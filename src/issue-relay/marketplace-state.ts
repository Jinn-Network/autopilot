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
  type IssueRelayEvaluationAnchorV1,
  type IssueRelayRoundV1,
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
  if (
    observation.status !== 'verified'
    || observation.role !== 'solution'
    || observation.payload.schemaVersion !== 'jinn-repo-solution.v1'
  ) {
    throw new Error('Relay observation must be a verified solution');
  }
  const valid = parseIssueRelayDeliveryObservation(observation);
  if (valid.status !== 'verified' || valid.role !== 'solution') {
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
    || solutionExpectation.round.workspaceRepository !== receipt.workspaceRepository
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
  if (
    observation.status !== 'verified'
    || observation.role !== 'verdict'
    || observation.payload.schemaVersion !== 'jinn-issue-relay-verdict.v1'
  ) {
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
