import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginCycleStep,
  configureCycleHeartbeat,
  cycleHeartbeatPath,
  readCycleHeartbeat,
  withCycleStep,
} from '../src/cycle-heartbeat.js';

afterEach(() => {
  configureCycleHeartbeat(null);
});

function serviceDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'autopilot-heartbeat-'));
}

describe('process-local cycle heartbeat', () => {
  it('names the step a live engine child is inside and clears it when the step ends', async () => {
    const directory = serviceDirectory();
    const path = cycleHeartbeatPath(directory);
    let clock = Date.parse('2026-09-02T18:10:00.000Z');
    configureCycleHeartbeat({
      path,
      pid: 4242,
      now: () => new Date(clock),
    });

    await withCycleStep('worktree remove pr-3683', async () => {
      expect(readCycleHeartbeat(path, () => true)).toEqual({
        schemaVersion: 1,
        pid: 4242,
        step: 'worktree remove pr-3683',
        startedAt: '2026-09-02T18:10:00.000Z',
      });
      clock += 60_000;
    });

    expect(existsSync(path)).toBe(false);
    expect(readCycleHeartbeat(path, () => true)).toBeNull();
  });

  it('ignores a heartbeat whose recorded engine pid is not alive', () => {
    const directory = serviceDirectory();
    const path = cycleHeartbeatPath(directory);
    configureCycleHeartbeat({
      path,
      pid: 4242,
      now: () => new Date('2026-09-02T18:10:00.000Z'),
    });
    const end = beginCycleStep('worktree remove pr-3683');

    expect(readCycleHeartbeat(path, (pid) => pid === 4242)).not.toBeNull();
    expect(readCycleHeartbeat(path, () => false)).toBeNull();
    expect(readCycleHeartbeat(path, (pid) => pid === 9999)).toBeNull();

    end();
  });

  it('reports the innermost live step while nested steps unwind out of order', () => {
    const directory = serviceDirectory();
    const path = cycleHeartbeatPath(directory);
    let clock = Date.parse('2026-09-02T18:10:00.000Z');
    configureCycleHeartbeat({ path, pid: 7, now: () => new Date(clock) });

    const outer = beginCycleStep('attempt cleanup sweep');
    clock += 1_000;
    const inner = beginCycleStep('worktree remove pr-3683');

    expect(readCycleHeartbeat(path, () => true)?.step)
      .toBe('worktree remove pr-3683');
    expect(readCycleHeartbeat(path, () => true)?.startedAt)
      .toBe('2026-09-02T18:10:01.000Z');

    outer();
    expect(readCycleHeartbeat(path, () => true)?.step)
      .toBe('worktree remove pr-3683');

    inner();
    expect(readCycleHeartbeat(path, () => true)).toBeNull();
  });

  it('is inert until an engine child configures it', async () => {
    const directory = serviceDirectory();
    const path = cycleHeartbeatPath(directory);

    const end = beginCycleStep('worktree remove pr-3683');
    end();
    await expect(withCycleStep('full reconciliation read', async () => 'value'))
      .resolves.toBe('value');

    expect(existsSync(path)).toBe(false);
  });

  it('ignores a malformed or foreign-schema heartbeat rather than reporting it', () => {
    const directory = serviceDirectory();
    const path = cycleHeartbeatPath(directory);

    writeFileSync(path, 'not json at all', { mode: 0o600 });
    expect(readCycleHeartbeat(path, () => true)).toBeNull();

    writeFileSync(path, JSON.stringify({
      schemaVersion: 2,
      pid: 4242,
      step: 'worktree remove pr-3683',
      startedAt: '2026-09-02T18:10:00.000Z',
    }), { mode: 0o600 });
    expect(readCycleHeartbeat(path, () => true)).toBeNull();

    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      pid: 0,
      step: 'worktree remove pr-3683',
      startedAt: '2026-09-02T18:10:00.000Z',
    }), { mode: 0o600 });
    expect(readCycleHeartbeat(path, () => true)).toBeNull();

    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      pid: 4242,
      step: 'worktree remove pr-3683',
      startedAt: 'not-a-timestamp',
    }), { mode: 0o600 });
    expect(readCycleHeartbeat(path, () => true)).toBeNull();
  });

  it('never lets a heartbeat write failure escape into the cycle', async () => {
    const directory = serviceDirectory();
    configureCycleHeartbeat({
      // A path whose parent is a regular file can never be written.
      path: join(directory, 'not-a-directory', 'heartbeat.json'),
      pid: 4242,
    });
    writeFileSync(join(directory, 'not-a-directory'), 'file\n', { mode: 0o600 });

    await expect(withCycleStep('worktree remove pr-3683', async () => 'ok'))
      .resolves.toBe('ok');
    expect(readFileSync(join(directory, 'not-a-directory'), 'utf8')).toBe('file\n');
  });
});
