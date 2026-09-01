import type { ProjectStatus } from '../dispatcher/types.js';
import { DEFAULT_CONFIG } from '../dispatcher/types.js';
import { formatHumanCommentMarker } from './codecs.js';
import type {
  GitOid,
  HumanReason,
  LifecycleMappingDiagnostic,
  LifecyclePhase,
  LifecycleView,
  LifecycleViewItem,
  MappingDiagnosticAuthority,
  MappingRereadRequest,
  ReviewClaimState,
} from './types.js';

export interface ProjectionPullRequest {
  readonly number: number;
  readonly headRefName?: string;
  readonly baseRefName?: string;
  readonly scheduledIssueNumber?: number;
  readonly resolvedIssueNumber?: number;
  readonly reviewRefOid?: GitOid;
  readonly reviewClaim?: {
    readonly head: GitOid;
    readonly generation: string;
    readonly state: ReviewClaimState;
    readonly mappingRequest?: MappingRereadRequest;
    readonly mappingDiagnostic?: MappingDiagnosticAuthority;
  };
}

export interface OrphanBranchClaim {
  readonly issueNumber: number;
  readonly head: GitOid;
  readonly headRefName: string;
  readonly headChangedAt: string;
  readonly baseRefName: string;
  readonly claimAttempt: string;
  readonly claimRunner: string;
  readonly projectStatus: ProjectStatus | null;
  readonly phase: 'implementing' | 'awaiting-review' | 'human';
  readonly underlyingPhase?: 'implementing' | 'awaiting-review';
  readonly progressAgeMs?: number;
  readonly stale: boolean;
  readonly staleSince?: string;
  readonly staleReason?: 'branch-head-unchanged';
  readonly humanHold?: boolean;
  readonly humanReason?: HumanReason;
}

export interface ProjectionContext {
  readonly view: LifecycleView;
  readonly pullRequests: readonly ProjectionPullRequest[];
  readonly orphanBranchClaims: readonly OrphanBranchClaim[];
  readonly mappingDiagnostics?: readonly LifecycleMappingDiagnostic[];
  readonly snapshotComplete?: boolean;
}

interface HeadPinned {
  readonly expectedHead: GitOid;
}

export type ProjectionAction =
  | ({
      readonly kind: 'set-pr-draft';
      readonly prNumber: number;
      readonly draft: boolean;
      readonly requiresPreviousSuccess?: true;
    } & HeadPinned)
  | ({
      readonly kind: 'set-pr-label';
      readonly prNumber: number;
      readonly label: string;
      readonly present: boolean;
      readonly requiresPreviousSuccess?: true;
    } & HeadPinned)
  | ({
      readonly kind: 'ensure-human-comment';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly expectedReviewRefOid: GitOid;
      readonly expectedGeneration: string;
      readonly expectedDiagnosticIssueNumbers?: readonly number[];
      readonly expectedDiagnosticDetail?: string;
      readonly marker: string;
      readonly body: string;
    } & HeadPinned)
  | ({
      readonly kind: 'ensure-implementation-summary';
      readonly prNumber: number;
      readonly summary: string;
    } & HeadPinned)
  | ({
      readonly kind: 'repair-obsolete-mapping-human';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly expectedReviewRefOid: GitOid;
      readonly expectedGeneration: string;
      readonly expectedAuthor: string;
      readonly mappingDiagnostic: MappingDiagnosticAuthority;
      readonly marker: string;
    } & HeadPinned)
  | ({
      readonly kind: 'mark-review-stale';
      readonly prNumber: number;
      readonly expectedReviewRefOid: GitOid;
    } & HeadPinned)
  | ({
      readonly kind: 'complete-verdict-intent';
      readonly prNumber: number;
      readonly expectedReviewRefOid: GitOid;
      readonly state: 'terminal-approved';
    } & HeadPinned)
  | ({
      readonly kind: 'ensure-draft-pr';
      readonly issueNumber: number;
      readonly headRefName: string;
      readonly baseRefName: string;
    } & HeadPinned);

export interface ProjectionPlan {
  readonly actions: readonly ProjectionAction[];
}

function activeMutation(view: LifecycleViewItem): boolean {
  if (view.phase === 'human') return true;
  if (view.phase === 'implementing') {
    return true;
  }
  const item = view.item;
  if (
    item.kind === 'pull-request'
    && item.isDraft
    && item.reviewClaim?.head === item.head
    && item.reviewClaim.state === 'stale'
  ) {
    return true;
  }
  // Head-pinned, like every other review-claim check in the engine (issue
  // #118). A REQUEST_CHANGES verdict describes the diff at the head it was
  // recorded against; once the PR advances past that head the verdict has been
  // answered — by definition, since the only way to answer it is to push — and
  // must not keep drafting the new head. Without the pin this branch was the
  // engine's one unbounded latch: `verdict-intent`/`REQUEST_CHANGES` has no
  // completion path (only APPROVE completes, below), so the claim stayed in
  // that state forever, the PR was re-drafted every cycle, drafts are not
  // review-claimable, and the superseding review that would have replaced the
  // verdict could never run. Manual `gh pr ready` was reverted within one
  // cycle. Measured on Jinn-Network/mono: 142/142 APPROVE verdict intents
  // completed, 0/6 REQUEST_CHANGES ones did, and all six sat at a stale head.
  //
  // The pin is also the machine exit, and the only one this shape needs: push a
  // fix -> the head moves -> the latch releases -> `reviewEnrollmentEligible`
  // re-opens review enrollment on the now-undrafted PR at its new head. The
  // claim record is left behind at its old head deliberately; it is
  // `supersededReview` from that moment on, and every other consumer of a
  // review claim — the merge gate included — is already head-pinned, so a
  // stranded `verdict-intent` authorizes nothing.
  return item.kind === 'pull-request'
    && item.reviewClaim?.head === item.head
    && item.reviewClaim.state === 'verdict-intent'
    && item.reviewClaim.verdict.state === 'REQUEST_CHANGES';
}

function humanMarker(
  view: LifecycleViewItem,
  reviewRefOid: GitOid | undefined,
): Extract<ProjectionAction, { kind: 'ensure-human-comment' }> | null {
  if (
    view.phase !== 'human'
    || view.humanReason === undefined
    || view.item.kind !== 'pull-request'
    || reviewRefOid === undefined
    || view.item.reviewClaim?.state !== 'human'
    || view.item.reviewClaim.head !== view.item.head
  ) {
    return null;
  }
  const reason = view.humanReason;
  const marker = formatHumanCommentMarker({
    issueNumber: view.item.issueNumber,
    prNumber: view.item.prNumber,
    head: view.item.head,
    generation: view.item.reviewClaim.generation,
    reason,
  });
  return {
    kind: 'ensure-human-comment',
    issueNumber: view.item.issueNumber,
    prNumber: view.item.prNumber,
    expectedHead: view.item.head,
    expectedReviewRefOid: reviewRefOid,
    expectedGeneration: view.item.reviewClaim.generation,
    marker,
    body: `${marker}\n\nAutopilot parked this item for Human review.\n\n${reason.detail}`,
  };
}

function planItem(
  view: LifecycleViewItem,
  reviewRefByPr: ReadonlyMap<number, GitOid>,
  labels: { readonly review: string },
): ProjectionAction[] {
  const item = view.item;
  if (!item.v2Marked && view.phase !== 'human') return [];
  // Stage 3: Project Status is painter-owned. Cycle projection never emits
  // `set-project-status` / `requeue-implementation` (Status-only) actions.
  const actions: ProjectionAction[] = [];
  const implementationComplete = item.kind === 'pull-request'
    && item.branchClaim?.phase === 'implement'
    && item.branchClaim.phaseComplete === true;
  if (item.kind !== 'pull-request') return actions;
  const obsoleteMapping = item.obsoleteMachineMappingHuman;
  if (
    obsoleteMapping !== undefined
    && obsoleteMapping.mappingDiagnostic === undefined
  ) {
    // Unsigned legacy mapping overlays are migration input, never an
    // automatically writable projection.
    return [];
  }
  if (
    obsoleteMapping !== undefined
    && obsoleteMapping.mappingDiagnostic !== undefined
  ) {
    const refOid = reviewRefByPr.get(item.prNumber);
    if (refOid !== undefined) {
      return [{
        kind: 'repair-obsolete-mapping-human',
        issueNumber: item.issueNumber,
        prNumber: item.prNumber,
        expectedHead: item.head,
        expectedReviewRefOid: refOid,
        expectedGeneration: obsoleteMapping.generation,
        expectedAuthor: obsoleteMapping.author,
        mappingDiagnostic: obsoleteMapping.mappingDiagnostic,
        marker: formatHumanCommentMarker({
          issueNumber: item.issueNumber,
          prNumber: item.prNumber,
          head: item.head,
          generation: obsoleteMapping.generation,
          reason: obsoleteMapping.reason,
          diagnosticIssueNumbers:
            obsoleteMapping.mappingDiagnostic.issueNumbers,
          diagnosticSignature:
            obsoleteMapping.mappingDiagnostic.signature,
        }),
      }];
    }
  }

  if (view.phase === 'human') {
    const comment = humanMarker(view, reviewRefByPr.get(item.prNumber));
    return comment === null ? [] : [comment];
  }

  if (implementationComplete && item.implementationSummary !== undefined) {
    actions.push({
      kind: 'ensure-implementation-summary',
      prNumber: item.prNumber,
      expectedHead: item.head,
      summary: item.implementationSummary,
    });
  }

  let completedReviewState: 'terminal-approved' | undefined;
  if (
    item.v2Marked
    && item.reviewClaim?.state === 'verdict-intent'
    && item.reviewClaim.verdict.state === 'APPROVE'
    && item.terminalVerdict !== undefined
    && item.terminalVerdict.head === item.head
    && item.terminalVerdict.marker === item.reviewClaim.verdict.marker
    && item.terminalVerdict.state === item.reviewClaim.verdict.state
  ) {
    const refOid = reviewRefByPr.get(item.prNumber);
    if (refOid !== undefined) {
      completedReviewState = 'terminal-approved';
      actions.push({
        kind: 'complete-verdict-intent',
        prNumber: item.prNumber,
        expectedHead: item.head,
        expectedReviewRefOid: refOid,
        state: completedReviewState,
      });
    }
  }

  if (item.v2Marked) {
    const draft = activeMutation(view);
    if (!implementationComplete && item.isDraft !== draft) {
      actions.push({
        kind: 'set-pr-draft',
        prNumber: item.prNumber,
        expectedHead: item.head,
        draft,
      });
    }
    const wantsReviewLabel = true;
    if (
      !implementationComplete
      && item.labels.includes(labels.review) !== wantsReviewLabel
    ) {
      actions.push({
        kind: 'set-pr-label',
        prNumber: item.prNumber,
        expectedHead: item.head,
        label: labels.review,
        present: wantsReviewLabel,
      });
    }
  }

  if (implementationComplete) {
    const requiresPreviousSuccess = { requiresPreviousSuccess: true as const };
    if (!item.labels.includes(labels.review)) {
      actions.push({
        kind: 'set-pr-label',
        prNumber: item.prNumber,
        expectedHead: item.head,
        label: labels.review,
        present: true,
        ...requiresPreviousSuccess,
      });
    }
    const draft = activeMutation(view);
    if (item.isDraft !== draft) {
      actions.push({
        kind: 'set-pr-draft',
        prNumber: item.prNumber,
        expectedHead: item.head,
        draft,
        ...requiresPreviousSuccess,
      });
    }
  }

  if (!item.v2Marked) return actions;
  // Stage 3: stale implementation reclaim is claim-branch / scheduler driven;
  // Status Todo paint moved to the board painter (no requeue-implementation).
  if (view.stale && view.phase === 'reviewing') {
    const refOid = reviewRefByPr.get(item.prNumber);
    if (refOid !== undefined) {
      actions.push({
        kind: 'mark-review-stale',
        prNumber: item.prNumber,
        expectedHead: item.head,
        expectedReviewRefOid: refOid,
      });
    }
  }

  return actions;
}

export function planProjection(
  context: ProjectionContext,
  options: {
    readonly reviewLabel?: string;
  } = {},
): ProjectionPlan {
  const labels = {
    review: options.reviewLabel ?? DEFAULT_CONFIG.engineReviewLabel,
  };
  const reviewRefByPr = new Map<number, GitOid>();
  for (const pr of context.pullRequests) {
    if (pr.reviewRefOid !== undefined) reviewRefByPr.set(pr.number, pr.reviewRefOid);
  }
  const actions = context.view.items.flatMap((view) => (
    planItem(view, reviewRefByPr, labels)
  ));
  const existingPrIssues = new Set(
    context.view.items
      .filter((view) => view.item.kind === 'pull-request')
      .map((view) => view.item.issueNumber),
  );
  for (const claim of context.orphanBranchClaims) {
    if (existingPrIssues.has(claim.issueNumber)) continue;
    if (claim.phase === 'human') {
      // Stage 3: Human Status paint is painter-owned (label/marker authority).
      continue;
    }
    if (claim.phase === 'awaiting-review') {
      actions.push({
        kind: 'ensure-draft-pr',
        issueNumber: claim.issueNumber,
        expectedHead: claim.head,
        headRefName: claim.headRefName,
        baseRefName: claim.baseRefName,
      });
      continue;
    }
    actions.push({
      kind: 'ensure-draft-pr',
      issueNumber: claim.issueNumber,
      expectedHead: claim.head,
      headRefName: claim.headRefName,
      baseRefName: claim.baseRefName,
    });
  }
  const diagnosticByPr = new Map<number, LifecycleMappingDiagnostic>();
  for (const diagnostic of context.mappingDiagnostics ?? []) {
    for (const pr of diagnostic.pullRequests) diagnosticByPr.set(pr.number, diagnostic);
  }
  for (const pullRequest of context.pullRequests) {
    const claim = pullRequest.reviewClaim;
    if (
      claim === undefined
      || pullRequest.reviewRefOid === undefined
      || claim.state === 'stale'
    ) {
      continue;
    }
    const canonical = diagnosticByPr.get(pullRequest.number);
    if (
      canonical === undefined
      && claim.state === 'mapping-reread'
      && claim.mappingRequest !== undefined
      && context.snapshotComplete === true
      && pullRequest.resolvedIssueNumber
        === claim.mappingRequest.selectedIssueNumber
      && pullRequest.headRefName === claim.mappingRequest.headRefName
      && pullRequest.baseRefName === claim.mappingRequest.baseRefName
    ) {
      if (!actions.some((action) => (
        action.kind === 'mark-review-stale'
        && action.prNumber === pullRequest.number
      ))) {
        actions.push({
          kind: 'mark-review-stale',
          prNumber: pullRequest.number,
          expectedHead: claim.head,
          expectedReviewRefOid: pullRequest.reviewRefOid,
        });
      }
      continue;
    }
  }
  return { actions };
}

export function phaseStatus(phase: LifecyclePhase): ProjectStatus {
  if (phase === 'human') return 'Human';
  if (phase === 'eligible') return 'Todo';
  if (phase === 'implementing') return 'In Progress';
  if (phase === 'merged') return 'Done';
  // blocked-by-child paints In Review for now (Stage 2); painter owns Status in Stage 3.
  return 'In Review';
}
