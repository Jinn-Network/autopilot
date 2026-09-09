import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decodeAttemptManifest,
  listHostAttemptFootprints,
  listHostLiveAttempts,
  markAttemptExited,
  measureWorktreeBytes,
  readAttemptManifest,
  sampleAttemptWorktreePeak,
  sampleHostAttemptFootprints,
  type AttemptManifest,
} from '../../src/lifecycle/attempt-workspace.js';

const OID = 'a'.repeat(40);
const HASH = '0'.repeat(64);
const UUID = '11111111-2222-4333-8444-555555555555';

function manifestFixture(
  root: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const attemptDir = join(root, 'attempt');
  return {
    version: 2,
    attemptId: UUID,
    runnerId: 'runner-1',
    host: 'host-1',
    phase: 'implement',
    execution: { backend: 'local' },
    subject: 'issue-7',
    issueNumber: 7,
    branch: 'jinn/issue-7',
    targetBase: 'main',
    expectedHead: OID,
    claimOid: OID,
    selectedLogin: 'bot',
    repository: {
      root,
      gitCommonDir: join(root, '.git'),
      remoteName: 'origin',
      remoteUrlHash: HASH,
    },
    processState: 'preparing',
    pid: null,
    paths: {
      attemptDir,
      worktree: join(attemptDir, 'worktree'),
      manifest: join(attemptDir, 'manifest.json'),
      log: join(attemptDir, 'session.log'),
      ghConfigDir: join(attemptDir, 'gh-config'),
      askpass: join(attemptDir, 'askpass'),
      tokenFile: join(attemptDir, 'gh-token'),
    },
    timestamps: {
      createdAt: '2026-09-03T10:00:00.000Z',
      updatedAt: '2026-09-03T10:00:00.000Z',
    },
    ...overrides,
  };
}

describe('attempt worktree footprint', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'attempt-footprint-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('measures a worktree with a bounded recursive walk', () => {
    const worktree = join(root, 'worktree');
    mkdirSync(join(worktree, 'src', 'deep'), { recursive: true });
    writeFileSync(join(worktree, 'top.txt'), 'x'.repeat(1000));
    writeFileSync(join(worktree, 'src', 'mid.txt'), 'x'.repeat(2000));
    writeFileSync(join(worktree, 'src', 'deep', 'leaf.txt'), 'x'.repeat(3000));
    const measured = measureWorktreeBytes(worktree);
    expect(measured).not.toBeNull();
    // Block-rounded, so at least the logical bytes and never absurdly more.
    expect(measured!).toBeGreaterThanOrEqual(6000);
    expect(measured!).toBeLessThan(6000 + 64 * 1024);
  });

  it('reports an absent worktree as zero and never throws', () => {
    expect(measureWorktreeBytes(join(root, 'never-created'))).toBe(0);
  });

  it('gives up rather than under-report when the entry budget is spent', () => {
    const worktree = join(root, 'worktree');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, 'a.txt'), 'a');
    writeFileSync(join(worktree, 'b.txt'), 'b');
    writeFileSync(join(worktree, 'c.txt'), 'c');
    expect(measureWorktreeBytes(worktree, 2)).toBeNull();
  });

  it('decodes a manifest that carries worktreeBytes', () => {
    const manifest = decodeAttemptManifest(
      manifestFixture(root, { worktreeBytes: 6_500_000_000 }),
    );
    expect(manifest.worktreeBytes).toBe(6_500_000_000);
  });

  it('decodes a legacy manifest without worktreeBytes unchanged', () => {
    const manifest = decodeAttemptManifest(manifestFixture(root));
    expect(manifest.worktreeBytes).toBeUndefined();
    expect(Object.hasOwn(manifest, 'worktreeBytes')).toBe(false);
  });

  it('rejects a negative or fractional worktreeBytes', () => {
    expect(() => decodeAttemptManifest(
      manifestFixture(root, { worktreeBytes: -1 }),
    )).toThrow('Invalid worktree bytes');
    expect(() => decodeAttemptManifest(
      manifestFixture(root, { worktreeBytes: 1.5 }),
    )).toThrow('Invalid worktree bytes');
  });

  it('records the measured worktree size when an attempt exits', () => {
    const attemptDir = join(root, 'attempt');
    const worktree = join(attemptDir, 'worktree');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, 'payload.bin'), 'y'.repeat(4096));
    const manifestPath = join(attemptDir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifestFixture(root, {
      processState: 'running',
      pid: process.pid,
      timestamps: {
        createdAt: '2026-09-03T10:00:00.000Z',
        updatedAt: '2026-09-03T10:00:00.000Z',
        childStartedAt: '2026-09-03T10:00:00.000Z',
      },
    })));
    const exited = markAttemptExited(manifestPath);
    expect(exited.processState).toBe('exited');
    expect(exited.worktreeBytes).toBeGreaterThanOrEqual(4096);
    expect(readAttemptManifest(manifestPath).worktreeBytes)
      .toBe(exited.worktreeBytes);
  });

  it('omits worktreeBytes when the worktree cannot be measured', () => {
    const attemptDir = join(root, 'attempt');
    mkdirSync(attemptDir, { recursive: true });
    const manifestPath = join(attemptDir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifestFixture(root, {
      processState: 'running',
      pid: process.pid,
      timestamps: {
        createdAt: '2026-09-03T10:00:00.000Z',
        updatedAt: '2026-09-03T10:00:00.000Z',
        childStartedAt: '2026-09-03T10:00:00.000Z',
      },
    })));
    const exited = markAttemptExited(manifestPath, undefined, undefined, () => null);
    expect(exited.processState).toBe('exited');
    expect(exited.worktreeBytes).toBeUndefined();
  });

  it('lists this host\'s recorded footprints newest last, ignoring others', () => {
    const v2Base = join(root, 'v2');
    const write = (
      runnerId: string,
      phase: string,
      name: string,
      overrides: Record<string, unknown>,
    ): void => {
      const attemptDir = join(v2Base, runnerId, phase, name);
      mkdirSync(attemptDir, { recursive: true });
      writeFileSync(
        join(attemptDir, 'manifest.json'),
        JSON.stringify(manifestFixture(root, { runnerId, phase, ...overrides })),
      );
    };
    write('runner-1', 'implement', 'issue-7-a', {
      worktreeBytes: 1000,
      timestamps: {
        createdAt: '2026-09-03T09:00:00.000Z',
        updatedAt: '2026-09-03T09:00:00.000Z',
      },
    });
    write('runner-2', 'implement', 'issue-7-b', {
      worktreeBytes: 2000,
      timestamps: {
        createdAt: '2026-09-03T11:00:00.000Z',
        updatedAt: '2026-09-03T11:00:00.000Z',
      },
    });
    // Another host's attempt never informs this host's projection.
    write('runner-3', 'implement', 'issue-7-c', {
      host: 'host-2',
      worktreeBytes: 9000,
      timestamps: {
        createdAt: '2026-09-03T12:00:00.000Z',
        updatedAt: '2026-09-03T12:00:00.000Z',
      },
    });
    // No recorded size: nothing to learn from.
    write('runner-1', 'implement', 'issue-7-d', {});
    const footprints = listHostAttemptFootprints(v2Base, 'host-1');
    expect(footprints).toEqual([
      { phase: 'implement', worktreeBytes: 1000, endedAtMs: Date.parse('2026-09-03T09:00:00.000Z') },
      { phase: 'implement', worktreeBytes: 2000, endedAtMs: Date.parse('2026-09-03T11:00:00.000Z') },
    ]);
  });

  it('lists every live attempt on this host, whichever runner owns it', () => {
    const v2Base = join(root, 'v2');
    const write = (
      runnerId: string,
      name: string,
      overrides: Record<string, unknown>,
    ): void => {
      const attemptDir = join(v2Base, runnerId, 'implement', name);
      mkdirSync(attemptDir, { recursive: true });
      writeFileSync(
        join(attemptDir, 'manifest.json'),
        JSON.stringify(manifestFixture(root, { runnerId, ...overrides })),
      );
    };
    write('runner-1', 'issue-7-a', { processState: 'preparing', pid: null });
    // Another runner, same disk: its worktree costs this host exactly as much.
    write('runner-2', 'issue-7-b', { processState: 'preparing', pid: null });
    write('runner-1', 'issue-7-c', {
      host: 'host-2',
      processState: 'preparing',
      pid: null,
    });
    write('runner-1', 'issue-7-d', {
      processState: 'exited',
      pid: 4242,
      timestamps: {
        createdAt: '2026-09-03T10:00:00.000Z',
        updatedAt: '2026-09-03T10:05:00.000Z',
        childStartedAt: '2026-09-03T10:00:00.000Z',
        childExitedAt: '2026-09-03T10:05:00.000Z',
      },
    });
    const live = listHostLiveAttempts(v2Base, 'host-1', () => false);
    expect(live.map((manifest) => manifest.runnerId).sort())
      .toEqual(['runner-1', 'runner-2']);
  });

  it('keeps a decoded manifest assignable to the interface', () => {
    const manifest: AttemptManifest = decodeAttemptManifest(
      manifestFixture(root, { worktreeBytes: 10 }),
    );
    expect(manifest.phase).toBe('implement');
  });
});

describe('footprint history survives the sweep (#155)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'attempt-footprint-history-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeRunning(v2Base: string, name: string, attemptId: string): string {
    const attemptDir = join(v2Base, 'runner-1', 'implement', name);
    mkdirSync(join(attemptDir, 'worktree'), { recursive: true });
    writeFileSync(join(attemptDir, 'worktree', 'file'), 'x'.repeat(64));
    const manifestPath = join(attemptDir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifestFixture(root, {
      attemptId,
      processState: 'running',
      pid: process.pid,
      timestamps: {
        createdAt: '2026-09-04T19:00:00.000Z',
        updatedAt: '2026-09-04T19:00:00.000Z',
        childStartedAt: '2026-09-04T19:00:00.000Z',
      },
      paths: {
        attemptDir,
        worktree: join(attemptDir, 'worktree'),
        manifest: manifestPath,
        log: join(attemptDir, 'session.log'),
        ghConfigDir: join(attemptDir, 'gh-config'),
        askpass: join(attemptDir, 'askpass'),
        tokenFile: join(attemptDir, 'gh-token'),
      },
    })));
    return manifestPath;
  }

  it('still reports an attempt whose manifest the sweep has removed', () => {
    const v2Base = join(root, 'attempts', 'v2');
    const manifestPath = writeRunning(v2Base, 'issue-7-a', 'aaaaaaaa-2222-4333-8444-555555555555');
    markAttemptExited(manifestPath, () => new Date('2026-09-04T20:00:00.000Z'), undefined, () => 4096);
    rmSync(join(v2Base, 'runner-1', 'implement', 'issue-7-a'), { recursive: true, force: true });
    expect(listHostAttemptFootprints(v2Base, 'host-1')).toEqual([
      { phase: 'implement', worktreeBytes: 4096, endedAtMs: Date.parse('2026-09-04T20:00:00.000Z') },
    ]);
  });

  it('counts an attempt once while its manifest is still on disk', () => {
    const v2Base = join(root, 'attempts', 'v2');
    const manifestPath = writeRunning(v2Base, 'issue-7-b', 'bbbbbbbb-2222-4333-8444-555555555555');
    markAttemptExited(manifestPath, () => new Date('2026-09-04T20:00:00.000Z'), undefined, () => 2048);
    expect(listHostAttemptFootprints(v2Base, 'host-1')).toHaveLength(1);
  });

  it('never lets a history write failure break the exit transition', () => {
    const v2Base = join(root, 'attempts', 'v2');
    const manifestPath = writeRunning(v2Base, 'issue-7-c', 'cccccccc-2222-4333-8444-555555555555');
    // A directory where the history file should be makes the rename fail.
    mkdirSync(join(root, 'attempts', 'attempt-footprints.json'), { recursive: true });
    const exited = markAttemptExited(manifestPath, () => new Date('2026-09-04T20:00:00.000Z'), undefined, () => 512);
    expect(exited.processState).toBe('exited');
    expect(exited.worktreeBytes).toBe(512);
    expect(readAttemptManifest(manifestPath).processState).toBe('exited');
  });
});

/**
 * #158: the exit measurement is the smallest a worktree ever is, so the number
 * the history learns has to come from the attempt while it still runs.
 */
describe('live attempt footprint sampling (#158)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'attempt-footprint-peak-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  let attemptIds = 0;

  function writeLive(
    v2Base: string,
    name: string,
    overrides: Record<string, unknown> = {},
  ): string {
    attemptIds += 1;
    const attemptDir = join(v2Base, 'runner-1', 'implement', name);
    mkdirSync(join(attemptDir, 'worktree'), { recursive: true });
    const manifestPath = join(attemptDir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifestFixture(root, {
      attemptId: `${String(attemptIds).repeat(8).slice(0, 8)}-2222-4333-8444-555555555555`,
      processState: 'preparing',
      pid: null,
      paths: {
        attemptDir,
        worktree: join(attemptDir, 'worktree'),
        manifest: manifestPath,
        log: join(attemptDir, 'session.log'),
        ghConfigDir: join(attemptDir, 'gh-config'),
        askpass: join(attemptDir, 'askpass'),
        tokenFile: join(attemptDir, 'gh-token'),
      },
      ...overrides,
    })));
    return manifestPath;
  }

  it('decodes a manifest that carries a peak and a sample timestamp', () => {
    const manifest = decodeAttemptManifest(manifestFixture(root, {
      worktreePeakBytes: 6_500_000_000,
      worktreeSampledAt: '2026-09-03T10:30:00.000Z',
    }));
    expect(manifest.worktreePeakBytes).toBe(6_500_000_000);
    expect(manifest.worktreeSampledAt).toBe('2026-09-03T10:30:00.000Z');
    const legacy = decodeAttemptManifest(manifestFixture(root));
    expect(Object.hasOwn(legacy, 'worktreePeakBytes')).toBe(false);
    expect(Object.hasOwn(legacy, 'worktreeSampledAt')).toBe(false);
    expect(() => decodeAttemptManifest(
      manifestFixture(root, { worktreePeakBytes: -1 }),
    )).toThrow('Invalid worktree peak bytes');
  });

  it('keeps the largest sample it has seen, never the latest', () => {
    const manifestPath = writeLive(join(root, 'v2'), 'issue-7-a');
    const grown = sampleAttemptWorktreePeak(
      manifestPath,
      () => 6_500_000_000,
      () => new Date('2026-09-03T10:30:00.000Z'),
    );
    expect(grown.worktreePeakBytes).toBe(6_500_000_000);
    expect(grown.worktreeSampledAt).toBe('2026-09-03T10:30:00.000Z');
    // The attempt cleaned up after itself before the next walk; the disk still
    // had to hold the larger number.
    const shrunk = sampleAttemptWorktreePeak(
      manifestPath,
      () => 200_000_000,
      () => new Date('2026-09-03T10:40:00.000Z'),
    );
    expect(shrunk.worktreePeakBytes).toBe(6_500_000_000);
    expect(shrunk.worktreeSampledAt).toBe('2026-09-03T10:40:00.000Z');
    expect(readAttemptManifest(manifestPath).worktreePeakBytes).toBe(6_500_000_000);
  });

  it('records the sample time even when the walk gave up', () => {
    const manifestPath = writeLive(join(root, 'v2'), 'issue-7-b');
    const sampled = sampleAttemptWorktreePeak(
      manifestPath,
      () => null,
      () => new Date('2026-09-03T10:30:00.000Z'),
    );
    expect(sampled.worktreePeakBytes).toBeUndefined();
    // Otherwise a worktree too large to walk is re-walked every single cycle.
    expect(sampled.worktreeSampledAt).toBe('2026-09-03T10:30:00.000Z');
  });

  it('records the peak, not the exit measurement, as the attempt footprint', () => {
    const v2Base = join(root, 'v2');
    const manifestPath = writeLive(v2Base, 'issue-7-c', {
      processState: 'running',
      pid: process.pid,
      worktreePeakBytes: 6_500_000_000,
      worktreeSampledAt: '2026-09-03T10:30:00.000Z',
      timestamps: {
        createdAt: '2026-09-03T10:00:00.000Z',
        updatedAt: '2026-09-03T10:30:00.000Z',
        childStartedAt: '2026-09-03T10:00:00.000Z',
      },
    });
    const exited = markAttemptExited(
      manifestPath,
      () => new Date('2026-09-03T11:00:00.000Z'),
      undefined,
      () => 200_000_000,
    );
    expect(exited.worktreeBytes).toBe(6_500_000_000);
    expect(listHostAttemptFootprints(v2Base, 'host-1')).toEqual([
      {
        phase: 'implement',
        worktreeBytes: 6_500_000_000,
        endedAtMs: Date.parse('2026-09-03T11:00:00.000Z'),
      },
    ]);
  });

  it('falls back to the peak when the exit measurement gives up', () => {
    const manifestPath = writeLive(join(root, 'v2'), 'issue-7-d', {
      processState: 'running',
      pid: process.pid,
      worktreePeakBytes: 4_200_000_000,
      timestamps: {
        createdAt: '2026-09-03T10:00:00.000Z',
        updatedAt: '2026-09-03T10:30:00.000Z',
        childStartedAt: '2026-09-03T10:00:00.000Z',
      },
    });
    const exited = markAttemptExited(
      manifestPath,
      () => new Date('2026-09-03T11:00:00.000Z'),
      undefined,
      () => null,
    );
    expect(exited.worktreeBytes).toBe(4_200_000_000);
  });

  it('samples the stalest live attempts and no more than the limit', () => {
    const v2Base = join(root, 'v2');
    writeLive(v2Base, 'issue-7-e', { worktreeSampledAt: '2026-09-03T10:00:00.000Z' });
    writeLive(v2Base, 'issue-7-f', { worktreeSampledAt: '2026-09-03T10:20:00.000Z' });
    // Never sampled at all: the stalest reading there is.
    writeLive(v2Base, 'issue-7-g');
    const walked: string[] = [];
    const sampled = sampleHostAttemptFootprints(v2Base, 'host-1', () => false, {
      limit: 2,
      staleMs: 10 * 60_000,
      now: () => new Date('2026-09-03T10:30:00.000Z'),
      measure: (path) => {
        walked.push(path);
        return 1_000_000;
      },
    });
    expect(sampled).toHaveLength(2);
    expect(walked).toHaveLength(2);
    expect(walked.some((path) => path.includes('issue-7-g'))).toBe(true);
    expect(walked.some((path) => path.includes('issue-7-e'))).toBe(true);
    // Sampled ten minutes ago and the window is ten minutes wide, so it is not
    // yet worth another walk of the same checkout.
    expect(walked.some((path) => path.includes('issue-7-f'))).toBe(false);
    expect(readAttemptManifest(join(v2Base, 'runner-1', 'implement', 'issue-7-f', 'manifest.json'))
      .worktreeSampledAt).toBe('2026-09-03T10:20:00.000Z');
  });

  it('never spends a slot on an attempt a dedicated transition owns', () => {
    const v2Base = join(root, 'v2');
    const attemptDir = join(v2Base, 'runner-1', 'implement', 'issue-7-marketplace');
    writeLive(v2Base, 'issue-7-marketplace', {
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v2',
          status: 'prepared',
          requestPath: join(attemptDir, 'request.json'),
          requestDigest: `sha256:${HASH}`,
          solverNetSelectionPath: join(attemptDir, 'selection.json'),
          preparedAt: '2026-09-03T10:00:00.000Z',
          agentSoftDeadline: '2026-09-03T11:00:00.000Z',
          adoptionDeadline: '2026-09-03T12:00:00.000Z',
        },
      },
    });
    writeLive(v2Base, 'issue-7-local', {
      worktreeSampledAt: '2026-09-03T10:00:00.000Z',
    });
    const walked: string[] = [];
    // The marketplace manifest can never carry a sample stamp, so it sorts
    // ahead of every attempt that can — and would starve them forever.
    sampleHostAttemptFootprints(v2Base, 'host-1', () => false, {
      limit: 1,
      now: () => new Date('2026-09-03T10:30:00.000Z'),
      measure: (path) => {
        walked.push(path);
        return 1_000_000;
      },
    });
    expect(walked).toHaveLength(1);
    expect(walked[0]).toContain('issue-7-local');
  });

  it('never lets one unmeasurable attempt stop the rest of the sweep', () => {
    const v2Base = join(root, 'v2');
    writeLive(v2Base, 'issue-7-h');
    writeLive(v2Base, 'issue-7-i');
    // The attempt exited and its worktree went between the listing and the
    // walk. Bookkeeping is measurement; nothing here may fail a cycle.
    const sampled = sampleHostAttemptFootprints(v2Base, 'host-1', () => false, {
      limit: 4,
      now: () => new Date('2026-09-03T10:30:00.000Z'),
      measure: (path) => {
        if (path.includes('issue-7-h')) throw new Error('ENOENT: worktree vanished');
        return 1_000_000;
      },
    });
    expect(sampled).toHaveLength(1);
    expect(sampled[0]!.worktreePeakBytes).toBe(1_000_000);
  });
});
