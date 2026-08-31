import { describe, expect, it } from 'vitest';
import {
  readExactChangedFiles,
  readExactCompareEvidence,
  readExactCompareStatus,
} from '../../src/lifecycle/github-changed-files.js';
import { reviewedDiffDigestFromCompare } from '../../src/lifecycle/reviewed-diff-digest.js';
import { chooseIntegrationLadderAction } from '../../src/lifecycle/integration-ladder.js';
import { evaluateEnqueueGate, type EnqueueCandidate } from '../../src/lifecycle/enqueue-executor.js';
import { gitOid, gitRefName } from '../../src/lifecycle/types.js';

const HEAD = gitOid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const BASE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BASE_TIP = 'cccccccccccccccccccccccccccccccccccccccc';

describe('readExactCompareEvidence', () => {
  const COMPARE_FILE = {
    filename: 'src/a.ts',
    status: 'modified',
    patch: '@@ -1,1 +1,1 @@\n-old\n+new',
  };

  async function evidence(
    compare: unknown,
    options: {
      readonly proveReviewedDiff?: boolean;
      readonly changedFiles?: readonly string[];
      readonly changedFileCount?: number;
      readonly filesFail?: boolean;
    } = {},
  ) {
    const calls: string[] = [];
    const changedFiles = options.changedFiles ?? ['src/a.ts'];
    const result = await readExactCompareEvidence({
      run: async (_command, args) => {
        calls.push(args[1]!);
        if (args[1] === 'repos/Jinn-Network/mono/pulls/101') {
          return JSON.stringify({
            changed_files: options.changedFileCount ?? changedFiles.length,
            head: { sha: HEAD },
            base: { ref: 'next', sha: BASE },
          });
        }
        if (args[1]!.startsWith('repos/Jinn-Network/mono/pulls/101/files?')) {
          if (options.filesFail === true) throw new Error('HTTP 500');
          return JSON.stringify([changedFiles.map((filename) => ({ filename }))]);
        }
        return JSON.stringify(compare);
      },
      prNumber: 101,
      expectedHead: HEAD,
      expectedBaseRefName: 'next',
      repositorySlug: 'Jinn-Network/mono',
      ...(options.proveReviewedDiff === undefined
        ? {}
        : { proveReviewedDiff: options.proveReviewedDiff }),
    });
    return { result, calls };
  }

  it('emits no digest at all unless the changed-file proof was requested', async () => {
    const { result, calls } = await evidence({
      status: 'ahead',
      base_commit: { sha: BASE_TIP },
      files: [COMPARE_FILE],
    });
    // A cheaper, weaker digest is worse than none: the merge gate always proves
    // the changed-file set, so a view that carried on less would strand the PR.
    expect(result).toEqual({
      status: 'ahead',
      compareBaseTipOid: gitOid(BASE_TIP),
    });
    expect(calls).toEqual([
      'repos/Jinn-Network/mono/pulls/101',
      `repos/Jinn-Network/mono/compare/heads/next...${HEAD}`,
    ]);
  });

  it('derives status and a fully proven digest when the proof is requested', async () => {
    const { result, calls } = await evidence(
      { status: 'ahead', base_commit: { sha: BASE_TIP }, files: [COMPARE_FILE] },
      { proveReviewedDiff: true },
    );
    const expected = reviewedDiffDigestFromCompare([COMPARE_FILE], {
      baseOid: gitOid(BASE),
      baseRefName: gitRefName('next'),
      files: ['src/a.ts'],
      complete: true,
    });
    expect(expected.status).toBe('digest');
    expect(result).toEqual({
      status: 'ahead',
      compareBaseTipOid: gitOid(BASE_TIP),
      reviewedDiffDigest: expected.status === 'digest' ? expected.digest : undefined,
    });
    expect(calls).toContain(`repos/Jinn-Network/mono/pulls/101/files?per_page=100`);
  });

  it('omits compareBaseTipOid when the compare response has no base_commit.sha', async () => {
    const { result } = await evidence({ status: 'ahead', files: [COMPARE_FILE] });
    expect(result).toEqual({ status: 'ahead' });
    expect(result).not.toHaveProperty('compareBaseTipOid');
  });

  it.each([
    ['a compare with no files array', { status: 'ahead' }, {}],
    [
      'a file GitHub could not represent as a patch',
      { status: 'ahead', files: [{ filename: 'logo.png', status: 'modified' }] },
      { changedFiles: ['logo.png'] },
    ],
    [
      'a changed-file read that failed',
      { status: 'ahead', files: [COMPARE_FILE] },
      { filesFail: true },
    ],
    [
      'a changed-file list GitHub could not prove complete',
      { status: 'ahead', files: [COMPARE_FILE] },
      { changedFileCount: 4 },
    ],
    [
      'a compare file set that disagrees with the changed-file list',
      { status: 'ahead', files: [COMPARE_FILE] },
      { changedFiles: ['src/a.ts', 'src/b.ts'] },
    ],
  ])('keeps the status but omits the digest for %s', async (_name, compare, options) => {
    const { result } = await evidence(compare, { ...options, proveReviewedDiff: true });
    expect(result).toEqual({ status: 'ahead' });
    expect(result).not.toHaveProperty('reviewedDiffDigest');
  });

  /**
   * A concurrent worker pushing to the head between the listing and this reread
   * is routine, not a broken snapshot. The refusal is still total — no compare
   * is issued and no status is asserted — but it is expressed as the fail-closed
   * `unknown` this PR's own evidence, so it cannot abort the whole page.
   */
  it('reports an unreadable compare rather than throwing when head authority moved', async () => {
    const calls: string[] = [];
    await expect(readExactCompareEvidence({
      run: async (_command, args) => {
        calls.push(args[1]!);
        return JSON.stringify({
          head: { sha: 'f'.repeat(40) },
          base: { ref: 'next', sha: BASE },
        });
      },
      prNumber: 101,
      expectedHead: HEAD,
      expectedBaseRefName: 'next',
      repositorySlug: 'Jinn-Network/mono',
    })).resolves.toEqual({ status: 'unknown', unavailableReason: 'head-authority-moved' });

    // The stale authority is refused before the compare is built, so the racing
    // PR costs exactly one request instead of two.
    expect(calls).toEqual(['repos/Jinn-Network/mono/pulls/101']);
  });
});

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

  it('reports unknown when the fresh PR reread no longer has the expected head or base', async () => {
    const calls: string[] = [];
    await expect(readExactCompareStatus({
      run: async (_command, args) => {
        calls.push(args[1]!);
        return JSON.stringify({
          head: { sha: 'cccccccccccccccccccccccccccccccccccccccc' },
          base: { ref: 'next', sha: BASE },
        });
      },
      prNumber: 101,
      expectedHead: HEAD,
      expectedBaseRefName: 'next',
      repositorySlug: 'Jinn-Network/mono',
    })).resolves.toBe('unknown');

    expect(calls).toEqual(['repos/Jinn-Network/mono/pulls/101']);
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

  function gateCandidate(): EnqueueCandidate {
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
      changedFilesComplete: true,
      codeownersComplete: true,
      codeownerSensitive: false,
      codeOwnerLogins: new Set<string>(),
      graphqlId: 'PR_kwDOABCD2081',
      inMergeQueue: false,
    };
  }

  const OPERATOR_LOGINS = new Set(['review-bot']);

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

  it('reaches the ladder and reads that status as enqueue-ready', async () => {
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
    })).toEqual({ kind: 'enqueue-ready' });
  });

  /**
   * The compare status still has to be read correctly — the ladder routes on
   * it. What changed with #82 is who acts on it: the merge queue rebases onto
   * the base it merges into, so a diverged head is the queue's ordinary input
   * and the enqueue gate no longer refuses it.
   */
  it('does not block the enqueue gate on that status', async () => {
    const status = await readExactCompareStatus({
      run: monoRun([]),
      prNumber: 2081,
      expectedHead: PR_2081_HEAD,
      expectedBaseRefName: 'next',
      repositorySlug: 'Jinn-Network/mono',
    });
    expect(['behind', 'diverged', 'unknown']).toContain(status);

    // The enqueue gate's candidate no longer carries a compare status at
    // all -- the field was retired once the merge queue took over rebasing,
    // so nothing about this PR's stale-base shape can refuse it here.
    const gate = evaluateEnqueueGate(gateCandidate(), OPERATOR_LOGINS);

    expect(gate.reasons).not.toContain('behind');
    expect(gate).toEqual({ pass: true, reasons: [] });
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

/**
 * `gitRefName` is a safety filter, not a re-implementation of git.
 *
 * Since the snapshot reader started passing arbitrary PR base refs through it,
 * every over-rejection has repo-wide blast radius: one PR based on a branch the
 * validator dislikes throws and aborts the *entire* snapshot read, not just
 * that PR. So the validator must reject exactly what is unsafe and nothing
 * more.
 */
describe('gitRefName tracks git ref rules, not a stricter invention', () => {
  it.each([
    ['closing bracket', 'feat/x]y'],
    ['bracket pair remainder', 'release/v1]'],
    ['braces', 'feat/x{y}'],
    ['parentheses', 'feat/(x)'],
    ['semicolon', 'feat/x;y'],
    ['exclamation', 'feat/x!y'],
    ['plain nested path', 'stack/base/child'],
  ])('accepts a ref git itself accepts (%s)', (_name, ref) => {
    // Verified against `git check-ref-format refs/heads/<ref>`, which exits 0
    // for every entry here.
    expect(gitRefName(ref)).toBe(ref);
  });

  /**
   * `..` stays rejected because it is load-bearing for compare-URL safety: a
   * base branch named `x...y` would inject a second `...` separator into
   * `compare/heads/{base}...{head}` and silently change which comparison runs.
   */
  it.each([
    ['range separator', 'a..b'],
    ['triple-dot injection', 'x...y'],
    ['whitespace', 'a b'],
    ['tab', 'a\tb'],
    ['tilde', 'a~1'],
    ['caret', 'a^2'],
    ['colon', 'a:b'],
    ['question mark', 'a?b'],
    ['glob', 'a*b'],
    ['open bracket', 'a[b'],
    ['backslash', 'a\\b'],
    ['reflog syntax', 'a@{1}'],
    ['leading slash', '/a'],
    ['trailing slash', 'a/'],
    ['empty segment', 'a//b'],
    ['lock suffix', 'a.lock'],
    ['segment lock suffix', 'a.lock/b'],
    ['leading dot', '.a'],
    ['trailing dot', 'a.'],
    ['bare at', '@'],
    ['empty', ''],
  ])('still rejects an unsafe or invalid ref (%s)', (_name, ref) => {
    expect(() => gitRefName(ref)).toThrow(/Invalid Git ref name/i);
  });

  it('reads changed files for a PR whose base branch contains a bracket', async () => {
    const base = 'release/v1]rc';
    await expect(readExactChangedFiles({
      run: async () => JSON.stringify({
        changed_files: 1,
        head: { sha: HEAD },
        base: { ref: base, sha: BASE },
      }),
      prNumber: 101,
      expectedHead: HEAD,
      expectedBaseRefName: base,
      context: 'Merge',
      repositorySlug: 'Jinn-Network/mono',
      readFiles: async () => ['README.md'],
    })).resolves.toMatchObject({ baseRefName: base, complete: true });
  });

  it('compares a base branch containing a bracket instead of aborting the read', async () => {
    const base = 'release/v1]rc';
    const calls: string[] = [];
    const status = await readExactCompareStatus({
      run: async (_command, args) => {
        calls.push(args[1]!);
        if (args[1] === 'repos/Jinn-Network/mono/pulls/101') {
          return JSON.stringify({ head: { sha: HEAD }, base: { ref: base, sha: BASE } });
        }
        return JSON.stringify({ status: 'behind' });
      },
      prNumber: 101,
      expectedHead: HEAD,
      expectedBaseRefName: base,
      repositorySlug: 'Jinn-Network/mono',
    });

    expect(status).toBe('behind');
    expect(calls[1]).toBe(`repos/Jinn-Network/mono/compare/heads/${base}...${HEAD}`);
  });
});
