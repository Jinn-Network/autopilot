import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageRoot } from '../src/package-paths.js';

function skill(name: string): string {
  return readFileSync(join(
    packageRoot(),
    'assets',
    'maintainer-skills',
    name,
    'SKILL.md',
  ), 'utf8');
}

describe('maintainer skills RED/GREEN pressure contracts', () => {
  it('file-issue closes the baseline ambiguity and direct-mutation loopholes', () => {
    const baseline = 'File the issue with gh.';
    expect(baseline).not.toMatch(/binary acceptance criteria/i);
    expect(baseline).not.toMatch(/preview/i);

    const guided = skill('file-issue');
    expect(guided).toMatch(/binary acceptance criteria/i);
    expect(guided).toMatch(/confirm the Issue Type.*Effort.*Priority/is);
    expect(guided).toContain('autopilot issue create --input <json-file>');
    expect(guided).toContain('--apply');
    expect(guided).toMatch(/Never call `gh issue create` directly/i);
  });

  it('triage closes the baseline bulk-edit and invented-state loopholes', () => {
    const baseline = 'Triage all issues and fix their fields.';
    expect(baseline).not.toMatch(/selected issues/i);
    expect(baseline).not.toMatch(/Never invent a Sprint/i);

    const guided = skill('triage-for-autopilot');
    expect(guided).toMatch(/select issues/i);
    expect(guided).toMatch(/Never invent a Sprint/i);
    expect(guided).toContain('autopilot issue triage <N> --input <json-file>');
    expect(guided).toMatch(/Apply only confirmed/i);
  });

  it('explain closes the baseline lifecycle-invention and mutation loopholes', () => {
    const baseline = 'Inspect GitHub and decide what Autopilot is doing.';
    expect(baseline).not.toMatch(/Never infer a state/i);
    expect(baseline).not.toMatch(/read-only/i);

    const guided = skill('explain-autopilot');
    expect(guided).toMatch(/read-only evidence commands/i);
    expect(guided).toMatch(/Never infer a state/i);
    expect(guided).toMatch(/merge-ready.*manual policy/is);
    expect(guided).toMatch(/Do not mutate/i);
  });

  it('keeps generic product rules free of Jinn repository policy', () => {
    for (const name of [
      'file-issue',
      'triage-for-autopilot',
      'explain-autopilot',
    ]) {
      const content = skill(name);
      expect(content).not.toContain('Jinn-Network/mono');
      expect(content).not.toContain('jinn-app');
      expect(content).not.toContain('DR-');
    }
  });
});
