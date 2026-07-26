import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest';
import { TaskSubmitRequestV1Schema } from '@jinn-network/sdk/autopilot';
import {
  LocalSessionExecutionBackend,
  MarketplaceSessionExecutionBackend,
  recoverPreparedMarketplaceAttempts,
  type LocalImplementationSessionExecutionRequest,
  type LocalSessionExecutionRequest,
  type MarketplaceSessionExecutionRequest,
} from '../../src/lifecycle/session-execution-backend.js';
import {
  decodeAttemptManifest,
  readAttemptManifest,
  transitionMarketplaceExecution,
} from '../../src/lifecycle/attempt-workspace.js';
import {
  buildMarketplaceTaskRequest,
  persistMarketplaceTaskRequest,
} from '../../src/lifecycle/marketplace-task.js';

const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-07-26T12:00:00.000Z';
const CLAIM = '2'.repeat(40);
const BASE = '1'.repeat(40);
const MARKETPLACE_CANCEL_INTENT_REASON = 'operator-cancelled';
const SUBMISSION = {
  schemaVersion: 1,
  generatedAt: '2026-07-26T12:01:00.000Z',
  verb: 'tasks submit',
  id: `autopilot:${ATTEMPT_ID}`,
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
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function marketplaceFixture(
  state: 'prepared' | 'submitted' | 'cancelled' = 'prepared',
) {
  const root = mkdtempSync(join(tmpdir(), 'autopilot-marketplace-backend-'));
  roots.push(root);
  const attemptDir = join(root, 'attempt');
  mkdirSync(join(attemptDir, 'worktree'), { recursive: true });
  writeFileSync(
    join(attemptDir, 'worktree', '.git'),
    `gitdir: ${join(root, '.git', 'worktrees', ATTEMPT_ID)}\n`,
  );
  mkdirSync(join(attemptDir, 'gh-config'));
  const requestPath = join(attemptDir, 'marketplace-request.json');
  const built = buildMarketplaceTaskRequest({
    workflow: 'implementation',
    repository: 'Jinn-Network/mono',
    language: 'typescript',
    verificationProfile: 'jinn-mono.v1',
    issueNumber: 42,
    prNumber: 84,
    targetBase: 'next',
    branch: 'autopilot/42',
    claimOid: CLAIM,
    expectedHead: CLAIM,
    v2AttemptId: ATTEMPT_ID,
    runnerId: 'runner-a',
    taskSnapshot: {
      title: 'Submit an implementation task',
      body: 'Authoritative issue body',
      prBody: 'Closes #42',
      baseSha: BASE,
      targetBaseOid: BASE,
    },
    receiptAuthors: ['implementation-bot'],
    createdAt: Date.parse(NOW),
  });
  const persisted = persistMarketplaceTaskRequest(requestPath, built.request);
  const prepared = {
    schemaVersion: 'marketplace-execution-v2',
    requestPath,
    requestDigest: persisted.requestDigest,
    solverNetSelectionPath: persisted.solverNetSelectionPath,
    preparedAt: NOW,
    agentSoftDeadline: built.agentSoftDeadline,
    adoptionDeadline: built.adoptionDeadline,
  } as const;
  const executionState = state === 'prepared'
    ? { ...prepared, status: 'prepared' as const }
    : state === 'submitted'
      ? {
          ...prepared,
          status: 'submitted' as const,
          submission: SUBMISSION,
          submittedAt: '2026-07-26T12:02:00.000Z',
        }
      : {
          ...prepared,
          status: 'cancelled' as const,
          reason: MARKETPLACE_CANCEL_INTENT_REASON,
          cancelledAt: '2026-07-26T12:02:00.000Z',
        };
  const manifest = decodeAttemptManifest({
    version: 2,
    attemptId: ATTEMPT_ID,
    runnerId: 'runner-a',
    host: 'test-host',
    phase: 'implement',
    execution: { backend: 'marketplace', state: executionState },
    subject: 'issue-42',
    issueNumber: 42,
    prNumber: 84,
    branch: 'autopilot/42',
    targetBase: 'next',
    targetBaseOid: BASE,
    expectedHead: CLAIM,
    claimOid: CLAIM,
    selectedLogin: 'implementation-bot',
    repository: {
      root,
      gitCommonDir: join(root, '.git'),
      remoteName: 'jinn-autopilot-v2',
      remoteUrlHash: 'a'.repeat(64),
    },
    processState: 'preparing',
    pid: null,
    paths: {
      attemptDir,
      worktree: join(attemptDir, 'worktree'),
      manifest: join(attemptDir, 'manifest.json'),
      log: join(attemptDir, 'session.log'),
      ghConfigDir: join(attemptDir, 'gh-config'),
      askpass: join(attemptDir, 'askpass'),
      tokenFile: join(attemptDir, 'gh-token'),
    },
    timestamps: {
      createdAt: NOW,
      updatedAt: state === 'prepared' ? NOW : '2026-07-26T12:02:00.000Z',
    },
  });
  writeFileSync(
    manifest.paths.manifest,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  const request: MarketplaceSessionExecutionRequest = {
    kind: 'implementation',
    workflow: 'implementation',
    manifestPath: manifest.paths.manifest,
    attemptId: ATTEMPT_ID,
    issueNumber: 42,
    prNumber: 84,
    branch: 'autopilot/42',
    targetBase: 'next',
    worktreePath: manifest.paths.worktree,
    logPath: manifest.paths.log,
    backend: 'marketplace',
  };
  return {
    manifest,
    request,
    requestPath,
    requestDigest: persisted.requestDigest,
  };
}

function marketplaceRecoveryFixture(
  v2Base: string,
  input: {
    readonly runnerId: string;
    readonly attemptId: string;
    readonly state: 'prepared' | 'submitted' | 'cancelled' | 'local';
    readonly profile?: {
      readonly repository: string;
      readonly language: string;
      readonly verificationProfile: string;
    };
  },
) {
  const attemptDir = join(
    v2Base,
    input.runnerId,
    'implement',
    `issue-42-${input.attemptId}`,
  );
  mkdirSync(join(attemptDir, 'worktree'), { recursive: true });
  writeFileSync(
    join(attemptDir, 'worktree', '.git'),
    `gitdir: ${join(v2Base, '.git', 'worktrees', input.attemptId)}\n`,
  );
  mkdirSync(join(attemptDir, 'gh-config'));
  const requestPath = join(attemptDir, 'marketplace-request.json');
  const built = buildMarketplaceTaskRequest({
    workflow: 'implementation',
    repository: 'Jinn-Network/mono',
    language: 'typescript',
    verificationProfile: 'jinn-mono.v1',
    issueNumber: 42,
    prNumber: 84,
    targetBase: 'next',
    branch: 'autopilot/42',
    claimOid: CLAIM,
    expectedHead: CLAIM,
    v2AttemptId: input.attemptId,
    runnerId: input.runnerId,
    taskSnapshot: {
      title: 'Recover an implementation task',
      body: 'Authoritative recovery issue body',
      prBody: 'Closes #42',
      baseSha: BASE,
      targetBaseOid: BASE,
    },
    receiptAuthors: ['implementation-bot'],
    createdAt: Date.parse(NOW),
  });
  const request = structuredClone(built.request);
  if (input.profile !== undefined) {
    request.spec.repo = input.profile.repository;
    request.spec.language = input.profile.language;
    request.spec.verificationProfile = input.profile.verificationProfile;
    request.spec.session.repository = input.profile.repository;
    request.spec.session.language = input.profile.language;
    request.spec.session.verificationProfile =
      input.profile.verificationProfile;
  }
  TaskSubmitRequestV1Schema.parse(request);
  const persisted = persistMarketplaceTaskRequest(requestPath, request);
  const submission = {
    ...SUBMISSION,
    id: `autopilot:${input.attemptId}`,
    taskId: `task-${input.attemptId}`,
  };
  const prepared = {
    schemaVersion: 'marketplace-execution-v2',
    requestPath,
    requestDigest: persisted.requestDigest,
    solverNetSelectionPath: persisted.solverNetSelectionPath,
    preparedAt: NOW,
    agentSoftDeadline: built.agentSoftDeadline,
    adoptionDeadline: built.adoptionDeadline,
  } as const;
  const execution = input.state === 'local'
    ? { backend: 'local' as const }
    : {
        backend: 'marketplace' as const,
        state: input.state === 'prepared'
          ? { ...prepared, status: 'prepared' as const }
          : input.state === 'submitted'
            ? {
                ...prepared,
                status: 'submitted' as const,
                submission,
                submittedAt: '2026-07-26T12:02:00.000Z',
              }
            : {
                ...prepared,
                status: 'cancelled' as const,
                reason: MARKETPLACE_CANCEL_INTENT_REASON,
                cancelledAt: '2026-07-26T12:02:00.000Z',
              },
      };
  const manifest = decodeAttemptManifest({
    version: 2,
    attemptId: input.attemptId,
    runnerId: input.runnerId,
    host: 'test-host',
    phase: 'implement',
    execution,
    subject: 'issue-42',
    issueNumber: 42,
    prNumber: 84,
    branch: 'autopilot/42',
    targetBase: 'next',
    ...(input.state === 'local' ? {} : { targetBaseOid: BASE }),
    expectedHead: CLAIM,
    claimOid: CLAIM,
    selectedLogin: 'implementation-bot',
    repository: {
      root: v2Base,
      gitCommonDir: join(v2Base, '.git'),
      remoteName: 'jinn-autopilot-v2',
      remoteUrlHash: 'a'.repeat(64),
    },
    processState: 'preparing',
    pid: null,
    paths: {
      attemptDir,
      worktree: join(attemptDir, 'worktree'),
      manifest: join(attemptDir, 'manifest.json'),
      log: join(attemptDir, 'session.log'),
      ghConfigDir: join(attemptDir, 'gh-config'),
      askpass: join(attemptDir, 'askpass'),
      tokenFile: join(attemptDir, 'gh-token'),
    },
    timestamps: {
      createdAt: NOW,
      updatedAt: input.state === 'prepared' || input.state === 'local'
        ? NOW
        : '2026-07-26T12:02:00.000Z',
    },
  });
  writeFileSync(
    manifest.paths.manifest,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { manifest, requestPath, submission };
}

const implementationRequest = (): LocalImplementationSessionExecutionRequest => ({
  kind: 'implementation',
  workflow: 'implementation',
  manifestPath: '/attempts/implementation/manifest.json',
  attemptId: 'attempt-implementation',
  issueNumber: 42,
  prNumber: 43,
  branch: 'autopilot/42',
  targetBase: 'next',
  worktreePath: '/worktrees/42',
  logPath: '/logs/42.log',
  backend: 'local',
  local: {
    spawnInput: {
      attemptId: 'attempt-implementation',
      issue: {
        number: 42,
        title: 'Add the backend seam',
        open: true,
        eligible: true,
        targetBase: 'next',
        effort: null,
      },
      prNumber: 43,
      branch: 'autopilot/42',
      targetBase: 'next',
      environment: { GH_TOKEN: 'local-only-test-token' },
      worktreePath: '/worktrees/42',
      logPath: '/logs/42.log',
    },
  },
});

const reviewRequest = (): LocalSessionExecutionRequest => ({
  kind: 'exact-head-review',
  manifestPath: '/attempts/review/manifest.json',
  attemptId: 'attempt-review',
  issueNumber: 42,
  prNumber: 43,
  branch: 'autopilot/42',
  targetBase: 'next',
  worktreePath: '/worktrees/42',
  logPath: '/logs/42.log',
  backend: 'local',
  reviewedHead: 'a'.repeat(40),
  reviewerLogin: 'review-bot',
  local: {
    spawnInput: {
      attemptId: 'attempt-review',
      candidate: {
        issueNumber: 42,
        number: 43,
        open: true,
        head: 'a'.repeat(40),
        headChangedAt: '2026-07-26T12:00:00.000Z',
        headRefName: 'autopilot/42',
        baseRefName: 'next',
        draft: false,
        author: 'octocat',
        labels: [],
        body: '',
        humanHold: false,
        approvalPolicy: 'single-approval',
        nativeReviews: [],
      },
      environment: { GH_TOKEN: 'local-only-test-token' },
      worktreePath: '/worktrees/42',
      logPath: '/logs/42.log',
    },
  },
});

describe('session execution backends', () => {
  it('local implementation start orders spawn, PID validation, and tracking without invoking review spawn', async () => {
    const events: string[] = [];
    const child = {
      get pid() {
        events.push('pid');
        return 1234;
      },
    };
    const spawnImplementation = vi.fn(() => {
      events.push('spawn');
      return child;
    });
    const spawnExactHeadReview = vi.fn();
    const trackChild = vi.fn((_manifestPath: string, _child: typeof child) => {
      events.push('track');
    });
    const backend = new LocalSessionExecutionBackend({
      spawnImplementation,
      spawnExactHeadReview,
      trackChild,
    });

    await expect(backend.start(implementationRequest())).resolves.toEqual({
      status: 'started',
      backend: 'local',
      pid: 1234,
    });
    expect(spawnImplementation).toHaveBeenCalledWith(
      implementationRequest().local.spawnInput,
    );
    expect(trackChild).toHaveBeenCalledTimes(1);
    expect(trackChild.mock.calls[0]?.[0]).toBe('/attempts/implementation/manifest.json');
    expect(trackChild.mock.calls[0]?.[1]).toBe(child);
    expect(spawnExactHeadReview).not.toHaveBeenCalled();
    expect(events).toEqual(['spawn', 'pid', 'track', 'pid']);
  });

  it('local review start orders spawn, PID validation, and tracking without invoking implementation spawn', async () => {
    const events: string[] = [];
    const child = {
      get pid() {
        events.push('pid');
        return 5678;
      },
    };
    const spawnImplementation = vi.fn();
    const spawnExactHeadReview = vi.fn(() => {
      events.push('spawn');
      return child;
    });
    const trackChild = vi.fn(() => { events.push('track'); });
    const backend = new LocalSessionExecutionBackend({
      spawnImplementation,
      spawnExactHeadReview,
      trackChild,
    });

    await expect(backend.start(reviewRequest())).resolves.toEqual({
      status: 'started',
      backend: 'local',
      pid: 5678,
    });
    expect(spawnImplementation).not.toHaveBeenCalled();
    expect(events).toEqual(['spawn', 'pid', 'track', 'pid']);
  });

  it('local start rejects a missing PID before tracking an exact-head review child', async () => {
    const trackChild = vi.fn();
    const backend = new LocalSessionExecutionBackend({
      spawnImplementation: vi.fn(),
      spawnExactHeadReview: vi.fn(() => ({ pid: undefined })),
      trackChild,
    });

    await expect(backend.start(reviewRequest())).rejects.toThrow(
      'Review coordinator did not report a child PID',
    );
    expect(trackChild).not.toHaveBeenCalled();
  });

  it('preserves distinct missing-PID diagnostics for root and child implementation workflows', async () => {
    const trackChild = vi.fn();
    const backend = new LocalSessionExecutionBackend({
      spawnImplementation: vi.fn(() => ({ pid: undefined })),
      spawnExactHeadReview: vi.fn(),
      trackChild,
    });

    await expect(backend.start(implementationRequest())).rejects.toThrow(
      'Implementation coordinator did not report a child PID',
    );
    await expect(backend.start({
      ...implementationRequest(),
      workflow: 'ci-failure',
    })).rejects.toThrow(
      'Child coordinator did not report a child PID',
    );
    expect(trackChild).not.toHaveBeenCalled();
  });

  it('reports existing local recovery and cancellation as unsupported rather than inventing control behavior', async () => {
    const backend = new LocalSessionExecutionBackend({
      spawnImplementation: vi.fn(),
      spawnExactHeadReview: vi.fn(),
      trackChild: vi.fn(),
    });

    await expect(backend.recover(implementationRequest())).resolves.toEqual({
      status: 'unsupported',
      backend: 'local',
      operation: 'recover',
    });
    await expect(backend.cancel(reviewRequest())).resolves.toEqual({
      status: 'unsupported',
      backend: 'local',
      operation: 'cancel',
    });
  });

  it('verifies, submits, and durably records a marketplace task before returning its persisted identity', async () => {
    const fixture = marketplaceFixture();
    const submit = vi.fn(async () => SUBMISSION);
    const recover = vi.fn(async () => {
      throw new Error('recovery must not run during start');
    });
    const backend = new MarketplaceSessionExecutionBackend({
      adapter: { submit, recover },
      now: () => new Date('2026-07-26T12:02:00.000Z'),
    });

    await expect(backend.start(fixture.request)).resolves.toEqual({
      status: 'started',
      backend: 'marketplace',
      id: `autopilot:${ATTEMPT_ID}`,
      taskId: SUBMISSION.taskId,
      taskCid: SUBMISSION.taskCid,
    });
    expect(submit).toHaveBeenCalledWith(fixture.requestPath);
    expect(recover).not.toHaveBeenCalled();
    expect(readAttemptManifest(fixture.manifest.paths.manifest).execution)
      .toMatchObject({
        backend: 'marketplace',
        state: {
          status: 'submitted',
          submission: SUBMISSION,
          submittedAt: '2026-07-26T12:02:00.000Z',
        },
      });
  });

  it.each(['missing', 'modified'] as const)(
    'rejects a %s immutable request artifact before invoking the marketplace CLI',
    async (failure) => {
      const fixture = marketplaceFixture();
      if (failure === 'missing') {
        rmSync(fixture.requestPath);
      } else {
        writeFileSync(fixture.requestPath, '{}\n', { mode: 0o600 });
      }
      const submit = vi.fn(async () => SUBMISSION);
      const backend = new MarketplaceSessionExecutionBackend({
        adapter: { submit, recover: vi.fn(async () => SUBMISSION) },
      });

      await expect(backend.start(fixture.request)).rejects.toThrow(
        failure === 'missing' ? /marketplace task request/i : /digest mismatch/i,
      );
      expect(submit).not.toHaveBeenCalled();
      expect(readAttemptManifest(fixture.manifest.paths.manifest).execution)
        .toMatchObject({ backend: 'marketplace', state: { status: 'prepared' } });
    },
  );

  it('recovers a crash after CLI success by replaying the exact bytes and converging on a matching duplicate', async () => {
    const fixture = marketplaceFixture();
    const before = readFileSync(fixture.requestPath);
    const submit = vi.fn(async () => SUBMISSION);
    const crashed = new MarketplaceSessionExecutionBackend({
      adapter: { submit, recover: vi.fn(async () => SUBMISSION) },
      transitionMarketplaceExecution: () => {
        throw new Error('injected crash before manifest bookkeeping');
      },
    });

    await expect(crashed.start(fixture.request)).rejects.toThrow(
      'injected crash before manifest bookkeeping',
    );
    expect(readAttemptManifest(fixture.manifest.paths.manifest).execution)
      .toMatchObject({ backend: 'marketplace', state: { status: 'prepared' } });

    const duplicate = {
      ...SUBMISSION,
      status: 'already_submitted',
      idempotent: true,
    } as const;
    const recover = vi.fn(async () => duplicate);
    const restarted = new MarketplaceSessionExecutionBackend({
      adapter: { submit: vi.fn(async () => SUBMISSION), recover },
      now: () => new Date('2026-07-26T12:03:00.000Z'),
    });
    await expect(restarted.recover(fixture.request)).resolves.toEqual({
      status: 'started',
      backend: 'marketplace',
      id: `autopilot:${ATTEMPT_ID}`,
      taskId: SUBMISSION.taskId,
      taskCid: SUBMISSION.taskCid,
    });
    expect(recover).toHaveBeenCalledWith(fixture.requestPath);
    expect(readFileSync(fixture.requestPath)).toEqual(before);
    expect(readAttemptManifest(fixture.manifest.paths.manifest).execution)
      .toMatchObject({
        backend: 'marketplace',
        state: { status: 'submitted', submission: duplicate },
      });
  });

  it('returns a submitted task from durable state without invoking either CLI operation', async () => {
    const fixture = marketplaceFixture('submitted');
    rmSync(fixture.manifest.paths.worktree, { recursive: true });
    const submit = vi.fn(async () => {
      throw new Error('submitted recovery must not submit');
    });
    const recover = vi.fn(async () => {
      throw new Error('submitted recovery must not replay');
    });
    const backend = new MarketplaceSessionExecutionBackend({
      adapter: { submit, recover },
    });

    await expect(backend.recover(fixture.request)).resolves.toEqual({
      status: 'started',
      backend: 'marketplace',
      id: `autopilot:${ATTEMPT_ID}`,
      taskId: SUBMISSION.taskId,
      taskCid: SUBMISSION.taskCid,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it('rejects a submitted manifest whose persisted result contradicts the verified request identity', async () => {
    const fixture = marketplaceFixture('submitted');
    const raw = JSON.parse(
      readFileSync(fixture.manifest.paths.manifest, 'utf8'),
    ) as {
      execution: {
        state: { submission: { id: string } };
      };
    };
    raw.execution.state.submission.id =
      'autopilot:22222222-2222-4222-8222-222222222222';
    writeFileSync(
      fixture.manifest.paths.manifest,
      `${JSON.stringify(raw, null, 2)}\n`,
      { mode: 0o600 },
    );
    const submit = vi.fn(async () => SUBMISSION);
    const recover = vi.fn(async () => SUBMISSION);
    const backend = new MarketplaceSessionExecutionBackend({
      adapter: { submit, recover },
    });

    await expect(backend.recover(fixture.request)).rejects.toThrow(
      /persisted submission.*request identity/i,
    );
    expect(submit).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it('rejects an uncorrelated CLI result without changing prepared state', async () => {
    const fixture = marketplaceFixture();
    const backend = new MarketplaceSessionExecutionBackend({
      adapter: {
        submit: vi.fn(async () => ({
          ...SUBMISSION,
          id: 'autopilot:22222222-2222-4222-8222-222222222222',
        })),
        recover: vi.fn(async () => SUBMISSION),
      },
    });

    await expect(backend.start(fixture.request)).rejects.toThrow(
      /submission result.*request identity/i,
    );
    expect(readAttemptManifest(fixture.manifest.paths.manifest).execution)
      .toMatchObject({ backend: 'marketplace', state: { status: 'prepared' } });
  });

  it('fails closed when replay returns a result that contradicts committed terminal evidence', async () => {
    const fixture = marketplaceFixture();
    const preparedBytes = readFileSync(fixture.manifest.paths.manifest);
    transitionMarketplaceExecution(
      fixture.manifest.paths.manifest,
      fixture.requestDigest,
      { status: 'submitted', submission: SUBMISSION },
      () => new Date('2026-07-26T12:02:00.000Z'),
    );
    writeFileSync(fixture.manifest.paths.manifest, preparedBytes);
    const backend = new MarketplaceSessionExecutionBackend({
      adapter: {
        submit: vi.fn(async () => SUBMISSION),
        recover: vi.fn(async () => ({
          ...SUBMISSION,
          taskId: 'contradictory-task',
          status: 'already_submitted' as const,
          idempotent: true as const,
        })),
      },
      now: () => new Date('2026-07-26T12:03:00.000Z'),
    });

    await expect(backend.recover(fixture.request)).rejects.toThrow(
      /contradictory submission/i,
    );
    expect(readAttemptManifest(fixture.manifest.paths.manifest).execution)
      .toMatchObject({ backend: 'marketplace', state: { status: 'prepared' } });
  });

  it('records cancellation as durable local intent without invoking the CLI', async () => {
    const fixture = marketplaceFixture();
    const submit = vi.fn(async () => SUBMISSION);
    const recover = vi.fn(async () => SUBMISSION);
    const backend = new MarketplaceSessionExecutionBackend({
      adapter: { submit, recover },
      now: () => new Date('2026-07-26T12:02:00.000Z'),
    });

    await expect(backend.cancel(fixture.request)).resolves.toEqual({
      status: 'cancelled',
      backend: 'marketplace',
      reason: MARKETPLACE_CANCEL_INTENT_REASON,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(readAttemptManifest(fixture.manifest.paths.manifest).execution)
      .toMatchObject({
        backend: 'marketplace',
        state: {
          status: 'cancelled',
          reason: MARKETPLACE_CANCEL_INTENT_REASON,
        },
      });
  });

  it('fails closed when recovery is attempted from cancelled state', async () => {
    const fixture = marketplaceFixture('cancelled');
    const recover = vi.fn(async () => SUBMISSION);
    const backend = new MarketplaceSessionExecutionBackend({
      adapter: { submit: vi.fn(async () => SUBMISSION), recover },
    });

    await expect(backend.recover(fixture.request)).rejects.toThrow(
      /cancelled marketplace execution/i,
    );
    expect(recover).not.toHaveBeenCalled();
  });

  it('recovers prepared marketplace attempts across runner directories and skips terminal or local attempts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autopilot-marketplace-recovery-'));
    roots.push(root);
    const v2Base = join(root, 'v2');
    const preparedPrior = marketplaceRecoveryFixture(v2Base, {
      runnerId: 'runner-prior',
      attemptId: '11111111-1111-4111-8111-111111111112',
      state: 'prepared',
    });
    const preparedCurrent = marketplaceRecoveryFixture(v2Base, {
      runnerId: 'runner-current',
      attemptId: '11111111-1111-4111-8111-111111111113',
      state: 'prepared',
    });
    marketplaceRecoveryFixture(v2Base, {
      runnerId: 'runner-submitted',
      attemptId: '11111111-1111-4111-8111-111111111114',
      state: 'submitted',
    });
    marketplaceRecoveryFixture(v2Base, {
      runnerId: 'runner-cancelled',
      attemptId: '11111111-1111-4111-8111-111111111115',
      state: 'cancelled',
    });
    marketplaceRecoveryFixture(v2Base, {
      runnerId: 'runner-local',
      attemptId: '11111111-1111-4111-8111-111111111116',
      state: 'local',
    });
    const recover = vi.fn(async (requestPath: string) => {
      const request = JSON.parse(readFileSync(requestPath, 'utf8')) as {
        readonly id: string;
      };
      return {
        ...SUBMISSION,
        id: request.id,
        taskId: `task-${request.id}`,
        status: 'already_submitted' as const,
        idempotent: true as const,
      };
    });
    const backend = new MarketplaceSessionExecutionBackend({
      adapter: { submit: vi.fn(async () => SUBMISSION), recover },
      now: () => new Date('2026-07-26T12:03:00.000Z'),
    });

    const recovered = await recoverPreparedMarketplaceAttempts(v2Base, backend);

    expect(recovered).toHaveLength(2);
    expect(recover.mock.calls.map(([path]) => path).sort()).toEqual([
      preparedCurrent.requestPath,
      preparedPrior.requestPath,
    ].sort());
    expect(readAttemptManifest(preparedPrior.manifest.paths.manifest).execution)
      .toMatchObject({ backend: 'marketplace', state: { status: 'submitted' } });
    expect(readAttemptManifest(preparedCurrent.manifest.paths.manifest).execution)
      .toMatchObject({ backend: 'marketplace', state: { status: 'submitted' } });
  });

  it('stops marketplace recovery on an invalid prepared artifact before replaying later attempts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autopilot-marketplace-recovery-'));
    roots.push(root);
    const v2Base = join(root, 'v2');
    const invalid = marketplaceRecoveryFixture(v2Base, {
      runnerId: 'runner-a',
      attemptId: '11111111-1111-4111-8111-111111111117',
      state: 'prepared',
    });
    marketplaceRecoveryFixture(v2Base, {
      runnerId: 'runner-b',
      attemptId: '11111111-1111-4111-8111-111111111118',
      state: 'prepared',
    });
    writeFileSync(invalid.requestPath, '{}\n', { mode: 0o600 });
    const recover = vi.fn(async () => SUBMISSION);
    const backend = new MarketplaceSessionExecutionBackend({
      adapter: { submit: vi.fn(async () => SUBMISSION), recover },
    });

    await expect(
      recoverPreparedMarketplaceAttempts(v2Base, backend),
    ).rejects.toThrow(/digest mismatch/i);
    expect(recover).not.toHaveBeenCalled();
  });

  it.each(['worktree', 'git-marker'] as const)(
    'rejects a prepared crash state with a missing %s before marketplace replay',
    async (missing) => {
      const root = mkdtempSync(join(tmpdir(), 'autopilot-marketplace-recovery-'));
      roots.push(root);
      const v2Base = join(root, 'v2');
      const fixture = marketplaceRecoveryFixture(v2Base, {
        runnerId: 'runner-a',
        attemptId: '11111111-1111-4111-8111-111111111119',
        state: 'prepared',
      });
      if (missing === 'worktree') {
        rmSync(fixture.manifest.paths.worktree, { recursive: true });
      } else {
        rmSync(join(fixture.manifest.paths.worktree, '.git'));
      }
      const recover = vi.fn(async () => fixture.submission);
      const backend = new MarketplaceSessionExecutionBackend({
        adapter: { submit: vi.fn(async () => fixture.submission), recover },
      });

      await expect(
        recoverPreparedMarketplaceAttempts(v2Base, backend),
      ).rejects.toThrow(/marketplace.*worktree.*initialized/i);
      expect(recover).not.toHaveBeenCalled();
    },
  );

  it('rejects a schema-valid immutable request with an unsupported marketplace profile before replay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autopilot-marketplace-recovery-'));
    roots.push(root);
    const v2Base = join(root, 'v2');
    marketplaceRecoveryFixture(v2Base, {
      runnerId: 'runner-a',
      attemptId: '11111111-1111-4111-8111-111111111120',
      state: 'prepared',
      profile: {
        repository: 'Other/repository',
        language: 'rust',
        verificationProfile: 'other.v1',
      },
    });
    const recover = vi.fn(async () => SUBMISSION);
    const backend = new MarketplaceSessionExecutionBackend({
      adapter: { submit: vi.fn(async () => SUBMISSION), recover },
    });

    await expect(
      recoverPreparedMarketplaceAttempts(v2Base, backend),
    ).rejects.toThrow(
      /supports only Jinn-Network\/mono.*typescript.*jinn-mono\.v1/i,
    );
    expect(recover).not.toHaveBeenCalled();
  });

  it('uses a backend discriminator that keeps local launch input out of marketplace methods', () => {
    const marketplace = new MarketplaceSessionExecutionBackend({
      adapter: {
        submit: vi.fn(async () => SUBMISSION),
        recover: vi.fn(async () => SUBMISSION),
      },
    });
    const local = new LocalSessionExecutionBackend({
      spawnImplementation: vi.fn(),
      spawnExactHeadReview: vi.fn(),
      trackChild: vi.fn(),
    });
    expectTypeOf<LocalSessionExecutionRequest>()
      .not.toMatchTypeOf<Parameters<typeof marketplace.start>[0]>();
    expectTypeOf<Parameters<typeof marketplace.start>[0]>()
      .toMatchTypeOf<MarketplaceSessionExecutionRequest>();
    expectTypeOf<MarketplaceSessionExecutionRequest>()
      .not.toMatchTypeOf<Parameters<typeof local.start>[0]>();
  });
});
