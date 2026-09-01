import type { AttemptManifest } from './attempt-workspace.js';
import {
  formatAutomatedReviewMarker,
  formatHumanCommentMarker,
} from './codecs.js';
import {
  effectiveNativeReviews,
  isSupersededOwnedNativeRequest,
} from './native-review.js';
import type {
  FiledReviewFollowUp,
  ReviewFollowUpEntry,
} from './review-follow-ups.js';
import type { ReviewNativeReview } from './review-executor.js';
import { isReviewedDiffDigest } from './reviewed-diff-digest.js';
import type {
  ReviewedDiffDigestResult,
  ReviewedDiffDigestUnavailableReason,
} from './reviewed-diff-digest.js';
import type {
  GitOid,
  HumanReason,
  PublicationOutcome,
  ReviewClaimRecord,
  ReviewVerdict,
  ReviewVerdictState,
} from './types.js';

export interface ReviewSessionAuthority {
  readonly reviewRefOid: GitOid;
  readonly record: ReviewClaimRecord;
}

export interface ReviewSessionPullRequest {
  readonly number: number;
  readonly issueNumber: number;
  readonly open: boolean;
  readonly head: GitOid;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly draft: boolean;
  readonly author: string;
  readonly labels: readonly string[];
  readonly body: string;
  readonly approvalPolicy: 'approve-eligible' | 'human-codeowner';
  readonly humanHold?: boolean;
  readonly mappingProblem?: string;
}

export interface ReviewSessionPort {
  readManifest(path: string): AttemptManifest;
  readAuthority(manifest: AttemptManifest): Promise<ReviewSessionAuthority>;
  readPullRequest(
    prNumber: number,
    expectedHead: GitOid,
  ): Promise<ReviewSessionPullRequest>;
  readNativeReviews(
    prNumber: number,
    expectedHead: GitOid,
  ): Promise<readonly ReviewNativeReview[]>;
  hasHumanHold(
    issueNumber: number,
    prNumber: number,
    expectedHead: GitOid,
  ): Promise<boolean>;
  createReviewRecord(input: {
    readonly manifest: AttemptManifest;
    readonly parent: GitOid;
    readonly record: ReviewClaimRecord;
  }): Promise<GitOid>;
  publishReviewClaim(input: {
    readonly manifest: AttemptManifest;
    readonly recordParent: GitOid;
    readonly expectedRemoteRecordOid: GitOid;
    readonly recordOid: GitOid;
    readonly record: ReviewClaimRecord;
  }): Promise<PublicationOutcome>;
  submitNativeReview(input: {
    readonly manifest: AttemptManifest;
    readonly prNumber: number;
    readonly commitId: GitOid;
    readonly reviewer: string;
    readonly state: ReviewVerdictState;
    readonly body: string;
  }): Promise<void>;
  setPullRequestLabel(
    prNumber: number,
    expectedHead: GitOid,
    label: string,
    present: boolean,
  ): Promise<void>;
  setPullRequestDraft(
    prNumber: number,
    expectedHead: GitOid,
    draft: boolean,
  ): Promise<void>;
  hasHumanComment(
    prNumber: number,
    expectedHead: GitOid,
    expectedReviewRefOid: GitOid,
    expectedGeneration: string,
    expectedReviewState: ReviewClaimRecord['state'],
    body: string,
  ): Promise<boolean>;
  ensureHumanComment(
    prNumber: number,
    expectedHead: GitOid,
    expectedReviewRefOid: GitOid,
    expectedGeneration: string,
    expectedReviewState: ReviewClaimRecord['state'],
    marker: string,
    body: string,
  ): Promise<void>;
  /**
   * Identity of the diff the reviewer is being asked to approve, recorded on
   * the claim so a later head can be proven to present the same diff.
   *
   * Required, and returning an *attributed* result rather than an optional
   * string. Both properties are the fix for the way this feature shipped dead:
   * as an optional method returning `string | undefined`, a port that simply
   * did not implement it produced the same bare `undefined` as a read that
   * genuinely could not prove the digest, and nothing anywhere named the
   * difference. Measured on the canary, that is exactly what happened — the
   * session build that publishes the claim had no such method at all, so every
   * claim was written without a digest and the carry could never fire.
   *
   * Unavailability is still fail-closed: no digest on the claim means the merge
   * gate keeps requiring exact head identity. It is no longer silent.
   */
  readReviewedDiffDigest(
    prNumber: number,
    expectedHead: GitOid,
  ): Promise<ReviewedDiffDigestResult>;
  fileFindingChild?(input: {
    readonly parentPr: number;
    readonly title: string;
    readonly body: string;
    readonly effort: 'low' | 'medium' | 'high';
    /**
     * The base the parent pull request carries at filing time (issue #114).
     * Recorded on the child marker so the executor's retarget check compares
     * live base against recorded base rather than against the repository
     * default, which also fired on every legitimately stacked parent.
     */
    readonly parentBase?: string;
  }): Promise<
    | { readonly number: number; readonly created: boolean; readonly runawayHold?: undefined }
    | { readonly runawayHold: true; readonly priorCount: number }
  >;
  fileReviewFollowUps?(input: {
    readonly parentPr: number;
    readonly head: GitOid;
    readonly entries: readonly ReviewFollowUpEntry[];
  }): Promise<readonly FiledReviewFollowUp[]>;
  nextMarker(): string;
  now(): Date;
}

/**
 * Why an approval was recorded without a reviewed-diff digest.
 *
 * Attribution, in the shape of `issueRefusal` in `implementation-executor.ts`
 * and `TargetedAuthorityRefusal` in `targeted-action-reader.ts`: a withheld
 * value alone is unattributable, so the site that withholds it names the cause
 * and every caller repeats that name verbatim. It exists so an operator can
 * tell "the carry is off because X" from "the carry is silently broken" — the
 * distinction this feature shipped without, and the reason it ran dead on the
 * canary for twelve review claims before anyone could see it.
 *
 * It never relaxes anything. A refusal is exactly a missing digest, and a
 * missing digest is exactly today's fail-closed behaviour: the merge gate keeps
 * requiring exact head identity.
 */
export type ReviewedDiffDigestRefusal =
  /**
   * The session build's port has no `readReviewedDiffDigest` at all. Not
   * hypothetical: this is the measured canary cause. The engine that publishes
   * the review claim is resolved separately from the engine that runs the
   * lifecycle daemon, so it can be an older build in which the method does not
   * exist, and the optional-method contract used to make that indistinguishable
   * from a proven-unprovable digest.
   */
  | 'port-unavailable'
  /** The port threw. The message is appended after a colon. */
  | `port-threw: ${string}`
  /** The port resolved to something that is not a digest result. */
  | 'port-malformed'
  /** The port's own attributed reason, repeated verbatim. */
  | ReviewedDiffDigestUnavailableReason
  /**
   * A durable `verdict-intent`/`terminal-approved` record from an earlier
   * attempt is being reused and holds no digest. The original cause was not
   * recorded, and the digest is deliberately not recomputed here: it must
   * describe the diff the reviewer read, not a later one.
   */
  | 'recorded-without-digest';

type ReviewedDiffDigestReading =
  | { readonly status: 'digest'; readonly digest: string }
  | { readonly status: 'unavailable'; readonly refusal: ReviewedDiffDigestRefusal };

export type ReviewVerdictResult =
  | { readonly status: 'requested-changes'; readonly head: GitOid }
  | {
      readonly status: 'approved';
      readonly head: GitOid;
      readonly followUpNumbers?: readonly number[];
      /**
       * Present exactly when the approval carries no reviewed-diff digest, and
       * absent when it carries one. Reported, never acted on.
       */
      readonly reviewedDiffDigestRefusal?: ReviewedDiffDigestRefusal;
    }
  | { readonly status: 'human'; readonly head: GitOid }
  | { readonly status: 'mapping-pending'; readonly head: GitOid }
  | { readonly status: 'stale' | 'ambiguous'; readonly head: GitOid };

export type ReviewFindingsResult =
  | {
      readonly status: 'filed';
      readonly head: GitOid;
      readonly childNumber: number;
      readonly created: boolean;
    }
  | { readonly status: 'human'; readonly head: GitOid }
  | { readonly status: 'mapping-pending'; readonly head: GitOid }
  | { readonly status: 'stale' | 'ambiguous'; readonly head: GitOid };

export interface ReviewSessionProtocol {
  reviewVerdict(
    manifest: AttemptManifest,
    state: ReviewVerdictState,
    body: string,
    followUps?: readonly ReviewFollowUpEntry[],
  ): Promise<ReviewVerdictResult>;
  reviewFindings?(
    manifest: AttemptManifest,
    findings: string,
  ): Promise<ReviewFindingsResult>;
  human(
    manifest: AttemptManifest,
    reason: string,
  ): Promise<{ readonly status: 'human'; readonly head: GitOid }>;
}

function requireReviewManifest(
  supplied: AttemptManifest,
  port: ReviewSessionPort,
): AttemptManifest {
  const fresh = port.readManifest(supplied.paths.manifest);
  if (
    fresh.phase !== 'review'
    || fresh.attemptId !== supplied.attemptId
    || fresh.paths.manifest !== supplied.paths.manifest
    || fresh.paths.worktree !== supplied.paths.worktree
    || fresh.prNumber === undefined
    || fresh.reviewGeneration === undefined
    || fresh.reviewRefOid === undefined
    || fresh.reviewApprovalPolicy === undefined
  ) {
    throw new Error('Review session manifest authority changed or is invalid');
  }
  return fresh;
}

async function requireAuthority(
  manifest: AttemptManifest,
  port: ReviewSessionPort,
): Promise<ReviewSessionAuthority> {
  const authority = await port.readAuthority(manifest);
  if (!authorityMatchesManifest(authority, manifest)) {
    throw new Error('Review attempt no longer owns the exact review authority');
  }
  return authority;
}

function authorityMatchesManifest(
  authority: ReviewSessionAuthority,
  manifest: AttemptManifest,
): boolean {
  const record = authority.record;
  return authority.reviewRefOid === manifest.reviewRefOid
    && record.prNumber === manifest.prNumber
    && record.generation === manifest.reviewGeneration
    && record.attempt === manifest.attemptId
    && record.reviewer.toLowerCase() === manifest.selectedLogin.toLowerCase()
    && record.head === manifest.expectedHead;
}

type PullRequestAuthorityProblem =
  | { readonly kind: 'mapping'; readonly detail: string }
  | { readonly kind: 'human'; readonly detail: string };

function pullRequestAuthorityProblem(
  manifest: AttemptManifest,
  pullRequest: ReviewSessionPullRequest,
): PullRequestAuthorityProblem | undefined {
  if (!pullRequest.open) {
    return { kind: 'human', detail: 'The review pull request is no longer open.' };
  }
  if (pullRequest.mappingProblem !== undefined) {
    return { kind: 'mapping', detail: pullRequest.mappingProblem };
  }
  if (
    pullRequest.issueNumber !== manifest.issueNumber
    || pullRequest.headRefName !== manifest.branch
    || pullRequest.baseRefName !== manifest.targetBase
  ) {
    return {
      kind: 'mapping',
      detail: 'The unique canonical PR, issue, branch, or base mapping changed.',
    };
  }
  if (pullRequest.approvalPolicy !== manifest.reviewApprovalPolicy) {
    return {
      kind: 'human',
      detail: 'The current-head CODEOWNER approval policy changed.',
    };
  }
  return undefined;
}

async function readExactPullRequest(
  manifest: AttemptManifest,
  port: ReviewSessionPort,
): Promise<ReviewSessionPullRequest> {
  const head = manifest.expectedHead as GitOid;
  const pullRequest = await port.readPullRequest(manifest.prNumber!, head);
  if (
    pullRequest.number !== manifest.prNumber
    || pullRequest.head !== head
    || pullRequest.author.toLowerCase() === manifest.selectedLogin.toLowerCase()
  ) {
    throw new Error('Review pull request authority changed or is invalid');
  }
  return pullRequest;
}

async function requirePullRequest(
  manifest: AttemptManifest,
  port: ReviewSessionPort,
): Promise<ReviewSessionPullRequest> {
  const pullRequest = await readExactPullRequest(manifest, port);
  if (pullRequestAuthorityProblem(manifest, pullRequest) !== undefined) {
    throw new Error('Review pull request authority changed or is invalid');
  }
  return pullRequest;
}

function nextRecord(
  manifest: AttemptManifest,
  state: 'active' | 'verdict-intent' | 'terminal-approved' | 'human' | 'stale',
  now: Date,
  verdict?: { readonly state: ReviewVerdictState; readonly marker: string },
  reviewedDiffDigest?: string,
): ReviewClaimRecord {
  const common = {
    kind: 'review-claim' as const,
    protocolVersion: 2 as const,
    prNumber: manifest.prNumber!,
    generation: manifest.reviewGeneration!,
    attempt: manifest.attemptId,
    reviewer: manifest.selectedLogin,
    head: manifest.expectedHead as GitOid,
    recordedAt: now.toISOString(),
  };
  // The digest describes a verdict's subject; the codec rejects it on any other
  // state, so it is attached only where it means something.
  const withDigest = reviewedDiffDigest === undefined
    ? {}
    : { reviewedDiffDigest };
  if (state === 'verdict-intent') {
    if (verdict === undefined) throw new Error('Verdict intent requires verdict metadata');
    return { ...common, ...withDigest, state, verdict };
  }
  if (state === 'terminal-approved') {
    if (verdict?.state !== 'APPROVE') {
      throw new Error('Terminal approval requires approval metadata');
    }
    return {
      ...common,
      ...withDigest,
      state,
      verdict: { ...verdict, state: 'APPROVE' },
    };
  }
  return { ...common, state };
}

function refusalDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  // Bounded and single-line: this string is reported to an operator, not
  // parsed, and a port failure can carry an arbitrarily large message.
  return detail.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Never throws and never propagates a port failure: an unreadable digest must
 * leave the claim without one, which is byte-for-byte the pre-existing
 * behaviour, and must not fail an otherwise valid approval.
 *
 * What it no longer does is stay quiet about it. Every way this can fail to
 * produce a digest returns a named cause, including the one the type system
 * now also rules out in-tree — a port build that has no such method. The method
 * is required, but the runtime guard stays: the failure this fix exists for was
 * a *build* whose port predates the method, which no compile of this file can
 * observe.
 */
async function readReviewedDiffDigest(
  manifest: AttemptManifest,
  port: ReviewSessionPort,
): Promise<ReviewedDiffDigestReading> {
  if (typeof port.readReviewedDiffDigest !== 'function') {
    return { status: 'unavailable', refusal: 'port-unavailable' };
  }
  let result: ReviewedDiffDigestResult;
  try {
    result = await port.readReviewedDiffDigest(
      manifest.prNumber!,
      manifest.expectedHead as GitOid,
    );
  } catch (error) {
    return { status: 'unavailable', refusal: `port-threw: ${refusalDetail(error)}` };
  }
  if (result?.status === 'digest' && isReviewedDiffDigest(result.digest)) {
    return { status: 'digest', digest: result.digest };
  }
  // A malformed port result is not a digest and must not be reported as one of
  // the reader's own proven reasons either.
  return result?.status === 'unavailable' && typeof result.reason === 'string'
    ? { status: 'unavailable', refusal: result.reason }
    : { status: 'unavailable', refusal: 'port-malformed' };
}

async function publishRecord(
  manifest: AttemptManifest,
  authority: ReviewSessionAuthority,
  record: ReviewClaimRecord,
  port: ReviewSessionPort,
): Promise<{ readonly status: 'published'; readonly oid: GitOid } | {
  readonly status: 'stale' | 'ambiguous';
}> {
  const oid = await port.createReviewRecord({
    manifest,
    parent: authority.reviewRefOid,
    record,
  });
  const outcome = await port.publishReviewClaim({
    manifest,
    recordParent: authority.reviewRefOid,
    expectedRemoteRecordOid: authority.reviewRefOid,
    recordOid: oid,
    record,
  });
  if (outcome.status === 'lost') return { status: 'stale' };
  if (
    outcome.status === 'ambiguous'
    || !('observed' in outcome)
    || outcome.published !== oid
    || outcome.observed !== oid
  ) {
    return { status: 'ambiguous' };
  }
  return { status: 'published', oid };
}

function nativeState(state: ReviewVerdictState): ReviewNativeReview['state'] {
  return state === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED';
}

function canonicalMarker(
  manifest: AttemptManifest,
  verdict: ReviewVerdict,
): string {
  return formatAutomatedReviewMarker({
    generation: manifest.reviewGeneration!,
    attempt: manifest.attemptId,
    intent: verdict.marker,
    reviewer: manifest.selectedLogin,
    head: manifest.expectedHead as GitOid,
    verdict: verdict.state,
  });
}

async function matchingNativeReview(
  manifest: AttemptManifest,
  verdict: ReviewVerdict,
  port: ReviewSessionPort,
): Promise<ReviewNativeReview | undefined> {
  const marker = canonicalMarker(manifest, verdict);
  return (await port.readNativeReviews(
    manifest.prNumber!,
    manifest.expectedHead as GitOid,
  )).find((review) => (
    review.reviewer.toLowerCase() === manifest.selectedLogin.toLowerCase()
    && review.commitId === manifest.expectedHead
    && review.state === nativeState(verdict.state)
    && review.body.includes(marker)
  ));
}

async function humanIsActive(
  manifest: AttemptManifest,
  port: ReviewSessionPort,
): Promise<boolean> {
  await requireAuthority(manifest, port);
  const active = await port.hasHumanHold(
    manifest.issueNumber,
    manifest.prNumber!,
    manifest.expectedHead as GitOid,
  );
  await requireAuthority(manifest, port);
  return active;
}

async function enterHuman(
  supplied: AttemptManifest,
  detail: string,
  port: ReviewSessionPort,
): Promise<{ readonly status: 'human'; readonly head: GitOid }> {
  let manifest = requireReviewManifest(supplied, port);
  let authority = await requireAuthority(manifest, port);
  const head = manifest.expectedHead as GitOid;
  const reason: HumanReason = {
    phase: 'reviewing',
    code: 'review-escalation',
    detail,
  };
  const marker = formatHumanCommentMarker({
    issueNumber: manifest.issueNumber,
    prNumber: manifest.prNumber!,
    head,
    generation: manifest.reviewGeneration!,
    reason,
  });
  const commentBody =
    `${marker}\n\nAutopilot parked this review for Human judgment.\n\n${reason.detail}`;
  if (!await humanIsActive(manifest, port)) {
    await port.setPullRequestLabel(
      manifest.prNumber!,
      head,
      'review:needs-human',
      true,
    );
  }
  if (!await humanIsActive(manifest, port)) {
    throw new Error('External Human authority was not established');
  }
  const ensureComment = async (
    expectedReviewState: ReviewClaimRecord['state'],
  ): Promise<void> => {
    if (!await port.hasHumanComment(
      manifest.prNumber!,
      head,
      authority.reviewRefOid,
      manifest.reviewGeneration!,
      expectedReviewState,
      commentBody,
    )) {
      await port.ensureHumanComment(
        manifest.prNumber!,
        head,
        authority.reviewRefOid,
        manifest.reviewGeneration!,
        expectedReviewState,
        marker,
        commentBody,
      );
    }
  };
  if (authority.record.state !== 'human') {
    const humanRecord = nextRecord(manifest, 'human', port.now());
    const published = await publishRecord(manifest, authority, humanRecord, port);
    if (published.status !== 'published') {
      throw new Error('Human review record did not win exact-parent authority');
    }
    manifest = requireReviewManifest(manifest, port);
    authority = await requireAuthority(manifest, port);
  }
  await ensureComment('human');
  return { status: 'human', head };
}

type MappingRereadResult =
  | { readonly status: 'mapping-pending' | 'human'; readonly head: GitOid }
  | { readonly status: 'stale' | 'ambiguous'; readonly head: GitOid };

async function requestMappingReread(
  supplied: AttemptManifest,
  port: ReviewSessionPort,
): Promise<MappingRereadResult> {
  let manifest = requireReviewManifest(supplied, port);
  let authority = await requireAuthority(manifest, port);
  const head = manifest.expectedHead as GitOid;
  if (await humanIsActive(manifest, port)) return { status: 'human', head };
  const mappingRequest = {
    selectedIssueNumber: manifest.issueNumber,
    headRefName: manifest.branch,
    baseRefName: manifest.targetBase,
  };
  if (authority.record.state === 'mapping-reread') {
    const current = authority.record.mappingRequest;
    if (
      current.selectedIssueNumber !== mappingRequest.selectedIssueNumber
      || current.headRefName !== mappingRequest.headRefName
      || current.baseRefName !== mappingRequest.baseRefName
    ) {
      throw new Error('Mapping reread retry contradicts the durable request');
    }
    return { status: 'mapping-pending', head };
  }
  const record: ReviewClaimRecord = {
    kind: 'review-claim',
    protocolVersion: 2,
    prNumber: manifest.prNumber!,
    generation: manifest.reviewGeneration!,
    attempt: manifest.attemptId,
    reviewer: manifest.selectedLogin,
    head,
    state: 'mapping-reread',
    mappingRequest,
    recordedAt: port.now().toISOString(),
  };
  const published = await publishRecord(manifest, authority, record, port);
  if (published.status !== 'published') {
    return { status: published.status, head };
  }
  manifest = requireReviewManifest(manifest, port);
  authority = await requireAuthority(manifest, port);
  if (
    authority.record.state !== 'mapping-reread'
    || authority.record.mappingRequest.selectedIssueNumber
      !== mappingRequest.selectedIssueNumber
    || authority.record.mappingRequest.headRefName !== mappingRequest.headRefName
    || authority.record.mappingRequest.baseRefName !== mappingRequest.baseRefName
  ) {
    throw new Error('Mapping reread request did not retain exact authority');
  }
  return { status: 'mapping-pending', head };
}

async function requireNoNativeChangeRequests(
  manifest: AttemptManifest,
  port: ReviewSessionPort,
  allowOwnedPriorRequest = false,
): Promise<void> {
  const head = manifest.expectedHead as GitOid;
  const blocking = effectiveNativeReviews(
    await port.readNativeReviews(manifest.prNumber!, head),
  ).find((review) => {
    if (review.state !== 'CHANGES_REQUESTED') return false;
    return !allowOwnedPriorRequest
      || !isSupersededOwnedNativeRequest(review, manifest.selectedLogin, head);
  });
  if (blocking !== undefined) {
    throw new Error(
      `Native requested changes by ${blocking.reviewer} block automated approval`,
    );
  }
}

async function releaseRequestedChangesProjection(
  manifest: AttemptManifest,
  pullRequest: ReviewSessionPullRequest,
  port: ReviewSessionPort,
): Promise<ReviewVerdictResult> {
  const head = manifest.expectedHead as GitOid;
  if (!pullRequest.labels.includes('review:changes-requested')) {
    await port.setPullRequestLabel(
      manifest.prNumber!,
      head,
      'review:changes-requested',
      true,
    );
  }
  if (pullRequest.labels.includes('review:approved')) {
    if (await humanIsActive(manifest, port)) return { status: 'human', head };
    await port.setPullRequestLabel(manifest.prNumber!, head, 'review:approved', false);
  }
  return { status: 'requested-changes', head };
}

async function reviewVerdict(
  supplied: AttemptManifest,
  state: ReviewVerdictState,
  body: string,
  port: ReviewSessionPort,
  followUps?: readonly ReviewFollowUpEntry[],
): Promise<ReviewVerdictResult> {
  if (followUps !== undefined && followUps.length > 0 && state !== 'APPROVE') {
    throw new Error('Follow-ups are only valid with APPROVE');
  }

  let manifest = requireReviewManifest(supplied, port);
  let authority = await requireAuthority(manifest, port);
  let pullRequest = await readExactPullRequest(manifest, port);
  const head = manifest.expectedHead as GitOid;
  const authorityProblem = pullRequestAuthorityProblem(manifest, pullRequest);
  if (authorityProblem !== undefined) {
    return authorityProblem.kind === 'mapping'
      ? requestMappingReread(manifest, port)
      : enterHuman(manifest, authorityProblem.detail, port);
  }
  if (await humanIsActive(manifest, port)) return { status: 'human', head };
  if (state === 'APPROVE' && manifest.reviewApprovalPolicy === 'human-codeowner') {
    return enterHuman(manifest, 'Human CODEOWNER approval is required.', port);
  }
  if (state === 'APPROVE') {
    await requireNoNativeChangeRequests(manifest, port, true);
  }

  let followUpNumbers: number[] | undefined;
  if (followUps !== undefined && followUps.length > 0) {
    if (port.fileReviewFollowUps === undefined) {
      throw new Error('Review follow-ups require a follow-up filing port');
    }
    const filed = await port.fileReviewFollowUps({
      parentPr: manifest.prNumber!,
      head,
      entries: followUps,
    });
    followUpNumbers = filed.map((entry) => entry.number);
  }
  const bodyWithFollowUps =
    followUpNumbers === undefined || followUpNumbers.length === 0
      ? body
      : `${body.trim()}\n\nFollow-up issues: ${followUpNumbers.map((n) => `#${n}`).join(', ')}`;

  let intent: Extract<ReviewClaimRecord, { readonly state: 'verdict-intent' }>;
  let digestRefusal: ReviewedDiffDigestRefusal | undefined;
  if (authority.record.state === 'verdict-intent') {
    if (authority.record.verdict.state !== state) {
      throw new Error('Review verdict retry contradicts the current intent');
    }
    intent = authority.record;
  } else if (
    authority.record.state === 'stale'
    && state === 'REQUEST_CHANGES'
  ) {
    return releaseRequestedChangesProjection(manifest, pullRequest, port);
  } else if (
    authority.record.state === 'terminal-approved'
    && state === 'APPROVE'
  ) {
    intent = {
      ...authority.record,
      state: 'verdict-intent',
    };
  } else if (authority.record.state === 'active') {
    // Recorded once, at the head the reviewer read, and never recomputed for a
    // later head: the whole point is that this value describes *what was
    // reviewed*. Retries reuse the durable `verdict-intent` record above rather
    // than re-reading, so the recorded digest cannot drift under a retry.
    const reading = state === 'APPROVE'
      ? await readReviewedDiffDigest(manifest, port)
      : undefined;
    if (reading?.status === 'unavailable') digestRefusal = reading.refusal;
    intent = nextRecord(
      manifest,
      'verdict-intent',
      port.now(),
      { state, marker: port.nextMarker() },
      reading?.status === 'digest' ? reading.digest : undefined,
    ) as Extract<ReviewClaimRecord, { readonly state: 'verdict-intent' }>;
    const published = await publishRecord(manifest, authority, intent, port);
    if (published.status !== 'published') return { status: published.status, head };
    manifest = requireReviewManifest(manifest, port);
    authority = await requireAuthority(manifest, port);
  } else {
    throw new Error(`Review verdict is invalid from ${authority.record.state} authority`);
  }

  let confirmed = await matchingNativeReview(manifest, intent.verdict, port);
  if (confirmed === undefined) {
    const marker = canonicalMarker(manifest, intent.verdict);
    let submissionError: unknown;
    try {
      await port.submitNativeReview({
        manifest,
        prNumber: manifest.prNumber!,
        commitId: head,
        reviewer: manifest.selectedLogin,
        state,
        body: `${bodyWithFollowUps.trim()}\n\n${marker}`,
      });
    } catch (error) {
      submissionError = error;
    }
    confirmed = await matchingNativeReview(manifest, intent.verdict, port);
    if (confirmed === undefined && submissionError !== undefined) {
      throw submissionError;
    }
  }
  if (confirmed === undefined) {
    return { status: 'ambiguous', head };
  }

  if (state === 'REQUEST_CHANGES') {
    // Stage 5: release the claim (stale). No fixing state, no redraft, no branch push.
    if (authority.record.state !== 'stale') {
      const released = nextRecord(manifest, 'stale', port.now());
      const published = await publishRecord(manifest, authority, released, port);
      if (published.status !== 'published') return { status: published.status, head };
      manifest = requireReviewManifest(manifest, port);
      authority = await requireAuthority(manifest, port);
    }
    pullRequest = await requirePullRequest(manifest, port);
    return releaseRequestedChangesProjection(manifest, pullRequest, port);
  }

  await requireNoNativeChangeRequests(manifest, port);
  if (authority.record.state !== 'terminal-approved') {
    await requireNoNativeChangeRequests(manifest, port);
    const terminal = nextRecord(
      manifest,
      'terminal-approved',
      port.now(),
      intent.verdict,
      intent.reviewedDiffDigest,
    );
    const published = await publishRecord(manifest, authority, terminal, port);
    if (published.status !== 'published') return { status: published.status, head };
    manifest = requireReviewManifest(manifest, port);
    authority = await requireAuthority(manifest, port);
  }
  pullRequest = await requirePullRequest(manifest, port);
  if (!pullRequest.labels.includes('review:approved')) {
    await port.setPullRequestLabel(manifest.prNumber!, head, 'review:approved', true);
  }
  if (pullRequest.labels.includes('review:changes-requested')) {
    if (await humanIsActive(manifest, port)) return { status: 'human', head };
    await port.setPullRequestLabel(
      manifest.prNumber!,
      head,
      'review:changes-requested',
      false,
    );
  }
  if (await humanIsActive(manifest, port)) return { status: 'human', head };
  // Stage 3: In Review Status paint is painter-owned (no setProjectStatus).
  await requireNoNativeChangeRequests(manifest, port);
  pullRequest = await requirePullRequest(manifest, port);
  if (await humanIsActive(manifest, port)) return { status: 'human', head };
  if (pullRequest.draft) {
    await port.setPullRequestDraft(manifest.prNumber!, head, false);
  }
  // Reported off the durable record, not off the reading: a retry that reused
  // an existing intent never re-read a digest, and the claim is what the merge
  // gate will actually consult.
  const refusal = intent.reviewedDiffDigest !== undefined
    ? undefined
    : digestRefusal ?? 'recorded-without-digest';
  return {
    status: 'approved',
    head,
    ...(followUpNumbers === undefined || followUpNumbers.length === 0
      ? {}
      : { followUpNumbers }),
    ...(refusal === undefined ? {} : { reviewedDiffDigestRefusal: refusal }),
  };
}

/**
 * Stage 2 children path: native REQUEST_CHANGES + file one finding child +
 * release the review claim. No redraft, no fixing state, no branch push.
 */
async function reviewFindings(
  supplied: AttemptManifest,
  findings: string,
  port: ReviewSessionPort,
): Promise<ReviewFindingsResult> {
  if (port.fileFindingChild === undefined) {
    throw new Error('Review findings require a child-issue port');
  }
  let manifest = requireReviewManifest(supplied, port);
  let authority = await requireAuthority(manifest, port);
  let pullRequest = await readExactPullRequest(manifest, port);
  const head = manifest.expectedHead as GitOid;
  const authorityProblem = pullRequestAuthorityProblem(manifest, pullRequest);
  if (authorityProblem !== undefined) {
    return authorityProblem.kind === 'mapping'
      ? requestMappingReread(manifest, port)
      : enterHuman(manifest, authorityProblem.detail, port);
  }
  if (await humanIsActive(manifest, port)) return { status: 'human', head };
  if (authority.record.state !== 'active' && authority.record.state !== 'verdict-intent') {
    throw new Error(`Review findings are invalid from ${authority.record.state} authority`);
  }

  const child = await port.fileFindingChild({
    parentPr: manifest.prNumber!,
    title: `Address review findings for PR #${manifest.prNumber}`,
    body: findings.trim(),
    effort: 'medium',
    // Read from the exact pull request this attempt holds authority over, so
    // the recorded base is the one the parent carried at this instant.
    parentBase: pullRequest.baseRefName,
  });
  if (child.runawayHold === true) {
    return enterHuman(
      manifest,
      `Runaway child guard: ${child.priorCount} prior review-finding children `
      + `on PR #${manifest.prNumber}; parking for Human.`,
      port,
    );
  }

  let intent: Extract<ReviewClaimRecord, { readonly state: 'verdict-intent' }>;
  if (authority.record.state === 'verdict-intent') {
    if (authority.record.verdict.state !== 'REQUEST_CHANGES') {
      throw new Error('Review findings retry contradicts the current intent');
    }
    intent = authority.record;
  } else {
    intent = nextRecord(
      manifest,
      'verdict-intent',
      port.now(),
      { state: 'REQUEST_CHANGES', marker: port.nextMarker() },
    ) as Extract<ReviewClaimRecord, { readonly state: 'verdict-intent' }>;
    const published = await publishRecord(manifest, authority, intent, port);
    if (published.status !== 'published') return { status: published.status, head };
    manifest = requireReviewManifest(manifest, port);
    authority = await requireAuthority(manifest, port);
  }

  let confirmed = await matchingNativeReview(manifest, intent.verdict, port);
  if (confirmed === undefined) {
    const marker = canonicalMarker(manifest, intent.verdict);
    let submissionError: unknown;
    try {
      await port.submitNativeReview({
        manifest,
        prNumber: manifest.prNumber!,
        commitId: head,
        reviewer: manifest.selectedLogin,
        state: 'REQUEST_CHANGES',
        body: `${findings.trim()}\n\nChild issue: #${child.number}\n\n${marker}`,
      });
    } catch (error) {
      submissionError = error;
    }
    confirmed = await matchingNativeReview(manifest, intent.verdict, port);
    if (confirmed === undefined && submissionError !== undefined) {
      throw submissionError;
    }
  }
  if (confirmed === undefined) return { status: 'ambiguous', head };

  // Release claim (stale) — children path does not enter fixing / redraft.
  if (authority.record.state !== 'stale') {
    const released = nextRecord(manifest, 'stale', port.now());
    const published = await publishRecord(manifest, authority, released, port);
    if (published.status !== 'published') return { status: published.status, head };
  }
  pullRequest = await requirePullRequest(manifest, port);
  if (!pullRequest.labels.includes('review:changes-requested')) {
    await port.setPullRequestLabel(
      manifest.prNumber!,
      head,
      'review:changes-requested',
      true,
    );
  }
  if (pullRequest.labels.includes('review:approved')) {
    await port.setPullRequestLabel(manifest.prNumber!, head, 'review:approved', false);
  }
  return {
    status: 'filed',
    head,
    childNumber: child.number,
    created: child.created,
  };
}

export function makeReviewSessionProtocol(
  port: ReviewSessionPort,
): ReviewSessionProtocol {
  return {
    reviewVerdict: (manifest, state, body, followUps) =>
      reviewVerdict(manifest, state, body, port, followUps),
    reviewFindings: (manifest, findings) => reviewFindings(manifest, findings, port),
    human: (manifest, reason) => enterHuman(manifest, reason, port),
  };
}
