import {
  gitRefName,
  isoTimestamp,
  type AutopilotMode,
  type HumanReason,
  type LifecycleItem,
  type LifecyclePhase,
  type LifecycleSnapshot,
  type LifecycleView,
  type LifecycleViewItem,
  type LocalCapacity,
  type PlannedAction,
  type PullRequestLifecycleItem,
  type RecoveryAction,
  type ReviewClaimRecord,
} from './types.js';
import { isCiGreen } from './ci-classifier.js';

export function timestampMs(value: string): number | null {
  try {
    isoTimestamp(value);
    return new Date(value).getTime();
  } catch {
    return null;
  }
}

export interface OrphanImplementationStateInput {
  readonly headChangedAt: string;
  readonly phaseComplete: boolean;
  readonly humanHold: boolean;
  readonly humanReason?: HumanReason;
}

export interface OrphanImplementationState {
  readonly phase: 'implementing' | 'awaiting-review' | 'human';
  readonly underlyingPhase?: 'implementing' | 'awaiting-review';
  readonly progressAgeMs?: number;
  readonly stale: boolean;
  readonly staleSince?: string;
  readonly staleReason?: 'branch-head-unchanged';
  readonly humanReason?: HumanReason;
}

export function deriveOrphanImplementationState(
  input: OrphanImplementationStateInput,
  now: Date,
  staleAfterMs: number,
): OrphanImplementationState {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error('Invalid lifecycle derivation time');
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new Error('staleAfterMs must be a non-negative finite number');
  }
  const underlyingPhase = input.phaseComplete ? 'awaiting-review' : 'implementing';
  const headTime = timestampMs(input.headChangedAt);
  if (input.humanHold || input.humanReason !== undefined) {
    return {
      phase: 'human',
      underlyingPhase,
      ...(headTime === null || headTime > nowMs ? {} : { progressAgeMs: nowMs - headTime }),
      stale: false,
      ...(input.humanReason === undefined ? {} : { humanReason: input.humanReason }),
    };
  }
  if (headTime === null || headTime > nowMs) {
    return {
      phase: 'human',
      underlyingPhase,
      stale: false,
      humanReason: {
        phase: 'implementing',
        code: 'invalid-branch-progress-time',
        detail: `Invalid branch head progress timestamp: ${input.headChangedAt}`,
      },
    };
  }
  const progressAgeMs = nowMs - headTime;
  if (input.phaseComplete) {
    return {
      phase: 'awaiting-review',
      progressAgeMs,
      stale: false,
    };
  }
  if (progressAgeMs >= staleAfterMs) {
    return {
      phase: 'implementing',
      progressAgeMs,
      stale: true,
      staleSince: new Date(headTime + staleAfterMs).toISOString(),
      staleReason: 'branch-head-unchanged',
    };
  }
  return {
    phase: 'implementing',
    progressAgeMs,
    stale: false,
  };
}

function branchClaimMatchesItem(item: PullRequestLifecycleItem): boolean {
  const claim = item.branchClaim;
  return claim === undefined
    || (claim.issueNumber === item.issueNumber
      && (claim.prNumber === undefined || claim.prNumber === item.prNumber));
}

function reviewClaimMatchesItem(item: PullRequestLifecycleItem): boolean {
  return item.reviewClaim === undefined || item.reviewClaim.prNumber === item.prNumber;
}

function correlatedBranchClaim(item: PullRequestLifecycleItem) {
  return branchClaimMatchesItem(item) ? item.branchClaim : undefined;
}

function correlatedReviewClaim(item: PullRequestLifecycleItem) {
  return reviewClaimMatchesItem(item) ? item.reviewClaim : undefined;
}

/**
 * The approval was recorded at an older head, but the diff that head presented
 * against its base is byte-identical to the diff the current head presents.
 *
 * This is the *only* relaxation of head identity anywhere in the engine, and it
 * relaxes nothing else: the verdict must still be the claim's own APPROVE, must
 * still be anchored to the head the reviewer read, and every other conjunct of
 * `underlyingPhase` and of the merge gate keeps applying unchanged.
 *
 * Fail-closed by shape: both digests are optional, and `undefined === undefined`
 * is short-circuited by the explicit `!== undefined` guards, so an unproven
 * digest on either side can never satisfy this.
 */
function approvalCarriesToCurrentHead(
  item: PullRequestLifecycleItem,
  claim: ReviewClaimRecord,
): boolean {
  const verdict = item.terminalVerdict;
  return claim.reviewedDiffDigest !== undefined
    && item.reviewedDiffDigest !== undefined
    && claim.reviewedDiffDigest === item.reviewedDiffDigest
    && claim.verdict !== undefined
    && verdict !== undefined
    && verdict.head === claim.head
    && verdict.marker === claim.verdict.marker
    && verdict.state === claim.verdict.state;
}

/**
 * The engine's own signed approval, valid for the current head.
 *
 * Mirrors the engine-side half of `terminalApprovalMatches` in
 * merge-executor-production (the merge gate additionally re-derives the signed
 * marker, requires a native APPROVED review carrying it, and recomputes the
 * digest from a *fresh* compare rather than the snapshot's). Deliberately a
 * strict subset: the view may never call an item merge-ready that the gate
 * would then reject for `terminal-approval`.
 *
 * Defers to `hasMatchingVerdict` for the exact-head case rather than restating
 * the SHA/marker/state conjunction: `terminal-approved` already types
 * `claim.verdict.state` as `'APPROVE'`, so the two are equivalent, and a sixth
 * parallel copy of "the engine approved this head" is precisely how these
 * predicates drift apart.
 */
export function engineApprovedAtHead(item: PullRequestLifecycleItem): boolean {
  const claim = correlatedReviewClaim(item);
  if (claim?.state !== 'terminal-approved') return false;
  return hasMatchingVerdict(item, claim)
    || approvalCarriesToCurrentHead(item, claim);
}

/**
 * GitHub's native review state says APPROVED at the current head, but the
 * engine's approval does not reach this head.
 *
 * The integration ladder's own `update-branch` action merges the base into the
 * PR branch, which creates a new head commit AND carries the prior review
 * forward onto it (GitHub re-points the review's `commit_id`). Native
 * `approved` stays true while the engine's claim ref and signed body marker
 * remain bound to the pre-merge sha, so the merge gate refuses with
 * `terminal-approval`.
 *
 * A fresh review is the right answer whenever the new head presents a different
 * diff — and it stays the answer whenever we cannot *prove* the diff is the
 * same, which includes every claim written before diff digests existed and
 * every diff GitHub declines to represent. It is not the answer when the diff
 * is provably identical: re-reviewing then buys nothing but a review slot, and
 * the pipeline was serialising on exactly that (PR #2130 reviewed three times
 * to land one change). The residual exposure that remains — a base change that
 * alters semantics without altering this PR's diff — is not something a fresh
 * review of the same diff would catch either; CI on the new head is what covers
 * it, and the `checks` conjunct evaluates against the current head.
 */
export function engineApprovalLapsed(item: PullRequestLifecycleItem): boolean {
  return item.approved && !item.needsReview && !engineApprovedAtHead(item);
}

function humanOverlay(item: LifecycleItem): boolean {
  return item.humanHold === true
    || item.labels.includes('review:needs-human')
    || item.labels.includes('autopilot:human')
    || item.humanReason !== undefined
    || (item.kind === 'pull-request'
      && (!branchClaimMatchesItem(item)
        || !reviewClaimMatchesItem(item)));
}

function underlyingPhase(item: LifecycleItem): Exclude<LifecyclePhase, 'human'> {
  if (item.kind === 'issue') return 'eligible';
  if (item.merged) return 'merged';

  const branchClaim = correlatedBranchClaim(item);
  if (
    (branchClaim?.phase === 'implement'
      || branchClaim?.phase === 'fix'
      || branchClaim?.phase === 'reconcile')
    && branchClaim.phaseComplete !== true
  ) {
    return 'implementing';
  }

  // Children / head-bound RC outrank an in-flight review claim: the parent is
  // blocked until the child lands (Stage 2). Checking before review-claim
  // phases keeps REQUEST_CHANGES from looking like an active review.
  const openChildren = item.openChildKinds ?? [];
  const headBoundChangesRequested = item.terminalVerdict?.head === item.head
    && item.terminalVerdict.state === 'REQUEST_CHANGES';
  if (openChildren.length > 0 || headBoundChangesRequested) {
    return 'blocked-by-child';
  }

  const review = correlatedReviewClaim(item);
  const currentReview = review !== undefined && review.head === item.head;
  if (
    currentReview
    && ![
      'stale',
      'terminal-approved',
      'human',
      'human-intent',
    ].includes(review.state)
  ) {
    return 'reviewing';
  }

  if (item.approved && !item.needsReview) {
    if (!isCiGreen(item.checks ?? [])) return 'ci-blocked';
    // A native APPROVED that the engine did not sign at this exact head cannot
    // pass the merge gate (`terminal-approval`), so calling it merge-ready
    // strands the PR in a merge-ready -> merge -> ineligible loop with review
    // enrollment closed. Fall through to awaiting-review so it can be
    // re-reviewed at the head that actually exists.
    if (item.mergeState === 'clean' && !engineApprovalLapsed(item)) return 'merge-ready';
    // Behind / conflict: integration ladder owns the next mutation; view stays
    // awaiting-review so review enrollment stays closed while the gate
    // schedules update-branch / file-reconcile-child.
    return 'awaiting-review';
  }
  return 'awaiting-review';
}

function hasMatchingVerdict(
  item: PullRequestLifecycleItem,
  review: ReviewClaimRecord,
): boolean {
  const verdict = item.terminalVerdict;
  return verdict !== undefined
    && review.verdict !== undefined
    && review.head === item.head
    && verdict.head === review.head
    && verdict.marker === review.verdict.marker
    && verdict.state === review.verdict.state;
}

function matchingVerdictTime(
  item: PullRequestLifecycleItem,
  review: ReviewClaimRecord,
): number | null {
  return hasMatchingVerdict(item, review) && item.terminalVerdict !== undefined
    ? timestampMs(item.terminalVerdict.recordedAt)
    : null;
}

function staleEvidence(
  item: LifecycleItem,
  phase: Exclude<LifecyclePhase, 'human'>,
  nowMs: number,
  staleAfterMs: number,
): Pick<LifecycleViewItem, 'stale' | 'staleSince' | 'staleReason'> {
  if (!item.v2Marked || staleAfterMs < 0 || item.kind !== 'pull-request') {
    return { stale: false };
  }

  if (
    phase === 'implementing'
    && correlatedBranchClaim(item) !== undefined
    && correlatedBranchClaim(item)?.phaseComplete !== true
  ) {
    const headTime = timestampMs(item.headChangedAt);
    if (headTime === null || headTime > nowMs || nowMs - headTime < staleAfterMs) {
      return { stale: false };
    }
    return {
      stale: true,
      staleSince: new Date(headTime + staleAfterMs).toISOString(),
      staleReason: 'branch-head-unchanged',
    };
  }

  const review = correlatedReviewClaim(item);
  if (
    phase === 'reviewing'
    && review !== undefined
    && review.head === item.head
    && ![
      'stale',
      'terminal-approved',
      'human',
      'human-intent',
      'mapping-reread',
    ].includes(review.state)
  ) {
    const headTime = timestampMs(item.headChangedAt);
    const verdictTime = matchingVerdictTime(item, review);
    if (verdictTime !== null) return { stale: false };
    if (headTime === null) return { stale: false };
    if (headTime > nowMs) return { stale: false };

    // Winning a review claim generation is the one permitted progress event for
    // review (mirrors the branch claim commit for implement): it initializes
    // the clock even when the PR head is already old. Later metadata-only
    // transitions within the same generation (verdict-intent, ...) do not
    // carry their own recordedAt forward as a reset, so they cannot re-extend it.
    let progressTime = headTime;
    if (review.state === 'active') {
      const acquisitionTime = timestampMs(review.recordedAt);
      if (acquisitionTime !== null && acquisitionTime > progressTime) {
        progressTime = acquisitionTime;
      }
    }

    if (nowMs - progressTime < staleAfterMs) {
      return { stale: false };
    }
    return {
      stale: true,
      staleSince: new Date(progressTime + staleAfterMs).toISOString(),
      staleReason: 'review-progress-unchanged',
    };
  }

  return { stale: false };
}

function deriveItem(item: LifecycleItem, nowMs: number, staleAfterMs: number): LifecycleViewItem {
  const supersededReview = item.kind === 'pull-request'
    && item.reviewClaim !== undefined
    && item.reviewClaim.head !== item.head;
  if (item.kind === 'pull-request' && item.merged) {
    return { item, phase: 'merged', stale: false, supersededReview };
  }
  if (item.humanReason !== undefined) {
    return {
      item,
      phase: 'human',
      underlyingPhase: underlyingPhase(item),
      humanReason: item.humanReason,
      stale: false,
      supersededReview,
    };
  }
  if (item.kind === 'pull-request') {
    const review = correlatedReviewClaim(item);
    if (
      review !== undefined
      && hasMatchingVerdict(item, review)
      && item.terminalVerdict !== undefined
    ) {
      const verdictTime = timestampMs(item.terminalVerdict.recordedAt);
      if (verdictTime === null || verdictTime > nowMs) {
        const underlying = underlyingPhase(item);
        return {
          item,
          phase: 'human',
          underlyingPhase: underlying,
          humanReason: {
            phase: 'reviewing',
            code: 'invalid-review-progress-time',
            detail: `Invalid terminal verdict progress timestamp: ${item.terminalVerdict.recordedAt}`,
          },
          stale: false,
          supersededReview,
        };
      }
    }
  }
  const underlying = underlyingPhase(item);
  let invalidProgressReason: HumanReason | undefined;
  if (item.kind === 'pull-request') {
    const headTime = timestampMs(item.headChangedAt);
    if (underlying === 'implementing' && (headTime === null || headTime > nowMs)) {
      invalidProgressReason = {
        phase: 'implementing',
        code: 'invalid-branch-progress-time',
        detail: `Invalid branch head progress timestamp: ${item.headChangedAt}`,
      };
    } else if (
      (underlying === 'merge-ready' || underlying === 'ci-blocked')
      && (headTime === null || headTime > nowMs)
    ) {
      invalidProgressReason = {
        phase: underlying === 'ci-blocked' ? 'merge-ready' : underlying,
        code: 'invalid-merge-progress-time',
        detail: `Invalid merge progress timestamp: ${item.headChangedAt}`,
      };
    } else if (
      (underlying === 'awaiting-review' || underlying === 'reviewing')
      && (headTime === null || headTime > nowMs)
    ) {
      invalidProgressReason = {
        phase: underlying,
        code: 'invalid-review-progress-time',
        detail: `Invalid review progress timestamp: ${item.headChangedAt}`,
      };
    } else if (underlying === 'reviewing') {
      const review = correlatedReviewClaim(item);
      if (review !== undefined && review.head === item.head && review.state === 'active') {
        const acquisitionTime = timestampMs(review.recordedAt);
        if (acquisitionTime === null || acquisitionTime > nowMs) {
          invalidProgressReason = {
            phase: underlying,
            code: 'invalid-review-progress-time',
            detail: `Invalid review claim acquisition timestamp: ${review.recordedAt}`,
          };
        }
      }
    }
  }
  if (invalidProgressReason !== undefined) {
    return {
      item,
      phase: 'human',
      underlyingPhase: underlying,
      humanReason: invalidProgressReason,
      stale: false,
      supersededReview,
    };
  }
  if (humanOverlay(item)) {
    return {
      item,
      phase: 'human',
      underlyingPhase: underlying,
      humanReason: item.humanReason,
      stale: false,
      supersededReview,
    };
  }
  return {
    item,
    phase: underlying,
    ...staleEvidence(item, underlying, nowMs, staleAfterMs),
    supersededReview,
  };
}

export function deriveLifecycle(
  snapshot: LifecycleSnapshot,
  now: Date,
  staleAfterMs: number,
): LifecycleView {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error('Invalid lifecycle derivation time');
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new Error('staleAfterMs must be a non-negative finite number');
  }
  return { items: snapshot.items.map((item) => deriveItem(item, nowMs, staleAfterMs)) };
}

function recoveryForView(view: LifecycleViewItem): readonly RecoveryAction[] {
  if (!view.stale || view.phase === 'human' || view.item.kind !== 'pull-request') return [];
  const item = view.item;
  // Stale implementation reclaim is claim-branch / scheduler driven (Stage 3+).
  if (
    view.phase === 'reviewing'
    && item.reviewClaim !== undefined
  ) {
    return [{
      kind: 'mark-review-stale',
      prNumber: item.prNumber,
      expectedGeneration: item.reviewClaim.generation,
      expectedHead: item.head,
    }];
  }
  return [];
}

export function deriveRecovery(
  item: LifecycleItem,
  now: Date,
  staleAfterMs: number,
): readonly RecoveryAction[] {
  const view = deriveLifecycle({ items: [item] }, now, staleAfterMs).items[0];
  return view === undefined ? [] : recoveryForView(view);
}

function nonNegativeSlots(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function reviewEnrollmentEligible(item: PullRequestLifecycleItem): boolean {
  // A lapsed engine approval (native APPROVED carried onto a head the engine
  // never signed) is the one approved-looking shape that still needs a review;
  // suppressing it here is what made the merge-gate refusal unrecoverable.
  if (item.approved && !item.needsReview) return !item.isDraft && engineApprovalLapsed(item);
  if (!item.isDraft) return item.needsReview && !item.approved;
  return item.reviewClaim?.state === 'stale' && item.reviewClaim.head === item.head;
}

export function planCycle(
  view: LifecycleView,
  localCapacity: LocalCapacity,
  mode: AutopilotMode,
): readonly PlannedAction[] {
  if (mode === 'observe') return [];

  const recovery = view.items.flatMap(recoveryForView);
  if (mode === 'recover') return recovery;

  let lanes = nonNegativeSlots(localCapacity.usableCredentialLanes);
  let implementationSlots = nonNegativeSlots(localCapacity.implementationSlots);
  let reviewSlots = nonNegativeSlots(localCapacity.reviewSlots);
  const planned: PlannedAction[] = [...recovery];

  for (const candidate of view.items) {
    if (
      lanes === 0
      || implementationSlots === 0
      || candidate.phase !== 'eligible'
      || candidate.stale
      || candidate.item.kind !== 'issue'
      || !candidate.item.eligible
    ) {
      continue;
    }
    planned.push({
      kind: 'claim-implementation',
      intent: 'fresh',
      issueNumber: candidate.item.issueNumber,
    });
    lanes -= 1;
    implementationSlots -= 1;
  }

  for (const candidate of view.items) {
    if (
      lanes === 0
      || reviewSlots === 0
      || candidate.phase !== 'awaiting-review'
      || candidate.stale
      || candidate.item.kind !== 'pull-request'
      || !reviewEnrollmentEligible(candidate.item)
    ) {
      continue;
    }
    planned.push({
      kind: 'claim-review',
      issueNumber: candidate.item.issueNumber,
      prNumber: candidate.item.prNumber,
      head: candidate.item.head,
    });
    lanes -= 1;
    reviewSlots -= 1;
  }

  for (const candidate of view.items) {
    if (candidate.phase !== 'merge-ready' || candidate.item.kind !== 'pull-request') continue;
    if (candidate.item.expectedBaseRefName === undefined) continue;
    planned.push({
      kind: 'merge',
      issueNumber: candidate.item.issueNumber,
      prNumber: candidate.item.prNumber,
      head: candidate.item.head,
      expectedBaseRefName: gitRefName(candidate.item.expectedBaseRefName),
    });
  }
  return planned;
}
