// @ts-nocheck — Stage 5 leftover fixtures for deleted merge-prep/review-fix/project APIs.
import { describe, expect, it } from 'vitest';
import {
  explainIssue,
  explainPullRequest,
  fullReconciliationAllowsNewClaims,
  parseLifecycleCli,
  renderLifecycleHuman,
  renderLifecycleJson,
  runLifecycleCycle,
  type LifecycleControllerDeps,
} from '../../src/lifecycle/controller.js';
import {
  LifecycleRateLimitError,
  type GitHubLifecycleSnapshot,
} from '../../src/lifecycle/snapshot.js';
import {
  gitOid,
  gitRefName,
  type LifecycleItem,
} from '../../src/lifecycle/types.js';
import type { ReconciliationWriter } from '../../src/lifecycle/reconciler.js';
import {
  EXPECTED_ACCOUNTING_APPROXIMATION_PREFIX,
  GitHubUsageIncompleteError,
  GitHubUsageMeter,
  makeGitHubUsageCommandRunner,
  type GitHubUsage,
} from '../../src/lifecycle/github-usage.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import type { PolledIssue } from '../../src/dispatcher/types.js';
import { LifecycleSnapshotCoordinator } from '../../src/lifecycle/runner-snapshot.js';

const HEAD = gitOid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const NOW = new Date('2026-07-20T12:00:00.000Z');

function implementation(
  overrides: Partial<Extract<LifecycleItem, { kind: 'pull-request' }>> = {},
): Extract<LifecycleItem, { kind: 'pull-request' }> {
  return {
    kind: 'pull-request',
    issueNumber: 42,
    prNumber: 101,
    v2Marked: true,
    projectStatus: 'Todo',
    labels: ['engine:review'],
    head: HEAD,
    expectedBaseRefName: 'next',
    headChangedAt: '2026-07-20T11:00:00.000Z',
    isDraft: false,
    merged: false,
    needsReview: true,
    approved: false,
    mergeState: 'blocked',
    branchClaim: {
      kind: 'branch-claim',
      protocolVersion: 2,
      phase: 'implement',
      issueNumber: 42,
      prNumber: 101,
      attempt: '11111111-1111-4111-8111-111111111111',
      runner: 'runner-a',
      login: 'implementer',
      expectedHead: HEAD,
      targetBase: gitRefName('next'),
      claimedAt: '2026-07-20T11:00:00.000Z',
    },
    ...overrides,
  };
}

/**
 * A live open issue, exactly as `snapshot.issues` carries it — every field a
 * value the readers can actually produce (`shape` from `ISSUE_SHAPES`,
 * `effort` from `EFFORTS`).
 *
 * The base `snapshot()` helper yields `issues: []`, which is only sound for
 * fixtures whose issue is genuinely closed: eligibility is computed by
 * `selectReady` over `snapshot.issues` alone, so an eligible Todo issue is by
 * construction present there. Fixtures asserting recovery for a live claim
 * must say so.
 *
 * NOTE: the `PolledIssue` annotation documents the contract but does not
 * enforce it — the `@ts-nocheck` on line 1 suppresses checking for this whole
 * file. Treat the field values as hand-verified against
 * `src/dispatcher/types.ts`, not as compiler-guaranteed.
 */
function openIssue(number: number): PolledIssue {
  return {
    number,
    title: 'feat: lifecycle',
    labels: [],
    body: '',
    shape: 'feat',
    blockedOn: 'Nothing',
    blockedByIssues: [],
    effort: 'Low',
    priority: 'P1',
    status: 'Todo',
    onBoard: true,
    author: 'trusted',
    projectItemId: `PVTI_${number}`,
    inCurrentSprint: true,
  };
}

function snapshot(item: LifecycleItem): GitHubLifecycleSnapshot {
  return {
    project: {
      items: [],
      rateLimit: {
        remaining: 4_000,
        used: 1_000,
        resetAt: '2026-07-20T13:00:00.000Z',
      },
      currentSprintIterationId: null,
    },
    issues: [],
    pullRequests: item.kind === 'pull-request'
      ? [{
          number: item.prNumber,
          title: 'feat: lifecycle',
          body: 'Closes #42',
          author: 'trusted',
          baseRefName: 'next',
          headRefName: 'autopilot/42',
          headOid: item.head,
          headCommittedAt: item.headChangedAt,
          isDraft: item.isDraft,
          state: item.merged ? 'MERGED' : 'OPEN',
          labels: item.labels,
          closingIssueNumbers: [item.issueNumber],
          mergeability: 'UNKNOWN',
          mergeStateStatus: 'BLOCKED',
          checks: [],
          reviews: [],
          ...(item.branchClaim === undefined ? {} : { branchClaim: item.branchClaim }),
        }]
      : [],
    branches: [],
    diagnostics: [],
    lifecycle: { items: [item] },
    capturedAt: NOW.toISOString(),
    snapshotMode: 'full',
    snapshotComplete: true,
    lastFullReconciliationAt: NOW.toISOString(),
    githubUsage: {
      graphqlRequests: 3,
      graphqlCost: 21,
      graphqlRemaining: 3_979,
      graphqlResetAt: '2026-07-20T13:00:00.000Z',
      restRequests: 4,
      restNotModified: 1,
      cacheHits: 2,
    },
  };
}

function throwingWriter(calls: string[]): ReconciliationWriter {
  return new Proxy({} as ReconciliationWriter, {
    get(_target, property) {
      return async () => {
        calls.push(String(property));
        throw new Error('writer called');
      };
    },
  });
}

function deps(
  item: LifecycleItem,
  calls: string[],
  writer: ReconciliationWriter = throwingWriter(calls),
): LifecycleControllerDeps {
  return {
    readSnapshot: async () => snapshot(item),
    writer,
    now: () => NOW,
    staleAfterMs: 2 * 60 * 60 * 1000,
    runnerId: 'runner-a',
    cycleId: () => 'cycle-1',
  };
}

describe('lifecycle controller', () => {
  it('defaults to observe and maps dry-run to one observe cycle', () => {
    expect(parseLifecycleCli([])).toEqual({
      mode: 'observe',
      once: false,
      command: { kind: 'status' },
      json: false,
      fullReconcile: false,
    });
    expect(parseLifecycleCli(['--dry-run', '--mode', 'recover'])).toEqual({
      mode: 'observe',
      once: true,
      command: { kind: 'status' },
      json: false,
      fullReconcile: false,
    });
    expect(parseLifecycleCli(['--once', '--mode', 'recover'])).toMatchObject({
      mode: 'recover',
      once: true,
    });
    expect(parseLifecycleCli(['--full-reconcile'])).toMatchObject({
      mode: 'observe',
      once: true,
      fullReconcile: true,
    });
    expect(() => parseLifecycleCli(['--full-reconcile', '--mode', 'active']))
      .toThrow(/full-reconcile.*observe/i);
  });

  it('returns a clearly partial zero-write status when complete discovery is unavailable', async () => {
    const calls: string[] = [];
    const partial = {
      ...snapshot(implementation()),
      project: {
        items: [],
        rateLimit: { remaining: 0, used: 0, resetAt: NOW.toISOString() },
        currentSprintIterationId: null,
      },
      pullRequests: [],
      lifecycle: { items: [] },
      snapshotMode: 'incremental' as const,
      snapshotComplete: false,
      lastFullReconciliationAt: null,
      partialReason: 'no complete lifecycle cache exists',
      githubUsage: {
        ...snapshot(implementation()).githubUsage!,
        graphqlRemaining: null,
      },
    };
    const report = await runLifecycleCycle('observe', {
      ...deps(implementation(), calls),
      readSnapshot: async () => partial,
    });

    expect(report).toMatchObject({
      status: 'ok',
      snapshotMode: 'incremental',
      snapshotComplete: false,
      partialReason: 'no complete lifecycle cache exists',
      items: [],
      events: [],
    });
    expect(calls).toEqual([]);
    expect(renderLifecycleHuman(report)).toContain('PARTIAL: no complete lifecycle cache exists');
  });

  it('reports a persistent snapshot failure as mutation-free but keeps one-shot behavior fail-closed', async () => {
    const calls: string[] = [];
    let cycleIds = 0;
    const persistent = await runLifecycleCycle('recover', {
      ...deps(implementation(), calls),
      cycleId: () => {
        cycleIds += 1;
        return 'unused-cycle';
      },
      snapshotFailureMode: 'report',
      readGitHubUsage: () => ({
        graphqlRequests: 2,
        graphqlCost: 301,
        graphqlRemaining: 3_200,
        graphqlResetAt: '2026-07-20T13:00:00.000Z',
        restRequests: 8,
        restNotModified: 4,
        cacheHits: 4,
      }),
      readSnapshot: async () => {
        throw new AggregateError([new Error('full failed'), new Error('fallback failed')], 'both failed');
      },
    });

    expect(persistent).toMatchObject({
      status: 'failed',
      mutationFree: true,
      message: expect.stringMatching(/both failed/i),
      usageAccounting: { complete: true },
      githubUsage: { graphqlCost: 301, restRequests: 8 },
      items: [],
      events: [],
    });
    expect(calls).toEqual([]);
    expect(cycleIds).toBe(0);
    await expect(runLifecycleCycle('recover', {
      ...deps(implementation(), calls),
      readSnapshot: async () => { throw new Error('one-shot failed'); },
    })).rejects.toThrow('one-shot failed');
  });

  it('marks failed-cycle usage unavailable instead of reporting invented zero usage', async () => {
    const report = await runLifecycleCycle('recover', {
      ...deps(implementation(), []),
      snapshotFailureMode: 'report',
      readGitHubUsage: () => {
        throw new GitHubUsageIncompleteError('opaque GraphQL span has no closing evidence');
      },
      readSnapshot: async () => { throw new Error('snapshot failed'); },
    });

    expect(report).toMatchObject({
      status: 'failed',
      mutationFree: true,
      usageAccounting: {
        complete: false,
        reason: expect.stringMatching(/opaque GraphQL span has no closing evidence/i),
      },
    });
    expect(report).not.toHaveProperty('githubUsage');
    expect(renderLifecycleHuman(report)).toContain('GitHub usage: unavailable');
    expect(renderLifecycleHuman(report)).not.toContain('GraphQL 0');
    const json = renderLifecycleJson(report);
    expect(json).toContain('"complete": false');
    expect(json).toContain('opaque GraphQL span has no closing evidence');
    expect(json).not.toContain('"graphqlCost": 0');
  });

  /**
   * A cycle that produces no snapshot at all finishes in about a minute having
   * done nothing, leaves `status` reading `running`, and fires none of the
   * stall instruments — every one of them sits behind a snapshot. #136 ran 46
   * such cycles overnight and the only evidence was one WARNING line shaped
   * like every other WARNING line. Counted and surfaced the way #130 surfaces a
   * stale reconciliation: one derived line per cycle, from the second.
   */
  describe('no-snapshot stall surfacing (#136)', () => {
    const unavailable = (report: Awaited<ReturnType<typeof runLifecycleCycle>>) => (
      report.events.filter((event) => event.subject === 'snapshot')
    );

    /**
     * A fresh deps object per cycle carrying one stable `readSnapshot`, exactly
     * as the daemon builds it: the count must survive the per-cycle deps and
     * still belong to this engine alone.
     */
    function failingRuntime(message = 'both failed') {
      const readSnapshot = async (): Promise<never> => { throw new Error(message); };
      return () => ({
        ...deps(implementation(), []),
        snapshotFailureMode: 'report' as const,
        readSnapshot,
      });
    }

    it('says nothing on the first cycle that produces no snapshot', async () => {
      // One is a failed read; a run of them is a stall.
      const runtime = failingRuntime();
      expect(unavailable(await runLifecycleCycle('recover', runtime()))).toEqual([]);
    });

    it('logs the stall from the second consecutive no-snapshot cycle', async () => {
      const runtime = failingRuntime(
        'Full reconciliation and incremental fallback both failed: [full] '
        + 'GitHubRestSchemaError: pull request 1 merged after it closed',
      );

      await runLifecycleCycle('recover', runtime());
      const report = await runLifecycleCycle('recover', runtime());

      expect(unavailable(report)).toEqual([expect.objectContaining({
        mode: 'recover',
        phase: 'eligible',
        action: 'read',
        subject: 'snapshot',
        outcome: 'unavailable',
        reason:
          'for 2 consecutive cycle(s): Full reconciliation and incremental fallback both '
          + 'failed: [full] GitHubRestSchemaError: pull request 1 merged after it c',
      })]);
    });

    it('counts every consecutive no-snapshot cycle, one line each', async () => {
      const runtime = failingRuntime();
      const reasons: (string | undefined)[] = [];

      for (let cycle = 0; cycle < 4; cycle += 1) {
        reasons.push(unavailable(await runLifecycleCycle('recover', runtime()))[0]?.reason);
      }

      expect(reasons).toEqual([
        undefined,
        'for 2 consecutive cycle(s): both failed',
        'for 3 consecutive cycle(s): both failed',
        'for 4 consecutive cycle(s): both failed',
      ]);
    });

    it('carries only the first 120 characters of the last error', async () => {
      const runtime = failingRuntime('x'.repeat(400));

      await runLifecycleCycle('recover', runtime());
      const report = await runLifecycleCycle('recover', runtime());

      expect(unavailable(report)[0]?.reason)
        .toBe(`for 2 consecutive cycle(s): ${'x'.repeat(120)}`);
    });

    it('clears the count once a snapshot succeeds', async () => {
      // The machine exit: one good snapshot, nothing persisted to clear.
      let broken = true;
      const readSnapshot = async () => {
        if (broken) throw new Error('both failed');
        return snapshot(implementation());
      };
      const runtime = () => ({
        ...deps(implementation(), []),
        snapshotFailureMode: 'report' as const,
        readSnapshot,
      });

      await runLifecycleCycle('recover', runtime());
      expect(unavailable(await runLifecycleCycle('recover', runtime()))).toHaveLength(1);
      broken = false;
      // Observed, so the good snapshot proves the reset without mutating.
      await runLifecycleCycle('observe', runtime());
      broken = true;
      expect(unavailable(await runLifecycleCycle('recover', runtime()))).toEqual([]);
    });

    it('tracks the stall per runtime, never across engines in one process', async () => {
      const first = failingRuntime();
      const second = failingRuntime();

      await runLifecycleCycle('recover', first());
      await runLifecycleCycle('recover', first());

      // A second engine's first no-snapshot cycle is its own first, not this one's third.
      expect(unavailable(await runLifecycleCycle('recover', second()))).toEqual([]);
    });
  });

  it('reports eventually-consistent counter skew as an approximation, not a per-cycle warning', async () => {
    // Regression (PR #2001): GitHub used/remaining counters are eventually
    // consistent, so under concurrent reads a cycle's usage accounting can be
    // incomplete even though every command succeeded. read() must not throw and
    // the cycle must still produce a report — otherwise the closing opaque probe
    // skew propagates out of runLifecycleCycle and kills the continuous loop.
    //
    // And it must not be reported as an ANOMALY. This fired on every single
    // live cycle, which is exactly how an operator learns to skip the line that
    // also carries the real gaps — and its "reported quota numbers are
    // best-effort" text was wrong for this cause: graphqlRemaining/resetAt come
    // straight off the probe responses and stay exact. Only the cost is soft.
    const meter = new GitHubUsageMeter();
    let probe = 0;
    const raw: CommandRunner = async (_command, args) => {
      if (args[0] !== 'api' || args[1] !== 'graphql') return 'edited';
      probe += 1;
      return JSON.stringify({
        data: {
          rateLimit: probe === 1
            ? { cost: 1, remaining: 1_000, resetAt: '2026-07-20T13:00:00.000Z', used: 0, limit: 5_000 }
            : { cost: 1, remaining: 990, resetAt: '2026-07-20T13:00:00.000Z', used: 12, limit: 5_000 },
        },
      });
    };
    const run = makeGitHubUsageCommandRunner(raw, meter);
    await expect(run('gh', ['project', 'item-edit'])).resolves.toBe('edited');
    expect(meter.read().accountingComplete).toBe(false);

    const report = await runLifecycleCycle('observe', {
      ...deps(implementation(), []),
      readGitHubUsage: () => meter.read(),
    });

    expect(report.status).toBe('ok');
    expect(report.githubUsage.accountingComplete).toBe(false);
    const human = renderLifecycleHuman(report);
    expect(human).toContain('GitHub usage accounting is approximate:');
    expect(human).toContain('graphqlCost is a lower bound');
    expect(human).not.toMatch(/WARNING: GitHub usage accounting/);
    // The prefix is an internal severity switch, not operator prose.
    expect(human).not.toContain(EXPECTED_ACCOUNTING_APPROXIMATION_PREFIX);
    // The flag is unchanged, so every existing consumer keeps its semantics.
    const json = JSON.parse(renderLifecycleJson(report));
    expect(json.githubUsage.accountingComplete).toBe(false);
  });

  it('still warns when a cycle genuinely failed to evidence its usage', async () => {
    // The counterpart to the test above: a real gap keeps the WARNING, so
    // downgrading the expected approximation does not silence the line the
    // operator relies on to know whether quota numbers can be trusted.
    const meter = new GitHubUsageMeter();
    meter.markIncomplete('the closing opaque-command quota probe failed');

    const report = await runLifecycleCycle('observe', {
      ...deps(implementation(), []),
      readGitHubUsage: () => meter.read(),
    });

    expect(report.status).toBe('ok');
    const human = renderLifecycleHuman(report);
    expect(human).toContain('WARNING: GitHub usage accounting is incomplete');
    expect(human).toContain('closing opaque-command quota probe failed');
    expect(human).toContain('reported quota numbers are best-effort');
  });

  it('cannot claim work from a fallback that forges a fresh full-reconciliation marker', async () => {
    const eligible: LifecycleItem = {
      kind: 'issue',
      issueNumber: 42,
      v2Marked: false,
      projectStatus: 'Todo',
      labels: [],
      eligible: true,
      eligibilityReason: 'eligible',
      eligibilityDetail: 'selected',
    };
    const candidate = snapshot(eligible);
    const coordinator = new LifecycleSnapshotCoordinator({
      source: {
        async read(options) {
          if (options.mode === 'full') throw new Error('full failed');
          return {
            ...candidate,
            snapshotMode: 'incremental',
            capturedAt: NOW.toISOString(),
            lastFullReconciliationAt: NOW.toISOString(),
          };
        },
      },
      configuredMode: 'incremental',
      fullReconcileMs: 60 * 60_000,
      startupFull: true,
      allowPartial: false,
      now: () => NOW,
    });
    const actions: string[] = [];
    const writes: string[] = [];
    const report = await runLifecycleCycle('active', {
      ...deps(eligible, writes),
      snapshotFailureMode: 'report',
      readSnapshot: (floor) => coordinator.read(floor ?? 500),
      active: {
        preflight: async () => ({ ok: true }),
        readLocalState: () => ({
          remaining: { implementation: 1, child: 1, review: 1, mergePrep: 1 },
          availableLogins: ['bot'],
          implementationPreferredLogin: 'bot',
        }),
        implementationBackpressureThreshold: 10,
        executeAction: async (action) => {
          actions.push(action.kind);
          return { outcome: 'spawned' };
        },
      },
    });

    expect(report).toMatchObject({
      status: 'failed',
      mutationFree: true,
      usageAccounting: {
        complete: false,
        reason: expect.stringMatching(/usage meter is unavailable/i),
      },
    });
    expect(report).not.toHaveProperty('githubUsage');
    expect(actions).toEqual([]);
    expect(writes).toEqual([]);
  });

  it.each([
    '2026-07-20T10:00:00+00:00',
    '2026-07-20 10:00:00.000Z',
    '2026-02-30T10:00:00.000Z',
    '2026-07-20T24:00:00.000Z',
    '2026-07-20T10:00:00.0000Z',
  ])('fails closed for non-canonical last-full timestamp %s', (timestamp) => {
    expect(fullReconciliationAllowsNewClaims(timestamp, NOW)).toBe(false);
  });

  it('renders full/incremental parity differences in human and JSON status', async () => {
    const current = snapshot(implementation());
    const report = await runLifecycleCycle('observe', {
      ...deps(implementation(), []),
      readSnapshot: async () => ({
        ...current,
        snapshotWarning: 'Full reconciliation failed and remains due: oracle drift',
        parityDifferences: [{
          subject: 'issue:42',
          incremental: '{"eligible":true}',
          full: '{"eligible":false}',
        }],
      }),
    });

    expect(report).toMatchObject({ parityDifferences: [{ subject: 'issue:42' }] });
    expect(renderLifecycleHuman(report)).toContain('Parity differences: 1 (issue:42).');
    expect(renderLifecycleHuman(report)).toContain(
      'WARNING: Full reconciliation failed and remains due: oracle drift.',
    );
    expect(renderLifecycleJson(report)).toContain('"parityDifferences"');
    expect(renderLifecycleJson(report)).toContain('"snapshotWarning"');
  });

  it('renders an explicit unavailable parity reason without changing lifecycle items', async () => {
    const current = snapshot(implementation());
    const baseline = await runLifecycleCycle('observe', deps(implementation(), []));
    const report = await runLifecycleCycle('observe', {
      ...deps(implementation(), []),
      readSnapshot: async () => ({
        ...current,
        parityUnavailableReason: 'open PR index changed during the parity oracle',
      }),
    });

    expect(report).toMatchObject({
      status: 'ok',
      parityUnavailableReason: 'open PR index changed during the parity oracle',
    });
    expect(report.items).toEqual(baseline.items);
    expect(renderLifecycleHuman(report)).toContain(
      'Parity comparison: unavailable (open PR index changed during the parity oracle).',
    );
    expect(JSON.parse(renderLifecycleJson(report))).toMatchObject({
      parityUnavailableReason: 'open PR index changed during the parity oracle',
      items: [{ issueNumber: 42, prNumber: 101 }],
    });
  });

  it.skip('observe reports desired actions without any writer call', async () => {
    const calls: string[] = [];
    const report = await runLifecycleCycle('observe', deps(implementation(), calls));

    expect(report.status).toBe('ok');
    expect(calls).toEqual([]);
    expect(report.items[0]).toMatchObject({
      phase: 'implementing',
      issueNumber: 42,
      prNumber: 101,
      head: HEAD,
      claimGeneration: '11111111-1111-4111-8111-111111111111',
      progressAgeMs: 60 * 60 * 1000,
      desiredActions: [
        { kind: 'set-project-status' },
        { kind: 'set-pr-draft' },
      ],
    });
  });

  it('surfaces snapshot completeness, reconciliation time, and GitHub usage in JSON and human output', async () => {
    const report = await runLifecycleCycle('observe', deps(implementation(), []));

    expect(report).toMatchObject({
      snapshotMode: 'full',
      snapshotComplete: true,
      lastFullReconciliationAt: NOW.toISOString(),
      githubUsage: {
        graphqlRequests: 3,
        graphqlCost: 21,
        graphqlRemaining: 3_979,
        restRequests: 4,
        restNotModified: 1,
        cacheHits: 2,
      },
    });
    expect(JSON.parse(renderLifecycleJson(report))).toMatchObject({
      snapshotMode: 'full',
      lastFullReconciledAt: NOW.toISOString(),
      githubUsage: {
        graphqlCost: 21,
        graphqlPoints: 21,
      },
    });
    expect(renderLifecycleHuman(report)).toContain(
      'Snapshot: full (complete), captured 2026-07-20T12:00:00.000Z, last full reconciliation 2026-07-20T12:00:00.000Z.',
    );
    expect(renderLifecycleHuman(report)).toContain(
      'GitHub usage: GraphQL 21 points across 3 evidence requests, 3979 remaining; REST 4 requests, 1 not modified, 2 cache hits.',
    );
  });

  it('retains the absolute 500-point controller floor when configured lower', async () => {
    const calls: string[] = [];
    const low = snapshot(implementation());
    const report = await runLifecycleCycle('observe', {
      ...deps(implementation(), calls),
      rateLimitFloor: 100,
      readSnapshot: async () => ({
        ...low,
        githubUsage: { ...low.githubUsage!, graphqlRemaining: 499 },
        project: {
          ...low.project,
          rateLimit: { ...low.project.rateLimit, remaining: 4_999 },
        },
      }),
    });

    expect(report).toMatchObject({ status: 'rate-limited' });
    expect(calls).toEqual([]);
  });

  it('never substitutes REST core remaining for authoritative GraphQL remaining', async () => {
    const calls: string[] = [];
    const current = snapshot(implementation());
    const report = await runLifecycleCycle('observe', {
      ...deps(implementation(), calls),
      readSnapshot: async () => ({
        ...current,
        project: {
          ...current.project,
          rateLimit: { ...current.project.rateLimit, remaining: 1 },
        },
        githubUsage: { ...current.githubUsage!, graphqlRemaining: 3_979 },
      }),
    });

    expect(report).toMatchObject({ status: 'ok' });
  });

  it.skip('recover applies projection only and emits structured safe events', async () => {
    const calls: string[] = [];
    let status: 'Todo' | 'In Progress' = 'Todo';
    let draft = false;
    const writer: ReconciliationWriter = {
      ...throwingWriter(calls),
      readIssueHead: async () => HEAD,
      readProjectStatus: async () => status,
      setProjectStatus: async (_issue, desired) => {
        calls.push('setProjectStatus');
        status = desired as typeof status;
      },
      readPullRequest: async () => ({ head: HEAD, draft, labels: [] }),
      setPullRequestDraft: async (_pr, desired) => {
        calls.push('setPullRequestDraft');
        draft = desired;
      },
    };

    const report = await runLifecycleCycle('recover', deps(implementation(), calls, writer));

    expect(calls).toEqual(['setProjectStatus', 'setPullRequestDraft']);
    expect(report.events).toEqual([
      expect.objectContaining({
        cycleId: 'cycle-1',
        runnerId: 'runner-a',
        mode: 'recover',
        phase: 'implementing',
        subject: 'issue:42/pr:101',
        head: HEAD,
        action: 'set-project-status',
        outcome: 'applied',
      }),
      expect.objectContaining({
        action: 'set-pr-draft',
        outcome: 'applied',
      }),
    ]);
    expect(JSON.stringify(report.events)).not.toMatch(/token/i);
  });

  it.skip('makes two recover controllers planning the same correction converge', async () => {
    const calls: string[] = [];
    let status: 'Todo' | 'In Progress' = 'Todo';
    let draft = false;
    const writer: ReconciliationWriter = {
      ...throwingWriter(calls),
      readIssueHead: async () => HEAD,
      readProjectStatus: async () => status,
      setProjectStatus: async (_issue, desired) => {
        calls.push('setProjectStatus');
        status = desired as typeof status;
      },
      readPullRequest: async () => ({ head: HEAD, draft, labels: [] }),
      setPullRequestDraft: async (_pr, desired) => {
        calls.push('setPullRequestDraft');
        draft = desired;
      },
    };
    const controller = deps(implementation(), calls, writer);

    const first = await runLifecycleCycle('recover', controller);
    const second = await runLifecycleCycle('recover', controller);

    expect(first.events.map((event) => event.outcome)).toEqual(['applied', 'applied']);
    expect(second.events.map((event) => event.outcome)).toEqual([
      'already-applied',
      'already-applied',
    ]);
    expect(calls).toEqual(['setProjectStatus', 'setPullRequestDraft']);
  });

  it('rejects active mode before reading or writing', async () => {
    const calls: string[] = [];
    const controller = deps(implementation(), calls);
    controller.readSnapshot = async () => {
      calls.push('readSnapshot');
      return snapshot(implementation());
    };

    const report = await runLifecycleCycle('active', controller);

    expect(report).toMatchObject({
      status: 'rejected',
      message: 'active executor not configured',
    });
    expect(calls).toEqual([]);
  });

  it('suppresses only new active claims when the last full reconciliation is absent or older than two hours', async () => {
    const eligible: LifecycleItem = {
      kind: 'issue',
      issueNumber: 42,
      v2Marked: false,
      projectStatus: 'Todo',
      labels: [],
      eligible: true,
      eligibilityReason: 'eligible',
      eligibilityDetail: 'selected',
    };
    const actions: string[] = [];
    const reconciliation: string[] = [];
    const writer = throwingWriter(reconciliation);
    const active = {
      preflight: async () => ({ ok: true }),
      readLocalState: () => ({
        remaining: { implementation: 1, child: 1, review: 1 },
        availableLogins: ['bot'],
        implementationPreferredLogin: 'bot',
      }),
      implementationBackpressureThreshold: 10,
      executeAction: async (action: { kind: string }) => {
        actions.push(action.kind);
        return { outcome: 'spawned' };
      },
    };
    const runAt = async (lastFullReconciliationAt: string | null) => {
      actions.length = 0;
      const current = snapshot(eligible);
      const report = await runLifecycleCycle('active', {
        ...deps(eligible, reconciliation, writer),
        active,
        readSnapshot: async () => ({ ...current, lastFullReconciliationAt }),
      });
      return { report, actions: [...actions] };
    };

    expect((await runAt(null)).actions).toEqual([]);
    expect((await runAt('2026-07-20T09:59:59.999Z')).actions).toEqual([]);
    expect((await runAt('2026-07-20T10:00:00.000Z')).actions)
      .toEqual(['claim-implementation']);
    expect(reconciliation).toEqual([]);
    expect((await runAt(null)).report.events).toContainEqual(expect.objectContaining({
      action: 'schedule',
      outcome: 'skipped',
      reason: 'full-reconciliation-stale',
    }));
  });

  it('enrolls a fresh review for a delivered non-draft PR (DELIVERED → IN REVIEW)', async () => {
    // Regression: single-surface lifecycle §4 mandates the active loop schedule
    // a review claim (review-ref CAS) for a DELIVERED PR — non-draft ∧
    // engine:review ∧ needsReview ∧ no verdict for the head. activeCandidates
    // only enrolled stale-draft recovery and the approved integration ladder,
    // so a freshly delivered non-draft PR sat at awaiting-review forever and the
    // review → approve → merge half never ran. The correct predicate already
    // lived in reviewEnrollmentEligible (planCycle), but planCycle is unused by
    // the v2 controller.
    const delivered = implementation({
      branchClaim: {
        kind: 'branch-claim',
        protocolVersion: 2,
        phase: 'implement',
        issueNumber: 42,
        prNumber: 101,
        attempt: '11111111-1111-4111-8111-111111111111',
        runner: 'runner-a',
        login: 'implementer',
        expectedHead: HEAD,
        targetBase: gitRefName('next'),
        claimedAt: '2026-07-20T11:00:00.000Z',
        phaseComplete: true,
      },
      isDraft: false,
      needsReview: true,
      approved: false,
    });

    // Fixture self-check: a phase-complete, non-draft PR with no verdict must
    // derive to awaiting-review (the DELIVERED state), not implementing.
    const observed = await runLifecycleCycle('observe', deps(delivered, []));
    expect(observed.items[0]).toMatchObject({ prNumber: 101, phase: 'awaiting-review' });

    const scheduled: { kind: string; prNumber?: number }[] = [];
    const report = await runLifecycleCycle('active', {
      ...deps(delivered, []),
      active: {
        preflight: async () => ({ ok: true }),
        readLocalState: () => ({
          remaining: { implementation: 1, child: 1, review: 1 },
          availableLogins: ['reviewer-bot'], // ≠ pr.author ('trusted')
          implementationPreferredLogin: 'reviewer-bot',
        }),
        implementationBackpressureThreshold: 10,
        executeAction: async (action: { kind: string; prNumber?: number }) => {
          scheduled.push({ kind: action.kind, prNumber: action.prNumber });
          return { outcome: 'spawned' };
        },
      },
    });

    expect(report.status).toBe('ok');
    expect(scheduled).toContainEqual(
      expect.objectContaining({ kind: 'claim-review', prNumber: 101 }),
    );
  });

  it('never schedules an action from explicitly incomplete PR evidence', async () => {
    const delivered = implementation({
      branchClaim: {
        ...implementation().branchClaim,
        phaseComplete: true,
      },
      isDraft: false,
      needsReview: true,
      approved: false,
    });
    const incomplete = snapshot(delivered);
    incomplete.pullRequests[0]!.evidenceIncompleteReason =
      'PR #101 reviews were truncated';
    const scheduled: string[] = [];

    await runLifecycleCycle('active', {
      ...deps(delivered, []),
      readSnapshot: async () => incomplete,
      active: {
        preflight: async () => ({ ok: true }),
        readLocalState: () => ({
          remaining: { implementation: 1, child: 1, review: 1 },
          availableLogins: ['reviewer-bot'],
          implementationPreferredLogin: 'reviewer-bot',
        }),
        implementationBackpressureThreshold: 10,
        executeAction: async (action: { kind: string }) => {
          scheduled.push(action.kind);
          return { outcome: 'spawned' };
        },
      },
    });

    expect(scheduled).toEqual([]);
  });

  it('dispatches from scoped authority before reading and maintaining the global snapshot', async () => {
    const delivered = implementation({
      branchClaim: {
        ...implementation().branchClaim,
        phaseComplete: true,
      },
      projectStatus: 'In Review',
    });
    const reviewing = implementation({
      ...delivered,
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer-bot',
        head: HEAD,
        state: 'active',
        recordedAt: NOW.toISOString(),
      },
    });
    const order: string[] = [];
    let claimed = false;
    let resets = 0;
    const base = deps(delivered, [], new Proxy({} as ReconciliationWriter, {
      get() {
        return async () => null;
      },
    }));
    const report = await runLifecycleCycle('active', {
      ...base,
      resetGitHubUsage: () => { resets += 1; },
      readScopedSnapshot: async (issueNumbers) => {
        order.push(`scoped:${[...issueNumbers].join(',')}`);
        return {
          ...snapshot(delivered),
          snapshotMode: 'incremental',
          snapshotAuthority: 'scoped',
          scopedIssueNumbers: [42],
          globalOpenPipelineBacklog: 1,
        };
      },
      readSnapshot: async () => {
        order.push('global');
        expect(claimed).toBe(true);
        return snapshot(reviewing);
      },
      active: {
        preflight: async () => ({ ok: true }),
        readLocalState: () => ({
          remaining: { implementation: 1, child: 1, review: 1 },
          availableLogins: ['reviewer-bot'],
          implementationPreferredLogin: 'reviewer-bot',
        }),
        implementationBackpressureThreshold: 10,
        onlyIssues: new Set([42]),
        executeAction: async (action) => {
          order.push(action.kind);
          claimed = true;
          return { outcome: 'spawned' };
        },
      },
    });

    expect(order).toEqual(['scoped:42', 'claim-review', 'global']);
    expect(resets).toBe(1);
    expect(report.events.filter((event) => event.action === 'claim-review')).toHaveLength(1);
    expect(report.items).toContainEqual(expect.objectContaining({
      issueNumber: 42,
      prNumber: 101,
      phase: 'reviewing',
    }));
  });

  it('uses global scoped backlog for fresh work without blocking child or stale recovery', async () => {
    const eligible: LifecycleItem = {
      kind: 'issue',
      issueNumber: 42,
      v2Marked: false,
      projectStatus: 'Todo',
      labels: [],
      eligible: true,
      eligibilityReason: 'eligible',
      eligibilityDetail: 'All implementation admission gates pass',
    };
    const ineligible: LifecycleItem = {
      ...eligible,
      eligible: false,
      eligibilityReason: 'dependency-blocked',
      eligibilityDetail: 'Not selected in the mandatory global pass',
    };
    const stale = implementation({
      headChangedAt: '2026-07-20T08:00:00.000Z',
      isDraft: true,
      projectStatus: 'In Progress',
    });
    const cases = [
      {
        label: 'fresh top-level',
        item: eligible,
        issues: [],
        expectedActions: [],
      },
      {
        label: 'fresh machine child',
        item: eligible,
        issues: [{
          number: 42,
          body: '<!-- jinn-autopilot:child pr=99 kind=review-finding -->',
          labels: [],
        }],
        expectedActions: ['claim-implementation'],
      },
      {
        label: 'stale recovery',
        item: stale,
        issues: [],
        expectedActions: ['claim-implementation'],
      },
    ] as const;

    for (const scenario of cases) {
      const actions: string[] = [];
      const scoped = {
        ...snapshot(scenario.item),
        issues: scenario.issues,
        snapshotMode: 'incremental' as const,
        snapshotAuthority: 'scoped' as const,
        scopedIssueNumbers: [42],
        globalOpenPipelineBacklog: 5,
      };
      const report = await runLifecycleCycle('active', {
        ...deps(eligible, [], new Proxy({} as ReconciliationWriter, {
          get() {
            return async () => null;
          },
        })),
        readScopedSnapshot: async () => scoped,
        readSnapshot: async () => snapshot(ineligible),
        active: {
          preflight: async () => ({ ok: true }),
          readLocalState: () => ({
            remaining: { implementation: 1, child: 1, review: 0 },
            availableLogins: ['implementer'],
            implementationPreferredLogin: 'implementer',
          }),
          implementationBackpressureThreshold: 1,
          onlyIssues: new Set([42]),
          executeAction: async (action) => {
            actions.push(action.kind);
            return { outcome: 'spawned' };
          },
        },
      });

      expect(actions, scenario.label).toEqual(scenario.expectedActions);
      if (scenario.label === 'fresh top-level') {
        expect(report.events).toContainEqual(expect.objectContaining({
          action: 'schedule',
          outcome: 'skipped',
          reason: 'backpressure',
        }));
      }
    }
  });

  it('reports scoped mutations and combined usage when the mandatory global read fails', async () => {
    const delivered = implementation({
      branchClaim: {
        ...implementation().branchClaim,
        phaseComplete: true,
      },
      projectStatus: 'In Review',
    });
    let actionCalls = 0;
    const combinedUsage: GitHubUsage = {
      graphqlRequests: 4,
      graphqlCost: 32,
      graphqlRemaining: 3_968,
      graphqlResetAt: '2026-07-20T13:00:00.000Z',
      restRequests: 7,
      restNotModified: 0,
      cacheHits: 1,
      accountingComplete: true,
    };
    const report = await runLifecycleCycle('active', {
      ...deps(delivered, [], new Proxy({} as ReconciliationWriter, {
        get() {
          return async () => null;
        },
      })),
      snapshotFailureMode: 'report',
      readGitHubUsage: () => combinedUsage,
      readScopedSnapshot: async () => ({
        ...snapshot(delivered),
        snapshotMode: 'incremental',
        snapshotAuthority: 'scoped',
        scopedIssueNumbers: [42],
        globalOpenPipelineBacklog: 1,
      }),
      readSnapshot: async () => {
        throw new Error('global incremental unavailable');
      },
      active: {
        preflight: async () => ({ ok: true }),
        readLocalState: () => ({
          remaining: { implementation: 0, child: 0, review: 1 },
          availableLogins: ['reviewer-bot'],
          implementationPreferredLogin: 'reviewer-bot',
        }),
        implementationBackpressureThreshold: 10,
        onlyIssues: new Set([42]),
        executeAction: async () => {
          actionCalls += 1;
          return { outcome: 'spawned' };
        },
      },
    });

    expect(actionCalls).toBe(1);
    expect(report).toMatchObject({
      status: 'failed',
      mutationFree: false,
      githubUsage: combinedUsage,
    });
    expect(report.events).toContainEqual(expect.objectContaining({
      action: 'claim-review',
      outcome: 'spawned',
    }));
    expect(report.message).toMatch(/global.*failed after scoped pre-dispatch/i);
    const human = renderLifecycleHuman(report);
    expect(human).toMatch(/mutation-free: no/i);
    expect(human).toContain('claim-review issue:42/pr:101: spawned.');
    expect(human).toMatch(/reconciliation results retained: 0/i);
    const json = JSON.parse(renderLifecycleJson(report));
    expect(json).toMatchObject({
      status: 'failed',
      mutationFree: false,
      events: [expect.objectContaining({
        action: 'claim-review',
        outcome: 'spawned',
      })],
      reconciliation: { results: [] },
    });
  });

  it('does not hide scoped mutations behind an incomplete global snapshot gate', async () => {
    const delivered = implementation({
      branchClaim: {
        ...implementation().branchClaim,
        phaseComplete: true,
      },
      projectStatus: 'In Review',
    });
    const report = await runLifecycleCycle('active', {
      ...deps(delivered, [], new Proxy({} as ReconciliationWriter, {
        get() {
          return async () => null;
        },
      })),
      readGitHubUsage: () => ({
        ...snapshot(delivered).githubUsage!,
        restRequests: 9,
        accountingComplete: true,
      }),
      readScopedSnapshot: async () => ({
        ...snapshot(delivered),
        snapshotMode: 'incremental',
        snapshotAuthority: 'scoped',
        scopedIssueNumbers: [42],
        globalOpenPipelineBacklog: 1,
      }),
      readSnapshot: async () => ({
        ...snapshot(delivered),
        snapshotComplete: false,
      }),
      active: {
        preflight: async () => ({ ok: true }),
        readLocalState: () => ({
          remaining: { implementation: 0, child: 0, review: 1 },
          availableLogins: ['reviewer-bot'],
          implementationPreferredLogin: 'reviewer-bot',
        }),
        implementationBackpressureThreshold: 10,
        onlyIssues: new Set([42]),
        executeAction: async () => ({ outcome: 'spawned' }),
      },
    });

    expect(report).toMatchObject({
      status: 'failed',
      mutationFree: false,
      githubUsage: { restRequests: 9 },
    });
    expect(report.events).toContainEqual(expect.objectContaining({
      action: 'claim-review',
      outcome: 'spawned',
    }));
  });

  it('does not hide scoped mutations when the global read reaches its rate-limit reserve', async () => {
    const delivered = implementation({
      branchClaim: {
        ...implementation().branchClaim,
        phaseComplete: true,
      },
      projectStatus: 'In Review',
    });
    const report = await runLifecycleCycle('active', {
      ...deps(delivered, [], new Proxy({} as ReconciliationWriter, {
        get() {
          return async () => null;
        },
      })),
      readGitHubUsage: () => ({
        ...snapshot(delivered).githubUsage!,
        graphqlRemaining: 999,
        restRequests: 11,
        accountingComplete: true,
      }),
      readScopedSnapshot: async () => ({
        ...snapshot(delivered),
        snapshotMode: 'incremental',
        snapshotAuthority: 'scoped',
        scopedIssueNumbers: [42],
        globalOpenPipelineBacklog: 1,
      }),
      readSnapshot: async () => {
        throw new LifecycleRateLimitError(999, 1_000, 0);
      },
      active: {
        preflight: async () => ({ ok: true }),
        readLocalState: () => ({
          remaining: { implementation: 0, child: 0, review: 1 },
          availableLogins: ['reviewer-bot'],
          implementationPreferredLogin: 'reviewer-bot',
        }),
        implementationBackpressureThreshold: 10,
        onlyIssues: new Set([42]),
        executeAction: async () => ({ outcome: 'spawned' }),
      },
    });

    expect(report).toMatchObject({
      status: 'failed',
      mutationFree: false,
      githubUsage: { graphqlRemaining: 999, restRequests: 11 },
    });
    expect(report.events).toContainEqual(expect.objectContaining({
      action: 'claim-review',
      outcome: 'spawned',
    }));
  });

  it('does not hide scoped mutations behind insufficient global rate-limit evidence', async () => {
    const delivered = implementation({
      branchClaim: {
        ...implementation().branchClaim,
        phaseComplete: true,
      },
      projectStatus: 'In Review',
    });
    const report = await runLifecycleCycle('active', {
      ...deps(delivered, [], new Proxy({} as ReconciliationWriter, {
        get() {
          return async () => null;
        },
      })),
      readGitHubUsage: () => ({
        ...snapshot(delivered).githubUsage!,
        graphqlRemaining: 499,
        restRequests: 13,
        accountingComplete: true,
      }),
      readScopedSnapshot: async () => ({
        ...snapshot(delivered),
        snapshotMode: 'incremental',
        snapshotAuthority: 'scoped',
        scopedIssueNumbers: [42],
        globalOpenPipelineBacklog: 1,
      }),
      readSnapshot: async () => ({
        ...snapshot(delivered),
        githubUsage: {
          ...snapshot(delivered).githubUsage!,
          graphqlRemaining: 499,
        },
      }),
      active: {
        preflight: async () => ({ ok: true }),
        readLocalState: () => ({
          remaining: { implementation: 0, child: 0, review: 1 },
          availableLogins: ['reviewer-bot'],
          implementationPreferredLogin: 'reviewer-bot',
        }),
        implementationBackpressureThreshold: 10,
        onlyIssues: new Set([42]),
        executeAction: async () => ({ outcome: 'spawned' }),
      },
    });

    expect(report).toMatchObject({
      status: 'failed',
      mutationFree: false,
      githubUsage: { graphqlRemaining: 499, restRequests: 13 },
    });
    expect(report.events).toContainEqual(expect.objectContaining({
      action: 'claim-review',
      outcome: 'spawned',
    }));
  });

  it('reports a bounded review cohort in deterministic scheduled order', async () => {
    const first = implementation({
      branchClaim: {
        ...implementation().branchClaim,
        phaseComplete: true,
      },
      projectStatus: 'In Review',
    });
    const secondHead = gitOid('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const second = implementation({
      issueNumber: 43,
      prNumber: 102,
      head: secondHead,
      branchClaim: {
        ...implementation().branchClaim,
        issueNumber: 43,
        prNumber: 102,
        expectedHead: secondHead,
        phaseComplete: true,
      },
      projectStatus: 'In Review',
    });
    const firstSnapshot = snapshot(first);
    const world: GitHubLifecycleSnapshot = {
      ...firstSnapshot,
      pullRequests: [
        firstSnapshot.pullRequests[0],
        {
          ...firstSnapshot.pullRequests[0],
          number: 102,
          body: 'Closes #43',
          headRefName: 'autopilot/43',
          headOid: secondHead,
          closingIssueNumbers: [43],
          branchClaim: second.branchClaim,
        },
      ],
      lifecycle: { items: [first, second] },
    };
    const cohortCalls: number[][] = [];
    const report = await runLifecycleCycle('active', {
      ...deps(first, [], new Proxy({} as ReconciliationWriter, {
        get() {
          return async () => null;
        },
      })),
      readSnapshot: async () => world,
      active: {
        preflight: async () => ({ ok: true }),
        readLocalState: () => ({
          remaining: { implementation: 0, child: 0, review: 2 },
          availableLogins: ['reviewer-bot'],
          implementationPreferredLogin: 'reviewer-bot',
        }),
        implementationBackpressureThreshold: 10,
        executeAction: async () => {
          throw new Error('review cohort must not use the sequential action port');
        },
        executeReviewActions: async (actions) => {
          cohortCalls.push(actions.map((action) => action.prNumber));
          return [
            { outcome: 'spawned' },
            { outcome: 'failed', reason: 'isolated failure' },
          ];
        },
      },
    });

    expect(cohortCalls).toEqual([[101, 102]]);
    expect(report.events.filter((event) => event.action === 'claim-review')).toEqual([
      expect.objectContaining({ subject: 'issue:42/pr:101', outcome: 'spawned' }),
      expect.objectContaining({
        subject: 'issue:43/pr:102',
        outcome: 'failed',
        reason: 'isolated failure',
      }),
    ]);
  });

  it('keeps merge-ready visible but never constructs an enqueue under manual policy', async () => {
    const mergeReady = implementation({
      projectStatus: 'In Review',
      approved: true,
      needsReview: false,
      mergeState: 'clean',
      // Merge-ready needs the engine's own signed approval bound to this exact
      // head, not just GitHub's native APPROVED state.
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'review-bot',
        head: HEAD,
        state: 'terminal-approved',
        recordedAt: '2026-07-20T11:00:00.000Z',
        verdict: {
          marker: '44444444-4444-4444-8444-444444444444',
          state: 'APPROVE',
        },
      },
      terminalVerdict: {
        head: HEAD,
        state: 'APPROVE',
        marker: '44444444-4444-4444-8444-444444444444',
        recordedAt: '2026-07-20T11:00:00.000Z',
      },
      branchClaim: {
        kind: 'branch-claim',
        protocolVersion: 2,
        phase: 'implement',
        phaseComplete: true,
        issueNumber: 42,
        prNumber: 101,
        attempt: '11111111-1111-4111-8111-111111111111',
        runner: 'runner-a',
        login: 'implementer',
        expectedHead: HEAD,
        targetBase: gitRefName('next'),
        claimedAt: '2026-07-20T11:00:00.000Z',
      },
      checks: [{
        source: 'check-run',
        name: 'test',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
      }],
    });
    const actions: unknown[] = [];
    const noOpWriter = new Proxy({} as ReconciliationWriter, {
      get() {
        return async () => null;
      },
    });
    const active = {
      preflight: async () => ({ ok: true }),
      readLocalState: () => ({
        remaining: { implementation: 1, child: 1, review: 1 },
        availableLogins: ['implementation-bot'],
        implementationPreferredLogin: 'implementation-bot',
      }),
      implementationBackpressureThreshold: 10,
      executeAction: async (action: unknown) => {
        actions.push(action);
        return { outcome: 'spawned' };
      },
    };

    const manual = await runLifecycleCycle('active', {
      ...deps(mergeReady, [], noOpWriter),
      mergePolicy: 'manual',
      active,
    });
    expect(manual.items[0]).toMatchObject({ phase: 'merge-ready' });
    expect(actions).toEqual([]);

    await runLifecycleCycle('active', {
      ...deps(mergeReady, [], noOpWriter),
      mergePolicy: 'safe-auto',
      active,
    });
    expect(actions).toEqual([{
      kind: 'enqueue',
      issueNumber: 42,
      prNumber: 101,
      head: HEAD,
      expectedBaseRefName: 'next',
    }]);
  });

  it('re-enrolls review when GitHub carried an approval onto an unsigned head', async () => {
    // PR #2130 / #2081: the update-branch merge commit becomes the head and
    // GitHub re-points the prior APPROVED review onto it, so `approved` reads
    // true while the engine's signed claim is still bound to the old sha.
    const NEW_HEAD = gitOid('cccccccccccccccccccccccccccccccccccccccc');
    const carried = implementation({
      projectStatus: 'In Review',
      head: NEW_HEAD,
      approved: true,
      needsReview: false,
      mergeState: 'clean',
      branchClaim: undefined,
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'review-bot',
        head: HEAD,
        state: 'terminal-approved',
        recordedAt: '2026-07-20T11:00:00.000Z',
        verdict: {
          marker: '44444444-4444-4444-8444-444444444444',
          state: 'APPROVE',
        },
      },
      terminalVerdict: {
        head: HEAD,
        state: 'APPROVE',
        marker: '44444444-4444-4444-8444-444444444444',
        recordedAt: '2026-07-20T11:00:00.000Z',
      },
      checks: [{
        source: 'check-run',
        name: 'test',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
      }],
    });
    const actions: unknown[] = [];
    const noOpWriter = new Proxy({} as ReconciliationWriter, {
      get() {
        return async () => null;
      },
    });

    const report = await runLifecycleCycle('active', {
      ...deps(carried, [], noOpWriter),
      mergePolicy: 'safe-auto',
      active: {
        preflight: async () => ({ ok: true }),
        readLocalState: () => ({
          remaining: { implementation: 0, child: 0, review: 1 },
          availableLogins: ['review-bot'],
          implementationPreferredLogin: 'review-bot',
        }),
        implementationBackpressureThreshold: 10,
        executeAction: async (action: unknown) => {
          actions.push(action);
          return { outcome: 'spawned' };
        },
      },
    });

    expect(report.items[0]).toMatchObject({ phase: 'awaiting-review' });
    expect(actions).toEqual([{
      kind: 'claim-review',
      issueNumber: 42,
      prNumber: 101,
      head: NEW_HEAD,
    }]);
    expect(actions.some((action) => (action as { kind: string }).kind === 'enqueue')).toBe(false);
  });

  it('re-reviews a lapsed approval immediately even while the PR is behind', async () => {
    // #82 inverted this. The ladder used to go first, because re-reviewing a
    // behind PR would only be invalidated again by the `update-branch` that had
    // to follow it. Nothing moves the head under the approval any more — the
    // merge queue rebases its own candidate — so the re-review is simply the
    // next thing that has to happen, and it happens now.
    const NEW_HEAD = gitOid('cccccccccccccccccccccccccccccccccccccccc');
    const behind = implementation({
      projectStatus: 'In Review',
      head: NEW_HEAD,
      approved: true,
      needsReview: false,
      mergeState: 'behind',
      branchClaim: undefined,
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'review-bot',
        head: HEAD,
        state: 'terminal-approved',
        recordedAt: '2026-07-20T11:00:00.000Z',
        verdict: {
          marker: '44444444-4444-4444-8444-444444444444',
          state: 'APPROVE',
        },
      },
      checks: [{
        source: 'check-run',
        name: 'test',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
      }],
    });
    const actions: unknown[] = [];
    const noOpWriter = new Proxy({} as ReconciliationWriter, {
      get() {
        return async () => null;
      },
    });

    const behindSnapshot = snapshot(behind);
    behindSnapshot.pullRequests[0] = {
      ...behindSnapshot.pullRequests[0]!,
      mergeability: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      compareStatus: 'behind',
      checks: behind.checks!,
    };

    await runLifecycleCycle('active', {
      ...deps(behind, [], noOpWriter),
      readSnapshot: async () => behindSnapshot,
      mergePolicy: 'safe-auto',
      active: {
        preflight: async () => ({ ok: true }),
        readLocalState: () => ({
          remaining: { implementation: 0, child: 0, review: 1 },
          availableLogins: ['review-bot'],
          implementationPreferredLogin: 'review-bot',
        }),
        implementationBackpressureThreshold: 10,
        executeAction: async (action: unknown) => {
          actions.push(action);
          return { outcome: 'spawned' };
        },
      },
    });

    expect(actions).toEqual([{
      kind: 'claim-review',
      issueNumber: 42,
      prNumber: 101,
      head: NEW_HEAD,
    }]);
  });

  it('never moves a stacked PR head, however far behind its parent base it is', async () => {
    const clean = implementation({
      projectStatus: 'In Review',
      expectedBaseRefName: 'stack/custom-parent',
      approved: true,
      needsReview: false,
      mergeState: 'behind',
      branchClaim: {
        kind: 'branch-claim',
        protocolVersion: 2,
        phase: 'implement',
        phaseComplete: true,
        issueNumber: 42,
        prNumber: 101,
        attempt: '11111111-1111-4111-8111-111111111111',
        runner: 'runner-a',
        login: 'implementer',
        expectedHead: HEAD,
        targetBase: gitRefName('stack/custom-parent'),
        claimedAt: '2026-07-20T11:00:00.000Z',
      },
      checks: [{
        source: 'check-run',
        name: 'test',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
      }],
    });
    const actions: unknown[] = [];
    const noOpWriter = new Proxy({} as ReconciliationWriter, {
      get() {
        return async () => null;
      },
    });
    const active = {
      preflight: async () => ({ ok: true }),
      readLocalState: () => ({
        remaining: { implementation: 1, child: 1, review: 1 },
        availableLogins: ['implementation-bot'],
        implementationPreferredLogin: 'implementation-bot',
      }),
      implementationBackpressureThreshold: 10,
      executeAction: async (action: unknown) => {
        actions.push(action);
        return { outcome: 'spawned' };
      },
    };
    const behindSnapshot = snapshot(clean);
    behindSnapshot.pullRequests[0] = {
      ...behindSnapshot.pullRequests[0]!,
      baseRefName: 'stack/custom-parent',
      mergeability: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      compareStatus: 'behind',
      checks: clean.checks!,
    };

    await runLifecycleCycle('active', {
      ...deps(clean, [], noOpWriter),
      readSnapshot: async () => behindSnapshot,
      mergePolicy: 'safe-auto',
      active,
    });

    // The engine no longer owns catching a head up to its base; the queue does.
    // The lapsed approval is what still needs an action, and it gets one.
    expect(actions).toEqual([{
      kind: 'claim-review',
      issueNumber: 42,
      prNumber: 101,
      head: HEAD,
    }]);
    expect(actions.every(
      (action) => (action as { kind: string }).kind !== 'update-branch',
    )).toBe(true);
  });

  it('never enqueues when a CLEAN mergeability has exact unknown compare evidence', async () => {
    const clean = implementation({
      projectStatus: 'In Review',
      approved: true,
      needsReview: false,
      mergeState: 'clean',
      branchClaim: {
        kind: 'branch-claim',
        protocolVersion: 2,
        phase: 'implement',
        phaseComplete: true,
        issueNumber: 42,
        prNumber: 101,
        attempt: '11111111-1111-4111-8111-111111111111',
        runner: 'runner-a',
        login: 'implementer',
        expectedHead: HEAD,
        targetBase: gitRefName('next'),
        claimedAt: '2026-07-20T11:00:00.000Z',
      },
      checks: [{ source: 'check-run', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    });
    const actions: unknown[] = [];
    const writerCalls: string[] = [];
    const noOpWriter = new Proxy({} as ReconciliationWriter, {
      get(_target, property) {
        return async () => {
          writerCalls.push(String(property));
          return null;
        };
      },
    });
    const active = {
      preflight: async () => ({ ok: true }),
      readLocalState: () => ({
        remaining: { implementation: 1, child: 1, review: 1 },
        availableLogins: ['implementation-bot'],
        implementationPreferredLogin: 'implementation-bot',
      }),
      implementationBackpressureThreshold: 10,
      executeAction: async (action: unknown) => {
        actions.push(action);
        return { outcome: 'spawned' };
      },
    };
    const falseClean = snapshot(clean);
    falseClean.pullRequests[0] = {
      ...falseClean.pullRequests[0]!,
      mergeability: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      compareStatus: 'unknown',
      checks: clean.checks!,
    };

    await runLifecycleCycle('active', {
      ...deps(clean, [], noOpWriter),
      readSnapshot: async () => falseClean,
      mergePolicy: 'safe-auto',
      active,
    });

    // An unreadable compare cannot prove the head is enqueueable, so no enqueue
    // is constructed. The lapsed approval still earns its re-review.
    expect(actions).toEqual([{
      kind: 'claim-review',
      issueNumber: 42,
      prNumber: 101,
      head: HEAD,
    }]);
    expect(actions.every(
      (action) => (action as { kind: string }).kind !== 'enqueue',
    )).toBe(true);
    expect(writerCalls).toEqual([]);
  });

  it('retains the canonical parent base when a stacked PR needs reconciliation', async () => {
    const clean = implementation({
      projectStatus: 'In Review',
      expectedBaseRefName: 'stack/custom-parent',
      approved: true,
      needsReview: false,
      mergeState: 'conflict',
      branchClaim: {
        kind: 'branch-claim',
        protocolVersion: 2,
        phase: 'implement',
        phaseComplete: true,
        issueNumber: 42,
        prNumber: 101,
        attempt: '11111111-1111-4111-8111-111111111111',
        runner: 'runner-a',
        login: 'implementer',
        expectedHead: HEAD,
        targetBase: gitRefName('stack/custom-parent'),
        claimedAt: '2026-07-20T11:00:00.000Z',
      },
      checks: [{ source: 'check-run', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    });
    const actions: unknown[] = [];
    const noOpWriter = new Proxy({} as ReconciliationWriter, {
      get() {
        return async () => null;
      },
    });
    const active = {
      preflight: async () => ({ ok: true }),
      readLocalState: () => ({
        remaining: { implementation: 1, child: 1, review: 1 },
        availableLogins: ['implementation-bot'],
        implementationPreferredLogin: 'implementation-bot',
      }),
      implementationBackpressureThreshold: 10,
      executeAction: async (action: unknown) => {
        actions.push(action);
        return { outcome: 'spawned' };
      },
    };
    const falseClean = snapshot(clean);
    falseClean.pullRequests[0] = {
      ...falseClean.pullRequests[0]!,
      baseRefName: 'stack/custom-parent',
      mergeability: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      compareStatus: 'diverged',
      checks: clean.checks!,
    };

    await runLifecycleCycle('active', {
      ...deps(clean, [], noOpWriter),
      readSnapshot: async () => falseClean,
      mergePolicy: 'safe-auto',
      active,
    });

    expect(actions).toEqual([{
      kind: 'file-reconcile-child',
      issueNumber: 42,
      prNumber: 101,
      head: HEAD,
      expectedBaseRefName: 'stack/custom-parent',
      effort: 'medium',
    }]);
  });

  /**
   * #120, end to end. This is the live shape of mono #3060: approved, no
   * outstanding review, conflicted — and no CI at all, because a conflicted
   * head has no merge ref for GitHub to build a merge commit from, so no
   * `pull_request` workflow ever runs and the check rollup is literally empty.
   *
   * Both layers gated on CI before the conflict, and both had to move for this
   * to compose. `underlyingPhase` derived `ci-blocked`, which `activeCandidates`
   * never routes to the integration ladder (its branch takes `awaiting-review`
   * and `merge-ready` only), and the `ci-blocked` handler itself only schedules
   * on a *failed* classification — an empty rollup classifies as `missing`, so
   * it swallowed the pull request and scheduled nothing. Then the ladder,
   * reached at last, still had to answer the conflict before its own CI gate.
   *
   * Seven approved mono PRs sat in exactly this state, some since 2026-08-27.
   */
  it('files a reconcile child for an approved conflicted PR that has no CI at all', async () => {
    const conflictedWithoutCi = implementation({
      projectStatus: 'In Review',
      approved: true,
      needsReview: false,
      mergeState: 'conflict',
      branchClaim: {
        kind: 'branch-claim',
        protocolVersion: 2,
        phase: 'implement',
        phaseComplete: true,
        issueNumber: 42,
        prNumber: 101,
        attempt: '11111111-1111-4111-8111-111111111111',
        runner: 'runner-a',
        login: 'implementer',
        expectedHead: HEAD,
        targetBase: gitRefName('next'),
        claimedAt: '2026-07-20T11:00:00.000Z',
      },
      // total=0. Not failing checks — no checks, the way GitHub reports a head
      // it cannot compute a merge commit for.
      checks: [],
    });
    const actions: unknown[] = [];
    const noOpWriter = new Proxy({} as ReconciliationWriter, {
      get() {
        return async () => null;
      },
    });
    const active = {
      preflight: async () => ({ ok: true }),
      readLocalState: () => ({
        remaining: { implementation: 1, child: 1, review: 1 },
        availableLogins: ['implementation-bot'],
        implementationPreferredLogin: 'implementation-bot',
      }),
      implementationBackpressureThreshold: 10,
      executeAction: async (action: unknown) => {
        actions.push(action);
        return { outcome: 'spawned' };
      },
    };
    const dirty = snapshot(conflictedWithoutCi);
    dirty.pullRequests[0] = {
      ...dirty.pullRequests[0]!,
      mergeability: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      compareStatus: 'diverged',
      checks: [],
    };

    await runLifecycleCycle('active', {
      ...deps(conflictedWithoutCi, [], noOpWriter),
      readSnapshot: async () => dirty,
      mergePolicy: 'safe-auto',
      active,
    });

    expect(actions).toEqual([{
      kind: 'file-reconcile-child',
      issueNumber: 42,
      prNumber: 101,
      head: HEAD,
      expectedBaseRefName: 'next',
      effort: 'medium',
    }]);
    // Emphatically not a re-review. The approved branch of the phase
    // derivation excludes review enrollment by construction, and the ladder —
    // not the re-review rung — owns the next mutation while a head conflicts.
    expect(actions.every(
      (action) => (action as { kind: string }).kind !== 'claim-review',
    )).toBe(true);
  });

  /**
   * The CI gate is untouched for every head the conflict test does not answer.
   * A non-conflicted pull request *can* have CI, so red CI there is a real
   * refusal, and it must still park the PR in ci-blocked rather than reach the
   * ladder.
   */
  it('still holds an approved non-conflicted PR with red CI at ci-blocked', async () => {
    const redCi = implementation({
      projectStatus: 'In Review',
      approved: true,
      needsReview: false,
      mergeState: 'clean',
      branchClaim: {
        kind: 'branch-claim',
        protocolVersion: 2,
        phase: 'implement',
        phaseComplete: true,
        issueNumber: 42,
        prNumber: 101,
        attempt: '11111111-1111-4111-8111-111111111111',
        runner: 'runner-a',
        login: 'implementer',
        expectedHead: HEAD,
        targetBase: gitRefName('next'),
        claimedAt: '2026-07-20T11:00:00.000Z',
      },
      checks: [{
        source: 'check-run',
        name: 'test',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        runId: 7,
      }],
    });
    const actions: unknown[] = [];
    const noOpWriter = new Proxy({} as ReconciliationWriter, {
      get() {
        return async () => null;
      },
    });
    const active = {
      preflight: async () => ({ ok: true }),
      readLocalState: () => ({
        remaining: { implementation: 1, child: 1, review: 1 },
        availableLogins: ['implementation-bot'],
        implementationPreferredLogin: 'implementation-bot',
      }),
      implementationBackpressureThreshold: 10,
      executeAction: async (action: unknown) => {
        actions.push(action);
        return { outcome: 'spawned' };
      },
    };
    const clean = snapshot(redCi);
    clean.pullRequests[0] = {
      ...clean.pullRequests[0]!,
      mergeability: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      compareStatus: 'ahead',
      checks: redCi.checks!,
    };

    const report = await runLifecycleCycle('active', {
      ...deps(redCi, [], noOpWriter),
      readSnapshot: async () => clean,
      mergePolicy: 'safe-auto',
      active,
    });

    expect(report.items.find((item) => item.prNumber === 101)?.phase).toBe('ci-blocked');
    expect(actions.every(
      (action) => (action as { kind: string }).kind !== 'file-reconcile-child',
    )).toBe(true);
  });

  it.skip('reports legacy stale-looking items without reaping them', async () => {
    const calls: string[] = [];
    const legacy = implementation({
      v2Marked: false,
      branchClaim: undefined,
      headChangedAt: '2026-07-20T06:00:00.000Z',
      isDraft: false,
    });

    const report = await runLifecycleCycle('recover', deps(legacy, calls));

    expect(report.items[0]).toMatchObject({ stale: false, legacy: true });
    expect(report.items[0]?.desiredActions.some((action) => (
      action.kind === 'requeue-implementation'
      || action.kind === 'mark-review-stale'
    ))).toBe(false);
    expect(calls).toEqual([]);
  });

  it('renders JSON and explains issue and PR gate state', async () => {
    const calls: string[] = [];
    const report = await runLifecycleCycle('observe', deps(implementation(), calls));

    expect(JSON.parse(renderLifecycleJson(report))).toMatchObject({
      mode: 'observe',
      items: [{ issueNumber: 42, prNumber: 101, phase: 'implementing' }],
    });
    expect(explainIssue(report, 42)).toContain('implementing');
    expect(explainPullRequest(report, 101)).toContain('awaiting');
  });

  it('explains CI-blocked PRs without reporting that they are merged', async () => {
    const calls: string[] = [];
    const report = await runLifecycleCycle('observe', deps(implementation({
      approved: true,
      needsReview: false,
      branchClaim: {
        kind: 'branch-claim',
        protocolVersion: 2,
        phase: 'implement',
        phaseComplete: true,
        issueNumber: 42,
        prNumber: 101,
        attempt: '11111111-1111-4111-8111-111111111111',
        runner: 'runner-a',
        login: 'implementer',
        expectedHead: HEAD,
        targetBase: gitRefName('next'),
        claimedAt: '2026-07-20T11:00:00.000Z',
      },
      checks: [{
        source: 'check-run',
        name: 'test',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
      }],
    }), calls));

    expect(report.items[0]).toMatchObject({ phase: 'ci-blocked' });
    expect(explainPullRequest(report, 101)).toContain('CI');
    expect(explainPullRequest(report, 101)).not.toContain('is merged');
  });

  it('explains child-blocked PRs without reporting that they are merged', async () => {
    const calls: string[] = [];
    const report = await runLifecycleCycle('observe', deps(implementation({
      branchClaim: {
        kind: 'branch-claim',
        protocolVersion: 2,
        phase: 'implement',
        phaseComplete: true,
        issueNumber: 42,
        prNumber: 101,
        attempt: '11111111-1111-4111-8111-111111111111',
        runner: 'runner-a',
        login: 'implementer',
        expectedHead: HEAD,
        targetBase: gitRefName('next'),
        claimedAt: '2026-07-20T11:00:00.000Z',
      },
      openChildKinds: ['ci-failure'],
    }), calls));

    expect(report.items[0]).toMatchObject({ phase: 'blocked-by-child' });
    expect(explainPullRequest(report, 101)).toContain('child');
    expect(explainPullRequest(report, 101)).not.toContain('is merged');
  });

  it('reserves merged wording for merged PRs', async () => {
    const calls: string[] = [];
    const report = await runLifecycleCycle('observe', deps(implementation({ merged: true }), calls));

    expect(report.items[0]).toMatchObject({ phase: 'merged' });
    expect(explainPullRequest(report, 101)).toContain('is merged');
  });

  it('rejects trailing positional arguments for every operator command', () => {
    expect(() => parseLifecycleCli(['status', 'extra'])).toThrow(/Expected status/);
    expect(() => parseLifecycleCli(['sessions', 'extra'])).toThrow(/Expected status/);
    expect(() => parseLifecycleCli(['explain', 'issue', '42', 'extra'])).toThrow(
      /Expected status/,
    );
  });

  it('does not describe an ineligible no-PR issue as claim eligible', async () => {
    const calls: string[] = [];
    const blocked: LifecycleItem = {
      kind: 'issue',
      issueNumber: 42,
      v2Marked: false,
      projectStatus: 'Todo',
      labels: [],
      eligible: false,
      eligibilityReason: 'dependency-blocked',
      eligibilityDetail: 'Blocked by unresolved issue #41',
    };

    const report = await runLifecycleCycle('observe', deps(blocked, calls));

    expect(report.items[0]).toMatchObject({
      issueNumber: 42,
      eligible: false,
      eligibilityReason: 'dependency-blocked',
    });
    expect(explainIssue(report, 42)).toContain('not eligible');
    expect(explainIssue(report, 42)).toContain('Blocked by unresolved issue #41');
  });

  it('uses a later matching terminal verdict as the progress age', async () => {
    const calls: string[] = [];
    const reviewed = implementation({
      branchClaim: undefined,
      headChangedAt: '2026-07-20T08:00:00.000Z',
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD,
        state: 'verdict-intent',
        recordedAt: '2026-07-20T08:00:00.000Z',
        verdict: {
          marker: '44444444-4444-4444-8444-444444444444',
          state: 'REQUEST_CHANGES',
        },
      },
      terminalVerdict: {
        head: HEAD,
        marker: '44444444-4444-4444-8444-444444444444',
        state: 'REQUEST_CHANGES',
        recordedAt: '2026-07-20T11:30:00.000Z',
      },
    });

    const report = await runLifecycleCycle('observe', deps(reviewed, calls));

    expect(report.items[0]?.progressAgeMs).toBe(30 * 60 * 1000);
  });

  it.skip('carries Project Human evidence through orphan-claim recovery planning', async () => {
    const calls: string[] = [];
    const heldIssue: LifecycleItem = {
      kind: 'issue',
      issueNumber: 42,
      v2Marked: false,
      projectStatus: 'In Progress',
      labels: ['review:needs-human'],
      humanHold: true,
      humanReason: {
        phase: 'eligible',
        code: 'implementation-escalation',
        detail: 'Project Blocked on is Human',
      },
      eligible: false,
      eligibilityReason: 'not-selected',
      eligibilityDetail: 'Project Blocked on is Human',
    };
    const heldSnapshot: GitHubLifecycleSnapshot = {
      ...snapshot(heldIssue),
      project: {
        ...snapshot(heldIssue).project,
        items: [{
          id: 'PVTI_42',
          number: 42,
          contentType: 'Issue',
          status: 'In Progress',
          priority: 'P1',
          effort: 'Medium',
          blockedOn: 'Human',
          issueType: 'feat',
          blockedByIssues: [],
          sprintIterationId: null,
        }],
      },
      branches: [{
        issueNumber: 42,
        headRefName: 'autopilot/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T11:00:00.000Z',
        claim: implementation().branchClaim!,
      }],
    };

    const report = await runLifecycleCycle('observe', {
      ...deps(heldIssue, calls),
      readSnapshot: async () => heldSnapshot,
    });

    expect(report.items).toEqual([]);
    expect(report.orphanBranchClaims[0]).toMatchObject({
      kind: 'orphan-branch-claim',
      phase: 'human',
      issueNumber: 42,
      head: HEAD,
      headRefName: 'autopilot/42',
      claimAttempt: implementation().branchClaim!.attempt,
      claimRunner: 'runner-a',
      claimGeneration: implementation().branchClaim!.attempt,
      progressAgeMs: 60 * 60 * 1000,
      stale: false,
      v2Marked: true,
      humanHold: true,
      humanReason: {
        phase: 'implementing',
        detail: 'Project Blocked on is Human',
      },
    });
    expect(report.orphanBranchClaims[0]?.desiredActions).toEqual([{
      kind: 'set-project-status',
      issueNumber: 42,
      status: 'Human',
    }]);
    expect(JSON.stringify(report)).not.toContain('ensure-draft-pr');
    expect(calls).toEqual([]);
  });

  it.skip('reports an orphan branch claim as active v2 implementation state with repair actions', async () => {
    const calls: string[] = [];
    const orphanIssue: LifecycleItem = {
      kind: 'issue',
      issueNumber: 42,
      v2Marked: false,
      projectStatus: 'Todo',
      labels: [],
      eligible: true,
      eligibilityReason: 'eligible',
      eligibilityDetail: 'All implementation admission gates pass',
    };
    const orphanSnapshot: GitHubLifecycleSnapshot = {
      ...snapshot(orphanIssue),
      branches: [{
        issueNumber: 42,
        headRefName: 'autopilot/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T11:00:00.000Z',
        claim: implementation().branchClaim!,
      }],
    };

    const report = await runLifecycleCycle('observe', {
      ...deps(orphanIssue, calls),
      readSnapshot: async () => orphanSnapshot,
    });

    expect(report.items).toEqual([]);
    expect(report.orphanBranchClaims).toEqual([expect.objectContaining({
      kind: 'orphan-branch-claim',
      phase: 'implementing',
      issueNumber: 42,
      head: HEAD,
      headRefName: 'autopilot/42',
      claimAttempt: implementation().branchClaim!.attempt,
      claimRunner: 'runner-a',
      claimGeneration: implementation().branchClaim!.attempt,
      progressAgeMs: 60 * 60 * 1000,
      stale: false,
      v2Marked: true,
      humanHold: false,
      desiredActions: [
        {
          kind: 'set-project-status',
          issueNumber: 42,
          expectedHead: HEAD,
          status: 'In Progress',
        },
        {
          kind: 'ensure-draft-pr',
          issueNumber: 42,
          expectedHead: HEAD,
          headRefName: 'autopilot/42',
          baseRefName: 'next',
        },
      ],
    })]);
    expect(explainIssue(report, 42)).toContain('implementing');
    const json = JSON.parse(renderLifecycleJson(report));
    expect(json.items).toEqual([]);
    expect(json.orphanBranchClaims[0]).not.toHaveProperty('prNumber');
    expect(calls).toEqual([]);
  });

  it('uses matching terminal claim evidence only to suppress retained-branch orphan recovery', async () => {
    const calls: string[] = [];
    const eligibleIssue: LifecycleItem = {
      kind: 'issue',
      issueNumber: 42,
      v2Marked: false,
      projectStatus: 'Todo',
      labels: [],
      eligible: true,
      eligibilityReason: 'eligible',
      eligibilityDetail: 'All implementation admission gates pass',
    };
    const terminalSnapshot: GitHubLifecycleSnapshot = {
      ...snapshot(eligibleIssue),
      branches: [{
        issueNumber: 42,
        headRefName: 'autopilot/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T11:00:00.000Z',
        claim: implementation().branchClaim!,
      }],
      terminalClaims: [{
        issueNumber: 42,
        prNumber: 101,
        headRefName: 'autopilot/42',
        headOid: HEAD,
        claimAttempt: implementation().branchClaim!.attempt,
        targetBase: gitRefName('next'),
        claimFingerprint: '6f0c55eda2d8d6b32c6f24ccac605d377c48acb0d8ab41ca9dd443f16c13613b',
        mergedAt: '2026-07-20T11:30:00.000Z',
        mergeCommitOid: gitOid('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      }],
    };

    const report = await runLifecycleCycle('observe', {
      ...deps(eligibleIssue, calls),
      readSnapshot: async () => terminalSnapshot,
    });

    expect(report.orphanBranchClaims).toEqual([]);
    expect(report.items).toEqual([
      expect.objectContaining({
        issueNumber: 42,
        phase: 'eligible',
      }),
    ]);
    expect(report.items.flatMap((item) => item.desiredActions)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'ensure-draft-pr' }),
        expect.objectContaining({ kind: 'set-project-status', status: 'Done' }),
      ]),
    );
    expect(report.items.some((item) => item.phase === 'merged')).toBe(false);
    expect(calls).toEqual([]);
  });

  it('keeps orphan recovery fail-closed when terminal claim identity does not match the branch', async () => {
    const calls: string[] = [];
    const eligibleIssue: LifecycleItem = {
      kind: 'issue',
      issueNumber: 42,
      v2Marked: false,
      projectStatus: 'Todo',
      labels: [],
      eligible: true,
      eligibilityReason: 'eligible',
      eligibilityDetail: 'All implementation admission gates pass',
    };
    const mismatchedSnapshot: GitHubLifecycleSnapshot = {
      ...snapshot(eligibleIssue),
      issues: [openIssue(42)],
      branches: [{
        issueNumber: 42,
        headRefName: 'autopilot/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T11:00:00.000Z',
        claim: implementation().branchClaim!,
      }],
      terminalClaims: [{
        issueNumber: 42,
        prNumber: 101,
        headRefName: 'autopilot/42',
        headOid: gitOid('cccccccccccccccccccccccccccccccccccccccc'),
        claimAttempt: implementation().branchClaim!.attempt,
        targetBase: gitRefName('next'),
        claimFingerprint: '6f0c55eda2d8d6b32c6f24ccac605d377c48acb0d8ab41ca9dd443f16c13613b',
        mergedAt: '2026-07-20T11:30:00.000Z',
        mergeCommitOid: gitOid('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      }],
    };

    const report = await runLifecycleCycle('observe', {
      ...deps(eligibleIssue, calls),
      readSnapshot: async () => mismatchedSnapshot,
    });

    expect(report.orphanBranchClaims).toEqual([
      expect.objectContaining({
        issueNumber: 42,
        desiredActions: expect.arrayContaining([
          expect.objectContaining({ kind: 'ensure-draft-pr' }),
        ]),
      }),
    ]);
    expect(calls).toEqual([]);
  });

  it('keeps orphan recovery fail-closed when an omitted implementation claim field changes', async () => {
    const calls: string[] = [];
    const eligibleIssue: LifecycleItem = {
      kind: 'issue',
      issueNumber: 42,
      v2Marked: false,
      projectStatus: 'Todo',
      labels: [],
      eligible: true,
      eligibilityReason: 'eligible',
      eligibilityDetail: 'All implementation admission gates pass',
    };
    const changedClaim = {
      ...implementation().branchClaim!,
      runner: 'runner-b',
    };
    const mismatchedSnapshot: GitHubLifecycleSnapshot = {
      ...snapshot(eligibleIssue),
      issues: [openIssue(42)],
      branches: [{
        issueNumber: 42,
        headRefName: 'autopilot/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T11:00:00.000Z',
        claim: changedClaim,
      }],
      terminalClaims: [{
        issueNumber: 42,
        prNumber: 101,
        headRefName: 'autopilot/42',
        headOid: HEAD,
        claimAttempt: implementation().branchClaim!.attempt,
        targetBase: gitRefName('next'),
        claimFingerprint: '6f0c55eda2d8d6b32c6f24ccac605d377c48acb0d8ab41ca9dd443f16c13613b',
        mergedAt: '2026-07-20T11:30:00.000Z',
        mergeCommitOid: gitOid('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      }],
    };

    const report = await runLifecycleCycle('observe', {
      ...deps(eligibleIssue, calls),
      readSnapshot: async () => mismatchedSnapshot,
    });

    expect(report.orphanBranchClaims).toEqual([
      expect.objectContaining({
        issueNumber: 42,
        desiredActions: expect.arrayContaining([
          expect.objectContaining({ kind: 'ensure-draft-pr' }),
        ]),
      }),
    ]);
    expect(calls).toEqual([]);
  });

  it('reports the cause of a reconciliation failure instead of a bare failed outcome', async () => {
    // Regression: eventFor built reconciliation log events without copying
    // ReconciliationResult.detail onto LifecycleLogEvent.reason, so every
    // reconciliation failure rendered as a bare `failed.` while sibling action
    // events (actionEvent) printed their reason. A live canary lost the cause
    // of a systematic 7/7 ensure-draft-pr failure loop to this hole.
    const failure = 'Issue is absent from the lifecycle snapshot';
    const { report, calls } = await ensureDraftPrCycle(async () => {
      throw new Error(failure);
    });

    expect(calls).toContain('ensureDraftPullRequest');
    expect(report.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'ensure-draft-pr',
        subject: 'issue:42',
        outcome: 'failed',
        reason: failure,
      }),
    ]));
    expect(renderLifecycleHuman(report)).toContain(
      `ensure-draft-pr issue:42: failed (${failure}).`,
    );
  });

  // Shared fixture for the log-safety cases: an orphan branch claim whose
  // reconciliation plans ensure-draft-pr, so a writer rejection produces a
  // `failed` reconciliation result carrying the raw error text as `detail`.
  const ELIGIBLE_ISSUE: LifecycleItem = {
    kind: 'issue',
    issueNumber: 42,
    v2Marked: false,
    projectStatus: 'Todo',
    labels: [],
    eligible: true,
    eligibilityReason: 'eligible',
    eligibilityDetail: 'All implementation admission gates pass',
  };

  function orphanReconciliationSnapshot(): GitHubLifecycleSnapshot {
    return {
      ...snapshot(ELIGIBLE_ISSUE),
      // Same correction as the two fixtures above: `ELIGIBLE_ISSUE` is an
      // eligible, Todo, open issue, so it is by construction present in the
      // open-issue set the cycle reads. The base `snapshot()` helper yields
      // `issues: []`, which would describe a closed issue.
      issues: [openIssue(42)],
      branches: [{
        issueNumber: 42,
        headRefName: 'autopilot/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T11:00:00.000Z',
        claim: implementation().branchClaim!,
      }],
    };
  }

  async function ensureDraftPrCycle(ensureDraftPullRequest: () => Promise<void>) {
    const calls: string[] = [];
    const writer: ReconciliationWriter = {
      ...throwingWriter(calls),
      readIssueHead: async () => HEAD,
      readBranchHead: async () => HEAD,
      readPullRequest: async () => null,
      readDraftPullRequestAuthority: async () => ({ kind: 'missing' }),
      ensureDraftPullRequest: async () => {
        calls.push('ensureDraftPullRequest');
        await ensureDraftPullRequest();
      },
    };
    const report = await runLifecycleCycle('active', {
      ...deps(ELIGIBLE_ISSUE, calls, writer),
      readSnapshot: async () => orphanReconciliationSnapshot(),
      active: {
        preflight: async () => ({ ok: true }),
        readLocalState: () => ({
          remaining: { implementation: 1, child: 1, review: 1 },
          availableLogins: ['reviewer-bot'],
          implementationPreferredLogin: 'reviewer-bot',
        }),
        implementationBackpressureThreshold: 10,
        executeAction: async () => ({ outcome: 'spawned' }),
      },
    });
    return { report, calls };
  }

  it('cannot let attacker-controlled error text forge a log line in a reconciliation event', async () => {
    // Security: ReconciliationResult.detail is message(error), and the
    // production writer shells out via execFile, whose rejection message reads
    // `Command failed: <argv>\n<stderr>`. `gh pr create` puts the target repo's
    // raw issue title and PR body into that argv, so `detail` carries
    // attacker-influenceable content with literal newlines straight into a
    // single-line operator log. Unflattened, an issue title beginning with a
    // newline forges an entire fake event line in a persisted log.
    const forged = 'ensure-draft-pr issue:1: applied.';
    const { report } = await ensureDraftPrCycle(async () => {
      throw new Error(
        `Command failed: gh pr create --title\n\n${forged}\n  trailing detail`,
      );
    });

    const event = report.events.find((candidate) => candidate.action === 'ensure-draft-pr');
    expect(event).toMatchObject({ outcome: 'failed' });
    expect(event!.reason).not.toMatch(/[\r\n]/);
    expect(event!.reason).toBe(
      `Command failed: gh pr create --title ${forged} trailing detail`,
    );

    const lines = renderLifecycleHuman(report).split('\n');
    // The forged text must never begin a line: starting a line is exactly what
    // makes it read as a genuine event to an operator or a log parser.
    expect(lines.some((line) => line.startsWith('ensure-draft-pr issue:1:'))).toBe(false);
    expect(lines.filter((line) => line.includes(forged))).toHaveLength(1);
    expect(lines).toContain(
      `ensure-draft-pr issue:42: failed (Command failed: gh pr create --title ${
        forged
      } trailing detail).`,
    );
  });

  it('keeps the trailing stderr of a long execFile failure message', async () => {
    // This is the point of the whole PR. Node's execFile rejection reads
    // `Command failed: <argv>\n<stderr>`: the argv comes FIRST and `gh pr
    // create`/`gh pr edit` push an entire PR body through it, while the actual
    // diagnosis — stderr — sits at the END. Any front-truncating bound would
    // keep the useless argv and discard the cause, re-hiding exactly what this
    // change exists to surface. The bound must preserve the tail.
    const stderr = 'pull request already exists for branch autopilot/42';
    const { report } = await ensureDraftPrCycle(async () => {
      throw new Error(
        `Command failed: gh pr create --body ${'x'.repeat(4_000)}\n${stderr}`,
      );
    });

    const event = report.events.find((candidate) => candidate.action === 'ensure-draft-pr');
    expect(event!.outcome).toBe('failed');
    expect(event!.reason).toContain(stderr);
    expect(event!.reason!.endsWith(stderr)).toBe(true);
    expect(renderLifecycleHuman(report)).toContain(stderr);
  });

  it('elides the middle of an oversized failure reason and marks the elision', async () => {
    // An unbounded reason turns a single failure into a multi-KB log entry, so
    // the middle goes — never the ends.
    const stderr = 'pull request already exists';
    const detail = `Command failed: gh pr edit --body ${'x'.repeat(4_000)}\n${stderr}`;
    const { report } = await ensureDraftPrCycle(async () => {
      throw new Error(detail);
    });

    const event = report.events.find((candidate) => candidate.action === 'ensure-draft-pr');
    const reason = event!.reason!;
    expect(reason.length).toBeLessThan(detail.length);
    expect(reason.startsWith('Command failed: gh pr edit --body xxx')).toBe(true);
    expect(reason.endsWith(stderr)).toBe(true);
    expect(reason).toMatch(/ \[…\d+ chars elided…\] /u);
    expect(reason).not.toMatch(/[\r\n]/);
  });

  it('leaves a failure reason under the elision threshold byte-identical', async () => {
    // No gratuitous mangling: the common case must survive untouched.
    const detail = 'Command failed: gh pr create --title x: HTTP 422 validation failed';
    const { report } = await ensureDraftPrCycle(async () => {
      throw new Error(detail);
    });

    const event = report.events.find((candidate) => candidate.action === 'ensure-draft-pr');
    expect(event!.reason).toBe(detail);
    expect(renderLifecycleHuman(report)).toContain(
      `ensure-draft-pr issue:42: failed (${detail}).`,
    );
  });

  it('strips control characters that the whitespace class does not cover', async () => {
    // The regex whitespace class matches no C1 control and only five of the C0
    // controls, so ESC (0x1B) in a target-repo PR body would otherwise reach
    // the reason intact and be acted on by the operator's terminal -- the same
    // forge-a-line channel the newline collapse closes, arriving as a different
    // byte. Built from char codes so the fixture cannot be mistaken for prose.
    const esc = String.fromCharCode(0x1b);
    const csi = String.fromCharCode(0x9b);
    const hasControl = (text: string): boolean =>
      [...text].some((char) => {
        const code = char.codePointAt(0)!;
        return code < 0x20 || (code >= 0x7f && code <= 0x9f);
      });

    const stderr = 'pull request already exists';
    const detail =
      `Command failed: gh pr edit --body ${esc}[2K${esc}[31mDONE${csi}1m\n${stderr}`;
    expect(hasControl(detail)).toBe(true);

    const { report } = await ensureDraftPrCycle(async () => {
      throw new Error(detail);
    });

    const event = report.events.find((candidate) => candidate.action === 'ensure-draft-pr');
    const reason = event!.reason!;
    expect(hasControl(reason)).toBe(false);
    expect(reason.endsWith(stderr)).toBe(true);
    // The printable payload survives: this bounds the escape, not the message.
    expect(reason).toContain('DONE');
    // The render is legitimately multi-line, so check inside the lines: the
    // guarantee is that no *field* smuggles a control character into one.
    const lines = renderLifecycleHuman(report).split('\n');
    expect(lines.some((line) => hasControl(line))).toBe(false);
  });

  it('omits reason entirely from a successful reconciliation event', async () => {
    // Pins the negative case so a later refactor cannot start emitting
    // `reason: undefined` (or an empty reason) on success unnoticed.
    const { report } = await ensureDraftPrCycle(async () => {});

    const event = report.events.find((candidate) => candidate.action === 'ensure-draft-pr');
    expect(event!.outcome).toBe('applied');
    expect(event).not.toHaveProperty('reason');
    expect(Object.keys(event!)).not.toContain('reason');
    expect(renderLifecycleHuman(report).split('\n')).toContain(
      'ensure-draft-pr issue:42: applied.',
    );
  });

  it('applies the same log-injection protection to scheduled action events', async () => {
    // actionEvent (the sibling builder) takes the same unsanitized route from a
    // thrown Error to a single-line log, so the protection must sit at both
    // construction sites, not only at eventFor.
    const delivered = implementation({
      branchClaim: {
        ...implementation().branchClaim,
        phaseComplete: true,
      },
      isDraft: false,
      needsReview: true,
      approved: false,
    });
    const forged = 'claim-review issue:1/pr:1: spawned.';

    const report = await runLifecycleCycle('active', {
      ...deps(delivered, []),
      active: {
        preflight: async () => ({ ok: true }),
        readLocalState: () => ({
          remaining: { implementation: 1, child: 1, review: 1 },
          availableLogins: ['reviewer-bot'],
          implementationPreferredLogin: 'reviewer-bot',
        }),
        implementationBackpressureThreshold: 10,
        executeAction: async () => {
          throw new Error(`Command failed: gh pr comment --body\n\n${forged}`);
        },
      },
    });

    const event = report.events.find((candidate) => candidate.action === 'claim-review');
    expect(event).toMatchObject({ outcome: 'failed' });
    expect(event!.reason).not.toMatch(/[\r\n]/);
    expect(event!.reason).toBe(`Command failed: gh pr comment --body ${forged}`);
    expect(
      renderLifecycleHuman(report).split('\n')
        .some((line) => line.startsWith('claim-review issue:1/')),
    ).toBe(false);
  });

  it('plans no orphan recovery for a claim whose issue is absent from the live snapshot', async () => {
    const calls: string[] = [];
    // Issue #42 is closed, so it is absent from the open-issue set the cycle
    // re-reads every pass. Only the retained implement claim survives; there is
    // no live evidence about the subject at all. The writer's own precondition
    // rejects this ("Issue is absent from the lifecycle snapshot"), so planning
    // a mutation here can only fail, forever.
    const closedIssue: LifecycleItem = {
      kind: 'issue',
      issueNumber: 42,
      v2Marked: false,
      projectStatus: 'In Progress',
      labels: [],
      eligible: false,
      eligibilityReason: 'not-selected',
      eligibilityDetail: 'Issue is not on the Project',
    };
    const absentIssueSnapshot: GitHubLifecycleSnapshot = {
      ...snapshot(closedIssue),
      issues: [],
      branches: [{
        issueNumber: 42,
        headRefName: 'autopilot/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T11:00:00.000Z',
        claim: implementation().branchClaim!,
      }],
      terminalClaims: [],
    };

    const report = await runLifecycleCycle('observe', {
      ...deps(closedIssue, calls),
      readSnapshot: async () => absentIssueSnapshot,
    });

    expect(report.orphanBranchClaims).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('ensure-draft-pr');
    expect(calls).toEqual([]);
  });

  it('plans no orphan recovery when a populated live issue set omits the claim issue', async () => {
    const calls: string[] = [];
    // The gate must be evidence about *this* issue, not merely that the cycle
    // read some issues. A busy repository always has a non-empty open-issue
    // set; issue #42 is still closed and absent from it, so the claim on
    // `autopilot/42` is still unsupported.
    const closedIssue: LifecycleItem = {
      kind: 'issue',
      issueNumber: 42,
      v2Marked: false,
      projectStatus: 'In Progress',
      labels: [],
      eligible: false,
      eligibilityReason: 'not-selected',
      eligibilityDetail: 'Issue is not on the Project',
    };
    const otherIssuesSnapshot: GitHubLifecycleSnapshot = {
      ...snapshot(closedIssue),
      issues: [openIssue(99)],
      branches: [{
        issueNumber: 42,
        headRefName: 'autopilot/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T11:00:00.000Z',
        claim: implementation().branchClaim!,
      }],
      terminalClaims: [],
    };

    const report = await runLifecycleCycle('observe', {
      ...deps(closedIssue, calls),
      readSnapshot: async () => otherIssuesSnapshot,
    });

    expect(report.orphanBranchClaims).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('ensure-draft-pr');
    expect(calls).toEqual([]);
  });

  it.skip('never reopens Done or otherwise merged work because its stable ref was retained', async () => {
    const calls: string[] = [];
    const doneIssue: LifecycleItem = {
      kind: 'issue',
      issueNumber: 42,
      v2Marked: false,
      projectStatus: 'Done',
      labels: [],
      eligible: false,
      eligibilityReason: 'not-selected',
      eligibilityDetail: 'Project status is Done',
    };
    const doneSnapshot: GitHubLifecycleSnapshot = {
      ...snapshot(doneIssue),
      project: {
        ...snapshot(doneIssue).project,
        items: [{
          id: 'PVTI_42',
          number: 42,
          contentType: 'Issue',
          status: 'Done',
          priority: 'P1',
          effort: 'Medium',
          blockedOn: null,
          issueType: 'feat',
          blockedByIssues: [],
          sprintIterationId: null,
        }],
      },
      branches: [{
        issueNumber: 42,
        headRefName: 'autopilot/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T08:00:00.000Z',
        claim: implementation().branchClaim!,
      }],
    };
    const doneReport = await runLifecycleCycle('observe', {
      ...deps(doneIssue, calls),
      readSnapshot: async () => doneSnapshot,
    });

    expect(doneReport.orphanBranchClaims).toEqual([]);
    expect(doneReport.items.flatMap((entry) => entry.desiredActions)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'set-project-status', status: 'In Progress' }),
        expect.objectContaining({ kind: 'ensure-draft-pr' }),
        expect.objectContaining({ kind: 'requeue-implementation' }),
      ]),
    );

    const merged = implementation({
      projectStatus: 'In Review',
      branchClaim: undefined,
      merged: true,
      isDraft: false,
    });
    const mergedSnapshot: GitHubLifecycleSnapshot = {
      ...snapshot(merged),
      pullRequests: [{
        ...snapshot(merged).pullRequests[0]!,
        headRefName: 'adopted/42',
      }],
      branches: [{
        issueNumber: 42,
        headRefName: 'autopilot/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T08:00:00.000Z',
        claim: implementation().branchClaim!,
      }],
    };
    const mergedReport = await runLifecycleCycle('observe', {
      ...deps(merged, calls),
      readSnapshot: async () => mergedSnapshot,
    });

    expect(mergedReport.orphanBranchClaims).toEqual([]);
    expect(mergedReport.items).toEqual([
      expect.objectContaining({
        phase: 'merged',
        issueNumber: 42,
        desiredActions: [expect.objectContaining({
          kind: 'set-project-status',
          status: 'Done',
        })],
      }),
    ]);
  });

  it.skip('fails orphan branch claims closed when canonical head progress time is invalid', async () => {
    const orphanIssue: LifecycleItem = {
      kind: 'issue',
      issueNumber: 42,
      v2Marked: false,
      projectStatus: 'In Progress',
      labels: [],
      eligible: false,
      eligibilityReason: 'not-selected',
      eligibilityDetail: 'Project status is In Progress',
    };

    for (const headCommittedAt of [
      '2026-07-20 11:00:00',
      '2026-07-20T12:00:00.001Z',
    ]) {
      const calls: string[] = [];
      const orphanSnapshot: GitHubLifecycleSnapshot = {
        ...snapshot(orphanIssue),
        branches: [{
          issueNumber: 42,
          headRefName: 'autopilot/42',
          headOid: HEAD,
          headCommittedAt,
          claim: implementation().branchClaim!,
        }],
      };

      const report = await runLifecycleCycle('observe', {
        ...deps(orphanIssue, calls),
        readSnapshot: async () => orphanSnapshot,
      });

      expect(report.orphanBranchClaims).toEqual([expect.objectContaining({
        phase: 'human',
        underlyingPhase: 'implementing',
        issueNumber: 42,
        stale: false,
        humanReason: {
          phase: 'implementing',
          code: 'invalid-branch-progress-time',
          detail: `Invalid branch head progress timestamp: ${headCommittedAt}`,
        },
      })]);
      expect(report.orphanBranchClaims[0]).not.toHaveProperty('progressAgeMs');
      expect(report.orphanBranchClaims[0]?.desiredActions).toEqual([{
        kind: 'set-project-status',
        issueNumber: 42,
        expectedHead: HEAD,
        status: 'Human',
      }]);
      expect(calls).toEqual([]);
    }
  });

  it.skip('reports stale and phase-complete orphan claims with their distinct recovery actions', async () => {
    const orphanIssue: LifecycleItem = {
      kind: 'issue',
      issueNumber: 42,
      v2Marked: false,
      projectStatus: 'In Progress',
      labels: [],
      eligible: false,
      eligibilityReason: 'not-selected',
      eligibilityDetail: 'Project status is In Progress',
    };
    const staleSnapshot: GitHubLifecycleSnapshot = {
      ...snapshot(orphanIssue),
      branches: [{
        issueNumber: 42,
        headRefName: 'autopilot/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T08:00:00.000Z',
        claim: implementation().branchClaim!,
      }],
    };
    const staleReport = await runLifecycleCycle('observe', {
      ...deps(orphanIssue, []),
      readSnapshot: async () => staleSnapshot,
    });

    expect(staleReport.orphanBranchClaims).toEqual([expect.objectContaining({
      phase: 'implementing',
      issueNumber: 42,
      progressAgeMs: 4 * 60 * 60 * 1000,
      stale: true,
      staleSince: '2026-07-20T10:00:00.000Z',
      staleReason: 'branch-head-unchanged',
      desiredActions: [
        {
          kind: 'ensure-draft-pr',
          issueNumber: 42,
          expectedHead: HEAD,
          headRefName: 'autopilot/42',
          baseRefName: 'next',
        },
        {
          kind: 'requeue-implementation',
          issueNumber: 42,
          expectedHead: HEAD,
        },
      ],
    })]);

    const completeSnapshot: GitHubLifecycleSnapshot = {
      ...staleSnapshot,
      branches: [{
        ...staleSnapshot.branches[0]!,
        claim: {
          ...staleSnapshot.branches[0]!.claim,
          phaseComplete: true,
        },
      }],
    };
    const completeReport = await runLifecycleCycle('observe', {
      ...deps(orphanIssue, []),
      readSnapshot: async () => completeSnapshot,
    });

    expect(completeReport.orphanBranchClaims).toEqual([expect.objectContaining({
      phase: 'awaiting-review',
      issueNumber: 42,
      progressAgeMs: 4 * 60 * 60 * 1000,
      stale: false,
      desiredActions: [
        {
          kind: 'ensure-draft-pr',
          issueNumber: 42,
          expectedHead: HEAD,
          headRefName: 'autopilot/42',
          baseRefName: 'next',
        },
        {
          kind: 'set-project-status',
          issueNumber: 42,
          expectedHead: HEAD,
          status: 'In Review',
        },
      ],
    })]);
  });

  it.skip('emits Human phase for ambiguity reconciliation events', async () => {
    const calls: string[] = [];
    let status: 'Todo' | 'Human' = 'Todo';
    let draft = false;
    const labels = new Set<string>();
    const comments = new Set<string>();
    const writer: ReconciliationWriter = {
      ...throwingWriter(calls),
      readProjectStatus: async () => status,
      setProjectStatus: async (_issue, desired) => {
        status = desired as typeof status;
      },
      readPullRequest: async () => ({ head: HEAD, draft, labels: [...labels] }),
      setPullRequestDraft: async (_pr, desired) => {
        draft = desired;
      },
      setPullRequestLabel: async (_pr, label, present) => {
        if (present) labels.add(label);
        else labels.delete(label);
      },
      hasHumanComment: async (_pr, marker) => comments.has(marker),
      ensureHumanComment: async (_pr, marker) => {
        comments.add(marker);
      },
    };
    const ambiguousSnapshot: GitHubLifecycleSnapshot = {
      ...snapshot(implementation()),
      lifecycle: { items: [] },
      diagnostics: [{
        code: 'branch-mapping-ambiguous',
        detail: 'Stable branch claim contradicts adopted PR #101',
        issueNumbers: [42],
        issues: [{ number: 42, projectStatus: 'Todo' }],
        pullRequests: [{
          number: 101,
          head: HEAD,
          draft: false,
          labels: [],
        }],
      }],
    };

    const report = await runLifecycleCycle('recover', {
      ...deps(implementation(), calls, writer),
      readSnapshot: async () => ambiguousSnapshot,
    });

    expect(report.status).toBe('ok');
    expect(report.events).not.toHaveLength(0);
    expect(report.events.every((event) => event.phase === 'human')).toBe(true);
    expect([...labels].sort()).toEqual(['engine:review', 'review:needs-human']);
  });
});

describe.skip('board-archive sweep wiring (jinn-mono#1883)', () => {
  it('never invokes the sweep in observe mode', async () => {
    const calls: string[] = [];
    let invoked = 0;
    const report = await runLifecycleCycle('observe', {
      ...deps(implementation(), calls),
      boardArchiveSweep: async () => {
        invoked += 1;
        return { status: 'archived', archived: 1, capped: false };
      },
    });

    expect(invoked).toBe(0);
    expect(report.status).toBe('ok');
    if (report.status === 'ok') expect(report.boardArchive).toBeUndefined();
    expect(renderLifecycleJson(report)).not.toContain('boardArchive');
  });

  it.skip('invokes the sweep after reconciliation in recover mode and surfaces the result', async () => {
    const calls: string[] = [];
    let status: 'Todo' | 'In Progress' = 'Todo';
    let draft = false;
    const writer: ReconciliationWriter = {
      ...throwingWriter(calls),
      readIssueHead: async () => HEAD,
      readProjectStatus: async () => status,
      setProjectStatus: async (_issue, desired) => {
        status = desired as typeof status;
      },
      readPullRequest: async () => ({ head: HEAD, draft, labels: [] }),
      setPullRequestDraft: async (_pr, desired) => {
        draft = desired;
      },
    };
    let invokedWithSnapshotAndNow: readonly [unknown, Date] | undefined;

    const report = await runLifecycleCycle('recover', {
      ...deps(implementation(), calls, writer),
      boardArchiveSweep: async (snapshotArg, now) => {
        invokedWithSnapshotAndNow = [snapshotArg, now];
        return { status: 'archived', archived: 3, capped: false };
      },
    });

    expect(invokedWithSnapshotAndNow?.[1]).toEqual(NOW);
    expect(report.status).toBe('ok');
    if (report.status === 'ok') {
      expect(report.boardArchive).toEqual({ status: 'archived', archived: 3, capped: false });
    }
    expect(renderLifecycleHuman(report)).toContain('Board archive sweep: archived 3.');
  });

  it('renders capped / throttled / failed sweep summaries', () => {
    const base = {
      status: 'ok' as const,
      mode: 'recover' as const,
      cycleId: 'cycle-1',
      runnerId: 'runner-a',
      capturedAt: NOW.toISOString(),
      snapshotMode: 'full' as const,
      snapshotComplete: true,
      lastFullReconciliationAt: NOW.toISOString(),
      githubUsage: {
        graphqlRequests: 0,
        graphqlCost: 0,
        graphqlRemaining: null,
        graphqlResetAt: null,
        restRequests: 0,
        restNotModified: 0,
        cacheHits: 0,
      },
      items: [],
      orphanBranchClaims: [],
      diagnostics: [],
      events: [],
    };
    expect(renderLifecycleHuman({ ...base, boardArchive: { status: 'archived' as const, archived: 50, capped: true } }))
      .toContain('Board archive sweep: archived 50 (capped).');
    expect(renderLifecycleHuman({ ...base, boardArchive: { status: 'skipped-throttled' as const } }))
      .toContain('Board archive sweep: skipped (throttled).');
    expect(renderLifecycleHuman({ ...base, boardArchive: { status: 'failed' as const, reason: 'boom' } }))
      .toContain('Board archive sweep: failed (boom).');
  });
});

describe('operator usage summary', () => {
  it('tells the operator how many reads a cycle retried through transport faults', () => {
    // This line is the only place an operator learns that a cycle papered over
    // network faults; a retried cycle must never read as a clean one. Asserted
    // against a real meter so the summary and the meter cannot drift apart.
    const base = {
      status: 'ok' as const,
      mode: 'recover' as const,
      cycleId: 'cycle-1',
      runnerId: 'runner-a',
      capturedAt: NOW.toISOString(),
      snapshotMode: 'full' as const,
      snapshotComplete: true,
      lastFullReconciliationAt: NOW.toISOString(),
      items: [],
      orphanBranchClaims: [],
      diagnostics: [],
      events: [],
      backlog: {
        ordinary: 0, followUps: 0, children: 0, sweeps: 0, actionable: 0,
        ordinaryByPriority: { p0: 0, p1: 0, p2: 0, p3: 0, p4: 0, unset: 0 },
      },
    };
    const retried = new GitHubUsageMeter();
    retried.recordTransientReadRetry('gh', 'TLS handshake failure');
    retried.recordTransientReadRetry('git', 'connection reset');

    expect(renderLifecycleHuman({ ...base, githubUsage: retried.read() }))
      .toContain('Retried reads: 2 transport faults.');
    expect(renderLifecycleHuman({ ...base, githubUsage: new GitHubUsageMeter().read() }))
      .not.toContain('Retried reads:');
  });
});

// #82: the integration stage hands the exact head to GitHub's merge queue.
// `update-branch` is gone with it — the queue rebases its own candidate, so the
// engine has no reason to move a PR head under an approval it already signed.
describe('enqueue stage scheduling', () => {
  const MARKER = '44444444-4444-4444-8444-444444444444';

  function approved(overrides = {}) {
    return implementation({
      projectStatus: 'In Review',
      approved: true,
      needsReview: false,
      mergeState: 'clean',
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'review-bot',
        head: HEAD,
        state: 'terminal-approved',
        recordedAt: '2026-07-20T11:00:00.000Z',
        verdict: { marker: MARKER, state: 'APPROVE' },
      },
      terminalVerdict: {
        head: HEAD,
        state: 'APPROVE',
        marker: MARKER,
        recordedAt: '2026-07-20T11:00:00.000Z',
      },
      branchClaim: {
        kind: 'branch-claim',
        protocolVersion: 2,
        phase: 'implement',
        phaseComplete: true,
        issueNumber: 42,
        prNumber: 101,
        attempt: '11111111-1111-4111-8111-111111111111',
        runner: 'runner-a',
        login: 'implementer',
        expectedHead: HEAD,
        targetBase: gitRefName('next'),
        claimedAt: '2026-07-20T11:00:00.000Z',
      },
      checks: [{
        source: 'check-run',
        name: 'test',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
      }],
      ...overrides,
    });
  }

  function cycle(item, prOverrides = {}, mergePolicy = 'safe-auto') {
    const actions: unknown[] = [];
    const noOpWriter = new Proxy({} as ReconciliationWriter, {
      get() {
        return async () => null;
      },
    });
    const built = snapshot(item);
    built.pullRequests[0] = {
      ...built.pullRequests[0]!,
      mergeability: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      compareStatus: 'ahead',
      checks: item.checks!,
      ...prOverrides,
    };
    return {
      actions,
      run: () => runLifecycleCycle('active', {
        ...deps(item, [], noOpWriter),
        readSnapshot: async () => built,
        mergePolicy,
        active: {
          preflight: async () => ({ ok: true }),
          readLocalState: () => ({
            remaining: { implementation: 1, child: 1, review: 1 },
            availableLogins: ['implementation-bot'],
            implementationPreferredLogin: 'implementation-bot',
          }),
          implementationBackpressureThreshold: 10,
          executeAction: async (action: unknown) => {
            actions.push(action);
            return { outcome: 'enqueued' };
          },
        },
      }),
    };
  }

  it('schedules an enqueue for a behind pull request instead of an update-branch', async () => {
    const harness = cycle(approved({ mergeState: 'behind' }), { compareStatus: 'behind' });
    await harness.run();

    expect(harness.actions).toEqual([{
      kind: 'enqueue',
      issueNumber: 42,
      prNumber: 101,
      head: HEAD,
      expectedBaseRefName: 'next',
    }]);
  });

  it('schedules an enqueue for a clean pull request', async () => {
    const harness = cycle(approved());
    await harness.run();

    expect(harness.actions).toEqual([{
      kind: 'enqueue',
      issueNumber: 42,
      prNumber: 101,
      head: HEAD,
      expectedBaseRefName: 'next',
    }]);
  });

  it('schedules nothing for a pull request already in the merge queue', async () => {
    const harness = cycle(approved(), {
      mergeQueue: { enqueued: true, position: 2, state: 'QUEUED' },
    });
    const report = await harness.run();

    expect(report.items[0]).toMatchObject({ phase: 'merge-ready' });
    expect(harness.actions).toEqual([]);
  });

  it('never schedules an update-branch, however far behind the head is', async () => {
    for (const compareStatus of ['behind', 'diverged'] as const) {
      const harness = cycle(
        approved({ mergeState: 'behind' }),
        { compareStatus },
      );
      await harness.run();
      expect(harness.actions.every(
        (action) => (action as { kind: string }).kind !== 'update-branch',
      )).toBe(true);
    }
  });

  it('files a reconcile child, not an enqueue, for a conflicting head', async () => {
    const harness = cycle(approved({ mergeState: 'conflict' }), {
      mergeability: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      compareStatus: 'diverged',
    });
    await harness.run();

    expect(harness.actions).toEqual([{
      kind: 'file-reconcile-child',
      issueNumber: 42,
      prNumber: 101,
      head: HEAD,
      expectedBaseRefName: 'next',
      effort: 'medium',
    }]);
  });

  /**
   * A kill switch is worth naming when it is holding the enqueue back and
   * misleading when it is not. An operator reading "JINN_AUTOPILOT_ENQUEUE
   * disarms the path" under a cycle that is about to enqueue has been handed a
   * false lead, and the string is the only thing they have to go on.
   */
  it('explains merge-ready as an enqueue with no kill switch to blame', async () => {
    const harness = cycle(approved());
    const report = await harness.run();
    const explanation = explainPullRequest(report, 101);

    expect(explanation).toContain('merge queue');
    expect(explanation).not.toContain('JINN_AUTOPILOT_ENQUEUE');
    expect(explanation).not.toContain('manual');
    expect(explanation).not.toContain('native merge gate');
  });

  it('names the merge policy when it is what withholds the enqueue', async () => {
    const harness = cycle(approved(), {}, 'manual');
    const report = await harness.run();
    const explanation = explainPullRequest(report, 101);

    expect(explanation).toContain('manual');
    expect(explanation).not.toContain('JINN_AUTOPILOT_ENQUEUE');
  });

  it('names the enqueue kill switch when it is what withholds the enqueue', async () => {
    const previous = process.env.JINN_AUTOPILOT_ENQUEUE;
    process.env.JINN_AUTOPILOT_ENQUEUE = '0';
    try {
      const harness = cycle(approved());
      const report = await harness.run();
      const explanation = explainPullRequest(report, 101);

      expect(explanation).toContain('JINN_AUTOPILOT_ENQUEUE');
      expect(explanation).not.toContain('manual');
    } finally {
      if (previous === undefined) delete process.env.JINN_AUTOPILOT_ENQUEUE;
      else process.env.JINN_AUTOPILOT_ENQUEUE = previous;
    }
  });

  it('explains a queued pull request as waiting on the queue, not on the engine', async () => {
    const harness = cycle(approved(), {
      mergeQueue: { enqueued: true, position: 2, state: 'QUEUED' },
    });
    const report = await harness.run();
    const explanation = explainPullRequest(report, 101);

    expect(explanation).toContain("in GitHub's merge queue");
    expect(explanation).toContain('Done');
    expect(explanation).not.toContain('ready to be enqueued');
  });

  /**
   * The whole point of the hold. A held head has already had this exact
   * decision derived and refused, and the derivation is the expensive part:
   * ~2 GraphQL + 8-10 REST reads per candidate, of which the attempt ledger —
   * the only thing that could have stopped it — is read LAST. Suppressing at
   * the candidate emission is what makes a held head cost nothing at all.
   */
  it.each(['flake', 'rejected'] as const)(
    'schedules no enqueue for a head on a %s hold',
    async (kind) => {
      const harness = cycle(approved({ enqueueHold: kind }));
      const report = await harness.run();

      expect(report.items[0]).toMatchObject({ phase: 'merge-ready' });
      expect(harness.actions).toEqual([]);
    },
  );

  /**
   * A held pull request that says nothing has simply stopped moving as far as
   * an operator can see. The explanation names the hold class and BOTH exits,
   * because the hold has exactly two: a new commit (which mints a new ref) and
   * the linked ci-failure child on this pull request.
   */
  it.each(['flake', 'rejected'] as const)(
    'explains a %s hold and names both exits',
    async (kind) => {
      const harness = cycle(approved({ enqueueHold: kind }));
      const report = await harness.run();
      const explanation = explainPullRequest(report, 101);

      expect(explanation).toContain(kind);
      expect(explanation).toContain('pushing a new commit');
      expect(explanation).toContain('ci-failure');
      expect(explanation).not.toContain('nothing is withholding');
      // Honest per class: a flake hold always has its explaining child, a
      // rejected hold has none, and naming one that does not exist sends an
      // operator looking for an issue nobody filed.
      expect(explanation.includes('No ci-failure child is filed'))
        .toBe(kind === 'rejected');
    },
  );

  it('reports the hold on the status item so an operator can filter for it', async () => {
    const harness = cycle(approved({ enqueueHold: 'flake' }));
    const report = await harness.run();

    expect(report.items[0]).toMatchObject({ enqueueHold: 'flake' });
  });

  /**
   * "The merge queue is not enabled" / "this credential cannot use it" is one
   * fact about the repository, and every merge-ready pull request in the cycle
   * would learn it the same expensive way: a full candidate derivation, a
   * GraphQL authority read, and a mutation, each ending in the identical
   * refusal. The first one that proves it latches the rest of the cycle.
   *
   * Per-cycle, deliberately. Re-enabling the queue must not need a restart, so
   * the next cycle re-probes with a single enqueue.
   */
  describe('repository refusal latch', () => {
    function approvedAt(prNumber: number, issueNumber: number) {
      const base = approved();
      return {
        ...base,
        prNumber,
        issueNumber,
        reviewClaim: { ...base.reviewClaim, prNumber },
        branchClaim: { ...base.branchClaim, prNumber, issueNumber },
      };
    }

    function threeMergeReady(execute: (action: unknown) => Promise<unknown>) {
      const items = [
        approvedAt(101, 42),
        approvedAt(102, 43),
        approvedAt(103, 44),
      ];
      const built = snapshot(items[0]!);
      built.lifecycle = { items };
      built.pullRequests = items.map((item) => ({
        number: item.prNumber,
        title: 'feat: lifecycle',
        body: `Closes #${item.issueNumber}`,
        author: 'trusted',
        baseRefName: 'next',
        headRefName: `autopilot/${item.issueNumber}`,
        headOid: item.head,
        headCommittedAt: item.headChangedAt,
        isDraft: false,
        state: 'OPEN',
        labels: item.labels,
        closingIssueNumbers: [item.issueNumber],
        mergeability: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        compareStatus: 'ahead',
        checks: item.checks,
        reviews: [],
        branchClaim: item.branchClaim,
      }));
      const actions: unknown[] = [];
      const noOpWriter = new Proxy({} as ReconciliationWriter, {
        get() { return async () => null; },
      });
      return {
        actions,
        run: () => runLifecycleCycle('active', {
          ...deps(items[0]!, [], noOpWriter),
          readSnapshot: async () => built,
          mergePolicy: 'safe-auto',
          active: {
            preflight: async () => ({ ok: true }),
            readLocalState: () => ({
              remaining: { implementation: 1, child: 1, review: 1 },
              availableLogins: ['implementation-bot'],
              implementationPreferredLogin: 'implementation-bot',
            }),
            implementationBackpressureThreshold: 10,
            executeAction: async (action: unknown) => {
              actions.push(action);
              return execute(action);
            },
          },
        }),
      };
    }

    it('schedules three enqueues and executes all of them when nothing refuses', async () => {
      const harness = threeMergeReady(async () => ({ outcome: 'enqueued' }));
      await harness.run();

      expect(harness.actions).toHaveLength(3);
    });

    it('stops the cycle after the first repository-wide refusal', async () => {
      const harness = threeMergeReady(async () => ({
        outcome: 'rejected',
        reason: 'GraphQL: Merge queue is not enabled for this branch',
        repositoryRefusal: true,
      }));
      const report = await harness.run();

      expect(harness.actions).toHaveLength(1);
      const enqueueEvents = report.events.filter((event) => event.action === 'enqueue');
      expect(enqueueEvents.map((event) => event.outcome))
        .toEqual(['rejected', 'skipped', 'skipped']);
      expect(enqueueEvents.slice(1).map((event) => event.reason))
        .toEqual(['enqueue-repository-refused', 'enqueue-repository-refused']);
      // The skipped events still name their own subject, so an operator reads
      // which pull requests went unattempted rather than a count.
      expect(enqueueEvents.map((event) => event.subject))
        .toEqual(['issue:42/pr:101', 'issue:43/pr:102', 'issue:44/pr:103']);
    });

    /**
     * A plain `rejected` is a fact about ONE pull request — a conflict, an
     * unresolvable node id. Latching the cycle on it would strand every other
     * merge-ready pull request behind an unrelated failure.
     */
    it('does not latch on a rejection that is not repository-wide', async () => {
      const harness = threeMergeReady(async () => ({
        outcome: 'rejected',
        reason: 'GraphQL: Pull request is not mergeable',
      }));
      await harness.run();

      expect(harness.actions).toHaveLength(3);
    });

    it('re-probes with one enqueue on the next cycle', async () => {
      let cycles = 0;
      const harness = threeMergeReady(async () => {
        cycles += 1;
        return {
          outcome: 'rejected',
          reason: 'GraphQL: Merge queue is not enabled for this branch',
          repositoryRefusal: true,
        };
      });

      await harness.run();
      await harness.run();

      expect(cycles).toBe(2);
    });
  });

  it('schedules no enqueue at all when JINN_AUTOPILOT_ENQUEUE is off', async () => {
    const previous = process.env.JINN_AUTOPILOT_ENQUEUE;
    process.env.JINN_AUTOPILOT_ENQUEUE = '0';
    try {
      const harness = cycle(approved());
      const report = await harness.run();
      expect(report.items[0]).toMatchObject({ phase: 'merge-ready' });
      expect(harness.actions).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.JINN_AUTOPILOT_ENQUEUE;
      else process.env.JINN_AUTOPILOT_ENQUEUE = previous;
    }
  });
});

// #127: open-issue composition, derived every cycle from `snapshot.issues`
// (already open-only — the poller reads `state=open`). No scheduling
// behavior depends on any of this; it is measurement only.
describe('backlog composition (#127)', () => {
  const DEBT_SWEEP_BODY = '<!-- jinn-autopilot:debt-sweep pr=101 members=1,2,3 -->';
  const CHILD_BODY = '<!-- jinn-autopilot:child pr=101 kind=review-finding -->';
  const FOLLOW_UP_BODY =
    '<!-- jinn-autopilot:review-follow-up pr=101 head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa index=0 -->';

  function issue(
    number: number,
    overrides: Partial<PolledIssue> = {},
  ): PolledIssue {
    return { ...openIssue(number), body: '', priority: 'P1', ...overrides };
  }

  async function backlogFor(issues: readonly PolledIssue[]) {
    const calls: string[] = [];
    const report = await runLifecycleCycle('observe', {
      ...deps(implementation(), calls),
      readSnapshot: async () => ({
        ...snapshot(implementation()),
        issues,
      }),
    });
    if (report.status !== 'ok') throw new Error(`expected ok, got ${report.status}`);
    return report;
  }

  it('classifies an issue carrying both a sweep tag and a follow-up marker as a sweep', async () => {
    const report = await backlogFor([
      issue(50, { body: `${DEBT_SWEEP_BODY}\n${FOLLOW_UP_BODY}` }),
    ]);
    expect(report.backlog).toMatchObject({
      ordinary: 0,
      followUps: 0,
      children: 0,
      sweeps: 1,
      actionable: 1,
    });
  });

  it('classifies an issue carrying both a child marker and a follow-up marker as a child', async () => {
    const report = await backlogFor([
      issue(51, { body: `${CHILD_BODY}\n${FOLLOW_UP_BODY}` }),
    ]);
    expect(report.backlog).toMatchObject({
      ordinary: 0,
      followUps: 0,
      children: 1,
      sweeps: 0,
      actionable: 0,
    });
  });

  it('counts an unset-priority issue as ordinary, bucketed under "unset"', async () => {
    const report = await backlogFor([
      issue(52, { priority: null }),
    ]);
    expect(report.backlog.ordinary).toBe(1);
    expect(report.backlog.ordinaryByPriority).toEqual({
      p0: 0, p1: 0, p2: 0, p3: 0, p4: 0, unset: 1,
    });
  });

  it('covers only the ordinary set in the per-priority breakdown', async () => {
    const report = await backlogFor([
      issue(53, { priority: 'P0' }),
      issue(54, { priority: 'P0', body: FOLLOW_UP_BODY }),
      issue(55, { priority: 'P0', body: CHILD_BODY }),
      issue(56, { priority: 'P0', body: DEBT_SWEEP_BODY }),
    ]);
    expect(report.backlog).toMatchObject({
      ordinary: 1,
      followUps: 1,
      children: 1,
      sweeps: 1,
    });
    // Only the one ordinary P0 issue counts; the follow-up/child/sweep P0
    // issues must not inflate this bucket.
    expect(report.backlog.ordinaryByPriority.p0).toBe(1);
  });

  it('computes actionable as ordinary + sweeps, excluding follow-ups and children', async () => {
    const report = await backlogFor([
      issue(60),
      issue(61, { body: FOLLOW_UP_BODY }),
      issue(62, { body: CHILD_BODY }),
      issue(63, { body: DEBT_SWEEP_BODY }),
    ]);
    expect(report.backlog).toEqual({
      ordinary: 1,
      followUps: 1,
      children: 1,
      sweeps: 1,
      actionable: 2,
      ordinaryByPriority: { p0: 0, p1: 1, p2: 0, p3: 0, p4: 0, unset: 0 },
    });
  });

  it('renders the per-cycle backlog log line in the exact specified format', async () => {
    const report = await backlogFor([
      issue(70),
      issue(71, { body: FOLLOW_UP_BODY }),
      issue(72, { body: CHILD_BODY }),
      issue(73, { body: DEBT_SWEEP_BODY }),
    ]);
    const human = renderLifecycleHuman(report);
    expect(human.split('\n')).toContain(
      'backlog: ordinary=1 follow-ups=1 children=1 sweeps=1 (actionable=2)',
    );
  });

  it('renders the ordinary per-priority breakdown in status text', async () => {
    const report = await backlogFor([
      issue(80, { priority: 'P0' }),
      issue(81, { priority: 'P2' }),
      issue(82, { priority: null }),
    ]);
    const human = renderLifecycleHuman(report);
    expect(human.split('\n')).toContain(
      'backlog ordinary priority: p0=1 p1=0 p2=1 p3=0 p4=0 unset=1',
    );
  });

  it('excludes closed issues: composition is derived only from snapshot.issues', async () => {
    // snapshot.issues is already open-only (the poller reads state=open); a
    // stray project-board item for an issue not present in `issues` (as a
    // closed issue can still linger on the board pre-archive) must not be
    // counted.
    const calls: string[] = [];
    const report = await runLifecycleCycle('observe', {
      ...deps(implementation(), calls),
      readSnapshot: async () => ({
        ...snapshot(implementation()),
        issues: [issue(90)],
        project: {
          ...snapshot(implementation()).project,
          items: [{
            id: 'PVTI_91',
            number: 91,
            contentType: 'Issue',
            status: 'Done',
            priority: 'P0',
            effort: 'Medium',
            blockedOn: 'Nothing',
            issueType: 'feat',
            blockedByIssues: [],
            sprintIterationId: null,
          }],
        },
      }),
    });
    if (report.status !== 'ok') throw new Error(`expected ok, got ${report.status}`);
    expect(report.backlog).toMatchObject({
      ordinary: 1,
      followUps: 0,
      children: 0,
      sweeps: 0,
      actionable: 1,
    });
    expect(report.backlog.ordinaryByPriority.p1).toBe(1); // issue(90) defaults to P1
    expect(report.backlog.ordinaryByPriority.p0).toBe(0); // the stray board item is not counted
  });
});
