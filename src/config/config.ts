import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, posix } from 'node:path';
import { z } from 'zod';

const nonEmpty = z.string().min(1);
const positiveInteger = z.number().int().positive().safe();
const positiveSeconds = z.number().int().positive().safe();
const nonNegativeInteger = z.number().int().nonnegative().safe();
const gitHubSlug = z.string().regex(
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+$/,
  'repository slug must be owner/name',
);
const gitRef = z.string().min(1).superRefine((value, context) => {
  if (
    value.startsWith('/')
    || value.endsWith('/')
    || value.includes('..')
    || value.includes('//')
    || value.includes('@{')
    || /[\u0000-\u0020\u007f~^:?*[\]\\]/.test(value)
  ) {
    context.addIssue({ code: 'custom', message: 'must be a safe Git ref name' });
  }
});
const repositoryRelativePath = z.string().min(1).superRefine((value, context) => {
  const normalized = posix.normalize(value.replaceAll('\\', '/'));
  if (
    isAbsolute(value)
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.startsWith('/')
  ) {
    context.addIssue({
      code: 'custom',
      message: 'must be a repository-relative path that cannot escape the checkout',
    });
  }
});

function optionsSchema<const Keys extends readonly [string, ...string[]]>(
  keys: Keys,
) {
  return z.object(Object.fromEntries(
    keys.map((key) => [key, nonEmpty]),
  ) as Record<Keys[number], typeof nonEmpty>).strict().superRefine(
    (options, context) => {
      const values = Object.values(options);
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: 'custom', message: 'option IDs must be unique' });
      }
    },
  );
}

const mappedField = <Schema extends z.ZodType>(options: Schema) =>
  z.object({ id: nonEmpty, options }).strict();

const projectFieldsSchema = z.object({
  status: mappedField(optionsSchema([
    'todo', 'inProgress', 'human', 'inReview', 'done',
  ])),
  priority: mappedField(optionsSchema(['p0', 'p1', 'p2', 'p3', 'p4'])),
  effort: mappedField(optionsSchema(['low', 'medium', 'high', 'xhigh', 'max'])),
  blockedOn: mappedField(optionsSchema(['nothing', 'human', 'anotherIssue'])),
  sprint: z.object({ id: nonEmpty }).strict(),
  type: mappedField(optionsSchema([
    'feat',
    'fix',
    'refactor',
    'spike',
    'chore',
    'docs',
    'test',
    'incident',
    'design',
  ])),
}).strict().superRefine((fields, context) => {
  const ids = Object.values(fields).map((field) => field.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', message: 'Project field IDs must be unique' });
  }
});

export const autopilotConfigSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.object({
    slug: gitHubSlug,
    defaultBranch: gitRef,
    restDatabaseId: positiveInteger,
    remote: z.object({
      name: nonEmpty,
      url: z.string().url(),
    }).strict(),
    instructionFiles: z.array(repositoryRelativePath),
  }).strict(),
  project: z.object({
    owner: nonEmpty,
    number: positiveInteger,
    id: nonEmpty,
    fields: projectFieldsSchema,
  }).strict(),
  worker: z.object({
    runtime: z.literal('hermes'),
    model: nonEmpty,
    provider: nonEmpty,
    repositorySkillDirectories: z.array(repositoryRelativePath),
  }).strict(),
  scheduler: z.object({
    pollSeconds: positiveSeconds,
    fullReconcileSeconds: positiveSeconds,
    implementationConcurrency: positiveInteger,
    reviewConcurrency: positiveInteger,
    openPrBackpressure: positiveInteger,
  }).strict(),
  triage: z.object({
    allowedAuthors: z.array(nonEmpty).min(1),
  }).strict(),
  safety: z.object({
    staleAfterSeconds: positiveSeconds,
    diskFloorGb: nonNegativeInteger,
    cleanup: z.boolean(),
    children: z.boolean(),
    carryover: z.boolean(),
  }).strict(),
  mergePolicy: z.enum(['manual', 'safe-auto']),
  maintainerSkills: z.object({
    host: z.enum(['claude', 'codex', 'cursor']),
    version: nonEmpty,
  }).strict(),
}).strict().superRefine((config, context) => {
  const [owner, repository] = config.repository.slug.split('/') as [string, string];
  const expectedRemote = `https://github.com/${owner}/${repository}.git`;
  if (config.repository.remote.url !== expectedRemote) {
    context.addIssue({
      code: 'custom',
      path: ['repository', 'remote', 'url'],
      message: 'remote URL must match the configured repository slug',
    });
  }
  if (config.project.owner.toLowerCase() !== owner.toLowerCase()) {
    context.addIssue({
      code: 'custom',
      path: ['project', 'owner'],
      message: 'Project owner must match the repository organization',
    });
  }
});

export type AutopilotConfig = z.infer<typeof autopilotConfigSchema>;
export type RepositoryContext = AutopilotConfig['repository'];
export type ProjectMapping = AutopilotConfig['project'];
export type MergePolicy = AutopilotConfig['mergePolicy'];

export function decodeAutopilotConfig(value: unknown): AutopilotConfig {
  return autopilotConfigSchema.parse(value);
}

export function repositoryStateKey(slug: string, remoteUrl: string): string {
  const readable = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const digest = createHash('sha256').update(`${slug}\0${remoteUrl}`).digest('hex')
    .slice(0, 12);
  return `${readable}-${digest}`;
}

export interface AutopilotRepositoryPaths {
  readonly root: string;
  readonly credentials: string;
  readonly runtime: string;
  readonly capabilityAttestation: string;
  readonly state: string;
  readonly attempts: string;
  readonly logs: string;
  readonly service: string;
}

export function defaultAutopilotHome(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.AUTOPILOT_HOME ?? join(homedir(), '.autopilot');
}

export function autopilotRepositoryPaths(
  autopilotHome: string,
  stateKey: string,
): AutopilotRepositoryPaths {
  const root = join(autopilotHome, 'repositories', stateKey);
  return {
    root,
    credentials: join(root, 'credentials.json'),
    runtime: join(root, 'runtime.json'),
    capabilityAttestation: join(root, 'capability-attestation.json'),
    state: join(root, 'state'),
    attempts: join(root, 'attempts'),
    logs: join(root, 'logs'),
    service: join(root, 'service'),
  };
}

export interface LoadedAutopilotConfig {
  readonly config: AutopilotConfig;
  readonly configPath: string;
  readonly repositoryRoot: string;
  readonly stateKey: string;
  readonly paths: AutopilotRepositoryPaths;
}

export async function loadAutopilotConfig(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LoadedAutopilotConfig> {
  const configPath = join(repositoryRoot, '.autopilot', 'config.json');
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `Autopilot configuration not found at ${configPath}; run \`autopilot init\``,
      );
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Autopilot configuration at ${configPath} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const config = decodeAutopilotConfig(value);
  const stateKey = repositoryStateKey(
    config.repository.slug,
    config.repository.remote.url,
  );
  return {
    config,
    configPath,
    repositoryRoot,
    stateKey,
    paths: autopilotRepositoryPaths(defaultAutopilotHome(environment), stateKey),
  };
}
