import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { argv, env, pid } from 'node:process';
import { INTERNAL_DAEMON_ACTIVE_ONCE_ENV } from '../src/service.js';
import {
  AUTOPILOT_RUNTIME_ENV,
  parseAutopilotRuntime,
} from '../src/autopilot-runtime.js';
import {
  loadAutopilotConfig,
  type AutopilotConfig,
} from '../src/config/config.js';
import {
  parseAutopilotExecutionBackend,
} from '../src/config/execution-backend.js';
import {
  MarketplaceSessionExecutionBackend,
  recoverPreparedMarketplaceAttempts,
} from '../src/lifecycle/session-execution-backend.js';
import {
  MARKETPLACE_LANGUAGE,
  MARKETPLACE_VERIFICATION_PROFILE,
  MarketplaceTaskCliAdapter,
} from '../src/lifecycle/marketplace-task.js';
import {
  assertMarketplaceRuntimeProfile,
} from '../src/lifecycle/active-runtime-production.js';
import type { SpawnFn } from '../src/dispatcher/coordinator-session.js';
import {
  paintBoardOptionsFromConfig,
  runPaintBoard,
} from './paint-board.js';
import {
  CURSOR_BIN_ENV,
  CURSOR_MODEL_ENV,
} from '../src/dispatcher/cursor-runtime.js';
import {
  defaultRunner,
  type CommandRunner,
} from '../src/dispatcher/issue-source.js';
import { DEFAULT_CONFIG, type DispatcherConfig } from '../src/dispatcher/types.js';
import { DEFAULT_FLOOR } from '../src/dispatcher/rate-limit-guard.js';
import { configureRepositoryConstants } from '../src/dispatcher/constants.js';
import { configureCanonicalGitHubRemote } from '../src/lifecycle/implementation-executor.js';
import { shouldRouteToSession } from '../src/cli/routing.js';
import {
  ConditionalPullRequestEvidenceProbe,
  ConditionalRestClient,
  defaultRunnerId,
  activeCleanupEnabled,
  attemptGraceMs,
  autopilotDiskFloorBytes,
  explainIssue,
  explainPullRequest,
  GhLifecycleReader,
  GitHubRestDiscoveryReader,
  GitHubUsageIncompleteError,
  GitHubUsageMeter,
  createConfiguredIncrementalLifecycleSnapshotSource,
  isRoutineCachedStatus,
  LifecycleSnapshotCoordinator,
  LifecycleDiscoveryCacheCorruptError,
  LifecycleDiscoveryCacheStore,
  makeProductionActiveRuntime,
  makeGitHubUsageCommandRunner,
  makeProductionReconciliationWriter,
  makeTargetedActionReader,
  targetedAuthorityRefusalDetail,
  targetedAuthoritySnapshot,
  assertRateLimitReserve,
  MAX_FULL_RECONCILIATION_AGE_MS,
  REVIEW_CLAIM_ACTION_RESERVE,
  TARGETED_PR_RESERVE,
  TARGETED_PROJECT_ITEM_RESERVE,
  parseLifecycleCli,
  parseAutopilotStateDirectory,
  parseSnapshotRuntimeConfig,
  recoverMarketplaceAttemptInitializations,
  renderLifecycleHuman,
  renderLifecycleJson,
  resolveCredentialPool,
  runLifecycleCadence,
  runLifecycleCycle,
  sanitizedGitHubCommandOverlay,
  selectCredential,
  sweepDeadAttempts,
  freeDiskBytes,
  type LifecycleCycleReport,
  type CredentialPool,
  type SelectedCredential,
} from '../src/lifecycle/index.js';

export function lifecycleExitCodeForReport(
  report: Pick<LifecycleCycleReport, 'status'>,
  once: boolean,
): number | undefined {
  if (report.status === 'rejected') return 2;
  if (report.status === 'failed' && once) return 1;
  return undefined;
}

export async function loadDaemonCadenceSeed(
  context: {
    readonly mode: 'observe' | 'recover' | 'active';
    readonly once: boolean;
  },
  environment: Readonly<Record<string, string | undefined>>,
  readSeed: () => Promise<string | null>,
): Promise<string | null> {
  if (
    context.mode !== 'active'
    || !context.once
    || environment[INTERNAL_DAEMON_ACTIVE_ONCE_ENV] !== '1'
  ) {
    return null;
  }
  try {
    return await readSeed();
  } catch (error) {
    if (error instanceof LifecycleDiscoveryCacheCorruptError) return null;
    throw error;
  }
}

function authorAllowlist(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((login) => login.trim().toLowerCase())
      .filter((login) => login.length > 0),
  );
}

// jinn-mono#1883: canary safety knob. `JINN_AUTOPILOT_ONLY_ISSUES` unset or
// empty (including an explicitly-set empty string) is unrestricted — a pure
// no-op matching current behavior. Set to a comma-separated list of positive
// issue numbers to restrict active-mode NEW-WORK claim scheduling to those
// issues only (see the `onlyIssues` threading through active-runtime.ts /
// active-runtime-production.ts / controller.ts). Malformed input fails loud,
// matching the other JINN_AUTOPILOT_* env knobs in this file.
export function parseOnlyIssuesAllowlist(
  raw: string | undefined,
): ReadonlySet<number> | undefined {
  const segments = (raw ?? '')
    .split(',')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return undefined;
  return new Set(segments.map((segment) => {
    if (!/^[1-9][0-9]*$/.test(segment) || !Number.isSafeInteger(Number(segment))) {
      throw new Error(
        'JINN_AUTOPILOT_ONLY_ISSUES must be a comma-separated list of positive issue numbers',
      );
    }
    return Number(segment);
  }));
}

function positiveEnvironmentInteger(
  raw: string | undefined,
  fallback: number,
  label: string,
): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is too large`);
  return value;
}

function warnLegacyOverride(name: string): void {
  console.warn(
    `[autopilot:v2] warning: ${name} is a temporary legacy override; `
    + 'prefer .autopilot/config.json',
  );
}

function configuredEnvironment(
  product: AutopilotConfig,
  repositoryHome: string,
  stateDirectory: string,
  capabilityAttestation: string,
  configPath: string,
): NodeJS.ProcessEnv {
  return {
    ...env,
    JINN_AUTOPILOT_STATE_DIRECTORY:
      env.JINN_AUTOPILOT_STATE_DIRECTORY ?? stateDirectory,
    JINN_AUTOPILOT_CAPABILITY_ATTESTATION:
      env.JINN_AUTOPILOT_CAPABILITY_ATTESTATION ?? capabilityAttestation,
    JINN_AUTOPILOT_FULL_RECONCILE_MS:
      env.JINN_AUTOPILOT_FULL_RECONCILE_MS
      ?? String(product.scheduler.fullReconcileSeconds * 1_000),
    JINN_AUTOPILOT_CHILDREN:
      env.JINN_AUTOPILOT_CHILDREN ?? String(product.safety.children),
    JINN_AUTOPILOT_CARRYOVER:
      env.JINN_AUTOPILOT_CARRYOVER ?? String(product.safety.carryover),
    JINN_AUTOPILOT_CLEANUP_ENABLED:
      env.JINN_AUTOPILOT_CLEANUP_ENABLED ?? String(product.safety.cleanup),
    JINN_AUTOPILOT_DISK_FLOOR_GB:
      env.JINN_AUTOPILOT_DISK_FLOOR_GB ?? String(product.safety.diskFloorGb),
    JINN_IMPL_GH_TOKEN:
      env.AUTOPILOT_GITHUB_IMPLEMENT_TOKEN ?? env.JINN_IMPL_GH_TOKEN,
    JINN_REVIEW_GH_TOKEN:
      env.AUTOPILOT_GITHUB_REVIEW_TOKEN ?? env.JINN_REVIEW_GH_TOKEN,
    AUTOPILOT_CONFIG_PATH: configPath,
    AUTOPILOT_HERMES_HOMES_DIR: join(repositoryHome, 'hermes-homes'),
  };
}

export function executionBackendForEnvironment(
  environment: NodeJS.ProcessEnv,
): ReturnType<typeof parseAutopilotExecutionBackend> {
  return parseAutopilotExecutionBackend(
    environment.JINN_AUTOPILOT_EXECUTION_BACKEND,
  );
}

export async function preflightProductionEntrypoint<Value>(
  _mode: 'observe' | 'recover' | 'active',
  _environment: NodeJS.ProcessEnv,
  setup: () => Promise<Value>,
): Promise<Value> {
  return setup();
}

export function makeMarketplaceRecoveryCallback(input: {
  readonly mode: 'observe' | 'recover' | 'active';
  readonly executionBackend: 'local' | 'marketplace';
  readonly repositorySlug: string;
  readonly language?: string;
  readonly verificationProfile?: string;
  readonly replay: () => Promise<unknown>;
}): (() => Promise<void>) | undefined {
  if (input.executionBackend !== 'marketplace' || input.mode === 'observe') {
    return undefined;
  }
  return async (): Promise<void> => {
    assertMarketplaceRuntimeProfile({
      repository: input.repositorySlug,
      language: input.language ?? MARKETPLACE_LANGUAGE,
      verificationProfile:
        input.verificationProfile ?? MARKETPLACE_VERIFICATION_PROFILE,
    });
    await input.replay();
  };
}

export function makeMarketplaceRecoveryCredentialResolver(
  credentials: CredentialPool,
): (normalizedLogin: string) => SelectedCredential {
  return (normalizedLogin: string): SelectedCredential => {
    const selection = selectCredential(
      credentials.restrictedTo([normalizedLogin]),
      { phase: 'implement' },
    );
    if (
      selection.status !== 'selected'
      || selection.credential.normalizedLogin !== normalizedLogin
    ) {
      throw new Error(
        `Marketplace recovery credential ${normalizedLogin} is unavailable`,
      );
    }
    return selection.credential;
  };
}

export function shouldSweepAttempts(input: {
  readonly mode: 'observe' | 'recover' | 'active';
  readonly executionBackend: 'local' | 'marketplace';
  readonly cleanupEnabled: boolean;
  readonly hasMaintenanceCredential: boolean;
  readonly report: {
    readonly status: LifecycleCycleReport['status'];
    readonly snapshotComplete?: boolean;
  };
}): boolean {
  return input.mode === 'active'
    && input.executionBackend === 'local'
    && input.cleanupEnabled
    && input.hasMaintenanceCredential
    && input.report.status === 'ok'
    && input.report.snapshotComplete === true;
}

function dispatcherConfig(
  allowlist: ReadonlySet<string>,
  product: AutopilotConfig,
  environment: NodeJS.ProcessEnv,
): DispatcherConfig {
  return {
    ...DEFAULT_CONFIG,
    runtime: parseAutopilotRuntime(
      environment[AUTOPILOT_RUNTIME_ENV] ?? product.worker.runtime,
    ),
    authorAllowlist: [...allowlist],
    concurrencyCap: product.scheduler.implementationConcurrency,
    reviewCap: product.scheduler.reviewConcurrency,
    openPrBackpressure: product.scheduler.openPrBackpressure,
    reviewBotLogin: environment.JINN_REVIEW_BOT_LOGIN ?? '',
    implGhToken: environment.JINN_IMPL_GH_TOKEN ?? '',
    reviewGhToken: environment.JINN_REVIEW_GH_TOKEN ?? '',
    hermesModel:
      environment.JINN_DISPATCHER_HERMES_MODEL ?? product.worker.model,
    hermesProvider:
      environment.JINN_DISPATCHER_HERMES_PROVIDER ?? product.worker.provider,
    ...(environment.JINN_DISPATCHER_HERMES_PYTHON === undefined
      ? {}
      : { hermesPythonPath: environment.JINN_DISPATCHER_HERMES_PYTHON }),
    ...(environment[CURSOR_MODEL_ENV] === undefined
      ? {}
      : { cursorModel: environment[CURSOR_MODEL_ENV] }),
    ...(environment[CURSOR_BIN_ENV] === undefined
      ? {}
      : { cursorBin: environment[CURSOR_BIN_ENV] }),
  };
}

function selectedReadRunner(
  token: string,
  ambient: NodeJS.ProcessEnv,
): CommandRunner {
  const selected = {
    ...sanitizedGitHubCommandOverlay(ambient, { GH_TOKEN: token }),
  };
  return (command, args, options) => defaultRunner(command, args, {
    ...options,
    env: { ...selected, ...options?.env },
  });
}

function makeLoggingSpawn(): SpawnFn {
  return (command, args, options) => {
    const { onExit, logPath, ...spawnOptions } = options;
    let descriptor: number | undefined;
    let stdio = options.stdio;
    try {
      if (logPath !== undefined) {
        mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
        descriptor = openSync(logPath, 'a', 0o600);
        writeSync(
          descriptor,
          `\n===== active dispatch ${new Date().toISOString()} pid=pending =====\n`,
        );
        stdio = ['ignore', descriptor, descriptor];
      }
      const child = spawn(command, args, {
        ...spawnOptions,
        detached: true,
        stdio,
      } as SpawnOptions) as ChildProcess;
      if (onExit !== undefined) {
        let completed = false;
        const finish = (
          code: number | null,
          signal: NodeJS.Signals | null,
        ) => {
          if (completed) return;
          completed = true;
          onExit(code, signal);
        };
        child.once('error', () => finish(null, null));
        child.once('exit', finish);
      }
      child.unref();
      const result = {
        pid: child.pid,
        get exitCode() {
          return child.exitCode;
        },
        once(event: 'exit', listener: (...args: unknown[]) => void) {
          child.once(event, listener);
          return result;
        },
      };
      return result;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  };
}

function childIsAlive(childPid: number): boolean {
  try {
    process.kill(childPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function runAutopilotV2(
  arguments_: readonly string[] = argv.slice(2),
): Promise<void> {
  if (
    arguments_[0] === 'session'
    || shouldRouteToSession(['node', 'autopilot', ...arguments_])
  ) {
    const { runSessionCli } = await import('../src/cli/session.js');
    await runSessionCli(arguments_[0] === 'session'
      ? arguments_.slice(1)
      : arguments_);
    return;
  }

  const options = parseLifecycleCli(arguments_);
  // Repository/config setup is shared by both execution backends. Marketplace
  // capability validation runs later through the active controller's
  // mutation-free preflight boundary.
  const repositoryPath = (await preflightProductionEntrypoint(
    options.mode,
    env,
    () => defaultRunner('git', [
      'rev-parse', '--path-format=absolute', '--show-toplevel',
    ]),
  )).trim();
  const loaded = await loadAutopilotConfig(repositoryPath, env);
  configureRepositoryConstants({
    repositorySlug: loaded.config.repository.slug,
    repositoryRestDatabaseId: loaded.config.repository.restDatabaseId,
    projectOwner: loaded.config.project.owner,
    projectNumber: loaded.config.project.number,
  });
  configureCanonicalGitHubRemote(loaded.config.repository.remote.url);
  const runtimeEnvironment = configuredEnvironment(
    loaded.config,
    loaded.paths.root,
    loaded.paths.state,
    loaded.paths.capabilityAttestation,
    loaded.configPath,
  );
  const executionBackend = executionBackendForEnvironment(runtimeEnvironment);
  const snapshotRuntime = parseSnapshotRuntimeConfig(runtimeEnvironment);
  const stateDirectory = parseAutopilotStateDirectory(runtimeEnvironment);
  const cadenceSeed = await loadDaemonCadenceSeed(
    options,
    runtimeEnvironment,
    () => new LifecycleDiscoveryCacheStore({
      ...(stateDirectory === undefined ? {} : { stateDirectory }),
    }).readCadenceSeed(),
  );
  const legacyAllowlist = env.JINN_DISPATCHER_AUTHOR_ALLOWLIST;
  if (legacyAllowlist !== undefined && legacyAllowlist.trim().length > 0) {
    warnLegacyOverride('JINN_DISPATCHER_AUTHOR_ALLOWLIST');
  }
  const allowlist = legacyAllowlist === undefined || legacyAllowlist.trim().length === 0
    ? new Set(loaded.config.triage.allowedAuthors.map((login) => login.toLowerCase()))
    : authorAllowlist(legacyAllowlist);
  const onlyIssues = parseOnlyIssuesAllowlist(env.JINN_AUTOPILOT_ONLY_ISSUES);
  const config = dispatcherConfig(allowlist, loaded.config, runtimeEnvironment);
  const staleAfterMs = positiveEnvironmentInteger(
    env.JINN_AUTOPILOT_STALE_AFTER_MS,
    loaded.config.safety.staleAfterSeconds * 1_000,
    'JINN_AUTOPILOT_STALE_AFTER_MS',
  );
  console.log(`[autopilot:v2] runtime=${config.runtime}`);
  if (config.runtime === 'cursor') {
    console.log(
      `[autopilot:v2] cursor config (bin=${config.cursorBin}, reviewModel=${config.cursorModel})`,
    );
  }
  const runnerId = defaultRunnerId({
    configured: env.JINN_AUTOPILOT_RUNNER_ID,
    environment: env,
    pid,
  });
  let runner: CommandRunner = defaultRunner;
  let credentials: Awaited<ReturnType<typeof resolveCredentialPool>> | undefined;
  let maintenanceCredential: SelectedCredential | undefined;
  if (options.mode !== 'observe') {
    credentials = await resolveCredentialPool({
      JINN_IMPL_GH_TOKEN: runtimeEnvironment.JINN_IMPL_GH_TOKEN,
      JINN_REVIEW_GH_TOKEN: runtimeEnvironment.JINN_REVIEW_GH_TOKEN,
      JINN_REVIEW_BOT_LOGIN: runtimeEnvironment.JINN_REVIEW_BOT_LOGIN,
    }, defaultRunner);
    const selected = selectCredential(credentials, { phase: 'implement' });
    if (selected.status !== 'selected') throw new Error(selected.detail);
    maintenanceCredential = selected.credential;
    runner = selectedReadRunner(selected.credential.secret(), env);
  }
  // One cycle-scoped boundary owns usage for every GitHub command below —
  // reader queries, reconciliation, board archive, and active action ports.
  // Credential overlays are applied inside those ports and flow unchanged
  // through this runner to its authenticated quota probes.
  const usageMeter = new GitHubUsageMeter();
  runner = makeGitHubUsageCommandRunner(runner, usageMeter, {
    rateLimitFloor: DEFAULT_FLOOR,
  });
  const machineAuthorLogins = new Set(
    (credentials?.logins() ?? []).map((login) => login.toLowerCase()),
  );
  // jinn-mono#1883-follow-up: review-claim refs (refs/jinn-autopilot/...) are
  // read over the git transport, not GraphQL (GitHub's `ref(qualifiedName:)`
  // permanently returns null for this custom namespace — proven live).
  // `remoteName` defaults to the canonical HTTPS URL inside GhLifecycleReader
  // itself, so it's passed explicitly here only for self-documentation; using
  // the URL (not the `jinn-autopilot-v2` named remote) means observe/recover
  // never depend on the runbook's "configure jinn-autopilot-v2" step, which
  // the cutover runbook deliberately runs an observe-mode smoke test before.
  const reader = new GhLifecycleReader(runner, {
    repositoryPath,
    remoteName: loaded.config.repository.remote.url,
    repositorySlug: loaded.config.repository.slug,
    projectOwner: loaded.config.project.owner,
    projectNumber: loaded.config.project.number,
    usageMeter,
    runnerIsMetered: true,
  });
  const conditionalRest = new ConditionalRestClient(runner, {
    usageMeter,
    runnerIsMetered: true,
  });
  const restDiscovery = new GitHubRestDiscoveryReader(conditionalRest, {
    repositorySlug: loaded.config.repository.slug,
    repositoryRestDatabaseId: loaded.config.repository.restDatabaseId,
    projectOwner: loaded.config.project.owner,
    projectNumber: loaded.config.project.number,
  });
  const snapshotSource = createConfiguredIncrementalLifecycleSnapshotSource({
    fullReader: reader,
    restDiscovery,
    conditionalRest,
    evidenceProbe: new ConditionalPullRequestEvidenceProbe(
      conditionalRest,
      loaded.config.repository.slug,
      restDiscovery,
    ),
    authorAllowlist: allowlist,
    machineAuthorLogins,
    defaultBranch: loaded.config.repository.defaultBranch,
  }, stateDirectory);
  // A persistent observe loop is a runner and takes the same authoritative
  // startup full as recover/active. Only one-shot, read-only status may
  // degrade to a partial cache view.
  const routineStatus = isRoutineCachedStatus({
    mode: options.mode,
    once: options.once,
    commandKind: options.command.kind,
    fullReconcile: options.fullReconcile,
  });
  const snapshotCoordinator = new LifecycleSnapshotCoordinator({
    source: snapshotSource,
    configuredMode: snapshotRuntime.mode,
    fullReconcileMs: snapshotRuntime.fullReconcileMs,
    startupFull: !routineStatus,
    allowPartial: routineStatus,
    cadenceSeed,
    forceFull: options.fullReconcile,
    readUsage: () => reader.githubUsage(),
  });
  const readCycleSnapshot = (rateLimitFloor = DEFAULT_FLOOR) => (
    snapshotCoordinator.read(rateLimitFloor)
  );
  const currentGraphQlRemaining = async (): Promise<number> => {
    return reader.readGraphQlRemaining();
  };
  const targeted = makeTargetedActionReader({
    authorAllowlist: allowlist,
    machineAuthorLogins,
    defaultBranch: loaded.config.repository.defaultBranch,
    rateLimitFloor: DEFAULT_FLOOR,
    readGraphQlRemaining: currentGraphQlRemaining,
    readPullRequest: (prNumber) => reader.readPullRequestForReconciliation(prNumber),
    readOpenPullRequestIndex: () => restDiscovery.readOpenPullRequestIndex(),
    readProjectItem: (issueNumber) => reader.readProjectItemForReconciliation(issueNumber),
    readIssue: (issueNumber) => restDiscovery.readIssueForAction(issueNumber),
    readBlockedByIssueNumbers: (issueNumber) =>
      restDiscovery.readBlockedByIssueNumbersForAction(issueNumber),
    readIssueActionContext: (issueNumber) =>
      reader.readIssueActionContextForReconciliation(issueNumber),
    readOpenPullRequestNumbersClosingIssue: (issueNumber) =>
      reader.readPullRequestNumbersClosingIssues([issueNumber]),
    readPullRequestOutcomeNumbersClosingIssues: (issueNumbers) =>
      reader.readPullRequestOutcomeNumbersClosingIssues(issueNumbers),
    readPullRequestDetails: (prNumber) => restDiscovery.readPullRequestForAction(prNumber),
  });
  const withTargetedReserve = async <Value>(
    reserve: number,
    operation: () => Promise<Value>,
  ): Promise<Value> => {
    assertRateLimitReserve(
      await currentGraphQlRemaining(),
      reserve,
      DEFAULT_FLOOR,
    );
    return operation();
  };
  const reconciliationTargets = {
    readPullRequestByNumber: (prNumber: number) =>
      withTargetedReserve(
        TARGETED_PR_RESERVE,
        () => reader.readPullRequestForReconciliation(prNumber),
      ),
    readProjectItemForReconciliation: (issueNumber: number) =>
      withTargetedReserve(
        TARGETED_PROJECT_ITEM_RESERVE,
        () => reader.readProjectItemForReconciliation(issueNumber),
      ),
    readBranchHeadByName: (headRefName: string) =>
      reader.readBranchHeadForReconciliation(headRefName),
    readBranchClaimByName: (headRefName: string) =>
      reader.readBranchClaimForReconciliation(headRefName),
    readIssueByNumber: (issueNumber: number) => restDiscovery.readIssueForAction(issueNumber),
    readBlockedByIssueNumbers: (issueNumber: number) =>
      restDiscovery.readBlockedByIssueNumbersForAction(issueNumber),
    readIssueActionContext: (issueNumber: number) =>
      targeted.readIssueActionContext!(issueNumber),
    readOpenPullRequestsByIssue: (issueNumber: number) =>
      targeted.readOpenPullRequests(issueNumber),
  };
  // Stage 3: board-archive + Status paint live in `yarn paint-board`
  // (scheduled workflow), not the autopilot cycle.
  const worktreeBase =
    env.JINN_AUTOPILOT_WORKTREE_BASE ?? loaded.paths.attempts;
  const v2AttemptsBase = join(worktreeBase, 'v2');
  const marketplaceTaskAdapter =
    executionBackend === 'marketplace' && options.mode !== 'observe'
      ? new MarketplaceTaskCliAdapter({ environment: runtimeEnvironment })
      : undefined;
  const marketplaceExecutionBackend = marketplaceTaskAdapter === undefined
    ? undefined
    : new MarketplaceSessionExecutionBackend({
        adapter: marketplaceTaskAdapter,
        now: () => new Date(),
      });
  const recoverMarketplaceAttempts =
    marketplaceExecutionBackend === undefined
      ? undefined
      : makeMarketplaceRecoveryCallback({
          mode: options.mode,
          executionBackend,
          repositorySlug: loaded.config.repository.slug,
          replay: async (): Promise<void> => {
            await recoverMarketplaceAttemptInitializations(
              v2AttemptsBase,
              runner,
              makeMarketplaceRecoveryCredentialResolver(credentials!),
            );
            await recoverPreparedMarketplaceAttempts(
              v2AttemptsBase,
              marketplaceExecutionBackend,
            );
          },
        });
  const cleanupEnabled = options.mode === 'active'
    && activeCleanupEnabled(
      env.JINN_AUTOPILOT_CLEANUP_ENABLED,
      'JINN_AUTOPILOT_CLEANUP_ENABLED',
    );
  const attemptGracePeriodMs = attemptGraceMs(env.JINN_AUTOPILOT_ATTEMPT_GRACE_MS);
  const diskFloorBytes = autopilotDiskFloorBytes(
    runtimeEnvironment.JINN_AUTOPILOT_DISK_FLOOR_GB,
  );
  const diskBelowFloor = (): boolean =>
    diskFloorBytes > 0 && freeDiskBytes(v2AttemptsBase) < diskFloorBytes;

  const writerForSnapshot = credentials === undefined
    ? undefined
    : (() => {
        const selection = selectCredential(credentials!, { phase: 'implement' });
        if (selection.status !== 'selected') throw new Error(selection.detail);
        return (cycleSnapshot: Awaited<ReturnType<typeof readCycleSnapshot>>) =>
          makeProductionReconciliationWriter({
            repositoryPath,
            cycleSnapshot,
            ...reconciliationTargets,
            readCanonicalSnapshot: async (prNumber) => targetedAuthoritySnapshot(
              await targeted.readPullRequest(cycleSnapshot, prNumber),
            ),
            credential: selection.credential,
            credentials,
            runner,
            environment: runtimeEnvironment,
            repositorySlug: loaded.config.repository.slug,
            repositoryUrl: loaded.config.repository.remote.url,
            defaultBranch: loaded.config.repository.defaultBranch,
          });
      })();
  const active = options.mode !== 'active'
    ? undefined
    : makeProductionActiveRuntime({
        executionBackend,
        repositoryPath,
        worktreeBase,
        runnerId,
        credentials: credentials!,
        authorAllowlist: allowlist,
        readReviewSnapshot: (cycleSnapshot, prNumber) =>
          targeted.readPullRequest(cycleSnapshot, prNumber),
        readReservedReviewSnapshot: (cycleSnapshot, prNumber) =>
          targeted.readReservedPullRequest(cycleSnapshot, prNumber),
        readImplementationSnapshot: async (cycleSnapshot, action) => {
          const read = action.intent === 'stale-recovery'
            ? await targeted.readStaleRecoveryPullRequest(cycleSnapshot, action.prNumber)
            : (await targeted.readIssue(cycleSnapshot, action.issueNumber))?.snapshot ?? null;
          const targetedSnapshot = targetedAuthoritySnapshot(read);
          if (targetedSnapshot === null) {
            const detail = targetedAuthorityRefusalDetail(read);
            throw new Error(
              `Targeted implementation authority for issue #${action.issueNumber} is unavailable`
              + (detail === null ? '' : ` (${detail})`),
            );
          }
          return targetedSnapshot;
        },
        reserveReviewCohort: async (size) => {
          assertRateLimitReserve(
            await currentGraphQlRemaining(),
            REVIEW_CLAIM_ACTION_RESERVE * size,
            DEFAULT_FLOOR,
          );
        },
        ...reconciliationTargets,
        config,
        spawn: makeLoggingSpawn(),
        caps: {
          implementation: positiveEnvironmentInteger(
            env.JINN_AUTOPILOT_IMPLEMENTATION_CAP,
            config.concurrencyCap,
            'JINN_AUTOPILOT_IMPLEMENTATION_CAP',
          ),
          review: positiveEnvironmentInteger(
            env.JINN_AUTOPILOT_REVIEW_CAP,
            config.reviewCap,
            'JINN_AUTOPILOT_REVIEW_CAP',
          ),
        },
        implementationBackpressureThreshold: positiveEnvironmentInteger(
          env.JINN_AUTOPILOT_BACKPRESSURE,
          config.openPrBackpressure,
          'JINN_AUTOPILOT_BACKPRESSURE',
        ),
        onlyIssues,
        staleAfterMs,
        runner,
        environment: runtimeEnvironment,
        remoteName: loaded.config.repository.remote.name,
        repositorySlug: loaded.config.repository.slug,
        repositoryUrl: loaded.config.repository.remote.url,
        defaultBranch: loaded.config.repository.defaultBranch,
        projectMapping: loaded.config.project,
        newWorkPaused: diskBelowFloor,
        ...(marketplaceTaskAdapter === undefined
          ? {}
          : { marketplaceTaskAdapter }),
        ...(marketplaceExecutionBackend === undefined
          ? {}
          : { marketplaceExecutionBackend }),
      });

  const runOnce = async (): Promise<void> => {
    let report: Awaited<ReturnType<typeof runLifecycleCycle>>;
    try {
      report = await runLifecycleCycle(options.mode, {
        readSnapshot: readCycleSnapshot,
        readScopedSnapshot: (issueNumbers, rateLimitFloor) =>
          snapshotCoordinator.readScoped(
            issueNumbers,
            rateLimitFloor,
            MAX_FULL_RECONCILIATION_AGE_MS,
          ),
        resetGitHubUsage: () => reader.resetGitHubUsage(),
        readGitHubUsage: () => reader.githubUsage(),
        ...(writerForSnapshot === undefined ? {} : { writerForSnapshot }),
        ...(active === undefined ? {} : { active }),
        ...(recoverMarketplaceAttempts === undefined
          ? {}
          : { recoverMarketplaceAttempts }),
        now: () => new Date(),
        staleAfterMs,
        runnerId,
        cycleId: randomUUID,
        mergePolicy: loaded.config.mergePolicy,
        snapshotFailureMode: options.once ? 'throw' : 'report',
      });
    } catch (error) {
      // Belt-and-suspenders: GitHub's used/remaining counters are eventually
      // consistent, so usage-accounting incompleteness must never terminate the
      // continuous cadence. The meter is already non-fatal (read() no longer
      // throws on incomplete accounting); this guards any residual thrower so a
      // one-shot still fails loud while a persistent loop survives to next cycle.
      if (error instanceof GitHubUsageIncompleteError && !options.once) {
        console.warn(`[autopilot:v2] ${error.message}; continuing to next cycle`);
        return;
      }
      throw error;
    }
    // A snapshot-failed cycle must remain mutation-free. Local attempt
    // cleanup therefore follows the same complete-snapshot boundary as all
    // GitHub reconciliation/archive/action mutations.
    if (shouldSweepAttempts({
      mode: options.mode,
      executionBackend,
      cleanupEnabled,
      hasMaintenanceCredential: maintenanceCredential !== undefined,
      report,
    })) {
      const cleanup = await sweepDeadAttempts(runner, {
        v2Base: v2AttemptsBase,
        isPidAlive: childIsAlive,
        env: { GH_TOKEN: maintenanceCredential!.secret() },
        graceMs: attemptGracePeriodMs,
        now: () => new Date(),
        diskFloorBytes,
        diskPath: v2AttemptsBase,
      });
      for (const result of cleanup) {
        if (result.status === 'retained' && result.reason.code !== 'live') {
          console.warn(
            `[autopilot:v2] cleanup retained attempt=${
              result.attemptId ?? 'unknown'
            } reason=${result.reason.code}: ${result.reason.detail}`,
          );
        }
      }
    }
    if (
      options.mode === 'active'
      && report.status === 'ok'
      && report.snapshotComplete
    ) {
      try {
        await runPaintBoard(
          runner,
          new Date(),
          paintBoardOptionsFromConfig(loaded.config),
        );
      } catch (error) {
        console.warn(
          `[autopilot:v2] status painter degraded: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (options.json) {
      process.stdout.write(`${renderLifecycleJson(report)}\n`);
    } else if (options.command.kind === 'explain-issue') {
      process.stdout.write(`${explainIssue(report, options.command.number)}\n`);
    } else if (options.command.kind === 'explain-pr') {
      process.stdout.write(`${explainPullRequest(report, options.command.number)}\n`);
    } else {
      process.stdout.write(`${renderLifecycleHuman(report)}\n`);
    }
    const exitCode = lifecycleExitCodeForReport(report, options.once);
    if (exitCode !== undefined) process.exitCode = exitCode;
  };

  await runLifecycleCadence({
    once: options.once,
    intervalMs: loaded.config.scheduler.pollSeconds * 1_000,
    runCycle: runOnce,
    shouldContinue: () => process.exitCode !== 2,
    wait: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  });
}

export function isDirectLifecycleEntrypoint(
  entryPath: string | undefined,
  moduleUrl = import.meta.url,
): boolean {
  return entryPath != null
    && /^run-autopilot-v2\.(?:[cm]?[jt]s)$/.test(basename(entryPath))
    && moduleUrl === pathToFileURL(entryPath).href;
}

if (isDirectLifecycleEntrypoint(argv[1])) {
  runAutopilotV2().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[autopilot:v2] ${message}`);
    process.exitCode = 1;
  });
}
