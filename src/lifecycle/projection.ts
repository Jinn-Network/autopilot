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
      readonly kind: 'converge-mapping-human';
      readonly selectedIssueNumber: number;
      readonly prNumber: number;
      readonly expectedReviewRefOid: GitOid;
      readonly expectedGeneration: string;
      readonly expectedReviewState:
        | 'active'
        | 'verdict-intent'
        | 'terminal-approved'
        | 'mapping-reread'
        | 'human-intent'
        | 'human';
      readonly mappingRequest?: MappingRereadRequest;
      readonly mappingDiagnostic: MappingDiagnosticAuthority;
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
  return item.kind === 'pull-request'
    && item.reviewClaim?.state === 'verdict-intent'
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
  if (obsoleteMapping !== undefined) {
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
        marker: formatHumanCommentMarker({
          issueNumber: item.issueNumber,
          prNumber: item.prNumber,
          head: item.head,
          generation: obsoleteMapping.generation,
          reason: obsoleteMapping.reason,
          ...(obsoleteMapping.mappingDiagnostic === undefined
            ? {}
            : {
                diagnosticIssueNumbers:
                  obsoleteMapping.mappingDiagnostic.issueNumbers,
                diagnosticSignature:
                  obsoleteMapping.mappingDiagnostic.signature,
              }),
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
    const selectedIssueNumber =
      claim.mappingRequest?.selectedIssueNumber
      ?? pullRequest.scheduledIssueNumber
      ?? (canonical?.issueNumbers.length === 1
        ? canonical.issueNumbers[0]
        : undefined);
    const diagnostic: MappingDiagnosticAuthority | undefined =
      claim.mappingDiagnostic
      ?? (
        canonical === undefined || selectedIssueNumber === undefined
          ? undefined
          : {
              selectedIssueNumber,
              issueNumbers: [...canonical.issueNumbers],
              detail: canonical.detail,
              signature: canonical.signature,
            }
      );
    if (
      diagnostic === undefined
      || !diagnostic.issueNumbers.includes(diagnostic.selectedIssueNumber)
      || (
        canonical !== undefined
        && claim.state !== 'human-intent'
        && claim.state !== 'human'
        && (
          canonical.signature !== diagnostic.signature
          || canonical.detail !== diagnostic.detail
        )
      )
      || (
        claim.mappingRequest !== undefined
        && (
          pullRequest.headRefName !== claim.mappingRequest.headRefName
          || pullRequest.baseRefName !== claim.mappingRequest.baseRefName
        )
      )
      || claim.head !== (
        canonical?.pullRequests.find((candidate) =>
          candidate.number === pullRequest.number)?.head
        ?? claim.head
      )
      // A legacy bare Human record has no signed intent authority and must
      // remain fail-closed instead of adopting a newly observed diagnostic.
      || (claim.state === 'human' && claim.mappingDiagnostic === undefined)
    ) {
      continue;
    }
    const reason: HumanReason = {
      phase: 'reviewing',
      code: 'branch-mapping-ambiguous',
      detail: diagnostic.detail,
    };
    const marker = formatHumanCommentMarker({
      issueNumber: diagnostic.selectedIssueNumber,
      prNumber: pullRequest.number,
      head: claim.head,
      generation: claim.generation,
      reason,
      diagnosticIssueNumbers: diagnostic.issueNumbers,
      diagnosticSignature: diagnostic.signature,
    });
    actions.push({
      kind: 'converge-mapping-human',
      selectedIssueNumber: diagnostic.selectedIssueNumber,
      prNumber: pullRequest.number,
      expectedHead: claim.head,
      expectedReviewRefOid: pullRequest.reviewRefOid,
      expectedGeneration: claim.generation,
      expectedReviewState: claim.state,
      ...(claim.mappingRequest === undefined
        ? {}
        : { mappingRequest: claim.mappingRequest }),
      mappingDiagnostic: diagnostic,
      marker,
      body: `${marker}\n\nAutopilot parked this item for Human review.\n\n${reason.detail}`,
    });
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
