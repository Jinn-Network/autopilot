import type { IssueRelayConfigV2 } from './config.js';
import {
  deriveRelayActionV2,
  type RelayActionV2,
  type RelayFactsV2,
} from './state-v2.js';

export interface RelayReconciliationCandidateV2 {
  readonly generation: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly transitionedAt: string;
  readonly authority: 'github' | 'ambiguous';
  readonly facts: RelayFactsV2;
  readonly production?: {
    readonly issueCommentId?: number;
    readonly issueCommentBody?: string;
  };
}

export interface RelayV2ActionExecutionResult {
  readonly outcome: 'completed' | 'pending' | 'refused';
  readonly detail: string;
}

export interface RelayReconciliationPortV2 {
  scan(input: {
    readonly discover: boolean;
    readonly recover: boolean;
  }): Promise<readonly RelayReconciliationCandidateV2[]>;
  reread(candidate: RelayReconciliationCandidateV2): Promise<RelayReconciliationCandidateV2>;
  execute(input: {
    readonly candidate: RelayReconciliationCandidateV2;
    readonly action: Exclude<RelayActionV2, { readonly kind: 'none' }>;
  }): Promise<RelayV2ActionExecutionResult>;
}

export interface RelayV2CycleReport {
  readonly discovered: number;
  readonly actions: readonly {
    readonly generation: string;
    readonly action: RelayActionV2['kind'];
    readonly outcome: 'completed' | 'pending' | 'refused' | 'failed';
    readonly detail: string;
  }[];
}

const RECOVERY_SPEND_ACTIONS: ReadonlySet<RelayActionV2['kind']> = new Set([
  'publish-generation',
  'prepare-round',
  'prepare-check-repair',
  'prepare-combined-repair',
  'prepare-decision-implementation',
  'retry-evaluation-lane',
]);

function exactCandidate(
  expected: RelayReconciliationCandidateV2,
  current: RelayReconciliationCandidateV2,
): boolean {
  return current.authority === 'github'
    && current.generation === expected.generation
    && current.repository === expected.repository
    && current.issueNumber === expected.issueNumber
    && (
      current.facts.durable?.generation === expected.generation
      || (
        current.facts.durable === undefined
        && expected.facts.durable === undefined
        && current.facts.admission?.generation === expected.generation
        && current.facts.admission?.snapshot.snapshotDigest
          === expected.facts.admission?.snapshot.snapshotDigest
      )
    );
}

function safeFailure(error: unknown): string {
  return error instanceof Error
    ? `Relay V2 generation failed (${error.name})`
    : 'Relay V2 generation failed';
}

/**
 * Runs one deterministic V2 pass. Every action gets an exact GitHub reread,
 * performs at most one externally visible effect, then gets a second reread.
 */
export async function runIssueRelayCycleV2(input: {
  readonly config: IssueRelayConfigV2;
  readonly mode: 'observe' | 'recover' | 'active';
  readonly reconciliation: RelayReconciliationPortV2;
}): Promise<RelayV2CycleReport> {
  if (
    input.config.schemaVersion !== 2
    || input.config.generationProtocol !== 'v2'
    || !input.config.dualLaneEvaluationEnabled
  ) throw new TypeError('Relay V2 cycle requires an enabled V2 configuration');
  const scanned = [...await input.reconciliation.scan({
    discover: input.mode !== 'recover',
    recover: true,
  })].sort((left, right) =>
    Date.parse(left.transitionedAt) - Date.parse(right.transitionedAt)
    || left.repository.localeCompare(right.repository, 'en-US')
    || left.issueNumber - right.issueNumber
    || left.generation.localeCompare(right.generation, 'en-US'));
  const duplicate = new Set<string>();
  const seen = new Set<string>();
  for (const candidate of scanned) {
    if (seen.has(candidate.generation)) duplicate.add(candidate.generation);
    seen.add(candidate.generation);
  }
  const actions: RelayV2CycleReport['actions'][number][] = [];
  for (const scannedCandidate of scanned) {
    if (
      scannedCandidate.authority !== 'github'
      || duplicate.has(scannedCandidate.generation)
    ) {
      actions.push({
        generation: scannedCandidate.generation,
        action: 'none',
        outcome: 'failed',
        detail: 'Exactly one GitHub-authored Relay V2 generation record is required',
      });
      continue;
    }
    let attempted: RelayActionV2['kind'] = 'none';
    try {
      const current = await input.reconciliation.reread(scannedCandidate);
      if (!exactCandidate(scannedCandidate, current)) {
        throw new Error('Relay V2 durable authority changed during reread');
      }
      const action = deriveRelayActionV2(current.facts, {
        maxRoundsPerGeneration: input.config.budget.maxRoundsPerGeneration,
        maxEvaluationAttemptsPerLanePerHead:
          input.config.budget.maxEvaluationAttemptsPerLanePerHead,
        maxDecisionRequestsPerGeneration:
          input.config.budget.maxDecisionRequestsPerGeneration,
        maxDecisionImplementationRoundsPerGeneration:
          input.config.budget.maxDecisionImplementationRoundsPerGeneration,
        humanDecisionTtlMs: input.config.budget.humanDecisionTtlMs,
        maxHumanDeferrals: input.config.budget.maxHumanDeferrals,
        humanDeferralExtensionMs:
          input.config.budget.humanDeferralExtensionMs,
        decisionContinuationDeadlineMs:
          input.config.budget.decisionContinuationDeadlineMs,
        implementBeforeDecision: (proposal) =>
          input.config.decisionImplementationEnabled
          && proposal.proposedImplementationPolicy === 'implement-before-decision'
          && input.config.safePreimplementationReasonCodes.includes(
            proposal.reasonCode,
          ),
      });
      attempted = action.kind;
      if (action.kind === 'none') {
        actions.push({
          generation: current.generation,
          action: 'none',
          outcome: 'pending',
          detail: action.reason,
        });
        continue;
      }
      if (
        input.mode === 'observe'
        || (input.mode === 'recover' && RECOVERY_SPEND_ACTIONS.has(action.kind))
        || (
          !input.config.humanDecisionCommandsEnabled
          && ['publish-decision-request', 'record-human-decision', 'supersede-generation']
            .includes(action.kind)
        )
        || (
          !input.config.decisionImplementationEnabled
          && action.kind === 'prepare-decision-implementation'
        )
      ) {
        actions.push({
          generation: current.generation,
          action: action.kind,
          outcome: 'pending',
          detail: input.mode === 'observe'
            ? 'Observe mode permits no writes'
            : input.mode === 'recover' && RECOVERY_SPEND_ACTIONS.has(action.kind)
              ? 'Recover mode permits no new spend'
              : 'The required Relay V2 feature flag is disabled',
        });
        continue;
      }
      const result = await input.reconciliation.execute({
        candidate: current,
        action,
      });
      actions.push({ generation: current.generation, action: action.kind, ...result });
      const readback = await input.reconciliation.reread(current);
      if (!exactCandidate(current, readback)) {
        throw new Error('Relay V2 action did not retain exact GitHub authority');
      }
    } catch (error) {
      actions.push({
        generation: scannedCandidate.generation,
        action: attempted,
        outcome: 'failed',
        detail: safeFailure(error),
      });
    }
  }
  return { discovered: scanned.length, actions };
}
