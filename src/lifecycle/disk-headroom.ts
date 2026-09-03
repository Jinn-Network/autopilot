import type { AttemptFootprintRecord, AttemptPhase } from './attempt-workspace.js';

/**
 * Projected disk headroom (#144).
 *
 * The disk floor used to be evaluated against current free bytes alone, which
 * only holds against work already on disk. A spawn's footprint lands minutes
 * later — clone, then install — so every spawn in one cycle saw the same free
 * bytes and the cycle admitted far more pending footprint than the disk had:
 * ten open slots and 12 GB free admitted ~65 GB of work and drove the volume
 * to zero. This module makes that pending footprint explicit so the floor can
 * be evaluated against what free space is *going to be*.
 */

const BYTES_PER_GB = 1024 * 1024 * 1024;

/** Expected footprints, in bytes, for an attempt with no usable history. */
export interface AttemptFootprintDefaults {
  readonly implement: number;
  readonly review: number;
}

/**
 * Same-phase attempts consulted before falling back to the configured default.
 *
 * Ten is deliberately short. A host's footprint changes when the target
 * repository does — a new lockfile, a new build output — and a long window
 * would keep quoting the old repository's cost long after it stopped being
 * true.
 */
export const ATTEMPT_FOOTPRINT_HISTORY = 10;

/**
 * How long a fresh attempt is assumed to still be growing toward its expected
 * footprint.
 *
 * Measuring a live worktree would be the honest reading, but a `du` over a
 * 6.5 GB checkout costs seconds of synchronous disk I/O per attempt per cycle
 * — on the very disk the projection exists to protect. So age stands in for
 * measurement: within the window an attempt is assumed to have written nothing
 * beyond whatever its manifest already records, and past it, its bytes are
 * assumed to be on disk and therefore already absent from free space. Ten
 * minutes comfortably covers the clone-plus-install phase where the footprint
 * actually appears.
 */
export const ATTEMPT_SETTLE_MS = 10 * 60 * 1000;

/** A live attempt, as the projection needs to see it. */
export interface LiveAttemptFootprint {
  readonly phase: AttemptPhase;
  /** When the attempt's workspace was created — the start of its settle window. */
  readonly startedAtMs: number;
  /** Bytes already known to be on disk, when anything has measured them. */
  readonly worktreeBytes?: number;
}

export interface DiskHeadroom {
  /** New work is paused: projected free space would sit below the floor. */
  readonly paused: boolean;
  readonly free: number;
  readonly reserved: number;
  readonly floor: number;
  /** Attempts and this-cycle spawns whose footprint has yet to land. */
  readonly settling: number;
}

export interface DiskHeadroomInput {
  readonly free: number;
  readonly floor: number;
  readonly liveAttempts: readonly LiveAttemptFootprint[];
  /** Phases already spawned in this cycle, whose footprint is entirely pending. */
  readonly pendingSpawns: readonly AttemptPhase[];
  readonly history: readonly AttemptFootprintRecord[];
  readonly defaults: AttemptFootprintDefaults;
  readonly nowMs: number;
  readonly settleMs?: number;
}

export function attemptFootprintDefaultsFromGb(
  gb: { readonly implement: number; readonly review: number },
): AttemptFootprintDefaults {
  return {
    implement: gb.implement * BYTES_PER_GB,
    review: gb.review * BYTES_PER_GB,
  };
}

/**
 * What one more attempt of this phase is expected to cost on this host.
 *
 * p75 of recent same-phase history rather than the mean: the cost of an
 * attempt is bounded below by the checkout and unbounded above by what the
 * work builds, so the distribution has a long right tail and a mean sits under
 * most of it. The 75th percentile keeps the projection conservative without
 * letting one pathological attempt set the budget for every future one.
 */
export function expectedAttemptFootprintBytes(
  phase: AttemptPhase,
  history: readonly AttemptFootprintRecord[],
  defaults: AttemptFootprintDefaults,
): number {
  const recent = history
    .filter((record) => record.phase === phase)
    .slice(-ATTEMPT_FOOTPRINT_HISTORY)
    .map((record) => record.worktreeBytes)
    .sort((left, right) => left - right);
  if (recent.length === 0) return defaults[phase];
  return recent[Math.ceil(0.75 * recent.length) - 1]!;
}

/**
 * Free space this cycle may still spend, and whether the floor now bites.
 *
 * `reserved` is the footprint that has been committed to but has not landed:
 * what each still-settling attempt has yet to write, plus the whole expected
 * footprint of every spawn this cycle already made. Subtracting it from free
 * space is what makes the floor hold against work in flight rather than only
 * against work already on disk.
 *
 * A floor of zero disables the gate outright, exactly as it did before.
 */
export function projectDiskHeadroom(input: DiskHeadroomInput): DiskHeadroom {
  const settleMs = input.settleMs ?? ATTEMPT_SETTLE_MS;
  const expected = (phase: AttemptPhase): number => expectedAttemptFootprintBytes(
    phase,
    input.history,
    input.defaults,
  );
  let reserved = 0;
  let settling = 0;
  const reserve = (bytes: number): void => {
    if (bytes <= 0) return;
    reserved += bytes;
    settling += 1;
  };
  for (const attempt of input.liveAttempts) {
    if (input.nowMs - attempt.startedAtMs >= settleMs) continue;
    reserve(expected(attempt.phase) - (attempt.worktreeBytes ?? 0));
  }
  for (const phase of input.pendingSpawns) reserve(expected(phase));
  return {
    paused: input.floor > 0 && input.free - reserved < input.floor,
    free: input.free,
    reserved,
    floor: input.floor,
    settling,
  };
}

/** Measured bytes, always to one decimal — they are never a round number. */
function measuredGb(bytes: number): string {
  return `${(bytes / BYTES_PER_GB).toFixed(1)}G`;
}

/** The configured floor, which an operator wrote as a whole number of GB. */
function configuredGb(bytes: number): string {
  const value = bytes / BYTES_PER_GB;
  return `${Number.isInteger(value) ? value : value.toFixed(1)}G`;
}

/**
 * The arithmetic behind a `disk-floor` skip, so an operator reading one line
 * can tell a full disk from a disk this cycle has already spoken for.
 */
export function diskHeadroomSkipDetail(headroom: DiskHeadroom): string {
  return `free ${measuredGb(headroom.free)} − reserved ${measuredGb(headroom.reserved)} `
    + `for ${headroom.settling} settling `
    + `attempt${headroom.settling === 1 ? '' : 's'} `
    + `< floor ${configuredGb(headroom.floor)}`;
}

/** One line per cycle, so the governor is visible when it is NOT biting too. */
export function diskHeadroomSummaryLine(headroom: DiskHeadroom): string {
  return `disk: free=${measuredGb(headroom.free)} `
    + `reserved=${measuredGb(headroom.reserved)} `
    + `floor=${configuredGb(headroom.floor)} `
    + `settling=${headroom.settling}`;
}
