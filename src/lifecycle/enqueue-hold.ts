import { gitOid, type GitOid } from './types.js';

/**
 * A head-keyed namespace recording that the engine has already paid for — and
 * already lost — an enqueue decision at this exact head, so a later cycle can
 * refuse to re-derive it.
 *
 * THE INVARIANT: *the hold ref is never stickier than the decision it caches.*
 * The head is in the ref name, so a new commit is a new ref and no hold
 * survives it. Nothing else releases a hold, and nothing needs to: every
 * decision cached here is a decision that was true of one immutable commit.
 *
 * WHY A SEPARATE NAMESPACE, and not a field on the enqueue-attempt record.
 * `decodeEnqueueRecord` fails OPEN — a message it cannot parse decodes to
 * `null`, and `null` *permits* an enqueue. Any new marker or field in that
 * record is therefore a silent fail-open under engine-version skew: an older
 * engine reading a newer record reads "no attempt at this head". A separate ref
 * namespace has no such hazard in either direction. An older engine never lists
 * these refs and simply behaves as it does today; a newer one lists them and
 * skips. Bumping `attempts` for a mutation the merge queue never accepted would
 * additionally be false on its face.
 *
 * NOTHING PARSES THE COMMIT MESSAGE. {@link encodeEnqueueHoldRecord} writes
 * forensics for a human reading `git log`; the whole of the machine-readable
 * state is the ref *name*, which {@link parseEnqueueHoldRef} decodes strictly.
 * There is consequently no decode hazard to fail open on.
 */
export const ENQUEUE_HOLD_REF_PREFIX = 'refs/jinn-autopilot/enqueue-holds/v1/';
export const ENQUEUE_HOLD_REF_GLOB = `${ENQUEUE_HOLD_REF_PREFIX}*`;

/**
 * `flake` — the terminal flake hold: this head has exhausted its attempts and
 * the `ci-failure` child that explains it already exists.
 * `rejected` — the merge queue durably refused this exact pull request at this
 * head (an unresolvable node id, a 404). Repository-wide refusals are
 * deliberately NOT recorded here: they are not a property of this head.
 */
export type EnqueueHoldKind = 'flake' | 'rejected';

export function enqueueHoldRef(
  kind: EnqueueHoldKind,
  prNumber: number,
  head: GitOid,
): string {
  return `${ENQUEUE_HOLD_REF_PREFIX}${kind}/pr-${prNumber}/${head}`;
}

const HOLD_REF_PATTERN = new RegExp(
  `^${ENQUEUE_HOLD_REF_PREFIX}(flake|rejected)/pr-([1-9][0-9]*)/([0-9a-f]{40})$`,
);

/**
 * Strict by construction, and for the same reason `decodeEnqueueRecord` is: the
 * reader's one `ls-remote` uses a prefix glob, so it sees every ref anyone puts
 * under this namespace. Only an exact v1 ref may cause a head to be skipped;
 * anything else — a future hold class, a hand-pushed ref, a typo — is a foreign
 * ref and parses to `null`, which reproduces today's behaviour exactly.
 */
export function parseEnqueueHoldRef(ref: string): {
  readonly kind: EnqueueHoldKind;
  readonly prNumber: number;
  readonly head: GitOid;
} | null {
  const match = HOLD_REF_PATTERN.exec(ref);
  if (match === null) return null;
  const prNumber = Number(match[2]);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
  return {
    kind: match[1] as EnqueueHoldKind,
    prNumber,
    head: gitOid(match[3]!),
  };
}

/**
 * Forensics for whoever runs `git log` on a hold ref. Deliberately has no
 * decoder: the ref name carries every fact the engine acts on, so this text can
 * never widen or narrow a decision by being malformed.
 */
export function encodeEnqueueHoldRecord(reason: string, heldAt: string): string {
  return [
    'Autopilot enqueue hold',
    '',
    `held-at=${heldAt}`,
    '',
    reason,
  ].join('\n');
}
