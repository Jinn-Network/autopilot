import { describe, expect, it } from 'vitest';
import {
  classifyDaemonRecord,
  serviceSocketPath,
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

  it('refuses to signal or replace a live PID whose process fingerprint differs', () => {
    expect(classifyDaemonRecord(metadata, {
      processAlive: true,
      processStartedAt: 'Thu Jul 23 22:59:00 2026',
      repository: metadata.repository,
      executableFingerprint: metadata.executableFingerprint,
    })).toBe('unsafe-live-mismatch');
    expect(classifyDaemonRecord(metadata, {
      processAlive: true,
      processStartedAt: metadata.processStartedAt,
      repository: metadata.repository,
      executableFingerprint: 'sha256:other',
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
});
