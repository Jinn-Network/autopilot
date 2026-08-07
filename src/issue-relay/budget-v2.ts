import type {
  RelayDecisionRecordV2,
  RelayGenerationRecordV2,
  RelayV2Policy,
} from './state-v2.js';

export type RelayV2SpendPurpose = 'initial' | 'repair' | 'decision-implementation' | 'evaluation-retry';

export type RelayV2SpendDecision =
  | { readonly admitted: true; readonly resultingGenerationSpendWei: bigint }
  | {
      readonly admitted: false;
      readonly reason:
        | 'cancelled'
        | 'terminal'
        | 'round-limit'
        | 'generation-spend-limit'
        | 'decision-round-limit'
        | 'decision-spend-limit'
        | 'evaluation-attempt-limit'
        | 'evaluation-spend-limit'
        | 'duplicate-decision-option'
        | 'deadline';
    };

function spend(round: RelayGenerationRecordV2['rounds'][number]): bigint {
  const evidence = round.task ?? round.fundingIntent;
  return evidence === undefined ? 0n : BigInt(evidence.spendWei);
}

export function relayGenerationSpendV2(record: RelayGenerationRecordV2): bigint {
  return record.rounds.reduce((total, round) => total + spend(round), 0n);
}

export function authorizeRelayV2Spend(input: {
  readonly record: RelayGenerationRecordV2;
  readonly purpose: RelayV2SpendPurpose;
  readonly proposedSpendWei: bigint;
  readonly maxGenerationSpendWei: bigint;
  readonly policy: RelayV2Policy & {
    readonly maxEvaluationRetrySpendWei: bigint;
    readonly maxDecisionImplementationSpendWei: bigint;
  };
  readonly now: string;
  readonly decision?: Pick<RelayDecisionRecordV2, 'decisionKey' | 'commissionedOptions'>;
  readonly optionId?: string;
  readonly evaluationAttemptsAtHead?: number;
  readonly evaluationRetrySpendAtHeadWei?: bigint;
  readonly continuationDeadlineAt?: string;
}): RelayV2SpendDecision {
  const { record, policy } = input;
  if (record.cancellation !== undefined || record.phase === 'cancelling') {
    return { admitted: false, reason: 'cancelled' };
  }
  if (['ready', 'closed', 'exhausted', 'superseded', 'security-blocked'].includes(record.phase)) {
    return { admitted: false, reason: 'terminal' };
  }
  if (Date.parse(input.now) >= Date.parse(record.executionDeadlineAt) && input.purpose !== 'decision-implementation') {
    return { admitted: false, reason: 'deadline' };
  }
  if (
    input.purpose === 'decision-implementation'
    && Date.parse(input.now) >= Date.parse(
      input.continuationDeadlineAt ?? record.executionDeadlineAt,
    )
  ) return { admitted: false, reason: 'deadline' };
  if (input.proposedSpendWei <= 0n) return { admitted: false, reason: 'generation-spend-limit' };
  const resulting = relayGenerationSpendV2(record) + input.proposedSpendWei;
  if (resulting > input.maxGenerationSpendWei) {
    return { admitted: false, reason: 'generation-spend-limit' };
  }
  if (input.purpose !== 'evaluation-retry' && record.rounds.length >= policy.maxRoundsPerGeneration) {
    return { admitted: false, reason: 'round-limit' };
  }
  if (input.purpose === 'evaluation-retry') {
    if ((input.evaluationAttemptsAtHead ?? 0) >= policy.maxEvaluationAttemptsPerLanePerHead) {
      return { admitted: false, reason: 'evaluation-attempt-limit' };
    }
    if ((input.evaluationRetrySpendAtHeadWei ?? 0n) + input.proposedSpendWei > policy.maxEvaluationRetrySpendWei) {
      return { admitted: false, reason: 'evaluation-spend-limit' };
    }
  }
  if (input.purpose === 'decision-implementation') {
    const rounds = record.rounds.filter(({ purpose }) => purpose === 'decision-implementation');
    if (rounds.length >= policy.maxDecisionImplementationRoundsPerGeneration) {
      return { admitted: false, reason: 'decision-round-limit' };
    }
    const decisionSpend = rounds.reduce((total, round) => total + spend(round), 0n);
    if (decisionSpend + input.proposedSpendWei > policy.maxDecisionImplementationSpendWei) {
      return { admitted: false, reason: 'decision-spend-limit' };
    }
    if (
      input.decision !== undefined
      && input.optionId !== undefined
      && input.decision.commissionedOptions.includes(input.optionId)
    ) return { admitted: false, reason: 'duplicate-decision-option' };
  }
  return { admitted: true, resultingGenerationSpendWei: resulting };
}

export function relayHumanDecisionExpiry(input: {
  readonly createdAt: string;
  readonly ttlMs: number;
  readonly deferrals: number;
  readonly maxDeferrals: number;
  readonly deferralExtensionMs: number;
}): string {
  if (
    !Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0
    || !Number.isSafeInteger(input.deferrals) || input.deferrals < 0
    || input.deferrals > input.maxDeferrals
    || !Number.isSafeInteger(input.deferralExtensionMs) || input.deferralExtensionMs <= 0
  ) throw new TypeError('Relay human decision deadline inputs are invalid');
  const created = Date.parse(input.createdAt);
  if (!Number.isFinite(created)) throw new TypeError('Relay human decision creation time is invalid');
  return new Date(created + input.ttlMs + input.deferrals * input.deferralExtensionMs).toISOString();
}

export function relayDecisionContinuationDeadline(input: {
  readonly decidedAt: string;
  readonly deadlineMs: number;
}): string {
  const decided = Date.parse(input.decidedAt);
  if (!Number.isFinite(decided) || !Number.isSafeInteger(input.deadlineMs) || input.deadlineMs <= 0) {
    throw new TypeError('Relay decision continuation deadline inputs are invalid');
  }
  return new Date(decided + input.deadlineMs).toISOString();
}
