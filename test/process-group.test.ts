import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  childProcessesOf,
  isProcessGroupAlive,
  terminateProcessGroup,
  terminateProcessTree,
} from '../src/process-group.js';
import { defaultRunner } from '../src/dispatcher/issue-source.js';

interface KillCall {
  readonly pid: number;
  readonly signal: NodeJS.Signals;
}

function recorder() {
  const kills: KillCall[] = [];
  const sleeps: number[] = [];
  return {
    kills,
    sleeps,
    kill: (pid: number, signal: NodeJS.Signals) => { kills.push({ pid, signal }); },
    sleep: async (ms: number) => { sleeps.push(ms); },
  };
}

describe('bounded process-group teardown', () => {
  it('reports nothing signalled when the group is already gone', async () => {
    const seams = recorder();

    await expect(terminateProcessGroup({
      pid: 4242,
      isAlive: () => false,
      kill: seams.kill,
      sleep: seams.sleep,
    })).resolves.toBe(0);
    expect(seams.kills).toEqual([]);
    expect(seams.sleeps).toEqual([]);
  });

  it('stops at SIGTERM when the group leaves inside the grace period', async () => {
    const seams = recorder();
    let alive = true;

    await expect(terminateProcessGroup({
      pid: 4242,
      graceMs: 10_000,
      isAlive: () => alive,
      kill: (pid, signal) => {
        seams.kill(pid, signal);
        alive = false;
      },
      sleep: seams.sleep,
    })).resolves.toBe(1);
    expect(seams.kills).toEqual([{ pid: 4242, signal: 'SIGTERM' }]);
    expect(seams.sleeps).toEqual([10_000]);
  });

  it('escalates to SIGKILL when the group outlives the grace period', async () => {
    const seams = recorder();

    await expect(terminateProcessGroup({
      pid: 4242,
      graceMs: 10_000,
      isAlive: () => true,
      kill: seams.kill,
      sleep: seams.sleep,
    })).resolves.toBe(2);
    expect(seams.kills).toEqual([
      { pid: 4242, signal: 'SIGTERM' },
      { pid: 4242, signal: 'SIGKILL' },
    ]);
  });

  it('counts a signal a vanishing group refuses, rather than throwing', async () => {
    await expect(terminateProcessGroup({
      pid: 4242,
      graceMs: 0,
      isAlive: () => true,
      kill: () => {
        const error: NodeJS.ErrnoException = new Error('ESRCH');
        error.code = 'ESRCH';
        throw error;
      },
      sleep: async () => {},
    })).resolves.toBe(2);
  });
});

describe('real detached process group', () => {
  const started: number[] = [];

  afterEach(() => {
    for (const pid of started.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone: the assertions below are what actually proved that.
      }
    }
  });

  async function until(
    predicate: () => boolean,
    timeoutMs = 5_000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
    return predicate();
  }

  function pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  it('reaps a background job orphaned by its own detached parent', async () => {
    // Only processes this test starts are ever signalled: one detached shell
    // (its own group leader) plus the `sleep` it backgrounds, which is what a
    // worker's background verification run looks like to the engine.
    const shell = spawn('/bin/sh', ['-c', 'sleep 120 & echo $!; wait'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const shellPid = shell.pid!;
    started.push(shellPid);
    const backgroundPid = await new Promise<number>((resolve, reject) => {
      shell.stdout!.once('data', (chunk: Buffer) => {
        const parsed = Number.parseInt(chunk.toString().trim(), 10);
        if (Number.isInteger(parsed)) resolve(parsed);
        else reject(new Error(`Unreadable background PID: ${chunk.toString()}`));
      });
      shell.once('error', reject);
    });
    started.push(backgroundPid);

    // Kill only the direct child, exactly as an exiting worker leaves things.
    shell.kill('SIGKILL');
    expect(await until(() => !pidAlive(shellPid))).toBe(true);
    expect(pidAlive(backgroundPid)).toBe(true);
    expect(isProcessGroupAlive(shellPid)).toBe(true);

    await expect(terminateProcessGroup({ pid: shellPid, graceMs: 2_000 }))
      .resolves.toBeGreaterThan(0);

    expect(await until(() => !pidAlive(backgroundPid))).toBe(true);
    expect(isProcessGroupAlive(shellPid)).toBe(false);
  }, 20_000);
});

describe('process-tree teardown (#184)', () => {
  it('walks the descendants before signalling, then signals the survivors by PID', async () => {
    const seams = recorder();
    const pidKills: KillCall[] = [];
    // 4242 -> 4243 -> 4244; 4242 -> 4245. Listed before the group signal,
    // because that signal re-parents the survivors away from the walk.
    const tree = new Map<number, number[]>([
      [4242, [4243, 4245]],
      [4243, [4244]],
    ]);
    const listed: number[] = [];
    // The group signal did nothing (the host in #184); only the walk reaps.
    const dead = new Set<number>();

    await expect(terminateProcessTree({
      pid: 4242,
      graceMs: 10_000,
      isAlive: () => true,
      kill: seams.kill,
      sleep: seams.sleep,
      listChildren: async (pid) => {
        listed.push(pid);
        return tree.get(pid) ?? [];
      },
      isPidAlive: (pid) => !dead.has(pid),
      killPid: (pid, signal) => {
        pidKills.push({ pid, signal });
        if (signal === 'SIGTERM' && pid !== 4244) dead.add(pid);
      },
    })).resolves.toBe(2 + 4 + 1);

    expect(listed).toEqual([4242, 4243, 4245, 4244]);
    expect(seams.kills.map((call) => call.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(pidKills).toEqual([
      { pid: 4242, signal: 'SIGTERM' },
      { pid: 4243, signal: 'SIGTERM' },
      { pid: 4245, signal: 'SIGTERM' },
      { pid: 4244, signal: 'SIGTERM' },
      { pid: 4244, signal: 'SIGKILL' },
    ]);
  });

  it('signals nothing by PID when the group signal already reaped the tree', async () => {
    const pidKills: KillCall[] = [];
    let alive = true;

    await expect(terminateProcessTree({
      pid: 4242,
      graceMs: 0,
      isAlive: () => alive,
      kill: () => { alive = false; },
      sleep: async () => {},
      listChildren: async () => [4243],
      isPidAlive: () => false,
      killPid: (pid, signal) => { pidKills.push({ pid, signal }); },
    })).resolves.toBe(1);
    expect(pidKills).toEqual([]);
  });

  it('treats a walk that cannot list children as an empty one', async () => {
    await expect(terminateProcessTree({
      pid: 4242,
      graceMs: 0,
      isAlive: () => false,
      listChildren: async () => { throw new Error('no pgrep'); },
      isPidAlive: () => false,
      killPid: () => {},
    })).resolves.toBe(0);
  });
});

describe('real process tree', () => {
  const started: number[] = [];

  afterEach(() => {
    for (const pid of started.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone: the assertions below are what actually proved that.
      }
    }
  });

  async function until(
    predicate: () => boolean,
    timeoutMs = 5_000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
    return predicate();
  }

  function pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  it('reaps a sleep tree by PID when the group signal does not take effect', async () => {
    // Only processes this test starts are signalled: one detached shell and
    // the two sleeps it backgrounds — a coordinator and the test runners it
    // left looping, as the sweep sees them.
    const shell = spawn('/bin/sh', ['-c', 'sleep 120 & sleep 120 & echo $$; wait'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const shellPid = shell.pid!;
    started.push(shellPid);
    await new Promise<void>((resolve, reject) => {
      shell.stdout!.once('data', () => resolve());
      shell.once('error', reject);
    });
    const children = await childProcessesOf(shellPid, defaultRunner);
    started.push(...children);
    expect(children).toHaveLength(2);
    expect(children.every(pidAlive)).toBe(true);

    await expect(terminateProcessTree({
      pid: shellPid,
      graceMs: 500,
      // The group signal is a no-op here, as it was on the #184 host.
      kill: () => {},
      listChildren: (pid) => childProcessesOf(pid, defaultRunner),
    })).resolves.toBeGreaterThan(0);

    expect(await until(() => !pidAlive(shellPid))).toBe(true);
    expect(await until(() => children.every((pid) => !pidAlive(pid)))).toBe(true);
  }, 20_000);
});
