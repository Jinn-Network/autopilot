import { describe, expect, it } from 'vitest';
import {
  COMPARE_FILES_CAP,
  isReviewedDiffDigest,
  reviewedDiffDigestFromCompare,
} from '../../src/lifecycle/reviewed-diff-digest.js';
import { readReviewedDiffDigest } from '../../src/lifecycle/github-changed-files.js';
import type { ExactChangedFiles } from '../../src/lifecycle/github-changed-files.js';
import { gitOid, gitRefName } from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));
const BASE = gitOid('3'.repeat(40));

function compareFile(overrides: Record<string, unknown> = {}) {
  return {
    filename: 'src/a.ts',
    status: 'modified',
    sha: 'a'.repeat(40),
    additions: 1,
    deletions: 1,
    patch: '@@ -1,1 +1,1 @@\n-old\n+new',
    ...overrides,
  };
}

function changedFiles(
  files: readonly string[],
  complete = true,
): ExactChangedFiles {
  return {
    baseOid: BASE,
    baseRefName: gitRefName('stack/base'),
    files,
    complete,
  };
}

function digestOf(files: readonly unknown[], names?: readonly string[]): string {
  const result = reviewedDiffDigestFromCompare(
    files,
    changedFiles(names ?? files.map((file) => (file as { filename: string }).filename)),
  );
  if (result.status !== 'digest') {
    throw new Error(`expected a digest, got ${result.reason}`);
  }
  return result.digest;
}

describe('reviewed diff digest', () => {
  it('is a stable v1 sha256 over the ordered (path, status, previousPath, patch) tuples', () => {
    const digest = digestOf([compareFile()]);
    expect(isReviewedDiffDigest(digest)).toBe(true);
    expect(digest).toMatch(/^v1:[0-9a-f]{64}$/);
    // Recomputing the same comparison yields the same identity.
    expect(digestOf([compareFile()])).toBe(digest);
  });

  it('is independent of the order GitHub happens to list files in', () => {
    const a = compareFile({ filename: 'src/a.ts' });
    const b = compareFile({ filename: 'src/b.ts', patch: '@@ -2,1 +2,1 @@\n-x\n+y' });
    expect(digestOf([a, b])).toBe(digestOf([b, a]));
  });

  it('changes when the patch text changes, which is the whole point', () => {
    const before = digestOf([compareFile()]);
    const after = digestOf([compareFile({ patch: '@@ -1,1 +1,1 @@\n-old\n+other' })]);
    expect(after).not.toBe(before);
  });

  it('changes when only the hunk header moves, so a shifted base cannot pass as identical', () => {
    const before = digestOf([compareFile({ patch: '@@ -1,1 +1,1 @@\n-old\n+new' })]);
    const after = digestOf([compareFile({ patch: '@@ -9,1 +9,1 @@\n-old\n+new' })]);
    expect(after).not.toBe(before);
  });

  // Known behaviour, pinned deliberately. This is the residual risk, stated as a
  // test so nobody can claim the digest is stricter than it is.
  //
  // GitHub renders `patch` with three lines of context. A base commit that
  // rewrites line 5 of this same file — in place, so no offsets move — is more
  // than three lines from the PR's hunk at line 40, so it appears nowhere in
  // either comparison. Both comparisons emit the identical patch, the digest
  // matches, and the approval carries even though the merged file now differs
  // from the file the reviewer read.
  it('does NOT notice a base change outside the patch context window', () => {
    const hunk = [
      '@@ -40,7 +40,7 @@ export function callsIntoTheBase() {',
      '   const a = 1;',
      '   const b = 2;',
      '   const c = 3;',
      '-  return helper(a, b, c);',
      '+  return helper(a, b, c) + 1;',
      '   const d = 4;',
      '   const e = 5;',
    ].join('\n');
    const beforeBaseEdit = digestOf([compareFile({ patch: hunk })]);
    // Same PR hunk, same offsets, same context. The base's edit to line 5 of
    // this file is simply not in the diff.
    const afterBaseEdit = digestOf([compareFile({ patch: hunk })]);
    expect(afterBaseEdit).toBe(beforeBaseEdit);
  });

  it('does notice a base change that shifts the hunk offsets', () => {
    const before = digestOf([compareFile({
      patch: '@@ -40,3 +40,3 @@\n   const a = 1;\n-  old\n+  new',
    })]);
    // The base inserted a line above the hunk, so GitHub renumbers it.
    const after = digestOf([compareFile({
      patch: '@@ -41,3 +41,3 @@\n   const a = 1;\n-  old\n+  new',
    })]);
    expect(after).not.toBe(before);
  });

  // Mutant guard: ordering the digest entries by `patch` instead of `path` is
  // not a total order — two files can carry the same patch text — so a stable
  // sort would leave those two in whatever order GitHub listed them and make
  // the digest depend on that order.
  it('is order-independent even when two files carry the same patch text', () => {
    const shared = '@@ -1,1 +1,1 @@\n-x\n+y';
    const a = compareFile({ filename: 'src/a.ts', patch: shared });
    const b = compareFile({ filename: 'src/b.ts', patch: shared });
    expect(digestOf([a, b])).toBe(digestOf([b, a]));
  });

  it('changes when the path, the status, or the rename source changes', () => {
    const base = digestOf([compareFile()]);
    expect(digestOf([compareFile({ filename: 'src/b.ts' })])).not.toBe(base);
    expect(digestOf([compareFile({ status: 'added' })])).not.toBe(base);
    expect(
      digestOf([compareFile({ status: 'renamed', previous_filename: 'src/old.ts' })]),
    ).not.toBe(base);
  });

  it('refuses an entry with no patch instead of treating it as no change', () => {
    // Binary content and diffs GitHub declines to render both arrive shaped
    // exactly like this: a real changed file with everything except `patch`.
    const binary = compareFile({ filename: 'assets/logo.png', patch: undefined });
    delete (binary as Record<string, unknown>).patch;
    expect(reviewedDiffDigestFromCompare([binary], changedFiles(['assets/logo.png'])))
      .toEqual({ status: 'unavailable', reason: 'unrepresented-patch' });
  });

  it('refuses a file list at or above the compare cap, where truncation is invisible', () => {
    const files = Array.from({ length: COMPARE_FILES_CAP }, (_unused, index) =>
      compareFile({ filename: `src/f${index}.ts` }));
    expect(reviewedDiffDigestFromCompare(files, changedFiles(
      files.map((file) => file.filename),
    ))).toEqual({ status: 'unavailable', reason: 'compare-files-truncated' });
    expect(reviewedDiffDigestFromCompare(files.slice(0, COMPARE_FILES_CAP - 1)).status)
      .toBe('digest');
  });

  it('refuses when compare and the proven changed-file list disagree', () => {
    expect(reviewedDiffDigestFromCompare([compareFile()], changedFiles([
      'src/a.ts',
      'src/unseen.ts',
    ]))).toEqual({ status: 'unavailable', reason: 'file-set-mismatch' });
  });

  it('refuses when the changed-file list was never proven complete', () => {
    expect(reviewedDiffDigestFromCompare(
      [compareFile()],
      changedFiles(['src/a.ts'], false),
    )).toEqual({ status: 'unavailable', reason: 'changed-files-incomplete' });
  });

  it('refuses a duplicated path, whose ordered identity would be ambiguous', () => {
    expect(reviewedDiffDigestFromCompare(
      [compareFile(), compareFile()],
      changedFiles(['src/a.ts']),
    )).toEqual({ status: 'unavailable', reason: 'duplicate-file' });
  });

  it.each([
    ['no files array at all', undefined],
    ['a non-array files value', { filename: 'src/a.ts' }],
    ['a non-object entry', ['src/a.ts']],
    ['an entry with no filename', [{ status: 'modified', patch: '@@' }]],
    ['an entry with no status', [{ filename: 'src/a.ts', patch: '@@' }]],
    ['a non-string previous_filename', [compareFile({ previous_filename: 7 })]],
  ])('refuses %s', (_name, files) => {
    expect(reviewedDiffDigestFromCompare(files, changedFiles(['src/a.ts'])))
      .toEqual({ status: 'unavailable', reason: 'compare-malformed' });
  });
});

describe('reading a reviewed diff digest', () => {
  const metadata = JSON.stringify({
    changed_files: 1,
    head: { sha: HEAD },
    base: { ref: 'stack/base', sha: BASE },
  });

  it('digests the PR diff against the base branch tip, never the pinned fork point', async () => {
    const endpoints: string[] = [];
    const result = await readReviewedDiffDigest({
      run: async (_command, args) => {
        const endpoint = args.find((arg) => arg.startsWith('repos/'))!;
        endpoints.push(endpoint);
        if (endpoint === 'repos/Jinn-Network/mono/pulls/84') return metadata;
        if (endpoint.startsWith('repos/Jinn-Network/mono/pulls/84/files?')) {
          return JSON.stringify([[{ filename: 'src/a.ts' }]]);
        }
        return JSON.stringify({ status: 'ahead', files: [compareFile()] });
      },
      prNumber: 84,
      expectedHead: HEAD,
      expectedBaseRefName: 'stack/base',
      context: 'Review',
    });
    expect(result).toEqual({ status: 'digest', digest: digestOf([compareFile()]) });
    expect(endpoints).toContain(`repos/Jinn-Network/mono/compare/heads/stack/base...${HEAD}`);
    // The pinned fork point can only ever answer "ahead" and would digest the
    // wrong comparison.
    expect(endpoints.some((endpoint) => endpoint.includes(BASE))).toBe(false);
  });

  it.each([
    ['the changed-file authority is unreadable', 'pulls/84', 'changed-files-unreadable'],
    ['the compare read fails', 'compare/', 'compare-unreadable'],
  ])('reports %s as unavailable rather than throwing', async (_name, failing, reason) => {
    const result = await readReviewedDiffDigest({
      run: async (_command, args) => {
        const endpoint = args.find((arg) => arg.startsWith('repos/'))!;
        if (endpoint.includes(failing) && !endpoint.includes('/files?')) {
          throw new Error('HTTP 500');
        }
        if (endpoint === 'repos/Jinn-Network/mono/pulls/84') return metadata;
        if (endpoint.startsWith('repos/Jinn-Network/mono/pulls/84/files?')) {
          return JSON.stringify([[{ filename: 'src/a.ts' }]]);
        }
        return JSON.stringify({ status: 'ahead', files: [compareFile()] });
      },
      prNumber: 84,
      expectedHead: HEAD,
      expectedBaseRefName: 'stack/base',
      context: 'Review',
    });
    expect(result).toEqual({ status: 'unavailable', reason });
  });

  it('reports a non-object compare body as unavailable', async () => {
    const result = await readReviewedDiffDigest({
      run: async (_command, args) => {
        const endpoint = args.find((arg) => arg.startsWith('repos/'))!;
        if (endpoint === 'repos/Jinn-Network/mono/pulls/84') return metadata;
        if (endpoint.startsWith('repos/Jinn-Network/mono/pulls/84/files?')) {
          return JSON.stringify([[{ filename: 'src/a.ts' }]]);
        }
        return JSON.stringify('not-an-object');
      },
      prNumber: 84,
      expectedHead: HEAD,
      expectedBaseRefName: 'stack/base',
      context: 'Review',
    });
    expect(result).toEqual({ status: 'unavailable', reason: 'compare-malformed' });
  });
});
