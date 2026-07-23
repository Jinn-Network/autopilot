import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import fixture from './fixtures/non-jinn-autopilot-config.json';
import {
  runDoctor,
  type DoctorRunner,
} from '../src/doctor.js';

const roots: string[] = [];

function setup(): {
  repositoryRoot: string;
  autopilotHome: string;
  hermesHome: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'autopilot-doctor-'));
  roots.push(root);
  const repositoryRoot = join(root, 'repo');
  const autopilotHome = join(root, 'autopilot-home');
  const hermesHome = join(root, 'hermes-home');
  mkdirSync(join(repositoryRoot, '.autopilot'), { recursive: true });
  mkdirSync(join(hermesHome, 'plugins', 'jinn'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(repositoryRoot, '.autopilot', 'config.json'),
    `${JSON.stringify({
      ...fixture,
      safety: { ...fixture.safety, diskFloorGb: 0 },
    })}\n`,
  );
  writeFileSync(
    join(hermesHome, 'config.yaml'),
    'plugins:\n  enabled:\n    - jinn\n',
    { mode: 0o600 },
  );
  return { repositoryRoot, autopilotHome, hermesHome };
}

const liveFields = JSON.stringify({
  fields: [
    {
      name: 'Status',
      id: fixture.project.fields.status.id,
      options: Object.entries(fixture.project.fields.status.options)
        .map(([key, id]) => ({
          id,
          name: {
            todo: 'Todo',
            inProgress: 'In Progress',
            human: 'Human',
            inReview: 'In Review',
            done: 'Done',
          }[key],
        })),
    },
    { name: 'Priority', id: fixture.project.fields.priority.id },
    { name: 'Effort', id: fixture.project.fields.effort.id },
    { name: 'Blocked on', id: fixture.project.fields.blockedOn.id },
    { name: 'Sprint', id: fixture.project.fields.sprint.id },
  ],
});

function healthyRunner(): DoctorRunner {
  return async (command, args, options) => {
    if (command === 'node') return 'v22.18.0\n';
    if (command === 'git' && args[0] === '--version') return 'git version 2.50.0\n';
    if (command === 'git' && args[0] === 'remote') {
      return `${fixture.repository.remote.url}\n`;
    }
    if (command === 'gh' && args[0] === '--version') return 'gh version 2.76.0\n';
    if (command === 'gh' && args[0] === 'repo') {
      return JSON.stringify({
        nameWithOwner: fixture.repository.slug,
        defaultBranchRef: { name: fixture.repository.defaultBranch },
        databaseId: fixture.repository.restDatabaseId,
      });
    }
    if (command === 'gh' && args[0] === 'project' && args[1] === 'field-list') {
      return liveFields;
    }
    if (command === 'gh' && args[0] === 'api' && args[1] === 'user') {
      return options?.env?.GH_TOKEN === 'review-secret'
        ? 'reviewer\n'
        : 'implementer\n';
    }
    if (command === 'gh' && args[0] === 'api' && args[1] === 'graphql') {
      return JSON.stringify({
        data: {
          organization: {
            projectV2: {
              id: fixture.project.id,
              viewerCanUpdate: true,
              typeField: {
                id: fixture.project.fields.type.id,
                name: 'Type',
                dataType: 'ISSUE_TYPE',
              },
            },
            issueTypes: {
              nodes: Object.entries(fixture.project.fields.type.options)
                .map(([name, id]) => ({ name, id, isEnabled: true })),
            },
          },
          repository: { viewerPermission: 'ADMIN' },
        },
      });
    }
    if (command === 'hermes' && args[0] === '--version') return 'hermes 1.4.0\n';
    if (command === 'hermes' && args[0] === 'doctor') return '{"status":"degraded"}\n';
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('autopilot doctor', () => {
  it('returns a versioned check list and does not make degraded plugin health blocking', async () => {
    const paths = setup();
    const report = await runDoctor({
      ...paths,
      runner: healthyRunner(),
      environment: {
        AUTOPILOT_HOME: paths.autopilotHome,
        AUTOPILOT_GITHUB_IMPLEMENT_TOKEN: 'implementation-secret',
        AUTOPILOT_GITHUB_REVIEW_TOKEN: 'review-secret',
      },
      nodeVersion: 'v22.18.0',
      skipCapabilityAttestation: true,
    });

    expect(report.schemaVersion).toBe(1);
    expect(report.checks.find((check) => check.id === 'plugin-diagnostics')?.status)
      .toBe('degraded');
    expect(report.checks.filter((entry) => entry.status === 'blocking')).toEqual([]);
    expect(report.blocking).toBe(false);
    expect(JSON.stringify(report)).not.toContain('implementation-secret');
  });

  it('treats missing plugin registration as blocking with one remedy', async () => {
    const paths = setup();
    rmSync(join(paths.hermesHome, 'plugins', 'jinn'), { recursive: true });
    const report = await runDoctor({
      ...paths,
      runner: healthyRunner(),
      environment: {
        AUTOPILOT_HOME: paths.autopilotHome,
        AUTOPILOT_GITHUB_IMPLEMENT_TOKEN: 'implementation-secret',
      },
      nodeVersion: 'v22.18.0',
      skipCapabilityAttestation: true,
    });
    const check = report.checks.find((entry) => entry.id === 'jinn-plugin');
    expect(check).toMatchObject({ status: 'blocking' });
    expect(check?.remedy).toMatch(/install|enable/i);
    expect(report.blocking).toBe(true);
  });

  it('reports a missing repository configuration as a blocking check', async () => {
    const paths = setup();
    rmSync(join(paths.repositoryRoot, '.autopilot', 'config.json'));
    const report = await runDoctor({
      ...paths,
      runner: healthyRunner(),
      environment: { AUTOPILOT_HOME: paths.autopilotHome },
      nodeVersion: 'v22.18.0',
    });
    expect(report.checks).toEqual([
      expect.objectContaining({ id: 'configuration', status: 'blocking' }),
    ]);
    expect(report.blocking).toBe(true);
  });
});
