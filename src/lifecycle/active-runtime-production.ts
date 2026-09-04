import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatcherConfig } from '../dispatcher/types.js';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { AutopilotDeliveryExpectationSchema } from '@jinn-network/sdk/autopilot';
import {
  spawnCoordinatorSession,
  type SpawnFn,
  type SpawnResult,
} from '../dispatcher/coordinator-session.js';
import {
  assertHermesBillingRoute,
  assertHermesRuntimeReady,
} from '../dispatcher/hermes-runtime.js';
import {
  assertCursorRuntimeReady,
} from '../dispatcher/cursor-runtime.js';
import { assertCodexRuntimeReady } from '../dispatcher/codex-runtime.js';
import { readRuntimeCircuit, recordRuntimeExit } from './runtime-circuit.js';
import {
  listRunnerLiveAttempts,
  readAttemptManifest,
  trackAttemptChild,
  type AttemptPhase,
  type TrackableAttemptChild,
} from './attempt-workspace.js';
import { makeActiveRuntime } from './active-runtime.js';
import type { DiskHeadroom } from './disk-headroom.js';
import {
  decodeReviewClaimPayload,
  formatHumanCommentMarker,
} from './codecs.js';
import {
  selectCredential,
  type CredentialPool,
} from './credentials.js';
import {
  CAPABILITY_ATTESTATION_ENV,
  readCapabilityAttestation,
} from './capability-attestation.js';
import {
  CANONICAL_GITHUB_HTTPS_REMOTE,
  executeImplementationAction,
  makeCanonicalImplementationSpawner,
  type SpawnImplementationInput,
} from './implementation-executor.js';
import {
  makeProductionImplementationActionPort,
} from './implementation-executor-production.js';
import {
  executeReviewAction,
  type SpawnExactHeadReviewInput,
} from './review-executor.js';
import { makeProductionReviewActionPort } from './review-executor-production.js';
import {
  executeEnqueueAction,
  executeFileReconcileChildAction,
} from './enqueue-executor.js';
import { makeProductionEnqueueActionPort } from './enqueue-executor-production.js';
import {
  executeProductionFileCiFailureChild,
  executeProductionRerunFailedChecks,
} from './ci-rerun-production.js';
import { repairProductionMachineChild } from './child-issues-production.js';
import { executeProductionFileDebtSweep } from './debt-sweep-production.js';
import { withSelectedCredential } from './production-auth.js';
import {
  makeProductionReconciliationWriter,
  type ReconciliationProjectItemNode,
  type ReconciliationBranchClaimNode,
  type ReconciliationPullRequestNode,
} from './reconciliation-writer-production.js';
import type { GitHubLifecycleSnapshot } from './snapshot.js';
import type {
  TargetedIssueActionContext,
  TargetedNativeIssue,
  TargetedOpenPullRequest,
  TargetedPullRequestRead,
} from './targeted-action-reader.js';
import {
  targetedAuthorityRefusalDetail,
  targetedAuthoritySnapshot,
} from './targeted-action-reader.js';
import type {
  GitOid,
  HumanReason,
  NewWorkAction,
  ReviewClaimRecord,
} from './types.js';
import { gitOid } from './types.js';
import type { ProjectMapping } from '../config/config.js';
import type { AutopilotExecutionBackend } from '../config/execution-backend.js';
import {
  hasExternalHumanAuthority,
  NEEDS_HUMAN_LABEL,
} from './human-authority.js';
import {
  LocalSessionExecutionBackend,
  MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL,
  MARKETPLACE_REVIEW_UNAVAILABLE_DETAIL,
  MarketplaceSessionExecutionBackend,
  type LocalExactHeadReviewSessionExecutionRequest,
  type LocalImplementationSessionExecutionRequest,
  type MarketplaceSessionExecutionRequest,
} from './session-execution-backend.js';
import {
  buildMarketplaceTaskRequest,
  MARKETPLACE_LANGUAGE,
  MARKETPLACE_REPOSITORY,
  MARKETPLACE_VERIFICATION_PROFILE,
  MarketplaceTaskCliAdapter,
  persistMarketplaceTaskRequest,
} from './marketplace-task.js';
import {
  makeProductionMarketplaceMutationAdoptionCoordinator,
  type ProductionMarketplaceMutationAdoptionOptions,
} from './marketplace-mutation-adoption-production.js';
import type { MarketplaceMutationAdoptionCoordinator } from './marketplace-mutation-adoption.js';
import {
  marketplaceMachineEnvironment,
  resolveInstalledJinnBinary,
  runMarketplaceMachineSubprocess,
  type MarketplaceMachineSubprocess,
} from './marketplace-cli.js';
import {
  createMarketplaceVerificationDockerSandbox,
  createProductionMarketplaceVerificationPort,
} from './marketplace-mutation-verification-production.js';

type ProductionMarketplaceTaskAdapter = Pick<
  MarketplaceTaskCliAdapter,
  'dryRun' | 'submit' | 'recover'
>;

export const AUTOPILOT_V2_REMOTE = 'jinn-autopilot-v2';

export function assertMarketplaceRuntimeProfile(input: {
  readonly repository: string;
  readonly language: string;
  readonly verificationProfile: string;
}): void {
  if (
    input.repository !== MARKETPLACE_REPOSITORY
    || input.language !== MARKETPLACE_LANGUAGE
    || input.verificationProfile !== MARKETPLACE_VERIFICATION_PROFILE
  ) {
    throw new Error(
      `Marketplace Task submission supports only ${MARKETPLACE_REPOSITORY}, `
      + `${MARKETPLACE_LANGUAGE}, and verification profile `
      + MARKETPLACE_VERIFICATION_PROFILE,
    );
  }
}

export interface ProductionActiveRuntimeOptions {
  /**
   * Process-local execution selector. The production entrypoint always passes
   * its parsed value; local remains the default for source compatibility.
   */
  readonly executionBackend?: AutopilotExecutionBackend;
  readonly repositoryPath: string;
  readonly worktreeBase: string;
  readonly runnerId: string;
  readonly credentials: CredentialPool;
  readonly authorAllowlist: ReadonlySet<string>;
  /** Exact per-PR reads used by review cohorts without touching coordinator state. */
  readonly readReviewSnapshot: (
    cycleSnapshot: GitHubLifecycleSnapshot,
    prNumber: number,
  ) => Promise<TargetedPullRequestRead>;
  readonly readReservedReviewSnapshot: (
    cycleSnapshot: GitHubLifecycleSnapshot,
    prNumber: number,
  ) => Promise<TargetedPullRequestRead>;
  /** Exact issue/PR closure reads used by implementation without a global scan. */
  readonly readImplementationSnapshot: (
    cycleSnapshot: GitHubLifecycleSnapshot,
    action: Extract<NewWorkAction, { kind: 'claim-implementation' }>,
    selfClaim?: import('./self-claim-transition.js').SelfClaimHeadTransition,
  ) => Promise<GitHubLifecycleSnapshot>;
  /** One aggregate quota reservation before any review cohort begins. */
  readonly reserveReviewCohort: (size: number) => Promise<void>;
  /** Targeted reads backing the cycle-snapshot reconciliation writer. */
  readonly readPullRequestByNumber: (
    prNumber: number,
  ) => Promise<ReconciliationPullRequestNode | null>;
  readonly readProjectItemForReconciliation: (
    issueNumber: number,
  ) => Promise<ReconciliationProjectItemNode | null>;
  readonly readBranchHeadByName: (headRefName: string) => Promise<GitOid | null>;
  readonly readBranchClaimByName: (
    headRefName: string,
  ) => Promise<ReconciliationBranchClaimNode | null>;
  readonly readIssueByNumber: (issueNumber: number) => Promise<TargetedNativeIssue | null>;
  readonly readBlockedByIssueNumbers: (issueNumber: number) => Promise<readonly number[]>;
  readonly readOpenPullRequestsByIssue: (
    issueNumber: number,
  ) => Promise<readonly TargetedOpenPullRequest[]>;
  readonly readIssueActionContext: (
    issueNumber: number,
  ) => Promise<TargetedIssueActionContext>;
  readonly config: DispatcherConfig;
  readonly spawn: SpawnFn;
  readonly caps: {
    readonly implementation: number;
    /** Machine-child work, capped separately from fresh claims (#122). */
    readonly child: number;
    readonly review: number;
    /** Codex overflow pool shared by the implementation and child lanes (#152). */
    readonly codexOverflow?: number;
  };
  /**
   * Where the `claude` session-limit circuit is persisted (#152). Absent, no
   * exit is recorded and the scheduler never prefers Codex.
   */
  readonly runtimeCircuitPath?: string;
  readonly implementationBackpressureThreshold: number;
  /**
   * jinn-mono#1883: canary safety knob (`JINN_AUTOPILOT_ONLY_ISSUES`),
   * parsed in scripts/run-autopilot-v2.ts and threaded through unchanged.
   * `undefined` is unrestricted — see active-runtime.ts.
   */
  readonly onlyIssues?: ReadonlySet<number>;
  readonly staleAfterMs: number;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly readCapabilityAttestation?: typeof readCapabilityAttestation;
  readonly now?: () => Date;
  readonly nextId?: () => string;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly trackAttemptChild?: typeof trackAttemptChild;
  readonly makeImplementationActionPort?:
    typeof makeProductionImplementationActionPort;
  readonly makeReviewActionPort?: typeof makeProductionReviewActionPort;
  readonly remoteName?: string;
  readonly repositorySlug?: string;
  readonly repositoryUrl?: string;
  readonly defaultBranch?: string;
  readonly projectMapping?: ProjectMapping;
  /**
   * Logins the repository's CODEOWNERS policy names, used by the enqueue gate
   * to decide whether a codeowner-sensitive change carries an owner's approval
   * at the exact head. Absent or empty proves nobody is an owner, so every
   * sensitive change refuses — the fail-safe default, and exactly what the
   * unconditional `codeowner-sensitive` refusal used to do.
   */
  readonly codeOwnerLogins?: ReadonlySet<string>;
  /**
   * Injectable delay for the bounded post-win confirmation retries in
   * review-claim acquisition (replication-lag tolerance;
   * see `confirmReviewAcquisition` in review-executor.ts). Defaults to a
   * real `setTimeout`-based sleep.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly newWorkPaused?: () => boolean;
  /** Projected disk headroom for this cycle's own dispatches (#144). */
  readonly readDiskHeadroom?: (
    pendingSpawns: readonly AttemptPhase[],
  ) => DiskHeadroom | null;
  readonly marketplaceTaskAdapter?: ProductionMarketplaceTaskAdapter;
  readonly marketplaceExecutionBackend?: Pick<
    MarketplaceSessionExecutionBackend,
    'start'
  >;
  readonly marketplaceLanguage?: string;
  readonly marketplaceVerificationProfile?: string;
  readonly makeMarketplaceMutationAdoptionCoordinator?: (
    options: ProductionMarketplaceMutationAdoptionOptions,
  ) => MarketplaceMutationAdoptionCoordinator;
  readonly marketplaceObservationHelp?: MarketplaceMachineSubprocess;
  readonly marketplaceVerificationPreflight?: () => Promise<{
    readonly ok: boolean;
    readonly detail?: string;
  }>;
}

export type ProductionActiveRuntime = ReturnType<typeof makeActiveRuntime> & {
  readonly makeMarketplaceMutationAdoptionCoordinator?: (
    input: {
      readonly manifestPath: string;
      readonly readSnapshot: () => Promise<GitHubLifecycleSnapshot>;
    },
  ) => MarketplaceMutationAdoptionCoordinator;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function requireTrackable(child: SpawnResult): TrackableAttemptChild {
  if (
    child.pid === undefined
    || typeof (child as Partial<TrackableAttemptChild>).once !== 'function'
  ) {
    throw new Error('Production coordinator child is not trackable');
  }
  return child as TrackableAttemptChild;
}

/**
 * The follow-ups already open against this PR, rendered for the coordinator
 * prompt (#124).
 *
 * Titles only, no bodies. The section is omitted entirely when nothing is
 * open: a reviewer told "there are none" learns nothing it did not already
 * assume, and every line here competes with the diff it is there to read. When
 * the list is capped, the true count is printed alongside it, because a
 * reviewer that reads a capped list as complete will re-file exactly the
 * findings this exists to stop.
 */
function openFollowUpSection(
  followUps: readonly { readonly number: number; readonly title: string }[],
  total: number,
): readonly string[] {
  if (followUps.length === 0) return [];
  const shown = followUps.length < total
    ? ` (showing ${followUps.length} of ${total})`
    : '';
  return [
    '',
    `Open Autopilot review follow-ups already filed for this PR${shown}:`,
    ...followUps.map((followUp) =>
      `- #${followUp.number} — ${followUp.title.replace(/\s+/g, ' ').trim()}`),
    'Do not file another follow-up for anything already covered above; '
    + 'cite the existing issue number in the verdict body instead.',
  ];
}

function reviewScenario(input: {
  readonly prNumber: number;
  readonly issueNumber: number;
  readonly head: string;
  readonly worktreePath: string;
  readonly openFollowUps?: readonly {
    readonly number: number;
    readonly title: string;
  }[];
  readonly openFollowUpTotal?: number;
}): string {
  return [
    `Use the review-pr skill on PR #${input.prNumber} for issue #${input.issueNumber}.`,
    `The v2 lifecycle already claimed exact head \`${input.head}\` and created the detached worktree at \`${input.worktreePath}\`.`,
    'Finish with `autopilot session review-verdict --state <APPROVE|REQUEST_CHANGES> --body-file <path>` or park with `autopilot session human --reason-file <path>`.',
    ...openFollowUpSection(
      input.openFollowUps ?? [],
      input.openFollowUpTotal ?? 0,
    ),
  ].join('\n');
}


export function makeProductionCapabilityPreflight(
  options: Pick<
  ProductionActiveRuntimeOptions,
  | 'executionBackend'
  | 'repositoryPath'
  | 'credentials'
  | 'config'
  | 'runner'
  | 'remoteName'
  | 'environment'
  | 'now'
  | 'nextId'
  | 'runnerId'
  | 'readCapabilityAttestation'
  | 'repositorySlug'
  | 'repositoryUrl'
  | 'defaultBranch'
  | 'marketplaceTaskAdapter'
  | 'marketplaceLanguage'
  | 'marketplaceVerificationProfile'
  | 'marketplaceObservationHelp'
  | 'marketplaceVerificationPreflight'
  >,
): () => Promise<{ readonly ok: boolean; readonly detail?: string }> {
  const executionBackend = options.executionBackend ?? 'local';
  const runner = options.runner ?? defaultRunner;
  const remoteName = options.remoteName ?? AUTOPILOT_V2_REMOTE;
  const ambient = options.environment ?? process.env;
  const now = options.now ?? (() => new Date());
  const readAttestation =
    options.readCapabilityAttestation ?? readCapabilityAttestation;
  const repositoryUrl =
    options.repositoryUrl ?? CANONICAL_GITHUB_HTTPS_REMOTE;
  return async () => {
    if (executionBackend === 'marketplace') {
      let preflightDirectory: string | undefined;
      try {
        const createdAt = now().getTime();
        const attemptId = (options.nextId ?? randomUUID)();
        const baseOid = '0'.repeat(40);
        const profile = {
          repository: options.repositorySlug ?? '',
          language: options.marketplaceLanguage ?? MARKETPLACE_LANGUAGE,
          verificationProfile:
            options.marketplaceVerificationProfile
              ?? MARKETPLACE_VERIFICATION_PROFILE,
        };
        assertMarketplaceRuntimeProfile(profile);
        const built = buildMarketplaceTaskRequest({
          workflow: 'implementation',
          ...profile,
          issueNumber: 1,
          prNumber: 1,
          targetBase: options.defaultBranch ?? 'next',
          branch: `autopilot/marketplace-preflight-${attemptId}`,
          claimOid: baseOid,
          expectedHead: baseOid,
          v2AttemptId: attemptId,
          runnerId: options.runnerId,
          taskSnapshot: {
            title: 'Autopilot marketplace capability preflight',
            body: 'Validate the installed marketplace Task submission capability.',
            prBody: 'Synthetic dry-run request; no GitHub mutation is performed.',
            baseSha: baseOid,
            targetBaseOid: baseOid,
          },
          receiptAuthors: options.credentials.logins(),
          createdAt,
        });
        preflightDirectory = mkdtempSync(
          join(tmpdir(), 'jinn-autopilot-marketplace-preflight-'),
        );
        const persisted = persistMarketplaceTaskRequest(
          join(preflightDirectory, 'marketplace-request.json'),
          built.request,
        );
        const adapter = options.marketplaceTaskAdapter
          ?? new MarketplaceTaskCliAdapter({ environment: ambient });
        await adapter.dryRun(persisted.requestPath);
        AutopilotDeliveryExpectationSchema.parse({
          schemaVersion: 'jinn-autopilot-delivery-observation-request.v1',
          role: 'solution',
          taskId: '501',
          taskCid: 'bafy-task',
          creationBlockNumber: 1,
          session: built.request.spec.session,
        });
        const jinnBinary = resolveInstalledJinnBinary();
        const observationHelp = options.marketplaceObservationHelp
          ?? runMarketplaceMachineSubprocess;
        const helpResult = await observationHelp(
          jinnBinary,
          ['tasks', '--help'],
          { environment: marketplaceMachineEnvironment(ambient) },
        );
        if (
          helpResult.exitCode !== 0
          || !helpResult.stdout.includes('observe-autopilot-delivery')
        ) {
          throw new Error(
            'Installed jinn client does not expose tasks observe-autopilot-delivery',
          );
        }
        const verificationPreflight = options.marketplaceVerificationPreflight
          ?? (async () => {
            const sandbox = createMarketplaceVerificationDockerSandbox();
            return createProductionMarketplaceVerificationPort({
              dockerRunner: sandbox.dockerRunner,
              dockerInspector: sandbox.dockerInspector,
              ambientEnvironment: ambient,
              now,
            }).preflight();
          });
        const verificationReady = await verificationPreflight();
        if (!verificationReady.ok) {
          throw new Error(
            verificationReady.detail ?? 'marketplace verification preflight failed',
          );
        }
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (preflightDirectory !== undefined) {
          rmSync(preflightDirectory, { recursive: true, force: true });
        }
      }
    }
    try {
      if (options.credentials.logins().length === 0) {
        throw new Error('no configured GitHub credential is available');
      }
      const url = (await runner('git', [
        '-C', options.repositoryPath,
        'remote', 'get-url', remoteName,
      ])).trim();
      if (url !== repositoryUrl) {
        throw new Error(
          `${remoteName} must be the canonical HTTPS GitHub remote`,
        );
      }
      const attestationPath = ambient[CAPABILITY_ATTESTATION_ENV];
      if (attestationPath === undefined || attestationPath.length === 0) {
        throw new Error(
          `${CAPABILITY_ATTESTATION_ENV} must name a fresh live capability attestation`,
        );
      }
      readAttestation(attestationPath, {
        remoteName,
        repositoryUrl,
        configuredLogins: options.credentials.logins(),
        now: now(),
      });
      if (options.config.runtime === 'hermes') {
        assertHermesBillingRoute(
          options.config.hermesModel,
          options.config.hermesProvider,
        );
        assertHermesRuntimeReady(options.config.hermesPythonPath);
      }
      if (options.config.runtime === 'cursor') {
        assertCursorRuntimeReady(options.config.cursorBin);
      }
      // Whenever a cycle could dispatch to Codex — as the process-wide
      // runtime or as overflow — prove the binary launches before the cycle
      // spends claims on workers that would die at spawn (#152).
      if (
        options.config.runtime === 'codex'
        || options.config.codexOverflowSlots > 0
      ) {
        assertCodexRuntimeReady(options.config.codexBin);
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

export function makeProductionActiveRuntime(
  options: ProductionActiveRuntimeOptions,
): ProductionActiveRuntime {
  const executionBackend = options.executionBackend ?? 'local';
  const runner = options.runner ?? defaultRunner;
  const ambient = options.environment ?? process.env;
  const now = options.now ?? (() => new Date());
  const nextId = options.nextId ?? randomUUID;
  const sleep = options.sleep ?? defaultSleep;
  const remoteName = options.remoteName ?? AUTOPILOT_V2_REMOTE;
  const alive = options.isPidAlive ?? isPidAlive;
  const trackAttempt = options.trackAttemptChild ?? trackAttemptChild;
  const implementationActionPort =
    options.makeImplementationActionPort
    ?? makeProductionImplementationActionPort;
  const reviewActionPort =
    options.makeReviewActionPort
    ?? makeProductionReviewActionPort;
  let reviewMutationTail: Promise<void> = Promise.resolve();
  const serializeReviewMutation = <Value>(
    operation: () => Promise<Value>,
  ): Promise<Value> => {
    const pending = reviewMutationTail.then(operation, operation);
    reviewMutationTail = pending.then(() => undefined, () => undefined);
    return pending;
  };
  const targetedPullRequestSnapshot = (
    cycleSnapshot: GitHubLifecycleSnapshot,
    prNumber: number,
  ) => async (): Promise<GitHubLifecycleSnapshot> => {
    const read = await options.readReviewSnapshot(cycleSnapshot, prNumber);
    const targeted = targetedAuthoritySnapshot(read);
    if (targeted === null) {
      const detail = targetedAuthorityRefusalDetail(read);
      throw new Error(
        `Targeted PR authority for #${prNumber} is unavailable`
        + (detail === null ? '' : ` (${detail})`),
      );
    }
    return targeted;
  };
  const track = (manifestPath: string, child: SpawnResult): void => {
    const trackable = requireTrackable(child);
    const tracked = trackAttempt(manifestPath, trackable, { now });
    const circuitPath = options.runtimeCircuitPath;
    if (circuitPath === undefined) return;
    // Folds this child's exit into the session-limit circuit (#152). Registered
    // after trackAttempt's own listener, so by the time it runs the manifest
    // already carries the exit code and timestamps it reads. Advisory only:
    // a failure here must never fail the cycle.
    const observe = (): void => {
      try {
        const manifest = readAttemptManifest(manifestPath);
        if (manifest.processState !== 'exited') return;
        recordRuntimeExit(circuitPath, {
          runtime: manifest.runtime ?? options.config.runtime,
          exitCode: manifest.exitCode ?? null,
          ...(manifest.timestamps.childStartedAt === undefined
            ? {}
            : { childStartedAt: manifest.timestamps.childStartedAt }),
          ...(manifest.timestamps.childExitedAt === undefined
            ? {}
            : { childExitedAt: manifest.timestamps.childExitedAt }),
        }, now());
      } catch {
        // See above.
      }
    };
    if (tracked.processState === 'exited') observe();
    else trackable.once('exit', observe);
  };
  const implementationPreferred = selectCredential(
    options.credentials,
    { phase: 'implement' },
  );
  const implementationPreferredLogin =
    implementationPreferred.status === 'selected'
      ? implementationPreferred.login
      : options.credentials.logins()[0] ?? '';
  const implementationSpawner = makeCanonicalImplementationSpawner(
    options.config,
    options.spawn,
  );
  const reviewSpawner = (
    input: SpawnExactHeadReviewInput,
  ) => spawnCoordinatorSession({
    kind: 'review',
    number: input.candidate.number,
    skill: 'review-pr',
    scenario: reviewScenario({
      prNumber: input.candidate.number,
      issueNumber: input.candidate.issueNumber,
      head: input.candidate.head,
      worktreePath: input.worktreePath,
      ...(input.openFollowUps === undefined
        ? {}
        : {
            openFollowUps: input.openFollowUps,
            openFollowUpTotal: input.openFollowUpTotal ?? input.openFollowUps.length,
          }),
    }),
    worktreePath: input.worktreePath,
    effort: null,
    env: input.environment,
    spawnOptions: {
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit'],
      logPath: input.logPath,
    },
  }, options.config, { spawn: options.spawn });
  type ProductionLocalExecutionBackend = LocalSessionExecutionBackend<
    SpawnImplementationInput,
    SpawnExactHeadReviewInput,
    SpawnResult
  >;
  const localExecutionBackend: ProductionLocalExecutionBackend | undefined =
    executionBackend === 'local'
      ? new LocalSessionExecutionBackend({
          spawnImplementation: implementationSpawner,
          spawnExactHeadReview: reviewSpawner,
          trackChild: track,
        })
      : undefined;
  const marketplaceExecutionBackend = executionBackend === 'marketplace'
    ? options.marketplaceExecutionBackend
      ?? new MarketplaceSessionExecutionBackend({
        ...(options.marketplaceTaskAdapter === undefined
          ? {}
          : { adapter: options.marketplaceTaskAdapter }),
        now,
      })
    : undefined;
  const requireLocalExecutionBackend = (): ProductionLocalExecutionBackend => {
    if (localExecutionBackend === undefined) {
      throw new Error(MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL);
    }
    return localExecutionBackend;
  };
  const startImplementationSession = (
    request:
      | LocalImplementationSessionExecutionRequest<SpawnImplementationInput>
      | Extract<
          MarketplaceSessionExecutionRequest,
          { readonly kind: 'implementation' }
        >,
  ) => request.backend === 'local'
    ? requireLocalExecutionBackend().start(request)
    : marketplaceExecutionBackend!.start(request);
  const startExactHeadReviewSession = (
    request: LocalExactHeadReviewSessionExecutionRequest<SpawnExactHeadReviewInput>,
  ) => requireLocalExecutionBackend().start(request);
  const escalateReview = async (
    input: {
      readonly candidate: {
        readonly issueNumber: number;
        readonly number: number;
        readonly head: GitOid;
      };
      readonly reason: HumanReason;
    },
    credentials: CredentialPool,
    cycleSnapshot: GitHubLifecycleSnapshot,
  ): Promise<void> => {
    const authorityRead = await options.readReviewSnapshot(
      cycleSnapshot,
      input.candidate.number,
    );
    const authoritySnapshot = targetedAuthoritySnapshot(authorityRead);
    if (authoritySnapshot === null || authoritySnapshot.snapshotComplete !== true) {
      const detail = targetedAuthorityRefusalDetail(authorityRead);
      throw new Error(
        'Review Human escalation live mapping authority is unavailable'
        + (detail === null ? '' : ` (${detail})`),
      );
    }
    const diagnostic = authoritySnapshot.diagnostics.find((candidate) => (
      candidate.pullRequests.some((pr) => (
        pr.number === input.candidate.number
        && pr.head === input.candidate.head
      ))
    ));
    if (
      diagnostic !== undefined
      && !diagnostic.issueNumbers.includes(input.candidate.issueNumber)
    ) {
      throw new Error('Review Human escalation selected issue is outside the live diagnostic');
    }
    if (
      input.reason.code === 'branch-mapping-ambiguous'
      && diagnostic === undefined
    ) {
      // The scheduled candidate can lag a just-completed canonical reread.
      // Only the fresh complete snapshot may authorize a mapping pause.
      return;
    }
    const live = await options.readPullRequestByNumber(input.candidate.number);
    if (
      live === null
      || live.state !== 'OPEN'
      || live.headOid !== input.candidate.head
    ) {
      throw new Error('Review Human escalation lost exact-head authority');
    }
    if (live.evidenceIncompleteReason !== undefined) {
      throw new Error(
        `Review Human escalation live PR evidence is incomplete: ${
          live.evidenceIncompleteReason
        }`,
      );
    }
    const canonicalPr = authoritySnapshot.pullRequests.find(
      (pr) => pr.number === input.candidate.number,
    );
    let canonicalMappingRequest: {
      readonly selectedIssueNumber: number;
      readonly headRefName: string;
      readonly baseRefName: string;
    } | undefined;
    if (diagnostic !== undefined) {
      if (canonicalPr === undefined) {
        throw new Error('Review mapping escalation canonical PR is absent');
      }
      const diagnosticIssues = new Set(diagnostic.issueNumbers);
      const externalHumanActive = (
        hasExternalHumanAuthority({
          pullRequestLabels: [...live.labels, ...canonicalPr.labels],
        })
        || authoritySnapshot.issues.some((issue) => (
          diagnosticIssues.has(issue.number)
          && hasExternalHumanAuthority({
            nativeIssueLabels: issue.labels,
            projectBlockedOn: issue.blockedOn,
          })
        ))
        || authoritySnapshot.project.items.some((item) => (
          item.contentType === 'Issue'
          && diagnosticIssues.has(item.number)
          && hasExternalHumanAuthority({ projectBlockedOn: item.blockedOn })
        ))
      );
      if (externalHumanActive) return;
      canonicalMappingRequest = {
        selectedIssueNumber: input.candidate.issueNumber,
        headRefName: canonicalPr.headRefName,
        baseRefName: canonicalPr.baseRefName,
      };
    }
    let currentRefOid = live.reviewClaim === null
      ? null
      : gitOid(live.reviewClaim.oid);
    const currentRecord = live.reviewClaim === null
      ? undefined
      : decodeReviewClaimPayload(live.reviewClaim.payload);
    const currentHeadRecord = currentRecord?.head === input.candidate.head
      ? currentRecord
      : undefined;
    const candidateAuthor = authoritySnapshot.pullRequests.find(
      (pr) => pr.number === input.candidate.number,
    )?.author;
    const eligibleCredentials = currentHeadRecord === undefined
      ? credentials
      : credentials.restrictedTo([currentHeadRecord.reviewer]);
    const selection = selectCredential(eligibleCredentials, {
      phase: 'review',
      ...(candidateAuthor === undefined ? {} : { prAuthor: candidateAuthor }),
    });
    if (selection.status !== 'selected') throw new Error(selection.detail);
    const generation = currentHeadRecord?.generation ?? nextId();
    const attempt = currentHeadRecord?.attempt ?? nextId();
    const reviewer = currentHeadRecord?.reviewer ?? selection.login;
    const port = reviewActionPort({
      repositoryPath: options.repositoryPath,
      worktreeBase: options.worktreeBase,
      runnerId: options.runnerId,
      remoteName,
      readSnapshot: (prNumber) => options.readReviewSnapshot(authoritySnapshot, prNumber),
      runner,
      environment: ambient,
      repositorySlug: options.repositorySlug,
      repositoryUrl: options.repositoryUrl,
      projectMapping: options.projectMapping,
    });
    const publishRecord = async (
      record: ReviewClaimRecord,
      parent: GitOid | null,
      failure: string,
    ): Promise<GitOid> => {
      const recordOid = await port.createReviewRecord({
        record,
        parent,
        credential: selection.credential,
      });
      const outcome = await port.publishReviewClaim({
        prNumber: input.candidate.number,
        recordParent: parent,
        expectedRemoteRecordOid: parent,
        recordOid,
        credential: selection.credential,
      });
      if (
        (outcome.status !== 'won' && outcome.status !== 'already-applied')
        || outcome.observed !== recordOid
      ) {
        throw new Error(failure);
      }
      return recordOid;
    };
    let authorityRecord = currentHeadRecord;
    if (authorityRecord === undefined || currentRefOid === null) {
      authorityRecord = {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: input.candidate.number,
        generation,
        attempt,
        reviewer,
        head: input.candidate.head,
        state: 'active',
        recordedAt: now().toISOString(),
      };
      currentRefOid = await publishRecord(
        authorityRecord,
        currentRefOid,
        'Review escalation did not establish exact non-Human authority',
      );
    }
    if (currentRefOid === null) {
      throw new Error('Review Human escalation review-ref authority is absent');
    }
    const writer = makeProductionReconciliationWriter({
      repositoryPath: options.repositoryPath,
      cycleSnapshot: authoritySnapshot,
      readPullRequestByNumber: options.readPullRequestByNumber,
      readProjectItemForReconciliation: options.readProjectItemForReconciliation,
      readBranchHeadByName: options.readBranchHeadByName,
      readBranchClaimByName: options.readBranchClaimByName,
      readIssueByNumber: options.readIssueByNumber,
      readBlockedByIssueNumbers: options.readBlockedByIssueNumbers,
      readOpenPullRequestsByIssue: options.readOpenPullRequestsByIssue,
      readIssueActionContext: options.readIssueActionContext,
      readCanonicalSnapshot: async (prNumber) => targetedAuthoritySnapshot(
        await options.readReviewSnapshot(authoritySnapshot, prNumber),
      ),
      credential: selection.credential,
      credentials,
      runner,
      environment: ambient,
      repositorySlug: options.repositorySlug,
      repositoryUrl: options.repositoryUrl,
      defaultBranch: options.defaultBranch,
      now,
    });
    if (diagnostic !== undefined) {
      if (canonicalMappingRequest === undefined) {
        throw new Error('Review mapping escalation request authority is absent');
      }
      const mappingRequest = canonicalMappingRequest;
      if (
        authorityRecord.state !== 'mapping-reread'
      ) {
        const requestRecord: ReviewClaimRecord = {
          kind: 'review-claim',
          protocolVersion: 2,
          prNumber: input.candidate.number,
          generation,
          attempt,
          reviewer,
          head: input.candidate.head,
          state: 'mapping-reread',
          mappingRequest,
          recordedAt: now().toISOString(),
        };
        currentRefOid = await publishRecord(
          requestRecord,
          currentRefOid,
          'Review mapping reread request did not win exact-parent authority',
        );
        authorityRecord = requestRecord;
      }
      if (
        authorityRecord.state === 'mapping-reread'
        && (
          authorityRecord.mappingRequest.selectedIssueNumber
            !== mappingRequest.selectedIssueNumber
          || authorityRecord.mappingRequest.headRefName !== mappingRequest.headRefName
          || authorityRecord.mappingRequest.baseRefName !== mappingRequest.baseRefName
        )
      ) {
        throw new Error('Review mapping reread request identity changed');
      }
      return;
    }
    const publicationReason: HumanReason = input.reason;
    const marker = formatHumanCommentMarker({
      issueNumber: input.candidate.issueNumber,
      prNumber: input.candidate.number,
      head: input.candidate.head,
      generation,
      reason: publicationReason,
    });
    const commentBody =
      `${marker}\n\nAutopilot parked this item for Human review.\n\n${publicationReason.detail}`;
    const commentAuthority = (
      expectedReviewRefOid: GitOid,
      expectedReviewState: ReviewClaimRecord['state'],
    ) => ({
      issueNumber: input.candidate.issueNumber,
      expectedHead: input.candidate.head,
      expectedReviewRefOid,
      expectedGeneration: generation,
      expectedReviewState,
    });
    const ensureComment = async (
      expectedReviewRefOid: GitOid,
      expectedReviewState: ReviewClaimRecord['state'],
    ): Promise<void> => {
      const authority = commentAuthority(expectedReviewRefOid, expectedReviewState);
      if (await writer.hasHumanComment(input.candidate.number, marker, authority)) return;
      await writer.ensureHumanComment(
        input.candidate.number,
        marker,
        commentBody,
        authority,
      );
    };
    const requireExactEscalationRef = async (): Promise<void> => {
      const observed = await writer.readReviewRef(input.candidate.number);
      if (
        observed?.oid !== currentRefOid
        || observed.head !== input.candidate.head
      ) {
        throw new Error('Review Human escalation lost exact review-ref authority');
      }
    };
    await requireExactEscalationRef();
    await writer.setPullRequestLabel(
      input.candidate.number,
      NEEDS_HUMAN_LABEL,
      true,
      input.candidate.head,
    );
    await requireExactEscalationRef();
    if (authorityRecord.state !== 'human') {
      const humanRecord: ReviewClaimRecord = {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: input.candidate.number,
        generation,
        attempt,
        reviewer,
        head: input.candidate.head,
        state: 'human',
        recordedAt: now().toISOString(),
      };
      currentRefOid = await publishRecord(
        humanRecord,
        currentRefOid,
        'Review Human escalation did not win exact-parent authority',
      );
      authorityRecord = humanRecord;
    }
    await ensureComment(currentRefOid, 'human');
  };

  const activeRuntime = makeActiveRuntime({
    credentials: options.credentials,
    caps: options.caps,
    ...(options.runtimeCircuitPath === undefined
      ? {}
      : {
          readRuntimeCircuit: () => readRuntimeCircuit(options.runtimeCircuitPath!, now()),
        }),
    implementationPreferredLogin,
    implementationBackpressureThreshold:
      options.implementationBackpressureThreshold,
    ...(options.onlyIssues === undefined ? {} : { onlyIssues: options.onlyIssues }),
    readLocalAttempts: () => listRunnerLiveAttempts(
      join(options.worktreeBase, 'v2'),
      options.runnerId,
      alive,
    ),
    preflight: makeProductionCapabilityPreflight(options),
    reserveReviewCohort: options.reserveReviewCohort,
    ...(options.newWorkPaused === undefined
      ? {}
      : { newWorkPaused: options.newWorkPaused }),
    ...(options.readDiskHeadroom === undefined
      ? {}
      : { readDiskHeadroom: options.readDiskHeadroom }),
    handlers: {
      repairMachineChild: async (action, credentials) => {
        const selection = selectCredential(credentials, { phase: 'implement' });
        if (selection.status !== 'selected') {
          return { status: 'skipped', reason: 'credential-unavailable' };
        }
        const result = await withSelectedCredential(
          selection.credential,
          ambient,
          ({ run }) => repairProductionMachineChild({
            runner: run,
            repo: options.repositorySlug,
            fixIssueTypeId: options.projectMapping?.fields.type.options.fix,
            projectOwner: options.projectMapping?.owner,
            projectNumber: options.projectMapping?.number,
            projectMapping: options.projectMapping,
          }, action),
          runner,
        );
        return { status: result.status };
      },

      implementation: (action, credentials, cycleSnapshot) => {
        const port = implementationActionPort({
          repositoryPath: options.repositoryPath,
          worktreeBase: options.worktreeBase,
          runnerId: options.runnerId,
          remoteName,
          credentials,
          authorAllowlist: options.authorAllowlist,
          readSnapshot: (selfClaim) =>
            options.readImplementationSnapshot(cycleSnapshot, action, selfClaim),
          runner,
          environment: ambient,
          repositorySlug: options.repositorySlug,
          repositoryUrl: options.repositoryUrl,
          defaultBranch: options.defaultBranch,
          projectMapping: options.projectMapping,
        });
        return executeImplementationAction(action, {
          ...port,
          executionBackend,
          ...(executionBackend === 'marketplace'
            ? {
                marketplace: {
                  repository: options.repositorySlug ?? '',
                  language: options.marketplaceLanguage ?? MARKETPLACE_LANGUAGE,
                  verificationProfile:
                    options.marketplaceVerificationProfile
                      ?? MARKETPLACE_VERIFICATION_PROFILE,
                },
              }
            : {}),
          credentials,
          remoteUrl:
            options.repositoryUrl ?? CANONICAL_GITHUB_HTTPS_REMOTE,
          ambientEnvironment: ambient,
          nextAttemptId: nextId,
          runnerId: options.runnerId,
          now,
          startSession: startImplementationSession,
        });
      },

      review: (action, credentials, cycleSnapshot, context) => {
        if (executionBackend === 'marketplace') {
          return Promise.resolve({
            status: 'unavailable',
            detail: MARKETPLACE_REVIEW_UNAVAILABLE_DETAIL,
          });
        }
        requireLocalExecutionBackend();
        const productionPort = reviewActionPort({
          repositoryPath: options.repositoryPath,
          worktreeBase: options.worktreeBase,
          runnerId: options.runnerId,
          remoteName,
          readSnapshot: (prNumber) => (
            context?.cohortQuotaReserved === true
              ? options.readReservedReviewSnapshot(cycleSnapshot, prNumber)
              : options.readReviewSnapshot(cycleSnapshot, prNumber)
          ),
          runner,
          environment: ambient,
          repositorySlug: options.repositorySlug,
          repositoryUrl: options.repositoryUrl,
          projectMapping: options.projectMapping,
        });
        const port = {
          ...productionPort,
          createAttempt: (
            input: Parameters<typeof productionPort.createAttempt>[0],
          ) => serializeReviewMutation(() => productionPort.createAttempt(input)),
          repairProjection: (
            input: Parameters<typeof productionPort.repairProjection>[0],
          ) => serializeReviewMutation(() => productionPort.repairProjection(input)),
        };
        return executeReviewAction({
          prNumber: action.prNumber,
          expectedHead: action.head,
        }, {
          ...port,
          credentials,
          ambientEnvironment: ambient,
          nextAttemptId: nextId,
          nextGeneration: nextId,
          runnerId: options.runnerId,
          now,
          sleep,
          staleAfterMs: options.staleAfterMs,
          startSession: startExactHeadReviewSession,
          escalateHuman: (input) => serializeReviewMutation(
            () => escalateReview(input, credentials, cycleSnapshot),
          ),
        });
      },


      enqueue: (action, credentials, cycleSnapshot) => executeEnqueueAction({
        prNumber: action.prNumber,
        expectedHead: action.head,
        expectedBaseRefName: action.expectedBaseRefName,
      }, {
        ...makeProductionEnqueueActionPort({
          readSnapshot: targetedPullRequestSnapshot(cycleSnapshot, action.prNumber),
          authorAllowlist: options.authorAllowlist,
          expectedBaseRefName: action.expectedBaseRefName,
          repositorySlug: options.repositorySlug,
          projectOwner: options.projectMapping?.owner,
          projectNumber: options.projectMapping?.number,
          projectMapping: options.projectMapping,
          // The attempt ledger lives on the canonical remote and is pushed from
          // this clone. Without both of these the flake policy has no ledger to
          // read, so it degrades to always-allow and a head that the queue keeps
          // ejecting is fed back forever.
          repositoryPath: options.repositoryPath,
          repositoryUrl: options.repositoryUrl,
          // The one branch the merge queue is configured on. Without it the
          // gate cannot tell a root pull request from a stacked one.
          defaultBranch: options.defaultBranch,
          // Empty is the fail-safe: a codeowner-sensitive change refuses when
          // nobody is proven to be an owner.
          codeOwnerLogins: options.codeOwnerLogins ?? new Set<string>(),
          fixIssueTypeId: options.projectMapping?.fields.type.options.fix,
          runner,
          environment: ambient,
        }),
        credentials,
      }),

      fileReconcileChild: async (action, credentials, cycleSnapshot) => {
        const result = await executeFileReconcileChildAction({
          prNumber: action.prNumber,
          expectedHead: action.head,
          effort: action.effort,
        }, {
          ...makeProductionEnqueueActionPort({
            readSnapshot: targetedPullRequestSnapshot(cycleSnapshot, action.prNumber),
            authorAllowlist: options.authorAllowlist,
            expectedBaseRefName: action.expectedBaseRefName,
            repositorySlug: options.repositorySlug,
            projectOwner: options.projectMapping?.owner,
            projectNumber: options.projectMapping?.number,
            projectMapping: options.projectMapping,
            runner,
            environment: ambient,
          }),
          credentials,
        });
        if (result.status === 'runaway-hold') {
          await escalateReview({
            candidate: {
              issueNumber: action.issueNumber,
              number: action.prNumber,
              head: action.head,
            },
            reason: {
              phase: 'merge-ready',
              code: 'runaway-child',
              detail:
                `Runaway child guard: ${result.priorCount} prior reconcile children `
                + `on PR #${action.prNumber}; parking for Human.`,
            },
          }, credentials, cycleSnapshot);
          return { status: 'human', detail: 'runaway-child-hold' };
        }
        return {
          status: result.status,
          ...(result.status === 'ineligible'
            ? { reason: result.reason }
            : { detail: `child:${result.childNumber}` }),
        };
      },

      rerunFailedChecks: async (action, credentials, cycleSnapshot) => {
        const selection = selectCredential(credentials, { phase: 'merge' });
        if (selection.status !== 'selected') {
          return { status: 'skipped', reason: 'credential-unavailable' };
        }
        return executeProductionRerunFailedChecks(
          { prNumber: action.prNumber, head: action.head },
          {
            readSnapshot: targetedPullRequestSnapshot(cycleSnapshot, action.prNumber),
            repositoryPath: options.repositoryPath,
            runner,
            environment: ambient,
            repositorySlug: options.repositorySlug,
            repositoryUrl: options.repositoryUrl,
            fixIssueTypeId: options.projectMapping?.fields.type.options.fix,
            projectMapping: options.projectMapping,
          },
          selection.credential,
        );
      },

      // Ordinary issue filing on the repository, not a mutation of any pull
      // request: no head to pin, no snapshot to re-read. Dedup and the live
      // member set both come from the one open-issue listing the port makes,
      // which refuses a truncated page rather than risk a second sweep.
      fileDebtSweep: async (action, credentials) => {
        const selection = selectCredential(credentials, { phase: 'implement' });
        if (selection.status !== 'selected') {
          return { status: 'skipped', reason: 'credential-unavailable' };
        }
        return withSelectedCredential(
          selection.credential,
          ambient,
          ({ run }) => executeProductionFileDebtSweep(action, {
            runner: run,
            ...(options.repositorySlug === undefined
              ? {}
              : { repo: options.repositorySlug }),
            ...(options.projectMapping === undefined
              ? {}
              : {
                  projectOwner: options.projectMapping.owner,
                  projectNumber: options.projectMapping.number,
                  projectMapping: options.projectMapping,
                }),
          }),
          runner,
        );
      },

      fileCiFailureChild: async (action, credentials, cycleSnapshot) => {
        const selection = selectCredential(credentials, { phase: 'merge' });
        if (selection.status !== 'selected') {
          return { status: 'skipped', reason: 'credential-unavailable' };
        }
        const result = await executeProductionFileCiFailureChild(
          { prNumber: action.prNumber, head: action.head },
          {
            readSnapshot: targetedPullRequestSnapshot(cycleSnapshot, action.prNumber),
            repositoryPath: options.repositoryPath,
            runner,
            environment: ambient,
            repositorySlug: options.repositorySlug,
            repositoryUrl: options.repositoryUrl,
            fixIssueTypeId: options.projectMapping?.fields.type.options.fix,
            projectMapping: options.projectMapping,
          },
          selection.credential,
        );
        if (result.status === 'runaway-hold') {
          await escalateReview({
            candidate: {
              issueNumber: action.issueNumber,
              number: action.prNumber,
              head: action.head,
            },
            reason: {
              phase: 'merge-ready',
              code: 'runaway-child',
              detail:
                `Runaway child guard: ${result.detail ?? 'unknown'} prior ci-failure children `
                + `on PR #${action.prNumber}; parking for Human.`,
            },
          }, credentials, cycleSnapshot);
          return { status: 'human', detail: 'runaway-child-hold' };
        }
        return result;
      },
    },
  });
  if (executionBackend !== 'marketplace') return activeRuntime;
  const adoptionFactory = options.makeMarketplaceMutationAdoptionCoordinator
    ?? makeProductionMarketplaceMutationAdoptionCoordinator;
  return {
    ...activeRuntime,
    executeReviewActions: async (actions) => actions.map(() => ({
      outcome: 'unavailable',
      reason: MARKETPLACE_REVIEW_UNAVAILABLE_DETAIL,
    })),
    makeMarketplaceMutationAdoptionCoordinator: (input) => adoptionFactory({
      originManifestPath: input.manifestPath,
      repositoryPath: options.repositoryPath,
      worktreeBase: options.worktreeBase,
      runnerId: options.runnerId,
      credentials: options.credentials,
      readSnapshot: input.readSnapshot,
      staleAfterMs: options.staleAfterMs,
      runner,
      environment: ambient,
      now,
      nextId,
      sleep,
    }),
  };
}

export function makeMarketplaceRecoveryReadSnapshot(input: {
  readonly manifestPath: string;
  readonly readCycleSnapshot: () => Promise<GitHubLifecycleSnapshot>;
  readonly readTargetedPullRequestSnapshot: (
    cycleSnapshot: GitHubLifecycleSnapshot,
    prNumber: number,
  ) => Promise<GitHubLifecycleSnapshot | null>;
}): () => Promise<GitHubLifecycleSnapshot> {
  return async (): Promise<GitHubLifecycleSnapshot> => {
    const manifest = readAttemptManifest(input.manifestPath);
    const prNumber = manifest.prNumber;
    if (prNumber === undefined) {
      throw new Error('Marketplace recovery requires a pull request number');
    }
    const cycleSnapshot = await input.readCycleSnapshot();
    const targetedSnapshot = await input.readTargetedPullRequestSnapshot(
      cycleSnapshot,
      prNumber,
    );
    if (targetedSnapshot === null) {
      throw new Error(
        `Targeted PR authority for #${prNumber} is unavailable during marketplace recovery`,
      );
    }
    return targetedSnapshot;
  };
}

export function makeProductionMarketplaceAdoptionRecoveryCoordinator(
  options: Pick<
    ProductionActiveRuntimeOptions,
    | 'repositoryPath'
    | 'worktreeBase'
    | 'runnerId'
    | 'credentials'
    | 'staleAfterMs'
    | 'runner'
    | 'environment'
    | 'now'
    | 'nextId'
    | 'sleep'
    | 'makeMarketplaceMutationAdoptionCoordinator'
  > & {
    readonly manifestPath: string;
    readonly readRecoverySnapshot: () => Promise<GitHubLifecycleSnapshot>;
  },
): MarketplaceMutationAdoptionCoordinator {
  const adoptionFactory = options.makeMarketplaceMutationAdoptionCoordinator
    ?? makeProductionMarketplaceMutationAdoptionCoordinator;
  return adoptionFactory({
    originManifestPath: options.manifestPath,
    repositoryPath: options.repositoryPath,
    worktreeBase: options.worktreeBase,
    runnerId: options.runnerId,
    credentials: options.credentials,
    readSnapshot: options.readRecoverySnapshot,
    staleAfterMs: options.staleAfterMs,
    runner: options.runner ?? defaultRunner,
    environment: options.environment ?? process.env,
    now: options.now,
    nextId: options.nextId,
    sleep: options.sleep,
  });
}
