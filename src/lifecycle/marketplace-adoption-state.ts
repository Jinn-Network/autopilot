import { isDeepStrictEqual } from 'node:util';
import {
  advanceMarketplaceExecutionExpectedHead,
  MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION,
  readAttemptManifest,
  replaceMarketplaceExecutionState,
  type AttemptManifest,
} from './attempt-workspace.js';
import {
  MARKETPLACE_EVALUATOR_LEG_SCHEMA_VERSION,
  MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION,
  type MarketplaceArtifactEvidence,
  type MarketplaceAdoptionProgress,
  type MarketplaceCompletionEvidence,
  type MarketplaceEvaluatorLegExecutionState,
  type MarketplaceEvaluatorLegIdentity,
  type MarketplaceHostCommitEvidence,
  type MarketplaceReceiptEvidence,
  type MarketplaceReviewAnchorEvidence,
  type MarketplaceSolutionDeliveryEvidence,
  type MarketplaceVerificationEvidence,
  type MarketplaceExecutionV3State,
  type MarketplaceExecutionV3Status,
} from './marketplace-execution-state.js';

export type MarketplaceRecoveryStatus =
  | MarketplaceExecutionV3Status
  | 'prepared'
  | 'cancelled';

export function marketplaceStatus(
  manifest: AttemptManifest,
): MarketplaceRecoveryStatus | null {
  if (manifest.execution.backend !== 'marketplace') {
    throw new Error('Only marketplace attempts expose marketplace status');
  }
  const state = manifest.execution.state;
  if (state.schemaVersion === MARKETPLACE_EVALUATOR_LEG_SCHEMA_VERSION) {
    return null;
  }
  if (state.schemaVersion === MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION) {
    return state.status;
  }
  if (state.schemaVersion === MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION) {
    if (state.status === 'prepared' || state.status === 'cancelled' || state.status === 'submitted') {
      return state.status;
    }
  }
  throw new Error('Unsupported marketplace execution state for recovery');
}

export type MarketplaceAdoptionTransition =
  | { readonly status: 'solution-observed'; readonly delivery: MarketplaceSolutionDeliveryEvidence }
  | { readonly status: 'solution-verified'; readonly artifact: MarketplaceArtifactEvidence; readonly verification: MarketplaceVerificationEvidence }
  | { readonly status: 'host-committed'; readonly hostCommit: MarketplaceHostCommitEvidence }
  | { readonly status: 'lifecycle-completed'; readonly completion: MarketplaceCompletionEvidence }
  | { readonly status: 'review-anchored'; readonly reviewAnchor: MarketplaceReviewAnchorEvidence }
  | { readonly status: 'receipt-published'; readonly receipt: MarketplaceReceiptEvidence };

export type MarketplaceEvaluatorLegTransition = {
  readonly status: 'released';
  readonly releaseReason: string;
};

function digest(value: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error('Invalid marketplace request digest');
  return value;
}

function timestamp(now: () => Date): string {
  return now().toISOString();
}

function adoptionState(
  manifest: AttemptManifest,
  expected: string,
): MarketplaceExecutionV3State {
  if (manifest.execution.backend !== 'marketplace') {
    throw new Error('Marketplace request digest changed before adoption transition');
  }
  const state = manifest.execution.state;
  if (state.schemaVersion === MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION) {
    if (state.requestDigest !== expected) {
      throw new Error('Marketplace request digest changed before adoption transition');
    }
    return state;
  }
  if (
    state.schemaVersion !== MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
    || state.requestDigest !== expected
    || state.status === 'cancelled'
  ) {
    throw new Error('Marketplace request digest changed before adoption transition');
  }
  return {
    ...state,
    schemaVersion: MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION,
  };
}

function durableProgress(
  state: MarketplaceExecutionV3State,
): MarketplaceAdoptionProgress | undefined {
  switch (state.status) {
    case 'solution-observed':
      return { status: state.status, delivery: state.delivery };
    case 'solution-verified':
      return {
        status: state.status,
        delivery: state.delivery,
        artifact: state.artifact,
        verification: state.verification,
      };
    case 'host-committed':
      return {
        status: state.status,
        delivery: state.delivery,
        artifact: state.artifact,
        verification: state.verification,
        hostCommit: state.hostCommit,
      };
    case 'lifecycle-completed':
      return {
        status: state.status,
        delivery: state.delivery,
        artifact: state.artifact,
        verification: state.verification,
        hostCommit: state.hostCommit,
        completion: state.completion,
      };
    case 'review-anchored':
      return {
        status: state.status,
        delivery: state.delivery,
        artifact: state.artifact,
        verification: state.verification,
        hostCommit: state.hostCommit,
        completion: state.completion,
        reviewAnchor: state.reviewAnchor,
      };
    case 'receipt-published':
      return state.progress;
    case 'prepared':
    case 'submitted':
    case 'cancelled':
      return undefined;
  }
}

function evaluatorIdentityFromState(
  state: MarketplaceEvaluatorLegExecutionState,
): MarketplaceEvaluatorLegIdentity {
  return {
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
  };
}

export function upgradeMarketplaceExecutionV2(
  manifestPath: string,
  expectedRequestDigest: string,
  now: () => Date = () => new Date(),
): AttemptManifest {
  const expected = digest(expectedRequestDigest);
  const manifest = readAttemptManifest(manifestPath);
  if (manifest.execution.backend !== 'marketplace') throw new Error('Only marketplace attempts may upgrade');
  const state = manifest.execution.state;
  if (state.schemaVersion === MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION) {
    if (state.requestDigest !== expected) throw new Error('Marketplace request digest changed before upgrade');
    return manifest;
  }
  if (state.schemaVersion !== MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION || state.requestDigest !== expected) {
    throw new Error('Marketplace request digest changed before upgrade');
  }
  if (state.status === 'cancelled') return manifest;
  const upgraded = {
    ...state,
    schemaVersion: MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION,
  };
  const at = timestamp(now);
  if (Date.parse(at) < Date.parse(manifest.timestamps.updatedAt)) {
    throw new Error('Marketplace upgrade timestamp predates manifest updated timestamp');
  }
  return replaceMarketplaceExecutionState(manifestPath, state, upgraded, at);
}

export function advanceMarketplaceAdoptionExpectedHead(
  manifestPath: string,
  expectedRequestDigest: string,
  expectedHead: string,
  nextHead: string,
  now: () => Date = () => new Date(),
): AttemptManifest {
  const expected = digest(expectedRequestDigest);
  const manifest = readAttemptManifest(manifestPath);
  if (manifest.execution.backend !== 'marketplace') {
    throw new Error('Only marketplace attempts may advance adoption expected head');
  }
  const state = manifest.execution.state;
  if (
    state.schemaVersion !== MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION
    || state.requestDigest !== expected
    || state.status !== 'host-committed'
  ) {
    throw new Error('Only a host-committed marketplace adoption may advance expected head');
  }
  return advanceMarketplaceExecutionExpectedHead(
    manifestPath,
    state,
    expectedHead,
    nextHead,
    timestamp(now),
  );
}

export function transitionMarketplaceAdoption(
  manifestPath: string,
  expectedRequestDigest: string,
  transition: MarketplaceAdoptionTransition,
  now: () => Date = () => new Date(),
): AttemptManifest {
  const expected = digest(expectedRequestDigest);
  const manifest = readAttemptManifest(manifestPath);
  if (manifest.execution.backend !== 'marketplace') {
    throw new Error('Marketplace request digest changed before adoption transition');
  }
  const expectedState = manifest.execution.state;
  const state = adoptionState(manifest, expected);
  const at = timestamp(now);
  if (Date.parse(at) < Date.parse(manifest.timestamps.updatedAt)) {
    throw new Error('Marketplace adoption transition timestamp predates manifest updated timestamp');
  }
  const same = (status: string): AttemptManifest => {
    const durable = state as unknown as Record<string, unknown>;
    const requested = transition as unknown as Record<string, unknown>;
    const matches = status === 'solution-verified'
      ? isDeepStrictEqual(durable.artifact, requested.artifact)
        && isDeepStrictEqual(durable.verification, requested.verification)
      : isDeepStrictEqual(
          durable[status === 'solution-observed'
            ? 'delivery'
            : status === 'host-committed'
              ? 'hostCommit'
              : status === 'lifecycle-completed'
                ? 'completion'
                : status === 'review-anchored'
                  ? 'reviewAnchor'
                  : 'receipt'],
          requested.delivery
            ?? requested.hostCommit
            ?? requested.completion
            ?? requested.reviewAnchor
            ?? requested.receipt,
        );
    if (state.status === status && matches) return manifest;
    throw new Error('Marketplace adoption transition contradicts prior durable state');
  };
  switch (transition.status) {
    case 'solution-observed':
      if (state.status !== 'submitted') return same('solution-observed');
      return replaceMarketplaceExecutionState(manifestPath, expectedState, { ...state, status: 'solution-observed', delivery: transition.delivery }, at);
    case 'solution-verified':
      if (state.status !== 'solution-observed') return same('solution-verified');
      return replaceMarketplaceExecutionState(manifestPath, expectedState, { ...state, status: 'solution-verified', artifact: transition.artifact, verification: transition.verification }, at);
    case 'host-committed':
      if (state.status !== 'solution-verified') return same('host-committed');
      return replaceMarketplaceExecutionState(manifestPath, expectedState, { ...state, status: 'host-committed', hostCommit: transition.hostCommit }, at);
    case 'lifecycle-completed':
      if (state.status !== 'host-committed') return same('lifecycle-completed');
      return replaceMarketplaceExecutionState(manifestPath, expectedState, { ...state, status: 'lifecycle-completed', completion: transition.completion }, at);
    case 'review-anchored':
      if (state.status !== 'lifecycle-completed') return same('review-anchored');
      return replaceMarketplaceExecutionState(manifestPath, expectedState, { ...state, status: 'review-anchored', reviewAnchor: transition.reviewAnchor }, at);
    case 'receipt-published':
      if (state.status === 'receipt-published') return same('receipt-published');
      if (!('submission' in state)) return same('receipt-published');
      {
        const progress = durableProgress(state);
        if (progress === undefined) return same('receipt-published');
        return replaceMarketplaceExecutionState(manifestPath, expectedState, {
          schemaVersion: state.schemaVersion,
          requestPath: state.requestPath,
          requestDigest: state.requestDigest,
          solverNetSelectionPath: state.solverNetSelectionPath,
          preparedAt: state.preparedAt,
          agentSoftDeadline: state.agentSoftDeadline,
          adoptionDeadline: state.adoptionDeadline,
          submission: state.submission,
          submittedAt: state.submittedAt,
          status: 'receipt-published',
          progress,
          receipt: transition.receipt,
        }, at);
      }
  }
}

export function installMarketplaceEvaluatorLeg(
  manifestPath: string,
  identity: MarketplaceEvaluatorLegIdentity,
  now: () => Date = () => new Date(),
): AttemptManifest {
  const manifest = readAttemptManifest(manifestPath);
  if (manifest.execution.backend !== 'marketplace') throw new Error('Evaluator leg requires a marketplace attempt');
  if (manifest.execution.state.schemaVersion === MARKETPLACE_EVALUATOR_LEG_SCHEMA_VERSION) {
    if (!isDeepStrictEqual(evaluatorIdentityFromState(manifest.execution.state), identity)) {
      throw new Error('Marketplace evaluator leg identity changed');
    }
    return manifest;
  }
  if (
    manifest.phase !== 'review'
    || manifest.reviewApprovalPolicy !== 'approve-eligible'
    || (
      manifest.execution.state.schemaVersion !== MARKETPLACE_EXECUTION_V2_SCHEMA_VERSION
      && manifest.execution.state.schemaVersion !== MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION
    )
    || manifest.execution.state.status !== 'prepared'
  ) {
    throw new Error('Evaluator leg requires an eligible prepared review manifest');
  }
  if (
    manifest.prNumber !== identity.prNumber
    || manifest.expectedHead !== identity.expectedHead
    || manifest.reviewGeneration !== identity.generation
    || manifest.reviewRefOid !== identity.reviewRefOid
    || manifest.selectedLogin !== identity.reviewer
  ) {
    throw new Error('Marketplace evaluator contradicts review manifest authority');
  }
  const anchoredAt = timestamp(now);
  if (Date.parse(anchoredAt) < Date.parse(manifest.timestamps.updatedAt)) {
    throw new Error('Marketplace evaluator install timestamp predates manifest updated timestamp');
  }
  return replaceMarketplaceExecutionState(
    manifestPath,
    manifest.execution.state,
    {
      ...identity,
      schemaVersion: MARKETPLACE_EVALUATOR_LEG_SCHEMA_VERSION,
      status: 'anchored',
      anchoredAt,
    },
    anchoredAt,
  );
}

export function transitionMarketplaceEvaluatorLeg(
  manifestPath: string,
  expected: MarketplaceEvaluatorLegIdentity,
  transition: MarketplaceEvaluatorLegTransition,
  now: () => Date = () => new Date(),
): AttemptManifest {
  if (transition.status !== 'released') throw new Error('Invalid marketplace evaluator leg transition');
  const manifest = readAttemptManifest(manifestPath);
  if (
    manifest.execution.backend !== 'marketplace'
    || manifest.execution.state.schemaVersion !== MARKETPLACE_EVALUATOR_LEG_SCHEMA_VERSION
    || !isDeepStrictEqual(evaluatorIdentityFromState(manifest.execution.state), expected)
  ) {
    throw new Error('Marketplace evaluator leg identity changed');
  }
  const state: MarketplaceEvaluatorLegExecutionState = manifest.execution.state;
  if (state.status === 'released') {
    if (state.releaseReason !== transition.releaseReason) throw new Error('Marketplace evaluator leg release contradicts durable state');
    return manifest;
  }
  const releasedAt = timestamp(now);
  if (Date.parse(releasedAt) < Date.parse(state.anchoredAt)) throw new Error('Marketplace evaluator release timestamp predates anchor');
  return replaceMarketplaceExecutionState(manifestPath, state, { ...state, status: 'released', releasedAt, releaseReason: transition.releaseReason }, releasedAt);
}
