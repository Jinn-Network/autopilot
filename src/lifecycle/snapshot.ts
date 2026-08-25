import type { PolledIssue } from '../dispatcher/types.js';
import type { ProjectSnapshot } from '../dispatcher/project-snapshot.js';
import { toIssueBoardState } from '../dispatcher/project-snapshot.js';
import { DEFAULT_FLOOR } from '../dispatcher/rate-limit-guard.js';
import type { PrLink } from '../dispatcher/pr-links.js';
import { resolveStackReady } from '../dispatcher/stack-readiness.js';
import { selectReady } from '../dispatcher/ready-filter.js';
import {
  decodeBranchClaimTrailers,
  decodeReviewClaimPayload,
  formatAutomatedReviewMarker,
  mappingDiagnosticSignature,
} from './codecs.js';
import { parseChildMarker, isMachineChildIssue, type ChildKind } from './child-issues.js';
import { isReviewedDiffDigest } from './reviewed-diff-digest.js';
import {
  hasReviewFollowUpMarkerTag,
  parseReviewFollowUpMarker,
} from './review-follow-ups.js';
import {
  gitOid,
  isoTimestamp,
  type BranchClaim,
  type CompareStatus,
  type GitOid,
  type HumanReason,
  type IssueEligibilityReason,
  type LifecycleItem,
  type LifecycleMappingDiagnostic,
  type LifecycleSnapshot,
  type ReviewClaimRecord,
  type ReviewVerdictState,
} from './types.js';
import {
  FULL_SCAN_RESERVE,
  GitHubRateLimitReserveError,
  assertRateLimitReserve,
  type GitHubUsage,
} from './github-usage.js';
import {
  resolveStructuredPullRequestMappings,
  type StructuredPullRequestMapping,
} from './pr-mapping.js';
import {
  hasExternalHumanAuthority,
  hasExternalHumanLabel,
} from './human-authority.js';

export type SnapshotReadMode = 'incremental' | 'full';

export interface LifecycleSnapshotSource {
  read(options: {
    readonly mode: SnapshotReadMode;
    readonly rateLimitFloor: number;
    /** Internal coordinator retry: preserve already-metered work in this cycle. */
    readonly resetUsage?: boolean;
  }): Promise<GitHubLifecycleSnapshot>;
}

export type NativeReviewState =
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'COMMENTED'
  | 'DISMISSED'
  | 'PENDING';

export interface NativeReviewSnapshot {
  readonly reviewer: string;
  readonly state: NativeReviewState;
  readonly commitId: GitOid;
  readonly body: string;
  readonly submittedAt: string;
}

export type { CheckSummary } from './types.js';
import type { CheckSummary } from './types.js';

export interface ReviewClaimSnapshot {
  readonly oid: GitOid;
  readonly record: ReviewClaimRecord;
}

export interface BranchClaimSnapshot {
  readonly issueNumber: number;
  readonly headRefName: string;
  readonly headOid: GitOid;
  readonly headCommittedAt: string;
  readonly claim: BranchClaim;
  readonly implementationCompletionSummary?: string;
}

export interface TerminalClaimEvidence {
  readonly issueNumber: number;
  readonly prNumber: number;
  readonly headRefName: string;
  readonly headOid: GitOid;
  readonly claimAttempt: string;
  readonly targetBase: string;
  readonly claimFingerprint: string;
  readonly mergedAt: string;
  readonly mergeCommitOid: GitOid;
}

export interface RawBranchClaim {
  readonly issueNumber: number;
  readonly headRefName: string;
  readonly headOid: string;
  readonly headCommittedAt: string;
  readonly claimTrailers: string;
  readonly implementationCompletionSummary?: string | null;
}

/**
 * Merge-queue membership for a PR head, read from GitHub's `isInMergeQueue` and
 * `mergeQueueEntry`. Absent means *unknown*, never "not queued": a read that
 * could not prove membership must not license a second enqueue.
 */
export interface MergeQueueSnapshot {
  readonly enqueued: boolean;
  readonly position?: number;
  readonly state?: string;
}

export interface PullRequestSnapshot {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headOid: GitOid;
  readonly headCommittedAt: string;
  readonly updatedAt?: string;
  /**
   * The PR's GraphQL node id, the `pullRequestId` argument of
   * `enqueuePullRequest`. Absent whenever the read could not prove it.
   */
  readonly graphqlId?: string;
  readonly mergeQueue?: MergeQueueSnapshot;
  readonly isDraft: boolean;
  readonly state: 'OPEN' | 'MERGED';
  readonly labels: readonly string[];
  readonly closingIssueNumbers: readonly number[];
  /**
   * The closing-issue connection was truncated. No partial issue list may
   * participate in mapping or global action authority.
   */
  readonly closingIssueNumbersIncomplete?: true;
  readonly mergeability: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  readonly mergeStateStatus: string;
  readonly compareStatus?: CompareStatus;
  /**
   * Base branch tip OID that `compareStatus` was computed against. Absent when
   * compare evidence could not be proven cacheable — never read absence as
   * "the base has not moved".
   */
  readonly compareBaseTipOid?: GitOid;
  /**
   * Identity of the diff this head presents against its base branch tip, read
   * from the same compare response as `compareStatus`. Absent whenever it could
   * not be proven — see `reviewed-diff-digest.ts`. Absence must never be read
   * as "the diff is unchanged".
   */
  readonly reviewedDiffDigest?: string;
  readonly checks: readonly CheckSummary[];
  readonly ciRerunRecorded?: boolean;
  /** True when a CAS-fenced enqueue-attempt record exists for this PR head. */
  readonly enqueueRecorded?: boolean;
  readonly reviews: readonly NativeReviewSnapshot[];
  /**
   * Non-comment PR evidence could not be read completely. This is a machine
   * availability fence, never Human authority, and must make the PR
   * non-actionable until a later exact refresh succeeds.
   */
  readonly evidenceIncompleteReason?: string;
  readonly branchClaim?: BranchClaim;
  readonly implementationCompletionSummary?: string;
  readonly reviewClaim?: ReviewClaimSnapshot;
  readonly humanIssueNumber?: number;
  readonly humanAuthor?: string;
  readonly humanHead?: GitOid;
  readonly humanGeneration?: string;
  readonly humanDiagnosticIssueNumbers?: readonly number[];
  readonly humanDiagnosticSignature?: string;
  /** Actor on the latest timeline event for the current Human label. */
  readonly humanLabelActor?: string;
  /** Actor on the latest timeline event for the current draft state. */
  readonly draftActor?: string;
  readonly humanReason?: HumanReason;
  readonly mergedAt?: string;
  readonly mergeCommitOid?: GitOid;
}

export interface RawNativeReview {
  readonly reviewer: string;
  readonly state: NativeReviewState;
  readonly commitId: string;
  readonly body: string;
  readonly submittedAt: string;
}

export interface RawPullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly headOid: string;
  readonly headCommittedAt: string;
  readonly updatedAt?: string;
  readonly graphqlId?: string;
  readonly mergeQueue?: MergeQueueSnapshot;
  readonly isDraft: boolean;
  readonly state: 'OPEN' | 'MERGED';
  readonly labels: readonly string[];
  readonly closingIssueNumbers: readonly number[];
  readonly closingIssueNumbersIncomplete?: true;
  readonly mergeability: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  readonly mergeStateStatus: string;
  readonly compareStatus?: CompareStatus;
  readonly compareBaseTipOid?: string;
  readonly reviewedDiffDigest?: string;
  readonly checks: readonly CheckSummary[];
  readonly ciRerunRecorded?: boolean;
  readonly enqueueRecorded?: boolean;
  readonly reviews: readonly RawNativeReview[];
  readonly evidenceIncompleteReason?: string;
  readonly branchClaimTrailers: string | null;
  readonly implementationCompletionSummary?: string | null;
  readonly reviewClaim: { readonly oid: string; readonly payload: string } | null;
  readonly humanIssueNumber?: number | null;
  readonly humanAuthor?: string | null;
  readonly humanHead?: string | null;
  readonly humanGeneration?: string | null;
  readonly humanDiagnosticIssueNumbers?: readonly number[] | null;
  readonly humanDiagnosticSignature?: string | null;
  readonly humanLabelActor?: string | null;
  readonly draftActor?: string | null;
  readonly humanReason: HumanReason | null;
  readonly mergedAt: string | null;
  readonly mergeCommitOid: string | null;
}

export interface PullRequestPage {
  readonly nodes: readonly RawPullRequest[];
  /**
   * A page-bound merged-outcome or issue closed-by connection was incomplete,
   * so no global lifecycle action may rely on the resulting issue closure.
   */
  readonly closingIssueEvidenceIncomplete?: true;
  readonly pageInfo: {
    readonly hasNextPage: boolean;
    readonly endCursor: string | null;
  };
}

export interface GitHubLifecycleReader {
  readProjectSnapshot(): Promise<ProjectSnapshot>;
  readIssues(board: ReturnType<typeof toIssueBoardState>): Promise<readonly PolledIssue[]>;
  readPullRequests(
    cursor: string | null,
    nonDoneIssueNumbers?: readonly number[],
  ): Promise<PullRequestPage>;
  readBranchClaims?(): Promise<readonly RawBranchClaim[]>;
  /** Incremental stable-branch ref listing over the existing git transport. */
  readIncrementalBranchClaims?(): Promise<readonly RawBranchClaim[]>;
  /** Exact single-PR GraphQL hydration used by incremental discovery. */
  readPullRequestForReconciliation?(prNumber: number): Promise<RawPullRequest | null>;
  /** Git-transport review-claim ref listing, keyed by PR number. */
  readReviewClaimRefs?(): Promise<ReadonlyMap<number, GitOid>>;
  /** Cheap live GraphQL quota evidence read before a targeted hydration. */
  readGraphQlRemaining?(): Promise<number>;
  /** Lightweight targeted discovery for newly-active Project issues. */
  readPullRequestNumbersClosingIssues?(
    issueNumbers: readonly number[],
  ): Promise<ReadonlySet<number>>;
  /** Targeted recovery discovery including exact merged blocker outcomes. */
  readPullRequestOutcomeNumbersClosingIssues?(
    issueNumbers: readonly number[],
  ): Promise<ReadonlySet<number>>;
  resetGitHubUsage?(): void;
  githubUsage(): GitHubUsage;
}

export interface LifecycleParityDifference {
  readonly subject: string;
  readonly incremental: string | null;
  readonly full: string | null;
}

export interface GitHubLifecycleSnapshot {
  readonly project: ProjectSnapshot;
  readonly issues: readonly PolledIssue[];
  readonly pullRequests: readonly PullRequestSnapshot[];
  readonly branches: readonly BranchClaimSnapshot[];
  /** Narrow terminal proof for suppressing orphan recovery on retained implementation refs. */
  readonly terminalClaims?: readonly TerminalClaimEvidence[];
  readonly diagnostics: readonly LifecycleMappingDiagnostic[];
  readonly pullRequestMappings?: readonly StructuredPullRequestMapping[];
  readonly lifecycle: LifecycleSnapshot;
  readonly capturedAt: string;
  /** Additive metadata; legacy/custom readers that omit it are treated as partial. */
  readonly snapshotMode?: SnapshotReadMode;
  readonly snapshotComplete?: boolean;
  readonly lastFullReconciliationAt?: string | null;
  readonly githubUsage?: GitHubUsage;
  readonly parityDifferences?: readonly LifecycleParityDifference[];
  /** Why a full oracle could not be compared to a same-boundary incremental candidate. */
  readonly parityUnavailableReason?: string;
  /** Present only for a deliberately non-authoritative routine status view. */
  readonly partialReason?: string;
  /** A complete cached/incremental view returned after a due full read failed. */
  readonly snapshotWarning?: string;
  /**
   * Present only on a deliberately non-global pre-dispatch view. Scoped
   * evidence may drive reconciliation and exact action checks, but must never
   * replace the durable global discovery cache.
   */
  readonly snapshotAuthority?: 'scoped';
  /** Original operator-selected issue numbers for a scoped authority view. */
  readonly scopedIssueNumbers?: readonly number[];
  /** Validated global count used to preserve fresh-work backpressure in a scoped view. */
  readonly globalOpenPipelineBacklog?: number;
}

export function decodeBranchClaimSnapshot(raw: RawBranchClaim): BranchClaimSnapshot {
  try {
    assertPositiveInteger(raw.issueNumber, 'issue number');
    isoTimestamp(raw.headCommittedAt);
    const claim = decodeBranchClaimTrailers(raw.claimTrailers);
    if (claim.issueNumber !== raw.issueNumber) {
      throw new Error('Branch claim issue does not match ref issue');
    }
    return {
      issueNumber: raw.issueNumber,
      headRefName: raw.headRefName,
      headOid: gitOid(raw.headOid),
      headCommittedAt: raw.headCommittedAt,
      claim,
      ...(raw.implementationCompletionSummary === undefined
        || raw.implementationCompletionSummary === null
        ? {}
        : { implementationCompletionSummary: raw.implementationCompletionSummary }),
    };
  } catch (cause) {
    throw new SnapshotDecodeError(`branch ${raw.headRefName}`, cause);
  }
}

export class SnapshotDecodeError extends Error {
  constructor(subject: string, cause: unknown) {
    super(`SnapshotDecodeError: could not decode ${subject}: ${errorMessage(cause)}`);
    this.name = 'SnapshotDecodeError';
  }
}

export class LifecycleRateLimitError extends Error {
  constructor(
    readonly remaining: number,
    readonly required = DEFAULT_FLOOR,
    readonly reserve = 0,
  ) {
    super(
      reserve === 0
        ? `GitHub rate-limit budget low: ${remaining} remaining`
        : `GitHub rate-limit budget low: ${remaining} remaining; ${required} required `
          + `(${required - reserve} floor + ${reserve} reserve)`,
    );
    this.name = 'LifecycleRateLimitError';
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${label}`);
  }
}

export function decodePullRequestSnapshot(raw: RawPullRequest): PullRequestSnapshot {
  try {
    assertPositiveInteger(raw.number, 'PR number');
    const headOid = gitOid(raw.headOid);
    isoTimestamp(raw.headCommittedAt);
    if (raw.updatedAt !== undefined) isoTimestamp(raw.updatedAt);
    const reviews = raw.reviews.map((review): NativeReviewSnapshot => {
      isoTimestamp(review.submittedAt);
      return {
        ...review,
        commitId: gitOid(review.commitId),
      };
    });
    if (
      raw.evidenceIncompleteReason !== undefined
      && raw.evidenceIncompleteReason.trim().length === 0
    ) {
      throw new Error('PR evidence-incomplete reason must be non-empty');
    }
    if (
      raw.closingIssueNumbersIncomplete === true
      && raw.evidenceIncompleteReason === undefined
    ) {
      throw new Error('Incomplete PR closing-issue evidence requires a reason');
    }
    const branchClaim = (() => {
      if (raw.branchClaimTrailers === null) return undefined;
      try {
        return decodeBranchClaimTrailers(raw.branchClaimTrailers);
      } catch (cause) {
        console.warn(
          `[snapshot] skipping undecodable PR branch claim on #${raw.number}: ${
            errorMessage(cause)
          }`,
        );
        return undefined;
      }
    })();
    const reviewClaim = raw.reviewClaim === null
      ? undefined
      : {
          oid: gitOid(raw.reviewClaim.oid),
          record: decodeReviewClaimPayload(raw.reviewClaim.payload),
        };
    if (raw.mergedAt !== null) isoTimestamp(raw.mergedAt);
    if (raw.humanIssueNumber !== undefined && raw.humanIssueNumber !== null) {
      assertPositiveInteger(raw.humanIssueNumber, 'Human marker issue number');
    }
    const humanHead = raw.humanHead === undefined || raw.humanHead === null
      ? undefined
      : gitOid(raw.humanHead);
    const hasHumanDiagnosticIssues = raw.humanDiagnosticIssueNumbers !== undefined
      && raw.humanDiagnosticIssueNumbers !== null;
    const hasHumanDiagnosticSignature = raw.humanDiagnosticSignature !== undefined
      && raw.humanDiagnosticSignature !== null;
    if (hasHumanDiagnosticIssues !== hasHumanDiagnosticSignature) {
      throw new Error('Human mapping diagnostic provenance is incomplete');
    }
    const humanDiagnosticIssueNumbers = hasHumanDiagnosticIssues
      ? [...raw.humanDiagnosticIssueNumbers!]
      : undefined;
    if (humanDiagnosticIssueNumbers !== undefined) {
      for (const issueNumber of humanDiagnosticIssueNumbers) {
        assertPositiveInteger(issueNumber, 'Human mapping diagnostic issue number');
      }
      if (
        raw.humanReason?.code !== 'branch-mapping-ambiguous'
        || raw.humanDiagnosticSignature !== mappingDiagnosticSignature({
          issueNumbers: humanDiagnosticIssueNumbers,
          detail: raw.humanReason.detail,
        })
      ) {
        throw new Error('Human mapping diagnostic signature is invalid');
      }
    }
    return {
      number: raw.number,
      title: raw.title,
      body: raw.body,
      author: raw.author,
      baseRefName: raw.baseRefName,
      headRefName: raw.headRefName,
      headOid,
      headCommittedAt: raw.headCommittedAt,
      ...(raw.updatedAt === undefined ? {} : { updatedAt: raw.updatedAt }),
      ...(raw.graphqlId === undefined ? {} : { graphqlId: raw.graphqlId }),
      ...(raw.mergeQueue === undefined ? {} : { mergeQueue: { ...raw.mergeQueue } }),
      isDraft: raw.isDraft,
      state: raw.state,
      labels: [...raw.labels],
      closingIssueNumbers: raw.closingIssueNumbersIncomplete === true
        ? []
        : [...raw.closingIssueNumbers],
      ...(raw.closingIssueNumbersIncomplete === true
        ? { closingIssueNumbersIncomplete: true as const }
        : {}),
      mergeability: raw.mergeability,
      mergeStateStatus: raw.mergeStateStatus,
      ...(raw.compareStatus === undefined ? {} : { compareStatus: raw.compareStatus }),
      ...(raw.compareBaseTipOid === undefined
        ? {}
        : { compareBaseTipOid: gitOid(raw.compareBaseTipOid) }),
      ...(isReviewedDiffDigest(raw.reviewedDiffDigest)
        ? { reviewedDiffDigest: raw.reviewedDiffDigest }
        : {}),
      checks: raw.checks.map((check) => ({ ...check })),
      ...(raw.ciRerunRecorded === true ? { ciRerunRecorded: true } : {}),
      ...(raw.enqueueRecorded === true ? { enqueueRecorded: true } : {}),
      reviews,
      ...(raw.evidenceIncompleteReason === undefined
        ? {}
        : { evidenceIncompleteReason: raw.evidenceIncompleteReason }),
      ...(branchClaim === undefined ? {} : { branchClaim }),
      ...(raw.implementationCompletionSummary === undefined
        || raw.implementationCompletionSummary === null
        ? {}
        : { implementationCompletionSummary: raw.implementationCompletionSummary }),
      ...(reviewClaim === undefined ? {} : { reviewClaim }),
      ...(raw.humanIssueNumber === undefined || raw.humanIssueNumber === null
        ? {}
        : { humanIssueNumber: raw.humanIssueNumber }),
      ...(raw.humanAuthor === undefined || raw.humanAuthor === null
        ? {}
        : { humanAuthor: raw.humanAuthor }),
      ...(humanHead === undefined ? {} : { humanHead }),
      ...(raw.humanGeneration === undefined || raw.humanGeneration === null
        ? {}
        : { humanGeneration: raw.humanGeneration }),
      ...(humanDiagnosticIssueNumbers === undefined
        ? {}
        : {
            humanDiagnosticIssueNumbers,
            humanDiagnosticSignature: raw.humanDiagnosticSignature!,
          }),
      ...(raw.humanLabelActor === undefined || raw.humanLabelActor === null
        ? {}
        : { humanLabelActor: raw.humanLabelActor }),
      ...(raw.draftActor === undefined || raw.draftActor === null
        ? {}
        : { draftActor: raw.draftActor }),
      ...(raw.humanReason === null ? {} : { humanReason: raw.humanReason }),
      ...(raw.mergedAt === null ? {} : { mergedAt: raw.mergedAt }),
      ...(raw.mergeCommitOid === null ? {} : { mergeCommitOid: gitOid(raw.mergeCommitOid) }),
    };
  } catch (cause) {
    throw new SnapshotDecodeError(`PR #${raw.number}`, cause);
  }
}

function prLinksByIssue(
  prs: readonly PullRequestSnapshot[],
  issueByPr: ReadonlyMap<number, number>,
): Map<number, PrLink[]> {
  const out = new Map<number, PrLink[]>();
  for (const pr of prs) {
    const link: PrLink = {
      prNumber: pr.number,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      state: pr.state,
      isDraft: pr.isDraft,
      author: pr.author,
      labels: [...pr.labels],
    };
    const issueNumber = issueByPr.get(pr.number);
    if (issueNumber === undefined) continue;
    const links = out.get(issueNumber) ?? [];
    links.push(link);
    out.set(issueNumber, links);
  }
  return out;
}

function latestDecisiveReview(
  pr: PullRequestSnapshot,
): NativeReviewSnapshot | undefined {
  return pr.reviews
    .filter((review) => (
      review.commitId === pr.headOid
      && (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED')
    ))
    .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt))[0];
}

/**
 * The merge gate's `terminalReview` conjunct, projected onto the lifecycle item.
 *
 * The gate requires the *claim reviewer's* effective (latest) native review at
 * the **current** head to be `APPROVED` and to carry the signed marker naming
 * the reviewed head (`enqueue-executor-production.ts`). Nothing else in the
 * lifecycle item expresses that: `approved` is any reviewer's latest decisive
 * review at head, and `terminalVerdict` is selected by marker across every
 * commit. Without this projection the view can carry an approval the gate then
 * refuses, and because `reviewEnrollmentEligible` only dispatches a review when
 * `engineApprovalLapsed` is true, the PR strands in merge-ready with no
 * recovery. Two shapes reach that state: a human approving at the new head while
 * the engine's marker-bearing review is still pinned to the old one, and the
 * claim reviewer's latest review at head being `COMMENTED`.
 *
 * Deliberately duplicated rather than shared: the gate reads live REST, this
 * reads the cycle snapshot, and the point is that both answer the same question
 * about the same evidence. Any drift between them is a strand, so the two
 * implementations are pinned against each other by test.
 */
function reviewerApprovedAtHead(pr: PullRequestSnapshot): boolean {
  const claim = pr.reviewClaim?.record;
  if (claim?.state !== 'terminal-approved') return false;
  const expectedMarker = formatAutomatedReviewMarker({
    generation: claim.generation,
    attempt: claim.attempt,
    intent: claim.verdict.marker,
    reviewer: claim.reviewer,
    head: claim.head,
    verdict: claim.verdict.state,
  });
  const latest = new Map<string, NativeReviewSnapshot>();
  for (const review of pr.reviews
    .filter((candidate) => candidate.commitId === pr.headOid)
    .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt))) {
    latest.set(review.reviewer.toLowerCase(), review);
  }
  const effective = latest.get(claim.reviewer.toLowerCase());
  return effective?.state === 'APPROVED'
    && effective.body.includes(expectedMarker);
}

function terminalVerdict(pr: PullRequestSnapshot) {
  const claim = pr.reviewClaim?.record;
  if (claim?.verdict === undefined) return undefined;
  const expectedMarker = formatAutomatedReviewMarker({
    generation: claim.generation,
    attempt: claim.attempt,
    intent: claim.verdict.marker,
    reviewer: claim.reviewer,
    head: claim.head,
    verdict: claim.verdict.state,
  });
  const nativeState = claim.verdict.state === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED';
  // Selected by the signed marker, not by `commit_id`.
  //
  // `commit_id` is not a stable head binding. Measured on Jinn-Network/mono:
  // when `update-branch` merges the base into the PR branch, GitHub re-points
  // every existing review's `commit_id` onto the new merge commit — PR #2130
  // ended with three reviews whose markers name three different heads
  // (2aa7c2d…, 01aa754…, 09f2da4…) and whose `commit_id` all read as the final
  // head, with 01aa754… being literally the first parent of that head. An
  // ordinary worker push leaves `commit_id` alone (PR #2232: head 75b6e35e,
  // review `commit_id` 080cdc6d).
  //
  // The marker is engine-signed and encodes `head=<claim.head>`, so it survives
  // that rewrite and is the stronger of the two bindings. Filtering on it and
  // reporting `head: claim.head` therefore *tightens* the identity rather than
  // relaxing it, and is unchanged in the common case where the head has not
  // moved and `commit_id === claim.head` anyway.
  //
  // Note what this makes `head` mean, because a caller could get it wrong:
  // it is now `claim.head` by definition, not an independently observed value.
  // Comparing `terminalVerdict.head` to `reviewClaim.head` is therefore a
  // tautology for any snapshot-derived item and proves nothing; the head
  // bindings that do prove something are `terminalVerdict.head === item.head`
  // (used by every exact-head consumer) and the signed marker inside the review
  // body (used by the merge gate).
  const review = pr.reviews
    .filter((candidate) => (
      candidate.reviewer.toLowerCase() === claim.reviewer.toLowerCase()
      && candidate.state === nativeState
      && candidate.body.includes(expectedMarker)
    ))
    .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt))[0];
  if (review === undefined) return undefined;
  return {
    head: claim.head,
    state: claim.verdict.state,
    recordedAt: review.submittedAt,
    marker: claim.verdict.marker,
  } as const;
}

function mergeState(pr: PullRequestSnapshot): Extract<
LifecycleItem,
{ kind: 'pull-request' }
>['mergeState'] {
  if (pr.mergeability === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return 'conflict';
  if (pr.mergeStateStatus === 'BEHIND') return 'behind';
  if (pr.compareStatus === 'behind' || pr.compareStatus === 'diverged') return 'behind';
  if (pr.compareStatus === 'unknown') return 'blocked';
  if (pr.mergeability === 'MERGEABLE' && ['CLEAN', 'UNSTABLE', 'HAS_HOOKS'].includes(
    pr.mergeStateStatus,
  )) {
    return 'clean';
  }
  return 'blocked';
}

function lifecyclePr(
  pr: PullRequestSnapshot,
  issue: PolledIssue,
  expectedBaseRefName: string,
  machineAuthorLogins: ReadonlySet<string>,
  openChildKinds: readonly ChildKind[] = [],
): Extract<LifecycleItem, { kind: 'pull-request' }> {
  const decisive = latestDecisiveReview(pr);
  const reviewClaim = pr.reviewClaim?.record;
  const issueLabels = [...(issue.labels ?? [])];
  const humanHold = hasExternalHumanAuthority({
    pullRequestLabels: pr.labels,
    nativeIssueLabels: issueLabels,
    projectBlockedOn: issue.blockedOn,
  });
  const humanSource = issue.blockedOn === 'Human'
    ? 'Project Blocked on: Human'
    : pr.labels.includes('review:needs-human')
      ? 'PR label: review:needs-human'
      : pr.labels.includes('autopilot:human')
        ? 'PR label: autopilot:human'
        : issueLabels.includes('review:needs-human')
          ? 'Issue label: review:needs-human'
          : issueLabels.includes('autopilot:human')
            ? 'Issue label: autopilot:human'
            : undefined;
  const implementationActive = pr.branchClaim?.phase === 'implement'
    && pr.branchClaim.phaseComplete !== true;
  const reviewPhase = reviewClaim !== undefined && reviewClaim.head === pr.headOid
    ? 'reviewing' as const
    : 'awaiting-review' as const;
  const synthesizedHumanReason: HumanReason | undefined = humanSource === undefined
    ? undefined
    : implementationActive
      ? {
          phase: 'implementing',
          code: 'implementation-escalation',
          detail: humanSource,
        }
      : {
          phase: reviewPhase,
          code: 'review-escalation',
          detail: humanSource,
        };
  const exactMachineMappingComment = pr.humanReason?.code === 'branch-mapping-ambiguous'
    && pr.humanIssueNumber === issue.number
    && pr.humanAuthor !== undefined
    && machineAuthorLogins.has(pr.humanAuthor.toLowerCase())
    && pr.humanHead === pr.headOid
    && pr.humanGeneration !== undefined;
  const reviewMappingDiagnostic = reviewClaim !== undefined
    && 'mappingDiagnostic' in reviewClaim
    ? reviewClaim.mappingDiagnostic
    : undefined;
  const signedMachineMappingComment = exactMachineMappingComment
    && reviewMappingDiagnostic !== undefined
    && reviewMappingDiagnostic.selectedIssueNumber === issue.number
    && pr.humanDiagnosticSignature === reviewMappingDiagnostic.signature
    && pr.humanReason?.detail === reviewMappingDiagnostic.detail
    && pr.humanDiagnosticIssueNumbers !== undefined
    && pr.humanDiagnosticIssueNumbers.length
      === reviewMappingDiagnostic.issueNumbers.length
    && pr.humanDiagnosticIssueNumbers.every((issueNumber, index) => (
      issueNumber === reviewMappingDiagnostic.issueNumbers[index]
    ));
  // Comments and legacy machine Human records are audit/migration evidence,
  // never lifecycle Human authority. Only maintainer-visible GitHub surfaces
  // above may synthesize a Human hold.
  const humanReason = synthesizedHumanReason;
  const obsoleteMachineMappingHuman = (
    signedMachineMappingComment
    && pr.humanGeneration === reviewClaim?.generation
    && !hasExternalHumanLabel(pr.labels)
    && !pr.isDraft
    && reviewClaim !== undefined
    && reviewClaim.head === pr.headOid
    && reviewClaim.state === 'human'
    && issue.blockedOn !== 'Human'
    && !hasExternalHumanLabel(issueLabels)
  )
    ? {
        generation: reviewClaim.generation,
        author: pr.humanAuthor,
        mappingDiagnostic: reviewMappingDiagnostic!,
        reason: {
          phase: pr.humanReason!.phase,
          code: 'branch-mapping-ambiguous' as const,
          detail: pr.humanReason!.detail,
        },
      }
    : undefined;
  return {
    kind: 'pull-request',
    issueNumber: issue.number,
    prNumber: pr.number,
    v2Marked: pr.branchClaim !== undefined
      || reviewClaim !== undefined
      || (pr.state === 'MERGED' && (
        pr.labels.includes('engine:review')
        || stableBranchIssue(pr.headRefName) === issue.number
        || /<!-- jinn-autopilot-[a-z-]+:v2\b/.test(pr.body)
      )),
    projectStatus: issue.status,
    labels: [...pr.labels],
    ...(humanHold ? { humanHold: true } : {}),
    ...(humanReason === undefined ? {} : { humanReason }),
    head: pr.headOid,
    expectedBaseRefName,
    ...(obsoleteMachineMappingHuman === undefined
      ? {}
      : { obsoleteMachineMappingHuman }),
    headChangedAt: pr.headCommittedAt,
    isDraft: pr.isDraft,
    merged: pr.state === 'MERGED',
    needsReview: decisive?.state !== 'APPROVED',
    approved: decisive?.state === 'APPROVED',
    mergeState: mergeState(pr),
    checks: [...pr.checks],
    ...(pr.ciRerunRecorded === true ? { ciRerunRecorded: true } : {}),
    ...(pr.enqueueRecorded === true ? { enqueueRecorded: true } : {}),
    ...(pr.mergeQueue?.enqueued === true ? { inMergeQueue: true } : {}),
    ...(openChildKinds.length === 0 ? {} : { openChildKinds: [...openChildKinds] }),
    ...(pr.branchClaim === undefined ? {} : { branchClaim: pr.branchClaim }),
    ...(pr.implementationCompletionSummary === undefined
      ? {}
      : { implementationSummary: pr.implementationCompletionSummary }),
    ...(reviewClaim === undefined ? {} : { reviewClaim }),
    ...(terminalVerdict(pr) === undefined ? {} : { terminalVerdict: terminalVerdict(pr) }),
    ...(reviewerApprovedAtHead(pr) ? { reviewerApprovedAtHead: true } : {}),
    ...(pr.reviewedDiffDigest === undefined
      ? {}
      : { reviewedDiffDigest: pr.reviewedDiffDigest }),
  };
}

function stableBranchIssue(headRefName: string): number | undefined {
  const match = /^autopilot\/([1-9][0-9]*)$/.exec(headRefName);
  if (match === null) return undefined;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : undefined;
}

function resolveMappings(
  prs: readonly PullRequestSnapshot[],
  branches: readonly BranchClaimSnapshot[],
  byIssue: ReadonlyMap<number, PolledIssue>,
  defaultBranch: string,
): {
  readonly issueByPr: ReadonlyMap<number, number>;
  readonly expectedBaseByPr: ReadonlyMap<number, string>;
  readonly resolutions: readonly StructuredPullRequestMapping[];
  readonly diagnostics: readonly LifecycleMappingDiagnostic[];
  readonly affectedIssues: ReadonlySet<number>;
} {
  const resolutions = resolveStructuredPullRequestMappings({
    defaultBranch,
    issues: [...byIssue.values()].map((issue) => ({
      number: issue.number,
      blockedOn: issue.blockedOn,
      blockedByIssues: [...issue.blockedByIssues],
    })),
    pullRequests: prs
      .filter((pr) => pr.closingIssueNumbersIncomplete !== true)
      .map((pr) => ({
        number: pr.number,
        state: pr.state,
        head: pr.headOid,
        headRefName: pr.headRefName,
        baseRefName: pr.baseRefName,
        closingIssueNumbers: [...pr.closingIssueNumbers],
        body: pr.body,
      })),
    stableBranches: branches.map((branch) => ({
      issueNumber: branch.issueNumber,
      phase: branch.claim.phase,
      head: branch.headOid,
      headRefName: branch.headRefName,
      targetBase: branch.claim.targetBase,
    })),
  });
  const candidatesByPr = new Map(resolutions.map((resolution) => [
    resolution.prNumber,
    new Set(
      resolution.status === 'resolved'
        ? [resolution.issueNumber]
        : resolution.issueNumbers,
    ),
  ]));
  const prsByIssue = new Map<number, Set<number>>();
  const intrinsicallyAmbiguous = new Set(
    resolutions
      .filter((resolution) => resolution.status === 'ambiguous')
      .map((resolution) => resolution.prNumber),
  );
  const intrinsicDetails = new Map<number, string[]>();
  for (const resolution of resolutions) {
    const candidates = candidatesByPr.get(resolution.prNumber) ?? new Set<number>();
    for (const issueNumber of candidates) {
      const issuePrs = prsByIssue.get(issueNumber) ?? new Set<number>();
      issuePrs.add(resolution.prNumber);
      prsByIssue.set(issueNumber, issuePrs);
    }
    if (resolution.status === 'ambiguous') {
      intrinsicDetails.set(resolution.prNumber, [...resolution.details]);
    }
  }

  const ambiguousPrs = new Set(intrinsicallyAmbiguous);
  for (const issuePrs of prsByIssue.values()) {
    if (issuePrs.size > 1) {
      for (const prNumber of issuePrs) ambiguousPrs.add(prNumber);
    }
  }

  const prByNumber = new Map(prs.map((pr) => [pr.number, pr]));
  const seenPrs = new Set<number>();
  const diagnostics: LifecycleMappingDiagnostic[] = [];
  const affectedIssues = new Set<number>();
  for (const seed of [...ambiguousPrs].sort((left, right) => left - right)) {
    if (seenPrs.has(seed)) continue;
    const componentPrs = new Set<number>();
    const componentIssues = new Set<number>();
    const pendingPrs = [seed];
    while (pendingPrs.length > 0) {
      const prNumber = pendingPrs.pop()!;
      if (componentPrs.has(prNumber)) continue;
      componentPrs.add(prNumber);
      ambiguousPrs.add(prNumber);
      seenPrs.add(prNumber);
      const connectedIssues = candidatesByPr.get(prNumber) ?? new Set<number>();
      for (const issueNumber of connectedIssues) {
        if (componentIssues.has(issueNumber)) continue;
        componentIssues.add(issueNumber);
        for (const linkedPr of prsByIssue.get(issueNumber) ?? []) {
          if (!componentPrs.has(linkedPr)) pendingPrs.push(linkedPr);
        }
      }
    }
    for (const issueNumber of componentIssues) affectedIssues.add(issueNumber);
    const diagnosticPrs = [...componentPrs]
      .map((number) => prByNumber.get(number)!)
      .sort((left, right) => left.number - right.number);
    const issueNumbers = [...componentIssues].sort((left, right) => left - right);
    const prNumbers = diagnosticPrs.map((pr) => pr.number);
    const details = [...new Set(diagnosticPrs.flatMap((pr) => (
      intrinsicDetails.get(pr.number) ?? []
    )))];
    const detail = `Ambiguous lifecycle mapping between issue(s) ${
      issueNumbers.length === 0 ? 'none' : issueNumbers.map((number) => `#${number}`).join(', ')
    } and PR(s) ${prNumbers.map((number) => `#${number}`).join(', ')}${
      details.length === 0 ? '' : `: ${details.join('; ')}`
    }`;
    diagnostics.push({
      code: 'branch-mapping-ambiguous',
      detail,
      issueNumbers,
      signature: mappingDiagnosticSignature({ issueNumbers, detail }),
      issues: issueNumbers.map((number) => ({
        number,
        projectStatus: byIssue.get(number)?.status ?? null,
      })),
      pullRequests: diagnosticPrs.map((pr) => ({
        number: pr.number,
        head: pr.headOid,
        draft: pr.isDraft,
        labels: [...pr.labels],
      })),
    });
  }

  const issueByPr = new Map<number, number>();
  const expectedBaseByPr = new Map<number, string>();
  for (const resolution of resolutions) {
    if (resolution.status !== 'resolved' || ambiguousPrs.has(resolution.prNumber)) continue;
    issueByPr.set(resolution.prNumber, resolution.issueNumber);
    expectedBaseByPr.set(resolution.prNumber, resolution.expectedBaseRefName);
  }
  return {
    issueByPr,
    expectedBaseByPr,
    resolutions,
    diagnostics,
    affectedIssues,
  };
}

type ReviewFollowUpBlock =
  | { readonly cause: 'parent-open'; readonly parentPr: number }
  | { readonly cause: 'unparseable-marker' };

/**
 * Review follow-up (canon §3, §5.1): held while the parent PR named by its
 * machine marker is still OPEN in this snapshot, because the reviewed code
 * exists only on that branch. Marker `pr=` and PR state are the only inputs.
 * A marker-shaped comment that does not parse fails closed. Absence of the
 * parent does not gate — canon §5.1 carries that boundary and its argument.
 */
function reviewFollowUpBlock(
  issue: PolledIssue,
  openPrNumbers: ReadonlySet<number>,
): ReviewFollowUpBlock | null {
  const body = issue.body ?? '';
  const marker = parseReviewFollowUpMarker(body);
  if (marker === null) {
    return hasReviewFollowUpMarkerTag(body) ? { cause: 'unparseable-marker' } : null;
  }
  return openPrNumbers.has(marker.parentPr)
    ? { cause: 'parent-open', parentPr: marker.parentPr }
    : null;
}

function eligibilityEvidence(
  issue: PolledIssue,
  eligible: boolean,
  authorDisallowed: boolean,
  stackReady: ReadonlyMap<number, unknown>,
  hasClaimBranch = false,
  followUpBlock: ReviewFollowUpBlock | null = null,
): { readonly reason: IssueEligibilityReason; readonly detail: string } {
  if (eligible) return { reason: 'eligible', detail: 'All implementation admission gates pass' };
  if (issue.blockedOn === 'Another issue' && !stackReady.has(issue.number)) {
    const blockers = issue.blockedByIssues.map((number) => `#${number}`).join(', ');
    return {
      reason: 'dependency-blocked',
      detail: blockers.length === 0
        ? 'Blocked by an unresolved issue dependency'
        : `Blocked by unresolved issue ${blockers}`,
    };
  }
  if (authorDisallowed) {
    return {
      reason: 'author-disallowed',
      detail: `Issue author ${issue.author || '(missing)'} is not selected by the author allowlist`,
    };
  }
  if (hasClaimBranch) {
    return {
      reason: 'not-selected',
      detail: `Issue has an in-flight claim branch autopilot/${issue.number}`,
    };
  }
  if (isMachineChildIssue(issue)) {
    return {
      reason: 'not-selected',
      detail: 'Machine child issue is not currently selectable',
    };
  }
  // Explainer only — the disjunction is unchanged, so `eligible` is identical
  // either way (it is computed by the caller and never reads `triageReason`).
  // Board membership is tested first because `shape` and `priority` are Project
  // *board* fields: an issue that is not on the board necessarily reads both as
  // null, and the old order reported "Issue Type is not set" for it. That sends
  // an operator to set a field on an item that has no board row to set it on.
  // The most fundamental unmet condition is the actionable one.
  const triageReason =
    !issue.onBoard || issue.projectItemId === null ? 'Issue is not on the Project'
      : issue.shape === null ? 'Issue Type is not set'
        : issue.priority === null ? 'Priority is not set'
          : issue.blockedOn === 'Human' ? 'Project Blocked on is Human'
            : null;
  if (triageReason !== null) return { reason: 'not-selected', detail: triageReason };
  // Below the whole cascade on purpose: an untriaged, author-disallowed or
  // already-claimed follow-up must report *that* failure, not the parent PR.
  if (followUpBlock !== null) {
    return followUpBlock.cause === 'parent-open'
      ? {
          reason: 'dependency-blocked',
          detail: `Review follow-up is blocked by open parent PR #${followUpBlock.parentPr}`,
        }
      : {
          reason: 'not-selected',
          detail: 'Review follow-up marker is present but could not be parsed',
        };
  }
  return {
    reason: 'not-selected',
    detail: `Project Blocked on is ${issue.blockedOn ?? 'unset'}`,
  };
}

function openChildrenByParent(
  issues: readonly PolledIssue[],
): Map<number, ChildKind[]> {
  const byParent = new Map<number, ChildKind[]>();
  for (const issue of issues) {
    const marker = parseChildMarker(issue.body ?? '');
    if (marker === null) continue;
    const current = byParent.get(marker.parentPr) ?? [];
    if (!current.includes(marker.kind)) current.push(marker.kind);
    byParent.set(marker.parentPr, current);
  }
  return byParent;
}

function lifecycleItems(
  issues: readonly PolledIssue[],
  prs: readonly PullRequestSnapshot[],
  branches: readonly BranchClaimSnapshot[],
  authorAllowlist: ReadonlySet<string>,
  machineAuthorLogins: ReadonlySet<string>,
  project: ProjectSnapshot,
  defaultBranch: string,
  closingIssueEvidenceComplete: boolean,
): {
  readonly items: readonly LifecycleItem[];
  readonly diagnostics: readonly LifecycleMappingDiagnostic[];
  readonly mappings: readonly StructuredPullRequestMapping[];
} {
  const byIssue = new Map(issues.map((issue) => [issue.number, issue]));
  for (const entry of project.items) {
    if (entry.contentType !== 'Issue' || byIssue.has(entry.number)) continue;
    byIssue.set(entry.number, {
      number: entry.number,
      title: '',
      shape: entry.issueType,
      blockedOn: entry.blockedOn,
      blockedByIssues: [...entry.blockedByIssues],
      effort: entry.effort,
      priority: entry.priority,
      status: entry.status,
      onBoard: true,
      author: '',
      projectItemId: entry.id,
      inCurrentSprint: entry.sprintIterationId !== null
        && entry.sprintIterationId === project.currentSprintIterationId,
    });
  }
  const mappings = resolveMappings(prs, branches, byIssue, defaultBranch);
  const mappingEvidenceComplete = closingIssueEvidenceComplete
    && prs.every((pr) => pr.closingIssueNumbersIncomplete !== true);
  const links = prLinksByIssue(prs, mappings.issueByPr);
  const stackReady = resolveStackReady([...issues], links, authorAllowlist);
  const claimBranchIssues = new Set(
    branches
      .filter((branch) => (
        branch.claim.phase === 'implement'
        && branch.headRefName === `autopilot/${branch.issueNumber}`
      ))
      .map((branch) => branch.issueNumber),
  );
  const issuesWithPr = new Set([
    ...mappings.issueByPr.values(),
    ...mappings.affectedIssues,
  ]);
  const inFlight = new Set([
    ...issuesWithPr,
    ...claimBranchIssues,
  ]);
  const selected = mappingEvidenceComplete
    ? selectReady([...issues], inFlight, authorAllowlist, stackReady)
    : { ready: [], skippedForAuthor: [] };
  const ready = new Set(selected.ready.map((issue) => issue.number));
  const skippedForAuthor = new Set(selected.skippedForAuthor.map((issue) => issue.number));
  const childrenByParent = openChildrenByParent([...byIssue.values()]);
  const openPrNumbers = new Set(
    prs.filter((pr) => pr.state === 'OPEN').map((pr) => pr.number),
  );
  const out: LifecycleItem[] = [];
  for (const issue of issues) {
    if (issuesWithPr.has(issue.number)) continue;
    const issueLabels = [...(issue.labels ?? [])];
    const sourceHumanHold = hasExternalHumanAuthority({
      nativeIssueLabels: issueLabels,
      projectBlockedOn: issue.blockedOn,
    });
    const selectedReady = ready.has(issue.number);
    // Review follow-ups wait on their parent PR's branch (canon §5.1).
    const followUpBlock = reviewFollowUpBlock(issue, openPrNumbers);
    const eligible = selectedReady && !sourceHumanHold && followUpBlock === null;
    const holdDetail = issue.blockedOn === 'Human'
      ? 'Project Blocked on is Human'
      : issueLabels.includes('autopilot:human')
        ? 'Issue carries autopilot:human'
        : issueLabels.includes('review:needs-human')
          ? 'Issue carries review:needs-human'
          : undefined;
    const eligibility = !mappingEvidenceComplete
      ? {
          reason: 'not-selected' as const,
          detail: 'PR closing-issue mapping evidence is incomplete',
        }
      : sourceHumanHold && selectedReady && holdDetail !== undefined
      ? { reason: 'not-selected' as const, detail: holdDetail }
      : eligibilityEvidence(
        issue,
        eligible,
        skippedForAuthor.has(issue.number),
        stackReady,
        claimBranchIssues.has(issue.number),
        followUpBlock,
      );
    const sourceHumanReason: HumanReason | undefined = sourceHumanHold
      ? {
          phase: 'eligible',
          code: 'implementation-escalation',
          detail: holdDetail ?? 'Human hold',
        }
      : undefined;
    out.push({
      kind: 'issue',
      issueNumber: issue.number,
      v2Marked: isMachineChildIssue(issue),
      projectStatus: issue.status,
      labels: issueLabels,
      ...(sourceHumanHold ? { humanHold: true } : {}),
      ...(sourceHumanReason === undefined ? {} : { humanReason: sourceHumanReason }),
      eligible,
      eligibilityReason: eligibility.reason,
      eligibilityDetail: eligibility.detail,
    });
  }
  for (const pr of prs) {
    if (!mappingEvidenceComplete) continue;
    const issueNumber = mappings.issueByPr.get(pr.number);
    if (issueNumber === undefined) continue;
    const issue = byIssue.get(issueNumber);
    if (issue !== undefined) {
      out.push(lifecyclePr(
        pr,
        issue,
        mappings.expectedBaseByPr.get(pr.number) ?? defaultBranch,
        machineAuthorLogins,
        childrenByParent.get(pr.number) ?? [],
      ));
    }
  }
  return {
    items: out,
    diagnostics: mappings.diagnostics,
    mappings: mappings.resolutions,
  };
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

export function composeGitHubLifecycleSnapshot(
  evidence: {
    readonly project: ProjectSnapshot;
    readonly issues: readonly PolledIssue[];
    readonly pullRequests: readonly PullRequestSnapshot[];
    readonly branches: readonly BranchClaimSnapshot[];
    readonly terminalClaims?: readonly TerminalClaimEvidence[];
  },
  options: {
    readonly authorAllowlist: ReadonlySet<string>;
    readonly machineAuthorLogins?: ReadonlySet<string>;
    readonly defaultBranch?: string;
    readonly capturedAt: string;
    readonly snapshotMode: SnapshotReadMode;
    readonly lastFullReconciliationAt: string;
    readonly githubUsage: GitHubUsage;
    readonly parityDifferences?: readonly LifecycleParityDifference[];
    readonly parityUnavailableReason?: string;
    readonly snapshotAuthority?: 'scoped';
    readonly scopedIssueNumbers?: readonly number[];
    readonly globalOpenPipelineBacklog?: number;
    readonly closingIssueEvidenceIncomplete?: true;
  },
): GitHubLifecycleSnapshot {
  isoTimestamp(options.capturedAt);
  isoTimestamp(options.lastFullReconciliationAt);
  if (
    options.globalOpenPipelineBacklog !== undefined
    && (
      !Number.isSafeInteger(options.globalOpenPipelineBacklog)
      || options.globalOpenPipelineBacklog < 0
    )
  ) {
    throw new Error('Global open-pipeline backlog must be a non-negative integer');
  }
  const mappingEvidenceComplete = options.closingIssueEvidenceIncomplete !== true
    && evidence.pullRequests.every((pr) => (
      pr.closingIssueNumbersIncomplete !== true
      && pr.evidenceIncompleteReason === undefined
    ));
  const lifecycle = lifecycleItems(
    evidence.issues,
    evidence.pullRequests,
    evidence.branches,
    options.authorAllowlist,
    new Set(
      [...(options.machineAuthorLogins ?? [])].map((login) => login.toLowerCase()),
    ),
    evidence.project,
    options.defaultBranch ?? 'next',
    mappingEvidenceComplete,
  );
  return deepFreeze({
    project: evidence.project,
    issues: [...evidence.issues],
    pullRequests: [...evidence.pullRequests],
    branches: [...evidence.branches],
    terminalClaims: [...(evidence.terminalClaims ?? [])],
    diagnostics: lifecycle.diagnostics,
    pullRequestMappings: lifecycle.mappings,
    lifecycle: { items: lifecycle.items },
    capturedAt: options.capturedAt,
    snapshotMode: options.snapshotMode,
    snapshotComplete: mappingEvidenceComplete,
    lastFullReconciliationAt: options.lastFullReconciliationAt,
    githubUsage: options.githubUsage,
    ...(options.parityDifferences === undefined
      ? {}
      : { parityDifferences: [...options.parityDifferences] }),
    ...(options.parityUnavailableReason === undefined
      ? {}
      : { parityUnavailableReason: options.parityUnavailableReason }),
    ...(options.snapshotAuthority === undefined
      ? {}
      : {
          snapshotAuthority: options.snapshotAuthority,
          scopedIssueNumbers: [...(options.scopedIssueNumbers ?? [])],
          ...(options.globalOpenPipelineBacklog === undefined
            ? {}
            : { globalOpenPipelineBacklog: options.globalOpenPipelineBacklog }),
        }),
  });
}

export async function buildGitHubLifecycleSnapshot(
  reader: GitHubLifecycleReader,
  options: {
    readonly authorAllowlist: ReadonlySet<string>;
    readonly machineAuthorLogins?: ReadonlySet<string>;
    readonly now?: () => Date;
    readonly maxPages?: number;
    readonly rateLimitFloor?: number;
    readonly defaultBranch?: string;
  },
): Promise<GitHubLifecycleSnapshot> {
  if (typeof reader.githubUsage !== 'function') {
    throw new Error('Full lifecycle snapshot requires a cycle usage meter');
  }
  if (reader.readGraphQlRemaining === undefined) {
    throw new Error('Full lifecycle snapshot live rate-limit reader is unavailable');
  }
  const usageBeforeFull = reader.githubUsage();
  const rateLimitFloor = options.rateLimitFloor ?? DEFAULT_FLOOR;
  try {
    assertRateLimitReserve(
      await reader.readGraphQlRemaining(),
      FULL_SCAN_RESERVE,
      rateLimitFloor,
    );
  } catch (error) {
    if (!(error instanceof GitHubRateLimitReserveError)) throw error;
    throw new LifecycleRateLimitError(error.remaining, error.required, error.reserve);
  }
  const project = await reader.readProjectSnapshot();
  const usageAfterProject = reader.githubUsage();
  const projectGraphQlCost = usageAfterProject.graphqlCost - usageBeforeFull.graphqlCost;
  if (!Number.isSafeInteger(projectGraphQlCost) || projectGraphQlCost < 0) {
    throw new Error('Full lifecycle Project read returned inconsistent GraphQL usage evidence');
  }
  try {
    assertRateLimitReserve(
      project.rateLimit.remaining,
      Math.max(0, FULL_SCAN_RESERVE - projectGraphQlCost),
      rateLimitFloor,
    );
  } catch (error) {
    if (!(error instanceof GitHubRateLimitReserveError)) throw error;
    throw new LifecycleRateLimitError(error.remaining, error.required, error.reserve);
  }
  const issues = await reader.readIssues(toIssueBoardState(project));
  const nonDoneIssueNumbers = project.items
    .filter((item) => item.contentType === 'Issue' && item.status !== 'Done')
    .map((item) => item.number);
  const rawPrs: RawPullRequest[] = [];
  let closingIssueEvidenceIncomplete = false;
  const maxPages = options.maxPages ?? 100;
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let pageNumber = 1; ; pageNumber += 1) {
    if (pageNumber > maxPages) throw new Error('PR pagination exceeded safety limit');
    const page = await reader.readPullRequests(cursor, nonDoneIssueNumbers);
    rawPrs.push(...page.nodes);
    if (page.closingIssueEvidenceIncomplete === true) {
      closingIssueEvidenceIncomplete = true;
    }
    if (!page.pageInfo.hasNextPage) break;
    const next = page.pageInfo.endCursor;
    if (next === null || seen.has(next)) {
      throw new Error('PR pagination cursor did not advance');
    }
    seen.add(next);
    cursor = next;
  }
  const pullRequests = rawPrs.map(decodePullRequestSnapshot);
  const branchClaims = await reader.readBranchClaims?.() ?? [];
  const branches: BranchClaimSnapshot[] = [];
  for (const raw of branchClaims) {
    try {
      branches.push(decodeBranchClaimSnapshot(raw));
    } catch (cause) {
      console.warn(
        `[snapshot] skipping undecodable branch claim ${raw.headRefName}: ${
          errorMessage(cause)
        }`,
      );
    }
  }
  const now = (options.now ?? (() => new Date()))();
  isoTimestamp(now.toISOString());
  const githubUsage = reader.githubUsage();
  if (
    githubUsage.graphqlRequests < 1
    || githubUsage.graphqlRemaining === null
    || githubUsage.graphqlResetAt === null
  ) {
    throw new Error('Full lifecycle snapshot is missing metered GraphQL rate-limit evidence');
  }
  try {
    assertRateLimitReserve(
      githubUsage.graphqlRemaining,
      0,
      rateLimitFloor,
    );
  } catch (error) {
    if (!(error instanceof GitHubRateLimitReserveError)) throw error;
    throw new LifecycleRateLimitError(error.remaining, error.required, error.reserve);
  }
  return composeGitHubLifecycleSnapshot({ project, issues, pullRequests, branches }, {
    authorAllowlist: options.authorAllowlist,
    ...(options.machineAuthorLogins === undefined
      ? {}
      : { machineAuthorLogins: options.machineAuthorLogins }),
    capturedAt: now.toISOString(),
    snapshotMode: 'full',
    lastFullReconciliationAt: now.toISOString(),
    githubUsage,
    ...(closingIssueEvidenceIncomplete
      ? { closingIssueEvidenceIncomplete: true as const }
      : {}),
    ...(options.defaultBranch === undefined ? {} : { defaultBranch: options.defaultBranch }),
  });
}

export function nativeStateForVerdict(
  state: ReviewVerdictState,
): Extract<NativeReviewState, 'APPROVED' | 'CHANGES_REQUESTED'> {
  return state === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED';
}
