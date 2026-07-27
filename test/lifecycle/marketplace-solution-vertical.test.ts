import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { readAttemptManifest } from '../../src/lifecycle/attempt-workspace.js';
import { Harness } from './marketplace-mutation-adoption.test.js';

const HOST_COMMIT = '3'.repeat(40);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function adopt(harness: Harness) {
  return harness.coordinator().adopt(harness.manifestPath);
}

describe('marketplace solution vertical acceptance', () => {
  it('adopts a submitted mutation through accepted receipt without duplicate side effects', async () => {
    const harness = new Harness('implement', 'submitted');
    const first = await adopt(harness);
    expect(first).toMatchObject({ status: 'accepted', resultingHead: HOST_COMMIT });
    expect(harness.observeCalls).toBe(1);
    expect(harness.applyMutations).toBe(1);
    expect(harness.commitMutations).toBe(1);
    expect(harness.comments).toHaveLength(1);
    expect(harness.reviewAnchorMutations).toBe(1);
    expect(readAttemptManifest(harness.manifestPath).processState).toBe('running');
    const second = await adopt(harness);
    expect(second).toMatchObject({ status: 'accepted' });
    expect(harness.observeCalls).toBe(1);
    expect(harness.comments).toHaveLength(1);
  });

  it.each([
    'observation-persisted',
    'patch-applied',
    'verification-persisted',
    'host-commit-created',
    'checkpoint-published',
    'completion-confirmed',
    'review-anchor-published',
  ] as const)('recovers idempotently after crash at %s', async (boundary) => {
    const harness = new Harness(
      'implement',
      boundary === 'observation-persisted' ? 'submitted' : 'solution-observed',
    );
    harness.crashBoundary = boundary;
    await expect(adopt(harness)).resolves.toMatchObject({ status: 'recoverable' });
    const result = await adopt(harness);
    expect(result).toMatchObject({ status: 'accepted', resultingHead: HOST_COMMIT });
    expect(harness.applyMutations).toBe(1);
    expect(harness.commitMutations).toBe(1);
    expect(harness.comments).toHaveLength(1);
    expect(harness.reviewAnchorMutations).toBe(1);
  });

  it('replays submitted recovery without a second observation or comment', async () => {
    const harness = new Harness('implement', 'submitted');
    const first = await adopt(harness);
    expect(first).toMatchObject({ status: 'accepted' });
    expect(harness.observeCalls).toBe(1);
    expect(harness.comments).toHaveLength(1);
    const second = await adopt(harness);
    expect(second).toMatchObject({ status: 'accepted' });
    expect(harness.observeCalls).toBe(1);
    expect(harness.comments).toHaveLength(1);
  });
});
