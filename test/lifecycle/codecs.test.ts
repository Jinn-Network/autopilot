// @ts-nocheck — Stage 5: deleted merge-prep/review-fix/project-status fixtures.
import { describe, expect, it } from 'vitest';
import {
  branchNameForIssue,
  decodeBranchClaimTrailers,
  decodeReviewClaimPayload,
  encodeBranchClaimTrailers,
  encodeReviewClaimPayload,
  extractMergePrepCompletionSummary,
  formatAutomatedReviewMarker,
  formatHumanCommentMarker,
  mappingDiagnosticSignature,
  parseAutomatedReviewMarker,
  parseHumanCommentEvidence,
  reviewClaimRef,
} from '../../src/lifecycle/codecs.js';
import {
  gitOid,
  gitRefName,
  type BranchClaim,
  type ReviewClaimRecord,
} from '../../src/lifecycle/types.js';

const OID_A = gitOid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

describe('lifecycle metadata codecs', () => {

  it('round-trips an implementation branch claim through strict trailers', () => {
    const claim = {
      kind: 'branch-claim' as const,
      protocolVersion: 2 as const,
      phase: 'implement' as const,
      issueNumber: 42,
      prNumber: 101,
      attempt: '11111111-1111-4111-8111-111111111111',
      runner: 'runner-eu-1',
      login: 'jinn-implementer',
      expectedHead: OID_A,
      targetBase: gitRefName('next'),
      claimedAt: '2026-07-20T10:00:00.000Z',
      phaseComplete: true as const,
    };

    expect(decodeBranchClaimTrailers(encodeBranchClaimTrailers(claim))).toEqual(claim);
  });

  it('round-trips review claims and rejects contradictory terminal verdicts', () => {
    const record = {
      kind: 'review-claim' as const,
      protocolVersion: 2 as const,
      prNumber: 101,
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      reviewer: 'jinn-reviewer',
      head: OID_A,
      state: 'terminal-approved' as const,
      recordedAt: '2026-07-20T10:05:00.000Z',
      verdict: {
        marker: '44444444-4444-4444-8444-444444444444',
        state: 'APPROVE' as const,
      },
    };

    expect(decodeReviewClaimPayload(encodeReviewClaimPayload(record))).toEqual(record);
    const wireRecord = JSON.parse(encodeReviewClaimPayload(record)) as Record<string, unknown>;
    expect(() => decodeReviewClaimPayload(JSON.stringify({
      ...wireRecord,
      verdict: { ...record.verdict, state: 'REQUEST_CHANGES' },
    }))).toThrow(/terminal-approved.*APPROVE/);
  });

  it('round-trips a reviewed-diff digest and rejects every malformed shape', () => {
    const record = {
      kind: 'review-claim' as const,
      protocolVersion: 2 as const,
      prNumber: 101,
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      reviewer: 'jinn-reviewer',
      head: OID_A,
      state: 'terminal-approved' as const,
      recordedAt: '2026-07-20T10:05:00.000Z',
      reviewedDiffDigest: `v1:${'c'.repeat(64)}`,
      verdict: {
        marker: '44444444-4444-4444-8444-444444444444',
        state: 'APPROVE' as const,
      },
    };
    expect(decodeReviewClaimPayload(encodeReviewClaimPayload(record))).toEqual(record);

    // A claim written before the field existed stays valid and stays digest-less,
    // which is what keeps the merge gate on its exact-head rule for it.
    const { reviewedDiffDigest: _omitted, ...legacy } = record;
    expect(decodeReviewClaimPayload(encodeReviewClaimPayload(legacy)))
      .not.toHaveProperty('reviewedDiffDigest');

    const wire = JSON.parse(encodeReviewClaimPayload(record)) as Record<string, unknown>;
    for (const bad of [
      'c'.repeat(64),
      `v1:${'c'.repeat(63)}`,
      `v2:${'c'.repeat(64)}`,
      `v1:${'C'.repeat(64)}`,
      '',
      7,
      null,
    ]) {
      // Rejected, never silently dropped: "asserts an unparseable identity" and
      // "asserts nothing" must stay distinguishable.
      expect(() => decodeReviewClaimPayload(JSON.stringify({
        ...wire,
        reviewedDiffDigest: bad,
      }))).toThrow(/reviewed diff digest/i);
    }

    // A digest is evidence about a verdict's subject and is refused anywhere else.
    expect(() => decodeReviewClaimPayload(JSON.stringify({
      ...wire,
      state: 'stale',
      verdict: undefined,
    }))).toThrow(/contradictory reviewed diff digest/i);
  });

  it('round-trips durable mapping reread and signed Human intent review claims', () => {
    const common = {
      kind: 'review-claim' as const,
      protocolVersion: 2 as const,
      prNumber: 101,
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      reviewer: 'jinn-reviewer',
      head: OID_A,
      recordedAt: '2026-07-20T10:05:00.000Z',
    };
    const mappingRequest = {
      selectedIssueNumber: 42,
      headRefName: 'autopilot/42',
      baseRefName: 'next',
    };
    const mappingDiagnostic = {
      selectedIssueNumber: 42,
      issueNumbers: [42, 43],
      detail: 'PR #101 maps both issues.',
      signature: mappingDiagnosticSignature({
        issueNumbers: [42, 43],
        detail: 'PR #101 maps both issues.',
      }),
    };

    for (const record of [
      { ...common, state: 'mapping-reread' as const, mappingRequest },
      { ...common, state: 'human-intent' as const, mappingDiagnostic },
      { ...common, state: 'human' as const, mappingDiagnostic },
    ]) {
      expect(decodeReviewClaimPayload(encodeReviewClaimPayload(record))).toEqual(record);
    }
    const { kind: _kind, ...wireCommon } = common;
    expect(() => decodeReviewClaimPayload(JSON.stringify({
      ...wireCommon,
      state: 'human-intent',
      mappingDiagnostic: {
        ...mappingDiagnostic,
        signature: 'f'.repeat(64),
      },
    }))).toThrow(/signature/i);
  });

  it('rejects malformed protocol values instead of coercing them', () => {
    expect(() => gitOid('ABC')).toThrow(/Git OID/);
    expect(() => gitRefName('refs/heads/a..b')).toThrow(/Git ref name/);
    expect(() => decodeBranchClaimTrailers(
      encodeBranchClaimTrailers({
        kind: 'branch-claim',
        protocolVersion: 2,
        phase: 'implement',
        issueNumber: 42,
        attempt: '11111111-1111-4111-8111-111111111111',
        runner: 'runner',
        login: 'login',
        expectedHead: OID_A,
        targetBase: gitRefName('next'),
        claimedAt: '2026-07-20T10:00:00.000Z',
      }).replace('Jinn-Autopilot-Protocol: 2', 'Jinn-Autopilot-Protocol: 1'),
    )).toThrow(/protocol version/);
    expect(() => decodeReviewClaimPayload(JSON.stringify({
      protocolVersion: 2,
      prNumber: 101,
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      reviewer: 'reviewer',
      head: OID_A,
      state: 'released',
      recordedAt: '2026-07-20T10:05:00.000Z',
    }))).toThrow(/state/);
  });

  it('rejects string PR numbers in review claim JSON', () => {
    expect(() => decodeReviewClaimPayload(JSON.stringify({
      protocolVersion: 2,
      prNumber: '101',
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      reviewer: 'reviewer',
      head: OID_A,
      state: 'active',
      recordedAt: '2026-07-20T10:05:00.000Z',
    }))).toThrow(/PR number/);
  });

  it('requires the review-claim discriminator when encoding runtime records', () => {
    const record: ReviewClaimRecord = {
      kind: 'review-claim',
      protocolVersion: 2,
      prNumber: 101,
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      reviewer: 'reviewer',
      head: OID_A,
      state: 'active',
      recordedAt: '2026-07-20T10:05:00.000Z',
    };

    expect(() => encodeReviewClaimPayload({
      ...record,
      kind: undefined,
    } as unknown as ReviewClaimRecord)).toThrow(/kind/);
  });

  it('rejects a runtime discriminator in the review wire payload', () => {
    expect(() => decodeReviewClaimPayload(JSON.stringify({
      kind: 'review-claim',
      protocolVersion: 2,
      prNumber: 101,
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      reviewer: 'reviewer',
      head: OID_A,
      state: 'active',
      recordedAt: '2026-07-20T10:05:00.000Z',
    }))).toThrow(/Unknown field: kind/);
  });

  it('strictly validates branch claim objects before encoding', () => {
    const claim: BranchClaim = {
      kind: 'branch-claim',
      protocolVersion: 2,
      phase: 'implement',
      issueNumber: 42,
      attempt: '11111111-1111-4111-8111-111111111111',
      runner: 'runner',
      login: 'login',
      expectedHead: OID_A,
      targetBase: gitRefName('next'),
      claimedAt: '2026-07-20T10:00:00.000Z',
    };

    expect(() => encodeBranchClaimTrailers({
      ...claim,
      kind: 'other',
    } as unknown as BranchClaim)).toThrow(/kind/);
    expect(() => encodeBranchClaimTrailers({
      ...claim,
      unexpected: true,
    } as unknown as BranchClaim)).toThrow(/Unknown field/);
  });

  it('requires numeric positive integer issue and PR values when encoding branch claims', () => {
    const claim: BranchClaim = {
      kind: 'branch-claim',
      protocolVersion: 2,
      phase: 'implement',
      issueNumber: 42,
      prNumber: 101,
      attempt: '11111111-1111-4111-8111-111111111111',
      runner: 'runner',
      login: 'login',
      expectedHead: OID_A,
      targetBase: gitRefName('next'),
      claimedAt: '2026-07-20T10:00:00.000Z',
    };

    expect(() => encodeBranchClaimTrailers({
      ...claim,
      issueNumber: '42',
    } as unknown as BranchClaim)).toThrow(/issue number/);
    expect(() => encodeBranchClaimTrailers({
      ...claim,
      prNumber: '101',
    } as unknown as BranchClaim)).toThrow(/PR number/);
  });

  it('derives stable refs and round-trips the automated review marker', () => {
    expect(branchNameForIssue(42)).toBe('autopilot/42');
    expect(reviewClaimRef(101)).toBe('refs/jinn-autopilot/review-claims/v1/101');

    const marker = formatAutomatedReviewMarker({
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      intent: '44444444-4444-4444-8444-444444444444',
      reviewer: 'review-bot',
      head: OID_A,
      verdict: 'REQUEST_CHANGES',
    });
    expect(marker).toBe(
      '<!-- jinn-autopilot-review:v2 generation=22222222-2222-4222-8222-222222222222 '
      + 'attempt=33333333-3333-4333-8333-333333333333 '
      + 'intent=44444444-4444-4444-8444-444444444444 reviewer=review-bot '
      + 'head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa verdict=REQUEST_CHANGES -->',
    );
    expect(parseAutomatedReviewMarker(marker)).toEqual({
      generation: '22222222-2222-4222-8222-222222222222',
      attempt: '33333333-3333-4333-8333-333333333333',
      intent: '44444444-4444-4444-8444-444444444444',
      reviewer: 'review-bot',
      head: OID_A,
      verdict: 'REQUEST_CHANGES',
    });
    expect(() => parseAutomatedReviewMarker(`${marker} trailing`)).toThrow(/review marker/);
  });

  it('round-trips exact head and generation provenance in a mapping Human marker', () => {
    const generation = '22222222-2222-4222-8222-222222222222';
    const reason = {
      phase: 'implementing' as const,
      code: 'branch-mapping-ambiguous' as const,
      detail: 'Mapping was ambiguous.',
    };
    const marker = formatHumanCommentMarker({
      issueNumber: 42,
      prNumber: 101,
      head: OID_A,
      generation,
      reason,
    });

    expect(marker).toBe(
      '<!-- jinn-autopilot-human:v2 issue=42 pr=101 phase=implementing '
      + 'code=branch-mapping-ambiguous '
      + 'head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa '
      + 'generation=22222222-2222-4222-8222-222222222222 -->',
    );
    expect(parseHumanCommentEvidence(`${marker}\n\nMapping was ambiguous.`)).toEqual({
      issueNumber: 42,
      prNumber: 101,
      head: OID_A,
      generation,
      reason,
    });
  });

  it('binds the complete canonical mapping diagnostic into the Human marker', () => {
    const generation = '22222222-2222-4222-8222-222222222222';
    const reason = {
      phase: 'reviewing' as const,
      code: 'branch-mapping-ambiguous' as const,
      detail: 'PR #101 maps both issues.',
    };
    const signature = mappingDiagnosticSignature({
      issueNumbers: [43, 42, 43],
      detail: reason.detail,
    });
    expect(signature).toBe(
      mappingDiagnosticSignature({ issueNumbers: [42, 43], detail: reason.detail }),
    );
    const marker = formatHumanCommentMarker({
      issueNumber: 42,
      prNumber: 101,
      head: OID_A,
      generation,
      reason,
      diagnosticIssueNumbers: [42, 43],
      diagnosticSignature: signature,
    });
    expect(marker).toContain(`diagnostic=${signature}`);
    expect(parseHumanCommentEvidence(`${marker}\n\n${reason.detail}`)).toEqual({
      issueNumber: 42,
      prNumber: 101,
      head: OID_A,
      generation,
      diagnosticIssueNumbers: [42, 43],
      diagnosticSignature: signature,
      reason,
    });
    expect(
      parseHumanCommentEvidence(`${marker}\n\nA different diagnostic.`),
    ).toBeNull();
    const changedSet = mappingDiagnosticSignature({
      issueNumbers: [42, 44],
      detail: reason.detail,
    });
    const changedDetail = mappingDiagnosticSignature({
      issueNumbers: [42, 43],
      detail: 'Different detail.',
    });
    expect(changedSet).not.toBe(signature);
    expect(changedDetail).not.toBe(signature);
  });

  it('rejects string numerics in runtime ref-name helpers', () => {
    expect(() => branchNameForIssue('42' as unknown as number)).toThrow(/issue number/);
    expect(() => reviewClaimRef('101' as unknown as number)).toThrow(/PR number/);
  });
});
