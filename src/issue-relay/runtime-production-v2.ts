import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { authorizeRelayV2Spend } from './budget-v2.js';
import { admitRelayIssue } from './admission.js';
import {
  aggregateRelayChecks,
  createRelayEvaluationAnchorPublisher,
  findRelayEvaluationAnchorBlock,
  relayAdoptionReceiptDigest,
  relayFailedCheckFindings,
  relayRequiredCheckStatus,
} from './checks.js';
import type { IssueRelayConfigV2 } from './config.js';
import {
  IssueRelayRoundV2Schema,
  issueRelayCanonicalDigest,
  issueRelayPullRequestMetadataDigest,
  issueRelayDecisionKey,
  type IssueRelayLaneAttestationV1,
  type IssueRelayLaneFindingV1,
  type IssueRelayRoundV2,
} from './contracts.js';
import { observeRelayHumanDecision } from './decision-observer.js';
import type {
  RelayGitHubProductionAuthorityPort,
} from './github-production.js';
import type {
  RelayGitHubReadPort,
  RelayGitHubWritePort,
} from './github-port.js';
import { createIssueRelayV2GitHubReconciliation } from './github-reconciliation-v2.js';
import { relayBranch, relayGeneration } from './identity.js';
import {
  formatRelayIssueMarkerV2,
  validateRelayIssueMarkerUpdateV2,
} from './markers-v2.js';
import {
  buildRelayEvaluationBundleExpectationV2,
  buildRelaySolutionExpectationV2,
  installVerifiedRelayEvaluationBundleV2,
  installVerifiedRelaySolutionObservationV2,
  persistRelayEvaluationBundleExpectationV2,
  persistRelaySolutionExpectationV2,
  persistRelaySubmissionEvidence,
  readVerifiedRelayObservation,
} from './marketplace-state.js';
import {
  isVerifiedIssueRelayEvaluationBundleV2,
  isVerifiedIssueRelaySolutionV2,
  type IssueRelayMarketplaceCli,
  type RelaySubmissionEvidence,
} from './marketplace-cli.js';
import {
  type RelayDurableArtifactStore,
} from './reconciler.js';
import type {
  RelayReconciliationCandidateV2,
  RelayReconciliationPortV2,
  RelayV2ActionExecutionResult,
} from './reconciler-v2.js';
import {
  relayLaneFromGateV2,
  renderRelayAssuranceV2,
  type RelayAssuranceLaneV2,
} from './report-v2.js';
import {
  aggregateRelayEvaluationV2,
  persistRelayFundingIntentV2,
  publishCriticalSecurityDecisionV2,
  publishRelayDecisionRequestV2,
  queueRelayDecisionV2,
  recordRelayHumanDecisionV2,
  relayRoundV2Capsule,
  type RelayActionV2,
  type RelayGenerationRecordV2,
  type RelayLaneAttemptRecordV2,
  type RelayRoundRecordV2,
} from './state-v2.js';
import {
  blockRelaySecurityV2,
  exhaustRelayGenerationV2,
  finishRelayCancellationV2,
  markRelayReadyV2,
  persistRelayAdoptionV2,
  persistRelayCancellationV2,
  persistRelayChecksV2,
  persistRelayEvaluationAnchorV2,
  persistRelayEvaluationBundleV2,
  persistRelaySolutionDeliveryV2,
  persistRelayTaskSubmissionV2,
  supersedeRelayGenerationV2,
} from './transitions-v2.js';
import {
  buildRelayMarketplaceRequest,
  buildRelayTaskSpecV2,
  persistRelayMarketplaceRequest,
  type RelayTaskSpecV2,
} from './task.js';
import type {
  AcceptedRelayAdoption,
  RelayAdoptionCoordinator,
  VerifiedRelaySolutionObservation,
} from './adoption.js';
import {
  parseRelayAdoptionReceiptBlocks,
} from './git-publisher.js';
import { buildRelaySnapshot, type IssueRelaySnapshotV1 } from './snapshot.js';

const sameName = (left: string, right: string): boolean =>
  left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US');

const digest = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

function snapshotMateriallyChanged(
  current: IssueRelaySnapshotV1,
  next: IssueRelaySnapshotV1,
): boolean {
  const material = (snapshot: IssueRelaySnapshotV1) => ({
    repository: snapshot.repository,
    issue: {
      number: snapshot.issue.number,
      url: snapshot.issue.url,
      title: snapshot.issue.title,
      body: snapshot.issue.body,
      authorLogin: snapshot.issue.authorLogin,
      authorId: snapshot.issue.authorId,
    },
    language: snapshot.language,
    verificationProfile: snapshot.verificationProfile,
    acceptanceEvidence: snapshot.acceptanceEvidence,
    admissionPolicyVersion: snapshot.admissionPolicyVersion,
  });
  return JSON.stringify(material(current)) !== JSON.stringify(material(next));
}

export interface IssueRelayV2ProductionOptions {
  readonly config: IssueRelayConfigV2;
  readonly stateDirectory: string;
  readonly githubRead: RelayGitHubReadPort;
  readonly githubWrite: RelayGitHubWritePort;
  readonly githubAuthority: RelayGitHubProductionAuthorityPort;
  readonly marketplace: IssueRelayMarketplaceCli;
  readonly adopter: RelayAdoptionCoordinator;
  readonly artifacts: RelayDurableArtifactStore;
  readonly now: () => Date;
}

function latestRound(
  record: RelayGenerationRecordV2,
  round: number,
): RelayRoundRecordV2 {
  const durable = record.rounds[round];
  if (durable === undefined || durable.round !== round) {
    throw new Error('Relay V2 round authority is missing');
  }
  return durable;
}

function attemptForHead(
  round: RelayRoundRecordV2,
  lane: 'security' | 'quality',
): RelayLaneAttemptRecordV2 | undefined {
  return [...round.laneAttempts[lane]].reverse().find(({ head }) =>
    head === round.checks?.head);
}

function laneReport(
  round: RelayRoundRecordV2,
  lane: 'security' | 'quality',
): RelayAssuranceLaneV2 {
  const attempt = attemptForHead(round, lane);
  if (attempt === undefined) {
    return { lane, status: 'evaluating', publicSummary: `${lane} evaluation is pending.` };
  }
  const observation = attempt.observation;
  if (observation.schemaVersion === 'jinn-issue-relay-lane-failure.v1') {
    return {
      lane,
      status: 'operator-required',
      publicSummary: observation.publicSummary,
      reviewMethod: lane === 'security' ? 'Claude `/security-review`' : 'Claude `/code-review`',
      evaluatorIdentity: attempt.evaluatorSafe,
      evidenceDigest: attempt.observationDigest,
    };
  }
  const status: RelayAssuranceLaneV2['status'] = observation.outcome.kind === 'pass'
    ? 'passed'
    : observation.outcome.kind === 'changes-required'
      ? 'changes-required'
      : observation.outcome.kind === 'decision-required'
        ? 'decision-required'
        : 'blocked';
  return {
    lane,
    status,
    publicSummary: observation.publicSummary,
    reviewMethod: lane === 'security' ? 'Claude `/security-review`' : 'Claude `/code-review`',
    evaluatorIdentity: attempt.evaluatorSafe,
    evidenceDigest: attempt.observationDigest,
    ...(observation.automatedEvidence === undefined
      ? {}
      : { automatedEvidence: observation.automatedEvidence }),
  };
}

function decisionAttestation(
  record: RelayGenerationRecordV2,
  decisionKey: string,
): { readonly round: RelayRoundRecordV2; readonly attestation: IssueRelayLaneAttestationV1 } {
  const round = record.rounds.at(-1);
  if (round === undefined || round.checks === undefined) {
    throw new Error('Relay V2 decision lacks an evaluated exact head');
  }
  for (const lane of ['security', 'quality'] as const) {
    const attempt = attemptForHead(round, lane);
    const observation = attempt?.observation;
    if (
      observation?.schemaVersion === 'jinn-issue-relay-lane-attestation.v1'
      && observation.outcome.kind === 'decision-required'
      && issueRelayDecisionKey({
        generation: record.generation,
        snapshotDigest: record.snapshot.snapshotDigest,
        proposal: observation.outcome.proposal,
      }) === decisionKey
    ) return { round, attestation: observation };
  }
  throw new Error('Relay V2 decision key does not bind a current-head attestation');
}

/**
 * Wires the V2 pure reconciler to the existing authenticated marketplace,
 * adoption, check, and GitHub mutation boundaries. V1 marker readers and
 * writers remain untouched.
 */
export function createIssueRelayProductionReconciliationV2(
  options: IssueRelayV2ProductionOptions,
): RelayReconciliationPortV2 {
  const roundDirectory = (
    candidate: RelayReconciliationCandidateV2,
    record: RelayGenerationRecordV2,
    round: number,
  ) => {
    const relative = `rounds/${candidate.issueNumber}/`
      + `${record.snapshot.snapshotDigest.slice('sha256:'.length)}/${round}`;
    return { relative, absolute: join(options.stateDirectory, relative) };
  };

  const replaceMarker = async (
    candidate: RelayReconciliationCandidateV2,
    proposed: RelayGenerationRecordV2,
  ): Promise<void> => {
    const commentId = candidate.production?.issueCommentId;
    const expectedBody = candidate.production?.issueCommentBody;
    if (
      commentId === undefined
      || expectedBody === undefined
      || !validateRelayIssueMarkerUpdateV2({ expectedBody, proposed })
    ) throw new Error('Relay V2 marker update lost exact monotonic authority');
    await options.githubAuthority.editIssueCommentExact({
      issueNumber: candidate.issueNumber,
      commentId,
      expectedBody,
      body: formatRelayIssueMarkerV2(proposed),
    });
  };

  const requestDeadline = (
    record: RelayGenerationRecordV2,
    round: RelayRoundRecordV2,
  ): string => {
    if (round.purpose !== 'decision-implementation') return record.executionDeadlineAt;
    const decision = record.decisions.find(({ decisionKey }) =>
      decisionKey === round.decisionBinding?.decisionKey);
    return decision?.continuationDeadlineAt ?? record.executionDeadlineAt;
  };

  const taskForRound = (
    record: RelayGenerationRecordV2,
    round: RelayRoundRecordV2,
  ): RelayTaskSpecV2 => buildRelayTaskSpecV2({
    snapshot: record.snapshot,
    round: relayRoundV2Capsule(record, round),
    ...(round.purpose === 'initial' ? {} : {
      hostAuthority: {
        managedFork: true,
        workspaceRepository: round.workspaceRepository,
        visibility: 'PUBLIC',
        prNumber: round.prNumber!,
        currentHead: round.inputHead,
      } as const,
    }),
  });

  const prepareRequest = async (input: {
    readonly candidate: RelayReconciliationCandidateV2;
    readonly record: RelayGenerationRecordV2;
    readonly round: RelayRoundRecordV2;
    readonly task: RelayTaskSpecV2;
    readonly createdAt: string;
    readonly maximumSpendWei: bigint;
  }) => {
    const directory = roundDirectory(input.candidate, input.record, input.round.round);
    await options.artifacts.installImmutable({
      relativePath: `${directory.relative}/identity`,
      bytes: Buffer.from(`${input.record.generation}\n`),
    });
    const request = buildRelayMarketplaceRequest({
      task: input.task,
      solverNet: options.config.solverNet,
      maximumSpendWei: input.maximumSpendWei,
      specPath: join(directory.absolute, 'spec.json'),
      createdAt: input.createdAt,
      submitBy: requestDeadline(input.record, input.round),
    });
    const persisted = persistRelayMarketplaceRequest(
      join(directory.absolute, 'request.json'),
      request,
    );
    return { directory, persisted };
  };

  const recoverSubmission = async (
    candidate: RelayReconciliationCandidateV2,
    record: RelayGenerationRecordV2,
    roundNumber: number,
  ): Promise<{ readonly round: RelayRoundRecordV2; readonly task: RelayTaskSpecV2; readonly submission: RelaySubmissionEvidence; readonly directory: string }> => {
    const round = latestRound(record, roundNumber);
    const intent = round.fundingIntent;
    if (intent === undefined) throw new Error('Relay V2 funding intent is missing');
    const task = taskForRound(record, round);
    const prepared = await prepareRequest({
      candidate,
      record,
      round,
      task,
      createdAt: intent.preparedAt,
      maximumSpendWei: BigInt(intent.maximumSpendWei),
    });
    if (prepared.persisted.requestDigest !== intent.requestDigest) {
      throw new Error('Relay V2 reconstructed request differs from durable intent');
    }
    const dryRun = await options.marketplace.dryRun(
      prepared.persisted.requestPath,
      intent.requestDigest,
    );
    if (
      !sameName(dryRun.creatorSafe, intent.creatorSafe)
      || dryRun.solverNetManifestCid !== intent.solverNetManifestCid
      || dryRun.proposedSpendWei.toString() !== intent.spendWei
    ) throw new Error('Relay V2 reconstructed funding authority changed');
    const submission = await options.marketplace.submit(
      prepared.persisted.requestPath,
      intent.requestDigest,
    );
    if (
      submission.id !== intent.taskKey
      || (round.task !== undefined && (
        submission.taskId !== round.task.taskId
        || submission.taskCid !== round.task.taskCid
      ))
    ) throw new Error('Relay V2 marketplace submission conflicts with durable evidence');
    persistRelaySubmissionEvidence(
      join(prepared.directory.absolute, 'submission.json'),
      submission,
    );
    return { round, task, submission, directory: prepared.directory.absolute };
  };

  const observeSolution = async (
    candidate: RelayReconciliationCandidateV2,
    record: RelayGenerationRecordV2,
    roundNumber: number,
  ) => {
    const recovered = await recoverSubmission(candidate, record, roundNumber);
    const expectation = buildRelaySolutionExpectationV2({
      submission: recovered.submission,
      round: recovered.task.spec.relay,
    });
    const expected = persistRelaySolutionExpectationV2(
      join(recovered.directory, 'solution-expectation-v2.json'),
      expectation,
    );
    const observed = await options.marketplace.observe(expected.path, expected.digest);
    if (observed.status === 'pending') return { status: 'pending' as const, detail: observed.reason };
    const installed = installVerifiedRelaySolutionObservationV2({
      observationPath: join(recovered.directory, 'solution-observation-v2.json'),
      expectationPath: expected.path,
      expectationDigest: expected.digest,
      observation: observed,
    });
    const readback = readVerifiedRelayObservation(installed.path, installed.digest);
    if (!isVerifiedIssueRelaySolutionV2(readback)) {
      throw new Error('Relay V2 persisted observation is not a V2 Solution');
    }
    return { status: 'verified' as const, observation: readback };
  };

  const publicationAuthority = async (
    record: RelayGenerationRecordV2,
    allowReady = false,
    expectedChecksDigest?: string,
  ) => {
    const durable = record.pr;
    if (durable === undefined) throw new Error('Relay V2 publication requires a pull request');
    const assertPr = (pr: Awaited<ReturnType<typeof options.githubAuthority.readPullRequest>>) => {
      if (
        pr.number !== durable.number
        || pr.generation !== record.generation
        || pr.branch !== durable.branch
        || pr.head !== durable.head
        || pr.base !== options.config.targetBase
        || !pr.open
        || !(pr.draft === durable.draft || (allowReady && durable.draft && !pr.draft))
      ) throw new Error('Relay V2 exact pull-request authority changed');
    };
    const pr = await options.githubAuthority.readPullRequest(durable.number);
    assertPr(pr);
    const currentBaseOid = await options.githubRead.readDefaultBranchHead();
    if (currentBaseOid !== record.snapshot.repository.baseOid) {
      throw new Error('Relay V2 frozen base authority changed');
    }
    const observed = await options.githubAuthority.readChecks({ head: pr.head, base: pr.base });
    const checks = aggregateRelayChecks({
      head: pr.head,
      branchRequiredChecks: observed.branchRequiredChecks,
      profile: {
        name: options.config.verificationProfile,
        requiredChecks: options.config.requiredChecks,
      },
      checks: observed.checks,
    });
    const after = await options.githubAuthority.readPullRequest(durable.number);
    assertPr(after);
    if (
      after.head !== pr.head
      || after.draft !== pr.draft
      || (expectedChecksDigest !== undefined && checks.digest !== expectedChecksDigest)
    ) throw new Error('Relay V2 publication authority changed during read');
    return { pr: after, currentBaseOid, checks };
  };

  const adoptionEvidence = async (
    record: RelayGenerationRecordV2,
    roundNumber: number,
  ): Promise<{ readonly adoption: AcceptedRelayAdoption; readonly anchor?: ReturnType<typeof findRelayEvaluationAnchorBlock> }> => {
    const round = latestRound(record, roundNumber);
    const prNumber = record.pr?.number;
    if (
      prNumber === undefined
      || round.task === undefined
      || round.solution === undefined
      || round.adoption?.disposition !== 'accepted'
    ) throw new Error('Relay V2 accepted adoption evidence is missing');
    const owned = (await options.githubAuthority.listAssuranceComments(prNumber))
      .filter(({ authorLogin, body }) => sameName(authorLogin, options.config.relayBotLogin)
        && body.includes('jinn-issue-relay:assurance:'));
    if (owned.length !== 1 || owned[0] === undefined) {
      throw new Error('Relay V2 does not own exactly one assurance comment');
    }
    const receipt = parseRelayAdoptionReceiptBlocks(owned[0].body).find((value) =>
      value.correlation.generation === record.generation
      && value.correlation.round === roundNumber
      && value.correlation.taskId === round.task!.taskId
      && value.correlation.deliveryEnvelopeCid === round.solution!.envelopeCid);
    if (receipt?.disposition !== 'accepted') {
      throw new Error('Relay V2 assurance lacks the accepted adoption receipt');
    }
    const adoption: AcceptedRelayAdoption = {
      status: 'accepted',
      receipt,
      branch: receipt.headRef,
      resultingHead: receipt.resultingHead,
      prNumber: receipt.prNumber,
    };
    if (
      relayAdoptionReceiptDigest(adoption) !== round.adoption.receiptDigest
      || receipt.resultingHead !== round.adoption.resultingHead
    ) throw new Error('Relay V2 adoption receipt contradicts durable evidence');
    return {
      adoption,
      anchor: findRelayEvaluationAnchorBlock(owned[0].body, receipt.correlation),
    };
  };

  const observeEvaluation = async (
    candidate: RelayReconciliationCandidateV2,
    record: RelayGenerationRecordV2,
    roundNumber: number,
    allowReady = false,
  ) => {
    const recovered = await recoverSubmission(candidate, record, roundNumber);
    const solutionExpectation = buildRelaySolutionExpectationV2({
      submission: recovered.submission,
      round: recovered.task.spec.relay,
    });
    const evidence = await adoptionEvidence(record, roundNumber);
    const authority = await publicationAuthority(
      record,
      allowReady,
      recovered.round.checks?.digest,
    );
    if (
      evidence.anchor === null
      || evidence.anchor === undefined
      || relayRequiredCheckStatus(authority.checks) !== 'passed'
    ) throw new Error('Relay V2 evaluation lacks an exact anchor and passed checks');
    const expectation = buildRelayEvaluationBundleExpectationV2({
      solutionExpectation,
      adoption: evidence.adoption,
      evaluationAnchor: evidence.anchor,
      checks: authority.checks,
    });
    const expected = persistRelayEvaluationBundleExpectationV2(
      join(recovered.directory, 'evaluation-bundle-expectation-v2.json'),
      expectation,
    );
    const observed = await options.marketplace.observe(expected.path, expected.digest);
    if (observed.status === 'pending') return { status: 'pending' as const, detail: observed.reason };
    const installed = installVerifiedRelayEvaluationBundleV2({
      observationPath: join(recovered.directory, 'evaluation-bundle-observation-v2.json'),
      expectationPath: expected.path,
      expectationDigest: expected.digest,
      observation: observed,
      adoption: evidence.adoption,
      evaluationAnchor: evidence.anchor,
      checks: authority.checks,
      pullRequestMetadata: {
        title: authority.pr.title,
        body: authority.pr.body,
      },
      laneSpecifications: options.config.laneSpecifications,
    });
    const readback = readVerifiedRelayObservation(installed.path, installed.digest);
    if (!isVerifiedIssueRelayEvaluationBundleV2(readback)) {
      throw new Error('Relay V2 persisted observation is not a dual-lane bundle');
    }
    return {
      status: 'verified' as const,
      observation: readback,
      adoption: evidence.adoption,
      anchor: evidence.anchor,
      checks: authority.checks,
    };
  };

  const publishAssurance = async (
    record: RelayGenerationRecordV2,
    input: {
      readonly request?: RelayGenerationRecordV2['decisions'][number]['request'];
      readonly ready?: ReturnType<typeof aggregateRelayEvaluationV2>;
      readonly allowReady?: boolean;
    } = {},
  ): Promise<void> => {
    const round = record.rounds.at(-1);
    if (record.pr === undefined || round?.adoption?.disposition !== 'accepted') return;
    const evidence = await adoptionEvidence(record, round.round);
    if (evidence.anchor === null || evidence.anchor === undefined || round.checks === undefined) {
      throw new Error('Relay V2 assurance lacks exact authenticated evidence');
    }
    const authority = await publicationAuthority(
      record,
      input.allowReady ?? false,
      round.checks.digest,
    );
    let security = laneReport(round, 'security');
    let quality = laneReport(round, 'quality');
    const ready = input.ready?.kind === 'ready' ? input.ready : undefined;
    if (ready !== undefined) {
      security = {
        ...relayLaneFromGateV2('security', ready.security),
        ...(security.automatedEvidence === undefined
          ? {}
          : { automatedEvidence: security.automatedEvidence }),
      };
      quality = {
        ...relayLaneFromGateV2('quality', ready.quality),
        ...(quality.automatedEvidence === undefined
          ? {}
          : { automatedEvidence: quality.automatedEvidence }),
      };
    }
    const body = renderRelayAssuranceV2({
      generation: record.generation,
      exactHead: authority.pr.head,
      baseOid: authority.currentBaseOid,
      solutionOperator: round.solution!.operatorSafe,
      security,
      quality,
      checksDigest: authority.checks.digest,
      adoptionReceiptDigest: round.adoption.receiptDigest,
      adoptionReceipt: evidence.adoption.receipt,
      evaluationAnchor: evidence.anchor,
      humanDecisionReceipts: record.decisions.flatMap((decision) => [
        ...decision.deferralReceipts,
        ...(decision.receipt === undefined ? [] : [decision.receipt]),
      ]),
      ...(input.request === undefined ? {} : { decisionRequest: input.request }),
      ...(ready === undefined ? {} : {
        ready: { security: ready.security, quality: ready.quality },
      }),
    });
    const comments = (await options.githubAuthority.listAssuranceComments(record.pr.number))
      .filter(({ authorLogin, body: commentBody }) =>
        sameName(authorLogin, options.config.relayBotLogin)
        && commentBody.includes('jinn-issue-relay:assurance:'));
    if (comments.length !== 1 || comments[0] === undefined) {
      throw new Error('Relay V2 assurance publication lost comment authority');
    }
    if (comments[0].body === body) return;
    await options.githubAuthority.editAssuranceCommentExact({
      prNumber: record.pr.number,
      commentId: comments[0].id,
      expectedHead: authority.pr.head,
      expectedBody: comments[0].body,
      body,
    });
  };

  const prepareRound = async (
    candidate: RelayReconciliationCandidateV2,
    action: Extract<RelayActionV2, {
      readonly kind:
        | 'prepare-round'
        | 'prepare-check-repair'
        | 'prepare-combined-repair'
        | 'prepare-decision-implementation';
    }>,
  ): Promise<RelayV2ActionExecutionResult> => {
    let record = candidate.facts.durable;
    if (record === undefined) throw new Error('Relay V2 funding lacks a generation marker');
    const pr = record.pr === undefined
      ? undefined
      : await options.githubAuthority.readPullRequest(record.pr.number);
    let capsule: IssueRelayRoundV2;
    if (action.kind === 'prepare-round') {
      capsule = IssueRelayRoundV2Schema.parse({
        schemaVersion: 'jinn-issue-relay-round.v2',
        generation: record.generation,
        round: action.round,
        snapshotDigest: record.snapshot.snapshotDigest,
        targetRepository: record.snapshot.repository.slug,
        workspaceRepository: record.snapshot.repository.slug,
        inputHead: record.snapshot.repository.baseOid,
        purpose: 'initial',
        findings: [],
      }) as IssueRelayRoundV2;
    } else if (action.kind === 'prepare-decision-implementation') {
      const current = decisionAttestation(record, action.decisionKey);
      const proposal = current.attestation.outcome.kind === 'decision-required'
        ? current.attestation.outcome.proposal
        : undefined;
      const option = proposal?.options.find(({ optionId }) => optionId === action.optionId);
      if (proposal === undefined || option?.effect !== 'implement-change' || option.implementationBrief === undefined) {
        throw new Error('Relay V2 decision implementation option is not code-changing');
      }
      const existing = record.decisions.find(({ decisionKey }) => decisionKey === action.decisionKey);
      if (existing === undefined) {
        record = queueRelayDecisionV2({ record, attestation: current.attestation, now: options.now().toISOString() });
      }
      const decision = record.decisions.find(({ decisionKey }) => decisionKey === action.decisionKey)!;
      const human = decision.receipt?.action === 'select-option'
        && decision.receipt.selectedOptionId === option.optionId
        && decision.receipt.binding === 'option-intent';
      capsule = IssueRelayRoundV2Schema.parse({
        schemaVersion: 'jinn-issue-relay-round.v2',
        generation: record.generation,
        round: action.round,
        snapshotDigest: record.snapshot.snapshotDigest,
        targetRepository: record.snapshot.repository.slug,
        workspaceRepository: options.config.managedForkRepository,
        inputHead: pr?.head,
        purpose: 'decision-implementation',
        findings: [],
        prNumber: pr?.number,
        decisionBinding: {
          decisionKey: action.decisionKey,
          proposalDigest: issueRelayCanonicalDigest(proposal),
          ...(human ? { requestDigest: decision.receipt!.requestDigest } : {}),
          optionId: option.optionId,
          authorization: human
            ? 'human-option-intent'
            : 'repository-policy-safe-preimplementation',
          sourceHead: pr?.head,
          frozenImplementationBrief: option.implementationBrief,
        },
      }) as IssueRelayRoundV2;
    } else {
      let findings: readonly IssueRelayLaneFindingV1[];
      if (action.kind === 'prepare-combined-repair') {
        findings = action.findings;
      } else {
        const authority = await publicationAuthority(record, false, action.checksDigest);
        if (authority.pr.head !== action.failedHead || relayRequiredCheckStatus(authority.checks) !== 'failed') {
          throw new Error('Relay V2 failed-check repair evidence is stale');
        }
        findings = relayFailedCheckFindings(authority.checks).map((finding, index) => ({
          findingId: `quality-check-${index + 1}`,
          lane: 'quality' as const,
          code: finding.code,
          severity: 'high' as const,
          title: finding.title,
          publicDetail: finding.detail,
          ...(finding.path === undefined ? {} : { path: finding.path }),
          sensitivity: 'public' as const,
        }));
      }
      capsule = IssueRelayRoundV2Schema.parse({
        schemaVersion: 'jinn-issue-relay-round.v2',
        generation: record.generation,
        round: action.round,
        snapshotDigest: record.snapshot.snapshotDigest,
        targetRepository: record.snapshot.repository.slug,
        workspaceRepository: options.config.managedForkRepository,
        inputHead: pr?.head,
        purpose: 'repair',
        findings,
        prNumber: pr?.number,
      }) as IssueRelayRoundV2;
    }
    const perRound = options.config.budget.maxGenerationSpendWei
      / BigInt(options.config.budget.maxRoundsPerGeneration);
    const maximumSpendWei = capsule.purpose === 'decision-implementation'
      ? [perRound, options.config.budget.maxDecisionImplementationSpendWei]
          .reduce((left, right) => left < right ? left : right)
      : perRound;
    if (maximumSpendWei <= 0n) throw new Error('Relay V2 per-round spend bound is zero');
    const provisional: RelayRoundRecordV2 = {
      round: capsule.round,
      purpose: capsule.purpose,
      workspaceRepository: capsule.workspaceRepository,
      inputHead: capsule.inputHead,
      findings: capsule.findings,
      ...(capsule.prNumber === undefined ? {} : { prNumber: capsule.prNumber }),
      ...(capsule.decisionBinding === undefined ? {} : { decisionBinding: capsule.decisionBinding as RelayRoundRecordV2['decisionBinding'] }),
      laneAttempts: { security: [], quality: [] },
    };
    const task = buildRelayTaskSpecV2({
      snapshot: record.snapshot,
      round: capsule,
      ...(capsule.purpose === 'initial' ? {} : {
        hostAuthority: {
          managedFork: true,
          workspaceRepository: capsule.workspaceRepository,
          visibility: 'PUBLIC',
          prNumber: capsule.prNumber!,
          currentHead: capsule.inputHead,
        } as const,
      }),
    });
    const preparedAt = options.now().toISOString();
    const prepared = await prepareRequest({
      candidate,
      record,
      round: provisional,
      task,
      createdAt: preparedAt,
      maximumSpendWei,
    });
    const dryRun = await options.marketplace.dryRun(
      prepared.persisted.requestPath,
      prepared.persisted.requestDigest,
    );
    const decision = capsule.decisionBinding === undefined
      ? undefined
      : record.decisions.find(({ decisionKey }) => decisionKey === capsule.decisionBinding!.decisionKey);
    const spend = authorizeRelayV2Spend({
      record,
      purpose: capsule.purpose,
      proposedSpendWei: dryRun.proposedSpendWei,
      maxGenerationSpendWei: options.config.budget.maxGenerationSpendWei,
      policy: {
        maxRoundsPerGeneration: options.config.budget.maxRoundsPerGeneration,
        maxEvaluationAttemptsPerLanePerHead: options.config.budget.maxEvaluationAttemptsPerLanePerHead,
        maxDecisionRequestsPerGeneration: options.config.budget.maxDecisionRequestsPerGeneration,
        maxDecisionImplementationRoundsPerGeneration: options.config.budget.maxDecisionImplementationRoundsPerGeneration,
        humanDecisionTtlMs: options.config.budget.humanDecisionTtlMs,
        maxHumanDeferrals: options.config.budget.maxHumanDeferrals,
        humanDeferralExtensionMs: options.config.budget.humanDeferralExtensionMs,
        decisionContinuationDeadlineMs: options.config.budget.decisionContinuationDeadlineMs,
        implementBeforeDecision: () => false,
        maxEvaluationRetrySpendWei: options.config.budget.maxEvaluationRetrySpendWei,
        maxDecisionImplementationSpendWei: options.config.budget.maxDecisionImplementationSpendWei,
      },
      now: preparedAt,
      ...(decision === undefined ? {} : { decision }),
      ...(capsule.decisionBinding === undefined ? {} : { optionId: capsule.decisionBinding.optionId }),
      ...(decision?.continuationDeadlineAt === undefined ? {} : { continuationDeadlineAt: decision.continuationDeadlineAt }),
    });
    if (!spend.admitted) return { outcome: 'refused', detail: `Relay V2 spend refused: ${spend.reason}` };
    const proposed = persistRelayFundingIntentV2({
      record,
      round: capsule,
      fundingIntent: {
        taskKey: task.spec.instance_id,
        creatorSafe: dryRun.creatorSafe,
        solverNetManifestCid: dryRun.solverNetManifestCid,
        requestDigest: prepared.persisted.requestDigest,
        maximumSpendWei: maximumSpendWei.toString(),
        spendWei: dryRun.proposedSpendWei.toString(),
        preparedAt,
      },
      now: preparedAt,
    });
    await replaceMarker(candidate, proposed);
    return { outcome: 'completed', detail: `Persisted Relay V2 ${capsule.purpose} funding intent` };
  };

  const execute = async (input: {
    readonly candidate: RelayReconciliationCandidateV2;
    readonly action: Exclude<RelayActionV2, { readonly kind: 'none' }>;
  }): Promise<RelayV2ActionExecutionResult> => {
    const { candidate, action } = input;
    const now = options.now().toISOString();
    if (action.kind === 'publish-generation') {
      const record = candidate.facts.admission;
      if (record === undefined || candidate.production?.issueCommentId !== undefined) {
        throw new Error('Relay V2 admission publication lacks exact authority');
      }
      await options.githubAuthority.createIssueCommentExact({
        issueNumber: candidate.issueNumber,
        body: formatRelayIssueMarkerV2(record),
      });
      await options.artifacts.installImmutable({
        relativePath: `locators/${candidate.issueNumber}/${record.snapshot.snapshotDigest}.json`,
        bytes: Buffer.from(`${JSON.stringify({
          repository: candidate.repository,
          issueNumber: candidate.issueNumber,
          generation: candidate.generation,
        })}\n`),
      });
      return { outcome: 'completed', detail: 'Published Relay V2 generation marker' };
    }
    if (
      action.kind === 'prepare-round'
      || action.kind === 'prepare-check-repair'
      || action.kind === 'prepare-combined-repair'
      || action.kind === 'prepare-decision-implementation'
    ) return prepareRound(candidate, action);
    const record = candidate.facts.durable;
    if (record === undefined) throw new Error('Relay V2 action lacks durable authority');
    switch (action.kind) {
      case 'submit-round': {
        const recovered = await recoverSubmission(candidate, record, action.round);
        const proposed = persistRelayTaskSubmissionV2({
          record,
          round: action.round,
          task: {
            taskKey: recovered.submission.id,
            taskId: recovered.submission.taskId,
            taskCid: recovered.submission.taskCid,
            spendWei: recovered.round.fundingIntent!.spendWei,
            fundedAt: now,
          },
          now,
        });
        await replaceMarker(candidate, proposed);
        return { outcome: 'completed', detail: 'Submitted the exact Relay V2 task' };
      }
      case 'observe-solution': {
        const observed = await observeSolution(candidate, record, action.round);
        if (observed.status === 'pending') return { outcome: 'pending', detail: observed.detail };
        const proposed = persistRelaySolutionDeliveryV2({
          record,
          round: action.round,
          solution: {
            envelopeCid: observed.observation.delivery.envelopeCid,
            operatorSafe: observed.observation.attempt.operator,
            observedAt: now,
          },
          now,
        });
        await replaceMarker(candidate, proposed);
        return { outcome: 'completed', detail: 'Observed authenticated Relay V2 Solution' };
      }
      case 'adopt-solution': {
        const round = latestRound(record, action.round);
        const observed = await observeSolution(candidate, record, action.round);
        if (observed.status === 'pending') return { outcome: 'pending', detail: observed.detail };
        const adoption = await options.adopter.adopt({
          authority: {
            generation: record.generation,
            round: action.round,
            targetRepository: 'Jinn-Network/mono',
            workspaceRepository: round.workspaceRepository,
            inputHead: round.inputHead,
            forkRepository: options.config.managedForkRepository,
            branch: relayBranch(record.generation),
            ...(record.pr === undefined ? {} : { existingPrNumber: record.pr.number }),
            cancellationRequested: record.cancellation !== undefined,
          },
          observation: observed.observation as unknown as VerifiedRelaySolutionObservation,
          snapshot: record.snapshot,
        });
        if (adoption.status === 'rejected') {
          const proposed = persistRelayAdoptionV2({
            record,
            round: action.round,
            adoption: {
              disposition: 'rejected',
              receiptDigest: digest(adoption.receipt),
              recordedAt: adoption.receipt.recordedAt,
            },
            now,
          });
          await replaceMarker(candidate, proposed);
          return { outcome: 'refused', detail: adoption.receipt.reason };
        }
        const pr = await options.githubAuthority.readPullRequest(adoption.prNumber);
        if (!pr.open || !pr.draft || pr.head !== adoption.resultingHead || pr.generation !== record.generation) {
          throw new Error('Relay V2 adopted draft did not read back exactly');
        }
        const proposed = persistRelayAdoptionV2({
          record,
          round: action.round,
          adoption: {
            disposition: 'accepted',
            resultingHead: adoption.resultingHead,
            prNumber: adoption.prNumber,
            receiptDigest: relayAdoptionReceiptDigest(adoption),
            recordedAt: adoption.receipt.adoptedAt,
          },
          pr: {
            number: pr.number,
            branch: pr.branch,
            head: pr.head,
            draft: true,
            targetRepository: record.snapshot.repository.slug,
            targetRepositoryId: pr.targetRepositoryId,
            forkRepository: options.config.managedForkRepository,
            forkRepositoryId: pr.forkRepositoryId,
            forkParentRepositoryId: pr.forkParentRepositoryId,
            visibility: 'PUBLIC',
            managedFork: true,
          },
          now,
        });
        await replaceMarker(candidate, proposed);
        return { outcome: 'completed', detail: 'Adopted Relay V2 Solution into the managed draft' };
      }
      case 'observe-checks': {
        const authority = await publicationAuthority(record);
        const status = relayRequiredCheckStatus(authority.checks);
        if (status === 'pending') return { outcome: 'pending', detail: 'Exact-head repository checks are pending' };
        const proposed = persistRelayChecksV2({
          record,
          round: action.round,
          checks: {
            head: authority.checks.head,
            status,
            digest: authority.checks.digest,
            observedAt: now,
          },
          now,
        });
        await replaceMarker(candidate, proposed);
        return { outcome: status === 'failed' ? 'refused' : 'completed', detail: `Recorded exact-head checks as ${status}` };
      }
      case 'publish-evaluation-anchor': {
        const round = latestRound(record, action.round);
        const evidence = await adoptionEvidence(record, action.round);
        const authority = await publicationAuthority(record, false, round.checks?.digest);
        if (relayRequiredCheckStatus(authority.checks) !== 'passed') {
          throw new Error('Relay V2 anchor requires passed exact-head checks');
        }
        const publisher = createRelayEvaluationAnchorPublisher({
          now: options.now,
          port: {
            readPullRequest: async () => options.githubAuthority.readPullRequest(record.pr!.number),
            listAssuranceComments: async () => options.githubAuthority.listAssuranceComments(record.pr!.number),
            editAssuranceComment: async (edit) => {
              const comments = await options.githubAuthority.listAssuranceComments(edit.prNumber);
              const existing = comments.find(({ id }) => id === edit.commentId);
              if (existing === undefined) throw new Error('Relay V2 assurance comment disappeared');
              await options.githubAuthority.editAssuranceCommentExact({
                prNumber: edit.prNumber,
                commentId: edit.commentId,
                expectedHead: edit.expectedHead,
                expectedBody: existing.body,
                body: edit.body,
              });
            },
          },
        });
        const anchor = await publisher.publish({
          authority: {
            targetRepositoryId: authority.pr.targetRepositoryId,
            forkRepositoryId: authority.pr.forkRepositoryId,
            forkParentRepositoryId: authority.pr.forkParentRepositoryId,
          },
          targetRepository: record.snapshot.repository.slug,
          targetBase: options.config.targetBase,
          serviceLogin: options.config.relayBotLogin,
          pr: authority.pr,
          currentBaseOid: authority.currentBaseOid,
          adoption: evidence.adoption,
          checks: authority.checks,
        });
        const proposed = persistRelayEvaluationAnchorV2({
          record,
          round: action.round,
          evaluation: {
            head: anchor.evaluatedHead,
            anchorDigest: issueRelayCanonicalDigest(anchor),
            anchoredAt: anchor.anchoredAt,
          },
          now,
        });
        await replaceMarker(candidate, proposed);
        return { outcome: 'completed', detail: 'Published Relay V2 exact-head evaluation anchor' };
      }
      case 'observe-evaluation-bundle': {
        const observed = await observeEvaluation(candidate, record, action.round);
        if (observed.status === 'pending') return { outcome: 'pending', detail: observed.detail };
        const proposed = persistRelayEvaluationBundleV2({
          record,
          round: action.round,
          bundle: observed.observation.payload,
          evaluatorSafe: observed.observation.attempt.operator,
          envelopeCid: observed.observation.delivery.envelopeCid,
          observedAt: now,
        });
        await publishAssurance(proposed);
        await replaceMarker(candidate, proposed);
        return { outcome: 'completed', detail: 'Recorded authenticated dual-lane evaluation bundle' };
      }
      case 'publish-decision-request': {
        const current = decisionAttestation(record, action.decisionKey);
        const observedAt = (['security', 'quality'] as const)
          .flatMap((lane) => current.round.laneAttempts[lane])
          .filter(({ head }) => head === current.round.checks?.head)
          .map(({ observedAt }) => observedAt)
          .sort()
          .at(-1) ?? record.updatedAt;
        const existing = record.decisions.find(({ decisionKey }) => decisionKey === action.decisionKey);
        const implementation = existing?.implementationRound === undefined
          ? {
              status: current.attestation.outcome.kind === 'decision-required'
                && current.attestation.outcome.proposal.options.some(({ effect }) =>
                  effect === 'implement-change')
                ? 'not-started' as const
                : 'not-required' as const,
              ...(current.attestation.outcome.kind === 'decision-required'
                && current.attestation.outcome.proposal.options.some(({ effect }) =>
                  effect === 'implement-change')
                ? {
                    optionId: current.attestation.outcome.proposal.recommendedOptionId,
                    sourceHead: current.attestation.evaluatedHead,
                  }
                : {}),
            }
          : {
              status: 'verified' as const,
              optionId: existing.commissionedOptions.at(-1),
              sourceHead: existing.firstProposedHead,
              implementedHead: current.attestation.evaluatedHead,
              implementationRound: existing.implementationRound,
              conformanceAttestationDigest: issueRelayCanonicalDigest(current.attestation),
            };
        const proposed = publishRelayDecisionRequestV2({
          record,
          round: current.round,
          attestation: current.attestation,
          implementation,
          now: observedAt,
          ttlMs: options.config.budget.humanDecisionTtlMs,
        });
        const request = proposed.decisions.find(({ decisionKey }) =>
          decisionKey === action.decisionKey)?.request;
        await publishAssurance(proposed, { request });
        await replaceMarker(candidate, proposed);
        return { outcome: 'completed', detail: 'Published a head-bound Relay V2 decision request' };
      }
      case 'record-human-decision': {
        const decision = record.decisions.find(({ decisionKey, status }) =>
          decisionKey === action.decisionKey && status === 'active');
        if (decision?.request === undefined || record.pr === undefined) {
          throw new Error('Relay V2 human observation lacks an active request and PR');
        }
        if (options.githubRead.listPullRequestComments === undefined) {
          throw new Error('Relay V2 GitHub comment observation is unavailable');
        }
        const list = () => options.githubRead.listPullRequestComments!(record.pr!.number);
        const observed = await observeRelayHumanDecision({
          request: decision.request,
          existingReceipt: decision.receipt,
          existingDeferralReceipts: decision.deferralReceipts,
          effectiveExpiresAt: decision.deferredUntil,
          originalAuthorisingMaintainer: {
            login: record.snapshot.issue.authorLogin,
            userId: record.snapshot.issue.authorId,
          },
          now,
          port: {
            listComments: list,
            readComment: async (commentId) => (await list()).find((comment) =>
              comment.commentId === commentId),
            readHead: async () => (await options.githubAuthority.readPullRequest(record.pr!.number)).head,
            readPermission: (login) => options.githubRead.readRepositoryPermission(login),
          },
        });
        if (observed.state === 'pending') return { outcome: 'pending', detail: observed.detail };
        if (observed.state === 'contradictory') return { outcome: 'refused', detail: observed.detail };
        if (observed.state === 'duplicate') return { outcome: 'completed', detail: 'Relay V2 human decision was already durable' };
        const proposed = recordRelayHumanDecisionV2({
          record,
          decisionKey: action.decisionKey,
          receipt: observed.receipt,
          now,
          maxDeferrals: options.config.budget.maxHumanDeferrals,
          deferralExtensionMs: options.config.budget.humanDeferralExtensionMs,
          decisionContinuationDeadlineMs: options.config.budget.decisionContinuationDeadlineMs,
        });
        await replaceMarker(candidate, proposed);
        return { outcome: 'completed', detail: 'Persisted the first authorized Relay V2 human receipt' };
      }
      case 'security-blocked': {
        const round = record.rounds.at(-1);
        const security = round === undefined ? undefined : attemptForHead(round, 'security');
        if (
          security?.observation.schemaVersion
            !== 'jinn-issue-relay-lane-attestation.v1'
          || security.observation.outcome.kind !== 'critical-block'
        ) throw new Error('Relay V2 critical block lacks exact security evidence');
        const requestAt = record.updatedAt;
        const blocked = blockRelaySecurityV2({ record, now: requestAt });
        const proposed = publishCriticalSecurityDecisionV2({
          record: blocked,
          attestation: security.observation,
          now: requestAt,
          ttlMs: options.config.budget.humanDecisionTtlMs,
        });
        const request = proposed.decisions.at(-1)?.request;
        await publishAssurance(proposed, { request });
        await replaceMarker(candidate, proposed);
        return { outcome: 'refused', detail: 'Recorded a non-overridable critical security block' };
      }
      case 'mark-ready': {
        const observed = await observeEvaluation(candidate, record, record.rounds.length - 1, true);
        if (observed.status === 'pending') return { outcome: 'pending', detail: observed.detail };
        const round = record.rounds.at(-1)!;
        const aggregate = aggregateRelayEvaluationV2({
          record,
          round,
          exactHead: record.pr!.head,
          maxAttemptsPerLanePerHead: options.config.budget.maxEvaluationAttemptsPerLanePerHead,
        });
        if (aggregate.kind !== 'ready') throw new Error('Relay V2 readiness gates are not satisfied');
        const before = await publicationAuthority(record, true, round.checks?.digest);
        const beforeMetadataDigest = issueRelayPullRequestMetadataDigest({
          title: before.pr.title,
          body: before.pr.body,
        });
        if ((['security', 'quality'] as const).some((lane) => {
          const current = attemptForHead(round, lane)?.observation;
          return current === undefined
            || current.pullRequestMetadataDigest !== beforeMetadataDigest;
        })) {
          throw new Error('Relay V2 PR metadata changed after exact quality evaluation');
        }
        if (before.pr.draft) {
          await options.githubWrite.markPullRequestReady({
            prNumber: record.pr!.number,
            expectedHead: record.pr!.head,
          });
        }
        const authority = await publicationAuthority(record, true, round.checks?.digest);
        if (authority.pr.draft) throw new Error('Relay V2 PR did not read back ready');
        if (issueRelayPullRequestMetadataDigest({
          title: authority.pr.title,
          body: authority.pr.body,
        }) !== beforeMetadataDigest) {
          throw new Error('Relay V2 PR metadata changed during ready transition');
        }
        const proposed = markRelayReadyV2({
          record,
          currentHead: authority.pr.head,
          currentBase: authority.currentBaseOid,
          currentPullRequestMetadataDigest: beforeMetadataDigest,
          policy: {
            maxEvaluationAttemptsPerLanePerHead: options.config.budget.maxEvaluationAttemptsPerLanePerHead,
          },
          now,
        });
        await publishAssurance(proposed, { ready: aggregate, allowReady: true });
        await replaceMarker(candidate, proposed);
        return { outcome: 'completed', detail: 'Marked the exact dual-lane-evaluated PR ready' };
      }
      case 'record-cancellation': {
        const proposed = persistRelayCancellationV2({ record, reason: action.reason, now });
        await replaceMarker(candidate, proposed);
        return { outcome: 'completed', detail: 'Recorded Relay V2 soft cancellation intent' };
      }
      case 'finish-cancellation':
      case 'close-exhausted': {
        if (record.pr !== undefined) {
          const pr = await options.githubAuthority.readPullRequest(record.pr.number);
          if (pr.open) {
            await options.githubWrite.closePullRequest({
              prNumber: pr.number,
              expectedHead: pr.head,
              expectedDraft: pr.draft,
              reason: action.kind === 'finish-cancellation'
                ? 'Jinn Issue Relay was cancelled.'
                : `Jinn Issue Relay exhausted: ${action.reason}.`,
            });
          }
        }
        const proposed = action.kind === 'finish-cancellation'
          ? finishRelayCancellationV2({ record, now })
          : exhaustRelayGenerationV2({ record, now });
        await replaceMarker(candidate, proposed);
        return { outcome: 'completed', detail: `Closed Relay V2 generation as ${proposed.phase}` };
      }
      case 'retry-evaluation-lane':
        return {
          outcome: 'refused',
          detail: 'The compatibility marketplace slot is finalized; lane retry requires operator escalation',
        };
      case 'supersede-generation': {
        const decision = record.decisions.find(({ decisionKey }) =>
          decisionKey === action.decisionKey);
        if (decision?.receipt?.action !== 'clarify-scope') {
          throw new Error('Relay V2 supersession lacks a clarify-scope receipt');
        }
        const issue = await options.githubRead.readIssue(candidate.issueNumber);
        const [labelEvents, permission, currentBaseOid] = await Promise.all([
          options.githubRead.listLabelEvents(candidate.issueNumber),
          options.githubRead.readRepositoryPermission(issue.issue.authorLogin),
          options.githubRead.readDefaultBranchHead(),
        ]);
        const admission = admitRelayIssue({
          issue,
          labelEvents,
          currentPermission: permission,
          currentBaseOid,
          policy: {
            repository: options.config.repository,
            label: options.config.label,
            maxIssueBytes: 256 * 1024,
            maxAcceptanceItems: 50,
            forbiddenRequestPatterns: [
              /\b(?:private key|seed phrase|repository secret)\b/i,
              /\b(?:deploy|release to production)\b/i,
            ],
          },
          now: options.now(),
        });
        if (admission.status !== 'admitted') {
          return { outcome: 'refused', detail: 'Clarified issue is not admissible' };
        }
        const successorSnapshot = buildRelaySnapshot(admission.input);
        if (!snapshotMateriallyChanged(record.snapshot, successorSnapshot)) {
          return { outcome: 'pending', detail: 'Clarify the issue scope before creating a successor generation' };
        }
        const proposed = supersedeRelayGenerationV2({
          record,
          receipt: decision.receipt,
          successorSnapshot,
          now,
        });
        await replaceMarker(candidate, proposed);
        return { outcome: 'completed', detail: 'Pinned a materially changed successor snapshot' };
      }
      case 'finish-supersession': {
        if (record.phase !== 'superseded' || record.pr === undefined) {
          throw new Error('Relay V2 supersession close lacks exact draft authority');
        }
        const pr = await options.githubAuthority.readPullRequest(record.pr.number);
        if (pr.open) {
          await options.githubWrite.closePullRequest({
            prNumber: pr.number,
            expectedHead: pr.head,
            expectedDraft: pr.draft,
            reason: 'Jinn Issue Relay scope was clarified; a successor generation will replace this draft.',
          });
        }
        return { outcome: 'completed', detail: 'Closed the superseded Relay V2 draft' };
      }
      case 'publish-successor-generation': {
        const supersession = record.supersession;
        if (
          record.phase !== 'superseded'
          || supersession === undefined
          || candidate.facts.successorPresent === true
        ) throw new Error('Relay V2 successor publication lacks durable supersession intent');
        const successor: RelayGenerationRecordV2 = {
          schemaVersion: 'jinn-issue-relay-generation.v2',
          generation: relayGeneration(supersession.successorSnapshot),
          snapshot: supersession.successorSnapshot,
          predecessor: {
            generation: record.generation,
            snapshotDigest: record.snapshot.snapshotDigest,
          },
          phase: 'admitted',
          executionDeadlineAt: new Date(
            Date.parse(supersession.successorSnapshot.capturedAt)
              + options.config.budget.generationDeadlineMs,
          ).toISOString(),
          rounds: [],
          decisions: [],
          updatedAt: supersession.successorSnapshot.capturedAt,
        };
        if (successor.generation !== supersession.successorGeneration) {
          throw new Error('Relay V2 successor generation identity changed');
        }
        await options.githubAuthority.createIssueCommentExact({
          issueNumber: candidate.issueNumber,
          body: formatRelayIssueMarkerV2(successor),
        });
        await options.artifacts.installImmutable({
          relativePath: `locators/${candidate.issueNumber}/${successor.snapshot.snapshotDigest}.json`,
          bytes: Buffer.from(`${JSON.stringify({
            repository: candidate.repository,
            issueNumber: candidate.issueNumber,
            generation: successor.generation,
            predecessorGeneration: record.generation,
          })}\n`),
        });
        return { outcome: 'completed', detail: 'Published the linked Relay V2 successor generation' };
      }
    }
  };

  return createIssueRelayV2GitHubReconciliation({
    config: options.config,
    githubRead: options.githubRead,
    githubAuthority: options.githubAuthority,
    now: options.now,
    execute,
    knownIssueNumbers: () => options.githubAuthority.listIssueNumbersForMarkerRecovery(),
  });
}
