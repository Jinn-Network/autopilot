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
- `yarn test` — 135 files passed, 1,816 tests passed, 40 skipped
- `yarn verify:source`
- `yarn build`
- `yarn verify:dist`
- `git diff --check`

## Self-review

Reviewed the final diff for retry scope and fail-closed behavior. The retry
only tolerates a temporarily absent Project item; all other existing safety
checks remain on every fresh read, and no CLI or configuration schema changed.
