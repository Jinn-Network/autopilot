import { describe, expect, it, vi } from 'vitest';
import {
  makeTargetedActionReader,
  targetedAuthorityRefusalDetail,
  targetedAuthoritySnapshot as snapshotOf,
} from '../../src/lifecycle/targeted-action-reader.js';
import { GitHubRateLimitReserveError } from '../../src/lifecycle/github-usage.js';
import {
  makeProductionImplementationActionPort,
} from '../../src/lifecycle/implementation-executor-production.js';
import {
  executeImplementationAction,
  type ImplementationExecutorDeps,
} from '../../src/lifecycle/implementation-executor.js';
import { encodeBranchClaimTrailers } from '../../src/lifecycle/codecs.js';
import { CredentialPool } from '../../src/lifecycle/credentials.js';
import { gitOid, gitRefName } from '../../src/lifecycle/types.js';
import {
  selfClaimHeadTransition,
  type SelfClaimHeadTransition,
} from '../../src/lifecycle/self-claim-transition.js';
import type {
  GitHubLifecycleSnapshot,
  RawPullRequest,
} from '../../src/lifecycle/snapshot.js';
import { decodePullRequestSnapshot } from '../../src/lifecycle/snapshot.js';

const HEAD = 'a'.repeat(40);
const BLOCKER_HEAD = 'b'.repeat(40);

function cycleSnapshot(): GitHubLifecycleSnapshot {
  return {
    project: {
      items: [{
        id: 'item-42',
        contentType: 'Issue',
        number: 42,
        status: 'In Review',
        priority: 'P1',
        effort: 'Medium',
        blockedOn: 'Nothing',
        blockedByIssues: [],
        issueType: 'fix',
        sprintIterationId: 'sprint-1',
      }],
      rateLimit: { remaining: 4_000, used: 1_000, resetAt: '2026-07-22T12:00:00.000Z' },
      currentSprintIterationId: 'sprint-1',
    },
    issues: [{
      number: 42,
      title: 'Target issue',
      shape: 'fix',
      blockedOn: 'Nothing',
      blockedByIssues: [],
      effort: 'Medium',
      priority: 'P1',
      status: 'In Review',
      onBoard: true,
      author: 'oaksprout',
      projectItemId: 'item-42',
      inCurrentSprint: true,
      labels: [],
    }],
    pullRequests: [],
    branches: [],
    diagnostics: [],
    lifecycle: { items: [] },
    capturedAt: '2026-07-22T10:00:00.000Z',
    snapshotMode: 'incremental',
    snapshotComplete: true,
    lastFullReconciliationAt: '2026-07-22T09:30:00.000Z',
    githubUsage: {
      graphqlRequests: 1,
      graphqlCost: 2,
      graphqlRemaining: 4_000,
      graphqlResetAt: '2026-07-22T12:00:00.000Z',
      restRequests: 0,
      restNotModified: 0,
      cacheHits: 0,
      accountingComplete: true,
    },
  };
}

function rawPullRequest(overrides: Partial<RawPullRequest> = {}): RawPullRequest {
  return {
    number: 101,
    title: 'Fix target',
    body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
    author: 'oaksprout',
    baseRefName: 'next',
    headRefName: 'autopilot/42',
    headOid: HEAD,
    headCommittedAt: '2026-07-22T09:00:00.000Z',
    updatedAt: '2026-07-22T09:30:00.000Z',
    isDraft: false,
    state: 'OPEN',
    labels: ['engine:review'],
    closingIssueNumbers: [42],
    mergeability: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    checks: [],
    reviews: [],
    branchClaimTrailers: null,
    reviewClaim: null,
    humanReason: null,
    mergedAt: null,
    mergeCommitOid: null,
    ...overrides,
  };
}

function staleRecoveryCycle(
  implementationBase = 'autopilot/7',
): {
  readonly cycle: GitHubLifecycleSnapshot;
  readonly implementation: RawPullRequest;
  readonly blocker: RawPullRequest;
} {
  const base = cycleSnapshot();
  const implementation = rawPullRequest({
    baseRefName: implementationBase,
    isDraft: true,
    branchClaimTrailers: encodeBranchClaimTrailers({
      kind: 'branch-claim',
      protocolVersion: 2,
      phase: 'implement',
      issueNumber: 42,
      prNumber: 101,
      attempt: '11111111-1111-4111-8111-111111111111',
      runner: 'runner-a',
      login: 'oaksprout',
      expectedHead: gitOid(HEAD),
      targetBase: gitRefName('autopilot/7'),
      claimedAt: '2026-07-22T09:00:00.000Z',
    }),
  });
  const blocker = rawPullRequest({
    number: 201,
    title: 'Implement blocker',
    body: '<!-- jinn-autopilot:v2 issue=7 branch=autopilot/7 -->',
    baseRefName: 'next',
    headRefName: 'autopilot/7',
    headOid: BLOCKER_HEAD,
    isDraft: true,
    closingIssueNumbers: [7],
  });
  return {
    cycle: {
      ...base,
      project: {
        ...base.project,
        items: [{
          ...base.project.items[0]!,
          status: 'In Progress',
          blockedOn: 'Another issue',
          blockedByIssues: [7],
        }],
      },
      issues: [{
        ...base.issues[0]!,
        status: 'In Progress',
        blockedOn: 'Another issue',
        blockedByIssues: [7],
      }],
      pullRequests: [
        decodePullRequestSnapshot(blocker),
        decodePullRequestSnapshot(implementation),
      ],
    },
    implementation,
    blocker,
  };
}

function staleRecoveryReader(
  fixture: ReturnType<typeof staleRecoveryCycle>,
  liveBlocker: RawPullRequest | null,
  calls: number[] = [],
  outcomeNumbers: ReadonlySet<number> = new Set([fixture.blocker.number]),
) {
  return makeTargetedActionReader({
    authorAllowlist: new Set(['oaksprout']),
    rateLimitFloor: 500,
    readGraphQlRemaining: async () => 510,
    readPullRequest: async (number) => {
      calls.push(number);
      if (number === fixture.implementation.number) return fixture.implementation;
      if (number === fixture.blocker.number) return liveBlocker;
      return null;
    },
    readProjectItem: async () => ({
      id: 'item-42',
      status: 'In Progress',
      priority: 'P1',
      effort: 'Medium',
      blockedOn: 'Another issue',
      issueType: 'fix',
    }),
    readIssue: async (number) => ({
      number,
      title: 'Target issue',
      open: true,
      author: 'oaksprout',
      labels: [],
    }),
    readBlockedByIssueNumbers: async () => [7],
    readPullRequestOutcomeNumbersClosingIssues: async () => outcomeNumbers,
  });
}

function staleRecoveryTarget(
  snapshot: GitHubLifecycleSnapshot,
): ReturnType<ReturnType<typeof makeProductionImplementationActionPort>['readStaleRecovery']> {
  const port = makeProductionImplementationActionPort({
    repositoryPath: '/repo',
    worktreeBase: '/attempts',
    runnerId: 'runner-a',
    credentials: new CredentialPool([]),
    authorAllowlist: new Set(['oaksprout']),
    defaultBranch: 'next',
    readSnapshot: async () => snapshot,
  });
  return port.readStaleRecovery(42, 101);
}

function executeTargetedRecovery(
  snapshot: GitHubLifecycleSnapshot,
  events: string[],
) {
  return executeRecoveryAgainst(async () => snapshot, events);
}

function executeRecoveryAgainst(
  readSnapshot: (
    selfClaim?: SelfClaimHeadTransition,
  ) => Promise<GitHubLifecycleSnapshot>,
  events: string[],
  overrides: Partial<ImplementationExecutorDeps> = {},
) {
  return executeImplementationAction({
    kind: 'claim-implementation',
    intent: 'stale-recovery',
    issueNumber: 42,
    prNumber: 101,
    expectedHead: gitOid(HEAD),
    branch: gitRefName('autopilot/42'),
    claimAttempt: '11111111-1111-4111-8111-111111111111',
  }, {
    ...makeProductionImplementationActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/attempts',
      runnerId: 'runner-a',
      credentials: new CredentialPool([]),
      authorAllowlist: new Set(['oaksprout']),
      defaultBranch: 'next',
      readSnapshot,
    }),
    runRealityCheck: async () => {
      events.push('reality');
      return {
        classification: 'clear',
        evidence: {},
        suggestedBlockedOn: null,
        suggestedComment: null,
      };
    },
    credentials: new CredentialPool([{
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'selected-secret',
    }]),
    remoteUrl: 'https://github.com/Jinn-Network/mono.git',
    readTargetBaseHead: async () => {
      events.push('target-head');
      return gitOid(BLOCKER_HEAD);
    },
    createClaimCommit: async () => {
      events.push('claim-commit');
      return gitOid('c'.repeat(40));
    },
    claimBranch: async (input) => {
      events.push('claim');
      return {
        status: 'won',
        expected: input.expectedRemoteHead,
        published: input.claimOid,
        observed: input.claimOid,
      };
    },
    ensureDraftPullRequest: async (input) => {
      events.push('pull-request');
      return {
        number: 101,
        headRefName: input.branch,
        head: input.claimOid,
        baseRefName: input.targetBase,
        draft: true,
        labels: [input.label],
        body: input.body,
      };
    },
    setProjectInProgress: async () => {
      events.push('project');
    },
    createAttempt: async (input) => {
      events.push('attempt');
      return {
        attemptId: input.attemptId,
        paths: {
          worktree: '/attempt/worktree',
          manifest: '/attempt/manifest.json',
          log: '/attempt/session.log',
          ghConfigDir: '/attempt/gh',
          askpass: '/attempt/askpass',
        },
      };
    },
    startSession: async () => {
      events.push('worker');
      events.push('track');
      return { status: 'started', backend: 'local', pid: 42 };
    },
    ambientEnvironment: {},
    nextAttemptId: () => '22222222-2222-4222-8222-222222222222',
    runnerId: 'runner-a',
    now: () => new Date('2026-07-22T10:00:00.000Z'),
    ...overrides,
  } satisfies ImplementationExecutorDeps);
}

/**
 * The live shape of jinn-mono#2822: a stale implementing draft whose recovery
 * pushes its claim commit, after which the two GitHub surfaces disagree about
 * the head for a moment. `indexHead` is what `GET /pulls?state=open` reports,
 * `liveHead` what the GraphQL PR node reports; the claim push moves them
 * independently, and the engine holds a git-protocol `ls-remote` readback
 * proving the branch is at `claimOid` regardless of either.
 */
function selfClaimSkew() {
  const fixture = staleRecoveryCycle();
  const claimOid = gitOid('c'.repeat(40));
  const surfaces = { indexHead: HEAD as string, liveHead: HEAD as string };
  const reader = makeTargetedActionReader({
    authorAllowlist: new Set(['oaksprout']),
    rateLimitFloor: 500,
    readGraphQlRemaining: async () => 510,
    readOpenPullRequestIndex: async () => [
      indexEntry(fixture.implementation, { headOid: surfaces.indexHead }),
      indexEntry(fixture.blocker),
    ],
    readPullRequest: async (number) => {
      if (number === fixture.implementation.number) {
        return { ...fixture.implementation, headOid: surfaces.liveHead };
      }
      if (number === fixture.blocker.number) return fixture.blocker;
      return null;
    },
    readProjectItem: async () => ({
      id: 'item-42',
      status: 'In Progress',
      priority: 'P1',
      effort: 'Medium',
      blockedOn: 'Another issue',
      issueType: 'fix',
    }),
    readIssue: async (number) => ({
      number,
      title: 'Target issue',
      open: true,
      author: 'oaksprout',
      labels: [],
    }),
    readBlockedByIssueNumbers: async () => [7],
    readPullRequestOutcomeNumbersClosingIssues: async () =>
      new Set([fixture.blocker.number]),
  });
  // The same composition run-autopilot-v2.ts wires for a stale-recovery
  // action, including the rejection message the engine log carries.
  const readSnapshot = async (
    selfClaim?: SelfClaimHeadTransition,
  ): Promise<GitHubLifecycleSnapshot> => {
    const read = await reader.readStaleRecoveryPullRequest(
      fixture.cycle,
      101,
      selfClaim,
    );
    const snapshot = snapshotOf(read);
    if (snapshot === null) {
      throw new Error(
        'Targeted implementation authority for issue #42 is unavailable'
        + ` (${targetedAuthorityRefusalDetail(read) ?? 'no authority'})`,
      );
    }
    return snapshot;
  };
  return { claimOid, surfaces, readSnapshot };
}

function indexEntry(pr: RawPullRequest, overrides: {
  readonly headOid?: string;
  readonly updatedAt?: string;
} = {}) {
  return {
    number: pr.number,
    title: pr.title,
    state: 'OPEN' as const,
    updatedAt: overrides.updatedAt ?? pr.updatedAt!,
    headOid: overrides.headOid ?? pr.headOid,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    isDraft: pr.isDraft,
    closedAt: null,
    mergedAt: null,
  };
}

describe('targeted action reader', () => {
  it('hydrates only the requested PR and its mapped Project item', async () => {
    const calls: string[] = [];
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => { calls.push('quota'); return 510; },
      readPullRequest: async (number) => {
        calls.push(`pr:${number}`);
        return rawPullRequest();
      },
      readProjectItem: async (number) => {
        calls.push(`project:${number}`);
        return { id: 'item-42', status: 'In Review', blockedOn: 'Nothing' };
      },
      readIssue: async (number) => {
        calls.push(`issue:${number}`);
        return { number, title: 'Target issue', open: true, author: 'oaksprout', labels: [] };
      },
      readBlockedByIssueNumbers: async (number) => {
        calls.push(`dependencies:${number}`);
        return [];
      },
    });

    const snapshot = snapshotOf(await reader.readPullRequest(cycleSnapshot(), 101));

    expect(calls).toEqual([
      'quota',
      'pr:101',
      'issue:42',
      'project:42',
      'dependencies:42',
    ]);
    expect(snapshot?.pullRequests.map((pr) => pr.number)).toEqual([101]);
    expect(snapshot?.lifecycle.items).toEqual([
      expect.objectContaining({ kind: 'pull-request', issueNumber: 42, prNumber: 101 }),
    ]);
  });

  it('returns no action authority when exact target PR evidence is incomplete', async () => {
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => 510,
      readPullRequest: async () => rawPullRequest({
        evidenceIncompleteReason: 'PR #101 labels were truncated',
      }),
      readProjectItem: async () => ({
        id: 'item-42',
        status: 'In Review',
        blockedOn: 'Nothing',
      }),
      readIssue: async (number) => ({
        number,
        title: 'Target issue',
        open: true,
        author: 'oaksprout',
        labels: [],
      }),
      readBlockedByIssueNumbers: async () => [],
    });

    await expect(reader.readPullRequest(cycleSnapshot(), 101)).resolves.toBeNull();
  });

  it('refreshes a newly opened unlabeled mapping competitor before review authority', async () => {
    const target = rawPullRequest();
    const competitor = rawPullRequest({
      number: 102,
      title: 'Competing implementation',
      headOid: 'c'.repeat(40),
      headRefName: 'feature/duplicate-42',
      labels: [],
      body: 'Closes #42',
      updatedAt: '2026-07-22T09:40:00.000Z',
    });
    const base = cycleSnapshot();
    const cycle: GitHubLifecycleSnapshot = {
      ...base,
      pullRequests: [decodePullRequestSnapshot(target)],
    };
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => 4_000,
      readPullRequest: async (number) => (
        number === target.number ? target : number === competitor.number ? competitor : null
      ),
      readOpenPullRequestIndex: async () => [target, competitor].map((pr) => ({
        number: pr.number,
        title: pr.title,
        state: 'OPEN' as const,
        updatedAt: pr.updatedAt!,
        headOid: pr.headOid,
        headRefName: pr.headRefName,
        baseRefName: pr.baseRefName,
        isDraft: pr.isDraft,
        closedAt: null,
        mergedAt: null,
      })),
      readProjectItem: async () => ({
        id: 'item-42',
        status: 'In Review',
        blockedOn: 'Nothing',
      }),
      readIssue: async (number) => ({
        number,
        title: 'Target issue',
        open: true,
        author: 'oaksprout',
        labels: [],
      }),
      readBlockedByIssueNumbers: async () => [],
    });

    const snapshot = snapshotOf(await reader.readPullRequest(cycle, target.number));

    expect(snapshot?.pullRequestMappings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'ambiguous',
        prNumber: target.number,
        details: [expect.stringMatching(/unique open PR/i)],
      }),
    ]));
    expect(snapshot?.lifecycle.items).toEqual([]);
  });

  it('does not probe blocker relations or details for a dependent ordinary review read', async () => {
    const fixture = staleRecoveryCycle();
    const calls: string[] = [];
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => {
        calls.push('quota');
        return 510;
      },
      readPullRequest: async (number) => {
        calls.push(`pr:${number}`);
        if (number === fixture.implementation.number) return fixture.implementation;
        if (number === fixture.blocker.number) return fixture.blocker;
        return null;
      },
      readProjectItem: async (number) => {
        calls.push(`project:${number}`);
        return { id: 'item-42', status: 'In Review', blockedOn: 'Another issue' };
      },
      readIssue: async (number) => {
        calls.push(`issue:${number}`);
        return { number, title: 'Target issue', open: true, author: 'oaksprout', labels: [] };
      },
      readBlockedByIssueNumbers: async (number) => {
        calls.push(`dependencies:${number}`);
        return [7];
      },
      readPullRequestOutcomeNumbersClosingIssues: async (numbers) => {
        calls.push(`blocker-relations:${numbers.join(',')}`);
        return new Set([fixture.blocker.number]);
      },
    });

    await expect(reader.readPullRequest(
      fixture.cycle,
      fixture.implementation.number,
    )).resolves.not.toBeNull();

    expect(calls).toEqual([
      'quota',
      'pr:101',
      'issue:42',
      'project:42',
      'dependencies:42',
    ]);
  });

  it('does not probe blocker relations or details for a dependent reserved review read', async () => {
    const fixture = staleRecoveryCycle();
    const calls: string[] = [];
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => {
        calls.push('quota');
        return 510;
      },
      readPullRequest: async (number) => {
        calls.push(`pr:${number}`);
        if (number === fixture.implementation.number) return fixture.implementation;
        if (number === fixture.blocker.number) return fixture.blocker;
        return null;
      },
      readProjectItem: async (number) => {
        calls.push(`project:${number}`);
        return { id: 'item-42', status: 'In Review', blockedOn: 'Another issue' };
      },
      readIssue: async (number) => {
        calls.push(`issue:${number}`);
        return { number, title: 'Target issue', open: true, author: 'oaksprout', labels: [] };
      },
      readBlockedByIssueNumbers: async (number) => {
        calls.push(`dependencies:${number}`);
        return [7];
      },
      readPullRequestOutcomeNumbersClosingIssues: async (numbers) => {
        calls.push(`blocker-relations:${numbers.join(',')}`);
        return new Set([fixture.blocker.number]);
      },
    });

    await expect(reader.readReservedPullRequest(
      fixture.cycle,
      fixture.implementation.number,
    )).resolves.not.toBeNull();

    expect(calls).toEqual([
      'pr:101',
      'issue:42',
      'project:42',
      'dependencies:42',
    ]);
  });

  it('allows only the engine exact self-claim head transition during stale recovery', async () => {
    const fixture = staleRecoveryCycle();
    const claimedHead = 'b'.repeat(40);
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => 510,
      readOpenPullRequestIndex: async () => [
        indexEntry(fixture.implementation, { headOid: HEAD }),
        indexEntry(fixture.blocker),
      ],
      readPullRequest: async (number) => {
        if (number === fixture.implementation.number) {
          return { ...fixture.implementation, headOid: claimedHead };
        }
        if (number === fixture.blocker.number) return fixture.blocker;
        return null;
      },
      readProjectItem: async () => ({
        id: 'item-42',
        status: 'In Progress',
        priority: 'P1',
        effort: 'Medium',
        blockedOn: 'Another issue',
        issueType: 'fix',
      }),
      readIssue: async (number) => ({
        number,
        title: 'Target issue',
        open: true,
        author: 'oaksprout',
        labels: [],
      }),
      readBlockedByIssueNumbers: async () => [7],
      readPullRequestOutcomeNumbersClosingIssues: async () =>
        new Set([fixture.blocker.number]),
    });

    const refused = await reader.readStaleRecoveryPullRequest(fixture.cycle, 101);
    expect(targetedAuthorityRefusalDetail(refused)).toContain('headOid moved');

    const allowed = await reader.readStaleRecoveryPullRequest(
      fixture.cycle,
      101,
      selfClaimHeadTransition({
        prNumber: 101,
        previousHead: gitOid(HEAD),
        candidateParent: gitOid(HEAD),
        claimedHead: gitOid(claimedHead),
      }),
    );
    expect(snapshotOf(allowed)).not.toBeNull();
  });

  it('dispatches the recovery worker when the live PR read still trails its own claim push', async () => {
    const { claimOid, surfaces, readSnapshot } = selfClaimSkew();
    const events: string[] = [];

    const result = await executeRecoveryAgainst(readSnapshot, events, {
      createClaimCommit: async () => {
        events.push('claim-commit');
        return claimOid;
      },
      claimBranch: async (input) => {
        events.push('claim');
        // The CAS push wins and `ls-remote` proves the branch head. The REST
        // open-PR index shows it at once; the GraphQL PR node does not.
        surfaces.indexHead = claimOid;
        return {
          status: 'won',
          expected: input.expectedRemoteHead,
          published: input.claimOid,
          observed: input.claimOid,
        };
      },
    });

    expect(result).toMatchObject({
      status: 'spawned',
      issueNumber: 42,
      prNumber: 101,
      claimOid,
    });
    expect(events).toContain('worker');
    expect(events.filter((event) => event === 'claim-commit')).toHaveLength(1);
  });

  it('still aborts the recovery when a foreign head lands on the claim branch', async () => {
    const foreign = gitOid('9'.repeat(40));
    for (const surface of ['index', 'live'] as const) {
      const { claimOid, surfaces, readSnapshot } = selfClaimSkew();
      const events: string[] = [];

      await expect(executeRecoveryAgainst(readSnapshot, events, {
        createClaimCommit: async () => {
          events.push('claim-commit');
          return claimOid;
        },
        claimBranch: async (input) => {
          events.push('claim');
          if (surface === 'index') {
            surfaces.indexHead = foreign;
          } else {
            surfaces.indexHead = claimOid;
            surfaces.liveHead = foreign;
          }
          return {
            status: 'won',
            expected: input.expectedRemoteHead,
            published: input.claimOid,
            observed: input.claimOid,
          };
        },
      })).rejects.toThrow('live read disagrees with its open PR index row');
      expect(events).not.toContain('worker');
    }
  });

  it('refuses a second claim commit once the branch already carries this claim', async () => {
    const { claimOid, surfaces, readSnapshot } = selfClaimSkew();
    const events: string[] = [];
    const deps = {
      createClaimCommit: async () => {
        events.push('claim-commit');
        return claimOid;
      },
      claimBranch: async (input: { readonly expectedRemoteHead: unknown; readonly claimOid: unknown }) => {
        events.push('claim');
        surfaces.indexHead = claimOid;
        surfaces.liveHead = claimOid;
        return {
          status: 'won' as const,
          expected: input.expectedRemoteHead,
          published: input.claimOid,
          observed: input.claimOid,
        };
      },
    } as Partial<ImplementationExecutorDeps>;

    await expect(executeRecoveryAgainst(readSnapshot, events, deps))
      .resolves.toMatchObject({ status: 'spawned' });

    // The next cycle replays the same frozen candidate. The claim protocol
    // pins the action to the head it was derived from, so the recovery refuses
    // before it mutates anything rather than stacking a second claim commit.
    const replay = await executeRecoveryAgainst(readSnapshot, events, deps);

    expect(replay).toMatchObject({
      status: 'ineligible',
      issueNumber: 42,
      detail: expect.stringContaining('head changed'),
    });
    expect(events.filter((event) => event === 'claim-commit')).toHaveLength(1);
  });

  it('withholds stale-recovery authority when a blocker closes unmerged after the cycle', async () => {
    const fixture = staleRecoveryCycle();
    const calls: number[] = [];
    const reader = staleRecoveryReader(fixture, null, calls);

    const targeted = snapshotOf(await reader.readStaleRecoveryPullRequest(fixture.cycle, 101));

    expect(targeted).not.toBeNull();
    expect(calls).toEqual([101, 201]);
    await expect(staleRecoveryTarget(targeted!)).resolves.toMatchObject({
      issue: null,
    });
  });

  it('stops a closed-unmerged blocker race before reality check or mutation', async () => {
    const fixture = staleRecoveryCycle();
    const reader = staleRecoveryReader(fixture, null);
    const events: string[] = [];
    const targeted = snapshotOf(await reader.readStaleRecoveryPullRequest(fixture.cycle, 101));
    const result = targeted === null
      ? 'withheld'
      : await executeTargetedRecovery(targeted, events);

    expect(result).toMatchObject({
      status: 'ineligible',
      issueNumber: 42,
    });
    expect(events).toEqual([]);
  });

  it('derives the configured default target when a blocker merges after the cycle', async () => {
    const fixture = staleRecoveryCycle('next');
    const mergedBlocker: RawPullRequest = {
      ...fixture.blocker,
      state: 'MERGED',
      mergedAt: '2026-07-22T09:30:00.000Z',
      mergeCommitOid: 'c'.repeat(40),
    };
    const reader = staleRecoveryReader(fixture, mergedBlocker);

    const targeted = snapshotOf(await reader.readStaleRecoveryPullRequest(fixture.cycle, 101));

    expect(targeted).not.toBeNull();
    await expect(staleRecoveryTarget(targeted!)).resolves.toMatchObject({
      issue: { targetBase: 'next' },
      pullRequest: { baseRefName: 'next' },
    });
  });

  it('recovers #2039 through merged PR #1728 omitted from the cycle cache', async () => {
    const fixture = staleRecoveryCycle('next');
    const implementation = {
      ...fixture.implementation,
      number: 2040,
      body: '<!-- jinn-autopilot:v2 issue=2039 branch=autopilot/2039 -->',
      baseRefName: 'main',
      headRefName: 'autopilot/2039',
      closingIssueNumbers: [2039],
      branchClaimTrailers: encodeBranchClaimTrailers({
        kind: 'branch-claim',
        protocolVersion: 2,
        phase: 'implement',
        issueNumber: 2039,
        prNumber: 2040,
        attempt: '11111111-1111-4111-8111-111111111111',
        runner: 'runner-a',
        login: 'oaksprout',
        expectedHead: gitOid(HEAD),
        targetBase: gitRefName('autopilot/1243'),
        claimedAt: '2026-07-22T09:00:00.000Z',
      }),
    };
    const mergedBlocker: RawPullRequest = {
      ...fixture.blocker,
      number: 1728,
      body: '<!-- jinn-autopilot:v2 issue=1243 branch=autopilot/1243 -->',
      headRefName: 'autopilot/1243',
      closingIssueNumbers: [1243],
      state: 'MERGED',
      mergedAt: '2026-07-22T09:30:00.000Z',
      mergeCommitOid: 'c'.repeat(40),
    };
    const calls: string[] = [];
    const options = {
      authorAllowlist: new Set(['oaksprout']),
      defaultBranch: 'main',
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => 510,
      readPullRequest: async (number: number) => {
        calls.push(`pr:${number}`);
        if (number === 2040) return implementation;
        if (number === 1728) return mergedBlocker;
        return null;
      },
      readProjectItem: async () => ({
        id: 'item-42',
        status: 'In Progress' as const,
        priority: 'P1' as const,
        effort: 'Medium' as const,
        blockedOn: 'Another issue' as const,
        issueType: 'fix' as const,
      }),
      readIssue: async (number: number) => ({
        number,
        title: 'Target issue',
        open: true,
        author: 'oaksprout',
        labels: [],
      }),
      readBlockedByIssueNumbers: async () => [1243],
      readPullRequestOutcomeNumbersClosingIssues: async (numbers: readonly number[]) => {
        calls.push(`relations:${numbers.join(',')}`);
        return new Set([1728]);
      },
    };
    const reader = makeTargetedActionReader(options);
    const cycleWithoutMergedOutcome = {
      ...fixture.cycle,
      project: {
        ...fixture.cycle.project,
        items: [{
          ...fixture.cycle.project.items[0]!,
          number: 2039,
          blockedByIssues: [1243],
        }],
      },
      issues: [{
        ...fixture.cycle.issues[0]!,
        number: 2039,
        blockedByIssues: [1243],
      }],
      pullRequests: [decodePullRequestSnapshot(implementation)],
    };

    const targeted = snapshotOf(await reader.readStaleRecoveryPullRequest(
      cycleWithoutMergedOutcome,
      2040,
    ));
    const port = makeProductionImplementationActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/attempts',
      runnerId: 'runner-a',
      credentials: new CredentialPool([]),
      authorAllowlist: new Set(['oaksprout']),
      defaultBranch: 'main',
      readSnapshot: async () => targeted!,
    });

    expect(calls).toEqual(['pr:2040', 'relations:1243', 'pr:1728']);
    await expect(port.readStaleRecovery(2039, 2040)).resolves.toMatchObject({
      issue: { targetBase: 'main' },
      pullRequest: { baseRefName: 'main' },
    });
  });

  it('retains a still-open trusted blocker exact live branch target', async () => {
    const fixture = staleRecoveryCycle('stack/live-blocker');
    const liveBlocker: RawPullRequest = {
      ...fixture.blocker,
      headRefName: 'stack/live-blocker',
      body: '<!-- jinn-autopilot:v2 issue=7 branch=stack/live-blocker -->',
    };
    const reader = staleRecoveryReader(fixture, liveBlocker);

    const targeted = snapshotOf(await reader.readStaleRecoveryPullRequest(fixture.cycle, 101));

    expect(targeted).not.toBeNull();
    await expect(staleRecoveryTarget(targeted!)).resolves.toMatchObject({
      issue: { targetBase: 'stack/live-blocker' },
      pullRequest: { baseRefName: 'stack/live-blocker' },
    });
  });

  it('withholds stale-recovery authority for untrusted live blocker evidence', async () => {
    const fixture = staleRecoveryCycle();
    const reader = staleRecoveryReader(fixture, {
      ...fixture.blocker,
      author: 'outsider',
    });

    const targeted = snapshotOf(await reader.readStaleRecoveryPullRequest(fixture.cycle, 101));

    expect(targeted).not.toBeNull();
    await expect(staleRecoveryTarget(targeted!)).resolves.toMatchObject({
      issue: null,
    });
  });

  it('withholds stale-recovery authority for ambiguously mapped live blocker evidence', async () => {
    const fixture = staleRecoveryCycle();
    const reader = staleRecoveryReader(fixture, {
      ...fixture.blocker,
      closingIssueNumbers: [7, 8],
    });

    await expect(reader.readStaleRecoveryPullRequest(
      fixture.cycle,
      101,
    )).resolves.toBeNull();
  });

  it('withholds two trusted OPEN outcomes for one blocker before reality or mutation', async () => {
    const fixture = staleRecoveryCycle();
    const secondBlocker = {
      ...fixture.blocker,
      number: 202,
      body: '<!-- jinn-autopilot:v2 issue=7 branch=stack/second -->',
      headRefName: 'stack/second',
      headOid: 'd'.repeat(40),
    };
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => 510,
      readPullRequest: async (number) => {
        if (number === 101) return fixture.implementation;
        if (number === 201) return fixture.blocker;
        if (number === 202) return secondBlocker;
        return null;
      },
      readProjectItem: async () => ({
        id: 'item-42',
        status: 'In Progress',
        priority: 'P1',
        effort: 'Medium',
        blockedOn: 'Another issue',
        issueType: 'fix',
      }),
      readIssue: async (number) => ({
        number,
        title: 'Target issue',
        open: true,
        author: 'oaksprout',
        labels: [],
      }),
      readBlockedByIssueNumbers: async () => [7],
      // PR #201 is present in both sources; identity deduplication must leave
      // exactly two distinct OPEN outcomes, not three.
      readPullRequestOutcomeNumbersClosingIssues: async () => new Set([201, 202]),
    });
    const events: string[] = [];

    const targeted = snapshotOf(await reader.readStaleRecoveryPullRequest(fixture.cycle, 101));
    const result = targeted === null
      ? 'withheld'
      : await executeTargetedRecovery(targeted, events);

    expect(result).toBe('withheld');
    expect(events).toEqual([]);
  });

  it('keeps one MERGED and one OPEN outcome for the same blocker satisfied', async () => {
    const fixture = staleRecoveryCycle('next');
    const mergedBlocker = {
      ...fixture.blocker,
      state: 'MERGED' as const,
      mergedAt: '2026-07-22T09:30:00.000Z',
      mergeCommitOid: 'c'.repeat(40),
    };
    const historicalOpen = {
      ...fixture.blocker,
      number: 202,
      body: '<!-- jinn-autopilot:v2 issue=7 branch=stack/historical-open -->',
      headRefName: 'stack/historical-open',
      headOid: 'd'.repeat(40),
    };
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => 510,
      readPullRequest: async (number) => {
        if (number === 101) return fixture.implementation;
        if (number === 201) return mergedBlocker;
        if (number === 202) return historicalOpen;
        return null;
      },
      readProjectItem: async () => ({
        id: 'item-42',
        status: 'In Progress',
        priority: 'P1',
        effort: 'Medium',
        blockedOn: 'Another issue',
        issueType: 'fix',
      }),
      readIssue: async (number) => ({
        number,
        title: 'Target issue',
        open: true,
        author: 'oaksprout',
        labels: [],
      }),
      readBlockedByIssueNumbers: async () => [7],
      readPullRequestOutcomeNumbersClosingIssues: async () => new Set([201, 202]),
    });

    const targeted = snapshotOf(await reader.readStaleRecoveryPullRequest(fixture.cycle, 101));

    expect(targeted).not.toBeNull();
    await expect(staleRecoveryTarget(targeted!)).resolves.toMatchObject({
      issue: { targetBase: 'next' },
    });
  });

  it('withholds stale-recovery authority when a fresh blocker edge has no PR evidence', async () => {
    const fixture = staleRecoveryCycle();
    const reader = staleRecoveryReader(fixture, fixture.blocker, [], new Set());
    const withoutBlockerEvidence = {
      ...fixture.cycle,
      pullRequests: fixture.cycle.pullRequests.filter((pr) => pr.number !== 201),
    };

    const targeted = snapshotOf(await reader.readStaleRecoveryPullRequest(
      withoutBlockerEvidence,
      101,
    ));

    expect(targeted).not.toBeNull();
    await expect(staleRecoveryTarget(targeted!)).resolves.toMatchObject({
      issue: null,
    });
  });

  it('exact-hydrates every PR referenced by fresh blocker edges', async () => {
    const fixture = staleRecoveryCycle('next');
    const secondBlocker = rawPullRequest({
      number: 202,
      title: 'Implement second blocker',
      body: '<!-- jinn-autopilot:v2 issue=8 branch=autopilot/8 -->',
      baseRefName: 'next',
      headRefName: 'autopilot/8',
      headOid: 'd'.repeat(40),
      isDraft: false,
      state: 'MERGED',
      closingIssueNumbers: [8],
      mergedAt: '2026-07-22T09:35:00.000Z',
      mergeCommitOid: 'e'.repeat(40),
    });
    const firstMerged = {
      ...fixture.blocker,
      state: 'MERGED' as const,
      mergedAt: '2026-07-22T09:30:00.000Z',
      mergeCommitOid: 'c'.repeat(40),
    };
    const cycle = {
      ...fixture.cycle,
      project: {
        ...fixture.cycle.project,
        items: [{
          ...fixture.cycle.project.items[0]!,
          blockedByIssues: [7, 8],
        }],
      },
      issues: [{
        ...fixture.cycle.issues[0]!,
        blockedByIssues: [7, 8],
      }],
      pullRequests: [
        ...fixture.cycle.pullRequests,
        decodePullRequestSnapshot({
          ...secondBlocker,
          state: 'OPEN',
          mergedAt: null,
          mergeCommitOid: null,
        }),
      ],
    };
    const calls: number[] = [];
    let reserveReads = 0;
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => {
        reserveReads += 1;
        return 510;
      },
      readPullRequest: async (number) => {
        calls.push(number);
        if (number === 101) return fixture.implementation;
        if (number === 201) return firstMerged;
        if (number === 202) return secondBlocker;
        return null;
      },
      readProjectItem: async () => ({
        id: 'item-42',
        status: 'In Progress',
        priority: 'P1',
        effort: 'Medium',
        blockedOn: 'Another issue',
        issueType: 'fix',
      }),
      readIssue: async (number) => ({
        number,
        title: 'Target issue',
        open: true,
        author: 'oaksprout',
        labels: [],
      }),
      readBlockedByIssueNumbers: async () => [7, 8],
      readPullRequestOutcomeNumbersClosingIssues: async () => new Set([201, 202]),
    });

    const targeted = snapshotOf(await reader.readStaleRecoveryPullRequest(cycle, 101));

    expect(calls).toEqual([101, 201, 202]);
    expect(reserveReads).toBe(4);
    expect(targeted?.pullRequests.filter((pr) => (
      pr.number === 201 || pr.number === 202
    )).map((pr) => pr.state)).toEqual(['MERGED', 'MERGED']);
    await expect(staleRecoveryTarget(targeted!)).resolves.toMatchObject({
      issue: { targetBase: 'next' },
    });
  });

  it('reuses an aggregate cohort reservation without per-review quota probes', async () => {
    const calls: string[] = [];
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => {
        calls.push('quota');
        return 510;
      },
      readPullRequest: async () => rawPullRequest(),
      readProjectItem: async () => ({
        id: 'item-42',
        status: 'In Review',
        blockedOn: 'Nothing',
      }),
      readIssue: async (number) => ({
        number,
        title: 'Target issue',
        open: true,
        author: 'oaksprout',
        labels: [],
      }),
      readBlockedByIssueNumbers: async () => [],
    });

    const terminalClaims = [{
      issueNumber: 42,
      prNumber: 101,
      headRefName: 'autopilot/42',
      headOid: gitOid(HEAD),
      claimAttempt: '11111111-1111-4111-8111-111111111111',
      targetBase: 'next',
      claimFingerprint: 'claim-fingerprint',
      mergedAt: '2026-07-22T09:30:00.000Z',
      mergeCommitOid: gitOid('b'.repeat(40)),
    }];
    await expect(reader.readReservedPullRequest({
      ...cycleSnapshot(),
      snapshotAuthority: 'scoped',
      scopedIssueNumbers: [42],
      globalOpenPipelineBacklog: 7,
      terminalClaims,
    }, 101)).resolves.toMatchObject({
      snapshotAuthority: 'scoped',
      scopedIssueNumbers: [42],
      globalOpenPipelineBacklog: 7,
      terminalClaims,
    });
    expect(calls).toEqual([]);
  });

  it('reads one live native issue, Project item, and dependency set for implementation', async () => {
    const calls: string[] = [];
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => { calls.push('quota'); return 510; },
      readPullRequest: vi.fn(),
      readProjectItem: async (number) => {
        calls.push(`project:${number}`);
        return { id: 'item-42', status: 'Todo', blockedOn: 'Another issue' };
      },
      readIssue: async (number) => {
        calls.push(`issue:${number}`);
        return { number, title: 'Target issue now', open: true, author: 'oaksprout', labels: [] };
      },
      readBlockedByIssueNumbers: async (number) => {
        calls.push(`dependencies:${number}`);
        return [7];
      },
    });

    const base = cycleSnapshot();
    const result = await reader.readIssue({
      ...base,
      issues: [{ ...base.issues[0]!, blockedByIssues: [7] }],
      project: {
        ...base.project,
        items: [{ ...base.project.items[0]!, blockedByIssues: [7] }],
      },
    }, 42);

    expect(calls).toEqual(['quota', 'issue:42', 'project:42', 'dependencies:42']);
    expect(result?.source).toEqual(expect.objectContaining({
      number: 42,
      title: 'Target issue now',
      blockedOn: 'Another issue',
      blockedByIssues: [7],
      status: 'Todo',
    }));
  });

  it('hydrates Project and closing relations from one combined issue context', async () => {
    const calls: string[] = [];
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => { calls.push('quota:10'); return 510; },
      readPullRequest: vi.fn(),
      readProjectItem: vi.fn(),
      readIssue: async (number) => ({
        number, title: 'Target issue', open: true, author: 'oaksprout', labels: [],
      }),
      readBlockedByIssueNumbers: async () => [],
      readIssueActionContext: async () => {
        calls.push('combined:2');
        return {
          projectItem: {
            id: 'item-42', status: 'Todo', priority: 'P1', effort: 'Medium',
            blockedOn: 'Nothing', issueType: 'fix',
          },
          openPullRequestNumbers: new Set([101]),
        };
      },
      readPullRequestDetails: async (number) => {
        calls.push(`rest-pr:${number}`);
        return {
          number,
          headRefName: 'autopilot/42',
          headOid: HEAD,
          baseRefName: 'next',
          draft: true,
          labels: ['engine:review'],
          body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
        };
      },
    });

    const result = await reader.readIssue(cycleSnapshot(), 42);

    expect(result?.openPullRequests?.map((pr) => pr.number)).toEqual([101]);
    expect(calls).toEqual(['quota:10', 'combined:2', 'rest-pr:101']);
  });

  it('does not revive live-missing admission fields from the cycle cache', async () => {
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => 510,
      readPullRequest: vi.fn(),
      readProjectItem: async () => ({
        id: 'item-42',
        status: 'Todo',
        priority: null,
        effort: null,
        blockedOn: 'Nothing',
        issueType: null,
      }),
      readIssue: async (number) => ({
        number,
        title: 'Target issue',
        open: true,
        author: 'oaksprout',
        labels: [],
      }),
      readBlockedByIssueNumbers: async () => [],
    });

    const result = await reader.readIssue(cycleSnapshot(), 42);

    expect(result?.source).toMatchObject({ priority: null, effort: null, shape: null });
    expect(result?.snapshot.lifecycle.items).toEqual([
      expect.objectContaining({ kind: 'issue', eligible: false }),
    ]);
  });

  it('preserves single-open-blocker stack admission after exact blocker hydration', async () => {
    const base = cycleSnapshot();
    const blockerRaw = rawPullRequest({
      number: 201,
      body: '<!-- jinn-autopilot:v2 issue=7 branch=autopilot/7 -->',
      headRefName: 'autopilot/7',
      closingIssueNumbers: [7],
    });
    const cycle: GitHubLifecycleSnapshot = {
      ...base,
      project: {
        ...base.project,
        items: [{ ...base.project.items[0]!, blockedOn: 'Another issue', blockedByIssues: [7] }],
      },
      issues: [
        { ...base.issues[0]!, blockedOn: 'Another issue', blockedByIssues: [7] },
        {
          ...base.issues[0]!,
          number: 7,
          title: 'Blocker',
          status: 'In Progress',
          projectItemId: 'item-7',
        },
      ],
      pullRequests: [decodePullRequestSnapshot(blockerRaw)],
    };
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => 510,
      readPullRequest: async (number) => number === 201 ? blockerRaw : null,
      readProjectItem: async () => ({
        id: 'item-42',
        status: 'Todo',
        priority: 'P1',
        effort: 'Medium',
        blockedOn: 'Another issue',
        issueType: 'fix',
      }),
      readIssue: async (number) => ({
        number,
        title: 'Target issue',
        open: true,
        author: 'oaksprout',
        labels: [],
      }),
      readBlockedByIssueNumbers: async () => [7],
    });

    const result = await reader.readIssue(cycle, 42);

    expect(result?.snapshot.lifecycle.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'issue', issueNumber: 42, eligible: true }),
    ]));
  });

  it.each([
    ['branch', { headRefName: 'autopilot/other' }],
    ['closing relation', { closingIssueNumbers: [8] }],
    ['marker', {
      body: '<!-- jinn-autopilot:v2 issue=7 branch=autopilot/other -->',
    }],
  ])('rejects a stacked implementation when the blocker %s changes', async (_field, override) => {
    const base = cycleSnapshot();
    const blocker = rawPullRequest({
      number: 201,
      body: '<!-- jinn-autopilot:v2 issue=7 branch=autopilot/7 -->',
      headRefName: 'autopilot/7',
      closingIssueNumbers: [7],
    });
    const cycle: GitHubLifecycleSnapshot = {
      ...base,
      project: {
        ...base.project,
        items: [{ ...base.project.items[0]!, blockedOn: 'Another issue', blockedByIssues: [7] }],
      },
      issues: [{ ...base.issues[0]!, blockedOn: 'Another issue', blockedByIssues: [7] }],
      pullRequests: [decodePullRequestSnapshot(blocker)],
    };
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => 510,
      readPullRequest: async () => ({ ...blocker, ...override }),
      readProjectItem: async () => ({
        id: 'item-42', status: 'Todo', priority: 'P1', effort: 'Medium',
        blockedOn: 'Another issue', issueType: 'fix',
      }),
      readIssue: async (number) => ({
        number, title: 'Target issue', open: true, author: 'oaksprout', labels: [],
      }),
      readBlockedByIssueNumbers: async () => [7],
    });

    await expect(reader.readIssue(cycle, 42)).rejects.toThrow(/blocker PR authority changed/i);
  });

  it('checks the ten-point reserve before starting targeted GraphQL work', async () => {
    const readPullRequest = vi.fn(async () => rawPullRequest());
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => 509,
      readPullRequest,
      readProjectItem: vi.fn(),
      readIssue: async (number) => ({
        number,
        title: 'Target issue',
        open: true,
        author: 'oaksprout',
        labels: [],
      }),
      readBlockedByIssueNumbers: vi.fn(),
    });

    await expect(reader.readPullRequest(cycleSnapshot(), 101))
      .rejects.toBeInstanceOf(GitHubRateLimitReserveError);
    expect(readPullRequest).not.toHaveBeenCalled();
  });

  it('guards direct Project pre/post readbacks at the one-point floor boundary', async () => {
    let remaining = 500;
    const readProjectItem = vi.fn(async () => ({
      id: 'item-42', status: 'Todo' as const, blockedOn: 'Nothing' as const,
    }));
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => remaining,
      readPullRequest: vi.fn(),
      readProjectItem,
      readIssue: vi.fn(),
      readBlockedByIssueNumbers: vi.fn(),
    });

    await expect(reader.readProjectItem(42)).rejects.toBeInstanceOf(GitHubRateLimitReserveError);
    expect(readProjectItem).not.toHaveBeenCalled();

    remaining = 501;
    await expect(reader.readProjectItem(42)).resolves.toMatchObject({ id: 'item-42' });
    expect(readProjectItem).toHaveBeenCalledTimes(1);
  });

  it('guards issue-level closing-relation reads at the two-point floor boundary', async () => {
    let remaining = 501;
    const readRelations = vi.fn(async () => new Set<number>());
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => remaining,
      readPullRequest: vi.fn(),
      readProjectItem: vi.fn(),
      readIssue: vi.fn(),
      readBlockedByIssueNumbers: vi.fn(),
      readOpenPullRequestNumbersClosingIssue: readRelations,
      readPullRequestDetails: vi.fn(),
    });

    await expect(reader.readOpenPullRequests(42))
      .rejects.toBeInstanceOf(GitHubRateLimitReserveError);
    expect(readRelations).not.toHaveBeenCalled();

    remaining = 502;
    await expect(reader.readOpenPullRequests(42)).resolves.toEqual([]);
    expect(readRelations).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a mapped issue has no live Project item', async () => {
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => 510,
      readPullRequest: async () => rawPullRequest(),
      readProjectItem: async () => null,
      readIssue: async (number) => ({
        number,
        title: 'Target issue',
        open: true,
        author: 'oaksprout',
        labels: [],
      }),
      readBlockedByIssueNumbers: vi.fn(),
    });

    await expect(reader.readPullRequest(cycleSnapshot(), 101))
      .rejects.toThrow(/Project item/i);
  });

  it('rejects an open PR when its exactly mapped native issue closed after the cycle', async () => {
    const reader = makeTargetedActionReader({
      authorAllowlist: new Set(['oaksprout']),
      rateLimitFloor: 500,
      readGraphQlRemaining: async () => 510,
      readPullRequest: async () => rawPullRequest(),
      readProjectItem: vi.fn(),
      readIssue: async (number) => ({
        number,
        title: 'Closed issue',
        open: false,
        author: 'oaksprout',
        labels: [],
      }),
      readBlockedByIssueNumbers: vi.fn(),
    });

    await expect(reader.readPullRequest(cycleSnapshot(), 101))
      .rejects.toThrow(/native issue.*closed/i);
  });
});

describe('targeted action reader unrelated open PR churn', () => {
  const RACING_INDEX_HEAD = 'd'.repeat(40);
  const RACING_LIVE_HEAD = 'e'.repeat(40);

  const target = () => rawPullRequest();

  const racing = (overrides: Partial<RawPullRequest> = {}) => rawPullRequest({
    number: 999,
    title: 'Unrelated racing PR',
    body: '<!-- jinn-autopilot:v2 issue=77 branch=autopilot/77 -->',
    headRefName: 'autopilot/77',
    headOid: RACING_LIVE_HEAD,
    closingIssueNumbers: [77],
    updatedAt: '2026-07-22T10:01:00.000Z',
    ...overrides,
  });

  const vetoReader = (input: {
    readonly index: readonly ReturnType<typeof indexEntry>[];
    readonly reads: ReadonlyMap<number, RawPullRequest | null>;
    readonly dependencies?: readonly number[];
    readonly blockedOn?: 'Nothing' | 'Another issue';
    /** Records every rate-limit reservation, in the order the reader takes it. */
    readonly onReserve?: () => void;
    /** Records every live PR read, in the order the reader issues it. */
    readonly onRead?: (number: number) => void;
  }) => makeTargetedActionReader({
    authorAllowlist: new Set(['oaksprout']),
    rateLimitFloor: 500,
    readGraphQlRemaining: async () => {
      input.onReserve?.();
      return 4_000;
    },
    readPullRequest: async (number) => {
      input.onRead?.(number);
      return input.reads.get(number) ?? null;
    },
    readOpenPullRequestIndex: async () => input.index,
    readProjectItem: async () => ({
      id: 'item-42',
      status: 'In Review',
      blockedOn: input.blockedOn ?? 'Nothing',
    }),
    readIssue: async (number) => ({
      number,
      title: `Issue ${number}`,
      open: true,
      author: 'oaksprout',
      labels: [],
    }),
    readBlockedByIssueNumbers: async () => input.dependencies ?? [],
  });

  const cycleWith = (
    ...pullRequests: readonly RawPullRequest[]
  ): GitHubLifecycleSnapshot => ({
    ...cycleSnapshot(),
    pullRequests: pullRequests.map((pr) => decodePullRequestSnapshot(pr)),
  });

  it('keeps review authority when an unrelated PR races the cycle snapshot', async () => {
    const subject = target();
    const other = racing();
    const reader = vetoReader({
      // The racing PR was created after the cycle snapshot and its branch is
      // still receiving pushes, so the ETag-cached index row is behind the
      // live head.
      index: [indexEntry(subject), indexEntry(other, { headOid: RACING_INDEX_HEAD })],
      reads: new Map([[subject.number, subject], [other.number, other]]),
    });

    const snapshot = snapshotOf(await reader.readPullRequest(cycleWith(subject), subject.number));

    expect(snapshot).not.toBeNull();
    expect(snapshot?.pullRequests.map((pr) => pr.number)).toEqual([subject.number]);
    expect(snapshot?.pullRequestMappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'resolved', prNumber: subject.number }),
    ]));
  });

  it('refuses authority when the target base-chain parent races the cycle snapshot', async () => {
    const subject = rawPullRequest({ baseRefName: 'autopilot/7' });
    const parent = rawPullRequest({
      number: 201,
      title: 'Parent of the stack',
      body: '<!-- jinn-autopilot:v2 issue=7 branch=autopilot/7 -->',
      headRefName: 'autopilot/7',
      headOid: RACING_LIVE_HEAD,
      closingIssueNumbers: [7],
      updatedAt: '2026-07-22T10:01:00.000Z',
    });
    const reader = vetoReader({
      index: [indexEntry(subject), indexEntry(parent, { headOid: RACING_INDEX_HEAD })],
      reads: new Map([[subject.number, subject], [parent.number, parent]]),
    });

    const read = await reader.readPullRequest(cycleWith(subject), subject.number);

    expect(snapshotOf(read)).toBeNull();
    expect(targetedAuthorityRefusalDetail(read)).toMatch(
      /PR #201 heads the target base chain branch autopilot\/7 and its headOid moved/,
    );
  });

  it('refuses authority when a blocker-closing PR races the cycle snapshot', async () => {
    const subject = target();
    const blocker = rawPullRequest({
      number: 201,
      title: 'Blocker implementation',
      body: '<!-- jinn-autopilot:v2 issue=7 branch=autopilot/7 -->',
      headRefName: 'autopilot/7',
      headOid: RACING_LIVE_HEAD,
      closingIssueNumbers: [7],
      updatedAt: '2026-07-22T10:01:00.000Z',
    });
    const reader = vetoReader({
      index: [indexEntry(subject), indexEntry(blocker, { headOid: RACING_INDEX_HEAD })],
      reads: new Map([[subject.number, subject], [blocker.number, blocker]]),
      dependencies: [7],
    });

    const read = await reader.readPullRequest(cycleWith(subject), subject.number);

    expect(snapshotOf(read)).toBeNull();
    expect(targetedAuthorityRefusalDetail(read)).toMatch(
      /PR #201 closes target blocker issue #7 and its headOid moved/,
    );
  });

  it('refuses authority when a same-issue mapping contender races the cycle snapshot', async () => {
    const subject = target();
    const contender = rawPullRequest({
      number: 102,
      title: 'Competing implementation',
      body: 'Closes #42',
      headRefName: 'feature/duplicate-42',
      headOid: RACING_LIVE_HEAD,
      labels: [],
      updatedAt: '2026-07-22T10:01:00.000Z',
    });
    const reader = vetoReader({
      index: [indexEntry(subject), indexEntry(contender, { headOid: RACING_INDEX_HEAD })],
      reads: new Map([[subject.number, subject], [contender.number, contender]]),
    });

    const read = await reader.readPullRequest(cycleWith(subject), subject.number);

    expect(snapshotOf(read)).toBeNull();
    expect(targetedAuthorityRefusalDetail(read)).toMatch(
      /PR #102 closes the target issue #42 and its headOid moved/,
    );
  });

  it('refuses authority when an unclassifiable index row cannot be re-read', async () => {
    const subject = target();
    const other = racing();
    const reader = vetoReader({
      index: [indexEntry(subject), indexEntry(other, { headOid: RACING_INDEX_HEAD })],
      reads: new Map<number, RawPullRequest | null>([
        [subject.number, subject],
        [other.number, null],
      ]),
    });

    const read = await reader.readPullRequest(cycleWith(subject), subject.number);

    expect(snapshotOf(read)).toBeNull();
    expect(targetedAuthorityRefusalDetail(read)).toMatch(
      /PR #999 has no live or cached evidence to classify it against the target/,
    );
  });

  it('drops an unrelated PR whose live evidence is incomplete', async () => {
    const subject = target();
    const other = racing({ evidenceIncompleteReason: 'PR #999 labels were truncated' });
    const reader = vetoReader({
      index: [indexEntry(subject), indexEntry(other)],
      reads: new Map([[subject.number, subject], [other.number, other]]),
    });

    const snapshot = snapshotOf(await reader.readPullRequest(cycleWith(subject), subject.number));

    expect(snapshot?.pullRequests.map((pr) => pr.number)).toEqual([subject.number]);
  });

  it('refuses authority when a blocker-closing PR has incomplete live evidence', async () => {
    const subject = target();
    const blocker = rawPullRequest({
      number: 201,
      title: 'Blocker implementation',
      body: '<!-- jinn-autopilot:v2 issue=7 branch=autopilot/7 -->',
      headRefName: 'autopilot/7',
      headOid: RACING_LIVE_HEAD,
      closingIssueNumbers: [7],
      updatedAt: '2026-07-22T10:01:00.000Z',
      evidenceIncompleteReason: 'PR #201 labels were truncated',
    });
    const reader = vetoReader({
      index: [indexEntry(subject), indexEntry(blocker)],
      reads: new Map([[subject.number, subject], [blocker.number, blocker]]),
      dependencies: [7],
    });

    const read = await reader.readPullRequest(cycleWith(subject), subject.number);

    expect(snapshotOf(read)).toBeNull();
    expect(targetedAuthorityRefusalDetail(read)).toMatch(
      /PR #201 closes target blocker issue #7 and its live evidence is incomplete/,
    );
  });

  it('refuses authority when only the index row shares the target head branch', async () => {
    const subject = target();
    const renamedTwin = rawPullRequest({
      number: 555,
      title: 'Duplicate branch PR renamed mid-cycle',
      body: '<!-- jinn-autopilot:v2 issue=88 branch=autopilot/42-moved -->',
      headRefName: 'autopilot/42-moved',
      headOid: RACING_LIVE_HEAD,
      closingIssueNumbers: [88],
      updatedAt: '2026-07-22T10:01:00.000Z',
    });
    const reader = vetoReader({
      // The cached index row still shows this PR on the target head branch.
      index: [
        indexEntry(subject),
        { ...indexEntry(renamedTwin), headRefName: 'autopilot/42' },
      ],
      reads: new Map([[subject.number, subject], [renamedTwin.number, renamedTwin]]),
    });

    const read = await reader.readPullRequest(cycleWith(subject), subject.number);

    expect(snapshotOf(read)).toBeNull();
    expect(targetedAuthorityRefusalDetail(read)).toMatch(
      /PR #555 shares the target head branch autopilot\/42 and its headRefName moved/,
    );
  });

  it('refuses authority when only the index row heads the target base chain', async () => {
    const subject = rawPullRequest({ baseRefName: 'autopilot/7' });
    const renamedParent = rawPullRequest({
      number: 201,
      title: 'Parent renamed mid-cycle',
      body: '<!-- jinn-autopilot:v2 issue=7 branch=autopilot/7-moved -->',
      headRefName: 'autopilot/7-moved',
      headOid: RACING_LIVE_HEAD,
      closingIssueNumbers: [7],
      updatedAt: '2026-07-22T10:01:00.000Z',
    });
    const reader = vetoReader({
      index: [
        indexEntry(subject),
        { ...indexEntry(renamedParent), headRefName: 'autopilot/7' },
      ],
      reads: new Map([[subject.number, subject], [renamedParent.number, renamedParent]]),
    });

    const read = await reader.readPullRequest(cycleWith(subject), subject.number);

    expect(snapshotOf(read)).toBeNull();
    expect(targetedAuthorityRefusalDetail(read)).toMatch(
      /PR #201 heads the target base chain branch autopilot\/7 and its headRefName moved/,
    );
  });

  it('refuses authority when a two-level base-chain grandparent races the cycle', async () => {
    const subject = rawPullRequest({ baseRefName: 'autopilot/7' });
    const parent = rawPullRequest({
      number: 201,
      title: 'Parent of the stack',
      body: '<!-- jinn-autopilot:v2 issue=7 branch=autopilot/7 -->',
      headRefName: 'autopilot/7',
      baseRefName: 'autopilot/9',
      headOid: 'f'.repeat(40),
      closingIssueNumbers: [7],
    });
    const grandparent = rawPullRequest({
      number: 301,
      title: 'Grandparent of the stack',
      body: '<!-- jinn-autopilot:v2 issue=9 branch=autopilot/9 -->',
      headRefName: 'autopilot/9',
      headOid: RACING_LIVE_HEAD,
      closingIssueNumbers: [9],
      updatedAt: '2026-07-22T10:01:00.000Z',
    });
    const reader = vetoReader({
      index: [
        indexEntry(subject),
        indexEntry(parent),
        indexEntry(grandparent, { headOid: RACING_INDEX_HEAD }),
      ],
      reads: new Map([
        [subject.number, subject],
        [parent.number, parent],
        [grandparent.number, grandparent],
      ]),
    });

    const read = await reader.readPullRequest(
      cycleWith(subject, parent),
      subject.number,
    );

    expect(snapshotOf(read)).toBeNull();
    expect(targetedAuthorityRefusalDetail(read)).toMatch(
      /PR #301 heads the target base chain branch autopilot\/9 and its headOid moved/,
    );
  });

  it('refuses authority when only the live read places a PR in the base chain', async () => {
    const subject = rawPullRequest({ baseRefName: 'autopilot/7' });
    const renamed = rawPullRequest({
      number: 201,
      title: 'Renamed parent branch',
      body: '<!-- jinn-autopilot:v2 issue=7 branch=autopilot/7 -->',
      headRefName: 'autopilot/7',
      headOid: RACING_LIVE_HEAD,
      closingIssueNumbers: [7],
      updatedAt: '2026-07-22T10:01:00.000Z',
    });
    const reader = vetoReader({
      // The cached index row still carries the pre-rename branch, so only the
      // live read shows this PR heading the target base chain.
      index: [
        indexEntry(subject),
        { ...indexEntry(renamed), headRefName: 'autopilot/7-old' },
      ],
      reads: new Map([[subject.number, subject], [renamed.number, renamed]]),
    });

    const read = await reader.readPullRequest(cycleWith(subject), subject.number);

    expect(snapshotOf(read)).toBeNull();
    expect(targetedAuthorityRefusalDetail(read)).toMatch(
      /PR #201 heads the target base chain branch autopilot\/7 and its headRefName moved/,
    );
  });

  it('refuses authority when a PR sharing the target head branch races the cycle', async () => {
    const subject = target();
    const twin = rawPullRequest({
      number: 555,
      title: 'Duplicate branch PR',
      body: '<!-- jinn-autopilot:v2 issue=88 branch=autopilot/42 -->',
      headRefName: 'autopilot/42',
      headOid: RACING_LIVE_HEAD,
      closingIssueNumbers: [88],
      updatedAt: '2026-07-22T10:01:00.000Z',
    });
    const reader = vetoReader({
      index: [indexEntry(subject), indexEntry(twin, { headOid: RACING_INDEX_HEAD })],
      reads: new Map([[subject.number, subject], [twin.number, twin]]),
    });

    const read = await reader.readPullRequest(cycleWith(subject), subject.number);

    expect(snapshotOf(read)).toBeNull();
    expect(targetedAuthorityRefusalDetail(read)).toMatch(
      /PR #555 shares the target head branch autopilot\/42 and its headOid moved/,
    );
  });

  // The mapping resolver counts every lifecycle marker in a body, so a second
  // marker naming the target issue makes the racing PR a mapping contender.
  it('refuses authority when a later body marker maps a racing PR onto the target issue', async () => {
    const subject = target();
    const contender = rawPullRequest({
      number: 102,
      title: 'Competing implementation',
      body: '<!-- jinn-autopilot:v2 issue=77 branch=autopilot/77 -->\n'
        + '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
      headRefName: 'feature/dup-42',
      headOid: RACING_LIVE_HEAD,
      labels: [],
      closingIssueNumbers: [],
      updatedAt: '2026-07-22T10:01:00.000Z',
    });
    const reader = vetoReader({
      index: [indexEntry(subject), indexEntry(contender, { headOid: RACING_INDEX_HEAD })],
      reads: new Map([[subject.number, subject], [contender.number, contender]]),
    });

    const read = await reader.readPullRequest(cycleWith(subject), subject.number);

    expect(snapshotOf(read)).toBeNull();
    expect(targetedAuthorityRefusalDetail(read)).toMatch(
      /PR #102 closes the target issue #42 and its headOid moved/,
    );
  });

  // The mapping resolver infers `autopilot/<N>` as evidence for issue N with no
  // closing reference and no marker at all.
  it('refuses authority when a racing PR stable branch names the target issue', async () => {
    const subject = rawPullRequest({ headRefName: 'feature/target-42' });
    const contender = rawPullRequest({
      number: 102,
      title: 'Stable branch squatter',
      body: 'No lifecycle marker here.',
      headRefName: 'autopilot/42',
      headOid: RACING_LIVE_HEAD,
      labels: [],
      closingIssueNumbers: [],
      updatedAt: '2026-07-22T10:01:00.000Z',
    });
    const reader = vetoReader({
      index: [indexEntry(subject), indexEntry(contender, { headOid: RACING_INDEX_HEAD })],
      reads: new Map([[subject.number, subject], [contender.number, contender]]),
    });

    const read = await reader.readPullRequest(cycleWith(subject), subject.number);

    expect(snapshotOf(read)).toBeNull();
    expect(targetedAuthorityRefusalDetail(read)).toMatch(
      /PR #102 closes the target issue #42 and its headOid moved/,
    );
  });

  // The target's mapping depends on the whole base chain being unambiguously
  // mapped, so a contender for a grandparent's issue decides the target's
  // mapping even though it closes none of the target's direct blockers.
  it('refuses authority when a racing PR contends for a base chain grandparent issue', async () => {
    const subject = rawPullRequest({ baseRefName: 'autopilot/7' });
    const parent = rawPullRequest({
      number: 201,
      title: 'Parent of the stack',
      body: '<!-- jinn-autopilot:v2 issue=7 branch=autopilot/7 -->',
      headRefName: 'autopilot/7',
      baseRefName: 'autopilot/9',
      headOid: 'f'.repeat(40),
      closingIssueNumbers: [7],
    });
    const grandparent = rawPullRequest({
      number: 301,
      title: 'Grandparent of the stack',
      body: '<!-- jinn-autopilot:v2 issue=9 branch=autopilot/9 -->',
      headRefName: 'autopilot/9',
      headOid: '0'.repeat(40),
      closingIssueNumbers: [9],
    });
    const contender = rawPullRequest({
      number: 401,
      title: 'Competing grandparent implementation',
      body: 'Closes #9',
      headRefName: 'feature/dup-9',
      headOid: RACING_LIVE_HEAD,
      labels: [],
      closingIssueNumbers: [9],
      updatedAt: '2026-07-22T10:01:00.000Z',
    });
    const base = cycleSnapshot();
    const cycle: GitHubLifecycleSnapshot = {
      ...base,
      project: {
        ...base.project,
        items: [
          base.project.items[0]!,
          { ...base.project.items[0]!, id: 'item-7', number: 7 },
          { ...base.project.items[0]!, id: 'item-9', number: 9 },
        ],
      },
      issues: [
        { ...base.issues[0]!, blockedOn: 'Another issue', blockedByIssues: [7] },
        {
          ...base.issues[0]!,
          number: 7,
          title: 'Parent issue',
          projectItemId: 'item-7',
          blockedOn: 'Another issue',
          blockedByIssues: [9],
        },
        {
          ...base.issues[0]!,
          number: 9,
          title: 'Grandparent issue',
          projectItemId: 'item-9',
        },
      ],
      pullRequests: [subject, parent, grandparent]
        .map((pr) => decodePullRequestSnapshot(pr)),
    };
    const reader = vetoReader({
      index: [
        indexEntry(subject),
        indexEntry(parent),
        indexEntry(grandparent),
        indexEntry(contender, { headOid: RACING_INDEX_HEAD }),
      ],
      reads: new Map([
        [subject.number, subject],
        [parent.number, parent],
        [grandparent.number, grandparent],
        [contender.number, contender],
      ]),
      dependencies: [7],
      blockedOn: 'Another issue',
    });

    const read = await reader.readPullRequest(cycle, subject.number);

    expect(snapshotOf(read)).toBeNull();
    expect(targetedAuthorityRefusalDetail(read)).toMatch(
      /PR #401 maps to target base chain issue #9 and its headOid moved/,
    );
  });

  /**
   * The cached row is the only evidence left when a contender's live read
   * comes back empty and its branch is off the stable pattern. Dropping the
   * cached arm of the contention predicate would classify this contender as
   * unrelated and let the target resolve against a PR that may already have
   * been retargeted onto the target issue.
   */
  it('refuses a cached same-issue contender whose live re-read returns nothing', async () => {
    const subject = target();
    const contender = rawPullRequest({
      number: 777,
      title: 'Competing target implementation',
      body: 'Competing work.',
      headRefName: 'feature/dup-42',
      headOid: RACING_LIVE_HEAD,
      labels: [],
      closingIssueNumbers: [42],
      updatedAt: '2026-07-22T09:45:00.000Z',
    });
    const reader = vetoReader({
      // The index row is ahead of the cycle-cached row, so the contender is
      // re-read; the re-read then finds nothing.
      index: [
        indexEntry(subject),
        indexEntry(contender, {
          headOid: RACING_INDEX_HEAD,
          updatedAt: '2026-07-22T10:01:00.000Z',
        }),
      ],
      reads: new Map<number, RawPullRequest | null>([
        [subject.number, subject],
        [contender.number, null],
      ]),
    });

    const read = await reader.readPullRequest(cycleWith(subject, contender), subject.number);

    expect(snapshotOf(read)).toBeNull();
    expect(targetedAuthorityRefusalDetail(read)).toMatch(
      /PR #777 closes the target issue #42 and the live re-read returned no PR/,
    );
  });

  /**
   * A two-deep stack whose grandparent sits on a branch the stable-branch
   * pattern cannot decode. Its issue closure is therefore knowable only from a
   * row — cached or live — never from the index row's branch name, which is
   * all the base chain walk holds for an ancestor missing from the cycle
   * cache. Every other base-chain case in this file stacks on `autopilot/N`,
   * where the branch name alone carries the closure and hides the gap.
   */
  const offPatternStack = () => ({
    subject: rawPullRequest({ baseRefName: 'autopilot/7' }),
    parent: rawPullRequest({
      number: 201,
      title: 'Parent of the stack',
      body: '<!-- jinn-autopilot:v2 issue=7 branch=autopilot/7 -->',
      headRefName: 'autopilot/7',
      baseRefName: 'feature/g',
      headOid: 'f'.repeat(40),
      closingIssueNumbers: [7],
    }),
    grandparent: rawPullRequest({
      number: 301,
      title: 'Grandparent of the stack',
      body: 'Grandparent work.',
      headRefName: 'feature/g',
      baseRefName: 'next',
      headOid: '0'.repeat(40),
      closingIssueNumbers: [9],
    }),
    contender: rawPullRequest({
      number: 401,
      title: 'Competing grandparent implementation',
      body: 'Closes #9',
      headRefName: 'feature/dup-9',
      headOid: RACING_LIVE_HEAD,
      labels: [],
      closingIssueNumbers: [9],
      updatedAt: '2026-07-22T10:01:00.000Z',
    }),
  });

  const stackedCycle = (
    ...pullRequests: readonly RawPullRequest[]
  ): GitHubLifecycleSnapshot => {
    const base = cycleSnapshot();
    return {
      ...base,
      project: {
        ...base.project,
        items: [
          base.project.items[0]!,
          { ...base.project.items[0]!, id: 'item-7', number: 7 },
          { ...base.project.items[0]!, id: 'item-9', number: 9 },
        ],
      },
      issues: [
        { ...base.issues[0]!, blockedOn: 'Another issue', blockedByIssues: [7] },
        {
          ...base.issues[0]!,
          number: 7,
          title: 'Parent issue',
          projectItemId: 'item-7',
          blockedOn: 'Another issue',
          blockedByIssues: [9],
        },
        {
          ...base.issues[0]!,
          number: 9,
          title: 'Grandparent issue',
          projectItemId: 'item-9',
        },
      ],
      pullRequests: pullRequests.map((pr) => decodePullRequestSnapshot(pr)),
    };
  };

  const offPatternReader = (input: {
    readonly stack: ReturnType<typeof offPatternStack>;
    readonly contenderIndexHeadOid?: string;
    readonly onReserve?: () => void;
    readonly onRead?: (number: number) => void;
  }) => {
    const { subject, parent, grandparent, contender } = input.stack;
    return vetoReader({
      onReserve: input.onReserve,
      onRead: input.onRead,
      index: [
        indexEntry(subject),
        indexEntry(parent),
        indexEntry(grandparent),
        indexEntry(contender, input.contenderIndexHeadOid === undefined
          ? {}
          : { headOid: input.contenderIndexHeadOid }),
      ],
      reads: new Map([
        [subject.number, subject],
        [parent.number, parent],
        [grandparent.number, grandparent],
        [contender.number, contender],
      ]),
      dependencies: [7],
      blockedOn: 'Another issue',
    });
  };

  // Control: the grandparent's closure is cached, so the contender is seen.
  it('refuses a racing contender for a cached off-pattern grandparent issue', async () => {
    const stack = offPatternStack();
    const reader = offPatternReader({ stack, contenderIndexHeadOid: RACING_INDEX_HEAD });

    const read = await reader.readPullRequest(
      stackedCycle(stack.subject, stack.parent, stack.grandparent),
      stack.subject.number,
    );

    expect(snapshotOf(read)).toBeNull();
    expect(targetedAuthorityRefusalDetail(read)).toMatch(
      /PR #401 maps to target base chain issue #9 and its headOid moved/,
    );
  });

  // Counterfactual: the same uncached grandparent, contender quiescent. The
  // contender survives into the composed snapshot and contends there.
  it('leaves an uncached off-pattern grandparent ambiguous against a quiescent contender', async () => {
    const stack = offPatternStack();
    const reader = offPatternReader({ stack });

    const snapshot = snapshotOf(await reader.readPullRequest(
      stackedCycle(stack.subject, stack.parent),
      stack.subject.number,
    ));

    expect(snapshot?.pullRequests.map((pr) => pr.number)).toEqual([101, 201, 301, 401]);
    expect(snapshot?.pullRequestMappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'ambiguous', prNumber: stack.subject.number }),
    ]));
  });

  // Probe: identical to the counterfactual except the contender is churning.
  // Churn must never buy authority that quiescence denies.
  it('refuses a racing contender for an uncached off-pattern grandparent issue', async () => {
    const stack = offPatternStack();
    const reader = offPatternReader({ stack, contenderIndexHeadOid: RACING_INDEX_HEAD });

    const read = await reader.readPullRequest(
      stackedCycle(stack.subject, stack.parent),
      stack.subject.number,
    );

    expect(snapshotOf(read)).toBeNull();
    expect(targetedAuthorityRefusalDetail(read)).toMatch(
      /PR #401 maps to target base chain issue #9 and its headOid moved/,
    );
  });

  /**
   * The base chain walk and the refresh loop both want the same ancestor rows.
   * An uncached off-pattern grandparent is wanted by both, so without the
   * memo it is fetched — and billed — twice for one targeted action. This
   * engine may not hammer the GitHub API, so one PR number costs one read.
   */
  it('reads each PR at most once across the walk and the refresh loop', async () => {
    const stack = offPatternStack();
    const reads: number[] = [];
    const reader = offPatternReader({ stack, onRead: (number) => reads.push(number) });

    const snapshot = snapshotOf(await reader.readPullRequest(
      stackedCycle(stack.subject, stack.parent),
      stack.subject.number,
    ));

    expect(snapshot?.pullRequests.map((pr) => pr.number)).toEqual([101, 201, 301, 401]);
    // #301 is wanted by the walk and again by the refresh loop; #201 is cached
    // fresh and wanted by neither.
    expect(reads).toEqual([101, 301, 401]);
  });

  /**
   * Every non-fresh PR read on this path — the walk's ancestors and the
   * refresh loop's index rows alike — funnels through the one reserve call in
   * `readLive`. That single call site is the whole of this path's reservation
   * accounting, so an unreserved read here is an unbilled read.
   */
  it('reserves rate limit quota before every live PR read', async () => {
    const stack = offPatternStack();
    const events: string[] = [];
    const reader = offPatternReader({
      stack,
      onReserve: () => events.push('reserve'),
      onRead: (number) => events.push(`read:${number}`),
    });

    const snapshot = snapshotOf(await reader.readPullRequest(
      stackedCycle(stack.subject, stack.parent),
      stack.subject.number,
    ));

    expect(snapshot).not.toBeNull();
    expect(events).toEqual([
      'reserve', 'read:101',
      'reserve', 'read:301',
      'reserve', 'read:401',
    ]);
  });

  /**
   * A cached ancestor row is only as good as the index says it is. Here the
   * grandparent picked up issue #9 after the cycle, so the cached row's
   * closure is empty and its off-pattern branch name carries nothing. Trusting
   * mere presence in the cache — rather than freshness against the index —
   * composes an empty closure and hides the contender racing for #9.
   */
  it('re-reads a stale cached base chain ancestor before composing its closure', async () => {
    const stack = offPatternStack();
    const staleGrandparent: RawPullRequest = {
      ...stack.grandparent,
      updatedAt: '2026-07-22T08:00:00.000Z',
      closingIssueNumbers: [],
    };
    const reads: number[] = [];
    const reader = offPatternReader({
      stack,
      contenderIndexHeadOid: RACING_INDEX_HEAD,
      onRead: (number) => reads.push(number),
    });

    const read = await reader.readPullRequest(
      stackedCycle(stack.subject, stack.parent, staleGrandparent),
      stack.subject.number,
    );

    expect(reads).toEqual([101, 301, 401]);
    expect(snapshotOf(read)).toBeNull();
    expect(targetedAuthorityRefusalDetail(read)).toMatch(
      /PR #401 maps to target base chain issue #9 and its headOid moved/,
    );
  });
});
