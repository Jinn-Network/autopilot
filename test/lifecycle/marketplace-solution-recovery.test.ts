import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeProductionCapabilityPreflight,
  makeMarketplaceRecoveryReadSnapshot,
} from '../../src/lifecycle/active-runtime-production.js';
import { DEFAULT_CONFIG } from '../../src/dispatcher/types.js';
import { CredentialPool } from '../../src/lifecycle/credentials.js';
import { runLifecycleCycle } from '../../src/lifecycle/controller.js';
import type { ReconciliationWriter } from '../../src/lifecycle/reconciler.js';
import {
  marketplaceStatus,
  installMarketplaceEvaluatorLeg,
  upgradeMarketplaceExecutionV2,
} from '../../src/lifecycle/marketplace-adoption-state.js';
import {
  readAttemptManifest,
  decodeAttemptManifest,
  type AttemptManifest,
  type MarketplaceExecutionState,
} from '../../src/lifecycle/attempt-workspace.js';
import {
  recoverSubmittedMarketplaceAttempts,
  reconcileReceiptTerminalState,
} from '../../src/lifecycle/session-execution-backend.js';
import * as lifecycleEntrypoint from '../../scripts/run-autopilot-v2.js';
import type { GitHubLifecycleSnapshot } from '../../src/lifecycle/snapshot.js';
import { gitOid } from '../../src/lifecycle/types.js';
import { Harness } from './marketplace-mutation-adoption.test.js';

const NOW = new Date('2026-07-27T12:00:00.000Z');
const ATTEMPT_ID = '123e4567-e89b-42d3-a456-426614174001';
const REVIEW_ATTEMPT = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];

function marketplaceExecutionState(manifest: AttemptManifest): MarketplaceExecutionState {
  if (manifest.execution.backend !== 'marketplace') {
    throw new Error('expected marketplace execution');
  }
  return manifest.execution.state;
}

function marketplacePreparedState(manifest: AttemptManifest) {
  const state = marketplaceExecutionState(manifest);
  if (!('requestDigest' in state)) {
    throw new Error('expected prepared marketplace execution state');
  }
  return state;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function snapshot(): GitHubLifecycleSnapshot {
  return {
    snapshotComplete: true,
    capturedAt: NOW.toISOString(),
    githubUsage: {
      graphqlRequests: 1,
      graphqlCost: 1,
      graphqlRemaining: 4_000,
      graphqlResetAt: '2026-07-27T13:00:00.000Z',
      restRequests: 0,
      restNotModified: 0,
      cacheHits: 0,
      accountingComplete: true,
    },
    project: {
      items: [],
      rateLimit: {
        remaining: 4_000,
        used: 0,
        resetAt: '2026-07-27T13:00:00.000Z',
      },
      currentSprintIterationId: null,
    },
    issues: [],
    pullRequests: [],
    branches: [],
    diagnostics: [],
    lifecycle: { items: [] },
  };
}

function pool(): CredentialPool {
  return new CredentialPool([{
    login: 'jinn-autopilot',
    normalizedLogin: 'jinn-autopilot',
    implementationToken: 'secret',
  }]);
}

function relocateMarketplaceExecutionState(
  state: MarketplaceExecutionState,
  linkedDir: string,
): MarketplaceExecutionState {
  if (state.schemaVersion !== 'marketplace-execution-v3') {
    return state;
  }
  const requestPath = join(linkedDir, 'marketplace-request.json');
  const solverNetSelectionPath = join(linkedDir, 'solvernet-selection.json');
  const relocatedBase = {
    ...state,
    requestPath,
    solverNetSelectionPath,
  };
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
                basename(dirname(progress.reviewAnchor.manifestPath)),
                basename(progress.reviewAnchor.manifestPath),
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

function installHarnessAtV2(
  harness: Harness,
  v2Base: string,
  runnerId: string,
  attemptId: string,
): string {
  const linkedDir = join(v2Base, runnerId, 'implement', `issue-2001-${attemptId}`);
  mkdirSync(linkedDir, { recursive: true });
  cpSync(harness.attemptDir, linkedDir, { recursive: true });
  const manifestPath = join(linkedDir, 'manifest.json');
  const source = readAttemptManifest(harness.manifestPath);
  const state = marketplaceExecutionState(source);
  const relocatedState = relocateMarketplaceExecutionState(state, linkedDir);
  const requestPath = join(linkedDir, 'marketplace-request.json');
  const solverNetSelectionPath = join(linkedDir, 'solvernet-selection.json');
  const nextState = 'submission' in relocatedState
    ? {
        ...relocatedState,
        requestPath,
        solverNetSelectionPath,
        submission: {
          ...relocatedState.submission,
          id: `autopilot:${attemptId}`,
        },
      }
    : {
        ...relocatedState,
        requestPath,
        solverNetSelectionPath,
      };
  writeFileSync(manifestPath, `${JSON.stringify({
    ...source,
    attemptId,
    runnerId,
    execution: {
      backend: 'marketplace',
      state: nextState,
    },
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
  }, null, 2)}\n`);
  return manifestPath;
}

function setMarketplaceProcessMetadata(
  manifestPath: string,
  processState: 'preparing' | 'running',
  pid: number | null,
): AttemptManifest {
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    processState: 'preparing' | 'running';
    pid: number | null;
    timestamps: {
      createdAt: string;
      updatedAt: string;
      childStartedAt?: string;
      childExitedAt?: string;
    };
  };
  raw.processState = processState;
  raw.pid = pid;
  delete raw.timestamps.childExitedAt;
  if (processState === 'preparing') {
    delete raw.timestamps.childStartedAt;
  } else {
    raw.timestamps.childStartedAt ??= raw.timestamps.updatedAt;
  }
  const manifest = decodeAttemptManifest(raw);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function installEvaluatorLegAtV2(
  v2Base: string,
  runnerId: string,
  originManifestPath: string,
  reviewAttemptId: string,
): string {
  const reviewDir = join(v2Base, runnerId, 'review', `pr-2101-${reviewAttemptId}`);
  mkdirSync(join(reviewDir, 'worktree'), { recursive: true });
  mkdirSync(join(reviewDir, 'gh-config'), { recursive: true });
  const requestDigest = marketplacePreparedState(readAttemptManifest(originManifestPath)).requestDigest;
  const origin = readAttemptManifest(originManifestPath);
  const reviewManifestPath = join(reviewDir, 'manifest.json');
  const manifest = decodeAttemptManifest({
    version: 2,
    attemptId: reviewAttemptId,
    runnerId,
    host: origin.host,
    phase: 'review',
    processState: 'preparing',
    pid: null,
    execution: {
      backend: 'marketplace',
      state: {
        schemaVersion: 'marketplace-execution-v2',
        status: 'prepared',
        requestPath: join(reviewDir, 'marketplace-request.json'),
        requestDigest,
        solverNetSelectionPath: join(reviewDir, 'solvernet-selection.json'),
        preparedAt: NOW.toISOString(),
        agentSoftDeadline: '2026-07-27T13:00:00.000Z',
        adoptionDeadline: '2026-07-27T14:00:00.000Z',
      },
    },
    subject: 'pr-2101',
    issueNumber: 2001,
    prNumber: 2101,
    branch: 'autopilot/2001',
    targetBase: 'next',
    expectedHead: gitOid('3'.repeat(40)),
    claimOid: gitOid('3'.repeat(40)),
    reviewGeneration: '33333333-3333-4333-8333-333333333333',
    reviewRefOid: gitOid('3'.repeat(40)),
    reviewApprovalPolicy: 'approve-eligible',
    selectedLogin: 'review-bot',
    repository: origin.repository,
    paths: {
      attemptDir: reviewDir,
      manifest: reviewManifestPath,
      worktree: join(reviewDir, 'worktree'),
      log: join(reviewDir, 'session.log'),
      ghConfigDir: join(reviewDir, 'gh-config'),
      askpass: join(reviewDir, 'askpass'),
      tokenFile: join(reviewDir, 'token'),
    },
    timestamps: {
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    },
  });
  writeFileSync(reviewManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  installMarketplaceEvaluatorLeg(
    reviewManifestPath,
    {
      originManifestPath,
      originV2AttemptId: ATTEMPT_ID,
      originRequestDigest: requestDigest,
      taskId: '501',
      taskCid: 'bafybeigdyrzt5m6u2r3o4exampletaskcid',
      taskCreationBlock: 501,
      prNumber: 2101,
      expectedHead: gitOid('3'.repeat(40)),
      generation: '33333333-3333-4333-8333-333333333333',
      reviewRefOid: gitOid('3'.repeat(40)),
      reviewer: 'review-bot',
    },
    () => NOW,
  );
  return reviewManifestPath;
}

function writer(): ReconciliationWriter {
  return new Proxy({} as ReconciliationWriter, {
    get() {
      return async () => null;
    },
  });
}

describe('marketplace solution recovery', () => {
  it('runs controller phases in the required pre-snapshot order', async () => {
    const events: string[] = [];
    const report = await runLifecycleCycle('active', {
      writer: writer(),
      now: () => NOW,
      staleAfterMs: 60_000,
      runnerId: 'runner-a',
      cycleId: () => 'cycle-1',
      onLifecyclePhase: (phase) => events.push(phase),
      recoverPreparedMarketplaceSubmissions: async () => {},
      recoverSubmittedMarketplaceAdoptions: async () => {},
      readSnapshot: async () => snapshot(),
      active: {
        preflight: async () => ({ ok: true }),
        readLocalState: () => ({
          remaining: { implementation: 1, child: 1, review: 1 },
          newWorkPaused: false,
          availableLogins: ['jinn-autopilot'],
          implementationPreferredLogin: 'jinn-autopilot',
        }),
        implementationBackpressureThreshold: 10,
        executeAction: async () => ({ outcome: 'spawned' }),
      },
    });
    expect(report.status).toBe('ok');
    expect(events).toEqual([
      'initialize',
      'recover-prepared-submissions',
      'recover-submitted-adoptions',
      'read-snapshot',
      'dispatch',
    ]);
  });

  it('scans every runner directory and upgrades submitted v2 before adoption', async () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-solution-recovery-'));
    roots.push(root);
    const v2Base = join(root, 'v2');
    const harnessA = new Harness('implement', 'submitted');
    const harnessB = new Harness('implement', 'submitted');
    const first = installHarnessAtV2(harnessA, v2Base, 'runner-a', ATTEMPT_ID);
    const second = installHarnessAtV2(
      harnessB,
      v2Base,
      'runner-b',
      '223e4567-e89b-42d3-a456-426614174002',
    );
    writeFileSync(first, readFileSync(first, 'utf8').replace(
      'marketplace-execution-v3',
      'marketplace-execution-v2',
    ));
    const adopted: string[] = [];
    const upgraded = upgradeMarketplaceExecutionV2(
      first,
      marketplacePreparedState(readAttemptManifest(first)).requestDigest,
      () => NOW,
    );
    expect(marketplaceStatus(upgraded)).toBe('submitted');
    const result = await recoverSubmittedMarketplaceAttempts({
      v2Base,
      recoverPrepared: async () => [],
      processPid: 4242,
      makeAdopter: () => ({
        adopt: async (manifestPath) => {
          adopted.push(manifestPath);
          return { status: 'recoverable', stage: 'observation', detail: 'pending' };
        },
      }),
      isPidAlive: () => true,
      now: () => NOW,
    });
    expect(result).toEqual({ ok: true });
    expect(adopted.sort()).toEqual([first, second].sort());
    expect(
      marketplaceExecutionState(readAttemptManifest(first)).schemaVersion,
    ).toBe('marketplace-execution-v3');
  });

  it('claims a preparing submitted marketplace process before invoking its adopter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-solution-recovery-'));
    roots.push(root);
    const v2Base = join(root, 'v2');
    const harness = new Harness('implement', 'submitted');
    const manifestPath = installHarnessAtV2(
      harness,
      v2Base,
      'runner-1',
      ATTEMPT_ID,
    );
    setMarketplaceProcessMetadata(manifestPath, 'preparing', null);
    const seen: AttemptManifest[] = [];

    const result = await recoverSubmittedMarketplaceAttempts({
      v2Base,
      recoverPrepared: async () => [],
      processPid: 720,
      isPidAlive: () => false,
      makeAdopter: () => ({
        adopt: async (path) => {
          seen.push(readAttemptManifest(path));
          return { status: 'recoverable', stage: 'observation', detail: 'pending' };
        },
      }),
      now: () => NOW,
    });

    expect(result).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      processState: 'running',
      pid: 720,
    });
  });

  it('blocks a live foreign marketplace process lease before constructing its adopter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-solution-recovery-'));
    roots.push(root);
    const v2Base = join(root, 'v2');
    const harness = new Harness('implement', 'submitted');
    const manifestPath = installHarnessAtV2(
      harness,
      v2Base,
      'runner-1',
      ATTEMPT_ID,
    );
    setMarketplaceProcessMetadata(manifestPath, 'running', 721);
    const before = readFileSync(manifestPath);
    const makeAdopter = vi.fn(() => ({
      adopt: vi.fn(async () => ({
        status: 'recoverable' as const,
        stage: 'observation',
        detail: 'pending',
      })),
    }));

    const result = await recoverSubmittedMarketplaceAttempts({
      v2Base,
      recoverPrepared: async () => [],
      processPid: 720,
      isPidAlive: (pid) => pid === 721,
      makeAdopter,
      now: () => NOW,
    });

    expect(result).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/live PID/i),
    });
    expect(makeAdopter).not.toHaveBeenCalled();
    expect(readFileSync(manifestPath)).toEqual(before);
  });

  it('rebinds a dead marketplace process lease before replaying mid-adoption state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-solution-recovery-'));
    roots.push(root);
    const v2Base = join(root, 'v2');
    const harness = new Harness('implement', 'solution-observed');
    const manifestPath = installHarnessAtV2(
      harness,
      v2Base,
      'runner-1',
      ATTEMPT_ID,
    );
    setMarketplaceProcessMetadata(manifestPath, 'running', 721);
    const seen: AttemptManifest[] = [];

    const result = await recoverSubmittedMarketplaceAttempts({
      v2Base,
      recoverPrepared: async () => [],
      processPid: 720,
      isPidAlive: () => false,
      makeAdopter: () => ({
        adopt: async (path) => {
          seen.push(readAttemptManifest(path));
          return { status: 'recoverable', stage: 'verification', detail: 'pending' };
        },
      }),
      now: () => NOW,
    });

    expect(result).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      processState: 'running',
      pid: 720,
      execution: {
        backend: 'marketplace',
        state: { status: 'solution-observed' },
      },
    });
  });

  it('skips re-adoption for accepted receipt-published attempts', async () => {
    const harness = new Harness();
    await harness.coordinator().adopt(harness.manifestPath);
    const adopted = readAttemptManifest(harness.manifestPath);
    expect(marketplaceExecutionState(adopted).status).toBe('receipt-published');
    expect(marketplaceStatus(adopted)).toBe('receipt-published');
    const adopt = vi.fn();
    await reconcileReceiptTerminalState(adopted, {
      v2Base: join(dirname(harness.attemptDir), 'v2'),
      isPidAlive: () => true,
      now: () => NOW,
    });
    expect(adopt).not.toHaveBeenCalled();
    expect(adopted.processState).toBe('running');
  });

  it('reconciles rejected receipt-published attempts without re-adoption', async () => {
    const harness = new Harness();
    await harness.coordinator().adopt(harness.manifestPath);
    const adopt = vi.fn();
    const root = mkdtempSync(join(tmpdir(), 'marketplace-solution-recovery-'));
    roots.push(root);
    const v2Base = join(root, 'v2');
    const linkedDir = join(v2Base, 'runner-1', 'implement', `issue-2001-${ATTEMPT_ID}`);
    const runnerDir = join(v2Base, 'runner-1');
    const reviewDir = join(runnerDir, 'review', `pr-2101-${REVIEW_ATTEMPT}`);
    mkdirSync(linkedDir, { recursive: true });
    cpSync(harness.attemptDir, linkedDir, { recursive: true });
    const sourceReviewDir = join(
      dirname(dirname(harness.attemptDir)),
      'review',
      `pr-2101-${REVIEW_ATTEMPT}`,
    );
    if (existsSync(sourceReviewDir)) {
      mkdirSync(dirname(reviewDir), { recursive: true });
      cpSync(sourceReviewDir, reviewDir, { recursive: true });
    }
    const manifestPath = join(linkedDir, 'manifest.json');
    const source = readAttemptManifest(harness.manifestPath);
    const adoptedState = relocateMarketplaceExecutionState(
      marketplaceExecutionState(source),
      linkedDir,
    );
    expect(adoptedState.status).toBe('receipt-published');
    if (!('progress' in adoptedState) || adoptedState.progress.status !== 'review-anchored') {
      throw new Error('expected review-anchored progress');
    }
    const progress = {
      ...adoptedState.progress,
      reviewAnchor: {
        ...adoptedState.progress.reviewAnchor,
        manifestPath: join(reviewDir, 'manifest.json'),
      },
    };
    const acceptedEvidence = 'receipt' in adoptedState ? adoptedState.receipt : undefined;
    if (acceptedEvidence === undefined) {
      throw new Error('expected receipt evidence');
    }
    writeFileSync(manifestPath, `${JSON.stringify({
      ...source,
      attemptId: ATTEMPT_ID,
      runnerId: 'runner-1',
      processState: 'running',
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
      execution: {
        backend: 'marketplace',
        state: {
          ...adoptedState,
          status: 'receipt-published',
          progress,
          receipt: {
            ...acceptedEvidence,
            receipt: {
              ...acceptedEvidence.receipt,
              disposition: 'rejected',
              reason: 'stale-head',
              detail: 'head moved',
              resultingHead: undefined,
              reviewGeneration: undefined,
              reviewRefOid: undefined,
              operation: undefined,
            },
          },
        },
      },
    }, null, 2)}\n`);
    const release = vi.fn(async () => {});
    const pidProbe = vi.fn(() => true);
    const result = await recoverSubmittedMarketplaceAttempts({
      v2Base,
      recoverPrepared: async () => [],
      makeAdopter: () => ({ adopt }),
      releaseReviewAnchor: release,
      processPid: 720,
      isPidAlive: pidProbe,
      now: () => new Date('2026-07-28T12:00:00.000Z'),
    });
    expect(result).toEqual({ ok: true });
    expect(adopt).not.toHaveBeenCalled();
    expect(pidProbe).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(progress.reviewAnchor);
    expect(readAttemptManifest(manifestPath).processState).toBe('exited');
  });

  it('fails closed when adoption recovery returns rejected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-solution-recovery-'));
    roots.push(root);
    const v2Base = join(root, 'v2');
    const harness = new Harness('implement', 'submitted');
    const manifestPath = installHarnessAtV2(harness, v2Base, 'runner-1', ATTEMPT_ID);
    const result = await recoverSubmittedMarketplaceAttempts({
      v2Base,
      recoverPrepared: async () => [],
      processPid: 4242,
      makeAdopter: () => ({
        adopt: async () => ({
          status: 'rejected',
          reason: 'correlation-mismatch',
          receipt: {
            schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
            disposition: 'rejected',
            role: 'solution',
            reason: 'correlation-mismatch',
            detail: 'mismatch',
            taskId: '501',
            attemptIndex: 0,
            requestId: `0x${'1'.repeat(64)}`,
            deliveryEnvelopeCid: 'bafy-envelope',
            v2AttemptId: ATTEMPT_ID,
            prNumber: 2101,
            claimOid: gitOid('1'.repeat(40)),
            expectedHead: gitOid('2'.repeat(40)),
            recordedAt: NOW.toISOString(),
          },
        }),
      }),
      isPidAlive: () => true,
      now: () => NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/rejected/);
    expect(result.detail).toContain(manifestPath);
  });

  it('keeps pending delivery recoverable without failing recovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-solution-recovery-'));
    roots.push(root);
    const v2Base = join(root, 'v2');
    const harness = new Harness('implement', 'submitted');
    installHarnessAtV2(harness, v2Base, 'runner-1', ATTEMPT_ID);
    const result = await recoverSubmittedMarketplaceAttempts({
      v2Base,
      recoverPrepared: async () => [],
      processPid: 4242,
      makeAdopter: () => ({
        adopt: async () => ({
          status: 'recoverable',
          stage: 'observation',
          detail: 'delivery pending',
        }),
      }),
      isPidAlive: () => true,
      now: () => NOW,
    });
    expect(result).toEqual({ ok: true });
  });

  it('reads recovery snapshots from targeted PR authority instead of fabricating mappings', async () => {
    const harness = new Harness('implement', 'submitted');
    const manifest = readAttemptManifest(harness.manifestPath);
    const cycleSnapshot = snapshot();
    const targetedSnapshot = {
      ...cycleSnapshot,
      pullRequestMappings: [{
        status: 'ambiguous' as const,
        prNumber: 2101,
        issueNumbers: [2001, 2002],
        details: ['PR maps to multiple issues'],
      }],
      pullRequests: [{
        number: 2101,
        title: 'Implement contracts',
        body: '',
        author: 'jinn-autopilot',
        baseRefName: 'next',
        headRefName: 'codex/issue-2001',
        headOid: gitOid(manifest.expectedHead),
        headCommittedAt: NOW.toISOString(),
        isDraft: false,
        state: 'OPEN' as const,
        labels: ['review:needs-human'],
        closingIssueNumbers: [2001],
        mergeability: 'UNKNOWN' as const,
        mergeStateStatus: 'BLOCKED' as const,
        checks: [],
        reviews: [],
      }],
    } satisfies GitHubLifecycleSnapshot;
    const readCycleSnapshot = vi.fn(async () => cycleSnapshot);
    const readTargetedPullRequestSnapshot = vi.fn(async () => targetedSnapshot);
    const readRecoverySnapshot = makeMarketplaceRecoveryReadSnapshot({
      manifestPath: harness.manifestPath,
      readCycleSnapshot,
      readTargetedPullRequestSnapshot,
    });

    await expect(readRecoverySnapshot()).resolves.toBe(targetedSnapshot);
    expect(readCycleSnapshot).toHaveBeenCalledTimes(1);
    expect(readTargetedPullRequestSnapshot).toHaveBeenCalledWith(cycleSnapshot, 2101);
    expect(targetedSnapshot.pullRequestMappings?.[0]?.status).toBe('ambiguous');
    expect(targetedSnapshot.pullRequests?.[0]?.labels).toEqual(['review:needs-human']);
  });

  it('fails closed on contradictory recovery manifest paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-solution-recovery-'));
    roots.push(root);
    const v2Base = join(root, 'v2');
    const harness = new Harness('implement', 'submitted');
    const manifestPath = installHarnessAtV2(harness, v2Base, 'runner-1', ATTEMPT_ID);
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace(
      '"runner-1"',
      '"runner-other"',
    ));
    const result = await recoverSubmittedMarketplaceAttempts({
      v2Base,
      recoverPrepared: async () => [],
      makeAdopter: () => ({ adopt: vi.fn() }),
      isPidAlive: () => true,
      now: () => NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/does not match its v2 attempt path/i);
  });

  it('skips anchored evaluator-leg review manifests during adoption recovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-solution-recovery-'));
    roots.push(root);
    const v2Base = join(root, 'v2');
    const harness = new Harness('implement', 'submitted');
    const manifestPath = installHarnessAtV2(harness, v2Base, 'runner-1', ATTEMPT_ID);
    installEvaluatorLegAtV2(v2Base, 'runner-1', manifestPath, REVIEW_ATTEMPT);
    expect(marketplaceStatus(readAttemptManifest(
      join(v2Base, 'runner-1', 'review', `pr-2101-${REVIEW_ATTEMPT}`, 'manifest.json'),
    ))).toBeNull();
    const adopt = vi.fn(async () => ({
      status: 'recoverable' as const,
      stage: 'observation',
      detail: 'pending',
    }));
    const result = await recoverSubmittedMarketplaceAttempts({
      v2Base,
      recoverPrepared: async () => [],
      processPid: 4242,
      makeAdopter: () => ({ adopt }),
      isPidAlive: () => true,
      now: () => NOW,
    });
    expect(result).toEqual({ ok: true });
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(adopt).toHaveBeenCalledWith(manifestPath);
  });

  it('fails closed when prepared attempts remain before adoption recovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'marketplace-solution-recovery-'));
    roots.push(root);
    const v2Base = join(root, 'v2');
    const harness = new Harness('implement', 'submitted');
    const manifest = readAttemptManifest(harness.manifestPath);
    const preparedState = marketplacePreparedState(manifest);
    const manifestPath = installHarnessAtV2(harness, v2Base, 'runner-1', ATTEMPT_ID);
    writeFileSync(manifestPath, `${JSON.stringify({
      ...readAttemptManifest(manifestPath),
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v3',
          status: 'prepared',
          requestPath: join(dirname(manifestPath), 'marketplace-request.json'),
          requestDigest: preparedState.requestDigest,
          solverNetSelectionPath: join(dirname(manifestPath), 'solvernet-selection.json'),
          preparedAt: preparedState.preparedAt,
          agentSoftDeadline: preparedState.agentSoftDeadline,
          adoptionDeadline: preparedState.adoptionDeadline,
        },
      },
    }, null, 2)}\n`);
    const result = await recoverSubmittedMarketplaceAttempts({
      v2Base,
      recoverPrepared: async () => [],
      makeAdopter: () => ({ adopt: vi.fn() }),
      isPidAlive: () => false,
      now: () => NOW,
    });
    expect(result).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/prepared recovery must finish/i),
    });
  });

  it('joins marketplace preflight dry-run, observation help, and verification readiness', async () => {
    const dryRun = vi.fn(async () => ({
      schemaVersion: 1 as const,
      generatedAt: NOW.toISOString(),
      dryRun: true as const,
      verb: 'tasks submit' as const,
      description: 'marketplace dry run',
      plan: [{}],
    }));
    const observationHelp = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'tasks observe-autopilot-delivery',
      stderr: '',
    }));
    const verificationPreflight = vi.fn(async () => ({ ok: true }));
    const preflight = makeProductionCapabilityPreflight({
      executionBackend: 'marketplace',
      repositoryPath: '/repo',
      runnerId: 'runner-a',
      credentials: pool(),
      repositorySlug: 'Jinn-Network/mono',
      defaultBranch: 'next',
      config: DEFAULT_CONFIG,
      marketplaceTaskAdapter: {
        dryRun,
        submit: vi.fn(),
        recover: vi.fn(),
      },
      marketplaceObservationHelp: observationHelp,
      marketplaceVerificationPreflight: verificationPreflight,
      now: () => NOW,
      nextId: () => ATTEMPT_ID,
    });
    await expect(preflight()).resolves.toEqual({ ok: true });
    expect(dryRun).toHaveBeenCalledTimes(1);
    expect(observationHelp).toHaveBeenCalledTimes(1);
    expect(verificationPreflight).toHaveBeenCalledTimes(1);
  });

  it('never constructs adoption recovery in local execution mode', () => {
    const { makeMarketplaceRecoveryCallback } = lifecycleEntrypoint;
    expect(makeMarketplaceRecoveryCallback({
      mode: 'recover',
      executionBackend: 'local',
      repositorySlug: 'Jinn-Network/mono',
      replay: vi.fn(),
    })).toBeUndefined();
  });
});
