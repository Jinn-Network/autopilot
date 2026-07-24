/**
 * Production ChildIssuePort backed by `gh issue` / `gh api` GraphQL.
 */

import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { REPO } from '../dispatcher/constants.js';
import { createProjectTriageApplier } from './project-triage.js';
import {
  CHILD_KINDS,
  parseChildMarker,
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
  let fixTypeIdPromise: Promise<string> | undefined;
  const resolveFixTypeId = (): Promise<string> => {
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
      if (matches.length !== 1 || typeof matches[0]?.id !== 'string'
        || matches[0].id.length === 0) {
        throw new Error(
          `Organization ${owner} must have exactly one enabled fix Issue Type`,
        );
      }
      return matches[0].id;
    })();
    return fixTypeIdPromise;
  };
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
