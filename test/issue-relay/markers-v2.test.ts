import { describe, expect, it } from 'vitest';
import {
  RELAY_GENERATION_V2_MARKER,
  formatRelayIssueMarkerV2,
  parseRelayIssueMarkerV2,
  relayIssueMarkerV2Digest,
  validateRelayIssueMarkerUpdateV2,
} from '../../src/issue-relay/markers-v2.js';
import { relayV2TestRecord } from './v2-fixture.js';

describe('Relay V2 marker', () => {
  it('round-trips a distinct generation.v2 marker without accepting it as another shape', () => {
    const record = relayV2TestRecord();
    const body = formatRelayIssueMarkerV2(record);
    expect(body.startsWith(RELAY_GENERATION_V2_MARKER)).toBe(true);
    expect(parseRelayIssueMarkerV2(body)).toEqual(record);
    expect(relayIssueMarkerV2Digest(body)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(parseRelayIssueMarkerV2(body.replace('generation:v2', 'generation:v1'))).toBeNull();
  });

  it('permits explicit phase progression while rejecting immutable evidence rewrites', () => {
    const current = relayV2TestRecord();
    const expectedBody = formatRelayIssueMarkerV2(current);
    expect(validateRelayIssueMarkerUpdateV2({
      expectedBody,
      proposed: { ...current, phase: 'human-decision-required', updatedAt: '2026-08-06T12:11:00.000Z' },
    })).toBe(true);
    expect(validateRelayIssueMarkerUpdateV2({
      expectedBody,
      proposed: {
        ...current,
        snapshot: { ...current.snapshot, snapshotDigest: `sha256:${'b'.repeat(64)}` },
        updatedAt: '2026-08-06T12:11:00.000Z',
      },
    })).toBe(false);
    expect(validateRelayIssueMarkerUpdateV2({
      expectedBody,
      proposed: { ...current, phase: 'ready', updatedAt: '2026-08-06T12:09:00.000Z' },
    })).toBe(false);
  });

  it('allows an idempotent expected-body rewrite but no terminal rollback', () => {
    const ready = { ...relayV2TestRecord(), phase: 'ready' as const };
    const body = formatRelayIssueMarkerV2(ready);
    expect(validateRelayIssueMarkerUpdateV2({ expectedBody: body, proposed: ready })).toBe(true);
    expect(validateRelayIssueMarkerUpdateV2({
      expectedBody: body,
      proposed: { ...ready, phase: 'evaluating', updatedAt: '2026-08-06T12:11:00.000Z' },
    })).toBe(false);
  });
});
