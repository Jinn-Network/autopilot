import { access, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AutopilotDeliveryExpectationSchema,
  AutopilotSessionCapsuleSchema,
  TaskSubmitRequestV1Schema,
} from '@jinn-network/sdk/autopilot';

const localJinnBinary = fileURLToPath(
  new URL('../node_modules/.bin/jinn', import.meta.url),
);

const sessionCapsule = {
  schemaVersion: 'jinn-autopilot-session.v1',
  workflow: 'implement',
  workflowContract: {
    skill: 'implement-issue',
    version: 'v2',
    resultSchema: 'jinn-autopilot-mutation-result.v1',
  },
  repository: 'Jinn-Network/autopilot',
  language: 'typescript',
  verificationProfile: 'unit',
  issueNumber: 42,
  prNumber: 43,
  targetBase: 'main',
  branch: 'autopilot/issue-42',
  claimOid: 'a'.repeat(40),
  expectedHead: 'b'.repeat(40),
  v2AttemptId: 'e6507f48-4b9d-4a9e-9c32-9621f167c819',
  runnerId: 'runner-1',
  taskSnapshot: {
    title: 'Add marketplace seam',
    body: 'Use the published boundary.',
    prBody: 'Implements the backend seam.',
    baseSha: 'c'.repeat(40),
    targetBaseOid: 'd'.repeat(40),
  },
  deadline: '2023-11-14T22:13:23.000Z',
  receiptAuthors: ['jinn-bot'],
};

const taskSubmitRequest = {
  schemaVersion: 'jinn-task-submit-request.v1',
  id: `autopilot:${sessionCapsule.v2AttemptId}`,
  description: 'Marketplace-backed Autopilot implementation session.',
  solverType: 'jinn-repo.v1',
  solverNetManifestCid: 'bafy-marketplace-manifest',
  createdAt: 1_700_000_000_000,
  window: {
    startTs: 1_700_000_001_000,
    endTs: 1_700_000_005_000,
  },
  claimPolicy: {
    mode: 'exclusive',
    maxClaims: 1,
    maxClaimsPerOperator: 1,
    claimWindowStartTs: 1_700_000_001_000,
    claimWindowEndTs: 1_700_000_002_000,
    submissionDeadlineTs: 1_700_000_003_000,
    claimLeaseTtlSeconds: 60,
    requiredVerdicts: 1,
  },
  spec: {
    schemaVersion: 'jinn-repo.v1',
    instance_id: 'autopilot-attempt-42',
    base_commit: 'c'.repeat(40),
    problem_statement: 'Implement the requested marketplace backend seam.',
    repo: sessionCapsule.repository,
    language: sessionCapsule.language,
    verificationProfile: sessionCapsule.verificationProfile,
    source: 'autopilot-session',
    session: sessionCapsule,
  },
};

const deliveryExpectation = {
  schemaVersion: 'jinn-autopilot-delivery-observation-request.v1',
  role: 'solution',
  taskId: '123',
  taskCid: 'bafy-marketplace-task',
  creationBlockNumber: 456,
  session: sessionCapsule,
};

describe('published Autopilot marketplace boundary', () => {
  it('decodes representative public contracts through the Autopilot SDK path', () => {
    expect(AutopilotSessionCapsuleSchema.parse(sessionCapsule)).toMatchObject({
      workflow: 'implement',
      repository: 'Jinn-Network/autopilot',
    });
    expect(TaskSubmitRequestV1Schema.parse(taskSubmitRequest)).toMatchObject({
      id: `autopilot:${sessionCapsule.v2AttemptId}`,
      solverType: 'jinn-repo.v1',
    });
    expect(AutopilotDeliveryExpectationSchema.parse(deliveryExpectation)).toMatchObject({
      role: 'solution',
      taskId: '123',
    });
  });

  it('resolves the installed client jinn binary from local node_modules', async () => {
    await expect(access(localJinnBinary)).resolves.toBeUndefined();
    await expect(realpath(localJinnBinary)).resolves.toContain(
      '/node_modules/@jinn-network/client/dist/bin/jinn.js',
    );
  });
});
