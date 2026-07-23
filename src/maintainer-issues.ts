import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { AutopilotConfig } from './config/config.js';
import {
  parseItemAddId,
  type MachineTriageEffort,
  type MachineTriagePriority,
} from './lifecycle/project-triage.js';
import type { CommandRunner } from './dispatcher/issue-source.js';

const ISSUE_TYPES = [
  'feat',
  'fix',
  'refactor',
  'spike',
  'chore',
  'docs',
  'test',
  'incident',
  'design',
] as const;

const issueCreateSchema = z.object({
  title: z.string().trim().min(5).max(256),
  body: z.string().trim().min(1),
  acceptanceCriteria: z.array(z.string().trim().min(5)).min(1),
  type: z.enum(ISSUE_TYPES),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  priority: z.enum(['p0', 'p1', 'p2', 'p3', 'p4']),
}).strict();

const issueTriageSchema = z.object({
  type: z.enum(ISSUE_TYPES),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  priority: z.enum(['p0', 'p1', 'p2', 'p3', 'p4']),
  blockedOn: z.enum(['nothing', 'human', 'anotherIssue']),
}).strict();

export type MaintainerIssueCreateInput = z.infer<typeof issueCreateSchema>;
export type MaintainerIssueTriageInput = z.infer<typeof issueTriageSchema>;

export interface IssueMutationPreview {
  readonly schemaVersion: 1;
  readonly operation: 'create' | 'triage';
  readonly apply: boolean;
  readonly repository: string;
  readonly issueNumber?: number;
  readonly issue?: MaintainerIssueCreateInput;
  readonly triage: MaintainerIssueTriageInput;
  readonly mutations: readonly string[];
  readonly result?: { readonly issueNumber: number };
}

const UPDATE_ISSUE_TYPE_MUTATION = `
mutation($issueId: ID!, $typeId: ID!) {
  updateIssue(input: {id: $issueId, issueTypeId: $typeId}) {
    issue { id }
  }
}`;

function parsePositiveInteger(raw: string, label: string): number {
  const match = raw.trim().match(/(?:^|\/issues\/)([1-9][0-9]*)\s*$/);
  if (match == null) throw new Error(`Could not parse ${label} from: ${raw.trim()}`);
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${label}`);
  return value;
}

async function readJsonInput<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Cannot read JSON input ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return schema.parse(value);
}

function issueBody(input: MaintainerIssueCreateInput): string {
  return [
    input.body.trim(),
    '',
    '## Acceptance criteria',
    '',
    ...input.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`),
    '',
  ].join('\n');
}

async function issueNodeId(
  issueNumber: number,
  config: AutopilotConfig,
  runner: CommandRunner,
): Promise<string> {
  const raw = await runner('gh', [
    'issue',
    'view',
    String(issueNumber),
    '--repo',
    config.repository.slug,
    '--json',
    'id',
    '--jq',
    '.id',
  ]);
  const id = raw.trim();
  if (id === '') throw new Error(`GitHub returned no node ID for issue #${issueNumber}`);
  return id;
}

const SPRINT_CONFIGURATION_QUERY = `
query($owner: String!, $projectNumber: Int!) {
  organization(login: $owner) {
    projectV2(number: $projectNumber) {
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
}`;

const ISSUE_FACTS_QUERY = `
query($owner: String!, $repository: String!, $number: Int!) {
  repository(owner: $owner, name: $repository) {
    issue(number: $number) {
      author { login }
      issueType { name }
    }
  }
}`;

function currentSprintId(raw: string, sprintFieldId: string, now: Date): string {
  const parsed = JSON.parse(raw) as {
    data?: {
      organization?: {
        projectV2?: {
          sprintField?: {
            id?: unknown;
            configuration?: {
              iterations?: readonly {
                id?: unknown;
                title?: unknown;
                startDate?: unknown;
                duration?: unknown;
              }[];
            };
          };
        };
      };
    };
  };
  const sprint = parsed.data?.organization?.projectV2?.sprintField;
  if (sprint?.id !== sprintFieldId) {
    throw new Error(
      'Configured Sprint field does not match the live Project; run `autopilot doctor`',
    );
  }
  const iterations = sprint.configuration?.iterations ?? [];
  const nowMs = now.getTime();
  for (const iteration of iterations) {
    if (
      typeof iteration.id !== 'string'
      || typeof iteration.startDate !== 'string'
      || typeof iteration.duration !== 'number'
    ) continue;
    const start = Date.parse(`${iteration.startDate}T00:00:00Z`);
    const end = start + iteration.duration * 86_400_000;
    if (Number.isFinite(start) && nowMs >= start && nowMs < end) {
      return iteration.id;
    }
  }
  throw new Error(
    'No current Sprint iteration is configured; select or create the active iteration before applying triage',
  );
}

async function applyTriage(
  issueNumber: number,
  input: MaintainerIssueTriageInput,
  config: AutopilotConfig,
  runner: CommandRunner,
  now: Date,
): Promise<void> {
  const issueId = await issueNodeId(issueNumber, config, runner);
  await runner('gh', [
    'api',
    'graphql',
    '-f',
    `query=${UPDATE_ISSUE_TYPE_MUTATION}`,
    '-f',
    `issueId=${issueId}`,
    '-f',
    `typeId=${config.project.fields.type.options[input.type]}`,
  ]);

  const itemRaw = await runner('gh', [
    'project',
    'item-add',
    String(config.project.number),
    '--owner',
    config.project.owner,
    '--url',
    `https://github.com/${config.repository.slug}/issues/${issueNumber}`,
    '--format',
    'json',
  ]);
  const itemId = parseItemAddId(itemRaw);
  const fieldRaw = await runner('gh', [
    'api',
    'graphql',
    '-f',
    `query=${SPRINT_CONFIGURATION_QUERY}`,
    '-f',
    `owner=${config.project.owner}`,
    '-F',
    `projectNumber=${config.project.number}`,
  ]);
  const iterationId = currentSprintId(
    fieldRaw,
    config.project.fields.sprint.id,
    now,
  );

  const edits = [
    [
      '--field-id',
      config.project.fields.status.id,
      '--single-select-option-id',
      config.project.fields.status.options.todo,
    ],
    [
      '--field-id',
      config.project.fields.blockedOn.id,
      '--single-select-option-id',
      config.project.fields.blockedOn.options[input.blockedOn],
    ],
    [
      '--field-id',
      config.project.fields.effort.id,
      '--single-select-option-id',
      config.project.fields.effort.options[input.effort],
    ],
    [
      '--field-id',
      config.project.fields.priority.id,
      '--single-select-option-id',
      config.project.fields.priority.options[input.priority],
    ],
    [
      '--field-id',
      config.project.fields.sprint.id,
      '--iteration-id',
      iterationId,
    ],
  ] as const;
  // Sequential idempotent edits make a partial response safely resumable.
  for (const edit of edits) {
    await runner('gh', [
      'project',
      'item-edit',
      '--id',
      itemId,
      '--project-id',
      config.project.id,
      ...edit,
    ]);
  }
}

function mutationDescriptions(
  issueNumber: number | undefined,
  input: MaintainerIssueTriageInput,
): readonly string[] {
  return [
    ...(issueNumber === undefined ? ['create GitHub issue'] : []),
    `set Issue Type to ${input.type}`,
    'add issue to configured GitHub Project if missing',
    'set Status to Todo',
    `set Blocked on to ${input.blockedOn}`,
    `set Effort to ${input.effort}`,
    `set Priority to ${input.priority}`,
    'set Sprint to the current Project iteration',
  ];
}

export async function createMaintainerIssue(input: {
  readonly inputPath: string;
  readonly apply: boolean;
  readonly config: AutopilotConfig;
  readonly runner: CommandRunner;
  readonly now?: Date;
}): Promise<IssueMutationPreview> {
  const issue = await readJsonInput(input.inputPath, issueCreateSchema);
  const triage: MaintainerIssueTriageInput = {
    type: issue.type,
    effort: issue.effort,
    priority: issue.priority,
    blockedOn: 'nothing',
  };
  const preview: IssueMutationPreview = {
    schemaVersion: 1,
    operation: 'create',
    apply: input.apply,
    repository: input.config.repository.slug,
    issue,
    triage,
    mutations: mutationDescriptions(undefined, triage),
  };
  if (!input.apply) return preview;

  const created = await input.runner('gh', [
    'issue',
    'create',
    '--repo',
    input.config.repository.slug,
    '--title',
    issue.title,
    '--body',
    issueBody(issue),
  ]);
  const issueNumber = parsePositiveInteger(created, 'created issue number');
  await applyTriage(
    issueNumber,
    triage,
    input.config,
    input.runner,
    input.now ?? new Date(),
  );
  return { ...preview, result: { issueNumber } };
}

export async function triageMaintainerIssue(input: {
  readonly issueNumber: number;
  readonly inputPath: string;
  readonly apply: boolean;
  readonly config: AutopilotConfig;
  readonly runner: CommandRunner;
  readonly now?: Date;
}): Promise<IssueMutationPreview> {
  const triage = await readJsonInput(input.inputPath, issueTriageSchema);
  const preview: IssueMutationPreview = {
    schemaVersion: 1,
    operation: 'triage',
    apply: input.apply,
    repository: input.config.repository.slug,
    issueNumber: input.issueNumber,
    triage,
    mutations: mutationDescriptions(input.issueNumber, triage),
  };
  if (!input.apply) return preview;
  await applyTriage(
    input.issueNumber,
    triage,
    input.config,
    input.runner,
    input.now ?? new Date(),
  );
  return preview;
}

export interface TriageInventory {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly project: { readonly owner: string; readonly number: number };
  readonly items: readonly {
    readonly number: number;
    readonly title: string;
    readonly missing: readonly string[];
    readonly blocked: readonly string[];
  }[];
}

function projectFieldIsPresent(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const iterationId = (value as { iterationId?: unknown }).iterationId;
  return typeof iterationId === 'string' && iterationId.trim() !== '';
}

export async function readTriageInventory(
  config: AutopilotConfig,
  runner: CommandRunner,
): Promise<TriageInventory> {
  const raw = await runner('gh', [
    'project',
    'item-list',
    String(config.project.number),
    '--owner',
    config.project.owner,
    '--limit',
    '500',
    '--format',
    'json',
  ]);
  const parsed = JSON.parse(raw) as {
    items?: Array<Record<string, unknown> & {
      content?: {
        number?: unknown;
        title?: unknown;
        type?: unknown;
        author?: { login?: unknown };
      };
    }>;
  };
  const allowed = new Set(
    config.triage.allowedAuthors.map((author) => author.toLowerCase()),
  );
  const [owner, repository] = config.repository.slug.split('/') as [string, string];
  const items: TriageInventory['items'][number][] = [];
  for (const item of parsed.items ?? []) {
    const number = item.content?.number;
    if (typeof number !== 'number' || !Number.isSafeInteger(number)) continue;
    const factsRaw = await runner('gh', [
      'api',
      'graphql',
      '-f',
      `query=${ISSUE_FACTS_QUERY}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `repository=${repository}`,
      '-F',
      `number=${number}`,
    ]);
    const facts = JSON.parse(factsRaw) as {
      data?: {
        repository?: {
          issue?: {
            author?: { login?: unknown } | null;
            issueType?: { name?: unknown } | null;
          } | null;
        } | null;
      };
    };
    const issue = facts.data?.repository?.issue;
    const missing = [
      ['type', issue?.issueType?.name],
      ['effort', item.effort],
      ['priority', item.priority],
      ['blockedOn', item['blocked on'] ?? item.blockedOn],
      ['sprint', item.sprint],
    ].filter(([, value]) => !projectFieldIsPresent(value))
      .map(([name]) => name as string);
    const author = issue?.author?.login;
    const blocked = typeof author === 'string' && allowed.has(author.toLowerCase())
      ? []
      : ['author-not-allowed'];
    items.push({
      number,
      title: typeof item.content?.title === 'string'
        ? item.content.title
        : `Issue #${number}`,
      missing,
      blocked,
    });
  }
  return {
    schemaVersion: 1,
    repository: config.repository.slug,
    project: { owner: config.project.owner, number: config.project.number },
    items,
  };
}

export type { MachineTriageEffort, MachineTriagePriority };
