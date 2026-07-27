// @ts-nocheck — Stage 5: deleted merge-prep/review-fix/project-status fixtures.
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/dispatcher/types.js';
import {
  makeProductionActiveRuntime,
  makeProductionCapabilityPreflight,
} from '../../src/lifecycle/active-runtime-production.js';
import {
  runLifecycleCycle,
} from '../../src/lifecycle/controller.js';
import {
  MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL,
} from '../../src/lifecycle/session-execution-backend.js';
import {
  decodeCapabilityAttestation,
} from '../../src/lifecycle/capability-attestation.js';
import { CredentialPool } from '../../src/lifecycle/credentials.js';
import {
  decodeReviewClaimPayload,
  encodeReviewClaimPayload,
  mappingDiagnosticSignature,
} from '../../src/lifecycle/codecs.js';
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
  it('rejects marketplace execution before Git, credentials, attestation, or local runtime probes', async () => {
    const runner = vi.fn(async () => {
      throw new Error('Git probe must remain untouched');
    });
    const readCapabilityAttestation = vi.fn(() => {
      throw new Error('attestation probe must remain untouched');
    });
    const credentials = {
      logins: vi.fn(() => {
        throw new Error('credential probe must remain untouched');
      }),
    };
    const preflight = makeProductionCapabilityPreflight({
      executionBackend: 'marketplace',
      repositoryPath: '/repo',
      credentials,
      config: {
        ...DEFAULT_CONFIG,
        runtime: 'cursor',
        cursorBin: '/missing/cursor-agent',
      },
      runner,
      readCapabilityAttestation,
    });

    await expect(preflight()).resolves.toEqual({
      ok: false,
      detail: MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(readCapabilityAttestation).not.toHaveBeenCalled();
    expect(credentials.logins).not.toHaveBeenCalled();
  });

  it('rejects a marketplace production cycle before snapshot discovery or any claim path', async () => {
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
    const active = marketplaceRuntime({
      spawn,
      isPidAlive,
      trackAttemptChild,
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
        `active capability preflight failed: ${MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL}`,
      events: [],
    });
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(isPidAlive).not.toHaveBeenCalled();
    expect(trackAttemptChild).not.toHaveBeenCalled();
  });

  it('fails a direct marketplace implementation dispatch before authority reads or local spawn', async () => {
    const spawn = vi.fn(() => {
      throw new Error('local spawn must remain untouched');
    });
    const readImplementationSnapshot = vi.fn(async () => {
      throw new Error('implementation authority must remain untouched');
    });
    const trackAttemptChild = vi.fn(() => {
      throw new Error('local tracking must remain untouched');
    });
    const active = marketplaceRuntime({
      spawn,
      readImplementationSnapshot,
      trackAttemptChild,
    });

    await expect(active.executeAction({
      kind: 'claim-implementation',
      intent: 'fresh',
      issueNumber: 42,
    }, {} as never)).rejects.toThrow(MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL);
    expect(readImplementationSnapshot).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(trackAttemptChild).not.toHaveBeenCalled();
  });

  it('fails a direct marketplace exact-head review before acquisition reads or local spawn', async () => {
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
    }, {} as never)).rejects.toThrow(MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL);
    expect(readReviewSnapshot).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(trackAttemptChild).not.toHaveBeenCalled();
  });

  it('guards direct marketplace dispatch before credential and full-capacity local-state reads', async () => {
    const credentials = {
      logins: vi.fn(() => {
        throw new Error('credential/local-state probe must remain untouched');
      }),
    };
    const active = marketplaceRuntime({
      credentials,
      caps: { implementation: 0, review: 0 },
    });

    await expect(active.executeAction({
      kind: 'claim-implementation',
      intent: 'fresh',
      issueNumber: 42,
    }, {} as never)).rejects.toThrow(MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL);
    await expect(active.executeReviewActions!([{
      kind: 'claim-review',
      issueNumber: 42,
      prNumber: 84,
      head: '1'.repeat(40),
    }], {} as never)).rejects.toThrow(MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL);
    expect(credentials.logins).not.toHaveBeenCalled();
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

  it('uses only the fresh canonical diagnostic to publish a mapping reread', async () => {
    const head = gitOid('3'.repeat(40));
    const acquisitionOids = [
      gitOid('4'.repeat(40)),
      gitOid('5'.repeat(40)),
      gitOid('6'.repeat(40)),
      gitOid('7'.repeat(40)),
      gitOid('9'.repeat(40)),
      gitOid('a'.repeat(40)),
      gitOid('b'.repeat(40)),
    ];
    const generation = '33333333-3333-4333-8333-333333333333';
    const attempt = '44444444-4444-4444-8444-444444444444';
    const resolvedGeneration = '55555555-5555-4555-8555-555555555555';
    const resolvedAttempt = '66666666-6666-4666-8666-666666666666';
    const mappingDetails = [
      'Closing-reference mapping is duplicated or names multiple issues.',
      'PR evidence does not resolve to one known lifecycle issue.',
    ];
    const diagnosticDetail =
      'Ambiguous lifecycle mapping between issue(s) #42, #43 and PR(s) #84: '
      + mappingDetails.join('; ');
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
      body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
      humanHold: false,
      approvalPolicy: 'approve-eligible',
      nativeReviews: [],
      mappingProblem: mappingDetails.join(' '),
    };
    const diagnosticSignature = mappingDiagnosticSignature({
      issueNumbers: [42, 43],
      detail: diagnosticDetail,
    });
    let reviewClaim: { oid: string; payload: string } | null = null;
    const comments: string[] = [];
    const sharedMutations: string[] = [];
    const events: string[] = [];
    const liveSnapshot = {
      snapshotComplete: true,
      capturedAt: '2026-07-20T12:00:00.000Z',
      project: {
        items: [42, 43].map((number) => ({
          id: `PVTI_${number}`,
          number,
          contentType: 'Issue',
          status: 'In Review',
          priority: 'P1',
          effort: 'Medium',
          blockedOn: 'Nothing',
          issueType: 'feat',
          blockedByIssues: [],
          sprintIterationId: null,
        })),
        rateLimit: { remaining: 4_000, used: 1, resetAt: '2026-07-20T13:00:00.000Z' },
        currentSprintIterationId: null,
      },
      issues: [
        {
          number: 42,
          title: 'first',
          shape: 'feat',
          blockedOn: 'Nothing',
          blockedByIssues: [],
          effort: 'Medium',
          priority: 'P1',
          status: 'In Review',
          onBoard: true,
          author: 'implementation-bot',
          projectItemId: 'PVTI_42',
          inCurrentSprint: false,
        },
        {
          number: 43,
          title: 'second',
          shape: 'feat',
          blockedOn: 'Nothing',
          blockedByIssues: [],
          effort: 'Medium',
          priority: 'P1',
          status: 'In Review',
          onBoard: true,
          author: 'implementation-bot',
          projectItemId: 'PVTI_43',
          inCurrentSprint: false,
        },
      ],
      branches: [],
      lifecycle: { items: [] },
      pullRequests: [{
        number: 84,
        title: 'ambiguous',
        body: candidate.body,
        author: candidate.author,
        baseRefName: candidate.baseRefName,
        headRefName: candidate.headRefName,
        headOid: head,
        headCommittedAt: candidate.headChangedAt,
        isDraft: false,
        state: 'OPEN',
        labels: ['engine:review'],
        closingIssueNumbers: [42, 43],
        mergeability: 'UNKNOWN',
        mergeStateStatus: 'BLOCKED',
        checks: [],
        reviews: [],
      }],
      pullRequestMappings: [{
        status: 'ambiguous',
        prNumber: 84,
        issueNumbers: [42, 43],
        details: mappingDetails,
      }],
      diagnostics: [{
        code: 'branch-mapping-ambiguous',
        detail: diagnosticDetail,
        issueNumbers: [42, 43],
        signature: diagnosticSignature,
        issues: [
          { number: 42, projectStatus: 'In Review' },
          { number: 43, projectStatus: 'In Review' },
        ],
        pullRequests: [{
          number: 84,
          head,
          draft: false,
          labels: ['engine:review'],
        }],
      }],
    };
    const cycleSnapshot = {
      ...liveSnapshot,
      pullRequests: [{
        ...liveSnapshot.pullRequests[0],
        closingIssueNumbers: [42],
      }],
      pullRequestMappings: [{
        status: 'resolved',
        prNumber: 84,
        issueNumber: 42,
        expectedBaseRefName: 'next',
        evidence: 'closing-reference',
      }],
      diagnostics: [],
    };
    let freshSnapshot = liveSnapshot;
    const acquisitionRecords = new Map<string, unknown>();
    let acquisitionCount = 0;
    const makeReviewActionPort = vi.fn(() => ({
      readCandidate: async () => candidate,
      createReviewRecord: async ({ record }) => {
        events.push(`record:${record.state}`);
        const oid = acquisitionOids[acquisitionCount++]!;
        acquisitionRecords.set(oid, record);
        return oid;
      },
      publishReviewClaim: async ({ recordOid, expectedRemoteRecordOid }) => {
        const record = acquisitionRecords.get(recordOid);
        if (record === undefined) throw new Error('missing acquisition record');
        reviewClaim = {
          oid: recordOid,
          payload: encodeReviewClaimPayload(record),
        };
        events.push(`claim:${record.state}`);
        return {
          status: 'won',
          expected: expectedRemoteRecordOid,
          published: recordOid,
          observed: recordOid,
        };
      },
    }));
    let liveLabels = ['engine:review'];
    let liveEvidenceIncompleteReason: string | undefined;
    const readPullRequestByNumber = async () => ({
      state: 'OPEN',
      headRefName: candidate.headRefName,
      headOid: head,
      baseRefName: candidate.baseRefName,
      isDraft: false,
      labels: liveLabels,
      body: candidate.body,
      closingIssueNumbers: [42, 43],
      humanIssueNumber: null,
      humanReason: null,
      reviewClaim,
      ...(liveEvidenceIncompleteReason === undefined
        ? {}
        : { evidenceIncompleteReason: liveEvidenceIncompleteReason }),
    });
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
      readPullRequestByNumber,
      readReviewSnapshot: async () => freshSnapshot,
      readProjectItemForReconciliation: async (number) => ({
        id: `PVTI_${number}`,
        status: 'In Review',
        blockedOn: 'Nothing',
      }),
      readIssueByNumber: async (number) => ({
        number,
        title: number === 42 ? 'first' : 'second',
        open: true,
        author: 'implementation-bot',
        labels: [],
      }),
      readBlockedByIssueNumbers: async () => [],
      nextId: vi.fn()
        .mockReturnValueOnce(generation)
        .mockReturnValueOnce(attempt)
        .mockReturnValueOnce(resolvedGeneration)
        .mockReturnValueOnce(resolvedAttempt),
      now: () => NOW,
      runner: async (_command, args) => {
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    });

    await expect(active.executeAction({
      kind: 'claim-review',
      issueNumber: 42,
      prNumber: 84,
      head,
    }, cycleSnapshot)).resolves.toEqual({ outcome: 'human' });

    expect(reviewClaim).not.toBeNull();
    expect(decodeReviewClaimPayload(reviewClaim!.payload)).toMatchObject({
      state: 'mapping-reread',
      mappingRequest: {
        selectedIssueNumber: 42,
        headRefName: 'autopilot/42',
        baseRefName: 'next',
      },
    });
    expect(comments).toEqual([]);
    expect(events).toEqual([
      'record:active',
      'claim:active',
      'record:mapping-reread',
      'claim:mapping-reread',
    ]);
    expect(sharedMutations).toEqual([]);

    reviewClaim = null;
    freshSnapshot = cycleSnapshot;
    comments.length = 0;
    events.length = 0;
    sharedMutations.length = 0;

    await expect(active.executeAction({
      kind: 'claim-review',
      issueNumber: 42,
      prNumber: 84,
      head,
    }, cycleSnapshot)).resolves.toEqual({ outcome: 'human' });

    expect(reviewClaim).toBeNull();
    expect(comments).toEqual([]);
    expect(events).toEqual([]);
    expect(sharedMutations).toEqual([]);

    const retainedOid = gitOid('8'.repeat(40));
    const retainedRecord = {
      kind: 'review-claim' as const,
      protocolVersion: 2 as const,
      prNumber: 84,
      generation,
      attempt,
      reviewer: 'review-bot',
      head,
      state: 'active' as const,
      recordedAt: '2026-07-20T11:00:00.000Z',
    };
    const externalAuthorityObservations: Array<{
      readonly name: string;
      readonly reviewClaim: typeof reviewClaim;
      readonly events: readonly string[];
      readonly comments: readonly string[];
      readonly sharedMutations: readonly string[];
    }> = [];
    for (const authority of [
      {
        name: 'PR Human label',
        labels: ['engine:review', 'review:needs-human'],
        issueLabels: [] as string[],
        blockedOn: 'Nothing' as const,
      },
      {
        name: 'issue Human label',
        labels: ['engine:review'],
        issueLabels: ['autopilot:human'],
        blockedOn: 'Nothing' as const,
      },
      {
        name: 'Project Blocked on Human',
        labels: ['engine:review'],
        issueLabels: [] as string[],
        blockedOn: 'Human' as const,
      },
    ]) {
      reviewClaim = {
        oid: retainedOid,
        payload: encodeReviewClaimPayload(retainedRecord),
      };
      liveLabels = authority.labels;
      freshSnapshot = {
        ...liveSnapshot,
        pullRequests: [{
          ...liveSnapshot.pullRequests[0],
          labels: authority.labels,
        }],
        issues: liveSnapshot.issues.map((issue) => (
          issue.number === 42
            ? {
                ...issue,
                labels: authority.issueLabels,
                blockedOn: authority.blockedOn,
              }
            : issue
        )),
        project: {
          ...liveSnapshot.project,
          items: liveSnapshot.project.items.map((item) => (
            item.number === 42
              ? { ...item, blockedOn: authority.blockedOn }
              : item
          )),
        },
      };
      events.length = 0;
      comments.length = 0;
      sharedMutations.length = 0;

      await expect(active.executeAction({
        kind: 'claim-review',
        issueNumber: 42,
        prNumber: 84,
        head,
      }, cycleSnapshot), authority.name).resolves.toEqual({ outcome: 'human' });
      externalAuthorityObservations.push({
        name: authority.name,
        reviewClaim,
        events: [...events],
        comments: [...comments],
        sharedMutations: [...sharedMutations],
      });
    }
    expect(externalAuthorityObservations).toEqual([
      'PR Human label',
      'issue Human label',
      'Project Blocked on Human',
    ].map((name) => ({
      name,
      reviewClaim: {
        oid: retainedOid,
        payload: encodeReviewClaimPayload(retainedRecord),
      },
      events: [],
      comments: [],
      sharedMutations: [],
    })));

    reviewClaim = {
      oid: retainedOid,
      payload: encodeReviewClaimPayload(retainedRecord),
    };
    liveLabels = ['engine:review'];
    liveEvidenceIncompleteReason = 'PR #84 labels were truncated';
    freshSnapshot = liveSnapshot;
    events.length = 0;
    comments.length = 0;
    sharedMutations.length = 0;

    await expect(active.executeAction({
      kind: 'claim-review',
      issueNumber: 42,
      prNumber: 84,
      head,
    }, cycleSnapshot)).rejects.toThrow(/evidence.*incomplete/i);

    expect(reviewClaim).toEqual({
      oid: retainedOid,
      payload: encodeReviewClaimPayload(retainedRecord),
    });
    expect(events).toEqual([]);
    expect(comments).toEqual([]);
    expect(sharedMutations).toEqual([]);
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
