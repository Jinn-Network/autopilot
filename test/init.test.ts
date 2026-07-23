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
  type InitializationInteractor,
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
              typeField: {
                id: 'PVTF_type',
                name: 'Type',
                dataType: 'ISSUE_TYPE',
              },
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
    if (command === 'hermes' && args[0] === 'plugins' && args[1] === 'list') {
      return JSON.stringify([
        { name: 'jinn', status: 'enabled', version: '0.1.0', source: 'git' },
      ]);
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

function detailedOption(name: string, id: string): object {
  return { name, id, color: 'GRAY', description: '' };
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

  it('asks the maintainer to select when multiple linked Projects exist', async () => {
    const root = repository();
    const calls: string[][] = [];
    const base = compatibleRunner(calls);
    const runner: InitializationRunner = async (command, args, options) => {
      if (
        command === 'gh'
        && args[0] === 'api'
        && args[1] === 'graphql'
        && args.some((arg) => arg.includes('linkedProjects: projectsV2'))
      ) {
        calls.push([command, ...args]);
        return JSON.stringify({
          data: {
            repository: {
              linkedProjects: {
                nodes: [
                  { id: 'PVT_12', number: 12, title: 'Roadmap' },
                  { id: 'PVT_73', number: 73, title: 'Widget engineering' },
                ],
              },
            },
            organization: {
              projectsV2: {
                nodes: [
                  { id: 'PVT_12', number: 12, title: 'Roadmap' },
                  { id: 'PVT_73', number: 73, title: 'Widget engineering' },
                ],
              },
            },
          },
        });
      }
      return base(command, args, options);
    };
    const selections: Parameters<InitializationInteractor['chooseProject']>[0][] = [];
    const interactor: InitializationInteractor = {
      chooseProject: async (request) => {
        selections.push(request);
        return { kind: 'existing', owner: 'Octo-Labs', number: 73 };
      },
      confirm: async () => true,
    };

    const result = await initializeAutopilot({
      cwd: root,
      nonInteractive: false,
      runner,
      interactor,
      environment: {},
    });

    expect(result.project).toEqual({ owner: 'Octo-Labs', number: 73 });
    expect(selections).toHaveLength(1);
    expect(selections[0]?.linked).toHaveLength(2);
  });

  it('previews a complete creation plan before creating and linking a Project', async () => {
    const root = repository();
    const calls: string[][] = [];
    const base = compatibleRunner(calls);
    let created = false;
    const runner: InitializationRunner = async (command, args, options) => {
      if (
        command === 'gh'
        && args[0] === 'api'
        && args[1] === 'graphql'
        && args.some((arg) => arg.includes('linkedProjects: projectsV2'))
      ) {
        calls.push([command, ...args]);
        return JSON.stringify({
          data: {
            repository: { linkedProjects: { nodes: [] } },
            organization: { projectsV2: { nodes: [] } },
          },
        });
      }
      if (
        command === 'gh'
        && args[0] === 'api'
        && args[1] === 'graphql'
        && args.some((arg) => arg.includes('projectCreationPreflight'))
      ) {
        calls.push([command, ...args]);
        return JSON.stringify({
          data: {
            projectCreationPreflight: {
              id: 'O_external',
              viewerCanAdminister: true,
              issueTypes: {
                nodes: [
                  issueType('feat'), issueType('fix'), issueType('refactor'),
                  issueType('spike'), issueType('chore'), issueType('docs'),
                  issueType('test'), issueType('incident'), issueType('design'),
                ],
              },
            },
            repository: { id: 'R_widget', viewerPermission: 'ADMIN' },
          },
        });
      }
      if (command === 'gh' && args[0] === 'project' && args[1] === 'create') {
        calls.push([command, ...args]);
        created = true;
        return JSON.stringify({
          id: 'PVT_external_fixture',
          number: 74,
          title: 'Widget Autopilot',
        });
      }
      if (command === 'gh' && args[0] === 'project' && args[1] === 'link') {
        calls.push([command, ...args]);
        return '';
      }
      return base(command, args, options);
    };
    const plans: string[][] = [];
    const interactor: InitializationInteractor = {
      chooseProject: async () => ({ kind: 'create', title: 'Widget Autopilot' }),
      confirm: async (plan) => {
        plans.push([...plan.changes]);
        return true;
      },
    };

    const result = await initializeAutopilot({
      cwd: root,
      nonInteractive: false,
      runner,
      interactor,
      environment: {},
    });

    expect(created).toBe(true);
    expect(result.project).toEqual({ owner: 'Octo-Labs', number: 74 });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toEqual(expect.arrayContaining([
      'Create organization Project "Widget Autopilot"',
      'Link Project to Octo-Labs/widget',
      'Provision Status, Priority, Effort, Blocked on, Sprint, and native Type mappings',
    ]));
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

  it('previews and creates only a missing compatible Project field', async () => {
    const root = repository();
    const calls: string[][] = [];
    const base = compatibleRunner(calls);
    let provisioned = false;
    const runner: InitializationRunner = async (command, args, options) => {
      if (command === 'gh' && args[0] === 'project' && args[1] === 'field-create') {
        calls.push([command, ...args]);
        provisioned = true;
        return JSON.stringify({ id: 'PVTF_priority' });
      }
      const raw = await base(command, args, options);
      if (
        !provisioned
        && command === 'gh'
        && args[0] === 'project'
        && args[1] === 'field-list'
      ) {
        const value = JSON.parse(raw);
        value.fields = value.fields.filter(
          (entry: { name: string }) => entry.name !== 'Priority',
        );
        return JSON.stringify(value);
      }
      return raw;
    };
    const plans: string[][] = [];
    const interactor: InitializationInteractor = {
      chooseProject: async () => {
        throw new Error('unexpected Project selection');
      },
      confirm: async (plan) => {
        plans.push([...plan.changes]);
        return true;
      },
    };

    await initializeAutopilot({
      cwd: root,
      nonInteractive: false,
      project: 'Octo-Labs/73',
      runner,
      interactor,
      environment: {},
    });

    expect(plans).toEqual([[
      'Create single-select field Priority with options P0, P1, P2, P3, P4',
    ]]);
    expect(calls.some((call) => (
      call[0] === 'gh'
      && call[1] === 'project'
      && call[2] === 'field-create'
      && call.includes('Priority')
    ))).toBe(true);
  });

  it('previews one complete plan before adding compatible options, Sprint, and Issue Types', async () => {
    const root = repository();
    const calls: string[][] = [];
    const base = compatibleRunner(calls);
    let statusUpdated = false;
    let sprintCreated = false;
    let typeCreated = false;
    const runner: InitializationRunner = async (command, args, options) => {
      if (
        command === 'gh'
        && args[0] === 'api'
        && args[1] === 'graphql'
        && args.some((arg) => arg.includes('singleSelectField: node'))
      ) {
        calls.push([command, ...args]);
        return JSON.stringify({
          data: {
            singleSelectField: {
              id: 'PVTF_status',
              name: 'Status',
              options: [
                detailedOption('Todo', 'status_todo'),
                detailedOption('In Progress', 'status_progress'),
                detailedOption('In Review', 'status_review'),
                detailedOption('Done', 'status_done'),
              ],
            },
          },
        });
      }
      if (command === 'gh' && args[0] === 'api' && args.includes('--input')) {
        calls.push([command, ...args]);
        const inputPath = args[args.indexOf('--input') + 1]!;
        const payload = JSON.parse(readFileSync(inputPath, 'utf8'));
        if (payload.query.includes('updateProjectV2Field')) statusUpdated = true;
        if (payload.query.includes('createProjectV2Field')) sprintCreated = true;
        return JSON.stringify({ data: {} });
      }
      if (
        command === 'gh'
        && args[0] === 'api'
        && args[1] === '--method'
        && args[2] === 'POST'
        && args.includes('orgs/Octo-Labs/issue-types')
      ) {
        calls.push([command, ...args]);
        typeCreated = true;
        return JSON.stringify({ node_id: 'IT_docs' });
      }
      const raw = await base(command, args, options);
      const complete = statusUpdated && sprintCreated && typeCreated;
      if (
        !complete
        && command === 'gh'
        && args[0] === 'project'
        && args[1] === 'field-list'
      ) {
        const value = JSON.parse(raw);
        value.fields = value.fields
          .filter((entry: { name: string }) => entry.name !== 'Sprint');
        const status = value.fields.find(
          (entry: { name: string }) => entry.name === 'Status',
        );
        status.options = status.options.filter(
          (entry: { name: string }) => entry.name !== 'Human',
        );
        return JSON.stringify(value);
      }
      if (
        !complete
        && command === 'gh'
        && args[0] === 'api'
        && args[1] === 'graphql'
      ) {
        const value = JSON.parse(raw);
        value.data.organization.issueTypes.nodes = value.data.organization
          .issueTypes.nodes.filter((entry: { name: string }) => entry.name !== 'docs');
        delete value.data.organization.projectV2.sprintField;
        return JSON.stringify(value);
      }
      return raw;
    };
    const plans: string[][] = [];
    const interactor: InitializationInteractor = {
      chooseProject: async () => {
        throw new Error('unexpected Project selection');
      },
      confirm: async (plan) => {
        plans.push([...plan.changes]);
        return true;
      },
    };

    await initializeAutopilot({
      cwd: root,
      nonInteractive: false,
      project: 'Octo-Labs/73',
      runner,
      interactor,
      environment: {},
    });

    expect(plans).toEqual([[
      'Add option Human to single-select field Status',
      'Create iteration field Sprint with two-week iterations',
      'Create enabled organization Issue Type docs',
    ]]);
    expect({ statusUpdated, sprintCreated, typeCreated }).toEqual({
      statusUpdated: true,
      sprintCreated: true,
      typeCreated: true,
    });
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

  it('installs and enables the Jinn Plugin only after confirmation when absent', async () => {
    const root = repository();
    const calls: string[][] = [];
    const base = compatibleRunner(calls);
    let installed = false;
    const runner: InitializationRunner = async (command, args, options) => {
      if (command === 'hermes' && args[0] === 'plugins' && args[1] === 'list') {
        calls.push([command, ...args]);
        return JSON.stringify(installed
          ? [{ name: 'jinn', status: 'enabled', version: '0.1.0', source: 'git' }]
          : []);
      }
      if (command === 'hermes' && args[0] === 'plugins' && args[1] === 'install') {
        calls.push([command, ...args]);
        installed = true;
        return '';
      }
      return base(command, args, options);
    };
    const changes: string[][] = [];
    const interactor: InitializationInteractor = {
      chooseProject: async () => {
        throw new Error('unexpected Project selection');
      },
      confirm: async (plan) => {
        changes.push([...plan.changes]);
        return true;
      },
    };

    await initializeAutopilot({
      cwd: root,
      nonInteractive: false,
      project: 'Octo-Labs/73',
      runner,
      interactor,
      environment: {},
    });

    expect(changes).toEqual([[
      'Install and enable Jinn-Network/jinn-plugin in Hermes',
    ]]);
    expect(calls.some((call) => call.join(' ') === (
      'hermes plugins install Jinn-Network/jinn-plugin --enable'
    ))).toBe(true);
  });
});
