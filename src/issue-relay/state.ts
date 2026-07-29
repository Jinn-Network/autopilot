import { isDeepStrictEqual } from 'node:util';
import type { IssueRelaySnapshotV1 } from './snapshot.js';
import { relayTaskKey } from './identity.js';
import type { AcceptedRelayAdoption } from './adoption.js';
import {
  IssueRelayAdoptionReceiptV1Schema,
  IssueRelayEvaluationAnchorV1Schema,
  IssueRelayFindingV1Schema,
  type IssueRelayEvaluationAnchorV1,
  type IssueRelayFindingV1,
} from './contracts.js';
import {
  parseIssueRelayDeliveryObservation,
  type VerifiedIssueRelayVerdictObservation,
} from './marketplace-cli.js';
import {
  relayAdoptionReceiptDigest,
  relayRequiredCheckStatus,
  verifyRelayCheckSummary,
  type RelayCheckSummary,
} from './checks.js';

export type RelayPhase =
  | 'awaiting-clarification'
  | 'refused'
  | 'admitted'
  | 'funding'
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
  /** Durable task input needed to reconstruct a repair after local-state loss. */
  readonly findings?: readonly IssueRelayFindingV1[];
  readonly prNumber?: number;
  readonly fundingIntent?: {
    readonly taskKey: string;
    readonly creatorSafe: string;
    readonly solverNetManifestCid: string;
    readonly requestDigest: `sha256:${string}`;
    readonly maximumSpendWei: string;
    readonly spendWei: string;
    readonly preparedAt: string;
  };
  readonly task?: {
    readonly taskKey: string;
    readonly taskId: string;
    readonly taskCid: string;
    /** Exact dry-run/funding-fenced amount, persisted as canonical uint256 text. */
    readonly spendWei: string;
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
    readonly targetRepository?: string;
    readonly targetRepositoryId?: string;
    readonly forkRepository?: string;
    readonly forkRepositoryId?: string;
    readonly forkParentRepositoryId?: string;
    readonly visibility?: 'PUBLIC' | 'PRIVATE' | 'INTERNAL';
    readonly managedFork?: boolean;
  };
  readonly cancellation?: {
    readonly requestedAt: string;
    readonly reason: 'issue-closed' | 'label-removed' | 'operator';
  };
  readonly updatedAt: string;
}

export type RelayCancellationReason =
  | 'issue-closed'
  | 'label-removed'
  | 'operator';

export type RelayAction =
  | { readonly kind: 'publish-snapshot' }
  | { readonly kind: 'prepare-round'; readonly round: number }
  | {
      readonly kind: 'record-cancellation';
      readonly reason: RelayCancellationReason;
    }
  | { readonly kind: 'submit-round'; readonly round: number }
  | { readonly kind: 'observe-solution'; readonly round: number }
  | { readonly kind: 'adopt-solution'; readonly round: number }
  | { readonly kind: 'observe-checks'; readonly round: number }
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
    readonly branch: string;
    readonly head: string;
    readonly base: string;
    readonly open: boolean;
    readonly draft: boolean;
    readonly generation: string;
  };
  readonly readiness?: RelayReadyEvidence;
  readonly operatorCancellationRequested?: boolean;
  readonly now: string;
}

export interface RelayReadyEvidence {
  readonly adoption: AcceptedRelayAdoption;
  readonly checks: RelayCheckSummary;
  readonly evaluationAnchor?: IssueRelayEvaluationAnchorV1;
  readonly verdict?: VerifiedIssueRelayVerdictObservation;
}

export interface RelayReadyInput extends RelayReadyEvidence {
  readonly currentHead: string;
  readonly currentBaseOid: string;
  readonly targetBase: string;
  readonly draft?: {
    readonly number: number;
    readonly branch: string;
    readonly head: string;
    readonly base: string;
    readonly open: boolean;
    readonly draft: boolean;
    readonly generation: string;
  };
  readonly cancelled: boolean;
  readonly exhausted: boolean;
}

export type RelayReadyDecision =
  | { readonly ready: true; readonly head: string }
  | {
      readonly ready: false;
      readonly reason:
        | 'draft-missing'
        | 'checks-pending'
        | 'checks-failed'
        | 'verdict-pending'
        | 'verdict-failed'
        | 'stale-head'
        | 'stale-base'
        | 'cancelled'
        | 'exhausted';
    };

export interface RelayDerivationPolicy {
  readonly maxRoundsPerGeneration: number;
  readonly generationDeadlineMs: number;
}

const CANONICAL_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const GIT_OID_PATTERN = /^[0-9a-f]{40}$/;
const CANONICAL_POSITIVE_WEI_PATTERN = /^[1-9][0-9]*$/;
const UINT256_MAX = (1n << 256n) - 1n;

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
    const expectedTaskKey = relayTaskKey(record.generation, round.round);
    const intent = round.fundingIntent;
    if (
      (
        round.purpose === 'initial'
        && (
          (round.findings !== undefined && round.findings.length !== 0)
          || round.prNumber !== undefined
        )
      )
      || (
        round.purpose === 'repair'
        && intent !== undefined
        && (
          round.findings === undefined
          || round.findings.length === 0
          || !round.findings.every((finding: IssueRelayFindingV1) =>
            IssueRelayFindingV1Schema.safeParse(finding).success)
          || round.prNumber === undefined
        )
      )
    ) {
      return false;
    }
    if (intent !== undefined && (
      intent.taskKey !== expectedTaskKey
      || !/^0x[0-9a-fA-F]{40}$/.test(intent.creatorSafe)
      || intent.solverNetManifestCid.length === 0
      || !/^sha256:[0-9a-f]{64}$/.test(intent.requestDigest)
      || !CANONICAL_POSITIVE_WEI_PATTERN.test(intent.maximumSpendWei)
      || !CANONICAL_POSITIVE_WEI_PATTERN.test(intent.spendWei)
      || BigInt(intent.maximumSpendWei) > UINT256_MAX
      || BigInt(intent.spendWei) > BigInt(intent.maximumSpendWei)
      || canonicalUtcTimestamp(intent.preparedAt) === undefined
    )) {
      return false;
    }
    if (round.task !== undefined && (
      round.task.taskKey !== expectedTaskKey
      || (
        intent !== undefined
        && (
          round.task.taskKey !== intent.taskKey
          || round.task.spendWei !== intent.spendWei
        )
      )
      || !CANONICAL_POSITIVE_WEI_PATTERN.test(round.task.spendWei)
      || BigInt(round.task.spendWei) > UINT256_MAX
    )) {
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
      || (
        record.rounds[index - 1]?.verdict?.outcome === 'request-changes'
        && record.rounds[index - 1]?.verdict?.evaluatedHead === round.inputHead
        && record.rounds[index - 1]?.adoption?.disposition === 'accepted'
        && record.rounds[index - 1]?.adoption?.resultingHead === round.inputHead
      );
  });
}

function latestRound(
  record: RelayGenerationRecordV1,
): RelayRoundRecordV1 | undefined {
  return record.rounds.at(-1);
}

export function persistRelayCancellation(
  record: RelayGenerationRecordV1,
  input: {
    readonly requestedAt: string;
    readonly reason: RelayCancellationReason;
  },
): RelayGenerationRecordV1 {
  const requestedAt = canonicalUtcTimestamp(input.requestedAt);
  const updatedAt = canonicalUtcTimestamp(record.updatedAt);
  if (requestedAt === undefined || updatedAt === undefined) {
    throw new TypeError('Relay cancellation intent is stale or not persistable');
  }
  if (record.cancellation !== undefined) {
    if (
      record.phase === 'cancelling'
      && record.updatedAt === input.requestedAt
      && record.cancellation.requestedAt === input.requestedAt
      && record.cancellation.reason === input.reason
    ) {
      return record;
    }
    throw new TypeError('Relay cancellation intent is contradictory');
  }
  if (
    requestedAt <= updatedAt
    || ['awaiting-clarification', 'refused', 'ready', 'closed', 'exhausted']
      .includes(record.phase)
  ) {
    throw new TypeError('Relay cancellation intent is stale or not persistable');
  }
  return {
    ...record,
    phase: 'cancelling',
    cancellation: {
      requestedAt: input.requestedAt,
      reason: input.reason,
    },
    updatedAt: input.requestedAt,
  };
}

function roundInputIsCurrent(
  facts: RelayAuthoritativeFacts,
  round: RelayRoundRecordV1,
): boolean {
  switch (round.purpose) {
    case 'initial':
      return round.inputHead === facts.currentBaseOid;
    case 'repair':
      return livePrMatchesDurable(facts)
        && facts.currentPr?.head === round.inputHead
        && facts.durable?.pr?.head === round.inputHead;
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
    && durablePr.branch === livePr.branch
    && durablePr.head === livePr.head
    && durablePr.draft === livePr.draft
    && livePr.open
    && livePr.base === facts.durable?.snapshot.repository.defaultBranch
    && livePr.generation === facts.durable?.generation
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

function acceptedLiveHead(
  facts: RelayAuthoritativeFacts,
  round: RelayRoundRecordV1,
): boolean {
  return round.adoption?.disposition === 'accepted'
    && round.adoption.resultingHead !== undefined
    && facts.durable?.pr !== undefined
    && livePrMatchesDurable(facts)
    && facts.currentBaseOid === facts.durable.snapshot.repository.baseOid
    && round.adoption.resultingHead === facts.durable.pr.head;
}

function notReady(reason: Exclude<RelayReadyDecision, { readonly ready: true }>['reason']):
RelayReadyDecision {
  return { ready: false, reason };
}

/**
 * Makes no mutations. It accepts only the exact live draft/base facts and the
 * authenticated evidence installed for the same adopted head.
 */
export function deriveRelayReady(input: RelayReadyInput): RelayReadyDecision {
  if (input.cancelled) return notReady('cancelled');
  if (input.exhausted) return notReady('exhausted');

  const adoptionRecord = input.adoption as unknown;
  if (
    adoptionRecord === null
    || typeof adoptionRecord !== 'object'
    || Array.isArray(adoptionRecord)
  ) {
    return notReady('verdict-failed');
  }
  const adoptionCandidate = adoptionRecord as Partial<AcceptedRelayAdoption>;
  const receiptResult = IssueRelayAdoptionReceiptV1Schema.safeParse(
    adoptionCandidate.receipt,
  );
  if (
    adoptionCandidate.status !== 'accepted'
    || typeof adoptionCandidate.branch !== 'string'
    || typeof adoptionCandidate.resultingHead !== 'string'
    || !Number.isSafeInteger(adoptionCandidate.prNumber)
    || receiptResult.success === false
    || receiptResult.data.disposition !== 'accepted'
  ) {
    return notReady('verdict-failed');
  }
  const adoption = adoptionCandidate as AcceptedRelayAdoption;
  const receipt = receiptResult.data as AcceptedRelayAdoption['receipt'];

  let anchor: IssueRelayEvaluationAnchorV1 | undefined;
  if (input.evaluationAnchor !== undefined) {
    const anchorResult = IssueRelayEvaluationAnchorV1Schema.safeParse(
      input.evaluationAnchor,
    );
    if (anchorResult.success === false) return notReady('verdict-failed');
    anchor = anchorResult.data as IssueRelayEvaluationAnchorV1;
  }

  let verdict: VerifiedIssueRelayVerdictObservation | undefined;
  let verdictState: 'missing' | 'pending' | 'failed' | 'verified' =
    input.verdict === undefined ? 'missing' : 'failed';
  if (input.verdict !== undefined) {
    try {
      const observation = parseIssueRelayDeliveryObservation(input.verdict);
      if (observation.status === 'pending') {
        verdictState = 'pending';
      } else if (
        observation.status === 'verified'
        && observation.role === 'verdict'
      ) {
        verdict = observation;
        verdictState = 'verified';
      }
    } catch {
      verdictState = 'failed';
    }
  }

  if (
    input.draft === undefined
    || !input.draft.open
    || !input.draft.draft
    || input.draft.number !== adoption.prNumber
  ) {
    return notReady('draft-missing');
  }

  const heads = [
    input.currentHead,
    input.draft.head,
    adoption.resultingHead,
    receipt.resultingHead,
    input.checks.head,
    ...(anchor === undefined ? [] : [anchor.evaluatedHead]),
    ...(verdict === undefined ? [] : [verdict.payload.evaluatedHead]),
  ];
  if (
    !heads.every((head) => GIT_OID_PATTERN.test(head))
    || heads.some((head) => head !== input.currentHead)
    || adoption.branch !== receipt.headRef
    || adoption.prNumber !== receipt.prNumber
    || input.draft.branch !== receipt.headRef
    || input.draft.generation !== receipt.correlation.generation
  ) {
    return notReady('stale-head');
  }
  if (
    input.targetBase.length === 0
    || input.draft.base !== input.targetBase
    || !GIT_OID_PATTERN.test(input.currentBaseOid)
  ) {
    return notReady('stale-base');
  }

  try {
    verifyRelayCheckSummary(input.checks);
  } catch {
    return notReady('checks-failed');
  }
  const checkStatus = relayRequiredCheckStatus(input.checks);
  if (checkStatus === 'failed') return notReady('checks-failed');
  if (checkStatus === 'pending') return notReady('checks-pending');
  if (anchor === undefined) return notReady('verdict-pending');
  if (
    anchor.targetBase !== input.targetBase
    || !GIT_OID_PATTERN.test(anchor.baseOid)
    || input.currentBaseOid !== anchor.baseOid
  ) {
    return notReady('stale-base');
  }
  if (anchor.checksDigest !== input.checks.digest) {
    return notReady('checks-failed');
  }
  if (
    anchor.adoptionReceiptDigest !== relayAdoptionReceiptDigest({
      ...adoption,
      receipt,
    })
    || !isDeepStrictEqual(anchor.correlation, receipt.correlation)
    || anchor.targetRepository !== receipt.targetRepository
    || anchor.workspaceRepository !== receipt.workspaceRepository
    || anchor.prNumber !== receipt.prNumber
    || anchor.headRef !== receipt.headRef
  ) {
    return notReady('verdict-failed');
  }
  if (verdictState === 'missing' || verdictState === 'pending') {
    return notReady('verdict-pending');
  }
  if (verdictState === 'failed' || verdict === undefined) {
    return notReady('verdict-failed');
  }
  if (
    verdict.payload.outcome !== 'pass'
    || verdict.attempt.operator.toLocaleLowerCase('en-US')
      === receipt.solutionSafe.toLocaleLowerCase('en-US')
    || verdict.task.taskId !== receipt.correlation.taskId
    || verdict.attempt.attemptIndex !== receipt.correlation.attemptIndex
    || verdict.attempt.requestId !== receipt.correlation.requestId
    || !isDeepStrictEqual(verdict.payload.correlation, receipt.correlation)
    || verdict.round.generation !== receipt.correlation.generation
    || verdict.round.round !== receipt.correlation.round
    || verdict.round.snapshotDigest !== receipt.correlation.snapshotDigest
    || verdict.round.targetRepository !== receipt.targetRepository
    || verdict.round.workspaceRepository !== receipt.workspaceRepository
    || verdict.round.inputHead !== receipt.inputHead
  ) {
    return notReady('verdict-failed');
  }
  return { ready: true, head: input.currentHead };
}

function readinessMatchesRound(
  facts: RelayAuthoritativeFacts,
  round: RelayRoundRecordV1,
): boolean {
  const evidence = facts.readiness;
  const durableVerdict = round.verdict;
  if (
    evidence === undefined
    || durableVerdict === undefined
    || facts.currentPr === undefined
  ) {
    return false;
  }
  const decision = deriveRelayReady({
    currentHead: facts.currentPr.head,
    currentBaseOid: facts.currentBaseOid,
    targetBase: facts.durable?.snapshot.repository.defaultBranch ?? '',
    draft: facts.currentPr,
    adoption: evidence.adoption,
    checks: evidence.checks,
    evaluationAnchor: evidence.evaluationAnchor,
    verdict: evidence.verdict,
    cancelled: facts.durable?.cancellation !== undefined,
    exhausted: facts.durable?.phase === 'exhausted',
  });
  return decision.ready
    && evidence.adoption.receipt.correlation.generation
      === facts.durable?.generation
    && facts.currentPr.generation === facts.durable?.generation
    && facts.currentPr.base === facts.durable?.snapshot.repository.defaultBranch
    && facts.currentPr.branch === facts.durable?.pr?.branch
    && evidence.adoption.receipt.correlation.round === round.round
    && evidence.adoption.receipt.correlation.taskId === round.task?.taskId
    && evidence.verdict?.task.taskCid === round.task?.taskCid
    && evidence.adoption.receipt.correlation.deliveryEnvelopeCid
      === round.solution?.envelopeCid
    && evidence.adoption.receipt.solutionSafe.toLocaleLowerCase('en-US')
      === round.solution?.operatorSafe.toLocaleLowerCase('en-US')
    && evidence.evaluationAnchor?.adoptionReceiptDigest
      === round.adoption?.receiptDigest
    && evidence.evaluationAnchor?.checksDigest === round.checks?.digest
    && evidence.verdict?.delivery.envelopeCid === durableVerdict.envelopeCid;
}

function deriveDraftOpenAction(
  facts: RelayAuthoritativeFacts,
  round: RelayRoundRecordV1 | undefined,
): RelayAction {
  if (round === undefined || !acceptedLiveHead(facts, round)) {
    return none('Accepted adoption and an exact live PR head are required');
  }
  const checksStatus = round.checks?.status;
  switch (checksStatus) {
    case 'passed':
      return { kind: 'publish-evaluation-anchor', round: round.round };
    case 'pending':
      return { kind: 'observe-checks', round: round.round };
    case 'failed':
      return none('Exact-head checks failed');
    case undefined:
      return { kind: 'observe-checks', round: round.round };
    default:
      return exhaustiveNone(checksStatus);
  }
}

function deriveEvaluatingAction(
  facts: RelayAuthoritativeFacts,
  round: RelayRoundRecordV1 | undefined,
): RelayAction {
  const readyMutationRecovery =
    round?.verdict?.outcome === 'pass'
    && facts.currentPr?.open === true
    && facts.currentPr.draft === false
    && readinessMatchesRound({
      ...facts,
      currentPr: { ...facts.currentPr, draft: true },
    }, round);
  if (readyMutationRecovery) {
    return { kind: 'mark-ready' };
  }
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
      return readinessMatchesRound(facts, round)
        ? { kind: 'mark-ready' }
        : none('Authenticated exact-head readiness evidence is missing');
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
  return { kind: 'prepare-round', round: nextRound };
}

function deriveCancellationSettlement(
  record: RelayGenerationRecordV1,
): RelayAction {
  const fundedRound = [...record.rounds].reverse()
    .find(({ task }) => task !== undefined);
  if (fundedRound?.task === undefined) {
    return { kind: 'finish-cancellation' };
  }
  if (fundedRound.solution === undefined) {
    return { kind: 'observe-solution', round: fundedRound.round };
  }
  if (fundedRound.adoption === undefined) {
    return { kind: 'adopt-solution', round: fundedRound.round };
  }
  return { kind: 'finish-cancellation' };
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
    case 'funding':
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

  const cancellationReason: RelayCancellationReason | undefined =
    facts.operatorCancellationRequested === true
      ? 'operator'
      : !facts.issue.open
        ? 'issue-closed'
        : !facts.issue.optedIn
          ? 'label-removed'
          : undefined;
  if (
    cancellationReason !== undefined
    && record.cancellation === undefined
  ) {
    return { kind: 'record-cancellation', reason: cancellationReason };
  }
  if (record.phase === 'cancelling' || record.cancellation !== undefined) {
    return deriveCancellationSettlement(record);
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
        : { kind: 'prepare-round', round: 0 };
    case 'funding':
      if (
        round?.fundingIntent === undefined
        || round.task !== undefined
        || !roundInputIsCurrent(facts, round)
      ) {
        return none('Funding requires one exact current durable funding intent');
      }
      return { kind: 'submit-round', round: round.round };
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
