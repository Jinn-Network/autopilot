import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LoadedAutopilotConfig } from '../src/config/config.js';
import { cycleHeartbeatPath } from '../src/cycle-heartbeat.js';
import {
  classifyDaemonRecord,
  completeDaemonCycle,
  consecutiveFailureLine,
  CYCLE_FAILURE_EXCERPT_CHARS,
  cycleFailureExcerpt,
  cycleFailureSignal,
  cycleWatchdogLine,
  cycleWatchdogThresholdMs,
  daemonActiveOnceEnvironment,
  daemonCycleStatus,
  formatCycleDuration,
  healStartTimeFallback,
  inspectDaemon,
  INTERNAL_DAEMON_ACTIVE_ONCE_ENV,
  isStartTimeFallback,
  MIN_CYCLE_WATCHDOG_MS,
  nextConsecutiveFailedCycles,
  readCycleFailureExcerpt,
  readDaemonMetadata,
  renderDaemonStatus,
  runDaemon,
  serviceSocketPath,
  serviceStatus,
  START_TIME_FALLBACK_HEAL_ATTEMPTS,
  startCycleWatchdog,
  startService,
  stopService,
  type DaemonMetadata,
} from '../src/service.js';

const metadata: DaemonMetadata = {
  schemaVersion: 1,
  pid: 4242,
  processStartedAt: 'Thu Jul 23 23:00:00 2026',
  startedAt: '2026-07-23T21:00:00.000Z',
  repository: 'Octo-Labs/widget',
  executableFingerprint: 'sha256:expected',
  configHash: 'sha256:config',
  socketPath: '/tmp/autopilot.sock',
  state: 'running',
};

describe('repository-scoped daemon safety', () => {
  it('makes duplicate starts idempotent only for an exact verified live daemon', () => {
    expect(classifyDaemonRecord(metadata, {
      processAlive: true,
      processStartedAt: metadata.processStartedAt,
      repository: metadata.repository,
      executableFingerprint: metadata.executableFingerprint,
    })).toBe('already-running');
  });

  it('allows replacement only when the recorded process is proven dead', () => {
    expect(classifyDaemonRecord(metadata, {
      processAlive: false,
      processStartedAt: null,
      repository: metadata.repository,
      executableFingerprint: metadata.executableFingerprint,
    })).toBe('stale');
  });

  it('classifies a live daemon with a proven identity but a rebuilt binary as drift, not unsafe', () => {
    expect(classifyDaemonRecord(metadata, {
      processAlive: true,
      processStartedAt: metadata.processStartedAt,
      repository: metadata.repository,
      executableFingerprint: 'sha256:other',
    })).toBe('binary-drift');
  });

  it('refuses to signal or replace a live PID whose start time does not match the record', () => {
    expect(classifyDaemonRecord(metadata, {
      processAlive: true,
      processStartedAt: 'Thu Jul 23 22:59:00 2026',
      repository: metadata.repository,
      executableFingerprint: metadata.executableFingerprint,
    })).toBe('unsafe-live-mismatch');
  });

  it('binds daemon metadata to exactly one repository', () => {
    expect(classifyDaemonRecord(metadata, {
      processAlive: true,
      processStartedAt: metadata.processStartedAt,
      repository: 'Octo-Labs/other',
      executableFingerprint: metadata.executableFingerprint,
    })).toBe('unsafe-live-mismatch');
  });

  it('uses a deterministic, collision-safe control socket below macOS limits', () => {
    const first = serviceSocketPath(
      { stateKey: 'octo-labs-widget-123456789abc' },
      '/an/intentionally/very/long/temporary/directory/that/would/exceed/the/unix/socket/path/limit',
    );
    const repeated = serviceSocketPath(
      { stateKey: 'octo-labs-widget-123456789abc' },
      '/an/intentionally/very/long/temporary/directory/that/would/exceed/the/unix/socket/path/limit',
    );
    const second = serviceSocketPath(
      { stateKey: 'octo-labs-other-123456789abc' },
      '/an/intentionally/very/long/temporary/directory/that/would/exceed/the/unix/socket/path/limit',
    );

    expect(first).toBe(repeated);
    expect(first).not.toBe(second);
    expect(Buffer.byteLength(first)).toBeLessThanOrEqual(100);
    expect(first).toMatch(/^\/tmp\/ap-\d+\/[0-9a-f]{24}\.sock$/);
  });

  it('marks a copied environment only for a daemon-spawned active once child', () => {
    const parent = {
      PATH: '/opt/homebrew/bin',
      JINN_AUTOPILOT_INTERNAL_DAEMON_ACTIVE_ONCE: 'stale',
    };

    const child = daemonActiveOnceEnvironment(parent);

    expect(child).toEqual({
      PATH: '/opt/homebrew/bin',
      JINN_AUTOPILOT_INTERNAL_DAEMON_ACTIVE_ONCE: '1',
    });
    expect(parent.JINN_AUTOPILOT_INTERNAL_DAEMON_ACTIVE_ONCE).toBe('stale');
    expect(INTERNAL_DAEMON_ACTIVE_ONCE_ENV)
      .toBe('JINN_AUTOPILOT_INTERNAL_DAEMON_ACTIVE_ONCE');
  });

  it('measures the next poll delay from child completion', async () => {
    let completeChild: ((exitCode: number | null) => void) | undefined;
    const exit = new Promise<number | null>((resolve) => {
      completeChild = resolve;
    });
    let clockMs = 100;
    let completionAt: number | undefined;
    let waitStartedAt: number | undefined;

    const cycle = completeDaemonCycle({
      exit,
      recordCompletion: () => {
        completionAt = clockMs;
      },
      shouldStop: () => false,
      intervalMs: 600_000,
      wait: async (ms) => {
        waitStartedAt = clockMs;
        clockMs += ms;
      },
    });
    await Promise.resolve();
    expect(waitStartedAt).toBeUndefined();

    clockMs = 1_000;
    completeChild!(0);

    await expect(cycle).resolves.toEqual({ exitCode: 0, waited: true });
    expect(completionAt).toBe(1_000);
    expect(waitStartedAt).toBe(completionAt);
    expect(clockMs).toBe(601_000);
  });
});

const MINUTE = 60_000;

describe('cycle-duration watchdog', () => {
  it('takes the longer of two poll intervals and a twenty-minute floor', () => {
    expect(MIN_CYCLE_WATCHDOG_MS).toBe(20 * MINUTE);
    expect(cycleWatchdogThresholdMs(60)).toBe(20 * MINUTE);
    expect(cycleWatchdogThresholdMs(600)).toBe(20 * MINUTE);
    expect(cycleWatchdogThresholdMs(900)).toBe(30 * MINUTE);
  });

  it('renders durations the way an operator reads a stalled cycle', () => {
    expect(formatCycleDuration(0)).toBe('0s');
    expect(formatCycleDuration(45_000)).toBe('45s');
    expect(formatCycleDuration(20 * MINUTE)).toBe('20m');
    expect(formatCycleDuration(35 * MINUTE)).toBe('35m');
    expect(formatCycleDuration(128 * MINUTE)).toBe('2h08m');
  });

  it('stays silent while a cycle is still inside the threshold', () => {
    expect(cycleWatchdogLine({
      cycleStartedAtMs: 0,
      nowMs: 19 * MINUTE,
      thresholdMs: 20 * MINUTE,
      step: { step: 'worktree remove pr-3683', startedAtMs: 5 * MINUTE },
    })).toBeNull();
  });

  it('carries the cycle age and the last recorded step once the threshold is passed', () => {
    expect(cycleWatchdogLine({
      cycleStartedAtMs: 0,
      nowMs: 35 * MINUTE,
      thresholdMs: 20 * MINUTE,
      step: { step: 'worktree remove pr-3683', startedAtMs: 14 * MINUTE },
    })).toBe(
      '[autopilot:daemon] cycle running for 35m (threshold 20m); '
      + 'last step: worktree remove pr-3683 (21m ago)',
    );
    expect(cycleWatchdogLine({
      cycleStartedAtMs: 0,
      nowMs: 35 * MINUTE,
      thresholdMs: 20 * MINUTE,
      step: null,
    })).toBe(
      '[autopilot:daemon] cycle running for 35m (threshold 20m); '
      + 'last step: none recorded',
    );
  });

  it('logs nothing below the threshold and exactly one line per interval above it', () => {
    const scheduled: { tick?: () => void; intervalMs?: number } = {};
    let stopped = false;
    const lines: string[] = [];
    let nowMs = 0;
    let step: { step: string; startedAtMs: number } | null = null;

    const stop = startCycleWatchdog({
      cycleStartedAtMs: 0,
      thresholdMs: 20 * MINUTE,
      now: () => nowMs,
      readStep: () => step,
      log: (line) => lines.push(line),
      schedule: (tick, intervalMs) => {
        scheduled.tick = tick;
        scheduled.intervalMs = intervalMs;
        return () => { stopped = true; };
      },
    });

    expect(scheduled.intervalMs).toBe(20 * MINUTE);
    nowMs = 19 * MINUTE;
    scheduled.tick!();
    expect(lines).toEqual([]);

    step = { step: 'worktree remove pr-3683', startedAtMs: 14 * MINUTE };
    nowMs = 20 * MINUTE;
    scheduled.tick!();
    nowMs = 40 * MINUTE;
    scheduled.tick!();

    expect(lines).toEqual([
      '[autopilot:daemon] cycle running for 20m (threshold 20m); '
      + 'last step: worktree remove pr-3683 (6m ago)',
      '[autopilot:daemon] cycle running for 40m (threshold 20m); '
      + 'last step: worktree remove pr-3683 (26m ago)',
    ]);

    stop();
    expect(stopped).toBe(true);
  });
});

describe('consecutive failed-cycle streak', () => {
  it('counts every consecutive non-zero exit and resets on the first clean cycle', () => {
    expect(nextConsecutiveFailedCycles(0, 1)).toBe(1);
    expect(nextConsecutiveFailedCycles(1, 1)).toBe(2);
    expect(nextConsecutiveFailedCycles(2, 137)).toBe(3);
    // A child that never reported an exit code (spawn error, signal kill) is a
    // failed cycle, not an unknown one.
    expect(nextConsecutiveFailedCycles(3, null)).toBe(4);
    expect(nextConsecutiveFailedCycles(4, 0)).toBe(0);
    expect(nextConsecutiveFailedCycles(0, 0)).toBe(0);
  });

  it('stays silent after one failed cycle and speaks once per cycle from the second', () => {
    expect(consecutiveFailureLine({ failures: 0, exitCode: 0, excerpt: null })).toBeNull();
    expect(consecutiveFailureLine({ failures: 1, exitCode: 1, excerpt: 'boom' })).toBeNull();
    expect(consecutiveFailureLine({ failures: 2, exitCode: 1, excerpt: 'boom' })).toBe(
      '[autopilot:daemon] cycle failed 2 time(s) in a row (exit 1); last: boom',
    );
    expect(consecutiveFailureLine({ failures: 3, exitCode: 137, excerpt: 'boom' })).toBe(
      '[autopilot:daemon] cycle failed 3 time(s) in a row (exit 137); last: boom',
    );
    expect(consecutiveFailureLine({ failures: 2, exitCode: null, excerpt: null })).toBe(
      '[autopilot:daemon] cycle failed 2 time(s) in a row (exit unknown); '
      + 'last: none recorded',
    );
  });

  it('drives one line per cycle across a failing run that a success ends', () => {
    const lines: string[] = [];
    let failures = 0;

    for (const exitCode of [1, 1, 1, 0, 1]) {
      failures = nextConsecutiveFailedCycles(failures, exitCode);
      const line = consecutiveFailureLine({ failures, exitCode, excerpt: 'ECONNRESET' });
      if (line !== null) lines.push(line);
    }

    expect(lines).toEqual([
      '[autopilot:daemon] cycle failed 2 time(s) in a row (exit 1); last: ECONNRESET',
      '[autopilot:daemon] cycle failed 3 time(s) in a row (exit 1); last: ECONNRESET',
    ]);
    expect(failures).toBe(1);
  });

  it('takes the last meaningful engine line, redacted and cut at 120 characters', () => {
    expect(CYCLE_FAILURE_EXCERPT_CHARS).toBe(120);
    expect(cycleFailureExcerpt('')).toBeNull();
    expect(cycleFailureExcerpt('\n  \n\n')).toBeNull();
    expect(cycleFailureExcerpt([
      'cycle 41 start',
      'Error: HTTP 504 from api.github.com',
      '',
      '   ',
    ].join('\n'))).toBe('Error: HTTP 504 from api.github.com');
    // The daemon's own lines must never become the next cycle's excerpt, or the
    // signal quotes itself instead of the child.
    expect(cycleFailureExcerpt([
      'Error: HTTP 504 from api.github.com',
      '[autopilot:daemon] cycle failed 2 time(s) in a row (exit 1); last: x',
      '[autopilot:daemon] cycle running for 20m (threshold 20m); last step: none recorded',
    ].join('\n'))).toBe('Error: HTTP 504 from api.github.com');
    expect(cycleFailureExcerpt(`Error: ${'x'.repeat(200)}\n`))
      .toBe(`Error: ${'x'.repeat(113)}`);
    expect(cycleFailureExcerpt('fatal: bad credentials ghp_abcdefghijklmnopqrstuvwxyz012345\n'))
      .toBe('fatal: bad credentials [REDACTED_GITHUB_TOKEN]');
  });

  it('reads the tail of the engine log the child inherits, and never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-failure-excerpt-'));
    const logPath = join(dir, 'engine.log');

    expect(readCycleFailureExcerpt(logPath)).toBeNull();
    writeFileSync(logPath, '');
    expect(readCycleFailureExcerpt(logPath)).toBeNull();
    writeFileSync(logPath, `${'filler line\n'.repeat(20_000)}Error: worktree is locked\n`);
    expect(readCycleFailureExcerpt(logPath)).toBe('Error: worktree is locked');
    expect(readCycleFailureExcerpt(dir)).toBeNull();
  });

  it('never lets the excerpt source throw into the daemon loop', () => {
    expect(cycleFailureSignal({
      failures: 2,
      exitCode: 1,
      readExcerpt: () => { throw new Error('log read exploded'); },
    })).toEqual({
      excerpt: null,
      line: '[autopilot:daemon] cycle failed 2 time(s) in a row (exit 1); '
        + 'last: none recorded',
    });
    // A clean cycle reads no log at all.
    let reads = 0;
    expect(cycleFailureSignal({
      failures: 0,
      exitCode: 0,
      readExcerpt: () => { reads += 1; return 'never'; },
    })).toEqual({ excerpt: null, line: null });
    expect(reads).toBe(0);
    expect(cycleFailureSignal({
      failures: 1,
      exitCode: 1,
      readExcerpt: () => 'Error: HTTP 504',
    })).toEqual({ excerpt: 'Error: HTTP 504', line: null });
  });

  it('renders the streak in status and leaves a clean daemon byte-identical', () => {
    const cycle = daemonCycleStatus({
      metadata: { lastCycleStartedAt: '2026-09-02T18:09:45.000Z' },
      heartbeat: {
        schemaVersion: 1,
        pid: 4242,
        step: 'full reconciliation read',
        startedAt: '2026-09-02T18:10:45.000Z',
      },
      thresholdMs: 20 * MINUTE,
      nowMs: Date.parse('2026-09-02T18:13:45.000Z'),
    });

    expect(renderDaemonStatus({
      status: 'running',
      cycle: null,
      daemon: { ...metadata, consecutiveFailedCycles: 3, lastCycleFailureExcerpt: 'HTTP 504' },
    })).toBe('running (idle; last 3 cycles failed; last: HTTP 504)');
    expect(renderDaemonStatus({
      status: 'running',
      cycle,
      daemon: { ...metadata, consecutiveFailedCycles: 3, lastCycleFailureExcerpt: 'HTTP 504' },
    })).toBe(
      'running (cycle 4m; step: full reconciliation read 3m ago; '
      + 'last 3 cycles failed; last: HTTP 504)',
    );
    expect(renderDaemonStatus({
      status: 'running',
      cycle: null,
      daemon: { ...metadata, consecutiveFailedCycles: 1 },
    })).toBe('running (idle; last 1 cycle failed; last: none recorded)');

    // Streak zero, absent, or on a record written before #139: unchanged.
    expect(renderDaemonStatus({
      status: 'running',
      cycle: null,
      daemon: { ...metadata, consecutiveFailedCycles: 0 },
    })).toBe('running (idle)');
    expect(renderDaemonStatus({ status: 'running', cycle: null, daemon: metadata }))
      .toBe('running (idle)');
    expect(renderDaemonStatus({ status: 'running', cycle })).toBe(
      'running (cycle 4m; step: full reconciliation read 3m ago)',
    );
    // A hand-edited or truncated record renders as no streak, never as one.
    for (const corrupt of [-1, Number.NaN, 1.5, 'three' as unknown as number]) {
      expect(renderDaemonStatus({
        status: 'running',
        cycle: null,
        daemon: { ...metadata, consecutiveFailedCycles: corrupt },
      })).toBe('running (idle)');
    }
    for (const status of ['not-running', 'stale', 'stale-binary', 'unsafe']) {
      expect(renderDaemonStatus({
        status,
        cycle: null,
        daemon: { ...metadata, consecutiveFailedCycles: 5, lastCycleFailureExcerpt: 'HTTP 504' },
      })).toBe(status);
    }
  });

  it('carries the streak all the way to the line the CLI prints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-streak-status-'));
    // Exactly what bin/autopilot.ts does: serviceStatus's result, rendered.
    const status = await serviceStatus({
      loaded: loadedFixture(dir, dir),
      entryPath: '/dev/null',
      inspect: async () => ({
        classification: 'already-running',
        metadata: {
          ...metadata,
          lastCycleExitCode: 1,
          consecutiveFailedCycles: 4,
          lastCycleFailureExcerpt: 'Error: HTTP 504 from api.github.com',
        },
      }),
    });

    expect(status.daemon?.consecutiveFailedCycles).toBe(4);
    expect(`Daemon: ${renderDaemonStatus(status)}`).toBe(
      'Daemon: running (idle; last 4 cycles failed; '
      + 'last: Error: HTTP 504 from api.github.com)',
    );
  });

  it('still parses and classifies a daemon record written before the streak field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-old-record-'));
    writeFileSync(join(dir, 'daemon.json'), `${JSON.stringify({
      ...metadata,
      lastCycleStartedAt: '2026-09-02T18:09:45.000Z',
      lastCycleFinishedAt: '2026-09-02T18:12:45.000Z',
      lastCycleExitCode: 1,
    })}\n`, { mode: 0o600 });

    const record = readDaemonMetadata(loadedFixture(dir, dir))!;

    expect(record.lastCycleExitCode).toBe(1);
    expect(record.consecutiveFailedCycles).toBeUndefined();
    expect(record.lastCycleFailureExcerpt).toBeUndefined();
    expect(classifyDaemonRecord(record, {
      processAlive: true,
      processStartedAt: metadata.processStartedAt,
      repository: metadata.repository,
      executableFingerprint: metadata.executableFingerprint,
    })).toBe('already-running');
    expect(renderDaemonStatus({ status: 'running', cycle: null, daemon: record }))
      .toBe('running (idle)');
  });
});

describe('operator-visible cycle age and current step', () => {
  const started = '2026-09-02T18:09:45.000Z';

  it('reports no in-flight cycle once the last one has finished', () => {
    expect(daemonCycleStatus({
      metadata: {
        lastCycleStartedAt: started,
        lastCycleFinishedAt: '2026-09-02T18:12:45.000Z',
      },
      heartbeat: null,
      thresholdMs: 20 * MINUTE,
      nowMs: Date.parse('2026-09-02T18:20:00.000Z'),
    })).toBeNull();
    expect(daemonCycleStatus({
      metadata: {},
      heartbeat: null,
      thresholdMs: 20 * MINUTE,
      nowMs: Date.parse('2026-09-02T18:20:00.000Z'),
    })).toBeNull();
  });

  it('surfaces cycle age and current step instead of a bare running', () => {
    const cycle = daemonCycleStatus({
      metadata: { lastCycleStartedAt: started },
      heartbeat: {
        schemaVersion: 1,
        pid: 4242,
        step: 'worktree remove pr-3683',
        startedAt: '2026-09-02T18:23:45.000Z',
      },
      thresholdMs: 20 * MINUTE,
      nowMs: Date.parse('2026-09-02T18:44:45.000Z'),
    });

    expect(cycle).toEqual({
      startedAt: started,
      ageMs: 35 * MINUTE,
      thresholdMs: 20 * MINUTE,
      overdue: true,
      step: {
        step: 'worktree remove pr-3683',
        startedAt: '2026-09-02T18:23:45.000Z',
        ageMs: 21 * MINUTE,
      },
    });
    expect(renderDaemonStatus({ status: 'running', cycle })).toBe(
      'running (cycle 35m, over the 20m watchdog threshold; '
      + 'step: worktree remove pr-3683 21m ago)',
    );
  });

  it('renders a healthy in-flight cycle, a stepless one, and an idle daemon', () => {
    const healthy = daemonCycleStatus({
      metadata: { lastCycleStartedAt: started },
      heartbeat: {
        schemaVersion: 1,
        pid: 4242,
        step: 'full reconciliation read',
        startedAt: '2026-09-02T18:10:45.000Z',
      },
      thresholdMs: 20 * MINUTE,
      nowMs: Date.parse('2026-09-02T18:13:45.000Z'),
    });

    expect(renderDaemonStatus({ status: 'running', cycle: healthy })).toBe(
      'running (cycle 4m; step: full reconciliation read 3m ago)',
    );
    expect(renderDaemonStatus({
      status: 'running',
      cycle: daemonCycleStatus({
        metadata: { lastCycleStartedAt: started },
        heartbeat: null,
        thresholdMs: 20 * MINUTE,
        nowMs: Date.parse('2026-09-02T18:13:45.000Z'),
      }),
    })).toBe('running (cycle 4m; step: none recorded)');
    expect(renderDaemonStatus({ status: 'running', cycle: null }))
      .toBe('running (idle)');
    expect(renderDaemonStatus({ status: 'not-running' })).toBe('not-running');
    expect(renderDaemonStatus({ status: 'stale-binary', cycle: null }))
      .toBe('stale-binary');
  });
});

function loadedFixture(serviceDir: string, logsDir: string): LoadedAutopilotConfig {
  return {
    configPath: join(serviceDir, 'config.json'),
    repositoryRoot: serviceDir,
    stateKey: 'octo-labs-widget-test',
    config: {
      repository: { slug: metadata.repository },
      scheduler: { pollSeconds: 600 },
    },
    paths: {
      root: serviceDir,
      credentials: join(serviceDir, 'credentials.json'),
      runtime: join(serviceDir, 'runtime.json'),
      capabilityAttestation: join(serviceDir, 'capability-attestation.json'),
      state: join(serviceDir, 'state'),
      attempts: join(serviceDir, 'attempts'),
      logs: logsDir,
      service: serviceDir,
    },
  } as unknown as LoadedAutopilotConfig;
}

describe('operator exit when the live daemon is only a binary drift', () => {
  it('lets a plain stop proceed via the recorded socket on binary-drift', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-stop-socket-'));
    const socketPath = join(dir, 'control.sock');
    const received: string[] = [];
    const server = createServer((connection) => {
      let message = '';
      connection.setEncoding('utf8');
      connection.on('data', (chunk: string) => { message += chunk; });
      connection.on('end', () => {
        received.push(message.trim());
        connection.end('stopping\n');
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });

    try {
      const loaded = loadedFixture(dir, dir);
      const result = await stopService({
        loaded,
        entryPath: '/dev/null',
        force: false,
        inspect: async () => ({
          classification: 'binary-drift',
          metadata: { ...metadata, socketPath },
        }),
      });

      expect(result).toEqual({ status: 'stopping' });
      expect(received).toEqual(['stop']);
    } finally {
      server.close();
    }
  });

  it('lets --force kill a live daemon whose only drift is the on-disk binary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-stop-force-'));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const exited = new Promise<boolean>((resolve) => {
      child.once('exit', () => resolve(true));
    });

    try {
      const loaded = loadedFixture(dir, dir);
      const result = await stopService({
        loaded,
        entryPath: '/dev/null',
        force: true,
        inspect: async () => ({
          classification: 'binary-drift',
          metadata: { ...metadata, pid: child.pid! },
        }),
      });

      expect(result).toEqual({ status: 'forced' });
      await expect(Promise.race([
        exited,
        new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), 2_000); }),
      ])).resolves.toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('still refuses both plain and forced stop on a genuine identity mismatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-stop-refuse-'));
    const loaded = loadedFixture(dir, dir);
    const inspect = async () => ({
      classification: 'unsafe-live-mismatch' as const,
      metadata,
    });

    await expect(stopService({
      loaded, entryPath: '/dev/null', force: false, inspect,
    })).rejects.toThrow(
      'Refusing to signal a live PID whose daemon identity does not match',
    );
    await expect(stopService({
      loaded, entryPath: '/dev/null', force: true, inspect,
    })).rejects.toThrow(
      'Refusing to signal a live PID whose daemon identity does not match',
    );
  });

  it('never reports a dead engine child\'s recorded step as the current one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-status-heartbeat-'));
    const dead = spawn(process.execPath, ['-e', '']);
    await new Promise<void>((resolve) => { dead.once('exit', () => resolve()); });
    const startedAt = new Date(Date.now() - 90_000).toISOString();
    writeFileSync(cycleHeartbeatPath(dir), `${JSON.stringify({
      schemaVersion: 1,
      pid: dead.pid!,
      step: 'worktree remove pr-3683',
      startedAt,
    })}\n`, { mode: 0o600 });

    const status = await serviceStatus({
      loaded: loadedFixture(dir, dir),
      entryPath: '/dev/null',
      inspect: async () => ({
        classification: 'already-running',
        metadata: { ...metadata, lastCycleStartedAt: startedAt },
      }),
    });

    expect(status.status).toBe('running');
    expect(status.cycle?.step).toBeNull();
    expect(status.cycle?.ageMs).toBeGreaterThanOrEqual(90_000);
    expect(renderDaemonStatus(status)).toMatch(
      /^running \(cycle \d+[ms]; step: none recorded\)$/,
    );
  });

  it('refuses to auto-replace on binary-drift with an actionable message', async () => {
    const serviceDir = mkdtempSync(join(tmpdir(), 'autopilot-start-service-'));
    const logsDir = mkdtempSync(join(tmpdir(), 'autopilot-start-logs-'));
    const loaded = loadedFixture(serviceDir, logsDir);

    await expect(startService({
      loaded,
      entryPath: '/dev/null',
      foreground: false,
      doctor: async () => ({ schemaVersion: 1, blocking: false, checks: [] }),
      inspect: async () => ({ classification: 'binary-drift', metadata }),
    })).rejects.toThrow(
      'Live daemon predates the current build; run autopilot stop (or stop --force) first',
    );
  });
});

const HEALED_START_TIME = 'Wed Sep  2 23:14:53 2026';

/** Mirrors `requestControl`: one connection, one message, read the answer. */
async function sendControl(socketPath: string, message: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const connection = createConnection(socketPath);
    let output = '';
    connection.setEncoding('utf8');
    connection.once('error', reject);
    connection.on('data', (chunk: string) => { output += chunk; });
    connection.on('end', () => resolve(output));
    connection.end(message);
  });
}

async function waitForRecord(
  loaded: LoadedAutopilotConfig,
  matches: (record: DaemonMetadata) => boolean,
  timeoutMs = 15_000,
): Promise<DaemonMetadata> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let record: DaemonMetadata | null = null;
    try {
      record = readDaemonMetadata(loaded);
    } catch {
      record = null;
    }
    if (record !== null && matches(record)) return record;
    await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
  }
  throw new Error('daemon record never reached the expected shape');
}

/**
 * A daemon whose `ps` fails its first two calls (the startup read that writes
 * the fallback, then the first cycle boundary's heal attempt) and succeeds
 * afterwards — the exact shape of a transiently unreadable `ps`.
 */
function fallbackDaemonFixture(dir: string, failingCalls: number): {
  readonly loaded: LoadedAutopilotConfig;
  readonly entryPath: string;
  readonly binDirectory: string;
  readonly psCallsPath: string;
} {
  const binDirectory = join(dir, 'bin');
  mkdirSync(binDirectory, { mode: 0o700 });
  const counter = join(dir, 'ps-calls');
  // Shell builtins only: the daemon under test runs with a PATH holding
  // nothing but this shim, so `cat` and friends are not on it.
  writeFileSync(join(binDirectory, 'ps'), [
    '#!/bin/sh',
    'count=0',
    `[ -f '${counter}' ] && read count < '${counter}'`,
    'count=$((count + 1))',
    `printf '%s\\n' "$count" > '${counter}'`,
    `[ "$count" -le ${failingCalls} ] && exit 1`,
    `printf '%s\\n' '${HEALED_START_TIME}'`,
    '',
  ].join('\n'), { mode: 0o755 });
  const entryPath = join(dir, 'engine-child.mjs');
  writeFileSync(entryPath, 'process.exit(0);\n', { mode: 0o700 });
  writeFileSync(join(dir, 'config.json'), '{"schemaVersion":1}\n', { mode: 0o600 });
  return {
    loaded: {
      ...loadedFixture(dir, dir),
      config: {
        repository: { slug: metadata.repository },
        scheduler: { pollSeconds: 1 },
      },
    } as unknown as LoadedAutopilotConfig,
    entryPath,
    binDirectory,
    psCallsPath: counter,
  };
}

describe('the start-time fallback is transient, not permanent', () => {
  it('treats only the record\'s own pid-<pid> string as the fallback form', () => {
    expect(isStartTimeFallback({ pid: 36859, processStartedAt: 'pid-36859' }))
      .toBe(true);
    expect(isStartTimeFallback(metadata)).toBe(false);
    // A record naming some other pid is not this record's fallback: it is
    // malformed, and the guard must keep refusing it.
    expect(isStartTimeFallback({ pid: 36859, processStartedAt: 'pid-999' }))
      .toBe(false);
    expect(isStartTimeFallback({ pid: 36859, processStartedAt: 'pid-' }))
      .toBe(false);
  });

  it('heals the fallback at the first boundary whose ps read succeeds', async () => {
    const readings: readonly (string | null)[] = [null, HEALED_START_TIME, null];
    let calls = 0;
    let record: DaemonMetadata = {
      ...metadata,
      pid: 36859,
      processStartedAt: 'pid-36859',
    };
    let attemptsSpent = 0;

    for (let boundary = 0; boundary < START_TIME_FALLBACK_HEAL_ATTEMPTS; boundary += 1) {
      const heal = await healStartTimeFallback({
        record,
        attemptsSpent,
        read: async () => {
          const reading = readings[calls] ?? null;
          calls += 1;
          return reading;
        },
      });
      attemptsSpent = heal.attemptsSpent;
      if (heal.processStartedAt !== null) {
        record = { ...record, processStartedAt: heal.processStartedAt };
      }
    }

    expect(record.processStartedAt).toBe(HEALED_START_TIME);
    expect(isStartTimeFallback(record)).toBe(false);
    // Once healed the daemon stops paying for `ps` at every boundary.
    expect(calls).toBe(2);
    expect(record.startedAt).toBe(metadata.startedAt);
  });

  it('never touches a record that already carries a real start time', async () => {
    let calls = 0;
    const heal = await healStartTimeFallback({
      record: metadata,
      attemptsSpent: 0,
      read: async () => { calls += 1; return HEALED_START_TIME; },
    });

    expect(heal).toEqual({ attemptsSpent: 0, processStartedAt: null });
    expect(calls).toBe(0);
  });

  it('gives up silently after three boundaries when ps never becomes readable', async () => {
    let calls = 0;
    const record = { ...metadata, pid: 36859, processStartedAt: 'pid-36859' };
    let attemptsSpent = 0;

    for (let boundary = 0; boundary < 6; boundary += 1) {
      const heal = await healStartTimeFallback({
        record,
        attemptsSpent,
        read: async () => {
          calls += 1;
          throw new Error('spawn ps ENOENT');
        },
      });
      attemptsSpent = heal.attemptsSpent;
      expect(heal.processStartedAt).toBeNull();
    }

    expect(START_TIME_FALLBACK_HEAL_ATTEMPTS).toBe(3);
    expect(calls).toBe(START_TIME_FALLBACK_HEAL_ATTEMPTS);
    expect(attemptsSpent).toBe(START_TIME_FALLBACK_HEAL_ATTEMPTS);
    expect(record.processStartedAt).toBe('pid-36859');
  });

  it('upgrades a live daemon\'s own record once ps becomes readable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-heal-daemon-'));
    const fixture = fallbackDaemonFixture(dir, 2);
    const previousPath = process.env.PATH;
    process.env.PATH = fixture.binDirectory;
    let daemon: Promise<void> | null = null;

    try {
      daemon = runDaemon({
        loaded: fixture.loaded,
        entryPath: fixture.entryPath,
        environment: { PATH: fixture.binDirectory },
      });
      const started = await waitForRecord(fixture.loaded, () => true);
      expect(started.processStartedAt).toBe(`pid-${process.pid}`);
      expect(isStartTimeFallback(started)).toBe(true);

      const healed = await waitForRecord(
        fixture.loaded,
        (record) => !isStartTimeFallback(record),
      );

      expect(healed.processStartedAt).toBe(HEALED_START_TIME);
      expect(healed.pid).toBe(process.pid);
      expect(healed.startedAt).toBe(started.startedAt);
      expect(healed.socketPath).toBe(started.socketPath);
    } finally {
      process.env.PATH = previousPath;
      if (daemon !== null) {
        const record = readDaemonMetadata(fixture.loaded);
        if (record !== null) await sendControl(record.socketPath, 'stop');
        await daemon;
      }
    }
  }, 30_000);
});

const fallbackRecord: DaemonMetadata = {
  ...metadata,
  processStartedAt: `pid-${metadata.pid}`,
};

/** The answer a live daemon gives an `identity` control request. */
function identityAnswer(
  overrides: Record<string, unknown> = {},
  record: DaemonMetadata = fallbackRecord,
): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    pid: record.pid,
    startedAt: record.startedAt,
    repository: record.repository,
    executableFingerprint: record.executableFingerprint,
    ...overrides,
  })}\n`;
}

async function controlSocketStub(
  socketPath: string,
  answers: Record<string, string | null>,
): Promise<{
  readonly received: string[];
  readonly close: () => void;
}> {
  const received: string[] = [];
  const server = createServer((connection) => {
    let message = '';
    connection.setEncoding('utf8');
    connection.on('data', (chunk: string) => { message += chunk; });
    connection.on('end', () => {
      const request = message.trim();
      received.push(request);
      // A null answer is the silent daemon: the socket closes saying nothing.
      const answer = answers[request];
      if (answer == null) connection.end();
      else connection.end(answer);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return { received, close: () => server.close() };
}

function spawnLiveProcess(): {
  readonly child: ReturnType<typeof spawn>;
  readonly exited: Promise<boolean>;
} {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  return {
    child,
    exited: new Promise<boolean>((resolve) => {
      child.once('exit', () => resolve(true));
    }),
  };
}

async function exitedWithin(exited: Promise<boolean>, ms: number): Promise<boolean> {
  return Promise.race([
    exited,
    new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), ms); }),
  ]);
}

describe('control-socket identity is the fallback record\'s second channel', () => {
  it('lets a plain stop proceed when the socket answers the record\'s identity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-identity-stop-'));
    const socketPath = join(dir, 'control.sock');
    const stub = await controlSocketStub(socketPath, {
      identity: identityAnswer(),
      stop: 'stopping\n',
    });

    try {
      const result = await stopService({
        loaded: loadedFixture(dir, dir),
        entryPath: '/dev/null',
        force: false,
        inspect: async () => ({
          classification: 'unsafe-live-mismatch',
          metadata: { ...fallbackRecord, socketPath },
          startTimeFallback: true,
        }),
      });

      expect(result).toEqual({ status: 'stopping' });
      expect(stub.received).toEqual(['identity', 'stop']);
    } finally {
      stub.close();
    }
  });

  it('lets --force signal a fallback-record daemon the socket confirms', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-identity-force-'));
    const socketPath = join(dir, 'control.sock');
    const live = spawnLiveProcess();
    const record: DaemonMetadata = {
      ...fallbackRecord,
      pid: live.child.pid!,
      processStartedAt: `pid-${live.child.pid!}`,
      socketPath,
    };
    const stub = await controlSocketStub(socketPath, {
      identity: identityAnswer({ pid: record.pid }, record),
    });

    try {
      const result = await stopService({
        loaded: loadedFixture(dir, dir),
        entryPath: '/dev/null',
        force: true,
        inspect: async () => ({
          classification: 'unsafe-live-mismatch',
          metadata: record,
          startTimeFallback: true,
        }),
      });

      expect(result).toEqual({ status: 'forced' });
      expect(stub.received).toEqual(['identity']);
      await expect(exitedWithin(live.exited, 2_000)).resolves.toBe(true);
    } finally {
      stub.close();
      live.child.kill('SIGKILL');
    }
  });

  it('still refuses a pid whose socket answers a different start time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-identity-reuse-'));
    const socketPath = join(dir, 'control.sock');
    const live = spawnLiveProcess();
    const record: DaemonMetadata = {
      ...fallbackRecord,
      pid: live.child.pid!,
      processStartedAt: `pid-${live.child.pid!}`,
      socketPath,
    };
    // The pid-reuse shape: the recorded pid is alive and something is
    // listening, but it started at a different time — a different process.
    const stub = await controlSocketStub(socketPath, {
      identity: identityAnswer(
        { pid: record.pid, startedAt: '2026-09-03T06:00:00.000Z' },
        record,
      ),
    });
    const inspect = async () => ({
      classification: 'unsafe-live-mismatch' as const,
      metadata: record,
      startTimeFallback: true,
    });

    try {
      const loaded = loadedFixture(dir, dir);
      await expect(stopService({
        loaded, entryPath: '/dev/null', force: false, inspect,
      })).rejects.toThrow(
        'Refusing to signal a live PID whose daemon identity does not match',
      );
      await expect(stopService({
        loaded, entryPath: '/dev/null', force: true, inspect,
      })).rejects.toThrow(
        'Refusing to signal a live PID whose daemon identity does not match',
      );

      expect(await exitedWithin(live.exited, 250)).toBe(false);
    } finally {
      stub.close();
      live.child.kill('SIGKILL');
    }
  });

  it('still refuses when the socket answers for a different repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-identity-repository-'));
    const socketPath = join(dir, 'control.sock');
    const stub = await controlSocketStub(socketPath, {
      identity: identityAnswer({ repository: 'Octo-Labs/other' }),
    });

    try {
      await expect(stopService({
        loaded: loadedFixture(dir, dir),
        entryPath: '/dev/null',
        force: false,
        inspect: async () => ({
          classification: 'unsafe-live-mismatch',
          metadata: { ...fallbackRecord, socketPath },
          startTimeFallback: true,
        }),
      })).rejects.toThrow(
        'Refusing to signal a live PID whose daemon identity does not match',
      );
    } finally {
      stub.close();
    }
  });

  it('fails closed on a silent, malformed or missing control socket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-identity-closed-'));
    const answers: readonly (string | null)[] = [
      null,
      'unknown command\n',
      '{"schemaVersion":1,"pid":4242}\n',
      'not json at all\n',
      identityAnswer({ schemaVersion: 2 }),
    ];

    for (const [index, answer] of answers.entries()) {
      const socketPath = join(dir, `control-${index}.sock`);
      const stub = await controlSocketStub(socketPath, { identity: answer });
      try {
        await expect(stopService({
          loaded: loadedFixture(dir, dir),
          entryPath: '/dev/null',
          force: true,
          inspect: async () => ({
            classification: 'unsafe-live-mismatch',
            metadata: { ...fallbackRecord, socketPath },
            startTimeFallback: true,
          }),
        })).rejects.toThrow(
          'Refusing to signal a live PID whose daemon identity does not match',
        );
      } finally {
        stub.close();
      }
    }

    // No socket at all — the daemon died, or never listened.
    await expect(stopService({
      loaded: loadedFixture(dir, dir),
      entryPath: '/dev/null',
      force: true,
      inspect: async () => ({
        classification: 'unsafe-live-mismatch',
        metadata: { ...fallbackRecord, socketPath: join(dir, 'absent.sock') },
        startTimeFallback: true,
      }),
    })).rejects.toThrow(
      'Refusing to signal a live PID whose daemon identity does not match',
    );
  });

  it('never asks the socket about a genuine identity mismatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-identity-genuine-'));
    const socketPath = join(dir, 'control.sock');
    // A socket that would confirm anything: the record still carries a real
    // `ps` reading that did not match, so the guard must not even ask.
    const stub = await controlSocketStub(socketPath, {
      identity: identityAnswer({}, metadata),
      stop: 'stopping\n',
    });

    try {
      await expect(stopService({
        loaded: loadedFixture(dir, dir),
        entryPath: '/dev/null',
        force: false,
        inspect: async () => ({
          classification: 'unsafe-live-mismatch',
          metadata: { ...metadata, socketPath },
        }),
      })).rejects.toThrow(
        'Refusing to signal a live PID whose daemon identity does not match',
      );

      expect(stub.received).toEqual([]);
    } finally {
      stub.close();
    }
  });

  it('refuses to replace a live daemon the control socket verifies', async () => {
    const serviceDir = mkdtempSync(join(tmpdir(), 'autopilot-identity-start-'));
    const logsDir = mkdtempSync(join(tmpdir(), 'autopilot-identity-start-logs-'));
    const socketPath = join(serviceDir, 'control.sock');
    const stub = await controlSocketStub(socketPath, {
      identity: identityAnswer(),
    });
    const start = (startTimeFallback: boolean) => startService({
      loaded: loadedFixture(serviceDir, logsDir),
      entryPath: '/dev/null',
      foreground: false,
      doctor: async () => ({ schemaVersion: 1, blocking: false, checks: [] }),
      inspect: async () => ({
        classification: 'unsafe-live-mismatch',
        metadata: { ...fallbackRecord, socketPath },
        startTimeFallback,
      }),
    });

    try {
      await expect(start(true)).rejects.toThrow(
        'Live daemon verified through its control socket; '
        + 'run autopilot stop (or stop --force) first',
      );
      await expect(start(false)).rejects.toThrow(
        'Recorded daemon PID is live but its identity does not match; '
        + 'refusing replacement',
      );
    } finally {
      stub.close();
    }
  });

  it('marks only a solely-fallback record as socket-verifiable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-identity-inspect-'));
    const entryPath = join(dir, 'entry.mjs');
    writeFileSync(entryPath, 'export default 1;\n', { mode: 0o600 });
    const live = spawnLiveProcess();
    const loaded = loadedFixture(dir, dir);
    const inspectWith = async (record: Partial<DaemonMetadata>) => {
      writeFileSync(join(dir, 'daemon.json'), `${JSON.stringify({
        ...fallbackRecord,
        pid: live.child.pid!,
        processStartedAt: `pid-${live.child.pid!}`,
        ...record,
      })}\n`, { mode: 0o600 });
      return inspectDaemon({ loaded, entryPath });
    };

    try {
      const fallback = await inspectWith({});
      expect(fallback.classification).toBe('unsafe-live-mismatch');
      expect(fallback.startTimeFallback).toBe(true);

      // A record carrying a real (but wrong) reading is the pid-reuse case the
      // guard exists for, and a fallback for a different repository is not
      // "solely" the fallback either.
      const genuine = await inspectWith({
        processStartedAt: 'Thu Jul 23 23:00:00 2026',
      });
      expect(genuine.classification).toBe('unsafe-live-mismatch');
      expect(genuine.startTimeFallback).toBe(false);

      const foreign = await inspectWith({ repository: 'Octo-Labs/other' });
      expect(foreign.classification).toBe('unsafe-live-mismatch');
      expect(foreign.startTimeFallback).toBe(false);
    } finally {
      live.child.kill('SIGKILL');
    }
  });

  it('tells the operator the record is unverifiable instead of just "unsafe"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-identity-status-'));
    const loaded = loadedFixture(dir, dir);

    const unverifiable = await serviceStatus({
      loaded,
      entryPath: '/dev/null',
      inspect: async () => ({
        classification: 'unsafe-live-mismatch',
        metadata: fallbackRecord,
        startTimeFallback: true,
      }),
    });

    expect(unverifiable.status).toBe('unverifiable-fallback');
    expect(unverifiable.daemon).toEqual(fallbackRecord);
    expect(`Daemon: ${renderDaemonStatus(unverifiable)}`).toBe(
      'Daemon: running but unverifiable (start-time fallback in record; '
      + 'stop will verify via the control socket)',
    );

    // Every other verdict keeps the byte it printed before.
    const unsafe = await serviceStatus({
      loaded,
      entryPath: '/dev/null',
      inspect: async () => ({
        classification: 'unsafe-live-mismatch',
        metadata,
      }),
    });

    expect(unsafe.status).toBe('unsafe');
    expect(renderDaemonStatus(unsafe)).toBe('unsafe');
  });

  it('answers identity from a live daemon that never healed its record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-identity-daemon-'));
    const fixture = fallbackDaemonFixture(dir, 99);
    const previousPath = process.env.PATH;
    process.env.PATH = fixture.binDirectory;
    let daemon: Promise<void> | null = null;

    try {
      daemon = runDaemon({
        loaded: fixture.loaded,
        entryPath: fixture.entryPath,
        environment: { PATH: fixture.binDirectory },
      });
      const record = await waitForRecord(fixture.loaded, () => true);
      expect(isStartTimeFallback(record)).toBe(true);

      const answer = await sendControl(record.socketPath, 'identity');

      expect(JSON.parse(answer)).toEqual({
        schemaVersion: 1,
        pid: record.pid,
        startedAt: record.startedAt,
        repository: record.repository,
        executableFingerprint: record.executableFingerprint,
      });
      expect(await sendControl(record.socketPath, 'wat')).toBe('unknown command\n');

      // Past the third boundary the daemon stops re-reading `ps` and keeps
      // running with the fallback: bounded, silent, still answering identity.
      await waitForRecord(
        fixture.loaded,
        (current) => Date.parse(current.lastCycleStartedAt ?? '')
          > Date.parse(record.startedAt) + 3_000,
      );
      const unhealed = readDaemonMetadata(fixture.loaded)!;

      expect(isStartTimeFallback(unhealed)).toBe(true);
      expect(readFileSync(fixture.psCallsPath, 'utf8').trim())
        .toBe(String(1 + START_TIME_FALLBACK_HEAL_ATTEMPTS));
      expect(JSON.parse(await sendControl(record.socketPath, 'identity')))
        .toMatchObject({ pid: record.pid, startedAt: record.startedAt });
    } finally {
      process.env.PATH = previousPath;
      if (daemon !== null) {
        const record = readDaemonMetadata(fixture.loaded);
        if (record !== null) await sendControl(record.socketPath, 'stop');
        await daemon;
      }
    }
  }, 30_000);
});
