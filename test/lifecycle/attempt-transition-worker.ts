import { transitionMarketplaceExecution } from '../../src/lifecycle/attempt-workspace.js';

const input = JSON.parse(process.argv[2] ?? '{}') as {
  readonly manifestPath: string;
  readonly requestDigest: string;
  readonly transition: unknown;
};

try {
  transitionMarketplaceExecution(
    input.manifestPath,
    input.requestDigest,
    input.transition as never,
  );
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }));
}
