import type { NewWorkAction } from './types.js';
import type { GitOid, GitRefName } from './types.js';
import type { MergePolicy } from '../config/config.js';

export type ActiveCandidate =
  | {
      readonly phase: 'implementation';
      readonly intent: 'fresh';
      readonly issueNumber: number;
      /**
       * Machine child (review-finding / reconcile / ci-failure). Children
       * drain the open-PR backlog; open-pipeline backpressure must not block
       * them or the loop deadlocks.
       */
      readonly isChild?: boolean;
    }
  | {
      readonly phase: 'implementation';
      readonly intent: 'stale-recovery';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly expectedHead: GitOid;
      readonly branch: GitRefName;
      readonly claimAttempt: string;
    }
  | {
      readonly phase: 'repair-machine-child';
      readonly issueNumber: number;
      readonly parentPr: number;
      readonly childKind: 'review-finding' | 'reconcile' | 'ci-failure';
      readonly expectedType: 'fix';
      readonly expectedEffort: 'low' | 'medium' | 'high';
      readonly expectedPriority: 'p1' | 'p2';
    }
  | {
      readonly phase: 'review';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly head: GitOid;
      readonly author: string;
    }
  | {
      readonly phase: 'file-reconcile-child';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly head: GitOid;
      readonly expectedBaseRefName: GitRefName;
      readonly effort: 'low' | 'medium' | 'high';
    }
  | {
      readonly phase: 'rerun-failed-checks';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly head: GitOid;
    }
  | {
      readonly phase: 'file-ci-failure-child';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly head: GitOid;
    }
  | {
      /**
       * Batch a merged/closed parent's open review follow-ups into one
       * elevated sweep issue (#126). Spends no concurrency lane, like the
       * other filing rungs — it spawns no session — and is instead bounded at
       * derivation by `DEBT_SWEEP_MAX_PER_CYCLE`; its dedup is the
       * parent-scoped sweep marker, re-checked live at execution.
       *
       * The only candidate that names no single issue: its subject is the
       * parent PR and its members are the issues it batches.
       */
      readonly phase: 'file-debt-sweep';
      readonly parentPr: number;
      readonly members: readonly {
        readonly number: number;
        readonly priority: 'p0' | 'p1' | 'p2' | 'p3' | 'p4';
      }[];
    }
  | {
      /**
       * Hand the exact head to GitHub's merge queue. The queue builds and lands
       * the merge commit; this engine only puts the PR in line.
       */
      readonly phase: 'enqueue';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly head: GitOid;
      readonly expectedBaseRefName: GitRefName;
    };

export interface ActiveSchedulingInput {
  readonly candidates: readonly ActiveCandidate[];
  readonly remaining: {
    readonly implementation: number;
    /**
     * Machine-child work has its own lane (#122). Children heal branches that
     * already exist and shrink the open-PR backlog; fresh claims open new
     * ones. Sharing one cap throttled the conflict-healing work against the
     * conflict-creating work, which is exactly backwards when the child queue
     * is deep.
     */
    readonly child: number;
    readonly review: number;
  };
  readonly availableLogins: readonly string[];
  readonly implementationPreferredLogin: string;
  readonly openPipelineBacklog: number;
  readonly implementationBackpressureThreshold: number;
  readonly newWorkPaused?: boolean;
}

export interface ActiveSchedulingSkip {
  readonly phase: ActiveCandidate['phase'];
  readonly subject: string;
  readonly reason: 'capacity' | 'credential-lane' | 'identity' | 'backpressure' | 'disk-floor';
}

export interface ActiveSchedulingPlan {
  readonly actions: readonly NewWorkAction[];
  readonly skips: readonly ActiveSchedulingSkip[];
  /**
   * The surplus the concurrency cap displaced, in exactly the order the plan
   * itself used — so consuming one preserves the priority ranking that decided
   * `actions`.
   *
   * A claim can still refuse at execution time (a retargeted parent, a head
   * that moved, a draft) long after scheduling proved it worthy of a slot. That
   * refusal spends no concurrency, so the cycle must be able to reach past it:
   * the cap bounds SPAWNED work, not attempted evaluations. Every candidate
   * here has already cleared the same gates a scheduled action cleared —
   * backpressure, credential lane, reviewer identity — so promoting one is
   * never a way around a gate, only around an empty slot.
   *
   * These are still reported as capacity skips: a backup that is never promoted
   * did not run, and the log must keep saying so.
   */
  readonly backups: {
    readonly implementation:
      readonly Extract<NewWorkAction, { kind: 'claim-implementation' }>[];
    readonly child:
      readonly Extract<NewWorkAction, { kind: 'claim-implementation' }>[];
    readonly review: readonly Extract<NewWorkAction, { kind: 'claim-review' }>[];
  };
}

export function applyMergePolicy(
  candidates: readonly ActiveCandidate[],
  policy: MergePolicy,
): readonly ActiveCandidate[] {
  return policy === 'manual'
    ? candidates.filter((candidate) => candidate.phase !== 'enqueue')
    : candidates;
}

function subject(candidate: ActiveCandidate): string {
  return candidate.phase === 'implementation'
    ? `issue:${candidate.issueNumber}`
    : candidate.phase === 'repair-machine-child'
      ? `issue:${candidate.issueNumber}/pr:${candidate.parentPr}`
      : candidate.phase === 'file-debt-sweep'
        ? `pr:${candidate.parentPr}`
    : `pr:${candidate.prNumber}`;
}

/**
 * The issue numbers a candidate is gated on — blocked-by-projection and the
 * `JINN_AUTOPILOT_ONLY_ISSUES` allowlist. One for every candidate that names a
 * single issue; for a debt sweep, every member it would batch, so a sweep is
 * admitted only when all of them are.
 */
export function gatingIssueNumbers(
  candidate: ActiveCandidate,
): readonly number[] {
  return candidate.phase === 'file-debt-sweep'
    ? candidate.members.map((member) => member.number)
    : [candidate.issueNumber];
}

function capacitySkipReason(input: ActiveSchedulingInput): ActiveSchedulingSkip['reason'] {
  return input.newWorkPaused === true ? 'disk-floor' : 'capacity';
}

function implementationAction(
  candidate: Extract<ActiveCandidate, { phase: 'implementation' }>,
): Extract<NewWorkAction, { kind: 'claim-implementation' }> {
  return {
    kind: 'claim-implementation',
    ...candidate.intent === 'fresh'
      ? {
          intent: 'fresh',
          issueNumber: candidate.issueNumber,
          // Advisory lane tag, not execution authority: it records which lane
          // admitted the claim so the runtime charges the right slot and the
          // controller the right fall-through budget. What the claim then
          // does is decided by the issue's own child marker.
          ...(candidate.isChild === true ? { child: true as const } : {}),
        }
      : {
          intent: 'stale-recovery',
          issueNumber: candidate.issueNumber,
          prNumber: candidate.prNumber,
          expectedHead: candidate.expectedHead,
          branch: candidate.branch,
          claimAttempt: candidate.claimAttempt,
        },
  };
}

/**
 * Every implementation gate other than capacity, so the same verdict decides a
 * skip reason for a candidate inside the cap and backup eligibility for one
 * outside it. Capacity stays the caller's first question: a surplus candidate
 * is reported as a capacity skip whatever this returns.
 */
function implementationGate(
  candidate: Extract<ActiveCandidate, { phase: 'implementation' }>,
  input: ActiveSchedulingInput,
  configuredLogins: ReadonlySet<string>,
): Exclude<ActiveSchedulingSkip['reason'], 'capacity' | 'disk-floor'> | null {
  // Fresh work only: child fixes/reconciles/ci-failures reduce backlog and
  // must still claim under backpressure (capacity remaining still applies).
  if (
    candidate.intent === 'fresh'
    && candidate.isChild !== true
    && input.openPipelineBacklog >= input.implementationBackpressureThreshold
  ) return 'backpressure';
  if (configuredLogins.size === 0) return 'credential-lane';
  return null;
}

export function scheduleActiveActions(
  input: ActiveSchedulingInput,
): ActiveSchedulingPlan {
  const actions: NewWorkAction[] = [];
  const skips: ActiveSchedulingSkip[] = [];
  const implementationBackups:
    Extract<NewWorkAction, { kind: 'claim-implementation' }>[] = [];
  const childBackups:
    Extract<NewWorkAction, { kind: 'claim-implementation' }>[] = [];
  const reviewBackups: Extract<NewWorkAction, { kind: 'claim-review' }>[] = [];
  const configuredLogins = new Set(
    input.availableLogins.map((login) => login.toLowerCase()),
  );
  const implementation = input.candidates.filter(
    (candidate): candidate is Extract<ActiveCandidate, { phase: 'implementation' }> =>
      candidate.phase === 'implementation',
  );
  for (const candidate of input.candidates) {
    if (candidate.phase !== 'repair-machine-child') continue;
    actions.push({
      kind: 'repair-machine-child',
      issueNumber: candidate.issueNumber,
      parentPr: candidate.parentPr,
      childKind: candidate.childKind,
      expectedType: candidate.expectedType,
      expectedEffort: candidate.expectedEffort,
      expectedPriority: candidate.expectedPriority,
    });
  }
  const isChildCandidate = (
    candidate: Extract<ActiveCandidate, { phase: 'implementation' }>,
  ): boolean => candidate.intent === 'fresh' && candidate.isChild === true;
  // One loop body, walked once per lane against that lane's own remaining
  // capacity and its own backup queue. Children go first, which is the
  // "children outrank fresh implementation claims" order the caller already
  // ranked them in; the fresh pass then sees exactly the candidates it saw
  // before, in exactly the same order, minus the ones this lane took.
  const scheduleLane = (
    laneCandidates: readonly Extract<ActiveCandidate, { phase: 'implementation' }>[],
    remaining: number,
    backups: Extract<NewWorkAction, { kind: 'claim-implementation' }>[],
  ): void => {
    let scheduled = 0;
    for (const candidate of laneCandidates) {
      const gate = implementationGate(candidate, input, configuredLogins);
      if (scheduled >= remaining) {
        skips.push({
          phase: candidate.phase,
          subject: subject(candidate),
          reason: capacitySkipReason(input),
        });
        // Paused new work is not a slot shortage, so nothing behind it is a
        // backup: promoting one would spend the very capacity the disk floor
        // withheld.
        if (gate === null && input.newWorkPaused !== true) {
          backups.push(implementationAction(candidate));
        }
        continue;
      }
      if (gate !== null) {
        skips.push({ phase: candidate.phase, subject: subject(candidate), reason: gate });
        continue;
      }
      actions.push(implementationAction(candidate));
      scheduled += 1;
    }
  };
  scheduleLane(
    implementation.filter(isChildCandidate),
    input.remaining.child,
    childBackups,
  );
  scheduleLane(
    implementation.filter((candidate) => !isChildCandidate(candidate)),
    input.remaining.implementation,
    implementationBackups,
  );

  let scheduledReview = 0;
  for (const candidate of input.candidates) {
    if (candidate.phase !== 'review') continue;
    const reviewer = [...configuredLogins].find(
      (login) => login !== candidate.author.toLowerCase(),
    );
    if (scheduledReview >= input.remaining.review) {
      skips.push({
        phase: candidate.phase,
        subject: subject(candidate),
        reason: capacitySkipReason(input),
      });
      if (reviewer !== undefined && input.newWorkPaused !== true) {
        reviewBackups.push({
          kind: 'claim-review',
          issueNumber: candidate.issueNumber,
          prNumber: candidate.prNumber,
          head: candidate.head,
        });
      }
      continue;
    }
    if (reviewer === undefined) {
      skips.push({
        phase: candidate.phase,
        subject: subject(candidate),
        reason: configuredLogins.size === 0 ? 'credential-lane' : 'identity',
      });
      continue;
    }
    actions.push({
      kind: 'claim-review',
      issueNumber: candidate.issueNumber,
      prNumber: candidate.prNumber,
      head: candidate.head,
    });
    scheduledReview += 1;
  }

  for (const candidate of input.candidates) {
    if (candidate.phase === 'file-reconcile-child') {
      actions.push({
        kind: 'file-reconcile-child',
        issueNumber: candidate.issueNumber,
        prNumber: candidate.prNumber,
        head: candidate.head,
        expectedBaseRefName: candidate.expectedBaseRefName,
        effort: candidate.effort,
      });
      continue;
    }
    if (candidate.phase === 'rerun-failed-checks') {
      actions.push({
        kind: 'rerun-failed-checks',
        issueNumber: candidate.issueNumber,
        prNumber: candidate.prNumber,
        head: candidate.head,
      });
      continue;
    }
    if (candidate.phase === 'file-ci-failure-child') {
      actions.push({
        kind: 'file-ci-failure-child',
        issueNumber: candidate.issueNumber,
        prNumber: candidate.prNumber,
        head: candidate.head,
      });
      continue;
    }
    if (candidate.phase === 'file-debt-sweep') {
      actions.push({
        kind: 'file-debt-sweep',
        parentPr: candidate.parentPr,
        members: candidate.members,
      });
    }
  }

  for (const candidate of input.candidates) {
    if (candidate.phase !== 'enqueue') continue;
    if (configuredLogins.size === 0) {
      skips.push({ phase: candidate.phase, subject: subject(candidate), reason: 'credential-lane' });
      continue;
    }
    actions.push({
      kind: 'enqueue',
      issueNumber: candidate.issueNumber,
      prNumber: candidate.prNumber,
      head: candidate.head,
      expectedBaseRefName: candidate.expectedBaseRefName,
    });
  }

  return {
    actions,
    skips,
    backups: {
      implementation: implementationBackups,
      child: childBackups,
      review: reviewBackups,
    },
  };
}
