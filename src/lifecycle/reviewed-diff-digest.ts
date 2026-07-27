import { createHash } from 'node:crypto';
// Type-only on purpose: this module stays free of runtime imports from
// `github-changed-files`, which imports *it*. The network-side reader that
// needs both lives there, so the runtime dependency graph has no cycle.
import type { ExactChangedFiles } from './github-changed-files.js';

/**
 * Stable identity for *what a reviewer approved*: the ordered set of
 * `(path, status, previousPath, patch)` tuples of the PR's three-dot diff
 * against its base branch tip.
 *
 * A review approves a diff, not a commit SHA. `update-branch` merges the base
 * into the head to clear a `behind`/`diverged` state and therefore mints a new
 * head commit without changing anything the reviewer read. This digest is the
 * only evidence that lets the merge gate tell that case apart from a worker
 * pushing new code, and it is deliberately conservative in every direction it
 * cannot prove.
 *
 * Why `patch` and not `sha`:
 * `files[].sha` is the blob OID of the file *at the head side only*. It says
 * nothing about the other side of the diff, so two comparisons with identical
 * head blobs can still be different diffs — e.g. the base rewrote a file and
 * the merge kept the head's version, which changes the reviewed diff while
 * leaving every head-side blob untouched. `patch` is the only field in the
 * response that identifies both sides, so it is the only sound identity.
 * Consequently a response that omits `patch` for any entry — binary content,
 * or a diff GitHub declined to render because it was too large — yields no
 * digest at all rather than a digest that silently ignores that file.
 *
 * Why truncation is guarded twice:
 * `compare` caps its `files[]` array at 300 entries and gives no total from
 * which truncation could be detected, so any response at or above the cap is
 * refused outright — 300 exactly and 300-of-4000 are indistinguishable, and
 * digesting the visible prefix of a truncated list is precisely the "silently
 * ignores a file" failure this module must not have. Where an
 * `ExactChangedFiles` reading is already in hand (the merge gate has one, for
 * CODEOWNERS) it is additionally required to name the same set of paths:
 * `readExactChangedFiles` proves completeness against
 * `pulls/{n}.changed_files`, so equality of the two sets is a second,
 * independent completeness proof at no extra API cost.
 */
export type ReviewedDiffDigest = string;

export const REVIEWED_DIFF_DIGEST_PATTERN = /^v1:[0-9a-f]{64}$/;

export function isReviewedDiffDigest(value: unknown): value is ReviewedDiffDigest {
  return typeof value === 'string' && REVIEWED_DIFF_DIGEST_PATTERN.test(value);
}

/**
 * Every way the digest can fail to exist. All of them mean *unknown*, and
 * every consumer must map unknown onto "do not carry the approval" — never
 * onto "unchanged".
 */
export type ReviewedDiffDigestUnavailableReason =
  /** The changed-file authority read threw (API error, lost head/base pin). */
  | 'changed-files-unreadable'
  /** GitHub could not prove the changed-file list is complete. */
  | 'changed-files-incomplete'
  /** The compare read threw. */
  | 'compare-unreadable'
  /** The compare payload is absent or not shaped like `files[]`. */
  | 'compare-malformed'
  /** The same path appeared twice; ordering identity would be ambiguous. */
  | 'duplicate-file'
  /** At or above the documented 300-entry cap: truncation cannot be excluded. */
  | 'compare-files-truncated'
  /** compare and pulls/{n}/files disagree — the compare list may be truncated. */
  | 'file-set-mismatch'
  /** An entry carries no `patch`: binary, or a diff GitHub declined to render. */
  | 'unrepresented-patch';

/**
 * `GET /repos/{o}/{r}/compare/{base}...{head}` returns at most 300 entries in
 * `files[]` and reports no total, so a response holding exactly this many is
 * indistinguishable from a truncated one.
 */
export const COMPARE_FILES_CAP = 300;

export type ReviewedDiffDigestResult =
  | { readonly status: 'digest'; readonly digest: ReviewedDiffDigest }
  | {
      readonly status: 'unavailable';
      readonly reason: ReviewedDiffDigestUnavailableReason;
    };

interface DigestEntry {
  readonly path: string;
  readonly status: string;
  readonly previousPath: string | null;
  readonly patch: string;
}

function unavailable(
  reason: ReviewedDiffDigestUnavailableReason,
): ReviewedDiffDigestResult {
  return { status: 'unavailable', reason };
}

/**
 * Pure digest computation over an already-read `compare` payload and an
 * already-proven exact changed-file list. Kept pure so the merge gate can reuse
 * the compare response it must fetch anyway and spend no extra API call.
 */
export function reviewedDiffDigestFromCompare(
  compareFiles: unknown,
  changedFiles?: ExactChangedFiles,
): ReviewedDiffDigestResult {
  if (changedFiles !== undefined && !changedFiles.complete) {
    return unavailable('changed-files-incomplete');
  }
  if (!Array.isArray(compareFiles)) return unavailable('compare-malformed');
  if (compareFiles.length >= COMPARE_FILES_CAP) {
    return unavailable('compare-files-truncated');
  }
  const entries: DigestEntry[] = [];
  const seen = new Set<string>();
  for (const raw of compareFiles) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return unavailable('compare-malformed');
    }
    const file = raw as Record<string, unknown>;
    const path = file.filename;
    const status = file.status;
    const previousPath = file.previous_filename;
    if (
      typeof path !== 'string'
      || path.length === 0
      || typeof status !== 'string'
      || status.length === 0
      || (previousPath !== undefined && typeof previousPath !== 'string')
    ) {
      return unavailable('compare-malformed');
    }
    if (seen.has(path)) return unavailable('duplicate-file');
    seen.add(path);
    // Fail closed, never "no change". A missing patch is the one shape that
    // would let an unseen edit ride along under a matching digest.
    if (typeof file.patch !== 'string') return unavailable('unrepresented-patch');
    entries.push({
      path,
      status,
      previousPath: previousPath ?? null,
      patch: file.patch,
    });
  }
  if (changedFiles !== undefined) {
    const expected = new Set(changedFiles.files);
    if (
      expected.size !== changedFiles.files.length
      || expected.size !== seen.size
      || [...seen].some((path) => !expected.has(path))
    ) {
      return unavailable('file-set-mismatch');
    }
  }
  entries.sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
  const digest = createHash('sha256')
    .update(JSON.stringify({ v: 1, files: entries }), 'utf8')
    .digest('hex');
  return { status: 'digest', digest: `v1:${digest}` };
}
