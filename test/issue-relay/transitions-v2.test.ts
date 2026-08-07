import { describe, expect, it } from 'vitest';
import {
  IssueRelayEvaluationBundleV2Schema,
  IssueRelayDecisionRequestV1Schema,
  IssueRelayHumanDecisionReceiptV1Schema,
  issueRelayCanonicalDigest,
  issueRelayDecisionKey,
  issueRelayDecisionRequestDigest,
  issueRelayHumanDecisionReceiptDigest,
  type IssueRelayEvaluationBundleV2,
  type IssueRelayDecisionProposalV1,
  type IssueRelayDecisionRequestV1,
  type IssueRelayHumanDecisionReceiptV1,
  type IssueRelayRoundV2,
} from '../../src/issue-relay/contracts.js';
import { persistRelayFundingIntentV2 } from '../../src/issue-relay/state-v2.js';
import {
  finishRelayCancellationV2,
  markRelayReadyV2,
  persistRelayAdoptionV2,
  persistRelayCancellationV2,
  persistRelayChecksV2,
  persistRelayEvaluationAnchorV2,
  persistRelayEvaluationBundleV2,
  persistRelaySolutionDeliveryV2,
  persistRelayTaskSubmissionV2,
  supersedeRelayGenerationV2,
} from '../../src/issue-relay/transitions-v2.js';
import { deriveRelayActionV2 } from '../../src/issue-relay/state-v2.js';
import { buildRelaySnapshot } from '../../src/issue-relay/snapshot.js';
import { relayV2TestRecord } from './v2-fixture.js';

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const head = (character: string) => character.repeat(40);

function initialRound(record = relayV2TestRecord()): IssueRelayRoundV2 {
  return {
    schemaVersion: 'jinn-issue-relay-round.v2',
    generation: record.generation,
    round: 0,
    snapshotDigest: record.snapshot.snapshotDigest,
    targetRepository: record.snapshot.repository.slug,
    workspaceRepository: record.snapshot.repository.slug,
    inputHead: record.snapshot.repository.baseOid,
    purpose: 'initial',
    findings: [],
  };
}

function readyRecord() {
  const admitted = { ...relayV2TestRecord(), phase: 'admitted' as const, rounds: [], pr: undefined };
  const funded = persistRelayFundingIntentV2({
    record: admitted,
    round: initialRound(admitted),
    fundingIntent: {
      taskKey: `issue-relay:${admitted.generation}:round:0`,
      creatorSafe: `0x${'4'.repeat(40)}`,
      solverNetManifestCid: 'bafy-solver-net',
      requestDigest: digest('7'),
      maximumSpendWei: '100',
      spendWei: '80',
      preparedAt: '2026-08-06T12:03:00.000Z',
    },
    now: '2026-08-06T12:03:00.000Z',
  });
  const submitted = persistRelayTaskSubmissionV2({
    record: funded,
    round: 0,
    task: {
      taskKey: funded.rounds[0]!.fundingIntent!.taskKey,
      taskId: '42',
      taskCid: 'bafy-task',
      spendWei: '80',
      fundedAt: '2026-08-06T12:04:00.000Z',
    },
    now: '2026-08-06T12:04:00.000Z',
  });
  const solution = persistRelaySolutionDeliveryV2({
    record: submitted,
    round: 0,
    solution: {
      envelopeCid: 'bafy-solution',
      operatorSafe: `0x${'1'.repeat(40)}`,
      observedAt: '2026-08-06T12:05:00.000Z',
    },
    now: '2026-08-06T12:05:00.000Z',
  });
  const adopted = persistRelayAdoptionV2({
    record: solution,
    round: 0,
    adoption: {
      disposition: 'accepted',
      resultingHead: head('2'),
      prNumber: 314,
      receiptDigest: digest('d'),
      recordedAt: '2026-08-06T12:06:00.000Z',
    },
    pr: {
      number: 314,
      branch: 'jinn/relay',
      head: head('2'),
      draft: true,
      forkRepository: 'jinn-relay/mono',
    },
    now: '2026-08-06T12:06:00.000Z',
  });
  const checked = persistRelayChecksV2({
    record: adopted,
    round: 0,
    checks: { head: head('2'), status: 'passed', digest: digest('e'), observedAt: '2026-08-06T12:07:00.000Z' },
    now: '2026-08-06T12:07:00.000Z',
  });
  const anchored = persistRelayEvaluationAnchorV2({
    record: checked,
    round: 0,
    evaluation: { head: head('2'), anchorDigest: digest('c'), anchoredAt: '2026-08-06T12:08:00.000Z' },
    now: '2026-08-06T12:08:00.000Z',
  });
  const correlation = {
    generation: admitted.generation,
    round: 0,
    snapshotDigest: admitted.snapshot.snapshotDigest,
    taskId: '42',
    attemptIndex: 0,
    requestId: `0x${'3'.repeat(64)}`,
    deliveryEnvelopeCid: 'bafy-solution',
  };
  const lane = (name: 'security' | 'quality') => ({
    schemaVersion: 'jinn-issue-relay-lane-attestation.v1' as const,
    lane: name,
    correlation,
    evaluatedHead: head('2'),
    evaluationContextDigest: digest('b'),
    pullRequestMetadataDigest: digest('a'),
    evaluationAnchorDigest: digest('c'),
    adoptionReceiptDigest: digest('d'),
    checksDigest: digest('e'),
    evaluationSpecificationDigest: name === 'security' ? digest('f') : digest('1'),
    outcome: { kind: 'pass' as const, findings: [] },
    publicSummary: `${name} passed.`,
  });
  const bundle = IssueRelayEvaluationBundleV2Schema.parse({
    schemaVersion: 'jinn-issue-relay-evaluation-bundle.v2',
    correlation,
    evaluatedHead: head('2'),
    evaluationContextDigest: digest('b'),
    lanes: { security: lane('security'), quality: lane('quality') },
    overallProjection: 'pass',
  }) as IssueRelayEvaluationBundleV2;
  return persistRelayEvaluationBundleV2({
    record: anchored,
    round: 0,
    bundle,
    evaluatorSafe: `0x${'2'.repeat(40)}`,
    envelopeCid: 'bafy-evaluation',
    observedAt: '2026-08-06T12:09:00.000Z',
  });
}

describe('Relay V2 durable transitions', () => {
  it('advances one evidence-backed side effect at a time and is idempotent after receipts', () => {
    const evaluated = readyRecord();
    expect(evaluated.phase).toBe('evaluating');
    const ready = markRelayReadyV2({
      record: evaluated,
      currentHead: head('2'),
      currentBase: head('1'),
      currentPullRequestMetadataDigest: digest('a'),
      policy: { maxEvaluationAttemptsPerLanePerHead: 2 },
      now: '2026-08-06T12:10:00.000Z',
    });
    expect(ready).toMatchObject({ phase: 'ready', pr: { draft: false } });
    expect(() => markRelayReadyV2({
      record: evaluated,
      currentHead: head('3'),
      currentBase: head('1'),
      currentPullRequestMetadataDigest: digest('a'),
      policy: { maxEvaluationAttemptsPerLanePerHead: 2 },
      now: '2026-08-06T12:10:00.000Z',
    })).toThrow(/readiness|exact/i);
    expect(() => markRelayReadyV2({
      record: evaluated,
      currentHead: head('2'),
      currentBase: head('1'),
      currentPullRequestMetadataDigest: digest('9'),
      policy: { maxEvaluationAttemptsPerLanePerHead: 2 },
      now: '2026-08-06T12:10:00.000Z',
    })).toThrow(/readiness|exact/i);
  });

  it('makes a persisted cancellation dominate and closes idempotently', () => {
    const record = { ...relayV2TestRecord(), phase: 'admitted' as const, rounds: [], pr: undefined };
    const cancelling = persistRelayCancellationV2({
      record,
      reason: 'label-removed',
      now: '2026-08-06T12:11:00.000Z',
    });
    expect(persistRelayCancellationV2({
      record: cancelling,
      reason: 'label-removed',
      now: '2026-08-06T12:12:00.000Z',
    })).toBe(cancelling);
    expect(finishRelayCancellationV2({
      record: cancelling,
      now: '2026-08-06T12:12:00.000Z',
    })).toMatchObject({ phase: 'closed' });
  });

  it('pins a materially changed successor before closing and publishing it', () => {
    const baseRecord = relayV2TestRecord();
    const proposal: IssueRelayDecisionProposalV1 = {
      schemaVersion: 'jinn-issue-relay-decision-proposal.v1',
      lane: 'quality',
      reasonCode: 'scope-clarification',
      question: 'Should the frozen issue scope be clarified?',
      authorityCategory: 'authorising-maintainer',
      whyHumanAuthorityIsRequired: 'Only the maintainer can change issue scope.',
      supportingEvidence: [],
      options: [
        { optionId: 'clarify', title: 'Clarify', description: 'Replace the scope.', effect: 'clarify-scope', consequences: ['A successor is created.'], tradeoffs: ['Current work closes.'] },
        { optionId: 'cancel', title: 'Cancel', description: 'Stop work.', effect: 'cancel', consequences: ['No successor.'], tradeoffs: ['No result.'] },
      ],
      recommendedOptionId: 'clarify',
      recommendationRationale: 'The issue needs a new frozen contract.',
      recommendationConfidence: 'high',
      proposedImplementationPolicy: 'decision-before-implementation',
    };
    const decisionKey = issueRelayDecisionKey({
      generation: baseRecord.generation,
      snapshotDigest: baseRecord.snapshot.snapshotDigest,
      proposal,
    });
    const requestFields = {
      schemaVersion: 'jinn-issue-relay-decision-request.v1' as const,
      decisionKey,
      generation: baseRecord.generation,
      round: 0,
      snapshotDigest: baseRecord.snapshot.snapshotDigest,
      exactHead: head('2'),
      lane: 'quality' as const,
      proposal,
      effectiveImplementationPolicy: 'decision-before-implementation' as const,
      implementation: { status: 'not-required' as const },
      requiredRole: 'original-authorising-maintainer' as const,
      allowedActions: [
        'select-option' as const,
        'clarify-scope' as const,
        'cancel' as const,
        'defer' as const,
      ],
      createdAt: '2026-08-06T12:10:00.000Z',
      expiresAt: '2026-08-20T12:10:00.000Z',
    };
    const request: IssueRelayDecisionRequestV1 = {
      ...requestFields,
      requestDigest: issueRelayDecisionRequestDigest(requestFields),
    };
    const receiptFields = {
      schemaVersion: 'jinn-issue-relay-human-decision.v1' as const,
      requestDigest: request.requestDigest,
      decisionKey,
      generation: baseRecord.generation,
      round: 0,
      snapshotDigest: baseRecord.snapshot.snapshotDigest,
      requestHead: head('2'),
      lane: 'quality' as const,
      action: 'clarify-scope' as const,
      binding: 'exact-head-acceptance' as const,
      actor: { githubLogin: 'maintainer', githubUserId: 'U_maintainer' },
      authority: {
        requiredRole: 'original-authorising-maintainer' as const,
        observedPermission: 'WRITE' as const,
        checkedAt: '2026-08-06T12:11:00.000Z',
      },
      sourceComment: {
        commentId: 99,
        nodeId: 'IC_99',
        bodyDigest: digest('8'),
        createdAt: '2026-08-06T12:11:00.000Z',
        updatedAt: '2026-08-06T12:11:00.000Z',
      },
      decidedAt: '2026-08-06T12:11:00.000Z',
    };
    const receipt: IssueRelayHumanDecisionReceiptV1 = {
      ...receiptFields,
      receiptDigest: issueRelayHumanDecisionReceiptDigest(receiptFields),
    };
    const record = {
      ...baseRecord,
      phase: 'human-decision-required' as const,
      decisions: [{
        decisionKey,
        lane: 'quality' as const,
        proposalDigest: issueRelayCanonicalDigest(proposal),
        proposal,
        firstProposedHead: head('2'),
        status: 'active' as const,
        request,
        receipt,
        deferrals: 0,
        deferralReceipts: [],
        commissionedOptions: [],
      }],
    };
    IssueRelayDecisionRequestV1Schema.parse(request);
    IssueRelayHumanDecisionReceiptV1Schema.parse(receipt);
    const { schemaVersion: _version, snapshotDigest: _digest, ...snapshotInput } = baseRecord.snapshot;
    const successorSnapshot = buildRelaySnapshot({
      ...snapshotInput,
      issue: { ...snapshotInput.issue, title: 'Clarified Relay scope' },
      capturedAt: '2026-08-06T12:12:00.000Z',
    });
    const superseded = supersedeRelayGenerationV2({
      record,
      receipt,
      successorSnapshot,
      now: '2026-08-06T12:12:00.000Z',
    });
    const policy = {
      maxRoundsPerGeneration: 4,
      maxEvaluationAttemptsPerLanePerHead: 2,
      maxDecisionRequestsPerGeneration: 3,
      maxDecisionImplementationRoundsPerGeneration: 2,
      humanDecisionTtlMs: 1,
      maxHumanDeferrals: 1,
      humanDeferralExtensionMs: 1,
      decisionContinuationDeadlineMs: 1,
      implementBeforeDecision: () => false,
    };
    expect(deriveRelayActionV2({
      durable: superseded,
      issue: { open: true, optedIn: true },
      currentBaseOid: head('1'),
      currentPr: { number: 314, branch: 'jinn/relay', head: head('2'), base: 'next', open: true, draft: true, generation: baseRecord.generation, pullRequestMetadataDigest: digest('a') },
      successorPresent: false,
      now: '2026-08-06T12:13:00.000Z',
    }, policy)).toEqual({ kind: 'finish-supersession' });
    expect(deriveRelayActionV2({
      durable: superseded,
      issue: { open: true, optedIn: true },
      currentBaseOid: head('1'),
      successorPresent: false,
      now: '2026-08-06T12:13:00.000Z',
    }, policy)).toEqual({ kind: 'publish-successor-generation' });
  });
});
