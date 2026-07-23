import {
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  autopilotRepositoryPaths,
  decodeAutopilotConfig,
  defaultAutopilotHome,
  repositoryStateKey,
  type AutopilotRepositoryPaths,
} from './config/config.js';

const STATUS_OPTIONS = {
  todo: 'Todo',
  inProgress: 'In Progress',
  human: 'Human',
  inReview: 'In Review',
  done: 'Done',
} as const;
const PRIORITY_OPTIONS = {
  p0: 'P0', p1: 'P1', p2: 'P2', p3: 'P3', p4: 'P4',
} as const;
const EFFORT_OPTIONS = {
  low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max',
} as const;
const BLOCKED_OPTIONS = {
  nothing: 'Nothing', human: 'Human', anotherIssue: 'Another issue',
} as const;
const TYPE_OPTIONS = {
  feat: 'feat',
  fix: 'fix',
  refactor: 'refactor',
  spike: 'spike',
  chore: 'chore',
  docs: 'docs',
  test: 'test',
  incident: 'incident',
  design: 'design',
} as const;

const DISCOVERY_QUERY = `
query($owner: String!, $repository: String!, $projectNumber: Int!) {
  organization(login: $owner) {
    id
    viewerCanAdminister
    issueTypes(first: 100) {
      nodes { id name isEnabled }
    }
    projectV2(number: $projectNumber) {
      id
      viewerCanUpdate
      sprintField: field(name: "Sprint") {
        ... on ProjectV2IterationField {
          id
          configuration {
            iterations { id title startDate duration }
          }
        }
      }
    }
  }
  repository(owner: $owner, name: $repository) {
    viewerPermission
  }
}`;

export type InitializationRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> },
) => Promise<string>;

interface GitHubField {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly type?: unknown;
  readonly options?: readonly {
    readonly id?: unknown;
    readonly name?: unknown;
  }[];
}

interface Discovery {
  readonly organization?: {
    readonly id?: unknown;
    readonly viewerCanAdminister?: unknown;
    readonly issueTypes?: {
      readonly nodes?: readonly {
        readonly id?: unknown;
        readonly name?: unknown;
        readonly isEnabled?: unknown;
      }[];
    };
    readonly projectV2?: {
      readonly id?: unknown;
      readonly viewerCanUpdate?: unknown;
      readonly sprintField?: { readonly id?: unknown };
    };
  };
  readonly repository?: { readonly viewerPermission?: unknown };
}

export interface InitializationResult {
  readonly schemaVersion: 1;
  readonly status: 'initialized';
  readonly repositoryRoot: string;
  readonly configPath: string;
  readonly paths: AutopilotRepositoryPaths;
  readonly repository: string;
  readonly project: { readonly owner: string; readonly number: number };
  readonly credentials: {
    readonly implementationLogin?: string;
    readonly reviewLogin?: string;
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is missing`);
  }
  return value.trim();
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} is missing`);
  }
  return value;
}

function parseProjectReference(raw: string): { owner: string; number: number } {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([1-9][0-9]*)$/.exec(raw);
  if (match == null) throw new Error('--project must be formatted as owner/number');
  return { owner: match[1]!, number: Number(match[2]) };
}

function parseJson(raw: string, label: string): Record<string, unknown> {
  try {
    return record(JSON.parse(raw) as unknown, label);
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function canonicalRemote(slug: string): string {
  return `https://github.com/${slug}.git`;
}

function normalizedRemote(raw: string): string {
  const trimmed = raw.trim();
  const ssh = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(trimmed);
  if (ssh != null) return canonicalRemote(ssh[1]!);
  const https = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  return https == null ? trimmed : canonicalRemote(https[1]!);
}

function findField(fields: readonly GitHubField[], name: string): GitHubField {
  const matches = fields.filter((field) => field.name === name);
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `Project is missing required field ${name}`
        : `Project has contradictory duplicate fields named ${name}`,
    );
  }
  return matches[0]!;
}

function mapOptions<const Mapping extends Readonly<Record<string, string>>>(
  field: GitHubField,
  fieldName: string,
  expected: Mapping,
): { id: string; options: { [Key in keyof Mapping]: string } } {
  const id = text(field.id, `${fieldName} field ID`);
  const live = new Map<string, string>();
  for (const option of field.options ?? []) {
    live.set(text(option.name, `${fieldName} option name`), text(
      option.id,
      `${fieldName} option ID`,
    ));
  }
  const options = {} as { [Key in keyof Mapping]: string };
  for (const [key, name] of Object.entries(expected)) {
    const optionId = live.get(name);
    if (optionId == null) {
      throw new Error(
        `Project has contradictory ${fieldName} options: required option ${name} is missing`,
      );
    }
    options[key as keyof Mapping] = optionId;
  }
  return { id, options };
}

function instructionFiles(root: string): string[] {
  const candidates = [
    'AGENTS.md',
    'CLAUDE.md',
    '.github/copilot-instructions.md',
    '.cursor/rules.md',
    'docs/MAINTAINING.md',
    'CONTRIBUTING.md',
  ];
  return candidates.filter((path) => {
    const absolute = join(root, path);
    return existsSync(absolute) && lstatSync(absolute).isFile();
  });
}

function maintainerHost(root: string): 'claude' | 'codex' | 'cursor' {
  if (existsSync(join(root, '.codex'))) return 'codex';
  if (existsSync(join(root, '.cursor'))) return 'cursor';
  return 'claude';
}

function atomicWrite(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode });
  renameSync(temporary, path);
}

async function credentialLogin(
  token: string | undefined,
  runner: InitializationRunner,
): Promise<string | undefined> {
  if (token == null || token === '') return undefined;
  return text(await runner('gh', ['api', 'user', '--jq', '.login'], {
    env: { GH_TOKEN: token },
  }), 'credential login');
}

function writeCredentials(input: {
  readonly path: string;
  readonly implementationToken?: string;
  readonly implementationLogin?: string;
  readonly reviewToken?: string;
  readonly reviewLogin?: string;
}): void {
  if (input.implementationToken == null && input.reviewToken == null) return;
  atomicWrite(input.path, `${JSON.stringify({
    schemaVersion: 1,
    implementation: input.implementationToken == null
      ? null
      : {
          login: input.implementationLogin,
          token: input.implementationToken,
        },
    review: input.reviewToken == null
      ? null
      : { login: input.reviewLogin, token: input.reviewToken },
  }, null, 2)}\n`, 0o600);
}

export async function initializeAutopilot(input: {
  readonly cwd: string;
  readonly nonInteractive: boolean;
  readonly project?: string;
  readonly runner: InitializationRunner;
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<InitializationResult> {
  if (input.nonInteractive && input.project == null) {
    throw new Error('Non-interactive initialization requires --project owner/number');
  }
  if (input.project == null) {
    throw new Error(
      'Interactive Project selection is unavailable in this invocation; supply --project owner/number',
    );
  }
  const environment = input.environment ?? process.env;
  const projectRef = parseProjectReference(input.project);
  const repositoryRoot = resolve((await input.runner(
    'git',
    ['rev-parse', '--show-toplevel'],
    { cwd: input.cwd },
  )).trim());
  const relativeCwd = relative(repositoryRoot, resolve(input.cwd));
  if (relativeCwd.startsWith('..')) throw new Error('Current directory is outside repository root');

  const repo = parseJson(await input.runner('gh', [
    'repo',
    'view',
    '--json',
    'nameWithOwner,defaultBranchRef,databaseId,url',
  ], { cwd: repositoryRoot }), 'GitHub repository discovery');
  const slug = text(repo.nameWithOwner, 'repository nameWithOwner');
  const [owner, repositoryName] = slug.split('/') as [string, string];
  if (projectRef.owner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error('V0 requires an organization Project owned by the repository organization');
  }
  const defaultBranch = text(
    record(repo.defaultBranchRef, 'default branch').name,
    'default branch name',
  );
  const restDatabaseId = integer(repo.databaseId, 'repository REST database ID');
  const remoteName = 'origin';
  const discoveredRemote = normalizedRemote(await input.runner(
    'git',
    ['remote', 'get-url', remoteName],
    { cwd: repositoryRoot },
  ));
  if (discoveredRemote !== canonicalRemote(slug)) {
    throw new Error(
      `Publication remote ${remoteName} does not resolve to ${canonicalRemote(slug)}`,
    );
  }
  const maintainerLogin = text(await input.runner(
    'gh',
    ['api', 'user', '--jq', '.login'],
    { cwd: repositoryRoot },
  ), 'authenticated maintainer login');

  const project = parseJson(await input.runner('gh', [
    'project',
    'view',
    String(projectRef.number),
    '--owner',
    projectRef.owner,
    '--format',
    'json',
  ], { cwd: repositoryRoot }), 'GitHub Project discovery');
  const projectId = text(project.id, 'Project node ID');
  const fieldDocument = parseJson(await input.runner('gh', [
    'project',
    'field-list',
    String(projectRef.number),
    '--owner',
    projectRef.owner,
    '--limit',
    '100',
    '--format',
    'json',
  ], { cwd: repositoryRoot }), 'GitHub Project fields');
  if (!Array.isArray(fieldDocument.fields)) {
    throw new Error('GitHub Project fields are malformed');
  }
  const fields = fieldDocument.fields as GitHubField[];

  const discoveryDocument = parseJson(await input.runner('gh', [
    'api',
    'graphql',
    '-f',
    `query=${DISCOVERY_QUERY}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `repository=${repositoryName}`,
    '-F',
    `projectNumber=${projectRef.number}`,
  ], { cwd: repositoryRoot }), 'GitHub schema discovery');
  const discovery = record(discoveryDocument.data, 'GitHub schema data') as Discovery;
  if (discovery.repository?.viewerPermission !== 'ADMIN') {
    throw new Error(
      'Repository administration permission is required; no schema changes were made',
    );
  }
  if (discovery.organization?.projectV2?.viewerCanUpdate !== true) {
    throw new Error(
      'Project update permission is required; no schema changes were made',
    );
  }
  if (discovery.organization?.viewerCanAdminister !== true) {
    throw new Error(
      'Organization administration permission is required for Issue Types; no schema changes were made',
    );
  }

  const typeNodes = discovery.organization.issueTypes?.nodes ?? [];
  const typeOptions = {} as Record<keyof typeof TYPE_OPTIONS, string>;
  for (const [key, name] of Object.entries(TYPE_OPTIONS)) {
    const matches = typeNodes.filter((node) => node.name === name && node.isEnabled === true);
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `Organization is missing required enabled Issue Type ${name}`
          : `Organization has contradictory duplicate Issue Types named ${name}`,
      );
    }
    typeOptions[key as keyof typeof TYPE_OPTIONS] = text(
      matches[0]!.id,
      `${name} Issue Type ID`,
    );
  }
  const sprintField = findField(fields, 'Sprint');
  const liveSprintId = text(
    discovery.organization.projectV2.sprintField?.id,
    'live Sprint field ID',
  );
  if (text(sprintField.id, 'Sprint field ID') !== liveSprintId) {
    throw new Error('Project has contradictory Sprint field identity');
  }

  const config = decodeAutopilotConfig({
    schemaVersion: 1,
    repository: {
      slug,
      defaultBranch,
      restDatabaseId,
      remote: { name: remoteName, url: canonicalRemote(slug) },
      instructionFiles: instructionFiles(repositoryRoot),
    },
    project: {
      owner: projectRef.owner,
      number: projectRef.number,
      id: projectId,
      fields: {
        status: mapOptions(findField(fields, 'Status'), 'Status', STATUS_OPTIONS),
        priority: mapOptions(findField(fields, 'Priority'), 'Priority', PRIORITY_OPTIONS),
        effort: mapOptions(findField(fields, 'Effort'), 'Effort', EFFORT_OPTIONS),
        blockedOn: mapOptions(findField(fields, 'Blocked on'), 'Blocked on', BLOCKED_OPTIONS),
        sprint: { id: liveSprintId },
        type: {
          id: text(findField(fields, 'Type').id, 'Type field ID'),
          options: typeOptions,
        },
      },
    },
    worker: {
      runtime: 'hermes',
      model: 'gpt-5.6-sol',
      provider: 'openai-codex',
      repositorySkillDirectories: [],
    },
    scheduler: {
      pollSeconds: 600,
      fullReconcileSeconds: 3600,
      implementationConcurrency: 1,
      reviewConcurrency: 1,
      openPrBackpressure: 30,
    },
    triage: { allowedAuthors: [maintainerLogin] },
    safety: {
      staleAfterSeconds: 7200,
      diskFloorGb: 10,
      cleanup: true,
      children: true,
      carryover: true,
    },
    mergePolicy: 'manual',
    maintainerSkills: {
      host: maintainerHost(repositoryRoot),
      version: '0.1.0',
    },
  });

  const configPath = join(repositoryRoot, '.autopilot', 'config.json');
  atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`, 0o644);
  const stateKey = repositoryStateKey(slug, config.repository.remote.url);
  const paths = autopilotRepositoryPaths(
    defaultAutopilotHome(environment),
    stateKey,
  );
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const implementationToken = environment.AUTOPILOT_GITHUB_IMPLEMENT_TOKEN;
  const reviewToken = environment.AUTOPILOT_GITHUB_REVIEW_TOKEN;
  const implementationLogin = await credentialLogin(implementationToken, input.runner);
  const reviewLogin = await credentialLogin(reviewToken, input.runner);
  writeCredentials({
    path: paths.credentials,
    ...(implementationToken == null ? {} : { implementationToken }),
    ...(implementationLogin == null ? {} : { implementationLogin }),
    ...(reviewToken == null ? {} : { reviewToken }),
    ...(reviewLogin == null ? {} : { reviewLogin }),
  });

  return {
    schemaVersion: 1,
    status: 'initialized',
    repositoryRoot,
    configPath,
    paths,
    repository: slug,
    project: { owner: projectRef.owner, number: projectRef.number },
    credentials: {
      ...(implementationLogin == null ? {} : { implementationLogin }),
      ...(reviewLogin == null ? {} : { reviewLogin }),
    },
  };
}
