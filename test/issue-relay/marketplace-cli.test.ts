import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MarketplaceMachineCliFailure,
  MarketplaceMachineCliProtocolError,
  MarketplaceMachineSubprocessPolicyError,
} from '../../src/lifecycle/marketplace-cli.js';
import { relayGeneration, relayTaskKey } from '../../src/issue-relay/identity.js';
import {
  buildRelaySolutionExpectation,
  buildRelaySolutionExpectationV2,
  persistRelaySolutionExpectation,
  persistRelaySolutionExpectationV2,
} from '../../src/issue-relay/marketplace-state.js';
import {
  IssueRelayMarketplaceCli,
  parseIssueRelayDeliveryObservation,
  type IssueRelayMarketplaceSubprocess,
} from '../../src/issue-relay/marketplace-cli.js';
import { buildRelaySnapshot } from '../../src/issue-relay/snapshot.js';
import {
  buildRelayMarketplaceRequest,
  buildRelayTaskSpec,
  buildRelayTaskSpecV2,
  persistRelayMarketplaceRequest,
} from '../../src/issue-relay/task.js';

const temporaryDirectories: string[] = [];
const base = '1'.repeat(40);
const evaluation = {
  relayBotLogin: 'jinn-relay',
  requiredChecks: ['ci/typecheck'],
  laneSpecifications: {
    security: `sha256:${'a'.repeat(64)}` as const,
    quality: `sha256:${'b'.repeat(64)}` as const,
  },
};
const snapshot = buildRelaySnapshot({
  repository: {
    slug: 'Jinn-Network/mono',
    nodeId: 'R_kgDOExample',
    visibility: 'PUBLIC',
    defaultBranch: 'main',
    baseOid: base,
  },
  issue: {
    number: 42,
    url: 'https://github.com/Jinn-Network/mono/issues/42',
    title: 'Preserve exact Relay state',
    body: 'Persist before submit.',
    authorLogin: 'alice',
    authorId: 'U_kgDOAlice',
    updatedAt: '2026-07-28T10:00:00.000Z',
  },
  optIn: {
    label: 'engine:marketplace',
    actorLogin: 'alice',
    createdAt: '2026-07-28T10:01:00.000Z',
    permission: 'MAINTAIN',
  },
  language: 'typescript',
  verificationProfile: 'jinn-mono.v1',
  acceptanceEvidence: ['Focused tests pass.'],
  admissionPolicyVersion: 'jinn-issue-relay-admission.v1',
  capturedAt: '2026-07-28T10:02:00.000Z',
});
const task = buildRelayTaskSpec({
  snapshot,
  round: 0,
  purpose: 'initial',
  workspaceRepository: 'Jinn-Network/mono',
  inputHead: base,
  findings: [],
});
const creatorSafe = `0x${'a'.repeat(40)}`;
const creationTx = `0x${'b'.repeat(64)}`;
const taskCid = `f01551220${'c'.repeat(64)}`;
const envelopeCid = `f01551220${'d'.repeat(64)}`;
const manifestCid = 'bafy-solver-net';
const submitted = {
  schemaVersion: 1,
  generatedAt: '2026-07-28T10:05:00.000Z',
  verb: 'tasks submit',
  id: relayTaskKey(relayGeneration(snapshot), 0),
  creatorMultisig: creatorSafe,
  taskId: '501',
  taskCid,
  creationTx,
  creationBlock: 100,
  solverNetManifestCid: manifestCid,
  status: 'submitted',
  idempotent: false,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function persistedRequest(): {
  readonly requestPath: string;
  readonly requestDigest: string;
  readonly expectationPath: string;
  readonly expectationDigest: string;
  readonly argv: readonly string[];
} {
  const directory = mkdtempSync(join(tmpdir(), 'autopilot-relay-cli-'));
  temporaryDirectories.push(directory);
  const requestPath = join(directory, 'request.json');
  const specPath = join(directory, 'spec.json');
  const request = buildRelayMarketplaceRequest({
    task,
    solverNet: 'jinn-repo',
    maximumSpendWei: 100n,
    specPath,
    createdAt: '2026-07-28T10:03:00.000Z',
    submitBy: '2026-07-28T10:18:00.000Z',
  });
  const requestArtifact = persistRelayMarketplaceRequest(requestPath, request);
  const expectationPath = join(directory, 'expectation.json');
  const expectationArtifact = persistRelaySolutionExpectation(
    expectationPath,
    buildRelaySolutionExpectation({
      submission: {
        id: submitted.id,
        taskId: submitted.taskId,
        taskCid: submitted.taskCid,
        creationTx: submitted.creationTx,
        creationBlock: submitted.creationBlock,
        solverNetManifestCid: submitted.solverNetManifestCid,
        idempotent: submitted.idempotent,
      },
      round: task.spec.relay,
    }),
  );
  return {
    requestPath,
    requestDigest: requestArtifact.requestDigest,
    expectationPath,
    expectationDigest: expectationArtifact.digest,
    argv: request.argv,
  };
}

const dryRunEnvelope = {
  schemaVersion: 1,
  generatedAt: '2026-07-28T10:04:00.000Z',
  dryRun: true,
  verb: 'tasks submit',
  description: `Would post task '${submitted.id}' from ${creatorSafe}`,
  plan: [{
    id: submitted.id,
    description: 'Relay round',
    creatorMultisig: creatorSafe,
    asset: 'native',
    txCount: 1,
    solverNetManifestCid: manifestCid,
    proposedSpendWei: '40',
    solverType: 'jinn-repo.v1',
    spec: task.spec,
  }],
};

describe('Issue Relay marketplace CLI submission', () => {
  it('does not implicitly forward ambient Jinn session paths that can lead to host credentials', async () => {
    const fixture = persistedRequest();
    vi.stubEnv('JINN_AUTOPILOT_SESSION_MANIFEST', '/attempt/private/manifest.json');
    vi.stubEnv('JINN_IMPL_GH_TOKEN', 'must-not-leak');
    const run = vi.fn<IssueRelayMarketplaceSubprocess>(async () => ({
      exitCode: 30,
      stdout: JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-07-28T10:07:00.000Z',
        verb: 'tasks observe-issue-relay-delivery',
        observation: {
          status: 'pending',
          reason: 'delivery-not-found',
        },
      }),
      stderr: '',
    }));
    const cli = new IssueRelayMarketplaceCli({
      jinnBinary: '/installed/bin/jinn',
      now: () => new Date('2026-07-28T10:06:00.000Z'),
      run,
    });

    await cli.observe(fixture.expectationPath, fixture.expectationDigest);

    expect(run.mock.calls[0]?.[2].environment)
      .not.toHaveProperty('JINN_AUTOPILOT_SESSION_MANIFEST');
    expect(run.mock.calls[0]?.[2].environment)
      .not.toHaveProperty('JINN_IMPL_GH_TOKEN');
    expect(run.mock.calls[0]?.[2].environment).toMatchObject({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NO_COLOR: '1',
    });
  });

  it('dry-runs then submits with exact argv, least environment, spend pins, and idempotent evidence', async () => {
    const fixture = persistedRequest();
    const run = vi.fn<IssueRelayMarketplaceSubprocess>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: `${JSON.stringify(dryRunEnvelope)}\n`,
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: `${JSON.stringify(submitted)}\n`,
        stderr: '',
      });
    const cli = new IssueRelayMarketplaceCli({
      jinnBinary: '/installed/bin/jinn',
      environment: {
        PATH: '/installed/bin',
        HOME: '/operator',
        TMPDIR: '/private/tmp',
        JINN_CONFIG_HOME: '/operator/jinn',
        JINN_WALLET_PASSWORD: 'wallet-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/private/manifest.json',
        JINN_LOAD_DEV_ENV: '1',
        BASE_RPC_URL: 'https://rpc.example',
        GH_TOKEN: 'must-not-leak',
        GITHUB_TOKEN: 'must-not-leak',
        JINN_IMPL_GH_TOKEN: 'must-not-leak',
        AWS_SECRET_ACCESS_KEY: 'must-not-leak',
      },
      now: () => new Date('2026-07-28T10:06:00.000Z'),
      run,
    });

    await expect(cli.dryRun(
      fixture.requestPath,
      fixture.requestDigest,
    )).resolves.toEqual({
      id: submitted.id,
      creatorSafe,
      solverNetManifestCid: manifestCid,
      proposedSpendWei: 40n,
    });
    await expect(cli.submit(
      fixture.requestPath,
      fixture.requestDigest,
    )).resolves.toEqual({
      id: submitted.id,
      taskId: '501',
      taskCid,
      creationTx,
      creationBlock: 100,
      solverNetManifestCid: manifestCid,
      idempotent: false,
    });

    expect(run.mock.calls[0]?.[0]).toBe('/installed/bin/jinn');
    expect(run.mock.calls[0]?.[1]).toEqual([
      ...fixture.argv.slice(0, -2),
      '--dry-run',
      '--yes',
      '--json',
    ]);
    expect(run.mock.calls[1]?.[1]).toEqual(fixture.argv);
    expect(run.mock.calls[0]?.[2]).toEqual({
      environment: {
        PATH: '/installed/bin',
        HOME: '/operator',
        TMPDIR: '/private/tmp',
        JINN_CONFIG_HOME: '/operator/jinn',
        JINN_WALLET_PASSWORD: 'wallet-secret',
        BASE_RPC_URL: 'https://rpc.example',
        NO_COLOR: '1',
      },
      outputProfile: 'issue-relay-dry-run',
    });
    expect(run.mock.calls[1]?.[2]).toEqual({
      environment: {
        PATH: '/installed/bin',
        HOME: '/operator',
        TMPDIR: '/private/tmp',
        JINN_CONFIG_HOME: '/operator/jinn',
        JINN_WALLET_PASSWORD: 'wallet-secret',
        BASE_RPC_URL: 'https://rpc.example',
        NO_COLOR: '1',
        JINN_RELAY_EXPECTED_CREATOR_SAFE: creatorSafe,
        JINN_RELAY_EXPECTED_SOLVERNET_MANIFEST_CID: manifestCid,
        JINN_RELAY_EXPECTED_SPEND_WEI: '40',
      },
    });
  });

  it('requires a fresh spend confirmation and rejects stale or changed dry-run pins', async () => {
    const fixture = persistedRequest();
    const run = vi.fn<IssueRelayMarketplaceSubprocess>(async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify(submitted)}\n`,
      stderr: '',
    }));
    const withoutConfirmation = new IssueRelayMarketplaceCli({
      jinnBinary: '/installed/bin/jinn',
      environment: { PATH: '/bin' },
      now: () => new Date('2026-07-28T10:06:00.000Z'),
      run,
    });

    await expect(withoutConfirmation.submit(
      fixture.requestPath,
      fixture.requestDigest,
    ))
      .rejects.toThrow(/dry-run spend confirmation/i);
    expect(run).not.toHaveBeenCalled();

    const stale = new IssueRelayMarketplaceCli({
      jinnBinary: '/installed/bin/jinn',
      environment: { PATH: '/bin' },
      now: () => new Date('2026-07-28T10:18:00.000Z'),
      run,
    });
    await expect(stale.dryRun(
      fixture.requestPath,
      fixture.requestDigest,
    )).rejects.toThrow(/expired/i);
    expect(run).not.toHaveBeenCalled();

    const mismatchRun = vi.fn<IssueRelayMarketplaceSubprocess>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(dryRunEnvelope),
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          ...submitted,
          solverNetManifestCid: 'bafy-different',
        }),
        stderr: '',
      });
    const mismatch = new IssueRelayMarketplaceCli({
      jinnBinary: '/installed/bin/jinn',
      environment: { PATH: '/bin' },
      now: () => new Date('2026-07-28T10:06:00.000Z'),
      run: mismatchRun,
    });
    await mismatch.dryRun(fixture.requestPath, fixture.requestDigest);
    await expect(mismatch.submit(fixture.requestPath, fixture.requestDigest))
      .rejects.toThrow(/dry-run.*solvernet/i);
  });

  it('rejects a successful dry-run that changes the exact spec or exceeds the persisted cap', async () => {
    const fixture = persistedRequest();
    for (const envelope of [
      {
        ...dryRunEnvelope,
        plan: [{
          ...dryRunEnvelope.plan[0],
          spec: { ...task.spec, base_commit: '2'.repeat(40) },
        }],
      },
      {
        ...dryRunEnvelope,
        plan: [{
          ...dryRunEnvelope.plan[0],
          proposedSpendWei: '101',
        }],
      },
    ]) {
      const run = vi.fn<IssueRelayMarketplaceSubprocess>(async () => ({
        exitCode: 0,
        stdout: JSON.stringify(envelope),
        stderr: '',
      }));
      const cli = new IssueRelayMarketplaceCli({
        jinnBinary: '/installed/bin/jinn',
        environment: { PATH: '/bin' },
        now: () => new Date('2026-07-28T10:06:00.000Z'),
        run,
      });

      await expect(cli.dryRun(fixture.requestPath, fixture.requestDigest))
        .rejects.toBeInstanceOf(MarketplaceMachineCliProtocolError);
    }
  });

  it('accepts exact already-submitted readback and rejects malformed success output', async () => {
    const fixture = persistedRequest();
    const alreadySubmitted = {
      ...submitted,
      status: 'already_submitted',
      idempotent: true,
    };
    const run = vi.fn<IssueRelayMarketplaceSubprocess>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(dryRunEnvelope),
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(alreadySubmitted),
        stderr: '',
      });
    const cli = new IssueRelayMarketplaceCli({
      jinnBinary: '/installed/bin/jinn',
      environment: { PATH: '/bin' },
      now: () => new Date('2026-07-28T10:06:00.000Z'),
      run,
    });

    await cli.dryRun(fixture.requestPath, fixture.requestDigest);
    await expect(cli.submit(
      fixture.requestPath,
      fixture.requestDigest,
    )).resolves.toMatchObject({
      taskId: '501',
      idempotent: true,
    });

    for (const stdout of [
      'not-json',
      `${JSON.stringify(submitted)}\nextra stdout`,
      JSON.stringify({ ...submitted, extra: true }),
      JSON.stringify({ ...submitted, status: 'already_submitted' }),
    ]) {
      const malformed = new IssueRelayMarketplaceCli({
        jinnBinary: '/installed/bin/jinn',
        environment: { PATH: '/bin' },
        now: () => new Date('2026-07-28T10:06:00.000Z'),
        run: vi.fn<IssueRelayMarketplaceSubprocess>()
          .mockResolvedValueOnce({
            exitCode: 0,
            stdout: JSON.stringify(dryRunEnvelope),
            stderr: '',
          })
          .mockResolvedValueOnce({ exitCode: 0, stdout, stderr: 'diagnostic' }),
      });
      await malformed.dryRun(fixture.requestPath, fixture.requestDigest);
      await expect(malformed.submit(fixture.requestPath, fixture.requestDigest))
        .rejects.toBeInstanceOf(MarketplaceMachineCliProtocolError);
    }
  });

  it('fails closed on a nonzero machine envelope and subprocess timeout', async () => {
    const fixture = persistedRequest();
    const failure = {
      schemaVersion: 1,
      generatedAt: '2026-07-28T10:04:00.000Z',
      code: 'transient_error',
      exitCode: 40,
      message: 'RPC unavailable',
    };
    const nonzero = new IssueRelayMarketplaceCli({
      jinnBinary: '/installed/bin/jinn',
      environment: { PATH: '/bin' },
      now: () => new Date('2026-07-28T10:06:00.000Z'),
      run: async () => ({
        exitCode: 40,
        stdout: JSON.stringify(failure),
        stderr: 'rpc diagnostic',
      }),
    });
    await expect(nonzero.dryRun(fixture.requestPath, fixture.requestDigest))
      .rejects.toBeInstanceOf(MarketplaceMachineCliFailure);

    const timeout = new MarketplaceMachineSubprocessPolicyError(
      'timeout',
      'jinn exceeded 300000ms',
    );
    const hung = new IssueRelayMarketplaceCli({
      jinnBinary: '/installed/bin/jinn',
      environment: { PATH: '/bin' },
      now: () => new Date('2026-07-28T10:06:00.000Z'),
      run: async () => { throw timeout; },
    });
    await expect(hung.dryRun(
      fixture.requestPath,
      fixture.requestDigest,
    )).rejects.toBe(timeout);
  });

  it('rejects canonical request replacement against the independently persisted digest', async () => {
    const fixture = persistedRequest();
    const replacement = JSON.parse(
      readFileSync(fixture.requestPath, 'utf8'),
    ) as { solverNet?: string; argv: string[] };
    replacement.argv[7] = 'different-solver-net';
    writeFileSync(
      fixture.requestPath,
      `${JSON.stringify(replacement, null, 2)}\n`,
      { mode: 0o600 },
    );
    const run = vi.fn<IssueRelayMarketplaceSubprocess>();
    const cli = new IssueRelayMarketplaceCli({
      jinnBinary: '/installed/bin/jinn',
      environment: { PATH: '/bin' },
      now: () => new Date('2026-07-28T10:06:00.000Z'),
      run,
    });

    await expect(cli.dryRun(fixture.requestPath, fixture.requestDigest))
      .rejects.toThrow(/digest mismatch/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects a request before its canonical creation instant', async () => {
    const fixture = persistedRequest();
    const run = vi.fn<IssueRelayMarketplaceSubprocess>();
    const cli = new IssueRelayMarketplaceCli({
      jinnBinary: '/installed/bin/jinn',
      environment: { PATH: '/bin' },
      now: () => new Date('2026-07-28T10:02:59.999Z'),
      run,
    });

    await expect(cli.dryRun(fixture.requestPath, fixture.requestDigest))
      .rejects.toThrow(/not active|creation/i);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('Issue Relay marketplace CLI observation', () => {
  it('uses generic application observation for a V2 Relay task and unwraps the owned result', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'autopilot-relay-cli-v2-'));
    temporaryDirectories.push(directory);
    const round = {
      schemaVersion: 'jinn-issue-relay-round.v2' as const,
      generation: relayGeneration(snapshot),
      round: 0,
      snapshotDigest: snapshot.snapshotDigest,
      targetRepository: 'Jinn-Network/mono',
      workspaceRepository: 'Jinn-Network/mono',
      inputHead: base,
      purpose: 'initial' as const,
      findings: [],
    };
    const taskV2 = buildRelayTaskSpecV2({ snapshot, evaluation, round });
    const persisted = persistRelaySolutionExpectationV2(
      join(directory, 'expectation.json'),
      buildRelaySolutionExpectationV2({
        submission: {
          id: submitted.id,
          taskId: submitted.taskId,
          taskCid: submitted.taskCid,
          creationTx: submitted.creationTx,
          creationBlock: submitted.creationBlock,
          solverNetManifestCid: submitted.solverNetManifestCid,
          idempotent: submitted.idempotent,
        },
        taskSpec: taskV2.spec,
      }),
    );
    const solution = {
      schemaVersion: 'jinn-issue-relay-solution.v2',
      patch: 'diff --git a/a.ts b/a.ts\n',
      pullRequest: {
        title: 'Preserve exact Relay state',
        body: '## Summary\n\nPreserves exact state.\n\n## Testing\n\n- yarn test',
      },
    };
    const transportObservation = {
      status: 'verified',
      role: 'solution',
      task: { taskId: '501', taskCid },
      attempt: {
        attemptIndex: 0,
        requestId: `0x${'d'.repeat(64)}`,
        operator: `0x${'e'.repeat(40)}`,
      },
      delivery: {
        envelopeCid,
        transactionHash: `0x${'f'.repeat(64)}`,
        blockNumber: 120,
      },
      payload: {
        schemaVersion: 'jinn-repo-application-payload.v1',
        application: { id: 'autopilot.issue-relay', version: 'v2' },
        role: 'solution',
        payload: solution,
      },
    };
    const run = vi.fn<IssueRelayMarketplaceSubprocess>(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-07-28T10:07:00.000Z',
        verb: 'tasks observe-application-delivery',
        observation: transportObservation,
      }),
      stderr: '',
    }));
    const cli = new IssueRelayMarketplaceCli({
      jinnBinary: '/installed/bin/jinn',
      environment: { PATH: '/bin', GH_TOKEN: 'must-not-leak' },
      run,
    });

    await expect(cli.observe(persisted.path, persisted.digest)).resolves.toEqual({
      ...transportObservation,
      round,
      payload: solution,
    });
    expect(run).toHaveBeenCalledWith('/installed/bin/jinn', [
      'tasks',
      'observe-application-delivery',
      '--expectation-file',
      persisted.path,
      '--json',
    ], {
      environment: { PATH: '/bin', NO_COLOR: '1' },
      outputProfile: 'issue-relay-observation',
    });
  });

  it('accepts the canonical V2 bundle only with a V2 round', () => {
    const payload = JSON.parse(readFileSync(
      new URL('../fixtures/issue-relay-evaluation-bundle.v2.json', import.meta.url),
      'utf8',
    )) as Record<string, unknown>;
    const correlation = payload['correlation'] as {
      generation: string;
      round: number;
      snapshotDigest: string;
    };
    const roundV2 = {
      schemaVersion: 'jinn-issue-relay-round.v2',
      generation: correlation.generation,
      round: correlation.round,
      snapshotDigest: correlation.snapshotDigest,
      targetRepository: 'Jinn-Network/mono',
      workspaceRepository: 'Jinn-Network/mono',
      inputHead: base,
      purpose: 'initial',
      findings: [],
    };
    const observation = {
      status: 'verified', role: 'verdict', task: { taskId: '501', taskCid },
      attempt: { attemptIndex: 0, requestId: `0x${'3'.repeat(64)}`, operator: `0x${'e'.repeat(40)}` },
      delivery: { envelopeCid, transactionHash: `0x${'f'.repeat(64)}`, blockNumber: 120 },
      round: roundV2,
      payload,
    };
    expect(parseIssueRelayDeliveryObservation(observation)).toMatchObject({
      role: 'verdict',
      round: { schemaVersion: 'jinn-issue-relay-round.v2' },
      payload: { schemaVersion: 'jinn-issue-relay-evaluation-bundle.v2' },
    });
    expect(() => parseIssueRelayDeliveryObservation({
      ...observation,
      round: task.spec.relay,
    })).toThrow();
  });

  it('accepts a 2 MiB UTF-8 patch and rejects the next byte', () => {
    const common = {
      status: 'verified' as const,
      role: 'solution' as const,
      task: { taskId: '501', taskCid },
      attempt: {
        attemptIndex: 0,
        requestId: `0x${'d'.repeat(64)}`,
        operator: `0x${'e'.repeat(40)}`,
      },
      delivery: {
        envelopeCid,
        transactionHash: `0x${'f'.repeat(64)}`,
        blockNumber: 120,
      },
      round: task.spec.relay,
    };
    const maximumPatch = 'x'.repeat(2 * 1024 * 1024);

    expect(parseIssueRelayDeliveryObservation({
      ...common,
      payload: {
        schemaVersion: 'jinn-repo-solution.v1',
        patch: maximumPatch,
      },
    })).toMatchObject({ status: 'verified', role: 'solution' });
    expect(() => parseIssueRelayDeliveryObservation({
      ...common,
      payload: {
        schemaVersion: 'jinn-repo-solution.v1',
        patch: `${maximumPatch}x`,
      },
    })).toThrow();
  });

  it('bounds canonical Task IDs, envelope CIDs, and pending diagnostics', () => {
    const maximumTaskId = ((1n << 256n) - 1n).toString();
    const maximumPending = {
      status: 'pending' as const,
      reason: 'r'.repeat(240),
      detail: 'd'.repeat(8 * 1024),
    };
    const verified = {
      status: 'verified' as const,
      role: 'solution' as const,
      task: { taskId: maximumTaskId, taskCid },
      attempt: {
        attemptIndex: 0,
        requestId: `0x${'d'.repeat(64)}`,
        operator: `0x${'e'.repeat(40)}`,
      },
      delivery: {
        envelopeCid,
        transactionHash: `0x${'f'.repeat(64)}`,
        blockNumber: 120,
      },
      round: task.spec.relay,
      payload: {
        schemaVersion: 'jinn-repo-solution.v1' as const,
        patch: 'diff --git a/a.ts b/a.ts\n',
      },
    };

    expect(parseIssueRelayDeliveryObservation(verified))
      .toMatchObject({ task: { taskId: maximumTaskId } });
    expect(parseIssueRelayDeliveryObservation(maximumPending))
      .toEqual(maximumPending);

    for (const invalid of [
      {
        ...verified,
        task: { ...verified.task, taskId: (1n << 256n).toString() },
      },
      {
        ...verified,
        task: { ...verified.task, taskId: '01' },
      },
      {
        ...verified,
        delivery: { ...verified.delivery, envelopeCid: `${envelopeCid}0` },
      },
      {
        status: 'pending',
        reason: 'r'.repeat(241),
      },
      {
        status: 'contradiction',
        reason: 'task-mismatch',
        detail: 'd'.repeat(8 * 1024 + 1),
      },
    ]) {
      expect(() => parseIssueRelayDeliveryObservation(invalid)).toThrow();
    }
  });

  it('accepts canonical base32 CID padding bits and rejects noncanonical padding', () => {
    const verified = {
      status: 'verified' as const,
      role: 'solution' as const,
      task: { taskId: '501', taskCid },
      attempt: {
        attemptIndex: 0,
        requestId: `0x${'d'.repeat(64)}`,
        operator: `0x${'e'.repeat(40)}`,
      },
      delivery: {
        envelopeCid:
          'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4',
        transactionHash: `0x${'f'.repeat(64)}`,
        blockNumber: 120,
      },
      round: task.spec.relay,
      payload: {
        schemaVersion: 'jinn-repo-solution.v1' as const,
        patch: 'diff --git a/a.ts b/a.ts\n',
      },
    };

    expect(parseIssueRelayDeliveryObservation(verified))
      .toMatchObject({ delivery: { envelopeCid: verified.delivery.envelopeCid } });
    expect(() => parseIssueRelayDeliveryObservation({
      ...verified,
      delivery: {
        ...verified.delivery,
        envelopeCid:
          'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6',
      },
    })).toThrow();
  });

  it('uses the exact read-only observation argv and accepts one strict verified envelope', async () => {
    const fixture = persistedRequest();
    const observation = {
      status: 'verified',
      role: 'solution',
      task: { taskId: '501', taskCid },
      attempt: {
        attemptIndex: 0,
        requestId: `0x${'d'.repeat(64)}`,
        operator: `0x${'e'.repeat(40)}`,
      },
      delivery: {
        envelopeCid,
        transactionHash: `0x${'f'.repeat(64)}`,
        blockNumber: 120,
      },
      round: task.spec.relay,
      payload: {
        schemaVersion: 'jinn-repo-solution.v1',
        patch: 'diff --git a/a.ts b/a.ts\n',
      },
    };
    const run = vi.fn<IssueRelayMarketplaceSubprocess>(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-07-28T10:07:00.000Z',
        verb: 'tasks observe-issue-relay-delivery',
        observation,
      }),
      stderr: '',
    }));
    const cli = new IssueRelayMarketplaceCli({
      jinnBinary: '/installed/bin/jinn',
      environment: { PATH: '/bin', GH_TOKEN: 'must-not-leak' },
      now: () => new Date('2026-07-28T10:06:00.000Z'),
      run,
    });

    await expect(cli.observe(
      fixture.expectationPath,
      fixture.expectationDigest,
    )).resolves.toEqual(observation);
    expect(run).toHaveBeenCalledWith('/installed/bin/jinn', [
      'tasks',
      'observe-issue-relay-delivery',
      '--expectation-file',
      fixture.expectationPath,
      '--json',
    ], {
      environment: { PATH: '/bin', NO_COLOR: '1' },
      outputProfile: 'issue-relay-observation',
    });
  });

  it('returns documented pending/contradiction observations but rejects operational nonzero output', async () => {
    const fixture = persistedRequest();
    for (const [exitCode, observation] of [
      [30, { status: 'pending', reason: 'delivery-not-found' }],
      [50, {
        status: 'contradiction',
        reason: 'task-mismatch',
        detail: 'wrong Task CID',
      }],
    ] as const) {
      const cli = new IssueRelayMarketplaceCli({
        jinnBinary: '/installed/bin/jinn',
        environment: { PATH: '/bin' },
        now: () => new Date('2026-07-28T10:06:00.000Z'),
        run: async () => ({
          exitCode,
          stdout: JSON.stringify({
            schemaVersion: 1,
            generatedAt: '2026-07-28T10:07:00.000Z',
            verb: 'tasks observe-issue-relay-delivery',
            observation,
          }),
          stderr: '',
        }),
      });
      await expect(cli.observe(
        fixture.expectationPath,
        fixture.expectationDigest,
      )).resolves.toEqual(observation);
    }

    const operational = new IssueRelayMarketplaceCli({
      jinnBinary: '/installed/bin/jinn',
      environment: { PATH: '/bin' },
      now: () => new Date('2026-07-28T10:06:00.000Z'),
      run: async () => ({
        exitCode: 40,
        stdout: JSON.stringify({
          schemaVersion: 1,
          generatedAt: '2026-07-28T10:07:00.000Z',
          code: 'transient_error',
          exitCode: 40,
          message: 'Indexer unavailable',
        }),
        stderr: 'diagnostic',
      }),
    });
    await expect(operational.observe(
      fixture.expectationPath,
      fixture.expectationDigest,
    ))
      .rejects.toBeInstanceOf(MarketplaceMachineCliFailure);
  });

  it('rejects canonical expectation replacement against the persisted digest before observation', async () => {
    const fixture = persistedRequest();
    const replacement = JSON.parse(
      readFileSync(fixture.expectationPath, 'utf8'),
    ) as { taskId: string };
    replacement.taskId = '502';
    writeFileSync(
      fixture.expectationPath,
      `${JSON.stringify(replacement, null, 2)}\n`,
      { mode: 0o600 },
    );
    const run = vi.fn<IssueRelayMarketplaceSubprocess>();
    const cli = new IssueRelayMarketplaceCli({
      jinnBinary: '/installed/bin/jinn',
      environment: { PATH: '/bin' },
      run,
    });

    await expect(cli.observe(
      fixture.expectationPath,
      fixture.expectationDigest,
    )).rejects.toThrow(/digest mismatch/i);
    expect(run).not.toHaveBeenCalled();
  });
});
