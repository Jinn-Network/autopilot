// @ts-nocheck — Stage 5 leftover fixtures for deleted merge-prep/review-fix/project APIs.
import { describe, expect, it, vi } from 'vitest';
import type { PolledIssue } from '../../src/dispatcher/types.js';
import {
  buildGitHubLifecycleSnapshot,
  SnapshotDecodeError,
  type GitHubLifecycleReader,
  type PullRequestPage,
} from '../../src/lifecycle/snapshot.js';
import { deriveLifecycle, planCycle } from '../../src/lifecycle/lifecycle.js';
import { FULL_SCAN_RESERVE } from '../../src/lifecycle/github-usage.js';
import { planProjection } from '../../src/lifecycle/projection.js';
import { executeProjectionPlan } from '../../src/lifecycle/reconciler.js';
import { executeReviewAction } from '../../src/lifecycle/review-executor.js';
import { CredentialPool, selectCredential } from '../../src/lifecycle/credentials.js';
import {
  formatAutomatedReviewMarker,
  parseHumanCommentEvidence,
} from '../../src/lifecycle/codecs.js';
import { makeProductionReconciliationWriter } from '../../src/lifecycle/reconciliation-writer-production.js';
import { makeProductionReviewActionPort } from '../../src/lifecycle/review-executor-production.js';
import { makeProductionMergeActionPort } from '../../src/lifecycle/merge-executor-production.js';
import { executeMergeAction } from '../../src/lifecycle/merge-executor.js';
import { derivePaintedStatus } from '../../src/lifecycle/board-painter.js';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REVIEW_REF = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function issue(): PolledIssue {
  return {
    number: 42,
    title: 'Lifecycle work',
    shape: 'feat',
    blockedOn: 'Nothing',
    blockedByIssues: [],
    effort: 'Medium',
    priority: 'P1',
    status: 'In Review',
    onBoard: true,
    author: 'trusted',
    projectItemId: 'PVTI_42',
    inCurrentSprint: true,
  };
}

function page(after: string | null): PullRequestPage {
  if (after === null) {
    return {
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: 'page-2' },
    };
  }
  return {
    nodes: [{
      number: 101,
      title: 'feat: lifecycle work',
      body: 'Closes #42',
      author: 'trusted',
      baseRefName: 'next',
      headRefName: 'autopilot/42',
      headOid: HEAD,
      headCommittedAt: '2026-07-20T09:00:00.000Z',
      isDraft: false,
      state: 'OPEN',
      labels: ['engine:review'],
      closingIssueNumbers: [42],
      mergeability: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      reviews: [{
        reviewer: 'reviewer',
        state: 'APPROVED',
        commitId: HEAD,
        body: '<!-- jinn-autopilot-review:v2 generation=22222222-2222-4222-8222-222222222222 attempt=33333333-3333-4333-8333-333333333333 intent=44444444-4444-4444-8444-444444444444 reviewer=reviewer head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa verdict=APPROVE -->',
        submittedAt: '2026-07-20T10:00:00.000Z',
      }],
      branchClaimTrailers: null,
      reviewClaim: {
        oid: REVIEW_REF,
        payload: JSON.stringify({
          protocolVersion: 2,
          prNumber: 101,
          generation: '22222222-2222-4222-8222-222222222222',
          attempt: '33333333-3333-4333-8333-333333333333',
          reviewer: 'reviewer',
          head: HEAD,
          state: 'verdict-intent',
          recordedAt: '2026-07-20T09:00:00.000Z',
          verdict: {
            marker: '44444444-4444-4444-8444-444444444444',
            state: 'APPROVE',
          },
        }),
      },
      humanReason: null,
      mergedAt: null,
      mergeCommitOid: null,
    }],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
}

function reader(overrides: Partial<GitHubLifecycleReader> = {}): GitHubLifecycleReader {
  return {
    readGraphQlRemaining: async () => 4_000,
    readProjectSnapshot: async () => ({
      items: [{
        id: 'PVTI_42',
        number: 42,
        contentType: 'Issue',
        status: 'In Review',
        priority: 'P1',
        effort: 'Medium',
        blockedOn: 'Nothing',
        issueType: 'feat',
        blockedByIssues: [],
        sprintIterationId: 'sprint',
      }],
      rateLimit: {
        remaining: 4_000,
        used: 1_000,
        resetAt: '2026-07-20T13:00:00.000Z',
      },
      currentSprintIterationId: 'sprint',
    }),
    readIssues: async () => [issue()],
    readPullRequests: async (cursor) => page(cursor),
    githubUsage: () => ({
      graphqlRequests: 3,
      graphqlCost: 20,
      graphqlRemaining: 3_980,
      graphqlResetAt: '2026-07-20T13:00:00.000Z',
      restRequests: 2,
      restNotModified: 0,
      cacheHits: 0,
    }),
    ...overrides,
  };
}

describe('buildGitHubLifecycleSnapshot', () => {
  it('uses the canonical resolver to enroll the complete #2084 stacked mapping once', async () => {
    const stackedIssue = {
      ...issue(),
      number: 2084,
      blockedOn: 'Another issue' as const,
      blockedByIssues: [2083],
    };
    const stackedPr = {
      ...page('page-2').nodes[0]!,
      number: 84,
      body: '<!-- jinn-autopilot:v2 issue=2084 branch=autopilot/2084 -->',
      baseRefName: 'autopilot/2083',
      headRefName: 'autopilot/2084',
      closingIssueNumbers: [],
      reviews: [],
      reviewClaim: null,
      branchClaimTrailers: [
        'Jinn-Autopilot-Protocol: 2',
        'Jinn-Autopilot-Phase: implement',
        'Jinn-Autopilot-Issue: 2084',
        'Jinn-Autopilot-PR: 84',
        'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
        'Jinn-Autopilot-Runner: runner-a',
        'Jinn-Autopilot-Login: trusted',
        `Jinn-Autopilot-Expected-Head: ${HEAD}`,
        'Jinn-Autopilot-Target-Base: autopilot/2083',
        'Jinn-Autopilot-Claimed-At: 2026-07-20T08:00:00.000Z',
        'Jinn-Autopilot-Phase-Complete: true',
      ].join('\n'),
    };
    const source = reader({
      readProjectSnapshot: async () => ({
        ...(await reader().readProjectSnapshot()),
        items: [{
          id: 'PVTI_2084',
          number: 2084,
          contentType: 'Issue' as const,
          status: 'In Review' as const,
          priority: 'P1' as const,
          effort: 'Medium' as const,
          blockedOn: 'Another issue' as const,
          issueType: 'feat' as const,
          blockedByIssues: [2083],
          sprintIterationId: 'sprint',
        }],
      }),
      readIssues: async () => [stackedIssue],
      readPullRequests: async () => ({
        nodes: [stackedPr],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
      readBranchClaims: async () => [{
        issueNumber: 2084,
        headRefName: 'autopilot/2084',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T09:00:00.000Z',
        claimTrailers: [
          'Jinn-Autopilot-Protocol: 2',
          'Jinn-Autopilot-Phase: implement',
          'Jinn-Autopilot-Issue: 2084',
          'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
          'Jinn-Autopilot-Runner: runner-a',
          'Jinn-Autopilot-Login: trusted',
          `Jinn-Autopilot-Expected-Head: ${HEAD}`,
          'Jinn-Autopilot-Target-Base: autopilot/2083',
          'Jinn-Autopilot-Claimed-At: 2026-07-20T08:00:00.000Z',
        ].join('\n'),
      }],
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
      defaultBranch: 'next',
    });

    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.pullRequestMappings).toEqual([{
      status: 'resolved',
      prNumber: 84,
      issueNumber: 2084,
      expectedBaseRefName: 'autopilot/2083',
      evidence: 'stacked-empty-closing',
    }]);
    expect(snapshot.lifecycle.items).toEqual([
      expect.objectContaining({
        kind: 'pull-request',
        issueNumber: 2084,
        prNumber: 84,
        expectedBaseRefName: 'autopilot/2083',
      }),
    ]);
    const view = deriveLifecycle(
      snapshot.lifecycle,
      new Date('2026-07-20T12:00:00.000Z'),
      2 * 60 * 60 * 1_000,
    );
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({ phase: 'awaiting-review' });
    expect(planCycle(view, {
      implementationSlots: 0,
      reviewSlots: 1,
      usableCredentialLanes: 1,
    }, 'active')).toEqual([{
      kind: 'claim-review',
      issueNumber: 2084,
      prNumber: 84,
      head: HEAD,
    }]);
    const approved = snapshot.lifecycle.items[0];
    if (approved?.kind !== 'pull-request') throw new Error('stacked fixture PR missing');
    const mergeView = deriveLifecycle({
      items: [{
        ...approved,
        needsReview: false,
        approved: true,
        mergeState: 'clean',
        checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      }],
    }, new Date('2026-07-20T12:00:00.000Z'), 2 * 60 * 60 * 1_000);
    expect(planCycle(mergeView, {
      implementationSlots: 0,
      reviewSlots: 0,
      usableCredentialLanes: 1,
    }, 'active')).toEqual([{
      kind: 'merge',
      issueNumber: 2084,
      prNumber: 84,
      head: HEAD,
      expectedBaseRefName: 'autopilot/2083',
    }]);
  });

  it('runs future #2084 comment-only recovery through production write, review, and exact pinned-base merge seams', async () => {
    const generation = '22222222-2222-4222-8222-222222222222';
    const attempt = '33333333-3333-4333-8333-333333333333';
    const newGeneration = '44444444-4444-4444-8444-444444444444';
    const newAttempt = '55555555-5555-4555-8555-555555555555';
    const newReviewOid = 'cccccccccccccccccccccccccccccccccccccccc';
    const intent = '66666666-6666-4666-8666-666666666666';
    const mappingReason = {
      phase: 'implementing' as const,
      code: 'branch-mapping-ambiguous' as const,
      detail: 'A competing PR made the #2084 mapping ambiguous.',
    };
    let duplicatePresent = true;
    let projectStatus: 'Human' | 'In Review' | 'Done' = 'In Review';
    const draft = false;
    const humanComments = [];
    let reviewState: 'human' | 'stale' | 'active' | 'terminal-approved' = 'human';
    let reviewOid = REVIEW_REF;
    let nativeReviews = [];
    let checks = [];
    let mergeability = 'UNKNOWN';
    let mergeStateStatus = 'BLOCKED';
    const reviewPayload = () => JSON.stringify({
      protocolVersion: 2,
      prNumber: 84,
      generation: reviewState === 'active' || reviewState === 'terminal-approved'
        ? newGeneration
        : generation,
      attempt: reviewState === 'active' || reviewState === 'terminal-approved'
        ? newAttempt
        : attempt,
      reviewer: reviewState === 'active' || reviewState === 'terminal-approved'
        ? 'review-bot'
        : 'maintenance-bot',
      head: HEAD,
      state: reviewState,
      recordedAt: '2026-07-20T11:00:00.000Z',
      ...(reviewState === 'terminal-approved'
        ? { verdict: { marker: intent, state: 'APPROVE' } }
        : {}),
    });
    const targetPr = () => ({
      ...page('page-2').nodes[0]!,
      number: 84,
      body: '<!-- jinn-autopilot:v2 issue=2084 branch=autopilot/2084 -->',
      baseRefName: 'autopilot/2083',
      headRefName: 'autopilot/2084',
      closingIssueNumbers: [],
      isDraft: draft,
      labels: ['engine:review'],
      humanIssueNumber: humanComments.length === 0
        ? null
        : parseHumanCommentEvidence(humanComments.at(-1).body)?.issueNumber ?? null,
      humanAuthor: humanComments.at(-1)?.user.login ?? null,
      humanHead: humanComments.length === 0
        ? null
        : parseHumanCommentEvidence(humanComments.at(-1).body)?.head ?? null,
      humanGeneration: humanComments.length === 0
        ? null
        : parseHumanCommentEvidence(humanComments.at(-1).body)?.generation ?? null,
      humanLabelActor: null,
      draftActor: null,
      humanReason: humanComments.length === 0
        ? null
        : parseHumanCommentEvidence(humanComments.at(-1).body)?.reason ?? null,
      reviews: nativeReviews,
      checks,
      mergeability,
      mergeStateStatus,
      reviewClaim: {
        oid: reviewOid,
        payload: reviewPayload(),
      },
      branchClaimTrailers: [
        'Jinn-Autopilot-Protocol: 2',
        'Jinn-Autopilot-Phase: implement',
        'Jinn-Autopilot-Issue: 2084',
        'Jinn-Autopilot-PR: 84',
        'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
        'Jinn-Autopilot-Runner: runner-a',
        'Jinn-Autopilot-Login: trusted',
        `Jinn-Autopilot-Expected-Head: ${HEAD}`,
        'Jinn-Autopilot-Target-Base: autopilot/2083',
        'Jinn-Autopilot-Claimed-At: 2026-07-20T08:00:00.000Z',
        'Jinn-Autopilot-Phase-Complete: true',
      ].join('\n'),
    });
    const source = reader({
      readProjectSnapshot: async () => ({
        ...(await reader().readProjectSnapshot()),
        items: [{
          id: 'PVTI_2084',
          number: 2084,
          contentType: 'Issue',
          status: projectStatus,
          priority: 'P1',
          effort: 'Medium',
          blockedOn: 'Another issue',
          issueType: 'feat',
          blockedByIssues: [2083],
          sprintIterationId: 'sprint',
        }],
      }),
      readIssues: async () => [{
        ...issue(),
        number: 2084,
        status: projectStatus,
        blockedOn: 'Another issue',
        blockedByIssues: [2083],
      }],
      readPullRequests: async () => ({
        nodes: [
          targetPr(),
          ...(duplicatePresent ? [{
            ...page('page-2').nodes[0]!,
            number: 85,
            title: 'competing unlabeled PR',
            body: 'Closes #2084',
            headRefName: 'feature/duplicate-2084',
            closingIssueNumbers: [2084],
            labels: [],
            reviewClaim: null,
            branchClaimTrailers: null,
          }] : []),
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
      readBranchClaims: async () => [{
        issueNumber: 2084,
        headRefName: 'autopilot/2084',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T09:00:00.000Z',
        claimTrailers: [
          'Jinn-Autopilot-Protocol: 2',
          'Jinn-Autopilot-Phase: implement',
          'Jinn-Autopilot-Issue: 2084',
          'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
          'Jinn-Autopilot-Runner: runner-a',
          'Jinn-Autopilot-Login: trusted',
          `Jinn-Autopilot-Expected-Head: ${HEAD}`,
          'Jinn-Autopilot-Target-Base: autopilot/2083',
          'Jinn-Autopilot-Claimed-At: 2026-07-20T08:00:00.000Z',
        ].join('\n'),
      }],
    });
    const build = () => buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
      defaultBranch: 'next',
      machineAuthorLogins: new Set(['maintenance-bot', 'review-bot']),
    });
    const credentials = new CredentialPool([{
      login: 'maintenance-bot',
      normalizedLogin: 'maintenance-bot',
      implementationToken: 'maintenance-secret',
    }, {
      login: 'review-bot',
      normalizedLogin: 'review-bot',
      reviewToken: 'review-secret',
    }]);
    const selected = selectCredential(credentials, { phase: 'implement' });
    if (selected.status !== 'selected') throw new Error('maintenance credential missing');
    const staleReviewOid = 'dddddddddddddddddddddddddddddddddddddddd';
    let reviewRefPushes = 0;
    let sharedMutations = 0;
    const rawTarget = () => {
      const pr = targetPr();
      return {
        state: pr.state,
        headRefName: pr.headRefName,
        headOid: pr.headOid,
        baseRefName: pr.baseRefName,
        isDraft: pr.isDraft,
        labels: pr.labels,
        body: pr.body,
        closingIssueNumbers: pr.closingIssueNumbers,
        humanIssueNumber: pr.humanIssueNumber,
        humanAuthor: pr.humanAuthor,
        humanHead: pr.humanHead,
        humanGeneration: pr.humanGeneration,
        humanLabelActor: pr.humanLabelActor,
        draftActor: pr.draftActor,
        humanReason: pr.humanReason,
        reviewClaim: pr.reviewClaim,
      };
    };
    const writerFor = (cycleSnapshot) => makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      cycleSnapshot,
      readCanonicalSnapshot: async () => build(),
      readPullRequestByNumber: async (prNumber) => (
        prNumber === 84 ? rawTarget() : null
      ),
      readProjectItemForReconciliation: async (issueNumber) => (
        issueNumber === 2084
          ? { id: 'PVTI_2084', status: projectStatus, blockedOn: 'Another issue' }
          : null
      ),
      readBranchHeadByName: async (headRefName) => (
        headRefName === 'autopilot/2084' ? HEAD : null
      ),
      readIssueByNumber: async (issueNumber) => (
        issueNumber === 2084
          ? {
              number: 2084,
              title: 'stacked lifecycle work',
              open: true,
              author: 'trusted',
              labels: [],
            }
          : null
      ),
      readBlockedByIssueNumbers: async (issueNumber) => (
        issueNumber === 2084 ? [2083] : []
      ),
      readOpenPullRequestsByIssue: async (issueNumber) => (
        issueNumber !== 2084 || !duplicatePresent
          ? []
          : [{
              number: 85,
              headRefName: 'feature/duplicate-2084',
              headOid: HEAD,
              baseRefName: 'next',
              draft: false,
              labels: [],
              body: 'Closes #2084',
            }]
      ),
      credential: selected.credential,
      credentials,
      now: () => new Date('2026-07-20T12:00:00.000Z'),
      runner: async (_command, args) => {
        if (args.includes('hash-object')) return `${'1'.repeat(40)}\n`;
        if (args.includes('write-tree')) return `${'2'.repeat(40)}\n`;
        if (args.includes('commit-tree')) return `${staleReviewOid}\n`;
        if (args.includes('rev-list')) return `${staleReviewOid} ${REVIEW_REF}`;
        if (args.includes('ls-remote')) {
          return `${reviewOid}\trefs/jinn-autopilot/review-claims/v1/84\n`;
        }
        if (args.includes('push')) {
          reviewRefPushes += 1;
          reviewState = 'stale';
          reviewOid = staleReviewOid;
          return '';
        }
        if (args.includes('read-tree') || args.includes('update-index')) return '';
        if (
          (args[0] === 'pr' && (args[1] === 'edit' || args[1] === 'ready'))
          || (args[0] === 'api' && args.includes('DELETE'))
        ) {
          sharedMutations += 1;
          return '';
        }
        if (args[0] === 'api' && args[1]?.includes('/issues/84/comments')) {
          return JSON.stringify(humanComments);
        }
        if (args[0] === 'pr' && args[1] === 'comment') {
          humanComments.push({
            id: humanComments.length + 1,
            body: args[args.indexOf('--body') + 1],
            user: { login: 'maintenance-bot' },
          });
          return '';
        }
        throw new Error(`unexpected production writer command: ${args.join(' ')}`);
      },
    });

    const ambiguous = await build();
    expect(ambiguous.pullRequestMappings?.find((mapping) => mapping.prNumber === 84))
      .toMatchObject({ status: 'ambiguous' });
    const diagnosticPlan = planProjection({
      view: deriveLifecycle(
        ambiguous.lifecycle,
        new Date('2026-07-20T12:00:00.000Z'),
        2 * 60 * 60_000,
      ),
      pullRequests: ambiguous.pullRequests.map((pr) => ({
        number: pr.number,
        reviewRefOid: pr.reviewClaim?.oid,
        ...(pr.reviewClaim === undefined ? {} : {
          reviewClaim: {
            head: pr.reviewClaim.record.head,
            generation: pr.reviewClaim.record.generation,
            state: pr.reviewClaim.record.state,
          },
        }),
      })),
      orphanBranchClaims: [],
      mappingDiagnostics: ambiguous.diagnostics,
    });
    expect(diagnosticPlan.actions).toEqual([expect.objectContaining({
      kind: 'ensure-human-comment',
      issueNumber: 2084,
      prNumber: 84,
      expectedHead: HEAD,
    })]);
    const diagnosticResult = await executeProjectionPlan(
      diagnosticPlan,
      writerFor(ambiguous),
    );
    expect(diagnosticResult.results).toEqual([{
      action: diagnosticPlan.actions[0],
      outcome: 'applied',
    }]);
    expect(humanComments).toHaveLength(1);
    expect(humanComments[0].body).toContain('issue=2084');
    expect(humanComments[0].body).toContain(`head=${HEAD}`);
    expect(humanComments[0].body).toContain(`generation=${generation}`);
    expect(sharedMutations).toBe(0);

    duplicatePresent = false;
    const repairable = await build();
    const repairPlan = planProjection({
      view: deriveLifecycle(
        repairable.lifecycle,
        new Date('2026-07-20T12:00:00.000Z'),
        2 * 60 * 60_000,
      ),
      pullRequests: repairable.pullRequests.map((pr) => ({
        number: pr.number,
        reviewRefOid: pr.reviewClaim?.oid,
      })),
      orphanBranchClaims: [],
      mappingDiagnostics: repairable.diagnostics,
    });
    expect(repairPlan.actions).toEqual([expect.objectContaining({
      kind: 'repair-obsolete-mapping-human',
      issueNumber: 2084,
      prNumber: 84,
      expectedHead: HEAD,
      expectedGeneration: generation,
      expectedAuthor: 'maintenance-bot',
    })]);

    const reconciliation = await executeProjectionPlan(
      repairPlan,
      writerFor(repairable),
    );
    expect(reconciliation.results).toEqual([{
      action: repairPlan.actions[0],
      outcome: 'applied',
    }]);
    expect(reviewRefPushes).toBe(1);
    expect(reviewState).toBe('stale');
    expect(reviewOid).toBe(staleReviewOid);
    expect(humanComments).toHaveLength(1);
    expect(sharedMutations).toBe(0);

    // The normal painter sees a non-draft open PR and no shared Human surface.
    expect(derivePaintedStatus({
      issueOpen: true,
      merged: false,
      labels: ['engine:review'],
      hasClaimBranch: true,
      hasOpenDraftPr: false,
      hasOpenNonDraftPr: true,
      hasOpenChildren: false,
    })).toBe('In Review');
    const repainted = await build();
    const reviewView = deriveLifecycle(
      repainted.lifecycle,
      new Date('2026-07-20T12:00:00.000Z'),
      2 * 60 * 60_000,
    );
    const scheduled = planCycle(reviewView, {
      implementationSlots: 0,
      reviewSlots: 1,
      usableCredentialLanes: 1,
    }, 'active');
    expect(scheduled).toEqual([{
      kind: 'claim-review',
      issueNumber: 2084,
      prNumber: 84,
      head: HEAD,
    }]);

    let spawned = 0;
    const projectGraphQl = () => JSON.stringify({
      data: {
        rateLimit: {
          remaining: 4999,
          used: 1,
          resetAt: '2026-07-20T13:00:00.000Z',
        },
        organization: {
          projectV2: {
            sprintField: null,
            items: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{
                id: 'PVTI_2084',
                content: {
                  __typename: 'Issue',
                  number: 2084,
                  repository: { nameWithOwner: 'Jinn-Network/mono' },
                  issueType: { name: 'feat' },
                  blockedBy: { nodes: [{ number: 2083 }] },
                },
                status: { name: projectStatus },
                priority: { name: 'P1' },
                effort: { name: 'Medium' },
                blockedOn: { name: 'Another issue' },
                sprint: null,
              }],
            },
          },
        },
      },
    });
    const reviewPort = makeProductionReviewActionPort({
      repositoryPath: '/repo',
      worktreeBase: '/worktrees',
      runnerId: 'runner-a',
      readSnapshot: async () => build(),
      changedFiles: async () => [],
      codeownersText: () => '',
      createWorkspace: async (input) => ({
        attemptId: input.attemptId,
        paths: {
          worktree: '/tmp/review/worktree',
          manifest: '/tmp/review/manifest.json',
          log: '/tmp/review/session.log',
          ghConfigDir: '/tmp/review/gh-config',
          askpass: '/tmp/review/askpass',
        },
      }),
      runner: async (_command, args) => {
        if (args.some((arg) => arg.endsWith('/pulls/84'))) {
          return JSON.stringify({
            changed_files: 0,
            head: { sha: HEAD },
            base: { ref: 'autopilot/2083', sha: 'e'.repeat(40) },
          });
        }
        if (args.includes('hash-object')) return `${'3'.repeat(40)}\n`;
        if (args.includes('write-tree')) return `${'4'.repeat(40)}\n`;
        if (args.includes('commit-tree')) return `${newReviewOid}\n`;
        if (args.includes('rev-list')) return `${newReviewOid} ${staleReviewOid}`;
        if (args.includes('ls-remote')) {
          return `${reviewOid}\trefs/jinn-autopilot/review-claims/v1/84\n`;
        }
        if (args.includes('push')) {
          reviewState = 'active';
          reviewOid = newReviewOid;
          return '';
        }
        if (args.includes('read-tree') || args.includes('update-index')) return '';
        if (args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({
            headRefOid: HEAD,
            labels: [{ name: 'engine:review' }],
            isDraft: false,
          });
        }
        if (args[0] === 'api' && args[1] === 'graphql') return projectGraphQl();
        throw new Error(`unexpected production review command: ${args.join(' ')}`);
      },
    });
    const reviewResult = await executeReviewAction({
      prNumber: 84,
      expectedHead: HEAD,
    }, {
      ...reviewPort,
      credentials,
      startSession: async () => {
        spawned += 1;
        return { status: 'started', backend: 'local', pid: 42 };
      },
      escalateHuman: async () => {
        throw new Error('fresh repaired review must not escalate');
      },
      ambientEnvironment: {},
      nextAttemptId: () => newAttempt,
      nextGeneration: () => newGeneration,
      runnerId: 'runner-a',
      now: () => new Date('2026-07-20T12:00:00.000Z'),
      staleAfterMs: 2 * 60 * 60_000,
      sleep: async () => {},
    });
    expect(reviewResult).toMatchObject({
      status: 'spawned',
      prNumber: 84,
      head: HEAD,
      generation: newGeneration,
    });
    expect(spawned).toBe(1);

    reviewState = 'terminal-approved';
    nativeReviews = [{
      reviewer: 'review-bot',
      state: 'APPROVED',
      commitId: HEAD,
      body: formatAutomatedReviewMarker({
        generation: newGeneration,
        attempt: newAttempt,
        intent,
        reviewer: 'review-bot',
        head: HEAD,
        verdict: 'APPROVE',
      }),
      submittedAt: '2026-07-20T12:10:00.000Z',
    }];
    checks = [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }];
    mergeability = 'MERGEABLE';
    mergeStateStatus = 'CLEAN';
    const terminal = await build();
    const mergeActions = planCycle(deriveLifecycle(
      terminal.lifecycle,
      new Date('2026-07-20T12:15:00.000Z'),
      2 * 60 * 60_000,
    ), {
      implementationSlots: 0,
      reviewSlots: 0,
      usableCredentialLanes: 1,
    }, 'active');
    expect(mergeActions).toEqual([{
      kind: 'merge',
      issueNumber: 2084,
      prNumber: 84,
      head: HEAD,
      expectedBaseRefName: 'autopilot/2083',
    }]);
    let merged = false;
    let exactMergeCalls = 0;
    const mergeCommitOid = 'f'.repeat(40);
    const mergePort = makeProductionMergeActionPort({
      readSnapshot: async () => build(),
      authorAllowlist: new Set(['trusted']),
      expectedBaseRefName: 'autopilot/2083',
      runner: async (_command, args) => {
        const endpoint = args.find((arg) => arg.startsWith('repos/'));
        if (endpoint === 'repos/Jinn-Network/mono/pulls/84') {
          return JSON.stringify({
            changed_files: 1,
            head: { sha: HEAD },
            base: { ref: 'autopilot/2083', sha: 'e'.repeat(40) },
          });
        }
        if (endpoint?.startsWith('repos/Jinn-Network/mono/pulls/84/files?')) {
          return JSON.stringify([[{ filename: 'README.md' }]]);
        }
        if (endpoint?.startsWith('repos/Jinn-Network/mono/contents/.github/CODEOWNERS')) {
          return JSON.stringify({ content: Buffer.from('').toString('base64') });
        }
        if (endpoint?.startsWith('repos/Jinn-Network/mono/compare/')) {
          expect(endpoint).toBe(
            `repos/Jinn-Network/mono/compare/${'e'.repeat(40)}...${HEAD}`,
          );
          return JSON.stringify({ status: 'ahead' });
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify(merged
            ? {
                state: 'MERGED',
                headRefOid: HEAD,
                baseRefName: 'autopilot/2083',
                mergeCommit: { oid: mergeCommitOid },
              }
            : {
                state: 'OPEN',
                headRefOid: HEAD,
                baseRefName: 'autopilot/2083',
              });
        }
        if (
          args[0] === 'api'
          && args.includes('PUT')
          && args.includes('repos/Jinn-Network/mono/pulls/84/merge')
        ) {
          exactMergeCalls += 1;
          expect(args).toContain(`sha=${HEAD}`);
          merged = true;
          projectStatus = 'Done';
          return JSON.stringify({ merged: true, sha: mergeCommitOid });
        }
        if (args[0] === 'api' && args[1] === 'graphql') return projectGraphQl();
        throw new Error(`unexpected production merge command: ${args.join(' ')}`);
      },
    });
    const mergeResult = await executeMergeAction({
      prNumber: 84,
      expectedHead: HEAD,
      expectedBaseRefName: 'autopilot/2083',
    }, {
      ...mergePort,
      credentials,
    });
    expect(mergeResult).toEqual({
      status: 'merged',
      prNumber: 84,
      head: HEAD,
      mergeCommitOid,
    });
    expect(exactMergeCalls).toBe(1);
  });

  it('turns missing #2084 dependency evidence into a structured diagnostic', async () => {
    const stacked = {
      ...page('page-2').nodes[0]!,
      number: 84,
      body: '<!-- jinn-autopilot:v2 issue=2084 branch=autopilot/2084 -->',
      baseRefName: 'autopilot/2083',
      headRefName: 'autopilot/2084',
      closingIssueNumbers: [],
    };
    const source = reader({
      readIssues: async () => [{ ...issue(), number: 2084 }],
      readPullRequests: async () => ({
        nodes: [stacked],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
      readBranchClaims: async () => [{
        issueNumber: 2084,
        headRefName: 'autopilot/2084',
        headOid: HEAD,
        headCommittedAt: '2026-07-20T09:00:00.000Z',
        claimTrailers: [
          'Jinn-Autopilot-Protocol: 2',
          'Jinn-Autopilot-Phase: implement',
          'Jinn-Autopilot-Issue: 2084',
          'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
          'Jinn-Autopilot-Runner: runner-a',
          'Jinn-Autopilot-Login: trusted',
          `Jinn-Autopilot-Expected-Head: ${HEAD}`,
          'Jinn-Autopilot-Target-Base: autopilot/2083',
          'Jinn-Autopilot-Claimed-At: 2026-07-20T08:00:00.000Z',
        ].join('\n'),
      }],
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
      defaultBranch: 'next',
    });

    expect(snapshot.lifecycle.items).toEqual([]);
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({
        code: 'branch-mapping-ambiguous',
        issueNumbers: [2084],
        detail: expect.stringMatching(/dependency.*2083/i),
      }),
    ]);
  });

  it('paginates PRs and preserves native review commit IDs exactly', async () => {
    const cursors: Array<string | null> = [];
    const source = reader({
      readPullRequests: async (cursor) => {
        cursors.push(cursor);
        return page(cursor);
      },
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(cursors).toEqual([null, 'page-2']);
    expect(snapshot.project.items).toHaveLength(1);
    expect(snapshot.pullRequests[0]?.reviews[0]?.commitId).toBe(HEAD);
    expect(snapshot.pullRequests[0]?.reviewClaim?.oid).toBe(REVIEW_REF);
    expect(snapshot.lifecycle.items[0]).toMatchObject({
      kind: 'pull-request',
      issueNumber: 42,
      prNumber: 101,
      head: HEAD,
      approved: true,
      terminalVerdict: {
        head: HEAD,
        state: 'APPROVE',
        recordedAt: '2026-07-20T10:00:00.000Z',
        marker: '44444444-4444-4444-8444-444444444444',
      },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.pullRequests)).toBe(true);
  });

  it('maps MERGEABLE/CLEAN with exact compare behind to lifecycle behind', async () => {
    const raw = page('page-2').nodes[0]!;
    const source = reader({
      readPullRequests: async () => ({
        nodes: [{
          ...raw,
          mergeability: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          compareStatus: 'behind',
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items[0]).toMatchObject({
      kind: 'pull-request',
      mergeState: 'behind',
      approved: true,
    });
  });

  it('fails closed when MERGEABLE/CLEAN has exact unknown compare evidence', async () => {
    const raw = page('page-2').nodes[0]!;
    const source = reader({
      readPullRequests: async () => ({
        nodes: [{
          ...raw,
          mergeability: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          compareStatus: 'unknown',
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items[0]).toMatchObject({
      kind: 'pull-request',
      mergeState: 'blocked',
      approved: true,
    });
    const [view] = deriveLifecycle(
      snapshot.lifecycle,
      new Date('2026-07-20T12:00:00.000Z'),
      2 * 60 * 60 * 1000,
    ).items;
    expect(view?.phase).not.toBe('merge-ready');
  });

  it('fails closed when a review claim payload is malformed', async () => {
    const malformed = page('page-2');
    const node = malformed.nodes[0]!;
    const source = reader({
      readPullRequests: async () => ({
        ...malformed,
        nodes: [{
          ...node,
          reviewClaim: { oid: REVIEW_REF, payload: '{"protocolVersion":2}' },
        }],
      }),
    });

    await expect(buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    })).rejects.toBeInstanceOf(SnapshotDecodeError);
  });

  it('skips undecodable legacy merge-prep branch claims without failing the snapshot', async () => {
    const source = reader({
      readBranchClaims: async () => [{
        issueNumber: 1935,
        headRefName: 'autopilot/1935',
        headOid: 'dddddddddddddddddddddddddddddddddddddddd',
        headCommittedAt: '2026-07-21T19:14:05.251Z',
        claimTrailers: [
          'Jinn-Autopilot-Protocol: 2',
          'Jinn-Autopilot-Phase: merge-prep',
          'Jinn-Autopilot-Issue: 1935',
          'Jinn-Autopilot-PR: 1943',
          'Jinn-Autopilot-Attempt: 5a3ec319-150f-4386-8a10-4755896655b6',
          'Jinn-Autopilot-Runner: rollout-merge-prep-recovery-c',
          'Jinn-Autopilot-Login: trusted',
          'Jinn-Autopilot-Expected-Head: fbfb6fd064538f17326fbbcb142c6e1f917bf1d1',
          'Jinn-Autopilot-Target-Base: next',
          'Jinn-Autopilot-Claimed-At: 2026-07-21T19:14:05.251Z',
          'Jinn-Autopilot-Phase-Complete: true',
        ].join('\n'),
      }],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.branches).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('autopilot/1935'),
    );
    warn.mockRestore();
  });

  it('does not recover a copied exact intent marker from the wrong reviewer login', async () => {
    const copied = page('page-2');
    const node = copied.nodes[0]!;
    const source = reader({
      readPullRequests: async () => ({
        ...copied,
        nodes: [{
          ...node,
          reviews: node.reviews.map((review) => ({
            ...review,
            reviewer: 'marker-copying-bot',
          })),
        }],
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items[0]).not.toHaveProperty('terminalVerdict');
  });

  it('fails closed when pagination says another page exists without a cursor', async () => {
    const source = reader({
      readPullRequests: async () => ({
        nodes: [],
        pageInfo: { hasNextPage: true, endCursor: null },
      }),
    });

    await expect(buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    })).rejects.toThrow(/pagination/i);
  });

  it('stops before the first Project GraphQL read when the live rate-limit preflight trips', async () => {
    const calls: string[] = [];
    const source = reader({
      readGraphQlRemaining: async () => {
        calls.push('quota');
        return 499;
      },
      readProjectSnapshot: async () => {
        calls.push('project');
        return {
          ...(await reader().readProjectSnapshot()),
          rateLimit: {
            remaining: 499,
            used: 4_501,
            resetAt: '2026-07-20T13:00:00.000Z',
          },
        };
      },
      readIssues: async () => {
        calls.push('issues');
        return [issue()];
      },
      readPullRequests: async () => {
        calls.push('prs');
        return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      },
      readBranchClaims: async () => {
        calls.push('branches');
        return [];
      },
    });

    await expect(buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    })).rejects.toThrow(/rate-limit/i);
    expect(calls).toEqual(['quota']);
  });

  it('admits a full scan at the exact floor-plus-reserve boundary', async () => {
    const base = reader();
    const calls: string[] = [];
    let projectRead = false;
    const source = reader({
      readGraphQlRemaining: async () => {
        calls.push('quota');
        return 500 + FULL_SCAN_RESERVE;
      },
      readProjectSnapshot: async () => {
        calls.push('project');
        projectRead = true;
        return {
          ...(await base.readProjectSnapshot()),
          rateLimit: {
            remaining: 500 + FULL_SCAN_RESERVE - 2,
            used: 4_052,
            resetAt: '2026-07-20T13:00:00.000Z',
          },
        };
      },
      githubUsage: () => ({
        ...(base.githubUsage?.() ?? {
          graphqlRemaining: null,
          graphqlResetAt: null,
          restRequests: 0,
          restNotModified: 0,
          cacheHits: 0,
        }),
        graphqlRequests: projectRead ? 3 : 2,
        graphqlCost: projectRead ? 22 : 20,
        graphqlRemaining: projectRead ? 3_978 : 3_980,
      }),
    });

    await expect(buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    })).resolves.toMatchObject({ snapshotMode: 'full', snapshotComplete: true });
    expect(calls.slice(0, 2)).toEqual(['quota', 'project']);
  });

  it('fails after the Project read when external spend consumes the adjusted reserve', async () => {
    const base = reader();
    const calls: string[] = [];
    let projectRead = false;
    const source = reader({
      readGraphQlRemaining: async () => {
        calls.push('quota');
        return 500 + FULL_SCAN_RESERVE;
      },
      readProjectSnapshot: async () => {
        calls.push('project');
        projectRead = true;
        return {
          ...(await base.readProjectSnapshot()),
          rateLimit: {
            remaining: 500 + FULL_SCAN_RESERVE - 3,
            used: 4_053,
            resetAt: '2026-07-20T13:00:00.000Z',
          },
        };
      },
      githubUsage: () => ({
        ...base.githubUsage!(),
        graphqlRequests: projectRead ? 4 : 3,
        graphqlCost: projectRead ? 22 : 20,
        graphqlRemaining: projectRead ? 3_978 : 3_980,
      }),
    });

    await expect(buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    })).rejects.toThrow(/rate-limit|948/i);
    expect(calls).toEqual(['quota', 'project']);
  });

  it('fails closed one point below the full-scan reserve boundary', async () => {
    const calls: string[] = [];
    const base = reader();
    const source = reader({
      readGraphQlRemaining: async () => {
        calls.push('quota');
        return 500 + FULL_SCAN_RESERVE - 1;
      },
      readProjectSnapshot: async () => {
        calls.push('project');
        return {
          ...(await base.readProjectSnapshot()),
          rateLimit: {
            remaining: 500 + FULL_SCAN_RESERVE - 1,
            used: 4_051,
            resetAt: '2026-07-20T13:00:00.000Z',
          },
        };
      },
      readIssues: async () => {
        calls.push('issues');
        return [issue()];
      },
    });

    await expect(buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    })).rejects.toThrow(/950/);
    expect(calls).toEqual(['quota']);
  });

  it('fails closed before GraphQL when the live full-scan quota reader is unavailable', async () => {
    const source = reader({ readGraphQlRemaining: undefined });

    await expect(buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    })).rejects.toThrow(/quota.*unavailable|rate-limit.*reader/i);
  });

  it('fails closed when the completed scan reports fewer than 500 points remaining', async () => {
    const source = reader({
      githubUsage: () => ({
        graphqlRequests: 4,
        graphqlCost: 451,
        graphqlRemaining: 499,
        graphqlResetAt: '2026-07-20T13:00:00.000Z',
        restRequests: 0,
        restNotModified: 0,
        cacheHits: 0,
      }),
    });

    await expect(buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    })).rejects.toThrow(/rate-limit/i);
  });

  it('cannot mark a full snapshot complete without a cycle usage meter', async () => {
    const completeReader = reader();
    const source = {
      readProjectSnapshot: completeReader.readProjectSnapshot,
      readIssues: completeReader.readIssues,
      readPullRequests: completeReader.readPullRequests,
    } as GitHubLifecycleReader;

    await expect(buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    })).rejects.toThrow(/usage meter/i);
  });

  it('cannot mark a full snapshot complete without metered GraphQL rate-limit evidence', async () => {
    const source = reader({
      githubUsage: () => ({
        graphqlRequests: 0,
        graphqlCost: 0,
        graphqlRemaining: null,
        graphqlResetAt: null,
        restRequests: 0,
        restNotModified: 0,
        cacheHits: 0,
      }),
    });

    await expect(buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    })).rejects.toThrow(/rate-limit evidence/i);
  });

  it('preserves source eligibility reasons for no-PR issues', async () => {
    const dependencyBlocked = {
      ...issue(),
      number: 43,
      status: 'Todo' as const,
      blockedOn: 'Another issue' as const,
      blockedByIssues: [41],
    };
    const disallowed = {
      ...issue(),
      number: 44,
      status: 'Todo' as const,
      author: 'untrusted',
    };
    const source = reader({
      readIssues: async () => [
        { ...issue(), status: 'Todo' },
        dependencyBlocked,
        disallowed,
      ],
      readPullRequests: async () => ({
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items).toEqual([
      expect.objectContaining({
        issueNumber: 42,
        eligible: true,
        eligibilityReason: 'eligible',
      }),
      expect.objectContaining({
        issueNumber: 43,
        eligible: false,
        eligibilityReason: 'dependency-blocked',
      }),
      expect.objectContaining({
        issueNumber: 44,
        eligible: false,
        eligibilityReason: 'author-disallowed',
      }),
    ]);
  });

  it('fails ambiguous issue-to-PR mappings into structured Human diagnostics', async () => {
    const second = {
      ...page('page-2').nodes[0]!,
      number: 102,
      headRefName: 'feature/also-42',
      headOid: 'cccccccccccccccccccccccccccccccccccccccc',
      reviews: [],
      reviewClaim: null,
    };
    const multiIssue = {
      ...page('page-2').nodes[0]!,
      number: 103,
      headRefName: 'autopilot/43',
      headOid: 'dddddddddddddddddddddddddddddddddddddddd',
      closingIssueNumbers: [43, 44],
      reviews: [],
      reviewClaim: null,
    };
    const unlinked = {
      ...page('page-2').nodes[0]!,
      number: 104,
      headRefName: 'feature/unlinked',
      headOid: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      closingIssueNumbers: [],
      reviews: [],
      reviewClaim: null,
    };
    const source = reader({
      readIssues: async () => [
        issue(),
        { ...issue(), number: 43 },
        { ...issue(), number: 44 },
      ],
      readPullRequests: async () => ({
        nodes: [page('page-2').nodes[0]!, second, multiIssue, unlinked],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items).toEqual([]);
    expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'branch-mapping-ambiguous',
        issueNumbers: [42],
        pullRequests: expect.arrayContaining([
          expect.objectContaining({ number: 101 }),
          expect.objectContaining({ number: 102 }),
        ]),
      }),
      expect.objectContaining({
        code: 'branch-mapping-ambiguous',
        issueNumbers: [43, 44],
        pullRequests: [expect.objectContaining({ number: 103 })],
      }),
      expect.objectContaining({
        code: 'branch-mapping-ambiguous',
        issueNumbers: [],
        pullRequests: [expect.objectContaining({ number: 104 })],
      }),
    ]));
  });

  it('carries bounded merged v2 evidence so merge-before-Done can recover', async () => {
    const merged = {
      ...page('page-2').nodes[0]!,
      state: 'MERGED' as const,
      mergedAt: '2026-07-20T10:00:00.000Z',
      mergeCommitOid: HEAD,
      branchClaimTrailers: null,
      reviewClaim: null,
      labels: ['engine:review'],
    };
    const source = reader({
      readPullRequests: async () => ({
        nodes: [merged],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items[0]).toMatchObject({
      kind: 'pull-request',
      merged: true,
      v2Marked: true,
      projectStatus: 'In Review',
    });
  });

  it.each([
    {
      name: 'Project Blocked on: Human',
      issue: { blockedOn: 'Human' as const },
      labels: ['engine:review'],
      expectedDetail: 'Project Blocked on: Human',
    },
    {
      name: 'review:needs-human label',
      issue: {},
      labels: ['engine:review', 'review:needs-human'],
      expectedDetail: 'PR label: review:needs-human',
    },
  ])('synthesizes a structured review reason from $name', async ({
    issue: issueOverride,
    labels,
    expectedDetail,
  }) => {
    const source = reader({
      readIssues: async () => [{ ...issue(), ...issueOverride }],
      readPullRequests: async () => ({
        nodes: [{ ...page('page-2').nodes[0]!, labels }],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items[0]).toMatchObject({
      kind: 'pull-request',
      humanHold: true,
      humanReason: {
        phase: 'reviewing',
        code: 'review-escalation',
        detail: expectedDetail,
      },
    });
  });

  it.skip('preserves an explicit structured Human marker ahead of synthesized sources', async () => {
    const explicit = {
      phase: 'review-fixing' as const,
      code: 'review-escalation' as const,
      detail: 'A human must decide whether the requested API change is acceptable',
    };
    const source = reader({
      readIssues: async () => [{ ...issue(), blockedOn: 'Human', status: 'Human' }],
      readPullRequests: async () => ({
        nodes: [{
          ...page('page-2').nodes[0]!,
          labels: ['engine:review', 'review:needs-human'],
          humanReason: explicit,
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items[0]).toMatchObject({
      humanHold: true,
      humanReason: explicit,
    });
  });

  it('treats a current-head Human review record as authoritative without projections', async () => {
    const humanClaim = page('page-2').nodes[0]!;
    const source = reader({
      readPullRequests: async () => ({
        nodes: [{
          ...humanClaim,
          labels: ['engine:review'],
          reviewClaim: {
            ...humanClaim.reviewClaim!,
            payload: JSON.stringify({
              protocolVersion: 2,
              prNumber: 101,
              generation: '22222222-2222-4222-8222-222222222222',
              attempt: '33333333-3333-4333-8333-333333333333',
              reviewer: 'reviewer',
              head: HEAD,
              state: 'human',
              recordedAt: '2026-07-20T09:00:00.000Z',
            }),
          },
          humanReason: null,
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items[0]).toMatchObject({
      kind: 'pull-request',
      humanHold: true,
      humanReason: {
        phase: 'reviewing',
        code: 'review-escalation',
        detail: 'Current-head Human review record',
      },
    });
  });

  it('identifies only an exact machine-authored obsolete mapping Human overlay for CAS repair', async () => {
    const original = page('page-2').nodes[0]!;
    const mappingReason = {
      phase: 'implementing' as const,
      code: 'branch-mapping-ambiguous' as const,
      detail: 'Old evidence could not uniquely map this PR.',
    };
    const source = reader({
      readPullRequests: async () => ({
        nodes: [{
          ...original,
          labels: ['engine:review'],
          humanIssueNumber: 42,
          humanAuthor: 'maintenance-bot',
          humanHead: HEAD,
          humanGeneration: '22222222-2222-4222-8222-222222222222',
          humanLabelActor: null,
          draftActor: null,
          humanReason: mappingReason,
          reviewClaim: {
            ...original.reviewClaim!,
            payload: JSON.stringify({
              protocolVersion: 2,
              prNumber: 101,
              generation: '22222222-2222-4222-8222-222222222222',
              attempt: '33333333-3333-4333-8333-333333333333',
              reviewer: 'reviewer',
              head: HEAD,
              state: 'human',
              recordedAt: '2026-07-20T09:00:00.000Z',
            }),
          },
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
      machineAuthorLogins: new Set(['maintenance-bot']),
    });

    expect(snapshot.lifecycle.items[0]).toMatchObject({
      humanHold: true,
      obsoleteMachineMappingHuman: {
        author: 'maintenance-bot',
        generation: '22222222-2222-4222-8222-222222222222',
        reason: mappingReason,
      },
    });
  });

  it('retires an exact comment-only machine mapping diagnostic after its review generation is stale', async () => {
    const original = page('page-2').nodes[0]!;
    const generation = '22222222-2222-4222-8222-222222222222';
    const source = reader({
      readPullRequests: async () => ({
        nodes: [{
          ...original,
          labels: ['engine:review'],
          isDraft: false,
          humanIssueNumber: 42,
          humanAuthor: 'maintenance-bot',
          humanHead: HEAD,
          humanGeneration: generation,
          humanLabelActor: null,
          draftActor: null,
          humanReason: {
            phase: 'implementing',
            code: 'branch-mapping-ambiguous',
            detail: 'Old evidence could not uniquely map this PR.',
          },
          reviewClaim: {
            ...original.reviewClaim!,
            payload: JSON.stringify({
              protocolVersion: 2,
              prNumber: 101,
              generation,
              attempt: '33333333-3333-4333-8333-333333333333',
              reviewer: 'reviewer',
              head: HEAD,
              state: 'stale',
              recordedAt: '2026-07-20T09:00:00.000Z',
            }),
          },
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const current = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
      machineAuthorLogins: new Set(['maintenance-bot']),
    });

    expect(current.lifecycle.items[0]).not.toHaveProperty('humanHold');
    expect(current.lifecycle.items[0]).not.toHaveProperty('humanReason');
    expect(current.lifecycle.items[0]).not.toHaveProperty('obsoleteMachineMappingHuman');
    expect(deriveLifecycle(
      current.lifecycle,
      new Date('2026-07-20T12:00:00.000Z'),
      2 * 60 * 60_000,
    ).items[0]).toMatchObject({ phase: 'awaiting-review' });
  });

  it('keeps the live legacy #2084 label and draft fail-closed until its authorized migration', async () => {
    const original = page('page-2').nodes[0]!;
    const generation = '22222222-2222-4222-8222-222222222222';
    const source = reader({
      readPullRequests: async () => ({
        nodes: [{
          ...original,
          labels: ['engine:review', 'review:needs-human'],
          isDraft: true,
          humanIssueNumber: 42,
          humanAuthor: 'maintenance-bot',
          humanHead: null,
          humanGeneration: null,
          humanLabelActor: 'maintenance-bot',
          draftActor: 'maintenance-bot',
          humanReason: {
            phase: 'implementing',
            code: 'branch-mapping-ambiguous',
            detail: 'Legacy mapping diagnostic without an exact tuple.',
          },
          reviewClaim: {
            ...original.reviewClaim!,
            payload: JSON.stringify({
              protocolVersion: 2,
              prNumber: 101,
              generation,
              attempt: '33333333-3333-4333-8333-333333333333',
              reviewer: 'reviewer',
              head: HEAD,
              state: 'human',
              recordedAt: '2026-07-20T09:00:00.000Z',
            }),
          },
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const current = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
      machineAuthorLogins: new Set(['maintenance-bot']),
    });

    expect(current.lifecycle.items[0]).toMatchObject({
      humanHold: true,
      isDraft: true,
      labels: ['engine:review', 'review:needs-human'],
    });
    expect(current.lifecycle.items[0]).not.toHaveProperty('obsoleteMachineMappingHuman');
    const view = deriveLifecycle(
      current.lifecycle,
      new Date('2026-07-20T12:00:00.000Z'),
      2 * 60 * 60_000,
    );
    expect(planProjection({
      view,
      pullRequests: current.pullRequests.map((pr) => ({
        number: pr.number,
        reviewRefOid: pr.reviewClaim?.oid,
      })),
      orphanBranchClaims: [],
      mappingDiagnostics: current.diagnostics,
    }).actions).not.toContainEqual(expect.objectContaining({
      kind: 'repair-obsolete-mapping-human',
    }));
    expect(planCycle(view, {
      implementationSlots: 1,
      reviewSlots: 1,
      usableCredentialLanes: 1,
    }, 'active')).toEqual([]);
  });

  it.each([
    ['maintainer-owned Human label', {
      humanLabelActor: 'maintainer',
      draftActor: null,
    }],
    ['maintainer-owned diagnostic draft', {
      humanLabelActor: 'maintenance-bot',
      draftActor: 'maintainer',
    }],
    ['comment missing exact head/generation provenance', {
      humanLabelActor: 'maintenance-bot',
      draftActor: null,
      humanHead: undefined,
      humanGeneration: undefined,
    }],
  ])('preserves a %s instead of planning automatic repair', async (_name, provenance) => {
    const original = page('page-2').nodes[0]!;
    const generation = '22222222-2222-4222-8222-222222222222';
    const source = reader({
      readPullRequests: async () => ({
        nodes: [{
          ...original,
          labels: ['engine:review', 'review:needs-human'],
          humanIssueNumber: 42,
          humanAuthor: 'maintenance-bot',
          humanHead: HEAD,
          humanGeneration: generation,
          humanReason: {
            phase: 'implementing',
            code: 'branch-mapping-ambiguous',
            detail: 'Old evidence could not uniquely map this PR.',
          },
          isDraft: provenance.draftActor !== null,
          ...provenance,
          reviewClaim: {
            ...original.reviewClaim!,
            payload: JSON.stringify({
              protocolVersion: 2,
              prNumber: 101,
              generation,
              attempt: '33333333-3333-4333-8333-333333333333',
              reviewer: 'reviewer',
              head: HEAD,
              state: 'human',
              recordedAt: '2026-07-20T09:00:00.000Z',
            }),
          },
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
      machineAuthorLogins: new Set(['maintenance-bot']),
    });

    expect(snapshot.lifecycle.items[0]).not.toHaveProperty('obsoleteMachineMappingHuman');
  });

  it.each([
    {
      name: 'maintainer-authored',
      author: 'maintainer',
      issueBlockedOn: 'Nothing' as const,
      reasonCode: 'branch-mapping-ambiguous' as const,
      claimHead: HEAD,
    },
    {
      name: 'explicit issue Human hold',
      author: 'maintenance-bot',
      issueBlockedOn: 'Human' as const,
      reasonCode: 'branch-mapping-ambiguous' as const,
      claimHead: HEAD,
    },
    {
      name: 'different structured reason code',
      author: 'maintenance-bot',
      issueBlockedOn: 'Nothing' as const,
      reasonCode: 'implementation-escalation' as const,
      claimHead: HEAD,
    },
    {
      name: 'different review head',
      author: 'maintenance-bot',
      issueBlockedOn: 'Nothing' as const,
      reasonCode: 'branch-mapping-ambiguous' as const,
      claimHead: 'cccccccccccccccccccccccccccccccccccccccc',
    },
  ])('preserves a $name mapping Human overlay', async ({
    author,
    issueBlockedOn,
    reasonCode,
    claimHead,
  }) => {
    const original = page('page-2').nodes[0]!;
    const source = reader({
      readIssues: async () => [{ ...issue(), blockedOn: issueBlockedOn }],
      readPullRequests: async () => ({
        nodes: [{
          ...original,
          humanIssueNumber: 42,
          humanAuthor: author,
          humanReason: {
            phase: 'implementing',
            code: reasonCode,
            detail: 'Hold this mapping.',
          },
          reviewClaim: {
            ...original.reviewClaim!,
            payload: JSON.stringify({
              protocolVersion: 2,
              prNumber: 101,
              generation: '22222222-2222-4222-8222-222222222222',
              attempt: '33333333-3333-4333-8333-333333333333',
              reviewer: 'reviewer',
              head: claimHead,
              state: 'human',
              recordedAt: '2026-07-20T09:00:00.000Z',
            }),
          },
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
      machineAuthorLogins: new Set(['maintenance-bot']),
    });

    expect(snapshot.lifecycle.items[0]).toMatchObject({ humanHold: true });
    expect(snapshot.lifecycle.items[0]).not.toHaveProperty('obsoleteMachineMappingHuman');
  });

  it('diagnoses a stable claim that contradicts an adopted PR for the same issue', async () => {
    const adopted = {
      ...page('page-2').nodes[0]!,
      headRefName: 'feature/adopted-42',
    };
    const source = reader({
      readPullRequests: async () => ({
        nodes: [adopted],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
      readBranchClaims: async () => [{
        issueNumber: 42,
        headRefName: 'autopilot/42',
        headOid: 'cccccccccccccccccccccccccccccccccccccccc',
        headCommittedAt: '2026-07-20T08:00:00.000Z',
        claimTrailers: [
          'Jinn-Autopilot-Protocol: 2',
          'Jinn-Autopilot-Phase: implement',
          'Jinn-Autopilot-Issue: 42',
          'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
          'Jinn-Autopilot-Runner: runner-a',
          'Jinn-Autopilot-Login: trusted',
          `Jinn-Autopilot-Expected-Head: ${HEAD}`,
          'Jinn-Autopilot-Target-Base: next',
          'Jinn-Autopilot-Claimed-At: 2026-07-20T08:00:00.000Z',
        ].join('\n'),
      }],
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items).toEqual([]);
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({
        code: 'branch-mapping-ambiguous',
        issueNumbers: [42],
        detail: expect.stringContaining('stable branch'),
        pullRequests: [expect.objectContaining({ number: 101 })],
      }),
    ]);
  });

  it('diagnoses a Human marker whose issue contradicts the resolved PR mapping', async () => {
    const contradictory = {
      ...page('page-2').nodes[0]!,
      humanIssueNumber: 43,
      humanReason: {
        phase: 'implementing' as const,
        code: 'implementation-escalation' as const,
        detail: 'Needs product judgment',
      },
    };
    const actualIssue43Pr = {
      ...page('page-2').nodes[0]!,
      number: 102,
      headRefName: 'autopilot/43',
      headOid: 'cccccccccccccccccccccccccccccccccccccccc',
      closingIssueNumbers: [43],
      reviews: [],
      reviewClaim: null,
      humanReason: null,
    };
    const source = reader({
      readIssues: async () => [issue(), { ...issue(), number: 43 }],
      readPullRequests: async () => ({
        nodes: [contradictory, actualIssue43Pr],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items).toEqual([]);
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({
        code: 'branch-mapping-ambiguous',
        issueNumbers: [42, 43],
        detail: expect.stringContaining('Human marker issue #43'),
        pullRequests: [
          expect.objectContaining({ number: 101 }),
          expect.objectContaining({ number: 102 }),
        ],
      }),
    ]);
  });
});
