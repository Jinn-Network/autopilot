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
  buildRelayVerdictExpectation,
  buildRelaySolutionExpectation,
  observeAndInstallRelayVerdict,
  persistRelayVerdictExpectation,
  installVerifiedRelayObservation,
  persistRelaySolutionExpectation,
  persistRelaySubmissionEvidence,
  readVerifiedRelayVerdictObservation,
  readVerifiedRelayObservation,
  verifyRelayVerdictExpectation,
  verifyRelaySolutionExpectation,
} from '../../src/issue-relay/marketplace-state.js';
import {
  aggregateRelayChecks,
  relayAdoptionReceiptDigest,
} from '../../src/issue-relay/checks.js';
import { buildRelaySnapshot } from '../../src/issue-relay/snapshot.js';
import { buildRelayTaskSpec } from '../../src/issue-relay/task.js';
import type { AcceptedRelayAdoption } from '../../src/issue-relay/adoption.js';
import type {
  IssueRelayEvaluationAnchorV1,
  IssueRelayVerdictV1,
} from '../../src/issue-relay/contracts.js';
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
    envelopeCid: `f01551220${'d'.repeat(64)}`,
    transactionHash: `0x${'f'.repeat(64)}`,
    blockNumber: 120,
  },
  round,
  payload: {
    schemaVersion: 'jinn-repo-solution.v1',
    patch: 'diff --git a/a.ts b/a.ts\n',
  },
};
const resultingHead = '2'.repeat(40);
const adoption: AcceptedRelayAdoption = {
  status: 'accepted',
  branch: 'jinn/issue-relay/example',
  resultingHead,
  prNumber: 68,
  receipt: {
    schemaVersion: 'jinn-issue-relay-adoption.v1',
    disposition: 'accepted',
    correlation: {
      generation: round.generation,
      round: round.round,
      snapshotDigest: round.snapshotDigest,
      taskId: observation.task.taskId,
      attemptIndex: observation.attempt.attemptIndex,
      requestId: observation.attempt.requestId,
      deliveryEnvelopeCid: observation.delivery.envelopeCid,
    },
    targetRepository: round.targetRepository,
    workspaceRepository: round.workspaceRepository,
    issueNumber: 42,
    prNumber: 68,
    headRef: 'jinn/issue-relay/example',
    inputHead: round.inputHead,
    resultingHead,
    patchDigest: `sha256:${'a'.repeat(64)}`,
    solutionSafe: observation.attempt.operator,
    adoptedAt: '2026-07-28T12:00:00.000Z',
  },
};
const checks = aggregateRelayChecks({
  head: resultingHead,
  branchRequiredChecks: [],
  profile: { name: 'jinn-mono.v1', requiredChecks: [] },
  checks: [],
});
const anchor: IssueRelayEvaluationAnchorV1 = {
  schemaVersion: 'jinn-issue-relay-evaluation-anchor.v1',
  correlation: adoption.receipt.correlation,
  targetRepository: adoption.receipt.targetRepository,
  workspaceRepository: adoption.receipt.workspaceRepository,
  prNumber: adoption.receipt.prNumber,
  targetBase: 'main',
  baseOid: base,
  headRef: adoption.receipt.headRef,
  evaluatedHead: adoption.receipt.resultingHead,
  adoptionReceiptDigest: relayAdoptionReceiptDigest(adoption),
  checksDigest: checks.digest,
  anchoredAt: '2026-07-28T12:10:00.000Z',
};
const verdict: IssueRelayVerdictV1 = {
  schemaVersion: 'jinn-issue-relay-verdict.v1',
  outcome: 'pass',
  correlation: adoption.receipt.correlation,
  evaluatedHead: resultingHead,
  summary: 'The complete adopted head satisfies the frozen issue.',
  findings: [],
};
const verdictObservation: IssueRelayDeliveryObservation = {
  status: 'verified',
  role: 'verdict',
  task: observation.task,
  attempt: {
    attemptIndex: observation.attempt.attemptIndex,
    requestId: observation.attempt.requestId,
    operator: `0x${'f'.repeat(40)}`,
  },
  delivery: {
    envelopeCid: `f01551220${'e'.repeat(64)}`,
    transactionHash: `0x${'1'.repeat(64)}`,
    blockNumber: 130,
  },
  round,
  payload: verdict,
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
    verdictExpectationPath: join(directory, 'verdict-expectation.json'),
    verdictObservationPath: join(directory, 'verdict-observation.json'),
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

describe('Relay authenticated verdict state', () => {
  it('persists a role-verdict expectation pinned to exact solution adoption and anchor facts', () => {
    const paths = statePaths();
    const expectation = buildRelayVerdictExpectation({
      solutionExpectation: buildRelaySolutionExpectation({ submission, round }),
      adoption,
      evaluationAnchor: anchor,
      checks,
    });

    expect(expectation).toEqual({
      schemaVersion: 'jinn-issue-relay-delivery-expectation.v1',
      role: 'verdict',
      taskId: submission.taskId,
      taskCid: submission.taskCid,
      creationBlockNumber: submission.creationBlock,
      round,
      attemptIndex: observation.attempt.attemptIndex,
      requestId: observation.attempt.requestId,
      deliveryEnvelopeCid: observation.delivery.envelopeCid,
      solutionOperatorSafe: observation.attempt.operator,
    });
    const artifact = persistRelayVerdictExpectation(
      paths.verdictExpectationPath,
      expectation,
    );
    expect(statSync(paths.verdictExpectationPath).mode & 0o777).toBe(0o600);
    expect(verifyRelayVerdictExpectation(
      paths.verdictExpectationPath,
      artifact.digest,
    )).toEqual(expectation);
  });

  it('uses the Task 7 observation port and installs only the exact authenticated verdict', async () => {
    const paths = statePaths();
    const calls: Array<{ path: string; digest: string }> = [];
    const result = await observeAndInstallRelayVerdict({
      marketplace: {
        async observe(path, digest) {
          calls.push({ path, digest });
          return verdictObservation;
        },
      },
      expectationPath: paths.verdictExpectationPath,
      observationPath: paths.verdictObservationPath,
      solutionExpectation: buildRelaySolutionExpectation({ submission, round }),
      adoption,
      evaluationAnchor: anchor,
      checks,
    });

    expect(calls).toEqual([{
      path: paths.verdictExpectationPath,
      digest: result.expectation.digest,
    }]);
    expect(readVerifiedRelayVerdictObservation(
      paths.verdictObservationPath,
      result.observation.digest,
    )).toEqual(verdictObservation);
  });

  it.each([
    [
      'evaluated head',
      {
        ...verdictObservation,
        payload: { ...verdict, evaluatedHead: '3'.repeat(40) },
      },
    ],
    [
      'full correlation',
      {
        ...verdictObservation,
        payload: {
          ...verdict,
          correlation: { ...verdict.correlation, requestId: `0x${'9'.repeat(64)}` },
        },
      },
    ],
    [
      'evaluator Safe distinctness',
      {
        ...verdictObservation,
        attempt: {
          ...verdictObservation.attempt,
          operator: `0x${'E'.repeat(40)}`,
        },
      },
    ],
    [
      'request facts',
      {
        ...verdictObservation,
        attempt: {
          ...verdictObservation.attempt,
          requestId: `0x${'8'.repeat(64)}`,
        },
      },
    ],
    [
      'delivery facts',
      {
        ...verdictObservation,
        task: { ...observation.task, taskId: '502' },
      },
    ],
  ])('rejects a verdict whose %s do not match the anchor', async (
    _label,
    candidate,
  ) => {
    const paths = statePaths();
    await expect(observeAndInstallRelayVerdict({
      marketplace: {
        async observe() {
          return candidate as IssueRelayDeliveryObservation;
        },
      },
      expectationPath: paths.verdictExpectationPath,
      observationPath: paths.verdictObservationPath,
      solutionExpectation: buildRelaySolutionExpectation({ submission, round }),
      adoption,
      evaluationAnchor: anchor,
      checks,
    })).rejects.toThrow(/verdict|correlation|operator|expectation|pin/i);
  });

  it('rejects replaced check and receipt digest bindings before invoking the CLI', async () => {
    const paths = statePaths();
    let calls = 0;
    const marketplace = {
      async observe(): Promise<IssueRelayDeliveryObservation> {
        calls += 1;
        return verdictObservation;
      },
    };

    await expect(observeAndInstallRelayVerdict({
      marketplace,
      expectationPath: paths.verdictExpectationPath,
      observationPath: paths.verdictObservationPath,
      solutionExpectation: buildRelaySolutionExpectation({ submission, round }),
      adoption,
      evaluationAnchor: { ...anchor, checksDigest: `sha256:${'8'.repeat(64)}` },
      checks,
    })).rejects.toThrow(/check/i);
    await expect(observeAndInstallRelayVerdict({
      marketplace,
      expectationPath: paths.verdictExpectationPath,
      observationPath: paths.verdictObservationPath,
      solutionExpectation: buildRelaySolutionExpectation({ submission, round }),
      adoption,
      evaluationAnchor: {
        ...anchor,
        adoptionReceiptDigest: `sha256:${'7'.repeat(64)}`,
      },
      checks,
    })).rejects.toThrow(/receipt/i);
    expect(calls).toBe(0);
  });
});
