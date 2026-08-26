import type { GitOid } from './types.js';
import type { PullRequestIndexEntry } from './github-rest-discovery.js';
import type { RawPullRequest } from './snapshot.js';

/** Exact head movement the engine proved with a winning CAS claim push. */
export interface SelfClaimHeadTransition {
  readonly prNumber: number;
  readonly previousHead: GitOid;
  readonly claimedHead: GitOid;
}

/**
 * True when a disagreement between a REST index row and its live re-read is
 * entirely explained by the engine's own claim push.
 *
 * That push is a compare-and-swap the git protocol already proved: it swung
 * the branch from `previousHead` to `claimedHead` and read the ref back over
 * `ls-remote` before this predicate is ever consulted. What is not proved is
 * how fast each GitHub read surface replicates that swing. The REST open-PR
 * index and the GraphQL PR node catch up independently, so in the seconds
 * after the push either surface may still answer with `previousHead` while the
 * other already answers with `claimedHead` — and jinn-mono#2822 livelocked on
 * exactly the direction this predicate used to omit, the index already at the
 * claim commit while the live re-read still trailed at the head it was pushed
 * from.
 *
 * So both skew directions are authorized and only those: both observations
 * must land on an end of this one transition, and at least one must be the
 * claimed end. Any head the engine did not itself publish still refuses, on
 * either surface. A pair that reads `previousHead` on both sides is no
 * mismatch at all and never reaches here.
 */
export function allowsSelfClaimHeadMismatch(
  entry: PullRequestIndexEntry,
  live: RawPullRequest,
  transition: SelfClaimHeadTransition,
): boolean {
  if (entry.number !== transition.prNumber) return false;
  const provenEnd = (headOid: string): boolean =>
    headOid === transition.previousHead || headOid === transition.claimedHead;
  return provenEnd(entry.headOid)
    && provenEnd(live.headOid)
    && (
      entry.headOid === transition.claimedHead
      || live.headOid === transition.claimedHead
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
