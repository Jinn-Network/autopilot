# Task 11 — Issue #28 report

## Result

Pinned stale implementation recovery now tolerates a historical claim base that
differs from the current base when the exact open draft PR and issue have been
legitimately retargeted together.

## Root cause

Execution rechecked the immutable historical claim's original target base
against the live issue target base. That equality is invalid after a stacked
base lands and the issue and draft PR are jointly retargeted, even though the
action still pins the exact issue, PR, head, branch, and unfinished claim
attempt.

Review then exposed that the production port derived the live issue target from
the same implementation PR before falling back to stack/default evidence. That
made the retained PR-to-issue comparison tautological and allowed a PR-only
retarget to supply both sides of its own authority check.

## Change

- Removed only the historical-claim-to-live-issue target-base equality gate.
- Production now derives the current target independently from current blocker
  PR evidence or the configured default branch, never from the implementation
  PR being recovered.
- Retained the live PR-to-issue target-base check and every pinned recovery
  authority check.
- A successful recovery creates the replacement claim against the current live
  base and dispatches the existing PR worktree.
- Fresh implementation admission and ordinary target-base gates are unchanged.

## Test evidence

The new non-skipped regression first failed under Node 22 because the executor
returned `ineligible` before claim publication for a historical stacked base
and a jointly retargeted live issue/PR. It passes after the correction and
asserts the new CAS claim uses the current base and the existing branch/head.

The non-skipped production-port review regression first failed under Node 22
because an `attacker/retarget` PR base was also returned as the issue target
instead of the independently expected `next`. It now preserves the three
distinct values: historical stacked claim base, independently derived current
target, and live PR base. Additional coverage confirms current active stacking
derives authority from the blocker PR even when the implementation PR is
retargeted elsewhere.

The focused safety matrix covers missing or changed issue, PR, head, branch,
live target base, bounded PR mapping, claim phase/identity/attempt/completion,
draft/open state, In Progress status, and Human authority. Every rejection
asserts that no claim commit or later recovery mutation occurs. A separate
fresh-work regression retains the ordinary mismatched-base Human gate.

Fresh Node 22 verification passed:

- focused executor, production-port, and stack-readiness tests — 64 passed,
  1 skipped;
- `yarn typecheck`;
- `yarn test` — 135 files passed, 1,836 tests passed, 40 skipped;
- `yarn verify:source`;
- `yarn build`;
- `yarn verify:dist`; and
- `git diff --check`.

## Self-review

The production changes are limited to stale-recovery validation and the
production port's target derivation. Exact live head, branch, issue, PR, claim
attempt, open draft state, In Progress status, non-Human authority, and live
PR agreement with independently derived stack/default authority all remain
mandatory before the first mutation. Fresh admission still uses the same
independent target-base and stacking gates. The issue #27 stack below this
branch is untouched.
