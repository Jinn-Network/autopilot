import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
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
  IssueRelayAdoptionReceiptV1Schema,
  IssueRelayEvaluationAnchorV1Schema,
  IssueRelayRoundV1Schema,
  IssueRelayRoundV2Schema,
  issueRelayCanonicalDigest,
  issueRelayPullRequestMetadataDigest,
  type IssueRelayEvaluationAnchorV1,
  type IssueRelayRoundV1,
  type IssueRelayRoundV2,
} from './contracts.js';
import type { AcceptedRelayAdoption } from './adoption.js';
import {
  relayAdoptionReceiptDigest,
  relayRequiredCheckStatus,
  verifyRelayCheckSummary,
  type RelayCheckSummary,
} from './checks.js';
import { relayTaskKey } from './identity.js';
import {
  isVerifiedIssueRelaySolutionV1,
  isVerifiedIssueRelaySolutionV2,
  isVerifiedIssueRelayEvaluationBundleV2,
  isVerifiedIssueRelayVerdictV1,
  parseIssueRelayDeliveryObservation,
  type IssueRelayDeliveryObservation,
  type RelaySubmissionEvidence,
} from './marketplace-cli.js';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const HEX_32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const TASK_ID_PATTERN = /^(0|[1-9][0-9]*)$/;
const TASK_CID_PATTERN = /^f01551220[0-9a-f]{64}$/;
const SAFE_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export interface IssueRelayDeliveryExpectation {
  readonly schemaVersion: 'jinn-issue-relay-delivery-expectation.v1';
  readonly role: 'solution' | 'verdict';
  readonly taskId: string;
  readonly taskCid: string;
  readonly creationBlockNumber: number;
  readonly round: IssueRelayRoundV1;
  readonly attemptIndex?: number;
  readonly requestId?: string;
  readonly deliveryEnvelopeCid?: string;
  readonly solutionOperatorSafe?: string;
}

export interface IssueRelayDeliveryExpectationV2
  extends Omit<IssueRelayDeliveryExpectation, 'round'> {
  readonly round: IssueRelayRoundV2;
}

export interface ImmutableRelayStateArtifact {
  readonly path: string;
  readonly digest: `sha256:${string}`;
  readonly reused: boolean;
}

function digest(bytes: Uint8Array): `sha256:${string}` {
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

function assertPrivateRegular(path: string, label: string): void {
  if (!isAbsolute(path)) {
    throw new Error(`${label} path must be absolute`);
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file`);
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error(`${label} does not have mode 0600`);
  }
}

function install(
  path: string,
  bytes: Buffer,
  label: string,
): ImmutableRelayStateArtifact {
  if (!isAbsolute(path)) {
    throw new Error(`${label} path must be absolute`);
  }
  const temporary = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`,
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
      linkSync(temporary, path);
      fsyncDirectory(dirname(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      assertPrivateRegular(path, `Existing ${label}`);
      if (!readFileSync(path).equals(bytes)) {
        throw new Error(`Existing ${label} conflicts with canonical bytes`);
      }
      reused = true;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) {
      rmSync(temporary);
      fsyncDirectory(dirname(path));
    }
  }
  assertPrivateRegular(path, label);
  if (!readFileSync(path).equals(bytes)) {
    throw new Error(`${label} verification failed after persistence`);
  }
  return { path, digest: digest(bytes), reused };
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error(`${label} contains malformed JSON`);
  }
}

function exactKeys(
  record: Readonly<Record<string, unknown>>,
  required: readonly string[],
): boolean {
  return Object.keys(record).length === required.length
    && required.every((key) => Object.hasOwn(record, key));
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validateSubmissionEvidence(input: unknown): RelaySubmissionEvidence {
  const record = object(input);
  if (
    record === undefined
    || !exactKeys(record, [
      'id',
      'taskId',
      'taskCid',
      'creationTx',
      'creationBlock',
      'solverNetManifestCid',
      'idempotent',
    ])
    || typeof record.id !== 'string'
    || record.id.length === 0
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
  ) {
    throw new Error('Relay submission evidence is invalid');
  }
  return record as unknown as RelaySubmissionEvidence;
}

export function persistRelaySubmissionEvidence(
  path: string,
  evidence: RelaySubmissionEvidence,
): ImmutableRelayStateArtifact {
  const valid = validateSubmissionEvidence(evidence);
  const bytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 'jinn-issue-relay-submission.v1',
    evidence: valid,
  }, null, 2)}\n`);
  return install(path, bytes, 'Relay submission evidence');
}

export function buildRelaySolutionExpectation(input: {
  readonly submission: RelaySubmissionEvidence;
  readonly round: IssueRelayRoundV1;
}): IssueRelayDeliveryExpectation {
  const submission = validateSubmissionEvidence(input.submission);
  const round = IssueRelayRoundV1Schema.parse(input.round) as IssueRelayRoundV1;
  if (submission.id !== relayTaskKey(round.generation, round.round)) {
    throw new Error('Relay submission Task key does not match the round pin');
  }
  return {
    schemaVersion: 'jinn-issue-relay-delivery-expectation.v1',
    role: 'solution',
    taskId: submission.taskId,
    taskCid: submission.taskCid,
    creationBlockNumber: submission.creationBlock,
    round,
  };
}

function validateSolutionExpectation(
  value: unknown,
): IssueRelayDeliveryExpectation {
  const record = object(value);
  if (
    record === undefined
    || !exactKeys(record, [
      'schemaVersion',
      'role',
      'taskId',
      'taskCid',
      'creationBlockNumber',
      'round',
    ])
    || record.schemaVersion
      !== 'jinn-issue-relay-delivery-expectation.v1'
    || record.role !== 'solution'
    || typeof record.taskId !== 'string'
    || !TASK_ID_PATTERN.test(record.taskId)
    || typeof record.taskCid !== 'string'
    || !TASK_CID_PATTERN.test(record.taskCid)
    || !Number.isSafeInteger(record.creationBlockNumber)
    || (record.creationBlockNumber as number) < 0
  ) {
    throw new Error('Relay solution expectation is invalid');
  }
  const round = IssueRelayRoundV1Schema.parse(record.round) as IssueRelayRoundV1;
  return {
    schemaVersion: 'jinn-issue-relay-delivery-expectation.v1',
    role: 'solution',
    taskId: record.taskId,
    taskCid: record.taskCid,
    creationBlockNumber: record.creationBlockNumber as number,
    round,
  };
}

export function persistRelaySolutionExpectation(
  path: string,
  expectation: IssueRelayDeliveryExpectation,
): ImmutableRelayStateArtifact {
  const valid = validateSolutionExpectation(expectation);
  const bytes = Buffer.from(`${JSON.stringify(valid, null, 2)}\n`);
  return install(path, bytes, 'Relay solution expectation');
}

export function verifyRelaySolutionExpectation(
  path: string,
  expectedDigest: string,
): IssueRelayDeliveryExpectation {
  if (!SHA256_PATTERN.test(expectedDigest)) {
    throw new Error('Relay solution expectation digest is invalid');
  }
  assertPrivateRegular(path, 'Relay solution expectation');
  const bytes = readFileSync(path);
  if (digest(bytes) !== expectedDigest) {
    throw new Error('Relay solution expectation digest mismatch');
  }
  const expectation = validateSolutionExpectation(
    parseJson(bytes, 'Relay solution expectation'),
  );
  const canonical = Buffer.from(`${JSON.stringify(expectation, null, 2)}\n`);
  if (!canonical.equals(bytes)) {
    throw new Error('Relay solution expectation bytes are not canonical');
  }
  return expectation;
}

function exactRound(
  expected: IssueRelayRoundV1,
  actual: IssueRelayRoundV1,
): boolean {
  return JSON.stringify(expected) === JSON.stringify(actual);
}

function validateVerifiedSolution(
  observation: IssueRelayDeliveryObservation,
  expectation: IssueRelayDeliveryExpectation,
): Extract<IssueRelayDeliveryObservation, { readonly status: 'verified' }> {
  if (!isVerifiedIssueRelaySolutionV1(observation)) {
    throw new Error('Relay observation must be a verified solution');
  }
  const valid = parseIssueRelayDeliveryObservation(observation);
  if (!isVerifiedIssueRelaySolutionV1(valid)) {
    throw new Error('Relay observation must be a verified solution');
  }
  if (
    valid.task.taskId !== expectation.taskId
    || valid.task.taskCid !== expectation.taskCid
    || !exactRound(expectation.round, valid.round)
  ) {
    throw new Error('Relay verified observation differs from expectation pins');
  }
  return valid;
}

export function installVerifiedRelayObservation(input: {
  readonly observationPath: string;
  readonly expectationPath: string;
  readonly expectationDigest: string;
  readonly observation: IssueRelayDeliveryObservation;
}): ImmutableRelayStateArtifact {
  const expectation = verifyRelaySolutionExpectation(
    input.expectationPath,
    input.expectationDigest,
  );
  const observation = validateVerifiedSolution(
    input.observation,
    expectation,
  );
  verifyRelaySolutionExpectation(
    input.expectationPath,
    input.expectationDigest,
  );
  const bytes = Buffer.from(`${JSON.stringify(observation, null, 2)}\n`);
  return install(input.observationPath, bytes, 'Relay verified observation');
}

export function readVerifiedRelayObservation(
  path: string,
  expectedDigest: string,
): Extract<IssueRelayDeliveryObservation, { readonly status: 'verified' }> {
  if (!SHA256_PATTERN.test(expectedDigest)) {
    throw new Error('Relay verified observation digest is invalid');
  }
  assertPrivateRegular(path, 'Relay verified observation');
  const bytes = readFileSync(path);
  if (digest(bytes) !== expectedDigest) {
    throw new Error('Relay verified observation digest mismatch');
  }
  const observation = parseIssueRelayDeliveryObservation(
    parseJson(bytes, 'Relay verified observation'),
  );
  if (observation.status !== 'verified') {
    throw new Error('Relay observation state is not verified');
  }
  const canonical = Buffer.from(`${JSON.stringify(observation, null, 2)}\n`);
  if (!canonical.equals(bytes)) {
    throw new Error('Relay verified observation bytes are not canonical');
  }
  return observation;
}

function validateVerdictExpectation(
  value: unknown,
): IssueRelayDeliveryExpectation {
  const record = object(value);
  if (
    record === undefined
    || !exactKeys(record, [
      'schemaVersion',
      'role',
      'taskId',
      'taskCid',
      'creationBlockNumber',
      'round',
      'attemptIndex',
      'requestId',
      'deliveryEnvelopeCid',
      'solutionOperatorSafe',
    ])
    || record.schemaVersion
      !== 'jinn-issue-relay-delivery-expectation.v1'
    || record.role !== 'verdict'
    || typeof record.taskId !== 'string'
    || !TASK_ID_PATTERN.test(record.taskId)
    || typeof record.taskCid !== 'string'
    || !TASK_CID_PATTERN.test(record.taskCid)
    || !Number.isSafeInteger(record.creationBlockNumber)
    || (record.creationBlockNumber as number) < 0
    || !Number.isSafeInteger(record.attemptIndex)
    || (record.attemptIndex as number) < 0
    || typeof record.requestId !== 'string'
    || !HEX_32_PATTERN.test(record.requestId)
    || typeof record.deliveryEnvelopeCid !== 'string'
    || !TASK_CID_PATTERN.test(record.deliveryEnvelopeCid)
    || typeof record.solutionOperatorSafe !== 'string'
    || !SAFE_ADDRESS_PATTERN.test(record.solutionOperatorSafe)
  ) {
    throw new Error('Relay verdict expectation is invalid');
  }
  const round = IssueRelayRoundV1Schema.parse(record.round) as IssueRelayRoundV1;
  return {
    schemaVersion: 'jinn-issue-relay-delivery-expectation.v1',
    role: 'verdict',
    taskId: record.taskId,
    taskCid: record.taskCid,
    creationBlockNumber: record.creationBlockNumber as number,
    round,
    attemptIndex: record.attemptIndex as number,
    requestId: record.requestId,
    deliveryEnvelopeCid: record.deliveryEnvelopeCid,
    solutionOperatorSafe: record.solutionOperatorSafe,
  };
}

function exactCorrelation(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function validateVerdictBindings(input: {
  readonly solutionExpectation: IssueRelayDeliveryExpectation;
  readonly adoption: AcceptedRelayAdoption;
  readonly evaluationAnchor: IssueRelayEvaluationAnchorV1;
  readonly checks: RelayCheckSummary;
}): {
  readonly solutionExpectation: IssueRelayDeliveryExpectation;
  readonly adoption: AcceptedRelayAdoption;
  readonly evaluationAnchor: IssueRelayEvaluationAnchorV1;
} {
  const solutionExpectation = validateSolutionExpectation(
    input.solutionExpectation,
  );
  const receipt = IssueRelayAdoptionReceiptV1Schema.parse(input.adoption.receipt);
  const evaluationAnchor = IssueRelayEvaluationAnchorV1Schema.parse(
    input.evaluationAnchor,
  ) as IssueRelayEvaluationAnchorV1;
  verifyRelayCheckSummary(input.checks);
  if (
    receipt.disposition !== 'accepted'
    || input.adoption.status !== 'accepted'
    || input.adoption.resultingHead !== receipt.resultingHead
    || input.adoption.prNumber !== receipt.prNumber
    || input.adoption.branch !== receipt.headRef
  ) {
    throw new Error('Relay verdict adoption binding is invalid');
  }
  const correlation = receipt.correlation;
  if (
    solutionExpectation.taskId !== correlation.taskId
    || solutionExpectation.round.generation !== correlation.generation
    || solutionExpectation.round.round !== correlation.round
    || solutionExpectation.round.snapshotDigest !== correlation.snapshotDigest
    || solutionExpectation.round.targetRepository !== receipt.targetRepository
    || solutionExpectation.round.workspaceRepository !== (
      solutionExpectation.round.purpose === 'repair'
        ? receipt.workspaceRepository
        : receipt.targetRepository
    )
    || (
      solutionExpectation.round.purpose === 'repair'
      && solutionExpectation.round.prNumber !== receipt.prNumber
    )
    || solutionExpectation.round.inputHead !== receipt.inputHead
    || receipt.solutionSafe.toLocaleLowerCase('en-US')
      !== input.adoption.receipt.solutionSafe.toLocaleLowerCase('en-US')
  ) {
    throw new Error('Relay verdict solution expectation does not match adoption');
  }
  if (
    !exactCorrelation(evaluationAnchor.correlation, correlation)
    || evaluationAnchor.targetRepository !== receipt.targetRepository
    || evaluationAnchor.workspaceRepository !== receipt.workspaceRepository
    || evaluationAnchor.prNumber !== receipt.prNumber
    || evaluationAnchor.headRef !== receipt.headRef
    || evaluationAnchor.evaluatedHead !== receipt.resultingHead
  ) {
    throw new Error('Relay verdict evaluation anchor does not match adoption');
  }
  if (
    evaluationAnchor.adoptionReceiptDigest
      !== relayAdoptionReceiptDigest(input.adoption)
  ) {
    throw new Error('Relay verdict evaluation anchor receipt digest is stale');
  }
  if (
    evaluationAnchor.checksDigest !== input.checks.digest
    || input.checks.head !== evaluationAnchor.evaluatedHead
    || relayRequiredCheckStatus(input.checks) !== 'passed'
  ) {
    throw new Error('Relay verdict evaluation anchor check digest is stale');
  }
  return { solutionExpectation, adoption: input.adoption, evaluationAnchor };
}

export function buildRelayVerdictExpectation(input: {
  readonly solutionExpectation: IssueRelayDeliveryExpectation;
  readonly adoption: AcceptedRelayAdoption;
  readonly evaluationAnchor: IssueRelayEvaluationAnchorV1;
  readonly checks: RelayCheckSummary;
}): IssueRelayDeliveryExpectation {
  const bindings = validateVerdictBindings(input);
  const correlation = bindings.adoption.receipt.correlation;
  return validateVerdictExpectation({
    ...bindings.solutionExpectation,
    role: 'verdict',
    attemptIndex: correlation.attemptIndex,
    requestId: correlation.requestId,
    deliveryEnvelopeCid: correlation.deliveryEnvelopeCid,
    solutionOperatorSafe: bindings.adoption.receipt.solutionSafe,
  });
}

export function persistRelayVerdictExpectation(
  path: string,
  expectation: IssueRelayDeliveryExpectation,
): ImmutableRelayStateArtifact {
  const valid = validateVerdictExpectation(expectation);
  const bytes = Buffer.from(`${JSON.stringify(valid, null, 2)}\n`);
  return install(path, bytes, 'Relay verdict expectation');
}

export function verifyRelayVerdictExpectation(
  path: string,
  expectedDigest: string,
): IssueRelayDeliveryExpectation {
  if (!SHA256_PATTERN.test(expectedDigest)) {
    throw new Error('Relay verdict expectation digest is invalid');
  }
  assertPrivateRegular(path, 'Relay verdict expectation');
  const bytes = readFileSync(path);
  if (digest(bytes) !== expectedDigest) {
    throw new Error('Relay verdict expectation digest mismatch');
  }
  const expectation = validateVerdictExpectation(
    parseJson(bytes, 'Relay verdict expectation'),
  );
  const canonical = Buffer.from(`${JSON.stringify(expectation, null, 2)}\n`);
  if (!canonical.equals(bytes)) {
    throw new Error('Relay verdict expectation bytes are not canonical');
  }
  return expectation;
}

function validateVerifiedVerdict(input: {
  readonly observation: IssueRelayDeliveryObservation;
  readonly expectation: IssueRelayDeliveryExpectation;
  readonly adoption: AcceptedRelayAdoption;
  readonly evaluationAnchor: IssueRelayEvaluationAnchorV1;
  readonly checks: RelayCheckSummary;
}): Extract<
IssueRelayDeliveryObservation,
{ readonly status: 'verified'; readonly role: 'verdict' }
> {
  validateVerdictBindings({
    solutionExpectation: {
      schemaVersion: input.expectation.schemaVersion,
      role: 'solution',
      taskId: input.expectation.taskId,
      taskCid: input.expectation.taskCid,
      creationBlockNumber: input.expectation.creationBlockNumber,
      round: input.expectation.round,
    },
    adoption: input.adoption,
    evaluationAnchor: input.evaluationAnchor,
    checks: input.checks,
  });
  const expectation = validateVerdictExpectation(input.expectation);
  const observation = parseIssueRelayDeliveryObservation(input.observation);
  if (!isVerifiedIssueRelayVerdictV1(observation)) {
    throw new Error('Relay observation must be a verified verdict');
  }
  if (
    observation.task.taskId !== expectation.taskId
    || observation.task.taskCid !== expectation.taskCid
    || !exactRound(observation.round, expectation.round)
    || observation.attempt.attemptIndex !== expectation.attemptIndex
    || observation.attempt.requestId !== expectation.requestId
    || observation.attempt.operator.toLocaleLowerCase('en-US')
      === expectation.solutionOperatorSafe?.toLocaleLowerCase('en-US')
    || !exactCorrelation(
      observation.payload.correlation,
      input.evaluationAnchor.correlation,
    )
    || observation.payload.evaluatedHead
      !== input.evaluationAnchor.evaluatedHead
  ) {
    throw new Error('Relay verified verdict differs from expectation pins');
  }
  return observation;
}

function installVerifiedRelayVerdictObservation(input: {
  readonly observationPath: string;
  readonly expectationPath: string;
  readonly expectationDigest: string;
  readonly observation: IssueRelayDeliveryObservation;
  readonly adoption: AcceptedRelayAdoption;
  readonly evaluationAnchor: IssueRelayEvaluationAnchorV1;
  readonly checks: RelayCheckSummary;
}): ImmutableRelayStateArtifact {
  const expectation = verifyRelayVerdictExpectation(
    input.expectationPath,
    input.expectationDigest,
  );
  const observation = validateVerifiedVerdict({
    observation: input.observation,
    expectation,
    adoption: input.adoption,
    evaluationAnchor: input.evaluationAnchor,
    checks: input.checks,
  });
  verifyRelayVerdictExpectation(
    input.expectationPath,
    input.expectationDigest,
  );
  const bytes = Buffer.from(`${JSON.stringify(observation, null, 2)}\n`);
  return install(input.observationPath, bytes, 'Relay verified verdict observation');
}

export function readVerifiedRelayVerdictObservation(
  path: string,
  expectedDigest: string,
): Extract<
IssueRelayDeliveryObservation,
{ readonly status: 'verified'; readonly role: 'verdict' }
> {
  const observation = readVerifiedRelayObservation(path, expectedDigest);
  if (observation.role !== 'verdict') {
    throw new Error('Relay verified observation is not a verdict');
  }
  return observation;
}

export async function observeAndInstallRelayVerdict(input: {
  readonly marketplace: {
    observe(
      expectationPath: string,
      expectationDigest: string,
    ): Promise<IssueRelayDeliveryObservation>;
  };
  readonly expectationPath: string;
  readonly observationPath: string;
  readonly solutionExpectation: IssueRelayDeliveryExpectation;
  readonly adoption: AcceptedRelayAdoption;
  readonly evaluationAnchor: IssueRelayEvaluationAnchorV1;
  readonly checks: RelayCheckSummary;
}): Promise<{
  readonly expectation: ImmutableRelayStateArtifact;
  readonly observation: ImmutableRelayStateArtifact;
}> {
  const expectation = buildRelayVerdictExpectation(input);
  const expectationArtifact = persistRelayVerdictExpectation(
    input.expectationPath,
    expectation,
  );
  const observation = await input.marketplace.observe(
    expectationArtifact.path,
    expectationArtifact.digest,
  );
  verifyRelayVerdictExpectation(
    expectationArtifact.path,
    expectationArtifact.digest,
  );
  const observationArtifact = installVerifiedRelayVerdictObservation({
    observationPath: input.observationPath,
    expectationPath: expectationArtifact.path,
    expectationDigest: expectationArtifact.digest,
    observation,
    adoption: input.adoption,
    evaluationAnchor: input.evaluationAnchor,
    checks: input.checks,
  });
  return {
    expectation: expectationArtifact,
    observation: observationArtifact,
  };
}

function validateV2Expectation(value: unknown): IssueRelayDeliveryExpectationV2 {
  const record = object(value);
  if (
    record === undefined
    || !exactKeys(record, record['role'] === 'solution'
      ? ['schemaVersion', 'role', 'taskId', 'taskCid', 'creationBlockNumber', 'round']
      : ['schemaVersion', 'role', 'taskId', 'taskCid', 'creationBlockNumber', 'round',
          'attemptIndex', 'requestId', 'deliveryEnvelopeCid', 'solutionOperatorSafe'])
    || record.schemaVersion !== 'jinn-issue-relay-delivery-expectation.v1'
    || (record.role !== 'solution' && record.role !== 'verdict')
    || typeof record.taskId !== 'string'
    || !TASK_ID_PATTERN.test(record.taskId)
    || typeof record.taskCid !== 'string'
    || !TASK_CID_PATTERN.test(record.taskCid)
    || !Number.isSafeInteger(record.creationBlockNumber)
    || (record.creationBlockNumber as number) < 0
  ) throw new Error('Relay V2 delivery expectation is invalid');
  const round = IssueRelayRoundV2Schema.parse(record.round) as IssueRelayRoundV2;
  if (
    record.role === 'verdict'
    && (
      !Number.isSafeInteger(record.attemptIndex)
      || (record.attemptIndex as number) < 0
      || typeof record.requestId !== 'string'
      || !HEX_32_PATTERN.test(record.requestId)
      || typeof record.deliveryEnvelopeCid !== 'string'
      || !TASK_CID_PATTERN.test(record.deliveryEnvelopeCid)
      || typeof record.solutionOperatorSafe !== 'string'
      || !SAFE_ADDRESS_PATTERN.test(record.solutionOperatorSafe)
    )
  ) throw new Error('Relay V2 evaluation expectation correlation is invalid');
  return {
    schemaVersion: 'jinn-issue-relay-delivery-expectation.v1',
    role: record.role,
    taskId: record.taskId,
    taskCid: record.taskCid,
    creationBlockNumber: record.creationBlockNumber as number,
    round,
    ...(record.role === 'solution' ? {} : {
      attemptIndex: record.attemptIndex as number,
      requestId: record.requestId as string,
      deliveryEnvelopeCid: record.deliveryEnvelopeCid as string,
      solutionOperatorSafe: record.solutionOperatorSafe as string,
    }),
  };
}

export function buildRelaySolutionExpectationV2(input: {
  readonly submission: RelaySubmissionEvidence;
  readonly round: IssueRelayRoundV2;
}): IssueRelayDeliveryExpectationV2 {
  const submission = validateSubmissionEvidence(input.submission);
  const round = IssueRelayRoundV2Schema.parse(input.round) as IssueRelayRoundV2;
  if (submission.id !== relayTaskKey(round.generation, round.round)) {
    throw new Error('Relay V2 submission Task key does not match its round');
  }
  return validateV2Expectation({
    schemaVersion: 'jinn-issue-relay-delivery-expectation.v1',
    role: 'solution',
    taskId: submission.taskId,
    taskCid: submission.taskCid,
    creationBlockNumber: submission.creationBlock,
    round,
  });
}

export function persistRelaySolutionExpectationV2(
  path: string,
  expectation: IssueRelayDeliveryExpectationV2,
): ImmutableRelayStateArtifact {
  const valid = validateV2Expectation(expectation);
  if (valid.role !== 'solution') {
    throw new Error('Relay V2 Solution expectation is required');
  }
  return install(
    path,
    Buffer.from(`${JSON.stringify(valid, null, 2)}\n`),
    'Relay V2 Solution expectation',
  );
}

export function verifyRelaySolutionExpectationV2(
  path: string,
  expectedDigest: string,
): IssueRelayDeliveryExpectationV2 {
  if (!SHA256_PATTERN.test(expectedDigest)) {
    throw new Error('Relay V2 Solution expectation digest is invalid');
  }
  assertPrivateRegular(path, 'Relay V2 Solution expectation');
  const bytes = readFileSync(path);
  if (digest(bytes) !== expectedDigest) {
    throw new Error('Relay V2 Solution expectation digest mismatch');
  }
  const expected = validateV2Expectation(
    parseJson(bytes, 'Relay V2 Solution expectation'),
  );
  if (expected.role !== 'solution') {
    throw new Error('Relay V2 Solution expectation has the wrong role');
  }
  if (!Buffer.from(`${JSON.stringify(expected, null, 2)}\n`).equals(bytes)) {
    throw new Error('Relay V2 Solution expectation bytes are not canonical');
  }
  return expected;
}

export function installVerifiedRelaySolutionObservationV2(input: {
  readonly observationPath: string;
  readonly expectationPath: string;
  readonly expectationDigest: string;
  readonly observation: IssueRelayDeliveryObservation;
}): ImmutableRelayStateArtifact {
  const expectation = verifyRelaySolutionExpectationV2(
    input.expectationPath,
    input.expectationDigest,
  );
  const observation = parseIssueRelayDeliveryObservation(input.observation);
  if (
    !isVerifiedIssueRelaySolutionV2(observation)
    || observation.task.taskId !== expectation.taskId
    || observation.task.taskCid !== expectation.taskCid
    || !isDeepStrictEqual(observation.round, expectation.round)
  ) {
    throw new Error('Relay V2 Solution differs from exact expectation pins');
  }
  verifyRelaySolutionExpectationV2(
    input.expectationPath,
    input.expectationDigest,
  );
  return install(
    input.observationPath,
    Buffer.from(`${JSON.stringify(observation, null, 2)}\n`),
    'Relay verified V2 Solution observation',
  );
}

export function buildRelayEvaluationBundleExpectationV2(input: {
  readonly solutionExpectation: IssueRelayDeliveryExpectationV2;
  readonly adoption: AcceptedRelayAdoption;
  readonly evaluationAnchor: IssueRelayEvaluationAnchorV1;
  readonly checks: RelayCheckSummary;
}): IssueRelayDeliveryExpectationV2 {
  const solution = validateV2Expectation(input.solutionExpectation);
  if (solution.role !== 'solution') throw new Error('Relay V2 Solution expectation is required');
  const receipt = IssueRelayAdoptionReceiptV1Schema.parse(input.adoption.receipt);
  const anchor = IssueRelayEvaluationAnchorV1Schema.parse(input.evaluationAnchor);
  verifyRelayCheckSummary(input.checks);
  if (
    receipt.disposition !== 'accepted'
    || solution.taskId !== receipt.correlation.taskId
    || solution.round.generation !== receipt.correlation.generation
    || solution.round.round !== receipt.correlation.round
    || solution.round.snapshotDigest !== receipt.correlation.snapshotDigest
    || solution.round.targetRepository !== receipt.targetRepository
    || solution.round.inputHead !== receipt.inputHead
    || (solution.round.purpose !== 'initial' && solution.round.workspaceRepository !== receipt.workspaceRepository)
    || (solution.round.purpose !== 'initial' && solution.round.prNumber !== receipt.prNumber)
    || !exactCorrelation(anchor.correlation, receipt.correlation)
    || anchor.evaluatedHead !== receipt.resultingHead
    || anchor.adoptionReceiptDigest !== relayAdoptionReceiptDigest(input.adoption)
    || anchor.checksDigest !== input.checks.digest
    || input.checks.head !== anchor.evaluatedHead
    || relayRequiredCheckStatus(input.checks) !== 'passed'
  ) throw new Error('Relay V2 evaluation expectation bindings are stale or contradictory');
  return validateV2Expectation({
    ...solution,
    role: 'verdict',
    attemptIndex: receipt.correlation.attemptIndex,
    requestId: receipt.correlation.requestId,
    deliveryEnvelopeCid: receipt.correlation.deliveryEnvelopeCid,
    solutionOperatorSafe: receipt.solutionSafe,
  });
}

export function persistRelayEvaluationBundleExpectationV2(
  path: string,
  expectation: IssueRelayDeliveryExpectationV2,
): ImmutableRelayStateArtifact {
  const valid = validateV2Expectation(expectation);
  return install(
    path,
    Buffer.from(`${JSON.stringify(valid, null, 2)}\n`),
    'Relay V2 evaluation-bundle expectation',
  );
}

export function verifyRelayEvaluationBundleExpectationV2(
  path: string,
  expectedDigest: string,
): IssueRelayDeliveryExpectationV2 {
  if (!SHA256_PATTERN.test(expectedDigest)) throw new Error('Relay V2 expectation digest is invalid');
  assertPrivateRegular(path, 'Relay V2 evaluation-bundle expectation');
  const bytes = readFileSync(path);
  if (digest(bytes) !== expectedDigest) throw new Error('Relay V2 expectation digest mismatch');
  const expected = validateV2Expectation(parseJson(bytes, 'Relay V2 expectation'));
  if (!Buffer.from(`${JSON.stringify(expected, null, 2)}\n`).equals(bytes)) {
    throw new Error('Relay V2 expectation bytes are not canonical');
  }
  return expected;
}

export function installVerifiedRelayEvaluationBundleV2(input: {
  readonly observationPath: string;
  readonly expectationPath: string;
  readonly expectationDigest: string;
  readonly observation: IssueRelayDeliveryObservation;
  readonly adoption: AcceptedRelayAdoption;
  readonly evaluationAnchor: IssueRelayEvaluationAnchorV1;
  readonly checks: RelayCheckSummary;
  readonly pullRequestMetadata: {
    readonly title: string;
    readonly body: string;
  };
  readonly laneSpecifications: {
    readonly security: `sha256:${string}`;
    readonly quality: `sha256:${string}`;
  };
}): ImmutableRelayStateArtifact {
  const expectation = verifyRelayEvaluationBundleExpectationV2(
    input.expectationPath,
    input.expectationDigest,
  );
  const observation = parseIssueRelayDeliveryObservation(input.observation);
  if (!isVerifiedIssueRelayEvaluationBundleV2(observation)) {
    throw new Error('Relay observation is not an authenticated V2 evaluation bundle');
  }
  const expected = buildRelayEvaluationBundleExpectationV2({
    solutionExpectation: {
      schemaVersion: expectation.schemaVersion,
      role: 'solution',
      taskId: expectation.taskId,
      taskCid: expectation.taskCid,
      creationBlockNumber: expectation.creationBlockNumber,
      round: expectation.round,
    },
    adoption: input.adoption,
    evaluationAnchor: input.evaluationAnchor,
    checks: input.checks,
  });
  if (
    !isDeepStrictEqual(expectation, expected)
    || observation.task.taskId !== expectation.taskId
    || observation.task.taskCid !== expectation.taskCid
    || !isDeepStrictEqual(observation.round, expectation.round)
    || observation.attempt.attemptIndex !== expectation.attemptIndex
    || observation.attempt.requestId !== expectation.requestId
    || observation.attempt.operator.toLowerCase()
      === expectation.solutionOperatorSafe?.toLowerCase()
    || !exactCorrelation(observation.payload.correlation, input.evaluationAnchor.correlation)
    || observation.payload.evaluatedHead !== input.evaluationAnchor.evaluatedHead
    || (['security', 'quality'] as const).some((lane) =>
      observation.payload.lanes[lane].pullRequestMetadataDigest
        !== issueRelayPullRequestMetadataDigest(input.pullRequestMetadata))
    || (['security', 'quality'] as const).some((lane) => {
      const laneResult = observation.payload.lanes[lane];
      return laneResult.schemaVersion === 'jinn-issue-relay-lane-attestation.v1'
        && (
          laneResult.evaluationAnchorDigest
            !== issueRelayCanonicalDigest(input.evaluationAnchor)
          || laneResult.adoptionReceiptDigest
            !== input.evaluationAnchor.adoptionReceiptDigest
          || laneResult.checksDigest !== input.checks.digest
          || laneResult.evaluationSpecificationDigest
            !== input.laneSpecifications[lane]
        );
    })
  ) throw new Error('Relay V2 evaluation bundle differs from exact expectation pins');
  verifyRelayEvaluationBundleExpectationV2(input.expectationPath, input.expectationDigest);
  return install(
    input.observationPath,
    Buffer.from(`${JSON.stringify(observation, null, 2)}\n`),
    'Relay verified V2 evaluation-bundle observation',
  );
}
