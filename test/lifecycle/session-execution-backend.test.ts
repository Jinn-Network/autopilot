import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  LocalSessionExecutionBackend,
  MarketplaceSessionExecutionBackend,
  MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL,
  type LocalSessionExecutionRequest,
  type MarketplaceSessionExecutionRequest,
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
  backend: 'local',
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
  backend: 'local',
  reviewedHead: 'a'.repeat(40),
  reviewerLogin: 'review-bot',
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
  it('local implementation start orders spawn, PID validation, and tracking without invoking review spawn', async () => {
    const events: string[] = [];
    const child = {
      get pid() {
        events.push('pid');
        return 1234;
      },
    };
    const spawnImplementation = vi.fn(() => {
      events.push('spawn');
      return child;
    });
    const spawnExactHeadReview = vi.fn();
    const trackChild = vi.fn((_manifestPath: string, _child: typeof child) => {
      events.push('track');
    });
    const backend = new LocalSessionExecutionBackend({
      spawnImplementation,
      spawnExactHeadReview,
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
    expect(trackChild).toHaveBeenCalledTimes(1);
    expect(trackChild.mock.calls[0]?.[0]).toBe('/attempts/implementation/manifest.json');
    expect(trackChild.mock.calls[0]?.[1]).toBe(child);
    expect(spawnExactHeadReview).not.toHaveBeenCalled();
    expect(events).toEqual(['spawn', 'pid', 'track', 'pid']);
  });

  it('local review start orders spawn, PID validation, and tracking without invoking implementation spawn', async () => {
    const events: string[] = [];
    const child = {
      get pid() {
        events.push('pid');
        return 5678;
      },
    };
    const spawnImplementation = vi.fn();
    const spawnExactHeadReview = vi.fn(() => {
      events.push('spawn');
      return child;
    });
    const trackChild = vi.fn(() => { events.push('track'); });
    const backend = new LocalSessionExecutionBackend({
      spawnImplementation,
      spawnExactHeadReview,
      trackChild,
    });

    await expect(backend.start(reviewRequest())).resolves.toEqual({
      status: 'started',
      backend: 'local',
      pid: 5678,
    });
    expect(spawnImplementation).not.toHaveBeenCalled();
    expect(events).toEqual(['spawn', 'pid', 'track', 'pid']);
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
    const marketplaceRequest: MarketplaceSessionExecutionRequest = {
      kind: 'implementation',
      manifestPath: '/attempts/implementation/manifest.json',
      attemptId: 'attempt-implementation',
      issueNumber: 42,
      prNumber: 43,
      branch: 'autopilot/42',
      targetBase: 'next',
      worktreePath: '/worktrees/42',
      logPath: '/logs/42.log',
      backend: 'marketplace',
    };

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

  it('uses a backend discriminator that keeps local launch input out of marketplace methods', () => {
    const marketplace = new MarketplaceSessionExecutionBackend();
    const local = new LocalSessionExecutionBackend({
      spawnImplementation: vi.fn(),
      spawnExactHeadReview: vi.fn(),
      trackChild: vi.fn(),
    });
    expectTypeOf<LocalSessionExecutionRequest>()
      .not.toMatchTypeOf<Parameters<typeof marketplace.start>[0]>();
    expectTypeOf<Parameters<typeof marketplace.start>[0]>()
      .toMatchTypeOf<MarketplaceSessionExecutionRequest>();
    expectTypeOf<MarketplaceSessionExecutionRequest>()
      .not.toMatchTypeOf<Parameters<typeof local.start>[0]>();
  });
});
