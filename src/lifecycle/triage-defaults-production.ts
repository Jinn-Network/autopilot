/**
 * Production board-triage writer (#166).
 *
 * The mutation surface is exactly the machine-child repair's: one
 * `updateIssueIssueType` GraphQL mutation for the native Issue Type, and one
 * `gh project item-edit` for the Project Priority, each guarded by a readback
 * taken immediately before the write. The guard is the whole point — a field a
 * human filled in between the snapshot and the write must be left alone, and
 * the refusal reported rather than swallowed.
 *
 * What differs from the child repair is the READ. The child repair pages the
 * whole Project to find its item; this action already carries the item id the
 * snapshot saw, so it reads that node directly and proves the node still
 * belongs to the issue it names. That makes a triage write two cheap reads
 * instead of a board-wide scan, which is what makes ten of them per cycle
 * affordable.
 */

import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { ORG, PROJECT_NUMBER, REPO } from '../dispatcher/constants.js';
import type { ProjectMapping } from '../config/config.js';
import { parseTriageFields } from './project-triage.js';
import type { NewWorkAction } from './types.js';

type TriageDefaultsAction = Extract<NewWorkAction, { kind: 'triage-defaults' }>;

export interface ProductionTriageDefaultsOptions {
  readonly runner?: CommandRunner;
  readonly repo?: string;
  readonly projectOwner?: string;
  readonly projectNumber?: number;
  readonly projectMapping?: ProjectMapping;
}

/**
 * Reads the issue and the one Project item the action names, in a single
 * round trip. `node(id:)` rather than a paged `items(first: 100)` scan: the
 * item id came from the same snapshot that planned the action, and the
 * `content` assertion below is what turns that id back into proof.
 */
const TRIAGE_DEFAULTS_STATE_QUERY = `
query TriageDefaultsState(
  $owner: String!,
  $name: String!,
  $number: Int!,
  $itemId: ID!
) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      id
      state
      issueType { name }
    }
  }
  node(id: $itemId) {
    __typename
    ... on ProjectV2Item {
      id
      project { id }
      content {
        __typename
        ... on Issue {
          number
          repository { nameWithOwner }
        }
      }
      priority: fieldValueByName(name: "Priority") {
        ... on ProjectV2ItemFieldSingleSelectValue { name }
      }
    }
  }
}
`;

/** The same mutation the machine-child repair uses; the taxonomy is org-wide. */
const UPDATE_ISSUE_TYPE_MUTATION = `
mutation($issueId: ID!, $typeId: ID!) {
  updateIssueIssueType(input: { issueId: $issueId, issueTypeId: $typeId }) {
    issue { number issueType { name } }
  }
}
`;

const ISSUE_TYPES_QUERY = `
query($owner: String!) {
  organization(login: $owner) {
    issueTypes(first: 100) {
      nodes { id name isEnabled }
    }
  }
}
`;

interface TriageDefaultsState {
  readonly issueId: string;
  readonly issueType: string | null;
  readonly projectId: string;
  readonly priority: string | null;
}

function optionalSelectName(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { name?: unknown }).name === 'string'
  ) {
    return (value as { name: string }).name;
  }
  throw new Error(`Malformed triage-defaults ${label}`);
}

function splitRepo(repo: string): readonly [string, string] {
  const [owner, name, ...unexpected] = repo.split('/');
  if (
    owner === undefined || owner.length === 0
    || name === undefined || name.length === 0
    || unexpected.length > 0
  ) {
    throw new Error('Triage-defaults repository must be owner/name');
  }
  return [owner, name];
}

async function readTriageDefaultsState(
  runner: CommandRunner,
  action: TriageDefaultsAction,
  repo: string,
): Promise<TriageDefaultsState> {
  const [owner, name] = splitRepo(repo);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await runner('gh', [
      'api',
      'graphql',
      '-f',
      `query=${TRIAGE_DEFAULTS_STATE_QUERY}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-F',
      `number=${action.issueNumber}`,
      '-f',
      `itemId=${action.projectItemId}`,
    ])) as unknown;
  } catch {
    throw new Error('Malformed triage-defaults state readback');
  }
  const data = (parsed as {
    data?: {
      repository?: { issue?: unknown } | null;
      node?: unknown;
    };
  }).data;
  const issue = data?.repository?.issue;
  if (
    typeof issue !== 'object'
    || issue === null
    || Array.isArray(issue)
    || typeof (issue as { id?: unknown }).id !== 'string'
    || (issue as { state?: unknown }).state !== 'OPEN'
  ) {
    throw new Error('Triage-defaults issue is missing, closed, or malformed');
  }
  const node = data?.node;
  if (
    typeof node !== 'object'
    || node === null
    || Array.isArray(node)
    || (node as { __typename?: unknown }).__typename !== 'ProjectV2Item'
    || typeof (node as { project?: { id?: unknown } }).project?.id !== 'string'
  ) {
    throw new Error('Triage-defaults Project item is missing or malformed');
  }
  // The item id came from a snapshot; this is what turns it back into proof
  // that the row about to be edited is the row for this very issue.
  const content = (node as {
    content?: {
      __typename?: unknown;
      number?: unknown;
      repository?: { nameWithOwner?: unknown } | null;
    } | null;
  }).content;
  if (
    content?.__typename !== 'Issue'
    || content.number !== action.issueNumber
    || String(content.repository?.nameWithOwner ?? '').toLowerCase() !== repo.toLowerCase()
  ) {
    throw new Error('Triage-defaults Project item does not belong to the named issue');
  }
  return {
    issueId: (issue as { id: string }).id,
    issueType: optionalSelectName((issue as { issueType?: unknown }).issueType, 'Issue Type'),
    projectId: (node as { project: { id: string } }).project.id,
    priority: optionalSelectName((node as { priority?: unknown }).priority, 'Priority'),
  };
}

/**
 * Issue Type node ids, from config where an operator pinned them and from the
 * organization's taxonomy otherwise. Cached for the life of the caller: these
 * ids name an org-wide taxonomy that does not change under a running daemon,
 * which is exactly why config is allowed to pin them statically. A rename that
 * did invalidate one fails the mutation loudly rather than writing the wrong
 * type.
 */
function createIssueTypeIdResolver(
  runner: CommandRunner,
  repo: string,
  projectMapping: ProjectMapping | undefined,
): (shape: NonNullable<TriageDefaultsAction['issueType']>) => Promise<string> {
  let discovered: Promise<ReadonlyMap<string, string>> | undefined;
  const discover = async (): Promise<ReadonlyMap<string, string>> => {
    const [owner] = splitRepo(repo);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await runner('gh', [
        'api', 'graphql', '-f', `query=${ISSUE_TYPES_QUERY}`, '-f', `owner=${owner}`,
      ])) as unknown;
    } catch {
      throw new Error(`Malformed Issue Type discovery for ${owner}`);
    }
    const nodes = (parsed as {
      data?: {
        organization?: {
          issueTypes?: { nodes?: readonly { id?: unknown; name?: unknown; isEnabled?: unknown }[] };
        } | null;
      };
    }).data?.organization?.issueTypes?.nodes ?? [];
    const byName = new Map<string, string>();
    for (const node of nodes) {
      if (
        node.isEnabled !== true
        || typeof node.name !== 'string'
        || typeof node.id !== 'string'
        || node.id.length === 0
      ) continue;
      // A duplicate enabled name makes the choice ambiguous; refuse rather
      // than pick one, exactly as the child repair's resolver does.
      if (byName.has(node.name)) byName.delete(node.name);
      else byName.set(node.name, node.id);
    }
    return byName;
  };
  return async (shape) => {
    const configured = projectMapping?.fields.type.options[shape];
    if (configured !== undefined && configured.length > 0) return configured;
    discovered ??= discover();
    const id = (await discovered).get(shape);
    if (id === undefined) {
      throw new Error(`No unique enabled Issue Type named ${shape} is available`);
    }
    return id;
  };
}

async function priorityOptionId(
  runner: CommandRunner,
  priority: NonNullable<TriageDefaultsAction['priority']>,
  projectMapping: ProjectMapping | undefined,
  projectOwner: string,
  projectNumber: number,
): Promise<{ readonly fieldId: string; readonly optionId: string }> {
  if (projectMapping !== undefined) {
    const key = priority.toLowerCase() as 'p0' | 'p1' | 'p2' | 'p3' | 'p4';
    return {
      fieldId: projectMapping.fields.priority.id,
      optionId: projectMapping.fields.priority.options[key],
    };
  }
  const fields = parseTriageFields(await runner('gh', [
    'project', 'field-list', String(projectNumber),
    '--owner', projectOwner,
    '--format', 'json',
  ]));
  const optionId = fields.priority.options[priority];
  if (optionId === undefined) {
    throw new Error(`Project Priority field carries no ${priority} option`);
  }
  return { fieldId: fields.priority.fieldId, optionId };
}

/**
 * Applies one issue's triage defaults, or reports why it did not.
 *
 * `applied` names what was written, in the exact shape the cycle log renders
 * (`triage-defaults issue:N: applied (type fix, priority P3)`). A gap that
 * closed underneath is refused and named; when every gap closed underneath
 * nothing was written and the action reports `skipped`, which is the right
 * answer — a human filling the field in IS the outcome this action wanted.
 */
export async function executeProductionTriageDefaults(
  action: TriageDefaultsAction,
  options: ProductionTriageDefaultsOptions = {},
): Promise<{
  readonly status: string;
  readonly detail?: string;
  readonly reason?: string;
}> {
  if (action.issueType === undefined && action.priority === undefined) {
    throw new Error('Triage-defaults action names no field to write');
  }
  const runner = options.runner ?? defaultRunner;
  const repo = options.repo ?? REPO;
  const projectOwner = options.projectOwner ?? ORG;
  const projectNumber = options.projectNumber ?? PROJECT_NUMBER;
  const resolveIssueTypeId = createIssueTypeIdResolver(runner, repo, options.projectMapping);
  const refresh = (): Promise<TriageDefaultsState> =>
    readTriageDefaultsState(runner, action, repo);

  let current = await refresh();
  const applied: string[] = [];
  const refused: string[] = [];

  if (action.issueType !== undefined) {
    if (current.issueType !== null) {
      refused.push(`Issue Type ${current.issueType} was set underneath`);
    } else {
      const typeId = await resolveIssueTypeId(action.issueType);
      current = await refresh();
      if (current.issueType !== null) {
        refused.push(`Issue Type ${current.issueType} was set underneath`);
      } else {
        await runner('gh', [
          'api',
          'graphql',
          '-f',
          `query=${UPDATE_ISSUE_TYPE_MUTATION}`,
          '-f',
          `issueId=${current.issueId}`,
          '-f',
          `typeId=${typeId}`,
        ]);
        applied.push(`type ${action.issueType}`);
      }
    }
  }

  if (action.priority !== undefined) {
    if (current.priority !== null) {
      refused.push(`Priority ${current.priority} was set underneath`);
    } else {
      const field = await priorityOptionId(
        runner,
        action.priority,
        options.projectMapping,
        projectOwner,
        projectNumber,
      );
      current = await refresh();
      if (current.priority !== null) {
        refused.push(`Priority ${current.priority} was set underneath`);
      } else {
        await runner('gh', [
          'project',
          'item-edit',
          '--id',
          action.projectItemId,
          '--project-id',
          current.projectId,
          '--field-id',
          field.fieldId,
          '--single-select-option-id',
          field.optionId,
        ]);
        applied.push(`priority ${action.priority}`);
      }
    }
  }

  if (applied.length === 0) {
    return { status: 'skipped', reason: refused.join('; ') };
  }
  // A write GitHub accepted but did not apply must never be reported as
  // applied: the next cycle would re-derive the identical gap with nothing in
  // the log to explain why it never closed.
  const final = await refresh();
  const unwritten = [
    applied.includes(`type ${action.issueType}`) && final.issueType === null
      ? 'Issue Type'
      : null,
    applied.includes(`priority ${action.priority}`) && final.priority === null
      ? 'Priority'
      : null,
  ].filter((value): value is string => value !== null);
  if (unwritten.length > 0) {
    throw new Error(
      `Triage-defaults final readback is incomplete: ${unwritten.join(', ')} still unset`,
    );
  }
  return {
    status: 'applied',
    detail: `${applied.join(', ')}${
      refused.length === 0 ? '' : ` (refused: ${refused.join('; ')})`
    }`,
  };
}
