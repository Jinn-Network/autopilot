import type { AutopilotCorrelation } from '@jinn-network/sdk/autopilot';
import {
  anchorEvidenceFromEvaluatorManifest,
  findMarketplaceEvaluatorLegReviews,
  findMarketplaceEvaluatorReviewByAttemptId,
  readAttemptManifest,
  type AttemptManifest,
} from './attempt-workspace.js';
import { installMarketplaceEvaluatorLeg, transitionMarketplaceEvaluatorLeg } from './marketplace-adoption-state.js';
import type {
  MarketplaceEvaluatorLegIdentity,
  MarketplaceReviewAnchorEvidence,
} from './marketplace-execution-state.js';
import {
  acquireExactHeadReviewClaim,
  type AcquiredExactHeadReviewClaim,
  type ReviewActionCandidate,
  type ReviewClaimAcquisitionDeps,
  type ReviewClaimAcquisitionResult,
} from './review-executor.js';
import type { ReviewSessionPort } from './review-session.js';
import type {
  GitOid,
  PublicationOutcome,
  ReviewClaimRecord,
} from './types.js';
import { gitOid } from './types.js';

export type {
  AcquiredExactHeadReviewClaim,
  ReviewClaimAcquisitionDeps,
  ReviewClaimAcquisitionResult,
};

export { acquireExactHeadReviewClaim };

export interface MarketplaceReviewAnchorOrigin {
  readonly originManifestPath: string;
  readonly originV2AttemptId: string;
  readonly originRequestDigest: string;
  readonly taskId: string;
  readonly taskCid: string;
  readonly taskCreationBlock: number;
  readonly correlation: AutopilotCorrelation;
}

export type MarketplaceReviewAnchorResult =
  | { readonly status: 'anchored'; readonly anchor: MarketplaceReviewAnchorEvidence }
  | { readonly status: 'already-approved'; readonly detail: string }
  | { readonly status: 'rejected'; readonly detail: string }
  | { readonly status: 'recoverable'; readonly detail: string };

export interface MarketplaceReviewAnchorPort {
  acquireOrRecover(input: {
    readonly origin: MarketplaceReviewAnchorOrigin;
    readonly prNumber: number;
    readonly expectedHead: GitOid;
  }): Promise<MarketplaceReviewAnchorResult>;
  release(anchor: MarketplaceReviewAnchorEvidence): Promise<void>;
}

export interface MarketplaceReviewAnchorDependencies {
  readonly claimAcquisition: ReviewClaimAcquisitionDeps;
  readonly createEvaluatorReviewWorkspace: (input: {
    readonly claim: AcquiredExactHeadReviewClaim;
    readonly origin: MarketplaceReviewAnchorOrigin;
    readonly confirmed: ReviewActionCandidate;
  }) => Promise<AttemptManifest>;
  readonly releasePort?: ReviewSessionPort;
  readonly releasePortFor?: (manifestPath: string) => ReviewSessionPort;
  readonly now?: () => Date;
}

const ACTIVE_REVIEW_GENERATION_DETAIL = 'The exact PR head already has an active review generation.';
const CODEOWNER_REJECTION_DETAIL = 'CODEOWNER review claims cannot anchor marketplace evaluators.';

function claimFromManifest(manifest: AttemptManifest): AcquiredExactHeadReviewClaim {
  if (
    manifest.prNumber === undefined
    || manifest.reviewGeneration === undefined
    || manifest.reviewRefOid === undefined
    || manifest.reviewApprovalPolicy === undefined
  ) {
    throw new Error('Review manifest is incomplete');
  }
  return {
    prNumber: manifest.prNumber,
    head: gitOid(manifest.expectedHead),
    reviewRefOid: gitOid(manifest.reviewRefOid),
    attemptId: manifest.attemptId,
    generation: manifest.reviewGeneration,
    reviewer: manifest.selectedLogin,
    approvalPolicy: manifest.reviewApprovalPolicy,
    manifestPath: manifest.paths.manifest,
    paths: manifest.paths,
  };
}

function evaluatorIdentity(
  origin: MarketplaceReviewAnchorOrigin,
  claim: AcquiredExactHeadReviewClaim,
): MarketplaceEvaluatorLegIdentity {
  return {
    originManifestPath: origin.originManifestPath,
    originV2AttemptId: origin.originV2AttemptId,
    originRequestDigest: origin.originRequestDigest,
    taskId: origin.taskId,
    taskCid: origin.taskCid,
    taskCreationBlock: origin.taskCreationBlock,
    prNumber: claim.prNumber,
    expectedHead: claim.head,
    generation: claim.generation,
    reviewRefOid: claim.reviewRefOid,
    reviewer: claim.reviewer,
  };
}

function claimResultToAnchorResult(
  result: ReviewClaimAcquisitionResult,
): MarketplaceReviewAnchorResult {
  switch (result.status) {
    case 'acquired':
      throw new Error('Claim acquisition succeeded without anchor installation');
    case 'already-approved':
      return { status: 'already-approved', detail: result.detail };
    case 'ineligible':
    case 'human':
    case 'lost':
    case 'ambiguous':
      return { status: 'rejected', detail: result.detail };
  }
}

async function installEvaluatorLeg(
  manifestPath: string,
  origin: MarketplaceReviewAnchorOrigin,
  claim: AcquiredExactHeadReviewClaim,
  now: () => Date,
): Promise<AttemptManifest> {
  installMarketplaceEvaluatorLeg(manifestPath, evaluatorIdentity(origin, claim), now);
  return readAttemptManifest(manifestPath);
}

async function anchorFromPreparedManifest(
  manifest: AttemptManifest,
  origin: MarketplaceReviewAnchorOrigin,
  claim: AcquiredExactHeadReviewClaim,
  now: () => Date,
): Promise<MarketplaceReviewAnchorResult> {
  if (
    manifest.execution.backend === 'marketplace'
    && manifest.execution.state.schemaVersion === 'marketplace-evaluator-leg-v1'
  ) {
    if (manifest.execution.state.status === 'released') {
      return {
        status: 'rejected',
        detail: 'Linked evaluator-leg review manifest was already released.',
      };
    }
    return {
      status: 'anchored',
      anchor: anchorEvidenceFromEvaluatorManifest(manifest),
    };
  }
  const installed = await installEvaluatorLeg(manifest.paths.manifest, origin, claim, now);
  return {
    status: 'anchored',
    anchor: anchorEvidenceFromEvaluatorManifest(installed),
  };
}

async function abandonAcquiredReviewClaim(
  manifest: AttemptManifest,
  port: ReviewSessionPort,
): Promise<void> {
  await publishStaleReviewClaim(manifest, port);
}

async function abandonOrphanedActiveClaim(
  input: {
    readonly prNumber: number;
    readonly expectedHead: GitOid;
    readonly v2Base: string;
  },
  deps: Pick<MarketplaceReviewAnchorDependencies, 'releasePort' | 'releasePortFor'>,
  readCandidate: ReviewClaimAcquisitionDeps['readCandidate'],
): Promise<boolean> {
  const candidate = await readCandidate(input.prNumber);
  const activeClaim = candidate?.reviewRef?.record;
  if (
    candidate === null
    || candidate.head !== input.expectedHead
    || activeClaim === undefined
    || activeClaim.head !== input.expectedHead
    || activeClaim.state !== 'active'
    || activeClaim.prNumber !== input.prNumber
  ) {
    return false;
  }
  const manifest = findMarketplaceEvaluatorReviewByAttemptId(input.v2Base, activeClaim.attempt);
  if (manifest === null) return false;
  const port = releasePortForManifest(deps, manifest.paths.manifest);
  if (port === undefined) return false;
  await abandonAcquiredReviewClaim(manifest, port);
  return true;
}

function releasePortForManifest(
  deps: Pick<MarketplaceReviewAnchorDependencies, 'releasePort' | 'releasePortFor'>,
  manifestPath: string,
): ReviewSessionPort | undefined {
  return deps.releasePortFor?.(manifestPath) ?? deps.releasePort;
}

async function recoverPreparedEvaluatorReview(
  input: {
    readonly origin: MarketplaceReviewAnchorOrigin;
    readonly prNumber: number;
    readonly expectedHead: GitOid;
    readonly v2Base: string;
  },
  deps: MarketplaceReviewAnchorDependencies,
  now: () => Date,
): Promise<MarketplaceReviewAnchorResult | null> {
  const candidate = await deps.claimAcquisition.readCandidate(input.prNumber);
  const activeClaim = candidate?.reviewRef?.record;
  if (
    candidate === null
    || candidate.head !== input.expectedHead
    || activeClaim === undefined
    || activeClaim.head !== input.expectedHead
    || activeClaim.state !== 'active'
    || activeClaim.prNumber !== input.prNumber
  ) {
    return null;
  }
  const manifest = findMarketplaceEvaluatorReviewByAttemptId(input.v2Base, activeClaim.attempt);
  if (manifest === null) return null;
  if (manifest.execution.backend !== 'marketplace') return null;
  const state = manifest.execution.state;
  if (
    manifest.prNumber !== input.prNumber
    || manifest.expectedHead !== input.expectedHead
  ) {
    return null;
  }
  if (state.schemaVersion === 'marketplace-evaluator-leg-v1') {
    if (
      state.originV2AttemptId !== input.origin.originV2AttemptId
      || state.originRequestDigest !== input.origin.originRequestDigest
      || state.originManifestPath !== input.origin.originManifestPath
    ) {
      return null;
    }
    return anchorFromPreparedManifest(manifest, input.origin, claimFromManifest(manifest), now);
  }
  if (
    state.schemaVersion !== 'marketplace-execution-v2'
    || state.status !== 'prepared'
    || state.requestDigest !== input.origin.originRequestDigest
  ) {
    return null;
  }
  return anchorFromPreparedManifest(
    manifest,
    input.origin,
    claimFromManifest(manifest),
    now,
  );
}

function isCodeownerCandidate(candidate: ReviewActionCandidate | null): boolean {
  return candidate?.approvalPolicy === 'human-codeowner';
}

export async function anchorMarketplaceEvaluatorReview(
  input: {
    readonly origin: MarketplaceReviewAnchorOrigin;
    readonly prNumber: number;
    readonly expectedHead: GitOid;
    readonly v2Base: string;
  },
  deps: MarketplaceReviewAnchorDependencies,
): Promise<MarketplaceReviewAnchorResult> {
  const now = deps.now ?? (() => new Date());
  const criteria = {
    originManifestPath: input.origin.originManifestPath,
    originV2AttemptId: input.origin.originV2AttemptId,
    originRequestDigest: input.origin.originRequestDigest,
    prNumber: input.prNumber,
    expectedHead: input.expectedHead,
  };
  const linked = findMarketplaceEvaluatorLegReviews(input.v2Base, criteria);
  if (linked.length > 1) {
    return {
      status: 'rejected',
      detail: 'Multiple exact live evaluator-leg review manifests match the origin.',
    };
  }
  if (linked.length === 1) {
    return {
      status: 'anchored',
      anchor: anchorEvidenceFromEvaluatorManifest(linked[0]),
    };
  }

  const preClaimCandidate = await deps.claimAcquisition.readCandidate(input.prNumber);
  if (isCodeownerCandidate(preClaimCandidate)) {
    return {
      status: 'rejected',
      detail: CODEOWNER_REJECTION_DETAIL,
    };
  }

  const acquired = await acquireExactHeadReviewClaim(
    { prNumber: input.prNumber, expectedHead: input.expectedHead },
    deps.claimAcquisition,
  );
  if (acquired.status !== 'acquired') {
    if (
      acquired.status === 'ineligible'
      && acquired.detail === ACTIVE_REVIEW_GENERATION_DETAIL
    ) {
      const recovered = await recoverPreparedEvaluatorReview(input, deps, now);
      if (recovered !== null) return recovered;
    }
    if (
      acquired.status === 'human'
      && (deps.releasePort !== undefined || deps.releasePortFor !== undefined)
    ) {
      await abandonOrphanedActiveClaim(
        input,
        deps,
        deps.claimAcquisition.readCandidate,
      );
    }
    return claimResultToAnchorResult(acquired);
  }
  const { claim, confirmed } = acquired;
  if (confirmed.approvalPolicy !== 'approve-eligible') {
    const manifest = findMarketplaceEvaluatorReviewByAttemptId(input.v2Base, claim.attemptId)
      ?? readAttemptManifest(claim.manifestPath);
    const releasePort = releasePortForManifest(deps, manifest.paths.manifest);
    if (releasePort !== undefined) {
      await abandonAcquiredReviewClaim(manifest, releasePort);
    }
    return {
      status: 'rejected',
      detail: CODEOWNER_REJECTION_DETAIL,
    };
  }
  let manifest = findMarketplaceEvaluatorReviewByAttemptId(input.v2Base, claim.attemptId);
  if (manifest === null) {
    manifest = await deps.createEvaluatorReviewWorkspace({
      claim,
      origin: input.origin,
      confirmed,
    });
  }
  return anchorFromPreparedManifest(manifest, input.origin, claim, now);
}

async function publishStaleReviewClaim(
  manifest: AttemptManifest,
  port: ReviewSessionPort,
): Promise<void> {
  const authority = await port.readAuthority(manifest);
  if (authority.record.state === 'stale') return;
  const record: ReviewClaimRecord = {
    kind: 'review-claim',
    protocolVersion: 2,
    prNumber: manifest.prNumber!,
    generation: manifest.reviewGeneration!,
    attempt: manifest.attemptId,
    reviewer: manifest.selectedLogin,
    head: gitOid(manifest.expectedHead),
    state: 'stale',
    recordedAt: port.now().toISOString(),
  };
  const oid = await port.createReviewRecord({
    manifest,
    parent: authority.reviewRefOid,
    record,
  });
  const outcome: PublicationOutcome = await port.publishReviewClaim({
    manifest,
    recordParent: authority.reviewRefOid,
    expectedRemoteRecordOid: authority.reviewRefOid,
    recordOid: oid,
    record,
  });
  if (
    outcome.status === 'ambiguous'
    || !('observed' in outcome)
    || outcome.published !== oid
    || outcome.observed !== oid
  ) {
    throw new Error('Evaluator review claim release is ambiguous');
  }
}

export async function releaseMarketplaceReviewAnchor(
  anchor: MarketplaceReviewAnchorEvidence,
  port: ReviewSessionPort,
  now: () => Date = () => new Date(),
): Promise<void> {
  const manifest = readAttemptManifest(anchor.manifestPath);
  if (
    manifest.execution.backend !== 'marketplace'
    || manifest.execution.state.schemaVersion !== 'marketplace-evaluator-leg-v1'
  ) {
    throw new Error('Review anchor manifest is not an evaluator leg');
  }
  const state = manifest.execution.state;
  if (state.status === 'released') {
    await publishStaleReviewClaim(manifest, port);
    return;
  }
  transitionMarketplaceEvaluatorLeg(
    anchor.manifestPath,
    {
      originManifestPath: state.originManifestPath,
      originV2AttemptId: state.originV2AttemptId,
      originRequestDigest: state.originRequestDigest,
      taskId: state.taskId,
      taskCid: state.taskCid,
      taskCreationBlock: state.taskCreationBlock,
      prNumber: state.prNumber,
      expectedHead: state.expectedHead,
      generation: state.generation,
      reviewRefOid: state.reviewRefOid,
      reviewer: state.reviewer,
    },
    { status: 'released', releaseReason: 'adoption-rejected' },
    now,
  );
  await publishStaleReviewClaim(readAttemptManifest(anchor.manifestPath), port);
}

export function makeMarketplaceReviewAnchorPort(
  deps: MarketplaceReviewAnchorDependencies & {
    readonly v2Base: string;
  },
): MarketplaceReviewAnchorPort {
  const now = deps.now ?? (() => new Date());
  return {
    acquireOrRecover: (input) => anchorMarketplaceEvaluatorReview(
      { ...input, v2Base: deps.v2Base },
      deps,
    ),
    release: (anchor) => {
      const releasePort = releasePortForManifest(deps, anchor.manifestPath);
      if (releasePort === undefined) {
        throw new Error('Review anchor release port is unavailable');
      }
      return releaseMarketplaceReviewAnchor(anchor, releasePort, now);
    },
  };
}
