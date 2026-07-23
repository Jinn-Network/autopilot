import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import fixture from '../fixtures/non-jinn-autopilot-config.json';
import {
  loadRuntimeCanon,
  repositorySkillDirectories,
} from '../../src/config/runtime-assets.js';
import {
  packageCanonPaths,
  packageEngineSkillsRoot,
  packageHermesLauncherPath,
  packageRoot,
} from '../../src/package-paths.js';

const roots: string[] = [];

function repository(): {
  root: string;
  configPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'autopilot-external-repo-'));
  roots.push(root);
  mkdirSync(join(root, '.autopilot'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, '.agents', 'skills'), { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), 'EXTERNAL AGENT RULES\n');
  writeFileSync(
    join(root, 'docs', 'MAINTAINING.md'),
    'EXTERNAL MAINTAINER RULES\n',
  );
  const configPath = join(root, '.autopilot', 'config.json');
  writeFileSync(configPath, `${JSON.stringify(fixture)}\n`);
  return { root, configPath };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('installed package runtime assets', () => {
  it('resolves engine canon, skills, and stage launcher inside the package', () => {
    const root = packageRoot();
    for (const path of [
      ...packageCanonPaths(),
      packageEngineSkillsRoot(),
      packageHermesLauncherPath(),
    ]) {
      expect(path.startsWith(`${root}/`)).toBe(true);
    }
    expect(readFileSync(packageHermesLauncherPath(), 'utf8'))
      .toContain('source="autopilot"');
  });

  it('loads package canon and only explicitly configured repository instructions', () => {
    const repo = repository();
    const canon = loadRuntimeCanon(
      { AUTOPILOT_CONFIG_PATH: repo.configPath },
      repo.root,
    );

    expect(canon).toContain('Autopilot active-active lifecycle');
    expect(canon).toContain('Single-Surface Autopilot Lifecycle');
    expect(canon).toContain('EXTERNAL AGENT RULES');
    expect(canon).toContain('EXTERNAL MAINTAINER RULES');
    expect(canon).not.toContain('Jinn Network monorepo');
    expect(canon).not.toContain('Engineering handbook');
  });

  it('resolves configured repository skill directories in the attempt worktree', () => {
    const repo = repository();
    expect(repositorySkillDirectories(
      { AUTOPILOT_CONFIG_PATH: repo.configPath },
      repo.root,
    )).toEqual([realpathSync(join(repo.root, '.agents', 'skills'))]);
  });

  it('refuses instruction symlinks that escape the attempt worktree', () => {
    const repo = repository();
    const outside = mkdtempSync(join(tmpdir(), 'autopilot-outside-'));
    roots.push(outside);
    writeFileSync(join(outside, 'SECRET.md'), 'NOT ALLOWED\n');
    rmSync(join(repo.root, 'AGENTS.md'));
    symlinkSync(join(outside, 'SECRET.md'), join(repo.root, 'AGENTS.md'));

    expect(() => loadRuntimeCanon(
      { AUTOPILOT_CONFIG_PATH: repo.configPath },
      repo.root,
    )).toThrow(/escapes the repository worktree/i);
  });

  it('does not infer repository instructions when no config is supplied', () => {
    const canon = loadRuntimeCanon({}, dirname(packageRoot()));
    expect(canon).toContain('Autopilot active-active lifecycle');
    expect(canon).not.toContain('CLAUDE.md');
    expect(canon).not.toContain('Engineering handbook');
  });
});
