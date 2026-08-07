import { describe, expect, it, vi } from 'vitest';
import { parseIssueRelayConfig, type IssueRelayConfigV2 } from '../../src/issue-relay/config.js';
import {
  runIssueRelayCycleV2,
  type RelayReconciliationCandidateV2,
  type RelayReconciliationPortV2,
} from '../../src/issue-relay/reconciler-v2.js';
import { relayV2TestRecord } from './v2-fixture.js';

const config = parseIssueRelayConfig({
  schemaVersion: 2,
  repository: 'Jinn-Network/mono',
  label: 'engine:marketplace',
  relayBotLogin: 'jinn-relay',
  managedForkRepository: 'jinn-relay/mono',
  targetBase: 'next',
  solverNet: 'jinn-repo',
  verificationProfile: 'jinn-mono.v1',
  requiredChecks: [],
  pollSeconds: 30,
  generationProtocol: 'v2',
  dualLaneEvaluationEnabled: true,
  humanDecisionCommandsEnabled: true,
  decisionImplementationEnabled: true,
  laneSpecifications: {
    security: `sha256:${'a'.repeat(64)}`,
    quality: `sha256:${'b'.repeat(64)}`,
  },
  safePreimplementationReasonCodes: ['compatibility-choice'],
  budget: {
    maxGlobalActiveGenerations: 2,
    maxActivePerRepository: 2,
    maxActivePerAuthor: 1,
    maxRoundsPerGeneration: 4,
    maxGenerationSpendWei: '1000',
    maxGlobalSpendWeiPerUtcDay: '10000',
    generationDeadlineMs: 86_400_000,
    maxEvaluationAttemptsPerLanePerHead: 2,
    maxEvaluationRetrySpendWei: '100',
    maxDecisionRequestsPerGeneration: 3,
    maxDecisionImplementationRoundsPerGeneration: 2,
    maxDecisionImplementationSpendWei: '200',
    humanDecisionTtlMs: 1_209_600_000,
    maxHumanDeferrals: 1,
    humanDeferralExtensionMs: 1_209_600_000,
    decisionContinuationDeadlineMs: 86_400_000,
  },
}) as IssueRelayConfigV2;

function candidate(): RelayReconciliationCandidateV2 {
  const record = {
    ...relayV2TestRecord(),
    phase: 'admitted' as const,
    rounds: [],
    decisions: [],
    pr: undefined,
  };
  return {
    generation: record.generation,
    repository: record.snapshot.repository.slug,
    issueNumber: record.snapshot.issue.number,
    transitionedAt: record.updatedAt,
    authority: 'github',
    facts: {
      durable: record,
      issue: { open: true, optedIn: true },
      currentBaseOid: record.snapshot.repository.baseOid,
      now: '2026-08-06T12:11:00.000Z',
    },
  };
}

function port(value: RelayReconciliationCandidateV2): RelayReconciliationPortV2 & {
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(async () => ({ outcome: 'completed' as const, detail: 'recorded' }));
  return {
    scan: async () => [value],
    reread: async () => value,
    execute,
  };
}

describe('Relay V2 reconciliation cycle', () => {
  it('derives and executes at most one exact action', async () => {
    const reconciliation = port(candidate());
    const report = await runIssueRelayCycleV2({ config, mode: 'active', reconciliation });
    expect(report).toMatchObject({
      discovered: 1,
      actions: [{ action: 'prepare-round', outcome: 'completed' }],
    });
    expect(reconciliation.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps observe mode read-only and cancellation dominant', async () => {
    const observed = port(candidate());
    expect(await runIssueRelayCycleV2({ config, mode: 'observe', reconciliation: observed }))
      .toMatchObject({ actions: [{ action: 'prepare-round', outcome: 'pending' }] });
    expect(observed.execute).not.toHaveBeenCalled();

    const initial = candidate();
    const cancellingCandidate = {
      ...initial,
      facts: {
        ...initial.facts,
        issue: { open: false, optedIn: true },
      },
    };
    const cancelling = port(cancellingCandidate);
    expect(await runIssueRelayCycleV2({ config, mode: 'active', reconciliation: cancelling }))
      .toMatchObject({ actions: [{ action: 'record-cancellation', outcome: 'completed' }] });
  });

  it('fails closed on duplicate GitHub generation authority', async () => {
    const value = candidate();
    const reconciliation = port(value);
    reconciliation.scan = async () => [value, value];
    const report = await runIssueRelayCycleV2({ config, mode: 'active', reconciliation });
    expect(report.actions).toHaveLength(2);
    expect(report.actions.every(({ outcome }) => outcome === 'failed')).toBe(true);
    expect(reconciliation.execute).not.toHaveBeenCalled();
  });
});
