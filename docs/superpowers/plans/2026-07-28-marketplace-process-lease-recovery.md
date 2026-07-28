# Marketplace Process Lease Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make real marketplace mutation and evaluator attempts acquire an idempotent, recoverable lease on the Autopilot process before adoption work.

**Architecture:** A dedicated manifest primitive owns marketplace process metadata without changing marketplace execution evidence. Submission, pre-adoption recovery, and evaluator anchoring all call the primitive at their existing durable boundaries; a live foreign PID blocks, while a dead PID is safely rebound.

**Tech Stack:** TypeScript, Node.js 22, Vitest, atomic JSON attempt manifests, existing marketplace v2/v3 and evaluator-leg state machines.

## Global Constraints

- Task `1197`, PR `2267`, its rejected receipt, and the local Jinn database are immutable.
- Do not run Autopilot active/recover mode or submit a live Task while implementing this plan.
- Do not edit, delete, or supersede an authenticated marketplace receipt.
- Preserve local-backend behavior byte-for-byte.
- Add no dependency, daemon, heartbeat, database, timeout, SDK schema, or marketplace request/receipt field.
- A marketplace process claim may change only `processState`, `pid`, `timestamps.updatedAt`, and `timestamps.childStartedAt`.
- Every production behavior starts with a test that is run and observed failing for the intended reason.
- Use Node.js `>=22 <23`.

---

### Task 1: Dedicated Marketplace Process Claim

**Files:**
- Modify: `src/lifecycle/attempt-workspace.ts`
- Test: `test/lifecycle/attempt-workspace.test.ts`

**Interfaces:**
- Consumes: strict `AttemptManifest`, `decodeAttemptManifest()`, `readAttemptManifest()`, and `writeManifestAtomic()`.
- Produces:

```ts
export interface MarketplaceAttemptProcessClaimOptions {
  readonly pid?: number;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly now?: () => Date;
}

export function claimMarketplaceAttemptProcess(
  manifestPath: string,
  options?: MarketplaceAttemptProcessClaimOptions,
): AttemptManifest;
```

- [ ] **Step 1: Add a production-shaped fixture helper and the preparing-acquisition test**

Use an actual marketplace manifest produced by `createAttemptWorkspace()`.
The production change that makes this test fail is omission of the dedicated
process claim.

```ts
it('claims a submitted preparing marketplace attempt without changing execution evidence', async () => {
  const fixture = repositoryFixture();
  const manifest = await createSubmittedMarketplaceAttempt(fixture);
  const executionBefore = structuredClone(manifest.execution);

  const claimed = claimMarketplaceAttemptProcess(manifest.paths.manifest, {
    pid: 700,
    isPidAlive: () => false,
    now: () => new Date('2026-07-28T12:03:00.000Z'),
  });

  expect(claimed).toMatchObject({
    processState: 'running',
    pid: 700,
    timestamps: {
      updatedAt: '2026-07-28T12:03:00.000Z',
      childStartedAt: '2026-07-28T12:03:00.000Z',
    },
  });
  expect(claimed.execution).toEqual(executionBefore);
});
```

- [ ] **Step 2: Run the preparing-acquisition test and verify RED**

Run:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn test \
  test/lifecycle/attempt-workspace.test.ts \
  -t "claims a submitted preparing marketplace attempt"
```

Expected: FAIL because `claimMarketplaceAttemptProcess` is not exported.

- [ ] **Step 3: Add the remaining lease behavior tests**

Name and independently assert these breaks:

| Test | Literal setup | Literal result |
| --- | --- | --- |
| replays a claim by the same PID without rewriting bytes or timestamps | `running,pid=700`, claimant `700` | before/after `Buffer` equality |
| refuses another live PID | `running,pid=701`, claimant `700`, `isPidAlive(701)=true` | throws; before/after `Buffer` equality |
| rebinds a dead PID | `running,pid=701`, claimant `700`, `isPidAlive(701)=false` | `running,pid=700`, claim timestamp |
| refuses exited and terminal attempts | `exited` submitted plus preparing cancelled/receipt-published cases | throws; bytes unchanged |
| refuses clock regression | manifest updated `12:03`, claim time `12:02` | throws; bytes unchanged |
| claims anchored but refuses released evaluator legs | evaluator state `anchored` then `released` | anchored becomes `running`; released throws unchanged |

For byte stability, read the manifest bytes before and after same-PID replay
and compare `Buffer` values. For refusal cases, compare bytes before and after
the thrown error. For rebind, assert the literal replacement PID and timestamp
and deep equality of the complete `execution` object.

- [ ] **Step 4: Run all new lease tests and verify RED**

Run:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn test \
  test/lifecycle/attempt-workspace.test.ts \
  -t "marketplace attempt|evaluator leg"
```

Expected: the new claim tests fail because the API is absent; unrelated
existing tests pass.

- [ ] **Step 5: Implement the minimal dedicated process claim**

Add a default PID liveness probe:

```ts
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
```

Strictly permit only submitted/nonterminal adoption state or anchored
evaluator state. Use `decodeAttemptManifest()` and `writeManifestAtomic()`
directly because generic `updateAttemptManifest()` intentionally rejects
marketplace execution manifests.

```ts
export function claimMarketplaceAttemptProcess(
  manifestPath: string,
  options: MarketplaceAttemptProcessClaimOptions = {},
): AttemptManifest {
  const claimantPid = positiveInteger(options.pid ?? process.pid, 'marketplace process PID');
  const isAlive = options.isPidAlive ?? pidIsAlive;
  const current = readAttemptManifest(manifestPath);
  assertMarketplaceProcessClaimable(current);

  if (current.processState === 'exited') {
    throw new Error('Exited marketplace attempt cannot acquire a process lease');
  }
  if (current.processState === 'running' && current.pid === claimantPid) {
    return current;
  }
  if (
    current.processState === 'running'
    && current.pid !== null
    && isAlive(current.pid)
  ) {
    throw new Error('Marketplace attempt process lease is held by a live PID');
  }

  const timestamp = transitionTimestamp(options.now ?? (() => new Date()));
  if (Date.parse(timestamp) < Date.parse(current.timestamps.updatedAt)) {
    throw new Error('Marketplace process claim predates the manifest update');
  }
  const claimed = decodeAttemptManifest({
    ...current,
    processState: 'running',
    pid: claimantPid,
    timestamps: {
      ...current.timestamps,
      updatedAt: timestamp,
      childStartedAt: timestamp,
    },
  });
  writeManifestAtomic(manifestPath, claimed);
  return claimed;
}
```

The private `assertMarketplaceProcessClaimable()` accepts:

```text
v2: submitted
v3: submitted, solution-observed, solution-verified, host-committed,
    lifecycle-completed, review-anchored
evaluator leg: anchored
```

It rejects every other backend/schema/status.

- [ ] **Step 6: Run the focused attempt-workspace suite and verify GREEN**

Run:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn test \
  test/lifecycle/attempt-workspace.test.ts
```

Expected: all tests pass with zero failures.

- [ ] **Step 7: Commit the process primitive**

```bash
git add src/lifecycle/attempt-workspace.ts \
  test/lifecycle/attempt-workspace.test.ts
git diff --cached --check
git commit -m "fix: claim marketplace process leases"
```

---

### Task 2: Submission and Adoption-Recovery Lease Wiring

**Files:**
- Modify: `src/lifecycle/session-execution-backend.ts`
- Test: `test/lifecycle/session-execution-backend.test.ts`
- Test: `test/lifecycle/marketplace-solution-recovery.test.ts`
- Test: `test/lifecycle/marketplace-solution-vertical.test.ts`

**Interfaces:**
- Consumes: `claimMarketplaceAttemptProcess()` from Task 1.
- Produces:
  - `MarketplaceSessionExecutionBackend.start()` and `.recover()` return
    `started` only after the exact attempt is `submitted+running`.
  - `recoverSubmittedMarketplaceAttempts()` claims/rebinds before adopter
    construction or invocation.
  - Optional `processPid` injection on backend/recovery options for literal
    tests; production defaults to `process.pid`.

- [ ] **Step 1: Add backend RED tests for fresh, replayed, and durable-submitted starts**

Extend real `marketplaceFixture()` assertions:

```ts
expect(readAttemptManifest(fixture.manifest.paths.manifest)).toMatchObject({
  processState: 'running',
  pid: 710,
  execution: { backend: 'marketplace', state: { status: 'submitted' } },
});
```

Cover:

| Test | Adapter calls | Manifest result |
| --- | --- | --- |
| fresh submission records a process lease | `submit=1`, `recover=0` | `submitted,running,pid=710` |
| prepared recovery replay records a process lease | `submit=0`, `recover=1` | `submitted,running,pid=710` |
| submitted plus preparing repairs without replay | `submit=0`, `recover=0` | same submission plus `running,pid=710` |
| crash after terminal evidence repairs on recovery | first transition throws after evidence; recovery reconciles it | matching submission plus `running,pid=710` |

Inject `processPid: 710`, literal `now`, and a dead prior-PID probe.

- [ ] **Step 2: Run the backend tests and verify RED**

Run:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn test \
  test/lifecycle/session-execution-backend.test.ts \
  -t "marketplace process lease|submitted plus preparing|crash window"
```

Expected: FAIL because returned started identities leave the manifest
`preparing,pid:null`.

- [ ] **Step 3: Wire the claim into the backend's durable started identity**

Add injectable backend options:

```ts
readonly claimMarketplaceAttemptProcess?: typeof claimMarketplaceAttemptProcess;
readonly processPid?: number;
readonly isPidAlive?: (pid: number) => boolean;
```

Store those dependencies. In `startedIdentity()`, validate submitted identity,
then claim:

```ts
const claimed = this.claimProcess(manifest.paths.manifest, {
  pid: this.processPid,
  isPidAlive: this.isPidAlive,
  now: this.now,
});
const submission = marketplaceSubmittedState(claimed).submission;
```

Do not inspect Git or call the adapter for a durable submitted recovery.

- [ ] **Step 4: Run the backend suite and verify GREEN**

Run:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn test \
  test/lifecycle/session-execution-backend.test.ts
```

Expected: all tests pass with zero failures.

- [ ] **Step 5: Add pre-adoption recovery RED tests**

Use real manifest files in `marketplace-solution-recovery.test.ts`:

```ts
it('claims a preparing submitted attempt before invoking its adopter', async () => {
  const seen: AttemptManifest[] = [];
  const result = await recoverSubmittedMarketplaceAttempts({
    v2Base,
    recoverPrepared: async () => [],
    processPid: 720,
    isPidAlive: () => false,
    makeAdopter: () => ({
      adopt: async (manifestPath) => {
        seen.push(readAttemptManifest(manifestPath));
        return { status: 'recoverable', stage: 'observation', detail: 'pending' };
      },
    }),
    now: () => NOW,
  });
  expect(result).toEqual({ ok: true });
  expect(seen[0]).toMatchObject({ processState: 'running', pid: 720 });
});
```

Add:

| Test | Literal setup | Result |
| --- | --- | --- |
| live foreign process blocks adopter | `running,pid=721`, claimant `720`, PID 721 alive | `ok:false`, zero adopter calls, bytes unchanged |
| dead process rebinds before mid-adoption replay | `solution-observed,running,pid=721`, PID 721 dead | adopter reads `running,pid=720` |
| receipt-published remains outside acquisition | accepted/rejected terminal manifest | existing reconciliation behavior; no claim call |

Assert the live-foreign case returns `ok:false`, leaves bytes unchanged, and
records zero adopter calls.

Also add a production-shaped vertical that begins
`submitted+preparing,pid:null`, enters through
`recoverSubmittedMarketplaceAttempts()`, and reaches an accepted receipt
without a second Task or local agent:

```ts
expect(result).toEqual({ ok: true });
expect(marketplaceStatus(readAttemptManifest(harness.manifestPath)))
  .toBe('receipt-published');
expect(readAttemptManifest(harness.manifestPath))
  .toMatchObject({ processState: 'running', pid: 720 });
expect(harness.taskSubmissions).toBe(0);
expect(harness.agentSpawns).toBe(0);
expect(harness.comments).toHaveLength(1);
expect(harness.reviewAnchorLinked()).toBe(true);
```

- [ ] **Step 6: Run pre-adoption and vertical tests and verify RED**

Run:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn test \
  test/lifecycle/marketplace-solution-recovery.test.ts \
  test/lifecycle/marketplace-solution-vertical.test.ts \
  -t "process|lease|preparing marketplace"
```

Expected: preparing/dead cases reach the adopter without a running lease, and
the live-foreign case incorrectly invokes it. The vertical receives a
`stale-claim` rejection because the real manifest is still preparing.

- [ ] **Step 7: Claim before adopter invocation**

Add `processPid?: number` to
`RecoverSubmittedMarketplaceAttemptsOptions`. For statuses `submitted` through
`review-anchored`, call:

```ts
manifest = claimMarketplaceAttemptProcess(manifest.paths.manifest, {
  pid: options.processPid ?? process.pid,
  isPidAlive: options.isPidAlive,
  now,
});
```

Place this after v2 upgrade and before `makeAdopter()`. Leave
`receipt-published` reconciliation and `cancelled` behavior unchanged.

- [ ] **Step 8: Run the two focused suites and verify GREEN**

Run:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn test \
  test/lifecycle/session-execution-backend.test.ts \
  test/lifecycle/marketplace-solution-recovery.test.ts \
  test/lifecycle/marketplace-solution-vertical.test.ts
```

Expected: both files pass with zero failures.

- [ ] **Step 9: Commit submission and recovery wiring**

```bash
git add src/lifecycle/session-execution-backend.ts \
  test/lifecycle/session-execution-backend.test.ts \
  test/lifecycle/marketplace-solution-recovery.test.ts \
  test/lifecycle/marketplace-solution-vertical.test.ts
git diff --cached --check
git commit -m "fix: recover marketplace process ownership"
```

---

### Task 3: Evaluator Process Lease

**Files:**
- Modify: `src/lifecycle/marketplace-review-anchor.ts`
- Test: `test/lifecycle/marketplace-review-anchor.test.ts`

**Interfaces:**
- Consumes: `claimMarketplaceAttemptProcess()` and the Task 2 recovery boundary.
- Produces: every returned `anchored` evaluator leg has a process lease held by
  the current Autopilot process.

- [ ] **Step 1: Add evaluator-anchor RED tests**

Inject literal process dependencies through
`MarketplaceReviewAnchorDependencies`:

```ts
readonly processPid?: number;
readonly isPidAlive?: (pid: number) => boolean;
```

Cover both creation and recovery:

| Test | Literal setup | Result |
| --- | --- | --- |
| new evaluator anchor acquires process | prepared evaluator, claimant PID `730` | returned anchor and manifest `anchored,running,pid=730` |
| recovered anchor rebinds dead process | anchored evaluator `running,pid=731`, PID 731 dead | returned anchor and manifest PID `730` |
| live foreign evaluator owner is recoverable | anchored evaluator `running,pid=731`, PID 731 alive | `recoverable`, bytes unchanged, no extra review-ref mutation |

Assert the manifest is `anchored+running` before the API returns anchor
evidence. The live-foreign test compares bytes and review-ref mutation counts.

- [ ] **Step 2: Run evaluator tests and verify RED**

Run:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn test \
  test/lifecycle/marketplace-review-anchor.test.ts \
  -t "process"
```

Expected: returned anchored manifests remain `preparing,pid:null`.

- [ ] **Step 3: Claim the evaluator process at the anchor boundary**

In `anchorFromPreparedManifest()`, install or read the exact anchored
evaluator execution first, then call:

```ts
const running = claimMarketplaceAttemptProcess(manifest.paths.manifest, {
  pid: deps.processPid ?? process.pid,
  isPidAlive: deps.isPidAlive,
  now,
});
return {
  status: 'anchored',
  anchor: anchorEvidenceFromEvaluatorManifest(running),
};
```

Pass the complete dependencies into both new and recovered anchor paths.
Convert a live foreign lease error to:

```ts
{ status: 'recoverable', detail: error.message }
```

without publishing or releasing review authority.

- [ ] **Step 4: Run evaluator suite and verify GREEN**

Run:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn test \
  test/lifecycle/marketplace-review-anchor.test.ts
```

Expected: all tests pass with zero failures.

- [ ] **Step 5: Commit evaluator lease coverage**

```bash
git add src/lifecycle/marketplace-review-anchor.ts \
  test/lifecycle/marketplace-review-anchor.test.ts
git diff --cached --check
git commit -m "fix: lease marketplace evaluator anchors"
```

---

### Task 4: Verification, Review, and Publication

**Files:**
- Modify: `docs/superpowers/specs/2026-07-28-marketplace-process-lease-recovery-design.md` only if implementation reveals a required design correction.
- Modify: `docs/superpowers/plans/2026-07-28-marketplace-process-lease-recovery.md` only to mark completed steps if repository convention requires it.

**Interfaces:**
- Consumes: Tasks 1–3 commits.
- Produces: one clean, reviewed PR #68 head with no Critical or Important
  findings and a reproducible production build.

- [ ] **Step 1: Run all focused marketplace and lifecycle suites**

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn test \
  test/lifecycle/attempt-workspace.test.ts \
  test/lifecycle/session-execution-backend.test.ts \
  test/lifecycle/marketplace-solution-recovery.test.ts \
  test/lifecycle/marketplace-review-anchor.test.ts \
  test/lifecycle/marketplace-solution-vertical.test.ts \
  test/lifecycle/marketplace-mutation-adoption.test.ts \
  test/lifecycle/marketplace-mutation-adoption-production.test.ts
```

Expected: zero failures.

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

- [ ] **Step 4: Build and verify the distribution**

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn build
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn verify:source
PATH="/opt/homebrew/opt/node@22/bin:$PATH" yarn verify:dist
git diff --check
```

Expected: all commands exit `0`.

- [ ] **Step 5: Self-review exact scope and safety**

```bash
BASE_SHA=8c2dcf91496021b0e3dd418362a82508f60593b1
HEAD_SHA="$(git rev-parse HEAD)"
git diff --stat "$BASE_SHA..$HEAD_SHA"
git diff "$BASE_SHA..$HEAD_SHA"
git status --short
```

Confirm:

- only the process-lease design/plan, four production/test areas, and necessary
  vertical coverage changed;
- Task/receipt schemas and local execution are untouched;
- no generated distribution, token, capability, attempt, or live-canary file
  is tracked; and
- the worktree is clean.

- [ ] **Step 6: Request mandatory scoped review**

Dispatch a read-only reviewer for
`8c2dcf91496021b0e3dd418362a82508f60593b1..HEAD` with this plan and design.
Require explicit Critical/Important/Minor findings and a merge-readiness
verdict. The reviewer must independently run at least the focused suites.

- [ ] **Step 7: Resolve all Critical and Important findings with TDD**

For each valid finding:

```text
write a regression test → run RED → implement minimal fix → run GREEN
```

Commit fixes separately and repeat focused/typecheck/full/build verification
plus review until no Critical or Important findings remain.

- [ ] **Step 8: Push the exact reviewed head to PR #68**

```bash
git status --short
git push origin codex/marketplace-solution-adoption
```

Read back PR #68 head and CI. Do not start a fresh canary until the pushed head
and required checks are exact and green.
