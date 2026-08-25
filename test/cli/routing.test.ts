import { describe, it, expect } from 'vitest';
import { shouldRouteToSession } from '../../src/cli/routing.js';

describe('shouldRouteToSession', () => {
  it('routes only the singular internal session subcommand', () => {
    expect(shouldRouteToSession(['node', 'run-autopilot.ts', 'session', 'checkpoint']))
      .toBe(true);
    expect(shouldRouteToSession(['node', 'run-autopilot.ts', 'sessions']))
      .toBe(false);
    expect(shouldRouteToSession(['node', 'run-autopilot.ts', '--once']))
      .toBe(false);
  });
});
