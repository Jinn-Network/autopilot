# Task 13 — Issue #33 report

## Result

Ordinary and cohort-reserved review reads retain their original bounded target
read. Even when the mapped issue has dependencies, they do not discover blocker
outcome relations, reserve extra blocker quota, or hydrate blocker PR details.
Exact blocker outcome discovery and hydration remains available only to stale
implementation recovery.

## Root cause

Issue #31 added exact OPEN/MERGED blocker discovery and detail hydration inside
the internal pull-request reader already shared by three callers:

- ordinary review reads;
- review reads whose quota was reserved once for a concurrent cohort; and
- stale implementation recovery.

The shared reader's existing boolean distinguished only whether the target PR
quota had already been reserved. A dependent review therefore continued into
the new recovery-only relation and blocker-detail loop. Reserved cohort reads
could perform those extra GraphQL probes after the atomic pre-batch decision,
including on post-claim confirmation reads.

## Change

- Added one internal stale-recovery pull-request entrypoint.
- Kept ordinary and reserved review entrypoints on the pre-#31 target-only
  composition path.
- Routed only `claim-implementation` actions with `intent: stale-recovery`
  through exact blocker outcome discovery and hydration.
- Preserved the original review target PR, native issue, Project item, and
  dependency-set refresh. The change removes only the recovery-specific
  blocker outcome relation and detail probes.
- Made no CLI, public configuration, schema, or lifecycle protocol change.

## TDD evidence

The first executable Node 22 RED run produced two non-skipped failures:

- a dependent ordinary review performed an additional quota read, blocker
  outcome relation read, quota read, and blocker PR detail read; and
- a dependent cohort-reserved review performed the same four post-reservation
  operations.

Both regressions assert the complete observable read ledger. They fail if
either review entrypoint is routed back through recovery blocker hydration.
They pass after the split, while the reserved case performs no per-review quota
probe.

The issue #31 matrix now calls the explicit stale-recovery entrypoint and
continues to cover cycle-present blocker races, merged outcomes omitted from
the cycle, live #2039/#1243/#1728, configured defaults, multiple blockers,
untrusted and ambiguous mappings, conflicting OPEN outcomes, exact reserves,
and zero-mutation rejection paths.

## Verification

Fresh Node 22.22.2 verification passed:

- focused targeted-reader, GitHub-reader, implementation executor/production,
  review executor/production, and cohort runtime tests — 170 passed, 3 skipped;
- `yarn typecheck`;
- `yarn test` — 135 files passed, 1,853 tests passed, 40 skipped;
- `yarn verify:source`;
- `yarn build`;
- `yarn verify:dist`; and
- `git diff --check`.

## Self-review

Review admission still rereads the exact target PR and mapped native issue,
refreshes its Project item and dependency set, and preserves the cycle's
remaining evidence. Review identity selection, expected-head validation,
claim publication, detached attempt creation, projection repair, bounded
confirmation retries, exact review-ref fencing, and worker spawn are unchanged.
The cohort still makes one aggregate reservation before concurrent handlers
start, and every initial or confirmation read uses the reserved review
entrypoint.

Stale recovery retains the complete issue #31 fail-closed contract. Its
dedicated entrypoint still reserves before relation discovery and every exact
blocker hydration, rejects unavailable or ambiguous blocker authority, and
hands the resulting snapshot to the existing independent target derivation and
pre-mutation guards.
