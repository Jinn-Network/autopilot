import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
for (const forbidden of [
  'packages/autopilot',
  'scripts/run-autopilot.ts',
  'bin/jinn-merge-batch.ts',
  'bin/jinn-run-stage.ts',
  'bin/jinn-triage-check.ts',
]) {
  if (existsSync(join(root, forbidden))) {
    throw new Error(`second or legacy engine source is forbidden: ${forbidden}`);
  }
}
const bins = readdirSync(join(root, 'bin')).filter((name) => !name.startsWith('.'));
if (bins.join(',') !== 'autopilot.ts') {
  throw new Error(`standalone source must have one public bin, found: ${bins.join(', ')}`);
}
