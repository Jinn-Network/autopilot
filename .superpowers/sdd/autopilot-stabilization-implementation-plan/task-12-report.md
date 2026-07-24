# Task 12 — Issue #31 report

## Result

Stale implementation recovery now exact-discovers and exact-hydrates every
current blocker PR outcome before deriving target authority. A merged blocker
omitted from the cycle cache authorizes the configured default branch, while
missing, closed-unmerged, untrusted, or ambiguously mapped evidence withholds
authority before reality check or mutation.

## Root cause

The production stale-recovery entrypoint uses
`targeted.readPullRequest(cycleSnapshot, implementationPrNumber)`. It reread
the dependent issue's blocker edges and the implementation PR, but composed
the result with blocker PRs retained from the older cycle snapshot.
`resolveStackReady` therefore consumed mixed-time evidence.

The live #2039 diagnosis exposed a second form of the same defect. Its fresh
blocker edge references closed/Done issue #1243 and merged PR #1728, but the
full cache omitted that merged outcome and existing scoped relation discovery
returned OPEN PRs only. Refreshing only blocker PRs already present in the
cycle could not recover that authoritative merged evidence.

## Change

- Added a narrow internal closing-relation read that returns OPEN and MERGED
  PR outcome numbers while preserving the existing OPEN-only method.
- Wired stale targeted reads to discover blocker outcomes for the freshly
  reread blocker edges, with a quota reserve before relation discovery and
  before every exact PR hydration.
- Exact-hydrated every discovered or cycle-referenced blocker PR by number.
  Closed-unmerged/disappeared PRs are removed from the composed evidence;
  mismatched or multi-issue blocker mappings fail closed.
- Kept target derivation in the existing stack resolver. All-merged blockers
  now use the configured default branch rather than a hard-coded `next`;
  still-open trusted blockers retain their exact live head branch.
- Made no CLI, public configuration, or schema change.

## TDD evidence

The first Node 22 RED run produced six non-skipped failures. The
closed-unmerged production-wiring case reached reality check, claim commit,
claim publication, PR/Project/attempt creation, and worker dispatch, returning
`spawned` after its blocker had closed.

Additional RED regressions proved:

- merged-after-snapshot retained the stale stacked target;
- a still-open blocker retained its stale rather than exact live branch;
- untrusted and ambiguously mapped live blocker evidence retained authority;
- the live #2039/#1243/#1728 cache-omission shape never discovered PR #1728;
- outcome discovery had no merged-capable reader; and
- all-merged recovery returned hard-coded `next` instead of the configured
  default branch.

The GREEN matrix covers close-unmerged, missing, untrusted, ambiguous,
still-open trusted, merged-after-snapshot, multiple blocker hydration, exact
quota reserves, zero reality/mutation events, and #2039 resolving through
merged PR #1728 to a configured non-`next` default.

## Verification

Fresh Node 22.23.1 verification passed:

- focused targeted-reader, GitHub-reader, implementation executor/production
  port, and stack-readiness tests — 149 passed, 1 skipped;
- `yarn typecheck`;
- `yarn test` — 135 files passed, 1,848 tests passed, 40 skipped;
- `yarn verify:source`;
- `yarn build`;
- `yarn verify:dist`; and
- `git diff --check`.

## Self-review

The mutation boundary is unchanged: stale recovery still requires the exact
issue, Project In Progress state, non-Human authority, implementation PR
number/head/branch/base, open draft state, bounded mapping, and unfinished
claim identity/attempt before the first mutation. Fresh implementation and
review paths retain their existing gates. The new reader surface is internal
and optional at the snapshot interface, but production stale-recovery wiring
provides it and fails closed when blocker discovery is unavailable.
