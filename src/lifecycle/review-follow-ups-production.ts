/**
 * Production ReviewFollowUpPort — ordinary triage-complete issues, not children.
 */

import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { REPO } from '../dispatcher/constants.js';
import type { ProjectMapping } from '../config/config.js';
import { FIX_ISSUE_TYPE_ID } from './child-issues-production.js';
import { createProjectTriageApplier } from './project-triage.js';
import {
  formatReviewFollowUpMarkerKey,
  type OpenReviewFollowUp,
  type ReviewFollowUpPort,
  type ReviewFollowUpType,
} from './review-follow-ups.js';

/**
 * Open-issue read cap for follow-up dedup. `--limit` is a cap rather than a
 * fetch size, so reading generously is free on a smaller repository and a
 * full page means the answer was cut short rather than complete.
 */
const FOLLOW_UP_LIST_LIMIT = 1000;

/** Org-level Issue Type node ids (see file-issue gh-taxonomy). */
export const CHORE_ISSUE_TYPE_ID = 'IT_kwDODh3-Ac4BvpyJ';
export const FEAT_ISSUE_TYPE_ID = 'IT_kwDODh3-Ac4BvpyL';
export const REFACTOR_ISSUE_TYPE_ID = 'IT_kwDODh3-Ac4CAgNe';

const ISSUE_TYPE_IDS: Record<ReviewFollowUpType, string> = {
  chore: CHORE_ISSUE_TYPE_ID,
  fix: FIX_ISSUE_TYPE_ID,
  feat: FEAT_ISSUE_TYPE_ID,
  refactor: REFACTOR_ISSUE_TYPE_ID,
};

const UPDATE_ISSUE_TYPE_MUTATION = `
mutation($issueId: ID!, $typeId: ID!) {
  updateIssueIssueType(input: { issueId: $issueId, issueTypeId: $typeId }) {
    issue { number issueType { name } }
  }
}
`;

interface OpenIssueRow {
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

export interface ProductionReviewFollowUpPortOptions {
  readonly runner?: CommandRunner;
  readonly repo?: string;
  readonly issueTypeIds?: Partial<Record<ReviewFollowUpType, string>>;
  /**
   * Project coordinates for the triage applier. A review session omits them and
   * gets the ORG/PROJECT_NUMBER defaults plus a `field-list` read, exactly as
   * before. The engine, which files debt sweeps through this same port (#126),
   * already holds a resolved mapping and passes it, so no field read is made.
   */
  readonly projectOwner?: string;
  readonly projectNumber?: number;
  readonly projectMapping?: ProjectMapping;
}

export function parseIssueList(raw: string): readonly {
  readonly number: number;
  readonly title: string;
  readonly body: string;
}[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Malformed review-follow-up list readback');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Malformed review-follow-up list readback');
  }
  return parsed.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('Malformed review-follow-up list entry');
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.number !== 'number'
      || typeof record.body !== 'string'
      || typeof record.title !== 'string'
    ) {
      throw new Error('Malformed review-follow-up list entry fields');
    }
    return {
      number: record.number,
      title: record.title,
      body: record.body,
    };
  });
}

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

async function listOpenIssues(
  runner: CommandRunner,
  repo: string,
): Promise<readonly OpenIssueRow[]> {
  const raw = await runner('gh', [
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--limit',
    String(FOLLOW_UP_LIST_LIMIT),
    '--json',
    'number,title,body',
  ]);
  return parseIssueList(raw);
}

/**
 * Reads the follow-ups already open against one parent PR, for the review
 * session's prompt context (#124).
 *
 * Deliberately *not* the filing port's `searchOpenByMarker`, despite doing the
 * same listing and the same substring match. That read backs dedup, where a
 * truncated page files a duplicate, so it refuses one. This read backs a
 * prompt hint that runs at session-spawn time: refusing here would take the
 * whole review lane down over an open-issue count, while an incomplete hint is
 * strictly better than none and the filing path still fails closed on the same
 * condition moments later. So truncation is tolerated here and only here.
 */
export function makeProductionOpenReviewFollowUpReader(
  options: Pick<ProductionReviewFollowUpPortOptions, 'runner' | 'repo'> = {},
): (parentPr: number) => Promise<readonly OpenReviewFollowUp[]> {
  const runner = options.runner ?? defaultRunner;
  const repo = options.repo ?? REPO;
  return async (parentPr) => {
    const key = formatReviewFollowUpMarkerKey(parentPr);
    const open = await listOpenIssues(runner, repo);
    return open
      .filter((issue) => issue.body.includes(key))
      .map((issue) => ({ number: issue.number, title: issue.title }));
  };
}

export function makeProductionReviewFollowUpPort(
  options: ProductionReviewFollowUpPortOptions = {},
): ReviewFollowUpPort {
  const runner = options.runner ?? defaultRunner;
  const repo = options.repo ?? REPO;
  const issueTypeIds: Record<ReviewFollowUpType, string> = {
    ...ISSUE_TYPE_IDS,
    ...options.issueTypeIds,
  };
  const triageApplier = createProjectTriageApplier(runner, {
    repo,
    ...(options.projectOwner === undefined
      ? {}
      : { projectOwner: options.projectOwner }),
    ...(options.projectNumber === undefined
      ? {}
      : { projectNumber: options.projectNumber }),
    ...(options.projectMapping === undefined
      ? {}
      : { projectMapping: options.projectMapping }),
  });
  let openIssuesCache: readonly OpenIssueRow[] | undefined;

  const loadOpenIssues = async (): Promise<readonly OpenIssueRow[]> => {
    if (openIssuesCache !== undefined) return openIssuesCache;
    const rows = await listOpenIssues(runner, repo);
    // Backs follow-up dedup: a truncated read files a duplicate follow-up.
    if (rows.length >= FOLLOW_UP_LIST_LIMIT) {
      throw new Error(
        `Open follow-up issue listing reached its ${FOLLOW_UP_LIST_LIMIT}-item `
        + 'limit; refusing a potentially truncated set',
      );
    }
    openIssuesCache = rows;
    return openIssuesCache;
  };

  return {
    async searchOpenByMarker(marker) {
      const open = await loadOpenIssues();
      return open
        .filter((issue) => issue.body.includes(marker))
        .map((issue) => ({ number: issue.number, title: issue.title }));
    },

    async createIssue(input) {
      const raw = await runner('gh', [
        'issue',
        'create',
        '--repo',
        repo,
        '--title',
        input.title,
        '--body',
        input.body,
      ]);
      return { number: parseCreatedIssueNumber(raw) };
    },

    async ensureTriageComplete(input) {
      const typeId = issueTypeIds[input.type];
      const idRaw = await runner('gh', [
        'issue',
        'view',
        String(input.issueNumber),
        '--repo',
        repo,
        '--json',
        'id',
        '--jq',
        '.id',
      ]);
      const issueId = idRaw.trim();
      if (issueId.length === 0) {
        throw new Error(`Missing node id for issue #${input.issueNumber}`);
      }
      await runner('gh', [
        'api',
        'graphql',
        '-f',
        `query=${UPDATE_ISSUE_TYPE_MUTATION}`,
        '-f',
        `issueId=${issueId}`,
        '-f',
        `typeId=${typeId}`,
      ]);

      await triageApplier.applyMachineTriage({
        issueNumber: input.issueNumber,
        effort: input.effort,
        priority: input.priority,
      });
    },
  };
}
