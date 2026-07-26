import { parseAutomatedReviewMarker } from './codecs.js';
import type { ReviewNativeReview } from './review-executor.js';
import type { GitOid } from './types.js';

export function effectiveNativeReviews(
  reviews: readonly ReviewNativeReview[],
): readonly ReviewNativeReview[] {
  const latest = new Map<string, ReviewNativeReview>();
  for (const review of [...reviews].sort((left, right) =>
    left.submittedAt.localeCompare(right.submittedAt))) {
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) {
      continue;
    }
    latest.set(review.reviewer.toLowerCase(), review);
  }
  return [...latest.values()];
}

export function isSupersededOwnedNativeRequest(
  review: ReviewNativeReview,
  selectedLogin: string,
  currentHead: GitOid,
): boolean {
  if (
    review.state !== 'CHANGES_REQUESTED'
    || review.commitId === currentHead
    || review.reviewer.toLowerCase() !== selectedLogin.toLowerCase()
  ) {
    return false;
  }
  const markerText = review.body.match(/<!-- jinn-autopilot-review:v2\b[^>]* -->/)?.[0];
  if (markerText === undefined) return false;
  try {
    const marker = parseAutomatedReviewMarker(markerText);
    return (
      marker.reviewer.toLowerCase() === selectedLogin.toLowerCase()
      && marker.head === review.commitId
      && marker.verdict === 'REQUEST_CHANGES'
    );
  } catch {
    // A malformed or copied marker never exempts a native blocker.
    return false;
  }
}
