import { describe, expect, it, vi } from 'vitest';
import {
  buildJinnMonoV1VerificationPlan,
  MarketplaceVerificationError,
  marketplaceVerificationPlanDigest,
} from '../../src/lifecycle/marketplace-mutation-verification.js';
import {
  buildMarketplaceVerificationDockerInvocation,
  createProductionMarketplaceVerificationPort,
  digestBoundedVerificationOutput,
  isStaleImmutableLockfileInstallFailure,
  JINN_MONO_V1_VERIFICATION_NODE_IMAGE,
  MARKETPLACE_VERIFICATION_SANDBOX_LIMITS,
  sanitizeMarketplaceVerificationSandboxEnvironment,
  type MarketplaceVerificationDockerInvocation,
  type MarketplaceVerificationDockerRunner,
  type MarketplaceVerificationSandboxCleanup,
} from '../../src/lifecycle/marketplace-mutation-verification-production.js';
import {
  decodeMarketplaceExecutionV3State,
  type MarketplaceVerificationEvidence,
} from '../../src/lifecycle/marketplace-execution-state.js';
import { gitOid } from '../../src/lifecycle/types.js';

const REPO = '/srv/attempt/mono';
const WORKSPACE = '/tmp/autopilot/verification-workspace';
const ARTIFACT_DIGEST = `sha256:${'a'.repeat(64)}`;
const EXPECTED_TREE = gitOid('b'.repeat(40));
const DEADLINE = '2020-01-01T02:00:00.000Z';

function clock(start = '2020-01-01T00:00:00.000Z'): () => Date {
  let tick = Date.parse(start);
  return () => {
    const now = new Date(tick);
    tick += 1_000;
    return now;
  };
}

function digestOf(label: string): string {
  return digestBoundedVerificationOutput(label);
}

const verifyInput = {
  profile: 'jinn-mono.v1' as const,
  repositoryPath: REPO,
  touchedPaths: ['packages/autopilot/src/engine.ts'],
  artifactDigest: ARTIFACT_DIGEST,
  expectedTree: EXPECTED_TREE,
  deadline: DEADLINE,
};

const DECODER_ATTEMPT_DIR =
  '/tmp/autopilot/v2/runner-a/implement/issue-42-11111111-1111-4111-8111-111111111111';

function solutionVerifiedState(evidence: MarketplaceVerificationEvidence): unknown {
  return {
    schemaVersion: 'marketplace-execution-v3',
    status: 'solution-verified',
    requestPath: `${DECODER_ATTEMPT_DIR}/marketplace-request.json`,
    requestDigest: `sha256:${'b'.repeat(64)}`,
    solverNetSelectionPath:
      `${DECODER_ATTEMPT_DIR}/marketplace-request.json.solvernet-selection.json`,
    preparedAt: '2020-01-01T00:00:00.000Z',
    agentSoftDeadline: '2020-01-01T01:00:00.000Z',
    adoptionDeadline: DEADLINE,
    submission: {
      schemaVersion: 1,
      generatedAt: '2020-01-01T00:00:00.000Z',
      verb: 'tasks submit',
      id: 'autopilot:11111111-1111-4111-8111-111111111111',
      creatorMultisig: `0x${'c'.repeat(40)}`,
      taskId: '501',
      taskCid: 'bafybeigdyrzt5m6u2r3o4exampletaskcid',
      creationTx: `0x${'d'.repeat(64)}`,
      creationBlock: 501,
      solverNetManifestCid: 'bafybeigdyrzt5m6u2r3o4examplesolvercid',
      status: 'submitted',
      idempotent: false,
    },
    submittedAt: '2020-01-01T00:00:00.000Z',
    delivery: {
      observationPath: `${DECODER_ATTEMPT_DIR}/delivery.json`,
      observationDigest: `sha256:${'b'.repeat(64)}`,
      taskId: '501',
      taskCid: 'bafybeigdyrzt5m6u2r3o4exampletaskcid',
      taskCreationTransaction: `0x${'d'.repeat(64)}`,
      taskCreationBlock: 501,
      solverNetManifestCid: 'bafybeigdyrzt5m6u2r3o4examplesolvercid',
      attemptIndex: 0,
      requestId: `0x${'9'.repeat(64)}`,
      deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid',
      deliveryEnvelopeDigest: `sha256:${'e'.repeat(64)}`,
      deliveryTransaction: `0x${'f'.repeat(64)}`,
      deliveryBlock: 502,
      solverSafe: `0x${'1'.repeat(40)}`,
      solverAgentEoa: `0x${'2'.repeat(40)}`,
      signer: `0x${'2'.repeat(40)}`,
      publisherAgentId: '501',
      correlation: {
        taskId: '501',
        attemptIndex: 0,
        requestId: `0x${'9'.repeat(64)}`,
        deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid',
        v2AttemptId: '11111111-1111-4111-8111-111111111111',
        claimOid: gitOid('c'.repeat(40)),
        prNumber: 42,
        expectedHead: gitOid('d'.repeat(40)),
      },
      observedAt: '2020-01-01T00:00:00.000Z',
    },
    artifact: {
      digest: ARTIFACT_DIGEST,
      byteLength: 512,
      touchedPaths: ['packages/autopilot/src/engine.ts'],
      expectedTree: EXPECTED_TREE,
    },
    verification: evidence,
  };
}

function passingRunner(
  invocations: MarketplaceVerificationDockerInvocation[] = [],
): MarketplaceVerificationDockerRunner {
  return async (invocation) => {
    invocations.push(invocation);
    return {
      exitCode: 0,
      stdout: invocation.label,
      stderr: '',
    };
  };
}

function confirmedCleanup(): MarketplaceVerificationSandboxCleanup {
  return async () => 'confirmed';
}

describe('marketplace verification sandbox helpers', () => {
  it('pins the Node 22 bookworm-slim manifest digest', () => {
    expect(JINN_MONO_V1_VERIFICATION_NODE_IMAGE).toBe(
      'node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3',
    );
  });

  it('allowlists only non-secret sandbox environment keys', () => {
    expect(sanitizeMarketplaceVerificationSandboxEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/operator',
      LANG: 'C.UTF-8',
      NO_COLOR: '1',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      YARN_ENABLE_SCRIPTS: '0',
      YARN_ENABLE_IMMUTABLE_INSTALLS: '1',
      CI: 'true',
      GH_TOKEN: 'secret',
      GITHUB_TOKEN: 'secret',
      JINN_RPC_URL: 'https://rpc.example',
      JINN_CONFIG_HOME: '/operator/jinn',
      MARKETPLACE_WALLET_PRIVATE_KEY: '0xdead',
      GH_CONFIG_DIR: '/private/gh',
      ALCHEMY_API_KEY: 'secret',
    })).toEqual({
      PATH: '/usr/bin',
      HOME: '/workspace',
      LANG: 'C.UTF-8',
      NO_COLOR: '1',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      YARN_ENABLE_SCRIPTS: '0',
      YARN_ENABLE_IMMUTABLE_INSTALLS: '1',
      CI: 'true',
    });
  });

  it('forces security defaults over hostile ambient yarn settings', () => {
    expect(sanitizeMarketplaceVerificationSandboxEnvironment({
      YARN_ENABLE_SCRIPTS: '1',
      YARN_ENABLE_IMMUTABLE_INSTALLS: '0',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '1',
      NO_COLOR: '0',
      CI: 'false',
      HOME: '/root',
    })).toEqual({
      YARN_ENABLE_SCRIPTS: '0',
      YARN_ENABLE_IMMUTABLE_INSTALLS: '1',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      NO_COLOR: '1',
      CI: 'true',
      HOME: '/workspace',
    });
  });

  it('detects stale immutable lockfile failures separately from registry outages', () => {
    expect(isStaleImmutableLockfileInstallFailure(
      'YN0028: The lockfile would have been modified by this install, which is explicitly forbidden.',
    )).toBe(true);
    expect(isStaleImmutableLockfileInstallFailure(
      'getaddrinfo ENOTFOUND registry.yarnpkg.com',
    )).toBe(false);
    expect(isStaleImmutableLockfileInstallFailure(
      'connect ECONNREFUSED 104.16.3.35:443',
    )).toBe(false);
  });

  it('caps retained output before digesting it', () => {
    const retained = 'x'.repeat(MARKETPLACE_VERIFICATION_SANDBOX_LIMITS.maxRetainedOutputBytes + 10);
    const digest = digestBoundedVerificationOutput(retained);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digestBoundedVerificationOutput(retained)).toBe(digest);
    expect(digestBoundedVerificationOutput('y'.repeat(retained.length))).not.toBe(digest);
  });

  it('builds a bounded docker invocation with read-only source and writable workspace', () => {
    const invocation = buildMarketplaceVerificationDockerInvocation({
      repositoryPath: REPO,
      workspacePath: WORKSPACE,
      command: {
        label: 'install',
        command: 'corepack',
        args: ['yarn', 'install', '--immutable'],
        cwd: REPO,
      },
      network: 'bridge',
      environment: sanitizeMarketplaceVerificationSandboxEnvironment({ PATH: '/usr/bin' }),
    });

    expect(invocation.image).toBe(JINN_MONO_V1_VERIFICATION_NODE_IMAGE);
    expect(invocation.perCommandTimeoutSeconds).toBe(
      MARKETPLACE_VERIFICATION_SANDBOX_LIMITS.perCommandTimeoutSeconds,
    );
    expect(invocation.argv).toEqual(expect.arrayContaining([
      'run',
      '--rm',
      '--init',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid',
      '--tmpfs',
      '/run:rw,noexec,nosuid',
      '--security-opt',
      'no-new-privileges',
      '--cap-drop',
      'ALL',
      `--cpus=${MARKETPLACE_VERIFICATION_SANDBOX_LIMITS.cpus}`,
      `--memory=${MARKETPLACE_VERIFICATION_SANDBOX_LIMITS.memory}`,
      `--memory-swap=${MARKETPLACE_VERIFICATION_SANDBOX_LIMITS.memorySwap}`,
      `--pids-limit=${MARKETPLACE_VERIFICATION_SANDBOX_LIMITS.pidsLimit}`,
      '--network',
      'bridge',
      `--mount=type=bind,source=${REPO},target=/source,readonly`,
      `--mount=type=bind,source=${WORKSPACE},target=/workspace`,
      '--workdir',
      '/workspace',
      JINN_MONO_V1_VERIFICATION_NODE_IMAGE,
      'corepack',
      'yarn',
      'install',
      '--immutable',
    ]));
    expect(invocation.env).toEqual({
      YARN_ENABLE_SCRIPTS: '0',
      YARN_ENABLE_IMMUTABLE_INSTALLS: '1',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      NO_COLOR: '1',
      CI: 'true',
      PATH: '/usr/bin',
      HOME: '/workspace',
    });
    expect(invocation.network).toBe('bridge');
    expect(invocation.label).toBe('install');
    expect(invocation.phase).toBe('install');
  });

  it('runs verification commands with network disabled after install', () => {
    const install = buildMarketplaceVerificationDockerInvocation({
      repositoryPath: REPO,
      workspacePath: WORKSPACE,
      command: {
        label: 'install',
        command: 'corepack',
        args: ['yarn', 'install', '--immutable'],
        cwd: REPO,
      },
      network: 'bridge',
      environment: {},
    });
    const typecheck = buildMarketplaceVerificationDockerInvocation({
      repositoryPath: REPO,
      workspacePath: WORKSPACE,
      command: {
        label: 'typecheck:packages/autopilot',
        command: 'corepack',
        args: ['yarn', 'typecheck'],
        cwd: `${REPO}/packages/autopilot`,
      },
      network: 'none',
      environment: {},
    });

    expect(install.network).toBe('bridge');
    expect(install.phase).toBe('install');
    expect(typecheck.network).toBe('none');
    expect(typecheck.phase).toBe('verify');
    expect(typecheck.argv).toContain('--network');
    expect(typecheck.argv[typecheck.argv.indexOf('--network') + 1]).toBe('none');
    expect(typecheck.argv).toContain('--workdir');
    expect(typecheck.argv[typecheck.argv.indexOf('--workdir') + 1]).toBe('/workspace/packages/autopilot');
  });
});

describe('createProductionMarketplaceVerificationPort', () => {
  it('preflights Docker and the pinned image without mutating GitHub state', async () => {
    const inspectCalls: string[] = [];
    const port = createProductionMarketplaceVerificationPort({
      now: clock(),
      dockerRunner: passingRunner(),
      dockerInspector: {
        inspectDaemon: async () => {
          inspectCalls.push('daemon');
          return true;
        },
        inspectImage: async (image) => {
          inspectCalls.push(`image:${image}`);
          return true;
        },
      },
      cleanup: confirmedCleanup(),
      prepareWorkspace: async () => {},
    });

    await expect(port.preflight()).resolves.toEqual({ ok: true });
    expect(inspectCalls).toEqual([
      'daemon',
      `image:${JINN_MONO_V1_VERIFICATION_NODE_IMAGE}`,
    ]);
  });

  it('reports preflight failure when the daemon or pinned image is unavailable', async () => {
    const port = createProductionMarketplaceVerificationPort({
      dockerRunner: passingRunner(),
      dockerInspector: {
        inspectDaemon: async () => false,
        inspectImage: async () => true,
      },
      cleanup: confirmedCleanup(),
      prepareWorkspace: async () => {},
    });

    await expect(port.preflight()).resolves.toMatchObject({
      ok: false,
      detail: expect.stringMatching(/docker daemon/i),
    });
  });

  it('fails closed in verify before docker when the daemon or pinned image is unavailable', async () => {
    const dockerRunner = vi.fn(passingRunner());
    const port = createProductionMarketplaceVerificationPort({
      now: clock(),
      dockerRunner,
      dockerInspector: {
        inspectDaemon: async () => false,
        inspectImage: async () => true,
      },
      cleanup: confirmedCleanup(),
      prepareWorkspace: async () => {},
    });

    await expect(port.verify(verifyInput)).rejects.toMatchObject({
      reason: 'runner-failed',
      disposition: 'recoverable',
      message: expect.stringMatching(/docker daemon/i),
    });
    expect(dockerRunner).not.toHaveBeenCalled();
  });

  it('rejects verification before starting when the adoption deadline has already passed', async () => {
    const invocations: MarketplaceVerificationDockerInvocation[] = [];
    const port = createProductionMarketplaceVerificationPort({
      now: clock('2020-01-01T03:00:00.000Z'),
      dockerRunner: passingRunner(invocations),
      dockerInspector: {
        inspectDaemon: async () => true,
        inspectImage: async () => true,
      },
      cleanup: confirmedCleanup(),
      prepareWorkspace: async () => {},
    });

    await expect(port.verify(verifyInput)).rejects.toMatchObject({
      reason: 'deadline-expired',
      disposition: 'abandoned',
    });
    expect(invocations).toEqual([]);
  });

  it('runs install with network enabled before network-disabled verification commands', async () => {
    const invocations: MarketplaceVerificationDockerInvocation[] = [];
    const port = createProductionMarketplaceVerificationPort({
      now: clock(),
      dockerRunner: passingRunner(invocations),
      dockerInspector: {
        inspectDaemon: async () => true,
        inspectImage: async () => true,
      },
      cleanup: confirmedCleanup(),
      prepareWorkspace: async () => {},
    });

    await port.verify(verifyInput);

    expect(invocations.map((entry) => [entry.label, entry.network, entry.phase])).toEqual([
      ['install', 'bridge', 'install'],
      ['typecheck:packages/autopilot', 'none', 'verify'],
      ['test:packages/autopilot', 'none', 'verify'],
    ]);
  });

  it('classifies a stale immutable lockfile install failure as stable-rejection', async () => {
    const port = createProductionMarketplaceVerificationPort({
      now: clock(),
      dockerRunner: async (invocation) => (
        invocation.label === 'install'
          ? {
            exitCode: 1,
            stdout: '',
            stderr: 'YN0028: The lockfile would have been modified by this install, which is explicitly forbidden.',
          }
          : { exitCode: 0, stdout: invocation.label, stderr: '' }
      ),
      dockerInspector: {
        inspectDaemon: async () => true,
        inspectImage: async () => true,
      },
      cleanup: confirmedCleanup(),
      prepareWorkspace: async () => {},
    });

    await expect(port.verify(verifyInput)).rejects.toMatchObject({
      reason: 'command-failed',
      disposition: 'stable-rejection',
    });
  });

  it('classifies signal and OOM-class non-install exits as recoverable', async () => {
    for (const exitCode of [137, 143]) {
      const port = createProductionMarketplaceVerificationPort({
        now: clock(),
        dockerRunner: async (invocation) => (
          invocation.label === 'install'
            ? { exitCode: 0, stdout: invocation.label, stderr: '' }
            : { exitCode, stdout: '', stderr: '' }
        ),
        dockerInspector: {
          inspectDaemon: async () => true,
          inspectImage: async () => true,
        },
        cleanup: confirmedCleanup(),
        prepareWorkspace: async () => {},
      });

      await expect(port.verify(verifyInput)).rejects.toMatchObject({
        reason: 'command-failed',
        disposition: 'recoverable',
      });
    }
  });

  it('classifies a normal non-install failure as stable-rejection', async () => {
    const port = createProductionMarketplaceVerificationPort({
      now: clock(),
      dockerRunner: async (invocation) => (
        invocation.label === 'typecheck:packages/autopilot'
          ? { exitCode: 1, stdout: '', stderr: 'type error' }
          : { exitCode: 0, stdout: invocation.label, stderr: '' }
      ),
      dockerInspector: {
        inspectDaemon: async () => true,
        inspectImage: async () => true,
      },
      cleanup: confirmedCleanup(),
      prepareWorkspace: async () => {},
    });

    await expect(port.verify(verifyInput)).rejects.toMatchObject({
      reason: 'command-failed',
      disposition: 'stable-rejection',
    });
  });

  it('classifies a registry outage during install as recoverable', async () => {
    const port = createProductionMarketplaceVerificationPort({
      now: clock(),
      dockerRunner: async (invocation) => (
        invocation.label === 'install'
          ? {
            exitCode: 1,
            stdout: '',
            stderr: 'getaddrinfo ENOTFOUND registry.yarnpkg.com',
          }
          : { exitCode: 0, stdout: invocation.label, stderr: '' }
      ),
      dockerInspector: {
        inspectDaemon: async () => true,
        inspectImage: async () => true,
      },
      cleanup: confirmedCleanup(),
      prepareWorkspace: async () => {},
    });

    await expect(port.verify(verifyInput)).rejects.toMatchObject({
      reason: 'command-failed',
      disposition: 'recoverable',
    });
  });

  it('enforces per-command and total output bounds while producing decoder-legal evidence', async () => {
    const huge = 'x'.repeat(MARKETPLACE_VERIFICATION_SANDBOX_LIMITS.maxRetainedOutputBytes + 128);
    const port = createProductionMarketplaceVerificationPort({
      now: clock(),
      dockerRunner: async (invocation) => ({
        exitCode: 0,
        stdout: `${invocation.label}:${huge}`,
        stderr: huge,
      }),
      dockerInspector: {
        inspectDaemon: async () => true,
        inspectImage: async () => true,
      },
      cleanup: confirmedCleanup(),
      prepareWorkspace: async () => {},
    });

    const evidence = await port.verify(verifyInput);
    const decoded = decodeMarketplaceExecutionV3State(
      solutionVerifiedState(evidence),
      DECODER_ATTEMPT_DIR,
    );

    expect(decoded.status).toBe('solution-verified');
    expect(evidence.planDigest).toBe(marketplaceVerificationPlanDigest(
      buildJinnMonoV1VerificationPlan({
        repositoryPath: REPO,
        touchedPaths: verifyInput.touchedPaths,
      }),
    ));
    for (const command of evidence.commands) {
      expect(command.stdoutDigest).toBe(digestBoundedVerificationOutput(`${command.label}:${huge}`));
      expect(command.stderrDigest).toBe(digestBoundedVerificationOutput(huge));
    }
  });

  it('stops before the next command once the deadline passes mid-run', async () => {
    const invocations: MarketplaceVerificationDockerInvocation[] = [];
    const port = createProductionMarketplaceVerificationPort({
      now: clock(),
      dockerRunner: passingRunner(invocations),
      dockerInspector: {
        inspectDaemon: async () => true,
        inspectImage: async () => true,
      },
      cleanup: confirmedCleanup(),
      prepareWorkspace: async () => {},
    });

    await expect(port.verify({ ...verifyInput, deadline: '2020-01-01T00:00:03.000Z' }))
      .rejects.toMatchObject({
        reason: 'deadline-expired',
        disposition: 'abandoned',
      });
    expect(invocations.map((entry) => entry.label)).toEqual(['install']);
  });

  it('escalates SIGTERM ambiguity to SIGKILL before failing closed', async () => {
    const signals: string[] = [];
    const port = createProductionMarketplaceVerificationPort({
      now: clock(),
      dockerRunner: passingRunner(),
      dockerInspector: {
        inspectDaemon: async () => true,
        inspectImage: async () => true,
      },
      cleanup: async ({ signal }) => {
        signals.push(signal);
        return signal === 'SIGTERM' ? 'ambiguous' : 'confirmed';
      },
      prepareWorkspace: async () => {},
    });

    await expect(port.verify(verifyInput)).resolves.toBeDefined();
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('cleans up with SIGTERM then SIGKILL and fails closed when cleanup is ambiguous', async () => {
    const signals: string[] = [];
    const port = createProductionMarketplaceVerificationPort({
      now: clock(),
      dockerRunner: async () => {
        throw new MarketplaceVerificationError(
          'runner-failed',
          'recoverable',
          'sandbox interrupted',
        );
      },
      dockerInspector: {
        inspectDaemon: async () => true,
        inspectImage: async () => true,
      },
      cleanup: async ({ signal }) => {
        signals.push(signal);
        return signal === 'SIGKILL' ? 'ambiguous' : 'confirmed';
      },
      prepareWorkspace: async () => {},
    });

    await expect(port.verify(verifyInput)).rejects.toMatchObject({
      reason: 'unsafe-cleanup',
      disposition: 'unsafe',
    });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('preserves a classified failure the runner raised itself', async () => {
    const port = createProductionMarketplaceVerificationPort({
      now: clock(),
      dockerRunner: async () => {
        throw new MarketplaceVerificationError(
          'unsafe-cleanup',
          'unsafe',
          'container teardown could not be confirmed',
        );
      },
      dockerInspector: {
        inspectDaemon: async () => true,
        inspectImage: async () => true,
      },
      cleanup: confirmedCleanup(),
      prepareWorkspace: async () => {},
    });

    await expect(port.verify(verifyInput)).rejects.toMatchObject({
      reason: 'unsafe-cleanup',
      disposition: 'unsafe',
    });
  });

  it('enforces per-command timeout on docker invocations', async () => {
    vi.useFakeTimers({ now: Date.parse('2020-01-01T00:00:00.000Z') });
    try {
      const invocations: MarketplaceVerificationDockerInvocation[] = [];
      const installBlocked = new Promise<void>(() => {});
      const port = createProductionMarketplaceVerificationPort({
        now: () => new Date(Date.parse('2020-01-01T00:00:00.000Z')),
        dockerRunner: async (invocation) => {
          invocations.push(invocation);
          if (invocation.label === 'install') {
            await installBlocked;
          }
          return { exitCode: 0, stdout: invocation.label, stderr: '' };
        },
        dockerInspector: {
          inspectDaemon: async () => true,
          inspectImage: async () => true,
        },
        cleanup: confirmedCleanup(),
        prepareWorkspace: async () => {},
      });

      const verifyPromise = port.verify({
        ...verifyInput,
        deadline: '2020-01-01T00:00:02.000Z',
      });
      const expectation = expect(verifyPromise).rejects.toMatchObject({
        reason: 'deadline-expired',
        disposition: 'abandoned',
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await expectation;
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.perCommandTimeoutSeconds).toBe(
        MARKETPLACE_VERIFICATION_SANDBOX_LIMITS.perCommandTimeoutSeconds,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('records every planned command in order with bounded digests on success', async () => {
    const port = createProductionMarketplaceVerificationPort({
      now: clock(),
      dockerRunner: async (invocation) => ({
        exitCode: 0,
        stdout: invocation.label,
        stderr: 'e',
      }),
      dockerInspector: {
        inspectDaemon: async () => true,
        inspectImage: async () => true,
      },
      cleanup: confirmedCleanup(),
      prepareWorkspace: async () => {},
    });

    const evidence = await port.verify(verifyInput);

    expect(evidence.commands.map((entry) => entry.label)).toEqual([
      'install',
      'typecheck:packages/autopilot',
      'test:packages/autopilot',
    ]);
    expect(evidence.commands.every((entry) => entry.exitCode === 0 && entry.status === 'passed'))
      .toBe(true);
    expect(evidence.commands[0]?.stdoutDigest).toBe(digestOf('install'));
  });
});
