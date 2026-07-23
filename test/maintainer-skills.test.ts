import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import fixture from './fixtures/non-jinn-autopilot-config.json';
import {
  MAINTAINER_SKILL_PACK_VERSION,
  updateMaintainerSkills,
} from '../src/maintainer-skills.js';
import { decodeAutopilotConfig } from '../src/config/config.js';

const roots: string[] = [];
const config = decodeAutopilotConfig(fixture);

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'autopilot-skills-'));
  roots.push(root);
  mkdirSync(join(root, '.autopilot'), { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('maintainer skill pack updates', () => {
  it('is dry-run by default and installs real skill directories only with apply', () => {
    const root = repository();
    const preview = updateMaintainerSkills({
      repositoryRoot: root,
      config,
      apply: false,
      force: false,
    });
    expect(preview.changed).toEqual([
      'explain-autopilot/SKILL.md',
      'file-issue/SKILL.md',
      'triage-for-autopilot/SKILL.md',
    ]);
    expect(preview.apply).toBe(false);
    expect(existsSync(join(root, '.codex', 'skills'))).toBe(false);

    const applied = updateMaintainerSkills({
      repositoryRoot: root,
      config,
      apply: true,
      force: false,
    });
    expect(applied.apply).toBe(true);
    expect(existsSync(join(
      root,
      '.codex',
      'skills',
      'file-issue',
      'SKILL.md',
    ))).toBe(true);
    const lock = JSON.parse(readFileSync(
      join(root, '.autopilot', 'skills.lock.json'),
      'utf8',
    )) as { version: string; files: Record<string, string> };
    expect(lock.version).toBe(MAINTAINER_SKILL_PACK_VERSION);
    expect(Object.keys(lock.files)).toHaveLength(3);
  });

  it('updates an unmodified installed file', () => {
    const root = repository();
    const source = mkdtempSync(join(tmpdir(), 'autopilot-skill-source-'));
    roots.push(source);
    mkdirSync(join(source, 'file-issue'), { recursive: true });
    writeFileSync(join(source, 'file-issue', 'SKILL.md'), 'version one\n');
    updateMaintainerSkills({
      repositoryRoot: root,
      config,
      apply: true,
      force: false,
      sourceRoot: source,
    });
    writeFileSync(join(source, 'file-issue', 'SKILL.md'), 'version two\n');

    const report = updateMaintainerSkills({
      repositoryRoot: root,
      config,
      apply: true,
      force: false,
      sourceRoot: source,
    });
    expect(report.conflicts).toEqual([]);
    expect(readFileSync(
      join(root, '.codex', 'skills', 'file-issue', 'SKILL.md'),
      'utf8',
    )).toBe('version two\n');
  });

  it('leaves every file untouched when any local edit conflicts', () => {
    const root = repository();
    updateMaintainerSkills({
      repositoryRoot: root,
      config,
      apply: true,
      force: false,
    });
    const fileIssue = join(
      root,
      '.codex',
      'skills',
      'file-issue',
      'SKILL.md',
    );
    const explain = join(
      root,
      '.codex',
      'skills',
      'explain-autopilot',
      'SKILL.md',
    );
    writeFileSync(fileIssue, 'local maintainer edit\n');
    const explainBefore = readFileSync(explain, 'utf8');

    const report = updateMaintainerSkills({
      repositoryRoot: root,
      config,
      apply: true,
      force: false,
    });
    expect(report.apply).toBe(false);
    expect(report.conflicts).toEqual(['file-issue/SKILL.md']);
    expect(readFileSync(fileIssue, 'utf8')).toBe('local maintainer edit\n');
    expect(readFileSync(explain, 'utf8')).toBe(explainBefore);
  });

  it('overwrites local edits only with force', () => {
    const root = repository();
    updateMaintainerSkills({
      repositoryRoot: root,
      config,
      apply: true,
      force: false,
    });
    const fileIssue = join(
      root,
      '.codex',
      'skills',
      'file-issue',
      'SKILL.md',
    );
    writeFileSync(fileIssue, 'local edit\n');

    const report = updateMaintainerSkills({
      repositoryRoot: root,
      config,
      apply: true,
      force: true,
    });
    expect(report.apply).toBe(true);
    expect(readFileSync(fileIssue, 'utf8')).toContain('# File an issue');
  });
});
