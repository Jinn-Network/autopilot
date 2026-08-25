import { DEFAULT_FLOOR } from '../dispatcher/rate-limit-guard.js';
import {
  deriveLifecycle,
  deriveOrphanImplementationState,
  engineApprovalLapsed,
} from './lifecycle.js';
import {
  planProjection,
  type OrphanBranchClaim,
  type ProjectionAction,
  type ProjectionContext,
} from './projection.js';
import {
  executeProjectionPlan,
  type ReconciliationReport,
  type ReconciliationWriter,
} from './reconciler.js';
import {
  LifecycleRateLimitError,
  type GitHubLifecycleSnapshot,
  type LifecycleParityDifference,
  type SnapshotReadMode,
} from './snapshot.js';
import { implementationClaimFingerprint } from './terminal-claim.js';
import {
  applyMergePolicy,
  scheduleActiveActions,
  type ActiveCandidate,
  type ActiveSchedulingSkip,
} from './active-scheduler.js';
import type { MergePolicy } from '../config/config.js';
import {
  childrenPathEnabled,
  isMachineChildIssue,
  parseChildMarker,
  resolveChildTriageExpectation,
} from './child-issues.js';
import { classifyCiChecks, isCiGreen } from './ci-classifier.js';
import { enqueuePathEnabled } from './enqueue-record.js';
import { chooseIntegrationLadderAction } from './integration-ladder.js';
import type {
  AutopilotMode,
  GitOid,
  HumanReason,
  IssueEligibilityReason,
  LifecycleMappingDiagnostic,
  LifecyclePhase,
  LifecycleSnapshot,
  LifecycleView,
  LifecycleViewItem,
  NewWorkAction,
  CompareStatus,
} from './types.js';
import { gitRefName } from './types.js';
import {
  EMPTY_GITHUB_USAGE,
  EXPECTED_ACCOUNTING_APPROXIMATION_PREFIX,
  type GitHubUsage,
} from './github-usage.js';
import { exactUtcTimestampMs } from './exact-utc-time.js';

export type LifecycleCliCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'explain-issue'; readonly number: number }
  | { readonly kind: 'explain-pr'; readonly number: number };

export interface LifecycleCliOptions {
  readonly mode: AutopilotMode;
  readonly once: boolean;
  readonly command: LifecycleCliCommand;
  readonly json: boolean;
  readonly fullReconcile: boolean;
}

export interface LifecycleControllerDeps {
  readSnapshot(rateLimitFloor?: number): Promise<GitHubLifecycleSnapshot>;
  /**
   * Optional allowlist fast path. A null result means no recent global cache
   * authority exists and the controller must keep its unrestricted behavior.
   */
  readScopedSnapshot?(
    issueNumbers: ReadonlySet<number>,
    rateLimitFloor: number,
  ): Promise<GitHubLifecycleSnapshot | null>;
  /**
   * Optional end-of-cycle GraphQL remaining probe. When set, the cycle report
   * includes `budget.pointsSpent` (start remaining − end remaining).
   */
  readRateLimitRemaining?(): Promise<number>;
  /** Reset/read the shared meter at cycle boundaries and report completion. */
  readonly resetGitHubUsage?: () => void;
  readonly readGitHubUsage?: () => GitHubUsage;
  /**
   * Replays durable prepared marketplace attempts before any new snapshot,
   * reconciliation, or claim work. Active capability preflight runs first.
   */
  readonly recoverMarketplaceAttempts?: () => Promise<void>;
  readonly recoverPreparedMarketplaceSubmissions?: () => Promise<void>;
  readonly recoverSubmittedMarketplaceAdoptions?: () => Promise<void>;
  readonly onLifecyclePhase?: (phase: string) => void;
  readonly writer?: ReconciliationWriter;
  readonly writerForSnapshot?: (snapshot: GitHubLifecycleSnapshot) => ReconciliationWriter;
  readonly now: () => Date;
  readonly staleAfterMs: number;
  readonly runnerId: string;
  readonly cycleId: () => string;
  readonly rateLimitFloor?: number;
  /** Persistent runners report pre-mutation snapshot failures and retry next cadence. */
  readonly snapshotFailureMode?: 'throw' | 'report';
  /**
   * The temporary internal default remains safe-auto until the Jinn consumer
   * configuration lands. Every product entry point supplies this explicitly,
   * and initialization writes manual.
   */
  readonly mergePolicy?: MergePolicy;
  readonly active?: {
    preflight(): Promise<{ readonly ok: boolean; readonly detail?: string }>;
    readLocalState(): {
      readonly remaining: {
        readonly implementation: number;
        readonly review: number;
      };
      readonly newWorkPaused: boolean;
      readonly availableLogins: readonly string[];
      readonly implementationPreferredLogin: string;
    };
    readonly implementationBackpressureThreshold: number;
    /**
     * jinn-mono#1883: canary safety knob (`JINN_AUTOPILOT_ONLY_ISSUES`).
     * `undefined` means unrestricted — exactly current behavior. When set,
     * `runLifecycleCycle` restricts NEW-WORK claim scheduling (implement,
     * review, merge candidates) to issue numbers in this set.
     * It does not affect reconciliation/projection of existing items,
     * Human-overlay handling, or observe/recover output — those all run
     * unfiltered before this is consulted. Board archive lives in the
     * scheduled painter (Stage 3), not the cycle.
     */
    readonly onlyIssues?: ReadonlySet<number>;
    executeAction(
      action: NewWorkAction,
      snapshot: GitHubLifecycleSnapshot,
    ): Promise<{ readonly outcome: string; readonly reason?: string }>;
    executeReviewActions?(
      actions: readonly Extract<NewWorkAction, { kind: 'claim-review' }>[],
      snapshot: GitHubLifecycleSnapshot,
    ): Promise<readonly { readonly outcome: string; readonly reason?: string }[]>;
  };
}

export interface LifecycleStatusItem {
  readonly phase: LifecyclePhase;
  readonly underlyingPhase?: Exclude<LifecyclePhase, 'human'>;
  readonly issueNumber: number;
  readonly prNumber?: number;
  readonly head?: GitOid;
  readonly claimGeneration?: string;
  readonly progressAgeMs?: number;
  readonly stale: boolean;
  readonly legacy: boolean;
  readonly humanReason?: HumanReason;
  readonly eligible?: boolean;
  readonly eligibilityReason?: IssueEligibilityReason;
  readonly eligibilityDetail?: string;
  /**
   * The pull request is proven to be sitting in GitHub's merge queue. Absent
   * means *not proven queued*, never "proven not queued", so the operator-facing
   * explanation says "ready to be enqueued" rather than asserting it is not.
   */
  readonly inMergeQueue?: boolean;
  /**
   * Kill switches that are *engaged* this cycle and would withhold the enqueue
   * of a merge-ready pull request. Empty is the ordinary case and says exactly
   * that: nothing is holding it back. Naming a switch that is not engaged reads
   * to an operator as the reason their PR has not moved, which is the one thing
   * the explanation must never invent.
   */
  readonly enqueueHolds?: readonly EnqueueHold[];
  readonly desiredActions: readonly ProjectionAction[];
}

export type EnqueueHold = 'enqueue-path-disarmed' | 'manual-merge-policy';

export interface LifecycleOrphanBranchClaimStatus {
  readonly kind: 'orphan-branch-claim';
  readonly phase: 'implementing' | 'awaiting-review' | 'human';
  readonly underlyingPhase?: 'implementing' | 'awaiting-review';
  readonly issueNumber: number;
  readonly head: GitOid;
  readonly headRefName: string;
  readonly claimGeneration: string;
  readonly claimAttempt: string;
  readonly claimRunner: string;
  readonly progressAgeMs?: number;
  readonly stale: boolean;
  readonly staleSince?: string;
  readonly staleReason?: 'branch-head-unchanged';
  readonly v2Marked: true;
  readonly humanHold: boolean;
  readonly humanReason?: HumanReason;
  readonly desiredActions: readonly ProjectionAction[];
}

export interface LifecycleStatusDiagnostic extends LifecycleMappingDiagnostic {
  readonly phase: 'human';
  readonly desiredActions: readonly ProjectionAction[];
}

export interface LifecycleLogEvent {
  readonly cycleId: string;
  readonly runnerId: string;
  readonly mode: AutopilotMode;
  readonly phase: LifecyclePhase;
  readonly subject: string;
  readonly head?: GitOid;
  readonly action: string;
  readonly outcome: string;
  readonly reason?: string;
}

type LifecycleFailedUsage =
  | {
      readonly usageAccounting: { readonly complete: true };
      readonly githubUsage: GitHubUsage;
    }
  | {
      readonly usageAccounting: {
        readonly complete: false;
        readonly reason: string;
      };
      readonly githubUsage?: never;
    };

type LifecycleFailedReport = {
  readonly status: 'failed';
  readonly mode: AutopilotMode;
  readonly message: string;
  readonly mutationFree: boolean;
  readonly items: readonly LifecycleStatusItem[];
  readonly orphanBranchClaims: readonly LifecycleOrphanBranchClaimStatus[];
  readonly diagnostics: readonly LifecycleStatusDiagnostic[];
  readonly events: readonly LifecycleLogEvent[];
  readonly reconciliation?: ReconciliationReport;
} & LifecycleFailedUsage;

export type LifecycleCycleReport =
  | {
      readonly status: 'rejected';
      readonly mode: AutopilotMode;
      readonly message: string;
      readonly githubUsage: GitHubUsage;
      readonly items: readonly [];
      readonly orphanBranchClaims: readonly [];
      readonly diagnostics: readonly [];
      readonly events: readonly [];
    }
  | {
      readonly status: 'rate-limited';
      readonly mode: AutopilotMode;
      readonly message: string;
      readonly githubUsage: GitHubUsage;
      readonly items: readonly [];
      readonly orphanBranchClaims: readonly [];
      readonly diagnostics: readonly [];
      readonly events: readonly [];
    }
  | LifecycleFailedReport
  | {
      readonly status: 'ok';
      readonly mode: AutopilotMode;
      readonly cycleId: string;
      readonly runnerId: string;
      readonly capturedAt: string;
      readonly snapshotMode: SnapshotReadMode;
      readonly snapshotComplete: boolean;
      readonly lastFullReconciliationAt: string | null;
      readonly partialReason?: string;
      readonly snapshotWarning?: string;
      readonly parityDifferences?: readonly LifecycleParityDifference[];
      readonly parityUnavailableReason?: string;
      readonly githubUsage: GitHubUsage;
      readonly items: readonly LifecycleStatusItem[];
      readonly orphanBranchClaims: readonly LifecycleOrphanBranchClaimStatus[];
      readonly diagnostics: readonly LifecycleStatusDiagnostic[];
      readonly events: readonly LifecycleLogEvent[];
      readonly reconciliation?: ReconciliationReport;
      /** Stage 4: GraphQL points spent this cycle (start remaining − end). */
      readonly budget?: {
        readonly remainingStart: number;
        readonly remainingEnd: number;
        readonly pointsSpent: number;
      };
    };

function snapshotReportMetadata(snapshot: GitHubLifecycleSnapshot): {
  readonly snapshotMode: SnapshotReadMode;
  readonly snapshotComplete: boolean;
  readonly lastFullReconciliationAt: string | null;
  readonly partialReason?: string;
  readonly snapshotWarning?: string;
  readonly parityDifferences?: readonly LifecycleParityDifference[];
  readonly parityUnavailableReason?: string;
} {
  return {
    snapshotMode: snapshot.snapshotMode ?? 'full',
    snapshotComplete: snapshot.snapshotComplete ?? false,
    lastFullReconciliationAt: snapshot.lastFullReconciliationAt ?? null,
    ...(snapshot.partialReason === undefined ? {} : { partialReason: snapshot.partialReason }),
    ...(snapshot.snapshotWarning === undefined
      ? {}
      : { snapshotWarning: snapshot.snapshotWarning }),
    ...(snapshot.parityDifferences === undefined
      ? {}
      : { parityDifferences: snapshot.parityDifferences }),
    ...(snapshot.parityUnavailableReason === undefined
      ? {}
      : { parityUnavailableReason: snapshot.parityUnavailableReason }),
  };
}

function finalGitHubUsage(
  deps: LifecycleControllerDeps,
  snapshot?: GitHubLifecycleSnapshot,
): GitHubUsage {
  return deps.readGitHubUsage?.() ?? snapshot?.githubUsage ?? EMPTY_GITHUB_USAGE;
}

function failedCycleGitHubUsage(deps: LifecycleControllerDeps): GitHubUsage {
  if (deps.readGitHubUsage === undefined) {
    throw new Error('GitHub cycle usage meter is unavailable after snapshot failure');
  }
  return deps.readGitHubUsage();
}

function failedAfterScopedPreDispatch(
  mode: AutopilotMode,
  deps: LifecycleControllerDeps,
  scopedPass: ActivePassResult,
  message: string,
): LifecycleFailedReport {
  const failed = {
    status: 'failed' as const,
    mode,
    message,
    mutationFree: false,
    items: scopedPass.items,
    orphanBranchClaims: scopedPass.orphanBranchClaims,
    diagnostics: scopedPass.diagnostics,
    events: scopedPass.events,
    reconciliation: scopedPass.reconciliation,
  };
  try {
    return {
      ...failed,
      usageAccounting: { complete: true },
      githubUsage: failedCycleGitHubUsage(deps),
    };
  } catch (error) {
    return {
      ...failed,
      usageAccounting: {
        complete: false,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function positiveNumber(raw: string | undefined, label: string): number {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) throw new Error(`Invalid ${label}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${label}`);
  return value;
}

export function parseLifecycleCli(args: readonly string[]): LifecycleCliOptions {
  let mode: AutopilotMode = 'observe';
  let once = false;
  let dryRun = false;
  let json = false;
  let fullReconcile = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--once') {
      once = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--full-reconcile') {
      fullReconcile = true;
      once = true;
    } else if (arg === '--mode') {
      const value = args[index + 1];
      if (value !== 'observe' && value !== 'recover' && value !== 'active') {
        throw new Error('Invalid lifecycle mode');
      }
      mode = value;
      index += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown lifecycle option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (dryRun) {
    mode = 'observe';
    once = true;
  }
  if (fullReconcile && mode !== 'observe') {
    throw new Error('--full-reconcile is an authoritative observe-only read');
  }
  let command: LifecycleCliCommand = { kind: 'status' };
  if (positional.length === 1 && (positional[0] === 'status' || positional[0] === 'sessions')) {
    // Both names intentionally render the same GitHub-derived lifecycle view.
  } else if (positional.length > 0) {
    if (positional[0] !== 'explain' || positional.length !== 3) {
      throw new Error('Expected status, sessions, explain issue <N>, or explain pr <N>');
    }
    if (positional[1] === 'issue') {
      command = { kind: 'explain-issue', number: positiveNumber(positional[2], 'issue number') };
    } else if (positional[1] === 'pr') {
      command = { kind: 'explain-pr', number: positiveNumber(positional[2], 'PR number') };
    } else {
      throw new Error('Expected explain issue <N> or explain pr <N>');
    }
  }
  return { mode, once, command, json, fullReconcile };
}

function projectionContext(
  snapshot: GitHubLifecycleSnapshot,
  view: ReturnType<typeof deriveLifecycle>,
  now: Date,
  staleAfterMs: number,
): ProjectionContext {
  const liveIssues = new Set(snapshot.issues.map((issue) => issue.number));
  const prBranches = new Set(snapshot.pullRequests.map((pr) => pr.headRefName));
  const ambiguousIssues = new Set(snapshot.diagnostics.flatMap((diagnostic) => (
    diagnostic.issueNumbers
  )));
  const terminalIssues = new Set<number>([
    ...snapshot.project.items
      .filter((item) => item.contentType === 'Issue' && item.status === 'Done')
      .map((item) => item.number),
    ...view.items
      .filter((item) => item.item.kind === 'pull-request' && item.phase === 'merged')
      .map((item) => item.item.issueNumber),
    ...snapshot.pullRequests
      .filter((pr) => pr.state === 'MERGED')
      .flatMap((pr) => pr.closingIssueNumbers),
  ]);
  const terminalClaims = snapshot.terminalClaims ?? [];
  const orphanBranchClaims: OrphanBranchClaim[] = snapshot.branches
    .filter((branch) => {
      const claim = branch.claim;
      return claim.phase === 'implement'
        && liveIssues.has(branch.issueNumber)
        && !prBranches.has(branch.headRefName)
        && !ambiguousIssues.has(branch.issueNumber)
        && !terminalIssues.has(branch.issueNumber)
        && !terminalClaims.some((terminal) => (
          terminal.issueNumber === branch.issueNumber
          && terminal.prNumber === claim.prNumber
          && terminal.headRefName === branch.headRefName
          && terminal.headOid === branch.headOid
          && terminal.claimAttempt === claim.attempt
          && terminal.targetBase === claim.targetBase
          && implementationClaimFingerprint(claim) === terminal.claimFingerprint
        ));
    })
    .map((branch) => {
      const projectIssue = snapshot.project.items.find((item) => (
        item.contentType === 'Issue' && item.number === branch.issueNumber
      ));
      const lifecycleIssue = snapshot.lifecycle.items.find((item) => (
        item.kind === 'issue' && item.issueNumber === branch.issueNumber
      ));
      const humanHold = projectIssue?.blockedOn === 'Human'
        || lifecycleIssue?.humanHold === true
        || lifecycleIssue?.labels.includes('review:needs-human') === true
        || lifecycleIssue?.labels.includes('autopilot:human') === true;
      const issueHumanReason = lifecycleIssue?.humanReason;
      const humanReason: HumanReason | undefined = issueHumanReason !== undefined
        ? issueHumanReason.phase === 'eligible'
          ? { ...issueHumanReason, phase: 'implementing' }
          : issueHumanReason
        : humanHold
          ? {
              phase: 'implementing' as const,
              code: 'implementation-escalation' as const,
              detail: projectIssue?.blockedOn === 'Human'
                ? 'Project Blocked on: Human'
                : lifecycleIssue?.labels.includes('autopilot:human') === true
                  ? 'Issue label: autopilot:human'
                  : 'Issue label: review:needs-human',
            }
          : undefined;
      const state = deriveOrphanImplementationState({
        headChangedAt: branch.headCommittedAt,
        phaseComplete: branch.claim.phaseComplete === true,
        humanHold,
        ...(humanReason === undefined ? {} : { humanReason }),
      }, now, staleAfterMs);
      return {
        issueNumber: branch.issueNumber,
        head: branch.headOid,
        headRefName: branch.headRefName,
        headChangedAt: branch.headCommittedAt,
        baseRefName: branch.claim.targetBase,
        claimAttempt: branch.claim.attempt,
        claimRunner: branch.claim.runner,
        projectStatus: projectIssue?.status ?? null,
        ...state,
        ...(humanHold ? { humanHold: true } : {}),
      };
    });
  return {
    view,
    snapshotComplete: snapshot.snapshotComplete === true,
    pullRequests: snapshot.pullRequests.map((pr) => ({
      number: pr.number,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      ...((() => {
        const mapping = snapshot.pullRequestMappings?.find((candidate) => (
          candidate.prNumber === pr.number && candidate.status === 'resolved'
        ));
        return mapping?.status === 'resolved'
          ? { resolvedIssueNumber: mapping.issueNumber }
          : {};
      })()),
      ...((() => {
        const markers = [...pr.body.matchAll(
          /<!-- jinn-autopilot:v2 issue=([1-9][0-9]*) branch=([^ >]+) -->/g,
        )].filter((match) => match[2] === pr.headRefName);
        return markers.length === 1
          ? { scheduledIssueNumber: Number(markers[0]![1]) }
          : {};
      })()),
      ...(pr.reviewClaim === undefined ? {} : { reviewRefOid: pr.reviewClaim.oid }),
      ...(pr.reviewClaim === undefined
        ? {}
        : {
            reviewClaim: {
              head: pr.reviewClaim.record.head,
              generation: pr.reviewClaim.record.generation,
              state: pr.reviewClaim.record.state,
              ...('mappingRequest' in pr.reviewClaim.record
                ? { mappingRequest: pr.reviewClaim.record.mappingRequest }
                : {}),
              ...('mappingDiagnostic' in pr.reviewClaim.record
                && pr.reviewClaim.record.mappingDiagnostic !== undefined
                ? { mappingDiagnostic: pr.reviewClaim.record.mappingDiagnostic }
                : {}),
            },
          }),
    })),
    orphanBranchClaims,
    mappingDiagnostics: snapshot.diagnostics,
  };
}

function actionMatchesView(action: ProjectionAction, view: LifecycleViewItem): boolean {
  if ('prNumber' in action && view.item.kind === 'pull-request') {
    return action.prNumber === view.item.prNumber;
  }
  return 'issueNumber' in action && action.issueNumber === view.item.issueNumber;
}

function progressAge(view: LifecycleViewItem, now: Date): number | undefined {
  if (view.item.kind !== 'pull-request') return undefined;
  const item = view.item;
  const headAt = Date.parse(item.headChangedAt);
  if (!Number.isFinite(headAt)) return undefined;
  let progressAt = headAt;
  const claim = item.reviewClaim;
  const verdict = item.terminalVerdict;
  if (
    claim?.verdict !== undefined
    && claim.head === item.head
    && verdict !== undefined
    && verdict.head === item.head
    && verdict.marker === claim.verdict.marker
    && verdict.state === claim.verdict.state
  ) {
    const verdictAt = Date.parse(verdict.recordedAt);
    if (Number.isFinite(verdictAt) && verdictAt <= now.getTime() && verdictAt > progressAt) {
      progressAt = verdictAt;
    }
  }
  return Math.max(0, now.getTime() - progressAt);
}

/**
 * The switches that withhold an enqueue, read as they actually stand right now.
 * Both are read once per cycle, next to each other, so the operator-facing
 * explanation and the scheduler cannot disagree about which is engaged.
 */
function engagedEnqueueHolds(
  mergePolicy: MergePolicy | undefined,
): readonly EnqueueHold[] {
  return [
    ...(enqueuePathEnabled() ? [] : ['enqueue-path-disarmed' as const]),
    ...((mergePolicy ?? 'manual') === 'manual' ? ['manual-merge-policy' as const] : []),
  ];
}

function statusItems(
  view: ReturnType<typeof deriveLifecycle>,
  actions: readonly ProjectionAction[],
  now: Date,
  orphanBranchClaims: readonly OrphanBranchClaim[],
  enqueueHolds: readonly EnqueueHold[] = [],
): LifecycleStatusItem[] {
  const orphanIssues = new Set(orphanBranchClaims.map((claim) => claim.issueNumber));
  return view.items
    .filter((entry) => !orphanIssues.has(entry.item.issueNumber))
    .map((entry): LifecycleStatusItem => {
      const item = entry.item;
      const claimGeneration = item.kind === 'pull-request'
        ? item.reviewClaim?.generation ?? item.branchClaim?.attempt
        : undefined;
      const age = progressAge(entry, now);
      return {
        phase: entry.phase,
        ...(entry.underlyingPhase === undefined ? {} : { underlyingPhase: entry.underlyingPhase }),
        issueNumber: item.issueNumber,
        ...(item.kind === 'pull-request'
          ? {
              prNumber: item.prNumber,
              head: item.head,
              ...(item.inMergeQueue === true ? { inMergeQueue: true } : {}),
              ...(enqueueHolds.length === 0 ? {} : { enqueueHolds }),
            }
          : {}),
        ...(claimGeneration === undefined ? {} : { claimGeneration }),
        ...(age === undefined ? {} : { progressAgeMs: age }),
        stale: entry.stale,
        legacy: !item.v2Marked,
        ...(entry.humanReason === undefined ? {} : { humanReason: entry.humanReason }),
        ...(item.kind === 'issue'
          ? {
              eligible: item.eligible,
              ...(item.eligibilityReason === undefined
                ? {}
                : { eligibilityReason: item.eligibilityReason }),
              ...(item.eligibilityDetail === undefined
                ? {}
                : { eligibilityDetail: item.eligibilityDetail }),
            }
          : {}),
        desiredActions: actions.filter((action) => actionMatchesView(action, entry)),
      };
    });
}

function orphanStatusItems(
  claims: readonly OrphanBranchClaim[],
  actions: readonly ProjectionAction[],
): LifecycleOrphanBranchClaimStatus[] {
  return claims.map((claim): LifecycleOrphanBranchClaimStatus => {
    return {
      kind: 'orphan-branch-claim',
      phase: claim.phase,
      ...(claim.underlyingPhase === undefined
        ? {}
        : { underlyingPhase: claim.underlyingPhase }),
      issueNumber: claim.issueNumber,
      head: claim.head,
      headRefName: claim.headRefName,
      claimGeneration: claim.claimAttempt,
      claimAttempt: claim.claimAttempt,
      claimRunner: claim.claimRunner,
      ...(claim.progressAgeMs === undefined ? {} : { progressAgeMs: claim.progressAgeMs }),
      stale: claim.stale,
      ...(claim.staleSince === undefined ? {} : { staleSince: claim.staleSince }),
      ...(claim.staleReason === undefined ? {} : { staleReason: claim.staleReason }),
      v2Marked: true,
      humanHold: claim.phase === 'human',
      ...(claim.humanReason === undefined ? {} : { humanReason: claim.humanReason }),
      desiredActions: actions.filter((action) => (
        'issueNumber' in action && action.issueNumber === claim.issueNumber
      )),
    };
  });
}

function eventFor(
  result: ReconciliationReport['results'][number],
  items: readonly LifecycleStatusItem[],
  orphanBranchClaims: readonly LifecycleOrphanBranchClaimStatus[],
  diagnostics: readonly LifecycleStatusDiagnostic[],
  cycleId: string,
  runnerId: string,
  mode: 'recover' | 'active',
): LifecycleLogEvent {
  const action = result.action;
  const item = items.find((candidate) => (
    ('prNumber' in action && candidate.prNumber === action.prNumber)
    || ('issueNumber' in action && candidate.issueNumber === action.issueNumber)
  ));
  const orphan = orphanBranchClaims.find((candidate) => (
    'issueNumber' in action && action.issueNumber === candidate.issueNumber
  ));
  const issue = 'issueNumber' in action
    ? action.issueNumber
    : item?.issueNumber ?? orphan?.issueNumber;
  const pr = 'prNumber' in action ? action.prNumber : item?.prNumber;
  const diagnostic = diagnostics.find((candidate) => (
    (issue !== undefined && candidate.issueNumbers.includes(issue))
    || (pr !== undefined && candidate.pullRequests.some((candidatePr) => candidatePr.number === pr))
  ));
  return {
    cycleId,
    runnerId,
    mode,
    phase: item?.phase ?? orphan?.phase ?? diagnostic?.phase ?? 'eligible',
    subject: [
      issue === undefined ? null : `issue:${issue}`,
      pr === undefined ? null : `pr:${pr}`,
    ].filter((value): value is string => value !== null).join('/'),
    ...('expectedHead' in action ? { head: action.expectedHead } : {}),
    action: action.kind,
    outcome: result.outcome,
    ...(result.detail === undefined ? {} : { reason: logSafeReason(result.detail) }),
  };
}

function activeCandidates(
  snapshot: GitHubLifecycleSnapshot,
  view: ReturnType<typeof deriveLifecycle>,
): ActiveCandidate[] {
  const byPr = new Map(snapshot.pullRequests.map((pr) => [pr.number, pr]));
  const repair: ActiveCandidate[] = [];
  const repairingIssues = new Set<number>();
  for (const issue of snapshot.issues) {
    const marker = parseChildMarker(issue.body ?? '');
    if (marker === null) continue;
    const expected = resolveChildTriageExpectation(issue.body ?? '', marker.kind);
    if (expected === null) continue;
    const needsRepair = (
      !issue.onBoard
      || issue.projectItemId === null
      || issue.shape !== expected.issueType
      || issue.blockedOn !== 'Nothing'
      || issue.effort?.toLowerCase() !== expected.effort
      || issue.priority?.toLowerCase() !== expected.priority
    );
    if (!needsRepair) continue;
    repair.push({
      phase: 'repair-machine-child',
      issueNumber: issue.number,
      parentPr: marker.parentPr,
      childKind: marker.kind,
      expectedType: expected.issueType,
      expectedEffort: expected.effort,
      expectedPriority: expected.priority,
    });
    repairingIssues.add(issue.number);
  }
  const childImplementation: ActiveCandidate[] = [];
  const freshImplementation: ActiveCandidate[] = [];
  const other: ActiveCandidate[] = [];
  // Read once per cycle, next to the children knob it sits beside. Disarming
  // it leaves derivation untouched — a merge-ready PR still reads as
  // merge-ready — and only withholds the mutation.
  const enqueueOn = enqueuePathEnabled();
  for (const entry of view.items) {
    const item = entry.item;
    if (
      entry.phase === 'eligible'
      && item.kind === 'issue'
      && item.eligible
      && !item.humanHold
      && !repairingIssues.has(item.issueNumber)
    ) {
      const issueSource = snapshot.issues.find((candidate) =>
        candidate.number === item.issueNumber);
      const isChild = isMachineChildIssue({
        body: issueSource?.body,
        labels: item.labels,
      });
      (isChild ? childImplementation : freshImplementation).push({
        phase: 'implementation',
        intent: 'fresh',
        issueNumber: item.issueNumber,
        ...(isChild ? { isChild: true } : {}),
      });
      continue;
    }
    if (item.kind !== 'pull-request' || item.humanHold || item.merged) continue;
    const pr = byPr.get(item.prNumber);
    if (pr === undefined) continue;
    if (pr.evidenceIncompleteReason !== undefined) continue;
    const compareStatus: CompareStatus = pr.compareStatus ?? (
      item.mergeState === 'behind'
        ? 'behind'
        : item.mergeState === 'conflict'
          ? 'diverged'
          : item.mergeState === 'clean'
            ? 'ahead'
            : 'unknown'
    );
    if (
      entry.phase === 'implementing'
      && entry.stale
      && item.isDraft
      && item.branchClaim?.phase === 'implement'
      && item.branchClaim.phaseComplete !== true
    ) {
      const pullRequest = byPr.get(item.prNumber);
      if (pullRequest === undefined) continue;
      freshImplementation.push({
        phase: 'implementation',
        intent: 'stale-recovery',
        issueNumber: item.issueNumber,
        prNumber: item.prNumber,
        expectedHead: item.head,
        branch: gitRefName(pullRequest.headRefName),
        claimAttempt: item.branchClaim.attempt,
      });
    } else if (
      entry.phase === 'awaiting-review'
      && item.isDraft
      && item.reviewClaim?.head === item.head
      && item.reviewClaim.state === 'stale'
    ) {
      other.push({
        phase: 'review',
        issueNumber: item.issueNumber,
        prNumber: item.prNumber,
        head: item.head,
        author: pr.author,
      });
    } else if (
      // DELIVERED → IN REVIEW (single-surface §4): a non-draft PR that still
      // needs a verdict and has no active review claim for its head must be
      // enrolled for a fresh review. Mirrors reviewEnrollmentEligible's
      // non-draft branch; the awaiting-review phase already excludes PRs with
      // an active claim for the current head (those derive to `reviewing`).
      entry.phase === 'awaiting-review'
      && !item.isDraft
      && item.needsReview
      && !item.approved
    ) {
      other.push({
        phase: 'review',
        issueNumber: item.issueNumber,
        prNumber: item.prNumber,
        head: item.head,
        author: pr.author,
      });
    } else if (
      // Conflict only. A behind or diverged head used to land here for an
      // `update-branch`; the merge queue rebases its own candidate onto the
      // base before it tests it, so moving the PR head is work GitHub already
      // does — and doing it here cost a re-review every time, because
      // update-branch mints a new head under the engine's signed approval.
      // What the queue genuinely cannot do is merge a head that conflicts, and
      // that is the one case the reconcile child still owns.
      (entry.phase === 'awaiting-review' || entry.phase === 'merge-ready')
      && item.approved
      && !item.needsReview
      && item.mergeState === 'conflict'
      && !(item.openChildKinds ?? []).includes('reconcile')
    ) {
      const childrenOn = childrenPathEnabled();
      const ciGreen = isCiGreen(pr.checks);
      const ladder = chooseIntegrationLadderAction({
        approved: true,
        ciGreen,
        draft: item.isDraft,
        humanHold: false,
        mergeable: pr.mergeability,
        mergeStateStatus: pr.mergeStateStatus,
        compareStatus,
        openReconcileChild: (item.openChildKinds ?? []).includes('reconcile'),
        openFindingChild: (item.openChildKinds ?? []).includes('review-finding'),
        childrenEnabled: childrenOn,
      });
      if (ladder.kind === 'file-reconcile-child') {
        if (item.expectedBaseRefName === undefined) continue;
        other.push({
          phase: 'file-reconcile-child',
          issueNumber: item.issueNumber,
          prNumber: item.prNumber,
          head: item.head,
          expectedBaseRefName: gitRefName(item.expectedBaseRefName),
          effort: ladder.effort,
        });
      }
    } else if (
      // Re-review after the ladder moved the head under the approval. GitHub's
      // update-branch merges the base into the PR branch and re-points the
      // prior APPROVED review onto the new merge commit, so `approved` stays
      // true while the engine's signed approval is still bound to the old sha.
      // The merge gate refuses that forever (`terminal-approval`), so the head
      // must be reviewed again. Ordered AFTER the integration ladder branch on
      // purpose: while the PR is behind or conflicted the ladder still owns the
      // next mutation, otherwise a re-review would only be invalidated again by
      // the update-branch that follows it.
      entry.phase === 'awaiting-review'
      && !item.isDraft
      && engineApprovalLapsed(item)
    ) {
      other.push({
        phase: 'review',
        issueNumber: item.issueNumber,
        prNumber: item.prNumber,
        head: item.head,
        author: pr.author,
      });
    } else if (entry.phase === 'ci-blocked') {
      const classification = classifyCiChecks(pr.checks);
      if (classification.state === 'failed') {
        const rerunRecorded = item.ciRerunRecorded === true;
        if (!rerunRecorded && classification.rerunnableRunIds.length > 0) {
          other.push({
            phase: 'rerun-failed-checks',
            issueNumber: item.issueNumber,
            prNumber: item.prNumber,
            head: item.head,
          });
        } else {
          other.push({
            phase: 'file-ci-failure-child',
            issueNumber: item.issueNumber,
            prNumber: item.prNumber,
            head: item.head,
          });
        }
      }
    } else if (entry.phase === 'merge-ready') {
      if (!enqueueOn) continue;
      if (item.expectedBaseRefName === undefined) continue;
      // Proven queued — from either authority the snapshot carries. Absence is
      // never proof of the opposite, so only a positive reading suppresses the
      // action; an unreadable membership falls through to an enqueue the
      // executor re-checks against GitHub before it mutates.
      if (item.inMergeQueue === true || pr.mergeQueue?.enqueued === true) continue;
      other.push({
        phase: 'enqueue',
        issueNumber: item.issueNumber,
        prNumber: item.prNumber,
        head: item.head,
        expectedBaseRefName: gitRefName(item.expectedBaseRefName),
      });
    } else if (entry.phase === 'blocked-by-child') {
      // No new work while a child is open or head-bound RC stands; child
      // implementation claims are scheduled from the child issue itself.
    }
  }
  // Children outrank fresh implementation claims for the remaining slots.
  return [...repair, ...childImplementation, ...freshImplementation, ...other];
}

/**
 * Reconcile the lifecycle projection against the pull-request facts the
 * scheduler and the operator-facing explanation both depend on, so a stale or
 * custom projection cannot disagree with evidence the same snapshot carries.
 *
 * Keeps the scheduler fail-closed if such a projection retained GraphQL's
 * false-clean state after exact REST compare evidence was already captured.
 *
 * Conflict outranks the compare status and is never overwritten. A diverged
 * compare and a CONFLICTING mergeability describe the same PR from two angles,
 * and only one of them is disqualifying: the merge queue rebases a diverged
 * head happily and cannot merge a conflicting one at all. Downgrading conflict
 * to `behind` here would derive that PR as merge-ready and feed it to the
 * queue, which is precisely the enqueue this stage must refuse.
 */
function lifecycleWithExactCompareEvidence(
  snapshot: GitHubLifecycleSnapshot,
): LifecycleSnapshot {
  const byPr = new Map(snapshot.pullRequests.map((pr) => [pr.number, pr]));
  return {
    items: snapshot.lifecycle.items.map((item) => {
      if (item.kind !== 'pull-request') return item;
      const pr = byPr.get(item.prNumber);
      // Membership is only ever added, never cleared: absence is "not proven
      // queued", and overwriting a projected `true` with an unread `false`
      // would license a second enqueue at a head already in line.
      const queued = item.inMergeQueue === true || pr?.mergeQueue?.enqueued === true
        ? { inMergeQueue: true as const }
        : {};
      if (
        item.mergeState === 'conflict'
        || pr?.mergeability === 'CONFLICTING'
        || pr?.mergeStateStatus === 'DIRTY'
      ) {
        return { ...item, ...queued, mergeState: 'conflict' as const };
      }
      const compareStatus = pr?.compareStatus;
      if (compareStatus === 'behind' || compareStatus === 'diverged') {
        return { ...item, ...queued, mergeState: 'behind' as const };
      }
      if (compareStatus === 'unknown') {
        return { ...item, ...queued, mergeState: 'blocked' as const };
      }
      return { ...item, ...queued };
    }),
  };
}

function phaseForAction(action: NewWorkAction): LifecyclePhase {
  if (
    action.kind === 'claim-implementation'
    || action.kind === 'repair-machine-child'
  ) return 'eligible';
  if (action.kind === 'claim-review') return 'awaiting-review';
  if (action.kind === 'file-reconcile-child') return 'awaiting-review';
  if (action.kind === 'rerun-failed-checks' || action.kind === 'file-ci-failure-child') {
    return 'ci-blocked';
  }
  return 'merge-ready';
}

function subjectForAction(action: NewWorkAction): string {
  return action.kind === 'claim-implementation'
    ? `issue:${action.issueNumber}`
    : action.kind === 'repair-machine-child'
      ? `issue:${action.issueNumber}/pr:${action.parentPr}`
    : `issue:${action.issueNumber}/pr:${action.prNumber}`;
}

function phaseForSchedulingSkip(
  skip: Pick<ActiveSchedulingSkip, 'phase'>,
): LifecyclePhase {
  if (
    skip.phase === 'implementation'
    || skip.phase === 'repair-machine-child'
  ) return 'eligible';
  if (skip.phase === 'review') return 'awaiting-review';
  if (skip.phase === 'file-reconcile-child') return 'awaiting-review';
  if (
    skip.phase === 'rerun-failed-checks'
    || skip.phase === 'file-ci-failure-child'
  ) {
    return 'ci-blocked';
  }
  return 'merge-ready';
}

// Reconcile-before-claim is a per-item guarantee, not a whole-cycle gate: a
// projection action pending for issue/PR X (e.g. a correcting project-status
// write just attempted this cycle, or a permanently-unappliable action like
// a comment on a locked conversation) must defer a new claim for X, but must
// never suppress claim scheduling for an unrelated issue/PR Y. Derived from
// so an item whose reconciliation was just corrected this cycle still waits
// for a fresh snapshot next cycle before claiming — only the *scope* narrows
// from the whole cycle to the specific item.
//
// `ensure-implementation-summary` is excluded (jinn-mono#1883 follow-up): it
// is a benign, idempotent PR-body content sync (the writer no-ops once the
// body already matches) that is orthogonal to claiming — a review claim
// advances a dedicated ref, never the PR body. `implementationComplete &&
// item.implementationSummary !== undefined` is permanently true once
// implementation finishes, so without this exclusion the action is emitted
// every cycle for every finalized PR and its issue is blocked forever, so
// `claim-review` is never scheduled.
function blockedIssueNumbers(
  actions: readonly ProjectionAction[],
  view: LifecycleView,
): ReadonlySet<number> {
  const issueByPr = new Map<number, number>();
  for (const entry of view.items) {
    if (entry.item.kind === 'pull-request') {
      issueByPr.set(entry.item.prNumber, entry.item.issueNumber);
    }
  }
  const blocked = new Set<number>();
  for (const action of actions) {
    if (action.kind === 'ensure-implementation-summary') continue;
    if ('issueNumber' in action && action.issueNumber !== undefined) {
      blocked.add(action.issueNumber);
      continue;
    }
    if ('prNumber' in action) {
      const issueNumber = issueByPr.get(action.prNumber);
      if (issueNumber !== undefined) blocked.add(issueNumber);
    }
  }
  return blocked;
}

// jinn-mono#1883: `onlyIssues === undefined` is the unrestricted (default)
// state — matches unset/empty `JINN_AUTOPILOT_ONLY_ISSUES`. When it is set,
// a candidate is admitted only if its issue number is a member. Every
// `ActiveCandidate` variant carries a required `issueNumber` sourced from an
// already-resolved lifecycle item (ambiguous PR-to-issue mappings are
// diverted to diagnostics upstream and never reach `activeCandidates`), so
// `issueNumber` here is typed loosely (`number | undefined`) only to fail
// closed defensively if that invariant is ever broken.
export function matchesOnlyIssuesAllowlist(
  issueNumber: number | undefined,
  onlyIssues: ReadonlySet<number> | undefined,
): boolean {
  if (onlyIssues === undefined) return true;
  return issueNumber !== undefined && onlyIssues.has(issueNumber);
}

export const MAX_FULL_RECONCILIATION_AGE_MS = 2 * 60 * 60_000;

export function fullReconciliationAllowsNewClaims(
  lastFullReconciliationAt: string | null | undefined,
  now: Date,
): boolean {
  if (lastFullReconciliationAt === null || lastFullReconciliationAt === undefined) return false;
  const timestamp = exactUtcTimestampMs(lastFullReconciliationAt);
  if (timestamp === null) return false;
  const age = now.getTime() - timestamp;
  return age >= 0 && age <= MAX_FULL_RECONCILIATION_AGE_MS;
}

interface ActivePassResult {
  readonly items: readonly LifecycleStatusItem[];
  readonly orphanBranchClaims: readonly LifecycleOrphanBranchClaimStatus[];
  readonly diagnostics: readonly LifecycleStatusDiagnostic[];
  readonly events: readonly LifecycleLogEvent[];
  readonly reconciliation: ReconciliationReport;
}

async function executeActivePass(
  snapshot: GitHubLifecycleSnapshot,
  deps: LifecycleControllerDeps,
  cycleId: string,
  now: Date,
): Promise<ActivePassResult> {
  const view = deriveLifecycle(
    lifecycleWithExactCompareEvidence(snapshot),
    now,
    deps.staleAfterMs,
  );
  const context = projectionContext(snapshot, view, now, deps.staleAfterMs);
  const plan = planProjection(context);
  const items = statusItems(
    view,
    plan.actions,
    now,
    context.orphanBranchClaims,
    engagedEnqueueHolds(deps.mergePolicy),
  );
  const orphanBranchClaims = orphanStatusItems(
    context.orphanBranchClaims,
    plan.actions,
  );
  const diagnostics: LifecycleStatusDiagnostic[] = snapshot.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    phase: 'human',
    desiredActions: plan.actions.filter((action) => (
      ('prNumber' in action
        && diagnostic.pullRequests.some((pr) => pr.number === action.prNumber))
      || ('issueNumber' in action
        && action.issueNumber !== undefined
        && diagnostic.issueNumbers.includes(action.issueNumber))
    )),
  }));
  const writer = deps.writerForSnapshot?.(snapshot) ?? deps.writer!;
  const reconciliation = await executeProjectionPlan(plan, writer);
  const reconciliationEvents = reconciliation.results.map((result) => (
    eventFor(
      result,
      items,
      orphanBranchClaims,
      diagnostics,
      cycleId,
      deps.runnerId,
      'active',
    )
  ));
  const actionEvents: LifecycleLogEvent[] = [];
  const blockedIssues = blockedIssueNumbers(plan.actions, view);
  const local = deps.active!.readLocalState();
  const openPipelineBacklog = snapshot.snapshotAuthority === 'scoped'
    ? snapshot.globalOpenPipelineBacklog!
    : snapshot.pullRequests.filter((pr) => (
        pr.state === 'OPEN' && pr.labels.includes('engine:review')
      )).length;
  const candidates = applyMergePolicy(
    activeCandidates(snapshot, view),
    deps.mergePolicy ?? 'manual',
  ).filter((candidate) => (
    !blockedIssues.has(candidate.issueNumber)
    && matchesOnlyIssuesAllowlist(candidate.issueNumber, deps.active!.onlyIssues)
  ));
  const reconciliationFresh = fullReconciliationAllowsNewClaims(
    snapshot.lastFullReconciliationAt,
    now,
  );
  if (!reconciliationFresh) {
    actionEvents.push(...candidates.map((candidate): LifecycleLogEvent => ({
      cycleId,
      runnerId: deps.runnerId,
      mode: 'active',
      phase: phaseForSchedulingSkip(candidate),
      subject: candidate.phase === 'implementation'
        ? `issue:${candidate.issueNumber}`
        : candidate.phase === 'repair-machine-child'
          ? `issue:${candidate.issueNumber}/pr:${candidate.parentPr}`
        : `issue:${candidate.issueNumber}/pr:${candidate.prNumber}`,
      action: 'schedule',
      outcome: 'skipped',
      reason: 'full-reconciliation-stale',
    })));
  }
  const scheduling = scheduleActiveActions({
    candidates: reconciliationFresh ? candidates : [],
    remaining: local.remaining,
    availableLogins: local.availableLogins,
    implementationPreferredLogin: local.implementationPreferredLogin,
    openPipelineBacklog,
    implementationBackpressureThreshold:
      deps.active!.implementationBackpressureThreshold,
    ...(local.newWorkPaused ? { newWorkPaused: true } : {}),
  });
  actionEvents.push(...scheduling.skips.map((skip): LifecycleLogEvent => ({
    cycleId,
    runnerId: deps.runnerId,
    mode: 'active',
    phase: phaseForSchedulingSkip(skip),
    subject: skip.subject,
    action: 'schedule',
    outcome: 'skipped',
    reason: skip.reason,
  })));
  const actionEvent = (
    action: NewWorkAction,
    result: { readonly outcome: string; readonly reason?: string },
  ): LifecycleLogEvent => ({
    cycleId,
    runnerId: deps.runnerId,
    mode: 'active',
    phase: phaseForAction(action),
    subject: subjectForAction(action),
    ...('head' in action ? { head: action.head } : {}),
    action: action.kind,
    outcome: result.outcome,
    ...(result.reason === undefined ? {} : { reason: logSafeReason(result.reason) }),
  });
  for (let index = 0; index < scheduling.actions.length;) {
    const action = scheduling.actions[index]!;
    if (
      action.kind === 'claim-review'
      && deps.active!.executeReviewActions !== undefined
    ) {
      const cohort: Extract<NewWorkAction, { kind: 'claim-review' }>[] = [];
      while (scheduling.actions[index]?.kind === 'claim-review') {
        cohort.push(scheduling.actions[index] as Extract<
          NewWorkAction,
          { kind: 'claim-review' }
        >);
        index += 1;
      }
      try {
        const results = await deps.active!.executeReviewActions(cohort, snapshot);
        if (results.length !== cohort.length) {
          throw new Error('review cohort returned a result count different from its schedule');
        }
        actionEvents.push(...cohort.map((candidate, offset) => (
          actionEvent(candidate, results[offset]!)
        )));
      } catch (error) {
        actionEvents.push(...cohort.map((candidate) => actionEvent(candidate, {
          outcome: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        })));
      }
      continue;
    }
    try {
      const result = await deps.active!.executeAction(action, snapshot);
      actionEvents.push(actionEvent(action, result));
    } catch (error) {
      actionEvents.push(actionEvent(action, {
        outcome: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      }));
    }
    index += 1;
  }
  return {
    items,
    orphanBranchClaims,
    diagnostics,
    events: [...reconciliationEvents, ...actionEvents],
    reconciliation,
  };
}

export async function runLifecycleCycle(
  mode: AutopilotMode,
  deps: LifecycleControllerDeps,
): Promise<LifecycleCycleReport> {
  deps.resetGitHubUsage?.();
  const emitPhase = (phase: string): void => {
    deps.onLifecyclePhase?.(phase);
  };
  emitPhase('initialize');
  if (mode === 'active' && deps.active === undefined) {
    return {
      status: 'rejected',
      mode,
      message: 'active executor not configured',
      githubUsage: finalGitHubUsage(deps),
      items: [],
      orphanBranchClaims: [],
      diagnostics: [],
      events: [],
    };
  }
  if (
    (mode === 'recover' || mode === 'active')
    && deps.writer === undefined
    && deps.writerForSnapshot === undefined
  ) {
    return {
      status: 'rejected',
      mode,
      message: 'recover writer not configured',
      githubUsage: finalGitHubUsage(deps),
      items: [],
      orphanBranchClaims: [],
      diagnostics: [],
      events: [],
    };
  }
  if (mode === 'active') {
    const preflight = await deps.active!.preflight();
    if (!preflight.ok) {
      return {
        status: 'rejected',
        mode,
        message: `active capability preflight failed: ${
          preflight.detail ?? 'required capability is unverified'
        }`,
        githubUsage: finalGitHubUsage(deps),
        items: [],
        orphanBranchClaims: [],
        diagnostics: [],
        events: [],
      };
    }
  }
  if (mode === 'active' || mode === 'recover') {
    if (
      deps.recoverPreparedMarketplaceSubmissions !== undefined
      || deps.recoverSubmittedMarketplaceAdoptions !== undefined
    ) {
      if (deps.recoverPreparedMarketplaceSubmissions !== undefined) {
        emitPhase('recover-prepared-submissions');
        await deps.recoverPreparedMarketplaceSubmissions();
      }
      if (deps.recoverSubmittedMarketplaceAdoptions !== undefined) {
        emitPhase('recover-submitted-adoptions');
        await deps.recoverSubmittedMarketplaceAdoptions();
      }
    } else {
      await deps.recoverMarketplaceAttempts?.();
    }
  }
  const rateLimitFloor = Math.max(DEFAULT_FLOOR, deps.rateLimitFloor ?? DEFAULT_FLOOR);
  let scopedCycleId: string | undefined;
  const cycleIdForScopedPass = (): string => {
    scopedCycleId ??= deps.cycleId();
    return scopedCycleId;
  };
  let scopedPass: ActivePassResult | undefined;
  if (
    mode === 'active'
    && deps.active!.onlyIssues !== undefined
    && deps.active!.onlyIssues.size > 0
    && deps.readScopedSnapshot !== undefined
  ) {
    const scoped = await deps.readScopedSnapshot(
      deps.active!.onlyIssues,
      rateLimitFloor,
    );
    if (scoped !== null) {
      if (
        scoped.snapshotAuthority !== 'scoped'
        || scoped.snapshotComplete !== true
        || !Number.isSafeInteger(scoped.globalOpenPipelineBacklog)
        || scoped.globalOpenPipelineBacklog! < 0
        || scoped.githubUsage?.graphqlRemaining === null
        || scoped.githubUsage?.graphqlRemaining === undefined
        || scoped.githubUsage.graphqlRemaining < rateLimitFloor
      ) {
        throw new Error('Scoped pre-dispatch source returned non-authoritative evidence');
      }
      scopedPass = await executeActivePass(
        scoped,
        deps,
        cycleIdForScopedPass(),
        deps.now(),
      );
    }
  }
  let snapshot: GitHubLifecycleSnapshot;
  try {
    emitPhase('read-snapshot');
    snapshot = await deps.readSnapshot(rateLimitFloor);
  } catch (error) {
    if (scopedPass !== undefined) {
      return failedAfterScopedPreDispatch(
        mode,
        deps,
        scopedPass,
        `Global lifecycle snapshot failed after scoped pre-dispatch: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (error instanceof LifecycleRateLimitError) {
      return {
        status: 'rate-limited',
        mode,
        message: error.message,
        githubUsage: finalGitHubUsage(deps),
        items: [],
        orphanBranchClaims: [],
        diagnostics: [],
        events: [],
      };
    }
    if (deps.snapshotFailureMode === 'report') {
      const failed = {
        status: 'failed' as const,
        mode,
        message: `Lifecycle snapshot failed before mutations: ${
          error instanceof Error ? error.message : String(error)
        }`,
        mutationFree: true,
        items: [],
        orphanBranchClaims: [],
        diagnostics: [],
        events: [],
      };
      try {
        return {
          ...failed,
          usageAccounting: { complete: true as const },
          githubUsage: failedCycleGitHubUsage(deps),
        };
      } catch (usageError) {
        return {
          ...failed,
          usageAccounting: {
            complete: false as const,
            reason: usageError instanceof Error ? usageError.message : String(usageError),
          },
        };
      }
    }
    throw error;
  }
  if (snapshot.snapshotComplete !== true) {
    if (mode !== 'observe') {
      if (scopedPass !== undefined) {
        return failedAfterScopedPreDispatch(
          mode,
          deps,
          scopedPass,
          'Global lifecycle snapshot was incomplete after scoped pre-dispatch',
        );
      }
      return {
        status: 'rejected',
        mode,
        message: 'complete lifecycle snapshot is unavailable; mutations are suppressed',
        githubUsage: finalGitHubUsage(deps, snapshot),
        items: [],
        orphanBranchClaims: [],
        diagnostics: [],
        events: [],
      };
    }
    return {
      status: 'ok',
      mode,
      cycleId: deps.cycleId(),
      runnerId: deps.runnerId,
      capturedAt: snapshot.capturedAt,
      ...snapshotReportMetadata(snapshot),
      githubUsage: finalGitHubUsage(deps, snapshot),
      items: [],
      orphanBranchClaims: [],
      diagnostics: [],
      events: [],
    };
  }
  const graphqlRemaining = snapshot.githubUsage?.graphqlRemaining ?? null;
  if (graphqlRemaining === null || graphqlRemaining < rateLimitFloor) {
    if (scopedPass !== undefined) {
      return failedAfterScopedPreDispatch(
        mode,
        deps,
        scopedPass,
        graphqlRemaining === null
          ? 'Global GitHub GraphQL rate-limit evidence was unavailable after scoped pre-dispatch'
          : `Global GitHub rate-limit budget was low after scoped pre-dispatch: ${
              graphqlRemaining
            } remaining`,
      );
    }
    return {
      status: 'rate-limited',
      mode,
      message: graphqlRemaining === null
        ? 'GitHub GraphQL rate-limit evidence is unavailable'
        : `GitHub rate-limit budget low: ${graphqlRemaining} remaining`,
      githubUsage: finalGitHubUsage(deps, snapshot),
      items: [],
      orphanBranchClaims: [],
      diagnostics: [],
      events: [],
    };
  }
  const cycleId = scopedCycleId ?? deps.cycleId();
  const remainingStart = snapshot.project.rateLimit.remaining;
  const attachBudget = async <Report extends { readonly status: 'ok' }>(
    report: Report,
  ): Promise<Report & {
    readonly budget?: {
      readonly remainingStart: number;
      readonly remainingEnd: number;
      readonly pointsSpent: number;
    };
  }> => {
    if (deps.readRateLimitRemaining === undefined) return report;
    const remainingEnd = await deps.readRateLimitRemaining();
    return {
      ...report,
      budget: {
        remainingStart,
        remainingEnd,
        pointsSpent: Math.max(0, remainingStart - remainingEnd),
      },
    };
  };
  const now = deps.now();
  if (mode === 'active') {
    emitPhase('dispatch');
    const activePass = await executeActivePass(snapshot, deps, cycleId, now);
    const combinedReconciliation = scopedPass === undefined
      ? activePass.reconciliation
      : {
          results: [
            ...scopedPass.reconciliation.results,
            ...activePass.reconciliation.results,
          ],
        };
    return attachBudget({
      status: 'ok',
      mode,
      cycleId,
      runnerId: deps.runnerId,
      capturedAt: snapshot.capturedAt,
      ...snapshotReportMetadata(snapshot),
      githubUsage: finalGitHubUsage(deps, snapshot),
      items: activePass.items,
      orphanBranchClaims: activePass.orphanBranchClaims,
      diagnostics: activePass.diagnostics,
      events: [
        ...(scopedPass?.events ?? []),
        ...activePass.events,
      ],
      reconciliation: combinedReconciliation,
    });
  }
  emitPhase('dispatch');
  const view = deriveLifecycle(snapshot.lifecycle, now, deps.staleAfterMs);
  const context = projectionContext(snapshot, view, now, deps.staleAfterMs);
  const plan = planProjection(context);
  const items = statusItems(
    view,
    plan.actions,
    now,
    context.orphanBranchClaims,
    engagedEnqueueHolds(deps.mergePolicy),
  );
  const orphanBranchClaims = orphanStatusItems(
    context.orphanBranchClaims,
    plan.actions,
  );
  const diagnostics: LifecycleStatusDiagnostic[] = snapshot.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    phase: 'human',
    desiredActions: plan.actions.filter((action) => (
      ('prNumber' in action
        && diagnostic.pullRequests.some((pr) => pr.number === action.prNumber))
      || ('issueNumber' in action
        && action.issueNumber !== undefined
        && diagnostic.issueNumbers.includes(action.issueNumber))
    )),
  }));
  if (mode === 'observe') {
    return attachBudget({
      status: 'ok',
      mode,
      cycleId,
      runnerId: deps.runnerId,
      capturedAt: snapshot.capturedAt,
      ...snapshotReportMetadata(snapshot),
      githubUsage: finalGitHubUsage(deps, snapshot),
      items,
      orphanBranchClaims,
      diagnostics,
      events: [],
    });
  }
  const writer = deps.writerForSnapshot?.(snapshot) ?? deps.writer!;
  const reconciliation = await executeProjectionPlan(plan, writer);
  const reconciliationEvents = reconciliation.results.map((result) => (
    eventFor(
      result,
      items,
      orphanBranchClaims,
      diagnostics,
      cycleId,
      deps.runnerId,
      'recover',
    )
  ));
  return attachBudget({
    status: 'ok',
    mode,
    cycleId,
    runnerId: deps.runnerId,
    capturedAt: snapshot.capturedAt,
    ...snapshotReportMetadata(snapshot),
    githubUsage: finalGitHubUsage(deps, snapshot),
    items,
    orphanBranchClaims,
    diagnostics,
    events: reconciliationEvents,
    reconciliation,
  });
}

export function renderLifecycleJson(report: LifecycleCycleReport): string {
  const githubUsage = report.githubUsage;
  const lastFullReconciliationAt = 'lastFullReconciliationAt' in report
    ? report.lastFullReconciliationAt
    : undefined;
  return JSON.stringify({
    ...report,
    ...(lastFullReconciliationAt === undefined
      ? {}
      : { lastFullReconciledAt: lastFullReconciliationAt }),
    ...(githubUsage === undefined
      ? {}
      : {
          githubUsage: {
            ...githubUsage,
            graphqlPoints: githubUsage.graphqlCost,
          },
        }),
  }, null, 2);
}

function explanation(item: LifecycleStatusItem): string {
  const identity = item.prNumber === undefined
    ? `Issue #${item.issueNumber}`
    : `PR #${item.prNumber} (issue #${item.issueNumber})`;
  if (item.stale) {
    return `${identity} is stale in ${item.phase}; recovery is awaiting an exact-head correction.`;
  }
  switch (item.phase) {
    case 'eligible':
      if (item.eligible === true) return `${identity} is eligible for an ordinary claim.`;
      return `${identity} is not eligible for an ordinary claim: ${
        item.eligibilityDetail ?? item.eligibilityReason ?? 'source admission gates did not select it'
      }.`;
    case 'implementing':
      return `${identity} is implementing and awaiting durable phase completion before review.`;
    case 'awaiting-review':
      return `${identity} is awaiting an exact-head review claim.`;
    case 'reviewing':
      return `${identity} is reviewing the current exact head.`;
    case 'blocked-by-child':
      return `${identity} is blocked by an open child issue before the lifecycle can continue.`;
    case 'ci-blocked':
      return `${identity} is blocked by CI before it can be handed to the merge queue.`;
    case 'merge-ready': {
      if (item.inMergeQueue === true) {
        return `${identity} is in GitHub's merge queue; the queue builds and lands the merge, `
          + 'and Done arrives from a later cycle reading the merged fact.';
      }
      const holds = item.enqueueHolds ?? [];
      return holds.length === 0
        ? `${identity} is ready to be enqueued into GitHub's merge queue, and nothing is `
          + 'withholding the enqueue.'
        : `${identity} is ready to be enqueued into GitHub's merge queue, but the enqueue is `
          + `withheld: ${holds.map(enqueueHoldDetail).join('; ')}.`;
    }
    case 'human':
      return `${identity} is blocked in Human: ${item.humanReason?.detail ?? 'explicit Human hold'}.`;
    case 'merged':
      return `${identity} is merged and awaiting no lifecycle gate.`;
    default:
      return assertNever(item.phase);
  }
}

function enqueueHoldDetail(hold: EnqueueHold): string {
  return hold === 'enqueue-path-disarmed'
    ? 'JINN_AUTOPILOT_ENQUEUE disarms the enqueue path entirely'
    : 'the repository merge policy is manual, which leaves the enqueue to a maintainer';
}

function assertNever(phase: never): never {
  throw new Error(`Unhandled lifecycle phase: ${phase}`);
}

function orphanExplanation(item: LifecycleOrphanBranchClaimStatus): string {
  const identity = `Issue #${item.issueNumber} orphan branch claim ${item.headRefName}`;
  if (item.phase === 'human') {
    return `${identity} is blocked in Human: ${
      item.humanReason?.detail ?? 'explicit Human hold'
    }.`;
  }
  if (item.stale) {
    return `${identity} is stale in implementation and awaiting exact-head draft repair and requeue.`;
  }
  if (item.phase === 'awaiting-review') {
    return `${identity} completed implementation and is awaiting draft PR review recovery.`;
  }
  return `${identity} is implementing and awaiting draft PR repair.`;
}

export function explainIssue(report: LifecycleCycleReport, issueNumber: number): string {
  if (report.status !== 'ok') return report.message;
  const items = report.items.filter((item) => item.issueNumber === issueNumber);
  const orphans = report.orphanBranchClaims.filter((item) => item.issueNumber === issueNumber);
  const diagnostics = report.diagnostics.filter((diagnostic) => (
    diagnostic.issueNumbers.includes(issueNumber)
  ));
  if (items.length === 0 && orphans.length === 0 && diagnostics.length === 0) {
    return `Issue #${issueNumber} is not present in the complete lifecycle snapshot.`;
  }
  return [
    ...items.map(explanation),
    ...orphans.map(orphanExplanation),
    ...diagnostics.map((diagnostic) => `Issue #${issueNumber} is blocked in Human: ${diagnostic.detail}.`),
  ].join('\n');
}

export function explainPullRequest(report: LifecycleCycleReport, prNumber: number): string {
  if (report.status !== 'ok') return report.message;
  const item = report.items.find((candidate) => candidate.prNumber === prNumber);
  const diagnostic = report.diagnostics.find((candidate) => (
    candidate.pullRequests.some((pr) => pr.number === prNumber)
  ));
  if (item === undefined && diagnostic === undefined) {
    return `PR #${prNumber} is not present in the complete lifecycle snapshot.`;
  }
  return item === undefined
    ? `PR #${prNumber} is blocked in Human: ${diagnostic!.detail}.`
    : explanation(item);
}

function githubUsageSummary(usage: GitHubUsage): string {
  return `GitHub usage: GraphQL ${usage.graphqlCost} points across `
    + `${usage.graphqlRequests} evidence requests, `
    + `${usage.graphqlRemaining ?? 'unknown'} remaining; `
    + `REST ${usage.restRequests} requests, ${usage.restNotModified} not modified, `
    + `${usage.cacheHits} cache hits.`
    + (usage.transientRetries === undefined || usage.transientRetries === 0
      ? ''
      : ` Retried reads: ${usage.transientRetries} transport faults.`);
}

// Accounting incompleteness is observability, not failure: GitHub's
// used/remaining counters are eventually consistent under concurrency, so a
// cycle whose commands all succeeded can still report incomplete accounting.
// Surface it as a line, never let it gate or crash the cycle.
//
// Two severities, because the flag covers two situations. A cycle that failed
// to evidence something it should have evidenced is an anomaly and keeps the
// WARNING. A cycle whose only gap is an approximation GitHub's API makes
// unavoidable is not — it fired on EVERY cycle, which trains the operator to
// ignore the line that also carries the real anomalies, and its "reported
// quota numbers are best-effort" text overstated the damage: under counter
// skew `graphqlRemaining`/`graphqlResetAt` are exact and only the cost
// attribution is soft. The approximate form states which number is soft and
// why. The `accountingComplete` flag itself is unchanged in both cases.
function accountingWarningLines(usage: GitHubUsage | undefined): readonly string[] {
  if (usage === undefined || usage.accountingComplete !== false) return [];
  // A legacy cache entry can carry the flag without a reason; an unattributable
  // gap is not an expected approximation, so it keeps the warning.
  const reason = usage.incompleteReason ?? 'eventually-consistent rate-limit counter skew';
  if (reason.startsWith(EXPECTED_ACCOUNTING_APPROXIMATION_PREFIX)) {
    return [
      'GitHub usage accounting is approximate: '
        + `${reason.slice(EXPECTED_ACCOUNTING_APPROXIMATION_PREFIX.length)}.`,
    ];
  }
  return [
    'WARNING: GitHub usage accounting is incomplete '
      + `(${reason}); `
      + 'reported quota numbers are best-effort.',
  ];
}

function paritySummary(
  differences: readonly LifecycleParityDifference[] | undefined,
  complete: boolean,
  unavailableReason?: string,
): readonly string[] {
  if (!complete) return ['Parity comparison: unavailable for a partial view.'];
  if (unavailableReason !== undefined) {
    return [`Parity comparison: unavailable (${unavailableReason}).`];
  }
  if (differences === undefined) return ['Parity comparison: not run for this snapshot.'];
  if (differences.length === 0) return ['Parity differences: 0.'];
  return [
    `Parity differences: ${differences.length} (${
      differences.map((difference) => difference.subject).join(', ')
    }).`,
    ...differences.map((difference) => (
      `Parity ${difference.subject}: incremental=${difference.incremental ?? 'absent'}; `
        + `full=${difference.full ?? 'absent'}.`
    )),
  ];
}

/**
 * Elision budget for `LifecycleLogEvent.reason`.
 *
 * Failure detail originates as `message(error)`, and the production writer
 * shells out via execFile, whose rejection message is
 * `Command failed: <argv>\n<stderr>`. The argv comes FIRST and carries whole PR
 * bodies and raw issue titles from the target repository, while the actual
 * diagnosis — stderr — sits at the END. So the budget is biased hard toward the
 * tail: truncating from the front would keep the noise and drop the cause.
 */
const LOG_REASON_HEAD_LENGTH = 120;
const LOG_REASON_TAIL_LENGTH = 600;

/**
 * Minimum number of elided characters worth spending the marker on. Comfortably
 * exceeds the marker's own length, so eliding always shortens the string.
 */
const LOG_REASON_ELISION_THRESHOLD = 64;

/**
 * Renders untrusted failure detail as a single bounded log field.
 *
 * Event reasons are interpolated into one-line, operator-facing log records,
 * but their content is attacker-influenceable: a target-repo issue title or PR
 * body reaches the detail verbatim through a failed `gh` invocation. Collapsing
 * whitespace keeps a title that begins with a newline from forging an extra
 * event line for a human reading the log, and the middle elision stops one
 * failure from emitting a multi-KB record — while preserving the trailing
 * stderr that makes the reason worth logging at all.
 *
 * The collapsed class deliberately exceeds `\s`, which matches no C0 control
 * beyond the five ASCII spaces and no C1 control at all. ESC (0x1B) in a PR
 * body would otherwise survive into an operator's terminal as a live escape
 * sequence — the same misleading-a-human channel the newline collapse closes,
 * reached by a different byte.
 *
 * Pure and total: never throws, and never returns a string containing a line
 * break or any other control character. Sanitizing here, at event construction,
 * means every consumer of `LifecycleLogEvent` inherits the guarantee instead of
 * re-deriving it.
 */
function logSafeReason(detail: string): string {
  const flattened = detail.replace(/[\s\u0000-\u001F\u007F-\u009F]+/gu, ' ').trim();
  const elided = flattened.length - LOG_REASON_HEAD_LENGTH - LOG_REASON_TAIL_LENGTH;
  if (elided <= LOG_REASON_ELISION_THRESHOLD) return flattened;
  return `${flattened.slice(0, LOG_REASON_HEAD_LENGTH)} […${elided} chars elided…] ${
    flattened.slice(flattened.length - LOG_REASON_TAIL_LENGTH)
  }`;
}

function lifecycleEventSummary(event: LifecycleLogEvent): string {
  return `${event.action} ${event.subject}: ${event.outcome}${
    event.reason === undefined ? '' : ` (${event.reason})`
  }.`;
}

export function renderLifecycleHuman(report: LifecycleCycleReport): string {
  if (report.status === 'failed') {
    const retainedState = [
      `Mutation-free: ${report.mutationFree ? 'yes' : 'no'}.`,
      `Reconciliation results retained: ${report.reconciliation?.results.length ?? 0}.`,
      ...report.events.map(lifecycleEventSummary),
    ];
    if (report.usageAccounting.complete === false) {
      return [
        report.message,
        ...retainedState,
        `GitHub usage: unavailable (${report.usageAccounting.reason}).`,
      ].join('\n');
    }
    const usage = report.githubUsage;
    if (usage === undefined) {
      return [
        report.message,
        ...retainedState,
        'GitHub usage: unavailable (complete usage evidence is missing).',
      ].join('\n');
    }
    return [
      report.message,
      ...retainedState,
      githubUsageSummary(usage),
      ...accountingWarningLines(usage),
    ].join('\n');
  }
  const usageLine = githubUsageSummary(report.githubUsage);
  const accountingLines = accountingWarningLines(report.githubUsage);
  if (report.status !== 'ok') {
    return [report.message, usageLine, ...accountingLines].join('\n');
  }
  const snapshotLine = `Snapshot: ${report.snapshotMode} (${
    report.snapshotComplete ? 'complete' : 'partial'
  }), captured ${report.capturedAt}, last full reconciliation ${
    report.lastFullReconciliationAt ?? 'never'
  }.`;
  const partialLines = report.partialReason === undefined
    ? []
    : [`PARTIAL: ${report.partialReason}.`];
  const warningLines = report.snapshotWarning === undefined
    ? []
    : [`WARNING: ${report.snapshotWarning}.`];
  const parityLines = paritySummary(
    report.parityDifferences,
    report.snapshotComplete,
    report.parityUnavailableReason,
  );
  if (
    report.items.length === 0
    && report.orphanBranchClaims.length === 0
    && report.diagnostics.length === 0
    && report.events.length === 0
    && report.budget === undefined
  ) {
    return [
      snapshotLine,
      ...partialLines,
      ...warningLines,
      usageLine,
      ...accountingLines,
      ...parityLines,
      'No lifecycle items.',
    ].join('\n');
  }
  return [
    snapshotLine,
    ...partialLines,
    ...warningLines,
    usageLine,
    ...accountingLines,
    ...parityLines,
    ...report.items.map(explanation),
    ...report.orphanBranchClaims.map(orphanExplanation),
    ...report.diagnostics.map((diagnostic) => `Human diagnostic: ${diagnostic.detail}.`),
    ...report.events.map(lifecycleEventSummary),
    ...(report.budget === undefined
      ? []
      : [
          `points-spent: ${report.budget.pointsSpent} `
          + `(remaining ${report.budget.remainingStart} → ${report.budget.remainingEnd})`,
        ]),
  ].join('\n');
}
