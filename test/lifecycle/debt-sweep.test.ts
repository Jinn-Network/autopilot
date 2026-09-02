import { describe, expect, it } from 'vitest';
import {
  DEBT_SWEEP_MARKER_TAG,
  DEBT_SWEEP_MAX_MEMBERS,
  DEBT_SWEEP_MIN_MEMBERS,
  DEBT_SWEEP_MAX_PER_CYCLE,
  debtSweepEffort,
  debtSweepPriority,
  rankDebtSweeps,
  fileDebtSweep,
  formatDebtSweepMarker,
  formatDebtSweepMarkerKey,
  formatDebtSweepTitle,
  parseDebtSweepMarker,
  planDebtSweeps,
  type DebtSweepMember,
  type DebtSweepPort,
  type OpenDebtSweepIssue,
} from '../../src/lifecycle/debt-sweep.js';
import {
  formatReviewFollowUpMarker,
  formatReviewFollowUpMarkerKey,
} from '../../src/lifecycle/review-follow-ups.js';

const HEAD = 'a'.repeat(40);

function followUpIssue(
  number: number,
  parentPr: number,
  priority: string | null = 'P4',
): {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly priority: string | null;
} {
  return {
    number,
    title: `Follow-up ${number}`,
    body: `${formatReviewFollowUpMarker(parentPr, HEAD, number)}\n\nbody`,
    priority,
  };
}

function port(overrides: {
  readonly open?: readonly { readonly number: number; readonly title: string; readonly body: string }[];
  readonly created?: number;
  readonly log?: unknown[];
} = {}): DebtSweepPort {
  const open = overrides.open ?? [];
  const log = overrides.log ?? [];
  return {
    async searchOpenByMarker(marker: string): Promise<readonly OpenDebtSweepIssue[]> {
      log.push({ searchOpenByMarker: marker });
      return open
        .filter((issue) => issue.body.includes(marker))
        .map((issue) => ({ number: issue.number, title: issue.title }));
    },
    async createIssue(input) {
      log.push({ createIssue: input });
      return { number: overrides.created ?? 900 };
    },
    async ensureTriageComplete(input) {
      log.push({ ensureTriageComplete: input });
    },
  };
}

describe('debt sweep marker', () => {
  it('round-trips the parent PR and its member list', () => {
    const marker = formatDebtSweepMarker(84, [11, 12, 13]);
    expect(marker).toBe(
      `<!-- ${DEBT_SWEEP_MARKER_TAG} pr=84 members=11,12,13 -->`,
    );
    expect(parseDebtSweepMarker(`prose\n${marker}\nmore`)).toEqual({
      parentPr: 84,
      members: [11, 12, 13],
    });
  });

  it('keys dedup on the parent through pr=<N> with the trailing space', () => {
    expect(formatDebtSweepMarkerKey(84)).toBe(
      `<!-- ${DEBT_SWEEP_MARKER_TAG} pr=84 `,
    );
    // The production search is a substring match over open issue bodies, so
    // without the field boundary PR #84's key matches PR #845's marker.
    expect(formatDebtSweepMarker(845, [1, 2, 3])).not.toContain(
      formatDebtSweepMarkerKey(84),
    );
    expect(formatDebtSweepMarker(84, [1, 2, 3])).toContain(
      formatDebtSweepMarkerKey(84),
    );
  });

  it('rejects a marker with no members', () => {
    expect(() => formatDebtSweepMarker(84, [])).toThrow(/member/i);
  });
});

describe('debt sweep elevation policy', () => {
  it('lifts one step above the most urgent member, capped at P2', () => {
    expect(debtSweepPriority(['p4', 'p4', 'p4'])).toBe('p3');
    expect(debtSweepPriority(['p3', 'p3', 'p3'])).toBe('p2');
    expect(debtSweepPriority(['p2', 'p2', 'p2'])).toBe('p2');
    expect(debtSweepPriority(['p4', 'p3', 'p4'])).toBe('p2');
    expect(debtSweepPriority(['p1', 'p4', 'p4'])).toBe('p2');
  });

  it('sizes effort by member count', () => {
    expect(debtSweepEffort(3)).toBe('medium');
    expect(debtSweepEffort(4)).toBe('medium');
    expect(debtSweepEffort(5)).toBe('high');
    expect(debtSweepEffort(6)).toBe('high');
    expect(debtSweepEffort(7)).toBe('xhigh');
    expect(debtSweepEffort(DEBT_SWEEP_MAX_MEMBERS)).toBe('xhigh');
  });
});

describe('planDebtSweeps', () => {
  it('clusters open follow-ups by parent and excludes an open parent', () => {
    const clusters = planDebtSweeps({
      issues: [
        followUpIssue(101, 84),
        followUpIssue(102, 84),
        followUpIssue(103, 84),
        followUpIssue(201, 90),
        followUpIssue(202, 90),
        followUpIssue(203, 90),
      ],
      openPullRequestNumbers: new Set([90]),
    });
    expect(clusters.map((cluster) => cluster.parentPr)).toEqual([84]);
    expect(clusters[0]!.members.map((member) => member.number)).toEqual([
      101, 102, 103,
    ]);
  });

  it('excludes a parent that was closed unmerged', () => {
    const clusters = planDebtSweeps({
      issues: [
        followUpIssue(101, 84),
        followUpIssue(102, 84),
        followUpIssue(103, 84),
      ],
      openPullRequestNumbers: new Set(),
      closedUnmergedParentPrs: new Set([84]),
    });
    expect(clusters).toEqual([]);
  });

  it('waits below the minimum and caps the maximum, leaving a remainder', () => {
    const small = planDebtSweeps({
      issues: [followUpIssue(101, 84), followUpIssue(102, 84)],
      openPullRequestNumbers: new Set(),
    });
    expect(small).toEqual([]);

    const large = planDebtSweeps({
      issues: Array.from({ length: 11 }, (_unused, index) =>
        followUpIssue(101 + index, 84)),
      openPullRequestNumbers: new Set(),
    });
    expect(large).toHaveLength(1);
    expect(large[0]!.members).toHaveLength(DEBT_SWEEP_MAX_MEMBERS);
    expect(large[0]!.members.map((member) => member.number)).toEqual([
      101, 102, 103, 104, 105, 106, 107, 108,
    ]);
    expect(large[0]!.remainingMembers).toBe(3);
  });

  it('never files a second sweep for a parent that already has one open', () => {
    const clusters = planDebtSweeps({
      issues: [
        followUpIssue(101, 84),
        followUpIssue(102, 84),
        followUpIssue(103, 84),
        followUpIssue(104, 84),
        {
          number: 500,
          title: 'Sweep review follow-ups for PR #84 (3 items)',
          body: formatDebtSweepMarker(84, [101, 102, 103]),
          priority: 'P3',
        },
      ],
      openPullRequestNumbers: new Set(),
    });
    expect(clusters).toEqual([]);
  });

  it('excludes members an open sweep already covers', () => {
    const clusters = planDebtSweeps({
      issues: [
        followUpIssue(101, 84),
        followUpIssue(102, 84),
        followUpIssue(103, 84),
        followUpIssue(201, 90),
        followUpIssue(202, 90),
        followUpIssue(203, 90),
        followUpIssue(204, 90),
        {
          number: 500,
          title: 'Sweep review follow-ups for PR #90 (1 items)',
          // A stale sweep marker naming a member of another parent's cluster
          // must still exclude that member from a new one.
          body: formatDebtSweepMarker(90, [201, 101]),
          priority: 'P3',
        },
      ],
      openPullRequestNumbers: new Set(),
    });
    expect(clusters).toEqual([]);
  });

  it('derives triage from the selected members', () => {
    const clusters = planDebtSweeps({
      issues: [
        followUpIssue(101, 84, 'P4'),
        followUpIssue(102, 84, 'P3'),
        followUpIssue(103, 84, null),
      ],
      openPullRequestNumbers: new Set(),
    });
    expect(clusters[0]).toMatchObject({
      parentPr: 84,
      priority: 'p2',
      effort: 'medium',
    });
    expect(clusters[0]!.members).toEqual([
      { number: 101, priority: 'p4' },
      { number: 102, priority: 'p3' },
      { number: 103, priority: 'p4' },
    ]);
  });
});

describe('rankDebtSweeps', () => {
  it('takes the largest clusters first, bounded per cycle, ties by parent', () => {
    const issues = [
      ...Array.from({ length: 3 }, (_u, index) => followUpIssue(100 + index, 10)),
      ...Array.from({ length: 5 }, (_u, index) => followUpIssue(200 + index, 20)),
      ...Array.from({ length: 4 }, (_u, index) => followUpIssue(300 + index, 30)),
      ...Array.from({ length: 4 }, (_u, index) => followUpIssue(400 + index, 15)),
    ];
    const clusters = planDebtSweeps({
      issues,
      openPullRequestNumbers: new Set(),
    });
    // The plan is complete and parent-ordered; the bound is the caller's.
    expect(clusters.map((cluster) => cluster.parentPr)).toEqual([10, 15, 20, 30]);
    expect(rankDebtSweeps(clusters).map((cluster) => cluster.parentPr))
      .toEqual([20, 15, 30]);
    expect(DEBT_SWEEP_MAX_PER_CYCLE).toBe(3);
  });
});

describe('fileDebtSweep', () => {
  const members: readonly DebtSweepMember[] = [
    { number: 101, priority: 'p4' },
    { number: 102, priority: 'p3' },
    { number: 103, priority: 'p4' },
  ];
  const openFollowUps = [101, 102, 103].map((number) => ({
    number,
    title: `Follow-up ${number}`,
    body: formatReviewFollowUpMarker(84, HEAD, number),
  }));

  it('files a chore sweep, triaged to the elevated priority', async () => {
    const log: unknown[] = [];
    const filed = await fileDebtSweep(
      port({ open: openFollowUps, created: 900, log }),
      { parentPr: 84, members },
    );
    expect(filed).toMatchObject({ status: 'filed', number: 900 });
    expect(log).toContainEqual({
      ensureTriageComplete: {
        issueNumber: 900,
        type: 'chore',
        effort: 'medium',
        priority: 'p2',
      },
    });
    const create = log.find((entry) => (
      typeof entry === 'object' && entry !== null && 'createIssue' in entry
    )) as { createIssue: { title: string; body: string; type: string } };
    expect(create.createIssue.title).toBe(formatDebtSweepTitle(84, 3));
    expect(create.createIssue.type).toBe('chore');
    expect(create.createIssue.body).toContain(formatDebtSweepMarker(84, [101, 102, 103]));
    expect(create.createIssue.body).toContain('#101');
    expect(create.createIssue.body).toContain('Follow-up 102');
  });

  it('refuses a second sweep while one is open for the parent', async () => {
    const log: unknown[] = [];
    const filed = await fileDebtSweep(
      port({
        open: [
          ...openFollowUps,
          {
            number: 500,
            title: 'Sweep review follow-ups for PR #84 (3 items)',
            body: formatDebtSweepMarker(84, [101, 102, 103]),
          },
        ],
        log,
      }),
      { parentPr: 84, members },
    );
    expect(filed).toEqual({ status: 'already-open', number: 500 });
    expect(log).not.toContainEqual(
      expect.objectContaining({ createIssue: expect.anything() }),
    );
  });

  it('skips a member closed independently and waits below the minimum', async () => {
    const filed = await fileDebtSweep(
      port({ open: openFollowUps.slice(0, 2) }),
      { parentPr: 84, members },
    );
    expect(filed).toEqual({ status: 'below-minimum', openMembers: 2 });
  });

  it('reads the live member set through the parent-scoped follow-up key', async () => {
    const log: unknown[] = [];
    await fileDebtSweep(
      port({ open: openFollowUps, log }),
      { parentPr: 84, members },
    );
    expect(log).toContainEqual({
      searchOpenByMarker: formatDebtSweepMarkerKey(84),
    });
    expect(log).toContainEqual({
      searchOpenByMarker: formatReviewFollowUpMarkerKey(84),
    });
  });

  it('never emits a body that would read as a child or a follow-up', async () => {
    await expect(fileDebtSweep(
      port({
        open: [101, 102, 103].map((number) => ({
          number,
          title: number === 102
            ? 'jinn-autopilot:child pr=1 kind=reconcile'
            : `Follow-up ${number}`,
          body: formatReviewFollowUpMarker(84, HEAD, number),
        })),
      }),
      { parentPr: 84, members },
    )).rejects.toThrow(/child marker/i);
  });

  it('states the minimum and maximum it enforces', () => {
    expect(DEBT_SWEEP_MIN_MEMBERS).toBe(3);
    expect(DEBT_SWEEP_MAX_MEMBERS).toBe(8);
  });
});
