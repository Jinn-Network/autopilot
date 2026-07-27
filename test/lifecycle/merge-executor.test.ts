import { describe, expect, it } from 'vitest';
import { CredentialPool } from '../../src/lifecycle/credentials.js';
import {
  evaluateMergeGate,
  executeMergeAction,
  executeUpdateBranchAction,
  type MergeCandidate,
  type MergeExecutorDeps,
} from '../../src/lifecycle/merge-executor.js';
import { gitOid, gitRefName } from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));

function candidate(overrides: Partial<MergeCandidate> = {}): MergeCandidate {
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

function harness(overrides: Partial<MergeExecutorDeps> = {}) {
  const events: string[] = [];
  const deps: MergeExecutorDeps = {
    readCandidate: async () => candidate(),
    credentials: pool(),
    mergeExactHead: async ({ head, credential }) => {
      events.push(`merge:${head}:${credential.login}`);
      return { status: 'merged', head, mergeCommitOid: gitOid('2'.repeat(40)) };
    },
    reconcileDone: async ({ expectedHead }) => {
      events.push(`done:${expectedHead}`);
    },
    ...overrides,
  };
  return { deps, events };
}

describe('head-pinned merge executor', () => {
  it.each([
    ['closed', { open: false }],
    ['draft', { draft: true }],
    ['Human', { humanHold: true }],
    ['author', { authorAllowed: false }],
    ['mapping', { uniqueIssueMapping: false }],
    ['marker', { terminalApprovalMatches: false }],
    ['self-review', { terminalApprovalReviewer: 'implementation-bot' }],
    ['requested changes', {
      effectiveReviews: [{ reviewer: 'other', state: 'CHANGES_REQUESTED' as const, commitId: HEAD }],
    }],
    ['empty checks', { checks: [] }],
    ['pending check', { checks: [{ name: 'test', status: 'IN_PROGRESS', conclusion: null }] }],
    ['failed check', {
      checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }],
    }],
    ['behind', { compareStatus: 'behind' as const }],
    ['conflict', { mergeable: 'CONFLICTING' as const }],
    ['unknown', { mergeable: 'UNKNOWN' as const }],
    ['changed files', { changedFilesComplete: false }],
    ['CODEOWNERS read', { codeownersComplete: false }],
    ['CODEOWNER path', { codeownerSensitive: true }],
    ['wrong base', { baseRefName: gitRefName('main') }],
  ])('fails closed for %s', (_name, override) => {
    expect(evaluateMergeGate(candidate(override))).toMatchObject({ pass: false });
  });

  it('rereads every gate and sends the exact head without bypass flags', async () => {
    const h = harness();
    await expect(
      executeMergeAction({
        prNumber: 84,
        expectedHead: HEAD,
        expectedBaseRefName: gitRefName('next'),
      }, h.deps),
    ).resolves.toEqual({
      status: 'merged',
      prNumber: 84,
      head: HEAD,
      mergeCommitOid: gitOid('2'.repeat(40)),
    });
    expect(h.events).toEqual([`merge:${HEAD}:implementation-bot`, `done:${HEAD}`]);
  });

  it('rejects a changed head on the immediate pre-merge reread', async () => {
    let reads = 0;
    const moved = gitOid('9'.repeat(40));
    const h = harness({
      readCandidate: async () => candidate({ head: reads++ === 0 ? HEAD : moved }),
    });
    await expect(
      executeMergeAction({
        prNumber: 84,
        expectedHead: HEAD,
        expectedBaseRefName: gitRefName('next'),
      }, h.deps),
    ).resolves.toEqual({ status: 'changed-head', prNumber: 84, head: moved });
    expect(h.events).toEqual([]);
  });

  it('rejects a retargeted base on the immediate pre-merge reread', async () => {
    let reads = 0;
    const h = harness({
      readCandidate: async () => candidate({
        baseRefName: gitRefName(reads++ === 0 ? 'next' : 'autopilot/99'),
      }),
    });

    await expect(executeMergeAction({
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

  it('allows concurrent attempts and accepts already-merged exact readback', async () => {
    let merged = false;
    const h = harness({
      mergeExactHead: async () => {
        if (merged) return { status: 'already-merged', head: HEAD, mergeCommitOid: gitOid('2'.repeat(40)) };
        merged = true;
        return { status: 'merged', head: HEAD, mergeCommitOid: gitOid('2'.repeat(40)) };
      },
    });
    const results = await Promise.all([
      executeMergeAction({
        prNumber: 84,
        expectedHead: HEAD,
        expectedBaseRefName: gitRefName('next'),
      }, h.deps),
      executeMergeAction({
        prNumber: 84,
        expectedHead: HEAD,
        expectedBaseRefName: gitRefName('next'),
      }, h.deps),
    ]);
    expect(results.every((result) => result.status === 'merged')).toBe(true);
  });

  it('does not report terminal success when Done projection is ambiguous', async () => {
    const h = harness({
      reconcileDone: async () => {
        throw new Error('readback ambiguous');
      },
    });
    await expect(
      executeMergeAction({
        prNumber: 84,
        expectedHead: HEAD,
        expectedBaseRefName: gitRefName('next'),
      }, h.deps),
    ).resolves.toMatchObject({ status: 'merged-projection-pending' });
  });
});

// Guard for the update-branch re-approval fix: tightening the lifecycle view is
// only safe because the merge gate itself is untouched and still fails closed on
// a missing head-bound engine approval.
describe('merge gate approval authority is not loosened', () => {
  it('still refuses to merge when the engine approval is not bound to the head', () => {
    expect(evaluateMergeGate(candidate({ terminalApprovalMatches: false }))).toEqual({
      pass: false,
      reasons: ['terminal-approval'],
    });
  });

  it('still refuses when a carried-forward native APPROVED is the only approval', () => {
    // Exactly the #2130 / #2081 shape: GitHub re-pointed the old review onto the
    // update-branch merge commit, so the native review reads APPROVED at the
    // current head while the engine's signed marker is bound to the old sha.
    const result = evaluateMergeGate(candidate({
      terminalApprovalMatches: false,
      effectiveReviews: [{ reviewer: 'review-bot', state: 'APPROVED', commitId: HEAD }],
    }));
    expect(result.pass).toBe(false);
    expect(result.reasons).toContain('terminal-approval');
  });
});

/**
 * `update-branch` outcome mapping. The old executor ended with an unconditional
 * `return { status: 'updated' }`, so every outcome that was neither
 * `changed-head` nor `rejected` was reported to the operator as a successful
 * branch update. That is the fail-open shape these tests pin shut.
 */
describe('update-branch outcome mapping fails closed', () => {
  const updateHarness = (
    outcome: Awaited<ReturnType<NonNullable<MergeExecutorDeps['updateBranch']>>>,
  ) => ({
    ...harness().deps,
    updateBranch: async () => outcome,
  });

  it('reports an accepted-but-queued update as pending, never as updated', async () => {
    const result = await executeUpdateBranchAction(
      { prNumber: 84, expectedHead: HEAD },
      updateHarness({ status: 'pending', head: HEAD, failure: 'queued' }),
    );

    expect(result).toEqual({
      status: 'pending',
      prNumber: 84,
      reason: 'update-branch-queued',
    });
  });

  it.each([
    ['rate-limited', 'pending'],
    ['unavailable', 'pending'],
    ['unclassified', 'pending'],
  ] as const)('reports a %s outcome as %s', async (failure, status) => {
    const result = await executeUpdateBranchAction(
      { prNumber: 84, expectedHead: HEAD },
      updateHarness({ status: 'pending', head: HEAD, failure }),
    );

    expect(result).toMatchObject({ status, reason: `update-branch-${failure}` });
  });

  it.each(['conflict', 'forbidden'] as const)(
    'keeps a durable %s refusal a rejection and names the class',
    async (failure) => {
      const result = await executeUpdateBranchAction(
        { prNumber: 84, expectedHead: HEAD },
        updateHarness({ status: 'rejected', head: HEAD, failure }),
      );

      expect(result).toEqual({
        status: 'rejected',
        prNumber: 84,
        reason: `update-branch-${failure}`,
      });
    },
  );

  it('still reports a genuine head move as updated', async () => {
    const moved = gitOid('7'.repeat(40));
    const result = await executeUpdateBranchAction(
      { prNumber: 84, expectedHead: HEAD },
      updateHarness({ status: 'updated', head: moved }),
    );

    expect(result).toEqual({ status: 'updated', prNumber: 84, head: moved });
  });

  /**
   * A variant nobody has taught the executor about. TypeScript proves this
   * unreachable today; the runtime arm exists so that adding a case to
   * `UpdateBranchOutcome` and forgetting this switch cannot make the new case
   * inherit success.
   */
  it('never reports an unhandled outcome variant as updated', async () => {
    const result = await executeUpdateBranchAction(
      { prNumber: 84, expectedHead: HEAD },
      {
        ...harness().deps,
        updateBranch: async () => ({
          status: 'queued-somewhere-new',
          head: HEAD,
        }) as unknown as Awaited<
        ReturnType<NonNullable<MergeExecutorDeps['updateBranch']>>
        >,
      },
    );

    expect(result.status).not.toBe('updated');
    expect(result).toEqual({
      status: 'pending',
      prNumber: 84,
      reason: 'update-branch-unclassified',
    });
  });
});
