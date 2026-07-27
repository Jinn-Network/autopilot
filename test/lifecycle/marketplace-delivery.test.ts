import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildMarketplaceTaskRequest,
  persistMarketplaceTaskRequest,
} from '../../src/lifecycle/marketplace-task.js';
import { decodeAttemptManifest, readAttemptManifest } from '../../src/lifecycle/attempt-workspace.js';
import { observeMarketplaceSolutionDelivery } from '../../src/lifecycle/marketplace-delivery.js';

const ATTEMPT_ID = '123e4567-e89b-42d3-a456-426614174001';
const CLAIM = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'autopilot-marketplace-delivery-'));
  roots.push(root);
  const attemptDir = join(root, 'attempt');
  const worktree = join(attemptDir, 'worktree');
  mkdirSync(worktree, { recursive: true });
  const requestPath = join(attemptDir, 'marketplace-request.json');
  const built = buildMarketplaceTaskRequest({
    workflow: 'implementation', repository: 'Jinn-Network/mono', language: 'typescript',
    verificationProfile: 'jinn-mono.v1', issueNumber: 2001, prNumber: 2101,
    targetBase: 'next', branch: 'codex/issue-2001', claimOid: CLAIM, expectedHead: HEAD,
    v2AttemptId: ATTEMPT_ID, runnerId: 'runner-1',
    taskSnapshot: { title: 'Implement exact marketplace contracts', body: 'Add the approved contract surface.', prBody: 'Draft implementation PR.', baseSha: '3'.repeat(40), targetBaseOid: '3'.repeat(40) },
    receiptAuthors: ['jinn-autopilot'], createdAt: Date.parse('2026-07-26T12:00:00.000Z'),
  });
  const persisted = persistMarketplaceTaskRequest(requestPath, built.request);
  const submission = {
    schemaVersion: 1, generatedAt: '2026-07-26T12:01:00.000Z', verb: 'tasks submit',
    id: `autopilot:${ATTEMPT_ID}`, creatorMultisig: `0x${'a'.repeat(40)}`,
    taskId: '501', taskCid: 'bafy-task', creationTx: `0x${'a'.repeat(64)}`,
    creationBlock: 100, solverNetManifestCid: 'bafy-solvernet', status: 'submitted', idempotent: false,
  } as const;
  const manifest = decodeAttemptManifest({
    version: 2, attemptId: ATTEMPT_ID, runnerId: 'runner-1', host: 'test-host', phase: 'implement',
    execution: { backend: 'marketplace', state: {
      schemaVersion: 'marketplace-execution-v3', status: 'submitted', requestPath,
      requestDigest: persisted.requestDigest, solverNetSelectionPath: persisted.solverNetSelectionPath,
      preparedAt: '2026-07-26T12:00:00.000Z', agentSoftDeadline: built.agentSoftDeadline,
      adoptionDeadline: built.adoptionDeadline, submission, submittedAt: '2026-07-26T12:02:00.000Z',
    } },
    subject: 'issue-2001', issueNumber: 2001, prNumber: 2101, branch: 'codex/issue-2001',
    targetBase: 'next', targetBaseOid: '3'.repeat(40), expectedHead: HEAD, claimOid: CLAIM,
    selectedLogin: 'jinn-autopilot', repository: { root, gitCommonDir: root, remoteName: 'origin', remoteUrlHash: 'a'.repeat(64) },
    processState: 'preparing', pid: null,
    paths: { attemptDir, worktree, manifest: join(attemptDir, 'manifest.json'), log: join(attemptDir, 'session.log'), ghConfigDir: join(attemptDir, 'gh-config'), askpass: join(attemptDir, 'askpass'), tokenFile: join(attemptDir, 'token') },
    timestamps: { createdAt: '2026-07-26T12:00:00.000Z', updatedAt: '2026-07-26T12:02:00.000Z' },
  });
  writeFileSync(manifest.paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { attemptDir, manifestPath: manifest.paths.manifest };
}

function verifiedWrapper() {
  const observation = JSON.parse(readFileSync(
    join(process.cwd(), 'node_modules/@jinn-network/sdk/fixtures/autopilot/verified-solution.json'), 'utf8',
  )) as Record<string, unknown>;
  observation.session = {
    ...(observation.session as Record<string, unknown>),
    deadline: '2026-07-26T13:00:00.000Z',
  };
  return { schemaVersion: 1, generatedAt: '2026-07-27T12:00:00.000Z', verb: 'tasks observe-autopilot-delivery', observation };
}

describe('marketplace Solution delivery observation', () => {
  it('leaves the submitted state unchanged when the exact delivery is pending', async () => {
    const { manifestPath } = fixture();
    const before = readFileSync(manifestPath);

    await expect(observeMarketplaceSolutionDelivery(manifestPath, {
      jinnBinary: '/installed/bin/jinn',
      run: async () => ({ exitCode: 0, stdout: JSON.stringify({
        schemaVersion: 1, generatedAt: '2026-07-27T12:00:00.000Z',
        verb: 'tasks observe-autopilot-delivery',
        observation: { status: 'pending', reason: 'envelope-not-indexed', detail: 'not indexed' },
      }), stderr: '' }),
    })).resolves.toEqual({ status: 'pending', reason: 'envelope-not-indexed', detail: 'not indexed' });

    expect(readFileSync(manifestPath)).toEqual(before);
  });

  it('returns the exact typed contradiction without transitioning', async () => {
    const { manifestPath } = fixture();
    const before = readFileSync(manifestPath);

    await expect(observeMarketplaceSolutionDelivery(manifestPath, {
      jinnBinary: '/installed/bin/jinn',
      run: async () => ({ exitCode: 0, stdout: JSON.stringify({
        schemaVersion: 1, generatedAt: '2026-07-27T12:00:00.000Z',
        verb: 'tasks observe-autopilot-delivery',
        observation: { status: 'contradiction', reason: 'multiple-envelopes', detail: 'two exact rows' },
      }), stderr: '' }),
    })).resolves.toEqual({ status: 'contradiction', reason: 'multiple-envelopes', detail: 'two exact rows' });

    expect(readFileSync(manifestPath)).toEqual(before);
  });

  it('rejects a malformed success wrapper before mutating the manifest or worktree', async () => {
    const { attemptDir, manifestPath } = fixture();
    const worktreeFile = join(attemptDir, 'worktree', 'untouched.txt');
    writeFileSync(worktreeFile, 'unchanged\n');
    const before = readFileSync(manifestPath);

    await expect(observeMarketplaceSolutionDelivery(manifestPath, {
      jinnBinary: '/installed/bin/jinn',
      run: async () => ({ exitCode: 0, stdout: '{"schemaVersion":1}', stderr: 'diagnostic' }),
    })).rejects.toMatchObject({ name: 'MarketplaceMachineCliProtocolError', exitCode: 0 });

    expect(readFileSync(manifestPath)).toEqual(before);
    expect(readFileSync(worktreeFile, 'utf8')).toBe('unchanged\n');
    expect(() => statSync(join(attemptDir, 'marketplace-solution-observation.json'))).toThrow();
  });

  it('persists the strict expectation and authenticated observation before transitioning once', async () => {
    const { attemptDir, manifestPath } = fixture();
    const run = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify(verifiedWrapper()), stderr: '' }));

    const result = await observeMarketplaceSolutionDelivery(manifestPath, {
      jinnBinary: '/installed/bin/jinn', environment: { PATH: '/bin', GH_TOKEN: 'secret', GH_CONFIG_DIR: '/private/gh' }, run,
      now: () => new Date('2026-07-27T12:01:00.000Z'),
    });

    const expectationPath = join(attemptDir, 'marketplace-solution-expectation.json');
    expect(run).toHaveBeenCalledWith('/installed/bin/jinn', [
      'tasks', 'observe-autopilot-delivery', '--expectation-file', expectationPath, '--json',
    ], { environment: { PATH: '/bin', NO_COLOR: '1' } });
    expect(statSync(expectationPath).mode & 0o777).toBe(0o600);
    expect(result.status).toBe('verified');
    if (result.status !== 'verified') throw new Error('expected verified result');
    expect(statSync(result.observationPath).mode & 0o777).toBe(0o600);
    expect(result.observationDigest).toBe(`sha256:${createHash('sha256').update(readFileSync(result.observationPath)).digest('hex')}`);
    const persisted = readAttemptManifest(manifestPath);
    if (persisted.execution.backend !== 'marketplace') throw new Error('expected marketplace attempt');
    expect(persisted.execution.state).toMatchObject({ status: 'solution-observed', delivery: { observationPath: result.observationPath, observationDigest: result.observationDigest } });
  });

  it('pins a retry to the prior delivery and reuses byte-identical evidence', async () => {
    const { attemptDir, manifestPath } = fixture();
    const output = JSON.stringify(verifiedWrapper());
    const run = vi.fn(async () => ({ exitCode: 0, stdout: output, stderr: '' }));
    const options = { jinnBinary: '/installed/bin/jinn', run, now: vi.fn()
      .mockReturnValueOnce(new Date('2026-07-27T12:01:00.000Z'))
      .mockReturnValueOnce(new Date('2026-07-27T12:01:00.000Z'))
      .mockReturnValueOnce(new Date('2026-07-27T12:02:00.000Z')) };

    const first = await observeMarketplaceSolutionDelivery(manifestPath, options);
    const second = await observeMarketplaceSolutionDelivery(manifestPath, options);

    expect(first).toMatchObject({ status: 'verified' });
    expect(second).toEqual(first);
    const expectation = JSON.parse(readFileSync(join(attemptDir, 'marketplace-solution-expectation.json'), 'utf8')) as Record<string, unknown>;
    expect(expectation).toMatchObject({ attemptIndex: 0, requestId: `0x${'1'.repeat(64)}`, deliveryEnvelopeCid: 'bafy-envelope-solution', deliveryTransactionHash: `0x${'d'.repeat(64)}`, deliveryBlockNumber: 102, solutionOperator: `0x${'1'.repeat(40)}` });
  });

  it('rejects a second valid-looking delivery identity before replacing immutable evidence', async () => {
    const { attemptDir, manifestPath } = fixture();
    const first = JSON.stringify(verifiedWrapper());
    const secondWrapper = verifiedWrapper();
    const observation = secondWrapper.observation as Record<string, unknown>;
    const attempt = observation.attempt as Record<string, unknown>;
    const result = observation.result as Record<string, unknown>;
    const correlation = observation.correlation as Record<string, unknown>;
    const resultCorrelation = result.correlation as Record<string, unknown>;
    const alternate = `0x${'f'.repeat(64)}`;
    attempt.requestId = alternate;
    correlation.requestId = alternate;
    resultCorrelation.requestId = alternate;
    const outputs = [first, JSON.stringify(secondWrapper)];
    const run = vi.fn(async () => ({ exitCode: 0, stdout: outputs.shift()!, stderr: '' }));
    const options = { jinnBinary: '/installed/bin/jinn', run, now: () => new Date('2026-07-27T12:01:00.000Z') };

    const accepted = await observeMarketplaceSolutionDelivery(manifestPath, options);
    const bytes = readFileSync(join(attemptDir, 'marketplace-solution-observation.json'));
    await expect(observeMarketplaceSolutionDelivery(manifestPath, options))
      .rejects.toThrow('Marketplace Solution observation contradicts pinned delivery identity');

    expect(readFileSync(join(attemptDir, 'marketplace-solution-observation.json'))).toEqual(bytes);
    expect(accepted.status).toBe('verified');
  });
});
