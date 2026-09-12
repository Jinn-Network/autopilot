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

/**
 * A seat held this long has outlived every default wall clock several times
 * over — the incident's shape (three sessions at 42 hours), and the one a
 * full lane's `skipped (capacity)` lines never name.
 */
export const LONG_HELD_SEAT_MS = 24 * 60 * 60 * 1000;

/** Sessions this close to their wall clock are listed by the cycle summary. */
export const DEADLINE_WARNING_MS = 30 * 60 * 1000;

/** One live attempt as the scheduler sees it: a seat in a lane. */
export interface HeldSeat {
  readonly lane: 'implementation' | 'child' | 'review' | 'debt';
  readonly session: string;
  /** Since the running transition. */
  readonly ageMs: number;
  /**
   * Until the recorded wall clock, negative once past it. Absent for a
   * manifest that recorded no deadline — one the sweep never expires.
   */
  readonly untilDeadlineMs?: number;
}

/**
 * The seats the given live attempts hold, oldest first. An attempt still
 * preparing holds no seat yet. A sweep is reported in `debt`; a caller whose
 * debt lane is off folds it into `implementation`, as lane accounting does.
 */
export function heldSeats(
  attempts: readonly AttemptManifest[],
  now: Date,
): readonly HeldSeat[] {
  const nowMs = now.getTime();
  return attempts.flatMap((attempt): HeldSeat[] => {
    const startedAt = attempt.timestamps.childStartedAt;
    if (startedAt === undefined) return [];
    const lane = attempt.phase === 'review'
      ? 'review'
      : attempt.childKind !== undefined
        ? 'child'
        : attempt.sweep === true ? 'debt' : 'implementation';
    return [{
      lane,
      session: attemptSessionName(attempt),
      ageMs: Math.max(0, nowMs - Date.parse(startedAt)),
      ...(attempt.deadlineAt === undefined
        ? {}
        : { untilDeadlineMs: Date.parse(attempt.deadlineAt) - nowMs }),
    }];
  }).sort((left, right) => right.ageMs - left.ageMs);
}

/**
 * The `wall clock:` summary line, or nothing when no session is within
 * `DEADLINE_WARNING_MS` of its deadline or past it. A session past its
 * deadline that is still listed is one the sweep has not expired — it is
 * disabled with cleanup, or the teardown failed — which is worth a line.
 */
export function wallClockSummaryLine(seats: readonly HeldSeat[]): string | undefined {
  const near = seats
    .filter((seat) => seat.untilDeadlineMs !== undefined
      && seat.untilDeadlineMs <= DEADLINE_WARNING_MS)
    .sort((left, right) => right.untilDeadlineMs! - left.untilDeadlineMs!);
  if (near.length === 0) return undefined;
  return `wall clock: ${near.map((seat) => (
    seat.untilDeadlineMs! >= 0
      ? `${seat.session} expires in ${formatElapsed(seat.untilDeadlineMs!)}`
      : `${seat.session} expired ${formatElapsed(-seat.untilDeadlineMs!)} ago`
  )).join('; ')}`;
}
