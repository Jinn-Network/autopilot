import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeStackBreak,
  resolveStackChains,
  type StackChainPullRequest,
} from '../../src/lifecycle/stack-authority.js';
import {
  composeGitHubLifecycleSnapshot,
  type PullRequestSnapshot,
} from '../../src/lifecycle/snapshot.js';
import {
  LifecycleDiscoveryCacheStore,
  type LifecycleDiscoveryState,
} from '../../src/lifecycle/lifecycle-cache.js';
import type { PolledIssue } from '../../src/dispatcher/types.js';
import { gitOid } from '../../src/lifecycle/types.js';

const DEFAULT_BRANCH = 'next';

function chainPr(
  number: number,
  headRefName: string,
  baseRefName: string,
  extra: Partial<StackChainPullRequest> = {},
): StackChainPullRequest {
  return { number, headRefName, baseRefName, ...extra };
}

describe('stack authority chain walk', () => {
  it('calls a pull request based on the default branch a root', () => {
    const chains = resolveStackChains(
      [chainPr(1, 'autopilot/10', 'next')],
      DEFAULT_BRANCH,
    );

    expect(chains.get(1)).toEqual({
      verdict: 'root',
      ancestors: [],
      rootPr: 1,
    });
  });

  it('admits a depth-1 stack whose parent is a root', () => {
    const chains = resolveStackChains(
      [
        chainPr(1, 'autopilot/10', 'next'),
        chainPr(2, 'autopilot/11', 'autopilot/10'),
      ],
      DEFAULT_BRANCH,
    );

    expect(chains.get(2)).toEqual({
      verdict: 'stacked-valid',
      ancestors: [1],
      rootPr: 1,
    });
  });

  it('admits a depth-2 stack and names the bottom-most open pull request', () => {
    const chains = resolveStackChains(
      [
        chainPr(1, 'autopilot/10', 'next'),
        chainPr(2, 'autopilot/11', 'autopilot/10'),
        chainPr(3, 'autopilot/12', 'autopilot/11'),
      ],
      DEFAULT_BRANCH,
    );

    expect(chains.get(3)).toEqual({
      verdict: 'stacked-valid',
      ancestors: [2, 1],
      rootPr: 1,
    });
  });

  it('breaks a chain whose base branch belongs to a closed pull request', () => {
    const chains = resolveStackChains(
      [
        chainPr(1, 'autopilot/10', 'next', { state: 'CLOSED' }),
        chainPr(2, 'autopilot/11', 'autopilot/10'),
      ],
      DEFAULT_BRANCH,
    );

    expect(chains.get(2)).toEqual({
      verdict: 'stacked-broken',
      ancestors: [],
      brokenAtRef: 'autopilot/10',
    });
  });

  it('breaks a chain whose base branch no open pull request owns', () => {
    const chains = resolveStackChains(
      [chainPr(2, 'autopilot/11', 'autopilot/10')],
      DEFAULT_BRANCH,
    );

    expect(chains.get(2)).toEqual({
      verdict: 'stacked-broken',
      ancestors: [],
      brokenAtRef: 'autopilot/10',
    });
  });

  it('terminates on a reference cycle and calls it broken', () => {
    const chains = resolveStackChains(
      [
        chainPr(1, 'autopilot/10', 'autopilot/11'),
        chainPr(2, 'autopilot/11', 'autopilot/10'),
      ],
      DEFAULT_BRANCH,
    );

    expect(chains.get(1)?.verdict).toBe('stacked-broken');
    expect(chains.get(2)?.verdict).toBe('stacked-broken');
    expect(chains.get(1)?.brokenAtRef).toBe('autopilot/10');
  });

  it('terminates on a self-referencing head and base', () => {
    const chains = resolveStackChains(
      [chainPr(1, 'autopilot/10', 'autopilot/10')],
      DEFAULT_BRANCH,
    );

    expect(chains.get(1)).toEqual({
      verdict: 'stacked-broken',
      ancestors: [],
      brokenAtRef: 'autopilot/10',
    });
  });

  it('keeps a draft root valid for its descendants', () => {
    const chains = resolveStackChains(
      [
        chainPr(1, 'autopilot/10', 'next', { draft: true }),
        chainPr(2, 'autopilot/11', 'autopilot/10'),
      ],
      DEFAULT_BRANCH,
    );

    expect(chains.get(2)).toMatchObject({ verdict: 'stacked-valid', rootPr: 1 });
  });

  it('treats a merged owner of the base branch as a valid terminus', () => {
    const chains = resolveStackChains(
      [
        chainPr(1, 'autopilot/10', 'next', { state: 'MERGED' }),
        chainPr(2, 'autopilot/11', 'autopilot/10'),
      ],
      DEFAULT_BRANCH,
    );

    expect(chains.get(2)).toEqual({
      verdict: 'stacked-valid',
      ancestors: [],
      rootPr: 2,
    });
  });

  it('resolves a duplicate head reference to the lowest open pull request number', () => {
    const chains = resolveStackChains(
      [
        chainPr(7, 'autopilot/10', 'next'),
        chainPr(5, 'autopilot/10', 'next'),
        chainPr(9, 'autopilot/11', 'autopilot/10'),
      ],
      DEFAULT_BRANCH,
    );

    expect(chains.get(9)).toEqual({
      verdict: 'stacked-valid',
      ancestors: [5],
      rootPr: 5,
    });
  });

  it('terminates on an arbitrarily deep chain', () => {
    const prs: StackChainPullRequest[] = [chainPr(1, 'autopilot/1', 'next')];
    for (let index = 2; index <= 60; index += 1) {
      prs.push(chainPr(index, `autopilot/${index}`, `autopilot/${index - 1}`));
    }

    expect(resolveStackChains(prs, DEFAULT_BRANCH).get(60)).toMatchObject({
      verdict: 'stacked-valid',
      rootPr: 1,
    });
  });

  it('names the break for the eligibility detail', () => {
    const chains = resolveStackChains(
      [chainPr(3437, 'autopilot/3219', 'autopilot/3218')],
      DEFAULT_BRANCH,
    );

    expect(describeStackBreak(3437, chains.get(3437)!)).toBe(
      'Parent pull request #3437 sits on a broken dependency stack: '
      + 'no open pull request owns base branch autopilot/3218',
    );
  });
});

const HEAD_A = gitOid('a'.repeat(40));
const HEAD_B = gitOid('b'.repeat(40));
const CAPTURED_AT = '2026-09-01T10:00:00.000Z';

function snapshotPr(
  number: number,
  headRefName: string,
  baseRefName: string,
  closingIssueNumbers: readonly number[],
  extra: Partial<PullRequestSnapshot> = {},
): PullRequestSnapshot {
  return {
    number,
    title: `feat: ${headRefName}`,
    body: `Closes #${closingIssueNumbers[0]}`,
    author: 'oaksprout',
    baseRefName,
    headRefName,
    headOid: number % 2 === 0 ? HEAD_A : HEAD_B,
    headCommittedAt: '2026-09-01T09:00:00.000Z',
    isDraft: false,
    state: 'OPEN',
    labels: [],
    closingIssueNumbers: [...closingIssueNumbers],
    mergeability: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    checks: [],
    reviews: [],
    ...extra,
  };
}

function polledIssue(number: number, extra: Partial<PolledIssue> = {}): PolledIssue {
  return {
    number,
    title: `Issue ${number}`,
    shape: 'feat',
    blockedOn: 'Nothing',
    blockedByIssues: [],
    effort: 'Medium',
    priority: 'P1',
    status: 'Todo',
    onBoard: true,
    author: 'oaksprout',
    projectItemId: `PVTI_${number}`,
    inCurrentSprint: true,
    ...extra,
  };
}

function compose(
  pullRequests: readonly PullRequestSnapshot[],
  issues: readonly PolledIssue[],
) {
  return composeGitHubLifecycleSnapshot(
    {
      project: {
        items: [],
        rateLimit: {
          remaining: 4_000,
          used: 1_000,
          resetAt: '2026-09-01T11:00:00.000Z',
        },
        currentSprintIterationId: null,
      },
      issues: [...issues],
      pullRequests: [...pullRequests],
      branches: [],
    },
    {
      authorAllowlist: new Set(['oaksprout']),
      defaultBranch: DEFAULT_BRANCH,
      capturedAt: CAPTURED_AT,
      snapshotMode: 'full',
      lastFullReconciliationAt: CAPTURED_AT,
      githubUsage: {
        graphqlRequests: 1,
        graphqlCost: 1,
        graphqlRemaining: 4_000,
        graphqlResetAt: '2026-09-01T11:00:00.000Z',
        restRequests: 0,
        restNotModified: 0,
        cacheHits: 0,
        accountingComplete: true,
      },
    },
  );
}

/**
 * The 2026-09-01 Jinn-Network/mono incident, verbatim:
 *   #3424 head=autopilot/3218 base=next           (root, draft)
 *   #3437 head=autopilot/3219 base=autopilot/3218 (stacked by design)
 *   #3462 review-finding child of #3437           (was permanently ineligible)
 */
function incidentPullRequests(
  parentBase = 'autopilot/3218',
): readonly PullRequestSnapshot[] {
  return [
    snapshotPr(3424, 'autopilot/3218', 'next', [3218], { isDraft: true }),
    snapshotPr(3437, 'autopilot/3219', parentBase, [3219]),
  ];
}

/** The dependency evidence a stacked PR's mapping requires (`pr-mapping.ts`). */
function stackedIssue(number: number): PolledIssue {
  return polledIssue(number, {
    blockedOn: 'Another issue',
    blockedByIssues: [number - 1],
  });
}

function childIssue(body: string): PolledIssue {
  return polledIssue(3462, { shape: null, body, title: 'Address review findings for PR #3437' });
}

describe('snapshot stack verdicts', () => {
  it('stamps every mapped pull request with its chain verdict', () => {
    const snapshot = compose(
      incidentPullRequests(),
      [polledIssue(3218), stackedIssue(3219)],
    );
    const byPr = new Map(
      snapshot.lifecycle.items
        .filter((item) => item.kind === 'pull-request')
        .map((item) => [item.prNumber, item]),
    );

    expect(byPr.get(3424)).toMatchObject({ stackVerdict: 'root' });
    expect(byPr.get(3437)).toMatchObject({
      stackVerdict: 'stacked-valid',
      stackRootPr: 3424,
    });
  });

  // The verdict is a fact about the *set* of pull requests, so it lives on the
  // derived lifecycle item and never on the persisted evidence: the discovery
  // cache requires each OPEN row in `evidence.pullRequests` to be
  // byte-identical to its `openPullRequestEvidence` twin, and a per-PR cached
  // verdict would go stale the moment a sibling merged.
  it('leaves the persisted pull-request evidence free of the derived verdict', async () => {
    const snapshot = compose(
      incidentPullRequests(),
      [polledIssue(3218), stackedIssue(3219)],
    );
    for (const pullRequest of snapshot.pullRequests) {
      expect(pullRequest).not.toHaveProperty('stackVerdict');
    }

    const directory = await mkdtemp(join(tmpdir(), 'stack-authority-'));
    const store = new LifecycleDiscoveryCacheStore({
      stateDirectory: join(directory, 'state'),
    });
    const state: LifecycleDiscoveryState = {
      version: 4,
      evidence: {
        project: snapshot.project,
        issues: [...snapshot.issues],
        pullRequests: [...snapshot.pullRequests],
        branches: [],
        capturedAt: CAPTURED_AT,
        snapshotMode: 'full',
        lastFullReconciliationAt: CAPTURED_AT,
        githubUsage: snapshot.githubUsage!,
      },
      terminalClaims: [],
      openPullRequestEvidence: [...snapshot.pullRequests],
      openPullRequests: null,
      recentlyClosedPullRequests: [],
      recentlyClosedCutoff: '2026-09-01T09:55:00.000Z',
      restCache: [],
    };

    // Round-trips unchanged, and the verdict is re-derived from the reloaded
    // evidence with nothing persisted in between.
    await store.save(state);
    const loaded = await store.load();
    expect(loaded?.evidence.pullRequests).toEqual(snapshot.pullRequests);

    const recomposed = compose(
      loaded!.evidence.pullRequests,
      loaded!.evidence.issues,
    );
    expect(
      recomposed.lifecycle.items.find(
        (item) => item.kind === 'pull-request' && item.prNumber === 3437,
      ),
    ).toMatchObject({ stackVerdict: 'stacked-valid', stackRootPr: 3424 });
  });

  it('keeps a review-finding child of a legitimately stacked parent eligible', () => {
    const snapshot = compose(
      incidentPullRequests(),
      [
        polledIssue(3218),
        stackedIssue(3219),
        childIssue(
          '<!-- jinn-autopilot:child pr=3437 kind=review-finding base=autopilot/3218 -->',
        ),
      ],
    );
    const child = snapshot.lifecycle.items.find(
      (item) => item.issueNumber === 3462,
    );

    expect(child).toMatchObject({ kind: 'issue', eligible: true });
  });

  it('refuses a child whose parent sits on a broken stack and names the break', () => {
    const snapshot = compose(
      [snapshotPr(3437, 'autopilot/3219', 'autopilot/3218', [3219])],
      [
        polledIssue(3219),
        childIssue('<!-- jinn-autopilot:child pr=3437 kind=review-finding -->'),
      ],
    );
    const child = snapshot.lifecycle.items.find(
      (item) => item.issueNumber === 3462,
    );

    expect(child).toMatchObject({
      kind: 'issue',
      eligible: false,
      eligibilityReason: 'dependency-blocked',
      eligibilityDetail:
        'Parent pull request #3437 sits on a broken dependency stack: '
        + 'no open pull request owns base branch autopilot/3218',
    });
  });

  it('releases the child the moment the root lands and GitHub retargets the parent', () => {
    const broken = compose(
      [snapshotPr(3437, 'autopilot/3219', 'autopilot/3218', [3219])],
      [
        polledIssue(3219),
        childIssue('<!-- jinn-autopilot:child pr=3437 kind=review-finding -->'),
      ],
    );
    expect(
      broken.lifecycle.items.find((item) => item.issueNumber === 3462),
    ).toMatchObject({ eligible: false });

    // Root merged; GitHub retargeted #3437 onto the default branch. Nothing is
    // persisted between the two compositions — the verdict is recomputed.
    const released = compose(
      [snapshotPr(3437, 'autopilot/3219', 'next', [3219])],
      [
        polledIssue(3219),
        childIssue('<!-- jinn-autopilot:child pr=3437 kind=review-finding -->'),
      ],
    );

    expect(
      released.lifecycle.items.find((item) => item.issueNumber === 3462),
    ).toMatchObject({ eligible: true });
    expect(
      released.lifecycle.items.find(
        (item) => item.kind === 'pull-request' && item.prNumber === 3437,
      ),
    ).toMatchObject({ stackVerdict: 'root' });
  });

  it('never manufactures a stack refusal from a scoped pull-request set', () => {
    const scoped = composeGitHubLifecycleSnapshot(
      {
        project: {
          items: [],
          rateLimit: {
            remaining: 4_000,
            used: 1_000,
            resetAt: '2026-09-01T11:00:00.000Z',
          },
          currentSprintIterationId: null,
        },
        issues: [
          polledIssue(3219),
          childIssue('<!-- jinn-autopilot:child pr=3437 kind=review-finding -->'),
        ],
        // The root #3424 is simply outside the scoped read.
        pullRequests: [snapshotPr(3437, 'autopilot/3219', 'autopilot/3218', [3219])],
        branches: [],
      },
      {
        authorAllowlist: new Set(['oaksprout']),
        defaultBranch: DEFAULT_BRANCH,
        capturedAt: CAPTURED_AT,
        snapshotMode: 'full',
        lastFullReconciliationAt: CAPTURED_AT,
        snapshotAuthority: 'scoped',
        scopedIssueNumbers: [3462],
        githubUsage: {
          graphqlRequests: 1,
          graphqlCost: 1,
          graphqlRemaining: 4_000,
          graphqlResetAt: '2026-09-01T11:00:00.000Z',
          restRequests: 0,
          restNotModified: 0,
          cacheHits: 0,
          accountingComplete: true,
        },
      },
    );

    expect(
      scoped.lifecycle.items.find((item) => item.issueNumber === 3462),
    ).toMatchObject({ eligible: true });
    const scopedPr = scoped.lifecycle.items.find(
      (item): item is Extract<typeof item, { kind: 'pull-request' }> =>
        item.kind === 'pull-request' && item.prNumber === 3437,
    );
    expect(scopedPr?.stackVerdict).toBeUndefined();
  });
});
