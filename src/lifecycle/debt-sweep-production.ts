/**
 * Production debt-sweep filing (#126).
 *
 * The GitHub surface a sweep needs is exactly the one review follow-ups
 * already use: one listing of open issues, a substring match over their bodies,
 * `gh issue create`, an Issue Type mutation, and Project triage. So the port is
 * that port, deliberately — including its refusal of a truncated listing, which
 * backs sweep dedup for the same reason it backs follow-up dedup: a listing cut
 * short cannot prove there is no open sweep, and filing a second one is not a
 * recoverable mistake.
 *
 * Both of `fileDebtSweep`'s reads (the sweep key and the follow-up key) hit
 * that single cached listing, so a whole filing costs one `gh issue list`.
 */

import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { REPO } from '../dispatcher/constants.js';
import type { ProjectMapping } from '../config/config.js';
import {
  fileDebtSweep,
  type ClosedDebtSweepIssue,
  type DebtSweepPort,
  type FileDebtSweepResult,
  type MergedSweepPullRequest,
} from './debt-sweep.js';
import {
  makeProductionReviewFollowUpPort,
  parseIssueList,
} from './review-follow-ups-production.js';

/**
 * How far back the closed-sweep read looks (#154). Closed issues are unbounded,
 * so this is a window over the most recently updated ones, sized so a sweep
 * closed within the last few days of an active repository is inside it. A
 * duplicate outside the window is the pre-#154 behaviour, not a new failure.
 */
const CLOSED_SWEEP_LIST_LIMIT = 200;
import type { NewWorkAction } from './types.js';

export interface ProductionDebtSweepOptions {
  readonly runner?: CommandRunner;
  readonly repo?: string;
  readonly projectOwner?: string;
  readonly projectNumber?: number;
  readonly projectMapping?: ProjectMapping;
  readonly choreIssueTypeId?: string;
}

export function makeProductionDebtSweepPort(
  options: ProductionDebtSweepOptions = {},
): DebtSweepPort {
  const runner = options.runner ?? defaultRunner;
  const repo = options.repo ?? REPO;
  const followUps = makeProductionReviewFollowUpPort({
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(options.repo === undefined ? {} : { repo: options.repo }),
    ...(options.projectOwner === undefined
      ? {}
      : { projectOwner: options.projectOwner }),
    ...(options.projectNumber === undefined
      ? {}
      : { projectNumber: options.projectNumber }),
    ...(options.projectMapping === undefined
      ? {}
      : { projectMapping: options.projectMapping }),
    ...(options.choreIssueTypeId === undefined
      ? {}
      : { issueTypeIds: { chore: options.choreIssueTypeId } }),
  });
  return {
    ...followUps,
    async searchClosedByMarker(marker): Promise<readonly ClosedDebtSweepIssue[]> {
      const raw = await runner('gh', [
        'issue',
        'list',
        '--repo',
        repo,
        '--state',
        'closed',
        '--search',
        'sort:updated-desc',
        '--limit',
        String(CLOSED_SWEEP_LIST_LIMIT),
        '--json',
        'number,title,body',
      ]);
      return parseIssueList(raw)
        .filter((issue) => issue.body.includes(marker))
        .map((issue) => ({ number: issue.number, body: issue.body }));
    },
    async mergedClosingPullRequest(issueNumber): Promise<MergedSweepPullRequest | null> {
      const raw = await runner('gh', [
        'issue',
        'view',
        String(issueNumber),
        '--repo',
        repo,
        '--json',
        'closedByPullRequestsReferences',
      ]);
      for (const prNumber of parseClosingPullRequestNumbers(raw)) {
        const pr = await runner('gh', [
          'pr',
          'view',
          String(prNumber),
          '--repo',
          repo,
          '--json',
          'number,mergedAt,body',
        ]);
        const merged = parseMergedPullRequest(pr);
        if (merged !== null) return merged;
      }
      return null;
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

function parseClosingPullRequestNumbers(raw: string): readonly number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Could not parse closing pull request references');
  }
  const references = (parsed as { closedByPullRequestsReferences?: unknown })
    .closedByPullRequestsReferences;
  if (!Array.isArray(references)) return [];
  return references.flatMap((reference) => {
    const number = (reference as { number?: unknown }).number;
    return typeof number === 'number' && Number.isSafeInteger(number) && number > 0
      ? [number]
      : [];
  });
}

function parseMergedPullRequest(raw: string): MergedSweepPullRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Could not parse pull request view');
  }
  const pr = parsed as { number?: unknown; mergedAt?: unknown; body?: unknown };
  if (typeof pr.mergedAt !== 'string' || pr.mergedAt.length === 0) return null;
  if (typeof pr.number !== 'number') return null;
  return { number: pr.number, body: typeof pr.body === 'string' ? pr.body : '' };
}

function runtimeResult(result: FileDebtSweepResult): {
  readonly status: string;
  readonly detail?: string;
  readonly reason?: string;
} {
  if (result.status === 'already-open') {
    return { status: 'skipped', reason: `sweep-already-open:${result.number}` };
  }
  const closed = (members: readonly number[] | undefined): string => (
    members === undefined || members.length === 0 ? '' : ` closed=${members.join(',')}`
  );
  if (result.status === 'already-swept') {
    return {
      status: 'skipped',
      reason: `sweep-already-swept:${result.number}`,
      detail: `closed=${result.closedMembers.join(',') || '-'} declined=${result.declinedMembers.join(',') || '-'}`,
    };
  }
  if (result.status === 'below-minimum') {
    // Not a failure: the cluster shrank between the snapshot and the filing.
    // A later cycle re-derives it from fresh state, or never does.
    return {
      status: 'skipped',
      reason: `sweep-below-minimum:${result.openMembers}`,
      ...(closed(result.closedMembers) === '' ? {} : { detail: closed(result.closedMembers).trim() }),
    };
  }
  return { status: 'filed', detail: `sweep:${result.number}${closed(result.closedMembers)}` };
}

export async function executeProductionFileDebtSweep(
  action: Extract<NewWorkAction, { kind: 'file-debt-sweep' }>,
  options: ProductionDebtSweepOptions & {
    readonly port?: DebtSweepPort;
  } = {},
): Promise<{
  readonly status: string;
  readonly detail?: string;
  readonly reason?: string;
}> {
  const port = options.port ?? makeProductionDebtSweepPort(options);
  return runtimeResult(await fileDebtSweep(port, {
    parentPr: action.parentPr,
    members: action.members,
  }));
}
