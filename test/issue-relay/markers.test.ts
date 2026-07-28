import { describe, expect, it } from 'vitest';
import {
  formatRelayIssueMarker,
  parseRelayIssueMarker,
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
});
