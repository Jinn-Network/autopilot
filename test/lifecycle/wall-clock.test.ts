import { describe, expect, it } from 'vitest';
import {
  attemptSessionName,
  formatElapsed,
  formatWallClock,
  heldSeats,
} from '../../src/lifecycle/wall-clock.js';
import type { AttemptManifest } from '../../src/lifecycle/attempt-workspace.js';

const NOW = new Date('2026-09-12T13:00:00.000Z');

function manifest(overrides: Partial<AttemptManifest>): AttemptManifest {
  return {
    phase: 'implement',
    issueNumber: 4188,
    processState: 'running',
    pid: 64106,
    timestamps: {
      createdAt: '2026-09-10T18:49:00.000Z',
      updatedAt: '2026-09-10T18:49:00.000Z',
      childStartedAt: '2026-09-10T18:49:00.000Z',
    },
    ...overrides,
  } as AttemptManifest;
}

describe('session wall clock rendering (#184)', () => {
  it('names a session the way the coordinator logs it', () => {
    expect(attemptSessionName(manifest({}))).toBe('implement-4188');
    expect(attemptSessionName(manifest({ phase: 'review', prNumber: 4190 })))
      .toBe('review-4190');
  });

  it('renders elapsed time with minutes always, and a limit without them when whole', () => {
    expect(formatElapsed(4 * 3_600_000)).toBe('4h 0m');
    expect(formatElapsed(4 * 3_600_000 + 7 * 60_000 + 59_000)).toBe('4h 7m');
    expect(formatElapsed(12 * 60_000)).toBe('12m');
    expect(formatWallClock(4 * 3_600_000)).toBe('4h');
    expect(formatWallClock(2.5 * 3_600_000)).toBe('2h 30m');
    expect(formatWallClock(45 * 60_000)).toBe('45m');
  });
});

describe('held seats (#184)', () => {
  it('reads each live attempt as a seat with its lane, age and time to its deadline', () => {
    const seats = heldSeats([
      manifest({ deadlineAt: '2026-09-12T13:12:00.000Z' }),
      manifest({
        issueNumber: 4191,
        childKind: 'ci-failure',
        deadlineAt: '2026-09-12T12:53:00.000Z',
      }),
      manifest({ issueNumber: 4192, sweep: true }),
      manifest({
        phase: 'review',
        issueNumber: 4193,
        prNumber: 4190,
        timestamps: {
          createdAt: '2026-09-12T12:00:00.000Z',
          updatedAt: '2026-09-12T12:00:00.000Z',
          childStartedAt: '2026-09-12T12:00:00.000Z',
        },
      }),
    ], NOW);

    expect(seats).toEqual([
      {
        lane: 'implementation',
        session: 'implement-4188',
        ageMs: 42 * 3_600_000 + 11 * 60_000,
        untilDeadlineMs: 12 * 60_000,
      },
      {
        lane: 'child',
        session: 'implement-4191',
        ageMs: 42 * 3_600_000 + 11 * 60_000,
        untilDeadlineMs: -7 * 60_000,
      },
      // No deadline recorded: a legacy manifest, listed but never expiring.
      { lane: 'debt', session: 'implement-4192', ageMs: 42 * 3_600_000 + 11 * 60_000 },
      { lane: 'review', session: 'review-4190', ageMs: 3_600_000 },
    ]);
  });

  it('skips an attempt that has not started, which holds no seat', () => {
    expect(heldSeats([manifest({
      processState: 'preparing',
      pid: null,
      timestamps: { createdAt: '2026-09-12T12:00:00.000Z', updatedAt: '2026-09-12T12:00:00.000Z' },
    })], NOW)).toEqual([]);
  });
});
