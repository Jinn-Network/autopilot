import { describe, expect, it, vi } from 'vitest';
import {
  carryoverEnabled,
  childrenPathEnabled,
  closeChildrenFor,
  countChildrenOfKind,
  fileChildIssue,
  findOpenChildren,
  formatChildMarker,
  formatChildTriageIntent,
  isMachineChildIssue,
  parseChildMarker,
  parseChildTriageIntent,
  resolveChildTriageExpectation,
  shouldFileRunawayHold,
  type ChildIssuePort,
  type ChildIssueRecord,
} from '../../src/lifecycle/child-issues.js';
import {
  GitHubUsageMeter,
  makeGitHubUsageCommandRunner,
} from '../../src/lifecycle/github-usage.js';
import { createProjectTriageApplier } from '../../src/lifecycle/project-triage.js';

function record(
  over: Partial<ChildIssueRecord> & Pick<ChildIssueRecord, 'number' | 'kind' | 'parentPr'>,
): ChildIssueRecord {
  const marker = formatChildMarker(over.parentPr, over.kind);
  return {
    title: over.title ?? `Child ${over.number}`,
    body: over.body ?? `${marker}\n\nfindings`,
    state: over.state ?? 'open',
    labels: over.labels ?? [over.kind],
    ...over,
  };
}

function fakePort(seed: ChildIssueRecord[] = []): ChildIssuePort & {
  readonly created: { title: string; body: string; labels: string[] }[];
  readonly closed: number[];
  readonly typed: number[];
  readonly triaged: Array<{ issueNumber: number; effort: string; priority: string }>;
} {
  const issues = [...seed];
  const created: { title: string; body: string; labels: string[] }[] = [];
  const closed: number[] = [];
  const typed: number[] = [];
  const triaged: Array<{ issueNumber: number; effort: string; priority: string }> = [];
  let next = Math.max(0, ...issues.map((issue) => issue.number)) + 1;
  return {
    created,
    closed,
    typed,
    triaged,
    async searchOpenByMarker(marker) {
      return issues.filter(
        (issue) => issue.state === 'open' && issue.body.includes(marker),
      );
    },
    async listByParentAndKind(parentPr, kind) {
      return issues.filter(
        (issue) => issue.parentPr === parentPr && issue.kind === kind,
      );
    },
    async createIssue(input) {
      created.push({ ...input, labels: [...input.labels] });
      const marker = parseChildMarker(input.body);
      if (marker === null) throw new Error('create without marker');
      const number = next;
      next += 1;
      issues.push({
        number,
        title: input.title,
        body: input.body,
        state: 'open',
        labels: [...input.labels],
        parentPr: marker.parentPr,
        kind: marker.kind,
      });
      return { number };
    },
    async setIssueTypeFix(issueNumber) {
      typed.push(issueNumber);
    },
    async ensureTriageComplete(input) {
      triaged.push({ ...input });
    },
    async closeIssue(issueNumber, _comment) {
      closed.push(issueNumber);
      const index = issues.findIndex((issue) => issue.number === issueNumber);
      if (index >= 0) {
        issues[index] = { ...issues[index]!, state: 'closed' };
      }
    },
  };
}

describe('child marker parse/format', () => {
  it('round-trips review-finding, reconcile, and ci-failure markers', () => {
    for (const kind of ['review-finding', 'reconcile', 'ci-failure'] as const) {
      const marker = formatChildMarker(42, kind);
      expect(marker).toBe(`<!-- jinn-autopilot:child pr=42 kind=${kind} -->`);
      expect(parseChildMarker(marker)).toEqual({ parentPr: 42, kind });
      expect(parseChildMarker(`preamble\n${marker}\ntrail`)).toEqual({
        parentPr: 42,
        kind,
      });
    }
  });

  it('round-trips additive triage intent without changing the authoritative child marker', () => {
    const childMarker = formatChildMarker(42, 'reconcile');
    const triageIntent = formatChildTriageIntent({
      issueType: 'fix',
      effort: 'medium',
      priority: 'p1',
    });

    expect(childMarker).toBe('<!-- jinn-autopilot:child pr=42 kind=reconcile -->');
    expect(triageIntent).toBe(
      '<!-- jinn-autopilot:child-triage type=fix effort=medium priority=p1 -->',
    );
    expect(parseChildTriageIntent(`${childMarker}\n\n${triageIntent}`)).toEqual({
      issueType: 'fix',
      effort: 'medium',
      priority: 'p1',
    });
  });

  it('uses Fix/Medium/P1 only for legacy reconcile children without triage intent', () => {
    expect(resolveChildTriageExpectation(
      formatChildMarker(2140, 'reconcile'),
      'reconcile',
    )).toEqual({
      issueType: 'fix',
      effort: 'medium',
      priority: 'p1',
    });
    expect(resolveChildTriageExpectation(
      formatChildMarker(84, 'review-finding'),
      'review-finding',
    )).toBeNull();
  });

  it.each([
    {
      label: 'malformed',
      body: [
        '<!-- jinn-autopilot:child pr=2140 kind=reconcile -->',
        '<!-- jinn-autopilot:child-triage type=fix effort=max priority=p1 -->',
      ].join('\n\n'),
    },
    {
      label: 'duplicate',
      body: [
        '<!-- jinn-autopilot:child pr=2140 kind=reconcile -->',
        '<!-- jinn-autopilot:child-triage type=fix effort=medium priority=p1 -->',
        '<!-- jinn-autopilot:child-triage type=fix effort=medium priority=p1 -->',
      ].join('\n\n'),
    },
  ])('does not apply the reconcile legacy fallback to $label durable intent', ({
    body,
  }) => {
    expect(parseChildTriageIntent(body)).toBeNull();
    expect(resolveChildTriageExpectation(body, 'reconcile')).toBeNull();
  });

  it('rejects malformed markers', () => {
    expect(parseChildMarker('<!-- jinn-autopilot:child pr=0 kind=reconcile -->')).toBeNull();
    expect(parseChildMarker('<!-- jinn-autopilot:child pr=1 kind=finding -->')).toBeNull();
    expect(parseChildMarker('no marker')).toBeNull();
  });
});

describe('isMachineChildIssue', () => {
  it('recognizes marker-only issues without kind labels', () => {
    const body = formatChildMarker(42, 'ci-failure');
    expect(isMachineChildIssue({ body, labels: [] })).toBe(true);
    expect(isMachineChildIssue({ body })).toBe(true);
  });

  it('rejects label-only issues without a body marker', () => {
    expect(isMachineChildIssue({ body: 'no marker', labels: ['ci-failure'] })).toBe(false);
  });
});

describe('fileChildIssue', () => {
  it('creates once and is idempotent on the open marker', async () => {
    const port = fakePort();
    const first = await fileChildIssue(port, {
      parentPr: 10,
      kind: 'review-finding',
      title: 'Fix findings for #10',
      body: 'Blocking: missing test',
      effort: 'low',
      priority: 'p1',
    });
    expect(first).toMatchObject({ created: true });
    if ('runawayHold' in first && first.runawayHold) throw new Error('unexpected hold');
    expect(port.created).toHaveLength(1);
    expect(port.created[0]!.labels).toEqual(['review-finding']);
    expect(port.created[0]!.body.split('\n\n').slice(0, 2)).toEqual([
      formatChildMarker(10, 'review-finding'),
      formatChildTriageIntent({
        issueType: 'fix',
        effort: 'low',
        priority: 'p1',
      }),
    ]);
    expect(port.typed).toEqual([first.number]);
    expect(port.triaged).toEqual([
      { issueNumber: first.number, effort: 'low', priority: 'p1' },
    ]);

    const second = await fileChildIssue(port, {
      parentPr: 10,
      kind: 'review-finding',
      title: 'Fix findings for #10 again',
      body: 'more',
      effort: 'medium',
      priority: 'p1',
    });
    expect(second).toEqual({ number: first.number, created: false });
    expect(port.created).toHaveLength(1);
    expect(port.triaged).toEqual([
      { issueNumber: first.number, effort: 'low', priority: 'p1' },
    ]);
  });

  it('allows a different kind on the same parent', async () => {
    const port = fakePort([
      record({ number: 1, parentPr: 7, kind: 'review-finding' }),
    ]);
    const result = await fileChildIssue(port, {
      parentPr: 7,
      kind: 'reconcile',
      title: 'Reconcile #7',
      body: 'conflicts',
      effort: 'medium',
      priority: 'p1',
    });
    expect(result).toMatchObject({ created: true });
    if ('runawayHold' in result && result.runawayHold) throw new Error('unexpected hold');
    expect(port.created[0]!.labels[0]).toBe('reconcile');
  });

  it('adds triage intent beside an existing authoritative marker without duplicating it', async () => {
    const port = fakePort();
    const marker = formatChildMarker(7, 'reconcile');
    await fileChildIssue(port, {
      parentPr: 7,
      kind: 'reconcile',
      title: 'Reconcile #7',
      body: `Context before marker\n\n${marker}\n\nconflicts`,
      effort: 'medium',
      priority: 'p1',
    });

    expect(port.created[0]!.body.match(/jinn-autopilot:child pr=/g)).toHaveLength(1);
    expect(port.created[0]!.body).toContain('Context before marker');
    expect(port.created[0]!.body).toContain(
      formatChildTriageIntent({
        issueType: 'fix',
        effort: 'medium',
        priority: 'p1',
      }),
    );
  });

  it.each([
    {
      label: 'malformed',
      body: [
        '<!-- jinn-autopilot:child pr=7 kind=reconcile -->',
        '<!-- jinn-autopilot:child-triage type=fix effort=max priority=p1 -->',
      ].join('\n\n'),
    },
    {
      label: 'duplicate',
      body: [
        '<!-- jinn-autopilot:child pr=7 kind=reconcile -->',
        '<!-- jinn-autopilot:child-triage type=fix effort=medium priority=p1 -->',
        '<!-- jinn-autopilot:child-triage type=fix effort=medium priority=p1 -->',
      ].join('\n\n'),
    },
    {
      label: 'mismatched',
      body: [
        '<!-- jinn-autopilot:child pr=7 kind=reconcile -->',
        '<!-- jinn-autopilot:child-triage type=fix effort=low priority=p2 -->',
      ].join('\n\n'),
    },
  ])('rejects $label durable triage intent before creating a child', async ({
    body,
  }) => {
    const port = fakePort();

    await expect(fileChildIssue(port, {
      parentPr: 7,
      kind: 'reconcile',
      title: 'Reconcile #7',
      body,
      effort: 'medium',
      priority: 'p1',
    })).rejects.toThrow(/triage intent/i);
    expect(port.created).toEqual([]);
    expect(port.typed).toEqual([]);
    expect(port.triaged).toEqual([]);
  });

  it('returns runawayHold when prior children of the kind already hit the limit', async () => {
    const port = fakePort([
      record({ number: 1, parentPr: 8, kind: 'reconcile', state: 'closed' }),
      record({ number: 2, parentPr: 8, kind: 'reconcile', state: 'closed' }),
      record({ number: 3, parentPr: 8, kind: 'reconcile', state: 'closed' }),
    ]);
    const result = await fileChildIssue(port, {
      parentPr: 8,
      kind: 'reconcile',
      title: 'Reconcile #8 again',
      body: 'still conflicting',
      effort: 'medium',
      priority: 'p1',
    });
    expect(result).toEqual({ runawayHold: true, priorCount: 3 });
    expect(port.created).toHaveLength(0);
  });
});

describe('findOpenChildren / closeChildrenFor', () => {
  it('lists open children and closes them', async () => {
    const port = fakePort([
      record({ number: 1, parentPr: 3, kind: 'review-finding' }),
      record({ number: 2, parentPr: 3, kind: 'reconcile' }),
      record({ number: 3, parentPr: 3, kind: 'reconcile', state: 'closed' }),
      record({ number: 4, parentPr: 9, kind: 'reconcile' }),
    ]);
    const open = await findOpenChildren(port, 3);
    expect(open.map((issue) => issue.number).sort()).toEqual([1, 2]);

    const closed = await closeChildrenFor(port, 3, 'parent merged');
    expect([...closed].sort()).toEqual([1, 2]);
    expect([...port.closed].sort()).toEqual([1, 2]);
    expect(await findOpenChildren(port, 3)).toEqual([]);
  });
});

describe('runaway helpers and knobs', () => {
  it('counts prior children of one kind', async () => {
    const port = fakePort([
      record({ number: 1, parentPr: 5, kind: 'reconcile' }),
      record({ number: 2, parentPr: 5, kind: 'reconcile', state: 'closed' }),
      record({ number: 3, parentPr: 5, kind: 'review-finding' }),
    ]);
    expect(await countChildrenOfKind(port, 5, 'reconcile')).toBe(2);
    expect(shouldFileRunawayHold(2)).toBe(false);
    expect(shouldFileRunawayHold(3)).toBe(true);
  });

  it('defaults children on and carryover on (Stage 4)', () => {
    expect(childrenPathEnabled({})).toBe(true);
    expect(childrenPathEnabled({ JINN_AUTOPILOT_CHILDREN: '0' })).toBe(false);
    expect(childrenPathEnabled({ JINN_AUTOPILOT_CHILDREN: 'false' })).toBe(false);
    expect(carryoverEnabled({})).toBe(true);
    expect(carryoverEnabled({ JINN_AUTOPILOT_CARRYOVER: '' })).toBe(true);
    expect(carryoverEnabled({ JINN_AUTOPILOT_CARRYOVER: '0' })).toBe(false);
    expect(carryoverEnabled({ JINN_AUTOPILOT_CARRYOVER: 'false' })).toBe(false);
    expect(carryoverEnabled({ JINN_AUTOPILOT_CARRYOVER: 'no' })).toBe(false);
    expect(carryoverEnabled({ JINN_AUTOPILOT_CARRYOVER: 'off' })).toBe(false);
    expect(carryoverEnabled({ JINN_AUTOPILOT_CARRYOVER: '1' })).toBe(true);
    expect(carryoverEnabled({ JINN_AUTOPILOT_CARRYOVER: 'yes' })).toBe(true);
  });
});

const FIELD_LIST_JSON = JSON.stringify({
  fields: [
    {
      id: 'PVTSSF_blocked',
      name: 'Blocked on',
      options: [
        { id: 'opt_nothing', name: 'Nothing' },
        { id: 'opt_human', name: 'Human' },
      ],
    },
    {
      id: 'PVTSSF_effort',
      name: 'Effort',
      options: [
        { id: 'opt_low', name: 'Low' },
        { id: 'opt_medium', name: 'Medium' },
        { id: 'opt_high', name: 'High' },
        { id: 'opt_xhigh', name: 'XHigh' },
        { id: 'opt_max', name: 'Max' },
      ],
    },
    {
      id: 'PVTSSF_priority',
      name: 'Priority',
      options: [
        { id: 'opt_p0', name: 'P0' },
        { id: 'opt_p1', name: 'P1' },
        { id: 'opt_p2', name: 'P2' },
        { id: 'opt_p3', name: 'P3' },
        { id: 'opt_p4', name: 'P4' },
      ],
    },
  ],
});

describe('machine triage mutation order', () => {
  it('applies Project field mutations sequentially', async () => {
    let activeEdits = 0;
    let maxConcurrentEdits = 0;
    const applier = createProjectTriageApplier(async (_cmd, args) => {
      if (args[0] === 'project' && args[1] === 'field-list') return FIELD_LIST_JSON;
      if (args[0] === 'project' && args[1] === 'item-add') {
        return JSON.stringify({ id: 'PVTI_child99' });
      }
      if (args[0] === 'project' && args[1] === 'item-edit') {
        activeEdits += 1;
        maxConcurrentEdits = Math.max(maxConcurrentEdits, activeEdits);
        await Promise.resolve();
        activeEdits -= 1;
        return '';
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    }, {
      repo: 'example/widgets',
      projectOwner: 'example',
      projectNumber: 1,
    });

    await applier.applyMachineTriage({
      issueNumber: 99,
      effort: 'medium',
      priority: 'p1',
    });

    expect(maxConcurrentEdits).toBe(1);
  });
});

describe('production port GraphQL type assign contract', () => {
  it('resolves the repository organization fix Issue Type and applies Project triage', async () => {
    const { makeProductionChildIssuePort } = await import(
      '../../src/lifecycle/child-issues-production.js'
    );

    const calls: string[][] = [];
    let activeItemEdits = 0;
    let maxConcurrentItemEdits = 0;
    const meter = new GitHubUsageMeter();
    const port = makeProductionChildIssuePort({
      runner: makeGitHubUsageCommandRunner(async (_cmd, args) => {
        calls.push([...args]);
        if (args[0] === 'issue' && args[1] === 'list') {
          return '[]';
        }
        if (args[0] === 'issue' && args[1] === 'create') {
          return 'https://github.com/Jinn-Network/mono/issues/99\n';
        }
        if (args[0] === 'issue' && args[1] === 'view') {
          return 'I_kwIssue99\n';
        }
        if (args[0] === 'api' && args[1] === 'graphql') {
          if (args.some((arg) => arg.includes('OpaqueGitHubUsageProbe'))) {
            return JSON.stringify({
              data: {
                rateLimit: {
                  cost: 1,
                  remaining: 4_999,
                  resetAt: '2026-07-24T13:00:00.000Z',
                  used: 1,
                  limit: 5_000,
                },
              },
            });
          }
          if (args.some((arg) => arg.includes('issueTypes(first: 100)'))) {
            return JSON.stringify({
              data: {
                organization: {
                  issueTypes: {
                    nodes: [{ id: 'IT_example_fix', name: 'fix', isEnabled: true }],
                  },
                },
                rateLimit: {
                  cost: 1,
                  remaining: 4_999,
                  resetAt: '2026-07-24T13:00:00.000Z',
                },
              },
            });
          }
          return '{"data":{}}';
        }
        if (args[0] === 'project' && args[1] === 'field-list') {
          return FIELD_LIST_JSON;
        }
        if (args[0] === 'project' && args[1] === 'item-add') {
          return JSON.stringify({ id: 'PVTI_child99' });
        }
        if (args[0] === 'project' && args[1] === 'item-edit') {
          activeItemEdits += 1;
          maxConcurrentItemEdits = Math.max(maxConcurrentItemEdits, activeItemEdits);
          await Promise.resolve();
          activeItemEdits -= 1;
          return '';
        }
        return '';
      }, meter),
      repo: 'example/widgets',
    });

    const filed = await fileChildIssue(port, {
      parentPr: 12,
      kind: 'reconcile',
      title: 'Reconcile',
      body: 'x',
      effort: 'low',
      priority: 'p1',
    });
    expect(filed).toEqual({ number: 99, created: true });
    const graphql = calls.find((args) =>
      args[0] === 'api'
      && args[1] === 'graphql'
      && args.some((arg) => arg === 'typeId=IT_example_fix'),
    );
    expect(graphql?.join(' ')).toContain('typeId=IT_example_fix');
    expect(graphql?.join(' ')).toContain('issueId=I_kwIssue99');
    expect(calls.flat().some((arg) => arg.includes('IT_kwDODh3-Ac4BvpyK'))).toBe(false);

    const createCall = calls.find((args) => args[0] === 'issue' && args[1] === 'create');
    expect(createCall).toEqual(expect.arrayContaining(['--label', 'reconcile']));
    expect(createCall!.join(' ')).not.toContain('effort:');
    expect(createCall!.join(' ')).not.toContain('priority:');

    const itemEdits = calls.filter((args) => args[0] === 'project' && args[1] === 'item-edit');
    expect(itemEdits).toHaveLength(3);
    expect(itemEdits.some((args) =>
      args.includes('PVTSSF_blocked') && args.includes('opt_nothing'),
    )).toBe(true);
    expect(itemEdits.some((args) =>
      args.includes('PVTSSF_effort') && args.includes('opt_low'),
    )).toBe(true);
    expect(itemEdits.some((args) =>
      args.includes('PVTSSF_priority') && args.includes('opt_p1'),
    )).toBe(true);
    expect(maxConcurrentItemEdits).toBe(1);
    expect(meter.read()).toMatchObject({
      graphqlRequests: expect.any(Number),
      accountingComplete: false,
    });
    // silence unused vi import if tree-shaken differently
    expect(vi).toBeDefined();
  });

  it('creates without labels when labeled create fails, then best-effort adds label', async () => {
    const { makeProductionChildIssuePort } = await import(
      '../../src/lifecycle/child-issues-production.js'
    );
    let createAttempts = 0;
    const calls: string[][] = [];
    const port = makeProductionChildIssuePort({
      runner: async (_cmd, args) => {
        calls.push([...args]);
        if (args[0] === 'label' && args[1] === 'create') {
          throw new Error('label create denied');
        }
        if (args[0] === 'issue' && args[1] === 'list') {
          return '[]';
        }
        if (args[0] === 'issue' && args[1] === 'create') {
          createAttempts += 1;
          if (createAttempts === 1) {
            throw new Error('could not add label: ci-failure');
          }
          return 'https://github.com/example/widgets/issues/100\n';
        }
        if (args[0] === 'issue' && args[1] === 'view') {
          return 'I_kwIssue100\n';
        }
        if (args[0] === 'issue' && args[1] === 'edit') {
          return '';
        }
        if (args[0] === 'api' && args[1] === 'graphql') {
          return '{"data":{}}';
        }
        if (args[0] === 'project' && args[1] === 'field-list') {
          return FIELD_LIST_JSON;
        }
        if (args[0] === 'project' && args[1] === 'item-add') {
          return JSON.stringify({ id: 'PVTI_child100' });
        }
        if (args[0] === 'project' && args[1] === 'item-edit') {
          return '';
        }
        return '';
      },
      repo: 'example/widgets',
      fixIssueTypeId: 'IT_example_fix',
    });

    const filed = await fileChildIssue(port, {
      parentPr: 55,
      kind: 'ci-failure',
      title: 'Fix CI for PR #55',
      body: 'checks red',
      effort: 'medium',
      priority: 'p1',
    });
    expect(filed).toEqual({ number: 100, created: true });
    expect(createAttempts).toBe(2);
    expect(calls.some((args) => args.includes('--label') && args.includes('ci-failure'))).toBe(true);
    expect(calls.some((args) => args.includes('--force'))).toBe(false);
    expect(calls.some((args) =>
      args[0] === 'issue' && args[1] === 'edit' && args.includes('--add-label'),
    )).toBe(true);
  });

  it('does not duplicate a child when labeled creation succeeded before reporting failure', async () => {
    const { makeProductionChildIssuePort } = await import(
      '../../src/lifecycle/child-issues-production.js'
    );
    let createAttempts = 0;
    let createdBody = '';
    const port = makeProductionChildIssuePort({
      runner: async (_cmd, args) => {
        if (args[0] === 'label' && args[1] === 'create') {
          throw new Error('label create denied');
        }
        if (args[0] === 'issue' && args[1] === 'create') {
          createAttempts += 1;
          createdBody = args[args.indexOf('--body') + 1] ?? '';
          throw new Error('connection closed after request');
        }
        if (args[0] === 'issue' && args[1] === 'list') {
          return JSON.stringify([{
            number: 101,
            title: 'Fix CI for PR #55',
            body: createdBody,
            state: 'OPEN',
            labels: [],
          }]);
        }
        if (args[0] === 'issue' && args[1] === 'view') {
          return 'I_kwIssue101\n';
        }
        if (args[0] === 'api' && args[1] === 'graphql') {
          return '{"data":{}}';
        }
        if (args[0] === 'project' && args[1] === 'field-list') {
          return FIELD_LIST_JSON;
        }
        if (args[0] === 'project' && args[1] === 'item-add') {
          return JSON.stringify({ id: 'PVTI_child101' });
        }
        if (args[0] === 'project' && args[1] === 'item-edit') {
          return '';
        }
        return '';
      },
      repo: 'example/widgets',
      fixIssueTypeId: 'IT_example_fix',
    });

    await expect(fileChildIssue(port, {
      parentPr: 55,
      kind: 'ci-failure',
      title: 'Fix CI for PR #55',
      body: 'checks red',
      effort: 'medium',
      priority: 'p1',
    })).resolves.toEqual({ number: 101, created: true });
    expect(createAttempts).toBe(1);
  });

  it('does not mutate issues or labels when the organization fix type is unavailable', async () => {
    const { makeProductionChildIssuePort } = await import(
      '../../src/lifecycle/child-issues-production.js'
    );
    const calls: string[][] = [];
    const port = makeProductionChildIssuePort({
      runner: async (_cmd, args) => {
        calls.push([...args]);
        if (args[0] === 'issue' && args[1] === 'list') return '[]';
        if (args[0] === 'api' && args[1] === 'graphql') {
          return JSON.stringify({
            data: {
              organization: {
                issueTypes: { nodes: [] },
              },
            },
          });
        }
        throw new Error(`unexpected mutation: ${args.join(' ')}`);
      },
      repo: 'example/widgets',
    });

    await expect(fileChildIssue(port, {
      parentPr: 55,
      kind: 'ci-failure',
      title: 'Fix CI for PR #55',
      body: 'checks red',
      effort: 'medium',
      priority: 'p1',
    })).rejects.toThrow(/exactly one enabled fix Issue Type/i);
    expect(calls.some((args) =>
      (args[0] === 'issue' && args[1] === 'create')
      || (args[0] === 'label' && args[1] === 'create'),
    )).toBe(false);
  });
});
