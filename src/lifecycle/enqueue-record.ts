import { gitOid, type GitOid } from './types.js';

export const ENQUEUE_MARKER_PREFIX = '<!-- jinn-autopilot:enqueue:v1';

/**
 * The CAS ref that records how many times this engine has enqueued *this exact
 * head*. Keying by head rather than by PR is the flake policy in one line: a
 * new commit is a new ref, so pushing a fix resets the attempt count instead of
 * inheriting a hold from the commit it replaced.
 */
export function enqueueRef(prNumber: number, head: GitOid): string {
  return `refs/jinn-autopilot/enqueues/v1/pr-${prNumber}/${head}`;
}

export interface EnqueueRecord {
  readonly prNumber: number;
  readonly head: GitOid;
  /** Enqueue attempts recorded at this head so far; always at least 1. */
  readonly attempts: number;
  readonly enqueuedAt: string;
  /**
   * The `ci-failure` child issue filed when the second attempt at this head was
   * refused. Its presence is what releases the hold: a human-readable
   * explanation exists, so the engine may try the queue again.
   */
  readonly linkedIssue?: number;
}

export function encodeEnqueueRecord(record: EnqueueRecord): string {
  return [
    'Autopilot enqueue record',
    '',
    `${ENQUEUE_MARKER_PREFIX} pr=${record.prNumber} head=${record.head}`
    + ` attempts=${record.attempts} -->`,
    `enqueued-at=${record.enqueuedAt}`,
    ...(record.linkedIssue === undefined ? [] : [`linked-issue=${record.linkedIssue}`]),
  ].join('\n');
}

/**
 * Strict by construction. Anything that is not an exact, complete v1 record
 * decodes to `null`, and a `null` record means "no attempt recorded at this
 * head" — which *permits* an enqueue. A lenient parser would therefore turn a
 * corrupt or foreign commit message into a licence to enqueue forever, so every
 * field is either proven or the whole record is discarded.
 */
export function decodeEnqueueRecord(message: string): EnqueueRecord | null {
  const marker = message.match(
    /<!--\s*jinn-autopilot:enqueue:v1\s+pr=(\d+)\s+head=([0-9a-f]{40})\s+attempts=(\d+)\s*-->/,
  );
  if (marker === null) return null;
  const prNumber = Number(marker[1]);
  const attempts = Number(marker[3]);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
  if (!Number.isSafeInteger(attempts) || attempts <= 0) return null;
  const enqueuedAt = message.match(/^enqueued-at=(.+)$/m)?.[1];
  if (enqueuedAt === undefined || enqueuedAt.length === 0) return null;
  const rawLinkedIssue = message.match(/^linked-issue=(.+)$/m)?.[1];
  const linkedIssue = rawLinkedIssue === undefined || !/^[1-9][0-9]*$/.test(rawLinkedIssue)
    ? undefined
    : Number(rawLinkedIssue);
  return {
    prNumber,
    head: gitOid(marker[2]!),
    attempts,
    enqueuedAt,
    ...(linkedIssue === undefined || !Number.isSafeInteger(linkedIssue)
      ? {}
      : { linkedIssue }),
  };
}

export type ReEnqueueDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: 'flake-hold' };

/**
 * One retry at a head is a flake; a second failure at the same head is a
 * signal. The engine stops feeding the queue until a `ci-failure` child issue
 * exists to say why, and the record's `linked-issue` is the proof it does.
 *
 * `null` — no record at this head — is the ordinary first enqueue.
 */
export function decideReEnqueue(record: EnqueueRecord | null): ReEnqueueDecision {
  if (record === null) return { allow: true };
  if (record.attempts <= 1) return { allow: true };
  if (record.linkedIssue !== undefined) return { allow: true };
  return { allow: false, reason: 'flake-hold' };
}

/** Env knob: when unset or truthy (not 0/false/no/off), the enqueue path is armed. */
export function enqueuePathEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.JINN_AUTOPILOT_ENQUEUE;
  if (raw === undefined || raw === '') return true;
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}
