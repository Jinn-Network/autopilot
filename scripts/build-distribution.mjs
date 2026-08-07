import { chmod, copyFile, mkdir, rm } from 'node:fs/promises';
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
  // Keep the exact published wire contracts as a runtime dependency. Bundling
  // them would embed their fixed profile literals into the standalone binary,
  // where the distribution verifier correctly treats such literals as local
  // repository fallbacks.
  external: [
    '@jinn-network/sdk/autopilot',
    '@jinn-network/sdk/solvernets/jinn-repo',
  ],
  sourcemap: false,
  legalComments: 'none',
});
await chmod(new URL('../dist/autopilot.js', import.meta.url), 0o755);

const evaluatorDir = new URL('../dist/issue-relay-evaluator/', import.meta.url);
await mkdir(evaluatorDir, { recursive: true });
await build({
  entryPoints: [
    new URL('../src/issue-relay/evaluator/external-harness.ts', import.meta.url).pathname,
  ],
  outfile: new URL('index.js', evaluatorDir).pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
});
for (const name of ['README.md', 'jinn.manifest.template.json']) {
  await copyFile(
    new URL(`../assets/issue-relay/evaluator/${name}`, import.meta.url),
    new URL(name, evaluatorDir),
  );
}
