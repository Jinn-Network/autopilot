import { cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AutopilotAdoptionReceipt,
  AutopilotCorrelation,
} from '@jinn-network/sdk/autopilot';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { REPO } from '../dispatcher/constants.js';
import {
  proveMarketplaceAttemptWorktree,
  readAttemptManifest,
  type AttemptManifest,
} from './attempt-workspace.js';
import {
  decodeReviewClaimPayload,
  extractImplementationCompletionSummary,
  terminalBranchClaimTrailers,
} from './codecs.js';
import {
  readAttemptTokenFile,
  sanitizedGitHubCommandOverlay,
  type CredentialPool,
} from './credentials.js';
import { hasExternalHumanAuthority } from './human-authority.js';
import {
  IMPLEMENTATION_SUMMARY_END,
  IMPLEMENTATION_SUMMARY_START,
  makeImplementationSessionProtocol,
} from './implementation-session.js';
import {
  makeProductionImplementationSessionPort,
} from './implementation-session-production.js';
import type {
  AdoptionReceiptComment,
  AdoptionReceiptExactFacts,
  AdoptionReceiptPorts,
} from './marketplace-adoption-receipt.js';
import { observeMarketplaceSolutionDelivery } from './marketplace-delivery.js';
import {
  makeMarketplaceMutationAdoptionCoordinator,
  type MarketplaceMutationAdoptionCoordinator,
  type MarketplaceMutationAuthority,
  type MarketplaceMutationAuthorityPort,
} from './marketplace-mutation-adoption.js';
import { createMarketplaceMutationGitPort } from './marketplace-mutation-git.js';
import {
  createProductionMarketplaceVerificationPort,
  createMarketplaceVerificationDockerInspector,
  createMarketplaceVerificationDockerSandbox,
  type MarketplaceVerificationDockerRunner,
} from './marketplace-mutation-verification-production.js';
import type { MarketplaceMutationVerificationPort } from './marketplace-mutation-verification.js';
import type {
  MarketplaceAttemptWorktreeProofPort,
  MarketplacePatchApplicationPorts,
} from './marketplace-patch.js';
import {
  applyMarketplacePatchToWorktree,
  runMarketplacePatchGit,
  validateMarketplacePatch,
  type MarketplaceAttemptWorktreeProof,
} from './marketplace-patch.js';
import type { MarketplaceReviewAnchorOrigin } from './marketplace-review-anchor.js';
import { transitionMarketplaceAdoption } from './marketplace-adoption-state.js';
import { parseChildMarker } from './child-issues.js';
import {
  makeProductionMarketplaceReviewAnchorPort,
  makeProductionReviewActionPort,
} from './review-executor-production.js';
import { verifyMarketplaceTaskRequest } from './marketplace-task.js';
import type { GitHubLifecycleSnapshot } from './snapshot.js';
import { gitOid, type GitOid } from './types.js';

const GITHUB_PAGE_SIZE = 100;
const AUTOPILOT_V2_REMOTE = 'jinn-autopilot-v2';

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Malformed ${name}`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`Malformed ${name}`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Malformed ${name}`);
  }
  return value;
}

function pageNumber(cursor: string | undefined): number {
  if (cursor === undefined) return 1;
  if (!/^[1-9][0-9]*$/.test(cursor)) {
    throw new Error('Malformed GitHub adoption comment cursor');
  }
  return Number(cursor);
}

function parseComment(value: unknown): AdoptionReceiptComment | null {
  try {
    const comment = record(value, 'GitHub adoption comment');
    const user = record(comment.user, 'GitHub adoption comment author');
    return {
      id: positiveInteger(comment.id, 'GitHub adoption comment ID'),
      authorLogin: stringField(user.login, 'GitHub adoption comment login'),
      body: stringField(comment.body, 'GitHub adoption comment body'),
      createdAt: stringField(
        comment.created_at,
        'GitHub adoption comment creation',
      ),
      updatedAt: stringField(
        comment.updated_at,
        'GitHub adoption comment update',
      ),
    };
  } catch {
    return null;
  }
}

function parsePullRequest(raw: string): {
  readonly number: number;
  readonly head: GitOid;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly open: boolean;
  readonly draft: boolean;
  readonly labels: readonly string[];
  readonly body: string;
} {
  const value = record(JSON.parse(raw) as unknown, 'GitHub pull request');
  const rawLabels = value.labels;
  if (rawLabels !== undefined && !Array.isArray(rawLabels)) {
    throw new Error('Malformed GitHub pull request labels');
  }
  const labels = (rawLabels ?? []).map((entry) => {
    const label = record(entry, 'GitHub pull request label');
    return stringField(label.name, 'GitHub pull request label name');
  });
  const state = stringField(value.state, 'GitHub pull request state');
  return {
    number: positiveInteger(value.number, 'GitHub pull request number'),
    head: gitOid(stringField(value.headRefOid, 'GitHub pull request head')),
    headRefName: stringField(value.headRefName, 'GitHub pull request head ref'),
    baseRefName: stringField(value.baseRefName, 'GitHub pull request base ref'),
    open: state === 'OPEN',
    draft: value.isDraft === true,
    labels,
    body: typeof value.body === 'string' ? value.body : '',
  };
}

function implementationSummary(body: string): string | undefined {
  const start = body.indexOf(IMPLEMENTATION_SUMMARY_START);
  const end = body.indexOf(IMPLEMENTATION_SUMMARY_END);
  if (start === -1 || end < start) return undefined;
  return body.slice(
    start + IMPLEMENTATION_SUMMARY_START.length,
    end,
  ).trim();
}

export function secureMarketplaceAdoptionGitHubRunner(
  manifestPath: string,
  runner: CommandRunner,
  ambient: NodeJS.ProcessEnv,
): CommandRunner {
  const manifest = readAttemptManifest(manifestPath);
  const token = readAttemptTokenFile(manifest.paths.tokenFile);
  if (token === undefined) {
    throw new Error('Marketplace adoption GitHub credential is unavailable');
  }
  const environment = sanitizedGitHubCommandOverlay(ambient, {
    GH_TOKEN: token,
  });
  return (command, args, options) => runner(command, args, {
    ...options,
    env: { ...options?.env, ...environment },
  });
}

async function verifyAcceptedSolutionReviewAuthority(input: {
  readonly receipt: Extract<AutopilotAdoptionReceipt, { readonly disposition: 'accepted' }>;
  readonly expected: AdoptionReceiptExactFacts & { readonly disposition: 'accepted' };
  readonly manifest: AttemptManifest;
  readonly run: CommandRunner;
  readonly prHead: GitOid;
}): Promise<boolean> {
  const { receipt, expected, manifest, run, prHead } = input;
  if (receipt.role !== 'solution' || expected.role !== 'solution') return false;
  const reviewRefOid = expected.expectedReview.refOid;
  const generation = expected.expectedReview.generation;
  const ref = `refs/jinn-autopilot/review-claims/v1/${expected.prNumber}`;
  const lines = (await run('git', [
    '-C', manifest.paths.worktree,
    'ls-remote', manifest.repository.remoteName, ref,
  ])).trim().split('\n').filter(Boolean);
  if (lines.length !== 1) return false;
  const [currentOid, observedRef, extra] = lines[0]!.split('\t');
  if (
    currentOid === undefined
    || observedRef !== ref
    || extra !== undefined
    || gitOid(currentOid) !== reviewRefOid
  ) {
    return false;
  }
  await run('git', [
    '-C', manifest.paths.worktree,
    'fetch', '--quiet', manifest.repository.remoteName, ref,
  ]);
  const record = decodeReviewClaimPayload((await run('git', [
    '-C', manifest.paths.worktree,
    'show', `${reviewRefOid}:jinn-autopilot-review.json`,
  ])).trim());
  return record.state === 'active'
    && record.prNumber === expected.prNumber
    && record.generation === generation
    && record.head === expected.resultingHead
    && prHead === expected.publicationHead;
}

export function makeProductionMarketplaceAdoptionReceiptPorts(options: {
  readonly manifestPath: string;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
}): AdoptionReceiptPorts {
  const manifest = readAttemptManifest(options.manifestPath);
  const run = secureMarketplaceAdoptionGitHubRunner(
    options.manifestPath,
    options.runner ?? defaultRunner,
    options.environment ?? process.env,
  );
  const readPullRequest = async (prNumber: number) => parsePullRequest(await run('gh', [
    'pr', 'view', String(prNumber),
    '--repo', REPO,
    '--json', 'number,headRefName,baseRefName,headRefOid,isDraft,labels,body,state',
  ]));
  const readHead = async (prNumber: number): Promise<GitOid> =>
    (await readPullRequest(prNumber)).head;
  return {
    async listPrIssueComments({ prNumber, cursor }) {
      const page = pageNumber(cursor);
      const raw = JSON.parse(await run('gh', [
        'api', '--method', 'GET',
        `repos/${REPO}/issues/${prNumber}/comments`,
        '-f', `per_page=${GITHUB_PAGE_SIZE}`,
        '-f', `page=${page}`,
      ])) as unknown;
      if (!Array.isArray(raw)) throw new Error('Malformed GitHub adoption comments');
      const comments = raw
        .map(parseComment)
        .filter((comment): comment is AdoptionReceiptComment => comment !== null);
      return {
        comments,
        ...(raw.length === GITHUB_PAGE_SIZE
          ? { nextCursor: String(page + 1) }
          : {}),
      };
    },
    async verifyReceiptFacts({ expected, receipt }) {
      if (receipt.disposition !== 'accepted') return true;
      const pr = await readPullRequest(expected.prNumber);
      if (expected.disposition !== 'accepted') return true;
      return verifyAcceptedSolutionReviewAuthority({
        receipt,
        expected,
        manifest,
        run,
        prHead: pr.head,
      });
    },
    readCurrentPrHead: readHead,
    async createPrComment({ prNumber, expectedHead, body }) {
      if (await readHead(prNumber) !== expectedHead) {
        throw new Error('Marketplace adoption receipt lost exact-head authority');
      }
      const created = record(JSON.parse(await run('gh', [
        'api', '--method', 'POST',
        `repos/${REPO}/issues/${prNumber}/comments`,
        '-f', `body=${body}`,
      ])) as unknown, 'created GitHub adoption comment');
      const commentId = positiveInteger(
        created.id,
        'created GitHub adoption comment ID',
      );
      const author = record(created.user, 'created GitHub adoption comment author');
      const authorLogin = stringField(author.login, 'created GitHub adoption comment login');
      if (await readHead(prNumber) !== expectedHead) {
        throw new Error(
          'Marketplace adoption receipt head changed during publication',
        );
      }
      return { commentId, author: authorLogin };
    },
  };
}

function mappingFacts(
  snapshot: GitHubLifecycleSnapshot,
  prNumber: number,
  sessionIssueNumber: number,
): Pick<
  MarketplaceMutationAuthority['pullRequest'],
  'canonicalIssueNumber' | 'mappingStatus'
> {
  const mapping = snapshot.pullRequestMappings?.find(
    (entry) => entry.prNumber === prNumber,
  );
  if (mapping === undefined) {
    return { canonicalIssueNumber: sessionIssueNumber, mappingStatus: 'missing' };
  }
  if (mapping.status === 'ambiguous') {
    return {
      canonicalIssueNumber: mapping.issueNumbers[0] ?? sessionIssueNumber,
      mappingStatus: 'ambiguous',
    };
  }
  return {
    canonicalIssueNumber: mapping.issueNumber,
    mappingStatus: 'resolved',
  };
}

function reviewAnchorOrigin(
  manifestPath: string,
  manifest: AttemptManifest,
): MarketplaceReviewAnchorOrigin {
  const state = manifest.execution.backend === 'marketplace'
    && manifest.execution.state.schemaVersion === 'marketplace-execution-v3'
    ? manifest.execution.state
    : undefined;
  const delivery = state !== undefined && 'delivery' in state
    ? state.delivery
    : undefined;
  const correlation: AutopilotCorrelation = delivery?.correlation ?? {
    taskId: '0',
    attemptIndex: 0,
    requestId: '0'.repeat(66),
    deliveryEnvelopeCid: 'pending',
    v2AttemptId: manifest.attemptId,
    claimOid: gitOid(manifest.claimOid),
    prNumber: manifest.prNumber ?? 0,
    expectedHead: gitOid(manifest.expectedHead),
  };
  return {
    originManifestPath: manifestPath,
    originV2AttemptId: manifest.attemptId,
    originRequestDigest: state?.requestDigest ?? '',
    taskId: delivery?.taskId ?? '0',
    taskCid: delivery?.taskCid ?? 'pending',
    taskCreationBlock: delivery?.taskCreationBlock ?? 0,
    correlation,
  };
}

export function makeProductionMarketplaceMutationAuthorityPort(options: {
  readonly originManifestPath: string;
  readonly repositoryPath: string;
  readonly worktreeBase: string;
  readonly runnerId: string;
  readonly readSnapshot: () => Promise<GitHubLifecycleSnapshot>;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
}): MarketplaceMutationAuthorityPort {
  const runner = options.runner ?? defaultRunner;
  const ambient = options.environment ?? process.env;
  const sessionEnvironment = { ...ambient };
  delete sessionEnvironment.GH_TOKEN;
  delete sessionEnvironment.GITHUB_TOKEN;
  sessionEnvironment.JINN_AUTOPILOT_SESSION_MANIFEST = options.originManifestPath;
  const implementationPort = makeProductionImplementationSessionPort({
    runner,
    environment: sessionEnvironment,
  });
  const gh = secureMarketplaceAdoptionGitHubRunner(
    options.originManifestPath,
    runner,
    ambient,
  );
  const receiptPorts = makeProductionMarketplaceAdoptionReceiptPorts({
    manifestPath: options.originManifestPath,
    runner,
    environment: ambient,
  });
  return {
    async readExactAuthority({ manifestPath, touchedPaths: _touchedPaths }) {
      if (manifestPath !== options.originManifestPath) {
        throw new Error('Marketplace authority requested a foreign manifest');
      }
      const manifest = readAttemptManifest(manifestPath);
      const authority = await implementationPort.readAuthority(manifest);
      const pullRequest = parsePullRequest(await gh('gh', [
        'pr', 'view', String(manifest.prNumber),
        '--repo', REPO,
        '--json', 'number,headRefName,baseRefName,headRefOid,isDraft,labels,body,state',
      ]));
      const snapshot = await options.readSnapshot();
      const issue = snapshot.issues.find((entry) => entry.number === manifest.issueNumber);
      const projectItem = snapshot.project.items.find((entry) =>
        entry.contentType === 'Issue' && entry.number === manifest.issueNumber);
      const mapping = mappingFacts(snapshot, pullRequest.number, manifest.issueNumber);
      const reviewPort = makeProductionReviewActionPort({
        repositoryPath: options.repositoryPath,
        worktreeBase: options.worktreeBase,
        runnerId: options.runnerId,
        readSnapshot: () => options.readSnapshot(),
        runner,
        environment: ambient,
      });
      const candidate = await reviewPort.readCandidate(pullRequest.number);
      let commentCursor: string | undefined;
      let humanComment = false;
      for (let page = 0; page < 100; page += 1) {
        const comments = await receiptPorts.listPrIssueComments({
          prNumber: pullRequest.number,
          ...(commentCursor === undefined ? {} : { cursor: commentCursor }),
        });
        humanComment ||= comments.comments.some((comment) =>
          comment.body.includes('<!-- jinn-autopilot:v2-human'));
        if (comments.nextCursor === undefined) break;
        commentCursor = comments.nextCursor;
        if (page === 99) {
          throw new Error('Marketplace authority comment pagination exceeded its bound');
        }
      }
      const humanActive = hasExternalHumanAuthority({
        pullRequestLabels: pullRequest.labels,
        nativeIssueLabels: issue?.labels,
        projectBlockedOn: projectItem?.blockedOn ?? null,
      }) || humanComment;
      const codeOwnerRequired = candidate?.approvalPolicy === 'human-codeowner';
      let child: MarketplaceMutationAuthority['child'];
      const execution = manifest.execution;
      if (
        execution.backend === 'marketplace'
        && execution.state.schemaVersion === 'marketplace-execution-v3'
      ) {
        const request = verifyMarketplaceTaskRequest(
          execution.state.requestPath,
          execution.state.requestDigest,
        );
        const session = request.spec.session;
        if (
          session.childIssueNumber !== undefined
          && session.parentPrNumber !== undefined
        ) {
          const raw = record(JSON.parse(await gh('gh', [
            'issue', 'view', String(session.childIssueNumber),
            '--repo', REPO,
            '--json', 'number,state,body',
          ])) as unknown, 'marketplace child issue');
          const marker = parseChildMarker(
            typeof raw.body === 'string' ? raw.body : '',
          );
          child = {
            number: positiveInteger(raw.number, 'marketplace child issue number'),
            parentPrNumber: session.parentPrNumber,
            kind: session.workflow === 'reconcile'
              ? 'reconcile'
              : session.workflow === 'ci-failure'
                ? 'ci-failure'
                : marker?.kind === 'reconcile'
                  ? 'reconcile'
                  : marker?.kind === 'ci-failure'
                    ? 'ci-failure'
                    : 'review-finding',
            open: stringField(raw.state, 'marketplace child issue state') === 'OPEN',
          };
        }
      }
      const authors = execution.backend === 'marketplace'
        && execution.state.schemaVersion === 'marketplace-execution-v3'
        ? verifyMarketplaceTaskRequest(
          execution.state.requestPath,
          execution.state.requestDigest,
        ).spec.session.receiptAuthors
        : [manifest.selectedLogin];
      const summaryFromBody = implementationSummary(pullRequest.body);
      const summaryFromClaim = await (async () => {
        const message = await runner('git', [
          '-C', manifest.paths.worktree,
          'show', '-s', '--format=%B', authority.latestClaimOid,
        ]);
        const trailers = terminalBranchClaimTrailers(message);
        if (trailers === null) return null;
        return extractImplementationCompletionSummary(message, trailers);
      })().catch(() => null);
      return {
        manifest,
        remoteHead: authority.remoteHead,
        latestClaimOid: authority.latestClaimOid,
        latestClaim: authority.latestClaim,
        pullRequest: {
          number: pullRequest.number,
          head: pullRequest.head,
          headRefName: pullRequest.headRefName,
          baseRefName: pullRequest.baseRefName,
          open: pullRequest.open,
          draft: pullRequest.draft,
          labels: pullRequest.labels,
          ...(summaryFromBody === undefined && summaryFromClaim === null
            ? {}
            : { implementationSummary: summaryFromBody ?? summaryFromClaim ?? undefined }),
          canonicalIssueNumber: mapping.canonicalIssueNumber,
          mappingStatus: mapping.mappingStatus,
          humanActive,
          codeOwnerRequired,
        },
        ...(child === undefined ? {} : { child }),
        receiptAuthors: authors,
      };
    },
  };
}

async function buildWorktreeProof(
  manifest: AttemptManifest,
  runner: CommandRunner,
  input: {
    readonly manifestPath: string;
    readonly worktreePath: string;
    readonly expectedHead: GitOid;
  },
): Promise<MarketplaceAttemptWorktreeProof> {
  await proveMarketplaceAttemptWorktree(manifest, runner);
  const currentHead = gitOid((await runner('git', [
    '-C', input.worktreePath,
    'rev-parse', '--verify', 'HEAD^{commit}',
  ])).trim());
  return {
    manifestPath: input.manifestPath,
    registeredWorktreePath: input.worktreePath,
    expectedHead: input.expectedHead,
    currentHead,
    indexClean: true,
    worktreeClean: true,
    untrackedPaths: [],
  };
}

function makeWorktreeProofPort(
  runner: CommandRunner,
): MarketplaceAttemptWorktreeProofPort {
  return {
    async prove(input) {
      const manifest = readAttemptManifest(input.manifestPath);
      return buildWorktreeProof(manifest, runner, input);
    },
  };
}

export async function copyWorktreeForVerification(
  sourcePath: string,
  workspacePath: string,
): Promise<void> {
  await cp(sourcePath, workspacePath, {
    recursive: true,
    force: true,
    filter: (path) => !shouldExcludeWorktreeVerificationCopyPath(sourcePath, path),
  });
}

export function shouldExcludeWorktreeVerificationCopyPath(
  sourcePath: string,
  path: string,
): boolean {
  const gitDir = join(sourcePath, '.git');
  return path === gitDir
    || path.startsWith(`${gitDir}/`)
    || path.includes('node_modules');
}

export interface ProductionMarketplaceMutationAdoptionOptions {
  readonly originManifestPath: string;
  readonly repositoryPath: string;
  readonly worktreeBase: string;
  readonly runnerId: string;
  readonly credentials: CredentialPool;
  readonly readSnapshot: () => Promise<GitHubLifecycleSnapshot>;
  readonly staleAfterMs: number;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly nextId?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly verification?: MarketplaceMutationVerificationPort;
  readonly dockerRunner?: MarketplaceVerificationDockerRunner;
}

export function makeProductionMarketplacePatchPorts(
  worktreeProof: MarketplaceAttemptWorktreeProofPort,
): MarketplacePatchApplicationPorts {
  return {
    worktreeProof,
    runGit: runMarketplacePatchGit,
  };
}

export function makeProductionMarketplaceMutationAdoptionCoordinator(
  options: ProductionMarketplaceMutationAdoptionOptions,
): MarketplaceMutationAdoptionCoordinator {
  const runner = options.runner ?? defaultRunner;
  const ambient = options.environment ?? process.env;
  const implementationEnvironment = { ...ambient };
  delete implementationEnvironment.GH_TOKEN;
  delete implementationEnvironment.GITHUB_TOKEN;
  implementationEnvironment.JINN_AUTOPILOT_SESSION_MANIFEST =
    options.originManifestPath;
  const manifest = readAttemptManifest(options.originManifestPath);
  const origin = reviewAnchorOrigin(options.originManifestPath, manifest);
  const implementation = makeImplementationSessionProtocol(
    makeProductionImplementationSessionPort({
      runner,
      environment: implementationEnvironment,
      now: options.now,
    }),
  );
  const dockerSandbox = options.verification === undefined
    ? (options.dockerRunner === undefined
      ? createMarketplaceVerificationDockerSandbox()
      : {
        dockerRunner: options.dockerRunner,
        dockerInspector: createMarketplaceVerificationDockerInspector(),
        cleanup: async () => 'confirmed' as const,
      })
    : undefined;
  const verification = options.verification
    ?? createProductionMarketplaceVerificationPort({
      dockerRunner: dockerSandbox!.dockerRunner,
      dockerInspector: dockerSandbox!.dockerInspector,
      cleanup: dockerSandbox!.cleanup,
      prepareWorkspace: async ({ sourcePath, workspacePath }) => {
        await copyWorktreeForVerification(sourcePath, workspacePath);
      },
      workspacePath: join(
        tmpdir(),
        `jinn-autopilot-verify-${manifest.attemptId}`,
      ),
      ambientEnvironment: ambient,
      now: options.now,
    });
  const reviewAnchors = makeProductionMarketplaceReviewAnchorPort({
    repositoryPath: options.repositoryPath,
    worktreeBase: options.worktreeBase,
    runnerId: options.runnerId,
    readSnapshot: () => options.readSnapshot(),
    runner,
    environment: ambient,
    origin,
    credentials: options.credentials,
    staleAfterMs: options.staleAfterMs,
    nextAttemptId: options.nextId,
    nextGeneration: options.nextId,
    sleep: options.sleep,
    remoteName: AUTOPILOT_V2_REMOTE,
  });
  const worktreeProof = makeWorktreeProofPort(runner);
  return makeMarketplaceMutationAdoptionCoordinator({
    observe: observeMarketplaceSolutionDelivery,
    readAuthority: makeProductionMarketplaceMutationAuthorityPort({
      originManifestPath: options.originManifestPath,
      repositoryPath: options.repositoryPath,
      worktreeBase: options.worktreeBase,
      runnerId: options.runnerId,
      readSnapshot: options.readSnapshot,
      runner,
      environment: ambient,
    }),
    validatePatch: validateMarketplacePatch,
    applyPatch: (input) => applyMarketplacePatchToWorktree(
      input,
      makeProductionMarketplacePatchPorts(worktreeProof),
    ),
    git: createMarketplaceMutationGitPort(),
    verification,
    implementation,
    reviewAnchors,
    receipts: makeProductionMarketplaceAdoptionReceiptPorts({
      manifestPath: options.originManifestPath,
      runner,
      environment: ambient,
    }),
    transition: transitionMarketplaceAdoption,
    now: options.now,
  });
}
