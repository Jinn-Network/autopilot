#!/usr/bin/env node
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseAutopilotArguments, AUTOPILOT_USAGE } from '../src/cli/arguments.js';
import {
  loadAutopilotConfig,
  type LoadedAutopilotConfig,
} from '../src/config/config.js';
import { runDoctor, type DoctorReport } from '../src/doctor.js';
import { initializeAutopilot, type InitializationRunner } from '../src/init.js';
import {
  createMaintainerIssue,
  readTriageInventory,
  triageMaintainerIssue,
} from '../src/maintainer-issues.js';
import { updateMaintainerSkills } from '../src/maintainer-skills.js';
import { packageRoot } from '../src/package-paths.js';
import {
  redactLog,
  runDaemon,
  serviceStatus,
  startService,
  stopService,
} from '../src/service.js';
import {
  upgradeAutopilot,
  type AutopilotInstallation,
  type UpgradeDependencies,
} from '../src/upgrade.js';
import { defaultRunner } from '../src/dispatcher/issue-source.js';

const execFileAsync = promisify(execFile);
const PACKAGE_VERSION = '0.1.0';

const runner: InitializationRunner = async (command, args, options) => {
  const result = await execFileAsync(command, args, {
    cwd: options?.cwd,
    env: { ...process.env, ...options?.env },
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout;
};

async function repositoryRoot(cwd = process.cwd()): Promise<string> {
  return (await runner('git', ['rev-parse', '--show-toplevel'], { cwd })).trim();
}

async function loadedConfig(): Promise<LoadedAutopilotConfig> {
  return loadAutopilotConfig(await repositoryRoot(), process.env);
}

function renderDoctor(report: DoctorReport): string {
  const lines = report.checks.map((entry) => {
    const mark = entry.status === 'pass'
      ? 'PASS'
      : entry.status === 'degraded'
        ? 'DEGRADED'
        : 'BLOCKING';
    return `${mark.padEnd(8)} ${entry.id}: ${entry.detail}${
      entry.remedy == null ? '' : `\n         Remedy: ${entry.remedy}`
    }`;
  });
  return `${lines.join('\n')}\n\n${
    report.blocking ? 'Doctor found blocking failures.' : 'Doctor passed all blocking checks.'
  }`;
}

async function doctorFor(loaded: LoadedAutopilotConfig): Promise<DoctorReport> {
  return runDoctor({
    repositoryRoot: loaded.repositoryRoot,
    runner,
    environment: process.env,
  });
}

async function captureEngine(arguments_: readonly string[]): Promise<{
  readonly text: string;
  readonly exitCode: number | undefined;
}> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    const { runAutopilotV2 } = await import('../scripts/run-autopilot-v2.js');
    await runAutopilotV2(arguments_);
    return { text: chunks.join(''), exitCode: process.exitCode };
  } finally {
    process.stdout.write = originalWrite;
    process.exitCode = previousExitCode;
  }
}

async function runEngine(arguments_: readonly string[]): Promise<void> {
  const result = await captureEngine(arguments_);
  process.stdout.write(result.text);
  if (result.exitCode != null) process.exitCode = result.exitCode;
}

function parseLastJson(output: string): unknown {
  const lines = output.trim().split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]!) as unknown;
    } catch {
      // Runtime diagnostics may precede the final JSON lifecycle report.
    }
  }
  throw new Error('Lifecycle engine did not return a JSON report');
}

function logPath(
  loaded: LoadedAutopilotConfig,
  attempt: string | undefined,
): string {
  if (attempt == null) return join(loaded.paths.logs, 'engine.log');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(attempt)) {
    throw new Error('Attempt must be a simple identifier');
  }
  const candidates = [
    join(loaded.paths.logs, `${attempt}.log`),
    join(loaded.paths.attempts, attempt, 'session.log'),
    join(loaded.paths.attempts, 'v2', attempt, 'session.log'),
  ];
  return candidates.find(existsSync) ?? candidates[0]!;
}

async function renderLogs(
  loaded: LoadedAutopilotConfig,
  attempt: string | undefined,
  follow: boolean,
): Promise<void> {
  const path = logPath(loaded, attempt);
  if (!existsSync(path)) throw new Error(`No log exists at ${path}`);
  let offset = 0;
  const emit = (): void => {
    const content = readFileSync(path, 'utf8');
    if (content.length > offset) {
      process.stdout.write(redactLog(content.slice(offset)));
      offset = content.length;
    }
  };
  emit();
  if (!follow) return;
  await new Promise<void>((resolvePromise) => {
    const timer = setInterval(emit, 500);
    const stop = (): void => {
      clearInterval(timer);
      resolvePromise();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

async function installation(): Promise<AutopilotInstallation> {
  const currentRoot = realpathSync(packageRoot());
  let globalRoot = '';
  try {
    globalRoot = realpathSync((await runner('npm', ['root', '--global'])).trim());
  } catch {
    return {
      kind: 'unsupported',
      packageRoot: currentRoot,
      executable: process.argv[1] ?? '',
      version: PACKAGE_VERSION,
    };
  }
  return {
    kind: currentRoot.startsWith(`${globalRoot}/`) ? 'npm-global' : 'unsupported',
    packageRoot: currentRoot,
    executable: process.argv[1] ?? '',
    version: PACKAGE_VERSION,
  };
}

async function waitForStop(
  loaded: LoadedAutopilotConfig,
  entryPath: string,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const status = await serviceStatus({ loaded, entryPath });
    if (status.status === 'not-running' || status.status === 'stale') return;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error('Timed out waiting for the daemon controller boundary to finish');
}

async function upgradeDependencies(
  loaded: LoadedAutopilotConfig,
  entryPath: string,
): Promise<UpgradeDependencies> {
  const detected = await installation();
  return {
    installation: detected,
    wasRunning: async () => (
      (await serviceStatus({ loaded, entryPath })).status === 'running'
    ),
    stop: async () => {
      await stopService({ loaded, entryPath, force: false });
    },
    waitStopped: () => waitForStop(loaded, entryPath),
    packCurrent: async () => {
      const destination = mkdtempSync(join(tmpdir(), 'autopilot-rollback-'));
      const raw = await runner('npm', [
        'pack',
        detected.packageRoot,
        '--json',
        '--pack-destination',
        destination,
      ]);
      const parsed = JSON.parse(raw) as Array<{ filename?: unknown }>;
      const filename = parsed[0]?.filename;
      if (typeof filename !== 'string') throw new Error('npm pack did not return a tarball');
      return join(destination, basename(filename));
    },
    install: async (specification) => {
      await runner('npm', ['install', '--global', specification]);
    },
    migrate: async () => {
      await runner(detected.executable, ['internal', 'migrate'], {
        cwd: loaded.repositoryRoot,
      });
    },
    doctor: async () => {
      await runner(detected.executable, ['doctor', '--json'], {
        cwd: loaded.repositoryRoot,
      });
    },
    start: async () => {
      await runner(detected.executable, ['start'], { cwd: loaded.repositoryRoot });
    },
  };
}

async function main(): Promise<void> {
  const command = parseAutopilotArguments(process.argv.slice(2));
  if (command.kind === 'help') {
    process.stdout.write(`${AUTOPILOT_USAGE}\n`);
    return;
  }
  if (command.kind === 'version') {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }
  if (command.kind === 'init') {
    const result = await initializeAutopilot({
      cwd: process.cwd(),
      nonInteractive: command.nonInteractive,
      ...(command.project == null ? {} : { project: command.project }),
      runner,
      environment: process.env,
    });
    const loaded = await loadAutopilotConfig(result.repositoryRoot, process.env);
    const skills = updateMaintainerSkills({
      repositoryRoot: result.repositoryRoot,
      config: loaded.config,
      apply: true,
      force: false,
    });
    process.stdout.write(`${JSON.stringify({ ...result, skills }, null, 2)}\n`);
    return;
  }
  if (command.kind === 'internal') {
    const [operation, ...arguments_] = command.arguments;
    if (operation === 'engine') {
      const { runAutopilotV2 } = await import('../scripts/run-autopilot-v2.js');
      await runAutopilotV2(arguments_);
      return;
    }
    if (operation === 'daemon') {
      const [root] = arguments_;
      if (root == null) throw new Error('internal daemon requires a repository root');
      const loaded = await loadAutopilotConfig(resolve(root), process.env);
      await runDaemon({
        loaded,
        entryPath: realpathSync(process.argv[1]!),
        environment: process.env,
      });
      return;
    }
    if (operation === 'run-stage') {
      const value = (name: string): string | undefined => {
        const index = arguments_.indexOf(name);
        return index < 0 ? undefined : arguments_[index + 1];
      };
      const promptFile = value('--prompt-file');
      const worktree = value('--worktree');
      if (promptFile == null || worktree == null) {
        throw new Error(
          'internal run-stage requires --prompt-file <path> --worktree <path>',
        );
      }
      const timeout = value('--timeout-ms');
      const { runStageHeadless } = await import('../src/dispatcher/run-stage.js');
      const result = await runStageHeadless({
        stageTask: readFileSync(promptFile, 'utf8'),
        worktreePath: worktree,
        ...(value('--model') == null ? {} : { model: value('--model') }),
        ...(timeout == null ? {} : { timeoutMs: Number.parseInt(timeout, 10) }),
      });
      process.stdout.write(result.stdout);
      if (result.stderr !== '') process.stderr.write(result.stderr);
      process.exitCode = result.timedOut ? 1 : result.exitCode;
      return;
    }
    if (operation === 'migrate') return;
    throw new Error('Unknown internal command');
  }
  if (command.kind === 'session') {
    const { runSessionCli } = await import('../src/cli/session.js');
    await runSessionCli(command.arguments);
    return;
  }

  const loaded = await loadedConfig();
  const entryPath = realpathSync(process.argv[1]!);
  if (command.kind === 'doctor') {
    const report = await doctorFor(loaded);
    process.stdout.write(command.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${renderDoctor(report)}\n`);
    if (report.blocking) process.exitCode = 1;
    return;
  }
  if (command.kind === 'start') {
    const result = await startService({
      loaded,
      entryPath,
      foreground: command.foreground,
      doctor: () => doctorFor(loaded),
      environment: process.env,
    });
    process.stdout.write(`${result.status} (pid ${result.pid})\n`);
    return;
  }
  if (command.kind === 'stop') {
    const result = await stopService({
      loaded,
      entryPath,
      force: command.force,
    });
    process.stdout.write(`${result.status}\n`);
    return;
  }
  if (command.kind === 'status') {
    const daemon = await serviceStatus({ loaded, entryPath });
    const lifecycle = await captureEngine(['--mode', 'observe', '--once', '--json']);
    if (command.json) {
      process.stdout.write(`${JSON.stringify({
        schemaVersion: 1,
        daemon,
        lifecycle: parseLastJson(lifecycle.text),
      }, null, 2)}\n`);
    } else {
      process.stdout.write(`Daemon: ${daemon.status}\n${lifecycle.text}`);
    }
    return;
  }
  if (command.kind === 'explain') {
    await runEngine([
      '--mode',
      'observe',
      '--once',
      ...(command.json ? ['--json'] : []),
      'explain',
      command.subject,
      String(command.number),
    ]);
    return;
  }
  if (command.kind === 'observe') {
    await runEngine([
      '--mode',
      'observe',
      ...(command.once ? ['--once'] : []),
      ...(command.json ? ['--json'] : []),
      ...(command.fullReconcile ? ['--full-reconcile'] : []),
    ]);
    return;
  }
  if (command.kind === 'recover') {
    await runEngine([
      '--mode',
      'recover',
      ...(command.once ? ['--once'] : []),
      ...(command.json ? ['--json'] : []),
    ]);
    return;
  }
  if (command.kind === 'logs') {
    await renderLogs(loaded, command.attempt, command.follow);
    return;
  }
  if (command.kind === 'skills-update') {
    const report = updateMaintainerSkills({
      repositoryRoot: loaded.repositoryRoot,
      config: loaded.config,
      apply: command.apply,
      force: command.force,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.conflicts.length > 0 && !command.force) process.exitCode = 2;
    return;
  }
  if (command.kind === 'triage') {
    process.stdout.write(`${JSON.stringify(
      await readTriageInventory(loaded.config, defaultRunner),
      null,
      2,
    )}\n`);
    return;
  }
  if (command.kind === 'issue-create') {
    process.stdout.write(`${JSON.stringify(await createMaintainerIssue({
      inputPath: command.input,
      apply: command.apply,
      config: loaded.config,
      runner: defaultRunner,
    }), null, 2)}\n`);
    return;
  }
  if (command.kind === 'issue-triage') {
    process.stdout.write(`${JSON.stringify(await triageMaintainerIssue({
      issueNumber: command.number,
      inputPath: command.input,
      apply: command.apply,
      config: loaded.config,
      runner: defaultRunner,
    }), null, 2)}\n`);
    return;
  }
  if (command.kind === 'upgrade') {
    const result = await upgradeAutopilot(
      command.version,
      await upgradeDependencies(loaded, entryPath),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`autopilot: ${redactLog(message)}\n`);
  process.exitCode = 1;
});
