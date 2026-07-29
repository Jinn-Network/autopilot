# Task 11 Formal Fix Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind READY assurance to the exact live/durable managed-fork identity and to a complete canonical timeline derived from the durable generation record.

**Architecture:** Extend the READY-only PR authority with immutable target/fork identity and persist the same optional identity fields in the durable PR marker, while requiring them for READY. Build a deterministic event timeline from the already parsed durable record, require the caller projection to equal it exactly, and render only the derived projection.

**Tech Stack:** TypeScript, Zod marker codecs, Vitest, Node 22.

## Global Constraints

- Use strict RED/GREEN TDD and observe every new adversarial test failing before production changes.
- Preserve every formal-fix-round-1 authority, URL, Unicode, cancellation, one-comment, and readback invariant.
- Do not push.
- Commit the round as one separate fix commit after fresh verification and independent review.
- Append the central Task 11 report without rewriting earlier evidence.

---

### Task 1: Exact live and durable managed-fork authority

**Files:**
- Modify: `src/issue-relay/state.ts`
- Modify: `src/issue-relay/markers.ts`
- Modify: `src/issue-relay/report.ts`
- Test: `test/issue-relay/report.test.ts`

**Interfaces:**
- Consumes: the frozen snapshot target slug/node ID, canonical receipt/anchor/verdict workspaces, and host-read current PR facts.
- Produces: READY evidence whose current and durable PR facts carry the same public managed-fork slug and immutable repository IDs.

- [x] **Step 1: Write failing host-authority tests**

Add exact mutation probes for:

```ts
currentPr.targetRepositoryId
currentPr.forkRepositoryId
currentPr.forkParentRepositoryId
currentPr.forkRepository
currentPr.visibility
currentPr.branch
record.pr.forkRepository
record.pr.forkRepositoryId
```

Add one self-consistent artifact attack that changes the latest repair
workspace, receipt, receipt block, anchor, anchor block, and verdict round to
an attacker fork while leaving the live/durable host authority unchanged.
Add one round-0 mutation that changes its upstream workspace or frozen input.

- [x] **Step 2: Run the focused report tests and verify RED**

Run:

```bash
export PATH="/Users/adrianobradley/.nvm/versions/node/v22.22.2/bin:$PATH"
yarn vitest run test/issue-relay/report.test.ts
```

Expected: the new managed-fork and round-0 probes fail because READY currently
does not bind those facts.

- [x] **Step 3: Implement the minimal exact authority**

Extend the durable `pr` shape and strict marker codec with optional READY
identity fields:

```ts
targetRepository?: string;
targetRepositoryId?: string;
forkRepository?: string;
forkRepositoryId?: string;
forkParentRepositoryId?: string;
visibility?: 'PUBLIC' | 'PRIVATE' | 'INTERNAL';
managedFork?: boolean;
```

Extend READY `currentPr` with the same required identity, requiring
`visibility: 'PUBLIC'`, `managedFork: true`, distinct non-empty target/fork
IDs, exact parent-to-target ID, exact frozen target slug/node ID, and an exact
fork slug distinct from the target. Require durable PR identity, latest repair
workspace, receipt, anchor, verdict round, and live PR head repository to equal
that exact fork. Require round 0 to retain the frozen upstream target workspace
and frozen base input.

- [x] **Step 4: Run focused tests and typecheck to verify GREEN**

Run:

```bash
yarn vitest run test/issue-relay/report.test.ts
yarn typecheck
```

Expected: all pass.

---

### Task 2: Canonical complete durable timeline

**Files:**
- Modify: `src/issue-relay/report.ts`
- Test: `test/issue-relay/report.test.ts`

**Interfaces:**
- Consumes: every durable round task, solution, adoption, and verdict fact.
- Produces: one deterministic ordered `RelayRoundTimelineItem[]` that is both the READY comparison authority and the rendered timeline.

- [x] **Step 1: Write failing timeline-completeness tests**

Create a three-round valid READY record with two prior
`request-changes` verdicts. Assert rejection when the caller timeline:

```ts
omits a prior request-changes event
omits a funded, solution, or adoption event
reorders two events
adds an extra contradictory event
labels the final repair as initial
changes the final passed head
```

Also assert that the accepted rendered report visibly retains every prior
request-changes and repair event in canonical order.

- [x] **Step 2: Run the focused report tests and verify RED**

Run:

```bash
yarn vitest run test/issue-relay/report.test.ts
```

Expected: omission/reordering/extra-item probes are accepted or the complete
canonical report cannot yet be constructed.

- [x] **Step 3: Implement the minimal canonical projection**

Derive, in round order, exactly:

```ts
task -> funded at inputHead
solution -> solution-delivered at inputHead
accepted adoption -> adopted at resultingHead
rejected adoption -> rejected at inputHead
pass verdict -> passed at evaluatedHead
request-changes verdict -> request-changes at evaluatedHead
human verdict -> human at evaluatedHead
unresolved verdict -> unresolved at evaluatedHead
```

Use fixed summaries. For READY, require deep exact equality between the caller
timeline and this derived projection, retain the exact final passed
round/head/purpose gate, and render only the derived projection.

- [x] **Step 4: Run focused tests and typecheck to verify GREEN**

Run:

```bash
yarn vitest run test/issue-relay/report.test.ts
yarn typecheck
```

Expected: all pass, including the multi-round negative-evidence assertions.

---

### Task 3: Verification, review, commit, and report

**Files:**
- Modify: `.superpowers/sdd/2026-07-28-jinn-issue-relay/task-11-report.md` in the central workspace after commit.

**Interfaces:**
- Consumes: the completed diff and its exact RED/GREEN evidence.
- Produces: independently reviewed commit, clean worktree, and appended audit report.

- [x] **Step 1: Run fresh verification**

Run:

```bash
yarn vitest run test/issue-relay/report.test.ts
yarn vitest run \
  test/issue-relay/repair.test.ts \
  test/issue-relay/report.test.ts \
  test/issue-relay/state.test.ts \
  test/issue-relay/task.test.ts \
  test/issue-relay/markers.test.ts
yarn vitest run test/issue-relay
yarn typecheck
yarn vitest run
git diff --check
```

- [x] **Step 2: Request independent scoped review**

Review the complete diff from
`0f5efc9b58fd2a6b5fc764db56714c901c094370`, requiring no Critical or
Important findings for managed-fork identity, timeline completeness, or any
round-1 regression.

- [x] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-07-29-task-11-formal-fix-round-2.md \
  src/issue-relay/state.ts \
  src/issue-relay/markers.ts \
  src/issue-relay/report.ts \
  test/issue-relay/report.test.ts
git diff --cached --check
git commit -m "fix(relay): authenticate ready fork and timeline"
```

- [x] **Step 4: Append the report and verify clean state**

Append round-2 findings, RED/GREEN evidence, verification counts, review
outcome, commit SHA, clean status, and no-push state to the central Task 11
report. Confirm `git status --short` is empty in the isolated worktree.
