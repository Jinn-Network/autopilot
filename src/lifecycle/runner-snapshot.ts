import { isAbsolute } from 'node:path';
import type { GitHubUsage } from './github-usage.js';
import { EMPTY_GITHUB_USAGE } from './github-usage.js';
import {
  IncrementalLifecycleSnapshotSource,
  IncrementalSnapshotUnavailableError,
  type IncrementalLifecycleSnapshotSourceOptions,
} from './incremental-snapshot-source.js';
import {
  LifecycleDiscoveryCacheCorruptError,
} from './lifecycle-cache.js';
import type {
  GitHubLifecycleSnapshot,
  LifecycleSnapshotSource,
  SnapshotReadMode,
} from './snapshot.js';
import { LifecycleRateLimitError } from './snapshot.js';
import { exactUtcTimestampMs } from './exact-utc-time.js';

export const DEFAULT_FULL_RECONCILE_MS = 60 * 60_000;

export interface SnapshotRuntimeConfig {
  readonly mode: SnapshotReadMode;
  readonly fullReconcileMs: number;
}

export function parseAutopilotStateDirectory(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value = environment.JINN_AUTOPILOT_STATE_DIRECTORY;
  if (value === undefined) return undefined;
  if (value.length === 0 || !isAbsolute(value)) {
    throw new Error(
      'JINN_AUTOPILOT_STATE_DIRECTORY must be a non-empty absolute filesystem path',
    );
  }
  return value;
}

type IncrementalSourceBaseOptions = Omit<
IncrementalLifecycleSnapshotSourceOptions,
'stateDirectory'
>;

export function createConfiguredIncrementalLifecycleSnapshotSource(
  options: IncrementalSourceBaseOptions,
  stateDirectory: string | undefined,
): IncrementalLifecycleSnapshotSource;
export function createConfiguredIncrementalLifecycleSnapshotSource<Result>(
  options: IncrementalSourceBaseOptions,
  stateDirectory: string | undefined,
  create: (options: IncrementalLifecycleSnapshotSourceOptions) => Result,
): Result;
export function createConfiguredIncrementalLifecycleSnapshotSource<Result>(
  options: IncrementalSourceBaseOptions,
  stateDirectory: string | undefined,
  create?: (options: IncrementalLifecycleSnapshotSourceOptions) => Result,
): IncrementalLifecycleSnapshotSource | Result {
  if (
    stateDirectory !== undefined
    && (stateDirectory.length === 0 || !isAbsolute(stateDirectory))
  ) {
    throw new Error(
      'JINN_AUTOPILOT_STATE_DIRECTORY must be a non-empty absolute filesystem path',
    );
  }
  const configured: IncrementalLifecycleSnapshotSourceOptions = {
    ...options,
    ...(stateDirectory === undefined ? {} : { stateDirectory }),
  };
  return create === undefined
    ? new IncrementalLifecycleSnapshotSource(configured)
    : create(configured);
}

export interface LifecycleCadenceOptions {
  readonly once: boolean;
  readonly intervalMs: number;
  readonly runCycle: () => Promise<void>;
  readonly shouldContinue: () => boolean;
  readonly wait: (ms: number) => Promise<void>;
}

/** One wait follows every persistent cycle, including a reported failure. */
export async function runLifecycleCadence(options: LifecycleCadenceOptions): Promise<void> {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error('Lifecycle cadence interval must be a positive integer');
  }
  while (true) {
    await options.runCycle();
    if (options.once || !options.shouldContinue()) return;
    await options.wait(options.intervalMs);
  }
}

export interface SnapshotStartupContext {
  readonly mode: 'observe' | 'recover' | 'active';
  readonly once: boolean;
  readonly commandKind: 'status' | 'explain-issue' | 'explain-pr';
  readonly fullReconcile: boolean;
}

export function isRoutineCachedStatus(context: SnapshotStartupContext): boolean {
  return context.mode === 'observe'
    && context.once
    && context.commandKind === 'status'
    && !context.fullReconcile;
}

function positiveInteger(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${label} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is too large`);
  return value;
}

export function parseSnapshotRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>>,
): SnapshotRuntimeConfig {
  const rawMode = environment.JINN_AUTOPILOT_SNAPSHOT_MODE;
  if (rawMode !== undefined && rawMode !== '' && rawMode !== 'full' && rawMode !== 'incremental') {
    throw new Error('JINN_AUTOPILOT_SNAPSHOT_MODE must be full or incremental');
  }
  return {
    mode: rawMode === 'full' ? 'full' : 'incremental',
    fullReconcileMs: positiveInteger(
      environment.JINN_AUTOPILOT_FULL_RECONCILE_MS,
      DEFAULT_FULL_RECONCILE_MS,
      'JINN_AUTOPILOT_FULL_RECONCILE_MS',
    ),
  };
}

function exactNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('Lifecycle snapshot coordinator clock returned an invalid Date');
  }
  return value;
}

function partialSnapshot(
  capturedAt: string,
  usage: GitHubUsage,
  reason: string,
): GitHubLifecycleSnapshot {
  return {
    project: {
      items: [],
      rateLimit: {
        remaining: 0,
        used: 0,
        resetAt: capturedAt,
      },
      currentSprintIterationId: null,
    },
    issues: [],
    pullRequests: [],
    branches: [],
    diagnostics: [],
    lifecycle: { items: [] },
    capturedAt,
    snapshotMode: 'incremental',
    snapshotComplete: false,
    lastFullReconciliationAt: null,
    githubUsage: usage,
    partialReason: reason,
  };
}

export class FullSnapshotAuthorityError extends Error {
  constructor(detail: string) {
    super(`Requested full snapshot is not authoritative: ${detail}`);
    this.name = 'FullSnapshotAuthorityError';
  }
}

export class IncrementalFallbackAuthorityError extends Error {
  constructor(detail: string) {
    super(`Failed-full incremental fallback is not authoritative: ${detail}`);
    this.name = 'IncrementalFallbackAuthorityError';
  }
}

export class IncrementalCadenceSeedAuthorityError extends Error {
  constructor(detail: string) {
    super(`Seeded startup incremental snapshot is not authoritative: ${detail}`);
    this.name = 'IncrementalCadenceSeedAuthorityError';
  }
}

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

function liveGraphQlUsageAuthorityDetail(
  usage: GitHubUsage | undefined,
  requireGraphQlResponse: boolean,
): string | null {
  if (usage === undefined) return 'live GraphQL usage evidence is missing';
  if (
    !safeNonNegativeInteger(usage.graphqlRequests)
    || (requireGraphQlResponse && usage.graphqlRequests === 0)
  ) {
    return 'no live GraphQL evidence request was recorded';
  }
  if (!safeNonNegativeInteger(usage.graphqlCost)) return 'GraphQL cost evidence is invalid';
  if (usage.graphqlRequests === 0 && usage.graphqlCost !== 0) {
    return 'GraphQL cost cannot be non-zero without a GraphQL request';
  }
  if (!safeNonNegativeInteger(usage.restRequests)) {
    return 'REST request evidence is invalid';
  }
  if (usage.graphqlRequests === 0 && usage.restRequests < 1) {
    return 'no live REST GraphQL quota evidence request was recorded';
  }
  if (!safeNonNegativeInteger(usage.graphqlRemaining)) {
    return 'GraphQL remaining evidence is missing or invalid';
  }
  if (exactUtcTimestampMs(usage.graphqlResetAt) === null) {
    return 'GraphQL reset evidence is missing or invalid';
  }
  return null;
}

function assertFullSnapshotAuthority(
  snapshot: GitHubLifecycleSnapshot,
  requestedAtMs: number,
  completedAtMs: number,
): void {
  if (snapshot.snapshotComplete !== true) {
    throw new FullSnapshotAuthorityError('snapshotComplete is not true');
  }
  if (snapshot.snapshotMode !== 'full') {
    throw new FullSnapshotAuthorityError('snapshotMode is not full');
  }
  const capturedMs = exactUtcTimestampMs(snapshot.capturedAt);
  if (capturedMs === null) {
    throw new FullSnapshotAuthorityError('capturedAt is not an exact UTC timestamp');
  }
  const lastFullMs = exactUtcTimestampMs(snapshot.lastFullReconciliationAt);
  if (lastFullMs === null) {
    throw new FullSnapshotAuthorityError(
      'lastFullReconciliationAt is missing or not an exact UTC timestamp',
    );
  }
  if (snapshot.capturedAt !== snapshot.lastFullReconciliationAt) {
    throw new FullSnapshotAuthorityError('capturedAt and lastFullReconciliationAt differ');
  }
  if (capturedMs < requestedAtMs || capturedMs > completedAtMs) {
    throw new FullSnapshotAuthorityError('full reconciliation marker is stale or future-dated');
  }
  const usageDetail = liveGraphQlUsageAuthorityDetail(snapshot.githubUsage, true);
  if (usageDetail !== null) throw new FullSnapshotAuthorityError(usageDetail);
}

function assertIncrementalFallbackAuthority(
  snapshot: GitHubLifecycleSnapshot,
  fallbackRequestedAtMs: number,
  fallbackCompletedAtMs: number,
  failedFullRequestedAtMs: number,
  priorLastFullReconciliationAt: string | null,
): void {
  if (snapshot.snapshotComplete !== true) {
    throw new IncrementalFallbackAuthorityError('snapshotComplete is not true');
  }
  if (snapshot.snapshotMode !== 'incremental') {
    throw new IncrementalFallbackAuthorityError('snapshotMode is not incremental');
  }
  const capturedMs = exactUtcTimestampMs(snapshot.capturedAt);
  if (capturedMs === null) {
    throw new IncrementalFallbackAuthorityError('capturedAt is not an exact UTC timestamp');
  }
  if (capturedMs < fallbackRequestedAtMs || capturedMs > fallbackCompletedAtMs) {
    throw new IncrementalFallbackAuthorityError('capturedAt is stale or future-dated');
  }
  const lastFullMs = exactUtcTimestampMs(snapshot.lastFullReconciliationAt);
  if (lastFullMs === null) {
    throw new IncrementalFallbackAuthorityError(
      'lastFullReconciliationAt is missing or not an exact UTC timestamp',
    );
  }
  if (lastFullMs > capturedMs) {
    throw new IncrementalFallbackAuthorityError(
      'lastFullReconciliationAt is later than capturedAt',
    );
  }
  if (priorLastFullReconciliationAt !== null) {
    if (snapshot.lastFullReconciliationAt !== priorLastFullReconciliationAt) {
      throw new IncrementalFallbackAuthorityError(
        'lastFullReconciliationAt advanced during the failed full reconciliation',
      );
    }
  } else if (lastFullMs >= failedFullRequestedAtMs) {
    throw new IncrementalFallbackAuthorityError(
      'startup fallback claims the failed full reconciliation as successful',
    );
  }
  const usageDetail = liveGraphQlUsageAuthorityDetail(snapshot.githubUsage, false);
  if (usageDetail !== null) throw new IncrementalFallbackAuthorityError(usageDetail);
}

function cadenceSeedAuthorityDetail(
  snapshot: GitHubLifecycleSnapshot,
  cadenceSeed: string,
  requestedAtMs: number,
  completedAtMs: number,
  fullReconcileMs: number,
): string | null {
  const seedMs = exactUtcTimestampMs(cadenceSeed);
  if (seedMs === null) return 'cadence seed is not an exact UTC timestamp';
  const capturedMs = exactUtcTimestampMs(snapshot.capturedAt);
  if (capturedMs === null) return 'capturedAt is not an exact UTC timestamp';
  const sourceMarkerMs = exactUtcTimestampMs(snapshot.lastFullReconciliationAt);
  if (sourceMarkerMs === null) {
    return 'lastFullReconciliationAt is missing or not an exact UTC timestamp';
  }
  if (capturedMs > completedAtMs) return 'capturedAt is future-dated';
  if (sourceMarkerMs > capturedMs || sourceMarkerMs > completedAtMs) {
    return 'lastFullReconciliationAt is future-dated';
  }
  if (sourceMarkerMs < seedMs) return 'lastFullReconciliationAt regressed behind the cadence seed';
  const elapsed = requestedAtMs - sourceMarkerMs;
  if (elapsed < 0) return 'lastFullReconciliationAt is future-dated';
  if (elapsed >= fullReconcileMs) return 'lastFullReconciliationAt is due for a full reconciliation';
  return null;
}

export interface LifecycleSnapshotCoordinatorOptions {
  readonly source: LifecycleSnapshotSource & {
    readScoped?(options: {
      readonly issueNumbers: ReadonlySet<number>;
      readonly rateLimitFloor: number;
      readonly maxGlobalAgeMs: number;
    }): Promise<GitHubLifecycleSnapshot | null>;
  };
  readonly configuredMode: SnapshotReadMode;
  readonly fullReconcileMs: number;
  /** Active/recover runners seed authoritatively; routine observe status does not. */
  readonly startupFull: boolean;
  /** Only routine read-only status may turn a missing/corrupt cache into a partial view. */
  readonly allowPartial: boolean;
  /** Validated durable marker supplied only to a daemon-spawned active one-shot. */
  readonly cadenceSeed?: string | null;
  readonly forceFull?: boolean;
  readonly now?: () => Date;
  readonly readUsage?: () => GitHubUsage;
}

/**
 * Chooses the authoritative startup/hourly reads without giving cached state
 * mutation authority. The underlying source owns atomic cache replacement.
 */
export class LifecycleSnapshotCoordinator {
  private readonly source: LifecycleSnapshotCoordinatorOptions['source'];
  private readonly configuredMode: SnapshotReadMode;
  private readonly fullReconcileMs: number;
  private readonly startupFull: boolean;
  private readonly allowPartial: boolean;
  private readonly forceFull: boolean;
  private readonly now: () => Date;
  private readonly readUsage: () => GitHubUsage;
  private started = false;
  private lastFullReconciliationAt: string | null = null;
  private fullRetryDue = false;
  private preserveUsageOnNextRead = false;
  private scopedCadenceFence: string | null = null;

  constructor(options: LifecycleSnapshotCoordinatorOptions) {
    if (!Number.isSafeInteger(options.fullReconcileMs) || options.fullReconcileMs <= 0) {
      throw new Error('Full-reconciliation cadence must be a positive integer');
    }
    this.source = options.source;
    this.configuredMode = options.configuredMode;
    this.fullReconcileMs = options.fullReconcileMs;
    this.startupFull = options.startupFull;
    this.allowPartial = options.allowPartial;
    this.forceFull = options.forceFull ?? false;
    this.now = options.now ?? (() => new Date());
    this.readUsage = options.readUsage ?? (() => EMPTY_GITHUB_USAGE);
    this.lastFullReconciliationAt = options.cadenceSeed ?? null;
  }

  private nextMode(now: Date): SnapshotReadMode {
    if (this.forceFull || this.configuredMode === 'full') return 'full';
    if (this.fullRetryDue) return 'full';
    if (!this.started && this.lastFullReconciliationAt === null) {
      return this.startupFull ? 'full' : 'incremental';
    }
    if (this.lastFullReconciliationAt === null) return this.startupFull ? 'full' : 'incremental';
    const lastFullMs = exactUtcTimestampMs(this.lastFullReconciliationAt);
    if (lastFullMs === null) return 'full';
    const elapsed = now.getTime() - lastFullMs;
    if (elapsed < 0 || elapsed >= this.fullReconcileMs) {
      return 'full';
    }
    return 'incremental';
  }

  async readScoped(
    issueNumbers: ReadonlySet<number>,
    rateLimitFloor: number,
    maxGlobalAgeMs: number,
  ): Promise<GitHubLifecycleSnapshot | null> {
    if (this.source.readScoped === undefined) return null;
    const requestedAt = exactNow(this.now);
    const manualUnmarkedStartup = (
      !this.started
      && this.lastFullReconciliationAt === null
      && this.startupFull
      && this.configuredMode === 'incremental'
      && !this.forceFull
      && !this.fullRetryDue
    );
    if (this.nextMode(requestedAt) === 'full' && !manualUnmarkedStartup) return null;
    const cadenceFence = this.lastFullReconciliationAt;
    const scoped = await this.source.readScoped({
      issueNumbers,
      rateLimitFloor,
      maxGlobalAgeMs,
    });
    if (scoped !== null) {
      this.preserveUsageOnNextRead = true;
      const authorityFence = cadenceFence ?? scoped.lastFullReconciliationAt;
      if (authorityFence === null || authorityFence === undefined) return null;
      const authorityDetail = cadenceSeedAuthorityDetail(
        scoped,
        authorityFence,
        requestedAt.getTime(),
        exactNow(this.now).getTime(),
        this.fullReconcileMs,
      );
      if (authorityDetail !== null) return null;
      this.lastFullReconciliationAt = scoped.lastFullReconciliationAt ?? null;
      this.scopedCadenceFence = scoped.lastFullReconciliationAt ?? null;
    }
    return scoped;
  }

  private async retryFullAfterSeededIncremental(
    rateLimitFloor: number,
    authorityError: unknown,
  ): Promise<GitHubLifecycleSnapshot> {
    this.fullRetryDue = true;
    try {
      const fullRequestedAtMs = exactNow(this.now).getTime();
      const full = await this.source.read({
        mode: 'full',
        rateLimitFloor,
        resetUsage: false,
      });
      assertFullSnapshotAuthority(
        full,
        fullRequestedAtMs,
        exactNow(this.now).getTime(),
      );
      this.lastFullReconciliationAt = full.lastFullReconciliationAt!;
      this.fullRetryDue = false;
      return full;
    } catch (fullError) {
      throw new AggregateError(
        [authorityError, fullError],
        'Seeded startup incremental cache authority changed and full retry failed',
      );
    }
  }

  async read(rateLimitFloor: number): Promise<GitHubLifecycleSnapshot> {
    const now = exactNow(this.now);
    const mode = this.nextMode(now);
    const preserveUsage = this.preserveUsageOnNextRead;
    this.preserveUsageOnNextRead = false;
    const cadenceFence = mode === 'incremental'
      ? this.scopedCadenceFence ?? (!this.started ? this.lastFullReconciliationAt : null)
      : null;
    this.scopedCadenceFence = null;
    this.started = true;
    try {
      const snapshot = await this.source.read({
        mode,
        rateLimitFloor,
        ...(preserveUsage ? { resetUsage: false } : {}),
      });
      if (mode === 'full') {
        assertFullSnapshotAuthority(snapshot, now.getTime(), exactNow(this.now).getTime());
      } else if (snapshot.snapshotComplete !== true) {
        throw new IncrementalSnapshotUnavailableError('snapshot source returned a partial view');
      }
      if (cadenceFence !== null) {
        const authorityDetail = cadenceSeedAuthorityDetail(
          snapshot,
          cadenceFence,
          now.getTime(),
          exactNow(this.now).getTime(),
          this.fullReconcileMs,
        );
        if (authorityDetail !== null) {
          const authorityError = new IncrementalCadenceSeedAuthorityError(authorityDetail);
          return this.retryFullAfterSeededIncremental(rateLimitFloor, authorityError);
        }
      }
      this.lastFullReconciliationAt = snapshot.lastFullReconciliationAt ?? null;
      if (mode === 'full') this.fullRetryDue = false;
      return snapshot;
    } catch (error) {
      if (
        cadenceFence !== null
        && mode === 'incremental'
        && (
          error instanceof IncrementalSnapshotUnavailableError
          || error instanceof LifecycleDiscoveryCacheCorruptError
        )
      ) {
        return this.retryFullAfterSeededIncremental(rateLimitFloor, error);
      }
      if (
        mode === 'full'
        && this.configuredMode === 'incremental'
        && !this.forceFull
      ) {
        this.fullRetryDue = true;
        const priorLastFullReconciliationAt = this.lastFullReconciliationAt;
        try {
          const fallbackRequestedAtMs = exactNow(this.now).getTime();
          const fallback = await this.source.read({
            mode: 'incremental',
            rateLimitFloor,
            resetUsage: false,
          });
          assertIncrementalFallbackAuthority(
            fallback,
            fallbackRequestedAtMs,
            exactNow(this.now).getTime(),
            now.getTime(),
            priorLastFullReconciliationAt,
          );
          this.lastFullReconciliationAt = fallback.lastFullReconciliationAt!;
          return {
            ...fallback,
            snapshotWarning: `Full reconciliation failed and remains due: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        } catch (fallbackError) {
          if (fallbackError instanceof LifecycleRateLimitError) throw fallbackError;
          throw new AggregateError(
            [error, fallbackError],
            'Full reconciliation and incremental fallback both failed',
          );
        }
      }
      if (
        this.allowPartial
        && mode === 'incremental'
        && (
          error instanceof IncrementalSnapshotUnavailableError
          || error instanceof LifecycleDiscoveryCacheCorruptError
        )
      ) {
        return partialSnapshot(
          now.toISOString(),
          this.readUsage(),
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
  }
}
