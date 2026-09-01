// @ts-nocheck — Stage 5: deleted merge-prep/review-fix/project-status fixtures.
import { describe, expect, it } from 'vitest';
import {
  matchesOnlyIssuesAllowlist,
  runLifecycleCycle,
  type LifecycleControllerDeps,
} from '../../src/lifecycle/controller.js';
import type { ReconciliationWriter } from '../../src/lifecycle/reconciler.js';
import type { GitHubLifecycleSnapshot } from '../../src/lifecycle/snapshot.js';
import { gitOid, gitRefName } from '../../src/lifecycle/types.js';
import { formatChildMarker } from '../../src/lifecycle/child-issues.js';

const NOW = new Date('2026-07-20T12:00:00.000Z');

function snapshot(status: 'Todo' | 'In Progress' = 'Todo'): GitHubLifecycleSnapshot {
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
    pullRequests: [],
    branches: [],
    diagnostics: [],
    lifecycle: {
      items: [{
        kind: 'issue',
        issueNumber: 42,
        v2Marked: status !== 'Todo',
        projectStatus: status,
        labels: [],
        eligible: true,
        eligibilityReason: 'eligible',
      }],
    },
    capturedAt: NOW.toISOString(),
  };
}

function writer(): ReconciliationWriter {
  return new Proxy({} as ReconciliationWriter, {
    get() {
      return async () => null;
    },
  });
}

function completeSnapshot(value: GitHubLifecycleSnapshot): GitHubLifecycleSnapshot {
  return {
    snapshotMode: 'full',
    snapshotComplete: true,
    lastFullReconciliationAt: NOW.toISOString(),
    githubUsage: {
      graphqlRequests: 1,
      graphqlCost: 1,
      graphqlRemaining: 4_000,
      graphqlResetAt: '2026-07-20T13:00:00.000Z',
      restRequests: 0,
      restNotModified: 0,
      cacheHits: 0,
    },
    ...value,
  };
}

function deps(
  overrides: Partial<LifecycleControllerDeps> = {},
): LifecycleControllerDeps {
  const readSnapshot = overrides.readSnapshot ?? (async () => snapshot());
  return {
    writer: writer(),
    now: () => NOW,
    staleAfterMs: 2 * 60 * 60_000,
    runnerId: 'runner-a',
    cycleId: () => 'cycle-1',
    active: {
      preflight: async () => ({ ok: true }),
      readLocalState: () => ({
        remaining: { implementation: 1, child: 1, review: 1 },
        availableLogins: ['implementation-bot'],
        implementationPreferredLogin: 'implementation-bot',
      }),
      implementationBackpressureThreshold: 10,
      executeAction: async () => ({ outcome: 'spawned' }),
    },
    ...overrides,
    readSnapshot: async (rateLimitFloor) => completeSnapshot(
      await readSnapshot(rateLimitFloor),
    ),
  };
}

describe('active lifecycle controller', () => {
  it('fails closed on capability preflight before snapshot or mutation', async () => {
    let reads = 0;
    let actions = 0;
    const controller = deps({
      readSnapshot: async () => {
        reads += 1;
        return snapshot();
      },
      active: {
        preflight: async () => ({ ok: false, detail: 'atomic multi-ref unsupported' }),
        readLocalState: () => ({
          remaining: { implementation: 1, child: 1, review: 1 },
          availableLogins: ['implementation-bot'],
          implementationPreferredLogin: 'implementation-bot',
        }),
        implementationBackpressureThreshold: 10,
        executeAction: async () => {
          actions += 1;
          return { outcome: 'unexpected' };
        },
      },
    });
    const report = await runLifecycleCycle('active', controller);
    expect(report).toMatchObject({
      status: 'rejected',
      message: 'active capability preflight failed: atomic multi-ref unsupported',
    });
    expect({ reads, actions }).toEqual({ reads: 0, actions: 0 });
  });

  it('runs active recovery after capability preflight and before snapshot discovery or claims', async () => {
    const events: string[] = [];
    const controller = deps({
      recoverMarketplaceAttempts: async () => {
        events.push('recover');
      },
      readSnapshot: async () => {
        events.push('snapshot');
        return snapshot();
      },
    });
    controller.active!.preflight = async () => {
      events.push('preflight');
      return { ok: true };
    };
    controller.active!.executeAction = async () => {
      events.push('claim');
      return { outcome: 'spawned' };
    };

    await expect(runLifecycleCycle('active', controller))
      .resolves.toMatchObject({ status: 'ok' });
    expect(events).toEqual(['preflight', 'recover', 'snapshot', 'claim']);
  });

  it('runs recover-mode marketplace recovery before snapshot discovery and reconciliation', async () => {
    const events: string[] = [];
    const controller = deps({
      recoverMarketplaceAttempts: async () => {
        events.push('recover');
      },
      readSnapshot: async () => {
        events.push('snapshot');
        return snapshot('In Progress');
      },
      writerForSnapshot: (cycleSnapshot) => {
        events.push(`writer:${cycleSnapshot.capturedAt}`);
        return writer();
      },
      writer: undefined,
    });

    await expect(runLifecycleCycle('recover', controller))
      .resolves.toMatchObject({ status: 'ok' });
    expect(events[0]).toBe('recover');
    expect(events[1]).toBe('snapshot');
    expect(events[2]).toBe(`writer:${NOW.toISOString()}`);
  });

  it('claims only in explicit active mode', async () => {
    const actions: string[] = [];
    const controller = deps();
    controller.active!.executeAction = async (action) => {
      actions.push(action.kind);
      return { outcome: 'spawned' };
    };
    const active = await runLifecycleCycle('active', controller);
    await runLifecycleCycle('observe', controller);
    expect(actions).toEqual(['claim-implementation']);
    expect(active.status).toBe('ok');
  });

  function childRepairSnapshot(repaired: boolean): GitHubLifecycleSnapshot {
    const childBody = formatChildMarker(2140, 'reconcile');
    return {
      ...snapshot(),
      issues: [
        {
          number: 2141,
          title: 'Reconcile conflicts for PR #2140',
          body: childBody,
          labels: ['reconcile'],
          shape: repaired ? 'fix' : null,
          blockedOn: repaired ? 'Nothing' : null,
          blockedByIssues: [],
          effort: repaired ? 'Medium' : null,
          priority: repaired ? 'P1' : null,
          status: repaired ? 'Todo' : null,
          onBoard: repaired,
          author: 'implementation-bot',
          projectItemId: repaired ? 'PVTI_2141' : null,
          inCurrentSprint: false,
        },
        {
          number: 42,
          title: 'Fresh implementation',
          body: '',
          labels: [],
          shape: 'fix',
          blockedOn: 'Nothing',
          blockedByIssues: [],
          effort: 'Low',
          priority: 'P2',
          status: 'Todo',
          onBoard: true,
          author: 'implementation-bot',
          projectItemId: 'PVTI_42',
          inCurrentSprint: false,
        },
      ],
      lifecycle: {
        items: [
          {
            kind: 'issue',
            issueNumber: 2141,
            v2Marked: true,
            projectStatus: repaired ? 'Todo' : null,
            labels: ['reconcile'],
            eligible: repaired,
            eligibilityReason: repaired ? 'eligible' : 'not-selected',
          },
          {
            kind: 'issue',
            issueNumber: 42,
            v2Marked: false,
            projectStatus: 'Todo',
            labels: [],
            eligible: true,
            eligibilityReason: 'eligible',
          },
        ],
      },
    };
  }

  it('repairs an off-Project legacy reconcile child before fresh implementation work', async () => {
    const actions: unknown[] = [];
    const controller = deps({
      readSnapshot: async () => childRepairSnapshot(false),
    });
    controller.active!.executeAction = async (action) => {
      actions.push(action);
      return { outcome: 'completed' };
    };

    await runLifecycleCycle('active', controller);

    expect(actions).toEqual([
      {
        kind: 'repair-machine-child',
        issueNumber: 2141,
        parentPr: 2140,
        childKind: 'reconcile',
        expectedType: 'fix',
        expectedEffort: 'medium',
        expectedPriority: 'p1',
      },
      { kind: 'claim-implementation', intent: 'fresh', issueNumber: 42 },
    ]);
  });

  it('prioritizes the repaired child over fresh work on the next snapshot', async () => {
    const actions: unknown[] = [];
    const controller = deps({
      readSnapshot: async () => childRepairSnapshot(true),
    });
    controller.active!.executeAction = async (action) => {
      actions.push(action);
      return { outcome: 'spawned' };
    };

    await runLifecycleCycle('active', controller);

    // The child leads, tagged with the lane that admitted it; the fresh claim
    // follows on its own lane's slot rather than waiting behind the child.
    expect(actions).toEqual([
      { kind: 'claim-implementation', intent: 'fresh', issueNumber: 2141, child: true },
      { kind: 'claim-implementation', intent: 'fresh', issueNumber: 42 },
    ]);
  });

  it('threads the same immutable cycle snapshot into reconciliation and active execution', async () => {
    let writerSnapshot: GitHubLifecycleSnapshot | undefined;
    let actionSnapshot: GitHubLifecycleSnapshot | undefined;
    const controller = deps({
      writerForSnapshot: (cycle) => {
        writerSnapshot = cycle;
        return writer();
      },
    });
    controller.active!.executeAction = async (_action, cycle) => {
      actionSnapshot = cycle;
      return { outcome: 'spawned' };
    };

    await runLifecycleCycle('active', controller);

    expect(writerSnapshot).toBeDefined();
    expect(actionSnapshot).toBe(writerSnapshot);
    expect(actionSnapshot?.snapshotComplete).toBe(true);
  });

  it.skip('runs reconciliation first and defers claims after a correcting mutation attempt', async () => {
    let actions = 0;
    const controller = deps({
      readSnapshot: async () => snapshot('In Progress'),
    });
    controller.active!.executeAction = async () => {
      actions += 1;
      return { outcome: 'spawned' };
    };
    const report = await runLifecycleCycle('active', controller);
    expect(actions).toBe(0);
    expect(report.status).toBe('ok');
  });

  it('isolates action failures and emits safe structured reasons', async () => {
    const controller = deps();
    controller.active!.executeAction = async () => {
      throw new Error('claim lost without token material');
    };
    const report = await runLifecycleCycle('active', controller);
    expect(report.status).toBe('ok');
    if (report.status !== 'ok') throw new Error('expected active report');
    expect(report.events).toEqual([
      expect.objectContaining({
        mode: 'active',
        phase: 'eligible',
        action: 'claim-implementation',
        outcome: 'failed',
        reason: 'claim lost without token material',
      }),
      // The lane held a free slot and an eligible candidate and still spawned
      // nothing, which is exactly what the starvation line reports — a failed
      // claim is no more productive than an ineligible one.
      expect.objectContaining({
        subject: 'lane:implementation',
        action: 'schedule',
        outcome: 'starved',
      }),
    ]);
  });

  function implementationPrSnapshot(headChangedAt: string): GitHubLifecycleSnapshot {
    const head = gitOid('1'.repeat(40));
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
      branches: [],
      diagnostics: [],
      pullRequests: [{
        number: 84,
        title: 'stale implementation',
        body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
        author: 'implementation-bot',
        baseRefName: 'next',
        headRefName: 'autopilot/42',
        headOid: head,
        headCommittedAt: headChangedAt,
        isDraft: true,
        state: 'OPEN',
        labels: ['engine:review'],
        closingIssueNumbers: [42],
        mergeability: 'UNKNOWN',
        mergeStateStatus: 'BLOCKED',
        checks: [],
        reviews: [],
      }],
      lifecycle: {
        items: [{
          kind: 'pull-request',
          issueNumber: 42,
          prNumber: 84,
          v2Marked: true,
          projectStatus: 'In Progress',
          labels: ['engine:review'],
          head,
          headChangedAt,
          isDraft: true,
          merged: false,
          needsReview: true,
          approved: false,
          mergeState: 'blocked',
          branchClaim: {
            kind: 'branch-claim',
            protocolVersion: 2,
            phase: 'implement',
            issueNumber: 42,
            prNumber: 84,
            attempt: '11111111-1111-4111-8111-111111111111',
            runner: 'runner-old',
            login: 'implementation-bot',
            expectedHead: head,
            targetBase: gitRefName('next'),
            claimedAt: '2026-07-20T08:00:00.000Z',
          },
        }],
      },
      capturedAt: NOW.toISOString(),
    };
  }

  function priorityIssue(number: number, priority: string) {
    return {
      number,
      title: `Issue ${number}`,
      body: '',
      labels: [],
      shape: 'fix',
      blockedOn: 'Nothing',
      blockedByIssues: [],
      effort: 'Low',
      priority,
      status: 'Todo',
      onBoard: true,
      author: 'implementation-bot',
      projectItemId: `PVTI_${number}`,
      inCurrentSprint: false,
    };
  }

  function priorityItem(number: number) {
    return {
      kind: 'issue',
      issueNumber: number,
      v2Marked: false,
      projectStatus: 'Todo',
      labels: [],
      eligible: true,
      eligibilityReason: 'eligible',
    };
  }

  // Snapshot order is deliberately worst-first: the lowest priority is the
  // first eligible candidate, so an unsorted scheduler claims it.
  function mixedPrioritySnapshot(): GitHubLifecycleSnapshot {
    return {
      ...snapshot(),
      issues: [
        priorityIssue(400, 'P4'),
        priorityIssue(200, 'P2'),
        priorityIssue(100, 'P0'),
      ],
      lifecycle: {
        items: [priorityItem(400), priorityItem(200), priorityItem(100)],
      },
    };
  }

  /**
   * N eligible issues at the same Priority, so the claim order is exactly the
   * snapshot order and a fall-through sequence is readable as a list.
   */
  function eligibleSnapshot(numbers: readonly number[]): GitHubLifecycleSnapshot {
    return {
      ...snapshot(),
      issues: numbers.map((number) => priorityIssue(number, 'P1')),
      lifecycle: { items: numbers.map((number) => priorityItem(number)) },
    };
  }

  function awaitingReviewPr(issueNumber: number, prNumber: number) {
    const head = gitOid(`${prNumber}`.padStart(40, '0'));
    const branchClaim = {
      kind: 'branch-claim',
      protocolVersion: 2,
      phase: 'implement',
      phaseComplete: true,
      issueNumber,
      prNumber,
      attempt: '11111111-1111-4111-8111-111111111111',
      runner: 'runner-a',
      login: 'implementer',
      expectedHead: head,
      targetBase: gitRefName('next'),
      claimedAt: '2026-07-20T11:00:00.000Z',
    };
    return {
      item: {
        kind: 'pull-request',
        issueNumber,
        prNumber,
        v2Marked: true,
        projectStatus: 'In Review',
        labels: ['engine:review'],
        head,
        expectedBaseRefName: 'next',
        headChangedAt: '2026-07-20T11:00:00.000Z',
        isDraft: false,
        merged: false,
        needsReview: true,
        approved: false,
        mergeState: 'blocked',
        branchClaim,
      },
      pullRequest: {
        number: prNumber,
        title: 'feat: lifecycle',
        body: `Closes #${issueNumber}`,
        author: 'implementer',
        baseRefName: 'next',
        headRefName: `autopilot/${issueNumber}`,
        headOid: head,
        headCommittedAt: '2026-07-20T11:00:00.000Z',
        isDraft: false,
        state: 'OPEN',
        labels: ['engine:review'],
        closingIssueNumbers: [issueNumber],
        mergeability: 'UNKNOWN',
        mergeStateStatus: 'BLOCKED',
        checks: [],
        reviews: [],
        branchClaim,
      },
    };
  }

  function awaitingReviewSnapshot(prNumbers: readonly number[]): GitHubLifecycleSnapshot {
    const built = prNumbers.map((prNumber) => awaitingReviewPr(prNumber - 60, prNumber));
    return {
      ...snapshot(),
      issues: [],
      pullRequests: built.map((entry) => entry.pullRequest),
      lifecycle: { items: built.map((entry) => entry.item) },
    };
  }

  describe('ineligible claim fall-through', () => {
    it('attempts the next candidate when a claim refuses as ineligible', async () => {
      const attempted: number[] = [];
      const controller = deps({ readSnapshot: async () => mixedPrioritySnapshot() });
      controller.active!.executeAction = async (action) => {
        attempted.push(action.issueNumber);
        return action.issueNumber === 100
          ? {
              outcome: 'ineligible',
              reason: 'Parent pull request #3437 is retargeted: base is autopilot/3218.',
            }
          : { outcome: 'spawned' };
      };

      const report = await runLifecycleCycle('active', controller);

      expect(attempted).toEqual([100, 200]);
      expect(report.events).toContainEqual(expect.objectContaining({
        action: 'claim-implementation',
        subject: 'issue:200',
        outcome: 'spawned',
      }));
      // The third candidate never runs: the cap still bounds SPAWNED work.
      expect(report.events).toContainEqual(expect.objectContaining({
        action: 'schedule',
        subject: 'issue:400',
        outcome: 'skipped',
        reason: 'capacity',
      }));
      expect(report.events).toContainEqual(expect.objectContaining({
        action: 'schedule',
        subject: 'issue:200',
        outcome: 'promoted',
        reason: 'ineligible-fall-through',
      }));
    });

    it('consumes fall-through backups in priority order', async () => {
      const attempted: number[] = [];
      const controller = deps({ readSnapshot: async () => mixedPrioritySnapshot() });
      controller.active!.executeAction = async (action) => {
        attempted.push(action.issueNumber);
        return { outcome: 'ineligible', reason: 'permanently ineligible' };
      };

      await runLifecycleCycle('active', controller);

      expect(attempted).toEqual([100, 200, 400]);
    });

    it('bounds fall-through attempts per lane per cycle and logs the exhaustion', async () => {
      const attempted: number[] = [];
      const controller = deps({
        readSnapshot: async () => eligibleSnapshot([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      });
      controller.active!.executeAction = async (action) => {
        attempted.push(action.issueNumber);
        return { outcome: 'ineligible', reason: 'permanently ineligible' };
      };

      const report = await runLifecycleCycle('active', controller);

      expect(report.status).toBe('ok');
      // One scheduled claim plus a bounded five fall-through attempts.
      expect(attempted).toEqual([1, 2, 3, 4, 5, 6]);
      expect(report.events).toContainEqual(expect.objectContaining({
        action: 'schedule',
        subject: 'lane:implementation',
        outcome: 'fallthrough-exhausted',
      }));
    });

    it('re-attempts next cycle a candidate that was ineligible this cycle', async () => {
      const cycles: number[][] = [];
      const controller = deps({ readSnapshot: async () => mixedPrioritySnapshot() });
      let current: number[] = [];
      controller.active!.executeAction = async (action) => {
        current.push(action.issueNumber);
        return { outcome: 'ineligible', reason: 'the stack has not collapsed yet' };
      };
      await runLifecycleCycle('active', controller);
      cycles.push(current);

      // Nothing is persisted, so the same head candidate is claimable again the
      // moment GitHub state changes — no manual step, no cache to clear.
      current = [];
      controller.active!.executeAction = async (action) => {
        current.push(action.issueNumber);
        return { outcome: 'spawned' };
      };
      await runLifecycleCycle('active', controller);
      cycles.push(current);

      expect(cycles).toEqual([[100, 200, 400], [100]]);
    });

    it('falls through a review cohort that refuses late', async () => {
      const cohorts: number[][] = [];
      const controller = deps({
        readSnapshot: async () => awaitingReviewSnapshot([101, 102, 103]),
      });
      controller.active!.readLocalState = () => ({
        remaining: { implementation: 0, child: 0, review: 1 },
        availableLogins: ['implementation-bot'],
        implementationPreferredLogin: 'implementation-bot',
      });
      controller.active!.executeAction = async () => {
        throw new Error('review cohort must not use the sequential action port');
      };
      controller.active!.executeReviewActions = async (actions) => {
        cohorts.push(actions.map((action) => action.prNumber));
        return actions.map((action) => (
          action.prNumber === 101
            ? { outcome: 'ineligible', reason: 'Pull request head changed after scheduling.' }
            : { outcome: 'spawned' }
        ));
      };

      const report = await runLifecycleCycle('active', controller);

      expect(cohorts).toEqual([[101], [102]]);
      expect(report.events).toContainEqual(expect.objectContaining({
        action: 'claim-review',
        subject: 'issue:42/pr:102',
        outcome: 'spawned',
      }));
    });
  });

  describe('lane starvation surfacing', () => {
    const starvation = (report: Awaited<ReturnType<typeof runLifecycleCycle>>) => (
      report.events.filter((event) => event.outcome === 'starved')
    );

    it('logs a starved implementation lane distinctly from a capacity skip', async () => {
      const controller = deps({ readSnapshot: async () => mixedPrioritySnapshot() });
      controller.active!.executeAction = async () => ({
        outcome: 'ineligible',
        reason: 'permanently ineligible',
      });

      const report = await runLifecycleCycle('active', controller);

      expect(starvation(report)).toEqual([expect.objectContaining({
        mode: 'active',
        phase: 'eligible',
        action: 'schedule',
        subject: 'lane:implementation',
        outcome: 'starved',
      })]);
      // Distinct from the high-volume line an operator already greps past.
      expect(starvation(report)[0]!.reason).not.toBe('capacity');
    });

    it('logs no starvation when the lane spawned work', async () => {
      const controller = deps({ readSnapshot: async () => mixedPrioritySnapshot() });
      controller.active!.executeAction = async () => ({ outcome: 'spawned' });

      expect(starvation(await runLifecycleCycle('active', controller))).toEqual([]);
    });

    it('logs no starvation when the lane is genuinely full', async () => {
      const controller = deps({ readSnapshot: async () => mixedPrioritySnapshot() });
      controller.active!.readLocalState = () => ({
        remaining: { implementation: 0, child: 0, review: 0 },
        availableLogins: ['implementation-bot'],
        implementationPreferredLogin: 'implementation-bot',
      });
      controller.active!.executeAction = async () => ({ outcome: 'spawned' });

      const report = await runLifecycleCycle('active', controller);

      expect(starvation(report)).toEqual([]);
      expect(report.events).toContainEqual(expect.objectContaining({
        action: 'schedule',
        subject: 'issue:100',
        outcome: 'skipped',
        reason: 'capacity',
      }));
    });

    it('logs no starvation when the lane has no candidates', async () => {
      const controller = deps({
        readSnapshot: async () => ({ ...snapshot(), lifecycle: { items: [] } }),
      });
      controller.active!.executeAction = async () => ({ outcome: 'spawned' });

      expect(starvation(await runLifecycleCycle('active', controller))).toEqual([]);
    });

    it('logs a starved review lane on its own subject', async () => {
      const controller = deps({
        readSnapshot: async () => awaitingReviewSnapshot([101, 102]),
      });
      controller.active!.readLocalState = () => ({
        remaining: { implementation: 0, child: 0, review: 1 },
        availableLogins: ['implementation-bot'],
        implementationPreferredLogin: 'implementation-bot',
      });
      controller.active!.executeAction = async () => ({ outcome: 'spawned' });
      controller.active!.executeReviewActions = async (actions) => actions.map(() => ({
        outcome: 'ineligible',
        reason: 'Draft pull requests are not claimable for review.',
      }));

      const report = await runLifecycleCycle('active', controller);

      expect(starvation(report)).toEqual([expect.objectContaining({
        phase: 'awaiting-review',
        action: 'schedule',
        subject: 'lane:review',
        outcome: 'starved',
      })]);
    });
  });

  describe('the machine-child lane', () => {
    // `review-finding` carries no default triage expectation, so these children
    // are never candidates for machine-child repair and reach the claim lane
    // directly at whatever Priority the fixture gives them.
    function childIssue(number: number, priority: string) {
      return {
        ...priorityIssue(number, priority),
        body: formatChildMarker(3000 + number, 'review-finding'),
        labels: ['review-finding'],
      };
    }

    function childLaneSnapshot(
      children: readonly (readonly [number, string])[],
      fresh: readonly (readonly [number, string])[],
    ): GitHubLifecycleSnapshot {
      const issues = [
        ...children.map(([number, priority]) => childIssue(number, priority)),
        ...fresh.map(([number, priority]) => priorityIssue(number, priority)),
      ];
      return {
        ...snapshot(),
        issues,
        lifecycle: { items: issues.map((issue) => priorityItem(issue.number)) },
      };
    }

    const ladder = (count: number, base: number) => Array.from(
      { length: count },
      (_unused, index) => [base + index, 'P1'] as const,
    );

    it('logs a starved child lane on its own subject', async () => {
      const controller = deps({
        readSnapshot: async () => childLaneSnapshot([[9001, 'P1']], [[100, 'P0']]),
      });
      controller.active!.executeAction = async (action) => (
        action.child === true
          ? { outcome: 'ineligible', reason: 'Parent pull request #3000 is not open.' }
          : { outcome: 'spawned' }
      );

      const report = await runLifecycleCycle('active', controller);

      // The implementation lane spawned, so only the child lane starved — the
      // failure #113 surfaces was previously absorbed into `lane:implementation`.
      expect(report.events.filter((event) => event.outcome === 'starved'))
        .toEqual([expect.objectContaining({
          phase: 'eligible',
          action: 'schedule',
          subject: 'lane:child',
          outcome: 'starved',
        })]);
    });

    it('gives each implementation lane its own fall-through budget', async () => {
      const attempted: number[] = [];
      const controller = deps({
        readSnapshot: async () => childLaneSnapshot(ladder(10, 9000), ladder(10, 100)),
      });
      controller.active!.executeAction = async (action) => {
        attempted.push(action.issueNumber);
        return { outcome: 'ineligible', reason: 'permanently ineligible' };
      };

      const report = await runLifecycleCycle('active', controller);

      // One scheduled claim plus a bounded five fall-throughs, in EACH lane —
      // children and fresh work verifiably shared one budget before.
      expect(attempted).toEqual([
        9000, 9001, 9002, 9003, 9004, 9005,
        100, 101, 102, 103, 104, 105,
      ]);
      for (const lane of ['child', 'implementation']) {
        expect(report.events).toContainEqual(expect.objectContaining({
          action: 'schedule',
          subject: `lane:${lane}`,
          outcome: 'fallthrough-exhausted',
        }));
      }
    });

    it('promotes only child backups when a child claim refuses late', async () => {
      const attempted: number[] = [];
      const controller = deps({
        readSnapshot: async () => childLaneSnapshot(
          [[9001, 'P1'], [9002, 'P1']],
          [[100, 'P0'], [200, 'P2']],
        ),
      });
      controller.active!.executeAction = async (action) => {
        attempted.push(action.issueNumber);
        return action.issueNumber === 9001
          ? { outcome: 'ineligible', reason: 'Parent pull request #3000 is not open.' }
          : { outcome: 'spawned' };
      };

      await runLifecycleCycle('active', controller);

      // The refusal reaches down the child lane's own queue, never across into
      // the fresh one, which keeps its slot for its own highest-priority claim.
      expect(attempted).toEqual([9001, 9002, 100]);
    });

    it('ranks child claims by Priority like every other implementation claim', async () => {
      const claimed: number[] = [];
      // Snapshot order is worst-first: an unranked child lane claims 9002.
      const controller = deps({
        readSnapshot: async () => childLaneSnapshot([[9002, 'P2'], [9001, 'P1']], []),
      });
      controller.active!.executeAction = async (action) => {
        claimed.push(action.issueNumber);
        return { outcome: 'spawned' };
      };

      await runLifecycleCycle('active', controller);

      expect(claimed).toEqual([9001]);
    });

    it('emits no stale-recovery candidate for a machine child', async () => {
      const base = implementationPrSnapshot('2026-07-20T08:00:00.000Z');
      const actions: unknown[] = [];
      const controller = deps({
        readSnapshot: async () => ({
          ...base,
          issues: [{
            ...priorityIssue(42, 'P1'),
            body: formatChildMarker(2140, 'review-finding'),
            labels: ['review-finding'],
          }],
        }),
      });
      controller.active!.executeAction = async (action) => {
        actions.push(action);
        return { outcome: 'spawned' };
      };

      const report = await runLifecycleCycle('active', controller);

      // The executor refuses stale recovery for a child categorically, so the
      // candidate is a guaranteed `ineligible` that spends a real GitHub read
      // and a fall-through attempt from the fresh lane's budget. Do not emit it.
      expect(actions).toEqual([]);
      expect(report.events.some((event) => event.action === 'claim-implementation'))
        .toBe(false);
    });
  });

  describe('priority-ordered implementation claims', () => {
    it('claims the highest-priority eligible issue when only one slot is free', async () => {
      const claimed: number[] = [];
      const controller = deps({ readSnapshot: async () => mixedPrioritySnapshot() });
      controller.active!.executeAction = async (action) => {
        if (action.kind === 'claim-implementation') claimed.push(action.issueNumber);
        return { outcome: 'spawned' };
      };

      await runLifecycleCycle('active', controller);

      expect(claimed).toEqual([100]);
    });

    it('resumes stale in-flight work before starting a higher-priority fresh claim', async () => {
      // Reuses the proven stale-recovery fixture (issue #42, no Priority) and adds
      // one eligible fresh P0. With a single slot, ordering decides which runs.
      const base = implementationPrSnapshot('2026-07-20T08:00:00.000Z');
      const stale: GitHubLifecycleSnapshot = {
        ...base,
        issues: [priorityIssue(100, 'P0')],
        // Fresh P0 placed FIRST: snapshot order alone would claim it.
      lifecycle: { items: [priorityItem(100), ...base.lifecycle.items] },
      };
      const claimed: unknown[] = [];
      const controller = deps({ readSnapshot: async () => stale });
      controller.active!.executeAction = async (action) => {
        if (action.kind === 'claim-implementation') claimed.push(action.intent);
        return { outcome: 'spawned' };
      };

      await runLifecycleCycle('active', controller);

      expect(claimed).toEqual(['stale-recovery']);
    });

    it('orders every claim by priority when several slots are free', async () => {
      const claimed: number[] = [];
      const controller = deps({ readSnapshot: async () => mixedPrioritySnapshot() });
      controller.active!.readLocalState = () => ({
        remaining: { implementation: 3, child: 3, review: 1 },
        availableLogins: ['implementation-bot'],
        implementationPreferredLogin: 'implementation-bot',
      });
      controller.active!.executeAction = async (action) => {
        if (action.kind === 'claim-implementation') claimed.push(action.issueNumber);
        return { outcome: 'spawned' };
      };

      await runLifecycleCycle('active', controller);

      expect(claimed).toEqual([100, 200, 400]);
    });
  });

  it('pins stale implementation recovery to the observed PR, head, branch, and claim', async () => {
    const head = gitOid('1'.repeat(40));
    const actions: unknown[] = [];
    const controller = deps({
      readSnapshot: async () => implementationPrSnapshot('2026-07-20T08:00:00.000Z'),
    });
    controller.active!.executeAction = async (action) => {
      actions.push(action);
      return { outcome: 'spawned' };
    };

    await runLifecycleCycle('active', controller);
    expect(actions).toEqual([{
      kind: 'claim-implementation',
      intent: 'stale-recovery',
      issueNumber: 42,
      prNumber: 84,
      expectedHead: head,
      branch: gitRefName('autopilot/42'),
      claimAttempt: '11111111-1111-4111-8111-111111111111',
    }]);
  });

  it('does not schedule a non-stale In Progress implementation as fresh work', async () => {
    const actions: unknown[] = [];
    const controller = deps({
      readSnapshot: async () => implementationPrSnapshot('2026-07-20T11:00:00.000Z'),
    });
    controller.active!.executeAction = async (action) => {
      actions.push(action);
      return { outcome: 'unexpected' };
    };

    await runLifecycleCycle('active', controller);

    expect(actions).toEqual([]);
  });

  it.skip('does not let a permanently-failing reconciliation action for one issue block claim scheduling for an unrelated issue', async () => {
    // Issue 99 has a stuck project-status write (e.g. an archived project item) that
    // will fail every cycle forever. Issue 42 is an unrelated, otherwise-eligible issue
    // with nothing to reconcile. A poisoned item must not starve the whole fleet.
    const poisoned: GitHubLifecycleSnapshot = {
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
      branches: [],
      diagnostics: [],
      pullRequests: [],
      lifecycle: {
        items: [
          {
            kind: 'issue',
            issueNumber: 42,
            v2Marked: true,
            projectStatus: 'Todo',
            labels: [],
            eligible: true,
            eligibilityReason: 'eligible',
          },
          {
            kind: 'issue',
            issueNumber: 99,
            v2Marked: true,
            projectStatus: null,
            labels: [],
            eligible: true,
            eligibilityReason: 'eligible',
          },
        ],
      },
      capturedAt: NOW.toISOString(),
    };
    const failingWriter: ReconciliationWriter = new Proxy({} as ReconciliationWriter, {
      get(_target, prop) {
        if (prop === 'setProjectStatus') {
          return async (issueNumber: number) => {
            if (issueNumber === 99) throw new Error('project item is archived');
          };
        }
        return async () => null;
      },
    });
    const actions: unknown[] = [];
    const controller = deps({
      readSnapshot: async () => poisoned,
      writer: failingWriter,
    });
    controller.active!.executeAction = async (action) => {
      actions.push(action);
      return { outcome: 'spawned' };
    };

    const first = await runLifecycleCycle('active', controller);
    expect(actions).toEqual([
      { kind: 'claim-implementation', intent: 'fresh', issueNumber: 42 },
    ]);
    if (first.status !== 'ok') throw new Error('expected active report');
    expect(first.reconciliation?.results).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        action: expect.objectContaining({ issueNumber: 99 }),
      }),
    ]);

    // The poisoned action re-plans and re-fails every cycle; issue 42 must keep
    // being claimable in later cycles too, not just the first.
    actions.length = 0;
    const second = await runLifecycleCycle('active', controller);
    expect(actions).toEqual([
      { kind: 'claim-implementation', intent: 'fresh', issueNumber: 42 },
    ]);
    expect(second.status).toBe('ok');
  });

  // jinn-mono#1883 follow-up: `implementationComplete && item.implementationSummary
  // !== undefined` is permanently true once implementation finishes, so
  // `ensure-implementation-summary` is emitted every cycle for a finalized PR
  // (the writer no-ops once the PR body already matches, but the action
  // itself stays in the plan). Before excluding it in `blockedIssueNumbers`,
  // that permanent pending action treated the PR's issue as blocked forever,
  // so `claim-review` was never scheduled for it.
  function finalizedPrSnapshot(projectStatus: 'In Review' | 'Todo' = 'In Review'): GitHubLifecycleSnapshot {
    const head = gitOid('8'.repeat(40));
    return {
      project: {
        items: [],
        rateLimit: { remaining: 4_000, used: 1_000, resetAt: '2026-07-20T13:00:00.000Z' },
        currentSprintIterationId: null,
      },
      issues: [],
      branches: [],
      diagnostics: [],
      pullRequests: [{
        number: 84,
        title: 'implementation',
        body: 'Closes #42',
        author: 'implementation-bot',
        baseRefName: 'next',
        headRefName: 'autopilot/42',
        headOid: head,
        headCommittedAt: '2026-07-20T08:00:00.000Z',
        isDraft: false,
        state: 'OPEN',
        labels: ['engine:review'],
        closingIssueNumbers: [42],
        mergeability: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        checks: [],
        reviews: [],
      }],
      lifecycle: {
        items: [{
          kind: 'pull-request',
          issueNumber: 42,
          prNumber: 84,
          v2Marked: true,
          projectStatus,
          labels: ['engine:review'],
          head,
          headChangedAt: '2026-07-20T08:00:00.000Z',
          isDraft: false,
          merged: false,
          needsReview: true,
          approved: false,
          mergeState: 'clean',
          branchClaim: {
            kind: 'branch-claim',
            protocolVersion: 2,
            phase: 'implement',
            phaseComplete: true,
            issueNumber: 42,
            prNumber: 84,
            attempt: '55555555-5555-4555-8555-555555555555',
            runner: 'runner-old',
            login: 'implementation-bot',
            expectedHead: head,
            targetBase: gitRefName('next'),
            claimedAt: '2026-07-20T08:00:00.000Z',
          },
          implementationSummary: 'Implemented the thing.',
        }],
      },
      capturedAt: NOW.toISOString(),
    };
  }

  function finalizedPrActive(): NonNullable<LifecycleControllerDeps['active']> {
    return {
      preflight: async () => ({ ok: true }),
      readLocalState: () => ({
        remaining: { implementation: 1, child: 1, review: 1 },
        availableLogins: ['review-bot'],
        implementationPreferredLogin: 'review-bot',
      }),
      implementationBackpressureThreshold: 10,
      executeAction: async () => ({ outcome: 'spawned' }),
    };
  }

  it.skip('schedules a review claim for a finalized PR even though its ensure-implementation-summary projection is pending', async () => {
    const head = gitOid('8'.repeat(40));
    const actions: unknown[] = [];
    const controller = deps({
      readSnapshot: async () => finalizedPrSnapshot('In Review'),
      active: finalizedPrActive(),
    });
    controller.active!.executeAction = async (action) => {
      actions.push(action);
      return { outcome: 'spawned' };
    };

    const report = await runLifecycleCycle('active', controller);
    expect(actions).toEqual([{
      kind: 'claim-review',
      issueNumber: 42,
      prNumber: 84,
      head,
      recoverFixes: false,
    }]);
    if (report.status !== 'ok') throw new Error('expected active report');
    // Confirms the plan really did carry the pending body-sync action this
    // cycle -- proving the exclusion, not an absent action, is what let the
    // claim through.
    expect(report.reconciliation?.results).toContainEqual(expect.objectContaining({
      action: expect.objectContaining({ kind: 'ensure-implementation-summary', prNumber: 84 }),
    }));
  });

  it.skip('still blocks the claim when a genuinely state-correcting action is pending for the same PR', async () => {
    // Same finalized PR, but its project status has drifted to 'Todo' (e.g. a
    // stray manual edit), which plans a real correcting `set-project-status`
    // action alongside `ensure-implementation-summary`. Proves the new
    // exclusion is narrow: it does not launder every other action kind past
    // the reconcile-before-claim guarantee.
    const actions: unknown[] = [];
    const controller = deps({
      readSnapshot: async () => finalizedPrSnapshot('Todo'),
      active: finalizedPrActive(),
    });
    controller.active!.executeAction = async (action) => {
      actions.push(action);
      return { outcome: 'spawned' };
    };

    const report = await runLifecycleCycle('active', controller);
    expect(actions).toEqual([]);
    if (report.status !== 'ok') throw new Error('expected active report');
    expect(report.reconciliation?.results).toContainEqual(expect.objectContaining({
      action: expect.objectContaining({ kind: 'set-project-status', issueNumber: 42 }),
    }));
  });
});

// jinn-mono#1883: `JINN_AUTOPILOT_ONLY_ISSUES` canary safety knob. Restricts
// active-mode NEW-WORK claim scheduling to a fixed set of issue numbers so a
// single disposable canary issue can run safely alongside another agent's
// live work on the same board (runbook §8). Must not restrict reconciliation
// of existing items.
describe('active lifecycle controller — JINN_AUTOPILOT_ONLY_ISSUES allowlist (#1883)', () => {
  // Both issues already sit at their reconciler-desired project status
  // ('Todo' for an eligible issue), so this cycle plans zero reconciliation
  // actions for either — the per-item "reconcile before claim" guarantee
  // (`blockedIssueNumbers` in controller.ts) can't confound the assertions
  // below with an unrelated block.
  function twoEligibleIssuesSnapshot(): GitHubLifecycleSnapshot {
    return {
      project: {
        items: [],
        rateLimit: { remaining: 4_000, used: 1_000, resetAt: '2026-07-20T13:00:00.000Z' },
        currentSprintIterationId: null,
      },
      issues: [],
      pullRequests: [],
      branches: [],
      diagnostics: [],
      lifecycle: {
        items: [
          {
            kind: 'issue',
            issueNumber: 42,
            v2Marked: true,
            projectStatus: 'Todo',
            labels: [],
            eligible: true,
            eligibilityReason: 'eligible',
          },
          {
            kind: 'issue',
            issueNumber: 99,
            v2Marked: true,
            projectStatus: 'Todo',
            labels: [],
            eligible: true,
            eligibilityReason: 'eligible',
          },
        ],
      },
      capturedAt: NOW.toISOString(),
    };
  }

  function twoSlotActive(
    onlyIssues?: ReadonlySet<number>,
  ): NonNullable<LifecycleControllerDeps['active']> {
    return {
      preflight: async () => ({ ok: true }),
      readLocalState: () => ({
        remaining: { implementation: 2, child: 2, review: 2 },
        availableLogins: ['implementation-bot', 'implementation-bot-2'],
        implementationPreferredLogin: 'implementation-bot',
      }),
      implementationBackpressureThreshold: 10,
      executeAction: async () => ({ outcome: 'spawned' }),
      ...(onlyIssues === undefined ? {} : { onlyIssues }),
    };
  }

  it('excludes an eligible issue outside the allowlist from claim-implementation scheduling', async () => {
    const actions: unknown[] = [];
    const controller = deps({
      readSnapshot: async () => twoEligibleIssuesSnapshot(),
      active: twoSlotActive(new Set([42])),
    });
    controller.active!.executeAction = async (action) => {
      actions.push(action);
      return { outcome: 'spawned' };
    };
    const report = await runLifecycleCycle('active', controller);
    expect(actions).toEqual([
      { kind: 'claim-implementation', intent: 'fresh', issueNumber: 42 },
    ]);
    expect(report.status).toBe('ok');
  });

  it('schedules both issues when the allowlist is unset (pure no-op)', async () => {
    const actions: unknown[] = [];
    const controller = deps({
      readSnapshot: async () => twoEligibleIssuesSnapshot(),
      active: twoSlotActive(),
    });
    controller.active!.executeAction = async (action) => {
      actions.push(action);
      return { outcome: 'spawned' };
    };
    await runLifecycleCycle('active', controller);
    expect(actions).toEqual([
      { kind: 'claim-implementation', intent: 'fresh', issueNumber: 42 },
      { kind: 'claim-implementation', intent: 'fresh', issueNumber: 99 },
    ]);
  });

  // #99 deliberately has no project status yet, so reconciliation has a
  // `set-project-status` action to run for it every cycle regardless of
  // whether the allowlist below excludes it from claiming. The filter must
  // be scoped to NEW-WORK claim scheduling only, so this action — and its
  // outcome — must be identical whether or not the allowlist is set.
  function needsReconciliationSnapshot(): GitHubLifecycleSnapshot {
    const base = twoEligibleIssuesSnapshot();
    return {
      ...base,
      lifecycle: {
        items: base.lifecycle.items.map((item) => (
          item.kind === 'issue' && item.issueNumber === 99
            ? { ...item, projectStatus: null }
            : item
        )),
      },
    };
  }

  it.skip('still reconciles a non-allowlisted issue exactly the same as when unrestricted', async () => {
    const restricted = deps({
      readSnapshot: async () => needsReconciliationSnapshot(),
      active: twoSlotActive(new Set([42])),
    });
    const unrestricted = deps({
      readSnapshot: async () => needsReconciliationSnapshot(),
      active: twoSlotActive(),
    });
    const restrictedReport = await runLifecycleCycle('active', restricted);
    const unrestrictedReport = await runLifecycleCycle('active', unrestricted);
    if (restrictedReport.status !== 'ok' || unrestrictedReport.status !== 'ok') {
      throw new Error('expected active reports');
    }
    const issue99Action = expect.objectContaining({
      action: expect.objectContaining({ kind: 'set-project-status', issueNumber: 99 }),
    });
    expect(restrictedReport.reconciliation?.results).toContainEqual(issue99Action);
    expect(restrictedReport.reconciliation?.results).toEqual(
      unrestrictedReport.reconciliation?.results,
    );
  });

  function reviewCandidateSnapshot(): GitHubLifecycleSnapshot {
    const headA = gitOid('6'.repeat(40));
    const headB = gitOid('7'.repeat(40));
    // Both the PR's native labels and the lifecycle item's `labels` carry
    // 'engine:review' already, and `projectStatus` is already 'In Review' —
    // `planItem` wants both for the 'awaiting-review' phase, so a mismatch
    // in either would generate a correcting reconciliation action, which
    // the per-item "reconcile before claim" guarantee (see
    // `blockedIssueNumbers` in controller.ts) would defer the claim behind,
    // confounding this test with an unrelated block.
    const prBase = {
      title: 'implementation',
      author: 'implementation-bot',
      baseRefName: 'next',
      isDraft: false,
      state: 'OPEN' as const,
      labels: ['engine:review'],
      mergeability: 'MERGEABLE' as const,
      mergeStateStatus: 'CLEAN',
      checks: [],
      reviews: [],
    };
    const lifecycleBase = {
      kind: 'pull-request' as const,
      v2Marked: true,
      projectStatus: 'In Review' as const,
      labels: ['engine:review'],
      isDraft: false,
      merged: false,
      needsReview: true,
      approved: false,
      mergeState: 'clean' as const,
    };
    return {
      project: {
        items: [],
        rateLimit: { remaining: 4_000, used: 1_000, resetAt: '2026-07-20T13:00:00.000Z' },
        currentSprintIterationId: null,
      },
      issues: [],
      branches: [],
      diagnostics: [],
      pullRequests: [
        {
          ...prBase,
          number: 84,
          body: 'Closes #42',
          headRefName: 'autopilot/42',
          headOid: headA,
          headCommittedAt: '2026-07-20T08:00:00.000Z',
          closingIssueNumbers: [42],
        },
        {
          ...prBase,
          number: 85,
          body: 'Closes #43',
          headRefName: 'autopilot/43',
          headOid: headB,
          headCommittedAt: '2026-07-20T08:00:00.000Z',
          closingIssueNumbers: [43],
        },
      ],
      lifecycle: {
        items: [
          {
            ...lifecycleBase,
            issueNumber: 42,
            prNumber: 84,
            head: headA,
            headChangedAt: '2026-07-20T08:00:00.000Z',
          },
          {
            ...lifecycleBase,
            issueNumber: 43,
            prNumber: 85,
            head: headB,
            headChangedAt: '2026-07-20T08:00:00.000Z',
          },
        ],
      },
      capturedAt: NOW.toISOString(),
    };
  }

  it.skip('excludes a review candidate whose issue is outside the allowlist; admits one inside it', async () => {
    const actions: unknown[] = [];
    const controller = deps({
      readSnapshot: async () => reviewCandidateSnapshot(),
      active: {
        preflight: async () => ({ ok: true }),
        readLocalState: () => ({
          remaining: { implementation: 2, child: 2, review: 2 },
          availableLogins: ['review-bot-1', 'review-bot-2'],
          implementationPreferredLogin: 'review-bot-1',
        }),
        implementationBackpressureThreshold: 10,
        executeAction: async () => ({ outcome: 'spawned' }),
        onlyIssues: new Set([42]),
      },
    });
    controller.active!.executeAction = async (action) => {
      actions.push(action);
      return { outcome: 'spawned' };
    };
    await runLifecycleCycle('active', controller);
    expect(actions).toEqual([{
      kind: 'claim-review',
      issueNumber: 42,
      prNumber: 84,
      head: gitOid('6'.repeat(40)),
      recoverFixes: false,
    }]);
  });

  // Every `ActiveCandidate` variant carries a required `issueNumber` sourced
  // from an already-resolved lifecycle item — an ambiguous PR-to-issue
  // mapping never reaches `activeCandidates` (it is diverted to diagnostics
  // upstream in `resolveMappings`), so this scenario cannot occur via the
  // real snapshot pipeline today. `matchesOnlyIssuesAllowlist` fails closed
  // on it anyway, matching the fail-closed contract even if that upstream
  // invariant is ever weakened.
  it('excludes a candidate with an undeterminable issue number when the allowlist is set (fail closed)', () => {
    expect(matchesOnlyIssuesAllowlist(undefined, new Set([1896]))).toBe(false);
    expect(matchesOnlyIssuesAllowlist(1896, new Set([1896]))).toBe(true);
    expect(matchesOnlyIssuesAllowlist(1902, new Set([1896]))).toBe(false);
  });

  it('does not fail closed on an undeterminable issue number when the allowlist is unset', () => {
    expect(matchesOnlyIssuesAllowlist(undefined, undefined)).toBe(true);
  });
});
