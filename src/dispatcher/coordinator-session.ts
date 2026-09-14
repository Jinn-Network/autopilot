import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildCodexHeadlessPrompt,
  buildCursorHeadlessPrompt,
  buildHeadlessPrompt,
  buildHermesHeadlessPrompt,
} from '../headless.js';
import type { AutopilotRuntime } from '../autopilot-runtime.js';
import { codexExecArgs, CODEX_BIN_ENV, CODEX_MODEL_ENV } from './codex-runtime.js';
import {
  prepareHermesHome,
  type HermesHomeOpts,
} from './hermes-home.js';
import {
  cursorAgentArgs,
  cursorModelForEffort,
  CURSOR_BIN_ENV,
  CURSOR_MODEL_ENV,
} from './cursor-runtime.js';
import { hermesChatArgs } from './hermes-runtime.js';
import type { DispatcherConfig, Effort } from './types.js';
import {
  loadRuntimeCanon,
  repositorySkillDirectories,
} from '../config/runtime-assets.js';
import { packageRoot } from '../package-paths.js';
import { terminateProcessGroup } from '../process-group.js';
import {
  PRINT_BACKGROUND_WAIT_CEILING_ENV,
  withoutAmbientClaudeEnvironment,
} from '../worker-environment.js';

export { PRINT_BACKGROUND_WAIT_CEILING_ENV } from '../worker-environment.js';

export interface SpawnResult {
  pid: number | undefined;
}

export type SpawnExitHandler = (
  code: number | null,
  signal: NodeJS.Signals | null,
) => void;

export interface CoordinatorSpawnOptions {
  cwd: string;
  detached: boolean;
  stdio: 'ignore' | Array<string | number | null>;
  env?: NodeJS.ProcessEnv;
  logPath?: string;
  startedAtMarkerPath?: string;
  onExit?: SpawnExitHandler;
  [key: string]: unknown;
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: CoordinatorSpawnOptions,
) => SpawnResult;

export type CoordinatorSessionKind = 'implement' | 'review';
export type CoordinatorSkill =
  | 'implement-issue'
  | 'review-pr'
    | 'fix-child'
  | 'reconcile';

export interface CoordinatorSessionSpec {
  kind: CoordinatorSessionKind;
  number: number;
  skill: CoordinatorSkill;
  scenario: string;
  worktreePath: string;
  /** Only implementation supplies board Effort; other sessions pass null. */
  effort: Effort | null;
  /**
   * Overrides the process-wide runtime for this one session (#152): the
   * scheduler sets it when it routes a claim to the Codex overflow pool.
   * Absent, the session runs on `cfg.runtime` exactly as before.
   */
  runtime?: AutopilotRuntime;
  /** Identity and caller-specific child-stage environment. */
  env: NodeJS.ProcessEnv;
  spawnOptions: {
    detached: boolean;
    stdio: 'ignore' | Array<string | number | null>;
    logPath?: string;
    startedAtMarkerPath?: string;
    onExit?: SpawnExitHandler;
    [key: string]: unknown;
  };
}

export interface CoordinatorSessionDeps {
  spawn: SpawnFn;
  prepareHermesHome?: (
    opts: HermesHomeOpts,
  ) => { hermesHome: string };
  log?: (message: string) => void;
  /**
   * Bounded SIGTERM -> SIGKILL of an exited worker's process group, returning
   * how many signals were delivered. Injectable so tests never signal a
   * fixture PID; production tears the real group down (#167).
   */
  terminateProcessGroup?: (pid: number) => Promise<number>;
  /**
   * Reads the operator's ambient `~/.claude.json`, or nothing when it cannot
   * be read. Injectable so a test can declare an ambient server set without
   * touching the operator's real home (#182).
   */
  readTextFile?: (path: string) => string | undefined;
  /** Writes the engine-owned MCP document beside the session log (#182). */
  writeWorkerMcpConfig?: (path: string, contents: string) => void;
}

/**
 * Windows has no process groups to signal, and `detached` means something
 * else there, so teardown is a no-op rather than a throw.
 */
function defaultTerminateProcessGroup(pid: number): Promise<number> {
  return process.platform === 'win32'
    ? Promise.resolve(0)
    : terminateProcessGroup({ pid });
}

/** Canon is explicit because neither headless runtime auto-loads it reliably. */
export function loadCanon(
  environment: NodeJS.ProcessEnv = process.env,
  repositoryRoot?: string,
): string {
  return loadRuntimeCanon(environment, repositoryRoot);
}

/**
 * The ceiling overlay for one `claude -p` session, or nothing when the
 * operator has already exported the variable: an explicit export is a
 * deliberate override of the configured value and outranks it. Inside a
 * worker the "export" is the engine's own value, which is how a nested stage
 * session (#184) ends up on the same ceiling as its parent.
 */
function printBackgroundWaitCeiling(
  ambient: NodeJS.ProcessEnv,
  backgroundWaitCeilingMs: number,
): NodeJS.ProcessEnv {
  const exported = ambient[PRINT_BACKGROUND_WAIT_CEILING_ENV];
  if (exported !== undefined && exported.length > 0) return {};
  return {
    [PRINT_BACKGROUND_WAIT_CEILING_ENV]: String(backgroundWaitCeilingMs),
  };
}

/** Map board Effort to Claude's CLI flag; null keeps the runtime default. */
export function effortFlag(effort: Effort | null): string[] {
  return effort == null ? [] : ['--effort', effort.toLowerCase()];
}

/** The engine-owned MCP document, written beside the attempt's session log. */
export const WORKER_MCP_CONFIG_FILENAME = 'mcp-config.json';

/**
 * Carries a worker's MCP grant — the `--mcp-config` operand it was launched
 * on, a file path or the inline document — into its environment, so the
 * nested stage sessions it launches through `internal run-stage` are put on
 * the same grant (#184). Nothing else reads it.
 */
export const WORKER_MCP_CONFIG_ENV = 'JINN_AUTOPILOT_WORKER_MCP_CONFIG';

/** The grant a stage falls back to when its worker carried none: no servers. */
export const EMPTY_WORKER_MCP_DOCUMENT = '{"mcpServers":{}}';

export interface ClaudeWorkerLaunchInput {
  readonly prompt: string;
  readonly effort: Effort | null;
  readonly model?: string;
  /** The MCP document operand: a path beside the session log, or inline JSON. */
  readonly mcpConfig: string;
  readonly backgroundWaitCeilingMs: number;
  /** What the child would inherit; the returned `env` is built from it. */
  readonly ambient: NodeJS.ProcessEnv;
}

export interface ClaudeWorkerLaunch {
  readonly args: string[];
  /** The child's whole environment: `ambient` scrubbed, plus the contract. */
  readonly env: NodeJS.ProcessEnv;
}

/**
 * The worker contract for one `claude -p` session: argv and environment.
 * The coordinator's claude branch and the nested stage sessions a worker
 * launches (`run-stage.ts`) both build here, so a session of the engine's
 * cannot be launched without `--strict-mcp-config` (#182), the
 * background-wait ceiling (#167), or the `CLAUDE_*` scrub (#186) — #184
 * found stage sessions launched with neither of the first two, running the
 * operator's ambient servers under a third-party repository.
 *
 * The environment is the whole child environment rather than an overlay
 * because a scrub cannot be expressed as one: the ambient `CLAUDE_*`
 * variables (a parent session's id, socket and pid) are removed, then the
 * engine's own are set. The ceiling is read from the ambient environment
 * before the scrub, so an exported one still outranks the configured value.
 *
 * ORDER IS LOAD-BEARING: `--mcp-config <configs...>` is variadic and consumes
 * operands greedily until the next flag, so the document is followed by
 * `--strict-mcp-config` and the prompt stays the last operand. Put the prompt
 * between them and the CLI reads it as a second MCP document.
 */
export function claudeWorkerLaunch(input: ClaudeWorkerLaunchInput): ClaudeWorkerLaunch {
  return {
    args: [
      '-p',
      ...effortFlag(input.effort),
      ...(input.model === undefined ? [] : ['--model', input.model]),
      '--mcp-config', input.mcpConfig, '--strict-mcp-config',
      input.prompt,
    ],
    env: {
      ...withoutAmbientClaudeEnvironment(input.ambient).env,
      ...printBackgroundWaitCeiling(input.ambient, input.backgroundWaitCeilingMs),
      [WORKER_MCP_CONFIG_ENV]: input.mcpConfig,
    },
  };
}

/** The operator's user-level Claude config, relative to `HOME`. */
const AMBIENT_CLAUDE_CONFIG_FILENAME = '.claude.json';

/**
 * `claude -p`'s MCP document operand for one worker: the engine's own server
 * grant, which `claudeWorkerLaunch` pairs with a refusal of every other MCP
 * configuration (#182).
 *
 * Without them a worker loads the operator's user-level `~/.claude.json` and
 * starts whatever it declares, so its toolset is decided by whoever last ran
 * `claude` on the host rather than by the engine — a live browser bridge and
 * a personal data store under sessions acting on third-party repositories, and
 * two extra processes per worker across the whole concurrency width.
 *
 * The document is a file beside the session log when the caller named one —
 * every production attempt does — so the argv (and the process listing that
 * shows it) stays readable and the grant is inspectable after the fact. A
 * caller with no log path, or an attempt directory that cannot be written,
 * gets the same document inline, which the CLI accepts as a JSON string.
 * Nothing about the isolation differs between the two, which is why the write
 * is allowed to fail: an unwritable file would otherwise cost a whole attempt
 * to protect a convenience, and the fallback is announced rather than hidden.
 */
function workerMcpConfig(
  spec: CoordinatorSessionSpec,
  cfg: DispatcherConfig,
  writeConfig: (path: string, contents: string) => void,
  log: (message: string) => void,
): string {
  const document = JSON.stringify({ mcpServers: cfg.mcpServers });
  const logPath = spec.spawnOptions.logPath;
  if (logPath === undefined) return document;
  const configPath = join(dirname(logPath), WORKER_MCP_CONFIG_FILENAME);
  try {
    writeConfig(configPath, document);
  } catch {
    log(
      `[autopilot] worker mcp: could not write ${configPath}; `
        + 'passing the grant inline',
    );
    return document;
  }
  return configPath;
}

/**
 * The MCP server names the operator's ambient config declares, or none.
 *
 * Fail-safe by construction: an unset `HOME`, an absent or unreadable file,
 * malformed JSON and a config with no `mcpServers` map all read as "no ambient
 * servers". This is read for one log line and nothing else — a worker is
 * isolated whether or not the file can be read, so no failure here may reach
 * the launch.
 */
function ambientMcpServerNames(
  environment: NodeJS.ProcessEnv,
  readTextFile: (path: string) => string | undefined,
): string[] {
  const home = environment.HOME;
  if (home === undefined || home.length === 0) return [];
  const raw = readTextFile(join(home, AMBIENT_CLAUDE_CONFIG_FILENAME));
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (
    typeof servers !== 'object'
    || servers === null
    || Array.isArray(servers)
  ) return [];
  return Object.keys(servers as Record<string, unknown>);
}

/**
 * Cycles that have already reported the ambient servers they drop, keyed on
 * the sink the line would be written to (#182).
 *
 * The daemon runs one `internal engine --mode active --once` child per cycle,
 * so a `WeakSet` on the log sink — `console.log` in production, one object for
 * the life of that process — is once per cycle, and every worker after the
 * first in the same cycle would only repeat it. It is deliberately not
 * persisted: a cycle that starts after the operator adds a server says so
 * again, which is the point of the line. Two engines in one process, and two
 * tests in one file, keep their own sinks and never pool.
 */
const reportedAmbientMcpSinks = new WeakSet<object>();

/**
 * One line naming the ambient MCP servers this engine is refusing to pass on,
 * so the difference between "the engine grants nothing" and "the operator
 * configured nothing" is visible rather than inferred.
 */
function reportDroppedAmbientMcpServers(
  spec: CoordinatorSessionSpec,
  cfg: DispatcherConfig,
  readTextFile: (path: string) => string | undefined,
  log: (message: string) => void,
): void {
  if (reportedAmbientMcpSinks.has(log)) return;
  reportedAmbientMcpSinks.add(log);
  const dropped = ambientMcpServerNames(spec.env, readTextFile)
    .filter((name) => !Object.hasOwn(cfg.mcpServers, name));
  if (dropped.length === 0) return;
  log(
    `[autopilot] worker mcp: ignoring ${dropped.length} ambient server(s) `
      + `(${dropped.join(', ')})`,
  );
}

/**
 * Cycles that have already reported the ambient `CLAUDE_*` variables they
 * drop (#186), keyed the same way as {@link reportedAmbientMcpSinks} and for
 * the same reasons: once per engine process is once per cycle, and a fresh
 * cycle under a fresh environment says so again.
 */
const reportedAmbientClaudeEnvSinks = new WeakSet<object>();

/**
 * One line naming the ambient `CLAUDE_*` variables this engine is refusing
 * to pass on, so a daemon started from inside a Claude Code session is
 * visible in the log as such rather than only as a fleet of instant deaths.
 */
function reportDroppedAmbientClaudeEnv(
  dropped: readonly string[],
  log: (message: string) => void,
): void {
  if (reportedAmbientClaudeEnvSinks.has(log)) return;
  reportedAmbientClaudeEnvSinks.add(log);
  if (dropped.length === 0) return;
  log(
    `[autopilot] worker env: dropping ${dropped.length} ambient CLAUDE_* var(s) `
      + `(${dropped.join(', ')})`,
  );
}

/** Absent, unreadable or unparseable all read the same: no ambient servers. */
function readTextFileOrNothing(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Owner-only: the grant is the engine's, and no worker may rewrite it. */
function writeWorkerMcpConfigFile(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o600 });
}

function resolveCursorSessionModel(
  kind: CoordinatorSessionKind,
  effort: Effort | null,
  cfg: DispatcherConfig,
): string {
  return kind === 'implement'
    ? cursorModelForEffort(effort)
    : cfg.cursorModel;
}

/**
 * Launch one AI coordinator through the process-wide runtime.
 *
 * Runtime selection lives only here: callers retain their lifecycle, cleanup,
 * logging paths, worktrees, and GitHub identities.
 */
function composeExitHandler(
  sessionId: string,
  spec: CoordinatorSessionSpec,
  log: (message: string) => void,
  getPid: () => number | undefined,
  callerOnExit: SpawnExitHandler | undefined,
  tearDown: (pid: number) => Promise<number>,
): SpawnExitHandler {
  return (code, signal) => {
    const pid = getPid();
    const logPath = spec.spawnOptions.logPath;
    log(
      `[autopilot] coordinator exit session=${sessionId} ` +
        `pid=${pid ?? 'unknown'} ` +
        `code=${code ?? 'null'} signal=${signal ?? 'null'}` +
        (logPath === undefined ? '' : ` log=${logPath}`),
    );
    callerOnExit?.(code, signal);
    if (pid === undefined) return;
    // The worker is a group leader (`detached`), so this reaches the test
    // runners, servers and verification jobs it started. Without it they
    // survive as orphans holding a worktree the sweep is about to remove
    // (#167). Advisory and un-awaited: the exit handler is synchronous, and
    // no cleanup failure may propagate into the caller's exit bookkeeping.
    void tearDown(pid).then((signalled) => {
      if (signalled === 0) return;
      log(
        `[autopilot] coordinator teardown session=${sessionId} ` +
          `pgid=${pid} signalled=${signalled}`,
      );
    }).catch(() => {
      // A group that cannot be signalled is the sweep's problem now: it
      // refuses to delete a worktree that still hosts a live process.
    });
  };
}

export function spawnCoordinatorSession(
  spec: CoordinatorSessionSpec,
  cfg: DispatcherConfig,
  deps: CoordinatorSessionDeps,
): SpawnResult {
  const sessionId = `${spec.kind}-${spec.number}`;
  const log = deps.log ?? console.log;
  let spawnedPid: number | undefined;
  const { onExit: callerOnExit, ...spawnOptions } = spec.spawnOptions;
  const composedOnExit = composeExitHandler(
    sessionId,
    spec,
    log,
    () => spawnedPid,
    callerOnExit,
    deps.terminateProcessGroup ?? defaultTerminateProcessGroup,
  );
  const runtime = spec.runtime ?? cfg.runtime;
  const runtimePrompt = runtime === 'hermes'
    ? buildHermesHeadlessPrompt(spec.skill, spec.scenario)
    : runtime === 'cursor'
      ? buildCursorHeadlessPrompt(spec.skill, spec.scenario)
      : runtime === 'codex'
        ? buildCodexHeadlessPrompt(spec.skill, spec.scenario)
        : buildHeadlessPrompt(spec.skill, spec.scenario);
  const prompt = [
    loadCanon(spec.env, spec.worktreePath),
    '',
    runtimePrompt,
  ].join('\n');
  // Every runtime, not only claude: the scrub is about what the environment
  // carries, not which binary reads it (#186). Reported once per cycle.
  const scrubbed = withoutAmbientClaudeEnvironment(spec.env);
  reportDroppedAmbientClaudeEnv(scrubbed.dropped, log);
  const env: NodeJS.ProcessEnv = {
    ...scrubbed.env,
    JINN_AUTOPILOT_RUNTIME: runtime,
    // Overrides any ambient JINN_AUTOPILOT_PACKAGE_DIR the operator may have
    // exported: pinned to this package's real root (works from `src/` and
    // from the bundled `dist/autopilot.js` alike), not derived from it.
    JINN_AUTOPILOT_PACKAGE_DIR: packageRoot(),
  };
  let result: SpawnResult;

  if (runtime === 'hermes') {
    const home = (deps.prepareHermesHome ?? prepareHermesHome)({
      sessionId,
      worktreePath: spec.worktreePath,
      effort: spec.effort,
      cfg,
      homesRoot: spec.env.AUTOPILOT_HERMES_HOMES_DIR,
      repositorySkillDirectories: repositorySkillDirectories(
        spec.env,
        spec.worktreePath,
      ),
    });
    result = deps.spawn(
      cfg.hermesPythonPath,
      hermesChatArgs(prompt, {
        model: cfg.hermesModel,
        provider: cfg.hermesProvider,
      }),
      {
        ...spawnOptions,
        onExit: composedOnExit,
        cwd: spec.worktreePath,
        env: {
          ...env,
          HERMES_HOME: home.hermesHome,
          JINN_DISPATCHER_HERMES_PYTHON: cfg.hermesPythonPath,
          JINN_DISPATCHER_HERMES_MODEL: cfg.hermesModel,
          JINN_DISPATCHER_HERMES_PROVIDER: cfg.hermesProvider,
        },
      },
    );
  } else if (runtime === 'cursor') {
    const resolvedModel = resolveCursorSessionModel(
      spec.kind,
      spec.effort,
      cfg,
    );
    result = deps.spawn(
      cfg.cursorBin,
      cursorAgentArgs(prompt, {
        model: resolvedModel,
        workspace: spec.worktreePath,
      }),
      {
        ...spawnOptions,
        onExit: composedOnExit,
        cwd: spec.worktreePath,
        env: {
          ...env,
          [CURSOR_MODEL_ENV]: resolvedModel,
          [CURSOR_BIN_ENV]: cfg.cursorBin,
        },
      },
    );
  } else if (runtime === 'codex') {
    // Stage children the coordinator launches read the same two variables
    // (run-stage.ts), so they follow it onto Codex rather than falling back
    // to `claude -p` and re-entering the budget this session was routed
    // around (#152).
    result = deps.spawn(
      cfg.codexBin,
      codexExecArgs(prompt, {
        ...(cfg.codexModel === undefined ? {} : { model: cfg.codexModel }),
        effort: spec.effort,
        workspace: spec.worktreePath,
      }),
      {
        ...spawnOptions,
        onExit: composedOnExit,
        cwd: spec.worktreePath,
        env: {
          ...env,
          [CODEX_BIN_ENV]: cfg.codexBin,
          ...(cfg.codexModel === undefined ? {} : { [CODEX_MODEL_ENV]: cfg.codexModel }),
        },
      },
    );
  } else {
    reportDroppedAmbientMcpServers(
      spec,
      cfg,
      deps.readTextFile ?? readTextFileOrNothing,
      log,
    );
    const launch = claudeWorkerLaunch({
      prompt,
      effort: spec.effort,
      mcpConfig: workerMcpConfig(
        spec,
        cfg,
        deps.writeWorkerMcpConfig ?? writeWorkerMcpConfigFile,
        log,
      ),
      backgroundWaitCeilingMs: cfg.backgroundWaitCeilingMs,
      ambient: env,
    });
    result = deps.spawn(
      'claude',
      launch.args,
      {
        ...spawnOptions,
        onExit: composedOnExit,
        cwd: spec.worktreePath,
        env: launch.env,
      },
    );
  }

  spawnedPid = result.pid;

  log(
    `[autopilot] coordinator dispatch session=${sessionId} ` +
      `runtime=${runtime} pid=${result.pid ?? 'unknown'}`,
  );
  return result;
}
