import { describe, expect, it } from 'vitest';
import {
  readExactChangedFiles,
  readExactCompareStatus,
} from '../../src/lifecycle/github-changed-files.js';
import { chooseIntegrationLadderAction } from '../../src/lifecycle/integration-ladder.js';
import { evaluateMergeGate, type MergeCandidate } from '../../src/lifecycle/merge-executor.js';
import { gitOid, gitRefName, type CompareStatus } from '../../src/lifecycle/types.js';

const HEAD = gitOid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const BASE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('readExactCompareStatus', () => {
  it('binds compare status to a fresh exact head/base read', async () => {
    const calls: string[] = [];
    const status = await readExactCompareStatus({
      run: async (_command, args) => {
        calls.push(args[1]!);
        if (args[1] === 'repos/Jinn-Network/mono/pulls/101') {
          return JSON.stringify({
            head: { sha: HEAD },
            base: { ref: 'next', sha: BASE },
          });
        }
        return JSON.stringify({ status: 'behind' });
      },
      prNumber: 101,
      expectedHead: HEAD,
      expectedBaseRefName: 'next',
      repositorySlug: 'Jinn-Network/mono',
    });

    expect(status).toBe('behind');
    expect(calls).toEqual([
      'repos/Jinn-Network/mono/pulls/101',
      `repos/Jinn-Network/mono/compare/heads/next...${HEAD}`,
    ]);
  });

  it('compares against the base branch tip, never the pinned fork point', async () => {
    const calls: string[] = [];
    await readExactCompareStatus({
      run: async (_command, args) => {
        calls.push(args[1]!);
        if (args[1] === 'repos/Jinn-Network/mono/pulls/101') {
          return JSON.stringify({
            head: { sha: HEAD },
            base: { ref: 'next', sha: BASE },
          });
        }
        return JSON.stringify({ status: 'ahead' });
      },
      prNumber: 101,
      expectedHead: HEAD,
      expectedBaseRefName: 'next',
      repositorySlug: 'Jinn-Network/mono',
    });

    expect(calls[1]).not.toContain(BASE);
    expect(calls[1]).toBe(`repos/Jinn-Network/mono/compare/heads/next...${HEAD}`);
  });

  it('rejects a compare when the fresh PR reread no longer has the expected head or base', async () => {
    await expect(readExactCompareStatus({
      run: async () => JSON.stringify({
        head: { sha: 'cccccccccccccccccccccccccccccccccccccccc' },
        base: { ref: 'next', sha: BASE },
      }),
      prNumber: 101,
      expectedHead: HEAD,
      expectedBaseRefName: 'next',
      repositorySlug: 'Jinn-Network/mono',
    })).rejects.toThrow(/exact PR authority/i);
  });

  /**
   * `gitRefName` is the only thing keeping URL construction safe. `..` rejection
   * is what stops a base branch named `x...y` from injecting a second `...`
   * separator and silently changing which comparison is performed, and the
   * `heads/` prefix stops a same-named tag from hijacking ref resolution.
   */
  it.each([
    ['embedded range separator', 'a..b'],
    ['triple-dot injection', `x...${'9'.repeat(40)}`],
    ['whitespace', 'a b'],
    ['revision suffix', 'a~1'],
    ['caret', 'a^2'],
    ['reflog syntax', 'a@{1}'],
  ])('refuses to issue a compare for an unsafe base ref (%s)', async (_name, ref) => {
    const calls: string[] = [];
    await expect(readExactCompareStatus({
      run: async (_command, args) => {
        calls.push(args[1]!);
        return JSON.stringify({ head: { sha: HEAD }, base: { ref, sha: BASE } });
      },
      prNumber: 101,
      expectedHead: HEAD,
      expectedBaseRefName: ref,
      repositorySlug: 'Jinn-Network/mono',
    })).rejects.toThrow(/Invalid Git ref name/i);

    // The PR reread happened; the compare never did.
    expect(calls).toEqual(['repos/Jinn-Network/mono/pulls/101']);
  });

  it('refuses to return changed files for an unsafe base ref', async () => {
    await expect(readExactChangedFiles({
      run: async () => JSON.stringify({
        changed_files: 1,
        head: { sha: HEAD },
        base: { ref: 'a..b', sha: BASE },
      }),
      prNumber: 101,
      expectedHead: HEAD,
      expectedBaseRefName: 'a..b',
      context: 'Merge',
      repositorySlug: 'Jinn-Network/mono',
      readFiles: async () => ['README.md'],
    })).rejects.toThrow(/Invalid Git ref name/i);
  });

  it('pins the base branch through heads/ so a same-named tag cannot hijack it', async () => {
    const calls: string[] = [];
    await readExactCompareStatus({
      run: async (_command, args) => {
        calls.push(args[1]!);
        if (args[1] === 'repos/Jinn-Network/mono/pulls/101') {
          return JSON.stringify({
            head: { sha: HEAD },
            base: { ref: 'next', sha: BASE },
          });
        }
        return JSON.stringify({ status: 'ahead' });
      },
      prNumber: 101,
      expectedHead: HEAD,
      expectedBaseRefName: 'next',
      repositorySlug: 'Jinn-Network/mono',
    });

    expect(calls[1]).toBe(`repos/Jinn-Network/mono/compare/heads/next...${HEAD}`);
  });
});

/**
 * Regression for the merge-safety defect that let Jinn-Network/mono#2081 be
 * squash-merged into `next` at 2026-07-27T19:14:08Z (merge commit bacaf0f0)
 * while 30 commits behind its base.
 *
 * Live shape, measured against Jinn-Network/mono:
 *
 *   PR    base.ref  pinned base.sha  compare(base.sha...head)  compare(base.ref...head)
 *   2130  next      a74705e8         ahead   19/0              diverged  ahead 19 / behind 41
 *   2081  next      1f12d068         ahead   20/0              diverged  ahead 20 / behind 30
 *
 * `pulls/{n}.base.sha` is the fork point and is always an ancestor of head, so
 * comparing against it is structurally `ahead` and the `behind` merge-gate
 * reason was unreachable.
 */
describe('stale-base merge safety (mono#2081 regression)', () => {
  const PR_2081_HEAD = gitOid('765262e7f83cfd4fc6cc4147413b3fc59ccceeb7');
  const PR_2081_FORK_POINT = '1f12d06835345af108c19ee121d08c056a426285';

  /**
   * Models the real graph: head is 20 ahead of the pinned fork point and 0
   * behind it, while `next` has moved 30 commits past that fork point.
   */
  function monoRun(calls: string[]) {
    return async (_command: string, args: readonly string[]): Promise<string> => {
      const path = args[1]!;
      calls.push(path);
      if (path === 'repos/Jinn-Network/mono/pulls/2081') {
        return JSON.stringify({
          changed_files: 1,
          head: { sha: PR_2081_HEAD },
          base: { ref: 'next', sha: PR_2081_FORK_POINT },
        });
      }
      if (path === `repos/Jinn-Network/mono/compare/${PR_2081_FORK_POINT}...${PR_2081_HEAD}`) {
        return JSON.stringify({ status: 'ahead', ahead_by: 20, behind_by: 0 });
      }
      if (path === `repos/Jinn-Network/mono/compare/heads/next...${PR_2081_HEAD}`) {
        return JSON.stringify({ status: 'diverged', ahead_by: 20, behind_by: 30 });
      }
      throw new Error(`unexpected gh api path: ${path}`);
    };
  }

  function gateCandidate(compareStatus: CompareStatus): MergeCandidate {
    return {
      issueNumber: 2080,
      prNumber: 2081,
      open: true,
      merged: false,
      head: PR_2081_HEAD,
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
        commitId: PR_2081_HEAD,
      }],
      checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      compareStatus,
      changedFilesComplete: true,
      codeownersComplete: true,
      codeownerSensitive: false,
    };
  }

  it('resolves diverged, not ahead, when the base branch has moved past the fork point', async () => {
    const calls: string[] = [];
    const status = await readExactCompareStatus({
      run: monoRun(calls),
      prNumber: 2081,
      expectedHead: PR_2081_HEAD,
      expectedBaseRefName: 'next',
      repositorySlug: 'Jinn-Network/mono',
    });

    expect(status).toBe('diverged');
    expect(calls).not.toContain(
      `repos/Jinn-Network/mono/compare/${PR_2081_FORK_POINT}...${PR_2081_HEAD}`,
    );
  });

  it('reaches the ladder and arms update-branch on that status', async () => {
    const status = await readExactCompareStatus({
      run: monoRun([]),
      prNumber: 2081,
      expectedHead: PR_2081_HEAD,
      expectedBaseRefName: 'next',
      repositorySlug: 'Jinn-Network/mono',
    });

    // The controller only consults the ladder for behind/diverged/unknown, so
    // the old `ahead` short-circuited the whole recovery path.
    expect(['behind', 'diverged', 'unknown']).toContain(status);
    expect(chooseIntegrationLadderAction({
      approved: true,
      ciGreen: true,
      draft: false,
      humanHold: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      compareStatus: status,
      openReconcileChild: false,
      openFindingChild: false,
      childrenEnabled: true,
    })).toEqual({ kind: 'update-branch' });
  });

  it('blocks the merge gate with reason "behind" on that status', async () => {
    const status = await readExactCompareStatus({
      run: monoRun([]),
      prNumber: 2081,
      expectedHead: PR_2081_HEAD,
      expectedBaseRefName: 'next',
      repositorySlug: 'Jinn-Network/mono',
    });
    const gate = evaluateMergeGate(gateCandidate(status));

    expect(gate.pass).toBe(false);
    expect(gate.reasons).toContain('behind');
  });

  it('keeps baseOid pinned to the fork point for CODEOWNERS while exposing the ref separately', async () => {
    const calls: string[] = [];
    const changed = await readExactChangedFiles({
      run: monoRun(calls),
      prNumber: 2081,
      expectedHead: PR_2081_HEAD,
      expectedBaseRefName: 'next',
      context: 'Merge',
      repositorySlug: 'Jinn-Network/mono',
      readFiles: async () => ['packages/core/src/index.ts'],
    });

    expect(changed.baseOid).toBe(PR_2081_FORK_POINT);
    expect(changed.baseRefName).toBe('next');
    expect(changed.complete).toBe(true);
  });
});
