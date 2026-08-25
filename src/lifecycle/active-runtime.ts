import type { AttemptManifest } from './attempt-workspace.js';
import type { LifecycleControllerDeps } from './controller.js';
import type { CredentialPool } from './credentials.js';
import type { NewWorkAction } from './types.js';
import type { GitHubLifecycleSnapshot } from './snapshot.js';

export interface ActiveRuntimeResult {
  readonly status: string;
  readonly detail?: string;
  readonly reason?: string;
  readonly reasons?: readonly string[];
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
  readonly newWorkPaused?: () => boolean;
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

export function makeActiveRuntime(
  options: ActiveRuntimeOptions,
): NonNullable<LifecycleControllerDeps['active']> {
  const caps = {
    implementation: nonNegative(options.caps.implementation, 'implementation cap'),
    review: nonNegative(options.caps.review, 'review cap'),
  };
  const readLocalState = () => {
    const newWorkPaused = options.newWorkPaused?.() ?? false;
    const attempts = options.readLocalAttempts();
    const activeByPhase = {
      implementation: attempts.filter((attempt) => attempt.phase === 'implement').length,
      review: attempts.filter((attempt) => attempt.phase === 'review').length,
    };
    return {
      remaining: newWorkPaused
        ? { implementation: 0, review: 0 }
        : {
            implementation: Math.max(0, caps.implementation - activeByPhase.implementation),
            review: Math.max(0, caps.review - activeByPhase.review),
          },
      newWorkPaused,
      availableLogins: options.credentials.logins(),
      implementationPreferredLogin: options.implementationPreferredLogin,
    };
  };

  return {
    preflight: options.preflight,
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
      if (actions.length > local.remaining.review) {
        throw new Error(
          `Review cohort of ${actions.length} exceeds remaining review capacity `
            + `${local.remaining.review}`,
        );
      }
      await options.reserveReviewCohort?.(actions.length);
      return Promise.all(actions.map(async (action) => {
        try {
          const result = await options.handlers.review(
            action,
            options.credentials,
            snapshot,
            { cohortQuotaReserved: true },
          );
          const detail = reason(result);
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
    },
    async executeAction(action, snapshot) {
      const local = readLocalState();
      const phase = action.kind === 'claim-implementation'
        ? 'implementation'
        : action.kind === 'claim-review'
          ? 'review'
          : null;
      if (phase !== null && local.remaining[phase] === 0) {
        return { outcome: 'skipped', reason: 'local phase capacity is full' };
      }
      const credentials = options.credentials;
      const result = action.kind === 'claim-implementation'
        ? await options.handlers.implementation(action, credentials, snapshot)
        : action.kind === 'repair-machine-child'
          ? options.handlers.repairMachineChild === undefined
            ? { status: 'skipped', detail: 'repair-machine-child handler unavailable' }
            : await options.handlers.repairMachineChild(action, credentials, snapshot)
          : action.kind === 'claim-review'
            ? await options.handlers.review(action, credentials, snapshot)
            : action.kind === 'file-reconcile-child'
              ? options.handlers.fileReconcileChild === undefined
                ? { status: 'skipped', detail: 'file-reconcile-child handler unavailable' }
                : await options.handlers.fileReconcileChild(action, credentials, snapshot)
              : action.kind === 'rerun-failed-checks'
                ? options.handlers.rerunFailedChecks === undefined
                  ? { status: 'skipped', detail: 'rerun-failed-checks handler unavailable' }
                  : await options.handlers.rerunFailedChecks(action, credentials, snapshot)
                : action.kind === 'file-ci-failure-child'
                  ? options.handlers.fileCiFailureChild === undefined
                    ? { status: 'skipped', detail: 'file-ci-failure-child handler unavailable' }
                    : await options.handlers.fileCiFailureChild(action, credentials, snapshot)
                  : action.kind === 'enqueue'
                    ? await options.handlers.enqueue(action, credentials, snapshot)
                    : {
                        status: 'skipped',
                        detail: `action ${(action as { kind: string }).kind} is not wired`,
                      };
      const detail = reason(result);
      return {
        outcome: result.status,
        ...(detail === undefined ? {} : { reason: detail }),
      };
    },
  };
}
