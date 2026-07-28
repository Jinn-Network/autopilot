import type { RelaySpendDecision } from './budget.js';
import {
  IssueRelayVerdictV1Schema,
  type IssueRelayFindingV1,
  type IssueRelayVerdictV1,
} from './contracts.js';
import {
  relayBranch,
  relayGeneration,
  relayTaskKey,
} from './identity.js';
import type { IssueRelaySnapshotV1 } from './snapshot.js';
import {
  buildRelayTaskSpec,
  type RelayRepairAuthority,
} from './task.js';

export interface RelayRepairRound {
  readonly status: 'ready';
  readonly generation: string;
  readonly round: number;
  readonly taskKey: string;
  readonly workspaceRepository: string;
  readonly inputHead: string;
  readonly findings: readonly IssueRelayFindingV1[];
  readonly prNumber: number;
}

export interface RelayRepairRefusal {
  readonly status: 'refused';
  readonly reason:
    | 'verdict-not-repairable'
    | 'cancelled'
    | 'duplicate'
    | 'round-limit'
    | 'budget-limit'
    | 'deadline';
}

export interface RelayRepairPlanningAuthority extends RelayRepairAuthority {
  readonly generation: string;
  readonly targetRepository: 'Jinn-Network/mono';
  readonly targetRepositoryId: string;
  readonly forkRepositoryId: string;
  readonly forkParentRepositoryId: string;
  readonly branch: string;
  readonly managedFork: true;
  readonly visibility: 'PUBLIC';
  readonly open: true;
  readonly draft: true;
}

function refused(reason: RelayRepairRefusal['reason']): RelayRepairRefusal {
  return { status: 'refused', reason };
}

function budgetRefusal(
  budget: Exclude<RelaySpendDecision, { readonly status: 'admitted' }>,
): RelayRepairRefusal {
  switch (budget.status) {
    case 'duplicate':
      return refused('duplicate');
    case 'deferred':
      return refused('budget-limit');
    case 'exhausted':
      switch (budget.code) {
        case 'round-limit':
          return refused('round-limit');
        case 'generation-spend-limit':
          return refused('budget-limit');
        case 'deadline':
          return refused('deadline');
      }
  }
}

export function buildRelayRepair(input: {
  readonly snapshot: IssueRelaySnapshotV1;
  readonly previousRound: number;
  readonly currentHead: string;
  readonly managedForkRepository: string;
  readonly prNumber: number;
  readonly verdict: IssueRelayVerdictV1;
  readonly budget: RelaySpendDecision;
  readonly cancelled: boolean;
  readonly authority: RelayRepairPlanningAuthority;
}): RelayRepairRound | RelayRepairRefusal {
  if (input.cancelled) return refused('cancelled');
  if (input.budget.status !== 'admitted') {
    return budgetRefusal(input.budget);
  }

  const verdict = IssueRelayVerdictV1Schema.safeParse(input.verdict);
  const generation = relayGeneration(input.snapshot);
  const authority = input.authority as
    | Partial<RelayRepairPlanningAuthority>
    | undefined;
  if (
    !verdict.success
    || verdict.data.outcome !== 'request-changes'
    || !Number.isSafeInteger(input.previousRound)
    || input.previousRound < 0
    || verdict.data.correlation.generation !== generation
    || verdict.data.correlation.round !== input.previousRound
    || verdict.data.correlation.snapshotDigest !== input.snapshot.snapshotDigest
    || verdict.data.evaluatedHead !== input.currentHead
    || authority === undefined
    || authority.generation !== generation
    || authority.targetRepository !== input.snapshot.repository.slug
    || authority.workspaceRepository !== input.managedForkRepository
    || authority.managedFork !== true
    || authority.visibility !== 'PUBLIC'
    || authority.prNumber !== input.prNumber
    || authority.currentHead !== input.currentHead
    || authority.branch !== relayBranch(generation)
    || authority.open !== true
    || authority.draft !== true
    || typeof authority.targetRepositoryId !== 'string'
    || authority.targetRepositoryId.length === 0
    || typeof authority.forkRepositoryId !== 'string'
    || authority.forkRepositoryId.length === 0
    || authority.forkRepositoryId === authority.targetRepositoryId
    || authority.forkParentRepositoryId !== authority.targetRepositoryId
  ) {
    return refused('verdict-not-repairable');
  }

  const round = input.previousRound + 1;
  const taskKey = relayTaskKey(generation, round);
  if (input.budget.taskKey !== taskKey) {
    return refused('verdict-not-repairable');
  }

  try {
    const task = buildRelayTaskSpec({
      snapshot: input.snapshot,
      round,
      purpose: 'repair',
      workspaceRepository: input.managedForkRepository,
      inputHead: input.currentHead,
      findings: verdict.data.findings,
      prNumber: input.prNumber,
      repairAuthority: {
        managedFork: authority.managedFork,
        workspaceRepository: authority.workspaceRepository,
        visibility: authority.visibility,
        prNumber: authority.prNumber,
        currentHead: authority.currentHead,
      },
    });
    return {
      status: 'ready',
      generation,
      round,
      taskKey: task.spec.instance_id,
      workspaceRepository: task.spec.relay.workspaceRepository,
      inputHead: task.spec.relay.inputHead,
      findings: task.spec.relay.findings,
      prNumber: task.spec.relay.prNumber!,
    };
  } catch {
    return refused('verdict-not-repairable');
  }
}
