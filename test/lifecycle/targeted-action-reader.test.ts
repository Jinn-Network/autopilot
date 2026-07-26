import { describe, expect, it, vi } from 'vitest';
import {
  makeTargetedActionReader,
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
      readSnapshot: async () => snapshot,
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
  } satisfies ImplementationExecutorDeps);
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

    const snapshot = await reader.readPullRequest(cycleSnapshot(), 101);

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

  it('withholds stale-recovery authority when a blocker closes unmerged after the cycle', async () => {
    const fixture = staleRecoveryCycle();
    const calls: number[] = [];
    const reader = staleRecoveryReader(fixture, null, calls);

    const targeted = await reader.readStaleRecoveryPullRequest(fixture.cycle, 101);

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
    const targeted = await reader.readStaleRecoveryPullRequest(fixture.cycle, 101);
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

    const targeted = await reader.readStaleRecoveryPullRequest(fixture.cycle, 101);

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

    const targeted = await reader.readStaleRecoveryPullRequest(
      cycleWithoutMergedOutcome,
      2040,
    );
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

    const targeted = await reader.readStaleRecoveryPullRequest(fixture.cycle, 101);

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

    const targeted = await reader.readStaleRecoveryPullRequest(fixture.cycle, 101);

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

    const targeted = await reader.readStaleRecoveryPullRequest(fixture.cycle, 101);
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

    const targeted = await reader.readStaleRecoveryPullRequest(fixture.cycle, 101);

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

    const targeted = await reader.readStaleRecoveryPullRequest(
      withoutBlockerEvidence,
      101,
    );

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

    const targeted = await reader.readStaleRecoveryPullRequest(cycle, 101);

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
