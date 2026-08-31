import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LoadedAutopilotConfig } from '../src/config/config.js';
import {
  classifyDaemonRecord,
  completeDaemonCycle,
  daemonActiveOnceEnvironment,
  INTERNAL_DAEMON_ACTIVE_ONCE_ENV,
  serviceSocketPath,
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

function loadedFixture(serviceDir: string, logsDir: string): LoadedAutopilotConfig {
  return {
    config: { repository: { slug: metadata.repository } },
    configPath: join(serviceDir, 'config.json'),
    repositoryRoot: serviceDir,
    stateKey: 'octo-labs-widget-test',
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
