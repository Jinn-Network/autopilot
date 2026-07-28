import { createHash } from 'node:crypto';
import { z } from 'zod';
import { relayGeneration, relayTaskKey } from './identity.js';
import { buildRelaySnapshot } from './snapshot.js';
import type { RelayIssueInput } from './snapshot.js';
import type {
  RelayGenerationRecordV1,
  RelayRoundRecordV1,
} from './state.js';

const RELAY_ISSUE_MARKER_PREFIX = '<!-- jinn-issue-relay:generation:v1 -->';
const MAX_RELAY_ISSUE_MARKER_BYTES = 256 * 1024;
const CANONICAL_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const GIT_OID_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SAFE_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

const NonEmptyStringSchema = z.string().min(1);
const CanonicalUtcSchema = z.string().refine(
  (value) => {
    if (!CANONICAL_UTC_PATTERN.test(value)) return false;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  },
  'Expected a canonical UTC timestamp',
);
const GitOidSchema = z.string().regex(GIT_OID_PATTERN);
const DigestSchema = z.string().regex(SHA256_PATTERN);

const SnapshotSchema = z.object({
  repository: z.object({
    slug: NonEmptyStringSchema,
    nodeId: NonEmptyStringSchema,
    visibility: z.literal('PUBLIC'),
    defaultBranch: NonEmptyStringSchema,
    baseOid: GitOidSchema,
  }).strict(),
  issue: z.object({
    number: z.number().int().safe().positive(),
    url: z.string().url(),
    title: NonEmptyStringSchema,
    body: z.string(),
    authorLogin: NonEmptyStringSchema,
    authorId: NonEmptyStringSchema,
    updatedAt: CanonicalUtcSchema,
  }).strict(),
  optIn: z.object({
    label: z.literal('engine:marketplace'),
    actorLogin: NonEmptyStringSchema,
    createdAt: CanonicalUtcSchema,
    permission: z.enum(['WRITE', 'MAINTAIN', 'ADMIN']),
  }).strict(),
  language: z.literal('typescript'),
  verificationProfile: z.literal('jinn-mono.v1'),
  acceptanceEvidence: z.array(NonEmptyStringSchema),
  admissionPolicyVersion: z.literal('jinn-issue-relay-admission.v1'),
  capturedAt: CanonicalUtcSchema,
  schemaVersion: z.literal('jinn-issue-relay-snapshot.v1'),
  snapshotDigest: DigestSchema,
}).strict();

const RoundSchema = z.object({
  round: z.number().int().safe().nonnegative(),
  purpose: z.enum(['initial', 'repair']),
  workspaceRepository: NonEmptyStringSchema,
  inputHead: GitOidSchema,
  task: z.object({
    taskKey: NonEmptyStringSchema,
    taskId: NonEmptyStringSchema,
    taskCid: NonEmptyStringSchema,
    fundedAt: CanonicalUtcSchema,
  }).strict().optional(),
  solution: z.object({
    envelopeCid: NonEmptyStringSchema,
    operatorSafe: z.string().regex(SAFE_ADDRESS_PATTERN),
    observedAt: CanonicalUtcSchema,
  }).strict().optional(),
  adoption: z.object({
    disposition: z.enum(['accepted', 'rejected']),
    resultingHead: GitOidSchema.optional(),
    receiptDigest: DigestSchema,
  }).strict().optional(),
  checks: z.object({
    head: GitOidSchema,
    status: z.enum(['pending', 'passed', 'failed']),
    digest: DigestSchema,
  }).strict().optional(),
  verdict: z.object({
    outcome: z.enum(['pass', 'request-changes', 'human', 'unresolved']),
    evaluatedHead: GitOidSchema,
    envelopeCid: NonEmptyStringSchema,
  }).strict().optional(),
}).strict();

const GenerationSchema = z.object({
  schemaVersion: z.literal('jinn-issue-relay-generation.v1'),
  generation: NonEmptyStringSchema,
  snapshot: SnapshotSchema,
  phase: z.enum([
    'awaiting-clarification',
    'refused',
    'admitted',
    'submitted',
    'solution-delivered',
    'draft-open',
    'evaluating',
    'repair-needed',
    'ready',
    'cancelling',
    'closed',
    'exhausted',
  ]),
  deadlineAt: CanonicalUtcSchema,
  rounds: z.array(RoundSchema),
  pr: z.object({
    number: z.number().int().safe().positive(),
    branch: NonEmptyStringSchema,
    head: GitOidSchema,
    draft: z.boolean(),
  }).strict().optional(),
  cancellation: z.object({
    requestedAt: CanonicalUtcSchema,
    reason: z.enum(['issue-closed', 'label-removed', 'operator']),
  }).strict().optional(),
  updatedAt: CanonicalUtcSchema,
}).strict();

function sameGitHubLogin(left: string, right: string): boolean {
  return left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US');
}

function hasValidSnapshotBinding(record: RelayGenerationRecordV1): boolean {
  const snapshotInput: RelayIssueInput = {
    repository: record.snapshot.repository,
    issue: record.snapshot.issue,
    optIn: record.snapshot.optIn,
    language: record.snapshot.language,
    verificationProfile: record.snapshot.verificationProfile,
    acceptanceEvidence: record.snapshot.acceptanceEvidence,
    admissionPolicyVersion: record.snapshot.admissionPolicyVersion,
    capturedAt: record.snapshot.capturedAt,
  };
  const rebuilt = buildRelaySnapshot(snapshotInput);
  return rebuilt.snapshotDigest === record.snapshot.snapshotDigest
    && relayGeneration(rebuilt) === record.generation;
}

function roundEvidenceIsConsistent(
  generation: string,
  round: RelayRoundRecordV1,
): boolean {
  if (round.task !== undefined && round.task.taskKey !== relayTaskKey(generation, round.round)) {
    return false;
  }
  if (round.solution !== undefined && round.task === undefined) return false;
  if (round.adoption !== undefined && round.solution === undefined) return false;
  if (
    round.adoption?.disposition === 'accepted'
    && round.adoption.resultingHead === undefined
  ) {
    return false;
  }
  if (
    round.adoption?.disposition === 'rejected'
    && round.adoption.resultingHead !== undefined
  ) {
    return false;
  }
  if (
    round.checks !== undefined
    && (
      round.adoption?.disposition !== 'accepted'
      || round.adoption.resultingHead !== round.checks.head
    )
  ) {
    return false;
  }
  if (
    round.verdict !== undefined
    && (
      round.checks?.status !== 'passed'
      || round.verdict.evaluatedHead !== round.checks.head
    )
  ) {
    return false;
  }
  return true;
}

function hasValidRoundSequence(record: RelayGenerationRecordV1): boolean {
  return record.rounds.every((round, index) => (
    round.round === index
    && round.purpose === (index === 0 ? 'initial' : 'repair')
    && roundEvidenceIsConsistent(record.generation, round)
    && (
      index === 0
      || (
        record.rounds[index - 1]?.verdict?.outcome === 'request-changes'
        && record.rounds[index - 1]?.verdict?.evaluatedHead === round.inputHead
        && record.rounds[index - 1]?.adoption?.disposition === 'accepted'
        && record.rounds[index - 1]?.adoption?.resultingHead === round.inputHead
      )
    )
  ));
}

function latestRound(record: RelayGenerationRecordV1): RelayRoundRecordV1 | undefined {
  return record.rounds.at(-1);
}

function phaseEvidenceIsConsistent(record: RelayGenerationRecordV1): boolean {
  const round = latestRound(record);
  switch (record.phase) {
    case 'awaiting-clarification':
    case 'refused':
    case 'admitted':
      return record.rounds.length === 0 && record.pr === undefined;
    case 'submitted':
      return round?.task !== undefined
        && round.solution === undefined
        && round.adoption === undefined
        && (
          round.purpose === 'initial'
          || (
            record.pr?.head === round.inputHead
            && record.pr.draft
          )
        );
    case 'solution-delivered':
      return round?.solution !== undefined
        && round.adoption === undefined
        && (
          round.purpose === 'initial'
          || (
            record.pr?.head === round.inputHead
            && record.pr.draft
          )
        );
    case 'draft-open':
      return round?.adoption?.disposition === 'accepted'
        && round.verdict === undefined
        && record.pr !== undefined
        && record.pr.head === round.adoption.resultingHead;
    case 'evaluating':
      return round?.checks?.status === 'passed'
        && record.pr?.head === round.checks.head;
    case 'repair-needed':
      return round?.verdict?.outcome === 'request-changes';
    case 'ready':
      return round?.verdict?.outcome === 'pass'
        && record.pr?.head === round.verdict.evaluatedHead;
    case 'cancelling':
      return record.cancellation !== undefined
        && record.rounds.some(({ task }) => task !== undefined);
    case 'closed':
    case 'exhausted':
      return true;
    default: {
      const exhaustive: never = record.phase;
      return exhaustive;
    }
  }
}

function decodeRecord(value: unknown): RelayGenerationRecordV1 | null {
  const decoded = GenerationSchema.safeParse(value);
  if (!decoded.success) return null;
  const record = decoded.data as RelayGenerationRecordV1;
  if (
    !hasValidSnapshotBinding(record)
    || !hasValidRoundSequence(record)
    || !phaseEvidenceIsConsistent(record)
  ) {
    return null;
  }
  return record;
}

export function formatRelayIssueMarker(record: RelayGenerationRecordV1): string {
  const decoded = decodeRecord(record);
  if (decoded === null) {
    throw new TypeError(
      'Invalid or contradictory Relay generation record, timestamp, or snapshot binding',
    );
  }
  const marker = `${RELAY_ISSUE_MARKER_PREFIX}\n\n\`\`\`json\n${JSON.stringify(decoded)}\n\`\`\``;
  if (Buffer.byteLength(marker, 'utf8') > MAX_RELAY_ISSUE_MARKER_BYTES) {
    throw new RangeError('Relay issue marker is oversized');
  }
  return marker;
}

export function parseRelayIssueMarker(input: {
  readonly body: string;
  readonly authorLogin: string;
  readonly expectedAuthorLogin: string;
}): RelayGenerationRecordV1 | null {
  if (
    input.expectedAuthorLogin.length === 0
    || !sameGitHubLogin(input.authorLogin, input.expectedAuthorLogin)
    || Buffer.byteLength(input.body, 'utf8') > MAX_RELAY_ISSUE_MARKER_BYTES
  ) {
    return null;
  }

  const escapedPrefix = RELAY_ISSUE_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^${escapedPrefix}\\n\\n\`\`\`json\\n([^\\r\\n]*)\\n\`\`\`$`,
  );
  const match = pattern.exec(input.body);
  if (match?.[1] === undefined) return null;

  try {
    const value: unknown = JSON.parse(match[1]);
    const record = decodeRecord(value);
    if (record === null || JSON.stringify(record) !== match[1]) return null;
    return record;
  } catch {
    return null;
  }
}

export interface RelayIssueMarkerUpdatePrecondition {
  readonly body: string;
  readonly expectedCurrent: {
    readonly bodyDigest: `sha256:${string}`;
    readonly generation: string;
    readonly updatedAt: string;
  };
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function relayPhaseCanAdvance(
  current: RelayGenerationRecordV1['phase'],
  proposed: RelayGenerationRecordV1['phase'],
): boolean {
  if (current === proposed) {
    return ![
      'awaiting-clarification',
      'refused',
      'ready',
      'closed',
      'exhausted',
    ].includes(current);
  }
  switch (current) {
    case 'awaiting-clarification':
    case 'refused':
    case 'ready':
    case 'closed':
    case 'exhausted':
      return false;
    case 'admitted':
      return ['submitted', 'cancelling', 'closed', 'exhausted'].includes(proposed);
    case 'submitted':
      return ['solution-delivered', 'cancelling', 'closed', 'exhausted']
        .includes(proposed);
    case 'solution-delivered':
      return ['draft-open', 'cancelling', 'closed'].includes(proposed);
    case 'draft-open':
      return ['evaluating', 'cancelling', 'closed'].includes(proposed);
    case 'evaluating':
      return ['repair-needed', 'ready', 'cancelling', 'closed'].includes(proposed);
    case 'repair-needed':
      return ['submitted', 'cancelling', 'closed', 'exhausted'].includes(proposed);
    case 'cancelling':
      return proposed === 'closed';
    default: {
      const exhaustive: never = current;
      return exhaustive;
    }
  }
}

function optionalEvidenceDoesNotRegress(
  current: unknown,
  proposed: unknown,
): boolean {
  return current === undefined || sameCanonicalValue(current, proposed);
}

function checksDoNotRegress(
  current: RelayRoundRecordV1['checks'],
  proposed: RelayRoundRecordV1['checks'],
): boolean {
  if (current === undefined) return true;
  if (proposed === undefined || current.head !== proposed.head) return false;
  switch (current.status) {
    case 'pending':
      return true;
    case 'passed':
    case 'failed':
      return sameCanonicalValue(current, proposed);
    default: {
      const exhaustive: never = current.status;
      return exhaustive;
    }
  }
}

function roundDoesNotRegress(
  current: RelayRoundRecordV1,
  proposed: RelayRoundRecordV1,
): boolean {
  return current.round === proposed.round
    && current.purpose === proposed.purpose
    && current.workspaceRepository === proposed.workspaceRepository
    && current.inputHead === proposed.inputHead
    && optionalEvidenceDoesNotRegress(current.task, proposed.task)
    && optionalEvidenceDoesNotRegress(current.solution, proposed.solution)
    && optionalEvidenceDoesNotRegress(current.adoption, proposed.adoption)
    && checksDoNotRegress(current.checks, proposed.checks)
    && optionalEvidenceDoesNotRegress(current.verdict, proposed.verdict);
}

function roundsDoNotRegress(
  current: RelayGenerationRecordV1,
  proposed: RelayGenerationRecordV1,
): boolean {
  if (
    proposed.rounds.length < current.rounds.length
    || proposed.rounds.length > current.rounds.length + 1
  ) {
    return false;
  }
  return current.rounds.every((round, index) => {
    const proposedRound = proposed.rounds[index];
    return proposedRound !== undefined && roundDoesNotRegress(round, proposedRound);
  });
}

function prDoesNotRegress(
  current: RelayGenerationRecordV1,
  proposed: RelayGenerationRecordV1,
): boolean {
  if (current.pr === undefined) return true;
  if (
    proposed.pr === undefined
    || current.pr.number !== proposed.pr.number
    || current.pr.branch !== proposed.pr.branch
    || (!current.pr.draft && proposed.pr.draft)
  ) {
    return false;
  }
  if (current.pr.head !== proposed.pr.head) {
    return proposed.rounds.at(-1)?.adoption?.disposition === 'accepted'
      && proposed.rounds.at(-1)?.adoption?.resultingHead === proposed.pr.head;
  }
  return current.pr.draft === proposed.pr.draft
    || (proposed.phase === 'ready' && !proposed.pr.draft);
}

function sameGenerationUpdateIsMonotonic(
  current: RelayGenerationRecordV1,
  proposed: RelayGenerationRecordV1,
): boolean {
  const currentUpdatedAt = Date.parse(current.updatedAt);
  const proposedUpdatedAt = Date.parse(proposed.updatedAt);
  if (
    proposedUpdatedAt <= currentUpdatedAt
    || !sameCanonicalValue(current.snapshot, proposed.snapshot)
    || current.deadlineAt !== proposed.deadlineAt
    || !relayPhaseCanAdvance(current.phase, proposed.phase)
    || !roundsDoNotRegress(current, proposed)
    || !prDoesNotRegress(current, proposed)
    || !optionalEvidenceDoesNotRegress(current.cancellation, proposed.cancellation)
  ) {
    return false;
  }

  return !sameCanonicalValue(
    current,
    { ...proposed, updatedAt: current.updatedAt },
  );
}

function isTerminalForSupersession(
  phase: RelayGenerationRecordV1['phase'],
): boolean {
  switch (phase) {
    case 'awaiting-clarification':
    case 'refused':
    case 'ready':
    case 'closed':
    case 'exhausted':
      return true;
    case 'admitted':
    case 'submitted':
    case 'solution-delivered':
    case 'draft-open':
    case 'evaluating':
    case 'repair-needed':
    case 'cancelling':
      return false;
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

function generationSupersessionIsMonotonic(
  current: RelayGenerationRecordV1,
  proposed: RelayGenerationRecordV1,
): boolean {
  return isTerminalForSupersession(current.phase)
    && current.snapshot.repository.nodeId === proposed.snapshot.repository.nodeId
    && current.snapshot.issue.number === proposed.snapshot.issue.number
    && Date.parse(proposed.snapshot.capturedAt) > Date.parse(current.snapshot.capturedAt)
    && Date.parse(proposed.snapshot.capturedAt) > Date.parse(current.updatedAt)
    && Date.parse(proposed.updatedAt) >= Date.parse(proposed.snapshot.capturedAt)
    && ['awaiting-clarification', 'refused', 'admitted'].includes(proposed.phase);
}

/**
 * Prepares a deterministic, read-compare-write precondition for the eventual
 * GitHub writer. This does not claim atomic compare-and-swap support: Task 12
 * must re-read and compare the expected body digest before updating, then
 * verify the exact proposed body on readback.
 */
export function prepareRelayIssueMarkerUpdate(input: {
  readonly current: {
    readonly body: string;
    readonly authorLogin: string;
    readonly expectedAuthorLogin: string;
  };
  readonly proposed: RelayGenerationRecordV1;
}): RelayIssueMarkerUpdatePrecondition | null {
  const current = parseRelayIssueMarker(input.current);
  const proposed = decodeRecord(input.proposed);
  if (current === null || proposed === null) return null;

  const monotonic = current.generation === proposed.generation
    ? sameGenerationUpdateIsMonotonic(current, proposed)
    : generationSupersessionIsMonotonic(current, proposed);
  if (!monotonic) return null;

  const body = formatRelayIssueMarker(proposed);
  const bodyDigest = `sha256:${createHash('sha256')
    .update(input.current.body, 'utf8')
    .digest('hex')}` as const;
  return {
    body,
    expectedCurrent: {
      bodyDigest,
      generation: current.generation,
      updatedAt: current.updatedAt,
    },
  };
}
