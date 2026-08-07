import { describe, expect, it } from 'vitest';
import {
  IssueRelayDecisionRequestV1Schema,
  issueRelayDecisionKey,
  issueRelayDecisionRequestDigest,
  type IssueRelayDecisionProposalV1,
  type IssueRelayDecisionRequestV1,
} from '../../src/issue-relay/contracts.js';
import {
  createRelayHumanDecisionReceipt,
  parseRelayDecisionCommand,
  relayCommentBodyDigest,
} from '../../src/issue-relay/decision-protocol.js';

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const exactHead = '2'.repeat(40);

const proposal: IssueRelayDecisionProposalV1 = {
  schemaVersion: 'jinn-issue-relay-decision-proposal.v1',
  lane: 'quality',
  reasonCode: 'compatibility-choice',
  question: 'Which compatibility policy should apply?',
  authorityCategory: 'authorising-maintainer',
  whyHumanAuthorityIsRequired: 'This is a product policy choice.',
  supportingEvidence: [{ label: 'Call sites', digest: digest('1'), summary: 'Callers remain.' }],
  options: [
    {
      optionId: 'preserve-compatibility', title: 'Preserve compatibility', description: 'Add a wrapper.',
      effect: 'implement-change', implementationBrief: 'Add a wrapper and tests.',
      consequences: ['Callers continue to work.'], tradeoffs: ['More surface remains.'],
    },
    {
      optionId: 'accept-current', title: 'Accept current', description: 'Accept the exact head.',
      effect: 'retain-current-change', consequences: ['No more code.'], tradeoffs: ['Compatibility is not retained.'],
    },
  ],
  recommendedOptionId: 'preserve-compatibility',
  recommendationRationale: 'It is safer.',
  recommendationConfidence: 'high',
  proposedImplementationPolicy: 'decision-before-implementation',
};

function request(overrides: Partial<IssueRelayDecisionRequestV1> = {}): IssueRelayDecisionRequestV1 {
  const generation = 'relay-v2-generation';
  const snapshotDigest = digest('a');
  const unsigned = {
    schemaVersion: 'jinn-issue-relay-decision-request.v1' as const,
    decisionKey: issueRelayDecisionKey({ generation, snapshotDigest, proposal }),
    generation,
    round: 0,
    snapshotDigest,
    exactHead,
    lane: 'quality' as const,
    proposal,
    effectiveImplementationPolicy: 'decision-before-implementation' as const,
    implementation: { status: 'not-started' as const, optionId: 'preserve-compatibility', sourceHead: exactHead },
    requiredRole: 'original-authorising-maintainer' as const,
    allowedActions: ['select-option', 'clarify-scope', 'cancel', 'defer'] as const,
    createdAt: '2026-08-06T12:00:00.000Z',
    expiresAt: '2026-08-20T12:00:00.000Z',
    ...overrides,
  };
  return IssueRelayDecisionRequestV1Schema.parse({
    ...unsigned,
    requestDigest: issueRelayDecisionRequestDigest(unsigned),
  }) as IssueRelayDecisionRequestV1;
}

function comment(body: string) {
  return {
    commentId: 123,
    nodeId: 'IC_example',
    body,
    actorLogin: 'maintainer',
    actorUserId: 'U_maintainer',
    createdAt: '2026-08-06T12:05:00.000Z',
    updatedAt: '2026-08-06T12:05:00.000Z',
  };
}

describe('Relay PR decision protocol', () => {
  it('parses an exact first-line command and keeps later lines as inert rationale', () => {
    const value = request();
    const body = `/jinn-relay decide ${value.requestDigest} ${exactHead} preserve-compatibility\nThis is our compatibility policy.`;
    expect(parseRelayDecisionCommand(body)).toEqual({
      action: 'select-option', requestDigest: value.requestDigest, exactHead,
      optionId: 'preserve-compatibility', rationale: 'This is our compatibility policy.',
    });
    expect(parseRelayDecisionCommand(`prefix ${body}`)).toBeNull();
    expect(relayCommentBodyDigest(body)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('accepts only the original authorising maintainer with current write permission', () => {
    const value = request();
    const body = `/jinn-relay decide ${value.requestDigest} ${exactHead} preserve-compatibility`;
    const result = createRelayHumanDecisionReceipt({
      request: value,
      comment: comment(body),
      currentHead: exactHead,
      currentPermission: 'WRITE',
      originalAuthorisingMaintainer: { login: 'maintainer', userId: 'U_maintainer' },
      checkedAt: '2026-08-06T12:06:00.000Z',
      now: '2026-08-06T12:06:00.000Z',
    });
    expect(result).toMatchObject({
      accepted: true,
      receipt: {
        binding: 'option-intent',
        selectedOptionId: 'preserve-compatibility',
        requestHead: exactHead,
        actor: { githubUserId: 'U_maintainer' },
      },
    });
  });

  it('rejects edited, stale-head, replayed-request, and unauthorized responses', () => {
    const value = request();
    const body = `/jinn-relay decide ${value.requestDigest} ${exactHead} accept-current`;
    const common = {
      request: value,
      comment: comment(body),
      currentHead: exactHead,
      currentPermission: 'WRITE' as const,
      originalAuthorisingMaintainer: { login: 'maintainer', userId: 'U_maintainer' },
      checkedAt: '2026-08-06T12:06:00.000Z',
      now: '2026-08-06T12:06:00.000Z',
    };
    expect(createRelayHumanDecisionReceipt({ ...common, comment: { ...common.comment, updatedAt: '2026-08-06T12:05:01.000Z' } })).toEqual({ accepted: false, reason: 'edited-comment' });
    expect(createRelayHumanDecisionReceipt({ ...common, currentHead: '3'.repeat(40) })).toEqual({ accepted: false, reason: 'stale-head' });
    expect(createRelayHumanDecisionReceipt({ ...common, comment: comment(`/jinn-relay decide ${digest('f')} ${exactHead} accept-current`) })).toEqual({ accepted: false, reason: 'stale-request' });
    expect(createRelayHumanDecisionReceipt({ ...common, currentPermission: 'READ' })).toEqual({ accepted: false, reason: 'unauthorised' });
  });

  it('requires current ADMIN for a security exception', () => {
    const securityProposal = {
      ...proposal,
      lane: 'security' as const,
      authorityCategory: 'repository-admin' as const,
      options: [
        proposal.options[0]!,
        { ...proposal.options[1]!, optionId: 'accept-risk', effect: 'accept-noncritical-risk' as const },
      ],
      recommendedOptionId: 'preserve-compatibility',
    };
    const generation = 'relay-v2-generation';
    const snapshotDigest = digest('a');
    const unsigned = {
      schemaVersion: 'jinn-issue-relay-decision-request.v1' as const,
      decisionKey: issueRelayDecisionKey({ generation, snapshotDigest, proposal: securityProposal }),
      generation, round: 0, snapshotDigest, exactHead, lane: 'security' as const,
      proposal: securityProposal, effectiveImplementationPolicy: 'decision-before-implementation' as const,
      implementation: { status: 'not-required' as const },
      requiredRole: 'current-repository-admin' as const,
      allowedActions: ['select-option', 'cancel'] as const,
      createdAt: '2026-08-06T12:00:00.000Z', expiresAt: '2026-08-20T12:00:00.000Z',
    };
    const securityRequest = IssueRelayDecisionRequestV1Schema.parse({ ...unsigned, requestDigest: issueRelayDecisionRequestDigest(unsigned) }) as IssueRelayDecisionRequestV1;
    const body = `/jinn-relay decide ${securityRequest.requestDigest} ${exactHead} accept-risk`;
    const common = {
      request: securityRequest, comment: { ...comment(body), actorLogin: 'admin', actorUserId: 'U_admin' },
      currentHead: exactHead, originalAuthorisingMaintainer: { login: 'maintainer', userId: 'U_maintainer' },
      checkedAt: '2026-08-06T12:06:00.000Z', now: '2026-08-06T12:06:00.000Z',
    };
    expect(createRelayHumanDecisionReceipt({ ...common, currentPermission: 'MAINTAIN' })).toEqual({ accepted: false, reason: 'unauthorised' });
    expect(createRelayHumanDecisionReceipt({ ...common, currentPermission: 'ADMIN' })).toMatchObject({ accepted: true, receipt: { binding: 'exact-head-acceptance' } });
  });
});
