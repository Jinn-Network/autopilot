import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillsRoot = join(packageRoot, 'assets', 'engine-skills');
const workflows = [
  'implement-issue',
  'review-pr',
  'fix-child',
  'reconcile',
  'autopilot-runtime',
] as const;

function skill(name: typeof workflows[number]): string {
  return readFileSync(join(skillsRoot, name, 'SKILL.md'), 'utf8');
}

function textFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? textFiles(path) : [path];
  });
}

describe('distributable engine workflow assets', () => {
  it('ships every V2 workflow and runtime adapter inside the package', () => {
    for (const workflow of workflows) {
      expect(existsSync(join(skillsRoot, workflow, 'SKILL.md'))).toBe(true);
    }
    for (const runtime of ['claude', 'hermes', 'cursor']) {
      expect(existsSync(join(
        skillsRoot,
        'autopilot-runtime',
        'references',
        `${runtime}.md`,
      ))).toBe(true);
    }
  });

  it('uses the installed CLI and injected canon instead of jinn-mono paths', () => {
    for (const path of textFiles(join(packageRoot, 'assets'))) {
      const document = readFileSync(path, 'utf8');
      expect(document).not.toContain('<repo-root>/packages/autopilot');
      expect(document).not.toContain('../../../CLAUDE.md');
      expect(document).not.toContain('../../../docs/engineering/handbook.md');
      expect(document).not.toContain('yarn --cwd "$AUTOPILOT_PACKAGE_DIR"');
      expect(document).not.toContain('WORKTREE_PATH/packages/autopilot');
      expect(document).not.toContain('Jinn-Network/mono');
      expect(document).not.toContain('jinn-mono_worktrees');
    }
    expect(skill('implement-issue')).toContain('autopilot session checkpoint');
    expect(skill('review-pr')).toContain('autopilot session review-verdict');
  });

  it('keeps Jinn product validation out of the generic implementer', () => {
    const document = skill('implement-issue');
    expect(document).not.toContain('testing-jinn-app');
    expect(document).not.toContain('Jinn-app test');
    expect(document).toContain('Repository validation');
  });

  it('ships package-owned lifecycle canon', () => {
    expect(existsSync(join(
      packageRoot,
      'assets',
      'canon',
      'active-active-lifecycle.md',
    ))).toBe(true);
    expect(existsSync(join(
      packageRoot,
      'assets',
      'canon',
      'single-surface-lifecycle.md',
    ))).toBe(true);
  });
});
