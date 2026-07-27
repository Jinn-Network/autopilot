import { expect, describe, it } from 'vitest';
import {
  MarketplaceMachineCliFailure,
  MarketplaceMachineCliProtocolError,
  marketplaceMachineEnvironment,
  parseMarketplaceMachineFailure,
  resolveInstalledJinnBinary,
} from '../../src/lifecycle/marketplace-cli.js';

describe('marketplace machine CLI boundary', () => {
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
