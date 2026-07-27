import { describe, expect, it } from 'vitest';
import { CredentialPool, selectCredential } from '../../src/lifecycle/credentials.js';
import {
  makeProductionImplementationActionPort,
} from '../../src/lifecycle/implementation-executor-production.js';
import type { GitHubLifecycleSnapshot } from '../../src/lifecycle/snapshot.js';
import { buildMarketplaceTaskRequest } from '../../src/lifecycle/marketplace-task.js';
import { gitOid, gitRefName } from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));
const PARENT = gitOid('2'.repeat(40));
const TREE = gitOid('3'.repeat(40));
const CLAIM = gitOid('4'.repeat(40));

function snapshot(): GitHubLifecycleSnapshot {
  return {
    project: {
      items: [{
        id: 'PVTI_issue',
        contentType: 'Issue',
        number: 42,
        issueType: 'feat',
        status: 'Todo',
        priority: 'P1',
        effort: 'High',
        blockedOn: 'Nothing',
        blockedByIssues: [],
        sprintIterationId: null,
      }],
      rateLimit: { remaining: 4_000, used: 1, resetAt: '2026-07-20T13:00:00.000Z' },
      currentSprintIterationId: null,
    },
    issues: [{
      number: 42,
      title: 'Implement active lifecycle',
      body: 'Authoritative implementation issue body.',
      shape: 'feat',
      blockedOn: 'Nothing',
      blockedByIssues: [],
      effort: 'High',
      priority: 'P1',
      status: 'Todo',
      onBoard: true,
      author: 'trusted-author',
      projectItemId: 'PVTI_issue',
      inCurrentSprint: false,
    }],
    pullRequests: [],
    branches: [],
    diagnostics: [],
    lifecycle: {
      items: [{
        kind: 'issue',
        issueNumber: 42,
        v2Marked: false,
        projectStatus: 'Todo',
        labels: [],
        eligible: true,
        eligibilityReason: 'eligible',
      }],
    },
    capturedAt: '2026-07-20T12:00:00.000Z',
  };
}

describe('production implementation action port', () => {
  it('fetches a missing child parent before creating the claim commit', async () => {
    const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const pool = new CredentialPool([{
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'selected-secret',
    }]);
    const selection = selectCredential(pool, { phase: 'implement' });
    if (selection.status !== 'selected') throw new Error('selection failed');
    let treeReads = 0;
    const port = makeProductionImplementationActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/attempts',
      runnerId: 'runner-a',
      repositoryUrl: 'https://github.com/Jinn-Network/mono.git',
      credentials: pool,
      authorAllowlist: new Set(['trusted-author']),
      readSnapshot: async () => snapshot(),
      runner: async (command, args, options) => {
        if (command !== 'git') throw new Error(`unexpected ${command}`);
        calls.push({ args, env: options?.env });
        if (args.includes('rev-parse')) {
          treeReads += 1;
          if (treeReads === 1) throw new Error('fatal: Needed a single revision');
          return `${TREE}\n`;
        }
        if (args.includes('fetch')) return '';
        if (args.includes('commit-tree')) return `${CLAIM}\n`;
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    });

    await expect(port.createClaimCommit({
      claim: {
        kind: 'branch-claim',
        protocolVersion: 2,
        phase: 'fix',
        issueNumber: 2090,
        prNumber: 2014,
        attempt: '11111111-1111-4111-8111-111111111111',
        runner: 'runner-a',
        login: 'implementation-bot',
        expectedHead: PARENT,
        targetBase: gitRefName('next'),
        claimedAt: '2026-07-24T10:00:00.000Z',
      },
      parent: PARENT,
      parentFetchRef: gitRefName('pull/2014/head'),
      attempt: '11111111-1111-4111-8111-111111111111',
      credential: selection.credential,
    })).resolves.toBe(CLAIM);
    expect(calls.filter((call) => call.args.includes('fetch'))).toEqual([
      expect.objectContaining({
        args: expect.arrayContaining([
          'fetch',
          '--quiet',
          '--no-tags',
          'https://github.com/Jinn-Network/mono.git',
          'pull/2014/head',
        ]),
        env: expect.objectContaining({
          GH_TOKEN: 'selected-secret',
          GITHUB_TOKEN: '',
        }),
      }),
    ]);
    expect(treeReads).toBe(2);
  });

  it('rereads the exact durable state needed for pinned stale recovery', async () => {
    const base = snapshot();
    const current: GitHubLifecycleSnapshot = {
      ...base,
      project: {
        ...base.project,
        items: [{
          ...base.project.items[0]!,
          status: 'In Progress',
        }],
      },
      issues: [{
        ...base.issues[0]!,
        status: 'In Progress',
      }],
      pullRequests: [{
        number: 84,
        title: 'Implement active lifecycle',
        body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=existing/42 -->',
        author: 'implementation-bot',
        baseRefName: 'next',
        headRefName: 'existing/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T08:00:00.000Z',
        isDraft: true,
        state: 'OPEN',
        labels: ['engine:review'],
        closingIssueNumbers: [42],
        mergeability: 'UNKNOWN',
        mergeStateStatus: 'BLOCKED',
        checks: [],
        reviews: [],
      }, {
        number: 85,
        title: 'Duplicate implementation',
        body: 'Closes #42',
        author: 'implementation-bot',
        baseRefName: 'next',
        headRefName: 'other/42',
        headOid: PARENT,
        headCommittedAt: '2026-07-20T09:00:00.000Z',
        isDraft: true,
        state: 'OPEN',
        labels: ['engine:review'],
        closingIssueNumbers: [42],
        mergeability: 'UNKNOWN',
        mergeStateStatus: 'BLOCKED',
        checks: [],
        reviews: [],
      }],
      lifecycle: {
        items: [{
          kind: 'pull-request',
          issueNumber: 42,
          prNumber: 84,
          v2Marked: true,
          projectStatus: 'In Progress',
          labels: ['engine:review'],
          head: HEAD,
          headChangedAt: '2026-07-20T08:00:00.000Z',
          isDraft: true,
          merged: false,
          needsReview: true,
          approved: false,
          mergeState: 'blocked',
          branchClaim: {
            kind: 'branch-claim',
            protocolVersion: 2,
            phase: 'implement',
            issueNumber: 42,
            prNumber: 84,
            attempt: '11111111-1111-4111-8111-111111111111',
            runner: 'old-runner',
            login: 'implementation-bot',
            expectedHead: HEAD,
            targetBase: gitRefName('stack/base'),
            claimedAt: '2026-07-20T08:00:00.000Z',
          },
        }],
      },
    };
    const credentials = new CredentialPool([]);
    const port = makeProductionImplementationActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/attempts',
      runnerId: 'runner-a',
      credentials,
      authorAllowlist: new Set(['trusted-author']),
      readSnapshot: async () => current,
    });

    await expect(port.readIssue(42)).resolves.toMatchObject({
      body: 'Authoritative implementation issue body.',
      eligible: false,
      eligibilityDetail: 'Project status is In Progress',
      targetBase: 'next',
    });
    await expect(port.readStaleRecovery(42, 84)).resolves.toEqual(
      expect.objectContaining({
        projectStatus: 'In Progress',
        humanHold: false,
        claim: expect.objectContaining({
          attempt: '11111111-1111-4111-8111-111111111111',
          targetBase: 'stack/base',
        }),
        pullRequest: expect.objectContaining({
          state: 'OPEN',
          draft: true,
          number: 84,
          headRefName: 'existing/42',
          head: HEAD,
          baseRefName: 'next',
        }),
        openPullRequests: [
          expect.objectContaining({
            number: 84,
            headRefName: 'existing/42',
            head: HEAD,
            baseRefName: 'next',
          }),
          expect.objectContaining({
            number: 85,
            headRefName: 'other/42',
            head: PARENT,
            baseRefName: 'next',
          }),
        ],
      }),
    );
  });

  it('forwards exact target-base authority and marketplace preparation into transactional attempt creation', async () => {
    const credentials = new CredentialPool([{
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'selected-secret',
    }]);
    const selection = selectCredential(credentials, { phase: 'implement' });
    if (selection.status !== 'selected') throw new Error('selection failed');
    const attemptId = '11111111-1111-4111-8111-111111111111';
    const built = buildMarketplaceTaskRequest({
      workflow: 'implementation',
      repository: 'Jinn-Network/mono',
      language: 'typescript',
      verificationProfile: 'jinn-mono.v1',
      issueNumber: 42,
      prNumber: 84,
      targetBase: 'next',
      branch: 'autopilot/42',
      claimOid: CLAIM,
      expectedHead: CLAIM,
      v2AttemptId: attemptId,
      runnerId: 'runner-a',
      taskSnapshot: {
        title: 'Implement active lifecycle',
        body: 'Authoritative implementation issue body.',
        prBody: 'Closes #42',
        baseSha: PARENT,
        targetBaseOid: HEAD,
      },
      receiptAuthors: ['implementation-bot'],
      createdAt: Date.parse('2026-07-20T12:00:00.000Z'),
    });
    const preparation = {
      workflow: 'implementation' as const,
      baseSha: PARENT,
      request: built.request,
      agentSoftDeadline: built.agentSoftDeadline,
      adoptionDeadline: built.adoptionDeadline,
    };
    let workspaceOptions: unknown;
    const port = makeProductionImplementationActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/attempts',
      runnerId: 'runner-a',
      credentials,
      authorAllowlist: new Set(['trusted-author']),
      readSnapshot: async () => snapshot(),
      createWorkspace: async (options) => {
        workspaceOptions = options;
        return {
          attemptId,
          paths: {
            attemptDir: '/attempts/v2/runner-a/implement/issue-42',
            worktree: '/attempts/v2/runner-a/implement/issue-42/worktree',
            manifest: '/attempts/v2/runner-a/implement/issue-42/manifest.json',
            log: '/attempts/v2/runner-a/implement/issue-42/session.log',
            ghConfigDir: '/attempts/v2/runner-a/implement/issue-42/gh-config',
            askpass: '/attempts/v2/runner-a/implement/issue-42/askpass',
            tokenFile: '/attempts/v2/runner-a/implement/issue-42/gh-token',
          },
        } as never;
      },
    });

    await port.createAttempt({
      attemptId,
      issueNumber: 42,
      branch: gitRefName('autopilot/42'),
      targetBase: gitRefName('next'),
      targetBaseOid: HEAD,
      expectedHead: CLAIM,
      claimOid: CLAIM,
      prNumber: 84,
      selectedLogin: 'implementation-bot',
      credential: selection.credential,
      marketplacePreparation: preparation,
    });

    expect(workspaceOptions).toMatchObject({
      targetBaseOid: HEAD,
      marketplacePreparation: preparation,
    });
  });

  it('derives stale recovery target authority independently of a PR-only retarget', async () => {
    const base = snapshot();
    const current: GitHubLifecycleSnapshot = {
      ...base,
      project: {
        ...base.project,
        items: [{
          ...base.project.items[0]!,
          status: 'In Progress',
        }],
      },
      issues: [{
        ...base.issues[0]!,
        status: 'In Progress',
      }],
      pullRequests: [{
        number: 84,
        title: 'Implement active lifecycle',
        body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=existing/42 -->',
        author: 'implementation-bot',
        baseRefName: 'attacker/retarget',
        headRefName: 'existing/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T08:00:00.000Z',
        isDraft: true,
        state: 'OPEN',
        labels: ['engine:review'],
        closingIssueNumbers: [42],
        mergeability: 'UNKNOWN',
        mergeStateStatus: 'BLOCKED',
        checks: [],
        reviews: [],
      }],
      lifecycle: {
        items: [{
          kind: 'pull-request',
          issueNumber: 42,
          prNumber: 84,
          v2Marked: true,
          projectStatus: 'In Progress',
          labels: ['engine:review'],
          head: HEAD,
          headChangedAt: '2026-07-20T08:00:00.000Z',
          isDraft: true,
          merged: false,
          needsReview: true,
          approved: false,
          mergeState: 'blocked',
          branchClaim: {
            kind: 'branch-claim',
            protocolVersion: 2,
            phase: 'implement',
            issueNumber: 42,
            prNumber: 84,
            attempt: '11111111-1111-4111-8111-111111111111',
            runner: 'old-runner',
            login: 'implementation-bot',
            expectedHead: HEAD,
            targetBase: gitRefName('stacked/original-base'),
            claimedAt: '2026-07-20T08:00:00.000Z',
          },
        }],
      },
    };
    const port = makeProductionImplementationActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/attempts',
      runnerId: 'runner-a',
      credentials: new CredentialPool([]),
      authorAllowlist: new Set(['trusted-author']),
      readSnapshot: async () => current,
    });

    await expect(port.readStaleRecovery(42, 84)).resolves.toMatchObject({
      issue: {
        targetBase: 'next',
      },
      pullRequest: {
        baseRefName: 'attacker/retarget',
      },
      claim: {
        targetBase: 'stacked/original-base',
      },
    });
  });

  it('derives current stacking authority from the blocker PR rather than the implementation PR', async () => {
    const base = snapshot();
    const current: GitHubLifecycleSnapshot = {
      ...base,
      issues: [{
        ...base.issues[0]!,
        blockedOn: 'Another issue',
        blockedByIssues: [50],
      }],
      pullRequests: [{
        number: 83,
        title: 'Implement blocker',
        body: 'Closes #50',
        author: 'trusted-author',
        baseRefName: 'next',
        headRefName: 'stack/current-blocker',
        headOid: PARENT,
        headCommittedAt: '2026-07-20T07:00:00.000Z',
        isDraft: true,
        state: 'OPEN',
        labels: ['engine:review'],
        closingIssueNumbers: [50],
        mergeability: 'UNKNOWN',
        mergeStateStatus: 'BLOCKED',
        checks: [],
        reviews: [],
      }, {
        number: 84,
        title: 'Implement active lifecycle',
        body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=existing/42 -->',
        author: 'implementation-bot',
        baseRefName: 'attacker/retarget',
        headRefName: 'existing/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T08:00:00.000Z',
        isDraft: true,
        state: 'OPEN',
        labels: ['engine:review'],
        closingIssueNumbers: [42],
        mergeability: 'UNKNOWN',
        mergeStateStatus: 'BLOCKED',
        checks: [],
        reviews: [],
      }],
    };
    const port = makeProductionImplementationActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/attempts',
      runnerId: 'runner-a',
      credentials: new CredentialPool([]),
      authorAllowlist: new Set(['trusted-author']),
      readSnapshot: async () => current,
    });

    await expect(port.readIssue(42)).resolves.toMatchObject({
      targetBase: 'stack/current-blocker',
    });
  });

  it('withholds stale recovery target authority for missing, untrusted, or unresolved blockers', async () => {
    const base = snapshot();
    const current: GitHubLifecycleSnapshot = {
      ...base,
      project: {
        ...base.project,
        items: [{
          ...base.project.items[0]!,
          status: 'In Progress',
          blockedOn: 'Another issue',
          blockedByIssues: [50],
        }],
      },
      issues: [{
        ...base.issues[0]!,
        status: 'In Progress',
        blockedOn: 'Another issue',
        blockedByIssues: [50],
      }],
      pullRequests: [{
        number: 84,
        title: 'Implement active lifecycle',
        body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=existing/42 -->',
        author: 'implementation-bot',
        baseRefName: 'next',
        headRefName: 'existing/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T08:00:00.000Z',
        isDraft: true,
        state: 'OPEN',
        labels: ['engine:review'],
        closingIssueNumbers: [42],
        mergeability: 'UNKNOWN',
        mergeStateStatus: 'BLOCKED',
        checks: [],
        reviews: [],
      }],
      lifecycle: {
        items: [{
          kind: 'pull-request',
          issueNumber: 42,
          prNumber: 84,
          v2Marked: true,
          projectStatus: 'In Progress',
          labels: ['engine:review'],
          head: HEAD,
          headChangedAt: '2026-07-20T08:00:00.000Z',
          isDraft: true,
          merged: false,
          needsReview: true,
          approved: false,
          mergeState: 'blocked',
          branchClaim: {
            kind: 'branch-claim',
            protocolVersion: 2,
            phase: 'implement',
            issueNumber: 42,
            prNumber: 84,
            attempt: '11111111-1111-4111-8111-111111111111',
            runner: 'old-runner',
            login: 'implementation-bot',
            expectedHead: HEAD,
            targetBase: gitRefName('stacked/original-base'),
            claimedAt: '2026-07-20T08:00:00.000Z',
          },
        }],
      },
    };
    const port = makeProductionImplementationActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/attempts',
      runnerId: 'runner-a',
      credentials: new CredentialPool([]),
      authorAllowlist: new Set(['trusted-author']),
      readSnapshot: async () => current,
    });

    await expect(port.readIssue(42)).resolves.toMatchObject({
      eligible: false,
      targetBase: 'next',
    });
    await expect(port.readStaleRecovery(42, 84)).resolves.toMatchObject({
      issue: null,
      pullRequest: {
        baseRefName: 'next',
      },
      claim: {
        targetBase: 'stacked/original-base',
      },
    });

    const blockerPr = (
      number: number,
      issueNumber: number,
      headRefName: string,
      author = 'trusted-author',
    ): GitHubLifecycleSnapshot['pullRequests'][number] => ({
      number,
      title: `Implement blocker #${issueNumber}`,
      body: `Closes #${issueNumber}`,
      author,
      baseRefName: 'next',
      headRefName,
      headOid: PARENT,
      headCommittedAt: '2026-07-20T07:00:00.000Z',
      isDraft: true,
      state: 'OPEN',
      labels: ['engine:review'],
      closingIssueNumbers: [issueNumber],
      mergeability: 'UNKNOWN',
      mergeStateStatus: 'BLOCKED',
      checks: [],
      reviews: [],
    });
    const untrustedPort = makeProductionImplementationActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/attempts',
      runnerId: 'runner-a',
      credentials: new CredentialPool([]),
      authorAllowlist: new Set(['trusted-author']),
      readSnapshot: async () => ({
        ...current,
        pullRequests: [
          blockerPr(83, 50, 'stack/untrusted', 'outsider'),
          ...current.pullRequests,
        ],
      }),
    });
    await expect(untrustedPort.readStaleRecovery(42, 84)).resolves.toMatchObject({
      issue: null,
    });

    const unresolvedPort = makeProductionImplementationActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/attempts',
      runnerId: 'runner-a',
      credentials: new CredentialPool([]),
      authorAllowlist: new Set(['trusted-author']),
      readSnapshot: async () => ({
        ...current,
        project: {
          ...current.project,
          items: [{
            ...current.project.items[0]!,
            blockedByIssues: [50, 60],
          }],
        },
        issues: [{
          ...current.issues[0]!,
          blockedByIssues: [50, 60],
        }],
        pullRequests: [
          blockerPr(82, 50, 'stack/first'),
          blockerPr(83, 60, 'stack/second'),
          ...current.pullRequests,
        ],
      }),
    });
    await expect(unresolvedPort.readStaleRecovery(42, 84)).resolves.toMatchObject({
      issue: null,
    });
  });

  it('uses the selected credential and accepts a lost PR-create response only after exact readback', async () => {
    const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const pool = new CredentialPool([{
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'selected-secret',
    }]);
    const selection = selectCredential(pool, { phase: 'implement' });
    if (selection.status !== 'selected') throw new Error('selection failed');
    const port = makeProductionImplementationActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/attempts',
      runnerId: 'runner-a',
      credentials: pool,
      authorAllowlist: new Set(['trusted-author']),
      readSnapshot: async () => snapshot(),
      environment: { GITHUB_TOKEN: 'ambient-secret' },
      runner: async (command, args, options) => {
        if (command !== 'gh') throw new Error(`unexpected ${command}`);
        calls.push({ args, env: options?.env });
        if (args.includes('create')) throw new Error('response lost');
        if (args.includes('list')) {
          return JSON.stringify([{
            number: 84,
            headRefName: 'autopilot/42',
            headRefOid: HEAD,
            baseRefName: 'next',
            isDraft: true,
            labels: [{ name: 'engine:review' }],
            body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
          }]);
        }
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    });

    await expect(port.ensureDraftPullRequest({
      issueNumber: 42,
      branch: gitRefName('autopilot/42'),
      claimOid: HEAD,
      targetBase: gitRefName('next'),
      title: 'Implement active lifecycle',
      body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
      draft: true,
      label: 'engine:review',
      credential: selection.credential,
    })).resolves.toMatchObject({
      number: 84,
      head: HEAD,
      draft: true,
    });
    expect(calls.every((call) => call.env?.GH_TOKEN === 'selected-secret')).toBe(true);
    expect(calls.every((call) => call.env?.GITHUB_TOKEN === '')).toBe(true);
  });

  it('retries a temporarily missing PR after creation until exact readback', async () => {
    const pool = new CredentialPool([{
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'selected-secret',
    }]);
    const selection = selectCredential(pool, { phase: 'implement' });
    if (selection.status !== 'selected') throw new Error('selection failed');
    let listReads = 0;
    let creates = 0;
    const port = makeProductionImplementationActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/attempts',
      runnerId: 'runner-a',
      credentials: pool,
      authorAllowlist: new Set(['trusted-author']),
      readSnapshot: async () => snapshot(),
      runner: async (command, args) => {
        if (command !== 'gh') throw new Error(`unexpected ${command}`);
        if (args.includes('create')) {
          creates += 1;
          return 'https://github.com/Jinn-Network/mono/pull/84\n';
        }
        if (args.includes('list')) {
          listReads += 1;
          if (listReads <= 2) return '[]';
          return JSON.stringify([{
            number: 84,
            headRefName: 'autopilot/42',
            headRefOid: HEAD,
            baseRefName: 'next',
            isDraft: true,
            labels: [{ name: 'engine:review' }],
            body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
          }]);
        }
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    });

    await expect(port.ensureDraftPullRequest({
      issueNumber: 42,
      branch: gitRefName('autopilot/42'),
      claimOid: HEAD,
      targetBase: gitRefName('next'),
      title: 'Implement active lifecycle',
      body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
      draft: true,
      label: 'engine:review',
      credential: selection.credential,
    })).resolves.toMatchObject({ number: 84, head: HEAD, draft: true });
    expect(creates).toBe(1);
    expect(listReads).toBeGreaterThanOrEqual(3);
  });

  it('does not reclaim Project authority after a Human hold arrives', async () => {
    const baseline = snapshot();
    const current: GitHubLifecycleSnapshot = {
      ...baseline,
      project: {
        ...baseline.project,
        items: [{
          ...baseline.project.items[0]!,
          status: 'Human',
          blockedOn: 'Human',
        }],
      },
      branches: [{
        headRefName: 'autopilot/42',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T12:00:00.000Z',
        issueNumber: 42,
        claim: {
          kind: 'branch-claim',
          protocolVersion: 2,
          phase: 'implement',
          issueNumber: 42,
          attempt: '11111111-1111-4111-8111-111111111111',
          runner: 'runner-a',
          login: 'implementation-bot',
          expectedHead: gitOid('0'.repeat(40)),
          targetBase: gitRefName('next'),
          claimedAt: '2026-07-20T12:00:00.000Z',
        },
      }],
    };
    const pool = new CredentialPool([{
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'selected-secret',
    }]);
    const selection = selectCredential(pool, { phase: 'implement' });
    if (selection.status !== 'selected') throw new Error('selection failed');
    let mutations = 0;
    const port = makeProductionImplementationActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/attempts',
      runnerId: 'runner-a',
      credentials: pool,
      authorAllowlist: new Set(['trusted-author']),
      readSnapshot: async () => current,
      runner: async () => {
        mutations++;
        return '';
      },
    });

    await expect(port.setProjectInProgress(
      42,
      HEAD,
      selection.credential,
    )).rejects.toThrow('Human is dominant');
    expect(mutations).toBe(0);
  });

  it('resolves machine children from issue bodies in incremental snapshots', async () => {
    const marker = '<!-- jinn-autopilot:child pr=2065 kind=review-finding -->';
    const current: GitHubLifecycleSnapshot = {
      ...snapshot(),
      issues: [{
        number: 2069,
        title: 'Address review findings for PR #2065',
        body: `${marker}\n\nFindings`,
        labels: ['review-finding'],
        shape: 'fix',
        blockedOn: 'Nothing',
        blockedByIssues: [],
        effort: 'Low',
        priority: 'P2',
        status: 'Todo',
        onBoard: true,
        author: 'ritsukai',
        projectItemId: 'PVTI_child',
        inCurrentSprint: false,
      }],
      pullRequests: [{
        number: 2065,
        title: 'Parent PR',
        body: 'Closes #2044',
        author: 'ritsukai',
        baseRefName: 'next',
        headRefName: 'autopilot/2044',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T08:00:00.000Z',
        isDraft: false,
        state: 'OPEN',
        labels: ['engine:review'],
        closingIssueNumbers: [2044],
        mergeability: 'UNKNOWN',
        mergeStateStatus: 'BLOCKED',
        checks: [],
        reviews: [],
      }],
      lifecycle: {
        items: [{
          kind: 'issue',
          issueNumber: 2069,
          v2Marked: true,
          projectStatus: 'Todo',
          labels: ['review-finding'],
          eligible: true,
          eligibilityReason: 'eligible',
        }],
      },
    };
    const port = makeProductionImplementationActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/attempts',
      runnerId: 'runner-a',
      credentials: new CredentialPool([{
        login: 'implementation-bot',
        normalizedLogin: 'implementation-bot',
        implementationToken: 'selected-secret',
      }]),
      authorAllowlist: new Set(['ritsukai']),
      readSnapshot: async () => current,
    });

    await expect(port.readIssue(2069)).resolves.toMatchObject({
      eligible: true,
      child: { parentPr: 2065, kind: 'review-finding' },
    });
    await expect(port.readParentPullRequest!(2065)).resolves.toMatchObject({
      number: 2065,
      headRefName: 'autopilot/2044',
      head: HEAD,
    });
  });

  it('fails closed when a child kind label is present without a body marker', async () => {
    const current: GitHubLifecycleSnapshot = {
      ...snapshot(),
      issues: [{
        number: 2069,
        title: 'Address review findings for PR #2065',
        labels: ['review-finding'],
        shape: 'fix',
        blockedOn: 'Nothing',
        blockedByIssues: [],
        effort: 'Low',
        priority: 'P2',
        status: 'Todo',
        onBoard: true,
        author: 'ritsukai',
        projectItemId: 'PVTI_child',
        inCurrentSprint: false,
      }],
      lifecycle: {
        items: [{
          kind: 'issue',
          issueNumber: 2069,
          v2Marked: true,
          projectStatus: 'Todo',
          labels: ['review-finding'],
          eligible: true,
          eligibilityReason: 'eligible',
        }],
      },
    };
    const port = makeProductionImplementationActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/attempts',
      runnerId: 'runner-a',
      credentials: new CredentialPool([]),
      authorAllowlist: new Set(['ritsukai']),
      readSnapshot: async () => current,
    });

    await expect(port.readIssue(2069)).resolves.toMatchObject({
      eligible: false,
    });
  });
});
