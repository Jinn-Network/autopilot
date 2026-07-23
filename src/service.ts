import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import type { LoadedAutopilotConfig } from './config/config.js';
import type { DoctorReport } from './doctor.js';

export interface DaemonMetadata {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly processStartedAt: string;
  readonly startedAt: string;
  readonly repository: string;
  readonly executableFingerprint: string;
  readonly configHash: string;
  readonly socketPath: string;
  readonly state: 'starting' | 'running' | 'stopping' | 'config-drift' | 'failed';
  readonly lastCycleStartedAt?: string;
  readonly lastCycleFinishedAt?: string;
  readonly lastCycleExitCode?: number | null;
}

export type DaemonClassification =
  | 'already-running'
  | 'stale'
  | 'unsafe-live-mismatch';

export function classifyDaemonRecord(
  record: DaemonMetadata,
  actual: {
    readonly processAlive: boolean;
    readonly processStartedAt: string | null;
    readonly repository: string;
    readonly executableFingerprint: string;
  },
): DaemonClassification {
  if (!actual.processAlive) return 'stale';
  return (
    actual.processStartedAt === record.processStartedAt
    && actual.repository === record.repository
    && actual.executableFingerprint === record.executableFingerprint
  )
    ? 'already-running'
    : 'unsafe-live-mismatch';
}

export function shouldRunDaemonCycle(input: {
  readonly stopping: boolean;
  readonly startupConfigHash: string;
  readonly currentConfigHash: string;
}): { readonly run: true } | {
  readonly run: false;
  readonly reason: 'stopping' | 'config-drift';
} {
  if (input.stopping) return { run: false, reason: 'stopping' };
  if (input.currentConfigHash !== input.startupConfigHash) {
    return { run: false, reason: 'config-drift' };
  }
  return { run: true };
}

function hashFile(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

export function configurationHash(path: string): string {
  return hashFile(path);
}

export function executableFingerprint(entryPath: string): string {
  const executable = realpathSync(process.execPath);
  const entry = realpathSync(entryPath);
  const executableStat = statSync(executable);
  const hash = createHash('sha256');
  hash.update(executable);
  hash.update('\0');
  hash.update([
    executableStat.dev,
    executableStat.ino,
    executableStat.size,
    executableStat.mtimeMs,
  ].join(':'));
  hash.update('\0');
  hash.update(entry);
  hash.update('\0');
  hash.update(readFileSync(entry));
  return `sha256:${hash.digest('hex')}`;
}

function metadataPath(loaded: LoadedAutopilotConfig): string {
  return join(loaded.paths.service, 'daemon.json');
}

function socketPath(loaded: LoadedAutopilotConfig): string {
  return join(loaded.paths.service, 'control.sock');
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function readDaemonMetadata(
  loaded: LoadedAutopilotConfig,
): DaemonMetadata | null {
  const path = metadataPath(loaded);
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('daemon metadata must be a regular owner-only file');
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as DaemonMetadata;
  if (
    parsed.schemaVersion !== 1
    || !Number.isSafeInteger(parsed.pid)
    || parsed.pid <= 0
    || typeof parsed.processStartedAt !== 'string'
    || typeof parsed.repository !== 'string'
    || typeof parsed.executableFingerprint !== 'string'
  ) {
    throw new Error('daemon metadata is malformed');
  }
  return parsed;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function processStartedAt(pid: number): Promise<string | null> {
  if (!processAlive(pid)) return null;
  const child = spawn('ps', ['-p', String(pid), '-o', 'lstart='], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { output += chunk; });
  const code = await new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null));
    child.once('exit', resolve);
  });
  return code === 0 && output.trim() !== '' ? output.trim() : null;
}

export async function inspectDaemon(input: {
  readonly loaded: LoadedAutopilotConfig;
  readonly entryPath: string;
}): Promise<{
  readonly classification: DaemonClassification | 'not-running';
  readonly metadata: DaemonMetadata | null;
}> {
  const metadata = readDaemonMetadata(input.loaded);
  if (metadata == null) return { classification: 'not-running', metadata: null };
  return {
    classification: classifyDaemonRecord(metadata, {
      processAlive: processAlive(metadata.pid),
      processStartedAt: await processStartedAt(metadata.pid),
      repository: input.loaded.config.repository.slug,
      executableFingerprint: executableFingerprint(input.entryPath),
    }),
    metadata,
  };
}

export function serviceCredentialEnvironment(
  loaded: LoadedAutopilotConfig,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!existsSync(loaded.paths.credentials)) return { ...environment };
  const stat = lstatSync(loaded.paths.credentials);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('credentials.json must be a regular owner-only file');
  }
  const profile = JSON.parse(readFileSync(loaded.paths.credentials, 'utf8')) as {
    implementation?: { token?: unknown } | null;
    review?: { token?: unknown } | null;
  };
  return {
    ...environment,
    ...(environment.AUTOPILOT_GITHUB_IMPLEMENT_TOKEN != null
      ? {}
      : typeof profile.implementation?.token === 'string'
        ? { AUTOPILOT_GITHUB_IMPLEMENT_TOKEN: profile.implementation.token }
        : {}),
    ...(environment.AUTOPILOT_GITHUB_REVIEW_TOKEN != null
      ? {}
      : typeof profile.review?.token === 'string'
        ? { AUTOPILOT_GITHUB_REVIEW_TOKEN: profile.review.token }
        : {}),
  };
}

export async function startService(input: {
  readonly loaded: LoadedAutopilotConfig;
  readonly entryPath: string;
  readonly foreground: boolean;
  readonly doctor: () => Promise<DoctorReport>;
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<{ readonly status: 'started' | 'already-running'; readonly pid: number }> {
  const report = await input.doctor();
  if (report.blocking) {
    throw new Error('Autopilot doctor found blocking failures; start was refused');
  }
  mkdirSync(input.loaded.paths.service, { recursive: true, mode: 0o700 });
  mkdirSync(input.loaded.paths.logs, { recursive: true, mode: 0o700 });
  const inspected = await inspectDaemon(input);
  if (inspected.classification === 'already-running') {
    return { status: 'already-running', pid: inspected.metadata!.pid };
  }
  if (inspected.classification === 'unsafe-live-mismatch') {
    throw new Error(
      'Recorded daemon PID is live but its identity does not match; refusing replacement',
    );
  }
  if (inspected.classification === 'stale') {
    rmSync(metadataPath(input.loaded), { force: true });
    rmSync(socketPath(input.loaded), { force: true });
  }
  if (input.foreground) {
    await runDaemon({
      loaded: input.loaded,
      entryPath: input.entryPath,
      environment: serviceCredentialEnvironment(
        input.loaded,
        input.environment ?? process.env,
      ),
    });
    return { status: 'started', pid: process.pid };
  }
  const logPath = join(input.loaded.paths.logs, 'engine.log');
  const descriptor = openSync(logPath, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [
      input.entryPath,
      'internal',
      'daemon',
      input.loaded.repositoryRoot,
    ], {
      cwd: input.loaded.repositoryRoot,
      detached: true,
      env: serviceCredentialEnvironment(
        input.loaded,
        input.environment ?? process.env,
      ),
      stdio: ['ignore', descriptor, descriptor],
    });
    child.unref();
    if (child.pid == null) throw new Error('daemon process did not report a PID');
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (existsSync(metadataPath(input.loaded))) {
        const inspectedAfterStart = await inspectDaemon(input);
        if (inspectedAfterStart.classification === 'already-running') {
          return { status: 'started', pid: child.pid };
        }
        if (inspectedAfterStart.classification === 'unsafe-live-mismatch') {
          throw new Error('new daemon wrote unverifiable process metadata');
        }
      }
      if (!processAlive(child.pid)) {
        throw new Error(`daemon exited during startup; inspect ${logPath}`);
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    throw new Error(`daemon did not become ready; inspect ${logPath}`);
  } finally {
    closeSync(descriptor);
  }
}

function updateMetadata(
  loaded: LoadedAutopilotConfig,
  metadata: DaemonMetadata,
  patch: Partial<DaemonMetadata>,
): DaemonMetadata {
  const next = { ...metadata, ...patch };
  atomicWriteJson(metadataPath(loaded), next);
  return next;
}

export async function runDaemon(input: {
  readonly loaded: LoadedAutopilotConfig;
  readonly entryPath: string;
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<void> {
  mkdirSync(input.loaded.paths.service, { recursive: true, mode: 0o700 });
  mkdirSync(input.loaded.paths.logs, { recursive: true, mode: 0o700 });
  const controlPath = socketPath(input.loaded);
  rmSync(controlPath, { force: true });
  const startupConfigHash = configurationHash(input.loaded.configPath);
  let stopping = false;
  let wake: (() => void) | undefined;
  let metadata: DaemonMetadata = {
    schemaVersion: 1,
    pid: process.pid,
    processStartedAt: (await processStartedAt(process.pid))
      ?? `pid-${process.pid}`,
    startedAt: new Date().toISOString(),
    repository: input.loaded.config.repository.slug,
    executableFingerprint: executableFingerprint(input.entryPath),
    configHash: startupConfigHash,
    socketPath: controlPath,
    state: 'starting',
  };

  const server = createServer((connection) => {
    let message = '';
    connection.setEncoding('utf8');
    connection.on('data', (chunk: string) => {
      message += chunk;
      if (message.trim() === 'stop') {
        stopping = true;
        metadata = updateMetadata(input.loaded, metadata, { state: 'stopping' });
        wake?.();
        connection.end('stopping\n');
      }
    });
    connection.on('end', () => {
      if (message.trim() !== 'stop') connection.end('unknown command\n');
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(controlPath, () => resolvePromise());
  });
  chmodSync(controlPath, 0o600);
  metadata = updateMetadata(input.loaded, metadata, { state: 'running' });

  const requestStop = (): void => {
    stopping = true;
    metadata = updateMetadata(input.loaded, metadata, { state: 'stopping' });
    wake?.();
  };
  process.once('SIGTERM', requestStop);
  process.once('SIGINT', requestStop);
  try {
    while (true) {
      const decision = shouldRunDaemonCycle({
        stopping,
        startupConfigHash,
        currentConfigHash: configurationHash(input.loaded.configPath),
      });
      if (!decision.run) {
        if (decision.reason === 'config-drift') {
          metadata = updateMetadata(input.loaded, metadata, { state: 'config-drift' });
          await new Promise<void>((resolvePromise) => {
            wake = resolvePromise;
          });
          wake = undefined;
          continue;
        }
        break;
      }

      metadata = updateMetadata(input.loaded, metadata, {
        lastCycleStartedAt: new Date().toISOString(),
      });
      const controller = spawn(process.execPath, [
        input.entryPath,
        'internal',
        'engine',
        '--mode',
        'active',
        '--once',
      ], {
        cwd: input.loaded.repositoryRoot,
        env: input.environment ?? process.env,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      const exitCode = await new Promise<number | null>((resolvePromise) => {
        controller.once('error', () => resolvePromise(null));
        controller.once('exit', resolvePromise);
      });
      metadata = updateMetadata(input.loaded, metadata, {
        lastCycleFinishedAt: new Date().toISOString(),
        lastCycleExitCode: exitCode,
        state: stopping ? 'stopping' : 'running',
      });
      if (stopping) break;
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(resolvePromise, input.loaded.config.scheduler.pollSeconds * 1_000);
        wake = () => {
          clearTimeout(timer);
          resolvePromise();
        };
      });
      wake = undefined;
    }
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    rmSync(controlPath, { force: true });
    rmSync(metadataPath(input.loaded), { force: true });
  }
}

async function requestControl(socket: string, message: string): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const connection = createConnection(socket);
    let output = '';
    connection.setEncoding('utf8');
    connection.once('error', reject);
    connection.on('data', (chunk: string) => { output += chunk; });
    connection.on('end', () => resolvePromise(output));
    connection.end(message);
  });
}

export async function stopService(input: {
  readonly loaded: LoadedAutopilotConfig;
  readonly entryPath: string;
  readonly force: boolean;
}): Promise<{ readonly status: 'not-running' | 'stopping' | 'forced' }> {
  const inspected = await inspectDaemon(input);
  if (inspected.classification === 'not-running' || inspected.classification === 'stale') {
    if (inspected.classification === 'stale') {
      rmSync(metadataPath(input.loaded), { force: true });
      rmSync(socketPath(input.loaded), { force: true });
    }
    return { status: 'not-running' };
  }
  if (inspected.classification === 'unsafe-live-mismatch') {
    throw new Error('Refusing to signal a live PID whose daemon identity does not match');
  }
  const metadata = inspected.metadata!;
  if (input.force) {
    process.kill(metadata.pid, 'SIGKILL');
    return { status: 'forced' };
  }
  await requestControl(metadata.socketPath, 'stop');
  return { status: 'stopping' };
}

export async function serviceStatus(input: {
  readonly loaded: LoadedAutopilotConfig;
  readonly entryPath: string;
}): Promise<{
  readonly status: 'not-running' | 'running' | 'stale' | 'unsafe';
  readonly daemon?: DaemonMetadata;
}> {
  const inspected = await inspectDaemon(input);
  switch (inspected.classification) {
    case 'not-running':
      return { status: 'not-running' };
    case 'stale':
      return { status: 'stale', daemon: inspected.metadata! };
    case 'unsafe-live-mismatch':
      return { status: 'unsafe', daemon: inspected.metadata! };
    case 'already-running':
      return { status: 'running', daemon: inspected.metadata! };
  }
}

const TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

export function redactLog(content: string): string {
  return content
    .replace(TOKEN_PATTERN, '[REDACTED_GITHUB_TOKEN]')
    .replace(
      /((?:GH_TOKEN|GITHUB_TOKEN|AUTOPILOT_GITHUB_(?:IMPLEMENT|REVIEW)_TOKEN)\s*[=:]\s*)\S+/gi,
      '$1[REDACTED]',
    );
}
