import { createHash } from 'node:crypto';

import {
  IssueRelayEvaluationContextV2Schema,
  issueRelayPullRequestMetadataDigest,
  type IssueRelayCorrelationV1,
  type IssueRelayEvaluationContextV2,
  type IssueRelaySolutionV2,
} from '../contracts.js';
import {
  IssueRelayMarketplaceTaskSchema,
  type IssueRelayMarketplaceTask,
} from '../marketplace-application.js';
import type { IssueRelaySnapshotV1 } from '../snapshot.js';
import { relayTaskKey } from '../identity.js';
import { renderRelayTaskProblemStatementV2 } from '../task.js';
import {
  observeExactIssueRelayEvaluationReceipts,
  type IssueRelayGitHubReadPort,
} from './github-receipt-observer.js';

export interface IssueRelayEvaluationProvenance {
  readonly sourceTaskId: string;
  readonly sourceTaskCid: string;
  readonly attemptIndex: number;
  readonly solutionRequestId: string;
  readonly solutionEnvelopeCid: string;
  readonly solutionOperatorSafe: string;
  readonly evaluatorOperatorSafe: string;
}

export interface IssueRelayEvaluationContextResolverInput {
  readonly task: IssueRelayMarketplaceTask;
  readonly solution: IssueRelaySolutionV2;
  readonly provenance: IssueRelayEvaluationProvenance;
}

export type IssueRelayEvaluationContextObservation =
  | {
      readonly state: 'accepted';
      readonly context: IssueRelayEvaluationContextV2;
    }
  | {
      readonly state: 'pending' | 'rejected' | 'contradictory';
      readonly detail: string;
    };

export interface IssueRelayEvaluationContextResolver {
  resolve(
    input: IssueRelayEvaluationContextResolverInput,
  ): Promise<IssueRelayEvaluationContextObservation>;
}

function sameSafe(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function contradictory(detail: string): IssueRelayEvaluationContextObservation {
  return { state: 'contradictory', detail };
}

function patchDigest(patch: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(patch, 'utf8').digest('hex')}`;
}

/**
 * Reconstructs Relay's exact-head evaluation context from public GitHub
 * receipts. Marketplace provenance supplies correlation and operator identity;
 * it never supplies host authorization, adoption, checks, or PR facts.
 */
export function createIssueRelayEvaluationContextResolver(options: {
  readonly github: IssueRelayGitHubReadPort;
  readonly relayBotLogin: string;
  readonly maxPages?: number;
  readonly laneSpecifications: {
    readonly security: `sha256:${string}`;
    readonly quality: `sha256:${string}`;
  };
}): IssueRelayEvaluationContextResolver {
  return {
    async resolve(
      input: IssueRelayEvaluationContextResolverInput,
    ): Promise<IssueRelayEvaluationContextObservation> {
      const parsedTask = IssueRelayMarketplaceTaskSchema.safeParse(input.task);
      if (!parsedTask.success) {
        return contradictory('Source Relay application Task is malformed');
      }
      const task = parsedTask.data;
      const round = task.application.payload.round;
      const provenance = input.provenance;
      if (sameSafe(provenance.solutionOperatorSafe, provenance.evaluatorOperatorSafe)) {
        return contradictory('Solution and evaluator Safes must be distinct');
      }
      if (
        task.base_commit !== round.inputHead
        || task.repo !== round.targetRepository
        || task.instance_id !== relayTaskKey(round.generation, round.round)
      ) {
        return contradictory('Relay application Task does not bind its exact round');
      }
      const correlation: IssueRelayCorrelationV1 = {
        generation: round.generation,
        round: round.round,
        snapshotDigest: round.snapshotDigest as `sha256:${string}`,
        taskId: provenance.sourceTaskId,
        attemptIndex: provenance.attemptIndex,
        requestId: provenance.solutionRequestId,
        deliveryEnvelopeCid: provenance.solutionEnvelopeCid,
      };
      const observation = await observeExactIssueRelayEvaluationReceipts({
        round,
        issueNumber: task.issue_number,
        correlation,
        relayBotLogin: options.relayBotLogin,
        github: options.github,
        ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
      });
      if (observation.state !== 'accepted') {
        return {
          state: observation.state,
          detail: observation.detail,
        };
      }
      if (observation.marker.schemaVersion !== 'jinn-issue-relay-generation.v2') {
        return contradictory('Relay V2 evaluation requires a V2 generation marker');
      }
      const marker = observation.marker;
      const markerRound = marker.rounds[round.round];
      if (
        markerRound?.solution?.operatorSafe === undefined
        || !sameSafe(markerRound.solution.operatorSafe, provenance.solutionOperatorSafe)
        || !sameSafe(observation.receipt.solutionSafe, provenance.solutionOperatorSafe)
      ) {
        return contradictory('Relay Solution Safe binding is contradictory');
      }
      if (observation.receipt.patchDigest !== patchDigest(input.solution.patch)) {
        return contradictory('Relay Solution patch digest is contradictory');
      }
      const snapshot = marker.snapshot as IssueRelaySnapshotV1;
      if (
        task.problem_statement
          !== renderRelayTaskProblemStatementV2({ snapshot, round })
      ) {
        return contradictory('Relay Task goal differs from the frozen GitHub marker');
      }
      const priorDecisions = marker.rounds.flatMap((record) => {
        const binding = record.decisionBinding;
        if (binding === undefined) return [];
        const decision = marker.decisions.find(
          ({ decisionKey }) => decisionKey === binding.decisionKey,
        );
        const receipt = decision?.receipt as
          | { readonly receiptDigest?: `sha256:${string}` }
          | undefined;
        return [{
          decisionKey: binding.decisionKey,
          ...(decision?.lane === undefined ? {} : { lane: decision.lane }),
          optionId: binding.optionId,
          implementationRound: record.round,
          ...(binding.requestDigest === undefined
            ? {}
            : { requestDigest: binding.requestDigest }),
          ...(receipt?.receiptDigest === undefined
            ? {}
            : { humanDecisionReceiptDigest: receipt.receiptDigest }),
          authorization: binding.authorization,
        }];
      });
      const pullRequestMetadata = {
        title: observation.pullRequest.title,
        body: observation.pullRequest.body,
      };
      const candidate = {
        schemaVersion: 'jinn-issue-relay-evaluation-context.v2',
        goal: {
          snapshotDigest: round.snapshotDigest,
          problemStatement: task.problem_statement,
          acceptanceEvidence: snapshot.acceptanceEvidence,
          verificationProfile: snapshot.verificationProfile,
        },
        operators: {
          solutionSafe: provenance.solutionOperatorSafe,
          evaluatorSafe: provenance.evaluatorOperatorSafe,
        },
        round,
        correlation,
        reviewTarget: {
          targetRepository: observation.pullRequest.targetRepository,
          workspaceRepository: observation.pullRequest.workspaceRepository,
          issueNumber: task.issue_number,
          prNumber: observation.pullRequest.number,
          targetBase: observation.pullRequest.targetBase,
          baseOid: observation.pullRequest.baseOid,
          headRef: observation.pullRequest.headRef,
          evaluatedHead: observation.pullRequest.headSha,
          pullRequest: {
            ...pullRequestMetadata,
            digest: issueRelayPullRequestMetadataDigest(pullRequestMetadata),
          },
        },
        adoptionReceipt: observation.receipt,
        evaluationAnchor: observation.anchor,
        checks: observation.pullRequest.checks,
        laneSpecifications: options.laneSpecifications,
        priorDecisions,
      };
      const parsedContext = IssueRelayEvaluationContextV2Schema.safeParse(candidate);
      if (!parsedContext.success) {
        return contradictory(
          `Relay evidence failed strict context binding: ${parsedContext.error.issues
            .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ')}`,
        );
      }
      return { state: 'accepted', context: parsedContext.data };
    },
  };
}
