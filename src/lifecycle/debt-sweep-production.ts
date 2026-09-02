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
import type { ProjectMapping } from '../config/config.js';
import {
  fileDebtSweep,
  type DebtSweepPort,
  type FileDebtSweepResult,
} from './debt-sweep.js';
import { makeProductionReviewFollowUpPort } from './review-follow-ups-production.js';
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
  return makeProductionReviewFollowUpPort({
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
}

function runtimeResult(result: FileDebtSweepResult): {
  readonly status: string;
  readonly detail?: string;
  readonly reason?: string;
} {
  if (result.status === 'already-open') {
    return { status: 'skipped', reason: `sweep-already-open:${result.number}` };
  }
  if (result.status === 'below-minimum') {
    // Not a failure: the cluster shrank between the snapshot and the filing.
    // A later cycle re-derives it from fresh state, or never does.
    return {
      status: 'skipped',
      reason: `sweep-below-minimum:${result.openMembers}`,
    };
  }
  return { status: 'filed', detail: `sweep:${result.number}` };
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
