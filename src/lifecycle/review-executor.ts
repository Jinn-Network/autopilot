import type {
  AttemptPaths,
  ReviewApprovalPolicy,
} from './attempt-workspace.js';
import type {
  CredentialPool,
  SelectedCredential,
} from './credentials.js';
import {
  buildSanitizedChildEnv,
  selectCredential,
} from './credentials.js';
import type { NativeReviewState } from './snapshot.js';
import type {
  GitOid,
  GitRefName,
  HumanReason,
  PublicationOutcome,
  ReviewClaimRecord,
} from './types.js';
import type {
  LocalExactHeadReviewSessionExecutionRequest,
  SessionExecutionResult,
} from './session-execution-backend.js';
import type { OpenReviewFollowUp } from './review-follow-ups.js';
import { MAX_REVIEW_FOLLOW_UP_CONTEXT } from './review-follow-ups.js';

export interface ReviewNativeReview {
  readonly reviewer: string;
  readonly state: NativeReviewState;
  readonly commitId: GitOid;
  readonly body: string;
  readonly submittedAt: string;
}

export interface ReviewActionCandidate {
  readonly issueNumber: number;
  readonly number: number;
  readonly open: boolean;
  readonly head: GitOid;
  readonly headChangedAt: string;
  readonly headRefName: GitRefName;
  readonly baseRefName: GitRefName;
  readonly draft: boolean;
  readonly author: string;
  readonly labels: readonly string[];
  readonly body: string;
  readonly humanHold: boolean;
  readonly approvalPolicy: ReviewApprovalPolicy;
  readonly nativeReviews: readonly ReviewNativeReview[];
  readonly terminalApprovalMatches?: boolean;
  readonly mappingProblem?: string;
  readonly reviewRef?: {
    readonly oid: GitOid;
    readonly record: ReviewClaimRecord;
  };
}

export interface ReviewAttemptBinding {
  readonly attemptId: string;
  readonly paths: Pick<
  AttemptPaths,
  'worktree' | 'manifest' | 'log' | 'ghConfigDir' | 'askpass'
  >;
}

export interface SpawnExactHeadReviewInput {
  readonly attemptId: string;
  readonly candidate: ReviewActionCandidate;
  readonly environment: NodeJS.ProcessEnv;
  readonly worktreePath: string;
  readonly logPath: string;
  /**
   * Mirrors `ExactHeadReviewSessionExecutionRequest.openFollowUps` (#124). The
   * local backend hands the spawner only `local.spawnInput` and the prompt is
   * composed there, so the context has to ride on both.
   */
  readonly openFollowUps?: readonly OpenReviewFollowUp[];
  readonly openFollowUpTotal?: number;
}

export interface ReviewExecutorDeps {
  readCandidate(prNumber: number): Promise<ReviewActionCandidate | null>;
  confirmAcquisition(input: {
    readonly prNumber: number;
    readonly expectedHead: GitOid;
    readonly expectedReviewRefOid: GitOid;
  }): Promise<ReviewActionCandidate | null>;
  readonly credentials: CredentialPool;
  createReviewRecord(input: {
    readonly record: ReviewClaimRecord;
    readonly parent: GitOid | null;
    readonly credential: SelectedCredential;
  }): Promise<GitOid>;
  publishReviewClaim(input: {
    readonly prNumber: number;
    readonly recordParent: GitOid | null;
    readonly expectedRemoteRecordOid: GitOid | null;
    readonly recordOid: GitOid;
    readonly credential: SelectedCredential;
  }): Promise<PublicationOutcome>;
  createAttempt(input: {
    readonly attemptId: string;
    readonly issueNumber: number;
    readonly prNumber: number;
    readonly branch: GitRefName;
    readonly targetBase: GitRefName;
    readonly expectedHead: GitOid;
    readonly claimOid: GitOid;
    readonly reviewGeneration: string;
    readonly reviewRefOid: GitOid;
    readonly approvalPolicy: ReviewApprovalPolicy;
    readonly selectedLogin: string;
    readonly credential: SelectedCredential;
  }): Promise<ReviewAttemptBinding>;
  repairProjection(input: {
    readonly candidate: ReviewActionCandidate;
    readonly expectedReviewRefOid: GitOid;
    readonly credential: SelectedCredential;
  }): Promise<void>;
  /**
   * Non-blocking follow-ups already open against the parent PR (#124).
   *
   * The mechanical dedup in `review-follow-ups.ts` matches normalized titles,
   * which catches a restatement but not a rewrite: mono #3292 "Publish
   * @colophon-claims/check, then republish the verify alias" and #3621
   * "Publish the renamed Colophon reader and its retired-name alias" are one
   * task with no shared words. Only the reviewer can see that, and only if it
   * is shown what is already filed.
   *
   * Optional because a build without it must stay distinguishable from a
   * parent with nothing open — see the request field's note.
   */
  readOpenFollowUps?(parentPr: number): Promise<readonly OpenReviewFollowUp[]>;
  startSession(
    request: LocalExactHeadReviewSessionExecutionRequest<SpawnExactHeadReviewInput>,
  ): Promise<SessionExecutionResult>;
  escalateHuman(input: {
    readonly candidate: ReviewActionCandidate;
    readonly reason: HumanReason;
  }): Promise<void>;
  readonly ambientEnvironment: NodeJS.ProcessEnv;
  nextAttemptId(): string;
  nextGeneration(): string;
  readonly runnerId: string;
  now(): Date;
  readonly staleAfterMs: number;
  /**
   * Injectable delay, used only to pace {@link confirmReviewAcquisition}'s
   * bounded retry against GitHub GraphQL replication lag. Production wires a
   * real `setTimeout`-based sleep; tests fake it so retries resolve
   * instantly and can assert on the delay values requested.
   */
  sleep(ms: number): Promise<void>;
}

export interface AcquiredExactHeadReviewClaim {
  readonly prNumber: number;
  readonly head: GitOid;
  readonly reviewRefOid: GitOid;
  readonly attemptId: string;
  readonly generation: string;
  readonly reviewer: string;
  readonly approvalPolicy: ReviewApprovalPolicy;
  readonly manifestPath: string;
  readonly paths: Pick<
    AttemptPaths,
    'worktree' | 'manifest' | 'log' | 'ghConfigDir' | 'askpass'
  >;
}

export type ReviewClaimAcquisitionDeps = Omit<
  ReviewExecutorDeps,
  'startSession'
>;

export type ReviewClaimAcquisitionResult =
  | {
      readonly status: 'acquired';
      readonly claim: AcquiredExactHeadReviewClaim;
      readonly confirmed: ReviewActionCandidate;
      readonly credential: SelectedCredential;
    }
  | {
      readonly status: 'already-approved';
      readonly detail: string;
      readonly prNumber: number;
      readonly head: GitOid;
    }
  | {
      readonly status: 'ineligible' | 'human' | 'lost' | 'ambiguous';
      readonly detail: string;
    };

export type ReviewExecutionResult =
  | {
      readonly status: 'spawned';
      readonly prNumber: number;
      readonly head: GitOid;
      readonly reviewRefOid: GitOid;
      readonly attemptId: string;
      readonly generation: string;
      readonly reviewer: string;
      readonly approvalPolicy: ReviewApprovalPolicy;
    }
  | { readonly status: 'already-approved'; readonly prNumber: number; readonly head: GitOid }
  | { readonly status: 'ineligible'; readonly prNumber: number; readonly detail: string }
  | { readonly status: 'human'; readonly prNumber: number; readonly code: 'reviewer-identity-unavailable' | 'review-escalation' }
  | { readonly status: 'lost' | 'ambiguous'; readonly prNumber: number };

/**
 * Bounded retry count for {@link confirmReviewAcquisition}'s post-win
 * confirmation read. jinn-mono#1925 lived this: a review-claim push won its
 * exact-lease race (confirmed by git-protocol's own ls-remote readback and
 * by `repairProjection`'s direct ref check) but the very next GraphQL
 * snapshot read still reported the *pre-push* ref state, because GitHub's
 * GraphQL API can lag a just-pushed ref's replication by up to a few
 * seconds. The old single-shot confirm treated that lag as a loss and
 * orphaned our own winning claim. Three attempts with a short delay between
 * them gives replication time to catch up without weakening the fencing
 * invariant below.
 */
const REVIEW_ACQUISITION_MAX_ATTEMPTS = 3;

/** Delay between {@link confirmReviewAcquisition} retry attempts. */
const REVIEW_ACQUISITION_RETRY_DELAY_MS = 1000;

type ReviewAcquisitionOutcome =
  | { readonly outcome: 'confirmed'; readonly confirmed: ReviewActionCandidate }
  | {
      readonly outcome: 'human';
      readonly candidate: ReviewActionCandidate;
      readonly reason: HumanReason;
    }
  | { readonly outcome: 'lost' }
  | { readonly outcome: 'ambiguous' };

/**
 * Confirms a just-published review-claim record is the ref's exact current
 * state, tolerating GraphQL replication lag without weakening fencing.
 *
 * The invariant that must never move: a session spawns only once our exact
 * record OID has been observed as current. This function re-reads the full
 * candidate (preserving every existing revalidation: open/head/issue/branch
 * mapping/approval-policy/Human-hold) on every attempt via the same
 * `confirmAcquisition` port method the caller used before this fix -- only
 * the review-claim-ref-specific check at the end gets bounded-retry
 * treatment, because that is the only field this function reads back that
 * *we* just wrote in this operation (everything else -- head, labels,
 * project status -- was already read-back-confirmed by `repairProjection`
 * before this runs, or predates this operation entirely).
 *
 * On each attempt, the observed review-ref OID is one of three things:
 *   - our own `recordOid` -> confirmed, proceed.
 *   - the exact pre-push state (`recordParent`, or absent when the parent
 *     was null) -> replication lag; retry.
 *   - anything else -> a foreign write actually won the ref; fail closed
 *     immediately with no further retries.
 */
async function confirmReviewAcquisition(
  deps: ReviewClaimAcquisitionDeps,
  input: {
    readonly candidate: ReviewActionCandidate;
    readonly recordOid: GitOid;
    readonly recordParent: GitOid | null;
    readonly generation: string;
    readonly attemptId: string;
    readonly reviewerLogin: string;
  },
): Promise<ReviewAcquisitionOutcome> {
  const phase: HumanReason['phase'] = 'reviewing';
  for (let attempt = 1; attempt <= REVIEW_ACQUISITION_MAX_ATTEMPTS; attempt += 1) {
    const confirmed = await deps.confirmAcquisition({
      prNumber: input.candidate.number,
      expectedHead: input.candidate.head,
      expectedReviewRefOid: input.recordOid,
    });
    if (confirmed?.humanHold) {
      return {
        outcome: 'human',
        candidate: confirmed,
        reason: {
          phase,
          code: 'review-escalation',
          detail: 'A Human hold arrived during review acquisition.',
        },
      };
    }
    if (
      confirmed === null
      || !confirmed.open
      || confirmed.number !== input.candidate.number
      || confirmed.head !== input.candidate.head
      || confirmed.issueNumber !== input.candidate.issueNumber
      || confirmed.headRefName !== input.candidate.headRefName
      || confirmed.baseRefName !== input.candidate.baseRefName
      || confirmed.mappingProblem !== undefined
      || confirmed.approvalPolicy !== input.candidate.approvalPolicy
    ) {
      if (
        confirmed !== null
        && (
          confirmed.mappingProblem !== undefined
          || confirmed.approvalPolicy !== input.candidate.approvalPolicy
        )
      ) {
        return {
          outcome: 'human',
          candidate: confirmed,
          reason: {
            phase,
            code: confirmed.mappingProblem === undefined
              ? 'review-escalation'
              : 'branch-mapping-ambiguous',
            detail: confirmed.mappingProblem
              ?? 'The current-head CODEOWNER approval policy changed during acquisition.',
          },
        };
      }
      return { outcome: 'lost' };
    }
    const confirmedClaim = confirmed.reviewRef;
    if (
      confirmedClaim?.oid === input.recordOid
      && confirmedClaim.record.prNumber === input.candidate.number
      && confirmedClaim.record.generation === input.generation
      && confirmedClaim.record.attempt === input.attemptId
      && confirmedClaim.record.reviewer.toLowerCase() === input.reviewerLogin.toLowerCase()
      && confirmedClaim.record.head === input.candidate.head
      && confirmedClaim.record.state === 'active'
    ) {
      return { outcome: 'confirmed', confirmed };
    }
    const observedOid = confirmedClaim?.oid ?? null;
    if (observedOid !== input.recordParent) {
      // Neither our record nor the pre-push state -- a foreign write
      // genuinely won. Fail closed immediately; no more retries.
      return { outcome: 'lost' };
    }
    if (attempt === REVIEW_ACQUISITION_MAX_ATTEMPTS) return { outcome: 'ambiguous' };
    await deps.sleep(REVIEW_ACQUISITION_RETRY_DELAY_MS);
  }
  /* istanbul ignore next -- unreachable: the loop always returns */
  return { outcome: 'ambiguous' };
}

export async function acquireExactHeadReviewClaim(
  action: {
    readonly prNumber: number;
    readonly expectedHead?: GitOid;
  },
  deps: ReviewClaimAcquisitionDeps,
): Promise<ReviewClaimAcquisitionResult> {
  if (!Number.isSafeInteger(action.prNumber) || action.prNumber <= 0) {
    throw new Error('Review action requires a positive PR number');
  }
  const candidate = await deps.readCandidate(action.prNumber);
  if (
    candidate === null
    || candidate.number !== action.prNumber
    || !candidate.open
  ) {
    return {
      status: 'ineligible',
      detail: candidate === null ? 'Pull request is missing.' : 'Pull request is not open.',
    };
  }
  if (action.expectedHead !== undefined && candidate.head !== action.expectedHead) {
    return {
      status: 'ineligible',
      detail: 'Pull request head changed after scheduling.',
    };
  }
  if (candidate.mappingProblem !== undefined) {
    const reason: HumanReason = {
      phase: 'awaiting-review',
      code: 'branch-mapping-ambiguous',
      detail: candidate.mappingProblem,
    };
    await deps.escalateHuman({ candidate, reason });
    return {
      status: 'human',
      detail: candidate.mappingProblem,
    };
  }
  if (candidate.humanHold) {
    const reason: HumanReason = {
      phase: 'reviewing',
      code: 'review-escalation',
      detail: 'Human authority is active; repair its durable projection before stopping.',
    };
    await deps.escalateHuman({ candidate, reason });
    return {
      status: 'human',
      detail: 'Human authority is active; repair its durable projection before stopping.',
    };
  }
  const current = candidate.reviewRef;
  if (
    current?.record.state === 'terminal-approved'
    && current.record.head === candidate.head
    && candidate.terminalApprovalMatches === true
  ) {
    return {
      status: 'already-approved',
      detail: 'Pull request already has a matching terminal approval.',
      prNumber: candidate.number,
      head: candidate.head,
    };
  }

  const currentHeadClaim = current?.record.head === candidate.head
    ? current.record
    : undefined;
  const headChangedAt = Date.parse(candidate.headChangedAt);
  const nowMs = deps.now().getTime();
  if (!Number.isFinite(headChangedAt) || headChangedAt > nowMs) {
    return {
      status: 'ineligible',
      detail: 'Review progress timestamp is invalid.',
    };
  }
  // Winning a review claim generation initializes its own progress clock (the
  // one permitted progress event for review, mirroring the branch claim commit
  // for implement) — see staleEvidence in lifecycle.ts, the canonical
  // definition this mirrors. Later metadata-only transitions (verdict-intent,
  // ...) do not get their own fresh window.
  let progressTime = headChangedAt;
  if (currentHeadClaim?.state === 'active') {
    const acquisitionTime = Date.parse(currentHeadClaim.recordedAt);
    if (!Number.isFinite(acquisitionTime) || acquisitionTime > nowMs) {
      return {
        status: 'ineligible',
        detail: 'Review claim acquisition timestamp is invalid.',
      };
    }
    if (acquisitionTime > progressTime) progressTime = acquisitionTime;
  }
  const stale = nowMs - progressTime >= deps.staleAfterMs;
  if (
    currentHeadClaim !== undefined
    && currentHeadClaim.state !== 'stale'
    && currentHeadClaim.state !== 'terminal-approved'
    && currentHeadClaim.state !== 'human'
    && currentHeadClaim.state !== 'human-intent'
    && !stale
  ) {
    return {
      status: 'ineligible',
      detail: 'The exact PR head already has an active review generation.',
    };
  }
  if (candidate.draft) {
    return {
      status: 'ineligible',
      detail: 'Draft pull requests are not claimable for review.',
    };
  }

  const selection = selectCredential(deps.credentials, {
    phase: 'review',
    prAuthor: candidate.author,
  });
  if (selection.status !== 'selected') {
    return {
      status: 'ineligible',
      detail: selection.detail,
    };
  }

  const attemptId = deps.nextAttemptId();
  const generation = deps.nextGeneration();
  const record: ReviewClaimRecord = {
    kind: 'review-claim',
    protocolVersion: 2,
    prNumber: candidate.number,
    generation,
    attempt: attemptId,
    reviewer: selection.login,
    head: candidate.head,
    state: 'active',
    recordedAt: deps.now().toISOString(),
  };
  const parent = current?.oid ?? null;
  const recordOid = await deps.createReviewRecord({
    record,
    parent,
    credential: selection.credential,
  });
  const outcome = await deps.publishReviewClaim({
    prNumber: candidate.number,
    recordParent: parent,
    expectedRemoteRecordOid: parent,
    recordOid,
    credential: selection.credential,
  });
  if (outcome.status === 'lost') {
    return { status: 'lost', detail: 'Review claim publication lost exact ref authority.' };
  }
  if (
    outcome.status === 'ambiguous'
    || !('observed' in outcome)
    || outcome.published !== recordOid
    || outcome.observed !== recordOid
  ) {
    return { status: 'ambiguous', detail: 'Review claim publication is ambiguous.' };
  }

  const attempt = await deps.createAttempt({
    attemptId,
    issueNumber: candidate.issueNumber,
    prNumber: candidate.number,
    branch: candidate.headRefName,
    targetBase: candidate.baseRefName,
    expectedHead: candidate.head,
    claimOid: recordOid,
    reviewGeneration: generation,
    reviewRefOid: recordOid,
    approvalPolicy: candidate.approvalPolicy,
    selectedLogin: selection.login,
    credential: selection.credential,
  });
  if (attempt.attemptId !== attemptId) {
    throw new Error('Detached review attempt does not match its claim');
  }
  await deps.repairProjection({
    candidate,
    expectedReviewRefOid: recordOid,
    credential: selection.credential,
  });
  const acquisition = await confirmReviewAcquisition(deps, {
    candidate,
    recordOid,
    recordParent: parent,
    generation,
    attemptId,
    reviewerLogin: selection.login,
  });
  if (acquisition.outcome === 'human') {
    await deps.escalateHuman({ candidate: acquisition.candidate, reason: acquisition.reason });
    return {
      status: 'human',
      detail: acquisition.reason.detail,
    };
  }
  if (acquisition.outcome === 'lost') {
    return { status: 'lost', detail: 'Review claim confirmation lost exact ref authority.' };
  }
  if (acquisition.outcome === 'ambiguous') {
    return { status: 'ambiguous', detail: 'Review claim confirmation is ambiguous.' };
  }
  const confirmed = acquisition.confirmed;
  return {
    status: 'acquired',
    claim: {
      prNumber: candidate.number,
      head: candidate.head,
      reviewRefOid: recordOid,
      attemptId,
      generation,
      reviewer: selection.login,
      approvalPolicy: candidate.approvalPolicy,
      manifestPath: attempt.paths.manifest,
      paths: attempt.paths,
    },
    confirmed,
    credential: selection.credential,
  };
}

export async function executeReviewAction(
  action: {
    readonly prNumber: number;
    readonly expectedHead?: GitOid;
  },
  deps: ReviewExecutorDeps,
): Promise<ReviewExecutionResult> {
  const acquired = await acquireExactHeadReviewClaim(action, deps);
  if (acquired.status === 'already-approved') {
    return {
      status: 'already-approved',
      prNumber: acquired.prNumber,
      head: acquired.head,
    };
  }
  if (acquired.status !== 'acquired') {
    const prNumber = action.prNumber;
    switch (acquired.status) {
      case 'ineligible':
        return { status: 'ineligible', prNumber, detail: acquired.detail };
      case 'human':
        return { status: 'human', prNumber, code: 'review-escalation' };
      case 'lost':
        return { status: 'lost', prNumber };
      case 'ambiguous':
        return { status: 'ambiguous', prNumber };
    }
  }
  const { claim, confirmed, credential } = acquired;
  const manifestPaths = claim.paths;
  const environment = buildSanitizedChildEnv(
    deps.ambientEnvironment,
    credential,
    {
      ghConfigDir: manifestPaths.ghConfigDir,
      askpassPath: manifestPaths.askpass,
      manifestPath: manifestPaths.manifest,
    },
  );
  // Read after the claim is confirmed and before the session starts: the point
  // is to tell *this* reviewer what is already filed, and the answer is only
  // meaningful once we know we are the ones reviewing.
  const followUpContext = deps.readOpenFollowUps === undefined
    ? {}
    : await (async () => {
      const open = await deps.readOpenFollowUps!(claim.prNumber);
      return {
        openFollowUps: open.slice(0, MAX_REVIEW_FOLLOW_UP_CONTEXT)
          .map((followUp) => ({
            number: followUp.number,
            title: followUp.title,
          })),
        openFollowUpTotal: open.length,
      };
    })();
  const started = await deps.startSession({
    kind: 'exact-head-review',
    backend: 'local',
    manifestPath: manifestPaths.manifest,
    attemptId: claim.attemptId,
    issueNumber: confirmed.issueNumber,
    prNumber: claim.prNumber,
    branch: confirmed.headRefName,
    targetBase: confirmed.baseRefName,
    worktreePath: manifestPaths.worktree,
    logPath: manifestPaths.log,
    reviewedHead: claim.head,
    reviewerLogin: claim.reviewer,
    ...followUpContext,
    local: {
      spawnInput: {
        attemptId: claim.attemptId,
        candidate: confirmed,
        environment,
        worktreePath: manifestPaths.worktree,
        logPath: manifestPaths.log,
        ...followUpContext,
      },
    },
  });
  if (started.status !== 'started') {
    throw new Error('Review session execution did not start');
  }
  return {
    status: 'spawned',
    prNumber: claim.prNumber,
    head: claim.head,
    reviewRefOid: claim.reviewRefOid,
    attemptId: claim.attemptId,
    generation: claim.generation,
    reviewer: claim.reviewer,
    approvalPolicy: claim.approvalPolicy,
  };
}
