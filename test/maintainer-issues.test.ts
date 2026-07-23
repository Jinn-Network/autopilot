import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/non-jinn-autopilot-config.json';
import { decodeAutopilotConfig } from '../src/config/config.js';
import {
  createMaintainerIssue,
  readTriageInventory,
  triageMaintainerIssue,
} from '../src/maintainer-issues.js';
import type { CommandRunner } from '../src/dispatcher/issue-source.js';

const config = decodeAutopilotConfig(fixture);
const roots: string[] = [];

function inputFile(value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'autopilot-issue-input-'));
  roots.push(root);
  const path = join(root, 'input.json');
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return path;
}

function fieldList(): string {
  return JSON.stringify({
    data: {
      organization: {
        projectV2: {
          sprintField: {
            id: config.project.fields.sprint.id,
            configuration: {
              iterations: [{
                id: 'iteration-current',
                title: 'Current',
                startDate: '2026-07-20',
                duration: 14,
              }],
            },
          },
        },
      },
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('deterministic maintainer issue helpers', () => {
  it('previews a strict issue without mutating GitHub', async () => {
    const runner = vi.fn<CommandRunner>();
    const path = inputFile({
      title: 'Expose widget health',
      body: 'Operators cannot see widget health.',
      acceptanceCriteria: ['The status command reports widget health.'],
      type: 'feat',
      effort: 'medium',
      priority: 'p2',
    });

    const preview = await createMaintainerIssue({
      inputPath: path,
      apply: false,
      config,
      runner,
    });

    expect(preview.apply).toBe(false);
    expect(preview.mutations).toContain('create GitHub issue');
    expect(runner).not.toHaveBeenCalled();
  });

  it('creates, types, and completely triages only with apply', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args: [...args] });
      if (args[0] === 'issue' && args[1] === 'create') {
        return 'https://github.com/Octo-Labs/widget/issues/42\n';
      }
      if (args[0] === 'issue' && args[1] === 'view') return 'I_external_42\n';
      if (args[0] === 'project' && args[1] === 'item-add') {
        return '{"id":"PVTI_external_42"}';
      }
      if (args[0] === 'api' && args.includes('owner=Octo-Labs')) return fieldList();
      return '';
    };
    const path = inputFile({
      title: 'Expose widget health',
      body: 'Operators cannot see widget health.',
      acceptanceCriteria: ['The status command reports widget health.'],
      type: 'feat',
      effort: 'medium',
      priority: 'p2',
    });

    const result = await createMaintainerIssue({
      inputPath: path,
      apply: true,
      config,
      runner,
      now: new Date('2026-07-23T00:00:00Z'),
    });

    expect(result.result).toEqual({ issueNumber: 42 });
    const create = calls.find((call) => call.args[1] === 'create');
    expect(create?.args.some((arg) => arg.includes(
      '## Acceptance criteria\n\n- [ ] The status command reports widget health.',
    ))).toBe(true);
    expect(calls.some((call) => call.args.includes(
      'typeId=external_type_feat',
    ))).toBe(true);
    expect(calls.filter((call) => call.args[1] === 'item-edit')).toHaveLength(5);
    expect(calls.at(-1)?.args).toContain('iteration-current');
  });

  it('rejects vague or incomplete input before a mutation', async () => {
    const runner = vi.fn<CommandRunner>();
    const path = inputFile({
      title: 'Thing',
      body: 'Do it.',
      acceptanceCriteria: [],
      type: 'feat',
      effort: 'medium',
      priority: 'p2',
    });
    await expect(createMaintainerIssue({
      inputPath: path,
      apply: true,
      config,
      runner,
    })).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });

  it('retries partial issue triage through idempotent readback and field edits', async () => {
    const inputPath = inputFile({
      type: 'fix',
      effort: 'high',
      priority: 'p1',
      blockedOn: 'nothing',
    });
    let failOnce = true;
    const successfulEdits: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      if (args[0] === 'issue' && args[1] === 'view') return 'I_external_42\n';
      if (args[0] === 'project' && args[1] === 'item-add') {
        return '{"id":"PVTI_external_42"}';
      }
      if (args[0] === 'api' && args.includes('owner=Octo-Labs')) return fieldList();
      if (args[0] === 'project' && args[1] === 'item-edit') {
        if (failOnce && args.includes(config.project.fields.effort.id)) {
          failOnce = false;
          throw new Error('ambiguous network failure');
        }
        successfulEdits.push([...args]);
      }
      return '';
    };

    await expect(triageMaintainerIssue({
      issueNumber: 42,
      inputPath,
      apply: true,
      config,
      runner,
      now: new Date('2026-07-23T00:00:00Z'),
    })).rejects.toThrow(/ambiguous network failure/);
    await expect(triageMaintainerIssue({
      issueNumber: 42,
      inputPath,
      apply: true,
      config,
      runner,
      now: new Date('2026-07-23T00:00:00Z'),
    })).resolves.toMatchObject({ operation: 'triage', issueNumber: 42 });
    expect(successfulEdits.some((args) => args.includes('iteration-current'))).toBe(true);
  });

  it('reports missing triage facts and disallowed authors read-only', async () => {
    const runner: CommandRunner = async (_command, args) => {
      if (args[0] === 'project') {
        return JSON.stringify({
          items: [{
            content: {
              number: 7,
              title: 'External issue',
              type: 'Issue',
            },
            effort: '',
            priority: 'P2',
            blockedOn: 'Nothing',
            sprint: {
              duration: 14,
              iterationId: 'iteration-current',
              startDate: '2026-07-20',
              title: 'Sprint 1',
            },
          }],
        });
      }
      return JSON.stringify({
        data: {
          repository: {
            issue: {
              author: { login: 'someone-else' },
              issueType: null,
            },
          },
        },
      });
    };
    const inventory = await readTriageInventory(config, runner);
    expect(inventory.items).toEqual([{
      number: 7,
      title: 'External issue',
      missing: ['type', 'effort'],
      blocked: ['author-not-allowed'],
    }]);
  });
});
