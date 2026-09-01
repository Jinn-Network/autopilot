// @ts-nocheck — Stage 5: deleted merge-prep/review-fix/project-status fixtures.
import { describe, expect, it } from 'vitest';
import {
  scheduleActiveActions,
  type ActiveSchedulingInput,
} from '../../src/lifecycle/active-scheduler.js';
import { gitOid, gitRefName } from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));

function input(overrides: Partial<ActiveSchedulingInput> = {}): ActiveSchedulingInput {
  return {
    candidates: [
      { phase: 'implementation', intent: 'fresh', issueNumber: 1 },
      { phase: 'implementation', intent: 'fresh', issueNumber: 2 },
      { phase: 'review', issueNumber: 3, prNumber: 30, head: HEAD, author: 'other' },
      {
        phase: 'enqueue',
        issueNumber: 5,
        prNumber: 50,
        head: HEAD,
        expectedBaseRefName: gitRefName('autopilot/4'),
      },
    ],
    remaining: { implementation: 1, review: 1 },
    availableLogins: [
      'implementation-bot',
      'review-bot',
      'merge-bot',
    ],
    implementationPreferredLogin: 'implementation-bot',
    openPipelineBacklog: 0,
    implementationBackpressureThreshold: 10,
    ...overrides,
  };
}

describe('active local scheduler', () => {
  it('enforces independent per-phase local caps and keeps the enqueue claimless', () => {
    const plan = scheduleActiveActions(input());
    expect(plan.actions.map((action) => action.kind)).toEqual([
      'claim-implementation',
      'claim-review',
      'enqueue',
    ]);
  });

  it.each([
    {
      phase: 'file-reconcile-child' as const,
      expected: {
        kind: 'file-reconcile-child',
        issueNumber: 42,
        prNumber: 84,
        head: HEAD,
        expectedBaseRefName: gitRefName('stack/custom-parent'),
        effort: 'medium' as const,
      },
    },
  ])('preserves the canonical stacked base for $phase actions', ({ phase, expected }) => {
    const plan = scheduleActiveActions(input({
      candidates: [{
        phase,
        issueNumber: 42,
        prNumber: 84,
        head: HEAD,
        expectedBaseRefName: gitRefName('stack/custom-parent'),
        ...(phase === 'file-reconcile-child' ? { effort: 'medium' as const } : {}),
      }],
      remaining: { implementation: 0, review: 0 },
    }));

    expect(plan.actions).toEqual([expected]);
  });

  it('schedules machine-child repair first without consuming an implementation slot', () => {
    const plan = scheduleActiveActions(input({
      candidates: [
        {
          phase: 'repair-machine-child',
          issueNumber: 2141,
          parentPr: 2140,
          childKind: 'reconcile',
          expectedType: 'fix',
          expectedEffort: 'medium',
          expectedPriority: 'p1',
        },
        { phase: 'implementation', intent: 'fresh', issueNumber: 42 },
        { phase: 'implementation', intent: 'fresh', issueNumber: 43 },
      ],
      remaining: { implementation: 1, review: 0 },
    }));

    expect(plan.actions).toEqual([
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
    expect(plan.skips).toContainEqual({
      phase: 'implementation',
      subject: 'issue:43',
      reason: 'capacity',
    });
  });

  it('suppresses only fresh implementation at the GitHub backlog threshold', () => {
    const plan = scheduleActiveActions(input({ openPipelineBacklog: 10 }));
    expect(plan.actions.map((action) => action.kind)).toEqual([
      'claim-review',
      'enqueue',
    ]);
    expect(plan.skips).toContainEqual({
      phase: 'implementation',
      subject: 'issue:1',
      reason: 'backpressure',
    });
  });

  it('still claims machine children under open-pipeline backpressure', () => {
    const plan = scheduleActiveActions(input({
      candidates: [
        { phase: 'implementation', intent: 'fresh', issueNumber: 99, isChild: true },
        { phase: 'implementation', intent: 'fresh', issueNumber: 1 },
        { phase: 'review', issueNumber: 3, prNumber: 30, head: HEAD, author: 'other' },
        {
          phase: 'enqueue',
          issueNumber: 5,
          prNumber: 50,
          head: HEAD,
          expectedBaseRefName: gitRefName('autopilot/4'),
        },
      ],
      openPipelineBacklog: 10,
      remaining: { implementation: 2, review: 1 },
    }));
    expect(plan.actions).toEqual([
      { kind: 'claim-implementation', intent: 'fresh', issueNumber: 99 },
      {
        kind: 'claim-review',
        issueNumber: 3,
        prNumber: 30,
        head: HEAD,
      },
      {
        kind: 'enqueue',
        issueNumber: 5,
        prNumber: 50,
        head: HEAD,
        expectedBaseRefName: gitRefName('autopilot/4'),
      },
    ]);
    expect(plan.skips).toContainEqual({
      phase: 'implementation',
      subject: 'issue:1',
      reason: 'backpressure',
    });
  });

  it('preserves pinned stale-recovery authority and exempts only recovery from backpressure', () => {
    const plan = scheduleActiveActions(input({
      candidates: [
        {
          phase: 'implementation',
          intent: 'stale-recovery',
          issueNumber: 42,
          prNumber: 84,
          expectedHead: HEAD,
          branch: 'existing/42',
          claimAttempt: '11111111-1111-4111-8111-111111111111',
        },
        { phase: 'implementation', intent: 'fresh', issueNumber: 43 },
      ],
      openPipelineBacklog: 10,
      remaining: { implementation: 2, review: 0 },
    }));

    expect(plan.actions).toEqual([{
      kind: 'claim-implementation',
      intent: 'stale-recovery',
      issueNumber: 42,
      prNumber: 84,
      expectedHead: HEAD,
      branch: 'existing/42',
      claimAttempt: '11111111-1111-4111-8111-111111111111',
    }]);
    expect(plan.skips).toContainEqual({
      phase: 'implementation',
      subject: 'issue:43',
      reason: 'backpressure',
    });
  });

  it('schedules both implement and review with one login when review targets another author', () => {
    const plan = scheduleActiveActions(input({
      candidates: [
        { phase: 'implementation', intent: 'fresh', issueNumber: 1 },
        { phase: 'review', issueNumber: 3, prNumber: 30, head: HEAD, author: 'other' },
      ],
      availableLogins: ['implementation-bot'],
      remaining: { implementation: 1, review: 1 },
    }));
    expect(plan.actions.map((action) => action.kind)).toEqual([
      'claim-implementation',
      'claim-review',
    ]);
  });

  it('caps implementation concurrency by phase remaining, not login count', () => {
    const plan = scheduleActiveActions(input({
      candidates: [
        { phase: 'implementation', intent: 'fresh', issueNumber: 1 },
        { phase: 'implementation', intent: 'fresh', issueNumber: 2 },
        { phase: 'implementation', intent: 'fresh', issueNumber: 3 },
        { phase: 'implementation', intent: 'fresh', issueNumber: 4 },
      ],
      availableLogins: ['implementation-bot'],
      remaining: { implementation: 3, review: 0 },
    }));
    expect(plan.actions).toEqual([
      { kind: 'claim-implementation', intent: 'fresh', issueNumber: 1 },
      { kind: 'claim-implementation', intent: 'fresh', issueNumber: 2 },
      { kind: 'claim-implementation', intent: 'fresh', issueNumber: 3 },
    ]);
    expect(plan.skips).toContainEqual({
      phase: 'implementation',
      subject: 'issue:4',
      reason: 'capacity',
    });
  });

  it('uses the one login to review another author when no implementation is selected', () => {
    const plan = scheduleActiveActions(input({
      candidates: [
        { phase: 'review', issueNumber: 3, prNumber: 30, head: HEAD, author: 'other' },
      ],
      availableLogins: ['implementation-bot'],
    }));
    expect(plan.actions).toEqual([{
      kind: 'claim-review',
      issueNumber: 3,
      prNumber: 30,
      head: HEAD,
    }]);
  });

  it('never schedules a reviewer against its own authored PR', () => {
    const plan = scheduleActiveActions(input({
      candidates: [
        {
          phase: 'review',
          issueNumber: 3,
          prNumber: 30,
          head: HEAD,
          author: 'implementation-bot',
        },
      ],
      availableLogins: ['implementation-bot'],
    }));
    expect(plan.actions).toEqual([]);
  });

  it('derives no global or other-runner capacity signal', () => {
    expect(Object.keys(input().remaining).sort()).toEqual([
      'implementation',
      'review',
    ]);
  });

  describe('ineligible-claim fall-through backups', () => {
    it('emits the capacity surplus as ordered implementation backups', () => {
      const plan = scheduleActiveActions(input({
        candidates: [
          { phase: 'implementation', intent: 'fresh', issueNumber: 1 },
          { phase: 'implementation', intent: 'fresh', issueNumber: 2 },
          { phase: 'implementation', intent: 'fresh', issueNumber: 3 },
        ],
        remaining: { implementation: 1, review: 0 },
      }));

      expect(plan.actions).toEqual([
        { kind: 'claim-implementation', intent: 'fresh', issueNumber: 1 },
      ]);
      // Same order the plan itself used: a backup is only ever the next
      // candidate the cap displaced, never a re-ranking of the queue.
      expect(plan.backups.implementation).toEqual([
        { kind: 'claim-implementation', intent: 'fresh', issueNumber: 2 },
        { kind: 'claim-implementation', intent: 'fresh', issueNumber: 3 },
      ]);
      expect(plan.skips).toContainEqual({
        phase: 'implementation',
        subject: 'issue:2',
        reason: 'capacity',
      });
      expect(plan.skips).toContainEqual({
        phase: 'implementation',
        subject: 'issue:3',
        reason: 'capacity',
      });
    });

    it('keeps a backpressure-suppressed surplus out of the implementation backups', () => {
      const plan = scheduleActiveActions(input({
        candidates: [
          { phase: 'implementation', intent: 'fresh', issueNumber: 99, isChild: true },
          { phase: 'implementation', intent: 'fresh', issueNumber: 1 },
          { phase: 'implementation', intent: 'fresh', issueNumber: 2, isChild: true },
        ],
        openPipelineBacklog: 10,
        remaining: { implementation: 1, review: 0 },
      }));

      expect(plan.actions).toEqual([
        { kind: 'claim-implementation', intent: 'fresh', issueNumber: 99 },
      ]);
      // Issue 1 is a fresh claim under backpressure: it was never eligible to
      // run this cycle, so promoting it would defeat the threshold.
      expect(plan.backups.implementation).toEqual([
        { kind: 'claim-implementation', intent: 'fresh', issueNumber: 2 },
      ]);
    });

    it('keeps the credential-less surplus out of the implementation backups', () => {
      const plan = scheduleActiveActions(input({
        candidates: [
          { phase: 'implementation', intent: 'fresh', issueNumber: 1 },
          { phase: 'implementation', intent: 'fresh', issueNumber: 2 },
        ],
        availableLogins: [],
        remaining: { implementation: 1, review: 0 },
      }));

      expect(plan.actions).toEqual([]);
      expect(plan.backups.implementation).toEqual([]);
    });

    it('emits the review surplus as ordered review backups', () => {
      const plan = scheduleActiveActions(input({
        candidates: [
          { phase: 'review', issueNumber: 3, prNumber: 30, head: HEAD, author: 'other' },
          {
            phase: 'review',
            issueNumber: 4,
            prNumber: 40,
            head: HEAD,
            author: 'implementation-bot',
          },
          { phase: 'review', issueNumber: 5, prNumber: 50, head: HEAD, author: 'other' },
        ],
        availableLogins: ['implementation-bot'],
        remaining: { implementation: 0, review: 1 },
      }));

      expect(plan.actions).toEqual([
        { kind: 'claim-review', issueNumber: 3, prNumber: 30, head: HEAD },
      ]);
      // PR 40 is authored by the only login: no reviewer exists for it at any
      // capacity, so it is not a promotable backup either.
      expect(plan.backups.review).toEqual([
        { kind: 'claim-review', issueNumber: 5, prNumber: 50, head: HEAD },
      ]);
    });

    it('emits no backups at all while new work is paused', () => {
      const plan = scheduleActiveActions(input({
        remaining: { implementation: 0, review: 0 },
        newWorkPaused: true,
      }));

      expect(plan.backups).toEqual({ implementation: [], review: [] });
    });
  });

  it('reports disk-floor skips when new work is paused', () => {
    const plan = scheduleActiveActions(input({
      remaining: { implementation: 0, review: 0 },
      newWorkPaused: true,
    }));
    expect(plan.actions.map((action) => action.kind)).toEqual(['enqueue']);
    expect(plan.skips).toContainEqual({
      phase: 'implementation',
      subject: 'issue:1',
      reason: 'disk-floor',
    });
    expect(plan.skips).toContainEqual({
      phase: 'review',
      subject: 'pr:30',
      reason: 'disk-floor',
    });
  });
});
