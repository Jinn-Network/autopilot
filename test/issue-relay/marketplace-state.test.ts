import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { relayGeneration, relayTaskKey } from '../../src/issue-relay/identity.js';
import {
  buildRelaySolutionExpectation,
  installVerifiedRelayObservation,
  persistRelaySolutionExpectation,
  persistRelaySubmissionEvidence,
  readVerifiedRelayObservation,
  verifyRelaySolutionExpectation,
} from '../../src/issue-relay/marketplace-state.js';
import { buildRelaySnapshot } from '../../src/issue-relay/snapshot.js';
import { buildRelayTaskSpec } from '../../src/issue-relay/task.js';
import type {
  IssueRelayDeliveryObservation,
  RelaySubmissionEvidence,
} from '../../src/issue-relay/marketplace-cli.js';

const temporaryDirectories: string[] = [];
const base = '1'.repeat(40);
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
    title: 'Persist exact delivery state',
    body: 'Install only authenticated solution observations.',
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
const round = buildRelayTaskSpec({
  snapshot,
  round: 0,
  purpose: 'initial',
  workspaceRepository: 'Jinn-Network/mono',
  inputHead: base,
  findings: [],
}).spec.relay;
const submission: RelaySubmissionEvidence = {
  id: relayTaskKey(relayGeneration(snapshot), 0),
  taskId: '501',
  taskCid: `f01551220${'c'.repeat(64)}`,
  creationTx: `0x${'b'.repeat(64)}`,
  creationBlock: 100,
  solverNetManifestCid: 'bafy-solver-net',
  idempotent: false,
};
const observation: Extract<
  IssueRelayDeliveryObservation,
  { readonly status: 'verified' }
> = {
  status: 'verified',
  role: 'solution',
  task: {
    taskId: submission.taskId,
    taskCid: submission.taskCid,
  },
  attempt: {
    attemptIndex: 0,
    requestId: `0x${'d'.repeat(64)}`,
    operator: `0x${'e'.repeat(40)}`,
  },
  delivery: {
    envelopeCid: 'bafy-delivery',
    transactionHash: `0x${'f'.repeat(64)}`,
    blockNumber: 120,
  },
  round,
  payload: {
    schemaVersion: 'jinn-repo-solution.v1',
    patch: 'diff --git a/a.ts b/a.ts\n',
  },
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function statePaths() {
  const directory = mkdtempSync(join(tmpdir(), 'autopilot-relay-state-'));
  temporaryDirectories.push(directory);
  return {
    submissionPath: join(directory, 'submission.json'),
    expectationPath: join(directory, 'expectation.json'),
    observationPath: join(directory, 'observation.json'),
  };
}

describe('Relay submission and solution expectation state', () => {
  it('persists exact idempotent submission evidence and builds the Task 6 solution expectation', () => {
    const paths = statePaths();
    const idempotent = { ...submission, idempotent: true };

    const submissionArtifact =
      persistRelaySubmissionEvidence(paths.submissionPath, idempotent);
    expect(submissionArtifact.reused).toBe(false);
    expect(statSync(paths.submissionPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(paths.submissionPath, 'utf8'))).toEqual({
      schemaVersion: 'jinn-issue-relay-submission.v1',
      evidence: idempotent,
    });

    const expectation = buildRelaySolutionExpectation({
      submission: idempotent,
      round,
    });
    expect(expectation).toEqual({
      schemaVersion: 'jinn-issue-relay-delivery-expectation.v1',
      role: 'solution',
      taskId: '501',
      taskCid: submission.taskCid,
      creationBlockNumber: 100,
      round,
    });
    const expectationArtifact =
      persistRelaySolutionExpectation(paths.expectationPath, expectation);
    expect(expectationArtifact.reused).toBe(false);
    expect(statSync(paths.expectationPath).mode & 0o777).toBe(0o600);
    expect(verifyRelaySolutionExpectation(
      paths.expectationPath,
      expectationArtifact.digest,
    )).toEqual(expectation);
  });

  it('reuses byte-identical evidence and rejects conflicting or weakened expectation files', () => {
    const paths = statePaths();
    const first = persistRelaySubmissionEvidence(paths.submissionPath, submission);
    expect(persistRelaySubmissionEvidence(paths.submissionPath, submission)).toEqual({
      ...first,
      reused: true,
    });
    expect(() => persistRelaySubmissionEvidence(paths.submissionPath, {
      ...submission,
      taskId: '502',
    })).toThrow(/conflicts/i);

    const expectation = buildRelaySolutionExpectation({ submission, round });
    const artifact =
      persistRelaySolutionExpectation(paths.expectationPath, expectation);
    chmodSync(paths.expectationPath, 0o644);
    expect(() => verifyRelaySolutionExpectation(
      paths.expectationPath,
      artifact.digest,
    )).toThrow(/mode 0600/i);
  });
});

describe('Relay verified observation state', () => {
  it('installs exact verified solution bytes immutably after rereading expectation pins', () => {
    const paths = statePaths();
    const expectation = buildRelaySolutionExpectation({ submission, round });
    const expectationArtifact =
      persistRelaySolutionExpectation(paths.expectationPath, expectation);

    const artifact = installVerifiedRelayObservation({
      observationPath: paths.observationPath,
      expectationPath: paths.expectationPath,
      expectationDigest: expectationArtifact.digest,
      observation,
    });

    expect(artifact.reused).toBe(false);
    expect(statSync(paths.observationPath).mode & 0o777).toBe(0o600);
    expect(readVerifiedRelayObservation(
      paths.observationPath,
      artifact.digest,
    )).toEqual(observation);
    expect(installVerifiedRelayObservation({
      observationPath: paths.observationPath,
      expectationPath: paths.expectationPath,
      expectationDigest: expectationArtifact.digest,
      observation,
    })).toEqual({ ...artifact, reused: true });
  });

  it('rejects pending, wrong-role, stale task, stale round, and byte-conflicting observations', () => {
    const paths = statePaths();
    const expectationArtifact = persistRelaySolutionExpectation(
      paths.expectationPath,
      buildRelaySolutionExpectation({ submission, round }),
    );
    for (const candidate of [
      { status: 'pending', reason: 'delivery-not-found' },
      { ...observation, role: 'verdict' },
      {
        ...observation,
        task: { ...observation.task, taskId: '502' },
      },
      {
        ...observation,
        round: { ...observation.round, inputHead: '2'.repeat(40) },
      },
    ]) {
      expect(() => installVerifiedRelayObservation({
        observationPath: paths.observationPath,
        expectationPath: paths.expectationPath,
        expectationDigest: expectationArtifact.digest,
        observation: candidate as IssueRelayDeliveryObservation,
      })).toThrow(/verified solution|expectation|pin/i);
    }

    installVerifiedRelayObservation({
      observationPath: paths.observationPath,
      expectationPath: paths.expectationPath,
      expectationDigest: expectationArtifact.digest,
      observation,
    });
    writeFileSync(paths.observationPath, '{"attacker":true}\n', { mode: 0o600 });
    expect(() => installVerifiedRelayObservation({
      observationPath: paths.observationPath,
      expectationPath: paths.expectationPath,
      expectationDigest: expectationArtifact.digest,
      observation,
    })).toThrow(/conflicts/i);
  });

  it('rejects canonical expectation replacement against the independent digest pin', () => {
    const paths = statePaths();
    const artifact = persistRelaySolutionExpectation(
      paths.expectationPath,
      buildRelaySolutionExpectation({ submission, round }),
    );
    const replacement = JSON.parse(
      readFileSync(paths.expectationPath, 'utf8'),
    ) as { taskId: string };
    replacement.taskId = '502';
    writeFileSync(
      paths.expectationPath,
      `${JSON.stringify(replacement, null, 2)}\n`,
      { mode: 0o600 },
    );

    expect(() => installVerifiedRelayObservation({
      observationPath: paths.observationPath,
      expectationPath: paths.expectationPath,
      expectationDigest: artifact.digest,
      observation,
    })).toThrow(/digest mismatch/i);
  });
});
