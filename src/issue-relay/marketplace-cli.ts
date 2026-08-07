import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
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
  IssueRelayRoundV2Schema,
  IssueRelayEvaluationBundleV2Schema,
  IssueRelaySolutionV2Schema,
  IssueRelayVerdictV1Schema,
  type IssueRelayEvaluationBundleV2,
  type IssueRelayRoundV1,
  type IssueRelayRoundV2,
  type IssueRelayVerdictV1,
  type IssueRelaySolutionV2,
} from './contracts.js';
import {
  ISSUE_RELAY_MAX_ENVELOPE_CID_BYTES,
  ISSUE_RELAY_MAX_OBSERVATION_DETAIL_BYTES,
  ISSUE_RELAY_MAX_OBSERVATION_REASON_BYTES,
  ISSUE_RELAY_MAX_PATCH_BYTES,
  ISSUE_RELAY_MAX_TASK_ID_DECIMAL_DIGITS,
} from './limits.js';
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

export interface VerifiedIssueRelaySolutionObservationV2
  extends Omit<VerifiedIssueRelaySolutionObservation, 'round' | 'payload'> {
  readonly round: IssueRelayRoundV2;
  readonly payload: IssueRelaySolutionV2;
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

export interface VerifiedIssueRelayEvaluationBundleObservation {
  readonly status: 'verified';
  readonly role: 'verdict';
  readonly task: VerifiedIssueRelayVerdictObservation['task'];
  readonly attempt: VerifiedIssueRelayVerdictObservation['attempt'];
  readonly delivery: VerifiedIssueRelayVerdictObservation['delivery'];
  readonly round: IssueRelayRoundV2;
  readonly payload: IssueRelayEvaluationBundleV2;
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
  | VerifiedIssueRelaySolutionObservationV2
  | VerifiedIssueRelayVerdictObservation
  | VerifiedIssueRelayEvaluationBundleObservation;

export function isVerifiedIssueRelaySolutionV1(
  observation: IssueRelayDeliveryObservation,
): observation is VerifiedIssueRelaySolutionObservation {
  return observation.status === 'verified'
    && observation.role === 'solution'
    && observation.round.schemaVersion === 'jinn-issue-relay-round.v1';
}

export function isVerifiedIssueRelaySolutionV2(
  observation: IssueRelayDeliveryObservation,
): observation is VerifiedIssueRelaySolutionObservationV2 {
  return observation.status === 'verified'
    && observation.role === 'solution'
    && observation.round.schemaVersion === 'jinn-issue-relay-round.v2';
}

export function isVerifiedIssueRelayVerdictV1(
  observation: IssueRelayDeliveryObservation,
): observation is VerifiedIssueRelayVerdictObservation {
  return observation.status === 'verified'
    && observation.role === 'verdict'
    && observation.round.schemaVersion === 'jinn-issue-relay-round.v1'
    && observation.payload.schemaVersion === 'jinn-issue-relay-verdict.v1';
}

export function isVerifiedIssueRelayEvaluationBundleV2(
  observation: IssueRelayDeliveryObservation,
): observation is VerifiedIssueRelayEvaluationBundleObservation {
  return observation.status === 'verified'
    && observation.role === 'verdict'
    && observation.round.schemaVersion === 'jinn-issue-relay-round.v2'
    && observation.payload.schemaVersion === 'jinn-issue-relay-evaluation-bundle.v2';
}

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
const UINT256_MAX = (1n << 256n) - 1n;
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const RAW_SHA256_CID_PREFIX = [0x01, 0x55, 0x12, 0x20] as const;

function isCanonicalRawSha256Cid(value: string): boolean {
  if (/^f01551220[0-9a-f]{64}$/.test(value)) return true;
  if (value.length !== 59 || !value.startsWith('b')) return false;

  const bytes: number[] = [];
  let pending = 0;
  let pendingBits = 0;
  for (const character of value.slice(1)) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) return false;
    pending = (pending << 5) | index;
    pendingBits += 5;
    if (pendingBits >= 8) {
      pendingBits -= 8;
      bytes.push((pending >> pendingBits) & 0xff);
      pending &= (1 << pendingBits) - 1;
    }
  }

  return bytes.length === 36
    && pendingBits === 2
    && pending === 0
    && RAW_SHA256_CID_PREFIX.every((byte, index) => bytes[index] === byte);
}

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
): RelaySubmissionDryRun & { readonly spec: unknown } {
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
      'solverType',
      'spec',
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
    || plan.solverType !== 'jinn-repo.v1'
    || object(plan.spec) === undefined
  ) {
    throw new Error('Invalid jinn tasks submit dry-run plan');
  }
  return {
    id: plan.id,
    creatorSafe: plan.creatorMultisig,
    solverNetManifestCid: plan.solverNetManifestCid,
    proposedSpendWei: BigInt(plan.proposedSpendWei),
    spec: plan.spec,
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
const boundedText = (maxBytes: number, label: string) =>
  nonEmpty
    .refine((value) => !value.includes('\u0000'), `${label} must not contain NUL`)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= maxBytes,
      `${label} exceeds its UTF-8 byte limit`,
    );
const address = z.string().regex(ADDRESS_PATTERN);
const hex32 = z.string().regex(HEX_32_PATTERN);
const taskId = z.string()
  .regex(TASK_ID_PATTERN)
  .max(ISSUE_RELAY_MAX_TASK_ID_DECIMAL_DIGITS)
  .refine((value) => BigInt(value) <= UINT256_MAX, 'Task ID exceeds uint256');
const taskCid = z.string().regex(TASK_CID_PATTERN);
const envelopeCid = z.string()
  .max(ISSUE_RELAY_MAX_ENVELOPE_CID_BYTES)
  .refine(
    isCanonicalRawSha256Cid,
    'Envelope CID must be a canonical raw sha2-256 CIDv1',
  );
const observationReason = boundedText(
  ISSUE_RELAY_MAX_OBSERVATION_REASON_BYTES,
  'Issue Relay observation reason',
);
const observationDetail = boundedText(
  ISSUE_RELAY_MAX_OBSERVATION_DETAIL_BYTES,
  'Issue Relay observation detail',
);
const nonNegativeInteger = z.number().int().safe().nonnegative();
const relayRoundV1 = z.custom<IssueRelayRoundV1>(
  (value) => IssueRelayRoundV1Schema.safeParse(value).success,
  'Invalid Issue Relay V1 round',
);
const relayRoundV2 = z.custom<IssueRelayRoundV2>(
  (value) => IssueRelayRoundV2Schema.safeParse(value).success,
  'Invalid Issue Relay V2 round',
);
const relayVerdictV1 = z.custom<IssueRelayVerdictV1>(
  (value) => IssueRelayVerdictV1Schema.safeParse(value).success,
  'Invalid Issue Relay V1 verdict',
);
const relayEvaluationBundleV2 = z.custom<IssueRelayEvaluationBundleV2>(
  (value) => IssueRelayEvaluationBundleV2Schema.safeParse(value).success,
  'Invalid Issue Relay V2 evaluation bundle',
);
const solutionPayload = z.object({
  schemaVersion: z.literal('jinn-repo-solution.v1'),
  patch: nonEmpty.refine(
    (value) => new TextEncoder().encode(value).byteLength <= ISSUE_RELAY_MAX_PATCH_BYTES,
    'Issue Relay patch exceeds 2 MiB',
  ),
}).strict();
const solutionPayloadV2 = z.custom<IssueRelaySolutionV2>(
  (value) => IssueRelaySolutionV2Schema.safeParse(value).success,
  'Invalid Issue Relay V2 solution',
);
const observationCommon = {
  status: z.literal('verified'),
  task: z.object({ taskId, taskCid }).strict(),
  attempt: z.object({
    attemptIndex: nonNegativeInteger,
    requestId: hex32,
    operator: address,
  }).strict(),
  delivery: z.object({
    envelopeCid,
    transactionHash: hex32,
    blockNumber: nonNegativeInteger,
  }).strict(),
};
const observationSchema = z.union([
  z.object({
    status: z.literal('pending'),
    reason: observationReason,
    detail: observationDetail.optional(),
  }).strict(),
  z.object({
    status: z.literal('contradiction'),
    reason: observationReason,
    detail: observationDetail,
  }).strict(),
  z.object({
    ...observationCommon,
    role: z.literal('solution'),
    round: relayRoundV1,
    payload: solutionPayload,
  }).strict(),
  z.object({
    ...observationCommon,
    role: z.literal('solution'),
    round: relayRoundV2,
    payload: solutionPayloadV2,
  }).strict(),
  z.object({
    ...observationCommon,
    role: z.literal('verdict'),
    round: relayRoundV1,
    payload: relayVerdictV1,
  }).strict(),
  z.object({
    ...observationCommon,
    role: z.literal('verdict'),
    round: relayRoundV2,
    payload: relayEvaluationBundleV2,
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

function maximumSpendFromArgv(argv: readonly string[]): bigint {
  const index = argv.indexOf('--max-spend-wei');
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error('Relay marketplace request does not contain a maximum spend');
  }
  return BigInt(value);
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
    ], {
      environment: this.environment,
      outputProfile: 'issue-relay-dry-run',
    });
    verifyRelayMarketplaceRequest(requestPath, requestDigestPin);
    if (result.exitCode !== 0) {
      throwMarketplaceMachineFailure(result, 'jinn tasks submit --dry-run');
    }
    let parsed: RelaySubmissionDryRun & { readonly spec: unknown };
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
    const expectedSpec = JSON.parse(loaded.request.specBytes) as unknown;
    if (!isDeepStrictEqual(parsed.spec, expectedSpec)) {
      throw protocolError(
        'jinn tasks submit dry-run returned a different Relay Task spec',
        result,
      );
    }
    if (parsed.proposedSpendWei > maximumSpendFromArgv(argv)) {
      throw protocolError(
        'jinn tasks submit dry-run exceeded the persisted Relay spend maximum',
        result,
      );
    }
    const { spec: _spec, ...confirmation } = parsed;
    this.confirmations.set(requestPath, {
      requestDigest: loaded.digest,
      result: confirmation,
    });
    return confirmation;
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
      {
        environment: {
          ...this.environment,
          JINN_RELAY_EXPECTED_CREATOR_SAFE:
            confirmation.result.creatorSafe,
          JINN_RELAY_EXPECTED_SOLVERNET_MANIFEST_CID:
            confirmation.result.solverNetManifestCid,
          JINN_RELAY_EXPECTED_SPEND_WEI:
            confirmation.result.proposedSpendWei.toString(),
        },
      },
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
    ], {
      environment: this.environment,
      outputProfile: 'issue-relay-observation',
    });
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
