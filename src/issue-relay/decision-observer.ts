import { isDeepStrictEqual } from 'node:util';
import type {
  IssueRelayDecisionRequestV1,
  IssueRelayHumanDecisionReceiptV1,
} from './contracts.js';
import {
  createRelayHumanDecisionReceipt,
  parseRelayDecisionCommand,
  type RelayDecisionCommentFacts,
} from './decision-protocol.js';

export type RelayHumanDecisionObservation =
  | { readonly state: 'pending'; readonly detail: string }
  | { readonly state: 'accepted'; readonly receipt: IssueRelayHumanDecisionReceiptV1 }
  | { readonly state: 'duplicate'; readonly receipt: IssueRelayHumanDecisionReceiptV1 }
  | { readonly state: 'contradictory'; readonly detail: string };

export interface RelayDecisionObservationPort {
  listComments(): Promise<readonly RelayDecisionCommentFacts[]>;
  readComment(commentId: number): Promise<RelayDecisionCommentFacts | undefined>;
  readHead(): Promise<string>;
  readPermission(login: string): Promise<'NONE' | 'READ' | 'TRIAGE' | 'WRITE' | 'MAINTAIN' | 'ADMIN'>;
}

function sameDecisionIntent(
  left: IssueRelayHumanDecisionReceiptV1,
  right: IssueRelayHumanDecisionReceiptV1,
): boolean {
  return left.requestDigest === right.requestDigest
    && left.action === right.action
    && left.selectedOptionId === right.selectedOptionId
    && left.binding === right.binding
    && left.actor.githubUserId === right.actor.githubUserId;
}

/**
 * Observes a head-bound PR conversation without treating GitHub comments as
 * durable authority. The caller must persist the returned normalized receipt
 * into the bot-owned generation marker before deriving any next side effect.
 */
export async function observeRelayHumanDecision(input: {
  readonly request: IssueRelayDecisionRequestV1;
  readonly existingReceipt?: IssueRelayHumanDecisionReceiptV1;
  readonly existingDeferralReceipts?: readonly IssueRelayHumanDecisionReceiptV1[];
  readonly effectiveExpiresAt?: string;
  readonly originalAuthorisingMaintainer: {
    readonly login: string;
    readonly userId: string;
  };
  readonly port: RelayDecisionObservationPort;
  readonly now: string;
}): Promise<RelayHumanDecisionObservation> {
  const comments = (await input.port.listComments())
    .filter(({ createdAt }) => Date.parse(createdAt) >= Date.parse(input.request.createdAt))
    .filter(({ body }) => parseRelayDecisionCommand(body) !== null)
    .filter(({ commentId }) => !(input.existingDeferralReceipts ?? [])
      .some((receipt) => receipt.sourceComment.commentId === commentId))
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
      || left.commentId - right.commentId);
  if (comments.length === 0) return { state: 'pending', detail: 'No valid Relay decision command is observable' };

  let first: IssueRelayHumanDecisionReceiptV1 | undefined;
  for (const comment of comments) {
    const beforeHead = await input.port.readHead();
    const permission = await input.port.readPermission(comment.actorLogin);
    if (permission === 'NONE') continue;
    const source = await input.port.readComment(comment.commentId);
    const afterHead = await input.port.readHead();
    if (source === undefined || !isDeepStrictEqual(source, comment) || beforeHead !== afterHead) {
      continue;
    }
    const result = createRelayHumanDecisionReceipt({
      request: input.request,
      comment: source,
      currentHead: afterHead,
      currentPermission: permission,
      originalAuthorisingMaintainer: input.originalAuthorisingMaintainer,
      checkedAt: input.now,
      now: input.now,
      ...(input.effectiveExpiresAt === undefined
        ? {}
        : { effectiveExpiresAt: input.effectiveExpiresAt }),
    });
    if (!result.accepted) continue;
    if (first === undefined) {
      first = result.receipt;
      continue;
    }
    if (!sameDecisionIntent(first, result.receipt)) {
      return { state: 'contradictory', detail: 'Multiple contradictory authorized decision commands are observable' };
    }
  }
  if (first === undefined) {
    return { state: 'pending', detail: 'No immutable authorized Relay decision command is observable' };
  }
  if (input.existingReceipt !== undefined) {
    return sameDecisionIntent(input.existingReceipt, first)
      ? { state: 'duplicate', receipt: first }
      : { state: 'contradictory', detail: 'Durable human receipt conflicts with observable decision authority' };
  }
  return { state: 'accepted', receipt: first };
}
