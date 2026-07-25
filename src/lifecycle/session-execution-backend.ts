import type { SpawnResult } from '../dispatcher/coordinator-session.js';
import type { AutopilotExecutionBackend } from '../config/execution-backend.js';

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
}

export interface ExactHeadReviewSessionExecutionRequest
  extends SessionExecutionRequestBase {
  readonly kind: 'exact-head-review';
  /** Exact head that the review claim fenced and the marketplace must review. */
  readonly reviewedHead: string;
  /** Non-secret selected reviewer identity; never a credential or token. */
  readonly reviewerLogin: string;
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
          ? 'Implementation coordinator did not report a child PID'
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

/**
 * Foundation-only backend. Submission, adoption, and marketplace control are
 * intentionally deferred; this class has no local spawn or tracking ports.
 */
export class MarketplaceSessionExecutionBackend
  implements SessionExecutionBackend<'marketplace', MarketplaceSessionExecutionRequest> {
  readonly backend = 'marketplace' as const;

  async start(_request: MarketplaceSessionExecutionRequest): Promise<SessionExecutionResult> {
    return this.unavailable();
  }

  async recover(_request: MarketplaceSessionExecutionRequest): Promise<SessionExecutionResult> {
    return this.unavailable();
  }

  async cancel(_request: MarketplaceSessionExecutionRequest): Promise<SessionExecutionResult> {
    return this.unavailable();
  }

  private unavailable(): SessionExecutionResult {
    return {
      status: 'unavailable',
      backend: 'marketplace',
      detail: MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL,
    };
  }
}
