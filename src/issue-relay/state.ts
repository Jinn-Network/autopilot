import type { IssueRelaySnapshotV1 } from './snapshot.js';
import { relayTaskKey } from './identity.js';

export type RelayPhase =
  | 'awaiting-clarification'
  | 'refused'
  | 'admitted'
  | 'submitted'
  | 'solution-delivered'
  | 'draft-open'
  | 'evaluating'
  | 'repair-needed'
  | 'ready'
  | 'cancelling'
  | 'closed'
  | 'exhausted';

export interface RelayRoundRecordV1 {
  readonly round: number;
  readonly purpose: 'initial' | 'repair';
  readonly workspaceRepository: string;
  readonly inputHead: string;
  readonly task?: {
    readonly taskKey: string;
    readonly taskId: string;
    readonly taskCid: string;
    readonly fundedAt: string;
  };
  readonly solution?: {
    readonly envelopeCid: string;
    readonly operatorSafe: string;
    readonly observedAt: string;
  };
  readonly adoption?: {
    readonly disposition: 'accepted' | 'rejected';
    readonly resultingHead?: string;
    readonly receiptDigest: `sha256:${string}`;
  };
  readonly checks?: {
    readonly head: string;
    readonly status: 'pending' | 'passed' | 'failed';
    readonly digest: `sha256:${string}`;
  };
  readonly verdict?: {
    readonly outcome: 'pass' | 'request-changes' | 'human' | 'unresolved';
    readonly evaluatedHead: string;
    readonly envelopeCid: string;
  };
}

export interface RelayGenerationRecordV1 {
  readonly schemaVersion: 'jinn-issue-relay-generation.v1';
  readonly generation: string;
  readonly snapshot: IssueRelaySnapshotV1;
  readonly phase: RelayPhase;
  /**
   * Absolute generation cutoff, derived once when the generation is admitted.
   * Recovery and continuation must use this durable instant verbatim.
   */
  readonly deadlineAt: string;
  readonly rounds: readonly RelayRoundRecordV1[];
  readonly pr?: {
    readonly number: number;
    readonly branch: string;
    readonly head: string;
    readonly draft: boolean;
  };
  readonly cancellation?: {
    readonly requestedAt: string;
    readonly reason: 'issue-closed' | 'label-removed' | 'operator';
  };
  readonly updatedAt: string;
}

export type RelayAction =
  | { readonly kind: 'publish-snapshot' }
  | { readonly kind: 'submit-round'; readonly round: number }
  | { readonly kind: 'observe-solution'; readonly round: number }
  | { readonly kind: 'adopt-solution'; readonly round: number }
  | { readonly kind: 'publish-evaluation-anchor'; readonly round: number }
  | { readonly kind: 'observe-verdict'; readonly round: number }
  | { readonly kind: 'submit-repair'; readonly round: number }
  | { readonly kind: 'mark-ready' }
  | { readonly kind: 'finish-cancellation' }
  | { readonly kind: 'close-exhausted' }
  | { readonly kind: 'none'; readonly reason: string };

export interface RelayAuthoritativeFacts {
  readonly durable?: RelayGenerationRecordV1;
  readonly issue: {
    readonly open: boolean;
    readonly optedIn: boolean;
  };
  readonly currentBaseOid: string;
  readonly currentPr?: {
    readonly number: number;
    readonly head: string;
    readonly draft: boolean;
  };
  readonly now: string;
}

export interface RelayDerivationPolicy {
  readonly maxRoundsPerGeneration: number;
  readonly generationDeadlineMs: number;
}

const CANONICAL_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const GIT_OID_PATTERN = /^[0-9a-f]{40}$/;

function none(reason: string): RelayAction {
  return { kind: 'none', reason };
}

function canonicalUtcTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !CANONICAL_UTC_PATTERN.test(value)) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : undefined;
}

function exhaustiveNone(value: never): RelayAction {
  return none(`Unsupported Relay discriminant: ${String(value)}`);
}

function exhaustiveFalse(_value: never): false {
  return false;
}

function policyIsValid(policy: RelayDerivationPolicy): boolean {
  return Number.isSafeInteger(policy.maxRoundsPerGeneration)
    && policy.maxRoundsPerGeneration >= 0
    && Number.isSafeInteger(policy.generationDeadlineMs)
    && policy.generationDeadlineMs > 0;
}

function durableShapeIsConsistent(record: RelayGenerationRecordV1): boolean {
  if (
    record.schemaVersion !== 'jinn-issue-relay-generation.v1'
    || typeof record.generation !== 'string'
    || record.generation.length === 0
    || !Array.isArray(record.rounds)
  ) {
    return false;
  }
  return record.rounds.every((round, index) => {
    if (
      round.round !== index
      || round.purpose !== (index === 0 ? 'initial' : 'repair')
      || !GIT_OID_PATTERN.test(round.inputHead)
    ) {
      return false;
    }
    if (
      round.task !== undefined
      && round.task.taskKey !== relayTaskKey(record.generation, round.round)
    ) {
      return false;
    }
    if (round.solution !== undefined && round.task === undefined) return false;
    if (round.adoption !== undefined && round.solution === undefined) return false;
    if (
      round.adoption?.disposition === 'accepted'
      && round.adoption.resultingHead === undefined
    ) {
      return false;
    }
    if (
      round.adoption?.disposition === 'rejected'
      && round.adoption.resultingHead !== undefined
    ) {
      return false;
    }
    if (
      round.checks !== undefined
      && (
        round.adoption?.disposition !== 'accepted'
        || round.adoption.resultingHead !== round.checks.head
      )
    ) {
      return false;
    }
    if (
      round.verdict !== undefined
      && (
        round.checks?.status !== 'passed'
        || round.verdict.evaluatedHead !== round.checks.head
      )
    ) {
      return false;
    }
    return index === 0
      || record.rounds[index - 1]?.verdict?.outcome === 'request-changes';
  });
}

function latestRound(
  record: RelayGenerationRecordV1,
): RelayRoundRecordV1 | undefined {
  return record.rounds.at(-1);
}

function hasFundedWork(record: RelayGenerationRecordV1): boolean {
  return record.rounds.some(({ task }) => task !== undefined);
}

function roundInputIsCurrent(
  facts: RelayAuthoritativeFacts,
  round: RelayRoundRecordV1,
): boolean {
  switch (round.purpose) {
    case 'initial':
      return round.inputHead === facts.currentBaseOid;
    case 'repair':
      return facts.currentPr !== undefined
        && round.inputHead === facts.currentPr.head;
    default:
      return exhaustiveFalse(round.purpose);
  }
}

function livePrMatchesDurable(facts: RelayAuthoritativeFacts): boolean {
  const durablePr = facts.durable?.pr;
  const livePr = facts.currentPr;
  return durablePr !== undefined
    && livePr !== undefined
    && durablePr.number === livePr.number
    && durablePr.head === livePr.head
    && durablePr.draft === livePr.draft
    && durablePr.draft;
}

function acceptedExactHead(
  facts: RelayAuthoritativeFacts,
  round: RelayRoundRecordV1,
): boolean {
  if (
    round.adoption?.disposition !== 'accepted'
    || round.adoption.resultingHead === undefined
    || round.checks === undefined
    || facts.durable?.pr === undefined
    || !livePrMatchesDurable(facts)
    || facts.currentBaseOid !== facts.durable.snapshot.repository.baseOid
  ) {
    return false;
  }
  return round.adoption.resultingHead === round.checks.head
    && round.checks.head === facts.durable.pr.head;
}

function deriveDraftOpenAction(
  facts: RelayAuthoritativeFacts,
  round: RelayRoundRecordV1 | undefined,
): RelayAction {
  if (round === undefined || !acceptedExactHead(facts, round)) {
    return none('Accepted adoption and an exact live PR head are required');
  }
  const checksStatus = round.checks?.status;
  switch (checksStatus) {
    case 'passed':
      return { kind: 'publish-evaluation-anchor', round: round.round };
    case 'pending':
      return none('Exact-head checks are still pending');
    case 'failed':
      return none('Exact-head checks failed');
    case undefined:
      return none('Exact-head checks are missing');
    default:
      return exhaustiveNone(checksStatus);
  }
}

function deriveEvaluatingAction(
  facts: RelayAuthoritativeFacts,
  round: RelayRoundRecordV1 | undefined,
): RelayAction {
  if (
    round === undefined
    || !acceptedExactHead(facts, round)
    || round.checks?.status !== 'passed'
  ) {
    return none('Evaluation requires accepted adoption and passed exact-head checks');
  }
  if (round.verdict === undefined) {
    return { kind: 'observe-verdict', round: round.round };
  }
  if (round.verdict.evaluatedHead !== round.checks.head) {
    return none('Verdict head is stale');
  }
  switch (round.verdict.outcome) {
    case 'pass':
      return { kind: 'mark-ready' };
    case 'request-changes':
      return none('Request-changes verdict must enter repair-needed');
    case 'human':
      return none('Verdict requires Human judgment');
    case 'unresolved':
      return none('Verdict is unresolved');
    default:
      return exhaustiveNone(round.verdict.outcome);
  }
}

function deriveRepairAction(
  facts: RelayAuthoritativeFacts,
  policy: RelayDerivationPolicy,
  deadlineMs: number,
  nowMs: number,
  round: RelayRoundRecordV1 | undefined,
): RelayAction {
  if (
    round?.verdict?.outcome !== 'request-changes'
    || round.checks?.status !== 'passed'
    || round.verdict.evaluatedHead !== round.checks.head
    || !acceptedExactHead(facts, round)
  ) {
    return none('Repair requires an exact-head request-changes verdict');
  }
  const nextRound = round.round + 1;
  if (nextRound >= policy.maxRoundsPerGeneration || nowMs >= deadlineMs) {
    return { kind: 'close-exhausted' };
  }
  return { kind: 'submit-repair', round: nextRound };
}

/**
 * Derives at most one next action from durable GitHub-authored evidence.
 * The function is intentionally I/O-free; callers must reread facts after
 * executing any returned side effect.
 */
export function deriveRelayAction(
  facts: RelayAuthoritativeFacts,
  policy: RelayDerivationPolicy,
): RelayAction {
  if (!policyIsValid(policy)) return none('Invalid Relay derivation policy');
  const nowMs = canonicalUtcTimestamp(facts.now);
  if (nowMs === undefined) return none('Current time is not canonical UTC');
  if (!GIT_OID_PATTERN.test(facts.currentBaseOid)) {
    return none('Current base head is invalid');
  }

  const record = facts.durable;
  if (record === undefined) {
    return facts.issue.open && facts.issue.optedIn
      ? { kind: 'publish-snapshot' }
      : none('Issue is not an active Relay candidate');
  }

  const deadlineMs = canonicalUtcTimestamp(record.deadlineAt);
  if (deadlineMs === undefined || !durableShapeIsConsistent(record)) {
    return none('Durable Relay evidence is malformed or contradictory');
  }

  switch (record.phase) {
    case 'awaiting-clarification':
    case 'refused':
    case 'ready':
    case 'closed':
    case 'exhausted':
      return none(`Relay phase ${record.phase} is terminal`);
    case 'admitted':
    case 'submitted':
    case 'solution-delivered':
    case 'draft-open':
    case 'evaluating':
    case 'repair-needed':
    case 'cancelling':
      break;
    default:
      return exhaustiveNone(record.phase);
  }

  const funded = hasFundedWork(record);
  if (
    record.phase === 'cancelling'
    || record.cancellation !== undefined
    || ((!facts.issue.open || !facts.issue.optedIn) && funded)
  ) {
    return funded
      ? { kind: 'finish-cancellation' }
      : none('Cancellation has no funded settlement path');
  }
  if (!facts.issue.open || !facts.issue.optedIn) {
    return none('Issue authority ended before funding');
  }

  const round = latestRound(record);
  switch (record.phase) {
    case 'admitted':
      if (record.rounds.length !== 0) {
        return none('Admitted generation has contradictory round evidence');
      }
      if (record.snapshot.repository.baseOid !== facts.currentBaseOid) {
        return none('Snapshot base head is stale');
      }
      return policy.maxRoundsPerGeneration === 0 || nowMs >= deadlineMs
        ? { kind: 'close-exhausted' }
        : { kind: 'submit-round', round: 0 };
    case 'submitted':
      if (
        round?.task === undefined
        || round.solution !== undefined
        || !roundInputIsCurrent(facts, round)
      ) {
        return none('Submitted round lacks current funded task evidence');
      }
      return { kind: 'observe-solution', round: round.round };
    case 'solution-delivered':
      if (
        round?.task === undefined
        || round.solution === undefined
        || round.adoption !== undefined
        || !roundInputIsCurrent(facts, round)
      ) {
        return none('Authenticated current-head solution delivery is missing');
      }
      return { kind: 'adopt-solution', round: round.round };
    case 'draft-open':
      return deriveDraftOpenAction(facts, round);
    case 'evaluating':
      return deriveEvaluatingAction(facts, round);
    case 'repair-needed':
      return deriveRepairAction(facts, policy, deadlineMs, nowMs, round);
    default:
      return exhaustiveNone(record.phase);
  }
}
