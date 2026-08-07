import { describe, expect, it } from 'vitest';
import {
  authorizeRelayV2Spend,
  relayDecisionContinuationDeadline,
  relayHumanDecisionExpiry,
} from '../../src/issue-relay/budget-v2.js';
import type { RelayV2Policy } from '../../src/issue-relay/state-v2.js';
import { relayV2TestRecord } from './v2-fixture.js';

const policy: RelayV2Policy & {
  readonly maxEvaluationRetrySpendWei: bigint;
  readonly maxDecisionImplementationSpendWei: bigint;
} = {
  maxRoundsPerGeneration: 5,
  maxEvaluationAttemptsPerLanePerHead: 2,
  maxDecisionRequestsPerGeneration: 3,
  maxDecisionImplementationRoundsPerGeneration: 2,
  humanDecisionTtlMs: 1_209_600_000,
  maxHumanDeferrals: 1,
  humanDeferralExtensionMs: 1_209_600_000,
  decisionContinuationDeadlineMs: 86_400_000,
  implementBeforeDecision: () => false,
  maxEvaluationRetrySpendWei: 20n,
  maxDecisionImplementationSpendWei: 50n,
};

describe('Relay V2 spend and deadlines', () => {
  it('bounds evaluation retries without turning them into solver repair rounds', () => {
    const record = relayV2TestRecord();
    expect(authorizeRelayV2Spend({
      record, purpose: 'evaluation-retry', proposedSpendWei: 10n,
      maxGenerationSpendWei: 100n, policy, now: '2026-08-06T12:11:00.000Z',
      evaluationAttemptsAtHead: 1, evaluationRetrySpendAtHeadWei: 5n,
    })).toEqual({ admitted: true, resultingGenerationSpendWei: 10n });
    expect(authorizeRelayV2Spend({
      record, purpose: 'evaluation-retry', proposedSpendWei: 10n,
      maxGenerationSpendWei: 100n, policy, now: '2026-08-06T12:11:00.000Z',
      evaluationAttemptsAtHead: 2, evaluationRetrySpendAtHeadWei: 5n,
    })).toEqual({ admitted: false, reason: 'evaluation-attempt-limit' });
  });

  it('prevents duplicate decision options and applies dedicated decision spend caps', () => {
    const record = relayV2TestRecord();
    const common = {
      record, purpose: 'decision-implementation' as const, proposedSpendWei: 30n,
      maxGenerationSpendWei: 100n, policy, now: '2026-08-06T12:11:00.000Z',
      decision: { decisionKey: `sha256:${'a'.repeat(64)}` as const, commissionedOptions: ['option-a'] },
      continuationDeadlineAt: '2026-08-07T12:11:00.000Z',
    };
    expect(authorizeRelayV2Spend({ ...common, optionId: 'option-a' })).toEqual({ admitted: false, reason: 'duplicate-decision-option' });
    expect(authorizeRelayV2Spend({ ...common, optionId: 'option-b' })).toEqual({ admitted: true, resultingGenerationSpendWei: 30n });
    expect(authorizeRelayV2Spend({ ...common, optionId: 'option-b', proposedSpendWei: 51n })).toEqual({ admitted: false, reason: 'decision-spend-limit' });
  });

  it('makes cancellation dominate all new spend', () => {
    const record = { ...relayV2TestRecord(), phase: 'cancelling' as const, cancellation: { requestedAt: '2026-08-06T12:11:00.000Z', reason: 'operator' as const } };
    expect(authorizeRelayV2Spend({
      record, purpose: 'repair', proposedSpendWei: 1n, maxGenerationSpendWei: 100n,
      policy, now: '2026-08-06T12:12:00.000Z',
    })).toEqual({ admitted: false, reason: 'cancelled' });
  });

  it('separates human waiting and one deferral from the autonomous deadline', () => {
    expect(relayHumanDecisionExpiry({
      createdAt: '2026-08-06T12:00:00.000Z', ttlMs: 14 * 86_400_000,
      deferrals: 1, maxDeferrals: 1, deferralExtensionMs: 14 * 86_400_000,
    })).toBe('2026-09-03T12:00:00.000Z');
    expect(relayDecisionContinuationDeadline({
      decidedAt: '2026-08-06T12:00:00.000Z', deadlineMs: 86_400_000,
    })).toBe('2026-08-07T12:00:00.000Z');
  });
});
