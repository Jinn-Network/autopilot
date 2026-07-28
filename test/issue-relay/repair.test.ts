import { describe, expect, it } from 'vitest';
import type { RelaySpendDecision } from '../../src/issue-relay/budget.js';
import type {
  IssueRelayFindingV1,
  IssueRelayVerdictV1,
} from '../../src/issue-relay/contracts.js';
import {
  relayBranch,
  relayGeneration,
  relayTaskKey,
} from '../../src/issue-relay/identity.js';
import { buildRelayRepair } from '../../src/issue-relay/repair.js';
import { buildRelaySnapshot } from '../../src/issue-relay/snapshot.js';

const BASE = '1111111111111111111111111111111111111111';
const HEAD = '2222222222222222222222222222222222222222';
const MANAGED_FORK = 'jinn-relay/mono';

const snapshot = buildRelaySnapshot({
  repository: {
    slug: 'Jinn-Network/mono',
    nodeId: 'R_kgDOExample',
    visibility: 'PUBLIC',
    defaultBranch: 'main',
    baseOid: BASE,
  },
  issue: {
    number: 101,
    url: 'https://github.com/Jinn-Network/mono/issues/101',
    title: 'Repair Relay',
    body: 'Keep the original frozen issue.',
    authorLogin: 'maintainer',
    authorId: 'MDQ6VXNlcjE=',
    updatedAt: '2026-07-28T10:00:00.000Z',
  },
  optIn: {
    label: 'engine:marketplace',
    actorLogin: 'maintainer',
    createdAt: '2026-07-28T10:01:00.000Z',
    permission: 'MAINTAIN',
  },
  language: 'typescript',
  verificationProfile: 'jinn-mono.v1',
  acceptanceEvidence: ['A regression test passes.'],
  admissionPolicyVersion: 'jinn-issue-relay-admission.v1',
  capturedAt: '2026-07-28T10:02:00.000Z',
});

const generation = relayGeneration(snapshot);
const finding: IssueRelayFindingV1 = {
  code: 'missing-regression',
  title: 'Add a regression test',
  detail: 'The cumulative head does not cover the reported failure.',
  path: 'test/relay.test.ts',
};
const repairVerdict: Extract<
  IssueRelayVerdictV1,
  { readonly outcome: 'request-changes' }
> = {
  schemaVersion: 'jinn-issue-relay-verdict.v1',
  outcome: 'request-changes',
  correlation: {
    generation,
    round: 0,
    snapshotDigest: snapshot.snapshotDigest,
    taskId: '123',
    attemptIndex: 0,
    requestId: 'request-0',
    deliveryEnvelopeCid: 'bafybeigdyrzt',
  },
  evaluatedHead: HEAD,
  summary: 'One actionable defect remains.',
  findings: [finding],
};

const admitted: RelaySpendDecision = {
  status: 'admitted',
  taskKey: relayTaskKey(generation, 1),
};
const authority = {
  generation,
  targetRepository: 'Jinn-Network/mono' as const,
  targetRepositoryId: 'R_target',
  forkRepositoryId: 'R_fork',
  forkParentRepositoryId: 'R_target',
  branch: relayBranch(generation),
  managedFork: true as const,
  workspaceRepository: MANAGED_FORK,
  visibility: 'PUBLIC' as const,
  prNumber: 68,
  currentHead: HEAD,
  open: true as const,
  draft: true as const,
};

function build(
  overrides: Partial<Parameters<typeof buildRelayRepair>[0]> = {},
) {
  return buildRelayRepair({
    snapshot,
    previousRound: 0,
    currentHead: HEAD,
    managedForkRepository: MANAGED_FORK,
    prNumber: 68,
    verdict: repairVerdict,
    budget: admitted,
    cancelled: false,
    authority,
    ...overrides,
  });
}

describe('Relay repair planning', () => {
  it('builds exactly the next round on the current managed-fork PR head', () => {
    expect(build()).toEqual({
      status: 'ready',
      generation,
      round: 1,
      taskKey: relayTaskKey(generation, 1),
      workspaceRepository: MANAGED_FORK,
      inputHead: HEAD,
      findings: [finding],
      prNumber: 68,
    });
  });

  it('does not mutate the frozen snapshot or verdict findings', () => {
    const frozenSnapshot = structuredClone(snapshot);
    const frozenFindings = structuredClone(repairVerdict.findings);

    build();

    expect(snapshot).toEqual(frozenSnapshot);
    expect(repairVerdict.findings).toEqual(frozenFindings);
  });

  it('preserves generation while assigning a task key distinct from the previous round', () => {
    const result = build();

    expect(result).toMatchObject({
      status: 'ready',
      generation,
      taskKey: relayTaskKey(generation, 1),
    });
    expect(result.status === 'ready' && result.taskKey)
      .not.toBe(relayTaskKey(generation, 0));
  });

  it.each([
    ['pass', { outcome: 'pass', findings: [] }],
    ['human', { outcome: 'human', findings: [] }],
    ['unresolved', { outcome: 'unresolved', findings: [] }],
  ] as const)('refuses a %s verdict without planning funding', (_label, patch) => {
    const verdict = {
      ...repairVerdict,
      ...patch,
    } as IssueRelayVerdictV1;

    expect(build({ verdict })).toEqual({
      status: 'refused',
      reason: 'verdict-not-repairable',
    });
  });

  it.each([
    [
      'duplicate',
      { status: 'duplicate', taskKey: relayTaskKey(generation, 1) },
      'duplicate',
    ],
    [
      'round limit',
      { status: 'exhausted', code: 'round-limit' },
      'round-limit',
    ],
    [
      'generation budget',
      { status: 'exhausted', code: 'generation-spend-limit' },
      'budget-limit',
    ],
    [
      'daily budget',
      { status: 'deferred', code: 'daily-spend-limit' },
      'budget-limit',
    ],
    [
      'deadline',
      { status: 'exhausted', code: 'deadline' },
      'deadline',
    ],
  ] as const)('refuses the %s gate before constructing funded work', (
    _label,
    budget,
    reason,
  ) => {
    expect(build({ budget })).toEqual({ status: 'refused', reason });
  });

  it('lets cancellation dominate an otherwise admitted repair', () => {
    expect(build({ cancelled: true })).toEqual({
      status: 'refused',
      reason: 'cancelled',
    });
  });

  it.each([
    [
      'stale evaluated head',
      { verdict: { ...repairVerdict, evaluatedHead: BASE } },
    ],
    [
      'wrong generation',
      {
        verdict: {
          ...repairVerdict,
          correlation: {
            ...repairVerdict.correlation,
            generation: 'other-generation',
          },
        },
      },
    ],
    [
      'wrong prior round',
      {
        verdict: {
          ...repairVerdict,
          correlation: {
            ...repairVerdict.correlation,
            round: 7,
          },
        },
      },
    ],
    [
      'upstream workspace',
      { managedForkRepository: 'Jinn-Network/mono' },
    ],
  ])('fails closed for %s rather than planning a repair', (_label, overrides) => {
    expect(build(overrides as Partial<Parameters<typeof buildRelayRepair>[0]>))
      .toEqual({
        status: 'refused',
        reason: 'verdict-not-repairable',
      });
  });

  it.each([
    [
      'an unrelated public fork',
      {
        authority: {
          ...authority,
          forkParentRepositoryId: 'R_other-parent',
        },
      },
    ],
    [
      'a stale live PR head',
      {
        authority: {
          ...authority,
          currentHead: BASE,
        },
      },
    ],
    [
      'a different PR number',
      {
        authority: {
          ...authority,
          prNumber: 69,
        },
      },
    ],
    [
      'a different generation',
      {
        authority: {
          ...authority,
          generation: 'other-generation',
        },
      },
    ],
    [
      'a non-deterministic branch',
      {
        authority: {
          ...authority,
          branch: 'attacker/branch',
        },
      },
    ],
    [
      'a closed draft',
      {
        authority: {
          ...authority,
          open: false,
        },
      },
    ],
    [
      'a ready PR',
      {
        authority: {
          ...authority,
          draft: false,
        },
      },
    ],
    [
      'a different managed repository',
      {
        authority: {
          ...authority,
          workspaceRepository: 'attacker/mono',
        },
      },
    ],
  ])('refuses host authority for %s', (_label, overrides) => {
    expect(build(overrides as Partial<Parameters<typeof buildRelayRepair>[0]>))
      .toEqual({
        status: 'refused',
        reason: 'verdict-not-repairable',
      });
  });
});
