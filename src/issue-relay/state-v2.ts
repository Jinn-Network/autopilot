import { isDeepStrictEqual } from 'node:util';
import {
  IssueRelayDecisionRequestV1Schema,
  IssueRelayEvaluationBundleV2Schema,
  IssueRelayHumanDecisionReceiptV1Schema,
  IssueRelayLaneAttestationV1Schema,
  IssueRelayLaneFailureV1Schema,
  IssueRelayRoundV2Schema,
  issueRelayCanonicalDigest,
  issueRelayDecisionKey,
  issueRelayDecisionRequestDigest,
  type IssueRelayDecisionProposalV1,
  type IssueRelayDecisionRequestV1,
  type IssueRelayCorrelationV1,
  type IssueRelayEvaluationBundleV2,
  type IssueRelayEvaluationLane,
  type IssueRelayHumanDecisionReceiptV1,
  type IssueRelayLaneAttestationV1,
  type IssueRelayLaneFailureV1,
  type IssueRelayLaneFindingV1,
  type IssueRelayRoundV2,
} from './contracts.js';
import {
  buildRelaySnapshot,
  type IssueRelaySnapshotV1,
  type RelayIssueInput,
} from './snapshot.js';
import { relayGeneration } from './identity.js';

export type RelayPhaseV2 =
  | 'awaiting-clarification'
  | 'refused'
  | 'admitted'
  | 'funding'
  | 'submitted'
  | 'solution-delivered'
  | 'draft-open'
  | 'evaluating'
  | 'human-decision-required'
  | 'security-blocked'
  | 'superseded'
  | 'ready'
  | 'cancelling'
  | 'closed'
  | 'exhausted';

export interface RelayLaneAttemptRecordV2 {
  readonly attempt: number;
  readonly head: string;
  readonly evaluatorSafe: string;
  readonly envelopeCid: string;
  readonly correlation: IssueRelayCorrelationV1;
  readonly observationDigest: `sha256:${string}`;
  readonly observation: IssueRelayLaneAttestationV1 | IssueRelayLaneFailureV1;
  readonly observedAt: string;
}

export interface RelayDecisionRecordV2 {
  readonly decisionKey: `sha256:${string}`;
  readonly lane: IssueRelayEvaluationLane;
  readonly proposalDigest: `sha256:${string}`;
  readonly proposal: IssueRelayDecisionProposalV1;
  readonly firstProposedHead: string;
  readonly status: 'queued' | 'active' | 'implementing' | 'resolved' | 'expired' | 'superseded';
  readonly request?: IssueRelayDecisionRequestV1;
  readonly receipt?: IssueRelayHumanDecisionReceiptV1;
  readonly deferrals: number;
  readonly deferralReceipts: readonly IssueRelayHumanDecisionReceiptV1[];
  readonly deferredUntil?: string;
  readonly commissionedOptions: readonly string[];
  readonly implementationRound?: number;
  readonly continuationDeadlineAt?: string;
  readonly resolvedAt?: string;
}

export interface RelayRoundRecordV2 {
  readonly round: number;
  readonly purpose: 'initial' | 'repair' | 'decision-implementation';
  readonly workspaceRepository: string;
  readonly inputHead: string;
  readonly findings?: readonly IssueRelayLaneFindingV1[];
  readonly prNumber?: number;
  readonly decisionBinding?: {
    readonly decisionKey: `sha256:${string}`;
    readonly proposalDigest: `sha256:${string}`;
    readonly requestDigest?: `sha256:${string}`;
    readonly optionId: string;
    readonly authorization:
      | 'repository-policy-safe-preimplementation'
      | 'human-option-intent';
    readonly sourceHead: string;
    readonly frozenImplementationBrief: string;
  };
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
    readonly prNumber?: number;
    readonly receiptDigest: `sha256:${string}`;
    readonly recordedAt?: string;
  };
  readonly checks?: {
    readonly head: string;
    readonly status: 'pending' | 'passed' | 'failed';
    readonly digest: `sha256:${string}`;
    readonly observedAt?: string;
  };
  readonly evaluation?: {
    readonly head: string;
    readonly anchorDigest: `sha256:${string}`;
    readonly anchoredAt: string;
  };
  readonly laneAttempts: {
    readonly security: readonly RelayLaneAttemptRecordV2[];
    readonly quality: readonly RelayLaneAttemptRecordV2[];
  };
}

export interface RelayGenerationRecordV2 {
  readonly schemaVersion: 'jinn-issue-relay-generation.v2';
  readonly generation: string;
  readonly snapshot: IssueRelaySnapshotV1;
  readonly phase: RelayPhaseV2;
  readonly executionDeadlineAt: string;
  readonly rounds: readonly RelayRoundRecordV2[];
  readonly decisions: readonly RelayDecisionRecordV2[];
  readonly predecessor?: {
    readonly generation: string;
    readonly snapshotDigest: `sha256:${string}`;
  };
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
  readonly supersession?: {
    readonly successorGeneration: string;
    readonly successorSnapshotDigest: `sha256:${string}`;
    readonly successorSnapshot: IssueRelaySnapshotV1;
    readonly requestedByReceiptDigest: `sha256:${string}`;
    readonly supersededAt: string;
  };
  readonly updatedAt: string;
}

export interface RelayV2Policy {
  readonly maxRoundsPerGeneration: number;
  readonly maxEvaluationAttemptsPerLanePerHead: number;
  readonly maxDecisionRequestsPerGeneration: number;
  readonly maxDecisionImplementationRoundsPerGeneration: number;
  readonly humanDecisionTtlMs: number;
  readonly maxHumanDeferrals: number;
  readonly humanDeferralExtensionMs: number;
  readonly decisionContinuationDeadlineMs: number;
  readonly implementBeforeDecision: (
    proposal: IssueRelayDecisionProposalV1,
  ) => boolean;
}

export type RelayLaneGateV2 =
  | {
      readonly status: 'evaluator-pass';
      readonly attestationDigest: `sha256:${string}`;
      readonly evaluatorIdentity: string;
    }
  | {
      readonly status: 'authorised-noncritical-exception' | 'authorised-interpretation';
      readonly attestationDigest: `sha256:${string}`;
      readonly decisionReceiptDigest: `sha256:${string}`;
      readonly humanActor: string;
    };

export type RelayV2Aggregation =
  | {
      readonly kind: 'ready';
      readonly security: RelayLaneGateV2;
      readonly quality: RelayLaneGateV2;
    }
  | { readonly kind: 'security-blocked'; readonly attestation: IssueRelayLaneAttestationV1 }
  | { readonly kind: 'repair'; readonly findings: readonly IssueRelayLaneFindingV1[] }
  | { readonly kind: 'retry'; readonly lanes: readonly IssueRelayEvaluationLane[] }
  | { readonly kind: 'operator'; readonly lanes: readonly IssueRelayEvaluationLane[] }
  | {
      readonly kind: 'decision';
      readonly lane: IssueRelayEvaluationLane;
      readonly attestation: IssueRelayLaneAttestationV1;
      readonly decisionKey: `sha256:${string}`;
      readonly record?: RelayDecisionRecordV2;
    }
  | {
      readonly kind: 'decision-implementation';
      readonly lane: IssueRelayEvaluationLane;
      readonly decisionKey: `sha256:${string}`;
      readonly optionId: string;
      readonly authorization:
        | 'repository-policy-safe-preimplementation'
        | 'human-option-intent';
      readonly requestDigest?: `sha256:${string}`;
      readonly implementationBrief: string;
    }
  | { readonly kind: 'cancel'; readonly receipt: IssueRelayHumanDecisionReceiptV1 }
  | { readonly kind: 'supersede'; readonly receipt: IssueRelayHumanDecisionReceiptV1 }
  | { readonly kind: 'deferred'; readonly receipt: IssueRelayHumanDecisionReceiptV1 };

const canonicalUtc = (value: string): boolean => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
};
const gitOid = (value: string): boolean => /^[0-9a-f]{40}$/.test(value);
const safe = (value: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(value);

function currentAttempt(
  round: RelayRoundRecordV2,
  lane: IssueRelayEvaluationLane,
): RelayLaneAttemptRecordV2 | undefined {
  return [...round.laneAttempts[lane]].reverse().find(({ head }) =>
    head === round.checks?.head);
}

function decisionRecord(
  record: RelayGenerationRecordV2,
  decisionKey: string,
): RelayDecisionRecordV2 | undefined {
  return [...record.decisions].reverse().find((decision) =>
    decision.decisionKey === decisionKey && decision.status !== 'superseded');
}

function selectedOption(
  record: RelayDecisionRecordV2 | undefined,
): IssueRelayDecisionProposalV1['options'][number] | undefined {
  const optionId = record?.receipt?.selectedOptionId;
  return optionId === undefined
    ? undefined
    : record?.proposal.options.find((option) => option.optionId === optionId);
}

function humanOutcome(
  lane: IssueRelayEvaluationLane,
  attestation: IssueRelayLaneAttestationV1,
  decision: RelayDecisionRecordV2,
): RelayV2Aggregation | RelayLaneGateV2 | undefined {
  const receiptResult = IssueRelayHumanDecisionReceiptV1Schema.safeParse(decision.receipt);
  if (!receiptResult.success) return undefined;
  const receipt = receiptResult.data as IssueRelayHumanDecisionReceiptV1;
  if (
    receipt.decisionKey !== decision.decisionKey
    || receipt.requestHead !== attestation.evaluatedHead
    || receipt.lane !== lane
  ) return undefined;
  if (receipt.action === 'cancel') return { kind: 'cancel', receipt };
  if (receipt.action === 'clarify-scope') return { kind: 'supersede', receipt };
  if (receipt.action === 'defer') return { kind: 'deferred', receipt };
  const option = selectedOption(decision);
  if (option === undefined) return undefined;
  if (option.effect === 'implement-change') {
    if (decision.commissionedOptions.includes(option.optionId)) return undefined;
    return {
      kind: 'decision-implementation',
      lane,
      decisionKey: decision.decisionKey,
      optionId: option.optionId,
      authorization: 'human-option-intent',
      requestDigest: receipt.requestDigest as `sha256:${string}`,
      implementationBrief: option.implementationBrief!,
    };
  }
  if (receipt.binding !== 'exact-head-acceptance') return undefined;
  if (option.effect === 'cancel') return { kind: 'cancel', receipt };
  if (option.effect === 'clarify-scope') return { kind: 'supersede', receipt };
  const digest = issueRelayCanonicalDigest(attestation);
  if (lane === 'security' && option.effect === 'accept-noncritical-risk') {
    return {
        status: 'authorised-noncritical-exception',
        attestationDigest: digest,
        decisionReceiptDigest: receipt.receiptDigest as `sha256:${string}`,
        humanActor: receipt.actor.githubLogin,
      };
  }
  if (lane === 'quality' && option.effect === 'retain-current-change') {
    return {
        status: 'authorised-interpretation',
        attestationDigest: digest,
        decisionReceiptDigest: receipt.receiptDigest as `sha256:${string}`,
        humanActor: receipt.actor.githubLogin,
      };
  }
  return undefined;
}

/**
 * Mechanically aggregates independently authenticated lane objects. The
 * evaluator's overallProjection is deliberately ignored for readiness.
 */
export function aggregateRelayEvaluationV2(input: {
  readonly record: RelayGenerationRecordV2;
  readonly round: RelayRoundRecordV2;
  readonly exactHead: string;
  readonly exactPullRequestMetadataDigest?: `sha256:${string}`;
  readonly maxAttemptsPerLanePerHead: number;
  readonly allowSafePreimplementation?: (
    proposal: IssueRelayDecisionProposalV1,
  ) => boolean;
}): RelayV2Aggregation {
  const observations = {
    security: currentAttempt(input.round, 'security'),
    quality: currentAttempt(input.round, 'quality'),
  };
  const retry: IssueRelayEvaluationLane[] = [];
  const operator: IssueRelayEvaluationLane[] = [];
  const attestations = {} as Partial<Record<IssueRelayEvaluationLane, IssueRelayLaneAttestationV1>>;
  for (const lane of ['security', 'quality'] as const) {
    const attempt = observations[lane];
    if (attempt === undefined || attempt.head !== input.exactHead) {
      retry.push(lane);
      continue;
    }
    const failure = IssueRelayLaneFailureV1Schema.safeParse(attempt.observation);
    if (failure.success) {
      // The compatibility marketplace path has one finalized evaluation slot.
      // A failure carried by a signed bundle has consumed that slot and cannot
      // be converted into solver repair or silently re-routed. Native component
      // evaluations can later append independently paid attempts.
      operator.push(lane);
      continue;
    }
    const attestation = IssueRelayLaneAttestationV1Schema.safeParse(attempt.observation);
    if (!attestation.success || attestation.data.evaluatedHead !== input.exactHead) {
      operator.push(lane);
      continue;
    }
    attestations[lane] = attestation.data as IssueRelayLaneAttestationV1;
  }
  if (operator.length > 0) return { kind: 'operator', lanes: operator };
  if (retry.length > 0) return { kind: 'retry', lanes: retry };

  const security = attestations.security!;
  const quality = attestations.quality!;
  if (
    security.pullRequestMetadataDigest !== quality.pullRequestMetadataDigest
    || (
      input.exactPullRequestMetadataDigest !== undefined
      && security.pullRequestMetadataDigest
        !== input.exactPullRequestMetadataDigest
    )
  ) {
    return { kind: 'operator', lanes: ['security', 'quality'] };
  }
  if (security.outcome.kind === 'critical-block') {
    return { kind: 'security-blocked', attestation: security };
  }
  if (input.round.purpose === 'decision-implementation') {
    const binding = input.round.decisionBinding;
    const decision = binding === undefined
      ? undefined
      : input.record.decisions.find(({ decisionKey }) =>
        decisionKey === binding.decisionKey);
    const assessment = decision === undefined
      ? undefined
      : attestations[decision.lane]?.decisionAssessment;
    if (
      binding === undefined
      || decision === undefined
      || decision.implementationRound !== input.round.round
      || assessment === undefined
      || assessment.decisionKey !== binding.decisionKey
      || assessment.optionId !== binding.optionId
      || assessment.implementationRound !== input.round.round
    ) {
      return { kind: 'operator', lanes: [decision?.lane ?? 'quality'] };
    }
  }
  const findings = [security, quality].flatMap((attestation) =>
    attestation.outcome.kind === 'changes-required'
      ? attestation.outcome.findings
      : []);
  if (findings.length > 0) return { kind: 'repair', findings };

  let securityGate: RelayLaneGateV2 | undefined;
  let qualityGate: RelayLaneGateV2 | undefined;
  const decisionOrder: Array<[IssueRelayEvaluationLane, IssueRelayLaneAttestationV1]> = [
    ['security', security],
    ['quality', quality],
  ];
  for (const [lane, attestation] of decisionOrder) {
    if (attestation.outcome.kind === 'pass') {
      const gate = {
        status: 'evaluator-pass' as const,
        attestationDigest: issueRelayCanonicalDigest(attestation),
        evaluatorIdentity: observations[lane]!.evaluatorSafe,
      };
      if (lane === 'security') securityGate = gate;
      else qualityGate = gate;
      continue;
    }
    if (attestation.outcome.kind !== 'decision-required') {
      return { kind: 'operator', lanes: [lane] };
    }
    const proposal = attestation.outcome.proposal;
    const key = issueRelayDecisionKey({
      generation: input.record.generation,
      snapshotDigest: input.record.snapshot.snapshotDigest,
      proposal,
    });
    const record = decisionRecord(input.record, key);
    const human = record === undefined ? undefined : humanOutcome(lane, attestation, record);
    if (human !== undefined && 'kind' in human) return human;
    if (human !== undefined) {
      if (lane === 'security') securityGate = human;
      else qualityGate = human;
      continue;
    }
    if (record === undefined && proposal.proposedImplementationPolicy === 'implement-before-decision') {
      const recommended = proposal.options.find(({ optionId }) =>
        optionId === proposal.recommendedOptionId);
      if (
        recommended?.effect === 'implement-change'
        && recommended.implementationBrief !== undefined
        && input.allowSafePreimplementation?.(proposal) === true
      ) {
        return {
          kind: 'decision-implementation',
          lane,
          decisionKey: key,
          optionId: recommended.optionId,
          authorization: 'repository-policy-safe-preimplementation',
          implementationBrief: recommended.implementationBrief,
        };
      }
    }
    return { kind: 'decision', lane, attestation, decisionKey: key, ...(record === undefined ? {} : { record }) };
  }
  if (securityGate !== undefined && qualityGate !== undefined) {
    return { kind: 'ready', security: securityGate, quality: qualityGate };
  }
  return { kind: 'operator', lanes: ['security', 'quality'] };
}

export type RelayActionV2 =
  | { readonly kind: 'publish-generation' }
  | { readonly kind: 'prepare-round'; readonly round: number; readonly purpose: RelayRoundRecordV2['purpose'] }
  | { readonly kind: 'submit-round'; readonly round: number }
  | { readonly kind: 'observe-solution'; readonly round: number }
  | { readonly kind: 'adopt-solution'; readonly round: number }
  | { readonly kind: 'observe-checks'; readonly round: number }
  | { readonly kind: 'publish-evaluation-anchor'; readonly round: number }
  | { readonly kind: 'observe-evaluation-bundle'; readonly round: number }
  | { readonly kind: 'retry-evaluation-lane'; readonly round: number; readonly lane: IssueRelayEvaluationLane }
  | { readonly kind: 'prepare-check-repair'; readonly round: number; readonly failedHead: string; readonly checksDigest: `sha256:${string}` }
  | { readonly kind: 'prepare-combined-repair'; readonly round: number; readonly findings: readonly IssueRelayLaneFindingV1[] }
  | { readonly kind: 'prepare-decision-implementation'; readonly round: number; readonly decisionKey: string; readonly optionId: string }
  | { readonly kind: 'publish-decision-request'; readonly decisionKey: string }
  | { readonly kind: 'record-human-decision'; readonly decisionKey: string }
  | { readonly kind: 'security-blocked' }
  | { readonly kind: 'supersede-generation'; readonly decisionKey: string }
  | { readonly kind: 'finish-supersession' }
  | { readonly kind: 'publish-successor-generation' }
  | { readonly kind: 'mark-ready' }
  | { readonly kind: 'record-cancellation'; readonly reason: 'issue-closed' | 'label-removed' | 'operator' }
  | { readonly kind: 'finish-cancellation' }
  | { readonly kind: 'close-exhausted'; readonly reason: 'deadline' | 'bounds' | 'human-decision-expired' | 'stale-base' }
  | { readonly kind: 'none'; readonly reason: string };

export interface RelayFactsV2 {
  readonly durable?: RelayGenerationRecordV2;
  /** Deterministic admitted record before its first GitHub marker is written. */
  readonly admission?: RelayGenerationRecordV2;
  readonly issue: { readonly open: boolean; readonly optedIn: boolean };
  readonly currentBaseOid: string;
  readonly currentPr?: {
    readonly number: number;
    readonly branch: string;
    readonly head: string;
    readonly base: string;
    readonly open: boolean;
    readonly draft: boolean;
    readonly generation: string;
    readonly pullRequestMetadataDigest: `sha256:${string}`;
  };
  readonly operatorCancellationRequested?: boolean;
  readonly successorPresent?: boolean;
  readonly now: string;
}

function noAction(reason: string): RelayActionV2 {
  return { kind: 'none', reason };
}

function latestRoundV2(record: RelayGenerationRecordV2): RelayRoundRecordV2 | undefined {
  return record.rounds.at(-1);
}

function liveDraftMatchesV2(facts: RelayFactsV2, record: RelayGenerationRecordV2): boolean {
  return facts.currentPr !== undefined
    && record.pr !== undefined
    && facts.currentPr.open
    && facts.currentPr.draft
    && record.pr.draft
    && facts.currentPr.number === record.pr.number
    && facts.currentPr.branch === record.pr.branch
    && facts.currentPr.head === record.pr.head
    && facts.currentPr.generation === record.generation
    && facts.currentPr.base === record.snapshot.repository.defaultBranch;
}

function liveReadyTransitionMatchesV2(
  facts: RelayFactsV2,
  record: RelayGenerationRecordV2,
): boolean {
  return facts.currentPr !== undefined
    && record.pr !== undefined
    && facts.currentPr.open
    && !facts.currentPr.draft
    && record.pr.draft
    && facts.currentPr.number === record.pr.number
    && facts.currentPr.branch === record.pr.branch
    && facts.currentPr.head === record.pr.head
    && facts.currentPr.generation === record.generation
    && facts.currentPr.base === record.snapshot.repository.defaultBranch;
}

/** Pure one-action reconciliation for generation.v2. */
export function deriveRelayActionV2(
  facts: RelayFactsV2,
  policy: RelayV2Policy,
): RelayActionV2 {
  if (!canonicalUtc(facts.now) || !gitOid(facts.currentBaseOid)) {
    return noAction('Relay V2 facts are malformed');
  }
  const record = facts.durable;
  if (record === undefined) {
    return facts.admission !== undefined
      && facts.admission.phase === 'admitted'
      && facts.admission.rounds.length === 0
      && validateRelayGenerationV2(facts.admission)
      ? { kind: 'publish-generation' }
      : noAction('No Relay V2 generation exists');
  }
  if (!validateRelayGenerationV2(record)) return noAction('Relay V2 durable evidence is contradictory');
  if (record.phase === 'superseded') {
    if (facts.currentPr?.open === true) return { kind: 'finish-supersession' };
    return facts.successorPresent === true
      ? noAction('Relay V2 successor generation is durable')
      : { kind: 'publish-successor-generation' };
  }
  if (['awaiting-clarification', 'refused', 'ready', 'closed', 'exhausted'].includes(record.phase)) {
    return noAction(`Relay V2 phase ${record.phase} is terminal`);
  }
  const cancellationReason = facts.operatorCancellationRequested === true
    ? 'operator' as const
    : !facts.issue.open
      ? 'issue-closed' as const
      : !facts.issue.optedIn
        ? 'label-removed' as const
        : undefined;
  if (cancellationReason !== undefined && record.cancellation === undefined) {
    return { kind: 'record-cancellation', reason: cancellationReason };
  }
  if (record.phase === 'cancelling' || record.cancellation !== undefined) {
    return { kind: 'finish-cancellation' };
  }
  if (record.phase === 'security-blocked') {
    const active = record.decisions.find(({ status }) => status === 'active');
    if (active?.request === undefined) {
      return noAction('Critical security block lacks its bounded administrator request');
    }
    if (active.receipt === undefined) {
      if (Date.parse(facts.now) >= Date.parse(active.deferredUntil ?? active.request.expiresAt)) {
        return { kind: 'record-cancellation', reason: 'operator' };
      }
      return { kind: 'record-human-decision', decisionKey: active.decisionKey };
    }
    if (active.receipt.action === 'clarify-scope') {
      return { kind: 'supersede-generation', decisionKey: active.decisionKey };
    }
    if (active.receipt.action === 'cancel') {
      return { kind: 'record-cancellation', reason: 'operator' };
    }
    return noAction('Critical security decision was deferred within its bounded expiry');
  }
  if (facts.currentBaseOid !== record.snapshot.repository.baseOid) {
    return { kind: 'close-exhausted', reason: 'stale-base' };
  }
  const now = Date.parse(facts.now);
  const executionDeadline = Date.parse(record.executionDeadlineAt);
  const round = latestRoundV2(record);

  if (record.phase === 'human-decision-required') {
    const active = record.decisions.find(({ status }) => status === 'active');
    if (active?.request === undefined) return noAction('Active decision request is missing');
    if (active.receipt === undefined) {
      if (now >= Date.parse(active.deferredUntil ?? active.request.expiresAt)) {
        return { kind: 'close-exhausted', reason: 'human-decision-expired' };
      }
      return { kind: 'record-human-decision', decisionKey: active.decisionKey };
    }
    if (
      active.receipt.binding === 'option-intent'
      && (
        active.continuationDeadlineAt === undefined
        || now >= Date.parse(active.continuationDeadlineAt)
      )
    ) {
      return { kind: 'close-exhausted', reason: 'deadline' };
    }
  } else if (now >= executionDeadline) {
    return { kind: 'close-exhausted', reason: 'deadline' };
  }

  switch (record.phase) {
    case 'admitted':
      return record.rounds.length === 0 && policy.maxRoundsPerGeneration > 0
        ? { kind: 'prepare-round', round: 0, purpose: 'initial' }
        : { kind: 'close-exhausted', reason: 'bounds' };
    case 'funding':
      return round?.fundingIntent !== undefined && round.task === undefined
        ? { kind: 'submit-round', round: round.round }
        : noAction('Funding intent is missing or already submitted');
    case 'submitted':
      return round?.task !== undefined && round.solution === undefined
        ? { kind: 'observe-solution', round: round.round }
        : noAction('Submitted round evidence is contradictory');
    case 'solution-delivered':
      return round?.solution !== undefined && round.adoption === undefined
        ? { kind: 'adopt-solution', round: round.round }
        : noAction('Solution delivery evidence is contradictory');
    case 'draft-open':
      if (round === undefined || !liveDraftMatchesV2(facts, record)) {
        return noAction('An exact managed draft is required');
      }
      if (round.checks === undefined || round.checks.status === 'pending') {
        return { kind: 'observe-checks', round: round.round };
      }
      if (round.checks.status === 'failed') {
        return round.round + 1 >= policy.maxRoundsPerGeneration
          ? { kind: 'close-exhausted', reason: 'bounds' }
          : {
              kind: 'prepare-check-repair',
              round: round.round + 1,
              failedHead: round.checks.head,
              checksDigest: round.checks.digest,
            };
      }
      return round.evaluation === undefined
        ? { kind: 'publish-evaluation-anchor', round: round.round }
        : { kind: 'observe-evaluation-bundle', round: round.round };
    case 'evaluating':
    case 'human-decision-required': {
      if (
        round === undefined
        || !(
          liveDraftMatchesV2(facts, record)
          || liveReadyTransitionMatchesV2(facts, record)
        )
        || !relayV2EvidenceIsExact({
          record,
          round,
          currentHead: facts.currentPr!.head,
          currentBase: facts.currentBaseOid,
        })
      ) return noAction('Exact-head adoption, checks, anchor, and draft are required');
      const hasCurrentLaneEvidence = (['security', 'quality'] as const).every((lane) =>
        round.laneAttempts[lane].some(({ head }) => head === facts.currentPr!.head));
      if (!hasCurrentLaneEvidence) {
        return { kind: 'observe-evaluation-bundle', round: round.round };
      }
      const aggregate = aggregateRelayEvaluationV2({
        record,
        round,
        exactHead: facts.currentPr!.head,
        exactPullRequestMetadataDigest:
          facts.currentPr!.pullRequestMetadataDigest,
        maxAttemptsPerLanePerHead: policy.maxEvaluationAttemptsPerLanePerHead,
        allowSafePreimplementation: policy.implementBeforeDecision,
      });
      switch (aggregate.kind) {
        case 'ready': return { kind: 'mark-ready' };
        case 'security-blocked': return { kind: 'security-blocked' };
        case 'repair':
          if (!facts.currentPr!.draft) {
            return noAction('A non-ready evaluation cannot mutate an already-ready pull request');
          }
          return round.round + 1 >= policy.maxRoundsPerGeneration
            ? { kind: 'close-exhausted', reason: 'bounds' }
            : { kind: 'prepare-combined-repair', round: round.round + 1, findings: aggregate.findings };
        case 'retry':
          if (!facts.currentPr!.draft) {
            return noAction('An already-ready pull request has contradictory lane evidence');
          }
          return { kind: 'retry-evaluation-lane', round: round.round, lane: aggregate.lanes[0]! };
        case 'operator': return noAction(`Evaluation operator intervention required for ${aggregate.lanes.join(', ')}`);
        case 'decision': {
          if (!facts.currentPr!.draft) {
            return noAction('An already-ready pull request cannot open a new Relay decision');
          }
          if (aggregate.record?.request !== undefined && aggregate.record.receipt === undefined) {
            return { kind: 'record-human-decision', decisionKey: aggregate.decisionKey };
          }
          if (record.decisions.filter(({ request }) => request !== undefined).length >= policy.maxDecisionRequestsPerGeneration) {
            return { kind: 'close-exhausted', reason: 'bounds' };
          }
          return { kind: 'publish-decision-request', decisionKey: aggregate.decisionKey };
        }
        case 'decision-implementation':
          if (!facts.currentPr!.draft) {
            return noAction('An already-ready pull request cannot commission Relay work');
          }
          return record.rounds.filter(({ purpose }) => purpose === 'decision-implementation').length
              >= policy.maxDecisionImplementationRoundsPerGeneration
            ? { kind: 'close-exhausted', reason: 'bounds' }
            : {
                kind: 'prepare-decision-implementation',
                round: round.round + 1,
                decisionKey: aggregate.decisionKey,
                optionId: aggregate.optionId,
              };
        case 'cancel': return { kind: 'record-cancellation', reason: 'operator' };
        case 'supersede': return { kind: 'supersede-generation', decisionKey: aggregate.receipt.decisionKey };
        case 'deferred': return noAction('Human decision was deferred within its bounded expiry');
      }
    }
    case 'awaiting-clarification':
    case 'refused':
    case 'ready':
    case 'closed':
    case 'exhausted':
      return noAction(`Relay V2 phase ${record.phase} has no autonomous action`);
  }
}

export function createRelayDecisionRequestV2(input: {
  readonly record: RelayGenerationRecordV2;
  readonly round: RelayRoundRecordV2;
  readonly attestation: IssueRelayLaneAttestationV1;
  readonly implementation: IssueRelayDecisionRequestV1['implementation'];
  readonly now: string;
  readonly ttlMs: number;
}): IssueRelayDecisionRequestV1 {
  if (input.attestation.outcome.kind !== 'decision-required') {
    throw new TypeError('A decision request requires a decision-required attestation');
  }
  if (!canonicalUtc(input.now) || !Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new TypeError('Decision request timing is invalid');
  }
  const proposal = input.attestation.outcome.proposal;
  const decisionKey = issueRelayDecisionKey({
    generation: input.record.generation,
    snapshotDigest: input.record.snapshot.snapshotDigest,
    proposal,
  });
  const requiredRole = input.attestation.lane === 'security'
    ? 'current-repository-admin' as const
    : 'original-authorising-maintainer' as const;
  const unsigned = {
    schemaVersion: 'jinn-issue-relay-decision-request.v1' as const,
    decisionKey,
    generation: input.record.generation,
    round: input.round.round,
    snapshotDigest: input.record.snapshot.snapshotDigest,
    exactHead: input.attestation.evaluatedHead,
    lane: input.attestation.lane,
    proposal,
    effectiveImplementationPolicy: proposal.proposedImplementationPolicy,
    implementation: input.implementation,
    requiredRole,
    allowedActions: ['select-option', 'clarify-scope', 'cancel', 'defer'] as const,
    createdAt: input.now,
    expiresAt: new Date(Date.parse(input.now) + input.ttlMs).toISOString(),
  };
  return IssueRelayDecisionRequestV1Schema.parse({
    ...unsigned,
    requestDigest: issueRelayDecisionRequestDigest(unsigned),
  }) as IssueRelayDecisionRequestV1;
}

export function publishRelayDecisionRequestV2(input: {
  readonly record: RelayGenerationRecordV2;
  readonly round: RelayRoundRecordV2;
  readonly attestation: IssueRelayLaneAttestationV1;
  readonly implementation: IssueRelayDecisionRequestV1['implementation'];
  readonly now: string;
  readonly ttlMs: number;
}): RelayGenerationRecordV2 {
  if (!validateRelayGenerationV2(input.record)) {
    throw new TypeError('Cannot publish a decision from contradictory Relay V2 evidence');
  }
  const request = createRelayDecisionRequestV2(input);
  const active = input.record.decisions.find(({ status }) => status === 'active');
  if (active !== undefined && active.decisionKey !== request.decisionKey) {
    throw new TypeError('Only one Relay V2 decision request may be active');
  }
  const index = input.record.decisions.findIndex(({ decisionKey }) =>
    decisionKey === request.decisionKey);
  const decisions = [...input.record.decisions];
  if (index === -1) {
    decisions.push({
      decisionKey: request.decisionKey as `sha256:${string}`,
      lane: request.lane,
      proposalDigest: issueRelayCanonicalDigest(request.proposal),
      proposal: request.proposal,
      firstProposedHead: request.exactHead,
      status: 'active',
      request,
      deferrals: 0,
      deferralReceipts: [],
      commissionedOptions: [],
    });
  } else {
    const current = decisions[index]!;
    if (current.request !== undefined) {
      if (!isDeepStrictEqual(current.request, request)) {
        throw new TypeError('A Relay V2 decision request cannot be rewritten');
      }
      return input.record.phase === 'human-decision-required'
        ? input.record
        : { ...input.record, phase: 'human-decision-required', updatedAt: input.now };
    }
    if (!['queued', 'implementing'].includes(current.status) || current.receipt !== undefined) {
      throw new TypeError('Resolved Relay V2 decisions cannot be reopened');
    }
    decisions[index] = { ...current, status: 'active', request };
  }
  const next = {
    ...input.record,
    phase: 'human-decision-required' as const,
    decisions,
    updatedAt: input.now,
  };
  if (!validateRelayGenerationV2(next)) {
    throw new TypeError('Published Relay V2 decision evidence is invalid');
  }
  return next;
}

/**
 * Pins a proposal before speculative recommendation implementation. This is
 * deliberately separate from publishing a human request: no human-facing
 * request exists until the implemented head has passed checks and both lanes
 * have reevaluated it.
 */
export function queueRelayDecisionV2(input: {
  readonly record: RelayGenerationRecordV2;
  readonly attestation: IssueRelayLaneAttestationV1;
  readonly now: string;
}): RelayGenerationRecordV2 {
  if (
    !validateRelayGenerationV2(input.record)
    || !canonicalUtc(input.now)
    || input.attestation.outcome.kind !== 'decision-required'
    || input.attestation.evaluatedHead !== input.record.pr?.head
  ) throw new TypeError('Relay V2 decision queue lacks exact-head proposal authority');
  const proposal = input.attestation.outcome.proposal;
  const decisionKey = issueRelayDecisionKey({
    generation: input.record.generation,
    snapshotDigest: input.record.snapshot.snapshotDigest,
    proposal,
  });
  const existing = input.record.decisions.find((decision) =>
    decision.decisionKey === decisionKey);
  if (existing !== undefined) {
    if (
      existing.lane !== input.attestation.lane
      || existing.proposalDigest !== issueRelayCanonicalDigest(proposal)
      || !isDeepStrictEqual(existing.proposal, proposal)
    ) throw new TypeError('Relay V2 decision key collides with a different proposal');
    return input.record;
  }
  const next = {
    ...input.record,
    decisions: [...input.record.decisions, {
      decisionKey: decisionKey as `sha256:${string}`,
      lane: input.attestation.lane,
      proposalDigest: issueRelayCanonicalDigest(proposal),
      proposal,
      firstProposedHead: input.attestation.evaluatedHead,
      status: 'queued' as const,
      deferrals: 0,
      deferralReceipts: [],
      commissionedOptions: [],
    }],
    updatedAt: input.now,
  };
  if (!validateRelayGenerationV2(next)) {
    throw new TypeError('Queued Relay V2 decision evidence is invalid');
  }
  return next;
}

export function publishCriticalSecurityDecisionV2(input: {
  readonly record: RelayGenerationRecordV2;
  readonly attestation: IssueRelayLaneAttestationV1;
  readonly now: string;
  readonly ttlMs: number;
}): RelayGenerationRecordV2 {
  if (
    !validateRelayGenerationV2(input.record)
    || input.record.phase !== 'security-blocked'
    || !canonicalUtc(input.now)
    || !Number.isSafeInteger(input.ttlMs)
    || input.ttlMs <= 0
    || input.attestation.lane !== 'security'
    || input.attestation.outcome.kind !== 'critical-block'
    || input.attestation.evaluatedHead !== input.record.pr?.head
  ) throw new TypeError('Critical security decision lacks exact blocked-head authority');
  const proposal: IssueRelayDecisionProposalV1 = {
    schemaVersion: 'jinn-issue-relay-decision-proposal.v1',
    lane: 'security',
    reasonCode: 'critical-security-block',
    question: 'Should this blocked generation be cancelled or replaced with clarified scope?',
    authorityCategory: 'repository-admin',
    whyHumanAuthorityIsRequired: 'Critical security findings cannot be overridden; an administrator may only cancel or clarify the frozen scope.',
    supportingEvidence: [{
      label: 'Critical security attestation',
      digest: issueRelayCanonicalDigest(input.attestation),
      summary: input.attestation.publicSummary,
    }],
    options: [
      {
        optionId: 'clarify-scope',
        title: 'Clarify scope',
        description: 'Edit the issue into a materially changed safe scope, then create a linked successor generation.',
        effect: 'clarify-scope',
        consequences: ['The blocked draft closes and a new frozen generation may begin.'],
        tradeoffs: ['Existing work and evidence remain only on the blocked predecessor.'],
      },
      {
        optionId: 'cancel',
        title: 'Cancel',
        description: 'Stop this Relay generation without further marketplace spend.',
        effect: 'cancel',
        consequences: ['The blocked draft closes.'],
        tradeoffs: ['No successor work is created.'],
      },
    ],
    recommendedOptionId: 'cancel',
    recommendationRationale: 'A critical security block cannot become review-ready; cancellation is safest unless the issue contract is materially replaced.',
    recommendationConfidence: 'high',
    proposedImplementationPolicy: 'recommendation-only',
  };
  const decisionKey = issueRelayDecisionKey({
    generation: input.record.generation,
    snapshotDigest: input.record.snapshot.snapshotDigest,
    proposal,
  });
  const unsigned = {
    schemaVersion: 'jinn-issue-relay-decision-request.v1' as const,
    decisionKey,
    generation: input.record.generation,
    round: input.attestation.correlation.round,
    snapshotDigest: input.record.snapshot.snapshotDigest,
    exactHead: input.attestation.evaluatedHead,
    lane: 'security' as const,
    proposal,
    effectiveImplementationPolicy: 'recommendation-only' as const,
    implementation: { status: 'not-required' as const },
    requiredRole: 'current-repository-admin' as const,
    allowedActions: ['clarify-scope' as const, 'cancel' as const, 'defer' as const],
    createdAt: input.now,
    expiresAt: new Date(Date.parse(input.now) + input.ttlMs).toISOString(),
  };
  const request = IssueRelayDecisionRequestV1Schema.parse({
    ...unsigned,
    requestDigest: issueRelayDecisionRequestDigest(unsigned),
  }) as IssueRelayDecisionRequestV1;
  const existing = input.record.decisions.find((decision) =>
    decision.decisionKey === decisionKey);
  if (existing !== undefined) {
    if (!isDeepStrictEqual(existing.request, request)) {
      throw new TypeError('Critical security request cannot be rewritten');
    }
    return input.record;
  }
  const next = {
    ...input.record,
    decisions: [...input.record.decisions, {
      decisionKey: decisionKey as `sha256:${string}`,
      lane: 'security' as const,
      proposalDigest: issueRelayCanonicalDigest(proposal),
      proposal,
      firstProposedHead: input.attestation.evaluatedHead,
      status: 'active' as const,
      request,
      deferrals: 0,
      deferralReceipts: [],
      commissionedOptions: [],
    }],
    updatedAt: input.now,
  };
  if (!validateRelayGenerationV2(next)) {
    throw new TypeError('Critical security request produced invalid durable evidence');
  }
  return next;
}

export function recordRelayHumanDecisionV2(input: {
  readonly record: RelayGenerationRecordV2;
  readonly decisionKey: string;
  readonly receipt: IssueRelayHumanDecisionReceiptV1;
  readonly now: string;
  readonly maxDeferrals: number;
  readonly deferralExtensionMs: number;
  readonly decisionContinuationDeadlineMs: number;
}): RelayGenerationRecordV2 {
  const receipt = IssueRelayHumanDecisionReceiptV1Schema.parse(
    input.receipt,
  ) as IssueRelayHumanDecisionReceiptV1;
  if (!canonicalUtc(input.now) || !validateRelayGenerationV2(input.record)) {
    throw new TypeError('Cannot persist a human decision into invalid Relay V2 evidence');
  }
  const index = input.record.decisions.findIndex(({ decisionKey, status }) =>
    decisionKey === input.decisionKey && status === 'active');
  if (index === -1) throw new TypeError('No matching active Relay V2 decision exists');
  const decision = input.record.decisions[index]!;
  if (
    decision.request === undefined
    || receipt.decisionKey !== decision.decisionKey
    || receipt.requestDigest !== decision.request.requestDigest
    || receipt.requestHead !== decision.request.exactHead
    || receipt.lane !== decision.lane
  ) throw new TypeError('Human receipt does not bind the active Relay V2 request');
  const allReceipts = [
    ...decision.deferralReceipts,
    ...(decision.receipt === undefined ? [] : [decision.receipt]),
  ];
  const sameSource = allReceipts.find(({ sourceComment }) =>
    sourceComment.commentId === receipt.sourceComment.commentId);
  if (sameSource !== undefined) {
    if (isDeepStrictEqual(sameSource, receipt)) return input.record;
    throw new TypeError('One PR comment cannot authorize contradictory Relay decisions');
  }
  const decisions = [...input.record.decisions];
  if (receipt.action === 'defer') {
    if (
      decision.receipt !== undefined
      || decision.deferrals >= input.maxDeferrals
      || !Number.isSafeInteger(input.deferralExtensionMs)
      || input.deferralExtensionMs <= 0
    ) throw new TypeError('Relay V2 decision deferral is outside its bound');
    const currentExpiry = Date.parse(decision.deferredUntil ?? decision.request.expiresAt);
    if (Date.parse(receipt.decidedAt) >= currentExpiry) {
      throw new TypeError('Relay V2 decision was deferred after expiry');
    }
    const deferredUntil = new Date(currentExpiry + input.deferralExtensionMs).toISOString();
    decisions[index] = {
      ...decision,
      deferrals: decision.deferrals + 1,
      deferralReceipts: [...decision.deferralReceipts, receipt],
      deferredUntil,
    };
  } else {
    if (decision.receipt !== undefined) {
      if (isDeepStrictEqual(decision.receipt, receipt)) return input.record;
      throw new TypeError('The first durable Relay V2 decision receipt wins');
    }
    if (
      receipt.binding === 'option-intent'
      && (
        !Number.isSafeInteger(input.decisionContinuationDeadlineMs)
        || input.decisionContinuationDeadlineMs <= 0
      )
    ) throw new TypeError('Relay V2 decision continuation deadline is invalid');
    const continuationDeadlineAt = receipt.binding === 'option-intent'
      ? new Date(
          Date.parse(receipt.decidedAt) + input.decisionContinuationDeadlineMs,
        ).toISOString()
      : undefined;
    decisions[index] = {
      ...decision,
      receipt,
      ...(continuationDeadlineAt === undefined ? {} : { continuationDeadlineAt }),
    };
  }
  const next = { ...input.record, decisions, updatedAt: input.now };
  if (!validateRelayGenerationV2(next)) {
    throw new TypeError('Persisted Relay V2 human decision is invalid');
  }
  return next;
}

export function persistRelayFundingIntentV2(input: {
  readonly record: RelayGenerationRecordV2;
  readonly round: IssueRelayRoundV2;
  readonly fundingIntent: NonNullable<RelayRoundRecordV2['fundingIntent']>;
  readonly now: string;
}): RelayGenerationRecordV2 {
  const capsule = IssueRelayRoundV2Schema.parse(input.round) as IssueRelayRoundV2;
  if (
    !validateRelayGenerationV2(input.record)
    || !canonicalUtc(input.now)
    || capsule.generation !== input.record.generation
    || capsule.snapshotDigest !== input.record.snapshot.snapshotDigest
    || capsule.targetRepository !== input.record.snapshot.repository.slug
    || capsule.round !== input.record.rounds.length
    || input.fundingIntent.taskKey
      !== `issue-relay:${input.record.generation}:round:${capsule.round}`
    || !canonicalUtc(input.fundingIntent.preparedAt)
    || !safe(input.fundingIntent.creatorSafe)
  ) throw new TypeError('Relay V2 funding intent is not exact or canonical');
  if (capsule.purpose === 'initial') {
    if (input.record.phase !== 'admitted' || capsule.round !== 0) {
      throw new TypeError('Relay V2 initial funding requires an admitted generation');
    }
  } else if (
    !['evaluating', 'human-decision-required'].includes(input.record.phase)
    || input.record.pr === undefined
    || capsule.workspaceRepository !== input.record.pr.forkRepository
    || capsule.inputHead !== input.record.pr.head
    || capsule.prNumber !== input.record.pr.number
  ) {
    throw new TypeError('Relay V2 continuation funding lacks exact managed-fork authority');
  }
  const decisions = [...input.record.decisions];
  if (capsule.purpose === 'decision-implementation') {
    const index = decisions.findIndex(({ decisionKey }) =>
      decisionKey === capsule.decisionBinding.decisionKey);
    const decision = decisions[index];
    const option = decision?.proposal.options.find(({ optionId }) =>
      optionId === capsule.decisionBinding.optionId);
    if (
      decision === undefined
      || option?.effect !== 'implement-change'
      || option.implementationBrief !== capsule.decisionBinding.frozenImplementationBrief
      || decision.commissionedOptions.includes(option.optionId)
      || (
        capsule.decisionBinding.authorization === 'human-option-intent'
        && (
          decision.receipt?.action !== 'select-option'
          || decision.receipt.selectedOptionId !== option.optionId
          || decision.receipt.binding !== 'option-intent'
          || capsule.decisionBinding.requestDigest !== decision.receipt.requestDigest
        )
      )
    ) throw new TypeError('Relay V2 decision implementation authority is invalid');
    decisions[index] = {
      ...decision,
      status: 'implementing',
      commissionedOptions: [...decision.commissionedOptions, option.optionId],
      implementationRound: capsule.round,
    };
  }
  const durableDecisionBinding: RelayRoundRecordV2['decisionBinding'] =
    capsule.decisionBinding === undefined
      ? undefined
      : {
          decisionKey: capsule.decisionBinding.decisionKey as `sha256:${string}`,
          proposalDigest: capsule.decisionBinding.proposalDigest as `sha256:${string}`,
          optionId: capsule.decisionBinding.optionId,
          authorization: capsule.decisionBinding.authorization,
          sourceHead: capsule.decisionBinding.sourceHead,
          frozenImplementationBrief: capsule.decisionBinding.frozenImplementationBrief,
          ...(capsule.decisionBinding.requestDigest === undefined
            ? {}
            : {
                requestDigest: capsule.decisionBinding.requestDigest as `sha256:${string}`,
              }),
        };
  const round: RelayRoundRecordV2 = {
    round: capsule.round,
    purpose: capsule.purpose,
    workspaceRepository: capsule.workspaceRepository,
    inputHead: capsule.inputHead,
    findings: capsule.findings,
    ...(capsule.prNumber === undefined ? {} : { prNumber: capsule.prNumber }),
    ...(durableDecisionBinding === undefined
      ? {}
      : { decisionBinding: durableDecisionBinding }),
    fundingIntent: input.fundingIntent,
    laneAttempts: { security: [], quality: [] },
  };
  const next = {
    ...input.record,
    phase: 'funding' as const,
    rounds: [...input.record.rounds, round],
    decisions,
    updatedAt: input.now,
  };
  if (!validateRelayGenerationV2(next)) {
    throw new TypeError('Relay V2 funding intent produced invalid durable evidence');
  }
  return next;
}

export function recordRelayEvaluationBundleV2(input: {
  readonly round: RelayRoundRecordV2;
  readonly bundle: IssueRelayEvaluationBundleV2;
  readonly evaluatorSafe: string;
  readonly envelopeCid: string;
  readonly observedAt: string;
}): RelayRoundRecordV2 {
  const bundle = IssueRelayEvaluationBundleV2Schema.parse(input.bundle) as IssueRelayEvaluationBundleV2;
  const correlation = bundle.correlation as IssueRelayCorrelationV1;
  if (
    !safe(input.evaluatorSafe)
    || !canonicalUtc(input.observedAt)
    || input.round.checks?.head !== bundle.evaluatedHead
    || input.round.evaluation?.head !== bundle.evaluatedHead
    || input.round.adoption?.disposition !== 'accepted'
    || bundle.correlation.round !== input.round.round
    || (['security', 'quality'] as const).some((lane) => {
      const observation = bundle.lanes[lane];
      return observation.schemaVersion === 'jinn-issue-relay-lane-attestation.v1'
        && (
          observation.evaluationAnchorDigest !== input.round.evaluation?.anchorDigest
          || observation.adoptionReceiptDigest !== input.round.adoption?.receiptDigest
          || observation.checksDigest !== input.round.checks?.digest
        );
    })
  ) throw new TypeError('Evaluation bundle does not bind the current anchored round head');
  const append = (lane: IssueRelayEvaluationLane): readonly RelayLaneAttemptRecordV2[] => {
    const observation = bundle.lanes[lane];
    const digest = issueRelayCanonicalDigest(observation);
    const prior = input.round.laneAttempts[lane];
    const duplicate = prior.find((entry) =>
      entry.envelopeCid === input.envelopeCid && entry.observationDigest === digest);
    if (duplicate !== undefined) return prior;
    if (prior.some((entry) =>
      entry.envelopeCid === input.envelopeCid && entry.observationDigest !== digest)) {
      throw new TypeError('One authenticated envelope cannot carry contradictory lane evidence');
    }
    return [...prior, {
      attempt: prior.filter(({ head }) => head === bundle.evaluatedHead).length,
      head: bundle.evaluatedHead,
      evaluatorSafe: input.evaluatorSafe,
      envelopeCid: input.envelopeCid,
      correlation,
      observationDigest: digest,
      observation,
      observedAt: input.observedAt,
    }];
  };
  return {
    ...input.round,
    laneAttempts: { security: append('security'), quality: append('quality') },
  };
}

export function relayRoundV2Capsule(
  generation: RelayGenerationRecordV2,
  round: RelayRoundRecordV2,
): IssueRelayRoundV2 {
  return IssueRelayRoundV2Schema.parse({
    schemaVersion: 'jinn-issue-relay-round.v2',
    generation: generation.generation,
    round: round.round,
    snapshotDigest: generation.snapshot.snapshotDigest,
    targetRepository: generation.snapshot.repository.slug,
    workspaceRepository: round.workspaceRepository,
    inputHead: round.inputHead,
    purpose: round.purpose,
    findings: round.findings ?? [],
    ...(round.prNumber === undefined ? {} : { prNumber: round.prNumber }),
    ...(round.decisionBinding === undefined ? {} : { decisionBinding: round.decisionBinding }),
  }) as IssueRelayRoundV2;
}

export function relayV2EvidenceIsExact(input: {
  readonly record: RelayGenerationRecordV2;
  readonly round: RelayRoundRecordV2;
  readonly currentHead: string;
  readonly currentBase: string;
}): boolean {
  const { record, round } = input;
  return gitOid(input.currentHead)
    && gitOid(input.currentBase)
    && input.currentBase === record.snapshot.repository.baseOid
    && record.pr?.draft === true
    && record.pr.head === input.currentHead
    && round.adoption?.disposition === 'accepted'
    && round.adoption.resultingHead === input.currentHead
    && round.checks?.status === 'passed'
    && round.checks.head === input.currentHead
    && round.evaluation?.head === input.currentHead;
}

export function validateRelayGenerationV2(record: RelayGenerationRecordV2): boolean {
  const snapshotIsExact = (snapshot: IssueRelaySnapshotV1): boolean => {
    try {
      const {
        schemaVersion: _schemaVersion,
        snapshotDigest,
        ...input
      } = snapshot;
      return buildRelaySnapshot(input as RelayIssueInput).snapshotDigest
        === snapshotDigest;
    } catch {
      return false;
    }
  };
  if (
    record.schemaVersion !== 'jinn-issue-relay-generation.v2'
    || !snapshotIsExact(record.snapshot)
    || record.generation !== relayGeneration(record.snapshot)
    || !canonicalUtc(record.executionDeadlineAt)
    || !canonicalUtc(record.updatedAt)
    || record.rounds.some((round, index) => round.round !== index)
    || record.decisions.filter(({ status }) => status === 'active').length > 1
    || (
      record.pr !== undefined
      && (
        !Number.isSafeInteger(record.pr.number)
        || record.pr.number <= 0
        || !gitOid(record.pr.head)
        || record.pr.branch.length === 0
      )
    )
  ) return false;
  if (
    record.predecessor !== undefined
    && (
      record.predecessor.generation === record.generation
      || !/^sha256:[0-9a-f]{64}$/.test(record.predecessor.snapshotDigest)
    )
  ) return false;
  if (
    record.supersession !== undefined
    && (
      record.phase !== 'superseded'
      || record.supersession.successorGeneration === record.generation
      || record.supersession.successorGeneration
        !== relayGeneration(record.supersession.successorSnapshot)
      || !snapshotIsExact(record.supersession.successorSnapshot)
      || record.supersession.successorSnapshotDigest
        !== record.supersession.successorSnapshot.snapshotDigest
      || record.supersession.successorSnapshot.repository.slug
        !== record.snapshot.repository.slug
      || record.supersession.successorSnapshot.issue.number
        !== record.snapshot.issue.number
      || !record.decisions.some((decision) =>
        decision.receipt?.receiptDigest
          === record.supersession?.requestedByReceiptDigest)
    )
  ) return false;
  const commissioned = new Set<string>();
  for (const decision of record.decisions) {
    const expected = issueRelayDecisionKey({
      generation: record.generation,
      snapshotDigest: record.snapshot.snapshotDigest,
      proposal: decision.proposal,
    });
    if (
      decision.decisionKey !== expected
      || decision.proposalDigest !== issueRelayCanonicalDigest(decision.proposal)
      || decision.deferrals !== decision.deferralReceipts.length
      || (decision.status === 'active' && decision.request === undefined)
      || (decision.status === 'implementing' && decision.implementationRound === undefined)
      || (
        decision.request !== undefined
        && !IssueRelayDecisionRequestV1Schema.safeParse(decision.request).success
      )
      || (
        decision.receipt !== undefined
        && (
          !IssueRelayHumanDecisionReceiptV1Schema.safeParse(decision.receipt).success
          || decision.receipt.requestDigest !== decision.request?.requestDigest
        )
      )
      || decision.deferralReceipts.some((receipt) =>
        !IssueRelayHumanDecisionReceiptV1Schema.safeParse(receipt).success
        || receipt.action !== 'defer'
        || receipt.decisionKey !== decision.decisionKey
        || receipt.requestDigest !== decision.request?.requestDigest)
      || (decision.deferredUntil !== undefined && !canonicalUtc(decision.deferredUntil))
      || (
        decision.continuationDeadlineAt !== undefined
        && !canonicalUtc(decision.continuationDeadlineAt)
      )
      || new Set(decision.commissionedOptions).size !== decision.commissionedOptions.length
    ) return false;
    for (const option of decision.commissionedOptions) {
      const key = `${decision.decisionKey}:${option}`;
      if (commissioned.has(key)) return false;
      commissioned.add(key);
    }
  }
  return record.rounds.every((round, roundIndex) => {
    try { relayRoundV2Capsule(record, round); } catch { return false; }
    const intent = round.fundingIntent;
    const task = round.task;
    const solution = round.solution;
    const adoption = round.adoption;
    const checks = round.checks;
    const evaluation = round.evaluation;
    const previous = record.rounds[roundIndex - 1];
    if (
      (intent !== undefined && (
        intent.taskKey !== `issue-relay:${record.generation}:round:${round.round}`
        || !safe(intent.creatorSafe)
        || !/^sha256:[0-9a-f]{64}$/.test(intent.requestDigest)
        || !/^[1-9][0-9]*$/.test(intent.maximumSpendWei)
        || !/^[1-9][0-9]*$/.test(intent.spendWei)
        || BigInt(intent.spendWei) > BigInt(intent.maximumSpendWei)
        || !canonicalUtc(intent.preparedAt)
      ))
      || (task !== undefined && (
        intent === undefined
        || task.taskKey !== intent.taskKey
        || !/^(0|[1-9][0-9]*)$/.test(task.taskId)
        || task.taskCid.length === 0
        || task.spendWei !== intent.spendWei
        || !canonicalUtc(task.fundedAt)
      ))
      || (solution !== undefined && (
        task === undefined
        || solution.envelopeCid.length === 0
        || !safe(solution.operatorSafe)
        || !canonicalUtc(solution.observedAt)
      ))
      || (adoption !== undefined && (
        solution === undefined
        || !/^sha256:[0-9a-f]{64}$/.test(adoption.receiptDigest)
        || (adoption.disposition === 'accepted')
          !== (adoption.resultingHead !== undefined && adoption.prNumber !== undefined)
        || (adoption.resultingHead !== undefined && !gitOid(adoption.resultingHead))
      ))
      || (checks !== undefined && (
        adoption?.disposition !== 'accepted'
        || checks.head !== adoption.resultingHead
        || !/^sha256:[0-9a-f]{64}$/.test(checks.digest)
      ))
      || (evaluation !== undefined && (
        checks?.status !== 'passed'
        || evaluation.head !== checks.head
        || !/^sha256:[0-9a-f]{64}$/.test(evaluation.anchorDigest)
        || !canonicalUtc(evaluation.anchoredAt)
      ))
      || (roundIndex === 0 && (
        round.purpose !== 'initial'
        || round.inputHead !== record.snapshot.repository.baseOid
      ))
      || (roundIndex > 0 && (
        previous?.adoption?.disposition !== 'accepted'
        || previous.adoption.resultingHead !== round.inputHead
        || round.purpose === 'initial'
      ))
      || (round.purpose !== 'initial' && (
        record.pr === undefined
        || round.prNumber !== record.pr.number
        || round.workspaceRepository !== record.pr.forkRepository
      ))
    ) return false;
    return (['security', 'quality'] as const).every((lane) =>
      round.laneAttempts[lane].every((attempt, index, attempts) =>
        attempt.observationDigest === issueRelayCanonicalDigest(attempt.observation)
        && attempt.correlation.generation === record.generation
        && attempt.correlation.round === round.round
        && attempt.correlation.snapshotDigest === record.snapshot.snapshotDigest
        && (
          attempt.observation.schemaVersion === 'jinn-issue-relay-lane-failure.v1'
          || isDeepStrictEqual(attempt.observation.correlation, attempt.correlation)
        )
        && attempt.observation.lane === lane
        && attempt.observation.evaluatedHead === attempt.head
        && safe(attempt.evaluatorSafe)
        && canonicalUtc(attempt.observedAt)
        && !attempts.slice(0, index).some((prior) =>
          prior.envelopeCid === attempt.envelopeCid
          && !isDeepStrictEqual(prior.observation, attempt.observation))));
  });
}
