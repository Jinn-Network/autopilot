import { describe, expect, it } from 'vitest';
import type { AttemptFootprintRecord } from '../../src/lifecycle/attempt-workspace.js';
import {
  ATTEMPT_FOOTPRINT_HISTORY,
  ATTEMPT_SETTLE_MS,
  diskHeadroomAdmits,
  diskHeadroomSkipDetail,
  diskHeadroomSummaryLine,
  expectedAttemptFootprintBytes,
  projectDiskHeadroom,
  type AttemptFootprintDefaults,
} from '../../src/lifecycle/disk-headroom.js';

const GB = 1024 ** 3;
const DEFAULTS: AttemptFootprintDefaults = { implement: 8 * GB, review: 1 * GB };
/** What one more attempt of each phase costs, as a projection reports it. */
const EXPECTED = { implement: 8 * GB, review: 1 * GB };
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
    // Sorted: 9,10,11,12 → ceil(0.75*4) = 3 → the third smallest.
    expect(expectedAttemptFootprintBytes(
      'implement',
      history('implement', [11 * GB, 9 * GB, 12 * GB, 10 * GB]),
      DEFAULTS,
    )).toBe(11 * GB);
  });

  // #158: `worktreeBytes` is measured once, at the exit transition, which is
  // the smallest a worktree ever is. The mono host recorded 0.19 G exits for
  // implementations observed live at 6.5 G, so p75 of that history reserved a
  // thirtieth of what the attempt took and the 8 G fallback was never reached
  // again. History may raise the estimate; it may never lower it.
  it('never lets history reserve less than the configured default', () => {
    expect(expectedAttemptFootprintBytes(
      'implement',
      history('implement', [0.19 * GB, 0.19 * GB, 0.2 * GB, 0.19 * GB]),
      DEFAULTS,
    )).toBe(8 * GB);
  });

  it('still lets history raise the estimate above the default', () => {
    // The 12.9 G worktrees the same host measured: over-reserving costs a
    // delayed spawn, under-reserving costs the volume.
    expect(expectedAttemptFootprintBytes(
      'implement',
      history('implement', [12 * GB, 12.9 * GB, 13 * GB, 12.5 * GB]),
      DEFAULTS,
    )).toBe(12.9 * GB);
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
    const recent = Array.from({ length: ATTEMPT_FOOTPRINT_HISTORY }, () => 9 * GB);
    expect(expectedAttemptFootprintBytes(
      'implement',
      history('implement', [...stale, ...recent]),
      DEFAULTS,
    )).toBe(9 * GB);
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
      expected: EXPECTED,
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

  // #158, at the level an operator sees it: four implementations settling and
  // a history of nothing but exit-sized records must still reserve four whole
  // attempts, not four fifths of one.
  it('reserves the configured default against a history of tiny exits', () => {
    const headroom = projectDiskHeadroom({
      ...base,
      free: 54 * GB,
      floor: 15 * GB,
      history: history('implement', [0.19 * GB, 0.19 * GB, 0.19 * GB, 0.2 * GB]),
      pendingSpawns: ['implement', 'implement', 'implement', 'implement'],
    });
    expect(headroom.reserved).toBe(32 * GB);
    expect(headroom.settling).toBe(4);
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

/**
 * #159: admission used to be one global `free − reserved < floor` test, so a
 * 0.2 G review was refused because 8 G implementations were settling — 27
 * starved review cycles on mono. `reserved` says nothing about what the
 * candidate itself would cost, and the review lane is what converts
 * implementations into merges.
 */
describe('per-candidate admission (#159)', () => {
  const base = {
    liveAttempts: [],
    pendingSpawns: [],
    history: [],
    defaults: DEFAULTS,
    nowMs: NOW,
  } as const;

  it('admits a review and refuses an implementation against the same disk', () => {
    const headroom = projectDiskHeadroom({
      ...base,
      free: 47.2 * GB,
      floor: 20 * GB,
      liveAttempts: [
        { phase: 'implement', startedAtMs: NOW - 60_000 },
        { phase: 'implement', startedAtMs: NOW - 60_000 },
        { phase: 'implement', startedAtMs: NOW - 60_000 },
      ],
    });
    expect(headroom.reserved).toBe(24 * GB);
    // 47.2 − 24 − 1 = 22.2, above the floor; 47.2 − 24 − 8 = 15.2, below it.
    expect(diskHeadroomAdmits(headroom, 'review')).toBe(true);
    expect(diskHeadroomAdmits(headroom, 'implement')).toBe(false);
    // The lane that can still take work keeps the cycle unpaused.
    expect(headroom.paused).toBe(false);
  });

  it('publishes what one more attempt of each phase would cost', () => {
    const headroom = projectDiskHeadroom({
      ...base,
      free: 47.2 * GB,
      floor: 20 * GB,
      history: history('review', [0.18 * GB, 0.19 * GB, 0.2 * GB, 0.19 * GB]),
    });
    expect(headroom.expected).toEqual({ implement: 8 * GB, review: 1 * GB });
  });

  // The weaker reading of #159 — "never let one phase's reservation gate a
  // cheaper phase" — would admit here. It must not: those bytes are committed
  // and about to land, so the floor is genuinely spoken for, and a floor that
  // yields to the cheapest candidate is not a floor.
  it('refuses even a review once the reservation itself has eaten the floor', () => {
    const headroom = projectDiskHeadroom({
      ...base,
      free: 47.2 * GB,
      floor: 20 * GB,
      liveAttempts: Array.from({ length: 4 }, () => ({
        phase: 'implement' as const,
        startedAtMs: NOW - 60_000,
      })),
    });
    expect(headroom.reserved).toBe(32 * GB);
    expect(diskHeadroomAdmits(headroom, 'review')).toBe(false);
    expect(headroom.paused).toBe(true);
  });

  it('admits every phase when the floor is disabled', () => {
    const headroom = projectDiskHeadroom({
      ...base,
      free: 0,
      floor: 0,
      pendingSpawns: ['implement', 'implement'],
    });
    expect(diskHeadroomAdmits(headroom, 'implement')).toBe(true);
    expect(diskHeadroomAdmits(headroom, 'review')).toBe(true);
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
      expected: EXPECTED,
    })).toBe('free 12.0G − reserved 19.5G for 3 settling attempts < floor 8G');
  });

  it('renders a single settling attempt in the singular', () => {
    expect(diskHeadroomSkipDetail({
      paused: true,
      free: 4 * GB,
      reserved: 8 * GB,
      floor: 8 * GB,
      settling: 1,
      expected: EXPECTED,
    })).toBe('free 4.0G − reserved 8.0G for 1 settling attempt < floor 8G');
  });

  // #159: a refused candidate must name its own cost, or an operator reading
  // `47.2G free` and a refused review has no way to see what was weighed.
  it('names the candidate’s own footprint in the skip it caused', () => {
    expect(diskHeadroomSkipDetail({
      paused: false,
      free: 47.2 * GB,
      reserved: 24 * GB,
      floor: 20 * GB,
      settling: 3,
      expected: EXPECTED,
    }, 'implement')).toBe(
      'free 47.2G − reserved 24.0G for 3 settling attempts − implement 8.0G '
      + '< floor 20G',
    );
  });

  it('renders one cycle summary line', () => {
    expect(diskHeadroomSummaryLine({
      paused: false,
      free: 40 * GB,
      reserved: 8 * GB,
      floor: 8 * GB,
      settling: 1,
      expected: EXPECTED,
    })).toBe('disk: free=40.0G reserved=8.0G floor=8G settling=1 admits=implement,review');
  });

  it('names the lanes the projection still admits, and none when it admits none', () => {
    expect(diskHeadroomSummaryLine({
      paused: false,
      free: 30 * GB,
      reserved: 8 * GB,
      floor: 20 * GB,
      settling: 1,
      expected: EXPECTED,
    })).toBe('disk: free=30.0G reserved=8.0G floor=20G settling=1 admits=review');
    expect(diskHeadroomSummaryLine({
      paused: true,
      free: 20 * GB,
      reserved: 8 * GB,
      floor: 20 * GB,
      settling: 1,
      expected: EXPECTED,
    })).toBe('disk: free=20.0G reserved=8.0G floor=20G settling=1 admits=none');
  });
});
