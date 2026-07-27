import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
} from 'node:path';
import {
  AutopilotSessionCapsuleSchema,
  TaskSubmitRequestV1Schema,
  TaskSubmitResultV1Schema,
  type AutopilotSessionCapsule,
  type TaskSubmitRequestV1,
  type TaskSubmitResultV1,
} from '@jinn-network/sdk/autopilot';
import {
  MarketplaceMachineCliFailure,
  MarketplaceMachineCliProtocolError,
  marketplaceMachineEnvironment,
  parseMarketplaceMachineJson,
  runMarketplaceMachineSubprocess,
  resolveInstalledJinnBinary,
  parseMarketplaceMachineFailure,
  type MarketplaceMachineCliFailureCode as MarketplaceTaskCliFailureCode,
  type MarketplaceMachineCliFailureEnvelope as MarketplaceTaskCliFailureEnvelope,
  type MarketplaceMachineSubprocess as MarketplaceTaskSubprocess,
  type MarketplaceMachineSubprocessResult as MarketplaceTaskSubprocessResult,
} from './marketplace-cli.js';

export {
  resolveInstalledJinnBinary,
};
export type {
  MarketplaceTaskCliFailureCode,
  MarketplaceTaskCliFailureEnvelope,
  MarketplaceTaskSubprocess,
  MarketplaceTaskSubprocessResult,
};

export class MarketplaceTaskCliProtocolError extends MarketplaceMachineCliProtocolError {
  constructor(
    message: string,
    result: MarketplaceTaskSubprocessResult,
    cause?: unknown,
  ) {
    super(message, result, cause);
    this.name = 'MarketplaceTaskCliProtocolError';
  }
}

export class MarketplaceTaskCliFailure extends MarketplaceMachineCliFailure {
  constructor(envelope: MarketplaceTaskCliFailureEnvelope, stderr: string) {
    super(envelope, stderr);
    this.name = 'MarketplaceTaskCliFailure';
  }
}

import { JINN_MONO_REPOSITORY } from '../runtime-profile.js';

/**
 * The fixed marketplace profile is owned by the published SDK contract. Read
 * its legacy literal fields instead of embedding a standalone repository
 * fallback in the distributable Autopilot binary.
 */
export const MARKETPLACE_REPOSITORY = JINN_MONO_REPOSITORY;
export const MARKETPLACE_LANGUAGE = 'typescript';
export const MARKETPLACE_VERIFICATION_PROFILE = 'jinn-mono.v1';

export type MarketplaceMutationWorkflow =
  | 'implementation'
  | 'review-finding'
  | 'reconcile'
  | 'ci-failure';

export interface MarketplaceTaskSnapshot {
  readonly title: string;
  readonly body: string;
  readonly prBody: string;
  readonly baseSha: string;
  readonly targetBaseOid: string;
}

export interface MarketplaceTaskBuildInput {
  readonly workflow: MarketplaceMutationWorkflow;
  readonly repository: string;
  readonly language: string;
  readonly verificationProfile: string;
  readonly issueNumber: number;
  readonly childIssueNumber?: number;
  readonly parentPrNumber?: number;
  readonly prNumber: number;
  readonly targetBase: string;
  readonly branch: string;
  readonly claimOid: string;
  readonly expectedHead: string;
  readonly v2AttemptId: string;
  readonly runnerId: string;
  readonly taskSnapshot: MarketplaceTaskSnapshot;
  readonly receiptAuthors: readonly string[];
  readonly createdAt: number;
}

export interface BuiltMarketplaceTaskRequest {
  readonly session: AutopilotSessionCapsule;
  readonly request: TaskSubmitRequestV1;
  readonly agentSoftDeadline: string;
  readonly adoptionDeadline: string;
}

export interface PersistedMarketplaceTaskRequest {
  readonly requestPath: string;
  readonly requestDigest: string;
  readonly solverNetSelectionPath: string;
  readonly reused: boolean;
}

export function buildMarketplaceTaskRequest(
  input: MarketplaceTaskBuildInput,
): BuiltMarketplaceTaskRequest {
  if (
    input.repository !== MARKETPLACE_REPOSITORY
    || input.language !== MARKETPLACE_LANGUAGE
    || input.verificationProfile !== MARKETPLACE_VERIFICATION_PROFILE
  ) {
    throw new Error(
      `Marketplace Task submission supports only ${MARKETPLACE_REPOSITORY}, `
      + `${MARKETPLACE_LANGUAGE}, and verification profile `
      + MARKETPLACE_VERIFICATION_PROFILE,
    );
  }
  if (
    input.workflow === 'implementation'
    && (input.childIssueNumber !== undefined || input.parentPrNumber !== undefined)
  ) {
    throw new Error('Implementation marketplace sessions cannot bind child metadata');
  }
  if (
    input.workflow !== 'implementation'
    && (
      input.childIssueNumber === undefined
      || input.parentPrNumber === undefined
      || input.parentPrNumber !== input.prNumber
    )
  ) {
    throw new Error(
      'Child marketplace sessions require a child issue and matching parent PR',
    );
  }
  const claimWindowEnd = input.createdAt + 15 * 60 * 1_000;
  const agentSoftDeadline = input.createdAt + 60 * 60 * 1_000;
  const adoptionDeadline = input.createdAt + 90 * 60 * 1_000;
  const workflowFields = input.workflow === 'implementation'
    ? {
        workflow: 'implement',
        workflowContract: {
          skill: 'implement-issue',
          version: 'v2',
          resultSchema: 'jinn-autopilot-mutation-result.v1',
        },
      }
    : {
        workflow: input.workflow === 'review-finding'
          ? 'fix-child'
          : input.workflow,
        workflowContract: {
          skill: input.workflow === 'reconcile' ? 'reconcile' : 'fix-child',
          version: 'v2',
          resultSchema: 'jinn-autopilot-mutation-result.v1',
        },
        childIssueNumber: input.childIssueNumber,
        parentPrNumber: input.parentPrNumber,
      };
  const session = AutopilotSessionCapsuleSchema.parse({
    schemaVersion: 'jinn-autopilot-session.v1',
    ...workflowFields,
    repository: input.repository,
    language: input.language,
    verificationProfile: input.verificationProfile,
    issueNumber: input.issueNumber,
    prNumber: input.prNumber,
    targetBase: input.targetBase,
    branch: input.branch,
    claimOid: input.claimOid,
    expectedHead: input.expectedHead,
    v2AttemptId: input.v2AttemptId,
    runnerId: input.runnerId,
    taskSnapshot: input.taskSnapshot,
    deadline: new Date(agentSoftDeadline).toISOString(),
    receiptAuthors: [...input.receiptAuthors],
  });
  const id = `autopilot:${input.v2AttemptId}`;
  const request = TaskSubmitRequestV1Schema.parse({
    schemaVersion: 'jinn-task-submit-request.v1',
    id,
    description: input.taskSnapshot.title,
    solverType: 'jinn-repo.v1',
    solverNet: 'jinn-repo.v1',
    createdAt: input.createdAt,
    window: {
      startTs: input.createdAt,
      endTs: adoptionDeadline,
    },
    claimPolicy: {
      mode: 'exclusive',
      maxClaims: 1,
      maxClaimsPerOperator: 1,
      claimWindowStartTs: input.createdAt,
      claimWindowEndTs: claimWindowEnd,
      submissionDeadlineTs: adoptionDeadline,
      claimLeaseTtlSeconds: 60 * 60,
      requiredVerdicts: 1,
    },
    spec: {
      schemaVersion: 'jinn-repo.v1',
      instance_id: id,
      base_commit: input.expectedHead,
      problem_statement: input.taskSnapshot.body.length === 0
        ? input.taskSnapshot.title
        : input.taskSnapshot.body,
      repo: input.repository,
      language: input.language,
      verificationProfile: input.verificationProfile,
      source: 'autopilot-session',
      session,
    },
  });
  return {
    session,
    request,
    agentSoftDeadline: new Date(agentSoftDeadline).toISOString(),
    adoptionDeadline: new Date(adoptionDeadline).toISOString(),
  };
}

function requestDigest(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function persistMarketplaceTaskRequest(
  requestPath: string,
  input: TaskSubmitRequestV1,
): PersistedMarketplaceTaskRequest {
  if (!isAbsolute(requestPath)) {
    throw new Error('Marketplace Task request path must be absolute');
  }
  const request = TaskSubmitRequestV1Schema.parse(input);
  const bytes = Buffer.from(`${JSON.stringify(request, null, 2)}\n`);
  const digest = requestDigest(bytes);
  const temporary = join(
    dirname(requestPath),
    `.${basename(requestPath)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let descriptor: number | undefined;
  let reused = false;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    chmodSync(temporary, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(temporary, requestPath);
      fsyncDirectory(dirname(requestPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const metadata = lstatSync(requestPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error('Existing marketplace Task request is not a regular file');
      }
      const winner = readFileSync(requestPath);
      if (!winner.equals(bytes) || requestDigest(winner) !== digest) {
        throw new Error('Existing marketplace Task request conflicts with canonical bytes');
      }
      if ((metadata.mode & 0o777) !== 0o600) {
        throw new Error('Existing marketplace Task request does not have mode 0600');
      }
      reused = true;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) {
      rmSync(temporary);
      fsyncDirectory(dirname(requestPath));
    }
  }
  const persisted = readFileSync(requestPath);
  if (!persisted.equals(bytes) || requestDigest(persisted) !== digest) {
    throw new Error('Marketplace Task request verification failed after persistence');
  }
  return {
    requestPath,
    requestDigest: digest,
    solverNetSelectionPath: `${requestPath}.solvernet-selection.json`,
    reused,
  };
}

export function verifyMarketplaceTaskRequest(
  requestPath: string,
  expectedDigest: string,
): TaskSubmitRequestV1 {
  if (!isAbsolute(requestPath)) {
    throw new Error('Marketplace Task request path must be absolute');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) {
    throw new Error('Marketplace Task request expected digest is invalid');
  }
  const metadata = lstatSync(requestPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Marketplace Task request is not a regular file');
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error('Marketplace Task request does not have mode 0600');
  }
  const bytes = readFileSync(requestPath);
  if (requestDigest(bytes) !== expectedDigest) {
    throw new Error('Marketplace Task request digest mismatch');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('Marketplace Task request contains malformed JSON');
  }
  const request = TaskSubmitRequestV1Schema.parse(parsed);
  const canonical = Buffer.from(`${JSON.stringify(request, null, 2)}\n`);
  if (!canonical.equals(bytes)) {
    throw new Error('Marketplace Task request bytes are not canonical');
  }
  return request;
}

export interface MarketplaceTaskCliAdapterOptions {
  readonly jinnBinary?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly run?: MarketplaceTaskSubprocess;
}

export interface MarketplaceTaskDryRunResult {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly dryRun: true;
  readonly verb: 'tasks submit';
  readonly description: string;
  readonly plan: readonly Readonly<Record<string, unknown>>[];
}

function parseMarketplaceTaskDryRun(stdout: string): MarketplaceTaskDryRunResult {
  const value = parseMarketplaceMachineJson(stdout);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid jinn tasks submit dry-run result');
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1
    || typeof record.generatedAt !== 'string'
    || !Number.isFinite(Date.parse(record.generatedAt))
    || record.dryRun !== true
    || record.verb !== 'tasks submit'
    || typeof record.description !== 'string'
    || record.description.length === 0
    || !Array.isArray(record.plan)
    || record.plan.length === 0
    || record.plan.some((entry) =>
      entry === null || typeof entry !== 'object' || Array.isArray(entry))
  ) {
    throw new Error('Invalid jinn tasks submit dry-run result');
  }
  return value as MarketplaceTaskDryRunResult;
}

function throwMarketplaceTaskFailure(
  result: MarketplaceTaskSubprocessResult,
): never {
  try {
    throw new MarketplaceTaskCliFailure(
      parseMarketplaceMachineFailure(result), result.stderr,
    );
  } catch (error) {
    if (error instanceof MarketplaceMachineCliProtocolError) {
      throw new MarketplaceTaskCliProtocolError(
        error.message, result, error.cause,
      );
    }
    throw error;
  }
}

export class MarketplaceTaskCliAdapter {
  private readonly jinnBinary: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly run: MarketplaceTaskSubprocess;

  constructor(options: MarketplaceTaskCliAdapterOptions) {
    this.jinnBinary = options.jinnBinary ?? resolveInstalledJinnBinary();
    this.environment = marketplaceMachineEnvironment(
      options.environment ?? process.env,
    );
    this.run = options.run ?? runMarketplaceMachineSubprocess;
  }

  submit(requestPath: string): Promise<TaskSubmitResultV1> {
    return this.runSubmit(requestPath);
  }

  recover(requestPath: string): Promise<TaskSubmitResultV1> {
    return this.runSubmit(requestPath);
  }

  async dryRun(requestPath: string): Promise<MarketplaceTaskDryRunResult> {
    const result = await this.run(this.jinnBinary, [
      'tasks',
      'submit',
      '--request-file',
      requestPath,
      '--dry-run',
      '--yes',
      '--json',
    ], { environment: this.environment });
    if (result.exitCode !== 0) {
      throwMarketplaceTaskFailure(result);
    }
    try {
      return parseMarketplaceTaskDryRun(result.stdout);
    } catch (error) {
      throw new MarketplaceTaskCliProtocolError(
        'jinn tasks submit dry-run returned malformed successful output',
        result,
        error,
      );
    }
  }

  private async runSubmit(requestPath: string): Promise<TaskSubmitResultV1> {
    const result = await this.run(this.jinnBinary, [
      'tasks',
      'submit',
      '--request-file',
      requestPath,
      '--yes',
      '--json',
    ], { environment: this.environment });
    if (result.exitCode !== 0) {
      throwMarketplaceTaskFailure(result);
    }
    try {
      return TaskSubmitResultV1Schema.parse(parseMarketplaceMachineJson(result.stdout));
    } catch (error) {
      throw new MarketplaceTaskCliProtocolError(
        'jinn tasks submit returned malformed successful output',
        result,
        error,
      );
    }
  }
}
