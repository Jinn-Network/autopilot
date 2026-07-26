import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DispatcherConfig } from '../dispatcher/types.js';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
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
import {
  listRunnerLiveAttempts,
  trackAttemptChild,
  type TrackableAttemptChild,
} from './attempt-workspace.js';
import { makeActiveRuntime } from './active-runtime.js';
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
  executeMergeAction,
  executeFileReconcileChildAction,
  executeUpdateBranchAction,
} from './merge-executor.js';
import { makeProductionMergeActionPort } from './merge-executor-production.js';
import {
  executeProductionFileCiFailureChild,
  executeProductionRerunFailedChecks,
} from './ci-rerun-production.js';
import { repairProductionMachineChild } from './child-issues-production.js';
import { withSelectedCredential } from './production-auth.js';
import {
  makeProductionReconciliationWriter,
  type ReconciliationProjectItemNode,
  type ReconciliationPullRequestNode,
} from './reconciliation-writer-production.js';
import type { GitHubLifecycleSnapshot } from './snapshot.js';
import type {
  TargetedIssueActionContext,
  TargetedNativeIssue,
  TargetedOpenPullRequest,
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
  LocalSessionExecutionBackend,
  MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL,
  type LocalExactHeadReviewSessionExecutionRequest,
  type LocalImplementationSessionExecutionRequest,
} from './session-execution-backend.js';

export const AUTOPILOT_V2_REMOTE = 'jinn-autopilot-v2';

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
  ) => Promise<GitHubLifecycleSnapshot | null>;
  readonly readReservedReviewSnapshot: (
    cycleSnapshot: GitHubLifecycleSnapshot,
    prNumber: number,
  ) => Promise<GitHubLifecycleSnapshot | null>;
  /** Exact issue/PR closure reads used by implementation without a global scan. */
  readonly readImplementationSnapshot: (
    cycleSnapshot: GitHubLifecycleSnapshot,
    action: Extract<NewWorkAction, { kind: 'claim-implementation' }>,
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
    readonly review: number;
  };
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
   * Injectable delay for the bounded post-win confirmation retries in
   * review-claim acquisition (replication-lag tolerance;
   * see `confirmReviewAcquisition` in review-executor.ts). Defaults to a
   * real `setTimeout`-based sleep.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly newWorkPaused?: () => boolean;
}

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

function reviewScenario(input: {
  readonly prNumber: number;
  readonly issueNumber: number;
  readonly head: string;
  readonly worktreePath: string;
}): string {
  return [
    `Use the review-pr skill on PR #${input.prNumber} for issue #${input.issueNumber}.`,
    `The v2 lifecycle already claimed exact head \`${input.head}\` and created the detached worktree at \`${input.worktreePath}\`.`,
    'Finish with `autopilot session review-verdict --state <APPROVE|REQUEST_CHANGES> --body-file <path>` or park with `autopilot session human --reason-file <path>`.',
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
  | 'readCapabilityAttestation'
  | 'repositoryUrl'
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
      return {
        ok: false,
        detail: MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL,
      };
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
): ReturnType<typeof makeActiveRuntime> {
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
    const targeted = await options.readReviewSnapshot(cycleSnapshot, prNumber);
    if (targeted === null) {
      throw new Error(`Targeted PR authority for #${prNumber} is unavailable`);
    }
    return targeted;
  };
  const track = (manifestPath: string, child: SpawnResult): void => {
    trackAttempt(manifestPath, requireTrackable(child), { now });
  };
  const implementationPreferredLogin = executionBackend === 'marketplace'
    ? ''
    : (() => {
        const implementationPreferred = selectCredential(
          options.credentials,
          { phase: 'implement' },
        );
        return implementationPreferred.status === 'selected'
          ? implementationPreferred.login
          : options.credentials.logins()[0] ?? '';
      })();
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
  const requireLocalExecutionBackend = (): ProductionLocalExecutionBackend => {
    if (localExecutionBackend === undefined) {
      throw new Error(MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL);
    }
    return localExecutionBackend;
  };
  const startImplementationSession = (
    request: LocalImplementationSessionExecutionRequest<SpawnImplementationInput>,
  ) => requireLocalExecutionBackend().start(request);
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
    const live = await options.readPullRequestByNumber(input.candidate.number);
    if (
      live === null
      || live.state !== 'OPEN'
      || live.headOid !== input.candidate.head
    ) {
      throw new Error('Review Human escalation lost exact-head authority');
    }
    const currentRefOid = live.reviewClaim === null
      ? null
      : gitOid(live.reviewClaim.oid);
    const currentRecord = live.reviewClaim === null
      ? undefined
      : decodeReviewClaimPayload(live.reviewClaim.payload);
    const currentHeadRecord = currentRecord?.head === input.candidate.head
      ? currentRecord
      : undefined;
    const candidateAuthor = cycleSnapshot.pullRequests.find(
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
    let humanRefOid = currentRefOid;
    if (
      currentHeadRecord?.state !== 'human'
      || currentRefOid === null
    ) {
      const port = reviewActionPort({
        repositoryPath: options.repositoryPath,
        worktreeBase: options.worktreeBase,
        runnerId: options.runnerId,
        remoteName,
        readSnapshot: (prNumber) => options.readReviewSnapshot(cycleSnapshot, prNumber),
        runner,
        environment: ambient,
        repositorySlug: options.repositorySlug,
        repositoryUrl: options.repositoryUrl,
        projectMapping: options.projectMapping,
      });
      const recordOid = await port.createReviewRecord({
        record: humanRecord,
        parent: currentRefOid,
        credential: selection.credential,
      });
      const outcome = await port.publishReviewClaim({
        prNumber: input.candidate.number,
        recordParent: currentRefOid,
        expectedRemoteRecordOid: currentRefOid,
        recordOid,
        credential: selection.credential,
      });
      if (
        (outcome.status !== 'won' && outcome.status !== 'already-applied')
        || outcome.observed !== recordOid
      ) {
        throw new Error('Review Human escalation did not win exact-parent authority');
      }
      humanRefOid = recordOid;
    }
    if (humanRefOid === null) {
      throw new Error('Review Human escalation review-ref authority is absent');
    }
    const writer = makeProductionReconciliationWriter({
      repositoryPath: options.repositoryPath,
      cycleSnapshot,
      readPullRequestByNumber: options.readPullRequestByNumber,
      readProjectItemForReconciliation: options.readProjectItemForReconciliation,
      readBranchHeadByName: options.readBranchHeadByName,
      readIssueByNumber: options.readIssueByNumber,
      readBlockedByIssueNumbers: options.readBlockedByIssueNumbers,
      readOpenPullRequestsByIssue: options.readOpenPullRequestsByIssue,
      readIssueActionContext: options.readIssueActionContext,
      credential: selection.credential,
      credentials,
      runner,
      environment: ambient,
      repositorySlug: options.repositorySlug,
      repositoryUrl: options.repositoryUrl,
      defaultBranch: options.defaultBranch,
      now,
    });
    const diagnostic = cycleSnapshot.diagnostics.find((candidate) => (
      candidate.pullRequests.some((pr) => pr.number === input.candidate.number)
    ));
    const publicationReason: HumanReason = diagnostic === undefined
      ? input.reason
      : {
          phase: 'implementing',
          code: 'branch-mapping-ambiguous',
          detail: diagnostic.detail,
        };
    const marker = formatHumanCommentMarker({
      issueNumber: input.candidate.issueNumber,
      prNumber: input.candidate.number,
      head: input.candidate.head,
      generation,
      reason: publicationReason,
    });
    const authority = {
      issueNumber: input.candidate.issueNumber,
      expectedHead: input.candidate.head,
      expectedReviewRefOid: humanRefOid,
      expectedGeneration: generation,
      ...(diagnostic === undefined
        ? {}
        : {
            expectedDiagnosticIssueNumbers: diagnostic.issueNumbers,
            expectedDiagnosticDetail: diagnostic.detail,
          }),
    };
    if (!await writer.hasHumanComment(input.candidate.number, marker, authority)) {
      await writer.ensureHumanComment(
        input.candidate.number,
        marker,
        `${marker}\n\nAutopilot parked this item for Human review.\n\n${publicationReason.detail}`,
        authority,
      );
    }
  };

  const activeRuntime = makeActiveRuntime({
    credentials: options.credentials,
    caps: options.caps,
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
        requireLocalExecutionBackend();
        const port = implementationActionPort({
          repositoryPath: options.repositoryPath,
          worktreeBase: options.worktreeBase,
          runnerId: options.runnerId,
          remoteName,
          credentials,
          authorAllowlist: options.authorAllowlist,
          readSnapshot: () =>
            options.readImplementationSnapshot(cycleSnapshot, action),
          runner,
          environment: ambient,
          repositorySlug: options.repositorySlug,
          repositoryUrl: options.repositoryUrl,
          defaultBranch: options.defaultBranch,
          projectMapping: options.projectMapping,
        });
        return executeImplementationAction(action, {
          ...port,
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


      merge: (action, credentials, cycleSnapshot) => executeMergeAction({
        prNumber: action.prNumber,
        expectedHead: action.head,
        expectedBaseRefName: action.expectedBaseRefName,
      }, {
        ...makeProductionMergeActionPort({
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
      }),

      updateBranch: async (action, credentials, cycleSnapshot) => {
        const result = await executeUpdateBranchAction({
          prNumber: action.prNumber,
          expectedHead: action.head,
        }, {
          ...makeProductionMergeActionPort({
            readSnapshot: targetedPullRequestSnapshot(cycleSnapshot, action.prNumber),
            authorAllowlist: options.authorAllowlist,
            expectedBaseRefName: options.defaultBranch,
            repositorySlug: options.repositorySlug,
            projectOwner: options.projectMapping?.owner,
            projectNumber: options.projectMapping?.number,
            projectMapping: options.projectMapping,
            runner,
            environment: ambient,
          }),
          credentials,
        });
        return {
          status: result.status,
          ...(result.status === 'ineligible' || result.status === 'rejected'
            ? { reason: result.reason }
            : {}),
        };
      },

      fileReconcileChild: async (action, credentials, cycleSnapshot) => {
        const result = await executeFileReconcileChildAction({
          prNumber: action.prNumber,
          expectedHead: action.head,
          effort: action.effort,
        }, {
          ...makeProductionMergeActionPort({
            readSnapshot: targetedPullRequestSnapshot(cycleSnapshot, action.prNumber),
            authorAllowlist: options.authorAllowlist,
            expectedBaseRefName: options.defaultBranch,
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
  if (executionBackend === 'marketplace') {
    const unavailable = async (): Promise<never> => {
      throw new Error(MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL);
    };
    return {
      ...activeRuntime,
      executeAction: unavailable,
      executeReviewActions: unavailable,
    };
  }
  return activeRuntime;
}
