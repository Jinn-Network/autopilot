/**
 * Production ChildIssuePort backed by `gh issue` / `gh api` GraphQL.
 */

import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { REPO } from '../dispatcher/constants.js';
import { ORG, PROJECT_NUMBER } from '../dispatcher/constants.js';
import {
  EFFORT_PROJECT_NAME,
  PRIORITY_PROJECT_NAME,
  createProjectTriageApplier,
  parseItemAddId,
  parseTriageFields,
} from './project-triage.js';
import {
  CHILD_KINDS,
  parseChildMarker,
  resolveChildTriageExpectation,
  type ChildIssuePort,
  type ChildIssueRecord,
  type ChildKind,
} from './child-issues.js';
import type { ProjectMapping } from '../config/config.js';

/** Org-level Issue Type node id for `fix` (see file-issue gh-taxonomy). */
export const FIX_ISSUE_TYPE_ID = 'IT_kwDODh3-Ac4BvpyK';

const FIX_ISSUE_TYPE_QUERY = `
query($owner: String!) {
  organization(login: $owner) {
    issueTypes(first: 100) {
      nodes { id name isEnabled }
    }
  }
}
`;

const CHILD_LABEL_COLORS: Record<ChildKind, string> = {
  'review-finding': 'd4c5f9',
  reconcile: 'fbca04',
  'ci-failure': 'e11d21',
};

function parseCreatedIssueNumber(raw: string): number {
  const match = raw.trim().match(/\/issues\/(\d+)\s*$/);
  if (match !== null) {
    return Number(match[1]);
  }
  const asNumber = Number(raw.trim());
  if (Number.isSafeInteger(asNumber) && asNumber > 0) {
    return asNumber;
  }
  throw new Error(`Could not parse created issue number from: ${raw.trim()}`);
}

const UPDATE_ISSUE_TYPE_MUTATION = `
mutation($issueId: ID!, $typeId: ID!) {
  updateIssueIssueType(input: { issueId: $issueId, issueTypeId: $typeId }) {
    issue { number issueType { name } }
  }
}
`;

export interface ProductionChildIssuePortOptions {
  readonly runner?: CommandRunner;
  readonly repo?: string;
  readonly fixIssueTypeId?: string;
  readonly projectOwner?: string;
  readonly projectNumber?: number;
  readonly projectMapping?: ProjectMapping;
  /** Injectable only for bounded, eventually-consistent Project readbacks. */
  readonly wait?: (milliseconds: number) => Promise<void>;
}

const PROJECT_MEMBERSHIP_READBACK_ATTEMPTS = 5;
const PROJECT_MEMBERSHIP_READBACK_DELAY_MS = 250;

function productionWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

function createFixIssueTypeIdResolver(
  options: ProductionChildIssuePortOptions,
  runner: CommandRunner,
  repo: string,
): () => Promise<string> {
  let fixTypeIdPromise: Promise<string> | undefined;
  return () => {
    fixTypeIdPromise ??= (async () => {
      if (options.fixIssueTypeId !== undefined) {
        if (options.fixIssueTypeId.trim().length === 0) {
          throw new Error('Configured fix Issue Type ID must not be empty');
        }
        return options.fixIssueTypeId;
      }
      const owner = repo.split('/')[0];
      if (owner === undefined || owner.length === 0) {
        throw new Error(`Cannot resolve repository owner from '${repo}'`);
      }
      const raw = await runner('gh', [
        'api',
        'graphql',
        '-f',
        `query=${FIX_ISSUE_TYPE_QUERY}`,
        '-f',
        `owner=${owner}`,
      ]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        throw new Error(`Malformed Issue Type discovery for ${owner}`);
      }
      const organization = (
        parsed as {
          data?: {
            organization?: {
              issueTypes?: {
                nodes?: Array<{ id?: unknown; name?: unknown; isEnabled?: unknown }>;
              };
            } | null;
          };
        }
      ).data?.organization;
      const matches = organization?.issueTypes?.nodes?.filter((entry) => (
        entry.name === 'fix' && entry.isEnabled === true
      )) ?? [];
      if (
        matches.length !== 1
        || typeof matches[0]?.id !== 'string'
        || matches[0].id.length === 0
      ) {
        throw new Error(
          `Organization ${owner} must have exactly one enabled fix Issue Type`,
        );
      }
      return matches[0].id;
    })();
    return fixTypeIdPromise;
  };
}

export interface ProductionMachineChildRepairInput {
  readonly issueNumber: number;
  readonly parentPr: number;
  readonly childKind: ChildKind;
  readonly expectedType: 'fix';
  readonly expectedEffort: 'low' | 'medium' | 'high';
  readonly expectedPriority: 'p1' | 'p2';
}

interface MachineChildRepairState {
  readonly issueId: string;
  readonly issueType: string | null;
  readonly projectId: string;
  readonly item: {
    readonly id: string;
    readonly blockedOn: string | null;
    readonly effort: string | null;
    readonly priority: string | null;
  } | null;
}

const MACHINE_CHILD_REPAIR_STATE_QUERY = `
query MachineChildRepairState(
  $repositoryOwner: String!,
  $projectOwner: String!,
  $name: String!,
  $issueNumber: Int!,
  $projectNumber: Int!,
  $cursor: String
) {
  repository(owner: $repositoryOwner, name: $name) {
    issue(number: $issueNumber) {
      id
      state
      body
      issueType { name }
    }
  }
  organization(login: $projectOwner) {
    projectV2(number: $projectNumber) {
      id
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          content {
            __typename
            ... on Issue {
              number
              repository { nameWithOwner }
            }
          }
          blockedOn: fieldValueByName(name: "Blocked on") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          effort: fieldValueByName(name: "Effort") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          priority: fieldValueByName(name: "Priority") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
      }
    }
  }
}
`;

function optionalSelectName(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as { name?: unknown }).name === 'string'
  ) {
    return (value as { name: string }).name;
  }
  throw new Error(`Malformed machine-child repair ${label}`);
}

async function readMachineChildRepairState(
  runner: CommandRunner,
  input: ProductionMachineChildRepairInput,
  repo: string,
  projectOwner: string,
  projectNumber: number,
): Promise<MachineChildRepairState> {
  const [owner, name, ...unexpected] = repo.split('/');
  if (
    owner === undefined
    || owner.length === 0
    || name === undefined
    || name.length === 0
    || unexpected.length > 0
  ) {
    throw new Error('Machine-child repair repository must be owner/name');
  }
  let cursor: string | null = null;
  let issueRecord: Record<string, unknown> | null = null;
  let projectId: string | null = null;
  let item: MachineChildRepairState['item'] = null;
  for (let page = 1; page <= 100; page += 1) {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${MACHINE_CHILD_REPAIR_STATE_QUERY}`,
      '-F',
      `repositoryOwner=${owner}`,
      '-F',
      `projectOwner=${projectOwner}`,
      '-F',
      `name=${name}`,
      '-F',
      `issueNumber=${input.issueNumber}`,
      '-F',
      `projectNumber=${projectNumber}`,
      ...(cursor === null ? [] : ['-f', `cursor=${cursor}`]),
    ];
    let parsed: unknown;
    try {
      parsed = JSON.parse(await runner('gh', args)) as unknown;
    } catch {
      throw new Error('Malformed machine-child repair state readback');
    }
    const data = (parsed as {
      data?: {
        repository?: { issue?: unknown } | null;
        organization?: {
          projectV2?: {
            id?: unknown;
            items?: {
              pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
              nodes?: unknown;
            };
          } | null;
        } | null;
      };
    }).data;
    const rawIssue = data?.repository?.issue;
    const project = data?.organization?.projectV2;
    const nodes = project?.items?.nodes;
    const pageInfo = project?.items?.pageInfo;
    if (
      typeof rawIssue !== 'object'
      || rawIssue === null
      || Array.isArray(rawIssue)
      || typeof project?.id !== 'string'
      || !Array.isArray(nodes)
      || typeof pageInfo?.hasNextPage !== 'boolean'
    ) {
      throw new Error('Malformed machine-child repair state readback');
    }
    issueRecord = rawIssue as Record<string, unknown>;
    projectId = project.id;
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null || Array.isArray(node)) continue;
      const record = node as Record<string, unknown>;
      const content = record.content as {
        __typename?: unknown;
        number?: unknown;
        repository?: { nameWithOwner?: unknown } | null;
      } | null;
      if (
        content?.__typename !== 'Issue'
        || content.number !== input.issueNumber
        || content.repository?.nameWithOwner?.toString().toLowerCase() !== repo.toLowerCase()
      ) {
        continue;
      }
      if (typeof record.id !== 'string' || record.id.length === 0 || item !== null) {
        throw new Error('Machine-child repair Project item is ambiguous');
      }
      item = {
        id: record.id,
        blockedOn: optionalSelectName(record.blockedOn, 'Blocked on'),
        effort: optionalSelectName(record.effort, 'Effort'),
        priority: optionalSelectName(record.priority, 'Priority'),
      };
    }
    if (!pageInfo.hasNextPage) break;
    if (typeof pageInfo.endCursor !== 'string' || pageInfo.endCursor.length === 0) {
      throw new Error('Machine-child repair pagination cursor did not advance');
    }
    cursor = pageInfo.endCursor;
    if (page === 100) throw new Error('Machine-child repair pagination exceeded safety limit');
  }
  if (issueRecord === null || projectId === null) {
    throw new Error('Machine-child repair state is unavailable');
  }
  if (
    typeof issueRecord.id !== 'string'
    || issueRecord.id.length === 0
    || issueRecord.state !== 'OPEN'
    || typeof issueRecord.body !== 'string'
  ) {
    throw new Error('Machine-child repair issue is missing, closed, or malformed');
  }
  const marker = parseChildMarker(issueRecord.body);
  if (
    marker === null
    || marker.parentPr !== input.parentPr
    || marker.kind !== input.childKind
  ) {
    throw new Error('Machine-child repair action contradicts the authoritative child marker');
  }
  const liveExpectation = resolveChildTriageExpectation(issueRecord.body, marker.kind);
  if (
    liveExpectation === null
    || liveExpectation.issueType !== input.expectedType
    || liveExpectation.effort !== input.expectedEffort
    || liveExpectation.priority !== input.expectedPriority
  ) {
    throw new Error('Machine-child repair live child triage intent contradicts the action');
  }
  const issueType = optionalSelectName(issueRecord.issueType, 'Issue Type');
  return {
    issueId: issueRecord.id,
    issueType,
    projectId,
    item,
  };
}

function assertMatchingRepairState(
  state: MachineChildRepairState,
  input: ProductionMachineChildRepairInput,
): void {
  const expectedEffort = EFFORT_PROJECT_NAME[input.expectedEffort];
  const expectedPriority = PRIORITY_PROJECT_NAME[input.expectedPriority];
  const contradictions = [
    state.issueType !== null
      && state.issueType.toLowerCase() !== input.expectedType
      ? `Issue Type=${state.issueType}, expected ${input.expectedType}`
      : null,
    state.item?.blockedOn !== null
      && state.item?.blockedOn !== undefined
      && state.item.blockedOn !== 'Nothing'
      ? `Blocked on=${state.item.blockedOn}, expected Nothing`
      : null,
    state.item?.effort !== null
      && state.item?.effort !== undefined
      && state.item.effort !== expectedEffort
      ? `Effort=${state.item.effort}, expected ${expectedEffort}`
      : null,
    state.item?.priority !== null
      && state.item?.priority !== undefined
      && state.item.priority !== expectedPriority
      ? `Priority=${state.item.priority}, expected ${expectedPriority}`
      : null,
  ].filter((value): value is string => value !== null);
  if (contradictions.length > 0) {
    throw new Error(`Machine-child repair found contradictory triage: ${contradictions.join('; ')}`);
  }
}

function machineChildRepairComplete(
  state: MachineChildRepairState,
  input: ProductionMachineChildRepairInput,
): boolean {
  return (
    state.issueType?.toLowerCase() === input.expectedType
    && state.item?.blockedOn === 'Nothing'
    && state.item.effort === EFFORT_PROJECT_NAME[input.expectedEffort]
    && state.item.priority === PRIORITY_PROJECT_NAME[input.expectedPriority]
  );
}

export async function repairProductionMachineChild(
  options: ProductionChildIssuePortOptions,
  input: ProductionMachineChildRepairInput,
): Promise<{ readonly status: 'repaired' | 'already-complete' }> {
  const runner = options.runner ?? defaultRunner;
  const repo = options.repo ?? REPO;
  const projectOwner = options.projectOwner ?? ORG;
  const projectNumber = options.projectNumber ?? PROJECT_NUMBER;
  const wait = options.wait ?? productionWait;
  const resolveFixTypeId = createFixIssueTypeIdResolver(options, runner, repo);
  let current = await readMachineChildRepairState(
    runner,
    input,
    repo,
    projectOwner,
    projectNumber,
  );
  assertMatchingRepairState(current, input);
  const expectedEffort = EFFORT_PROJECT_NAME[input.expectedEffort];
  const expectedPriority = PRIORITY_PROJECT_NAME[input.expectedPriority];
  if (machineChildRepairComplete(current, input)) return { status: 'already-complete' };
  const refresh = async (): Promise<MachineChildRepairState> => {
    const state = await readMachineChildRepairState(
      runner,
      input,
      repo,
      projectOwner,
      projectNumber,
    );
    assertMatchingRepairState(state, input);
    return state;
  };

  if (current.issueType === null) {
    const typeId = await resolveFixTypeId();
    current = await refresh();
    if (current.issueType === null) {
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
    }
  }

  const fields = options.projectMapping === undefined
    ? parseTriageFields(await runner('gh', [
        'project',
        'field-list',
        String(projectNumber),
        '--owner',
        projectOwner,
        '--format',
        'json',
      ]), current.projectId)
    : {
        projectId: options.projectMapping.id,
        blockedOn: {
          fieldId: options.projectMapping.fields.blockedOn.id,
          nothingOptionId: options.projectMapping.fields.blockedOn.options.nothing,
        },
        effort: {
          fieldId: options.projectMapping.fields.effort.id,
          options: {
            Low: options.projectMapping.fields.effort.options.low,
            Medium: options.projectMapping.fields.effort.options.medium,
            High: options.projectMapping.fields.effort.options.high,
            XHigh: options.projectMapping.fields.effort.options.xhigh,
            Max: options.projectMapping.fields.effort.options.max,
          },
        },
        priority: {
          fieldId: options.projectMapping.fields.priority.id,
          options: {
            P0: options.projectMapping.fields.priority.options.p0,
            P1: options.projectMapping.fields.priority.options.p1,
            P2: options.projectMapping.fields.priority.options.p2,
            P3: options.projectMapping.fields.priority.options.p3,
            P4: options.projectMapping.fields.priority.options.p4,
          },
        },
      };

  current = await refresh();
  if (current.item === null) {
    const added = parseItemAddId(await runner('gh', [
      'project',
      'item-add',
      String(projectNumber),
      '--owner',
      projectOwner,
      '--url',
      `https://github.com/${repo}/issues/${input.issueNumber}`,
      '--format',
      'json',
    ]));
    for (let attempt = 0; attempt < PROJECT_MEMBERSHIP_READBACK_ATTEMPTS; attempt += 1) {
      current = await refresh();
      if (current.item !== null) {
        if (current.item.id !== added) {
          throw new Error('Machine-child repair Project membership readback is ambiguous');
        }
        break;
      }
      if (attempt + 1 < PROJECT_MEMBERSHIP_READBACK_ATTEMPTS) {
        await wait(PROJECT_MEMBERSHIP_READBACK_DELAY_MS);
      }
    }
    if (current.item === null) {
      throw new Error('Machine-child repair Project membership readback is ambiguous');
    }
  }

  const edits = [
    {
      value: (state: MachineChildRepairState) => state.item?.blockedOn,
      expected: 'Nothing',
      fieldId: fields.blockedOn.fieldId,
      optionId: fields.blockedOn.nothingOptionId,
    },
    {
      value: (state: MachineChildRepairState) => state.item?.effort,
      expected: expectedEffort,
      fieldId: fields.effort.fieldId,
      optionId: fields.effort.options[expectedEffort],
    },
    {
      value: (state: MachineChildRepairState) => state.item?.priority,
      expected: expectedPriority,
      fieldId: fields.priority.fieldId,
      optionId: fields.priority.options[expectedPriority],
    },
  ];
  for (const edit of edits) {
    current = await refresh();
    if (current.item === null) {
      throw new Error('Machine-child repair Project item disappeared before field mutation');
    }
    const value = edit.value(current);
    if (value === edit.expected) continue;
    if (value !== null) {
      throw new Error('Machine-child repair field state changed before mutation');
    }
    if (edit.optionId === undefined) {
      throw new Error('Machine-child repair configured triage option is unavailable');
    }
    await runner('gh', [
      'project',
      'item-edit',
      '--id',
      current.item.id,
      '--project-id',
      fields.projectId,
      '--field-id',
      edit.fieldId,
      '--single-select-option-id',
      edit.optionId,
    ]);
  }
  current = await refresh();
  if (!machineChildRepairComplete(current, input)) {
    throw new Error('Machine-child repair final readback is incomplete');
  }
  return { status: 'repaired' };
}

function parseIssueList(raw: string): readonly {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly labels: readonly string[];
}[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Malformed child-issue list readback');
  }
  if (!Array.isArray(parsed)) throw new Error('Malformed child-issue list readback');
  return parsed.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('Malformed child-issue list entry');
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.number !== 'number'
      || typeof record.title !== 'string'
      || typeof record.body !== 'string'
      || typeof record.state !== 'string'
      || !Array.isArray(record.labels)
    ) {
      throw new Error('Malformed child-issue list entry fields');
    }
    const labels = record.labels.map((label) => {
      if (typeof label === 'string') return label;
      if (
        typeof label === 'object'
        && label !== null
        && typeof (label as { name?: unknown }).name === 'string'
      ) {
        return (label as { name: string }).name;
      }
      throw new Error('Malformed child-issue label');
    });
    return {
      number: record.number,
      title: record.title,
      body: record.body,
      state: record.state.toLowerCase(),
      labels,
    };
  });
}

function toChildRecord(
  entry: {
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly state: string;
    readonly labels: readonly string[];
  },
): ChildIssueRecord | null {
  const marker = parseChildMarker(entry.body);
  if (marker === null) return null;
  if (entry.state !== 'open' && entry.state !== 'closed') return null;
  return {
    number: entry.number,
    title: entry.title,
    body: entry.body,
    state: entry.state,
    labels: entry.labels,
    parentPr: marker.parentPr,
    kind: marker.kind,
  };
}

export function makeProductionChildIssuePort(
  options: ProductionChildIssuePortOptions = {},
): ChildIssuePort {
  const runner = options.runner ?? defaultRunner;
  const repo = options.repo ?? REPO;
  const resolveFixTypeId = createFixIssueTypeIdResolver(options, runner, repo);
  const triageApplier = createProjectTriageApplier(runner, {
    repo,
    projectOwner: options.projectOwner,
    projectNumber: options.projectNumber,
    projectMapping: options.projectMapping,
  });

  const ensureChildKindLabel = async (label: string): Promise<void> => {
    if (!CHILD_KINDS.includes(label as ChildKind)) return;
    try {
      await runner('gh', [
        'label',
        'create',
        label,
        '--repo',
        repo,
        '--color',
        CHILD_LABEL_COLORS[label as ChildKind],
        '--description',
        `Autopilot machine child: ${label}`,
      ]);
    } catch {
      // The label may already exist or creation may be denied. Filing still proceeds.
    }
  };

  const listOpen = async (): Promise<readonly ChildIssueRecord[]> => {
    const raw = await runner('gh', [
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--limit',
      '200',
      '--json',
      'number,title,body,state,labels',
    ]);
    return parseIssueList(raw)
      .map(toChildRecord)
      .filter((entry): entry is ChildIssueRecord => entry !== null);
  };

  const listAllForParent = async (
    parentPr: number,
    kind: ChildKind,
  ): Promise<readonly ChildIssueRecord[]> => {
    // Search both open and closed so runaway counting and close sweeps work.
    const [openRaw, closedRaw] = await Promise.all([
      runner('gh', [
        'issue',
        'list',
        '--repo',
        repo,
        '--state',
        'open',
        '--limit',
        '200',
        '--json',
        'number,title,body,state,labels',
      ]),
      runner('gh', [
        'issue',
        'list',
        '--repo',
        repo,
        '--state',
        'closed',
        '--limit',
        '200',
        '--json',
        'number,title,body,state,labels',
      ]),
    ]);
    const markerNeedle = `pr=${parentPr} kind=${kind}`;
    return [...parseIssueList(openRaw), ...parseIssueList(closedRaw)]
      .map(toChildRecord)
      .filter((entry): entry is ChildIssueRecord => (
        entry !== null
        && entry.parentPr === parentPr
        && entry.kind === kind
        && entry.body.includes(markerNeedle)
      ));
  };

  return {
    async searchOpenByMarker(marker) {
      const open = await listOpen();
      return open.filter((issue) => issue.body.includes(marker));
    },

    async listByParentAndKind(parentPr, kind) {
      if (!CHILD_KINDS.includes(kind)) {
        throw new Error(`Invalid child kind: ${kind}`);
      }
      return listAllForParent(parentPr, kind);
    },

    async createIssue(input) {
      // Resolve repository-scoped taxonomy before any label or issue mutation.
      await resolveFixTypeId();
      const baseArgs = [
        'issue',
        'create',
        '--repo',
        repo,
        '--title',
        input.title,
        '--body',
        input.body,
      ];
      for (const label of input.labels) {
        await ensureChildKindLabel(label);
      }
      const withLabels = [...baseArgs];
      for (const label of input.labels) {
        withLabels.push('--label', label);
      }
      try {
        const raw = await runner('gh', withLabels);
        return { number: parseCreatedIssueNumber(raw) };
      } catch {
        const marker = parseChildMarker(input.body);
        if (marker !== null) {
          const existing = (await listOpen()).find((issue) => (
            issue.parentPr === marker.parentPr && issue.kind === marker.kind
          ));
          if (existing !== undefined) {
            return { number: existing.number };
          }
        }
        const raw = await runner('gh', baseArgs);
        const created = { number: parseCreatedIssueNumber(raw) };
        for (const label of input.labels) {
          try {
            await runner('gh', [
              'issue',
              'edit',
              String(created.number),
              '--repo',
              repo,
              '--add-label',
              label,
            ]);
          } catch {
            // The structured marker is authoritative; labels are best effort.
          }
        }
        return created;
      }
    },

    async setIssueTypeFix(issueNumber) {
      const fixTypeId = await resolveFixTypeId();
      const idRaw = await runner('gh', [
        'issue',
        'view',
        String(issueNumber),
        '--repo',
        repo,
        '--json',
        'id',
        '--jq',
        '.id',
      ]);
      const issueId = idRaw.trim();
      if (issueId.length === 0) {
        throw new Error(`Missing node id for issue #${issueNumber}`);
      }
      await runner('gh', [
        'api',
        'graphql',
        '-f',
        `query=${UPDATE_ISSUE_TYPE_MUTATION}`,
        '-f',
        `issueId=${issueId}`,
        '-f',
        `typeId=${fixTypeId}`,
      ]);
    },

    async ensureTriageComplete(input) {
      await triageApplier.applyMachineTriage({
        issueNumber: input.issueNumber,
        effort: input.effort,
        priority: input.priority,
      });
    },

    async closeIssue(issueNumber, comment) {
      await runner('gh', [
        'issue',
        'close',
        String(issueNumber),
        '--repo',
        repo,
        '--comment',
        comment,
      ]);
    },
  };
}
