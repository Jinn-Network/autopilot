import { describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import * as lifecycleEntrypoint from '../scripts/run-autopilot-v2.js';
import { CredentialPool } from '../src/lifecycle/credentials.js';

const {
  isDirectLifecycleEntrypoint,
  makeMarketplaceRecoveryCallback,
  makeMarketplaceRecoveryCredentialResolver,
  makeMarketplaceReviewAnchorRelease,
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

  it('allows attempt cleanup only for successful complete local active cycles', () => {
    const shouldSweepAttempts = Reflect.get(
      lifecycleEntrypoint,
      'shouldSweepAttempts',
    ) as ((input: {
      readonly mode: string;
      readonly executionBackend: string;
      readonly cleanupEnabled: boolean;
      readonly hasMaintenanceCredential: boolean;
      readonly report: { readonly status: string; readonly snapshotComplete?: boolean };
    }) => boolean) | undefined;
    const base = {
      mode: 'active',
      executionBackend: 'local',
      cleanupEnabled: true,
      hasMaintenanceCredential: true,
      report: { status: 'ok', snapshotComplete: true },
    };

    expect(shouldSweepAttempts).toBeTypeOf('function');
    expect(shouldSweepAttempts!(base)).toBe(true);
    expect(shouldSweepAttempts!({
      ...base,
      executionBackend: 'marketplace',
    })).toBe(false);
    expect(shouldSweepAttempts!({
      ...base,
      report: { status: 'rejected', snapshotComplete: false },
    })).toBe(false);
    expect(shouldSweepAttempts!({
      ...base,
      report: { status: 'ok', snapshotComplete: false },
    })).toBe(false);
  });
});
