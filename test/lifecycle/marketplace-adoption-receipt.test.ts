import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AutopilotAdoptionReceiptSchema,
  formatAutopilotAdoptionReceiptComment,
} from '@jinn-network/sdk/autopilot';
import {
  publishAdoptionReceipt,
  readAdoptionReceiptState,
  type AdoptionReceiptComment,
  type AdoptionReceiptExactFacts,
  type AdoptionReceiptPorts,
} from '../../src/lifecycle/marketplace-adoption-receipt.js';
import { gitOid, type GitOid } from '../../src/lifecycle/types.js';

const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const GENERATION = '33333333-3333-4333-8333-333333333333';
const REQUEST_ID = `0x${'9'.repeat(64)}`;
const ENVELOPE_CID = 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid';
const CLAIM_OID = gitOid('a'.repeat(40));
const PUBLICATION_HEAD = gitOid('b'.repeat(40));
const REVIEW_REF_OID = gitOid('c'.repeat(40));
const PR_NUMBER = 42;
const RECORDED_AT = '2026-07-27T12:08:00.000Z';

const CORRELATION = {
  taskId: '501',
  attemptIndex: 0,
  requestId: REQUEST_ID,
  deliveryEnvelopeCid: ENVELOPE_CID,
  v2AttemptId: ATTEMPT_ID,
  claimOid: CLAIM_OID,
  prNumber: PR_NUMBER,
  expectedHead: PUBLICATION_HEAD,
} as const;

function acceptedReceipt(overrides: Record<string, unknown> = {}) {
  return AutopilotAdoptionReceiptSchema.parse({
    schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
    disposition: 'accepted',
    role: 'solution',
    operation: 'implementation-complete',
    taskId: CORRELATION.taskId,
    attemptIndex: CORRELATION.attemptIndex,
    requestId: CORRELATION.requestId,
    deliveryEnvelopeCid: CORRELATION.deliveryEnvelopeCid,
    v2AttemptId: CORRELATION.v2AttemptId,
    prNumber: CORRELATION.prNumber,
    claimOid: CORRELATION.claimOid,
    expectedHead: CORRELATION.expectedHead,
    resultingHead: PUBLICATION_HEAD,
    reviewGeneration: GENERATION,
    reviewRefOid: REVIEW_REF_OID,
    recordedAt: RECORDED_AT,
    ...overrides,
  });
}

function rejectedReceipt(overrides: Record<string, unknown> = {}) {
  return AutopilotAdoptionReceiptSchema.parse({
    schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
    disposition: 'rejected',
    role: 'solution',
    reason: 'invalid-artifact',
    detail: 'Patch policy rejected the artifact.',
    taskId: CORRELATION.taskId,
    attemptIndex: CORRELATION.attemptIndex,
    requestId: CORRELATION.requestId,
    deliveryEnvelopeCid: CORRELATION.deliveryEnvelopeCid,
    v2AttemptId: CORRELATION.v2AttemptId,
    prNumber: CORRELATION.prNumber,
    claimOid: CORRELATION.claimOid,
    expectedHead: CORRELATION.expectedHead,
    recordedAt: RECORDED_AT,
    ...overrides,
  });
}

function acceptedFacts(
  overrides: Partial<Extract<AdoptionReceiptExactFacts, { disposition: 'accepted' }>> = {},
): Extract<AdoptionReceiptExactFacts, { disposition: 'accepted' }> {
  return {
    role: 'solution',
    correlation: CORRELATION,
    prNumber: PR_NUMBER,
    publicationHead: PUBLICATION_HEAD,
    receiptAuthors: ['jinn-autopilot'],
    disposition: 'accepted',
    resultingHead: PUBLICATION_HEAD,
    expectedReview: {
      generation: GENERATION,
      refOid: REVIEW_REF_OID,
    },
    ...overrides,
  };
}

function rejectedFacts(
  overrides: Partial<Extract<AdoptionReceiptExactFacts, { disposition: 'rejected' }>> = {},
): Extract<AdoptionReceiptExactFacts, { disposition: 'rejected' }> {
  return {
    role: 'solution',
    correlation: CORRELATION,
    prNumber: PR_NUMBER,
    publicationHead: PUBLICATION_HEAD,
    receiptAuthors: ['jinn-autopilot'],
    disposition: 'rejected',
    reason: 'invalid-artifact',
    ...overrides,
  };
}

function comment(
  id: number,
  authorLogin: string,
  body: string,
  overrides: Partial<AdoptionReceiptComment> = {},
): AdoptionReceiptComment {
  const timestamp = '2026-07-27T12:08:00.000Z';
  return {
    id,
    authorLogin,
    body,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function verifyReceiptFacts(
  input: {
    readonly expected: AdoptionReceiptExactFacts;
    readonly receipt: ReturnType<typeof acceptedReceipt>;
  },
): boolean {
  const { expected, receipt } = input;
  if (receipt.role !== expected.role) return false;
  if (receipt.prNumber !== expected.prNumber) return false;
  if (receipt.expectedHead !== expected.publicationHead) return false;
  if (expected.disposition === 'accepted') {
    if (receipt.disposition !== 'accepted') return false;
    return receipt.resultingHead === expected.resultingHead
      && receipt.reviewGeneration === expected.expectedReview.generation
      && receipt.reviewRefOid === expected.expectedReview.refOid;
  }
  return receipt.disposition === 'rejected' && receipt.reason === expected.reason;
}

function createPorts(input: {
  readonly comments?: readonly AdoptionReceiptComment[][];
  readonly pageSize?: number;
  readonly head?: GitOid;
  readonly onCreate?: AdoptionReceiptPorts['createPrComment'];
} = {}): AdoptionReceiptPorts & {
  readonly createCalls: Array<Parameters<AdoptionReceiptPorts['createPrComment']>[0]>;
  readonly headReads: number[];
  readonly liveComments: AdoptionReceiptComment[];
} {
  const pageSize = input.pageSize ?? 100;
  const liveComments = [...(input.comments ?? []).flat()];
  const createCalls: Array<Parameters<AdoptionReceiptPorts['createPrComment']>[0]> = [];
  const headReads: number[] = [];
  let head = input.head ?? PUBLICATION_HEAD;

  return {
    createCalls,
    headReads,
    liveComments,
    async listPrIssueComments({ cursor }) {
      const pageIndex = cursor ? Number.parseInt(cursor, 10) : 0;
      const start = pageIndex * pageSize;
      const comments = liveComments.slice(start, start + pageSize);
      const nextCursor = start + pageSize < liveComments.length
        ? String(pageIndex + 1)
        : undefined;
      return { comments, nextCursor };
    },
    async readCurrentPrHead() {
      headReads.push(1);
      return head;
    },
    verifyReceiptFacts,
    async createPrComment(request) {
      createCalls.push(request);
      if (request.expectedHead !== head) {
        throw new Error('createPrComment expected head mismatch');
      }
      if (input.onCreate) return input.onCreate(request);
      const created = comment(
        liveComments.reduce((max, current) => Math.max(max, current.id), 0) + 1,
        'jinn-autopilot',
        request.body,
      );
      liveComments.push(created);
      return { commentId: created.id, author: created.authorLogin };
    },
    setHead(nextHead: GitOid) {
      head = nextHead;
    },
  } as AdoptionReceiptPorts & {
    readonly createCalls: typeof createCalls;
    readonly headReads: number[];
    liveComments: AdoptionReceiptComment[];
    setHead(nextHead: GitOid): void;
  };
}

type MutablePorts = ReturnType<typeof createPorts>;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readAdoptionReceiptState', () => {
  it('paginates pull-request issue comments until the exact receipt is found', async () => {
    const receipt = acceptedReceipt();
    const ports = createPorts({
      pageSize: 1,
      comments: [
        [comment(1, 'jinn-autopilot', 'unrelated discussion')],
        [comment(2, 'jinn-autopilot', formatAutopilotAdoptionReceiptComment(receipt))],
      ],
    });

    await expect(readAdoptionReceiptState(acceptedFacts(), ports)).resolves.toEqual({
      status: 'exact',
      comment: expect.objectContaining({ id: 2 }),
      receipt,
    });
  });

  it('accepts authorized authors with case-insensitive login matching', async () => {
    const receipt = acceptedReceipt();
    const ports = createPorts({
      comments: [[comment(1, 'Jinn-Autopilot', formatAutopilotAdoptionReceiptComment(receipt))]],
    });

    await expect(readAdoptionReceiptState(
      acceptedFacts({ receiptAuthors: ['jinn-autopilot'] }),
      ports,
    )).resolves.toMatchObject({ status: 'exact' });
  });

  it('ignores forged authors outside the persisted allowlist', async () => {
    const receipt = acceptedReceipt();
    const ports = createPorts({
      comments: [[comment(1, 'forged-bot', formatAutopilotAdoptionReceiptComment(receipt))]],
    });

    await expect(readAdoptionReceiptState(acceptedFacts(), ports)).resolves.toEqual({
      status: 'missing',
    });
  });

  it('ignores unrelated canonical receipts for a different marketplace attempt', async () => {
    const unrelated = acceptedReceipt({ taskId: '999' });
    const ports = createPorts({
      comments: [[comment(1, 'jinn-autopilot', formatAutopilotAdoptionReceiptComment(unrelated))]],
    });

    await expect(readAdoptionReceiptState(acceptedFacts(), ports)).resolves.toEqual({
      status: 'missing',
    });
  });

  it('treats exact duplicate authorized comments as one exact receipt', async () => {
    const receipt = acceptedReceipt();
    const body = formatAutopilotAdoptionReceiptComment(receipt);
    const ports = createPorts({
      comments: [[
        comment(1, 'jinn-autopilot', body),
        comment(2, 'jinn-autopilot', body),
      ]],
    });

    await expect(readAdoptionReceiptState(acceptedFacts(), ports)).resolves.toMatchObject({
      status: 'exact',
      comment: { id: 1 },
      receipt,
    });
  });

  it('fails closed on contradictory accepted and rejected authorized receipts', async () => {
    const ports = createPorts({
      comments: [[
        comment(1, 'jinn-autopilot', formatAutopilotAdoptionReceiptComment(acceptedReceipt())),
        comment(2, 'jinn-autopilot', formatAutopilotAdoptionReceiptComment(rejectedReceipt())),
      ]],
    });

    const result = await readAdoptionReceiptState(acceptedFacts(), ports);
    expect(result.status).toBe('contradiction');
    if (result.status === 'contradiction') {
      expect(result.detail).toMatch(/contradict/i);
    }
  });

  it('fails closed on two contradictory accepted receipt identities', async () => {
    const ports = createPorts({
      comments: [[
        comment(1, 'jinn-autopilot', formatAutopilotAdoptionReceiptComment(acceptedReceipt())),
        comment(2, 'jinn-autopilot', formatAutopilotAdoptionReceiptComment(
          acceptedReceipt({ resultingHead: gitOid('d'.repeat(40)) }),
        )),
      ]],
    });

    const result = await readAdoptionReceiptState(acceptedFacts(), ports);
    expect(result.status).toBe('contradiction');
  });

  it('ignores edited comments whose body no longer parses canonically', async () => {
    const receipt = acceptedReceipt();
    const editedBody = `${formatAutopilotAdoptionReceiptComment(receipt)}\nedited`;
    const ports = createPorts({
      comments: [[comment(1, 'jinn-autopilot', editedBody, {
        updatedAt: '2026-07-27T12:09:00.000Z',
      })]],
    });

    await expect(readAdoptionReceiptState(acceptedFacts(), ports)).resolves.toEqual({
      status: 'missing',
    });
  });

  it('ignores noncanonical framing around an otherwise valid receipt payload', async () => {
    const receipt = acceptedReceipt();
    const ports = createPorts({
      comments: [[comment(1, 'jinn-autopilot', `prefix\n${formatAutopilotAdoptionReceiptComment(receipt)}`)]],
    });

    await expect(readAdoptionReceiptState(acceptedFacts(), ports)).resolves.toEqual({
      status: 'missing',
    });
  });

  it('ignores malformed JSON inside a canonical-looking frame', async () => {
    const ports = createPorts({
      comments: [[comment(1, 'jinn-autopilot', [
        '<!-- jinn-autopilot:marketplace-adoption-receipt:v1 key=abc -->',
        '<!-- jinn-autopilot:marketplace-adoption-receipt-payload:v1 begin -->',
        '```json',
        '{not-json',
        '```',
        '<!-- jinn-autopilot:marketplace-adoption-receipt-payload:v1 end -->',
      ].join('\n'))]],
    });

    await expect(readAdoptionReceiptState(acceptedFacts(), ports)).resolves.toEqual({
      status: 'missing',
    });
  });

  it('ignores an accepted receipt whose head and review claims no longer match', async () => {
    const ports = createPorts({
      comments: [[comment(1, 'jinn-autopilot', formatAutopilotAdoptionReceiptComment(
        acceptedReceipt({ resultingHead: gitOid('d'.repeat(40)) }),
      ))]],
    });

    await expect(readAdoptionReceiptState(acceptedFacts(), ports)).resolves.toEqual({
      status: 'missing',
    });
  });

  it('returns missing when accepted facts require a review anchor that does not match', async () => {
    const ports = createPorts({
      comments: [[comment(1, 'jinn-autopilot', formatAutopilotAdoptionReceiptComment(
        acceptedReceipt({ reviewGeneration: '44444444-4444-4444-8444-444444444444' }),
      ))]],
    });

    await expect(readAdoptionReceiptState(acceptedFacts(), ports)).resolves.toEqual({
      status: 'missing',
    });
  });

  it('accepts an exact rejected receipt without review fields', async () => {
    const receipt = rejectedReceipt();
    const ports = createPorts({
      comments: [[comment(1, 'jinn-autopilot', formatAutopilotAdoptionReceiptComment(receipt))]],
    });

    await expect(readAdoptionReceiptState(rejectedFacts(), ports)).resolves.toEqual({
      status: 'exact',
      comment: expect.objectContaining({ id: 1 }),
      receipt,
    });
  });
});

describe('publishAdoptionReceipt', () => {
  it('checks the exact publication head before and after writing the comment', async () => {
    const receipt = acceptedReceipt();
    const ports = createPorts() as MutablePorts;

    await publishAdoptionReceipt(acceptedFacts(), receipt, ports);

    expect(ports.headReads.length).toBeGreaterThanOrEqual(2);
    expect(ports.createCalls[0]?.expectedHead).toBe(PUBLICATION_HEAD);
  });

  it('requires accepted receipts to publish resultingHead equal to publicationHead', async () => {
    const ports = createPorts() as MutablePorts;

    await expect(publishAdoptionReceipt(
      acceptedFacts(),
      acceptedReceipt({ resultingHead: gitOid('d'.repeat(40)) }),
      ports,
    )).rejects.toThrow(/resultingHead|publication head/i);
  });

  it('verifies exact accepted review facts through the injected port', async () => {
    const receipt = acceptedReceipt();
    const verify = vi.fn(verifyReceiptFacts);
    const ports = createPorts() as MutablePorts;
    ports.verifyReceiptFacts = verify;

    await publishAdoptionReceipt(acceptedFacts(), receipt, ports);

    expect(verify).toHaveBeenCalledWith({
      expected: acceptedFacts(),
      receipt,
    });
  });

  it('reads back the created comment through paginated lookup', async () => {
    const receipt = acceptedReceipt();
    const body = formatAutopilotAdoptionReceiptComment(receipt);
    const ports = createPorts({
      pageSize: 1,
      comments: [[comment(1, 'jinn-autopilot', 'noise')]],
    }) as MutablePorts;

    const result = await publishAdoptionReceipt(acceptedFacts(), receipt, ports);

    expect(result).toEqual({
      status: 'published',
      commentId: 2,
      author: 'jinn-autopilot',
    });
    expect(ports.liveComments).toHaveLength(2);
    await expect(readAdoptionReceiptState(acceptedFacts(), ports)).resolves.toMatchObject({
      status: 'exact',
      comment: { id: 2 },
    });
    expect(ports.liveComments[1]?.body).toBe(body);
  });

  it('does not write a duplicate comment when the exact receipt is already published', async () => {
    const receipt = acceptedReceipt();
    const ports = createPorts({
      comments: [[comment(1, 'jinn-autopilot', formatAutopilotAdoptionReceiptComment(receipt))]],
    }) as MutablePorts;

    const result = await publishAdoptionReceipt(acceptedFacts(), receipt, ports);

    expect(result).toEqual({
      status: 'already-published',
      commentId: 1,
      author: 'jinn-autopilot',
    });
    expect(ports.createCalls).toHaveLength(0);
  });

  it('publishes bounded rejection detail through the SDK codec', async () => {
    const ports = createPorts() as MutablePorts;
    const receipt = rejectedReceipt({
      detail: 'x'.repeat(7_000),
    });

    await publishAdoptionReceipt(rejectedFacts(), receipt, ports);

    const published = ports.createCalls[0]?.body ?? '';
    const parsed = AutopilotAdoptionReceiptSchema.parse(
      JSON.parse(published.split('\n')[3] ?? '{}'),
    );
    expect(Buffer.byteLength(parsed.detail ?? '', 'utf8')).toBeLessThanOrEqual(8_192);
    expect(parsed.detail).toBe(receipt.detail);
  });

  it('publishes stale-head rejections against the newly observed publication head', async () => {
    const newHead = gitOid('e'.repeat(40));
    const ports = createPorts({
      head: newHead,
    }) as MutablePorts;
    const receipt = rejectedReceipt({
      reason: 'stale-head',
      expectedHead: newHead,
      detail: 'Pull-request head advanced before publication.',
    });

    await publishAdoptionReceipt(
      rejectedFacts({
        publicationHead: gitOid('d'.repeat(40)),
        reason: 'stale-head',
      }),
      receipt,
      ports,
    );

    expect(ports.createCalls[0]?.expectedHead).toBe(newHead);
  });

  it('does not mutate marketplace adoption manifests before exact readback', async () => {
    const receipt = acceptedReceipt();
    const ports = createPorts() as MutablePorts;
    const transition = vi.fn();
    const moduleSource = await import('node:fs/promises').then(({ readFile }) => readFile(
      new URL('../../src/lifecycle/marketplace-adoption-receipt.ts', import.meta.url),
      'utf8',
    ));

    expect(moduleSource).not.toMatch(/transitionMarketplaceAdoption/);
    expect(transition).not.toHaveBeenCalled();

    await publishAdoptionReceipt(acceptedFacts(), receipt, ports);
    expect(transition).not.toHaveBeenCalled();
  });
});
