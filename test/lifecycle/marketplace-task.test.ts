import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AutopilotSessionCapsuleSchema,
  TaskSubmitRequestV1Schema,
} from '@jinn-network/sdk/autopilot';
import {
  buildMarketplaceTaskRequest,
  MarketplaceTaskCliAdapter,
  MarketplaceTaskCliFailure,
  MarketplaceTaskCliProtocolError,
  persistMarketplaceTaskRequest,
  resolveInstalledJinnBinary,
  verifyMarketplaceTaskRequest,
  type MarketplaceTaskBuildInput,
  type MarketplaceTaskSubprocess,
} from '../../src/lifecycle/marketplace-task.js';

const CREATED_AT = Date.parse('2026-07-26T12:00:00.000Z');
const ATTEMPT_ID = '123e4567-e89b-42d3-a456-426614174001';
const temporaryDirectories: string[] = [];
const activeMarketplaceTaskWriters = new Map<ChildProcess, Promise<void>>();

interface MarketplaceTaskWriterHandle {
  readonly ready: Promise<void>;
  readonly result: Promise<{
    readonly ok: boolean;
    readonly artifact?: { readonly requestDigest: string };
    readonly error?: string;
  }>;
}

function startMarketplaceTaskWriterProcess(
  command: string,
  args: readonly string[],
  readyTimeoutMs = 10_000,
): MarketplaceTaskWriterHandle {
  const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });
  activeMarketplaceTaskWriters.set(child, closed);
  void closed.then(() => {
    activeMarketplaceTaskWriters.delete(child);
  });
  let stdout = '';
  let stderr = '';
  let markReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let readySettled = false;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    rejectReady = reject;
  });
  const readyTimeout = setTimeout(() => {
    if (readySettled) return;
    readySettled = true;
    rejectReady?.(new Error(
      `Marketplace Task writer did not become ready within ${readyTimeoutMs}ms`,
    ));
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }, readyTimeoutMs);
  readyTimeout.unref();
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    if (!readySettled && stdout.startsWith('ready\n')) {
      readySettled = true;
      clearTimeout(readyTimeout);
      markReady?.();
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const result = new Promise<{
    readonly ok: boolean;
    readonly artifact?: { readonly requestDigest: string };
    readonly error?: string;
  }>((resolve, reject) => {
    child.on('error', (error) => {
      clearTimeout(readyTimeout);
      if (!readySettled) {
        readySettled = true;
        rejectReady?.(error);
      }
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(readyTimeout);
      if (!readySettled) {
        readySettled = true;
        rejectReady?.(new Error(
          `Marketplace Task writer exited before ready `
          + `(code ${code ?? 'null'}, signal ${signal ?? 'none'}): ${stderr}`,
        ));
      }
      try {
        const line = stdout.trimEnd().split('\n').at(-1) ?? '';
        resolve(JSON.parse(line) as {
          readonly ok: boolean;
          readonly artifact?: { readonly requestDigest: string };
          readonly error?: string;
        });
      } catch {
        reject(new Error(`Marketplace Task writer returned malformed output: ${stderr}`));
      }
    });
  });
  return { ready, result };
}

function startMarketplaceTaskWriter(
  input: Record<string, unknown>,
): MarketplaceTaskWriterHandle {
  return startMarketplaceTaskWriterProcess(process.execPath, [
    join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
    join(process.cwd(), 'test/lifecycle/marketplace-task-writer.ts'),
    JSON.stringify(input),
  ]);
}

afterEach(async () => {
  const active = [...activeMarketplaceTaskWriters.entries()];
  for (const [child] of active) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
  await Promise.all(active.map(([, closed]) => closed));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function buildInput(
  overrides: Partial<MarketplaceTaskBuildInput> = {},
): MarketplaceTaskBuildInput {
  return {
    workflow: 'implementation',
    repository: 'Jinn-Network/mono',
    language: 'typescript',
    verificationProfile: 'jinn-mono.v1',
    issueNumber: 2001,
    prNumber: 2101,
    targetBase: 'next',
    branch: 'codex/issue-2001',
    claimOid: '1'.repeat(40),
    expectedHead: '2'.repeat(40),
    v2AttemptId: ATTEMPT_ID,
    runnerId: 'runner-1',
    taskSnapshot: {
      title: 'Implement exact marketplace contracts',
      body: 'Add the approved contract surface.',
      prBody: 'Draft implementation PR.',
      baseSha: '3'.repeat(40),
      targetBaseOid: '4'.repeat(40),
    },
    receiptAuthors: ['jinn-implementer', 'jinn-reviewer'],
    createdAt: CREATED_AT,
    ...overrides,
  };
}

describe('marketplace Task request builder', () => {
  it('builds the fixed implementation profile and default one-shot timing policy through SDK contracts', () => {
    const built = buildMarketplaceTaskRequest(buildInput());

    expect(AutopilotSessionCapsuleSchema.parse(built.session)).toEqual(built.session);
    expect(TaskSubmitRequestV1Schema.parse(built.request)).toEqual(built.request);
    expect(built).toEqual({
      session: {
        schemaVersion: 'jinn-autopilot-session.v1',
        workflow: 'implement',
        workflowContract: {
          skill: 'implement-issue',
          version: 'v2',
          resultSchema: 'jinn-autopilot-mutation-result.v1',
        },
        repository: 'Jinn-Network/mono',
        language: 'typescript',
        verificationProfile: 'jinn-mono.v1',
        issueNumber: 2001,
        prNumber: 2101,
        targetBase: 'next',
        branch: 'codex/issue-2001',
        claimOid: '1'.repeat(40),
        expectedHead: '2'.repeat(40),
        v2AttemptId: ATTEMPT_ID,
        runnerId: 'runner-1',
        taskSnapshot: {
          title: 'Implement exact marketplace contracts',
          body: 'Add the approved contract surface.',
          prBody: 'Draft implementation PR.',
          baseSha: '3'.repeat(40),
          targetBaseOid: '4'.repeat(40),
        },
        deadline: '2026-07-26T13:00:00.000Z',
        receiptAuthors: ['jinn-implementer', 'jinn-reviewer'],
      },
      request: {
        schemaVersion: 'jinn-task-submit-request.v1',
        id: `autopilot:${ATTEMPT_ID}`,
        description: 'Implement exact marketplace contracts',
        solverType: 'jinn-repo.v1',
        solverNet: 'jinn-repo.v1',
        createdAt: CREATED_AT,
        window: {
          startTs: CREATED_AT,
          endTs: Date.parse('2026-07-26T13:30:00.000Z'),
        },
        claimPolicy: {
          mode: 'exclusive',
          maxClaims: 1,
          maxClaimsPerOperator: 1,
          claimWindowStartTs: CREATED_AT,
          claimWindowEndTs: Date.parse('2026-07-26T12:15:00.000Z'),
          submissionDeadlineTs: Date.parse('2026-07-26T13:30:00.000Z'),
          claimLeaseTtlSeconds: 60 * 60,
          requiredVerdicts: 1,
        },
        spec: {
          schemaVersion: 'jinn-repo.v1',
          instance_id: `autopilot:${ATTEMPT_ID}`,
          base_commit: '2'.repeat(40),
          problem_statement: 'Add the approved contract surface.',
          repo: 'Jinn-Network/mono',
          language: 'typescript',
          verificationProfile: 'jinn-mono.v1',
          source: 'autopilot-session',
          session: built.session,
        },
      },
      agentSoftDeadline: '2026-07-26T13:00:00.000Z',
      adoptionDeadline: '2026-07-26T13:30:00.000Z',
    });
  });

  it('preserves an empty task body while using the issue title as the required problem statement', () => {
    const input = buildInput({
      taskSnapshot: {
        ...buildInput().taskSnapshot,
        body: '',
      },
    });

    const built = buildMarketplaceTaskRequest(input);

    expect(built.session.taskSnapshot.body).toBe('');
    expect(built.request.spec.problem_statement)
      .toBe('Implement exact marketplace contracts');
    expect(TaskSubmitRequestV1Schema.parse(built.request)).toEqual(built.request);
  });

  it.each([
    ['review-finding', 'fix-child', 'fix-child'],
    ['reconcile', 'reconcile', 'reconcile'],
    ['ci-failure', 'ci-failure', 'fix-child'],
  ] as const)(
    'maps %s child work to the exact %s SDK workflow contract',
    (workflow, sdkWorkflow, skill) => {
      const built = buildMarketplaceTaskRequest(buildInput({
        workflow,
        issueNumber: 2001,
        childIssueNumber: 2002,
        parentPrNumber: 2101,
        prNumber: 2101,
      }));

      expect(built.session).toMatchObject({
        workflow: sdkWorkflow,
        workflowContract: {
          skill,
          version: 'v2',
          resultSchema: 'jinn-autopilot-mutation-result.v1',
        },
        issueNumber: 2001,
        childIssueNumber: 2002,
        parentPrNumber: 2101,
        prNumber: 2101,
      });
      expect(AutopilotSessionCapsuleSchema.parse(built.session)).toEqual(built.session);
      expect(TaskSubmitRequestV1Schema.parse(built.request)).toEqual(built.request);
    },
  );

  it('fails preflight construction outside the fixed profile or without exact child bindings', () => {
    for (const overrides of [
      { repository: 'Jinn-Network/autopilot' },
      { language: 'rust' },
      { verificationProfile: 'unit' },
    ]) {
      expect(() => buildMarketplaceTaskRequest(buildInput(overrides)))
        .toThrow(/Jinn-Network\/mono.*typescript.*jinn-mono\.v1/i);
    }

    expect(() => buildMarketplaceTaskRequest(buildInput({
      workflow: 'review-finding',
    }))).toThrow(/child issue.*parent PR/i);

    expect(() => buildMarketplaceTaskRequest(buildInput({
      workflow: 'implementation',
      childIssueNumber: 2002,
      parentPrNumber: 2101,
    }))).toThrow(/implementation.*child/i);
  });
});

describe('marketplace Task request artifact', () => {
  it('rejects writer readiness when the child exits before its ready signal', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'autopilot-marketplace-task-'));
    temporaryDirectories.push(directory);
    const originalCwd = process.cwd();
    let writer: ReturnType<typeof startMarketplaceTaskWriter>;
    try {
      process.chdir(directory);
      writer = startMarketplaceTaskWriter({});
    } finally {
      process.chdir(originalCwd);
    }
    const resultState = writer.result.then(
      () => 'resolved',
      () => 'rejected',
    );
    const readyState = await Promise.race([
      writer.ready.then(
        () => 'resolved',
        () => 'rejected',
      ),
      delay(250).then(() => 'hung'),
    ]);

    expect(readyState).toBe('rejected');
    await expect(resultState).resolves.toBe('rejected');
  });

  it('bounds writer readiness and terminates a child that never becomes ready', async () => {
    const writer = startMarketplaceTaskWriterProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000)'],
      50,
    );
    const resultState = writer.result.then(
      () => 'resolved',
      () => 'rejected',
    );

    await expect(writer.ready).rejects.toThrow(/did not become ready within 50ms/i);
    await expect(resultState).resolves.toBe('rejected');
    expect(activeMarketplaceTaskWriters.size).toBe(0);
  });

  it('durably writes canonical SDK-validated bytes with their digest and private mode', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autopilot-marketplace-task-'));
    temporaryDirectories.push(directory);
    const requestPath = join(directory, 'marketplace-request.json');
    const request = buildMarketplaceTaskRequest(buildInput()).request;
    const expectedBytes = Buffer.from(`${JSON.stringify(request, null, 2)}\n`);
    const expectedDigest =
      `sha256:${createHash('sha256').update(expectedBytes).digest('hex')}`;

    expect(persistMarketplaceTaskRequest(requestPath, request)).toEqual({
      requestPath,
      requestDigest: expectedDigest,
      solverNetSelectionPath: `${requestPath}.solvernet-selection.json`,
      reused: false,
    });
    expect(readFileSync(requestPath)).toEqual(expectedBytes);
    expect(statSync(requestPath).mode & 0o777).toBe(0o600);
  });

  it('reuses an existing exact byte match without rewriting it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autopilot-marketplace-task-'));
    temporaryDirectories.push(directory);
    const requestPath = join(directory, 'marketplace-request.json');
    const request = buildMarketplaceTaskRequest(buildInput()).request;
    const first = persistMarketplaceTaskRequest(requestPath, request);
    const before = statSync(requestPath, { bigint: true });

    expect(persistMarketplaceTaskRequest(requestPath, request)).toEqual({
      ...first,
      reused: true,
    });
    const after = statSync(requestPath, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
  });

  it('fails closed without replacing an existing conflicting writer', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autopilot-marketplace-task-'));
    temporaryDirectories.push(directory);
    const requestPath = join(directory, 'marketplace-request.json');
    const conflictingBytes = Buffer.from('{"writer":"concurrent-winner"}\n');
    writeFileSync(requestPath, conflictingBytes, { mode: 0o600 });
    const request = buildMarketplaceTaskRequest(buildInput()).request;

    expect(() => persistMarketplaceTaskRequest(requestPath, request))
      .toThrow(/conflicts with canonical bytes/i);
    expect(readFileSync(requestPath)).toEqual(conflictingBytes);
  });

  it('allows only one of two concurrent conflicting process writers to install immutable bytes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'autopilot-marketplace-task-'));
    temporaryDirectories.push(directory);
    const requestPath = join(directory, 'marketplace-request.json');
    const startPath = join(directory, 'start');
    const first = startMarketplaceTaskWriter({
      startPath,
      requestPath,
      request: buildMarketplaceTaskRequest(buildInput()).request,
    });
    const second = startMarketplaceTaskWriter({
      startPath,
      requestPath,
      request: buildMarketplaceTaskRequest(buildInput({
        taskSnapshot: {
          ...buildInput().taskSnapshot,
          title: 'A conflicting immutable request',
        },
      })).request,
    });

    await Promise.all([first.ready, second.ready]);
    writeFileSync(startPath, 'go\n', { mode: 0o600 });
    const results = await Promise.all([first.result, second.result]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)[0]?.error)
      .toMatch(/conflicts with canonical bytes/i);
    const installedDigest =
      `sha256:${createHash('sha256').update(readFileSync(requestPath)).digest('hex')}`;
    expect(results.find((result) => result.ok)?.artifact?.requestDigest)
      .toBe(installedDigest);
  });

  it('rereads and verifies the exact persisted digest before replay', () => {
    const directory = mkdtempSync(join(tmpdir(), 'autopilot-marketplace-task-'));
    temporaryDirectories.push(directory);
    const requestPath = join(directory, 'marketplace-request.json');
    const request = buildMarketplaceTaskRequest(buildInput()).request;
    const artifact = persistMarketplaceTaskRequest(requestPath, request);

    expect(verifyMarketplaceTaskRequest(
      artifact.requestPath,
      artifact.requestDigest,
    )).toEqual(request);

    writeFileSync(requestPath, `${readFileSync(requestPath, 'utf8')} `, { mode: 0o600 });
    expect(() => verifyMarketplaceTaskRequest(
      artifact.requestPath,
      artifact.requestDigest,
    )).toThrow(/digest mismatch/i);
  });
});

const SUBMITTED_RESULT = {
  schemaVersion: 1 as const,
  generatedAt: '2026-07-26T12:01:00.000Z',
  verb: 'tasks submit' as const,
  id: `autopilot:${ATTEMPT_ID}`,
  creatorMultisig: `0x${'1'.repeat(40)}`,
  taskId: '501',
  taskCid: 'bafy-task',
  creationTx: `0x${'a'.repeat(64)}`,
  creationBlock: 100,
  solverNetManifestCid: 'bafy-autopilot-manifest',
  status: 'submitted' as const,
  attemptId: '123e4567-e89b-42d3-a456-426614174020',
  attemptNumber: 1,
  idempotent: false,
};

describe('marketplace Task CLI adapter', () => {
  it('resolves the executable declared by the installed client package', () => {
    expect(realpathSync(resolveInstalledJinnBinary())).toContain(
      '/node_modules/@jinn-network/client/dist/bin/jinn.js',
    );
  });

  it('submits and recovers with the exact request-file command and no GitHub credential environment', async () => {
    const run = vi.fn<MarketplaceTaskSubprocess>(async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify(SUBMITTED_RESULT)}\n`,
      stderr: '',
    }));
    const adapter = new MarketplaceTaskCliAdapter({
      jinnBinary: '/installed/bin/jinn',
      environment: {
        PATH: '/installed/bin',
        JINN_CONFIG_HOME: '/operator/jinn',
        GH_TOKEN: 'must-not-leak',
        GITHUB_TOKEN: 'must-not-leak',
        JINN_IMPL_GH_TOKEN: 'must-not-leak',
        ACME_GITHUB_PAT: 'must-not-leak',
      },
      run,
    });
    const requestPath = '/attempts/one/marketplace-request.json';

    await expect(adapter.submit(requestPath)).resolves.toEqual(SUBMITTED_RESULT);
    await expect(adapter.recover(requestPath)).resolves.toEqual(SUBMITTED_RESULT);

    expect(run).toHaveBeenCalledTimes(2);
    for (const call of run.mock.calls) {
      expect(call[0]).toBe('/installed/bin/jinn');
      expect(call[1]).toEqual([
        'tasks',
        'submit',
        '--request-file',
        requestPath,
        '--yes',
        '--json',
      ]);
      expect(call[2]).toEqual({
        environment: {
          PATH: '/installed/bin',
          JINN_CONFIG_HOME: '/operator/jinn',
          NO_COLOR: '1',
        },
      });
    }
  });

  it('models the installed client dry-run plan separately from a submission result', async () => {
    const dryRunResult = {
      schemaVersion: 1,
      generatedAt: '2026-07-26T12:01:00.000Z',
      dryRun: true,
      verb: 'tasks submit',
      description: `Would post task 'autopilot:${ATTEMPT_ID}'`,
      plan: [{
        id: `autopilot:${ATTEMPT_ID}`,
        creatorMultisig: `0x${'1'.repeat(40)}`,
        txCount: 1,
        solverNetManifestCid: 'bafy-autopilot-manifest',
      }],
    };
    const run = vi.fn<MarketplaceTaskSubprocess>(async () => ({
      exitCode: 0,
      stdout: `${JSON.stringify(dryRunResult)}\n`,
      stderr: '',
    }));
    const adapter = new MarketplaceTaskCliAdapter({
      jinnBinary: '/installed/bin/jinn',
      environment: { PATH: '/installed/bin' },
      run,
    });
    const requestPath = '/attempts/one/marketplace-request.json';

    await expect(adapter.dryRun(requestPath)).resolves.toEqual(dryRunResult);
    expect(run.mock.calls[0]?.[1]).toEqual([
      'tasks',
      'submit',
      '--request-file',
      requestPath,
      '--dry-run',
      '--yes',
      '--json',
    ]);
  });

  it.each([
    'not-json',
    JSON.stringify({ status: 'submitted' }),
  ])('rejects malformed successful stdout as a CLI protocol error', async (stdout) => {
    const adapter = new MarketplaceTaskCliAdapter({
      jinnBinary: '/installed/bin/jinn',
      environment: { PATH: '/installed/bin' },
      run: async () => ({ exitCode: 0, stdout, stderr: 'diagnostic log' }),
    });

    const submission = adapter.submit('/attempts/one/marketplace-request.json');
    await expect(submission).rejects.toBeInstanceOf(MarketplaceTaskCliProtocolError);
    await expect(submission).rejects.toMatchObject({
      name: 'MarketplaceTaskCliProtocolError',
      exitCode: 0,
      stdout,
      stderr: 'diagnostic log',
    });
  });

  it('preserves the installed client nonzero failure code and exit classification', async () => {
    const envelope = {
      schemaVersion: 1,
      generatedAt: '2026-07-26T12:01:00.000Z',
      code: 'transient_error',
      exitCode: 40,
      message: 'RPC endpoint unavailable',
      hint: 'Retry later.',
      exampleCli: 'jinn tasks submit --request-file request.json --yes --json',
      details: { cause: 'timeout' },
    };
    const adapter = new MarketplaceTaskCliAdapter({
      jinnBinary: '/installed/bin/jinn',
      environment: { PATH: '/installed/bin' },
      run: async () => ({
        exitCode: 40,
        stdout: `${JSON.stringify(envelope)}\n`,
        stderr: 'rpc diagnostic',
      }),
    });

    const submission = adapter.submit('/attempts/one/marketplace-request.json');
    await expect(submission).rejects.toBeInstanceOf(MarketplaceTaskCliFailure);
    await expect(submission).rejects.toMatchObject({
      name: 'MarketplaceTaskCliFailure',
      code: 'transient_error',
      exitCode: 40,
      envelope,
      stderr: 'rpc diagnostic',
    });
  });

  it('accepts the SDK already-submitted idempotency result on exact replay', async () => {
    const alreadySubmitted = {
      ...SUBMITTED_RESULT,
      status: 'already_submitted' as const,
      idempotent: true,
    };
    const adapter = new MarketplaceTaskCliAdapter({
      jinnBinary: '/installed/bin/jinn',
      environment: { PATH: '/installed/bin' },
      run: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify(alreadySubmitted)}\n`,
        stderr: '',
      }),
    });

    await expect(adapter.recover('/attempts/one/marketplace-request.json'))
      .resolves.toEqual(alreadySubmitted);
  });
});
