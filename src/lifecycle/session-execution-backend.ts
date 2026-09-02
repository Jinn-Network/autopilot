import type { SpawnResult } from '../dispatcher/coordinator-session.js';
import type { AutopilotExecutionBackend } from '../config/execution-backend.js';
import {
  existsSync,
  readdirSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
} from 'node:path';
import type {
  TaskSubmitRequestV1,
  TaskSubmitResultV1,
} from '@jinn-network/sdk/autopilot';
import {
  defaultRunner,
  type CommandRunner,
} from '../dispatcher/issue-source.js';
import {
  claimMarketplaceAttemptProcess,
  claimMarketplaceDispatchDecision,
  findMarketplaceEvaluatorLegReviews,
  markAttemptExited,
  MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION,
  proveMarketplaceAttemptWorktree,
  readAttemptManifest,
  reconcileMarketplaceTerminalEvidence,
  transitionMarketplaceExecution,
  type AttemptManifest,
} from './attempt-workspace.js';
import {
  marketplaceStatus,
  upgradeMarketplaceExecutionV2,
} from './marketplace-adoption-state.js';
import { MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION } from './marketplace-execution-state.js';
import type { MarketplaceReviewAnchorEvidence } from './marketplace-execution-state.js';
import type { MarketplaceMutationAdoptionCoordinator } from './marketplace-mutation-adoption.js';
import {
  MARKETPLACE_LANGUAGE,
  MARKETPLACE_REPOSITORY,
  MARKETPLACE_VERIFICATION_PROFILE,
  MarketplaceTaskCliAdapter,
  verifyMarketplaceTaskRequest,
} from './marketplace-task.js';
import { gitOid } from './types.js';

/**
 * The non-secret session identity shared by local and marketplace backends.
 * `local` launch data is intentionally absent so a marketplace backend never
 * receives the sanitized child environment containing GitHub credentials.
 */
interface SessionExecutionRequestBase {
  readonly manifestPath: string;
  readonly attemptId: string;
  readonly issueNumber: number;
  readonly prNumber: number;
  readonly branch: string;
  readonly targetBase: string;
  readonly worktreePath: string;
  readonly logPath: string;
}

export interface ImplementationSessionExecutionRequest
  extends SessionExecutionRequestBase {
  readonly kind: 'implementation';
  /** Non-secret workflow identity used for routing and stable diagnostics. */
  readonly workflow:
    | 'implementation'
    | 'review-finding'
    | 'reconcile'
    | 'ci-failure';
}

export interface ExactHeadReviewSessionExecutionRequest
  extends SessionExecutionRequestBase {
  readonly kind: 'exact-head-review';
  /** Exact head that the review claim fenced and the marketplace must review. */
  readonly reviewedHead: string;
  /** Non-secret selected reviewer identity; never a credential or token. */
  readonly reviewerLogin: string;
  /**
   * Non-blocking follow-ups already open against this PR, so the session does
   * not re-derive a finding that is already filed (#124).
   *
   * Numbers and titles only, never bodies: an index of what exists, not its
   * content. Capped at `MAX_REVIEW_FOLLOW_UP_CONTEXT`, with
   * {@link ExactHeadReviewSessionExecutionRequest.openFollowUpTotal} carrying
   * the true count so a capped list is never read as a complete one.
   *
   * Absent and empty mean different things, which is why this is optional
   * rather than defaulted: `[]` is "we looked and there are none", absence is
   * "this build did not look". A build with no follow-up reader must not be
   * able to tell the reviewer that a PR carrying seventeen open follow-ups has
   * none.
   */
  readonly openFollowUps?: readonly {
    readonly number: number;
    readonly title: string;
  }[];
  /** Open follow-ups observed, which may exceed what `openFollowUps` carries. */
  readonly openFollowUpTotal?: number;
}

/**
 * Local-only launch data. Task 4 will supply the existing executor spawn
 * inputs here, including their already-sanitized per-attempt environment.
 */
export type LocalSessionExecutionRequest<
  ImplementationSpawnInput = unknown,
  ReviewSpawnInput = unknown,
> =
  | (ImplementationSessionExecutionRequest & {
      readonly backend: 'local';
      readonly local: { readonly spawnInput: ImplementationSpawnInput };
    })
  | (ExactHeadReviewSessionExecutionRequest & {
      readonly backend: 'local';
      readonly local: { readonly spawnInput: ReviewSpawnInput };
    });

export type LocalImplementationSessionExecutionRequest<
  ImplementationSpawnInput = unknown,
> = Extract<
  LocalSessionExecutionRequest<ImplementationSpawnInput, never>,
  { readonly kind: 'implementation' }
>;

export type LocalExactHeadReviewSessionExecutionRequest<
  ReviewSpawnInput = unknown,
> = Extract<
  LocalSessionExecutionRequest<never, ReviewSpawnInput>,
  { readonly kind: 'exact-head-review' }
>;

/**
 * Credential-free request surface used by the marketplace adapter. The
 * `local?: never` discriminator prevents a local launch payload from being
 * structurally passed to this backend.
 */
export type MarketplaceSessionExecutionRequest =
  | (ImplementationSessionExecutionRequest & {
      readonly backend: 'marketplace';
      readonly local?: never;
    })
  | (ExactHeadReviewSessionExecutionRequest & {
      readonly backend: 'marketplace';
      readonly local?: never;
    });

export type SessionExecutionRequest =
  | LocalSessionExecutionRequest
  | MarketplaceSessionExecutionRequest;

export type SessionExecutionResult =
  | {
      readonly status: 'started';
      readonly backend: 'local';
      readonly pid: number;
    }
  | {
      readonly status: 'unsupported';
      readonly backend: 'local';
      readonly operation: 'recover' | 'cancel';
    }
  | {
      readonly status: 'unavailable';
      readonly backend: 'marketplace';
      readonly detail: string;
    }
  | {
      readonly status: 'started';
      readonly backend: 'marketplace';
      readonly id: string;
      readonly taskId: string;
      readonly taskCid: string;
    }
  | {
      readonly status: 'cancelled';
      readonly backend: 'marketplace';
      readonly reason: string;
    };

export interface SessionExecutionBackend<
  Backend extends AutopilotExecutionBackend,
  Request extends SessionExecutionRequest & { readonly backend: Backend },
> {
  readonly backend: Backend;
  start(request: Request): Promise<SessionExecutionResult>;
  recover(request: Request): Promise<SessionExecutionResult>;
  cancel(request: Request): Promise<SessionExecutionResult>;
}

/**
 * The only local capabilities the adapter needs. Marketplace construction
 * cannot receive this object, keeping the local process and tracking ports
 * out of its implementation.
 */
export interface LocalSessionExecutionCapabilities<
  ImplementationSpawnInput = unknown,
  ReviewSpawnInput = unknown,
  Child extends SpawnResult = SpawnResult,
> {
  readonly spawnImplementation: (input: ImplementationSpawnInput) => Child;
  readonly spawnExactHeadReview: (input: ReviewSpawnInput) => Child;
  readonly trackChild: (manifestPath: string, child: Child) => void;
}

export class LocalSessionExecutionBackend<
  ImplementationSpawnInput = unknown,
  ReviewSpawnInput = unknown,
  Child extends SpawnResult = SpawnResult,
> implements SessionExecutionBackend<
  'local',
  LocalSessionExecutionRequest<ImplementationSpawnInput, ReviewSpawnInput>
> {
  readonly backend = 'local' as const;

  constructor(
    private readonly capabilities: LocalSessionExecutionCapabilities<
      ImplementationSpawnInput,
      ReviewSpawnInput,
      Child
    >,
  ) {}

  async start(
    request: LocalSessionExecutionRequest<ImplementationSpawnInput, ReviewSpawnInput>,
  ): Promise<SessionExecutionResult> {
    const child = request.kind === 'implementation'
      ? this.capabilities.spawnImplementation(request.local.spawnInput)
      : this.capabilities.spawnExactHeadReview(request.local.spawnInput);
    if (child.pid === undefined) {
      throw new Error(
        request.kind === 'implementation'
          ? request.workflow === 'implementation'
            ? 'Implementation coordinator did not report a child PID'
            : 'Child coordinator did not report a child PID'
          : 'Review coordinator did not report a child PID',
      );
    }
    this.capabilities.trackChild(request.manifestPath, child);
    return { status: 'started', backend: 'local', pid: child.pid };
  }

  async recover(
    _request: LocalSessionExecutionRequest<ImplementationSpawnInput, ReviewSpawnInput>,
  ): Promise<SessionExecutionResult> {
    // Existing recovery derives sessions from attempts/worktrees; it has no
    // per-child backend operation to invoke.
    return { status: 'unsupported', backend: 'local', operation: 'recover' };
  }

  async cancel(
    _request: LocalSessionExecutionRequest<ImplementationSpawnInput, ReviewSpawnInput>,
  ): Promise<SessionExecutionResult> {
    // Existing local sessions have no safe per-session cancellation protocol.
    return { status: 'unsupported', backend: 'local', operation: 'cancel' };
  }
}

export const MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL =
  'Marketplace session submission and adoption are not enabled yet.';
export const MARKETPLACE_REVIEW_UNAVAILABLE_DETAIL =
  'Marketplace exact-head review submission is not enabled in this slice.';
export const MARKETPLACE_CANCEL_INTENT_REASON = 'operator-cancelled';

export interface MarketplaceTaskSubmissionAdapter {
  submit(requestPath: string): Promise<TaskSubmitResultV1>;
  recover(requestPath: string): Promise<TaskSubmitResultV1>;
}

export interface MarketplaceSessionExecutionBackendOptions {
  readonly adapter?: MarketplaceTaskSubmissionAdapter;
  readonly readAttemptManifest?: typeof readAttemptManifest;
  readonly verifyMarketplaceTaskRequest?: typeof verifyMarketplaceTaskRequest;
  readonly claimMarketplaceDispatchDecision?: typeof claimMarketplaceDispatchDecision;
  readonly claimMarketplaceAttemptProcess?: typeof claimMarketplaceAttemptProcess;
  readonly reconcileMarketplaceTerminalEvidence?: typeof reconcileMarketplaceTerminalEvidence;
  readonly transitionMarketplaceExecution?: typeof transitionMarketplaceExecution;
  readonly runner?: CommandRunner;
  readonly processPid?: number;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly now?: () => Date;
}

interface VerifiedMarketplaceExecution {
  readonly manifest: AttemptManifest;
  readonly request: TaskSubmitRequestV1;
  readonly state: Extract<
    AttemptManifest['execution'],
    { readonly backend: 'marketplace' }
  >['state'] & {
    readonly schemaVersion:
      | typeof MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
      | typeof MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION;
  };
}

export class MarketplaceSessionExecutionBackend
  implements SessionExecutionBackend<'marketplace', MarketplaceSessionExecutionRequest> {
  readonly backend = 'marketplace' as const;
  private readonly adapter: MarketplaceTaskSubmissionAdapter;
  private readonly readManifest: typeof readAttemptManifest;
  private readonly verifyRequest: typeof verifyMarketplaceTaskRequest;
  private readonly claimDispatch: typeof claimMarketplaceDispatchDecision;
  private readonly claimProcess: typeof claimMarketplaceAttemptProcess;
  private readonly reconcileTerminal: typeof reconcileMarketplaceTerminalEvidence;
  private readonly transition: typeof transitionMarketplaceExecution;
  private readonly runner: CommandRunner;
  private readonly processPid: number | undefined;
  private readonly isPidAlive: ((pid: number) => boolean) | undefined;
  private readonly now: () => Date;

  constructor(options: MarketplaceSessionExecutionBackendOptions = {}) {
    this.adapter = options.adapter ?? new MarketplaceTaskCliAdapter({});
    this.readManifest = options.readAttemptManifest ?? readAttemptManifest;
    this.verifyRequest =
      options.verifyMarketplaceTaskRequest ?? verifyMarketplaceTaskRequest;
    this.claimDispatch =
      options.claimMarketplaceDispatchDecision ?? claimMarketplaceDispatchDecision;
    this.claimProcess =
      options.claimMarketplaceAttemptProcess ?? claimMarketplaceAttemptProcess;
    this.reconcileTerminal =
      options.reconcileMarketplaceTerminalEvidence
      ?? reconcileMarketplaceTerminalEvidence;
    this.transition =
      options.transitionMarketplaceExecution ?? transitionMarketplaceExecution;
    this.runner = options.runner ?? defaultRunner;
    this.processPid = options.processPid;
    this.isPidAlive = options.isPidAlive;
    this.now = options.now ?? (() => new Date());
  }

  async start(request: MarketplaceSessionExecutionRequest): Promise<SessionExecutionResult> {
    let verified = this.reconciledExecution(request);
    if (verified.state.status !== 'prepared') {
      throw new Error('Marketplace start requires a prepared marketplace execution');
    }
    await proveMarketplaceAttemptWorktree(verified.manifest, this.runner);
    verified = this.reconciledExecution(request);
    if (verified.state.status === 'cancelled') {
      throw new Error('Cannot start a cancelled marketplace execution');
    }
    if (verified.state.status !== 'prepared') {
      throw new Error('Marketplace start requires a prepared marketplace execution');
    }
    return this.submitAndPersist(request, verified, 'submit');
  }

  async recover(request: MarketplaceSessionExecutionRequest): Promise<SessionExecutionResult> {
    let verified = this.reconciledExecution(request);
    if (verified.state.status === 'submitted') {
      return this.startedIdentity(verified.manifest);
    }
    if (verified.state.status === 'cancelled') {
      throw new Error('Cannot recover a cancelled marketplace execution');
    }
    if (verified.state.status !== 'prepared') {
      throw new Error('Marketplace recovery requires a prepared marketplace execution');
    }
    await proveMarketplaceAttemptWorktree(verified.manifest, this.runner);
    verified = this.reconciledExecution(request);
    if (verified.state.status === 'submitted') {
      return this.startedIdentity(verified.manifest);
    }
    if (verified.state.status === 'cancelled') {
      throw new Error('Cannot recover a cancelled marketplace execution');
    }
    if (verified.state.status !== 'prepared') {
      throw new Error('Marketplace recovery requires a prepared marketplace execution');
    }
    return this.submitAndPersist(request, verified, 'recover');
  }

  async cancel(request: MarketplaceSessionExecutionRequest): Promise<SessionExecutionResult> {
    const verified = this.reconciledExecution(request);
    if (verified.state.status !== 'prepared') {
      throw new Error('Marketplace cancellation requires a prepared marketplace execution');
    }
    this.transition(
      request.manifestPath,
      verified.state.requestDigest,
      { status: 'cancelled', reason: MARKETPLACE_CANCEL_INTENT_REASON },
      this.now,
    );
    return {
      status: 'cancelled',
      backend: 'marketplace',
      reason: MARKETPLACE_CANCEL_INTENT_REASON,
    };
  }

  private reconciledExecution(
    request: MarketplaceSessionExecutionRequest,
  ): VerifiedMarketplaceExecution {
    this.reconcileTerminal(request.manifestPath);
    return this.verifiedExecution(request);
  }

  private verifiedExecution(
    request: MarketplaceSessionExecutionRequest,
  ): VerifiedMarketplaceExecution {
    if (request.kind !== 'implementation') {
      throw new Error(MARKETPLACE_REVIEW_UNAVAILABLE_DETAIL);
    }
    const manifest = this.readManifest(request.manifestPath);
    if (
      manifest.execution.backend !== 'marketplace'
      || (manifest.execution.state.schemaVersion
        !== MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
        && manifest.execution.state.schemaVersion
          !== MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION)
    ) {
      throw new Error('Marketplace execution requires a version-2 or version-3 marketplace attempt');
    }
    const state = manifest.execution.state;
    const expectedRequestPath = join(
      dirname(request.manifestPath),
      'marketplace-request.json',
    );
    if (
      state.requestPath !== expectedRequestPath
      || state.solverNetSelectionPath
        !== `${expectedRequestPath}.solvernet-selection.json`
    ) {
      throw new Error('Marketplace execution request path escaped its attempt');
    }
    let taskRequest: TaskSubmitRequestV1;
    try {
      taskRequest = this.verifyRequest(
        state.requestPath,
        state.requestDigest,
      );
    } catch (error) {
      throw new Error(
        `Marketplace Task request verification failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    if (
      taskRequest.spec.repo !== MARKETPLACE_REPOSITORY
      || taskRequest.spec.language !== MARKETPLACE_LANGUAGE
      || taskRequest.spec.verificationProfile
        !== MARKETPLACE_VERIFICATION_PROFILE
    ) {
      throw new Error(
        `Marketplace Task submission supports only ${MARKETPLACE_REPOSITORY}, `
        + `${MARKETPLACE_LANGUAGE}, and verification profile `
        + MARKETPLACE_VERIFICATION_PROFILE,
      );
    }
    const session = taskRequest.spec.session;
    const expectedWorkflow = request.workflow === 'implementation'
      ? 'implement'
      : request.workflow === 'review-finding'
        ? 'fix-child'
        : request.workflow;
    if (
      manifest.phase !== 'implement'
      || manifest.attemptId !== request.attemptId
      || manifest.issueNumber !== request.issueNumber
      || manifest.prNumber !== request.prNumber
      || manifest.branch !== request.branch
      || manifest.targetBase !== request.targetBase
      || manifest.paths.manifest !== request.manifestPath
      || manifest.paths.worktree !== request.worktreePath
      || manifest.paths.log !== request.logPath
      || taskRequest.id !== `autopilot:${manifest.attemptId}`
      || taskRequest.spec.instance_id !== taskRequest.id
      || taskRequest.spec.base_commit !== manifest.expectedHead
      || session.v2AttemptId !== manifest.attemptId
      || session.runnerId !== manifest.runnerId
      || session.issueNumber !== manifest.issueNumber
      || session.prNumber !== manifest.prNumber
      || session.branch !== manifest.branch
      || session.targetBase !== manifest.targetBase
      || session.claimOid !== manifest.claimOid
      || session.expectedHead !== manifest.expectedHead
      || session.workflow !== expectedWorkflow
      || manifest.targetBaseOid === undefined
      || session.taskSnapshot.targetBaseOid !== manifest.targetBaseOid
    ) {
      throw new Error('Marketplace request does not correlate with its attempt manifest');
    }
    if (
      state.status === 'submitted'
      && state.submission.id !== taskRequest.id
    ) {
      throw new Error(
        'Marketplace persisted submission does not match request identity',
      );
    }
    return { manifest, request: taskRequest, state };
  }

  private async submitAndPersist(
    executionRequest: MarketplaceSessionExecutionRequest,
    verified: VerifiedMarketplaceExecution,
    operation: 'submit' | 'recover',
  ): Promise<SessionExecutionResult> {
    const decision = this.claimDispatch(
      executionRequest.manifestPath,
      verified.state.requestDigest,
      { decision: 'broadcast' },
      this.now,
    );
    if (decision.decision === 'cancelled') {
      this.transition(
        executionRequest.manifestPath,
        verified.state.requestDigest,
        { status: 'cancelled', reason: decision.reason },
        this.now,
      );
      throw new Error(`Cannot ${operation} a cancelled marketplace execution`);
    }
    const submission = operation === 'submit'
      ? await this.adapter.submit(verified.state.requestPath)
      : await this.adapter.recover(verified.state.requestPath);
    if (submission.id !== verified.request.id) {
      throw new Error(
        'Marketplace submission result does not match request identity',
      );
    }
    const transitioned = this.transition(
      executionRequest.manifestPath,
      verified.state.requestDigest,
      { status: 'submitted', submission },
      this.now,
    );
    return this.startedIdentity(transitioned);
  }

  private startedIdentity(manifest: AttemptManifest): SessionExecutionResult {
    if (
      manifest.execution.backend !== 'marketplace'
      || (manifest.execution.state.schemaVersion
        !== MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
        && manifest.execution.state.schemaVersion
          !== MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION)
      || manifest.execution.state.status !== 'submitted'
    ) {
      throw new Error('Marketplace submission did not persist submitted state');
    }
    const claimed = this.claimProcess(manifest.paths.manifest, {
      ...(this.processPid === undefined ? {} : { pid: this.processPid }),
      ...(this.isPidAlive === undefined ? {} : { isPidAlive: this.isPidAlive }),
      now: this.now,
    });
    if (
      claimed.execution.backend !== 'marketplace'
      || (claimed.execution.state.schemaVersion
        !== MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
        && claimed.execution.state.schemaVersion
          !== MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION)
      || claimed.execution.state.status !== 'submitted'
    ) {
      throw new Error('Marketplace process claim changed submitted state');
    }
    const submission = claimed.execution.state.submission;
    return {
      status: 'started',
      backend: 'marketplace',
      id: submission.id,
      taskId: submission.taskId,
      taskCid: submission.taskCid,
    };
  }
}

type MarketplaceStartedResult = Extract<
  SessionExecutionResult,
  { readonly status: 'started'; readonly backend: 'marketplace' }
>;

function sortedDirectories(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => join(path, entry.name));
}

function marketplaceWorkflowFromTaskRequest(
  request: TaskSubmitRequestV1,
): ImplementationSessionExecutionRequest['workflow'] {
  switch (request.spec.session.workflow) {
    case 'implement':
      return 'implementation';
    case 'fix-child':
      return 'review-finding';
    case 'reconcile':
      return 'reconcile';
    case 'ci-failure':
      return 'ci-failure';
  }
}

/**
 * Replays every prepared marketplace request found under the complete v2
 * attempts tree. Runner IDs are process identities, so restart recovery must
 * intentionally scan every runner directory rather than only the current one.
 *
 * Traversal and replay are deterministic. Any malformed manifest, path
 * contradiction, immutable-request verification failure, or backend failure
 * stops the pump before later attempts can run.
 */
export async function recoverPreparedMarketplaceAttempts(
  v2Base: string,
  backend: Pick<MarketplaceSessionExecutionBackend, 'recover'>,
): Promise<readonly MarketplaceStartedResult[]> {
  if (!isAbsolute(v2Base)) {
    throw new Error('Marketplace recovery base must be absolute');
  }
  const recovered: MarketplaceStartedResult[] = [];
  for (const runnerDir of sortedDirectories(v2Base)) {
    for (const phaseDir of sortedDirectories(runnerDir)) {
      for (const attemptDir of sortedDirectories(phaseDir)) {
        const manifestPath = join(attemptDir, 'manifest.json');
        const manifest = readAttemptManifest(manifestPath);
        if (
          manifest.paths.manifest !== manifestPath
          || manifest.paths.attemptDir !== attemptDir
          || manifest.runnerId !== basename(runnerDir)
          || manifest.phase !== basename(phaseDir)
          || basename(attemptDir) !== `${manifest.subject}-${manifest.attemptId}`
        ) {
          throw new Error(
            'Marketplace recovery manifest does not match its v2 attempt path',
          );
        }
        if (
          manifest.execution.backend !== 'marketplace'
          || (
            manifest.execution.state.schemaVersion !== MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
            && manifest.execution.state.schemaVersion !== MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION
          )
          || manifest.execution.state.status !== 'prepared'
        ) {
          continue;
        }
        if (manifest.phase !== 'implement' || manifest.prNumber === undefined) {
          throw new Error(
            'Prepared marketplace recovery requires an implementation attempt',
          );
        }
        const request = verifyMarketplaceTaskRequest(
          manifest.execution.state.requestPath,
          manifest.execution.state.requestDigest,
        );
        const result = await backend.recover({
          kind: 'implementation',
          workflow: marketplaceWorkflowFromTaskRequest(request),
          manifestPath,
          attemptId: manifest.attemptId,
          issueNumber: manifest.issueNumber,
          prNumber: manifest.prNumber,
          branch: manifest.branch,
          targetBase: manifest.targetBase,
          worktreePath: manifest.paths.worktree,
          logPath: manifest.paths.log,
          backend: 'marketplace',
        });
        if (result.status !== 'started' || result.backend !== 'marketplace') {
          throw new Error('Marketplace recovery did not return a started Task');
        }
        recovered.push(result);
      }
    }
  }
  return recovered;
}

export interface RecoverSubmittedMarketplaceAttemptsOptions {
  readonly v2Base: string;
  readonly recoverPrepared: () => Promise<readonly SessionExecutionResult[]>;
  readonly makeAdopter: (
    manifestPath: string,
  ) => MarketplaceMutationAdoptionCoordinator;
  readonly releaseReviewAnchor?: (
    anchor: MarketplaceReviewAnchorEvidence,
  ) => Promise<void>;
  readonly processPid?: number;
  readonly isPidAlive: (pid: number) => boolean;
  readonly now?: () => Date;
}

function validateMarketplaceRecoveryManifest(
  manifestPath: string,
  attemptDir: string,
  runnerDir: string,
  phaseDir: string,
): AttemptManifest {
  const manifest = readAttemptManifest(manifestPath);
  if (
    manifest.paths.manifest !== manifestPath
    || manifest.paths.attemptDir !== attemptDir
    || manifest.runnerId !== basename(runnerDir)
    || manifest.phase !== basename(phaseDir)
    || basename(attemptDir) !== `${manifest.subject}-${manifest.attemptId}`
  ) {
    throw new Error(
      'Marketplace recovery manifest does not match its v2 attempt path',
    );
  }
  if (manifest.execution.backend !== 'marketplace') {
    throw new Error('Marketplace adoption recovery requires a marketplace attempt');
  }
  return manifest;
}

export async function reconcileReceiptTerminalState(
  manifest: AttemptManifest,
  options: Pick<
    RecoverSubmittedMarketplaceAttemptsOptions,
    'v2Base' | 'releaseReviewAnchor' | 'isPidAlive' | 'now'
  >,
): Promise<void> {
  if (manifest.execution.backend !== 'marketplace') {
    throw new Error('Marketplace receipt reconciliation requires a marketplace attempt');
  }
  const state = manifest.execution.state;
  if (
    state.schemaVersion !== MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION
    || state.status !== 'receipt-published'
  ) {
    throw new Error('Marketplace receipt reconciliation requires receipt-published state');
  }
  const receipt = state.receipt.receipt;
  if (receipt.disposition === 'accepted') {
    return;
  }
  const now = options.now ?? (() => new Date());
  const progress = state.progress;
  if (
    progress.status === 'review-anchored'
    && options.releaseReviewAnchor !== undefined
  ) {
    await options.releaseReviewAnchor(progress.reviewAnchor);
  }
  if (
    manifest.processState === 'running'
  ) {
    markAttemptExited(
      manifest.paths.manifest,
      now,
      receipt.resultingHead === undefined ? undefined : gitOid(receipt.resultingHead),
    );
  }
  if (
    manifest.issueNumber === undefined
    || manifest.prNumber === undefined
  ) {
    return;
  }
  for (const linked of findMarketplaceEvaluatorLegReviews(options.v2Base, {
    originManifestPath: manifest.paths.manifest,
    originV2AttemptId: manifest.attemptId,
    originRequestDigest: state.requestDigest,
    prNumber: manifest.prNumber,
    expectedHead: gitOid(manifest.expectedHead),
  })) {
    if (linked.processState === 'running') {
      markAttemptExited(linked.paths.manifest, now);
    }
  }
}

export async function recoverSubmittedMarketplaceAttempts(
  options: RecoverSubmittedMarketplaceAttemptsOptions,
): Promise<{ readonly ok: boolean; readonly detail?: string }> {
  if (!isAbsolute(options.v2Base)) {
    return { ok: false, detail: 'Marketplace recovery base must be absolute' };
  }
  try {
    await options.recoverPrepared();
    const now = options.now ?? (() => new Date());
    for (const runnerDir of sortedDirectories(options.v2Base)) {
      for (const phaseDir of sortedDirectories(runnerDir)) {
        for (const attemptDir of sortedDirectories(phaseDir)) {
          const manifestPath = join(attemptDir, 'manifest.json');
          if (!existsSync(manifestPath)) continue;
          let manifest = validateMarketplaceRecoveryManifest(
            manifestPath,
            attemptDir,
            runnerDir,
            phaseDir,
          );
          if (manifest.execution.backend !== 'marketplace') {
            continue;
          }
          const marketplaceState = manifest.execution.state;
          if (
            marketplaceState.schemaVersion === MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
            && marketplaceState.status === 'submitted'
          ) {
            manifest = upgradeMarketplaceExecutionV2(
              manifestPath,
              marketplaceState.requestDigest,
              now,
            );
          }
          const recoveryStatus = marketplaceStatus(manifest);
          if (recoveryStatus === null) {
            continue;
          }
          switch (recoveryStatus) {
            case 'prepared':
              throw new Error('prepared recovery must finish before adoption recovery');
            case 'submitted':
            case 'solution-observed':
            case 'solution-verified':
            case 'host-committed':
            case 'lifecycle-completed':
            case 'review-anchored': {
              manifest = claimMarketplaceAttemptProcess(
                manifest.paths.manifest,
                {
                  pid: options.processPid ?? process.pid,
                  isPidAlive: options.isPidAlive,
                  now,
                },
              );
              const adoptionResult = await options.makeAdopter(manifest.paths.manifest)
                .adopt(manifest.paths.manifest);
              if (adoptionResult.status === 'rejected') {
                return {
                  ok: false,
                  detail: `Marketplace adoption recovery rejected ${manifest.paths.manifest}: ${adoptionResult.reason}`,
                };
              }
              break;
            }
            case 'receipt-published':
              await reconcileReceiptTerminalState(manifest, options);
              break;
            case 'cancelled':
              break;
          }
        }
      }
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
