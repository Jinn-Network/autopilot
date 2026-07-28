import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Mono repository root when the dispatcher package lives at
 * `<repo>/packages/autopilot`. Matches the historical computation in
 * `dispatch.ts` so `JINN_AUTOPILOT_PACKAGE_DIR` stays stable across layouts.
 */
export const REPO_ROOT = join(HERE, '..', '..', '..', '..');

/** Canonical autopilot package directory inside the mono tree. */
export const AUTOPILOT_PACKAGE_DIR = join(REPO_ROOT, 'packages', 'autopilot');

/**
 * Resolve the package directory every coordinator child must use, overriding
 * any ambient `JINN_AUTOPILOT_PACKAGE_DIR` the operator may have exported.
 */
export function pinnedAutopilotPackageDir(
  ambient: NodeJS.ProcessEnv = process.env,
): string {
  void ambient;
  return AUTOPILOT_PACKAGE_DIR;
}
