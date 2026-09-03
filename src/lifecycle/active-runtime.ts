import { withCycleStep } from '../cycle-heartbeat.js';
import type { AttemptManifest, AttemptPhase } from './attempt-workspace.js';
import { diskHeadroomSkipDetail, type DiskHeadroom } from './disk-headroom.js';
import type { LifecycleControllerDeps } from './controller.js';
import type { CredentialPool } from './credentials.js';
import { laneForNewWorkAction, type NewWorkAction } from './types.js';
import type { GitHubLifecycleSnapshot } from './snapshot.js';

export interface ActiveRuntimeResult {
  readonly status: string;
  readonly detail?: string;
  readonly reason?: string;
  readonly reasons?: readonly string[];
  /**
   * An enqueue was refused for a reason that belongs to the repository, not to
   * this pull request — the merge queue is not enabled, or this credential
   * cannot use it. Carried through the `{outcome, reason}` collapse below
   * because the controller's per-cycle latch reads it: every remaining enqueue
   * would pay a full candidate derivation to reach the identical refusal.
   */
  readonly repositoryRefusal?: true;
}

export interface ActiveRuntimeHandlers {
  repairMachineChild?(
    action: Extract<NewWorkAction, { kind: 'repair-machine-child' }>,
    credentials: CredentialPool,
    snapshot: GitHubLifecycleSnapshot,
  ): Promise<ActiveRuntimeResult>;
  implementation(
    action: Extract<NewWorkAction, { kind: 'claim-implementation' }>,
    credentials: CredentialPool,
    snapshot: GitHubLifecycleSnapshot,
  ): Promise<ActiveRuntimeResult>;
  review(
    action: Extract<NewWorkAction, { kind: 'claim-review' }>,
    credentials: CredentialPool,
    snapshot: GitHubLifecycleSnapshot,
    context?: { readonly cohortQuotaReserved: boolean },
  ): Promise<ActiveRuntimeResult>;
  fileReconcileChild?(
    action: Extract<NewWorkAction, { kind: 'file-reconcile-child' }>,
    credentials: CredentialPool,
    snapshot: GitHubLifecycleSnapshot,
  ): Promise<ActiveRuntimeResult>;
  rerunFailedChecks?(
    action: Extract<NewWorkAction, { kind: 'rerun-failed-checks' }>,
    credentials: CredentialPool,
    snapshot: GitHubLifecycleSnapshot,
  ): Promise<ActiveRuntimeResult>;
  fileCiFailureChild?(
    action: Extract<NewWorkAction, { kind: 'file-ci-failure-child' }>,
    credentials: CredentialPool,
    snapshot: GitHubLifecycleSnapshot,
  ): Promise<ActiveRuntimeResult>;
  /** File one debt sweep for a merged/closed parent's follow-ups (#126). */
  fileDebtSweep?(
    action: Extract<NewWorkAction, { kind: 'file-debt-sweep' }>,
    credentials: CredentialPool,
    snapshot: GitHubLifecycleSnapshot,
  ): Promise<ActiveRuntimeResult>;
  /**
   * Hand the exact head to GitHub's merge queue. Nothing this handler returns
   * may claim the change landed: the queue merges on its own schedule, and Done
   * arrives from a later cycle reading a MERGED snapshot.
   */
  enqueue(
    action: Extract<NewWorkAction, { kind: 'enqueue' }>,
    credentials: CredentialPool,
    snapshot: GitHubLifecycleSnapshot,
  ): Promise<ActiveRuntimeResult>;
}

export interface ActiveRuntimeOptions {
  readonly credentials: CredentialPool;
  readonly caps: {
    readonly implementation: number;
    /** Machine-child work, capped separately from fresh claims (#122). */
    readonly child: number;
    readonly review: number;
  };
  readonly implementationPreferredLogin: string;
  readonly implementationBackpressureThreshold: number;
  /**
   * jinn-mono#1883: canary safety knob (`JINN_AUTOPILOT_ONLY_ISSUES`).
   * `undefined` means unrestricted — the pre-existing behavior. When set,
   * new-work claim scheduling in the controller is restricted to issue
   * numbers in this set; reconciliation of existing items is unaffected.
   */
  readonly onlyIssues?: ReadonlySet<number>;
  readonly readLocalAttempts: () => readonly AttemptManifest[];
  readonly preflight: () => Promise<{
    readonly ok: boolean;
    readonly detail?: string;
  }>;
  /**
   * The pre-#144 seam: current free bytes against the floor, with no notion of
   * work already committed to. Still honoured — a build that wires no
   * projection behaves exactly as it did — but `readDiskHeadroom` supersedes
   * it wherever both are present.
   */
  readonly newWorkPaused?: () => boolean;
  /**
   * Projects free space forward over this cycle's own dispatches (#144).
   *
   * Called with the phases this cycle has already spawned, so the projection
   * can charge each of them its expected footprint before the next dispatch
   * asks whether the disk can take one more. Returning `null` means the
   * projection could not be computed — an unreadable volume, an absent
   * `statvfs` — and the runtime falls back to `newWorkPaused`; it never
   * blocks work on its own inability to answer.
   */
  readonly readDiskHeadroom?: (
    pendingSpawns: readonly AttemptPhase[],
  ) => DiskHeadroom | null;
  /** Reserves aggregate GitHub capacity once before a review cohort starts. */
  readonly reserveReviewCohort?: (size: number) => Promise<void>;
  readonly handlers: ActiveRuntimeHandlers;
}

function nonNegative(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function reason(result: ActiveRuntimeResult): string | undefined {
  if (result.reason !== undefined) return result.reason;
  if (result.detail !== undefined) return result.detail;
  if (result.reasons !== undefined && result.reasons.length > 0) {
    return result.reasons.join(', ');
  }
  return undefined;
}

/**
 * Names one dispatch for the cycle heartbeat (#132). A dispatch is where the
 * cycle prepares an attempt workspace — a `git worktree add` of the whole
 * repository — so it is the other place a cycle can sit for minutes with
 * nothing to show for it.
 */
export function dispatchStepLabel(action: NewWorkAction): string {
  const subject = 'prNumber' in action
    ? `pr-${action.prNumber}`
    : 'parentPr' in action
      ? `pr-${action.parentPr}`
      : 'issueNumber' in action
        ? `issue-${action.issueNumber}`
        : null;
  return `dispatch ${action.kind}${subject === null ? '' : ` ${subject}`}`;
}

/**
 * One action to one handler. The optional handlers report `skipped` rather
 * than throwing when a build does not wire them, so a partially-wired runtime
 * degrades to "did not run" instead of failing the cycle.
 */
function dispatchAction(
  handlers: ActiveRuntimeHandlers,
  action: NewWorkAction,
  credentials: CredentialPool,
  snapshot: GitHubLifecycleSnapshot,
): Promise<ActiveRuntimeResult> {
  return withCycleStep(
    dispatchStepLabel(action),
    () => routeAction(handlers, action, credentials, snapshot),
  );
}

async function routeAction(
  handlers: ActiveRuntimeHandlers,
  action: NewWorkAction,
  credentials: CredentialPool,
  snapshot: GitHubLifecycleSnapshot,
): Promise<ActiveRuntimeResult> {
  const unwired = (kind: string): ActiveRuntimeResult => ({
    status: 'skipped',
    detail: `${kind} handler unavailable`,
  });
  switch (action.kind) {
    case 'claim-implementation':
      return handlers.implementation(action, credentials, snapshot);
    case 'claim-review':
      return handlers.review(action, credentials, snapshot);
    case 'enqueue':
      return handlers.enqueue(action, credentials, snapshot);
    case 'repair-machine-child':
      return handlers.repairMachineChild?.(action, credentials, snapshot)
        ?? unwired('repair-machine-child');
    case 'file-reconcile-child':
      return handlers.fileReconcileChild?.(action, credentials, snapshot)
        ?? unwired('file-reconcile-child');
    case 'rerun-failed-checks':
      return handlers.rerunFailedChecks?.(action, credentials, snapshot)
        ?? unwired('rerun-failed-checks');
    case 'file-ci-failure-child':
      return handlers.fileCiFailureChild?.(action, credentials, snapshot)
        ?? unwired('file-ci-failure-child');
    case 'file-debt-sweep':
      return handlers.fileDebtSweep?.(action, credentials, snapshot)
        ?? unwired('file-debt-sweep');
    default:
      // Unreachable for the declared union; reached only by a retired or
      // not-yet-declared kind arriving from a stale plan. Skipping names it
      // rather than throwing the cycle away.
      return {
        status: 'skipped',
        detail: `action ${(action as { kind: string }).kind} is not wired`,
      };
  }
}

export function makeActiveRuntime(
  options: ActiveRuntimeOptions,
): NonNullable<LifecycleControllerDeps['active']> {
  const caps = {
    implementation: nonNegative(options.caps.implementation, 'implementation cap'),
    child: nonNegative(options.caps.child, 'child cap'),
    review: nonNegative(options.caps.review, 'review cap'),
  };
  /**
   * Phases this cycle has already spawned (#144).
   *
   * The footprint of a spawn lands minutes after the spawn — clone, then
   * install — so nothing on disk records it while the cycle is still
   * dispatching. This does, and the projection charges each entry its expected
   * footprint, which is what stops N spawns in one cycle from all being
   * admitted against the same free bytes.
   *
   * Reset at preflight rather than trusted to the process lifetime: the daemon
   * runs many cycles in one process, and a count that survived a cycle would
   * pause the next one for work that has long since landed.
   */
  let spawnedThisCycle: AttemptPhase[] = [];
  const readLocalState = () => {
    const diskHeadroom = options.readDiskHeadroom?.(spawnedThisCycle) ?? null;
    const newWorkPaused = diskHeadroom?.paused ?? options.newWorkPaused?.() ?? false;
    const attempts = options.readLocalAttempts();
    // Both lanes write `implement`-phase manifests, so the split is the
    // manifest's own `childKind`. An attempt written before that field existed
    // has none and counts as fresh: over-booking the implementation lane is
    // recoverable, over-running the child lane is not visible at all.
    const activeByLane = {
      implementation: attempts.filter((attempt) => (
        attempt.phase === 'implement' && attempt.childKind === undefined
      )).length,
      child: attempts.filter((attempt) => (
        attempt.phase === 'implement' && attempt.childKind !== undefined
      )).length,
      review: attempts.filter((attempt) => attempt.phase === 'review').length,
    };
    return {
      // The disk floor pauses every lane: a floor that only stopped fresh
      // claims would keep filling the same disk with child and review work.
      remaining: newWorkPaused
        ? { implementation: 0, child: 0, review: 0 }
        : {
            implementation: Math.max(0, caps.implementation - activeByLane.implementation),
            child: Math.max(0, caps.child - activeByLane.child),
            review: Math.max(0, caps.review - activeByLane.review),
          },
      newWorkPaused,
      ...(diskHeadroom === null ? {} : { diskHeadroom }),
      availableLogins: options.credentials.logins(),
      implementationPreferredLogin: options.implementationPreferredLogin,
    };
  };

  /**
   * The reason a lane with no remaining capacity refused this action. A paused
   * disk and a genuinely full lane are the same zero, and only the projection
   * can tell an operator which one they are looking at.
   */
  const laneFullReason = (local: ReturnType<typeof readLocalState>): string => (
    local.diskHeadroom?.paused === true
      ? `disk-floor (${diskHeadroomSkipDetail(local.diskHeadroom)})`
      : 'local phase capacity is full'
  );

  /**
   * How many of a review cohort the projected headroom can take, and the
   * refusal to report for the rest. With no projection wired, every member is
   * affordable — the pre-#144 behavior.
   */
  const affordableReviewCohort = (size: number): {
    readonly admitted: number;
    readonly refusal?: string;
  } => {
    const project = options.readDiskHeadroom;
    if (project === undefined) return { admitted: size };
    for (let admitted = 1; admitted <= size; admitted += 1) {
      const projected = project([
        ...spawnedThisCycle,
        ...Array.from({ length: admitted }, () => 'review' as const),
      ]);
      if (projected?.paused !== true) continue;
      return {
        admitted: admitted - 1,
        refusal: `disk-floor (${diskHeadroomSkipDetail(projected)})`,
      };
    }
    return { admitted: size };
  };

  /**
   * Charges a spawn's expected footprint against the rest of this cycle. Only
   * `spawned` counts: a refused claim opened no worktree and must not consume
   * the headroom the next candidate needs.
   */
  const chargeSpawn = (action: NewWorkAction, status: string): void => {
    if (status !== 'spawned') return;
    const lane = laneForNewWorkAction(action);
    if (lane === null) return;
    spawnedThisCycle = [
      ...spawnedThisCycle,
      lane === 'review' ? 'review' : 'implement',
    ];
  };

  return {
    async preflight() {
      spawnedThisCycle = [];
      return options.preflight();
    },
    readLocalState,
    implementationBackpressureThreshold:
      nonNegative(
        options.implementationBackpressureThreshold,
        'implementation backpressure threshold',
      ),
    ...(options.onlyIssues === undefined ? {} : { onlyIssues: options.onlyIssues }),
    async executeReviewActions(actions, snapshot) {
      if (actions.length === 0) return [];
      const local = readLocalState();
      // A review cohort dispatches concurrently, so the projection cannot gate
      // it one member at a time the way `executeAction` does — and admitting a
      // whole cohort against one reading of free space is exactly the
      // overcommit #144 is about, in miniature. So the cohort is trimmed to
      // the prefix the projection affords.
      //
      // The tail is reported as a `disk-floor` skip rather than thrown at the
      // controller as a capacity violation: the disk can fall below the floor
      // partway through a cycle — implementation claims dispatch first and
      // charge their footprint against the same volume — and that is the
      // governor working, not a scheduling error. A throw here reached the
      // controller's catch and logged every member as `failed`, which is a lie
      // about work that was deliberately held back.
      const admission = affordableReviewCohort(actions.length);
      const refused = actions.slice(admission.admitted).map(() => ({
        outcome: 'skipped',
        reason: admission.refusal!,
      }));
      if (admission.admitted === 0) return refused;
      const batch = actions.slice(0, admission.admitted);
      if (batch.length > local.remaining.review) {
        throw new Error(
          `Review cohort of ${batch.length} exceeds remaining review capacity `
            + `${local.remaining.review}`,
        );
      }
      await options.reserveReviewCohort?.(batch.length);
      const results = await Promise.all(batch.map(async (action) => {
        try {
          const result = await withCycleStep(
            dispatchStepLabel(action),
            () => options.handlers.review(
              action,
              options.credentials,
              snapshot,
              { cohortQuotaReserved: true },
            ),
          );
          const detail = reason(result);
          chargeSpawn(action, result.status);
          return {
            outcome: result.status,
            ...(detail === undefined ? {} : { reason: detail }),
          };
        } catch (error) {
          return {
            outcome: 'failed',
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      }));
      return [...results, ...refused];
    },
    async executeAction(action, snapshot) {
      const local = readLocalState();
      const lane = laneForNewWorkAction(action);
      if (lane !== null && local.remaining[lane] === 0) {
        return { outcome: 'skipped', reason: laneFullReason(local) };
      }
      const credentials = options.credentials;
      const result = await dispatchAction(
        options.handlers,
        action,
        credentials,
        snapshot,
      );
      const detail = reason(result);
      chargeSpawn(action, result.status);
      return {
        outcome: result.status,
        ...(detail === undefined ? {} : { reason: detail }),
        ...(result.repositoryRefusal === true ? { repositoryRefusal: true as const } : {}),
      };
    },
  };
}
