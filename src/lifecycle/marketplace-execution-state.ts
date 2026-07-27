import {
  AutopilotAdoptionReceiptSchema,
  AutopilotCorrelationSchema,
  TaskSubmitResultV1Schema,
  type AutopilotCorrelation,
  type AutopilotAdoptionReceipt,
  type TaskSubmitResultV1,
} from '@jinn-network/sdk/autopilot';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from 'node:path';
import { gitOid, type GitOid } from './types.js';

export const MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION =
  'marketplace-execution-v3' as const;
export const MARKETPLACE_EVALUATOR_LEG_SCHEMA_VERSION =
  'marketplace-evaluator-leg-v1' as const;

export type MarketplaceExecutionV3Status =
  | 'prepared'
  | 'submitted'
  | 'solution-observed'
  | 'solution-verified'
  | 'host-committed'
  | 'lifecycle-completed'
  | 'review-anchored'
  | 'receipt-published'
  | 'cancelled';

export interface MarketplaceSolutionDeliveryEvidence {
  readonly observationPath: string;
  readonly observationDigest: string;
  readonly taskId: string;
  readonly taskCid: string;
  readonly taskCreationTransaction: string;
  readonly taskCreationBlock: number;
  readonly solverNetManifestCid: string;
  readonly attemptIndex: number;
  readonly requestId: string;
  readonly deliveryEnvelopeCid: string;
  readonly deliveryEnvelopeDigest: string;
  readonly deliveryTransaction: string;
  readonly deliveryBlock: number;
  readonly solverSafe: string;
  readonly solverAgentEoa: string;
  readonly signer: string;
  readonly publisherAgentId: string;
  readonly correlation: AutopilotCorrelation;
  readonly observedAt: string;
}

export interface MarketplaceArtifactEvidence {
  readonly digest: string;
  readonly byteLength: number;
  readonly touchedPaths: readonly string[];
  readonly expectedTree: GitOid;
}

export interface MarketplaceVerificationEvidence {
  readonly profile: 'jinn-mono.v1';
  readonly artifactDigest: string;
  readonly expectedTree: GitOid;
  readonly planDigest: string;
  readonly commands: readonly {
    readonly label: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly cwdRelative: string;
    readonly status: 'passed';
    readonly exitCode: 0;
    readonly stdoutDigest: string;
    readonly stderrDigest: string;
    readonly startedAt: string;
    readonly completedAt: string;
  }[];
  readonly verifiedAt: string;
}

export interface MarketplaceHostCommitEvidence {
  readonly head: GitOid;
  readonly tree: GitOid;
  readonly parents: readonly GitOid[];
  readonly artifactDigest: string;
  readonly correlationDigest: string;
  readonly trailers: {
    readonly taskId: string;
    readonly requestId: string;
    readonly deliveryEnvelopeCid: string;
    readonly v2AttemptId: string;
    readonly artifactDigest: string;
    readonly childIssueNumber?: number;
  };
  readonly createdAt: string;
}

export type MarketplaceCompletionEvidence =
  | {
      readonly operation: 'implementation-complete';
      readonly prNumber: number;
      readonly branch: string;
      readonly claimOid: GitOid;
      readonly checkpointOid: GitOid;
      readonly resultingHead: GitOid;
      readonly lifecycleStatus: 'In Review';
      readonly confirmedAt: string;
    }
  | {
      readonly operation: 'child-complete';
      readonly childIssueNumber: number;
      readonly parentPrNumber: number;
      readonly parentBranch: string;
      readonly claimOid: GitOid;
      readonly checkpointOid: GitOid;
      readonly resultingHead: GitOid;
      readonly childClosed: true;
      readonly lifecycleStatus: 'In Review';
      readonly confirmedAt: string;
    };

export interface MarketplaceReviewAnchorEvidence {
  readonly attemptId: string;
  readonly manifestPath: string;
  readonly head: GitOid;
  readonly generation: string;
  readonly refOid: GitOid;
  readonly reviewer: string;
  readonly anchoredAt: string;
}

export interface MarketplaceReceiptEvidence {
  readonly receipt: AutopilotAdoptionReceipt;
  readonly commentId: number;
  readonly author: string;
  readonly recordedAt: string;
}

export interface MarketplaceEvaluatorLegIdentity {
  readonly originManifestPath: string;
  readonly originV2AttemptId: string;
  readonly originRequestDigest: string;
  readonly taskId: string;
  readonly taskCid: string;
  readonly taskCreationBlock: number;
  readonly prNumber: number;
  readonly expectedHead: GitOid;
  readonly generation: string;
  readonly reviewRefOid: GitOid;
  readonly reviewer: string;
}

export type MarketplaceEvaluatorLegExecutionState =
  | (MarketplaceEvaluatorLegIdentity & {
      readonly schemaVersion: typeof MARKETPLACE_EVALUATOR_LEG_SCHEMA_VERSION;
      readonly status: 'anchored';
      readonly anchoredAt: string;
    })
  | (MarketplaceEvaluatorLegIdentity & {
      readonly schemaVersion: typeof MARKETPLACE_EVALUATOR_LEG_SCHEMA_VERSION;
      readonly status: 'released';
      readonly anchoredAt: string;
      readonly releasedAt: string;
      readonly releaseReason: string;
    });

export type StrictMarketplaceAttemptExecutionState =
  | MarketplaceExecutionV3State
  | MarketplaceEvaluatorLegExecutionState;

interface MarketplaceExecutionV3Base {
  readonly schemaVersion: typeof MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION;
  readonly requestPath: string;
  readonly requestDigest: string;
  readonly solverNetSelectionPath: string;
  readonly preparedAt: string;
  readonly agentSoftDeadline: string;
  readonly adoptionDeadline: string;
}

type MarketplaceSubmittedV3 = MarketplaceExecutionV3Base & {
  readonly submission: TaskSubmitResultV1;
  readonly submittedAt: string;
};

export type MarketplaceAdoptionProgress =
  | {
      readonly status: 'solution-observed';
      readonly delivery: MarketplaceSolutionDeliveryEvidence;
    }
  | {
      readonly status: 'solution-verified';
      readonly delivery: MarketplaceSolutionDeliveryEvidence;
      readonly artifact: MarketplaceArtifactEvidence;
      readonly verification: MarketplaceVerificationEvidence;
    }
  | {
      readonly status: 'host-committed';
      readonly delivery: MarketplaceSolutionDeliveryEvidence;
      readonly artifact: MarketplaceArtifactEvidence;
      readonly verification: MarketplaceVerificationEvidence;
      readonly hostCommit: MarketplaceHostCommitEvidence;
    }
  | {
      readonly status: 'lifecycle-completed';
      readonly delivery: MarketplaceSolutionDeliveryEvidence;
      readonly artifact: MarketplaceArtifactEvidence;
      readonly verification: MarketplaceVerificationEvidence;
      readonly hostCommit: MarketplaceHostCommitEvidence;
      readonly completion: MarketplaceCompletionEvidence;
    }
  | {
      readonly status: 'review-anchored';
      readonly delivery: MarketplaceSolutionDeliveryEvidence;
      readonly artifact: MarketplaceArtifactEvidence;
      readonly verification: MarketplaceVerificationEvidence;
      readonly hostCommit: MarketplaceHostCommitEvidence;
      readonly completion: MarketplaceCompletionEvidence;
      readonly reviewAnchor: MarketplaceReviewAnchorEvidence;
    };

export type MarketplaceExecutionV3State =
  | (MarketplaceExecutionV3Base & { readonly status: 'prepared' })
  | (MarketplaceSubmittedV3 & { readonly status: 'submitted' })
  | (MarketplaceSubmittedV3 & MarketplaceAdoptionProgress)
  | (MarketplaceSubmittedV3 & {
      readonly status: 'receipt-published';
      readonly progress: MarketplaceAdoptionProgress;
      readonly receipt: MarketplaceReceiptEvidence;
    })
  | (MarketplaceExecutionV3Base & {
      readonly status: 'cancelled';
      readonly cancelledAt: string;
      readonly reason: string;
    });

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  name: string,
  optional: readonly string[] = [],
): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new Error(`Unknown ${name} field: ${unknown}`);
  const missing = keys.find((key) => !optional.includes(key) && !Object.hasOwn(value, key));
  if (missing !== undefined) throw new Error(`Missing ${name} field: ${missing}`);
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function timestamp(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(result)
    || !Number.isFinite(Date.parse(result))) {
    throw new Error(`Invalid ${name}`);
  }
  return result;
}

function digest(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^sha256:[0-9a-f]{64}$/.test(result)) throw new Error(`Invalid ${name}`);
  return result;
}

function hex32(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(result)) throw new Error(`Invalid ${name}`);
  return result;
}

function address(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(result)) throw new Error(`Invalid ${name}`);
  return result;
}

function taskId(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^(0|[1-9][0-9]*)$/.test(result)) throw new Error(`Invalid ${name}`);
  return result;
}

function positiveDecimal(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^[1-9][0-9]*$/.test(result)) throw new Error(`Invalid ${name}`);
  return result;
}

function uuid(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result)) {
    throw new Error(`Invalid ${name}`);
  }
  return result;
}

function safeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  const result = safeInteger(value, name);
  if (result === 0) throw new Error(`Invalid ${name}`);
  return result;
}

function absoluteAttemptPath(value: unknown, attemptDir: string, name: string): string {
  const path = text(value, name);
  if (!isAbsolute(path) || normalize(path) !== path) throw new Error(`Invalid ${name}`);
  const root = resolve(attemptDir);
  const child = resolve(path);
  const segment = relative(root, child);
  if (segment === '' || segment === '..' || segment.startsWith('../') || isAbsolute(segment)) {
    throw new Error(`${name} escaped its attempt`);
  }
  return child;
}

function absoluteManifestPath(value: unknown, name: string): string {
  const path = text(value, name);
  if (!isAbsolute(path) || normalize(path) !== path || basename(path) !== 'manifest.json') {
    throw new Error(`Invalid ${name}`);
  }
  return path;
}

function siblingManifestPath(
  value: unknown,
  attemptDir: string,
  phase: 'implement' | 'review',
  attemptId: string,
  name: string,
): string {
  const path = absoluteManifestPath(value, name);
  const linkedAttemptDir = dirname(path);
  const runnerDir = resolve(attemptDir, '..', '..');
  if (
    dirname(linkedAttemptDir) !== join(runnerDir, phase)
    || !basename(linkedAttemptDir).endsWith(`-${attemptId}`)
  ) {
    throw new Error(`Invalid ${name}`);
  }
  return path;
}

function base(value: Record<string, unknown>, attemptDir: string): MarketplaceExecutionV3Base {
  const preparedAt = timestamp(value.preparedAt, 'marketplace preparation timestamp');
  const agentSoftDeadline = timestamp(value.agentSoftDeadline, 'marketplace agent soft deadline');
  const adoptionDeadline = timestamp(value.adoptionDeadline, 'marketplace adoption deadline');
  if (Date.parse(preparedAt) > Date.parse(agentSoftDeadline)
    || Date.parse(agentSoftDeadline) > Date.parse(adoptionDeadline)) {
    throw new Error('Marketplace execution deadlines disagree');
  }
  return {
    schemaVersion: MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION,
    requestPath: absoluteAttemptPath(value.requestPath, attemptDir, 'marketplace request path'),
    requestDigest: digest(value.requestDigest, 'marketplace request digest'),
    solverNetSelectionPath: absoluteAttemptPath(
      value.solverNetSelectionPath,
      attemptDir,
      'marketplace SolverNet selection path',
    ),
    preparedAt,
    agentSoftDeadline,
    adoptionDeadline,
  };
}

function submission(value: unknown): TaskSubmitResultV1 {
  const parsed = TaskSubmitResultV1Schema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid marketplace task submission result');
  return parsed.data;
}

function delivery(value: unknown, attemptDir: string): MarketplaceSolutionDeliveryEvidence {
  const evidence = record(value, 'marketplace solution delivery');
  exactKeys(evidence, [
    'observationPath', 'observationDigest', 'taskId', 'taskCid',
    'taskCreationTransaction', 'taskCreationBlock', 'solverNetManifestCid',
    'attemptIndex', 'requestId', 'deliveryEnvelopeCid', 'deliveryEnvelopeDigest',
    'deliveryTransaction', 'deliveryBlock', 'solverSafe', 'solverAgentEoa', 'signer',
    'publisherAgentId', 'correlation', 'observedAt',
  ], 'marketplace solution delivery');
  const correlation = AutopilotCorrelationSchema.safeParse(evidence.correlation);
  if (!correlation.success) throw new Error('Invalid marketplace solution correlation');
  return {
    observationPath: absoluteAttemptPath(evidence.observationPath, attemptDir, 'marketplace observation path'),
    observationDigest: digest(evidence.observationDigest, 'marketplace observation digest'),
    taskId: taskId(evidence.taskId, 'marketplace delivery task ID'),
    taskCid: text(evidence.taskCid, 'marketplace delivery task CID'),
    taskCreationTransaction: hex32(
      evidence.taskCreationTransaction,
      'marketplace task creation transaction',
    ),
    taskCreationBlock: safeInteger(evidence.taskCreationBlock, 'marketplace task creation block'),
    solverNetManifestCid: text(evidence.solverNetManifestCid, 'marketplace SolverNet manifest CID'),
    attemptIndex: safeInteger(evidence.attemptIndex, 'marketplace delivery attempt index'),
    requestId: hex32(evidence.requestId, 'marketplace delivery request ID'),
    deliveryEnvelopeCid: text(evidence.deliveryEnvelopeCid, 'marketplace delivery envelope CID'),
    deliveryEnvelopeDigest: digest(evidence.deliveryEnvelopeDigest, 'marketplace delivery envelope digest'),
    deliveryTransaction: hex32(evidence.deliveryTransaction, 'marketplace delivery transaction'),
    deliveryBlock: safeInteger(evidence.deliveryBlock, 'marketplace delivery block'),
    solverSafe: address(evidence.solverSafe, 'marketplace solver Safe'),
    solverAgentEoa: address(evidence.solverAgentEoa, 'marketplace solver agent EOA'),
    signer: address(evidence.signer, 'marketplace delivery signer'),
    publisherAgentId: positiveDecimal(
      evidence.publisherAgentId,
      'marketplace publisher agent ID',
    ),
    correlation: correlation.data,
    observedAt: timestamp(evidence.observedAt, 'marketplace observation timestamp'),
  };
}

function oid(value: unknown, name: string): GitOid {
  return gitOid(text(value, name));
}

function relativePath(value: unknown, name: string, allowDot = false): string {
  const path = text(value, name);
  if (
    (!allowDot && path === '.')
    || path.includes('\\')
    || normalize(path) !== path
    || (
      path !== '.'
      && (
        isAbsolute(path)
        || path === '..'
        || path.startsWith('../')
        || path.includes('/../')
        || path === '.git'
        || path.startsWith('.git/')
      )
    )
  ) {
    throw new Error(`Invalid ${name}`);
  }
  return path;
}

function artifact(value: unknown): MarketplaceArtifactEvidence {
  const evidence = record(value, 'marketplace artifact evidence');
  exactKeys(evidence, ['digest', 'byteLength', 'touchedPaths', 'expectedTree'], 'marketplace artifact evidence');
  if (!Array.isArray(evidence.touchedPaths) || evidence.touchedPaths.length === 0) {
    throw new Error('Invalid marketplace artifact touched paths');
  }
  const touchedPaths = evidence.touchedPaths.map((path) => relativePath(path, 'marketplace artifact touched path'));
  if (new Set(touchedPaths).size !== touchedPaths.length || [...touchedPaths].sort().some((path, index) => path !== touchedPaths[index])) {
    throw new Error('Marketplace artifact touched paths are not canonical');
  }
  return {
    digest: digest(evidence.digest, 'marketplace artifact digest'),
    byteLength: safeInteger(evidence.byteLength, 'marketplace artifact byte length'),
    touchedPaths,
    expectedTree: oid(evidence.expectedTree, 'marketplace artifact expected tree'),
  };
}

function verification(
  value: unknown,
  expectedArtifact: MarketplaceArtifactEvidence,
): MarketplaceVerificationEvidence {
  const evidence = record(value, 'marketplace verification evidence');
  exactKeys(evidence, ['profile', 'artifactDigest', 'expectedTree', 'planDigest', 'commands', 'verifiedAt'], 'marketplace verification evidence');
  if (evidence.profile !== 'jinn-mono.v1' || evidence.artifactDigest !== expectedArtifact.digest
    || evidence.expectedTree !== expectedArtifact.expectedTree) {
    throw new Error('Marketplace verification contradicts artifact identity');
  }
  if (!Array.isArray(evidence.commands) || evidence.commands.length === 0) {
    throw new Error('Invalid marketplace verification commands');
  }
  const commands = evidence.commands.map((entry) => {
    const command = record(entry, 'marketplace verification command');
    exactKeys(command, ['label', 'command', 'args', 'cwdRelative', 'status', 'exitCode', 'stdoutDigest', 'stderrDigest', 'startedAt', 'completedAt'], 'marketplace verification command');
    if (!Array.isArray(command.args) || command.status !== 'passed' || command.exitCode !== 0) {
      throw new Error('Invalid marketplace verification command result');
    }
    const startedAt = timestamp(command.startedAt, 'marketplace verification command start');
    const completedAt = timestamp(command.completedAt, 'marketplace verification command completion');
    if (Date.parse(completedAt) < Date.parse(startedAt)) {
      throw new Error('Marketplace verification command completion predates start');
    }
    return {
      label: text(command.label, 'marketplace verification command label'),
      command: text(command.command, 'marketplace verification command'),
      args: command.args.map((argument) => text(argument, 'marketplace verification command argument')),
      cwdRelative: relativePath(
        command.cwdRelative,
        'marketplace verification command cwd',
        true,
      ),
      status: 'passed' as const,
      exitCode: 0 as const,
      stdoutDigest: digest(command.stdoutDigest, 'marketplace verification stdout digest'),
      stderrDigest: digest(command.stderrDigest, 'marketplace verification stderr digest'),
      startedAt,
      completedAt,
    };
  });
  const verifiedAt = timestamp(evidence.verifiedAt, 'marketplace verification timestamp');
  if (commands.some((command) => Date.parse(command.completedAt) > Date.parse(verifiedAt))) {
    throw new Error('Marketplace verification timestamp predates a command');
  }
  return {
    profile: 'jinn-mono.v1', artifactDigest: expectedArtifact.digest,
    expectedTree: expectedArtifact.expectedTree,
    planDigest: digest(evidence.planDigest, 'marketplace verification plan digest'),
    commands, verifiedAt,
  };
}

function hostCommit(
  value: unknown,
  expectedArtifact: MarketplaceArtifactEvidence,
  expectedDelivery: MarketplaceSolutionDeliveryEvidence,
): MarketplaceHostCommitEvidence {
  const evidence = record(value, 'marketplace host commit evidence');
  exactKeys(evidence, ['head', 'tree', 'parents', 'artifactDigest', 'correlationDigest', 'trailers', 'createdAt'], 'marketplace host commit evidence');
  if (
    !Array.isArray(evidence.parents)
    || evidence.artifactDigest !== expectedArtifact.digest
    || evidence.tree !== expectedArtifact.expectedTree
  ) {
    throw new Error('Marketplace host commit contradicts artifact identity');
  }
  const trailers = record(evidence.trailers, 'marketplace host commit trailers');
  exactKeys(trailers, ['taskId', 'requestId', 'deliveryEnvelopeCid', 'v2AttemptId', 'artifactDigest', 'childIssueNumber'], 'marketplace host commit trailers', ['childIssueNumber']);
  const childIssueNumber = trailers.childIssueNumber === undefined
    ? undefined
    : positiveInteger(
        trailers.childIssueNumber,
        'marketplace host commit child issue number',
      );
  if (trailers.taskId !== expectedDelivery.taskId || trailers.requestId !== expectedDelivery.requestId
    || trailers.deliveryEnvelopeCid !== expectedDelivery.deliveryEnvelopeCid
    || trailers.v2AttemptId !== expectedDelivery.correlation.v2AttemptId
    || trailers.artifactDigest !== expectedArtifact.digest) {
    throw new Error('Marketplace host commit contradicts delivery identity');
  }
  return {
    head: oid(evidence.head, 'marketplace host commit head'), tree: oid(evidence.tree, 'marketplace host commit tree'),
    parents: evidence.parents.map((parent) => oid(parent, 'marketplace host commit parent')),
    artifactDigest: expectedArtifact.digest,
    correlationDigest: digest(evidence.correlationDigest, 'marketplace host commit correlation digest'),
    trailers: {
      taskId: text(trailers.taskId, 'marketplace host commit task ID'),
      requestId: text(trailers.requestId, 'marketplace host commit request ID'),
      deliveryEnvelopeCid: text(trailers.deliveryEnvelopeCid, 'marketplace host commit envelope CID'),
      v2AttemptId: uuid(trailers.v2AttemptId, 'marketplace host commit attempt ID'),
      artifactDigest: digest(trailers.artifactDigest, 'marketplace host commit artifact digest'),
      ...(childIssueNumber === undefined ? {} : { childIssueNumber }),
    },
    createdAt: timestamp(evidence.createdAt, 'marketplace host commit timestamp'),
  };
}

function completion(value: unknown): MarketplaceCompletionEvidence {
  const evidence = record(value, 'marketplace completion evidence');
  if (evidence.operation === 'implementation-complete') {
    exactKeys(evidence, ['operation', 'prNumber', 'branch', 'claimOid', 'checkpointOid', 'resultingHead', 'lifecycleStatus', 'confirmedAt'], 'marketplace implementation completion evidence');
    if (evidence.lifecycleStatus !== 'In Review') throw new Error('Invalid marketplace lifecycle status');
    return { operation: 'implementation-complete', prNumber: positiveInteger(evidence.prNumber, 'marketplace completion PR number'), branch: text(evidence.branch, 'marketplace completion branch'), claimOid: oid(evidence.claimOid, 'marketplace completion claim OID'), checkpointOid: oid(evidence.checkpointOid, 'marketplace completion checkpoint OID'), resultingHead: oid(evidence.resultingHead, 'marketplace completion resulting head'), lifecycleStatus: 'In Review', confirmedAt: timestamp(evidence.confirmedAt, 'marketplace completion timestamp') };
  }
  if (evidence.operation === 'child-complete') {
    exactKeys(evidence, ['operation', 'childIssueNumber', 'parentPrNumber', 'parentBranch', 'claimOid', 'checkpointOid', 'resultingHead', 'childClosed', 'lifecycleStatus', 'confirmedAt'], 'marketplace child completion evidence');
    if (evidence.childClosed !== true || evidence.lifecycleStatus !== 'In Review') throw new Error('Invalid marketplace child completion evidence');
    return { operation: 'child-complete', childIssueNumber: positiveInteger(evidence.childIssueNumber, 'marketplace completion child issue number'), parentPrNumber: positiveInteger(evidence.parentPrNumber, 'marketplace completion parent PR number'), parentBranch: text(evidence.parentBranch, 'marketplace completion parent branch'), claimOid: oid(evidence.claimOid, 'marketplace completion claim OID'), checkpointOid: oid(evidence.checkpointOid, 'marketplace completion checkpoint OID'), resultingHead: oid(evidence.resultingHead, 'marketplace completion resulting head'), childClosed: true, lifecycleStatus: 'In Review', confirmedAt: timestamp(evidence.confirmedAt, 'marketplace completion timestamp') };
  }
  throw new Error('Invalid marketplace completion operation');
}

function reviewAnchor(value: unknown, attemptDir: string): MarketplaceReviewAnchorEvidence {
  const evidence = record(value, 'marketplace review anchor evidence');
  exactKeys(evidence, ['attemptId', 'manifestPath', 'head', 'generation', 'refOid', 'reviewer', 'anchoredAt'], 'marketplace review anchor evidence');
  const attemptId = uuid(evidence.attemptId, 'marketplace review anchor attempt ID');
  return { attemptId, manifestPath: siblingManifestPath(evidence.manifestPath, attemptDir, 'review', attemptId, 'marketplace review anchor manifest path'), head: oid(evidence.head, 'marketplace review anchor head'), generation: uuid(evidence.generation, 'marketplace review anchor generation'), refOid: oid(evidence.refOid, 'marketplace review anchor ref OID'), reviewer: text(evidence.reviewer, 'marketplace review anchor reviewer'), anchoredAt: timestamp(evidence.anchoredAt, 'marketplace review anchor timestamp') };
}

function receiptEvidence(
  value: unknown,
  progress: MarketplaceAdoptionProgress,
): MarketplaceReceiptEvidence {
  const evidence = record(value, 'marketplace receipt evidence');
  exactKeys(
    evidence,
    ['receipt', 'commentId', 'author', 'recordedAt'],
    'marketplace receipt evidence',
  );
  const parsed = AutopilotAdoptionReceiptSchema.safeParse(evidence.receipt);
  if (!parsed.success || parsed.data.role !== 'solution') {
    throw new Error('Invalid marketplace Solution adoption receipt');
  }
  const receipt = parsed.data;
  const delivery = progress.delivery;
  if (
    receipt.taskId !== delivery.taskId
    || receipt.attemptIndex !== delivery.attemptIndex
    || receipt.requestId !== delivery.requestId
    || receipt.deliveryEnvelopeCid !== delivery.deliveryEnvelopeCid
    || receipt.v2AttemptId !== delivery.correlation.v2AttemptId
    || receipt.claimOid !== delivery.correlation.claimOid
    || receipt.prNumber !== delivery.correlation.prNumber
    || receipt.expectedHead !== delivery.correlation.expectedHead
  ) {
    throw new Error('Marketplace receipt contradicts Solution delivery identity');
  }
  if (receipt.disposition === 'accepted') {
    if (
      progress.status !== 'review-anchored'
      || receipt.operation !== progress.completion.operation
      || receipt.resultingHead !== progress.completion.resultingHead
      || receipt.reviewGeneration !== progress.reviewAnchor.generation
      || receipt.reviewRefOid !== progress.reviewAnchor.refOid
    ) {
      throw new Error('Accepted marketplace receipt contradicts durable adoption');
    }
  } else {
    const resultingHead = progress.status === 'host-committed'
      || progress.status === 'lifecycle-completed'
      || progress.status === 'review-anchored'
      ? progress.hostCommit.head
      : undefined;
    if (
      (receipt.resultingHead !== undefined && receipt.resultingHead !== resultingHead)
      || (
        receipt.reviewGeneration !== undefined
        && (
          progress.status !== 'review-anchored'
          || receipt.reviewGeneration !== progress.reviewAnchor.generation
        )
      )
      || (
        receipt.reviewRefOid !== undefined
        && (
          progress.status !== 'review-anchored'
          || receipt.reviewRefOid !== progress.reviewAnchor.refOid
        )
      )
    ) {
      throw new Error('Rejected marketplace receipt contradicts durable adoption');
    }
  }
  const recordedAt = timestamp(
    evidence.recordedAt,
    'marketplace receipt evidence timestamp',
  );
  const progressTimestamp = latestProgressTimestamp(progress);
  if (
    Date.parse(receipt.recordedAt) < Date.parse(progressTimestamp)
    || Date.parse(recordedAt) < Date.parse(receipt.recordedAt)
    || Date.parse(recordedAt) < Date.parse(progressTimestamp)
  ) {
    throw new Error('Marketplace receipt evidence timestamp predates durable adoption');
  }
  return {
    receipt,
    commentId: positiveInteger(evidence.commentId, 'marketplace receipt comment ID'),
    author: text(evidence.author, 'marketplace receipt author'),
    recordedAt,
  };
}

function latestProgressTimestamp(progress: MarketplaceAdoptionProgress): string {
  switch (progress.status) {
    case 'solution-observed':
      return progress.delivery.observedAt;
    case 'solution-verified':
      return progress.verification.verifiedAt;
    case 'host-committed':
      return progress.hostCommit.createdAt;
    case 'lifecycle-completed':
      return progress.completion.confirmedAt;
    case 'review-anchored':
      return progress.reviewAnchor.anchoredAt;
  }
}

function adoptionProgress(
  state: MarketplaceSubmittedV3 & MarketplaceAdoptionProgress,
): MarketplaceAdoptionProgress {
  switch (state.status) {
    case 'solution-observed':
      return { status: state.status, delivery: state.delivery };
    case 'solution-verified':
      return {
        status: state.status,
        delivery: state.delivery,
        artifact: state.artifact,
        verification: state.verification,
      };
    case 'host-committed':
      return {
        status: state.status,
        delivery: state.delivery,
        artifact: state.artifact,
        verification: state.verification,
        hostCommit: state.hostCommit,
      };
    case 'lifecycle-completed':
      return {
        status: state.status,
        delivery: state.delivery,
        artifact: state.artifact,
        verification: state.verification,
        hostCommit: state.hostCommit,
        completion: state.completion,
      };
    case 'review-anchored':
      return {
        status: state.status,
        delivery: state.delivery,
        artifact: state.artifact,
        verification: state.verification,
        hostCommit: state.hostCommit,
        completion: state.completion,
        reviewAnchor: state.reviewAnchor,
      };
  }
}

function submittedFields(state: MarketplaceSubmittedV3): MarketplaceSubmittedV3 {
  return {
    schemaVersion: state.schemaVersion,
    requestPath: state.requestPath,
    requestDigest: state.requestDigest,
    solverNetSelectionPath: state.solverNetSelectionPath,
    preparedAt: state.preparedAt,
    agentSoftDeadline: state.agentSoftDeadline,
    adoptionDeadline: state.adoptionDeadline,
    submission: state.submission,
    submittedAt: state.submittedAt,
  };
}

export function decodeMarketplaceEvaluatorLegExecutionState(
  value: unknown,
  attemptDir: string,
): MarketplaceEvaluatorLegExecutionState {
  const state = record(value, 'marketplace evaluator leg state');
  if (state.schemaVersion !== MARKETPLACE_EVALUATOR_LEG_SCHEMA_VERSION
    || (state.status !== 'anchored' && state.status !== 'released')) {
    throw new Error('Invalid marketplace evaluator leg state');
  }
  exactKeys(state, state.status === 'anchored'
    ? ['schemaVersion', 'status', 'originManifestPath', 'originV2AttemptId',
      'originRequestDigest', 'taskId', 'taskCid', 'taskCreationBlock', 'prNumber',
      'expectedHead', 'generation', 'reviewRefOid', 'reviewer', 'anchoredAt']
    : ['schemaVersion', 'status', 'originManifestPath', 'originV2AttemptId',
      'originRequestDigest', 'taskId', 'taskCid', 'taskCreationBlock', 'prNumber',
      'expectedHead', 'generation', 'reviewRefOid', 'reviewer', 'anchoredAt',
      'releasedAt', 'releaseReason'], 'marketplace evaluator leg state');
  const originV2AttemptId = uuid(
    state.originV2AttemptId,
    'marketplace evaluator origin attempt ID',
  );
  const identity: MarketplaceEvaluatorLegIdentity = {
    originManifestPath: siblingManifestPath(
      state.originManifestPath,
      attemptDir,
      'implement',
      originV2AttemptId,
      'marketplace evaluator origin manifest path',
    ),
    originV2AttemptId,
    originRequestDigest: digest(state.originRequestDigest, 'marketplace evaluator origin request digest'),
    taskId: taskId(state.taskId, 'marketplace evaluator task ID'),
    taskCid: text(state.taskCid, 'marketplace evaluator task CID'),
    taskCreationBlock: safeInteger(state.taskCreationBlock, 'marketplace evaluator task creation block'),
    prNumber: positiveInteger(state.prNumber, 'marketplace evaluator PR number'),
    expectedHead: oid(state.expectedHead, 'marketplace evaluator expected head'),
    generation: uuid(state.generation, 'marketplace evaluator generation'),
    reviewRefOid: oid(state.reviewRefOid, 'marketplace evaluator review ref OID'),
    reviewer: text(state.reviewer, 'marketplace evaluator reviewer'),
  };
  const anchoredAt = timestamp(state.anchoredAt, 'marketplace evaluator anchored timestamp');
  if (state.status === 'anchored') {
    return { ...identity, schemaVersion: MARKETPLACE_EVALUATOR_LEG_SCHEMA_VERSION, status: 'anchored', anchoredAt };
  }
  const releasedAt = timestamp(state.releasedAt, 'marketplace evaluator release timestamp');
  if (Date.parse(releasedAt) < Date.parse(anchoredAt)) {
    throw new Error('Marketplace evaluator release timestamp predates anchor');
  }
  return { ...identity, schemaVersion: MARKETPLACE_EVALUATOR_LEG_SCHEMA_VERSION, status: 'released', anchoredAt, releasedAt, releaseReason: text(state.releaseReason, 'marketplace evaluator release reason') };
}

export function decodeMarketplaceExecutionV3State(
  value: unknown,
  attemptDir: string,
): MarketplaceExecutionV3State {
  const state = record(value, 'marketplace execution v3 state');
  if (state.schemaVersion !== MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION) {
    throw new Error('Unsupported marketplace execution v3 schema version');
  }
  if (state.status === 'prepared') {
    exactKeys(state, [
      'schemaVersion', 'status', 'requestPath', 'requestDigest', 'solverNetSelectionPath',
      'preparedAt', 'agentSoftDeadline', 'adoptionDeadline',
    ], 'prepared marketplace execution v3 state');
    return { ...base(state, attemptDir), status: 'prepared' };
  }
  if (state.status === 'cancelled') {
    exactKeys(state, [
      'schemaVersion', 'status', 'requestPath', 'requestDigest', 'solverNetSelectionPath',
      'preparedAt', 'agentSoftDeadline', 'adoptionDeadline', 'cancelledAt', 'reason',
    ], 'cancelled marketplace execution v3 state');
    const decodedBase = base(state, attemptDir);
    const cancelledAt = timestamp(state.cancelledAt, 'marketplace cancellation timestamp');
    if (Date.parse(cancelledAt) < Date.parse(decodedBase.preparedAt)) {
      throw new Error('Marketplace cancelled timestamp predates preparation timestamp');
    }
    return {
      ...decodedBase,
      status: 'cancelled',
      cancelledAt,
      reason: text(state.reason, 'marketplace cancellation reason'),
    };
  }
  if (state.status === 'receipt-published') {
    exactKeys(state, [
      'schemaVersion', 'status', 'requestPath', 'requestDigest', 'solverNetSelectionPath',
      'preparedAt', 'agentSoftDeadline', 'adoptionDeadline', 'submission', 'submittedAt',
      'progress', 'receipt',
    ], 'receipt-published marketplace execution v3 state');
    const progress = record(state.progress, 'marketplace adoption progress');
    const progressKeys = progress.status === 'solution-observed'
      ? ['status', 'delivery']
      : progress.status === 'solution-verified'
        ? ['status', 'delivery', 'artifact', 'verification']
        : progress.status === 'host-committed'
          ? ['status', 'delivery', 'artifact', 'verification', 'hostCommit']
          : progress.status === 'lifecycle-completed'
            ? ['status', 'delivery', 'artifact', 'verification', 'hostCommit', 'completion']
            : progress.status === 'review-anchored'
              ? [
                  'status', 'delivery', 'artifact', 'verification', 'hostCommit',
                  'completion', 'reviewAnchor',
                ]
              : undefined;
    if (progressKeys === undefined) throw new Error('Invalid marketplace adoption progress');
    exactKeys(progress, progressKeys, 'marketplace adoption progress');
    const decodedProgressState = decodeMarketplaceExecutionV3State({
      schemaVersion: state.schemaVersion,
      status: progress.status,
      requestPath: state.requestPath,
      requestDigest: state.requestDigest,
      solverNetSelectionPath: state.solverNetSelectionPath,
      preparedAt: state.preparedAt,
      agentSoftDeadline: state.agentSoftDeadline,
      adoptionDeadline: state.adoptionDeadline,
      submission: state.submission,
      submittedAt: state.submittedAt,
      ...progress,
    }, attemptDir);
    if (
      decodedProgressState.status === 'prepared'
      || decodedProgressState.status === 'submitted'
      || decodedProgressState.status === 'receipt-published'
      || decodedProgressState.status === 'cancelled'
    ) {
      throw new Error('Invalid marketplace adoption progress');
    }
    const decodedProgress = adoptionProgress(decodedProgressState);
    return {
      ...submittedFields(decodedProgressState),
      status: 'receipt-published',
      progress: decodedProgress,
      receipt: receiptEvidence(state.receipt, decodedProgress),
    };
  }
  const submittedStatuses = new Set<MarketplaceExecutionV3Status>([
    'submitted', 'solution-observed', 'solution-verified', 'host-committed',
    'lifecycle-completed', 'review-anchored',
  ]);
  if (typeof state.status === 'string' && submittedStatuses.has(state.status as MarketplaceExecutionV3Status)) {
    const common = ['schemaVersion', 'status', 'requestPath', 'requestDigest', 'solverNetSelectionPath',
      'preparedAt', 'agentSoftDeadline', 'adoptionDeadline', 'submission', 'submittedAt'];
    const status = state.status as MarketplaceExecutionV3Status;
    const keys = status === 'submitted' ? common : [...common, 'delivery'];
    if (status === 'solution-verified' || status === 'host-committed' || status === 'lifecycle-completed' || status === 'review-anchored') {
      keys.push('artifact', 'verification');
    }
    if (status === 'host-committed' || status === 'lifecycle-completed' || status === 'review-anchored') keys.push('hostCommit');
    if (status === 'lifecycle-completed' || status === 'review-anchored') keys.push('completion');
    if (status === 'review-anchored') keys.push('reviewAnchor');
    exactKeys(state, keys, `${status} marketplace execution v3 state`);
    const decodedBase = base(state, attemptDir);
    const submittedAt = timestamp(state.submittedAt, 'marketplace submitted timestamp');
    if (Date.parse(submittedAt) < Date.parse(decodedBase.preparedAt)) {
      throw new Error('Marketplace submitted timestamp predates preparation timestamp');
    }
    const decodedSubmission = submission(state.submission);
    if (status === 'submitted') {
      return { ...decodedBase, status: 'submitted', submission: decodedSubmission, submittedAt };
    }
    const decodedDelivery = delivery(state.delivery, attemptDir);
    if (decodedDelivery.taskId !== decodedSubmission.taskId
      || decodedDelivery.taskCid !== decodedSubmission.taskCid
      || decodedDelivery.taskCreationTransaction !== decodedSubmission.creationTx
      || decodedDelivery.taskCreationBlock !== decodedSubmission.creationBlock
      || decodedDelivery.solverNetManifestCid !== decodedSubmission.solverNetManifestCid
      || decodedSubmission.id !== `autopilot:${decodedDelivery.correlation.v2AttemptId}`
      || decodedDelivery.correlation.taskId !== decodedDelivery.taskId
      || decodedDelivery.correlation.requestId !== decodedDelivery.requestId
      || decodedDelivery.correlation.attemptIndex !== decodedDelivery.attemptIndex
      || decodedDelivery.correlation.deliveryEnvelopeCid !== decodedDelivery.deliveryEnvelopeCid
      || decodedDelivery.deliveryBlock < decodedDelivery.taskCreationBlock
      || decodedDelivery.signer.toLowerCase() !== decodedDelivery.solverAgentEoa.toLowerCase()) {
      throw new Error('Marketplace solution delivery contradicts submission identity');
    }
    if (Date.parse(decodedDelivery.observedAt) < Date.parse(submittedAt)) {
      throw new Error('Marketplace observation timestamp predates submission');
    }
    const observed = {
      ...decodedBase,
      status: 'solution-observed',
      submission: decodedSubmission,
      submittedAt,
      delivery: decodedDelivery,
    } as const;
    if (status === 'solution-observed') return observed;
    const decodedArtifact = artifact(state.artifact);
    const decodedVerification = verification(state.verification, decodedArtifact);
    if (Date.parse(decodedVerification.verifiedAt) < Date.parse(decodedDelivery.observedAt)) {
      throw new Error('Marketplace verification timestamp predates observation');
    }
    const verified = { ...observed, status: 'solution-verified' as const, artifact: decodedArtifact, verification: decodedVerification };
    if (status === 'solution-verified') return verified;
    const decodedHostCommit = hostCommit(state.hostCommit, decodedArtifact, decodedDelivery);
    if (Date.parse(decodedHostCommit.createdAt) < Date.parse(decodedVerification.verifiedAt)) {
      throw new Error('Marketplace host commit timestamp predates verification');
    }
    const committed = { ...verified, status: 'host-committed' as const, hostCommit: decodedHostCommit };
    if (status === 'host-committed') return committed;
    const decodedCompletion = completion(state.completion);
    const completionPrNumber = decodedCompletion.operation === 'implementation-complete'
      ? decodedCompletion.prNumber
      : decodedCompletion.parentPrNumber;
    const completionChildIssue = decodedCompletion.operation === 'child-complete'
      ? decodedCompletion.childIssueNumber
      : undefined;
    if (decodedCompletion.resultingHead !== decodedHostCommit.head
      || decodedCompletion.claimOid !== decodedDelivery.correlation.claimOid
      || completionPrNumber !== decodedDelivery.correlation.prNumber
      || completionChildIssue !== decodedHostCommit.trailers.childIssueNumber
      || Date.parse(decodedCompletion.confirmedAt) < Date.parse(decodedHostCommit.createdAt)) {
      throw new Error('Marketplace completion contradicts host commit');
    }
    const completed = { ...committed, status: 'lifecycle-completed' as const, completion: decodedCompletion };
    if (status === 'lifecycle-completed') return completed;
    const decodedReviewAnchor = reviewAnchor(state.reviewAnchor, attemptDir);
    if (decodedReviewAnchor.head !== decodedCompletion.resultingHead
      || Date.parse(decodedReviewAnchor.anchoredAt) < Date.parse(decodedCompletion.confirmedAt)) {
      throw new Error('Marketplace review anchor contradicts completion');
    }
    return { ...completed, status: 'review-anchored', reviewAnchor: decodedReviewAnchor };
  }
  throw new Error('Invalid marketplace execution v3 status');
}
