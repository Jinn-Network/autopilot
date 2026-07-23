import { existsSync, readFileSync } from 'node:fs';

const packageRoot = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'));
const bundlePath = new URL('dist/autopilot.js', packageRoot);
if (!existsSync(bundlePath)) throw new Error('dist/autopilot.js is missing; run yarn build');
const bins = typeof manifest.bin === 'string'
  ? ['autopilot']
  : Object.keys(manifest.bin ?? {});
if (bins.join(',') !== 'autopilot') {
  throw new Error('the distributable surface must expose only the autopilot bin');
}
const bundle = readFileSync(bundlePath, 'utf8');
const forbidden = [
  'Jinn-Network/mono',
  'https://github.com/Jinn-Network/mono.git',
  'jinn-mono_worktrees',
];
for (const value of forbidden) {
  if (bundle.includes(value)) {
    throw new Error(`distributable bundle retains forbidden Jinn fallback: ${value}`);
  }
}
for (const asset of [
  'assets/engine-skills/implement-issue/SKILL.md',
  'assets/engine-skills/review-pr/SKILL.md',
  'assets/engine-skills/fix-child/SKILL.md',
  'assets/engine-skills/reconcile/SKILL.md',
  'assets/engine-skills/autopilot-runtime/SKILL.md',
  'assets/canon/active-active-lifecycle.md',
  'assets/canon/headless-override.md',
  'assets/runtime/autopilot-hermes-stateless.py',
  'assets/maintainer-skills/file-issue/SKILL.md',
  'schemas/config-v1.json',
]) {
  if (!existsSync(new URL(asset, packageRoot))) {
    throw new Error(`required distributable asset is missing: ${asset}`);
  }
}
