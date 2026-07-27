import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import {
  AutopilotAdoptionReceiptSchema,
  AutopilotCorrelationSchema,
  AutopilotMutationResultSchema,
  AutopilotSessionCapsuleSchema,
  autopilotCorrelationMatches,
  type AutopilotAdoptionReceipt,
  type AutopilotAdoptionRejectionReason,
  type AutopilotCorrelation,
  type AutopilotMutationResult,
  type AutopilotSessionCapsule,
  type AutopilotWorkflow,
} from '@jinn-network/sdk/autopilot';
import { readAttemptManifest, type AttemptManifest } from './attempt-workspace.js';
import {
  publishAdoptionReceipt,
  type AdoptionReceiptExactFacts,
  type AdoptionReceiptPorts,
} from './marketplace-adoption-receipt.js';
import { transitionMarketplaceAdoption } from './marketplace-adoption-state.js';
import type { VerifiedSolutionObservation } from './marketplace-delivery.js';
import { observeMarketplaceSolutionDelivery } from './marketplace-delivery.js';
import type {
  MarketplaceArtifactEvidence,
  MarketplaceCompletionEvidence,
  MarketplaceHostCommitEvidence,
  MarketplaceReceiptEvidence,
  MarketplaceReviewAnchorEvidence,
  MarketplaceSolutionDeliveryEvidence,
  MarketplaceVerificationEvidence,
} from './marketplace-execution-state.js';
import type {
  MarketplaceMutationCommitIdentity,
  MarketplaceMutationGitPort,
  MarketplaceMutationWorkflow,
} from './marketplace-mutation-git.js';
import {
  MarketplaceVerificationError,
  buildJinnMonoV1VerificationPlan,
  marketplaceVerificationPlanDigest,
  type MarketplaceMutationVerificationPort,
} from './marketplace-mutation-verification.js';
import {
  MarketplacePatchPolicyError,
  validateMarketplacePatch,
  type ValidatedMarketplacePatch,
} from './marketplace-patch.js';
import type {
  MarketplaceReviewAnchorOrigin,
  MarketplaceReviewAnchorPort,
} from './marketplace-review-anchor.js';
import type { ImplementationSessionProtocol } from './implementation-session.js';
import { gitOid, type BranchClaim, type GitOid } from './types.js';

export type MarketplaceMutationAdoptionResult =
  | {
      readonly status: 'accepted';
      readonly receipt: AutopilotAdoptionReceipt;
      readonly resultingHead: GitOid;
      readonly reviewAnchor: MarketplaceReviewAnchorEvidence;
    }
  | {
      readonly status: 'rejected';
      readonly reason: AutopilotAdoptionRejectionReason;
      readonly receipt: AutopilotAdoptionReceipt;
    }
  | { readonly status: 'recoverable'; readonly stage: string; readonly detail: string };

export interface MarketplaceMutationAdoptionCoordinator {
  adopt(manifestPath: string): Promise<MarketplaceMutationAdoptionResult>;
}

export type MarketplaceMutationAdoptionBoundary =
  | 'observation-persisted'
  | 'patch-applied'
  | 'verification-persisted'
  | 'host-commit-created'
  | 'checkpoint-published'
  | 'completion-confirmed'
  | 'review-anchor-published'
  | 'receipt-comment-created'
  | 'receipt-persisted';

export interface MarketplaceMutationAuthority {
  readonly manifest: AttemptManifest;
  readonly remoteHead: GitOid;
  readonly latestClaimOid: GitOid;
  readonly latestClaim: BranchClaim;
  readonly pullRequest: {
    readonly number: number;
    readonly head: GitOid;
    readonly headRefName: string;
    readonly baseRefName: string;
    readonly open: boolean;
    readonly draft: boolean;
    readonly labels: readonly string[];
    readonly implementationSummary?: string;
    readonly canonicalIssueNumber: number;
    readonly mappingStatus: 'resolved' | 'ambiguous' | 'missing';
    readonly humanActive: boolean;
    readonly codeOwnerRequired: boolean;
  };
  readonly child?: {
    readonly number: number;
    readonly parentPrNumber: number;
    readonly kind: 'review-finding' | 'reconcile' | 'ci-failure';
    readonly open: boolean;
  };
  readonly receiptAuthors: readonly string[];
}

export interface MarketplaceMutationAuthorityPort {
  readExactAuthority(input: {
    readonly manifestPath: string;
    readonly touchedPaths: readonly string[];
  }): Promise<MarketplaceMutationAuthority>;
}

export interface MarketplaceMutationAdoptionDependencies {
  readonly observe: typeof observeMarketplaceSolutionDelivery;
  readonly readAuthority: MarketplaceMutationAuthorityPort;
  readonly validatePatch: typeof validateMarketplacePatch;
  readonly applyPatch: (input: {
    readonly artifact: Uint8Array;
    readonly manifestPath: string;
    readonly worktreePath: string;
    readonly expectedHead: GitOid;
  }) => Promise<ValidatedMarketplacePatch>;
  readonly git: MarketplaceMutationGitPort;
  readonly verification: MarketplaceMutationVerificationPort;
  readonly implementation: ImplementationSessionProtocol;
  readonly reviewAnchors: MarketplaceReviewAnchorPort;
  readonly receipts: AdoptionReceiptPorts;
  readonly transition: typeof transitionMarketplaceAdoption;
  readonly now?: () => Date;
  readonly onBoundary?: (
    boundary: MarketplaceMutationAdoptionBoundary,
  ) => Promise<void> | void;
}

interface ParsedObservation {
  readonly observation: VerifiedSolutionObservation;
  readonly session: AutopilotSessionCapsule;
  readonly result: AutopilotMutationResult;
  readonly correlation: AutopilotCorrelation;
  readonly patch?: ValidatedMarketplacePatch;
  readonly artifact?: Uint8Array;
}

interface StableFailure {
  readonly reason: AutopilotAdoptionRejectionReason;
  readonly detail: string;
}

type PureValidation =
  | { readonly ok: true; readonly parsed: ParsedObservation }
  | {
      readonly ok: false;
      readonly failure: StableFailure;
      readonly parsed: Omit<ParsedObservation, 'patch' | 'artifact'>;
    };

interface AdoptionProgress {
  readonly delivery: MarketplaceSolutionDeliveryEvidence;
  readonly artifact?: MarketplaceArtifactEvidence;
  readonly verification?: MarketplaceVerificationEvidence;
  readonly hostCommit?: MarketplaceHostCommitEvidence;
  readonly completion?: MarketplaceCompletionEvidence;
  readonly reviewAnchor?: MarketplaceReviewAnchorEvidence;
  readonly receipt?: MarketplaceReceiptEvidence;
}

const SOLUTION_ADOPTION_RESERVE_MS = 30 * 60 * 1000;
const MAX_RECEIPT_DETAIL_BYTES = 8 * 1024;

function nowFn(deps: MarketplaceMutationAdoptionDependencies): () => Date {
  return deps.now ?? (() => new Date());
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAdoptionCrashInjection(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('crash after ');
}

function receiptSafeDetail(detail: string): string {
  const sanitized = detail.replaceAll('\u0000', '\ufffd');
  const source = sanitized.length === 0
    ? 'Unspecified marketplace adoption failure'
    : sanitized;
  const encoder = new TextEncoder();
  if (encoder.encode(source).byteLength <= MAX_RECEIPT_DETAIL_BYTES) return source;
  const suffix = '\n… [truncated for adoption receipt]';
  const available = MAX_RECEIPT_DETAIL_BYTES - encoder.encode(suffix).byteLength;
  let truncated = '';
  let bytes = 0;
  for (const character of source) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > available) break;
    truncated += character;
    bytes += size;
  }
  return `${truncated}${suffix}`;
}

function observationFileDigest(path: string): string {
  const bytes = readFileSync(path);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function readObservationFile(path: string): VerifiedSolutionObservation {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (
    typeof raw !== 'object'
    || raw === null
    || (raw as { readonly status?: unknown }).status !== 'verified'
    || (raw as { readonly role?: unknown }).role !== 'solution'
  ) {
    throw new Error('Marketplace Solution observation file is invalid');
  }
  return raw as VerifiedSolutionObservation;
}

function expectedCorrelation(
  observation: VerifiedSolutionObservation,
  session: AutopilotSessionCapsule,
): AutopilotCorrelation {
  return AutopilotCorrelationSchema.parse({
    taskId: observation.task.taskId,
    attemptIndex: observation.attempt.attemptIndex,
    requestId: observation.attempt.requestId,
    deliveryEnvelopeCid: observation.delivery.envelopeCid,
    v2AttemptId: session.v2AttemptId,
    claimOid: session.claimOid,
    prNumber: session.prNumber,
    expectedHead: session.expectedHead,
  });
}

function baseParsedObservation(
  observation: VerifiedSolutionObservation,
): Omit<ParsedObservation, 'patch' | 'artifact'> {
  const session = AutopilotSessionCapsuleSchema.parse(observation.session);
  const result = AutopilotMutationResultSchema.parse(observation.result);
  return {
    observation,
    session,
    result,
    correlation: expectedCorrelation(observation, session),
  };
}

function deliveryDerivedParsedObservation(
  delivery: MarketplaceSolutionDeliveryEvidence,
): Omit<ParsedObservation, 'patch' | 'artifact'> {
  return {
    observation: {
      status: 'verified',
      role: 'solution',
      task: {
        taskId: delivery.taskId,
        taskCid: delivery.taskCid,
        createdAtBlock: delivery.taskCreationBlock,
        createdAtTx: delivery.taskCreationTransaction,
      },
      attempt: {
        attemptIndex: delivery.attemptIndex,
        requestId: delivery.requestId,
        operator: delivery.solverSafe,
        createdAtBlock: delivery.deliveryBlock,
      },
      delivery: {
        envelopeCid: delivery.deliveryEnvelopeCid,
        envelopeDigest: delivery.deliveryEnvelopeDigest.replace(/^sha256:/, '0x'),
        publisherAgentId: delivery.publisherAgentId,
        transactionHash: delivery.deliveryTransaction,
        blockNumber: delivery.deliveryBlock,
      },
      envelope: {
        cid: delivery.deliveryEnvelopeCid,
        digest: delivery.deliveryEnvelopeDigest.replace(/^sha256:/, '0x'),
        executionSchema: 'jinn.execution.v1',
        solverType: 'jinn-repo.v1',
        role: 'solution',
        participant: {
          safeAddress: delivery.solverSafe,
          agentEoa: delivery.solverAgentEoa,
        },
        signer: delivery.signer,
      },
      session: {} as AutopilotSessionCapsule,
      result: {} as AutopilotMutationResult,
      correlation: delivery.correlation,
    } as VerifiedSolutionObservation,
    session: {} as AutopilotSessionCapsule,
    result: {} as AutopilotMutationResult,
    correlation: delivery.correlation,
  };
}

function pureValidateObservation(
  observation: VerifiedSolutionObservation,
  delivery: MarketplaceSolutionDeliveryEvidence,
  manifest: AttemptManifest,
  validatePatch: typeof validateMarketplacePatch,
): PureValidation {
  let parsed: Omit<ParsedObservation, 'patch' | 'artifact'>;
  try {
    parsed = baseParsedObservation(observation);
  } catch {
    return {
      ok: false,
      parsed: {
        observation,
        session: observation.session as AutopilotSessionCapsule,
        result: observation.result as AutopilotMutationResult,
        correlation: delivery.correlation,
      },
      failure: {
        reason: 'invalid-artifact',
        detail: 'Mutation result or session capsule failed its strict schema',
      },
    };
  }
  const { result, correlation } = parsed;
  if (
    delivery.taskId !== observation.task.taskId
    || delivery.taskCid !== observation.task.taskCid
    || delivery.attemptIndex !== observation.attempt.attemptIndex
    || delivery.requestId !== observation.attempt.requestId
    || delivery.deliveryEnvelopeCid !== observation.delivery.envelopeCid
    || !isDeepStrictEqual(delivery.correlation, observation.correlation)
    || !autopilotCorrelationMatches(correlation, delivery.correlation)
    || !autopilotCorrelationMatches(correlation, result.correlation)
    || observation.session.v2AttemptId !== manifest.attemptId
    || observation.correlation.v2AttemptId !== manifest.attemptId
    || observation.attempt.operator.toLowerCase()
      !== observation.envelope.participant.safeAddress.toLowerCase()
  ) {
    return {
      ok: false,
      parsed,
      failure: {
        reason: 'correlation-mismatch',
        detail: 'Solution observation does not match the durable delivery identity',
      },
    };
  }
  if (result.outcome === 'human') return { ok: true, parsed };
  const artifact = new TextEncoder().encode(
    (result as Extract<AutopilotMutationResult, { outcome: 'mutation-complete' }>).patch,
  );
  try {
    return {
      ok: true,
      parsed: {
        ...parsed,
        artifact,
        patch: validatePatch(artifact),
      },
    };
  } catch (error) {
    if (error instanceof MarketplacePatchPolicyError) {
      return {
        ok: false,
        parsed,
        failure: {
          reason: 'invalid-artifact',
          detail: `Marketplace patch is invalid: ${error.reason}`,
        },
      };
    }
    throw error;
  }
}

function workflowClaimPhase(workflow: AutopilotWorkflow): BranchClaim['phase'] {
  if (workflow === 'implement') return 'implement';
  if (workflow === 'reconcile') return 'reconcile';
  return 'fix';
}

function childKind(
  workflow: AutopilotWorkflow,
): 'review-finding' | 'reconcile' | 'ci-failure' | undefined {
  if (workflow === 'implement') return undefined;
  if (workflow === 'reconcile') return 'reconcile';
  if (workflow === 'ci-failure') return 'ci-failure';
  return 'review-finding';
}

function mutationWorkflow(workflow: AutopilotWorkflow): MarketplaceMutationWorkflow {
  if (workflow === 'implement') return 'implement';
  if (workflow === 'reconcile') return 'reconcile';
  if (workflow === 'ci-failure') return 'ci-failure';
  return 'fix-child';
}

function authorityFailure(
  parsed: ParsedObservation | Omit<ParsedObservation, 'patch' | 'artifact'>,
  authority: MarketplaceMutationAuthority,
  options: {
    readonly allowHuman: boolean;
    readonly allowClosedChild?: boolean;
    readonly allowAdvancedHead?: boolean;
  },
): StableFailure | null {
  const { session } = parsed;
  const manifest = authority.manifest;
  const claim = authority.latestClaim;
  const expectedIssue = session.workflow === 'implement'
    ? session.issueNumber
    : session.childIssueNumber;
  if (
    manifest.phase !== 'implement'
    || manifest.attemptId !== session.v2AttemptId
    || manifest.issueNumber !== expectedIssue
    || manifest.prNumber !== session.prNumber
    || manifest.branch !== session.branch
    || manifest.targetBase !== session.targetBase
    || manifest.claimOid !== session.claimOid
    || manifest.runnerId !== session.runnerId
    || claim.login.toLowerCase() !== manifest.selectedLogin.toLowerCase()
  ) {
    return {
      reason: 'correlation-mismatch',
      detail: 'Attempt manifest no longer matches the exact delivered session',
    };
  }
  const pullRequest = authority.pullRequest;
  if (
    pullRequest.mappingStatus === 'ambiguous'
    || pullRequest.mappingStatus === 'missing'
    || pullRequest.canonicalIssueNumber !== session.issueNumber
  ) {
    return {
      reason: pullRequest.mappingStatus === 'ambiguous' ? 'policy-human' : 'correlation-mismatch',
      detail: 'Pull request mapping no longer matches the session capsule',
    };
  }
  if (
    manifest.processState !== 'running'
  ) {
    return {
      reason: 'stale-claim',
      detail: 'Marketplace attempt is no longer running',
    };
  }
  if (
    claim.phase !== workflowClaimPhase(session.workflow)
    || claim.issueNumber !== manifest.issueNumber
    || claim.prNumber !== session.prNumber
    || claim.attempt !== session.v2AttemptId
    || claim.runner !== session.runnerId
    || claim.targetBase !== session.targetBase
    || (
      claim.phaseComplete === true
        ? authority.latestClaimOid !== authority.remoteHead
        : authority.latestClaimOid !== manifest.claimOid
    )
  ) {
    return {
      reason: 'stale-claim',
      detail: 'Implementation attempt no longer owns the exact claim',
    };
  }
  if (
    (!options.allowAdvancedHead && authority.remoteHead !== session.expectedHead)
    || pullRequest.head !== authority.remoteHead
    || pullRequest.headRefName !== session.branch
    || pullRequest.baseRefName !== session.targetBase
    || !pullRequest.open
    || pullRequest.number !== session.prNumber
  ) {
    return {
      reason: 'stale-head',
      detail: 'Current branch or pull request head changed',
    };
  }
  const expectedChildKind = childKind(session.workflow);
  if (
    expectedChildKind === undefined
      ? authority.child !== undefined
      : authority.child === undefined
        || authority.child.number !== session.childIssueNumber
        || authority.child.parentPrNumber !== session.parentPrNumber
        || authority.child.kind !== expectedChildKind
        || (!options.allowClosedChild && !authority.child.open)
  ) {
    return {
      reason: 'correlation-mismatch',
      detail: 'Child/parent workflow facts no longer match the session capsule',
    };
  }
  if (
    pullRequest.codeOwnerRequired
    || (!options.allowHuman && pullRequest.humanActive)
  ) {
    return {
      reason: 'policy-human',
      detail: 'Marketplace v1 excludes Human and CODEOWNER surfaces',
    };
  }
  if (!sameReceiptAuthors(authority.receiptAuthors, session.receiptAuthors)) {
    return {
      reason: 'untrusted-operator',
      detail: 'Receipt-author policy does not authorize this delivery',
    };
  }
  return null;
}

function sameReceiptAuthors(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalize = (values: readonly string[]) =>
    [...new Set(values.map((value) => value.trim().toLowerCase()))].sort();
  const a = normalize(left);
  const b = normalize(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function progressFromManifest(manifest: AttemptManifest): AdoptionProgress | null {
  if (manifest.execution.backend !== 'marketplace') return null;
  const state = manifest.execution.state;
  if (state.schemaVersion !== 'marketplace-execution-v3') return null;
  if (state.status === 'receipt-published') {
    return { ...state.progress, receipt: state.receipt };
  }
  if (state.status === 'submitted') return null;
  if (
    state.status !== 'solution-observed'
    && state.status !== 'solution-verified'
    && state.status !== 'host-committed'
    && state.status !== 'lifecycle-completed'
    && state.status !== 'review-anchored'
  ) {
    return null;
  }
  return {
    delivery: state.delivery,
    ...('artifact' in state ? { artifact: state.artifact } : {}),
    ...('verification' in state ? { verification: state.verification } : {}),
    ...('hostCommit' in state ? { hostCommit: state.hostCommit } : {}),
    ...('completion' in state ? { completion: state.completion } : {}),
    ...('reviewAnchor' in state ? { reviewAnchor: state.reviewAnchor } : {}),
  };
}

function adoptionCutoff(session: AutopilotSessionCapsule): number {
  return Date.parse(session.deadline) + SOLUTION_ADOPTION_RESERVE_MS;
}

function rejectedReceipt(
  parsed: ParsedObservation | Omit<ParsedObservation, 'patch' | 'artifact'>,
  failure: StableFailure,
  now: () => Date,
): AutopilotAdoptionReceipt {
  return AutopilotAdoptionReceiptSchema.parse({
    schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
    disposition: 'rejected',
    role: 'solution',
    reason: failure.reason,
    detail: receiptSafeDetail(failure.detail),
    ...parsed.correlation,
    recordedAt: now().toISOString(),
  });
}

function acceptedReceipt(
  parsed: ParsedObservation,
  operation: 'implementation-complete' | 'child-complete',
  resultingHead: GitOid,
  reviewAnchor: MarketplaceReviewAnchorEvidence,
  now: () => Date,
): AutopilotAdoptionReceipt {
  return AutopilotAdoptionReceiptSchema.parse({
    schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
    disposition: 'accepted',
    role: 'solution',
    operation,
    ...parsed.correlation,
    resultingHead,
    reviewGeneration: reviewAnchor.generation,
    reviewRefOid: reviewAnchor.refOid,
    recordedAt: now().toISOString(),
  });
}

function rejectedFacts(
  parsed: ParsedObservation | Omit<ParsedObservation, 'patch' | 'artifact'>,
  authority: MarketplaceMutationAuthority,
  reason: AutopilotAdoptionRejectionReason,
): AdoptionReceiptExactFacts {
  return {
    role: 'solution',
    correlation: parsed.correlation,
    prNumber: authority.pullRequest.number,
    publicationHead: authority.pullRequest.head,
    receiptAuthors: authority.receiptAuthors,
    disposition: 'rejected',
    reason,
  };
}

function acceptedFacts(
  parsed: ParsedObservation,
  authority: MarketplaceMutationAuthority,
  resultingHead: GitOid,
  reviewAnchor: MarketplaceReviewAnchorEvidence,
): AdoptionReceiptExactFacts {
  return {
    role: 'solution',
    correlation: parsed.correlation,
    prNumber: authority.pullRequest.number,
    publicationHead: authority.pullRequest.head,
    receiptAuthors: authority.receiptAuthors,
    disposition: 'accepted',
    resultingHead,
    expectedReview: {
      generation: reviewAnchor.generation,
      refOid: reviewAnchor.refOid,
    },
  };
}

async function readAuthority(
  manifestPath: string,
  touchedPaths: readonly string[],
  deps: MarketplaceMutationAdoptionDependencies,
): Promise<MarketplaceMutationAuthority> {
  return deps.readAuthority.readExactAuthority({ manifestPath, touchedPaths });
}

async function requireHumanAuthority(
  _parsed: ParsedObservation | Omit<ParsedObservation, 'patch' | 'artifact'>,
  authority: MarketplaceMutationAuthority,
  detail: string,
  deps: MarketplaceMutationAdoptionDependencies,
  touchedPaths: readonly string[],
): Promise<MarketplaceMutationAuthority> {
  await deps.implementation.human(authority.manifest, detail);
  const readback = await readAuthority(
    authority.manifest.paths.manifest,
    touchedPaths,
    deps,
  );
  if (!readback.pullRequest.humanActive) {
    throw new Error('Human hold did not read back durably');
  }
  return readback;
}

async function stableReject(
  parsed: ParsedObservation | Omit<ParsedObservation, 'patch' | 'artifact'>,
  failure: StableFailure,
  authority: MarketplaceMutationAuthority,
  deps: MarketplaceMutationAdoptionDependencies,
  touchedPaths: readonly string[],
  reviewAnchor?: MarketplaceReviewAnchorEvidence,
): Promise<MarketplaceMutationAdoptionResult> {
  let publicationAuthority = authority;
  if (failure.reason === 'receipt-contradiction') {
    publicationAuthority = await requireHumanAuthority(
      parsed,
      authority,
      failure.detail,
      deps,
      touchedPaths,
    );
  }
  const receipt = rejectedReceipt(parsed, failure, nowFn(deps));
  const facts = rejectedFacts(parsed, publicationAuthority, failure.reason);
  try {
    const publication = await publishAdoptionReceipt(facts, receipt, deps.receipts);
    await deps.onBoundary?.('receipt-persisted');
    const publicationExecution = publicationAuthority.manifest.execution;
    const publicationRequestDigest =
      publicationExecution.backend === 'marketplace'
      && publicationExecution.state.schemaVersion === 'marketplace-execution-v3'
        ? publicationExecution.state.requestDigest
        : '';
    await deps.transition(
      publicationAuthority.manifest.paths.manifest,
      publicationRequestDigest,
      {
        status: 'receipt-published',
        receipt: {
          receipt,
          commentId: publication.commentId,
          author: publication.author,
          recordedAt: receipt.recordedAt,
        },
      },
      nowFn(deps),
    );
    if (reviewAnchor !== undefined) {
      await deps.reviewAnchors.release(reviewAnchor);
    }
    return { status: 'rejected', reason: failure.reason, receipt };
  } catch (error) {
    if (isAdoptionCrashInjection(error)) throw error;
    if (failure.reason !== 'receipt-contradiction') {
      await requireHumanAuthority(parsed, authority, errorDetail(error), deps, touchedPaths);
    }
    if (reviewAnchor !== undefined) {
      await deps.reviewAnchors.release(reviewAnchor);
    }
    return {
      status: 'rejected',
      reason: 'receipt-contradiction',
      receipt: rejectedReceipt(parsed, {
        reason: 'receipt-contradiction',
        detail: errorDetail(error),
      }, nowFn(deps)),
    };
  }
}

function artifactEvidence(
  patch: ValidatedMarketplacePatch,
  expectedTree: GitOid,
): MarketplaceArtifactEvidence {
  return {
    digest: patch.artifactDigest,
    byteLength: patch.byteLength,
    touchedPaths: patch.touchedPaths,
    expectedTree,
  };
}

function verificationMatches(
  stored: MarketplaceVerificationEvidence,
  artifact: MarketplaceArtifactEvidence,
  verification: MarketplaceVerificationEvidence,
): boolean {
  return stored.profile === verification.profile
    && stored.artifactDigest === artifact.digest
    && stored.expectedTree === artifact.expectedTree
    && stored.planDigest === verification.planDigest
    && isDeepStrictEqual(stored.commands, verification.commands);
}

function boundVerificationReusable(
  stored: MarketplaceVerificationEvidence | undefined,
  artifact: MarketplaceArtifactEvidence,
  session: AutopilotSessionCapsule,
  patch: ValidatedMarketplacePatch,
  repositoryPath: string,
): boolean {
  if (stored === undefined) return false;
  try {
    const plan = buildJinnMonoV1VerificationPlan({
      repositoryPath,
      touchedPaths: patch.touchedPaths,
    });
    return verificationMatches(stored, artifact, {
      profile: session.verificationProfile as MarketplaceVerificationEvidence['profile'],
      artifactDigest: artifact.digest,
      expectedTree: artifact.expectedTree,
      planDigest: marketplaceVerificationPlanDigest(plan),
      commands: stored.commands,
      verifiedAt: stored.verifiedAt,
    });
  } catch {
    return false;
  }
}

function completionReadbackFailure(
  parsed: ParsedObservation,
  authority: MarketplaceMutationAuthority,
  resultingHead: GitOid,
): StableFailure | null {
  if (
    authority.remoteHead !== resultingHead
    || authority.pullRequest.head !== resultingHead
  ) {
    return {
      reason: 'stale-head',
      detail: 'Completion did not read back on the exact resulting head',
    };
  }
  if (parsed.session.workflow === 'implement') {
    if (
      authority.latestClaim.phaseComplete !== true
      || authority.latestClaimOid !== resultingHead
      || authority.pullRequest.draft
      || !authority.pullRequest.labels.includes('engine:review')
      || authority.pullRequest.implementationSummary?.trim()
        !== (parsed.result.outcome === 'mutation-complete'
          ? parsed.result.summary.trim()
          : '')
    ) {
      return {
        reason: 'receipt-contradiction',
        detail: 'Implementation completion did not converge durably',
      };
    }
    return null;
  }
  if (authority.child?.open !== false) {
    return {
      reason: 'receipt-contradiction',
      detail: 'Child completion did not close the exact child',
    };
  }
  return null;
}

function buildCompletionEvidence(
  parsed: ParsedObservation,
  authority: MarketplaceMutationAuthority,
  resultingHead: GitOid,
  checkpointOid: GitOid,
  now: () => Date,
): MarketplaceCompletionEvidence {
  if (parsed.session.workflow === 'implement') {
    return {
      operation: 'implementation-complete',
      prNumber: authority.pullRequest.number,
      branch: authority.pullRequest.headRefName,
      claimOid: gitOid(authority.manifest.claimOid),
      checkpointOid,
      resultingHead,
      lifecycleStatus: 'In Review',
      confirmedAt: now().toISOString(),
    };
  }
  return {
    operation: 'child-complete',
    childIssueNumber: authority.child!.number,
    parentPrNumber: authority.child!.parentPrNumber,
    parentBranch: authority.pullRequest.headRefName,
    claimOid: gitOid(authority.manifest.claimOid),
    checkpointOid,
    resultingHead,
    childClosed: true,
    lifecycleStatus: 'In Review',
    confirmedAt: now().toISOString(),
  };
}

function reviewOrigin(
  manifestPath: string,
  requestDigest: string,
  delivery: MarketplaceSolutionDeliveryEvidence,
): MarketplaceReviewAnchorOrigin {
  return {
    originManifestPath: manifestPath,
    originV2AttemptId: delivery.correlation.v2AttemptId,
    originRequestDigest: requestDigest,
    taskId: delivery.taskId,
    taskCid: delivery.taskCid,
    taskCreationBlock: delivery.taskCreationBlock,
    correlation: delivery.correlation,
  };
}

function commitIdentity(
  parsed: ParsedObservation,
  authority: MarketplaceMutationAuthority,
  artifact: Uint8Array,
  patch: ValidatedMarketplacePatch,
): MarketplaceMutationCommitIdentity {
  const session = parsed.session;
  const childIssueNumber = session.workflow === 'implement'
    ? undefined
    : session.childIssueNumber;
  return {
    worktreePath: authority.manifest.paths.worktree,
    expectedHead: session.expectedHead as GitOid,
    artifact,
    artifactDigest: patch.artifactDigest,
    workflow: mutationWorkflow(session.workflow),
    touchedPaths: patch.touchedPaths,
    summary: parsed.result.outcome === 'mutation-complete' ? parsed.result.summary : '',
    taskId: parsed.observation.task.taskId,
    requestId: parsed.observation.attempt.requestId,
    deliveryEnvelopeCid: parsed.observation.delivery.envelopeCid,
    v2AttemptId: session.v2AttemptId,
    ...(childIssueNumber === undefined ? {} : { childIssueNumber }),
    ...(session.workflow === 'reconcile'
      ? { reconcileBase: session.taskSnapshot.targetBaseOid as GitOid }
      : {}),
  };
}

async function adoptManifest(
  manifestPath: string,
  deps: MarketplaceMutationAdoptionDependencies,
): Promise<MarketplaceMutationAdoptionResult> {
  const now = nowFn(deps);
  let manifest = readAttemptManifest(manifestPath);
  if (manifest.execution.backend !== 'marketplace') {
    throw new Error('Only marketplace attempts may adopt Solution delivery');
  }
  const state = manifest.execution.state;
  if (state.schemaVersion !== 'marketplace-execution-v3') {
    throw new Error('Marketplace mutation adoption requires marketplace execution v3');
  }
  const requestDigest = state.requestDigest;

  if (state.status === 'receipt-published') {
    const receipt = state.receipt.receipt;
    if (receipt.disposition === 'accepted') {
      const progress = state.progress;
      if (progress.status !== 'review-anchored') {
        throw new Error('Accepted marketplace receipt is missing review anchor progress');
      }
      return {
        status: 'accepted',
        receipt,
        resultingHead: gitOid(receipt.resultingHead!),
        reviewAnchor: progress.reviewAnchor,
      };
    }
    return {
      status: 'rejected',
      reason: receipt.reason,
      receipt,
    };
  }

  let progress = progressFromManifest(manifest);
  if (state.status === 'submitted') {
    const observed = await deps.observe(manifestPath);
    if (observed.status === 'pending') {
      return {
        status: 'recoverable',
        stage: 'observation',
        detail: observed.detail ?? observed.reason,
      };
    }
    if (observed.status === 'contradiction') {
      return {
        status: 'recoverable',
        stage: 'observation',
        detail: observed.detail,
      };
    }
    manifest = readAttemptManifest(manifestPath);
    progress = progressFromManifest(manifest);
    await deps.onBoundary?.('observation-persisted');
  }
  if (progress === null) {
    return {
      status: 'recoverable',
      stage: 'observation',
      detail: 'Marketplace Solution observation is not yet durable',
    };
  }

  const observationPath = progress.delivery.observationPath;
  if (observationFileDigest(observationPath) !== progress.delivery.observationDigest) {
    const mismatchParsed = deliveryDerivedParsedObservation(progress.delivery);
    const mismatchAuthority = await readAuthority(manifestPath, [], deps);
    return stableReject(mismatchParsed, {
      reason: 'correlation-mismatch',
      detail: 'Solution observation bytes do not match the durable digest',
    }, mismatchAuthority, deps, []);
  }
  const observation = readObservationFile(observationPath);
  const validation = pureValidateObservation(
    observation,
    progress.delivery,
    manifest,
    deps.validatePatch,
  );
  const touchedPaths = validation.ok && validation.parsed.patch !== undefined
    ? validation.parsed.patch.touchedPaths
    : [];
  let authority = await readAuthority(manifestPath, touchedPaths, deps);
  if (!validation.ok) {
    return stableReject(validation.parsed, validation.failure, authority, deps, touchedPaths);
  }
  const parsed = validation.parsed;
  const session = parsed.session;
  const cutoff = adoptionCutoff(session);
  const deadlineExceeded = () => !Number.isFinite(cutoff) || now().getTime() >= cutoff;

  let failure = authorityFailure(parsed, authority, {
    allowHuman: parsed.result.outcome === 'human',
    allowClosedChild: true,
    allowAdvancedHead: progress.hostCommit !== undefined,
  });
  if (failure !== null) {
    return stableReject(parsed, failure, authority, deps, touchedPaths);
  }

  if (parsed.result.outcome === 'human') {
    authority = await requireHumanAuthority(
      parsed,
      authority,
      `${parsed.result.reason.code}: ${parsed.result.reason.detail}`,
      deps,
      touchedPaths,
    );
    return stableReject(parsed, {
      reason: 'policy-human',
      detail: parsed.result.reason.detail,
    }, authority, deps, touchedPaths);
  }

  const patch = parsed.patch!;
  const artifact = parsed.artifact!;
  const identity = commitIdentity(parsed, authority, artifact, patch);
  let gitState = await deps.git.readState(identity);
  if (gitState.status === 'contradiction') {
    return stableReject(parsed, {
      reason: 'receipt-contradiction',
      detail: gitState.detail,
    }, authority, deps, touchedPaths);
  }
  const recoveringDurableEffects =
    gitState.status === 'committed'
    || progress.hostCommit !== undefined
    || progress.completion !== undefined;
  if (deadlineExceeded() && !recoveringDurableEffects) {
    return stableReject(parsed, {
      reason: 'internal-adoption-failure',
      detail: 'solution-adoption-deadline-exceeded',
    }, authority, deps, touchedPaths);
  }
  if (
    parsed.session.workflow !== 'implement'
    && authority.child?.open === false
    && gitState.status !== 'committed'
    && progress.hostCommit === undefined
  ) {
    return stableReject(parsed, {
      reason: 'stale-claim',
      detail:
        'Child is already closed without an exact recoverable marketplace host commit',
    }, authority, deps, touchedPaths);
  }

  let artifactRecord = progress.artifact;
  let verificationRecord = progress.verification;
  if (gitState.status === 'clean' && progress.hostCommit === undefined) {
    try {
      const applied = await deps.applyPatch({
        artifact,
        manifestPath,
        worktreePath: authority.manifest.paths.worktree,
        expectedHead: session.expectedHead as GitOid,
      });
      if (
        applied.artifactDigest !== patch.artifactDigest
        || !isDeepStrictEqual(applied.touchedPaths, patch.touchedPaths)
      ) {
        return stableReject(parsed, {
          reason: 'receipt-contradiction',
          detail: 'Applied patch readback differs from pure validation',
        }, authority, deps, touchedPaths);
      }
    } catch (error) {
      if (error instanceof MarketplacePatchPolicyError) {
        const reason = error.reason === 'git-check-failed' || error.reason === 'git-apply-failed'
          ? 'patch-does-not-apply'
          : 'invalid-artifact';
        return stableReject(parsed, {
          reason,
          detail: error.message,
        }, authority, deps, touchedPaths);
      }
      throw error;
    }
    await deps.onBoundary?.('patch-applied');
    gitState = await deps.git.readState(identity);
  }
  if (gitState.status === 'clean') {
    return stableReject(parsed, {
      reason: 'invalid-artifact',
      detail: 'Marketplace patch produced no real tree change',
    }, authority, deps, touchedPaths);
  }
  if (gitState.status === 'contradiction') {
    return stableReject(parsed, {
      reason: 'receipt-contradiction',
      detail: gitState.detail,
    }, authority, deps, touchedPaths);
  }

  if (progress.hostCommit === undefined) {
    if (gitState.status === 'pending' || gitState.status === 'committed') {
      const expectedTree = gitState.expectedTree;
      artifactRecord = progress.artifact ?? artifactEvidence(patch, expectedTree);
      const needsVerification = !boundVerificationReusable(
        progress.verification,
        artifactRecord,
        session,
        patch,
        authority.manifest.paths.worktree,
      );
      if (gitState.status === 'pending' && needsVerification) {
        if (deadlineExceeded()) {
          return stableReject(parsed, {
            reason: 'internal-adoption-failure',
            detail: 'solution-adoption-deadline-exceeded',
          }, authority, deps, touchedPaths);
        }
        try {
          verificationRecord = await deps.verification.verify({
            profile: 'jinn-mono.v1',
            repositoryPath: authority.manifest.paths.worktree,
            touchedPaths: patch.touchedPaths,
            artifactDigest: patch.artifactDigest,
            expectedTree,
            deadline: new Date(cutoff).toISOString(),
          });
        } catch (error) {
          if (error instanceof MarketplaceVerificationError) {
            if (error.disposition === 'stable-rejection') {
              const reason = error.reason === 'unsupported-path'
                  || error.reason === 'unnormalized-path'
                  || error.reason === 'empty-selection'
                ? 'invalid-artifact'
                : 'verification-failed';
              return stableReject(parsed, {
                reason,
                detail: error.message,
              }, authority, deps, touchedPaths);
            }
            if (error.disposition === 'abandoned') {
              return stableReject(parsed, {
                reason: 'internal-adoption-failure',
                detail: 'solution-adoption-deadline-exceeded',
              }, authority, deps, touchedPaths);
            }
            return {
              status: 'recoverable',
              stage: 'verification',
              detail: error.message,
            };
          }
          throw error;
        }
        await deps.onBoundary?.('verification-persisted');
        deps.transition(
          manifestPath,
          requestDigest,
          {
            status: 'solution-verified',
            artifact: artifactRecord,
            verification: verificationRecord,
          },
          now,
        );
        manifest = readAttemptManifest(manifestPath);
        progress = progressFromManifest(manifest)!;
        verificationRecord = progress.verification;
      } else {
        verificationRecord = progress.verification;
      }
      if (deadlineExceeded() && gitState.status === 'pending') {
        return stableReject(parsed, {
          reason: 'internal-adoption-failure',
          detail: 'solution-adoption-deadline-exceeded',
        }, authority, deps, touchedPaths);
      }
      if (progress.hostCommit === undefined) {
        authority = await readAuthority(manifestPath, touchedPaths, deps);
        failure = authorityFailure(parsed, authority, {
          allowHuman: false,
          allowClosedChild: true,
          allowAdvancedHead: progress.hostCommit !== undefined,
        });
        if (failure !== null) return stableReject(parsed, failure, authority, deps, touchedPaths);
        const hostCommit = gitState.status === 'committed'
          ? gitState.commit
          : await deps.git.commit(identity);
        await deps.onBoundary?.('host-commit-created');
        deps.transition(
          manifestPath,
          requestDigest,
          { status: 'host-committed', hostCommit },
          now,
        );
        manifest = readAttemptManifest(manifestPath);
        progress = progressFromManifest(manifest)!;
        gitState = { status: 'committed', expectedTree: hostCommit.tree, commit: hostCommit };
      }
    }
  }

  const hostCommit = progress.hostCommit ?? (
    gitState.status === 'committed' ? gitState.commit : undefined
  );
  if (hostCommit === undefined) {
    return {
      status: 'recoverable',
      stage: 'host-commit',
      detail: 'Marketplace host commit is not yet durable',
    };
  }

  authority = await readAuthority(manifestPath, touchedPaths, deps);
  if (parsed.session.workflow === 'implement' && progress.completion === undefined) {
    if (authority.latestClaim.phaseComplete !== true) {
      const checkpoint = await deps.implementation.checkpoint(authority.manifest);
      if (checkpoint.status === 'stale' || checkpoint.status === 'ambiguous') {
        return stableReject(parsed, {
          reason: 'stale-head',
          detail: 'Checkpoint lost the exact head fence',
        }, authority, deps, touchedPaths);
      }
      await deps.onBoundary?.('checkpoint-published');
      authority = await readAuthority(manifestPath, touchedPaths, deps);
    }
  } else if (parsed.session.workflow !== 'implement' && progress.completion === undefined) {
    const checkpoint = await deps.implementation.checkpoint(authority.manifest);
    if (checkpoint.status === 'stale' || checkpoint.status === 'ambiguous') {
      return stableReject(parsed, {
        reason: 'stale-head',
        detail: 'Checkpoint lost the exact head fence',
      }, authority, deps, touchedPaths);
    }
    await deps.onBoundary?.('checkpoint-published');
    authority = await readAuthority(manifestPath, touchedPaths, deps);
  }

  let resultingHead: GitOid;
  let operation: 'implementation-complete' | 'child-complete';
  if (progress.completion !== undefined) {
    resultingHead = progress.completion.resultingHead;
    operation = progress.completion.operation;
  } else if (parsed.session.workflow === 'implement') {
    operation = 'implementation-complete';
    if (authority.latestClaim.phaseComplete === true) {
      resultingHead = authority.remoteHead;
    } else {
      const completed = await deps.implementation.implementationComplete(
        authority.manifest,
        parsed.result.summary,
      );
      if (completed.status !== 'complete') {
        if (completed.pending === 'hold') {
          return stableReject(parsed, {
            reason: 'policy-human',
            detail: 'Implementation completion entered a Human hold',
          }, authority, deps, touchedPaths);
        }
        return {
          status: 'recoverable',
          stage: 'implementation-complete',
          detail: completed.detail ?? `pending ${completed.pending}`,
        };
      }
      resultingHead = completed.head;
    }
  } else {
    operation = 'child-complete';
    resultingHead = hostCommit.head;
    if (authority.child?.open !== false) {
      if (deps.implementation.childComplete === undefined) {
        throw new Error('Existing child-complete protocol is unavailable');
      }
      const completed = await deps.implementation.childComplete(authority.manifest);
      if (completed.status !== 'closed') {
        return stableReject(parsed, {
          reason: 'receipt-contradiction',
          detail: completed.detail ?? 'Child completion was rejected',
        }, authority, deps, touchedPaths, progress.reviewAnchor);
      }
    }
  }
  await deps.onBoundary?.('completion-confirmed');
  authority = await readAuthority(manifestPath, touchedPaths, deps);
  failure = authorityFailure(parsed, authority, {
    allowHuman: false,
    allowClosedChild: true,
    allowAdvancedHead: progress.hostCommit !== undefined,
  });
  if (failure !== null) {
    return stableReject(parsed, failure, authority, deps, touchedPaths, progress.reviewAnchor);
  }
  failure = completionReadbackFailure(parsed, authority, resultingHead);
  if (failure !== null) {
    return stableReject(parsed, failure, authority, deps, touchedPaths, progress.reviewAnchor);
  }
  if (progress.completion === undefined) {
    const completion = buildCompletionEvidence(
      parsed,
      authority,
      resultingHead,
      hostCommit.head,
      now,
    );
    deps.transition(
      manifestPath,
      requestDigest,
      { status: 'lifecycle-completed', completion },
      now,
    );
    manifest = readAttemptManifest(manifestPath);
    progress = progressFromManifest(manifest)!;
  }

  const acquired = await deps.reviewAnchors.acquireOrRecover({
    origin: reviewOrigin(manifestPath, requestDigest, progress.delivery),
    prNumber: authority.pullRequest.number,
    expectedHead: resultingHead,
  });
  if (acquired.status === 'recoverable') {
    return {
      status: 'recoverable',
      stage: 'review-anchor',
      detail: acquired.detail,
    };
  }
  if (acquired.status === 'rejected' || acquired.status === 'already-approved') {
    return stableReject(parsed, {
      reason: acquired.status === 'already-approved' ? 'receipt-contradiction' : 'policy-human',
      detail: acquired.detail,
    }, authority, deps, touchedPaths);
  }
  let reviewAnchor = acquired.anchor;
  if (
    progress.reviewAnchor !== undefined
    && (
      progress.reviewAnchor.generation !== reviewAnchor.generation
      || progress.reviewAnchor.refOid !== reviewAnchor.refOid
      || progress.reviewAnchor.head !== resultingHead
    )
  ) {
    return stableReject(parsed, {
      reason: 'receipt-contradiction',
      detail: 'Stored review anchor does not match the active exact head',
    }, authority, deps, touchedPaths, reviewAnchor);
  }
  if (progress.reviewAnchor === undefined) {
    await deps.onBoundary?.('review-anchor-published');
    deps.transition(
      manifestPath,
      requestDigest,
      { status: 'review-anchored', reviewAnchor },
      now,
    );
    manifest = readAttemptManifest(manifestPath);
    progress = progressFromManifest(manifest)!;
    reviewAnchor = progress.reviewAnchor!;
  }

  const receipt = acceptedReceipt(parsed, operation, resultingHead, reviewAnchor, now);
  const facts = acceptedFacts(parsed, authority, resultingHead, reviewAnchor);
  try {
    const publication = await publishAdoptionReceipt(facts, receipt, deps.receipts);
    await deps.onBoundary?.('receipt-comment-created');
    const receiptEvidence: MarketplaceReceiptEvidence = {
      receipt,
      commentId: publication.commentId,
      author: publication.author,
      recordedAt: receipt.recordedAt,
    };
    deps.transition(
      manifestPath,
      requestDigest,
      { status: 'receipt-published', receipt: receiptEvidence },
      now,
    );
    await deps.onBoundary?.('receipt-persisted');
    return {
      status: 'accepted',
      receipt,
      resultingHead,
      reviewAnchor,
    };
  } catch (error) {
    if (isAdoptionCrashInjection(error)) throw error;
    return stableReject(parsed, {
      reason: 'receipt-contradiction',
      detail: errorDetail(error),
    }, authority, deps, touchedPaths, reviewAnchor);
  }
}

export function makeMarketplaceMutationAdoptionCoordinator(
  deps: MarketplaceMutationAdoptionDependencies,
): MarketplaceMutationAdoptionCoordinator {
  return {
    async adopt(manifestPath) {
      let stage = 'adoption';
      try {
        return await adoptManifest(manifestPath, deps);
      } catch (error) {
        return {
          status: 'recoverable',
          stage,
          detail: errorDetail(error),
        };
      }
    },
  };
}
