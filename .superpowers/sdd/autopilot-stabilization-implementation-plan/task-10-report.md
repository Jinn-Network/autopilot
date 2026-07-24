# Task 10 — Issue #27 report

## Result

Implemented bounded, fail-closed Project membership readback retries for
machine-child repair after `gh project item-add` returns its exact item ID.

## Root cause

GitHub Project item visibility is eventually consistent. The repair path
treated a single immediate authoritative read that did not yet contain the
new item as permanently ambiguous, although `item-add` had already succeeded.

## Change

- Added an injectable wait dependency to `ProductionChildIssuePortOptions`.
- After `item-add`, perform at most five authoritative state reads, waiting
  250 ms only between absent-item reads.
- Every retry calls the existing `refresh` path, retaining validation of the
  open issue, authoritative child marker, durable triage intent,
  contradictions, and unique Project item.
- Continue only when the unique item ID equals the exact `item-add` result;
  a differing ID, duplicate, authority/intent change, or non-convergence
  still fails closed before any Project-field edit.

## Test evidence

The new non-skipped regression test first failed against the original code
with `Machine-child repair Project membership readback is ambiguous`. It
simulates an item that is absent on the immediate read and appears after the
injected wait; the repair now completes with one item-add and the three
expected field mutations.

Fresh Node 22 verification passed:

- `yarn typecheck`
- `yarn test` — 135 files passed, 1,822 tests passed, 40 skipped
- `yarn verify:source`
- `yarn build`
- `yarn verify:dist`
- `git diff --check`

## Review follow-up

Added explicit safety-property regressions without changing production code:

- non-convergence performs exactly five post-add reads, four 250 ms waits,
  and no field edits;
- a first visible item with a different ID fails immediately without waiting
  or editing;
- duplicate matching membership fails before an edit;
- marker and durable-intent drift on an absent-item retry each fail on the
  next authoritative reread before an edit; and
- a partial repair resumes without another item-add, then a later complete
  cycle is an `already-complete` no-op.

## Self-review

Reviewed the final diff for retry scope and fail-closed behavior. The retry
only tolerates a temporarily absent Project item; all other existing safety
checks remain on every fresh read, and no CLI or configuration schema changed.
