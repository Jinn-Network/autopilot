import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as lifecycleEntrypoint from '../scripts/run-autopilot-v2.js';
import { CredentialPool } from '../src/lifecycle/credentials.js';
import { WorkerInfancyWatch } from '../src/lifecycle/worker-infancy.js';

const {
  isDirectLifecycleEntrypoint,
  makeLoggingSpawn,
  makeMarketplaceRecoveryCallback,
  makeMarketplaceRecoveryCredentialResolver,
  makeMarketplaceReviewAnchorRelease,
  renderCleanupWarnings,
  runCycleThenBookkeeping,
} = lifecycleEntrypoint;

describe('lifecycle script entrypoint', () => {
  it('runs only from the lifecycle script and not from the bundled CLI', () => {
    const lifecycle = '/package/scripts/run-autopilot-v2.ts';
    const bundledCli = '/package/dist/autopilot.js';

    expect(isDirectLifecycleEntrypoint(
      lifecycle,
      pathToFileURL(lifecycle).href,
    )).toBe(true);
    expect(isDirectLifecycleEntrypoint(
      bundledCli,
      pathToFileURL(bundledCli).href,
    )).toBe(false);
  });

  it('makes a failed scoped one-shot nonzero without stopping persistent cadence', () => {
    const exitCodeForReport = Reflect.get(
      lifecycleEntrypoint,
      'lifecycleExitCodeForReport',
    ) as ((report: { readonly status: string }, once: boolean) => number | undefined) | undefined;
    const failed = { status: 'failed' };

    expect(exitCodeForReport?.(failed, true)).toBe(1);
    expect(exitCodeForReport?.(failed, false)).toBeUndefined();
    expect(exitCodeForReport?.({ status: 'rejected' }, true)).toBe(2);
    expect(exitCodeForReport?.({ status: 'ok' }, true)).toBeUndefined();
  });

  it('forwards composed coordinator exit callbacks while capturing log output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-logging-spawn-'));
    const logPath = join(dir, 'review.log');
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
    const spawn = makeLoggingSpawn();
    const result = spawn(process.execPath, ['-e', 'process.exit(7)'], {
      cwd: dir,
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit'],
      logPath,
      onExit: (code, signal) => {
        exits.push({ code, signal });
      },
    });

    await vi.waitFor(() => {
      expect(exits).toEqual([{ code: 7, signal: null }]);
    });
    expect(result.pid).toBeTypeOf('number');
    expect(readFileSync(logPath, 'utf8')).toContain('active dispatch');
  });

  /**
   * #186: the dead sessions of 2026-09-12 left no attempt directory or log at
   * all, because the sweep removed them before anyone read them. A worker's
   * stderr lands in its `session.log` the moment it is written — even one
   * line before an immediate exit — and the watch reads it back at exit, so
   * the cycle summary can quote it after the directory is gone.
   */
  it('captures an infant worker\'s first stderr into session.log and the watch (#186)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-infant-spawn-'));
    const logPath = join(dir, 'attempt', 'session.log');
    const watch = new WorkerInfancyWatch();
    const spawn = makeLoggingSpawn(watch);
    let exited = false;
    spawn(process.execPath, [
      '-e',
      'console.error("Error: connect ENOENT /tmp/cc-socks/51448.sock"); process.exit(1)',
    ], {
      cwd: dir,
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit'],
      logPath,
      onExit: () => { exited = true; },
    });

    await vi.waitFor(() => { expect(exited).toBe(true); });
    expect(readFileSync(logPath, 'utf8')).toContain('connect ENOENT /tmp/cc-socks/51448.sock');
    expect(await watch.settle()).toEqual({
      dispatched: 1,
      infantDeaths: 1,
      lastStderr: 'Error: connect ENOENT /tmp/cc-socks/51448.sock',
    });
  });

  it('writes a launch that could not even spawn into session.log, as an infant death (#186)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-nospawn-'));
    const logPath = join(dir, 'session.log');
    const watch = new WorkerInfancyWatch();
    const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
    makeLoggingSpawn(watch)(join(dir, 'no-such-claude'), ['-p'], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
      logPath,
      onExit: (code, signal) => { exits.push({ code, signal }); },
    });

    await vi.waitFor(() => { expect(exits).toEqual([{ code: null, signal: null }]); });
    expect(readFileSync(logPath, 'utf8')).toMatch(/\[autopilot\] spawn failed: .*ENOENT/);
    expect(await watch.settle()).toMatchObject({
      dispatched: 1,
      infantDeaths: 1,
      lastStderr: expect.stringContaining('spawn failed'),
    });
  });

  it('selects the production backend only from the dedicated configured runtime variable', () => {
    const executionBackendForEnvironment = Reflect.get(
      lifecycleEntrypoint,
      'executionBackendForEnvironment',
    ) as ((environment: NodeJS.ProcessEnv) => 'local' | 'marketplace') | undefined;

    expect(executionBackendForEnvironment?.({
      JINN_AUTOPILOT_EXECUTION_BACKEND: 'marketplace',
      JINN_EXECUTION_MODE: 'local',
    })).toBe('marketplace');
    expect(executionBackendForEnvironment?.({
      JINN_EXECUTION_MODE: 'marketplace',
    })).toBe('local');
  });

  it.each(['observe', 'recover', 'active'] as const)(
    'allows %s marketplace mode to continue into repository setup',
    async (mode) => {
    const preflightProductionEntrypoint = Reflect.get(
      lifecycleEntrypoint,
      'preflightProductionEntrypoint',
    ) as ((
      mode: 'observe' | 'recover' | 'active',
      environment: NodeJS.ProcessEnv,
      setup: () => Promise<string>,
    ) => Promise<string>) | undefined;
    const setup = vi.fn(async () => '/repo');

    expect(preflightProductionEntrypoint).toBeTypeOf('function');
    await expect(preflightProductionEntrypoint!(
      mode,
      { JINN_AUTOPILOT_EXECUTION_BACKEND: 'marketplace' },
      setup,
    )).resolves.toBe('/repo');
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['repository', { repositorySlug: 'Other/repository' }],
    ['language', { language: 'rust' }],
    ['verification profile', { verificationProfile: 'other.v1' }],
  ])(
    'fails closed on an unsupported recover-mode marketplace %s before attempting replay',
    async (_label, overrides) => {
      const replay = vi.fn(async () => {});

      expect(makeMarketplaceRecoveryCallback).toBeTypeOf('function');
      const callback = makeMarketplaceRecoveryCallback({
        mode: 'recover',
        executionBackend: 'marketplace',
        repositorySlug: 'Jinn-Network/mono',
        replay,
        ...overrides,
      });
      await expect(callback!()).rejects.toThrow(
        /supports only Jinn-Network\/mono.*typescript.*jinn-mono\.v1/i,
      );
      expect(replay).not.toHaveBeenCalled();
    },
  );

  it('runs the recover-mode marketplace profile gate even when replay finds no prepared attempts', async () => {
    const replay = vi.fn(async () => {});

    const callback = makeMarketplaceRecoveryCallback({
      mode: 'recover',
      executionBackend: 'marketplace',
      repositorySlug: 'Jinn-Network/mono',
      replay,
    });
    await expect(callback!()).resolves.toBeUndefined();
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it('resolves marketplace initialization credentials by the journal exact login', () => {
    const credentials = new CredentialPool([
      {
        login: 'First-Bot',
        normalizedLogin: 'first-bot',
        implementationToken: 'first-secret',
      },
      {
        login: 'Second-Bot',
        normalizedLogin: 'second-bot',
        implementationToken: 'second-secret',
      },
    ]);

    const resolve = makeMarketplaceRecoveryCredentialResolver(credentials);
    expect(resolve('second-bot').normalizedLogin).toBe('second-bot');
    expect(() => resolve('missing-bot')).toThrow(/missing-bot.*unavailable/i);
  });

  it('leaves observe mode unchanged without marketplace profile validation or replay', () => {
    const replay = vi.fn(async () => {});

    expect(makeMarketplaceRecoveryCallback({
      mode: 'observe',
      executionBackend: 'marketplace',
      repositorySlug: 'Other/repository',
      replay,
    })).toBeUndefined();
    expect(replay).not.toHaveBeenCalled();
  });

  it('constructs the recovery review port lazily with the evaluator-leg manifest', async () => {
    const reviewPort = {} as never;
    const makeReviewPort = vi.fn(() => reviewPort);
    const release = vi.fn(async () => {});
    const runner = vi.fn(async () => '');
    const manifestPath = '/attempts/evaluator-leg/manifest.json';
    const callback = makeMarketplaceReviewAnchorRelease({
      runner,
      environment: { KEEP_ME: 'yes' },
      makeReviewPort,
      release,
      now: () => new Date('2026-07-28T10:30:00.000Z'),
    });
    const anchor = {
      attemptId: '22222222-2222-4222-8222-222222222222',
      manifestPath,
      head: 'a'.repeat(40),
      generation: '33333333-3333-4333-8333-333333333333',
      refOid: 'b'.repeat(40),
      reviewer: 'review-bot',
      anchoredAt: '2026-07-28T10:29:00.000Z',
    } as never;

    expect(makeReviewPort).not.toHaveBeenCalled();
    await callback(anchor);

    expect(makeReviewPort).toHaveBeenCalledWith({
      runner,
      environment: {
        KEEP_ME: 'yes',
        JINN_AUTOPILOT_SESSION_MANIFEST: manifestPath,
      },
    });
    expect(release).toHaveBeenCalledWith(
      anchor,
      reviewPort,
      expect.any(Function),
    );
  });

  it('allows local attempt cleanup without asking the cycle for a snapshot', () => {
    const shouldSweepAttempts = Reflect.get(
      lifecycleEntrypoint,
      'shouldSweepAttempts',
    ) as ((input: {
      readonly mode: string;
      readonly executionBackend: string;
      readonly cleanupEnabled: boolean;
      readonly hasMaintenanceCredential: boolean;
    }) => boolean) | undefined;
    // No report of any shape is an input here: a cycle that threw before its
    // snapshot has none to offer, and its dead attempts are no less dead.
    const base = {
      mode: 'active',
      executionBackend: 'local',
      cleanupEnabled: true,
      hasMaintenanceCredential: true,
    };

    expect(shouldSweepAttempts).toBeTypeOf('function');
    expect(shouldSweepAttempts!(base)).toBe(true);
    expect(shouldSweepAttempts!({
      ...base,
      executionBackend: 'marketplace',
    })).toBe(false);
    expect(shouldSweepAttempts!({ ...base, mode: 'observe' })).toBe(false);
    expect(shouldSweepAttempts!({ ...base, cleanupEnabled: false })).toBe(false);
    expect(shouldSweepAttempts!({
      ...base,
      hasMaintenanceCredential: false,
    })).toBe(false);
  });

  it('keeps board painting behind the snapshot boundary the sweep is exempt from', () => {
    const shouldPaintBoard = Reflect.get(
      lifecycleEntrypoint,
      'shouldPaintBoard',
    ) as ((input: {
      readonly mode: string;
      readonly report?: {
        readonly status: string;
        readonly snapshotComplete?: boolean;
      } | null;
    }) => boolean) | undefined;
    const complete = { status: 'ok', snapshotComplete: true };

    expect(shouldPaintBoard).toBeTypeOf('function');
    expect(shouldPaintBoard!({ mode: 'active', report: complete })).toBe(true);
    // The exemption is exactly one bookkeeping step wide: painting the board is
    // a GitHub mutation and still refuses a cycle without a complete snapshot.
    expect(shouldPaintBoard!({ mode: 'active' })).toBe(false);
    expect(shouldPaintBoard!({ mode: 'active', report: null })).toBe(false);
    expect(shouldPaintBoard!({
      mode: 'active',
      report: { status: 'ok', snapshotComplete: false },
    })).toBe(false);
    expect(shouldPaintBoard!({
      mode: 'active',
      report: { status: 'failed', snapshotComplete: true },
    })).toBe(false);
    expect(shouldPaintBoard!({ mode: 'observe', report: complete })).toBe(false);
  });

  it('keeps bookkeeping strictly behind the cycle that scheduled and dispatched', async () => {
    const order: string[] = [];
    let cycleFinished = false;

    const report = await runCycleThenBookkeeping({
      runCycle: async () => {
        order.push('schedule');
        await Promise.resolve();
        order.push('dispatch');
        cycleFinished = true;
        return { status: 'ok' } as const;
      },
      bookkeeping: [
        async (finished) => {
          order.push(`cleanup:${finished?.status}`);
          expect(cycleFinished).toBe(true);
        },
        async () => { order.push('paint'); },
      ],
    });

    expect(report).toEqual({ status: 'ok' });
    expect(order).toEqual(['schedule', 'dispatch', 'cleanup:ok', 'paint']);
  });

  it('still books a cycle that threw before it produced any snapshot', async () => {
    const cycleError = new Error('snapshot read failed');
    const order: string[] = [];
    const seen: Array<{ readonly status: string } | undefined> = [];

    await expect(runCycleThenBookkeeping({
      runCycle: async (): Promise<{ readonly status: string }> => {
        order.push('cycle');
        throw cycleError;
      },
      bookkeeping: [
        async (finished) => {
          order.push('cleanup');
          seen.push(finished);
        },
        async () => { order.push('paint'); },
      ],
    })).rejects.toBe(cycleError);

    expect(order).toEqual(['cycle', 'cleanup', 'paint']);
    expect(seen).toEqual([undefined]);
  });

  it('reports a bookkeeping failure of a failed cycle without masking either', async () => {
    const cycleError = new Error('snapshot read failed');
    const cleanupError = new Error('worktree remove failed');
    const order: string[] = [];
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(runCycleThenBookkeeping({
        runCycle: async (): Promise<{ readonly status: string }> => {
          throw cycleError;
        },
        bookkeeping: [
          async () => {
            order.push('cleanup');
            throw cleanupError;
          },
          async () => { order.push('paint'); },
        ],
      })).rejects.toBe(cycleError);

      expect(order).toEqual(['cleanup', 'paint']);
      expect(logged.mock.calls.map(([line]) => String(line))).toEqual([
        '[autopilot:v2] bookkeeping failed after a failed cycle: '
        + 'worktree remove failed',
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it('leaves a successful cycle answering for its own bookkeeping failure', async () => {
    const cleanupError = new Error('worktree remove failed');
    const order: string[] = [];

    await expect(runCycleThenBookkeeping({
      runCycle: async () => ({ status: 'ok' } as const),
      bookkeeping: [
        async () => {
          order.push('cleanup');
          throw cleanupError;
        },
        async () => { order.push('paint'); },
      ],
    })).rejects.toBe(cleanupError);

    expect(order).toEqual(['cleanup']);
  });

  it('names every deferral once and summarizes it apart from a real retention', () => {
    expect(renderCleanupWarnings([
      { status: 'removed', attemptId: 'a' },
      {
        status: 'retained',
        attemptId: 'b',
        reason: { code: 'live', detail: 'Attempt child PID is still live.' },
      },
      {
        status: 'retained',
        attemptId: 'c',
        reason: { code: 'dirty', detail: 'Worktree contains uncommitted changes.' },
      },
      {
        status: 'retained',
        attemptId: 'd',
        reason: { code: 'deferred', detail: 'deferred one' },
      },
      {
        status: 'retained',
        reason: { code: 'deferred', detail: 'deferred two' },
      },
    ])).toEqual([
      '[autopilot:v2] cleanup retained attempt=c reason=dirty: '
      + 'Worktree contains uncommitted changes.',
      '[autopilot:v2] cleanup deferred 2 attempt(s) to the next cycle; '
      + 'the 60s sweep budget was spent',
    ]);
  });

  it('reports background reclaims as occupied disk, never as reclaimed', () => {
    expect(renderCleanupWarnings([], 3)).toEqual([
      '[autopilot:v2] cleanup reclaiming 3 trashed worktree(s) in the background; '
      + 'their bytes stay occupied until each finishes',
    ]);
    expect(renderCleanupWarnings([], 0)).toEqual([]);
  });

  // #179: `reclaiming N in the background` names only what is running. When
  // the queue behind it is deeper than one cycle can start, the operator
  // reading `admits=none` needs the size of the queue, not the width of the
  // pool.
  it('reports a reclaim queue deeper than one cycle can start', () => {
    expect(renderCleanupWarnings([], 3, [], {
      count: 18,
      bytes: 40.2 * 1024 ** 3,
      concurrency: 3,
    })).toEqual([
      '[autopilot:v2] cleanup reclaiming 3 trashed worktree(s) in the background; '
      + 'their bytes stay occupied until each finishes',
      '[autopilot:v2] cleanup reclaim backlog: 18 worktree(s), 40.2G',
    ]);
  });

  it('stays quiet about a trash the pool is already keeping up with', () => {
    expect(renderCleanupWarnings([], 0, [], {
      count: 3,
      bytes: 6 * 1024 ** 3,
      concurrency: 3,
    })).toEqual([]);
  });

  it('reports a failed reclaim until it clears', () => {
    expect(renderCleanupWarnings([], 0, [
      { trashed: '/x/trash/attempt-1-uuid', entry: 'attempt-1-uuid', detail: 'EPERM' },
    ])).toEqual([
      '[autopilot:v2] cleanup reclaim failed trash=attempt-1-uuid: EPERM; '
      + 'the next sweep retries it',
    ]);
  });
});
