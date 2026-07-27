// @ts-nocheck — Stage 5 leftover fixtures for deleted merge-prep/review-fix/project APIs.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { PolledIssue } from '../../src/dispatcher/types.js';
import {
  buildGitHubLifecycleSnapshot,
  SnapshotDecodeError,
  type GitHubLifecycleReader,
  type PullRequestPage,
} from '../../src/lifecycle/snapshot.js';
import { GhLifecycleReader } from '../../src/lifecycle/github-reader.js';
import { deriveLifecycle, planCycle } from '../../src/lifecycle/lifecycle.js';
import { FULL_SCAN_RESERVE } from '../../src/lifecycle/github-usage.js';
import { planProjection } from '../../src/lifecycle/projection.js';
import { executeProjectionPlan } from '../../src/lifecycle/reconciler.js';
import { CredentialPool, selectCredential } from '../../src/lifecycle/credentials.js';
import {
  decodeReviewClaimPayload,
  formatAutomatedReviewMarker,
  mappingDiagnosticSignature,
  parseHumanCommentEvidence,
} from '../../src/lifecycle/codecs.js';
import { makeProductionReconciliationWriter } from '../../src/lifecycle/reconciliation-writer-production.js';
import { makeProductionReviewActionPort } from '../../src/lifecycle/review-executor-production.js';
import { makeReviewSessionProtocol } from '../../src/lifecycle/review-session.js';
import { makeProductionReviewSessionPort } from '../../src/lifecycle/review-session-production.js';
import { readAttemptManifest } from '../../src/lifecycle/attempt-workspace.js';
import { makeProductionActiveRuntime } from '../../src/lifecycle/active-runtime-production.js';
import { DEFAULT_CONFIG } from '../../src/dispatcher/types.js';
import { runPaintBoard } from '../../scripts/paint-board.js';

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
        // Merge-ready needs the engine's own signed approval bound to this
        // exact head, not just GitHub's native APPROVED state: the merge gate
        // refuses anything else with `terminal-approval`.
        reviewClaim: {
          kind: 'review-claim',
          protocolVersion: 2,
          prNumber: 84,
          generation: '22222222-2222-4222-8222-222222222222',
          attempt: '33333333-3333-4333-8333-333333333333',
          reviewer: 'review-bot',
          head: HEAD,
          state: 'terminal-approved',
          recordedAt: '2026-07-20T11:00:00.000Z',
          verdict: {
            marker: '44444444-4444-4444-8444-444444444444',
            state: 'APPROVE',
          },
        },
        terminalVerdict: {
          head: HEAD,
          state: 'APPROVE',
          marker: '44444444-4444-4444-8444-444444444444',
          recordedAt: '2026-07-20T11:00:00.000Z',
        },
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

  it('runs future #2084 mapping-reread recovery through production write, review, and exact pinned-base merge seams', async () => {
    const generation = '22222222-2222-4222-8222-222222222222';
    const attempt = '33333333-3333-4333-8333-333333333333';
    const newGeneration = '44444444-4444-4444-8444-444444444444';
    const newAttempt = '55555555-5555-4555-8555-555555555555';
    const newReviewOid = 'cccccccccccccccccccccccccccccccccccccccc';
    const verdictIntentOid = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const mappingRequestOid = '9999999999999999999999999999999999999999';
    const terminalReviewOid = '8888888888888888888888888888888888888888';
    let intent = '66666666-6666-4666-8666-666666666666';
    const stableBranchTrailers = [
      'Jinn-Autopilot-Protocol: 2',
      'Jinn-Autopilot-Phase: implement',
      'Jinn-Autopilot-Issue: 2084',
      'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
      'Jinn-Autopilot-Runner: runner-a',
      'Jinn-Autopilot-Login: trusted',
      `Jinn-Autopilot-Expected-Head: ${HEAD}`,
      'Jinn-Autopilot-Target-Base: autopilot/2083',
      'Jinn-Autopilot-Claimed-At: 2026-07-20T08:00:00.000Z',
    ].join('\n');
    let duplicatePresent = false;
    let projectStatus: 'Human' | 'In Progress' | 'In Review' | 'Done' = 'In Progress';
    const draft = false;
    const humanComments = [];
    let reviewState:
      | 'human'
      | 'mapping-reread'
      | 'stale'
      | 'active'
      | 'verdict-intent'
      | 'terminal-approved' = 'stale';
    let reviewOid = REVIEW_REF;
    let reviewGeneration = generation;
    let reviewAttempt = attempt;
    let reviewReviewer = 'maintenance-bot';
    let reviewVerdict: { marker: string; state: 'APPROVE' } | undefined;
    let reviewMappingRequest;
    let nativeReviews = [];
    let checks = [];
    let mergeability = 'UNKNOWN';
    let mergeStateStatus = 'BLOCKED';
    const reviewPayload = () => JSON.stringify({
      protocolVersion: 2,
      prNumber: 84,
      generation: reviewGeneration,
      attempt: reviewAttempt,
      reviewer: reviewReviewer,
      head: HEAD,
      state: reviewState,
      recordedAt: '2026-07-20T11:00:00.000Z',
      ...(reviewVerdict === undefined ? {} : { verdict: reviewVerdict }),
      ...(reviewMappingRequest === undefined
        ? {}
        : { mappingRequest: reviewMappingRequest }),
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
      humanDiagnosticIssueNumbers: humanComments.length === 0
        ? null
        : parseHumanCommentEvidence(humanComments.at(-1).body)
          ?.diagnosticIssueNumbers ?? null,
      humanDiagnosticSignature: humanComments.length === 0
        ? null
        : parseHumanCommentEvidence(humanComments.at(-1).body)
          ?.diagnosticSignature ?? null,
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
        items: [
          {
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
          },
          {
            id: 'PVTI_2083',
            number: 2083,
            contentType: 'Issue',
            status: 'Done',
            priority: 'P1',
            effort: 'Medium',
            blockedOn: 'Nothing',
            issueType: 'feat',
            blockedByIssues: [],
            sprintIterationId: 'sprint',
          },
        ],
      }),
      readIssues: async () => [
        {
          ...issue(),
          number: 2084,
          status: projectStatus,
          blockedOn: 'Another issue',
          blockedByIssues: [2083],
        },
        {
          ...issue(),
          number: 2083,
          title: 'stack parent',
          status: 'Done',
          blockedOn: 'Nothing',
          blockedByIssues: [],
          projectItemId: 'PVTI_2083',
        },
      ],
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
        claimTrailers: stableBranchTrailers,
      }],
    });
    const build = () => buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
      defaultBranch: 'next',
      machineAuthorLogins: new Set(['maintenance-bot', 'review-bot']),
    });
    const credentials = new CredentialPool([{
      login: 'review-bot',
      normalizedLogin: 'review-bot',
      reviewToken: 'review-secret',
    }, {
      login: 'maintenance-bot',
      normalizedLogin: 'maintenance-bot',
      implementationToken: 'maintenance-secret',
      reviewToken: 'maintenance-secret',
    }]);
    const selected = selectCredential(credentials, { phase: 'implement' });
    if (selected.status !== 'selected') throw new Error('maintenance credential missing');
    const staleReviewOid = 'dddddddddddddddddddddddddddddddddddddddd';
    let nextReviewWriteOid = staleReviewOid;
    let nextReviewWriteState: typeof reviewState = 'stale';
    let nextReviewWriteParentOid = REVIEW_REF;
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
        humanDiagnosticIssueNumbers: pr.humanDiagnosticIssueNumbers,
        humanDiagnosticSignature: pr.humanDiagnosticSignature,
        humanLabelActor: pr.humanLabelActor,
        draftActor: pr.draftActor,
        humanReason: pr.humanReason,
        reviewClaim: pr.reviewClaim,
      };
    };
    const rawDuplicate = () => ({
      ...rawTarget(),
      headRefName: 'feature/duplicate-2084',
      baseRefName: 'next',
      body: 'Closes #2084',
      closingIssueNumbers: [2084],
      labels: [],
      humanIssueNumber: null,
      humanAuthor: null,
      humanHead: null,
      humanGeneration: null,
      humanDiagnosticIssueNumbers: null,
      humanDiagnosticSignature: null,
      humanReason: null,
      reviewClaim: null,
    });
    const rawPullRequest = (prNumber) => (
      prNumber === 84
        ? rawTarget()
        : prNumber === 85 && duplicatePresent
          ? rawDuplicate()
          : null
    );
    const writerFor = (cycleSnapshot) => makeProductionReconciliationWriter({
      repositoryPath: '/repo',
      cycleSnapshot,
      readCanonicalSnapshot: async () => build(),
      readPullRequestByNumber: async (prNumber) => rawPullRequest(prNumber),
      readProjectItemForReconciliation: async (issueNumber) => (
        issueNumber === 2084
          ? { id: 'PVTI_2084', status: projectStatus, blockedOn: 'Another issue' }
          : issueNumber === 2083
            ? { id: 'PVTI_2083', status: 'Done', blockedOn: 'Nothing' }
            : null
      ),
      readBranchHeadByName: async (headRefName) => (
        headRefName === 'autopilot/2084' ? HEAD : null
      ),
      readBranchClaimByName: async (headRefName) => (
        headRefName === 'autopilot/2084'
          ? {
              issueNumber: 2084,
              headRefName,
              headOid: HEAD,
              claimTrailers: stableBranchTrailers,
            }
          : null
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
          : issueNumber === 2083
            ? {
                number: 2083,
                title: 'stack parent',
                open: false,
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
      readIssueActionContext: async (issueNumber) => ({
        projectItem: issueNumber === 2084
          ? { id: 'PVTI_2084', status: projectStatus, blockedOn: 'Another issue' }
          : null,
        openPullRequests: issueNumber !== 2084 || !duplicatePresent
          ? []
          : [{
              number: 85,
              headRefName: 'feature/duplicate-2084',
              headOid: HEAD,
              baseRefName: 'next',
              draft: false,
              labels: [],
              body: 'Closes #2084',
            }],
      }),
      credential: selected.credential,
      credentials,
      now: () => new Date('2026-07-20T12:00:00.000Z'),
      runner: async (_command, args) => {
        if (args.includes('hash-object')) return `${'1'.repeat(40)}\n`;
        if (args.includes('write-tree')) return `${'2'.repeat(40)}\n`;
        if (args.includes('commit-tree')) return `${nextReviewWriteOid}\n`;
        if (args.includes('rev-list')) {
          return `${nextReviewWriteOid} ${nextReviewWriteParentOid}`;
        }
        if (args.includes('ls-remote')) {
          return `${reviewOid}\trefs/jinn-autopilot/review-claims/v1/84\n`;
        }
        if (args.includes('push')) {
          reviewRefPushes += 1;
          reviewState = nextReviewWriteState;
          reviewOid = nextReviewWriteOid;
          reviewMappingRequest = undefined;
          if (reviewState === 'terminal-approved') {
            reviewVerdict = { marker: intent, state: 'APPROVE' };
          }
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
            created_at: '2026-07-20T10:00:00.000Z',
            author_association: 'COLLABORATOR',
            body: args[args.indexOf('--body') + 1],
            user: { login: 'maintenance-bot' },
          });
          return '';
        }
        throw new Error(`unexpected production writer command: ${args.join(' ')}`);
      },
    });

    const preEscalation = await build();
    const scheduledEscalation = planCycle(deriveLifecycle(
      preEscalation.lifecycle,
      new Date('2026-07-20T12:00:00.000Z'),
      2 * 60 * 60_000,
    ), {
      implementationSlots: 0,
      reviewSlots: 1,
      usableCredentialLanes: 1,
    }, 'active');
    expect(scheduledEscalation).toEqual([{
      kind: 'claim-review',
      issueNumber: 2084,
      prNumber: 84,
      head: HEAD,
    }]);
    duplicatePresent = true;
    let merged = false;
    let exactMergeCalls = 0;
    const mergeCommitOid = 'f'.repeat(40);
    let derivedMergeAction;
    let escalatedRecord;
    const makeReviewActionPort = vi.fn(() => ({
      readCandidate: async () => ({
        issueNumber: 2084,
        number: 84,
        open: true,
        head: HEAD,
        headChangedAt: '2026-07-20T09:00:00.000Z',
        headRefName: 'autopilot/2084',
        baseRefName: 'autopilot/2083',
        draft: false,
        author: 'trusted',
        labels: ['engine:review'],
        body: '<!-- jinn-autopilot:v2 issue=2084 branch=autopilot/2084 -->',
        humanHold: false,
        approvalPolicy: 'approve-eligible',
        nativeReviews: [],
        reviewRef: {
          oid: reviewOid,
          record: JSON.parse(reviewPayload()),
        },
        mappingProblem: (await build()).pullRequestMappings
          ?.find((mapping) => mapping.prNumber === 84)?.status === 'ambiguous'
          ? (await build()).pullRequestMappings
            .find((mapping) => mapping.prNumber === 84).details.join(' ')
          : undefined,
      }),
      createReviewRecord: async ({ record }) => {
        escalatedRecord = record;
        return mappingRequestOid;
      },
      publishReviewClaim: async ({ recordOid }) => {
        reviewState = escalatedRecord.state;
        reviewOid = recordOid;
        reviewGeneration = escalatedRecord.generation;
        reviewAttempt = escalatedRecord.attempt;
        reviewReviewer = escalatedRecord.reviewer;
        reviewVerdict = undefined;
        reviewMappingRequest = escalatedRecord.mappingRequest;
        return {
          status: 'won',
          expected: REVIEW_REF,
          published: recordOid,
          observed: recordOid,
        };
      },
    }));
    const escalationRuntime = makeProductionActiveRuntime({
      executionBackend: 'local',
      repositoryPath: '/repo',
      worktreeBase: '/worktrees',
      runnerId: 'runner-a',
      credentials,
      authorAllowlist: new Set(['trusted']),
      readReviewSnapshot: async () => build(),
      readReservedReviewSnapshot: async () => build(),
      readImplementationSnapshot: async () => build(),
      reserveReviewCohort: async () => {},
      readPullRequestByNumber: async (prNumber) => rawPullRequest(prNumber),
      readProjectItemForReconciliation: async (issueNumber) => (
        issueNumber === 2084
          ? { id: 'PVTI_2084', status: projectStatus, blockedOn: 'Another issue' }
          : issueNumber === 2083
            ? { id: 'PVTI_2083', status: 'Done', blockedOn: 'Nothing' }
          : null
      ),
      readBranchHeadByName: async () => HEAD,
      readBranchClaimByName: async (headRefName) => (
        headRefName === 'autopilot/2084'
          ? {
              issueNumber: 2084,
              headRefName,
              headOid: HEAD,
              claimTrailers: stableBranchTrailers,
            }
          : null
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
          : issueNumber === 2083
            ? {
                number: 2083,
                title: 'stack parent',
                open: false,
                author: 'trusted',
                labels: [],
              }
            : null
      ),
      readBlockedByIssueNumbers: async (issueNumber) => (
        issueNumber === 2084 ? [2083] : []
      ),
      readOpenPullRequestsByIssue: async (issueNumber) => (
        issueNumber === 2084 && duplicatePresent
          ? [{
              number: 85,
              headRefName: 'feature/duplicate-2084',
              headOid: HEAD,
              baseRefName: 'next',
              draft: false,
              labels: [],
              body: 'Closes #2084',
            }]
          : []
      ),
      readIssueActionContext: async (issueNumber) => ({
        projectItem: issueNumber === 2084
          ? {
              id: 'PVTI_2084',
              status: projectStatus,
              blockedOn: 'Another issue',
            }
          : issueNumber === 2083
            ? {
                id: 'PVTI_2083',
                status: 'Done',
                blockedOn: 'Nothing',
              }
            : null,
        openPullRequests: issueNumber === 2084 && duplicatePresent
          ? [{
              number: 85,
              headRefName: 'feature/duplicate-2084',
              headOid: HEAD,
              baseRefName: 'next',
              draft: false,
              labels: [],
              body: 'Closes #2084',
            }]
          : [],
      }),
      config: DEFAULT_CONFIG,
      spawn: vi.fn(() => {
        throw new Error('mapping escalation must not spawn a review');
      }),
      caps: { implementation: 0, review: 1 },
      implementationBackpressureThreshold: 30,
      staleAfterMs: 2 * 60 * 60_000,
      makeReviewActionPort,
      now: () => new Date('2026-07-20T12:00:00.000Z'),
      runner: async (_command, args) => {
        const endpoint = args.find((arg) => arg.startsWith('repos/'));
        if (
          derivedMergeAction !== undefined
          && endpoint === `repos/Jinn-Network/mono/pulls/${derivedMergeAction.prNumber}`
        ) {
          return JSON.stringify({
            changed_files: 1,
            head: { sha: derivedMergeAction.head },
            base: {
              ref: derivedMergeAction.expectedBaseRefName,
              sha: 'e'.repeat(40),
            },
          });
        }
        if (
          derivedMergeAction !== undefined
          && endpoint?.startsWith(
            `repos/Jinn-Network/mono/pulls/${derivedMergeAction.prNumber}/files?`,
          )
        ) {
          return JSON.stringify([[{ filename: 'README.md' }]]);
        }
        if (endpoint?.startsWith('repos/Jinn-Network/mono/contents/.github/CODEOWNERS')) {
          return JSON.stringify({ content: Buffer.from('').toString('base64') });
        }
        if (
          derivedMergeAction !== undefined
          && endpoint?.startsWith('repos/Jinn-Network/mono/compare/')
        ) {
          expect(endpoint).toBe(
            `repos/Jinn-Network/mono/compare/${'e'.repeat(40)}...`
            + derivedMergeAction.head,
          );
          return JSON.stringify({ status: 'ahead' });
        }
        if (
          derivedMergeAction !== undefined
          && args[0] === 'pr'
          && args[1] === 'view'
        ) {
          return JSON.stringify(merged
            ? {
                state: 'MERGED',
                headRefOid: derivedMergeAction.head,
                baseRefName: derivedMergeAction.expectedBaseRefName,
                mergeCommit: { oid: mergeCommitOid },
              }
            : {
                state: 'OPEN',
                headRefOid: derivedMergeAction.head,
                baseRefName: derivedMergeAction.expectedBaseRefName,
              });
        }
        if (
          derivedMergeAction !== undefined
          && args[0] === 'api'
          && args.includes('PUT')
          && args.includes(
            `repos/Jinn-Network/mono/pulls/${derivedMergeAction.prNumber}/merge`,
          )
        ) {
          exactMergeCalls += 1;
          expect(args).toContain(`sha=${derivedMergeAction.head}`);
          merged = true;
          projectStatus = 'Done';
          return JSON.stringify({ merged: true, sha: mergeCommitOid });
        }
        if (
          derivedMergeAction !== undefined
          && args[0] === 'api'
          && args[1] === 'graphql'
        ) {
          return projectGraphQl();
        }
        if (args.includes('hash-object')) return `${'1'.repeat(40)}\n`;
        if (args.includes('write-tree')) return `${'2'.repeat(40)}\n`;
        if (args.includes('commit-tree')) {
          return `${staleReviewOid}\n`;
        }
        if (args.includes('rev-list')) {
          return `${args.at(-1)} ${reviewOid}`;
        }
        if (args.includes('ls-remote')) {
          return `${reviewOid}\trefs/jinn-autopilot/review-claims/v1/84\n`;
        }
        if (args.includes('read-tree') || args.includes('update-index')) return '';
        if (args[0] === 'api' && args.some((arg) => arg.includes('/comments'))) {
          return JSON.stringify(humanComments);
        }
        if (args[0] === 'pr' && args[1] === 'comment') {
          humanComments.push({
            id: humanComments.length + 1,
            created_at: '2026-07-20T10:00:00.000Z',
            author_association: 'COLLABORATOR',
            body: args[args.indexOf('--body') + 1],
            user: { login: 'maintenance-bot' },
          });
          return '';
        }
        if (args[0] === 'pr' && (args[1] === 'ready' || args[1] === 'edit')) {
          sharedMutations += 1;
          return '';
        }
        throw new Error(`unexpected production escalation command: ${args.join(' ')}`);
      },
    });
    await expect(escalationRuntime.executeAction(
      scheduledEscalation[0],
      preEscalation,
    )).resolves.toEqual({ outcome: 'human' });
    expect(reviewState).toBe('mapping-reread');
    expect(reviewOid).toBe(mappingRequestOid);
    expect(humanComments).toHaveLength(0);
    expect(sharedMutations).toBe(0);

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
        headRefName: pr.headRefName,
        baseRefName: pr.baseRefName,
        scheduledIssueNumber: pr.number === 84 ? 2084 : undefined,
        reviewRefOid: pr.reviewClaim?.oid,
        ...(pr.reviewClaim === undefined ? {} : {
          reviewClaim: {
            head: pr.reviewClaim.record.head,
            generation: pr.reviewClaim.record.generation,
            state: pr.reviewClaim.record.state,
            ...(pr.reviewClaim.record.mappingRequest === undefined
              ? {}
              : { mappingRequest: pr.reviewClaim.record.mappingRequest }),
            ...(pr.reviewClaim.record.mappingDiagnostic === undefined
              ? {}
              : { mappingDiagnostic: pr.reviewClaim.record.mappingDiagnostic }),
          },
        }),
      })),
      orphanBranchClaims: [],
      mappingDiagnostics: ambiguous.diagnostics,
    });
    expect(diagnosticPlan.actions).toEqual([]);
    const diagnosticResult = await executeProjectionPlan(
      diagnosticPlan,
      writerFor(ambiguous),
    );
    expect(diagnosticResult.results).toEqual([]);
    expect(reviewState).toBe('mapping-reread');
    expect(humanComments).toHaveLength(0);
    expect(reviewRefPushes).toBe(0);
    expect(sharedMutations).toBe(0);

    duplicatePresent = false;
    reviewRefPushes = 0;
    const resolved = await build();
    const releasePlan = planProjection({
      view: deriveLifecycle(
        resolved.lifecycle,
        new Date('2026-07-20T12:00:00.000Z'),
        2 * 60 * 60_000,
      ),
      snapshotComplete: resolved.snapshotComplete,
      pullRequests: resolved.pullRequests.map((pr) => ({
        number: pr.number,
        headRefName: pr.headRefName,
        baseRefName: pr.baseRefName,
        ...((() => {
          const mapping = resolved.pullRequestMappings?.find((candidate) => (
            candidate.prNumber === pr.number && candidate.status === 'resolved'
          ));
          return mapping?.status === 'resolved'
            ? { resolvedIssueNumber: mapping.issueNumber }
            : {};
        })()),
        reviewRefOid: pr.reviewClaim?.oid,
        ...(pr.reviewClaim === undefined ? {} : {
          reviewClaim: {
            head: pr.reviewClaim.record.head,
            generation: pr.reviewClaim.record.generation,
            state: pr.reviewClaim.record.state,
            ...('mappingRequest' in pr.reviewClaim.record
              ? { mappingRequest: pr.reviewClaim.record.mappingRequest }
              : {}),
          },
        }),
      })),
      orphanBranchClaims: [],
      mappingDiagnostics: resolved.diagnostics,
    });
    expect(releasePlan.actions).toEqual([{
      kind: 'mark-review-stale',
      prNumber: 84,
      expectedHead: HEAD,
      expectedReviewRefOid: mappingRequestOid,
    }]);

    nextReviewWriteParentOid = mappingRequestOid;
    const reconciliation = await executeProjectionPlan(
      releasePlan,
      writerFor(resolved),
    );
    expect(reconciliation.results).toEqual([{
      action: releasePlan.actions[0],
      outcome: 'applied',
    }]);
    expect(reviewRefPushes).toBe(1);
    expect(reviewState).toBe('stale');
    expect(reviewOid).toBe(staleReviewOid);
    expect(humanComments).toHaveLength(0);
    expect(sharedMutations).toBe(0);

    let painterEdits = 0;
    await expect(runPaintBoard(async (_command, args) => {
      if (
        args[0] === 'api'
        && args[1] === 'graphql'
        && args.some((arg) => arg.startsWith('owner='))
      ) {
        return JSON.stringify({
          data: {
            rateLimit: {
              cost: 1,
              remaining: 4_999,
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
      }
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([{
          number: 84,
          headRefOid: HEAD,
          headRefName: 'autopilot/2084',
          baseRefName: 'autopilot/2083',
          body: '<!-- jinn-autopilot:v2 issue=2084 branch=autopilot/2084 -->',
          isDraft: false,
          labels: [{ name: 'engine:review' }],
          closingIssuesReferences: [],
        }]);
      }
      if (args[0] === 'api' && args[1]?.includes('/git/matching-refs/')) {
        return JSON.stringify([[
          { ref: 'refs/heads/autopilot/2084', object: { sha: HEAD } },
        ]]);
      }
      if (args[0] === 'api' && args[1]?.includes(`/commits/${HEAD}`)) {
        return [
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
        ].join('\n');
      }
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'api' && args[1] === 'graphql') {
        return JSON.stringify({
          data: {
            repository: {
              i0: {
                number: 2084,
                state: 'OPEN',
                labels: { nodes: [] },
              },
            },
          },
        });
      }
      if (args[0] === 'project' && args[1] === 'item-edit') {
        painterEdits += 1;
        projectStatus = 'In Review';
        return '';
      }
      throw new Error(`unexpected painter command: ${args.join(' ')}`);
    }, new Date('2026-07-20T12:00:00.000Z'), {
      repositorySlug: 'Jinn-Network/mono',
      repositoryOwner: 'Jinn-Network',
      repositoryName: 'mono',
      projectOwner: 'Jinn-Network',
      projectNumber: 1,
      projectId: 'PVT_project',
      statusFieldId: 'PVTSSF_status',
      statusOptions: {
        Todo: 'todo',
        'In Progress': 'in-progress',
        Human: 'human',
        'In Review': 'in-review',
        Done: 'done',
      },
      defaultBranch: 'next',
    })).resolves.toMatchObject({ paintsApplied: 1 });
    expect(painterEdits).toBe(1);
    expect(projectStatus).toBe('In Review');

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
    let startedSessionRequest;
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
    const scheduledReview = scheduled[0];
    const reviewAttemptRoot = mkdtempSync(join(tmpdir(), 'jinn-review-seam-'));
    onTestFinished(() => rmSync(reviewAttemptRoot, { recursive: true, force: true }));
    let reviewManifestPath;
    const createReviewWorkspace = async (input) => {
      const attemptDir = join(reviewAttemptRoot, input.attemptId);
      const paths = {
        attemptDir,
        worktree: join(attemptDir, 'worktree'),
        manifest: join(attemptDir, 'manifest.json'),
        log: join(attemptDir, 'session.log'),
        ghConfigDir: join(attemptDir, 'gh-config'),
        askpass: join(attemptDir, 'askpass'),
        tokenFile: join(attemptDir, 'gh-token'),
      };
      mkdirSync(paths.worktree, { recursive: true });
      mkdirSync(paths.ghConfigDir, { recursive: true });
      const manifest = {
        version: 2,
        attemptId: input.attemptId,
        runnerId: 'runner-a',
        host: 'host-a',
        phase: 'review',
        execution: { backend: 'local' },
        subject: `pr-${input.prNumber}`,
        issueNumber: input.issueNumber,
        prNumber: input.prNumber,
        branch: input.branch,
        targetBase: input.targetBase,
        expectedHead: input.expectedHead,
        claimOid: input.claimOid,
        reviewGeneration: input.reviewGeneration,
        reviewRefOid: input.reviewRefOid,
        reviewApprovalPolicy: input.reviewApprovalPolicy,
        selectedLogin: input.selectedLogin,
        repository: {
          root: '/repo',
          gitCommonDir: '/repo/.git',
          remoteName: 'jinn-autopilot-v2',
          remoteUrlHash: 'a'.repeat(64),
        },
        processState: 'preparing',
        pid: null,
        paths,
        timestamps: {
          createdAt: '2026-07-20T12:00:00.000Z',
          updatedAt: '2026-07-20T12:00:00.000Z',
        },
      };
      writeFileSync(paths.manifest, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
      writeFileSync(paths.tokenFile, 'review-secret\n', { mode: 0o600 });
      reviewManifestPath = paths.manifest;
      return { attemptId: input.attemptId, paths };
    };
    const reviewActionRunner = async (_command, args) => {
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
        reviewGeneration = newGeneration;
        reviewAttempt = newAttempt;
        reviewReviewer = 'review-bot';
        reviewVerdict = undefined;
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
    };
    const productionReviewActionFactory = vi.fn((options) =>
      makeProductionReviewActionPort({
        ...options,
        changedFiles: async () => [],
        codeownersText: () => '',
        createWorkspace: createReviewWorkspace,
      }));
    const reviewRuntime = makeProductionActiveRuntime({
      executionBackend: 'local',
      repositoryPath: '/repo',
      worktreeBase: reviewAttemptRoot,
      runnerId: 'runner-a',
      credentials,
      authorAllowlist: new Set(['trusted']),
      readReviewSnapshot: async () => build(),
      readReservedReviewSnapshot: async () => build(),
      readImplementationSnapshot: async () => {
        throw new Error('review seam must not read implementation authority');
      },
      reserveReviewCohort: async () => {},
      readPullRequestByNumber: async (prNumber) => rawPullRequest(prNumber),
      readProjectItemForReconciliation: async () => null,
      readBranchHeadByName: async () => HEAD,
      readBranchClaimByName: async () => null,
      readIssueByNumber: async () => null,
      readBlockedByIssueNumbers: async () => [],
      readOpenPullRequestsByIssue: async () => [],
      readIssueActionContext: async () => ({
        projectItem: null,
        openPullRequests: [],
      }),
      config: DEFAULT_CONFIG,
      spawn: vi.fn(() => {
        spawned += 1;
        return {
          pid: 42,
          exitCode: null,
          once: vi.fn(),
        };
      }),
      caps: { implementation: 0, review: 1 },
      implementationBackpressureThreshold: 30,
      staleAfterMs: 2 * 60 * 60_000,
      makeReviewActionPort: productionReviewActionFactory,
      nextId: vi.fn()
        .mockReturnValueOnce(newAttempt)
        .mockReturnValueOnce(newGeneration),
      now: () => new Date('2026-07-20T12:00:00.000Z'),
      runner: reviewActionRunner,
      environment: {},
    });
    await expect(reviewRuntime.executeAction(
      scheduledReview,
      repainted,
    )).resolves.toEqual({ outcome: 'spawned' });
    expect(productionReviewActionFactory).toHaveBeenCalledOnce();
    expect(spawned).toBe(1);
    expect(reviewState).toBe('active');
    expect(reviewOid).toBe(newReviewOid);
    expect(reviewManifestPath).toBeTypeOf('string');

    // Drive the durable crash boundary through the production session port:
    // intent publication and native approval succeed, while the terminal CAS
    // reports ambiguity and is recovered by projection below.
    let pendingSessionRecord;
    const reviewSessionRunner = async (command, args) => {
      if (command === 'gh' && args.join(' ') === 'api user --jq .login') {
        return 'review-bot\n';
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          number: 84,
          state: 'OPEN',
          headRefOid: HEAD,
          headRefName: 'autopilot/2084',
          baseRefName: 'autopilot/2083',
          baseRefOid: 'e'.repeat(40),
          isDraft: false,
          body: '<!-- jinn-autopilot:v2 issue=2084 branch=autopilot/2084 -->',
          author: { login: 'trusted' },
          labels: [{ name: 'engine:review' }],
          closingIssuesReferences: [],
          files: [],
        });
      }
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([{
          number: 84,
          headRefOid: HEAD,
          headRefName: 'autopilot/2084',
          baseRefName: 'autopilot/2083',
          body: '<!-- jinn-autopilot:v2 issue=2084 branch=autopilot/2084 -->',
          closingIssuesReferences: [],
        }]);
      }
      if (
        command === 'gh'
        && args[0] === 'api'
        && args.includes('repos/Jinn-Network/mono/pulls/84/reviews')
        && args.includes('--method')
      ) {
        const state = args.find((arg) => arg.startsWith('event='))?.slice('event='.length);
        const body = args.find((arg) => arg.startsWith('body='))?.slice('body='.length);
        nativeReviews = [{
          reviewer: 'review-bot',
          state: state === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED',
          commitId: HEAD,
          body,
          submittedAt: '2026-07-20T12:10:00.000Z',
        }];
        return '';
      }
      if (
        command === 'gh'
        && args[0] === 'api'
        && args.includes('repos/Jinn-Network/mono/pulls/84/reviews')
      ) {
        return JSON.stringify([nativeReviews.map((review) => ({
          user: { login: review.reviewer },
          state: review.state,
          commit_id: review.commitId,
          body: review.body,
          submitted_at: review.submittedAt,
        }))]);
      }
      if (command === 'git' && args.includes('get-url')) {
        return 'https://github.com/Jinn-Network/mono.git\n';
      }
      if (command === 'git' && args.includes('ls-tree')) return '';
      if (command === 'git' && args.includes('ls-remote')) {
        return `${reviewOid}\trefs/jinn-autopilot/review-claims/v1/84\n`;
      }
      if (command === 'git' && args.includes('fetch')) return '';
      if (command === 'git' && args.includes('show')) return `${reviewPayload()}\n`;
      if (command === 'git' && args.includes('hash-object')) return `${'3'.repeat(40)}\n`;
      if (command === 'git' && args.includes('write-tree')) return `${'4'.repeat(40)}\n`;
      if (command === 'git' && args.includes('commit-tree')) {
        return `${
          pendingSessionRecord.state === 'verdict-intent'
            ? verdictIntentOid
            : terminalReviewOid
        }\n`;
      }
      if (command === 'git' && args.includes('rev-list')) {
        return `${args.at(-1)} ${reviewOid}`;
      }
      if (command === 'git' && args.includes('push')) {
        if (pendingSessionRecord.state === 'terminal-approved') {
          throw new Error('simulated crash before terminal review-ref CAS');
        }
        reviewState = pendingSessionRecord.state;
        reviewOid = verdictIntentOid;
        reviewGeneration = pendingSessionRecord.generation;
        reviewAttempt = pendingSessionRecord.attempt;
        reviewReviewer = pendingSessionRecord.reviewer;
        reviewVerdict = pendingSessionRecord.verdict;
        intent = pendingSessionRecord.verdict.marker;
        return '';
      }
      if (
        command === 'git'
        && (args.includes('read-tree') || args.includes('update-index'))
      ) {
        return '';
      }
      throw new Error(`unexpected production session command: ${command} ${args.join(' ')}`);
    };
    const productionSessionPort = makeProductionReviewSessionPort({
      environment: {
        GH_TOKEN: 'review-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: reviewManifestPath,
      },
      readMappingAuthority: async () => ({
        defaultBranch: 'next',
        issues: [{
          number: 2084,
          blockedOn: 'Another issue',
          blockedByIssues: [2083],
        }],
        stableBranches: [{
          issueNumber: 2084,
          phase: 'implement',
          head: HEAD,
          headRefName: 'autopilot/2084',
          targetBase: 'autopilot/2083',
        }],
      }),
      readProjectHumanAuthority: async () => false,
      readNativeIssueHumanAuthority: async () => false,
      now: () => new Date('2026-07-20T12:10:00.000Z'),
      writeMetadataFile: (payload) => {
        pendingSessionRecord = decodeReviewClaimPayload(payload);
        return join(reviewAttemptRoot, 'review-metadata.json');
      },
      removeMetadataFile: () => {},
      runner: reviewSessionRunner,
    });
    const sessionProtocol = makeReviewSessionProtocol(productionSessionPort);
    const sessionManifest = readAttemptManifest(reviewManifestPath);
    await expect(sessionProtocol.reviewVerdict(
      sessionManifest,
      'APPROVE',
      'Approved.',
    )).resolves.toEqual({ status: 'ambiguous', head: HEAD });
    expect(reviewState).toBe('verdict-intent');
    expect(reviewOid).toBe(verdictIntentOid);
    expect(nativeReviews).toEqual([expect.objectContaining({
      reviewer: 'review-bot',
      state: 'APPROVED',
      commitId: HEAD,
      body: expect.stringContaining(formatAutomatedReviewMarker({
        generation: newGeneration,
        attempt: newAttempt,
        intent,
        reviewer: 'review-bot',
        head: HEAD,
        verdict: 'APPROVE',
      })),
    })]);
    checks = [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }];
    mergeability = 'MERGEABLE';
    mergeStateStatus = 'CLEAN';
    const crashed = await build();
    const terminalPlan = planProjection({
      view: deriveLifecycle(
        crashed.lifecycle,
        new Date('2026-07-20T12:15:00.000Z'),
        2 * 60 * 60_000,
      ),
      pullRequests: crashed.pullRequests.map((pr) => ({
        number: pr.number,
        reviewRefOid: pr.reviewClaim?.oid,
      })),
      orphanBranchClaims: [],
      mappingDiagnostics: crashed.diagnostics,
    });
    expect(terminalPlan.actions).toEqual([expect.objectContaining({
      kind: 'complete-verdict-intent',
      prNumber: 84,
      expectedHead: HEAD,
      expectedReviewRefOid: verdictIntentOid,
    })]);
    nextReviewWriteParentOid = verdictIntentOid;
    nextReviewWriteOid = terminalReviewOid;
    nextReviewWriteState = 'terminal-approved';
    const terminalRecovery = await executeProjectionPlan(
      terminalPlan,
      writerFor(crashed),
    );
    expect(terminalRecovery.results).toEqual([{
      action: terminalPlan.actions[0],
      outcome: 'applied',
    }]);
    expect(reviewState).toBe('terminal-approved');
    expect(reviewOid).toBe(terminalReviewOid);
    expect(reviewRefPushes).toBe(2);

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
    derivedMergeAction = mergeActions[0];
    await expect(escalationRuntime.executeAction(
      derivedMergeAction,
      terminal,
    )).resolves.toEqual({ outcome: 'merged' });
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

  // Review follow-ups (canon §5.1) are ordinary issues filed against code that
  // exists only on the parent PR's branch. jinn-mono#2175 (marker pr=2065,
  // blocked_by []) was claimed against `next`, produced draft PR #2217, and the
  // implementation session escalated to Human because the reviewed code was not
  // on the default branch. The gate is a query over the machine-written marker
  // plus the parent PR's snapshot state only — never prose.
  function followUpIssue(parentPr: number): PolledIssue {
    return {
      ...issue(),
      number: 50,
      title: 'Follow-up from review',
      status: 'Todo',
      projectItemId: 'PVTI_50',
      body: `<!-- jinn-autopilot:review-follow-up pr=${parentPr} head=${HEAD} index=0 -->\n\n`
        + `Follow-up from PR #${parentPr} review.`,
    };
  }

  it('holds a review follow-up while its parent PR is still open', async () => {
    const source = reader({
      readIssues: async () => [{ ...issue(), status: 'Todo' }, followUpIssue(101)],
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    const followUp = snapshot.lifecycle.items.find((item) => item.issueNumber === 50);
    expect(snapshot.pullRequests.find((pr) => pr.number === 101)?.state).toBe('OPEN');
    expect(followUp).toMatchObject({
      kind: 'issue',
      eligible: false,
      eligibilityReason: 'dependency-blocked',
    });
    expect(followUp?.eligibilityDetail).toContain('#101');
  });

  it('releases a review follow-up once its parent PR is merged', async () => {
    const mergedParent = {
      ...page('page-2').nodes[0]!,
      state: 'MERGED' as const,
      labels: [],
      reviews: [],
      reviewClaim: null,
      mergedAt: '2026-07-20T11:00:00.000Z',
      mergeCommitOid: REVIEW_REF,
    };
    const source = reader({
      readIssues: async () => [{ ...issue(), status: 'Todo' }, followUpIssue(101)],
      readPullRequests: async () => ({
        nodes: [mergedParent],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.pullRequests.find((pr) => pr.number === 101)?.state).toBe('MERGED');
    expect(snapshot.lifecycle.items.find((item) => item.issueNumber === 50)).toMatchObject({
      eligible: true,
      eligibilityReason: 'eligible',
    });
  });

  // Fail-closed boundary, stated: absence does NOT block. The reader drops
  // closed-unmerged PRs outright (github-reader `if (pr.state === 'CLOSED')
  // continue;`) and prunes merged PRs once their issues reach Done, so absence
  // is dominated by "merged and pruned". Blocking on absence would strand every
  // follow-up permanently with no machine exit.
  it('releases a review follow-up whose parent PR is absent from the snapshot', async () => {
    const source = reader({
      readIssues: async () => [{ ...issue(), status: 'Todo' }, followUpIssue(909)],
      readPullRequests: async () => ({
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.pullRequests.some((pr) => pr.number === 909)).toBe(false);
    expect(snapshot.lifecycle.items.find((item) => item.issueNumber === 50)).toMatchObject({
      eligible: true,
      eligibilityReason: 'eligible',
    });
  });

  // R6: the earlier version of this case re-used the `nodes: []` fixture and so
  // only re-asserted the absent case under a different name. `state` is typed
  // `'OPEN' | 'MERGED'`, so a CLOSED parent can only be produced by driving a
  // real `state: 'CLOSED'` node through GhLifecycleReader — which is where the
  // drop actually lives (github-reader.ts, `if (pr.state === 'CLOSED') continue`).
  it('drops a CLOSED parent PR in the reader, leaving its review follow-up eligible', async () => {
    const run = async (command: string, args: string[]): Promise<string> => {
      if (command === 'git') return '';
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('closedByPullRequestsReferences')) {
        return JSON.stringify({
          data: {
            rateLimit: { cost: 1, remaining: 4_999, resetAt: '2026-07-20T13:00:00.000Z' },
            repository: {
              issue50: {
                closedByPullRequestsReferences: {
                  pageInfo: { hasNextPage: false },
                  // Only `state` is read before the CLOSED drop.
                  nodes: [{ number: 101, state: 'CLOSED' }],
                },
              },
            },
          },
        });
      }
      return JSON.stringify({
        data: {
          rateLimit: { cost: 1, remaining: 4_999, resetAt: '2026-07-20T13:00:00.000Z' },
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    };
    const page = await new GhLifecycleReader(run).readPullRequests(null, [50]);
    // The reader, not the gate, is what makes a closed-unmerged parent absent.
    expect(page.nodes.some((pr) => pr.number === 101)).toBe(false);

    const source = reader({
      readIssues: async () => [{ ...issue(), status: 'Todo' }, followUpIssue(101)],
      readPullRequests: async () => page,
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.pullRequests.some((pr) => pr.number === 101)).toBe(false);
    expect(snapshot.lifecycle.items.find((item) => item.issueNumber === 50)).toMatchObject({
      eligible: true,
      eligibilityReason: 'eligible',
    });
  });

  // R1: the explainer branch must sit BELOW the whole cascade. Shipped above
  // `authorDisallowed` it reported the parent PR for issues that were actually
  // untriaged or author-disallowed, hiding the real failure. The untriaged
  // window is real: review-follow-ups-production.ts creates the issue and only
  // then calls ensureTriageComplete. Mutant M9 (move the branch back above the
  // cascade) survived without these two cases.
  it('reports the triage failure, not the parent PR, for an untriaged review follow-up', async () => {
    const untriaged = { ...followUpIssue(101), shape: null };
    const source = reader({
      readIssues: async () => [{ ...issue(), status: 'Todo' }, untriaged],
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.pullRequests.find((pr) => pr.number === 101)?.state).toBe('OPEN');
    expect(snapshot.lifecycle.items.find((item) => item.issueNumber === 50)).toMatchObject({
      eligible: false,
      eligibilityReason: 'not-selected',
      eligibilityDetail: 'Issue Type is not set',
    });
  });

  it('reports author-disallowed, not the parent PR, for a disallowed review follow-up', async () => {
    const disallowed = { ...followUpIssue(101), author: 'untrusted' };
    const source = reader({
      readIssues: async () => [{ ...issue(), status: 'Todo' }, disallowed],
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.pullRequests.find((pr) => pr.number === 101)?.state).toBe('OPEN');
    expect(snapshot.lifecycle.items.find((item) => item.issueNumber === 50)).toMatchObject({
      eligible: false,
      eligibilityReason: 'author-disallowed',
    });
  });

  // R7: a marker-shaped comment that does not parse now fails closed, matching
  // the framing the gate always claimed. Before this it fell through to
  // `eligible: true` — a truncated marker was strictly weaker than no marker.
  it('holds a review follow-up whose marker comment is present but unparseable', async () => {
    const truncated = {
      ...followUpIssue(101),
      body: '<!-- jinn-autopilot:review-follow-up pr=101 head=abc -->\n\nFollow-up.',
    };
    const source = reader({
      readIssues: async () => [{ ...issue(), status: 'Todo' }, truncated],
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    const followUp = snapshot.lifecycle.items.find((item) => item.issueNumber === 50);
    expect(followUp).toMatchObject({ eligible: false, eligibilityReason: 'not-selected' });
    expect(followUp?.eligibilityDetail).toContain('could not be parsed');
    // Distinct from the parent-open reason so the two never blur.
    expect(followUp?.eligibilityDetail).not.toContain('#101');
  });

  it('fails closed on an unparseable marker even when no such PR exists', async () => {
    // The `pr=` value is unreadable, so parent state cannot be consulted at
    // all; the hold does not depend on a PR being present.
    const truncated = {
      ...followUpIssue(909),
      body: '<!-- jinn-autopilot:review-follow-up pr=909 -->\n\nFollow-up.',
    };
    const source = reader({
      readIssues: async () => [{ ...issue(), status: 'Todo' }, truncated],
      readPullRequests: async () => ({
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items.find((item) => item.issueNumber === 50)).toMatchObject({
      eligible: false,
      eligibilityReason: 'not-selected',
    });
  });

  // The fail-closed hold is permanent — `eligible: false` with reason
  // `not-selected`, no self-heal and no timeout — so its trigger must not fire
  // on documentation. Canon §5.1 prints the marker *template* verbatim, and
  // issues here are routinely written by agents told to cite canon; matching
  // the template stranded any such issue forever behind a reason string that
  // reads like an ordinary triage miss.
  it('does not fail closed on an issue quoting the canon §5.1 marker template', async () => {
    const canon = readFileSync(
      new URL('../../assets/canon/single-surface-lifecycle.md', import.meta.url),
      'utf8',
    );
    const template = canon.match(/`(<!-- jinn-autopilot:review-follow-up [^`]*-->)`/)?.[1];
    expect(template).toBeDefined();

    for (const body of [
      `Canon §5.1 requires the body marker ${template}.`,
      `Canon §5.1 requires the body marker:\n\n\`\`\`\n${template}\n\`\`\`\n`,
    ]) {
      const quoting = { ...followUpIssue(101), body };
      const source = reader({
        readIssues: async () => [{ ...issue(), status: 'Todo' }, quoting],
      });

      const snapshot = await buildGitHubLifecycleSnapshot(source, {
        authorAllowlist: new Set(['trusted']),
      });

      expect(snapshot.pullRequests.find((pr) => pr.number === 101)?.state).toBe('OPEN');
      expect(snapshot.lifecycle.items.find((item) => item.issueNumber === 50)).toMatchObject({
        eligible: true,
        eligibilityReason: 'eligible',
      });
    }
  });

  it('does not fail closed on prose that merely names the review-follow-up marker tag', async () => {
    // The fail-closed trigger is a marker-shaped HTML comment, not the tag
    // string — engine issues discuss `jinn-autopilot:review-follow-up` in prose.
    const prose = {
      ...followUpIssue(101),
      body: 'Document the jinn-autopilot:review-follow-up marker format.',
    };
    const source = reader({
      readIssues: async () => [{ ...issue(), status: 'Todo' }, prose],
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items.find((item) => item.issueNumber === 50)).toMatchObject({
      eligible: true,
      eligibilityReason: 'eligible',
    });
  });

  it('does not gate an ordinary issue that merely mentions an open PR in prose', async () => {
    const prose = {
      ...issue(),
      number: 50,
      status: 'Todo' as const,
      projectItemId: 'PVTI_50',
      body: 'Follow-up from the review of PR #101. Parent PR: '
        + 'https://github.com/Jinn-Network/mono/pull/101',
    };
    const source = reader({
      readIssues: async () => [{ ...issue(), status: 'Todo' }, prose],
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.lifecycle.items.find((item) => item.issueNumber === 50)).toMatchObject({
      eligible: true,
      eligibilityReason: 'eligible',
    });
  });

  it('invalidates global action authority when truncated PR closure omits an issue', async () => {
    const partialClosure = {
      ...page('page-2').nodes[0]!,
      body: '',
      headRefName: 'feature/shared-closure',
      closingIssueNumbers: [42],
      closingIssueNumbersIncomplete: true,
      evidenceIncompleteReason: 'PR #101 closing issue references were truncated',
      reviews: [],
      reviewClaim: null,
    };
    const source = reader({
      readIssues: async () => [
        { ...issue(), status: 'Todo' },
        { ...issue(), number: 43, status: 'Todo' },
      ],
      readPullRequests: async () => ({
        nodes: [partialClosure],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.snapshotComplete).toBe(false);
    expect(snapshot.pullRequestMappings).toEqual([]);
    expect(snapshot.lifecycle.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'issue',
        issueNumber: 43,
        eligible: false,
      }),
    ]));
    expect(planCycle(deriveLifecycle(
      snapshot.lifecycle,
      new Date('2026-07-20T12:00:00.000Z'),
      2 * 60 * 60_000,
    ), {
      implementationSlots: 2,
      reviewSlots: 2,
      usableCredentialLanes: 2,
    }, 'active')).toEqual([]);
  });

  it('invalidates sibling action authority when any non-comment PR evidence is incomplete', async () => {
    const incompleteReviews = {
      ...page('page-2').nodes[0]!,
      evidenceIncompleteReason: 'PR #101 reviews were truncated',
      reviews: [],
      reviewClaim: null,
    };
    const source = reader({
      readIssues: async () => [
        { ...issue(), status: 'In Review' },
        { ...issue(), number: 43, status: 'Todo' },
      ],
      readPullRequests: async () => ({
        nodes: [incompleteReviews],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.snapshotComplete).toBe(false);
    expect(planCycle(deriveLifecycle(
      snapshot.lifecycle,
      new Date('2026-07-20T12:00:00.000Z'),
      2 * 60 * 60_000,
    ), {
      implementationSlots: 2,
      reviewSlots: 2,
      usableCredentialLanes: 2,
    }, 'active')).toEqual([]);
  });

  it('invalidates global action authority when merged outcome pagination is incomplete', async () => {
    const source = reader({
      readIssues: async () => [{ ...issue(), status: 'Todo' }],
      readPullRequests: async () => ({
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
        closingIssueEvidenceIncomplete: true,
      }),
    });

    const snapshot = await buildGitHubLifecycleSnapshot(source, {
      authorAllowlist: new Set(['trusted']),
    });

    expect(snapshot.snapshotComplete).toBe(false);
    expect(snapshot.lifecycle.items).toEqual([
      expect.objectContaining({
        kind: 'issue',
        issueNumber: 42,
        eligible: false,
      }),
    ]);
    expect(planCycle(deriveLifecycle(
      snapshot.lifecycle,
      new Date('2026-07-20T12:00:00.000Z'),
      2 * 60 * 60_000,
    ), {
      implementationSlots: 1,
      reviewSlots: 1,
      usableCredentialLanes: 1,
    }, 'active')).toEqual([]);
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

  it('does not treat a current-head internal Human review record as lifecycle authority', async () => {
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

    expect(snapshot.lifecycle.items[0]).toMatchObject({ kind: 'pull-request' });
    expect(snapshot.lifecycle.items[0]).not.toHaveProperty('humanHold');
    expect(snapshot.lifecycle.items[0]).not.toHaveProperty('humanReason');
  });

  it('keeps an unsigned legacy machine mapping Human overlay fail-closed', async () => {
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

    expect(snapshot.lifecycle.items[0]).not.toHaveProperty('humanHold');
    expect(snapshot.lifecycle.items[0]).not.toHaveProperty('humanReason');
    expect(snapshot.lifecycle.items[0]).not.toHaveProperty('obsoleteMachineMappingHuman');
  });

  it('treats a signed legacy mapping Human record as repairable machine pause, not Human authority', async () => {
    const original = page('page-2').nodes[0]!;
    const generation = '22222222-2222-4222-8222-222222222222';
    const mappingReason = {
      phase: 'implementing' as const,
      code: 'branch-mapping-ambiguous' as const,
      detail: 'Old evidence could not uniquely map this PR.',
    };
    const issueNumbers = [42, 43];
    const signature = mappingDiagnosticSignature({
      issueNumbers,
      detail: mappingReason.detail,
    });
    const mappingDiagnostic = {
      selectedIssueNumber: 42,
      issueNumbers,
      detail: mappingReason.detail,
      signature,
    };
    const source = reader({
      readPullRequests: async () => ({
        nodes: [{
          ...original,
          labels: ['engine:review'],
          humanIssueNumber: 42,
          humanAuthor: 'maintenance-bot',
          humanHead: HEAD,
          humanGeneration: generation,
          humanDiagnosticIssueNumbers: issueNumbers,
          humanDiagnosticSignature: signature,
          humanLabelActor: null,
          draftActor: null,
          humanReason: mappingReason,
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
              mappingDiagnostic,
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
      obsoleteMachineMappingHuman: {
        author: 'maintenance-bot',
        generation,
        mappingDiagnostic,
        reason: mappingReason,
      },
    });
    expect(snapshot.lifecycle.items[0]).not.toHaveProperty('humanHold');
    expect(snapshot.lifecycle.items[0]).not.toHaveProperty('humanReason');
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

  it('treats a pre-CAS machine mapping audit as inert while its exact review claim is active', async () => {
    const original = page('page-2').nodes[0]!;
    const generation = '22222222-2222-4222-8222-222222222222';
    const source = reader({
      readPullRequests: async () => ({
        nodes: [{
          ...original,
          humanIssueNumber: 42,
          humanAuthor: 'maintenance-bot',
          humanHead: HEAD,
          humanGeneration: generation,
          humanReason: {
            phase: 'implementing',
            code: 'branch-mapping-ambiguous',
            detail: 'A live contender made the mapping ambiguous.',
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
              state: 'active',
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
    const item = snapshot.lifecycle.items[0];
    expect(item).not.toHaveProperty('humanHold');
    expect(item).not.toHaveProperty('obsoleteMachineMappingHuman');
    expect(deriveLifecycle(
      snapshot.lifecycle,
      new Date('2026-07-20T09:01:00.000Z'),
      2 * 60 * 60 * 1_000,
    ).items[0]).toMatchObject({ phase: 'reviewing' });
  });

  it.each([
    {
      name: 'maintainer-authored',
      author: 'maintainer',
      issueBlockedOn: 'Nothing' as const,
      reasonCode: 'branch-mapping-ambiguous' as const,
      claimHead: HEAD,
      expectedHuman: false,
    },
    {
      name: 'explicit issue Human hold',
      author: 'maintenance-bot',
      issueBlockedOn: 'Human' as const,
      reasonCode: 'branch-mapping-ambiguous' as const,
      claimHead: HEAD,
      expectedHuman: true,
    },
    {
      name: 'different structured reason code',
      author: 'maintenance-bot',
      issueBlockedOn: 'Nothing' as const,
      reasonCode: 'implementation-escalation' as const,
      claimHead: HEAD,
      expectedHuman: false,
    },
    {
      name: 'different review head',
      author: 'maintenance-bot',
      issueBlockedOn: 'Nothing' as const,
      reasonCode: 'branch-mapping-ambiguous' as const,
      claimHead: 'cccccccccccccccccccccccccccccccccccccccc',
      expectedHuman: false,
    },
  ])('preserves a $name mapping Human overlay', async ({
    author,
    issueBlockedOn,
    reasonCode,
    claimHead,
    expectedHuman,
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

    if (expectedHuman) {
      expect(snapshot.lifecycle.items[0]).toMatchObject({ humanHold: true });
    } else {
      expect(snapshot.lifecycle.items[0]).not.toHaveProperty('humanHold');
      expect(snapshot.lifecycle.items[0]).not.toHaveProperty('humanReason');
    }
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

  it('treats a contradictory structured Human comment as inert audit evidence', async () => {
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

    expect(snapshot.lifecycle.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'pull-request', prNumber: 101, issueNumber: 42 }),
      expect.objectContaining({ kind: 'pull-request', prNumber: 102, issueNumber: 43 }),
    ]));
    expect(snapshot.diagnostics).toEqual([]);
  });
});
