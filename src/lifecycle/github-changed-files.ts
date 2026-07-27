import type { CommandRunner } from '../dispatcher/issue-source.js';
import { REPO } from '../dispatcher/constants.js';
import {
  reviewedDiffDigestFromCompare,
  type ReviewedDiffDigestResult,
} from './reviewed-diff-digest.js';
import {
  decodeCompareStatus,
  gitOid,
  gitRefName,
  type CompareStatus,
  type GitOid,
  type GitRefName,
} from './types.js';

export const GITHUB_CHANGED_FILES_MAX = 3_000;

export type {
  ReviewedDiffDigestResult,
  ReviewedDiffDigestUnavailableReason,
} from './reviewed-diff-digest.js';

export type { CompareStatus } from './types.js';

export interface ExactChangedFiles {
  /**
   * The commit the PR forked from (`pulls/{n}.base.sha`). This is a *pinned*
   * historical point that never advances as the base branch advances. It is the
   * correct authority for reading blob content that the PR diff was computed
   * against (CODEOWNERS), and it is NOT a valid authority for "is this head
   * behind its base branch" — see `baseRefName`.
   */
  readonly baseOid: GitOid;
  /**
   * The base branch name (`pulls/{n}.base.ref`), verified equal to the caller's
   * expected base. Unlike `baseOid` this resolves to the branch *tip* at request
   * time, which is the only authority that can answer whether a head is behind.
   */
  readonly baseRefName: GitRefName;
  readonly files: readonly string[];
  readonly complete: boolean;
}

export interface ReadExactChangedFilesOptions {
  readonly run: CommandRunner;
  readonly prNumber: number;
  readonly expectedHead: GitOid;
  readonly expectedBaseRefName: string;
  readonly context: string;
  readonly repositorySlug?: string;
  readonly readFiles?: (prNumber: number) => Promise<readonly string[]>;
}

function filenames(raw: unknown, context: string): string[] {
  if (
    !Array.isArray(raw)
    || !raw.every((page) => Array.isArray(page))
  ) {
    throw new Error(`${context} changed-file read was incomplete`);
  }
  return (raw as Array<Array<{ filename?: unknown }>>).flat().map((file) => {
    if (typeof file.filename !== 'string') {
      throw new Error(`Malformed ${context.toLowerCase()} changed file`);
    }
    return file.filename;
  });
}

/**
 * Bind changed-file policy to the exact REST head/base snapshot. GitHub caps
 * this endpoint at 3,000 files, so pagination alone is never completeness
 * proof.
 */
export async function readExactChangedFiles(
  options: ReadExactChangedFilesOptions,
): Promise<ExactChangedFiles> {
  const repositorySlug = options.repositorySlug ?? REPO;
  const metadata = JSON.parse(await options.run('gh', [
    'api', `repos/${repositorySlug}/pulls/${options.prNumber}`,
  ])) as {
    changed_files?: unknown;
    head?: { sha?: unknown };
    base?: { ref?: unknown; sha?: unknown };
  };
  if (
    metadata.head?.sha !== options.expectedHead
    || metadata.base?.ref !== options.expectedBaseRefName
    || typeof metadata.base.ref !== 'string'
    || typeof metadata.base.sha !== 'string'
    || typeof metadata.changed_files !== 'number'
    || !Number.isSafeInteger(metadata.changed_files)
    || metadata.changed_files < 0
  ) {
    throw new Error(
      `${options.context} changed-file metadata lost exact PR authority`,
    );
  }
  const files = options.readFiles === undefined
    ? filenames(JSON.parse(await options.run('gh', [
      'api',
      `repos/${repositorySlug}/pulls/${options.prNumber}/files?per_page=100`,
      '--paginate',
      '--slurp',
    ])), options.context)
    : [...await options.readFiles(options.prNumber)];
  if (!files.every((file) => typeof file === 'string')) {
    throw new Error(`Malformed ${options.context.toLowerCase()} changed file`);
  }
  return {
    baseOid: gitOid(metadata.base.sha),
    baseRefName: gitRefName(metadata.base.ref),
    files,
    complete: metadata.changed_files <= GITHUB_CHANGED_FILES_MAX
      && files.length === metadata.changed_files
      && new Set(files).size === files.length,
  };
}

/**
 * Bind REST compare status to an exactly pinned head and a deliberately *live*
 * base branch tip.
 *
 * The head side is a snapshot: `expectedHead` must still be the PR head on a
 * fresh reread. The base side is intentionally not a snapshot.
 *
 * `pulls/{n}.base.sha` is the commit the PR forked from. It never advances as
 * the base branch advances, so `compare/{base.sha}...{head}` asks "is head ahead
 * of where it started?" — structurally `ahead` for every PR with commits, and
 * unable to return `behind`/`diverged` no matter how far the base has moved.
 * That made every behind-guard downstream of this value unreachable.
 *
 * `compare/heads/{base.ref}...{head}` lets GitHub resolve the branch to its tip
 * at request time, which is the only formulation that can observe staleness.
 * GitHub derives `status` from the real merge-base of the two supplied commits,
 * so the result is `ahead`/`identical` exactly when the live base tip is an
 * ancestor of head at read time: a false `ahead` is not constructible.
 *
 * Residual race, stated plainly: this compare runs in the merge candidate read
 * and the merge itself is pinned on the head only — GitHub offers no
 * expected-base-SHA on merge — so the base tip can advance in the seconds
 * between the two. That window is inherent to the API. It is a large reduction
 * from the previous window, which was the PR's entire lifetime.
 *
 * The `heads/` prefix is load-bearing. A bare `{name}` is resolved by git's
 * disambiguation order, in which `refs/tags/<name>` precedes `refs/heads/<name>`,
 * so a tag sharing the base branch's name would silently redirect the
 * comparison. `gitRefName` is likewise load-bearing: it rejects `..`, which is
 * what stops a base branch named `x...y` from injecting a second `...`
 * separator and changing which comparison is performed.
 */
export async function readExactCompareStatus(
  options: Omit<ReadExactChangedFilesOptions, 'context' | 'readFiles'>,
): Promise<CompareStatus> {
  return (await readExactCompareEvidence(options)).status;
}

export interface ExactCompareEvidence {
  readonly status: CompareStatus;
  /**
   * Identity of the diff this head presents against its base branch tip, or
   * `undefined` when it could not be proven. Derived from the very same
   * response `status` comes from, so it costs no additional request.
   *
   * `undefined` is not "no change": every consumer must fall back to requiring
   * exact head identity when it is absent.
   */
  readonly reviewedDiffDigest?: string;
}

/** See `readExactCompareStatus` for the full head/base authority analysis. */
export async function readExactCompareEvidence(
  options: Omit<ReadExactChangedFilesOptions, 'context' | 'readFiles'>,
): Promise<ExactCompareEvidence> {
  const repositorySlug = options.repositorySlug ?? REPO;
  const metadata = JSON.parse(await options.run('gh', [
    'api', `repos/${repositorySlug}/pulls/${options.prNumber}`,
  ])) as {
    head?: { sha?: unknown };
    base?: { ref?: unknown; sha?: unknown };
  };
  if (
    metadata.head?.sha !== options.expectedHead
    || metadata.base?.ref !== options.expectedBaseRefName
    // Runtime no-op given the comparison above (`expectedBaseRefName` is typed
    // `string`); its job is to narrow `unknown` so `gitRefName` compiles.
    || typeof metadata.base.ref !== 'string'
    || typeof metadata.base.sha !== 'string'
  ) {
    throw new Error('Compare metadata lost exact PR authority');
  }
  // Validated before the request is built, so an unsafe ref never reaches the
  // network at all.
  const compareBase = gitRefName(metadata.base.ref);
  const compare = JSON.parse(await options.run('gh', [
    'api',
    `repos/${repositorySlug}/compare/heads/${compareBase}...${options.expectedHead}`,
  ])) as { status?: unknown; files?: unknown };
  const digest = reviewedDiffDigestFromCompare(compare.files);
  return {
    status: decodeCompareStatus(compare.status),
    ...(digest.status === 'digest' ? { reviewedDiffDigest: digest.digest } : {}),
  };
}

export interface ReadReviewedDiffDigestOptions {
  readonly run: CommandRunner;
  readonly prNumber: number;
  readonly expectedHead: GitOid;
  readonly expectedBaseRefName: string;
  readonly context: string;
  readonly repositorySlug?: string;
}

/**
 * Read both completeness authorities and digest the PR's diff against its base
 * branch tip.
 *
 * Never throws: every failure is an `unavailable` result, because the only
 * correct response to a failure here is to leave the merge gate's head-identity
 * requirement in place. A thrown error would instead have to be caught by every
 * caller and mapped to the same thing, which is exactly how a fail-open slips
 * in.
 */
export async function readReviewedDiffDigest(
  options: ReadReviewedDiffDigestOptions,
): Promise<ReviewedDiffDigestResult> {
  const repositorySlug = options.repositorySlug ?? REPO;
  let changedFiles: ExactChangedFiles;
  try {
    changedFiles = await readExactChangedFiles({
      run: options.run,
      prNumber: options.prNumber,
      expectedHead: options.expectedHead,
      expectedBaseRefName: options.expectedBaseRefName,
      context: options.context,
      repositorySlug,
    });
  } catch {
    return { status: 'unavailable', reason: 'changed-files-unreadable' };
  }
  let compare: unknown;
  try {
    // `heads/` and `gitRefName` are load-bearing for the same reasons as in
    // `readExactCompareStatus`: a same-named tag must not hijack resolution and
    // a base name containing `..` must not inject a second separator.
    compare = JSON.parse(await options.run('gh', [
      'api',
      `repos/${repositorySlug}/compare/`
      + `heads/${gitRefName(changedFiles.baseRefName)}...${options.expectedHead}`,
    ]));
  } catch {
    return { status: 'unavailable', reason: 'compare-unreadable' };
  }
  if (typeof compare !== 'object' || compare === null || Array.isArray(compare)) {
    return { status: 'unavailable', reason: 'compare-malformed' };
  }
  return reviewedDiffDigestFromCompare(
    (compare as { files?: unknown }).files,
    changedFiles,
  );
}
