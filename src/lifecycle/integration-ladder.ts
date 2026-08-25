/**
 * Enqueue-gate integration ladder helpers (single-surface Stage 2).
 */

import type { CompareStatus } from './types.js';

/**
 * What the engine still owes an approved, green pull request once merging
 * belongs to GitHub's merge queue.
 *
 * There used to be a third rung, `update-branch`, between `file-reconcile-child`
 * and `merge-ready`. It is gone. The queue builds its own merge candidate on
 * top of the current base and runs the required checks against that candidate,
 * so catching a head up to its base is work GitHub already does — and doing it
 * here cost a re-review every time, because `update-branch` mints a new head
 * commit that the engine's signed approval is no longer bound to.
 *
 * What is left is a two-way decision: a head the queue can take
 * (`enqueue-ready`), and a head it cannot (`file-reconcile-child`).
 */
export type IntegrationLadderAction =
  | { readonly kind: 'enqueue-ready' }
  | { readonly kind: 'file-reconcile-child'; readonly effort: 'low' | 'medium' | 'high' }
  | { readonly kind: 'blocked'; readonly reasons: readonly string[] }

export interface IntegrationLadderInput {
  readonly approved: boolean;
  readonly ciGreen: boolean;
  readonly draft: boolean;
  readonly humanHold: boolean;
  readonly mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | string;
  readonly mergeStateStatus: string;
  readonly compareStatus: CompareStatus;
  readonly openReconcileChild: boolean;
  readonly openFindingChild: boolean;
  readonly childrenEnabled?: boolean;
}

export function chooseIntegrationLadderAction(
  input: IntegrationLadderInput,
): IntegrationLadderAction {
  if (input.draft) return { kind: 'blocked', reasons: ['draft'] };
  if (input.humanHold) return { kind: 'blocked', reasons: ['human'] };
  if (!input.approved) return { kind: 'blocked', reasons: ['not-approved'] };
  if (!input.ciGreen) return { kind: 'blocked', reasons: ['ci'] };
  if (input.openFindingChild || input.openReconcileChild) {
    return { kind: 'blocked', reasons: ['open-child'] };
  }

  const conflicting = input.mergeable === 'CONFLICTING'
    || input.mergeStateStatus === 'DIRTY';

  if (conflicting) {
    // The one thing the queue genuinely cannot do. A reconcile child is the
    // only way out, so disarming children is a hold — never a licence to hand
    // the queue a head that does not merge.
    const childrenOn = input.childrenEnabled ?? true;
    if (!childrenOn) return { kind: 'blocked', reasons: ['children-disarmed'] };
    return { kind: 'file-reconcile-child', effort: 'medium' };
  }

  // An unreadable compare cannot rule out a state that disqualifies the head,
  // and an unfinished mergeability computation is not an answer yet. Both mean
  // "ask again next cycle", never "enqueue and hope".
  if (input.compareStatus === 'unknown' || input.mergeable !== 'MERGEABLE') {
    return { kind: 'blocked', reasons: ['mergeability'] };
  }

  // Everything that survives is queue input, `behind` and `diverged` included.
  // The `mergeStateStatus ∈ {CLEAN, UNSTABLE, HAS_HOOKS}` requirement went with
  // update-branch: BEHIND and BLOCKED are the states a queue-managed PR sits in
  // by construction, and DIRTY — the one that is a real refusal — was already
  // answered above by name.
  return { kind: 'enqueue-ready' };
}
