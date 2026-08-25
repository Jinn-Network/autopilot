import { describe, expect, it } from 'vitest';
import { applyMergePolicy } from '../../src/lifecycle/active-scheduler.js';
import { gitOid, gitRefName } from '../../src/lifecycle/types.js';

const HEAD = gitOid('a'.repeat(40));

describe('repository merge policy', () => {
  const candidates = [
    { phase: 'implementation' as const, intent: 'fresh' as const, issueNumber: 1 },
    {
      phase: 'enqueue' as const,
      issueNumber: 2,
      prNumber: 20,
      head: HEAD,
      expectedBaseRefName: gitRefName('next'),
    },
  ];

  it('removes enqueue candidates in the default manual policy', () => {
    expect(applyMergePolicy(candidates, 'manual')).toEqual([
      { phase: 'implementation', intent: 'fresh', issueNumber: 1 },
    ]);
  });

  it('preserves the exact-head enqueue lane only for safe-auto', () => {
    expect(applyMergePolicy(candidates, 'safe-auto')).toEqual(candidates);
  });
});
