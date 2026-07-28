import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  MarketplaceMachineCliProtocolError,
  parseMarketplaceMachineJson,
  runMarketplaceMachineSubprocess,
  resolveInstalledJinnBinary,
  throwMarketplaceMachineFailure,
  type MarketplaceMachineSubprocess,
  type MarketplaceMachineSubprocessResult,
} from '../lifecycle/marketplace-cli.js';
import { isGitHubSecretEnvironmentKey } from '../lifecycle/credentials.js';
import {
  IssueRelayRoundV1Schema,
  IssueRelayVerdictV1Schema,
  type IssueRelayRoundV1,
  type IssueRelayVerdictV1,
} from './contracts.js';
import { verifyRelayMarketplaceRequest } from './task.js';

export type IssueRelayMarketplaceSubprocess = MarketplaceMachineSubprocess;

export interface RelaySubmissionDryRun {
  readonly id: string;
  readonly creatorSafe: string;
  readonly solverNetManifestCid: string;
  readonly proposedSpendWei: bigint;
}

export interface RelaySubmissionEvidence {
  readonly id: string;
  readonly taskId: string;
  readonly taskCid: string;
  readonly creationTx: string;
  readonly creationBlock: number;
  readonly solverNetManifestCid: string;
  readonly idempotent: boolean;
}

export interface VerifiedIssueRelaySolutionObservation {
  readonly status: 'verified';
  readonly role: 'solution';
  readonly task: {
    readonly taskId: string;
    readonly taskCid: string;
  };
  readonly attempt: {
    readonly attemptIndex: number;
    readonly requestId: string;
    readonly operator: string;
  };
  readonly delivery: {
    readonly envelopeCid: string;
    readonly transactionHash: string;
    readonly blockNumber: number;
  };
  readonly round: IssueRelayRoundV1;
  readonly payload: {
    readonly schemaVersion: 'jinn-repo-solution.v1';
    readonly patch: string;
  };
}

export interface VerifiedIssueRelayVerdictObservation {
  readonly status: 'verified';
  readonly role: 'verdict';
  readonly task: {
    readonly taskId: string;
    readonly taskCid: string;
  };
  readonly attempt: {
    readonly attemptIndex: number;
    readonly requestId: string;
    readonly operator: string;
  };
  readonly delivery: {
    readonly envelopeCid: string;
    readonly transactionHash: string;
    readonly blockNumber: number;
  };
  readonly round: IssueRelayRoundV1;
  readonly payload: IssueRelayVerdictV1;
}

export type IssueRelayDeliveryObservation =
  | {
      readonly status: 'pending';
      readonly reason: string;
      readonly detail?: string;
    }
  | {
      readonly status: 'contradiction';
      readonly reason: string;
      readonly detail: string;
    }
  | VerifiedIssueRelaySolutionObservation
  | VerifiedIssueRelayVerdictObservation;

export interface IssueRelayMarketplaceCliOptions {
  readonly jinnBinary?: string;
  /**
   * Explicit host values allowed to reach the read/write marketplace CLI.
   * Unrelated ambient secrets are deliberately not inherited.
   */
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly run?: IssueRelayMarketplaceSubprocess;
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HEX_32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const TASK_ID_PATTERN = /^(0|[1-9][0-9]*)$/;
const TASK_CID_PATTERN = /^f01551220[0-9a-f]{64}$/;
const CANONICAL_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function exactKeys(
  record: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(record, key))
    && Object.keys(record).every((key) => allowed.has(key));
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_UTC_PATTERN.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requestDigest(bytes: Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function loadRelayRequest(
  requestPath: string,
  expectedDigest: string,
  now: Date,
) {
  if (!isAbsolute(requestPath)) {
    throw new Error('Relay marketplace request path must be absolute');
  }
  const request = verifyRelayMarketplaceRequest(requestPath, expectedDigest);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error('Relay marketplace CLI clock is invalid');
  }
  if (nowMs >= Date.parse(request.submitBy)) {
    throw new Error('Relay marketplace request has expired');
  }
  if (nowMs < Date.parse(request.createdAt)) {
    throw new Error('Relay marketplace request is not active before its creation time');
  }
  return { request, digest: expectedDigest };
}

const ALLOWED_ENVIRONMENT = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'BASE_RPC_URL',
  'BASE_SEPOLIA_RPC_URL',
  'JINN_CONFIG_HOME',
  'JINN_CONFIG_PATH',
  'JINN_PASSWORD',
  'JINN_WALLET_PASSWORD',
  'JINN_EARNING_DIR',
  'JINN_NETWORK',
  'JINN_RPC_URL',
  'JINN_ARCHIVE_RPC_URL',
  'JINN_DISCOVERY_MODE',
  'JINN_DISCOVERY_URL',
  'JINN_IPFS_GATEWAY_URL',
  'JINN_STATE_DIR',
  'JINN_DB_PATH',
]);

export function issueRelayMarketplaceEnvironment(
  explicit: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(explicit)) {
    if (
      value !== undefined
      && !isGitHubSecretEnvironmentKey(key)
      && key !== 'GH_CONFIG_DIR'
      && ALLOWED_ENVIRONMENT.has(key)
    ) {
      environment[key] = value;
    }
  }
  environment.NO_COLOR = '1';
  return environment;
}

function verifyPinnedPrivateFile(
  path: string,
  expectedDigest: string,
  label: string,
): void {
  if (!isAbsolute(path)) {
    throw new Error(`${label} path must be absolute`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) {
    throw new Error(`${label} expected digest is invalid`);
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file`);
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error(`${label} does not have mode 0600`);
  }
  if (requestDigest(readFileSync(path)) !== expectedDigest) {
    throw new Error(`${label} digest mismatch`);
  }
}

function protocolError(
  message: string,
  result: MarketplaceMachineSubprocessResult,
  cause?: unknown,
): MarketplaceMachineCliProtocolError {
  return new MarketplaceMachineCliProtocolError(message, result, cause);
}

function parseDryRun(
  result: MarketplaceMachineSubprocessResult,
): RelaySubmissionDryRun {
  const value = parseMarketplaceMachineJson(result.stdout);
  const record = object(value);
  if (
    record === undefined
    || !exactKeys(record, [
      'schemaVersion',
      'generatedAt',
      'dryRun',
      'verb',
      'description',
      'plan',
    ])
    || record.schemaVersion !== 1
    || !canonicalTimestamp(record.generatedAt)
    || record.dryRun !== true
    || record.verb !== 'tasks submit'
    || typeof record.description !== 'string'
    || record.description.length === 0
    || !Array.isArray(record.plan)
    || record.plan.length !== 1
  ) {
    throw new Error('Invalid jinn tasks submit dry-run result');
  }
  const plan = object(record.plan[0]);
  if (
    plan === undefined
    || !exactKeys(plan, [
      'id',
      'description',
      'creatorMultisig',
      'asset',
      'txCount',
      'solverNetManifestCid',
      'proposedSpendWei',
    ])
    || typeof plan.id !== 'string'
    || plan.id.length === 0
    || typeof plan.description !== 'string'
    || plan.description.length === 0
    || typeof plan.creatorMultisig !== 'string'
    || !ADDRESS_PATTERN.test(plan.creatorMultisig)
    || plan.asset !== 'native'
    || plan.txCount !== 1
    || typeof plan.solverNetManifestCid !== 'string'
    || plan.solverNetManifestCid.length === 0
    || typeof plan.proposedSpendWei !== 'string'
    || !/^(0|[1-9][0-9]*)$/.test(plan.proposedSpendWei)
  ) {
    throw new Error('Invalid jinn tasks submit dry-run plan');
  }
  return {
    id: plan.id,
    creatorSafe: plan.creatorMultisig,
    solverNetManifestCid: plan.solverNetManifestCid,
    proposedSpendWei: BigInt(plan.proposedSpendWei),
  };
}

interface ParsedSubmission extends RelaySubmissionEvidence {
  readonly creatorSafe: string;
}

function parseSubmission(
  result: MarketplaceMachineSubprocessResult,
): ParsedSubmission {
  const value = parseMarketplaceMachineJson(result.stdout);
  const record = object(value);
  if (
    record === undefined
    || !exactKeys(record, [
      'schemaVersion',
      'generatedAt',
      'verb',
      'id',
      'creatorMultisig',
      'taskId',
      'taskCid',
      'creationTx',
      'creationBlock',
      'solverNetManifestCid',
      'status',
      'idempotent',
    ], ['attemptId', 'attemptNumber'])
    || record.schemaVersion !== 1
    || !canonicalTimestamp(record.generatedAt)
    || record.verb !== 'tasks submit'
    || typeof record.id !== 'string'
    || record.id.length === 0
    || typeof record.creatorMultisig !== 'string'
    || !ADDRESS_PATTERN.test(record.creatorMultisig)
    || typeof record.taskId !== 'string'
    || !TASK_ID_PATTERN.test(record.taskId)
    || typeof record.taskCid !== 'string'
    || !TASK_CID_PATTERN.test(record.taskCid)
    || typeof record.creationTx !== 'string'
    || !HEX_32_PATTERN.test(record.creationTx)
    || !Number.isSafeInteger(record.creationBlock)
    || (record.creationBlock as number) < 0
    || typeof record.solverNetManifestCid !== 'string'
    || record.solverNetManifestCid.length === 0
    || typeof record.idempotent !== 'boolean'
    || record.status !== (
      record.idempotent ? 'already_submitted' : 'submitted'
    )
    || (
      record.attemptId !== undefined
      && (typeof record.attemptId !== 'string' || record.attemptId.length === 0)
    )
    || (
      record.attemptNumber !== undefined
      && (
        !Number.isSafeInteger(record.attemptNumber)
        || (record.attemptNumber as number) < 0
      )
    )
  ) {
    throw new Error('Invalid jinn tasks submit result');
  }
  return {
    id: record.id,
    creatorSafe: record.creatorMultisig,
    taskId: record.taskId,
    taskCid: record.taskCid,
    creationTx: record.creationTx,
    creationBlock: record.creationBlock as number,
    solverNetManifestCid: record.solverNetManifestCid,
    idempotent: record.idempotent,
  };
}

const nonEmpty = z.string().min(1);
const address = z.string().regex(ADDRESS_PATTERN);
const hex32 = z.string().regex(HEX_32_PATTERN);
const taskId = z.string().regex(TASK_ID_PATTERN);
const taskCid = z.string().regex(TASK_CID_PATTERN);
const nonNegativeInteger = z.number().int().safe().nonnegative();
const observationCommon = {
  status: z.literal('verified'),
  task: z.object({ taskId, taskCid }).strict(),
  attempt: z.object({
    attemptIndex: nonNegativeInteger,
    requestId: hex32,
    operator: address,
  }).strict(),
  delivery: z.object({
    envelopeCid: nonEmpty,
    transactionHash: hex32,
    blockNumber: nonNegativeInteger,
  }).strict(),
  round: IssueRelayRoundV1Schema,
};
const observationSchema = z.union([
  z.object({
    status: z.literal('pending'),
    reason: nonEmpty,
    detail: nonEmpty.optional(),
  }).strict(),
  z.object({
    status: z.literal('contradiction'),
    reason: nonEmpty,
    detail: nonEmpty,
  }).strict(),
  z.object({
    ...observationCommon,
    role: z.literal('solution'),
    payload: z.object({
      schemaVersion: z.literal('jinn-repo-solution.v1'),
      patch: nonEmpty,
    }).strict(),
  }).strict(),
  z.object({
    ...observationCommon,
    role: z.literal('verdict'),
    payload: IssueRelayVerdictV1Schema,
  }).strict(),
]);
const observationEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().refine(canonicalTimestamp),
  verb: z.literal('tasks observe-issue-relay-delivery'),
  observation: observationSchema,
}).strict();

function parseObservation(
  result: MarketplaceMachineSubprocessResult,
): IssueRelayDeliveryObservation {
  return parseIssueRelayDeliveryObservation(
    observationEnvelopeSchema.parse(
      parseMarketplaceMachineJson(result.stdout),
    ).observation,
  );
}

export function parseIssueRelayDeliveryObservation(
  input: unknown,
): IssueRelayDeliveryObservation {
  return observationSchema.parse(input) as IssueRelayDeliveryObservation;
}

function idFromArgv(argv: readonly string[]): string {
  const index = argv.indexOf('--id');
  const id = index === -1 ? undefined : argv[index + 1];
  if (id === undefined || id.length === 0) {
    throw new Error('Relay marketplace request does not contain a Task ID');
  }
  return id;
}

export class IssueRelayMarketplaceCli {
  private readonly jinnBinary: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly run: IssueRelayMarketplaceSubprocess;
  private readonly confirmations = new Map<
    string,
    {
      readonly requestDigest: string;
      readonly result: RelaySubmissionDryRun;
    }
  >();

  constructor(options: IssueRelayMarketplaceCliOptions = {}) {
    this.jinnBinary = options.jinnBinary ?? resolveInstalledJinnBinary();
    const explicitEnvironment = options.environment ?? {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
    };
    this.environment = issueRelayMarketplaceEnvironment(
      explicitEnvironment,
    );
    this.now = options.now ?? (() => new Date());
    this.run = options.run ?? runMarketplaceMachineSubprocess;
  }

  async dryRun(
    requestPath: string,
    requestDigestPin: string,
  ): Promise<RelaySubmissionDryRun> {
    const loaded = loadRelayRequest(requestPath, requestDigestPin, this.now());
    const { argv } = loaded.request;
    if (
      argv.length < 2
      || argv.at(-2) !== '--yes'
      || argv.at(-1) !== '--json'
    ) {
      throw new Error('Relay marketplace request has invalid submit argv');
    }
    const result = await this.run(this.jinnBinary, [
      ...argv.slice(0, -2),
      '--dry-run',
      '--yes',
      '--json',
    ], { environment: this.environment });
    verifyRelayMarketplaceRequest(requestPath, requestDigestPin);
    if (result.exitCode !== 0) {
      throwMarketplaceMachineFailure(result, 'jinn tasks submit --dry-run');
    }
    let parsed: RelaySubmissionDryRun;
    try {
      parsed = parseDryRun(result);
    } catch (error) {
      throw protocolError(
        'jinn tasks submit dry-run returned malformed successful output',
        result,
        error,
      );
    }
    if (parsed.id !== idFromArgv(argv)) {
      throw protocolError(
        'jinn tasks submit dry-run returned the wrong Relay Task ID',
        result,
      );
    }
    this.confirmations.set(requestPath, {
      requestDigest: loaded.digest,
      result: parsed,
    });
    return parsed;
  }

  async submit(
    requestPath: string,
    requestDigestPin: string,
  ): Promise<RelaySubmissionEvidence> {
    const loaded = loadRelayRequest(requestPath, requestDigestPin, this.now());
    const confirmation = this.confirmations.get(requestPath);
    if (
      confirmation === undefined
      || confirmation.requestDigest !== loaded.digest
    ) {
      throw new Error(
        'Relay submission requires a matching fresh dry-run spend confirmation',
      );
    }
    const result = await this.run(
      this.jinnBinary,
      loaded.request.argv,
      { environment: this.environment },
    );
    verifyRelayMarketplaceRequest(requestPath, requestDigestPin);
    if (result.exitCode !== 0) {
      throwMarketplaceMachineFailure(result, 'jinn tasks submit');
    }
    let parsed: ParsedSubmission;
    try {
      parsed = parseSubmission(result);
    } catch (error) {
      throw protocolError(
        'jinn tasks submit returned malformed successful output',
        result,
        error,
      );
    }
    if (parsed.id !== idFromArgv(loaded.request.argv)) {
      throw protocolError(
        'jinn tasks submit returned the wrong Relay Task ID',
        result,
      );
    }
    if (
      parsed.creatorSafe.toLowerCase()
        !== confirmation.result.creatorSafe.toLowerCase()
    ) {
      throw protocolError(
        'jinn tasks submit creator Safe differs from its dry-run pin',
        result,
      );
    }
    if (
      parsed.solverNetManifestCid
      !== confirmation.result.solverNetManifestCid
    ) {
      throw protocolError(
        'jinn tasks submit dry-run SolverNet pin changed',
        result,
      );
    }
    return {
      id: parsed.id,
      taskId: parsed.taskId,
      taskCid: parsed.taskCid,
      creationTx: parsed.creationTx,
      creationBlock: parsed.creationBlock,
      solverNetManifestCid: parsed.solverNetManifestCid,
      idempotent: parsed.idempotent,
    };
  }

  async observe(
    expectationPath: string,
    expectationDigest: string,
  ): Promise<IssueRelayDeliveryObservation> {
    verifyPinnedPrivateFile(
      expectationPath,
      expectationDigest,
      'Relay delivery expectation',
    );
    const result = await this.run(this.jinnBinary, [
      'tasks',
      'observe-issue-relay-delivery',
      '--expectation-file',
      expectationPath,
      '--json',
    ], { environment: this.environment });
    verifyPinnedPrivateFile(
      expectationPath,
      expectationDigest,
      'Relay delivery expectation',
    );
    if (result.exitCode === 0 || result.exitCode === 30 || result.exitCode === 50) {
      try {
        const observation = parseObservation(result);
        if (
          (result.exitCode === 0 && observation.status !== 'verified')
          || (result.exitCode === 30 && observation.status !== 'pending')
          || (result.exitCode === 50 && observation.status !== 'contradiction')
        ) {
          throw new Error('Observation status does not match process exit code');
        }
        return observation;
      } catch (error) {
        if (result.exitCode !== 0) {
          try {
            throwMarketplaceMachineFailure(
              result,
              'jinn tasks observe-issue-relay-delivery',
            );
          } catch (failure) {
            if (!(failure instanceof MarketplaceMachineCliProtocolError)) {
              throw failure;
            }
          }
        }
        throw protocolError(
          'jinn tasks observe-issue-relay-delivery returned malformed output',
          result,
          error,
        );
      }
    }
    throwMarketplaceMachineFailure(
      result,
      'jinn tasks observe-issue-relay-delivery',
    );
  }
}
