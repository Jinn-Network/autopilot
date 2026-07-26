import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { REPO } from '../dispatcher/constants.js';
import { NEEDS_HUMAN_LABEL } from '../dispatcher/merge-sweep.js';
import type { BlockedOn, ProjectStatus } from '../dispatcher/types.js';
import {
  IMPLEMENTATION_SUMMARY_END,
  IMPLEMENTATION_SUMMARY_START,
} from './implementation-session.js';
import {
  decodeReviewClaimPayload,
  encodeReviewClaimPayload,
  isUnstructuredHumanHoldComment,
  parseHumanCommentEvidence,
} from './codecs.js';
import {
  gitPublicationArgs,
  selectCredential,
  type CredentialPool,
  type SelectedCredential,
} from './credentials.js';
import { makeGitProtocolPort } from './git-protocol.js';
import { readIssueCommentBodies } from './github-comments.js';
import { CANONICAL_GITHUB_HTTPS_REMOTE } from './implementation-executor.js';
import { withSelectedCredential } from './production-auth.js';
import { resolveStructuredPullRequestMappings } from './pr-mapping.js';
import type {
  ReconciliationHumanCommentAuthority,
  ReconciliationPullRequestState,
  ReconciliationReviewRefState,
  ReconciliationWriter,
} from './reconciler.js';
import type { GitHubLifecycleSnapshot } from './snapshot.js';
import type {
  TargetedIssueActionContext,
  TargetedNativeIssue,
  TargetedOpenPullRequest,
} from './targeted-action-reader.js';
import {
  gitOid,
  type GitOid,
  type HumanReason,
  type ReviewClaimRecord,
} from './types.js';

/**
 * Minimal per-PR node shape the writer's exact-state pre-checks and
 * read-backs need. `RawPullRequest` (the shape github-reader.ts's
 * `readPullRequestForReconciliation` returns) satisfies this structurally,
 * so callers can wire that method straight in as `readPullRequestByNumber`.
 */
export interface ReconciliationPullRequestNode {
  readonly state: 'OPEN' | 'MERGED';
  readonly headRefName: string;
  readonly headOid: string;
  readonly baseRefName: string;
  readonly isDraft: boolean;
  readonly labels: readonly string[];
  readonly body: string;
  readonly closingIssueNumbers: readonly number[];
  readonly humanIssueNumber?: number | null;
  readonly humanAuthor?: string | null;
  readonly humanHead?: string | null;
  readonly humanGeneration?: string | null;
  readonly humanLabelActor?: string | null;
  readonly draftActor?: string | null;
  readonly humanReason?: HumanReason | null;
  readonly reviewClaim: { readonly oid: string; readonly payload: string } | null;
}

/**
 * Minimal per-issue Project item shape the writer's `readProjectStatus` /
 * `setProjectStatus` need. `github-reader.ts`'s
 * `readProjectItemForReconciliation` satisfies this structurally.
 */
export interface ReconciliationProjectItemNode {
  readonly id: string;
  readonly status: ProjectStatus | null;
  readonly blockedOn: BlockedOn | null;
}

export interface ProductionReconciliationWriterOptions {
  readonly repositoryPath: string;
  /** Immutable complete snapshot that produced this cycle's projection plan. */
  readonly cycleSnapshot: GitHubLifecycleSnapshot;
  /**
   * Cheap, always-fresh single-PR read (~7-8 GraphQL points, versus ~390 for
   * a full `readSnapshot`) backing every exact-state PR pre-check and
   * post-mutation read-back in this writer. Returns `null` when the PR is
   * not open or merged. Required: there is deliberately no full-world
   * fallback.
   */
  readonly readPullRequestByNumber: (
    prNumber: number,
  ) => Promise<ReconciliationPullRequestNode | null>;
  /**
   * Cheap, always-fresh single-issue Project-item read (a targeted
   * `Issue.projectItems` lookup, not a full board paginate) backing
   * `readProjectStatus` and `setProjectStatus`'s exact-state pre-check and
   * post-mutation read-back. Required: there is deliberately no full-world
   * fallback.
   */
  readonly readProjectItemForReconciliation: (
    issueNumber: number,
  ) => Promise<ReconciliationProjectItemNode | null>;
  /** Exact git-transport branch/ref read. Never backed by a world snapshot. */
  readonly readBranchHeadByName: (headRefName: string) => Promise<GitOid | null>;
  readonly readIssueByNumber: (issueNumber: number) => Promise<TargetedNativeIssue | null>;
  readonly readBlockedByIssueNumbers: (issueNumber: number) => Promise<readonly number[]>;
  readonly readOpenPullRequestsByIssue: (
    issueNumber: number,
  ) => Promise<readonly TargetedOpenPullRequest[]>;
  /** Combined Project + native closing-relation authority (two-point budget). */
  readonly readIssueActionContext: (
    issueNumber: number,
  ) => Promise<TargetedIssueActionContext>;
  readonly readCanonicalSnapshot?: (
    prNumber: number,
  ) => Promise<GitHubLifecycleSnapshot | null>;
  readonly credential: SelectedCredential;
  readonly credentials?: CredentialPool;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly repositorySlug?: string;
  readonly repositoryUrl?: string;
  readonly defaultBranch?: string;
}

interface ActionAuthorityScope {
  readonly pullRequests: Map<number, Promise<ReconciliationPullRequestNode | null>>;
  readonly issues: Map<number, Promise<TargetedIssueActionContext>>;
}

function completionBody(body: string, summary: string): string {
  const section =
    `${IMPLEMENTATION_SUMMARY_START}\n${summary.trim()}\n${IMPLEMENTATION_SUMMARY_END}`;
  const start = body.indexOf(IMPLEMENTATION_SUMMARY_START);
  const end = body.indexOf(IMPLEMENTATION_SUMMARY_END);
  if (start === -1 && end === -1) return `${body.trimEnd()}\n\n${section}\n`;
  if (start === -1 || end < start) {
    throw new Error('Contradictory implementation summary markers in PR body');
  }
  return `${body.slice(0, start)}${section}${
    body.slice(end + IMPLEMENTATION_SUMMARY_END.length)
  }`;
}

async function mutateWithExactReadback(
  mutate: () => Promise<unknown>,
  confirmed: () => Promise<boolean>,
  ambiguityMessage: string,
): Promise<void> {
  let mutationError: unknown;
  try {
    await mutate();
  } catch (error) {
    mutationError = error;
  }
  let exact = false;
  try {
    exact = await confirmed();
  } catch (readbackError) {
    if (mutationError !== undefined) throw mutationError;
    throw readbackError;
  }
  if (exact) return;
  if (mutationError !== undefined) throw mutationError;
  throw new Error(ambiguityMessage);
}

// The helpers below all read a single already-fetched PR node — no world
// snapshot involved (jinn-mono#1883). `raw` comes from the writer's cheap
// `readPullRequestByNumber` per-PR read.

function pullRequestStateFromRaw(
  raw: ReconciliationPullRequestNode | null,
): ReconciliationPullRequestState | null {
  if (raw === null || raw.state !== 'OPEN') return null;
  return {
    head: gitOid(raw.headOid),
    draft: raw.isDraft,
    labels: [...raw.labels],
  };
}

function reviewRefStateFromRaw(
  raw: ReconciliationPullRequestNode | null,
): ReconciliationReviewRefState | null {
  const claim = raw?.reviewClaim;
  if (claim === undefined || claim === null) return null;
  const record = decodeReviewClaimPayload(claim.payload);
  return {
    oid: gitOid(claim.oid),
    head: record.head,
    generation: record.generation,
    state: record.state,
  };
}

function autopilotMarkers(body: string): readonly {
  readonly issueNumber: number;
  readonly headRefName: string;
}[] {
  return [...body.matchAll(
    /<!-- jinn-autopilot:v2 issue=([1-9][0-9]*) branch=([^ >]+) -->/g,
  )].map((match) => ({
    issueNumber: Number(match[1]),
    headRefName: match[2]!,
  }));
}

function exactDraftRelation(
  pullRequest: TargetedOpenPullRequest,
  expected: {
    readonly headRefName: string;
    readonly head: GitOid;
    readonly baseRefName: string;
    readonly body: string;
  },
): boolean {
  return pullRequest.headRefName === expected.headRefName
    && gitOid(pullRequest.headOid) === expected.head
    && pullRequest.baseRefName === expected.baseRefName
    && pullRequest.body === expected.body
    && pullRequest.draft
    && pullRequest.labels.includes('engine:review');
}

function exactDraftIdentity(
  pullRequest: TargetedOpenPullRequest,
  expected: {
    readonly headRefName: string;
    readonly head: GitOid;
    readonly baseRefName: string;
    readonly body: string;
  },
): boolean {
  return pullRequest.headRefName === expected.headRefName
    && gitOid(pullRequest.headOid) === expected.head
    && pullRequest.baseRefName === expected.baseRefName
    && pullRequest.body === expected.body;
}

function humanDominatesPullRequest(
  snapshot: GitHubLifecycleSnapshot,
  prNumber: number,
): boolean {
  const pr = snapshot.pullRequests.find((candidate) => candidate.number === prNumber);
  const lifecycle = snapshot.lifecycle.items.find((item) =>
    item.kind === 'pull-request' && item.prNumber === prNumber);
  return pr?.labels.includes(NEEDS_HUMAN_LABEL) === true
    || (
      lifecycle?.kind === 'pull-request'
      && (
        lifecycle.humanHold === true
        || lifecycle.projectStatus === 'Human'
      )
    );
}

function nextReviewRecord(
  current: ReviewClaimRecord,
  state: 'terminal-approved' | 'stale',
  recordedAt: string,
): ReviewClaimRecord {
  const common = {
    kind: 'review-claim' as const,
    protocolVersion: 2 as const,
    prNumber: current.prNumber,
    generation: current.generation,
    attempt: current.attempt,
    reviewer: current.reviewer,
    head: current.head,
    recordedAt,
  };
  if (state === 'terminal-approved') {
    if (
      current.state !== 'verdict-intent'
      || current.verdict.state !== 'APPROVE'
    ) {
      throw new Error('Only an APPROVE verdict intent can become terminal-approved');
    }
    return {
      ...common,
      state,
      verdict: {
        marker: current.verdict.marker,
        state: 'APPROVE',
      },
    };
  }
  return { ...common, state };
}

export function makeProductionReconciliationWriter(
  options: ProductionReconciliationWriterOptions,
): ReconciliationWriter {
  return makeProductionReconciliationWriterWithScope(options, null);
}

function makeProductionReconciliationWriterWithScope(
  options: ProductionReconciliationWriterOptions,
  actionAuthority: ActionAuthorityScope | null,
): ReconciliationWriter {
  const runner = options.runner ?? defaultRunner;
  const ambient = options.environment ?? process.env;
  const now = options.now ?? (() => new Date());
  const repositorySlug = options.repositorySlug ?? REPO;
  const repositoryUrl =
    options.repositoryUrl ?? CANONICAL_GITHUB_HTTPS_REMOTE;
  const defaultBranch = options.defaultBranch ?? 'next';
  if (options.cycleSnapshot.snapshotComplete !== true) {
    throw new Error('Reconciliation writer requires a complete cycle snapshot');
  }
  const invalidateActionAuthority = (): void => {
    actionAuthority?.pullRequests.clear();
    actionAuthority?.issues.clear();
  };
  const readRawPr = (prNumber: number): Promise<ReconciliationPullRequestNode | null> => {
    if (actionAuthority === null) return options.readPullRequestByNumber(prNumber);
    const cached = actionAuthority.pullRequests.get(prNumber);
    if (cached !== undefined) return cached;
    const read = options.readPullRequestByNumber(prNumber);
    actionAuthority.pullRequests.set(prNumber, read);
    return read;
  };
  const readIssueContext = (issueNumber: number): Promise<TargetedIssueActionContext> => {
    const load = () => options.readIssueActionContext(issueNumber);
    if (actionAuthority === null) return load();
    const cached = actionAuthority.issues.get(issueNumber);
    if (cached !== undefined) return cached;
    const read = load();
    actionAuthority.issues.set(issueNumber, read);
    return read;
  };
  const readProjectItem = async (issueNumber: number) => (
    await readIssueContext(issueNumber)
  ).projectItem;
  const readOpenPullRequestsByIssue = async (issueNumber: number) => (
    await readIssueContext(issueNumber)
  ).openPullRequests;
  const selected = <Value>(
    operation: Parameters<typeof withSelectedCredential<Value>>[2],
  ): Promise<Value> => withSelectedCredential(
    options.credential,
    ambient,
    operation,
    runner,
  );
  const repairCredentialForAuthor = (author: string): SelectedCredential => {
    const normalizedAuthor = author.toLowerCase();
    if (options.credentials === undefined) {
      if (options.credential.normalizedLogin !== normalizedAuthor) {
        throw new Error(`Configured repair credential for ${author} is unavailable`);
      }
      return options.credential;
    }
    const selection = selectCredential(
      options.credentials.restrictedTo([author]),
      { phase: 'implement' },
    );
    if (
      selection.status !== 'selected'
      || selection.credential.normalizedLogin !== normalizedAuthor
    ) {
      throw new Error(`Configured repair credential for ${author} is unavailable`);
    }
    return selection.credential;
  };
  const machineAuthorLogins = new Set([
    options.credential.normalizedLogin,
    ...(options.credentials?.logins().map((login) => login.toLowerCase()) ?? []),
  ]);
  const isRetiredMappingAudit = (
    input: {
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly expectedHead: GitOid;
      readonly expectedGeneration: string;
    },
    body: string,
    author: unknown,
  ): boolean => {
    if (
      typeof author !== 'string'
      || !machineAuthorLogins.has(author.toLowerCase())
    ) {
      return false;
    }
    const evidence = parseHumanCommentEvidence(body);
    return evidence?.reason.code === 'branch-mapping-ambiguous'
      && evidence.issueNumber === input.issueNumber
      && evidence.prNumber === input.prNumber
      && evidence.head === input.expectedHead
      && evidence.generation !== undefined
      && evidence.generation !== input.expectedGeneration;
  };
  type LiveMapping =
    | { readonly kind: 'normal'; readonly issueNumber: number }
    | {
        readonly kind: 'diagnostic';
        readonly issueNumbers: readonly number[];
        readonly details: readonly string[];
      };
  const sameList = <Value>(
    left: readonly Value[],
    right: readonly Value[],
  ): boolean => left.length === right.length
    && left.every((value, index) => value === right[index]);
  const validateLiveMapping = (
    prNumber: number,
    raw: ReconciliationPullRequestNode,
  ): LiveMapping => {
    const cyclePr = options.cycleSnapshot.pullRequests.find((pr) => pr.number === prNumber);
    if (cyclePr === undefined) {
      throw new Error(`Live PR #${prNumber} mapping is absent from cycle context`);
    }
    if (
      cyclePr.headOid !== gitOid(raw.headOid)
      || cyclePr.headRefName !== raw.headRefName
      || cyclePr.baseRefName !== raw.baseRefName
    ) {
      throw new Error(`Live PR #${prNumber} exact mapping branch, head, or base changed`);
    }
    const liveMappings = resolveStructuredPullRequestMappings({
      defaultBranch,
      issues: options.cycleSnapshot.issues.map((issue) => ({
        number: issue.number,
        blockedOn: issue.blockedOn,
        blockedByIssues: [...issue.blockedByIssues],
      })),
      pullRequests: options.cycleSnapshot.pullRequests.map((pr) => (
        pr.number === prNumber
          ? {
              number: prNumber,
              state: raw.state,
              head: gitOid(raw.headOid),
              headRefName: raw.headRefName,
              baseRefName: raw.baseRefName,
              closingIssueNumbers: [...raw.closingIssueNumbers],
              body: raw.body,
              ...(raw.humanIssueNumber === undefined || raw.humanIssueNumber === null
                ? {}
                : { humanIssueNumber: raw.humanIssueNumber }),
            }
          : {
              number: pr.number,
              state: pr.state,
              head: pr.headOid,
              headRefName: pr.headRefName,
              baseRefName: pr.baseRefName,
              closingIssueNumbers: [...pr.closingIssueNumbers],
              body: pr.body,
              ...(pr.humanIssueNumber === undefined
                ? {}
                : { humanIssueNumber: pr.humanIssueNumber }),
            }
      )),
      stableBranches: options.cycleSnapshot.branches.map((branch) => ({
        issueNumber: branch.issueNumber,
        phase: branch.claim.phase,
        head: branch.headOid,
        headRefName: branch.headRefName,
        targetBase: branch.claim.targetBase,
      })),
    });
    const live = liveMappings.find((mapping) => mapping.prNumber === prNumber);
    const recordedCycle = options.cycleSnapshot.pullRequestMappings?.find(
      (mapping) => mapping.prNumber === prNumber,
    );
    if (recordedCycle === undefined) {
      throw new Error(`Live PR #${prNumber} canonical mapping is absent from cycle context`);
    }
    const cycle = recordedCycle;
    if (
      live?.status === 'resolved'
      && cycle?.status === 'resolved'
      && live.issueNumber === cycle.issueNumber
      && live.expectedBaseRefName === cycle.expectedBaseRefName
    ) {
      return { kind: 'normal', issueNumber: live.issueNumber };
    }
    if (
      live?.status === 'ambiguous'
      && cycle?.status === 'ambiguous'
      && sameList(live.issueNumbers, cycle.issueNumbers)
      && sameList(live.details, cycle.details)
    ) {
      return {
        kind: 'diagnostic',
        issueNumbers: [...live.issueNumbers],
        details: [...live.details],
      };
    }
    const detail = live?.status === 'ambiguous'
      ? live.details.join(' ')
      : 'mapping result is absent';
    throw new Error(`Live PR #${prNumber} canonical mapping changed: ${detail}`);
  };
  const readMappedRawPr = async (
    prNumber: number,
  ): Promise<ReconciliationPullRequestNode | null> => {
    const raw = await readRawPr(prNumber);
    if (raw !== null) validateLiveMapping(prNumber, raw);
    return raw;
  };
  const readPr = async (prNumber: number) =>
    pullRequestStateFromRaw(await readMappedRawPr(prNumber));
  const readReview = async (prNumber: number) =>
    reviewRefStateFromRaw(await readMappedRawPr(prNumber));
  const validateHumanCommentAuthority = (
    prNumber: number,
    raw: ReconciliationPullRequestNode,
    mapping: LiveMapping,
    authority: ReconciliationHumanCommentAuthority,
  ): void => {
    if (
      raw.state !== 'OPEN'
      || gitOid(raw.headOid) !== authority.expectedHead
    ) {
      throw new Error('Human comment reconciliation lost exact-head authority');
    }
    const claim = raw.reviewClaim;
    if (claim === null) {
      throw new Error('Human comment reconciliation review-ref authority is absent');
    }
    const record = decodeReviewClaimPayload(claim.payload);
    if (
      gitOid(claim.oid) !== authority.expectedReviewRefOid
      || record.prNumber !== prNumber
      || record.head !== authority.expectedHead
      || record.generation !== authority.expectedGeneration
      || record.state !== 'human'
    ) {
      throw new Error('Human comment reconciliation lost exact review-ref authority');
    }
    const diagnostic = options.cycleSnapshot.diagnostics.find((candidate) => (
      candidate.pullRequests.some((pr) => (
        pr.number === prNumber && pr.head === authority.expectedHead
      ))
    ));
    if (
      authority.expectedDiagnosticIssueNumbers !== undefined
      || authority.expectedDiagnosticDetail !== undefined
    ) {
      if (
        mapping.kind !== 'diagnostic'
        || diagnostic === undefined
        || authority.expectedDiagnosticDetail !== diagnostic.detail
        || !sameList(
          authority.expectedDiagnosticIssueNumbers ?? [],
          diagnostic.issueNumbers,
        )
        || !diagnostic.issueNumbers.includes(authority.issueNumber)
      ) {
        throw new Error('Human comment reconciliation diagnostic authority changed');
      }
      return;
    }
    if (mapping.kind !== 'normal' || mapping.issueNumber !== authority.issueNumber) {
      throw new Error('Human comment reconciliation issue mapping changed');
    }
  };
  const liveIssueHead = async (issueNumber: number): Promise<GitOid | null> => {
    const lifecyclePr = options.cycleSnapshot.lifecycle.items.find((item) => (
      item.kind === 'pull-request' && item.issueNumber === issueNumber
    ));
    if (lifecyclePr?.kind === 'pull-request') {
      const pr = await readRawPr(lifecyclePr.prNumber);
      const mapping = pr === null ? null : validateLiveMapping(lifecyclePr.prNumber, pr);
      if (mapping !== null && (
        mapping.kind !== 'normal' || mapping.issueNumber !== issueNumber
      )) {
        throw new Error(`Live PR mapping no longer names issue #${issueNumber}`);
      }
      return pr === null ? null : gitOid(pr.headOid);
    }
    const branch = options.cycleSnapshot.branches.find((entry) => (
      entry.issueNumber === issueNumber
    ));
    return branch === undefined
      ? null
      : options.readBranchHeadByName(branch.headRefName);
  };
  const liveHumanDominatesPullRequest = async (
    prNumber: number,
    supplied?: ReconciliationPullRequestNode | null,
    authoritativeReview?: ReviewClaimRecord,
  ): Promise<boolean> => {
    const raw = supplied === undefined ? await readMappedRawPr(prNumber) : supplied;
    const mapping = raw === null ? null : validateLiveMapping(prNumber, raw);
    if (mapping?.kind === 'diagnostic') return true;
    if (humanDominatesPullRequest(options.cycleSnapshot, prNumber)) return true;
    if (raw?.labels.includes(NEEDS_HUMAN_LABEL) === true) return true;
    if (raw?.humanReason !== undefined && raw.humanReason !== null) {
      const retainedMachineMappingAudit = (
        authoritativeReview !== undefined
        && mapping?.kind === 'normal'
        && raw.humanReason.code === 'branch-mapping-ambiguous'
        && raw.humanIssueNumber === mapping.issueNumber
        && raw.humanAuthor !== undefined
        && raw.humanAuthor !== null
        && machineAuthorLogins.has(raw.humanAuthor.toLowerCase())
        && raw.humanHead === authoritativeReview.head
        && raw.humanGeneration !== undefined
        && raw.humanGeneration !== null
        && authoritativeReview.head === gitOid(raw.headOid)
        && (
          raw.humanGeneration !== authoritativeReview.generation
          || (
            raw.humanGeneration === authoritativeReview.generation
            && authoritativeReview.state === 'stale'
          )
        )
      );
      if (!retainedMachineMappingAudit) return true;
    }
    const lifecycle = options.cycleSnapshot.lifecycle.items.find((item) => (
      item.kind === 'pull-request' && item.prNumber === prNumber
    ));
    if (lifecycle?.kind !== 'pull-request') return true;
    const project = await readProjectItem(lifecycle.issueNumber);
    return project === null || project.status === 'Human' || project.blockedOn === 'Human';
  };
  const updateReviewRef = async (
    prNumber: number,
    expectedReviewRefOid: GitOid,
    desired: 'terminal-approved' | 'stale',
    allowObsoleteMappingHuman = false,
    mutationCredential?: SelectedCredential,
  ): Promise<void> => {
    const beforeRaw = await readMappedRawPr(prNumber);
    const beforeClaim = beforeRaw?.reviewClaim;
    if (
      beforeClaim === undefined
      || beforeClaim === null
      || gitOid(beforeClaim.oid) !== expectedReviewRefOid
    ) {
      throw new Error('Review-ref authority changed before reconciliation');
    }
    const beforeRecord = decodeReviewClaimPayload(beforeClaim.payload);
    // The immutable cycle supplies lifecycle context; targeted PR and Project
    // reads refresh the mutable Human-dominance evidence.
    if (
      !allowObsoleteMappingHuman
      && await liveHumanDominatesPullRequest(prNumber, beforeRaw, beforeRecord)
    ) {
      throw new Error('Human is dominant over review-ref reconciliation');
    }
    if (
      desired !== 'stale'
      && (beforeRaw === null || gitOid(beforeRaw.headOid) !== beforeRecord.head)
    ) {
      throw new Error('Review-ref reconciliation lost exact-head authority');
    }
    const record = nextReviewRecord(
      beforeRecord,
      desired,
      now().toISOString(),
    );
    const authenticate = mutationCredential === undefined
      ? selected
      : <Value>(
          operation: Parameters<typeof withSelectedCredential<Value>>[2],
        ) => withSelectedCredential(mutationCredential, ambient, operation, runner);
    await authenticate(async ({ askpass, run }) => {
      const directory = mkdtempSync(join(tmpdir(), 'jinn-reconcile-review-'));
      const payloadPath = join(directory, 'jinn-autopilot-review.json');
      const indexPath = join(directory, 'index');
      const localEnvironment = { GIT_INDEX_FILE: indexPath };
      const git = (args: readonly string[], env = localEnvironment) => run(
        'git',
        ['-C', options.repositoryPath, ...args],
        { env },
      );
      try {
        writeFileSync(
          payloadPath,
          `${encodeReviewClaimPayload(record)}\n`,
          { mode: 0o600 },
        );
        await git(['read-tree', '--empty']);
        const blob = gitOid((await git([
          'hash-object', '-w', payloadPath,
        ])).trim());
        await git([
          'update-index', '--add',
          '--cacheinfo', `100644,${blob},jinn-autopilot-review.json`,
        ]);
        const tree = gitOid((await git(['write-tree'])).trim());
        const recordOid = gitOid((await git([
          'commit-tree', tree,
          '-p', expectedReviewRefOid,
          '-m', 'Autopilot reconciliation review metadata',
        ])).trim());
        const secureGit = (
          _command: 'git',
          args: readonly string[],
        ) => run('git', [
          ...gitPublicationArgs(askpass, []),
          '-C', options.repositoryPath,
          ...args,
        ]);
        await mutateWithExactReadback(
          async () => {
            invalidateActionAuthority();
            const outcome = await makeGitProtocolPort(secureGit, {
              remote: repositoryUrl,
            }).publishReviewClaim({
              prNumber,
              recordParent: expectedReviewRefOid,
              expectedRemoteRecordOid: expectedReviewRefOid,
              recordOid,
            });
            if (
              outcome.status !== 'won'
              && outcome.status !== 'already-applied'
            ) {
              throw new Error(`Review-ref reconciliation ${outcome.status}`);
            }
          },
          async () => {
            const after = await readReview(prNumber);
            return after?.oid === recordOid
              && after.head === record.head
              && after.state === desired;
          },
          'Review-ref reconciliation was ambiguous',
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  };

  return {
    actionScope() {
      return makeProductionReconciliationWriterWithScope(options, {
        pullRequests: new Map(),
        issues: new Map(),
      });
    },

    async readIssueHead(issueNumber) {
      return liveIssueHead(issueNumber);
    },

    async readBranchHead(headRefName) {
      const currentPr = options.cycleSnapshot.pullRequests.find((pr) => (
        pr.state === 'OPEN' && pr.headRefName === headRefName
      ));
      if (currentPr !== undefined) {
        const raw = await readRawPr(currentPr.number);
        if (raw !== null) validateLiveMapping(currentPr.number, raw);
        return raw === null ? null : gitOid(raw.headOid);
      }
      return options.readBranchHeadByName(headRefName);
    },



    readPullRequest: readPr,

    async setPullRequestDraft(prNumber, draft, expectedHead) {
      const beforeRaw = await readMappedRawPr(prNumber);
      const mapping = beforeRaw === null ? null : validateLiveMapping(prNumber, beforeRaw);
      const beforePr = pullRequestStateFromRaw(beforeRaw);
      if (expectedHead !== undefined && beforePr?.head !== expectedHead) {
        throw new Error('Pull-request draft reconciliation lost exact-head authority');
      }
      if (!draft && await liveHumanDominatesPullRequest(prNumber, beforeRaw)) {
        throw new Error('Human is dominant over pull-request draft reconciliation');
      }
      if (mapping?.kind === 'diagnostic' && !draft) {
        throw new Error('Diagnostic reconciliation may only make a PR draft');
      }
      await selected(({ run }) => mutateWithExactReadback(
        () => {
          invalidateActionAuthority();
          return run('gh', [
            'pr', 'ready', String(prNumber), '--repo', repositorySlug,
            ...(draft ? ['--undo'] : []),
          ]);
        },
        async () => {
          const after = await readPr(prNumber);
          return after?.draft === draft
            && (expectedHead === undefined || after.head === expectedHead);
        },
        'Pull-request draft reconciliation was ambiguous',
      ));
    },

    async setPullRequestLabel(prNumber, label, present, expectedHead) {
      const beforeRaw = await readMappedRawPr(prNumber);
      const mapping = beforeRaw === null ? null : validateLiveMapping(prNumber, beforeRaw);
      const beforePr = pullRequestStateFromRaw(beforeRaw);
      if (expectedHead !== undefined && beforePr?.head !== expectedHead) {
        throw new Error('Pull-request label reconciliation lost exact-head authority');
      }
      if (
        await liveHumanDominatesPullRequest(prNumber, beforeRaw)
        && !(
          present
          && (
            label === NEEDS_HUMAN_LABEL
            || (mapping?.kind === 'diagnostic' && label === 'engine:review')
          )
        )
      ) {
        throw new Error('Human is dominant over pull-request label reconciliation');
      }
      await selected(({ run }) => mutateWithExactReadback(
        () => {
          invalidateActionAuthority();
          return run('gh', [
            'pr', 'edit', String(prNumber), '--repo', repositorySlug,
            present ? '--add-label' : '--remove-label', label,
          ]);
        },
        async () => {
          const after = await readPr(prNumber);
          return after !== null
            && after.labels.includes(label) === present
            && (expectedHead === undefined || after.head === expectedHead);
        },
        'Pull-request label reconciliation was ambiguous',
      ));
    },

    async hasHumanComment(prNumber, marker, authority) {
      const raw = await readRawPr(prNumber);
      if (raw === null) {
        throw new Error('Human comment reconciliation pull request is absent');
      }
      const mapping = validateLiveMapping(prNumber, raw);
      validateHumanCommentAuthority(prNumber, raw, mapping, authority);
      return selected(async ({ run }) => {
        const bodies = await readIssueCommentBodies(
          run,
          prNumber,
          repositorySlug,
        );
        return bodies.some((body) => body.includes(marker));
      });
    },

    async ensureHumanComment(prNumber, marker, body, authority) {
      if (!body.includes(marker)) {
        throw new Error('Human comment body is missing its exact marker');
      }
      const beforeRaw = await readMappedRawPr(prNumber);
      if (beforeRaw === null) {
        throw new Error('Human comment reconciliation pull request is absent');
      }
      validateHumanCommentAuthority(
        prNumber,
        beforeRaw,
        validateLiveMapping(prNumber, beforeRaw),
        authority,
      );
      await selected(async ({ run }) => {
        const hasMarker = async () => (
          await readIssueCommentBodies(run, prNumber, repositorySlug)
        ).some((body) => body.includes(marker));
        await mutateWithExactReadback(
          () => {
            invalidateActionAuthority();
            return run('gh', [
              'pr', 'comment', String(prNumber),
              '--repo', repositorySlug, '--body', body,
            ]);
          },
          async () => {
            if (!await hasMarker()) return false;
            const after = await readRawPr(prNumber);
            if (after === null) return false;
            validateHumanCommentAuthority(
              prNumber,
              after,
              validateLiveMapping(prNumber, after),
              authority,
            );
            return true;
          },
          'Human comment reconciliation was ambiguous',
        );
      });
    },

    async ensureImplementationSummary(prNumber, expectedHead, summary) {
      const pr = await readMappedRawPr(prNumber);
      if (pr !== null && validateLiveMapping(prNumber, pr).kind === 'diagnostic') {
        throw new Error('Diagnostic reconciliation cannot write an implementation summary');
      }
      if (pr === null || pr.state !== 'OPEN' || gitOid(pr.headOid) !== expectedHead) {
        throw new Error('Implementation summary head changed');
      }
      const desired = completionBody(pr.body, summary);
      if (desired === pr.body) return;
      await selected(({ run }) => mutateWithExactReadback(
        () => {
          invalidateActionAuthority();
          return run('gh', [
            'pr', 'edit', String(prNumber),
            '--repo', repositorySlug, '--body', desired,
          ]);
        },
        async () => {
          const after = await readMappedRawPr(prNumber);
          return after !== null
            && after.state === 'OPEN'
            && gitOid(after.headOid) === expectedHead
            && after.body === desired;
        },
        'Implementation summary reconciliation was ambiguous',
      ));
    },

    async readDraftPullRequestAuthority(input) {
      const marker =
        `<!-- jinn-autopilot:v2 issue=${input.issueNumber} branch=${input.headRefName} -->`;
      const expected = {
        headRefName: input.headRefName,
        head: input.expectedHead,
        baseRefName: input.baseRefName,
        body: `Closes #${input.issueNumber}\n\n${marker}`,
      };
      const relations = await readOpenPullRequestsByIssue(input.issueNumber);
      if (relations.length > 1) {
        throw new Error('Draft PR reconciliation found duplicate issue closing relations');
      }
      const relation = relations[0];
      if (relation === undefined) return { kind: 'missing' };
      if (!exactDraftIdentity(relation, expected)) {
        throw new Error('Draft PR reconciliation found a malformed issue closing relation');
      }
      return {
        kind: 'linked',
        number: relation.number,
        head: gitOid(relation.headOid),
        draft: relation.draft,
        labels: [...relation.labels],
      };
    },

    async ensureDraftPullRequest(input) {
      // The cycle supplies immutable stack/projection context. Every mutable
      // authority used to create the draft is re-read through a target seam.
      const current = options.cycleSnapshot;
      const issue = current.issues.find((candidate) =>
        candidate.number === input.issueNumber);
      if (issue === undefined) throw new Error('Issue is absent from the lifecycle snapshot');
      const nativeIssue = await options.readIssueByNumber(input.issueNumber);
      if (
        nativeIssue === null
        || nativeIssue.number !== input.issueNumber
        || !nativeIssue.open
      ) {
        throw new Error('Draft PR reconciliation native issue is missing or closed');
      }
      const projectItem = await readProjectItem(input.issueNumber);
      if (projectItem === null) {
        throw new Error('Draft PR reconciliation issue is missing from Project');
      }
      if (projectItem.status === 'Human' || projectItem.blockedOn === 'Human') {
        throw new Error('Human is dominant over draft PR reconciliation');
      }
      if (
        projectItem.status !== 'Todo'
        && projectItem.status !== 'In Progress'
      ) {
        throw new Error(
          'Draft PR reconciliation Project status is not Todo or In Progress',
        );
      }
      const dependencies = await options.readBlockedByIssueNumbers(input.issueNumber);
      const expectedDependencies = [...issue.blockedByIssues].sort((left, right) => left - right);
      const liveDependencies = [...dependencies].sort((left, right) => left - right);
      if (
        expectedDependencies.length !== liveDependencies.length
        || expectedDependencies.some((number, index) => number !== liveDependencies[index])
      ) {
        throw new Error('Draft PR reconciliation native dependencies changed');
      }
      const cycleOpenBlockers = new Map<number, GitHubLifecycleSnapshot['pullRequests'][number]>();
      for (const dependency of expectedDependencies) {
        const linked = current.pullRequests.filter((pr) => (
          pr.closingIssueNumbers.includes(dependency)
        ));
        // Merged evidence is immutable and already satisfies this dependency.
        // Only the one still-open stacking base needs a live authority check.
        if (linked.some((pr) => pr.state === 'MERGED')) continue;
        const open = linked.filter((pr) => pr.state === 'OPEN');
        if (open.length === 0) {
          throw new Error('Draft PR reconciliation dependency is not satisfied in cycle context');
        }
        for (const blocker of open) cycleOpenBlockers.set(blocker.number, blocker);
      }
      if (cycleOpenBlockers.size > 1) {
        throw new Error('Draft PR reconciliation has more than one open blocker PR');
      }
      const cycleOpenBlocker = [...cycleOpenBlockers.values()][0];
      if (cycleOpenBlocker === undefined) {
        if (
          expectedDependencies.length > 0
          && input.baseRefName !== defaultBranch
        ) {
          throw new Error(
            'Draft PR reconciliation merged blockers require the configured default base',
          );
        }
      } else {
        if (input.baseRefName !== cycleOpenBlocker.headRefName) {
          throw new Error('Draft PR reconciliation blocker base changed');
        }
        const liveBlocker = await readRawPr(cycleOpenBlocker.number);
        const liveClosing = liveBlocker === null
          ? new Set<number>()
          : new Set(liveBlocker.closingIssueNumbers);
        const blockerMarkers = liveBlocker === null ? [] : autopilotMarkers(liveBlocker.body);
        const blockerDependency = expectedDependencies.find((dependency) => (
          cycleOpenBlocker.closingIssueNumbers.includes(dependency)
        ));
        if (
          liveBlocker === null
          || liveBlocker.state !== 'OPEN'
          || gitOid(liveBlocker.headOid) !== cycleOpenBlocker.headOid
          || liveBlocker.headRefName !== cycleOpenBlocker.headRefName
          || blockerDependency === undefined
          || liveClosing.size !== liveBlocker.closingIssueNumbers.length
          || liveClosing.size !== 1
          || !liveClosing.has(blockerDependency)
          || (
            blockerMarkers.length > 0
            && (
              blockerMarkers.length !== 1
              || blockerMarkers[0]!.issueNumber !== blockerDependency
              || blockerMarkers[0]!.headRefName !== liveBlocker.headRefName
            )
          )
        ) {
          throw new Error('Draft PR reconciliation blocker PR authority changed');
        }
      }
      if (await liveIssueHead(input.issueNumber) !== input.expectedHead) {
        throw new Error('Draft PR reconciliation lost exact-head authority');
      }
      const marker =
        `<!-- jinn-autopilot:v2 issue=${input.issueNumber} branch=${input.headRefName} -->`;
      const expectedBody = `Closes #${input.issueNumber}\n\n${marker}`;
      const expectedRelation = {
        headRefName: input.headRefName,
        head: input.expectedHead,
        baseRefName: input.baseRefName,
        body: expectedBody,
      };
      const beforeRelations = await readOpenPullRequestsByIssue(input.issueNumber);
      if (beforeRelations.length > 1) {
        throw new Error('Draft PR reconciliation found duplicate issue closing relations');
      }
      if (beforeRelations.length === 1) {
        if (exactDraftRelation(beforeRelations[0]!, expectedRelation)) return;
        throw new Error('Draft PR reconciliation found a malformed issue closing relation');
      }
      await selected(({ run }) => mutateWithExactReadback(
        () => {
          invalidateActionAuthority();
          return run('gh', [
            'pr', 'create', '--repo', repositorySlug,
            '--head', input.headRefName,
            '--base', input.baseRefName,
            '--title', nativeIssue.title,
            '--body', expectedBody,
            '--draft',
            '--label', 'engine:review',
          ]);
        },
        async () => {
          const after = await readOpenPullRequestsByIssue(input.issueNumber);
          return after.length === 1 && exactDraftRelation(after[0]!, expectedRelation);
        },
        'Draft pull-request reconciliation was ambiguous',
      ));
    },

    readReviewRef: readReview,

    async repairObsoleteMappingHuman(input) {
      if (options.readCanonicalSnapshot === undefined) {
        throw new Error('Complete canonical repair authority is unavailable');
      }
      const repairCredential = repairCredentialForAuthor(input.expectedAuthor);
      const runAsRepairAuthor = <Value>(
        operation: Parameters<typeof withSelectedCredential<Value>>[2],
      ) => withSelectedCredential(repairCredential, ambient, operation, runner);
      interface HumanCommentRead {
        readonly exactIds: readonly number[];
        readonly otherStructured: boolean;
      }
      const readHumanComments = async (
        run: Parameters<Parameters<typeof selected>[0]>[0]['run'],
      ): Promise<HumanCommentRead> => {
        const raw = await run('gh', [
          'api', `repos/${repositorySlug}/issues/${input.prNumber}/comments`,
          '--paginate', '--slurp',
        ]);
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) throw new Error('Malformed mapping Human comment readback');
        const comments = parsed.every((entry) => Array.isArray(entry))
          ? parsed.flat()
          : parsed;
        const exactIds: number[] = [];
        let otherStructured = false;
        for (const entry of comments) {
          if (typeof entry !== 'object' || entry === null) {
            throw new Error('Malformed mapping Human comment readback');
          }
          const comment = entry as {
            id?: unknown;
            body?: unknown;
            user?: { login?: unknown } | null;
          };
          if (
            typeof comment.id !== 'number'
            || !Number.isSafeInteger(comment.id)
            || comment.id <= 0
            || typeof comment.body !== 'string'
          ) {
            throw new Error('Malformed mapping Human comment readback');
          }
          const author = comment.user?.login;
          const exact = typeof author === 'string'
            && author.toLowerCase() === input.expectedAuthor.toLowerCase()
            && comment.body.includes(input.marker);
          if (exact) {
            exactIds.push(comment.id);
            continue;
          }
          let structured = null;
          try {
            structured = parseHumanCommentEvidence(comment.body);
          } catch {
            otherStructured = true;
            continue;
          }
          if (isRetiredMappingAudit(input, comment.body, author)) continue;
          if (
            structured !== null
            || comment.body.includes('<!-- jinn-autopilot-human:')
            || isUnstructuredHumanHoldComment(comment.body)
          ) {
            otherStructured = true;
          }
        }
        return { exactIds, otherStructured };
      };

      const fence = async (
        expectedReviewState: 'human' | 'stale',
        requireInitialOid = false,
      ): Promise<ReconciliationPullRequestNode> => {
        invalidateActionAuthority();
        const [canonical, raw, project, nativeIssue, liveDependencies, commentRead] =
          await Promise.all([
            options.readCanonicalSnapshot!(input.prNumber),
            options.readPullRequestByNumber(input.prNumber),
            options.readProjectItemForReconciliation(input.issueNumber),
            options.readIssueByNumber(input.issueNumber),
            options.readBlockedByIssueNumbers(input.issueNumber),
            runAsRepairAuthor(({ run }) => readHumanComments(run)),
          ]);
        const cycleMapping = options.cycleSnapshot.pullRequestMappings?.find(
          (mapping) => mapping.prNumber === input.prNumber,
        );
        const liveMapping = canonical?.pullRequestMappings?.find(
          (mapping) => mapping.prNumber === input.prNumber,
        );
        const livePr = canonical?.pullRequests.find((pr) => pr.number === input.prNumber);
        const liveIssue = canonical?.issues.find((issue) => issue.number === input.issueNumber);
        if (
          canonical?.snapshotComplete !== true
          || cycleMapping?.status !== 'resolved'
          || liveMapping?.status !== 'resolved'
          || liveMapping.issueNumber !== input.issueNumber
          || liveMapping.expectedBaseRefName !== cycleMapping.expectedBaseRefName
          || livePr?.state !== 'OPEN'
          || livePr.headOid !== input.expectedHead
          || livePr.baseRefName !== liveMapping.expectedBaseRefName
          || raw === null
          || raw.state !== 'OPEN'
          || gitOid(raw.headOid) !== input.expectedHead
          || raw.baseRefName !== liveMapping.expectedBaseRefName
          || liveIssue === undefined
          || project === null
          || project.blockedOn === 'Human'
          || nativeIssue === null
          || !nativeIssue.open
          || nativeIssue.labels.includes('review:needs-human')
          || nativeIssue.labels.includes('autopilot:human')
        ) {
          throw new Error('Obsolete mapping Human canonical or Human authority changed');
        }
        const expectedDependencies = [...liveIssue.blockedByIssues]
          .sort((left, right) => left - right);
        const observedDependencies = [...liveDependencies]
          .sort((left, right) => left - right);
        if (
          expectedDependencies.length !== observedDependencies.length
          || expectedDependencies.some((number, index) => (
            number !== observedDependencies[index]
          ))
        ) {
          throw new Error('Obsolete mapping Human dependency authority changed');
        }
        const claim = raw.reviewClaim;
        if (claim === null) {
          throw new Error('Obsolete mapping Human review-ref authority is absent');
        }
        const record = decodeReviewClaimPayload(claim.payload);
        if (
          (requireInitialOid && gitOid(claim.oid) !== input.expectedReviewRefOid)
          || record.generation !== input.expectedGeneration
          || record.head !== input.expectedHead
          || record.state !== expectedReviewState
        ) {
          throw new Error('Obsolete mapping Human review-ref authority changed');
        }
        const labelPresent = raw.labels.includes(NEEDS_HUMAN_LABEL);
        if (
          (
            labelPresent
            || raw.isDraft
            || raw.humanIssueNumber !== input.issueNumber
            || raw.humanAuthor?.toLowerCase() !== input.expectedAuthor.toLowerCase()
            || raw.humanHead !== input.expectedHead
            || raw.humanGeneration !== input.expectedGeneration
            || raw.humanReason?.code !== 'branch-mapping-ambiguous'
            || commentRead.exactIds.length !== 1
            || commentRead.otherStructured
          )
        ) {
          throw new Error('Obsolete mapping Human overlay provenance changed');
        }
        return raw;
      };

      const before = await fence('human', true).catch(async (error) => {
        const retry = await fence('stale', true).catch(() => null);
        if (retry !== null) return retry;
        throw error;
      });
      const beforeRecord = decodeReviewClaimPayload(before.reviewClaim!.payload);
      if (beforeRecord.state === 'human') {
        await updateReviewRef(
          input.prNumber,
          input.expectedReviewRefOid,
          'stale',
          true,
          repairCredential,
        );
      }
      await fence('stale');
    },

    async readObsoleteMappingHumanRepairState(input) {
      if (options.readCanonicalSnapshot === undefined) return { complete: false };
      const repairCredential = repairCredentialForAuthor(input.expectedAuthor);
      invalidateActionAuthority();
      const [canonical, raw, commentsRaw] = await Promise.all([
        options.readCanonicalSnapshot(input.prNumber),
        options.readPullRequestByNumber(input.prNumber),
        withSelectedCredential(repairCredential, ambient, ({ run }) => run('gh', [
          'api', `repos/${repositorySlug}/issues/${input.prNumber}/comments`,
          '--paginate', '--slurp',
        ]), runner),
      ]);
      const mapping = canonical?.pullRequestMappings?.find(
        (candidate) => candidate.prNumber === input.prNumber,
      );
      const claim = raw?.reviewClaim === null || raw?.reviewClaim === undefined
        ? undefined
        : decodeReviewClaimPayload(raw.reviewClaim.payload);
      const parsed = JSON.parse(commentsRaw) as unknown;
      if (!Array.isArray(parsed)) return { complete: false };
      const rows = parsed.every((entry) => Array.isArray(entry)) ? parsed.flat() : parsed;
      let exactComments = 0;
      let otherStructuredComments = 0;
      for (const entry of rows) {
        if (typeof entry !== 'object' || entry === null) {
          otherStructuredComments += 1;
          continue;
        }
        const comment = entry as {
          body?: unknown;
          user?: { login?: unknown } | null;
        };
        if (typeof comment.body !== 'string') {
          otherStructuredComments += 1;
          continue;
        }
        const exact = comment.body.includes(input.marker)
          && typeof comment.user?.login === 'string'
          && comment.user.login.toLowerCase() === input.expectedAuthor.toLowerCase();
        if (exact) {
          exactComments += 1;
          continue;
        }
        try {
          if (
            isRetiredMappingAudit(
              input,
              comment.body,
              comment.user?.login,
            )
          ) {
            continue;
          }
          if (
            parseHumanCommentEvidence(comment.body) !== null
            || comment.body.includes('<!-- jinn-autopilot-human:')
            || isUnstructuredHumanHoldComment(comment.body)
          ) {
            otherStructuredComments += 1;
          }
        } catch {
          otherStructuredComments += 1;
        }
      }
      return {
        complete: canonical?.snapshotComplete === true
          && mapping?.status === 'resolved'
          && mapping.issueNumber === input.issueNumber
          && raw?.state === 'OPEN'
          && gitOid(raw.headOid) === input.expectedHead
          && !raw.labels.includes(NEEDS_HUMAN_LABEL)
          && !raw.isDraft
          && claim?.head === input.expectedHead
          && claim.generation === input.expectedGeneration
          && claim.state === 'stale'
          && exactComments === 1
          && otherStructuredComments === 0,
      };
    },

    markReviewStale: (prNumber, expectedReviewRefOid) =>
      updateReviewRef(prNumber, expectedReviewRefOid, 'stale'),

    completeVerdictIntent: (prNumber, expectedReviewRefOid, state) =>
      updateReviewRef(prNumber, expectedReviewRefOid, state),
  };
}
