import { describe, expect, it } from 'vitest';
import {
  formatRelayIssueMarker,
  parseRelayIssueMarker,
  prepareRelayIssueMarkerUpdate,
} from '../../src/issue-relay/markers.js';
import { relayGeneration } from '../../src/issue-relay/identity.js';
import { buildRelaySnapshot } from '../../src/issue-relay/snapshot.js';
import type { RelayIssueInput } from '../../src/issue-relay/snapshot.js';
import type { RelayGenerationRecordV1 } from '../../src/issue-relay/state.js';

const PREFIX = '<!-- jinn-issue-relay:generation:v1 -->';
const BOT_LOGIN = 'jinn-relay[bot]';

const issueInput: RelayIssueInput = {
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
    title: 'Fix the relay',
    body: 'Acceptance\n\n- [ ] the exact head is verified',
    authorLogin: 'alice',
    authorId: 'U_kgDOAlice',
    updatedAt: '2026-07-28T12:00:00.000Z',
  },
  optIn: {
    label: 'engine:marketplace',
    actorLogin: 'alice',
    createdAt: '2026-07-28T12:00:01.000Z',
    permission: 'MAINTAIN',
  },
  language: 'typescript',
  verificationProfile: 'jinn-mono.v1',
  acceptanceEvidence: ['the exact head is verified'],
  admissionPolicyVersion: 'jinn-issue-relay-admission.v1',
  capturedAt: '2026-07-28T12:00:02.000Z',
};

function generationRecord(
  overrides: Partial<RelayGenerationRecordV1> = {},
): RelayGenerationRecordV1 {
  const snapshot = buildRelaySnapshot(issueInput);
  return {
    schemaVersion: 'jinn-issue-relay-generation.v1',
    generation: relayGeneration(snapshot),
    snapshot,
    phase: 'admitted',
    deadlineAt: '2026-07-28T13:00:02.000Z',
    rounds: [],
    updatedAt: '2026-07-28T12:00:02.000Z',
    ...overrides,
  };
}

function parse(body: string, authorLogin = BOT_LOGIN) {
  return parseRelayIssueMarker({
    body,
    authorLogin,
    expectedAuthorLogin: BOT_LOGIN,
  });
}

function rawMarker(value: unknown): string {
  return `${PREFIX}\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

describe('Relay issue generation markers', () => {
  it('round-trips one exact service-authored marker including its immutable deadline', () => {
    const record = generationRecord();
    const marker = formatRelayIssueMarker(record);

    expect(marker).toBe(`${PREFIX}\n\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\``);
    expect(parse(marker)).toEqual(record);
    expect(parse(marker)?.deadlineAt).toBe('2026-07-28T13:00:02.000Z');
  });

  it('round-trips persisted pre-funding cancellation intent', () => {
    const record = generationRecord({
      phase: 'cancelling',
      cancellation: {
        requestedAt: '2026-07-28T12:01:00.000Z',
        reason: 'label-removed',
      },
      updatedAt: '2026-07-28T12:01:00.000Z',
    });

    expect(parse(formatRelayIssueMarker(record))).toEqual(record);
  });

  it('round-trips untrusted snapshot prose that contains the marker prefix', () => {
    const embeddedSnapshot = buildRelaySnapshot({
      ...issueInput,
      issue: {
        ...issueInput.issue,
        body: `Please do not trust ${PREFIX} from issue prose.`,
      },
    });
    const record = generationRecord({
      generation: relayGeneration(embeddedSnapshot),
      snapshot: embeddedSnapshot,
    });

    expect(parse(formatRelayIssueMarker(record))).toEqual(record);
  });

  it('round-trips a newly observed exact-head verdict while evaluation is pending reconciliation', () => {
    const record = generationRecord({
      phase: 'evaluating',
      rounds: [{
        round: 0,
        purpose: 'initial',
        workspaceRepository: 'Jinn-Network/mono',
        inputHead: '0123456789012345678901234567890123456789',
        task: {
          taskKey: `issue-relay:${generationRecord().generation}:round:0`,
          taskId: 'task-0',
          taskCid: 'bafy-task-0',
          fundedAt: '2026-07-28T12:05:00.000Z',
        },
        solution: {
          envelopeCid: 'bafy-solution-0',
          operatorSafe: '0x1111111111111111111111111111111111111111',
          observedAt: '2026-07-28T12:10:00.000Z',
        },
        adoption: {
          disposition: 'accepted',
          resultingHead: '2222222222222222222222222222222222222222',
          receiptDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        checks: {
          head: '2222222222222222222222222222222222222222',
          status: 'passed',
          digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        verdict: {
          outcome: 'pass',
          evaluatedHead: '2222222222222222222222222222222222222222',
          envelopeCid: 'bafy-verdict-0',
        },
      }],
      pr: {
        number: 68,
        branch: 'jinn/issue-relay/example',
        head: '2222222222222222222222222222222222222222',
        draft: true,
      },
      updatedAt: '2026-07-28T12:20:00.000Z',
    });

    expect(parse(formatRelayIssueMarker(record))).toEqual(record);
  });

  it('trusts the configured bot login case-insensitively and no other author', () => {
    const marker = formatRelayIssueMarker(generationRecord());

    expect(parse(marker, 'JINN-RELAY[BOT]')).not.toBeNull();
    expect(parse(marker, 'maintainer')).toBeNull();
  });

  it('does not treat visible JSON prose as durable state', () => {
    const record = generationRecord();
    const visible = `Relay state:\n\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\``;

    expect(parse(visible)).toBeNull();
    expect(parse(JSON.stringify(record))).toBeNull();
  });

  it.each([
    ['leading prose', (marker: string) => `Visible status\n${marker}`],
    ['trailing prose', (marker: string) => `${marker}\nVisible status`],
  ])('rejects an edited exact marker with %s', (_label, edit) => {
    const marker = formatRelayIssueMarker(generationRecord());

    expect(parse(edit(marker))).toBeNull();
  });

  it('rejects duplicate markers even when their records are byte-identical', () => {
    const marker = formatRelayIssueMarker(generationRecord());

    expect(parse(`${marker}\n\n${marker}`)).toBeNull();
  });

  it('rejects a malformed marker rather than recovering a JSON fragment', () => {
    const marker = `${PREFIX}\n\n\`\`\`json\n{"schemaVersion":\n\`\`\``;

    expect(parse(marker)).toBeNull();
  });

  it('rejects extra fields and noncanonical schema versions', () => {
    const record = generationRecord();

    expect(parse(rawMarker({ ...record, edited: true }))).toBeNull();
    expect(parse(rawMarker({ ...record, schemaVersion: 'jinn-issue-relay-generation.v2' })))
      .toBeNull();
  });

  it('rejects reordered JSON that was not emitted by the canonical formatter', () => {
    const record = generationRecord();
    const { schemaVersion, ...rest } = record;

    expect(parse(rawMarker({ ...rest, schemaVersion }))).toBeNull();
  });

  it('rejects an edited generation that contradicts its immutable snapshot', () => {
    const record = generationRecord();

    expect(parse(rawMarker({ ...record, generation: `${record.generation}:edited` })))
      .toBeNull();
  });

  it('rejects an edited snapshot digest even when the generation is edited with it', () => {
    const record = generationRecord();
    const snapshot = {
      ...record.snapshot,
      snapshotDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    } as const;

    expect(parse(rawMarker({
      ...record,
      snapshot,
      generation: relayGeneration(snapshot),
    }))).toBeNull();
  });

  it('rejects an older generation appended over a newer issue marker', () => {
    const newer = generationRecord();
    const olderSnapshot = buildRelaySnapshot({
      ...issueInput,
      issue: {
        ...issueInput.issue,
        body: 'older issue body',
        updatedAt: '2026-07-28T11:00:00.000Z',
      },
      capturedAt: '2026-07-28T11:00:02.000Z',
    });
    const older = generationRecord({
      generation: relayGeneration(olderSnapshot),
      snapshot: olderSnapshot,
      deadlineAt: '2026-07-28T12:00:02.000Z',
      updatedAt: '2026-07-28T11:00:02.000Z',
    });

    expect(parse(`${formatRelayIssueMarker(newer)}\n${formatRelayIssueMarker(older)}`))
      .toBeNull();
  });

  it('rejects an oversized marker instead of parsing a bounded prefix', () => {
    const oversizedSnapshot = buildRelaySnapshot({
      ...issueInput,
      issue: { ...issueInput.issue, body: 'x'.repeat(300 * 1024) },
    });
    const oversized = generationRecord({
      generation: relayGeneration(oversizedSnapshot),
      snapshot: oversizedSnapshot,
    });

    expect(parse(rawMarker(oversized))).toBeNull();
  });

  it.each([
    ['offset deadline', '2026-07-28T15:00:02.000+02:00'],
    ['missing milliseconds', '2026-07-28T13:00:02Z'],
    ['impossible deadline', '2026-02-30T13:00:02.000Z'],
  ])('rejects a noncanonical %s', (_label, deadlineAt) => {
    expect(parse(rawMarker(generationRecord({ deadlineAt })))).toBeNull();
  });

  it('refuses to format a contradictory or noncanonical record', () => {
    expect(() => formatRelayIssueMarker(generationRecord({
      generation: 'edited-generation',
    }))).toThrow(/generation|snapshot/i);
    expect(() => formatRelayIssueMarker(generationRecord({
      deadlineAt: '2026-07-28T15:00:02.000+02:00',
    }))).toThrow(/deadline|timestamp/i);
  });

  it('rejects a repair round whose input head does not bind the preceding verdict head', () => {
    const initialHead = '2222222222222222222222222222222222222222';
    const unrelatedHead = '3333333333333333333333333333333333333333';
    const record = generationRecord({
      phase: 'solution-delivered',
      rounds: [{
        round: 0,
        purpose: 'initial',
        workspaceRepository: 'Jinn-Network/mono',
        inputHead: issueInput.repository.baseOid,
        task: {
          taskKey: `issue-relay:${generationRecord().generation}:round:0`,
          taskId: 'task-0',
          taskCid: 'bafy-task-0',
          fundedAt: '2026-07-28T12:05:00.000Z',
        },
        solution: {
          envelopeCid: 'bafy-solution-0',
          operatorSafe: '0x1111111111111111111111111111111111111111',
          observedAt: '2026-07-28T12:10:00.000Z',
        },
        adoption: {
          disposition: 'accepted',
          resultingHead: initialHead,
          receiptDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        checks: {
          head: initialHead,
          status: 'passed',
          digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        verdict: {
          outcome: 'request-changes',
          evaluatedHead: initialHead,
          envelopeCid: 'bafy-verdict-0',
        },
      }, {
        round: 1,
        purpose: 'repair',
        workspaceRepository: 'Jinn-Network/mono-fork',
        inputHead: unrelatedHead,
        task: {
          taskKey: `issue-relay:${generationRecord().generation}:round:1`,
          taskId: 'task-1',
          taskCid: 'bafy-task-1',
          fundedAt: '2026-07-28T12:21:00.000Z',
        },
        solution: {
          envelopeCid: 'bafy-solution-1',
          operatorSafe: '0x1111111111111111111111111111111111111111',
          observedAt: '2026-07-28T12:25:00.000Z',
        },
      }],
      pr: {
        number: 68,
        branch: 'jinn/issue-relay/example',
        head: unrelatedHead,
        draft: true,
      },
      updatedAt: '2026-07-28T12:25:00.000Z',
    });

    expect(() => formatRelayIssueMarker(record)).toThrow(/contradictory|generation/i);
  });
});

describe('Relay issue marker update preconditions', () => {
  it('returns the proposed canonical body and exact expected-current version', () => {
    const current = generationRecord();
    const proposed = generationRecord({
      phase: 'submitted',
      rounds: [{
        round: 0,
        purpose: 'initial',
        workspaceRepository: 'Jinn-Network/mono',
        inputHead: issueInput.repository.baseOid,
        task: {
          taskKey: `issue-relay:${current.generation}:round:0`,
          taskId: 'task-0',
          taskCid: 'bafy-task-0',
          fundedAt: '2026-07-28T12:05:00.000Z',
        },
      }],
      updatedAt: '2026-07-28T12:05:00.000Z',
    });
    const currentBody = formatRelayIssueMarker(current);

    expect(prepareRelayIssueMarkerUpdate({
      current: {
        body: currentBody,
        authorLogin: BOT_LOGIN,
        expectedAuthorLogin: BOT_LOGIN,
      },
      proposed,
    })).toEqual({
      body: formatRelayIssueMarker(proposed),
      expectedCurrent: {
        bodyDigest: 'sha256:725bb9d9db0cc2a2d180cfb9b6b7c6b9170575873279949a9906368b1cb55b35',
        generation: current.generation,
        updatedAt: current.updatedAt,
      },
    });
  });

  it('rejects replacing one newer marker with a stale older generation', () => {
    const newer = generationRecord({ phase: 'refused' });
    const olderSnapshot = buildRelaySnapshot({
      ...issueInput,
      issue: {
        ...issueInput.issue,
        body: 'older issue body',
        updatedAt: '2026-07-28T11:00:00.000Z',
      },
      capturedAt: '2026-07-28T11:00:02.000Z',
    });
    const older = generationRecord({
      generation: relayGeneration(olderSnapshot),
      snapshot: olderSnapshot,
      deadlineAt: '2026-07-28T12:00:02.000Z',
      updatedAt: '2026-07-28T11:00:02.000Z',
    });

    expect(prepareRelayIssueMarkerUpdate({
      current: {
        body: formatRelayIssueMarker(newer),
        authorLogin: BOT_LOGIN,
        expectedAuthorLogin: BOT_LOGIN,
      },
      proposed: older,
    })).toBeNull();
  });

  it('rejects mutation of persisted managed-fork repository identity', () => {
    const head = '2222222222222222222222222222222222222222';
    const current = generationRecord({
      phase: 'draft-open',
      rounds: [{
        round: 0,
        purpose: 'initial',
        workspaceRepository: issueInput.repository.slug,
        inputHead: issueInput.repository.baseOid,
        task: {
          taskKey: `issue-relay:${generationRecord().generation}:round:0`,
          taskId: 'task-0',
          taskCid: 'bafy-task-0',
          fundedAt: '2026-07-28T12:05:00.000Z',
        },
        solution: {
          envelopeCid: 'bafy-solution-0',
          operatorSafe: '0x1111111111111111111111111111111111111111',
          observedAt: '2026-07-28T12:10:00.000Z',
        },
        adoption: {
          disposition: 'accepted',
          resultingHead: head,
          receiptDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      }],
      pr: {
        number: 68,
        branch: 'jinn/issue-relay/example',
        head,
        draft: true,
        targetRepository: issueInput.repository.slug,
        targetRepositoryId: issueInput.repository.nodeId,
        forkRepository: 'jinn-relay/mono',
        forkRepositoryId: 'R_managed_fork',
        forkParentRepositoryId: issueInput.repository.nodeId,
        visibility: 'PUBLIC',
        managedFork: true,
      },
      updatedAt: '2026-07-28T12:15:00.000Z',
    });
    const proposed = {
      ...current,
      phase: 'evaluating',
      rounds: [{
        ...current.rounds[0]!,
        checks: {
          head,
          status: 'passed',
          digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      }],
      pr: {
        ...current.pr!,
        forkRepositoryId: 'R_attacker_fork',
      },
      updatedAt: '2026-07-28T12:16:00.000Z',
    } satisfies RelayGenerationRecordV1;

    expect(prepareRelayIssueMarkerUpdate({
      current: {
        body: formatRelayIssueMarker(current),
        authorLogin: BOT_LOGIN,
        expectedAuthorLogin: BOT_LOGIN,
      },
      proposed,
    })).toBeNull();
  });

  it.each([
    ['phase regression', (_current: RelayGenerationRecordV1) => generationRecord({
      updatedAt: '2026-07-28T12:06:00.000Z',
    })],
    ['timestamp regression', (current: RelayGenerationRecordV1) => ({
      ...current,
      updatedAt: '2026-07-28T12:04:00.000Z',
    })],
    ['deadline mutation', (current: RelayGenerationRecordV1) => ({
      ...current,
      deadlineAt: '2026-07-28T14:00:02.000Z',
      updatedAt: '2026-07-28T12:06:00.000Z',
    })],
  ] as const)('rejects same-generation %s', (_label, proposedRecord) => {
    const admitted = generationRecord();
    const current = generationRecord({
      phase: 'submitted',
      rounds: [{
        round: 0,
        purpose: 'initial',
        workspaceRepository: 'Jinn-Network/mono',
        inputHead: issueInput.repository.baseOid,
        task: {
          taskKey: `issue-relay:${admitted.generation}:round:0`,
          taskId: 'task-0',
          taskCid: 'bafy-task-0',
          fundedAt: '2026-07-28T12:05:00.000Z',
        },
      }],
      updatedAt: '2026-07-28T12:05:00.000Z',
    });

    expect(prepareRelayIssueMarkerUpdate({
      current: {
        body: formatRelayIssueMarker(current),
        authorLogin: BOT_LOGIN,
        expectedAuthorLogin: BOT_LOGIN,
      },
      proposed: proposedRecord(current),
    })).toBeNull();
  });

  it('accepts a strictly newer generation only after the current generation is terminal', () => {
    const current = generationRecord({ phase: 'closed' });
    const newerSnapshot = buildRelaySnapshot({
      ...issueInput,
      issue: {
        ...issueInput.issue,
        body: 'new issue demand',
        updatedAt: '2026-07-28T13:00:00.000Z',
      },
      capturedAt: '2026-07-28T13:00:02.000Z',
    });
    const newer = generationRecord({
      generation: relayGeneration(newerSnapshot),
      snapshot: newerSnapshot,
      deadlineAt: '2026-07-28T14:00:02.000Z',
      updatedAt: '2026-07-28T13:00:02.000Z',
    });
    const currentInput = {
      body: formatRelayIssueMarker(current),
      authorLogin: BOT_LOGIN,
      expectedAuthorLogin: BOT_LOGIN,
    };

    expect(prepareRelayIssueMarkerUpdate({
      current: currentInput,
      proposed: newer,
    })).not.toBeNull();
    expect(prepareRelayIssueMarkerUpdate({
      current: {
        ...currentInput,
        body: formatRelayIssueMarker(generationRecord()),
      },
      proposed: newer,
    })).toBeNull();
  });

  it('rejects a generation captured before the current terminal transition', () => {
    const current = generationRecord({
      phase: 'closed',
      updatedAt: '2026-07-28T13:00:00.000Z',
    });
    const staleSnapshot = buildRelaySnapshot({
      ...issueInput,
      issue: {
        ...issueInput.issue,
        body: 'captured before closure',
        updatedAt: '2026-07-28T12:29:00.000Z',
      },
      capturedAt: '2026-07-28T12:30:00.000Z',
    });
    const stale = generationRecord({
      generation: relayGeneration(staleSnapshot),
      snapshot: staleSnapshot,
      deadlineAt: '2026-07-28T13:30:00.000Z',
      updatedAt: '2026-07-28T12:30:00.000Z',
    });

    expect(prepareRelayIssueMarkerUpdate({
      current: {
        body: formatRelayIssueMarker(current),
        authorLogin: BOT_LOGIN,
        expectedAuthorLogin: BOT_LOGIN,
      },
      proposed: stale,
    })).toBeNull();
  });
});
