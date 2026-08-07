import { isDeepStrictEqual } from 'node:util';
import {
  issueRelayCanonicalDigest,
} from './contracts.js';
import {
  validateRelayGenerationV2,
  type RelayDecisionRecordV2,
  type RelayGenerationRecordV2,
  type RelayLaneAttemptRecordV2,
  type RelayPhaseV2,
  type RelayRoundRecordV2,
} from './state-v2.js';

export const RELAY_GENERATION_V2_MARKER = '<!-- jinn-issue-relay:generation:v2 -->';
const JSON_OPEN = '```json';
const JSON_CLOSE = '```';

function exactObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function formatRelayIssueMarkerV2(record: RelayGenerationRecordV2): string {
  if (!validateRelayGenerationV2(record)) {
    throw new TypeError('Cannot publish malformed Relay V2 generation evidence');
  }
  return `${RELAY_GENERATION_V2_MARKER}\n${JSON_OPEN}\n${JSON.stringify(record, null, 2)}\n${JSON_CLOSE}`;
}

export function parseRelayIssueMarkerV2(body: string): RelayGenerationRecordV2 | null {
  const prefix = `${RELAY_GENERATION_V2_MARKER}\n${JSON_OPEN}\n`;
  const suffix = `\n${JSON_CLOSE}`;
  if (!body.startsWith(prefix) || !body.endsWith(suffix)) return null;
  const source = body.slice(prefix.length, -suffix.length);
  try {
    const decoded = JSON.parse(source) as unknown;
    if (!exactObject(decoded) || decoded['schemaVersion'] !== 'jinn-issue-relay-generation.v2') {
      return null;
    }
    const record = decoded as unknown as RelayGenerationRecordV2;
    return validateRelayGenerationV2(record) ? record : null;
  } catch {
    return null;
  }
}

const phaseTransitions: Readonly<Record<RelayPhaseV2, readonly RelayPhaseV2[]>> = {
  'awaiting-clarification': ['awaiting-clarification', 'admitted', 'refused'],
  refused: ['refused'],
  admitted: ['admitted', 'funding', 'cancelling', 'exhausted'],
  funding: ['funding', 'submitted', 'cancelling', 'exhausted'],
  submitted: ['submitted', 'solution-delivered', 'cancelling', 'exhausted'],
  'solution-delivered': ['solution-delivered', 'draft-open', 'cancelling', 'exhausted'],
  'draft-open': ['draft-open', 'funding', 'evaluating', 'cancelling', 'exhausted'],
  evaluating: [
    'evaluating', 'funding', 'human-decision-required', 'security-blocked',
    'ready', 'cancelling', 'exhausted',
  ],
  'human-decision-required': [
    'human-decision-required', 'funding', 'ready', 'superseded', 'cancelling', 'exhausted',
  ],
  'security-blocked': ['security-blocked', 'superseded', 'cancelling'],
  superseded: ['superseded'],
  ready: ['ready'],
  cancelling: ['cancelling', 'closed'],
  closed: ['closed'],
  exhausted: ['exhausted'],
};

function evidencePrefix<T>(current: readonly T[], proposed: readonly T[]): boolean {
  return current.length <= proposed.length
    && current.every((entry, index) => isDeepStrictEqual(entry, proposed[index]));
}

function laneAttemptsMonotonic(
  current: readonly RelayLaneAttemptRecordV2[],
  proposed: readonly RelayLaneAttemptRecordV2[],
): boolean {
  return evidencePrefix(current, proposed);
}

function roundMonotonic(current: RelayRoundRecordV2, proposed: RelayRoundRecordV2): boolean {
  const immutable = ['round', 'purpose', 'workspaceRepository', 'inputHead', 'findings', 'prNumber', 'decisionBinding'] as const;
  if (immutable.some((key) => !isDeepStrictEqual(current[key], proposed[key]))) return false;
  const progressive = ['fundingIntent', 'task', 'solution', 'adoption', 'checks', 'evaluation'] as const;
  if (progressive.some((key) => current[key] !== undefined && !isDeepStrictEqual(current[key], proposed[key]))) {
    return false;
  }
  return laneAttemptsMonotonic(current.laneAttempts.security, proposed.laneAttempts.security)
    && laneAttemptsMonotonic(current.laneAttempts.quality, proposed.laneAttempts.quality);
}

const decisionTransitions: Readonly<Record<RelayDecisionRecordV2['status'], readonly RelayDecisionRecordV2['status'][]>> = {
  queued: ['queued', 'active', 'superseded'],
  active: ['active', 'implementing', 'resolved', 'expired', 'superseded'],
  implementing: ['implementing', 'active', 'resolved', 'superseded'],
  resolved: ['resolved'],
  expired: ['expired'],
  superseded: ['superseded'],
};

function decisionMonotonic(
  current: RelayDecisionRecordV2,
  proposed: RelayDecisionRecordV2,
): boolean {
  if (
    current.decisionKey !== proposed.decisionKey
    || current.lane !== proposed.lane
    || current.proposalDigest !== proposed.proposalDigest
    || !isDeepStrictEqual(current.proposal, proposed.proposal)
    || current.firstProposedHead !== proposed.firstProposedHead
    || !decisionTransitions[current.status].includes(proposed.status)
    || current.deferrals > proposed.deferrals
    || !evidencePrefix(current.deferralReceipts, proposed.deferralReceipts)
    || !evidencePrefix(current.commissionedOptions, proposed.commissionedOptions)
  ) return false;
  for (const key of [
    'request',
    'receipt',
    'implementationRound',
    'continuationDeadlineAt',
    'resolvedAt',
  ] as const) {
    if (current[key] !== undefined && !isDeepStrictEqual(current[key], proposed[key])) return false;
  }
  if (
    current.deferredUntil !== undefined
    && (
      proposed.deferredUntil === undefined
      || Date.parse(proposed.deferredUntil) < Date.parse(current.deferredUntil)
    )
  ) return false;
  return true;
}

/**
 * Enforces an expected-body compare-and-swap update. Evidence can only append
 * or advance through an explicit state transition; it can never be rewritten.
 */
export function validateRelayIssueMarkerUpdateV2(input: {
  readonly expectedBody: string;
  readonly proposed: RelayGenerationRecordV2;
}): boolean {
  const current = parseRelayIssueMarkerV2(input.expectedBody);
  const proposed = input.proposed;
  if (current === null || !validateRelayGenerationV2(proposed)) return false;
  if (
    current.generation !== proposed.generation
    || !isDeepStrictEqual(current.snapshot, proposed.snapshot)
    || !isDeepStrictEqual(current.predecessor, proposed.predecessor)
    || current.executionDeadlineAt !== proposed.executionDeadlineAt
    || !phaseTransitions[current.phase].includes(proposed.phase)
    || Date.parse(proposed.updatedAt) < Date.parse(current.updatedAt)
    || current.rounds.length > proposed.rounds.length
    || current.decisions.length > proposed.decisions.length
    || !current.rounds.every((round, index) => roundMonotonic(round, proposed.rounds[index]!))
    || !current.decisions.every((decision, index) => decisionMonotonic(decision, proposed.decisions[index]!))
  ) return false;
  if (current.cancellation !== undefined && !isDeepStrictEqual(current.cancellation, proposed.cancellation)) {
    return false;
  }
  if (current.supersession !== undefined && !isDeepStrictEqual(current.supersession, proposed.supersession)) {
    return false;
  }
  return true;
}

export function relayIssueMarkerV2Digest(body: string): `sha256:${string}` {
  const record = parseRelayIssueMarkerV2(body);
  if (record === null) throw new TypeError('Relay V2 marker is malformed');
  return issueRelayCanonicalDigest(record);
}
