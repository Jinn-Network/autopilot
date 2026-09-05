import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ATTEMPT_FOOTPRINTS_FILE,
  ATTEMPT_FOOTPRINTS_KEEP,
  attemptFootprintsPathForV2,
  readStoredAttemptFootprints,
  recordAttemptFootprint,
  type StoredAttemptFootprint,
} from '../../src/lifecycle/attempt-footprints.js';

function footprint(
  overrides: Partial<StoredAttemptFootprint> = {},
): StoredAttemptFootprint {
  return {
    attemptId: 'attempt-1',
    host: 'host-1',
    phase: 'implement',
    worktreeBytes: 1000,
    endedAt: '2026-09-04T20:00:00.000Z',
    ...overrides,
  };
}

describe('attempt footprint history (#155)', () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'attempt-footprints-'));
    path = join(root, ATTEMPT_FOOTPRINTS_FILE);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lives beside the v2 attempts base, like trash', () => {
    expect(attemptFootprintsPathForV2(join(root, 'attempts', 'v2')))
      .toBe(join(root, 'attempts', ATTEMPT_FOOTPRINTS_FILE));
  });

  it('round-trips records oldest first and survives the recording process', () => {
    recordAttemptFootprint(path, footprint({
      attemptId: 'b',
      endedAt: '2026-09-04T21:00:00.000Z',
      worktreeBytes: 2000,
    }));
    recordAttemptFootprint(path, footprint({ attemptId: 'a' }));
    expect(readStoredAttemptFootprints(path).map((entry) => entry.attemptId))
      .toEqual(['a', 'b']);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('is idempotent by attempt id: a re-measured attempt replaces, never duplicates', () => {
    recordAttemptFootprint(path, footprint({ worktreeBytes: 1000 }));
    recordAttemptFootprint(path, footprint({ worktreeBytes: 1500 }));
    expect(readStoredAttemptFootprints(path)).toEqual([
      footprint({ worktreeBytes: 1500 }),
    ]);
  });

  it('keeps the newest N per host and phase and drops the oldest beyond that', () => {
    for (let index = 0; index < ATTEMPT_FOOTPRINTS_KEEP + 5; index += 1) {
      recordAttemptFootprint(path, footprint({
        attemptId: `implement-${index}`,
        endedAt: new Date(Date.UTC(2026, 8, 4, 20, index)).toISOString(),
      }));
    }
    // A different phase and a different host each have their own budget.
    recordAttemptFootprint(path, footprint({ attemptId: 'review-1', phase: 'review' }));
    recordAttemptFootprint(path, footprint({ attemptId: 'elsewhere', host: 'host-2' }));
    const stored = readStoredAttemptFootprints(path);
    const implementOnHost1 = stored.filter((entry) => (
      entry.host === 'host-1' && entry.phase === 'implement'
    ));
    expect(implementOnHost1).toHaveLength(ATTEMPT_FOOTPRINTS_KEEP);
    expect(implementOnHost1[0]!.attemptId).toBe('implement-5');
    expect(stored.some((entry) => entry.attemptId === 'review-1')).toBe(true);
    expect(stored.some((entry) => entry.attemptId === 'elsewhere')).toBe(true);
  });

  it('reads a missing or malformed file as an empty history', () => {
    expect(readStoredAttemptFootprints(path)).toEqual([]);
    writeFileSync(path, '{not json');
    expect(readStoredAttemptFootprints(path)).toEqual([]);
    writeFileSync(path, JSON.stringify({ version: 2, footprints: [footprint()] }));
    expect(readStoredAttemptFootprints(path)).toEqual([]);
    writeFileSync(path, JSON.stringify({
      version: 1,
      footprints: [footprint(), { attemptId: 'x', worktreeBytes: 'big' }],
    }));
    expect(readStoredAttemptFootprints(path)).toEqual([footprint()]);
  });

  it('overwrites a malformed file on the next record instead of failing', () => {
    writeFileSync(path, '{not json');
    recordAttemptFootprint(path, footprint());
    expect(readStoredAttemptFootprints(path)).toEqual([footprint()]);
  });

  it('refuses an invalid record rather than writing it', () => {
    expect(() => recordAttemptFootprint(path, footprint({ worktreeBytes: -1 })))
      .toThrow(/Invalid attempt footprint record/);
    expect(readStoredAttemptFootprints(path)).toEqual([]);
  });
});
