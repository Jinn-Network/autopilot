import { describe, expect, it } from 'vitest';
import { branchClaimPrAuthorityMatches } from '../../src/lifecycle/implementation-claim-authority.js';
import {
  gitOid,
  gitRefName,
  type BranchClaim,
  type GitOid,
} from '../../src/lifecycle/types.js';

const ORIGIN = gitOid('1'.repeat(40));
const NEWER_CLAIM = gitOid('2'.repeat(40));
const REMOTE = gitOid('3'.repeat(40));
const EXPECTED_PR = 2271;

function implementClaim(
  overrides: Partial<Extract<BranchClaim, { readonly phase: 'implement' }>> = {},
): Extract<BranchClaim, { readonly phase: 'implement' }> {
  return {
    kind: 'branch-claim',
    protocolVersion: 2,
    phase: 'implement',
    issueNumber: 2270,
    attempt: '7a3b9eca-4cb5-4079-8367-e9307b036537',
    runner: 'marketplace-canary-2270-20260728t1730z',
    login: 'ritsuKai2000',
    expectedHead: gitOid('0'.repeat(40)),
    targetBase: gitRefName('next'),
    claimedAt: '2026-07-28T17:33:12.013Z',
    ...overrides,
  };
}

function childClaim(
  phase: 'fix' | 'reconcile',
  prNumber: number,
): Extract<BranchClaim, { readonly phase: 'fix' | 'reconcile' }> {
  return {
    kind: 'branch-claim',
    protocolVersion: 2,
    phase,
    issueNumber: 2272,
    prNumber,
    attempt: '8a3b9eca-4cb5-4079-8367-e9307b036538',
    runner: 'runner-child',
    login: 'ritsukai',
    expectedHead: gitOid('0'.repeat(40)),
    targetBase: gitRefName('next'),
    claimedAt: '2026-07-28T17:40:00.000Z',
  };
}

function matches(
  claim: BranchClaim,
  latestClaimOid: GitOid,
  remoteHead: GitOid = REMOTE,
): boolean {
  return branchClaimPrAuthorityMatches({
    claim,
    expectedPrNumber: EXPECTED_PR,
    originClaimOid: ORIGIN,
    latestClaimOid,
    remoteHead,
  });
}

describe('branch claim pull-request authority', () => {
  it('accepts a production-order initial implement claim before the PR exists', () => {
    expect(matches(implementClaim(), ORIGIN)).toBe(true);
  });

  it.each([
    {
      name: 'omitted implement PR after a newer claim',
      claim: implementClaim(),
      latestClaimOid: NEWER_CLAIM,
      remoteHead: REMOTE,
      expected: false,
    },
    {
      name: 'exact implement PR at the origin claim',
      claim: implementClaim({ prNumber: EXPECTED_PR }),
      latestClaimOid: ORIGIN,
      remoteHead: REMOTE,
      expected: true,
    },
    {
      name: 'exact implement PR after a newer claim',
      claim: implementClaim({ prNumber: EXPECTED_PR }),
      latestClaimOid: NEWER_CLAIM,
      remoteHead: REMOTE,
      expected: false,
    },
    {
      name: 'wrong explicit implement PR at the origin claim',
      claim: implementClaim({ prNumber: EXPECTED_PR + 1 }),
      latestClaimOid: ORIGIN,
      remoteHead: REMOTE,
      expected: false,
    },
    {
      name: 'exact fix PR at the origin claim',
      claim: childClaim('fix', EXPECTED_PR),
      latestClaimOid: ORIGIN,
      remoteHead: REMOTE,
      expected: true,
    },
    {
      name: 'wrong reconcile PR at the origin claim',
      claim: childClaim('reconcile', EXPECTED_PR + 1),
      latestClaimOid: ORIGIN,
      remoteHead: REMOTE,
      expected: false,
    },
    {
      name: 'phase-complete implement claim with omitted PR',
      claim: implementClaim({ phaseComplete: true }),
      latestClaimOid: REMOTE,
      remoteHead: REMOTE,
      expected: false,
    },
    {
      name: 'phase-complete exact PR at the remote head',
      claim: implementClaim({
        prNumber: EXPECTED_PR,
        phaseComplete: true,
      }),
      latestClaimOid: REMOTE,
      remoteHead: REMOTE,
      expected: true,
    },
    {
      name: 'phase-complete exact PR below the remote head',
      claim: implementClaim({
        prNumber: EXPECTED_PR,
        phaseComplete: true,
      }),
      latestClaimOid: ORIGIN,
      remoteHead: REMOTE,
      expected: false,
    },
    {
      name: 'phase-complete wrong PR at the remote head',
      claim: implementClaim({
        prNumber: EXPECTED_PR + 1,
        phaseComplete: true,
      }),
      latestClaimOid: REMOTE,
      remoteHead: REMOTE,
      expected: false,
    },
  ])('$name', ({ claim, latestClaimOid, remoteHead, expected }) => {
    expect(matches(claim, latestClaimOid, remoteHead)).toBe(expected);
  });
});
