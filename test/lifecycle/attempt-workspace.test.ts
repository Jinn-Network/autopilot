// @ts-nocheck — Stage 5: deleted merge-prep/review-fix/project-status fixtures.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultRunner, type CommandRunner } from '../../src/dispatcher/issue-source.js';
import { SelectedCredential } from '../../src/lifecycle/credentials.js';
import {
  advanceAttemptExpectedHead,
  advanceAttemptReviewPair,
  claimMarketplaceAttemptProcess,
  cleanupAttempt,
  countRunnerLiveAttempts,
  createAttemptWorkspace,
  decodeAttemptManifest,
  DEFAULT_ATTEMPT_SWEEP_BUDGET_MS,
  defaultRunnerId,
  drainTrashReclaims,
  failedTrashReclaims,
  freeDiskBytes,
  listRunnerLiveAttempts,
  markAttemptExited,
  markAttemptRunning,
  pendingTrashReclaims,
  readAttemptManifest,
  recoverMarketplaceAttemptInitializations,
  sweepDeadAttempts,
  trackAttemptChild,
  transitionMarketplaceExecution,
  updateAttemptManifest,
  type AttemptManifest,
  type CreateAttemptOptions,
} from '../../src/lifecycle/attempt-workspace.js';
import {
  buildMarketplaceTaskRequest,
  persistMarketplaceTaskRequest,
  verifyMarketplaceTaskRequest,
} from '../../src/lifecycle/marketplace-task.js';
import {
  installMarketplaceEvaluatorLeg,
  transitionMarketplaceAdoption,
  transitionMarketplaceEvaluatorLeg,
} from '../../src/lifecycle/marketplace-adoption-state.js';

// This file is deliberately subprocess-heavy: almost every test builds one or more real
// `git` repository fixtures and drives `createAttemptWorkspace` against them, so a single
// test routinely spawns dozens of real `git` processes. Vitest's 5000 ms default leaves
// too little headroom for that on a loaded runner — this file is *reported* to have timed
// out twice on `macos-latest`. That report is inherited rather than first-hand: those runs
// have since aged out of GitHub's log retention, so the failures cannot be re-read here.
//
// The number below is derived from measurement wherever measurement was still possible:
//   - Local worst case (measured here, post-fix), unloaded dev Mac, 3 runs, slowest test in
//     the file ('retains authentication failure, missing objects, malformed manifests, and
//     escaped paths'): 1474 / 1388 / 1466 ms.
//   - Inferred CI slowdown floor: the test named in that timeout report measured here
//     *before this PR's fixture fix* at 1893 / 1891 / 1812 ms — post-fix it measures
//     1281 / 1259 ms here, which is why the bullet above names a different test as the
//     file's slowest. Taking the report at face value — it is the one input below
//     resting on the expired logs rather than on a local measurement — puts that runner at
//     no better than 5000 / 1893 = 2.6x slower than this pre-fix baseline.
//   - Extrapolated CI worst case: 1474 ms x 2.6 = ~3.9 s, i.e. only ~1.3x under the
//     default — the next timeout would be a matter of runner variance, not of any one
//     test. 15000 ms restores a ~3.8x margin over that extrapolated CI worst case
//     (~10x over local) while still failing fast on a genuine hang.
//
// Scoped to this file on purpose. Raising `testTimeout` in vitest.config.ts would hide
// slowness across the entire suite; this file's cost is a known, intended property of it.
vi.setConfig({ testTimeout: 15_000 });

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const NOW = '2026-07-20T00:00:00.000Z';
const MARKETPLACE_TERMINAL_RECORD_SUFFIX = '.marketplace-terminal.json';
const SUBMISSION_RESULT = {
  schemaVersion: 1,
  generatedAt: '2026-07-20T00:01:30.000Z',
  verb: 'tasks submit',
  id: `autopilot:${UUID_A}`,
  creatorMultisig: `0x${'a'.repeat(40)}`,
  taskId: 'task-42',
  taskCid: 'bafybeigdyrzt5m6u2r3o4exampletaskcid',
  creationTx: `0x${'b'.repeat(64)}`,
  creationBlock: 123,
  solverNetManifestCid: 'bafybeigdyrzt5m6u2r3o4examplesolvercid',
  status: 'submitted',
  idempotent: false,
} as const;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function repositoryFixture(): {
  root: string;
  repo: string;
  remote: string;
  base: string;
  oid: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'jinn-attempt-test-'));
  roots.push(root);
  const remote = join(root, 'remote.git');
  const repo = join(root, 'repo');
  const base = join(root, 'worktrees');
  execFileSync('git', ['init', '--bare', remote]);
  execFileSync('git', ['init', repo]);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'base']);
  git(repo, ['branch', '-M', 'main']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-u', 'origin', 'main']);
  return { root, repo, remote, base, oid: git(repo, ['rev-parse', 'HEAD']) };
}

function sparseCloneFixture(
  fixture: ReturnType<typeof repositoryFixture>,
): { repo: string; head: string; branch: string } {
  writeFileSync(join(fixture.repo, 'feature.md'), 'feature\n');
  git(fixture.repo, ['checkout', '-b', 'feature']);
  git(fixture.repo, ['add', 'feature.md']);
  git(fixture.repo, ['commit', '-m', 'feature']);
  git(fixture.repo, ['push', '-u', 'origin', 'feature']);
  const head = git(fixture.repo, ['rev-parse', 'HEAD']);
  const sparseRepo = join(fixture.root, 'sparse');
  execFileSync('git', [
    'clone',
    '--single-branch',
    '--branch', 'main',
    fixture.remote,
    sparseRepo,
  ]);
  return { repo: sparseRepo, head, branch: 'feature' };
}

function options(
  fixture: ReturnType<typeof repositoryFixture>,
  overrides: Partial<CreateAttemptOptions> = {},
): CreateAttemptOptions {
  return {
    repositoryPath: fixture.repo,
    worktreeBase: fixture.base,
    runnerId: 'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    phase: 'implement',
    subject: 'issue-42',
    issueNumber: 42,
    branch: 'main',
    targetBase: 'main',
    expectedHead: fixture.oid,
    claimOid: fixture.oid,
    selectedLogin: 'impl-bot',
    credential: new SelectedCredential('impl-bot', 'implementation', 'selected-secret'),
    attemptId: UUID_A,
    now: () => new Date(NOW),
    ...overrides,
  };
}

function marketplacePreparation(
  fixture: ReturnType<typeof repositoryFixture>,
  workflow: 'implementation' | 'review-finding' | 'reconcile' | 'ci-failure' =
    'implementation',
  body = 'The authoritative issue body.',
) {
  const built = buildMarketplaceTaskRequest({
    workflow,
    repository: 'Jinn-Network/mono',
    language: 'typescript',
    verificationProfile: 'jinn-mono.v1',
    issueNumber: 42,
    ...(workflow === 'implementation'
      ? {}
      : { childIssueNumber: 42, parentPrNumber: 84 }),
    prNumber: 84,
    targetBase: 'main',
    branch: 'autopilot/42',
    claimOid: fixture.oid,
    expectedHead: fixture.oid,
    v2AttemptId: UUID_A,
    runnerId: 'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    taskSnapshot: {
      title: 'Publish one durable marketplace task',
      body,
      prBody: 'Closes #42',
      baseSha: fixture.oid,
      targetBaseOid: fixture.oid,
    },
    receiptAuthors: ['impl-bot'],
    createdAt: Date.parse(NOW),
  });
  return {
    workflow,
    baseSha: fixture.oid,
    request: built.request,
    agentSoftDeadline: built.agentSoftDeadline,
    adoptionDeadline: built.adoptionDeadline,
  };
}

function marketplaceInitializationJournal(
  fixture: ReturnType<typeof repositoryFixture>,
): string {
  const phaseDir = join(
    fixture.base,
    'v2',
    'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'implement',
  );
  const journals = existsSync(phaseDir)
    ? readdirSync(phaseDir)
      .filter((name) => name.endsWith('.marketplace-initialization.json'))
    : [];
  expect(journals).toHaveLength(1);
  return join(phaseDir, journals[0]!);
}

async function createSubmittedMarketplaceAttempt(
  fixture: ReturnType<typeof repositoryFixture>,
): Promise<AttemptManifest> {
  const prepared = await createAttemptWorkspace(options(fixture, {
    prNumber: 84,
    branch: 'autopilot/42',
    targetBaseOid: fixture.oid,
    marketplacePreparation: marketplacePreparation(fixture),
  }), defaultRunner);
  if (
    prepared.execution.backend !== 'marketplace'
    || prepared.execution.state.schemaVersion !== 'marketplace-execution-v3'
  ) {
    throw new Error('expected a version-3 marketplace execution');
  }
  return transitionMarketplaceExecution(
    prepared.paths.manifest,
    prepared.execution.state.requestDigest,
    {
      status: 'submitted',
      submission: { ...SUBMISSION_RESULT, taskId: '501' },
    },
    () => new Date('2026-07-28T12:02:00.000Z'),
  );
}

async function createAnchoredMarketplaceEvaluatorLeg(
  fixture: ReturnType<typeof repositoryFixture>,
): Promise<{
  readonly manifest: AttemptManifest;
  readonly identity: Parameters<typeof installMarketplaceEvaluatorLeg>[1];
}> {
  const origin = await createSubmittedMarketplaceAttempt(fixture);
  if (
    origin.execution.backend !== 'marketplace'
    || !('submission' in origin.execution.state)
  ) {
    throw new Error('expected a submitted marketplace execution');
  }
  const requestDigest = origin.execution.state.requestDigest;
  const review = await createAttemptWorkspace(options(fixture, {
    attemptId: UUID_B,
    phase: 'review',
    subject: 'pr-84',
    prNumber: 84,
    branch: 'autopilot/42',
    reviewGeneration: UUID_C,
    reviewRefOid: fixture.oid,
    reviewApprovalPolicy: 'approve-eligible',
    selectedLogin: 'review-bot',
    credential: new SelectedCredential('review-bot', 'review', 'review-secret'),
    execution: {
      backend: 'marketplace',
      state: {
        schemaVersion: 'marketplace-execution-v2',
        status: 'prepared',
        requestPath: join(fixture.root, 'evaluator-request.json'),
        requestDigest,
        solverNetSelectionPath: join(fixture.root, 'evaluator-solvernet-selection.json'),
        preparedAt: '2026-07-28T12:02:00.000Z',
        agentSoftDeadline: '2026-07-28T13:02:00.000Z',
        adoptionDeadline: '2026-07-28T14:02:00.000Z',
      },
    },
    now: () => new Date('2026-07-28T12:02:00.000Z'),
  }), defaultRunner);
  const identity = {
    originManifestPath: origin.paths.manifest,
    originV2AttemptId: origin.attemptId,
    originRequestDigest: requestDigest,
    taskId: '501',
    taskCid: origin.execution.state.submission.taskCid,
    taskCreationBlock: origin.execution.state.submission.creationBlock,
    prNumber: 84,
    expectedHead: fixture.oid,
    generation: UUID_C,
    reviewRefOid: fixture.oid,
    reviewer: 'review-bot',
  };
  return {
    manifest: installMarketplaceEvaluatorLeg(
      review.paths.manifest,
      identity,
      () => new Date('2026-07-28T12:03:00.000Z'),
    ),
    identity,
  };
}

function marketplaceInitializationJournalPathForTest(
  fixture: ReturnType<typeof repositoryFixture>,
): string {
  return join(
    fixture.base,
    'v2',
    'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'implement',
    `.issue-42-${UUID_A}.marketplace-initialization.json`,
  );
}

function terminalAttempt(manifest: AttemptManifest): AttemptManifest {
  markAttemptRunning(manifest.paths.manifest, 4242, () =>
    new Date('2026-07-20T00:01:00.000Z'));
  return markAttemptExited(
    manifest.paths.manifest,
    () => new Date('2026-07-20T00:02:00.000Z'),
    manifest.expectedHead,
  );
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise!: () => void;
  return {
    promise: new Promise<void>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve: () => resolvePromise(),
  };
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timed out waiting for initialization barrier'));
    }, 1_000);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function transitionInWorker(input: Record<string, unknown>): Promise<{
  readonly code: number | null;
  readonly result: { readonly ok: boolean; readonly error?: string };
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
      join(process.cwd(), 'test/lifecycle/attempt-transition-worker.ts'),
      JSON.stringify(input),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolve({ code, result: JSON.parse(stdout) as { readonly ok: boolean; readonly error?: string } });
      } catch {
        reject(new Error(`Marketplace transition worker did not return JSON: ${stderr}`));
      }
    });
  });
}

describe('attempt workspace and manifest', () => {
  it('claims a submitted preparing marketplace attempt without changing execution evidence', async () => {
    const fixture = repositoryFixture();
    const manifest = await createSubmittedMarketplaceAttempt(fixture);
    const executionBefore = structuredClone(manifest.execution);

    const claimed = claimMarketplaceAttemptProcess(manifest.paths.manifest, {
      pid: 700,
      isPidAlive: () => false,
      now: () => new Date('2026-07-28T12:03:00.000Z'),
    });

    expect(claimed).toMatchObject({
      processState: 'running',
      pid: 700,
      timestamps: {
        updatedAt: '2026-07-28T12:03:00.000Z',
        childStartedAt: '2026-07-28T12:03:00.000Z',
      },
    });
    expect(claimed.execution).toEqual(executionBefore);
  });

  it('replays a marketplace attempt claim by the same PID without rewriting bytes or timestamps', async () => {
    const fixture = repositoryFixture();
    const manifest = await createSubmittedMarketplaceAttempt(fixture);
    const first = claimMarketplaceAttemptProcess(manifest.paths.manifest, {
      pid: 700,
      now: () => new Date('2026-07-28T12:03:00.000Z'),
    });
    const before = readFileSync(manifest.paths.manifest);

    const replayed = claimMarketplaceAttemptProcess(manifest.paths.manifest, {
      pid: 700,
      now: () => new Date('2026-07-28T12:04:00.000Z'),
    });

    expect(replayed).toEqual(first);
    expect(readFileSync(manifest.paths.manifest)).toEqual(before);
  });

  it('refuses a marketplace attempt claim held by another live PID without rewriting bytes', async () => {
    const fixture = repositoryFixture();
    const manifest = await createSubmittedMarketplaceAttempt(fixture);
    claimMarketplaceAttemptProcess(manifest.paths.manifest, {
      pid: 701,
      now: () => new Date('2026-07-28T12:03:00.000Z'),
    });
    const before = readFileSync(manifest.paths.manifest);

    expect(() => claimMarketplaceAttemptProcess(manifest.paths.manifest, {
      pid: 700,
      isPidAlive: (pid) => pid === 701,
      now: () => new Date('2026-07-28T12:04:00.000Z'),
    })).toThrow(/held by a live PID/i);
    expect(readFileSync(manifest.paths.manifest)).toEqual(before);
  });

  it('serializes marketplace process claims with execution-state transitions', async () => {
    const fixture = repositoryFixture();
    const manifest = await createSubmittedMarketplaceAttempt(fixture);
    const before = readFileSync(manifest.paths.manifest);
    const lockPath = `${manifest.paths.manifest}.marketplace-state-transition.lock`;
    writeFileSync(lockPath, '{}\n', { mode: 0o600 });

    try {
      expect(() => claimMarketplaceAttemptProcess(manifest.paths.manifest, {
        pid: 700,
        isPidAlive: () => false,
        now: () => new Date('2026-07-28T12:03:00.000Z'),
      })).toThrow(/marketplace state transition already in progress/i);
      expect(readFileSync(manifest.paths.manifest)).toEqual(before);
    } finally {
      rmSync(lockPath);
    }
  });

  it('rebinds a marketplace attempt claim held by a dead PID without changing execution evidence', async () => {
    const fixture = repositoryFixture();
    const manifest = await createSubmittedMarketplaceAttempt(fixture);
    const executionBefore = structuredClone(manifest.execution);
    claimMarketplaceAttemptProcess(manifest.paths.manifest, {
      pid: 701,
      now: () => new Date('2026-07-28T12:03:00.000Z'),
    });

    const rebound = claimMarketplaceAttemptProcess(manifest.paths.manifest, {
      pid: 700,
      isPidAlive: () => false,
      now: () => new Date('2026-07-28T12:04:00.000Z'),
    });

    expect(rebound).toMatchObject({
      processState: 'running',
      pid: 700,
      timestamps: {
        updatedAt: '2026-07-28T12:04:00.000Z',
        childStartedAt: '2026-07-28T12:04:00.000Z',
      },
    });
    expect(rebound.execution).toEqual(executionBefore);
  });

  it('refuses exited and terminal marketplace attempts without rewriting bytes', async () => {
    const exitedFixture = repositoryFixture();
    const exited = await createSubmittedMarketplaceAttempt(exitedFixture);
    claimMarketplaceAttemptProcess(exited.paths.manifest, {
      pid: 701,
      now: () => new Date('2026-07-28T12:03:00.000Z'),
    });
    markAttemptExited(
      exited.paths.manifest,
      () => new Date('2026-07-28T12:04:00.000Z'),
    );
    const exitedBytes = readFileSync(exited.paths.manifest);
    expect(() => claimMarketplaceAttemptProcess(exited.paths.manifest, {
      pid: 700,
      isPidAlive: () => false,
      now: () => new Date('2026-07-28T12:05:00.000Z'),
    })).toThrow(/exited marketplace attempt/i);
    expect(readFileSync(exited.paths.manifest)).toEqual(exitedBytes);

    const cancelledFixture = repositoryFixture();
    const prepared = await createAttemptWorkspace(options(cancelledFixture, {
      prNumber: 84,
      branch: 'autopilot/42',
      targetBaseOid: cancelledFixture.oid,
      marketplacePreparation: marketplacePreparation(cancelledFixture),
    }), defaultRunner);
    if (
      prepared.execution.backend !== 'marketplace'
      || prepared.execution.state.schemaVersion !== 'marketplace-execution-v3'
    ) {
      throw new Error('expected a version-3 marketplace execution');
    }
    const cancelled = transitionMarketplaceExecution(
      prepared.paths.manifest,
      prepared.execution.state.requestDigest,
      { status: 'cancelled', reason: 'operator-cancelled' },
      () => new Date('2026-07-28T12:02:00.000Z'),
    );
    const cancelledBytes = readFileSync(cancelled.paths.manifest);
    expect(() => claimMarketplaceAttemptProcess(cancelled.paths.manifest, {
      pid: 700,
      now: () => new Date('2026-07-28T12:03:00.000Z'),
    })).toThrow(/terminal marketplace attempt/i);
    expect(readFileSync(cancelled.paths.manifest)).toEqual(cancelledBytes);

    const publishedFixture = repositoryFixture();
    const submitted = await createSubmittedMarketplaceAttempt(publishedFixture);
    if (
      submitted.execution.backend !== 'marketplace'
      || submitted.execution.state.schemaVersion !== 'marketplace-execution-v3'
      || submitted.execution.state.status !== 'submitted'
    ) {
      throw new Error('expected a submitted version-3 marketplace execution');
    }
    const state = submitted.execution.state;
    const delivery = {
      observationPath: join(submitted.paths.attemptDir, 'delivery.json'),
      observationDigest: `sha256:${'b'.repeat(64)}`,
      taskId: state.submission.taskId,
      taskCid: state.submission.taskCid,
      taskCreationTransaction: state.submission.creationTx,
      taskCreationBlock: state.submission.creationBlock,
      solverNetManifestCid: state.submission.solverNetManifestCid,
      attemptIndex: 0,
      requestId: `0x${'c'.repeat(64)}`,
      deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid',
      deliveryEnvelopeDigest: `sha256:${'d'.repeat(64)}`,
      deliveryTransaction: `0x${'e'.repeat(64)}`,
      deliveryBlock: state.submission.creationBlock + 1,
      solverSafe: `0x${'1'.repeat(40)}`,
      solverAgentEoa: `0x${'2'.repeat(40)}`,
      signer: `0x${'2'.repeat(40)}`,
      publisherAgentId: '501',
      correlation: {
        taskId: state.submission.taskId,
        attemptIndex: 0,
        requestId: `0x${'c'.repeat(64)}`,
        deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid',
        v2AttemptId: submitted.attemptId,
        claimOid: submitted.claimOid,
        prNumber: submitted.prNumber!,
        expectedHead: submitted.expectedHead,
      },
      observedAt: '2026-07-28T12:03:00.000Z',
    };
    transitionMarketplaceAdoption(
      submitted.paths.manifest,
      state.requestDigest,
      { status: 'solution-observed', delivery },
      () => new Date('2026-07-28T12:03:00.000Z'),
    );
    const receipt = {
      schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
      disposition: 'rejected',
      role: 'solution',
      reason: 'stale-claim',
      detail: 'The claim is stale.',
      ...delivery.correlation,
      recordedAt: '2026-07-28T12:04:00.000Z',
    } as const;
    const published = transitionMarketplaceAdoption(
      submitted.paths.manifest,
      state.requestDigest,
      {
        status: 'receipt-published',
        receipt: {
          receipt,
          commentId: 501,
          author: 'jinn-autopilot',
          recordedAt: receipt.recordedAt,
        },
      },
      () => new Date(receipt.recordedAt),
    );
    const publishedBytes = readFileSync(published.paths.manifest);
    expect(() => claimMarketplaceAttemptProcess(published.paths.manifest, {
      pid: 700,
      now: () => new Date('2026-07-28T12:05:00.000Z'),
    })).toThrow(/terminal marketplace attempt/i);
    expect(readFileSync(published.paths.manifest)).toEqual(publishedBytes);
  });

  it('refuses a marketplace attempt claim whose timestamp regresses without rewriting bytes', async () => {
    const fixture = repositoryFixture();
    const manifest = await createSubmittedMarketplaceAttempt(fixture);
    claimMarketplaceAttemptProcess(manifest.paths.manifest, {
      pid: 701,
      now: () => new Date('2026-07-28T12:03:00.000Z'),
    });
    const before = readFileSync(manifest.paths.manifest);

    expect(() => claimMarketplaceAttemptProcess(manifest.paths.manifest, {
      pid: 700,
      isPidAlive: () => false,
      now: () => new Date('2026-07-28T12:02:00.000Z'),
    })).toThrow(/predates the manifest update/i);
    expect(readFileSync(manifest.paths.manifest)).toEqual(before);
  });

  it('claims an anchored evaluator leg and refuses its released terminal state', async () => {
    const fixture = repositoryFixture();
    const { manifest, identity } = await createAnchoredMarketplaceEvaluatorLeg(fixture);
    const executionBefore = structuredClone(manifest.execution);

    const claimed = claimMarketplaceAttemptProcess(manifest.paths.manifest, {
      pid: 700,
      now: () => new Date('2026-07-28T12:04:00.000Z'),
    });

    expect(claimed).toMatchObject({
      processState: 'running',
      pid: 700,
      timestamps: {
        updatedAt: '2026-07-28T12:04:00.000Z',
        childStartedAt: '2026-07-28T12:04:00.000Z',
      },
    });
    expect(claimed.execution).toEqual(executionBefore);

    transitionMarketplaceEvaluatorLeg(
      manifest.paths.manifest,
      identity,
      { status: 'released', releaseReason: 'receipt-published' },
      () => new Date('2026-07-28T12:05:00.000Z'),
    );
    const releasedBytes = readFileSync(manifest.paths.manifest);
    expect(() => claimMarketplaceAttemptProcess(manifest.paths.manifest, {
      pid: 700,
      now: () => new Date('2026-07-28T12:06:00.000Z'),
    })).toThrow(/terminal marketplace evaluator leg/i);
    expect(readFileSync(manifest.paths.manifest)).toEqual(releasedBytes);
  });

  it('gives two processes unique detached attempts in one Git common directory', async () => {
    const fixture = repositoryFixture();
    const [one, two] = await Promise.all([
      createAttemptWorkspace(options(fixture), defaultRunner),
      createAttemptWorkspace(options(fixture, {
        runnerId: 'host-101-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        attemptId: UUID_B,
      }), defaultRunner),
    ]);

    expect(one.paths.worktree).toBe(join(
      fixture.base,
      'v2',
      one.runnerId,
      'implement',
      `issue-42-${UUID_A}`,
      'worktree',
    ));
    expect(two.paths.worktree).not.toBe(one.paths.worktree);
    expect(git(one.paths.worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    expect(git(two.paths.worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    expect(git(one.paths.worktree, ['rev-parse', 'HEAD'])).toBe(fixture.oid);
    expect(git(two.paths.worktree, ['rev-parse', 'HEAD'])).toBe(fixture.oid);
    expect(readFileSync(one.paths.askpass, 'utf8')).not.toContain('selected-secret');
    expect(readdirSync(one.paths.ghConfigDir)).toEqual(['hosts.yml']);
  });

  it('fetches a missing expected head before creating the detached worktree', async () => {
    const fixture = repositoryFixture();
    const sparse = sparseCloneFixture(fixture);
    const manifest = await createAttemptWorkspace(options(fixture, {
      repositoryPath: sparse.repo,
      branch: sparse.branch,
      expectedHead: sparse.head,
      claimOid: sparse.head,
      prNumber: 2075,
    }), defaultRunner);

    expect(git(manifest.paths.worktree, ['rev-parse', 'HEAD'])).toBe(sparse.head);
  });

  it('fails closed when the expected head is still missing after fetch', async () => {
    const fixture = repositoryFixture();
    const missingHead = '4dcd7a7f9d3f92e1eb13c77a6af2f522f6969b17';

    await expect(createAttemptWorkspace(options(fixture, {
      branch: 'missing-branch',
      expectedHead: missingHead,
      claimOid: missingHead,
      prNumber: 2075,
    }), defaultRunner)).rejects.toThrow(/not available after fetching/i);
    expect(existsSync(join(fixture.base, 'v2'))).toBe(false);
  });

  it('writes the runtime-independent gh-config hosts.yml and token file at creation, and points the askpass helper at the file instead of $GH_TOKEN (#1883)', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture, {
      selectedLogin: 'impl-bot',
      credential: new SelectedCredential('impl-bot', 'implementation', 'the-raw-token'),
    }), defaultRunner);

    // Token file: sibling to the manifest, 0o600, holds exactly the raw token.
    expect(manifest.paths.tokenFile).toBe(join(manifest.paths.attemptDir, 'gh-token'));
    expect(readFileSync(manifest.paths.tokenFile, 'utf8').trim()).toBe('the-raw-token');
    expect(statSync(manifest.paths.tokenFile).mode & 0o777).toBe(0o600);

    // gh CLI's own hosts.yml: 0o600, in the (already 0o700) gh-config dir.
    const hostsYamlPath = join(manifest.paths.ghConfigDir, 'hosts.yml');
    const hostsYaml = readFileSync(hostsYamlPath, 'utf8');
    expect(hostsYaml).toBe(
      'github.com:\n    oauth_token: the-raw-token\n    user: impl-bot\n    git_protocol: https\n',
    );
    expect(statSync(hostsYamlPath).mode & 0o777).toBe(0o600);
    expect(statSync(manifest.paths.ghConfigDir).mode & 0o777).toBe(0o700);

    // Askpass no longer echoes an env var; it reads the token file by path.
    const askpass = readFileSync(manifest.paths.askpass, 'utf8');
    expect(askpass).not.toContain('GH_TOKEN');
    expect(askpass).not.toContain('the-raw-token');
    expect(askpass).toContain(`cat "${manifest.paths.tokenFile}"`);
  });

  it('binds the strict manifest to the canonical repository and remote identity', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture), defaultRunner);

    expect(manifest.repository).toEqual({
      root: realpathSync(fixture.repo),
      gitCommonDir: realpathSync(git(fixture.repo, [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ])),
      remoteName: 'origin',
      remoteUrlHash: createHash('sha256').update(fixture.remote).digest('hex'),
    });

    const raw = JSON.parse(readFileSync(manifest.paths.manifest, 'utf8')) as Record<string, unknown>;
    raw.repository = {
      ...(raw.repository as Record<string, unknown>),
      unexpected: true,
    };
    writeFileSync(manifest.paths.manifest, JSON.stringify(raw));
    expect(() => readAttemptManifest(manifest.paths.manifest)).toThrow(
      /Unknown field: unexpected/,
    );
  });

  it('validates the complete manifest before side effects and exactly rolls back Git add failure', async () => {
    const invalidFixture = repositoryFixture();
    await expect(createAttemptWorkspace(options(invalidFixture, {
      expectedHead: 'not-an-oid',
    }), defaultRunner)).rejects.toThrow(/OID/);
    expect(existsSync(invalidFixture.base)).toBe(false);

    const failureFixture = repositoryFixture();
    const attemptDir = join(
      failureFixture.base,
      'v2',
      'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'implement',
      `issue-42-${UUID_A}`,
    );
    const failingRunner: CommandRunner = async (cmd, args, opts) => {
      const result = await defaultRunner(cmd, args, opts);
      if (cmd === 'git' && args.includes('add') && args.includes('--detach')) {
        throw new Error('injected failure after worktree registration');
      }
      return result;
    };

    await expect(createAttemptWorkspace(
      options(failureFixture),
      failingRunner,
    )).rejects.toThrow(/injected failure/);
    expect(existsSync(attemptDir)).toBe(false);
    expect(git(failureFixture.repo, ['worktree', 'list', '--porcelain']))
      .not.toContain(join(attemptDir, 'worktree'));

    const collisionFixture = repositoryFixture();
    const collision = await createAttemptWorkspace(options(collisionFixture), defaultRunner);
    rmSync(collision.paths.attemptDir, { recursive: true });
    await expect(createAttemptWorkspace(
      options(collisionFixture),
      defaultRunner,
    )).rejects.toThrow(/already registered/);
    expect(git(collisionFixture.repo, ['worktree', 'list', '--porcelain']))
      .toContain(`issue-42-${UUID_A}/worktree`);
  });

  it('rejects review ref metadata without a generation before any side effect', async () => {
    const fixture = repositoryFixture();
    let commandCalls = 0;
    const observingRunner: CommandRunner = async (cmd, args, runnerOptions) => {
      commandCalls++;
      return defaultRunner(cmd, args, runnerOptions);
    };

    await expect(createAttemptWorkspace(options(fixture, {
      phase: 'review',
      subject: 'pr-7',
      prNumber: 7,
      reviewRefOid: fixture.oid,
    }), observingRunner)).rejects.toThrow(/generation.*ref OID|ref OID.*generation/i);
    expect(commandCalls).toBe(0);
    expect(existsSync(fixture.base)).toBe(false);
  });

  it('builds a collision-resistant filesystem-safe default runner id', () => {
    const id = defaultRunnerId({
      configured: undefined,
      hostname: 'Build Host.example',
      pid: 123,
      bootId: UUID_A,
    });
    expect(id).toBe(`build-host.example-123-${UUID_A}`);
    expect(() => defaultRunnerId({
      configured: 'runner/escaped',
      hostname: 'host',
      pid: 1,
      bootId: UUID_A,
    })).toThrow(/filesystem-safe/);
    expect(defaultRunnerId({
      environment: { JINN_AUTOPILOT_RUNNER_ID: 'configured-runner' },
      hostname: 'ignored',
      pid: 1,
      bootId: UUID_A,
    })).toBe('configured-runner');
  });

  it('strictly decodes manifests and atomically tracks preparing, running, and exited', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture), defaultRunner);

    expect(manifest.processState).toBe('preparing');
    expect(readAttemptManifest(manifest.paths.manifest)).toEqual(manifest);
    const raw = JSON.parse(readFileSync(manifest.paths.manifest, 'utf8')) as Record<string, unknown>;
    raw.token = 'must-not-be-accepted';
    writeFileSync(manifest.paths.manifest, JSON.stringify(raw));
    expect(() => readAttemptManifest(manifest.paths.manifest)).toThrow(/Unknown field: token/);
    delete raw.token;
    writeFileSync(manifest.paths.manifest, JSON.stringify(raw));

    const running = markAttemptRunning(manifest.paths.manifest, 4242, () =>
      new Date('2026-07-20T00:01:00.000Z'));
    expect(running).toMatchObject({ processState: 'running', pid: 4242 });

    const child = Object.assign(new EventEmitter(), { pid: 4242 });
    trackAttemptChild(manifest.paths.manifest, child, {
      alreadyRunning: true,
      now: () => new Date('2026-07-20T00:02:00.000Z'),
    });
    child.emit('exit', 0);
    const updated = readAttemptManifest(manifest.paths.manifest);
    expect(updated).toMatchObject({ processState: 'exited', pid: 4242 });
    expect(updated.timestamps.childExitedAt).toBe('2026-07-20T00:02:00.000Z');

    const second = await createAttemptWorkspace(options(fixture, {
      attemptId: UUID_B,
    }), defaultRunner);
    const alreadyExited = Object.assign(new EventEmitter(), { pid: 5252, exitCode: 0 });
    trackAttemptChild(second.paths.manifest, alreadyExited, {
      now: () => new Date('2026-07-20T00:03:00.000Z'),
      terminalHead: second.expectedHead,
    });
    expect(readAttemptManifest(second.paths.manifest).processState).toBe('exited');
    expect(readdirSync(manifest.paths.attemptDir).filter((name) => name.includes('.tmp-')))
      .toEqual([]);
    // The earlier injected garbage `token` field (rejected above) must not
    // have been silently re-accepted; the legitimate `paths.tokenFile` field
    // is expected here and is not what this assertion is guarding against.
    expect(JSON.stringify(updated)).not.toMatch(/must-not-be-accepted/i);
    expect(Object.keys(JSON.parse(JSON.stringify(updated)) as Record<string, unknown>))
      .not.toContain('token');
  });

  it('records an optional child kind on implementation manifests and nowhere else', async () => {
    const fixture = repositoryFixture();
    const uuid = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}`
      + `-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

    // A fresh implementation claim writes no `childKind` at all, and a manifest
    // that predates the field decodes unchanged: absent means fresh.
    const fresh = await createAttemptWorkspace(options(fixture), defaultRunner);
    expect(fresh.childKind).toBeUndefined();
    expect(Object.keys(
      JSON.parse(readFileSync(fresh.paths.manifest, 'utf8')) as Record<string, unknown>,
    )).not.toContain('childKind');
    expect(readAttemptManifest(fresh.paths.manifest)).toEqual(fresh);

    // All three machine-child kinds round-trip create -> disk -> strict decode.
    const kinds = ['review-finding', 'reconcile', 'ci-failure'] as const;
    for (const [index, childKind] of kinds.entries()) {
      const attempt = await createAttemptWorkspace(options(fixture, {
        attemptId: uuid(String(index + 4)),
        childKind,
      }), defaultRunner);
      expect(attempt.childKind).toBe(childKind);
      expect(readAttemptManifest(attempt.paths.manifest).childKind).toBe(childKind);
      expect((JSON.parse(
        readFileSync(attempt.paths.manifest, 'utf8'),
      ) as Record<string, unknown>).childKind).toBe(childKind);
      // The lane tag never leaks into the phase, subject, or on-disk layout.
      expect(attempt.phase).toBe('implement');
      expect(attempt.subject).toBe('issue-42');
      expect(attempt.paths.attemptDir).toContain(join('implement', 'issue-42-'));
    }

    // Unknown values are rejected outright.
    const raw = JSON.parse(
      readFileSync(fresh.paths.manifest, 'utf8'),
    ) as Record<string, unknown>;
    expect(() => decodeAttemptManifest({ ...raw, childKind: 'merge-prep' }))
      .toThrow(/child kind/i);
    expect(() => decodeAttemptManifest({ ...raw, childKind: 7 }))
      .toThrow(/child kind/i);

    // And a child kind on a review attempt is a contradiction, not a tag.
    const review = await createAttemptWorkspace(options(fixture, {
      attemptId: uuid('7'),
      phase: 'review',
      subject: 'pr-7',
      prNumber: 7,
      reviewGeneration: UUID_C,
      reviewRefOid: fixture.oid,
      reviewApprovalPolicy: 'approve-eligible',
    }), defaultRunner);
    const reviewRaw = JSON.parse(
      readFileSync(review.paths.manifest, 'utf8'),
    ) as Record<string, unknown>;
    expect(() => decodeAttemptManifest({ ...reviewRaw, childKind: 'reconcile' }))
      .toThrow(/child kind/i);
    await expect(createAttemptWorkspace(options(fixture, {
      attemptId: uuid('8'),
      phase: 'review',
      subject: 'pr-7',
      prNumber: 7,
      reviewGeneration: UUID_C,
      reviewRefOid: fixture.oid,
      reviewApprovalPolicy: 'approve-eligible',
      childKind: 'reconcile',
    }), defaultRunner)).rejects.toThrow(/child kind/i);
  });

  it('locks the child kind against atomic manifest updates', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture, {
      childKind: 'ci-failure',
    }), defaultRunner);

    expect(() => updateAttemptManifest(manifest.paths.manifest, (current) => ({
      ...current,
      childKind: 'reconcile',
    }))).toThrow(/static attempt fields/);
    expect(() => updateAttemptManifest(manifest.paths.manifest, (current) => {
      const { childKind: _childKind, ...withoutChildKind } = current;
      return withoutChildKind;
    })).toThrow(/static attempt fields/);
    expect(readAttemptManifest(manifest.paths.manifest).childKind).toBe('ci-failure');
    expect(markAttemptRunning(manifest.paths.manifest, 4242, () =>
      new Date('2026-07-20T00:01:00.000Z')).childKind).toBe('ci-failure');
  });

  it('normalizes absent execution metadata to the local backend and writes local executions', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture), defaultRunner);

    expect(manifest.execution).toEqual({ backend: 'local' });
    const raw = JSON.parse(readFileSync(manifest.paths.manifest, 'utf8')) as Record<string, unknown>;
    delete raw.execution;
    expect(decodeAttemptManifest(raw).execution).toEqual({ backend: 'local' });
  });

  it('round-trips an explicitly-created submitted marketplace execution', async () => {
    const fixture = repositoryFixture();
    const execution = {
      backend: 'marketplace',
      state: {
        schemaVersion: 'marketplace-execution-v1',
        status: 'submitted',
        requestPath: join(fixture.root, 'marketplace-request.json'),
        taskId: 'task-42',
        taskCid: 'bafybeigdyrzt5m6u2r3o4exampletaskcid',
        submittedAt: '2026-07-20T00:01:00.000Z',
      },
    } as const;

    const manifest = await createAttemptWorkspace(options(fixture, { execution }), defaultRunner);

    expect(manifest.execution).toEqual(execution);
    expect(readAttemptManifest(manifest.paths.manifest).execution).toEqual(execution);
  });

  it('round-trips a version-2 prepared marketplace execution with immutable request metadata', async () => {
    const fixture = repositoryFixture();
    const execution = {
      backend: 'marketplace',
      state: {
        schemaVersion: 'marketplace-execution-v2',
        status: 'prepared',
        requestPath: join(fixture.root, 'marketplace-request.json'),
        requestDigest: `sha256:${'a'.repeat(64)}`,
        solverNetSelectionPath: join(fixture.root, 'solvernet-selection.json'),
        preparedAt: '2026-07-20T00:01:00.000Z',
        agentSoftDeadline: '2026-07-20T01:00:00.000Z',
        adoptionDeadline: '2026-07-20T01:30:00.000Z',
      },
    } as const;

    const manifest = await createAttemptWorkspace(options(fixture, { execution }), defaultRunner);

    expect(manifest.execution).toEqual(execution);
    expect(readAttemptManifest(manifest.paths.manifest).execution).toEqual(execution);
  });

  it('durably writes and verifies the immutable request before installing its prepared manifest', async () => {
    const fixture = repositoryFixture();
    const events: string[] = [];
    const manifest = await createAttemptWorkspace(options(fixture, {
      prNumber: 84,
      branch: 'autopilot/42',
      targetBaseOid: fixture.oid,
      marketplacePreparation: marketplacePreparation(fixture),
    }), defaultRunner, {
      persistMarketplaceTaskRequest(requestPath, request) {
        events.push('persist-request');
        expect(existsSync(join(dirname(requestPath), 'manifest.json'))).toBe(false);
        return persistMarketplaceTaskRequest(requestPath, request);
      },
      verifyMarketplaceTaskRequest(requestPath, requestDigest) {
        events.push('verify-request');
        expect(existsSync(join(dirname(requestPath), 'manifest.json'))).toBe(false);
        return verifyMarketplaceTaskRequest(requestPath, requestDigest);
      },
      afterMarketplaceManifestInstalled(_path, prepared) {
        events.push('write-manifest');
        expect(verifyMarketplaceTaskRequest(
          prepared.execution.state.requestPath,
          prepared.execution.state.requestDigest,
        ).id).toBe(`autopilot:${UUID_A}`);
      },
    });

    expect(events).toEqual([
      'persist-request',
      'verify-request',
      'write-manifest',
    ]);
    expect(manifest).toMatchObject({
      targetBaseOid: fixture.oid,
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v3',
          status: 'prepared',
          requestPath: join(manifest.paths.attemptDir, 'marketplace-request.json'),
          preparedAt: NOW,
        },
      },
    });
    expect(statSync(manifest.execution.state.requestPath).mode & 0o777).toBe(0o600);
    expect(readAttemptManifest(manifest.paths.manifest)).toEqual(manifest);
  });

  it('installs a non-secret sibling journal before creating the marketplace attempt directory and recovers it', async () => {
    const fixture = repositoryFixture();
    const attemptDir = join(
      fixture.base,
      'v2',
      'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'implement',
      `issue-42-${UUID_A}`,
    );
    const credential =
      new SelectedCredential('Impl-Bot', 'implementation', 'selected-secret');

    await expect(createAttemptWorkspace(options(fixture, {
      prNumber: 84,
      branch: 'autopilot/42',
      targetBaseOid: fixture.oid,
      selectedLogin: 'Impl-Bot',
      credential,
      marketplacePreparation: marketplacePreparation(fixture),
    }), defaultRunner, {
      afterMarketplaceJournalInstalled(journalPath) {
        expect(existsSync(attemptDir)).toBe(false);
        expect(statSync(journalPath).mode & 0o777).toBe(0o600);
        const journal = readFileSync(journalPath, 'utf8');
        expect(journal).not.toContain('selected-secret');
        expect(journal).toContain('"selectedLogin": "Impl-Bot"');
        throw new Error('injected crash after journal installation');
      },
    })).rejects.toThrow('injected crash after journal installation');

    const journalPath = marketplaceInitializationJournal(fixture);
    expect(existsSync(attemptDir)).toBe(false);
    const resolveCredential = vi.fn((normalizedLogin: string) => {
      expect(normalizedLogin).toBe('impl-bot');
      return credential;
    });
    const recovered = await recoverMarketplaceAttemptInitializations(
      join(fixture.base, 'v2'),
      defaultRunner,
      resolveCredential,
    );

    expect(recovered).toHaveLength(1);
    expect(resolveCredential).toHaveBeenCalledOnce();
    expect(existsSync(journalPath)).toBe(false);
    expect(readAttemptManifest(join(attemptDir, 'manifest.json')))
      .toEqual(recovered[0]);
    expect(git(join(attemptDir, 'worktree'), ['rev-parse', 'HEAD']))
      .toBe(fixture.oid);
  });

  it('does not install a new initialization journal over an unrelated preexisting attempt directory', async () => {
    const fixture = repositoryFixture();
    const attemptDir = join(
      fixture.base,
      'v2',
      'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'implement',
      `issue-42-${UUID_A}`,
    );
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(join(attemptDir, 'sentinel'), 'unrelated\n');

    await expect(createAttemptWorkspace(options(fixture, {
      prNumber: 84,
      branch: 'autopilot/42',
      targetBaseOid: fixture.oid,
      marketplacePreparation: marketplacePreparation(fixture),
    }), defaultRunner)).rejects.toThrow(/attempt directory.*already exists/i);

    expect(readFileSync(join(attemptDir, 'sentinel'), 'utf8'))
      .toBe('unrelated\n');
    expect(readdirSync(dirname(attemptDir))
      .some((name) => name.endsWith('.marketplace-initialization.json')))
      .toBe(false);
  });

  it('recovers the exact journal-owned request after a crash before worktree creation', async () => {
    const fixture = repositoryFixture();
    const credential =
      new SelectedCredential('impl-bot', 'implementation', 'selected-secret');

    await expect(createAttemptWorkspace(options(fixture, {
      prNumber: 84,
      branch: 'autopilot/42',
      targetBaseOid: fixture.oid,
      credential,
      marketplacePreparation: marketplacePreparation(fixture),
    }), defaultRunner, {
      persistMarketplaceTaskRequest(requestPath, request) {
        const persisted = persistMarketplaceTaskRequest(requestPath, request);
        throw new Error(`injected request-only crash:${persisted.requestDigest}`);
      },
    })).rejects.toThrow('injected request-only crash');

    const journalPath = marketplaceInitializationJournal(fixture);
    const journalBefore = readFileSync(journalPath);
    const attemptDir = join(
      fixture.base,
      'v2',
      'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'implement',
      `issue-42-${UUID_A}`,
    );
    const requestPath = join(attemptDir, 'marketplace-request.json');
    const requestBefore = readFileSync(requestPath);

    const recovered = await recoverMarketplaceAttemptInitializations(
      join(fixture.base, 'v2'),
      defaultRunner,
      () => credential,
    );

    expect(recovered).toHaveLength(1);
    expect(existsSync(journalPath)).toBe(false);
    expect(readFileSync(requestPath)).toEqual(requestBefore);
    expect(journalBefore.toString('utf8')).not.toContain('selected-secret');
    expect(git(join(attemptDir, 'worktree'), ['rev-parse', 'HEAD']))
      .toBe(fixture.oid);
  });

  it('repairs only an interrupted journal-owned worktree and converges to the recorded head', async () => {
    const fixture = repositoryFixture();
    const credential =
      new SelectedCredential('impl-bot', 'implementation', 'selected-secret');
    let interrupted = false;
    const runner: CommandRunner = async (command, args, runnerOptions) => {
      const result = await defaultRunner(command, args, runnerOptions);
      if (
        !interrupted
        && command === 'git'
        && args.includes('worktree')
        && args.includes('add')
      ) {
        interrupted = true;
        throw new Error('injected crash after worktree registration');
      }
      return result;
    };

    await expect(createAttemptWorkspace(options(fixture, {
      prNumber: 84,
      branch: 'autopilot/42',
      targetBaseOid: fixture.oid,
      credential,
      marketplacePreparation: marketplacePreparation(fixture),
    }), runner)).rejects.toThrow('injected crash after worktree registration');

    const journalPath = marketplaceInitializationJournal(fixture);
    const sibling = join(dirname(journalPath), 'keep-me');
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'sentinel'), 'preserve\n');

    const recovered = await recoverMarketplaceAttemptInitializations(
      join(fixture.base, 'v2'),
      defaultRunner,
      () => credential,
    );

    expect(recovered).toHaveLength(1);
    expect(existsSync(journalPath)).toBe(false);
    expect(readFileSync(join(sibling, 'sentinel'), 'utf8')).toBe('preserve\n');
    expect(git(recovered[0]!.paths.worktree, ['rev-parse', 'HEAD']))
      .toBe(fixture.oid);
    expect(git(fixture.repo, ['worktree', 'list', '--porcelain']))
      .toContain(recovered[0]!.paths.worktree);
  });

  it('retires a surviving initialization journal when its exact prepared manifest and worktree are already durable', async () => {
    const fixture = repositoryFixture();
    const credential =
      new SelectedCredential('impl-bot', 'implementation', 'selected-secret');

    await expect(createAttemptWorkspace(options(fixture, {
      prNumber: 84,
      branch: 'autopilot/42',
      targetBaseOid: fixture.oid,
      credential,
      marketplacePreparation: marketplacePreparation(fixture),
    }), defaultRunner, {
      afterMarketplaceManifestInstalled() {
        throw new Error('injected crash after prepared manifest installation');
      },
    })).rejects.toThrow('injected crash after prepared manifest installation');

    const journalPath = marketplaceInitializationJournal(fixture);
    const manifestPath = join(
      fixture.base,
      'v2',
      'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'implement',
      `issue-42-${UUID_A}`,
      'manifest.json',
    );
    const preparedBefore = readFileSync(manifestPath);
    const recovered = await recoverMarketplaceAttemptInitializations(
      join(fixture.base, 'v2'),
      defaultRunner,
      () => credential,
    );

    expect(recovered).toHaveLength(1);
    expect(readFileSync(manifestPath)).toEqual(preparedBefore);
    expect(existsSync(journalPath)).toBe(false);
  });

  it.each(['submitted', 'cancelled'] as const)(
    'retires a stale initialization journal around an agreeing %s terminal manifest without touching credentials or Git',
    async (terminal) => {
      const fixture = repositoryFixture();
      const credential =
        new SelectedCredential('impl-bot', 'implementation', 'selected-secret');

      await expect(createAttemptWorkspace(options(fixture, {
        prNumber: 84,
        branch: 'autopilot/42',
        targetBaseOid: fixture.oid,
        credential,
        marketplacePreparation: marketplacePreparation(fixture),
      }), defaultRunner, {
        afterMarketplaceManifestInstalled() {
          throw new Error('injected crash after prepared manifest installation');
        },
      })).rejects.toThrow('injected crash after prepared manifest installation');

      const journalPath = marketplaceInitializationJournal(fixture);
      const manifestPath = join(
        fixture.base,
        'v2',
        'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'implement',
        `issue-42-${UUID_A}`,
        'manifest.json',
      );
      const prepared = readAttemptManifest(manifestPath);
      if (
        prepared.execution.backend !== 'marketplace'
        || prepared.execution.state.schemaVersion !== 'marketplace-execution-v3'
      ) {
        throw new Error('expected prepared marketplace execution');
      }
      transitionMarketplaceExecution(
        manifestPath,
        prepared.execution.state.requestDigest,
        terminal === 'submitted'
          ? { status: 'submitted', submission: SUBMISSION_RESULT }
          : { status: 'cancelled', reason: 'operator-cancelled' },
        () => new Date('2026-07-20T00:02:00.000Z'),
      );
      const terminalBytes = readFileSync(manifestPath);
      const resolveCredential = vi.fn(() => {
        throw new Error('terminal recovery must not resolve credentials');
      });
      const runner = vi.fn(async () => {
        throw new Error('terminal recovery must not inspect or repair Git');
      });

      const recovered = await recoverMarketplaceAttemptInitializations(
        join(fixture.base, 'v2'),
        runner,
        resolveCredential,
      );

      expect(recovered).toHaveLength(1);
      expect(recovered[0]!.execution).toMatchObject({
        backend: 'marketplace',
        state: { status: terminal },
      });
      expect(resolveCredential).not.toHaveBeenCalled();
      expect(runner).not.toHaveBeenCalled();
      expect(readFileSync(manifestPath)).toEqual(terminalBytes);
      expect(existsSync(journalPath)).toBe(false);
    },
  );

  // This catches a self-consistent v3 evidence chain copied into another outer attempt.
  it('binds submitted, delivery, and completion evidence to outer manifest authority', async () => {
    const fixture = repositoryFixture();
    const requestDigest = `sha256:${'a'.repeat(64)}`;
    const runnerId = 'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const attemptDir = join(
      fixture.base,
      'v2',
      runnerId,
      'implement',
      `issue-42-${UUID_A}`,
    );
    const submission = {
      ...SUBMISSION_RESULT,
      generatedAt: NOW,
      id: `autopilot:${UUID_A}`,
      taskId: '501',
    };
    const manifest = await createAttemptWorkspace(options(fixture, {
      prNumber: 84,
      branch: 'autopilot/42',
      targetBaseOid: fixture.oid,
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v3',
          status: 'submitted',
          requestPath: join(attemptDir, 'marketplace-request.json'),
          requestDigest,
          solverNetSelectionPath: join(attemptDir, 'solvernet-selection.json'),
          preparedAt: NOW,
          agentSoftDeadline: '2026-07-20T01:00:00.000Z',
          adoptionDeadline: '2026-07-20T01:30:00.000Z',
          submission,
          submittedAt: NOW,
        },
      },
    }), defaultRunner);
    const delivery = {
      observationPath: join(attemptDir, 'delivery.json'),
      observationDigest: `sha256:${'b'.repeat(64)}`,
      taskId: '501',
      taskCid: submission.taskCid,
      taskCreationTransaction: submission.creationTx,
      taskCreationBlock: submission.creationBlock,
      solverNetManifestCid: submission.solverNetManifestCid,
      attemptIndex: 0,
      requestId: `0x${'c'.repeat(64)}`,
      deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid',
      deliveryEnvelopeDigest: `sha256:${'d'.repeat(64)}`,
      deliveryTransaction: `0x${'e'.repeat(64)}`,
      deliveryBlock: submission.creationBlock + 1,
      solverSafe: `0x${'1'.repeat(40)}`,
      solverAgentEoa: `0x${'2'.repeat(40)}`,
      signer: `0x${'2'.repeat(40)}`,
      publisherAgentId: '501',
      correlation: {
        taskId: '501',
        attemptIndex: 0,
        requestId: `0x${'c'.repeat(64)}`,
        deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid',
        v2AttemptId: UUID_A,
        claimOid: fixture.oid,
        prNumber: 84,
        expectedHead: fixture.oid,
      },
      observedAt: NOW,
    };
    const submittedBytes = readFileSync(manifest.paths.manifest);
    expect(() => transitionMarketplaceAdoption(
      manifest.paths.manifest,
      requestDigest,
      {
        status: 'solution-observed',
        delivery: {
          ...delivery,
          correlation: { ...delivery.correlation, prNumber: 85 },
        },
      },
      () => new Date(NOW),
    )).toThrow(/marketplace execution.*manifest authority/i);
    expect(readFileSync(manifest.paths.manifest)).toEqual(submittedBytes);
    transitionMarketplaceAdoption(
      manifest.paths.manifest,
      requestDigest,
      { status: 'solution-observed', delivery },
      () => new Date(NOW),
    );
    const observed = readAttemptManifest(manifest.paths.manifest);

    for (const [name, mutate] of [
      ['attempt', (raw) => {
        raw.execution.state.submission.id = `autopilot:${UUID_B}`;
        raw.execution.state.delivery.correlation.v2AttemptId = UUID_B;
      }],
      ['PR', (raw) => { raw.execution.state.delivery.correlation.prNumber = 85; }],
      ['claim', (raw) => { raw.execution.state.delivery.correlation.claimOid = 'b'.repeat(40); }],
      ['expected head', (raw) => {
        raw.execution.state.delivery.correlation.expectedHead = 'c'.repeat(40);
      }],
    ]) {
      const raw = JSON.parse(JSON.stringify(observed));
      mutate(raw);
      expect(() => decodeAttemptManifest(raw), `${name} authority`).toThrow(
        /marketplace execution.*manifest authority/i,
      );
    }

    const artifact = {
      digest: `sha256:${'3'.repeat(64)}`,
      byteLength: 12,
      touchedPaths: ['packages/a.ts'],
      expectedTree: fixture.oid,
    };
    transitionMarketplaceAdoption(
      manifest.paths.manifest,
      requestDigest,
      {
        status: 'solution-verified',
        artifact,
        verification: {
          profile: 'jinn-mono.v1',
          artifactDigest: artifact.digest,
          expectedTree: fixture.oid,
          planDigest: `sha256:${'4'.repeat(64)}`,
          commands: [{
            label: 'typecheck',
            command: 'yarn',
            args: ['typecheck'],
            cwdRelative: '.',
            status: 'passed',
            exitCode: 0,
            stdoutDigest: `sha256:${'5'.repeat(64)}`,
            stderrDigest: `sha256:${'6'.repeat(64)}`,
            startedAt: NOW,
            completedAt: NOW,
          }],
          verifiedAt: NOW,
        },
      },
      () => new Date(NOW),
    );
    transitionMarketplaceAdoption(
      manifest.paths.manifest,
      requestDigest,
      {
        status: 'host-committed',
        hostCommit: {
          head: fixture.oid,
          tree: fixture.oid,
          parents: [fixture.oid],
          artifactDigest: artifact.digest,
          correlationDigest: `sha256:${'7'.repeat(64)}`,
          trailers: {
            taskId: '501',
            requestId: delivery.requestId,
            deliveryEnvelopeCid: delivery.deliveryEnvelopeCid,
            v2AttemptId: UUID_A,
            artifactDigest: artifact.digest,
          },
          createdAt: NOW,
        },
      },
      () => new Date(NOW),
    );
    transitionMarketplaceAdoption(
      manifest.paths.manifest,
      requestDigest,
      {
        status: 'lifecycle-completed',
        completion: {
          operation: 'implementation-complete',
          prNumber: 84,
          branch: 'autopilot/42',
          claimOid: fixture.oid,
          checkpointOid: fixture.oid,
          resultingHead: fixture.oid,
          lifecycleStatus: 'In Review',
          confirmedAt: NOW,
        },
      },
      () => new Date(NOW),
    );
    const wrongBranch = JSON.parse(readFileSync(manifest.paths.manifest, 'utf8'));
    wrongBranch.execution.state.completion.branch = 'autopilot/other';
    expect(() => decodeAttemptManifest(wrongBranch)).toThrow(
      /marketplace execution.*manifest authority/i,
    );
  });

  // This catches evaluator installation erasing a Task or accepting copied review authority.
  it('installs an evaluator only over its exact eligible prepared review manifest', async () => {
    const createReview = async (input: {
      readonly phase?: 'implement' | 'review';
      readonly status?: 'prepared' | 'submitted';
      readonly approval?: 'approve-eligible' | 'human-codeowner';
    } = {}) => {
      const fixture = repositoryFixture();
      const phase = input.phase ?? 'review';
      const status = input.status ?? 'prepared';
      const attemptId = UUID_B;
      const subject = phase === 'review' ? 'pr-84' : 'issue-42';
      const attemptDir = join(
        fixture.base,
        'v2',
        'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        phase,
        `${subject}-${attemptId}`,
      );
      const prepared = {
        schemaVersion: 'marketplace-execution-v2',
        requestPath: join(attemptDir, 'marketplace-request.json'),
        requestDigest: `sha256:${'a'.repeat(64)}`,
        solverNetSelectionPath: join(attemptDir, 'solvernet-selection.json'),
        preparedAt: NOW,
        agentSoftDeadline: '2026-07-20T01:00:00.000Z',
        adoptionDeadline: '2026-07-20T01:30:00.000Z',
      };
      const manifest = await createAttemptWorkspace(options(fixture, {
        attemptId,
        phase,
        subject,
        prNumber: 84,
        branch: 'autopilot/42',
        ...(phase === 'review'
          ? {
              reviewGeneration: UUID_C,
              reviewRefOid: fixture.oid,
              reviewApprovalPolicy: input.approval ?? 'approve-eligible',
              selectedLogin: 'review-bot',
            }
          : { targetBaseOid: fixture.oid }),
        execution: {
          backend: 'marketplace',
          state: status === 'prepared'
            ? { ...prepared, status }
            : {
                ...prepared,
                status,
                submission: {
                  ...SUBMISSION_RESULT,
                  generatedAt: NOW,
                  id: `autopilot:${attemptId}`,
                },
                submittedAt: NOW,
              },
        },
      }), defaultRunner);
      return {
        manifest,
        identity: {
          originManifestPath: join(
            fixture.base,
            'v2',
            manifest.runnerId,
            'implement',
            `issue-42-${UUID_A}`,
            'manifest.json',
          ),
          originV2AttemptId: UUID_A,
          originRequestDigest: `sha256:${'b'.repeat(64)}`,
          taskId: '501',
          taskCid: 'bafybeigdyrzt5m6u2r3o4exampletaskcid',
          taskCreationBlock: 501,
          prNumber: 84,
          expectedHead: fixture.oid,
          generation: UUID_C,
          reviewRefOid: fixture.oid,
          reviewer: 'review-bot',
        },
      };
    };

    const exact = await createReview();
    const exactBytes = readFileSync(exact.manifest.paths.manifest);
    for (const [name, identity] of [
      ['PR', { ...exact.identity, prNumber: 85 }],
      ['head', { ...exact.identity, expectedHead: 'b'.repeat(40) }],
      ['generation', { ...exact.identity, generation: UUID_A }],
      ['ref', { ...exact.identity, reviewRefOid: 'c'.repeat(40) }],
      ['reviewer', { ...exact.identity, reviewer: 'other-reviewer' }],
    ]) {
      let error: unknown;
      try {
        installMarketplaceEvaluatorLeg(
          exact.manifest.paths.manifest,
          identity,
          () => new Date(NOW),
        );
      } catch (caught) {
        error = caught;
      }
      expect.soft(String(error), `${name} authority`).toMatch(
        /evaluator.*review manifest authority/i,
      );
      writeFileSync(exact.manifest.paths.manifest, exactBytes);
    }

    for (const [name, input] of [
      ['submitted predecessor', { status: 'submitted' }],
      ['human-owned review', { approval: 'human-codeowner' }],
      ['implementation predecessor', { phase: 'implement' }],
    ]) {
      const candidate = await createReview(input);
      const before = readFileSync(candidate.manifest.paths.manifest);
      expect(() => installMarketplaceEvaluatorLeg(
        candidate.manifest.paths.manifest,
        candidate.identity,
        () => new Date(NOW),
      ), name).toThrow(/eligible prepared review manifest/i);
      expect(readFileSync(candidate.manifest.paths.manifest)).toEqual(before);
    }

    const invalidLink = {
      ...exact.identity,
      originManifestPath: join(
        dirname(dirname(dirname(exact.identity.originManifestPath))),
        'other-runner',
        'implement',
        `issue-42-${UUID_A}`,
        'manifest.json',
      ),
    };
    expect(() => installMarketplaceEvaluatorLeg(
      exact.manifest.paths.manifest,
      invalidLink,
      () => new Date(NOW),
    )).toThrow(/origin manifest path/i);
    expect(readFileSync(exact.manifest.paths.manifest)).toEqual(exactBytes);
  });

  it.each(['digest', 'submission-identity'] as const)(
    'retains the initialization journal and terminal bytes when the %s contradicts it',
    async (contradiction) => {
      const fixture = repositoryFixture();
      const credential =
        new SelectedCredential('impl-bot', 'implementation', 'selected-secret');

      await expect(createAttemptWorkspace(options(fixture, {
        prNumber: 84,
        branch: 'autopilot/42',
        targetBaseOid: fixture.oid,
        credential,
        marketplacePreparation: marketplacePreparation(fixture),
      }), defaultRunner, {
        afterMarketplaceManifestInstalled() {
          throw new Error('injected crash after prepared manifest installation');
        },
      })).rejects.toThrow('injected crash after prepared manifest installation');

      const journalPath = marketplaceInitializationJournal(fixture);
      const manifestPath = join(
        fixture.base,
        'v2',
        'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'implement',
        `issue-42-${UUID_A}`,
        'manifest.json',
      );
      const prepared = readAttemptManifest(manifestPath);
      if (
        prepared.execution.backend !== 'marketplace'
        || prepared.execution.state.schemaVersion !== 'marketplace-execution-v3'
      ) {
        throw new Error('expected prepared marketplace execution');
      }
      transitionMarketplaceExecution(
        manifestPath,
        prepared.execution.state.requestDigest,
        { status: 'submitted', submission: SUBMISSION_RESULT },
        () => new Date('2026-07-20T00:02:00.000Z'),
      );
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        execution: {
          state: {
            requestDigest: string;
            submission: { id: string };
          };
        };
      };
      if (contradiction === 'digest') {
        raw.execution.state.requestDigest = `sha256:${'f'.repeat(64)}`;
      } else {
        raw.execution.state.submission.id =
          'autopilot:22222222-2222-4222-8222-222222222222';
      }
      writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, {
        mode: 0o600,
      });
      const terminalBytes = readFileSync(manifestPath);
      const resolveCredential = vi.fn(() => credential);
      const runner = vi.fn(async () => '');

      await expect(recoverMarketplaceAttemptInitializations(
        join(fixture.base, 'v2'),
        runner,
        resolveCredential,
      )).rejects.toThrow(
        /terminal.*journal|conflicts.*journal|marketplace execution.*manifest authority/i,
      );

      expect(resolveCredential).not.toHaveBeenCalled();
      expect(runner).not.toHaveBeenCalled();
      expect(readFileSync(manifestPath)).toEqual(terminalBytes);
      expect(existsSync(journalPath)).toBe(true);
    },
  );

  it('accepts an agreeing terminal transition between prepared-manifest installation and readback', async () => {
    const fixture = repositoryFixture();
    const preparation = marketplacePreparation(fixture);
    const manifest = await createAttemptWorkspace(options(fixture, {
      prNumber: 84,
      branch: 'autopilot/42',
      targetBaseOid: fixture.oid,
      marketplacePreparation: preparation,
    }), defaultRunner, {
      afterMarketplaceManifestInstalled(path, prepared) {
        transitionMarketplaceExecution(
          path,
          prepared.execution.state.requestDigest,
          { status: 'submitted', submission: SUBMISSION_RESULT },
          () => new Date('2026-07-20T00:02:00.000Z'),
        );
      },
    });

    expect(manifest.execution).toMatchObject({
      backend: 'marketplace',
      state: { status: 'submitted' },
    });
    expect(existsSync(marketplaceInitializationJournalPathForTest(
      fixture,
    ))).toBe(false);
  });

  it.each(['submitted', 'cancelled'] as const)(
    'preserves a %s winner when two stale initializers both observed no prepared manifest',
    async (terminal) => {
      const fixture = repositoryFixture();
      const credential =
        new SelectedCredential('impl-bot', 'implementation', 'selected-secret');
      await expect(createAttemptWorkspace(options(fixture, {
        prNumber: 84,
        branch: 'autopilot/42',
        targetBaseOid: fixture.oid,
        credential,
        marketplacePreparation: marketplacePreparation(fixture),
      }), defaultRunner, {
        beforeMarketplaceManifestInstall() {
          throw new Error('injected crash immediately before manifest install');
        },
      })).rejects.toThrow('injected crash immediately before manifest install');

      const journalPath = marketplaceInitializationJournal(fixture);
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        manifest: AttemptManifest;
      };
      const manifestPath = journal.manifest.paths.manifest;
      expect(existsSync(manifestPath)).toBe(false);
      const firstRelease = deferred();
      const secondRelease = deferred();
      const bothAtBarrier = deferred();
      const terminalInstalled = deferred();
      let barrierCalls = 0;
      let installCalls = 0;
      const runtime = {
        beforeMarketplaceManifestInstall() {
          barrierCalls += 1;
          if (barrierCalls === 2) bothAtBarrier.resolve();
          return barrierCalls === 1
            ? firstRelease.promise
            : secondRelease.promise;
        },
        afterMarketplaceManifestInstalled(path: string, prepared: AttemptManifest) {
          installCalls += 1;
          if (
            prepared.execution.backend !== 'marketplace'
            || prepared.execution.state.schemaVersion
              !== 'marketplace-execution-v3'
          ) {
            throw new Error('expected prepared marketplace manifest');
          }
          transitionMarketplaceExecution(
            path,
            prepared.execution.state.requestDigest,
            terminal === 'submitted'
              ? { status: 'submitted', submission: SUBMISSION_RESULT }
              : { status: 'cancelled', reason: 'operator-cancelled' },
            () => new Date('2026-07-20T00:02:00.000Z'),
          );
          terminalInstalled.resolve();
        },
      };
      const resolveCredential = vi.fn(() => credential);
      const first = recoverMarketplaceAttemptInitializations(
        join(fixture.base, 'v2'),
        defaultRunner,
        resolveCredential,
        runtime,
      );
      const second = recoverMarketplaceAttemptInitializations(
        join(fixture.base, 'v2'),
        defaultRunner,
        resolveCredential,
        runtime,
      );

      await withTimeout(bothAtBarrier.promise);
      firstRelease.resolve();
      await withTimeout(terminalInstalled.promise);
      const terminalBytes = readFileSync(manifestPath);
      secondRelease.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult[0]!.execution).toMatchObject({
        backend: 'marketplace',
        state: { status: terminal },
      });
      expect(secondResult[0]!.execution).toMatchObject({
        backend: 'marketplace',
        state: { status: terminal },
      });
      expect(installCalls).toBe(1);
      expect(readFileSync(manifestPath)).toEqual(terminalBytes);
      expect(existsSync(journalPath)).toBe(false);
    },
  );

  it('retains the journal when a concurrent manifest-install winner contradicts its request identity', async () => {
    const fixture = repositoryFixture();
    const credential =
      new SelectedCredential('impl-bot', 'implementation', 'selected-secret');
    await expect(createAttemptWorkspace(options(fixture, {
      prNumber: 84,
      branch: 'autopilot/42',
      targetBaseOid: fixture.oid,
      credential,
      marketplacePreparation: marketplacePreparation(fixture),
    }), defaultRunner, {
      beforeMarketplaceManifestInstall() {
        throw new Error('injected crash immediately before manifest install');
      },
    })).rejects.toThrow('injected crash immediately before manifest install');

    const journalPath = marketplaceInitializationJournal(fixture);
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      manifest: AttemptManifest;
    };
    const manifestPath = journal.manifest.paths.manifest;
    const firstRelease = deferred();
    const secondRelease = deferred();
    const bothAtBarrier = deferred();
    const contradictoryInstalled = deferred();
    let barrierCalls = 0;
    const runtime = {
      beforeMarketplaceManifestInstall() {
        barrierCalls += 1;
        if (barrierCalls === 2) bothAtBarrier.resolve();
        return barrierCalls === 1
          ? firstRelease.promise
          : secondRelease.promise;
      },
      afterMarketplaceManifestInstalled(path: string, prepared: AttemptManifest) {
        if (
          prepared.execution.backend !== 'marketplace'
          || prepared.execution.state.schemaVersion
            !== 'marketplace-execution-v3'
        ) {
          throw new Error('expected prepared marketplace manifest');
        }
        transitionMarketplaceExecution(
          path,
          prepared.execution.state.requestDigest,
          { status: 'submitted', submission: SUBMISSION_RESULT },
          () => new Date('2026-07-20T00:02:00.000Z'),
        );
        const raw = JSON.parse(readFileSync(path, 'utf8')) as {
          execution: { state: { submission: { id: string } } };
        };
        raw.execution.state.submission.id =
          'autopilot:22222222-2222-4222-8222-222222222222';
        writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
        contradictoryInstalled.resolve();
      },
    };
    const first = recoverMarketplaceAttemptInitializations(
      join(fixture.base, 'v2'),
      defaultRunner,
      () => credential,
      runtime,
    );
    const second = recoverMarketplaceAttemptInitializations(
      join(fixture.base, 'v2'),
      defaultRunner,
      () => credential,
      runtime,
    );

    await withTimeout(bothAtBarrier.promise);
    firstRelease.resolve();
    await withTimeout(contradictoryInstalled.promise);
    const contradictoryBytes = readFileSync(manifestPath);
    secondRelease.resolve();
    const outcomes = await Promise.allSettled([first, second]);

    expect(outcomes.every((outcome) =>
      outcome.status === 'rejected'
      && /identity.*journal|marketplace execution.*manifest authority/i
        .test(String(outcome.reason)))).toBe(true);
    expect(readFileSync(manifestPath)).toEqual(contradictoryBytes);
    expect(existsSync(journalPath)).toBe(true);
  });

  it('fails closed when initialization cannot resolve the exact recorded login', async () => {
    const fixture = repositoryFixture();
    const credential =
      new SelectedCredential('impl-bot', 'implementation', 'selected-secret');

    await expect(createAttemptWorkspace(options(fixture, {
      prNumber: 84,
      branch: 'autopilot/42',
      targetBaseOid: fixture.oid,
      credential,
      marketplacePreparation: marketplacePreparation(fixture),
    }), defaultRunner, {
      afterMarketplaceJournalInstalled() {
        throw new Error('injected crash after journal installation');
      },
    })).rejects.toThrow('injected crash after journal installation');

    await expect(recoverMarketplaceAttemptInitializations(
      join(fixture.base, 'v2'),
      defaultRunner,
      () => new SelectedCredential('other-bot', 'implementation', 'other-secret'),
    )).rejects.toThrow(/credential.*recorded login/i);
    expect(existsSync(marketplaceInitializationJournal(fixture))).toBe(true);
  });

  it('rejects a journal whose arbitrary direct-child path is not its subject and attempt identity before any side effect', async () => {
    const fixture = repositoryFixture();
    const credential =
      new SelectedCredential('impl-bot', 'implementation', 'selected-secret');

    await expect(createAttemptWorkspace(options(fixture, {
      prNumber: 84,
      branch: 'autopilot/42',
      targetBaseOid: fixture.oid,
      credential,
      marketplacePreparation: marketplacePreparation(fixture),
    }), defaultRunner, {
      afterMarketplaceJournalInstalled() {
        throw new Error('injected journal-only crash');
      },
    })).rejects.toThrow('injected journal-only crash');

    const originalJournal = marketplaceInitializationJournal(fixture);
    const raw = JSON.parse(readFileSync(originalJournal, 'utf8')) as {
      manifest: AttemptManifest;
    };
    const arbitraryAttemptDir = join(dirname(originalJournal), 'arbitrary-child');
    raw.manifest.paths = {
      attemptDir: arbitraryAttemptDir,
      worktree: join(arbitraryAttemptDir, 'worktree'),
      manifest: join(arbitraryAttemptDir, 'manifest.json'),
      log: join(arbitraryAttemptDir, 'session.log'),
      ghConfigDir: join(arbitraryAttemptDir, 'gh-config'),
      askpass: join(arbitraryAttemptDir, 'askpass'),
      tokenFile: join(arbitraryAttemptDir, 'gh-token'),
    };
    if (
      raw.manifest.execution.backend !== 'marketplace'
      || raw.manifest.execution.state.schemaVersion
        !== 'marketplace-execution-v3'
    ) {
      throw new Error('expected marketplace journal');
    }
    raw.manifest.execution.state.requestPath =
      join(arbitraryAttemptDir, 'marketplace-request.json');
    raw.manifest.execution.state.solverNetSelectionPath =
      `${raw.manifest.execution.state.requestPath}.solvernet-selection.json`;
    const tamperedJournal = join(
      dirname(originalJournal),
      '.arbitrary-child.marketplace-initialization.json',
    );
    renameSync(originalJournal, tamperedJournal);
    writeFileSync(tamperedJournal, `${JSON.stringify(raw, null, 2)}\n`, {
      mode: 0o600,
    });
    const resolveCredential = vi.fn(() => credential);
    const runner = vi.fn(async () => '');

    await expect(recoverMarketplaceAttemptInitializations(
      join(fixture.base, 'v2'),
      runner,
      resolveCredential,
    )).rejects.toThrow(/subject.*attempt|attempt.*identity/i);

    expect(resolveCredential).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(existsSync(arbitraryAttemptDir)).toBe(false);
    expect(existsSync(tamperedJournal)).toBe(true);
  });

  it('re-establishes repository identity before repairing an interrupted worktree', async () => {
    const fixture = repositoryFixture();
    const credential =
      new SelectedCredential('impl-bot', 'implementation', 'selected-secret');
    let interrupted = false;
    const crashRunner: CommandRunner = async (command, args, runnerOptions) => {
      const result = await defaultRunner(command, args, runnerOptions);
      if (
        !interrupted
        && command === 'git'
        && args.includes('worktree')
        && args.includes('add')
      ) {
        interrupted = true;
        throw new Error('injected crash after worktree registration');
      }
      return result;
    };

    await expect(createAttemptWorkspace(options(fixture, {
      prNumber: 84,
      branch: 'autopilot/42',
      targetBaseOid: fixture.oid,
      credential,
      marketplacePreparation: marketplacePreparation(fixture),
    }), crashRunner)).rejects.toThrow('injected crash after worktree registration');

    const journalPath = marketplaceInitializationJournal(fixture);
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      manifest: AttemptManifest;
    };
    writeFileSync(
      join(journal.manifest.paths.worktree, 'partial-checkout'),
      'dirty\n',
    );
    git(fixture.repo, ['remote', 'set-url', 'origin', join(fixture.root, 'other.git')]);
    let removeCalls = 0;
    const recoveryRunner: CommandRunner = async (command, args, runnerOptions) => {
      if (
        command === 'git'
        && args.includes('worktree')
        && args.includes('remove')
      ) {
        removeCalls += 1;
      }
      return defaultRunner(command, args, runnerOptions);
    };

    await expect(recoverMarketplaceAttemptInitializations(
      join(fixture.base, 'v2'),
      recoveryRunner,
      () => credential,
    )).rejects.toThrow(/repository identity.*match/i);

    expect(removeCalls).toBe(0);
    expect(readFileSync(
      join(journal.manifest.paths.worktree, 'partial-checkout'),
      'utf8',
    )).toBe('dirty\n');
    expect(existsSync(journalPath)).toBe(true);
  });

  it('accepts a bodyless task snapshot whose required problem statement falls back to its title', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture, {
      prNumber: 84,
      branch: 'autopilot/42',
      targetBaseOid: fixture.oid,
      marketplacePreparation: marketplacePreparation(
        fixture,
        'implementation',
        '',
      ),
    }), defaultRunner);
    if (
      manifest.execution.backend !== 'marketplace'
      || manifest.execution.state.schemaVersion !== 'marketplace-execution-v3'
    ) {
      throw new Error('expected a version-3 marketplace execution');
    }

    const request = verifyMarketplaceTaskRequest(
      manifest.execution.state.requestPath,
      manifest.execution.state.requestDigest,
    );
    expect(request.spec.session.taskSnapshot.body).toBe('');
    expect(request.spec.problem_statement)
      .toBe('Publish one durable marketplace task');
  });

  it('retains only the exact journal-owned attempt when marketplace initialization is interrupted before worktree creation', async () => {
    const fixture = repositoryFixture();
    const attemptDir = join(
      fixture.base,
      'v2',
      'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'implement',
      `issue-42-${UUID_A}`,
    );
    const sibling = join(dirname(attemptDir), 'keep-me');
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'sentinel'), 'preserve\n');

    await expect(createAttemptWorkspace(options(fixture, {
      prNumber: 84,
      branch: 'autopilot/42',
      targetBaseOid: fixture.oid,
      marketplacePreparation: marketplacePreparation(fixture),
    }), defaultRunner, {
      persistMarketplaceTaskRequest(requestPath, request) {
        persistMarketplaceTaskRequest(requestPath, request);
        throw new Error('injected post-request initialization failure');
      },
    })).rejects.toThrow('injected post-request initialization failure');

    expect(existsSync(attemptDir)).toBe(true);
    expect(existsSync(marketplaceInitializationJournal(fixture))).toBe(true);
    expect(readFileSync(join(sibling, 'sentinel'), 'utf8')).toBe('preserve\n');
    expect(git(fixture.repo, ['worktree', 'list', '--porcelain']))
      .not.toContain(join(attemptDir, 'worktree'));
  });

  it('rejects a schema-valid marketplace capsule that contradicts its attempt binding before side effects', async () => {
    const fixture = repositoryFixture();
    const preparation = marketplacePreparation(fixture);
    const attemptDir = join(
      fixture.base,
      'v2',
      'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'implement',
      `issue-42-${UUID_A}`,
    );
    const request = structuredClone(preparation.request);
    request.spec.session.branch = 'autopilot/wrong-issue';
    let worktreeAdds = 0;
    const runner: CommandRunner = async (command, args, runnerOptions) => {
      if (command === 'git' && args.includes('worktree') && args.includes('add')) {
        worktreeAdds += 1;
      }
      return defaultRunner(command, args, runnerOptions);
    };

    await expect(createAttemptWorkspace(options(fixture, {
      prNumber: 84,
      branch: 'autopilot/42',
      targetBaseOid: fixture.oid,
      marketplacePreparation: {
        ...preparation,
        request,
      },
    }), runner)).rejects.toThrow(/marketplace preparation.*branch/i);

    expect(existsSync(attemptDir)).toBe(false);
    expect(worktreeAdds).toBe(0);
  });

  it.each([
    ['implementation', 'implement'],
    ['review-finding', 'fix-child'],
    ['reconcile', 'reconcile'],
    ['ci-failure', 'ci-failure'],
  ] as const)(
    'accepts the canonical %s workflow discriminator as %s',
    async (workflow, expectedSessionWorkflow) => {
      const fixture = repositoryFixture();
      const manifest = await createAttemptWorkspace(options(fixture, {
        prNumber: 84,
        branch: 'autopilot/42',
        targetBaseOid: fixture.oid,
        marketplacePreparation: marketplacePreparation(fixture, workflow),
      }), defaultRunner);
      if (
        manifest.execution.backend !== 'marketplace'
        || manifest.execution.state.schemaVersion !== 'marketplace-execution-v3'
      ) {
        throw new Error('expected a version-3 marketplace execution');
      }

      expect(verifyMarketplaceTaskRequest(
        manifest.execution.state.requestPath,
        manifest.execution.state.requestDigest,
      ).spec.session.workflow).toBe(expectedSessionWorkflow);
    },
  );

  it('atomically transitions a prepared marketplace execution to submitted for its expected digest', async () => {
    const fixture = repositoryFixture();
    const requestDigest = `sha256:${'a'.repeat(64)}`;
    const manifest = await createAttemptWorkspace(options(fixture, {
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v2',
          status: 'prepared',
          requestPath: join(fixture.root, 'marketplace-request.json'),
          requestDigest,
          solverNetSelectionPath: join(fixture.root, 'solvernet-selection.json'),
          preparedAt: '2026-07-20T00:01:00.000Z',
          agentSoftDeadline: '2026-07-20T01:00:00.000Z',
          adoptionDeadline: '2026-07-20T01:30:00.000Z',
        },
      },
    }), defaultRunner);

    const transitioned = transitionMarketplaceExecution(
      manifest.paths.manifest,
      requestDigest,
      { status: 'submitted', submission: SUBMISSION_RESULT },
      () => new Date('2026-07-20T00:02:00.000Z'),
    );

    expect(transitioned.execution).toEqual({
      backend: 'marketplace',
      state: {
        schemaVersion: 'marketplace-execution-v2',
        status: 'submitted',
        requestPath: join(fixture.root, 'marketplace-request.json'),
        requestDigest,
        solverNetSelectionPath: join(fixture.root, 'solvernet-selection.json'),
        preparedAt: '2026-07-20T00:01:00.000Z',
        agentSoftDeadline: '2026-07-20T01:00:00.000Z',
        adoptionDeadline: '2026-07-20T01:30:00.000Z',
        submission: SUBMISSION_RESULT,
        submittedAt: '2026-07-20T00:02:00.000Z',
      },
    });
    expect(transitioned.timestamps.updatedAt).toBe('2026-07-20T00:02:00.000Z');
    expect(readAttemptManifest(manifest.paths.manifest)).toEqual(transitioned);
  });

  it('atomically transitions a prepared marketplace execution to cancelled with its stable reason', async () => {
    const fixture = repositoryFixture();
    const requestDigest = `sha256:${'a'.repeat(64)}`;
    const manifest = await createAttemptWorkspace(options(fixture, {
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v2',
          status: 'prepared',
          requestPath: join(fixture.root, 'marketplace-request.json'),
          requestDigest,
          solverNetSelectionPath: join(fixture.root, 'solvernet-selection.json'),
          preparedAt: '2026-07-20T00:01:00.000Z',
          agentSoftDeadline: '2026-07-20T01:00:00.000Z',
          adoptionDeadline: '2026-07-20T01:30:00.000Z',
        },
      },
    }), defaultRunner);

    const cancelled = transitionMarketplaceExecution(
      manifest.paths.manifest,
      requestDigest,
      { status: 'cancelled', reason: 'operator-cancelled' },
      () => new Date('2026-07-20T00:02:00.000Z'),
    );

    expect(cancelled.execution).toMatchObject({
      backend: 'marketplace',
      state: {
        schemaVersion: 'marketplace-execution-v2',
        status: 'cancelled',
        requestDigest,
        cancelledAt: '2026-07-20T00:02:00.000Z',
        reason: 'operator-cancelled',
      },
    });
    expect(cancelled.timestamps.updatedAt).toBe('2026-07-20T00:02:00.000Z');
  });

  // This catches a terminal journal that accepts only legacy v2 prepared manifests.
  it.each(['submitted', 'cancelled'] as const)(
    'atomically records a %s terminal outcome for a prepared v3 execution',
    async (status) => {
      const fixture = repositoryFixture();
      const requestDigest = `sha256:${'a'.repeat(64)}`;
      const attemptDir = join(
        fixture.base,
        'v2',
        'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'implement',
        `issue-42-${UUID_A}`,
      );
      const manifest = await createAttemptWorkspace(options(fixture, {
        execution: {
          backend: 'marketplace',
          state: {
            schemaVersion: 'marketplace-execution-v3',
            status: 'prepared',
            requestPath: join(attemptDir, 'marketplace-request.json'),
            requestDigest,
            solverNetSelectionPath: join(attemptDir, 'solvernet-selection.json'),
            preparedAt: NOW,
            agentSoftDeadline: '2026-07-20T01:00:00.000Z',
            adoptionDeadline: '2026-07-20T01:30:00.000Z',
          },
        },
      }), defaultRunner);

      const transitioned = transitionMarketplaceExecution(
        manifest.paths.manifest,
        requestDigest,
        status === 'submitted'
          ? { status, submission: SUBMISSION_RESULT }
          : { status, reason: 'operator-cancelled' },
        () => new Date('2026-07-20T00:02:00.000Z'),
      );

      expect(transitioned.execution).toMatchObject({
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v3',
          status,
          requestDigest,
        },
      });
    },
  );

  it('rejects local and stale-digest transitions before an atomic manifest rewrite', async () => {
    const fixture = repositoryFixture();
    const local = await createAttemptWorkspace(options(fixture), defaultRunner);
    const requestDigest = `sha256:${'a'.repeat(64)}`;
    expect(() => transitionMarketplaceExecution(
      local.paths.manifest,
      requestDigest,
      { status: 'submitted', submission: SUBMISSION_RESULT },
    )).toThrow(/Only marketplace attempts/i);

    const marketplace = await createAttemptWorkspace(options(fixture, {
      attemptId: UUID_B,
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v2',
          status: 'prepared',
          requestPath: join(fixture.root, 'marketplace-request.json'),
          requestDigest,
          solverNetSelectionPath: join(fixture.root, 'solvernet-selection.json'),
          preparedAt: '2026-07-20T00:01:00.000Z',
          agentSoftDeadline: '2026-07-20T01:00:00.000Z',
          adoptionDeadline: '2026-07-20T01:30:00.000Z',
        },
      },
    }), defaultRunner);
    const original = readFileSync(marketplace.paths.manifest, 'utf8');

    expect(() => transitionMarketplaceExecution(
      marketplace.paths.manifest,
      `sha256:${'b'.repeat(64)}`,
      { status: 'submitted', submission: SUBMISSION_RESULT },
    )).toThrow(/request digest changed/i);
    expect(readFileSync(marketplace.paths.manifest, 'utf8')).toBe(original);
  });

  it('makes matching marketplace resubmission idempotent and rejects contradictory resubmission', async () => {
    const fixture = repositoryFixture();
    const requestDigest = `sha256:${'a'.repeat(64)}`;
    const manifest = await createAttemptWorkspace(options(fixture, {
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v2',
          status: 'prepared',
          requestPath: join(fixture.root, 'marketplace-request.json'),
          requestDigest,
          solverNetSelectionPath: join(fixture.root, 'solvernet-selection.json'),
          preparedAt: '2026-07-20T00:01:00.000Z',
          agentSoftDeadline: '2026-07-20T01:00:00.000Z',
          adoptionDeadline: '2026-07-20T01:30:00.000Z',
        },
      },
    }), defaultRunner);
    const submitted = transitionMarketplaceExecution(
      manifest.paths.manifest,
      requestDigest,
      { status: 'submitted', submission: SUBMISSION_RESULT },
      () => new Date('2026-07-20T00:02:00.000Z'),
    );
    const persisted = readFileSync(manifest.paths.manifest, 'utf8');
    expect(existsSync(`${manifest.paths.manifest}${MARKETPLACE_TERMINAL_RECORD_SUFFIX}`)).toBe(true);

    expect(transitionMarketplaceExecution(
      manifest.paths.manifest,
      requestDigest,
      { status: 'submitted', submission: SUBMISSION_RESULT },
      () => new Date('2026-07-20T00:03:00.000Z'),
    )).toEqual(submitted);
    expect(readFileSync(manifest.paths.manifest, 'utf8')).toBe(persisted);
    expect(() => transitionMarketplaceExecution(
      manifest.paths.manifest,
      requestDigest,
      { status: 'submitted', submission: { ...SUBMISSION_RESULT, taskId: 'task-43' } },
    )).toThrow(/contradictory submission/i);
    expect(() => transitionMarketplaceExecution(
      manifest.paths.manifest,
      requestDigest,
      { status: 'cancelled', reason: 'operator-cancelled' },
    )).toThrow(/Only a prepared/i);
    expect(readFileSync(manifest.paths.manifest, 'utf8')).toBe(persisted);
  });

  it('strictly decodes version-2 state fields and the complete SDK submission result', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture), defaultRunner);
    const raw = JSON.parse(readFileSync(manifest.paths.manifest, 'utf8')) as Record<string, unknown>;
    const requestPath = join(fixture.root, 'marketplace-request.json');
    const selectionPath = join(fixture.root, 'solvernet-selection.json');
    const prepared = {
      schemaVersion: 'marketplace-execution-v2',
      status: 'prepared',
      requestPath,
      requestDigest: `sha256:${'a'.repeat(64)}`,
      solverNetSelectionPath: selectionPath,
      preparedAt: '2026-07-20T00:01:00.000Z',
      agentSoftDeadline: '2026-07-20T01:00:00.000Z',
      adoptionDeadline: '2026-07-20T01:30:00.000Z',
    };
    const invalidExecutions = [
      { backend: 'marketplace', state: { ...prepared, requestDigest: 'sha256:short' } },
      { backend: 'marketplace', state: { ...prepared, unexpected: true } },
      {
        backend: 'marketplace',
        state: {
          ...prepared,
          status: 'submitted',
          submission: { ...SUBMISSION_RESULT, unexpected: true },
          submittedAt: '2026-07-20T00:02:00.000Z',
        },
      },
      {
        backend: 'marketplace',
        state: {
          ...prepared,
          status: 'cancelled',
          cancelledAt: 'not-a-timestamp',
          reason: 'operator-cancelled',
        },
      },
    ];

    for (const execution of invalidExecutions) {
      expect(() => decodeAttemptManifest({ ...raw, execution })).toThrow();
    }
  });

  it('rejects terminal marketplace timestamps and transition clocks that predate durable state', async () => {
    const fixture = repositoryFixture();
    const requestDigest = `sha256:${'a'.repeat(64)}`;
    const manifest = await createAttemptWorkspace(options(fixture, {
      now: () => new Date('2026-07-20T00:03:00.000Z'),
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v2',
          status: 'prepared',
          requestPath: join(fixture.root, 'marketplace-request.json'),
          requestDigest,
          solverNetSelectionPath: join(fixture.root, 'solvernet-selection.json'),
          preparedAt: '2026-07-20T00:01:00.000Z',
          agentSoftDeadline: '2026-07-20T01:00:00.000Z',
          adoptionDeadline: '2026-07-20T01:30:00.000Z',
        },
      },
    }), defaultRunner);
    const raw = JSON.parse(readFileSync(manifest.paths.manifest, 'utf8')) as Record<string, unknown>;
    const state = (raw.execution as { state: Record<string, unknown> }).state;
    const submittedBeforePrepared = {
      backend: 'marketplace',
      state: {
        ...state,
        status: 'submitted',
        submission: SUBMISSION_RESULT,
        submittedAt: '2026-07-20T00:00:00.000Z',
      },
    };
    const cancelledBeforePrepared = {
      backend: 'marketplace',
      state: {
        ...state,
        status: 'cancelled',
        cancelledAt: '2026-07-20T00:00:00.000Z',
        reason: 'operator-cancelled',
      },
    };
    const submittedAfterOuterUpdate = {
      backend: 'marketplace',
      state: {
        ...state,
        status: 'submitted',
        submission: SUBMISSION_RESULT,
        submittedAt: '2026-07-20T00:04:00.000Z',
      },
    };
    const cancelledAfterOuterUpdate = {
      backend: 'marketplace',
      state: {
        ...state,
        status: 'cancelled',
        cancelledAt: '2026-07-20T00:04:00.000Z',
        reason: 'operator-cancelled',
      },
    };
    const original = readFileSync(manifest.paths.manifest, 'utf8');

    expect(() => decodeAttemptManifest({ ...raw, execution: submittedBeforePrepared })).toThrow(
      /submitted timestamp.*preparation/i,
    );
    expect(() => decodeAttemptManifest({ ...raw, execution: cancelledBeforePrepared })).toThrow(
      /cancelled timestamp.*preparation/i,
    );
    expect(() => decodeAttemptManifest({ ...raw, execution: submittedAfterOuterUpdate })).toThrow(
      /submitted timestamp.*manifest updated/i,
    );
    expect(() => decodeAttemptManifest({ ...raw, execution: cancelledAfterOuterUpdate })).toThrow(
      /cancelled timestamp.*manifest updated/i,
    );
    expect(() => transitionMarketplaceExecution(
      manifest.paths.manifest,
      requestDigest,
      { status: 'submitted', submission: SUBMISSION_RESULT },
      () => new Date('2026-07-20T00:02:00.000Z'),
    )).toThrow(/transition timestamp.*updated/i);
    expect(readFileSync(manifest.paths.manifest, 'utf8')).toBe(original);
  });

  it('rejects an invalid runtime transition status without rewriting the prepared manifest', async () => {
    const fixture = repositoryFixture();
    const requestDigest = `sha256:${'a'.repeat(64)}`;
    const manifest = await createAttemptWorkspace(options(fixture, {
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v2',
          status: 'prepared',
          requestPath: join(fixture.root, 'marketplace-request.json'),
          requestDigest,
          solverNetSelectionPath: join(fixture.root, 'solvernet-selection.json'),
          preparedAt: '2026-07-20T00:01:00.000Z',
          agentSoftDeadline: '2026-07-20T01:00:00.000Z',
          adoptionDeadline: '2026-07-20T01:30:00.000Z',
        },
      },
    }), defaultRunner);
    const original = readFileSync(manifest.paths.manifest, 'utf8');

    expect(() => transitionMarketplaceExecution(
      manifest.paths.manifest,
      requestDigest,
      { status: 'invalid', reason: 'must-not-cancel' } as unknown as {
        status: 'cancelled'; reason: string;
      },
    )).toThrow(/invalid marketplace execution transition/i);
    expect(readFileSync(manifest.paths.manifest, 'utf8')).toBe(original);
  });

  it('preserves the exact manifest bytes when a cancelled marketplace transition is replayed', async () => {
    const fixture = repositoryFixture();
    const requestDigest = `sha256:${'a'.repeat(64)}`;
    const manifest = await createAttemptWorkspace(options(fixture, {
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v2',
          status: 'prepared',
          requestPath: join(fixture.root, 'marketplace-request.json'),
          requestDigest,
          solverNetSelectionPath: join(fixture.root, 'solvernet-selection.json'),
          preparedAt: '2026-07-20T00:01:00.000Z',
          agentSoftDeadline: '2026-07-20T01:00:00.000Z',
          adoptionDeadline: '2026-07-20T01:30:00.000Z',
        },
      },
    }), defaultRunner);
    const cancelled = transitionMarketplaceExecution(
      manifest.paths.manifest,
      requestDigest,
      { status: 'cancelled', reason: 'operator-cancelled' },
      () => new Date('2026-07-20T00:02:00.000Z'),
    );
    const persisted = readFileSync(manifest.paths.manifest, 'utf8');

    expect(transitionMarketplaceExecution(
      manifest.paths.manifest,
      requestDigest,
      { status: 'cancelled', reason: 'operator-cancelled' },
      () => new Date('2026-07-20T00:03:00.000Z'),
    )).toEqual(cancelled);
    expect(readFileSync(manifest.paths.manifest, 'utf8')).toBe(persisted);
  });

  it.each(['marketplace-execution-v2', 'marketplace-execution-v3'] as const)(
    'uses one durable terminal winner when submitted and cancelled workers race for %s',
    async (schemaVersion) => {
    const fixture = repositoryFixture();
    const requestDigest = `sha256:${'a'.repeat(64)}`;
    const attemptDir = join(
      fixture.base,
      'v2',
      'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'implement',
      `issue-42-${UUID_A}`,
    );
    const manifest = await createAttemptWorkspace(options(fixture, {
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion,
          status: 'prepared',
          requestPath: schemaVersion === 'marketplace-execution-v3'
            ? join(attemptDir, 'marketplace-request.json')
            : join(fixture.root, 'marketplace-request.json'),
          requestDigest,
          solverNetSelectionPath: schemaVersion === 'marketplace-execution-v3'
            ? join(attemptDir, 'solvernet-selection.json')
            : join(fixture.root, 'solvernet-selection.json'),
          preparedAt: schemaVersion === 'marketplace-execution-v3'
            ? NOW
            : '2026-07-20T00:01:00.000Z',
          agentSoftDeadline: '2026-07-20T01:00:00.000Z',
          adoptionDeadline: '2026-07-20T01:30:00.000Z',
        },
      },
    }), defaultRunner);

    const [submitted, cancelled] = await Promise.all([
      transitionInWorker({
        manifestPath: manifest.paths.manifest,
        requestDigest,
        transition: { status: 'submitted', submission: SUBMISSION_RESULT },
      }),
      transitionInWorker({
        manifestPath: manifest.paths.manifest,
        requestDigest,
        transition: { status: 'cancelled', reason: 'operator-cancelled' },
      }),
    ]);

    expect([submitted.result.ok, cancelled.result.ok].filter(Boolean)).toHaveLength(1);
    const terminal = JSON.parse(readFileSync(
      `${manifest.paths.manifest}${MARKETPLACE_TERMINAL_RECORD_SUFFIX}`,
      'utf8',
    )) as Record<string, unknown>;
    const terminalMetadata = lstatSync(
      `${manifest.paths.manifest}${MARKETPLACE_TERMINAL_RECORD_SUFFIX}`,
    );
    const current = readAttemptManifest(manifest.paths.manifest);
    expect(terminalMetadata.isFile()).toBe(true);
    expect(terminalMetadata.isSymbolicLink()).toBe(false);
    expect(terminalMetadata.mode & 0o777).toBe(0o600);
    expect(current.execution).toMatchObject({
      backend: 'marketplace',
      state: { status: terminal.status },
    });
    expect((current.execution as { state: Record<string, unknown> }).state.requestDigest)
      .toBe(terminal.requestDigest);
    },
  );

  it('repairs a prepared manifest from committed terminal evidence after a crash before rename', async () => {
    const fixture = repositoryFixture();
    const requestDigest = `sha256:${'a'.repeat(64)}`;
    const manifest = await createAttemptWorkspace(options(fixture, {
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v2',
          status: 'prepared',
          requestPath: join(fixture.root, 'marketplace-request.json'),
          requestDigest,
          solverNetSelectionPath: join(fixture.root, 'solvernet-selection.json'),
          preparedAt: '2026-07-20T00:01:00.000Z',
          agentSoftDeadline: '2026-07-20T01:00:00.000Z',
          adoptionDeadline: '2026-07-20T01:30:00.000Z',
        },
      },
    }), defaultRunner);
    writeFileSync(
      `${manifest.paths.manifest}${MARKETPLACE_TERMINAL_RECORD_SUFFIX}`,
      JSON.stringify({
        schemaVersion: 'marketplace-terminal-v1',
        requestDigest,
        status: 'submitted',
        submission: SUBMISSION_RESULT,
        submittedAt: '2026-07-20T00:02:00.000Z',
      }),
      { mode: 0o600 },
    );

    const repaired = transitionMarketplaceExecution(
      manifest.paths.manifest,
      requestDigest,
      { status: 'submitted', submission: SUBMISSION_RESULT },
      () => new Date('2026-07-20T00:03:00.000Z'),
    );

    expect(repaired.execution).toMatchObject({
      backend: 'marketplace',
      state: {
        status: 'submitted',
        submittedAt: '2026-07-20T00:02:00.000Z',
      },
    });
    expect(repaired.timestamps.updatedAt).toBe('2026-07-20T00:02:00.000Z');
  });

  it('keeps a newer manifest update timestamp while repairing committed terminal evidence', async () => {
    const fixture = repositoryFixture();
    const requestDigest = `sha256:${'a'.repeat(64)}`;
    const manifest = await createAttemptWorkspace(options(fixture, {
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v2',
          status: 'prepared',
          requestPath: join(fixture.root, 'marketplace-request.json'),
          requestDigest,
          solverNetSelectionPath: join(fixture.root, 'solvernet-selection.json'),
          preparedAt: '2026-07-20T00:01:00.000Z',
          agentSoftDeadline: '2026-07-20T01:00:00.000Z',
          adoptionDeadline: '2026-07-20T01:30:00.000Z',
        },
      },
    }), defaultRunner);
    writeFileSync(
      `${manifest.paths.manifest}${MARKETPLACE_TERMINAL_RECORD_SUFFIX}`,
      JSON.stringify({
        schemaVersion: 'marketplace-terminal-v1',
        requestDigest,
        status: 'submitted',
        submission: SUBMISSION_RESULT,
        submittedAt: '2026-07-20T00:02:00.000Z',
      }),
      { mode: 0o600 },
    );
    const raw = JSON.parse(readFileSync(manifest.paths.manifest, 'utf8')) as Record<string, unknown>;
    writeFileSync(manifest.paths.manifest, JSON.stringify({
      ...raw,
      timestamps: { ...(raw.timestamps as Record<string, unknown>), updatedAt: '2026-07-20T00:03:00.000Z' },
    }));

    const repaired = transitionMarketplaceExecution(
      manifest.paths.manifest,
      requestDigest,
      { status: 'submitted', submission: SUBMISSION_RESULT },
      () => new Date('2026-07-20T00:04:00.000Z'),
    );

    expect((repaired.execution as { state: Record<string, unknown> }).state.submittedAt)
      .toBe('2026-07-20T00:02:00.000Z');
    expect(repaired.timestamps.updatedAt).toBe('2026-07-20T00:03:00.000Z');
  });

  it('accepts an equivalent SDK submit replay but persists the terminal winner wrapper', async () => {
    const fixture = repositoryFixture();
    const requestDigest = `sha256:${'a'.repeat(64)}`;
    const manifest = await createAttemptWorkspace(options(fixture, {
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v2',
          status: 'prepared',
          requestPath: join(fixture.root, 'marketplace-request.json'),
          requestDigest,
          solverNetSelectionPath: join(fixture.root, 'solvernet-selection.json'),
          preparedAt: '2026-07-20T00:01:00.000Z',
          agentSoftDeadline: '2026-07-20T01:00:00.000Z',
          adoptionDeadline: '2026-07-20T01:30:00.000Z',
        },
      },
    }), defaultRunner);
    const winner = {
      ...SUBMISSION_RESULT,
      attemptId: 'solver-attempt-42',
      attemptNumber: 7,
    };
    const replay = {
      ...winner,
      generatedAt: '2026-07-20T00:03:00.000Z',
      status: 'already_submitted',
      idempotent: true,
    } as const;

    const submitted = transitionMarketplaceExecution(
      manifest.paths.manifest,
      requestDigest,
      { status: 'submitted', submission: winner },
      () => new Date('2026-07-20T00:02:00.000Z'),
    );
    const raw = JSON.parse(readFileSync(manifest.paths.manifest, 'utf8')) as Record<string, unknown>;
    const execution = raw.execution as { readonly state: Record<string, unknown> };
    writeFileSync(manifest.paths.manifest, JSON.stringify({
      ...raw,
      execution: {
        backend: 'marketplace',
        state: { ...execution.state, submission: replay },
      },
    }));
    const replayed = transitionMarketplaceExecution(
      manifest.paths.manifest,
      requestDigest,
      { status: 'submitted', submission: replay },
      () => new Date('2026-07-20T00:04:00.000Z'),
    );

    expect(replayed).toEqual(submitted);
    expect((replayed.execution as { state: Record<string, unknown> }).state.submission)
      .toEqual(winner);
    expect(() => transitionMarketplaceExecution(
      manifest.paths.manifest,
      requestDigest,
      { status: 'submitted', submission: { ...replay, taskId: 'task-43' } },
    )).toThrow(/contradictory submission/i);
  });

  it('fails closed without rewriting when terminal evidence is malformed or bound to another digest', async () => {
    const fixture = repositoryFixture();
    const requestDigest = `sha256:${'a'.repeat(64)}`;
    const malformed = await createAttemptWorkspace(options(fixture, {
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v2',
          status: 'prepared',
          requestPath: join(fixture.root, 'marketplace-request.json'),
          requestDigest,
          solverNetSelectionPath: join(fixture.root, 'solvernet-selection.json'),
          preparedAt: '2026-07-20T00:01:00.000Z',
          agentSoftDeadline: '2026-07-20T01:00:00.000Z',
          adoptionDeadline: '2026-07-20T01:30:00.000Z',
        },
      },
    }), defaultRunner);
    const malformedOriginal = readFileSync(malformed.paths.manifest, 'utf8');
    writeFileSync(
      `${malformed.paths.manifest}${MARKETPLACE_TERMINAL_RECORD_SUFFIX}`,
      '{bad json',
      { mode: 0o600 },
    );
    expect(() => transitionMarketplaceExecution(
      malformed.paths.manifest,
      requestDigest,
      { status: 'submitted', submission: SUBMISSION_RESULT },
    )).toThrow(/terminal evidence/i);
    expect(readFileSync(malformed.paths.manifest, 'utf8')).toBe(malformedOriginal);

    const mismatched = await createAttemptWorkspace(options(fixture, {
      attemptId: UUID_B,
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v2',
          status: 'prepared',
          requestPath: join(fixture.root, 'marketplace-request.json'),
          requestDigest,
          solverNetSelectionPath: join(fixture.root, 'solvernet-selection.json'),
          preparedAt: '2026-07-20T00:01:00.000Z',
          agentSoftDeadline: '2026-07-20T01:00:00.000Z',
          adoptionDeadline: '2026-07-20T01:30:00.000Z',
        },
      },
    }), defaultRunner);
    const mismatchedOriginal = readFileSync(mismatched.paths.manifest, 'utf8');
    writeFileSync(
      `${mismatched.paths.manifest}${MARKETPLACE_TERMINAL_RECORD_SUFFIX}`,
      JSON.stringify({
        schemaVersion: 'marketplace-terminal-v1',
        requestDigest: `sha256:${'b'.repeat(64)}`,
        status: 'cancelled',
        reason: 'operator-cancelled',
        cancelledAt: '2026-07-20T00:02:00.000Z',
      }),
      { mode: 0o600 },
    );
    expect(() => transitionMarketplaceExecution(
      mismatched.paths.manifest,
      requestDigest,
      { status: 'submitted', submission: SUBMISSION_RESULT },
    )).toThrow(/terminal evidence.*digest/i);
    expect(readFileSync(mismatched.paths.manifest, 'utf8')).toBe(mismatchedOriginal);
  });

  it.each(['permissive-mode', 'symlink'] as const)(
    'rejects %s terminal evidence without rewriting the prepared manifest',
    async (kind) => {
      const fixture = repositoryFixture();
      const requestDigest = `sha256:${'a'.repeat(64)}`;
      const manifest = await createAttemptWorkspace(options(fixture, {
        execution: {
          backend: 'marketplace',
          state: {
            schemaVersion: 'marketplace-execution-v2',
            status: 'prepared',
            requestPath: join(fixture.root, 'marketplace-request.json'),
            requestDigest,
            solverNetSelectionPath: join(fixture.root, 'solvernet-selection.json'),
            preparedAt: '2026-07-20T00:01:00.000Z',
            agentSoftDeadline: '2026-07-20T01:00:00.000Z',
            adoptionDeadline: '2026-07-20T01:30:00.000Z',
          },
        },
      }), defaultRunner);
      const preparedBytes = readFileSync(manifest.paths.manifest);
      transitionMarketplaceExecution(
        manifest.paths.manifest,
        requestDigest,
        { status: 'cancelled', reason: 'operator-cancelled' },
        () => new Date('2026-07-20T00:02:00.000Z'),
      );
      writeFileSync(manifest.paths.manifest, preparedBytes);
      const terminalPath =
        `${manifest.paths.manifest}${MARKETPLACE_TERMINAL_RECORD_SUFFIX}`;
      if (kind === 'permissive-mode') {
        chmodSync(terminalPath, 0o644);
      } else {
        const targetPath = `${terminalPath}.target`;
        renameSync(terminalPath, targetPath);
        symlinkSync(targetPath, terminalPath);
      }

      expect(() => transitionMarketplaceExecution(
        manifest.paths.manifest,
        requestDigest,
        { status: 'cancelled', reason: 'operator-cancelled' },
      )).toThrow(/terminal evidence/i);
      expect(readFileSync(manifest.paths.manifest)).toEqual(preparedBytes);
    },
  );

  it('reserves every generic manifest writer for local and legacy marketplace attempts', async () => {
    const requestDigest = `sha256:${'a'.repeat(64)}`;
    const marketplaceExecution = (fixture: ReturnType<typeof repositoryFixture>) => ({
      backend: 'marketplace' as const,
      state: {
        schemaVersion: 'marketplace-execution-v2' as const,
        status: 'prepared' as const,
        requestPath: join(fixture.root, 'marketplace-request.json'),
        requestDigest,
        solverNetSelectionPath: join(fixture.root, 'solvernet-selection.json'),
        preparedAt: '2026-07-20T00:01:00.000Z',
        agentSoftDeadline: '2026-07-20T01:00:00.000Z',
        adoptionDeadline: '2026-07-20T01:30:00.000Z',
      },
    });
    const writers: Array<readonly [
      string,
      Partial<CreateAttemptOptions>,
      (manifest: AttemptManifest) => unknown,
    ]> = [
      ['updateAttemptManifest', {
        attemptId: '44444444-4444-4444-8444-444444444444',
      }, (manifest) => updateAttemptManifest(
        manifest.paths.manifest,
        (current) => current,
      )],
      ['markAttemptRunning', {
        attemptId: '55555555-5555-4555-8555-555555555555',
      }, (manifest) => markAttemptRunning(manifest.paths.manifest, 4242)],
      ['markAttemptExited', {
        attemptId: '66666666-6666-4666-8666-666666666666',
      }, (manifest) => markAttemptExited(manifest.paths.manifest)],
      ['advanceAttemptExpectedHead', {
        attemptId: '77777777-7777-4777-8777-777777777777',
      }, (manifest) => advanceAttemptExpectedHead(
        manifest.paths.manifest,
        manifest.expectedHead,
        'a'.repeat(40),
      )],
      ['advanceAttemptReviewPair', {
        attemptId: '88888888-8888-4888-8888-888888888888',
        phase: 'review',
        subject: 'pr-7',
        prNumber: 7,
        reviewGeneration: UUID_C,
        reviewRefOid: 'b'.repeat(40),
        reviewApprovalPolicy: 'approve-eligible',
      }, (manifest) => advanceAttemptReviewPair(
        manifest.paths.manifest,
        manifest.expectedHead,
        manifest.reviewRefOid!,
        'c'.repeat(40),
        'd'.repeat(40),
      )],
    ];

    // One repository fixture serves every writer: each case carries its own
    // attemptId, so `createAttemptWorkspace` places it under a distinct
    // `<base>/v2/<runnerId>/<phase>/<subject>-<attemptId>` directory
    // (src/lifecycle/attempt-workspace.ts:2493-2503) and therefore its own
    // manifest.json. The reservation the loop asserts is decided solely by the
    // manifest bytes at that path (src/lifecycle/attempt-workspace.ts:797-804),
    // so no case can observe or be rescued by another's state. The distinct-path
    // assertion below fails loudly if a future edit reuses an attemptId.
    const loopFixture = repositoryFixture();
    const loopManifests = new Set<string>();
    for (const [index, [name, overrides, writer]] of writers.entries()) {
      const manifest = await createAttemptWorkspace(options(loopFixture, {
        ...overrides,
        ...(name === 'advanceAttemptReviewPair' ? { reviewRefOid: loopFixture.oid } : {}),
        execution: marketplaceExecution(loopFixture),
      }), defaultRunner);
      expect(loopManifests.add(manifest.paths.manifest).size, `${name} must own a manifest`)
        .toBe(index + 1);
      const original = readFileSync(manifest.paths.manifest, 'utf8');
      let error: unknown;
      try {
        writer(manifest);
      } catch (caught) {
        error = caught;
      }
      expect.soft(String(error), `${name} must direct v2 marketplace callers`).toMatch(
        /marketplace execution v2 must use dedicated marketplace transition APIs/i,
      );
      expect.soft(readFileSync(manifest.paths.manifest, 'utf8'), `${name} must not rewrite`)
        .toBe(original);
    }

    const localFixture = repositoryFixture();
    const local = await createAttemptWorkspace(options(localFixture), defaultRunner);
    expect(updateAttemptManifest(local.paths.manifest, (current) => current)).toEqual(local);
    expect(markAttemptRunning(local.paths.manifest, 4242).processState).toBe('running');
    expect(markAttemptExited(local.paths.manifest).processState).toBe('exited');

    const localHead = await createAttemptWorkspace(options(localFixture, { attemptId: UUID_B }), defaultRunner);
    expect(advanceAttemptExpectedHead(
      localHead.paths.manifest,
      localHead.expectedHead,
      'a'.repeat(40),
    ).expectedHead).toBe('a'.repeat(40));

    const localReview = await createAttemptWorkspace(options(localFixture, {
      attemptId: UUID_C,
      phase: 'review',
      subject: 'pr-7',
      prNumber: 7,
      reviewGeneration: UUID_C,
      reviewRefOid: localFixture.oid,
      reviewApprovalPolicy: 'approve-eligible',
    }), defaultRunner);
    expect(advanceAttemptReviewPair(
      localReview.paths.manifest,
      localReview.expectedHead,
      localReview.reviewRefOid!,
      'b'.repeat(40),
      'c'.repeat(40),
    ).expectedHead).toBe('b'.repeat(40));

    const legacyFixture = repositoryFixture();
    const legacy = await createAttemptWorkspace(options(legacyFixture, {
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v1',
          status: 'unsubmitted',
          requestPath: join(legacyFixture.root, 'legacy-marketplace-request.json'),
        },
      },
    }), defaultRunner);
    expect(markAttemptRunning(legacy.paths.manifest, 4242).processState).toBe('running');
  });

  it('converges concurrent same-outcome marketplace transition writers on the durable winner', async () => {
    const fixture = repositoryFixture();
    const requestDigest = `sha256:${'a'.repeat(64)}`;
    const manifest = await createAttemptWorkspace(options(fixture, {
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v2',
          status: 'prepared',
          requestPath: join(fixture.root, 'marketplace-request.json'),
          requestDigest,
          solverNetSelectionPath: join(fixture.root, 'solvernet-selection.json'),
          preparedAt: '2026-07-20T00:01:00.000Z',
          agentSoftDeadline: '2026-07-20T01:00:00.000Z',
          adoptionDeadline: '2026-07-20T01:30:00.000Z',
        },
      },
    }), defaultRunner);

    const results = await Promise.all([
      transitionInWorker({
        manifestPath: manifest.paths.manifest,
        requestDigest,
        transition: { status: 'submitted', submission: SUBMISSION_RESULT },
      }),
      transitionInWorker({
        manifestPath: manifest.paths.manifest,
        requestDigest,
        transition: { status: 'submitted', submission: SUBMISSION_RESULT },
      }),
    ]);

    expect(results.map(({ result }) => result.ok)).toEqual([true, true]);
    const winner = JSON.parse(readFileSync(
      `${manifest.paths.manifest}${MARKETPLACE_TERMINAL_RECORD_SUFFIX}`,
      'utf8',
    )) as { readonly submission: unknown };
    expect((readAttemptManifest(manifest.paths.manifest).execution as {
      readonly state: { readonly submission: unknown };
    }).state.submission).toEqual(winner.submission);
  });

  it('rejects malformed execution discriminants and marketplace state records', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture), defaultRunner);
    const raw = JSON.parse(readFileSync(manifest.paths.manifest, 'utf8')) as Record<string, unknown>;
    const requestPath = join(fixture.root, 'marketplace-request.json');
    const invalidExecutions = [
      { backend: 'local', state: {} },
      { backend: 'marketplace' },
      { backend: 'remote', state: {} },
      {
        backend: 'marketplace',
        unexpected: true,
        state: { schemaVersion: 'marketplace-execution-v1', status: 'unsubmitted', requestPath },
      },
      {
        backend: 'marketplace',
        state: { schemaVersion: 'marketplace-execution-v2', status: 'unsubmitted', requestPath },
      },
      {
        backend: 'marketplace',
        state: { schemaVersion: 'marketplace-execution-v1', status: 'accepted', requestPath },
      },
      {
        backend: 'marketplace',
        state: { schemaVersion: 'marketplace-execution-v1', status: 'unsubmitted', requestPath: 'relative.json' },
      },
      {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v1',
          status: 'unsubmitted',
          requestPath,
          unexpected: true,
        },
      },
      {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v1',
          status: 'submitted',
          requestPath,
          taskCid: 'cid',
          submittedAt: '2026-07-20T00:01:00.000Z',
        },
      },
      {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v1',
          status: 'submitted',
          requestPath,
          taskId: '',
          taskCid: 'cid',
          submittedAt: '2026-07-20T00:01:00.000Z',
        },
      },
      {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v1',
          status: 'submitted',
          requestPath,
          taskId: 'task-42',
          taskCid: '',
          submittedAt: '2026-07-20T00:01:00.000Z',
        },
      },
      {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v1',
          status: 'submitted',
          requestPath,
          taskId: 'task-42',
          taskCid: 'cid',
          submittedAt: 'not-a-timestamp',
        },
      },
    ];

    for (const execution of invalidExecutions) {
      expect(() => decodeAttemptManifest({ ...raw, execution })).toThrow();
    }
  });

  it('rejects execution backend and marketplace-state changes through atomic updates', async () => {
    const fixture = repositoryFixture();
    const requestPath = join(fixture.root, 'marketplace-request.json');
    const manifest = await createAttemptWorkspace(options(fixture, {
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v1',
          status: 'unsubmitted',
          requestPath,
        },
      },
    }), defaultRunner);
    const original = readFileSync(manifest.paths.manifest, 'utf8');
    const mutations = [
      (current: AttemptManifest) => ({ ...current, execution: { backend: 'local' } }),
      (current: AttemptManifest) => ({
        ...current,
        execution: {
          backend: 'marketplace',
          state: {
            schemaVersion: 'marketplace-execution-v1',
            status: 'submitted',
            requestPath,
            taskId: 'task-42',
            taskCid: 'bafybeigdyrzt5m6u2r3o4exampletaskcid',
            submittedAt: '2026-07-20T00:01:00.000Z',
          },
        },
      }),
    ];

    for (const mutate of mutations) {
      expect(() => updateAttemptManifest(manifest.paths.manifest, mutate)).toThrow(
        /static attempt fields/,
      );
      expect(readFileSync(manifest.paths.manifest, 'utf8')).toBe(original);
    }

    const local = await createAttemptWorkspace(options(fixture, { attemptId: UUID_B }), defaultRunner);
    expect(() => updateAttemptManifest(local.paths.manifest, (current) => ({
      ...current,
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v1',
          status: 'unsubmitted',
          requestPath,
        },
      },
    }))).toThrow(/static attempt fields/);
    expect(readAttemptManifest(local.paths.manifest).execution).toEqual({ backend: 'local' });
  });

  it('locks every static manifest authority, identity, and path field across updates', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture, {
      phase: 'review',
      subject: 'pr-7',
      prNumber: 7,
      reviewGeneration: UUID_C,
      reviewRefOid: fixture.oid,
      reviewApprovalPolicy: 'approve-eligible',
    }), defaultRunner);
    const original = readFileSync(manifest.paths.manifest, 'utf8');
    const otherOid = 'a'.repeat(40);
    const mutations: Array<readonly [
      string,
      (current: AttemptManifest) => AttemptManifest,
    ]> = [
      ['version', (current) => ({ ...current, version: 3 as 2 })],
      ['attempt ID', (current) => ({ ...current, attemptId: UUID_B })],
      ['runner ID', (current) => ({ ...current, runnerId: 'other-runner' })],
      ['host', (current) => ({ ...current, host: 'other-host' })],
      ['phase', (current) => {
        const {
          reviewGeneration: _reviewGeneration,
          reviewRefOid: _reviewRefOid,
          reviewApprovalPolicy: _reviewApprovalPolicy,
          ...withoutReview
        } = current;
        return { ...withoutReview, phase: 'merge-prep' };
      }],
      ['subject and PR identity', (current) => ({
        ...current,
        subject: 'pr-8',
        prNumber: 8,
      })],
      ['issue identity', (current) => ({ ...current, issueNumber: 43 })],
      ['selected login', (current) => ({ ...current, selectedLogin: 'other-bot' })],
      ['branch', (current) => ({ ...current, branch: 'feature/other' })],
      ['in-place branch mutation', (current) => {
        (current as { branch: string }).branch = 'feature/in-place';
        return current;
      }],
      ['target base', (current) => ({ ...current, targetBase: 'next' })],
      ['expected head', (current) => ({ ...current, expectedHead: otherOid })],
      ['claim OID', (current) => ({ ...current, claimOid: otherOid })],
      ['review authority', (current) => ({
        ...current,
        reviewGeneration: UUID_B,
        reviewRefOid: otherOid,
      })],
      ['repository root', (current) => ({
        ...current,
        repository: { ...current.repository, root: join(fixture.root, 'other-root') },
      })],
      ['Git common directory', (current) => ({
        ...current,
        repository: {
          ...current.repository,
          gitCommonDir: join(fixture.root, 'other-common-dir'),
        },
      })],
      ['remote identity', (current) => ({
        ...current,
        repository: {
          ...current.repository,
          remoteName: 'upstream',
          remoteUrlHash: 'b'.repeat(64),
        },
      })],
      ['exact paths', (current) => ({
        ...current,
        paths: {
          ...current.paths,
          log: join(current.paths.attemptDir, 'other.log'),
        },
      })],
      ['creation timestamp', (current) => ({
        ...current,
        timestamps: {
          ...current.timestamps,
          createdAt: '2026-07-19T23:59:00.000Z',
        },
      })],
    ];

    for (const [name, mutate] of mutations) {
      let error: unknown;
      try {
        updateAttemptManifest(manifest.paths.manifest, mutate);
      } catch (caught) {
        error = caught;
      }
      expect.soft(error, `${name} must be rejected`).toBeInstanceOf(Error);
      expect.soft(
        readFileSync(manifest.paths.manifest, 'utf8'),
        `${name} must be rejected before writing`,
      ).toBe(original);
      writeFileSync(manifest.paths.manifest, original);
    }
  });

  it('advances review head and ref together through one exact manifest CAS', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture, {
      phase: 'review',
      subject: 'pr-7',
      prNumber: 7,
      reviewGeneration: UUID_C,
      reviewRefOid: fixture.oid,
      reviewApprovalPolicy: 'approve-eligible',
    }), defaultRunner);
    const nextHead = 'a'.repeat(40);
    const nextReview = 'b'.repeat(40);

    const advanced = advanceAttemptReviewPair(
      manifest.paths.manifest,
      manifest.expectedHead,
      manifest.reviewRefOid!,
      nextHead,
      nextReview,
      () => new Date('2026-07-20T00:01:00.000Z'),
    );

    expect(advanced).toMatchObject({
      expectedHead: nextHead,
      reviewRefOid: nextReview,
      reviewGeneration: UUID_C,
      reviewApprovalPolicy: 'approve-eligible',
    });
    expect(() => advanceAttemptReviewPair(
      manifest.paths.manifest,
      manifest.expectedHead,
      manifest.reviewRefOid!,
      'c'.repeat(40),
      'd'.repeat(40),
    )).toThrow(/authority pair changed/i);
    expect(readAttemptManifest(manifest.paths.manifest)).toMatchObject({
      expectedHead: nextHead,
      reviewRefOid: nextReview,
    });
  });

  it('advances only the progressive expected head through an exact manifest CAS', async () => {
    const fixture = repositoryFixture();
    const current = await createAttemptWorkspace(options(fixture), defaultRunner);
    const nextHead = 'a'.repeat(40);

    const advanced = advanceAttemptExpectedHead(
      current.paths.manifest,
      current.expectedHead,
      nextHead,
      () => new Date('2026-07-20T00:05:00.000Z'),
    );

    expect(advanced.expectedHead).toBe(nextHead);
    expect(advanced.claimOid).toBe(current.claimOid);
    expect(advanced.paths).toEqual(current.paths);
    expect(advanced.timestamps.updatedAt).toBe('2026-07-20T00:05:00.000Z');
    expect(() => advanceAttemptExpectedHead(
      current.paths.manifest,
      current.expectedHead,
      'b'.repeat(40),
    )).toThrow(/expected head changed/i);
    expect(readAttemptManifest(current.paths.manifest).expectedHead).toBe(nextHead);
  });

  it('rejects in-place nested static repository and path mutations', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture), defaultRunner);
    const original = readFileSync(manifest.paths.manifest, 'utf8');
    const mutations: Array<readonly [
      string,
      (current: AttemptManifest) => AttemptManifest,
    ]> = [
      ['repository root', (current) => {
        (current.repository as { root: string }).root = join(fixture.root, 'other-root');
        return current;
      }],
      ['Git common directory', (current) => {
        (current.repository as { gitCommonDir: string }).gitCommonDir = join(
          fixture.root,
          'other-common-dir',
        );
        return current;
      }],
      ['remote URL hash', (current) => {
        (current.repository as { remoteUrlHash: string }).remoteUrlHash = 'b'.repeat(64);
        return current;
      }],
      ['worktree path', (current) => {
        (current.paths as { worktree: string }).worktree = join(fixture.root, 'other-worktree');
        return current;
      }],
      ['log path', (current) => {
        (current.paths as { log: string }).log = join(fixture.root, 'other.log');
        return current;
      }],
      ['manifest path', (current) => {
        (current.paths as { manifest: string }).manifest = join(fixture.root, 'other-manifest.json');
        return current;
      }],
    ];

    for (const [name, mutate] of mutations) {
      expect(() => updateAttemptManifest(manifest.paths.manifest, mutate), name).toThrow(
        /static attempt fields/,
      );
      expect(readFileSync(manifest.paths.manifest, 'utf8')).toBe(original);
    }
  });

  function setManifestProcessState(
    manifestPath: string,
    processState: 'running' | 'exited',
    pid: number | null,
  ): void {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const existing = raw.timestamps as Record<string, unknown>;
    const timestamps = {
      ...existing,
      updatedAt: NOW,
      childStartedAt: existing.childStartedAt ?? NOW,
      ...(processState === 'exited' ? { childExitedAt: NOW } : {}),
    };
    if (processState === 'running') {
      delete timestamps.childExitedAt;
    }
    raw.processState = processState;
    raw.pid = pid;
    raw.timestamps = timestamps;
    writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
  }

  it('counts only this runner’s live manifests for local capacity', async () => {
    const fixture = repositoryFixture();
    const one = await createAttemptWorkspace(options(fixture, {
      pid: 100,
    }), defaultRunner);
    await createAttemptWorkspace(options(fixture, {
      runnerId: 'other-200-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      attemptId: UUID_B,
      pid: 200,
    }), defaultRunner);
    await createAttemptWorkspace(options(fixture, {
      attemptId: UUID_C,
    }), defaultRunner);

    expect(countRunnerLiveAttempts(
      join(fixture.base, 'v2'),
      one.runnerId,
      (pid) => pid === 100 || pid === 200,
    )).toBe(2);
    expect(listRunnerLiveAttempts(
      join(fixture.base, 'v2'),
      one.runnerId,
      (pid) => pid === 100 || pid === 200,
    ).map((attempt) => attempt.attemptId).sort()).toEqual([UUID_A, UUID_C]);
  });

  it('counts prepared and submitted marketplace attempts without a live local PID but excludes cancelled ones', async () => {
    const fixture = repositoryFixture();
    const runnerId = 'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const requestDigest = `sha256:${'a'.repeat(64)}`;
    const common = {
      schemaVersion: 'marketplace-execution-v2' as const,
      requestPath: join(fixture.root, 'marketplace-request.json'),
      requestDigest,
      solverNetSelectionPath: join(fixture.root, 'solvernet-selection.json'),
      preparedAt: '2026-07-20T00:01:00.000Z',
      agentSoftDeadline: '2026-07-20T01:00:00.000Z',
      adoptionDeadline: '2026-07-20T01:30:00.000Z',
    };
    await createAttemptWorkspace(options(fixture, {
      execution: { backend: 'marketplace', state: { ...common, status: 'prepared' } },
    }), defaultRunner);
    await createAttemptWorkspace(options(fixture, {
      attemptId: UUID_B,
      pid: 200,
      now: () => new Date('2026-07-20T00:02:00.000Z'),
      execution: {
        backend: 'marketplace',
        state: {
          ...common,
          status: 'submitted',
          submission: SUBMISSION_RESULT,
          submittedAt: '2026-07-20T00:02:00.000Z',
        },
      },
    }), defaultRunner);
    await createAttemptWorkspace(options(fixture, {
      attemptId: UUID_C,
      pid: 300,
      now: () => new Date('2026-07-20T00:02:00.000Z'),
      execution: {
        backend: 'marketplace',
        state: {
          ...common,
          status: 'cancelled',
          cancelledAt: '2026-07-20T00:02:00.000Z',
          reason: 'operator-cancelled',
        },
      },
    }), defaultRunner);

    expect(listRunnerLiveAttempts(
      join(fixture.base, 'v2'),
      runnerId,
      (pid) => pid === 300,
    ).map((attempt) => attempt.attemptId).sort()).toEqual([UUID_A, UUID_B]);
  });

  it('counts anchored evaluator legs only while their process is running', async () => {
    const fixture = repositoryFixture();
    const runnerId = 'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const requestDigest = `sha256:${'a'.repeat(64)}`;
    const common = {
      schemaVersion: 'marketplace-execution-v2' as const,
      requestPath: join(fixture.root, 'evaluator-request.json'),
      requestDigest,
      solverNetSelectionPath: join(fixture.root, 'evaluator-solvernet.json'),
      preparedAt: NOW,
      agentSoftDeadline: '2026-07-20T01:00:00.000Z',
      adoptionDeadline: '2026-07-20T01:30:00.000Z',
    };
    const origin = await createAttemptWorkspace(options(fixture, {
      execution: { backend: 'marketplace', state: { ...common, status: 'cancelled', cancelledAt: NOW, reason: 'test' } },
    }), defaultRunner);
    const review = await createAttemptWorkspace(options(fixture, {
      phase: 'review',
      subject: 'pr-84',
      prNumber: 84,
      branch: 'autopilot/42',
      reviewGeneration: UUID_C,
      reviewRefOid: fixture.oid,
      reviewApprovalPolicy: 'approve-eligible',
      selectedLogin: 'review-bot',
      credential: new SelectedCredential('review-bot', 'review', 'review-secret'),
      attemptId: UUID_B,
      execution: { backend: 'marketplace', state: { ...common, status: 'prepared' } },
    }), defaultRunner);
    const identity = {
      originManifestPath: origin.paths.manifest,
      originV2AttemptId: UUID_A,
      originRequestDigest: requestDigest,
      taskId: '501',
      taskCid: 'bafybeigdyrzt5m6u2r3o4exampletaskcid',
      taskCreationBlock: 501,
      prNumber: 84,
      expectedHead: fixture.oid,
      generation: UUID_C,
      reviewRefOid: fixture.oid,
      reviewer: 'review-bot',
    };
    installMarketplaceEvaluatorLeg(
      review.paths.manifest,
      identity,
      () => new Date(NOW),
    );
    setManifestProcessState(review.paths.manifest, 'running', 500);
    expect(listRunnerLiveAttempts(
      join(fixture.base, 'v2'),
      runnerId,
      (pid) => pid === 500,
    ).map((attempt) => attempt.attemptId)).toEqual([UUID_B]);
    setManifestProcessState(review.paths.manifest, 'exited', 500);
    expect(listRunnerLiveAttempts(
      join(fixture.base, 'v2'),
      runnerId,
      () => true,
    ).map((attempt) => attempt.attemptId)).toEqual([]);
    transitionMarketplaceEvaluatorLeg(
      review.paths.manifest,
      identity,
      { status: 'released', releaseReason: 'receipt-published' },
      () => new Date('2026-07-20T00:03:00.000Z'),
    );
    setManifestProcessState(review.paths.manifest, 'running', 501);
    expect(listRunnerLiveAttempts(
      join(fixture.base, 'v2'),
      runnerId,
      (pid) => pid === 501,
    ).map((attempt) => attempt.attemptId)).toEqual([]);
  });

  it('counts mid-adoption marketplace v3 attempts while their process is running', async () => {
    const fixture = repositoryFixture();
    const runnerId = 'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const requestDigest = `sha256:${'a'.repeat(64)}`;
    const attemptDir = join(
      fixture.base,
      'v2',
      runnerId,
      'implement',
      `issue-42-${UUID_A}`,
    );
    const submission = {
      ...SUBMISSION_RESULT,
      generatedAt: NOW,
      id: `autopilot:${UUID_A}`,
      taskId: '501',
    };
    const manifest = await createAttemptWorkspace(options(fixture, {
      prNumber: 84,
      branch: 'autopilot/42',
      targetBaseOid: fixture.oid,
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v3',
          status: 'submitted',
          requestPath: join(attemptDir, 'marketplace-request.json'),
          requestDigest,
          solverNetSelectionPath: join(attemptDir, 'solvernet-selection.json'),
          preparedAt: NOW,
          agentSoftDeadline: '2026-07-20T01:00:00.000Z',
          adoptionDeadline: '2026-07-20T01:30:00.000Z',
          submission,
          submittedAt: NOW,
        },
      },
    }), defaultRunner);
    const delivery = {
      observationPath: join(attemptDir, 'delivery.json'),
      observationDigest: `sha256:${'b'.repeat(64)}`,
      taskId: '501',
      taskCid: submission.taskCid,
      taskCreationTransaction: submission.creationTx,
      taskCreationBlock: submission.creationBlock,
      solverNetManifestCid: submission.solverNetManifestCid,
      attemptIndex: 0,
      requestId: `0x${'c'.repeat(64)}`,
      deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid',
      deliveryEnvelopeDigest: `sha256:${'d'.repeat(64)}`,
      deliveryTransaction: `0x${'e'.repeat(64)}`,
      deliveryBlock: submission.creationBlock + 1,
      solverSafe: `0x${'1'.repeat(40)}`,
      solverAgentEoa: `0x${'2'.repeat(40)}`,
      signer: `0x${'2'.repeat(40)}`,
      publisherAgentId: '501',
      correlation: {
        taskId: '501',
        attemptIndex: 0,
        requestId: `0x${'c'.repeat(64)}`,
        deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid',
        v2AttemptId: UUID_A,
        claimOid: fixture.oid,
        prNumber: 84,
        expectedHead: fixture.oid,
      },
      observedAt: NOW,
    };
    transitionMarketplaceAdoption(
      manifest.paths.manifest,
      requestDigest,
      { status: 'solution-observed', delivery },
      () => new Date(NOW),
    );
    expect(listRunnerLiveAttempts(
      join(fixture.base, 'v2'),
      runnerId,
      () => true,
    ).map((attempt) => attempt.attemptId)).toEqual([]);
    setManifestProcessState(manifest.paths.manifest, 'running', 600);
    expect(listRunnerLiveAttempts(
      join(fixture.base, 'v2'),
      runnerId,
      (pid) => pid === 600,
    ).map((attempt) => attempt.attemptId)).toEqual([UUID_A]);
    setManifestProcessState(manifest.paths.manifest, 'exited', 600);
    expect(listRunnerLiveAttempts(
      join(fixture.base, 'v2'),
      runnerId,
      () => true,
    ).map((attempt) => attempt.attemptId)).toEqual([]);
  });
});

describe('safe attempt cleanup', () => {
  it('retains an attempt when its creating repository identity no longer matches', async () => {
    const fixture = repositoryFixture();
    const manifest = terminalAttempt(
      await createAttemptWorkspace(options(fixture), defaultRunner),
    );
    git(fixture.repo, ['remote', 'set-url', 'origin', join(fixture.root, 'other.git')]);

    await expect(cleanupAttempt(manifest.paths.manifest, defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({
      status: 'retained',
      reason: { code: 'ambiguous' },
    });
    expect(readFileSync(manifest.paths.manifest, 'utf8')).toContain(UUID_A);
  });

  it('removes a clean attempt whose HEAD is reachable from the fetched publication ref', async () => {
    const fixture = repositoryFixture();
    const manifest = terminalAttempt(
      await createAttemptWorkspace(options(fixture), defaultRunner),
    );

    const result = await cleanupAttempt(manifest.paths.manifest, defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
    });
    expect(result).toEqual({ status: 'removed', attemptId: UUID_A });
    expect(() => readFileSync(manifest.paths.manifest)).toThrow();
  });

  it('treats an already-removed exact worktree as redundant cleanup', async () => {
    const fixture = repositoryFixture();
    const manifest = terminalAttempt(
      await createAttemptWorkspace(options(fixture), defaultRunner),
    );
    git(fixture.repo, ['worktree', 'remove', manifest.paths.worktree]);

    await expect(cleanupAttempt(manifest.paths.manifest, defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toEqual({ status: 'removed', attemptId: UUID_A });
  });

  it('requires registry absence and remote reachability before removing missing-worktree metadata', async () => {
    const unrecordedFixture = repositoryFixture();
    const unrecorded = await createAttemptWorkspace(options(unrecordedFixture), defaultRunner);
    markAttemptRunning(unrecorded.paths.manifest, 3131);
    markAttemptExited(unrecorded.paths.manifest);
    git(unrecordedFixture.repo, ['worktree', 'remove', unrecorded.paths.worktree]);
    await expect(cleanupAttempt(unrecorded.paths.manifest, defaultRunner, {
      v2Base: join(unrecordedFixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({
      status: 'retained',
      reason: { code: 'ambiguous' },
    });

    const registeredFixture = repositoryFixture();
    const registered = terminalAttempt(
      await createAttemptWorkspace(options(registeredFixture), defaultRunner),
    );
    rmSync(registered.paths.worktree, { recursive: true });

    await expect(cleanupAttempt(registered.paths.manifest, defaultRunner, {
      v2Base: join(registeredFixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({
      status: 'retained',
      reason: { code: 'ambiguous' },
    });
    expect(git(registeredFixture.repo, ['worktree', 'list', '--porcelain']))
      .toContain(registered.paths.worktree);

    const unreachableFixture = repositoryFixture();
    const unreachable = terminalAttempt(
      await createAttemptWorkspace(options(unreachableFixture), defaultRunner),
    );
    git(unreachableFixture.repo, ['worktree', 'remove', unreachable.paths.worktree]);
    execFileSync('git', [
      `--git-dir=${unreachableFixture.remote}`,
      'update-ref',
      '-d',
      'refs/heads/main',
    ]);

    await expect(cleanupAttempt(unreachable.paths.manifest, defaultRunner, {
      v2Base: join(unreachableFixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({ status: 'retained' });
    expect(readFileSync(unreachable.paths.manifest, 'utf8')).toContain(UUID_A);
  });

  it('performs missing-worktree cleanup with local Git reads/fetch only', async () => {
    const fixture = repositoryFixture();
    const manifest = terminalAttempt(
      await createAttemptWorkspace(options(fixture), defaultRunner),
    );
    git(fixture.repo, ['worktree', 'remove', manifest.paths.worktree]);
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const observingRunner: CommandRunner = async (cmd, args, opts) => {
      calls.push({ cmd, args });
      return defaultRunner(cmd, args, opts);
    };

    await expect(cleanupAttempt(manifest.paths.manifest, observingRunner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toEqual({ status: 'removed', attemptId: UUID_A });
    expect(calls.every(({ cmd }) => cmd === 'git')).toBe(true);
    expect(calls.some(({ args }) =>
      args.includes('push') || args.includes('update-ref'))).toBe(false);
  });

  it('contains a concurrent missing-worktree metadata removal race', async () => {
    const fixture = repositoryFixture();
    const manifest = terminalAttempt(
      await createAttemptWorkspace(options(fixture), defaultRunner),
    );
    git(fixture.repo, ['worktree', 'remove', manifest.paths.worktree]);
    let raced = false;
    const racingRunner: CommandRunner = async (cmd, args, runnerOptions) => {
      const output = await defaultRunner(cmd, args, runnerOptions);
      if (!raced && cmd === 'git' && args.includes('merge-base')) {
        raced = true;
        rmSync(manifest.paths.attemptDir, { recursive: true });
      }
      return output;
    };

    await expect(cleanupAttempt(manifest.paths.manifest, racingRunner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toEqual({
      status: 'already-removed',
      attemptId: manifest.attemptId,
    });
  });

  it('reconciles dead running processState to exited before retaining dirty worktrees', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(
      options(fixture, { pid: 4242 }),
      defaultRunner,
    );
    writeFileSync(join(manifest.paths.worktree, 'dirty.txt'), 'dirty\n');

    await expect(cleanupAttempt(manifest.paths.manifest, defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({ status: 'retained', reason: { code: 'dirty' } });
    expect(readAttemptManifest(manifest.paths.manifest).processState).toBe('exited');
  });

  it('retains dirty, ahead, and live attempts with structured reasons', async () => {
    const dirtyFixture = repositoryFixture();
    const dirty = terminalAttempt(
      await createAttemptWorkspace(options(dirtyFixture), defaultRunner),
    );
    writeFileSync(join(dirty.paths.worktree, 'dirty.txt'), 'dirty\n');
    await expect(cleanupAttempt(dirty.paths.manifest, defaultRunner, {
      v2Base: join(dirtyFixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({ status: 'retained', reason: { code: 'dirty' } });

    const aheadFixture = repositoryFixture();
    const ahead = terminalAttempt(
      await createAttemptWorkspace(options(aheadFixture), defaultRunner),
    );
    writeFileSync(join(ahead.paths.worktree, 'ahead.txt'), 'ahead\n');
    git(ahead.paths.worktree, ['add', 'ahead.txt']);
    git(ahead.paths.worktree, ['commit', '-m', 'ahead']);
    await expect(cleanupAttempt(ahead.paths.manifest, defaultRunner, {
      v2Base: join(aheadFixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({ status: 'retained', reason: { code: 'ahead' } });

    const liveFixture = repositoryFixture();
    const live = await createAttemptWorkspace(options(liveFixture, { pid: 444 }), defaultRunner);
    await expect(cleanupAttempt(live.paths.manifest, defaultRunner, {
      v2Base: join(liveFixture.base, 'v2'),
      isPidAlive: (pid) => pid === 444,
    })).resolves.toMatchObject({ status: 'retained', reason: { code: 'live' } });
  });

  it('retains preparing attempts because they have no positive terminal evidence', async () => {
    const fixture = repositoryFixture();
    const preparing = await createAttemptWorkspace(options(fixture), defaultRunner);

    await expect(cleanupAttempt(preparing.paths.manifest, defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({
      status: 'retained',
      reason: { code: 'ambiguous' },
    });
    expect(readAttemptManifest(preparing.paths.manifest).processState).toBe('preparing');
  });

  it('retains authentication failure, missing objects, malformed manifests, and escaped paths', async () => {
    const authFixture = repositoryFixture();
    const auth = terminalAttempt(
      await createAttemptWorkspace(options(authFixture), defaultRunner),
    );
    const authRunner: CommandRunner = async (cmd, args, opts) => {
      if (cmd === 'git' && args.includes('fetch')) {
        throw new Error('authentication failed and selected-secret appeared here');
      }
      return defaultRunner(cmd, args, opts);
    };
    const authResult = await cleanupAttempt(auth.paths.manifest, authRunner, {
      v2Base: join(authFixture.base, 'v2'),
      isPidAlive: () => false,
    });
    expect(authResult).toMatchObject({
      status: 'retained',
      reason: { code: 'authentication-failed' },
    });
    expect(JSON.stringify(authResult)).not.toContain('selected-secret');

    const missingFixture = repositoryFixture();
    const missing = terminalAttempt(
      await createAttemptWorkspace(options(missingFixture), defaultRunner),
    );
    const missingRunner: CommandRunner = async (cmd, args, opts) => {
      if (cmd === 'git' && args.includes('rev-parse') && args.some((arg) => arg.includes('HEAD'))) {
        throw new Error('missing');
      }
      return defaultRunner(cmd, args, opts);
    };
    await expect(cleanupAttempt(missing.paths.manifest, missingRunner, {
      v2Base: join(missingFixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({ status: 'retained', reason: { code: 'missing-object' } });

    const malformedFixture = repositoryFixture();
    const malformed = terminalAttempt(
      await createAttemptWorkspace(options(malformedFixture), defaultRunner),
    );
    writeFileSync(malformed.paths.manifest, '{"version":2,"oops":true}');
    await expect(cleanupAttempt(malformed.paths.manifest, defaultRunner, {
      v2Base: join(malformedFixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({ status: 'retained', reason: { code: 'malformed' } });

    const escapedFixture = repositoryFixture();
    const escaped = terminalAttempt(
      await createAttemptWorkspace(options(escapedFixture), defaultRunner),
    );
    const escapedRaw = JSON.parse(readFileSync(escaped.paths.manifest, 'utf8')) as AttemptManifest;
    writeFileSync(escaped.paths.manifest, JSON.stringify({
      ...escapedRaw,
      paths: { ...escapedRaw.paths, attemptDir: escapedFixture.root },
    }));
    await expect(cleanupAttempt(escaped.paths.manifest, defaultRunner, {
      v2Base: join(escapedFixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({ status: 'retained', reason: { code: 'escaped-path' } });

    const symlinkFixture = repositoryFixture();
    const symlinked = terminalAttempt(
      await createAttemptWorkspace(options(symlinkFixture), defaultRunner),
    );
    git(symlinkFixture.repo, ['worktree', 'remove', symlinked.paths.worktree]);
    symlinkSync(symlinkFixture.repo, symlinked.paths.worktree, 'dir');
    await expect(cleanupAttempt(symlinked.paths.manifest, defaultRunner, {
      v2Base: join(symlinkFixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({ status: 'retained', reason: { code: 'escaped-path' } });
    expect(readFileSync(join(symlinkFixture.repo, 'README.md'), 'utf8')).toBe('base\n');
  });

  it('retains ambiguous Git inspection errors instead of forcing removal', async () => {
    const fixture = repositoryFixture();
    const manifest = terminalAttempt(
      await createAttemptWorkspace(options(fixture), defaultRunner),
    );
    const runner: CommandRunner = async (cmd, args, opts) => {
      if (cmd === 'git' && args.includes('status')) throw new Error('unexpected git failure');
      return defaultRunner(cmd, args, opts);
    };
    await expect(cleanupAttempt(manifest.paths.manifest, runner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({ status: 'retained', reason: { code: 'ambiguous' } });
    expect(readFileSync(manifest.paths.manifest, 'utf8')).toContain(UUID_A);
  });

  it('sanitizes ambient credentials for the exact askpass fetch', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ambient-secret');
    const fixture = repositoryFixture();
    const manifest = terminalAttempt(
      await createAttemptWorkspace(options(fixture), defaultRunner),
    );
    let fetchSeen = false;
    const runner: CommandRunner = async (cmd, args, opts) => {
      if (cmd === 'git' && args.includes('fetch')) {
        fetchSeen = true;
        expect(opts?.env).toMatchObject({
          GH_TOKEN: 'selected-secret',
          GITHUB_TOKEN: '',
          GIT_ASKPASS: manifest.paths.askpass,
          GIT_TERMINAL_PROMPT: '0',
        });
      }
      return defaultRunner(cmd, args, opts);
    };
    try {
      await expect(cleanupAttempt(manifest.paths.manifest, runner, {
        v2Base: join(fixture.base, 'v2'),
        isPidAlive: () => false,
        env: { GH_TOKEN: 'selected-secret' },
      })).resolves.toEqual({ status: 'removed', attemptId: UUID_A });
      expect(fetchSeen).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('sweeps dead same-host attempts while retaining live children', async () => {
    const fixture = repositoryFixture();
    const dead = await createAttemptWorkspace(options(fixture, {
      pid: 100,
      host: 'same-host',
    }), defaultRunner);
    const live = await createAttemptWorkspace(options(fixture, {
      runnerId: 'same-host-200-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      attemptId: UUID_B,
      pid: 200,
      host: 'same-host',
    }), defaultRunner);

    const results = await sweepDeadAttempts(defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      host: 'same-host',
      isPidAlive: (pid) => pid === 200,
    });

    expect(results).toEqual(expect.arrayContaining([
      { status: 'removed', attemptId: dead.attemptId },
      {
        status: 'retained',
        attemptId: live.attemptId,
        reason: { code: 'live', detail: 'Attempt child PID is still live.' },
      },
    ]));
    expect(() => readFileSync(dead.paths.manifest)).toThrow();
    expect(readFileSync(live.paths.manifest, 'utf8')).toContain(live.attemptId);
  });

  it('isolates cleanup failures so one attempt cannot abort the remaining sweep', async () => {
    const fixture = repositoryFixture();
    const failing = await createAttemptWorkspace(options(fixture, {
      pid: 100,
      host: 'same-host',
    }), defaultRunner);
    const removable = terminalAttempt(
      await createAttemptWorkspace(options(fixture, {
        runnerId: 'same-host-200-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        attemptId: UUID_B,
        host: 'same-host',
      }), defaultRunner),
    );

    const results = await sweepDeadAttempts(defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      host: 'same-host',
      isPidAlive: (pid) => {
        if (pid === 100) throw new Error('injected process inspection failure');
        return false;
      },
    });

    expect(results).toEqual(expect.arrayContaining([
      {
        status: 'retained',
        attemptId: failing.attemptId,
        reason: {
          code: 'ambiguous',
          detail: 'Attempt cleanup failed unexpectedly and was isolated.',
        },
      },
      { status: 'removed', attemptId: removable.attemptId },
    ]));
    expect(readFileSync(failing.paths.manifest, 'utf8')).toContain(failing.attemptId);
    expect(() => readFileSync(removable.paths.manifest)).toThrow();
  });

  it('retains dirty dead attempts until the grace period elapses', async () => {
    const fixture = repositoryFixture();
    const manifest = terminalAttempt(
      await createAttemptWorkspace(options(fixture), defaultRunner),
    );
    writeFileSync(join(manifest.paths.worktree, 'dirty.txt'), 'dirty\n');

    await expect(cleanupAttempt(manifest.paths.manifest, defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
      graceMs: 30 * 60 * 1000,
      now: () => new Date('2026-07-20T00:10:00.000Z'),
    })).resolves.toMatchObject({ status: 'retained', reason: { code: 'dirty' } });

    await expect(cleanupAttempt(manifest.paths.manifest, defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
      graceMs: 30 * 60 * 1000,
      now: () => new Date('2026-07-20T01:00:00.000Z'),
    })).resolves.toEqual({ status: 'removed', attemptId: UUID_A });
  });

  it('removes dead ahead and preparing attempts after the grace period', async () => {
    const aheadFixture = repositoryFixture();
    const ahead = terminalAttempt(
      await createAttemptWorkspace(options(aheadFixture), defaultRunner),
    );
    writeFileSync(join(ahead.paths.worktree, 'ahead.txt'), 'ahead\n');
    git(ahead.paths.worktree, ['add', 'ahead.txt']);
    git(ahead.paths.worktree, ['commit', '-m', 'ahead']);
    await expect(cleanupAttempt(ahead.paths.manifest, defaultRunner, {
      v2Base: join(aheadFixture.base, 'v2'),
      isPidAlive: () => false,
      graceMs: 30 * 60 * 1000,
      now: () => new Date('2026-07-20T01:00:00.000Z'),
    })).resolves.toEqual({ status: 'removed', attemptId: UUID_A });

    const preparingFixture = repositoryFixture();
    const preparing = await createAttemptWorkspace(options(preparingFixture), defaultRunner);
    await expect(cleanupAttempt(preparing.paths.manifest, defaultRunner, {
      v2Base: join(preparingFixture.base, 'v2'),
      isPidAlive: () => false,
      graceMs: 30 * 60 * 1000,
      now: () => new Date('2026-07-20T01:00:00.000Z'),
    })).resolves.toEqual({ status: 'removed', attemptId: UUID_A });
  });

  it('sweeps malformed orphan attempt directories after the grace period', async () => {
    const fixture = repositoryFixture();
    const orphanDir = join(
      fixture.base,
      'v2',
      'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'implement',
      'issue-99-orphan-dir',
    );
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, 'manifest.json'), '{"version":2,"oops":true}');
    const createdAt = new Date('2026-07-20T00:00:00.000Z');
    utimesSync(orphanDir, createdAt, createdAt);
    utimesSync(join(orphanDir, 'manifest.json'), createdAt, createdAt);

    const retained = await sweepDeadAttempts(defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
      graceMs: 30 * 60 * 1000,
      now: () => new Date('2026-07-20T00:10:00.000Z'),
    });
    expect(retained).toContainEqual({
      status: 'retained',
      reason: {
        code: 'malformed',
        detail: 'Malformed attempt directory is still inside the grace period.',
      },
    });
    expect(existsSync(orphanDir)).toBe(true);

    const removed = await sweepDeadAttempts(defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
      graceMs: 30 * 60 * 1000,
      now: () => new Date('2026-07-20T01:00:00.000Z'),
    });
    expect(removed).toContainEqual({
      status: 'removed',
      attemptId: 'issue-99-orphan-dir',
    });
    expect(existsSync(orphanDir)).toBe(false);
  });

  it('force-evicts oldest dead attempts first when free disk is below the floor', async () => {
    const fixture = repositoryFixture();
    const olderManifest = await createAttemptWorkspace(options(fixture, {
      attemptId: UUID_A,
    }), defaultRunner);
    markAttemptRunning(olderManifest.paths.manifest, 4242, () =>
      new Date('2026-07-20T00:00:00.000Z'));
    markAttemptExited(
      olderManifest.paths.manifest,
      () => new Date('2026-07-20T00:01:00.000Z'),
      olderManifest.expectedHead,
    );
    const newerManifest = await createAttemptWorkspace(options(fixture, {
      runnerId: 'host-101-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      attemptId: UUID_B,
    }), defaultRunner);
    markAttemptRunning(newerManifest.paths.manifest, 4243, () =>
      new Date('2026-07-20T00:30:00.000Z'));
    markAttemptExited(
      newerManifest.paths.manifest,
      () => new Date('2026-07-20T00:31:00.000Z'),
      newerManifest.expectedHead,
    );
    writeFileSync(join(olderManifest.paths.worktree, 'dirty.txt'), 'dirty\n');
    writeFileSync(join(newerManifest.paths.worktree, 'dirty.txt'), 'dirty\n');

    const floor = 20 * 1024 * 1024 * 1024;
    let reads = 0;
    const readFreeDiskBytes = () => {
      reads += 1;
      return reads <= 2 ? floor - 1 : floor + 1;
    };

    const results = await sweepDeadAttempts(defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
      evictUnpublished: false,
      diskFloorBytes: floor,
      diskPath: join(fixture.base, 'v2'),
      readFreeDiskBytes,
    });
    expect(results).toContainEqual({ status: 'removed', attemptId: UUID_A });
    expect(() => readFileSync(olderManifest.paths.manifest)).toThrow();
    expect(readFileSync(newerManifest.paths.manifest, 'utf8')).toContain(UUID_B);
  });

  it('reports free disk bytes for a path', () => {
    const fixture = repositoryFixture();
    expect(freeDiskBytes(fixture.repo)).toBeGreaterThan(0);
    expect(freeDiskBytes(join(fixture.repo, 'not-created-yet', 'v2')))
      .toBeGreaterThan(0);
  });
});

describe('bounded attempt cleanup', () => {
  async function twoDeadAttempts(
    fixture: ReturnType<typeof repositoryFixture>,
  ): Promise<readonly AttemptManifest[]> {
    const first = terminalAttempt(await createAttemptWorkspace(options(fixture, {
      attemptId: UUID_A,
      host: 'same-host',
    }), defaultRunner));
    const second = terminalAttempt(await createAttemptWorkspace(options(fixture, {
      runnerId: 'same-host-200-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      attemptId: UUID_B,
      host: 'same-host',
    }), defaultRunner));
    return [first, second];
  }

  // Advances half a budget per reading: the sweep start and the first
  // candidate fall inside a 60s budget, the second candidate does not.
  function halfBudgetPerReading(): () => number {
    let elapsed = 0;
    return () => {
      const reading = elapsed;
      elapsed += 30_000;
      return reading;
    };
  }

  it('bounds one cycle of cleanup to a sixty-second wall clock by default', () => {
    expect(DEFAULT_ATTEMPT_SWEEP_BUDGET_MS).toBe(60_000);
  });

  it('starts at most a budget of removals and defers the rest to the next cycle', async () => {
    const fixture = repositoryFixture();
    const attempts = await twoDeadAttempts(fixture);

    const first = await sweepDeadAttempts(defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      host: 'same-host',
      isPidAlive: () => false,
      budgetMs: 60_000,
      monotonicNow: halfBudgetPerReading(),
    });

    expect(first.filter((result) => result.status === 'removed')).toHaveLength(1);
    expect(first).toContainEqual({
      status: 'retained',
      attemptId: expect.any(String),
      reason: {
        code: 'deferred',
        detail: 'Attempt cleanup deferred to the next cycle: '
          + 'the sweep wall-clock budget was spent.',
      },
    });

    const survivor = attempts.find(
      (attempt) => existsSync(attempt.paths.manifest),
    );
    expect(survivor).toBeDefined();

    const second = await sweepDeadAttempts(defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      host: 'same-host',
      isPidAlive: () => false,
      budgetMs: 60_000,
      monotonicNow: () => 0,
    });

    expect(second).toContainEqual({
      status: 'removed',
      attemptId: survivor.attemptId,
    });
    expect(existsSync(survivor.paths.manifest)).toBe(false);
  });

  it('leaves a deferred removal occupying disk rather than counting it as reclaimed', async () => {
    const fixture = repositoryFixture();
    const attempts = await twoDeadAttempts(fixture);
    const floor = 20 * 1024 * 1024 * 1024;
    let freeReads = 0;

    const results = await sweepDeadAttempts(defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      host: 'same-host',
      isPidAlive: () => false,
      diskFloorBytes: floor,
      diskPath: join(fixture.base, 'v2'),
      // A pending delete is not free space: the floor stays unmet for exactly
      // as long as the bytes are still on disk.
      readFreeDiskBytes: () => {
        freeReads += 1;
        return floor - 1;
      },
      budgetMs: 60_000,
      monotonicNow: halfBudgetPerReading(),
    });

    expect(freeReads).toBeGreaterThan(0);
    expect(results.filter((result) => result.status === 'removed'))
      .toHaveLength(1);
    expect(results.some((result) =>
      result.status === 'retained' && result.reason.code === 'deferred')).toBe(true);
    expect(attempts.filter((attempt) => existsSync(attempt.paths.attemptDir)))
      .toHaveLength(1);
  });

  it('trashes every dead worktree in one cycle and reclaims the bytes off the sweep', async () => {
    await drainTrashReclaims();
    const fixture = repositoryFixture();
    const attempts = await twoDeadAttempts(fixture);
    const trashBase = join(fixture.base, 'trash');
    const reclaims: string[] = [];
    const release = deferred();

    const results = await sweepDeadAttempts(defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      host: 'same-host',
      isPidAlive: () => false,
      trashBase,
      reclaimTrashed: async (path) => {
        reclaims.push(path);
        await release.promise;
      },
      budgetMs: 60_000,
      monotonicNow: () => 0,
    });

    // Both left their attempts in the same cycle: no deferral, whatever their size.
    expect(results.filter((result) => result.status === 'removed')).toHaveLength(2);
    expect(results.some((result) =>
      result.status === 'retained' && result.reason.code === 'deferred')).toBe(false);
    for (const attempt of attempts) {
      expect(existsSync(attempt.paths.worktree)).toBe(false);
      expect(existsSync(attempt.paths.attemptDir)).toBe(false);
    }
    // The registrations went with them: only the repository itself remains.
    const registered = git(fixture.repo, ['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter((line) => line.startsWith('worktree '));
    expect(registered).toHaveLength(1);
    // But the bytes are still on disk, owned and counted, until each reclaim
    // finishes: a trashed worktree is occupied space, never reclaimed space.
    expect(reclaims).toHaveLength(2);
    const trashed = readdirSync(trashBase, { withFileTypes: true });
    expect(trashed.filter((entry) => entry.isDirectory())).toHaveLength(2);
    // Each is owned by a recorded pid while it is in flight.
    expect(trashed.filter((entry) => entry.name.endsWith('.reclaim'))).toHaveLength(2);
    expect(pendingTrashReclaims()).toBe(2);

    release.resolve();
    await drainTrashReclaims();
    expect(pendingTrashReclaims()).toBe(0);
    expect(readdirSync(trashBase).filter((name) => name.endsWith('.reclaim')))
      .toHaveLength(0);
  });

  it('reclaims trashed bytes for real by default', async () => {
    const fixture = repositoryFixture();
    await twoDeadAttempts(fixture);
    const trashBase = join(fixture.base, 'trash');

    await sweepDeadAttempts(defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      host: 'same-host',
      isPidAlive: () => false,
      trashBase,
      budgetMs: 60_000,
      monotonicNow: () => 0,
    });
    await drainTrashReclaims();

    expect(readdirSync(trashBase)).toHaveLength(0);
  });

  it('re-adopts trash a previous daemon left behind mid-reclaim', async () => {
    const fixture = repositoryFixture();
    const trashBase = join(fixture.base, 'trash');
    const leftover = join(trashBase, 'leftover-from-a-dead-daemon');
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(leftover, 'file'), 'bytes\n');
    const reclaims: string[] = [];

    await sweepDeadAttempts(defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      host: 'same-host',
      isPidAlive: () => false,
      trashBase,
      reclaimTrashed: async (path) => {
        reclaims.push(path);
      },
      budgetMs: 60_000,
      monotonicNow: () => 0,
    });
    await drainTrashReclaims();

    expect(reclaims).toEqual([leftover]);
  });

  it('waits for each eviction below the floor so it stops at the floor, not at empty', async () => {
    const fixture = repositoryFixture();
    const attempts = await twoDeadAttempts(fixture);
    const trashBase = join(fixture.base, 'trash');
    const floor = 20 * 1024 * 1024 * 1024;
    let reclaimed = 0;
    // The sweep start and the one emergency eviction fall inside the budget;
    // the routine pass that follows finds it spent, so only the emergency
    // pass decides what leaves.
    let readings = 0;

    const results = await sweepDeadAttempts(defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      host: 'same-host',
      isPidAlive: () => false,
      trashBase,
      reclaimTrashed: async () => {
        reclaimed += 1;
      },
      diskFloorBytes: floor,
      diskPath: join(fixture.base, 'v2'),
      // Free space crosses the floor only once a reclaim has actually run —
      // which an un-awaited rename would never let happen inside the loop.
      readFreeDiskBytes: () => (reclaimed > 0 ? floor : floor - 1),
      budgetMs: 60_000,
      monotonicNow: () => {
        readings += 1;
        return readings <= 2 ? 0 : 60_000;
      },
    });
    await drainTrashReclaims();

    expect(reclaimed).toBe(1);
    expect(results.filter((result) => result.status === 'removed')).toHaveLength(1);
    expect(attempts.filter((attempt) => existsSync(attempt.paths.attemptDir)))
      .toHaveLength(1);
  });

  it('adopts a trashed entry only when no live pid owns it', async () => {
    await drainTrashReclaims();
    const fixture = repositoryFixture();
    const trashBase = join(fixture.base, 'trash');
    const owned = join(trashBase, 'owned-by-a-live-reclaim');
    mkdirSync(owned, { recursive: true });
    writeFileSync(join(trashBase, '.owned-by-a-live-reclaim.reclaim'), `${process.pid}\n`);
    const orphaned = join(trashBase, 'left-by-a-dead-reclaim');
    mkdirSync(orphaned, { recursive: true });
    writeFileSync(join(trashBase, '.left-by-a-dead-reclaim.reclaim'), '999999\n');
    const reclaims: string[] = [];

    await sweepDeadAttempts(defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      host: 'same-host',
      isPidAlive: (pid) => pid === process.pid,
      trashBase,
      reclaimTrashed: async (path) => {
        reclaims.push(path);
      },
      budgetMs: 60_000,
      monotonicNow: () => 0,
    });
    await drainTrashReclaims();

    // The live owner's entry is left to it; the dead owner's is taken over.
    expect(reclaims).toEqual([orphaned]);
    expect(existsSync(join(trashBase, '.owned-by-a-live-reclaim.reclaim'))).toBe(true);
    expect(existsSync(join(trashBase, '.left-by-a-dead-reclaim.reclaim'))).toBe(false);
  });

  it('drops a sidecar whose entry is already gone', async () => {
    const fixture = repositoryFixture();
    const trashBase = join(fixture.base, 'trash');
    mkdirSync(trashBase, { recursive: true });
    writeFileSync(join(trashBase, '.finished-elsewhere.reclaim'), '999999\n');

    await sweepDeadAttempts(defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      host: 'same-host',
      isPidAlive: () => false,
      trashBase,
      reclaimTrashed: async () => {},
      budgetMs: 60_000,
      monotonicNow: () => 0,
    });

    expect(existsSync(join(trashBase, '.finished-elsewhere.reclaim'))).toBe(false);
  });

  it('keeps a failed reclaim owned, reports it, and retries it next sweep', async () => {
    await drainTrashReclaims();
    const fixture = repositoryFixture();
    const trashBase = join(fixture.base, 'trash');
    const stuck = join(trashBase, 'will-not-delete');
    mkdirSync(stuck, { recursive: true });
    let calls = 0;
    const sweep = () => sweepDeadAttempts(defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      host: 'same-host',
      isPidAlive: () => false,
      trashBase,
      reclaimTrashed: async () => {
        calls += 1;
        throw new Error('EPERM: operation not permitted');
      },
      budgetMs: 60_000,
      monotonicNow: () => 0,
    });

    await sweep();
    await drainTrashReclaims();

    expect(calls).toBe(1);
    expect(failedTrashReclaims()).toContainEqual({
      trashed: stuck,
      entry: 'will-not-delete',
      detail: 'EPERM: operation not permitted',
    });
    // Still owned, still on disk, and the next sweep tries again.
    expect(existsSync(join(trashBase, '.will-not-delete.reclaim'))).toBe(true);
    expect(existsSync(stuck)).toBe(true);

    await sweep();
    await drainTrashReclaims();
    expect(calls).toBe(2);
  });
});

describe('attempt runtime and exit code (#152)', () => {
  it('records the routed runtime at creation and round-trips it', async () => {
    const fixture = repositoryFixture();
    const routed = await createAttemptWorkspace(
      options(fixture, { runtime: 'codex', host: 'same-host' }),
      defaultRunner,
    );
    expect(routed.runtime).toBe('codex');
    expect(readAttemptManifest(routed.paths.manifest).runtime).toBe('codex');

    // A manifest that predates the field, or was never routed, has none.
    const plain = await createAttemptWorkspace(options(fixture, {
      runnerId: 'same-host-200-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      attemptId: UUID_B,
      host: 'same-host',
    }), defaultRunner);
    expect(plain.runtime).toBeUndefined();
    expect(readAttemptManifest(plain.paths.manifest).runtime).toBeUndefined();
  });

  it('rejects a runtime the engine does not know and a non-integer exit code', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture), defaultRunner);
    const raw = JSON.parse(readFileSync(manifest.paths.manifest, 'utf8')) as Record<string, unknown>;

    expect(() => decodeAttemptManifest({ ...raw, runtime: 'gemini' })).toThrow(/runtime/i);
    expect(() => decodeAttemptManifest({ ...raw, exitCode: 'one' })).toThrow(/exit code/i);
    expect(decodeAttemptManifest({ ...raw, exitCode: null }).exitCode).toBeNull();
    expect(decodeAttemptManifest({ ...raw, exitCode: 137 }).exitCode).toBe(137);
  });

  it('records the exit code the child reported, and null for a signal death', async () => {
    const fixture = repositoryFixture();
    const failed = await createAttemptWorkspace(options(fixture), defaultRunner);
    markAttemptRunning(failed.paths.manifest, 4242, () => new Date('2026-07-20T00:01:00.000Z'));
    const child = Object.assign(new EventEmitter(), { pid: 4242 });
    trackAttemptChild(failed.paths.manifest, child, {
      alreadyRunning: true,
      now: () => new Date('2026-07-20T00:01:00.500Z'),
    });
    child.emit('exit', 1, null);
    expect(readAttemptManifest(failed.paths.manifest))
      .toMatchObject({ processState: 'exited', exitCode: 1 });

    const killed = await createAttemptWorkspace(options(fixture, {
      runnerId: 'host-200-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      attemptId: UUID_B,
    }), defaultRunner);
    markAttemptRunning(killed.paths.manifest, 5252, () => new Date('2026-07-20T00:01:00.000Z'));
    const signalled = Object.assign(new EventEmitter(), { pid: 5252 });
    trackAttemptChild(killed.paths.manifest, signalled, {
      alreadyRunning: true,
      now: () => new Date('2026-07-20T00:01:00.500Z'),
    });
    signalled.emit('exit', null, 'SIGKILL');
    expect(readAttemptManifest(killed.paths.manifest))
      .toMatchObject({ processState: 'exited', exitCode: null });
  });

  it('records the exit code of a child that had already exited when tracking began', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture), defaultRunner);
    markAttemptRunning(manifest.paths.manifest, 6262, () => new Date('2026-07-20T00:01:00.000Z'));
    const alreadyExited = Object.assign(new EventEmitter(), { pid: 6262, exitCode: 2 });
    const tracked = trackAttemptChild(manifest.paths.manifest, alreadyExited, {
      alreadyRunning: true,
      now: () => new Date('2026-07-20T00:01:00.500Z'),
    });
    expect(tracked).toMatchObject({ processState: 'exited', exitCode: 2 });
  });
});
