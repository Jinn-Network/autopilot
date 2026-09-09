/**
 * Process identity beyond the bare PID (#161).
 *
 * `kill -0` proves that *a* process holds a PID, never that it is *the*
 * process a record names. After a reboot or a long sleep the kernel hands the
 * same PID to something unrelated — in #161 an implementation worker's PID had
 * become a Chrome helper — and every reader that trusts `kill -0` alone counts
 * a stranger as a live worker for as long as the stranger lives. The kernel's
 * own start time for the PID closes that gap: a reused PID cannot carry the
 * start time of the process that held it before.
 */
import { spawnSync } from 'node:child_process';

/** How a caller reads a PID's start time; injectable so tests never spawn. */
export type ProcessStartTimeReader = (pid: number) => string | null;

/** Long enough for every `lstart` rendering, short enough to bound a manifest. */
const MAX_READING_LENGTH = 64;

/**
 * Whether a value is a reading worth recording and comparing: one line of
 * printable ASCII. Anything else — an empty column, a multi-line answer from
 * some other `ps`, a hostile manifest — is not identity evidence and must
 * never reach the manifest or a comparison.
 */
export function isProcessStartTimeReading(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_READING_LENGTH
    && /^[ -~]+$/.test(value);
}

/**
 * The kernel's start time for `pid`, as an OPAQUE token to be compared
 * verbatim against a reading taken earlier for the same PID — never parsed.
 *
 * `lstart` is the only absolute start-time column both BSD (macOS) and procps
 * (Linux) print, and it renders in the caller's timezone and locale, so one
 * process can render two different strings across a DST transition or a locale
 * change — which a verbatim comparison would misread as a reused PID. `TZ=UTC`
 * and `LC_ALL=C` pin the rendering, so a process renders one string for as long
 * as it lives, and that is what makes comparing the raw strings sound.
 *
 * `null` means the reading did not happen — no `ps` on this host, no process
 * on that PID, an empty or unrecognisable column. Callers must read that as
 * "unproven", never as "reused": failing to read a start time is exactly the
 * state every manifest written before this field was in, and it must keep the
 * `kill -0` verdict rather than declare a possibly-live worker dead.
 */
export function readProcessStartTime(pid: number): string | null {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
    });
  } catch {
    return null;
  }
  if (result.error !== undefined || result.status !== 0) return null;
  const reading = (result.stdout ?? '').toString().trim();
  return isProcessStartTimeReading(reading) ? reading : null;
}
