import { describe, expect, it } from 'vitest';

import {
  createIssueRelayGitHubRestReadPort,
} from '../../../src/issue-relay/evaluator/github-receipt-observer.js';

const HEAD = 'a'.repeat(40);
const BASE = 'c'.repeat(40);

function pullRequestBody(): unknown {
  return {
    number: 42,
    title: 'feat: relay evidence',
    body: 'Closes #7',
    base: {
      ref: 'main',
      sha: BASE,
      repo: { full_name: 'Jinn-Network/mono' },
    },
    head: {
      ref: 'relay/7',
      sha: HEAD,
      repo: { full_name: 'jinn-relay/mono' },
    },
  };
}

function checkRunRows(count: number, offset: number): unknown[] {
  return Array.from({ length: count }, (_row, index) => ({
    name: `check-${offset + index}`,
    status: 'completed',
    conclusion: 'success',
  }));
}

function commitStatusRows(count: number, offset: number): unknown[] {
  return Array.from({ length: count }, (_row, index) => ({
    context: `status-${offset + index}`,
    state: 'success',
  }));
}

/**
 * mono PR #2918's shape: a head commit whose check evidence outruns the 100-row
 * page GitHub serves. Serves `pages` pages of the named check endpoint, each
 * advertising the next through its own Link header, and records every path the
 * reader asks for so a test can prove the follow-up read followed that header
 * rather than re-reading page one. `endlessNext` never stops advertising a next
 * page, which is what the page cap has to survive.
 */
function pagedCheckPort(options: {
  readonly kind: 'check-runs' | 'status';
  readonly pages: readonly (readonly unknown[])[];
  readonly totalCount: number;
  readonly endlessNext?: boolean;
}): {
  readonly readPullRequest: () => Promise<{
    readonly checks: {
      readonly optional: readonly { readonly name: string }[];
    };
  }>;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith(`/commits/${HEAD}/${options.kind}`)) {
      const page = Number(url.searchParams.get('page') ?? '0');
      const rows = options.pages[page - 1] ?? [];
      const hasNext = options.endlessNext === true
        || page < options.pages.length;
      const nextUrl = new URL(url);
      nextUrl.searchParams.set('page', String(page + 1));
      return new Response(
        JSON.stringify(
          options.kind === 'check-runs'
            ? { total_count: options.totalCount, check_runs: rows }
            : {
                sha: HEAD,
                state: 'success',
                total_count: options.totalCount,
                statuses: rows,
              },
        ),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            ...(hasNext ? { link: `<${nextUrl.toString()}>; rel="next"` } : {}),
          },
        },
      );
    }
    const body = url.pathname.endsWith(`/commits/${HEAD}/check-runs`)
      ? { total_count: 0, check_runs: [] }
      : url.pathname.endsWith(`/commits/${HEAD}/status`)
        ? { sha: HEAD, state: 'success', total_count: 0, statuses: [] }
        : pullRequestBody();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const port = createIssueRelayGitHubRestReadPort({ fetchImpl });
  return {
    readPullRequest: () =>
      port.readPullRequest({ repository: 'Jinn-Network/mono', prNumber: 42 }),
    calls,
  };
}

function pathsFor(calls: readonly string[], kind: string): string[] {
  return calls.filter((call) => call.includes(`/commits/${HEAD}/${kind}?`));
}

function endpoint(kind: 'check-runs' | 'status', page: number): string {
  return `/repos/Jinn-Network/mono/commits/${HEAD}/${kind}`
    + `?per_page=100&page=${page}`;
}

describe('Relay REST read port check evidence', () => {
  /**
   * mono PR #2918 carries 144 check contexts on its head commit. One
   * `per_page=100` page cannot hold them, and the Relay's exact-head ready
   * invariant reads exactly this evidence — a truncated read either loses
   * checks or refuses the pull request outright.
   */
  it('merges a check-runs response that spans two pages', async () => {
    const context = pagedCheckPort({
      kind: 'check-runs',
      pages: [checkRunRows(100, 0), checkRunRows(44, 100)],
      totalCount: 144,
    });

    const facts = await context.readPullRequest();

    expect(facts.checks.optional).toHaveLength(144);
    expect(facts.checks.optional.at(-1)?.name).toBe('check-99');
    expect(pathsFor(context.calls, 'check-runs')).toEqual([
      endpoint('check-runs', 1),
      endpoint('check-runs', 2),
    ]);
  });

  it('issues no follow-up read when the check-runs response fits one page', async () => {
    const context = pagedCheckPort({
      kind: 'check-runs',
      pages: [checkRunRows(2, 0)],
      totalCount: 2,
    });

    await expect(context.readPullRequest()).resolves.toBeDefined();

    expect(pathsFor(context.calls, 'check-runs'))
      .toEqual([endpoint('check-runs', 1)]);
  });

  it('fails closed when check-runs pagination outruns the page cap', async () => {
    const context = pagedCheckPort({
      kind: 'check-runs',
      pages: [checkRunRows(100, 0)],
      totalCount: 100_000,
      endlessNext: true,
    });

    await expect(context.readPullRequest())
      .rejects.toThrow(/check-runs pagination is truncated/);
    expect(pathsFor(context.calls, 'check-runs')).toHaveLength(10);
  });

  it('asserts check-runs total_count against the merged pages, not the first', async () => {
    const context = pagedCheckPort({
      kind: 'check-runs',
      pages: [checkRunRows(100, 0), checkRunRows(43, 100)],
      totalCount: 144,
    });

    await expect(context.readPullRequest())
      .rejects.toThrow(/check-runs response is incomplete/);
  });

  it('merges a commit-status response that spans two pages', async () => {
    const context = pagedCheckPort({
      kind: 'status',
      pages: [commitStatusRows(100, 0), commitStatusRows(44, 100)],
      totalCount: 144,
    });

    const facts = await context.readPullRequest();

    expect(facts.checks.optional).toHaveLength(144);
    expect(pathsFor(context.calls, 'status')).toEqual([
      endpoint('status', 1),
      endpoint('status', 2),
    ]);
  });

  it('fails closed when commit-status pagination outruns the page cap', async () => {
    const context = pagedCheckPort({
      kind: 'status',
      pages: [commitStatusRows(100, 0)],
      totalCount: 100_000,
      endlessNext: true,
    });

    await expect(context.readPullRequest())
      .rejects.toThrow(/commit-status pagination is truncated/);
    expect(pathsFor(context.calls, 'status')).toHaveLength(10);
  });

  it('asserts commit-status total_count against the merged pages, not the first', async () => {
    const context = pagedCheckPort({
      kind: 'status',
      pages: [commitStatusRows(100, 0), commitStatusRows(43, 100)],
      totalCount: 144,
    });

    await expect(context.readPullRequest())
      .rejects.toThrow(/commit-status response is incomplete/);
  });
});
