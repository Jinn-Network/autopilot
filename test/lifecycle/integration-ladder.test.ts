import { describe, expect, it } from 'vitest';
import {
  chooseIntegrationLadderAction,
} from '../../src/lifecycle/integration-ladder.js';

const base = {
  approved: true,
  ciGreen: true,
  draft: false,
  humanHold: false,
  mergeable: 'MERGEABLE' as const,
  mergeStateStatus: 'CLEAN',
  compareStatus: 'ahead' as const,
  openReconcileChild: false,
  openFindingChild: false,
  childrenEnabled: true,
};

describe('chooseIntegrationLadderAction', () => {
  it('returns enqueue-ready when clean and ahead', () => {
    expect(chooseIntegrationLadderAction(base)).toEqual({ kind: 'enqueue-ready' });
  });

  // BEHIND is what the merge queue *does*: it builds its candidate on top of
  // the current base and runs the required checks against that. A behind head
  // is therefore ordinary queue input, not a step on a ladder.
  it.each([
    ['BEHIND', 'behind'],
    ['CLEAN', 'behind'],
    ['CLEAN', 'diverged'],
    ['BLOCKED', 'behind'],
  ] as const)(
    'is enqueue-ready at mergeStateStatus %s with a %s compare',
    (mergeStateStatus, compareStatus) => {
      expect(chooseIntegrationLadderAction({
        ...base,
        compareStatus,
        mergeStateStatus,
      })).toEqual({ kind: 'enqueue-ready' });
    },
  );

  it('blocks exact unknown compare evidence', () => {
    expect(chooseIntegrationLadderAction({
      ...base,
      compareStatus: 'unknown',
    })).toEqual({ kind: 'blocked', reasons: ['mergeability'] });
  });

  it('blocks while GitHub has not finished computing mergeability', () => {
    expect(chooseIntegrationLadderAction({
      ...base,
      mergeable: 'UNKNOWN',
    })).toEqual({ kind: 'blocked', reasons: ['mergeability'] });
  });

  // Children arm the reconcile path and nothing else now. Disarming them used
  // to block a behind PR, because the behind PR needed a child; it needs
  // nothing at all today, so disarming children must not hold it back.
  it('still enqueues a behind head when children are disarmed', () => {
    expect(chooseIntegrationLadderAction({
      ...base,
      compareStatus: 'behind',
      mergeStateStatus: 'BEHIND',
      childrenEnabled: false,
    })).toEqual({ kind: 'enqueue-ready' });
  });

  it('blocks a conflicting head when children are disarmed', () => {
    expect(chooseIntegrationLadderAction({
      ...base,
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      childrenEnabled: false,
    })).toEqual({ kind: 'blocked', reasons: ['children-disarmed'] });
  });

  it('files reconcile child when conflicting', () => {
    expect(chooseIntegrationLadderAction({
      ...base,
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
    })).toEqual({ kind: 'file-reconcile-child', effort: 'medium' });
  });

  it('blocks when an open child exists', () => {
    expect(chooseIntegrationLadderAction({
      ...base,
      openReconcileChild: true,
    })).toEqual({ kind: 'blocked', reasons: ['open-child'] });
    expect(chooseIntegrationLadderAction({
      ...base,
      openFindingChild: true,
      compareStatus: 'behind',
    })).toEqual({ kind: 'blocked', reasons: ['open-child'] });
  });

  it('blocks draft / human / not-approved / ci', () => {
    expect(chooseIntegrationLadderAction({ ...base, draft: true }))
      .toEqual({ kind: 'blocked', reasons: ['draft'] });
    expect(chooseIntegrationLadderAction({ ...base, humanHold: true }))
      .toEqual({ kind: 'blocked', reasons: ['human'] });
    expect(chooseIntegrationLadderAction({ ...base, approved: false }))
      .toEqual({ kind: 'blocked', reasons: ['not-approved'] });
    expect(chooseIntegrationLadderAction({ ...base, ciGreen: false }))
      .toEqual({ kind: 'blocked', reasons: ['ci'] });
  });
});
