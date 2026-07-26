# Task 3 report — stacked mapping, machine-Human recovery, and pinned base

## Root cause

The runtime had three independent authority gaps:

1. Snapshot mapping inferred an empty-closing PR from a stable-looking branch
   name alone, while the review session rejected every empty closing set.
   Review enrollment, candidate confirmation, reconciliation diagnostics, and
   merge scheduling therefore did not share one structured result.
2. A mapping diagnostic could publish a structured Human comment, Human
   review-ref state, and `review:needs-human` label, but there was no narrow
   recovery after better evidence made that mapping unique.
3. Merge scheduling carried only PR/head. The production port was normally
   configured with the repository default branch, so a legitimate stacked PR
   could not carry its parent branch authority. The archived canary instead
   assigned `expectedBaseRefName` from the live PR itself, which would have
   made a retarget agree with its own unauthorized value.

The preserved canary commit `218ff2c` was inspected as evidence only and was
not cherry-picked.

## RED evidence

Strict focused REDs were captured before each implementation slice:

- Canonical resolver: 7 tests failed after an API scaffold returned no
  resolutions. The failures covered #2084, missing marker, changed stable
  head, missing dependency, duplicate open PR, configured default, and
  live-base self-authorization.
- Snapshot integration: 2 tests failed because there was no canonical mapping
  output and missing dependency evidence still produced a lifecycle PR.
- Review acquisition/confirmation: 1 test failed because canonical ambiguity
  was ignored in favor of the old lifecycle/marker fallback.
- Review session: 1 test failed because the exact unique manifest-pinned
  stacked PR still received a mapping problem for an empty closing set.
- Exact custom parent branch: 1 resolver test failed because dependency
  authorization only understood `autopilot/<issue>` branch names.
- The first full suite exposed 2 targeted stale-recovery regressions. One
  fixture omitted its configured `main` default, and one used a uniquely
  evidenced noncanonical parent branch. Both were traced to the same overly
  narrow base resolver and fixed in that resolver.

## GREEN implementation

### Canonical mapping

- Added `resolveStructuredPullRequestMappings`, a structured resolver which
  returns either a unique issue plus separately authorized base or an
  ambiguous result with evidence details.
- Empty closing references require one exact lifecycle marker, an exact
  implement stable-branch claim at the PR head/branch/base, issue dependency
  evidence, and one unique open PR.
- Normal mappings authorize only the configured default branch, a dependency
  named and pinned by the exact stable claim, or the exact unique live parent
  PR branch. A live base never authorizes itself.
- Snapshot lifecycle construction, mapping diagnostics, targeted snapshots,
  review enrollment, review acquisition, confirmation, and live
  reconciliation validation consume the canonical result.
- Configured default-branch authority is threaded through full, incremental,
  parity, scoped, and targeted snapshot composition.

### Obsolete machine-Human recovery

- Structured Human evidence now retains the comment author through GraphQL,
  REST change detection, snapshot decoding, and the strict lifecycle cache.
- A uniquely mapped item is repairable only when its structured reason is
  `branch-mapping-ambiguous`, its issue/head match, its review claim is
  `human` or the matching retryable `stale` generation, the comment author is
  a configured machine login, and no issue/Project Human authority exists.
- Projection emits one `repair-obsolete-mapping-human` action pinned to
  PR/head/review-ref/generation/author/marker.
- Production maintenance rereads canonical mapping, head, base, dependencies,
  Project/native Human surfaces, review-ref payload, selected identity, and
  the exact authored comment. It marks a Human review claim stale under CAS,
  removes `review:needs-human`, and deletes only the exact matching machine
  comment. Ordering leaves the comment available for a safe retry if a later
  overlay step fails.
- Maintainer/foreign authors, unstructured comments, different reason codes,
  different heads, changed generations, and issue-level Human holds remain
  dominant.

### Pinned stacked merge base

- Lifecycle PRs retain the base authorized by the resolver.
- Merge candidates and actions carry that expected base through the scheduler
  and production runtime.
- Both candidate reads bind changed-file/CODEOWNERS evidence to the pinned
  base, and the executor rejects base disagreement independently of the live
  candidate value.
- `mergeExactHead` performs a final credentialed PR reread immediately before
  the merge PUT and requires open state, exact head, and exact expected base.
  Retargeting therefore blocks the mutation even after the ordinary second
  gate read.

## #2084 regression shape

Coverage proves that an empty-closing #2084 PR with the exact marker, stable
claim, dependency on #2083, and base `autopilot/2083`:

- resolves to one lifecycle item;
- enrolls exactly one fresh review;
- can repair one exact obsolete machine mapping Human overlay;
- can become merge-ready after exact-head approval; and
- schedules merge only with `autopilot/2083` as the pinned base.

Missing dependency evidence produces a structured diagnostic instead.

## Verification

Focused stabilization command:

```sh
PATH=/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH yarn vitest run test/lifecycle/pr-mapping.test.ts test/lifecycle/snapshot.test.ts test/lifecycle/review-executor-production.test.ts test/lifecycle/review-session-production.test.ts test/lifecycle/projection.test.ts test/lifecycle/reconciler.test.ts test/lifecycle/reconciliation-writer-production.test.ts test/lifecycle/merge-executor.test.ts test/lifecycle/merge-executor-production.test.ts test/lifecycle/active-scheduler.test.ts test/lifecycle/controller.test.ts test/lifecycle/active-runtime-production.test.ts test/lifecycle/merge-policy.test.ts
```

Observed: **13 files passed; 220 tests passed, 23 skipped (243 total)**.

Final repository verification:

- `yarn typecheck`: passed without diagnostics.
- `yarn test`: **140 files passed; 1,937 tests passed, 40 skipped (1,977
  total)**.
- `git diff --check`: passed.

## Self-review

- No archive commit was cherry-picked.
- Empty-closing evidence is stricter than normal closing-reference adoption.
- Custom dependency branches require one exact unique open parent PR; a
  similarly named or duplicate PR does not authorize the base.
- Repair authority is append/CAS bound before the destructive overlay cleanup,
  and protected Human sources fail closed.
- Merge authority is carried separately from live PR state and reread at the
  last mutation boundary.
- No unrelated worktree changes were modified.

## Commit

This report is included in the task commit whose message contains `Closes #40`.
