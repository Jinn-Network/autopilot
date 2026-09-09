import { describe, expect, it } from 'vitest';
import {
  executeProductionTriageDefaults,
  type ProductionTriageDefaultsOptions,
} from '../../src/lifecycle/triage-defaults-production.js';
import type { NewWorkAction } from '../../src/lifecycle/types.js';

type TriageAction = Extract<NewWorkAction, { kind: 'triage-defaults' }>;

const ACTION: TriageAction = {
  kind: 'triage-defaults',
  issueNumber: 3983,
  projectItemId: 'PVTI_3983',
  issueType: 'fix',
  priority: 'P3',
};

const TYPE_OPTIONS = {
  feat: 'IT_feat',
  fix: 'IT_fix',
  refactor: 'IT_refactor',
  spike: 'IT_spike',
  chore: 'IT_chore',
  docs: 'IT_docs',
  test: 'IT_test',
  incident: 'IT_incident',
  design: 'IT_design',
};

function mapping(): NonNullable<ProductionTriageDefaultsOptions['projectMapping']> {
  return {
    owner: 'Jinn-Network',
    number: 1,
    id: 'PVT_project',
    fields: {
      status: {
        id: 'PVTF_status',
        options: {
          todo: 's_todo',
          inProgress: 's_progress',
          human: 's_human',
          inReview: 's_review',
          done: 's_done',
        },
      },
      priority: {
        id: 'PVTSSF_priority',
        options: {
          p0: 'opt_p0',
          p1: 'opt_p1',
          p2: 'opt_p2',
          p3: 'opt_p3',
          p4: 'opt_p4',
        },
      },
      effort: {
        id: 'PVTSSF_effort',
        options: {
          low: 'e_low',
          medium: 'e_medium',
          high: 'e_high',
          xhigh: 'e_xhigh',
          max: 'e_max',
        },
      },
      blockedOn: {
        id: 'PVTSSF_blocked',
        options: { nothing: 'b_nothing', human: 'b_human', anotherIssue: 'b_issue' },
      },
      sprint: { id: 'PVTF_sprint' },
      type: { options: TYPE_OPTIONS },
    },
  };
}

function state(input: {
  readonly issueType: string | null;
  readonly priority: string | null;
  readonly blockedOn?: string | null;
  readonly issueState?: string;
  readonly itemIssueNumber?: number;
  readonly repository?: string;
  readonly item?: null;
}): string {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          id: 'I_3983',
          state: input.issueState ?? 'OPEN',
          issueType: input.issueType === null ? null : { name: input.issueType },
        },
      },
      node: input.item === null ? null : {
        __typename: 'ProjectV2Item',
        id: 'PVTI_3983',
        project: { id: 'PVT_project' },
        content: {
          __typename: 'Issue',
          number: input.itemIssueNumber ?? 3983,
          repository: { nameWithOwner: input.repository ?? 'Jinn-Network/mono' },
        },
        priority: input.priority === null ? null : { name: input.priority },
        blockedOn: input.blockedOn === undefined || input.blockedOn === null
          ? null
          : { name: input.blockedOn },
      },
    },
  });
}

function options(
  runner: NonNullable<ProductionTriageDefaultsOptions['runner']>,
): ProductionTriageDefaultsOptions {
  return {
    runner,
    repo: 'Jinn-Network/mono',
    projectOwner: 'Jinn-Network',
    projectNumber: 1,
    projectMapping: mapping(),
  };
}

/**
 * A board that answers reads from live state and applies our own writes to it,
 * so the readback guard and the final readback are exercised against something
 * that actually moves.
 */
function board(initial: {
  issueType: string | null;
  priority: string | null;
  blockedOn?: string | null;
}) {
  const live = {
    issueType: initial.issueType,
    priority: initial.priority,
    blockedOn: initial.blockedOn === undefined ? 'Nothing' : initial.blockedOn,
  };
  const commands: string[] = [];
  const runner = async (_cmd: string, args: readonly string[]): Promise<string> => {
    if (args[0] === 'api' && args.some((arg) => arg.includes('TriageDefaultsState'))) {
      commands.push('read');
      return state(live);
    }
    if (args[0] === 'api' && args.some((arg) => arg.includes('updateIssueIssueType'))) {
      const typeId = args[args.indexOf('-f', args.indexOf('issueId=I_3983')) + 1];
      commands.push(`type:${String(typeId)}`);
      live.issueType = 'fix';
      return '{"data":{}}';
    }
    if (args[0] === 'project' && args[1] === 'item-edit') {
      const fieldId = String(args[args.indexOf('--field-id') + 1]);
      commands.push(`item-edit:${String(args[args.indexOf('--single-select-option-id') + 1])}`);
      if (fieldId === 'PVTSSF_blocked') live.blockedOn = 'Nothing';
      else live.priority = 'P3';
      return '';
    }
    throw new Error(`unexpected command: ${args.join(' ')}`);
  };
  return { live, commands, runner };
}

describe('production board triage defaults (#166)', () => {
  it('writes the inferred type and the default Priority, and reports both', async () => {
    const fake = board({ issueType: null, priority: null });

    await expect(executeProductionTriageDefaults(ACTION, options(fake.runner)))
      .resolves.toEqual({ status: 'applied', detail: 'type fix, priority P3' });
    expect(fake.commands.filter((command) => command !== 'read'))
      .toEqual(['type:typeId=IT_fix', 'item-edit:opt_p3']);
    expect(fake.live).toEqual({ issueType: 'fix', priority: 'P3', blockedOn: 'Nothing' });
  });

  it('writes only the Priority when the action names no type', async () => {
    const fake = board({ issueType: 'feat', priority: null });

    await expect(executeProductionTriageDefaults(
      { kind: 'triage-defaults', issueNumber: 3983, projectItemId: 'PVTI_3983', priority: 'P3' },
      options(fake.runner),
    )).resolves.toEqual({ status: 'applied', detail: 'priority P3' });
    expect(fake.commands.filter((command) => command !== 'read'))
      .toEqual(['item-edit:opt_p3']);
  });

  // The whole action exists to fill a gap. A field that filled itself between
  // the snapshot and the write is the outcome, not a conflict — but the write
  // is still refused, and the refusal still reported.
  it('refuses and reports a Priority that was set underneath', async () => {
    const fake = board({ issueType: 'fix', priority: 'P1' });

    await expect(executeProductionTriageDefaults(
      { kind: 'triage-defaults', issueNumber: 3983, projectItemId: 'PVTI_3983', priority: 'P3' },
      options(fake.runner),
    )).resolves.toEqual({
      status: 'skipped',
      reason: 'Priority P1 was set underneath',
    });
    expect(fake.commands.filter((command) => command !== 'read')).toEqual([]);
  });

  it('refuses and reports an Issue Type that was set underneath', async () => {
    const fake = board({ issueType: 'design', priority: 'P2' });

    await expect(executeProductionTriageDefaults(ACTION, options(fake.runner)))
      .resolves.toEqual({
        status: 'skipped',
        reason: 'Issue Type design was set underneath; Priority P2 was set underneath',
      });
    expect(fake.commands.filter((command) => command !== 'read')).toEqual([]);
  });

  it('still applies the gap that is open when the other closed underneath', async () => {
    const fake = board({ issueType: 'design', priority: null });

    await expect(executeProductionTriageDefaults(ACTION, options(fake.runner)))
      .resolves.toEqual({
        status: 'applied',
        detail: 'priority P3 (refused: Issue Type design was set underneath)',
      });
    expect(fake.commands.filter((command) => command !== 'read'))
      .toEqual(['item-edit:opt_p3']);
  });

  // #171: the third gate. A board row added without touching Blocked on
  // reads empty, and the cascade refuses it as "Project Blocked on is unset".
  it('writes Blocked on = Nothing for an empty board field and reports it', async () => {
    const fake = board({ issueType: 'fix', priority: 'P1', blockedOn: null });

    await expect(executeProductionTriageDefaults(
      {
        kind: 'triage-defaults',
        issueNumber: 3983,
        projectItemId: 'PVTI_3983',
        blockedOn: 'Nothing',
      },
      options(fake.runner),
    )).resolves.toEqual({ status: 'applied', detail: 'blocked-on Nothing' });
    expect(fake.commands.filter((command) => command !== 'read'))
      .toEqual(['item-edit:b_nothing']);
    expect(fake.live.blockedOn).toBe('Nothing');
  });

  it('writes all three gaps in one action and names them in order', async () => {
    const fake = board({ issueType: null, priority: null, blockedOn: null });

    await expect(executeProductionTriageDefaults(
      { ...ACTION, blockedOn: 'Nothing' },
      options(fake.runner),
    )).resolves.toEqual({
      status: 'applied',
      detail: 'type fix, priority P3, blocked-on Nothing',
    });
    expect(fake.commands.filter((command) => command !== 'read'))
      .toEqual(['type:typeId=IT_fix', 'item-edit:opt_p3', 'item-edit:b_nothing']);
    expect(fake.live)
      .toEqual({ issueType: 'fix', priority: 'P3', blockedOn: 'Nothing' });
  });

  // `Human` and `Another issue` are deliberate operator values: the readback
  // guard must refuse them exactly as it refuses a Priority set underneath.
  it('refuses and reports a Blocked on that was set underneath', async () => {
    const fake = board({ issueType: 'fix', priority: 'P1', blockedOn: 'Human' });

    await expect(executeProductionTriageDefaults(
      {
        kind: 'triage-defaults',
        issueNumber: 3983,
        projectItemId: 'PVTI_3983',
        blockedOn: 'Nothing',
      },
      options(fake.runner),
    )).resolves.toEqual({
      status: 'skipped',
      reason: 'Blocked on Human was set underneath',
    });
    expect(fake.commands.filter((command) => command !== 'read')).toEqual([]);
  });

  it('fails closed when the final readback does not show the Blocked on write', async () => {
    await expect(executeProductionTriageDefaults(
      {
        kind: 'triage-defaults',
        issueNumber: 3983,
        projectItemId: 'PVTI_3983',
        blockedOn: 'Nothing',
      },
      options(async (_cmd, args) => {
        if (args[0] === 'api' && args.some((arg) => arg.includes('TriageDefaultsState'))) {
          return state({ issueType: 'fix', priority: 'P1', blockedOn: null });
        }
        if (args[0] === 'project' && args[1] === 'item-edit') return '';
        throw new Error(`unexpected command: ${args.join(' ')}`);
      }),
    )).rejects.toThrow(/final readback/i);
  });

  it('reads the project field list once for both board writes', async () => {
    const live = {
      issueType: 'fix' as string | null,
      priority: null as string | null,
      blockedOn: null as string | null,
    };
    let fieldLists = 0;
    const result = await executeProductionTriageDefaults(
      {
        kind: 'triage-defaults',
        issueNumber: 3983,
        projectItemId: 'PVTI_3983',
        priority: 'P3',
        blockedOn: 'Nothing',
      },
      {
        runner: async (_cmd, args) => {
          if (args[0] === 'api' && args.some((arg) => arg.includes('TriageDefaultsState'))) {
            return state(live);
          }
          if (args[0] === 'project' && args[1] === 'field-list') {
            fieldLists += 1;
            return JSON.stringify({
              fields: [
                {
                  id: 'PVTSSF_blocked',
                  name: 'Blocked on',
                  options: [
                    { id: 'b_nothing', name: 'Nothing' },
                    { id: 'b_human', name: 'Human' },
                  ],
                },
                {
                  id: 'PVTSSF_effort',
                  name: 'Effort',
                  options: [
                    { id: 'e_low', name: 'Low' },
                    { id: 'e_medium', name: 'Medium' },
                    { id: 'e_high', name: 'High' },
                    { id: 'e_xhigh', name: 'XHigh' },
                    { id: 'e_max', name: 'Max' },
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
          }
          if (args[0] === 'project' && args[1] === 'item-edit') {
            const fieldId = String(args[args.indexOf('--field-id') + 1]);
            if (fieldId === 'PVTSSF_blocked') live.blockedOn = 'Nothing';
            else live.priority = 'P3';
            return '';
          }
          throw new Error(`unexpected command: ${args.join(' ')}`);
        },
        repo: 'Jinn-Network/mono',
        projectOwner: 'Jinn-Network',
        projectNumber: 1,
      },
    );

    expect(result).toEqual({ status: 'applied', detail: 'priority P3, blocked-on Nothing' });
    expect(fieldLists).toBe(1);
  });

  it('refuses a Project item that does not belong to the named issue', async () => {
    await expect(executeProductionTriageDefaults(ACTION, options(async (_cmd, args) => {
      if (args[0] === 'api' && args.some((arg) => arg.includes('TriageDefaultsState'))) {
        return state({ issueType: null, priority: null, itemIssueNumber: 4242 });
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    }))).rejects.toThrow(/Project item/i);
  });

  it('refuses an issue that is no longer open', async () => {
    await expect(executeProductionTriageDefaults(ACTION, options(async (_cmd, args) => {
      if (args[0] === 'api' && args.some((arg) => arg.includes('TriageDefaultsState'))) {
        return state({ issueType: null, priority: null, issueState: 'CLOSED' });
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    }))).rejects.toThrow(/closed|missing|malformed/i);
  });

  it('refuses a Project item that has disappeared from the board', async () => {
    await expect(executeProductionTriageDefaults(ACTION, options(async (_cmd, args) => {
      if (args[0] === 'api' && args.some((arg) => arg.includes('TriageDefaultsState'))) {
        return state({ issueType: null, priority: null, item: null });
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    }))).rejects.toThrow(/Project item/i);
  });

  it('fails closed when the final readback does not show the write', async () => {
    // A write GitHub accepted but did not apply must never be reported as
    // applied: the next cycle would read the same gap and never know why.
    let reads = 0;
    await expect(executeProductionTriageDefaults(
      { kind: 'triage-defaults', issueNumber: 3983, projectItemId: 'PVTI_3983', priority: 'P3' },
      options(async (_cmd, args) => {
        if (args[0] === 'api' && args.some((arg) => arg.includes('TriageDefaultsState'))) {
          reads += 1;
          return state({ issueType: 'fix', priority: null });
        }
        if (args[0] === 'project' && args[1] === 'item-edit') return '';
        throw new Error(`unexpected command: ${args.join(' ')}`);
      }),
    )).rejects.toThrow(/final readback/i);
    expect(reads).toBeGreaterThan(1);
  });

  it('refuses an action that names neither field', async () => {
    await expect(executeProductionTriageDefaults(
      { kind: 'triage-defaults', issueNumber: 3983, projectItemId: 'PVTI_3983' },
      options(async () => { throw new Error('no command should run'); }),
    )).rejects.toThrow(/names no/i);
  });

  it('resolves an Issue Type id from the organization when no mapping is configured', async () => {
    const seen: string[] = [];
    const live = { issueType: null as string | null, priority: 'P1' as string | null };
    const result = await executeProductionTriageDefaults(
      { kind: 'triage-defaults', issueNumber: 3983, projectItemId: 'PVTI_3983', issueType: 'docs' },
      {
        runner: async (_cmd, args) => {
          if (args[0] === 'api' && args.some((arg) => arg.includes('TriageDefaultsState'))) {
            return state(live);
          }
          if (args[0] === 'api' && args.some((arg) => arg.includes('issueTypes'))) {
            seen.push('issue-types');
            return JSON.stringify({
              data: {
                organization: {
                  issueTypes: {
                    nodes: [
                      { id: 'IT_docs', name: 'docs', isEnabled: true },
                      { id: 'IT_fix', name: 'fix', isEnabled: true },
                    ],
                  },
                },
              },
            });
          }
          if (args[0] === 'api' && args.some((arg) => arg.includes('updateIssueIssueType'))) {
            seen.push(String(args[args.indexOf('-f', args.indexOf('issueId=I_3983')) + 1]));
            live.issueType = 'docs';
            return '{"data":{}}';
          }
          throw new Error(`unexpected command: ${args.join(' ')}`);
        },
        repo: 'Jinn-Network/mono',
        projectOwner: 'Jinn-Network',
        projectNumber: 1,
      },
    );

    expect(result).toEqual({ status: 'applied', detail: 'type docs' });
    expect(seen).toEqual(['issue-types', 'typeId=IT_docs']);
  });
});
