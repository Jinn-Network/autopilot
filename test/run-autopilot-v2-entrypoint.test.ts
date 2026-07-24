import { describe, expect, it } from 'vitest';
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
});
