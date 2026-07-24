import { describe, expect, it } from 'vitest';
import {
  repairProductionMachineChild,
  type ProductionChildIssuePortOptions,
} from '../../src/lifecycle/child-issues-production.js';
import {
  formatChildMarker,
  formatChildTriageIntent,
} from '../../src/lifecycle/child-issues.js';

const ACTION = {
  issueNumber: 2141,
  parentPr: 2140,
  childKind: 'reconcile' as const,
  expectedType: 'fix' as const,
  expectedEffort: 'medium' as const,
  expectedPriority: 'p1' as const,
};

const FIELD_LIST = JSON.stringify({
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

function state(input: {
  issueType: string | null;
  body?: string;
  repository?: string;
  itemId?: string;
  duplicateItem?: boolean;
  item?: {
    blockedOn: string | null;
    effort: string | null;
    priority: string | null;
  };
}): string {
  const item = input.item;
  const nodes = item === undefined
    ? []
    : Array.from({ length: input.duplicateItem ? 2 : 1 }, (_, index) => ({
        id: index === 0 ? (input.itemId ?? 'PVTI_2141') : 'PVTI_duplicate',
        content: {
          __typename: 'Issue',
          number: 2141,
          repository: { nameWithOwner: input.repository ?? 'Jinn-Network/mono' },
        },
        blockedOn: item.blockedOn === null ? null : { name: item.blockedOn },
        effort: item.effort === null ? null : { name: item.effort },
        priority: item.priority === null ? null : { name: item.priority },
      }));
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          id: 'I_2141',
          state: 'OPEN',
          body: input.body ?? formatChildMarker(2140, 'reconcile'),
          issueType: input.issueType === null ? null : { name: input.issueType },
        },
      },
      organization: {
        projectV2: {
          id: 'PVT_project',
          items: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes,
          },
        },
      },
    },
  });
}

function options(
  runner: NonNullable<ProductionChildIssuePortOptions['runner']>,
): ProductionChildIssuePortOptions {
  return {
    runner,
    repo: 'Jinn-Network/mono',
    projectOwner: 'Jinn-Network',
    projectNumber: 1,
    fixIssueTypeId: 'IT_fix',
  };
}

describe('production machine-child repair', () => {
  it('sequentially fills only missing type and Project triage for an off-Project child', async () => {
    const mutations: string[] = [];
    let issueType: string | null = null;
    let item: {
      blockedOn: string | null;
      effort: string | null;
      priority: string | null;
    } | undefined;
    const result = await repairProductionMachineChild(options(async (_cmd, args) => {
      if (args[0] === 'api' && args[1] === 'graphql'
        && args.some((arg) => arg.includes('MachineChildRepairState'))) {
        return state({ issueType, ...(item === undefined ? {} : { item: { ...item } }) });
      }
      if (args[0] === 'project' && args[1] === 'field-list') return FIELD_LIST;
      if (args[0] === 'project' && args[1] === 'item-add') {
        mutations.push('item-add');
        item = { blockedOn: null, effort: null, priority: null };
        return JSON.stringify({ id: 'PVTI_2141' });
      }
      if (args[0] === 'project' && args[1] === 'item-edit') {
        const option = args[args.indexOf('--single-select-option-id') + 1];
        mutations.push(String(option));
        if (item !== undefined && option === 'opt_nothing') item.blockedOn = 'Nothing';
        if (item !== undefined && option === 'opt_medium') item.effort = 'Medium';
        if (item !== undefined && option === 'opt_p1') item.priority = 'P1';
        return '';
      }
      if (args[0] === 'api' && args[1] === 'graphql') {
        mutations.push('type=fix');
        issueType = 'fix';
        return '{"data":{}}';
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    }), ACTION);

    expect(result).toEqual({ status: 'repaired' });
    expect(mutations).toEqual([
      'type=fix',
      'item-add',
      'opt_nothing',
      'opt_medium',
      'opt_p1',
    ]);
  });

  it('retries an absent immediate Project membership readback after exact item-add ID', async () => {
    const mutations: string[] = [];
    const waits: number[] = [];
    let added = false;
    let visible = false;
    const item = {
      blockedOn: null as string | null,
      effort: null as string | null,
      priority: null as string | null,
    };

    const result = await repairProductionMachineChild({
      ...options(async (_cmd, args) => {
        if (args[0] === 'api' && args[1] === 'graphql'
          && args.some((arg) => arg.includes('MachineChildRepairState'))) {
          return state({
            issueType: 'fix',
            ...(added && visible ? { item: { ...item } } : {}),
          });
        }
        if (args[0] === 'project' && args[1] === 'field-list') return FIELD_LIST;
        if (args[0] === 'project' && args[1] === 'item-add') {
          mutations.push('item-add');
          added = true;
          return JSON.stringify({ id: 'PVTI_2141' });
        }
        if (args[0] === 'project' && args[1] === 'item-edit') {
          const option = String(args[args.indexOf('--single-select-option-id') + 1]);
          mutations.push(option);
          if (option === 'opt_nothing') item.blockedOn = 'Nothing';
          if (option === 'opt_medium') item.effort = 'Medium';
          if (option === 'opt_p1') item.priority = 'P1';
          return '';
        }
        throw new Error(`unexpected command: ${args.join(' ')}`);
      }),
      wait: async (milliseconds: number) => {
        waits.push(milliseconds);
        visible = true;
      },
    }, ACTION);

    expect(result).toEqual({ status: 'repaired' });
    expect(waits).toHaveLength(1);
    expect(mutations).toEqual(['item-add', 'opt_nothing', 'opt_medium', 'opt_p1']);
  });

  it('fails closed after exactly five absent post-add membership readbacks', async () => {
    const waits: number[] = [];
    let added = false;
    let postAddReads = 0;
    const fieldEdits: string[][] = [];

    await expect(repairProductionMachineChild({
      ...options(async (_cmd, args) => {
        if (args[0] === 'api' && args[1] === 'graphql'
          && args.some((arg) => arg.includes('MachineChildRepairState'))) {
          if (added) postAddReads += 1;
          return state({ issueType: 'fix' });
        }
        if (args[0] === 'project' && args[1] === 'field-list') return FIELD_LIST;
        if (args[0] === 'project' && args[1] === 'item-add') {
          added = true;
          return JSON.stringify({ id: 'PVTI_2141' });
        }
        if (args[0] === 'project' && args[1] === 'item-edit') fieldEdits.push(args);
        return '';
      }),
      wait: async (milliseconds: number) => { waits.push(milliseconds); },
    }, ACTION)).rejects.toThrow(/Project membership readback is ambiguous/i);

    expect(postAddReads).toBe(5);
    expect(waits).toEqual([250, 250, 250, 250]);
    expect(fieldEdits).toEqual([]);
  });

  it('fails immediately when the first visible membership has a different item ID', async () => {
    const waits: number[] = [];
    const fieldEdits: string[][] = [];
    let added = false;

    await expect(repairProductionMachineChild({
      ...options(async (_cmd, args) => {
        if (args[0] === 'api' && args[1] === 'graphql'
          && args.some((arg) => arg.includes('MachineChildRepairState'))) {
          return state({
            issueType: 'fix',
            ...(added ? {
              itemId: 'PVTI_unexpected',
              item: { blockedOn: null, effort: null, priority: null },
            } : {}),
          });
        }
        if (args[0] === 'project' && args[1] === 'field-list') return FIELD_LIST;
        if (args[0] === 'project' && args[1] === 'item-add') {
          added = true;
          return JSON.stringify({ id: 'PVTI_2141' });
        }
        if (args[0] === 'project' && args[1] === 'item-edit') fieldEdits.push(args);
        return '';
      }),
      wait: async (milliseconds: number) => { waits.push(milliseconds); },
    }, ACTION)).rejects.toThrow(/Project membership readback is ambiguous/i);

    expect(waits).toEqual([]);
    expect(fieldEdits).toEqual([]);
  });

  it('fails immediately when the first visible membership is duplicated', async () => {
    const fieldEdits: string[][] = [];
    const waits: number[] = [];
    let added = false;

    await expect(repairProductionMachineChild({
      ...options(async (_cmd, args) => {
        if (args[0] === 'api' && args[1] === 'graphql'
          && args.some((arg) => arg.includes('MachineChildRepairState'))) {
          return state({
            issueType: 'fix',
            ...(added ? {
              duplicateItem: true,
              item: { blockedOn: null, effort: null, priority: null },
            } : {}),
          });
        }
        if (args[0] === 'project' && args[1] === 'field-list') return FIELD_LIST;
        if (args[0] === 'project' && args[1] === 'item-add') {
          added = true;
          return JSON.stringify({ id: 'PVTI_2141' });
        }
        if (args[0] === 'project' && args[1] === 'item-edit') fieldEdits.push(args);
        return '';
      }),
      wait: async (milliseconds: number) => {
        waits.push(milliseconds);
        throw new Error('duplicate membership must fail before waiting');
      },
    }, ACTION)).rejects.toThrow(/Project item is ambiguous/i);

    expect(waits).toEqual([]);
    expect(fieldEdits).toEqual([]);
  });

  it.each([
    {
      label: 'authoritative marker',
      body: formatChildMarker(9999, 'reconcile'),
      error: /authoritative child marker/i,
    },
    {
      label: 'durable triage intent',
      body: [
        formatChildMarker(2140, 'reconcile'),
        formatChildTriageIntent({ issueType: 'fix', effort: 'low', priority: 'p2' }),
      ].join('\n\n'),
      error: /live child triage intent contradicts/i,
    },
  ])('fails closed when $label drifts during an absent membership retry', async ({ body, error }) => {
    const waits: number[] = [];
    const fieldEdits: string[][] = [];
    let added = false;
    let liveBody = formatChildMarker(2140, 'reconcile');

    await expect(repairProductionMachineChild({
      ...options(async (_cmd, args) => {
        if (args[0] === 'api' && args[1] === 'graphql'
          && args.some((arg) => arg.includes('MachineChildRepairState'))) {
          return state({ issueType: 'fix', body: liveBody });
        }
        if (args[0] === 'project' && args[1] === 'field-list') return FIELD_LIST;
        if (args[0] === 'project' && args[1] === 'item-add') {
          added = true;
          return JSON.stringify({ id: 'PVTI_2141' });
        }
        if (args[0] === 'project' && args[1] === 'item-edit') fieldEdits.push(args);
        return '';
      }),
      wait: async (milliseconds: number) => {
        expect(added).toBe(true);
        waits.push(milliseconds);
        liveBody = body;
      },
    }, ACTION)).rejects.toThrow(error);

    expect(waits).toEqual([250]);
    expect(fieldEdits).toEqual([]);
  });

  it('resumes a partial repair once, then makes the later cycle a no-op', async () => {
    const mutations: string[] = [];
    let failFirstEdit = true;
    let item: {
      blockedOn: string | null;
      effort: string | null;
      priority: string | null;
    } | undefined;

    const runner: NonNullable<ProductionChildIssuePortOptions['runner']> = async (_cmd, args) => {
      if (args[0] === 'api' && args[1] === 'graphql'
        && args.some((arg) => arg.includes('MachineChildRepairState'))) {
        return state({ issueType: 'fix', ...(item === undefined ? {} : { item: { ...item } }) });
      }
      if (args[0] === 'project' && args[1] === 'field-list') return FIELD_LIST;
      if (args[0] === 'project' && args[1] === 'item-add') {
        mutations.push('item-add');
        item = { blockedOn: null, effort: null, priority: null };
        return JSON.stringify({ id: 'PVTI_2141' });
      }
      if (args[0] === 'project' && args[1] === 'item-edit') {
        const option = String(args[args.indexOf('--single-select-option-id') + 1]);
        mutations.push(option);
        if (item !== undefined && option === 'opt_nothing') item.blockedOn = 'Nothing';
        if (item !== undefined && option === 'opt_medium') item.effort = 'Medium';
        if (item !== undefined && option === 'opt_p1') item.priority = 'P1';
        if (failFirstEdit) {
          failFirstEdit = false;
          throw new Error('ambiguous field-edit response');
        }
        return '';
      }
      if (args[0] === 'issue' && args[1] === 'create') mutations.push('issue-create');
      return '';
    };

    await expect(repairProductionMachineChild(options(runner), ACTION))
      .rejects.toThrow(/ambiguous field-edit response/i);
    await expect(repairProductionMachineChild(options(runner), ACTION))
      .resolves.toEqual({ status: 'repaired' });
    const mutationsAfterRepair = [...mutations];
    await expect(repairProductionMachineChild(options(runner), ACTION))
      .resolves.toEqual({ status: 'already-complete' });

    expect(mutations).toEqual(['item-add', 'opt_nothing', 'opt_medium', 'opt_p1']);
    expect(mutations).toEqual(mutationsAfterRepair);
    expect(mutations.filter((mutation) => mutation === 'item-add')).toHaveLength(1);
    expect(mutations).not.toContain('issue-create');
  });

  it('leaves matching fields untouched and fills only the missing priority', async () => {
    const mutations: string[] = [];
    let priority: string | null = null;
    await repairProductionMachineChild(options(async (_cmd, args) => {
      if (args[0] === 'api' && args[1] === 'graphql'
        && args.some((arg) => arg.includes('MachineChildRepairState'))) {
        return state({
          issueType: 'fix',
          item: { blockedOn: 'Nothing', effort: 'Medium', priority },
        });
      }
      if (args[0] === 'project' && args[1] === 'field-list') return FIELD_LIST;
      if (args[0] === 'project' && args[1] === 'item-edit') {
        const option = String(args[args.indexOf('--single-select-option-id') + 1]);
        mutations.push(option);
        if (option === 'opt_p1') priority = 'P1';
        return '';
      }
      throw new Error(`unexpected mutation: ${args.join(' ')}`);
    }), ACTION);

    expect(mutations).toEqual(['opt_p1']);
  });

  it('performs no mutation when every expected value already matches', async () => {
    const mutations: string[][] = [];
    await expect(repairProductionMachineChild(options(async (_cmd, args) => {
      if (args[0] === 'api' && args[1] === 'graphql'
        && args.some((arg) => arg.includes('MachineChildRepairState'))) {
        return state({
          issueType: 'fix',
          item: { blockedOn: 'Nothing', effort: 'Medium', priority: 'P1' },
        });
      }
      mutations.push(args);
      return '';
    }), ACTION)).resolves.toEqual({ status: 'already-complete' });

    expect(mutations).toEqual([]);
  });

  it('fails closed when live durable triage intent contradicts the snapshot action', async () => {
    const mutations: string[][] = [];
    const body = [
      formatChildMarker(2140, 'reconcile'),
      '',
      formatChildTriageIntent({
        issueType: 'fix',
        effort: 'low',
        priority: 'p2',
      }),
    ].join('\n');

    await expect(repairProductionMachineChild(options(async (_cmd, args) => {
      if (args[0] === 'api' && args[1] === 'graphql'
        && args.some((arg) => arg.includes('MachineChildRepairState'))) {
        return state({
          issueType: 'fix',
          body,
          item: { blockedOn: 'Nothing', effort: 'Low', priority: 'P2' },
        });
      }
      mutations.push(args);
      return '';
    }), ACTION)).rejects.toThrow(/live child triage intent contradicts.*action/i);

    expect(mutations).toEqual([]);
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
  ])('fails closed on $label durable triage intent before repair mutation', async ({
    body,
  }) => {
    const mutations: string[][] = [];

    await expect(repairProductionMachineChild(options(async (_cmd, args) => {
      if (args[0] === 'api' && args[1] === 'graphql'
        && args.some((arg) => arg.includes('MachineChildRepairState'))) {
        return state({
          issueType: 'fix',
          body,
          item: { blockedOn: 'Nothing', effort: 'Medium', priority: 'P1' },
        });
      }
      mutations.push(args);
      return '';
    }), ACTION)).rejects.toThrow(/live child triage intent contradicts.*action/i);

    expect(mutations).toEqual([]);
  });

  it('dynamically resolves the enabled Fix Issue Type when no mapping is configured', async () => {
    let issueType: string | null = null;
    const mutations: string[] = [];

    const result = await repairProductionMachineChild({
      runner: async (_cmd, args) => {
        if (args[0] === 'api' && args[1] === 'graphql'
          && args.some((arg) => arg.includes('MachineChildRepairState'))) {
          return state({
            issueType,
            item: { blockedOn: 'Nothing', effort: 'Medium', priority: 'P1' },
          });
        }
        if (args[0] === 'api' && args[1] === 'graphql'
          && args.some((arg) => arg.includes('issueTypes(first: 100)'))) {
          return JSON.stringify({
            data: {
              organization: {
                issueTypes: {
                  nodes: [{ id: 'IT_dynamic_fix', name: 'fix', isEnabled: true }],
                },
              },
            },
          });
        }
        if (args[0] === 'api' && args[1] === 'graphql') {
          const typeId = String(args.find((arg) => arg.startsWith('typeId=')));
          mutations.push(typeId);
          issueType = 'fix';
          return '{"data":{}}';
        }
        if (args[0] === 'project' && args[1] === 'field-list') return FIELD_LIST;
        throw new Error(`unexpected command: ${args.join(' ')}`);
      },
      repo: 'Jinn-Network/mono',
      projectOwner: 'Jinn-Network',
      projectNumber: 1,
    }, ACTION);

    expect(result).toEqual({ status: 'repaired' });
    expect(mutations).toEqual(['typeId=IT_dynamic_fix']);
  });

  it('refreshes authority and membership immediately before adding a Project item', async () => {
    let body = formatChildMarker(2140, 'reconcile');
    const mutations: string[] = [];

    await expect(repairProductionMachineChild(options(async (_cmd, args) => {
      if (args[0] === 'api' && args[1] === 'graphql'
        && args.some((arg) => arg.includes('MachineChildRepairState'))) {
        return state({ issueType: 'fix', body });
      }
      if (args[0] === 'project' && args[1] === 'field-list') {
        body = formatChildMarker(9999, 'reconcile');
        return FIELD_LIST;
      }
      if (args[0] === 'project' && args[1] === 'item-add') {
        mutations.push('item-add');
        return JSON.stringify({ id: 'PVTI_2141' });
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    }), ACTION)).rejects.toThrow(/authoritative child marker/i);

    expect(mutations).toEqual([]);
  });

  it('keeps repository and Project owners distinct in the fresh-state query', async () => {
    const queryArgs: string[][] = [];
    await expect(repairProductionMachineChild({
      ...options(async (_cmd, args) => {
        if (args[0] === 'api' && args[1] === 'graphql'
          && args.some((arg) => arg.includes('MachineChildRepairState'))) {
          queryArgs.push(args);
          return state({
            issueType: 'fix',
            repository: 'RepoOrg/mono',
            item: { blockedOn: 'Nothing', effort: 'Medium', priority: 'P1' },
          });
        }
        throw new Error(`unexpected mutation: ${args.join(' ')}`);
      }),
      repo: 'RepoOrg/mono',
      projectOwner: 'ProjectOrg',
    }, ACTION)).resolves.toEqual({ status: 'already-complete' });

    expect(queryArgs[0]).toEqual(expect.arrayContaining([
      'repositoryOwner=RepoOrg',
      'projectOwner=ProjectOrg',
    ]));
  });

  it.each([
    {
      label: 'Issue Type',
      issueType: 'feat',
      item: { blockedOn: 'Nothing', effort: 'Medium', priority: 'P1' },
      detail: /Issue Type=feat, expected fix/i,
    },
    {
      label: 'Blocked on',
      issueType: 'fix',
      item: { blockedOn: 'Human', effort: 'Medium', priority: 'P1' },
      detail: /Blocked on=Human, expected Nothing/i,
    },
    {
      label: 'Effort',
      issueType: 'fix',
      item: { blockedOn: 'Nothing', effort: 'High', priority: 'P1' },
      detail: /Effort=High, expected Medium/i,
    },
    {
      label: 'Priority',
      issueType: 'fix',
      item: { blockedOn: 'Nothing', effort: 'Medium', priority: 'P2' },
      detail: /Priority=P2, expected P1/i,
    },
  ])('fails closed before mutation on contradictory non-null $label', async ({
    issueType,
    item,
    detail,
  }) => {
    const mutations: string[][] = [];
    await expect(repairProductionMachineChild(options(async (_cmd, args) => {
      if (args[0] === 'api' && args[1] === 'graphql'
        && args.some((arg) => arg.includes('MachineChildRepairState'))) {
        return state({ issueType, item });
      }
      if (args[0] === 'project' && args[1] === 'field-list') return FIELD_LIST;
      mutations.push(args);
      return '';
    }), ACTION)).rejects.toThrow(detail);

    expect(mutations).toEqual([]);
  });

  it('refreshes before each field edit and never overwrites a concurrent contradiction', async () => {
    const current = {
      blockedOn: null as string | null,
      effort: null as string | null,
      priority: null as string | null,
    };
    const mutations: string[] = [];
    await expect(repairProductionMachineChild(options(async (_cmd, args) => {
      if (args[0] === 'api' && args[1] === 'graphql'
        && args.some((arg) => arg.includes('MachineChildRepairState'))) {
        return state({ issueType: 'fix', item: { ...current } });
      }
      if (args[0] === 'project' && args[1] === 'field-list') return FIELD_LIST;
      if (args[0] === 'project' && args[1] === 'item-edit') {
        const option = String(args[args.indexOf('--single-select-option-id') + 1]);
        mutations.push(option);
        if (option === 'opt_nothing') {
          current.blockedOn = 'Nothing';
          current.priority = 'P2';
        }
        return '';
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    }), ACTION)).rejects.toThrow(/contradictory triage.*Priority=P2.*expected P1/i);

    expect(mutations).toEqual(['opt_nothing']);
  });
});
