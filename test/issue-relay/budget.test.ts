import { describe, expect, it } from 'vitest';
import {
  admitRelaySpend,
  type RelayBudgetPolicy,
  type RelaySpendLedger,
} from '../../src/issue-relay/budget.js';

const policy: RelayBudgetPolicy = {
  maxGlobalActiveGenerations: 3,
  maxActivePerRepository: 2,
  maxActivePerAuthor: 1,
  maxRoundsPerGeneration: 3,
  maxGenerationSpendWei: 100n,
  maxGlobalSpendWeiPerUtcDay: 200n,
  generationDeadlineMs: 60 * 60 * 1_000,
};

const emptyLedger: RelaySpendLedger = {
  activeGenerations: [],
  fundedRounds: [],
};

const candidate = {
  generation: 'R_kgDOCandidate:42:sha256:candidate',
  repository: 'Jinn-Network/mono',
  authorLogin: 'Alice',
  round: 0,
  proposedSpendWei: 40n,
};

const now = new Date('2026-07-28T12:00:00.000Z');

describe('Relay spend idempotency and concurrency', () => {
  it('returns duplicate for the canonical task key before applying other limits', () => {
    const taskKey = 'issue-relay:R_kgDOCandidate:42:sha256:candidate:round:0';
    const decision = admitRelaySpend({
      policy: {
        ...policy,
        maxGlobalActiveGenerations: 0,
        maxGenerationSpendWei: 0n,
        maxGlobalSpendWeiPerUtcDay: 0n,
      },
      ledger: {
        activeGenerations: [],
        fundedRounds: [{
          taskKey,
          generation: candidate.generation,
          repository: candidate.repository,
          authorLogin: candidate.authorLogin,
          round: 0,
          spendWei: 40n,
          fundedAt: '2026-07-28T11:00:00.000Z',
        }],
      },
      candidate,
      now,
    });

    expect(decision).toEqual({ status: 'duplicate', taskKey });
  });

  it('defers at the global active-generation limit and admits one below it', () => {
    const active = [
      {
        generation: 'generation-a',
        repository: 'other/a',
        authorLogin: 'one',
        deadlineAt: '2026-07-28T13:00:00.000Z',
      },
      {
        generation: 'generation-b',
        repository: 'other/b',
        authorLogin: 'two',
        deadlineAt: '2026-07-28T13:00:00.000Z',
      },
      {
        generation: 'generation-c',
        repository: 'other/c',
        authorLogin: 'three',
        deadlineAt: '2026-07-28T13:00:00.000Z',
      },
    ];

    expect(admitRelaySpend({
      policy,
      ledger: { ...emptyLedger, activeGenerations: active },
      candidate,
      now,
    })).toEqual({ status: 'deferred', code: 'global-active-limit' });
    expect(admitRelaySpend({
      policy,
      ledger: { ...emptyLedger, activeGenerations: active.slice(0, 2) },
      candidate,
      now,
    })).toEqual({
      status: 'admitted',
      taskKey: 'issue-relay:R_kgDOCandidate:42:sha256:candidate:round:0',
    });
  });

  it('defers at the case-insensitive per-repository active limit', () => {
    const decision = admitRelaySpend({
      policy,
      ledger: {
        ...emptyLedger,
        activeGenerations: [
          {
            generation: 'generation-a',
            repository: 'jinn-network/MONO',
            authorLogin: 'Bob',
            deadlineAt: '2026-07-28T13:00:00.000Z',
          },
          {
            generation: 'generation-b',
            repository: 'JINN-NETWORK/mono',
            authorLogin: 'Carol',
            deadlineAt: '2026-07-28T13:00:00.000Z',
          },
        ],
      },
      candidate,
      now,
    });

    expect(decision).toEqual({
      status: 'deferred',
      code: 'repository-active-limit',
    });
  });

  it('defers at the case-insensitive per-author active limit', () => {
    const decision = admitRelaySpend({
      policy,
      ledger: {
        ...emptyLedger,
        activeGenerations: [{
          generation: 'generation-a',
          repository: 'other/repository',
          authorLogin: 'aLiCe',
          deadlineAt: '2026-07-28T13:00:00.000Z',
        }],
      },
      candidate,
      now,
    });

    expect(decision).toEqual({ status: 'deferred', code: 'author-active-limit' });
  });

  it('does not count an entry whose deadline is exactly now as active', () => {
    const decision = admitRelaySpend({
      policy: { ...policy, maxGlobalActiveGenerations: 1 },
      ledger: {
        ...emptyLedger,
        activeGenerations: [{
          generation: 'expired-generation',
          repository: 'other/repository',
          authorLogin: 'Bob',
          deadlineAt: '2026-07-28T12:00:00.000Z',
        }],
      },
      candidate,
      now,
    });

    expect(decision.status).toBe('admitted');
  });
});

describe('Relay generation exhaustion', () => {
  it('rejects a funded continuation without its durable active deadline record', () => {
    const ledger: RelaySpendLedger = {
      activeGenerations: [],
      fundedRounds: [{
        taskKey: 'issue-relay:R_kgDOCandidate:42:sha256:candidate:round:0',
        generation: candidate.generation,
        repository: candidate.repository,
        authorLogin: candidate.authorLogin,
        round: 0,
        spendWei: 40n,
        fundedAt: '2026-07-28T11:00:00.000Z',
      }],
    };

    expect(() => admitRelaySpend({
      policy,
      ledger,
      candidate: { ...candidate, round: 1 },
      now,
    })).toThrow(/continuation.*active generation/i);
  });

  it('admits the last zero-based round and exhausts the configured round count', () => {
    const activeLedger: RelaySpendLedger = {
      activeGenerations: [{
        generation: candidate.generation,
        repository: candidate.repository,
        authorLogin: candidate.authorLogin,
        deadlineAt: '2026-07-28T13:00:00.000Z',
      }],
      fundedRounds: [],
    };

    expect(admitRelaySpend({
      policy,
      ledger: activeLedger,
      candidate: { ...candidate, round: 2 },
      now,
    }).status).toBe('admitted');
    expect(admitRelaySpend({
      policy,
      ledger: activeLedger,
      candidate: { ...candidate, round: 3 },
      now,
    })).toEqual({ status: 'exhausted', code: 'round-limit' });
  });

  it('admits just before the generation deadline and exhausts at the instant', () => {
    const activeLedger: RelaySpendLedger = {
      activeGenerations: [{
        generation: candidate.generation,
        repository: candidate.repository,
        authorLogin: candidate.authorLogin,
        deadlineAt: '2026-07-28T12:00:00.000Z',
      }],
      fundedRounds: [],
    };

    expect(admitRelaySpend({
      policy,
      ledger: activeLedger,
      candidate,
      now: new Date('2026-07-28T11:59:59.999Z'),
    }).status).toBe('admitted');
    expect(admitRelaySpend({
      policy,
      ledger: activeLedger,
      candidate,
      now,
    })).toEqual({ status: 'exhausted', code: 'deadline' });
  });

  it('admits exact generation spend and exhausts one wei over without clamping', () => {
    const ledger: RelaySpendLedger = {
      activeGenerations: [{
        generation: candidate.generation,
        repository: candidate.repository,
        authorLogin: candidate.authorLogin,
        deadlineAt: '2026-07-28T13:00:00.000Z',
      }],
      fundedRounds: [{
        taskKey: 'issue-relay:R_kgDOCandidate:42:sha256:candidate:round:0',
        generation: candidate.generation,
        repository: candidate.repository,
        authorLogin: candidate.authorLogin,
        round: 0,
        spendWei: 60n,
        fundedAt: '2026-07-27T11:00:00.000Z',
      }],
    };

    expect(admitRelaySpend({
      policy,
      ledger,
      candidate: { ...candidate, round: 1, proposedSpendWei: 40n },
      now,
    }).status).toBe('admitted');
    expect(admitRelaySpend({
      policy,
      ledger,
      candidate: { ...candidate, round: 1, proposedSpendWei: 41n },
      now,
    })).toEqual({ status: 'exhausted', code: 'generation-spend-limit' });
  });
});

describe('Relay UTC-day spend accounting', () => {
  it('includes midnight UTC and excludes the preceding millisecond', () => {
    const ledger: RelaySpendLedger = {
      activeGenerations: [],
      fundedRounds: [
        {
          taskKey: 'issue-relay:previous-day:round:0',
          generation: 'previous-day',
          repository: 'other/repository',
          authorLogin: 'Bob',
          round: 0,
          spendWei: 1_000n,
          fundedAt: '2026-07-27T23:59:59.999Z',
        },
        {
          taskKey: 'issue-relay:today:round:0',
          generation: 'today',
          repository: 'other/repository',
          authorLogin: 'Carol',
          round: 0,
          spendWei: 160n,
          fundedAt: '2026-07-28T00:00:00.000Z',
        },
      ],
    };

    expect(admitRelaySpend({
      policy,
      ledger,
      candidate,
      now,
    }).status).toBe('admitted');
    expect(admitRelaySpend({
      policy,
      ledger,
      candidate: { ...candidate, proposedSpendWei: 41n },
      now,
    })).toEqual({ status: 'deferred', code: 'daily-spend-limit' });
  });

  it('starts a new UTC accounting day exactly at the next midnight', () => {
    const ledger: RelaySpendLedger = {
      activeGenerations: [],
      fundedRounds: [{
        taskKey: 'issue-relay:previous-day:round:0',
        generation: 'previous-day',
        repository: 'other/repository',
        authorLogin: 'Bob',
        round: 0,
        spendWei: 200n,
        fundedAt: '2026-07-28T23:59:59.999Z',
      }],
    };

    expect(admitRelaySpend({
      policy,
      ledger,
      candidate,
      now: new Date('2026-07-29T00:00:00.000Z'),
    }).status).toBe('admitted');
  });
});

describe('Relay spend ledger validation', () => {
  it('fails closed on conflicting active metadata for the candidate generation', () => {
    expect(() => admitRelaySpend({
      policy,
      ledger: {
        activeGenerations: [{
          generation: candidate.generation,
          repository: 'other/repository',
          authorLogin: candidate.authorLogin,
          deadlineAt: '2026-07-28T13:00:00.000Z',
        }],
        fundedRounds: [],
      },
      candidate: { ...candidate, round: 1 },
      now,
    })).toThrow(/ambiguous active generation/i);
  });

  it('fails closed on negative spend rather than silently changing it', () => {
    expect(() => admitRelaySpend({
      policy,
      ledger: emptyLedger,
      candidate: { ...candidate, proposedSpendWei: -1n },
      now,
    })).toThrow(/proposed spend/i);
  });

  it.each([
    ['numeric shorthand', '0'],
    ['an impossible date', '2026-02-30T13:00:00.000Z'],
    ['a non-UTC offset', '2026-07-28T14:00:00.000+01:00'],
  ])('rejects a generation deadline using %s', (_name, deadlineAt) => {
    expect(() => admitRelaySpend({
      policy,
      ledger: {
        activeGenerations: [{
          generation: candidate.generation,
          repository: candidate.repository,
          authorLogin: candidate.authorLogin,
          deadlineAt,
        }],
        fundedRounds: [],
      },
      candidate,
      now,
    })).toThrow(/generation deadline.*canonical UTC/i);
  });

  it.each([
    ['numeric shorthand', '0'],
    ['an impossible date', '2026-02-30T11:00:00.000Z'],
    ['a non-UTC offset', '2026-07-28T12:00:00.000+01:00'],
    ['a future time', '2026-07-28T12:00:00.001Z'],
  ])('rejects a funding time using %s', (_name, fundedAt) => {
    expect(() => admitRelaySpend({
      policy,
      ledger: {
        activeGenerations: [],
        fundedRounds: [{
          taskKey: 'issue-relay:other-generation:round:0',
          generation: 'other-generation',
          repository: 'other/repository',
          authorLogin: 'Bob',
          round: 0,
          spendWei: 1n,
          fundedAt,
        }],
      },
      candidate,
      now,
    })).toThrow(/funded time/i);
  });

  it('fails closed on contradictory metadata for an unrelated generation', () => {
    expect(() => admitRelaySpend({
      policy,
      ledger: {
        activeGenerations: [{
          generation: 'unrelated-generation',
          repository: 'other/repository',
          authorLogin: 'Bob',
          deadlineAt: '2026-07-28T13:00:00.000Z',
        }],
        fundedRounds: [{
          taskKey: 'issue-relay:unrelated-generation:round:0',
          generation: 'unrelated-generation',
          repository: 'different/repository',
          authorLogin: 'Carol',
          round: 0,
          spendWei: 1n,
          fundedAt: '2026-07-28T11:00:00.000Z',
        }],
      },
      candidate,
      now,
    })).toThrow(/conflicting generation metadata/i);
  });

  it('fails closed on duplicate active records for an unrelated generation', () => {
    expect(() => admitRelaySpend({
      policy,
      ledger: {
        activeGenerations: [
          {
            generation: 'unrelated-generation',
            repository: 'other/repository',
            authorLogin: 'Bob',
            deadlineAt: '2026-07-28T13:00:00.000Z',
          },
          {
            generation: 'unrelated-generation',
            repository: 'other/repository',
            authorLogin: 'Bob',
            deadlineAt: '2026-07-28T13:00:00.000Z',
          },
        ],
        fundedRounds: [],
      },
      candidate,
      now,
    })).toThrow(/ambiguous active generation/i);
  });
});
