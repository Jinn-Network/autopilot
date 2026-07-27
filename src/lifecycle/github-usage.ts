import { createHash } from 'node:crypto';
import { DEFAULT_FLOOR } from '../dispatcher/rate-limit-guard.js';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import { withTransientReadRetry } from './transient-retry.js';

/** GraphQL points reserved to finish a complete lifecycle scan safely. */
export const FULL_SCAN_RESERVE = 450;

/** GraphQL points reserved for one exact, targeted pull-request read. */
export const TARGETED_PR_RESERVE = 10;

/** GraphQL points reserved for one single-issue Project-item lookup. */
export const TARGETED_PROJECT_ITEM_RESERVE = 1;

/** GraphQL points reserved for one targeted issue-to-closing-PR relation read. */
export const TARGETED_RELATION_RESERVE = 2;

/**
 * One enrollment may need one candidate read plus all three bounded
 * post-publication confirmation reads.
 */
export const REVIEW_CLAIM_ACTION_RESERVE = TARGETED_PR_RESERVE * 4;

/** Conservative modeled span for an opaque higher-level `gh` command. */
export const OPAQUE_GH_COMMAND_RESERVE = 10;

export interface GitHubUsage {
  /** Explicit GraphQL responses whose rate-limit evidence was decoded. */
  readonly graphqlRequests: number;
  readonly graphqlCost: number;
  readonly graphqlRemaining: number | null;
  readonly graphqlResetAt: string | null;
  readonly restRequests: number;
  readonly restNotModified: number;
  readonly cacheHits: number;
  /**
   * Whether every metered command this cycle contributed complete before/after
   * quota evidence. GitHub's `rateLimit.used`/`remaining` counters are
   * eventually consistent under concurrency, so this can be `false` for a cycle
   * whose commands all succeeded and whose numbers are otherwise correct. It is
   * observability only — never a correctness gate and never a reason to fail a
   * command or crash the loop.
   */
  readonly accountingComplete: boolean;
  /**
   * Human-readable reason accounting was incomplete; set only when incomplete.
   * Prefixed with {@link EXPECTED_ACCOUNTING_APPROXIMATION_PREFIX} when every
   * recorded cause is an expected approximation rather than an anomaly — see
   * that constant for why the distinction is reported rather than flattened.
   */
  readonly incompleteReason?: string;
  /**
   * Transport faults retried on allowlisted reads this cycle; present only when
   * at least one retry happened, so a retried action is never indistinguishable
   * from a first-attempt success.
   */
  readonly transientRetries?: number;
}

export const EMPTY_GITHUB_USAGE: GitHubUsage = Object.freeze({
  graphqlRequests: 0,
  graphqlCost: 0,
  graphqlRemaining: null,
  graphqlResetAt: null,
  restRequests: 0,
  restNotModified: 0,
  cacheHits: 0,
  accountingComplete: true,
});

/**
 * Marks a cycle whose only accounting gaps are EXPECTED approximations — the
 * cycle measured everything it can measure, and the residue is a property of
 * GitHub's API, not of this run.
 *
 * Why the distinction exists. `accountingComplete: false` is one flag over two
 * very different situations: (1) something that should have been evidenced was
 * not — a failed probe, an unevidenced retry, a hidden page count; and (2) a
 * quantity GitHub itself cannot report exactly. Reporting (2) with the same
 * `WARNING: … reported quota numbers are best-effort` line fires on every
 * single cycle, which trains the operator to ignore the line that also carries
 * (1) — and it misstates the condition: under counter skew `graphqlRemaining`
 * and `graphqlResetAt` are read straight off the probe responses and are
 * exact. Only the cost attribution is soft.
 *
 * The flag itself is deliberately NOT changed: `graphqlCost` really is a lower
 * bound in this case, so `accountingComplete: false` remains the accurate
 * value, the persisted cache shape is untouched, and every existing consumer
 * keeps its current semantics. Only the severity of the report changes.
 */
export const EXPECTED_ACCOUNTING_APPROXIMATION_PREFIX = 'expected approximation: ';

/**
 * The one approximation GitHub's API makes unavoidable. `rateLimit.used` and
 * `rateLimit.remaining` are eventually consistent, so the before/after probes
 * bracketing an opaque `gh` command legitimately disagree even when the
 * command and both probes all succeeded (see `recordOpaqueGraphQlSpan`). The
 * span cannot be closed from within the probe design, so the hidden cost goes
 * unattributed and `graphqlCost` becomes a lower bound.
 */
export const OPAQUE_SPAN_SKEW_APPROXIMATION =
  'GitHub\'s rateLimit used/remaining counters are eventually consistent, so the '
  + 'before/after probes bracketing at least one opaque `gh` command disagreed and '
  + 'its hidden cost could not be attributed; graphqlCost is a lower bound, while '
  + 'graphqlRemaining and graphqlResetAt are read directly from the probe responses '
  + 'and remain exact';

export class GitHubUsageDecodeError extends Error {
  constructor(detail: string) {
    super(`GitHub GraphQL rateLimit evidence is incomplete: ${detail}`);
    this.name = 'GitHubUsageDecodeError';
  }
}

export class GitHubUsageIncompleteError extends Error {
  constructor(detail: string) {
    super(`GitHub cycle usage is incomplete: ${detail}`);
    this.name = 'GitHubUsageIncompleteError';
  }
}

export class GitHubRateLimitReserveError extends Error {
  constructor(
    readonly remaining: number,
    readonly required: number,
    readonly reserve: number,
  ) {
    super(
      `GitHub rate-limit budget low: ${remaining} remaining; ${required} required `
        + `(${required - reserve} floor + ${reserve} reserve)`,
    );
    this.name = 'GitHubRateLimitReserveError';
  }
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new GitHubUsageDecodeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function resetTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new GitHubUsageDecodeError('resetAt must be an ISO-8601 timestamp');
  }
  return value;
}

function rateLimitEvidence(response: unknown): {
  readonly cost: number;
  readonly remaining: number;
  readonly resetAt: string;
} {
  if (typeof response !== 'object' || response === null) {
    throw new GitHubUsageDecodeError('response must be an object');
  }
  const data = (response as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) {
    throw new GitHubUsageDecodeError('data must be an object');
  }
  const rateLimit = (data as { rateLimit?: unknown }).rateLimit;
  if (typeof rateLimit !== 'object' || rateLimit === null) {
    throw new GitHubUsageDecodeError('data.rateLimit must be an object');
  }
  const values = rateLimit as Record<string, unknown>;
  return {
    cost: nonNegativeInteger(values.cost, 'cost'),
    remaining: nonNegativeInteger(values.remaining, 'remaining'),
    resetAt: resetTimestamp(values.resetAt),
  };
}

function assertSuccessfulGraphQlResult(response: unknown): void {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    throw new Error('GitHub GraphQL response must be an object');
  }
  const result = response as { data?: unknown; errors?: unknown };
  if (result.errors !== undefined && !Array.isArray(result.errors)) {
    throw new Error('GitHub GraphQL errors member must be an array');
  }
  if (result.errors !== undefined && result.errors.length > 0) {
    throw new Error('GitHub GraphQL errors were returned');
  }
  if (typeof result.data !== 'object' || result.data === null || Array.isArray(result.data)) {
    throw new Error('GitHub GraphQL response data must be an object');
  }
}

function opaqueRateLimitEvidence(response: unknown): {
  readonly cost: number;
  readonly remaining: number;
  readonly resetAt: string;
  readonly used: number;
  readonly limit: number;
} {
  const evidence = rateLimitEvidence(response);
  const data = (response as { data: { rateLimit: Record<string, unknown> } }).data;
  const used = nonNegativeInteger(data.rateLimit.used, 'used');
  const limit = nonNegativeInteger(data.rateLimit.limit, 'limit');
  if (used > limit || evidence.remaining > limit) {
    throw new GitHubUsageDecodeError('used and remaining must not exceed limit');
  }
  return { ...evidence, used, limit };
}

/** Mutable, cycle-scoped request meter. `read()` always returns a frozen copy. */
export class GitHubUsageMeter {
  private graphqlRequests = 0;
  private graphqlCost = 0;
  private readonly quotaByCredential = new Map<string, {
    readonly remaining: number;
    readonly resetAt: string;
  }>();
  private restRequests = 0;
  private restNotModified = 0;
  private cacheHits = 0;
  private transientRetries = 0;
  private transientRetryReason: string | null = null;
  private incompleteReason: string | null = null;
  /**
   * Expected approximations, deduplicated. Unlike `incompleteReason` this is
   * not first-wins: the same approximation fires on many commands per cycle
   * and must collapse to one statement, not N.
   */
  private readonly approximations = new Set<string>();
  private opaqueQueue: Promise<void> = Promise.resolve();

  private recordQuotaEvidence(
    remaining: number,
    resetAt: string,
    credentialKey: string,
  ): void {
    const current = this.quotaByCredential.get(credentialKey);
    if (
      current === undefined
      || Date.parse(resetAt) > Date.parse(current.resetAt)
    ) {
      this.quotaByCredential.set(credentialKey, { remaining, resetAt });
    } else if (resetAt === current.resetAt) {
      this.quotaByCredential.set(credentialKey, {
        remaining: Math.min(current.remaining, remaining),
        resetAt: current.resetAt,
      });
    }
  }

  recordGraphQlResponse(response: unknown, credentialKey = 'ambient'): void {
    const evidence = rateLimitEvidence(response);
    this.graphqlRequests += 1;
    this.graphqlCost += evidence.cost;
    this.recordQuotaEvidence(evidence.remaining, evidence.resetAt, credentialKey);
  }

  /**
   * Records a GraphQL request whose mutation/read result succeeded but omitted
   * usable optional rate-limit accounting evidence.
   */
  recordGraphQlRequestWithoutRateLimit(detail: string): void {
    this.graphqlRequests += 1;
    this.markIncomplete(detail);
  }

  /** Records quota authority from REST `/rate_limit` without charging GraphQL usage. */
  recordGraphQlQuotaEvidence(
    remainingValue: unknown,
    resetAtValue: unknown,
    credentialKey = 'ambient',
  ): void {
    const remaining = nonNegativeInteger(remainingValue, 'remaining');
    const resetAt = resetTimestamp(resetAtValue);
    this.recordQuotaEvidence(remaining, resetAt, credentialKey);
  }

  recordRestRequest(status?: number): void {
    if (
      status !== undefined
      && (!Number.isSafeInteger(status) || status < 100 || status > 599)
    ) {
      throw new Error(`Invalid GitHub REST status: ${String(status)}`);
    }
    this.restRequests += 1;
    if (status === 304) this.restNotModified += 1;
  }

  recordOpaqueGraphQlSpan(
    before: unknown,
    after: unknown,
    credentialKey = 'ambient',
  ): void {
    // Structural decode failures (missing/negative rateLimit fields) still
    // throw — they are corrupt evidence, not skew. Everything past this point
    // is best-effort accounting that must never throw: GitHub's used/remaining
    // counters are eventually consistent, so under concurrent reads the
    // before/after probes legitimately disagree even though the command
    // succeeded. Inconsistency is surfaced via markIncomplete, never raised.
    const start = opaqueRateLimitEvidence(before);
    const end = opaqueRateLimitEvidence(after);
    const startReset = Date.parse(start.resetAt);
    const endReset = Date.parse(end.resetAt);
    let hiddenCost = 0;
    if (endReset === startReset) {
      const remainingDelta = start.remaining - end.remaining;
      const usedDelta = end.used - start.used;
      if (
        end.limit !== start.limit
        || remainingDelta < end.cost
        || usedDelta < end.cost
        || remainingDelta !== usedDelta
      ) {
        // Expected, not anomalous: this is the documented eventual consistency
        // of GitHub's own counters, reachable on a cycle where the command and
        // both probes succeeded. Recorded as an approximation so it stops
        // being reported as a per-cycle anomaly, and so the report can say
        // which number is soft (cost) and which is not (remaining/resetAt).
        this.markApproximate(OPAQUE_SPAN_SKEW_APPROXIMATION);
      } else {
        hiddenCost = usedDelta - end.cost;
      }
    } else if (endReset > startReset) {
      // The span's cost is UNATTRIBUTABLE, not merely imprecise: the two probes
      // were measured in different quota windows, so no subtraction between
      // them means anything. `hiddenCost` stays 0 and the gap is declared.
      //
      // This previously computed `start.remaining + end.used - end.cost`, i.e.
      // `limit - usedOld + usedNew - end.cost`, justified as "intentionally
      // over-counts". That reasoning only holds when the old window was near
      // exhausted at the opening probe. When BOTH windows are lightly used —
      // the common case for a cycle that happens to cross the hour boundary —
      // it approaches `limit`, so a single straddling span charged ~5000 points
      // to a cycle that spent almost nothing. Observed live as
      // "GraphQL 5091 points across 91 evidence requests, 4951 remaining",
      // which is arithmetically impossible against a 5000-point limit.
      //
      // markIncomplete, not markApproximate: a straddled reset is a genuine
      // evidence gap in THIS run's probe design, not an approximation forced by
      // GitHub's API, so it must keep rendering as a WARNING rather than being
      // demoted to the expected-approximation channel.
      //
      // The former `end.used < end.cost` sub-guard is folded away rather than
      // kept: it is unreachable (GitHub's `used` includes the closing probe's
      // own cost, so `end.used >= end.cost` always holds), and now that both
      // arms would set `hiddenCost = 0` and mark incomplete, a dead branch
      // distinguishing two messages would only be noise.
      this.markIncomplete(
        'an opaque command\'s quota evidence straddled a rate-limit reset, so its '
          + 'cost cannot be attributed to either window; graphqlCost omits it',
      );
    } else {
      this.markIncomplete('opaque-command closing probe belonged to an older reset window');
    }
    // Always advance best-effort quota evidence from both probes so
    // remaining/reset/requests/cost keep moving even when accounting is soft.
    this.recordGraphQlResponse(before, credentialKey);
    this.recordGraphQlResponse(after, credentialKey);
    this.graphqlCost += hiddenCost;
  }

  serializeOpaque<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.opaqueQueue.then(operation);
    this.opaqueQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  markIncomplete(detail: string): void {
    this.incompleteReason ??= detail;
  }

  /**
   * Records an approximation GitHub's API makes unavoidable, as opposed to
   * something this cycle failed to evidence. Keeps `accountingComplete` false
   * — the number really is soft — but lets the report state it without the
   * anomaly framing. See {@link EXPECTED_ACCOUNTING_APPROXIMATION_PREFIX}.
   */
  markApproximate(detail: string): void {
    this.approximations.add(detail);
  }

  recordCacheHit(): void {
    this.cacheHits += 1;
  }

  /**
   * Records one allowlisted read whose transport fault was retried. The faulted
   * attempt returned no response, so whether GitHub charged it is unknowable —
   * it can be neither decoded as evidence nor guessed at. That makes accounting
   * incomplete, which is exactly what the flag already means: reported quota
   * numbers are best-effort for this cycle.
   *
   * The retry reason is held separately rather than pushed through
   * `markIncomplete`, whose first-wins `??=` would let an early retry
   * permanently mask a later genuine skew reason. `read()` reports both.
   */
  recordTransientReadRetry(command: string, fault: string): void {
    this.transientRetries += 1;
    this.transientRetryReason = `${this.transientRetries} `
      + `${this.transientRetries === 1 ? 'read was' : 'reads were'} retried through a `
      + `transport fault (latest: ${command}, ${fault}); `
      + 'the faulted attempts\' quota cost is unevidenced';
  }

  reset(): void {
    this.graphqlRequests = 0;
    this.graphqlCost = 0;
    this.quotaByCredential.clear();
    this.restRequests = 0;
    this.restNotModified = 0;
    this.cacheHits = 0;
    this.transientRetries = 0;
    this.transientRetryReason = null;
    this.incompleteReason = null;
    this.approximations.clear();
  }

  read(): GitHubUsage {
    // read() never throws on incomplete accounting: GitHub's used/remaining
    // counters are eventually consistent, so accounting can be incomplete for a
    // fully-correct cycle. Completeness is surfaced as a flag, not raised — a
    // throw here would fail a command that succeeded and crash the active loop.
    let lowest: { readonly remaining: number; readonly resetAt: string } | undefined;
    for (const quota of this.quotaByCredential.values()) {
      if (lowest === undefined || quota.remaining < lowest.remaining) lowest = quota;
    }
    // Both incompleteness reasons are reported: a retry must never mask a
    // genuine quota-evidence skew recorded later in the same cycle.
    const anomalies = [this.incompleteReason, this.transientRetryReason]
      .filter((reason): reason is string => reason !== null);
    const approximations = [...this.approximations];
    const reasons = [...anomalies, ...approximations];
    // Anomalies always lead, so the prefix appears only when there are none —
    // an anomaly is never demoted by an approximation recorded alongside it.
    const composed = anomalies.length === 0 && approximations.length > 0
      ? EXPECTED_ACCOUNTING_APPROXIMATION_PREFIX + approximations.join('; ')
      : reasons.join('; ');
    return Object.freeze({
      graphqlRequests: this.graphqlRequests,
      graphqlCost: this.graphqlCost,
      graphqlRemaining: lowest?.remaining ?? null,
      graphqlResetAt: lowest?.resetAt ?? null,
      restRequests: this.restRequests,
      restNotModified: this.restNotModified,
      cacheHits: this.cacheHits,
      accountingComplete: reasons.length === 0,
      ...(reasons.length === 0 ? {} : { incompleteReason: composed }),
      ...(this.transientRetries === 0 ? {} : { transientRetries: this.transientRetries }),
    });
  }
}

const OPAQUE_USAGE_PROBE = [
  'query OpaqueGitHubUsageProbe {',
  '  rateLimit { cost remaining resetAt used limit }',
  '}',
].join('\n');

function ephemeralCredentialKey(options?: { env?: Record<string, string> }): string {
  const token = options?.env?.GH_TOKEN;
  if (token === undefined) return 'ambient';
  return `token:${createHash('sha256').update(token).digest('hex')}`;
}

function includedRestStatus(raw: string): number | undefined {
  const match = /^(?:HTTP\/1\.[01]|HTTP\/2(?:\.0)?) ([1-5][0-9]{2})(?:[ \r\n])/.exec(raw);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * Exact HTTP page count of a `gh api --paginate --slurp` response, or null when
 * the payload is not a usable page array.
 *
 * `--slurp` emits one JSON array element per HTTP page, so the element count IS
 * the request count — the page count is not actually hidden for this command
 * form, it was simply never read. `--slurp` is mutually exclusive with `--jq`
 * and `--template` in `gh`, so a slurped response is always the raw page array.
 * An empty array is treated as unusable: `gh` always issues at least one
 * request, so zero pages is evidence of a payload this decoder does not model,
 * not of a request that never happened.
 */
export function slurpedRestPageCount(raw: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  return Array.isArray(parsed) && parsed.length > 0 ? parsed.length : null;
}

/** stdout retained by Node's exec-file rejection, when one is available. */
export function commandErrorStdout(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const stdout = (error as Record<string, unknown>).stdout;
  return typeof stdout === 'string' ? stdout : null;
}

/**
 * Meter every GitHub CLI call crossing one production command boundary.
 * Explicit REST and GraphQL calls are recorded directly. Higher-level `gh`
 * commands have opaque transport internals, so authenticated before/after
 * GraphQL probes reconcile their observed cost without assigning a guessed
 * fixed cost. The original command options are reused for both probes, which
 * keeps selected credential overlays intact.
 *
 * This is also the one place transport-fault retry is applied, and it is applied
 * beneath the meter on purpose (#2168):
 *
 *   - Metering stays exact. One logical request contributes one metered request
 *     however many transport attempts it took, so a retry can never inflate REST
 *     counts or double-decode a GraphQL rate-limit response.
 *   - The meter's own before/after quota probes are allowlisted GraphQL reads,
 *     so a blip on a probe no longer aborts the metered command it brackets.
 *   - Only real subprocess failures reach the classifier. Engine-level errors
 *     raised above this line (invalid JSON, returned GraphQL errors, reserve
 *     refusals) are never retried, because they are not transport faults.
 *
 * The retry's reach is exactly this boundary's reach, which is not every command
 * the engine issues: a port constructed without an explicit runner falls back to
 * `defaultRunner` and is unmetered and unretried. In the production orchestrator
 * the shared runner (`scripts/run-autopilot-v2.ts:496`) is threaded into the
 * lifecycle reader, the conditional REST client and the active runtime's action
 * ports, so those are covered; the CLI and triage entry points are not.
 *
 * Retryability is decided entirely by the positive read allowlist in
 * `transient-retry.ts`; every mutation crossing this boundary keeps exactly one
 * attempt.
 *
 * WHY THE TWO JOBS ARE COUPLED HERE RATHER THAN COMPOSED BY CALLERS. This
 * function now does two things — meter, and retry — and the obvious split is to
 * export them separately and let each installer write
 * `makeGitHubUsageCommandRunner(withTransientReadRetry(raw, …), meter)`. That is
 * mechanically possible; it is refused because it converts two structural
 * guarantees into call-site conventions:
 *
 *   - ORDER. Retry must sit BENEATH the meter. Composed the other way round —
 *     `withTransientReadRetry(makeGitHubUsageCommandRunner(raw, meter))`, which
 *     reads just as naturally — every retried attempt is separately metered, so
 *     a transport blip silently inflates REST counts and re-runs the opaque
 *     probe pair. Nothing in the type signature distinguishes the two
 *     compositions: both are `CommandRunner`. Owning the order here makes the
 *     wrong one unwritable.
 *   - COVERAGE. Three call sites install this boundary — the orchestrator's
 *     shared runner (`scripts/run-autopilot-v2.ts:496`), `GhLifecycleReader`
 *     (`src/lifecycle/github-reader.ts:793`) and `ConditionalRestClient`
 *     (`src/lifecycle/github-rest.ts:260`) — and each of the latter two builds
 *     it internally for callers who passed only a raw runner. Splitting makes
 *     every one of them re-derive the wiring, including the `onRetry` sink that
 *     needs this exact meter; one installer that forgot would lose retry
 *     coverage with no test failing, which is the same silent-drift failure mode
 *     the derived-argv tests in `test/lifecycle/transient-retry.test.ts` exist to
 *     prevent.
 *
 * The coupling is also narrow in substance: the retry decision itself lives
 * entirely in `transient-retry.ts`, and this function contributes only the
 * ordering and the `onRetry` sink. Nothing here inspects argv to decide
 * retryability.
 */
export function makeGitHubUsageCommandRunner(
  rawRun: CommandRunner,
  meter: GitHubUsageMeter,
  config: { readonly rateLimitFloor?: number } = {},
): CommandRunner {
  // No backoff seam is forwarded: retry timing is not configurable from here,
  // so no caller can zero the backoff of a production runner.
  const run = withTransientReadRetry(rawRun, {
    onRetry: (event) => meter.recordTransientReadRetry(event.command, event.fault),
  });
  const probeArgs = ['api', 'graphql', '-f', `query=${OPAQUE_USAGE_PROBE}`];
  return async (command, args, options) => {
    if (command !== 'gh') return run(command, args, options);
    // NOTE: this meter routes GraphQL by argument position (`args[1]`), so an
    // invocation like `gh api -X GET graphql …` would be metered down the REST
    // branch. That is a pre-existing metering imprecision, not a safety hole —
    // the retry allowlist finds the `graphql` operand positionally-independently
    // and is what decides whether anything may be re-sent. Left unchanged here
    // deliberately; changing metering shape is out of scope for this fix.
    if (args[0] === 'api' && args[1] !== 'graphql') {
      if (args.includes('--paginate')) {
        // --paginate collapses N HTTP pages into a single gh invocation. That
        // was treated as making the per-page count unobservable for every
        // paginated command, which marked accounting incomplete on every cycle
        // that read a PR's comments or changed files. It is only true for the
        // forms that merge or filter the pages away: `--slurp` returns one
        // array element PER PAGE, so those responses carry their own exact
        // count and just needed reading. Per #2013 this stays best-effort and
        // must never fail a command or crash the loop.
        //
        // No request behaviour changes: the same argv runs exactly once on
        // both paths, and REST counts gate nothing (only `graphqlRemaining`
        // feeds the reserve check, in the opaque branch below).
        if (!args.includes('--slurp')) {
          meter.markIncomplete(
            'a `gh api --paginate` command without `--slurp` merged its response '
              + 'pages, so its page count is unobservable',
          );
          meter.recordRestRequest();
          return run(command, args, options);
        }
        let raw: string;
        try {
          raw = await run(command, args, options);
        } catch (error) {
          // At least one page was attempted; how many is unknowable now.
          meter.markIncomplete(
            'a paginated REST command failed before its page count could be read',
          );
          meter.recordRestRequest();
          throw error;
        }
        const pages = slurpedRestPageCount(raw);
        if (pages === null) {
          meter.markIncomplete(
            'a `gh api --paginate --slurp` response was not a page array, so its '
              + 'page count is unreadable',
          );
          meter.recordRestRequest();
          return raw;
        }
        for (let page = 0; page < pages; page += 1) meter.recordRestRequest();
        return raw;
      }
      if (!args.includes('--include')) {
        meter.recordRestRequest();
        return run(command, args, options);
      }
      try {
        const raw = await run(command, args, options);
        meter.recordRestRequest(includedRestStatus(raw));
        return raw;
      } catch (error) {
        const stdout = commandErrorStdout(error);
        meter.recordRestRequest(stdout === null ? undefined : includedRestStatus(stdout));
        throw error;
      }
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      const credentialKey = ephemeralCredentialKey(options);
      let raw: string;
      try {
        raw = await run(command, args, options);
      } catch (error) {
        meter.markIncomplete('an explicit GraphQL command lacked rate-limit evidence');
        throw error;
      }
      let response: unknown;
      try {
        response = JSON.parse(raw) as unknown;
        assertSuccessfulGraphQlResult(response);
      } catch (error) {
        meter.markIncomplete('an explicit GraphQL command returned an invalid result');
        throw error;
      }
      try {
        meter.recordGraphQlResponse(response, credentialKey);
      } catch {
        meter.recordGraphQlRequestWithoutRateLimit(
          'an explicit GraphQL command lacked usable rate-limit evidence',
        );
      }
      return raw;
    }

    return meter.serializeOpaque(async () => {
      if (config.rateLimitFloor !== undefined) {
        const cachedRemaining = meter.read().graphqlRemaining;
        if (cachedRemaining !== null) {
          assertRateLimitReserve(
            cachedRemaining,
            OPAQUE_GH_COMMAND_RESERVE,
            config.rateLimitFloor,
          );
        }
      }
      const credentialKey = ephemeralCredentialKey(options);
      let before: unknown;
      let opening: ReturnType<typeof opaqueRateLimitEvidence>;
      try {
        before = JSON.parse(await run('gh', probeArgs, options)) as unknown;
        opening = opaqueRateLimitEvidence(before);
      } catch (error) {
        meter.markIncomplete('the opening opaque-command quota probe failed');
        throw error;
      }
      if (config.rateLimitFloor !== undefined) {
        try {
          assertRateLimitReserve(
            opening.remaining,
            OPAQUE_GH_COMMAND_RESERVE,
            config.rateLimitFloor,
          );
        } catch (error) {
          // The opening probe is a real GraphQL request even when it prevents
          // the opaque command. Keep that complete evidence in cycle usage.
          meter.recordGraphQlResponse(before, credentialKey);
          throw error;
        }
      }
      let result: string | undefined;
      let commandError: unknown;
      try {
        result = await run(command, args, options);
      } catch (error) {
        commandError = error;
      }
      // The closing quota probe and its span are best-effort accounting, never
      // the command's result. A probe that fails to transport or a probe span
      // that is skewed/unparseable must never fail a command that already
      // succeeded, and must never crash the loop — it only marks accounting
      // incomplete. The command's own failure is the sole reason to throw.
      let probeError: unknown;
      let after: unknown;
      try {
        after = JSON.parse(await run('gh', probeArgs, options)) as unknown;
      } catch (error) {
        probeError = error;
        meter.markIncomplete('the closing opaque-command quota probe failed');
      }
      if (after !== undefined) {
        try {
          meter.recordOpaqueGraphQlSpan(before, after, credentialKey);
        } catch (error) {
          // A structurally-undecodable closing probe is still accounting-only.
          meter.markIncomplete(
            `the closing opaque-command quota probe was unusable: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      if (commandError !== undefined) {
        if (probeError !== undefined) {
          throw new AggregateError(
            [commandError, probeError],
            'GitHub command and usage probe failed',
          );
        }
        throw commandError;
      }
      return result!;
    });
  };
}

export function requiredRateLimitRemaining(reserve: number, floor = DEFAULT_FLOOR): number {
  if (!Number.isSafeInteger(reserve) || reserve < 0) {
    throw new Error('GitHub rate-limit reserve must be a non-negative integer');
  }
  if (!Number.isSafeInteger(floor) || floor < 0) {
    throw new Error('GitHub rate-limit floor must be a non-negative integer');
  }
  return Math.max(DEFAULT_FLOOR, floor) + reserve;
}

export function assertRateLimitReserve(
  remaining: number,
  reserve: number,
  floor = DEFAULT_FLOOR,
): void {
  if (!Number.isSafeInteger(remaining) || remaining < 0) {
    throw new Error('GitHub rate-limit remaining must be a non-negative integer');
  }
  const required = requiredRateLimitRemaining(reserve, floor);
  if (remaining < required) {
    throw new GitHubRateLimitReserveError(remaining, required, reserve);
  }
}
