import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  isDirectIssueRelayEntrypoint,
  main,
  parseIssueRelayArguments,
} from '../scripts/run-jinn-issue-relay.js';

describe('Jinn Issue Relay entrypoint', () => {
  it.each([
    [['--mode', 'observe', '--once'], { mode: 'observe', once: true }],
    [['--mode', 'recover', '--once'], { mode: 'recover', once: true }],
    [['--mode', 'active', '--once'], { mode: 'active', once: true }],
    [['--mode', 'active'], { mode: 'active', once: false }],
  ] as const)('parses the supported runtime form', (argv, expected) => {
    expect(parseIssueRelayArguments(argv)).toEqual(expected);
  });

  it.each<[string[]]>([
    [[]],
    [['--once']],
    [['--mode', 'invalid']],
    [['--mode', 'active', '--unknown']],
    [['--mode', 'active', '--once', '--once']],
  ])('rejects unsupported arguments', (argv: string[]) => {
    expect(() => parseIssueRelayArguments(argv)).toThrow(/usage|argument/i);
  });

  it('does not execute when imported by tests or the public Autopilot CLI', () => {
    const relay = '/package/scripts/run-jinn-issue-relay.ts';
    expect(isDirectIssueRelayEntrypoint(relay, pathToFileURL(relay).href))
      .toBe(true);
    expect(isDirectIssueRelayEntrypoint(
      '/package/dist/autopilot.js',
      pathToFileURL(relay).href,
    )).toBe(false);
  });

  it('passes only parsed mode/once to injectable production setup', async () => {
    const run = vi.fn(async () => {});
    await main(
      ['--mode', 'recover', '--once'],
      { JINN_ISSUE_RELAY_CONFIG: '/config.json' },
      run,
    );
    expect(run).toHaveBeenCalledWith({
      mode: 'recover',
      once: true,
      environment: { JINN_ISSUE_RELAY_CONFIG: '/config.json' },
    });
  });

  it('adds the internal issue-relay command without changing autopilot', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      readonly scripts: Record<string, string>;
    };
    expect(manifest.scripts['issue-relay'])
      .toBe('tsx scripts/run-jinn-issue-relay.ts');
    expect(manifest.scripts.autopilot).toBe('tsx scripts/run-autopilot-v2.ts');
  });
});
