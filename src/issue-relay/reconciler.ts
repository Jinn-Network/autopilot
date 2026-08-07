import type { RelayAdoptionCoordinator } from './adoption.js';
import type { IssueRelayConfig } from './config.js';
import type { RelayAdmissionDecision } from './github-port.js';
import type {
  RelayGitHubReadPort,
  RelayGitHubWritePort,
} from './github-port.js';
import type { IssueRelayMarketplaceCli } from './marketplace-cli.js';
import type { IssueRelaySnapshotV1 } from './snapshot.js';
import {
  deriveRelayAction,
  type RelayAction,
  type RelayAuthoritativeFacts,
} from './state.js';

export interface RelayDurableArtifactStore {
  installImmutable(input: {
    readonly relativePath: string;
    readonly bytes: Buffer;
  }): Promise<'created' | 'identical'>;
  read(relativePath: string): Promise<Buffer | null>;
}

export interface RelayReconciliationCandidate {
  readonly generation: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly transitionedAt: string;
  /**
   * `github` means exactly one service-authored durable marker was decoded.
   * Local artifacts are locators only and must never be promoted to authority.
   */
  readonly authority: 'github' | 'cache' | 'ambiguous';
  readonly facts: RelayAuthoritativeFacts;
  readonly production?: {
    readonly issueCommentId?: number;
    readonly issueCommentBody?: string;
    readonly admission?: RelayAdmissionDecision;
    readonly snapshot?: IssueRelaySnapshotV1;
  };
}

export interface RelayActionExecutionResult {
  readonly outcome: 'completed' | 'pending' | 'refused';
  readonly detail: string;
}

export interface RelayReconciliationPort {
  scan(input: {
    readonly discover: boolean;
    readonly recover: boolean;
  }): Promise<readonly RelayReconciliationCandidate[]>;
  reread(
    candidate: RelayReconciliationCandidate,
  ): Promise<RelayReconciliationCandidate>;
  /**
   * Executes the supplied Task 3–11 action composition. Implementations must
   * use the exact marker/admission/budget/task/adoption/check/repair/report
   * ports and perform their authoritative readback before returning.
   */
  execute(input: {
    readonly candidate: RelayReconciliationCandidate;
    readonly action: Exclude<RelayAction, { readonly kind: 'none' }>;
    readonly ports: Omit<
    IssueRelayRuntimePorts,
    'reconciliation'
    >;
  }): Promise<RelayActionExecutionResult>;
}

export interface IssueRelayRuntimePorts {
  readonly config: IssueRelayConfig;
  readonly githubRead: RelayGitHubReadPort;
  readonly githubWrite: RelayGitHubWritePort;
  readonly marketplace: IssueRelayMarketplaceCli;
  readonly adopter: RelayAdoptionCoordinator;
  readonly artifacts: RelayDurableArtifactStore;
  readonly now: () => Date;
  readonly mode?: 'observe' | 'recover' | 'active';
  readonly reconciliation?: RelayReconciliationPort;
}

export interface RelayCycleReport {
  readonly discovered: number;
  readonly admitted: number;
  readonly refused: number;
  readonly actions: readonly {
    readonly generation: string;
    readonly action: RelayAction['kind'];
    readonly outcome: 'completed' | 'pending' | 'refused' | 'failed';
    readonly detail: string;
  }[];
}

export class IssueRelayRateLimitError extends Error {
  override readonly name = 'IssueRelayRateLimitError';
}

const CANONICAL_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RECOVERY_FUNDING_ACTIONS: ReadonlySet<RelayAction['kind']> = new Set([
  'publish-snapshot',
  'prepare-round',
  'submit-round',
  'submit-repair',
]);

function canonicalTime(value: string): number {
  if (!CANONICAL_UTC.test(value)) return Number.POSITIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : Number.POSITIVE_INFINITY;
}

function compareCandidates(
  left: RelayReconciliationCandidate,
  right: RelayReconciliationCandidate,
): number {
  return canonicalTime(left.transitionedAt) - canonicalTime(right.transitionedAt)
    || left.repository.localeCompare(right.repository, 'en-US')
    || left.issueNumber - right.issueNumber
    || left.generation.localeCompare(right.generation, 'en-US');
}

function exactCandidate(
  expected: RelayReconciliationCandidate,
  current: RelayReconciliationCandidate,
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
        && current.production?.snapshot?.snapshotDigest
          === expected.production?.snapshot?.snapshotDigest
      )
    );
}

function safeFailure(error: unknown): string {
  if (error instanceof IssueRelayRateLimitError) {
    return 'GitHub rate limit stopped the reconciliation pass';
  }
  return error instanceof Error
    ? `Relay generation failed (${error.name})`
    : 'Relay generation failed';
}

function phaseCounts(
  candidates: readonly RelayReconciliationCandidate[],
): Pick<RelayCycleReport, 'admitted' | 'refused'> {
  let admitted = 0;
  let refused = 0;
  for (const candidate of candidates) {
    const phase = candidate.facts.durable?.phase;
    if (phase === 'refused' || phase === 'awaiting-clarification') {
      refused += 1;
    } else if (candidate.authority === 'github') {
      admitted += 1;
    }
  }
  return { admitted, refused };
}

export async function runIssueRelayCycle(
  deps: IssueRelayRuntimePorts,
): Promise<RelayCycleReport> {
  if (deps.config.schemaVersion !== 1) {
    throw new Error('Relay generation.v2 must use the dedicated V2 reconciliation composition');
  }
  if (deps.reconciliation === undefined) {
    throw new Error('Issue Relay reconciliation composition is unavailable');
  }
  const mode = deps.mode ?? 'active';
  const scanned = await deps.reconciliation.scan({
    discover: mode !== 'recover',
    recover: true,
  });
  const candidates = [...scanned].sort(compareCandidates);
  const counts = phaseCounts(candidates);
  const duplicateGenerations = new Set<string>();
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.generation)) {
      duplicateGenerations.add(candidate.generation);
    }
    seen.add(candidate.generation);
  }

  const actions: RelayCycleReport['actions'][number][] = [];
  for (const scannedCandidate of candidates) {
    if (
      scannedCandidate.authority !== 'github'
      || duplicateGenerations.has(scannedCandidate.generation)
    ) {
      actions.push({
        generation: scannedCandidate.generation,
        action: 'none',
        outcome: 'failed',
        detail: 'Exactly one GitHub-authored active generation record is required',
      });
      continue;
    }

    let attemptedAction: RelayAction['kind'] = 'none';
    try {
      const current = await deps.reconciliation.reread(scannedCandidate);
      if (!exactCandidate(scannedCandidate, current)) {
        throw new Error('Relay durable authority changed during reread');
      }
      const action = deriveRelayAction(current.facts, {
        maxRoundsPerGeneration: deps.config.budget.maxRoundsPerGeneration,
        generationDeadlineMs: deps.config.budget.generationDeadlineMs,
      });
      attemptedAction = action.kind;
      if (action.kind === 'none') {
        actions.push({
          generation: current.generation,
          action: action.kind,
          outcome: 'pending',
          detail: action.reason,
        });
        continue;
      }
      if (
        mode === 'observe'
        || (mode === 'recover' && RECOVERY_FUNDING_ACTIONS.has(action.kind))
      ) {
        actions.push({
          generation: current.generation,
          action: action.kind,
          outcome: 'pending',
          detail: mode === 'observe'
            ? 'Observe mode permits no writes'
            : 'Recover mode permits no discovery or funding',
        });
        continue;
      }

      const result = await deps.reconciliation.execute({
        candidate: current,
        action,
        ports: deps,
      });
      actions.push({
        generation: current.generation,
        action: action.kind,
        ...result,
      });
      const readback = await deps.reconciliation.reread(current);
      if (!exactCandidate(current, readback)) {
        throw new Error('Relay action did not retain exact GitHub authority');
      }
    } catch (error) {
      actions.push({
        generation: scannedCandidate.generation,
        action: attemptedAction,
        outcome: 'failed',
        detail: safeFailure(error),
      });
      if (error instanceof IssueRelayRateLimitError) break;
    }
  }

  return {
    discovered: candidates.length,
    ...counts,
    actions,
  };
}
