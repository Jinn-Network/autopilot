// @ts-nocheck — Stage 5 leftover fixtures for deleted merge-prep/review-fix/project APIs.
import { describe, expect, it } from 'vitest';
import type { AttemptManifest } from '../../src/lifecycle/attempt-workspace.js';
import {
  makeActiveRuntime,
} from '../../src/lifecycle/active-runtime.js';
import { CredentialPool } from '../../src/lifecycle/credentials.js';
import { projectDiskHeadroom } from '../../src/lifecycle/disk-headroom.js';
import { gitOid } from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));
const GB = 1024 ** 3;
const NOW = Date.parse('2026-09-03T10:00:00.000Z');

function pool(): CredentialPool {
  return new CredentialPool([
    {
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'i',
    },
    {
      login: 'review-bot',
      normalizedLogin: 'review-bot',
      reviewToken: 'r',
    },
  ]);
}

function attempt(
  phase: AttemptManifest['phase'],
  selectedLogin: string,
  childKind?: AttemptManifest['childKind'],
): AttemptManifest {
  return {
    phase,
    selectedLogin,
    ...(childKind === undefined ? {} : { childKind }),
  } as AttemptManifest;
}

describe('active runtime boundary', () => {
  it('reserves one bounded review cohort, isolates failures, and returns scheduled order', async () => {
    const started: number[] = [];
    const reservations: number[] = [];
    const releases = new Map<number, {
      resolve: (value: { status: string; detail?: string }) => void;
      reject: (error: Error) => void;
    }>();
    const runtime = makeActiveRuntime({
      credentials: pool(),
      caps: { implementation: 1, child: 1, review: 2 },
      implementationPreferredLogin: 'implementation-bot',
      implementationBackpressureThreshold: 30,
      readLocalAttempts: () => [],
      preflight: async () => ({ ok: true }),
      reserveReviewCohort: async (size) => { reservations.push(size); },
      handlers: {
        implementation: async () => ({ status: 'spawned' }),
        review: async (action) => {
          started.push(action.prNumber);
          return new Promise((resolve, reject) => {
            releases.set(action.prNumber, { resolve, reject });
          });
        },
        enqueue: async () => ({ status: 'enqueued' }),
      },
    });
    const actions = [84, 85].map((prNumber, index) => ({
      kind: 'claim-review' as const,
      issueNumber: 42 + index,
      prNumber,
      head: HEAD,
    }));

    const pending = runtime.executeReviewActions!(actions, {} as never);
    await Promise.resolve();
    expect(started).toEqual([84, 85]);
    releases.get(85)!.resolve({ status: 'spawned', detail: 'second' });
    releases.get(84)!.reject(new Error('first failed'));

    await expect(pending).resolves.toEqual([
      { outcome: 'failed', reason: 'first failed' },
      { outcome: 'spawned', reason: 'second' },
    ]);
    expect(reservations).toEqual([2]);
  });

  it('rejects an oversized review cohort before reserving quota or starting handlers', async () => {
    const calls: string[] = [];
    const runtime = makeActiveRuntime({
      credentials: pool(),
      caps: { implementation: 1, child: 1, review: 1 },
      implementationPreferredLogin: 'implementation-bot',
      implementationBackpressureThreshold: 30,
      readLocalAttempts: () => [],
      preflight: async () => ({ ok: true }),
      reserveReviewCohort: async () => { calls.push('reserve'); },
      handlers: {
        implementation: async () => ({ status: 'spawned' }),
        review: async () => {
          calls.push('review');
          return { status: 'spawned' };
        },
        enqueue: async () => ({ status: 'enqueued' }),
      },
    });
    const actions = [84, 85].map((prNumber, index) => ({
      kind: 'claim-review' as const,
      issueNumber: 42 + index,
      prNumber,
      head: HEAD,
    }));

    await expect(runtime.executeReviewActions!(actions, {} as never))
      .rejects.toThrow(/cohort.*capacity/i);
    expect(calls).toEqual([]);
  });

  it('derives only this runner’s phase capacity from injected local attempts', () => {
    const runtime = makeActiveRuntime({
      credentials: pool(),
      caps: { implementation: 2, child: 2, review: 1 },
      implementationPreferredLogin: 'implementation-bot',
      implementationBackpressureThreshold: 30,
      readLocalAttempts: () => [attempt('implement', 'implementation-bot')],
      preflight: async () => ({ ok: true }),
      handlers: {
        implementation: async () => ({ status: 'spawned' }),
        review: async () => ({ status: 'spawned' }),
        enqueue: async () => ({ status: 'enqueued' }),
      },
    });

    expect(runtime.readLocalState()).toEqual({
      remaining: { implementation: 1, child: 2, review: 1 },
      newWorkPaused: false,
      availableLogins: ['implementation-bot', 'review-bot'],
      implementationPreferredLogin: 'implementation-bot',
    });
  });

  it('bills a child attempt to the child lane and an unmarked one to implementation', () => {
    const runtime = makeActiveRuntime({
      credentials: pool(),
      caps: { implementation: 2, child: 2, review: 2 },
      implementationPreferredLogin: 'implementation-bot',
      implementationBackpressureThreshold: 30,
      readLocalAttempts: () => [
        // Written before `childKind` existed: no marker at all. Counting it as
        // fresh over-books the implementation lane and can never over-run the
        // child lane, which is the safe direction to be wrong in.
        attempt('implement', 'implementation-bot'),
        attempt('implement', 'implementation-bot', 'reconcile'),
        attempt('review', 'review-bot'),
      ],
      preflight: async () => ({ ok: true }),
      handlers: {
        implementation: async () => ({ status: 'spawned' }),
        review: async () => ({ status: 'spawned' }),
        enqueue: async () => ({ status: 'enqueued' }),
      },
    });

    expect(runtime.readLocalState().remaining).toEqual({
      implementation: 1,
      child: 1,
      review: 1,
    });
  });

  it('gates each claim on its own lane, so one full lane never blocks the other', async () => {
    const lanes = (attempts: readonly AttemptManifest[]) => makeActiveRuntime({
      credentials: pool(),
      caps: { implementation: 1, child: 1, review: 1 },
      implementationPreferredLogin: 'implementation-bot',
      implementationBackpressureThreshold: 30,
      readLocalAttempts: () => attempts,
      preflight: async () => ({ ok: true }),
      handlers: {
        implementation: async () => ({ status: 'spawned' }),
        review: async () => ({ status: 'spawned' }),
        enqueue: async () => ({ status: 'enqueued' }),
      },
    });
    const childClaim = {
      kind: 'claim-implementation' as const,
      intent: 'fresh' as const,
      issueNumber: 7,
      child: true as const,
    };
    const freshClaim = {
      kind: 'claim-implementation' as const,
      intent: 'fresh' as const,
      issueNumber: 8,
    };

    // Child lane full, implementation lane free.
    const childFull = lanes([attempt('implement', 'implementation-bot', 'ci-failure')]);
    await expect(childFull.executeAction(childClaim, {} as never))
      .resolves.toMatchObject({ outcome: 'skipped' });
    await expect(childFull.executeAction(freshClaim, {} as never))
      .resolves.toMatchObject({ outcome: 'spawned' });

    // And the mirror image: implementation lane full, child lane free.
    const implementationFull = lanes([attempt('implement', 'implementation-bot')]);
    await expect(implementationFull.executeAction(freshClaim, {} as never))
      .resolves.toMatchObject({ outcome: 'skipped' });
    await expect(implementationFull.executeAction(childClaim, {} as never))
      .resolves.toMatchObject({ outcome: 'spawned' });
  });

  it('zeros implementation, child, and review remaining when new work is paused', () => {
    const runtime = makeActiveRuntime({
      credentials: pool(),
      caps: { implementation: 2, child: 2, review: 1 },
      implementationPreferredLogin: 'implementation-bot',
      implementationBackpressureThreshold: 30,
      readLocalAttempts: () => [],
      newWorkPaused: () => true,
      preflight: async () => ({ ok: true }),
      handlers: {
        implementation: async () => ({ status: 'spawned' }),
        review: async () => ({ status: 'spawned' }),
        enqueue: async () => ({ status: 'enqueued' }),
      },
    });

    expect(runtime.readLocalState()).toEqual({
      remaining: { implementation: 0, child: 0, review: 0 },
      newWorkPaused: true,
      availableLogins: ['implementation-bot', 'review-bot'],
      implementationPreferredLogin: 'implementation-bot',
    });
  });

  it('passes the full credential pool to an exact-head action handler', async () => {
    const selected: string[][] = [];
    const runtime = makeActiveRuntime({
      credentials: pool(),
      caps: { implementation: 1, child: 1, review: 1 },
      implementationPreferredLogin: 'implementation-bot',
      implementationBackpressureThreshold: 30,
      readLocalAttempts: () => [attempt('implement', 'implementation-bot')],
      preflight: async () => ({ ok: true }),
      handlers: {
        implementation: async () => ({ status: 'spawned' }),
        review: async (action, credentials) => {
          selected.push(credentials.logins());
          expect(action).toMatchObject({ prNumber: 84, head: HEAD });
          return { status: 'spawned' };
        },
        enqueue: async () => ({ status: 'enqueued' }),
      },
    });

    await expect(runtime.executeAction({
      kind: 'claim-review',
      issueNumber: 42,
      prNumber: 84,
      head: HEAD,
    })).resolves.toEqual({ outcome: 'spawned' });
    expect(selected).toEqual([['implementation-bot', 'review-bot']]);
  });

  it('dispatches machine-child repair through the maintenance handler at zero implementation capacity', async () => {
    const received: unknown[] = [];
    const runtime = makeActiveRuntime({
      credentials: pool(),
      caps: { implementation: 0, child: 0, review: 0 },
      implementationPreferredLogin: 'implementation-bot',
      implementationBackpressureThreshold: 30,
      readLocalAttempts: () => [],
      preflight: async () => ({ ok: true }),
      handlers: {
        implementation: async () => ({ status: 'spawned' }),
        review: async () => ({ status: 'spawned' }),
        repairMachineChild: async (action) => {
          received.push(action);
          return { status: 'repaired' };
        },
        enqueue: async () => ({ status: 'enqueued' }),
      },
    });
    const action = {
      kind: 'repair-machine-child' as const,
      issueNumber: 2141,
      parentPr: 2140,
      childKind: 'reconcile' as const,
      expectedType: 'fix' as const,
      expectedEffort: 'medium' as const,
      expectedPriority: 'p1' as const,
    };

    await expect(runtime.executeAction(action, {} as never)).resolves.toEqual({
      outcome: 'repaired',
    });
    expect(received).toEqual([action]);
  });

  it('dispatches an enqueue action to the enqueue handler and nowhere else', async () => {
    const received: unknown[] = [];
    const runtime = makeActiveRuntime({
      credentials: pool(),
      caps: { implementation: 1, child: 1, review: 1 },
      implementationPreferredLogin: 'implementation-bot',
      implementationBackpressureThreshold: 30,
      readLocalAttempts: () => [],
      preflight: async () => ({ ok: true }),
      handlers: {
        implementation: async () => ({ status: 'spawned' }),
        review: async () => ({ status: 'spawned' }),
        enqueue: async (action) => {
          received.push(action);
          return { status: 'enqueued', detail: 'position:1' };
        },
      },
    });
    const action = {
      kind: 'enqueue' as const,
      issueNumber: 42,
      prNumber: 84,
      head: HEAD,
      expectedBaseRefName: 'next',
    };

    await expect(runtime.executeAction(action, {} as never)).resolves.toEqual({
      outcome: 'enqueued',
      reason: 'position:1',
    });
    expect(received).toEqual([action]);
  });

  /**
   * The latch that stops a cycle's remaining enqueues lives in the controller,
   * so the executor's `repositoryRefusal` has to survive the collapse from an
   * `ActiveRuntimeResult` to the controller's `{outcome, reason}` pair. Nothing
   * else in that collapse carries a boolean, which is exactly why it is worth
   * pinning: a spread that dropped it would disarm the latch silently, and the
   * only symptom would be a cycle that costs eight times what it should.
   */
  it('carries a repository refusal through to the controller result', async () => {
    const runtime = makeActiveRuntime({
      credentials: pool(),
      caps: { implementation: 1, child: 1, review: 1 },
      implementationPreferredLogin: 'implementation-bot',
      implementationBackpressureThreshold: 30,
      readLocalAttempts: () => [],
      preflight: async () => ({ ok: true }),
      handlers: {
        implementation: async () => ({ status: 'spawned' }),
        review: async () => ({ status: 'spawned' }),
        enqueue: async () => ({
          status: 'rejected',
          reason: 'GraphQL: Merge queue is not enabled for this branch',
          repositoryRefusal: true,
        }),
      },
    });
    const action = {
      kind: 'enqueue' as const,
      issueNumber: 42,
      prNumber: 84,
      head: HEAD,
      expectedBaseRefName: 'next',
    };

    await expect(runtime.executeAction(action, {} as never)).resolves.toEqual({
      outcome: 'rejected',
      reason: 'GraphQL: Merge queue is not enabled for this branch',
      repositoryRefusal: true,
    });
  });

  it('does not invent a repository refusal for an ordinary rejection', async () => {
    const runtime = makeActiveRuntime({
      credentials: pool(),
      caps: { implementation: 1, child: 1, review: 1 },
      implementationPreferredLogin: 'implementation-bot',
      implementationBackpressureThreshold: 30,
      readLocalAttempts: () => [],
      preflight: async () => ({ ok: true }),
      handlers: {
        implementation: async () => ({ status: 'spawned' }),
        review: async () => ({ status: 'spawned' }),
        enqueue: async () => ({
          status: 'rejected',
          reason: 'GraphQL: Pull request is not mergeable',
        }),
      },
    });

    await expect(runtime.executeAction({
      kind: 'enqueue' as const,
      issueNumber: 42,
      prNumber: 84,
      head: HEAD,
      expectedBaseRefName: 'next',
    }, {} as never)).resolves.toEqual({
      outcome: 'rejected',
      reason: 'GraphQL: Pull request is not mergeable',
    });
  });

  // The handler is gone, and so is the action kind. An `update-branch` that
  // somehow reaches the runtime must fall through to the unwired arm rather
  // than quietly finding a handler that still knows how to move a PR head.
  it('has no update-branch handler left to reach', async () => {
    const runtime = makeActiveRuntime({
      credentials: pool(),
      caps: { implementation: 1, child: 1, review: 1 },
      implementationPreferredLogin: 'implementation-bot',
      implementationBackpressureThreshold: 30,
      readLocalAttempts: () => [],
      preflight: async () => ({ ok: true }),
      handlers: {
        implementation: async () => ({ status: 'spawned' }),
        review: async () => ({ status: 'spawned' }),
        enqueue: async () => ({ status: 'enqueued' }),
      },
    });

    await expect(runtime.executeAction({
      kind: 'update-branch',
      issueNumber: 42,
      prNumber: 84,
      head: HEAD,
      expectedBaseRefName: 'next',
    } as never, {} as never)).resolves.toEqual({
      outcome: 'skipped',
      reason: 'action update-branch is not wired',
    });
  });
  it('reserves each spawn against the same cycle\u2019s later spawns', async () => {
    const seen: (readonly string[])[] = [];
    const runtime = makeActiveRuntime({
      credentials: pool(),
      caps: { implementation: 2, child: 2, review: 2 },
      implementationPreferredLogin: 'implementation-bot',
      implementationBackpressureThreshold: 30,
      readLocalAttempts: () => [],
      readDiskHeadroom: (pendingSpawns) => {
        seen.push([...pendingSpawns]);
        return projectDiskHeadroom({
          free: 12 * GB,
          floor: 8 * GB,
          liveAttempts: [],
          pendingSpawns,
          history: [],
          defaults: { implement: 8 * GB, review: 1 * GB },
          nowMs: NOW,
        });
      },
      preflight: async () => ({ ok: true }),
      handlers: {
        implementation: async () => ({ status: 'spawned' }),
        review: async () => ({ status: 'spawned' }),
        enqueue: async () => ({ status: 'enqueued' }),
      },
    });
    const claim = (issueNumber: number) => ({
      kind: 'claim-implementation' as const,
      intent: 'fresh' as const,
      issueNumber,
    });

    await expect(runtime.executeAction(claim(1), {} as never))
      .resolves.toEqual({ outcome: 'spawned' });
    // Twelve gigabytes free, an eight-gigabyte floor, and eight already spoken
    // for: the second slot is open but the disk it would need is not.
    await expect(runtime.executeAction(claim(2), {} as never)).resolves.toEqual({
      outcome: 'skipped',
      reason: 'disk-floor (free 12.0G \u2212 reserved 8.0G for 1 settling attempt '
        + '< floor 8G)',
    });
    // One projection per dispatch, and the second one sees the first's charge.
    expect(seen).toEqual([[], ['implement']]);
  });

  it('reserves a review spawn its own smaller footprint', async () => {
    const runtime = makeActiveRuntime({
      credentials: pool(),
      caps: { implementation: 2, child: 2, review: 2 },
      implementationPreferredLogin: 'implementation-bot',
      implementationBackpressureThreshold: 30,
      readLocalAttempts: () => [],
      readDiskHeadroom: (pendingSpawns) => projectDiskHeadroom({
        free: 10 * GB,
        floor: 8 * GB,
        liveAttempts: [],
        pendingSpawns,
        history: [],
        defaults: { implement: 8 * GB, review: 1 * GB },
        nowMs: NOW,
      }),
      preflight: async () => ({ ok: true }),
      handlers: {
        implementation: async () => ({ status: 'spawned' }),
        review: async () => ({ status: 'spawned' }),
        enqueue: async () => ({ status: 'enqueued' }),
      },
    });
    const claim = (prNumber: number) => ({
      kind: 'claim-review' as const,
      issueNumber: prNumber - 40,
      prNumber,
      head: HEAD,
    });

    await expect(runtime.executeAction(claim(84), {} as never))
      .resolves.toEqual({ outcome: 'spawned' });
    // One gigabyte reserved, not eight, so a second review still fits.
    await expect(runtime.executeAction(claim(85), {} as never))
      .resolves.toEqual({ outcome: 'spawned' });
    expect(runtime.readLocalState().diskHeadroom).toMatchObject({
      paused: false,
      reserved: 2 * GB,
      settling: 2,
    });
  });

  it('forgets the previous cycle\u2019s spawns when the next one preflights', async () => {
    const runtime = makeActiveRuntime({
      credentials: pool(),
      caps: { implementation: 2, child: 2, review: 2 },
      implementationPreferredLogin: 'implementation-bot',
      implementationBackpressureThreshold: 30,
      readLocalAttempts: () => [],
      readDiskHeadroom: (pendingSpawns) => projectDiskHeadroom({
        free: 12 * GB,
        floor: 8 * GB,
        liveAttempts: [],
        pendingSpawns,
        history: [],
        defaults: { implement: 8 * GB, review: 1 * GB },
        nowMs: NOW,
      }),
      preflight: async () => ({ ok: true }),
      handlers: {
        implementation: async () => ({ status: 'spawned' }),
        review: async () => ({ status: 'spawned' }),
        enqueue: async () => ({ status: 'enqueued' }),
      },
    });
    const claim = { kind: 'claim-implementation', intent: 'fresh', issueNumber: 1 };

    await runtime.executeAction(claim as never, {} as never);
    expect(runtime.readLocalState().newWorkPaused).toBe(true);
    await runtime.preflight();
    expect(runtime.readLocalState().newWorkPaused).toBe(false);
  });

  it('charges nothing for a spawn that never happened', async () => {
    const runtime = makeActiveRuntime({
      credentials: pool(),
      caps: { implementation: 2, child: 2, review: 2 },
      implementationPreferredLogin: 'implementation-bot',
      implementationBackpressureThreshold: 30,
      readLocalAttempts: () => [],
      readDiskHeadroom: (pendingSpawns) => projectDiskHeadroom({
        free: 12 * GB,
        floor: 8 * GB,
        liveAttempts: [],
        pendingSpawns,
        history: [],
        defaults: { implement: 8 * GB, review: 1 * GB },
        nowMs: NOW,
      }),
      preflight: async () => ({ ok: true }),
      handlers: {
        implementation: async () => ({ status: 'ineligible' }),
        review: async () => ({ status: 'spawned' }),
        enqueue: async () => ({ status: 'enqueued' }),
      },
    });

    await runtime.executeAction(
      { kind: 'claim-implementation', intent: 'fresh', issueNumber: 1 } as never,
      {} as never,
    );
    expect(runtime.readLocalState().diskHeadroom).toMatchObject({ reserved: 0 });
  });

  it('keeps the boolean pause seam working with no projection wired', () => {
    const runtime = makeActiveRuntime({
      credentials: pool(),
      caps: { implementation: 2, child: 2, review: 1 },
      implementationPreferredLogin: 'implementation-bot',
      implementationBackpressureThreshold: 30,
      readLocalAttempts: () => [],
      newWorkPaused: () => true,
      preflight: async () => ({ ok: true }),
      handlers: {
        implementation: async () => ({ status: 'spawned' }),
        review: async () => ({ status: 'spawned' }),
        enqueue: async () => ({ status: 'enqueued' }),
      },
    });

    const local = runtime.readLocalState();
    expect(local.newWorkPaused).toBe(true);
    expect(local.diskHeadroom).toBeUndefined();
  });
  it('skips a review cohort the disk went below the floor under', async () => {
    // Implementation claims dispatch before the review cohort and charge their
    // footprint against the same disk, so the floor can start biting partway
    // through a cycle. That is the governor working, not a scheduling error:
    // the cohort must read as skipped, never as a capacity violation thrown at
    // the controller and logged as `failed`.
    let spawned = 0;
    const runtime = makeActiveRuntime({
      credentials: pool(),
      caps: { implementation: 2, child: 2, review: 2 },
      implementationPreferredLogin: 'implementation-bot',
      implementationBackpressureThreshold: 30,
      readLocalAttempts: () => [],
      readDiskHeadroom: (pendingSpawns) => projectDiskHeadroom({
        free: 12 * GB,
        floor: 8 * GB,
        liveAttempts: [],
        pendingSpawns,
        history: [],
        defaults: { implement: 8 * GB, review: 1 * GB },
        nowMs: NOW,
      }),
      preflight: async () => ({ ok: true }),
      reserveReviewCohort: async () => { spawned += 1; },
      handlers: {
        implementation: async () => ({ status: 'spawned' }),
        review: async () => {
          spawned += 1;
          return { status: 'spawned' };
        },
        enqueue: async () => ({ status: 'enqueued' }),
      },
    });

    await runtime.executeAction(
      { kind: 'claim-implementation', intent: 'fresh', issueNumber: 1 } as never,
      {} as never,
    );
    const cohort = [84, 85].map((prNumber, index) => ({
      kind: 'claim-review' as const,
      issueNumber: 42 + index,
      prNumber,
      head: HEAD,
    }));

    await expect(runtime.executeReviewActions!(cohort, {} as never)).resolves.toEqual([
      {
        outcome: 'skipped',
        reason: 'disk-floor (free 12.0G \u2212 reserved 8.0G for 1 settling attempt '
          + '< floor 8G)',
      },
      {
        outcome: 'skipped',
        reason: 'disk-floor (free 12.0G \u2212 reserved 8.0G for 1 settling attempt '
          + '< floor 8G)',
      },
    ]);
    // Nothing reserved GitHub quota and no reviewer session started.
    expect(spawned).toBe(0);
  });
});
