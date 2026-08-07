import type { RelayGenerationRecordV2 } from '../../src/issue-relay/state-v2.js';
import { relayGeneration } from '../../src/issue-relay/identity.js';
import { buildRelaySnapshot } from '../../src/issue-relay/snapshot.js';

const head = (character: string) => character.repeat(40);

export function relayV2TestRecord(): RelayGenerationRecordV2 {
  const snapshot = buildRelaySnapshot({
    repository: {
      slug: 'Jinn-Network/mono', nodeId: 'R_kgDOExample', visibility: 'PUBLIC',
      defaultBranch: 'next', baseOid: head('1'),
    },
    issue: {
      number: 42, url: 'https://github.com/Jinn-Network/mono/issues/42',
      title: 'Fix the relay', body: 'Acceptance criteria.', authorLogin: 'maintainer',
      authorId: 'U_maintainer', updatedAt: '2026-08-06T12:00:00.000Z',
    },
    optIn: {
      label: 'engine:marketplace', actorLogin: 'maintainer', permission: 'WRITE',
      createdAt: '2026-08-06T12:01:00.000Z',
    },
    acceptanceEvidence: ['Acceptance criteria.'], language: 'typescript',
    verificationProfile: 'jinn-mono.v1',
    admissionPolicyVersion: 'jinn-issue-relay-admission.v1',
    capturedAt: '2026-08-06T12:02:00.000Z',
  });
  return {
    schemaVersion: 'jinn-issue-relay-generation.v2',
    generation: relayGeneration(snapshot),
    snapshot,
    phase: 'evaluating',
    executionDeadlineAt: '2026-08-07T12:00:00.000Z',
    rounds: [], decisions: [],
    pr: { number: 314, branch: 'jinn/relay', head: head('2'), draft: true },
    updatedAt: '2026-08-06T12:10:00.000Z',
  };
}
