import {
  buildCursorHeadlessPrompt,
  buildHeadlessPrompt,
  buildHermesHeadlessPrompt,
} from '../headless.js';
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
}

/** Canon is explicit because neither headless runtime auto-loads it reliably. */
export function loadCanon(
  environment: NodeJS.ProcessEnv = process.env,
  repositoryRoot?: string,
): string {
  return loadRuntimeCanon(environment, repositoryRoot);
}

/** Map board Effort to Claude's CLI flag; null keeps the runtime default. */
export function effortFlag(effort: Effort | null): string[] {
  return effort == null ? [] : ['--effort', effort.toLowerCase()];
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
export function spawnCoordinatorSession(
  spec: CoordinatorSessionSpec,
  cfg: DispatcherConfig,
  deps: CoordinatorSessionDeps,
): SpawnResult {
  const sessionId = `${spec.kind}-${spec.number}`;
  const runtimePrompt = cfg.runtime === 'hermes'
    ? buildHermesHeadlessPrompt(spec.skill, spec.scenario)
    : cfg.runtime === 'cursor'
      ? buildCursorHeadlessPrompt(spec.skill, spec.scenario)
      : buildHeadlessPrompt(spec.skill, spec.scenario);
  const prompt = [
    loadCanon(spec.env, spec.worktreePath),
    '',
    runtimePrompt,
  ].join('\n');
  const env: NodeJS.ProcessEnv = {
    ...spec.env,
    JINN_AUTOPILOT_RUNTIME: cfg.runtime,
  };
  let result: SpawnResult;

  if (cfg.runtime === 'hermes') {
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
        ...spec.spawnOptions,
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
  } else if (cfg.runtime === 'cursor') {
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
        ...spec.spawnOptions,
        cwd: spec.worktreePath,
        env: {
          ...env,
          [CURSOR_MODEL_ENV]: resolvedModel,
          [CURSOR_BIN_ENV]: cfg.cursorBin,
        },
      },
    );
  } else {
    result = deps.spawn(
      'claude',
      ['-p', ...effortFlag(spec.effort), prompt],
      {
        ...spec.spawnOptions,
        cwd: spec.worktreePath,
        env,
      },
    );
  }

  (deps.log ?? console.log)(
    `[autopilot] coordinator dispatch session=${sessionId} ` +
      `runtime=${cfg.runtime} pid=${result.pid ?? 'unknown'}`,
  );
  return result;
}
