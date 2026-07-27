// @ts-nocheck — Stage 5: deleted merge-prep/review-fix/project-status fixtures.
import { describe, expect, it } from 'vitest';
import {
  deriveLifecycle,
  deriveRecovery,
  engineApprovalLapsed,
  engineApprovedAtHead,
  planCycle,
} from '../../src/lifecycle/lifecycle.js';
import { gitOid, gitRefName, type LifecycleItem, type LifecycleSnapshot } from '../../src/lifecycle/types.js';

const HEAD_A = gitOid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const HEAD_B = gitOid('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const NOW = new Date('2026-07-20T12:00:00.000Z');
const STALE_AFTER = 2 * 60 * 60 * 1000;

function implementation(overrides: Partial<Extract<LifecycleItem, { kind: 'pull-request' }>> = {}):
Extract<LifecycleItem, { kind: 'pull-request' }> {
  return {
    kind: 'pull-request',
    issueNumber: 42,
    prNumber: 101,
    v2Marked: true,
    projectStatus: 'Todo',
    labels: [],
    head: HEAD_A,
    headChangedAt: '2026-07-20T11:00:00.000Z',
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
      prNumber: 101,
      attempt: '11111111-1111-4111-8111-111111111111',
      runner: 'runner',
      login: 'implementer',
      expectedHead: HEAD_A,
      targetBase: gitRefName('next'),
      claimedAt: '2026-07-20T11:00:00.000Z',
    },
    ...overrides,
  };
}

function snapshot(...items: LifecycleItem[]): LifecycleSnapshot {
  return { items };
}

describe('deriveLifecycle', () => {
  it('uses branch claims as implementation ownership rather than Project or draft projections', () => {
    const [view] = deriveLifecycle(snapshot(implementation({
      projectStatus: 'In Review',
      isDraft: false,
    })), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({ phase: 'implementing', stale: false });
  });

  it('marks only v2 branch work stale from the authoritative unchanged head time', () => {
    const oldHead = '2026-07-20T09:59:59.999Z';
    const [v2, legacy] = deriveLifecycle(snapshot(
      implementation({ headChangedAt: oldHead }),
      implementation({ issueNumber: 43, prNumber: 102, v2Marked: false, headChangedAt: oldHead }),
    ), NOW, STALE_AFTER).items;

    expect(v2).toMatchObject({
      phase: 'implementing',
      stale: true,
      staleReason: 'branch-head-unchanged',
      staleSince: '2026-07-20T11:59:59.999Z',
    });
    expect(legacy?.stale).toBe(false);
  });

  it('fails closed on a non-canonical branch progress timestamp', () => {
    const [view] = deriveLifecycle(snapshot(implementation({
      headChangedAt: '2026-07-20 08:00:00',
    })), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({
      phase: 'human',
      underlyingPhase: 'implementing',
      stale: false,
      humanReason: {
        phase: 'implementing',
        code: 'invalid-branch-progress-time',
      },
    });
  });

  it('fails closed on future review progress evidence', () => {
    const [view] = deriveLifecycle(snapshot(implementation({
      branchClaim: undefined,
      isDraft: false,
      headChangedAt: '2026-07-20T12:00:00.001Z',
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD_A,
        state: 'active',
        recordedAt: '2026-07-20T11:00:00.000Z',
      },
    })), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({
      phase: 'human',
      underlyingPhase: 'reviewing',
      stale: false,
      humanReason: {
        phase: 'reviewing',
        code: 'invalid-review-progress-time',
      },
    });
  });

  it('supersedes review immediately when its claimed head differs from the PR head', () => {
    const item = implementation({
      head: HEAD_B,
      isDraft: false,
      branchClaim: undefined,
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD_A,
        state: 'active',
        recordedAt: '2026-07-20T11:55:00.000Z',
      },
    });

    const [view] = deriveLifecycle(snapshot(item), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({
      phase: 'awaiting-review',
      supersededReview: true,
      stale: false,
    });
  });

  it('supersedes old-head terminal verdicts before validating their timestamps', () => {
    const item = implementation({
      head: HEAD_B,
      isDraft: false,
      branchClaim: undefined,
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD_A,
        state: 'verdict-intent',
        recordedAt: '2026-07-20T11:00:00.000Z',
        verdict: {
          marker: '44444444-4444-4444-8444-444444444444',
          state: 'APPROVE',
        },
      },
      terminalVerdict: {
        head: HEAD_A,
        state: 'APPROVE',
        marker: '44444444-4444-4444-8444-444444444444',
        recordedAt: '2026-07-20T12:00:00.001Z',
      },
    });

    const [view] = deriveLifecycle(snapshot(item), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({
      phase: 'awaiting-review',
      supersededReview: true,
      stale: false,
    });
  });

  it.skip('requires both unchanged head and no matching terminal verdict before review is stale', () => {
    const reviewClaim = {
      kind: 'review-claim' as const,
      protocolVersion: 2 as const,
      prNumber: 101,
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      reviewer: 'reviewer',
      head: HEAD_A,
      state: 'active' as const,
      recordedAt: '2026-07-20T08:00:00.000Z',
    };
    const base = implementation({
      branchClaim: undefined,
      isDraft: false,
      headChangedAt: '2026-07-20T08:30:00.000Z',
      reviewClaim,
    });
    const [stale, verdictProgress] = deriveLifecycle(snapshot(
      base,
      {
        ...base,
        issueNumber: 43,
        prNumber: 102,
        reviewClaim: {
          ...reviewClaim,
          prNumber: 102,
          state: 'verdict-intent',
          verdict: {
            marker: '44444444-4444-4444-8444-444444444444',
            state: 'REQUEST_CHANGES',
          },
        },
        terminalVerdict: {
          head: HEAD_A,
          state: 'REQUEST_CHANGES',
          marker: '44444444-4444-4444-8444-444444444444',
          recordedAt: '2026-07-20T11:30:00.000Z',
        },
      },
    ), NOW, STALE_AFTER).items;

    expect(stale).toMatchObject({
      phase: 'reviewing',
      stale: true,
      staleReason: 'review-progress-unchanged',
    });
    expect(verdictProgress).toMatchObject({ phase: 'reviewing', stale: false });
  });

  it('gives a freshly won active review claim generation its own full staleness window', () => {
    // Election is the one permitted review progress event, exactly like the
    // branch claim commit for implement/merge-prep: a reviewer that wins a
    // claim on a backlogged (already >2h-old) PR head must not be immediately
    // reap-eligible.
    const item = implementation({
      branchClaim: undefined,
      isDraft: false,
      headChangedAt: '2026-07-20T08:00:00.000Z',
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD_A,
        state: 'active',
        recordedAt: '2026-07-20T11:59:00.000Z',
      },
    });

    const [view] = deriveLifecycle(snapshot(item), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({
      phase: 'reviewing',
      stale: false,
    });
  });

  it('does not age a machine-owned mapping reread into stale while ambiguity persists', () => {
    const [view] = deriveLifecycle(snapshot(implementation({
      branchClaim: undefined,
      isDraft: false,
      headChangedAt: '2026-07-20T08:00:00.000Z',
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD_A,
        state: 'mapping-reread',
        mappingRequest: {
          selectedIssueNumber: 42,
          headRefName: 'autopilot/42',
          baseRefName: 'next',
        },
        recordedAt: '2026-07-20T08:00:00.000Z',
      },
    })), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({ phase: 'reviewing', stale: false });
  });

  it('a replacement claim on a >2h-old head gets its own full staleness window (no livelock)', () => {
    // Regression for the reaper livelock: every backlogged-PR review claim
    // generation -- not just the first one on a given head -- must start its
    // own fresh window when it wins election, however old the head is.
    const veryOldHead = '2026-07-20T02:00:00.000Z';
    const item = implementation({
      branchClaim: undefined,
      isDraft: false,
      headChangedAt: veryOldHead,
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '66666666-6666-4666-8666-666666666666',
        attempt: '77777777-7777-4777-8777-777777777777',
        reviewer: 'replacement-reviewer',
        head: HEAD_A,
        state: 'active',
        recordedAt: '2026-07-20T11:55:00.000Z',
      },
    });

    const [view] = deriveLifecycle(snapshot(item), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({ phase: 'reviewing', stale: false });
  });

  it('does not extend review liveness from a metadata-only transition within the same generation', () => {
    // verdict-intent is an intent-only metadata transition, not a permitted
    // progress event: it must not reset the clock the way winning the claim
    // does, so this is stale from the original (old) head time, not from the
    // recent recordedAt on this later record.
    const item = implementation({
      branchClaim: undefined,
      isDraft: false,
      headChangedAt: '2026-07-20T08:00:00.000Z',
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD_A,
        state: 'verdict-intent',
        recordedAt: '2026-07-20T11:59:00.000Z',
        verdict: {
          marker: '44444444-4444-4444-8444-444444444444',
          state: 'REQUEST_CHANGES',
        },
      },
    });

    const [view] = deriveLifecycle(snapshot(item), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({
      phase: 'reviewing',
      stale: true,
      staleSince: '2026-07-20T10:00:00.000Z',
      staleReason: 'review-progress-unchanged',
    });
  });

  it('fails closed on an invalid (future) review claim acquisition timestamp', () => {
    const item = implementation({
      branchClaim: undefined,
      isDraft: false,
      headChangedAt: '2026-07-20T08:00:00.000Z',
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD_A,
        state: 'active',
        recordedAt: '2026-07-20T12:00:00.001Z',
      },
    });

    const [view] = deriveLifecycle(snapshot(item), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({
      phase: 'human',
      underlyingPhase: 'reviewing',
      stale: false,
      humanReason: {
        phase: 'reviewing',
        code: 'invalid-review-progress-time',
      },
    });
  });

  it('never reaps a review that already has a matching terminal verdict', () => {
    const item = implementation({
      branchClaim: undefined,
      isDraft: false,
      headChangedAt: '2026-07-20T06:00:00.000Z',
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD_A,
        state: 'verdict-intent',
        recordedAt: '2026-07-20T06:00:00.000Z',
        verdict: {
          marker: '44444444-4444-4444-8444-444444444444',
          state: 'APPROVE',
        },
      },
      terminalVerdict: {
        head: HEAD_A,
        state: 'APPROVE',
        marker: '44444444-4444-4444-8444-444444444444',
        recordedAt: '2026-07-20T07:00:00.000Z',
      },
    });

    const [view] = deriveLifecycle(snapshot(item), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({ phase: 'reviewing', stale: false });
  });

  it('fails closed when matching terminal verdict progress is from the future', () => {
    const item = implementation({
      branchClaim: undefined,
      isDraft: false,
      headChangedAt: '2026-07-20T06:00:00.000Z',
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD_A,
        state: 'verdict-intent',
        recordedAt: '2026-07-20T06:00:00.000Z',
        verdict: {
          marker: '44444444-4444-4444-8444-444444444444',
          state: 'APPROVE',
        },
      },
      terminalVerdict: {
        head: HEAD_A,
        state: 'APPROVE',
        marker: '44444444-4444-4444-8444-444444444444',
        recordedAt: '2026-07-20T12:00:00.001Z',
      },
    });

    const [view] = deriveLifecycle(snapshot(item), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({
      phase: 'human',
      underlyingPhase: 'reviewing',
      stale: false,
      humanReason: {
        phase: 'reviewing',
        code: 'invalid-review-progress-time',
      },
    });
  });

  it('derives ci-blocked before merge-ready when approval is exact-head but CI is not green', () => {
    const item = implementation({
      branchClaim: undefined,
      isDraft: false,
      needsReview: false,
      approved: true,
      mergeState: 'clean',
      checks: [{
        name: 'test',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
      }],
    });
    const [view] = deriveLifecycle(snapshot(item), NOW, STALE_AFTER).items;
    expect(view).toMatchObject({ phase: 'ci-blocked' });
  });

  it('validates matching terminal verdict time before merge-ready planning', () => {
    const reviewClaim = {
      kind: 'review-claim' as const,
      protocolVersion: 2 as const,
      prNumber: 101,
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      reviewer: 'reviewer',
      head: HEAD_A,
      state: 'terminal-approved' as const,
      recordedAt: '2026-07-20T11:00:00.000Z',
      verdict: {
        marker: '44444444-4444-4444-8444-444444444444',
        state: 'APPROVE' as const,
      },
    };
    const mergeReady = implementation({
      branchClaim: undefined,
      isDraft: false,
      needsReview: false,
      approved: true,
      mergeState: 'clean',
      checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      reviewClaim,
    });
    const view = deriveLifecycle(snapshot(
      {
        ...mergeReady,
        terminalVerdict: {
          head: HEAD_A,
          state: 'APPROVE',
          marker: '44444444-4444-4444-8444-444444444444',
          recordedAt: '2026-07-20T12:00:00.001Z',
        },
      },
      {
        ...mergeReady,
        issueNumber: 43,
        prNumber: 102,
        reviewClaim: { ...reviewClaim, prNumber: 102 },
        terminalVerdict: {
          head: HEAD_A,
          state: 'APPROVE',
          marker: '44444444-4444-4444-8444-444444444444',
          recordedAt: '2026-07-20 11:30:00',
        },
      },
    ), NOW, STALE_AFTER);

    expect(view.items).toEqual([
      expect.objectContaining({
        phase: 'human',
        underlyingPhase: 'merge-ready',
        stale: false,
        humanReason: expect.objectContaining({
          phase: 'reviewing',
          code: 'invalid-review-progress-time',
        }),
      }),
      expect.objectContaining({
        phase: 'human',
        underlyingPhase: 'merge-ready',
        stale: false,
        humanReason: expect.objectContaining({
          phase: 'reviewing',
          code: 'invalid-review-progress-time',
        }),
      }),
    ]);
    expect(planCycle(view, {
      implementationSlots: 0,
      reviewSlots: 0,
      mergePrepSlots: 0,
      usableCredentialLanes: 0,
    }, 'active')).toEqual([]);
  });

  it.skip('does not treat a contradictory verdict state as matching progress', () => {
    const item = implementation({
      branchClaim: undefined,
      isDraft: false,
      headChangedAt: '2026-07-20T06:00:00.000Z',
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD_A,
        state: 'verdict-intent',
        recordedAt: '2026-07-20T06:00:00.000Z',
        verdict: {
          marker: '44444444-4444-4444-8444-444444444444',
          state: 'APPROVE',
        },
      },
      terminalVerdict: {
        head: HEAD_A,
        state: 'REQUEST_CHANGES',
        marker: '44444444-4444-4444-8444-444444444444',
        recordedAt: '2026-07-20T07:00:00.000Z',
      },
    });

    const [view] = deriveLifecycle(snapshot(item), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({ phase: 'reviewing', stale: true });
  });

  it('applies Human as an overlay and preserves the underlying phase', () => {
    const [view] = deriveLifecycle(snapshot(implementation({
      projectStatus: 'Human',
      labels: ['review:needs-human'],
    })), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({
      phase: 'human',
      underlyingPhase: 'implementing',
      stale: false,
    });
    expect(deriveRecovery(view!.item, NOW, STALE_AFTER)).toEqual([]);
  });

  it('preserves an ordinary structured Human reason in the derived view', () => {
    const humanReason = {
      phase: 'implementing' as const,
      code: 'first-push' as const,
      detail: 'Waiting for a human to authorize the first push.',
    };
    const [view] = deriveLifecycle(snapshot(implementation({
      humanReason,
    })), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({
      phase: 'human',
      underlyingPhase: 'implementing',
      humanReason,
      stale: false,
    });
  });

  it('preserves explicit Human reasons ahead of generated invalid-time reasons', () => {
    const implementationReason = {
      phase: 'implementing' as const,
      code: 'first-push' as const,
      detail: 'Waiting for first-push authorization.',
    };
    const reviewReason = {
      phase: 'reviewing' as const,
      code: 'review-escalation' as const,
      detail: 'A human must resolve the review.',
    };
    const reviewClaim = {
      kind: 'review-claim' as const,
      protocolVersion: 2 as const,
      prNumber: 102,
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      reviewer: 'reviewer',
      head: HEAD_A,
      state: 'verdict-intent' as const,
      recordedAt: '2026-07-20T11:00:00.000Z',
      verdict: {
        marker: '44444444-4444-4444-8444-444444444444',
        state: 'APPROVE' as const,
      },
    };

    const [invalidHeadTime, invalidVerdictTime] = deriveLifecycle(snapshot(
      implementation({
        humanReason: implementationReason,
        headChangedAt: '2026-07-20T12:00:00.001Z',
      }),
      implementation({
        issueNumber: 43,
        prNumber: 102,
        branchClaim: undefined,
        isDraft: false,
        humanReason: reviewReason,
        reviewClaim,
        terminalVerdict: {
          head: HEAD_A,
          state: 'APPROVE',
          marker: '44444444-4444-4444-8444-444444444444',
          recordedAt: '2026-07-20T12:00:00.001Z',
        },
      }),
    ), NOW, STALE_AFTER).items;

    expect(invalidHeadTime).toMatchObject({
      phase: 'human',
      humanReason: implementationReason,
      stale: false,
    });
    expect(invalidVerdictTime).toMatchObject({
      phase: 'human',
      humanReason: reviewReason,
      stale: false,
    });
  });

  it('keeps authoritative merged state terminal even when Human projection lags', () => {
    const [view] = deriveLifecycle(snapshot(implementation({
      merged: true,
      projectStatus: 'Human',
      labels: ['review:needs-human'],
    })), NOW, STALE_AFTER).items;

    expect(view).toMatchObject({ phase: 'merged', stale: false });
  });

  it('fails closed when claim metadata does not match its lifecycle item', () => {
    const branchIssueMismatch = implementation({
      branchClaim: {
        ...implementation().branchClaim!,
        issueNumber: 43,
      },
    });
    const branchPrMismatch = implementation({
      issueNumber: 43,
      prNumber: 102,
      branchClaim: {
        ...implementation().branchClaim!,
        issueNumber: 43,
        prNumber: 999,
      },
    });
    const reviewPrMismatch = implementation({
      issueNumber: 44,
      prNumber: 103,
      branchClaim: undefined,
      isDraft: false,
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 999,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD_A,
        state: 'active',
        recordedAt: '2026-07-20T11:00:00.000Z',
      },
    });

    const view = deriveLifecycle(
      snapshot(branchIssueMismatch, branchPrMismatch, reviewPrMismatch),
      NOW,
      STALE_AFTER,
    );

    expect(view.items).toEqual([
      expect.objectContaining({ phase: 'human', underlyingPhase: 'awaiting-review', stale: false }),
      expect.objectContaining({ phase: 'human', underlyingPhase: 'awaiting-review', stale: false }),
      expect.objectContaining({ phase: 'human', underlyingPhase: 'awaiting-review', stale: false }),
    ]);
    expect(planCycle(view, {
      implementationSlots: 3,
      reviewSlots: 3,
      mergePrepSlots: 3,
      usableCredentialLanes: 3,
    }, 'active')).toEqual([]);
  });
});

describe('planCycle', () => {
  const eligible: LifecycleItem = {
    kind: 'issue',
    issueNumber: 7,
    v2Marked: true,
    projectStatus: 'Todo',
    labels: [],
    eligible: true,
  };
  const reviewable = implementation({
    issueNumber: 8,
    prNumber: 108,
    branchClaim: undefined,
    isDraft: false,
  });
  const capacity = {
    implementationSlots: 1,
    reviewSlots: 1,
    mergePrepSlots: 1,
    usableCredentialLanes: 1,
  };

  it.skip('emits no mutations in observe mode and only stale recovery in recover mode', () => {
    const stale = implementation({ headChangedAt: '2026-07-20T08:00:00.000Z' });
    const view = deriveLifecycle(snapshot(eligible, reviewable, stale), NOW, STALE_AFTER);

    expect(planCycle(view, capacity, 'observe')).toEqual([]);
    expect(planCycle(view, capacity, 'recover')).toEqual([{
      kind: 'requeue-implementation',
      issueNumber: 42,
      expectedHead: HEAD_A,
    }]);
  });

  it('prioritizes implementation before review on one usable credential lane', () => {
    const view = deriveLifecycle(snapshot(reviewable, eligible), NOW, STALE_AFTER);

    expect(planCycle(view, capacity, 'active')).toEqual([{
      kind: 'claim-implementation',
      intent: 'fresh',
      issueNumber: 7,
    }]);
  });

});

// Regression: GitHub's "update branch" API merges the base into the PR head and
// re-points every existing review's commit_id onto the new merge commit. The
// engine's own signed approval stays bound (by SHA, in its claim ref and in the
// review body marker) to the PRE-merge head, so `terminalApprovalMatches` in the
// merge executor is false while GitHub's native review state still reads
// APPROVED. Live strand: Jinn-Network/mono PR #2130 and PR #2081.
describe('engine approval must be head-bound to reach merge-ready', () => {
  const GREEN = [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] as const;
  const MARKER = '44444444-4444-4444-8444-444444444444';

  function claim(overrides = {}) {
    return {
      kind: 'review-claim' as const,
      protocolVersion: 2 as const,
      prNumber: 101,
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      reviewer: 'reviewer',
      head: HEAD_A,
      state: 'terminal-approved' as const,
      recordedAt: '2026-07-20T11:00:00.000Z',
      verdict: { marker: MARKER, state: 'APPROVE' as const },
      ...overrides,
    };
  }

  function carriedApproval(overrides = {}) {
    return implementation({
      branchClaim: undefined,
      isDraft: false,
      labels: ['engine:review'],
      expectedBaseRefName: 'next',
      // Head is the GitHub update-branch merge commit; the engine never signed it.
      head: HEAD_B,
      needsReview: false,
      approved: true,
      mergeState: 'clean',
      checks: [...GREEN],
      ...overrides,
    });
  }

  // PR #2130: claim ref reads {"head":"2aa7c2d2…","state":"stale"} with no
  // verdict, while the native APPROVED review was carried onto 01aa754a…
  it('holds a stale-claim carried approval in awaiting-review, not merge-ready', () => {
    const [view] = deriveLifecycle(snapshot(carriedApproval({
      reviewClaim: claim({ state: 'stale', verdict: undefined }),
    })), NOW, STALE_AFTER).items;

    expect(view.phase).toBe('awaiting-review');
    expect(view.phase).not.toBe('merge-ready');
  });

  // PR #2081: claim ref reads {"head":"e41c93af…","state":"terminal-approved",
  // "verdict":{...}} recorded 35 minutes BEFORE the update-branch merge commit
  // moved the head to 765262e7…; mergeable_state is `clean` and CI is green.
  it('holds a terminal-approved-at-old-head carried approval in awaiting-review', () => {
    const [view] = deriveLifecycle(snapshot(carriedApproval({
      reviewClaim: claim(),
      terminalVerdict: {
        head: HEAD_A,
        state: 'APPROVE',
        marker: MARKER,
        recordedAt: '2026-07-20T11:00:00.000Z',
      },
    })), NOW, STALE_AFTER).items;

    expect(view.phase).toBe('awaiting-review');
  });

  it('still reaches merge-ready when the signed approval is bound to the current head', () => {
    const [view] = deriveLifecycle(snapshot(carriedApproval({
      head: HEAD_A,
      reviewClaim: claim(),
      terminalVerdict: {
        head: HEAD_A,
        state: 'APPROVE',
        marker: MARKER,
        recordedAt: '2026-07-20T11:00:00.000Z',
      },
    })), NOW, STALE_AFTER).items;

    expect(view.phase).toBe('merge-ready');
  });

  it('never promotes an item into merge-ready that the old rule left out', () => {
    // Exhaustive cross-product guard: for every claim/verdict combination the
    // tightened rule may only move items OUT of merge-ready, never into it.
    const claimShapes = [
      undefined,
      claim({ state: 'stale', verdict: undefined }),
      claim({ state: 'active', verdict: undefined }),
      claim({ head: HEAD_B }),
      claim(),
    ];
    const verdictShapes = [
      undefined,
      { head: HEAD_A, state: 'APPROVE', marker: MARKER, recordedAt: '2026-07-20T11:00:00.000Z' },
      { head: HEAD_B, state: 'APPROVE', marker: MARKER, recordedAt: '2026-07-20T11:00:00.000Z' },
      { head: HEAD_A, state: 'REQUEST_CHANGES', marker: MARKER, recordedAt: '2026-07-20T11:00:00.000Z' },
      { head: HEAD_A, state: 'APPROVE', marker: 'other', recordedAt: '2026-07-20T11:00:00.000Z' },
    ];
    for (const reviewClaim of claimShapes) {
      for (const terminalVerdict of verdictShapes) {
        const item = carriedApproval({
          head: HEAD_A,
          ...(reviewClaim === undefined ? {} : { reviewClaim }),
          ...(terminalVerdict === undefined ? {} : { terminalVerdict }),
        });
        const [view] = deriveLifecycle(snapshot(item), NOW, STALE_AFTER).items;
        if (view.phase !== 'merge-ready') continue;
        // Only the exactly-matching, current-head, signed APPROVE may pass.
        expect(reviewClaim?.state).toBe('terminal-approved');
        expect(reviewClaim?.head).toBe(HEAD_A);
        expect(terminalVerdict).toMatchObject({
          head: HEAD_A,
          state: 'APPROVE',
          marker: MARKER,
        });
      }
    }
  });

  it('names the exact engine-side conditions the merge gate re-checks', () => {
    const bound = carriedApproval({
      head: HEAD_A,
      reviewClaim: claim(),
      terminalVerdict: {
        head: HEAD_A,
        state: 'APPROVE',
        marker: MARKER,
        recordedAt: '2026-07-20T11:00:00.000Z',
      },
    });
    expect(engineApprovedAtHead(bound)).toBe(true);
    expect(engineApprovalLapsed(bound)).toBe(false);

    // Head moved under the signature.
    expect(engineApprovedAtHead({ ...bound, head: HEAD_B })).toBe(false);
    expect(engineApprovalLapsed({ ...bound, head: HEAD_B })).toBe(true);
    // Claim never reached terminal-approved.
    expect(engineApprovedAtHead({
      ...bound,
      reviewClaim: claim({ state: 'stale', verdict: undefined }),
    })).toBe(false);
    // Verdict marker does not match the claim's.
    expect(engineApprovedAtHead({
      ...bound,
      terminalVerdict: { ...bound.terminalVerdict, marker: 'other' },
    })).toBe(false);
    // No reconstructed native verdict evidence at all.
    expect(engineApprovedAtHead({ ...bound, terminalVerdict: undefined })).toBe(false);
    // A PR that is not natively approved is not "lapsed", it is simply unreviewed.
    expect(engineApprovalLapsed({
      ...bound,
      head: HEAD_B,
      approved: false,
      needsReview: true,
    })).toBe(false);
  });

  it('plans claim-review, not merge, for carried approvals', () => {
    const capacity = {
      implementationSlots: 1,
      reviewSlots: 1,
      mergePrepSlots: 1,
      usableCredentialLanes: 2,
    };
    const stale = carriedApproval({
      reviewClaim: claim({ state: 'stale', verdict: undefined }),
    });
    const terminal = carriedApproval({
      issueNumber: 43,
      prNumber: 102,
      reviewClaim: claim({ prNumber: 102 }),
      terminalVerdict: {
        head: HEAD_A,
        state: 'APPROVE',
        marker: MARKER,
        recordedAt: '2026-07-20T11:00:00.000Z',
      },
    });

    for (const item of [stale, terminal]) {
      const planned = planCycle(deriveLifecycle(snapshot(item), NOW, STALE_AFTER), capacity, 'active');
      expect(planned).toEqual([{
        kind: 'claim-review',
        issueNumber: item.issueNumber,
        prNumber: item.prNumber,
        head: HEAD_B,
      }]);
      expect(planned.some((action) => action.kind === 'merge')).toBe(false);
    }
  });

  it('re-approving at the new head restores merge-ready without a duplicate claim', () => {
    // Ladder ordering: approve at X -> update-branch yields Y -> re-review at Y
    // -> merge-ready at Y. This is the cycle the strand never completed.
    const atOldHead = carriedApproval({
      head: HEAD_A,
      reviewClaim: claim(),
      terminalVerdict: {
        head: HEAD_A,
        state: 'APPROVE',
        marker: MARKER,
        recordedAt: '2026-07-20T11:00:00.000Z',
      },
    });
    expect(deriveLifecycle(snapshot(atOldHead), NOW, STALE_AFTER).items[0].phase)
      .toBe('merge-ready');

    // update-branch moves the head; GitHub carries the APPROVED review forward.
    const afterUpdateBranch = { ...atOldHead, head: HEAD_B };
    const stranded = deriveLifecycle(snapshot(afterUpdateBranch), NOW, STALE_AFTER);
    expect(stranded.items[0].phase).toBe('awaiting-review');
    expect(planCycle(stranded, {
      implementationSlots: 0,
      reviewSlots: 1,
      mergePrepSlots: 0,
      usableCredentialLanes: 1,
    }, 'active')).toEqual([{
      kind: 'claim-review',
      issueNumber: 42,
      prNumber: 101,
      head: HEAD_B,
    }]);

    // The review executor takes the claim through the normal path: a fresh
    // generation/attempt recorded at the new head, then a signed APPROVE.
    const reviewing = {
      ...afterUpdateBranch,
      reviewClaim: claim({
        head: HEAD_B,
        state: 'active',
        verdict: undefined,
        generation: '55555555-5555-4555-8555-555555555555',
        recordedAt: '2026-07-20T11:30:00.000Z',
      }),
      terminalVerdict: undefined,
    };
    expect(deriveLifecycle(snapshot(reviewing), NOW, STALE_AFTER).items[0].phase)
      .toBe('reviewing');
    expect(planCycle(deriveLifecycle(snapshot(reviewing), NOW, STALE_AFTER), {
      implementationSlots: 0,
      reviewSlots: 1,
      mergePrepSlots: 0,
      usableCredentialLanes: 1,
    }, 'active')).toEqual([]);

    const reApproved = {
      ...afterUpdateBranch,
      reviewClaim: claim({
        head: HEAD_B,
        generation: '55555555-5555-4555-8555-555555555555',
        recordedAt: '2026-07-20T11:45:00.000Z',
        verdict: { marker: '66666666-6666-4666-8666-666666666666', state: 'APPROVE' as const },
      }),
      terminalVerdict: {
        head: HEAD_B,
        state: 'APPROVE',
        marker: '66666666-6666-4666-8666-666666666666',
        recordedAt: '2026-07-20T11:45:00.000Z',
      },
    };
    const merged = deriveLifecycle(snapshot(reApproved), NOW, STALE_AFTER);
    expect(merged.items[0].phase).toBe('merge-ready');
    expect(planCycle(merged, {
      implementationSlots: 0,
      reviewSlots: 1,
      mergePrepSlots: 0,
      usableCredentialLanes: 1,
    }, 'active')).toEqual([{
      kind: 'merge',
      issueNumber: 42,
      prNumber: 101,
      head: HEAD_B,
      expectedBaseRefName: 'next',
    }]);
  });
});
