/**
 * Session wall-clock helpers (#184): how an attempt's deadline is named in
 * the log, and how the durations around it are rendered.
 *
 * Kept apart from `attempt-workspace.ts` so the cycle report can name the
 * same session the sweep expired without pulling the whole manifest module
 * in for one string.
 */

import type { AttemptManifest } from './attempt-workspace.js';

/**
 * The name the coordinator logs a session under — `implement-4188`,
 * `review-4190` — so an expiry line greps against the same token as the
 * dispatch and exit lines the session already has.
 */
export function attemptSessionName(
  manifest: Pick<AttemptManifest, 'phase' | 'issueNumber' | 'prNumber'>,
): string {
  const number = manifest.phase === 'review'
    ? manifest.prNumber ?? manifest.issueNumber
    : manifest.issueNumber;
  return `${manifest.phase}-${number}`;
}

/** Whole minutes of `ms`, split as `[hours, minutes]`. */
function hoursAndMinutes(ms: number): readonly [number, number] {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return [Math.floor(minutes / 60), minutes % 60];
}

/** An elapsed span as `4h 7m` — minutes always, so `4h 0m` is exact. */
export function formatElapsed(ms: number): string {
  const [hours, minutes] = hoursAndMinutes(ms);
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
}

/** A configured limit as `4h`, or `2h 30m` when it is not whole hours. */
export function formatWallClock(ms: number): string {
  const [hours, minutes] = hoursAndMinutes(ms);
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}
