import { chmod, mkdir, rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await build({
  entryPoints: [new URL('../bin/autopilot.ts', import.meta.url).pathname],
  outfile: new URL('../dist/autopilot.js', import.meta.url).pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
});
await chmod(new URL('../dist/autopilot.js', import.meta.url), 0o755);
