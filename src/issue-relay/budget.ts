import { relayTaskKey } from './identity.js';

export interface RelayBudgetPolicy {
  readonly maxGlobalActiveGenerations: number;
  readonly maxActivePerRepository: number;
  readonly maxActivePerAuthor: number;
  readonly maxRoundsPerGeneration: number;
  readonly maxGenerationSpendWei: bigint;
  readonly maxGlobalSpendWeiPerUtcDay: bigint;
  readonly generationDeadlineMs: number;
}

export interface RelaySpendLedger {
  readonly activeGenerations: readonly {
    readonly generation: string;
    readonly repository: string;
    readonly authorLogin: string;
    readonly deadlineAt: string;
  }[];
  readonly fundedRounds: readonly {
    readonly taskKey: string;
    readonly generation: string;
    readonly repository: string;
    readonly authorLogin: string;
    readonly round: number;
    readonly spendWei: bigint;
    readonly fundedAt: string;
  }[];
}

export type RelaySpendDecision =
  | { readonly status: 'admitted'; readonly taskKey: string }
  | { readonly status: 'duplicate'; readonly taskKey: string }
  | {
      readonly status: 'deferred';
      readonly code:
        | 'global-active-limit'
        | 'repository-active-limit'
        | 'author-active-limit'
        | 'daily-spend-limit';
    }
  | {
      readonly status: 'exhausted';
      readonly code: 'round-limit' | 'generation-spend-limit' | 'deadline';
    };

function sameGitHubName(left: string, right: string): boolean {
  return left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US');
}

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function requireNonNegativeWei(value: bigint, label: string): void {
  if (value < 0n) {
    throw new RangeError(`${label} must be non-negative`);
  }
}

function parsedTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${label} must be a valid timestamp`);
  }
  return timestamp;
}

function validatePolicy(policy: RelayBudgetPolicy): void {
  requireNonNegativeInteger(
    policy.maxGlobalActiveGenerations,
    'Global active-generation limit',
  );
  requireNonNegativeInteger(
    policy.maxActivePerRepository,
    'Repository active-generation limit',
  );
  requireNonNegativeInteger(
    policy.maxActivePerAuthor,
    'Author active-generation limit',
  );
  requireNonNegativeInteger(policy.maxRoundsPerGeneration, 'Round limit');
  requireNonNegativeWei(policy.maxGenerationSpendWei, 'Generation spend limit');
  requireNonNegativeWei(policy.maxGlobalSpendWeiPerUtcDay, 'Daily spend limit');
  if (!Number.isSafeInteger(policy.generationDeadlineMs) || policy.generationDeadlineMs <= 0) {
    throw new RangeError('Generation deadline must be a positive safe integer');
  }
}

export function admitRelaySpend(input: {
  readonly policy: RelayBudgetPolicy;
  readonly ledger: RelaySpendLedger;
  readonly candidate: {
    readonly generation: string;
    readonly repository: string;
    readonly authorLogin: string;
    readonly round: number;
    readonly proposedSpendWei: bigint;
  };
  readonly now: Date;
}): RelaySpendDecision {
  validatePolicy(input.policy);
  requireNonNegativeInteger(input.candidate.round, 'Candidate round');
  requireNonNegativeWei(input.candidate.proposedSpendWei, 'Proposed spend');

  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new TypeError('Current time must be valid');
  }

  const active = input.ledger.activeGenerations.map((generation) => ({
    ...generation,
    deadlineMs: parsedTimestamp(generation.deadlineAt, 'Generation deadline'),
  }));
  const activeGenerationNames = new Set<string>();
  for (const generation of active) {
    if (activeGenerationNames.has(generation.generation)) {
      throw new TypeError('Ambiguous active generation ledger entries');
    }
    activeGenerationNames.add(generation.generation);
  }

  const fundedTaskKeys = new Set<string>();
  for (const funded of input.ledger.fundedRounds) {
    requireNonNegativeInteger(funded.round, 'Funded round');
    requireNonNegativeWei(funded.spendWei, 'Funded spend');
    const fundedAtMs = parsedTimestamp(funded.fundedAt, 'Funded time');
    if (fundedAtMs > nowMs) {
      throw new TypeError('Funded time cannot be later than the supplied clock');
    }
    if (funded.taskKey !== relayTaskKey(funded.generation, funded.round)) {
      throw new TypeError('Funded round task key does not match its generation and round');
    }
    if (fundedTaskKeys.has(funded.taskKey)) {
      throw new TypeError('Ambiguous duplicate funded task key');
    }
    fundedTaskKeys.add(funded.taskKey);
  }

  const taskKey = relayTaskKey(input.candidate.generation, input.candidate.round);
  if (fundedTaskKeys.has(taskKey)) {
    return { status: 'duplicate', taskKey };
  }

  if (input.candidate.round >= input.policy.maxRoundsPerGeneration) {
    return { status: 'exhausted', code: 'round-limit' };
  }

  const candidateActive = active.find(
    ({ generation }) => generation === input.candidate.generation,
  );
  if (
    candidateActive !== undefined
    && (
      !sameGitHubName(candidateActive.repository, input.candidate.repository)
      || !sameGitHubName(candidateActive.authorLogin, input.candidate.authorLogin)
    )
  ) {
    throw new TypeError('Ambiguous active generation metadata');
  }
  if (candidateActive !== undefined && nowMs >= candidateActive.deadlineMs) {
    return { status: 'exhausted', code: 'deadline' };
  }

  let generationSpendWei = 0n;
  for (const funded of input.ledger.fundedRounds) {
    if (funded.generation !== input.candidate.generation) {
      continue;
    }
    if (
      !sameGitHubName(funded.repository, input.candidate.repository)
      || !sameGitHubName(funded.authorLogin, input.candidate.authorLogin)
    ) {
      throw new TypeError('Ambiguous funded generation metadata');
    }
    generationSpendWei += funded.spendWei;
  }
  if (
    generationSpendWei + input.candidate.proposedSpendWei
    > input.policy.maxGenerationSpendWei
  ) {
    return { status: 'exhausted', code: 'generation-spend-limit' };
  }

  if (candidateActive === undefined) {
    const currentlyActive = active.filter(({ deadlineMs }) => deadlineMs > nowMs);
    if (currentlyActive.length >= input.policy.maxGlobalActiveGenerations) {
      return { status: 'deferred', code: 'global-active-limit' };
    }
    if (
      currentlyActive.filter(
        ({ repository }) => sameGitHubName(repository, input.candidate.repository),
      ).length >= input.policy.maxActivePerRepository
    ) {
      return { status: 'deferred', code: 'repository-active-limit' };
    }
    if (
      currentlyActive.filter(
        ({ authorLogin }) => sameGitHubName(authorLogin, input.candidate.authorLogin),
      ).length >= input.policy.maxActivePerAuthor
    ) {
      return { status: 'deferred', code: 'author-active-limit' };
    }
  }

  const dayStartMs = Date.UTC(
    input.now.getUTCFullYear(),
    input.now.getUTCMonth(),
    input.now.getUTCDate(),
  );
  const nextDayStartMs = dayStartMs + 24 * 60 * 60 * 1_000;
  let dailySpendWei = 0n;
  for (const funded of input.ledger.fundedRounds) {
    const fundedAtMs = Date.parse(funded.fundedAt);
    if (fundedAtMs >= dayStartMs && fundedAtMs < nextDayStartMs) {
      dailySpendWei += funded.spendWei;
    }
  }
  if (
    dailySpendWei + input.candidate.proposedSpendWei
    > input.policy.maxGlobalSpendWeiPerUtcDay
  ) {
    return { status: 'deferred', code: 'daily-spend-limit' };
  }

  return { status: 'admitted', taskKey };
}
