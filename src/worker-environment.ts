/**
 * The `CLAUDE_*` hygiene of every environment this engine hands a session
 * (#186).
 *
 * A `claude -p` worker reads its own family of variables from the
 * environment, and a daemon started from inside a Claude Code session
 * inherits that session's: `CLAUDE_CODE_CHILD_SESSION=1`, a
 * `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_PID`, the host session id. Nothing
 * scrubbed them on the way to the engine child or the workers, so on
 * 2026-09-12 every worker was born a child of an operator's session; when
 * that session ended, every worker died on startup, for 48 hours, while every
 * cycle summary read as healthy. The operator recipe (`env -u CLAUDE_… start`)
 * was the only defence, and it was skipped once.
 *
 * Kept apart from the dispatcher so the daemon can apply the same scrub to
 * the engine child it spawns without importing a launcher.
 */

/**
 * `claude -p`'s print-mode background-task ceiling.
 *
 * After the final turn the runtime waits at most this long for background
 * tasks the session started, then terminates the session. Its own default is
 * 600 s, and engine sessions routinely end their last turn with verification
 * still running, so the default kills them at the finish line after hours of
 * work (#167: one attempt ran 9 h 41 m, checkpointed, and died here — the
 * sweep was then re-claimed five more times).
 */
export const PRINT_BACKGROUND_WAIT_CEILING_ENV =
  'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS';

/**
 * The `CLAUDE_*` variables the engine sets on purpose, and so lets through.
 * Everything else under the prefix is ambient — whatever the shell the daemon
 * was started from happened to export — and is dropped. An allowlist rather
 * than a denylist of the variables the incident named: the next variable the
 * CLI adds must not reach a worker either.
 */
export const ENGINE_OWNED_CLAUDE_ENV: ReadonlySet<string> = new Set([
  PRINT_BACKGROUND_WAIT_CEILING_ENV,
]);

const AMBIENT_CLAUDE_PREFIX = 'CLAUDE_';

/** A `CLAUDE_*` variable the engine did not set itself. */
export function isAmbientClaudeEnvironmentKey(key: string): boolean {
  return key.startsWith(AMBIENT_CLAUDE_PREFIX) && !ENGINE_OWNED_CLAUDE_ENV.has(key);
}

export interface ScrubbedEnvironment {
  /** `ambient` with every ambient `CLAUDE_*` variable removed. */
  readonly env: NodeJS.ProcessEnv;
  /** The names removed, sorted, so the drop can be reported by name. */
  readonly dropped: readonly string[];
}

/**
 * The environment with every ambient `CLAUDE_*` variable removed. Pure and
 * idempotent: scrubbing a scrubbed environment drops nothing, which is what
 * lets the daemon, the engine child and the worker launcher each apply it
 * without any of them having to know whether another already did.
 */
export function withoutAmbientClaudeEnvironment(
  ambient: NodeJS.ProcessEnv,
): ScrubbedEnvironment {
  const env: NodeJS.ProcessEnv = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(ambient)) {
    if (isAmbientClaudeEnvironmentKey(key)) dropped.push(key);
    else env[key] = value;
  }
  return { env, dropped: dropped.sort() };
}
