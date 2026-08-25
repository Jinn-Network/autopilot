import { describe, expect, it } from 'vitest';
import {
  decideReEnqueue,
  decodeEnqueueRecord,
  encodeEnqueueRecord,
  enqueuePathEnabled,
  enqueueRef,
  type EnqueueRecord,
} from '../../src/lifecycle/enqueue-record.js';
import { gitOid } from '../../src/lifecycle/types.js';

const HEAD = gitOid('a'.repeat(40));
const OTHER_HEAD = gitOid('b'.repeat(40));

function record(overrides: Partial<EnqueueRecord> = {}): EnqueueRecord {
  return {
    prNumber: 101,
    head: HEAD,
    attempts: 1,
    enqueuedAt: '2026-07-20T12:00:00.000Z',
    ...overrides,
  };
}

describe('enqueue attempt ref', () => {
  it('keys the ref by PR number and head', () => {
    expect(enqueueRef(101, HEAD))
      .toBe(`refs/jinn-autopilot/enqueues/v1/pr-101/${HEAD}`);
  });

  // Per-head keying is the whole flake policy: a new commit is a new ref, so
  // pushing a fix resets the attempt count instead of inheriting a hold.
  it('gives a different head a different ref', () => {
    expect(enqueueRef(101, HEAD)).not.toBe(enqueueRef(101, OTHER_HEAD));
  });
});

describe('enqueue record codec', () => {
  it('round-trips a first attempt', () => {
    expect(decodeEnqueueRecord(encodeEnqueueRecord(record()))).toEqual(record());
  });

  it('round-trips a linked flake issue', () => {
    const linked = record({ attempts: 2, linkedIssue: 4_242 });
    expect(decodeEnqueueRecord(encodeEnqueueRecord(linked))).toEqual(linked);
  });

  it('carries the marker so a foreign commit message cannot be mistaken for one', () => {
    expect(encodeEnqueueRecord(record()))
      .toContain(`<!-- jinn-autopilot:enqueue:v1 pr=101 head=${HEAD} attempts=1 -->`);
  });

  it.each([
    ['no marker at all', 'Autopilot enqueue record\n\nenqueued-at=2026-07-20T12:00:00.000Z'],
    [
      'a short head oid',
      '<!-- jinn-autopilot:enqueue:v1 pr=101 head=abc attempts=1 -->\n'
      + 'enqueued-at=2026-07-20T12:00:00.000Z',
    ],
    [
      'a non-numeric attempt count',
      `<!-- jinn-autopilot:enqueue:v1 pr=101 head=${'a'.repeat(40)} attempts=many -->\n`
      + 'enqueued-at=2026-07-20T12:00:00.000Z',
    ],
    [
      'a zero attempt count',
      `<!-- jinn-autopilot:enqueue:v1 pr=101 head=${'a'.repeat(40)} attempts=0 -->\n`
      + 'enqueued-at=2026-07-20T12:00:00.000Z',
    ],
    [
      'a missing enqueued-at',
      `<!-- jinn-autopilot:enqueue:v1 pr=101 head=${'a'.repeat(40)} attempts=1 -->`,
    ],
    [
      'the wrong marker version',
      `<!-- jinn-autopilot:enqueue:v2 pr=101 head=${'a'.repeat(40)} attempts=1 -->\n`
      + 'enqueued-at=2026-07-20T12:00:00.000Z',
    ],
  ])('refuses to decode %s', (_name, message) => {
    expect(decodeEnqueueRecord(message)).toBeNull();
  });

  it('ignores a malformed linked-issue line rather than inventing a link', () => {
    const message = `${encodeEnqueueRecord(record({ attempts: 2 }))}\nlinked-issue=not-a-number`;
    expect(decodeEnqueueRecord(message)).toMatchObject({ attempts: 2 });
    expect(decodeEnqueueRecord(message)?.linkedIssue).toBeUndefined();
  });
});

/**
 * Flake policy. One retry at a head is a flake; a second failure at the same
 * head is a signal, and the engine must not keep feeding the queue until a
 * human-readable issue exists to explain why it stopped.
 */
describe('decideReEnqueue', () => {
  it('allows the first enqueue at a head with no record', () => {
    expect(decideReEnqueue(null)).toEqual({ allow: true });
  });

  it('allows one retry after a single recorded attempt', () => {
    expect(decideReEnqueue(record({ attempts: 1 }))).toEqual({ allow: true });
  });

  it.each([2, 3, 9])('refuses at %i recorded attempts with no linked issue', (attempts) => {
    expect(decideReEnqueue(record({ attempts }))).toEqual({
      allow: false,
      reason: 'flake-hold',
    });
  });

  it('allows a re-enqueue once the flake is linked to an issue', () => {
    expect(decideReEnqueue(record({ attempts: 2, linkedIssue: 4_242 })))
      .toEqual({ allow: true });
  });
});

describe('enqueuePathEnabled', () => {
  it.each([
    [{}, true],
    [{ JINN_AUTOPILOT_ENQUEUE: '' }, true],
    [{ JINN_AUTOPILOT_ENQUEUE: '1' }, true],
    [{ JINN_AUTOPILOT_ENQUEUE: 'yes' }, true],
    [{ JINN_AUTOPILOT_ENQUEUE: 'anything-else' }, true],
    [{ JINN_AUTOPILOT_ENQUEUE: '0' }, false],
    [{ JINN_AUTOPILOT_ENQUEUE: 'false' }, false],
    [{ JINN_AUTOPILOT_ENQUEUE: 'FALSE' }, false],
    [{ JINN_AUTOPILOT_ENQUEUE: 'no' }, false],
    [{ JINN_AUTOPILOT_ENQUEUE: 'Off' }, false],
  ])('reads %j as %s', (env, expected) => {
    expect(enqueuePathEnabled(env)).toBe(expected);
  });
});
