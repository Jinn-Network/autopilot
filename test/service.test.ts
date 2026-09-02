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
  cycleWatchdogLine,
  cycleWatchdogThresholdMs,
  daemonActiveOnceEnvironment,
  daemonCycleStatus,
  formatCycleDuration,
  INTERNAL_DAEMON_ACTIVE_ONCE_ENV,
  MIN_CYCLE_WATCHDOG_MS,
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
