import {
  selectCredential,
  type CredentialPool,
  type SelectedCredential,
} from './credentials.js';
import type {
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
  /**
   * The repository's protected integration branch — the one branch a merge
   * queue is configured on. Absent means the caller could not say, which
   * asserts nothing either way; every production path supplies it.
   */
  readonly defaultBaseRefName?: GitRefName;
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
export function evaluateEnqueueGate(
  candidate: EnqueueCandidate,
  operatorLogins: ReadonlySet<string>,
): EnqueueGateResult {
  const reasons: string[] = [];
  if (!candidate.open || candidate.merged) reasons.push('pull-request-not-open');
  if (candidate.draft) reasons.push('draft');
  if (candidate.humanHold) reasons.push('human');
  if (!candidate.labels.includes('engine:review')) reasons.push('review-label');
  if (!candidate.authorAllowed) reasons.push('author');
  if (!candidate.uniqueIssueMapping) reasons.push('mapping');
  if (candidate.baseRefName !== candidate.expectedBaseRefName) reasons.push('base');
  // A merge queue belongs to one protected branch. A stacked pull request whose
  // base is another Autopilot work branch has no queue to be admitted to, so
  // this is not a risk being weighed — it is a call that cannot succeed, and
  // one that would burn an attempt-ledger entry against a head that did nothing
  // wrong. Distinct from `base` on purpose: `base` catches a PR retargeted away
  // from the base its canonical mapping names, while this catches a mapping
  // that legitimately names a parent work branch, which is the ordinary and
  // entirely correct shape of a stack until it collapses onto the root.
  if (
    candidate.defaultBaseRefName !== undefined
    && candidate.baseRefName !== candidate.defaultBaseRefName
  ) {
    reasons.push('stacked-base');
  }
  if (!candidate.terminalApprovalMatches) reasons.push('terminal-approval');
  // `terminalApprovalMatches` proves a signed, head-bound engine approval
  // exists; it says nothing about whether the account that signed it is one
  // this deployment actually runs. Without this, a credential file edited (or
  // a review claim forged) outside the configured operator set would still
  // read as a legitimate terminal approval. GitHub logins are
  // case-insensitive, so both sides are folded here — the same treatment
  // `codeOwnerApprovedAtHead` gives the CODEOWNERS comparison above.
  if (
    candidate.terminalApprovalMatches
    && (
      candidate.terminalApprovalReviewer === undefined
      || !operatorLogins.has(candidate.terminalApprovalReviewer.toLowerCase())
    )
  ) {
    reasons.push('terminal-approval-reviewer');
  }
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
      readonly status: 'rejected';
      readonly head: GitOid;
      readonly reason?: string;
      /**
       * The refusal is a property of the REPOSITORY, not of this pull request
       * or this head: the merge queue is not enabled, or the credential cannot
       * use it. Every other enqueue this cycle would be refused the same way,
       * so the caller stops issuing them until the next cycle re-probes.
       *
       * Absent means only "not proven repository-wide", never "proven
       * pull-request-scoped": an unclassified refusal simply costs another
       * cycle. Set exclusively by the post-mutation classification — the
       * pre-mutation `rejected` returns are transient races between two reads
       * and prove nothing about the repository.
       */
      readonly repositoryRefusal?: true;
    }
  | {
      readonly status:
      | 'already-merged'
      | 'changed-head'
      | 'ambiguous'
      | 'flake-hold';
      readonly head: GitOid;
      readonly reason?: string;
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
      readonly status: 'rejected';
      readonly prNumber: number;
      readonly head: GitOid;
      readonly reason?: string;
      /** See {@link ExactEnqueueOutcome}'s `rejected` variant. */
      readonly repositoryRefusal?: true;
    }
  | {
      readonly status: 'already-merged' | 'ambiguous' | 'flake-hold';
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
  // The accounts this deployment is actually authenticated as. A terminal
  // approval whose reviewer falls outside this set cannot be a real engine
  // review this deployment produced. The pool is already in hand for
  // `selectCredential` below, so deriving it costs nothing extra.
  const operatorLogins = new Set(
    deps.credentials.logins().map((login) => login.toLowerCase()),
  );
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
  const initialGate = evaluateEnqueueGate(initial, operatorLogins);
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
  const gate = evaluateEnqueueGate(current, operatorLogins);
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
  // Carried explicitly rather than through the spread below, because
  // `repositoryRefusal` is meaningful on exactly one variant and the caller's
  // per-cycle latch reads it: a spread that silently widened it onto every
  // status would be a latch armed by the wrong outcome.
  if (outcome.status === 'rejected') {
    return {
      status: 'rejected',
      prNumber: action.prNumber,
      head: outcome.head,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      ...(outcome.repositoryRefusal === true ? { repositoryRefusal: true as const } : {}),
    };
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
