// @ts-nocheck — Stage 5 leftover fixtures for deleted merge-prep/review-fix/project APIs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  spawnCoordinatorSession,
  type CoordinatorSessionKind,
  type CoordinatorSessionSpec,
  type SpawnFn,
} from '../../src/dispatcher/coordinator-session.js';
import { HERMES_STATELESS_LAUNCHER } from '../../src/dispatcher/hermes-runtime.js';
import { DEFAULT_CONFIG } from '../../src/dispatcher/types.js';
import type { AutopilotRuntime } from '../../src/autopilot-runtime.js';

/**
 * Reads the `name` field from the package.json inside `dir`, proving `dir` is
 * actually this package's root rather than merely equal to some other
 * (possibly also wrong) computed constant.
 */
function packageNameAt(dir: string): string {
  const manifest = readFileSync(join(dir, 'package.json'), 'utf8');
  return (JSON.parse(manifest) as { name: string }).name;
}

type SpawnCall = {
  cmd: string;
  args: string[];
  opts: Record<string, unknown>;
};

const CASES: Array<{
  kind: CoordinatorSessionKind;
  skill: CoordinatorSessionSpec['skill'];
  effort: CoordinatorSessionSpec['effort'];
}> = [
  { kind: 'implement', skill: 'implement-issue', effort: 'High' },
  { kind: 'review', skill: 'review-pr', effort: null },
];

function exercise(
  runtime: AutopilotRuntime,
  session: (typeof CASES)[number],
) {
  const calls: SpawnCall[] = [];
  const homes: Array<{
    sessionId: string;
    effort: CoordinatorSessionSpec['effort'];
  }> = [];
  const logs: string[] = [];
  const spawn: SpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts: opts as Record<string, unknown> });
    return { pid: 4242 };
  };

  const result = spawnCoordinatorSession(
    {
      kind: session.kind,
      number: 42,
      skill: session.skill,
      scenario: `SCENARIO-${session.kind}`,
      worktreePath: `/tmp/worktrees/${session.kind}-42`,
      effort: session.effort,
      env: { GH_TOKEN: `${session.kind}-token` },
      spawnOptions: {
        detached: true,
        stdio: session.kind === 'review'
          ? 'ignore'
          : ['ignore', 'inherit', 'inherit'],
      },
    },
    { ...DEFAULT_CONFIG, runtime },
    {
      spawn,
      prepareHermesHome: (opts) => {
        homes.push({ sessionId: opts.sessionId, effort: opts.effort });
        return { hermesHome: `/tmp/hermes-homes/${opts.sessionId}` };
      },
      log: (message) => logs.push(message),
    },
  );

  return { result, call: calls[0], calls, homes, logs };
}

describe.each(['claude', 'hermes', 'cursor', 'codex'] as const)(
  '%s coordinator launcher',
  (runtime) => {
    it.each(CASES)(
      'uses only the selected runtime for $kind',
      (session) => {
        const { result, call, calls, homes, logs } = exercise(runtime, session);

        expect(result.pid).toBe(4242);
        expect(calls).toHaveLength(1);
        expect(call.opts.cwd).toBe(`/tmp/worktrees/${session.kind}-42`);
        expect(call.opts.env).toMatchObject({
          GH_TOKEN: `${session.kind}-token`,
          JINN_AUTOPILOT_RUNTIME: runtime,
        });
        expect(packageNameAt((call.opts.env as Record<string, string>)
          .JINN_AUTOPILOT_PACKAGE_DIR)).toBe('@jinn-network/autopilot');

        if (runtime === 'claude') {
          expect(call.cmd).toBe('claude');
          expect(call.args[0]).toBe('-p');
          expect(call.args).not.toContain(HERMES_STATELESS_LAUNCHER);
          expect(homes).toEqual([]);
          if (session.kind === 'implement') {
            expect(call.args).toContain('--effort');
            expect(call.args[call.args.indexOf('--effort') + 1]).toBe('high');
          } else {
            expect(call.args).not.toContain('--effort');
          }
          expect(call.args.at(-1)).toContain('`claude -p` / `--print`');
        } else if (runtime === 'hermes') {
          expect(call.cmd).toBe(DEFAULT_CONFIG.hermesPythonPath);
          expect(call.args[0]).toBe(HERMES_STATELESS_LAUNCHER);
          expect(call.args).not.toContain('--effort');
          expect(call.args[call.args.indexOf('--provider') + 1])
            .toBe('openai-codex');
          expect(call.args[call.args.indexOf('--model') + 1])
            .toBe('gpt-5.6-sol');
          expect(call.args[call.args.indexOf('-q') + 1])
            .toContain('`hermes chat -q`');
          expect(call.opts.env).toMatchObject({
            HERMES_HOME: `/tmp/hermes-homes/${session.kind}-42`,
            JINN_DISPATCHER_HERMES_MODEL: 'gpt-5.6-sol',
            JINN_DISPATCHER_HERMES_PROVIDER: 'openai-codex',
            JINN_DISPATCHER_HERMES_PYTHON: DEFAULT_CONFIG.hermesPythonPath,
          });
          expect(homes).toEqual([{
            sessionId: `${session.kind}-42`,
            effort: session.effort,
          }]);
        } else if (runtime === 'codex') {
          expect(call.cmd).toBe(DEFAULT_CONFIG.codexBin);
          expect(call.args[0]).toBe('exec');
          expect(call.args[call.args.indexOf('-C') + 1])
            .toBe(`/tmp/worktrees/${session.kind}-42`);
          expect(call.args).toContain('--dangerously-bypass-approvals-and-sandbox');
          expect(call.args).not.toContain('--effort');
          // No configured model: Codex's own default applies, so no `-m`.
          expect(call.args).not.toContain('-m');
          if (session.kind === 'implement') {
            expect(call.args[call.args.indexOf('-c') + 1])
              .toBe('model_reasoning_effort=high');
          } else {
            expect(call.args).not.toContain('-c');
          }
          expect(call.args.at(-1)).toContain('`codex exec`');
          expect(call.opts.env).toMatchObject({
            JINN_DISPATCHER_CODEX_BIN: DEFAULT_CONFIG.codexBin,
          });
          expect(homes).toEqual([]);
        } else {
          expect(call.cmd).toBe(DEFAULT_CONFIG.cursorBin);
          expect(call.args[0]).toBe('-p');
          expect(call.args).toContain('--approve-mcps');
          expect(call.args).not.toContain('--effort');
          expect(call.args[call.args.indexOf('--workspace') + 1])
            .toBe(`/tmp/worktrees/${session.kind}-42`);
          const expectedModel = session.kind === 'implement'
            ? 'cursor-grok-4.5-high'
            : DEFAULT_CONFIG.cursorModel;
          expect(call.args[call.args.indexOf('--model') + 1]).toBe(expectedModel);
          expect(call.args.at(-1)).toContain('`agent -p`');
          expect(call.opts.env).toMatchObject({
            JINN_DISPATCHER_CURSOR_MODEL: expectedModel,
            JINN_DISPATCHER_CURSOR_BIN: DEFAULT_CONFIG.cursorBin,
          });
          expect(homes).toEqual([]);
        }

        expect(logs).toEqual([
          expect.stringContaining(
            `session=${session.kind}-42 runtime=${runtime}`,
          ),
        ]);
        expect(logs[0]).not.toContain(`${session.kind}-token`);
      },
    );

    it('overrides ambient JINN_AUTOPILOT_PACKAGE_DIR for $kind', (session) => {
      const { call } = exercise(runtime, session);
      expect(packageNameAt((call.opts.env as Record<string, string>)
        .JINN_AUTOPILOT_PACKAGE_DIR)).toBe('@jinn-network/autopilot');
    });

    it('composes exit diagnostics with caller onExit for $kind', (session) => {
      const calls: SpawnCall[] = [];
      const logs: string[] = [];
      const callerExits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
      const spawn: SpawnFn = (cmd, args, opts) => {
        calls.push({ cmd, args, opts: opts as Record<string, unknown> });
        return { pid: 5151 };
      };

      spawnCoordinatorSession(
        {
          kind: session.kind,
          number: 42,
          skill: session.skill,
          scenario: `SCENARIO-${session.kind}`,
          worktreePath: `/tmp/worktrees/${session.kind}-42`,
          effort: session.effort,
          env: {
            GH_TOKEN: `${session.kind}-token`,
            JINN_AUTOPILOT_PACKAGE_DIR: '/wrong/package',
          },
          spawnOptions: {
            detached: true,
            stdio: ['ignore', 'inherit', 'inherit'],
            logPath: `/tmp/${session.kind}-42.log`,
            onExit: (code, signal) => {
              callerExits.push({ code, signal });
            },
          },
        },
        { ...DEFAULT_CONFIG, runtime },
        {
          spawn,
          log: (message) => logs.push(message),
          // 5151 is a fixture PID: never signal a real process group for it.
          terminateProcessGroup: async () => 0,
        },
      );

      const onExit = calls[0].opts.onExit as
        | ((code: number | null, signal: NodeJS.Signals | null) => void)
        | undefined;
      onExit?.(1, 'SIGTERM');

      expect(callerExits).toEqual([{ code: 1, signal: 'SIGTERM' }]);
      expect(logs).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`session=${session.kind}-42 runtime=${runtime}`),
          expect.stringContaining(
            `coordinator exit session=${session.kind}-42 pid=5151 code=1 signal=SIGTERM log=/tmp/${session.kind}-42.log`,
          ),
        ]),
      );
    });
  },
);

describe('per-session runtime override (#152)', () => {
  it('launches one session on Codex under a claude process-wide runtime', () => {
    const calls: SpawnCall[] = [];
    const logs: string[] = [];
    const spawn: SpawnFn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts: opts as Record<string, unknown> });
      return { pid: 7777 };
    };

    spawnCoordinatorSession(
      {
        kind: 'implement',
        number: 84,
        skill: 'implement-issue',
        scenario: 'SCENARIO-overflow',
        worktreePath: '/tmp/worktrees/implement-84',
        effort: 'Medium',
        runtime: 'codex',
        env: { GH_TOKEN: 'implement-token' },
        spawnOptions: { detached: true, stdio: ['ignore', 'inherit', 'inherit'] },
      },
      { ...DEFAULT_CONFIG, runtime: 'claude', codexModel: 'gpt-5.6-sol' },
      { spawn, log: (message) => logs.push(message) },
    );

    const [call] = calls;
    expect(call.cmd).toBe(DEFAULT_CONFIG.codexBin);
    expect(call.args[0]).toBe('exec');
    expect(call.args[call.args.indexOf('-C') + 1]).toBe('/tmp/worktrees/implement-84');
    expect(call.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(call.args[call.args.indexOf('-m') + 1]).toBe('gpt-5.6-sol');
    expect(call.args[call.args.indexOf('-c') + 1]).toBe('model_reasoning_effort=medium');
    expect(call.args.at(-1)).toContain('`codex exec`');
    expect(call.args.at(-1)).toContain('SCENARIO-overflow');
    // The session, and every stage it launches, sees itself as Codex.
    expect(call.opts.env).toMatchObject({
      JINN_AUTOPILOT_RUNTIME: 'codex',
      JINN_DISPATCHER_CODEX_BIN: DEFAULT_CONFIG.codexBin,
      JINN_DISPATCHER_CODEX_MODEL: 'gpt-5.6-sol',
    });
    expect(logs).toEqual([expect.stringContaining('session=implement-84 runtime=codex')]);
  });

  it('leaves the process-wide runtime in force when no override is given', () => {
    const calls: SpawnCall[] = [];
    const spawn: SpawnFn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts: opts as Record<string, unknown> });
      return { pid: 7778 };
    };
    spawnCoordinatorSession(
      {
        kind: 'implement',
        number: 85,
        skill: 'implement-issue',
        scenario: 'SCENARIO-plain',
        worktreePath: '/tmp/worktrees/implement-85',
        effort: null,
        env: {},
        spawnOptions: { detached: true, stdio: 'ignore' },
      },
      { ...DEFAULT_CONFIG, runtime: 'claude' },
      { spawn },
    );
    expect(calls[0].cmd).toBe('claude');
    expect(calls[0].opts.env).toMatchObject({ JINN_AUTOPILOT_RUNTIME: 'claude' });
  });
});

describe('print-mode background wait ceiling (#167)', () => {
  function launch(
    runtime: AutopilotRuntime,
    env: NodeJS.ProcessEnv,
    backgroundWaitCeilingMs = DEFAULT_CONFIG.backgroundWaitCeilingMs,
  ): SpawnCall {
    const calls: SpawnCall[] = [];
    spawnCoordinatorSession(
      {
        kind: 'implement',
        number: 167,
        skill: 'implement-issue',
        scenario: 'SCENARIO-ceiling',
        worktreePath: '/tmp/worktrees/implement-167',
        effort: 'High',
        env,
        spawnOptions: { detached: true, stdio: 'ignore' },
      },
      { ...DEFAULT_CONFIG, runtime, backgroundWaitCeilingMs },
      {
        spawn: (cmd, args, opts) => {
          calls.push({ cmd, args, opts: opts as Record<string, unknown> });
          return { pid: 1670 };
        },
        prepareHermesHome: () => ({ hermesHome: '/tmp/hermes-homes/implement-167' }),
        log: () => {},
      },
    );
    return calls[0];
  }

  it('sets the configured ceiling for claude sessions', () => {
    expect(launch('claude', {}).opts.env).toMatchObject({
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '3600000',
    });
  });

  it('passes a zero ceiling through as wait-indefinitely', () => {
    expect(launch('claude', {}, 0).opts.env).toMatchObject({
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
    });
  });

  it('never overrides a ceiling the operator already exported', () => {
    expect(launch('claude', { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '900000' })
      .opts.env).toMatchObject({
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '900000',
    });
  });

  it.each(['hermes', 'cursor', 'codex'] as const)(
    'leaves %s sessions untouched — the ceiling is a `claude -p` knob',
    (runtime) => {
      expect((launch(runtime, {}).opts.env as Record<string, string>)
        .CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBeUndefined();
    },
  );
});

describe('worker process-group teardown (#167)', () => {
  function launchAndExit(
    terminateProcessGroup: (pid: number) => Promise<number>,
  ): { logs: string[]; exit: () => void } {
    const calls: SpawnCall[] = [];
    const logs: string[] = [];
    spawnCoordinatorSession(
      {
        kind: 'implement',
        number: 167,
        skill: 'implement-issue',
        scenario: 'SCENARIO-teardown',
        worktreePath: '/tmp/worktrees/implement-167',
        effort: null,
        env: {},
        spawnOptions: { detached: true, stdio: 'ignore' },
      },
      { ...DEFAULT_CONFIG, runtime: 'claude' },
      {
        spawn: (cmd, args, opts) => {
          calls.push({ cmd, args, opts: opts as Record<string, unknown> });
          return { pid: 9090 };
        },
        log: (message) => logs.push(message),
        terminateProcessGroup,
      },
    );
    const onExit = calls[0].opts.onExit as
      (code: number | null, signal: NodeJS.Signals | null) => void;
    return { logs, exit: () => { onExit(0, null); } };
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => { setImmediate(resolve); });
    await new Promise((resolve) => { setImmediate(resolve); });
  }

  it('tears the exited worker down by process group', async () => {
    const seen: number[] = [];
    const { logs, exit } = launchAndExit(async (pid) => {
      seen.push(pid);
      return 2;
    });

    exit();
    await settle();

    expect(seen).toEqual([9090]);
    expect(logs).toContain(
      '[autopilot] coordinator teardown session=implement-167 pgid=9090 signalled=2',
    );
  });

  it('says nothing when the worker left no process group behind', async () => {
    const { logs, exit } = launchAndExit(async () => 0);

    exit();
    await settle();

    expect(logs.some((line) => line.includes('coordinator teardown'))).toBe(false);
  });

  it('keeps a failed teardown advisory rather than throwing at the exit handler', async () => {
    const { logs, exit } = launchAndExit(async () => {
      throw new Error('kill refused');
    });

    expect(() => { exit(); }).not.toThrow();
    await settle();
    expect(logs.some((line) => line.includes('coordinator teardown'))).toBe(false);
  });
});
