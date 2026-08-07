import { createHash } from 'node:crypto';
import {
  IssueRelayDecisionRequestV1Schema,
  IssueRelayHumanDecisionReceiptV1Schema,
  issueRelayHumanDecisionReceiptDigest,
  type IssueRelayDecisionRequestV1,
  type IssueRelayHumanDecisionReceiptV1,
} from './contracts.js';

const COMMAND = /^\/jinn-relay (decide|defer|cancel|clarify) (sha256:[0-9a-f]{64}) ([0-9a-f]{40})(?: ([a-z0-9]+(?:-[a-z0-9]+)*))?$/;

export interface RelayDecisionCommentFacts {
  readonly commentId: number;
  readonly nodeId: string;
  readonly body: string;
  readonly actorLogin: string;
  readonly actorUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ParsedRelayDecisionCommand =
  | {
      readonly action: 'select-option';
      readonly requestDigest: `sha256:${string}`;
      readonly exactHead: string;
      readonly optionId: string;
      readonly rationale?: string;
    }
  | {
      readonly action: 'defer' | 'cancel' | 'clarify-scope';
      readonly requestDigest: `sha256:${string}`;
      readonly exactHead: string;
      readonly rationale?: string;
    };

export function relayCommentBodyDigest(body: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

/** Parses only an exact first-line command. Later lines are inert rationale. */
export function parseRelayDecisionCommand(body: string): ParsedRelayDecisionCommand | null {
  const [firstLine = '', ...rest] = body.split('\n');
  const match = COMMAND.exec(firstLine);
  if (match === null) return null;
  const verb = match[1]!;
  const requestDigest = match[2]! as `sha256:${string}`;
  const exactHead = match[3]!;
  const optionId = match[4];
  const rationale = rest.join('\n').trim();
  if (verb === 'decide') {
    if (optionId === undefined) return null;
    return {
      action: 'select-option',
      requestDigest,
      exactHead,
      optionId,
      ...(rationale.length === 0 ? {} : { rationale }),
    };
  }
  if (optionId !== undefined) return null;
  return {
    action: verb === 'clarify' ? 'clarify-scope' : verb,
    requestDigest,
    exactHead,
    ...(rationale.length === 0 ? {} : { rationale }),
  } as ParsedRelayDecisionCommand;
}

export type RelayDecisionReceiptResult =
  | { readonly accepted: true; readonly receipt: IssueRelayHumanDecisionReceiptV1 }
  | {
      readonly accepted: false;
      readonly reason:
        | 'edited-comment'
        | 'malformed-command'
        | 'stale-request'
        | 'stale-head'
        | 'expired'
        | 'action-not-allowed'
        | 'option-not-allowed'
        | 'unauthorised';
    };

export function createRelayHumanDecisionReceipt(input: {
  readonly request: IssueRelayDecisionRequestV1;
  readonly comment: RelayDecisionCommentFacts;
  readonly currentHead: string;
  readonly currentPermission: 'READ' | 'TRIAGE' | 'WRITE' | 'MAINTAIN' | 'ADMIN';
  readonly originalAuthorisingMaintainer: {
    readonly login: string;
    readonly userId: string;
  };
  readonly checkedAt: string;
  readonly now: string;
  /** Host-derived extension after a durable defer receipt. */
  readonly effectiveExpiresAt?: string;
}): RelayDecisionReceiptResult {
  const requestResult = IssueRelayDecisionRequestV1Schema.safeParse(input.request);
  if (!requestResult.success) return { accepted: false, reason: 'stale-request' };
  const request = requestResult.data as IssueRelayDecisionRequestV1;
  if (input.comment.createdAt !== input.comment.updatedAt) {
    return { accepted: false, reason: 'edited-comment' };
  }
  const command = parseRelayDecisionCommand(input.comment.body);
  if (command === null) return { accepted: false, reason: 'malformed-command' };
  if (command.requestDigest !== request.requestDigest) {
    return { accepted: false, reason: 'stale-request' };
  }
  if (command.exactHead !== request.exactHead || input.currentHead !== request.exactHead) {
    return { accepted: false, reason: 'stale-head' };
  }
  const expiresAt = input.effectiveExpiresAt ?? request.expiresAt;
  if (
    !Number.isFinite(Date.parse(expiresAt))
    || Date.parse(expiresAt) < Date.parse(request.expiresAt)
    || Date.parse(input.now) >= Date.parse(expiresAt)
  ) {
    return { accepted: false, reason: 'expired' };
  }
  if (!request.allowedActions.includes(command.action)) {
    return { accepted: false, reason: 'action-not-allowed' };
  }
  if (
    command.action === 'select-option'
    && !request.proposal.options.some(({ optionId }) => optionId === command.optionId)
  ) {
    return { accepted: false, reason: 'option-not-allowed' };
  }
  const permission = input.currentPermission;
  const actorIsOriginal =
    input.comment.actorLogin.toLowerCase() === input.originalAuthorisingMaintainer.login.toLowerCase()
    && input.comment.actorUserId === input.originalAuthorisingMaintainer.userId;
  const authorised = request.requiredRole === 'current-repository-admin'
    ? permission === 'ADMIN'
    : actorIsOriginal && ['WRITE', 'MAINTAIN', 'ADMIN'].includes(permission);
  if (!authorised) return { accepted: false, reason: 'unauthorised' };

  const selected = command.action === 'select-option'
    ? request.proposal.options.find(({ optionId }) => optionId === command.optionId)!
    : undefined;
  const binding = selected?.effect === 'implement-change'
    ? 'option-intent' as const
    : 'exact-head-acceptance' as const;
  const unsigned = {
    schemaVersion: 'jinn-issue-relay-human-decision.v1' as const,
    requestDigest: request.requestDigest,
    decisionKey: request.decisionKey,
    generation: request.generation,
    round: request.round,
    snapshotDigest: request.snapshotDigest,
    requestHead: request.exactHead,
    lane: request.lane,
    action: command.action,
    ...(command.action === 'select-option'
      ? { selectedOptionId: command.optionId }
      : {}),
    binding,
    actor: {
      githubLogin: input.comment.actorLogin,
      githubUserId: input.comment.actorUserId,
    },
    authority: {
      requiredRole: request.requiredRole,
      observedPermission: permission as 'WRITE' | 'MAINTAIN' | 'ADMIN',
      checkedAt: input.checkedAt,
    },
    sourceComment: {
      commentId: input.comment.commentId,
      nodeId: input.comment.nodeId,
      bodyDigest: relayCommentBodyDigest(input.comment.body),
      createdAt: input.comment.createdAt,
      updatedAt: input.comment.updatedAt,
    },
    ...(command.rationale === undefined ? {} : { rationale: command.rationale }),
    decidedAt: input.now,
  };
  const receipt = IssueRelayHumanDecisionReceiptV1Schema.parse({
    ...unsigned,
    receiptDigest: issueRelayHumanDecisionReceiptDigest(unsigned),
  }) as IssueRelayHumanDecisionReceiptV1;
  return { accepted: true, receipt };
}

export function renderRelayDecisionCommand(
  request: IssueRelayDecisionRequestV1,
  optionId: string,
): string {
  return `/jinn-relay decide ${request.requestDigest} ${request.exactHead} ${optionId}`;
}
