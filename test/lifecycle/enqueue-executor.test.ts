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
    compareStatus: 'ahead',
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
  return new CredentialPool([{
    login: 'implementation-bot',
    normalizedLogin: 'implementation-bot',
    implementationToken: 'selected-secret',
  }]);
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
    expect(evaluateEnqueueGate(candidate(override))).toMatchObject({ pass: false });
  });

  /**
   * What the merge queue itself owns. The old gate refused an out-of-date or
   * BLOCKED head because *it* was about to merge that exact commit; the queue
   * builds its own merge candidate on top of the current base, so refusing
   * these is refusing the queue's ordinary input.
   */
  it.each([
    ['a behind head', { compareStatus: 'behind' as const }],
    ['a diverged head', { compareStatus: 'diverged' as const }],
    ['an unreadable compare', { compareStatus: 'unknown' as const }],
    ['a BEHIND merge state', { mergeStateStatus: 'BEHIND' }],
    ['a BLOCKED merge state', { mergeStateStatus: 'BLOCKED' }],
    ['a merge state the queue owns', { mergeStateStatus: 'UNSTABLE' }],
  ])('lets the queue handle %s', (_name, override) => {
    expect(evaluateEnqueueGate(candidate(override))).toEqual({ pass: true, reasons: [] });
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
    }))).toEqual({ pass: true, reasons: [] });
  });

  it('names an unreadable mergeability as a wait, not a conflict', () => {
    expect(evaluateEnqueueGate(candidate({ mergeable: 'UNKNOWN' })).reasons)
      .toEqual(['mergeability-unknown']);
  });

  it.each([
    ['a CONFLICTING mergeable', { mergeable: 'CONFLICTING' as const }],
    ['a DIRTY merge state', { mergeStateStatus: 'DIRTY' }],
  ])('names %s a conflict', (_name, override) => {
    expect(evaluateEnqueueGate(candidate(override)).reasons).toEqual(['conflicting']);
  });

  it('waits, rather than refusing, while checks have not reported', () => {
    expect(evaluateEnqueueGate(candidate({ checks: [] })).reasons)
      .toEqual(['checks-missing']);
  });

  it('refuses a candidate GitHub cannot be told to enqueue', () => {
    expect(evaluateEnqueueGate(candidate({ graphqlId: undefined })).reasons)
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
      })).reasons).toEqual(['codeowner-approval-missing']);
    });

    it('passes when a configured code owner approved this head', () => {
      expect(evaluateEnqueueGate(candidate({
        codeownerSensitive: true,
        codeOwnerLogins: new Set(['Owner-One']),
        effectiveReviews: [
          { reviewer: 'review-bot', state: 'APPROVED', commitId: HEAD },
          { reviewer: 'owner-one', state: 'APPROVED', commitId: HEAD },
        ],
      }))).toEqual({ pass: true, reasons: [] });
    });

    it('does not accept a code owner approval bound to an older head', () => {
      expect(evaluateEnqueueGate(candidate({
        codeownerSensitive: true,
        codeOwnerLogins: new Set(['owner-one']),
        effectiveReviews: [
          { reviewer: 'review-bot', state: 'APPROVED', commitId: HEAD },
          { reviewer: 'owner-one', state: 'APPROVED', commitId: gitOid('5'.repeat(40)) },
        ],
      })).reasons).toEqual(['codeowner-approval-missing']);
    });

    it('does not accept a non-approving code owner review', () => {
      expect(evaluateEnqueueGate(candidate({
        codeownerSensitive: true,
        codeOwnerLogins: new Set(['owner-one']),
        effectiveReviews: [
          { reviewer: 'review-bot', state: 'APPROVED', commitId: HEAD },
          { reviewer: 'owner-one', state: 'COMMENTED', commitId: HEAD },
        ],
      })).reasons).toEqual(['codeowner-approval-missing']);
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
      })).reasons).toEqual(['codeowner-approval-missing']);
    });

    it('ignores the owner set entirely when nothing sensitive was touched', () => {
      expect(evaluateEnqueueGate(candidate({
        codeownerSensitive: false,
        codeOwnerLogins: new Set<string>(),
      }))).toEqual({ pass: true, reasons: [] });
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
    const h = harness({ credentials: new CredentialPool([]) });

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
    expect(evaluateEnqueueGate(candidate({ terminalApprovalMatches: false }))).toEqual({
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
    }));
    expect(result.pass).toBe(false);
    expect(result.reasons).toContain('terminal-approval');
  });
});
