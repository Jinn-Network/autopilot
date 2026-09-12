import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runStageHeadless } from '../../src/dispatcher/run-stage.js';
import {
  PRINT_BACKGROUND_WAIT_CEILING_ENV,
  WORKER_MCP_CONFIG_ENV,
} from '../../src/dispatcher/coordinator-session.js';

/** The ambient servers #184 found under nested stage sessions. */
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
 * and exits. Its shebang is this runner's own node by absolute path, so the
 * installed CLI is unreachable from a `PATH` holding nothing else.
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

describe('nested stage MCP isolation, real child (#184)', () => {
  it('launches the stage on the worker’s grant and ceiling, with no ambient server', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stage-mcp-'));
    roots.push(root);
    const home = join(root, 'home');
    const attemptDir = join(root, 'attempt');
    const worktree = join(root, 'worktree');
    for (const dir of [home, attemptDir, worktree]) mkdirSync(dir);
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: AMBIENT_SERVERS }),
    );
    // The engine-owned document the coordinator wrote beside the session log.
    const grantPath = join(attemptDir, 'mcp-config.json');
    writeFileSync(grantPath, '{"mcpServers":{}}', { mode: 0o600 });
    const recordPath = join(root, 'record.json');
    const binDir = stubClaude(root, recordPath);

    // The real spawn, on the environment a worker actually carries.
    const result = await runStageHeadless({
      stageTask: 'STAGE-stub',
      worktreePath: worktree,
      environment: {
        HOME: home,
        PATH: binDir,
        JINN_AUTOPILOT_RUNTIME: 'claude',
        [WORKER_MCP_CONFIG_ENV]: grantPath,
        [PRINT_BACKGROUND_WAIT_CEILING_ENV]: '3600000',
      },
    });
    expect(result.exitCode).toBe(0);

    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      argv: string[];
      env: Record<string, string>;
    };
    expect(record.argv[0]).toBe('-p');
    expect(record.argv).toContain('--strict-mcp-config');
    expect(record.argv[record.argv.indexOf('--mcp-config') + 1]).toBe(grantPath);
    expect(record.argv.at(-1)).toContain('STAGE-stub');
    for (const name of Object.keys(AMBIENT_SERVERS)) {
      expect(record.argv.join(' ')).not.toContain(name);
    }
    expect(JSON.parse(readFileSync(grantPath, 'utf8'))).toEqual({ mcpServers: {} });
    expect(record.env[PRINT_BACKGROUND_WAIT_CEILING_ENV]).toBe('3600000');
    expect(record.env[WORKER_MCP_CONFIG_ENV]).toBe(grantPath);
  });
});
