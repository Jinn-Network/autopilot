import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LoadedAutopilotConfig } from './config/config.js';
import {
  clearCycleHeartbeat,
  cycleHeartbeatPath,
  readCycleHeartbeat,
  type CycleHeartbeat,
} from './cycle-heartbeat.js';
import type { DoctorReport } from './doctor.js';

export const INTERNAL_DAEMON_ACTIVE_ONCE_ENV =
  'JINN_AUTOPILOT_INTERNAL_DAEMON_ACTIVE_ONCE';

export function daemonActiveOnceEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    [INTERNAL_DAEMON_ACTIVE_ONCE_ENV]: '1',
  };
}

export function spawnDaemonActiveOnce(input: {
  readonly entryPath: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}): ChildProcess {
  return spawn(process.execPath, [
    input.entryPath,
    'internal',
    'engine',
    '--mode',
    'active',
    '--once',
  ], {
    cwd: input.cwd,
    env: daemonActiveOnceEnvironment(input.environment),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

export async function completeDaemonCycle(options: {
  readonly exit: Promise<number | null>;
  readonly recordCompletion: (exitCode: number | null) => void | Promise<void>;
  readonly shouldStop: () => boolean;
  readonly intervalMs: number;
  readonly wait: (ms: number) => Promise<void>;
}): Promise<{ readonly exitCode: number | null; readonly waited: boolean }> {
  const exitCode = await options.exit;
  await options.recordCompletion(exitCode);
  if (options.shouldStop()) return { exitCode, waited: false };
  await options.wait(options.intervalMs);
  return { exitCode, waited: true };
}

/**
 * Floor for the cycle-duration watchdog (jinn-autopilot#132).
 *
 * Deliberately a constant and NOT config. A cycle that outlives this is not a
 * tuning question, it is the one failure class no other signal covers: the
 * per-lane starvation lines (#113), the reconciliation-stale counter (#130) and
 * the `Snapshot:` line all fire at cycle *end*, so a cycle that never ends is
 * silent everywhere else. An operator who could raise this knob could silence
 * the only evidence that a cycle is stuck; a threshold that needed raising per
 * repository would mean the signal itself is wrong.
 *
 * Twenty minutes is chosen against the shape of a healthy cycle rather than a
 * quantile: a full reconciliation plus a dispatch fan-out is minutes, not tens
 * of minutes, and the incident this came from sat at 2h08m on one synchronous
 * `git worktree remove`. Under a long poll interval two intervals is already
 * anomalous and wins instead, so the effective threshold is
 * `max(2 x pollSeconds, 20 min)`.
 */
export const MIN_CYCLE_WATCHDOG_MS = 20 * 60 * 1_000;

export function cycleWatchdogThresholdMs(pollSeconds: number): number {
  return Math.max(2 * pollSeconds * 1_000, MIN_CYCLE_WATCHDOG_MS);
}

/** Compact human durations: `45s`, `35m`, `2h08m`. */
export function formatCycleDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

export interface CycleStepReading {
  readonly step: string;
  readonly startedAtMs: number;
}

/**
 * The watchdog line, or null while the cycle is still inside its threshold.
 * Pure so the wording and the silence below the threshold are both pinned.
 */
export function cycleWatchdogLine(input: {
  readonly cycleStartedAtMs: number;
  readonly nowMs: number;
  readonly thresholdMs: number;
  readonly step: CycleStepReading | null;
}): string | null {
  const ageMs = input.nowMs - input.cycleStartedAtMs;
  if (ageMs < input.thresholdMs) return null;
  const step = input.step === null
    ? 'none recorded'
    : `${input.step.step} (${
      formatCycleDuration(input.nowMs - input.step.startedAtMs)
    } ago)`;
  return `[autopilot:daemon] cycle running for ${formatCycleDuration(ageMs)} `
    + `(threshold ${formatCycleDuration(input.thresholdMs)}); last step: ${step}`;
}

function scheduleWatchdogInterval(
  tick: () => void,
  intervalMs: number,
): () => void {
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Emits one line per threshold-length interval for as long as the cycle keeps
 * running, starting at the first interval past the threshold. `schedule` is a
 * test seam; production always uses a plain unref'd interval.
 */
export function startCycleWatchdog(input: {
  readonly cycleStartedAtMs: number;
  readonly thresholdMs: number;
  readonly now: () => number;
  readonly readStep: () => CycleStepReading | null;
  readonly log: (line: string) => void;
  readonly schedule?: (tick: () => void, intervalMs: number) => () => void;
}): () => void {
  const schedule = input.schedule ?? scheduleWatchdogInterval;
  return schedule(() => {
    const line = cycleWatchdogLine({
      cycleStartedAtMs: input.cycleStartedAtMs,
      nowMs: input.now(),
      thresholdMs: input.thresholdMs,
      step: input.readStep(),
    });
    if (line !== null) input.log(line);
  }, input.thresholdMs);
}

/**
 * Every line the daemon writes about itself carries this prefix, so a line the
 * daemon emitted can never be mistaken for one of its children's.
 */
const DAEMON_LOG_PREFIX = '[autopilot:daemon]';

/**
 * The engine log. `startService` attaches the detached daemon's stdout AND
 * stderr to this file, and `spawnDaemonActiveOnce` hands the child those same
 * descriptors (`stdio: ['ignore', 'inherit', 'inherit']`), so everything an
 * engine child says lands here. It is therefore the only place a supervisor
 * that never pipes its child can read what that child said before it died.
 */
function engineLogPath(logsDirectory: string): string {
  return join(logsDirectory, 'engine.log');
}

/**
 * How much of the child's last line an operator gets. Long enough for a
 * `fatal:`/`Error:` head plus its cause, short enough that a runaway line — a
 * dumped payload, a stack on one line — cannot push the count and the exit code
 * off the end of the line that carries them.
 */
export const CYCLE_FAILURE_EXCERPT_CHARS = 120;

/** Only the tail of the engine log is ever read; it grows without bound. */
const CYCLE_FAILURE_LOG_TAIL_BYTES = 64 * 1_024;

/**
 * The consecutive-failure counter the live topology can actually carry
 * (jinn-autopilot#139).
 *
 * The in-engine counters (#130's stale reconciliation, #136's unavailable
 * snapshot read) count in memory owned by the engine, and the live daemon
 * spawns one `--mode active --once` child per cycle: every such counter is born
 * at 0 and dies with the child, so a stall lasting 46 cycles looks like 46
 * unrelated first cycles. The daemon process is the only thing here that spans
 * cycles, so this is where a run of failures can be seen at all.
 *
 * A cycle counts as failed on any non-zero exit and on a null one — a spawn
 * error or a signal kill is a failed cycle, not an unknown one. The machine
 * exit is the first exit-0 cycle; nothing else clears it, and a daemon restart
 * legitimately starts at zero because a fresh daemon has failed no cycles.
 */
export function nextConsecutiveFailedCycles(
  previous: number,
  exitCode: number | null,
): number {
  return exitCode === 0 ? 0 : previous + 1;
}

/**
 * The daemon-side stall line, or null while the run is too short to be a run.
 * Pure, so both the wording and the silence after a single failed cycle are
 * pinned. One failure is a cycle that failed; two in a row is a stall, and it is
 * the second that earns the first line — the same shape as the #132 watchdog.
 */
export function consecutiveFailureLine(input: {
  readonly failures: number;
  readonly exitCode: number | null;
  readonly excerpt: string | null;
}): string | null {
  if (input.failures < 2) return null;
  const exit = input.exitCode === null ? 'unknown' : String(input.exitCode);
  const last = input.excerpt === null || input.excerpt === ''
    ? 'none recorded'
    : input.excerpt;
  return `${DAEMON_LOG_PREFIX} cycle failed ${input.failures} time(s) in a row `
    + `(exit ${exit}); last: ${last}`;
}

/**
 * The last thing the engine child said, redacted and cut to
 * `CYCLE_FAILURE_EXCERPT_CHARS`. Blank lines and the daemon's own lines are
 * skipped: without the second rule the signal quotes itself, since the failure
 * line it just wrote is the newest line in the very log it reads next cycle.
 */
export function cycleFailureExcerpt(content: string): string | null {
  const lines = content.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line === '' || line.startsWith(DAEMON_LOG_PREFIX)) continue;
    return redactLog(line).slice(0, CYCLE_FAILURE_EXCERPT_CHARS);
  }
  return null;
}

/**
 * Reads the excerpt from the engine log's tail. Never throws: a missing,
 * unreadable, or truncated log is a missing excerpt, not a failed cycle.
 */
export function readCycleFailureExcerpt(logPath: string): string | null {
  try {
    const stat = statSync(logPath);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, CYCLE_FAILURE_LOG_TAIL_BYTES);
    if (length <= 0) return null;
    const buffer = Buffer.alloc(length);
    const descriptor = openSync(logPath, 'r');
    try {
      readSync(descriptor, buffer, 0, length, stat.size - length);
    } finally {
      closeSync(descriptor);
    }
    // A tail cut mid-character only damages the FIRST line of the window, which
    // is never the one returned unless the whole tail is a single line.
    return cycleFailureExcerpt(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * The whole signal for one completed cycle, in one call the daemon loop can
 * make unguarded: a clean cycle reads no log at all, and a log read that throws
 * degrades to "none recorded" rather than taking the supervisor down with it.
 */
export function cycleFailureSignal(input: {
  readonly failures: number;
  readonly exitCode: number | null;
  readonly readExcerpt: () => string | null;
}): { readonly excerpt: string | null; readonly line: string | null } {
  let excerpt: string | null = null;
  if (input.failures > 0) {
    try {
      excerpt = input.readExcerpt();
    } catch {
      excerpt = null;
    }
  }
  return {
    excerpt,
    line: consecutiveFailureLine({
      failures: input.failures,
      exitCode: input.exitCode,
      excerpt,
    }),
  };
}

export interface DaemonCycleStatus {
  readonly startedAt: string;
  readonly ageMs: number;
  readonly thresholdMs: number;
  readonly overdue: boolean;
  readonly step: {
    readonly step: string;
    readonly startedAt: string;
    readonly ageMs: number;
  } | null;
}

/**
 * The in-flight cycle, or null when none is running. A cycle is in flight
 * exactly while `lastCycleStartedAt` is the later of the two markers — the
 * same evidence the watchdog runs on, so `status` and the log agree.
 */
export function daemonCycleStatus(input: {
  readonly metadata: Pick<DaemonMetadata, 'lastCycleStartedAt' | 'lastCycleFinishedAt'>;
  readonly heartbeat: CycleHeartbeat | null;
  readonly thresholdMs: number;
  readonly nowMs: number;
}): DaemonCycleStatus | null {
  const startedAt = input.metadata.lastCycleStartedAt;
  if (startedAt === undefined) return null;
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) return null;
  const finishedAt = input.metadata.lastCycleFinishedAt;
  if (finishedAt !== undefined && Date.parse(finishedAt) >= startedAtMs) return null;
  const ageMs = Math.max(0, input.nowMs - startedAtMs);
  const stepStartedAtMs = input.heartbeat === null
    ? null
    : Date.parse(input.heartbeat.startedAt);
  return {
    startedAt,
    ageMs,
    thresholdMs: input.thresholdMs,
    overdue: ageMs >= input.thresholdMs,
    step: input.heartbeat === null || stepStartedAtMs === null
      || !Number.isFinite(stepStartedAtMs)
      ? null
      : {
          step: input.heartbeat.step,
          startedAt: input.heartbeat.startedAt,
          ageMs: Math.max(0, input.nowMs - stepStartedAtMs),
        },
  };
}

/**
 * The failure-streak clause, or '' when the daemon has no streak to report.
 * Empty for a zero, absent, or pre-#139 field, which is what keeps every
 * healthy daemon line byte-identical to what #132 rendered.
 */
function failureStreakClause(daemon: Partial<DaemonMetadata> | null): string {
  const failures = daemon?.consecutiveFailedCycles ?? 0;
  // `readDaemonMetadata` does not validate the additive fields, so a
  // hand-edited or truncated record must render as no streak, never as one.
  if (!Number.isSafeInteger(failures) || failures < 1) return '';
  const excerpt = daemon?.lastCycleFailureExcerpt;
  const last = typeof excerpt === 'string' && excerpt !== '' ? excerpt : 'none recorded';
  return `; last ${failures} cycle${failures === 1 ? '' : 's'} failed; last: ${last}`;
}

/**
 * `autopilot status`'s daemon line. A live daemon reports the cycle it is in
 * and what that cycle is doing, so "slow" is distinguishable from "hung"
 * without reading logs — and, since #139, a run of failed cycles, so "cycling
 * fine" is distinguishable from "cycling and failing every time".
 */
export function renderDaemonStatus(input: {
  readonly status: string;
  readonly cycle?: DaemonCycleStatus | null;
  /** The daemon record, read only for its additive failure-streak fields. */
  readonly daemon?: Partial<DaemonMetadata> | null;
}): string {
  if (input.status !== 'running') return input.status;
  const streak = failureStreakClause(input.daemon ?? null);
  const cycle = input.cycle ?? null;
  if (cycle === null) return `running (idle${streak})`;
  const overdue = cycle.overdue
    ? `, over the ${formatCycleDuration(cycle.thresholdMs)} watchdog threshold`
    : '';
  const step = cycle.step === null
    ? 'none recorded'
    : `${cycle.step.step} ${formatCycleDuration(cycle.step.ageMs)} ago`;
  return `running (cycle ${formatCycleDuration(cycle.ageMs)}${overdue}; `
    + `step: ${step}${streak})`;
}

export interface DaemonMetadata {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly processStartedAt: string;
  readonly startedAt: string;
  readonly repository: string;
  readonly executableFingerprint: string;
  readonly configHash: string;
  readonly socketPath: string;
  readonly state: 'starting' | 'running' | 'stopping' | 'config-drift' | 'failed';
  readonly lastCycleStartedAt?: string;
  readonly lastCycleFinishedAt?: string;
  readonly lastCycleExitCode?: number | null;
  /**
   * Additive (#139): consecutive cycles that exited non-zero, 0 while healthy.
   * Absent on every record written before #139 and on any record a reader other
   * than `status` cares about, so it stays optional — `classifyDaemonRecord`
   * and `readDaemonMetadata` must keep parsing a record that lacks it.
   */
  readonly consecutiveFailedCycles?: number;
  /** Additive (#139): the excerpt behind the current streak; absent when 0. */
  readonly lastCycleFailureExcerpt?: string;
}

export type DaemonClassification =
  | 'already-running'
  | 'stale'
  | 'binary-drift'
  | 'unsafe-live-mismatch';

export function classifyDaemonRecord(
  record: DaemonMetadata,
  actual: {
    readonly processAlive: boolean;
    readonly processStartedAt: string | null;
    readonly repository: string;
    readonly executableFingerprint: string;
  },
): DaemonClassification {
  if (!actual.processAlive) return 'stale';
  // Process identity is processStartedAt + repository: pid reuse cannot
  // preserve a start time, so a match here proves the live process IS this
  // repository's daemon. Only the executable fingerprint may legitimately
  // drift (e.g. `yarn build` rewrote dist under a still-running daemon), and
  // that alone downgrades to 'binary-drift' rather than the unsafe verdict.
  const identityMatches = actual.processStartedAt === record.processStartedAt
    && actual.repository === record.repository;
  if (!identityMatches) return 'unsafe-live-mismatch';
  return actual.executableFingerprint === record.executableFingerprint
    ? 'already-running'
    : 'binary-drift';
}

export function shouldRunDaemonCycle(input: {
  readonly stopping: boolean;
  readonly startupConfigHash: string;
  readonly currentConfigHash: string;
}): { readonly run: true } | {
  readonly run: false;
  readonly reason: 'stopping' | 'config-drift';
} {
  if (input.stopping) return { run: false, reason: 'stopping' };
  if (input.currentConfigHash !== input.startupConfigHash) {
    return { run: false, reason: 'config-drift' };
  }
  return { run: true };
}

function hashFile(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

export function configurationHash(path: string): string {
  return hashFile(path);
}

export function executableFingerprint(entryPath: string): string {
  const executable = realpathSync(process.execPath);
  const entry = realpathSync(entryPath);
  const executableStat = statSync(executable);
  const hash = createHash('sha256');
  hash.update(executable);
  hash.update('\0');
  hash.update([
    executableStat.dev,
    executableStat.ino,
    executableStat.size,
    executableStat.mtimeMs,
  ].join(':'));
  hash.update('\0');
  hash.update(entry);
  hash.update('\0');
  hash.update(readFileSync(entry));
  return `sha256:${hash.digest('hex')}`;
}

function metadataPath(loaded: LoadedAutopilotConfig): string {
  return join(loaded.paths.service, 'daemon.json');
}

const SAFE_UNIX_SOCKET_PATH_BYTES = 100;

export function serviceSocketPath(
  loaded: Pick<LoadedAutopilotConfig, 'stateKey'>,
  temporaryDirectory = tmpdir(),
): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : process.pid;
  const socketName = `${createHash('sha256')
    .update(loaded.stateKey)
    .digest('hex')
    .slice(0, 24)}.sock`;
  const candidate = join(temporaryDirectory, `ap-${uid}`, socketName);
  if (Buffer.byteLength(candidate) <= SAFE_UNIX_SOCKET_PATH_BYTES) {
    return candidate;
  }
  const fallback = join('/tmp', `ap-${uid}`, socketName);
  if (Buffer.byteLength(fallback) > SAFE_UNIX_SOCKET_PATH_BYTES) {
    throw new Error('unable to construct a safe Unix control socket path');
  }
  return fallback;
}

function ensureSocketDirectory(controlPath: string): void {
  const directory = dirname(controlPath);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`daemon socket parent must be a real directory: ${directory}`);
  }
  if (
    typeof process.getuid === 'function'
    && stat.uid !== process.getuid()
  ) {
    throw new Error(`daemon socket parent must be owned by the current user: ${directory}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`daemon socket parent must be owner-only: ${directory}`);
  }
}

function removeControlSocket(loaded: LoadedAutopilotConfig): void {
  const controlPath = serviceSocketPath(loaded);
  ensureSocketDirectory(controlPath);
  rmSync(controlPath, { force: true });
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function readDaemonMetadata(
  loaded: LoadedAutopilotConfig,
): DaemonMetadata | null {
  const path = metadataPath(loaded);
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('daemon metadata must be a regular owner-only file');
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as DaemonMetadata;
  if (
    parsed.schemaVersion !== 1
    || !Number.isSafeInteger(parsed.pid)
    || parsed.pid <= 0
    || typeof parsed.processStartedAt !== 'string'
    || typeof parsed.repository !== 'string'
    || typeof parsed.executableFingerprint !== 'string'
  ) {
    throw new Error('daemon metadata is malformed');
  }
  return parsed;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readCurrentCycleStep(path: string): CycleStepReading | null {
  const heartbeat = readCycleHeartbeat(path, processAlive);
  if (heartbeat === null) return null;
  return { step: heartbeat.step, startedAtMs: Date.parse(heartbeat.startedAt) };
}

async function processStartedAt(pid: number): Promise<string | null> {
  if (!processAlive(pid)) return null;
  const child = spawn('ps', ['-p', String(pid), '-o', 'lstart='], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { output += chunk; });
  const code = await new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null));
    child.once('exit', resolve);
  });
  return code === 0 && output.trim() !== '' ? output.trim() : null;
}

export async function inspectDaemon(input: {
  readonly loaded: LoadedAutopilotConfig;
  readonly entryPath: string;
}): Promise<{
  readonly classification: DaemonClassification | 'not-running';
  readonly metadata: DaemonMetadata | null;
}> {
  const metadata = readDaemonMetadata(input.loaded);
  if (metadata == null) return { classification: 'not-running', metadata: null };
  return {
    classification: classifyDaemonRecord(metadata, {
      processAlive: processAlive(metadata.pid),
      processStartedAt: await processStartedAt(metadata.pid),
      repository: input.loaded.config.repository.slug,
      executableFingerprint: executableFingerprint(input.entryPath),
    }),
    metadata,
  };
}

export function serviceCredentialEnvironment(
  loaded: LoadedAutopilotConfig,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!existsSync(loaded.paths.credentials)) return { ...environment };
  const stat = lstatSync(loaded.paths.credentials);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('credentials.json must be a regular owner-only file');
  }
  const profile = JSON.parse(readFileSync(loaded.paths.credentials, 'utf8')) as {
    implementation?: { token?: unknown } | null;
    review?: { token?: unknown } | null;
  };
  return {
    ...environment,
    AUTOPILOT_REPOSITORY_SLUG: loaded.config.repository.slug,
    AUTOPILOT_REPOSITORY_URL: loaded.config.repository.remote.url,
    AUTOPILOT_REPOSITORY_REST_DATABASE_ID:
      String(loaded.config.repository.restDatabaseId),
    AUTOPILOT_PROJECT_OWNER: loaded.config.project.owner,
    AUTOPILOT_PROJECT_NUMBER: String(loaded.config.project.number),
    ...(environment.AUTOPILOT_GITHUB_IMPLEMENT_TOKEN != null
      ? {}
      : typeof profile.implementation?.token === 'string'
        ? { AUTOPILOT_GITHUB_IMPLEMENT_TOKEN: profile.implementation.token }
        : {}),
    ...(environment.AUTOPILOT_GITHUB_REVIEW_TOKEN != null
      ? {}
      : typeof profile.review?.token === 'string'
        ? { AUTOPILOT_GITHUB_REVIEW_TOKEN: profile.review.token }
        : {}),
  };
}

export async function startService(input: {
  readonly loaded: LoadedAutopilotConfig;
  readonly entryPath: string;
  readonly foreground: boolean;
  readonly doctor: () => Promise<DoctorReport>;
  readonly environment?: NodeJS.ProcessEnv;
  // Test-only seam: production callers never pass this, so inspectDaemon
  // (with its real ps/fingerprint reads) is always used outside tests.
  readonly inspect?: typeof inspectDaemon;
}): Promise<{ readonly status: 'started' | 'already-running'; readonly pid: number }> {
  const report = await input.doctor();
  if (report.blocking) {
    throw new Error('Autopilot doctor found blocking failures; start was refused');
  }
  mkdirSync(input.loaded.paths.service, { recursive: true, mode: 0o700 });
  mkdirSync(input.loaded.paths.logs, { recursive: true, mode: 0o700 });
  const inspect = input.inspect ?? inspectDaemon;
  const inspected = await inspect(input);
  if (inspected.classification === 'already-running') {
    return { status: 'already-running', pid: inspected.metadata!.pid };
  }
  if (inspected.classification === 'binary-drift') {
    throw new Error(
      'Live daemon predates the current build; run autopilot stop (or stop --force) first',
    );
  }
  if (inspected.classification === 'unsafe-live-mismatch') {
    throw new Error(
      'Recorded daemon PID is live but its identity does not match; refusing replacement',
    );
  }
  if (inspected.classification === 'stale') {
    rmSync(metadataPath(input.loaded), { force: true });
    removeControlSocket(input.loaded);
  }
  if (input.foreground) {
    await runDaemon({
      loaded: input.loaded,
      entryPath: input.entryPath,
      environment: serviceCredentialEnvironment(
        input.loaded,
        input.environment ?? process.env,
      ),
    });
    return { status: 'started', pid: process.pid };
  }
  const logPath = engineLogPath(input.loaded.paths.logs);
  const descriptor = openSync(logPath, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [
      input.entryPath,
      'internal',
      'daemon',
      input.loaded.repositoryRoot,
    ], {
      cwd: input.loaded.repositoryRoot,
      detached: true,
      env: serviceCredentialEnvironment(
        input.loaded,
        input.environment ?? process.env,
      ),
      stdio: ['ignore', descriptor, descriptor],
    });
    child.unref();
    if (child.pid == null) throw new Error('daemon process did not report a PID');
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (existsSync(metadataPath(input.loaded))) {
        const inspectedAfterStart = await inspectDaemon(input);
        if (inspectedAfterStart.classification === 'already-running') {
          return { status: 'started', pid: child.pid };
        }
        if (inspectedAfterStart.classification === 'unsafe-live-mismatch') {
          throw new Error('new daemon wrote unverifiable process metadata');
        }
      }
      if (!processAlive(child.pid)) {
        throw new Error(`daemon exited during startup; inspect ${logPath}`);
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    throw new Error(`daemon did not become ready; inspect ${logPath}`);
  } finally {
    closeSync(descriptor);
  }
}

function updateMetadata(
  loaded: LoadedAutopilotConfig,
  metadata: DaemonMetadata,
  patch: Partial<DaemonMetadata>,
): DaemonMetadata {
  const next = { ...metadata, ...patch };
  atomicWriteJson(metadataPath(loaded), next);
  return next;
}

export async function runDaemon(input: {
  readonly loaded: LoadedAutopilotConfig;
  readonly entryPath: string;
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<void> {
  mkdirSync(input.loaded.paths.service, { recursive: true, mode: 0o700 });
  mkdirSync(input.loaded.paths.logs, { recursive: true, mode: 0o700 });
  const controlPath = serviceSocketPath(input.loaded);
  ensureSocketDirectory(controlPath);
  rmSync(controlPath, { force: true });
  const startupConfigHash = configurationHash(input.loaded.configPath);
  const heartbeatPath = cycleHeartbeatPath(input.loaded.paths.service);
  const watchdogThresholdMs = cycleWatchdogThresholdMs(
    input.loaded.config.scheduler.pollSeconds,
  );
  const cycleLogPath = engineLogPath(input.loaded.paths.logs);
  // Daemon-process-local and deliberately not recovered from the record on
  // start (#139): a daemon that has just started has failed no cycles, so a
  // restart is the operator-visible reset.
  let consecutiveFailedCycles = 0;
  let stopping = false;
  let wake: (() => void) | undefined;
  let metadata: DaemonMetadata = {
    schemaVersion: 1,
    pid: process.pid,
    // Deliberately not "fixed": when `ps` is unavailable this fallback can
    // never match a later real `ps` reading, so such a record legitimately
    // classifies as unsafe rather than drift or already-running — that is
    // the correct, conservative outcome for an unverifiable start time.
    processStartedAt: (await processStartedAt(process.pid))
      ?? `pid-${process.pid}`,
    startedAt: new Date().toISOString(),
    repository: input.loaded.config.repository.slug,
    executableFingerprint: executableFingerprint(input.entryPath),
    configHash: startupConfigHash,
    socketPath: controlPath,
    state: 'starting',
  };

  const server = createServer((connection) => {
    let message = '';
    connection.setEncoding('utf8');
    connection.on('data', (chunk: string) => {
      message += chunk;
      if (message.trim() === 'stop') {
        stopping = true;
        metadata = updateMetadata(input.loaded, metadata, { state: 'stopping' });
        wake?.();
        connection.end('stopping\n');
      }
    });
    connection.on('end', () => {
      if (message.trim() !== 'stop') connection.end('unknown command\n');
    });
  });
  const requestStop = (): void => {
    stopping = true;
    metadata = updateMetadata(input.loaded, metadata, { state: 'stopping' });
    wake?.();
  };
  let signalHandlersInstalled = false;
  try {
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(controlPath, () => resolvePromise());
    });
    chmodSync(controlPath, 0o600);
    metadata = updateMetadata(input.loaded, metadata, { state: 'running' });
    process.once('SIGTERM', requestStop);
    process.once('SIGINT', requestStop);
    signalHandlersInstalled = true;

    while (true) {
      const decision = shouldRunDaemonCycle({
        stopping,
        startupConfigHash,
        currentConfigHash: configurationHash(input.loaded.configPath),
      });
      if (!decision.run) {
        if (decision.reason === 'config-drift') {
          metadata = updateMetadata(input.loaded, metadata, { state: 'config-drift' });
          await new Promise<void>((resolvePromise) => {
            wake = resolvePromise;
          });
          wake = undefined;
          continue;
        }
        break;
      }

      // Nothing from the previous cycle's child may survive into this one:
      // the heartbeat is process-local, so the last step of an engine that has
      // already exited must never be reported as this cycle's current step.
      clearCycleHeartbeat(heartbeatPath);
      const cycleStartedAtMs = Date.now();
      metadata = updateMetadata(input.loaded, metadata, {
        lastCycleStartedAt: new Date(cycleStartedAtMs).toISOString(),
      });
      const controller = spawnDaemonActiveOnce({
        entryPath: input.entryPath,
        cwd: input.loaded.repositoryRoot,
        environment: input.environment ?? process.env,
      });
      const stopWatchdog = startCycleWatchdog({
        cycleStartedAtMs,
        thresholdMs: watchdogThresholdMs,
        now: () => Date.now(),
        readStep: () => readCurrentCycleStep(heartbeatPath),
        log: (line) => console.warn(line),
      });
      let completed: Awaited<ReturnType<typeof completeDaemonCycle>>;
      try {
        completed = await completeDaemonCycle({
          exit: new Promise<number | null>((resolvePromise) => {
            controller.once('error', () => resolvePromise(null));
            controller.once('exit', resolvePromise);
          }),
          recordCompletion: (exitCode) => {
            stopWatchdog();
            clearCycleHeartbeat(heartbeatPath);
            consecutiveFailedCycles = nextConsecutiveFailedCycles(
              consecutiveFailedCycles,
              exitCode,
            );
            const signal = cycleFailureSignal({
              failures: consecutiveFailedCycles,
              exitCode,
              readExcerpt: () => readCycleFailureExcerpt(cycleLogPath),
            });
            metadata = updateMetadata(input.loaded, metadata, {
              lastCycleFinishedAt: new Date().toISOString(),
              lastCycleExitCode: exitCode,
              consecutiveFailedCycles,
              // Explicit undefined clears the field on the first clean cycle:
              // `JSON.stringify` drops it, so a healthy record carries no
              // excerpt at all rather than a stale one.
              lastCycleFailureExcerpt: signal.excerpt ?? undefined,
              state: stopping ? 'stopping' : 'running',
            });
            if (signal.line !== null) console.warn(signal.line);
          },
          shouldStop: () => stopping,
          intervalMs: input.loaded.config.scheduler.pollSeconds * 1_000,
          wait: (ms) => new Promise<void>((resolvePromise) => {
            const timer = setTimeout(resolvePromise, ms);
            wake = () => {
              clearTimeout(timer);
              resolvePromise();
            };
          }),
        });
      } finally {
        stopWatchdog();
      }
      if (!completed.waited) break;
      wake = undefined;
    }
  } finally {
    if (signalHandlersInstalled) {
      process.off('SIGTERM', requestStop);
      process.off('SIGINT', requestStop);
    }
    if (server.listening) {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
    rmSync(controlPath, { force: true });
    clearCycleHeartbeat(heartbeatPath);
    const currentMetadata = readDaemonMetadata(input.loaded);
    if (currentMetadata?.pid === process.pid) {
      rmSync(metadataPath(input.loaded), { force: true });
    }
  }
}

async function requestControl(socket: string, message: string): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const connection = createConnection(socket);
    let output = '';
    connection.setEncoding('utf8');
    connection.once('error', reject);
    connection.on('data', (chunk: string) => { output += chunk; });
    connection.on('end', () => resolvePromise(output));
    connection.end(message);
  });
}

export async function stopService(input: {
  readonly loaded: LoadedAutopilotConfig;
  readonly entryPath: string;
  readonly force: boolean;
  // Test-only seam: production callers never pass this, so inspectDaemon
  // (with its real ps/fingerprint reads) is always used outside tests.
  readonly inspect?: typeof inspectDaemon;
}): Promise<{ readonly status: 'not-running' | 'stopping' | 'forced' }> {
  const inspect = input.inspect ?? inspectDaemon;
  const inspected = await inspect(input);
  if (inspected.classification === 'not-running' || inspected.classification === 'stale') {
    if (inspected.classification === 'stale') {
      rmSync(metadataPath(input.loaded), { force: true });
      removeControlSocket(input.loaded);
    }
    return { status: 'not-running' };
  }
  if (inspected.classification === 'unsafe-live-mismatch') {
    throw new Error('Refusing to signal a live PID whose daemon identity does not match');
  }
  // 'already-running' and 'binary-drift' both carry a proven process
  // identity (processStartedAt + repository matched); only the on-disk
  // binary may have drifted, and the recorded socket/pid are independent of
  // that binary, so a plain stop or --force kill is safe on either verdict.
  const metadata = inspected.metadata!;
  if (input.force) {
    process.kill(metadata.pid, 'SIGKILL');
    return { status: 'forced' };
  }
  await requestControl(metadata.socketPath, 'stop');
  return { status: 'stopping' };
}

export async function serviceStatus(input: {
  readonly loaded: LoadedAutopilotConfig;
  readonly entryPath: string;
  // Test-only seam: production callers never pass this, so inspectDaemon
  // (with its real ps/fingerprint reads) is always used outside tests.
  readonly inspect?: typeof inspectDaemon;
}): Promise<{
  readonly status: 'not-running' | 'running' | 'stale' | 'stale-binary' | 'unsafe';
  readonly daemon?: DaemonMetadata;
  /** Additive (#132): the in-flight cycle's age and current step, if any. */
  readonly cycle?: DaemonCycleStatus | null;
}> {
  const inspected = await (input.inspect ?? inspectDaemon)(input);
  switch (inspected.classification) {
    case 'not-running':
      return { status: 'not-running' };
    case 'stale':
      return { status: 'stale', daemon: inspected.metadata! };
    // Distinct from 'unsafe': identity (processStartedAt + repository) is
    // proven, so an operator can tell "rebuild happened, stop/replace it" —
    // still live but running last build's binary — apart from "unsafe pid".
    case 'binary-drift':
      return { status: 'stale-binary', daemon: inspected.metadata! };
    case 'unsafe-live-mismatch':
      return { status: 'unsafe', daemon: inspected.metadata! };
    case 'already-running':
      return {
        status: 'running',
        daemon: inspected.metadata!,
        cycle: daemonCycleStatus({
          metadata: inspected.metadata!,
          heartbeat: readCycleHeartbeat(
            cycleHeartbeatPath(input.loaded.paths.service),
            processAlive,
          ),
          thresholdMs: cycleWatchdogThresholdMs(
            input.loaded.config.scheduler.pollSeconds,
          ),
          nowMs: Date.now(),
        }),
      };
  }
}

const TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

export function redactLog(content: string): string {
  return content
    .replace(TOKEN_PATTERN, '[REDACTED_GITHUB_TOKEN]')
    .replace(
      /((?:GH_TOKEN|GITHUB_TOKEN|AUTOPILOT_GITHUB_(?:IMPLEMENT|REVIEW)_TOKEN)\s*[=:]\s*)\S+/gi,
      '$1[REDACTED]',
    );
}
