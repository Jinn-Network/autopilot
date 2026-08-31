import { describe, expect, it } from 'vitest';
import { CredentialPool } from '../../src/lifecycle/credentials.js';
import {
  evaluateEnqueueGate,
  executeEnqueueAction,
  type EnqueueCandidate,
  type EnqueueExecutorDeps,
} from '../../src/lifecycle/enqueue-executor.js';
import { gitOid, gitRefName } from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));

// Matches the default `terminalApprovalReviewer` in `candidate()` below, plus
// the alternate reviewer the self-review test substitutes. Every gate test in
// this file that is not itself exercising the new reviewer-authority check
// passes this so the new refusal reason stays out of its way.
const OPERATOR_LOGINS = new Set(['review-bot', 'implementation-bot']);

function candidate(overrides: Partial<EnqueueCandidate> = {}): EnqueueCandidate {
  return {
    issueNumber: 42,
    prNumber: 84,
    open: true,
    merged: false,
    head: HEAD,
    baseRefName: gitRefName('next'),
    expectedBaseRefName: gitRefName('next'),
    draft: false,
    labels: ['engine:review'],
    humanHold: false,
    author: 'implementation-bot',
    authorAllowed: true,
    uniqueIssueMapping: true,
    terminalApprovalMatches: true,
    terminalApprovalReviewer: 'review-bot',
    effectiveReviews: [{
      reviewer: 'review-bot',
      state: 'APPROVED',
      commitId: HEAD,
    }],
    checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    changedFilesComplete: true,
    codeownersComplete: true,
    codeownerSensitive: false,
    codeOwnerLogins: new Set<string>(),
    graphqlId: 'PR_kwDOABCD84',
    inMergeQueue: false,
    ...overrides,
  };
}

function pool(): CredentialPool {
  return new CredentialPool([
    {
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'selected-secret',
    },
    // The default candidate's `terminalApprovalReviewer`. `executeEnqueueAction`
    // now derives its operator-login set from this same pool, so the reviewer
    // that terminally approved the candidate must be a registered identity
    // here too — exactly as it would be in production, where only a
    // configured review credential can produce a signed engine approval.
    {
      login: 'review-bot',
      normalizedLogin: 'review-bot',
      reviewToken: 'review-secret',
    },
  ]);
}

function harness(overrides: Partial<EnqueueExecutorDeps> = {}) {
  const events: string[] = [];
  const deps: EnqueueExecutorDeps = {
    readCandidate: async () => candidate(),
    credentials: pool(),
    enqueueAtHead: async ({ prNumber, head, graphqlId, credential }) => {
      events.push(`enqueue:${prNumber}:${graphqlId}:${head}:${credential.login}`);
      return { status: 'enqueued', head };
    },
    ...overrides,
  };
  return { deps, events };
}

describe('head-pinned enqueue executor', () => {
  it.each([
    ['closed', { open: false }],
    ['draft', { draft: true }],
    ['Human', { humanHold: true }],
    ['author', { authorAllowed: false }],
    ['mapping', { uniqueIssueMapping: false }],
    ['marker', { terminalApprovalMatches: false }],
    ['requested changes', {
      effectiveReviews: [{ reviewer: 'other', state: 'CHANGES_REQUESTED' as const, commitId: HEAD }],
    }],
    ['empty checks', { checks: [] }],
    ['pending check', { checks: [{ name: 'test', status: 'IN_PROGRESS', conclusion: null }] }],
    ['failed check', {
      checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }],
    }],
    ['conflict', { mergeable: 'CONFLICTING' as const }],
    ['dirty', { mergeStateStatus: 'DIRTY' }],
    ['unknown mergeability', { mergeable: 'UNKNOWN' as const }],
    ['changed files', { changedFilesComplete: false }],
    ['CODEOWNERS read', { codeownersComplete: false }],
    ['CODEOWNER path with no owner approval', { codeownerSensitive: true }],
    ['wrong base', { baseRefName: gitRefName('main') }],
  ])('fails closed for %s', (_name, override) => {
    expect(evaluateEnqueueGate(candidate(override), OPERATOR_LOGINS)).toMatchObject({ pass: false });
  });

  /**
   * What the merge queue itself owns. The old gate refused an out-of-date or
   * BLOCKED head because *it* was about to merge that exact commit; the queue
   * builds its own merge candidate on top of the current base, so refusing
   * these is refusing the queue's ordinary input.
   */
  it.each([
    ['a BEHIND merge state', { mergeStateStatus: 'BEHIND' }],
    ['a BLOCKED merge state', { mergeStateStatus: 'BLOCKED' }],
    ['a merge state the queue owns', { mergeStateStatus: 'UNSTABLE' }],
  ])('lets the queue handle %s', (_name, override) => {
    expect(evaluateEnqueueGate(candidate(override), OPERATOR_LOGINS)).toEqual({ pass: true, reasons: [] });
  });

  /**
   * The author of the change and the identity that enqueues it are the same
   * account in the engine's ordinary flow. `self-review` was a merge-time
   * refusal that has no analogue here: the terminal-approval conjunct above
   * already proves an engine reviewer signed this head.
   */
  it('permits an enqueue whose approver is also the author', () => {
    expect(evaluateEnqueueGate(candidate({
      author: 'implementation-bot',
      terminalApprovalReviewer: 'implementation-bot',
    }), OPERATOR_LOGINS)).toEqual({ pass: true, reasons: [] });
  });

  it('names an unreadable mergeability as a wait, not a conflict', () => {
    expect(evaluateEnqueueGate(candidate({ mergeable: 'UNKNOWN' }), OPERATOR_LOGINS).reasons)
      .toEqual(['mergeability-unknown']);
  });

  it.each([
    ['a CONFLICTING mergeable', { mergeable: 'CONFLICTING' as const }],
    ['a DIRTY merge state', { mergeStateStatus: 'DIRTY' }],
  ])('names %s a conflict', (_name, override) => {
    expect(evaluateEnqueueGate(candidate(override), OPERATOR_LOGINS).reasons).toEqual(['conflicting']);
  });

  it('waits, rather than refusing, while checks have not reported', () => {
    expect(evaluateEnqueueGate(candidate({ checks: [] }), OPERATOR_LOGINS).reasons)
      .toEqual(['checks-missing']);
  });

  it('refuses a candidate GitHub cannot be told to enqueue', () => {
    expect(evaluateEnqueueGate(candidate({ graphqlId: undefined }), OPERATOR_LOGINS).reasons)
      .toEqual(['pull-request-node-id-missing']);
  });

  /**
   * CODEOWNERS sensitivity used to be an unconditional refusal, which routed
   * every owned-path change to a human even when an owner had already approved
   * it at this head. The refusal now names what is actually missing.
   */
  describe('codeowner-sensitive changes', () => {
    it('refuses when no configured code owner approved this head', () => {
      expect(evaluateEnqueueGate(candidate({
        codeownerSensitive: true,
        codeOwnerLogins: new Set(['owner-one']),
      }), OPERATOR_LOGINS).reasons).toEqual(['codeowner-approval-missing']);
    });

    it('passes when a configured code owner approved this head', () => {
      expect(evaluateEnqueueGate(candidate({
        codeownerSensitive: true,
        codeOwnerLogins: new Set(['Owner-One']),
        effectiveReviews: [
          { reviewer: 'review-bot', state: 'APPROVED', commitId: HEAD },
          { reviewer: 'owner-one', state: 'APPROVED', commitId: HEAD },
        ],
      }), OPERATOR_LOGINS)).toEqual({ pass: true, reasons: [] });
    });

    it('does not accept a code owner approval bound to an older head', () => {
      expect(evaluateEnqueueGate(candidate({
        codeownerSensitive: true,
        codeOwnerLogins: new Set(['owner-one']),
        effectiveReviews: [
          { reviewer: 'review-bot', state: 'APPROVED', commitId: HEAD },
          { reviewer: 'owner-one', state: 'APPROVED', commitId: gitOid('5'.repeat(40)) },
        ],
      }), OPERATOR_LOGINS).reasons).toEqual(['codeowner-approval-missing']);
    });

    it('does not accept a non-approving code owner review', () => {
      expect(evaluateEnqueueGate(candidate({
        codeownerSensitive: true,
        codeOwnerLogins: new Set(['owner-one']),
        effectiveReviews: [
          { reviewer: 'review-bot', state: 'APPROVED', commitId: HEAD },
          { reviewer: 'owner-one', state: 'COMMENTED', commitId: HEAD },
        ],
      }), OPERATOR_LOGINS).reasons).toEqual(['codeowner-approval-missing']);
    });

    // An unconfigured owner set cannot prove anyone is an owner, so it must
    // refuse — exactly what the unconditional refusal did before.
    it('refuses with an empty owner set even when someone approved', () => {
      expect(evaluateEnqueueGate(candidate({
        codeownerSensitive: true,
        codeOwnerLogins: new Set<string>(),
        effectiveReviews: [
          { reviewer: 'anyone', state: 'APPROVED', commitId: HEAD },
        ],
      }), OPERATOR_LOGINS).reasons).toEqual(['codeowner-approval-missing']);
    });

    it('ignores the owner set entirely when nothing sensitive was touched', () => {
      expect(evaluateEnqueueGate(candidate({
        codeownerSensitive: false,
        codeOwnerLogins: new Set<string>(),
      }), OPERATOR_LOGINS)).toEqual({ pass: true, reasons: [] });
    });
  });

  /**
   * `terminalApprovalMatches` proves a signed, head-bound engine approval
   * exists; it says nothing about whether the account that signed it is one
   * this deployment actually runs. A credential file edited outside the
   * configured operator set, or a review claim for an identity this
   * deployment never authenticated as, must not read as a legitimate
   * terminal approval.
   */
  describe('terminal approval reviewer authority', () => {
    it('refuses when the approving reviewer is outside the operator set', () => {
      expect(evaluateEnqueueGate(candidate({
        terminalApprovalReviewer: 'outsider-bot',
      }), OPERATOR_LOGINS).reasons).toContain('terminal-approval-reviewer');
    });

    it('passes when the approving reviewer is inside the operator set', () => {
      const result = evaluateEnqueueGate(candidate({
        terminalApprovalReviewer: 'review-bot',
      }), OPERATOR_LOGINS);
      expect(result.reasons).not.toContain('terminal-approval-reviewer');
    });

    it('folds login casing the same way the codeowner comparison does', () => {
      const result = evaluateEnqueueGate(
        candidate({ terminalApprovalReviewer: 'RitsuKai2000' }),
        new Set(['ritsukai2000']),
      );
      expect(result.reasons).not.toContain('terminal-approval-reviewer');
    });

    it('refuses a reviewer login the operator set spells with different casing', () => {
      const result = evaluateEnqueueGate(
        candidate({ terminalApprovalReviewer: 'RitsuKai2000' }),
        new Set(['someone-else']),
      );
      expect(result.reasons).toContain('terminal-approval-reviewer');
    });

    it('refuses a matched approval whose reviewer is unknown', () => {
      expect(evaluateEnqueueGate(candidate({
        terminalApprovalMatches: true,
        terminalApprovalReviewer: undefined,
      }), OPERATOR_LOGINS).reasons).toContain('terminal-approval-reviewer');
    });

    // Guards against the reason firing for an already-refused candidate: the
    // existing `terminal-approval` reason should stand alone when the marker
    // never matched in the first place, whatever the reviewer field says.
    it('does not pile on when the terminal approval itself already failed', () => {
      const result = evaluateEnqueueGate(candidate({
        terminalApprovalMatches: false,
        terminalApprovalReviewer: 'outsider-bot',
      }), OPERATOR_LOGINS);
      expect(result.reasons).toEqual(['terminal-approval']);
    });
  });

  /**
   * A merge queue is a property of one protected branch. A stacked pull request
   * whose base is another Autopilot work branch has no queue to be admitted to,
   * so enqueueing it is not a risk to be weighed — it is a call that cannot
   * succeed, and one that would burn an attempt-ledger entry against a head
   * that never did anything wrong.
   *
   * This is not the `base` reason. `base` catches a PR retargeted away from the
   * base its canonical mapping names; this catches a PR whose canonical mapping
   * legitimately names a parent work branch, which is the ordinary shape of a
   * stack and stays entirely correct until the stack collapses onto the root.
   */
  describe('stacked pull requests', () => {
    it('refuses a base that is not the repository default branch', () => {
      expect(evaluateEnqueueGate(candidate({
        baseRefName: gitRefName('autopilot/2083'),
        expectedBaseRefName: gitRefName('autopilot/2083'),
        defaultBaseRefName: gitRefName('next'),
      }), OPERATOR_LOGINS).reasons).toEqual(['stacked-base']);
    });

    it('passes a root pull request targeting the default branch', () => {
      expect(evaluateEnqueueGate(candidate({
        defaultBaseRefName: gitRefName('next'),
      }), OPERATOR_LOGINS)).toEqual({ pass: true, reasons: [] });
    });

    // Not a licence, an absence of evidence. Every production path configures
    // the default branch; a fixture that does not is simply not asserting this.
    it('says nothing about the base when the default branch is unknown', () => {
      expect(evaluateEnqueueGate(candidate({
        baseRefName: gitRefName('autopilot/2083'),
        expectedBaseRefName: gitRefName('autopilot/2083'),
      }), OPERATOR_LOGINS)).toEqual({ pass: true, reasons: [] });
    });

    it('still names a retargeted base separately from a stacked one', () => {
      expect(evaluateEnqueueGate(candidate({
        baseRefName: gitRefName('autopilot/2083'),
        expectedBaseRefName: gitRefName('next'),
        defaultBaseRefName: gitRefName('next'),
      }), OPERATOR_LOGINS).reasons).toEqual(['base', 'stacked-base']);
    });
  });

  it('rereads every gate and enqueues the exact head under the selected credential', async () => {
    const h = harness();
    await expect(
      executeEnqueueAction({
        prNumber: 84,
        expectedHead: HEAD,
        expectedBaseRefName: gitRefName('next'),
      }, h.deps),
    ).resolves.toEqual({
      status: 'enqueued',
      prNumber: 84,
      head: HEAD,
    });
    expect(h.events).toEqual([`enqueue:84:PR_kwDOABCD84:${HEAD}:implementation-bot`]);
  });

  /**
   * The candidate GitHub already has in the queue. Enqueuing it again is at
   * best a no-op and at worst a duplicated queue entry, so the executor
   * short-circuits before it ever reaches the mutation.
   */
  it('short-circuits a candidate already in the merge queue', async () => {
    const h = harness({ readCandidate: async () => candidate({ inMergeQueue: true }) });

    await expect(
      executeEnqueueAction({
        prNumber: 84,
        expectedHead: HEAD,
        expectedBaseRefName: gitRefName('next'),
      }, h.deps),
    ).resolves.toEqual({ status: 'already-enqueued', prNumber: 84, head: HEAD });
    expect(h.events).toEqual([]);
  });

  it('reports an unavailable credential as ineligible without mutating', async () => {
    // The reviewer login is registered (so the gate's operator-authority check
    // passes) but carries no token of either kind, so `selectCredential` still
    // has nothing to select from for the merge phase.
    const h = harness({
      credentials: new CredentialPool([{
        login: 'review-bot',
        normalizedLogin: 'review-bot',
      }]),
    });

    await expect(
      executeEnqueueAction({
        prNumber: 84,
        expectedHead: HEAD,
        expectedBaseRefName: gitRefName('next'),
      }, h.deps),
    ).resolves.toEqual({
      status: 'ineligible',
      prNumber: 84,
      head: HEAD,
      reasons: ['credential-unavailable'],
    });
    expect(h.events).toEqual([]);
  });

  it.each([
    'already-enqueued',
    'already-merged',
    'rejected',
    'ambiguous',
    'flake-hold',
  ] as const)('forwards a %s port outcome', async (status) => {
    const h = harness({
      enqueueAtHead: async ({ head }) => ({ status, head, reason: `port-${status}` }),
    });

    await expect(
      executeEnqueueAction({
        prNumber: 84,
        expectedHead: HEAD,
        expectedBaseRefName: gitRefName('next'),
      }, h.deps),
    ).resolves.toEqual({
      status,
      prNumber: 84,
      head: HEAD,
      reason: `port-${status}`,
    });
  });

  it('reports a head the port found moved as changed-head', async () => {
    const moved = gitOid('7'.repeat(40));
    const h = harness({
      enqueueAtHead: async () => ({ status: 'changed-head', head: moved }),
    });

    await expect(
      executeEnqueueAction({
        prNumber: 84,
        expectedHead: HEAD,
        expectedBaseRefName: gitRefName('next'),
      }, h.deps),
    ).resolves.toEqual({ status: 'changed-head', prNumber: 84, head: moved });
  });

  it('rejects a changed head on the immediate pre-enqueue reread', async () => {
    let reads = 0;
    const moved = gitOid('9'.repeat(40));
    const h = harness({
      readCandidate: async () => candidate({ head: reads++ === 0 ? HEAD : moved }),
    });
    await expect(
      executeEnqueueAction({
        prNumber: 84,
        expectedHead: HEAD,
        expectedBaseRefName: gitRefName('next'),
      }, h.deps),
    ).resolves.toEqual({ status: 'changed-head', prNumber: 84, head: moved });
    expect(h.events).toEqual([]);
  });

  it('rejects a retargeted base on the immediate pre-enqueue reread', async () => {
    let reads = 0;
    const h = harness({
      readCandidate: async () => candidate({
        baseRefName: gitRefName(reads++ === 0 ? 'next' : 'autopilot/99'),
      }),
    });

    await expect(executeEnqueueAction({
      prNumber: 84,
      expectedHead: HEAD,
      expectedBaseRefName: gitRefName('next'),
    }, h.deps)).resolves.toEqual({
      status: 'ineligible',
      prNumber: 84,
      head: HEAD,
      reasons: ['base'],
    });
    expect(h.events).toEqual([]);
  });

  it('reruns the whole gate on the second read, not just the head check', async () => {
    let reads = 0;
    const h = harness({
      readCandidate: async () => candidate(
        reads++ === 0 ? {} : { terminalApprovalMatches: false },
      ),
    });

    await expect(executeEnqueueAction({
      prNumber: 84,
      expectedHead: HEAD,
      expectedBaseRefName: gitRefName('next'),
    }, h.deps)).resolves.toEqual({
      status: 'ineligible',
      prNumber: 84,
      head: HEAD,
      reasons: ['terminal-approval'],
    });
    expect(h.events).toEqual([]);
  });

  it('allows concurrent attempts and accepts an already-enqueued readback', async () => {
    let enqueued = false;
    const h = harness({
      enqueueAtHead: async () => {
        if (enqueued) return { status: 'already-enqueued', head: HEAD };
        enqueued = true;
        return { status: 'enqueued', head: HEAD };
      },
    });
    const results = await Promise.all([
      executeEnqueueAction({
        prNumber: 84,
        expectedHead: HEAD,
        expectedBaseRefName: gitRefName('next'),
      }, h.deps),
      executeEnqueueAction({
        prNumber: 84,
        expectedHead: HEAD,
        expectedBaseRefName: gitRefName('next'),
      }, h.deps),
    ]);

    expect(results.map((result) => result.status).sort())
      .toEqual(['already-enqueued', 'enqueued']);
  });

  /**
   * Done no longer arrives from the enqueue. GitHub merges from the queue on
   * its own schedule, so the projection is driven by a later cycle reading a
   * MERGED snapshot through the existing merged-phase machinery — there is
   * nothing for this executor to reconcile.
   */
  it('never reports a merge or a Done projection of its own', async () => {
    const h = harness();

    const result = await executeEnqueueAction({
      prNumber: 84,
      expectedHead: HEAD,
      expectedBaseRefName: gitRefName('next'),
    }, h.deps);

    expect(result.status).not.toBe('merged');
    expect(result.status).not.toBe('merged-projection-pending');
    expect(h.events.some((event) => event.startsWith('done:'))).toBe(false);
  });
});

// Guard for the update-branch re-approval fix: tightening the lifecycle view is
// only safe because the merge gate itself is untouched and still fails closed on
// a missing head-bound engine approval.
describe('enqueue gate approval authority is not loosened', () => {
  it('still refuses to enqueue when the engine approval is not bound to the head', () => {
    expect(evaluateEnqueueGate(candidate({ terminalApprovalMatches: false }), OPERATOR_LOGINS)).toEqual({
      pass: false,
      reasons: ['terminal-approval'],
    });
  });

  it('still refuses when a carried-forward native APPROVED is the only approval', () => {
    // Exactly the #2130 / #2081 shape: GitHub re-pointed the old review onto the
    // update-branch merge commit, so the native review reads APPROVED at the
    // current head while the engine's signed marker is bound to the old sha.
    const result = evaluateEnqueueGate(candidate({
      terminalApprovalMatches: false,
      effectiveReviews: [{ reviewer: 'review-bot', state: 'APPROVED', commitId: HEAD }],
    }), OPERATOR_LOGINS);
    expect(result.pass).toBe(false);
    expect(result.reasons).toContain('terminal-approval');
  });
});
