// @ts-nocheck — mirrors the fixture style of active-scheduler/active-runtime tests.
import { describe, expect, it } from 'vitest';
import {
  scheduleActiveActions,
  type ActiveSchedulingInput,
} from '../../src/lifecycle/active-scheduler.js';
import { makeActiveRuntime } from '../../src/lifecycle/active-runtime.js';
import { CredentialPool } from '../../src/lifecycle/credentials.js';
import { laneForNewWorkAction } from '../../src/lifecycle/types.js';
import type { AttemptManifest } from '../../src/lifecycle/attempt-workspace.js';

function pool(): CredentialPool {
  return new CredentialPool([
    { login: 'implementation-bot', normalizedLogin: 'implementation-bot', implementationToken: 'i' },
  ]);
}

function input(overrides: Partial<ActiveSchedulingInput> = {}): ActiveSchedulingInput {
  return {
    candidates: [
      { phase: 'implementation', intent: 'fresh', issueNumber: 1, isSweep: true },
      { phase: 'implementation', intent: 'fresh', issueNumber: 2 },
    ],
    remaining: { implementation: 1, child: 1, review: 1 },
    availableLogins: ['implementation-bot'],
    implementationPreferredLogin: 'implementation-bot',
    openPipelineBacklog: 0,
    implementationBackpressureThreshold: 10,
    ...overrides,
  };
}

describe('debt lane (#168 part 3)', () => {
  it('is off by default: a sweep claim spends an implementation slot, untagged', () => {
    const plan = scheduleActiveActions(input());
    expect(plan.actions).toEqual([
      { kind: 'claim-implementation', intent: 'fresh', issueNumber: 1 },
    ]);
    expect(plan.skips).toEqual([
      { phase: 'implementation', subject: 'issue:2', reason: 'capacity' },
    ]);
    expect(plan.backups.implementation).toHaveLength(1);
    expect(plan.backups).not.toHaveProperty('debt');
  });

  it('seats a sweep and an ordinary claim concurrently under separate lanes', () => {
    const plan = scheduleActiveActions(input({
      remaining: { implementation: 1, child: 1, review: 1, debt: 1 },
    }));
    expect(plan.actions).toEqual([
      { kind: 'claim-implementation', intent: 'fresh', issueNumber: 2 },
      { kind: 'claim-implementation', intent: 'fresh', issueNumber: 1, sweep: true },
    ]);
    expect(plan.skips).toEqual([]);
  });

  it('skips a surplus sweep against the debt lane, not the implementation one', () => {
    const plan = scheduleActiveActions(input({
      candidates: [
        { phase: 'implementation', intent: 'fresh', issueNumber: 1, isSweep: true },
        { phase: 'implementation', intent: 'fresh', issueNumber: 3, isSweep: true },
        { phase: 'implementation', intent: 'fresh', issueNumber: 2 },
      ],
      remaining: { implementation: 1, child: 1, review: 1, debt: 1 },
    }));
    expect(plan.actions.map((action) => action.issueNumber)).toEqual([2, 1]);
    expect(plan.skips).toEqual([
      { phase: 'implementation', subject: 'issue:3', reason: 'capacity' },
    ]);
    expect(plan.backups.debt!.map((action) => action.issueNumber)).toEqual([3]);
  });

  it('routes only a sweep-tagged claim to the debt lane', () => {
    expect(laneForNewWorkAction({
      kind: 'claim-implementation', intent: 'fresh', issueNumber: 1, sweep: true,
    })).toBe('debt');
    expect(laneForNewWorkAction({
      kind: 'claim-implementation', intent: 'fresh', issueNumber: 1,
    })).toBe('implementation');
    expect(laneForNewWorkAction({
      kind: 'claim-implementation', intent: 'fresh', issueNumber: 1, child: true,
    })).toBe('child');
  });
});

describe('debt lane capacity accounting', () => {
  const attempt = (fields: Partial<AttemptManifest>): AttemptManifest => ({
    phase: 'implement',
    selectedLogin: 'implementation-bot',
    ...fields,
  } as AttemptManifest);

  const runtime = (caps: Record<string, number>, attempts: readonly AttemptManifest[]) =>
    makeActiveRuntime({
      credentials: pool(),
      caps,
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

  it('reports no debt lane at all when the cap is zero', () => {
    const local = runtime({ implementation: 2, child: 1, review: 1, debt: 0 }, [
      attempt({ sweep: true }),
    ]).readLocalState();
    expect(local.remaining).not.toHaveProperty('debt');
    // With no lane, a live sweep attempt is ordinary implementation work.
    expect(local.remaining.implementation).toBe(1);
  });

  it('counts a live sweep attempt against the debt lane, not the implementation one', () => {
    const local = runtime({ implementation: 2, child: 1, review: 1, debt: 1 }, [
      attempt({ sweep: true }),
      attempt({}),
    ]).readLocalState();
    expect(local.remaining.debt).toBe(0);
    expect(local.remaining.implementation).toBe(1);
  });

  it('refuses a sweep claim when the debt lane is full', async () => {
    const result = await runtime({ implementation: 2, child: 1, review: 1, debt: 1 }, [
      attempt({ sweep: true }),
    ]).executeAction(
      { kind: 'claim-implementation', intent: 'fresh', issueNumber: 1, sweep: true },
      {} as never,
    );
    expect(result).toEqual({ outcome: 'skipped', reason: 'local phase capacity is full' });
  });
});
