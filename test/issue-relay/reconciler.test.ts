import { describe, expect, it, vi } from 'vitest';
import {
  IssueRelayRateLimitError,
  runIssueRelayCycle,
  type RelayReconciliationCandidate,
  type RelayReconciliationPort,
} from '../../src/issue-relay/reconciler.js';
import type { IssueRelayRuntimePorts } from '../../src/issue-relay/reconciler.js';
import type { RelayAuthoritativeFacts } from '../../src/issue-relay/state.js';

const oid = (character: string): string => character.repeat(40);

function facts(
  generation: string,
  issueNumber: number,
  updatedAt: string,
): RelayAuthoritativeFacts {
  return {
    durable: {
      schemaVersion: 'jinn-issue-relay-generation.v1',
      generation,
      snapshot: {
        repository: {
          slug: 'Jinn-Network/mono',
          nodeId: 'R_1',
          visibility: 'PUBLIC',
          defaultBranch: 'main',
          baseOid: oid('a'),
        },
        issue: {
          number: issueNumber,
          url: `https://github.com/Jinn-Network/mono/issues/${issueNumber}`,
          title: `Issue ${issueNumber}`,
          body: '- [ ] done',
          authorLogin: 'maintainer',
          authorId: 'U_1',
          updatedAt: '2026-07-28T00:00:00.000Z',
        },
        optIn: {
          label: 'engine:marketplace',
          actorLogin: 'maintainer',
          createdAt: '2026-07-28T00:00:01.000Z',
          permission: 'WRITE',
        },
        language: 'typescript',
        verificationProfile: 'jinn-mono.v1',
        acceptanceEvidence: ['done'],
        admissionPolicyVersion: 'jinn-issue-relay-admission.v1',
        capturedAt: '2026-07-28T00:00:02.000Z',
        schemaVersion: 'jinn-issue-relay-snapshot.v1',
        snapshotDigest:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      phase: 'admitted',
      deadlineAt: '2026-07-29T00:00:02.000Z',
      rounds: [],
      updatedAt,
    },
    issue: { open: true, optedIn: true },
    currentBaseOid: oid('a'),
    now: '2026-07-28T01:00:00.000Z',
  };
}

function candidate(
  generation: string,
  issueNumber: number,
  transitionedAt: string,
): RelayReconciliationCandidate {
  return {
    generation,
    repository: 'Jinn-Network/mono',
    issueNumber,
    transitionedAt,
    authority: 'github',
    facts: facts(generation, issueNumber, transitionedAt),
  };
}

function ports(
  reconciliation: RelayReconciliationPort,
  mode: 'observe' | 'recover' | 'active' = 'active',
): IssueRelayRuntimePorts {
  return {
    mode,
    config: {
      schemaVersion: 1,
      repository: 'Jinn-Network/mono',
      label: 'engine:marketplace',
      relayBotLogin: 'jinn-relay',
      managedForkRepository: 'jinn-relay/mono',
      targetBase: 'main',
      solverNet: 'jinn-repo',
      verificationProfile: 'jinn-mono.v1',
      requiredChecks: [],
      pollSeconds: 30,
      budget: {
        maxGlobalActiveGenerations: 20,
        maxActivePerRepository: 10,
        maxActivePerAuthor: 2,
        maxRoundsPerGeneration: 5,
        maxGenerationSpendWei: 1n,
        maxGlobalSpendWeiPerUtcDay: 10n,
        generationDeadlineMs: 86_400_000,
      },
    },
    githubRead: {} as IssueRelayRuntimePorts['githubRead'],
    githubWrite: {} as IssueRelayRuntimePorts['githubWrite'],
    marketplace: {} as IssueRelayRuntimePorts['marketplace'],
    adopter: {} as IssueRelayRuntimePorts['adopter'],
    artifacts: {
      installImmutable: vi.fn(),
      read: vi.fn(() => {
        throw new Error('local cache must not be read as authority');
      }),
    },
    reconciliation,
    now: () => new Date('2026-07-28T01:00:00.000Z'),
  };
}

describe('runIssueRelayCycle', () => {
  it('executes one action per generation in oldest transition order and rereads', async () => {
    const calls: string[] = [];
    const later = candidate('generation-b', 20, '2026-07-28T00:20:00.000Z');
    const olderHigherIssue = candidate(
      'generation-c',
      30,
      '2026-07-28T00:10:00.000Z',
    );
    const olderLowerIssue = candidate(
      'generation-a',
      10,
      '2026-07-28T00:10:00.000Z',
    );
    const reconciliation: RelayReconciliationPort = {
      scan: vi.fn(async () => [later, olderHigherIssue, olderLowerIssue]),
      reread: vi.fn(async (input) => {
        calls.push(`read:${input.generation}`);
        return input;
      }),
      execute: vi.fn(async ({ candidate: input, action }) => {
        calls.push(`write:${input.generation}:${action.kind}`);
        return {
          outcome: 'completed' as const,
          detail: 'submitted idempotently',
        };
      }),
    };

    const report = await runIssueRelayCycle(ports(reconciliation));

    expect(calls).toEqual([
      'read:generation-a',
      'write:generation-a:prepare-round',
      'read:generation-a',
      'read:generation-c',
      'write:generation-c:prepare-round',
      'read:generation-c',
      'read:generation-b',
      'write:generation-b:prepare-round',
      'read:generation-b',
    ]);
    expect(report.actions).toHaveLength(3);
  });

  it('isolates ordinary generation failures but stops the pass on a rate limit', async () => {
    const first = candidate('generation-a', 1, '2026-07-28T00:00:00.000Z');
    const second = candidate('generation-b', 2, '2026-07-28T00:01:00.000Z');
    const third = candidate('generation-c', 3, '2026-07-28T00:02:00.000Z');
    const executed: string[] = [];
    const reconciliation: RelayReconciliationPort = {
      scan: vi.fn(async () => [first, second, third]),
      reread: vi.fn(async (input) => input),
      execute: vi.fn(async ({ candidate: input }) => {
        executed.push(input.generation);
        if (input.generation === 'generation-a') throw new Error('bad generation');
        if (input.generation === 'generation-b') {
          throw new IssueRelayRateLimitError('GitHub search exhausted');
        }
        return { outcome: 'completed' as const, detail: 'unexpected' };
      }),
    };

    const report = await runIssueRelayCycle(ports(reconciliation));

    expect(executed).toEqual(['generation-a', 'generation-b']);
    expect(report.actions.map(({ outcome }) => outcome)).toEqual([
      'failed',
      'failed',
    ]);
  });

  it('observes without writes and recover mode never discovers or funds', async () => {
    const item = candidate('generation-a', 1, '2026-07-28T00:00:00.000Z');
    const reconciliation: RelayReconciliationPort = {
      scan: vi.fn(async () => [item]),
      reread: vi.fn(async (input) => input),
      execute: vi.fn(async () => ({
        outcome: 'completed' as const,
        detail: 'must not run',
      })),
    };

    const observed = await runIssueRelayCycle(ports(reconciliation, 'observe'));
    expect(reconciliation.scan).toHaveBeenCalledWith({
      discover: true,
      recover: true,
    });
    expect(reconciliation.execute).not.toHaveBeenCalled();
    expect(observed.actions[0]).toMatchObject({
      action: 'prepare-round',
      outcome: 'pending',
    });

    await runIssueRelayCycle(ports(reconciliation, 'recover'));
    expect(reconciliation.scan).toHaveBeenLastCalledWith({
      discover: false,
      recover: true,
    });
    expect(reconciliation.execute).not.toHaveBeenCalled();
  });

  it('rejects cache-derived and ambiguous durable authority', async () => {
    const cache = {
      ...candidate('cache', 1, '2026-07-28T00:00:00.000Z'),
      authority: 'cache' as const,
    };
    const ambiguous = {
      ...candidate('ambiguous', 2, '2026-07-28T00:00:01.000Z'),
      authority: 'ambiguous' as const,
    };
    const reconciliation: RelayReconciliationPort = {
      scan: vi.fn(async () => [cache, ambiguous]),
      reread: vi.fn(async (input) => input),
      execute: vi.fn(),
    };

    const report = await runIssueRelayCycle(ports(reconciliation));

    expect(reconciliation.execute).not.toHaveBeenCalled();
    expect(report.actions.map(({ outcome }) => outcome)).toEqual([
      'failed',
      'failed',
    ]);
  });

  it('replays an ambiguous prior mutation only through authoritative reread', async () => {
    const item = candidate('generation-a', 1, '2026-07-28T00:00:00.000Z');
    const execute = vi.fn(async () => ({
      outcome: 'pending' as const,
      detail: 'submission transport ambiguous; deterministic readback pending',
    }));
    const reconciliation: RelayReconciliationPort = {
      scan: vi.fn(async () => [item]),
      reread: vi.fn(async (input) => input),
      execute,
    };

    await runIssueRelayCycle(ports(reconciliation));
    await runIssueRelayCycle(ports(reconciliation));

    expect(execute).toHaveBeenCalledTimes(2);
    expect(reconciliation.reread).toHaveBeenCalledTimes(4);
  });
});
