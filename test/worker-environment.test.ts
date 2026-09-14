import { describe, expect, it } from 'vitest';
import {
  ENGINE_OWNED_CLAUDE_ENV,
  isAmbientClaudeEnvironmentKey,
  PRINT_BACKGROUND_WAIT_CEILING_ENV,
  withoutAmbientClaudeEnvironment,
} from '../src/worker-environment.js';

/**
 * The variables the 2026-09-12 start leaked into every worker (#186): a
 * daemon started from inside a Claude Code session carried its parent's
 * child-session marker and messaging socket, and every `claude -p` died on
 * startup once that parent was gone. Spelled out so the assertions fail on
 * the exact names that reached a worker.
 */
const LEAKED_HOST_SESSION_ENV = {
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/51448.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'host-session-token',
  CLAUDE_PID: '51448',
  CLAUDE_CODE_HOST_SESSION_ID: 'host-session',
  CLAUDE_CODE_SESSION_ID: 'session',
  CLAUDE_EFFORT: 'high',
};

describe('ambient CLAUDE_* environment (#186)', () => {
  it('drops every variable the leaked start carried, and nothing else', () => {
    const { env, dropped } = withoutAmbientClaudeEnvironment({
      PATH: '/bin',
      HOME: '/home/operator',
      // No underscore: the Bash-tool marker every worker already ran under
      // while the host session lived, and not what the operator recipe scrubs.
      CLAUDECODE: '1',
      ...LEAKED_HOST_SESSION_ENV,
    });

    expect(env).toEqual({ PATH: '/bin', HOME: '/home/operator', CLAUDECODE: '1' });
    expect(dropped).toEqual(Object.keys(LEAKED_HOST_SESSION_ENV).sort());
  });

  it('keeps the ceiling the engine sets itself, by name', () => {
    expect(ENGINE_OWNED_CLAUDE_ENV.has(PRINT_BACKGROUND_WAIT_CEILING_ENV)).toBe(true);
    expect(PRINT_BACKGROUND_WAIT_CEILING_ENV).toBe('CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS');
    expect(isAmbientClaudeEnvironmentKey(PRINT_BACKGROUND_WAIT_CEILING_ENV)).toBe(false);
    expect(isAmbientClaudeEnvironmentKey('CLAUDE_CODE_CHILD_SESSION')).toBe(true);
    expect(isAmbientClaudeEnvironmentKey('CLAUDECODE')).toBe(false);

    const { env, dropped } = withoutAmbientClaudeEnvironment({
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '3600000',
      CLAUDE_CODE_CHILD_SESSION: '1',
    });
    expect(env).toEqual({ CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '3600000' });
    expect(dropped).toEqual(['CLAUDE_CODE_CHILD_SESSION']);
  });

  it('is idempotent: a scrubbed environment scrubs to itself with nothing dropped', () => {
    const once = withoutAmbientClaudeEnvironment({ PATH: '/bin', ...LEAKED_HOST_SESSION_ENV });
    const twice = withoutAmbientClaudeEnvironment(once.env);

    expect(twice.env).toEqual(once.env);
    expect(twice.dropped).toEqual([]);
  });

  it('never mutates the environment it was given', () => {
    const ambient: NodeJS.ProcessEnv = { CLAUDE_PID: '1', PATH: '/bin' };
    withoutAmbientClaudeEnvironment(ambient);
    expect(ambient).toEqual({ CLAUDE_PID: '1', PATH: '/bin' });
  });
});
