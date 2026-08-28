import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NEEDS_HUMAN_LABEL,
  hasExternalHumanLabel,
} from '../src/lifecycle/human-authority.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..', 'src');

const LEGACY_LABEL = 'autopilot:human';

/** Files still permitted to name the legacy alias: the read paths that tolerate it. */
const TOLERATED_READ_SITES = ['lifecycle/human-authority.ts'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('one human-hold label', () => {
  it('names review:needs-human as the canonical label', () => {
    expect(NEEDS_HUMAN_LABEL).toBe('review:needs-human');
  });

  it('still honours the legacy alias on read, so live repositories keep working', () => {
    expect(hasExternalHumanLabel([LEGACY_LABEL])).toBe(true);
    expect(hasExternalHumanLabel([NEEDS_HUMAN_LABEL])).toBe(true);
  });

  it('confines the legacy alias to the tolerated read paths', () => {
    const offenders = sourceFiles(srcRoot)
      .filter((file) => readFileSync(file, 'utf8').includes(LEGACY_LABEL))
      .map((file) => relative(srcRoot, file).split('\\').join('/'))
      .filter((file) => !TOLERATED_READ_SITES.includes(file));

    expect(offenders).toEqual([]);
  });
});
