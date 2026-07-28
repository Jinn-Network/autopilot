import { describe, expect, it } from 'vitest';
import {
  buildRelaySnapshot,
  canonicalRelaySnapshotBytes,
} from '../../src/issue-relay/snapshot.js';
import type { RelayIssueInput } from '../../src/issue-relay/snapshot.js';

const relayInput: RelayIssueInput = {
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
    title: 'Fix café\r\nnow',
    body: 'Line 1\r\nΔ line',
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
  acceptanceEvidence: ['label:engine:marketplace', 'maintainer:write'],
  admissionPolicyVersion: 'jinn-issue-relay-admission.v1',
  capturedAt: '2026-07-28T12:01:00.000Z',
};

const expectedCanonicalJson = '{"repository":{"slug":"Jinn-Network/mono","nodeId":"R_kgDOExample","visibility":"PUBLIC","defaultBranch":"main","baseOid":"0123456789012345678901234567890123456789"},"issue":{"number":42,"url":"https://github.com/Jinn-Network/mono/issues/42","title":"Fix café\\nnow","body":"Line 1\\nΔ line","authorLogin":"alice","authorId":"U_kgDOBob","updatedAt":"2026-07-28T12:00:00.000Z"},"optIn":{"label":"engine:marketplace","actorLogin":"maintainer","createdAt":"2026-07-28T11:00:00.000Z","permission":"MAINTAIN"},"language":"typescript","verificationProfile":"jinn-mono.v1","acceptanceEvidence":["label:engine:marketplace","maintainer:write"],"admissionPolicyVersion":"jinn-issue-relay-admission.v1","capturedAt":"2026-07-28T12:01:00.000Z"}';

describe('Relay snapshot canonicalization', () => {
  it('emits hand-derived UTF-8 bytes in the contract property order', () => {
    expect(canonicalRelaySnapshotBytes(relayInput))
      .toEqual(Buffer.from(expectedCanonicalJson, 'utf8'));
  });

  it('normalizes CRLF while preserving Unicode code points', () => {
    expect(canonicalRelaySnapshotBytes(relayInput).toString('utf8'))
      .toContain('Fix café\\nnow');
    expect(canonicalRelaySnapshotBytes(relayInput).toString('utf8'))
      .toContain('Line 1\\nΔ line');
    expect(canonicalRelaySnapshotBytes(relayInput).toString('utf8'))
      .not.toContain('\\r');
  });

  it('changes the digest when the issue body changes', () => {
    const original = buildRelaySnapshot(relayInput);
    const changed = buildRelaySnapshot({
      ...relayInput,
      issue: { ...relayInput.issue, body: 'Line 1\r\nchanged' },
    });

    expect(original.snapshotDigest)
      .toBe('sha256:734a2997a28910e57d2e0912919ce9347d70673ce1824422de9f2fa46ad7603f');
    expect(changed.snapshotDigest).not.toBe(original.snapshotDigest);
  });
});
