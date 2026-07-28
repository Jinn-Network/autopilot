import { describe, expect, it } from 'vitest';
import { relayGeneration, relayTaskKey } from '../../src/issue-relay/identity.js';
import { buildRelaySnapshot } from '../../src/issue-relay/snapshot.js';
import type { RelayIssueInput } from '../../src/issue-relay/snapshot.js';
import {
  deriveRelayAction,
  type RelayAuthoritativeFacts,
  type RelayGenerationRecordV1,
  type RelayPhase,
  type RelayRoundRecordV1,
} from '../../src/issue-relay/state.js';

const BASE = '1111111111111111111111111111111111111111';
const HEAD = '2222222222222222222222222222222222222222';
const STALE = '3333333333333333333333333333333333333333';
const DIGEST = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

const issueInput: RelayIssueInput = {
  repository: {
    slug: 'Jinn-Network/mono',
    nodeId: 'R_kgDOExample',
    visibility: 'PUBLIC',
    defaultBranch: 'main',
    baseOid: BASE,
  },
  issue: {
    number: 42,
    url: 'https://github.com/Jinn-Network/mono/issues/42',
    title: 'Fix the relay',
    body: '## Acceptance\n\n- [ ] exact-head evaluation passes',
    authorLogin: 'alice',
    authorId: 'U_kgDOAlice',
    updatedAt: '2026-07-28T12:00:00.000Z',
  },
  optIn: {
    label: 'engine:marketplace',
    actorLogin: 'alice',
    createdAt: '2026-07-28T12:00:01.000Z',
    permission: 'MAINTAIN',
  },
  language: 'typescript',
  verificationProfile: 'jinn-mono.v1',
  acceptanceEvidence: ['exact-head evaluation passes'],
  admissionPolicyVersion: 'jinn-issue-relay-admission.v1',
  capturedAt: '2026-07-28T12:00:02.000Z',
};

const snapshot = buildRelaySnapshot(issueInput);
const generation = relayGeneration(snapshot);

const task = {
  taskKey: relayTaskKey(generation, 0),
  taskId: 'task-0',
  taskCid: 'bafy-task-0',
  fundedAt: '2026-07-28T12:05:00.000Z',
};
const solution = {
  envelopeCid: 'bafy-solution-0',
  operatorSafe: '0x1111111111111111111111111111111111111111',
  observedAt: '2026-07-28T12:10:00.000Z',
};
const adoption = {
  disposition: 'accepted' as const,
  resultingHead: HEAD,
  receiptDigest: DIGEST,
};
const passedChecks = {
  head: HEAD,
  status: 'passed' as const,
  digest: DIGEST,
};
const passingVerdict = {
  outcome: 'pass' as const,
  evaluatedHead: HEAD,
  envelopeCid: 'bafy-verdict-pass',
};
const repairVerdict = {
  outcome: 'request-changes' as const,
  evaluatedHead: HEAD,
  envelopeCid: 'bafy-verdict-repair',
};

function completedInitialRound(): RelayRoundRecordV1 {
  return round({
    task,
    solution,
    adoption,
    checks: passedChecks,
    verdict: repairVerdict,
  });
}

function deliveredRepairRound(inputHead: string): RelayRoundRecordV1 {
  return {
    round: 1,
    purpose: 'repair',
    workspaceRepository: 'Jinn-Network/mono-fork',
    inputHead,
    task: {
      taskKey: relayTaskKey(generation, 1),
      taskId: 'task-1',
      taskCid: 'bafy-task-1',
      fundedAt: '2026-07-28T12:21:00.000Z',
    },
    solution: {
      envelopeCid: 'bafy-solution-1',
      operatorSafe: '0x1111111111111111111111111111111111111111',
      observedAt: '2026-07-28T12:25:00.000Z',
    },
  };
}

function round(overrides: Partial<RelayRoundRecordV1> = {}): RelayRoundRecordV1 {
  return {
    round: 0,
    purpose: 'initial',
    workspaceRepository: 'Jinn-Network/mono',
    inputHead: BASE,
    ...overrides,
  };
}

function durable(
  phase: RelayPhase,
  overrides: Partial<RelayGenerationRecordV1> = {},
): RelayGenerationRecordV1 {
  return {
    schemaVersion: 'jinn-issue-relay-generation.v1',
    generation,
    snapshot,
    phase,
    deadlineAt: '2026-07-28T13:00:02.000Z',
    rounds: [],
    updatedAt: '2026-07-28T12:20:00.000Z',
    ...overrides,
  };
}

function facts(
  record: RelayGenerationRecordV1 | undefined,
  overrides: Partial<RelayAuthoritativeFacts> = {},
): RelayAuthoritativeFacts {
  return {
    ...(record === undefined ? {} : { durable: record }),
    issue: { open: true, optedIn: true },
    currentBaseOid: BASE,
    now: '2026-07-28T12:30:00.000Z',
    ...overrides,
  };
}

const policy = {
  maxRoundsPerGeneration: 3,
  generationDeadlineMs: 60 * 60 * 1_000,
};

describe('Relay state/action transition table', () => {
  it('missing durable snapshot -> publish-snapshot', () => {
    expect(deriveRelayAction(facts(undefined), policy))
      .toEqual({ kind: 'publish-snapshot' });
  });

  it('missing durable snapshot plus absent opt-in -> none', () => {
    expect(deriveRelayAction(facts(undefined, {
      issue: { open: true, optedIn: false },
    }), policy)).toMatchObject({ kind: 'none' });
  });

  it('admitted with exact base -> submit-round 0', () => {
    expect(deriveRelayAction(facts(durable('admitted')), policy))
      .toEqual({ kind: 'submit-round', round: 0 });
  });

  it('admitted with a stale snapshot base -> none', () => {
    expect(deriveRelayAction(facts(durable('admitted'), {
      currentBaseOid: STALE,
    }), policy)).toMatchObject({ kind: 'none' });
  });

  it('admitted with a zero-round budget -> close-exhausted', () => {
    expect(deriveRelayAction(facts(durable('admitted')), {
      ...policy,
      maxRoundsPerGeneration: 0,
    })).toEqual({ kind: 'close-exhausted' });
  });

  it('submitted with funded task evidence -> observe-solution', () => {
    const record = durable('submitted', { rounds: [round({ task })] });

    expect(deriveRelayAction(facts(record), policy))
      .toEqual({ kind: 'observe-solution', round: 0 });
  });

  it('solution-delivered with authenticated delivery -> adopt-solution', () => {
    const record = durable('solution-delivered', {
      rounds: [round({ task, solution })],
    });

    expect(deriveRelayAction(facts(record), policy))
      .toEqual({ kind: 'adopt-solution', round: 0 });
  });

  it('solution-delivered without authenticated delivery evidence -> none', () => {
    const record = durable('solution-delivered', {
      rounds: [round({ task })],
    });

    expect(deriveRelayAction(facts(record), policy)).toMatchObject({ kind: 'none' });
  });

  it('repair delivery with an arbitrary input head cannot be adopted', () => {
    const record = durable('solution-delivered', {
      rounds: [completedInitialRound(), deliveredRepairRound(STALE)],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: STALE, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: { number: 68, head: STALE, draft: true },
    }), policy)).toMatchObject({ kind: 'none' });
  });

  it.each([
    ['missing durable PR', undefined, { number: 68, head: HEAD, draft: true }],
    [
      'different live PR number',
      { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
      { number: 69, head: HEAD, draft: true },
    ],
    [
      'non-draft live PR',
      { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
      { number: 68, head: HEAD, draft: false },
    ],
  ] as const)('repair delivery with %s cannot be adopted', (_label, pr, currentPr) => {
    const record = durable('solution-delivered', {
      rounds: [completedInitialRound(), deliveredRepairRound(HEAD)],
      ...(pr === undefined ? {} : { pr }),
    });

    expect(deriveRelayAction(facts(record, { currentPr }), policy))
      .toMatchObject({ kind: 'none' });
  });

  it('draft-open with accepted adoption and passed exact-head checks -> publish-evaluation-anchor', () => {
    const record = durable('draft-open', {
      rounds: [round({ task, solution, adoption, checks: passedChecks })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: { number: 68, head: HEAD, draft: true },
    }), policy)).toEqual({ kind: 'publish-evaluation-anchor', round: 0 });
  });

  it.each([
    ['missing adoption', round({ task, solution, checks: passedChecks })],
    ['rejected adoption', round({
      task,
      solution,
      adoption: { disposition: 'rejected', receiptDigest: DIGEST },
      checks: passedChecks,
    })],
    ['missing checks', round({ task, solution, adoption })],
    ['pending checks', round({
      task,
      solution,
      adoption,
      checks: { ...passedChecks, status: 'pending' },
    })],
    ['failed checks', round({
      task,
      solution,
      adoption,
      checks: { ...passedChecks, status: 'failed' },
    })],
  ])('draft-open with %s -> none', (_label, currentRound) => {
    const record = durable('draft-open', {
      rounds: [currentRound],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: { number: 68, head: HEAD, draft: true },
    }), policy)).toMatchObject({ kind: 'none' });
  });

  it('draft-open cannot skip authenticated delivery evidence -> none', () => {
    const record = durable('draft-open', {
      rounds: [round({ adoption, checks: passedChecks })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: { number: 68, head: HEAD, draft: true },
    }), policy)).toMatchObject({ kind: 'none' });
  });

  it('draft-open with a stale live PR head -> none', () => {
    const record = durable('draft-open', {
      rounds: [round({ task, solution, adoption, checks: passedChecks })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: { number: 68, head: STALE, draft: true },
    }), policy)).toMatchObject({ kind: 'none' });
  });

  it('evaluating with an exact anchor and no verdict -> observe-verdict', () => {
    const record = durable('evaluating', {
      rounds: [round({ task, solution, adoption, checks: passedChecks })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: { number: 68, head: HEAD, draft: true },
    }), policy)).toEqual({ kind: 'observe-verdict', round: 0 });
  });

  it('evaluating with a passing exact-head verdict -> mark-ready', () => {
    const record = durable('evaluating', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: passingVerdict,
      })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: { number: 68, head: HEAD, draft: true },
    }), policy)).toEqual({ kind: 'mark-ready' });
  });

  it('evaluating with pass on a stale live head -> none', () => {
    const record = durable('evaluating', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: passingVerdict,
      })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: { number: 68, head: STALE, draft: true },
    }), policy)).toMatchObject({ kind: 'none' });
  });

  it('evaluating with pass after the base advances -> none', () => {
    const record = durable('evaluating', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: passingVerdict,
      })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentBaseOid: STALE,
      currentPr: { number: 68, head: HEAD, draft: true },
    }), policy)).toMatchObject({ kind: 'none' });
  });

  it('repair-needed with request changes -> submit-repair for the next round', () => {
    const record = durable('repair-needed', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: repairVerdict,
      })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: { number: 68, head: HEAD, draft: true },
    }), policy)).toEqual({ kind: 'submit-repair', round: 1 });
  });

  it('repair-needed at the round limit -> close-exhausted', () => {
    const record = durable('repair-needed', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: repairVerdict,
      })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: { number: 68, head: HEAD, draft: true },
    }), { ...policy, maxRoundsPerGeneration: 1 }))
      .toEqual({ kind: 'close-exhausted' });
  });

  it('repair-needed at its immutable deadline -> close-exhausted', () => {
    const record = durable('repair-needed', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: repairVerdict,
      })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: { number: 68, head: HEAD, draft: true },
      now: '2026-07-28T13:00:02.000Z',
    }), policy)).toEqual({ kind: 'close-exhausted' });
  });

  it('uses the durable deadline instead of recomputing it from policy on continuation', () => {
    const record = durable('repair-needed', {
      deadlineAt: '2026-07-28T13:00:02.000Z',
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: repairVerdict,
      })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: { number: 68, head: HEAD, draft: true },
    }), { ...policy, generationDeadlineMs: 1 }))
      .toEqual({ kind: 'submit-repair', round: 1 });
    expect(record.deadlineAt).toBe('2026-07-28T13:00:02.000Z');
  });

  it.each([
    ['closed issue', { open: false, optedIn: true }],
    ['removed label', { open: true, optedIn: false }],
  ])('%s after funding dominates a passing verdict -> finish-cancellation', (
    _label,
    issue,
  ) => {
    const record = durable('evaluating', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: passingVerdict,
      })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      issue,
      currentPr: { number: 68, head: HEAD, draft: true },
    }), policy)).toEqual({ kind: 'finish-cancellation' });
  });

  it('cancelling with funded work -> finish-cancellation', () => {
    const record = durable('cancelling', {
      rounds: [round({ task })],
      cancellation: {
        requestedAt: '2026-07-28T12:25:00.000Z',
        reason: 'operator',
      },
    });

    expect(deriveRelayAction(facts(record), policy))
      .toEqual({ kind: 'finish-cancellation' });
  });

  it.each([
    ['awaiting-clarification', durable('awaiting-clarification')],
    ['refused', durable('refused')],
    ['ready', durable('ready', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: passingVerdict,
      })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: false },
    })],
    ['closed', durable('closed')],
    ['exhausted', durable('exhausted')],
  ] as const)('%s terminal -> none', (_phase, record) => {
    expect(deriveRelayAction(facts(record), policy)).toMatchObject({ kind: 'none' });
  });

  it.each([
    ['invalid now', facts(durable('admitted'), { now: 'not-a-time' })],
    ['missing immutable deadline', facts({
      ...durable('admitted'),
      deadlineAt: undefined,
    } as unknown as RelayGenerationRecordV1)],
  ])('%s fails closed -> none', (_label, inputFacts) => {
    expect(deriveRelayAction(inputFacts, policy)).toMatchObject({ kind: 'none' });
  });
});
