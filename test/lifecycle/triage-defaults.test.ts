import { describe, expect, it } from 'vitest';
import {
  MAX_TRIAGE_DEFAULTS_PER_CYCLE,
  inferIssueShapeFromTitle,
  isUntriaged,
  planTriageDefaults,
  triageGaps,
  type TriageDefaultsIssue,
} from '../../src/lifecycle/triage-defaults.js';

const CHILD_BODY = '<!-- jinn-autopilot:child pr=101 kind=review-finding -->';

function issue(
  number: number,
  overrides: Partial<TriageDefaultsIssue> = {},
): TriageDefaultsIssue {
  return {
    number,
    title: 'feat: something',
    body: '',
    shape: 'feat',
    priority: 'P1',
    status: 'Todo',
    onBoard: true,
    projectItemId: `PVTI_${number}`,
    ...overrides,
  };
}

const POLICY = { defaultPriority: 'P3', inferIssueType: true } as const;

describe('conventional title-prefix inference (#166)', () => {
  it('infers each of the nine work shapes from an explicit prefix', () => {
    for (const shape of [
      'fix', 'feat', 'chore', 'refactor', 'docs', 'test', 'design', 'spike', 'incident',
    ] as const) {
      expect(inferIssueShapeFromTitle(`${shape}: do the thing`)).toBe(shape);
      expect(inferIssueShapeFromTitle(`${shape}(scope): do the thing`)).toBe(shape);
      expect(inferIssueShapeFromTitle(`${shape} the thing`)).toBe(shape);
    }
  });

  it('refuses to guess when the title carries no explicit prefix', () => {
    // The type decides what kind of session runs, so a wrong guess costs more
    // than the wait: everything short of an exact anchored prefix is a miss.
    for (const title of [
      'Make the poller faster',
      'Fix: capitalised is not the convention',
      'fixture: a longer word that merely starts with a shape',
      'feature request: same trap, different shape',
      'test-utils: a hyphen is not a separator',
      ' fix: leading space breaks the anchor',
      'fix',
      '',
    ]) {
      expect(inferIssueShapeFromTitle(title)).toBeNull();
    }
  });
});

describe('triage gaps (#166)', () => {
  it('names the two missing fields independently', () => {
    expect(triageGaps(issue(1))).toEqual({ noType: false, noPriority: false });
    expect(triageGaps(issue(2, { shape: null })))
      .toEqual({ noType: true, noPriority: false });
    expect(triageGaps(issue(3, { priority: null })))
      .toEqual({ noType: false, noPriority: true });
    expect(triageGaps(issue(4, { shape: null, priority: null })))
      .toEqual({ noType: true, noPriority: true });
  });

  it('reads an off-board issue as missing its Priority', () => {
    // Priority is a Project board field: an issue with no board row cannot
    // carry one, so it is untriaged whatever its native Issue Type says.
    expect(isUntriaged(issue(5, {
      onBoard: false,
      projectItemId: null,
      priority: null,
    }))).toBe(true);
    expect(isUntriaged(issue(6))).toBe(false);
  });
});

describe('planTriageDefaults (#166)', () => {
  it('plans the configured default for a board issue with no Priority', () => {
    expect(planTriageDefaults([issue(10, { priority: null })], POLICY)).toEqual([
      { issueNumber: 10, projectItemId: 'PVTI_10', priority: 'P3' },
    ]);
  });

  it('plans the inferred type for a board issue with no Issue Type', () => {
    expect(planTriageDefaults(
      [issue(11, { shape: null, title: 'fix: the poller drops events' })],
      POLICY,
    )).toEqual([
      { issueNumber: 11, projectItemId: 'PVTI_11', issueType: 'fix' },
    ]);
  });

  it('plans both gaps as one action when both are open', () => {
    expect(planTriageDefaults(
      [issue(12, { shape: null, priority: null, title: 'docs: explain the cascade' })],
      POLICY,
    )).toEqual([
      {
        issueNumber: 12,
        projectItemId: 'PVTI_12',
        issueType: 'docs',
        priority: 'P3',
      },
    ]);
  });

  it('never plans a type for a title with no prefix, and plans nothing at all when that is the only gap', () => {
    expect(planTriageDefaults(
      [issue(13, { shape: null, title: 'Make the poller faster' })],
      POLICY,
    )).toEqual([]);
    // The Priority gap is still repaired; the type gap is simply left open.
    expect(planTriageDefaults(
      [issue(14, { shape: null, priority: null, title: 'Make the poller faster' })],
      POLICY,
    )).toEqual([
      { issueNumber: 14, projectItemId: 'PVTI_14', priority: 'P3' },
    ]);
  });

  it('honours a disarmed inferIssueType without touching the Priority default', () => {
    expect(planTriageDefaults(
      [issue(15, { shape: null, priority: null, title: 'fix: something' })],
      { defaultPriority: 'P2', inferIssueType: false },
    )).toEqual([
      { issueNumber: 15, projectItemId: 'PVTI_15', priority: 'P2' },
    ]);
  });

  it('leaves a machine child to its own repair', () => {
    expect(planTriageDefaults(
      [issue(16, { body: CHILD_BODY, shape: null, priority: null, title: 'fix: child' })],
      POLICY,
    )).toEqual([]);
  });

  it('skips an issue with no board row, a Done issue, and a fully triaged issue', () => {
    expect(planTriageDefaults([
      issue(17, { onBoard: false, projectItemId: null, priority: null }),
      issue(18, { onBoard: true, projectItemId: null, priority: null }),
      issue(19, { status: 'Done', priority: null }),
      issue(20),
    ], POLICY)).toEqual([]);
  });

  it('bounds one cycle to MAX_TRIAGE_DEFAULTS_PER_CYCLE, oldest issue first', () => {
    const neglected = Array.from({ length: 25 }, (_, index) => (
      issue(200 - index, { priority: null })
    ));
    const planned = planTriageDefaults(neglected, POLICY);

    expect(MAX_TRIAGE_DEFAULTS_PER_CYCLE).toBe(10);
    expect(planned).toHaveLength(MAX_TRIAGE_DEFAULTS_PER_CYCLE);
    // Ascending issue number: a board neglected for twelve days gets its
    // oldest gaps closed first, and the order is the same every cycle.
    expect(planned.map((entry) => entry.issueNumber))
      .toEqual([176, 177, 178, 179, 180, 181, 182, 183, 184, 185]);
  });
});
