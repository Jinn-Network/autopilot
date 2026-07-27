import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeAttemptManifest,
  readAttemptManifest,
  updateAttemptManifest,
  type AttemptManifest,
} from '../../src/lifecycle/attempt-workspace.js';
import {
  installMarketplaceEvaluatorLeg,
  transitionMarketplaceAdoption,
  transitionMarketplaceEvaluatorLeg,
  upgradeMarketplaceExecutionV2,
} from '../../src/lifecycle/marketplace-adoption-state.js';
import type {
  MarketplaceArtifactEvidence,
  MarketplaceEvaluatorLegIdentity,
  MarketplaceSolutionDeliveryEvidence,
  MarketplaceVerificationEvidence,
} from '../../src/lifecycle/marketplace-execution-state.js';
import { gitOid } from '../../src/lifecycle/types.js';

const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const REVIEW_ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const GENERATION = '33333333-3333-4333-8333-333333333333';
const OID = gitOid('a'.repeat(40));
const DIGEST = `sha256:${'b'.repeat(64)}`;
const DELIVERY_REQUEST_ID = `0x${'9'.repeat(64)}`;
const PREPARED_AT = '2026-07-27T12:00:00.000Z';
const SUBMITTED_AT = '2026-07-27T12:01:00.000Z';
const SUBMISSION = {
  schemaVersion: 1,
  generatedAt: SUBMITTED_AT,
  verb: 'tasks submit',
  id: `autopilot:${ATTEMPT_ID}`,
  creatorMultisig: `0x${'c'.repeat(40)}`,
  taskId: '501',
  taskCid: 'bafybeigdyrzt5m6u2r3o4exampletaskcid',
  creationTx: `0x${'d'.repeat(64)}`,
  creationBlock: 501,
  solverNetManifestCid: 'bafybeigdyrzt5m6u2r3o4examplesolvercid',
  status: 'submitted',
  idempotent: false,
} as const;
const roots: string[] = [];

interface AdoptionWorkerResult {
  readonly code: number | null;
  readonly result: {
    readonly ok: boolean;
    readonly error?: string;
    readonly status?: string;
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runAdoptionWorker(input: Record<string, unknown>): Promise<AdoptionWorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
      join(process.cwd(), 'test/lifecycle/marketplace-adoption-worker.ts'),
      JSON.stringify(input),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolve({
          code,
          result: JSON.parse(stdout) as AdoptionWorkerResult['result'],
        });
      } catch {
        reject(new Error(`Marketplace adoption worker did not return JSON: ${stderr}`));
      }
    });
  });
}

async function waitForFiles(...paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for adoption workers');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fixture(
  status: 'prepared' | 'submitted' | 'cancelled',
  input: {
    readonly attemptId?: string;
    readonly phase?: 'implement' | 'review';
    readonly updatedAt?: string;
  } = {},
): { readonly manifest: AttemptManifest; readonly path: string; readonly attemptDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'autopilot-marketplace-adoption-'));
  roots.push(root);
  mkdirSync(join(root, '.git'), { recursive: true });
  const attemptId = input.attemptId ?? ATTEMPT_ID;
  const phase = input.phase ?? 'implement';
  const subject = phase === 'implement' ? 'issue-42' : 'pr-84';
  const attemptDir = join(root, 'v2', 'runner-a', phase, `${subject}-${attemptId}`);
  mkdirSync(join(attemptDir, 'worktree'), { recursive: true });
  mkdirSync(join(attemptDir, 'gh-config'));
  const prepared = {
    schemaVersion: 'marketplace-execution-v2',
    requestPath: join(attemptDir, 'marketplace-request.json'),
    requestDigest: DIGEST,
    solverNetSelectionPath: join(attemptDir, 'marketplace-request.json.solvernet-selection.json'),
    preparedAt: PREPARED_AT,
    agentSoftDeadline: '2026-07-27T13:00:00.000Z',
    adoptionDeadline: '2026-07-27T14:00:00.000Z',
  } as const;
  const state = status === 'prepared'
    ? { ...prepared, status }
    : status === 'submitted'
      ? { ...prepared, status, submission: SUBMISSION, submittedAt: SUBMITTED_AT }
      : {
          ...prepared,
          status,
          cancelledAt: SUBMITTED_AT,
          reason: 'operator-cancelled',
        };
  const path = join(attemptDir, 'manifest.json');
  const manifest = decodeAttemptManifest({
    version: 2,
    attemptId,
    runnerId: 'runner-a',
    host: 'test-host',
    phase,
    execution: { backend: 'marketplace', state },
    subject,
    issueNumber: 42,
    prNumber: 84,
    branch: 'autopilot/42',
    targetBase: 'next',
    ...(phase === 'implement' ? { targetBaseOid: OID } : {}),
    expectedHead: OID,
    claimOid: OID,
    ...(phase === 'review'
      ? {
          reviewGeneration: GENERATION,
          reviewRefOid: OID,
          reviewApprovalPolicy: 'approve-eligible',
        }
      : {}),
    selectedLogin: phase === 'implement' ? 'implementation-bot' : 'review-bot',
    repository: {
      root,
      gitCommonDir: realpathSync(join(root, '.git')),
      remoteName: 'jinn-autopilot-v2',
      remoteUrlHash: 'e'.repeat(64),
    },
    processState: 'preparing',
    pid: null,
    paths: {
      attemptDir,
      worktree: join(attemptDir, 'worktree'),
      manifest: path,
      log: join(attemptDir, 'session.log'),
      ghConfigDir: join(attemptDir, 'gh-config'),
      askpass: join(attemptDir, 'askpass'),
      tokenFile: join(attemptDir, 'gh-token'),
    },
    timestamps: {
      createdAt: PREPARED_AT,
      updatedAt: input.updatedAt ?? (status === 'prepared' ? PREPARED_AT : SUBMITTED_AT),
    },
  });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { manifest, path, attemptDir };
}

function delivery(
  attemptDir: string,
  overrides: Partial<MarketplaceSolutionDeliveryEvidence> = {},
): MarketplaceSolutionDeliveryEvidence {
  return {
    observationPath: join(attemptDir, 'delivery.json'),
    observationDigest: DIGEST,
    taskId: SUBMISSION.taskId,
    taskCid: SUBMISSION.taskCid,
    taskCreationTransaction: SUBMISSION.creationTx,
    taskCreationBlock: SUBMISSION.creationBlock,
    solverNetManifestCid: SUBMISSION.solverNetManifestCid,
    attemptIndex: 0,
    requestId: DELIVERY_REQUEST_ID,
    deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid',
    deliveryEnvelopeDigest: `sha256:${'f'.repeat(64)}`,
    deliveryTransaction: `0x${'1'.repeat(64)}`,
    deliveryBlock: 502,
    solverSafe: `0x${'2'.repeat(40)}`,
    solverAgentEoa: `0x${'3'.repeat(40)}`,
    signer: `0x${'3'.repeat(40)}`,
    publisherAgentId: '501',
    correlation: {
      taskId: SUBMISSION.taskId,
      attemptIndex: 0,
      requestId: DELIVERY_REQUEST_ID,
      deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid',
      v2AttemptId: ATTEMPT_ID,
      claimOid: OID,
      prNumber: 84,
      expectedHead: OID,
    },
    observedAt: '2026-07-27T12:02:00.000Z',
    ...overrides,
  };
}

function evaluatorIdentity(
  attemptDir: string,
  overrides: Partial<MarketplaceEvaluatorLegIdentity> = {},
): MarketplaceEvaluatorLegIdentity {
  const runnerDir = join(attemptDir, '..', '..');
  return {
    originManifestPath: join(
      runnerDir,
      'implement',
      `issue-42-${ATTEMPT_ID}`,
      'manifest.json',
    ),
    originV2AttemptId: ATTEMPT_ID,
    originRequestDigest: DIGEST,
    taskId: SUBMISSION.taskId,
    taskCid: SUBMISSION.taskCid,
    taskCreationBlock: SUBMISSION.creationBlock,
    prNumber: 84,
    expectedHead: OID,
    generation: GENERATION,
    reviewRefOid: OID,
    reviewer: 'review-bot',
    ...overrides,
  };
}

const ARTIFACT: MarketplaceArtifactEvidence = {
  digest: `sha256:${'5'.repeat(64)}`,
  byteLength: 12,
  touchedPaths: ['packages/a.ts'],
  expectedTree: OID,
};

const VERIFICATION: MarketplaceVerificationEvidence = {
  profile: 'jinn-mono.v1',
  artifactDigest: ARTIFACT.digest,
  expectedTree: OID,
  planDigest: `sha256:${'6'.repeat(64)}`,
  commands: [{
    label: 'typecheck',
    command: 'yarn',
    args: ['typecheck'],
    cwdRelative: '.',
    status: 'passed',
    exitCode: 0,
    stdoutDigest: `sha256:${'7'.repeat(64)}`,
    stderrDigest: `sha256:${'8'.repeat(64)}`,
    startedAt: '2026-07-27T12:03:00.000Z',
    completedAt: '2026-07-27T12:04:00.000Z',
  }],
  verifiedAt: '2026-07-27T12:04:00.000Z',
};

const HOST_COMMIT = {
  head: OID,
  tree: OID,
  parents: [OID],
  artifactDigest: ARTIFACT.digest,
  correlationDigest: `sha256:${'9'.repeat(64)}`,
  trailers: {
    taskId: SUBMISSION.taskId,
    requestId: DELIVERY_REQUEST_ID,
    deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid',
    v2AttemptId: ATTEMPT_ID,
    artifactDigest: ARTIFACT.digest,
  },
  createdAt: '2026-07-27T12:05:00.000Z',
} as const;

const COMPLETION = {
  operation: 'implementation-complete',
  prNumber: 84,
  branch: 'autopilot/42',
  claimOid: OID,
  checkpointOid: OID,
  resultingHead: OID,
  lifecycleStatus: 'In Review',
  confirmedAt: '2026-07-27T12:06:00.000Z',
} as const;

function reviewAnchor(attemptDir: string) {
  const runnerDir = join(attemptDir, '..', '..');
  return {
    attemptId: REVIEW_ATTEMPT_ID,
    manifestPath: join(
      runnerDir,
      'review',
      `pr-84-${REVIEW_ATTEMPT_ID}`,
      'manifest.json',
    ),
    head: OID,
    generation: GENERATION,
    refOid: OID,
    reviewer: 'review-bot',
    anchoredAt: '2026-07-27T12:07:00.000Z',
  } as const;
}

function acceptedReceipt() {
  return {
    schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
    disposition: 'accepted',
    role: 'solution',
    operation: 'implementation-complete',
    taskId: SUBMISSION.taskId,
    attemptIndex: 0,
    requestId: DELIVERY_REQUEST_ID,
    deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid',
    v2AttemptId: ATTEMPT_ID,
    prNumber: 84,
    claimOid: OID,
    expectedHead: OID,
    resultingHead: OID,
    reviewGeneration: GENERATION,
    reviewRefOid: OID,
    recordedAt: '2026-07-27T12:08:00.000Z',
  } as const;
}

describe('marketplace adoption transition API', () => {
  // This catches migration that drops v2 terminal data or rewrites an already-migrated manifest.
  it.each(['prepared', 'submitted'] as const)(
    'upgrades an exact %s v2 attempt once and preserves replay bytes',
    (status) => {
      const { path } = fixture(status);
      const first = upgradeMarketplaceExecutionV2(
        path,
        DIGEST,
        () => new Date('2026-07-27T12:03:00.000Z'),
      );
      const firstBytes = readFileSync(path);
      const second = upgradeMarketplaceExecutionV2(
        path,
        DIGEST,
        () => new Date('2026-07-27T12:04:00.000Z'),
      );

      expect(first.execution).toMatchObject({
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v3',
          status,
          ...(status === 'submitted' ? { submission: SUBMISSION } : {}),
        },
      });
      expect(second).toEqual(first);
      expect(readFileSync(path)).toEqual(firstBytes);
    },
  );

  // This catches migration that invents a v3 cancellation and loses legacy recovery semantics.
  it('preserves a cancelled v2 attempt byte-for-byte', () => {
    const { path } = fixture('cancelled');
    const before = readFileSync(path);

    const result = upgradeMarketplaceExecutionV2(
      path,
      DIGEST,
      () => new Date('2026-07-27T12:03:00.000Z'),
    );

    expect(result.execution).toMatchObject({
      backend: 'marketplace',
      state: { schemaVersion: 'marketplace-execution-v2', status: 'cancelled' },
    });
    expect(readFileSync(path)).toEqual(before);
  });

  // This catches migration against a stale request identity.
  it('rejects v2 upgrade when the immutable request digest changed', () => {
    const { path } = fixture('submitted');
    const before = readFileSync(path);

    expect(() => upgradeMarketplaceExecutionV2(
      path,
      `sha256:${'0'.repeat(64)}`,
      () => new Date('2026-07-27T12:03:00.000Z'),
    )).toThrow(/request digest changed/i);
    expect(readFileSync(path)).toEqual(before);
  });

  // This catches two processes validating the same submitted snapshot and last-writer-wins.
  it('allows only one of two concurrent Solution delivery identities to become durable', async () => {
    const { path, attemptDir } = fixture('submitted');
    const readyA = join(attemptDir, 'worker-a.ready');
    const readyB = join(attemptDir, 'worker-b.ready');
    const release = join(attemptDir, 'workers.release');
    const firstDelivery = delivery(attemptDir);
    const secondDelivery = delivery(attemptDir, {
      deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4differentenvelopecid',
      deliveryEnvelopeDigest: `sha256:${'0'.repeat(64)}`,
      deliveryTransaction: `0x${'4'.repeat(64)}`,
      deliveryBlock: 503,
      correlation: {
        ...firstDelivery.correlation,
        deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4differentenvelopecid',
      },
    });
    const common = {
      operation: 'observe',
      manifestPath: path,
      requestDigest: DIGEST,
      timestamp: '2026-07-27T12:03:00.000Z',
      releasePath: release,
    } as const;

    const workerA = runAdoptionWorker({
      ...common,
      delivery: firstDelivery,
      readyPath: readyA,
    });
    const workerB = runAdoptionWorker({
      ...common,
      delivery: secondDelivery,
      readyPath: readyB,
    });
    await waitForFiles(readyA, readyB);
    writeFileSync(release, 'release\n', { mode: 0o600 });
    const results = await Promise.all([workerA, workerB]);

    expect(results.every(({ code }) => code === 0)).toBe(true);
    expect(results.filter(({ result }) => result.ok)).toHaveLength(1);
    expect(results.find(({ result }) => !result.ok)?.result.error)
      .toMatch(/marketplace execution state changed|transition already in progress/i);
    const current = readAttemptManifest(path);
    expect(current.execution).toMatchObject({
      backend: 'marketplace',
      state: { schemaVersion: 'marketplace-execution-v3', status: 'solution-observed' },
    });
    if (
      current.execution.backend !== 'marketplace'
      || current.execution.state.schemaVersion !== 'marketplace-execution-v3'
      || current.execution.state.status !== 'solution-observed'
    ) {
      throw new Error('expected one durable observed Solution');
    }
    expect([
      firstDelivery.deliveryEnvelopeCid,
      secondDelivery.deliveryEnvelopeCid,
    ]).toContain(current.execution.state.delivery.deliveryEnvelopeCid);
  });

  // This catches a paused v2 migration overwriting later observed v3 evidence.
  it('rejects a stale v2 upgrade after adoption advanced the same manifest', async () => {
    const { path, attemptDir } = fixture('submitted');
    const ready = join(attemptDir, 'upgrade.ready');
    const release = join(attemptDir, 'upgrade.release');
    const upgrade = runAdoptionWorker({
      operation: 'upgrade',
      manifestPath: path,
      requestDigest: DIGEST,
      timestamp: '2026-07-27T12:04:00.000Z',
      readyPath: ready,
      releasePath: release,
    });
    await waitForFiles(ready);

    transitionMarketplaceAdoption(
      path,
      DIGEST,
      { status: 'solution-observed', delivery: delivery(attemptDir) },
      () => new Date('2026-07-27T12:03:00.000Z'),
    );
    const observedBytes = readFileSync(path);
    writeFileSync(release, 'release\n', { mode: 0o600 });
    const stale = await upgrade;

    expect(stale.code).toBe(0);
    expect(stale.result).toMatchObject({ ok: false });
    expect(stale.result.error).toMatch(/marketplace execution state changed/i);
    expect(readFileSync(path)).toEqual(observedBytes);
    expect(readAttemptManifest(path).execution).toMatchObject({
      backend: 'marketplace',
      state: { schemaVersion: 'marketplace-execution-v3', status: 'solution-observed' },
    });
  });

  // This catches adoption replay that rewrites timestamps or accepts a second delivery identity.
  it('persists one Solution delivery idempotently and rejects a contradictory replay', () => {
    const { path, attemptDir } = fixture('submitted');
    const first = transitionMarketplaceAdoption(
      path,
      DIGEST,
      { status: 'solution-observed', delivery: delivery(attemptDir) },
      () => new Date('2026-07-27T12:03:00.000Z'),
    );
    const firstBytes = readFileSync(path);

    expect(transitionMarketplaceAdoption(
      path,
      DIGEST,
      { status: 'solution-observed', delivery: delivery(attemptDir) },
      () => new Date('2026-07-27T12:04:00.000Z'),
    )).toEqual(first);
    expect(readFileSync(path)).toEqual(firstBytes);
    expect(() => transitionMarketplaceAdoption(
      path,
      DIGEST,
      {
        status: 'solution-observed',
        delivery: delivery(attemptDir, { deliveryBlock: 503 }),
      },
      () => new Date('2026-07-27T12:04:00.000Z'),
    )).toThrow(/contradicts|different marketplace Solution delivery/i);
    expect(readFileSync(path)).toEqual(firstBytes);
  });

  // This catches replay equality that checks verification but silently ignores changed artifact facts.
  it('rejects a verification replay with contradictory artifact evidence', () => {
    const { path, attemptDir } = fixture('submitted');
    transitionMarketplaceAdoption(
      path,
      DIGEST,
      { status: 'solution-observed', delivery: delivery(attemptDir) },
      () => new Date('2026-07-27T12:03:00.000Z'),
    );
    transitionMarketplaceAdoption(
      path,
      DIGEST,
      {
        status: 'solution-verified',
        artifact: ARTIFACT,
        verification: VERIFICATION,
      },
      () => new Date('2026-07-27T12:04:00.000Z'),
    );
    const verifiedBytes = readFileSync(path);

    expect(() => transitionMarketplaceAdoption(
      path,
      DIGEST,
      {
        status: 'solution-verified',
        artifact: { ...ARTIFACT, byteLength: 13 },
        verification: VERIFICATION,
      },
      () => new Date('2026-07-27T12:05:00.000Z'),
    )).toThrow(/contradicts prior durable state/i);
    expect(readFileSync(path)).toEqual(verifiedBytes);
  });

  // This catches milestone skipping and stale clocks before either can rewrite durable state.
  it('rejects out-of-order and stale adoption transitions without rewriting the manifest', () => {
    const { path, attemptDir } = fixture('submitted');
    const submittedBytes = readFileSync(path);

    expect(() => transitionMarketplaceAdoption(
      path,
      DIGEST,
      {
        status: 'solution-verified',
        artifact: ARTIFACT,
        verification: VERIFICATION,
      },
      () => new Date('2026-07-27T12:03:00.000Z'),
    )).toThrow(/contradicts prior durable state/i);
    expect(readFileSync(path)).toEqual(submittedBytes);

    transitionMarketplaceAdoption(
      path,
      DIGEST,
      { status: 'solution-observed', delivery: delivery(attemptDir) },
      () => new Date('2026-07-27T12:03:00.000Z'),
    );
    const observedBytes = readFileSync(path);
    expect(() => transitionMarketplaceAdoption(
      path,
      DIGEST,
      {
        status: 'solution-verified',
        artifact: ARTIFACT,
        verification: VERIFICATION,
      },
      () => new Date('2026-07-27T12:02:00.000Z'),
    )).toThrow(/timestamp.*predates.*manifest/i);
    expect(readFileSync(path)).toEqual(observedBytes);
  });

  // This catches evaluator installation whose milestone predates the manifest's durable clock.
  it('rejects a stale evaluator install without rewriting the manifest', () => {
    const { path, attemptDir } = fixture('prepared', {
      attemptId: REVIEW_ATTEMPT_ID,
      phase: 'review',
      updatedAt: '2026-07-27T12:04:00.000Z',
    });
    const before = readFileSync(path);

    expect(() => installMarketplaceEvaluatorLeg(
      path,
      evaluatorIdentity(attemptDir),
      () => new Date('2026-07-27T12:03:00.000Z'),
    )).toThrow(/timestamp.*predates.*manifest/i);
    expect(readFileSync(path)).toEqual(before);
  });

  // This catches manifests whose outer durable clock does not cover their latest strict state.
  it.each(['adoption', 'evaluator'] as const)(
    'rejects a %s milestone newer than the manifest update timestamp',
    (kind) => {
      const fixtureValue = fixture(
        kind === 'adoption' ? 'submitted' : 'prepared',
        kind === 'evaluator'
          ? { attemptId: REVIEW_ATTEMPT_ID, phase: 'review' }
          : {},
      );
      if (kind === 'adoption') {
        transitionMarketplaceAdoption(
          fixtureValue.path,
          DIGEST,
          {
            status: 'solution-observed',
            delivery: delivery(fixtureValue.attemptDir),
          },
          () => new Date('2026-07-27T12:03:00.000Z'),
        );
      } else {
        installMarketplaceEvaluatorLeg(
          fixtureValue.path,
          evaluatorIdentity(fixtureValue.attemptDir),
          () => new Date('2026-07-27T12:03:00.000Z'),
        );
      }
      const raw = JSON.parse(readFileSync(fixtureValue.path, 'utf8')) as {
        timestamps: { updatedAt: string };
      };
      raw.timestamps.updatedAt = SUBMITTED_AT;

      expect(() => decodeAttemptManifest(raw)).toThrow(
        /marketplace.*timestamp.*manifest updated/i,
      );
    },
  );

  // This catches receipt persistence that flattens or loses the completed adoption chain.
  it('persists the full accepted adoption chain and replays the receipt byte-for-byte', () => {
    const { path, attemptDir } = fixture('submitted');
    transitionMarketplaceAdoption(
      path,
      DIGEST,
      { status: 'solution-observed', delivery: delivery(attemptDir) },
      () => new Date('2026-07-27T12:03:00.000Z'),
    );
    transitionMarketplaceAdoption(
      path,
      DIGEST,
      {
        status: 'solution-verified',
        artifact: ARTIFACT,
        verification: VERIFICATION,
      },
      () => new Date('2026-07-27T12:04:00.000Z'),
    );
    transitionMarketplaceAdoption(
      path,
      DIGEST,
      { status: 'host-committed', hostCommit: HOST_COMMIT },
      () => new Date('2026-07-27T12:05:00.000Z'),
    );
    transitionMarketplaceAdoption(
      path,
      DIGEST,
      { status: 'lifecycle-completed', completion: COMPLETION },
      () => new Date('2026-07-27T12:06:00.000Z'),
    );
    transitionMarketplaceAdoption(
      path,
      DIGEST,
      { status: 'review-anchored', reviewAnchor: reviewAnchor(attemptDir) },
      () => new Date('2026-07-27T12:07:00.000Z'),
    );
    const transition = {
      status: 'receipt-published' as const,
      receipt: {
        receipt: acceptedReceipt(),
        commentId: 501,
        author: 'jinn-autopilot',
        recordedAt: '2026-07-27T12:08:00.000Z',
      },
    };
    const published = transitionMarketplaceAdoption(
      path,
      DIGEST,
      transition,
      () => new Date('2026-07-27T12:08:00.000Z'),
    );
    const publishedBytes = readFileSync(path);

    expect(published.execution).toMatchObject({
      backend: 'marketplace',
      state: {
        status: 'receipt-published',
        progress: {
          status: 'review-anchored',
          completion: COMPLETION,
          reviewAnchor: reviewAnchor(attemptDir),
        },
        receipt: transition.receipt,
      },
    });
    expect(published.timestamps.updatedAt).toBe('2026-07-27T12:08:00.000Z');
    expect(transitionMarketplaceAdoption(
      path,
      DIGEST,
      transition,
      () => new Date('2026-07-27T12:09:00.000Z'),
    )).toEqual(published);
    expect(readFileSync(path)).toEqual(publishedBytes);
  });

  // This catches a receipt transition that incorrectly requires success-only review evidence.
  it('persists a correlated rejected receipt from observed progress', () => {
    const { path, attemptDir } = fixture('submitted');
    transitionMarketplaceAdoption(
      path,
      DIGEST,
      { status: 'solution-observed', delivery: delivery(attemptDir) },
      () => new Date('2026-07-27T12:03:00.000Z'),
    );
    const rejected = {
      schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
      disposition: 'rejected',
      role: 'solution',
      reason: 'invalid-artifact',
      detail: 'Patch policy rejected the artifact.',
      taskId: SUBMISSION.taskId,
      attemptIndex: 0,
      requestId: DELIVERY_REQUEST_ID,
      deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid',
      v2AttemptId: ATTEMPT_ID,
      prNumber: 84,
      claimOid: OID,
      expectedHead: OID,
      recordedAt: '2026-07-27T12:04:00.000Z',
    } as const;

    const published = transitionMarketplaceAdoption(
      path,
      DIGEST,
      {
        status: 'receipt-published',
        receipt: {
          receipt: rejected,
          commentId: 502,
          author: 'jinn-autopilot',
          recordedAt: '2026-07-27T12:04:00.000Z',
        },
      },
      () => new Date('2026-07-27T12:04:00.000Z'),
    );

    expect(published.execution).toMatchObject({
      backend: 'marketplace',
      state: {
        status: 'receipt-published',
        progress: { status: 'solution-observed' },
        receipt: { receipt: { disposition: 'rejected' } },
      },
    });
  });

  // This catches evaluator persistence that changes immutable origin linkage or rewrites a replay.
  it('installs and releases one evaluator leg with byte-identical replays', () => {
    const { path, attemptDir } = fixture('prepared', {
      attemptId: REVIEW_ATTEMPT_ID,
      phase: 'review',
    });
    const identity = evaluatorIdentity(attemptDir);
    const anchored = installMarketplaceEvaluatorLeg(
      path,
      identity,
      () => new Date('2026-07-27T12:03:00.000Z'),
    );
    const anchoredBytes = readFileSync(path);

    expect(installMarketplaceEvaluatorLeg(
      path,
      identity,
      () => new Date('2026-07-27T12:04:00.000Z'),
    )).toEqual(anchored);
    expect(readFileSync(path)).toEqual(anchoredBytes);
    expect(() => installMarketplaceEvaluatorLeg(
      path,
      { ...identity, originRequestDigest: `sha256:${'9'.repeat(64)}` },
      () => new Date('2026-07-27T12:04:00.000Z'),
    )).toThrow(/identity changed/i);

    const released = transitionMarketplaceEvaluatorLeg(
      path,
      identity,
      { status: 'released', releaseReason: 'receipt-published' },
      () => new Date('2026-07-27T12:05:00.000Z'),
    );
    const releasedBytes = readFileSync(path);
    expect(transitionMarketplaceEvaluatorLeg(
      path,
      identity,
      { status: 'released', releaseReason: 'receipt-published' },
      () => new Date('2026-07-27T12:06:00.000Z'),
    )).toEqual(released);
    expect(readFileSync(path)).toEqual(releasedBytes);
    expect(installMarketplaceEvaluatorLeg(
      path,
      identity,
      () => new Date('2026-07-27T12:06:00.000Z'),
    )).toEqual(released);
    expect(readFileSync(path)).toEqual(releasedBytes);
    expect(() => transitionMarketplaceEvaluatorLeg(
      path,
      identity,
      { status: 'released', releaseReason: 'different-reason' },
    )).toThrow(/contradicts durable state/i);
  });

  // This catches accidental expansion of evaluator legs into a second Task state machine.
  it.each(['submitted', 'cancelled'] as const)(
    'forbids evaluator %s transitions',
    (status) => {
      const { path, attemptDir } = fixture('prepared', {
        attemptId: REVIEW_ATTEMPT_ID,
        phase: 'review',
      });
      const identity = evaluatorIdentity(attemptDir);
      installMarketplaceEvaluatorLeg(
        path,
        identity,
        () => new Date('2026-07-27T12:03:00.000Z'),
      );
      const before = readFileSync(path);

      expect(() => transitionMarketplaceEvaluatorLeg(
        path,
        identity,
        { status } as never,
      )).toThrow(/invalid marketplace evaluator leg transition/i);
      expect(readFileSync(path)).toEqual(before);
    },
  );

  // This catches a generic writer bypass around either strict marketplace state machine.
  it.each(['v3', 'evaluator'] as const)(
    'prohibits the generic manifest writer for %s state',
    (kind) => {
      const fixtureValue = fixture('prepared', kind === 'evaluator'
        ? { attemptId: REVIEW_ATTEMPT_ID, phase: 'review' }
        : {});
      if (kind === 'v3') {
        upgradeMarketplaceExecutionV2(
          fixtureValue.path,
          DIGEST,
          () => new Date('2026-07-27T12:03:00.000Z'),
        );
      } else {
        installMarketplaceEvaluatorLeg(
          fixtureValue.path,
          evaluatorIdentity(fixtureValue.attemptDir),
          () => new Date('2026-07-27T12:03:00.000Z'),
        );
      }
      const before = readFileSync(fixtureValue.path);

      expect(() => updateAttemptManifest(
        fixtureValue.path,
        (current) => current,
      )).toThrow(/dedicated marketplace transition APIs/i);
      expect(readFileSync(fixtureValue.path)).toEqual(before);
      expect(readAttemptManifest(fixtureValue.path)).toBeDefined();
    },
  );
});
