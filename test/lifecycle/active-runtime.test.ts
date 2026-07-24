// @ts-nocheck — Stage 5 leftover fixtures for deleted merge-prep/review-fix/project APIs.
import { describe, expect, it } from 'vitest';
import type { AttemptManifest } from '../../src/lifecycle/attempt-workspace.js';
import {
  makeActiveRuntime,
} from '../../src/lifecycle/active-runtime.js';
import { CredentialPool } from '../../src/lifecycle/credentials.js';
import { gitOid } from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));

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
): AttemptManifest {
  return {
    phase,
    selectedLogin,
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
      caps: { implementation: 1, review: 2 },
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
        merge: async () => ({ status: 'merged' }),
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
      caps: { implementation: 1, review: 1 },
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
        merge: async () => ({ status: 'merged' }),
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
      caps: { implementation: 2, review: 1 },
      implementationPreferredLogin: 'implementation-bot',
      implementationBackpressureThreshold: 30,
      readLocalAttempts: () => [attempt('implement', 'implementation-bot')],
      preflight: async () => ({ ok: true }),
      handlers: {
        implementation: async () => ({ status: 'spawned' }),
        review: async () => ({ status: 'spawned' }),
        merge: async () => ({ status: 'merged' }),
      },
    });

    expect(runtime.readLocalState()).toEqual({
      remaining: { implementation: 1, review: 1 },
      newWorkPaused: false,
      availableLogins: ['implementation-bot', 'review-bot'],
      implementationPreferredLogin: 'implementation-bot',
    });
  });

  it('zeros implementation and review remaining when new work is paused', () => {
    const runtime = makeActiveRuntime({
      credentials: pool(),
      caps: { implementation: 2, review: 1 },
      implementationPreferredLogin: 'implementation-bot',
      implementationBackpressureThreshold: 30,
      readLocalAttempts: () => [],
      newWorkPaused: () => true,
      preflight: async () => ({ ok: true }),
      handlers: {
        implementation: async () => ({ status: 'spawned' }),
        review: async () => ({ status: 'spawned' }),
        merge: async () => ({ status: 'merged' }),
      },
    });

    expect(runtime.readLocalState()).toEqual({
      remaining: { implementation: 0, review: 0 },
      newWorkPaused: true,
      availableLogins: ['implementation-bot', 'review-bot'],
      implementationPreferredLogin: 'implementation-bot',
    });
  });

  it('passes the full credential pool to an exact-head action handler', async () => {
    const selected: string[][] = [];
    const runtime = makeActiveRuntime({
      credentials: pool(),
      caps: { implementation: 1, review: 1 },
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
        merge: async () => ({ status: 'merged' }),
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
      caps: { implementation: 0, review: 0 },
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
        merge: async () => ({ status: 'merged' }),
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
});
