import { describe, expect, it, vi } from 'vitest';
import {
  LocalSessionExecutionBackend,
  MarketplaceSessionExecutionBackend,
  MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL,
  type LocalSessionExecutionRequest,
} from '../../src/lifecycle/session-execution-backend.js';

const implementationRequest = (): LocalSessionExecutionRequest => ({
  kind: 'implementation',
  manifestPath: '/attempts/implementation/manifest.json',
  attemptId: 'attempt-implementation',
  issueNumber: 42,
  prNumber: 43,
  branch: 'autopilot/42',
  targetBase: 'next',
  worktreePath: '/worktrees/42',
  logPath: '/logs/42.log',
  local: {
    spawnInput: {
      attemptId: 'attempt-implementation',
      issue: {
        number: 42,
        title: 'Add the backend seam',
        open: true,
        eligible: true,
        targetBase: 'next',
        effort: null,
      },
      prNumber: 43,
      branch: 'autopilot/42',
      targetBase: 'next',
      environment: { GH_TOKEN: 'local-only-test-token' },
      worktreePath: '/worktrees/42',
      logPath: '/logs/42.log',
    },
  },
});

const reviewRequest = (): LocalSessionExecutionRequest => ({
  kind: 'exact-head-review',
  manifestPath: '/attempts/review/manifest.json',
  attemptId: 'attempt-review',
  issueNumber: 42,
  prNumber: 43,
  branch: 'autopilot/42',
  targetBase: 'next',
  worktreePath: '/worktrees/42',
  logPath: '/logs/42.log',
  local: {
    spawnInput: {
      attemptId: 'attempt-review',
      candidate: {
        issueNumber: 42,
        number: 43,
        open: true,
        head: 'a'.repeat(40),
        headChangedAt: '2026-07-26T12:00:00.000Z',
        headRefName: 'autopilot/42',
        baseRefName: 'next',
        draft: false,
        author: 'octocat',
        labels: [],
        body: '',
        humanHold: false,
        approvalPolicy: 'single-approval',
        nativeReviews: [],
      },
      environment: { GH_TOKEN: 'local-only-test-token' },
      worktreePath: '/worktrees/42',
      logPath: '/logs/42.log',
    },
  },
});

describe('session execution backends', () => {
  it('local start tracks a spawned implementation child only after validating its PID', async () => {
    const child = { pid: 1234 };
    const spawnImplementation = vi.fn(() => child);
    const trackChild = vi.fn();
    const backend = new LocalSessionExecutionBackend({
      spawnImplementation,
      spawnExactHeadReview: vi.fn(),
      trackChild,
    });

    await expect(backend.start(implementationRequest())).resolves.toEqual({
      status: 'started',
      backend: 'local',
      pid: 1234,
    });
    expect(spawnImplementation).toHaveBeenCalledWith(
      implementationRequest().local.spawnInput,
    );
    expect(trackChild).toHaveBeenCalledWith(
      '/attempts/implementation/manifest.json',
      child,
    );
  });

  it('local start rejects a missing PID before tracking an exact-head review child', async () => {
    const trackChild = vi.fn();
    const backend = new LocalSessionExecutionBackend({
      spawnImplementation: vi.fn(),
      spawnExactHeadReview: vi.fn(() => ({ pid: undefined })),
      trackChild,
    });

    await expect(backend.start(reviewRequest())).rejects.toThrow(
      'Review coordinator did not report a child PID',
    );
    expect(trackChild).not.toHaveBeenCalled();
  });

  it('reports existing local recovery and cancellation as unsupported rather than inventing control behavior', async () => {
    const backend = new LocalSessionExecutionBackend({
      spawnImplementation: vi.fn(),
      spawnExactHeadReview: vi.fn(),
      trackChild: vi.fn(),
    });

    await expect(backend.recover(implementationRequest())).resolves.toEqual({
      status: 'unsupported',
      backend: 'local',
      operation: 'recover',
    });
    await expect(backend.cancel(reviewRequest())).resolves.toEqual({
      status: 'unsupported',
      backend: 'local',
      operation: 'cancel',
    });
  });

  it('marketplace never calls local execution capabilities and reports its stable foundation outcome', async () => {
    const backend = new MarketplaceSessionExecutionBackend();
    const request = implementationRequest();
    const marketplaceRequest = {
      kind: request.kind,
      manifestPath: request.manifestPath,
      attemptId: request.attemptId,
      issueNumber: request.issueNumber,
      prNumber: request.prNumber,
      branch: request.branch,
      targetBase: request.targetBase,
      worktreePath: request.worktreePath,
      logPath: request.logPath,
    } as const;

    await expect(backend.start(marketplaceRequest)).resolves.toEqual({
      status: 'unavailable',
      backend: 'marketplace',
      detail: MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL,
    });
    await expect(backend.recover(marketplaceRequest)).resolves.toEqual({
      status: 'unavailable',
      backend: 'marketplace',
      detail: MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL,
    });
    await expect(backend.cancel(marketplaceRequest)).resolves.toEqual({
      status: 'unavailable',
      backend: 'marketplace',
      detail: MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL,
    });
  });
});
