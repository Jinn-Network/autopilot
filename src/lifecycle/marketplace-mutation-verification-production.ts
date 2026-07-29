/**
 * Bounded Docker execution of the `jinn-mono.v1` verification plan.
 *
 * Networked immutable dependency installation is separated from the
 * network-disabled typecheck/compile/test phase. The sandbox never receives
 * GitHub, wallet, or RPC credentials from the host.
 */

import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import { isGitHubSecretEnvironmentKey } from './credentials.js';
import { exactUtcTimestampMs } from './exact-utc-time.js';
import type { MarketplaceVerificationEvidence } from './marketplace-execution-state.js';
import {
  buildJinnMonoV1VerificationPlan,
  MarketplaceVerificationError,
  marketplaceVerificationCommandCwdRelative,
  marketplaceVerificationPlanDigest,
  type MarketplaceMutationVerificationPort,
  type MarketplaceVerificationCommand,
  type MarketplaceVerificationRunResult,
} from './marketplace-mutation-verification.js';

const execFileAsync = promisify(execFile);

export const JINN_MONO_V1_VERIFICATION_NODE_IMAGE =
  'cimg/node@sha256:dd75a8e98b54cbb37b262a9c31abc09212fd0a2bd47b2087758a5771e8167b2d';

export const MARKETPLACE_VERIFICATION_SANDBOX_LIMITS = {
  cpus: '2',
  memory: '4g',
  memorySwap: '4g',
  pidsLimit: '256',
  perCommandTimeoutSeconds: 600,
  stopTimeoutSeconds: 10,
  maxRetainedOutputBytes: 65_536,
} as const;

const SANDBOX_ENV_ALLOWLIST = new Set([
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'CI',
]);

const VERIFICATION_SECRET_ENV =
  /(?:WALLET|PRIVATE_KEY|MNEMONIC|SEED_PHRASE|RPC_URL|INFURA|ALCHEMY|QUICKNODE|JINN_CONFIG|GH_CONFIG|AWS_|AZURE_|GCP_)/;

export type MarketplaceVerificationDockerPhase =
  | 'install'
  | 'verify';

export type MarketplaceVerificationDockerNetwork = 'bridge' | 'none';

export interface MarketplaceVerificationDockerInvocation {
  readonly label: string;
  readonly phase: MarketplaceVerificationDockerPhase;
  readonly network: MarketplaceVerificationDockerNetwork;
  readonly image: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly perCommandTimeoutSeconds: number;
}

export interface MarketplaceVerificationDockerHandle {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type MarketplaceVerificationDockerRunner = (
  invocation: MarketplaceVerificationDockerInvocation,
) => Promise<MarketplaceVerificationDockerHandle>;

export interface MarketplaceVerificationDockerInspector {
  inspectDaemon(): Promise<boolean>;
  inspectImage(image: string): Promise<boolean>;
}

export type MarketplaceVerificationSandboxCleanupResult =
  | 'confirmed'
  | 'ambiguous';

export interface MarketplaceVerificationSandboxCleanupInput {
  readonly signal: 'SIGTERM' | 'SIGKILL';
}

export type MarketplaceVerificationSandboxCleanup = (
  input: MarketplaceVerificationSandboxCleanupInput,
) => Promise<MarketplaceVerificationSandboxCleanupResult>;

export interface ProductionMarketplaceVerificationPortOptions {
  readonly dockerRunner: MarketplaceVerificationDockerRunner;
  readonly dockerInspector: MarketplaceVerificationDockerInspector;
  readonly prepareWorkspace?: (input: {
    readonly sourcePath: string;
    readonly workspacePath: string;
  }) => Promise<void>;
  readonly cleanup?: MarketplaceVerificationSandboxCleanup;
  readonly workspacePath?: string;
  readonly ambientEnvironment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
}

function isVerificationSecretEnvironmentKey(key: string): boolean {
  if (isGitHubSecretEnvironmentKey(key)) return true;
  return VERIFICATION_SECRET_ENV.test(key.toUpperCase());
}

export function sanitizeMarketplaceVerificationSandboxEnvironment(
  ambient: NodeJS.ProcessEnv,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(ambient)) {
    if (
      value !== undefined
      && SANDBOX_ENV_ALLOWLIST.has(key)
      && !isVerificationSecretEnvironmentKey(key)
    ) {
      environment[key] = value;
    }
  }
  environment.YARN_ENABLE_SCRIPTS = '0';
  environment.YARN_ENABLE_IMMUTABLE_INSTALLS = '1';
  environment.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';
  environment.NO_COLOR = '1';
  environment.CI = 'true';
  environment.HOME = '/workspace';
  environment.GIT_AUTHOR_NAME = 'Jinn Marketplace Verifier';
  environment.GIT_AUTHOR_EMAIL = 'verifier@jinn.network';
  environment.GIT_COMMITTER_NAME = 'Jinn Marketplace Verifier';
  environment.GIT_COMMITTER_EMAIL = 'verifier@jinn.network';
  return environment;
}

export function digestBoundedVerificationOutput(output: string): string {
  const retained = output.slice(0, MARKETPLACE_VERIFICATION_SANDBOX_LIMITS.maxRetainedOutputBytes);
  return `sha256:${createHash('sha256').update(retained, 'utf8').digest('hex')}`;
}

export function isStaleImmutableLockfileInstallFailure(output: string): boolean {
  return /YN0028:|lockfile would have been modified|immutable.*lockfile|out-of-date lockfile/i
    .test(output);
}

function sandboxWorkdir(
  repositoryPath: string,
  command: MarketplaceVerificationCommand,
): string {
  const relative = posix.relative(repositoryPath, command.cwd);
  if (relative === '' || relative === '.') return '/workspace';
  return posix.join('/workspace', relative);
}

function dockerEnvFlags(environment: Readonly<Record<string, string>>): string[] {
  const flags: string[] = [];
  for (const [key, value] of Object.entries(environment)) {
    flags.push('-e', `${key}=${value}`);
  }
  return flags;
}

export function buildMarketplaceVerificationDockerInvocation(input: {
  readonly repositoryPath: string;
  readonly workspacePath: string;
  readonly command: MarketplaceVerificationCommand;
  readonly network: MarketplaceVerificationDockerNetwork;
  readonly environment: Readonly<Record<string, string>>;
}): MarketplaceVerificationDockerInvocation {
  const phase: MarketplaceVerificationDockerPhase =
    input.command.label.startsWith('install:') ? 'install' : 'verify';
  const argv = [
    'run',
    '--rm',
    '--init',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,exec,nosuid',
    '--tmpfs',
    '/run:rw,noexec,nosuid',
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    `--cpus=${MARKETPLACE_VERIFICATION_SANDBOX_LIMITS.cpus}`,
    `--memory=${MARKETPLACE_VERIFICATION_SANDBOX_LIMITS.memory}`,
    `--memory-swap=${MARKETPLACE_VERIFICATION_SANDBOX_LIMITS.memorySwap}`,
    `--pids-limit=${MARKETPLACE_VERIFICATION_SANDBOX_LIMITS.pidsLimit}`,
    '--stop-timeout',
    String(MARKETPLACE_VERIFICATION_SANDBOX_LIMITS.stopTimeoutSeconds),
    '--network',
    input.network,
    `--mount=type=bind,source=${input.repositoryPath},target=/source,readonly`,
    `--mount=type=bind,source=${input.workspacePath},target=/workspace`,
    '--workdir',
    sandboxWorkdir(input.repositoryPath, input.command),
    ...dockerEnvFlags(input.environment),
    JINN_MONO_V1_VERIFICATION_NODE_IMAGE,
    input.command.command,
    ...input.command.args,
  ];
  return {
    label: input.command.label,
    phase,
    network: input.network,
    image: JINN_MONO_V1_VERIFICATION_NODE_IMAGE,
    argv,
    env: input.environment,
    perCommandTimeoutSeconds: MARKETPLACE_VERIFICATION_SANDBOX_LIMITS.perCommandTimeoutSeconds,
  };
}

function networkForCommand(command: MarketplaceVerificationCommand):
MarketplaceVerificationDockerNetwork {
  return command.label.startsWith('install:') ? 'bridge' : 'none';
}

function classifyInstallFailure(stdout: string, stderr: string): 'stable-rejection' | 'recoverable' {
  const combined = `${stdout}\n${stderr}`;
  if (isStaleImmutableLockfileInstallFailure(combined)) {
    return 'stable-rejection';
  }
  return 'recoverable';
}

function classifyNonInstallFailure(exitCode: number): 'stable-rejection' | 'recoverable' {
  if (exitCode === 137 || exitCode === 143) {
    return 'recoverable';
  }
  return 'stable-rejection';
}

async function runDockerWithPerCommandTimeout(input: {
  readonly runner: MarketplaceVerificationDockerRunner;
  readonly invocation: MarketplaceVerificationDockerInvocation;
  readonly remainingMs: number;
}): Promise<MarketplaceVerificationDockerHandle> {
  const timeoutMs = Math.min(
    input.invocation.perCommandTimeoutSeconds * 1000,
    input.remainingMs,
  );
  if (timeoutMs <= 0) {
    throw new MarketplaceVerificationError(
      'deadline-expired',
      'abandoned',
      `Marketplace adoption deadline passed during verification command ${input.invocation.label}`,
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      input.runner(input.invocation),
      new Promise<MarketplaceVerificationDockerHandle>((_, reject) => {
        timer = setTimeout(() => {
          const cappedByDeadline = input.remainingMs < input.invocation.perCommandTimeoutSeconds * 1000;
          reject(new MarketplaceVerificationError(
            cappedByDeadline ? 'deadline-expired' : 'runner-failed',
            cappedByDeadline ? 'abandoned' : 'recoverable',
            cappedByDeadline
              ? `Marketplace adoption deadline passed during verification command ${input.invocation.label}`
              : `Marketplace verification command ${input.invocation.label} exceeded `
                + `${input.invocation.perCommandTimeoutSeconds}s`,
          ));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function ensureSandboxCleanup(
  cleanup: MarketplaceVerificationSandboxCleanup,
): Promise<void> {
  await cleanup({ signal: 'SIGTERM' });
  const kill = await cleanup({ signal: 'SIGKILL' });
  if (kill === 'ambiguous') {
    throw new MarketplaceVerificationError(
      'unsafe-cleanup',
      'unsafe',
      'Marketplace verification sandbox teardown could not be confirmed after SIGKILL',
    );
  }
}

async function dockerContainerRunning(name: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('docker', [
      'inspect',
      '-f',
      '{{.State.Running}}',
      name,
    ]);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export function createMarketplaceVerificationDockerInspector(): MarketplaceVerificationDockerInspector {
  return {
    inspectDaemon: async () => {
      try {
        await execFileAsync('docker', ['info']);
        return true;
      } catch {
        return false;
      }
    },
    inspectImage: async (image) => {
      try {
        await execFileAsync('docker', ['image', 'inspect', image]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function createMarketplaceVerificationDockerSandbox(): {
  readonly dockerRunner: MarketplaceVerificationDockerRunner;
  readonly dockerInspector: MarketplaceVerificationDockerInspector;
  readonly cleanup: MarketplaceVerificationSandboxCleanup;
} {
  const activeContainers = new Set<string>();
  let activeChild: ReturnType<typeof spawn> | undefined;

  const dockerRunner: MarketplaceVerificationDockerRunner = async (invocation) => {
    const containerName = `jinn-verify-${randomUUID()}`;
    const argv = [...invocation.argv];
    const runIndex = argv.indexOf('run');
    if (runIndex >= 0) {
      argv.splice(runIndex + 1, 0, '--name', containerName);
    }
    activeContainers.add(containerName);

    return new Promise((resolve, reject) => {
      const child = spawn('docker', argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      activeChild = child;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const maxBytes = MARKETPLACE_VERIFICATION_SANDBOX_LIMITS.maxRetainedOutputBytes;

      const collectStdout = (chunk: Buffer): void => {
        if (stdoutBytes + chunk.byteLength > maxBytes) return;
        stdoutBytes += chunk.byteLength;
        stdout.push(chunk);
      };
      const collectStderr = (chunk: Buffer): void => {
        if (stderrBytes + chunk.byteLength > maxBytes) return;
        stderrBytes += chunk.byteLength;
        stderr.push(chunk);
      };

      child.stdout.on('data', collectStdout);
      child.stderr.on('data', collectStderr);
      child.on('error', (error) => {
        activeChild = undefined;
        activeContainers.delete(containerName);
        reject(error);
      });
      child.on('close', (code, signal) => {
        activeChild = undefined;
        activeContainers.delete(containerName);
        const exitCode = code ?? (signal === null ? 1 : 128);
        resolve({
          exitCode,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
    });
  };

  const cleanup: MarketplaceVerificationSandboxCleanup = async ({ signal }) => {
    if (activeChild !== undefined) {
      activeChild.kill(signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM');
    }
    const targets = [...activeContainers];
    for (const name of targets) {
      try {
        await execFileAsync('docker', [
          'kill',
          ...(signal === 'SIGKILL' ? ['-s', '9'] : ['-s', '15']),
          name,
        ]);
      } catch {
        // container may already have exited
      }
      if (await dockerContainerRunning(name)) {
        if (signal === 'SIGKILL') return 'ambiguous';
        continue;
      }
      activeContainers.delete(name);
    }
    return activeContainers.size === 0 ? 'confirmed' : 'ambiguous';
  };

  return {
    dockerRunner,
    dockerInspector: createMarketplaceVerificationDockerInspector(),
    cleanup,
  };
}

async function ensureProductionVerificationInfrastructure(
  inspector: MarketplaceVerificationDockerInspector,
): Promise<void> {
  if (!(await inspector.inspectDaemon())) {
    throw new MarketplaceVerificationError(
      'runner-failed',
      'recoverable',
      'Docker daemon is not reachable for marketplace verification',
    );
  }
  if (!(await inspector.inspectImage(JINN_MONO_V1_VERIFICATION_NODE_IMAGE))) {
    throw new MarketplaceVerificationError(
      'runner-failed',
      'recoverable',
      `Pinned marketplace verification image is unavailable: ${JINN_MONO_V1_VERIFICATION_NODE_IMAGE}`,
    );
  }
}

export function createProductionMarketplaceVerificationPort(
  options: ProductionMarketplaceVerificationPortOptions,
): MarketplaceMutationVerificationPort {
  const now = options.now ?? (() => new Date());
  const workspacePath = options.workspacePath ?? '/tmp/autopilot/verification-workspace';
  const ambient = options.ambientEnvironment ?? process.env;
  const environment = sanitizeMarketplaceVerificationSandboxEnvironment(ambient);
  const prepareWorkspace = options.prepareWorkspace
    ?? (async () => {});
  const cleanup = options.cleanup
    ?? (async () => 'confirmed' as const);
  const inspector = options.dockerInspector;

  return {
    preflight: async () => {
      try {
        await ensureProductionVerificationInfrastructure(inspector);
        return { ok: true };
      } catch (error) {
        if (error instanceof MarketplaceVerificationError) {
          return { ok: false, detail: error.message };
        }
        throw error;
      }
    },
    verify: async (input) => {
      const plan = buildJinnMonoV1VerificationPlan({
        repositoryPath: input.repositoryPath,
        touchedPaths: input.touchedPaths,
      });
      const deadlineMs = exactUtcTimestampMs(input.deadline);
      if (deadlineMs === null) {
        throw new MarketplaceVerificationError(
          'invalid-deadline',
          'abandoned',
          `Marketplace adoption deadline is not an exact UTC timestamp: ${input.deadline}`,
        );
      }
      if (now().getTime() >= deadlineMs) {
        throw new MarketplaceVerificationError(
          'deadline-expired',
          'abandoned',
          `Marketplace adoption deadline ${input.deadline} passed before verification started`,
        );
      }

      await ensureProductionVerificationInfrastructure(inspector);

      let sandboxActive = false;
      let failure: unknown;
      try {
        await prepareWorkspace({
          sourcePath: input.repositoryPath,
          workspacePath,
        });
        sandboxActive = true;

        const commands: MarketplaceVerificationEvidence['commands'][number][] = [];
        for (const command of plan.commands) {
          const nowMs = now().getTime();
          if (nowMs >= deadlineMs) {
            throw new MarketplaceVerificationError(
              'deadline-expired',
              'abandoned',
              `Marketplace adoption deadline ${input.deadline} passed before `
                + `verification command ${command.label}`,
            );
          }
          const startedAt = now().toISOString();
          const remainingMs = deadlineMs - nowMs;
          let result: MarketplaceVerificationRunResult;
          let rawStdout = '';
          let rawStderr = '';
          try {
            const invocation = buildMarketplaceVerificationDockerInvocation({
              repositoryPath: input.repositoryPath,
              workspacePath,
              command,
              network: networkForCommand(command),
              environment,
            });
            const handle = await runDockerWithPerCommandTimeout({
              runner: options.dockerRunner,
              invocation,
              remainingMs,
            });
            rawStdout = handle.stdout;
            rawStderr = handle.stderr;
            result = {
              exitCode: handle.exitCode,
              stdoutDigest: digestBoundedVerificationOutput(handle.stdout),
              stderrDigest: digestBoundedVerificationOutput(handle.stderr),
            };
          } catch (error) {
            if (error instanceof MarketplaceVerificationError) throw error;
            throw new MarketplaceVerificationError(
              'runner-failed',
              'recoverable',
              `Marketplace verification command ${command.label} could not be run`,
              error,
            );
          }
          if (result.exitCode !== 0) {
            const disposition = command.label.startsWith('install:')
              ? classifyInstallFailure(rawStdout, rawStderr)
              : classifyNonInstallFailure(result.exitCode);
            throw new MarketplaceVerificationError(
              'command-failed',
              disposition,
              `Marketplace verification command ${command.label} exited ${result.exitCode}`,
            );
          }
          commands.push({
            label: command.label,
            command: command.command,
            args: [...command.args],
            cwdRelative: marketplaceVerificationCommandCwdRelative(plan, command),
            status: 'passed',
            exitCode: 0,
            stdoutDigest: result.stdoutDigest,
            stderrDigest: result.stderrDigest,
            startedAt,
            completedAt: now().toISOString(),
          });
        }

        return {
          profile: 'jinn-mono.v1',
          artifactDigest: input.artifactDigest,
          expectedTree: input.expectedTree,
          planDigest: marketplaceVerificationPlanDigest(plan),
          commands,
          verifiedAt: now().toISOString(),
        };
      } catch (error) {
        failure = error;
      } finally {
        if (sandboxActive) {
          await ensureSandboxCleanup(cleanup);
        }
      }
      throw failure;
    },
  };
}
