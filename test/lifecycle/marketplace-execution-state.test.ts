import { describe, expect, it } from 'vitest';
import {
  decodeMarketplaceEvaluatorLegExecutionState,
  decodeMarketplaceExecutionV3State,
} from '../../src/lifecycle/marketplace-execution-state.js';

const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const REVIEW_ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const RUNNER_DIR = '/tmp/autopilot/v2/runner-a';
const ATTEMPT_DIR = `${RUNNER_DIR}/implement/issue-42-${ATTEMPT_ID}`;
const EVALUATOR_ATTEMPT_DIR =
  `${RUNNER_DIR}/review/pr-42-${REVIEW_ATTEMPT_ID}`;
const OID = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const DELIVERY_REQUEST_ID = `0x${'9'.repeat(64)}`;
const NOW = '2026-07-27T12:00:00.000Z';

const submission = {
  schemaVersion: 1,
  generatedAt: NOW,
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

const prepared = {
  schemaVersion: 'marketplace-execution-v3',
  status: 'prepared',
  requestPath: `${ATTEMPT_DIR}/marketplace-request.json`,
  requestDigest: DIGEST,
  solverNetSelectionPath: `${ATTEMPT_DIR}/marketplace-request.json.solvernet-selection.json`,
  preparedAt: NOW,
  agentSoftDeadline: '2026-07-27T13:00:00.000Z',
  adoptionDeadline: '2026-07-27T14:00:00.000Z',
} as const;

const observed = (overrides: Record<string, unknown> = {}) => ({
  ...prepared,
  status: 'solution-observed',
  submission,
  submittedAt: '2026-07-27T12:01:00.000Z',
  delivery: {
    observationPath: `${ATTEMPT_DIR}/delivery.json`,
    observationDigest: DIGEST,
    taskId: '501',
    taskCid: submission.taskCid,
    taskCreationTransaction: submission.creationTx,
    taskCreationBlock: 501,
    solverNetManifestCid: submission.solverNetManifestCid,
    attemptIndex: 0,
    requestId: DELIVERY_REQUEST_ID,
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
      requestId: DELIVERY_REQUEST_ID,
      deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid',
      v2AttemptId: ATTEMPT_ID,
      claimOid: OID,
      prNumber: 42,
      expectedHead: OID,
    },
    observedAt: '2026-07-27T12:02:00.000Z',
    ...overrides,
  },
});

const artifact = {
  digest: `sha256:${'4'.repeat(64)}`,
  byteLength: 12,
  touchedPaths: ['packages/a.ts'],
  expectedTree: OID,
} as const;

const verification = {
  profile: 'jinn-mono.v1',
  artifactDigest: artifact.digest,
  expectedTree: OID,
  planDigest: `sha256:${'5'.repeat(64)}`,
  commands: [{
    label: 'typecheck', command: 'yarn', args: ['typecheck'], cwdRelative: '.',
    status: 'passed', exitCode: 0,
    stdoutDigest: `sha256:${'6'.repeat(64)}`,
    stderrDigest: `sha256:${'7'.repeat(64)}`,
    startedAt: '2026-07-27T12:03:00.000Z',
    completedAt: '2026-07-27T12:04:00.000Z',
  }],
  verifiedAt: '2026-07-27T12:04:00.000Z',
} as const;

const hostCommit = {
  head: OID, tree: OID, parents: [OID], artifactDigest: artifact.digest,
  correlationDigest: `sha256:${'8'.repeat(64)}`,
  trailers: {
    taskId: '501', requestId: DELIVERY_REQUEST_ID,
    deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid',
    v2AttemptId: ATTEMPT_ID, artifactDigest: artifact.digest,
  },
  createdAt: '2026-07-27T12:05:00.000Z',
} as const;

const completion = {
  operation: 'implementation-complete', prNumber: 42, branch: 'autopilot/42',
  claimOid: OID, checkpointOid: OID, resultingHead: OID,
  lifecycleStatus: 'In Review', confirmedAt: '2026-07-27T12:06:00.000Z',
} as const;

const reviewAnchor = {
  attemptId: REVIEW_ATTEMPT_ID,
  manifestPath: `${RUNNER_DIR}/review/pr-42-${REVIEW_ATTEMPT_ID}/manifest.json`,
  head: OID, generation: REVIEW_ATTEMPT_ID, refOid: OID,
  reviewer: 'review-bot', anchoredAt: '2026-07-27T12:07:00.000Z',
} as const;

const verified = { ...observed(), status: 'solution-verified', artifact, verification } as const;
const committed = { ...verified, status: 'host-committed', hostCommit } as const;
const completed = { ...committed, status: 'lifecycle-completed', completion } as const;
const anchored = { ...completed, status: 'review-anchored', reviewAnchor } as const;
const anchoredProgress = {
  status: 'review-anchored',
  delivery: anchored.delivery,
  artifact,
  verification,
  hostCommit,
  completion,
  reviewAnchor,
} as const;

const acceptedReceipt = {
  schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
  disposition: 'accepted',
  role: 'solution',
  operation: 'implementation-complete',
  taskId: '501',
  attemptIndex: 0,
  requestId: DELIVERY_REQUEST_ID,
  deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid',
  v2AttemptId: ATTEMPT_ID,
  prNumber: 42,
  claimOid: OID,
  expectedHead: OID,
  resultingHead: OID,
  reviewGeneration: reviewAnchor.generation,
  reviewRefOid: OID,
  recordedAt: '2026-07-27T12:08:00.000Z',
} as const;

describe('decodeMarketplaceExecutionV3State', () => {
  it('accepts prepared, submitted, and observed states with complete exact evidence', () => {
    expect(decodeMarketplaceExecutionV3State(prepared, ATTEMPT_DIR)).toEqual(prepared);
    expect(decodeMarketplaceExecutionV3State({
      ...prepared,
      status: 'submitted',
      submission,
      submittedAt: '2026-07-27T12:01:00.000Z',
    }, ATTEMPT_DIR)).toMatchObject({ status: 'submitted', submission });
    expect(decodeMarketplaceExecutionV3State(observed(), ATTEMPT_DIR)).toMatchObject({
      status: 'solution-observed',
      delivery: { taskId: '501' },
    });
  });

  // This catches a decoder that accepts only the first adoption milestone.
  it('accepts the complete monotonic adoption evidence chain', () => {
    expect(decodeMarketplaceExecutionV3State(verified, ATTEMPT_DIR).status).toBe('solution-verified');
    expect(decodeMarketplaceExecutionV3State(committed, ATTEMPT_DIR).status).toBe('host-committed');
    expect(decodeMarketplaceExecutionV3State(completed, ATTEMPT_DIR).status).toBe('lifecycle-completed');
    expect(decodeMarketplaceExecutionV3State(anchored, ATTEMPT_DIR).status).toBe('review-anchored');
  });

  // This catches omission or loose decoding of the two terminal v3 variants.
  it('accepts exact cancelled and receipt-published states', () => {
    expect(decodeMarketplaceExecutionV3State({
      ...prepared,
      status: 'cancelled',
      cancelledAt: '2026-07-27T12:01:00.000Z',
      reason: 'operator-cancelled',
    }, ATTEMPT_DIR).status).toBe('cancelled');
    expect(decodeMarketplaceExecutionV3State({
      ...prepared,
      status: 'receipt-published',
      submission,
      submittedAt: '2026-07-27T12:01:00.000Z',
      progress: anchoredProgress,
      receipt: {
        receipt: acceptedReceipt,
        commentId: 501,
        author: 'jinn-autopilot',
        recordedAt: '2026-07-27T12:08:00.000Z',
      },
    }, ATTEMPT_DIR)).toMatchObject({
      status: 'receipt-published',
      receipt: { commentId: 501 },
    });
  });

  // These cases catch accepting SDK receipts that contradict durable Solution evidence.
  it.each([
    ['a verdict receipt', { ...acceptedReceipt, role: 'verdict', operation: 'human', reviewedHead: OID }],
    ['a different task', { ...acceptedReceipt, taskId: '502' }],
    ['a different resulting head', { ...acceptedReceipt, resultingHead: 'c'.repeat(40) }],
    ['a different review generation', {
      ...acceptedReceipt,
      reviewGeneration: '33333333-3333-4333-8333-333333333333',
    }],
  ])('rejects receipt-published state with %s', (_name, receipt) => {
    expect(() => decodeMarketplaceExecutionV3State({
      ...prepared,
      status: 'receipt-published',
      submission,
      submittedAt: '2026-07-27T12:01:00.000Z',
      progress: anchoredProgress,
      receipt: {
        receipt,
        commentId: 501,
        author: 'jinn-autopilot',
        recordedAt: '2026-07-27T12:08:00.000Z',
      },
    }, ATTEMPT_DIR)).toThrow();
  });

  // This catches a later wrapper timestamp hiding a receipt authored before its evidence.
  it.each([
    ['accepted', anchoredProgress, {
      ...acceptedReceipt,
      recordedAt: '2026-07-27T12:06:00.000Z',
    }],
    ['rejected', {
      status: 'solution-observed',
      delivery: observed().delivery,
    }, {
      schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
      disposition: 'rejected',
      role: 'solution',
      reason: 'invalid-artifact',
      detail: 'Patch policy rejected the artifact.',
      taskId: '501',
      attemptIndex: 0,
      requestId: DELIVERY_REQUEST_ID,
      deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid',
      v2AttemptId: ATTEMPT_ID,
      prNumber: 42,
      claimOid: OID,
      expectedHead: OID,
      recordedAt: '2026-07-27T12:01:00.000Z',
    }],
  ] as const)('rejects a %s receipt authored before its durable progress', (
    _disposition,
    progress,
    receipt,
  ) => {
    expect(() => decodeMarketplaceExecutionV3State({
      ...prepared,
      status: 'receipt-published',
      submission,
      submittedAt: '2026-07-27T12:01:00.000Z',
      progress,
      receipt: {
        receipt,
        commentId: 501,
        author: 'jinn-autopilot',
        recordedAt: '2026-07-27T12:08:00.000Z',
      },
    }, ATTEMPT_DIR)).toThrow(/receipt.*predates durable adoption/i);
  });

  it('accepts a correlated rejected receipt without requiring review evidence', () => {
    const rejectedReceipt = {
      schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
      disposition: 'rejected',
      role: 'solution',
      reason: 'invalid-artifact',
      detail: 'Patch policy rejected the artifact.',
      taskId: '501',
      attemptIndex: 0,
      requestId: DELIVERY_REQUEST_ID,
      deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid',
      v2AttemptId: ATTEMPT_ID,
      prNumber: 42,
      claimOid: OID,
      expectedHead: OID,
      recordedAt: '2026-07-27T12:03:00.000Z',
    } as const;

    expect(decodeMarketplaceExecutionV3State({
      ...prepared,
      status: 'receipt-published',
      submission,
      submittedAt: '2026-07-27T12:01:00.000Z',
      progress: {
        status: 'solution-observed',
        delivery: observed().delivery,
      },
      receipt: {
        receipt: rejectedReceipt,
        commentId: 502,
        author: 'jinn-autopilot',
        recordedAt: '2026-07-27T12:03:00.000Z',
      },
    }, ATTEMPT_DIR)).toMatchObject({
      status: 'receipt-published',
      receipt: { receipt: { disposition: 'rejected' } },
    });
  });

  // These cases catch a decoder that loosens its exact evidence boundary.
  it.each([
    ['unknown status', { ...prepared, status: 'other' }],
    ['extra key', { ...prepared, extra: true }],
    ['cancelled extra key', {
      ...prepared,
      status: 'cancelled',
      cancelledAt: '2026-07-27T12:01:00.000Z',
      reason: 'operator-cancelled',
      extra: true,
    }],
    ['cancelled timestamp before preparation', {
      ...prepared,
      status: 'cancelled',
      cancelledAt: '2026-07-27T11:59:00.000Z',
      reason: 'operator-cancelled',
    }],
    ['noncanonical observation path', observed({
      observationPath: `${ATTEMPT_DIR}/nested/../delivery.json`,
    })],
    ['unsafe observation path', observed({ observationPath: '../result.json' })],
    ['bad digest', observed({ observationDigest: 'sha256:nope' })],
    ['unsafe block number', observed({ deliveryBlock: Number.MAX_SAFE_INTEGER + 1 })],
    ['mismatched creation transaction', observed({
      taskCreationTransaction: `0x${'0'.repeat(64)}`,
    })],
    ['mismatched SolverNet manifest', observed({
      solverNetManifestCid: 'bafybeigdyrzt5m6u2r3o4differentcid',
    })],
    ['mismatched submission attempt identity', {
      ...observed(),
      submission: {
        ...submission,
        id: 'autopilot:33333333-3333-4333-8333-333333333333',
      },
    }],
    ['mismatched signer', observed({ signer: `0x${'3'.repeat(40)}` })],
    ['unsafe artifact dot path', {
      ...verified,
      artifact: { ...artifact, touchedPaths: ['.'] },
    }],
    ['unsafe artifact normalized path', {
      ...verified,
      artifact: { ...artifact, touchedPaths: ['packages/a/..'] },
    }],
    ['relative review manifest path', {
      ...anchored,
      reviewAnchor: { ...reviewAnchor, manifestPath: '../manifest.json' },
    }],
    ['non-manifest review path', {
      ...anchored,
      reviewAnchor: {
        ...reviewAnchor,
        manifestPath: `${RUNNER_DIR}/review/pr-42-${REVIEW_ATTEMPT_ID}/state.json`,
      },
    }],
    ['review manifest outside the current runner tree', {
      ...anchored,
      reviewAnchor: {
        ...reviewAnchor,
        manifestPath: `/tmp/other/v2/runner-a/review/pr-42-${REVIEW_ATTEMPT_ID}/manifest.json`,
      },
    }],
    ['host tree that contradicts the verified artifact', {
      ...committed,
      hostCommit: { ...hostCommit, tree: 'c'.repeat(40) },
    }],
    ['completion PR that contradicts the delivery correlation', {
      ...completed,
      completion: { ...completion, prNumber: 43 },
    }],
    ['incomplete correlation', observed({ correlation: { taskId: '501' } })],
  ])('rejects %s', (_name, value) => {
    expect(() => decodeMarketplaceExecutionV3State(value, ATTEMPT_DIR)).toThrow();
  });

  // This catches an evaluator-leg decoder that admits a second submission or a loose identity.
  it('decodes only anchored and released evaluator legs with exact identity', () => {
    const anchored = {
      schemaVersion: 'marketplace-evaluator-leg-v1', status: 'anchored',
      originManifestPath: `${RUNNER_DIR}/implement/issue-42-${ATTEMPT_ID}/manifest.json`,
      originV2AttemptId: ATTEMPT_ID,
      originRequestDigest: DIGEST, taskId: '501', taskCid: submission.taskCid,
      taskCreationBlock: 501, prNumber: 42, expectedHead: OID,
      generation: '22222222-2222-4222-8222-222222222222', reviewRefOid: OID,
      reviewer: 'review-bot', anchoredAt: '2026-07-27T12:07:00.000Z',
    } as const;
    expect(decodeMarketplaceEvaluatorLegExecutionState(anchored, EVALUATOR_ATTEMPT_DIR)).toEqual(anchored);
    expect(decodeMarketplaceEvaluatorLegExecutionState({
      ...anchored, status: 'released', releasedAt: '2026-07-27T12:08:00.000Z',
      releaseReason: 'receipt-published',
    }, EVALUATOR_ATTEMPT_DIR)).toMatchObject({ status: 'released' });
    expect(() => decodeMarketplaceEvaluatorLegExecutionState({ ...anchored, status: 'submitted' }, EVALUATOR_ATTEMPT_DIR)).toThrow();
    expect(() => decodeMarketplaceEvaluatorLegExecutionState({ ...anchored, extra: true }, EVALUATOR_ATTEMPT_DIR)).toThrow();
    expect(() => decodeMarketplaceEvaluatorLegExecutionState({
      ...anchored,
      originV2AttemptId: 'not-a-uuid',
    }, EVALUATOR_ATTEMPT_DIR)).toThrow();
    expect(() => decodeMarketplaceEvaluatorLegExecutionState({
      ...anchored,
      generation: 'not-a-uuid',
    }, EVALUATOR_ATTEMPT_DIR)).toThrow();
    expect(() => decodeMarketplaceEvaluatorLegExecutionState({
      ...anchored,
      prNumber: 0,
    }, EVALUATOR_ATTEMPT_DIR)).toThrow();
    expect(() => decodeMarketplaceEvaluatorLegExecutionState({
      ...anchored,
      originManifestPath: '../manifest.json',
    }, EVALUATOR_ATTEMPT_DIR)).toThrow();
    expect(() => decodeMarketplaceEvaluatorLegExecutionState({
      ...anchored,
      originManifestPath: `${RUNNER_DIR}/implement/issue-42-${ATTEMPT_ID}/state.json`,
    }, EVALUATOR_ATTEMPT_DIR)).toThrow();
    expect(() => decodeMarketplaceEvaluatorLegExecutionState({
      ...anchored,
      originManifestPath: `/tmp/other/v2/runner-a/implement/issue-42-${ATTEMPT_ID}/manifest.json`,
    }, EVALUATOR_ATTEMPT_DIR)).toThrow();
    expect(() => decodeMarketplaceEvaluatorLegExecutionState({
      ...anchored,
      originManifestPath: `${RUNNER_DIR}/implement/issue-42-${REVIEW_ATTEMPT_ID}/manifest.json`,
    }, EVALUATOR_ATTEMPT_DIR)).toThrow();
  });
});
