import {
  AutopilotAdoptionReceiptSchema,
  autopilotCorrelationMatches,
  formatAutopilotAdoptionReceiptComment,
  parseAutopilotAdoptionReceiptComment,
  type AutopilotAdoptionReceipt,
  type AutopilotAdoptionRejectionReason,
  type AutopilotCorrelation,
} from '@jinn-network/sdk/autopilot';
import { isDeepStrictEqual } from 'node:util';
import type { GitOid } from './types.js';

export interface AdoptionReceiptComment {
  readonly id: number;
  readonly authorLogin: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AdoptionReceiptLookup =
  | { readonly status: 'missing' }
  | { readonly status: 'exact'; readonly comment: AdoptionReceiptComment; readonly receipt: AutopilotAdoptionReceipt }
  | { readonly status: 'contradiction'; readonly detail: string };

interface AdoptionReceiptBaseFacts {
  readonly role: 'solution';
  readonly correlation: AutopilotCorrelation;
  readonly prNumber: number;
  readonly publicationHead: GitOid;
  readonly receiptAuthors: readonly string[];
}

export type AdoptionReceiptExactFacts =
  | (AdoptionReceiptBaseFacts & {
      readonly disposition: 'accepted';
      readonly resultingHead: GitOid;
      readonly expectedReview: {
        readonly generation: string;
        readonly refOid: GitOid;
      };
    })
  | (AdoptionReceiptBaseFacts & {
      readonly disposition: 'rejected';
      readonly reason: AutopilotAdoptionRejectionReason;
    });

export interface AdoptionReceiptPorts {
  listPrIssueComments(input: {
    readonly prNumber: number;
    readonly cursor?: string;
  }): Promise<{
    readonly comments: readonly AdoptionReceiptComment[];
    readonly nextCursor?: string;
  }>;
  readCurrentPrHead(prNumber: number): Promise<GitOid>;
  verifyReceiptFacts(input: {
    readonly expected: AdoptionReceiptExactFacts;
    readonly receipt: AutopilotAdoptionReceipt;
  }): Promise<boolean>;
  createPrComment(input: {
    readonly prNumber: number;
    readonly expectedHead: GitOid;
    readonly body: string;
  }): Promise<{ readonly commentId: number; readonly author: string }>;
}

interface AuthorizedReceiptCandidate {
  readonly comment: AdoptionReceiptComment;
  readonly receipt: AutopilotAdoptionReceipt;
  readonly canonicalJson: string;
}

function isAuthorizedAuthor(
  authorLogin: string,
  receiptAuthors: readonly string[],
): boolean {
  const normalized = authorLogin.toLowerCase();
  return receiptAuthors.some((author) => author.toLowerCase() === normalized);
}

function baseReceiptCorrelation(receipt: AutopilotAdoptionReceipt): AutopilotCorrelation {
  return baseCorrelation({
    taskId: receipt.taskId,
    attemptIndex: receipt.attemptIndex,
    requestId: receipt.requestId,
    deliveryEnvelopeCid: receipt.deliveryEnvelopeCid,
    v2AttemptId: receipt.v2AttemptId,
    claimOid: receipt.claimOid,
    prNumber: receipt.prNumber,
    expectedHead: receipt.expectedHead,
  });
}

function baseCorrelation(correlation: AutopilotCorrelation): AutopilotCorrelation {
  return {
    taskId: correlation.taskId,
    attemptIndex: correlation.attemptIndex,
    requestId: correlation.requestId,
    deliveryEnvelopeCid: correlation.deliveryEnvelopeCid,
    v2AttemptId: correlation.v2AttemptId,
    claimOid: correlation.claimOid,
    prNumber: correlation.prNumber,
    expectedHead: correlation.expectedHead,
  };
}

function receiptCorrelates(
  receipt: AutopilotAdoptionReceipt,
  expected: AdoptionReceiptExactFacts,
): boolean {
  return receipt.role === expected.role
    && autopilotCorrelationMatches(
      baseCorrelation(expected.correlation),
      baseReceiptCorrelation(receipt),
    );
}

function receiptsContradict(
  left: AutopilotAdoptionReceipt,
  right: AutopilotAdoptionReceipt,
): boolean {
  if (left.disposition !== right.disposition) return true;
  return JSON.stringify(left) !== JSON.stringify(right);
}

async function listAllComments(
  prNumber: number,
  ports: AdoptionReceiptPorts,
): Promise<readonly AdoptionReceiptComment[]> {
  const comments: AdoptionReceiptComment[] = [];
  let cursor: string | undefined;
  do {
    const page = await ports.listPrIssueComments({ prNumber, cursor });
    comments.push(...page.comments);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return comments;
}

function collectAuthorizedReceipts(
  comments: readonly AdoptionReceiptComment[],
  expected: AdoptionReceiptExactFacts,
): readonly AuthorizedReceiptCandidate[] {
  const candidates: AuthorizedReceiptCandidate[] = [];
  for (const comment of comments) {
    if (!isAuthorizedAuthor(comment.authorLogin, expected.receiptAuthors)) continue;
    const parsed = parseAutopilotAdoptionReceiptComment(comment.body);
    if (parsed === null) continue;
    if (!receiptCorrelates(parsed.receipt, expected)) continue;
    candidates.push({
      comment,
      receipt: parsed.receipt,
      canonicalJson: parsed.canonicalJson,
    });
  }
  return candidates;
}

function findContradiction(
  candidates: readonly AuthorizedReceiptCandidate[],
): string | undefined {
  for (let index = 0; index < candidates.length; index += 1) {
    for (let other = index + 1; other < candidates.length; other += 1) {
      if (receiptsContradict(candidates[index]!.receipt, candidates[other]!.receipt)) {
        return 'Contradictory marketplace adoption receipts were found on the pull request';
      }
    }
  }
  return undefined;
}

function receiptsMatch(
  left: AutopilotAdoptionReceipt,
  right: AutopilotAdoptionReceipt,
): boolean {
  return isDeepStrictEqual(left, right);
}

function assertAcceptedPublicationIdentity(
  expected: Extract<AdoptionReceiptExactFacts, { disposition: 'accepted' }>,
  receipt: AutopilotAdoptionReceipt,
): void {
  if (receipt.disposition !== 'accepted') {
    throw new Error('Marketplace adoption receipt disposition does not match accepted publication facts');
  }
  if (receipt.resultingHead !== expected.publicationHead) {
    throw new Error('Accepted marketplace adoption receipt resultingHead must equal publicationHead');
  }
}

function assertRejectedPublicationIdentity(
  expected: Extract<AdoptionReceiptExactFacts, { disposition: 'rejected' }>,
  receipt: AutopilotAdoptionReceipt,
): void {
  if (receipt.disposition !== 'rejected') {
    throw new Error('Marketplace adoption receipt disposition does not match rejected publication facts');
  }
  if (receipt.reason !== expected.reason) {
    throw new Error('Rejected marketplace adoption receipt reason does not match publication facts');
  }
}

async function resolvePublicationFacts(
  expected: AdoptionReceiptExactFacts,
  ports: AdoptionReceiptPorts,
): Promise<AdoptionReceiptExactFacts> {
  const currentHead = await ports.readCurrentPrHead(expected.prNumber);
  if (currentHead === expected.publicationHead) return expected;
  if (expected.disposition === 'rejected' && expected.reason === 'stale-head') {
    return {
      ...expected,
      publicationHead: currentHead,
    };
  }
  throw new Error('Marketplace adoption receipt publication head does not match the pull request');
}

export async function readAdoptionReceiptState(
  expected: AdoptionReceiptExactFacts,
  ports: AdoptionReceiptPorts,
): Promise<AdoptionReceiptLookup> {
  const comments = await listAllComments(expected.prNumber, ports);
  const candidates = collectAuthorizedReceipts(comments, expected);
  const contradiction = findContradiction(candidates);
  if (contradiction !== undefined) {
    return { status: 'contradiction', detail: contradiction };
  }

  for (const candidate of candidates) {
    if (await ports.verifyReceiptFacts({ expected, receipt: candidate.receipt })) {
      return {
        status: 'exact',
        comment: candidate.comment,
        receipt: candidate.receipt,
      };
    }
  }

  return { status: 'missing' };
}

export async function publishAdoptionReceipt(
  expected: AdoptionReceiptExactFacts,
  receipt: AutopilotAdoptionReceipt,
  ports: AdoptionReceiptPorts,
): Promise<{ readonly status: 'published' | 'already-published'; readonly commentId: number; readonly author: string }> {
  const publicationFacts = await resolvePublicationFacts(expected, ports);
  const canonicalReceipt = AutopilotAdoptionReceiptSchema.parse(receipt);
  if (publicationFacts.disposition === 'accepted') {
    assertAcceptedPublicationIdentity(publicationFacts, canonicalReceipt);
  } else {
    assertRejectedPublicationIdentity(publicationFacts, canonicalReceipt);
  }
  if (!(await ports.verifyReceiptFacts({ expected: publicationFacts, receipt: canonicalReceipt }))) {
    throw new Error('Marketplace adoption receipt does not satisfy publication facts verification');
  }

  const existing = await readAdoptionReceiptState(publicationFacts, ports);
  if (existing.status === 'contradiction') {
    throw new Error(existing.detail);
  }
  if (existing.status === 'exact') {
    if (receiptsMatch(existing.receipt, canonicalReceipt)) {
      return {
        status: 'already-published',
        commentId: existing.comment.id,
        author: existing.comment.authorLogin,
      };
    }
    throw new Error('An exact marketplace adoption receipt already exists with a different identity');
  }

  const publicationHead = publicationFacts.publicationHead;
  await ports.createPrComment({
    prNumber: publicationFacts.prNumber,
    expectedHead: publicationHead,
    body: formatAutopilotAdoptionReceiptComment(canonicalReceipt),
  });

  const headAfterWrite = await ports.readCurrentPrHead(publicationFacts.prNumber);
  if (headAfterWrite !== publicationHead) {
    throw new Error('Marketplace adoption receipt publication head changed after comment creation');
  }

  const readback = await readAdoptionReceiptState(publicationFacts, ports);
  if (readback.status !== 'exact' || !receiptsMatch(readback.receipt, canonicalReceipt)) {
    throw new Error('Marketplace adoption receipt readback did not match the published receipt');
  }

  return {
    status: 'published',
    commentId: readback.comment.id,
    author: readback.comment.authorLogin,
  };
}
