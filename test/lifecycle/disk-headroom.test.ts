import { describe, expect, it } from 'vitest';
import type { AttemptFootprintRecord } from '../../src/lifecycle/attempt-workspace.js';
import {
  ATTEMPT_FOOTPRINT_HISTORY,
  ATTEMPT_SETTLE_MS,
  diskHeadroomSkipDetail,
  diskHeadroomSummaryLine,
  expectedAttemptFootprintBytes,
  projectDiskHeadroom,
  type AttemptFootprintDefaults,
} from '../../src/lifecycle/disk-headroom.js';

const GB = 1024 ** 3;
const DEFAULTS: AttemptFootprintDefaults = { implement: 8 * GB, review: 1 * GB };
const NOW = Date.parse('2026-09-03T10:00:00.000Z');

function history(
  phase: 'implement' | 'review',
  sizes: readonly number[],
): readonly AttemptFootprintRecord[] {
  return sizes.map((worktreeBytes, index) => ({
    phase,
    worktreeBytes,
    endedAtMs: NOW - (sizes.length - index) * 60_000,
  }));
}

describe('expected attempt footprint', () => {
  it('falls back to the configured default with no history', () => {
    expect(expectedAttemptFootprintBytes('implement', [], DEFAULTS))
      .toBe(8 * GB);
    expect(expectedAttemptFootprintBytes('review', [], DEFAULTS))
      .toBe(1 * GB);
  });

  it('takes the p75 of same-phase history by nearest rank', () => {
    // Sorted: 1,2,3,4 → ceil(0.75*4) = 3 → the third smallest.
    expect(expectedAttemptFootprintBytes(
      'implement',
      history('implement', [3, 1, 4, 2]),
      DEFAULTS,
    )).toBe(3);
  });

  it('ignores history recorded for the other phase', () => {
    expect(expectedAttemptFootprintBytes(
      'review',
      history('implement', [7 * GB, 7 * GB, 7 * GB, 7 * GB]),
      DEFAULTS,
    )).toBe(1 * GB);
  });

  it(`consults only the last ${ATTEMPT_FOOTPRINT_HISTORY} same-phase attempts`, () => {
    const stale = Array.from({ length: 20 }, () => 100 * GB);
    const recent = Array.from({ length: ATTEMPT_FOOTPRINT_HISTORY }, () => 2 * GB);
    expect(expectedAttemptFootprintBytes(
      'implement',
      history('implement', [...stale, ...recent]),
      DEFAULTS,
    )).toBe(2 * GB);
  });
});

describe('disk headroom projection', () => {
  const base = {
    floor: 8 * GB,
    liveAttempts: [],
    pendingSpawns: [],
    history: [],
    defaults: DEFAULTS,
    nowMs: NOW,
  } as const;

  it('reserves the full expected footprint for a spawn already made this cycle', () => {
    const headroom = projectDiskHeadroom({
      ...base,
      free: 12 * GB,
      pendingSpawns: ['implement'],
    });
    expect(headroom).toEqual({
      paused: true,
      free: 12 * GB,
      reserved: 8 * GB,
      floor: 8 * GB,
      settling: 1,
    });
  });

  it('admits the first implement spawn and blocks the second at 12G free', () => {
    const first = projectDiskHeadroom({ ...base, free: 12 * GB });
    expect(first.paused).toBe(false);
    const second = projectDiskHeadroom({
      ...base,
      free: 12 * GB,
      pendingSpawns: ['implement'],
    });
    expect(second.paused).toBe(true);
  });

  it('reserves only what a settling attempt has yet to write', () => {
    const headroom = projectDiskHeadroom({
      ...base,
      free: 12 * GB,
      liveAttempts: [
        { phase: 'implement', startedAtMs: NOW - 60_000, worktreeBytes: 6 * GB },
      ],
    });
    expect(headroom.reserved).toBe(2 * GB);
    expect(headroom.settling).toBe(1);
    expect(headroom.paused).toBe(false);
  });

  it('reserves nothing for an attempt already at or above expected size', () => {
    const headroom = projectDiskHeadroom({
      ...base,
      free: 12 * GB,
      liveAttempts: [
        { phase: 'implement', startedAtMs: NOW - 60_000, worktreeBytes: 9 * GB },
      ],
    });
    expect(headroom.reserved).toBe(0);
    expect(headroom.settling).toBe(0);
  });

  it('treats an unmeasured attempt past the settle window as settled', () => {
    const young = projectDiskHeadroom({
      ...base,
      free: 12 * GB,
      liveAttempts: [
        { phase: 'implement', startedAtMs: NOW - ATTEMPT_SETTLE_MS + 1 },
      ],
    });
    expect(young.reserved).toBe(8 * GB);
    expect(young.settling).toBe(1);
    const settled = projectDiskHeadroom({
      ...base,
      free: 12 * GB,
      liveAttempts: [
        { phase: 'implement', startedAtMs: NOW - ATTEMPT_SETTLE_MS },
      ],
    });
    expect(settled.reserved).toBe(0);
    expect(settled.settling).toBe(0);
  });

  it('reserves a review spawn its own smaller footprint', () => {
    const headroom = projectDiskHeadroom({
      ...base,
      free: 12 * GB,
      pendingSpawns: ['review', 'review', 'review'],
    });
    expect(headroom.reserved).toBe(3 * GB);
    expect(headroom.paused).toBe(false);
  });

  // #146: the executor writes the manifest before the dispatch returns, so a
  // spawn this cycle already made is visible in `liveAttempts` by the time the
  // next dispatch reads the projection. Charging it there *and* as a pending
  // spawn doubled every reservation the cycle made.
  describe('this cycle’s own spawns', () => {
    const CYCLE_START = NOW - 60_000;

    it('charges a spawn once after its own manifest has landed', () => {
      const headroom = projectDiskHeadroom({
        ...base,
        free: 38 * GB,
        cycleStartedAtMs: CYCLE_START,
        liveAttempts: [{ phase: 'implement', startedAtMs: CYCLE_START + 1_000 }],
        pendingSpawns: ['implement'],
      });
      expect(headroom.reserved).toBe(8 * GB);
      expect(headroom.settling).toBe(1);
      expect(headroom.paused).toBe(false);
    });

    it('still charges a pending spawn that has not landed yet', () => {
      // The review cohort's pre-dispatch trim asks about members that have no
      // manifest at all; only the one that landed may be netted off.
      const headroom = projectDiskHeadroom({
        ...base,
        free: 38 * GB,
        cycleStartedAtMs: CYCLE_START,
        liveAttempts: [{ phase: 'implement', startedAtMs: CYCLE_START + 1_000 }],
        pendingSpawns: ['implement', 'implement'],
      });
      expect(headroom.reserved).toBe(16 * GB);
      expect(headroom.settling).toBe(2);
    });

    it('never nets a pending spawn off an attempt older than the cycle', () => {
      const headroom = projectDiskHeadroom({
        ...base,
        free: 38 * GB,
        cycleStartedAtMs: CYCLE_START,
        liveAttempts: [{ phase: 'implement', startedAtMs: CYCLE_START - 1 }],
        pendingSpawns: ['implement'],
      });
      expect(headroom.reserved).toBe(16 * GB);
      expect(headroom.settling).toBe(2);
    });

    it('nets each phase off only its own landed attempts', () => {
      const headroom = projectDiskHeadroom({
        ...base,
        free: 38 * GB,
        cycleStartedAtMs: CYCLE_START,
        liveAttempts: [{ phase: 'review', startedAtMs: CYCLE_START + 1_000 }],
        pendingSpawns: ['implement'],
      });
      expect(headroom.reserved).toBe(9 * GB);
      expect(headroom.settling).toBe(2);
    });

    it('reports the two spawns of the observed cycle as two settling attempts', () => {
      const headroom = projectDiskHeadroom({
        ...base,
        free: 37.7 * GB,
        cycleStartedAtMs: CYCLE_START,
        liveAttempts: [
          { phase: 'implement', startedAtMs: CYCLE_START + 1_000 },
          { phase: 'implement', startedAtMs: CYCLE_START + 2_000 },
        ],
        pendingSpawns: ['implement', 'implement'],
      });
      expect(diskHeadroomSkipDetail(headroom))
        .toBe('free 37.7G − reserved 16.0G for 2 settling attempts < floor 8G');
    });
  });

  it('never pauses when the floor is disabled', () => {
    const headroom = projectDiskHeadroom({
      ...base,
      floor: 0,
      free: 0,
      pendingSpawns: ['implement', 'implement'],
    });
    expect(headroom.paused).toBe(false);
  });

  it('still pauses on current free space alone when nothing is reserved', () => {
    expect(projectDiskHeadroom({ ...base, free: 3.5 * GB }).paused).toBe(true);
  });
});

describe('disk headroom rendering', () => {
  it('renders the skip reason with the arithmetic that produced it', () => {
    expect(diskHeadroomSkipDetail({
      paused: true,
      free: 12 * GB,
      reserved: 19.5 * GB,
      floor: 8 * GB,
      settling: 3,
    })).toBe('free 12.0G − reserved 19.5G for 3 settling attempts < floor 8G');
  });

  it('renders a single settling attempt in the singular', () => {
    expect(diskHeadroomSkipDetail({
      paused: true,
      free: 4 * GB,
      reserved: 8 * GB,
      floor: 8 * GB,
      settling: 1,
    })).toBe('free 4.0G − reserved 8.0G for 1 settling attempt < floor 8G');
  });

  it('renders one cycle summary line', () => {
    expect(diskHeadroomSummaryLine({
      paused: false,
      free: 40 * GB,
      reserved: 8 * GB,
      floor: 8 * GB,
      settling: 1,
    })).toBe('disk: free=40.0G reserved=8.0G floor=8G settling=1');
  });
});
