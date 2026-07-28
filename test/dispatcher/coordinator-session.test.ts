// @ts-nocheck — Stage 5 leftover fixtures for deleted merge-prep/review-fix/project APIs.
import { describe, expect, it } from 'vitest';
import {
  spawnCoordinatorSession,
  type CoordinatorSessionKind,
  type CoordinatorSessionSpec,
  type SpawnFn,
} from '../../src/dispatcher/coordinator-session.js';
import { HERMES_STATELESS_LAUNCHER } from '../../src/dispatcher/hermes-runtime.js';
import { DEFAULT_CONFIG } from '../../src/dispatcher/types.js';
import { AUTOPILOT_PACKAGE_DIR } from '../../src/dispatcher/runtime-path.js';
import type { AutopilotRuntime } from '../../src/autopilot-runtime.js';

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

describe.each(['claude', 'hermes', 'cursor'] as const)(
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
          JINN_AUTOPILOT_PACKAGE_DIR: AUTOPILOT_PACKAGE_DIR,
        });
        expect((call.opts.env as Record<string, string>)
          .JINN_AUTOPILOT_PACKAGE_DIR).toBe(AUTOPILOT_PACKAGE_DIR);

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
      expect((call.opts.env as Record<string, string>).JINN_AUTOPILOT_PACKAGE_DIR)
        .toBe(AUTOPILOT_PACKAGE_DIR);
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
        { spawn, log: (message) => logs.push(message) },
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
