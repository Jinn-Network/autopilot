import { describe, expect, it } from 'vitest';
import {
  parseAutopilotArguments,
  type AutopilotCommand,
} from '../../src/cli/arguments.js';

describe('public Autopilot CLI grammar', () => {
  it.each<[string[], AutopilotCommand]>([
    [[], { kind: 'help' }],
    [['init'], { kind: 'init', nonInteractive: false }],
    [['init', '--non-interactive', '--project', 'Octo-Labs/73'], {
      kind: 'init',
      nonInteractive: true,
      project: 'Octo-Labs/73',
    }],
    [['doctor', '--json'], { kind: 'doctor', json: true }],
    [['start'], { kind: 'start', foreground: false }],
    [['start', '--foreground'], { kind: 'start', foreground: true }],
    [['stop', '--force'], { kind: 'stop', force: true }],
    [['status', '--json'], { kind: 'status', json: true }],
    [['explain', 'issue', '42'], {
      kind: 'explain',
      subject: 'issue',
      number: 42,
      json: false,
    }],
    [['explain', 'pr', '9', '--json'], {
      kind: 'explain',
      subject: 'pr',
      number: 9,
      json: true,
    }],
    [['logs', 'attempt-abc', '--follow'], {
      kind: 'logs',
      attempt: 'attempt-abc',
      follow: true,
    }],
    [['observe', '--full-reconcile', '--json'], {
      kind: 'observe',
      once: true,
      json: true,
      fullReconcile: true,
    }],
    [['recover', '--once'], { kind: 'recover', once: true, json: false }],
    [['skills', 'update', '--apply'], {
      kind: 'skills-update',
      apply: true,
      force: false,
    }],
    [['upgrade', '--version', '0.2.0'], { kind: 'upgrade', version: '0.2.0' }],
    [['triage', '--json'], { kind: 'triage', json: true }],
    [['issue', 'create', '--input', '/tmp/issue.json'], {
      kind: 'issue-create',
      input: '/tmp/issue.json',
      apply: false,
    }],
    [['issue', 'triage', '42', '--input', '/tmp/triage.json', '--apply'], {
      kind: 'issue-triage',
      number: 42,
      input: '/tmp/triage.json',
      apply: true,
    }],
  ])('parses %j', (input, expected) => {
    expect(parseAutopilotArguments(input)).toEqual(expected);
  });

  it('rejects unknown options and invalid issue identifiers', () => {
    expect(() => parseAutopilotArguments(['doctor', '--repair']))
      .toThrow(/unknown option/i);
    expect(() => parseAutopilotArguments([
      'issue', 'triage', '../42', '--input', 'x',
    ])).toThrow(/positive integer/i);
  });

  it.each([
    ['init', '--token', 'secret'],
    ['init', '--implement-token=secret'],
    ['doctor', '--github-review-token', 'secret'],
  ])('never accepts token values in argv: %j', (...input) => {
    expect(() => parseAutopilotArguments(input)).toThrow(
      /never accepted on the command line/i,
    );
  });

  it('keeps mutation helpers dry-run unless --apply is explicit', () => {
    expect(parseAutopilotArguments([
      'issue', 'create', '--input', 'issue.json',
    ])).toMatchObject({ kind: 'issue-create', apply: false });
    expect(parseAutopilotArguments([
      'skills', 'update',
    ])).toMatchObject({ kind: 'skills-update', apply: false });
  });
});
