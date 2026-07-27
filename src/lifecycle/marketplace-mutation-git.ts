import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeBranchClaimTrailers,
  terminalBranchClaimTrailers,
} from './codecs.js';
import {
  runMarketplacePatchGit,
  validateMarketplacePatch,
  type MarketplacePatchGitRunner,
} from './marketplace-patch.js';
import type { MarketplaceHostCommitEvidence } from './marketplace-execution-state.js';
import { gitOid, type GitOid } from './types.js';

export type MarketplaceMutationWorkflow =
  | 'implement'
  | 'fix-child'
  | 'reconcile'
  | 'ci-failure';

export interface MarketplaceMutationCommitIdentity {
  readonly worktreePath: string;
  readonly expectedHead: GitOid;
  readonly artifact: Uint8Array;
  readonly artifactDigest: string;
  readonly workflow: MarketplaceMutationWorkflow;
  readonly touchedPaths: readonly string[];
  readonly summary: string;
  readonly taskId: string;
  readonly requestId: string;
  readonly deliveryEnvelopeCid: string;
  readonly v2AttemptId: string;
  readonly childIssueNumber?: number;
  readonly reconcileBase?: GitOid;
}

export type MarketplaceMutationGitState =
  | { readonly status: 'clean'; readonly expectedTree: GitOid }
  | { readonly status: 'pending'; readonly expectedTree: GitOid }
  | {
      readonly status: 'committed';
      readonly expectedTree: GitOid;
      readonly commit: MarketplaceHostCommitEvidence;
    }
  | { readonly status: 'contradiction'; readonly detail: string };

export interface MarketplaceMutationGitPort {
  readState(
    identity: MarketplaceMutationCommitIdentity,
  ): Promise<MarketplaceMutationGitState>;
  commit(
    identity: MarketplaceMutationCommitIdentity,
  ): Promise<MarketplaceHostCommitEvidence>;
}

export interface MarketplaceMutationGitPorts {
  readonly runGit?: MarketplacePatchGitRunner;
}

export type MarketplaceMutationGitReason =
  | 'no-op-patch'
  | 'artifact-mismatch'
  | 'path-mismatch'
  | 'identity-invalid'
  | 'not-pending';

export class MarketplaceMutationGitError extends Error {
  readonly reason: MarketplaceMutationGitReason;

  constructor(reason: MarketplaceMutationGitReason, message: string) {
    super(message);
    this.name = 'MarketplaceMutationGitError';
    this.reason = reason;
  }
}

/**
 * Literal correlation trailers carried by every marketplace host commit. These
 * strings are durable protocol surface: changing one orphans every commit an
 * earlier Autopilot already wrote.
 */
export const MARKETPLACE_HOST_COMMIT_TRAILERS = {
  taskId: 'Jinn-Marketplace-Task',
  requestId: 'Jinn-Marketplace-Request',
  deliveryEnvelopeCid: 'Jinn-Marketplace-Envelope',
  v2AttemptId: 'Jinn-Autopilot-Attempt',
  artifactDigest: 'Jinn-Marketplace-Artifact',
  childIssueNumber: 'Jinn-Autopilot-Issue',
} as const;

const TRAILER_KEYS = new Set<string>(Object.values(MARKETPLACE_HOST_COMMIT_TRAILERS));

const GIT_TIMEOUT_MS = 30_000;
const GIT_OUTPUT_LIMIT_BYTES = 1024 * 1024;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function isChildWorkflow(workflow: MarketplaceMutationWorkflow): boolean {
  return workflow !== 'implement';
}

/**
 * Canonical digest of the marketplace-to-host correlation. It is a pure
 * function of the delivered identity — never of repository-local topology — so
 * the same delivery yields the same digest wherever it is adopted.
 *
 * It is deliberately *not* a function of the commit object. Reconstruction
 * after a crash re-derives the digest from the identity the caller supplies and
 * then verifies that identity against the commit; it does not read the identity
 * out of the commit. Every field except `workflow` is verified that way, since
 * each has a literal trailer. `workflow` is folded into the preimage but is not
 * recorded on the commit at all, so it is not recoverable from the commit
 * object: two identities differing only in `workflow` accept the same commit and
 * yield different digests. That is sound because `workflow` is durable
 * host-side state — the v3 execution state names the workflow that adopted the
 * delivery — but no caller may treat the digest as derivable from Git alone.
 */
function correlationDigestOf(identity: MarketplaceMutationCommitIdentity): string {
  const preimage = [
    'jinn-autopilot/marketplace-host-commit/v1',
    `workflow=${identity.workflow}`,
    `task=${identity.taskId}`,
    `request=${identity.requestId}`,
    `envelope=${identity.deliveryEnvelopeCid}`,
    `attempt=${identity.v2AttemptId}`,
    `artifact=${identity.artifactDigest}`,
    `child=${identity.childIssueNumber === undefined ? '' : String(identity.childIssueNumber)}`,
  ].join('\0');
  return `sha256:${createHash('sha256').update(preimage).digest('hex')}`;
}

/**
 * Refuses an identity that is internally contradictory before any Git command
 * runs: a host commit must never record correlation its workflow cannot carry.
 */
function assertCoherentIdentity(identity: MarketplaceMutationCommitIdentity): void {
  const invalid = (message: string): never => {
    throw new MarketplaceMutationGitError('identity-invalid', message);
  };
  if (identity.summary.trim().length === 0) {
    invalid('Marketplace host commit requires a non-empty summary');
  }
  if (isChildWorkflow(identity.workflow) === (identity.childIssueNumber === undefined)) {
    invalid(
      `Marketplace ${identity.workflow} host commit `
      + `${isChildWorkflow(identity.workflow) ? 'requires' : 'forbids'} a child issue number`,
    );
  }
  if (identity.childIssueNumber !== undefined
    && (!Number.isSafeInteger(identity.childIssueNumber) || identity.childIssueNumber <= 0)) {
    invalid('Marketplace host commit child issue number must be a positive integer');
  }
  if (identity.reconcileBase !== undefined && identity.workflow !== 'reconcile') {
    invalid(`Marketplace ${identity.workflow} host commit forbids a reconcile base`);
  }
  // The commit message is the only durable carrier of the correlation, so an
  // identity whose trailers do not read back out of the message it composes
  // must be refused before `commit-tree` can advance HEAD onto a commit this
  // module would then be unable to reconstruct.
  const parsed = parseHostCommitTrailers(messageOf(identity));
  const detail = 'detail' in parsed
    ? parsed.detail
    : trailerDisagreement(expectedTrailerFieldsOf(identity), parsed.fields);
  if (detail !== undefined) {
    invalid(`Marketplace host commit message does not read back: ${detail}`);
  }
}

/**
 * Re-derives the artifact's digest and touched paths from the bytes themselves,
 * so the evidence this module signs can never describe a different patch than
 * the one whose tree it computes.
 */
function assertArtifactCorrelation(identity: MarketplaceMutationCommitIdentity): void {
  const validated = validateMarketplacePatch(identity.artifact);
  if (validated.artifactDigest !== identity.artifactDigest) {
    throw new MarketplaceMutationGitError(
      'artifact-mismatch',
      `Marketplace artifact digests ${validated.artifactDigest} and`
      + ` ${identity.artifactDigest} disagree`,
    );
  }
  const declared = [...identity.touchedPaths].sort();
  if (declared.length !== validated.touchedPaths.length
    || declared.some((path, index) => path !== validated.touchedPaths[index])) {
    throw new MarketplaceMutationGitError(
      'path-mismatch',
      `Marketplace patch touches ${validated.touchedPaths.join(', ')},`
      + ` not the declared ${declared.join(', ')}`,
    );
  }
}

function expectedParentsOf(
  identity: MarketplaceMutationCommitIdentity,
): readonly GitOid[] {
  return identity.reconcileBase === undefined
    ? [identity.expectedHead]
    : [identity.expectedHead, identity.reconcileBase];
}

function trailerLinesOf(identity: MarketplaceMutationCommitIdentity): readonly string[] {
  const lines = [
    `${MARKETPLACE_HOST_COMMIT_TRAILERS.taskId}: ${identity.taskId}`,
    `${MARKETPLACE_HOST_COMMIT_TRAILERS.requestId}: ${identity.requestId}`,
    `${MARKETPLACE_HOST_COMMIT_TRAILERS.deliveryEnvelopeCid}: ${identity.deliveryEnvelopeCid}`,
    `${MARKETPLACE_HOST_COMMIT_TRAILERS.v2AttemptId}: ${identity.v2AttemptId}`,
    `${MARKETPLACE_HOST_COMMIT_TRAILERS.artifactDigest}: ${identity.artifactDigest}`,
  ];
  if (identity.childIssueNumber !== undefined) {
    lines.push(
      `${MARKETPLACE_HOST_COMMIT_TRAILERS.childIssueNumber}: ${String(identity.childIssueNumber)}`,
    );
  }
  return lines;
}

function messageOf(identity: MarketplaceMutationCommitIdentity): string {
  return [identity.summary.trim(), '', ...trailerLinesOf(identity)].join('\n');
}

function expectedTrailerFieldsOf(
  identity: MarketplaceMutationCommitIdentity,
): ReadonlyMap<string, string> {
  return new Map<string, string>(
    trailerLinesOf(identity).map((line) => {
      const separator = line.indexOf(': ');
      return [line.slice(0, separator), line.slice(separator + 2)];
    }),
  );
}

/**
 * The single reason `observed` fails to be exactly `expected`, or `undefined`
 * when the two agree field for field.
 */
function trailerDisagreement(
  expected: ReadonlyMap<string, string>,
  observed: ReadonlyMap<string, string>,
): string | undefined {
  for (const [key, value] of expected) {
    const seen = observed.get(key);
    if (seen === undefined) return `missing correlation trailer: ${key}`;
    if (seen !== value) return `correlation trailer ${key} is ${seen}, not ${value}`;
  }
  for (const key of observed.keys()) {
    if (!expected.has(key)) return `unexpected correlation trailer: ${key}`;
  }
  return undefined;
}

/**
 * Strict trailer parse: the maximal trailing run of `Jinn-` lines, each key
 * known and appearing exactly once.
 */
function parseHostCommitTrailers(
  message: string,
): { readonly fields: ReadonlyMap<string, string> } | { readonly detail: string } {
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  while (lines.at(-1) === '') lines.pop();
  let start = lines.length;
  while (start > 0 && lines[start - 1]!.startsWith('Jinn-')) start -= 1;
  if (start === lines.length) return { detail: 'host commit carries no correlation trailers' };
  const fields = new Map<string, string>();
  for (const line of lines.slice(start)) {
    const separator = line.indexOf(': ');
    if (separator <= 0) return { detail: `malformed correlation trailer: ${line}` };
    const key = line.slice(0, separator);
    if (!TRAILER_KEYS.has(key)) return { detail: `unknown correlation trailer: ${key}` };
    if (fields.has(key)) return { detail: `duplicate correlation trailer: ${key}` };
    fields.set(key, line.slice(separator + 2));
  }
  return { fields };
}

export function createMarketplaceMutationGitPort(
  ports: MarketplaceMutationGitPorts = {},
): MarketplaceMutationGitPort {
  const runGit = ports.runGit ?? runMarketplacePatchGit;

  const git = async (
    identity: MarketplaceMutationCommitIdentity,
    args: readonly string[],
    options: {
      readonly stdin?: Uint8Array;
      readonly indexFile?: string;
    } = {},
  ): Promise<string> => decoder.decode(await runGit(args, {
    cwd: identity.worktreePath,
    timeoutMs: GIT_TIMEOUT_MS,
    outputLimitBytes: GIT_OUTPUT_LIMIT_BYTES,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(options.indexFile === undefined
      ? {}
      : { env: { GIT_INDEX_FILE: options.indexFile } }),
  }));

  const gitLine = async (
    identity: MarketplaceMutationCommitIdentity,
    args: readonly string[],
    options?: { readonly stdin?: Uint8Array; readonly indexFile?: string },
  ): Promise<string> => (await git(identity, args, options)).trim();

  /**
   * Runs `body` against a scratch index file held outside the worktree so the
   * attempt worktree's real index is never mutated.
   */
  const withScratchIndex = async <T>(
    body: (indexFile: string) => Promise<T>,
  ): Promise<T> => {
    const scratch = await mkdtemp(join(tmpdir(), 'marketplace-mutation-index-'));
    try {
      return await body(join(scratch, 'index'));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };

  const expectedTreeOf = async (
    identity: MarketplaceMutationCommitIdentity,
  ): Promise<GitOid> => withScratchIndex(async (indexFile) => {
    await gitLine(identity, ['read-tree', `${identity.expectedHead}^{tree}`], { indexFile });
    // `--cached` keeps this entirely inside the scratch index: Task 3 already
    // applied the patch to the real worktree and this must not re-apply it.
    // The `--check` dry run precedes the real apply under the same options, as
    // the plan requires; `--3way` is never used.
    for (const check of [['--check'], []]) {
      await gitLine(identity, ['apply', '--cached', ...check, '-'], {
        indexFile,
        stdin: Uint8Array.from(identity.artifact),
      });
    }
    const tree = gitOid(await gitLine(identity, ['write-tree'], { indexFile }));
    const base = gitOid(await gitLine(identity, ['rev-parse', `${identity.expectedHead}^{tree}`]));
    if (tree === base) {
      throw new MarketplaceMutationGitError(
        'no-op-patch',
        `Marketplace patch leaves the attempt tree ${base} unchanged`,
      );
    }
    return tree;
  });

  const worktreeTreeOf = async (
    identity: MarketplaceMutationCommitIdentity,
    head: GitOid,
  ): Promise<GitOid> => withScratchIndex(async (indexFile) => {
    await gitLine(identity, ['read-tree', `${head}^{tree}`], { indexFile });
    // No pathspec: the comparison must cover the whole worktree, not just the
    // directory this call happens to run from.
    await gitLine(identity, ['add', '-A'], { indexFile });
    return gitOid(await gitLine(identity, ['write-tree'], { indexFile }));
  });

  /**
   * Paths differing between two trees, read from raw `-z` output rather than a
   * trimmed line, so a path with leading or trailing spaces is reported intact.
   */
  const divergentPathsOf = async (
    identity: MarketplaceMutationCommitIdentity,
    left: GitOid,
    right: GitOid,
  ): Promise<readonly string[]> => (
    await git(identity, ['diff', '--name-only', '-z', left, right])
  ).split('\0').filter((path) => path.length > 0);

  const parentsOf = async (
    identity: MarketplaceMutationCommitIdentity,
    commit: GitOid,
  ): Promise<readonly GitOid[]> => (
    await gitLine(identity, ['rev-list', '--parents', '-n', '1', commit])
  ).split(/\s+/).slice(1).map((value) => gitOid(value));

  const treeOf = async (
    identity: MarketplaceMutationCommitIdentity,
    commit: GitOid,
  ): Promise<GitOid> => gitOid(await gitLine(identity, ['rev-parse', `${commit}^{tree}`]));

  const messageAt = async (
    identity: MarketplaceMutationCommitIdentity,
    commit: GitOid,
  ): Promise<string> => git(identity, ['log', '-n', '1', '--format=%B', commit]);

  const createdAtOf = async (
    identity: MarketplaceMutationCommitIdentity,
    commit: GitOid,
  ): Promise<string> => new Date(
    await gitLine(identity, ['log', '-n', '1', '--format=%cI', commit]),
  ).toISOString();

  /**
   * Rebuilds the durable evidence for `candidate` from the commit object alone
   * and refuses it unless every correlation-bound field agrees with `identity`.
   */
  const reconstruct = async (
    identity: MarketplaceMutationCommitIdentity,
    expectedTree: GitOid,
    candidate: GitOid,
  ): Promise<MarketplaceHostCommitEvidence | { readonly detail: string }> => {
    const tree = await treeOf(identity, candidate);
    if (tree !== expectedTree) {
      return { detail: `host commit ${candidate} carries tree ${tree}, not ${expectedTree}` };
    }
    const parents = await parentsOf(identity, candidate);
    const expectedParents = expectedParentsOf(identity);
    if (
      parents.length !== expectedParents.length
      || parents.some((parent, index) => parent !== expectedParents[index])
    ) {
      return {
        detail: `host commit ${candidate} has parents ${parents.join(' ')},`
          + ` not ${expectedParents.join(' ')}`,
      };
    }
    const parsed = parseHostCommitTrailers(await messageAt(identity, candidate));
    if ('detail' in parsed) return { detail: `${candidate}: ${parsed.detail}` };
    const disagreement = trailerDisagreement(
      expectedTrailerFieldsOf(identity),
      parsed.fields,
    );
    if (disagreement !== undefined) return { detail: `${candidate}: ${disagreement}` };
    return {
      head: candidate,
      tree,
      parents,
      artifactDigest: identity.artifactDigest,
      correlationDigest: correlationDigestOf(identity),
      trailers: {
        taskId: identity.taskId,
        requestId: identity.requestId,
        deliveryEnvelopeCid: identity.deliveryEnvelopeCid,
        v2AttemptId: identity.v2AttemptId,
        artifactDigest: identity.artifactDigest,
        ...(identity.childIssueNumber === undefined
          ? {}
          : { childIssueNumber: identity.childIssueNumber }),
      },
      createdAt: await createdAtOf(identity, candidate),
    };
  };

  /**
   * True when `commit` is an ordinary Autopilot phase-complete marker: a
   * single-parent, empty-diff commit carrying `Jinn-Autopilot-Phase-Complete`.
   */
  const isCompletionMarker = async (
    identity: MarketplaceMutationCommitIdentity,
    commit: GitOid,
  ): Promise<boolean> => {
    const parents = await parentsOf(identity, commit);
    if (parents.length !== 1) return false;
    if (await treeOf(identity, commit) !== await treeOf(identity, parents[0]!)) return false;
    const trailers = terminalBranchClaimTrailers(await messageAt(identity, commit));
    if (trailers === null) return false;
    try {
      return decodeBranchClaimTrailers(trailers).phaseComplete === true;
    } catch {
      return false;
    }
  };

  const readState = async (
    identity: MarketplaceMutationCommitIdentity,
  ): Promise<MarketplaceMutationGitState> => {
    assertCoherentIdentity(identity);
    assertArtifactCorrelation(identity);
    const expectedTree = await expectedTreeOf(identity);
    const head = gitOid(await gitLine(identity, ['rev-parse', 'HEAD']));
    const headTree = await treeOf(identity, head);
    const worktreeTree = await worktreeTreeOf(identity, head);

    if (head === identity.expectedHead) {
      if (worktreeTree === expectedTree) return { status: 'pending', expectedTree };
      if (worktreeTree === headTree) return { status: 'clean', expectedTree };
      const divergent = await divergentPathsOf(identity, expectedTree, worktreeTree);
      return {
        status: 'contradiction',
        detail: `worktree tree ${worktreeTree} matches neither the delivered tree`
          + ` ${expectedTree} nor the attempt head tree ${headTree};`
          + ` paths diverging from the delivered tree: ${divergent.join(', ')}`,
      };
    }

    const chain = (await gitLine(identity, [
      'rev-list', '--first-parent', '--ancestry-path',
      `${identity.expectedHead}..${head}`,
    ])).split('\n').filter((line) => line.length > 0).map((line) => gitOid(line));
    if (chain.length === 0) {
      return {
        status: 'contradiction',
        detail: `head ${head} is not a first-parent descendant of the attempt head`
          + ` ${identity.expectedHead}`,
      };
    }
    const candidate = chain[chain.length - 1]!;
    const evidence = await reconstruct(identity, expectedTree, candidate);
    if ('detail' in evidence) return { status: 'contradiction', detail: evidence.detail };
    for (const descendant of chain.slice(0, -1)) {
      if (!await isCompletionMarker(identity, descendant)) {
        return {
          status: 'contradiction',
          detail: `commit ${descendant} above the host commit is not an Autopilot`
            + ' phase-complete marker',
        };
      }
    }
    if (worktreeTree !== headTree) {
      return {
        status: 'contradiction',
        detail: `worktree tree ${worktreeTree} diverges from committed head tree ${headTree}`,
      };
    }
    return { status: 'committed', expectedTree, commit: evidence };
  };

  /**
   * Points the attempt's real index at `HEAD` once the host commit exists.
   *
   * Task 3 applies the delivered patch to the working tree without `--index`,
   * so the real index still describes the pre-delivery tree; a commit built
   * from a scratch index therefore leaves every delivered path staged as a
   * reversal of the commit just made, and the worktree reads dirty forever to
   * attempt reclamation and the drift sweep. `read-tree` without `-u` rewrites
   * the index alone and never touches a working-tree file, which is safe here
   * precisely because the worktree already equals the committed tree — that is
   * what `pending`, and the committed branch's tree comparison, established.
   */
  const alignIndexWithHead = async (
    identity: MarketplaceMutationCommitIdentity,
  ): Promise<void> => {
    await gitLine(identity, ['read-tree', 'HEAD']);
  };

  return {
    readState,

    async commit(identity) {
      const state = await readState(identity);
      if (state.status === 'committed') {
        // A crash between the ref move and the refresh below lands here; the
        // recovery must leave the index consistent too, or that window is
        // permanently dirty.
        await alignIndexWithHead(identity);
        return state.commit;
      }
      if (state.status !== 'pending') {
        throw new MarketplaceMutationGitError(
          'not-pending',
          `Marketplace host commit requires an exactly applied worktree (${state.status}`
          + `${state.status === 'contradiction' ? `: ${state.detail}` : ''})`,
        );
      }
      const parents = expectedParentsOf(identity);
      const created = gitOid(await gitLine(identity, [
        'commit-tree', state.expectedTree,
        ...parents.flatMap((parent) => ['-p', parent]),
      ], { stdin: encoder.encode(messageOf(identity)) }));
      await gitLine(identity, ['update-ref', 'HEAD', created, identity.expectedHead]);
      await alignIndexWithHead(identity);
      const evidence = await reconstruct(identity, state.expectedTree, created);
      if ('detail' in evidence) {
        throw new MarketplaceMutationGitError(
          'identity-invalid',
          `Marketplace host commit did not reconstruct: ${evidence.detail}`,
        );
      }
      return evidence;
    },
  };
}
