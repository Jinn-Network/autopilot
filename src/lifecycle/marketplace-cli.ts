import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { isGitHubSecretEnvironmentKey } from './credentials.js';

export interface MarketplaceMachineSubprocessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type MarketplaceMachineSubprocess = (
  command: string,
  args: readonly string[],
  options: { readonly environment: NodeJS.ProcessEnv },
) => Promise<MarketplaceMachineSubprocessResult>;

export type MarketplaceMachineCliFailureCode =
  | 'funding_required'
  | 'invalid_invocation'
  | 'bootstrap_incomplete'
  | 'reconcile_needed'
  | 'transient_error'
  | 'fatal';

export interface MarketplaceMachineCliFailureEnvelope {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly code: MarketplaceMachineCliFailureCode;
  readonly exitCode: number;
  readonly message: string;
  readonly hint?: string;
  readonly exampleCli?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class MarketplaceMachineCliProtocolError extends Error {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    message: string,
    result: MarketplaceMachineSubprocessResult,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'MarketplaceMachineCliProtocolError';
    this.exitCode = result.exitCode;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

export class MarketplaceMachineCliFailure extends Error {
  readonly code: MarketplaceMachineCliFailureCode;
  readonly exitCode: number;
  readonly envelope: MarketplaceMachineCliFailureEnvelope;
  readonly stderr: string;

  constructor(
    envelope: MarketplaceMachineCliFailureEnvelope,
    stderr: string,
  ) {
    super(envelope.message);
    this.name = 'MarketplaceMachineCliFailure';
    this.code = envelope.code;
    this.exitCode = envelope.exitCode;
    this.envelope = envelope;
    this.stderr = stderr;
  }
}

export function resolveInstalledJinnBinary(): string {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve('@jinn-network/client/package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    readonly bin?: string | Readonly<Record<string, string>>;
  };
  const declared = typeof packageJson.bin === 'string'
    ? packageJson.bin
    : packageJson.bin?.jinn;
  if (declared === undefined || declared.length === 0) {
    throw new Error('Installed @jinn-network/client does not declare the jinn binary');
  }
  const binary = resolve(dirname(packageJsonPath), declared);
  accessSync(binary, fsConstants.X_OK);
  return binary;
}

export const MARKETPLACE_MACHINE_SUBPROCESS_TIMEOUT_MS = 300_000;
export const MARKETPLACE_MACHINE_SUBPROCESS_OUTPUT_LIMIT_BYTES = 1024 * 1024;

export class MarketplaceMachineSubprocessPolicyError extends Error {
  readonly reason: 'timeout' | 'output-limit';

  constructor(reason: 'timeout' | 'output-limit', message: string) {
    super(message);
    this.name = 'MarketplaceMachineSubprocessPolicyError';
    this.reason = reason;
  }
}

export const runMarketplaceMachineSubprocess: MarketplaceMachineSubprocess = (
  command,
  args,
  options,
) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], {
    env: options.environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let settled = false;
  let timedOut = false;
  let exceededOutput = false;

  const stop = (reason: 'timeout' | 'output'): void => {
    if (settled) return;
    if (reason === 'timeout') timedOut = true;
    else exceededOutput = true;
    child.kill('SIGKILL');
  };
  const timer = setTimeout(
    () => stop('timeout'),
    MARKETPLACE_MACHINE_SUBPROCESS_TIMEOUT_MS,
  );
  const collect = (target: Buffer[], chunk: Buffer): void => {
    if (settled) return;
    outputBytes += chunk.byteLength;
    if (outputBytes > MARKETPLACE_MACHINE_SUBPROCESS_OUTPUT_LIMIT_BYTES) {
      stop('output');
      return;
    }
    target.push(chunk);
  };
  child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
  child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
  child.on('error', (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(error);
  });
  child.on('close', (exitCode) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (timedOut) {
      reject(new MarketplaceMachineSubprocessPolicyError(
        'timeout',
        `${command} ${args.join(' ')} exceeded ${MARKETPLACE_MACHINE_SUBPROCESS_TIMEOUT_MS}ms`,
      ));
      return;
    }
    if (exceededOutput) {
      reject(new MarketplaceMachineSubprocessPolicyError(
        'output-limit',
        `${command} ${args.join(' ')} exceeded its output limit`,
      ));
      return;
    }
    resolve({
      exitCode: exitCode ?? 50,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    });
  });
});

export function marketplaceMachineEnvironment(
  ambient: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(ambient)) {
    if (
      value !== undefined
      && !isGitHubSecretEnvironmentKey(key)
      && key !== 'GH_CONFIG_DIR'
    ) {
      environment[key] = value;
    }
  }
  environment.NO_COLOR = '1';
  return environment;
}

export function parseMarketplaceMachineJson(stdout: string): unknown {
  return JSON.parse(stdout) as unknown;
}

const FAILURE_EXIT_CODES: Readonly<Record<MarketplaceMachineCliFailureCode, number>> = {
  funding_required: 10,
  invalid_invocation: 11,
  bootstrap_incomplete: 20,
  reconcile_needed: 30,
  transient_error: 40,
  fatal: 50,
};

export function parseMarketplaceMachineFailure(
  result: MarketplaceMachineSubprocessResult,
  command = 'jinn tasks submit',
): MarketplaceMachineCliFailureEnvelope {
  let value: unknown;
  try {
    value = parseMarketplaceMachineJson(result.stdout);
  } catch (error) {
    throw new MarketplaceMachineCliProtocolError(
      `${command} returned malformed failure output`, result, error,
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MarketplaceMachineCliProtocolError(
      `${command} returned malformed failure output`, result,
    );
  }
  const record = value as Record<string, unknown>;
  const code = record.code;
  const expectedExitCode = typeof code === 'string'
    && Object.hasOwn(FAILURE_EXIT_CODES, code)
    ? FAILURE_EXIT_CODES[code as MarketplaceMachineCliFailureCode]
    : undefined;
  const details = record.details;
  if (
    record.schemaVersion !== 1
    || typeof record.generatedAt !== 'string'
    || !Number.isFinite(Date.parse(record.generatedAt))
    || expectedExitCode === undefined
    || record.exitCode !== expectedExitCode
    || result.exitCode !== expectedExitCode
    || typeof record.message !== 'string'
    || record.message.length === 0
    || (record.hint !== undefined && typeof record.hint !== 'string')
    || (record.exampleCli !== undefined && typeof record.exampleCli !== 'string')
    || (details !== undefined && (details === null || typeof details !== 'object' || Array.isArray(details)))
  ) {
    throw new MarketplaceMachineCliProtocolError(
      `${command} returned malformed failure output`, result,
    );
  }
  return value as MarketplaceMachineCliFailureEnvelope;
}

export function throwMarketplaceMachineFailure(
  result: MarketplaceMachineSubprocessResult,
  command?: string,
): never {
  throw new MarketplaceMachineCliFailure(
    parseMarketplaceMachineFailure(result, command), result.stderr,
  );
}
