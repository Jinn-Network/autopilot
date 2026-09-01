/**
 * Shared authority for dependency stacks (issue #114).
 *
 * Dependency stacking is a *designed* dispatcher feature: `resolveStackReady`
 * (`src/dispatcher/stack-readiness.ts`, spec 2026-07-13-eng-loop-dependency-
 * stacking) admits an issue whose single unmerged blocker already has an open
 * pull request and stamps `stackBase` so the dependent's PR is created on that
 * blocker's head branch. The lifecycle never inherited the concept and met a
 * stacked PR only as something to refuse — mono #3437 (head `autopilot/3219`,
 * base `autopilot/3218`, stacked by design on #3424) made its review-finding
 * child #3462 permanently ineligible under "parent is retargeted".
 *
 * Division of labour, deliberately narrow:
 *  - `resolveStackReady` decides **admission and base selection** — may this
 *    issue dispatch, and onto which branch.
 *  - this module decides **validity of an existing base** — does the base a
 *    pull request already carries still reach the default branch through open
 *    pull requests.
 *
 * Both express the same rule set; neither owns the other's decision, so this
 * module imports nothing from the dispatcher and the dispatcher imports
 * nothing from here. It is pure: every input is an argument, so it is
 * unit-testable without `gh`, `git`, or a snapshot.
 *
 * Out of scope, unchanged from the 2026-07-13 spec: multi-parent stacking.
 * Also unchanged: the merge-queue enqueue gate still refuses every non-`root`
 * pull request, because the queue exists only on the default branch and
 * GitHub retargets children automatically when a root merges.
 */

/**
 * - `root`           the base is the default branch.
 * - `stacked-valid`  the base chain terminates at the default branch, or at a
 *                    pull request that already merged (its work landed and
 *                    GitHub's own retargeting will follow).
 * - `stacked-broken` the chain reaches a closed pull request, a ref no open
 *                    pull request owns, or a cycle. This is the abandoned-base
 *                    case `resolveStackReady` refuses at admission time.
 */
export type StackVerdict = 'root' | 'stacked-valid' | 'stacked-broken';

/**
 * The only pull-request facts a chain walk reads. `PullRequestSnapshot`
 * structurally satisfies this, so callers pass their snapshots directly and
 * the walk costs zero extra API calls.
 *
 * `state` defaults to `OPEN`; only open pull requests own a ref for the
 * purpose of continuing a chain. `draft` is accepted because callers carry it
 * and the enqueue gate reads it, but it never changes a verdict: a draft root
 * is still a valid terminus for everything stacked above it.
 */
export interface StackChainPullRequest {
  readonly number: number;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly draft?: boolean;
  readonly state?: 'OPEN' | 'MERGED' | 'CLOSED';
}

export interface StackChainRecord {
  readonly verdict: StackVerdict;
  /** Open ancestors walked through, nearest first. Empty for a root. */
  readonly ancestors: readonly number[];
  /**
   * Bottom-most *open* pull request of the chain — the one that must land
   * first. The subject itself when it has no open ancestors. Absent when the
   * chain is broken, because a broken chain has no landing order.
   */
  readonly rootPr?: number;
  /** The ref at which the chain stops reaching the default branch. */
  readonly brokenAtRef?: string;
}

/**
 * Two open pull requests may report the same head ref (a race, a reopened PR,
 * a fork pushing the same branch name). The chain walk must still be a
 * function of the snapshot, so the tie is broken by **lowest pull request
 * number**: it is total, deterministic, and stable across cycles, and the
 * older PR is the one that created the branch the newer one collided with.
 * A verdict that flipped with listing order would be worse than either choice.
 */
function ownersByHeadRef(
  pullRequests: readonly StackChainPullRequest[],
): Map<string, StackChainPullRequest> {
  const byRef = new Map<string, StackChainPullRequest>();
  for (const pullRequest of pullRequests) {
    if ((pullRequest.state ?? 'OPEN') !== 'OPEN') continue;
    const prior = byRef.get(pullRequest.headRefName);
    if (prior === undefined || pullRequest.number < prior.number) {
      byRef.set(pullRequest.headRefName, pullRequest);
    }
  }
  return byRef;
}

function mergedHeadRefs(
  pullRequests: readonly StackChainPullRequest[],
): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const pullRequest of pullRequests) {
    if (pullRequest.state === 'MERGED') refs.add(pullRequest.headRefName);
  }
  return refs;
}

/**
 * Walk every pull request's base chain once and return its verdict.
 *
 * The walk is `base ref → open PR owning that ref as head → its base ref → …`
 * and terminates on three conditions: the default branch (valid), a ref no
 * open pull request owns (merged owner = valid terminus, anything else =
 * broken), or a ref already visited on this walk. The visited-set guard is
 * what makes an arbitrarily deep chain and a cyclic ref graph both terminate —
 * the same shape `targeted-action-reader.ts` uses for its base-chain hydration.
 *
 * Nothing here is persisted. Verdicts are recomputed from live state every
 * cycle, which is the whole machine exit: when a root merges, GitHub retargets
 * its children onto the default branch, the next recomputation reads `root`,
 * and everything stacked above releases with no operator step.
 */
export function resolveStackChains(
  pullRequests: readonly StackChainPullRequest[],
  defaultBranch: string,
): Map<number, StackChainRecord> {
  const owners = ownersByHeadRef(pullRequests);
  const merged = mergedHeadRefs(pullRequests);
  const out = new Map<number, StackChainRecord>();

  for (const subject of pullRequests) {
    if (subject.baseRefName === defaultBranch) {
      out.set(subject.number, {
        verdict: 'root',
        ancestors: [],
        rootPr: subject.number,
      });
      continue;
    }

    const ancestors: number[] = [];
    const seenRefs = new Set<string>([subject.headRefName]);
    let base = subject.baseRefName;
    let record: StackChainRecord | undefined;

    for (;;) {
      if (seenRefs.has(base)) {
        // A cycle in the ref graph, or a pull request based on its own head.
        record = { verdict: 'stacked-broken', ancestors: [], brokenAtRef: base };
        break;
      }
      seenRefs.add(base);
      const owner = owners.get(base);
      if (owner === undefined) {
        record = merged.has(base)
          // The owning pull request already merged: its work is in the target
          // and GitHub's retargeting will move this one. A valid terminus.
          ? {
              verdict: 'stacked-valid',
              ancestors: [...ancestors],
              rootPr: ancestors.at(-1) ?? subject.number,
            }
          : { verdict: 'stacked-broken', ancestors: [], brokenAtRef: base };
        break;
      }
      ancestors.push(owner.number);
      if (owner.baseRefName === defaultBranch) {
        record = {
          verdict: 'stacked-valid',
          ancestors: [...ancestors],
          rootPr: owner.number,
        };
        break;
      }
      base = owner.baseRefName;
    }

    out.set(subject.number, record);
  }

  return out;
}

/** Operator-facing detail naming exactly where the chain stops. */
export function describeStackBreak(
  prNumber: number,
  record: StackChainRecord,
): string {
  return `Parent pull request #${prNumber} sits on a broken dependency stack: `
    + `no open pull request owns base branch ${record.brokenAtRef ?? '(unknown)'}`;
}
