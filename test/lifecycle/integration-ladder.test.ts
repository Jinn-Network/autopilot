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

/**
 * #120. A conflicted pull request cannot have CI: GitHub refuses to compute a
 * merge commit for a head that does not merge, so `pull_request` workflows
 * never run and the check rollup is literally empty (`total=0`, verified on
 * mono #3060 and #3285). Gating the reconcile child on `ciGreen` therefore
 * waited on a signal the conflict itself suppressed —
 *
 *   conflict -> no merge ref -> zero check runs -> ciGreen false -> blocked
 *   on CI -> no reconcile child -> conflict
 *
 * — a closed loop with no machine exit. The conflict has to be answered first.
 */
describe('chooseIntegrationLadderAction conflict before CI (#120)', () => {
  const conflicted = {
    ...base,
    mergeable: 'CONFLICTING' as const,
    mergeStateStatus: 'DIRTY',
  };

  // The live shape of mono #3060: approved, conflicted, and no CI at all.
  it('files a reconcile child for a conflicted head with no CI', () => {
    expect(chooseIntegrationLadderAction({
      ...conflicted,
      ciGreen: false,
    })).toEqual({ kind: 'file-reconcile-child', effort: 'medium' });
  });

  it('files a reconcile child for a conflicted head with green CI', () => {
    expect(chooseIntegrationLadderAction({
      ...conflicted,
      ciGreen: true,
    })).toEqual({ kind: 'file-reconcile-child', effort: 'medium' });
  });

  // Duplicate suppression survives the move. Without the guard travelling with
  // the conflict check, a PR that already has a reconcile child open would get
  // a second one filed on the first CI-less cycle.
  it.each([true, false])(
    'blocks on the open reconcile child rather than filing a duplicate (ciGreen %s)',
    (ciGreen) => {
      expect(chooseIntegrationLadderAction({
        ...conflicted,
        ciGreen,
        openReconcileChild: true,
      })).toEqual({ kind: 'blocked', reasons: ['open-child'] });
    },
  );

  // The guard moves whole. A review-finding child is real work on the same
  // branch; a reconcile filed alongside it would have two agents pushing to one
  // head, and would be redone anyway once the finding child's merge moved it.
  it.each([true, false])(
    'blocks on an open finding child rather than filing alongside it (ciGreen %s)',
    (ciGreen) => {
      expect(chooseIntegrationLadderAction({
        ...conflicted,
        ciGreen,
        openFindingChild: true,
      })).toEqual({ kind: 'blocked', reasons: ['open-child'] });
    },
  );

  // Disarming children is a hold, never a licence to enqueue a head that does
  // not merge — including on the CI-less cycle the conflict guarantees.
  it.each([true, false])(
    'holds a conflicted head when children are disarmed (ciGreen %s)',
    (ciGreen) => {
      expect(chooseIntegrationLadderAction({
        ...conflicted,
        ciGreen,
        childrenEnabled: false,
      })).toEqual({ kind: 'blocked', reasons: ['children-disarmed'] });
    },
  );

  // A reconcile child is real work on the branch. Parked, human-held and
  // unreviewed pull requests stay above the conflict check, so none of them
  // gets one filed.
  it.each([
    ['draft', { draft: true }, 'draft'],
    ['human hold', { humanHold: true }, 'human'],
    ['not approved', { approved: false }, 'not-approved'],
  ] as const)('still blocks a conflicted head on %s', (_name, patch, reason) => {
    expect(chooseIntegrationLadderAction({
      ...conflicted,
      ciGreen: false,
      ...patch,
    })).toEqual({ kind: 'blocked', reasons: [reason] });
    expect(chooseIntegrationLadderAction({
      ...conflicted,
      ciGreen: true,
      ...patch,
    })).toEqual({ kind: 'blocked', reasons: [reason] });
  });

  // The CI gate is untouched for everything the conflict check does not answer.
  it('still blocks a non-conflicted red head on ci', () => {
    expect(chooseIntegrationLadderAction({ ...base, ciGreen: false }))
      .toEqual({ kind: 'blocked', reasons: ['ci'] });
    expect(chooseIntegrationLadderAction({
      ...base,
      ciGreen: false,
      compareStatus: 'behind',
      mergeStateStatus: 'BEHIND',
    })).toEqual({ kind: 'blocked', reasons: ['ci'] });
    // CI still outranks the open-child hold on the non-conflicted path.
    expect(chooseIntegrationLadderAction({
      ...base,
      ciGreen: false,
      openReconcileChild: true,
    })).toEqual({ kind: 'blocked', reasons: ['ci'] });
  });

  // enqueue-ready stays reachable for exactly the inputs that reached it before.
  it.each([
    ['CLEAN', 'ahead'],
    ['BEHIND', 'behind'],
    ['BLOCKED', 'behind'],
    ['UNSTABLE', 'diverged'],
    ['HAS_HOOKS', 'ahead'],
  ] as const)(
    'still returns enqueue-ready at %s with a %s compare',
    (mergeStateStatus, compareStatus) => {
      expect(chooseIntegrationLadderAction({
        ...base,
        mergeStateStatus,
        compareStatus,
      })).toEqual({ kind: 'enqueue-ready' });
    },
  );

  it('does not widen enqueue-ready to a conflicted or unreadable head', () => {
    expect(chooseIntegrationLadderAction({
      ...base,
      mergeable: 'UNKNOWN',
    })).toEqual({ kind: 'blocked', reasons: ['mergeability'] });
    expect(chooseIntegrationLadderAction({
      ...base,
      compareStatus: 'unknown',
    })).toEqual({ kind: 'blocked', reasons: ['mergeability'] });
  });
});
