import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Effort } from './types.js';

export const CODEX_BIN_ENV = 'JINN_DISPATCHER_CODEX_BIN';
export const CODEX_MODEL_ENV = 'JINN_DISPATCHER_CODEX_MODEL';
export const DEFAULT_CODEX_BIN = 'codex';

/**
 * Board Effort → Codex `model_reasoning_effort`. Codex's ceiling is `xhigh`,
 * so `Max` maps there; an absent effort leaves the operator's own
 * `~/.codex/config.toml` default in force, exactly as `claude -p` without
 * `--effort` leaves Claude Code's.
 */
export function codexReasoningEffort(effort: Effort | null): string | null {
  switch (effort) {
    case 'Low':
      return 'low';
    case 'Medium':
      return 'medium';
    case 'High':
      return 'high';
    case 'XHigh':
    case 'Max':
      return 'xhigh';
    default:
      return null;
  }
}

/**
 * `codex exec` arguments for one unattended coordinator session (#152).
 *
 * Mirrors the `claude -p --effort <e> <prompt>` launch: the prompt is the
 * positional argument, the worktree is the working directory, and approvals
 * are bypassed because nobody is there to answer them — the detached worktree
 * is the isolation, as it is for every other runtime. The model is passed only
 * when the operator configured one; otherwise Codex's own default applies.
 */
export function codexExecArgs(
  prompt: string,
  opts: { model?: string | undefined; effort: Effort | null; workspace: string },
): string[] {
  const reasoning = codexReasoningEffort(opts.effort);
  return [
    'exec',
    '-C', opts.workspace,
    '--dangerously-bypass-approvals-and-sandbox',
    ...(opts.model === undefined ? [] : ['-m', opts.model]),
    ...(reasoning === null ? [] : ['-c', `model_reasoning_effort=${reasoning}`]),
    prompt,
  ];
}

export interface CodexProbeResult {
  status: number | null;
  stderr?: string | Buffer | null;
  error?: Error;
}

export type CodexProbe = (
  command: string,
  args: readonly string[],
) => CodexProbeResult;

const runCodexVersionProbe: CodexProbe = (command, args) => {
  const result = spawnSync(command, [...args], { encoding: 'utf8' });
  return {
    status: result.status,
    stderr: result.stderr,
    ...(result.error ? { error: result.error } : {}),
  };
};

function conciseProbeDetail(raw: string): string {
  const lastLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? '';
  return lastLine.length > 500 ? `${lastLine.slice(0, 497)}...` : lastLine;
}

/**
 * The cheapest proof the Codex CLI is launchable: a version probe. Run at
 * preflight whenever a cycle could dispatch to Codex — as the process-wide
 * runtime, or as overflow — so a missing or broken binary fails the cycle
 * with one clear line instead of failing every worker it would have spawned.
 */
export function assertCodexRuntimeReady(
  binPath: string,
  deps: {
    exists?: (path: string) => boolean;
    probe?: CodexProbe;
  } = {},
): void {
  const exists = deps.exists ?? existsSync;
  if (binPath.includes('/') && !exists(binPath)) {
    throw new Error(
      `[autopilot] Codex CLI is missing: ${binPath}. ` +
        `Set ${CODEX_BIN_ENV} to the codex binary path or install the Codex CLI.`,
    );
  }
  const result = (deps.probe ?? runCodexVersionProbe)(binPath, ['--version']);
  if (result.status === 0 && result.error == null) return;
  const stderr = result.stderr == null
    ? ''
    : (typeof result.stderr === 'string'
        ? result.stderr
        : result.stderr.toString('utf8')).trim();
  const detail = conciseProbeDetail(result.error?.message ?? stderr)
    || `probe exited with status ${String(result.status)}`;
  throw new Error(
    `[autopilot] Codex runtime probe failed for ${binPath}: ${detail}. ` +
      'Run `codex login`, then retry.',
  );
}
