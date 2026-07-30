import { afterEach, expect, describe, it, vi } from 'vitest';
import {
  MarketplaceMachineCliFailure,
  MarketplaceMachineCliProtocolError,
  MARKETPLACE_MACHINE_SUBPROCESS_OUTPUT_LIMIT_BYTES,
  MARKETPLACE_MACHINE_SUBPROCESS_TIMEOUT_MS,
  marketplaceMachineEnvironment,
  parseMarketplaceMachineFailure,
  resolveInstalledJinnBinary,
  runMarketplaceMachineSubprocess,
} from '../../src/lifecycle/marketplace-cli.js';

describe('marketplace machine CLI boundary', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves the executable declared by the installed client package', () => {
    expect(resolveInstalledJinnBinary()).toContain(
      '/node_modules/@jinn-network/client/dist/bin/jinn.js',
    );
  });

  it('removes GitHub credentials and GH_CONFIG_DIR while retaining marketplace configuration', () => {
    expect(marketplaceMachineEnvironment({
      PATH: '/bin',
      JINN_CONFIG_HOME: '/operator/jinn',
      JINN_RPC_URL: 'https://rpc.example',
      GH_CONFIG_DIR: '/private/gh',
      GH_TOKEN: 'secret',
      GITHUB_TOKEN: 'secret',
      ACME_GITHUB_PAT: 'secret',
    })).toEqual({
      PATH: '/bin',
      JINN_CONFIG_HOME: '/operator/jinn',
      JINN_RPC_URL: 'https://rpc.example',
      NO_COLOR: '1',
    });
  });

  it('accepts only the exact nonzero client failure envelope', () => {
    const result = {
      exitCode: 40,
      stdout: JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-07-26T12:01:00.000Z',
        code: 'transient_error',
        exitCode: 40,
        message: 'RPC endpoint unavailable',
      }),
      stderr: 'rpc diagnostic',
    };

    const envelope = parseMarketplaceMachineFailure(result);
    expect(envelope.code).toBe('transient_error');
    expect(() => { throw new MarketplaceMachineCliFailure(envelope, result.stderr); })
      .toThrow('RPC endpoint unavailable');
  });

  it('rejects marketplace machine subprocess output above the bounded limit', async () => {
    const overLimit = MARKETPLACE_MACHINE_SUBPROCESS_OUTPUT_LIMIT_BYTES + 1;
    await expect(runMarketplaceMachineSubprocess(
      process.execPath,
      ['-e', `process.stdout.write('x'.repeat(${overLimit}))`],
      { environment: process.env },
    )).rejects.toThrow(/output limit/i);
  });

  it('times out a hung marketplace machine subprocess', async () => {
    vi.useFakeTimers();
    const pending = runMarketplaceMachineSubprocess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000_000)'],
      { environment: process.env },
    );
    await vi.advanceTimersByTimeAsync(MARKETPLACE_MACHINE_SUBPROCESS_TIMEOUT_MS + 1);
    await expect(pending).rejects.toThrow(
      new RegExp(`${MARKETPLACE_MACHINE_SUBPROCESS_TIMEOUT_MS}ms`),
    );
  });

  it('rejects a malformed or mismatched nonzero client failure envelope', () => {
    expect(() => parseMarketplaceMachineFailure({
      exitCode: 40,
      stdout: JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-07-26T12:01:00.000Z',
        code: 'transient_error',
        exitCode: 50,
        message: 'RPC endpoint unavailable',
      }),
      stderr: 'rpc diagnostic',
    })).toThrow(MarketplaceMachineCliProtocolError);
  });
});
