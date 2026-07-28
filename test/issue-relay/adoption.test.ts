import { describe, expect, it, vi } from 'vitest';
import { relayBranch, relayGeneration } from '../../src/issue-relay/identity.js';
import {
  makeRelayAdoptionCoordinator,
  type RelayAdoptionDependencies,
  type RelayAdoptionExactAuthority,
  type RelayAdoptionAuthority,
  type VerifiedRelaySolutionObservation,
} from '../../src/issue-relay/adoption.js';
import { buildRelaySnapshot } from '../../src/issue-relay/snapshot.js';
import type { IssueRelayAdoptionReceiptV1 } from '../../src/issue-relay/contracts.js';

const BASE = '1'.repeat(40);
const RESULT = '2'.repeat(40);
const TREE = '3'.repeat(40);
const REQUEST = `0x${'4'.repeat(64)}`;
const ENVELOPE = `f01551220${'5'.repeat(64)}`;
const SOLUTION_SAFE = `0x${'6'.repeat(40)}`;

const snapshot = buildRelaySnapshot({
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
    body: 'Change the value.',
    authorLogin: 'maintainer',
    authorId: 'U_maintainer',
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
  acceptanceEvidence: ['The focused tests pass.'],
  admissionPolicyVersion: 'jinn-issue-relay-admission.v1',
  capturedAt: '2026-07-28T10:02:00.000Z',
});
const generation = relayGeneration(snapshot);

const patch = [
  'diff --git a/client/src/value.ts b/client/src/value.ts',
  '--- a/client/src/value.ts',
  '+++ b/client/src/value.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n');

function observation(
  overrides: Partial<VerifiedRelaySolutionObservation> = {},
): VerifiedRelaySolutionObservation {
  return {
    status: 'verified',
    role: 'solution',
    task: { taskId: '77', taskCid: `f01551220${'7'.repeat(64)}` },
    attempt: {
      attemptIndex: 0,
      requestId: REQUEST,
      operator: SOLUTION_SAFE,
    },
    delivery: {
      envelopeCid: ENVELOPE,
      transactionHash: `0x${'8'.repeat(64)}`,
      blockNumber: 100,
    },
    round: {
      schemaVersion: 'jinn-issue-relay-round.v1',
      generation,
      round: 0,
      snapshotDigest: snapshot.snapshotDigest,
      targetRepository: 'Jinn-Network/mono',
      workspaceRepository: 'Jinn-Network/mono',
      inputHead: BASE,
      purpose: 'initial',
      findings: [],
    },
    payload: {
      schemaVersion: 'jinn-repo-solution.v1',
      patch,
    },
    ...overrides,
  };
}

function authority(
  overrides: Partial<RelayAdoptionAuthority> = {},
): RelayAdoptionAuthority {
  return {
    generation,
    round: 0,
    targetRepository: 'Jinn-Network/mono',
    workspaceRepository: 'Jinn-Network/mono',
    inputHead: BASE,
    forkRepository: 'Jinn-Network/mono-relay',
    branch: relayBranch(generation),
    cancellationRequested: false,
    ...overrides,
  };
}

function liveAuthority(
  overrides: Partial<RelayAdoptionExactAuthority> = {},
): RelayAdoptionExactAuthority {
  return {
    generation,
    round: 0,
    snapshotDigest: snapshot.snapshotDigest,
    targetRepository: 'Jinn-Network/mono',
    workspaceRepository: 'Jinn-Network/mono',
    inputHead: BASE,
    forkRepository: 'Jinn-Network/mono-relay',
    branch: relayBranch(generation),
    taskId: '77',
    solutionOperator: SOLUTION_SAFE,
    issueNumber: 42,
    defaultBranch: 'main',
    targetRepositoryId: 'R_target',
    forkRepositoryId: 'R_fork',
    forkParentRepositoryId: 'R_target',
    expectedForkHead: undefined,
    cancellationRequested: false,
    serviceLogin: 'jinn-relay[bot]',
    adoptionDeadline: '2026-07-28T12:00:00.000Z',
    worktree: {
      manifestPath: '/relay/manifest.json',
      path: '/relay/worktree',
    },
    ...overrides,
  };
}

function acceptedReceipt(): Extract<
IssueRelayAdoptionReceiptV1,
{ readonly disposition: 'accepted' }
> {
  return {
    schemaVersion: 'jinn-issue-relay-adoption.v1',
    disposition: 'accepted',
    correlation: {
      generation,
      round: 0,
      snapshotDigest: snapshot.snapshotDigest,
      taskId: '77',
      attemptIndex: 0,
      requestId: REQUEST,
      deliveryEnvelopeCid: ENVELOPE,
    },
    targetRepository: 'Jinn-Network/mono',
    workspaceRepository: 'Jinn-Network/mono',
    issueNumber: 42,
    prNumber: 68,
    headRef: relayBranch(generation),
    inputHead: BASE,
    resultingHead: RESULT,
    patchDigest:
      'sha256:b934bd8ff982ee635e1f0fc491acb8489a35c2cfe3230c785ebf3996c2f80580',
    solutionSafe: SOLUTION_SAFE,
    adoptedAt: '2026-07-28T11:00:00.000Z',
  };
}

function dependencies(input: {
  readonly live?: RelayAdoptionExactAuthority;
  readonly replay?: ReturnType<typeof acceptedReceipt>;
} = {}): {
  readonly dependencies: RelayAdoptionDependencies;
  readonly mutations: string[];
} {
  const mutations: string[] = [];
  let reads = 0;
  const initial = input.live ?? liveAuthority();
  const dependencies: RelayAdoptionDependencies = {
    authority: {
      readExact: vi.fn(async () => {
        reads += 1;
        return reads === 1
          ? initial
          : { ...initial, expectedForkHead: RESULT, pr: {
            number: 68,
            branch: relayBranch(generation),
            head: RESULT,
            base: 'main',
            open: true,
            draft: true,
            generation,
          } };
      }),
    },
    worktrees: {
      prepareExact: vi.fn(async ({ expectedHead }) => {
        mutations.push('worktree');
        return {
          manifestPath: '/relay/manifest.json',
          path: '/relay/worktree',
          expectedHead,
        };
      }),
    },
    applyPatch: vi.fn(async ({ artifact }) => {
      mutations.push('apply');
      return {
        artifact,
        artifactDigest:
          'sha256:b934bd8ff982ee635e1f0fc491acb8489a35c2cfe3230c785ebf3996c2f80580',
        byteLength: artifact.byteLength,
        touchedPaths: ['client/src/value.ts'],
      };
    }),
    verification: {
      preflight: vi.fn(async () => ({ ok: true })),
      verify: vi.fn(async (input) => {
        mutations.push('verify');
        return {
          profile: 'jinn-mono.v1' as const,
          artifactDigest: input.artifactDigest,
          expectedTree: input.expectedTree,
          planDigest: `sha256:${'9'.repeat(64)}`,
          commands: [],
          verifiedAt: '2026-07-28T10:30:00.000Z',
        };
      }),
    },
    publisher: {
      recoverAccepted: vi.fn(async () => input.replay),
      recoverPublished: vi.fn(async () =>
        initial.expectedForkHead === RESULT
          ? { branch: relayBranch(generation), resultingHead: RESULT, tree: TREE }
          : undefined),
      readAppliedTree: vi.fn(async () => {
        mutations.push('read-tree');
        return TREE;
      }),
      commitAndPush: vi.fn(async () => {
        mutations.push('commit-push');
        return { branch: relayBranch(generation), resultingHead: RESULT };
      }),
      ensureDraftPullRequest: vi.fn(async () => {
        mutations.push('pr');
        return {
          number: 68,
          branch: relayBranch(generation),
          head: RESULT,
          base: 'main',
          open: true,
          draft: true,
          generation,
        };
      }),
      closeDraftPullRequest: vi.fn(async () => {
        mutations.push('close-pr');
      }),
      publishAdoptionReceipt: vi.fn(async ({ receipt }) => {
        mutations.push('receipt');
        return receipt;
      }),
    },
    now: () => new Date('2026-07-28T11:00:00.000Z'),
  };
  return { dependencies, mutations };
}

describe('Relay solution adoption policy', () => {
  it.each([
    ['generation', observation({
      round: { ...observation().round, generation: 'wrong-generation' },
    }), authority(), liveAuthority()],
    ['round', observation({
      round: { ...observation().round, round: 1 },
    }), authority(), liveAuthority()],
    ['snapshot', observation({
      round: {
        ...observation().round,
        snapshotDigest: `sha256:${'a'.repeat(64)}`,
      },
    }), authority(), liveAuthority()],
    ['task', observation({
      task: { ...observation().task, taskId: '78' },
    }), authority(), liveAuthority()],
    ['operator', observation({
      attempt: {
        ...observation().attempt,
        operator: `0x${'a'.repeat(40)}`,
      },
    }), authority(), liveAuthority()],
    ['managed fork identity', observation(), authority(), liveAuthority({
      forkRepositoryId: 'R_target',
    })],
    ['input head', observation({
      round: { ...observation().round, inputHead: 'a'.repeat(40) },
    }), authority(), liveAuthority()],
  ])('rejects the wrong %s before mutation', async (
    _label,
    candidate,
    requested,
    live,
  ) => {
    const { dependencies: deps, mutations } = dependencies({ live });
    const coordinator = makeRelayAdoptionCoordinator(deps);

    const result = await coordinator.adopt({
      authority: requested,
      observation: candidate,
      snapshot,
    });

    expect(result).toMatchObject({
      status: 'rejected',
      receipt: {
        disposition: 'rejected',
        reason: 'correlation-mismatch',
      },
    });
    expect(mutations).toEqual([]);
  });

  it.each([
    ['an unsafe traversal', [
      'diff --git a/../value.ts b/../value.ts',
      '--- a/../value.ts',
      '+++ b/../value.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n')],
    ['a protected verification file', [
      'diff --git a/client/test/value.test.ts b/client/test/value.test.ts',
      '--- a/client/test/value.test.ts',
      '+++ b/client/test/value.test.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n')],
  ])('rejects %s before worktree creation', async (_label, unsafePatch) => {
    const { dependencies: deps, mutations } = dependencies();
    const coordinator = makeRelayAdoptionCoordinator(deps);

    const result = await coordinator.adopt({
      authority: authority(),
      observation: observation({
        payload: {
          schemaVersion: 'jinn-repo-solution.v1',
          patch: unsafePatch,
        },
      }),
      snapshot,
    });

    expect(result).toMatchObject({
      status: 'rejected',
      receipt: { reason: 'unsafe-patch' },
    });
    expect(mutations).toEqual([]);
  });

  it.each([
    ['stale fork head', liveAuthority({ expectedForkHead: 'a'.repeat(40) }), 'stale-input'],
    ['stale PR head', liveAuthority({
      expectedForkHead: BASE,
      pr: {
        number: 68,
        branch: relayBranch(generation),
        head: 'a'.repeat(40),
        base: 'main',
        open: true,
        draft: true,
        generation,
      },
    }), 'stale-input'],
    ['cancellation', liveAuthority({ cancellationRequested: true }), 'cancelled'],
  ])('rejects %s before repository mutation', async (_label, live, reason) => {
    const requested = authority({
      ...(live.pr === undefined ? {} : { existingPrNumber: live.pr.number }),
    });
    const { dependencies: deps, mutations } = dependencies({ live });

    const result = await makeRelayAdoptionCoordinator(deps).adopt({
      authority: requested,
      observation: observation(),
      snapshot,
    });

    expect(result).toMatchObject({
      status: 'rejected',
      receipt: { reason },
    });
    expect(mutations).toEqual([]);
  });

  it('returns an exact accepted replay without touching a worktree', async () => {
    const receipt = acceptedReceipt();
    const { dependencies: deps, mutations } = dependencies({
      replay: receipt,
      live: liveAuthority({
        expectedForkHead: RESULT,
        pr: {
          number: 68,
          branch: relayBranch(generation),
          head: RESULT,
          base: 'main',
          open: true,
          draft: true,
          generation,
        },
      }),
    });

    const result = await makeRelayAdoptionCoordinator(deps).adopt({
      authority: authority({ existingPrNumber: 68 }),
      observation: observation(),
      snapshot,
    });

    expect(result).toEqual({
      status: 'accepted',
      receipt,
      branch: relayBranch(generation),
      resultingHead: RESULT,
      prNumber: 68,
    });
    expect(mutations).toEqual([]);
  });

  it('closes an exact accepted replay when cancellation has arrived', async () => {
    const receipt = acceptedReceipt();
    const { dependencies: deps, mutations } = dependencies({
      replay: receipt,
      live: liveAuthority({
        cancellationRequested: true,
        expectedForkHead: RESULT,
        pr: {
          number: 68,
          branch: relayBranch(generation),
          head: RESULT,
          base: 'main',
          open: true,
          draft: true,
          generation,
        },
      }),
    });

    const result = await makeRelayAdoptionCoordinator(deps).adopt({
      authority: authority({ existingPrNumber: 68 }),
      observation: observation(),
      snapshot,
    });

    expect(result).toMatchObject({
      status: 'rejected',
      receipt: { disposition: 'rejected', reason: 'cancelled' },
    });
    expect(mutations).toEqual(['close-pr']);
  });

  it('converges when the accepted draft was already closed for cancellation', async () => {
    const receipt = acceptedReceipt();
    const { dependencies: deps, mutations } = dependencies({
      replay: receipt,
      live: liveAuthority({
        cancellationRequested: true,
        expectedForkHead: RESULT,
        pr: {
          number: 68,
          branch: relayBranch(generation),
          head: RESULT,
          base: 'main',
          open: false,
          draft: true,
          generation,
        },
      }),
    });

    const result = await makeRelayAdoptionCoordinator(deps).adopt({
      authority: authority({ existingPrNumber: 68 }),
      observation: observation(),
      snapshot,
    });

    expect(result).toMatchObject({
      status: 'rejected',
      receipt: { disposition: 'rejected', reason: 'cancelled' },
    });
    expect(mutations).toEqual([]);
  });

  it.each([
    ['fork push', liveAuthority({ expectedForkHead: RESULT })],
    ['draft PR creation', liveAuthority({
      expectedForkHead: RESULT,
      pr: {
        number: 68,
        branch: relayBranch(generation),
        head: RESULT,
        base: 'main',
        open: true,
        draft: true,
        generation,
      },
    })],
  ])('resumes exact adoption after a crash following %s', async (_boundary, live) => {
    const { dependencies: deps, mutations } = dependencies({ live });

    const result = await makeRelayAdoptionCoordinator(deps).adopt({
      authority: authority(),
      observation: observation(),
      snapshot,
    });

    expect(result).toMatchObject({
      status: 'accepted',
      resultingHead: RESULT,
      prNumber: 68,
    });
    expect(mutations).toEqual([
      'worktree',
      'verify',
      'commit-push',
      'pr',
      'receipt',
    ]);
    expect(deps.worktrees.prepareExact).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRepository: 'Jinn-Network/mono-relay',
        expectedHead: RESULT,
      }),
    );
  });

  it('orders apply, exact-tree verification, host publication, draft PR, and receipt', async () => {
    const { dependencies: deps, mutations } = dependencies();

    const result = await makeRelayAdoptionCoordinator(deps).adopt({
      authority: authority(),
      observation: observation(),
      snapshot,
    });

    expect(result).toMatchObject({
      status: 'accepted',
      branch: relayBranch(generation),
      resultingHead: RESULT,
      prNumber: 68,
      receipt: {
        disposition: 'accepted',
        patchDigest:
          'sha256:b934bd8ff982ee635e1f0fc491acb8489a35c2cfe3230c785ebf3996c2f80580',
      },
    });
    expect(mutations).toEqual([
      'worktree',
      'apply',
      'read-tree',
      'verify',
      'commit-push',
      'pr',
      'receipt',
    ]);
  });

  it('closes the adopted draft when cancellation arrives after the fork push', async () => {
    const { dependencies: deps, mutations } = dependencies();
    let reads = 0;
    deps.authority.readExact = vi.fn(async () => {
      reads += 1;
      return reads === 1
        ? liveAuthority()
        : liveAuthority({
          cancellationRequested: true,
          expectedForkHead: RESULT,
          pr: {
            number: 68,
            branch: relayBranch(generation),
            head: RESULT,
            base: 'main',
            open: true,
            draft: true,
            generation,
          },
        });
    });

    const result = await makeRelayAdoptionCoordinator(deps).adopt({
      authority: authority(),
      observation: observation(),
      snapshot,
    });

    expect(result).toMatchObject({
      status: 'rejected',
      receipt: { disposition: 'rejected', reason: 'cancelled' },
    });
    expect(mutations).toEqual([
      'worktree',
      'apply',
      'read-tree',
      'verify',
      'commit-push',
      'close-pr',
    ]);
  });

  it('refuses a receipt when exact authority changes after PR creation', async () => {
    const { dependencies: deps, mutations } = dependencies();
    let reads = 0;
    deps.authority.readExact = vi.fn(async () => {
      reads += 1;
      const current = liveAuthority({
        expectedForkHead: reads === 1 ? undefined : RESULT,
        ...(reads === 1 ? {} : {
          pr: {
            number: 68,
            branch: relayBranch(generation),
            head: RESULT,
            base: 'main',
            open: true,
            draft: true,
            generation,
          },
        }),
      });
      return reads < 3 ? current : { ...current, taskId: '88' };
    });

    const result = await makeRelayAdoptionCoordinator(deps).adopt({
      authority: authority(),
      observation: observation(),
      snapshot,
    });

    expect(result).toMatchObject({
      status: 'rejected',
      receipt: { reason: 'authority-changed' },
    });
    expect(mutations).not.toContain('receipt');
  });
});
