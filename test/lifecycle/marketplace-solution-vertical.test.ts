import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeAttemptManifest,
  readAttemptManifest,
  type AttemptManifest,
  type MarketplaceExecutionState,
} from '../../src/lifecycle/attempt-workspace.js';
import {
  marketplaceStatus,
  transitionMarketplaceAdoption,
} from '../../src/lifecycle/marketplace-adoption-state.js';
import type { AdoptionReceiptComment, AdoptionReceiptPorts } from '../../src/lifecycle/marketplace-adoption-receipt.js';
import type {
  MarketplaceReviewAnchorEvidence,
  MarketplaceSolutionDeliveryEvidence,
} from '../../src/lifecycle/marketplace-execution-state.js';
import {
  makeMarketplaceMutationAdoptionCoordinator,
  MarketplaceAdoptionCrashInjectionError,
  type MarketplaceMutationAdoptionBoundary,
  type MarketplaceMutationAuthority,
  type MarketplaceMutationAuthorityPort,
} from '../../src/lifecycle/marketplace-mutation-adoption.js';
import { createMarketplaceMutationGitPort } from '../../src/lifecycle/marketplace-mutation-git.js';
import {
  buildJinnMonoV1VerificationPlan,
  marketplaceVerificationPlanDigest,
  type MarketplaceMutationVerificationPort,
} from '../../src/lifecycle/marketplace-mutation-verification.js';
import {
  applyMarketplacePatchToWorktree,
  runMarketplacePatchGit,
  validateMarketplacePatch,
} from '../../src/lifecycle/marketplace-patch.js';
import type { MarketplaceReviewAnchorPort } from '../../src/lifecycle/marketplace-review-anchor.js';
import {
  buildMarketplaceTaskRequest,
  persistMarketplaceTaskRequest,
} from '../../src/lifecycle/marketplace-task.js';
import type { ImplementationSessionProtocol } from '../../src/lifecycle/implementation-session.js';
import { recoverSubmittedMarketplaceAttempts } from '../../src/lifecycle/session-execution-backend.js';
import { gitOid, type BranchClaim, type GitOid } from '../../src/lifecycle/types.js';
import {
  ATTEMPT_ID,
  PATCH,
  PATCH_PATH,
  REVIEW_ATTEMPT,
  branchClaimFor,
  deliveryEvidence,
  observationForHeads,
  reviewAnchorEvidence,
  Harness,
} from './marketplace-mutation-adoption.test.js';

const ALL_BOUNDARIES: readonly MarketplaceMutationAdoptionBoundary[] = [
  'observation-persisted',
  'patch-applied',
  'verification-persisted',
  'host-commit-created',
  'checkpoint-published',
  'completion-confirmed',
  'review-anchor-published',
  'receipt-comment-created',
  'receipt-persisted',
];

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[], when = '2026-07-26T12:00:00.000Z'): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_DATE: when,
    },
  }).trim();
}

function initGitWorktree(worktreePath: string): { claimOid: GitOid; expectedHead: GitOid } {
  git(worktreePath, ['init']);
  git(worktreePath, ['config', 'user.email', 'vertical@example.test']);
  git(worktreePath, ['config', 'user.name', 'Vertical Test']);
  git(worktreePath, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(worktreePath, 'packages/autopilot/src'), { recursive: true });
  writeFileSync(join(worktreePath, 'README.md'), 'base\n');
  git(worktreePath, ['add', '-A']);
  git(worktreePath, ['commit', '-m', 'claim']);
  const claimOid = gitOid(git(worktreePath, ['rev-parse', 'HEAD']));
  writeFileSync(join(worktreePath, PATCH_PATH), 'old\n');
  git(worktreePath, ['add', PATCH_PATH]);
  git(worktreePath, ['commit', '-m', 'expected']);
  const expectedHead = gitOid(git(worktreePath, ['rev-parse', 'HEAD']));
  return { claimOid, expectedHead };
}

function relocateMarketplaceExecutionState(
  state: MarketplaceExecutionState,
  linkedDir: string,
): MarketplaceExecutionState {
  if (state.schemaVersion !== 'marketplace-execution-v3') return state;
  const requestPath = join(linkedDir, 'marketplace-request.json');
  const solverNetSelectionPath = join(linkedDir, 'solvernet-selection.json');
  const relocatedBase = { ...state, requestPath, solverNetSelectionPath };
  if ('progress' in relocatedBase) {
    const progress = relocatedBase.progress;
    return {
      ...relocatedBase,
      progress: {
        ...progress,
        delivery: {
          ...progress.delivery,
          observationPath: join(linkedDir, 'marketplace-solution-observation.json'),
        },
        ...('reviewAnchor' in progress
          ? {
            reviewAnchor: {
              ...progress.reviewAnchor,
              manifestPath: join(
                linkedDir,
                '..',
                '..',
                'review',
                `pr-2101-${REVIEW_ATTEMPT}`,
                'manifest.json',
              ),
            },
          }
          : {}),
      },
    };
  }
  if ('delivery' in relocatedBase) {
    return {
      ...relocatedBase,
      delivery: {
        ...relocatedBase.delivery,
        observationPath: join(linkedDir, 'marketplace-solution-observation.json'),
      },
    };
  }
  return relocatedBase;
}

function installAtV2(
  harness: RealGitVerticalHarness,
  runnerId = 'runner-1',
): string {
  const linkedDir = join(
    harness.v2Base,
    runnerId,
    'implement',
    `issue-2001-${ATTEMPT_ID}`,
  );
  mkdirSync(linkedDir, { recursive: true });
  cpSync(harness.attemptDir, linkedDir, { recursive: true });
  const manifestPath = join(linkedDir, 'manifest.json');
  const observationPath = join(linkedDir, 'marketplace-solution-observation.json');
  const obs = observationForHeads(harness.claimOid, harness.expectedHead);
  writeFileSync(observationPath, `${JSON.stringify(obs, null, 2)}\n`, { mode: 0o600 });
  harness.delivery = deliveryEvidence(linkedDir, obs);
  const source = readAttemptManifest(harness.manifestPath);
  const state = source.execution.backend === 'marketplace'
    ? source.execution.state
    : (() => { throw new Error('expected marketplace execution'); })();
  const relocatedState = relocateMarketplaceExecutionState(state, linkedDir);
  const nextState = {
    ...relocatedState,
    ...('delivery' in relocatedState ? { delivery: harness.delivery } : {}),
    ...('progress' in relocatedState && 'delivery' in relocatedState.progress
      ? { progress: { ...relocatedState.progress, delivery: harness.delivery } }
      : {}),
  };
  writeFileSync(manifestPath, `${JSON.stringify({
    ...source,
    runnerId,
    execution: { backend: 'marketplace', state: nextState },
    paths: {
      ...source.paths,
      attemptDir: linkedDir,
      manifest: manifestPath,
      worktree: join(linkedDir, 'worktree'),
      log: join(linkedDir, 'session.log'),
      ghConfigDir: join(linkedDir, 'gh-config'),
      askpass: join(linkedDir, 'askpass'),
      tokenFile: join(linkedDir, 'token'),
    },
    repository: {
      ...source.repository,
      root: join(linkedDir, 'worktree'),
      gitCommonDir: join(linkedDir, 'worktree', '.git'),
    },
  }, null, 2)}\n`);
  harness.manifestPath = manifestPath;
  harness.attemptDir = linkedDir;
  harness.worktreePath = join(linkedDir, 'worktree');
  harness.currentManifest = readAttemptManifest(manifestPath);
  return manifestPath;
}

class RealGitVerticalHarness implements
  MarketplaceMutationAuthorityPort,
  MarketplaceMutationVerificationPort,
  MarketplaceReviewAnchorPort,
  AdoptionReceiptPorts {
  readonly comments: AdoptionReceiptComment[] = [];
  readonly boundaries: MarketplaceMutationAdoptionBoundary[] = [];
  readonly claimOid: GitOid;
  readonly expectedHead: GitOid;
  currentManifest: AttemptManifest;
  manifestPath: string;
  attemptDir: string;
  worktreePath: string;
  v2Base: string;
  requestDigest: string;
  delivery: MarketplaceSolutionDeliveryEvidence;
  currentClaim: BranchClaim;
  currentClaimOid: GitOid;
  remoteHead: GitOid;
  prHead: GitOid;
  hostHead?: GitOid;
  reviewAnchor?: MarketplaceReviewAnchorEvidence;
  crashBoundary?: MarketplaceMutationAdoptionBoundary;
  observeCalls = 0;
  applyMutations = 0;
  commitMutations = 0;
  checkpointMutations = 0;
  completionMutations = 0;
  reviewAnchorMutations = 0;
  routerClaims = 0;
  taskSubmissions = 0;
  agentSpawns = 0;
  nextCommentId = 9001;
  clock: () => Date = () => new Date('2026-07-26T12:03:00.000Z');

  constructor(status: 'submitted' | 'solution-observed' = 'submitted') {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-solution-vertical-'));
    roots.push(root);
    this.v2Base = join(root, 'v2');
    this.attemptDir = join(root, 'attempt');
    this.worktreePath = join(this.attemptDir, 'worktree');
    mkdirSync(join(this.worktreePath, 'packages/autopilot/src'), { recursive: true });
    const heads = initGitWorktree(this.worktreePath);
    this.claimOid = heads.claimOid;
    this.expectedHead = heads.expectedHead;
    this.currentClaimOid = heads.claimOid;
    this.remoteHead = heads.expectedHead;
    this.prHead = heads.expectedHead;
    this.currentClaim = branchClaimFor(heads.claimOid);

    const requestPath = join(this.attemptDir, 'marketplace-request.json');
    const built = buildMarketplaceTaskRequest({
      workflow: 'implementation',
      repository: 'Jinn-Network/mono',
      language: 'typescript',
      verificationProfile: 'jinn-mono.v1',
      issueNumber: 2001,
      prNumber: 2101,
      targetBase: 'next',
      branch: 'codex/issue-2001',
      claimOid: heads.claimOid,
      expectedHead: heads.expectedHead,
      v2AttemptId: ATTEMPT_ID,
      runnerId: 'runner-1',
      taskSnapshot: {
        title: 'Implement exact marketplace contracts',
        body: 'Add the approved contract surface.',
        prBody: 'Draft implementation PR.',
        baseSha: heads.claimOid,
        targetBaseOid: heads.expectedHead,
      },
      receiptAuthors: ['jinn-autopilot'],
      createdAt: Date.parse('2026-07-26T12:00:00.000Z'),
    });
    const persisted = persistMarketplaceTaskRequest(requestPath, built.request);
    this.requestDigest = persisted.requestDigest;
    const obs = observationForHeads(heads.claimOid, heads.expectedHead);
    this.delivery = deliveryEvidence(this.attemptDir, obs);
    writeFileSync(this.delivery.observationPath, `${JSON.stringify(obs, null, 2)}\n`, { mode: 0o600 });
    this.manifestPath = join(this.attemptDir, 'manifest.json');
    this.currentManifest = decodeAttemptManifest({
      version: 2,
      attemptId: ATTEMPT_ID,
      runnerId: 'runner-1',
      host: 'test-host',
      phase: 'implement',
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v3',
          status,
          requestPath,
          requestDigest: persisted.requestDigest,
          solverNetSelectionPath: persisted.solverNetSelectionPath,
          preparedAt: '2026-07-26T12:00:00.000Z',
          agentSoftDeadline: built.agentSoftDeadline,
          adoptionDeadline: built.adoptionDeadline,
          submission: {
            schemaVersion: 1,
            generatedAt: '2026-07-26T12:01:00.000Z',
            verb: 'tasks submit',
            id: `autopilot:${ATTEMPT_ID}`,
            creatorMultisig: `0x${'a'.repeat(40)}`,
            taskId: '501',
            taskCid: 'bafy-task',
            creationTx: `0x${'a'.repeat(64)}`,
            creationBlock: 100,
            solverNetManifestCid: 'bafy-solvernet',
            status: 'submitted',
            idempotent: false,
          },
          submittedAt: '2026-07-26T12:02:00.000Z',
          ...(status === 'solution-observed' ? { delivery: this.delivery } : {}),
        },
      },
      subject: 'issue-2001',
      issueNumber: 2001,
      prNumber: 2101,
      branch: 'codex/issue-2001',
      targetBase: 'next',
      targetBaseOid: heads.expectedHead,
      expectedHead: heads.expectedHead,
      claimOid: heads.claimOid,
      selectedLogin: 'jinn-autopilot',
      repository: {
        root: this.worktreePath,
        gitCommonDir: join(this.worktreePath, '.git'),
        remoteName: 'origin',
        remoteUrlHash: 'a'.repeat(64),
      },
      processState: 'running',
      pid: 4242,
      paths: {
        attemptDir: this.attemptDir,
        worktree: this.worktreePath,
        manifest: this.manifestPath,
        log: join(this.attemptDir, 'session.log'),
        ghConfigDir: join(this.attemptDir, 'gh-config'),
        askpass: join(this.attemptDir, 'askpass'),
        tokenFile: join(this.attemptDir, 'token'),
      },
      timestamps: {
        createdAt: '2026-07-26T12:00:00.000Z',
        updatedAt: '2026-07-26T12:02:00.000Z',
        childStartedAt: '2026-07-26T12:01:00.000Z',
      },
    });
    writeFileSync(this.manifestPath, `${JSON.stringify(this.currentManifest, null, 2)}\n`, { mode: 0o600 });
  }

  transition = (
    manifestPath: string,
    expectedRequestDigest: string,
    transition: Parameters<typeof transitionMarketplaceAdoption>[2],
    now?: () => Date,
  ) => {
    const updated = transitionMarketplaceAdoption(
      manifestPath,
      expectedRequestDigest,
      transition,
      now ?? this.clock,
    );
    this.currentManifest = updated;
    writeFileSync(this.manifestPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
    return updated;
  };

  async readExactAuthority(): Promise<MarketplaceMutationAuthority> {
    return {
      manifest: this.currentManifest,
      latestClaimOid: this.currentClaimOid,
      latestClaim: this.currentClaim,
      remoteHead: this.remoteHead,
      pullRequest: {
        number: 2101,
        head: this.prHead,
        headRefName: 'codex/issue-2001',
        baseRefName: 'next',
        open: true,
        draft: false,
        labels: ['engine:review'],
        implementationSummary: this.currentClaim.phaseComplete === true
          ? 'Implemented the requested contract.'
          : undefined,
        canonicalIssueNumber: 2001,
        mappingStatus: 'resolved',
        humanActive: false,
        codeOwnerRequired: false,
      },
      receiptAuthors: ['jinn-autopilot'],
    };
  }

  async preflight() {
    return { ok: true as const };
  }

  async verify(input: Parameters<MarketplaceMutationVerificationPort['verify']>[0]) {
    const patch = validateMarketplacePatch(new TextEncoder().encode(PATCH));
    const plan = buildJinnMonoV1VerificationPlan({
      repositoryPath: this.worktreePath,
      touchedPaths: patch.touchedPaths,
    });
    const verifiedAt = this.clock().toISOString();
    return {
      profile: 'jinn-mono.v1' as const,
      artifactDigest: patch.artifactDigest,
      expectedTree: input.expectedTree,
      planDigest: marketplaceVerificationPlanDigest(plan),
      commands: [{
        label: 'typecheck',
        command: 'yarn',
        args: ['typecheck'],
        cwdRelative: 'packages/autopilot',
        status: 'passed' as const,
        exitCode: 0 as const,
        stdoutDigest: `sha256:${'f'.repeat(64)}`,
        stderrDigest: `sha256:${'0'.repeat(64)}`,
        startedAt: verifiedAt,
        completedAt: verifiedAt,
      }],
      verifiedAt,
    };
  }

  async acquireOrRecover(input: { readonly expectedHead: GitOid }) {
    this.routerClaims += 1;
    if (this.reviewAnchor === undefined) {
      this.reviewAnchorMutations += 1;
      this.reviewAnchor = {
        ...reviewAnchorEvidence(this.attemptDir, input.expectedHead),
        anchoredAt: this.clock().toISOString(),
      };
    }
    return { status: 'anchored' as const, anchor: this.reviewAnchor };
  }

  async release() {}

  readonly protocol: ImplementationSessionProtocol = {
    checkpoint: async () => {
      this.checkpointMutations += 1;
      if (this.hostHead !== undefined) {
        this.remoteHead = this.hostHead;
        this.prHead = this.hostHead;
      }
      return {
        status: 'already-applied' as const,
        head: this.hostHead ?? this.remoteHead,
      };
    },
    implementationComplete: async (_manifest, summary) => {
      expect(summary).toBe('Implemented the requested contract.');
      if (this.currentClaim.phaseComplete !== true) {
        this.completionMutations += 1;
        this.currentClaim = { ...this.currentClaim, phaseComplete: true };
        const head = this.hostHead ?? this.remoteHead;
        this.currentClaimOid = head;
        this.remoteHead = head;
        this.prHead = head;
      }
      return { status: 'complete' as const, head: this.hostHead ?? this.remoteHead };
    },
    reviewVerdict: async () => { throw new Error('not used'); },
    human: async () => ({ status: 'human' as const, head: this.remoteHead }),
  };

  async listPrIssueComments() {
    return { comments: this.comments };
  }

  async verifyReceiptFacts() {
    return true;
  }

  async readCurrentPrHead() {
    return this.prHead;
  }

  async createPrComment(input: { readonly expectedHead: GitOid; readonly body: string }) {
    const existing = this.comments.find((comment) => comment.body === input.body);
    if (existing !== undefined) {
      return { commentId: existing.id, author: existing.authorLogin };
    }
    const comment = {
      id: this.nextCommentId,
      authorLogin: 'jinn-autopilot',
      body: input.body,
      createdAt: '2026-07-27T12:08:00.000Z',
      updatedAt: '2026-07-27T12:08:00.000Z',
    };
    this.nextCommentId += 1;
    this.comments.push(comment);
    return { commentId: comment.id, author: comment.authorLogin };
  }

  async observe(manifestPath: string) {
    this.observeCalls += 1;
    this.delivery = {
      ...this.delivery,
      observedAt: this.clock().toISOString(),
    };
    this.transition(manifestPath, this.requestDigest, {
      status: 'solution-observed',
      delivery: this.delivery,
    }, this.clock);
    const obs = observationForHeads(this.claimOid, this.expectedHead);
    return {
      status: 'verified' as const,
      observation: obs,
      observationPath: this.delivery.observationPath,
      observationDigest: this.delivery.observationDigest,
    };
  }

  async boundary(boundary: MarketplaceMutationAdoptionBoundary) {
    this.boundaries.push(boundary);
    if (this.crashBoundary === boundary) {
      this.crashBoundary = undefined;
      throw new MarketplaceAdoptionCrashInjectionError(boundary);
    }
  }

  coordinator() {
    const gitDates = () => ({
      GIT_AUTHOR_DATE: this.clock().toISOString(),
      GIT_COMMITTER_DATE: this.clock().toISOString(),
    });
    const gitPort = createMarketplaceMutationGitPort({
      runGit: (args, options) => runMarketplacePatchGit(args, {
        ...options,
        env: { ...options.env, ...gitDates() },
      }),
    });
    const wrappedGit = {
      readState: (identity: Parameters<typeof gitPort.readState>[0]) => gitPort.readState(identity),
      commit: async (identity: Parameters<typeof gitPort.commit>[0]) => {
        this.commitMutations += 1;
        const evidence = await gitPort.commit(identity);
        this.hostHead = evidence.head;
        return evidence;
      },
    };
    return makeMarketplaceMutationAdoptionCoordinator({
      observe: (path) => this.observe(path),
      readAuthority: this,
      validatePatch: validateMarketplacePatch,
      applyPatch: async (input) => {
        this.applyMutations += 1;
        return applyMarketplacePatchToWorktree(input, {
          worktreeProof: {
            prove: async (proofInput) => ({
              manifestPath: proofInput.manifestPath,
              registeredWorktreePath: proofInput.worktreePath,
              expectedHead: proofInput.expectedHead,
              currentHead: proofInput.expectedHead,
              indexClean: true,
              worktreeClean: true,
              untrackedPaths: [],
            }),
          },
          runGit: (args, options) => runMarketplacePatchGit(args, {
            ...options,
            env: { ...options.env, ...gitDates() },
          }),
        });
      },
      git: wrappedGit,
      verification: this,
      implementation: this.protocol,
      reviewAnchors: this,
      receipts: this,
      transition: this.transition,
      now: () => this.clock(),
      onBoundary: (boundary) => this.boundary(boundary),
    });
  }

  async recover() {
    if (!this.manifestPath.startsWith(this.v2Base)) {
      installAtV2(this);
    }
    return recoverSubmittedMarketplaceAttempts({
      v2Base: this.v2Base,
      recoverPrepared: async () => [],
      makeAdopter: () => this.coordinator(),
      isPidAlive: () => true,
      now: () => this.clock(),
    });
  }

  gitCommitCount(): number {
    return Number(git(this.worktreePath, ['rev-list', '--count', 'HEAD']));
  }

  reviewAnchorLinked(): boolean {
    const manifest = readAttemptManifest(this.manifestPath);
    if (manifest.execution.backend !== 'marketplace') return false;
    const state = manifest.execution.state;
    return state.schemaVersion === 'marketplace-execution-v3'
      && state.status === 'receipt-published'
      && 'progress' in state
      && state.progress.status === 'review-anchored';
  }
}

async function adopt(harness: RealGitVerticalHarness) {
  return harness.coordinator().adopt(harness.manifestPath);
}

describe('marketplace solution vertical acceptance (real git)', () => {
  it('recovers a preparing marketplace process through an accepted receipt without local execution', async () => {
    const harness = new RealGitVerticalHarness('submitted');
    installAtV2(harness);
    const {
      childStartedAt: _childStartedAt,
      childExitedAt: _childExitedAt,
      ...preparingTimestamps
    } = harness.currentManifest.timestamps;
    harness.currentManifest = decodeAttemptManifest({
      ...harness.currentManifest,
      processState: 'preparing',
      pid: null,
      timestamps: preparingTimestamps,
    });
    writeFileSync(
      harness.manifestPath,
      `${JSON.stringify(harness.currentManifest, null, 2)}\n`,
      { mode: 0o600 },
    );

    const result = await recoverSubmittedMarketplaceAttempts({
      v2Base: harness.v2Base,
      recoverPrepared: async () => [],
      processPid: 720,
      isPidAlive: () => false,
      makeAdopter: () => {
        harness.currentManifest = readAttemptManifest(harness.manifestPath);
        return harness.coordinator();
      },
      now: () => harness.clock(),
    });

    expect(result).toEqual({ ok: true });
    expect(marketplaceStatus(readAttemptManifest(harness.manifestPath)))
      .toBe('receipt-published');
    expect(readAttemptManifest(harness.manifestPath)).toMatchObject({
      processState: 'running',
      pid: 720,
    });
    expect(harness.taskSubmissions).toBe(0);
    expect(harness.agentSpawns).toBe(0);
    expect(harness.comments).toHaveLength(1);
    expect(harness.reviewAnchorLinked()).toBe(true);
  });

  it('adopts a submitted mutation through accepted receipt without duplicate side effects', async () => {
    const harness = new RealGitVerticalHarness('submitted');
    installAtV2(harness);
    const first = await adopt(harness);
    expect(first).toMatchObject({ status: 'accepted' });
    expect(first.status === 'accepted' ? first.resultingHead : null).toBe(harness.hostHead);
    expect(harness.observeCalls).toBe(1);
    expect(harness.applyMutations).toBe(1);
    expect(harness.commitMutations).toBe(1);
    expect(harness.comments).toHaveLength(1);
    expect(harness.reviewAnchorMutations).toBe(1);
    expect(harness.taskSubmissions).toBe(0);
    expect(harness.agentSpawns).toBe(0);
    expect(harness.routerClaims).toBe(1);
    expect(readAttemptManifest(harness.manifestPath).processState).toBe('running');
    expect(marketplaceStatus(readAttemptManifest(harness.manifestPath))).toBe('receipt-published');
    expect(harness.reviewAnchorLinked()).toBe(true);

    const recovery = await harness.recover();
    expect(recovery).toEqual({ ok: true });
    expect(harness.observeCalls).toBe(1);
    expect(harness.comments).toHaveLength(1);
    expect(harness.applyMutations).toBe(1);
    expect(harness.commitMutations).toBe(1);
    expect(harness.reviewAnchorMutations).toBe(1);
  });

  it.each(ALL_BOUNDARIES)('recovers idempotently after crash at %s via recovery replay', async (boundary) => {
    const harness = new RealGitVerticalHarness(
      boundary === 'observation-persisted' ? 'submitted' : 'solution-observed',
    );
    installAtV2(harness);
    harness.crashBoundary = boundary;
    await expect(adopt(harness)).resolves.toMatchObject({ status: 'recoverable' });

    const observeAfterCrash = harness.observeCalls;
    const commentsAfterCrash = harness.comments.length;

    let completed = await adopt(harness);
    for (let attempt = 0; attempt < 5 && completed.status === 'recoverable'; attempt += 1) {
      completed = await adopt(harness);
    }
    expect(completed).toMatchObject({ status: 'accepted' });

    expect(harness.observeCalls).toBe(observeAfterCrash);
    expect(harness.comments).toHaveLength(Math.max(1, commentsAfterCrash));

    const manifest = readAttemptManifest(harness.manifestPath);
    expect(marketplaceStatus(manifest)).toBe('receipt-published');
    expect(readAttemptManifest(harness.manifestPath).processState).toBe('running');
    expect(harness.reviewAnchorLinked()).toBe(true);
    expect(completed.status === 'accepted' ? completed.resultingHead : null).toBe(harness.hostHead);

    expect(await harness.recover()).toEqual({ ok: true });
    expect(harness.observeCalls).toBe(observeAfterCrash);
    expect(harness.comments).toHaveLength(Math.max(1, commentsAfterCrash));
  });
});

describe('marketplace solution vertical crash matrix (Harness)', () => {
  async function adoptHarness(harness: Harness) {
    return harness.coordinator().adopt(harness.manifestPath);
  }

  it.each(ALL_BOUNDARIES)('replays %s without duplicate side effects', async (boundary) => {
    const harness = new Harness(
      'implement',
      boundary === 'observation-persisted' ? 'submitted' : 'solution-observed',
    );
    harness.clock = () => new Date('2026-07-27T12:22:00.000Z');
    harness.crashBoundary = boundary;
    await expect(adoptHarness(harness)).resolves.toMatchObject({ status: 'recoverable' });
    await expect(adoptHarness(harness)).resolves.toMatchObject({ status: 'accepted' });
    expect(harness.applyMutations).toBeLessThanOrEqual(1);
    expect(harness.commitMutations).toBeLessThanOrEqual(1);
    expect(harness.comments).toHaveLength(1);
    expect(harness.reviewAnchorMutations).toBe(1);
    await expect(adoptHarness(harness)).resolves.toMatchObject({ status: 'accepted' });
    expect(harness.comments).toHaveLength(1);
  });
});
