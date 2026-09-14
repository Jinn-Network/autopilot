import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { spawnCoordinatorSession } from '../../src/dispatcher/coordinator-session.js';
import { DEFAULT_CONFIG } from '../../src/dispatcher/types.js';

/**
 * The two servers the operator's real `~/.claude.json` carried when a worker's
 * process tree was first read (#182). Named here so the assertions below fail
 * on the exact strings that used to reach a session.
 */
const AMBIENT_SERVERS = {
  'chrome-devtools': { command: 'npx', args: ['chrome-devtools-mcp@latest'] },
  'personal-os': { command: '/opt/personal-os/.venv/bin/python' },
};

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A `claude` on `PATH` that records the argv and environment it was handed
 * and exits. The shebang is this test runner's own node by absolute path, so
 * `PATH` can hold nothing but the stub and the real CLI is unreachable.
 */
function stubClaude(root: string, recordPath: string): string {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const stub = join(binDir, 'claude');
  writeFileSync(
    stub,
    `#!${process.execPath}\n`
      + 'require("node:fs").writeFileSync('
      + `${JSON.stringify(recordPath)}, `
      + 'JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\n',
  );
  chmodSync(stub, 0o755);
  return binDir;
}

interface StubbedWorker {
  argv: string[];
  /** The environment the child actually ran under. */
  env: Record<string, string>;
  document: string;
  configPath: string;
  logs: string[];
  status: number | null;
}

function launchStubbedWorker(options: {
  readonly mcpServers?: Record<string, unknown>;
  /** Ambient variables on top of the minimal `HOME`/`PATH` a worker needs. */
  readonly ambient?: Record<string, string>;
} = {}): StubbedWorker {
  const { mcpServers } = options;
  const root = mkdtempSync(join(tmpdir(), 'worker-mcp-'));
  roots.push(root);
  const home = join(root, 'home');
  const attemptDir = join(root, 'attempt');
  const worktree = join(root, 'worktree');
  for (const dir of [home, attemptDir, worktree]) mkdirSync(dir);
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({ mcpServers: AMBIENT_SERVERS }),
  );
  const recordPath = join(root, 'record.json');
  const binDir = stubClaude(root, recordPath);
  const logs: string[] = [];
  let status: number | null = null;

  const result = spawnCoordinatorSession(
    {
      kind: 'implement',
      number: 182,
      skill: 'implement-issue',
      scenario: 'SCENARIO-stub',
      worktreePath: worktree,
      effort: 'High',
      env: { HOME: home, PATH: binDir, ...options.ambient },
      spawnOptions: {
        detached: false,
        stdio: 'ignore',
        logPath: join(attemptDir, 'session.log'),
      },
    },
    {
      ...DEFAULT_CONFIG,
      runtime: 'claude',
      ...(mcpServers === undefined ? {} : { mcpServers }),
    },
    {
      // A real child, launched exactly as production launches one: the
      // engine's own argv, the engine's own env, and nothing else.
      spawn: (cmd, args, opts) => {
        const child = spawnSync(cmd, args, {
          cwd: opts.cwd,
          env: opts.env,
          stdio: 'ignore',
        });
        status = child.status;
        return { pid: child.pid };
      },
      log: (message) => logs.push(message),
    },
  );
  expect(result.pid).toBeGreaterThan(0);

  // The filename is the contract the operator inspects after a run, so it is
  // spelled out here rather than re-derived from the launcher.
  const configPath = join(attemptDir, 'mcp-config.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
    argv: string[];
    env: Record<string, string>;
  };
  return {
    argv: record.argv,
    env: record.env,
    document: readFileSync(configPath, 'utf8'),
    configPath,
    logs,
    status,
  };
}

describe('worker MCP isolation, real child (#182)', () => {
  it('hands the child no ambient server, only the engine document', () => {
    const { argv, document, configPath, status } = launchStubbedWorker();

    expect(status).toBe(0);
    expect(argv).toContain('--strict-mcp-config');
    expect(argv[argv.indexOf('--mcp-config') + 1]).toBe(configPath);
    // Nothing on the command line names a server the operator configured, and
    // the only document the child is pointed at declares none at all — so the
    // session this argv would have started has no MCP server to launch.
    for (const name of Object.keys(AMBIENT_SERVERS)) {
      expect(argv.join(' ')).not.toContain(name);
      expect(document).not.toContain(name);
    }
    expect(JSON.parse(document)).toEqual({ mcpServers: {} });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('names the ambient servers it dropped', () => {
    const { logs } = launchStubbedWorker();

    expect(logs).toContain(
      '[autopilot] worker mcp: ignoring 2 ambient server(s) '
        + '(chrome-devtools, personal-os)',
    );
  });

  it('hands the child a granted server and still no ambient one', () => {
    const { argv, document, configPath } = launchStubbedWorker({
      mcpServers: {
        'jinn-notes': { command: 'npx', args: ['-y', 'jinn-notes-mcp'] },
      },
    });

    expect(argv[argv.indexOf('--mcp-config') + 1]).toBe(configPath);
    expect(JSON.parse(document)).toEqual({
      mcpServers: {
        'jinn-notes': { command: 'npx', args: ['-y', 'jinn-notes-mcp'] },
      },
    });
    expect(document).not.toContain('chrome-devtools');
  });

  it('keeps the prompt the last operand, past the variadic flag', () => {
    const { argv } = launchStubbedWorker();

    expect(argv[0]).toBe('-p');
    expect(argv.at(-1)).toContain('SCENARIO-stub');
    expect(argv.indexOf('--mcp-config')).toBeLessThan(argv.length - 1);
  });
});

/**
 * The environment the 2026-09-12 start leaked into every worker (#186). The
 * daemon was started from inside a Claude Code session; each `claude -p`
 * inherited that session's child-session marker and messaging socket, and
 * died on startup for 48 hours once the session was gone.
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

describe('worker env hygiene, real child (#186)', () => {
  it('hands the child no ambient CLAUDE_* variable, and still the ceiling', () => {
    const { env, status } = launchStubbedWorker({ ambient: LEAKED_HOST_SESSION_ENV });

    expect(status).toBe(0);
    for (const name of Object.keys(LEAKED_HOST_SESSION_ENV)) {
      expect(env).not.toHaveProperty(name);
    }
    expect(env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe('3600000');
    // The scrub is by prefix, so nothing else the worker needs is touched.
    expect(env.JINN_AUTOPILOT_RUNTIME).toBe('claude');
  });

  it('says how many ambient CLAUDE_* variables it dropped, and which', () => {
    const { logs } = launchStubbedWorker({ ambient: LEAKED_HOST_SESSION_ENV });

    expect(logs).toContain(
      '[autopilot] worker env: dropping 7 ambient CLAUDE_* var(s) '
        + '(CLAUDE_CODE_CHILD_SESSION, CLAUDE_CODE_HOST_SESSION_ID, '
        + 'CLAUDE_CODE_MESSAGING_SOCKET, CLAUDE_CODE_MESSAGING_TOKEN, '
        + 'CLAUDE_CODE_SESSION_ID, CLAUDE_EFFORT, CLAUDE_PID)',
    );
  });

  it('says nothing about the env when nothing ambient was there to drop', () => {
    const { logs } = launchStubbedWorker();

    expect(logs.some((line) => line.includes('worker env:'))).toBe(false);
  });
});
