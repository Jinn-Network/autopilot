import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));

/**
 * Package root in both development (`src/package-paths.ts`) and the compiled
 * distribution (`dist/package-paths.js`).
 */
export function packageRoot(): string {
  return resolve(MODULE_DIRECTORY, '..');
}

export function packageEngineSkillsRoot(): string {
  return join(packageRoot(), 'assets', 'engine-skills');
}

export function packageCanonPaths(): readonly string[] {
  return [
    join(packageRoot(), 'assets', 'canon', 'active-active-lifecycle.md'),
    join(packageRoot(), 'assets', 'canon', 'single-surface-lifecycle.md'),
  ];
}

export function packageHeadlessOverridePath(): string {
  return join(packageRoot(), 'assets', 'canon', 'headless-override.md');
}

export function packageHermesLauncherPath(): string {
  return join(packageRoot(), 'assets', 'runtime', 'autopilot-hermes-stateless.py');
}
