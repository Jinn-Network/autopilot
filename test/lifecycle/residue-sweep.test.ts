import { describe, expect, it } from 'vitest';
import {
  DEBT_SWEEP_MARKER_TAG,
  DEBT_SWEEP_MAX_MEMBERS,
  DEBT_SWEEP_MAX_PER_CYCLE,
  DEBT_SWEEP_MIN_MEMBERS,
  RESIDUE_AREA_UNKNOWN,
  countResidueFollowUps,
  fileResidueSweep,
  formatResidueSweepMarker,
  formatResidueSweepMarkerKey,
  formatResidueSweepTitle,
  parseDebtSweepMarker,
  parseResidueSweepMarker,
  planDebtSweeps,
  planResidueSweeps,
  rankResidueSweeps,
  residueAreaKey,
  type DebtSweepMember,
  type OpenDebtSweepIssue,
  type OpenDebtSweepIssueBody,
  type ResidueSweepPort,
} from '../../src/lifecycle/debt-sweep.js';
import { formatReviewFollowUpMarker } from '../../src/lifecycle/review-follow-ups.js';

const HEAD = 'a'.repeat(40);

function followUpIssue(
  number: number,
  parentPr: number,
  options: { readonly area?: string; readonly priority?: string | null } = {},
): {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly priority: string | null;
} {
  const cited = options.area === undefined
    ? 'no path here'
    : `See \`${options.area}/thing.ts\` for the finding.`;
  return {
    number,
    title: `Follow-up ${number}`,
    body: `${formatReviewFollowUpMarker(parentPr, HEAD, number)}\n\n${cited}`,
    priority: options.priority ?? 'P4',
  };
}

function port(overrides: {
  readonly open?: readonly { readonly number: number; readonly title: string; readonly body: string }[];
  readonly closed?: readonly { readonly number: number; readonly body: string }[];
  readonly mergedPrs?: Readonly<Record<number, { readonly number: number; readonly body: string }>>;
  readonly created?: number;
  readonly log?: unknown[];
} = {}): ResidueSweepPort {
  const open = overrides.open ?? [];
  const closed = overrides.closed ?? [];
  const mergedPrs = overrides.mergedPrs ?? {};
  const log = overrides.log ?? [];
  return {
    async searchClosedByMarker(marker: string) {
      log.push({ searchClosedByMarker: marker });
      return closed.filter((issue) => issue.body.includes(marker));
    },
    async mergedClosingPullRequest(issueNumber: number) {
      log.push({ mergedClosingPullRequest: issueNumber });
      return mergedPrs[issueNumber] ?? null;
    },
    async closeIssue(issueNumber: number, comment: string) {
      log.push({ closeIssue: { issueNumber, comment } });
    },
    async searchOpenByMarker(marker: string): Promise<readonly OpenDebtSweepIssue[]> {
      log.push({ searchOpenByMarker: marker });
      return open
        .filter((issue) => issue.body.includes(marker))
        .map((issue) => ({ number: issue.number, title: issue.title }));
    },
    async searchOpenBodiesByMarker(marker: string): Promise<readonly OpenDebtSweepIssueBody[]> {
      log.push({ searchOpenBodiesByMarker: marker });
      return open.filter((issue) => issue.body.includes(marker));
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

describe('residue sweep marker', () => {
  it('carries members and no pr=, and keys on the residue field', () => {
    const marker = formatResidueSweepMarker([11, 12, 13]);
    expect(marker).toBe(
      `<!-- ${DEBT_SWEEP_MARKER_TAG} residue=1 members=11,12,13 -->`,
    );
    expect(parseResidueSweepMarker(`prose\n${marker}\n`)).toEqual({
      members: [11, 12, 13],
    });
    expect(marker).toContain(formatResidueSweepMarkerKey());
    // The parent-keyed parser and dedup key must not see a residue sweep.
    expect(parseDebtSweepMarker(marker)).toBeNull();
  });
});

describe('residueAreaKey', () => {
  it('reduces a cited path to packages/<name> or its first segment', () => {
    expect(residueAreaKey('fix `packages/core/src/a.ts` please')).toBe('packages/core');
    expect(residueAreaKey('see src/lifecycle/debt-sweep.ts:57')).toBe('src');
    expect(residueAreaKey('nothing path-like here')).toBe(RESIDUE_AREA_UNKNOWN);
    // A URL is not a repository path.
    expect(residueAreaKey('https://github.com/Jinn-Network/autopilot/issues/1'))
      .toBe(RESIDUE_AREA_UNKNOWN);
  });
});

describe('planResidueSweeps', () => {
  it('groups residue across parents by area and leaves a lone residue behind', () => {
    const input = {
      issues: [
        // Parent 84 is merged with two remaining follow-ups: below the floor.
        followUpIssue(101, 84, { area: 'packages/core' }),
        followUpIssue(102, 84, { area: 'packages/core' }),
        // Parent 85 is merged with one: also below the floor, same area.
        followUpIssue(103, 85, { area: 'packages/core' }),
        // A lone residue in another area waits.
        followUpIssue(104, 86, { area: 'packages/edge' }),
      ],
      openPullRequestNumbers: new Set<number>(),
    };
    const clusters = planResidueSweeps(input);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.area).toBe('packages/core');
    expect(clusters[0]!.members.map((member) => member.number)).toEqual([101, 102, 103]);
    expect(clusters[0]!.parentPrs).toEqual([84, 85]);
    expect(countResidueFollowUps(input)).toBe(4);
  });

  it('never takes a member whose parent is open or closed unmerged', () => {
    const clusters = planResidueSweeps({
      issues: [
        followUpIssue(101, 84, { area: 'packages/core' }),
        followUpIssue(102, 85, { area: 'packages/core' }),
        followUpIssue(103, 86, { area: 'packages/core' }),
      ],
      openPullRequestNumbers: new Set([85]),
      closedUnmergedParentPrs: new Set([86]),
    });
    expect(clusters).toEqual([]);
  });

  it('never takes a member of an open parent sweep or an open residue sweep', () => {
    const clusters = planResidueSweeps({
      issues: [
        followUpIssue(101, 84, { area: 'packages/core' }),
        followUpIssue(102, 85, { area: 'packages/core' }),
        followUpIssue(103, 86, { area: 'packages/core' }),
        followUpIssue(104, 87, { area: 'packages/core' }),
        { number: 900, title: 'open residue sweep', body: formatResidueSweepMarker([101]), priority: null },
      ],
      openPullRequestNumbers: new Set<number>(),
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members.map((member) => member.number)).toEqual([102, 103, 104]);
  });

  it('leaves a parent at or above the per-parent floor to its own sweep', () => {
    const issues = [
      followUpIssue(101, 84, { area: 'packages/core' }),
      followUpIssue(102, 84, { area: 'packages/core' }),
      followUpIssue(103, 84, { area: 'packages/core' }),
      followUpIssue(104, 85, { area: 'packages/core' }),
    ];
    const input = { issues, openPullRequestNumbers: new Set<number>() };
    expect(planDebtSweeps(input).map((cluster) => cluster.parentPr)).toEqual([84]);
    expect(planResidueSweeps(input)).toEqual([]);
    expect(countResidueFollowUps(input)).toBe(1);
  });

  it('groups residue with no readable area together, oldest first', () => {
    const clusters = planResidueSweeps({
      issues: [
        followUpIssue(103, 86),
        followUpIssue(101, 84),
        followUpIssue(102, 85),
      ],
      openPullRequestNumbers: new Set<number>(),
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.area).toBe(RESIDUE_AREA_UNKNOWN);
    expect(clusters[0]!.members.map((member) => member.number)).toEqual([101, 102, 103]);
  });

  it('caps a batch at the maximum and reports the remainder', () => {
    const clusters = planResidueSweeps({
      issues: Array.from({ length: DEBT_SWEEP_MAX_MEMBERS + 2 }, (_unused, index) =>
        followUpIssue(101 + index, 200 + index, { area: 'packages/core' })),
      openPullRequestNumbers: new Set<number>(),
    });
    expect(clusters[0]!.members).toHaveLength(DEBT_SWEEP_MAX_MEMBERS);
    expect(clusters[0]!.remainingMembers).toBe(2);
  });

  it('ranks the biggest area first and spends at most one cycle budget', () => {
    const clusters = rankResidueSweeps([
      { area: 'a', members: [] as unknown as readonly DebtSweepMember[], parentPrs: [], priority: 'p3', effort: 'medium', remainingMembers: 0 },
    ]);
    expect(clusters).toHaveLength(1);
    expect(DEBT_SWEEP_MAX_PER_CYCLE).toBe(3);
  });
});

describe('fileResidueSweep', () => {
  const members: readonly DebtSweepMember[] = [
    { number: 101, priority: 'p4' },
    { number: 102, priority: 'p3' },
    { number: 103, priority: 'p4' },
  ];

  it('files one residue sweep whose marker carries the members and no pr=', async () => {
    const log: unknown[] = [];
    const created = await fileResidueSweep(
      port({
        log,
        open: [
          { number: 101, title: 'A', body: formatReviewFollowUpMarker(84, HEAD, 0) },
          { number: 102, title: 'B', body: formatReviewFollowUpMarker(85, HEAD, 0) },
          { number: 103, title: 'C', body: formatReviewFollowUpMarker(86, HEAD, 0) },
        ],
        created: 900,
      }),
      { area: 'packages/core', members, parentPrs: [84, 85, 86] },
    );
    expect(created).toMatchObject({ status: 'filed', number: 900, members: [101, 102, 103] });
    const createIssue = log.find((entry) => (entry as { createIssue?: unknown }).createIssue) as {
      readonly createIssue: { readonly title: string; readonly body: string; readonly type: string };
    };
    expect(createIssue.createIssue.title).toBe(formatResidueSweepTitle('packages/core', 3));
    expect(createIssue.createIssue.body).toContain(formatResidueSweepMarker([101, 102, 103]));
    expect(createIssue.createIssue.body).not.toContain(' pr=');
  });

  it('drops a member already carried by an open residue sweep', async () => {
    const filed = await fileResidueSweep(
      port({
        open: [
          { number: 900, title: 'sweep', body: formatResidueSweepMarker([101]) },
          { number: 101, title: 'A', body: formatReviewFollowUpMarker(84, HEAD, 0) },
          { number: 102, title: 'B', body: formatReviewFollowUpMarker(85, HEAD, 0) },
          { number: 103, title: 'C', body: formatReviewFollowUpMarker(86, HEAD, 0) },
        ],
      }),
      { area: 'packages/core', members, parentPrs: [84, 85, 86] },
    );
    expect(filed).toEqual({ status: 'below-minimum', openMembers: 2 });
  });

  it('settles a member a merged residue sweep addressed instead of re-filing it', async () => {
    const log: unknown[] = [];
    const filed = await fileResidueSweep(
      port({
        log,
        open: [
          { number: 101, title: 'A', body: formatReviewFollowUpMarker(84, HEAD, 0) },
          { number: 102, title: 'B', body: formatReviewFollowUpMarker(85, HEAD, 0) },
          { number: 103, title: 'C', body: formatReviewFollowUpMarker(86, HEAD, 0) },
        ],
        closed: [{ number: 800, body: formatResidueSweepMarker([101, 102, 103]) }],
        mergedPrs: { 800: { number: 801, body: 'landed everything' } },
      }),
      { area: 'packages/core', members, parentPrs: [84, 85, 86] },
    );
    expect(filed).toMatchObject({
      status: 'already-swept',
      number: 800,
      closedMembers: [101, 102, 103],
      declinedMembers: [],
    });
    expect(log).toContainEqual({
      closeIssue: {
        issueNumber: 101,
        comment: 'Addressed in sweep #800 (merged in PR #801); closed by Autopilot '
          + 'because the sweep session left it open.',
      },
    });
  });

  it('refuses a batch that fell below the minimum since the snapshot', async () => {
    const filed = await fileResidueSweep(
      port({
        open: [{ number: 101, title: 'A', body: formatReviewFollowUpMarker(84, HEAD, 0) }],
      }),
      { area: 'packages/core', members, parentPrs: [84, 85, 86] },
    );
    expect(filed).toEqual({ status: 'below-minimum', openMembers: 1 });
    expect(DEBT_SWEEP_MIN_MEMBERS).toBe(3);
  });
});
