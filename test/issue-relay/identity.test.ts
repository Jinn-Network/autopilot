import { describe, expect, it } from 'vitest';
import {
  relayBranch,
  relayGeneration,
  relayRoundKey,
  relayTaskKey,
} from '../../src/issue-relay/identity.js';
import { buildRelaySnapshot } from '../../src/issue-relay/snapshot.js';
import type { RelayIssueInput } from '../../src/issue-relay/snapshot.js';

const input: RelayIssueInput = {
  repository: {
    slug: 'Jinn-Network/mono',
    nodeId: 'R_kgDOExample',
    visibility: 'PUBLIC',
    defaultBranch: 'main',
    baseOid: '0123456789012345678901234567890123456789',
  },
  issue: {
    number: 42,
    url: 'https://github.com/Jinn-Network/mono/issues/42',
    title: 'Fix it',
    body: 'The body',
    authorLogin: 'alice',
    authorId: 'U_kgDOBob',
    updatedAt: '2026-07-28T12:00:00.000Z',
  },
  optIn: {
    label: 'engine:marketplace',
    actorLogin: 'maintainer',
    createdAt: '2026-07-28T11:00:00.000Z',
    permission: 'MAINTAIN',
  },
  language: 'typescript',
  verificationProfile: 'jinn-mono.v1',
  acceptanceEvidence: ['label:engine:marketplace'],
  admissionPolicyVersion: 'jinn-issue-relay-admission.v1',
  capturedAt: '2026-07-28T12:01:00.000Z',
};

describe('Relay identity', () => {
  it('binds generation to the repository node ID, issue number, and digest', () => {
    const snapshot = buildRelaySnapshot(input);
    const nodeChanged = buildRelaySnapshot({
      ...input,
      repository: { ...input.repository, nodeId: 'R_kgDOOther' },
    });

    expect(relayGeneration(snapshot))
      .toBe('R_kgDOExample:42:sha256:e61e7fdfef70021de3965dcb61b939ef206557c1538fef66bea2fae904c0aaa7');
    expect(relayGeneration(nodeChanged)).not.toBe(relayGeneration(snapshot));
  });

  it('creates distinct printable keys for each round', () => {
    const generation = relayGeneration(buildRelaySnapshot(input));

    expect(relayRoundKey(generation, 1)).toBe(`issue-relay:${generation}:round:1`);
    expect(relayTaskKey(generation, 2)).toBe(`issue-relay:${generation}:round:2`);
    expect(relayRoundKey(generation, 1)).not.toBe(relayRoundKey(generation, 2));
    expect(relayBranch(generation)).toBe('jinn/issue-relay/87170de88086a7e2d5c1d8f0');
  });
});
