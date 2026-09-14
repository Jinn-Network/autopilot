import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Worker infant deaths (#186): the signal that a launcher cannot keep a
 * worker alive, which for 48 hours on 2026-09-12 nothing rendered.
 *
 * Every worker died within a second of dispatch — a leaked parent session in
 * its environment — and the engine kept cycling normally: snapshots,
 * `backlog:`, `disk:`, claims, dispatch. 77 sessions dispatched, 80 `code=1`
 * exits, one `code=0`, and the only clue was the absence of clean exits,
 * which no summary line reported. Three things fix that here: a per-cycle
 * `workers:` line, a loud line when every dispatch of a cycle died in
 * infancy, and after three such cycles in a row a stop on new dispatch, so
 * the engine stops spending claims — branches, draft PRs, worktrees — on
 * sessions that cannot start.
 *
 * The streak is persisted under `state/`, beside the session-limit circuit
 * (#152), because the daemon runs one engine process per cycle: a count in
 * memory would be one cycle long. A fresh daemon starts with none — the
 * daemon removes the file at start — so a restart, which is how a leaked
 * environment is fixed anyway, is the operator-visible reset. The daemon's own
 * `consecutiveFailedCycles` (#139) resets the same way.
 */

/**
 * A worker that exits non-zero this soon after dispatch never did any work:
 * `claude -p` needs longer than this to load a session and take a first
 * turn, so an exit inside it is a launch failure — a dead parent socket, an
 * exhausted account, a missing binary — not an outcome. Thirty seconds is
 * comfortably past the slowest healthy startup seen and well short of the
 * shortest real session, and it is the bound on how long a cycle waits for
 * its youngest dispatch before it can say what became of them.
 */
export const WORKER_INFANT_DEATH_MS = 30_000;

/** All-infant cycles in a row before new dispatch stops. */
export const INFANT_CYCLES_TO_HALT = 3;

/** How much of the last infant death's stderr the summary quotes. */
export const INFANT_STDERR_CHARS = 200;

export const WORKER_INFANCY_FILE = 'worker-infancy.json';

/** The `makeLoggingSpawn` banner that opens each dispatch in a session log. */
const DISPATCH_HEADER = /^===== active dispatch .* =====$/m;

export interface WorkerCycleSummary {
  readonly dispatched: number;
  readonly infantDeaths: number;
  /** The last infant death's stderr, bounded; absent when none was captured. */
  readonly lastStderr?: string;
}

export interface WorkerInfancyState {
  readonly version: 1;
  readonly consecutiveAllInfantCycles: number;
  readonly lastStderr?: string;
}

const NO_STREAK: WorkerInfancyState = { version: 1, consecutiveAllInfantCycles: 0 };

/** The persisted streak; a missing or malformed file is no streak. */
export function readWorkerInfancy(path: string): WorkerInfancyState {
  if (!existsSync(path)) return NO_STREAK;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      version?: unknown;
      consecutiveAllInfantCycles?: unknown;
      lastStderr?: unknown;
    } | null;
    if (
      typeof parsed !== 'object' || parsed === null || parsed.version !== 1
      || typeof parsed.consecutiveAllInfantCycles !== 'number'
      || !Number.isInteger(parsed.consecutiveAllInfantCycles)
      || parsed.consecutiveAllInfantCycles < 0
    ) return NO_STREAK;
    return {
      version: 1,
      consecutiveAllInfantCycles: parsed.consecutiveAllInfantCycles,
      ...(typeof parsed.lastStderr === 'string' ? { lastStderr: parsed.lastStderr } : {}),
    };
  } catch {
    return NO_STREAK;
  }
}

/** Every dispatch of the cycle died in infancy — and there was at least one. */
export function isAllInfant(summary: WorkerCycleSummary): boolean {
  return summary.dispatched > 0 && summary.infantDeaths === summary.dispatched;
}

/**
 * Folds one cycle into the streak: all infant extends it, one survivor ends
 * it, and a cycle that dispatched nothing — including every cycle spent
 * halted — leaves it exactly where it was.
 */
export function recordWorkerCycle(
  path: string,
  summary: WorkerCycleSummary,
): WorkerInfancyState {
  const before = readWorkerInfancy(path);
  if (summary.dispatched === 0) return before;
  const next: WorkerInfancyState = isAllInfant(summary)
    ? {
        version: 1,
        consecutiveAllInfantCycles: before.consecutiveAllInfantCycles + 1,
        ...(summary.lastStderr === undefined
          ? (before.lastStderr === undefined ? {} : { lastStderr: before.lastStderr })
          : { lastStderr: summary.lastStderr }),
      }
    : NO_STREAK;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(temporary, path);
  return next;
}

export function dispatchHalted(state: WorkerInfancyState): boolean {
  return state.consecutiveAllInfantCycles >= INFANT_CYCLES_TO_HALT;
}

export function workersSummaryLine(summary: WorkerCycleSummary): string {
  return `workers: dispatched=${summary.dispatched} infant-deaths=${summary.infantDeaths}`;
}

export function allInfantLine(summary: WorkerCycleSummary): string {
  return `[autopilot] every worker this cycle died within ${WORKER_INFANT_DEATH_MS / 1_000}s; `
    + `last stderr: ${summary.lastStderr ?? 'none captured'}`;
}

/** The `lane:<lane>: infant-deaths` reason, with what the halt withheld. */
export function infantDeathsLaneReason(state: WorkerInfancyState, withheld: number): string {
  return `${state.consecutiveAllInfantCycles} consecutive cycle(s) of every worker dying `
    + `within ${WORKER_INFANT_DEATH_MS / 1_000}s; ${withheld} candidate(s) withheld `
    + 'until the daemon is restarted';
}

/**
 * The first `INFANT_STDERR_CHARS` of what the latest dispatch wrote to its
 * session log, whitespace collapsed; nothing for a missing log or one that
 * holds only the dispatch banner. Read at the worker's exit, before the sweep
 * can remove the attempt directory the log lives in.
 */
export function stderrExcerpt(logPath: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch {
    return undefined;
  }
  const headers = [...raw.matchAll(new RegExp(DISPATCH_HEADER.source, 'gm'))];
  const last = headers.at(-1);
  const body = last === undefined ? raw : raw.slice(last.index! + last[0].length);
  const collapsed = body.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > INFANT_STDERR_CHARS
    ? `${collapsed.slice(0, INFANT_STDERR_CHARS)}…`
    : collapsed;
}

interface Dispatch {
  readonly at: number;
  readonly logPath: string | undefined;
  exitedAt?: number;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  stderr?: string;
}

export type WorkerExitRecorder = (
  code: number | null,
  signal: NodeJS.Signals | null,
) => void;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * The dispatches of one cycle and what became of each, kept by the engine
 * process that made them. `dispatched` is called by the production spawn for
 * every worker; the recorder it returns is called at that worker's exit.
 * `settle` then waits until every dispatch has either exited or outlived
 * infancy — never longer than `WORKER_INFANT_DEATH_MS` past the youngest —
 * and hands back the cycle's summary, empty again for the next cycle.
 *
 * An infant death is a non-zero exit inside the window, or a launch that
 * never produced a process at all — reported with neither code nor signal —
 * which is the launcher failing in the plainest way. A signal is not one: it
 * is the wall-clock sweep or an operator, not the launcher. An exit after the
 * window is not one either, whatever its code: the session ran.
 */
export class WorkerInfancyWatch {
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #dispatches: Dispatch[] = [];

  constructor(options: {
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {}) {
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  dispatched(logPath: string | undefined): WorkerExitRecorder {
    const dispatch: Dispatch = { at: this.#now(), logPath };
    this.#dispatches.push(dispatch);
    return (code, signal) => {
      if (dispatch.exitedAt !== undefined) return;
      dispatch.exitedAt = this.#now();
      dispatch.code = code;
      dispatch.signal = signal;
      if (isInfantDeath(dispatch) && logPath !== undefined) {
        dispatch.stderr = stderrExcerpt(logPath);
      }
    };
  }

  async settle(): Promise<WorkerCycleSummary> {
    for (;;) {
      const now = this.#now();
      const pending = this.#dispatches
        .filter((dispatch) => dispatch.exitedAt === undefined)
        .map((dispatch) => dispatch.at + WORKER_INFANT_DEATH_MS - now)
        .filter((wait) => wait > 0);
      if (pending.length === 0) break;
      await this.#sleep(Math.min(...pending));
    }
    const dispatches = this.#dispatches;
    this.#dispatches = [];
    const infants = dispatches.filter(isInfantDeath);
    const lastStderr = infants.map((dispatch) => dispatch.stderr).filter((s) => s !== undefined).at(-1);
    return {
      dispatched: dispatches.length,
      infantDeaths: infants.length,
      ...(lastStderr === undefined ? {} : { lastStderr }),
    };
  }
}

function isInfantDeath(dispatch: Dispatch): boolean {
  if (dispatch.exitedAt === undefined) return false;
  const failed = typeof dispatch.code === 'number'
    ? dispatch.code !== 0
    : dispatch.signal === null || dispatch.signal === undefined;
  return failed && dispatch.exitedAt - dispatch.at < WORKER_INFANT_DEATH_MS;
}
