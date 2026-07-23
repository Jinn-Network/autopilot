import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  initializeAutopilot,
  type InitializationRunner,
} from '../src/init.js';

const roots: string[] = [];

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'autopilot-init-'));
  roots.push(root);
  writeFileSync(join(root, 'AGENTS.md'), '# Instructions\n');
  return root;
}

function compatibleRunner(calls: string[][]): InitializationRunner {
  return async (command, args, options) => {
    calls.push([command, ...args]);
    if (command === 'git' && args[0] === 'rev-parse') return `${options?.cwd}\n`;
    if (command === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
      return 'https://github.com/Octo-Labs/widget.git\n';
    }
    if (command === 'gh' && args[0] === 'repo') {
      return JSON.stringify({
        nameWithOwner: 'Octo-Labs/widget',
        databaseId: 987654,
        url: 'https://github.com/Octo-Labs/widget',
        defaultBranchRef: { name: 'trunk' },
      });
    }
    if (command === 'gh' && args[0] === 'api' && args[1] === 'user') {
      return 'octocat\n';
    }
    if (command === 'gh' && args[0] === 'project' && args[1] === 'view') {
      return JSON.stringify({
        id: 'PVT_external_fixture',
        number: 73,
        owner: { login: 'Octo-Labs' },
        title: 'Widget engineering',
      });
    }
    if (command === 'gh' && args[0] === 'project' && args[1] === 'field-list') {
      return JSON.stringify({
        fields: [
          field('Status', 'PVTF_status', [
            option('Todo', 'status_todo'),
            option('In Progress', 'status_progress'),
            option('Human', 'status_human'),
            option('In Review', 'status_review'),
            option('Done', 'status_done'),
          ]),
          field('Priority', 'PVTF_priority', [
            option('P0', 'priority_0'), option('P1', 'priority_1'),
            option('P2', 'priority_2'), option('P3', 'priority_3'),
            option('P4', 'priority_4'),
          ]),
          field('Effort', 'PVTF_effort', [
            option('Low', 'effort_low'), option('Medium', 'effort_medium'),
            option('High', 'effort_high'), option('XHigh', 'effort_xhigh'),
            option('Max', 'effort_max'),
          ]),
          field('Blocked on', 'PVTF_blocked', [
            option('Nothing', 'blocked_nothing'),
            option('Human', 'blocked_human'),
            option('Another issue', 'blocked_issue'),
          ]),
          { name: 'Sprint', id: 'PVTF_sprint', type: 'ProjectV2IterationField' },
          { name: 'Type', id: 'PVTF_type', type: 'ProjectV2Field' },
        ],
      });
    }
    if (command === 'gh' && args[0] === 'api' && args[1] === 'graphql') {
      return JSON.stringify({
        data: {
          organization: {
            id: 'O_external',
            viewerCanAdminister: true,
            issueTypes: {
              nodes: [
                issueType('feat'), issueType('fix'), issueType('refactor'),
                issueType('spike'), issueType('chore'), issueType('docs'),
                issueType('test'), issueType('incident'), issueType('design'),
              ],
            },
            projectV2: {
              id: 'PVT_external_fixture',
              viewerCanUpdate: true,
              sprintField: {
                id: 'PVTF_sprint',
                configuration: {
                  iterations: [{
                    id: 'iteration-current',
                    title: 'Sprint 1',
                    startDate: '2026-07-20',
                    duration: 14,
                  }],
                },
              },
            },
          },
          repository: { viewerPermission: 'ADMIN' },
        },
      });
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
}

function option(name: string, id: string): { name: string; id: string } {
  return { name, id };
}

function field(name: string, id: string, options: unknown[]): object {
  return { name, id, type: 'ProjectV2SingleSelectField', options };
}

function issueType(name: string): object {
  return { name, id: `IT_${name}`, isEnabled: true };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('autopilot init', () => {
  it('writes a strict conservative config from compatible existing GitHub state', async () => {
    const root = repository();
    const calls: string[][] = [];
    const result = await initializeAutopilot({
      cwd: root,
      nonInteractive: true,
      project: 'Octo-Labs/73',
      runner: compatibleRunner(calls),
      environment: {},
    });

    expect(result.status).toBe('initialized');
    const path = join(root, '.autopilot', 'config.json');
    expect(existsSync(path)).toBe(true);
    const config = JSON.parse(readFileSync(path, 'utf8'));
    expect(config.repository).toMatchObject({
      slug: 'Octo-Labs/widget',
      defaultBranch: 'trunk',
      instructionFiles: ['AGENTS.md'],
    });
    expect(config.mergePolicy).toBe('manual');
    expect(config.scheduler).toMatchObject({
      pollSeconds: 600,
      fullReconcileSeconds: 3600,
      implementationConcurrency: 1,
      reviewConcurrency: 1,
    });
    expect(config.triage.allowedAuthors).toEqual(['octocat']);
    expect(calls.every((call) => !call.includes('field-create'))).toBe(true);
  });

  it('requires an explicit Project in non-interactive mode before mutation', async () => {
    const root = repository();
    const calls: string[][] = [];
    await expect(initializeAutopilot({
      cwd: root,
      nonInteractive: true,
      runner: compatibleRunner(calls),
      environment: {},
    })).rejects.toThrow(/--project/);
    expect(calls).toEqual([]);
  });

  it('rejects contradictory fields and leaves configuration untouched', async () => {
    const root = repository();
    const calls: string[][] = [];
    const base = compatibleRunner(calls);
    const runner: InitializationRunner = async (command, args, options) => {
      const raw = await base(command, args, options);
      if (command === 'gh' && args[0] === 'project' && args[1] === 'field-list') {
        const value = JSON.parse(raw);
        value.fields.find((entry: { name: string }) => entry.name === 'Priority')
          .options[0].name = 'Urgent';
        return JSON.stringify(value);
      }
      return raw;
    };

    await expect(initializeAutopilot({
      cwd: root,
      nonInteractive: true,
      project: 'Octo-Labs/73',
      runner,
      environment: {},
    })).rejects.toThrow(/contradictory.*Priority.*P0/i);
    expect(existsSync(join(root, '.autopilot', 'config.json'))).toBe(false);
    expect(calls.some((call) => call.includes('field-create'))).toBe(false);
  });

  it('stores environment credentials only in an owner-only local profile', async () => {
    const root = repository();
    const autopilotHome = join(root, 'machine-home');
    const calls: string[][] = [];
    const base = compatibleRunner(calls);
    const runner: InitializationRunner = async (command, args, options) => {
      if (command === 'gh' && args[0] === 'api' && args[1] === 'user' && options?.env?.GH_TOKEN) {
        return options.env.GH_TOKEN === 'implementation-secret'
          ? 'implementer\n'
          : 'reviewer\n';
      }
      return base(command, args, options);
    };

    const result = await initializeAutopilot({
      cwd: root,
      nonInteractive: true,
      project: 'Octo-Labs/73',
      runner,
      environment: {
        AUTOPILOT_HOME: autopilotHome,
        AUTOPILOT_GITHUB_IMPLEMENT_TOKEN: 'implementation-secret',
        AUTOPILOT_GITHUB_REVIEW_TOKEN: 'review-secret',
      },
    });

    const credentialPath = result.paths.credentials;
    const raw = readFileSync(credentialPath, 'utf8');
    expect(raw).toContain('implementation-secret');
    expect(raw).toContain('review-secret');
    expect(statSync(credentialPath).mode & 0o077).toBe(0);
    expect(JSON.stringify(result)).not.toContain('implementation-secret');
  });
});
