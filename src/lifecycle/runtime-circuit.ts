import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AutopilotRuntime } from '../autopilot-runtime.js';

/**
 * The session-limit circuit for the `claude` runtime (#152).
 *
 * When Claude Code's account hits its session limit, every worker dies within
 * a second of starting with a non-zero exit — on 2026-09-03 that was 35
 * attempts in a row while the engine kept dispatching into it. That signature
 * is unmistakable and cheap to read: an *instant failure* is a `claude`
 * attempt whose child exited non-zero less than INSTANT_EXIT_MS after it
 * started. Two of them inside INSTANT_FAILURE_WINDOW_MS open the circuit for
 * CIRCUIT_OPEN_MS; while it is open the scheduler prefers the Codex overflow
 * pool for new implementation work. Any `claude` attempt that runs past
 * INSTANT_EXIT_MS, or exits zero, proves the runtime serves again and closes
 * it.
 *
 * Persisted under `state/` because every cycle is a fresh engine process:
 * an in-memory breaker would reset ten minutes later and dispatch into the
 * limit all over again. The file is the whole state; a missing or malformed
 * file is a closed circuit.
 */
export const INSTANT_EXIT_MS = 60_000;
export const INSTANT_FAILURE_WINDOW_MS = 10 * 60_000;
export const INSTANT_FAILURES_TO_OPEN = 2;
export const CIRCUIT_OPEN_MS = 30 * 60_000;
export const RUNTIME_CIRCUIT_FILE = 'runtime-circuit.json';

/** The runtime whose failures the circuit watches. */
const WATCHED_RUNTIME: AutopilotRuntime = 'claude';

interface RuntimeCircuitFile {
  readonly version: 1;
  readonly claude: {
    /** ISO timestamps of instant failures inside the window, oldest first. */
    readonly instantFailuresAt: readonly string[];
    readonly openUntil?: string;
  };
}

export interface RuntimeCircuitReading {
  /** True while the circuit is open: prefer Codex overflow for new work. */
  readonly preferCodex: boolean;
  readonly openUntil?: Date;
  readonly recentInstantFailures: number;
}

export interface RuntimeExitObservation {
  readonly runtime: AutopilotRuntime;
  readonly exitCode: number | null;
  /** ISO timestamps from the attempt manifest; either absent = not classifiable. */
  readonly childStartedAt?: string;
  readonly childExitedAt?: string;
}

const CLOSED: RuntimeCircuitFile = { version: 1, claude: { instantFailuresAt: [] } };

function readFile(path: string): RuntimeCircuitFile {
  if (!existsSync(path)) return CLOSED;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      typeof parsed !== 'object' || parsed === null
      || (parsed as { version?: unknown }).version !== 1
    ) return CLOSED;
    const claude = (parsed as { claude?: unknown }).claude;
    if (typeof claude !== 'object' || claude === null) return CLOSED;
    const at = (claude as { instantFailuresAt?: unknown }).instantFailuresAt;
    const openUntil = (claude as { openUntil?: unknown }).openUntil;
    return {
      version: 1,
      claude: {
        instantFailuresAt: Array.isArray(at)
          ? at.filter((value): value is string => typeof value === 'string')
          : [],
        ...(typeof openUntil === 'string' ? { openUntil } : {}),
      },
    };
  } catch {
    // A malformed file is a closed circuit, never a crashed cycle.
    return CLOSED;
  }
}

function writeFile(path: string, file: RuntimeCircuitFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(temporary, path);
}

function pruneWindow(at: readonly string[], now: Date): string[] {
  const cutoff = now.getTime() - INSTANT_FAILURE_WINDOW_MS;
  return at.filter((iso) => {
    const time = Date.parse(iso);
    return Number.isFinite(time) && time >= cutoff;
  });
}

function reading(file: RuntimeCircuitFile, now: Date): RuntimeCircuitReading {
  const openUntil = file.claude.openUntil === undefined
    ? undefined
    : new Date(file.claude.openUntil);
  const open = openUntil !== undefined
    && Number.isFinite(openUntil.getTime())
    && openUntil.getTime() > now.getTime();
  return {
    preferCodex: open,
    ...(open ? { openUntil: openUntil! } : {}),
    recentInstantFailures: pruneWindow(file.claude.instantFailuresAt, now).length,
  };
}

export function readRuntimeCircuit(path: string, now: Date = new Date()): RuntimeCircuitReading {
  return reading(readFile(path), now);
}

/**
 * Whether one observed exit is the session-limit signature. Unclassifiable
 * exits — no start or exit time on the manifest — count as nothing.
 */
export function isInstantFailure(exit: RuntimeExitObservation): boolean {
  if (exit.exitCode === 0) return false;
  if (exit.childStartedAt === undefined || exit.childExitedAt === undefined) return false;
  const started = Date.parse(exit.childStartedAt);
  const exited = Date.parse(exit.childExitedAt);
  if (!Number.isFinite(started) || !Number.isFinite(exited)) return false;
  return exited - started < INSTANT_EXIT_MS;
}

/**
 * Folds one exit into the circuit and returns the resulting reading. Exits on
 * any runtime but the watched one are ignored; a watched exit that is not an
 * instant failure closes the circuit and clears the window.
 */
export function recordRuntimeExit(
  path: string,
  exit: RuntimeExitObservation,
  now: Date = new Date(),
): RuntimeCircuitReading & { readonly opened: boolean; readonly closed: boolean } {
  const before = readFile(path);
  if (exit.runtime !== WATCHED_RUNTIME) {
    return { ...reading(before, now), opened: false, closed: false };
  }
  const wasOpen = reading(before, now).preferCodex;
  if (!isInstantFailure(exit)) {
    // Proof of service: a session that ran, or finished cleanly.
    const closed: RuntimeCircuitFile = { version: 1, claude: { instantFailuresAt: [] } };
    writeFile(path, closed);
    return { ...reading(closed, now), opened: false, closed: wasOpen };
  }
  const failures = [...pruneWindow(before.claude.instantFailuresAt, now), now.toISOString()];
  const open = wasOpen || failures.length >= INSTANT_FAILURES_TO_OPEN;
  const next: RuntimeCircuitFile = {
    version: 1,
    claude: {
      instantFailuresAt: failures,
      ...(open
        ? {
            openUntil: wasOpen
              ? before.claude.openUntil!
              : new Date(now.getTime() + CIRCUIT_OPEN_MS).toISOString(),
          }
        : {}),
    },
  };
  writeFile(path, next);
  return { ...reading(next, now), opened: open && !wasOpen, closed: false };
}
