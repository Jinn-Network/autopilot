import { describe, expect, it, vi } from 'vitest';
import {
  IssueRelayDecisionRequestV1Schema,
  issueRelayDecisionKey,
  issueRelayDecisionRequestDigest,
  type IssueRelayDecisionRequestV1,
} from '../../src/issue-relay/contracts.js';
import { observeRelayHumanDecision } from '../../src/issue-relay/decision-observer.js';

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const head = '2'.repeat(40);

function request(): IssueRelayDecisionRequestV1 {
  const proposal = {
    schemaVersion: 'jinn-issue-relay-decision-proposal.v1' as const,
    lane: 'quality' as const,
    reasonCode: 'choice', question: 'Choose one?', authorityCategory: 'authorising-maintainer' as const,
    whyHumanAuthorityIsRequired: 'Product authority is required.', supportingEvidence: [],
    options: [
      { optionId: 'option-a', title: 'A', description: 'Choose A.', effect: 'retain-current-change' as const, consequences: ['A.'], tradeoffs: ['A tradeoff.'] },
      { optionId: 'option-b', title: 'B', description: 'Choose B.', effect: 'implement-change' as const, implementationBrief: 'Implement B.', consequences: ['B.'], tradeoffs: ['B tradeoff.'] },
    ],
    recommendedOptionId: 'option-a', recommendationRationale: 'A is safer.', recommendationConfidence: 'high' as const,
    proposedImplementationPolicy: 'decision-before-implementation' as const,
  };
  const generation = 'relay-v2-generation';
  const snapshotDigest = digest('a');
  const unsigned = {
    schemaVersion: 'jinn-issue-relay-decision-request.v1' as const,
    decisionKey: issueRelayDecisionKey({ generation, snapshotDigest, proposal }),
    generation, round: 0, snapshotDigest, exactHead: head, lane: 'quality' as const,
    proposal, effectiveImplementationPolicy: 'decision-before-implementation' as const,
    implementation: { status: 'not-required' as const },
    requiredRole: 'original-authorising-maintainer' as const,
    allowedActions: ['select-option', 'cancel'] as const,
    createdAt: '2026-08-06T12:00:00.000Z', expiresAt: '2026-08-20T12:00:00.000Z',
  };
  return IssueRelayDecisionRequestV1Schema.parse({ ...unsigned, requestDigest: issueRelayDecisionRequestDigest(unsigned) }) as IssueRelayDecisionRequestV1;
}

function comment(id: number, option = 'option-a') {
  const value = request();
  return {
    commentId: id, nodeId: `IC_${id}`,
    body: `/jinn-relay decide ${value.requestDigest} ${head} ${option}`,
    actorLogin: 'maintainer', actorUserId: 'U_maintainer',
    createdAt: `2026-08-06T12:0${id}:00.000Z`, updatedAt: `2026-08-06T12:0${id}:00.000Z`,
  };
}

describe('observeRelayHumanDecision', () => {
  it('rereads the comment, permission, and exact head before accepting', async () => {
    const source = comment(5);
    const port = {
      listComments: vi.fn().mockResolvedValue([source]),
      readComment: vi.fn().mockResolvedValue(source),
      readHead: vi.fn().mockResolvedValue(head),
      readPermission: vi.fn().mockResolvedValue('WRITE' as const),
    };
    await expect(observeRelayHumanDecision({
      request: request(),
      originalAuthorisingMaintainer: { login: 'maintainer', userId: 'U_maintainer' },
      port,
      now: '2026-08-06T12:06:00.000Z',
    })).resolves.toMatchObject({ state: 'accepted', receipt: { selectedOptionId: 'option-a' } });
    expect(port.readHead).toHaveBeenCalledTimes(2);
    expect(port.readPermission).toHaveBeenCalledWith('maintainer');
  });

  it('ignores a comment deleted or edited before the exact reread', async () => {
    const source = comment(5);
    await expect(observeRelayHumanDecision({
      request: request(),
      originalAuthorisingMaintainer: { login: 'maintainer', userId: 'U_maintainer' },
      port: {
        listComments: async () => [source],
        readComment: async () => ({ ...source, body: `${source.body}\nedited` }),
        readHead: async () => head,
        readPermission: async () => 'WRITE',
      },
      now: '2026-08-06T12:06:00.000Z',
    })).resolves.toEqual({ state: 'pending', detail: 'No immutable authorized Relay decision command is observable' });
  });

  it('rejects two racing authorized commands with different intent', async () => {
    const first = comment(5, 'option-a');
    const second = comment(6, 'option-b');
    const rows = new Map([[5, first], [6, second]]);
    await expect(observeRelayHumanDecision({
      request: request(),
      originalAuthorisingMaintainer: { login: 'maintainer', userId: 'U_maintainer' },
      port: {
        listComments: async () => [second, first],
        readComment: async (id) => rows.get(id),
        readHead: async () => head,
        readPermission: async () => 'WRITE',
      },
      now: '2026-08-06T12:07:00.000Z',
    })).resolves.toMatchObject({ state: 'contradictory' });
  });
});
