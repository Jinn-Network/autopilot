// @ts-nocheck — Stage 5: deleted merge-prep/review-fix/project-status fixtures.
import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TaskSubmitRequestV1Schema } from '@jinn-network/sdk/autopilot';
import { DEFAULT_CONFIG } from '../../src/dispatcher/types.js';
import {
  makeProductionActiveRuntime,
  makeProductionCapabilityPreflight,
} from '../../src/lifecycle/active-runtime-production.js';
import {
  runLifecycleCycle,
} from '../../src/lifecycle/controller.js';
import {
  MARKETPLACE_REVIEW_UNAVAILABLE_DETAIL,
} from '../../src/lifecycle/session-execution-backend.js';
import {
  decodeCapabilityAttestation,
} from '../../src/lifecycle/capability-attestation.js';
import { CredentialPool } from '../../src/lifecycle/credentials.js';
import {
  gitOid,
  gitRefName,
} from '../../src/lifecycle/types.js';

const NOW = new Date('2026-07-20T12:00:00.000Z');

function pool(): CredentialPool {
  return new CredentialPool([{
    login: 'implementation-bot',
    normalizedLogin: 'implementation-bot',
    implementationToken: 'secret',
  }]);
}

function marketplaceRuntime(overrides: Record<string, unknown> = {}) {
  return makeProductionActiveRuntime({
    executionBackend: 'marketplace',
    repositoryPath: '/repo',
    worktreeBase: '/tmp/autopilot-marketplace-preflight-test',
    runnerId: 'runner-a',
    credentials: pool(),
    authorAllowlist: new Set(['implementation-bot']),
    readReviewSnapshot: async () => null,
    readReservedReviewSnapshot: async () => null,
    readImplementationSnapshot: async () => {
      throw new Error('implementation authority must remain untouched');
    },
    reserveReviewCohort: async () => {},
    readPullRequestByNumber: async () => null,
    readProjectItemForReconciliation: async () => null,
    readBranchHeadByName: async () => null,
    readIssueByNumber: async () => null,
    readBlockedByIssueNumbers: async () => [],
    readOpenPullRequestsByIssue: async () => [],
    readIssueActionContext: async () => {
      throw new Error('issue action context must remain untouched');
    },
    config: DEFAULT_CONFIG,
    spawn: vi.fn(() => {
      throw new Error('local spawn must remain untouched');
    }),
    caps: { implementation: 1, review: 1 },
    implementationBackpressureThreshold: 30,
    staleAfterMs: 60_000,
    repositorySlug: 'Jinn-Network/mono',
    defaultBranch: 'next',
    marketplaceTaskAdapter: {
      dryRun: vi.fn(async () => ({})),
      submit: vi.fn(async () => {
        throw new Error('marketplace submit must be explicitly configured');
      }),
      recover: vi.fn(async () => {
        throw new Error('marketplace recovery must be explicitly configured');
      }),
    },
    runner: vi.fn(async () => {
      throw new Error('runner must remain untouched');
    }),
    ...overrides,
  });
}

describe('decodeCapabilityAttestation timestamps', () => {
  it('accepts second-precision ISO-8601 timestamps', () => {
    const decoded = decodeCapabilityAttestation({
      version: 2,
      repositoryUrl: 'https://github.com/Jinn-Network/mono.git',
      remoteName: 'jinn-autopilot-v2',
      probeId: 'a'.repeat(32),
      implementerLogin: 'implementation-bot',
      verifiedAt: '2026-07-20T11:00:00Z',
      expiresAt: '2026-07-21T11:00:00Z',
      refs: {
        branch: `refs/heads/autopilot/capability-${'a'.repeat(32)}`,
        review:
          `refs/jinn-autopilot/review-claims/v1/capability-${'a'.repeat(32)}`,
      },
      proofs: {
        absentRefCreation: true,
        expectedParentRejection: true,
        ambiguousReadback: true,
        exactCleanup: true,
        readViaGitTransport: true,
      },
    }, {
      remoteName: 'jinn-autopilot-v2',
      configuredLogins: ['implementation-bot'],
      now: NOW,
    });
    expect(decoded.verifiedAt).toBe('2026-07-20T11:00:00Z');
  });

  it('rejects a non-ISO timestamp', () => {
    expect(() => decodeCapabilityAttestation({
      version: 2,
      repositoryUrl: 'https://github.com/Jinn-Network/mono.git',
      remoteName: 'jinn-autopilot-v2',
      probeId: 'a'.repeat(32),
      implementerLogin: 'implementation-bot',
      verifiedAt: '20 July 2026',
      expiresAt: '2026-07-21T11:00:00Z',
      refs: {
        branch: `refs/heads/autopilot/capability-${'a'.repeat(32)}`,
        review:
          `refs/jinn-autopilot/review-claims/v1/capability-${'a'.repeat(32)}`,
      },
      proofs: {
        absentRefCreation: true,
        expectedParentRejection: true,
        ambiguousReadback: true,
        exactCleanup: true,
        readViaGitTransport: true,
      },
    }, {
      remoteName: 'jinn-autopilot-v2',
      configuredLogins: ['implementation-bot'],
      now: NOW,
    })).toThrow('verifiedAt is invalid');
  });
});

describe('production active runtime preflight', () => {
  it('dry-runs a fresh SDK-valid temporary request on every marketplace preflight without local probes', async () => {
    const runner = vi.fn(async () => {
      throw new Error('Git probe must remain untouched');
    });
    const readCapabilityAttestation = vi.fn(() => {
      throw new Error('attestation probe must remain untouched');
    });
    const seen: Array<{ path: string; request: unknown; mode: number }> = [];
    const dryRun = vi.fn(async (path: string) => {
      expect(existsSync(path)).toBe(true);
      const request = TaskSubmitRequestV1Schema.parse(
        JSON.parse(readFileSync(path, 'utf8')),
      );
      seen.push({
        path,
        request,
        mode: statSync(path).mode & 0o777,
      });
      return {};
    });
    const ids = [
      '11111111-1111-4111-8111-111111111121',
      '11111111-1111-4111-8111-111111111122',
    ];
    const preflight = makeProductionCapabilityPreflight({
      executionBackend: 'marketplace',
      repositoryPath: '/repo',
      runnerId: 'runner-a',
      credentials: pool(),
      repositorySlug: 'Jinn-Network/mono',
      defaultBranch: 'next',
      config: {
        ...DEFAULT_CONFIG,
        runtime: 'cursor',
        cursorBin: '/missing/cursor-agent',
      },
      runner,
      readCapabilityAttestation,
      marketplaceTaskAdapter: {
        dryRun,
        submit: vi.fn(),
        recover: vi.fn(),
      },
      now: () => NOW,
      nextId: () => ids.shift()!,
    });

    await expect(preflight()).resolves.toEqual({ ok: true });
    await expect(preflight()).resolves.toEqual({ ok: true });
    expect(dryRun).toHaveBeenCalledTimes(2);
    expect(seen[0]!.path).not.toBe(seen[1]!.path);
    expect(seen.map(({ request }) => request.id)).toEqual([
      'autopilot:11111111-1111-4111-8111-111111111121',
      'autopilot:11111111-1111-4111-8111-111111111122',
    ]);
    expect(seen.map(({ mode }) => mode)).toEqual([0o600, 0o600]);
    expect(seen.every(({ path }) =>
      !existsSync(path) && !existsSync(dirname(path)))).toBe(true);
    expect(runner).not.toHaveBeenCalled();
    expect(readCapabilityAttestation).not.toHaveBeenCalled();
  });

  it.each([
    ['repository', { repositorySlug: 'Other/repository' }],
    ['language', { marketplaceLanguage: 'rust' }],
    ['verification profile', { marketplaceVerificationProfile: 'other.v1' }],
  ])(
    'rejects an unsupported marketplace %s before invoking the dry-run adapter',
    async (_label, overrides) => {
      const dryRun = vi.fn();
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
        ...overrides,
      });

      await expect(preflight()).resolves.toMatchObject({
        ok: false,
        detail: expect.stringMatching(
          /supports only Jinn-Network\/mono.*typescript.*jinn-mono\.v1/i,
        ),
      });
      expect(dryRun).not.toHaveBeenCalled();
    },
  );

  it('rejects a failed marketplace dry-run before snapshot discovery or any claim path', async () => {
    const spawn = vi.fn(() => {
      throw new Error('local spawn must remain untouched');
    });
    const readSnapshot = vi.fn(async () => {
      throw new Error('snapshot discovery must remain untouched');
    });
    const isPidAlive = vi.fn(() => {
      throw new Error('local PID probe must remain untouched');
    });
    const trackAttemptChild = vi.fn(() => {
      throw new Error('local tracking must remain untouched');
    });
    const dryRun = vi.fn(async () => {
      throw new Error('marketplace funding is unavailable');
    });
    const active = marketplaceRuntime({
      spawn,
      isPidAlive,
      trackAttemptChild,
      marketplaceTaskAdapter: {
        dryRun,
        submit: vi.fn(),
        recover: vi.fn(),
      },
    });

    await expect(runLifecycleCycle('active', {
      active,
      writer: {} as never,
      readSnapshot,
      now: () => NOW,
      staleAfterMs: 60_000,
      runnerId: 'runner-a',
      cycleId: () => 'cycle-a',
    })).resolves.toMatchObject({
      status: 'rejected',
      message:
        'active capability preflight failed: marketplace funding is unavailable',
      events: [],
    });
    expect(dryRun).toHaveBeenCalledTimes(1);
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(isPidAlive).not.toHaveBeenCalled();
    expect(trackAttemptChild).not.toHaveBeenCalled();
  });

  it('routes marketplace implementation dispatch through its backend without local spawn or tracking', async () => {
    const base = gitOid('1'.repeat(40));
    const claim = gitOid('2'.repeat(40));
    const attemptId = '11111111-1111-4111-8111-111111111123';
    const spawn = vi.fn(() => {
      throw new Error('local spawn must remain untouched');
    });
    const trackAttemptChild = vi.fn(() => {
      throw new Error('local tracking must remain untouched');
    });
    let preparation: unknown;
    const makeImplementationActionPort = vi.fn(() => ({
      readIssue: async () => ({
        number: 42,
        title: 'Wire marketplace production dispatch',
        body: '',
        open: true,
        eligible: true,
        targetBase: gitRefName('next'),
        effort: 'High',
      }),
      readStaleRecovery: async () => {
        throw new Error('not used');
      },
      runRealityCheck: async () => ({
        classification: 'clear',
        evidence: {},
        suggestedBlockedOn: null,
        suggestedComment: null,
      }),
      listOpenPullRequests: async () => [],
      readTargetBaseHead: async () => base,
      createClaimCommit: async () => claim,
      claimBranch: async (input) => ({
        status: 'won',
        expected: input.expectedRemoteHead,
        published: input.claimOid,
        observed: input.claimOid,
      }),
      ensureDraftPullRequest: async (input) => ({
        number: 84,
        headRefName: input.branch,
        head: input.claimOid,
        baseRefName: input.targetBase,
        draft: true,
        labels: [input.label],
        body: input.body,
      }),
      setProjectInProgress: async () => {},
      createAttempt: async (input) => {
        preparation = input.marketplacePreparation;
        return {
          attemptId: input.attemptId,
          paths: {
            worktree: '/attempt/marketplace-worktree',
            manifest: '/attempt/marketplace-manifest.json',
            log: '/attempt/marketplace.log',
            ghConfigDir: '/attempt/marketplace-gh',
            askpass: '/attempt/marketplace-askpass',
          },
        };
      },
      escalateHuman: async () => {},
    }));
    const start = vi.fn(async (request) => {
      expect(request).toMatchObject({
        kind: 'implementation',
        workflow: 'implementation',
        backend: 'marketplace',
        manifestPath: '/attempt/marketplace-manifest.json',
      });
      expect(request).not.toHaveProperty('local');
      return {
        status: 'started',
        backend: 'marketplace',
        id: `autopilot:${attemptId}`,
        taskId: 'task-42',
        taskCid: 'bafy-task-42',
      };
    });
    const active = marketplaceRuntime({
      spawn,
      trackAttemptChild,
      makeImplementationActionPort,
      marketplaceExecutionBackend: { start },
      nextId: () => attemptId,
      now: () => NOW,
      environment: {},
      repositoryUrl: 'https://github.com/Jinn-Network/mono.git',
    });

    await expect(active.executeAction({
      kind: 'claim-implementation',
      intent: 'fresh',
      issueNumber: 42,
    }, {} as never)).resolves.toEqual({ outcome: 'spawned' });
    expect(TaskSubmitRequestV1Schema.parse(preparation.request))
      .toEqual(preparation.request);
    expect(preparation.request.spec.session.taskSnapshot.body).toBe('');
    expect(preparation.request.spec.problem_statement)
      .toBe('Wire marketplace production dispatch');
    expect(start).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(trackAttemptChild).not.toHaveBeenCalled();
  });

  it('returns a stable unavailable marketplace exact-head review without acquisition reads or local spawn', async () => {
    const spawn = vi.fn(() => {
      throw new Error('local spawn must remain untouched');
    });
    const readReviewSnapshot = vi.fn(async () => {
      throw new Error('review authority must remain untouched');
    });
    const trackAttemptChild = vi.fn(() => {
      throw new Error('local tracking must remain untouched');
    });
    const active = marketplaceRuntime({
      spawn,
      readReviewSnapshot,
      trackAttemptChild,
    });

    await expect(active.executeAction({
      kind: 'claim-review',
      issueNumber: 42,
      prNumber: 84,
      head: '1'.repeat(40),
    }, {} as never)).resolves.toEqual({
      outcome: 'unavailable',
      reason: MARKETPLACE_REVIEW_UNAVAILABLE_DETAIL,
    });
    expect(readReviewSnapshot).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(trackAttemptChild).not.toHaveBeenCalled();
  });

  it('rejects an unsupported marketplace repository before implementation authority reads or claims', async () => {
    const readIssue = vi.fn(async () => {
      throw new Error('implementation authority must remain untouched');
    });
    const makeImplementationActionPort = vi.fn(() => ({
      readIssue,
    }));
    const start = vi.fn();
    const active = marketplaceRuntime({
      repositorySlug: 'Other/repository',
      makeImplementationActionPort,
      marketplaceExecutionBackend: { start },
    });

    await expect(active.executeAction({
      kind: 'claim-implementation',
      intent: 'fresh',
      issueNumber: 42,
    }, {} as never)).rejects.toThrow(
      /supports only Jinn-Network\/mono.*typescript.*jinn-mono\.v1/i,
    );
    expect(readIssue).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('binds local implementation dispatch through the production backend composition', async () => {
    const base = gitOid('1'.repeat(40));
    const claim = gitOid('2'.repeat(40));
    const attemptId = '11111111-1111-4111-8111-111111111111';
    const events: string[] = [];
    const child = {
      get pid() {
        events.push('pid');
        return 4242;
      },
      once: vi.fn(),
    };
    const spawn = vi.fn((_command, args) => {
      events.push('spawn');
      expect(args.join('\n')).toContain('Use the implement-issue skill on issue #42.');
      return child;
    });
    const trackAttemptChild = vi.fn((manifestPath, trackedChild) => {
      events.push('track');
      expect(manifestPath).toBe('/attempt/implementation-manifest.json');
      expect(trackedChild).toBe(child);
    });
    const makeImplementationActionPort = vi.fn(() => ({
      readIssue: async () => ({
        number: 42,
        title: 'Wire the local production backend',
        open: true,
        eligible: true,
        targetBase: gitRefName('next'),
        effort: 'High',
      }),
      readStaleRecovery: async () => {
        throw new Error('not used');
      },
      runRealityCheck: async () => ({
        classification: 'clear',
        evidence: {},
        suggestedBlockedOn: null,
        suggestedComment: null,
      }),
      listOpenPullRequests: async () => [],
      readTargetBaseHead: async () => base,
      createClaimCommit: async () => claim,
      claimBranch: async (input) => ({
        status: 'won',
        expected: input.expectedRemoteHead,
        published: input.claimOid,
        observed: input.claimOid,
      }),
      ensureDraftPullRequest: async (input) => ({
        number: 84,
        headRefName: input.branch,
        head: input.claimOid,
        baseRefName: input.targetBase,
        draft: true,
        labels: [input.label],
        body: input.body,
      }),
      setProjectInProgress: async () => {},
      createAttempt: async (input) => {
        events.push('attempt');
        return {
          attemptId: input.attemptId,
          paths: {
            worktree: '/attempt/implementation-worktree',
            manifest: '/attempt/implementation-manifest.json',
            log: '/attempt/implementation.log',
            ghConfigDir: '/attempt/implementation-gh',
            askpass: '/attempt/implementation-askpass',
          },
        };
      },
      escalateHuman: async () => {},
    }));
    const active = marketplaceRuntime({
      executionBackend: 'local',
      environment: {},
      repositoryUrl: 'https://github.com/Jinn-Network/mono.git',
      makeImplementationActionPort,
      spawn,
      trackAttemptChild,
      nextId: () => attemptId,
    });

    await expect(active.executeAction({
      kind: 'claim-implementation',
      intent: 'fresh',
      issueNumber: 42,
    }, {} as never)).resolves.toEqual({ outcome: 'spawned' });
    expect(makeImplementationActionPort).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(trackAttemptChild).toHaveBeenCalledTimes(1);
    expect(events.slice(0, 2)).toEqual(['attempt', 'spawn']);
    expect(events.indexOf('pid')).toBeLessThan(events.indexOf('track'));
  });

  it('binds exact-head review dispatch through the production backend composition', async () => {
    const head = gitOid('3'.repeat(40));
    const recordOid = gitOid('4'.repeat(40));
    const attemptId = '22222222-2222-4222-8222-222222222222';
    const generation = '33333333-3333-4333-8333-333333333333';
    const events: string[] = [];
    const candidate = {
      issueNumber: 42,
      number: 84,
      open: true,
      head,
      headChangedAt: '2026-07-20T08:00:00.000Z',
      headRefName: gitRefName('autopilot/42'),
      baseRefName: gitRefName('next'),
      draft: false,
      author: 'implementation-bot',
      labels: ['engine:review'],
      body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
      humanHold: false,
      approvalPolicy: 'approve-eligible',
      nativeReviews: [],
    };
    let reviewRecord: unknown;
    const child = {
      get pid() {
        events.push('pid');
        return 4343;
      },
      once: vi.fn(),
    };
    const spawn = vi.fn((_command, args) => {
      events.push('spawn');
      expect(args.join('\n')).toContain('Use the review-pr skill on PR #84');
      return child;
    });
    const trackAttemptChild = vi.fn((manifestPath, trackedChild) => {
      events.push('track');
      expect(manifestPath).toBe('/attempt/review-manifest.json');
      expect(trackedChild).toBe(child);
    });
    const makeReviewActionPort = vi.fn(() => ({
      readCandidate: async () => candidate,
      confirmAcquisition: async () => ({
        ...candidate,
        reviewRef: { oid: recordOid, record: reviewRecord },
      }),
      createReviewRecord: async ({ record }) => {
        reviewRecord = record;
        return recordOid;
      },
      publishReviewClaim: async ({ expectedRemoteRecordOid, recordOid: published }) => ({
        status: 'won',
        expected: expectedRemoteRecordOid,
        published,
        observed: published,
      }),
      createAttempt: async (input) => ({
        attemptId: input.attemptId,
        paths: {
          worktree: '/attempt/review-worktree',
          manifest: '/attempt/review-manifest.json',
          log: '/attempt/review.log',
          ghConfigDir: '/attempt/review-gh',
          askpass: '/attempt/review-askpass',
        },
      }),
      repairProjection: async () => {},
      escalateHuman: async () => {},
    }));
    const active = marketplaceRuntime({
      executionBackend: 'local',
      environment: {},
      credentials: new CredentialPool([{
        login: 'implementation-bot',
        normalizedLogin: 'implementation-bot',
        implementationToken: 'implementation-secret',
      }, {
        login: 'review-bot',
        normalizedLogin: 'review-bot',
        reviewToken: 'review-secret',
      }]),
      makeReviewActionPort,
      spawn,
      trackAttemptChild,
      nextId: vi.fn()
        .mockReturnValueOnce(attemptId)
        .mockReturnValueOnce(generation),
    });

    await expect(active.executeAction({
      kind: 'claim-review',
      issueNumber: 42,
      prNumber: 84,
      head,
    }, {} as never)).resolves.toEqual({ outcome: 'spawned' });
    expect(makeReviewActionPort).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(trackAttemptChild).toHaveBeenCalledTimes(1);
    expect(events[0]).toBe('spawn');
    expect(events.indexOf('pid')).toBeLessThan(events.indexOf('track'));
  });

  it('rejects active mode when no live capability attestation is configured', async () => {
    const preflight = makeProductionCapabilityPreflight({
      repositoryPath: '/repo',
      credentials: pool(),
      config: DEFAULT_CONFIG,
      runner: async () => 'https://github.com/Jinn-Network/mono.git\n',
    });

    await expect(preflight()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining(
        'JINN_AUTOPILOT_CAPABILITY_ATTESTATION',
      ),
    });
  });

  it('requires the dedicated canonical HTTPS remote without mutating local Git config', async () => {
    const calls: string[][] = [];
    const attestation = (
      expected: Parameters<typeof decodeCapabilityAttestation>[1],
    ) => decodeCapabilityAttestation({
      version: 2,
      repositoryUrl: 'https://github.com/Jinn-Network/mono.git',
      remoteName: 'jinn-autopilot-v2',
      probeId: 'a'.repeat(32),
      implementerLogin: 'implementation-bot',
      verifiedAt: '2026-07-20T11:00:00.000Z',
      expiresAt: '2026-07-21T11:00:00.000Z',
      refs: {
        branch: `refs/heads/autopilot/capability-${'a'.repeat(32)}`,
        review:
          `refs/jinn-autopilot/review-claims/v1/capability-${'a'.repeat(32)}`,
      },
      proofs: {
        absentRefCreation: true,
        expectedParentRejection: true,
        ambiguousReadback: true,
        exactCleanup: true,
        readViaGitTransport: true,
      },
    }, expected);
    const accepted = makeProductionCapabilityPreflight({
      repositoryPath: '/repo',
      credentials: pool(),
      config: DEFAULT_CONFIG,
      environment: {
        JINN_AUTOPILOT_CAPABILITY_ATTESTATION: '/attestation.json',
      },
      now: () => NOW,
      readCapabilityAttestation: (_path, expected) => attestation(expected),
      runner: async (command, args) => {
        expect(command).toBe('git');
        calls.push(args);
        return 'https://github.com/Jinn-Network/mono.git\n';
      },
    });
    await expect(accepted()).resolves.toEqual({ ok: true });
    await expect(accepted()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      '-C', '/repo', 'remote', 'get-url', 'jinn-autopilot-v2',
    ]);

    const rejected = makeProductionCapabilityPreflight({
      repositoryPath: '/repo',
      credentials: pool(),
      config: DEFAULT_CONFIG,
      environment: {
        JINN_AUTOPILOT_CAPABILITY_ATTESTATION: '/attestation.json',
      },
      now: () => NOW,
      readCapabilityAttestation: (_path, expected) => attestation(expected),
      runner: async () => 'git@example.invalid:Jinn-Network/mono.git\n',
    });
    await expect(rejected()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining('canonical HTTPS'),
    });
  });

  it('fails closed when Cursor runtime probe cannot find the agent binary', async () => {
    const attestation = (
      expected: Parameters<typeof decodeCapabilityAttestation>[1],
    ) => decodeCapabilityAttestation({
      version: 2,
      repositoryUrl: 'https://github.com/Jinn-Network/mono.git',
      remoteName: 'jinn-autopilot-v2',
      probeId: 'a'.repeat(32),
      implementerLogin: 'implementation-bot',
      verifiedAt: '2026-07-20T11:00:00.000Z',
      expiresAt: '2026-07-21T11:00:00.000Z',
      refs: {
        branch: `refs/heads/autopilot/capability-${'a'.repeat(32)}`,
        review:
          `refs/jinn-autopilot/review-claims/v1/capability-${'a'.repeat(32)}`,
      },
      proofs: {
        absentRefCreation: true,
        expectedParentRejection: true,
        ambiguousReadback: true,
        exactCleanup: true,
        readViaGitTransport: true,
      },
    }, expected);

    const preflight = makeProductionCapabilityPreflight({
      repositoryPath: '/repo',
      credentials: pool(),
      config: {
        ...DEFAULT_CONFIG,
        runtime: 'cursor',
        cursorBin: '/missing/cursor-agent',
      },
      environment: {
        JINN_AUTOPILOT_CAPABILITY_ATTESTATION: '/attestation.json',
      },
      now: () => NOW,
      readCapabilityAttestation: (_path, expected) => attestation(expected),
      runner: async () => 'https://github.com/Jinn-Network/mono.git\n',
    });

    await expect(preflight()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringMatching(/Cursor Agent CLI is missing|Cursor runtime probe failed/i),
    });
  });
});
