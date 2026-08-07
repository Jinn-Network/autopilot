import { isDeepStrictEqual } from 'node:util';
import {
  IssueRelayAdoptionReceiptV1Schema,
  type IssueRelayAdoptionReceiptV1,
} from './contracts.js';
import { relayBranch, relayGeneration } from './identity.js';
import {
  isVerifiedIssueRelaySolutionV1,
  isVerifiedIssueRelaySolutionV2,
  parseIssueRelayDeliveryObservation,
  type VerifiedIssueRelaySolutionObservation,
  type VerifiedIssueRelaySolutionObservationV2,
} from './marketplace-cli.js';
import type { IssueRelaySnapshotV1 } from './snapshot.js';
import {
  MarketplacePatchPolicyError,
  validateMarketplacePatch,
  type ValidatedMarketplacePatch,
} from '../lifecycle/marketplace-patch.js';
import {
  MarketplaceVerificationError,
  type MarketplaceMutationVerificationPort,
} from '../lifecycle/marketplace-mutation-verification.js';
import { gitOid } from '../lifecycle/types.js';
import type {
  RelayAdoptionPublisher,
  RelayPullRequest,
  RelayRepositoryAuthority,
} from './git-publisher.js';

export interface RelayAdoptionAuthority {
  readonly generation: string;
  readonly round: number;
  readonly targetRepository: 'Jinn-Network/mono';
  readonly workspaceRepository: string;
  readonly inputHead: string;
  readonly forkRepository: string;
  readonly branch: string;
  readonly existingPrNumber?: number;
  readonly cancellationRequested: boolean;
}

export interface AcceptedRelayAdoption {
  readonly status: 'accepted';
  readonly receipt: Extract<
    IssueRelayAdoptionReceiptV1,
    { readonly disposition: 'accepted' }
  >;
  readonly branch: string;
  readonly resultingHead: string;
  readonly prNumber: number;
}

export interface RejectedRelayAdoption {
  readonly status: 'rejected';
  readonly receipt: Extract<
    IssueRelayAdoptionReceiptV1,
    { readonly disposition: 'rejected' }
  >;
}

export type VerifiedRelaySolutionObservation =
  | VerifiedIssueRelaySolutionObservation
  | VerifiedIssueRelaySolutionObservationV2;

export interface RelayAdoptionCoordinator {
  adopt(input: {
    readonly authority: RelayAdoptionAuthority;
    readonly observation: VerifiedRelaySolutionObservation;
    readonly snapshot: IssueRelaySnapshotV1;
  }): Promise<AcceptedRelayAdoption | RejectedRelayAdoption>;
}

export interface RelayAdoptionExactAuthority {
  readonly generation: string;
  readonly round: number;
  readonly snapshotDigest: `sha256:${string}`;
  readonly targetRepository: 'Jinn-Network/mono';
  readonly workspaceRepository: string;
  readonly inputHead: string;
  readonly forkRepository: string;
  readonly branch: string;
  readonly taskId: string;
  readonly solutionOperator: string;
  readonly issueNumber: number;
  readonly defaultBranch: string;
  readonly targetRepositoryId: string;
  readonly forkRepositoryId: string;
  readonly forkParentRepositoryId: string;
  /** Current exact generation-branch head; absent only before its first push. */
  readonly expectedForkHead?: string;
  readonly cancellationRequested: boolean;
  readonly serviceLogin: string;
  readonly adoptionDeadline: string;
  readonly worktree: {
    readonly manifestPath: string;
    readonly path: string;
  };
  readonly pr?: RelayPullRequest;
}

export interface RelayAdoptionExactAuthorityPort {
  readExact(input: {
    readonly authority: RelayAdoptionAuthority;
    readonly observation: VerifiedRelaySolutionObservation;
    readonly snapshot: IssueRelaySnapshotV1;
  }): Promise<RelayAdoptionExactAuthority>;
}

export interface RelayAdoptionWorktreePort {
  prepareExact(input: {
    readonly generation: string;
    readonly round: number;
    readonly workspaceRepository: string;
    readonly expectedHead: string;
    readonly manifestPath: string;
    readonly worktreePath: string;
  }): Promise<{
    readonly manifestPath: string;
    readonly path: string;
    readonly expectedHead: string;
  }>;
}

export interface RelayAdoptionDependencies {
  readonly authority: RelayAdoptionExactAuthorityPort;
  readonly worktrees: RelayAdoptionWorktreePort;
  readonly applyPatch: (input: {
    readonly artifact: Uint8Array;
    readonly manifestPath: string;
    readonly worktreePath: string;
    readonly expectedHead: ReturnType<typeof gitOid>;
  }) => Promise<ValidatedMarketplacePatch>;
  readonly verification: MarketplaceMutationVerificationPort;
  readonly publisher: RelayAdoptionPublisher;
  readonly now?: () => Date;
}

type RejectionReason = Extract<
IssueRelayAdoptionReceiptV1,
{ readonly disposition: 'rejected' }
>['reason'];

function rejection(
  observation: VerifiedRelaySolutionObservation,
  reason: RejectionReason,
  detail: string,
  now: () => Date,
): RejectedRelayAdoption {
  const safeDetail = detail.replaceAll('\u0000', '\ufffd').slice(0, 8 * 1024);
  return {
    status: 'rejected',
    receipt: IssueRelayAdoptionReceiptV1Schema.parse({
      schemaVersion: 'jinn-issue-relay-adoption.v1',
      disposition: 'rejected',
      correlation: {
        generation: observation.round.generation,
        round: observation.round.round,
        snapshotDigest: observation.round.snapshotDigest,
        taskId: observation.task.taskId,
        attemptIndex: observation.attempt.attemptIndex,
        requestId: observation.attempt.requestId,
        deliveryEnvelopeCid: observation.delivery.envelopeCid,
      },
      reason,
      detail: safeDetail.length === 0 ? 'Relay adoption rejected' : safeDetail,
      recordedAt: now().toISOString(),
    }) as RejectedRelayAdoption['receipt'],
  };
}

function observationCorrelation(
  observation: VerifiedRelaySolutionObservation,
): IssueRelayAdoptionReceiptV1['correlation'] {
  return {
    generation: observation.round.generation,
    round: observation.round.round,
    snapshotDigest: observation.round.snapshotDigest as `sha256:${string}`,
    taskId: observation.task.taskId,
    attemptIndex: observation.attempt.attemptIndex,
    requestId: observation.attempt.requestId,
    deliveryEnvelopeCid: observation.delivery.envelopeCid,
  };
}

function baseCorrelationMatches(input: {
  readonly authority: RelayAdoptionAuthority;
  readonly observation: VerifiedRelaySolutionObservation;
  readonly snapshot: IssueRelaySnapshotV1;
}): boolean {
  const { authority, observation, snapshot } = input;
  const round = observation.round;
  return relayGeneration(snapshot) === authority.generation
    && relayBranch(authority.generation) === authority.branch
    && snapshot.repository.slug === authority.targetRepository
    && snapshot.schemaVersion === 'jinn-issue-relay-snapshot.v1'
    && snapshot.snapshotDigest === round.snapshotDigest
    && authority.generation === round.generation
    && authority.round === round.round
    && authority.targetRepository === round.targetRepository
    && authority.workspaceRepository === round.workspaceRepository
    && authority.inputHead === round.inputHead;
}

function liveStaticCorrelationMatches(input: {
  readonly requested: RelayAdoptionAuthority;
  readonly observation: VerifiedRelaySolutionObservation;
  readonly snapshot: IssueRelaySnapshotV1;
  readonly live: RelayAdoptionExactAuthority;
}): boolean {
  const { requested, observation, snapshot, live } = input;
  return live.generation === requested.generation
    && live.round === requested.round
    && live.snapshotDigest === snapshot.snapshotDigest
    && live.targetRepository === requested.targetRepository
    && live.workspaceRepository === requested.workspaceRepository
    && live.inputHead === requested.inputHead
    && live.forkRepository === requested.forkRepository
    && live.branch === requested.branch
    && live.taskId === observation.task.taskId
    && live.solutionOperator.toLowerCase()
      === observation.attempt.operator.toLowerCase()
    && live.issueNumber === snapshot.issue.number
    && live.defaultBranch === snapshot.repository.defaultBranch
    && live.targetRepository.toLowerCase()
      !== live.forkRepository.toLowerCase()
    && live.targetRepositoryId.length > 0
    && live.forkRepositoryId.length > 0
    && live.targetRepositoryId !== live.forkRepositoryId
    && live.forkParentRepositoryId === live.targetRepositoryId
    && live.worktree.manifestPath.length > 0
    && live.worktree.path.length > 0;
}

function repositoryAuthority(
  live: RelayAdoptionExactAuthority,
): RelayRepositoryAuthority {
  return {
    targetRepositoryId: live.targetRepositoryId,
    forkRepositoryId: live.forkRepositoryId,
    forkParentRepositoryId: live.forkParentRepositoryId,
  };
}

function repositoryAuthorityMatches(
  initial: RelayAdoptionExactAuthority,
  current: RelayAdoptionExactAuthority,
): boolean {
  return isDeepStrictEqual(
    repositoryAuthority(current),
    repositoryAuthority(initial),
  );
}

function authorityRereadMatches(input: {
  readonly requested: RelayAdoptionAuthority;
  readonly observation: VerifiedRelaySolutionObservation;
  readonly snapshot: IssueRelaySnapshotV1;
  readonly initial: RelayAdoptionExactAuthority;
  readonly current: RelayAdoptionExactAuthority;
}): boolean {
  return liveStaticCorrelationMatches({
    requested: input.requested,
    observation: input.observation,
    snapshot: input.snapshot,
    live: input.current,
  })
    && repositoryAuthorityMatches(input.initial, input.current)
    && input.current.serviceLogin === input.initial.serviceLogin;
}

function pullRequestRepositoryMatches(
  pr: RelayPullRequest,
  authority: RelayAdoptionExactAuthority,
): boolean {
  return pr.targetRepositoryId === authority.targetRepositoryId
    && pr.forkRepositoryId === authority.forkRepositoryId
    && pr.forkParentRepositoryId === authority.forkParentRepositoryId;
}

function expectedPreAdoptionForkHead(
  observation: VerifiedRelaySolutionObservation,
): string | undefined {
  return observation.round.purpose === 'initial'
    ? undefined
    : observation.round.inputHead;
}

function prMatchesPreAdoption(input: {
  readonly authority: RelayAdoptionAuthority;
  readonly observation: VerifiedRelaySolutionObservation;
  readonly live: RelayAdoptionExactAuthority;
}): boolean {
  const { authority, observation, live } = input;
  if (observation.round.purpose === 'initial') {
    return live.pr === undefined && authority.existingPrNumber === undefined;
  }
  const pr = live.pr;
  return pr !== undefined
    && pullRequestRepositoryMatches(pr, live)
    && authority.existingPrNumber === pr.number
    && observation.round.prNumber === pr.number
    && pr.generation === authority.generation
    && pr.branch === authority.branch
    && pr.head === authority.inputHead
    && pr.base === live.defaultBranch
    && pr.open
    && pr.draft;
}

function matchesRecoveredPublicationBoundary(input: {
  readonly authority: RelayAdoptionAuthority;
  readonly observation: VerifiedRelaySolutionObservation;
  readonly live: RelayAdoptionExactAuthority;
  readonly expectedPrNumber?: number;
}): boolean {
  const { authority, observation, live } = input;
  const forkHead = live.expectedForkHead;
  if (forkHead === undefined || !/^[0-9a-f]{40}$/.test(forkHead)) {
    return false;
  }
  const pr = live.pr;
  if (pr === undefined) {
    return observation.round.purpose === 'initial'
      && authority.existingPrNumber === undefined
      && input.expectedPrNumber === undefined;
  }
  return pr.generation === authority.generation
    && pullRequestRepositoryMatches(pr, live)
    && pr.branch === authority.branch
    && pr.head === forkHead
    && pr.base === live.defaultBranch
    && pr.open
    && pr.draft
    && input.expectedPrNumber !== undefined
    && pr.number === input.expectedPrNumber
    && (
      authority.existingPrNumber === undefined
      || authority.existingPrNumber === pr.number
    )
    && (
      observation.round.purpose === 'initial'
      || observation.round.prNumber === pr.number
    );
}

function acceptedReplayMatches(input: {
  readonly receipt: Extract<
  IssueRelayAdoptionReceiptV1,
  { readonly disposition: 'accepted' }
  >;
  readonly authority: RelayAdoptionAuthority;
  readonly observation: VerifiedRelaySolutionObservation;
  readonly snapshot: IssueRelaySnapshotV1;
  readonly patch: ValidatedMarketplacePatch;
}): boolean {
  const { receipt, authority, observation, snapshot, patch } = input;
  return isDeepStrictEqual(receipt.correlation, observationCorrelation(observation))
    && receipt.targetRepository === authority.targetRepository
    && receipt.workspaceRepository === authority.forkRepository
    && receipt.issueNumber === snapshot.issue.number
    && receipt.headRef === authority.branch
    && receipt.inputHead === authority.inputHead
    && receipt.patchDigest === patch.artifactDigest
    && receipt.solutionSafe.toLowerCase() === observation.attempt.operator.toLowerCase()
    && receipt.prNumber === authority.existingPrNumber;
}

function exactPublishedPr(input: {
  readonly pr: RelayPullRequest;
  readonly authority: RelayAdoptionAuthority;
  readonly defaultBranch: string;
  readonly resultingHead: string;
  readonly repository: RelayAdoptionExactAuthority;
  readonly expectedPrNumber?: number;
  readonly allowClosed?: boolean;
}): boolean {
  const {
    pr,
    authority,
    defaultBranch,
    resultingHead,
    repository,
  } = input;
  return pr.generation === authority.generation
    && pullRequestRepositoryMatches(pr, repository)
    && pr.branch === authority.branch
    && pr.head === resultingHead
    && pr.base === defaultBranch
    && (pr.open || input.allowClosed === true)
    && pr.draft
    && (
      input.expectedPrNumber === undefined
      || pr.number === input.expectedPrNumber
    );
}

function acceptedReceipt(input: {
  readonly authority: RelayAdoptionAuthority;
  readonly observation: VerifiedRelaySolutionObservation;
  readonly snapshot: IssueRelaySnapshotV1;
  readonly patch: ValidatedMarketplacePatch;
  readonly resultingHead: string;
  readonly prNumber: number;
  readonly now: () => Date;
}): AcceptedRelayAdoption['receipt'] {
  return IssueRelayAdoptionReceiptV1Schema.parse({
    schemaVersion: 'jinn-issue-relay-adoption.v1',
    disposition: 'accepted',
    correlation: observationCorrelation(input.observation),
    targetRepository: input.authority.targetRepository,
    workspaceRepository: input.authority.forkRepository,
    issueNumber: input.snapshot.issue.number,
    prNumber: input.prNumber,
    headRef: input.authority.branch,
    inputHead: input.authority.inputHead,
    resultingHead: input.resultingHead,
    patchDigest: input.patch.artifactDigest,
    solutionSafe: input.observation.attempt.operator,
    adoptedAt: input.now().toISOString(),
  }) as AcceptedRelayAdoption['receipt'];
}

export function makeRelayAdoptionCoordinator(
  dependencies: RelayAdoptionDependencies,
): RelayAdoptionCoordinator {
  const now = dependencies.now ?? (() => new Date());
  return {
    async adopt(input) {
      let observation: VerifiedRelaySolutionObservation;
      try {
        const parsed = parseIssueRelayDeliveryObservation(input.observation);
        if (
          !isVerifiedIssueRelaySolutionV1(parsed)
          && !isVerifiedIssueRelaySolutionV2(parsed)
        ) {
          throw new Error('Relay observation is not an authenticated solution');
        }
        observation = parsed as VerifiedRelaySolutionObservation;
      } catch {
        return rejection(
          input.observation,
          'correlation-mismatch',
          'Relay solution failed strict authenticated observation decoding',
          now,
        );
      }

      if (!baseCorrelationMatches({ ...input, observation })) {
        return rejection(
          observation,
          'correlation-mismatch',
          'Relay solution generation, round, snapshot, repository, or input head does not match',
          now,
        );
      }

      const live = await dependencies.authority.readExact({
        ...input,
        observation,
      });
      if (!liveStaticCorrelationMatches({
        requested: input.authority,
        observation,
        snapshot: input.snapshot,
        live,
      })) {
        return rejection(
          observation,
          'correlation-mismatch',
          'Relay task, operator, snapshot, or current authority does not match',
          now,
        );
      }
      const pinnedRepository = repositoryAuthority(live);
      const expectedPrNumber =
        input.authority.existingPrNumber ?? live.pr?.number;

      const artifact = new TextEncoder().encode(observation.payload.patch);
      let patch: ValidatedMarketplacePatch;
      try {
        patch = validateMarketplacePatch(artifact);
      } catch (error) {
        if (error instanceof MarketplacePatchPolicyError) {
          return rejection(
            observation,
            'unsafe-patch',
            `Relay patch policy rejected the artifact: ${error.reason}`,
            now,
          );
        }
        throw error;
      }

      const replay = await dependencies.publisher.recoverAccepted({
        ...pinnedRepository,
        generation: input.authority.generation,
        targetRepository: input.authority.targetRepository,
        forkRepository: input.authority.forkRepository,
        branch: input.authority.branch,
        prNumber: input.authority.existingPrNumber ?? live.pr?.number,
        defaultBranch: live.defaultBranch,
        serviceLogin: live.serviceLogin,
        correlation: observationCorrelation(observation),
        allowClosed:
          live.cancellationRequested || input.authority.cancellationRequested,
      });
      if (replay !== undefined) {
        if (!acceptedReplayMatches({
          receipt: replay,
          authority: {
            ...input.authority,
            existingPrNumber: input.authority.existingPrNumber ?? replay.prNumber,
          },
          observation,
          snapshot: input.snapshot,
          patch,
        })) {
          throw new Error('Relay accepted replay contradicts the exact adoption identity');
        }
        const afterReplay = await dependencies.authority.readExact({
          ...input,
          observation,
        });
        const cancellationRequested =
          live.cancellationRequested
          || afterReplay.cancellationRequested
          || input.authority.cancellationRequested;
        if (
          !authorityRereadMatches({
            requested: input.authority,
            observation,
            snapshot: input.snapshot,
            initial: live,
            current: afterReplay,
          })
          || afterReplay.expectedForkHead !== replay.resultingHead
          || afterReplay.pr === undefined
          || !exactPublishedPr({
            pr: afterReplay.pr,
            authority: input.authority,
            defaultBranch: afterReplay.defaultBranch,
            resultingHead: replay.resultingHead,
            repository: live,
            expectedPrNumber: replay.prNumber,
            allowClosed: cancellationRequested,
          })
        ) {
          return rejection(
            observation,
            'authority-changed',
            'Relay exact authority changed during accepted receipt recovery',
            now,
          );
        }
        if (
          cancellationRequested
        ) {
          if (afterReplay.pr.open) {
            await dependencies.publisher.closeDraftPullRequest({
              ...pinnedRepository,
              targetRepository: input.authority.targetRepository,
              pr: afterReplay.pr,
              expectedHead: replay.resultingHead,
              reason: 'Relay generation was cancelled',
            });
          }
          return rejection(
            observation,
            'cancelled',
            'Relay generation was cancelled after accepted adoption',
            now,
          );
        }
        return {
          status: 'accepted',
          receipt: replay,
          branch: replay.headRef,
          resultingHead: replay.resultingHead,
          prNumber: replay.prNumber,
        };
      }

      if (live.cancellationRequested || input.authority.cancellationRequested) {
        return rejection(
          observation,
          'cancelled',
          'Relay generation was cancelled before adoption mutation',
          now,
        );
      }
      const expectedForkHead = expectedPreAdoptionForkHead(observation);
      const recoveredPublication = live.expectedForkHead === expectedForkHead
        ? undefined
        : await dependencies.publisher.recoverPublished({
          generation: input.authority.generation,
          round: input.authority.round,
          branch: input.authority.branch,
          targetRepository: input.authority.targetRepository,
          ...pinnedRepository,
          forkRepository: input.authority.forkRepository,
          worktreePath: live.worktree.path,
          inputHead: input.authority.inputHead,
          summary: input.snapshot.issue.title,
          taskId: observation.task.taskId,
          deliveryEnvelopeCid: observation.delivery.envelopeCid,
          patchDigest: patch.artifactDigest,
        });
      if (
        !(
          live.expectedForkHead === expectedForkHead
          && prMatchesPreAdoption({
            authority: input.authority,
            observation,
            live,
          })
        )
        && !(
          recoveredPublication !== undefined
          && recoveredPublication.resultingHead === live.expectedForkHead
          && recoveredPublication.branch === input.authority.branch
          && matchesRecoveredPublicationBoundary({
            authority: input.authority,
            observation,
            live,
            expectedPrNumber,
          })
        )
      ) {
        return rejection(
          observation,
          'stale-input',
          'Relay fork or pull request no longer equals the exact round input',
          now,
        );
      }

      const inputWorktree = await dependencies.worktrees.prepareExact({
        generation: input.authority.generation,
        round: input.authority.round,
        workspaceRepository: input.authority.workspaceRepository,
        expectedHead: input.authority.inputHead,
        manifestPath: live.worktree.manifestPath,
        worktreePath: live.worktree.path,
      });
      if (
        inputWorktree.manifestPath !== live.worktree.manifestPath
        || inputWorktree.path !== live.worktree.path
        || inputWorktree.expectedHead !== input.authority.inputHead
      ) {
        throw new Error(
          'Relay worktree preparation did not read back exact input authority',
        );
      }

      let applied: ValidatedMarketplacePatch;
      try {
        applied = await dependencies.applyPatch({
          artifact: Uint8Array.from(patch.artifact),
          manifestPath: inputWorktree.manifestPath,
          worktreePath: inputWorktree.path,
          expectedHead: gitOid(input.authority.inputHead),
        });
      } catch (error) {
        if (error instanceof MarketplacePatchPolicyError) {
          return rejection(
            observation,
            'unsafe-patch',
            `Relay patch application rejected the artifact: ${error.reason}`,
            now,
          );
        }
        throw error;
      }
      if (
        applied.artifactDigest !== patch.artifactDigest
        || !isDeepStrictEqual(applied.touchedPaths, patch.touchedPaths)
      ) {
        throw new Error(
          'Relay patch application readback differs from policy validation',
        );
      }
      const expectedTree = gitOid(
        await dependencies.publisher.readAppliedTree({
          worktreePath: inputWorktree.path,
          inputHead: input.authority.inputHead,
        }),
      );

      if (recoveredPublication !== undefined) {
        if (recoveredPublication.tree !== expectedTree) {
          return rejection(
            observation,
            'stale-input',
            'Relay recovered commit tree differs from the authenticated patch tree',
            now,
          );
        }
        const recoveredWorktree = await dependencies.worktrees.prepareExact({
          generation: input.authority.generation,
          round: input.authority.round,
          workspaceRepository: input.authority.forkRepository,
          expectedHead: recoveredPublication.resultingHead,
          manifestPath: live.worktree.manifestPath,
          worktreePath: live.worktree.path,
        });
        if (
          recoveredWorktree.manifestPath !== live.worktree.manifestPath
          || recoveredWorktree.path !== live.worktree.path
          || recoveredWorktree.expectedHead
            !== recoveredPublication.resultingHead
        ) {
          throw new Error(
            'Relay recovered worktree did not read back exact fork authority',
          );
        }
      }
      try {
        await dependencies.verification.verify({
          profile: input.snapshot.verificationProfile,
          repositoryPath: live.worktree.path,
          touchedPaths: applied.touchedPaths,
          artifactDigest: applied.artifactDigest,
          expectedTree,
          deadline: live.adoptionDeadline,
        });
      } catch (error) {
        if (
          error instanceof MarketplaceVerificationError
          && error.disposition === 'stable-rejection'
        ) {
          return rejection(
            observation,
            'verification-failed',
            `Relay deterministic verification failed: ${error.reason}`,
            now,
          );
        }
        throw error;
      }

      const beforePush = await dependencies.authority.readExact({
        ...input,
        observation,
      });
      const beforePushBoundaryMatches = recoveredPublication === undefined
        ? (
          beforePush.expectedForkHead === expectedForkHead
          && prMatchesPreAdoption({
            authority: input.authority,
            observation,
            live: beforePush,
          })
        )
        : (
          beforePush.expectedForkHead === recoveredPublication.resultingHead
          && matchesRecoveredPublicationBoundary({
            authority: input.authority,
            observation,
            live: beforePush,
            expectedPrNumber,
          })
        );
      if (
        !authorityRereadMatches({
          requested: input.authority,
          observation,
          snapshot: input.snapshot,
          initial: live,
          current: beforePush,
        })
        || !beforePushBoundaryMatches
      ) {
        return rejection(
          observation,
          'authority-changed',
          'Relay exact repository authority changed before expected-old push',
          now,
        );
      }
      if (beforePush.cancellationRequested) {
        if (beforePush.pr !== undefined) {
          await dependencies.publisher.closeDraftPullRequest({
            ...pinnedRepository,
            targetRepository: input.authority.targetRepository,
            pr: beforePush.pr,
            expectedHead: beforePush.pr.head,
            reason: 'Relay generation was cancelled',
          });
        }
        return rejection(
          observation,
          'cancelled',
          'Relay generation was cancelled before expected-old push',
          now,
        );
      }

      const published = await dependencies.publisher.commitAndPush({
        generation: input.authority.generation,
        round: input.authority.round,
        branch: input.authority.branch,
        targetRepository: input.authority.targetRepository,
        ...pinnedRepository,
        forkRepository: input.authority.forkRepository,
        worktreePath: live.worktree.path,
        inputHead: input.authority.inputHead,
        expectedTree,
        expectedForkHead: expectedPreAdoptionForkHead(observation),
        summary: input.snapshot.issue.title,
        taskId: observation.task.taskId,
        deliveryEnvelopeCid: observation.delivery.envelopeCid,
        patchDigest: applied.artifactDigest,
      });

      const afterPush = await dependencies.authority.readExact({
        ...input,
        observation,
      });
      const afterPushPrMatches = afterPush.pr === undefined
        ? expectedPrNumber === undefined
        : (
          expectedPrNumber !== undefined
          && exactPublishedPr({
            pr: afterPush.pr,
            authority: input.authority,
            defaultBranch: afterPush.defaultBranch,
            resultingHead: published.resultingHead,
            repository: live,
            expectedPrNumber,
          })
        );
      if (
        !authorityRereadMatches({
          requested: input.authority,
          observation,
          snapshot: input.snapshot,
          initial: live,
          current: afterPush,
        })
        || afterPush.expectedForkHead !== published.resultingHead
        || !afterPushPrMatches
      ) {
        return rejection(
          observation,
          'authority-changed',
          'Relay exact authority changed after expected-old fork push',
          now,
        );
      }
      if (afterPush.cancellationRequested) {
        if (afterPush.pr !== undefined) {
          await dependencies.publisher.closeDraftPullRequest({
            ...pinnedRepository,
            targetRepository: input.authority.targetRepository,
            pr: afterPush.pr,
            expectedHead: published.resultingHead,
            reason: 'Relay generation was cancelled',
          });
        }
        return rejection(
          observation,
          'cancelled',
          'Relay generation was cancelled after host adoption',
          now,
        );
      }

      const pr = await dependencies.publisher.ensureDraftPullRequest({
        ...pinnedRepository,
        generation: input.authority.generation,
        targetRepository: input.authority.targetRepository,
        forkRepository: input.authority.forkRepository,
        branch: input.authority.branch,
        resultingHead: published.resultingHead,
        defaultBranch: afterPush.defaultBranch,
        issueNumber: input.snapshot.issue.number,
        title: observation.round.schemaVersion === 'jinn-issue-relay-round.v2'
          ? observation.payload.pullRequest.title
          : `Jinn Issue Relay: #${input.snapshot.issue.number}`,
        body: observation.round.schemaVersion === 'jinn-issue-relay-round.v2'
          ? observation.payload.pullRequest.body
          : `Implements #${input.snapshot.issue.number}.`,
        existingPrNumber: expectedPrNumber,
      });
      if (!exactPublishedPr({
        pr,
        authority: input.authority,
        defaultBranch: afterPush.defaultBranch,
        resultingHead: published.resultingHead,
        repository: live,
        expectedPrNumber,
      })) {
        throw new Error('Relay draft pull request failed exact adoption readback');
      }

      const afterPr = await dependencies.authority.readExact({
        ...input,
        observation,
      });
      if (
        !authorityRereadMatches({
          requested: input.authority,
          observation,
          snapshot: input.snapshot,
          initial: live,
          current: afterPr,
        })
        || afterPr.expectedForkHead !== published.resultingHead
        || afterPr.serviceLogin !== live.serviceLogin
        || afterPr.pr === undefined
        || afterPr.pr.number !== pr.number
        || !exactPublishedPr({
          pr: afterPr.pr,
          authority: input.authority,
          defaultBranch: afterPr.defaultBranch,
          resultingHead: published.resultingHead,
          repository: live,
          expectedPrNumber: pr.number,
        })
      ) {
        return rejection(
          observation,
          'authority-changed',
          'Relay exact authority changed before adoption receipt publication',
          now,
        );
      }
      if (afterPr.cancellationRequested) {
        await dependencies.publisher.closeDraftPullRequest({
          ...pinnedRepository,
          targetRepository: input.authority.targetRepository,
          pr,
          expectedHead: published.resultingHead,
          reason: 'Relay generation was cancelled',
        });
        return rejection(
          observation,
          'cancelled',
          'Relay generation was cancelled after draft pull request creation',
          now,
        );
      }

      const receipt = acceptedReceipt({
        authority: input.authority,
        observation,
        snapshot: input.snapshot,
        patch: applied,
        resultingHead: published.resultingHead,
        prNumber: pr.number,
        now,
      });
      const readback = await dependencies.publisher.publishAdoptionReceipt({
        ...pinnedRepository,
        targetRepository: input.authority.targetRepository,
        pr,
        serviceLogin: afterPr.serviceLogin,
        receipt,
      });
      if (
        readback.disposition !== 'accepted'
        || !isDeepStrictEqual(readback, receipt)
      ) {
        throw new Error('Relay adoption receipt did not read back exactly');
      }
      const afterReceipt = await dependencies.authority.readExact({
        ...input,
        observation,
      });
      if (
        !authorityRereadMatches({
          requested: input.authority,
          observation,
          snapshot: input.snapshot,
          initial: live,
          current: afterReceipt,
        })
        || afterReceipt.expectedForkHead !== published.resultingHead
        || afterReceipt.pr === undefined
        || !exactPublishedPr({
          pr: afterReceipt.pr,
          authority: input.authority,
          defaultBranch: afterReceipt.defaultBranch,
          resultingHead: published.resultingHead,
          repository: live,
          expectedPrNumber: pr.number,
        })
      ) {
        return rejection(
          observation,
          'authority-changed',
          'Relay exact authority changed after adoption receipt publication',
          now,
        );
      }
      if (afterReceipt.cancellationRequested) {
        await dependencies.publisher.closeDraftPullRequest({
          ...pinnedRepository,
          targetRepository: input.authority.targetRepository,
          pr: afterReceipt.pr,
          expectedHead: published.resultingHead,
          reason: 'Relay generation was cancelled',
        });
        return rejection(
          observation,
          'cancelled',
          'Relay generation was cancelled during adoption receipt publication',
          now,
        );
      }
      return {
        status: 'accepted',
        receipt,
        branch: published.branch,
        resultingHead: published.resultingHead,
        prNumber: pr.number,
      };
    },
  };
}
