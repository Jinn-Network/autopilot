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

  it('authorizes the live re-read that still trails its own claim push', () => {
    const transition = selfClaimHeadTransition({
      prNumber: 2085,
      previousHead: PREVIOUS,
      candidateParent: PREVIOUS,
      claimedHead: CLAIMED,
    });

    // The two GitHub surfaces replicate a push independently, so the skew runs
    // in both directions. Here the REST open-PR index already carries the
    // engine's own claim commit while the GraphQL PR node still answers with
    // the head the claim was CAS-pushed from.
    expect(allowsSelfClaimHeadMismatch(
      { ...ENTRY, headOid: CLAIMED },
      { ...LIVE, headOid: PREVIOUS },
      transition,
    )).toBe(true);
  });

  it('refuses every head that is not an end of the proven claim transition', () => {
    const foreign = gitOid('9'.repeat(40));
    const transition = selfClaimHeadTransition({
      prNumber: 2085,
      previousHead: PREVIOUS,
      candidateParent: PREVIOUS,
      claimedHead: CLAIMED,
    });

    // A foreign index row against a trailing live read.
    expect(allowsSelfClaimHeadMismatch(
      { ...ENTRY, headOid: foreign },
      { ...LIVE, headOid: PREVIOUS },
      transition,
    )).toBe(false);
    // A foreign live head against a caught-up index row.
    expect(allowsSelfClaimHeadMismatch(
      { ...ENTRY, headOid: CLAIMED },
      { ...LIVE, headOid: foreign },
      transition,
    )).toBe(false);
    // A foreign live head against a trailing index row.
    expect(allowsSelfClaimHeadMismatch(
      ENTRY,
      { ...LIVE, headOid: foreign },
      transition,
    )).toBe(false);
    // The right pair, the wrong PR.
    expect(allowsSelfClaimHeadMismatch(
      { ...ENTRY, number: 2086, headOid: CLAIMED },
      { ...LIVE, number: 2086, headOid: PREVIOUS },
      transition,
    )).toBe(false);
  });
});
