import { beforeEach, describe, expect, it } from 'vitest';
import { resetFieldCache } from '../../src/dispatcher/field-cache.js';
import {
  executeProductionFileDebtSweep,
  makeProductionDebtSweepPort,
} from '../../src/lifecycle/debt-sweep-production.js';
import {
  formatDebtSweepMarker,
  formatDebtSweepMarkerKey,
} from '../../src/lifecycle/debt-sweep.js';
import { formatReviewFollowUpMarker } from '../../src/lifecycle/review-follow-ups.js';
import { CHORE_ISSUE_TYPE_ID } from '../../src/lifecycle/review-follow-ups-production.js';

const HEAD = 'a'.repeat(40);

const FIELD_LIST_JSON = JSON.stringify({
  fields: [
    {
      id: 'PVTSSF_blocked',
      name: 'Blocked on',
      options: [
        { id: 'opt_nothing', name: 'Nothing' },
        { id: 'opt_human', name: 'Human' },
        { id: 'opt_another', name: 'Another issue' },
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

function openFollowUpRows(numbers: readonly number[]): string {
  return JSON.stringify(numbers.map((number) => ({
    number,
    title: `Follow-up ${number}`,
    body: `${formatReviewFollowUpMarker(84, HEAD, number)}\n\nbody`,
  })));
}

const ACTION = {
  kind: 'file-debt-sweep' as const,
  parentPr: 84,
  members: [
    { number: 101, priority: 'p4' as const },
    { number: 102, priority: 'p3' as const },
    { number: 103, priority: 'p4' as const },
  ],
};

describe('production debt sweep filing', () => {
  beforeEach(() => {
    resetFieldCache();
  });

  it('files a triage-complete chore sweep through the production port', async () => {
    const calls: string[][] = [];
    const result = await executeProductionFileDebtSweep(ACTION, {
      runner: async (_command, args) => {
        calls.push([...args]);
        if (args[0] === 'issue' && args[1] === 'list') {
          return openFollowUpRows([101, 102, 103]);
        }
        if (args[0] === 'issue' && args[1] === 'create') {
          return 'https://github.com/Jinn-Network/mono/issues/900\n';
        }
        if (args[0] === 'issue' && args[1] === 'view') return 'I_kwIssue900\n';
        if (args[0] === 'api' && args[1] === 'graphql') return '{"data":{}}';
        if (args[0] === 'project' && args[1] === 'field-list') return FIELD_LIST_JSON;
        if (args[0] === 'project' && args[1] === 'item-add') {
          return JSON.stringify({ id: 'PVTI_sweep900' });
        }
        if (args[0] === 'project' && args[1] === 'item-edit') return '';
        throw new Error(`Unexpected gh args: ${args.join(' ')}`);
      },
      repo: 'Jinn-Network/mono',
    });

    expect(result).toEqual({ status: 'filed', detail: 'sweep:900' });

    const create = calls.find((args) => args[0] === 'issue' && args[1] === 'create');
    expect(create!.join(' ')).toContain(formatDebtSweepMarker(84, [101, 102, 103]));
    expect(create!.join(' ')).not.toContain('jinn-autopilot:child');
    expect(create!.join(' ')).not.toContain('jinn-autopilot:review-follow-up');
    expect(create!.join(' ')).not.toContain('Closes #101');

    const graphql = calls.find((args) => args[0] === 'api' && args[1] === 'graphql');
    expect(graphql?.join(' ')).toContain(`typeId=${CHORE_ISSUE_TYPE_ID}`);

    const edits = calls.filter((args) => args[0] === 'project' && args[1] === 'item-edit');
    expect(edits.some((args) =>
      args.includes('PVTSSF_priority') && args.includes('opt_p2'))).toBe(true);
    expect(edits.some((args) =>
      args.includes('PVTSSF_effort') && args.includes('opt_medium'))).toBe(true);
  });

  it('does not create a second sweep for a parent that already has one open', async () => {
    let creates = 0;
    const result = await executeProductionFileDebtSweep(ACTION, {
      runner: async (_command, args) => {
        if (args[0] === 'issue' && args[1] === 'list') {
          return JSON.stringify([{
            number: 500,
            title: 'Sweep review follow-ups for PR #84 (3 items)',
            body: formatDebtSweepMarker(84, [101, 102, 103]),
          }]);
        }
        if (args[0] === 'issue' && args[1] === 'create') {
          creates += 1;
          return 'https://github.com/Jinn-Network/mono/issues/999\n';
        }
        throw new Error(`Unexpected gh args: ${args.join(' ')}`);
      },
      repo: 'Jinn-Network/mono',
    });
    expect(result).toEqual({ status: 'skipped', reason: 'sweep-already-open:500' });
    expect(creates).toBe(0);
  });

  it('refuses a truncated open-issue listing rather than duplicating a sweep', async () => {
    const port = makeProductionDebtSweepPort({
      runner: async (_command, args) => {
        if (args[0] === 'issue' && args[1] === 'list') {
          return JSON.stringify(Array.from({ length: 1000 }, (_unused, index) => ({
            number: index + 1,
            title: 'noise',
            body: '',
          })));
        }
        throw new Error(`Unexpected gh args: ${args.join(' ')}`);
      },
      repo: 'Jinn-Network/mono',
    });
    await expect(port.searchOpenByMarker(formatDebtSweepMarkerKey(84)))
      .rejects.toThrow(/truncated/i);
  });
});

describe('production closed-sweep resolution (#154)', () => {
  beforeEach(() => {
    resetFieldCache();
  });

  it('closes members a merged sweep addressed and skips the re-file', async () => {
    const calls: string[][] = [];
    const result = await executeProductionFileDebtSweep(ACTION, {
      runner: async (_command, args) => {
        calls.push([...args]);
        if (args[0] === 'issue' && args[1] === 'list' && args.includes('closed')) {
          return JSON.stringify([{
            number: 500,
            title: 'Sweep review follow-ups for PR #84 (3 items)',
            body: formatDebtSweepMarker(84, [101, 102, 103]),
          }]);
        }
        if (args[0] === 'issue' && args[1] === 'list') {
          return openFollowUpRows([101, 102, 103]);
        }
        if (args[0] === 'issue' && args[1] === 'view' && args.includes('closedByPullRequestsReferences')) {
          return JSON.stringify({ closedByPullRequestsReferences: [{ number: 610 }] });
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({ number: 610, mergedAt: '2026-09-03T11:58:18Z', body: 'Closes #500' });
        }
        if (args[0] === 'issue' && args[1] === 'close') return '';
        throw new Error(`Unexpected gh args: ${args.join(' ')}`);
      },
      repo: 'Jinn-Network/mono',
    });
    expect(result).toEqual({
      status: 'skipped',
      reason: 'sweep-already-swept:500',
      detail: 'closed=101,102,103 declined=-',
    });
    const closedList = calls.find((args) => args[0] === 'issue' && args[1] === 'list' && args.includes('closed'));
    expect(closedList).toContain('sort:updated-desc');
    const closes = calls.filter((args) => args[0] === 'issue' && args[1] === 'close');
    expect(closes.map((args) => args[2])).toEqual(['101', '102', '103']);
    expect(closes[0]!.join(' ')).toContain('sweep #500');
    expect(calls.some((args) => args[0] === 'issue' && args[1] === 'create')).toBe(false);
  });

  it('treats a sweep closed without a merged PR as declined: nothing closed, nothing filed', async () => {
    const calls: string[][] = [];
    const result = await executeProductionFileDebtSweep(ACTION, {
      runner: async (_command, args) => {
        calls.push([...args]);
        if (args[0] === 'issue' && args[1] === 'list' && args.includes('closed')) {
          return JSON.stringify([{ number: 500, title: 't', body: formatDebtSweepMarker(84, [101, 102, 103]) }]);
        }
        if (args[0] === 'issue' && args[1] === 'list') return openFollowUpRows([101, 102, 103]);
        if (args[0] === 'issue' && args[1] === 'view') {
          return JSON.stringify({ closedByPullRequestsReferences: [] });
        }
        throw new Error(`Unexpected gh args: ${args.join(' ')}`);
      },
      repo: 'Jinn-Network/mono',
    });
    expect(result).toEqual({
      status: 'skipped',
      reason: 'sweep-already-swept:500',
      detail: 'closed=- declined=101,102,103',
    });
    expect(calls.some((args) => args[1] === 'close' || args[1] === 'create')).toBe(false);
  });
});
