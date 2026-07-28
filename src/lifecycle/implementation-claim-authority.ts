import type { BranchClaim, GitOid } from './types.js';

export interface BranchClaimPrAuthorityInput {
  readonly claim: BranchClaim;
  readonly expectedPrNumber: number;
  readonly originClaimOid: GitOid;
  readonly latestClaimOid: GitOid;
  readonly remoteHead: GitOid;
}

export function branchClaimPrAuthorityMatches(
  input: BranchClaimPrAuthorityInput,
): boolean {
  const {
    claim,
    expectedPrNumber,
    originClaimOid,
    latestClaimOid,
    remoteHead,
  } = input;
  if (claim.phaseComplete === true) {
    return claim.prNumber === expectedPrNumber
      && latestClaimOid === remoteHead;
  }
  if (latestClaimOid !== originClaimOid) return false;
  return claim.prNumber === undefined
    ? claim.phase === 'implement'
    : claim.prNumber === expectedPrNumber;
}
