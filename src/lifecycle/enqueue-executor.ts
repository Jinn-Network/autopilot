import {
  selectCredential,
  type CredentialPool,
  type SelectedCredential,
} from './credentials.js';
import type {
  CompareStatus,
  GitOid,
  GitRefName,
} from './types.js';
import {
  classifyCiChecks,
  isCiGreen,
} from './ci-classifier.js';

export interface EnqueueEffectiveReview {
  readonly reviewer: string;
  readonly state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  readonly commitId: GitOid;
}

export interface EnqueueCandidate {
  readonly issueNumber: number;
  readonly prNumber: number;
  readonly open: boolean;
  readonly merged: boolean;
  readonly head: GitOid;
  readonly baseRefName: GitRefName;
  readonly expectedBaseRefName: GitRefName;
  readonly draft: boolean;
  readonly labels: readonly string[];
  readonly humanHold: boolean;
  readonly author: string;
  readonly authorAllowed: boolean;
  readonly uniqueIssueMapping: boolean;
  readonly terminalApprovalMatches: boolean;
  readonly terminalApprovalReviewer?: string;
  readonly effectiveReviews: readonly EnqueueEffectiveReview[];
  readonly checks: readonly {
    readonly name: string;
    readonly status: string;
    readonly conclusion: string | null;
  }[];
  readonly mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  readonly mergeStateStatus: string;
  readonly compareStatus: CompareStatus;
  readonly changedFilesComplete: boolean;
  readonly codeownersComplete: boolean;
  readonly codeownerSensitive: boolean;
  /**
   * Logins the repository's CODEOWNERS policy names; compared case-insensitively.
   * An empty set proves nobody is an owner, so a sensitive change refuses —
   * the same answer the unconditional `codeowner-sensitive` refusal gave, kept
   * as the fail-safe default rather than an accident of configuration.
   */
  readonly codeOwnerLogins: ReadonlySet<string>;
  /**
   * The PR's GraphQL node id, the `pullRequestId` argument of
   * `enqueuePullRequest`. Absent means the mutation cannot be addressed at all.
   */
  readonly graphqlId?: string;
  /** The PR already sits in the merge queue; a second enqueue is a no-op. */
  readonly inMergeQueue: boolean;
}

export interface EnqueueGateResult {
  readonly pass: boolean;
  readonly reasons: readonly string[];
}

/**
 * An effective APPROVED review at the candidate's head from a login the
 * repository's CODEOWNERS policy names. Head-bound on purpose: an approval
 * recorded against an older commit says nothing about the diff being enqueued.
 */
function codeOwnerApprovedAtHead(candidate: EnqueueCandidate): boolean {
  // GitHub logins are case-insensitive, so both sides are folded here rather
  // than trusting the casing a CODEOWNERS file or a config file happened to
  // use. A casing mismatch would refuse a change an owner really did approve.
  const owners = new Set(
    [...candidate.codeOwnerLogins].map((login) => login.toLowerCase()),
  );
  return candidate.effectiveReviews.some((review) => (
    review.commitId === candidate.head
    && review.state === 'APPROVED'
    && owners.has(review.reviewer.toLowerCase())
  ));
}

/**
 * What the engine still owns once merging belongs to GitHub's merge queue.
 *
 * The queue builds its own merge candidate on top of the current base and runs
 * the required checks against it, so three of the old merge gate's refusals
 * became refusals of the queue's ordinary input and are gone:
 *
 *   - `behind` / `compare-unknown`. The old gate merged *this exact commit*, so
 *     an out-of-date head was a real hazard. The queue rebases onto the base it
 *     merges into, which is precisely what BEHIND means, so a behind or
 *     diverged head is queue-normal.
 *   - the `mergeStateStatus ∈ {CLEAN, UNSTABLE, HAS_HOOKS}` requirement. BEHIND
 *     and BLOCKED are the states a queue-managed PR sits in by construction.
 *     Only `DIRTY` (and a `CONFLICTING` mergeable) is a real refusal, and it
 *     now says so by name.
 *   - `self-review`. The account that authors a change and the account that
 *     enqueues it are the same in the engine's ordinary flow, and
 *     `terminalApprovalMatches` above already proves an engine reviewer signed
 *     this exact head.
 *
 * Everything that is *not* the queue's job stays exactly as strict as it was.
 */
export function evaluateEnqueueGate(candidate: EnqueueCandidate): EnqueueGateResult {
  const reasons: string[] = [];
  if (!candidate.open || candidate.merged) reasons.push('pull-request-not-open');
  if (candidate.draft) reasons.push('draft');
  if (candidate.humanHold) reasons.push('human');
  if (!candidate.labels.includes('engine:review')) reasons.push('review-label');
  if (!candidate.authorAllowed) reasons.push('author');
  if (!candidate.uniqueIssueMapping) reasons.push('mapping');
  if (candidate.baseRefName !== candidate.expectedBaseRefName) reasons.push('base');
  if (!candidate.terminalApprovalMatches) reasons.push('terminal-approval');
  if (candidate.effectiveReviews.some((review) => (
    review.commitId === candidate.head && review.state === 'CHANGES_REQUESTED'
  ))) {
    reasons.push('changes-requested');
  }
  if (!isCiGreen(candidate.checks)) {
    const classification = classifyCiChecks(candidate.checks);
    if (classification.state === 'missing') reasons.push('checks-missing');
    else reasons.push('checks-not-green');
  }
  if (candidate.mergeable === 'CONFLICTING' || candidate.mergeStateStatus === 'DIRTY') {
    reasons.push('conflicting');
  } else if (candidate.mergeable === 'UNKNOWN') {
    // GitHub has not finished computing mergeability. Undetermined, not a
    // refusal — the next cycle reads it again.
    reasons.push('mergeability-unknown');
  }
  if (candidate.graphqlId === undefined || candidate.graphqlId.length === 0) {
    reasons.push('pull-request-node-id-missing');
  }
  if (!candidate.changedFilesComplete) reasons.push('changed-files-incomplete');
  if (!candidate.codeownersComplete) reasons.push('codeowners-incomplete');
  if (candidate.codeownerSensitive && !codeOwnerApprovedAtHead(candidate)) {
    reasons.push('codeowner-approval-missing');
  }
  return { pass: reasons.length === 0, reasons };
}

/**
 * What one `enqueuePullRequest` attempt at an exact head resolved to.
 *
 * `enqueued` and `already-enqueued` are both success — the PR is in the queue
 * at the expected head, and which call put it there does not matter.
 * `already-merged` means GitHub merged it out from under us, also success.
 * `rejected` is a durable refusal (not mergeable, queue not enabled, forbidden);
 * `ambiguous` is undetermined and a later identical attempt can still succeed;
 * `flake-hold` is the engine's own refusal to keep feeding a head that has
 * already failed the queue twice.
 */
export type ExactEnqueueOutcome =
  | {
      readonly status: 'enqueued' | 'already-enqueued';
      readonly head: GitOid;
      readonly position?: number;
      readonly queueState?: string;
      readonly reason?: string;
    }
  | {
      readonly status:
      | 'already-merged'
      | 'rejected'
      | 'changed-head'
      | 'ambiguous'
      | 'flake-hold';
      readonly head: GitOid;
      readonly reason?: string;
    };

/**
 * Why an `update-branch` attempt did not move the head. The port classifies the
 * failure once, at the only place that can still see the error text; every
 * consumer downstream reasons about the class, never about a raw message.
 *
 * `conflict` and `forbidden` are *durable*: the head will not move without
 * human intervention (a real merge conflict; a branch-protection, permission,
 * or credential refusal). `queued`, `rate-limited`, `unavailable` and
 * `unclassified` are *undetermined*: the request may have been accepted, may
 * have been throttled, or may never have reached GitHub, and a later identical
 * attempt can still succeed.
 */
export const UPDATE_BRANCH_FAILURE_CLASSES = [
  'conflict',
  'forbidden',
  'queued',
  'rate-limited',
  'unavailable',
  'unclassified',
] as const;

export type UpdateBranchFailureClass = typeof UPDATE_BRANCH_FAILURE_CLASSES[number];

export const DURABLE_UPDATE_BRANCH_FAILURES: ReadonlySet<UpdateBranchFailureClass> =
  new Set<UpdateBranchFailureClass>(['conflict', 'forbidden']);

export type UpdateBranchOutcome =
  | { readonly status: 'updated' | 'changed-head'; readonly head: GitOid }
  /**
   * There was nothing to update: the head is not behind its base. Success, not
   * failure, and distinct from `updated` because the head did not move.
   *
   * `gh pr update-branch` compares before it mutates and, when `behind_by == 0`,
   * prints `PR branch already up-to-date` to stdout and **exits 0** without
   * calling the API at all (`cli/cli` v2.78 `update_branch.go`). The old port
   * saw exit 0, read an unchanged head, and reported `rejected`.
   */
  | { readonly status: 'already-up-to-date'; readonly head: GitOid }
  | {
      readonly status: 'rejected' | 'pending';
      readonly head: GitOid;
      readonly failure: UpdateBranchFailureClass;
    };

export interface EnqueueExecutorDeps {
  readCandidate(prNumber: number): Promise<EnqueueCandidate | null>;
  readonly credentials: CredentialPool;
  enqueueAtHead(input: {
    readonly prNumber: number;
    readonly issueNumber: number;
    readonly head: GitOid;
    readonly graphqlId: string;
    readonly expectedBaseRefName: GitRefName;
    readonly credential: SelectedCredential;
  }): Promise<ExactEnqueueOutcome>;
  updateBranch?(input: {
    readonly prNumber: number;
    readonly expectedHead: GitOid;
    readonly credential: SelectedCredential;
  }): Promise<UpdateBranchOutcome>;
  fileReconcileChild?(input: {
    readonly prNumber: number;
    readonly effort: 'low' | 'medium' | 'high';
    readonly credential: SelectedCredential;
  }): Promise<
    | { readonly number: number; readonly created: boolean; readonly runawayHold?: undefined }
    | { readonly runawayHold: true; readonly priorCount: number }
  >;
}

/**
 * `merged` and `merged-projection-pending` are deliberately absent. This stage
 * hands the PR to GitHub's merge queue and stops; the merge itself happens on
 * GitHub's schedule, and Done arrives from a later cycle reading a MERGED
 * snapshot through the existing merged-phase machinery. A status claiming a
 * merge here would be asserting an outcome this code never observed.
 */
export type EnqueueExecutionResult =
  | {
      readonly status: 'enqueued' | 'already-enqueued';
      readonly prNumber: number;
      readonly head: GitOid;
      readonly position?: number;
      readonly queueState?: string;
      readonly reason?: string;
    }
  | {
      readonly status: 'ineligible';
      readonly prNumber: number;
      readonly head?: GitOid;
      readonly reasons: readonly string[];
    }
  | {
      readonly status: 'changed-head';
      readonly prNumber: number;
      readonly head: GitOid;
    }
  | {
      readonly status: 'already-merged' | 'rejected' | 'ambiguous' | 'flake-hold';
      readonly prNumber: number;
      readonly head: GitOid;
      readonly reason?: string;
    };

export async function executeEnqueueAction(
  action: {
    readonly prNumber: number;
    readonly expectedHead: GitOid;
    readonly expectedBaseRefName: GitRefName;
  },
  deps: EnqueueExecutorDeps,
): Promise<EnqueueExecutionResult> {
  if (!Number.isSafeInteger(action.prNumber) || action.prNumber <= 0) {
    throw new Error('Enqueue action requires a positive PR number');
  }
  const initial = await deps.readCandidate(action.prNumber);
  if (initial === null) {
    return {
      status: 'ineligible',
      prNumber: action.prNumber,
      reasons: ['pull-request-missing'],
    };
  }
  if (initial.head !== action.expectedHead) {
    return { status: 'changed-head', prNumber: action.prNumber, head: initial.head };
  }
  if (initial.expectedBaseRefName !== action.expectedBaseRefName) {
    return {
      status: 'ineligible',
      prNumber: action.prNumber,
      head: initial.head,
      reasons: ['base'],
    };
  }
  if (initial.inMergeQueue) {
    return { status: 'already-enqueued', prNumber: action.prNumber, head: initial.head };
  }
  const initialGate = evaluateEnqueueGate(initial);
  if (!initialGate.pass) {
    return {
      status: 'ineligible',
      prNumber: action.prNumber,
      head: initial.head,
      reasons: initialGate.reasons,
    };
  }
  const selection = selectCredential(deps.credentials, { phase: 'merge' });
  if (selection.status !== 'selected') {
    return {
      status: 'ineligible',
      prNumber: action.prNumber,
      head: initial.head,
      reasons: ['credential-unavailable'],
    };
  }
  const current = await deps.readCandidate(action.prNumber);
  if (current === null) {
    return {
      status: 'ineligible',
      prNumber: action.prNumber,
      reasons: ['pull-request-missing'],
    };
  }
  if (current.head !== action.expectedHead) {
    return { status: 'changed-head', prNumber: action.prNumber, head: current.head };
  }
  if (current.expectedBaseRefName !== action.expectedBaseRefName) {
    return {
      status: 'ineligible',
      prNumber: action.prNumber,
      head: current.head,
      reasons: ['base'],
    };
  }
  if (current.inMergeQueue) {
    return { status: 'already-enqueued', prNumber: action.prNumber, head: current.head };
  }
  const gate = evaluateEnqueueGate(current);
  if (!gate.pass) {
    return {
      status: 'ineligible',
      prNumber: action.prNumber,
      head: current.head,
      reasons: gate.reasons,
    };
  }
  // Proven by the gate immediately above: `pull-request-node-id-missing` is a
  // refusal, so a passing gate means the id is present.
  const graphqlId = current.graphqlId!;
  const outcome = await deps.enqueueAtHead({
    prNumber: action.prNumber,
    issueNumber: current.issueNumber,
    head: action.expectedHead,
    graphqlId,
    expectedBaseRefName: action.expectedBaseRefName,
    credential: selection.credential,
  });
  if (outcome.status === 'changed-head') {
    return { status: 'changed-head', prNumber: action.prNumber, head: outcome.head };
  }
  return {
    status: outcome.status,
    prNumber: action.prNumber,
    head: outcome.head,
    ...('position' in outcome && outcome.position !== undefined
      ? { position: outcome.position }
      : {}),
    ...('queueState' in outcome && outcome.queueState !== undefined
      ? { queueState: outcome.queueState }
      : {}),
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  };
}

/**
 * `pending` is a first-class outcome, not a flavour of `rejected`.
 *
 * `PUT /repos/{o}/{r}/pulls/{n}/update-branch` is documented to answer **202
 * Accepted**: GitHub *queues* the update and the PR head has not moved by the
 * time the call returns. The previous implementation read the head back once
 * and called an unchanged head `rejected`, which reported a merge conflict for
 * an update that was merely in flight, and equally for a 403 branch-protection
 * refusal, a secondary rate limit, and a dropped connection. Live evidence:
 * PR #2130's update-branch was reported `rejected`; the identical operation
 * later succeeded with nothing changed but time.
 *
 * `rejected` now means only "GitHub durably refused" (`conflict` / `forbidden`).
 * `pending` means "undetermined, retry is meaningful". `already-up-to-date`
 * means there was nothing to do. None of them is `updated`.
 *
 * Second live case, opposite cause, identical old output: PR #2229 was reported
 * `rejected` while sitting at `ahead_by=4, behind_by=0` — nothing to update at
 * all. One string covered "retry this", "nothing to do here", and "this
 * genuinely conflicts"; the operator could not tell them apart.
 *
 * The statuses are deliberately self-describing, because the runtime handler
 * that surfaces them forwards `reason` for only some statuses.
 */
export type UpdateBranchResult =
  | { readonly status: 'updated'; readonly prNumber: number; readonly head: GitOid }
  | { readonly status: 'changed-head'; readonly prNumber: number; readonly head: GitOid }
  | {
      readonly status: 'already-up-to-date';
      readonly prNumber: number;
      readonly head: GitOid;
    }
  | {
      readonly status: 'ineligible' | 'rejected' | 'pending';
      readonly prNumber: number;
      readonly reason: string;
    };

export async function executeUpdateBranchAction(
  action: { readonly prNumber: number; readonly expectedHead: GitOid },
  deps: EnqueueExecutorDeps,
): Promise<UpdateBranchResult> {
  if (deps.updateBranch === undefined) {
    return { status: 'ineligible', prNumber: action.prNumber, reason: 'update-branch-unavailable' };
  }
  const candidate = await deps.readCandidate(action.prNumber);
  if (candidate === null) {
    return { status: 'ineligible', prNumber: action.prNumber, reason: 'pull-request-missing' };
  }
  if (candidate.head !== action.expectedHead) {
    return { status: 'changed-head', prNumber: action.prNumber, head: candidate.head };
  }
  // Staleness guard. The ladder only ever schedules `update-branch` for a
  // `behind`/`diverged` compare, but that decision is made against the cycle
  // snapshot; by the time this executes the base may already have been merged
  // in, leaving nothing to do. Observed live on PR #2229, dispatched from a
  // stale `behind` and sitting at `ahead_by=4, behind_by=0` by the time the
  // mutation ran — which the old code reported as `rejected`.
  //
  // This is the *fresh* candidate read, so `ahead`/`identical` means the base
  // tip is genuinely an ancestor of the head and there is nothing to merge in.
  // `unknown` deliberately does not short-circuit: it cannot rule out `behind`,
  // so the work still happens.
  if (candidate.compareStatus === 'ahead' || candidate.compareStatus === 'identical') {
    return {
      status: 'already-up-to-date',
      prNumber: action.prNumber,
      head: candidate.head,
    };
  }
  const selection = selectCredential(deps.credentials, { phase: 'merge' });
  if (selection.status !== 'selected') {
    return { status: 'ineligible', prNumber: action.prNumber, reason: 'credential-unavailable' };
  }
  const outcome = await deps.updateBranch({
    prNumber: action.prNumber,
    expectedHead: action.expectedHead,
    credential: selection.credential,
  });
  // Fail closed by construction: `updated` is reachable only from the single
  // literal `updated` arm. Every other arm — including the `default`, which
  // TypeScript proves unreachable today and which exists so that a variant
  // added later cannot silently inherit success — lands on a non-success
  // status. There is no fallthrough `return { status: 'updated' }`.
  switch (outcome.status) {
    case 'updated':
      return { status: 'updated', prNumber: action.prNumber, head: outcome.head };
    case 'changed-head':
      return { status: 'changed-head', prNumber: action.prNumber, head: outcome.head };
    case 'already-up-to-date':
      return {
        status: 'already-up-to-date',
        prNumber: action.prNumber,
        head: outcome.head,
      };
    case 'rejected':
      return {
        status: 'rejected',
        prNumber: action.prNumber,
        reason: `update-branch-${outcome.failure}`,
      };
    case 'pending':
      return {
        status: 'pending',
        prNumber: action.prNumber,
        reason: `update-branch-${outcome.failure}`,
      };
    default: {
      const exhaustive: never = outcome;
      void exhaustive;
      return {
        status: 'pending',
        prNumber: action.prNumber,
        reason: 'update-branch-unclassified',
      };
    }
  }
}

export type FileReconcileChildResult =
  | {
      readonly status: 'filed' | 'already-open';
      readonly prNumber: number;
      readonly childNumber: number;
    }
  | {
      readonly status: 'runaway-hold';
      readonly prNumber: number;
      readonly priorCount: number;
    }
  | { readonly status: 'ineligible'; readonly prNumber: number; readonly reason: string };

export async function executeFileReconcileChildAction(
  action: {
    readonly prNumber: number;
    readonly expectedHead: GitOid;
    readonly effort: 'low' | 'medium' | 'high';
  },
  deps: EnqueueExecutorDeps,
): Promise<FileReconcileChildResult> {
  if (deps.fileReconcileChild === undefined) {
    return {
      status: 'ineligible',
      prNumber: action.prNumber,
      reason: 'file-reconcile-child-unavailable',
    };
  }
  const candidate = await deps.readCandidate(action.prNumber);
  if (candidate === null) {
    return { status: 'ineligible', prNumber: action.prNumber, reason: 'pull-request-missing' };
  }
  if (candidate.head !== action.expectedHead) {
    return { status: 'ineligible', prNumber: action.prNumber, reason: 'changed-head' };
  }
  const selection = selectCredential(deps.credentials, { phase: 'merge' });
  if (selection.status !== 'selected') {
    return { status: 'ineligible', prNumber: action.prNumber, reason: 'credential-unavailable' };
  }
  const filed = await deps.fileReconcileChild({
    prNumber: action.prNumber,
    effort: action.effort,
    credential: selection.credential,
  });
  if (filed.runawayHold === true) {
    return {
      status: 'runaway-hold',
      prNumber: action.prNumber,
      priorCount: filed.priorCount,
    };
  }
  return {
    status: filed.created ? 'filed' : 'already-open',
    prNumber: action.prNumber,
    childNumber: filed.number,
  };
}

// TODO(T6): remove compatibility aliases.
//
// The integration stage becomes an enqueue stage across #82's T1-T9. T3/T4
// rename this module and its production port; T5-T9 rewire the controller,
// the ladder, the scheduler and the runtime onto the new names. These aliases
// exist only so the tree typechecks at the half-done boundary between those
// two halves, and every one of them must be deleted with the rewiring.
//
// Exactly one live consumer remains: `active-runtime-production.ts` imports
// `executeMergeAction` for its `merge` handler. Point that handler at
// `executeEnqueueAction` and this whole block goes.
//
// Note that the aliases are name-only. `executeMergeAction` does not merge any
// more — it enqueues, and its result statuses are the enqueue ones. Nothing
// here preserves the old behaviour, only the old spelling.
export type MergeCandidate = EnqueueCandidate;
export type MergeGateResult = EnqueueGateResult;
export type MergeExecutorDeps = EnqueueExecutorDeps;
export type MergeExecutionResult = EnqueueExecutionResult;
export { evaluateEnqueueGate as evaluateMergeGate };
export { executeEnqueueAction as executeMergeAction };
