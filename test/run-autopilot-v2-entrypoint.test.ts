import { describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import * as lifecycleEntrypoint from '../scripts/run-autopilot-v2.js';

const { isDirectLifecycleEntrypoint } = lifecycleEntrypoint;

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

  it('short-circuits active marketplace mode before repository and credential setup', async () => {
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
      'active',
      { JINN_AUTOPILOT_EXECUTION_BACKEND: 'marketplace' },
      setup,
    )).rejects.toThrow(
      'Marketplace session submission and adoption are not enabled yet.',
    );
    expect(setup).not.toHaveBeenCalled();
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
