import { describe, expect, it } from 'vitest';
import {
  IssueRelayDecisionRequestV1Schema,
  issueRelayCanonicalDigest,
  issueRelayDecisionKey,
  issueRelayDecisionRequestDigest,
  type IssueRelayDecisionRequestV1,
} from '../../src/issue-relay/contracts.js';
import {
  relayLaneFromGateV2,
  renderRelayAssuranceV2,
} from '../../src/issue-relay/report-v2.js';

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const head = '2'.repeat(40);

function exactEvidence() {
  const correlation = {
    generation: 'relay-v2', round: 1, snapshotDigest: digest('a'), taskId: '42',
    attemptIndex: 0, requestId: `0x${'3'.repeat(64)}`, deliveryEnvelopeCid: 'bafy-solution',
  };
  const adoptionReceipt = {
    schemaVersion: 'jinn-issue-relay-adoption.v1' as const,
    disposition: 'accepted' as const,
    correlation,
    targetRepository: 'Jinn-Network/mono', workspaceRepository: 'jinn-relay/mono',
    issueNumber: 42, prNumber: 314, headRef: 'jinn/relay', inputHead: '1'.repeat(40),
    resultingHead: head, patchDigest: digest('9'), solutionSafe: `0x${'1'.repeat(40)}`,
    adoptedAt: '2026-08-06T11:58:00.000Z',
  };
  const adoptionReceiptDigest = issueRelayCanonicalDigest(adoptionReceipt);
  const checksDigest = digest('c');
  const evaluationAnchor = {
    schemaVersion: 'jinn-issue-relay-evaluation-anchor.v1' as const,
    correlation,
    targetRepository: adoptionReceipt.targetRepository,
    workspaceRepository: adoptionReceipt.workspaceRepository,
    prNumber: adoptionReceipt.prNumber,
    targetBase: 'next', baseOid: '1'.repeat(40), headRef: adoptionReceipt.headRef,
    evaluatedHead: head, adoptionReceiptDigest, checksDigest,
    anchoredAt: '2026-08-06T11:59:00.000Z',
  };
  return { adoptionReceipt, adoptionReceiptDigest, checksDigest, evaluationAnchor };
}

function decisionRequest(): IssueRelayDecisionRequestV1 {
  const proposal = {
    schemaVersion: 'jinn-issue-relay-decision-proposal.v1' as const,
    lane: 'quality' as const, reasonCode: 'compatibility-choice',
    question: 'Should compatibility be preserved?', authorityCategory: 'authorising-maintainer' as const,
    whyHumanAuthorityIsRequired: 'This is a product policy.', supportingEvidence: [],
    options: [
      { optionId: 'preserve', title: 'Preserve compatibility', description: 'Keep a wrapper.', effect: 'retain-current-change' as const, consequences: ['Callers work.'], tradeoffs: ['More surface.'] },
      { optionId: 'remove', title: 'Remove API', description: 'Remove it.', effect: 'implement-change' as const, implementationBrief: 'Remove the API and update tests.', consequences: ['Smaller surface.'], tradeoffs: ['Breaking change.'] },
    ],
    recommendedOptionId: 'preserve', recommendationRationale: 'Compatibility is safer.', recommendationConfidence: 'high' as const,
    proposedImplementationPolicy: 'implement-before-decision' as const,
  };
  const generation = 'relay-v2';
  const snapshotDigest = digest('a');
  const unsigned = {
    schemaVersion: 'jinn-issue-relay-decision-request.v1' as const,
    decisionKey: issueRelayDecisionKey({ generation, snapshotDigest, proposal }),
    generation, round: 1, snapshotDigest, exactHead: head, lane: 'quality' as const,
    proposal, effectiveImplementationPolicy: 'implement-before-decision' as const,
    implementation: { status: 'verified' as const, optionId: 'preserve', sourceHead: '1'.repeat(40), implementedHead: head, implementationRound: 1, conformanceAttestationDigest: digest('b') },
    requiredRole: 'original-authorising-maintainer' as const,
    allowedActions: ['select-option', 'cancel'] as const,
    createdAt: '2026-08-06T12:00:00.000Z', expiresAt: '2026-08-20T12:00:00.000Z',
  };
  return IssueRelayDecisionRequestV1Schema.parse({
    ...unsigned,
    allowedActions: [...unsigned.allowedActions],
    requestDigest: issueRelayDecisionRequestDigest(unsigned),
  }) as IssueRelayDecisionRequestV1;
}

describe('Relay V2 assurance report', () => {
  it('shows exact-head trust evidence and honestly discloses one canary evaluator', () => {
    const evaluator = `0x${'2'.repeat(40)}`;
    const evidence = exactEvidence();
    const body = renderRelayAssuranceV2({
      generation: 'relay-v2', exactHead: head, baseOid: '1'.repeat(40),
      solutionOperator: `0x${'1'.repeat(40)}`,
      ...evidence,
      security: {
        lane: 'security', status: 'passed', publicSummary: 'Security passed.',
        reviewMethod: 'Claude `/security-review`',
        evaluatorIdentity: evaluator, evidenceDigest: digest('e'),
        automatedEvidence: [{
          tool: 'snyk-code', version: '1.1297.3', status: 'passed',
          digest: digest('9'), summary: 'Snyk Code completed without findings.',
        }],
      },
      quality: {
        lane: 'quality', status: 'decision-required', publicSummary: 'Product intent is required.', evaluatorIdentity: evaluator, evidenceDigest: digest('f'),
        automatedEvidence: [{
          tool: 'repository-guidance', version: 'v1', status: 'passed',
          digest: digest('8'), summary: 'Patch and PR metadata follow frozen repository guidance.',
        }],
      },
      decisionRequest: decisionRequest(),
    });
    expect(body).toContain('one authenticated evaluator operator performed two separate evaluations');
    expect(body).toContain('Review method: Claude `/security-review`');
    expect(body).toContain('Automated evidence: `snyk-code@1.1297.3`');
    expect(body).toContain('Repository guidance: `repository-guidance@v1`');
    expect(body).toContain('QUALITY DECISION REQUIRED');
    expect(body).toContain(`/jinn-relay decide ${decisionRequest().requestDigest} ${head} preserve`);
    expect(body).toContain('This pull request remains draft');
    expect(body).toContain('does not auto-merge');
    expect(body).toContain('<!-- jinn-issue-relay:adoption:v1 -->');
    expect(body).toContain('<!-- jinn-issue-relay:evaluation-anchor:v1 -->');
  });

  it('never rewrites human security authority as an evaluator pass', () => {
    const lane = relayLaneFromGateV2('security', {
      status: 'authorised-noncritical-exception',
      attestationDigest: digest('1'), decisionReceiptDigest: digest('2'), humanActor: 'admin',
    });
    expect(lane.status).toBe('exception-authorised');
    expect(lane.publicSummary).toContain('evaluator did not pass');
    expect(lane.publicSummary).not.toContain('evaluation passed');
  });
});
