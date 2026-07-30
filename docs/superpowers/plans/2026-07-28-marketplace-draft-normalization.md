# Marketplace Draft Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a production-order draft implementation pull request enter marketplace Solution verification without weakening explicit Human or CODEOWNER rejection.

**Architecture:** Keep the existing marketplace authority shape and adoption consumer. Narrow the production authority normalization so `draft` remains an independent pull-request lifecycle fact while `humanActive` contains only shared external-Human sources and qualifying Human protocol comments; keep `codeOwnerRequired` independently derived from the live review candidate.

**Tech Stack:** TypeScript, Node.js 22, Vitest, GitHub pull-request/project authority, existing Autopilot v2 marketplace adoption state machine.

## Global Constraints

- Task `1200`, pull request `#2273`, its Solution, receipt, daemon rows, and all earlier canary Tasks and receipts are immutable.
- Do not run Autopilot active/recover mode or submit a live Task during implementation.
- Do not create a fresh issue or Task before the implementation is independently reviewed, pushed to pull request `#68`, and exact-head CI is green.
- Treat pull-request draft state as lifecycle state, not Human authority.
- Keep `humanActive` true for `review:needs-human`, `autopilot:human`, Project `Blocked on = Human`, and qualifying `<!-- jinn-autopilot:v2-human` comments.
- Keep `codeOwnerRequired` independent and fail closed for incomplete or matching CODEOWNERS evidence.
- Preserve all request, result, receipt, attempt, evaluator, claim, process, head, mapping, workflow, child, receipt-author, and correlation schemas and fences.
- Every changed production behavior starts with a test that is run and observed failing for the intended reason.
- Use Node.js `>=22 <23`.

---

### Task 1: Production Authority Regression and Narrow Fix

**Files:**
- Modify: `test/lifecycle/marketplace-mutation-adoption-production.test.ts`
- Modify: `src/lifecycle/marketplace-mutation-adoption-production.ts:434-438`

**Interfaces:**
- Consumes: `hasExternalHumanAuthority()` from `src/lifecycle/human-authority.ts` and the existing paginated Human-comment scan.
- Produces: the unchanged `MarketplaceMutationAuthority.pullRequest` shape with independent `draft`, `humanActive`, and `codeOwnerRequired` facts.

- [ ] **Step 1: Make the production snapshot fixture express draft and Project-Human inputs**

Extend `snapshotForMapping()` with exact optional inputs:

```ts
function snapshotForMapping(
  mapping: {
    readonly status: 'resolved' | 'ambiguous' | 'missing';
    readonly issueNumber?: number;
    readonly issueNumbers?: number[];
    readonly labels?: readonly string[];
    readonly blockedOn?: 'Nothing' | 'Human';
    readonly isDraft?: boolean;
  },
) {
  const issueNumber = mapping.issueNumber ?? 2001;
  const blockedOn = mapping.blockedOn ?? 'Nothing';
  const isDraft = mapping.isDraft ?? false;
```

Use `blockedOn` for both the native issue and Project item, and `isDraft` for
both the pull-request evidence and lifecycle item. Do not change the default
fixture behavior.

- [ ] **Step 2: Write the production-order draft regression**

Add this authority-port test. Its runner must override the default fixture's
bare-root CODEOWNERS rule so the test isolates draft normalization:

```ts
it('keeps a production-order draft PR separate from Human authority', async () => {
  const { manifest, manifestPath } = fixture();
  const baseline = authorityRunner(manifest);
  const runner = vi.fn(async (
    command: string,
    args: string[],
    options?: { readonly env?: Record<string, string> },
  ) => {
    if (command === 'gh' && args[0] === 'pr') {
      return JSON.stringify({
        number: 2101,
        headRefOid: HEAD,
        headRefName: 'codex/issue-2001',
        baseRefName: 'next',
        isDraft: true,
        labels: [{ name: 'engine:review' }],
        body: '',
        state: 'OPEN',
      });
    }
    if (
      command === 'gh'
      && args.some((arg) => arg.endsWith('/contents/.github/CODEOWNERS'))
    ) {
      return JSON.stringify({
        encoding: 'base64',
        content: Buffer.from('/SPEC.md @Jinn-Network/codeowners\n')
          .toString('base64'),
      });
    }
    return baseline(command, args, options);
  });
  const port = makeProductionMarketplaceMutationAuthorityPort({
    originManifestPath: manifestPath,
    repositoryPath: manifest.repository.root,
    worktreeBase: '/tmp/worktrees',
    runnerId: manifest.runnerId,
    readSnapshot: async () => snapshotForMapping({
      status: 'resolved',
      isDraft: true,
    }) as never,
    runner,
    environment: { PATH: '/usr/bin' },
  });

  const authority = await port.readExactAuthority({
    manifestPath,
    touchedPaths: [],
  });

  expect(authority.pullRequest).toMatchObject({
    draft: true,
    humanActive: false,
    codeOwnerRequired: false,
  });
  expectNoMutatingGhApiCalls(runner.mock.calls);
});
```

- [ ] **Step 3: Add explicit Human-source preservation cases**

Turn the existing `review:needs-human` production test into:

```ts
it.each([
  'review:needs-human',
  'autopilot:human',
])('marks Human dominance from live %s labels', async (label) => {
```

Use `label` in both the live pull-request response and
`snapshotForMapping({ labels: [label] })`, then keep:

```ts
expect(authority.pullRequest.humanActive).toBe(true);
expectNoMutatingGhApiCalls(runner.mock.calls);
```

Add `marks Human dominance from Project Blocked on` using the baseline runner
and:

```ts
readSnapshot: async () => snapshotForMapping({
  status: 'resolved',
  blockedOn: 'Human',
}) as never,
```

and require `humanActive === true`.

Add `marks Human dominance from a qualifying Human protocol comment`. Wrap the
baseline runner and intercept only the comments endpoint:

```ts
if (
  command === 'gh'
  && args[0] === 'api'
  && args.some((arg) => arg.includes('/issues/2101/comments'))
) {
  return JSON.stringify([{
    id: 73,
    user: { login: 'jinn-autopilot' },
    body: '<!-- jinn-autopilot:v2-human issue=2001 -->',
    created_at: '2026-07-24T12:01:00.000Z',
    updated_at: '2026-07-24T12:01:00.000Z',
  }]);
}
return baseline(command, args, options);
```

Require `humanActive === true` and no mutating GitHub API calls. Keep the
existing exact CODEOWNERS test and its
`codeOwnerRequired === true` assertion unchanged.

- [ ] **Step 4: Run focused authority tests and verify RED**

Run:

```bash
PATH="/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH" \
yarn test test/lifecycle/marketplace-mutation-adoption-production.test.ts \
  -t "production-order draft PR|Human dominance|Project Blocked on|Human protocol comment|CODEOWNER"
```

Expected:

- the new draft regression fails because actual `humanActive` is `true`;
- the explicit Human and CODEOWNER preservation cases pass;
- no test errors from malformed fixtures or command routing.

- [ ] **Step 5: Implement the minimal normalization change**

In `makeProductionMarketplaceMutationAuthorityPort()`, change only:

```ts
const humanActive = hasExternalHumanAuthority({
  pullRequestLabels: pullRequest.labels,
  nativeIssueLabels: issue?.labels,
  projectBlockedOn: projectItem?.blockedOn ?? null,
}) || humanComment;
```

Do not change the `draft` field, `codeOwnerRequired`, `authorityFailure()`, or
any schema.

- [ ] **Step 6: Run focused authority tests and verify GREEN**

Run the Step 4 command again.

Expected: all selected tests pass, including
`draft: true`, `humanActive: false`, and `codeOwnerRequired: false` for the
production-order case.

---

### Task 2: Adoption-Level Fail-Closed Characterization

**Files:**
- Modify: `test/lifecycle/marketplace-mutation-adoption.test.ts`
- Test: `test/lifecycle/marketplace-mutation-adoption-production.test.ts`
- Test: `test/lifecycle/marketplace-solution-vertical.test.ts`

**Interfaces:**
- Consumes: the existing `Harness.humanActive`,
  `Harness.codeOwnerRequired`, and `adopt()` behavior.
- Produces: direct evidence that the unchanged adoption consumer still rejects
  explicit Human and CODEOWNER authority before patch effects.

- [ ] **Step 1: Add the explicit-Human adoption characterization**

Add beside the existing CODEOWNER rejection:

```ts
it('rejects explicit Human authority before effects', async () => {
  const harness = new Harness();
  harness.humanActive = true;

  await expect(adopt(harness)).resolves.toMatchObject({
    status: 'rejected',
    reason: 'policy-human',
  });
  expect(harness.applyMutations).toBe(0);
  expect(harness.comments).toHaveLength(1);
});
```

Extend the existing CODEOWNER case with:

```ts
expect(harness.comments).toHaveLength(1);
```

These are preservation characterizations and may pass before the production
change; Task 1's draft test is the required behavior-changing RED.

- [ ] **Step 2: Run the adoption-level policy cases**

Run:

```bash
PATH="/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH" \
yarn test test/lifecycle/marketplace-mutation-adoption.test.ts \
  -t "explicit Human authority|CODEOWNER surface"
```

Expected: both cases pass and record zero patch effects.

- [ ] **Step 3: Run the complete focused marketplace regression set**

Run:

```bash
PATH="/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH" \
yarn test \
  test/lifecycle/marketplace-mutation-adoption-production.test.ts \
  test/lifecycle/marketplace-mutation-adoption.test.ts \
  test/lifecycle/marketplace-solution-vertical.test.ts \
  test/lifecycle/implementation-session.test.ts \
  test/lifecycle/implementation-executor.test.ts
```

Expected: all focused files pass with zero failures.

- [ ] **Step 4: Inspect and commit the code change**

Run:

```bash
git diff --check
git diff -- \
  src/lifecycle/marketplace-mutation-adoption-production.ts \
  test/lifecycle/marketplace-mutation-adoption-production.test.ts \
  test/lifecycle/marketplace-mutation-adoption.test.ts
```

Confirm the production diff removes only the draft-to-Human alias and the test
diff contains the positive and preserved-negative cases. Then:

```bash
git add \
  src/lifecycle/marketplace-mutation-adoption-production.ts \
  test/lifecycle/marketplace-mutation-adoption-production.test.ts \
  test/lifecycle/marketplace-mutation-adoption.test.ts
git diff --cached --check
git commit -m "fix: keep draft separate from Human authority"
```

---

### Task 3: Full Verification, Independent Review, and Publication

**Files:**
- Verify: all tracked source, tests, and generated `dist/`
- Review: the complete branch diff for pull request `#68`
- Update after all gates: the existing Task 5 report in the Jinn worktree

**Interfaces:**
- Consumes: committed design, plan, tests, and production fix.
- Produces: one independently reviewed, exact-head-green pull request update
  without any fresh live issue or Task.

- [ ] **Step 1: Run typecheck**

```bash
PATH="/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH" \
yarn typecheck
```

Expected: exit `0`.

- [ ] **Step 2: Run the complete test suite**

```bash
PATH="/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH" \
yarn test
```

Expected: exit `0` with zero failed files or tests.

- [ ] **Step 3: Build and verify source/distribution parity**

```bash
PATH="/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH" \
yarn build
PATH="/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH" \
yarn verify:source
PATH="/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH" \
yarn verify:dist
git diff --check
```

Expected: every command exits `0`; generated distribution is current.

- [ ] **Step 4: Commit generated distribution only if build changed it**

If `git status --short` shows tracked `dist/` changes, inspect them and commit:

```bash
git add dist
git diff --cached --check
git commit -m "build: refresh marketplace adoption distribution"
```

If no tracked distribution change exists, do not create an empty commit.

- [ ] **Step 5: Request independent code review**

Use `superpowers:requesting-code-review` against the full branch diff. The
review must explicitly check:

- production-order draft acceptance;
- explicit Human-source preservation;
- CODEOWNER fail-closed preservation;
- Task `1200` immutability;
- absence of schema or unrelated lifecycle changes; and
- adequacy of the RED-GREEN evidence.

Resolve every Critical, Important, and Minor finding with a fresh RED-GREEN
cycle as applicable, then repeat focused and full verification.

- [ ] **Step 6: Push the exact reviewed head to pull request `#68`**

```bash
git status --short --branch
git rev-parse HEAD
git push origin codex/marketplace-solution-adoption
```

Expected: the remote branch head equals the reviewed local head.

- [ ] **Step 7: Require exact-head CI green**

Read pull request `#68` and verify:

- PR head OID equals the pushed local OID;
- Ubuntu CI succeeds at that OID;
- macOS CI succeeds at that OID; and
- no required check is pending or failed.

Do not create a live issue or Task while any check is non-terminal or attached
to a different head.

- [ ] **Step 8: Restore the temporary local Jinn binary pointer**

After no further canary recovery is authorized, restore ignored
`node_modules/@jinn-network/client/package.json` in the Autopilot worktree from
the absolute reviewed Jinn binary path to:

```json
"jinn": "./dist/bin/jinn.js"
```

Confirm the Autopilot worktree has no unintended local state.

- [ ] **Step 9: Update the Task 5 report**

Append the immutable Task `1200` evidence, root cause, repair commits,
verification, independent-review result, pushed head, and exact-head CI result
to:

```text
/Users/adrianobradley/life's-work/jinn-mono/.worktrees/autopilot-mutation-payload-binding/.superpowers/sdd/2026-07-28-autopilot-mutation-delivery-binding/task-5-report.md
```

Record explicitly that Task `1200` failed
`adoption-rejected:policy-human`, no evaluator leg or Verdict was created, and
no live retry occurred.
