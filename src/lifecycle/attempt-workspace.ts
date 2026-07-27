import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { hostname as systemHostname } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  TaskSubmitRequestV1Schema,
  TaskSubmitResultV1Schema,
  type TaskSubmitRequestV1,
  type TaskSubmitResultV1,
} from '@jinn-network/sdk/autopilot';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import { gitOid, gitRefName, isoTimestamp, type GitOid } from './types.js';
import {
  persistMarketplaceTaskRequest,
  verifyMarketplaceTaskRequest,
  type MarketplaceMutationWorkflow,
  type PersistedMarketplaceTaskRequest,
} from './marketplace-task.js';
import {
  gitPublicationArgs,
  isolatedGitCommandOverlay,
  sanitizedGitHubCommandOverlay,
  type SelectedCredential,
} from './credentials.js';
import {
  MARKETPLACE_EVALUATOR_LEG_SCHEMA_VERSION,
  MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION,
  decodeMarketplaceEvaluatorLegExecutionState,
  decodeMarketplaceExecutionV3State,
  type MarketplaceEvaluatorLegExecutionState,
  type MarketplaceExecutionV3State,
  type MarketplaceReviewAnchorEvidence,
} from './marketplace-execution-state.js';

export type AttemptPhase = 'implement' | 'review';
export type AttemptProcessState = 'preparing' | 'running' | 'exited';
export type ReviewApprovalPolicy = 'approve-eligible' | 'human-codeowner';
export const MARKETPLACE_EXECUTION_SCHEMA_VERSION = 'marketplace-execution-v1';
export const MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION = 'marketplace-execution-v2';

export interface MarketplacePreparedExecutionFields {
  readonly requestPath: string;
  readonly requestDigest: string;
  readonly solverNetSelectionPath: string;
  readonly preparedAt: string;
  readonly agentSoftDeadline: string;
  readonly adoptionDeadline: string;
}

export type MarketplaceExecutionState =
  | {
      readonly schemaVersion: typeof MARKETPLACE_EXECUTION_SCHEMA_VERSION;
      readonly status: 'unsubmitted';
      readonly requestPath: string;
    }
  | {
      readonly schemaVersion: typeof MARKETPLACE_EXECUTION_SCHEMA_VERSION;
      readonly status: 'submitted';
      readonly requestPath: string;
      readonly taskId: string;
      readonly taskCid: string;
      readonly submittedAt: string;
    }
  | ({
      readonly schemaVersion: typeof MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION;
      readonly status: 'prepared';
    } & MarketplacePreparedExecutionFields)
  | ({
      readonly schemaVersion: typeof MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION;
      readonly status: 'submitted';
      readonly submission: TaskSubmitResultV1;
      readonly submittedAt: string;
    } & MarketplacePreparedExecutionFields)
  | ({
      readonly schemaVersion: typeof MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION;
      readonly status: 'cancelled';
      readonly cancelledAt: string;
      readonly reason: string;
    } & MarketplacePreparedExecutionFields)
  | MarketplaceExecutionV3State
  | MarketplaceEvaluatorLegExecutionState;

export type AttemptExecution =
  | { readonly backend: 'local' }
  | { readonly backend: 'marketplace'; readonly state: MarketplaceExecutionState };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_COMPONENT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const BOOT_ID = randomUUID();

export interface AttemptPaths {
  readonly attemptDir: string;
  readonly worktree: string;
  readonly manifest: string;
  readonly log: string;
  readonly ghConfigDir: string;
  readonly askpass: string;
  /**
   * A 0o600 file holding the attempt's raw GH token, sibling to the manifest.
   * The runtime-independent handoff seam (#1883): env-based `GH_TOKEN` is
   * scrubbed by some coordinator runtimes (Hermes strips secret-shaped env
   * vars from spawned shell tools) before the coordinator session or its
   * `autopilot session` subcommands ever see it. This file survives any
   * runtime because it is read directly off disk, never through env.
   */
  readonly tokenFile: string;
}

export interface AttemptTimestamps {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly childStartedAt?: string;
  readonly childExitedAt?: string;
}

export interface AttemptRepositoryIdentity {
  readonly root: string;
  readonly gitCommonDir: string;
  readonly remoteName: string;
  readonly remoteUrlHash: string;
}

export interface AttemptManifest {
  readonly version: 2;
  readonly attemptId: string;
  readonly runnerId: string;
  readonly host: string;
  readonly phase: AttemptPhase;
  readonly execution: AttemptExecution;
  readonly subject: string;
  readonly issueNumber: number;
  readonly prNumber?: number;
  readonly branch: string;
  readonly targetBase: string;
  readonly targetBaseOid?: string;
  readonly expectedHead: string;
  readonly claimOid: string;
  readonly reviewGeneration?: string;
  readonly reviewRefOid?: string;
  readonly reviewApprovalPolicy?: ReviewApprovalPolicy;
  readonly selectedLogin: string;
  readonly repository: AttemptRepositoryIdentity;
  readonly processState: AttemptProcessState;
  readonly pid: number | null;
  readonly terminalHead?: string;
  readonly paths: AttemptPaths;
  readonly timestamps: AttemptTimestamps;
}

export interface CreateAttemptOptions {
  readonly repositoryPath: string;
  readonly worktreeBase: string;
  readonly runnerId?: string;
  readonly phase: AttemptPhase;
  readonly execution?: AttemptExecution;
  readonly subject: string;
  readonly issueNumber: number;
  readonly prNumber?: number;
  readonly branch: string;
  readonly targetBase: string;
  readonly targetBaseOid?: string;
  readonly marketplacePreparation?: MarketplaceAttemptPreparation;
  readonly expectedHead: string;
  readonly claimOid: string;
  readonly reviewGeneration?: string;
  readonly reviewRefOid?: string;
  readonly reviewApprovalPolicy?: ReviewApprovalPolicy;
  readonly selectedLogin: string;
  /**
   * The winning credential for this attempt. Written into the attempt-scoped
   * `gh-config/hosts.yml` and `gh-token` file at creation time (#1883) so the
   * coordinator session — and its `autopilot session` subcommands, which may
   * run under a different, credential-scrubbing runtime — can authenticate
   * without depending on any inherited environment variable.
   */
  readonly credential: SelectedCredential;
  readonly remoteName?: string;
  readonly pid?: number | null;
  readonly attemptId?: string;
  readonly host?: string;
  readonly now?: () => Date;
}

export interface MarketplaceAttemptPreparation {
  readonly workflow: MarketplaceMutationWorkflow;
  readonly baseSha: string;
  readonly request: TaskSubmitRequestV1;
  readonly agentSoftDeadline: string;
  readonly adoptionDeadline: string;
}

export interface CreateAttemptWorkspaceRuntime {
  readonly persistMarketplaceTaskRequest?: (
    requestPath: string,
    request: TaskSubmitRequestV1,
  ) => PersistedMarketplaceTaskRequest;
  readonly verifyMarketplaceTaskRequest?: typeof verifyMarketplaceTaskRequest;
  readonly writeManifest?: (path: string, manifest: AttemptManifest) => void;
  readonly afterMarketplaceJournalInstalled?: (journalPath: string) => void;
  readonly beforeMarketplaceManifestInstall?: () => void | Promise<void>;
  readonly afterMarketplaceManifestInstalled?: (
    manifestPath: string,
    manifest: AttemptManifest,
  ) => void | Promise<void>;
}

export type MarketplaceCredentialResolver = (
  normalizedLogin: string,
) => SelectedCredential | Promise<SelectedCredential>;

export interface RunnerIdOptions {
  readonly configured?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly hostname?: string;
  readonly pid?: number;
  readonly bootId?: string;
}

function safeComponent(value: string, name: string): string {
  if (!SAFE_COMPONENT_PATTERN.test(value) || value === '.' || value === '..') {
    throw new Error(`${name} must be filesystem-safe`);
  }
  return value;
}

function filesystemSafeHostname(value: string): string {
  const safe = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return safeComponent(safe, 'hostname');
}

function uuid(value: string, name: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}

export function defaultRunnerId(options: RunnerIdOptions = {}): string {
  const configured = options.configured
    ?? options.environment?.JINN_AUTOPILOT_RUNNER_ID
    ?? process.env.JINN_AUTOPILOT_RUNNER_ID;
  if (configured !== undefined && configured !== '') {
    return safeComponent(configured, 'configured runner ID');
  }
  const host = filesystemSafeHostname(options.hostname ?? systemHostname());
  const pid = options.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid runner PID');
  const bootId = uuid(options.bootId ?? BOOT_ID, 'runner boot UUID');
  return `${host}-${pid}-${bootId}`;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function nullablePid(value: unknown): number | null {
  if (value === null) return null;
  return positiveInteger(value, 'PID');
}

function exactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
  optional: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) throw new Error(`Unknown field: ${unknown}`);
  const missing = allowed.find((key) => !Object.hasOwn(record, key)
    && !optional.includes(key)
    && ![
      'prNumber',
      'reviewGeneration',
      'reviewRefOid',
      'reviewApprovalPolicy',
      'targetBaseOid',
      'terminalHead',
      'childStartedAt',
      'childExitedAt',
    ].includes(key));
  if (missing !== undefined) throw new Error(`Missing ${name} field: ${missing}`);
}

function decodeMarketplaceExecutionState(value: unknown, attemptDir: string): MarketplaceExecutionState {
  const state = record(value, 'marketplace execution state');
  if (state.schemaVersion === MARKETPLACE_EXECUTION_SCHEMA_VERSION && state.status === 'unsubmitted') {
    exactKeys(state, [
      'schemaVersion',
      'status',
      'requestPath',
    ], 'unsubmitted marketplace execution state');
    return {
      schemaVersion: MARKETPLACE_EXECUTION_SCHEMA_VERSION,
      status: 'unsubmitted',
      requestPath: absolutePath(state.requestPath, 'marketplace request path'),
    };
  }
  if (state.schemaVersion === MARKETPLACE_EXECUTION_SCHEMA_VERSION && state.status === 'submitted') {
    exactKeys(state, [
      'schemaVersion',
      'status',
      'requestPath',
      'taskId',
      'taskCid',
      'submittedAt',
    ], 'submitted marketplace execution state');
    return {
      schemaVersion: MARKETPLACE_EXECUTION_SCHEMA_VERSION,
      status: 'submitted',
      requestPath: absolutePath(state.requestPath, 'marketplace request path'),
      taskId: stringField(state.taskId, 'marketplace task ID'),
      taskCid: stringField(state.taskCid, 'marketplace task CID'),
      submittedAt: isoTimestamp(stringField(state.submittedAt, 'marketplace submitted timestamp')),
    };
  }
  if (state.schemaVersion === MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION) {
    return decodeMarketplaceExecutionV2State(state);
  }
  if (state.schemaVersion === MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION) {
    return decodeMarketplaceExecutionV3State(state, attemptDir);
  }
  if (state.schemaVersion === 'marketplace-evaluator-leg-v1') {
    return decodeMarketplaceEvaluatorLegExecutionState(state, attemptDir);
  }
  if (
    state.schemaVersion !== MARKETPLACE_EXECUTION_SCHEMA_VERSION
    && state.schemaVersion !== MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
  ) {
    throw new Error('Unsupported marketplace execution schema version');
  }
  throw new Error('Invalid marketplace execution status');
}

function marketplaceRequestDigest(value: unknown): string {
  const digest = stringField(value, 'marketplace request digest');
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error('Invalid marketplace request digest');
  }
  return digest;
}

function decodeMarketplacePreparedExecutionFields(
  state: Record<string, unknown>,
): MarketplacePreparedExecutionFields {
  const preparedAt = isoTimestamp(stringField(state.preparedAt, 'marketplace preparation timestamp'));
  const agentSoftDeadline = isoTimestamp(
    stringField(state.agentSoftDeadline, 'marketplace agent soft deadline'),
  );
  const adoptionDeadline = isoTimestamp(
    stringField(state.adoptionDeadline, 'marketplace adoption deadline'),
  );
  if (
    Date.parse(preparedAt) > Date.parse(agentSoftDeadline)
    || Date.parse(agentSoftDeadline) > Date.parse(adoptionDeadline)
  ) {
    throw new Error('Marketplace execution deadlines disagree');
  }
  return {
    requestPath: absolutePath(state.requestPath, 'marketplace request path'),
    requestDigest: marketplaceRequestDigest(state.requestDigest),
    solverNetSelectionPath: absolutePath(
      state.solverNetSelectionPath,
      'marketplace SolverNet selection path',
    ),
    preparedAt,
    agentSoftDeadline,
    adoptionDeadline,
  };
}

function decodeMarketplaceSubmission(value: unknown): TaskSubmitResultV1 {
  const parsed = TaskSubmitResultV1Schema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid marketplace task submission result');
  return parsed.data;
}

function decodeMarketplaceExecutionV2State(
  state: Record<string, unknown>,
): MarketplaceExecutionState {
  const fields = decodeMarketplacePreparedExecutionFields(state);
  if (state.status === 'prepared') {
    exactKeys(state, [
      'schemaVersion',
      'status',
      'requestPath',
      'requestDigest',
      'solverNetSelectionPath',
      'preparedAt',
      'agentSoftDeadline',
      'adoptionDeadline',
    ], 'prepared marketplace execution state');
    return {
      schemaVersion: MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION,
      status: 'prepared',
      ...fields,
    };
  }
  if (state.status === 'submitted') {
    exactKeys(state, [
      'schemaVersion',
      'status',
      'requestPath',
      'requestDigest',
      'solverNetSelectionPath',
      'preparedAt',
      'agentSoftDeadline',
      'adoptionDeadline',
      'submission',
      'submittedAt',
    ], 'submitted marketplace execution state');
    const submittedAt = isoTimestamp(
      stringField(state.submittedAt, 'marketplace submitted timestamp'),
    );
    if (Date.parse(submittedAt) < Date.parse(fields.preparedAt)) {
      throw new Error('Marketplace submitted timestamp predates preparation timestamp');
    }
    return {
      schemaVersion: MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION,
      status: 'submitted',
      ...fields,
      submission: decodeMarketplaceSubmission(state.submission),
      submittedAt,
    };
  }
  if (state.status === 'cancelled') {
    exactKeys(state, [
      'schemaVersion',
      'status',
      'requestPath',
      'requestDigest',
      'solverNetSelectionPath',
      'preparedAt',
      'agentSoftDeadline',
      'adoptionDeadline',
      'cancelledAt',
      'reason',
    ], 'cancelled marketplace execution state');
    const cancelledAt = isoTimestamp(
      stringField(state.cancelledAt, 'marketplace cancellation timestamp'),
    );
    if (Date.parse(cancelledAt) < Date.parse(fields.preparedAt)) {
      throw new Error('Marketplace cancelled timestamp predates preparation timestamp');
    }
    return {
      schemaVersion: MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION,
      status: 'cancelled',
      ...fields,
      cancelledAt,
      reason: stringField(state.reason, 'marketplace cancellation reason'),
    };
  }
  throw new Error('Invalid marketplace execution status');
}

function decodeAttemptExecution(value: unknown, attemptDir: string): AttemptExecution {
  const execution = record(value, 'attempt execution');
  if (execution.backend === 'local') {
    exactKeys(execution, ['backend'], 'local attempt execution');
    return { backend: 'local' };
  }
  if (execution.backend === 'marketplace') {
    exactKeys(execution, ['backend', 'state'], 'marketplace attempt execution');
    return {
      backend: 'marketplace',
      state: decodeMarketplaceExecutionState(execution.state, attemptDir),
    };
  }
  throw new Error('Invalid attempt execution backend');
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function absolutePath(value: unknown, name: string): string {
  const path = stringField(value, name);
  if (!isAbsolute(path)) throw new Error(`Invalid ${name}`);
  return path;
}

function decodePaths(value: unknown): AttemptPaths {
  const paths = record(value, 'attempt paths');
  exactKeys(paths, [
    'attemptDir',
    'worktree',
    'manifest',
    'log',
    'ghConfigDir',
    'askpass',
    'tokenFile',
  ], 'attempt paths');
  return {
    attemptDir: absolutePath(paths.attemptDir, 'attempt directory'),
    worktree: absolutePath(paths.worktree, 'worktree path'),
    manifest: absolutePath(paths.manifest, 'manifest path'),
    log: absolutePath(paths.log, 'log path'),
    ghConfigDir: absolutePath(paths.ghConfigDir, 'GH config path'),
    askpass: absolutePath(paths.askpass, 'askpass path'),
    tokenFile: absolutePath(paths.tokenFile, 'token file path'),
  };
}

function decodeTimestamps(value: unknown): AttemptTimestamps {
  const timestamps = record(value, 'attempt timestamps');
  exactKeys(timestamps, [
    'createdAt',
    'updatedAt',
    'childStartedAt',
    'childExitedAt',
  ], 'attempt timestamps');
  const createdAt = isoTimestamp(stringField(timestamps.createdAt, 'created timestamp'));
  const updatedAt = isoTimestamp(stringField(timestamps.updatedAt, 'updated timestamp'));
  const childStartedAt = timestamps.childStartedAt === undefined
    ? undefined
    : isoTimestamp(stringField(timestamps.childStartedAt, 'child-started timestamp'));
  const childExitedAt = timestamps.childExitedAt === undefined
    ? undefined
    : isoTimestamp(stringField(timestamps.childExitedAt, 'child-exited timestamp'));
  return {
    createdAt,
    updatedAt,
    ...(childStartedAt === undefined ? {} : { childStartedAt }),
    ...(childExitedAt === undefined ? {} : { childExitedAt }),
  };
}

function decodeRepositoryIdentity(value: unknown): AttemptRepositoryIdentity {
  const repository = record(value, 'attempt repository identity');
  exactKeys(repository, [
    'root',
    'gitCommonDir',
    'remoteName',
    'remoteUrlHash',
  ], 'attempt repository identity');
  const remoteUrlHash = stringField(repository.remoteUrlHash, 'remote URL hash');
  if (!/^[0-9a-f]{64}$/.test(remoteUrlHash)) {
    throw new Error('Invalid remote URL hash');
  }
  return {
    root: absolutePath(repository.root, 'canonical repository root'),
    gitCommonDir: absolutePath(repository.gitCommonDir, 'Git common directory'),
    remoteName: gitRefName(stringField(repository.remoteName, 'remote name')),
    remoteUrlHash,
  };
}

function processState(value: unknown): AttemptProcessState {
  if (value !== 'preparing' && value !== 'running' && value !== 'exited') {
    throw new Error('Invalid attempt process state');
  }
  return value;
}

function strictMarketplaceStateTimestamp(
  execution: AttemptExecution,
): string | undefined {
  if (execution.backend !== 'marketplace') return undefined;
  const state = execution.state;
  if (state.schemaVersion === MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION) {
    switch (state.status) {
      case 'prepared':
        return state.preparedAt;
      case 'submitted':
        return state.submittedAt;
      case 'solution-observed':
        return state.delivery.observedAt;
      case 'solution-verified':
        return state.verification.verifiedAt;
      case 'host-committed':
        return state.hostCommit.createdAt;
      case 'lifecycle-completed':
        return state.completion.confirmedAt;
      case 'review-anchored':
        return state.reviewAnchor.anchoredAt;
      case 'receipt-published':
        return state.receipt.recordedAt;
      case 'cancelled':
        return state.cancelledAt;
    }
  }
  if (state.schemaVersion === 'marketplace-evaluator-leg-v1') {
    return state.status === 'released' ? state.releasedAt : state.anchoredAt;
  }
  return undefined;
}

function requireMarketplaceManifestAuthority(
  execution: AttemptExecution,
  authority: {
    readonly attemptId: string;
    readonly phase: AttemptPhase;
    readonly prNumber?: number;
    readonly branch: string;
    readonly expectedHead: GitOid;
    readonly claimOid: GitOid;
    readonly reviewGeneration?: string;
    readonly reviewRefOid?: GitOid;
    readonly reviewApprovalPolicy?: ReviewApprovalPolicy;
    readonly selectedLogin: string;
  },
): void {
  if (execution.backend !== 'marketplace') return;
  const state = execution.state;
  if (state.schemaVersion === 'marketplace-evaluator-leg-v1') {
    if (
      authority.phase !== 'review'
      || authority.reviewApprovalPolicy !== 'approve-eligible'
      || state.prNumber !== authority.prNumber
      || state.expectedHead !== authority.expectedHead
      || state.generation !== authority.reviewGeneration
      || state.reviewRefOid !== authority.reviewRefOid
      || state.reviewer !== authority.selectedLogin
    ) {
      throw new Error('Marketplace evaluator contradicts review manifest authority');
    }
    return;
  }
  if (state.schemaVersion !== MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION) return;
  if ('submission' in state && state.submission.id !== `autopilot:${authority.attemptId}`) {
    throw new Error('Marketplace execution contradicts manifest authority');
  }
  const progress = state.status === 'receipt-published'
    ? state.progress
    : 'delivery' in state
      ? state
      : undefined;
  if (progress === undefined) return;
  if (
    progress.delivery.correlation.v2AttemptId !== authority.attemptId
    || progress.delivery.correlation.prNumber !== authority.prNumber
    || progress.delivery.correlation.claimOid !== authority.claimOid
    || progress.delivery.correlation.expectedHead !== authority.expectedHead
  ) {
    throw new Error('Marketplace execution contradicts manifest authority');
  }
  const completion = progress.status === 'lifecycle-completed'
    || progress.status === 'review-anchored'
    ? progress.completion
    : undefined;
  if (
    completion !== undefined
    && (
      completion.claimOid !== authority.claimOid
      || (
        completion.operation === 'implementation-complete'
          ? completion.prNumber !== authority.prNumber
            || completion.branch !== authority.branch
          : completion.parentPrNumber !== authority.prNumber
            || completion.parentBranch !== authority.branch
      )
    )
  ) {
    throw new Error('Marketplace execution contradicts manifest authority');
  }
}

export function decodeAttemptManifest(value: unknown): AttemptManifest {
  const manifest = record(value, 'attempt manifest');
  exactKeys(manifest, [
    'version',
    'attemptId',
    'runnerId',
    'host',
    'phase',
    'execution',
    'subject',
    'issueNumber',
    'prNumber',
    'branch',
    'targetBase',
    'targetBaseOid',
    'expectedHead',
    'claimOid',
    'reviewGeneration',
    'reviewRefOid',
    'reviewApprovalPolicy',
    'selectedLogin',
    'repository',
    'processState',
    'pid',
    'terminalHead',
    'paths',
    'timestamps',
  ], 'attempt manifest', ['execution']);
  if (manifest.version !== 2) throw new Error('Unsupported attempt manifest version');
  const phase = manifest.phase;
  if (phase !== 'implement' && phase !== 'review') {
    throw new Error('Invalid attempt phase');
  }
  const paths = decodePaths(manifest.paths);
  const execution = Object.hasOwn(manifest, 'execution')
    ? decodeAttemptExecution(manifest.execution, paths.attemptDir)
    : { backend: 'local' } as const;
  const attemptId = uuid(stringField(manifest.attemptId, 'attempt ID'), 'attempt ID');
  const runnerId = safeComponent(stringField(manifest.runnerId, 'runner ID'), 'runner ID');
  const host = filesystemSafeHostname(stringField(manifest.host, 'attempt host'));
  const subject = safeComponent(stringField(manifest.subject, 'attempt subject'), 'attempt subject');
  const issueNumber = positiveInteger(manifest.issueNumber, 'issue number');
  const prNumber = manifest.prNumber === undefined
    ? undefined
    : positiveInteger(manifest.prNumber, 'PR number');
  if (phase !== 'implement' && prNumber === undefined) {
    throw new Error(`${phase} attempt requires a PR number`);
  }
  const expectedSubject = phase === 'implement' ? `issue-${issueNumber}` : `pr-${prNumber}`;
  if (subject !== expectedSubject) throw new Error('Attempt subject does not match phase identity');
  const expectedHead = gitOid(stringField(manifest.expectedHead, 'expected head'));
  const branch = gitRefName(stringField(manifest.branch, 'branch'));
  const targetBase = gitRefName(stringField(manifest.targetBase, 'target base'));
  const targetBaseOid = manifest.targetBaseOid === undefined
    ? undefined
    : gitOid(stringField(manifest.targetBaseOid, 'target base OID'));
  if (
    targetBaseOid !== undefined
    && !(
      execution.backend === 'marketplace'
      && (execution.state.schemaVersion === MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
        || execution.state.schemaVersion === MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION)
    )
  ) {
    throw new Error('Target base OID is not valid for attempt manifests');
  }
  const claimOid = gitOid(stringField(manifest.claimOid, 'claim OID'));
  const selectedLogin = stringField(manifest.selectedLogin, 'selected login');
  const reviewGeneration = manifest.reviewGeneration === undefined
    ? undefined
    : uuid(stringField(manifest.reviewGeneration, 'review generation'), 'review generation');
  const reviewRefOid = manifest.reviewRefOid === undefined
    ? undefined
    : gitOid(stringField(manifest.reviewRefOid, 'review ref OID'));
  const reviewApprovalPolicy = manifest.reviewApprovalPolicy;
  if (
    reviewApprovalPolicy !== undefined
    && reviewApprovalPolicy !== 'approve-eligible'
    && reviewApprovalPolicy !== 'human-codeowner'
  ) {
    throw new Error('Invalid review approval policy');
  }
  if ((reviewGeneration === undefined) !== (reviewRefOid === undefined)) {
    throw new Error('Review generation and ref OID must appear together');
  }
  if (
    phase === 'review'
    && (
      reviewGeneration === undefined
      || reviewRefOid === undefined
      || reviewApprovalPolicy === undefined
    )
  ) {
    throw new Error('Review attempts require generation, ref OID, and approval policy');
  }
  if (
    phase !== 'review'
    && (reviewGeneration !== undefined || reviewApprovalPolicy !== undefined)
  ) {
    throw new Error('Review generation metadata is valid only for review attempts');
  }
  const decodedProcessState = processState(manifest.processState);
  const pid = nullablePid(manifest.pid);
  const terminalHead = manifest.terminalHead === undefined
    ? undefined
    : gitOid(stringField(manifest.terminalHead, 'terminal head'));
  const timestamps = decodeTimestamps(manifest.timestamps);
  if (
    (decodedProcessState === 'preparing'
      && (pid !== null
        || timestamps.childStartedAt !== undefined
        || timestamps.childExitedAt !== undefined))
    || (decodedProcessState === 'running'
      && (pid === null
        || timestamps.childStartedAt === undefined
        || timestamps.childExitedAt !== undefined))
    || (decodedProcessState === 'exited'
      && (pid === null
        || timestamps.childStartedAt === undefined
        || timestamps.childExitedAt === undefined))
  ) {
    throw new Error('Attempt process state, PID, and timestamps disagree');
  }
  if (decodedProcessState !== 'exited' && terminalHead !== undefined) {
    throw new Error('Terminal head is valid only for an exited attempt');
  }
  if (
    execution.backend === 'marketplace'
    && execution.state.schemaVersion === MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
    && execution.state.status === 'submitted'
    && Date.parse(execution.state.submittedAt) > Date.parse(timestamps.updatedAt)
  ) {
    throw new Error('Marketplace submitted timestamp postdates manifest updated timestamp');
  }
  if (
    execution.backend === 'marketplace'
    && execution.state.schemaVersion === MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
    && execution.state.status === 'cancelled'
    && Date.parse(execution.state.cancelledAt) > Date.parse(timestamps.updatedAt)
  ) {
    throw new Error('Marketplace cancelled timestamp postdates manifest updated timestamp');
  }
  const strictMarketplaceTimestamp = strictMarketplaceStateTimestamp(execution);
  if (
    strictMarketplaceTimestamp !== undefined
    && Date.parse(strictMarketplaceTimestamp) > Date.parse(timestamps.updatedAt)
  ) {
    throw new Error('Marketplace execution timestamp postdates manifest updated timestamp');
  }
  requireMarketplaceManifestAuthority(execution, {
    attemptId,
    phase,
    ...(prNumber === undefined ? {} : { prNumber }),
    branch,
    expectedHead,
    claimOid,
    ...(reviewGeneration === undefined
      ? {}
      : {
          reviewGeneration,
          reviewRefOid: reviewRefOid!,
          reviewApprovalPolicy: reviewApprovalPolicy!,
        }),
    selectedLogin,
  });
  return {
    version: 2,
    attemptId,
    runnerId,
    host,
    phase,
    execution,
    subject,
    issueNumber,
    ...(prNumber === undefined ? {} : { prNumber }),
    branch,
    targetBase,
    ...(targetBaseOid === undefined ? {} : { targetBaseOid }),
    expectedHead,
    claimOid,
    ...(reviewGeneration === undefined
      ? {}
      : {
          reviewGeneration,
          reviewRefOid: reviewRefOid!,
          reviewApprovalPolicy: reviewApprovalPolicy!,
        }),
    selectedLogin,
    repository: decodeRepositoryIdentity(manifest.repository),
    processState: decodedProcessState,
    pid,
    ...(terminalHead === undefined ? {} : { terminalHead }),
    paths,
    timestamps,
  };
}

export function readAttemptManifest(path: string): AttemptManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error('Malformed attempt manifest');
  }
  return decodeAttemptManifest(parsed);
}

function writeManifestAtomic(path: string, manifest: AttemptManifest): void {
  const valid = decodeAttemptManifest(manifest);
  const temporary = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(valid, null, 2)}\n`, 'utf8');
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
}

/** Dedicated internal boundary for strict marketplace state transitions. */
export function replaceMarketplaceExecutionState(
  path: string,
  expectedState: MarketplaceExecutionState,
  state: MarketplaceExecutionState,
  updatedAt: string,
): AttemptManifest {
  const lockPath = `${path}.marketplace-state-transition.lock`;
  let descriptor: number | undefined;
  let acquired = false;
  try {
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('Marketplace state transition already in progress');
      }
      throw error;
    }
    acquired = true;
    writeFileSync(
      descriptor,
      `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
      'utf8',
    );
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    fsyncDirectory(dirname(path));

    const current = readAttemptManifest(path);
    if (current.execution.backend !== 'marketplace') {
      throw new Error('Only marketplace attempts may replace marketplace execution state');
    }
    if (!isDeepStrictEqual(current.execution.state, expectedState)) {
      throw new Error('Marketplace execution state changed before replacement');
    }
    const next = decodeAttemptManifest({
      ...current,
      execution: { backend: 'marketplace', state },
      timestamps: {
        ...current.timestamps,
        updatedAt: Date.parse(current.timestamps.updatedAt) >= Date.parse(updatedAt)
          ? current.timestamps.updatedAt : updatedAt,
      },
    });
    if (!isDeepStrictEqual(current, next)) writeManifestAtomic(path, next);
    return next;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (acquired && existsSync(lockPath)) {
      rmSync(lockPath);
      fsyncDirectory(dirname(path));
    }
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function samePaths(left: AttemptPaths, right: AttemptPaths): boolean {
  return Object.keys(left).every((key) =>
    left[key as keyof AttemptPaths] === right[key as keyof AttemptPaths],
  );
}

function sameRepositoryIdentity(
  left: AttemptRepositoryIdentity,
  right: AttemptRepositoryIdentity,
): boolean {
  return left.root === right.root
    && left.gitCommonDir === right.gitCommonDir
    && left.remoteName === right.remoteName
    && left.remoteUrlHash === right.remoteUrlHash;
}

function requireDedicatedMarketplaceExecutionTransition(manifest: AttemptManifest): void {
  if (
    manifest.execution.backend === 'marketplace'
    && (manifest.execution.state.schemaVersion === MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
      || manifest.execution.state.schemaVersion === MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION
      || manifest.execution.state.schemaVersion === 'marketplace-evaluator-leg-v1')
  ) {
    throw new Error('Marketplace execution v2 must use dedicated marketplace transition APIs');
  }
}

export function updateAttemptManifest(
  path: string,
  update: (manifest: AttemptManifest) => AttemptManifest,
): AttemptManifest {
  const previous = readAttemptManifest(path);
  requireDedicatedMarketplaceExecutionTransition(previous);
  const progressiveManifestFields = new Set([
    'processState',
    'pid',
    'terminalHead',
    'timestamps',
  ]);
  const progressiveTimestampFields = new Set([
    'updatedAt',
    'childStartedAt',
    'childExitedAt',
  ]);
  const staticFields = (manifest: AttemptManifest): Record<string, unknown> => ({
    ...Object.fromEntries(
      Object.entries(manifest)
        .filter(([key]) => !progressiveManifestFields.has(key)),
    ),
    timestamps: Object.fromEntries(
      Object.entries(manifest.timestamps)
        .filter(([key]) => !progressiveTimestampFields.has(key)),
    ),
  });
  const previousStaticFields = structuredClone(staticFields(previous));
  const next = decodeAttemptManifest(update(previous));
  if (!isDeepStrictEqual(staticFields(next), previousStaticFields)) {
    throw new Error('Atomic manifest update cannot change static attempt fields');
  }
  writeManifestAtomic(path, next);
  return next;
}

export type MarketplaceExecutionTransition =
  | { readonly status: 'submitted'; readonly submission: TaskSubmitResultV1 }
  | { readonly status: 'cancelled'; readonly reason: string };

const MARKETPLACE_TERMINAL_EVIDENCE_SCHEMA_VERSION = 'marketplace-terminal-v1';
const MARKETPLACE_TERMINAL_EVIDENCE_SUFFIX = '.marketplace-terminal.json';
const MARKETPLACE_DISPATCH_DECISION_SCHEMA_VERSION = 'marketplace-dispatch-v1';
const MARKETPLACE_DISPATCH_DECISION_SUFFIX = '.marketplace-dispatch.json';

type MarketplaceTerminalEvidence =
  | {
      readonly schemaVersion: typeof MARKETPLACE_TERMINAL_EVIDENCE_SCHEMA_VERSION;
      readonly requestDigest: string;
      readonly status: 'submitted';
      readonly submission: TaskSubmitResultV1;
      readonly submittedAt: string;
    }
  | {
      readonly schemaVersion: typeof MARKETPLACE_TERMINAL_EVIDENCE_SCHEMA_VERSION;
      readonly requestDigest: string;
      readonly status: 'cancelled';
      readonly reason: string;
      readonly cancelledAt: string;
    };

export type MarketplaceDispatchDecision =
  | {
      readonly schemaVersion: typeof MARKETPLACE_DISPATCH_DECISION_SCHEMA_VERSION;
      readonly requestDigest: string;
      readonly decision: 'broadcast';
      readonly decidedAt: string;
    }
  | {
      readonly schemaVersion: typeof MARKETPLACE_DISPATCH_DECISION_SCHEMA_VERSION;
      readonly requestDigest: string;
      readonly decision: 'cancelled';
      readonly reason: string;
      readonly decidedAt: string;
    };

function marketplaceTerminalEvidencePath(manifestPath: string): string {
  return `${manifestPath}${MARKETPLACE_TERMINAL_EVIDENCE_SUFFIX}`;
}

function marketplaceDispatchDecisionPath(manifestPath: string): string {
  return `${manifestPath}${MARKETPLACE_DISPATCH_DECISION_SUFFIX}`;
}

function decodeMarketplaceTerminalEvidence(value: unknown): MarketplaceTerminalEvidence {
  const evidence = record(value, 'marketplace terminal evidence');
  if (evidence.schemaVersion !== MARKETPLACE_TERMINAL_EVIDENCE_SCHEMA_VERSION) {
    throw new Error('Invalid marketplace terminal evidence schema version');
  }
  if (evidence.status === 'submitted') {
    exactKeys(evidence, [
      'schemaVersion',
      'requestDigest',
      'status',
      'submission',
      'submittedAt',
    ], 'submitted marketplace terminal evidence');
    return {
      schemaVersion: MARKETPLACE_TERMINAL_EVIDENCE_SCHEMA_VERSION,
      requestDigest: marketplaceRequestDigest(evidence.requestDigest),
      status: 'submitted',
      submission: decodeMarketplaceSubmission(evidence.submission),
      submittedAt: isoTimestamp(
        stringField(evidence.submittedAt, 'marketplace terminal submitted timestamp'),
      ),
    };
  }
  if (evidence.status === 'cancelled') {
    exactKeys(evidence, [
      'schemaVersion',
      'requestDigest',
      'status',
      'reason',
      'cancelledAt',
    ], 'cancelled marketplace terminal evidence');
    return {
      schemaVersion: MARKETPLACE_TERMINAL_EVIDENCE_SCHEMA_VERSION,
      requestDigest: marketplaceRequestDigest(evidence.requestDigest),
      status: 'cancelled',
      reason: stringField(evidence.reason, 'marketplace terminal cancellation reason'),
      cancelledAt: isoTimestamp(
        stringField(evidence.cancelledAt, 'marketplace terminal cancellation timestamp'),
      ),
    };
  }
  throw new Error('Invalid marketplace terminal evidence status');
}

function readMarketplaceTerminalEvidence(path: string): MarketplaceTerminalEvidence | undefined {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Invalid marketplace terminal evidence', { cause: error });
  }
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || (metadata.mode & 0o777) !== 0o600
  ) {
    throw new Error('Invalid marketplace terminal evidence');
  }
  try {
    return decodeMarketplaceTerminalEvidence(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  } catch (error) {
    throw new Error('Invalid marketplace terminal evidence', { cause: error });
  }
}

function decodeMarketplaceDispatchDecision(value: unknown): MarketplaceDispatchDecision {
  const decision = record(value, 'marketplace dispatch decision');
  if (decision.schemaVersion !== MARKETPLACE_DISPATCH_DECISION_SCHEMA_VERSION) {
    throw new Error('Invalid marketplace dispatch decision schema version');
  }
  if (decision.decision === 'broadcast') {
    exactKeys(decision, [
      'schemaVersion',
      'requestDigest',
      'decision',
      'decidedAt',
    ], 'broadcast marketplace dispatch decision');
    return {
      schemaVersion: MARKETPLACE_DISPATCH_DECISION_SCHEMA_VERSION,
      requestDigest: marketplaceRequestDigest(decision.requestDigest),
      decision: 'broadcast',
      decidedAt: isoTimestamp(
        stringField(decision.decidedAt, 'marketplace dispatch decision timestamp'),
      ),
    };
  }
  if (decision.decision === 'cancelled') {
    exactKeys(decision, [
      'schemaVersion',
      'requestDigest',
      'decision',
      'reason',
      'decidedAt',
    ], 'cancelled marketplace dispatch decision');
    return {
      schemaVersion: MARKETPLACE_DISPATCH_DECISION_SCHEMA_VERSION,
      requestDigest: marketplaceRequestDigest(decision.requestDigest),
      decision: 'cancelled',
      reason: stringField(decision.reason, 'marketplace dispatch cancellation reason'),
      decidedAt: isoTimestamp(
        stringField(decision.decidedAt, 'marketplace dispatch decision timestamp'),
      ),
    };
  }
  throw new Error('Invalid marketplace dispatch decision');
}

function readMarketplaceDispatchDecision(path: string): MarketplaceDispatchDecision | undefined {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Invalid marketplace dispatch decision', { cause: error });
  }
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || (metadata.mode & 0o777) !== 0o600
  ) {
    throw new Error('Invalid marketplace dispatch decision');
  }
  try {
    return decodeMarketplaceDispatchDecision(
      JSON.parse(readFileSync(path, 'utf8')) as unknown,
    );
  } catch (error) {
    throw new Error('Invalid marketplace dispatch decision', { cause: error });
  }
}

function terminalEvidenceTimestamp(evidence: MarketplaceTerminalEvidence): string {
  return evidence.status === 'submitted' ? evidence.submittedAt : evidence.cancelledAt;
}

function marketplaceSubmissionIdentityMatches(
  left: TaskSubmitResultV1,
  right: TaskSubmitResultV1,
): boolean {
  const compatibleOptionalIdentity = <Value>(
    leftValue: Value | undefined,
    rightValue: Value | undefined,
  ): boolean => leftValue === undefined || rightValue === undefined || leftValue === rightValue;
  return left.id === right.id
    && left.creatorMultisig === right.creatorMultisig
    && left.taskId === right.taskId
    && left.taskCid === right.taskCid
    && left.creationTx === right.creationTx
    && left.creationBlock === right.creationBlock
    && left.solverNetManifestCid === right.solverNetManifestCid
    && compatibleOptionalIdentity(left.attemptId, right.attemptId)
    && compatibleOptionalIdentity(left.attemptNumber, right.attemptNumber);
}

function terminalEvidenceMatchesTransition(
  evidence: MarketplaceTerminalEvidence,
  transition: MarketplaceExecutionTransition,
): boolean {
  return evidence.status === 'submitted' && transition.status === 'submitted'
    ? marketplaceSubmissionIdentityMatches(
        evidence.submission,
        decodeMarketplaceSubmission(transition.submission),
      )
    : evidence.status === 'cancelled' && transition.status === 'cancelled'
      ? evidence.reason === stringField(transition.reason, 'marketplace cancellation reason')
      : false;
}

function terminalEvidenceForTransition(
  requestDigest: string,
  transition: MarketplaceExecutionTransition,
  timestamp: string,
): MarketplaceTerminalEvidence {
  return transition.status === 'submitted'
    ? {
        schemaVersion: MARKETPLACE_TERMINAL_EVIDENCE_SCHEMA_VERSION,
        requestDigest,
        status: 'submitted',
        submission: decodeMarketplaceSubmission(transition.submission),
        submittedAt: timestamp,
      }
    : {
        schemaVersion: MARKETPLACE_TERMINAL_EVIDENCE_SCHEMA_VERSION,
        requestDigest,
        status: 'cancelled',
        reason: stringField(transition.reason, 'marketplace cancellation reason'),
        cancelledAt: timestamp,
      };
}

function writeMarketplaceTerminalCandidate(
  terminalPath: string,
  evidence: MarketplaceTerminalEvidence,
): string {
  const candidate = join(
    dirname(terminalPath),
    `.${basename(terminalPath)}.candidate-${process.pid}-${randomUUID()}`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(candidate, 'wx', 0o600);
    chmodSync(candidate, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return candidate;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeMarketplaceDispatchCandidate(
  decisionPath: string,
  decision: MarketplaceDispatchDecision,
): string {
  const candidate = join(
    dirname(decisionPath),
    `.${basename(decisionPath)}.candidate-${process.pid}-${randomUUID()}`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(candidate, 'wx', 0o600);
    chmodSync(candidate, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(decision, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return candidate;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function installMarketplaceTerminalEvidence(
  manifestPath: string,
  candidate: string,
): MarketplaceTerminalEvidence {
  const terminalPath = marketplaceTerminalEvidencePath(manifestPath);
  try {
    linkSync(candidate, terminalPath);
    fsyncDirectory(dirname(terminalPath));
    return readMarketplaceTerminalEvidence(terminalPath)!;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return readMarketplaceTerminalEvidence(terminalPath)!;
  } finally {
    if (existsSync(candidate)) rmSync(candidate);
  }
}

function installMarketplaceDispatchDecision(
  manifestPath: string,
  candidate: string,
): MarketplaceDispatchDecision {
  const decisionPath = marketplaceDispatchDecisionPath(manifestPath);
  try {
    linkSync(candidate, decisionPath);
    fsyncDirectory(dirname(decisionPath));
    return readMarketplaceDispatchDecision(decisionPath)!;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return readMarketplaceDispatchDecision(decisionPath)!;
  } finally {
    if (existsSync(candidate)) rmSync(candidate);
  }
}

/**
 * Atomically chooses whether a prepared marketplace request may be broadcast
 * or must remain cancelled. The immutable hard-link winner closes the window
 * where cancellation could otherwise commit while submission was starting.
 */
export function claimMarketplaceDispatchDecision(
  path: string,
  expectedRequestDigest: string,
  desired:
    | { readonly decision: 'broadcast' }
    | { readonly decision: 'cancelled'; readonly reason: string },
  now: () => Date = () => new Date(),
): MarketplaceDispatchDecision {
  const expectedDigest = marketplaceRequestDigest(expectedRequestDigest);
  const decisionPath = marketplaceDispatchDecisionPath(path);
  let decision = readMarketplaceDispatchDecision(decisionPath);
  if (decision === undefined) {
    const manifest = readAttemptManifest(path);
    if (
      manifest.execution.backend !== 'marketplace'
      || (
        manifest.execution.state.schemaVersion !== MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
        && manifest.execution.state.schemaVersion !== MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION
      )
      || manifest.execution.state.requestDigest !== expectedDigest
    ) {
      throw new Error('Marketplace dispatch decision does not match the attempt manifest');
    }
    const state = manifest.execution.state;
    if (state.status !== 'prepared') {
      throw new Error('Only a prepared marketplace execution may choose dispatch');
    }
    const decidedAt = transitionTimestamp(now);
    if (Date.parse(decidedAt) < Date.parse(state.preparedAt)) {
      throw new Error('Marketplace dispatch decision predates preparation timestamp');
    }
    if (Date.parse(decidedAt) < Date.parse(manifest.timestamps.updatedAt)) {
      throw new Error('Marketplace dispatch decision predates manifest updated timestamp');
    }
    const candidate = writeMarketplaceDispatchCandidate(
      decisionPath,
      desired.decision === 'broadcast'
        ? {
            schemaVersion: MARKETPLACE_DISPATCH_DECISION_SCHEMA_VERSION,
            requestDigest: expectedDigest,
            decision: 'broadcast',
            decidedAt,
          }
        : {
            schemaVersion: MARKETPLACE_DISPATCH_DECISION_SCHEMA_VERSION,
            requestDigest: expectedDigest,
            decision: 'cancelled',
            reason: stringField(desired.reason, 'marketplace cancellation reason'),
            decidedAt,
          },
    );
    decision = installMarketplaceDispatchDecision(path, candidate);
  }
  if (decision.requestDigest !== expectedDigest) {
    throw new Error('Marketplace dispatch decision request digest changed');
  }
  return decision;
}

function marketplaceStateForTerminalEvidence(
  state: MarketplacePreparedExecutionFields & {
    readonly schemaVersion:
      | typeof MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
      | typeof MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION;
  },
  evidence: MarketplaceTerminalEvidence,
): MarketplaceExecutionState {
  const prepared: MarketplacePreparedExecutionFields & {
    readonly schemaVersion:
      | typeof MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
      | typeof MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION;
  } = {
    schemaVersion: state.schemaVersion,
    requestPath: state.requestPath,
    requestDigest: state.requestDigest,
    solverNetSelectionPath: state.solverNetSelectionPath,
    preparedAt: state.preparedAt,
    agentSoftDeadline: state.agentSoftDeadline,
    adoptionDeadline: state.adoptionDeadline,
  };
  return evidence.status === 'submitted'
    ? {
        ...prepared,
        status: 'submitted',
        submission: evidence.submission,
        submittedAt: evidence.submittedAt,
      }
    : {
        ...prepared,
        status: 'cancelled',
        reason: evidence.reason,
        cancelledAt: evidence.cancelledAt,
      };
}

function applyMarketplaceTerminalEvidence(
  path: string,
  expectedDigest: string,
  evidence: MarketplaceTerminalEvidence,
): AttemptManifest {
  if (evidence.requestDigest !== expectedDigest) {
    throw new Error('Marketplace terminal evidence request digest changed before transition');
  }
  const current = readAttemptManifest(path);
  if (
    current.execution.backend !== 'marketplace'
    || (
      current.execution.state.schemaVersion !== MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
      && current.execution.state.schemaVersion !== MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION
    )
    || current.execution.state.requestDigest !== expectedDigest
  ) {
    throw new Error('Marketplace terminal evidence does not match the attempt manifest');
  }
  const state = current.execution.state;
  if (Date.parse(terminalEvidenceTimestamp(evidence)) < Date.parse(state.preparedAt)) {
    throw new Error('Marketplace terminal evidence predates preparation timestamp');
  }
  const persistedMatchesEvidence = state.status === 'submitted'
    ? evidence.status === 'submitted'
      && marketplaceSubmissionIdentityMatches(state.submission, evidence.submission)
    : state.status === 'cancelled'
      ? evidence.status === 'cancelled' && state.reason === evidence.reason
      : state.status === 'prepared'
        ? true
        : evidence.status === 'submitted'
          && 'submission' in state
          && marketplaceSubmissionIdentityMatches(state.submission, evidence.submission);
  if (!persistedMatchesEvidence) {
    throw new Error('Marketplace terminal evidence contradicts persisted execution');
  }
  if (
    state.status !== 'prepared'
    && state.status !== 'submitted'
    && state.status !== 'cancelled'
  ) {
    return current;
  }
  const terminalState = marketplaceStateForTerminalEvidence(state, evidence);
  const next = decodeAttemptManifest({
    ...current,
    execution: { backend: 'marketplace', state: terminalState },
    timestamps: {
      ...current.timestamps,
      updatedAt: Date.parse(current.timestamps.updatedAt) >= Date.parse(terminalEvidenceTimestamp(evidence))
        ? current.timestamps.updatedAt
        : terminalEvidenceTimestamp(evidence),
    },
  });
  if (!isDeepStrictEqual(current, next)) writeManifestAtomic(path, next);
  return next;
}

/**
 * Repairs the manifest from immutable terminal evidence before any caller
 * inspects execution state or starts an external process.
 */
export function reconcileMarketplaceTerminalEvidence(path: string): AttemptManifest {
  const current = readAttemptManifest(path);
  if (
    current.execution.backend !== 'marketplace'
    || (
      current.execution.state.schemaVersion !== MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
      && current.execution.state.schemaVersion !== MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION
    )
  ) {
    return current;
  }
  const evidence = readMarketplaceTerminalEvidence(
    marketplaceTerminalEvidencePath(path),
  );
  if (evidence !== undefined) {
    return applyMarketplaceTerminalEvidence(
      path,
      current.execution.state.requestDigest,
      evidence,
    );
  }
  const decision = readMarketplaceDispatchDecision(
    marketplaceDispatchDecisionPath(path),
  );
  if (decision === undefined || decision.decision === 'broadcast') return current;
  if (decision.requestDigest !== current.execution.state.requestDigest) {
    throw new Error('Marketplace dispatch decision request digest changed');
  }
  return transitionMarketplaceExecution(
    path,
    decision.requestDigest,
    { status: 'cancelled', reason: decision.reason },
    () => new Date(decision.decidedAt),
  );
}

/**
 * Records exactly one durable marketplace outcome for a prepared request.
 * Replaying the same terminal outcome is a no-op; any competing outcome is
 * rejected before the manifest can be rewritten.
 */
export function transitionMarketplaceExecution(
  path: string,
  expectedRequestDigest: string,
  transition: MarketplaceExecutionTransition,
  now: () => Date = () => new Date(),
): AttemptManifest {
  if (transition.status !== 'submitted' && transition.status !== 'cancelled') {
    throw new Error('Invalid marketplace execution transition');
  }
  const expectedDigest = marketplaceRequestDigest(expectedRequestDigest);
  const terminalPath = marketplaceTerminalEvidencePath(path);
  let evidence = readMarketplaceTerminalEvidence(terminalPath);
  if (evidence === undefined) {
    const previous = readAttemptManifest(path);
    if (previous.execution.backend !== 'marketplace') {
      throw new Error('Only marketplace attempts may transition marketplace execution');
    }
    const state = previous.execution.state;
    if (
      (
        state.schemaVersion !== MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
        && state.schemaVersion !== MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION
      )
      || state.requestDigest !== expectedDigest) {
      throw new Error('Marketplace request digest changed before execution transition');
    }
    if (state.status !== 'prepared') {
      throw new Error('Only a prepared marketplace execution may transition');
    }
    const timestamp = transitionTimestamp(now);
    if (Date.parse(timestamp) < Date.parse(state.preparedAt)) {
      throw new Error('Marketplace transition timestamp predates preparation timestamp');
    }
    if (Date.parse(timestamp) < Date.parse(previous.timestamps.updatedAt)) {
      throw new Error('Marketplace transition timestamp predates manifest updated timestamp');
    }
    const decision = claimMarketplaceDispatchDecision(
      path,
      expectedDigest,
      transition.status === 'submitted'
        ? { decision: 'broadcast' }
        : {
            decision: 'cancelled',
            reason: stringField(transition.reason, 'marketplace cancellation reason'),
          },
      () => new Date(timestamp),
    );
    if (transition.status === 'submitted' && decision.decision !== 'broadcast') {
      throw new Error('Cannot submit a cancelled marketplace execution');
    }
    if (transition.status === 'cancelled' && decision.decision !== 'cancelled') {
      throw new Error(
        'Marketplace cancellation cannot proceed after broadcast authorization started',
      );
    }
    if (
      transition.status === 'cancelled'
      && decision.decision === 'cancelled'
      && decision.reason !== transition.reason
    ) {
      throw new Error('Marketplace execution already has a contradictory cancellation');
    }
    evidence = readMarketplaceTerminalEvidence(terminalPath);
    if (evidence === undefined) {
      const candidate = writeMarketplaceTerminalCandidate(
        terminalPath,
        terminalEvidenceForTransition(expectedDigest, transition, timestamp),
      );
      evidence = installMarketplaceTerminalEvidence(path, candidate);
    }
  }
  if (evidence.requestDigest !== expectedDigest) {
    throw new Error('Marketplace terminal evidence request digest changed before transition');
  }
  if (!terminalEvidenceMatchesTransition(evidence, transition)) {
    if (evidence.status === 'submitted' && transition.status === 'submitted') {
      throw new Error('Marketplace execution already has a contradictory submission');
    }
    if (evidence.status === 'cancelled' && transition.status === 'cancelled') {
      throw new Error('Marketplace execution already has a contradictory cancellation');
    }
    throw new Error('Only a prepared marketplace execution may transition');
  }
  return applyMarketplaceTerminalEvidence(path, expectedDigest, evidence);
}

/**
 * Checkpoint-only manifest transition. The original claim/identity/path
 * binding remains immutable; only the exact progressive publication head and
 * its update timestamp may advance.
 */
export function advanceAttemptExpectedHead(
  path: string,
  expectedHead: string,
  nextHead: string,
  now: () => Date = () => new Date(),
): AttemptManifest {
  const previous = readAttemptManifest(path);
  requireDedicatedMarketplaceExecutionTransition(previous);
  const expected = gitOid(expectedHead);
  const next = gitOid(nextHead);
  if (previous.expectedHead !== expected) {
    throw new Error('Attempt manifest expected head changed before progressive update');
  }
  const timestamp = transitionTimestamp(now);
  const advanced = decodeAttemptManifest({
    ...previous,
    expectedHead: next,
    timestamps: {
      ...previous.timestamps,
      updatedAt: timestamp,
    },
  });
  writeManifestAtomic(path, advanced);
  return advanced;
}

/**
 * Review fix publication advances one exact branch/review-ref authority pair.
 * Both expectations are checked before the single atomic manifest rewrite.
 */
export function advanceAttemptReviewPair(
  path: string,
  expectedHead: string,
  expectedReviewRefOid: string,
  nextHead: string,
  nextReviewRefOid: string,
  now: () => Date = () => new Date(),
): AttemptManifest {
  const previous = readAttemptManifest(path);
  requireDedicatedMarketplaceExecutionTransition(previous);
  const expectedBranch = gitOid(expectedHead);
  const expectedReview = gitOid(expectedReviewRefOid);
  const nextBranch = gitOid(nextHead);
  const nextReview = gitOid(nextReviewRefOid);
  if (
    previous.phase !== 'review'
    || previous.expectedHead !== expectedBranch
    || previous.reviewRefOid !== expectedReview
  ) {
    throw new Error('Review attempt manifest authority pair changed before progressive update');
  }
  const advanced = decodeAttemptManifest({
    ...previous,
    expectedHead: nextBranch,
    reviewRefOid: nextReview,
    timestamps: {
      ...previous.timestamps,
      updatedAt: transitionTimestamp(now),
    },
  });
  writeManifestAtomic(path, advanced);
  return advanced;
}

function transitionTimestamp(now: () => Date): string {
  const timestamp = now().toISOString();
  return isoTimestamp(timestamp);
}

export function markAttemptRunning(
  manifestPath: string,
  pid: number,
  now: () => Date = () => new Date(),
): AttemptManifest {
  const validPid = positiveInteger(pid, 'PID');
  const timestamp = transitionTimestamp(now);
  return updateAttemptManifest(manifestPath, (current) => {
    if (current.processState !== 'preparing') {
      throw new Error('Only a preparing attempt may transition to running');
    }
    return {
      ...current,
      processState: 'running',
      pid: validPid,
      timestamps: {
        ...current.timestamps,
        updatedAt: timestamp,
        childStartedAt: timestamp,
      },
    };
  });
}

export function markAttemptExited(
  manifestPath: string,
  now: () => Date = () => new Date(),
  terminalHead?: string,
): AttemptManifest {
  const current = readAttemptManifest(manifestPath);
  if (
    current.execution.backend === 'marketplace'
    && (
      current.execution.state.schemaVersion === MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
      || current.execution.state.schemaVersion === MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION
      || current.execution.state.schemaVersion === 'marketplace-evaluator-leg-v1'
    )
  ) {
    return markMarketplaceAttemptExited(manifestPath, now, terminalHead);
  }
  const timestamp = transitionTimestamp(now);
  const validTerminalHead = terminalHead === undefined ? undefined : gitOid(terminalHead);
  return updateAttemptManifest(manifestPath, (manifest) => {
    if (manifest.processState !== 'running') {
      throw new Error('Only a running attempt may transition to exited');
    }
    return {
      ...manifest,
      processState: 'exited',
      ...(validTerminalHead === undefined ? {} : { terminalHead: validTerminalHead }),
      timestamps: {
        ...manifest.timestamps,
        updatedAt: timestamp,
        childExitedAt: timestamp,
      },
    };
  });
}

export function markMarketplaceAttemptExited(
  manifestPath: string,
  now: () => Date = () => new Date(),
  terminalHead?: string,
): AttemptManifest {
  const timestamp = transitionTimestamp(now);
  const validTerminalHead = terminalHead === undefined ? undefined : gitOid(terminalHead);
  const current = readAttemptManifest(manifestPath);
  if (current.processState !== 'running') {
    throw new Error('Only a running attempt may transition to exited');
  }
  const next = decodeAttemptManifest({
    ...current,
    processState: 'exited',
    ...(validTerminalHead === undefined ? {} : { terminalHead: validTerminalHead }),
    timestamps: {
      ...current.timestamps,
      updatedAt: timestamp,
      childExitedAt: timestamp,
    },
  });
  writeManifestAtomic(manifestPath, next);
  return next;
}

export interface TrackableAttemptChild {
  readonly pid?: number;
  readonly exitCode?: number | null;
  once(event: 'exit', listener: (...args: unknown[]) => void): unknown;
}

export interface TrackAttemptChildOptions {
  readonly alreadyRunning?: boolean;
  readonly now?: () => Date;
  readonly terminalHead?: string;
}

/**
 * Parent-side lifecycle binding. The exit listener records positive terminal
 * evidence through the same atomic manifest update used by direct callers.
 */
export function trackAttemptChild(
  manifestPath: string,
  child: TrackableAttemptChild,
  options: TrackAttemptChildOptions = {},
): AttemptManifest {
  const pid = positiveInteger(child.pid, 'child PID');
  let exitObserved = child.exitCode !== undefined && child.exitCode !== null;
  let runningRecorded = false;
  let exitedRecorded = false;
  const recordExit = (): void => {
    exitObserved = true;
    if (runningRecorded && !exitedRecorded) {
      markAttemptExited(manifestPath, options.now, options.terminalHead);
      exitedRecorded = true;
    }
  };
  child.once('exit', recordExit);
  const running = options.alreadyRunning === true
    ? readAttemptManifest(manifestPath)
    : markAttemptRunning(manifestPath, pid, options.now);
  if (running.processState !== 'running' || running.pid !== pid) {
    throw new Error('Tracked child does not match the running attempt');
  }
  runningRecorded = true;
  if (exitObserved) recordExit();
  return exitedRecorded ? readAttemptManifest(manifestPath) : running;
}

/**
 * The askpass helper used to read `$GH_TOKEN` from the environment. Replaced
 * (#1883) because some coordinator runtimes (Hermes) scrub secret-shaped env
 * vars from spawned shell tools before running them, so `git`'s askpass
 * invocation saw an empty `$GH_TOKEN` even though the parent process set it.
 * `buildAskpassScript` below bakes in the absolute path to the attempt's
 * token file instead — a filesystem read survives any runtime's env scrub.
 */
function buildAskpassScript(tokenFilePath: string): string {
  return `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *Password*) cat "${tokenFilePath}" ;;
  *) exit 1 ;;
esac
`;
}

const CONTROL_CHARACTER_PATTERN = new RegExp(
  '[' + String.fromCharCode(0) + '-' + String.fromCharCode(31)
    + String.fromCharCode(127) + ']',
);

function assertNoControlCharacters(value: string, name: string): string {
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${name} must not contain control characters`);
  }
  return value;
}

/**
 * gh CLI's own config-directory auth file (`$GH_CONFIG_DIR/hosts.yml`). Once
 * this exists, `gh` authenticates from `GH_CONFIG_DIR` alone — no `GH_TOKEN`
 * env var required — which is the other half of the runtime-independent
 * handoff (#1883): `gh` subcommands run by the coordinator (including
 * `autopilot session ...`) authenticate even when the runtime scrubbed env.
 */
function buildGhHostsYaml(login: string, token: string): string {
  assertNoControlCharacters(login, 'GitHub login');
  assertNoControlCharacters(token, 'GitHub token');
  return `github.com:\n    oauth_token: ${token}\n    user: ${login}\n    git_protocol: https\n`;
}

function canonicalDirectory(path: string, name: string): string {
  if (!isAbsolute(path)) throw new Error(`Invalid ${name}`);
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) throw new Error(`Invalid ${name}`);
  return canonical;
}

function remoteUrlHash(remoteUrl: string): string {
  return createHash('sha256').update(remoteUrl).digest('hex');
}

async function readRepositoryIdentity(
  repositoryPath: string,
  remoteName: string,
  runner: CommandRunner,
): Promise<AttemptRepositoryIdentity> {
  const validRemoteName = gitRefName(remoteName);
  try {
    const root = canonicalDirectory((await runner('git', [
      '-C', repositoryPath,
      'rev-parse', '--path-format=absolute', '--show-toplevel',
    ])).trim(), 'canonical repository root');
    const gitCommonDir = canonicalDirectory((await runner('git', [
      '-C', repositoryPath,
      'rev-parse', '--path-format=absolute', '--git-common-dir',
    ])).trim(), 'Git common directory');
    const remoteUrl = stringField((await runner('git', [
      '-C', repositoryPath,
      'remote', 'get-url', validRemoteName,
    ])).trim(), 'remote URL');
    return decodeRepositoryIdentity({
      root,
      gitCommonDir,
      remoteName: validRemoteName,
      remoteUrlHash: remoteUrlHash(remoteUrl),
    });
  } catch {
    throw new Error('Attempt repository identity could not be established');
  }
}

async function registeredWorktreePaths(
  gitCommonDir: string,
  runner: CommandRunner,
): Promise<string[]> {
  const porcelain = await runner('git', [
    `--git-dir=${gitCommonDir}`,
    'worktree', 'list', '--porcelain', '-z',
  ]);
  return porcelain
    .split('\0')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice('worktree '.length)));
}

function canonicalProspectivePath(path: string): string {
  let existing = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error('Path has no existing canonical ancestor');
    suffix.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...suffix);
}

async function commitObjectExists(
  runner: CommandRunner,
  repositoryRoot: string,
  oid: string,
): Promise<boolean> {
  try {
    await runner('git', ['-C', repositoryRoot, 'cat-file', '-e', `${oid}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function ensureExpectedHeadAvailable(
  runner: CommandRunner,
  repository: AttemptRepositoryIdentity,
  input: {
    readonly expectedHead: string;
    readonly branch: string;
    readonly prNumber?: number;
  },
): Promise<void> {
  if (await commitObjectExists(runner, repository.root, input.expectedHead)) {
    return;
  }
  const fetchSpecs = [input.branch];
  if (input.prNumber !== undefined) {
    fetchSpecs.push(`pull/${input.prNumber}/head`);
  }
  for (const spec of fetchSpecs) {
    try {
      await runner('git', [
        '-C', repository.root,
        'fetch', '--quiet', repository.remoteName, spec,
      ]);
    } catch {
      // Best-effort: the branch or PR ref may not exist on the remote yet.
    }
  }
  if (await commitObjectExists(runner, repository.root, input.expectedHead)) {
    return;
  }
  const prRef = input.prNumber === undefined
    ? ''
    : ` and ${repository.remoteName}/pull/${input.prNumber}/head`;
  throw new Error(
    `Expected head ${input.expectedHead} is not available after fetching `
    + `${repository.remoteName}/${input.branch}${prRef}`,
  );
}

function marketplaceWorkflow(
  workflow: MarketplaceMutationWorkflow,
): 'implement' | 'fix-child' | 'reconcile' | 'ci-failure' {
  if (workflow === 'implementation') return 'implement';
  if (workflow === 'ci-failure') return 'ci-failure';
  if (workflow === 'reconcile') return 'reconcile';
  return 'fix-child';
}

function validateMarketplacePreparation(
  options: CreateAttemptOptions,
  attemptId: string,
  runnerId: string,
): MarketplaceAttemptPreparation | undefined {
  const preparation = options.marketplacePreparation;
  if (preparation === undefined) return undefined;
  if (options.execution !== undefined) {
    throw new Error(
      'Marketplace preparation cannot be combined with explicit execution state',
    );
  }
  if (options.phase !== 'implement') {
    throw new Error('Marketplace preparation is valid only for implementation attempts');
  }
  if (options.prNumber === undefined) {
    throw new Error('Marketplace preparation requires a PR number');
  }
  if (options.targetBaseOid === undefined) {
    throw new Error('Marketplace preparation requires an exact target-base OID');
  }
  const request = TaskSubmitRequestV1Schema.parse(preparation.request);
  const session = request.spec.session;
  const agentSoftDeadline = isoTimestamp(preparation.agentSoftDeadline);
  const adoptionDeadline = isoTimestamp(preparation.adoptionDeadline);
  const baseSha = gitOid(preparation.baseSha);
  const targetBaseOid = gitOid(options.targetBaseOid);
  const mismatch = (field: string): never => {
    throw new Error(`Marketplace preparation ${field} does not match attempt binding`);
  };
  if (
    request.id !== `autopilot:${attemptId}`
    || request.spec.instance_id !== request.id
    || session.v2AttemptId !== attemptId
  ) {
    mismatch('v2 attempt ID');
  }
  if (session.runnerId !== runnerId) mismatch('runner ID');
  if (session.issueNumber !== options.issueNumber) mismatch('issue number');
  if (session.prNumber !== options.prNumber) mismatch('PR number');
  if (session.branch !== options.branch) mismatch('branch');
  if (session.targetBase !== options.targetBase) mismatch('target base');
  if (session.claimOid !== options.claimOid) mismatch('claim OID');
  if (
    session.expectedHead !== options.expectedHead
    || request.spec.base_commit !== options.expectedHead
  ) {
    mismatch('expected head');
  }
  if (session.workflow !== marketplaceWorkflow(preparation.workflow)) {
    mismatch('workflow');
  }
  if (session.taskSnapshot.baseSha !== baseSha) mismatch('base SHA');
  if (session.taskSnapshot.targetBaseOid !== targetBaseOid) {
    mismatch('target-base OID');
  }
  if (
    session.deadline !== agentSoftDeadline
    || request.window.endTs !== Date.parse(adoptionDeadline)
    || request.claimPolicy.submissionDeadlineTs !== Date.parse(adoptionDeadline)
  ) {
    mismatch('deadlines');
  }
  const expectedProblemStatement = session.taskSnapshot.body.length === 0
    ? session.taskSnapshot.title
    : session.taskSnapshot.body;
  if (
    request.description !== session.taskSnapshot.title
    || request.spec.problem_statement !== expectedProblemStatement
  ) {
    mismatch('task snapshot');
  }
  if (preparation.workflow === 'implementation') {
    if (session.childIssueNumber !== undefined || session.parentPrNumber !== undefined) {
      mismatch('implementation child metadata');
    }
  } else if (
    session.childIssueNumber !== options.issueNumber
    || session.parentPrNumber !== options.prNumber
  ) {
    mismatch('child binding');
  }
  return {
    ...preparation,
    baseSha,
    request,
    agentSoftDeadline,
    adoptionDeadline,
  };
}

const MARKETPLACE_INITIALIZATION_SCHEMA_VERSION =
  'marketplace-attempt-initialization-v1';
const MARKETPLACE_INITIALIZATION_SUFFIX =
  '.marketplace-initialization.json';

interface MarketplaceAttemptInitializationJournal {
  readonly schemaVersion: typeof MARKETPLACE_INITIALIZATION_SCHEMA_VERSION;
  readonly request: TaskSubmitRequestV1;
  readonly manifest: AttemptManifest;
}

function marketplaceInitializationJournalPath(manifest: AttemptManifest): string {
  return join(
    dirname(manifest.paths.attemptDir),
    `.${basename(manifest.paths.attemptDir)}${MARKETPLACE_INITIALIZATION_SUFFIX}`,
  );
}

function canonicalMarketplaceRequest(
  input: TaskSubmitRequestV1,
): { readonly request: TaskSubmitRequestV1; readonly digest: string } {
  const request = TaskSubmitRequestV1Schema.parse(input);
  const bytes = Buffer.from(`${JSON.stringify(request, null, 2)}\n`);
  return {
    request,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

function expectedAttemptPaths(attemptDir: string): AttemptPaths {
  return {
    attemptDir,
    worktree: join(attemptDir, 'worktree'),
    manifest: join(attemptDir, 'manifest.json'),
    log: join(attemptDir, 'session.log'),
    ghConfigDir: join(attemptDir, 'gh-config'),
    askpass: join(attemptDir, 'askpass'),
    tokenFile: join(attemptDir, 'gh-token'),
  };
}

function assertMarketplaceJournalCorrelation(
  journal: MarketplaceAttemptInitializationJournal,
): void {
  const { manifest, request } = journal;
  if (
    manifest.execution.backend !== 'marketplace'
    || (
      manifest.execution.state.schemaVersion !== MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
      && manifest.execution.state.schemaVersion !== MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION
    )
    || manifest.execution.state.status !== 'prepared'
    || manifest.phase !== 'implement'
    || manifest.prNumber === undefined
    || manifest.processState !== 'preparing'
    || manifest.pid !== null
  ) {
    throw new Error('Marketplace initialization journal requires a prepared implementation');
  }
  const state = manifest.execution.state;
  const expectedPaths = expectedAttemptPaths(manifest.paths.attemptDir);
  const phaseDir = dirname(manifest.paths.attemptDir);
  const runnerDir = dirname(phaseDir);
  const session = request.spec.session;
  const expectedWorkflow = session.workflow === 'implement'
    ? 'implementation'
    : session.workflow === 'fix-child'
      ? 'review-finding'
      : session.workflow;
  if (
    basename(manifest.paths.attemptDir)
      !== `${manifest.subject}-${manifest.attemptId}`
  ) {
    throw new Error(
      'Marketplace initialization journal subject and attempt identity disagree',
    );
  }
  if (
    !samePaths(manifest.paths, expectedPaths)
    || basename(phaseDir) !== manifest.phase
    || basename(runnerDir) !== manifest.runnerId
    || state.requestPath !== join(manifest.paths.attemptDir, 'marketplace-request.json')
    || state.solverNetSelectionPath !== `${state.requestPath}.solvernet-selection.json`
    || canonicalMarketplaceRequest(request).digest !== state.requestDigest
    || request.id !== `autopilot:${manifest.attemptId}`
    || request.spec.instance_id !== request.id
    || request.spec.base_commit !== manifest.expectedHead
    || session.v2AttemptId !== manifest.attemptId
    || session.runnerId !== manifest.runnerId
    || session.issueNumber !== manifest.issueNumber
    || session.prNumber !== manifest.prNumber
    || session.branch !== manifest.branch
    || session.targetBase !== manifest.targetBase
    || session.claimOid !== manifest.claimOid
    || session.expectedHead !== manifest.expectedHead
    || manifest.targetBaseOid === undefined
    || session.taskSnapshot.targetBaseOid !== manifest.targetBaseOid
    || !(
      expectedWorkflow === 'implementation'
      || expectedWorkflow === 'review-finding'
      || expectedWorkflow === 'reconcile'
      || expectedWorkflow === 'ci-failure'
    )
  ) {
    throw new Error('Marketplace initialization journal does not correlate');
  }
}

function decodeMarketplaceInitializationJournal(
  value: unknown,
  journalPath: string,
): MarketplaceAttemptInitializationJournal {
  const journal = record(value, 'marketplace initialization journal');
  exactKeys(
    journal,
    ['schemaVersion', 'request', 'manifest'],
    'marketplace initialization journal',
  );
  if (journal.schemaVersion !== MARKETPLACE_INITIALIZATION_SCHEMA_VERSION) {
    throw new Error('Invalid marketplace initialization journal schema version');
  }
  const decoded: MarketplaceAttemptInitializationJournal = {
    schemaVersion: MARKETPLACE_INITIALIZATION_SCHEMA_VERSION,
    request: TaskSubmitRequestV1Schema.parse(journal.request),
    manifest: decodeAttemptManifest(journal.manifest),
  };
  assertMarketplaceJournalCorrelation(decoded);
  if (marketplaceInitializationJournalPath(decoded.manifest) !== journalPath) {
    throw new Error('Marketplace initialization journal path escaped its attempt');
  }
  return decoded;
}

function readMarketplaceInitializationJournal(
  journalPath: string,
): MarketplaceAttemptInitializationJournal {
  const metadata = lstatSync(journalPath);
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || (metadata.mode & 0o777) !== 0o600
  ) {
    throw new Error('Marketplace initialization journal is not a mode-0600 regular file');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(journalPath, 'utf8')) as unknown;
  } catch {
    throw new Error('Malformed marketplace initialization journal');
  }
  return decodeMarketplaceInitializationJournal(parsed, journalPath);
}

function installMarketplaceInitializationJournal(
  journalPath: string,
  input: MarketplaceAttemptInitializationJournal,
): void {
  const journal = decodeMarketplaceInitializationJournal(input, journalPath);
  const bytes = Buffer.from(`${JSON.stringify(journal, null, 2)}\n`);
  const temporary = join(
    dirname(journalPath),
    `.${basename(journalPath)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    chmodSync(temporary, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(temporary, journalPath);
      fsyncDirectory(dirname(journalPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = readMarketplaceInitializationJournal(journalPath);
      if (!isDeepStrictEqual(existing, journal)) {
        throw new Error('Existing marketplace initialization journal conflicts');
      }
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) {
      rmSync(temporary);
      fsyncDirectory(dirname(journalPath));
    }
  }
}

function ensureExactDirectory(path: string, mode: number): void {
  if (!existsSync(path)) {
    mkdirSync(path, { mode });
    fsyncDirectory(dirname(path));
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('Marketplace initialization path is not a directory');
  }
  chmodSync(path, mode);
}

function writeDirectDurableFile(
  path: string,
  contents: string,
  mode: number,
): void {
  if (existsSync(path)) {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error('Marketplace initialization artifact is not a regular file');
    }
  }
  const descriptor = openSync(path, 'w', mode);
  try {
    chmodSync(path, mode);
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}

function materializeMarketplaceAttemptArtifacts(
  manifest: AttemptManifest,
  credential: SelectedCredential,
): void {
  if (credential.normalizedLogin !== manifest.selectedLogin.toLowerCase()) {
    throw new Error('Marketplace credential does not match the recorded login');
  }
  ensureExactDirectory(manifest.paths.attemptDir, 0o700);
  ensureExactDirectory(manifest.paths.ghConfigDir, 0o700);
  writeDirectDurableFile(manifest.paths.log, '', 0o600);
  writeDirectDurableFile(
    manifest.paths.askpass,
    buildAskpassScript(manifest.paths.tokenFile),
    0o700,
  );
  // Secret-bearing files deliberately use their final exact path directly.
  // A crash may leave partial bytes, but the non-secret journal remains and
  // exact-login recovery deterministically overwrites them. No atomic temp
  // ever contains raw credential material.
  writeDirectDurableFile(
    manifest.paths.tokenFile,
    `${credential.secret()}\n`,
    0o600,
  );
  writeDirectDurableFile(
    join(manifest.paths.ghConfigDir, 'hosts.yml'),
    buildGhHostsYaml(manifest.selectedLogin, credential.secret()),
    0o600,
  );
}

function sameCanonicalPath(left: string, right: string): boolean {
  return canonicalProspectivePath(left) === canonicalProspectivePath(right);
}

export async function proveMarketplaceAttemptWorktree(
  manifest: AttemptManifest,
  runner: CommandRunner,
): Promise<void> {
  let worktree: ReturnType<typeof lstatSync>;
  try {
    worktree = lstatSync(manifest.paths.worktree);
  } catch (error) {
    throw new Error('Marketplace attempt worktree is not initialized', { cause: error });
  }
  if (worktree.isSymbolicLink() || !worktree.isDirectory()) {
    throw new Error('Marketplace attempt worktree is not initialized');
  }
  const registered = await registeredWorktreePaths(
    manifest.repository.gitCommonDir,
    runner,
  );
  const exactRegistrations = registered.filter((path) =>
    sameCanonicalPath(path, manifest.paths.worktree));
  if (exactRegistrations.length !== 1) {
    throw new Error('Marketplace attempt worktree is not exactly registered');
  }
  let actualCommonDir: string;
  let head: string;
  let status: string;
  try {
    actualCommonDir = canonicalDirectory((await runner('git', [
      '-C', manifest.paths.worktree,
      'rev-parse', '--path-format=absolute', '--git-common-dir',
    ])).trim(), 'marketplace worktree Git common directory');
    head = gitOid((await runner('git', [
      '-C', manifest.paths.worktree,
      'rev-parse', '--verify', 'HEAD^{commit}',
    ])).trim());
    status = await runner('git', [
      '-C', manifest.paths.worktree,
      'status', '--porcelain', '--untracked-files=all',
    ]);
  } catch (error) {
    throw new Error('Marketplace attempt worktree identity could not be proven', {
      cause: error,
    });
  }
  if (actualCommonDir !== manifest.repository.gitCommonDir) {
    throw new Error('Marketplace attempt worktree Git common directory changed');
  }
  if (head !== manifest.expectedHead) {
    throw new Error('Marketplace attempt worktree HEAD changed');
  }
  if (status.trim() !== '') {
    throw new Error('Marketplace attempt worktree is not clean');
  }
}

async function repairMarketplaceAttemptWorktree(
  manifest: AttemptManifest,
  runner: CommandRunner,
): Promise<void> {
  try {
    await proveMarketplaceAttemptWorktree(manifest, runner);
    return;
  } catch {
    // The durable journal exclusively owns this exact not-yet-prepared path.
    // Repair is intentionally limited to this registration and checkout.
  }
  const repository = await readRepositoryIdentity(
    manifest.repository.root,
    manifest.repository.remoteName,
    runner,
  );
  if (!sameRepositoryIdentity(repository, manifest.repository)) {
    throw new Error(
      'Marketplace initialization repository identity does not match its journal',
    );
  }
  const registered = await registeredWorktreePaths(
    manifest.repository.gitCommonDir,
    runner,
  );
  if (registered.some((path) => sameCanonicalPath(path, manifest.paths.worktree))) {
    await runner('git', [
      `--git-dir=${manifest.repository.gitCommonDir}`,
      'worktree', 'remove', '--force', manifest.paths.worktree,
    ]);
    const remaining = await registeredWorktreePaths(
      manifest.repository.gitCommonDir,
      runner,
    );
    if (remaining.some((path) => sameCanonicalPath(path, manifest.paths.worktree))) {
      throw new Error('Interrupted marketplace worktree registration could not be removed');
    }
  }
  if (existsSync(manifest.paths.worktree)) {
    const metadata = lstatSync(manifest.paths.worktree);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('Interrupted marketplace worktree path is unsafe to repair');
    }
    rmSync(manifest.paths.worktree, { recursive: true });
    fsyncDirectory(manifest.paths.attemptDir);
  }
  await runner('git', [
    '-C', manifest.repository.root,
    'worktree', 'add', '--detach',
    manifest.paths.worktree,
    manifest.expectedHead,
  ]);
  await proveMarketplaceAttemptWorktree(manifest, runner);
}

type MarketplaceJournalManifestClassification =
  | { readonly status: 'absent' }
  | { readonly status: 'prepared'; readonly manifest: AttemptManifest }
  | { readonly status: 'terminal'; readonly manifest: AttemptManifest };

function sameMarketplacePreparedFields(
  expected: MarketplacePreparedExecutionFields,
  actual: MarketplacePreparedExecutionFields,
): boolean {
  return expected.requestPath === actual.requestPath
    && expected.requestDigest === actual.requestDigest
    && expected.solverNetSelectionPath === actual.solverNetSelectionPath
    && expected.preparedAt === actual.preparedAt
    && expected.agentSoftDeadline === actual.agentSoftDeadline
    && expected.adoptionDeadline === actual.adoptionDeadline;
}

function classifyMarketplaceJournalManifest(
  journal: MarketplaceAttemptInitializationJournal,
): MarketplaceJournalManifestClassification {
  const path = journal.manifest.paths.manifest;
  if (!existsSync(path)) return { status: 'absent' };
  const current = readAttemptManifest(path);
  if (isDeepStrictEqual(current, journal.manifest)) {
    return { status: 'prepared', manifest: current };
  }
  const expectedExecution = journal.manifest.execution;
  const actualExecution = current.execution;
  if (
    expectedExecution.backend !== 'marketplace'
    || (
      expectedExecution.state.schemaVersion !== MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
      && expectedExecution.state.schemaVersion !== MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION
    )
    || expectedExecution.state.status !== 'prepared'
    || actualExecution.backend !== 'marketplace'
    || actualExecution.state.schemaVersion !== expectedExecution.state.schemaVersion
    || (
      actualExecution.state.status !== 'submitted'
      && actualExecution.state.status !== 'cancelled'
    )
    || !sameMarketplacePreparedFields(
      expectedExecution.state,
      actualExecution.state,
    )
  ) {
    throw new Error(
      'Marketplace terminal manifest conflicts with its initialization journal',
    );
  }
  if (
    actualExecution.state.status === 'submitted'
    && actualExecution.state.submission.id !== journal.request.id
  ) {
    throw new Error(
      'Marketplace terminal request identity conflicts with its initialization journal',
    );
  }
  const normalized = decodeAttemptManifest({
    ...current,
    execution: journal.manifest.execution,
    timestamps: {
      ...current.timestamps,
      updatedAt: journal.manifest.timestamps.updatedAt,
    },
  });
  if (!isDeepStrictEqual(normalized, journal.manifest)) {
    throw new Error(
      'Marketplace terminal manifest conflicts with its initialization journal',
    );
  }
  return { status: 'terminal', manifest: current };
}

function retireMarketplaceInitializationJournal(
  journalPath: string,
  journal: MarketplaceAttemptInitializationJournal,
): AttemptManifest {
  const before = classifyMarketplaceJournalManifest(journal);
  if (before.status === 'absent') {
    throw new Error(
      'Marketplace initialization journal cannot retire without a manifest',
    );
  }
  let removed = false;
  try {
    rmSync(journalPath);
    removed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (removed) fsyncDirectory(dirname(journalPath));
  // A matching terminal transition may win after prepared readback but before
  // the journal unlink. Re-read so the caller observes that durable winner.
  const after = classifyMarketplaceJournalManifest(journal);
  if (after.status === 'absent') {
    throw new Error(
      'Marketplace initialization manifest disappeared during journal retirement',
    );
  }
  return after.manifest;
}

async function installPreparedMarketplaceManifest(
  manifest: AttemptManifest,
  runtime: CreateAttemptWorkspaceRuntime,
): Promise<void> {
  const path = manifest.paths.manifest;
  const valid = decodeAttemptManifest(manifest);
  const bytes = Buffer.from(`${JSON.stringify(valid, null, 2)}\n`);
  const temporary = join(
    dirname(path),
    `.${basename(path)}.marketplace-init-${process.pid}-${randomUUID()}`,
  );
  let descriptor: number | undefined;
  let installed = false;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    chmodSync(temporary, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(temporary, path);
      installed = true;
      fsyncDirectory(dirname(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) {
      rmSync(temporary);
      fsyncDirectory(dirname(path));
    }
  }
  if (installed) {
    await runtime.afterMarketplaceManifestInstalled?.(path, manifest);
  }
}

async function resolveMarketplaceInitialization(
  journalPath: string,
  runner: CommandRunner,
  resolveCredential: MarketplaceCredentialResolver,
  runtime: CreateAttemptWorkspaceRuntime = {},
): Promise<AttemptManifest> {
  const journal = readMarketplaceInitializationJournal(journalPath);
  const { manifest, request } = journal;
  const installed = classifyMarketplaceJournalManifest(journal);
  if (installed.status === 'terminal') {
    return retireMarketplaceInitializationJournal(journalPath, journal);
  }
  const credential = await resolveCredential(manifest.selectedLogin.toLowerCase());
  if (credential.normalizedLogin !== manifest.selectedLogin.toLowerCase()) {
    throw new Error('Marketplace credential does not match the recorded login');
  }
  materializeMarketplaceAttemptArtifacts(manifest, credential);
  const persistRequest = runtime.persistMarketplaceTaskRequest
    ?? persistMarketplaceTaskRequest;
  const verifyRequest = runtime.verifyMarketplaceTaskRequest
    ?? verifyMarketplaceTaskRequest;
  const persisted = persistRequest(
    manifest.execution.backend === 'marketplace'
      && 'requestPath' in manifest.execution.state
      ? manifest.execution.state.requestPath
      : '',
    request,
  );
  if (
    manifest.execution.backend !== 'marketplace'
    || (manifest.execution.state.schemaVersion !== MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
      && manifest.execution.state.schemaVersion !== MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION)
    || persisted.requestPath !== manifest.execution.state.requestPath
    || persisted.requestDigest !== manifest.execution.state.requestDigest
    || persisted.solverNetSelectionPath !== manifest.execution.state.solverNetSelectionPath
  ) {
    throw new Error('Marketplace request persistence did not match its journal');
  }
  const verified = verifyRequest(persisted.requestPath, persisted.requestDigest);
  if (!isDeepStrictEqual(verified, request)) {
    throw new Error('Marketplace request verification changed canonical request bytes');
  }
  await repairMarketplaceAttemptWorktree(manifest, runner);
  const beforeInstall = classifyMarketplaceJournalManifest(journal);
  if (beforeInstall.status === 'terminal') {
    return retireMarketplaceInitializationJournal(journalPath, journal);
  }
  if (beforeInstall.status === 'absent') {
    await runtime.beforeMarketplaceManifestInstall?.();
    await installPreparedMarketplaceManifest(manifest, runtime);
  }
  return retireMarketplaceInitializationJournal(journalPath, journal);
}

export async function recoverMarketplaceAttemptInitializations(
  v2Base: string,
  runner: CommandRunner,
  resolveCredential: MarketplaceCredentialResolver,
  runtime: CreateAttemptWorkspaceRuntime = {},
): Promise<readonly AttemptManifest[]> {
  if (!isAbsolute(v2Base)) {
    throw new Error('Marketplace initialization recovery base must be absolute');
  }
  const recovered: AttemptManifest[] = [];
  for (const runnerDir of directories(v2Base).sort()) {
    safeComponent(basename(runnerDir), 'runner ID');
    for (const phaseDir of directories(runnerDir).sort()) {
      const phase = basename(phaseDir);
      if (phase !== 'implement' && phase !== 'review') {
        throw new Error('Marketplace initialization journal is under an invalid phase');
      }
      const journals = readdirSync(phaseDir, { withFileTypes: true })
        .filter((entry) =>
          entry.name.endsWith(MARKETPLACE_INITIALIZATION_SUFFIX))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of journals) {
        if (!entry.isFile()) {
          throw new Error('Marketplace initialization journal is not a regular file');
        }
        const journalPath = join(phaseDir, entry.name);
        const journal = readMarketplaceInitializationJournal(journalPath);
        if (
          journal.manifest.runnerId !== basename(runnerDir)
          || journal.manifest.phase !== phase
        ) {
          throw new Error('Marketplace initialization journal path disagrees with manifest');
        }
        recovered.push(await resolveMarketplaceInitialization(
          journalPath,
          runner,
          resolveCredential,
          runtime,
        ));
      }
    }
  }
  return recovered;
}

export async function createAttemptWorkspace(
  options: CreateAttemptOptions,
  runner: CommandRunner,
  runtime: CreateAttemptWorkspaceRuntime = {},
): Promise<AttemptManifest> {
  if ((options.reviewGeneration === undefined) !== (options.reviewRefOid === undefined)) {
    throw new Error('Review generation and ref OID must appear together');
  }
  if (
    options.phase === 'review'
    && (
      options.reviewGeneration === undefined
      || options.reviewRefOid === undefined
      || options.reviewApprovalPolicy === undefined
    )
  ) {
    throw new Error('Review attempts require generation, ref OID, and approval policy');
  }
  if (options.phase !== 'review' && options.reviewApprovalPolicy !== undefined) {
    throw new Error('Review approval policy is valid only for review attempts');
  }
  if (!isAbsolute(options.repositoryPath) || !isAbsolute(options.worktreeBase)) {
    throw new Error('Attempt repository and worktree base must be absolute');
  }
  const attemptId = uuid(options.attemptId ?? randomUUID(), 'attempt ID');
  const runnerId = defaultRunnerId({ configured: options.runnerId });
  const marketplacePreparation = validateMarketplacePreparation(
    options,
    attemptId,
    runnerId,
  );
  const host = filesystemSafeHostname(options.host ?? systemHostname());
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  isoTimestamp(timestamp);
  const subject = safeComponent(options.subject, 'attempt subject');
  const repository = await readRepositoryIdentity(
    options.repositoryPath,
    options.remoteName ?? 'origin',
    runner,
  );
  const v2Base = join(options.worktreeBase, 'v2');
  const phaseDir = join(v2Base, runnerId, options.phase);
  const attemptDir = join(phaseDir, `${subject}-${attemptId}`);
  const paths: AttemptPaths = {
    attemptDir,
    worktree: join(attemptDir, 'worktree'),
    manifest: join(attemptDir, 'manifest.json'),
    log: join(attemptDir, 'session.log'),
    ghConfigDir: join(attemptDir, 'gh-config'),
    askpass: join(attemptDir, 'askpass'),
    tokenFile: join(attemptDir, 'gh-token'),
  };
  const buildManifest = (execution: AttemptExecution): AttemptManifest =>
    decodeAttemptManifest({
      version: 2,
      attemptId,
      runnerId,
      host,
      phase: options.phase,
      execution,
      subject,
      issueNumber: options.issueNumber,
      ...(options.prNumber === undefined ? {} : { prNumber: options.prNumber }),
      branch: options.branch,
      targetBase: options.targetBase,
      ...(options.targetBaseOid === undefined ? {} : { targetBaseOid: options.targetBaseOid }),
      expectedHead: options.expectedHead,
      claimOid: options.claimOid,
      ...(options.reviewGeneration === undefined
        ? {}
        : {
            reviewGeneration: options.reviewGeneration,
            reviewRefOid: options.reviewRefOid,
            reviewApprovalPolicy: options.reviewApprovalPolicy,
          }),
      selectedLogin: options.selectedLogin,
      repository,
      processState: options.pid === undefined || options.pid === null
        ? 'preparing'
        : 'running',
      pid: options.pid ?? null,
      paths,
      timestamps: {
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(options.pid === undefined || options.pid === null
          ? {}
          : { childStartedAt: timestamp }),
      },
    });
  let manifest = marketplacePreparation === undefined
    ? buildManifest(options.execution ?? { backend: 'local' })
    : (() => {
        const requestPath = join(paths.attemptDir, 'marketplace-request.json');
        const canonical = canonicalMarketplaceRequest(
          marketplacePreparation.request,
        );
        return buildManifest({
          backend: 'marketplace',
          state: {
            schemaVersion: MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION,
            status: 'prepared',
            requestPath,
            requestDigest: canonical.digest,
            solverNetSelectionPath: `${requestPath}.solvernet-selection.json`,
            preparedAt: timestamp,
            agentSoftDeadline: marketplacePreparation.agentSoftDeadline,
            adoptionDeadline: marketplacePreparation.adoptionDeadline,
          },
        });
      })();
  const registeredBefore = (await registeredWorktreePaths(
    repository.gitCommonDir,
    runner,
  )).some((path) =>
    canonicalProspectivePath(path) === canonicalProspectivePath(paths.worktree));
  if (registeredBefore) {
    throw new Error('Attempt worktree path is already registered');
  }
  await ensureExpectedHeadAvailable(runner, repository, {
    expectedHead: options.expectedHead,
    branch: options.branch,
    prNumber: options.prNumber,
  });
  mkdirSync(phaseDir, { recursive: true, mode: 0o700 });
  if (marketplacePreparation !== undefined) {
    const journal: MarketplaceAttemptInitializationJournal = {
      schemaVersion: MARKETPLACE_INITIALIZATION_SCHEMA_VERSION,
      request: marketplacePreparation.request,
      manifest,
    };
    const journalPath = marketplaceInitializationJournalPath(manifest);
    if (!existsSync(journalPath) && existsSync(manifest.paths.attemptDir)) {
      throw new Error('Marketplace attempt directory already exists');
    }
    installMarketplaceInitializationJournal(journalPath, journal);
    runtime.afterMarketplaceJournalInstalled?.(journalPath);
    return resolveMarketplaceInitialization(
      journalPath,
      runner,
      () => options.credential,
      runtime,
    );
  }
  mkdirSync(attemptDir, { mode: 0o700 });
  try {
    mkdirSync(paths.ghConfigDir, { mode: 0o700 });
    writeFileSync(paths.log, '', { mode: 0o600, flag: 'wx' });
    writeFileSync(paths.askpass, buildAskpassScript(paths.tokenFile), {
      mode: 0o700,
      flag: 'wx',
    });
    // Security note: this file (and gh-config/hosts.yml below) hold the raw
    // GH token in plaintext at rest. Any process running as this same OS user
    // could read it — an equivalent exposure to passing the token via
    // environment variables on this platform, not a regression. The
    // delegated-stage environment (run-stage.ts's
    // `buildUnprivilegedStageEnvironment`) deliberately keeps stage roots
    // pointed at a bogus `GH_CONFIG_DIR` and never forwards
    // `JINN_AUTOPILOT_SESSION_MANIFEST`, so stage children spawned by the
    // coordinator are not handed this file's location.
    writeFileSync(paths.tokenFile, `${options.credential.secret()}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    writeFileSync(
      join(paths.ghConfigDir, 'hosts.yml'),
      buildGhHostsYaml(options.selectedLogin, options.credential.secret()),
      { mode: 0o600, flag: 'wx' },
    );
    const preparedManifest = manifest;
    const writeManifest = runtime.writeManifest ?? writeManifestAtomic;
    writeManifest(paths.manifest, preparedManifest);
    if (!isDeepStrictEqual(readAttemptManifest(paths.manifest), preparedManifest)) {
      throw new Error('Attempt manifest verification failed after persistence');
    }
  } catch (error) {
    rmSync(paths.attemptDir, { recursive: true });
    fsyncDirectory(phaseDir);
    throw error;
  }
  try {
    await runner('git', [
      '-C', repository.root,
      'worktree', 'add', '--detach',
      paths.worktree,
      manifest!.expectedHead,
    ]);
  } catch (error) {
    try {
      await runner('git', [
        `--git-dir=${repository.gitCommonDir}`,
        'worktree', 'remove', paths.worktree,
      ]);
    } catch {
      // Registration may not have happened. Registry read-back below decides
      // whether exact local artifacts are safe to remove.
    }
    let registered = true;
    try {
      registered = (await registeredWorktreePaths(repository.gitCommonDir, runner))
        .some((path) =>
          canonicalProspectivePath(path) === canonicalProspectivePath(paths.worktree));
    } catch {
      // Retain the strict manifest rather than risk a manifestless registered
      // worktree when rollback read-back is ambiguous.
    }
    if (!registered) rmSync(paths.attemptDir, { recursive: true });
    throw error;
  }
  return manifest;
}

function sameManifestPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return left === right;
  }
}

function directories(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(path, entry.name));
}

export interface MarketplaceEvaluatorLegReviewCriteria {
  readonly originManifestPath: string;
  readonly originV2AttemptId: string;
  readonly originRequestDigest: string;
  readonly prNumber: number;
  readonly expectedHead: GitOid;
}

export function buildEvaluatorLegReviewPreparedExecution(
  attemptDir: string,
  originRequestDigest: string,
  now: () => Date = () => new Date(),
): AttemptExecution {
  const preparedAt = now().toISOString();
  isoTimestamp(preparedAt);
  const agentSoftDeadline = new Date(Date.parse(preparedAt) + 3_600_000).toISOString();
  const adoptionDeadline = new Date(Date.parse(preparedAt) + 7_200_000).toISOString();
  isoTimestamp(agentSoftDeadline);
  isoTimestamp(adoptionDeadline);
  return {
    backend: 'marketplace',
    state: {
      schemaVersion: MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION,
      status: 'prepared',
      requestPath: join(attemptDir, 'evaluator-leg.request.json'),
      requestDigest: originRequestDigest,
      solverNetSelectionPath: join(attemptDir, 'evaluator-leg.solvernet-selection.json'),
      preparedAt,
      agentSoftDeadline,
      adoptionDeadline,
    },
  };
}

export function findMarketplaceEvaluatorLegReviews(
  v2Base: string,
  criteria: MarketplaceEvaluatorLegReviewCriteria,
): AttemptManifest[] {
  const matches: AttemptManifest[] = [];
  if (!existsSync(v2Base)) return matches;
  for (const runnerDir of directories(v2Base)) {
    const reviewDir = join(runnerDir, 'review');
    for (const attemptDir of directories(reviewDir)) {
      const manifestPath = join(attemptDir, 'manifest.json');
      try {
        const manifest = readAttemptManifest(manifestPath);
        if (
          manifest.phase !== 'review'
          || manifest.execution.backend !== 'marketplace'
        ) continue;
        const state = manifest.execution.state;
        if (state.schemaVersion !== MARKETPLACE_EVALUATOR_LEG_SCHEMA_VERSION) continue;
        if (state.status === 'released') continue;
        if (
          state.originV2AttemptId === criteria.originV2AttemptId
          && state.originRequestDigest === criteria.originRequestDigest
          && state.prNumber === criteria.prNumber
          && state.expectedHead === criteria.expectedHead
          && (
            state.originManifestPath === criteria.originManifestPath
            || sameManifestPath(state.originManifestPath, criteria.originManifestPath)
          )
        ) {
          matches.push(manifest);
        }
      } catch {
        // Malformed manifests cannot prove a linked evaluator leg.
      }
    }
  }
  return matches;
}

export function findMarketplaceEvaluatorReviewByAttemptId(
  v2Base: string,
  attemptId: string,
): AttemptManifest | null {
  if (!existsSync(v2Base)) return null;
  for (const runnerDir of directories(v2Base)) {
    const reviewDir = join(runnerDir, 'review');
    for (const attemptDir of directories(reviewDir)) {
      const manifestPath = join(attemptDir, 'manifest.json');
      try {
        const manifest = readAttemptManifest(manifestPath);
        if (manifest.attemptId === attemptId && manifest.phase === 'review') {
          return manifest;
        }
      } catch {
        // Malformed manifests cannot prove a linked evaluator review.
      }
    }
  }
  return null;
}

export function anchorEvidenceFromEvaluatorManifest(
  manifest: AttemptManifest,
): MarketplaceReviewAnchorEvidence {
  if (
    manifest.execution.backend !== 'marketplace'
    || manifest.execution.state.schemaVersion !== MARKETPLACE_EVALUATOR_LEG_SCHEMA_VERSION
    || manifest.execution.state.status !== 'anchored'
    || manifest.reviewGeneration === undefined
    || manifest.reviewRefOid === undefined
  ) {
    throw new Error('Evaluator review manifest is not anchored');
  }
  const state = manifest.execution.state;
  return {
    attemptId: manifest.attemptId,
    manifestPath: manifest.paths.manifest,
    head: state.expectedHead,
    generation: state.generation,
    refOid: state.reviewRefOid,
    reviewer: state.reviewer,
    anchoredAt: state.anchoredAt,
  };
}

export function countRunnerLiveAttempts(
  v2Base: string,
  runnerId: string,
  isPidAlive: (pid: number) => boolean,
): number {
  return listRunnerLiveAttempts(v2Base, runnerId, isPidAlive).length;
}

export function listRunnerLiveAttempts(
  v2Base: string,
  runnerId: string,
  isPidAlive: (pid: number) => boolean,
): AttemptManifest[] {
  safeComponent(runnerId, 'runner ID');
  const runnerDir = join(v2Base, runnerId);
  const attempts: AttemptManifest[] = [];
  for (const phaseDir of directories(runnerDir)) {
    for (const attemptDir of directories(phaseDir)) {
      const manifestPath = join(attemptDir, 'manifest.json');
      try {
        const manifest = readAttemptManifest(manifestPath);
        if (
          manifest.runnerId === runnerId
          && isRunnerLiveAttempt(manifest, isPidAlive)
        ) {
          attempts.push(manifest);
        }
      } catch {
        // A malformed manifest cannot prove a live child and never affects
        // another runner's local capacity accounting.
      }
    }
  }
  return attempts;
}

function isRunnerLiveAttempt(
  manifest: AttemptManifest,
  isPidAlive: (pid: number) => boolean,
): boolean {
  if (
    manifest.execution.backend === 'marketplace'
    && manifest.execution.state.schemaVersion === MARKETPLACE_EVALUATOR_LEG_SCHEMA_VERSION
  ) {
    return manifest.execution.state.status === 'anchored';
  }
  if (
    manifest.execution.backend === 'marketplace'
    && (manifest.execution.state.schemaVersion === MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
      || manifest.execution.state.schemaVersion === MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION)
  ) {
    return manifest.execution.state.status === 'prepared'
      || manifest.execution.state.status === 'submitted';
  }
  return manifest.processState === 'preparing'
    || (
      manifest.processState === 'running'
      && manifest.pid !== null
      && isPidAlive(manifest.pid)
    );
}

export type CleanupReasonCode =
  | 'live'
  | 'dirty'
  | 'ahead'
  | 'missing-object'
  | 'authentication-failed'
  | 'malformed'
  | 'escaped-path'
  | 'ambiguous';

export type AttemptCleanupResult =
  | { readonly status: 'removed'; readonly attemptId: string }
  | { readonly status: 'already-removed'; readonly attemptId: string }
  | {
      readonly status: 'retained';
      readonly attemptId?: string;
      readonly reason: {
        readonly code: CleanupReasonCode;
        readonly detail: string;
      };
    };

export interface CleanupAttemptOptions {
  readonly v2Base: string;
  readonly isPidAlive: (pid: number) => boolean;
  readonly env?: Record<string, string>;
  /** Grace period before dead dirty/ahead/preparing attempts may be removed. */
  readonly graceMs?: number;
  readonly now?: () => Date;
  /** When true, skip grace and publication proof for dead attempts. */
  readonly evictUnpublished?: boolean;
}

export function freeDiskBytes(path: string): number {
  let existingPath = resolve(path);
  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) break;
    existingPath = parent;
  }
  const stats = statfsSync(existingPath);
  return Number(stats.bavail) * Number(stats.bsize);
}

function attemptEndedAtMs(manifest: AttemptManifest): number {
  const timestamp = manifest.timestamps.childExitedAt
    ?? manifest.timestamps.updatedAt
    ?? manifest.timestamps.createdAt;
  return Date.parse(timestamp);
}

function graceAllowsForceRemoval(
  manifest: AttemptManifest,
  options: CleanupAttemptOptions,
): boolean {
  if (options.evictUnpublished === true) return true;
  const graceMs = options.graceMs;
  if (graceMs === undefined) return false;
  const now = options.now?.() ?? new Date();
  return now.getTime() - attemptEndedAtMs(manifest) >= graceMs;
}

function isAttemptChildLive(
  manifest: AttemptManifest,
  isPidAlive: (pid: number) => boolean,
): boolean {
  return manifest.processState === 'running'
    && manifest.pid !== null
    && isPidAlive(manifest.pid);
}

function retained(
  code: CleanupReasonCode,
  detail: string,
  attemptId?: string,
): AttemptCleanupResult {
  return {
    status: 'retained',
    ...(attemptId === undefined ? {} : { attemptId }),
    reason: { code, detail },
  };
}

function removeAttemptMetadata(manifest: AttemptManifest): AttemptCleanupResult {
  try {
    rmSync(manifest.paths.attemptDir, { recursive: true });
    return { status: 'removed', attemptId: manifest.attemptId };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'already-removed', attemptId: manifest.attemptId };
    }
    return retained(
      'ambiguous',
      'Exact attempt metadata removal failed.',
      manifest.attemptId,
    );
  }
}

function isBelow(base: string, target: string): boolean {
  const normalizedBase = resolve(base);
  const normalizedTarget = resolve(target);
  return normalizedTarget.startsWith(`${normalizedBase}${sep}`);
}

function expectedPaths(v2Base: string, manifest: AttemptManifest): AttemptPaths {
  const attemptDir = join(
    resolve(v2Base),
    manifest.runnerId,
    manifest.phase,
    `${manifest.subject}-${manifest.attemptId}`,
  );
  return {
    attemptDir,
    worktree: join(attemptDir, 'worktree'),
    manifest: join(attemptDir, 'manifest.json'),
    log: join(attemptDir, 'session.log'),
    ghConfigDir: join(attemptDir, 'gh-config'),
    askpass: join(attemptDir, 'askpass'),
    tokenFile: join(attemptDir, 'gh-token'),
  };
}

function pathsAgree(
  manifestPath: string,
  manifest: AttemptManifest,
  v2Base: string,
): boolean {
  const expected = expectedPaths(v2Base, manifest);
  if (!samePaths(expected, manifest.paths)) return false;
  if (resolve(manifestPath) !== expected.manifest) return false;
  if (!isBelow(v2Base, expected.attemptDir)) return false;
  try {
    const realAttemptDir = realpathSync(expected.attemptDir);
    const realBase = realpathSync(resolve(v2Base));
    if (
      !isBelow(realBase, realAttemptDir)
      || lstatSync(expected.attemptDir).isSymbolicLink()
      || !lstatSync(expected.attemptDir).isDirectory()
    ) {
      return false;
    }
    for (const file of [
      expected.manifest,
      expected.log,
      expected.askpass,
      expected.tokenFile,
    ]) {
      const info = lstatSync(file);
      if (info.isSymbolicLink() || !info.isFile()) return false;
      if (!isBelow(realAttemptDir, realpathSync(file))) return false;
    }
    const configInfo = lstatSync(expected.ghConfigDir);
    if (configInfo.isSymbolicLink() || !configInfo.isDirectory()) return false;
    if (!isBelow(realAttemptDir, realpathSync(expected.ghConfigDir))) return false;
    if (existsSync(expected.worktree)) {
      const worktreeInfo = lstatSync(expected.worktree);
      if (worktreeInfo.isSymbolicLink() || !worktreeInfo.isDirectory()) return false;
      if (!isBelow(realAttemptDir, realpathSync(expected.worktree))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function authFailure(error: unknown): boolean {
  return /auth|credential|permission denied|could not read username|terminal prompts disabled/i
    .test(String(error));
}

function cleanupGitEnvironment(
  manifest: AttemptManifest,
  options: CleanupAttemptOptions,
): Record<string, string> {
  return {
    ...sanitizedGitHubCommandOverlay(process.env, options.env),
    ...isolatedGitCommandOverlay(process.env, manifest.paths.askpass),
    GH_CONFIG_DIR: manifest.paths.ghConfigDir,
  };
}

async function provePublicationReachability(
  manifest: AttemptManifest,
  runner: CommandRunner,
  options: CleanupAttemptOptions,
  gitContext: readonly string[],
  localHeadSpec: string,
): Promise<AttemptCleanupResult | null> {
  try {
    await runner('git', [
      ...gitPublicationArgs(manifest.paths.askpass, []),
      ...gitContext,
      'fetch', '--quiet', manifest.repository.remoteName,
      `${manifest.branch}:refs/remotes/${manifest.repository.remoteName}/${manifest.branch}`,
    ], {
      env: cleanupGitEnvironment(manifest, options),
    });
  } catch (error) {
    return retained(
      authFailure(error) ? 'authentication-failed' : 'ambiguous',
      authFailure(error)
        ? 'Remote publication ref could not be authenticated.'
        : 'Remote publication ref could not be refreshed.',
      manifest.attemptId,
    );
  }

  let head: string;
  let remoteHead: string;
  try {
    head = (await runner('git', [
      ...gitContext,
      'rev-parse', '--verify', `${localHeadSpec}^{commit}`,
    ])).trim();
    remoteHead = (await runner('git', [
      ...gitContext,
      'rev-parse', '--verify',
      `refs/remotes/${manifest.repository.remoteName}/${manifest.branch}^{commit}`,
    ])).trim();
    gitOid(head);
    gitOid(remoteHead);
  } catch {
    return retained(
      'missing-object',
      'Recorded local HEAD or expected remote publication object is missing.',
      manifest.attemptId,
    );
  }

  try {
    await runner('git', [
      ...gitContext,
      'merge-base', '--is-ancestor', head, remoteHead,
    ]);
  } catch {
    return retained(
      'ahead',
      'Recorded local HEAD is not reachable from the expected remote publication ref.',
      manifest.attemptId,
    );
  }
  return null;
}

async function removeAttemptWorktree(
  manifest: AttemptManifest,
  runner: CommandRunner,
  force: boolean,
): Promise<AttemptCleanupResult | null> {
  if (!existsSync(manifest.paths.worktree)) return null;
  try {
    await runner('git', [
      `--git-dir=${manifest.repository.gitCommonDir}`,
      'worktree',
      'remove',
      ...(force ? ['--force'] : []),
      manifest.paths.worktree,
    ]);
    return null;
  } catch {
    return retained(
      'ambiguous',
      force
        ? 'Exact worktree force-removal failed.'
        : 'Exact worktree removal failed.',
      manifest.attemptId,
    );
  }
}

export async function cleanupAttempt(
  manifestPath: string,
  runner: CommandRunner,
  options: CleanupAttemptOptions,
): Promise<AttemptCleanupResult> {
  let manifest: AttemptManifest;
  try {
    manifest = readAttemptManifest(manifestPath);
  } catch {
    return retained('malformed', 'Attempt manifest could not be strictly decoded.');
  }
  if (!pathsAgree(manifestPath, manifest, options.v2Base)) {
    return retained(
      'escaped-path',
      'Manifest path or attempt identity does not match the exact v2 attempt directory.',
      manifest.attemptId,
    );
  }
  if (manifest.processState === 'preparing') {
    if (!graceAllowsForceRemoval(manifest, options)) {
      return retained(
        'ambiguous',
        'Attempt is still preparing and has no positive terminal process evidence.',
        manifest.attemptId,
      );
    }
  } else if (manifest.processState === 'running') {
    if (manifest.pid === null) {
      return retained(
        'ambiguous',
        'Running attempt has no recorded child PID.',
        manifest.attemptId,
      );
    }
    if (options.isPidAlive(manifest.pid)) {
      return retained('live', 'Attempt child PID is still live.', manifest.attemptId);
    }
    markAttemptExited(manifestPath);
    manifest = readAttemptManifest(manifestPath);
  }
  let actualRepository: AttemptRepositoryIdentity;
  try {
    actualRepository = await readRepositoryIdentity(
      manifest.repository.root,
      manifest.repository.remoteName,
      runner,
    );
  } catch {
    return retained(
      'ambiguous',
      'Creating repository identity could not be re-established.',
      manifest.attemptId,
    );
  }
  if (!sameRepositoryIdentity(actualRepository, manifest.repository)) {
    return retained(
      'ambiguous',
      'Creating repository identity no longer matches the attempt manifest.',
      manifest.attemptId,
    );
  }
  if (existsSync(manifest.paths.worktree)) {
    try {
      const worktreeCommonDir = canonicalDirectory((await runner('git', [
        '-C', manifest.paths.worktree,
        'rev-parse', '--path-format=absolute', '--git-common-dir',
      ])).trim(), 'worktree Git common directory');
      if (worktreeCommonDir !== manifest.repository.gitCommonDir) {
        return retained(
          'ambiguous',
          'Attempt worktree belongs to a different Git common directory.',
          manifest.attemptId,
        );
      }
    } catch {
      return retained(
        'ambiguous',
        'Attempt worktree repository identity could not be proven.',
        manifest.attemptId,
      );
    }
  }
  if (!existsSync(manifest.paths.worktree)) {
    if (manifest.terminalHead === undefined) {
      if (!graceAllowsForceRemoval(manifest, options)) {
        return retained(
          'ambiguous',
          'Missing worktree has no recorded terminal HEAD.',
          manifest.attemptId,
        );
      }
      return removeAttemptMetadata(manifest);
    }
    let registered: boolean;
    try {
      registered = (await registeredWorktreePaths(
        manifest.repository.gitCommonDir,
        runner,
      )).some((path) =>
        canonicalProspectivePath(path) === canonicalProspectivePath(manifest.paths.worktree));
    } catch {
      return retained(
        'ambiguous',
        'Missing worktree could not be checked against the Git worktree registry.',
        manifest.attemptId,
      );
    }
    if (registered) {
      if (!graceAllowsForceRemoval(manifest, options)) {
        return retained(
          'ambiguous',
          'Missing worktree remains registered in the creating repository.',
          manifest.attemptId,
        );
      }
      const worktreeFailure = await removeAttemptWorktree(manifest, runner, true);
      if (worktreeFailure !== null) return worktreeFailure;
      return removeAttemptMetadata(manifest);
    }
    if (!graceAllowsForceRemoval(manifest, options)) {
      const proofFailure = await provePublicationReachability(
        manifest,
        runner,
        options,
        [`--git-dir=${manifest.repository.gitCommonDir}`],
        manifest.terminalHead,
      );
      if (proofFailure !== null) return proofFailure;
    }
    return removeAttemptMetadata(manifest);
  }

  const forceRemoval = graceAllowsForceRemoval(manifest, options);
  if (!forceRemoval) {
    try {
      const status = await runner('git', [
        '-C', manifest.paths.worktree,
        'status', '--porcelain', '--untracked-files=all',
      ]);
      if (status.trim() !== '') {
        return retained('dirty', 'Worktree contains uncommitted changes.', manifest.attemptId);
      }
    } catch {
      return retained('ambiguous', 'Git cleanliness inspection failed.', manifest.attemptId);
    }
  }

  if (!forceRemoval) {
    const proofFailure = await provePublicationReachability(
      manifest,
      runner,
      options,
      ['-C', manifest.paths.worktree],
      'HEAD',
    );
    if (proofFailure !== null) return proofFailure;
  }

  const worktreeFailure = await removeAttemptWorktree(manifest, runner, forceRemoval);
  if (worktreeFailure !== null) return worktreeFailure;
  return removeAttemptMetadata(manifest);
}

export interface SweepDeadAttemptsOptions extends CleanupAttemptOptions {
  readonly host?: string;
  readonly diskFloorBytes?: number;
  readonly diskPath?: string;
  readonly readFreeDiskBytes?: (path: string) => number;
}

interface CollectedAttempt {
  readonly manifestPath: string;
  readonly manifest: AttemptManifest;
}

function collectHostedAttempts(v2Base: string, host: string): CollectedAttempt[] {
  const attempts: CollectedAttempt[] = [];
  for (const runnerDir of directories(v2Base)) {
    for (const phaseDir of directories(runnerDir)) {
      for (const attemptDir of directories(phaseDir)) {
        const manifestPath = join(attemptDir, 'manifest.json');
        try {
          const manifest = readAttemptManifest(manifestPath);
          if (manifest.host !== host) continue;
          attempts.push({ manifestPath, manifest });
        } catch {
          // Malformed manifests are handled by the orphan sweep.
        }
      }
    }
  }
  return attempts;
}

function sweepOrphanAttemptDirs(
  v2Base: string,
  graceMs: number | undefined,
  now: () => Date,
): AttemptCleanupResult[] {
  if (graceMs === undefined) return [];
  const results: AttemptCleanupResult[] = [];
  const cutoff = now().getTime() - graceMs;
  for (const runnerDir of directories(v2Base)) {
    for (const phaseDir of directories(runnerDir)) {
      for (const attemptDir of directories(phaseDir)) {
        if (!isBelow(v2Base, attemptDir)) continue;
        const manifestPath = join(attemptDir, 'manifest.json');
        try {
          readAttemptManifest(manifestPath);
          continue;
        } catch {
          // Orphan candidate.
        }
        try {
          if (statSync(attemptDir).mtimeMs >= cutoff) {
            results.push(retained(
              'malformed',
              'Malformed attempt directory is still inside the grace period.',
            ));
            continue;
          }
          rmSync(attemptDir, { recursive: true });
          results.push({
            status: 'removed',
            attemptId: basename(attemptDir),
          });
        } catch {
          results.push(retained(
            'malformed',
            'Malformed attempt directory could not be removed.',
          ));
        }
      }
    }
  }
  return results;
}

export async function sweepDeadAttempts(
  runner: CommandRunner,
  options: SweepDeadAttemptsOptions,
): Promise<AttemptCleanupResult[]> {
  const host = filesystemSafeHostname(options.host ?? systemHostname());
  const results: AttemptCleanupResult[] = [];
  const diskPath = options.diskPath ?? options.v2Base;
  const diskFloorBytes = options.diskFloorBytes;
  const readFreeDiskBytes = options.readFreeDiskBytes ?? freeDiskBytes;

  if (
    diskFloorBytes !== undefined
    && diskFloorBytes > 0
    && readFreeDiskBytes(diskPath) < diskFloorBytes
  ) {
    const deadAttempts = collectHostedAttempts(options.v2Base, host)
      .filter((attempt) => !isAttemptChildLive(attempt.manifest, options.isPidAlive))
      .sort((left, right) =>
        attemptEndedAtMs(left.manifest) - attemptEndedAtMs(right.manifest));
    for (const attempt of deadAttempts) {
      if (readFreeDiskBytes(diskPath) >= diskFloorBytes) break;
      try {
        results.push(await cleanupAttempt(attempt.manifestPath, runner, {
          ...options,
          evictUnpublished: true,
        }));
      } catch {
        results.push(retained(
          'ambiguous',
          'Emergency disk-floor attempt cleanup failed unexpectedly and was isolated.',
          attempt.manifest.attemptId,
        ));
      }
    }
  }

  for (const runnerDir of directories(options.v2Base)) {
    for (const phaseDir of directories(runnerDir)) {
      for (const attemptDir of directories(phaseDir)) {
        const manifestPath = join(attemptDir, 'manifest.json');
        let manifest: AttemptManifest;
        try {
          manifest = readAttemptManifest(manifestPath);
          if (manifest.host !== host) continue;
        } catch {
          results.push(retained('malformed', 'Attempt manifest could not be strictly decoded.'));
          continue;
        }
        try {
          results.push(await cleanupAttempt(manifestPath, runner, options));
        } catch {
          results.push(retained(
            'ambiguous',
            'Attempt cleanup failed unexpectedly and was isolated.',
            manifest.attemptId,
          ));
        }
      }
    }
  }
  results.push(...sweepOrphanAttemptDirs(
    options.v2Base,
    options.graceMs,
    options.now ?? (() => new Date()),
  ));
  return results;
}
