import type { DispatcherConfig, Effort } from '../dispatcher/types.js';
import type { AutopilotExecutionBackend } from '../config/execution-backend.js';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import {
  spawnCoordinatorSession,
  type SpawnFn,
  type SpawnResult,
} from '../dispatcher/coordinator-session.js';
import type { RealityCheckVerdict } from '../triage/types.js';
import { gatherRealityCheckSignals } from '../triage/gather.js';
import { classifyRealityCheck } from '../triage/reality-check.js';
import {
  buildSanitizedChildEnv,
  selectCredential,
  type CredentialPool,
  type SelectedCredential,
} from './credentials.js';
import {
  hasReviewFollowUpMarkerTag,
  parseReviewFollowUpMarker,
} from './review-follow-ups.js';
import type { HumanReason, ImplementationClaimAction } from './types.js';
import type {
  LocalImplementationSessionExecutionRequest,
  MarketplaceSessionExecutionRequest,
  SessionExecutionResult,
} from './session-execution-backend.js';
import {
  buildMarketplaceTaskRequest,
  MARKETPLACE_LANGUAGE,
  MARKETPLACE_REPOSITORY,
  MARKETPLACE_VERIFICATION_PROFILE,
  type MarketplaceMutationWorkflow,
} from './marketplace-task.js';
import type {
  MarketplaceAttemptPreparation,
} from './attempt-workspace.js';
import {
  gitOid,
  gitRefName,
  type BranchClaim,
  type ClaimOutcome,
  type GitOid,
  type GitRefName,
} from './types.js';

export let CANONICAL_GITHUB_HTTPS_REMOTE =
  process.env.AUTOPILOT_REPOSITORY_URL ?? '';

export function configureCanonicalGitHubRemote(repositoryUrl: string): void {
  CANONICAL_GITHUB_HTTPS_REMOTE = repositoryUrl;
}

export async function runCanonicalImplementationRealityCheck(
  issueNumber: number,
  runner: CommandRunner,
  repositorySlug?: string,
): Promise<RealityCheckVerdict> {
  return classifyRealityCheck(
    await gatherRealityCheckSignals(issueNumber, runner, repositorySlug),
  );
}

export interface ImplementationIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly open: boolean;
  readonly eligible: boolean;
  readonly eligibilityDetail?: string;
  readonly targetBase: GitRefName;
  readonly effort: Effort | null;
  /** Present when this issue is a Stage 2 machine child targeting a parent PR. */
  readonly child?: {
    readonly parentPr: number;
    readonly kind: 'review-finding' | 'reconcile' | 'ci-failure';
  };
}

export interface StaleImplementationRecoveryState {
  readonly issue: ImplementationIssue | null;
  /**
   * Why the authority port withheld `issue`, when it did. Same shape as
   * `TargetedAuthorityRefusal` in `targeted-action-reader.ts`: a `null`
   * projection alone is unattributable, so the port names the cause at the
   * site that produced it and the rejection message repeats it verbatim.
   * Absent when the port has nothing more specific to say than `issue: null`.
   */
  readonly issueRefusal?: string;
  readonly projectStatus: 'Todo' | 'In Progress' | 'Human' | 'In Review' | 'Done' | null;
  readonly humanHold: boolean;
  readonly pullRequest: (ImplementationPullRequest & {
    readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  }) | null;
  readonly openPullRequests: readonly ImplementationPullRequest[];
  readonly claim: BranchClaim | null;
}

export interface ImplementationPullRequest {
  readonly number: number;
  readonly headRefName: GitRefName;
  readonly head: GitOid;
  readonly baseRefName: GitRefName;
  readonly draft: boolean;
  readonly labels: readonly string[];
  readonly body: string;
}

export interface ImplementationAttemptBinding {
  readonly attemptId: string;
  readonly paths: {
    readonly worktree: string;
    readonly manifest: string;
    readonly log: string;
    readonly ghConfigDir: string;
    readonly askpass: string;
  };
}

interface ClaimPublicationInput {
  readonly branch: GitRefName;
  readonly candidateParent: GitOid;
  readonly expectedRemoteHead: GitOid | null;
  readonly claimOid: GitOid;
  readonly remoteUrl: string;
  readonly login: string;
  readonly credential: SelectedCredential;
}

interface DraftPullRequestInput {
  readonly issueNumber: number;
  readonly branch: GitRefName;
  readonly claimOid: GitOid;
  readonly targetBase: GitRefName;
  readonly title: string;
  readonly body: string;
  readonly draft: true;
  readonly label: string;
  readonly credential: SelectedCredential;
}

interface CreateAttemptInput {
  readonly attemptId: string;
  readonly issueNumber: number;
  readonly branch: GitRefName;
  readonly targetBase: GitRefName;
  readonly targetBaseOid?: GitOid;
  readonly expectedHead: GitOid;
  readonly claimOid: GitOid;
  readonly prNumber: number;
  readonly selectedLogin: string;
  readonly credential: SelectedCredential;
  readonly marketplacePreparation?: MarketplaceAttemptPreparation;
}

export interface SpawnImplementationInput {
  readonly attemptId: string;
  readonly issue: ImplementationIssue;
  readonly prNumber: number;
  readonly branch: GitRefName;
  readonly targetBase: GitRefName;
  readonly environment: NodeJS.ProcessEnv;
  readonly worktreePath: string;
  readonly logPath: string;
}

export interface ImplementationExecutorDeps {
  readonly executionBackend?: AutopilotExecutionBackend;
  readonly marketplace?: {
    readonly repository: string;
    readonly language: string;
    readonly verificationProfile: string;
  };
  readIssue(issueNumber: number): Promise<ImplementationIssue | null>;
  readStaleRecovery(
    issueNumber: number,
    prNumber: number,
  ): Promise<StaleImplementationRecoveryState>;
  runRealityCheck(issueNumber: number): Promise<RealityCheckVerdict>;
  listOpenPullRequests(issueNumber: number): Promise<readonly ImplementationPullRequest[]>;
  credentials: CredentialPool;
  remoteUrl: string;
  readTargetBaseHead(targetBase: GitRefName, credential: SelectedCredential): Promise<GitOid>;
  createClaimCommit(input: {
    readonly claim: BranchClaim;
    readonly parent: GitOid;
    readonly parentFetchRef: GitRefName;
    readonly attempt: string;
    readonly credential: SelectedCredential;
  }): Promise<GitOid>;
  claimBranch(input: ClaimPublicationInput): Promise<ClaimOutcome>;
  ensureDraftPullRequest(input: DraftPullRequestInput): Promise<ImplementationPullRequest>;
  readParentPullRequest?(prNumber: number): Promise<ImplementationPullRequest | null>;
  setProjectInProgress(
    issueNumber: number,
    expectedHead: GitOid,
    credential: SelectedCredential,
  ): Promise<void>;
  createAttempt(input: CreateAttemptInput): Promise<ImplementationAttemptBinding>;
  startSession(
    request:
      | LocalImplementationSessionExecutionRequest<SpawnImplementationInput>
      | Extract<
          MarketplaceSessionExecutionRequest,
          { readonly kind: 'implementation' }
        >,
  ): Promise<SessionExecutionResult>;
  escalateHuman(input: {
    readonly issueNumber: number;
    readonly reason: HumanReason;
  }): Promise<void>;
  closeChildIssue?(input: {
    readonly issueNumber: number;
    readonly comment: string;
    readonly credential: SelectedCredential;
  }): Promise<void>;
  ambientEnvironment: NodeJS.ProcessEnv;
  nextAttemptId(): string;
  runnerId: string;
  now(): Date;
}

export type ImplementationExecutionResult =
  | {
      readonly status: 'spawned';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly branch: GitRefName;
      readonly claimOid: GitOid;
      readonly attemptId: string;
    }
  | {
      readonly status: 'ineligible';
      readonly issueNumber: number;
      readonly detail: string;
    }
  | {
      readonly status: 'human';
      readonly issueNumber: number;
      readonly code: 'branch-mapping-ambiguous';
    }
  | {
      readonly status: 'lost' | 'ambiguous';
      readonly issueNumber: number;
    }
  | {
      readonly status: 'partial';
      readonly issueNumber: number;
      readonly code: 'pr-not-converged' | 'target-base-changed';
      readonly claimOid: GitOid;
    };

function positiveIssueNumber(issueNumber: number): number {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new Error('Implementation action requires a positive issue number');
  }
  return issueNumber;
}

function marketplaceProfile(
  deps: ImplementationExecutorDeps,
): NonNullable<ImplementationExecutorDeps['marketplace']> {
  const profile = deps.marketplace;
  if (
    profile === undefined
    || profile.repository !== MARKETPLACE_REPOSITORY
    || profile.language !== MARKETPLACE_LANGUAGE
    || profile.verificationProfile !== MARKETPLACE_VERIFICATION_PROFILE
  ) {
    throw new Error(
      `Marketplace Task submission supports only ${MARKETPLACE_REPOSITORY}, `
      + `${MARKETPLACE_LANGUAGE}, and verification profile `
      + MARKETPLACE_VERIFICATION_PROFILE,
    );
  }
  return profile;
}

function marketplacePreparation(input: {
  readonly workflow: MarketplaceMutationWorkflow;
  readonly issue: ImplementationIssue;
  readonly pullRequest: ImplementationPullRequest;
  readonly branch: GitRefName;
  readonly targetBase: GitRefName;
  readonly targetBaseOid: GitOid;
  readonly baseSha: GitOid;
  readonly claimOid: GitOid;
  readonly expectedHead: GitOid;
  readonly attemptId: string;
  readonly deps: ImplementationExecutorDeps;
}): MarketplaceAttemptPreparation {
  const profile = marketplaceProfile(input.deps);
  const built = buildMarketplaceTaskRequest({
    workflow: input.workflow,
    repository: profile.repository,
    language: profile.language,
    verificationProfile: profile.verificationProfile,
    issueNumber: input.issue.number,
    ...(input.workflow === 'implementation'
      ? {}
      : {
          childIssueNumber: input.issue.number,
          parentPrNumber: input.pullRequest.number,
        }),
    prNumber: input.pullRequest.number,
    targetBase: input.targetBase,
    branch: input.branch,
    claimOid: input.claimOid,
    expectedHead: input.expectedHead,
    v2AttemptId: input.attemptId,
    runnerId: input.deps.runnerId,
    taskSnapshot: {
      title: input.issue.title,
      body: input.issue.body,
      prBody: input.pullRequest.body,
      baseSha: input.baseSha,
      targetBaseOid: input.targetBaseOid,
    },
    receiptAuthors: input.deps.credentials.logins(),
    createdAt: input.deps.now().getTime(),
  });
  return {
    workflow: input.workflow,
    baseSha: input.baseSha,
    request: built.request,
    agentSoftDeadline: built.agentSoftDeadline,
    adoptionDeadline: built.adoptionDeadline,
  };
}

export function validateCanonicalGitHubHttpsRemote(remoteUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    throw new Error('Implementation publication requires the canonical HTTPS GitHub remote');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname !== 'github.com'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || !/^\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\.git$/.test(parsed.pathname)
  ) {
    throw new Error('Implementation publication requires a canonical HTTPS GitHub remote');
  }
  return parsed.href;
}

function bodyFor(issueNumber: number, branch: GitRefName): string {
  return [
    `Closes #${issueNumber}`,
    '',
    `<!-- jinn-autopilot:v2 issue=${issueNumber} branch=${branch} -->`,
  ].join('\n');
}

function humanBranchAmbiguity(
  issueNumber: number,
  pullRequests: readonly ImplementationPullRequest[],
  realityPrNumber?: number,
): HumanReason {
  if (realityPrNumber !== undefined && pullRequests.length === 0) {
    return {
      phase: 'eligible',
      code: 'branch-mapping-ambiguous',
      detail:
        `Canonical reality-check evidence names open PR #${realityPrNumber} for issue ` +
        `#${issueNumber}, but the bounded issue-to-PR mapping names no open PR.`,
    };
  }
  if (
    realityPrNumber !== undefined
    && pullRequests.length === 1
    && pullRequests[0]!.number !== realityPrNumber
  ) {
    return {
      phase: 'eligible',
      code: 'branch-mapping-ambiguous',
      detail:
        `Canonical reality-check evidence names open PR #${realityPrNumber} for issue ` +
        `#${issueNumber}, but the bounded issue-to-PR mapping names sole PR ` +
        `#${pullRequests[0]!.number} (${pullRequests[0]!.headRefName} → ` +
        `${pullRequests[0]!.baseRefName}).`,
    };
  }
  return {
    phase: 'eligible',
    code: 'branch-mapping-ambiguous',
    detail:
      `Issue #${issueNumber} has contradictory open implementation branches: ` +
      pullRequests.map((pullRequest) =>
        `PR #${pullRequest.number} (${pullRequest.headRefName} → ${pullRequest.baseRefName})`,
      ).join(', '),
  };
}

function prConverged(
  pullRequest: ImplementationPullRequest,
  input: DraftPullRequestInput,
): boolean {
  return pullRequest.headRefName === input.branch
    && pullRequest.head === input.claimOid
    && pullRequest.baseRefName === input.targetBase
    && pullRequest.draft
    && pullRequest.labels.includes(input.label)
    && pullRequest.body.includes(`Closes #${input.issueNumber}`)
    && pullRequest.body.includes(
      `<!-- jinn-autopilot:v2 issue=${input.issueNumber} branch=${input.branch} -->`,
    );
}

function realityPermitsImplementation(
  verdict: RealityCheckVerdict,
  openPullRequests: readonly ImplementationPullRequest[],
): boolean {
  if (verdict.classification === 'clear') return true;
  return verdict.classification === 'pr-open'
    && openPullRequests.length === 1
    && verdict.evidence.prNumber === openPullRequests[0]!.number;
}

function canonicalScenario(
  issue: ImplementationIssue,
  branch: GitRefName,
  prNumber: number,
  worktreePath: string,
): string {
  if (issue.child !== undefined) {
    const skill = issue.child.kind === 'reconcile'
      ? 'reconcile'
      : 'fix-child';
    const phase = issue.child.kind === 'reconcile' ? 'reconcile' : 'fix';
    return [
      `Use the ${skill} skill on child issue #${issue.number} for parent PR #${prNumber}.`,
      `Issue: #${issue.number} — ${issue.title}`,
      `The v2 lifecycle already claimed parent branch \`${branch}\` (phase ${phase}) and created the detached worktree at \`${worktreePath}\`.`,
      'Do not open a new PR. Work lands as append-only commits on the parent branch.',
      'Finish with `autopilot session child-complete` or park with `autopilot session human --reason-file <path>`.',
    ].join('\n');
  }
  return [
    `Use the implement-issue skill on issue #${issue.number}.`,
    `Issue: #${issue.number} — ${issue.title}`,
    `The v2 lifecycle already claimed \`${branch}\`, opened draft PR #${prNumber}, and created the detached worktree at \`${worktreePath}\`.`,
    'Use `autopilot session checkpoint` for meaningful durable checkpoints.',
    'Finish with `autopilot session implementation-complete --summary-file <path>` or park with `autopilot session human --reason-file <path>`.',
  ].join('\n');
}

export function makeCanonicalImplementationSpawner(
  config: DispatcherConfig,
  spawn: SpawnFn,
): (input: SpawnImplementationInput) => SpawnResult {
  return (input) => {
    const skill = input.issue.child?.kind === 'reconcile'
      ? 'reconcile'
      : input.issue.child?.kind === 'review-finding'
        || input.issue.child?.kind === 'ci-failure'
        ? 'fix-child'
        : 'implement-issue';
    return spawnCoordinatorSession(
      {
        kind: 'implement',
        number: input.issue.number,
        skill,
        scenario: canonicalScenario(
          input.issue,
          input.branch,
          input.prNumber,
          input.worktreePath,
        ),
        worktreePath: input.worktreePath,
        effort: input.issue.effort,
        env: input.environment,
        spawnOptions: {
          detached: true,
          stdio: ['ignore', 'inherit', 'inherit'],
          logPath: input.logPath,
        },
      },
      config,
      { spawn },
    );
  };
}

/**
 * Stale recovery deliberately bypasses `issue.eligible` (an issue in recovery
 * always has its own open PR, so its lifecycle item is `kind: 'pull-request'`
 * and `eligible` is structurally false). That bypass also skipped the canon
 * §5.1 review-follow-up gate, so a follow-up claimed before the projection
 * gate could see its parent would be resumed into the same escalation. Re-apply
 * just that conjunct here, from the same two authoritative facts.
 */
async function reviewFollowUpRecoveryRejection(
  issueNumber: number,
  body: string,
  readParentPullRequest: ImplementationExecutorDeps['readParentPullRequest'],
): Promise<string | null> {
  const marker = parseReviewFollowUpMarker(body);
  if (marker === null) {
    return hasReviewFollowUpMarkerTag(body)
      ? `Stale recovery issue #${issueNumber} carries an unparseable review follow-up marker.`
      : null;
  }
  // Fail closed, as the child-claim gate below does for the same missing dep:
  // the marker parsed, so a parent dependency is asserted, and without the
  // lookup it cannot be checked.
  if (readParentPullRequest === undefined) {
    return `Parent PR lookup is unavailable for review follow-up issue #${issueNumber}.`;
  }
  // The production port resolves only OPEN pull requests, so non-null is
  // exactly the positive OPEN evidence the projection gate fires on.
  const parent = await readParentPullRequest(marker.parentPr);
  return parent === null
    ? null
    : `Stale recovery issue #${issueNumber} is a review follow-up blocked by open parent PR #${marker.parentPr}.`;
}

function staleRecoveryRejection(
  action: Extract<ImplementationClaimAction, { intent: 'stale-recovery' }>,
  state: StaleImplementationRecoveryState,
): string | null {
  if (state.humanHold) {
    return `Stale recovery for issue #${action.issueNumber} is blocked by Human authority.`;
  }
  // Three separately identifiable causes. They were collapsed into one
  // "missing or closed" message, which misattributed the only cause the
  // production port can actually produce here — a withheld projection for an
  // issue that is present and open — as a missing or closed issue.
  if (state.issue === null) {
    return state.issueRefusal === undefined
      ? `Stale recovery issue #${action.issueNumber} has no authority projection.`
      : `Stale recovery issue #${action.issueNumber} has no authority projection: ${
        state.issueRefusal
      }`;
  }
  if (!state.issue.open) {
    return `Stale recovery issue #${action.issueNumber} is closed.`;
  }
  if (state.issue.number !== action.issueNumber) {
    return `Stale recovery issue #${action.issueNumber} changed to issue #${state.issue.number}.`;
  }
  if (state.projectStatus !== 'In Progress') {
    return `Stale recovery Project status changed from In Progress to ${
      state.projectStatus ?? 'missing'
    }.`;
  }
  const pullRequest = state.pullRequest;
  if (pullRequest === null) {
    return `Stale recovery PR #${action.prNumber} is missing.`;
  }
  if (pullRequest.number !== action.prNumber) {
    return `Stale recovery PR #${action.prNumber} changed to PR #${pullRequest.number}.`;
  }
  if (pullRequest.state !== 'OPEN') {
    return `Stale recovery PR #${action.prNumber} is not open.`;
  }
  if (!pullRequest.draft) {
    return `Stale recovery PR #${action.prNumber} is not a draft.`;
  }
  if (pullRequest.head !== action.expectedHead) {
    return `Stale recovery PR #${action.prNumber} head changed from ${action.expectedHead} to ${
      pullRequest.head
    }.`;
  }
  if (pullRequest.headRefName !== action.branch) {
    return `Stale recovery PR #${action.prNumber} branch changed from ${action.branch} to ${
      pullRequest.headRefName
    }.`;
  }
  if (pullRequest.baseRefName !== state.issue.targetBase) {
    return `Stale recovery PR #${action.prNumber} target base changed.`;
  }
  if (!state.openPullRequests.some((candidate) => candidate.number === action.prNumber)) {
    return `Stale recovery PR #${action.prNumber} is no longer the bounded open mapping.`;
  }
  const claim = state.claim;
  // The pinned claim records its historical base; the exact live head and
  // attempt bind it while the PR-to-issue check above binds the current base.
  if (
    claim === null
    || claim.phase !== 'implement'
    || claim.issueNumber !== action.issueNumber
    || (claim.prNumber !== undefined && claim.prNumber !== action.prNumber)
  ) {
    return `Stale recovery PR #${action.prNumber} no longer has a matching implementation claim.`;
  }
  if (claim.phaseComplete === true) {
    return `Stale recovery PR #${action.prNumber} claim is finished.`;
  }
  if (claim.attempt !== action.claimAttempt) {
    return `Stale recovery PR #${action.prNumber} claim attempt changed from ${
      action.claimAttempt
    } to ${claim.attempt}.`;
  }
  return null;
}

export async function executeImplementationAction(
  action: ImplementationClaimAction,
  deps: ImplementationExecutorDeps,
): Promise<ImplementationExecutionResult> {
  const input = action as Partial<ImplementationClaimAction>;
  if (
    input.kind !== 'claim-implementation'
    || (input.intent !== 'fresh' && input.intent !== 'stale-recovery')
  ) {
    throw new Error(
      'Implementation action requires an explicit fresh or stale-recovery intent',
    );
  }
  const executionBackend = deps.executionBackend ?? 'local';
  if (executionBackend === 'marketplace') marketplaceProfile(deps);
  const issueNumber = positiveIssueNumber(action.issueNumber);
  const isStaleRecovery = action.intent === 'stale-recovery';
  const recovery = isStaleRecovery
    ? await deps.readStaleRecovery(issueNumber, action.prNumber)
    : null;
  const issue = isStaleRecovery
    ? recovery!.issue
    : await deps.readIssue(issueNumber);
  if (isStaleRecovery && recovery !== null) {
    const rejection = staleRecoveryRejection(action, recovery)
      ?? await reviewFollowUpRecoveryRejection(
        issueNumber,
        recovery.issue?.body ?? '',
        deps.readParentPullRequest,
      );
    if (rejection !== null) {
      return { status: 'ineligible', issueNumber, detail: rejection };
    }
  }
  if (issue === null || issue.number !== issueNumber || !issue.open) {
    return {
      status: 'ineligible',
      issueNumber,
      detail: issue === null ? 'Issue is missing.' : 'Issue is not currently eligible.',
    };
  }

  if (issue.child !== undefined) {
    if (isStaleRecovery) {
      return {
        status: 'ineligible',
        issueNumber,
        detail: 'Stale implementation recovery no longer targets ordinary implementation work.',
      };
    }
    return executeChildImplementationAction(
      { ...issue, child: issue.child },
      deps,
    );
  }

  const reality = await deps.runRealityCheck(issueNumber);
  const openPullRequests = isStaleRecovery
    ? recovery!.openPullRequests
    : await deps.listOpenPullRequests(issueNumber);
  const realityPrNumber = reality.classification === 'pr-open'
    ? reality.evidence.prNumber
    : undefined;
  if (
    openPullRequests.length > 1
    || (
      openPullRequests.length === 1
      && openPullRequests[0]!.baseRefName !== issue.targetBase
    )
    || (
      realityPrNumber !== undefined
      && (
        openPullRequests.length !== 1
        || openPullRequests[0]!.number !== realityPrNumber
      )
    )
  ) {
    const reason = humanBranchAmbiguity(
      issueNumber,
      openPullRequests,
      realityPrNumber,
    );
    await deps.escalateHuman({ issueNumber, reason });
    return { status: 'human', issueNumber, code: 'branch-mapping-ambiguous' };
  }
  if (
    (!isStaleRecovery && !issue.eligible)
    || !realityPermitsImplementation(reality, openPullRequests)
  ) {
    return {
      status: 'ineligible',
      issueNumber,
      detail: !isStaleRecovery && !issue.eligible
        ? issue.eligibilityDetail ?? 'Issue is not currently eligible.'
        : `Canonical reality check classified the issue as ${reality.classification}.`,
    };
  }

  const selection = selectCredential(deps.credentials, { phase: 'implement' });
  if (selection.status !== 'selected') {
    return { status: 'ineligible', issueNumber, detail: selection.detail };
  }
  const remoteUrl = validateCanonicalGitHubHttpsRemote(deps.remoteUrl);
  const adopted = openPullRequests[0];
  const branch = adopted?.headRefName ?? gitRefName(`autopilot/${issueNumber}`);
  const targetBaseOid = executionBackend === 'marketplace'
    ? await deps.readTargetBaseHead(issue.targetBase, selection.credential)
    : undefined;
  const candidateParent = adopted?.head
    ?? targetBaseOid
    ?? await deps.readTargetBaseHead(issue.targetBase, selection.credential);
  const expectedRemoteHead = adopted?.head ?? null;
  const attemptId = deps.nextAttemptId();
  const claimedAt = deps.now().toISOString();
  const claim: BranchClaim = {
    kind: 'branch-claim',
    protocolVersion: 2,
    phase: 'implement',
    issueNumber,
    ...(adopted === undefined ? {} : { prNumber: adopted.number }),
    attempt: attemptId,
    runner: deps.runnerId,
    login: selection.login,
    expectedHead: gitOid(candidateParent),
    targetBase: issue.targetBase,
    claimedAt,
  };
  const claimOid = await deps.createClaimCommit({
    claim,
    parent: candidateParent,
    parentFetchRef: adopted?.headRefName ?? issue.targetBase,
    attempt: attemptId,
    credential: selection.credential,
  });
  const outcome = await deps.claimBranch({
    branch,
    candidateParent,
    expectedRemoteHead,
    claimOid,
    remoteUrl,
    login: selection.login,
    credential: selection.credential,
  });
  if (outcome.status === 'lost') return { status: 'lost', issueNumber };
  if (outcome.status === 'ambiguous') return { status: 'ambiguous', issueNumber };
  if (outcome.published !== claimOid || outcome.observed !== claimOid) {
    return { status: 'ambiguous', issueNumber };
  }

  const currentIssue = await deps.readIssue(issueNumber);
  if (
    currentIssue === null
    || currentIssue.number !== issueNumber
    || !currentIssue.open
    || currentIssue.targetBase !== issue.targetBase
  ) {
    return {
      status: 'partial',
      issueNumber,
      code: 'target-base-changed',
      claimOid,
    };
  }

  const draftInput: DraftPullRequestInput = {
    issueNumber,
    branch,
    claimOid,
    targetBase: issue.targetBase,
    title: issue.title,
    body: bodyFor(issueNumber, branch),
    draft: true,
    label: 'engine:review',
    credential: selection.credential,
  };
  const pullRequest = await deps.ensureDraftPullRequest(draftInput);
  if (!prConverged(pullRequest, draftInput)) {
    return {
      status: 'partial',
      issueNumber,
      code: 'pr-not-converged',
      claimOid,
    };
  }
  await deps.setProjectInProgress(issueNumber, claimOid, selection.credential);

  const preparation = executionBackend === 'marketplace'
    ? marketplacePreparation({
        workflow: 'implementation',
        issue,
        pullRequest,
        branch,
        targetBase: issue.targetBase,
        targetBaseOid: targetBaseOid!,
        baseSha: candidateParent,
        claimOid,
        expectedHead: claimOid,
        attemptId,
        deps,
      })
    : undefined;
  const attempt = await deps.createAttempt({
    attemptId,
    issueNumber,
    branch,
    targetBase: issue.targetBase,
    ...(targetBaseOid === undefined ? {} : { targetBaseOid }),
    expectedHead: claimOid,
    claimOid,
    prNumber: pullRequest.number,
    selectedLogin: selection.login,
    credential: selection.credential,
    ...(preparation === undefined
      ? {}
      : { marketplacePreparation: preparation }),
  });
  if (attempt.attemptId !== attemptId) {
    throw new Error('Detached implementation attempt does not match its claim');
  }
  const started = executionBackend === 'marketplace'
    ? await deps.startSession({
        kind: 'implementation',
        workflow: 'implementation',
        backend: 'marketplace',
        manifestPath: attempt.paths.manifest,
        attemptId,
        issueNumber,
        prNumber: pullRequest.number,
        branch,
        targetBase: issue.targetBase,
        worktreePath: attempt.paths.worktree,
        logPath: attempt.paths.log,
      })
    : await deps.startSession({
        kind: 'implementation',
        workflow: 'implementation',
        backend: 'local',
        manifestPath: attempt.paths.manifest,
        attemptId,
        issueNumber,
        prNumber: pullRequest.number,
        branch,
        targetBase: issue.targetBase,
        worktreePath: attempt.paths.worktree,
        logPath: attempt.paths.log,
        local: {
          spawnInput: {
            attemptId,
            issue,
            prNumber: pullRequest.number,
            branch,
            targetBase: issue.targetBase,
            environment: buildSanitizedChildEnv(
              deps.ambientEnvironment,
              selection.credential,
              {
                ghConfigDir: attempt.paths.ghConfigDir,
                askpassPath: attempt.paths.askpass,
                manifestPath: attempt.paths.manifest,
              },
            ),
            worktreePath: attempt.paths.worktree,
            logPath: attempt.paths.log,
          },
        },
      });
  if (started.status !== 'started') {
    throw new Error('Implementation session execution did not start');
  }
  return {
    status: 'spawned',
    issueNumber,
    prNumber: pullRequest.number,
    branch,
    claimOid,
    attemptId,
  };
}

async function executeChildImplementationAction(
  issue: ImplementationIssue & {
    readonly child: { readonly parentPr: number; readonly kind: 'review-finding' | 'reconcile' | 'ci-failure' };
  },
  deps: ImplementationExecutorDeps,
): Promise<ImplementationExecutionResult> {
  const issueNumber = issue.number;
  const executionBackend = deps.executionBackend ?? 'local';
  if (!issue.eligible) {
    return {
      status: 'ineligible',
      issueNumber,
      detail: 'Issue is not currently eligible.',
    };
  }
  if (deps.readParentPullRequest === undefined) {
    return {
      status: 'ineligible',
      issueNumber,
      detail: 'Parent PR lookup is unavailable for child claims.',
    };
  }
  const parent = await deps.readParentPullRequest(issue.child.parentPr);
  if (parent === null || parent.baseRefName !== issue.targetBase) {
    return {
      status: 'ineligible',
      issueNumber,
      detail: 'Parent pull request is missing or retargeted.',
    };
  }

  const selection = selectCredential(deps.credentials, { phase: 'implement' });
  if (selection.status !== 'selected') {
    return { status: 'ineligible', issueNumber, detail: selection.detail };
  }
  const remoteUrl = validateCanonicalGitHubHttpsRemote(deps.remoteUrl);
  const branch = parent.headRefName;
  const candidateParent = parent.head;
  const targetBaseOid = executionBackend === 'marketplace'
    ? await deps.readTargetBaseHead(issue.targetBase, selection.credential)
    : undefined;
  const attemptId = deps.nextAttemptId();
  const claimedAt = deps.now().toISOString();
  const phase = issue.child.kind === 'reconcile' ? 'reconcile' as const : 'fix' as const;
  const claim: BranchClaim = {
    kind: 'branch-claim',
    protocolVersion: 2,
    phase,
    issueNumber,
    prNumber: parent.number,
    attempt: attemptId,
    runner: deps.runnerId,
    login: selection.login,
    expectedHead: gitOid(candidateParent),
    targetBase: issue.targetBase,
    claimedAt,
  };
  const claimOid = await deps.createClaimCommit({
    claim,
    parent: candidateParent,
    parentFetchRef: gitRefName(`pull/${parent.number}/head`),
    attempt: attemptId,
    credential: selection.credential,
  });
  const outcome = await deps.claimBranch({
    branch,
    candidateParent,
    expectedRemoteHead: parent.head,
    claimOid,
    remoteUrl,
    login: selection.login,
    credential: selection.credential,
  });
  if (outcome.status === 'lost') return { status: 'lost', issueNumber };
  if (outcome.status === 'ambiguous') return { status: 'ambiguous', issueNumber };
  if (outcome.published !== claimOid || outcome.observed !== claimOid) {
    return { status: 'ambiguous', issueNumber };
  }

  const preparation = executionBackend === 'marketplace'
    ? marketplacePreparation({
        workflow: issue.child.kind,
        issue,
        pullRequest: parent,
        branch,
        targetBase: issue.targetBase,
        targetBaseOid: targetBaseOid!,
        baseSha: candidateParent,
        claimOid,
        expectedHead: claimOid,
        attemptId,
        deps,
      })
    : undefined;
  const attempt = await deps.createAttempt({
    attemptId,
    issueNumber,
    branch,
    targetBase: issue.targetBase,
    ...(targetBaseOid === undefined ? {} : { targetBaseOid }),
    expectedHead: claimOid,
    claimOid,
    prNumber: parent.number,
    selectedLogin: selection.login,
    credential: selection.credential,
    ...(preparation === undefined
      ? {}
      : { marketplacePreparation: preparation }),
  });
  if (attempt.attemptId !== attemptId) {
    throw new Error('Detached child attempt does not match its claim');
  }
  const started = executionBackend === 'marketplace'
    ? await deps.startSession({
        kind: 'implementation',
        workflow: issue.child.kind,
        backend: 'marketplace',
        manifestPath: attempt.paths.manifest,
        attemptId,
        issueNumber,
        prNumber: parent.number,
        branch,
        targetBase: issue.targetBase,
        worktreePath: attempt.paths.worktree,
        logPath: attempt.paths.log,
      })
    : await deps.startSession({
        kind: 'implementation',
        workflow: issue.child.kind,
        backend: 'local',
        manifestPath: attempt.paths.manifest,
        attemptId,
        issueNumber,
        prNumber: parent.number,
        branch,
        targetBase: issue.targetBase,
        worktreePath: attempt.paths.worktree,
        logPath: attempt.paths.log,
        local: {
          spawnInput: {
            attemptId,
            issue,
            prNumber: parent.number,
            branch,
            targetBase: issue.targetBase,
            environment: buildSanitizedChildEnv(
              deps.ambientEnvironment,
              selection.credential,
              {
                ghConfigDir: attempt.paths.ghConfigDir,
                askpassPath: attempt.paths.askpass,
                manifestPath: attempt.paths.manifest,
              },
            ),
            worktreePath: attempt.paths.worktree,
            logPath: attempt.paths.log,
          },
        },
      });
  if (started.status !== 'started') {
    throw new Error('Child session execution did not start');
  }
  return {
    status: 'spawned',
    issueNumber,
    prNumber: parent.number,
    branch,
    claimOid,
    attemptId,
  };
}
