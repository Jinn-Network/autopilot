import { existsSync, writeFileSync } from 'node:fs';
import {
  transitionMarketplaceAdoption,
  upgradeMarketplaceExecutionV2,
} from '../../src/lifecycle/marketplace-adoption-state.js';

const input = JSON.parse(process.argv[2] ?? '{}') as {
  readonly operation: 'observe' | 'upgrade';
  readonly manifestPath: string;
  readonly requestDigest: string;
  readonly delivery?: unknown;
  readonly timestamp: string;
  readonly readyPath: string;
  readonly releasePath: string;
};

function blockedNow(): Date {
  writeFileSync(input.readyPath, 'ready\n', { mode: 0o600 });
  const deadline = Date.now() + 10_000;
  while (!existsSync(input.releasePath)) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for adoption worker release');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return new Date(input.timestamp);
}

try {
  const manifest = input.operation === 'upgrade'
    ? upgradeMarketplaceExecutionV2(
        input.manifestPath,
        input.requestDigest,
        blockedNow,
      )
    : transitionMarketplaceAdoption(
        input.manifestPath,
        input.requestDigest,
        {
          status: 'solution-observed',
          delivery: input.delivery,
        } as never,
        blockedNow,
      );
  process.stdout.write(JSON.stringify({
    ok: true,
    status: manifest.execution.backend === 'marketplace'
      ? manifest.execution.state.status
      : 'local',
  }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }));
}
