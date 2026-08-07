import { describe, expect, it } from 'vitest';
import {
  IssueRelayEvaluationBundleV2Schema,
  issueRelayCanonicalDigest,
  issueRelayDecisionKey,
  type IssueRelayDecisionProposalV1,
  type IssueRelayEvaluationBundleV2,
  type IssueRelayLaneAttestationV1,
} from '../../src/issue-relay/contracts.js';
import {
  aggregateRelayEvaluationV2,
  createRelayDecisionRequestV2,
  deriveRelayActionV2,
  persistRelayFundingIntentV2,
  publishCriticalSecurityDecisionV2,
  publishRelayDecisionRequestV2,
  recordRelayHumanDecisionV2,
  recordRelayEvaluationBundleV2,
  validateRelayGenerationV2,
  type RelayRoundRecordV2,
} from '../../src/issue-relay/state-v2.js';
import { createRelayHumanDecisionReceipt } from '../../src/issue-relay/decision-protocol.js';
import { blockRelaySecurityV2 } from '../../src/issue-relay/transitions-v2.js';
import { relayV2TestRecord } from './v2-fixture.js';

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const head = (character: string) => character.repeat(40);

const relayPolicy = () => ({
  maxRoundsPerGeneration: 4,
  maxEvaluationAttemptsPerLanePerHead: 2,
  maxDecisionRequestsPerGeneration: 3,
  maxDecisionImplementationRoundsPerGeneration: 2,
  humanDecisionTtlMs: 14 * 24 * 60 * 60_000,
  maxHumanDeferrals: 1,
  humanDeferralExtensionMs: 14 * 24 * 60 * 60_000,
  decisionContinuationDeadlineMs: 24 * 60 * 60_000,
  implementBeforeDecision: () => false,
});

const proposal: IssueRelayDecisionProposalV1 = {
  schemaVersion: 'jinn-issue-relay-decision-proposal.v1',
  lane: 'quality',
  reasonCode: 'compatibility-choice',
  question: 'Should compatibility be retained?',
  authorityCategory: 'authorising-maintainer',
  whyHumanAuthorityIsRequired: 'Both choices satisfy the technical contract.',
  supportingEvidence: [{ label: 'Call sites', digest: digest('9'), summary: 'Existing callers remain.' }],
  options: [
    {
      optionId: 'preserve-compatibility',
      title: 'Preserve compatibility',
      description: 'Keep a forwarding wrapper.',
      effect: 'implement-change',
      implementationBrief: 'Add a forwarding wrapper and tests.',
      consequences: ['Existing callers continue to work.'],
      tradeoffs: ['The deprecated surface remains.'],
    },
    {
      optionId: 'retain-current',
      title: 'Retain current change',
      description: 'Accept the current exact head.',
      effect: 'retain-current-change',
      consequences: ['No additional code is commissioned.'],
      tradeoffs: ['Compatibility is intentionally not preserved.'],
    },
  ],
  recommendedOptionId: 'preserve-compatibility',
  recommendationRationale: 'Compatibility is safer.',
  recommendationConfidence: 'high',
  proposedImplementationPolicy: 'implement-before-decision',
};

function attestation(
  lane: 'security' | 'quality',
  outcome: IssueRelayLaneAttestationV1['outcome'] = { kind: 'pass', findings: [] },
): IssueRelayLaneAttestationV1 {
  return {
    schemaVersion: 'jinn-issue-relay-lane-attestation.v1',
    lane,
    correlation: {
      generation: relayV2TestRecord().generation,
      round: 0,
      snapshotDigest: relayV2TestRecord().snapshot.snapshotDigest,
      taskId: '42',
      attemptIndex: 0,
      requestId: `0x${'3'.repeat(64)}`,
      deliveryEnvelopeCid: 'bafy-solution',
    },
    evaluatedHead: head('2'),
    evaluationContextDigest: digest('b'),
    pullRequestMetadataDigest: digest('a'),
    evaluationAnchorDigest: digest('c'),
    adoptionReceiptDigest: digest('d'),
    checksDigest: digest('e'),
    evaluationSpecificationDigest: digest(lane === 'security' ? 'f' : '1'),
    outcome,
    publicSummary: `${lane} evaluated`,
  } as IssueRelayLaneAttestationV1;
}

function bundle(
  security: IssueRelayLaneAttestationV1,
  quality: IssueRelayLaneAttestationV1,
): IssueRelayEvaluationBundleV2 {
  const observations = [security, quality];
  const overallProjection = observations.some(({ outcome }) =>
    outcome.kind === 'changes-required' || outcome.kind === 'critical-block')
    ? 'fail'
    : observations.every(({ outcome }) => outcome.kind === 'pass')
      ? 'pass'
      : 'unresolved';
  return IssueRelayEvaluationBundleV2Schema.parse({
    schemaVersion: 'jinn-issue-relay-evaluation-bundle.v2',
    correlation: security.correlation,
    evaluatedHead: head('2'),
    evaluationContextDigest: digest('b'),
    lanes: { security, quality },
    overallProjection,
  }) as IssueRelayEvaluationBundleV2;
}

function roundWith(
  security: IssueRelayLaneAttestationV1,
  quality: IssueRelayLaneAttestationV1,
): RelayRoundRecordV2 {
  const generation = relayV2TestRecord().generation;
  const base: RelayRoundRecordV2 = {
    round: 0,
    purpose: 'initial',
    workspaceRepository: 'Jinn-Network/mono',
    inputHead: head('1'),
    findings: [],
    fundingIntent: {
      taskKey: `issue-relay:${generation}:round:0`,
      creatorSafe: `0x${'4'.repeat(40)}`,
      solverNetManifestCid: 'bafy-solver-net',
      requestDigest: digest('7'),
      maximumSpendWei: '100',
      spendWei: '80',
      preparedAt: '2026-08-06T12:03:00.000Z',
    },
    task: {
      taskKey: `issue-relay:${generation}:round:0`,
      taskId: '42',
      taskCid: 'bafy-task',
      spendWei: '80',
      fundedAt: '2026-08-06T12:04:00.000Z',
    },
    solution: {
      envelopeCid: 'bafy-solution',
      operatorSafe: `0x${'1'.repeat(40)}`,
      observedAt: '2026-08-06T12:05:00.000Z',
    },
    adoption: {
      disposition: 'accepted',
      resultingHead: head('2'),
      prNumber: 314,
      receiptDigest: digest('d'),
    },
    checks: { head: head('2'), status: 'passed', digest: digest('e') },
    evaluation: { head: head('2'), anchorDigest: digest('c'), anchoredAt: '2026-08-06T12:09:00.000Z' },
    laneAttempts: { security: [], quality: [] },
  };
  return recordRelayEvaluationBundleV2({
    round: base,
    bundle: bundle(security, quality),
    evaluatorSafe: `0x${'2'.repeat(40)}`,
    envelopeCid: 'bafy-evaluation',
    observedAt: '2026-08-06T12:10:00.000Z',
  });
}

describe('Relay V2 aggregation', () => {
  it('requires both exact-head lane passes and ignores the bundle projection for readiness', () => {
    const generation = relayV2TestRecord();
    const round = roundWith(attestation('security'), attestation('quality'));
    expect(aggregateRelayEvaluationV2({
      record: { ...generation, rounds: [round] },
      round,
      exactHead: head('2'),
      maxAttemptsPerLanePerHead: 2,
    })).toMatchObject({
      kind: 'ready',
      security: { status: 'evaluator-pass' },
      quality: { status: 'evaluator-pass' },
    });
  });

  it('gives critical security priority and combines lane-attributed repair findings', () => {
    const generation = relayV2TestRecord();
    const critical = attestation('security', {
      kind: 'critical-block',
      publicSummary: 'Critical trust boundary violation.',
      restrictedEvidencePresent: true,
      restrictedEvidenceDigest: digest('8'),
      findings: [],
    });
    const blocked = roundWith(critical, attestation('quality'));
    expect(aggregateRelayEvaluationV2({ record: { ...generation, rounds: [blocked] }, round: blocked, exactHead: head('2'), maxAttemptsPerLanePerHead: 2 })).toMatchObject({ kind: 'security-blocked' });
    const blockedRecord = blockRelaySecurityV2({
      record: { ...generation, rounds: [blocked] },
      now: '2026-08-06T12:10:00.000Z',
    });
    const withRequest = publishCriticalSecurityDecisionV2({
      record: blockedRecord,
      attestation: critical,
      now: '2026-08-06T12:10:00.000Z',
      ttlMs: 14 * 24 * 60 * 60_000,
    });
    expect(withRequest).toMatchObject({
      phase: 'security-blocked',
      decisions: [{
        status: 'active',
        request: {
          requiredRole: 'current-repository-admin',
          allowedActions: ['clarify-scope', 'cancel', 'defer'],
        },
      }],
    });
    expect(deriveRelayActionV2({
      durable: withRequest,
      issue: { open: true, optedIn: true },
      currentBaseOid: head('1'),
      currentPr: { number: 314, branch: 'jinn/relay', head: head('2'), base: 'next', open: true, draft: true, generation: generation.generation, pullRequestMetadataDigest: digest('a') },
      now: '2026-08-06T12:11:00.000Z',
    }, relayPolicy())).toMatchObject({ kind: 'record-human-decision' });

    const securityFinding = {
      findingId: 'security-1', lane: 'security' as const, code: 'auth', severity: 'high' as const,
      title: 'Authorization bypass', publicDetail: 'A path bypasses authorization.', sensitivity: 'public' as const,
    };
    const qualityFinding = {
      findingId: 'quality-1', lane: 'quality' as const, code: 'regression', severity: 'medium' as const,
      title: 'Behavior regressed', publicDetail: 'Acceptance criteria are not met.', sensitivity: 'public' as const,
    };
    const repair = roundWith(
      attestation('security', { kind: 'changes-required', findings: [securityFinding] }),
      attestation('quality', { kind: 'changes-required', findings: [qualityFinding] }),
    );
    expect(aggregateRelayEvaluationV2({ record: { ...generation, rounds: [repair] }, round: repair, exactHead: head('2'), maxAttemptsPerLanePerHead: 2 })).toEqual({
      kind: 'repair', findings: [securityFinding, qualityFinding],
    });
  });

  it('presents security decisions before quality decisions and creates a canonical request', () => {
    const securityProposal = { ...proposal, lane: 'security' as const, authorityCategory: 'repository-admin' as const, proposedImplementationPolicy: 'decision-before-implementation' as const };
    const generation = relayV2TestRecord();
    const round = roundWith(
      attestation('security', { kind: 'decision-required', proposal: securityProposal, findings: [] }),
      attestation('quality', { kind: 'decision-required', proposal, findings: [] }),
    );
    const aggregate = aggregateRelayEvaluationV2({ record: { ...generation, rounds: [round] }, round, exactHead: head('2'), maxAttemptsPerLanePerHead: 2 });
    expect(aggregate).toMatchObject({ kind: 'decision', lane: 'security' });
    if (aggregate.kind !== 'decision') throw new Error('expected decision');
    const request = createRelayDecisionRequestV2({
      record: { ...generation, rounds: [round] },
      round,
      attestation: aggregate.attestation,
      implementation: { status: 'not-required' },
      now: '2026-08-06T12:11:00.000Z',
      ttlMs: 14 * 24 * 60 * 60 * 1000,
    });
    expect(request).toMatchObject({
      lane: 'security',
      requiredRole: 'current-repository-admin',
      exactHead: head('2'),
    });
  });

  it('commissions a safe reversible recommendation before asking only when host policy permits', () => {
    const generation = relayV2TestRecord();
    const round = roundWith(
      attestation('security'),
      attestation('quality', { kind: 'decision-required', proposal, findings: [] }),
    );
    const facts = { record: { ...generation, rounds: [round] }, round, exactHead: head('2'), maxAttemptsPerLanePerHead: 2 };
    expect(aggregateRelayEvaluationV2({ ...facts, allowSafePreimplementation: () => false })).toMatchObject({ kind: 'decision' });
    expect(aggregateRelayEvaluationV2({ ...facts, allowSafePreimplementation: () => true })).toMatchObject({
      kind: 'decision-implementation',
      optionId: 'preserve-compatibility',
      authorization: 'repository-policy-safe-preimplementation',
    });
  });

  it('persists lane evidence append-only and rejects an envelope contradiction', () => {
    const security = attestation('security');
    const quality = attestation('quality');
    const first = roundWith(security, quality);
    expect(recordRelayEvaluationBundleV2({
      round: first,
      bundle: bundle(security, quality),
      evaluatorSafe: `0x${'2'.repeat(40)}`,
      envelopeCid: 'bafy-evaluation',
      observedAt: '2026-08-06T12:10:00.000Z',
    })).toEqual(first);
    const changed = bundle(attestation('security', {
      kind: 'changes-required',
      findings: [{ findingId: 's1', lane: 'security', code: 'changed', severity: 'high', title: 'Changed', publicDetail: 'Changed.', sensitivity: 'public' }],
    }), quality);
    expect(() => recordRelayEvaluationBundleV2({
      round: first,
      bundle: changed,
      evaluatorSafe: `0x${'2'.repeat(40)}`,
      envelopeCid: 'bafy-evaluation',
      observedAt: '2026-08-06T12:11:00.000Z',
    })).toThrow(/contradictory/i);
  });

  it('validates decision identity and duplicate commissioning bounds', () => {
    const generation = relayV2TestRecord();
    const key = issueRelayDecisionKey({ generation: generation.generation, snapshotDigest: generation.snapshot.snapshotDigest, proposal });
    const decision = {
      decisionKey: key,
      lane: 'quality' as const,
      proposalDigest: issueRelayCanonicalDigest(proposal),
      proposal,
      firstProposedHead: head('2'),
      status: 'resolved' as const,
      deferrals: 0,
      deferralReceipts: [],
      commissionedOptions: ['preserve-compatibility'],
    };
    expect(validateRelayGenerationV2({ ...generation, decisions: [decision] })).toBe(true);
    expect(validateRelayGenerationV2({ ...generation, decisions: [decision, decision] })).toBe(false);
  });

  it('derives one exact action and preserves check failures as their own repair source', () => {
    const generation = relayV2TestRecord();
    const evaluated = roundWith(attestation('security'), attestation('quality'));
    const policy = {
      maxRoundsPerGeneration: 4,
      maxEvaluationAttemptsPerLanePerHead: 2,
      maxDecisionRequestsPerGeneration: 3,
      maxDecisionImplementationRoundsPerGeneration: 2,
      humanDecisionTtlMs: 14 * 24 * 60 * 60 * 1000,
      maxHumanDeferrals: 1,
      humanDeferralExtensionMs: 14 * 24 * 60 * 60 * 1000,
      decisionContinuationDeadlineMs: 24 * 60 * 60 * 1000,
      implementBeforeDecision: () => false,
    };
    const facts = {
      issue: { open: true, optedIn: true },
      currentBaseOid: head('1'),
      currentPr: {
        number: 314,
        branch: 'jinn/relay',
        head: head('2'),
        base: 'next',
        open: true,
        draft: true,
        generation: generation.generation,
        pullRequestMetadataDigest: digest('a'),
      },
      now: '2026-08-06T12:12:00.000Z',
    } as const;
    expect(deriveRelayActionV2({
      ...facts,
      durable: { ...generation, rounds: [evaluated] },
    }, policy)).toEqual({ kind: 'mark-ready' });

    expect(deriveRelayActionV2({
      ...facts,
      currentPr: {
        ...facts.currentPr,
        pullRequestMetadataDigest: digest('9'),
      },
      durable: { ...generation, rounds: [evaluated] },
    }, policy)).toEqual({
      kind: 'none',
      reason: 'Evaluation operator intervention required for security, quality',
    });

    const failedChecks = {
      ...evaluated,
      checks: { head: head('2'), status: 'failed' as const, digest: digest('e') },
      evaluation: undefined,
      laneAttempts: { security: [], quality: [] },
    };
    expect(deriveRelayActionV2({
      ...facts,
      durable: { ...generation, phase: 'draft-open', rounds: [failedChecks] },
    }, policy)).toEqual({
      kind: 'prepare-check-repair',
      round: 1,
      failedHead: head('2'),
      checksDigest: digest('e'),
    });

    expect(deriveRelayActionV2({
      ...facts,
      issue: { open: false, optedIn: true },
      durable: { ...generation, rounds: [evaluated] },
    }, policy)).toEqual({ kind: 'record-cancellation', reason: 'issue-closed' });
  });

  it('persists one bounded defer, a later option intent, and one decision implementation round', () => {
    const generation = relayV2TestRecord();
    const round = roundWith(
      attestation('security'),
      attestation('quality', { kind: 'decision-required', proposal, findings: [] }),
    );
    const withRequest = publishRelayDecisionRequestV2({
      record: {
        ...generation,
        rounds: [round],
        pr: {
          ...generation.pr!,
          forkRepository: 'jinn-relay/mono',
        },
      },
      round,
      attestation: attestation('quality', { kind: 'decision-required', proposal, findings: [] }),
      implementation: {
        status: 'not-started',
        optionId: 'preserve-compatibility',
        sourceHead: head('2'),
      },
      now: '2026-08-06T12:11:00.000Z',
      ttlMs: 60_000,
    });
    const request = withRequest.decisions[0]!.request!;
    const comment = (id: number, body: string, at: string) => ({
      commentId: id,
      nodeId: `IC_${id}`,
      body,
      actorLogin: 'maintainer',
      actorUserId: 'U_maintainer',
      createdAt: at,
      updatedAt: at,
    });
    const defer = createRelayHumanDecisionReceipt({
      request,
      comment: comment(
        1,
        `/jinn-relay defer ${request.requestDigest} ${request.exactHead}`,
        '2026-08-06T12:11:30.000Z',
      ),
      currentHead: request.exactHead,
      currentPermission: 'WRITE',
      originalAuthorisingMaintainer: { login: 'maintainer', userId: 'U_maintainer' },
      checkedAt: '2026-08-06T12:11:30.000Z',
      now: '2026-08-06T12:11:30.000Z',
    });
    if (!defer.accepted) throw new Error('expected defer receipt');
    const deferred = recordRelayHumanDecisionV2({
      record: withRequest,
      decisionKey: request.decisionKey,
      receipt: defer.receipt,
      now: '2026-08-06T12:11:30.000Z',
      maxDeferrals: 1,
      deferralExtensionMs: 60_000,
      decisionContinuationDeadlineMs: 60_000,
    });
    expect(deferred.decisions[0]).toMatchObject({
      deferrals: 1,
      deferredUntil: '2026-08-06T12:13:00.000Z',
    });

    const choose = createRelayHumanDecisionReceipt({
      request,
      comment: comment(
        2,
        `/jinn-relay decide ${request.requestDigest} ${request.exactHead} preserve-compatibility`,
        '2026-08-06T12:12:30.000Z',
      ),
      currentHead: request.exactHead,
      currentPermission: 'WRITE',
      originalAuthorisingMaintainer: { login: 'maintainer', userId: 'U_maintainer' },
      checkedAt: '2026-08-06T12:12:30.000Z',
      now: '2026-08-06T12:12:30.000Z',
      effectiveExpiresAt: deferred.decisions[0]!.deferredUntil,
    });
    if (!choose.accepted) throw new Error('expected selection receipt');
    const selected = recordRelayHumanDecisionV2({
      record: deferred,
      decisionKey: request.decisionKey,
      receipt: choose.receipt,
      now: '2026-08-06T12:12:30.000Z',
      maxDeferrals: 1,
      deferralExtensionMs: 60_000,
      decisionContinuationDeadlineMs: 60_000,
    });
    expect(aggregateRelayEvaluationV2({
      record: selected,
      round,
      exactHead: head('2'),
      maxAttemptsPerLanePerHead: 2,
    })).toMatchObject({
      kind: 'decision-implementation',
      optionId: 'preserve-compatibility',
      authorization: 'human-option-intent',
    });

    const implementationRound = {
      schemaVersion: 'jinn-issue-relay-round.v2' as const,
      generation: selected.generation,
      round: 1,
      snapshotDigest: selected.snapshot.snapshotDigest,
      targetRepository: selected.snapshot.repository.slug,
      workspaceRepository: 'jinn-relay/mono',
      inputHead: head('2'),
      purpose: 'decision-implementation' as const,
      findings: [],
      prNumber: 314,
      decisionBinding: {
        decisionKey: request.decisionKey,
        proposalDigest: issueRelayCanonicalDigest(proposal),
        requestDigest: request.requestDigest,
        optionId: 'preserve-compatibility',
        authorization: 'human-option-intent' as const,
        sourceHead: head('2'),
        frozenImplementationBrief: 'Add a forwarding wrapper and tests.',
      },
    };
    const funded = persistRelayFundingIntentV2({
      record: selected,
      round: implementationRound,
      fundingIntent: {
        taskKey: `issue-relay:${selected.generation}:round:1`,
        creatorSafe: `0x${'4'.repeat(40)}`,
        solverNetManifestCid: 'bafy-solver-net',
        requestDigest: digest('7'),
        maximumSpendWei: '100',
        spendWei: '80',
        preparedAt: '2026-08-06T12:12:31.000Z',
      },
      now: '2026-08-06T12:12:31.000Z',
    });
    expect(funded).toMatchObject({
      phase: 'funding',
      rounds: [{ round: 0 }, { round: 1, purpose: 'decision-implementation' }],
      decisions: [{ status: 'implementing', commissionedOptions: ['preserve-compatibility'] }],
    });
    expect(() => persistRelayFundingIntentV2({
      record: { ...selected, rounds: [round] },
      round: implementationRound,
      fundingIntent: funded.rounds[1]!.fundingIntent!,
      now: '2026-08-06T12:12:31.000Z',
    })).not.toThrow();
    expect(() => persistRelayFundingIntentV2({
      record: funded,
      round: { ...implementationRound, round: 2 },
      fundingIntent: { ...funded.rounds[1]!.fundingIntent!, taskKey: `issue-relay:${selected.generation}:round:2` },
      now: '2026-08-06T12:12:32.000Z',
    })).toThrow(/authority|invalid|commission/i);
  });

  it('does not accept a generic pass after decision implementation without exact conformance', () => {
    const generation = relayV2TestRecord();
    const key = issueRelayDecisionKey({
      generation: generation.generation,
      snapshotDigest: generation.snapshot.snapshotDigest,
      proposal,
    });
    const binding = {
      decisionKey: key,
      proposalDigest: issueRelayCanonicalDigest(proposal),
      optionId: 'preserve-compatibility',
      authorization: 'repository-policy-safe-preimplementation' as const,
      sourceHead: head('2'),
      frozenImplementationBrief: 'Add a forwarding wrapper and tests.',
    };
    const correlation = {
      ...attestation('security').correlation,
      round: 1,
      deliveryEnvelopeCid: 'bafy-decision-solution',
    };
    const exact = (lane: 'security' | 'quality') => ({
      ...attestation(lane),
      correlation,
      evaluatedHead: head('3'),
    });
    const makeRound = (quality: IssueRelayLaneAttestationV1) => {
      const security = exact('security');
      const evaluationBundle = IssueRelayEvaluationBundleV2Schema.parse({
        schemaVersion: 'jinn-issue-relay-evaluation-bundle.v2',
        correlation,
        evaluatedHead: head('3'),
        evaluationContextDigest: digest('b'),
        lanes: { security, quality },
        overallProjection: 'pass',
      }) as IssueRelayEvaluationBundleV2;
      return recordRelayEvaluationBundleV2({
        round: {
          round: 1,
          purpose: 'decision-implementation',
          workspaceRepository: 'jinn-relay/mono',
          inputHead: head('2'),
          findings: [],
          prNumber: 314,
          decisionBinding: binding,
          adoption: { disposition: 'accepted', resultingHead: head('3'), prNumber: 314, receiptDigest: digest('d') },
          checks: { head: head('3'), status: 'passed', digest: digest('e') },
          evaluation: { head: head('3'), anchorDigest: digest('c'), anchoredAt: '2026-08-06T12:20:00.000Z' },
          laneAttempts: { security: [], quality: [] },
        },
        bundle: evaluationBundle,
        evaluatorSafe: `0x${'2'.repeat(40)}`,
        envelopeCid: 'bafy-decision-evaluation',
        observedAt: '2026-08-06T12:21:00.000Z',
      });
    };
    const decision = {
      decisionKey: key,
      lane: 'quality' as const,
      proposalDigest: issueRelayCanonicalDigest(proposal),
      proposal,
      firstProposedHead: head('2'),
      status: 'implementing' as const,
      deferrals: 0,
      deferralReceipts: [],
      commissionedOptions: ['preserve-compatibility'],
      implementationRound: 1,
    };
    const missing = makeRound(exact('quality'));
    expect(aggregateRelayEvaluationV2({
      record: { ...generation, rounds: [roundWith(attestation('security'), attestation('quality')), missing], decisions: [decision] },
      round: missing,
      exactHead: head('3'),
      maxAttemptsPerLanePerHead: 2,
    })).toEqual({ kind: 'operator', lanes: ['quality'] });

    const conforming = makeRound({
      ...exact('quality'),
      decisionAssessment: {
        decisionKey: key,
        optionId: 'preserve-compatibility',
        implementationRound: 1,
        status: 'conforms',
      },
    });
    expect(aggregateRelayEvaluationV2({
      record: { ...generation, rounds: [roundWith(attestation('security'), attestation('quality')), conforming], decisions: [decision] },
      round: conforming,
      exactHead: head('3'),
      maxAttemptsPerLanePerHead: 2,
    })).toMatchObject({ kind: 'ready' });
  });
});
