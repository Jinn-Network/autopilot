import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The step ONE live engine child is inside right now — nothing more.
 *
 * A cycle that never finishes is invisible to every signal the engine has
 * (jinn-autopilot#132): `lastCycleFinishedAt` simply stays unset. The daemon
 * knows when its cycle started but not what the child is doing, so the child
 * publishes its current long-running step here for the daemon to read.
 *
 * This is deliberately NOT state. It is process-local and never durable:
 * - the recording engine's pid rides along, and a reader that cannot prove
 *   that pid is alive treats the file as absent, because a dead engine's last
 *   step is not "what the cycle is doing", it is debris;
 * - the daemon deletes it before spawning each cycle and on shutdown, so a
 *   restart can never inherit a stale "current step";
 * - nothing reads it back into a decision. It exists to be printed.
 */
export interface CycleHeartbeat {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly step: string;
  readonly startedAt: string;
}

export function cycleHeartbeatPath(serviceDirectory: string): string {
  return join(serviceDirectory, 'heartbeat.json');
}

function atomicWrite(path: string, heartbeat: CycleHeartbeat): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${heartbeat.pid}`;
  writeFileSync(temporary, `${JSON.stringify(heartbeat, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function clearCycleHeartbeat(path: string): void {
  rmSync(path, { force: true });
}

/**
 * Reads the current step, or null when there is nothing trustworthy to report.
 * Every rejection is silent by design: an unreadable heartbeat means "no step
 * known", never a failure — a diagnostic must not be able to break a cycle or
 * a status read.
 */
export function readCycleHeartbeat(
  path: string,
  isPidAlive: (pid: number) => boolean,
): CycleHeartbeat | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Partial<CycleHeartbeat>;
  if (
    record.schemaVersion !== 1
    || !Number.isSafeInteger(record.pid)
    || (record.pid as number) <= 0
    || typeof record.step !== 'string'
    || record.step === ''
    || typeof record.startedAt !== 'string'
    || !Number.isFinite(Date.parse(record.startedAt))
  ) {
    return null;
  }
  try {
    if (!isPidAlive(record.pid as number)) return null;
  } catch {
    return null;
  }
  return {
    schemaVersion: 1,
    pid: record.pid as number,
    step: record.step,
    startedAt: record.startedAt,
  };
}

interface HeartbeatRecorder {
  readonly path: string;
  readonly pid: number;
  readonly now: () => Date;
}

interface ActiveStep {
  readonly id: number;
  readonly step: string;
  readonly startedAt: string;
}

let recorder: HeartbeatRecorder | null = null;
let active: ActiveStep[] = [];
let nextStepId = 1;

/**
 * Arms the recorder for this process. Only a daemon-spawned cycle child arms
 * it; every other caller (a manual `observe`, a test, a library consumer)
 * leaves it null and every step call below is a no-op, so an ad-hoc run can
 * never publish a step the daemon would then report as its cycle's.
 */
export function configureCycleHeartbeat(options: {
  readonly path: string;
  readonly pid?: number;
  readonly now?: () => Date;
} | null): void {
  active = [];
  if (options === null) {
    recorder = null;
    return;
  }
  recorder = {
    path: options.path,
    pid: options.pid ?? process.pid,
    now: options.now ?? (() => new Date()),
  };
}

function publish(): void {
  if (recorder === null) return;
  const current = active.at(-1);
  try {
    if (current === undefined) {
      clearCycleHeartbeat(recorder.path);
      return;
    }
    atomicWrite(recorder.path, {
      schemaVersion: 1,
      pid: recorder.pid,
      step: current.step,
      startedAt: current.startedAt,
    });
  } catch {
    // A heartbeat is a diagnostic. Losing one must never fail the cycle it is
    // describing, so every publish failure is swallowed here and nowhere else.
  }
}

/**
 * Marks the process as inside `step` until the returned function is called.
 * Steps may nest and may end out of order (a review cohort dispatches in
 * parallel); the innermost step still open is the one reported, so the daemon
 * always names the most specific thing the cycle is blocked on.
 */
export function beginCycleStep(step: string): () => void {
  if (recorder === null) return () => {};
  const id = nextStepId;
  nextStepId += 1;
  active.push({ id, step, startedAt: recorder.now().toISOString() });
  publish();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    active = active.filter((entry) => entry.id !== id);
    publish();
  };
}

export async function withCycleStep<Value>(
  step: string,
  operation: () => Promise<Value>,
): Promise<Value> {
  const end = beginCycleStep(step);
  try {
    return await operation();
  } finally {
    end();
  }
}
