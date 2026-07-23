import {
  existsSync,
  lstatSync,
  readFileSync,
  statfsSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  loadAutopilotConfig,
  type LoadedAutopilotConfig,
} from './config/config.js';
import { packageRoot } from './package-paths.js';
import { readCapabilityAttestation } from './lifecycle/capability-attestation.js';

export type DoctorRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> },
) => Promise<string>;

export interface DoctorCheck {
  readonly id: string;
  readonly status: 'pass' | 'degraded' | 'blocking';
  readonly detail: string;
  readonly remedy?: string;
}

export interface DoctorReport {
  readonly schemaVersion: 1;
  readonly repository?: string;
  readonly blocking: boolean;
  readonly checks: readonly DoctorCheck[];
}

interface StoredCredential {
  readonly login?: unknown;
  readonly token?: unknown;
}

interface CredentialProfile {
  readonly implementation?: StoredCredential | null;
  readonly review?: StoredCredential | null;
}

const DOCTOR_DISCOVERY_QUERY = `
query($owner: String!, $repository: String!, $projectNumber: Int!) {
  organization(login: $owner) {
    projectV2(number: $projectNumber) { id viewerCanUpdate }
    issueTypes(first: 100) { nodes { id name isEnabled } }
  }
  repository(owner: $owner, name: $repository) { viewerPermission }
}`;

function check(
  id: string,
  status: DoctorCheck['status'],
  detail: string,
  remedy?: string,
): DoctorCheck {
  return {
    id,
    status,
    detail,
    ...(remedy == null ? {} : { remedy }),
  };
}

async function attempt(
  id: string,
  operation: () => Promise<string> | string,
  remedy: string,
  status: 'blocking' | 'degraded' = 'blocking',
): Promise<DoctorCheck> {
  try {
    const detail = await operation();
    return check(id, 'pass', detail);
  } catch (error) {
    return check(
      id,
      status,
      error instanceof Error ? error.message : String(error),
      remedy,
    );
  }
}

function safeJson(raw: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} is malformed`);
  }
  return parsed as Record<string, unknown>;
}

function readCredentialProfile(
  loaded: LoadedAutopilotConfig,
  environment: NodeJS.ProcessEnv,
): {
  implementation?: { token: string; assertedLogin?: string };
  review?: { token: string; assertedLogin?: string };
} {
  let stored: CredentialProfile = {};
  if (existsSync(loaded.paths.credentials)) {
    const stat = lstatSync(loaded.paths.credentials);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error('credentials.json must be a regular owner-only file (0600)');
    }
    stored = JSON.parse(readFileSync(loaded.paths.credentials, 'utf8')) as CredentialProfile;
  }
  const implementationToken = environment.AUTOPILOT_GITHUB_IMPLEMENT_TOKEN
    ?? (typeof stored.implementation?.token === 'string'
      ? stored.implementation.token
      : undefined);
  const reviewToken = environment.AUTOPILOT_GITHUB_REVIEW_TOKEN
    ?? (typeof stored.review?.token === 'string' ? stored.review.token : undefined);
  return {
    ...(implementationToken == null
      ? {}
      : {
          implementation: {
            token: implementationToken,
            ...(typeof stored.implementation?.login === 'string'
              ? { assertedLogin: stored.implementation.login }
              : {}),
          },
        }),
    ...(reviewToken == null
      ? {}
      : {
          review: {
            token: reviewToken,
            ...(typeof stored.review?.login === 'string'
              ? { assertedLogin: stored.review.login }
              : {}),
          },
        }),
  };
}

async function resolveLogin(
  token: string,
  runner: DoctorRunner,
  cwd: string,
): Promise<string> {
  const login = (await runner('gh', ['api', 'user', '--jq', '.login'], {
    cwd,
    env: { GH_TOKEN: token },
  })).trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) {
    throw new Error('GitHub credential resolved to an invalid login');
  }
  return login;
}

function validateFieldIds(raw: string, loaded: LoadedAutopilotConfig): void {
  const parsed = safeJson(raw, 'Project fields') as {
    fields?: Array<{ id?: unknown; name?: unknown; options?: Array<{
      id?: unknown;
      name?: unknown;
    }> }>;
  };
  const fields = parsed.fields ?? [];
  const expected: Array<[string, string]> = [
    ['Status', loaded.config.project.fields.status.id],
    ['Priority', loaded.config.project.fields.priority.id],
    ['Effort', loaded.config.project.fields.effort.id],
    ['Blocked on', loaded.config.project.fields.blockedOn.id],
    ['Sprint', loaded.config.project.fields.sprint.id],
    ['Type', loaded.config.project.fields.type.id],
  ];
  for (const [name, id] of expected) {
    const matches = fields.filter((field) => field.name === name);
    if (matches.length !== 1 || matches[0]!.id !== id) {
      throw new Error(`Configured Project field ${name} does not match live schema`);
    }
  }
  const status = fields.find((field) => field.name === 'Status');
  const liveStatusIds = new Set((status?.options ?? []).map((option) => option.id));
  for (const optionId of Object.values(loaded.config.project.fields.status.options)) {
    if (!liveStatusIds.has(optionId)) {
      throw new Error('Configured Status options do not match live schema');
    }
  }
}

function pluginRegistered(hermesHome: string): void {
  const plugin = join(hermesHome, 'plugins', 'jinn');
  if (!existsSync(plugin) || lstatSync(plugin).isSymbolicLink() && !existsSync(resolve(plugin))) {
    throw new Error('The Jinn Plugin installation is missing or unloadable');
  }
  const configPath = join(hermesHome, 'config.yaml');
  if (!existsSync(configPath) || !/\bjinn\b/.test(readFileSync(configPath, 'utf8'))) {
    throw new Error('The Jinn Plugin is not enabled in Hermes');
  }
}

function validateSafePaths(loaded: LoadedAutopilotConfig): string {
  if (!isAbsolute(loaded.paths.root)) throw new Error('machine state path is not absolute');
  const resolvedRoot = resolve(loaded.paths.root);
  const broad = new Set([resolve('/'), resolve(homedir()), resolve(loaded.repositoryRoot)]);
  if (broad.has(resolvedRoot)) throw new Error('machine state path is dangerously broad');
  if (existsSync(resolvedRoot)) {
    const stat = lstatSync(resolvedRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error('repository state directory must be a real owner-only directory (0700)');
    }
  }
  return `machine state is confined to ${resolvedRoot}`;
}

function validateDisk(loaded: LoadedAutopilotConfig): string {
  let path = loaded.paths.root;
  while (!existsSync(path)) path = resolve(path, '..');
  const stats = statfsSync(path);
  const availableGb = Number(stats.bavail) * Number(stats.bsize) / 1_000_000_000;
  if (availableGb < loaded.config.safety.diskFloorGb) {
    throw new Error(
      `${availableGb.toFixed(1)} GB free is below the configured `
      + `${loaded.config.safety.diskFloorGb} GB floor`,
    );
  }
  return `${availableGb.toFixed(1)} GB available`;
}

export async function runDoctor(input: {
  readonly repositoryRoot: string;
  readonly runner: DoctorRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly hermesHome?: string;
  readonly nodeVersion?: string;
  readonly skipCapabilityAttestation?: boolean;
  readonly autopilotHome?: string;
}): Promise<DoctorReport> {
  const environment: NodeJS.ProcessEnv = {
    ...(input.environment ?? process.env),
    ...(input.autopilotHome == null ? {} : { AUTOPILOT_HOME: input.autopilotHome }),
  };
  let loaded: LoadedAutopilotConfig;
  try {
    loaded = await loadAutopilotConfig(input.repositoryRoot, environment);
  } catch (error) {
    return {
      schemaVersion: 1,
      blocking: true,
      checks: [check(
        'configuration',
        'blocking',
        error instanceof Error ? error.message : String(error),
        'Run `autopilot init`, then correct every reported configuration error.',
      )],
    };
  }

  const checks: DoctorCheck[] = [
    check('configuration', 'pass', `strict schema v1: ${loaded.configPath}`),
  ];
  const nodeVersion = input.nodeVersion ?? process.version;
  checks.push(
    /^v22\./.test(nodeVersion)
      ? check('node', 'pass', nodeVersion)
      : check(
          'node',
          'blocking',
          `Unsupported Node runtime ${nodeVersion}`,
          'Install and select Node 22.',
        ),
  );
  checks.push(await attempt(
    'git',
    async () => (await input.runner('git', ['--version'], {
      cwd: loaded.repositoryRoot,
    })).trim(),
    'Install Git and ensure it is available on PATH.',
  ));
  checks.push(await attempt(
    'github-cli',
    async () => (await input.runner('gh', ['--version'], {
      cwd: loaded.repositoryRoot,
    })).split('\n')[0]!,
    'Install GitHub CLI and authenticate it.',
  ));
  checks.push(await attempt(
    'repository',
    async () => {
      const raw = await input.runner('gh', [
        'repo',
        'view',
        '--json',
        'nameWithOwner,defaultBranchRef,databaseId',
      ], { cwd: loaded.repositoryRoot });
      const repository = safeJson(raw, 'GitHub repository');
      const branch = safeJson(
        JSON.stringify(repository.defaultBranchRef),
        'default branch',
      );
      if (
        repository.nameWithOwner !== loaded.config.repository.slug
        || repository.databaseId !== loaded.config.repository.restDatabaseId
        || branch.name !== loaded.config.repository.defaultBranch
      ) {
        throw new Error('live repository identity differs from configuration');
      }
      const remote = (await input.runner('git', [
        'remote',
        'get-url',
        loaded.config.repository.remote.name,
      ], { cwd: loaded.repositoryRoot })).trim();
      if (remote !== loaded.config.repository.remote.url) {
        throw new Error('publication remote differs from configuration');
      }
      return `${loaded.config.repository.slug} on ${loaded.config.repository.defaultBranch}`;
    },
    'Correct .autopilot/config.json or rerun `autopilot init` in the intended repository.',
  ));

  let implementationLogin: string | undefined;
  let reviewLogin: string | undefined;
  checks.push(await attempt(
    'credentials',
    async () => {
      const credentials = readCredentialProfile(loaded, environment);
      if (credentials.implementation == null) {
        throw new Error('implementation credential is unavailable');
      }
      implementationLogin = await resolveLogin(
        credentials.implementation.token,
        input.runner,
        loaded.repositoryRoot,
      );
      if (
        credentials.implementation.assertedLogin != null
        && credentials.implementation.assertedLogin.toLowerCase()
          !== implementationLogin.toLowerCase()
      ) {
        throw new Error('stored implementation login does not match its credential');
      }
      if (credentials.review != null) {
        reviewLogin = await resolveLogin(
          credentials.review.token,
          input.runner,
          loaded.repositoryRoot,
        );
        if (
          credentials.review.assertedLogin != null
          && credentials.review.assertedLogin.toLowerCase()
            !== reviewLogin.toLowerCase()
        ) {
          throw new Error('stored review login does not match its credential');
        }
        if (reviewLogin.toLowerCase() === implementationLogin.toLowerCase()) {
          throw new Error('implementation and review credentials resolve to the same identity');
        }
      }
      return reviewLogin == null
        ? `implementation identity ${implementationLogin}; review uses available independent identities`
        : `implementation ${implementationLogin}; review ${reviewLogin}`;
    },
    'Provide AUTOPILOT_GITHUB_IMPLEMENT_TOKEN and, when used, an independent review token.',
  ));

  checks.push(await attempt(
    'project-schema',
    async () => {
      const fieldRaw = await input.runner('gh', [
        'project',
        'field-list',
        String(loaded.config.project.number),
        '--owner',
        loaded.config.project.owner,
        '--limit',
        '100',
        '--format',
        'json',
      ], { cwd: loaded.repositoryRoot });
      validateFieldIds(fieldRaw, loaded);
      const [owner, repository] = loaded.config.repository.slug.split('/') as [string, string];
      const raw = await input.runner('gh', [
        'api',
        'graphql',
        '-f',
        `query=${DOCTOR_DISCOVERY_QUERY}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `repository=${repository}`,
        '-F',
        `projectNumber=${loaded.config.project.number}`,
      ], { cwd: loaded.repositoryRoot });
      const data = safeJson(raw, 'Project permission response').data;
      const root = typeof data === 'object' && data != null
        ? data as Record<string, unknown>
        : {};
      const organization = root.organization as Record<string, unknown> | undefined;
      const project = organization?.projectV2 as Record<string, unknown> | undefined;
      const repositoryNode = root.repository as Record<string, unknown> | undefined;
      if (
        project?.id !== loaded.config.project.id
        || project.viewerCanUpdate !== true
        || repositoryNode?.viewerPermission !== 'ADMIN'
      ) {
        throw new Error('Project or repository permissions are insufficient');
      }
      const issueTypes = (
        organization?.issueTypes as { nodes?: Array<{ id?: unknown }> } | undefined
      )?.nodes ?? [];
      const liveIds = new Set(issueTypes.map((type) => type.id));
      for (const id of Object.values(loaded.config.project.fields.type.options)) {
        if (!liveIds.has(id)) throw new Error('configured Issue Types differ from organization schema');
      }
      return 'Project profile, Issue Types, and mutation permissions match';
    },
    'Restore the configured Project fields/options and repository/Project permissions.',
  ));

  checks.push(await attempt(
    'hermes',
    async () => (await input.runner('hermes', ['--version'], {
      cwd: loaded.repositoryRoot,
    })).trim(),
    'Install and authenticate Hermes.',
  ));
  const hermesHome = input.hermesHome
    ?? environment.HERMES_HOME
    ?? join(homedir(), '.hermes');
  checks.push(await attempt(
    'jinn-plugin',
    () => {
      pluginRegistered(hermesHome);
      return 'Jinn Plugin is installed and enabled';
    },
    'Install and enable Jinn-Network/jinn-plugin in Hermes.',
  ));
  checks.push(await attempt(
    'plugin-diagnostics',
    async () => {
      const raw = await input.runner('hermes', ['doctor', '--json'], {
        cwd: loaded.repositoryRoot,
        env: { HERMES_HOME: hermesHome },
      });
      if (/\bdegraded\b/i.test(raw)) {
        throw new Error('Hermes reports plugin-owned diagnostic degradation');
      }
      return 'Hermes diagnostics passed';
    },
    'Inspect Hermes/Jinn Plugin diagnostics; Autopilot will not mutate plugin-owned state.',
    'degraded',
  ));
  checks.push(await attempt(
    'worker-composition',
    () => {
      const required = [
        join(packageRoot(), 'assets', 'engine-skills', 'implement-issue', 'SKILL.md'),
        join(packageRoot(), 'assets', 'engine-skills', 'review-pr', 'SKILL.md'),
        join(packageRoot(), 'assets', 'canon', 'active-active-lifecycle.md'),
      ];
      for (const path of required) {
        if (!existsSync(path)) throw new Error(`packaged worker asset is missing: ${path}`);
      }
      return `package-owned worker assets are available from ${packageRoot()}`;
    },
    'Reinstall @jinn-network/autopilot from a verified package.',
  ));
  checks.push(await attempt(
    'safe-paths',
    () => validateSafePaths(loaded),
    'Move AUTOPILOT_HOME to a private, repository-scoped location and correct its permissions.',
  ));
  checks.push(await attempt(
    'disk',
    () => validateDisk(loaded),
    'Free disk space or deliberately lower safety.diskFloorGb.',
  ));

  if (!input.skipCapabilityAttestation) {
    checks.push(await attempt(
      'git-ref-capabilities',
      () => {
        const logins = [implementationLogin, reviewLogin].filter(
          (value): value is string => value != null,
        );
        readCapabilityAttestation(loaded.paths.capabilityAttestation, {
          repositoryUrl: loaded.config.repository.remote.url,
          remoteName: loaded.config.repository.remote.name,
          configuredLogins: logins,
          now: new Date(),
        });
        return 'repository-bound Git ref capability attestation is current';
      },
      'Run the capability probe for this repository, then rerun `autopilot doctor`.',
    ));
  }

  return {
    schemaVersion: 1,
    repository: loaded.config.repository.slug,
    blocking: checks.some((entry) => entry.status === 'blocking'),
    checks,
  };
}
