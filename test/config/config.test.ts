import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  autopilotRepositoryPaths,
  decodeAutopilotConfig,
  loadAutopilotConfig,
  repositoryStateKey,
} from '../../src/config/config.js';

function validConfig(): unknown {
  return {
    schemaVersion: 1,
    repository: {
      slug: 'Octo-Labs/widget',
      defaultBranch: 'main',
      restDatabaseId: 123456,
      remote: {
        name: 'origin',
        url: 'https://github.com/Octo-Labs/widget.git',
      },
      instructionFiles: ['AGENTS.md', 'CONTRIBUTING.md'],
    },
    project: {
      owner: 'Octo-Labs',
      number: 7,
      id: 'PVT_external',
      fields: {
        status: {
          id: 'PVTF_status',
          options: {
            todo: 'status_todo',
            inProgress: 'status_progress',
            human: 'status_human',
            inReview: 'status_review',
            done: 'status_done',
          },
        },
        priority: {
          id: 'PVTF_priority',
          options: {
            p0: 'priority_0',
            p1: 'priority_1',
            p2: 'priority_2',
            p3: 'priority_3',
            p4: 'priority_4',
          },
        },
        effort: {
          id: 'PVTF_effort',
          options: {
            low: 'effort_low',
            medium: 'effort_medium',
            high: 'effort_high',
            xhigh: 'effort_xhigh',
            max: 'effort_max',
          },
        },
        blockedOn: {
          id: 'PVTF_blocked',
          options: {
            nothing: 'blocked_nothing',
            human: 'blocked_human',
            anotherIssue: 'blocked_issue',
          },
        },
        sprint: { id: 'PVTF_sprint' },
        type: {
          options: {
            feat: 'type_feat',
            fix: 'type_fix',
            refactor: 'type_refactor',
            spike: 'type_spike',
            chore: 'type_chore',
            docs: 'type_docs',
            test: 'type_test',
            incident: 'type_incident',
            design: 'type_design',
          },
        },
      },
    },
    worker: {
      runtime: 'hermes',
      model: 'gpt-5.6-sol',
      provider: 'openai-codex',
      repositorySkillDirectories: ['.agents/skills'],
    },
    scheduler: {
      pollSeconds: 600,
      fullReconcileSeconds: 3600,
      implementationConcurrency: 1,
      reviewConcurrency: 1,
      openPrBackpressure: 30,
    },
    triage: {
      allowedAuthors: ['octocat'],
    },
    safety: {
      staleAfterSeconds: 7200,
      diskFloorGb: 10,
      cleanup: true,
      children: true,
      carryover: true,
    },
    mergePolicy: 'manual',
    maintainerSkills: {
      host: 'codex',
      version: '0.1.0',
    },
  };
}

describe('Autopilot product configuration', () => {
  it('decodes the complete non-Jinn v1 configuration without changing values', () => {
    expect(decodeAutopilotConfig(validConfig())).toEqual(validConfig());
  });

  it('rejects unknown keys instead of silently accepting policy drift', () => {
    const input = validConfig() as Record<string, unknown>;
    input.legacyJinnFallback = true;
    expect(() => decodeAutopilotConfig(input)).toThrow(/unrecognized key/i);
  });

  it('rejects a publication URL that does not match the configured repository', () => {
    const input = validConfig() as ReturnType<typeof validConfig> & {
      repository: { remote: { url: string } };
    };
    input.repository.remote.url = 'https://github.com/Jinn-Network/mono.git';
    expect(() => decodeAutopilotConfig(input)).toThrow(/remote URL.*repository slug/i);
  });

  it('rejects repository-relative paths that can escape the checkout', () => {
    const input = validConfig() as ReturnType<typeof validConfig> & {
      repository: { instructionFiles: string[] };
    };
    input.repository.instructionFiles = ['../CLAUDE.md'];
    expect(() => decodeAutopilotConfig(input)).toThrow(/repository-relative path/i);
  });

  it('accepts only the Hermes worker and the two explicit merge policies', () => {
    const runtime = validConfig() as ReturnType<typeof validConfig> & {
      worker: { runtime: string };
    };
    runtime.worker.runtime = 'claude';
    expect(() => decodeAutopilotConfig(runtime)).toThrow(/runtime/i);

    const policy = validConfig() as ReturnType<typeof validConfig> & {
      mergePolicy: string;
    };
    policy.mergePolicy = 'always';
    expect(() => decodeAutopilotConfig(policy)).toThrow(/mergePolicy/i);
  });

  it('derives a collision-safe stable state key and owner-only repository paths', () => {
    const key = repositoryStateKey(
      'Octo-Labs/widget',
      'https://github.com/Octo-Labs/widget.git',
    );
    expect(key).toMatch(/^octo-labs-widget-[0-9a-f]{12}$/);
    expect(repositoryStateKey(
      'Octo-Labs/widget',
      'https://github.com/Octo-Labs/widget.git',
    )).toBe(key);
    expect(repositoryStateKey(
      'Octo-Labs/widget',
      'https://github.com/someone-else/widget.git',
    )).not.toBe(key);

    expect(autopilotRepositoryPaths('/tmp/autopilot-home', key)).toEqual({
      root: `/tmp/autopilot-home/repositories/${key}`,
      credentials: `/tmp/autopilot-home/repositories/${key}/credentials.json`,
      runtime: `/tmp/autopilot-home/repositories/${key}/runtime.json`,
      capabilityAttestation:
        `/tmp/autopilot-home/repositories/${key}/capability-attestation.json`,
      state: `/tmp/autopilot-home/repositories/${key}/state`,
      attempts: `/tmp/autopilot-home/repositories/${key}/attempts`,
      logs: `/tmp/autopilot-home/repositories/${key}/logs`,
      service: `/tmp/autopilot-home/repositories/${key}/service`,
    });
  });

  it('loads the strict repository configuration from .autopilot/config.json', async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), 'autopilot-config-'));
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(join(repositoryRoot, '.autopilot'), { recursive: true }));
    await writeFile(
      join(repositoryRoot, '.autopilot', 'config.json'),
      `${JSON.stringify(validConfig())}\n`,
      'utf8',
    );

    const loaded = await loadAutopilotConfig(repositoryRoot);

    expect(loaded.config).toEqual(validConfig());
    expect(loaded.repositoryRoot).toBe(repositoryRoot);
    expect(loaded.configPath).toBe(join(repositoryRoot, '.autopilot', 'config.json'));
    expect(loaded.stateKey).toMatch(/^octo-labs-widget-[0-9a-f]{12}$/);
  });

  it('reports malformed JSON with the repository config path', async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), 'autopilot-config-'));
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(join(repositoryRoot, '.autopilot'), { recursive: true }));
    const configPath = join(repositoryRoot, '.autopilot', 'config.json');
    await writeFile(configPath, '{', 'utf8');

    await expect(loadAutopilotConfig(repositoryRoot)).rejects.toThrow(
      new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });
});
