import { isDeepStrictEqual } from 'node:util';
import {
  IssueRelayHumanDecisionReceiptV1Schema,
  type IssueRelayEvaluationBundleV2,
  type IssueRelayHumanDecisionReceiptV1,
} from './contracts.js';
import {
  aggregateRelayEvaluationV2,
  recordRelayEvaluationBundleV2,
  relayV2EvidenceIsExact,
  validateRelayGenerationV2,
  type RelayGenerationRecordV2,
  type RelayRoundRecordV2,
  type RelayV2Policy,
} from './state-v2.js';
import { relayGeneration } from './identity.js';

const oid = (value: string): boolean => /^[0-9a-f]{40}$/.test(value);
const digest = (value: string): value is `sha256:${string}` =>
  /^sha256:[0-9a-f]{64}$/.test(value);
const safe = (value: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(value);
const canonicalUtc = (value: string): boolean => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

function exactRecord(record: RelayGenerationRecordV2): void {
  if (!validateRelayGenerationV2(record)) {
    throw new TypeError('Relay V2 durable evidence is contradictory');
  }
}

function updateRound(
  record: RelayGenerationRecordV2,
  roundNumber: number,
  update: (round: RelayRoundRecordV2) => RelayRoundRecordV2,
  phase: RelayGenerationRecordV2['phase'],
  now: string,
  extra: Partial<Pick<RelayGenerationRecordV2, 'pr' | 'cancellation' | 'supersession'>> = {},
): RelayGenerationRecordV2 {
  exactRecord(record);
  if (!canonicalUtc(now)) throw new TypeError('Relay V2 transition time is invalid');
  const current = record.rounds[roundNumber];
  if (current === undefined) throw new TypeError('Relay V2 transition round does not exist');
  const rounds = [...record.rounds];
  rounds[roundNumber] = update(current);
  const next = { ...record, ...extra, phase, rounds, updatedAt: now };
  exactRecord(next);
  return next;
}

export function persistRelayTaskSubmissionV2(input: {
  readonly record: RelayGenerationRecordV2;
  readonly round: number;
  readonly task: NonNullable<RelayRoundRecordV2['task']>;
  readonly now: string;
}): RelayGenerationRecordV2 {
  return updateRound(input.record, input.round, (round) => {
    if (round.fundingIntent === undefined) {
      throw new TypeError('Relay V2 submission requires a durable funding intent');
    }
    if (round.task !== undefined) {
      if (isDeepStrictEqual(round.task, input.task)) return round;
      throw new TypeError('Relay V2 task submission evidence is contradictory');
    }
    if (
      input.task.taskKey !== round.fundingIntent.taskKey
      || !/^(0|[1-9][0-9]*)$/.test(input.task.taskId)
      || input.task.taskCid.length === 0
      || input.task.spendWei !== round.fundingIntent.spendWei
      || !canonicalUtc(input.task.fundedAt)
    ) throw new TypeError('Relay V2 task submission does not match funding authority');
    return { ...round, task: input.task };
  }, 'submitted', input.now);
}

export function persistRelaySolutionDeliveryV2(input: {
  readonly record: RelayGenerationRecordV2;
  readonly round: number;
  readonly solution: NonNullable<RelayRoundRecordV2['solution']>;
  readonly now: string;
}): RelayGenerationRecordV2 {
  return updateRound(input.record, input.round, (round) => {
    if (round.task === undefined) throw new TypeError('Relay V2 Solution requires a funded task');
    if (round.solution !== undefined) {
      if (isDeepStrictEqual(round.solution, input.solution)) return round;
      throw new TypeError('Relay V2 Solution evidence is contradictory');
    }
    if (
      input.solution.envelopeCid.length === 0
      || !safe(input.solution.operatorSafe)
      || !canonicalUtc(input.solution.observedAt)
    ) throw new TypeError('Relay V2 Solution evidence is malformed');
    return { ...round, solution: input.solution };
  }, 'solution-delivered', input.now);
}

export function persistRelayAdoptionV2(input: {
  readonly record: RelayGenerationRecordV2;
  readonly round: number;
  readonly adoption: NonNullable<RelayRoundRecordV2['adoption']>;
  readonly pr?: NonNullable<RelayGenerationRecordV2['pr']>;
  readonly now: string;
}): RelayGenerationRecordV2 {
  const accepted = input.adoption.disposition === 'accepted';
  if (
    accepted
      ? input.pr === undefined
        || input.adoption.resultingHead !== input.pr.head
        || input.adoption.prNumber !== input.pr.number
        || !input.pr.draft
      : input.adoption.resultingHead !== undefined || input.pr !== undefined
  ) throw new TypeError('Relay V2 adoption and pull request evidence disagree');
  return updateRound(input.record, input.round, (round) => {
    if (round.solution === undefined || !digest(input.adoption.receiptDigest)) {
      throw new TypeError('Relay V2 adoption requires exact Solution evidence');
    }
    if (round.adoption !== undefined) {
      if (isDeepStrictEqual(round.adoption, input.adoption)) return round;
      throw new TypeError('Relay V2 adoption evidence is contradictory');
    }
    return { ...round, adoption: input.adoption };
  }, accepted ? 'draft-open' : 'exhausted', input.now, accepted ? { pr: input.pr } : {});
}

/** Pending checks remain live facts; only a terminal exact-head summary is durable. */
export function persistRelayChecksV2(input: {
  readonly record: RelayGenerationRecordV2;
  readonly round: number;
  readonly checks: NonNullable<RelayRoundRecordV2['checks']> & {
    readonly status: 'passed' | 'failed';
  };
  readonly now: string;
}): RelayGenerationRecordV2 {
  return updateRound(input.record, input.round, (round) => {
    if (
      round.adoption?.disposition !== 'accepted'
      || round.adoption.resultingHead !== input.checks.head
      || !oid(input.checks.head)
      || !digest(input.checks.digest)
    ) throw new TypeError('Relay V2 checks do not bind the adopted exact head');
    if (round.checks !== undefined) {
      if (isDeepStrictEqual(round.checks, input.checks)) return round;
      throw new TypeError('Relay V2 terminal check evidence is contradictory');
    }
    return { ...round, checks: input.checks };
  }, 'draft-open', input.now);
}

export function persistRelayEvaluationAnchorV2(input: {
  readonly record: RelayGenerationRecordV2;
  readonly round: number;
  readonly evaluation: NonNullable<RelayRoundRecordV2['evaluation']>;
  readonly now: string;
}): RelayGenerationRecordV2 {
  return updateRound(input.record, input.round, (round) => {
    if (
      round.checks?.status !== 'passed'
      || round.checks.head !== input.evaluation.head
      || !digest(input.evaluation.anchorDigest)
      || !canonicalUtc(input.evaluation.anchoredAt)
    ) throw new TypeError('Relay V2 evaluation anchor does not bind passed exact-head checks');
    if (round.evaluation !== undefined) {
      if (isDeepStrictEqual(round.evaluation, input.evaluation)) return round;
      throw new TypeError('Relay V2 evaluation anchor is contradictory');
    }
    return { ...round, evaluation: input.evaluation };
  }, 'evaluating', input.now);
}

export function persistRelayEvaluationBundleV2(input: {
  readonly record: RelayGenerationRecordV2;
  readonly round: number;
  readonly bundle: IssueRelayEvaluationBundleV2;
  readonly evaluatorSafe: string;
  readonly envelopeCid: string;
  readonly observedAt: string;
}): RelayGenerationRecordV2 {
  return updateRound(input.record, input.round, (round) =>
    recordRelayEvaluationBundleV2({
      round,
      bundle: input.bundle,
      evaluatorSafe: input.evaluatorSafe,
      envelopeCid: input.envelopeCid,
      observedAt: input.observedAt,
    }), 'evaluating', input.observedAt);
}

export function persistRelayCancellationV2(input: {
  readonly record: RelayGenerationRecordV2;
  readonly reason: 'issue-closed' | 'label-removed' | 'operator';
  readonly now: string;
}): RelayGenerationRecordV2 {
  exactRecord(input.record);
  if (!canonicalUtc(input.now)) throw new TypeError('Relay V2 cancellation time is invalid');
  if (input.record.cancellation !== undefined) {
    if (input.record.cancellation.reason === input.reason) return input.record;
    throw new TypeError('Relay V2 cancellation intent is contradictory');
  }
  const next = {
    ...input.record,
    phase: 'cancelling' as const,
    cancellation: { requestedAt: input.now, reason: input.reason },
    updatedAt: input.now,
  };
  exactRecord(next);
  return next;
}

export function finishRelayCancellationV2(input: {
  readonly record: RelayGenerationRecordV2;
  readonly now: string;
}): RelayGenerationRecordV2 {
  exactRecord(input.record);
  if (input.record.phase !== 'cancelling' || input.record.cancellation === undefined) {
    throw new TypeError('Relay V2 cancellation has no durable intent');
  }
  const next = { ...input.record, phase: 'closed' as const, updatedAt: input.now };
  exactRecord(next);
  return next;
}

export function blockRelaySecurityV2(input: {
  readonly record: RelayGenerationRecordV2;
  readonly now: string;
}): RelayGenerationRecordV2 {
  exactRecord(input.record);
  const round = input.record.rounds.at(-1);
  const head = input.record.pr?.head;
  if (
    !canonicalUtc(input.now)
    || round === undefined
    || head === undefined
    || aggregateRelayEvaluationV2({
      record: input.record,
      round,
      exactHead: head,
      maxAttemptsPerLanePerHead: Number.MAX_SAFE_INTEGER,
    }).kind !== 'security-blocked'
  ) throw new TypeError('Relay V2 security block lacks exact critical evidence');
  const next = {
    ...input.record,
    phase: 'security-blocked' as const,
    updatedAt: input.now,
  };
  exactRecord(next);
  return next;
}

export function exhaustRelayGenerationV2(input: {
  readonly record: RelayGenerationRecordV2;
  readonly now: string;
}): RelayGenerationRecordV2 {
  exactRecord(input.record);
  if (!canonicalUtc(input.now)) {
    throw new TypeError('Relay V2 exhaustion time is invalid');
  }
  const next = {
    ...input.record,
    phase: 'exhausted' as const,
    updatedAt: input.now,
  };
  exactRecord(next);
  return next;
}

export function supersedeRelayGenerationV2(input: {
  readonly record: RelayGenerationRecordV2;
  readonly receipt: IssueRelayHumanDecisionReceiptV1;
  readonly successorSnapshot: RelayGenerationRecordV2['snapshot'];
  readonly now: string;
}): RelayGenerationRecordV2 {
  exactRecord(input.record);
  const receipt = IssueRelayHumanDecisionReceiptV1Schema.parse(
    input.receipt,
  ) as IssueRelayHumanDecisionReceiptV1;
  const successorGeneration = relayGeneration(input.successorSnapshot);
  if (
    receipt.action !== 'clarify-scope'
    || receipt.generation !== input.record.generation
    || !input.record.decisions.some((decision) =>
      decision.receipt?.receiptDigest === receipt.receiptDigest)
    || successorGeneration === input.record.generation
    || !digest(input.successorSnapshot.snapshotDigest)
    || input.successorSnapshot.repository.slug !== input.record.snapshot.repository.slug
    || input.successorSnapshot.issue.number !== input.record.snapshot.issue.number
    || !canonicalUtc(input.now)
  ) throw new TypeError('Relay V2 supersession authority is invalid');
  const next = {
    ...input.record,
    phase: 'superseded' as const,
    supersession: {
      successorGeneration,
      successorSnapshotDigest: input.successorSnapshot.snapshotDigest,
      successorSnapshot: input.successorSnapshot,
      requestedByReceiptDigest: receipt.receiptDigest as `sha256:${string}`,
      supersededAt: input.now,
    },
    updatedAt: input.now,
  };
  exactRecord(next);
  return next;
}

export function markRelayReadyV2(input: {
  readonly record: RelayGenerationRecordV2;
  readonly currentHead: string;
  readonly currentBase: string;
  readonly currentPullRequestMetadataDigest: `sha256:${string}`;
  readonly policy: Pick<RelayV2Policy, 'maxEvaluationAttemptsPerLanePerHead'>;
  readonly now: string;
}): RelayGenerationRecordV2 {
  exactRecord(input.record);
  const round = input.record.rounds.at(-1);
  if (
    round === undefined
    || !relayV2EvidenceIsExact({
      record: input.record,
      round,
      currentHead: input.currentHead,
      currentBase: input.currentBase,
    })
    || aggregateRelayEvaluationV2({
      record: input.record,
      round,
      exactHead: input.currentHead,
      exactPullRequestMetadataDigest: input.currentPullRequestMetadataDigest,
      maxAttemptsPerLanePerHead: input.policy.maxEvaluationAttemptsPerLanePerHead,
    }).kind !== 'ready'
    || input.record.pr === undefined
  ) throw new TypeError('Relay V2 readiness lacks both exact-head lane gates');
  const next = {
    ...input.record,
    phase: 'ready' as const,
    pr: { ...input.record.pr, draft: false },
    decisions: input.record.decisions.map((decision) =>
      ['active', 'implementing'].includes(decision.status)
        ? { ...decision, status: 'resolved' as const, resolvedAt: input.now }
        : decision),
    updatedAt: input.now,
  };
  exactRecord(next);
  return next;
}
