import type { GitOid } from './types.js';
import type { PullRequestIndexEntry } from './github-rest-discovery.js';
import type { RawPullRequest } from './snapshot.js';

/** Exact head movement the engine proved with a winning CAS claim push. */
export interface SelfClaimHeadTransition {
  readonly prNumber: number;
  readonly previousHead: GitOid;
  readonly claimedHead: GitOid;
}

export function allowsSelfClaimHeadMismatch(
  entry: PullRequestIndexEntry,
  live: RawPullRequest,
  transition: SelfClaimHeadTransition,
): boolean {
  if (entry.number !== transition.prNumber) return false;
  return (
    (
      entry.headOid === transition.previousHead
      && live.headOid === transition.claimedHead
    )
    || (
      entry.headOid === transition.claimedHead
      && live.headOid === transition.claimedHead
    )
  );
}

export function selfClaimHeadTransition(input: {
  readonly prNumber: number;
  readonly previousHead: GitOid | null;
  readonly candidateParent: GitOid;
  readonly claimedHead: GitOid;
}): SelfClaimHeadTransition {
  return {
    prNumber: input.prNumber,
    previousHead: input.previousHead ?? input.candidateParent,
    claimedHead: input.claimedHead,
  };
}
