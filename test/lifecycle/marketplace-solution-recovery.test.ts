import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeProductionCapabilityPreflight,
} from '../../src/lifecycle/active-runtime-production.js';
import { DEFAULT_CONFIG } from '../../src/dispatcher/types.js';
import { CredentialPool } from '../../src/lifecycle/credentials.js';
import { runLifecycleCycle } from '../../src/lifecycle/controller.js';
import type { ReconciliationWriter } from '../../src/lifecycle/reconciler.js';
import {
  marketplaceStatus,
  upgradeMarketplaceExecutionV2,
} from '../../src/lifecycle/marketplace-adoption-state.js';
import {
  readAttemptManifest,
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
  const requestPath = join(linkedDir, 'marketplace-request.json');
  const solverNetSelectionPath = join(linkedDir, 'solvernet-selection.json');
  const nextState = 'submission' in state
    ? {
        ...state,
        requestPath,
        solverNetSelectionPath,
        submission: {
          ...state.submission,
          id: `autopilot:${attemptId}`,
        },
      }
    : {
        ...state,
        requestPath,
        solverNetSelectionPath,
      };
  const relocatedState = 'delivery' in nextState
    ? {
        ...nextState,
        delivery: {
          ...nextState.delivery,
          observationPath: join(
            linkedDir,
            'marketplace-solution-observation.json',
          ),
        },
      }
    : nextState;
  writeFileSync(manifestPath, `${JSON.stringify({
    ...source,
    attemptId,
    runnerId,
    execution: {
      backend: 'marketplace',
      state: relocatedState,
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
          remaining: { implementation: 1, review: 1 },
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
    const adopt = vi.fn();
    const v2Base = join(dirname(dirname(harness.manifestPath)), 'v2');
    mkdirSync(join(v2Base, 'runner-1', 'implement'), { recursive: true });
    const manifestPath = join(v2Base, 'runner-1', 'implement', `issue-2001-${ATTEMPT_ID}`, 'manifest.json');
    mkdirSync(dirname(manifestPath), { recursive: true });
    const rejected = readAttemptManifest(harness.manifestPath);
    const rejectedState = marketplaceExecutionState(rejected);
    writeFileSync(manifestPath, `${JSON.stringify({
      ...rejected,
      execution: {
        backend: 'marketplace',
        state: {
          ...rejectedState,
          status: 'receipt-published',
          receipt: {
            commentId: 9001,
            author: 'jinn-autopilot',
            recordedAt: NOW.toISOString(),
            receipt: {
              schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
              disposition: 'rejected',
              role: 'solution',
              reason: 'stale-head',
              detail: 'head moved',
              taskId: '501',
              requestId: `0x${'1'.repeat(64)}`,
              deliveryEnvelopeCid: 'bafy-envelope',
              v2AttemptId: ATTEMPT_ID,
              artifactDigest: `sha256:${'a'.repeat(64)}`,
              claimOid: gitOid('1'.repeat(40)),
              prNumber: 2101,
              expectedHead: gitOid('2'.repeat(40)),
              recordedAt: NOW.toISOString(),
            },
          },
        },
      },
    }, null, 2)}\n`);
    const release = vi.fn(async () => {});
    const result = await recoverSubmittedMarketplaceAttempts({
      v2Base,
      recoverPrepared: async () => [],
      makeAdopter: () => ({ adopt }),
      releaseReviewAnchor: release,
      isPidAlive: () => true,
      now: () => NOW,
    });
    expect(result.ok).toBe(false);
    expect(adopt).not.toHaveBeenCalled();
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
