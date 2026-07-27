/**
 * Bounded Docker execution of the `jinn-mono.v1` verification plan.
 *
 * Networked immutable dependency installation is separated from the
 * network-disabled typecheck/compile/test phase. The sandbox never receives
 * GitHub, wallet, or RPC credentials from the host.
 */

import { createHash } from 'node:crypto';
import { posix } from 'node:path';
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

export const JINN_MONO_V1_VERIFICATION_NODE_IMAGE =
  'node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3';

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
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'NO_COLOR',
  'COREPACK_ENABLE_DOWNLOAD_PROMPT',
  'YARN_ENABLE_SCRIPTS',
  'YARN_ENABLE_IMMUTABLE_INSTALLS',
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
  readonly dockerInspector?: MarketplaceVerificationDockerInspector;
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
  const environment: Record<string, string> = {
    YARN_ENABLE_SCRIPTS: '0',
    YARN_ENABLE_IMMUTABLE_INSTALLS: '1',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    NO_COLOR: '1',
    CI: 'true',
  };
  for (const [key, value] of Object.entries(ambient)) {
    if (
      value !== undefined
      && SANDBOX_ENV_ALLOWLIST.has(key)
      && !isVerificationSecretEnvironmentKey(key)
    ) {
      environment[key] = value;
    }
  }
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
    input.command.label === 'install' ? 'install' : 'verify';
  const argv = [
    'run',
    '--rm',
    '--init',
    '--read-only',
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
  };
}

function networkForCommand(command: MarketplaceVerificationCommand):
MarketplaceVerificationDockerNetwork {
  return command.label === 'install' ? 'bridge' : 'none';
}

function classifyInstallFailure(stdout: string, stderr: string): 'stable-rejection' | 'recoverable' {
  const combined = `${stdout}\n${stderr}`;
  if (isStaleImmutableLockfileInstallFailure(combined)) {
    return 'stable-rejection';
  }
  return 'recoverable';
}

async function ensureSandboxCleanup(
  cleanup: MarketplaceVerificationSandboxCleanup,
): Promise<void> {
  const term = await cleanup({ signal: 'SIGTERM' });
  if (term === 'ambiguous') {
    throw new MarketplaceVerificationError(
      'unsafe-cleanup',
      'unsafe',
      'Marketplace verification sandbox teardown could not be confirmed after SIGTERM',
    );
  }
  const kill = await cleanup({ signal: 'SIGKILL' });
  if (kill === 'ambiguous') {
    throw new MarketplaceVerificationError(
      'unsafe-cleanup',
      'unsafe',
      'Marketplace verification sandbox teardown could not be confirmed after SIGKILL',
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
      if (inspector === undefined) {
        return { ok: true };
      }
      if (!(await inspector.inspectDaemon())) {
        return {
          ok: false,
          detail: 'Docker daemon is not reachable for marketplace verification',
        };
      }
      if (!(await inspector.inspectImage(JINN_MONO_V1_VERIFICATION_NODE_IMAGE))) {
        return {
          ok: false,
          detail: `Pinned marketplace verification image is unavailable: ${JINN_MONO_V1_VERIFICATION_NODE_IMAGE}`,
        };
      }
      return { ok: true };
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
          if (now().getTime() >= deadlineMs) {
            throw new MarketplaceVerificationError(
              'deadline-expired',
              'abandoned',
              `Marketplace adoption deadline ${input.deadline} passed before `
                + `verification command ${command.label}`,
            );
          }
          const startedAt = now().toISOString();
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
            const handle = await options.dockerRunner(invocation);
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
            const disposition = command.label === 'install'
              ? classifyInstallFailure(rawStdout, rawStderr)
              : 'stable-rejection';
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
