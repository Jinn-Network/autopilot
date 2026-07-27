// @ts-nocheck — Stage 5: deleted merge-prep/review-fix/project-status fixtures.
import { describe, expect, it } from 'vitest';
import { deriveLifecycle } from '../../src/lifecycle/lifecycle.js';
import {
  planProjection,
  type ProjectionContext,
} from '../../src/lifecycle/projection.js';
import { mappingDiagnosticSignature } from '../../src/lifecycle/codecs.js';
import { gitOid, gitRefName, type LifecycleItem } from '../../src/lifecycle/types.js';

const HEAD = gitOid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const REVIEW_OID = gitOid('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const NOW = new Date('2026-07-20T12:00:00.000Z');

function item(
  overrides: Partial<Extract<LifecycleItem, { kind: 'pull-request' }>> = {},
): Extract<LifecycleItem, { kind: 'pull-request' }> {
  return {
    kind: 'pull-request',
    issueNumber: 42,
    prNumber: 101,
    v2Marked: true,
    projectStatus: 'Todo',
    labels: [],
    head: HEAD,
    headChangedAt: '2026-07-20T11:00:00.000Z',
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
      prNumber: 101,
      attempt: '11111111-1111-4111-8111-111111111111',
      runner: 'runner-a',
      login: 'implementer',
      expectedHead: HEAD,
      targetBase: gitRefName('next'),
      claimedAt: '2026-07-20T11:00:00.000Z',
    },
    ...overrides,
  };
}

function context(
  lifecycleItem: Extract<LifecycleItem, { kind: 'pull-request' }>,
  reviewRefOid?: typeof REVIEW_OID,
): ProjectionContext {
  return {
    view: deriveLifecycle({ items: [lifecycleItem] }, NOW, 2 * 60 * 60 * 1000),
    pullRequests: [{
      number: lifecycleItem.prNumber,
      reviewRefOid,
    }],
    orphanBranchClaims: [],
  };
}

describe('planProjection', () => {
  it('keeps engine:review on a draft v2 implementation PR', () => {
    const plan = planProjection(context(item({
      projectStatus: 'In Progress',
      labels: ['engine:review'],
      isDraft: true,
    })));

    expect(plan.actions).not.toContainEqual({
      kind: 'set-pr-label',
      prNumber: 101,
      expectedHead: HEAD,
      label: 'engine:review',
      present: false,
    });
  });

  it('repairs an implementation PR to draft without Project Status writes', () => {
    const plan = planProjection(context(item({
      projectStatus: 'Todo',
      isDraft: false,
    })));

    expect(plan.actions).toEqual([
      {
        kind: 'set-pr-draft',
        prNumber: 101,
        expectedHead: HEAD,
        draft: true,
      },
      {
        kind: 'set-pr-label',
        prNumber: 101,
        expectedHead: HEAD,
        label: 'engine:review',
        present: true,
      },
    ]);
  });

  it('repairs a phase-complete draft last without Project Status writes', () => {
    const complete = item({
      implementationSummary: 'Implemented exact lifecycle ownership.',
      branchClaim: {
        ...item().branchClaim!,
        phaseComplete: true,
      },
    });

    const plan = planProjection(context(complete));

    expect(plan.actions).toEqual([
      {
        kind: 'ensure-implementation-summary',
        prNumber: 101,
        expectedHead: HEAD,
        summary: 'Implemented exact lifecycle ownership.',
      },
      {
        kind: 'set-pr-label',
        prNumber: 101,
        expectedHead: HEAD,
        label: 'engine:review',
        present: true,
        requiresPreviousSuccess: true,
      },
      {
        kind: 'set-pr-draft',
        prNumber: 101,
        expectedHead: HEAD,
        draft: false,
        requiresPreviousSuccess: true,
      },
    ]);
  });

  it('does not convert an explicit shared Human hold into a machine comment or more shared state', () => {
    const held = item({
      headChangedAt: '2026-07-20T08:00:00.000Z',
      projectStatus: 'In Progress',
      labels: ['review:needs-human'],
      humanReason: {
        phase: 'implementing',
        code: 'implementation-escalation',
        detail: 'Needs product judgment',
      },
    });

    const plan = planProjection(context(held));

    expect(plan.actions).toEqual([]);
  });

  it('projects a machine Human review ref as only an exact-generation audit comment', () => {
    const generation = '22222222-2222-4222-8222-222222222222';
    const held = item({
      branchClaim: undefined,
      isDraft: false,
      labels: ['engine:review'],
      humanReason: {
        phase: 'reviewing',
        code: 'review-escalation',
        detail: 'Needs product judgment',
      },
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation,
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD,
        state: 'human',
        recordedAt: '2026-07-20T11:00:00.000Z',
      },
    });

    const plan = planProjection(context(held, REVIEW_OID));

    expect(plan.actions).toEqual([{
      kind: 'ensure-human-comment',
      issueNumber: 42,
      prNumber: 101,
      expectedHead: HEAD,
      expectedReviewRefOid: REVIEW_OID,
      expectedGeneration: generation,
      marker: '<!-- jinn-autopilot-human:v2 issue=42 pr=101 phase=reviewing '
        + `code=review-escalation head=${HEAD} generation=${generation} -->`,
      body: expect.stringContaining('Needs product judgment'),
    }]);
  });

  it('plans no repair for an unsigned legacy mapping Human overlay', () => {
    const held = item({
      humanReason: {
        phase: 'implementing',
        code: 'branch-mapping-ambiguous',
        detail: 'Old mapping evidence was ambiguous.',
      },
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD,
        state: 'human',
        recordedAt: '2026-07-20T11:00:00.000Z',
      },
      obsoleteMachineMappingHuman: {
        generation: '22222222-2222-4222-8222-222222222222',
        author: 'maintenance-bot',
        reason: {
          phase: 'implementing',
          code: 'branch-mapping-ambiguous',
          detail: 'Old mapping evidence was ambiguous.',
        },
      },
    });

    expect(planProjection(context(held, REVIEW_OID)).actions).toEqual([]);
  });

  it('plans one signed CAS-fenced repair for a future machine mapping Human overlay', () => {
    const detail = 'Old mapping evidence was ambiguous.';
    const mappingDiagnostic = {
      selectedIssueNumber: 42,
      issueNumbers: [42, 43],
      detail,
      signature: mappingDiagnosticSignature({
        issueNumbers: [42, 43],
        detail,
      }),
    };
    const held = item({
      labels: ['engine:review', 'review:needs-human'],
      humanReason: {
        phase: 'implementing',
        code: 'branch-mapping-ambiguous',
        detail,
      },
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD,
        state: 'human',
        mappingDiagnostic,
        recordedAt: '2026-07-20T11:00:00.000Z',
      },
      obsoleteMachineMappingHuman: {
        generation: '22222222-2222-4222-8222-222222222222',
        author: 'maintenance-bot',
        mappingDiagnostic,
        reason: {
          phase: 'implementing',
          code: 'branch-mapping-ambiguous',
          detail,
        },
      },
    });

    expect(planProjection(context(held, REVIEW_OID)).actions).toEqual([{
      kind: 'repair-obsolete-mapping-human',
      issueNumber: 42,
      prNumber: 101,
      expectedHead: HEAD,
      expectedReviewRefOid: REVIEW_OID,
      expectedGeneration: '22222222-2222-4222-8222-222222222222',
      expectedAuthor: 'maintenance-bot',
      mappingDiagnostic,
      marker: '<!-- jinn-autopilot-human:v2 issue=42 pr=101 phase=implementing '
        + 'code=branch-mapping-ambiguous '
        + 'head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa '
        + 'generation=22222222-2222-4222-8222-222222222222 '
        + `issues=42,43 diagnostic=${mappingDiagnostic.signature} -->`,
    }]);
  });

  it('marks a stale review ref and completes recoverable APPROVE verdict intent', () => {
    const reviewBase = item({
      branchClaim: undefined,
      isDraft: false,
      headChangedAt: '2026-07-20T08:00:00.000Z',
      reviewClaim: {
        kind: 'review-claim',
        protocolVersion: 2,
        prNumber: 101,
        generation: '22222222-2222-4222-8222-222222222222',
        attempt: '33333333-3333-4333-8333-333333333333',
        reviewer: 'reviewer',
        head: HEAD,
        state: 'active',
        recordedAt: '2026-07-20T08:00:00.000Z',
      },
    });
    expect(planProjection(context(reviewBase, REVIEW_OID)).actions).toContainEqual({
      kind: 'mark-review-stale',
      prNumber: 101,
      expectedHead: HEAD,
      expectedReviewRefOid: REVIEW_OID,
    });

    const intent = item({
      branchClaim: undefined,
      isDraft: true,
      reviewClaim: {
        ...reviewBase.reviewClaim!,
        state: 'verdict-intent',
        verdict: {
          marker: '44444444-4444-4444-8444-444444444444',
          state: 'APPROVE',
        },
      },
      terminalVerdict: {
        head: HEAD,
        marker: '44444444-4444-4444-8444-444444444444',
        state: 'APPROVE',
        recordedAt: '2026-07-20T11:00:00.000Z',
      },
    });
    expect(planProjection(context(intent, REVIEW_OID)).actions).toContainEqual({
      kind: 'complete-verdict-intent',
      prNumber: 101,
      expectedHead: HEAD,
      expectedReviewRefOid: REVIEW_OID,
      state: 'terminal-approved',
    });
  });

  it('creates a draft PR for an orphan implementation claim without Project Status paint', () => {
    const orphanContext: ProjectionContext = {
      view: { items: [] },
      pullRequests: [],
      orphanBranchClaims: [{
        issueNumber: 43,
        head: HEAD,
        headRefName: 'autopilot/43',
        headChangedAt: '2026-07-20T11:00:00.000Z',
        baseRefName: 'next',
        claimAttempt: '11111111-1111-4111-8111-111111111111',
        claimRunner: 'runner-a',
        projectStatus: 'Todo',
        phase: 'implementing',
        progressAgeMs: 60 * 60 * 1000,
        stale: false,
      }],
    };
    expect(planProjection(orphanContext).actions).toEqual([
      {
        kind: 'ensure-draft-pr',
        issueNumber: 43,
        expectedHead: HEAD,
        headRefName: 'autopilot/43',
        baseRefName: 'next',
      },
    ]);
  });

  it('preserves a Human hold instead of creating a PR for an orphan implementation claim', () => {
    const humanReason = {
      phase: 'implementing' as const,
      code: 'implementation-escalation' as const,
      detail: 'Waiting for an operator decision',
    };
    const orphanContext: ProjectionContext = {
      view: { items: [] },
      pullRequests: [],
      mappingDiagnostics: [],
      orphanBranchClaims: [{
        issueNumber: 43,
        head: HEAD,
        headRefName: 'autopilot/43',
        headChangedAt: '2026-07-20T11:00:00.000Z',
        baseRefName: 'next',
        claimAttempt: '11111111-1111-4111-8111-111111111111',
        claimRunner: 'runner-a',
        projectStatus: 'In Progress',
        phase: 'human',
        underlyingPhase: 'implementing',
        progressAgeMs: 60 * 60 * 1000,
        stale: false,
        humanHold: true,
        humanReason,
      }],
    };

    // Stage 3: Human Project Status paint is painter-owned; cycle projection
    // does not emit set-project-status for orphan Human holds.
    expect(planProjection(orphanContext).actions).toEqual([]);
  });

  it('does not create a destructive or unbound overlay for a multi-issue diagnostic', () => {
    const ambiguous: ProjectionContext = {
      view: { items: [] },
      pullRequests: [],
      orphanBranchClaims: [],
      mappingDiagnostics: [{
        code: 'branch-mapping-ambiguous',
        detail: 'PR #101 resolves issues #42 and #43',
        issueNumbers: [42, 43],
        issues: [
          { number: 42, projectStatus: 'Todo' },
          { number: 43, projectStatus: 'Human' },
        ],
        pullRequests: [{
          number: 101,
          head: HEAD,
          draft: false,
          labels: [],
        }],
      }],
    };

    expect(planProjection(ambiguous).actions).toEqual([]);
  });

  it('keeps a durable mapping reread request machine-owned while ambiguity persists', () => {
    const generation = '22222222-2222-4222-8222-222222222222';
    const detail = 'PR #101 resolves issues #42 and #43';
    const signature = mappingDiagnosticSignature({
      issueNumbers: [42, 43],
      detail,
    });
    const diagnostic: ProjectionContext = {
      view: { items: [] },
      pullRequests: [{
        number: 101,
        scheduledIssueNumber: 42,
        reviewRefOid: REVIEW_OID,
        headRefName: 'autopilot/42',
        baseRefName: 'next',
        reviewClaim: {
          head: HEAD,
          generation,
          state: 'mapping-reread',
          mappingRequest: {
            selectedIssueNumber: 42,
            headRefName: 'autopilot/42',
            baseRefName: 'next',
          },
        },
      }],
      orphanBranchClaims: [],
      mappingDiagnostics: [{
        code: 'branch-mapping-ambiguous',
        detail,
        issueNumbers: [42, 43],
        signature,
        issues: [
          { number: 42, projectStatus: 'In Review' },
          { number: 43, projectStatus: 'Todo' },
        ],
        pullRequests: [{
          number: 101,
          head: HEAD,
          draft: false,
          labels: ['engine:review'],
        }],
      }],
    };
    expect(planProjection(diagnostic).actions).toEqual([]);
  });

  it('does not advance a legacy mapping Human intent while ambiguity persists', () => {
    const generation = '22222222-2222-4222-8222-222222222222';
    const detail = 'Another open PR also maps issue #42';
    const signature = mappingDiagnosticSignature({ issueNumbers: [42], detail });
    const mappingDiagnostic = {
      selectedIssueNumber: 42,
      issueNumbers: [42],
      detail,
      signature,
    };
    const diagnostic: ProjectionContext = {
      view: { items: [] },
      pullRequests: [{
        number: 101,
        scheduledIssueNumber: 42,
        reviewRefOid: REVIEW_OID,
        headRefName: 'autopilot/42',
        baseRefName: 'next',
        reviewClaim: {
          head: HEAD,
          generation,
          state: 'human-intent',
          mappingDiagnostic,
        },
      }],
      orphanBranchClaims: [],
      mappingDiagnostics: [{
        code: 'branch-mapping-ambiguous',
        detail,
        issueNumbers: [42],
        signature,
        issues: [{ number: 42, projectStatus: 'In Review' }],
        pullRequests: [{
          number: 101,
          head: HEAD,
          draft: false,
          labels: ['engine:review'],
        }],
      }],
    };

    expect(planProjection(diagnostic).actions).toEqual([]);
  });

  it('releases a mapping reread request when the canonical ambiguity resolved', () => {
    expect(planProjection({
      view: { items: [] },
      snapshotComplete: true,
      pullRequests: [{
        number: 101,
        resolvedIssueNumber: 42,
        reviewRefOid: REVIEW_OID,
        headRefName: 'autopilot/42',
        baseRefName: 'next',
        reviewClaim: {
          head: HEAD,
          generation: '22222222-2222-4222-8222-222222222222',
          state: 'mapping-reread',
          mappingRequest: {
            selectedIssueNumber: 42,
            headRefName: 'autopilot/42',
            baseRefName: 'next',
          },
        },
      }],
      orphanBranchClaims: [],
      mappingDiagnostics: [],
    }).actions).toEqual([{
      kind: 'mark-review-stale',
      prNumber: 101,
      expectedHead: HEAD,
      expectedReviewRefOid: REVIEW_OID,
    }]);
  });

  it('does not release a mapping reread without a complete resolved PR-to-issue mapping', () => {
    expect(planProjection({
      view: { items: [] },
      snapshotComplete: true,
      pullRequests: [{
        number: 101,
        reviewRefOid: REVIEW_OID,
        headRefName: 'autopilot/42',
        baseRefName: 'next',
        reviewClaim: {
          head: HEAD,
          generation: '22222222-2222-4222-8222-222222222222',
          state: 'mapping-reread',
          mappingRequest: {
            selectedIssueNumber: 42,
            headRefName: 'autopilot/42',
            baseRefName: 'next',
          },
        },
      }],
      orphanBranchClaims: [],
      mappingDiagnostics: [],
    }).actions).toEqual([]);
  });
});
