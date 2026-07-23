import { describe, expect, it } from 'vitest';
import { applyMergePolicy } from '../../src/lifecycle/active-scheduler.js';
import { gitOid } from '../../src/lifecycle/types.js';

const HEAD = gitOid('a'.repeat(40));

describe('repository merge policy', () => {
  const candidates = [
    { phase: 'implementation' as const, issueNumber: 1 },
    {
      phase: 'merge' as const,
      issueNumber: 2,
      prNumber: 20,
      head: HEAD,
    },
  ];

  it('removes merge candidates in the default manual policy', () => {
    expect(applyMergePolicy(candidates, 'manual')).toEqual([
      { phase: 'implementation', issueNumber: 1 },
    ]);
  });

  it('preserves the existing exact-head merge lane only for safe-auto', () => {
    expect(applyMergePolicy(candidates, 'safe-auto')).toEqual(candidates);
  });
});
