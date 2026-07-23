import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
const REQUIRED_LABELS = {
  'engine:review': {
    color: '1D76DB',
    description: 'Autopilot independent review lifecycle',
  },
  'autopilot:human': {
    color: 'D93F0B',
    description: 'Autopilot requires human attention',
  },
  'review-finding': {
    color: 'FBCA04',
    description: 'Autopilot review-finding child issue',
  },
  reconcile: {
    color: '5319E7',
    description: 'Autopilot branch-reconciliation child issue',
  },
  'ci-failure': {
    color: 'B60205',
    description: 'Autopilot CI-failure child issue',
  },
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
      fields(first: 100) {
        nodes {
          ... on ProjectV2Field { id name dataType }
          ... on ProjectV2IterationField {
            id
            name
            dataType
            configuration {
              duration
              iterations { id title startDate duration }
            }
          }
        }
      }
    }
  }
  repository(owner: $owner, name: $repository) {
    viewerPermission
    labels(first: 100) {
      nodes { name }
    }
  }
}`;

const PROJECT_SELECTION_QUERY = `
query($owner: String!, $repository: String!) {
  repository(owner: $owner, name: $repository) {
    linkedProjects: projectsV2(first: 100) {
      nodes { id number title }
    }
  }
  organization(login: $owner) {
    projectsV2(first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { id number title }
    }
  }
}`;

const PROJECT_CREATION_PREFLIGHT_QUERY = `
query($owner: String!, $repository: String!) {
  projectCreationPreflight: organization(login: $owner) {
    id
    viewerCanAdminister
    issueTypes(first: 100) { nodes { id name isEnabled } }
  }
  repository(owner: $owner, name: $repository) {
    id
    viewerPermission
  }
}`;

const SINGLE_SELECT_DETAIL_QUERY = `
query($id: ID!) {
  singleSelectField: node(id: $id) {
    ... on ProjectV2SingleSelectField {
      id
      name
      options { id name color description }
    }
  }
}`;

const UPDATE_SINGLE_SELECT_QUERY = `
mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
  updateProjectV2Field(input: {
    fieldId: $fieldId,
    singleSelectOptions: $options
  }) {
    projectV2Field { ... on ProjectV2SingleSelectField { id } }
  }
}`;

const CREATE_SPRINT_QUERY = `
mutation(
  $projectId: ID!,
  $name: String!,
  $startDate: Date!,
  $duration: Int!,
  $iterations: [ProjectV2Iteration!]!
) {
  createProjectV2Field(input: {
    projectId: $projectId,
    dataType: ITERATION,
    name: $name,
    iterationConfiguration: {
      startDate: $startDate,
      duration: $duration,
      iterations: $iterations
    }
  }) {
    projectV2Field { ... on ProjectV2IterationField { id } }
  }
}`;

const CONFIGURE_SPRINT_QUERY = `
mutation(
  $fieldId: ID!,
  $startDate: Date!,
  $duration: Int!,
  $iterations: [ProjectV2Iteration!]!
) {
  updateProjectV2Field(input: {
    fieldId: $fieldId,
    iterationConfiguration: {
      startDate: $startDate,
      duration: $duration,
      iterations: $iterations
    }
  }) {
    projectV2Field { ... on ProjectV2IterationField { id } }
  }
}`;

export type InitializationRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> },
) => Promise<string>;

export interface InitializationProject {
  readonly id: string;
  readonly owner: string;
  readonly number: number;
  readonly title: string;
}

export type InitializationProjectChoice =
  | {
      readonly kind: 'existing';
      readonly owner: string;
      readonly number: number;
    }
  | {
      readonly kind: 'create';
      readonly title: string;
    };

export interface InitializationMutationPlan {
  readonly repository: string;
  readonly project: string;
  readonly changes: readonly string[];
}

export interface InitializationInteractor {
  chooseProject(input: {
    readonly repository: string;
    readonly linked: readonly InitializationProject[];
    readonly available: readonly InitializationProject[];
  }): Promise<InitializationProjectChoice>;
  confirm(plan: InitializationMutationPlan): Promise<boolean>;
  readCredentials?(): Promise<{
    readonly implementationToken: string;
    readonly reviewToken?: string;
  }>;
}

interface GitHubField {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly type?: unknown;
  readonly options?: readonly {
    readonly id?: unknown;
    readonly name?: unknown;
  }[];
}

interface SelectOptionDetail {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

type ProvisioningAction =
  | {
      readonly kind: 'create-single-select';
      readonly name: string;
      readonly options: readonly string[];
      readonly description: string;
    }
  | {
      readonly kind: 'add-single-select-options';
      readonly fieldId: string;
      readonly fieldName: string;
      readonly options: readonly string[];
      readonly description: string;
    }
  | {
      readonly kind: 'create-sprint';
      readonly description: string;
    }
  | {
      readonly kind: 'configure-empty-sprint';
      readonly fieldId: string;
      readonly description: string;
    }
  | {
      readonly kind: 'create-issue-type';
      readonly name: string;
      readonly description: string;
    }
  | {
      readonly kind: 'create-label';
      readonly name: keyof typeof REQUIRED_LABELS;
      readonly color: string;
      readonly labelDescription: string;
      readonly description: string;
    };

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
      readonly fields?: {
        readonly nodes?: readonly {
          readonly id?: unknown;
          readonly name?: unknown;
          readonly dataType?: unknown;
          readonly configuration?: {
            readonly duration?: unknown;
            readonly iterations?: readonly {
              readonly id?: unknown;
              readonly title?: unknown;
              readonly startDate?: unknown;
              readonly duration?: unknown;
            }[];
          };
        }[];
      };
    };
  };
  readonly repository?: {
    readonly viewerPermission?: unknown;
    readonly labels?: {
      readonly nodes?: readonly { readonly name?: unknown }[];
    };
  };
}

function nativeProjectField(
  project: NonNullable<NonNullable<Discovery['organization']>['projectV2']>,
  name: string,
  dataType: string,
): {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly dataType?: unknown;
  readonly configuration?: {
    readonly duration?: unknown;
    readonly iterations?: readonly {
      readonly id?: unknown;
      readonly title?: unknown;
      readonly startDate?: unknown;
      readonly duration?: unknown;
    }[];
  };
} | undefined {
  const matches = (project.fields?.nodes ?? []).filter((field) => field.name === name);
  if (matches.length > 1) {
    throw new Error(`Project has contradictory duplicate native fields named ${name}`);
  }
  const field = matches[0];
  if (field != null && field.dataType !== dataType) {
    throw new Error(`Project native field ${name} has contradictory type`);
  }
  return field;
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

function integerText(value: string, label: string): number {
  const trimmed = value.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) throw new Error(`${label} is missing`);
  return integer(Number(trimmed), label);
}

function parseProjectReference(raw: string): { owner: string; number: number } {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([1-9][0-9]*)$/.exec(raw);
  if (match == null) throw new Error('--project must be formatted as owner/number');
  return { owner: match[1]!, number: Number(match[2]) };
}

function projects(
  raw: unknown,
  owner: string,
  label: string,
): InitializationProject[] {
  if (!Array.isArray(raw)) throw new Error(`${label} is malformed`);
  return raw.map((value, index) => {
    const project = record(value, `${label}[${index}]`);
    return {
      id: text(project.id, `${label}[${index}] ID`),
      owner,
      number: integer(project.number, `${label}[${index}] number`),
      title: text(project.title, `${label}[${index}] title`),
    };
  });
}

async function chooseProject(input: {
  readonly owner: string;
  readonly repositoryName: string;
  readonly slug: string;
  readonly repositoryRoot: string;
  readonly runner: InitializationRunner;
  readonly interactor?: InitializationInteractor;
}): Promise<
  | { kind: 'existing'; owner: string; number: number }
  | { kind: 'create'; owner: string; title: string }
> {
  const document = parseJson(await input.runner('gh', [
    'api',
    'graphql',
    '-f',
    `query=${PROJECT_SELECTION_QUERY}`,
    '-f',
    `owner=${input.owner}`,
    '-f',
    `repository=${input.repositoryName}`,
  ], { cwd: input.repositoryRoot }), 'GitHub Project selection');
  const data = record(document.data, 'GitHub Project selection data');
  const repository = record(data.repository, 'GitHub Project selection repository');
  const organization = record(data.organization, 'GitHub Project selection organization');
  const linked = projects(
    record(repository.linkedProjects, 'linked Projects').nodes,
    input.owner,
    'linked Projects',
  );
  const available = projects(
    record(organization.projectsV2, 'organization Projects').nodes,
    input.owner,
    'organization Projects',
  );
  if (linked.length === 1) {
    return { kind: 'existing', owner: input.owner, number: linked[0]!.number };
  }
  if (input.interactor == null) {
    throw new Error(
      `Interactive Project selection is required for ${input.slug}; `
      + 'rerun in a terminal or supply --project owner/number',
    );
  }
  const choice = await input.interactor.chooseProject({
    repository: input.slug,
    linked,
    available,
  });
  if (choice.kind === 'create') {
    return {
      kind: 'create',
      owner: input.owner,
      title: text(choice.title, 'new Project title'),
    };
  }
  if (choice.owner.toLowerCase() !== input.owner.toLowerCase()) {
    throw new Error('V0 requires an organization Project owned by the repository organization');
  }
  const selected = available.find((project) => project.number === choice.number);
  if (selected == null) {
    throw new Error('Selected Project was not returned by GitHub discovery');
  }
  return { kind: 'existing', owner: input.owner, number: choice.number };
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

const SINGLE_SELECT_FIELDS = [
  { name: 'Status', options: Object.values(STATUS_OPTIONS) },
  { name: 'Priority', options: Object.values(PRIORITY_OPTIONS) },
  { name: 'Effort', options: Object.values(EFFORT_OPTIONS) },
  { name: 'Blocked on', options: Object.values(BLOCKED_OPTIONS) },
] as const;

function missingSingleSelectFields(
  fields: readonly GitHubField[],
): typeof SINGLE_SELECT_FIELDS[number][] {
  const missing: typeof SINGLE_SELECT_FIELDS[number][] = [];
  for (const expected of SINGLE_SELECT_FIELDS) {
    const matches = fields.filter((field) => field.name === expected.name);
    if (matches.length > 1) {
      throw new Error(`Project has contradictory duplicate fields named ${expected.name}`);
    }
    if (matches.length === 0) {
      missing.push(expected);
      continue;
    }
    if (matches[0]!.type !== 'ProjectV2SingleSelectField') {
      throw new Error(
        `Project field ${expected.name} has contradictory type ${String(matches[0]!.type)}`,
      );
    }
  }
  return missing;
}

function singleSelectProvisioningActions(
  fields: readonly GitHubField[],
): ProvisioningAction[] {
  const missingFields = new Set(
    missingSingleSelectFields(fields).map((field) => field.name),
  );
  const actions: ProvisioningAction[] = [];
  for (const expected of SINGLE_SELECT_FIELDS) {
    if (missingFields.has(expected.name)) {
      actions.push({
        kind: 'create-single-select',
        name: expected.name,
        options: expected.options,
        description: `Create single-select field ${expected.name} with options ${
          expected.options.join(', ')
        }`,
      });
      continue;
    }
    const field = findField(fields, expected.name);
    const liveNames = (field.options ?? []).map((option) => (
      text(option.name, `${expected.name} option name`)
    ));
    const unexpected = liveNames.filter((name) => !expected.options.includes(
      name as never,
    ));
    const missing = expected.options.filter((name) => !liveNames.includes(name));
    if (missing.length > 0 && unexpected.length > 0) {
      throw new Error(
        `Project has contradictory ${expected.name} options: required option ${
          missing[0]
        } is missing while unexpected option ${unexpected[0]} exists`,
      );
    }
    for (const name of missing) {
      actions.push({
        kind: 'add-single-select-options',
        fieldId: text(field.id, `${expected.name} field ID`),
        fieldName: expected.name,
        options: [name],
        description: `Add option ${name} to single-select field ${expected.name}`,
      });
    }
  }
  return actions;
}

function sprintProvisioningAction(fields: readonly GitHubField[]): ProvisioningAction[] {
  const matches = fields.filter((field) => field.name === 'Sprint');
  if (matches.length > 1) {
    throw new Error('Project has contradictory duplicate fields named Sprint');
  }
  if (matches.length === 0) {
    return [{
      kind: 'create-sprint',
      description: 'Create iteration field Sprint with two-week iterations',
    }];
  }
  if (matches[0]!.type !== 'ProjectV2IterationField') {
    throw new Error(
      `Project field Sprint has contradictory type ${String(matches[0]!.type)}`,
    );
  }
  return [];
}

function sprintIterationProvisioningActions(
  project: NonNullable<NonNullable<Discovery['organization']>['projectV2']>,
  now: Date,
): ProvisioningAction[] {
  const sprint = nativeProjectField(project, 'Sprint', 'ITERATION');
  if (sprint == null) return [];
  const iterations = sprint.configuration?.iterations;
  if (iterations == null) {
    throw new Error('Project Sprint iteration configuration is malformed');
  }
  const nowMs = now.getTime();
  const hasCurrent = iterations.some((iteration) => {
    if (
      typeof iteration.startDate !== 'string'
      || typeof iteration.duration !== 'number'
    ) return false;
    const start = Date.parse(`${iteration.startDate}T00:00:00Z`);
    return Number.isFinite(start)
      && nowMs >= start
      && nowMs < start + iteration.duration * 86_400_000;
  });
  if (hasCurrent) return [];
  if (iterations.length > 0) {
    throw new Error(
      'Project Sprint has iterations but none is current; select or create the '
      + 'active iteration manually',
    );
  }
  return [{
    kind: 'configure-empty-sprint',
    fieldId: text(sprint.id, 'Sprint field ID'),
    description: 'Create the first active two-week Sprint iteration',
  }];
}

function issueTypeProvisioningActions(
  nodes: NonNullable<NonNullable<Discovery['organization']>['issueTypes']>['nodes'],
): ProvisioningAction[] {
  const actions: ProvisioningAction[] = [];
  for (const name of Object.values(TYPE_OPTIONS)) {
    const named = (nodes ?? []).filter((node) => node.name === name);
    if (named.length > 1 || named.some((node) => node.isEnabled !== true)) {
      throw new Error(`Organization has contradictory Issue Type ${name}`);
    }
    if (named.length === 0) {
      actions.push({
        kind: 'create-issue-type',
        name,
        description: `Create enabled organization Issue Type ${name}`,
      });
    }
  }
  return actions;
}

function labelProvisioningActions(
  nodes: NonNullable<NonNullable<Discovery['repository']>['labels']>['nodes'],
): ProvisioningAction[] {
  const actions: ProvisioningAction[] = [];
  for (const [name, metadata] of Object.entries(REQUIRED_LABELS) as [
    keyof typeof REQUIRED_LABELS,
    (typeof REQUIRED_LABELS)[keyof typeof REQUIRED_LABELS],
  ][]) {
    const named = (nodes ?? []).filter((node) => (
      typeof node.name === 'string'
      && node.name.toLowerCase() === name.toLowerCase()
    ));
    if (
      named.length > 1
      || (named.length === 1 && named[0]!.name !== name)
    ) {
      throw new Error(`Repository has contradictory lifecycle label ${name}`);
    }
    if (named.length === 0) {
      actions.push({
        kind: 'create-label',
        name,
        color: metadata.color,
        labelDescription: metadata.description,
        description: `Create repository lifecycle label ${name}`,
      });
    }
  }
  return actions;
}

function currentMonday(now: Date): string {
  const date = new Date(now);
  const day = date.getUTCDay();
  const distance = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + distance);
  return date.toISOString().slice(0, 10);
}

async function graphqlInput(
  runner: InitializationRunner,
  cwd: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'autopilot-graphql-'));
  const inputPath = join(directory, 'request.json');
  try {
    writeFileSync(inputPath, JSON.stringify({ query, variables }), { mode: 0o600 });
    return await runner('gh', ['api', 'graphql', '--input', inputPath], { cwd });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function selectFieldDetails(
  runner: InitializationRunner,
  cwd: string,
  fieldId: string,
  fieldName: string,
): Promise<SelectOptionDetail[]> {
  const response = parseJson(await runner('gh', [
    'api',
    'graphql',
    '-f',
    `query=${SINGLE_SELECT_DETAIL_QUERY}`,
    '-f',
    `id=${fieldId}`,
  ], { cwd }), `${fieldName} field details`);
  const data = record(response.data, `${fieldName} field detail data`);
  const field = record(data.singleSelectField, `${fieldName} field detail`);
  if (text(field.id, `${fieldName} field detail ID`) !== fieldId) {
    throw new Error(`${fieldName} field changed during initialization`);
  }
  if (!Array.isArray(field.options)) {
    throw new Error(`${fieldName} field options are malformed`);
  }
  return field.options.map((value, index) => {
    const option = record(value, `${fieldName} option ${index}`);
    return {
      id: text(option.id, `${fieldName} option ID`),
      name: text(option.name, `${fieldName} option name`),
      color: text(option.color, `${fieldName} option color`),
      description: typeof option.description === 'string' ? option.description : '',
    };
  });
}

const OPTION_STYLES: Readonly<Record<string, { color: string; description: string }>> = {
  Human: { color: 'ORANGE', description: 'Requires human attention' },
  'In Review': { color: 'BLUE', description: 'Ready for independent review' },
};

async function applyProvisioningActions(input: {
  readonly actions: readonly ProvisioningAction[];
  readonly runner: InitializationRunner;
  readonly repositoryRoot: string;
  readonly projectOwner: string;
  readonly projectNumber: number;
  readonly projectId: string;
  readonly repositorySlug: string;
  readonly now: Date;
}): Promise<void> {
  const optionActions = new Map<string, {
    fieldName: string;
    options: string[];
  }>();
  for (const action of input.actions) {
    if (action.kind === 'add-single-select-options') {
      const entry = optionActions.get(action.fieldId) ?? {
        fieldName: action.fieldName,
        options: [],
      };
      entry.options.push(...action.options);
      optionActions.set(action.fieldId, entry);
      continue;
    }
    if (action.kind === 'create-single-select') {
      await input.runner('gh', [
        'project',
        'field-create',
        String(input.projectNumber),
        '--owner',
        input.projectOwner,
        '--name',
        action.name,
        '--data-type',
        'SINGLE_SELECT',
        '--single-select-options',
        action.options.join(','),
        '--format',
        'json',
      ], { cwd: input.repositoryRoot });
      continue;
    }
    if (action.kind === 'create-sprint') {
      const startDate = currentMonday(input.now);
      await graphqlInput(input.runner, input.repositoryRoot, CREATE_SPRINT_QUERY, {
        projectId: input.projectId,
        name: 'Sprint',
        startDate,
        duration: 14,
        iterations: [{ title: 'Sprint 1', startDate, duration: 14 }],
      });
      continue;
    }
    if (action.kind === 'configure-empty-sprint') {
      const startDate = currentMonday(input.now);
      await graphqlInput(input.runner, input.repositoryRoot, CONFIGURE_SPRINT_QUERY, {
        fieldId: action.fieldId,
        startDate,
        duration: 14,
        iterations: [{ title: 'Sprint 1', startDate, duration: 14 }],
      });
      continue;
    }
    if (action.kind === 'create-label') {
      await input.runner('gh', [
        'label',
        'create',
        action.name,
        '--repo',
        input.repositorySlug,
        '--color',
        action.color,
        '--description',
        action.labelDescription,
      ], { cwd: input.repositoryRoot });
      continue;
    }
    await input.runner('gh', [
      'api',
      '--method',
      'POST',
      `orgs/${input.projectOwner}/issue-types`,
      '-f',
      `name=${action.name}`,
      '-F',
      'is_enabled=true',
      '-f',
      `description=Autopilot work shape: ${action.name}`,
      '-f',
      'color=gray',
    ], { cwd: input.repositoryRoot });
  }
  for (const [fieldId, update] of optionActions) {
    const existing = await selectFieldDetails(
      input.runner,
      input.repositoryRoot,
      fieldId,
      update.fieldName,
    );
    const additions = update.options.map((name) => ({
      name,
      ...(OPTION_STYLES[name] ?? {
        color: 'GRAY',
        description: `Autopilot ${update.fieldName} option`,
      }),
    }));
    await graphqlInput(input.runner, input.repositoryRoot, UPDATE_SINGLE_SELECT_QUERY, {
      fieldId,
      options: [
        ...existing.map((option) => ({
          id: option.id,
          name: option.name,
          color: option.color,
          description: option.description,
        })),
        ...additions,
      ],
    });
  }
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

async function ensureJinnPlugin(input: {
  readonly runner: InitializationRunner;
  readonly repositoryRoot: string;
  readonly repository: string;
  readonly project: string;
  readonly nonInteractive: boolean;
  readonly interactor?: InitializationInteractor;
}): Promise<void> {
  const readPlugins = async (): Promise<Array<Record<string, unknown>>> => {
    const raw = await input.runner(
      'hermes',
      ['plugins', 'list', '--json'],
      { cwd: input.repositoryRoot },
    );
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('Hermes plugin list is malformed');
    return parsed.map((entry, index) => record(entry, `Hermes plugin ${index}`));
  };
  const plugins = await readPlugins();
  const installed = plugins.find((entry) => entry.name === 'jinn');
  if (installed?.status === 'enabled') return;
  const description = installed == null
    ? 'Install and enable Jinn-Network/jinn-plugin in Hermes'
    : 'Enable the existing Jinn Plugin in Hermes';
  if (input.nonInteractive || input.interactor == null) {
    throw new Error(`${description}; rerun interactively after reviewing this change`);
  }
  if (!await input.interactor.confirm({
    repository: input.repository,
    project: input.project,
    changes: [description],
  })) {
    throw new Error('Initialization cancelled before Hermes changes');
  }
  if (installed == null) {
    await input.runner('hermes', [
      'plugins',
      'install',
      'Jinn-Network/jinn-plugin',
      '--enable',
    ], { cwd: input.repositoryRoot });
  } else {
    await input.runner('hermes', [
      'plugins',
      'enable',
      'jinn',
      '--no-allow-tool-override',
    ], { cwd: input.repositoryRoot });
  }
  const verified = (await readPlugins()).find((entry) => entry.name === 'jinn');
  if (verified?.status !== 'enabled') {
    throw new Error('Hermes did not report the Jinn Plugin as enabled');
  }
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
  readonly interactor?: InitializationInteractor;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: Date;
}): Promise<InitializationResult> {
  if (input.nonInteractive && input.project == null) {
    throw new Error('Non-interactive initialization requires --project owner/number');
  }
  const environment = input.environment ?? process.env;
  const now = input.now ?? new Date();
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
    'nameWithOwner,defaultBranchRef,url',
  ], { cwd: repositoryRoot }), 'GitHub repository discovery');
  const slug = text(repo.nameWithOwner, 'repository nameWithOwner');
  const [owner, repositoryName] = slug.split('/') as [string, string];
  const restDatabaseId = integerText(await input.runner('gh', [
    'api',
    `repos/${slug}`,
    '--jq',
    '.id',
  ], { cwd: repositoryRoot }), 'repository REST database ID');
  const selectedProject = input.project == null
    ? await chooseProject({
        owner,
        repositoryName,
        slug,
        repositoryRoot,
        runner: input.runner,
        ...(input.interactor == null ? {} : { interactor: input.interactor }),
      })
    : { kind: 'existing' as const, ...parseProjectReference(input.project) };
  if (selectedProject.owner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error('V0 requires an organization Project owned by the repository organization');
  }
  const defaultBranch = text(
    record(repo.defaultBranchRef, 'default branch').name,
    'default branch name',
  );
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
  let projectCreationApproved = false;
  let projectRef: { owner: string; number: number };
  if (selectedProject.kind === 'create') {
    if (input.interactor == null) {
      throw new Error('Interactive Project creation requires terminal confirmation');
    }
    const preflightDocument = parseJson(await input.runner('gh', [
      'api',
      'graphql',
      '-f',
      `query=${PROJECT_CREATION_PREFLIGHT_QUERY}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `repository=${repositoryName}`,
    ], { cwd: repositoryRoot }), 'Project creation preflight');
    const preflightData = record(
      preflightDocument.data,
      'Project creation preflight data',
    );
    const organization = record(
      preflightData.projectCreationPreflight,
      'Project creation organization',
    );
    const repository = record(
      preflightData.repository,
      'Project creation repository',
    );
    if (
      organization.viewerCanAdminister !== true
      || repository.viewerPermission !== 'ADMIN'
    ) {
      throw new Error(
        'Repository and organization administration permissions are required; '
        + 'no Project or schema changes were made',
      );
    }
    const issueTypes = record(
      organization.issueTypes,
      'Project creation Issue Types',
    ).nodes;
    if (!Array.isArray(issueTypes)) {
      throw new Error('Project creation Issue Types are malformed');
    }
    const missingTypes = issueTypeProvisioningActions(
      issueTypes as NonNullable<
        NonNullable<Discovery['organization']>['issueTypes']
      >['nodes'],
    ).map((action) => action.description);
    const creationPlan: InitializationMutationPlan = {
      repository: slug,
      project: `${owner}/new`,
      changes: [
        `Create organization Project "${selectedProject.title}"`,
        `Link Project to ${slug}`,
        'Provision Status, Priority, Effort, Blocked on, Sprint, and native Type mappings',
        ...missingTypes,
      ],
    };
    if (!await input.interactor.confirm(creationPlan)) {
      throw new Error('Initialization cancelled before GitHub changes');
    }
    const created = parseJson(await input.runner('gh', [
      'project',
      'create',
      '--owner',
      owner,
      '--title',
      selectedProject.title,
      '--format',
      'json',
    ], { cwd: repositoryRoot }), 'created GitHub Project');
    const number = integer(created.number, 'created Project number');
    await input.runner('gh', [
      'project',
      'link',
      String(number),
      '--owner',
      owner,
      '--repo',
      repositoryName,
    ], { cwd: repositoryRoot });
    projectRef = { owner, number };
    projectCreationApproved = true;
  } else {
    projectRef = {
      owner: selectedProject.owner,
      number: selectedProject.number,
    };
  }

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
  let fieldDocument = parseJson(await input.runner('gh', [
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
  let fields = fieldDocument.fields as GitHubField[];

  let discoveryDocument = parseJson(await input.runner('gh', [
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
  let discovery = record(discoveryDocument.data, 'GitHub schema data') as Discovery;
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

  const actions = [
    ...singleSelectProvisioningActions(fields),
    ...sprintProvisioningAction(fields),
    ...sprintIterationProvisioningActions(discovery.organization.projectV2, now),
    ...issueTypeProvisioningActions(discovery.organization.issueTypes?.nodes),
    ...labelProvisioningActions(discovery.repository?.labels?.nodes),
  ];
  if (actions.length > 0) {
    const plan: InitializationMutationPlan = {
      repository: slug,
      project: `${projectRef.owner}/${projectRef.number}`,
      changes: actions.map((action) => action.description),
    };
    if (!projectCreationApproved && (input.nonInteractive || input.interactor == null)) {
      throw new Error(
        `Project requires confirmed changes; rerun interactively:\n${plan.changes.join('\n')}`,
      );
    }
    if (
      !projectCreationApproved
      && input.interactor != null
      && !await input.interactor.confirm(plan)
    ) {
      throw new Error('Initialization cancelled before GitHub changes');
    }
    await applyProvisioningActions({
      actions,
      runner: input.runner,
      repositoryRoot,
      projectOwner: projectRef.owner,
      projectNumber: projectRef.number,
      projectId,
      repositorySlug: slug,
      now,
    });
    fieldDocument = parseJson(await input.runner('gh', [
      'project',
      'field-list',
      String(projectRef.number),
      '--owner',
      projectRef.owner,
      '--limit',
      '100',
      '--format',
      'json',
    ], { cwd: repositoryRoot }), 'GitHub Project fields after provisioning');
    if (!Array.isArray(fieldDocument.fields)) {
      throw new Error('GitHub Project fields are malformed after provisioning');
    }
    fields = fieldDocument.fields as GitHubField[];
    discoveryDocument = parseJson(await input.runner('gh', [
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
    ], { cwd: repositoryRoot }), 'GitHub schema discovery after provisioning');
    discovery = record(
      discoveryDocument.data,
      'GitHub schema data after provisioning',
    ) as Discovery;
    const reloadedProject = discovery.organization?.projectV2;
    if (reloadedProject == null) {
      throw new Error('GitHub Project schema disappeared during provisioning');
    }
    if (
      singleSelectProvisioningActions(fields).length > 0
      || sprintProvisioningAction(fields).length > 0
      || sprintIterationProvisioningActions(reloadedProject, now).length > 0
      || issueTypeProvisioningActions(discovery.organization?.issueTypes?.nodes).length > 0
      || labelProvisioningActions(discovery.repository?.labels?.nodes).length > 0
    ) {
      throw new Error('GitHub Project provisioning did not converge; no configuration was written');
    }
  }

  const organizationSchema = discovery.organization;
  const projectSchema = organizationSchema?.projectV2;
  if (organizationSchema == null || projectSchema == null) {
    throw new Error('GitHub Project schema disappeared during initialization');
  }
  const typeNodes = organizationSchema.issueTypes?.nodes ?? [];
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
    nativeProjectField(projectSchema, 'Sprint', 'ITERATION')?.id,
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

  await ensureJinnPlugin({
    runner: input.runner,
    repositoryRoot,
    repository: slug,
    project: `${projectRef.owner}/${projectRef.number}`,
    nonInteractive: input.nonInteractive,
    ...(input.interactor == null ? {} : { interactor: input.interactor }),
  });

  const stateKey = repositoryStateKey(slug, config.repository.remote.url);
  const paths = autopilotRepositoryPaths(
    defaultAutopilotHome(environment),
    stateKey,
  );
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  let implementationToken = environment.AUTOPILOT_GITHUB_IMPLEMENT_TOKEN;
  let reviewToken = environment.AUTOPILOT_GITHUB_REVIEW_TOKEN;
  if (
    implementationToken == null
    && !existsSync(paths.credentials)
    && input.interactor?.readCredentials != null
  ) {
    const credentials = await input.interactor.readCredentials();
    implementationToken = credentials.implementationToken;
    reviewToken = credentials.reviewToken;
  }
  const implementationLogin = await credentialLogin(implementationToken, input.runner);
  const reviewLogin = await credentialLogin(reviewToken, input.runner);
  writeCredentials({
    path: paths.credentials,
    ...(implementationToken == null ? {} : { implementationToken }),
    ...(implementationLogin == null ? {} : { implementationLogin }),
    ...(reviewToken == null ? {} : { reviewToken }),
    ...(reviewLogin == null ? {} : { reviewLogin }),
  });
  const configPath = join(repositoryRoot, '.autopilot', 'config.json');
  atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`, 0o644);

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
