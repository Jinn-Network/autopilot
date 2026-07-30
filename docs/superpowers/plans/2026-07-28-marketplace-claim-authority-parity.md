# Marketplace Claim Authority Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Share exact branch-claim pull-request/OID authority so production-order fresh marketplace claims reach Solution adoption without weakening stale-claim fences.

**Architecture:** A pure lifecycle helper owns only the initial-versus-terminal pull-request/OID transition. Implementation-session and marketplace adoption consume it while retaining their existing phase, identity, ancestry, mapping, process, head, Human, and receipt checks.

**Tech Stack:** TypeScript, Node.js 22, Vitest, Git branch-claim trailers, existing Autopilot v2 attempt manifests and marketplace adoption state machine.

## Global Constraints

- Task `1199`, Task `1197`, PRs `2271`/`2267`, their receipts, and the local Jinn database are immutable.
- Do not run Autopilot active/recover mode or submit a live Task during implementation.
- Do not start a fresh canary until the implementation is independently reviewed, pushed to PR `#68`, and exact-head CI is green.
- Preserve branch-claim, marketplace request/result/receipt, and SDK schemas.
- An omitted PR is valid only for a non-terminal `implement` claim while `latestClaimOid === originClaimOid`.
- An explicit wrong PR always rejects.
- A phase-complete claim must carry the exact PR and satisfy `latestClaimOid === remoteHead`.
- Preserve all caller-specific phase, issue, attempt, runner, login, base, ancestry, mapping, process, head, Human, CODEOWNER, child, receipt-author, and correlation checks.
- Every changed production behavior starts with a test that is run and observed failing for the intended reason.
- Use Node.js `>=22 <23`.

---

### Task 1: Pure Branch-Claim PR/OID Authority Policy

**Files:**
- Create: `src/lifecycle/implementation-claim-authority.ts`
- Create: `test/lifecycle/implementation-claim-authority.test.ts`

**Interfaces:**
- Consumes: `BranchClaim` and `GitOid` from `src/lifecycle/types.ts`.
- Produces:

```ts
export interface BranchClaimPrAuthorityInput {
  readonly claim: BranchClaim;
  readonly expectedPrNumber: number;
  readonly originClaimOid: GitOid;
  readonly latestClaimOid: GitOid;
  readonly remoteHead: GitOid;
}

export function branchClaimPrAuthorityMatches(
  input: BranchClaimPrAuthorityInput,
): boolean;
```

- [ ] **Step 1: Write the initial-claim and explicit-PR tests**

Create a strict claim fixture and these literal cases:

```ts
it('accepts a production-order initial implement claim before the PR exists', () => {
  const initial = implementClaim();
  delete (initial as { prNumber?: number }).prNumber;

  expect(branchClaimPrAuthorityMatches({
    claim: initial,
    expectedPrNumber: 2271,
    originClaimOid: CLAIM,
    latestClaimOid: CLAIM,
    remoteHead: CLAIM,
  })).toBe(true);
});

it('rejects an explicit wrong PR at the exact origin claim', () => {
  expect(branchClaimPrAuthorityMatches({
    claim: implementClaim({ prNumber: 2272 }),
    expectedPrNumber: 2271,
    originClaimOid: CLAIM,
    latestClaimOid: CLAIM,
    remoteHead: CLAIM,
  })).toBe(false);
});
```

Use object construction without `delete` in the final test if TypeScript's
readonly type rejects deletion:

```ts
const { prNumber: _prNumber, ...initial } = implementClaim();
```

- [ ] **Step 2: Add the complete transition truth table**

Add independent tests for:

| Case | Expected |
| --- | --- |
| non-terminal implement, omitted PR, latest equals origin | `true` |
| non-terminal implement, omitted PR, latest differs from origin | `false` |
| non-terminal implement, exact PR, latest equals origin | `true` |
| non-terminal implement, exact PR, latest differs from origin | `false` |
| non-terminal implement, wrong PR | `false` |
| non-terminal fix/reconcile, exact PR, latest equals origin | `true` |
| non-terminal fix/reconcile, wrong PR | `false` |
| phase-complete implement, omitted PR | `false` |
| phase-complete implement, exact PR, latest equals remote | `true` |
| phase-complete implement, exact PR, latest below remote | `false` |
| phase-complete implement, wrong PR, latest equals remote | `false` |

- [ ] **Step 3: Run the helper suite and verify RED**

Run:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn test \
  test/lifecycle/implementation-claim-authority.test.ts
```

Expected: FAIL because
`src/lifecycle/implementation-claim-authority.ts` does not exist.

- [ ] **Step 4: Implement the minimal pure helper**

```ts
import type { BranchClaim, GitOid } from './types.js';

export interface BranchClaimPrAuthorityInput {
  readonly claim: BranchClaim;
  readonly expectedPrNumber: number;
  readonly originClaimOid: GitOid;
  readonly latestClaimOid: GitOid;
  readonly remoteHead: GitOid;
}

export function branchClaimPrAuthorityMatches(
  input: BranchClaimPrAuthorityInput,
): boolean {
  const {
    claim,
    expectedPrNumber,
    originClaimOid,
    latestClaimOid,
    remoteHead,
  } = input;
  if (claim.phaseComplete === true) {
    return claim.prNumber === expectedPrNumber
      && latestClaimOid === remoteHead;
  }
  if (latestClaimOid !== originClaimOid) return false;
  return claim.prNumber === undefined
    ? claim.phase === 'implement'
    : claim.prNumber === expectedPrNumber;
}
```

- [ ] **Step 5: Run the helper suite and verify GREEN**

Run:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn test \
  test/lifecycle/implementation-claim-authority.test.ts
```

Expected: all tests pass with zero failures.

- [ ] **Step 6: Commit the pure authority policy**

```bash
git add src/lifecycle/implementation-claim-authority.ts \
  test/lifecycle/implementation-claim-authority.test.ts
git diff --cached --check
git commit -m "fix: share implementation claim authority"
```

---

### Task 2: Production-Order Session Parity

**Files:**
- Modify: `src/lifecycle/implementation-session.ts`
- Modify: `test/lifecycle/implementation-session.test.ts`
- Modify: `test/lifecycle/implementation-executor.test.ts`
- Test: `test/lifecycle/implementation-claim-authority.test.ts`

**Interfaces:**
- Consumes: `branchClaimPrAuthorityMatches()` from Task 1.
- Produces: one session authority gate that uses the shared initial/terminal
  claim transition while retaining its existing identity and ancestry checks.

- [ ] **Step 1: Add direct session parity cases**

Extend the session harness so a test can omit `prNumber` without a type cast:

```ts
function initialClaimWithoutPr(): BranchClaim {
  const { prNumber: _prNumber, ...initial } = claim();
  return initial;
}
```

Add:

```ts
it('owns the exact initial implement claim created before its PR', async () => {
  const h = harness({
    latestClaim: initialClaimWithoutPr(),
    latestClaimOid: CLAIM,
    remoteHead: CLAIM,
    localHead: WORK,
  });

  await expect(h.protocol.checkpoint(h.manifest)).resolves.toEqual({
    status: 'published',
    head: WORK,
  });
});
```

Add a negative case with an explicit wrong PR and assert
`no longer owns the latest claim` before any `push:` event.

- [ ] **Step 2: Run the direct session cases as characterization**

Run:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn test \
  test/lifecycle/implementation-session.test.ts \
  -t "initial implement claim|explicit wrong PR"
```

Expected before the refactor: both cases already pass. This is intentional
characterization of the reference policy, not the behavior-changing RED gate.
Task 1's missing helper and Task 3's adoption regression provide RED.

- [ ] **Step 3: Restore the executor-to-session production-order test**

Unskip:

```text
carries a brand-new executor claim into an authoritative session checkpoint
```

Remove deleted `setProjectStatus` and `readProjectStatus` fixture members.
Keep the assertions that:

- `executeImplementationAction()` captures a fresh claim without
  `prNumber`;
- the later attempt manifest carries PR `84`;
- session authority sees `latestClaimOid === manifest.claimOid`; and
- checkpoint publishes the real tree change.

- [ ] **Step 4: Run the executor-to-session test**

Run:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn test \
  test/lifecycle/implementation-executor.test.ts \
  -t "carries a brand-new executor claim"
```

Expected: PASS after removing obsolete fixture members. The test records the
actual production ordering that the shared policy must preserve.

- [ ] **Step 5: Replace session's local PR/OID branch with the shared helper**

Import `branchClaimPrAuthorityMatches()` and replace:

```ts
(
  latest.prNumber === undefined
    ? authority.latestClaimOid !== manifest.claimOid
    : latest.prNumber !== manifest.prNumber
)
```

with the negated shared predicate:

```ts
!branchClaimPrAuthorityMatches({
  claim: latest,
  expectedPrNumber: manifest.prNumber!,
  originClaimOid: manifest.claimOid as GitOid,
  latestClaimOid: authority.latestClaimOid,
  remoteHead: authority.remoteHead,
})
```

Do not remove the original/latest ancestry checks.

- [ ] **Step 6: Run session, executor, and helper suites and verify GREEN**

Run:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn test \
  test/lifecycle/implementation-claim-authority.test.ts \
  test/lifecycle/implementation-session.test.ts \
  test/lifecycle/implementation-executor.test.ts
```

Expected: all tests pass with zero failures and the formerly skipped
production-order test runs.

- [ ] **Step 7: Commit session parity**

```bash
git add src/lifecycle/implementation-session.ts \
  test/lifecycle/implementation-session.test.ts \
  test/lifecycle/implementation-executor.test.ts
git diff --cached --check
git commit -m "test: preserve claim-before-pr session authority"
```

---

### Task 3: Marketplace Adoption Regression

**Files:**
- Modify: `src/lifecycle/marketplace-mutation-adoption.ts`
- Modify: `test/lifecycle/marketplace-mutation-adoption.test.ts`
- Test: `test/lifecycle/marketplace-solution-vertical.test.ts`

**Interfaces:**
- Consumes: `branchClaimPrAuthorityMatches()` from Task 1.
- Produces: marketplace adoption accepts the exact production-order initial
  implement claim and retains all stale-claim rejections.

- [ ] **Step 1: Write the live-shape adoption regression**

Add a helper:

```ts
function withoutPrNumber(claim: BranchClaim): BranchClaim {
  const { prNumber: _prNumber, ...initial } = claim;
  return initial;
}
```

Then add:

```ts
it('accepts a fresh implement claim published before the PR existed', async () => {
  const harness = new Harness();
  harness.currentClaim = withoutPrNumber(harness.currentClaim);

  await expect(adopt(harness)).resolves.toMatchObject({
    status: 'accepted',
  });
  expect(harness.applyMutations).toBe(1);
  expect(harness.comments).toHaveLength(1);
  expect(harness.comments[0]!.body).toContain('"disposition":"accepted"');
});
```

Keep the harness's existing authority identity unchanged:

```ts
currentClaimOid === CLAIM
currentManifest.claimOid === CLAIM
remoteHead === EXPECTED
prHead === EXPECTED
currentManifest.expectedHead === EXPECTED
```

The initial claim remains the latest claim in the branch ancestry while the
branch and PR may correctly contain later non-claim work commits.

- [ ] **Step 2: Run the regression and verify RED**

Run:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn test \
  test/lifecycle/marketplace-mutation-adoption.test.ts \
  -t "published before the PR existed"
```

Expected: FAIL because adoption returns `rejected/stale-claim` before
`applyMutations`.

- [ ] **Step 3: Add negative adoption parity cases**

Add table-driven cases that assert `rejected/stale-claim`, zero patch effects,
and one rejection receipt for:

```ts
[
  ['explicit wrong PR', { claim: { ...currentClaim, prNumber: 2102 } }],
  ['omitted PR after newer claim', {
    claim: withoutPrNumber(currentClaim),
    latestClaimOid: STALE,
  }],
  ['phase-complete omitted PR', {
    claim: { ...withoutPrNumber(currentClaim), phaseComplete: true },
  }],
  ['phase-complete below remote head', {
    claim: { ...currentClaim, phaseComplete: true },
    latestClaimOid: CLAIM,
    remoteHead: STALE,
    prHead: STALE,
  }],
]
```

Use the existing literal harness constants `CLAIM`, `EXPECTED`, and `STALE`.
Keep each failure attributable to the shared claim gate rather than an earlier
head or correlation gate.

- [ ] **Step 4: Use the shared helper in marketplace authority**

Import `branchClaimPrAuthorityMatches()` and replace both:

```ts
claim.prNumber !== session.prNumber
```

and:

```ts
claim.phaseComplete === true
  ? authority.latestClaimOid !== authority.remoteHead
  : authority.latestClaimOid !== manifest.claimOid
```

with:

```ts
!branchClaimPrAuthorityMatches({
  claim,
  expectedPrNumber: session.prNumber,
  originClaimOid: gitOid(manifest.claimOid),
  latestClaimOid: authority.latestClaimOid,
  remoteHead: authority.remoteHead,
})
```

Leave every sibling authority predicate unchanged.

- [ ] **Step 5: Run focused adoption suites and verify GREEN**

Run:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn test \
  test/lifecycle/implementation-claim-authority.test.ts \
  test/lifecycle/implementation-session.test.ts \
  test/lifecycle/implementation-executor.test.ts \
  test/lifecycle/marketplace-mutation-adoption.test.ts \
  test/lifecycle/marketplace-mutation-adoption-production.test.ts \
  test/lifecycle/marketplace-solution-vertical.test.ts
```

Expected: all tests pass with zero failures.

- [ ] **Step 6: Commit adoption parity**

```bash
git add src/lifecycle/marketplace-mutation-adoption.ts \
  test/lifecycle/marketplace-mutation-adoption.test.ts
git diff --cached --check
git commit -m "fix: adopt claims created before pull requests"
```

---

### Task 4: Verification, Review, and Publication

**Files:**
- Modify: `docs/superpowers/specs/2026-07-28-marketplace-claim-authority-parity-design.md` only if implementation proves a required design correction.
- Modify: `docs/superpowers/plans/2026-07-28-marketplace-claim-authority-parity.md` only if implementation proves a required command or interface correction.

**Interfaces:**
- Consumes: Tasks 1–3 commits.
- Produces: one clean independently reviewed PR `#68` head with reproducible
  source and distribution artifacts and exact-head green CI.

- [ ] **Step 1: Run all focused claim, session, and marketplace suites**

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn test \
  test/lifecycle/implementation-claim-authority.test.ts \
  test/lifecycle/implementation-session.test.ts \
  test/lifecycle/implementation-executor.test.ts \
  test/lifecycle/implementation-executor-production.test.ts \
  test/lifecycle/marketplace-mutation-adoption.test.ts \
  test/lifecycle/marketplace-mutation-adoption-production.test.ts \
  test/lifecycle/marketplace-solution-recovery.test.ts \
  test/lifecycle/marketplace-solution-vertical.test.ts
```

Expected: exit `0`, zero failed files and tests.

- [ ] **Step 2: Run typecheck**

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn typecheck
```

Expected: exit `0`, no TypeScript errors.

- [ ] **Step 3: Run the complete test suite**

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn test
```

Expected: exit `0`, zero failed files and tests.

- [ ] **Step 4: Build and verify source/distribution parity**

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn build
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn verify:source
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn verify:dist
git diff --check
```

Expected: all commands exit `0`.

- [ ] **Step 5: Self-review exact scope**

```bash
BASE_SHA=ab7c2f2f94c2507cf9817d6844c6be90e0cfe3a4
HEAD_SHA="$(git rev-parse HEAD)"
git diff --stat "$BASE_SHA..$HEAD_SHA"
git diff "$BASE_SHA..$HEAD_SHA"
git status --short
```

Confirm:

- only the claim-authority design/plan, shared helper, session/executor parity,
  and adoption tests/production changed;
- no claim, marketplace, SDK, or receipt schema changed;
- no live issue, Task, receipt, database, capability, token, attempt, or
  canary artifact was edited; and
- the worktree is clean.

- [ ] **Step 6: Request mandatory independent review**

Review exact `ab7c2f2f94c2507cf9817d6844c6be90e0cfe3a4..HEAD` against this design and
plan. Require explicit Critical/Important/Minor findings and a merge-readiness
verdict. The reviewer independently runs at least the focused suites.

- [ ] **Step 7: Resolve valid findings with RED/GREEN**

For every valid Critical or Important finding:

```text
write a regression test -> run RED -> implement the minimal correction -> run GREEN
```

Commit corrections separately and repeat focused, typecheck, full-suite,
build, source, distribution, and independent-review gates until no Critical
or Important findings remain.

- [ ] **Step 8: Push the exact reviewed head to PR #68**

```bash
git status --short
git push origin codex/marketplace-solution-adoption
```

Read back PR `#68` head and required checks. Do not start a fresh canary until
the pushed head is exact and all required CI is green.
