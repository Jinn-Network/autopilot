import { describe, expect, it } from 'vitest';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import { ConditionalRestClient } from '../../src/lifecycle/github-rest.js';
import {
  ConditionalPullRequestEvidenceProbe,
} from '../../src/lifecycle/github-rest-pr-evidence.js';
import * as restEvidence from '../../src/lifecycle/github-rest-pr-evidence.js';
import type { PullRequestSnapshot } from '../../src/lifecycle/snapshot.js';
import { gitOid } from '../../src/lifecycle/types.js';
import { GitHubUsageMeter } from '../../src/lifecycle/github-usage.js';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE_TIP = 'cccccccccccccccccccccccccccccccccccccccc';

function pr(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    number: 101,
    title: 'feat: conditional evidence',
    body: 'Closes #42',
    author: 'oaksprout',
    baseRefName: 'next',
    headRefName: 'autopilot/42',
    headOid: gitOid(HEAD),
    headCommittedAt: '2026-07-22T09:00:00.000Z',
    isDraft: false,
    state: 'OPEN',
    labels: ['engine:review'],
    closingIssueNumbers: [42],
    mergeability: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    compareStatus: 'ahead',
    compareBaseTipOid: gitOid(BASE_TIP),
    checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    reviews: [],
    ...overrides,
  };
}

interface Response {
  readonly status: 200 | 304;
  readonly body?: unknown;
  readonly etag?: string;
  readonly link?: string;
}

function included(response: Response): string {
  const body = response.status === 200 ? JSON.stringify(response.body) : '';
  return [
    `HTTP/2.0 ${response.status} ${response.status === 200 ? 'OK' : 'Not Modified'}`,
    `etag: ${response.etag ?? '"same"'}`,
    'x-ratelimit-remaining: 4998',
    'x-ratelimit-used: 2',
    'x-ratelimit-reset: 1784725200',
    'x-ratelimit-resource: core',
    ...(response.status === 200 ? ['content-type: application/json'] : []),
    ...(response.link === undefined ? [] : [`link: ${response.link}`]),
    '',
    body,
  ].join('\r\n');
}

function equalBodies(): Record<string, unknown> {
  return {
    detail: {
      number: 101,
      title: 'feat: conditional evidence',
      body: 'Closes #42',
      state: 'open',
      draft: false,
      user: { login: 'oaksprout' },
      head: { ref: 'autopilot/42', sha: HEAD },
      base: { ref: 'next' },
      labels: [{ name: 'engine:review' }],
      mergeable: true,
      mergeable_state: 'clean',
      closed_at: null,
      merged_at: null,
    },
    reviews: [],
    comments: [],
    events: [],
    checks: {
      total_count: 1,
      check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    },
    statuses: {
      state: 'success',
      total_count: 0,
      statuses: [],
    },
  };
}

/**
 * Merge-path PRs key `compareStatus` freshness on the recorded base branch tip.
 * Tests whose subject is the conditional-equality path itself must therefore use
 * a PR that is *not* on the merge path, in both the live body and the cached
 * snapshot.
 */
const OFF_MERGE_PATH = { mergeStateStatus: 'BLOCKED' } as const;

function matchingBaseTipReader(tip: string = BASE_TIP) {
  return {
    readBaseBranchTipOid: async () => gitOid(tip),
  };
}

function offMergePathBodies(): Record<string, unknown> {
  const bodies = equalBodies();
  bodies.detail = {
    ...(bodies.detail as Record<string, unknown>),
    mergeable_state: 'blocked',
  };
  return bodies;
}

function probeWith(
  bodies: Record<string, unknown>,
  later304 = false,
  baseTip: string = BASE_TIP,
): {
  readonly probe: ConditionalPullRequestEvidenceProbe;
  readonly meter: GitHubUsageMeter;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const seen = new Set<string>();
  const run: CommandRunner = async (_command, args) => {
    const endpoint = args[2]!;
    calls.push(endpoint);
    if (later304 && seen.has(endpoint)) return included({ status: 304 });
    seen.add(endpoint);
    const kind = endpoint === 'repos/Jinn-Network/mono/pulls/101'
      ? 'detail'
      : endpoint.includes('/reviews?')
      ? 'reviews'
      : endpoint.includes('/comments?')
        ? 'comments'
        : endpoint.includes('/events?')
          ? 'events'
        : endpoint.includes('/check-runs?')
          ? 'checks'
          : 'statuses';
    return included({ status: 200, body: bodies[kind] });
  };
  const meter = new GitHubUsageMeter();
  return {
    probe: new ConditionalPullRequestEvidenceProbe(
      new ConditionalRestClient(run, { usageMeter: meter }),
      'Jinn-Network/mono',
      matchingBaseTipReader(baseTip),
    ),
    meter,
    calls,
  };
}

describe('ConditionalPullRequestEvidenceProbe', () => {
  it('parses workflow run ids rather than check-run ids', () => {
    const parser = (
      restEvidence as unknown as {
        workflowRunIdFromDetailsUrl?: (url: unknown) => number | undefined;
      }
    ).workflowRunIdFromDetailsUrl;
    expect(parser).toBeTypeOf('function');
    expect(parser?.(
      'https://github.com/Jinn-Network/mono/actions/runs/123/jobs/456',
    )).toBe(123);
    expect(parser?.('https://github.com/Jinn-Network/mono/runs/999')).toBeUndefined();
  });

  it('normalizes a cold 200 against full evidence, then reuses every ETag on 304', async () => {
    const context = probeWith(offMergePathBodies(), true);

    await expect(context.probe.changed(pr(OFF_MERGE_PATH))).resolves.toBe(false);
    await expect(context.probe.changed(pr(OFF_MERGE_PATH))).resolves.toBe(false);

    expect(context.calls).toHaveLength(12);
    expect(context.meter.read()).toMatchObject({
      restRequests: 12,
      restNotModified: 6,
      cacheHits: 6,
    });
  });

  it('re-hydrates false-clean PRs missing exact compare evidence', async () => {
    const probe = new ConditionalPullRequestEvidenceProbe(new ConditionalRestClient(
      async () => included({ status: 200, body: equalBodies().detail }),
      { usageMeter: new GitHubUsageMeter() },
    ));

    await expect(probe.changed(pr({ compareStatus: undefined }))).resolves.toBe(true);
  });

  /**
   * `compareStatus` depends on the live base branch tip. When the recorded tip
   * still matches, merge-path PRs may reuse cached compare evidence alongside
   * the conditional ETag path.
   */
  it('reuses cached compare evidence when the base branch tip is unchanged', async () => {
    const context = probeWith(equalBodies(), true);

    await expect(context.probe.changed(pr())).resolves.toBe(false);
    await expect(context.probe.changed(pr())).resolves.toBe(false);

    expect(context.calls).toHaveLength(12);
    expect(context.meter.read()).toMatchObject({
      restRequests: 12,
      restNotModified: 6,
      cacheHits: 6,
    });
  });

  it('refreshes merge-path compare evidence when the base branch tip moves', async () => {
    const movedTip = 'dddddddddddddddddddddddddddddddddddddddd';
    const context = probeWith(equalBodies(), true, movedTip);

    await expect(context.probe.changed(pr())).resolves.toBe(true);
    await expect(context.probe.changed(pr())).resolves.toBe(true);
    expect(context.calls).toHaveLength(12);
    expect(context.meter.read()).toMatchObject({ restNotModified: 6 });
  });

  it('refreshes merge-path compare evidence when the live base tip is unavailable', async () => {
    const meter = new GitHubUsageMeter();
    const unavailableProbe = new ConditionalPullRequestEvidenceProbe(
      new ConditionalRestClient(async (_command, args) => {
        const bodies = equalBodies();
        const kind = args[2] === 'repos/Jinn-Network/mono/pulls/101'
          ? 'detail'
          : args[2]!.includes('/reviews?')
            ? 'reviews'
            : args[2]!.includes('/comments?')
              ? 'comments'
              : args[2]!.includes('/events?')
                ? 'events'
                : args[2]!.includes('/check-runs?')
                  ? 'checks'
                  : 'statuses';
        return included({ status: 200, body: bodies[kind] });
      }, { usageMeter: meter }),
      'Jinn-Network/mono',
      { readBaseBranchTipOid: async () => 'unavailable' as const },
    );

    await expect(unavailableProbe.changed(pr())).resolves.toBe(true);
  });

  it('still fails closed on malformed evidence for a merge-path PR', async () => {
    const bodies = equalBodies();
    (bodies.detail as Record<string, unknown>).number = 999;
    const context = probeWith(bodies);

    // The forced refresh must not become a shortcut past the identity guard.
    await expect(context.probe.changed(pr({
      compareStatus: 'ahead',
      compareBaseTipOid: gitOid(BASE_TIP),
    }))).rejects.toThrow(
      /does not match/i,
    );
  });

  it.each([
    ['ahead' as const],
    ['identical' as const],
    ['behind' as const],
    ['diverged' as const],
    ['unknown' as const],
  ])('refreshes merge-path PRs missing a recorded base tip for cached %s compareStatus', async (compareStatus) => {
    const context = probeWith(equalBodies(), true);

    await expect(context.probe.changed(pr({
      compareStatus,
      compareBaseTipOid: undefined,
    }))).resolves.toBe(true);
  });

  it.each([
    ['ahead' as const],
    ['identical' as const],
    ['behind' as const],
    ['diverged' as const],
  ])('reuses cached %s compareStatus when the base tip still matches', async (compareStatus) => {
    const context = probeWith(equalBodies(), true);

    await expect(context.probe.changed(pr({ compareStatus }))).resolves.toBe(false);
  });

  it('forces refresh when cached PR evidence is explicitly incomplete', async () => {
    const context = probeWith(equalBodies());

    await expect(context.probe.changed(pr({
      evidenceIncompleteReason: 'PR #101 reviews were truncated',
    }))).resolves.toBe(true);
    expect(context.calls).toEqual([]);
  });

  it('uses the workflow run id from a check-run details URL', async () => {
    const bodies = offMergePathBodies();
    bodies.checks = {
      total_count: 1,
      check_runs: [{
        id: 999,
        name: 'test',
        status: 'completed',
        conclusion: 'success',
        details_url: 'https://github.com/Jinn-Network/mono/actions/runs/123/jobs/456',
        check_suite: { id: 77 },
      }],
    };

    await expect(probeWith(bodies).probe.changed(pr({
      ...OFF_MERGE_PATH,
      checks: [{
        name: 'test',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        source: 'check-run',
        runId: 123,
        checkSuiteId: 77,
      }],
    }))).resolves.toBe(false);
  });

  it('detects a changed workflow run id even when the visible check state is unchanged', async () => {
    const bodies = equalBodies();
    bodies.checks = {
      total_count: 1,
      check_runs: [{
        id: 999,
        name: 'test',
        status: 'completed',
        conclusion: 'success',
        details_url: 'https://github.com/Jinn-Network/mono/actions/runs/123/jobs/456',
        check_suite: { id: 77 },
      }],
    };

    await expect(probeWith(bodies).probe.changed(pr({
      checks: [{
        name: 'test',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        source: 'check-run',
        runId: 999,
        checkSuiteId: 77,
      }],
    }))).resolves.toBe(true);
  });

  it('normalizes documented null PR body and user values to empty strings', async () => {
    const bodies = offMergePathBodies();
    bodies.detail = {
      ...(bodies.detail as Record<string, unknown>),
      body: null,
      user: null,
    };

    await expect(
      probeWith(bodies).probe.changed(pr({ ...OFF_MERGE_PATH, body: '', author: '' })),
    ).resolves.toBe(false);
  });

  it.each(['body', 'user'] as const)(
    'still fails closed when documented PR field %s is undefined',
    async (field) => {
      const bodies = equalBodies();
      const detail = { ...(bodies.detail as Record<string, unknown>) };
      delete detail[field];
      bodies.detail = detail;

      await expect(probeWith(bodies).probe.changed(pr())).rejects.toThrow(/body|user/i);
    },
  );

  it('detects a decisive review even when the PR index timestamp is unchanged', async () => {
    const bodies = equalBodies();
    bodies.reviews = [{
      user: { login: 'reviewer' },
      state: 'APPROVED',
      commit_id: HEAD,
      body: 'approved',
      submitted_at: '2026-07-22T10:01:00.000Z',
    }];

    await expect(probeWith(bodies).probe.changed(pr())).resolves.toBe(true);
  });

  it('detects a structured Human comment transition', async () => {
    const bodies = equalBodies();
    bodies.comments = [{
      id: 1,
      body: '<!-- jinn-autopilot-human:v2 issue=42 pr=101 phase=reviewing code=review-escalation -->\n\nNeeds a product decision.',
      created_at: '2026-07-22T10:02:00.000Z',
      author_association: 'MEMBER',
    }];

    await expect(probeWith(bodies).probe.changed(pr())).resolves.toBe(true);
  });

  it('ignores unstructured maintainer prose as lifecycle authority', async () => {
    const bodies = offMergePathBodies();
    bodies.comments = [{
      id: 1,
      body: 'Please do not merge this PR until I investigate.',
      created_at: '2026-07-22T10:02:00.000Z',
      author_association: 'MEMBER',
      user: { login: 'maintainer' },
    }];

    await expect(probeWith(bodies).probe.changed(pr(OFF_MERGE_PATH))).resolves.toBe(false);
  });

  it.each([
    {
      label: 'an invalid structured audit marker',
      body: '<!-- jinn-autopilot-human:v2 pr=101 phase=reviewing code=review-escalation -->',
    },
    {
      label: 'a structured audit marker for another PR',
      body: '<!-- jinn-autopilot-human:v2 pr=999 phase=reviewing code=review-escalation -->'
        + '\n\nA real detail sentence.',
    },
  ])('forces canonical refresh rather than aborting on $label', async ({ body }) => {
    const bodies = equalBodies();
    bodies.comments = [{ id: 1, body, user: { login: 'review-bot' } }];

    await expect(probeWith(bodies).probe.changed(pr())).resolves.toBe(true);
  });

  it('detects a changed current Human label actor even when the label remains present', async () => {
    const generation = '22222222-2222-4222-8222-222222222222';
    const marker = '<!-- jinn-autopilot-human:v2 issue=42 pr=101 '
      + 'phase=implementing code=branch-mapping-ambiguous '
      + `head=${HEAD} generation=${generation} -->`;
    const bodies = equalBodies();
    bodies.detail = {
      ...(bodies.detail as Record<string, unknown>),
      labels: [{ name: 'engine:review' }, { name: 'review:needs-human' }],
    };
    bodies.comments = [{
      id: 1,
      body: `${marker}\n\nMapping was ambiguous.`,
      created_at: '2026-07-22T10:02:00.000Z',
      author_association: 'MEMBER',
      user: { login: 'maintenance-bot' },
    }];
    bodies.events = [{
      event: 'labeled',
      created_at: '2026-07-22T10:03:00.000Z',
      actor: { login: 'maintainer' },
      label: { name: 'review:needs-human' },
    }];

    await expect(probeWith(bodies).probe.changed(pr({
      labels: ['engine:review', 'review:needs-human'],
      humanIssueNumber: 42,
      humanAuthor: 'maintenance-bot',
      humanHead: gitOid(HEAD),
      humanGeneration: generation,
      humanLabelActor: 'maintenance-bot',
      humanReason: {
        phase: 'implementing',
        code: 'branch-mapping-ambiguous',
        detail: 'Mapping was ambiguous.',
      },
    }))).resolves.toBe(true);
  });

  it.each([
    ['check run', {
      checks: {
        total_count: 1,
        check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure' }],
      },
    }],
    ['commit status', {
      checks: { total_count: 0, check_runs: [] },
      statuses: {
        state: 'failure',
        total_count: 1,
        statuses: [{ context: 'legacy-ci', state: 'failure' }],
      },
    }],
  ])('detects a %s transition without relying on pull_request.updated_at', async (_label, change) => {
    await expect(probeWith({ ...equalBodies(), ...change }).probe.changed(pr()))
      .resolves.toBe(true);
  });

  it.each([
    ['dirty', false, 'dirty'],
    ['behind', true, 'behind'],
  ] as const)(
    'detects an exact-detail mergeability transition to %s with unchanged head and updated_at',
    async (_label, mergeable, mergeableState) => {
      const bodies = equalBodies();
      bodies.detail = {
        ...(bodies.detail as Record<string, unknown>),
        mergeable,
        mergeable_state: mergeableState,
      };

      await expect(probeWith(bodies).probe.changed(pr())).resolves.toBe(true);
    },
  );

  it('treats live PR head drift as changed evidence without aborting the cycle', async () => {
    const bodies = equalBodies();
    bodies.detail = {
      ...(bodies.detail as Record<string, unknown>),
      head: { ref: 'autopilot/42', sha: 'b'.repeat(40) },
    };

    await expect(probeWith(bodies).probe.changed(pr())).resolves.toBe(true);
  });

  it('fails closed when the exact PR detail identity does not match', async () => {
    const bodies = equalBodies();
    bodies.detail = {
      ...(bodies.detail as Record<string, unknown>),
      number: 999,
    };

    await expect(probeWith(bodies).probe.changed(pr())).rejects.toThrow(/identity/i);
  });

  it.each([
    {
      label: 'unknown review state',
      bodies: {
        ...equalBodies(),
        reviews: [{
          user: { login: 'reviewer' },
          state: 'SURPRISE',
          commit_id: HEAD,
          body: '',
          submitted_at: '2026-07-22T10:01:00.000Z',
        }],
      },
    },
    { label: 'truncated comments', bodies: equalBodies(), truncated: 'comments' },
    {
      label: 'incomplete check count',
      bodies: {
        ...equalBodies(),
        checks: { total_count: 2, check_runs: [] },
      },
    },
  ] as Array<{
    label: string;
    bodies: Record<string, unknown>;
    truncated?: string;
  }>)('fails closed on $label', async ({ bodies, truncated }) => {
    if (truncated === undefined) {
      await expect(probeWith(bodies).probe.changed(pr())).rejects.toThrow();
      return;
    }
    const run: CommandRunner = async (_command, args) => {
      const endpoint = args[2]!;
      const body = endpoint === 'repos/Jinn-Network/mono/pulls/101'
        ? bodies.detail
        : endpoint.includes('/reviews?')
        ? bodies.reviews
        : endpoint.includes('/comments?')
          ? bodies.comments
          : endpoint.includes('/check-runs?')
            ? bodies.checks
            : bodies.statuses;
      return included({
        status: 200,
        body,
        ...(endpoint.includes(`/${truncated}?`)
          ? { link: `<https://api.github.com/${endpoint.replace('page=1', 'page=2')}>; rel="next"` }
          : {}),
      });
    };
    const probe = new ConditionalPullRequestEvidenceProbe(new ConditionalRestClient(run));
    await expect(probe.changed(pr())).resolves.toBe(true);
  });
});
