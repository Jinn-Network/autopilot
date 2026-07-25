// @ts-nocheck — Stage 5: deleted merge-prep/review-fix/project-status fixtures.
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/dispatcher/types.js';
import {
  makeProductionActiveRuntime,
  makeProductionCapabilityPreflight,
} from '../../src/lifecycle/active-runtime-production.js';
import {
  runLifecycleCycle,
} from '../../src/lifecycle/controller.js';
import {
  MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL,
} from '../../src/lifecycle/session-execution-backend.js';
import {
  decodeCapabilityAttestation,
} from '../../src/lifecycle/capability-attestation.js';
import { CredentialPool } from '../../src/lifecycle/credentials.js';

const NOW = new Date('2026-07-20T12:00:00.000Z');

function pool(): CredentialPool {
  return new CredentialPool([{
    login: 'implementation-bot',
    normalizedLogin: 'implementation-bot',
    implementationToken: 'secret',
  }]);
}

function marketplaceRuntime(overrides: Record<string, unknown> = {}) {
  return makeProductionActiveRuntime({
    executionBackend: 'marketplace',
    repositoryPath: '/repo',
    worktreeBase: '/tmp/autopilot-marketplace-preflight-test',
    runnerId: 'runner-a',
    credentials: pool(),
    authorAllowlist: new Set(['implementation-bot']),
    readReviewSnapshot: async () => null,
    readReservedReviewSnapshot: async () => null,
    readImplementationSnapshot: async () => {
      throw new Error('implementation authority must remain untouched');
    },
    reserveReviewCohort: async () => {},
    readPullRequestByNumber: async () => null,
    readProjectItemForReconciliation: async () => null,
    readBranchHeadByName: async () => null,
    readIssueByNumber: async () => null,
    readBlockedByIssueNumbers: async () => [],
    readOpenPullRequestsByIssue: async () => [],
    readIssueActionContext: async () => {
      throw new Error('issue action context must remain untouched');
    },
    config: DEFAULT_CONFIG,
    spawn: vi.fn(() => {
      throw new Error('local spawn must remain untouched');
    }),
    caps: { implementation: 1, review: 1 },
    implementationBackpressureThreshold: 30,
    staleAfterMs: 60_000,
    runner: vi.fn(async () => {
      throw new Error('runner must remain untouched');
    }),
    ...overrides,
  });
}

describe('decodeCapabilityAttestation timestamps', () => {
  it('accepts second-precision ISO-8601 timestamps', () => {
    const decoded = decodeCapabilityAttestation({
      version: 2,
      repositoryUrl: 'https://github.com/Jinn-Network/mono.git',
      remoteName: 'jinn-autopilot-v2',
      probeId: 'a'.repeat(32),
      implementerLogin: 'implementation-bot',
      verifiedAt: '2026-07-20T11:00:00Z',
      expiresAt: '2026-07-21T11:00:00Z',
      refs: {
        branch: `refs/heads/autopilot/capability-${'a'.repeat(32)}`,
        review:
          `refs/jinn-autopilot/review-claims/v1/capability-${'a'.repeat(32)}`,
      },
      proofs: {
        absentRefCreation: true,
        expectedParentRejection: true,
        ambiguousReadback: true,
        exactCleanup: true,
        readViaGitTransport: true,
      },
    }, {
      remoteName: 'jinn-autopilot-v2',
      configuredLogins: ['implementation-bot'],
      now: NOW,
    });
    expect(decoded.verifiedAt).toBe('2026-07-20T11:00:00Z');
  });

  it('rejects a non-ISO timestamp', () => {
    expect(() => decodeCapabilityAttestation({
      version: 2,
      repositoryUrl: 'https://github.com/Jinn-Network/mono.git',
      remoteName: 'jinn-autopilot-v2',
      probeId: 'a'.repeat(32),
      implementerLogin: 'implementation-bot',
      verifiedAt: '20 July 2026',
      expiresAt: '2026-07-21T11:00:00Z',
      refs: {
        branch: `refs/heads/autopilot/capability-${'a'.repeat(32)}`,
        review:
          `refs/jinn-autopilot/review-claims/v1/capability-${'a'.repeat(32)}`,
      },
      proofs: {
        absentRefCreation: true,
        expectedParentRejection: true,
        ambiguousReadback: true,
        exactCleanup: true,
        readViaGitTransport: true,
      },
    }, {
      remoteName: 'jinn-autopilot-v2',
      configuredLogins: ['implementation-bot'],
      now: NOW,
    })).toThrow('verifiedAt is invalid');
  });
});

describe('production active runtime preflight', () => {
  it('rejects marketplace execution before Git, credentials, attestation, or local runtime probes', async () => {
    const runner = vi.fn(async () => {
      throw new Error('Git probe must remain untouched');
    });
    const readCapabilityAttestation = vi.fn(() => {
      throw new Error('attestation probe must remain untouched');
    });
    const credentials = {
      logins: vi.fn(() => {
        throw new Error('credential probe must remain untouched');
      }),
    };
    const preflight = makeProductionCapabilityPreflight({
      executionBackend: 'marketplace',
      repositoryPath: '/repo',
      credentials,
      config: {
        ...DEFAULT_CONFIG,
        runtime: 'cursor',
        cursorBin: '/missing/cursor-agent',
      },
      runner,
      readCapabilityAttestation,
    });

    await expect(preflight()).resolves.toEqual({
      ok: false,
      detail: MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(readCapabilityAttestation).not.toHaveBeenCalled();
    expect(credentials.logins).not.toHaveBeenCalled();
  });

  it('rejects a marketplace production cycle before snapshot discovery or any claim path', async () => {
    const spawn = vi.fn(() => {
      throw new Error('local spawn must remain untouched');
    });
    const readSnapshot = vi.fn(async () => {
      throw new Error('snapshot discovery must remain untouched');
    });
    const isPidAlive = vi.fn(() => {
      throw new Error('local PID probe must remain untouched');
    });
    const trackAttemptChild = vi.fn(() => {
      throw new Error('local tracking must remain untouched');
    });
    const active = marketplaceRuntime({
      spawn,
      isPidAlive,
      trackAttemptChild,
    });

    await expect(runLifecycleCycle('active', {
      active,
      writer: {} as never,
      readSnapshot,
      now: () => NOW,
      staleAfterMs: 60_000,
      runnerId: 'runner-a',
      cycleId: () => 'cycle-a',
    })).resolves.toMatchObject({
      status: 'rejected',
      message:
        `active capability preflight failed: ${MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL}`,
      events: [],
    });
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(isPidAlive).not.toHaveBeenCalled();
    expect(trackAttemptChild).not.toHaveBeenCalled();
  });

  it('fails a direct marketplace implementation dispatch before authority reads or local spawn', async () => {
    const spawn = vi.fn(() => {
      throw new Error('local spawn must remain untouched');
    });
    const readImplementationSnapshot = vi.fn(async () => {
      throw new Error('implementation authority must remain untouched');
    });
    const trackAttemptChild = vi.fn(() => {
      throw new Error('local tracking must remain untouched');
    });
    const active = marketplaceRuntime({
      spawn,
      readImplementationSnapshot,
      trackAttemptChild,
    });

    await expect(active.executeAction({
      kind: 'claim-implementation',
      intent: 'fresh',
      issueNumber: 42,
    }, {} as never)).rejects.toThrow(MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL);
    expect(readImplementationSnapshot).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(trackAttemptChild).not.toHaveBeenCalled();
  });

  it('fails a direct marketplace exact-head review before acquisition reads or local spawn', async () => {
    const spawn = vi.fn(() => {
      throw new Error('local spawn must remain untouched');
    });
    const readReviewSnapshot = vi.fn(async () => {
      throw new Error('review authority must remain untouched');
    });
    const trackAttemptChild = vi.fn(() => {
      throw new Error('local tracking must remain untouched');
    });
    const active = marketplaceRuntime({
      spawn,
      readReviewSnapshot,
      trackAttemptChild,
    });

    await expect(active.executeAction({
      kind: 'claim-review',
      issueNumber: 42,
      prNumber: 84,
      head: '1'.repeat(40),
    }, {} as never)).rejects.toThrow(MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL);
    expect(readReviewSnapshot).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(trackAttemptChild).not.toHaveBeenCalled();
  });

  it('guards direct marketplace dispatch before credential and full-capacity local-state reads', async () => {
    const credentials = {
      logins: vi.fn(() => {
        throw new Error('credential/local-state probe must remain untouched');
      }),
    };
    const active = marketplaceRuntime({
      credentials,
      caps: { implementation: 0, review: 0 },
    });

    await expect(active.executeAction({
      kind: 'claim-implementation',
      intent: 'fresh',
      issueNumber: 42,
    }, {} as never)).rejects.toThrow(MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL);
    await expect(active.executeReviewActions!([{
      kind: 'claim-review',
      issueNumber: 42,
      prNumber: 84,
      head: '1'.repeat(40),
    }], {} as never)).rejects.toThrow(MARKETPLACE_EXECUTION_UNAVAILABLE_DETAIL);
    expect(credentials.logins).not.toHaveBeenCalled();
  });

  it('rejects active mode when no live capability attestation is configured', async () => {
    const preflight = makeProductionCapabilityPreflight({
      repositoryPath: '/repo',
      credentials: pool(),
      config: DEFAULT_CONFIG,
      runner: async () => 'https://github.com/Jinn-Network/mono.git\n',
    });

    await expect(preflight()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining(
        'JINN_AUTOPILOT_CAPABILITY_ATTESTATION',
      ),
    });
  });

  it('requires the dedicated canonical HTTPS remote without mutating local Git config', async () => {
    const calls: string[][] = [];
    const attestation = (
      expected: Parameters<typeof decodeCapabilityAttestation>[1],
    ) => decodeCapabilityAttestation({
      version: 2,
      repositoryUrl: 'https://github.com/Jinn-Network/mono.git',
      remoteName: 'jinn-autopilot-v2',
      probeId: 'a'.repeat(32),
      implementerLogin: 'implementation-bot',
      verifiedAt: '2026-07-20T11:00:00.000Z',
      expiresAt: '2026-07-21T11:00:00.000Z',
      refs: {
        branch: `refs/heads/autopilot/capability-${'a'.repeat(32)}`,
        review:
          `refs/jinn-autopilot/review-claims/v1/capability-${'a'.repeat(32)}`,
      },
      proofs: {
        absentRefCreation: true,
        expectedParentRejection: true,
        ambiguousReadback: true,
        exactCleanup: true,
        readViaGitTransport: true,
      },
    }, expected);
    const accepted = makeProductionCapabilityPreflight({
      repositoryPath: '/repo',
      credentials: pool(),
      config: DEFAULT_CONFIG,
      environment: {
        JINN_AUTOPILOT_CAPABILITY_ATTESTATION: '/attestation.json',
      },
      now: () => NOW,
      readCapabilityAttestation: (_path, expected) => attestation(expected),
      runner: async (command, args) => {
        expect(command).toBe('git');
        calls.push(args);
        return 'https://github.com/Jinn-Network/mono.git\n';
      },
    });
    await expect(accepted()).resolves.toEqual({ ok: true });
    await expect(accepted()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      '-C', '/repo', 'remote', 'get-url', 'jinn-autopilot-v2',
    ]);

    const rejected = makeProductionCapabilityPreflight({
      repositoryPath: '/repo',
      credentials: pool(),
      config: DEFAULT_CONFIG,
      environment: {
        JINN_AUTOPILOT_CAPABILITY_ATTESTATION: '/attestation.json',
      },
      now: () => NOW,
      readCapabilityAttestation: (_path, expected) => attestation(expected),
      runner: async () => 'git@example.invalid:Jinn-Network/mono.git\n',
    });
    await expect(rejected()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringContaining('canonical HTTPS'),
    });
  });

  it('fails closed when Cursor runtime probe cannot find the agent binary', async () => {
    const attestation = (
      expected: Parameters<typeof decodeCapabilityAttestation>[1],
    ) => decodeCapabilityAttestation({
      version: 2,
      repositoryUrl: 'https://github.com/Jinn-Network/mono.git',
      remoteName: 'jinn-autopilot-v2',
      probeId: 'a'.repeat(32),
      implementerLogin: 'implementation-bot',
      verifiedAt: '2026-07-20T11:00:00.000Z',
      expiresAt: '2026-07-21T11:00:00.000Z',
      refs: {
        branch: `refs/heads/autopilot/capability-${'a'.repeat(32)}`,
        review:
          `refs/jinn-autopilot/review-claims/v1/capability-${'a'.repeat(32)}`,
      },
      proofs: {
        absentRefCreation: true,
        expectedParentRejection: true,
        ambiguousReadback: true,
        exactCleanup: true,
        readViaGitTransport: true,
      },
    }, expected);

    const preflight = makeProductionCapabilityPreflight({
      repositoryPath: '/repo',
      credentials: pool(),
      config: {
        ...DEFAULT_CONFIG,
        runtime: 'cursor',
        cursorBin: '/missing/cursor-agent',
      },
      environment: {
        JINN_AUTOPILOT_CAPABILITY_ATTESTATION: '/attestation.json',
      },
      now: () => NOW,
      readCapabilityAttestation: (_path, expected) => attestation(expected),
      runner: async () => 'https://github.com/Jinn-Network/mono.git\n',
    });

    await expect(preflight()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringMatching(/Cursor Agent CLI is missing|Cursor runtime probe failed/i),
    });
  });
});
