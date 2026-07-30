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
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  AutopilotDeliveryCommandResultV1Schema,
  AutopilotDeliveryExpectationSchema,
  type AutopilotDeliveryContradictionReason,
  type AutopilotDeliveryObservation,
  type AutopilotDeliveryPendingReason,
} from '@jinn-network/sdk/autopilot';
import {
  readAttemptManifest,
  type AttemptManifest,
} from './attempt-workspace.js';
import {
  marketplaceMachineEnvironment,
  parseMarketplaceMachineJson,
  resolveInstalledJinnBinary,
  runMarketplaceMachineSubprocess,
  throwMarketplaceMachineFailure,
  MarketplaceMachineCliProtocolError,
  type MarketplaceMachineSubprocess,
} from './marketplace-cli.js';
import { transitionMarketplaceAdoption } from './marketplace-adoption-state.js';
import type { MarketplaceSolutionDeliveryEvidence } from './marketplace-execution-state.js';
import { verifyMarketplaceTaskRequest } from './marketplace-task.js';

export interface MarketplaceDeliveryOptions {
  readonly jinnBinary?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly run?: MarketplaceMachineSubprocess;
  readonly now?: () => Date;
}

export type VerifiedSolutionObservation = Extract<
  AutopilotDeliveryObservation,
  { readonly status: 'verified'; readonly role: 'solution' }
>;

export type MarketplaceSolutionObservation =
  | { readonly status: 'pending'; readonly reason: AutopilotDeliveryPendingReason; readonly detail?: string }
  | { readonly status: 'contradiction'; readonly reason: AutopilotDeliveryContradictionReason; readonly detail: string }
  | { readonly status: 'verified'; readonly observation: VerifiedSolutionObservation; readonly observationPath: string; readonly observationDigest: string };

const EXPECTATION_FILE = 'marketplace-solution-expectation.json';
const OBSERVATION_FILE = 'marketplace-solution-observation.json';

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sdkDigest(value: string): string {
  if (!/^0x[0-9a-f]{64}$/i.test(value)) {
    throw new Error('Marketplace Solution observation has an invalid envelope digest');
  }
  return `sha256:${value.slice(2).toLowerCase()}`;
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function assertRegular0600(path: string, name: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${name} is not a regular file`);
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error(`${name} does not have mode 0600`);
  }
}

/** Replaces a non-authoritative request artifact atomically after fsync. */
function writeCanonical0600(path: string, bytes: Buffer): void {
  if (!isAbsolute(path)) throw new Error('Marketplace observation path must be absolute');
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    chmodSync(temporary, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    fsyncDirectory(dirname(path));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) rmSync(temporary);
  }
  assertRegular0600(path, 'Marketplace Solution expectation');
  if (!readFileSync(path).equals(bytes)) {
    throw new Error('Marketplace Solution expectation verification failed after persistence');
  }
}

/** Installs immutable evidence, accepting only byte-identical replay. */
function installCanonical0600(path: string, bytes: Buffer): { readonly path: string; readonly digest: string } {
  if (!isAbsolute(path)) throw new Error('Marketplace observation path must be absolute');
  const expectedDigest = digest(bytes);
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  let descriptor: number | undefined;
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
      assertRegular0600(path, 'Existing marketplace Solution observation');
      const installed = readFileSync(path);
      if (!installed.equals(bytes) || digest(installed) !== expectedDigest) {
        throw new Error('Existing marketplace Solution observation conflicts with canonical bytes');
      }
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) {
      rmSync(temporary);
      fsyncDirectory(dirname(path));
    }
  }
  assertRegular0600(path, 'Marketplace Solution observation');
  const installed = readFileSync(path);
  if (!installed.equals(bytes) || digest(installed) !== expectedDigest) {
    throw new Error('Marketplace Solution observation verification failed after persistence');
  }
  return { path, digest: expectedDigest };
}

function submittedManifest(manifest: AttemptManifest): {
  readonly requestDigest: string;
  readonly requestPath: string;
  readonly submission: import('@jinn-network/sdk/autopilot').TaskSubmitResultV1;
  readonly delivery?: MarketplaceSolutionDeliveryEvidence;
} {
  if (manifest.execution.backend !== 'marketplace') {
    throw new Error('Only marketplace attempts may observe Solution delivery');
  }
  const state = manifest.execution.state;
  if (state.schemaVersion !== 'marketplace-execution-v3') {
    throw new Error('Marketplace Solution observation requires marketplace execution v3');
  }
  if (state.status === 'submitted') {
    return state;
  }
  if (state.status === 'solution-observed') {
    return { ...state, delivery: state.delivery };
  }
  throw new Error('Marketplace Solution observation requires a submitted execution');
}

function expectationFor(
  manifest: AttemptManifest,
  state: ReturnType<typeof submittedManifest>,
) {
  const request = verifyMarketplaceTaskRequest(state.requestPath, state.requestDigest);
  const session = request.spec.session;
  if (
    request.id !== `autopilot:${manifest.attemptId}`
    || session.v2AttemptId !== manifest.attemptId
    || session.runnerId !== manifest.runnerId
    || session.issueNumber !== manifest.issueNumber
    || session.prNumber !== manifest.prNumber
    || session.branch !== manifest.branch
    || session.targetBase !== manifest.targetBase
    || session.claimOid !== manifest.claimOid
    || session.expectedHead !== manifest.expectedHead
  ) {
    throw new Error('Marketplace request contradicts attempt manifest');
  }
  const pinned = state.delivery === undefined ? {} : {
    attemptIndex: state.delivery.attemptIndex,
    requestId: state.delivery.requestId,
    deliveryEnvelopeCid: state.delivery.deliveryEnvelopeCid,
    deliveryTransactionHash: state.delivery.deliveryTransaction,
    deliveryBlockNumber: state.delivery.deliveryBlock,
    solutionOperator: state.delivery.solverSafe,
  };
  return {
    request,
    expectation: AutopilotDeliveryExpectationSchema.parse({
      schemaVersion: 'jinn-autopilot-delivery-observation-request.v1',
      role: 'solution',
      taskId: state.submission.taskId,
      taskCid: state.submission.taskCid,
      creationBlockNumber: state.submission.creationBlock,
      session,
      ...pinned,
    }),
  };
}

function verifiedEvidence(
  observation: VerifiedSolutionObservation,
  manifest: AttemptManifest,
  state: ReturnType<typeof submittedManifest>,
  request: ReturnType<typeof verifyMarketplaceTaskRequest>,
  observationPath: string,
  observationDigest: string,
  observedAt: string,
): MarketplaceSolutionDeliveryEvidence {
  if (
    observation.task.taskId !== state.submission.taskId
    || observation.task.taskCid !== state.submission.taskCid
    || observation.task.createdAtTx !== state.submission.creationTx
    || observation.task.createdAtBlock !== state.submission.creationBlock
    || !isDeepStrictEqual(observation.session, request.spec.session)
    || observation.session.v2AttemptId !== manifest.attemptId
    || observation.session.runnerId !== manifest.runnerId
    || observation.result.correlation.taskId !== observation.task.taskId
    || !isDeepStrictEqual(observation.result.correlation, observation.correlation)
    || observation.correlation.v2AttemptId !== manifest.attemptId
    || observation.correlation.claimOid !== manifest.claimOid
    || observation.correlation.prNumber !== manifest.prNumber
    || observation.correlation.expectedHead !== manifest.expectedHead
    || observation.correlation.attemptIndex !== observation.attempt.attemptIndex
    || observation.correlation.requestId !== observation.attempt.requestId
    || observation.correlation.deliveryEnvelopeCid !== observation.delivery.envelopeCid
    || observation.attempt.operator.toLowerCase() !== observation.envelope.participant.safeAddress.toLowerCase()
    || observation.envelope.cid !== observation.delivery.envelopeCid
    || observation.envelope.digest !== observation.delivery.envelopeDigest
    || observation.envelope.signer.toLowerCase() !== observation.envelope.participant.agentEoa.toLowerCase()
  ) {
    throw new Error('Marketplace Solution observation contradicts request or submission identity');
  }
  if (state.delivery !== undefined && (
    state.delivery.taskId !== observation.task.taskId
    || state.delivery.taskCid !== observation.task.taskCid
    || state.delivery.taskCreationTransaction !== observation.task.createdAtTx
    || state.delivery.taskCreationBlock !== observation.task.createdAtBlock
    || state.delivery.attemptIndex !== observation.attempt.attemptIndex
    || state.delivery.requestId !== observation.attempt.requestId
    || state.delivery.deliveryEnvelopeCid !== observation.delivery.envelopeCid
    || state.delivery.deliveryEnvelopeDigest !== sdkDigest(observation.delivery.envelopeDigest)
    || state.delivery.deliveryTransaction !== observation.delivery.transactionHash
    || state.delivery.deliveryBlock !== observation.delivery.blockNumber
    || state.delivery.solverSafe.toLowerCase() !== observation.envelope.participant.safeAddress.toLowerCase()
    || state.delivery.solverAgentEoa.toLowerCase() !== observation.envelope.participant.agentEoa.toLowerCase()
    || state.delivery.signer.toLowerCase() !== observation.envelope.signer.toLowerCase()
    || state.delivery.publisherAgentId !== observation.delivery.publisherAgentId
    || !isDeepStrictEqual(state.delivery.correlation, observation.correlation)
  )) {
    throw new Error('Marketplace Solution observation contradicts pinned delivery identity');
  }
  return {
    observationPath,
    observationDigest,
    taskId: observation.task.taskId,
    taskCid: observation.task.taskCid,
    taskCreationTransaction: observation.task.createdAtTx,
    taskCreationBlock: observation.task.createdAtBlock,
    solverNetManifestCid: state.submission.solverNetManifestCid,
    attemptIndex: observation.attempt.attemptIndex,
    requestId: observation.attempt.requestId,
    deliveryEnvelopeCid: observation.delivery.envelopeCid,
    deliveryEnvelopeDigest: sdkDigest(observation.delivery.envelopeDigest),
    deliveryTransaction: observation.delivery.transactionHash,
    deliveryBlock: observation.delivery.blockNumber,
    solverSafe: observation.envelope.participant.safeAddress,
    solverAgentEoa: observation.envelope.participant.agentEoa,
    signer: observation.envelope.signer,
    publisherAgentId: observation.delivery.publisherAgentId,
    correlation: observation.correlation,
    observedAt,
  };
}

export async function observeMarketplaceSolutionDelivery(
  manifestPath: string,
  options: MarketplaceDeliveryOptions = {},
): Promise<MarketplaceSolutionObservation> {
  const now = options.now ?? (() => new Date());
  const manifest = readAttemptManifest(manifestPath);
  const state = submittedManifest(manifest);
  const { request, expectation } = expectationFor(manifest, state);
  const expectationPath = join(manifest.paths.attemptDir, EXPECTATION_FILE);
  writeCanonical0600(expectationPath, canonicalBytes(expectation));

  const result = await (options.run ?? runMarketplaceMachineSubprocess)(
    options.jinnBinary ?? resolveInstalledJinnBinary(),
    ['tasks', 'observe-autopilot-delivery', '--expectation-file', expectationPath, '--json'],
    { environment: marketplaceMachineEnvironment(options.environment ?? process.env) },
  );
  if (result.exitCode !== 0) {
    throwMarketplaceMachineFailure(result, 'jinn tasks observe-autopilot-delivery');
  }
  let commandResult: import('@jinn-network/sdk/autopilot').AutopilotDeliveryCommandResultV1;
  try {
    commandResult = AutopilotDeliveryCommandResultV1Schema.parse(
      parseMarketplaceMachineJson(result.stdout),
    );
  } catch (error) {
    throw new MarketplaceMachineCliProtocolError(
      'jinn tasks observe-autopilot-delivery returned malformed successful output', result, error,
    );
  }
  const observed = commandResult.observation;
  if (observed.status === 'pending') return observed;
  if (observed.status === 'contradiction') return observed;
  if (observed.role !== 'solution') {
    throw new MarketplaceMachineCliProtocolError(
      'jinn tasks observe-autopilot-delivery returned a non-Solution observation', result,
    );
  }
  const observation = observed as VerifiedSolutionObservation;
  const observationPath = join(manifest.paths.attemptDir, OBSERVATION_FILE);
  const observationBytes = canonicalBytes(observation);
  const observationDigest = digest(observationBytes);
  const observedAt = state.delivery?.observedAt ?? now().toISOString();
  const evidence = verifiedEvidence(
    observation, manifest, state, request, observationPath, observationDigest, observedAt,
  );
  const installed = installCanonical0600(observationPath, observationBytes);
  transitionMarketplaceAdoption(
    manifestPath, state.requestDigest, { status: 'solution-observed', delivery: evidence }, now,
  );
  return {
    status: 'verified', observation, observationPath: installed.path, observationDigest: installed.digest,
  };
}
