import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
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
  INTERNAL_DAEMON_ACTIVE_ONCE_ENV,
  MIN_CYCLE_WATCHDOG_MS,
  nextConsecutiveFailedCycles,
  readCycleFailureExcerpt,
  readDaemonMetadata,
  renderDaemonStatus,
  serviceSocketPath,
  serviceStatus,
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
