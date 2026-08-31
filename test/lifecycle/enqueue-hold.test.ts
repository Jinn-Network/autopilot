import { describe, expect, it } from 'vitest';
import {
  ENQUEUE_HOLD_REF_GLOB,
  ENQUEUE_HOLD_REF_PREFIX,
  encodeEnqueueHoldRecord,
  enqueueHoldRef,
  parseEnqueueHoldRef,
} from '../../src/lifecycle/enqueue-hold.js';
import { gitOid } from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));

/**
 * `git ls-remote` glob semantics for the one shape this namespace uses: a
 * literal prefix followed by a single trailing `*`. Written out rather than
 * asserted by `startsWith` so the test proves the *glob* admits both classes,
 * which is what the reader's single listing depends on.
 */
function globMatches(glob: string, ref: string): boolean {
  if (!glob.endsWith('*')) throw new Error('this matcher only handles a trailing star');
  return ref.startsWith(glob.slice(0, -1));
}

describe('enqueue hold refs', () => {
  it.each(['flake', 'rejected'] as const)('round-trips a %s hold ref', (kind) => {
    const ref = enqueueHoldRef(kind, 84, HEAD);

    expect(ref).toBe(`refs/jinn-autopilot/enqueue-holds/v1/${kind}/pr-84/${HEAD}`);
    expect(parseEnqueueHoldRef(ref)).toEqual({ kind, prNumber: 84, head: HEAD });
  });

  it('is keyed by head, so a different head is a different ref', () => {
    const other = gitOid('2'.repeat(40));

    expect(enqueueHoldRef('flake', 84, HEAD)).not.toBe(enqueueHoldRef('flake', 84, other));
  });

  it('admits both hold classes under one ls-remote glob', () => {
    expect(ENQUEUE_HOLD_REF_GLOB).toBe(`${ENQUEUE_HOLD_REF_PREFIX}*`);
    for (const kind of ['flake', 'rejected'] as const) {
      expect(globMatches(ENQUEUE_HOLD_REF_GLOB, enqueueHoldRef(kind, 84, HEAD))).toBe(true);
    }
  });

  /**
   * The glob is a prefix match, so the reader sees every ref anyone ever puts
   * under this namespace — a future hold class, a typo, a hand-pushed ref. None
   * of them may be read as a hold at a head this engine would then skip, so
   * anything that is not an exact v1 ref parses to `null`.
   */
  it.each([
    ['a foreign kind', `${ENQUEUE_HOLD_REF_PREFIX}stuck/pr-84/${HEAD}`],
    ['a missing pr- prefix', `${ENQUEUE_HOLD_REF_PREFIX}flake/84/${HEAD}`],
    ['a non-numeric pr number', `${ENQUEUE_HOLD_REF_PREFIX}flake/pr-x/${HEAD}`],
    ['a zero pr number', `${ENQUEUE_HOLD_REF_PREFIX}flake/pr-0/${HEAD}`],
    ['a short head', `${ENQUEUE_HOLD_REF_PREFIX}flake/pr-84/${'1'.repeat(39)}`],
    ['an uppercase head', `${ENQUEUE_HOLD_REF_PREFIX}flake/pr-84/${'A'.repeat(40)}`],
    ['a trailing segment', `${ENQUEUE_HOLD_REF_PREFIX}flake/pr-84/${HEAD}/extra`],
    ['a v2 namespace', `refs/jinn-autopilot/enqueue-holds/v2/flake/pr-84/${HEAD}`],
    ['another namespace entirely', `refs/jinn-autopilot/enqueues/v1/pr-84/${HEAD}`],
    ['a branch', 'refs/heads/next'],
  ])('refuses %s', (_name, ref) => {
    expect(parseEnqueueHoldRef(ref)).toBeNull();
  });

  /**
   * Forensics only. Nothing in the engine decodes this message, which is the
   * whole reason the hold namespace carries no fail-open risk: an older engine
   * that has never heard of these refs simply does not list them.
   */
  it('encodes a human-readable, never-parsed hold record', () => {
    const message = encodeEnqueueHoldRecord(
      'GraphQL: Could not resolve to a node',
      '2026-07-20T12:00:00.000Z',
    );

    expect(message).toContain('held-at=2026-07-20T12:00:00.000Z');
    expect(message).toContain('GraphQL: Could not resolve to a node');
  });
});
