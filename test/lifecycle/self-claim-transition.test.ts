import { describe, expect, it } from 'vitest';
import {
  allowsSelfClaimHeadMismatch,
  selfClaimHeadTransition,
} from '../../src/lifecycle/self-claim-transition.js';
import type { PullRequestIndexEntry } from '../../src/lifecycle/github-rest-discovery.js';
import type { RawPullRequest } from '../../src/lifecycle/snapshot.js';
import { gitOid } from '../../src/lifecycle/types.js';

const PREVIOUS = gitOid('c'.repeat(40));
const CLAIMED = gitOid('e'.repeat(40));

const ENTRY = {
  number: 2085,
  state: 'OPEN',
  updatedAt: '2026-07-28T00:00:00.000Z',
  headOid: PREVIOUS,
  headRefName: 'autopilot/2040',
  baseRefName: 'next',
  isDraft: true,
  title: 'Implement',
  closedAt: null,
  mergedAt: null,
} satisfies PullRequestIndexEntry;

const LIVE = {
  number: 2085,
  headOid: CLAIMED,
} as unknown as RawPullRequest;

describe('selfClaimHeadTransition', () => {
  it('authorizes only the exact previous-to-claimed head pair for the claimed PR', () => {
    const transition = selfClaimHeadTransition({
      prNumber: 2085,
      previousHead: PREVIOUS,
      candidateParent: gitOid('0'.repeat(40)),
      claimedHead: CLAIMED,
    });

    expect(allowsSelfClaimHeadMismatch(ENTRY, LIVE, transition)).toBe(true);
    expect(allowsSelfClaimHeadMismatch(
      { ...ENTRY, number: 2086 },
      LIVE,
      transition,
    )).toBe(false);
    expect(allowsSelfClaimHeadMismatch(
      ENTRY,
      { ...LIVE, headOid: gitOid('f'.repeat(40)) },
      transition,
    )).toBe(false);
  });

  it('authorizes the replicated index row once it catches up to the claimed head', () => {
    const transition = selfClaimHeadTransition({
      prNumber: 2085,
      previousHead: PREVIOUS,
      candidateParent: PREVIOUS,
      claimedHead: CLAIMED,
    });

    expect(allowsSelfClaimHeadMismatch(
      { ...ENTRY, headOid: CLAIMED },
      LIVE,
      transition,
    )).toBe(true);
  });
});
