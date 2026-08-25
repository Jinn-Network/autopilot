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
    : `pr:${candidate.prNumber}`;
}

function capacitySkipReason(input: ActiveSchedulingInput): ActiveSchedulingSkip['reason'] {
  return input.newWorkPaused === true ? 'disk-floor' : 'capacity';
}

export function scheduleActiveActions(
  input: ActiveSchedulingInput,
): ActiveSchedulingPlan {
  const actions: NewWorkAction[] = [];
  const skips: ActiveSchedulingSkip[] = [];
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
  for (const candidate of implementation) {
    if (actions.filter((action) => action.kind === 'claim-implementation').length
      >= input.remaining.implementation) {
      skips.push({
        phase: candidate.phase,
        subject: subject(candidate),
        reason: capacitySkipReason(input),
      });
      continue;
    }
    // Fresh work only: child fixes/reconciles/ci-failures reduce backlog and
    // must still claim under backpressure (capacity remaining still applies).
    if (
      candidate.intent === 'fresh'
      && candidate.isChild !== true
      && input.openPipelineBacklog >= input.implementationBackpressureThreshold
    ) {
      skips.push({ phase: candidate.phase, subject: subject(candidate), reason: 'backpressure' });
      continue;
    }
    if (configuredLogins.size === 0) {
      skips.push({ phase: candidate.phase, subject: subject(candidate), reason: 'credential-lane' });
      continue;
    }
    actions.push({
      kind: 'claim-implementation',
      ...candidate.intent === 'fresh'
        ? { intent: 'fresh', issueNumber: candidate.issueNumber }
        : {
            intent: 'stale-recovery',
            issueNumber: candidate.issueNumber,
            prNumber: candidate.prNumber,
            expectedHead: candidate.expectedHead,
            branch: candidate.branch,
            claimAttempt: candidate.claimAttempt,
          },
    });
  }

  for (const candidate of input.candidates) {
    if (candidate.phase !== 'review') continue;
    if (actions.filter((action) => action.kind === 'claim-review').length >= input.remaining.review) {
      skips.push({
        phase: candidate.phase,
        subject: subject(candidate),
        reason: capacitySkipReason(input),
      });
      continue;
    }
    const reviewer = [...configuredLogins].find(
      (login) => login !== candidate.author.toLowerCase(),
    );
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

  return { actions, skips };
}
