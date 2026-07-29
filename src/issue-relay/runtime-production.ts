import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve as resolvePath,
  sep,
} from 'node:path';
import { execFile } from 'node:child_process';
import { isDeepStrictEqual, promisify } from 'node:util';
import type { IssueRelayConfig } from './config.js';
import { parseIssueRelayConfig } from './config.js';
import {
  createRelayGitHubProductionPorts,
  type RelayGitHubProductionAuthorityPort,
} from './github-production.js';
import {
  admitRelayIssue,
} from './admission.js';
import { admitRelaySpend, type RelaySpendLedger } from './budget.js';
import { relayBranch, relayGeneration } from './identity.js';
import {
  parseRelayIssueCommentMarker,
  renderRelayIssueComment,
} from './report.js';
import {
  formatRelayIssueMarker,
  prepareRelayIssueMarkerUpdate,
} from './markers.js';
import {
  persistRelayCancellation,
  type RelayGenerationRecordV1,
} from './state.js';
import {
  buildRelaySnapshot,
  type IssueRelaySnapshotV1,
} from './snapshot.js';
import {
  buildRelayMarketplaceRequest,
  buildRelayTaskSpec,
  persistRelayMarketplaceRequest,
  verifyRelayMarketplaceRequest,
} from './task.js';
import {
  buildRelaySolutionExpectation,
  buildRelayVerdictExpectation,
  installVerifiedRelayObservation,
  persistRelaySolutionExpectation,
  persistRelaySubmissionEvidence,
  persistRelayVerdictExpectation,
  readVerifiedRelayObservation,
  observeAndInstallRelayVerdict,
} from './marketplace-state.js';
import {
  IssueRelayMarketplaceCli,
  type VerifiedIssueRelaySolutionObservation,
} from './marketplace-cli.js';
import {
  aggregateRelayChecks,
  createRelayEvaluationAnchorPublisher,
  relayRequiredCheckStatus,
  type RelayCheckSummary,
} from './checks.js';
import {
  createRelayGitPublisher,
  formatRelayAdoptionReceiptBlock,
  parseRelayAdoptionReceiptBlock,
  type RelayGitCommand,
  type RelayGitCommandResult,
  type RelayGitCommandRunner,
} from './git-publisher.js';
import {
  formatRelayEvaluationAnchorBlock,
  parseRelayEvaluationAnchorBlock,
} from './checks.js';
import { relayAdoptionReceiptDigest } from './checks.js';
import {
  canonicalRelayTimeline,
  createRelayReportPublisher,
} from './report.js';
import type {
  AcceptedRelayAdoption,
} from './adoption.js';
import { makeRelayAdoptionCoordinator } from './adoption.js';
import type {
  IssueRelayEvaluationAnchorV1,
} from './contracts.js';
import { resolveInstalledJinnBinary } from '../lifecycle/marketplace-cli.js';
import {
  createMarketplaceVerificationDockerSandbox,
  createProductionMarketplaceVerificationPort,
} from '../lifecycle/marketplace-mutation-verification-production.js';
import {
  applyMarketplacePatchToWorktree,
  runMarketplacePatchGit,
} from '../lifecycle/marketplace-patch.js';
import type { RelayAdoptionCoordinator } from './adoption.js';
import type {
  RelayCycleReport,
  RelayDurableArtifactStore,
  RelayReconciliationCandidate,
  RelayReconciliationPort,
} from './reconciler.js';
import { runIssueRelayCycle } from './reconciler.js';
import { gitOid } from '../lifecycle/types.js';
import type {
  RelayGitHubReadPort,
  RelayGitHubWritePort,
} from './github-port.js';

const SAFE_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function assertOwnerOnlyDirectory(path: string, label: string): void {
  const metadata = lstatSync(path);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (metadata.mode & 0o777) !== 0o700
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
  ) {
    throw new Error(`${label} must be an owner-only 0700 directory`);
  }
}

function assertPrivateRegularFile(path: string, label: string): void {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || (metadata.mode & 0o777) !== 0o600
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
  ) {
    throw new Error(`${label} must be an owner-owned regular 0600 file`);
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

function safeRelativePath(relativePath: string): readonly string[] {
  if (
    relativePath.length === 0
    || isAbsolute(relativePath)
    || relativePath.includes('\\')
    || relativePath.includes('\u0000')
    || posix.normalize(relativePath) !== relativePath
  ) {
    throw new Error('Relay artifact path must be a canonical relative path');
  }
  const segments = relativePath.split('/');
  if (
    segments.some((segment) =>
      segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error('Relay artifact path must be a canonical relative path');
  }
  return segments;
}

function ensurePrivateParents(
  stateDirectory: string,
  segments: readonly string[],
): string {
  let parent = stateDirectory;
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    try {
      mkdirSync(parent, { mode: 0o700 });
      chmodSync(parent, 0o700);
      fsyncDirectory(dirname(parent));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    assertOwnerOnlyDirectory(parent, 'Relay artifact directory');
  }
  return parent;
}

export function createRelayDurableArtifactStore(
  stateDirectory: string,
  options: { readonly deferCreation?: boolean } = {},
): RelayDurableArtifactStore {
  if (!isAbsolute(stateDirectory)) {
    throw new Error('Relay state directory must be absolute');
  }
  if (!existsSync(stateDirectory) && options.deferCreation !== true) {
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    chmodSync(stateDirectory, 0o700);
    fsyncDirectory(dirname(stateDirectory));
  }
  if (existsSync(stateDirectory)) {
    assertOwnerOnlyDirectory(stateDirectory, 'Relay state directory');
  }

  const resolve = (relativePath: string): {
    readonly path: string;
    readonly parent: string;
  } => {
    const segments = safeRelativePath(relativePath);
    const parent = ensurePrivateParents(stateDirectory, segments);
    return {
      path: join(parent, segments.at(-1)!),
      parent,
    };
  };

  return {
    async installImmutable(input) {
      if (!existsSync(stateDirectory)) {
        throw new Error('Relay state directory requires an active writer lease');
      }
      assertOwnerOnlyDirectory(stateDirectory, 'Relay state directory');
      const target = resolve(input.relativePath);
      const temporary = join(
        target.parent,
        `.${input.relativePath.split('/').at(-1)}.tmp-${process.pid}-${randomUUID()}`,
      );
      let descriptor: number | undefined;
      try {
        descriptor = openSync(temporary, 'wx', 0o600);
        writeFileSync(descriptor, input.bytes);
        chmodSync(temporary, 0o600);
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        try {
          linkSync(temporary, target.path);
          fsyncDirectory(target.parent);
          return 'created';
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          assertPrivateRegularFile(target.path, 'Existing Relay artifact');
          if (!readFileSync(target.path).equals(input.bytes)) {
            throw new Error('Existing Relay artifact conflicts with canonical bytes');
          }
          return 'identical';
        }
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        if (existsSync(temporary)) {
          unlinkSync(temporary);
          fsyncDirectory(target.parent);
        }
      }
    },

    async read(relativePath) {
      if (!existsSync(stateDirectory)) return null;
      assertOwnerOnlyDirectory(stateDirectory, 'Relay state directory');
      const target = resolve(relativePath);
      try {
        assertPrivateRegularFile(target.path, 'Relay artifact');
        return readFileSync(target.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
  };
}

function createRelayReadOnlyArtifactStore(
  stateDirectory: string,
): RelayDurableArtifactStore {
  if (!isAbsolute(stateDirectory)) {
    throw new Error('Relay state directory must be absolute');
  }
  return {
    async installImmutable() {
      throw new Error('Observe mode permits no durable artifact writes');
    },
    async read(relativePath) {
      const segments = safeRelativePath(relativePath);
      if (!existsSync(stateDirectory)) return null;
      assertOwnerOnlyDirectory(stateDirectory, 'Relay state directory');
      let parent = stateDirectory;
      for (const segment of segments.slice(0, -1)) {
        parent = join(parent, segment);
        try {
          assertOwnerOnlyDirectory(parent, 'Relay artifact directory');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
      }
      const path = join(parent, segments.at(-1)!);
      try {
        assertPrivateRegularFile(path, 'Relay artifact');
        return readFileSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
  };
}

export interface IssueRelayRuntimeLease {
  /**
   * Releases the single-host V0 writer lease. A process crash intentionally
   * leaves `runtime.lock` behind so restart fails closed until an operator
   * verifies that no writer remains and removes that one file.
   */
  release(): void;
}

export function acquireIssueRelayRuntimeLease(
  stateDirectory: string,
): IssueRelayRuntimeLease {
  createRelayDurableArtifactStore(stateDirectory);
  const lockPath = join(stateDirectory, 'runtime.lock');
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        'Issue Relay writer lease is already active or requires operator recovery',
      );
    }
    throw error;
  }
  try {
    writeFileSync(descriptor, Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    })}\n`));
    chmodSync(lockPath, 0o600);
    fsyncSync(descriptor);
    fsyncDirectory(stateDirectory);
  } catch (error) {
    closeSync(descriptor);
    if (existsSync(lockPath)) unlinkSync(lockPath);
    throw error;
  }
  const identity = fstatSync(descriptor);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        const current = lstatSync(lockPath);
        if (
          current.isSymbolicLink()
          || !current.isFile()
          || current.dev !== identity.dev
          || current.ino !== identity.ino
        ) {
          throw new Error('Issue Relay writer lease authority changed');
        }
        unlinkSync(lockPath);
        fsyncDirectory(stateDirectory);
      } finally {
        closeSync(descriptor);
      }
    },
  };
}

export async function prepareRelayVerificationWorkspace(input: {
  readonly sourcePath: string;
  readonly workspacePath: string;
}): Promise<void> {
  const source = resolvePath(input.sourcePath);
  const workspace = resolvePath(input.workspacePath);
  if (workspace === source || workspace.startsWith(`${source}${sep}`)) {
    throw new Error('Relay verification workspace must be outside its source');
  }
  await rm(workspace, { recursive: true, force: true });
  await cp(source, workspace, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: (path) => {
      const segments = relative(source, resolvePath(path))
        .split(sep)
        .filter(Boolean);
      return !segments.includes('.git') && !segments.includes('node_modules');
    },
  });
}

export interface IssueRelayGitHubPreflight {
  readonly authenticatedLogin: string;
  readonly targetRepository: string;
  readonly targetRepositoryId: string;
  readonly targetVisibility: 'PUBLIC' | 'PRIVATE' | 'INTERNAL';
  readonly targetBase: string;
  readonly label: string;
  readonly forkRepository: string;
  readonly forkRepositoryId: string;
  readonly forkOwner: string;
  readonly forkParentRepositoryId: string;
  readonly forkVisibility: 'PUBLIC' | 'PRIVATE' | 'INTERNAL';
}

export interface IssueRelayProductionPreflightOptions {
  readonly config: IssueRelayConfig;
  readonly stateDirectory: string;
  readonly github: () => Promise<IssueRelayGitHubPreflight>;
  readonly resolveJinnBinary: () => Promise<string>;
  readonly marketplaceDryRun: (input: {
    readonly solverNet: string;
    readonly jinnBinary: string;
    readonly maximumSpendWei: bigint;
  }) => Promise<{
    readonly creatorSafe: string;
    readonly solverNet: string;
    readonly escrowReady: boolean;
    readonly proposedSpendWei: bigint;
  }>;
  readonly verificationRuntime: (
    profile: 'jinn-mono.v1',
  ) => Promise<boolean>;
}

export interface IssueRelayPreflightEvidence {
  readonly jinnBinary: string;
  readonly creatorSafe: string;
  readonly targetRepositoryId: string;
  readonly forkRepositoryId: string;
}

function deadlineFromSnapshot(
  snapshot: IssueRelaySnapshotV1,
  generationDeadlineMs: number,
): string {
  const capturedAt = Date.parse(snapshot.capturedAt);
  const deadline = capturedAt + generationDeadlineMs;
  if (
    !Number.isSafeInteger(generationDeadlineMs)
    || generationDeadlineMs <= 0
    || !Number.isFinite(capturedAt)
    || !Number.isFinite(deadline)
  ) {
    throw new Error('Relay generation deadline cannot be derived safely');
  }
  return new Date(deadline).toISOString();
}

function issueStatusBody(
  record: RelayGenerationRecordV1,
  summary: string,
  nextAction: string,
): string {
  return renderRelayIssueComment({
    record,
    generation: record.generation,
    phase: record.phase,
    prNumber: record.pr?.number,
    round: record.rounds.at(-1)?.round ?? 0,
    summary,
    nextAction,
  });
}

export async function readRelayPublicationAuthority(input: {
  readonly config: IssueRelayConfig;
  readonly record: RelayGenerationRecordV1;
  readonly githubRead: RelayGitHubReadPort;
  readonly githubAuthority: RelayGitHubProductionAuthorityPort;
  readonly allowReady: boolean;
  readonly expectedChecksDigest?: string;
}): Promise<{
  readonly pr: Awaited<
  ReturnType<RelayGitHubProductionAuthorityPort['readPullRequest']>
  >;
  readonly currentBaseOid: string;
  readonly checks: RelayCheckSummary;
}> {
  const durablePr = input.record.pr;
  if (durablePr === undefined) {
    throw new Error('Relay publication authority requires a pull request');
  }
  const assertPullRequest = (
    pr: Awaited<
    ReturnType<RelayGitHubProductionAuthorityPort['readPullRequest']>
    >,
  ): void => {
    const draftMatches = pr.draft === durablePr.draft
      || (
        input.allowReady
        && durablePr.draft
        && !pr.draft
      );
    if (
      pr.number !== durablePr.number
      || pr.generation !== input.record.generation
      || pr.branch !== durablePr.branch
      || pr.head !== durablePr.head
      || pr.base !== input.config.targetBase
      || !pr.open
      || !draftMatches
      || (
        durablePr.targetRepositoryId !== undefined
        && pr.targetRepositoryId !== durablePr.targetRepositoryId
      )
      || (
        durablePr.forkRepositoryId !== undefined
        && pr.forkRepositoryId !== durablePr.forkRepositoryId
      )
      || (
        durablePr.forkParentRepositoryId !== undefined
        && pr.forkParentRepositoryId !== durablePr.forkParentRepositoryId
      )
    ) {
      throw new Error('Relay pull request publication authority changed');
    }
  };

  const pr = await input.githubAuthority.readPullRequest(durablePr.number);
  assertPullRequest(pr);
  const currentBaseOid = await input.githubRead.readDefaultBranchHead();
  if (currentBaseOid !== input.record.snapshot.repository.baseOid) {
    throw new Error('Relay base publication authority changed');
  }
  const observed = await input.githubAuthority.readChecks({
    head: pr.head,
    base: pr.base,
  });
  const checks = aggregateRelayChecks({
    head: pr.head,
    branchRequiredChecks: observed.branchRequiredChecks,
    profile: {
      name: input.config.verificationProfile,
      requiredChecks: input.config.requiredChecks,
    },
    checks: observed.checks,
  });
  const readback = await input.githubAuthority.readPullRequest(durablePr.number);
  assertPullRequest(readback);
  if (
    readback.head !== pr.head
    || readback.base !== pr.base
    || readback.draft !== pr.draft
    || (
      input.expectedChecksDigest !== undefined
      && checks.digest !== input.expectedChecksDigest
    )
  ) {
    throw new Error('Relay final check publication authority changed');
  }
  return { pr: readback, currentBaseOid, checks };
}

export function createIssueRelayProductionReconciliation(options: {
  readonly config: IssueRelayConfig;
  readonly stateDirectory: string;
  readonly githubRead: RelayGitHubReadPort;
  readonly githubWrite: RelayGitHubWritePort;
  readonly githubAuthority: RelayGitHubProductionAuthorityPort;
  readonly marketplace: IssueRelayMarketplaceCli;
  readonly adopter: RelayAdoptionCoordinator;
  readonly artifacts: RelayDurableArtifactStore;
  readonly now: () => Date;
}): RelayReconciliationPort {
  let lastScan: readonly RelayReconciliationCandidate[] = [];
  let readReadiness: (
    candidate: RelayReconciliationCandidate,
  ) => Promise<RelayReconciliationCandidate['facts']['readiness']> =
    async () => undefined;

  const readCandidate = async (
    issueNumber: number,
  ): Promise<RelayReconciliationCandidate | undefined> => {
    const issue = await options.githubRead.readIssue(issueNumber);
    const [labelEvents, permission, currentBaseOid, comments] = await Promise.all([
      options.githubRead.listLabelEvents(issueNumber),
      options.githubRead.readRepositoryPermission(issue.issue.authorLogin),
      options.githubRead.readDefaultBranchHead(),
      options.githubAuthority.listIssueComments(issueNumber),
    ]);
    const owned = comments
      .filter(({ authorLogin }) => sameName(
        authorLogin,
        options.config.relayBotLogin,
      ))
      .map((comment) => ({
        ...comment,
        record: parseRelayIssueCommentMarker(
          comment.body,
          comment.authorLogin,
          options.config.relayBotLogin,
        ),
      }))
      .filter((comment) => comment.record !== null);
    if (owned.length > 1) {
      return {
        generation: `ambiguous:${issue.repository.nodeId}:${issueNumber}`,
        repository: issue.repository.slug,
        issueNumber,
        transitionedAt: issue.issue.updatedAt,
        authority: 'ambiguous',
        facts: {
          issue: {
            open: issue.issue.state === 'OPEN',
            optedIn: issue.issue.labels.some((label) =>
              sameName(label, options.config.label)),
          },
          currentBaseOid,
          now: options.now().toISOString(),
        },
      };
    }
    const admission = admitRelayIssue({
      issue,
      labelEvents,
      currentPermission: permission,
      currentBaseOid,
      policy: {
        repository: options.config.repository,
        label: options.config.label,
        maxIssueBytes: 256 * 1024,
        maxAcceptanceItems: 50,
        forbiddenRequestPatterns: [
          /\b(?:private key|seed phrase|repository secret)\b/i,
          /\b(?:deploy|release to production)\b/i,
        ],
      },
      now: options.now(),
    });
    const marker = owned[0];
    if (marker?.record !== undefined && marker.record !== null) {
      if (
        !sameName(marker.record.snapshot.repository.slug, options.config.repository)
        || !sameName(issue.repository.slug, options.config.repository)
        || marker.record.snapshot.repository.nodeId !== issue.repository.nodeId
        || marker.record.snapshot.issue.number !== issueNumber
        || issue.issue.number !== issueNumber
      ) {
        return {
          generation: marker.record.generation,
          repository: issue.repository.slug,
          issueNumber,
          transitionedAt: marker.record.updatedAt,
          authority: 'ambiguous',
          facts: {
            issue: {
              open: issue.issue.state === 'OPEN',
              optedIn: issue.issue.labels.some((label) =>
                sameName(label, options.config.label)),
            },
            currentBaseOid,
            now: options.now().toISOString(),
          },
        };
      }
      const nextSnapshot = admission.status === 'admitted'
        ? buildRelaySnapshot(admission.input)
        : undefined;
      const nextGeneration = nextSnapshot === undefined
        ? undefined
        : relayGeneration(nextSnapshot);
      if (
        ['ready', 'closed', 'exhausted', 'refused'].includes(
          marker.record.phase,
        )
        && nextSnapshot !== undefined
        && nextGeneration !== marker.record.generation
      ) {
        return {
          generation: nextGeneration!,
          repository: nextSnapshot.repository.slug,
          issueNumber,
          transitionedAt: nextSnapshot.capturedAt,
          authority: 'github',
          facts: {
            issue: { open: true, optedIn: true },
            currentBaseOid,
            now: options.now().toISOString(),
          },
          production: {
            issueCommentId: marker.id,
            issueCommentBody: marker.body,
            admission,
            snapshot: nextSnapshot,
          },
        };
      }
      const currentPr = marker.record.pr === undefined
        ? undefined
        : await options.githubAuthority.readPullRequest(marker.record.pr.number);
      const candidate: RelayReconciliationCandidate = {
        generation: marker.record.generation,
        repository: marker.record.snapshot.repository.slug,
        issueNumber,
        transitionedAt: marker.record.updatedAt,
        authority: 'github',
        facts: {
          durable: marker.record,
          issue: {
            open: issue.issue.state === 'OPEN',
            optedIn: issue.issue.labels.some((label) =>
              sameName(label, options.config.label)),
          },
          currentBaseOid,
          ...(currentPr === undefined ? {} : { currentPr }),
          ...(
            marker.record.phase === 'admitted'
            && (
              admission.status !== 'admitted'
              || nextGeneration !== marker.record.generation
            )
              ? { operatorCancellationRequested: true }
              : {}
          ),
          now: options.now().toISOString(),
        },
        production: {
          issueCommentId: marker.id,
          issueCommentBody: marker.body,
          snapshot: marker.record.snapshot,
        },
      };
      const latest = marker.record.rounds.at(-1);
      if (
        marker.record.phase === 'evaluating'
        && latest?.verdict?.outcome === 'pass'
      ) {
        const readiness = await readReadiness(candidate);
        return {
          ...candidate,
          facts: {
            ...candidate.facts,
            ...(readiness === undefined ? {} : { readiness }),
          },
        };
      }
      return candidate;
    }

    if (admission.status !== 'admitted') return undefined;
    const snapshot = buildRelaySnapshot(admission.input);
    return {
      generation: relayGeneration(snapshot),
      repository: snapshot.repository.slug,
      issueNumber,
      transitionedAt: snapshot.capturedAt,
      authority: 'github',
      facts: {
        issue: { open: true, optedIn: true },
        currentBaseOid,
        now: options.now().toISOString(),
      },
      production: { admission, snapshot },
    };
  };

  const exactCurrent = async (
    candidate: RelayReconciliationCandidate,
  ): Promise<RelayReconciliationCandidate> => {
    const current = await readCandidate(candidate.issueNumber);
    if (current === undefined || current.generation !== candidate.generation) {
      throw new Error('Relay issue authority changed on exact reread');
    }
    return current;
  };

  const replaceMarker = async (
    candidate: RelayReconciliationCandidate,
    record: RelayGenerationRecordV1,
    summary: string,
    nextAction: string,
  ): Promise<void> => {
    const commentId = candidate.production?.issueCommentId;
    const expectedBody = candidate.production?.issueCommentBody;
    if (commentId === undefined || expectedBody === undefined) {
      throw new Error('Relay marker update lacks exact comment authority');
    }
    await options.githubAuthority.editIssueCommentExact({
      issueNumber: candidate.issueNumber,
      commentId,
      expectedBody,
      body: issueStatusBody(record, summary, nextAction),
    });
  };

  const fundingLedger = (): RelaySpendLedger => ({
    activeGenerations: lastScan.flatMap((entry) => {
      const durable = entry.facts.durable;
      return durable === undefined
        || ['ready', 'closed', 'exhausted', 'refused'].includes(durable.phase)
        ? []
        : [{
          generation: durable.generation,
          repository: durable.snapshot.repository.slug,
          authorLogin: durable.snapshot.issue.authorLogin,
          deadlineAt: durable.deadlineAt,
        }];
    }),
    fundedRounds: lastScan.flatMap((entry) =>
      entry.facts.durable?.rounds.flatMap((round) => {
        const evidence = round.task ?? round.fundingIntent;
        return evidence === undefined ? [] : [{
          taskKey: evidence.taskKey,
          generation: entry.generation,
          repository: entry.repository,
          authorLogin: entry.facts.durable!.snapshot.issue.authorLogin,
          round: round.round,
          spendWei: BigInt(evidence.spendWei),
          fundedAt: round.task?.fundedAt
            ?? round.fundingIntent!.preparedAt,
        }];
      }) ?? []),
  });

  const rereadFundingCandidate = async (
    scanned: RelayReconciliationCandidate,
  ): Promise<RelayReconciliationCandidate> => {
    const issue = await options.githubRead.readIssue(scanned.issueNumber);
    const owned = (await options.githubAuthority.listIssueComments(
      scanned.issueNumber,
    ))
      .filter(({ authorLogin }) => sameName(
        authorLogin,
        options.config.relayBotLogin,
      ))
      .map((comment) => ({
        ...comment,
        record: parseRelayIssueCommentMarker(
          comment.body,
          comment.authorLogin,
          options.config.relayBotLogin,
        ),
      }))
      .filter((comment) => comment.record !== null);
    const previous = scanned.facts.durable;
    const expectedSnapshot = previous?.snapshot ?? scanned.production?.snapshot;
    if (
      expectedSnapshot === undefined
      || !sameName(issue.repository.slug, options.config.repository)
      || issue.repository.nodeId !== expectedSnapshot.repository.nodeId
      || issue.issue.number !== scanned.issueNumber
      || expectedSnapshot.issue.number !== scanned.issueNumber
    ) {
      throw new Error('Relay funding ledger live issue authority changed');
    }
    if (owned.length === 0 && previous === undefined) {
      return {
        ...scanned,
        facts: {
          ...scanned.facts,
          issue: {
            open: issue.issue.state === 'OPEN',
            optedIn: issue.issue.labels.some((label) =>
              sameName(label, options.config.label)),
          },
          now: options.now().toISOString(),
        },
      };
    }
    const marker = owned[0];
    if (
      owned.length !== 1
      || marker === undefined
      || marker.record === null
      || marker.record.generation !== scanned.generation
      || (
        scanned.production?.issueCommentId !== undefined
        && marker.id !== scanned.production.issueCommentId
      )
      || !sameName(marker.record.snapshot.repository.slug, options.config.repository)
      || !isDeepStrictEqual(
        marker.record.snapshot.repository,
        expectedSnapshot.repository,
      )
      || marker.record.snapshot.issue.number !== expectedSnapshot.issue.number
      || marker.record.snapshot.issue.number !== scanned.issueNumber
    ) {
      throw new Error('Relay funding ledger marker authority changed');
    }
    const proposedUpdatedAt = Date.parse(marker.record.updatedAt);
    const previousUpdatedAt = previous === undefined
      ? undefined
      : Date.parse(previous.updatedAt);
    const proposedForMonotonicCheck =
      previousUpdatedAt !== undefined
      && proposedUpdatedAt === previousUpdatedAt
        ? {
          ...marker.record,
          updatedAt: new Date(proposedUpdatedAt + 1).toISOString(),
        }
        : marker.record;
    if (
      previous === undefined
        ? !isDeepStrictEqual(
          marker.record.snapshot,
          scanned.production?.snapshot,
        )
        : (
          !isDeepStrictEqual(previous, marker.record)
          && prepareRelayIssueMarkerUpdate({
            current: {
              body: formatRelayIssueMarker(previous),
              authorLogin: options.config.relayBotLogin,
              expectedAuthorLogin: options.config.relayBotLogin,
            },
            proposed: proposedForMonotonicCheck,
          }) === null
        )
    ) {
      throw new Error('Relay funding ledger marker update is not monotonic');
    }
    return {
      ...scanned,
      transitionedAt: marker.record.updatedAt,
      facts: {
        durable: marker.record,
        issue: {
          open: issue.issue.state === 'OPEN',
          optedIn: issue.issue.labels.some((label) =>
            sameName(label, options.config.label)),
        },
        currentBaseOid: scanned.facts.currentBaseOid,
        now: options.now().toISOString(),
      },
      production: {
        issueCommentId: marker.id,
        issueCommentBody: marker.body,
        snapshot: marker.record.snapshot,
      },
    };
  };

  const refreshFundingLedger = async (): Promise<RelaySpendLedger> => {
    const refreshed: RelayReconciliationCandidate[] = [];
    for (const scanned of lastScan) {
      refreshed.push(await rereadFundingCandidate(scanned));
    }
    lastScan = refreshed;
    return fundingLedger();
  };

  const roundDirectory = (
    candidate: RelayReconciliationCandidate,
    record: RelayGenerationRecordV1,
    round: number,
  ): { readonly relative: string; readonly absolute: string } => {
    const relative =
      `rounds/${candidate.issueNumber}/`
      + `${record.snapshot.snapshotDigest.slice('sha256:'.length)}/${round}`;
    return { relative, absolute: join(options.stateDirectory, relative) };
  };

  const prepareRoundRequest = async (input: {
    readonly candidate: RelayReconciliationCandidate;
    readonly record: RelayGenerationRecordV1;
    readonly round: number;
    readonly task: ReturnType<typeof buildRelayTaskSpec>;
    readonly createdAt: string;
    readonly maximumSpendWei: bigint;
  }) => {
    const directory = roundDirectory(
      input.candidate,
      input.record,
      input.round,
    );
    await options.artifacts.installImmutable({
      relativePath: `${directory.relative}/identity`,
      bytes: Buffer.from(`${input.candidate.generation}\n`),
    });
    const request = buildRelayMarketplaceRequest({
      task: input.task,
      solverNet: options.config.solverNet,
      maximumSpendWei: input.maximumSpendWei,
      specPath: join(directory.absolute, 'spec.json'),
      createdAt: input.createdAt,
      submitBy: input.record.deadlineAt,
    });
    const persisted = persistRelayMarketplaceRequest(
      join(directory.absolute, 'request.json'),
      request,
    );
    return {
      task: input.task,
      persisted,
      absoluteDirectory: directory.absolute,
    };
  };

  const requestTask = (
    record: RelayGenerationRecordV1,
    round: number,
  ): ReturnType<typeof buildRelayTaskSpec> => {
    const durableRound = record.rounds[round];
    if (durableRound?.fundingIntent === undefined) {
      throw new Error('Relay round lacks durable funding intent');
    }
    return buildRelayTaskSpec({
      snapshot: record.snapshot,
      round,
      purpose: durableRound.purpose,
      workspaceRepository: durableRound.workspaceRepository,
      inputHead: durableRound.inputHead,
      findings: durableRound.findings ?? [],
      ...(durableRound.prNumber === undefined
        ? {}
        : { prNumber: durableRound.prNumber }),
      ...(durableRound.purpose === 'initial'
        ? {}
        : {
          repairAuthority: {
            managedFork: true,
            workspaceRepository: durableRound.workspaceRepository,
            visibility: 'PUBLIC',
            prNumber: durableRound.prNumber!,
            currentHead: durableRound.inputHead,
          } as const,
        }),
    });
  };

  const recoverSubmission = async (
    candidate: RelayReconciliationCandidate,
    record: RelayGenerationRecordV1,
    roundNumber: number,
  ) => {
    const round = record.rounds[roundNumber];
    const intent = round?.fundingIntent;
    const durableTask = round?.task;
    if (intent === undefined || durableTask === undefined) {
      throw new Error('Relay submission recovery lacks funding intent or task evidence');
    }
    const prepared = await prepareRoundRequest({
      candidate,
      record,
      round: roundNumber,
      task: requestTask(record, roundNumber),
      createdAt: intent.preparedAt,
      maximumSpendWei: BigInt(intent.maximumSpendWei),
    });
    const directory = roundDirectory(candidate, record, roundNumber);
    const requestPath = prepared.persisted.requestPath;
    if (prepared.persisted.requestDigest !== intent.requestDigest) {
      throw new Error('Relay reconstructed request differs from durable funding intent');
    }
    const dryRun = await options.marketplace.dryRun(
      requestPath,
      intent.requestDigest,
    );
    if (
      dryRun.creatorSafe.toLocaleLowerCase('en-US')
        !== intent.creatorSafe.toLocaleLowerCase('en-US')
      || dryRun.solverNetManifestCid !== intent.solverNetManifestCid
      || dryRun.proposedSpendWei.toString() !== intent.spendWei
    ) {
      throw new Error('Relay recovered dry-run differs from durable funding intent');
    }
    const submission = await options.marketplace.submit(
      requestPath,
      intent.requestDigest,
    );
    if (
      submission.id !== durableTask.taskKey
      || submission.taskId !== durableTask.taskId
      || submission.taskCid !== durableTask.taskCid
    ) {
      throw new Error('Relay chain submission differs from durable task evidence');
    }
    return {
      task: prepared.task,
      absoluteDirectory: directory.absolute,
      submission,
    };
  };

  const observeExactSolution = async (
    candidate: RelayReconciliationCandidate,
    record: RelayGenerationRecordV1,
    roundNumber: number,
  ): Promise<
    | { readonly status: 'pending'; readonly detail: string }
    | {
      readonly status: 'verified';
      readonly observation: VerifiedIssueRelaySolutionObservation;
    }
  > => {
    const recovered = await recoverSubmission(candidate, record, roundNumber);
    const expectation = buildRelaySolutionExpectation({
      submission: recovered.submission,
      round: recovered.task.spec.relay,
    });
    const expectationArtifact = persistRelaySolutionExpectation(
      join(recovered.absoluteDirectory, 'solution-expectation.json'),
      expectation,
    );
    const observed = await options.marketplace.observe(
      expectationArtifact.path,
      expectationArtifact.digest,
    );
    if (observed.status === 'pending') {
      return { status: 'pending', detail: observed.reason };
    }
    if (observed.status !== 'verified' || observed.role !== 'solution') {
      throw new Error('Relay marketplace returned contradictory solution evidence');
    }
    const artifact = installVerifiedRelayObservation({
      observationPath: join(
        recovered.absoluteDirectory,
        'solution-observation.json',
      ),
      expectationPath: expectationArtifact.path,
      expectationDigest: expectationArtifact.digest,
      observation: observed,
    });
    const readback = readVerifiedRelayObservation(
      artifact.path,
      artifact.digest,
    );
    if (readback.role !== 'solution') {
      throw new Error('Relay persisted observation is not a solution');
    }
    return { status: 'verified', observation: readback };
  };

  const acceptedAdoption = async (
    record: RelayGenerationRecordV1,
  ): Promise<{
    readonly adoption: AcceptedRelayAdoption;
    readonly receiptBlock: string;
    readonly anchor?: IssueRelayEvaluationAnchorV1;
    readonly anchorBlock?: string;
  }> => {
    const prNumber = record.pr?.number;
    const round = record.rounds.at(-1);
    if (prNumber === undefined || round?.adoption?.disposition !== 'accepted') {
      throw new Error('Relay accepted adoption authority is missing');
    }
    const owned = (await options.githubAuthority.listAssuranceComments(prNumber))
      .filter(({ authorLogin, body }) =>
        sameName(authorLogin, options.config.relayBotLogin)
        && body.includes('<!-- jinn-issue-relay:assurance:v1 -->'));
    if (owned.length !== 1 || owned[0] === undefined) {
      throw new Error('Relay does not own exactly one assurance comment');
    }
    const receipt = parseRelayAdoptionReceiptBlock(owned[0].body);
    if (
      receipt === null
      || receipt.disposition !== 'accepted'
      || receipt.correlation.generation !== record.generation
      || receipt.correlation.round !== round.round
      || receipt.correlation.taskId !== round.task?.taskId
      || receipt.correlation.deliveryEnvelopeCid !== round.solution?.envelopeCid
      || receipt.resultingHead !== round.adoption.resultingHead
      || relayAdoptionReceiptDigest({
        status: 'accepted',
        receipt,
        branch: receipt.headRef,
        resultingHead: receipt.resultingHead,
        prNumber: receipt.prNumber,
      }) !== round.adoption.receiptDigest
    ) {
      throw new Error('Relay assurance receipt contradicts the durable generation');
    }
    const receiptBlock = formatRelayAdoptionReceiptBlock(receipt);
    const anchor = parseRelayEvaluationAnchorBlock(owned[0].body) ?? undefined;
    const anchorBlock = anchor === undefined
      ? undefined
      : formatRelayEvaluationAnchorBlock(anchor);
    return {
      adoption: {
        status: 'accepted',
        receipt,
        branch: receipt.headRef,
        resultingHead: receipt.resultingHead,
        prNumber: receipt.prNumber,
      },
      receiptBlock,
      ...(anchor === undefined ? {} : { anchor }),
      ...(anchorBlock === undefined ? {} : { anchorBlock }),
    };
  };

  const exactChecks = async (
    record: RelayGenerationRecordV1,
    allowReady = false,
    expectedChecksDigest?: string,
  ): Promise<RelayCheckSummary> => {
    return (await readRelayPublicationAuthority({
      config: options.config,
      record,
      githubRead: options.githubRead,
      githubAuthority: options.githubAuthority,
      allowReady,
      ...(expectedChecksDigest === undefined
        ? {}
        : { expectedChecksDigest }),
    })).checks;
  };

  const publicationAuthority = async (
    record: RelayGenerationRecordV1,
    input: {
      readonly allowReady?: boolean;
      readonly expectedChecksDigest?: string;
    } = {},
  ) => readRelayPublicationAuthority({
    config: options.config,
    record,
    githubRead: options.githubRead,
    githubAuthority: options.githubAuthority,
    allowReady: input.allowReady ?? false,
    ...(input.expectedChecksDigest === undefined
      ? {}
      : { expectedChecksDigest: input.expectedChecksDigest }),
  });

  const observeExactVerdict = async (
    candidate: RelayReconciliationCandidate,
    record: RelayGenerationRecordV1,
    roundNumber: number,
    allowReady = false,
  ) => {
    const recovered = await recoverSubmission(candidate, record, roundNumber);
    const solutionExpectation = buildRelaySolutionExpectation({
      submission: recovered.submission,
      round: recovered.task.spec.relay,
    });
    const adoptionEvidence = await acceptedAdoption(record);
    const checks = await exactChecks(
      record,
      allowReady,
      record.rounds[roundNumber]?.checks?.digest,
    );
    const anchor = adoptionEvidence.anchor;
    if (
      anchor === undefined
      || checks.digest !== record.rounds[roundNumber]?.checks?.digest
      || anchor.checksDigest !== checks.digest
    ) {
      throw new Error('Relay verdict observation lacks exact anchor/check authority');
    }
    const expectation = buildRelayVerdictExpectation({
      solutionExpectation,
      adoption: adoptionEvidence.adoption,
      evaluationAnchor: anchor,
      checks,
    });
    const expectationArtifact = persistRelayVerdictExpectation(
      join(recovered.absoluteDirectory, 'verdict-expectation.json'),
      expectation,
    );
    const observed = await options.marketplace.observe(
      expectationArtifact.path,
      expectationArtifact.digest,
    );
    if (observed.status === 'pending') {
      return { status: 'pending' as const, detail: observed.reason };
    }
    if (observed.status !== 'verified' || observed.role !== 'verdict') {
      throw new Error('Relay marketplace returned contradictory verdict evidence');
    }
    const installed = await observeAndInstallRelayVerdict({
      marketplace: options.marketplace,
      expectationPath: expectationArtifact.path,
      observationPath: join(
        recovered.absoluteDirectory,
        'verdict-observation.json',
      ),
      solutionExpectation,
      adoption: adoptionEvidence.adoption,
      evaluationAnchor: anchor,
      checks,
    });
    const observation = readVerifiedRelayObservation(
      installed.observation.path,
      installed.observation.digest,
    );
    if (observation.role !== 'verdict') {
      throw new Error('Relay persisted observation is not a verdict');
    }
    return {
      status: 'verified' as const,
      observation,
      adoptionEvidence,
      checks,
      anchor,
    };
  };

  readReadiness = async (candidate) => {
    const record = candidate.facts.durable;
    const round = record?.rounds.at(-1);
    if (
      record === undefined
      || round?.verdict?.outcome !== 'pass'
      || record.pr === undefined
    ) {
      return undefined;
    }
    const verdict = await observeExactVerdict(
      candidate,
      record,
      round.round,
      true,
    );
    if (verdict.status !== 'verified') return undefined;
    return {
      adoption: verdict.adoptionEvidence.adoption,
      checks: verdict.checks,
      evaluationAnchor: verdict.anchor,
      verdict: verdict.observation,
    };
  };

  return {
    async scan(input) {
      const issueNumbers = new Set<number>();
      if (input.discover) {
        let cursor: string | undefined;
        do {
          const page = await options.githubRead.searchOptedInIssues({
            repository: options.config.repository,
            label: options.config.label,
            ...(cursor === undefined ? {} : { cursor }),
          });
          page.issues.forEach(({ issue }) => issueNumbers.add(issue.number));
          cursor = page.nextCursor;
        } while (cursor !== undefined);
      }
      if (input.recover) {
        (await options.githubAuthority.listIssueNumbersForMarkerRecovery())
          .forEach((number) => issueNumbers.add(number));
      }
      const candidates: RelayReconciliationCandidate[] = [];
      for (const number of [...issueNumbers].sort((left, right) => left - right)) {
        const candidate = await readCandidate(number);
        if (candidate !== undefined) candidates.push(candidate);
      }
      lastScan = candidates;
      return candidates;
    },

    reread: exactCurrent,

    async execute({ candidate, action }) {
      switch (action.kind) {
        case 'publish-snapshot': {
          const snapshot = candidate.production?.snapshot;
          if (
            snapshot === undefined
            || candidate.production?.admission?.status !== 'admitted'
          ) {
            throw new Error('Relay snapshot publication lacks admitted authority');
          }
          const record: RelayGenerationRecordV1 = {
            schemaVersion: 'jinn-issue-relay-generation.v1',
            generation: candidate.generation,
            snapshot,
            phase: 'admitted',
            deadlineAt: deadlineFromSnapshot(
              snapshot,
              options.config.budget.generationDeadlineMs,
            ),
            rounds: [],
            updatedAt: snapshot.capturedAt,
          };
          const body = issueStatusBody(
            record,
            'Admitted from an immutable issue snapshot.',
            'Awaiting marketplace funding preflight.',
          );
          if (
            candidate.production.issueCommentId !== undefined
            && candidate.production.issueCommentBody !== undefined
          ) {
            await options.githubAuthority.editIssueCommentExact({
              issueNumber: candidate.issueNumber,
              commentId: candidate.production.issueCommentId,
              expectedBody: candidate.production.issueCommentBody,
              body,
            });
          } else {
            await options.githubAuthority.createIssueCommentExact({
              issueNumber: candidate.issueNumber,
              body,
            });
          }
          await options.artifacts.installImmutable({
            relativePath:
              `locators/${candidate.issueNumber}/${snapshot.snapshotDigest}.json`,
            bytes: Buffer.from(`${JSON.stringify({
              repository: candidate.repository,
              issueNumber: candidate.issueNumber,
              generation: candidate.generation,
            })}\n`),
          });
          return {
            outcome: 'completed',
            detail: 'Published the first durable snapshot and immutable deadline marker',
          };
        }
        case 'record-cancellation': {
          const record = candidate.facts.durable;
          if (record === undefined) {
            throw new Error('Relay cancellation lacks a durable generation');
          }
          const proposed = persistRelayCancellation(record, {
            requestedAt: options.now().toISOString(),
            reason: action.reason,
          });
          await replaceMarker(
            candidate,
            proposed,
            'Soft cancellation was requested.',
            'Settling only the already-funded current round.',
          );
          return { outcome: 'completed', detail: 'Recorded soft cancellation intent' };
        }
        case 'prepare-round': {
          if (action.round !== 0) {
            const current = await exactCurrent(candidate);
            const record = current.facts.durable;
            const previousRound = action.round - 1;
            if (
              record === undefined
              || record.phase !== 'repair-needed'
              || record.pr === undefined
              || record.rounds.length !== action.round
            ) {
              throw new Error('Relay repair funding lost exact durable authority');
            }
            const verdict = await observeExactVerdict(
              current,
              record,
              previousRound,
            );
            if (verdict.status === 'pending') {
              return { outcome: 'pending', detail: verdict.detail };
            }
            if (verdict.observation.payload.outcome !== 'request-changes') {
              throw new Error('Relay repair requires an authenticated request-changes verdict');
            }
            const pr = await options.githubAuthority.readPullRequest(record.pr.number);
            if (
              pr.head !== record.pr.head
              || pr.branch !== relayBranch(record.generation)
              || !pr.open
              || !pr.draft
            ) {
              throw new Error('Relay repair pull request authority changed');
            }
            const maximumSpendWei =
              options.config.budget.maxGenerationSpendWei
              / BigInt(options.config.budget.maxRoundsPerGeneration);
            if (maximumSpendWei <= 0n) {
              throw new Error('Relay per-round funding bound is zero');
            }
            const task = buildRelayTaskSpec({
              snapshot: record.snapshot,
              round: action.round,
              purpose: 'repair',
              workspaceRepository: options.config.managedForkRepository,
              inputHead: pr.head,
              findings: verdict.observation.payload.findings,
              prNumber: pr.number,
              repairAuthority: {
                managedFork: true,
                workspaceRepository: options.config.managedForkRepository,
                visibility: 'PUBLIC',
                prNumber: pr.number,
                currentHead: pr.head,
              },
            });
            const preparedAt = options.now().toISOString();
            const prepared = await prepareRoundRequest({
              candidate: current,
              record,
              round: action.round,
              task,
              createdAt: preparedAt,
              maximumSpendWei,
            });
            const dryRun = await options.marketplace.dryRun(
              prepared.persisted.requestPath,
              prepared.persisted.requestDigest,
            );
            const budget = admitRelaySpend({
              policy: options.config.budget,
              ledger: await refreshFundingLedger(),
              candidate: {
                generation: record.generation,
                repository: record.snapshot.repository.slug,
                authorLogin: record.snapshot.issue.authorLogin,
                round: action.round,
                proposedSpendWei: dryRun.proposedSpendWei,
              },
              now: options.now(),
            });
            if (budget.status !== 'admitted') {
              return {
                outcome: 'refused',
                detail: `Repair funding intent ${budget.status}`,
              };
            }
            const proposed: RelayGenerationRecordV1 = {
              ...record,
              phase: 'funding',
              rounds: [...record.rounds, {
                round: action.round,
                purpose: 'repair',
                workspaceRepository: options.config.managedForkRepository,
                inputHead: pr.head,
                findings: verdict.observation.payload.findings,
                prNumber: pr.number,
                fundingIntent: {
                  taskKey: task.spec.instance_id,
                  creatorSafe: dryRun.creatorSafe,
                  solverNetManifestCid: dryRun.solverNetManifestCid,
                  requestDigest: prepared.persisted.requestDigest,
                  maximumSpendWei: maximumSpendWei.toString(),
                  spendWei: dryRun.proposedSpendWei.toString(),
                  preparedAt,
                },
              }],
              updatedAt: preparedAt,
            };
            await replaceMarker(
              current,
              proposed,
              `Repair round ${action.round} funding intent is pinned.`,
              'Funding the exact repair task on the next pass.',
            );
            return {
              outcome: 'completed',
              detail: 'Persisted exact repair funding intent',
            };
          }
          const current = await exactCurrent(candidate);
          const record = current.facts.durable;
          if (record === undefined || record.phase !== 'admitted') {
            throw new Error('Relay funding intent lost admitted marker authority');
          }
          const maximumSpendWei =
            options.config.budget.maxGenerationSpendWei
            / BigInt(options.config.budget.maxRoundsPerGeneration);
          if (maximumSpendWei <= 0n) {
            throw new Error('Relay per-round funding bound is zero');
          }
          const preparedAt = options.now().toISOString();
          const task = buildRelayTaskSpec({
            snapshot: record.snapshot,
            round: 0,
            purpose: 'initial',
            workspaceRepository: record.snapshot.repository.slug,
            inputHead: record.snapshot.repository.baseOid,
            findings: [],
          });
          const prepared = await prepareRoundRequest({
            candidate: current,
            record,
            round: 0,
            task,
            createdAt: preparedAt,
            maximumSpendWei,
          });
          const dryRun = await options.marketplace.dryRun(
            prepared.persisted.requestPath,
            prepared.persisted.requestDigest,
          );
          const budget = admitRelaySpend({
            policy: options.config.budget,
            ledger: await refreshFundingLedger(),
            candidate: {
              generation: candidate.generation,
              repository: candidate.repository,
              authorLogin: record.snapshot.issue.authorLogin,
              round: 0,
              proposedSpendWei: dryRun.proposedSpendWei,
            },
            now: options.now(),
          });
          if (budget.status !== 'admitted') {
            return { outcome: 'refused', detail: `Funding intent ${budget.status}` };
          }
          const proposed: RelayGenerationRecordV1 = {
            ...record,
            phase: 'funding',
            rounds: [{
              round: 0,
              purpose: 'initial',
              workspaceRepository: record.snapshot.repository.slug,
              inputHead: record.snapshot.repository.baseOid,
              findings: [],
              fundingIntent: {
                taskKey: prepared.task.spec.instance_id,
                creatorSafe: dryRun.creatorSafe,
                solverNetManifestCid: dryRun.solverNetManifestCid,
                requestDigest: prepared.persisted.requestDigest,
                maximumSpendWei: maximumSpendWei.toString(),
                spendWei: dryRun.proposedSpendWei.toString(),
                preparedAt,
              },
            }],
            updatedAt: preparedAt,
          };
          await replaceMarker(
            current,
            proposed,
            'Marketplace funding intent is pinned before broadcast.',
            'Funding the exact dry-run task on the next pass.',
          );
          return {
            outcome: 'completed',
            detail: 'Persisted exact Safe, SolverNet, request, cap, and spend intent',
          };
        }
        case 'submit-round': {
          const current = await exactCurrent(candidate);
          const record = current.facts.durable;
          const round = record?.rounds[action.round];
          const intent = round?.fundingIntent;
          if (
            record === undefined
            || record.phase !== 'funding'
            || round?.round !== action.round
            || intent === undefined
          ) {
            throw new Error('Relay funding lost exact durable funding intent');
          }
          const prepared = await prepareRoundRequest({
            candidate: current,
            record,
            round: action.round,
            task: requestTask(record, action.round),
            createdAt: intent.preparedAt,
            maximumSpendWei: BigInt(intent.maximumSpendWei),
          });
          if (prepared.persisted.requestDigest !== intent.requestDigest) {
            throw new Error(
              'Relay reconstructed request differs from durable funding intent',
            );
          }
          const directory = roundDirectory(current, record, action.round);
          const requestPath = prepared.persisted.requestPath;
          verifyRelayMarketplaceRequest(requestPath, intent.requestDigest);
          const dryRun = await options.marketplace.dryRun(
            requestPath,
            intent.requestDigest,
          );
          if (
            dryRun.creatorSafe.toLocaleLowerCase('en-US')
              !== intent.creatorSafe.toLocaleLowerCase('en-US')
            || dryRun.solverNetManifestCid !== intent.solverNetManifestCid
            || dryRun.proposedSpendWei.toString() !== intent.spendWei
          ) {
            throw new Error('Relay dry-run facts changed after funding intent');
          }
          const submission = await options.marketplace.submit(
            requestPath,
            intent.requestDigest,
          );
          persistRelaySubmissionEvidence(
            join(directory.absolute, 'submission.json'),
            submission,
          );
          const proposed: RelayGenerationRecordV1 = {
            ...record,
            phase: 'submitted',
            rounds: record.rounds.map((entry) => entry.round === action.round ? {
              ...entry,
              task: {
                taskKey: submission.id,
                taskId: submission.taskId,
                taskCid: submission.taskCid,
                spendWei: intent.spendWei,
                fundedAt: options.now().toISOString(),
              },
            } : entry),
            updatedAt: options.now().toISOString(),
          };
          await replaceMarker(
            current,
            proposed,
            `Marketplace round ${action.round} is funded.`,
            'Waiting for an authenticated solution delivery.',
          );
          return { outcome: 'completed', detail: 'Recovered and marked exact funding evidence' };
        }
        case 'observe-solution': {
          const record = candidate.facts.durable;
          const round = record?.rounds[action.round];
          if (
            record === undefined
            || round?.task === undefined
            || round.solution !== undefined
          ) {
            throw new Error('Relay solution observation lost submitted-round authority');
          }
          const observed = await observeExactSolution(
            candidate,
            record,
            action.round,
          );
          if (observed.status === 'pending') {
            return { outcome: 'pending', detail: observed.detail };
          }
          const timestamp = options.now().toISOString();
          const proposed: RelayGenerationRecordV1 = {
            ...record,
            phase: 'solution-delivered',
            rounds: record.rounds.map((entry) => entry.round === action.round
              ? {
                ...entry,
                solution: {
                  operatorSafe: observed.observation.attempt.operator,
                  envelopeCid: observed.observation.delivery.envelopeCid,
                  observedAt: timestamp,
                },
              }
              : entry),
            updatedAt: timestamp,
          };
          await replaceMarker(
            candidate,
            proposed,
            `Authenticated solution delivery observed for round ${action.round}.`,
            'Validating and adopting the patch into the managed fork.',
          );
          return {
            outcome: 'completed',
            detail: 'Pinned authenticated solution delivery',
          };
        }
        case 'adopt-solution': {
          const record = candidate.facts.durable;
          const round = record?.rounds[action.round];
          if (
            record === undefined
            || round?.task === undefined
            || round.solution === undefined
            || round.adoption !== undefined
          ) {
            throw new Error('Relay adoption lost exact delivered solution authority');
          }
          const observed = await observeExactSolution(
            candidate,
            record,
            action.round,
          );
          if (observed.status === 'pending') {
            return { outcome: 'pending', detail: observed.detail };
          }
          const adoption = await options.adopter.adopt({
            authority: {
              generation: record.generation,
              round: action.round,
              targetRepository: 'Jinn-Network/mono',
              workspaceRepository: round.workspaceRepository,
              inputHead: round.inputHead,
              forkRepository: options.config.managedForkRepository,
              branch: relayBranch(record.generation),
              ...(record.pr === undefined
                ? {}
                : { existingPrNumber: record.pr.number }),
              cancellationRequested: record.cancellation !== undefined,
            },
            observation: observed.observation,
            snapshot: record.snapshot,
          });
          const timestamp = options.now().toISOString();
          if (adoption.status === 'rejected') {
            const proposed: RelayGenerationRecordV1 = {
              ...record,
              phase: 'closed',
              rounds: record.rounds.map((entry) => entry.round === action.round
                ? {
                  ...entry,
                  adoption: {
                    disposition: 'rejected',
                    receiptDigest:
                      `sha256:${createHash('sha256').update(
                        JSON.stringify(adoption.receipt),
                      ).digest('hex')}`,
                    recordedAt: adoption.receipt.recordedAt,
                  },
                }
                : entry),
              updatedAt: timestamp,
            };
            await replaceMarker(
              candidate,
              proposed,
              `Round ${action.round} patch was rejected by host validation.`,
              'No repository mutation was accepted.',
            );
            return { outcome: 'refused', detail: adoption.receipt.reason };
          }
          const pr = await options.githubAuthority.readPullRequest(
            adoption.prNumber,
          );
          if (
            pr.head !== adoption.resultingHead
            || pr.branch !== adoption.branch
            || pr.generation !== record.generation
            || !pr.open
            || !pr.draft
          ) {
            throw new Error('Relay adopted pull request did not read back exactly');
          }
          const proposed: RelayGenerationRecordV1 = {
            ...record,
            phase: 'draft-open',
            pr: {
              number: pr.number,
              branch: pr.branch,
              head: pr.head,
              draft: true,
              targetRepository: record.snapshot.repository.slug,
              targetRepositoryId: pr.targetRepositoryId,
              forkRepository: options.config.managedForkRepository,
              forkRepositoryId: pr.forkRepositoryId,
              forkParentRepositoryId: pr.forkParentRepositoryId,
              visibility: 'PUBLIC',
              managedFork: true,
            },
            rounds: record.rounds.map((entry) => entry.round === action.round
              ? {
                ...entry,
                adoption: {
                  disposition: 'accepted',
                  resultingHead: adoption.resultingHead,
                  prNumber: adoption.prNumber,
                  receiptDigest: relayAdoptionReceiptDigest(adoption),
                  recordedAt: adoption.receipt.adoptedAt,
                },
              }
              : entry),
            updatedAt: timestamp,
          };
          await replaceMarker(
            candidate,
            proposed,
            `Round ${action.round} was adopted into draft pull request #${pr.number}.`,
            'Waiting for exact-head repository checks.',
          );
          return {
            outcome: 'completed',
            detail: 'Adopted the verified patch into the managed draft pull request',
          };
        }
        case 'observe-checks': {
          const record = candidate.facts.durable;
          const round = record?.rounds[action.round];
          if (
            record === undefined
            || record.phase !== 'draft-open'
            || round?.adoption?.disposition !== 'accepted'
          ) {
            throw new Error('Relay check observation lost adopted draft authority');
          }
          const checks = await exactChecks(record);
          const status = relayRequiredCheckStatus(checks);
          const timestamp = options.now().toISOString();
          const proposed: RelayGenerationRecordV1 = {
            ...record,
            rounds: record.rounds.map((entry) => entry.round === action.round
              ? {
                ...entry,
                checks: {
                  head: checks.head,
                  status,
                  digest: checks.digest,
                  observedAt: timestamp,
                },
              }
              : entry),
            updatedAt: timestamp,
          };
          await replaceMarker(
            candidate,
            proposed,
            `Exact-head repository checks are ${status}.`,
            status === 'passed'
              ? 'Publishing the evaluator anchor.'
              : 'Waiting for the exact draft head checks to pass.',
          );
          return {
            outcome: status === 'failed' ? 'refused' : status === 'pending'
              ? 'pending'
              : 'completed',
            detail: `Recorded exact-head checks as ${status}`,
          };
        }
        case 'publish-evaluation-anchor': {
          const record = candidate.facts.durable;
          const round = record?.rounds[action.round];
          if (
            record === undefined
            || record.pr === undefined
            || round?.checks?.status !== 'passed'
          ) {
            throw new Error('Relay evaluation anchor lost passed-check authority');
          }
          const adoptionEvidence = await acceptedAdoption(record);
          const finalAuthority = await publicationAuthority(record, {
            expectedChecksDigest: round.checks.digest,
          });
          if (relayRequiredCheckStatus(finalAuthority.checks) !== 'passed') {
            throw new Error('Relay evaluation anchor checks changed before publication');
          }
          const { checks, pr } = finalAuthority;
          const publisher = createRelayEvaluationAnchorPublisher({
            now: options.now,
            port: {
              readPullRequest: async () =>
                options.githubAuthority.readPullRequest(record.pr!.number),
              listAssuranceComments: async () =>
                options.githubAuthority.listAssuranceComments(record.pr!.number),
              editAssuranceComment: async (input) => {
                const comments =
                  await options.githubAuthority.listAssuranceComments(input.prNumber);
                const existing = comments.find(({ id }) => id === input.commentId);
                if (existing === undefined) {
                  throw new Error('Relay assurance comment disappeared before anchoring');
                }
                await options.githubAuthority.editAssuranceCommentExact({
                  prNumber: input.prNumber,
                  commentId: input.commentId,
                  expectedHead: input.expectedHead,
                  expectedBody: existing.body,
                  body: input.body,
                });
              },
            },
          });
          const anchor = await publisher.publish({
            authority: {
              targetRepositoryId: pr.targetRepositoryId,
              forkRepositoryId: pr.forkRepositoryId,
              forkParentRepositoryId: pr.forkParentRepositoryId,
            },
            targetRepository: record.snapshot.repository.slug,
            targetBase: options.config.targetBase,
            serviceLogin: options.config.relayBotLogin,
            pr,
            currentBaseOid: finalAuthority.currentBaseOid,
            adoption: adoptionEvidence.adoption,
            checks,
          });
          const anchoredAuthority = await publicationAuthority(record, {
            expectedChecksDigest: round.checks.digest,
          });
          if (
            relayRequiredCheckStatus(anchoredAuthority.checks) !== 'passed'
            || anchoredAuthority.pr.head !== anchor.evaluatedHead
            || anchoredAuthority.currentBaseOid !== anchor.baseOid
          ) {
            throw new Error('Relay evaluation anchor authority changed after publication');
          }
          const timestamp = options.now().toISOString();
          const proposed: RelayGenerationRecordV1 = {
            ...record,
            phase: 'evaluating',
            rounds: record.rounds.map((entry) => entry.round === action.round
              ? {
                ...entry,
                evaluation: {
                  head: anchor.evaluatedHead,
                  anchorDigest:
                    `sha256:${createHash('sha256').update(
                      JSON.stringify(anchor),
                    ).digest('hex')}`,
                  anchoredAt: anchor.anchoredAt,
                },
              }
              : entry),
            updatedAt: timestamp,
          };
          await replaceMarker(
            candidate,
            proposed,
            `Independent evaluation is running against ${anchor.evaluatedHead}.`,
            'Waiting for an authenticated evaluator verdict.',
          );
          return {
            outcome: 'completed',
            detail: 'Published an exact-head evaluator anchor',
          };
        }
        case 'observe-verdict': {
          const record = candidate.facts.durable;
          if (record === undefined || record.phase !== 'evaluating') {
            throw new Error('Relay verdict observation lost evaluation authority');
          }
          const verdict = await observeExactVerdict(
            candidate,
            record,
            action.round,
          );
          if (verdict.status === 'pending') {
            return { outcome: 'pending', detail: verdict.detail };
          }
          const timestamp = options.now().toISOString();
          const outcome = verdict.observation.payload.outcome;
          const proposed: RelayGenerationRecordV1 = {
            ...record,
            phase: outcome === 'request-changes'
              ? 'repair-needed'
              : 'evaluating',
            rounds: record.rounds.map((entry) => entry.round === action.round
              ? {
                ...entry,
                verdict: {
                  outcome,
                  evaluatedHead: verdict.observation.payload.evaluatedHead,
                  evaluatorSafe: verdict.observation.attempt.operator,
                  envelopeCid: verdict.observation.delivery.envelopeCid,
                  observedAt: timestamp,
                },
              }
              : entry),
            updatedAt: timestamp,
          };
          await replaceMarker(
            candidate,
            proposed,
            `Independent evaluator verdict: ${outcome}.`,
            outcome === 'pass'
              ? 'Checking exact readiness evidence.'
              : outcome === 'request-changes'
                ? 'Preparing a bounded marketplace repair round.'
                : 'Awaiting explicit human resolution.',
          );
          return {
            outcome: outcome === 'pass' || outcome === 'request-changes'
              ? 'completed'
              : 'pending',
            detail: `Recorded authenticated ${outcome} verdict`,
          };
        }
        case 'mark-ready': {
          const record = candidate.facts.durable;
          const round = record?.rounds.at(-1);
          if (
            record === undefined
            || record.pr === undefined
            || round?.verdict?.outcome !== 'pass'
          ) {
            throw new Error('Relay readiness lost authenticated pass authority');
          }
          const verdict = await observeExactVerdict(
            candidate,
            record,
            round.round,
            true,
          );
          if (verdict.status === 'pending') {
            return { outcome: 'pending', detail: verdict.detail };
          }
          const finalAuthority = await publicationAuthority(record, {
            allowReady: true,
            expectedChecksDigest: round.checks?.digest,
          });
          const draft = finalAuthority.pr;
          if (
            finalAuthority.currentBaseOid !== verdict.anchor.baseOid
            || relayRequiredCheckStatus(finalAuthority.checks) !== 'passed'
            || verdict.checks.digest !== round.checks?.digest
            || finalAuthority.checks.digest !== verdict.checks.digest
            || verdict.observation.delivery.envelopeCid
              !== round.verdict.envelopeCid
          ) {
            throw new Error('Relay readiness evidence changed before publication');
          }
          if (draft.draft) {
            await options.githubWrite.markPullRequestReady({
              prNumber: draft.number,
              expectedHead: draft.head,
            });
          }
          const readyAuthority = await publicationAuthority(record, {
            allowReady: true,
            expectedChecksDigest: round.checks?.digest,
          });
          const readyPr = readyAuthority.pr;
          if (
            !readyPr.open
            || readyPr.draft
            || readyPr.head !== draft.head
            || readyAuthority.currentBaseOid !== finalAuthority.currentBaseOid
            || readyAuthority.checks.digest !== finalAuthority.checks.digest
            || relayRequiredCheckStatus(readyAuthority.checks) !== 'passed'
          ) {
            throw new Error('Relay pull request did not read back ready at the exact head');
          }
          const timestamp = options.now().toISOString();
          const proposed: RelayGenerationRecordV1 = {
            ...record,
            phase: 'ready',
            pr: { ...record.pr, draft: false },
            updatedAt: timestamp,
          };
          const report = createRelayReportPublisher({
            port: {
              listIssueComments: async ({ issueNumber }) =>
                options.githubAuthority.listIssueComments(issueNumber),
              editIssueComment: async (input) => {
                await options.githubAuthority.editIssueCommentExact(input);
              },
              listAssuranceComments: async ({ prNumber }) =>
                options.githubAuthority.listAssuranceComments(prNumber),
              editAssuranceComment: async (input) => {
                await options.githubAuthority.editAssuranceCommentExact(input);
              },
            },
          });
          await report.publishAssurance({
            repository: proposed.snapshot.repository.slug,
            prNumber: readyPr.number,
            expectedHead: readyPr.head,
            serviceLogin: options.config.relayBotLogin,
            model: {
              status: 'READY FOR HUMAN REVIEW',
              head: readyPr.head,
              solutionOperator:
                verdict.adoptionEvidence.adoption.receipt.solutionSafe,
              evaluator: verdict.observation.attempt.operator,
              checks: verdict.checks.required,
              rounds: canonicalRelayTimeline(proposed),
              limitations: [],
              technicalEvidence: [],
              readyEvidence: {
                record: proposed,
                currentHead: readyPr.head,
                currentBaseOid: readyAuthority.currentBaseOid,
                targetBase: options.config.targetBase,
                currentPr: {
                  ...readyPr,
                  targetRepository: proposed.snapshot.repository.slug,
                  forkRepository: options.config.managedForkRepository,
                  visibility: 'PUBLIC',
                  managedFork: true,
                  draft: false,
                },
                draft: { ...draft, draft: true },
                adoption: verdict.adoptionEvidence.adoption,
                checks: verdict.checks,
                evaluationAnchor: verdict.anchor,
                verdict: verdict.observation,
                adoptionReceiptBlock:
                  verdict.adoptionEvidence.receiptBlock,
                evaluationAnchorBlock:
                  verdict.adoptionEvidence.anchorBlock
                  ?? formatRelayEvaluationAnchorBlock(verdict.anchor),
              },
            },
          });
          await replaceMarker(
            candidate,
            proposed,
            'Independently evaluated work is ready for maintainer review.',
            'Human maintainer review.',
          );
          return {
            outcome: 'completed',
            detail: 'Marked the exact evaluated pull request ready for human review',
          };
        }
        case 'finish-cancellation':
        case 'close-exhausted': {
          const record = candidate.facts.durable;
          if (record === undefined) {
            throw new Error('Relay terminal transition lacks durable authority');
          }
          if (record.pr !== undefined) {
            const pr = await options.githubAuthority.readPullRequest(record.pr.number);
            if (pr.open) {
              await options.githubWrite.closePullRequest({
                prNumber: pr.number,
                expectedHead: pr.head,
                reason: action.kind === 'finish-cancellation'
                  ? 'Jinn Issue Relay generation cancelled'
                  : 'Jinn Issue Relay budget or deadline exhausted',
              });
            }
          }
          const terminal = action.kind === 'finish-cancellation'
            ? 'closed'
            : 'exhausted';
          const proposed: RelayGenerationRecordV1 = {
            ...record,
            phase: terminal,
            updatedAt: options.now().toISOString(),
          };
          await replaceMarker(
            candidate,
            proposed,
            terminal === 'closed'
              ? 'Relay work was cancelled.'
              : 'Relay budget, rounds, or deadline were exhausted.',
            'No further marketplace work will be funded.',
          );
          return {
            outcome: 'completed',
            detail: `Recorded terminal ${terminal} state`,
          };
        }
        case 'submit-repair':
          throw new Error(
            'Repair submission must pass through a durable prepare-round funding intent',
          );
        default: {
          const exhaustive: never = action;
          throw new Error(`Unsupported Relay action ${JSON.stringify(exhaustive)}`);
        }
      }
    },
  };
}

function sameName(left: string, right: string): boolean {
  return left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US');
}

export async function preflightIssueRelayProduction(
  options: IssueRelayProductionPreflightOptions,
): Promise<IssueRelayPreflightEvidence> {
  createRelayDurableArtifactStore(options.stateDirectory);
  const github = await options.github();
  if (
    !sameName(github.authenticatedLogin, options.config.relayBotLogin)
    || github.targetRepository !== options.config.repository
    || github.targetVisibility !== 'PUBLIC'
    || github.targetBase !== options.config.targetBase
    || github.label !== options.config.label
    || github.targetRepositoryId.length === 0
    || github.forkRepository !== options.config.managedForkRepository
    || !sameName(github.forkOwner, options.config.relayBotLogin)
    || github.forkRepositoryId.length === 0
    || github.forkParentRepositoryId !== github.targetRepositoryId
    || github.forkVisibility !== 'PUBLIC'
  ) {
    throw new Error('Issue Relay production preflight rejected GitHub authority');
  }

  const jinnBinary = await options.resolveJinnBinary();
  if (!isAbsolute(jinnBinary)) {
    throw new Error('Issue Relay production preflight requires an installed Jinn binary');
  }
  const marketplace = await options.marketplaceDryRun({
    solverNet: options.config.solverNet,
    jinnBinary,
    maximumSpendWei: options.config.budget.maxGenerationSpendWei,
  });
  if (
    !SAFE_ADDRESS.test(marketplace.creatorSafe)
    || marketplace.solverNet !== options.config.solverNet
    || marketplace.escrowReady !== true
    || marketplace.proposedSpendWei <= 0n
    || marketplace.proposedSpendWei
      > options.config.budget.maxGenerationSpendWei
  ) {
    throw new Error('Issue Relay production preflight rejected marketplace funding');
  }
  if (
    await options.verificationRuntime(options.config.verificationProfile)
    !== true
  ) {
    throw new Error('Issue Relay production preflight rejected PR #68 verification runtime');
  }
  return {
    jinnBinary,
    creatorSafe: marketplace.creatorSafe,
    targetRepositoryId: github.targetRepositoryId,
    forkRepositoryId: github.forkRepositoryId,
  };
}

export async function runIssueRelayRuntime(options: {
  readonly mode: 'observe' | 'recover' | 'active';
  readonly once: boolean;
  readonly pollSeconds: number;
  readonly acquireWriterLease?: () => IssueRelayRuntimeLease;
  readonly preflight: () => Promise<void>;
  readonly cycle: () => Promise<RelayCycleReport>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly signal?: AbortSignal;
}): Promise<readonly RelayCycleReport[]> {
  if (
    !Number.isSafeInteger(options.pollSeconds)
    || options.pollSeconds <= 0
  ) {
    throw new Error('Issue Relay polling cadence must be a positive integer');
  }
  const lease = options.mode === 'observe'
    ? undefined
    : options.acquireWriterLease?.();
  try {
    await options.preflight();
    const reports: RelayCycleReport[] = [];
    const sleep = options.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
    do {
      reports.push(await options.cycle());
      if (options.once || Boolean(options.signal?.aborted)) break;
      await sleep(options.pollSeconds * 1_000);
    } while (!Boolean(options.signal?.aborted));
    return reports;
  } finally {
    lease?.release();
  }
}

const execFileAsync = promisify(execFile);

function relayGitEnvironment(
  token: string,
  ambient: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const authorization = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    PATH: ambient.PATH,
    HOME: ambient.HOME,
    TMPDIR: ambient.TMPDIR,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
    GIT_AUTHOR_NAME: 'Jinn Issue Relay',
    GIT_AUTHOR_EMAIL: 'issue-relay@jinn.network',
    GIT_COMMITTER_NAME: 'Jinn Issue Relay',
    GIT_COMMITTER_EMAIL: 'issue-relay@jinn.network',
  };
}

async function runGitText(input: {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<string> {
  const result = await execFileAsync('git', [...input.args], {
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    env: input.environment,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  });
  return result.stdout.trimEnd();
}

function relayRepositoryUrl(repository: string): string {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('Relay repository slug is malformed');
  }
  return `https://github.com/${repository}.git`;
}

function createRelayProductionGitAndWorktrees(input: {
  readonly config: IssueRelayConfig;
  readonly token: string;
  readonly stateDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly artifacts: RelayDurableArtifactStore;
}): {
  readonly git: RelayGitCommandRunner;
  readonly worktrees: Parameters<typeof makeRelayAdoptionCoordinator>[0]['worktrees'];
  readonly worktreeLocation: (
    generation: string,
    round: number,
  ) => { readonly manifestPath: string; readonly path: string };
  readonly readForkHead: (branch: string) => Promise<string | undefined>;
} {
  const environment = relayGitEnvironment(input.token, input.environment);
  const branchWorktrees = new Map<string, string>();
  const worktreeLocation = (generation: string, round: number) => {
    if (
      !/^[A-Za-z0-9:._-]+$/.test(generation)
      || !Number.isSafeInteger(round)
      || round < 0
    ) {
      throw new Error('Relay worktree identity is malformed');
    }
    const root = join(
      input.stateDirectory,
      'worktrees',
      createHash('sha256').update(generation).digest('hex'),
      String(round),
    );
    return { path: join(root, 'repository'), manifestPath: join(root, 'manifest.json') };
  };
  const readForkHead = async (branch: string): Promise<string | undefined> => {
    const output = await runGitText({
      args: [
        'ls-remote',
        relayRepositoryUrl(input.config.managedForkRepository),
        `refs/heads/${branch}`,
      ],
      environment,
    });
    if (output.length === 0) return undefined;
    const lines = output.split('\n');
    if (lines.length !== 1) {
      throw new Error('Relay managed-fork branch is ambiguous');
    }
    const [head, ref, extra] = lines[0]!.split('\t');
    if (
      head === undefined
      || !/^[0-9a-f]{40}$/.test(head)
      || ref !== `refs/heads/${branch}`
      || extra !== undefined
    ) {
      throw new Error('Relay managed-fork branch readback is malformed');
    }
    return head;
  };

  const worktrees: Parameters<typeof makeRelayAdoptionCoordinator>[0]['worktrees'] = {
    async prepareExact(authority) {
      const location = worktreeLocation(authority.generation, authority.round);
      if (
        location.path !== authority.worktreePath
        || location.manifestPath !== authority.manifestPath
      ) {
        throw new Error('Relay worktree path differs from exact authority');
      }
      const relativeRoot = location.manifestPath
        .slice(`${input.stateDirectory}/`.length)
        .split('/')
        .slice(0, -1)
        .join('/');
      await input.artifacts.installImmutable({
        relativePath: `${relativeRoot}/identity`,
        bytes: Buffer.from(
          `${authority.generation}\n${authority.round}\n`,
        ),
      });
      assertOwnerOnlyDirectory(dirname(location.path), 'Relay worktree directory');
      if (existsSync(location.path)) {
        const metadata = lstatSync(location.path);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw new Error('Relay worktree path is not a real directory');
        }
      }
      if (!existsSync(join(location.path, '.git'))) {
        await runGitText({
          args: [
            'clone',
            '--filter=blob:none',
            '--no-checkout',
            relayRepositoryUrl(authority.workspaceRepository),
            location.path,
          ],
          environment,
        });
      }
      await runGitText({
        args: [
          'fetch',
          '--force',
          'origin',
          authority.expectedHead,
        ],
        cwd: location.path,
        environment,
      });
      await runGitText({
        args: ['checkout', '--detach', '--force', authority.expectedHead],
        cwd: location.path,
        environment,
      });
      await runGitText({
        args: ['reset', '--hard', authority.expectedHead],
        cwd: location.path,
        environment,
      });
      await runGitText({
        args: ['clean', '-ffd'],
        cwd: location.path,
        environment,
      });
      const head = await runGitText({
        args: ['rev-parse', 'HEAD'],
        cwd: location.path,
        environment,
      });
      const status = await runGitText({
        args: ['status', '--porcelain=v1', '--untracked-files=all'],
        cwd: location.path,
        environment,
      });
      if (head !== authority.expectedHead || status.length !== 0) {
        throw new Error('Relay worktree did not read back exact and clean');
      }
      await input.artifacts.installImmutable({
        relativePath: location.manifestPath.slice(
          `${input.stateDirectory}/`.length,
        ),
        bytes: Buffer.from(`${JSON.stringify({
          schemaVersion: 1,
          generation: authority.generation,
          round: authority.round,
          repository: authority.workspaceRepository,
          expectedHead: authority.expectedHead,
          path: location.path,
        })}\n`),
      });
      branchWorktrees.set(relayBranch(authority.generation), location.path);
      return {
        manifestPath: location.manifestPath,
        path: location.path,
        expectedHead: authority.expectedHead,
      };
    },
  };

  const git: RelayGitCommandRunner = async (
    command: RelayGitCommand,
  ): Promise<RelayGitCommandResult> => {
    const worktreeForBranch = (branch: string): string => {
      const path = branchWorktrees.get(branch);
      if (path === undefined) {
        throw new Error('Relay Git command lacks a prepared exact worktree');
      }
      return path;
    };
    switch (command.kind) {
      case 'read-applied-tree': {
        const head = await runGitText({
          args: ['rev-parse', 'HEAD'],
          cwd: command.worktreePath,
          environment,
        });
        await runGitText({
          args: ['add', '--all'],
          cwd: command.worktreePath,
          environment,
        });
        const tree = await runGitText({
          args: ['write-tree'],
          cwd: command.worktreePath,
          environment,
        });
        return {
          kind: 'applied-tree',
          head,
          tree,
          exact: head === command.inputHead && /^[0-9a-f]{40}$/.test(tree),
        };
      }
      case 'read-local-head':
        return {
          kind: 'local-head',
          head: await runGitText({
            args: ['rev-parse', 'HEAD'],
            cwd: command.worktreePath,
            environment,
          }),
        };
      case 'create-commit': {
        const current = await runGitText({
          args: ['rev-parse', 'HEAD'],
          cwd: command.worktreePath,
          environment,
        });
        const tree = await runGitText({
          args: ['write-tree'],
          cwd: command.worktreePath,
          environment,
        });
        if (current !== command.expectedHead || tree !== command.expectedTree) {
          throw new Error('Relay commit creation lost exact head/tree authority');
        }
        const commit = await runGitText({
          args: [
            'commit-tree',
            command.expectedTree,
            '-p',
            command.expectedHead,
            '-m',
            command.message,
          ],
          cwd: command.worktreePath,
          environment,
        });
        await runGitText({
          args: ['update-ref', 'HEAD', commit, command.expectedHead],
          cwd: command.worktreePath,
          environment,
        });
        return { kind: 'mutated' };
      }
      case 'read-commit':
      case 'read-fork-commit': {
        const cwd = command.kind === 'read-commit'
          ? command.worktreePath
          : worktreeForBranch(command.branch);
        if (command.kind === 'read-fork-commit') {
          await runGitText({
            args: [
              'fetch',
              '--force',
              relayRepositoryUrl(command.repository),
              command.head,
            ],
            cwd,
            environment,
          });
        }
        const head = await runGitText({
          args: ['rev-parse', `${command.head}^{commit}`],
          cwd,
          environment,
        });
        const tree = await runGitText({
          args: ['rev-parse', `${command.head}^{tree}`],
          cwd,
          environment,
        });
        const parents = (await runGitText({
          args: ['show', '-s', '--format=%P', command.head],
          cwd,
          environment,
        })).split(' ').filter(Boolean);
        const message = await runGitText({
          args: ['show', '-s', '--format=%B', command.head],
          cwd,
          environment,
        });
        return { kind: 'commit', head, tree, parents, message };
      }
      case 'read-fork-ref':
        return { kind: 'fork-ref', head: await readForkHead(command.branch) };
      case 'push-fork': {
        const cwd = worktreeForBranch(command.branch);
        await runGitText({
          args: [
            'push',
            `--force-with-lease=refs/heads/${command.branch}:`
              + (command.expectedOldHead ?? '0000000000000000000000000000000000000000'),
            relayRepositoryUrl(command.repository),
            `${command.newHead}:refs/heads/${command.branch}`,
          ],
          cwd,
          environment,
        });
        return { kind: 'mutated' };
      }
      default: {
        const exhaustive: never = command;
        throw new Error(`Unsupported Relay Git command ${JSON.stringify(exhaustive)}`);
      }
    }
  };
  return { git, worktrees, worktreeLocation, readForkHead };
}

export interface IssueRelayProductionEnvironmentDependencies {
  readonly readConfig: (path: string) => unknown;
  readonly resolveJinnBinary: () => string;
}

const productionEnvironmentDependencies: IssueRelayProductionEnvironmentDependencies = {
  readConfig: (path) => JSON.parse(readFileSync(path, 'utf8')) as unknown,
  resolveJinnBinary: () => resolveInstalledJinnBinary(),
};

export async function runIssueRelayProductionFromEnvironment(options: {
  readonly mode: 'observe' | 'recover' | 'active';
  readonly once: boolean;
  readonly environment: NodeJS.ProcessEnv;
}, dependencies: IssueRelayProductionEnvironmentDependencies =
productionEnvironmentDependencies): Promise<void> {
  const configPath = options.environment.JINN_ISSUE_RELAY_CONFIG;
  const token = options.environment.JINN_ISSUE_RELAY_GITHUB_TOKEN;
  const stateDirectory =
    options.environment.JINN_ISSUE_RELAY_STATE_DIRECTORY;
  if (
    configPath === undefined
    || !isAbsolute(configPath)
    || token === undefined
    || token.length === 0
    || stateDirectory === undefined
    || !isAbsolute(stateDirectory)
  ) {
    throw new Error(
      'Issue Relay requires absolute config/state paths and a GitHub token',
    );
  }
  const config = parseIssueRelayConfig(dependencies.readConfig(configPath));
  const now = () => new Date();
  const artifacts = options.mode === 'observe'
    ? createRelayReadOnlyArtifactStore(stateDirectory)
    : createRelayDurableArtifactStore(stateDirectory, { deferCreation: true });
  const github = createRelayGitHubProductionPorts({ config, token });
  const jinnBinary = dependencies.resolveJinnBinary();
  const marketplace = new IssueRelayMarketplaceCli({
    jinnBinary,
    environment: options.environment,
    now,
  });
  const gitComposition = createRelayProductionGitAndWorktrees({
    config,
    token,
    stateDirectory,
    environment: options.environment,
    artifacts,
  });
  const docker = createMarketplaceVerificationDockerSandbox();
  const verification = createProductionMarketplaceVerificationPort({
    dockerRunner: docker.dockerRunner,
    dockerInspector: docker.dockerInspector,
    cleanup: docker.cleanup,
    workspacePath: join(stateDirectory, 'verification-workspace'),
    ambientEnvironment: options.environment,
    now,
    prepareWorkspace: prepareRelayVerificationWorkspace,
  });
  const publisher = createRelayGitPublisher({
    git: gitComposition.git,
    github: github.publisher,
  });
  let preflightEvidence: IssueRelayPreflightEvidence | undefined;
  const adopter = makeRelayAdoptionCoordinator({
    authority: {
      async readExact({ authority, observation, snapshot }) {
        const evidence = preflightEvidence;
        if (evidence === undefined) {
          throw new Error('Relay adoption requires completed production preflight');
        }
        const location = gitComposition.worktreeLocation(
          authority.generation,
          authority.round,
        );
        const pr = authority.existingPrNumber === undefined
          ? undefined
          : await github.authority.readPullRequest(authority.existingPrNumber);
        return {
          generation: authority.generation,
          round: authority.round,
          snapshotDigest: snapshot.snapshotDigest,
          targetRepository: authority.targetRepository,
          workspaceRepository: authority.workspaceRepository,
          inputHead: authority.inputHead,
          forkRepository: authority.forkRepository,
          branch: authority.branch,
          taskId: observation.task.taskId,
          solutionOperator: observation.attempt.operator,
          issueNumber: snapshot.issue.number,
          defaultBranch: snapshot.repository.defaultBranch,
          targetRepositoryId: evidence.targetRepositoryId,
          forkRepositoryId: evidence.forkRepositoryId,
          forkParentRepositoryId: evidence.targetRepositoryId,
          expectedForkHead: await gitComposition.readForkHead(authority.branch),
          cancellationRequested: authority.cancellationRequested,
          serviceLogin: config.relayBotLogin,
          adoptionDeadline: new Date(
            Date.parse(snapshot.capturedAt)
              + config.budget.generationDeadlineMs,
          ).toISOString(),
          worktree: location,
          ...(pr === undefined ? {} : { pr }),
        };
      },
    },
    worktrees: gitComposition.worktrees,
    applyPatch: (patchInput) => applyMarketplacePatchToWorktree(patchInput, {
      runGit: runMarketplacePatchGit,
      worktreeProof: {
        async prove(proofInput) {
          const manifest = JSON.parse(
            readFileSync(proofInput.manifestPath, 'utf8'),
          ) as {
            readonly path: string;
            readonly expectedHead: string;
          };
          const environment = relayGitEnvironment(token, options.environment);
          const head = await runGitText({
            args: ['rev-parse', 'HEAD'],
            cwd: proofInput.worktreePath,
            environment,
          });
          const status = await runGitText({
            args: ['status', '--porcelain=v1', '--untracked-files=all'],
            cwd: proofInput.worktreePath,
            environment,
          });
          return {
            manifestPath: proofInput.manifestPath,
            registeredWorktreePath: manifest.path,
            expectedHead: proofInput.expectedHead,
            currentHead: gitOid(head),
            indexClean: true,
            worktreeClean: true,
            untrackedPaths: [],
            ...(status.length === 0 && manifest.expectedHead === proofInput.expectedHead
              ? {}
              : (() => {
                throw new Error('Relay worktree proof is not exact and clean');
              })()),
          };
        },
      },
    }),
    verification,
    publisher,
    now,
  });
  const reconciliation = createIssueRelayProductionReconciliation({
    config,
    stateDirectory,
    githubRead: github.read,
    githubWrite: github.write,
    githubAuthority: github.authority,
    marketplace,
    adopter,
    artifacts,
    now,
  });
  await runIssueRelayRuntime({
    mode: options.mode,
    once: options.once,
    pollSeconds: config.pollSeconds,
    ...(options.mode === 'observe'
      ? {}
      : {
        acquireWriterLease: () =>
          acquireIssueRelayRuntimeLease(stateDirectory),
      }),
    preflight: async () => {
      if (options.mode === 'observe') {
        const observed = await github.preflight();
        if (
          !sameName(observed.authenticatedLogin, config.relayBotLogin)
          || observed.targetRepository !== config.repository
          || observed.targetVisibility !== 'PUBLIC'
          || observed.targetBase !== config.targetBase
          || observed.label !== config.label
          || observed.targetRepositoryId.length === 0
          || observed.forkRepository !== config.managedForkRepository
          || !sameName(observed.forkOwner, config.relayBotLogin)
          || observed.forkRepositoryId.length === 0
          || observed.forkParentRepositoryId !== observed.targetRepositoryId
          || observed.forkVisibility !== 'PUBLIC'
          || !isAbsolute(jinnBinary)
        ) {
          throw new Error('Issue Relay observe preflight rejected authority');
        }
        return;
      }
      preflightEvidence = await preflightIssueRelayProduction({
        config,
        stateDirectory,
        github: github.preflight,
        resolveJinnBinary: async () => jinnBinary,
        marketplaceDryRun: async ({ solverNet, maximumSpendWei }) => {
          const githubFacts = await github.preflight();
          const baseOid = await github.read.readDefaultBranchHead();
          const capturedAt = now().toISOString();
          const snapshot = buildRelaySnapshot({
            repository: {
              slug: config.repository,
              nodeId: githubFacts.targetRepositoryId,
              visibility: 'PUBLIC',
              defaultBranch: config.targetBase,
              baseOid,
            },
            issue: {
              number: 1,
              url: 'https://github.com/Jinn-Network/mono/issues/1',
              title: 'Issue Relay production preflight',
              body: '- [ ] Production dry-run succeeds.',
              authorLogin: config.relayBotLogin,
              authorId: 'relay-preflight',
              updatedAt: capturedAt,
            },
            optIn: {
              label: config.label,
              actorLogin: config.relayBotLogin,
              createdAt: capturedAt,
              permission: 'ADMIN',
            },
            language: 'typescript',
            verificationProfile: config.verificationProfile,
            acceptanceEvidence: ['Production dry-run succeeds.'],
            admissionPolicyVersion: 'jinn-issue-relay-admission.v1',
            capturedAt,
          });
          const task = buildRelayTaskSpec({
            snapshot,
            round: 0,
            purpose: 'initial',
            workspaceRepository: config.repository,
            inputHead: baseOid,
            findings: [],
          });
          const directory = await mkdtemp(
            join(tmpdir(), 'jinn-issue-relay-preflight-'),
          );
          chmodSync(directory, 0o700);
          try {
            const request = persistRelayMarketplaceRequest(
              join(directory, 'request.json'),
              buildRelayMarketplaceRequest({
                task,
                solverNet,
                maximumSpendWei,
                specPath: join(directory, 'spec.json'),
                createdAt: capturedAt,
                submitBy: new Date(
                  Date.parse(capturedAt) + 10 * 60_000,
                ).toISOString(),
              }),
            );
            const dryRun = await marketplace.dryRun(
              request.requestPath,
              request.requestDigest,
            );
            return {
              creatorSafe: dryRun.creatorSafe,
              solverNet,
              escrowReady: true,
              proposedSpendWei: dryRun.proposedSpendWei,
            };
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        },
        verificationRuntime: async () => (await verification.preflight()).ok,
      });
    },
    cycle: () => runIssueRelayCycle({
      mode: options.mode,
      config,
      githubRead: github.read,
      githubWrite: github.write,
      marketplace,
      adopter,
      artifacts,
      now,
      reconciliation,
    }),
  });
}
