import {
  readFileSync,
  realpathSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
} from 'node:path';
import { decodeAutopilotConfig, type AutopilotConfig } from './config.js';
import { packageCanonPaths } from '../package-paths.js';

export const AUTOPILOT_CONFIG_PATH_ENV = 'AUTOPILOT_CONFIG_PATH';

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function configured(
  environment: NodeJS.ProcessEnv,
): AutopilotConfig | null {
  const configPath = environment[AUTOPILOT_CONFIG_PATH_ENV];
  if (configPath == null || configPath === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Cannot load Autopilot runtime configuration at ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return decodeAutopilotConfig(parsed);
}

function confinedExistingPath(
  repositoryRoot: string,
  repositoryRelativePath: string,
): string {
  const realRoot = realpathSync(repositoryRoot);
  const candidate = realpathSync(resolve(repositoryRoot, repositoryRelativePath));
  if (!isInside(realRoot, candidate)) {
    throw new Error(
      `Configured repository path '${repositoryRelativePath}' escapes the repository worktree`,
    );
  }
  return candidate;
}

/**
 * Runtime canon consists of immutable package-owned lifecycle documents plus
 * only the instruction files named by the repository configuration.
 */
export function loadRuntimeCanon(
  environment: NodeJS.ProcessEnv = process.env,
  repositoryRoot?: string,
): string {
  const config = configured(environment);
  const configuredRoot = environment[AUTOPILOT_CONFIG_PATH_ENV] == null
    ? undefined
    : dirname(dirname(environment[AUTOPILOT_CONFIG_PATH_ENV]));
  const worktreeRoot = repositoryRoot ?? configuredRoot;
  if (config != null && worktreeRoot == null) {
    throw new Error('Autopilot runtime configuration has no repository root');
  }

  const sections = packageCanonPaths().map((path) => ({
    title: `Packaged lifecycle canon: ${path.split('/').at(-1) ?? path}`,
    body: readFileSync(path, 'utf8').trim(),
  }));

  if (config != null && worktreeRoot != null) {
    for (const path of config.repository.instructionFiles) {
      sections.push({
        title: `Repository instruction: ${path}`,
        body: readFileSync(confinedExistingPath(worktreeRoot, path), 'utf8').trim(),
      });
    }
  }

  return sections
    .map(({ title, body }) => `# ${title}\n\n${body}`)
    .join('\n\n');
}

export function repositorySkillDirectories(
  environment: NodeJS.ProcessEnv = process.env,
  repositoryRoot?: string,
): readonly string[] {
  const config = configured(environment);
  if (config == null) return [];
  const configuredRoot = dirname(dirname(
    environment[AUTOPILOT_CONFIG_PATH_ENV] as string,
  ));
  const worktreeRoot = repositoryRoot ?? configuredRoot;
  return config.worker.repositorySkillDirectories.map((path) =>
    confinedExistingPath(worktreeRoot, path));
}
