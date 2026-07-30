# Marketplace Solution Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely adopt marketplace-delivered mutation patches into the existing Autopilot V2 worktree, complete the existing lifecycle protocol, acquire the evaluator-leg review claim, and publish the authenticated Solution receipt.

**Architecture:** Standalone Autopilot invokes the released Jinn CLI for authenticated delivery observation, then runs a port-driven deterministic adoption coordinator. Strict internal execution states and exact Git/GitHub readback make every side effect recoverable; current implementation-session and review-claim protocols remain the only lifecycle authorities.

**Tech Stack:** TypeScript, Node.js 22, Yarn 4, Vitest, Zod through `@jinn-network/sdk`, Git plumbing, GitHub CLI, Docker, released `@jinn-network/sdk@0.1.1`, and released `@jinn-network/client@0.2.2`.

## Global Constraints

- Work only in standalone `Jinn-Network/autopilot`; do not add a Jinn monorepo source import or client-internal import.
- Consume contracts only from `@jinn-network/sdk/autopilot`.
- Invoke the installed client as `jinn tasks observe-autopilot-delivery --expectation-file <path> --json`.
- Do not start a daemon, launcher, generator, local agent, or local fallback in marketplace mode.
- Do not submit another marketplace Task for the evaluator leg.
- Do not call `claimSolutionDelivery`, `claimVerdictDelivery`, or any Router mutation from Autopilot.
- Preserve local backend behavior byte-for-byte at public boundaries and prove it with conformance tests.
- Preserve PR #42 canonical mapping, stacked-base, Human dominance, and machine-owned mapping-reread semantics.
- The immutable marketplace capsule is correlation evidence, never current GitHub authority.
- Keep v1 restricted to `Jinn-Network/mono`, `typescript`, and `jinn-mono.v1`.
- Mutation artifacts are UTF-8 patches of at most `2 * 1024 * 1024` bytes.
- Reject binary/combined diffs, absolute/traversal/`.git` paths, symlink mode `120000`, gitlink mode `160000`, and unsafe verification-control surfaces.
- Run `git apply --check` before plain `git apply`; never use `--3way`.
- Verification uses a pinned Node 22 container, no credentials, bounded resources/output/time, immutable dependency installation, and network-disabled typecheck/test execution.
- Stable validation/policy/verification failures receive SDK rejection receipts; infrastructure ambiguity remains recoverable.
- Accepted receipts are published only after exact lifecycle readback and an active exact-head evaluator-leg review claim.
- Existing v2 `prepared` and `submitted` marketplace attempts must remain recoverable through an exact v3 migration.
- Follow strict TDD: write one behavioral test, run it and record the expected failure, add minimal production code, run it green, then refactor.
- Within every table or suite described below, implement the named cases as individual RED → minimal GREEN microcycles. The aggregate test commands are checkpoints after those microcycles, not permission to write a whole suite before production code.
- Before changing tests, read the `superpowers:test-driven-development/writing-good-tests.md` reference and name the production break each test catches.

---

## File Structure

### New production files

- `src/lifecycle/marketplace-execution-state.ts` — strict v3 execution-state types, codecs, and pure identity comparison.
- `src/lifecycle/marketplace-adoption-state.ts` — dedicated atomic migration and monotonic manifest transitions.
- `src/lifecycle/marketplace-cli.ts` — shared installed-binary resolution, sanitized environment, subprocess, and machine failure-envelope parsing.
- `src/lifecycle/marketplace-delivery.ts` — strict expectation persistence, CLI observation, wrapper parsing, and immutable observation persistence.
- `src/lifecycle/marketplace-patch.ts` — raw patch policy, index/filesystem checks, check-before-apply, and immutable artifact identity.
- `src/lifecycle/marketplace-mutation-git.ts` — expected-tree calculation, correlation-bound host commits, and crash reconstruction.
- `src/lifecycle/marketplace-mutation-verification.ts` — pure `jinn-mono.v1` workspace closure and ordered command plan.
- `src/lifecycle/marketplace-mutation-verification-production.ts` — bounded Docker implementation of the verification port.
- `src/lifecycle/marketplace-adoption-receipt.ts` — exact authorized receipt lookup, publication, readback, and contradiction handling.
- `src/lifecycle/marketplace-review-anchor.ts` — claim-only exact-head review acquisition/recovery and evaluator-leg linking.
- `src/lifecycle/marketplace-mutation-adoption.ts` — port-driven mutation-adoption state machine.
- `src/lifecycle/marketplace-mutation-adoption-production.ts` — current standalone authority, lifecycle, review, GitHub, and credential adapters.

### Existing production files to modify

- `src/lifecycle/attempt-workspace.ts` — decode v3 execution state, create v3 marketplace attempts, and preserve existing cleanup/accounting.
- `src/lifecycle/marketplace-task.ts` — consume the shared CLI adapter without changing submission behavior.
- `src/lifecycle/session-execution-backend.ts` — accept v2/v3 submission states and keep start/recover/cancel behavior compatible.
- `src/lifecycle/review-executor.ts` — separate deterministic claim acquisition from local session dispatch.
- `src/lifecycle/review-executor-production.ts` — create evaluator-leg marketplace review attempts without preparing another Task.
- `src/lifecycle/active-runtime-production.ts` — construct production adoption ports and preserve unavailable standalone review scheduling.
- `src/lifecycle/controller.ts` — run submitted-attempt adoption recovery in the existing pre-snapshot recovery phase.
- `scripts/run-autopilot-v2.ts` — wire production recovery/preflight options without adding public configuration.

### New focused tests

- `test/lifecycle/marketplace-execution-state.test.ts`
- `test/lifecycle/marketplace-adoption-state.test.ts`
- `test/lifecycle/marketplace-cli.test.ts`
- `test/lifecycle/marketplace-delivery.test.ts`
- `test/lifecycle/marketplace-patch.test.ts`
- `test/lifecycle/marketplace-mutation-git.test.ts`
- `test/lifecycle/marketplace-mutation-verification.test.ts`
- `test/lifecycle/marketplace-mutation-verification-production.test.ts`
- `test/lifecycle/marketplace-adoption-receipt.test.ts`
- `test/lifecycle/marketplace-review-anchor.test.ts`
- `test/lifecycle/marketplace-mutation-adoption.test.ts`
- `test/lifecycle/marketplace-mutation-adoption-production.test.ts`
- `test/lifecycle/marketplace-solution-recovery.test.ts`
- `test/lifecycle/marketplace-solution-vertical.test.ts`

### Existing tests to extend

- `test/lifecycle/attempt-workspace.test.ts`
- `test/lifecycle/session-execution-backend.test.ts`
- `test/lifecycle/review-executor.test.ts`
- `test/lifecycle/review-executor-production.test.ts`
- `test/lifecycle/active-runtime-production.test.ts`
- `test/lifecycle/controller.test.ts`
- `test/run-autopilot-v2-entrypoint.test.ts`

---

### Plan checkpoint before Task 1

Commit this reviewed plan as its own documentation checkpoint before any
production or test edit:

```bash
git add docs/superpowers/plans/2026-07-27-marketplace-solution-adoption.md
git commit -m "docs: plan marketplace solution adoption"
```

The implementation ledger starts at the resulting commit. The design and plan
commits are not counted among the ten implementation-task commits below.

### Task 1: Strict marketplace execution v3 and monotonic manifest transitions

**Files:**
- Create: `src/lifecycle/marketplace-execution-state.ts`
- Create: `src/lifecycle/marketplace-adoption-state.ts`
- Modify: `src/lifecycle/attempt-workspace.ts`
- Modify: `src/lifecycle/session-execution-backend.ts`
- Test: `test/lifecycle/marketplace-execution-state.test.ts`
- Test: `test/lifecycle/marketplace-adoption-state.test.ts`
- Modify test: `test/lifecycle/attempt-workspace.test.ts`
- Modify test: `test/lifecycle/session-execution-backend.test.ts`

**Interfaces:**
- Consumes: existing `MarketplacePreparedExecutionFields`, `TaskSubmitResultV1`, `AttemptManifest`, atomic manifest writer, immutable request digest, and terminal/dispatch journal rules.
- Produces:

```ts
export const MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION =
  'marketplace-execution-v3' as const;

export type MarketplaceExecutionV3Status =
  | 'prepared'
  | 'submitted'
  | 'solution-observed'
  | 'solution-verified'
  | 'host-committed'
  | 'lifecycle-completed'
  | 'review-anchored'
  | 'receipt-published'
  | 'cancelled';

export interface MarketplaceSolutionDeliveryEvidence {
  readonly observationPath: string;
  readonly observationDigest: string;
  readonly taskId: string;
  readonly taskCid: string;
  readonly taskCreationTransaction: string;
  readonly taskCreationBlock: number;
  readonly solverNetManifestCid: string;
  readonly attemptIndex: number;
  readonly requestId: string;
  readonly deliveryEnvelopeCid: string;
  readonly deliveryEnvelopeDigest: string;
  readonly deliveryTransaction: string;
  readonly deliveryBlock: number;
  readonly solverSafe: string;
  readonly solverAgentEoa: string;
  readonly signer: string;
  readonly publisherAgentId: string;
  readonly correlation: AutopilotCorrelation;
  readonly observedAt: string;
}

export interface MarketplaceArtifactEvidence {
  readonly digest: string;
  readonly byteLength: number;
  readonly touchedPaths: readonly string[];
  readonly expectedTree: GitOid;
}

export interface MarketplaceVerificationEvidence {
  readonly profile: 'jinn-mono.v1';
  readonly artifactDigest: string;
  readonly expectedTree: GitOid;
  readonly planDigest: string;
  readonly commands: readonly {
    readonly label: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly cwdRelative: string;
    readonly status: 'passed';
    readonly exitCode: 0;
    readonly stdoutDigest: string;
    readonly stderrDigest: string;
    readonly startedAt: string;
    readonly completedAt: string;
  }[];
  readonly verifiedAt: string;
}

export interface MarketplaceHostCommitEvidence {
  readonly head: GitOid;
  readonly tree: GitOid;
  readonly parents: readonly GitOid[];
  readonly artifactDigest: string;
  readonly correlationDigest: string;
  readonly trailers: {
    readonly taskId: string;
    readonly requestId: string;
    readonly deliveryEnvelopeCid: string;
    readonly v2AttemptId: string;
    readonly artifactDigest: string;
    readonly childIssueNumber?: number;
  };
  readonly createdAt: string;
}

export type MarketplaceCompletionEvidence =
  | {
      readonly operation: 'implementation-complete';
      readonly prNumber: number;
      readonly branch: string;
      readonly claimOid: GitOid;
      readonly checkpointOid: GitOid;
      readonly resultingHead: GitOid;
      readonly lifecycleStatus: 'In Review';
      readonly confirmedAt: string;
    }
  | {
      readonly operation: 'child-complete';
      readonly childIssueNumber: number;
      readonly parentPrNumber: number;
      readonly parentBranch: string;
      readonly claimOid: GitOid;
      readonly checkpointOid: GitOid;
      readonly resultingHead: GitOid;
      readonly childClosed: true;
      readonly lifecycleStatus: 'In Review';
      readonly confirmedAt: string;
    };

export interface MarketplaceReviewAnchorEvidence {
  readonly attemptId: string;
  readonly manifestPath: string;
  readonly head: GitOid;
  readonly generation: string;
  readonly refOid: GitOid;
  readonly reviewer: string;
  readonly anchoredAt: string;
}

export interface MarketplaceReceiptEvidence {
  readonly receipt: AutopilotAdoptionReceipt;
  readonly commentId: number;
  readonly author: string;
  readonly recordedAt: string;
}

interface MarketplaceExecutionV3Base {
  readonly schemaVersion: typeof MARKETPLACE_EXECUTION_V3_SCHEMA_VERSION;
  readonly requestPath: string;
  readonly requestDigest: string;
  readonly solverNetSelectionPath: string;
  readonly preparedAt: string;
  readonly agentSoftDeadline: string;
  readonly adoptionDeadline: string;
}

type MarketplaceSubmittedV3 = MarketplaceExecutionV3Base & {
  readonly submission: TaskSubmitResultV1;
  readonly submittedAt: string;
};

export const MARKETPLACE_EVALUATOR_LEG_SCHEMA_VERSION =
  'marketplace-evaluator-leg-v1' as const;

export interface MarketplaceEvaluatorLegIdentity {
  readonly originManifestPath: string;
  readonly originV2AttemptId: string;
  readonly originRequestDigest: string;
  readonly taskId: string;
  readonly taskCid: string;
  readonly taskCreationBlock: number;
  readonly prNumber: number;
  readonly expectedHead: GitOid;
  readonly generation: string;
  readonly reviewRefOid: GitOid;
  readonly reviewer: string;
}

export type MarketplaceEvaluatorLegExecutionState =
  | (MarketplaceEvaluatorLegIdentity & {
      readonly schemaVersion:
        typeof MARKETPLACE_EVALUATOR_LEG_SCHEMA_VERSION;
      readonly status: 'anchored';
      readonly anchoredAt: string;
    })
  | (MarketplaceEvaluatorLegIdentity & {
      readonly schemaVersion:
        typeof MARKETPLACE_EVALUATOR_LEG_SCHEMA_VERSION;
      readonly status: 'released';
      readonly anchoredAt: string;
      readonly releasedAt: string;
      readonly releaseReason: string;
    });

export type MarketplaceAdoptionProgress =
  | { readonly status: 'solution-observed'; readonly delivery: MarketplaceSolutionDeliveryEvidence }
  | { readonly status: 'solution-verified'; readonly delivery: MarketplaceSolutionDeliveryEvidence; readonly artifact: MarketplaceArtifactEvidence; readonly verification: MarketplaceVerificationEvidence }
  | { readonly status: 'host-committed'; readonly delivery: MarketplaceSolutionDeliveryEvidence; readonly artifact: MarketplaceArtifactEvidence; readonly verification: MarketplaceVerificationEvidence; readonly hostCommit: MarketplaceHostCommitEvidence }
  | { readonly status: 'lifecycle-completed'; readonly delivery: MarketplaceSolutionDeliveryEvidence; readonly artifact: MarketplaceArtifactEvidence; readonly verification: MarketplaceVerificationEvidence; readonly hostCommit: MarketplaceHostCommitEvidence; readonly completion: MarketplaceCompletionEvidence }
  | { readonly status: 'review-anchored'; readonly delivery: MarketplaceSolutionDeliveryEvidence; readonly artifact: MarketplaceArtifactEvidence; readonly verification: MarketplaceVerificationEvidence; readonly hostCommit: MarketplaceHostCommitEvidence; readonly completion: MarketplaceCompletionEvidence; readonly reviewAnchor: MarketplaceReviewAnchorEvidence };

export type MarketplaceExecutionV3State =
  | (MarketplaceExecutionV3Base & { readonly status: 'prepared' })
  | (MarketplaceSubmittedV3 & { readonly status: 'submitted' })
  | (MarketplaceSubmittedV3 & MarketplaceAdoptionProgress)
  | (MarketplaceSubmittedV3 & {
      readonly status: 'receipt-published';
      readonly progress: MarketplaceAdoptionProgress;
      readonly receipt: MarketplaceReceiptEvidence;
    })
  | (MarketplaceExecutionV3Base & {
      readonly status: 'cancelled';
      readonly cancelledAt: string;
      readonly reason: string;
    });

export type StrictMarketplaceAttemptExecutionState =
  | MarketplaceExecutionV3State
  | MarketplaceEvaluatorLegExecutionState;

export type MarketplaceAdoptionTransition =
  | { readonly status: 'solution-observed'; readonly delivery: MarketplaceSolutionDeliveryEvidence }
  | { readonly status: 'solution-verified'; readonly artifact: MarketplaceArtifactEvidence; readonly verification: MarketplaceVerificationEvidence }
  | { readonly status: 'host-committed'; readonly hostCommit: MarketplaceHostCommitEvidence }
  | { readonly status: 'lifecycle-completed'; readonly completion: MarketplaceCompletionEvidence }
  | { readonly status: 'review-anchored'; readonly reviewAnchor: MarketplaceReviewAnchorEvidence }
  | { readonly status: 'receipt-published'; readonly receipt: MarketplaceReceiptEvidence };

export type MarketplaceEvaluatorLegTransition = {
  readonly status: 'released';
  readonly releaseReason: string;
};

export function upgradeMarketplaceExecutionV2(
  manifestPath: string,
  expectedRequestDigest: string,
  now?: () => Date,
): AttemptManifest;

export function transitionMarketplaceAdoption(
  manifestPath: string,
  expectedRequestDigest: string,
  transition: MarketplaceAdoptionTransition,
  now?: () => Date,
): AttemptManifest;

export function installMarketplaceEvaluatorLeg(
  manifestPath: string,
  identity: MarketplaceEvaluatorLegIdentity,
  now?: () => Date,
): AttemptManifest;

export function transitionMarketplaceEvaluatorLeg(
  manifestPath: string,
  expected: MarketplaceEvaluatorLegIdentity,
  transition: MarketplaceEvaluatorLegTransition,
  now?: () => Date,
): AttemptManifest;
```

- State evidence types use exact SDK-compatible strings/numbers, SHA-256 strings shaped as `sha256:<64 lowercase hex>`, absolute attempt-contained paths, safe JSON block numbers, and strict exact-key decoders.

- [ ] **Step 1: Write failing pure-codec tests**

Create literal v3 and evaluator-leg fixtures and test every valid status,
unknown/extra keys, incomplete evidence, unsafe paths, mismatched prior
identity, unsafe block numbers, accepted/rejected receipt consistency, immutable
origin linkage, and the sole legal evaluator transition `anchored → released`:

```ts
it.each([
  ['unknown status', { ...submitted, status: 'other' }],
  ['extra key', { ...submitted, extra: true }],
  ['unsafe observation path', observed({ observationPath: '../result.json' })],
  ['bad digest', observed({ observationDigest: 'sha256:nope' })],
  ['partial delivery', observed({ delivery: { taskId: '501' } })],
])('rejects %s', (_name, value) => {
  expect(() => decodeMarketplaceExecutionV3State(value, ATTEMPT_DIR))
    .toThrow();
});
```

Name the break before each table: loosening strict decoding, accepting escaped paths, accepting unsafe JSON numbers, or accepting incomplete correlation.

- [ ] **Step 2: Run codec tests and witness RED**

Run:

```bash
yarn test test/lifecycle/marketplace-execution-state.test.ts
```

Expected: FAIL because `marketplace-execution-state.ts` and its decoder do not exist.

- [ ] **Step 3: Implement the minimal strict v3 codecs**

Implement exact discriminated variants. Factor repeated prepared/submission/delivery identity through TypeScript intersections, but decode every variant with an explicit allowed-key set. Do not introduce optional milestone bags.

- [ ] **Step 4: Run codec tests GREEN**

Run the same focused command. Expected: all codec cases pass with pristine output.

- [ ] **Step 5: Write failing transition and migration tests**

Test v2 prepared/submitted migration, byte-identical idempotence, stale prior-state rejection, contradictory evidence rejection, monotonic timestamps, v2 cancelled preservation, evaluator-leg install/release idempotence, forbidden evaluator submission/cancellation transitions, and prohibition through the generic manifest updater:

```ts
it('upgrades an exact submitted v2 attempt once', () => {
  const first = upgradeMarketplaceExecutionV2(path, REQUEST_DIGEST, now);
  const second = upgradeMarketplaceExecutionV2(path, REQUEST_DIGEST, later);
  expect(first.execution).toEqual(second.execution);
  expect(marketplaceStatus(second)).toBe('submitted');
});

it('rejects a second delivery identity', () => {
  transitionMarketplaceAdoption(path, REQUEST_DIGEST, observedA, now);
  expect(() =>
    transitionMarketplaceAdoption(path, REQUEST_DIGEST, observedB, later)
  ).toThrow(/different marketplace Solution delivery/i);
});
```

- [ ] **Step 6: Run transition tests and witness RED**

Run:

```bash
yarn test test/lifecycle/marketplace-adoption-state.test.ts \
  test/lifecycle/attempt-workspace.test.ts \
  test/lifecycle/session-execution-backend.test.ts
```

Expected: FAIL because v3 creation/migration/transitions are absent.

- [ ] **Step 7: Implement atomic v3 creation, migration, and transitions**

Use the existing atomic manifest install and dedicated marketplace journal conventions. New marketplace attempts write v3. Submission backend start/recover/cancel accepts v2 or v3 at equivalent prepared/submitted/cancelled stages; v2 adoption recovery upgrades before progressing.

- [ ] **Step 8: Run Task 1 tests GREEN**

Run the Step 6 command. Expected: all focused tests pass and existing submission behavior remains unchanged.

- [ ] **Step 9: Commit**

```bash
git add src/lifecycle/marketplace-execution-state.ts \
  src/lifecycle/marketplace-adoption-state.ts \
  src/lifecycle/attempt-workspace.ts \
  src/lifecycle/session-execution-backend.ts \
  test/lifecycle/marketplace-execution-state.test.ts \
  test/lifecycle/marketplace-adoption-state.test.ts \
  test/lifecycle/attempt-workspace.test.ts \
  test/lifecycle/session-execution-backend.test.ts
git commit -m "feat: add marketplace adoption execution state"
```

### Task 2: Shared marketplace CLI boundary and authenticated Solution observation

**Files:**
- Create: `src/lifecycle/marketplace-cli.ts`
- Create: `src/lifecycle/marketplace-delivery.ts`
- Modify: `src/lifecycle/marketplace-task.ts`
- Test: `test/lifecycle/marketplace-cli.test.ts`
- Test: `test/lifecycle/marketplace-delivery.test.ts`
- Modify test: `test/lifecycle/marketplace-task.test.ts`

**Interfaces:**
- Consumes: Task 1 v3 states/transitions; released SDK schemas; existing request path/digest/submission; installed client binary.
- Produces:

```ts
export interface MarketplaceMachineSubprocessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type MarketplaceMachineSubprocess = (
  command: string,
  args: readonly string[],
  options: { readonly environment: NodeJS.ProcessEnv },
) => Promise<MarketplaceMachineSubprocessResult>;

export function resolveInstalledJinnBinary(): string;
export function marketplaceMachineEnvironment(
  ambient: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;

export interface MarketplaceDeliveryOptions {
  readonly jinnBinary?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly run?: MarketplaceMachineSubprocess;
  readonly now?: () => Date;
}

export type VerifiedSolutionObservation = Extract<
  AutopilotDeliveryObservation,
  { readonly status: 'verified'; readonly role: 'solution' }
>;

export type MarketplaceSolutionObservation =
  | { readonly status: 'pending'; readonly reason: AutopilotDeliveryPendingReason; readonly detail?: string }
  | { readonly status: 'contradiction'; readonly reason: AutopilotDeliveryContradictionReason; readonly detail: string }
  | { readonly status: 'verified'; readonly observation: VerifiedSolutionObservation; readonly observationPath: string; readonly observationDigest: string };

export async function observeMarketplaceSolutionDelivery(
  manifestPath: string,
  options?: MarketplaceDeliveryOptions,
): Promise<MarketplaceSolutionObservation>;
```

- [ ] **Step 1: Write failing shared-CLI tests**

Test installed binary resolution, removal of GitHub secret-shaped keys and `GH_CONFIG_DIR`, preservation of marketplace config/RPC keys, `NO_COLOR=1`, exact exit-code failure-envelope parsing, malformed output rejection, and unchanged Task submission arguments.

- [ ] **Step 2: Run shared-CLI tests and witness RED**

Run:

```bash
yarn test test/lifecycle/marketplace-cli.test.ts \
  test/lifecycle/marketplace-task.test.ts
```

Expected: FAIL because the shared CLI module does not exist.

- [ ] **Step 3: Extract the existing submission machine boundary**

Move installed-binary resolution, subprocess execution, sanitized environment, and failure-envelope parsing without changing `MarketplaceTaskCliAdapter` behavior. Keep submit result parsing in `marketplace-task.ts`.

- [ ] **Step 4: Run shared-CLI tests GREEN**

Run the Step 2 command. Expected: all tests pass.

- [ ] **Step 5: Write failing delivery-observation tests**

Use literal SDK fixtures and a real temporary attempt directory. Assert:

```ts
expect(run).toHaveBeenCalledWith(jinnBinary, [
  'tasks',
  'observe-autopilot-delivery',
  '--expectation-file',
  join(attemptDir, 'marketplace-solution-expectation.json'),
  '--json',
], expect.anything());
```

Also assert:

- expectation mode is `0600`;
- outer/inner session, Task, creation block, and optional pinned fields agree;
- malformed wrapper never mutates manifest/worktree;
- `pending` leaves state unchanged;
- `contradiction` leaves state unchanged and returns the exact typed reason;
- `verified` writes one canonical `0600` observation file, records its digest, and transitions once;
- a retry pins attempt/request/envelope/delivery fields and reuses exact evidence;
- a second identity is rejected;
- GitHub credentials never reach the subprocess.

- [ ] **Step 6: Run observation tests and witness RED**

Run:

```bash
yarn test test/lifecycle/marketplace-delivery.test.ts
```

Expected: FAIL because observation behavior is absent.

- [ ] **Step 7: Implement observation and immutable persistence**

Parse only `AutopilotDeliveryCommandResultV1Schema`. For verified observations require `role === 'solution'` and compare every Task/session/submission field against the manifest/request before installing the canonical observation. Use Task 1's transition API after file fsync/install.

- [ ] **Step 8: Run Task 2 tests GREEN**

Run:

```bash
yarn test test/lifecycle/marketplace-cli.test.ts \
  test/lifecycle/marketplace-delivery.test.ts \
  test/lifecycle/marketplace-task.test.ts
```

Expected: all pass with pristine output.

- [ ] **Step 9: Commit**

```bash
git add src/lifecycle/marketplace-cli.ts \
  src/lifecycle/marketplace-delivery.ts \
  src/lifecycle/marketplace-task.ts \
  test/lifecycle/marketplace-cli.test.ts \
  test/lifecycle/marketplace-delivery.test.ts \
  test/lifecycle/marketplace-task.test.ts
git commit -m "feat: observe exact marketplace solutions"
```

### Task 3: Strict patch policy and safe worktree application

**Files:**
- Create: `src/lifecycle/marketplace-patch.ts`
- Test: `test/lifecycle/marketplace-patch.test.ts`

**Interfaces:**
- Consumes: raw `Uint8Array` from the persisted SDK mutation result; exact registered attempt manifest/worktree/start head.
- Produces:

```ts
export const MAX_MARKETPLACE_PATCH_BYTES = 2 * 1024 * 1024;

export interface ValidatedMarketplacePatch {
  readonly artifact: Uint8Array;
  readonly artifactDigest: string;
  readonly byteLength: number;
  readonly touchedPaths: readonly string[];
}

export function validateMarketplacePatch(
  artifact: Uint8Array,
): ValidatedMarketplacePatch;

export type MarketplacePatchGitRunner = (
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly stdin?: Uint8Array;
    readonly timeoutMs: number;
    readonly outputLimitBytes: number;
  },
) => Promise<Uint8Array>;

export type MarketplacePatchLstat = (
  path: string,
) => Promise<'missing' | 'regular-file' | 'directory' | 'symlink' | 'other'>;

export interface MarketplaceAttemptWorktreeProof {
  readonly manifestPath: string;
  readonly registeredWorktreePath: string;
  readonly expectedHead: GitOid;
  readonly currentHead: GitOid;
  readonly indexClean: true;
  readonly worktreeClean: true;
  readonly untrackedPaths: readonly [];
}

export interface MarketplaceAttemptWorktreeProofPort {
  prove(input: {
    readonly manifestPath: string;
    readonly worktreePath: string;
    readonly expectedHead: GitOid;
  }): Promise<MarketplaceAttemptWorktreeProof>;
}

export interface MarketplacePatchApplicationPorts {
  readonly runGit?: MarketplacePatchGitRunner;
  readonly lstat?: MarketplacePatchLstat;
  readonly worktreeProof: MarketplaceAttemptWorktreeProofPort;
}

export async function applyMarketplacePatchToWorktree(input: {
  readonly artifact: Uint8Array;
  readonly manifestPath: string;
  readonly worktreePath: string;
  readonly expectedHead: GitOid;
}, ports: MarketplacePatchApplicationPorts): Promise<ValidatedMarketplacePatch>;
```

- [ ] **Step 1: Write failing pure validation tables**

Create literal byte fixtures for:

- one byte below, exactly at, and one byte above 2 MiB;
- multibyte UTF-8 byte counting;
- invalid UTF-8 and NUL;
- `GIT binary patch`, `Binary files`, and combined diff;
- ordinary add/delete/rename/copy/mode-only patches;
- quoted and escaped header paths;
- POSIX absolute, `C:\`, `C:/`, UNC, slash/backslash traversal;
- `.git` and case variants on every diff/header/rename/copy surface;
- empty/dot segments, control characters, non-NFC paths;
- `120000` and `160000` in old/new/index mode positions;
- package manifests/locks, Yarn/PnP/node_modules, tsconfig/test config, tests, and snapshots.

Every rejection asserts its typed reason and that no Git runner was called.

- [ ] **Step 2: Run pure patch tests and witness RED**

Run:

```bash
yarn test test/lifecycle/marketplace-patch.test.ts
```

Expected: FAIL because validator is absent.

- [ ] **Step 3: Implement minimal pure parser**

Parse all path and mode surfaces from immutable bytes, produce sorted unique touched paths, calculate `sha256:<hex>`, and return an artifact copy that cannot be changed by mutating the caller's buffer.

- [ ] **Step 4: Run pure tests GREEN**

Run the focused command. Expected: pure table passes.

- [ ] **Step 5: Write failing real-worktree safety tests**

Create temporary real Git repositories covering:

- manifest/worktree registry mismatch and an unregistered worktree;
- wrong current `HEAD`, dirty index, tracked worktree modification, and
  untracked path;
- untracked symlink target and symlink ancestor;
- tracked `120000` path/ancestor;
- tracked `160000` gitlink path/ancestor;
- regular files/directories;
- failed `git apply --check`;
- successful check then apply through stdin;
- runner timeout and output cap;
- no `--3way`;
- no mutation when checking fails;
- immutable artifact after the original buffer is modified.

- [ ] **Step 6: Run safety tests and witness RED**

Run the focused file. Expected: new worktree cases fail until index/lstat/check/apply behavior exists.

- [ ] **Step 7: Implement authority, index/filesystem proof, and apply**

First prove the manifest owns the exact registered worktree, `HEAD` equals the
attempt start head, and index/worktree/untracked sets are pristine. Then use
`git --literal-pathspecs ls-files --stage -z`, non-following `lstat`, bounded
subprocess execution, stdin, `git apply --check`, then plain `git apply`. Do
not write a patch file. Every authority rejection occurs before patch checking
or application.

- [ ] **Step 8: Run Task 3 GREEN**

Run the focused file. Expected: all validation and real-Git cases pass.

- [ ] **Step 9: Commit**

```bash
git add src/lifecycle/marketplace-patch.ts \
  test/lifecycle/marketplace-patch.test.ts
git commit -m "feat: validate marketplace mutation patches"
```

### Task 4: Exact delivered-tree calculation, host commit, and crash reconstruction

**Files:**
- Create: `src/lifecycle/marketplace-mutation-git.ts`
- Test: `test/lifecycle/marketplace-mutation-git.test.ts`

**Interfaces:**
- Consumes: Task 3 validated patch, exact expected head, workflow and correlation, child identity, optional reconcile target.
- Produces:

```ts
export interface MarketplaceMutationCommitIdentity {
  readonly worktreePath: string;
  readonly expectedHead: GitOid;
  readonly artifact: Uint8Array;
  readonly artifactDigest: string;
  readonly workflow: 'implement' | 'fix-child' | 'reconcile' | 'ci-failure';
  readonly touchedPaths: readonly string[];
  readonly summary: string;
  readonly taskId: string;
  readonly requestId: string;
  readonly deliveryEnvelopeCid: string;
  readonly v2AttemptId: string;
  readonly childIssueNumber?: number;
  readonly reconcileBase?: GitOid;
}

export type MarketplaceMutationGitState =
  | { readonly status: 'clean'; readonly expectedTree: GitOid }
  | { readonly status: 'pending'; readonly expectedTree: GitOid }
  | { readonly status: 'committed'; readonly expectedTree: GitOid; readonly commit: MarketplaceHostCommitEvidence }
  | { readonly status: 'contradiction'; readonly detail: string };

export interface MarketplaceMutationGitPort {
  readState(identity: MarketplaceMutationCommitIdentity): Promise<MarketplaceMutationGitState>;
  commit(identity: MarketplaceMutationCommitIdentity): Promise<MarketplaceHostCommitEvidence>;
}
```

- [ ] **Step 1: Write failing real-Git reconstruction tests**

Test:

- pristine clean state;
- exact applied pending tree;
- one deterministic host commit and retry reconstruction;
- no-op patch rejection;
- unrelated changed path;
- same touched paths but wrong content/tree;
- arbitrary local commit;
- wrong parent count/order;
- wrong/missing/duplicate correlation trailers;
- implementation completion-marker descendant recovery;
- child trailer `Jinn-Autopilot-Issue: <n>`;
- current reconcile merge-parent topology.

- [ ] **Step 2: Run tests and witness RED**

Run:

```bash
yarn test test/lifecycle/marketplace-mutation-git.test.ts
```

Expected: FAIL because the Git port is absent.

- [ ] **Step 3: Implement expected tree and reconstruction**

Use a temporary index to apply the artifact to `expectedHead`, write the expected tree, compare exact status/path/tree, and parse strict commit trailers. Do not update the real index during expected-tree calculation.

- [ ] **Step 4: Run reconstruction tests GREEN**

Run focused tests. Expected: clean/pending/contradiction cases pass.

- [ ] **Step 5: Write failing commit/retry tests**

Assert the created commit has the exact tree/parents, the persisted
`correlationDigest`, and one copy of each literal trailer:

```text
Jinn-Marketplace-Task: <taskId>
Jinn-Marketplace-Request: <requestId>
Jinn-Marketplace-Envelope: <deliveryEnvelopeCid>
Jinn-Autopilot-Attempt: <v2AttemptId>
Jinn-Marketplace-Artifact: <artifactDigest>
Jinn-Autopilot-Issue: <childIssueNumber>   # child workflows only
```

- [ ] **Step 6: Implement minimal commit creation**

Create the commit only from exact pending state, update `HEAD` with an
expected-old CAS, and return head/tree/parents, the canonical correlation
digest, and the complete parsed trailer identity. A retry returns the existing
exact commit only when every durable field agrees.

- [ ] **Step 7: Run Task 4 GREEN**

Run the focused file. Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/lifecycle/marketplace-mutation-git.ts \
  test/lifecycle/marketplace-mutation-git.test.ts
git commit -m "feat: reconstruct marketplace host commits"
```

### Task 5: `jinn-mono.v1` deterministic verification

**Files:**
- Create: `src/lifecycle/marketplace-mutation-verification.ts`
- Create: `src/lifecycle/marketplace-mutation-verification-production.ts`
- Test: `test/lifecycle/marketplace-mutation-verification.test.ts`
- Test: `test/lifecycle/marketplace-mutation-verification-production.test.ts`

**Interfaces:**
- Consumes: touched paths, exact worktree, adoption deadline.
- Produces:

```ts
export interface MarketplaceVerificationCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly label: string;
}

export type JinnMonoWorkspace =
  | 'apps/broadcast-bot'
  | 'client'
  | 'contracts'
  | 'packages/autopilot'
  | 'packages/core'
  | 'packages/indexer'
  | 'packages/indexer-enrichment'
  | 'packages/layer'
  | 'packages/plugin'
  | 'packages/sdk';

export interface MarketplaceVerificationPlan {
  readonly profile: 'jinn-mono.v1';
  readonly workspaces: readonly JinnMonoWorkspace[];
  readonly commands: readonly MarketplaceVerificationCommand[];
}

export function buildJinnMonoV1VerificationPlan(input: {
  readonly repositoryPath: string;
  readonly touchedPaths: readonly string[];
}): MarketplaceVerificationPlan;

export interface MarketplaceMutationVerificationPort {
  preflight(): Promise<{ readonly ok: boolean; readonly detail?: string }>;
  verify(input: {
    readonly profile: 'jinn-mono.v1';
    readonly repositoryPath: string;
    readonly touchedPaths: readonly string[];
    readonly artifactDigest: string;
    readonly expectedTree: GitOid;
    readonly deadline: string;
  }): Promise<MarketplaceVerificationEvidence>;
}
```

- [ ] **Step 1: Write failing workspace-policy tests**

Use literal expected workspace arrays for every supported root:
`packages/plugin`, `packages/core`, `packages/sdk`, `packages/indexer`,
`packages/indexer-enrichment`, `packages/layer`, `client`, `contracts`,
`packages/autopilot`, and `apps/broadcast-bot`.

Test normalized paths, unsupported roots, stable workspace order, dependency
closure, install/typecheck-or-compile/test ordering, stop-on-first-failure, and
a stable digest over exact command, argument, relative-CWD, and workspace
selection.

- [ ] **Step 2: Run policy tests and witness RED**

Run:

```bash
yarn test test/lifecycle/marketplace-mutation-verification.test.ts
```

Expected: FAIL because the plan builder is absent.

- [ ] **Step 3: Implement pure plan and sequential port**

Use literal workspace policy, `corepack yarn install --immutable`, workspace
typecheck/compile command, then `corepack yarn test`. Return typed evidence
bound to profile, artifact digest, expected tree, plan digest, exact
command/arguments/relative CWD, timestamps, exit code, and bounded
stdout/stderr digests. This complete evidence—not labels alone—is the
idempotent reuse key.

- [ ] **Step 4: Run policy tests GREEN**

Run focused file. Expected: all pass.

- [ ] **Step 5: Write failing production sandbox tests**

With an injected Docker runner, assert:

- pinned Node 22 image digest;
- read-only source and disposable writable workspace;
- no GitHub/client wallet/RPC secrets in environment;
- scripts disabled and lockfile immutable;
- dependency bootstrap precedes network disconnect;
- typecheck/tests execute after network disconnect;
- CPU/memory/PID/read-only/no-new-privileges bounds;
- per-command/total/output limits;
- deadline-before-start rejection;
- SIGTERM/SIGKILL cleanup;
- cleanup ambiguity returns fail-closed unsafe result;
- preflight checks Docker and pinned image without GitHub mutation.

- [ ] **Step 6: Run production tests and witness RED**

Run:

```bash
yarn test test/lifecycle/marketplace-mutation-verification-production.test.ts
```

Expected: FAIL because production sandbox is absent.

- [ ] **Step 7: Implement bounded Docker verification**

Separate public-registry immutable installation from network-disabled verification. Sanitize environment with an explicit allowlist. Cap retained output and reap the process group/container on every exit.

- [ ] **Step 8: Run Task 5 GREEN**

Run both Task 5 files. Expected: all pass with no warnings.

- [ ] **Step 9: Commit**

```bash
git add src/lifecycle/marketplace-mutation-verification.ts \
  src/lifecycle/marketplace-mutation-verification-production.ts \
  test/lifecycle/marketplace-mutation-verification.test.ts \
  test/lifecycle/marketplace-mutation-verification-production.test.ts
git commit -m "feat: verify adopted marketplace mutations"
```

### Task 6: Authenticated adoption receipt publication and recovery

**Files:**
- Create: `src/lifecycle/marketplace-adoption-receipt.ts`
- Test: `test/lifecycle/marketplace-adoption-receipt.test.ts`

**Interfaces:**
- Consumes: SDK receipt codecs/formatter, exact PR facts, persisted author allowlist, Task 1 receipt transition.
- Produces:

```ts
export interface AdoptionReceiptComment {
  readonly id: number;
  readonly authorLogin: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AdoptionReceiptLookup =
  | { readonly status: 'missing' }
  | { readonly status: 'exact'; readonly comment: AdoptionReceiptComment; readonly receipt: AutopilotAdoptionReceipt }
  | { readonly status: 'contradiction'; readonly detail: string };

interface AdoptionReceiptBaseFacts {
  readonly role: 'solution';
  readonly correlation: AutopilotCorrelation;
  readonly prNumber: number;
  readonly publicationHead: GitOid;
  readonly receiptAuthors: readonly string[];
}

export type AdoptionReceiptExactFacts =
  | (AdoptionReceiptBaseFacts & {
      readonly disposition: 'accepted';
      readonly resultingHead: GitOid;
      readonly expectedReview: {
        readonly generation: string;
        readonly refOid: GitOid;
      };
    })
  | (AdoptionReceiptBaseFacts & {
      readonly disposition: 'rejected';
      readonly reason: AutopilotAdoptionRejectionReason;
    });

export interface AdoptionReceiptPorts {
  listPrIssueComments(input: {
    readonly prNumber: number;
    readonly cursor?: string;
  }): Promise<{
    readonly comments: readonly AdoptionReceiptComment[];
    readonly nextCursor?: string;
  }>;
  readCurrentPrHead(prNumber: number): Promise<GitOid>;
  verifyReceiptFacts(input: {
    readonly expected: AdoptionReceiptExactFacts;
    readonly receipt: AutopilotAdoptionReceipt;
  }): Promise<boolean>;
  createPrComment(input: {
    readonly prNumber: number;
    readonly expectedHead: GitOid;
    readonly body: string;
  }): Promise<{ readonly commentId: number; readonly author: string }>;
}

export async function readAdoptionReceiptState(
  expected: AdoptionReceiptExactFacts,
  ports: AdoptionReceiptPorts,
): Promise<AdoptionReceiptLookup>;

export async function publishAdoptionReceipt(
  expected: AdoptionReceiptExactFacts,
  receipt: AutopilotAdoptionReceipt,
  ports: AdoptionReceiptPorts,
): Promise<{ readonly status: 'published' | 'already-published'; readonly commentId: number; readonly author: string }>;
```

- [ ] **Step 1: Write failing receipt lookup tests**

Test pagination, case-insensitive authorized login matching, forged author,
unrelated canonical receipts, exact duplicate comments, accepted/rejected
contradiction, two accepted identities, edited comments, noncanonical framing,
malformed JSON, accepted receipt whose current head/review claim no longer
matches, accepted facts without a review anchor, and a rejection receipt with
no review fields.

- [ ] **Step 2: Run lookup tests and witness RED**

Run:

```bash
yarn test test/lifecycle/marketplace-adoption-receipt.test.ts
```

Expected: FAIL because receipt ports are absent.

- [ ] **Step 3: Implement exact lookup**

Use only SDK parse/format helpers. Authenticate comment author before accepting its payload. An exact authorized duplicate is idempotent; contradictory authorized receipts fail closed.

- [ ] **Step 4: Run lookup tests GREEN**

Run focused file. Expected: lookup cases pass.

- [ ] **Step 5: Write failing publication/readback tests**

Assert exact `publicationHead` before write and after write, accepted
`resultingHead === publicationHead`, exact accepted review facts, paginated
readback of the created comment, no duplicate write on retry,
bounded/sanitized rejection detail, stale-head rejection publication against
the newly observed `publicationHead`, and no manifest transition before exact
readback.

- [ ] **Step 6: Implement publication and readback**

Publish one SDK-formatted PR issue comment through an injected port, then re-read exact facts and return comment identity. Do not mutate the manifest in this module.

- [ ] **Step 7: Run Task 6 GREEN**

Run focused file. Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/lifecycle/marketplace-adoption-receipt.ts \
  test/lifecycle/marketplace-adoption-receipt.test.ts
git commit -m "feat: publish marketplace adoption receipts"
```

### Task 7: Claim-only exact-head evaluator anchor

**Files:**
- Create: `src/lifecycle/marketplace-review-anchor.ts`
- Modify: `src/lifecycle/review-executor.ts`
- Modify: `src/lifecycle/review-executor-production.ts`
- Modify: `src/lifecycle/attempt-workspace.ts`
- Test: `test/lifecycle/marketplace-review-anchor.test.ts`
- Modify test: `test/lifecycle/review-executor.test.ts`
- Modify test: `test/lifecycle/review-executor-production.test.ts`

**Interfaces:**
- Consumes: current PR #42-aware review candidate/confirmation, exact ref CAS publication, credential selection, review workspace creation, Task 1 state.
- Produces:

```ts
export interface AcquiredExactHeadReviewClaim {
  readonly prNumber: number;
  readonly head: GitOid;
  readonly reviewRefOid: GitOid;
  readonly attemptId: string;
  readonly generation: string;
  readonly reviewer: string;
  readonly approvalPolicy: 'approve-eligible';
  readonly manifestPath: string;
}

export type ReviewClaimAcquisitionDeps = Omit<
  ReviewExecutorDeps,
  'startSession'
>;

export type ReviewClaimAcquisitionResult =
  | {
      readonly status: 'acquired';
      readonly claim: AcquiredExactHeadReviewClaim;
      readonly confirmed: ReviewActionCandidate;
    }
  | {
      readonly status: 'already-approved' | 'ineligible' | 'human' | 'lost' | 'ambiguous';
      readonly detail: string;
    };

export async function acquireExactHeadReviewClaim(
  action: { readonly prNumber: number; readonly expectedHead: GitOid },
  deps: ReviewClaimAcquisitionDeps,
): Promise<ReviewClaimAcquisitionResult>;

export interface MarketplaceReviewAnchorOrigin {
  readonly originManifestPath: string;
  readonly originV2AttemptId: string;
  readonly originRequestDigest: string;
  readonly taskId: string;
  readonly taskCid: string;
  readonly taskCreationBlock: number;
  readonly correlation: AutopilotCorrelation;
}

export interface MarketplaceReviewAnchorPort {
  acquireOrRecover(input: {
    readonly origin: MarketplaceReviewAnchorOrigin;
    readonly prNumber: number;
    readonly expectedHead: GitOid;
  }): Promise<MarketplaceReviewAnchorResult>;
  release(anchor: MarketplaceReviewAnchorEvidence): Promise<void>;
}
```

- [ ] **Step 1: Write failing local-conformance and extraction tests**

Characterize current local `executeReviewAction` behavior: exact candidate checks, mapping reread, claim CAS, GraphQL-lag confirmation, attempt creation, environment construction, and one local session start. Then write a failing test for the extracted acquisition result without session start.

- [ ] **Step 2: Run review tests and witness RED**

Run:

```bash
yarn test test/lifecycle/review-executor.test.ts \
  test/lifecycle/review-executor-production.test.ts
```

Expected: the new acquisition-only assertion fails because review acquisition and dispatch are still inseparable.

- [ ] **Step 3: Extract deterministic acquisition**

Move no policy. `executeReviewAction` calls `acquireExactHeadReviewClaim` and then performs the existing local `startSession`. Preserve result shapes and messages where externally asserted.

- [ ] **Step 4: Run local conformance GREEN**

Run Step 2. Expected: all existing local tests plus acquisition test pass.

- [ ] **Step 5: Write failing marketplace anchor tests**

Test:

- exact existing active claim/review manifest recovery;
- one new active claim with no local spawn;
- evaluator-leg manifest links origin Task and exact head;
- strict evaluator-leg state carries the immutable origin manifest, V2 attempt,
  request digest, Task ID/CID/creation block, generation, ref, and reviewer;
- only `anchored → released` is legal, and retry recovers byte-identical
  linkage;
- no second Task request file/submission;
- mapping ambiguous/retargeted/stacked-base mismatch;
- external Human and CODEOWNER rejection;
- foreign ref win and GraphQL ambiguity;
- multiple exact live review manifests;
- release through existing review-session protocol;
- idempotent retry never creates another generation.

- [ ] **Step 6: Run anchor tests and witness RED**

Run:

```bash
yarn test test/lifecycle/marketplace-review-anchor.test.ts
```

Expected: FAIL because claim-only marketplace anchoring is absent.

- [ ] **Step 7: Implement evaluator-leg attempt and anchor port**

Install Task 1's explicit `marketplace-evaluator-leg-v1` execution state linked
to the origin mutation attempt. It is not a mutation Task state and cannot
call submission backend methods. Build and release it through the production
review workspace port, Task 1's dedicated transition, and current authority
checks.

- [ ] **Step 8: Run Task 7 GREEN**

Run all three Task 7 test files. Expected: local behavior unchanged, marketplace path has zero local spawns and zero Task submissions.

- [ ] **Step 9: Commit**

```bash
git add src/lifecycle/marketplace-review-anchor.ts \
  src/lifecycle/review-executor.ts \
  src/lifecycle/review-executor-production.ts \
  src/lifecycle/attempt-workspace.ts \
  test/lifecycle/marketplace-review-anchor.test.ts \
  test/lifecycle/review-executor.test.ts \
  test/lifecycle/review-executor-production.test.ts
git commit -m "feat: anchor marketplace evaluator reviews"
```

### Task 8: Port-driven mutation-adoption coordinator

**Files:**
- Create: `src/lifecycle/marketplace-mutation-adoption.ts`
- Test: `test/lifecycle/marketplace-mutation-adoption.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7 ports and evidence types; existing `ImplementationSessionProtocol`.
- Produces:

```ts
export type MarketplaceMutationAdoptionResult =
  | { readonly status: 'accepted'; readonly receipt: AutopilotAdoptionReceipt; readonly resultingHead: GitOid; readonly reviewAnchor: MarketplaceReviewAnchorEvidence }
  | { readonly status: 'rejected'; readonly reason: AutopilotAdoptionRejectionReason; readonly receipt: AutopilotAdoptionReceipt }
  | { readonly status: 'recoverable'; readonly stage: string; readonly detail: string };

export interface MarketplaceMutationAdoptionCoordinator {
  adopt(manifestPath: string): Promise<MarketplaceMutationAdoptionResult>;
}

export type MarketplaceMutationAdoptionBoundary =
  | 'observation-persisted'
  | 'patch-applied'
  | 'verification-persisted'
  | 'host-commit-created'
  | 'checkpoint-published'
  | 'completion-confirmed'
  | 'review-anchor-published'
  | 'receipt-comment-created'
  | 'receipt-persisted';

export interface MarketplaceMutationAuthority {
  readonly manifest: AttemptManifest;
  readonly remoteHead: GitOid;
  readonly latestClaimOid: GitOid;
  readonly latestClaim: BranchClaim;
  readonly pullRequest: {
    readonly number: number;
    readonly head: GitOid;
    readonly headRefName: string;
    readonly baseRefName: string;
    readonly open: boolean;
    readonly draft: boolean;
    readonly labels: readonly string[];
    readonly implementationSummary?: string;
    readonly canonicalIssueNumber: number;
    readonly mappingStatus: 'resolved' | 'ambiguous' | 'missing';
    readonly humanActive: boolean;
    readonly codeOwnerRequired: boolean;
  };
  readonly child?: {
    readonly number: number;
    readonly parentPrNumber: number;
    readonly kind: 'review-finding' | 'reconcile' | 'ci-failure';
    readonly open: boolean;
  };
  readonly receiptAuthors: readonly string[];
}

export interface MarketplaceMutationAuthorityPort {
  readExactAuthority(input: {
    readonly manifestPath: string;
    readonly touchedPaths: readonly string[];
  }): Promise<MarketplaceMutationAuthority>;
}

export interface MarketplaceMutationAdoptionDependencies {
  readonly observe: typeof observeMarketplaceSolutionDelivery;
  readonly readAuthority: MarketplaceMutationAuthorityPort;
  readonly validatePatch: typeof validateMarketplacePatch;
  readonly applyPatch: (input: {
    readonly artifact: Uint8Array;
    readonly manifestPath: string;
    readonly worktreePath: string;
    readonly expectedHead: GitOid;
  }) => Promise<ValidatedMarketplacePatch>;
  readonly git: MarketplaceMutationGitPort;
  readonly verification: MarketplaceMutationVerificationPort;
  readonly implementation: ImplementationSessionProtocol;
  readonly reviewAnchors: MarketplaceReviewAnchorPort;
  readonly receipts: AdoptionReceiptPorts;
  readonly transition: typeof transitionMarketplaceAdoption;
  readonly now?: () => Date;
  readonly onBoundary?: (
    boundary: MarketplaceMutationAdoptionBoundary,
  ) => Promise<void> | void;
}

export function makeMarketplaceMutationAdoptionCoordinator(
  deps: MarketplaceMutationAdoptionDependencies,
): MarketplaceMutationAdoptionCoordinator;
```

- [ ] **Step 1: Write failing validation/authority tests**

Use small in-memory ports and literal SDK observations. Prove no patch/Git/GitHub effect for:

- mismatched Task/session/result correlation;
- untrusted/mismatched solver evidence;
- stale claim/head/PR/branch/base;
- PR #42 ambiguous or noncanonical mapping;
- unsupported CODEOWNER/verification-control surface;
- Human result.

Human result must call the existing Human protocol before constructing
`policy-human`.

- [ ] **Step 2: Run coordinator tests and witness RED**

Run:

```bash
yarn test test/lifecycle/marketplace-mutation-adoption.test.ts
```

Expected: FAIL because the coordinator is absent.

- [ ] **Step 3: Implement validation and stable-rejection ordering**

Order effects as observation validation → pure patch validation → live authority → worktree proof. Stable failures construct typed receipts only when correlation is sufficient; transient port errors return `recoverable`.

- [ ] **Step 4: Run initial coordinator tests GREEN**

Run focused file. Expected: no-effect and Human cases pass.

- [ ] **Step 5: Write failing success and recovery tests**

Cover:

- clean → apply → verify → commit;
- pending exact tree after crash;
- bound verification evidence reuse;
- committed host commit recovery;
- authority changes after verification;
- implementation completion exact readback;
- implementation completion persists PR, branch, claim OID, checkpoint OID,
  exact resulting head, and `In Review` readback;
- child checkpoint + `childComplete`;
- child completion additionally persists child/parent identity, parent branch,
  closed-child readback, claim/checkpoint OIDs, and exact resulting head;
- child already closed only with exact durable commit;
- review-anchor acquisition/recovery;
- accepted receipt publication/readback;
- rejected receipt after verification failure;
- receipt contradiction and anchor release;
- adoption deadline before/after durable effects;
- every state transition idempotently resumed.

- [ ] **Step 6: Implement minimal full coordinator**

Invoke existing implementation protocol methods rather than duplicating GitHub mutations. Require exact completion readback before review anchor; require exact active anchor before accepted receipt.

- [ ] **Step 7: Run Task 8 GREEN**

Run focused file. Expected: all coordinator paths pass.

- [ ] **Step 8: Commit**

```bash
git add src/lifecycle/marketplace-mutation-adoption.ts \
  test/lifecycle/marketplace-mutation-adoption.test.ts
git commit -m "feat: coordinate marketplace mutation adoption"
```

### Task 9: Standalone production adoption adapters

**Files:**
- Create: `src/lifecycle/marketplace-mutation-adoption-production.ts`
- Modify: `src/lifecycle/active-runtime-production.ts`
- Test: `test/lifecycle/marketplace-mutation-adoption-production.test.ts`
- Modify test: `test/lifecycle/active-runtime-production.test.ts`

**Interfaces:**
- Consumes: Task 8 coordinator, current standalone readers/writers/session ports, exact attempt credentials, and Task 5 verification port.
- Produces:

```ts
export interface ProductionMarketplaceMutationAdoptionOptions {
  readonly originManifestPath: string;
  readonly repositoryPath: string;
  readonly worktreeBase: string;
  readonly runnerId: string;
  readonly credentials: CredentialPool;
  readonly readSnapshot: () => Promise<GitHubLifecycleSnapshot>;
  readonly staleAfterMs: number;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly nextId?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly verification?: MarketplaceMutationVerificationPort;
}

export function makeProductionMarketplaceMutationAdoptionCoordinator(
  options: ProductionMarketplaceMutationAdoptionOptions,
): MarketplaceMutationAdoptionCoordinator;
```

- [ ] **Step 1: Write failing production-authority adapter tests**

Test exact credential isolation, attempt token resolution, canonical mapping reread, open PR/head/branch/base/claim facts, stacked base acceptance, retarget/ambiguity/Human/CODEOWNER rejection, existing implementation-session use, exact PR comment read/write, and no project/GitHub mutation outside existing protocols.

- [ ] **Step 2: Run production adapter tests and witness RED**

Run:

```bash
yarn test test/lifecycle/marketplace-mutation-adoption-production.test.ts
```

Expected: FAIL because production coordinator construction is absent.

- [ ] **Step 3: Implement production ports**

Compose:

- `observeMarketplaceSolutionDelivery`;
- exact current mapping/authority reader;
- manifest-registry/worktree/start-head cleanliness proof;
- `makeMarketplaceMutationGitPort`;
- production verification port;
- `makeImplementationSessionProtocol` with
  `makeProductionImplementationSessionPort`;
- marketplace review-anchor port;
- authenticated PR comment receipt ports;
- Task 1 transition APIs.

Use attempt-scoped credentials only for GitHub/Git publication. Keep them out of the CLI observer and Docker verifier.

- [ ] **Step 4: Run production adapter tests GREEN**

Run focused file. Expected: all pass.

- [ ] **Step 5: Write failing active-runtime construction tests**

Prove marketplace mode constructs the production adoption factory with the
same repository, credentials, runner, clock, and snapshot authority used by
the current V2 runtime. Prove local mode does not construct it and normal
marketplace review actions remain unavailable.

- [ ] **Step 6: Run active-runtime tests and witness RED**

Run:

```bash
yarn test test/lifecycle/active-runtime-production.test.ts
```

Expected: the new adoption-factory assertions fail because the factory is not
yet exposed by the active runtime.

- [ ] **Step 7: Wire the production factory without scheduling recovery**

Construct the production ports in marketplace mode and expose the resulting
coordinator to the recovery callback added in Task 10. Do not add a second
background loop or post-snapshot bridge.

- [ ] **Step 8: Run Task 9 GREEN**

Run:

```bash
yarn test test/lifecycle/marketplace-mutation-adoption-production.test.ts \
  test/lifecycle/active-runtime-production.test.ts
```

Expected: both pass with local behavior unchanged.

- [ ] **Step 9: Commit**

```bash
git add src/lifecycle/marketplace-mutation-adoption-production.ts \
  src/lifecycle/active-runtime-production.ts \
  test/lifecycle/marketplace-mutation-adoption-production.test.ts \
  test/lifecycle/active-runtime-production.test.ts
git commit -m "feat: wire marketplace adoption ports"
```

### Task 10: Pre-snapshot recovery, crash-injected vertical acceptance, and full regression

**Files:**
- Modify: `src/lifecycle/active-runtime-production.ts`
- Modify: `src/lifecycle/controller.ts`
- Modify: `scripts/run-autopilot-v2.ts`
- Create: `test/lifecycle/marketplace-solution-recovery.test.ts`
- Create: `test/lifecycle/marketplace-solution-vertical.test.ts`
- Modify: `test/lifecycle/active-runtime-production.test.ts`
- Modify: `test/lifecycle/controller.test.ts`
- Modify: `test/run-autopilot-v2-entrypoint.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 9 production coordinator, all-runner attempt scan, existing prepared-submission recovery, and controller pre-snapshot hook.
- Produces:

```ts
export interface RecoverSubmittedMarketplaceAttemptsOptions {
  readonly v2Base: string;
  readonly recoverPrepared: () => Promise<readonly SessionExecutionResult[]>;
  readonly makeAdopter: (
    manifestPath: string,
  ) => MarketplaceMutationAdoptionCoordinator;
  readonly isPidAlive: (pid: number) => boolean;
  readonly now?: () => Date;
}

export async function recoverSubmittedMarketplaceAttempts(
  options: RecoverSubmittedMarketplaceAttemptsOptions,
): Promise<{ readonly ok: boolean; readonly detail?: string }>;
```

- [ ] **Step 1: Write failing recovery-order, vertical, and crash tests**

In `marketplace-solution-recovery.test.ts`, assert the controller order with
literal event capture:

```ts
expect(events).toEqual([
  'initialize',
  'recover-prepared-submissions',
  'recover-submitted-adoptions',
  'read-snapshot',
  'dispatch',
]);
```

Cover:

- all runner directories are scanned;
- v2 migration happens before observation;
- pending delivery stays live;
- accepted receipt leaves linked origin/review attempts live and skips
  re-adoption;
- rejected receipt releases any anchor then exits exact attempts;
- malformed or contradictory state blocks snapshot and dispatch;
- local mode never constructs adoption recovery;
- verification preflight joins submission dry-run and client-command readiness;
- no launcher or daemon configuration is introduced.

In `marketplace-solution-vertical.test.ts`, build one real temporary Git
repository and attempt workspace with injected external boundaries. Exercise:

```text
submitted mutation Task
  -> SDK-validated verified Solution
  -> exact patch application
  -> jinn-mono.v1 verification evidence
  -> correlation-bound host commit
  -> existing implementation completion
  -> claim-only exact-head evaluator anchor
  -> accepted SDK receipt
```

Assert no local agent spawn, no second Task submission, no Router claim, exact resulting head, one review generation, one receipt comment, and live linked origin/review attempts.

Use Task 8's `onBoundary` hook to inject one crash after each literal boundary:

```ts
const boundaries: readonly MarketplaceMutationAdoptionBoundary[] = [
  'observation-persisted',
  'patch-applied',
  'verification-persisted',
  'host-commit-created',
  'checkpoint-published',
  'completion-confirmed',
  'review-anchor-published',
  'receipt-comment-created',
  'receipt-persisted',
];
```

For each boundary, restart the same recovery and assert no repost, reapply,
recommit, duplicate push/summary/child close, second review generation, or
duplicate comment.

- [ ] **Step 2: Run recovery and vertical tests and witness RED**

Run:

```bash
yarn test test/lifecycle/marketplace-solution-recovery.test.ts \
  test/lifecycle/marketplace-solution-vertical.test.ts \
  test/lifecycle/controller.test.ts \
  test/run-autopilot-v2-entrypoint.test.ts
```

Expected: FAIL because submitted adoption is not in the pre-snapshot hook and
the vertical recovery path cannot progress.

- [ ] **Step 3: Implement all-runner pre-snapshot adoption recovery**

After prepared submission recovery, scan every strict live marketplace
attempt:

```ts
switch (marketplaceStatus(manifest)) {
  case 'prepared':
    throw new Error('prepared recovery must finish before adoption recovery');
  case 'submitted':
  case 'solution-observed':
  case 'solution-verified':
  case 'host-committed':
  case 'lifecycle-completed':
  case 'review-anchored':
    await options.makeAdopter(manifest.paths.manifest)
      .adopt(manifest.paths.manifest);
    break;
  case 'receipt-published':
    await reconcileReceiptTerminalState(manifest, options);
    break;
  case 'cancelled':
    break;
}
```

Wire this callback before snapshot acquisition. Accepted receipt state remains
live for the Verdict follow-up; rejected state releases any linked anchor and
marks exact attempts exited. Extend marketplace preflight with Task 5
verification readiness and the installed observation command. Update README
only to state that Solution adoption is supported while Verdict adoption is
the next slice.

- [ ] **Step 4: Run recovery and vertical tests GREEN**

Run the Step 2 command. Expected: recovery ordering, vertical adoption, and
every crash-boundary restart pass.

- [ ] **Step 5: Run focused marketplace suites GREEN**

Run:

```bash
yarn test \
  test/lifecycle/marketplace-execution-state.test.ts \
  test/lifecycle/marketplace-adoption-state.test.ts \
  test/lifecycle/marketplace-cli.test.ts \
  test/lifecycle/marketplace-delivery.test.ts \
  test/lifecycle/marketplace-patch.test.ts \
  test/lifecycle/marketplace-mutation-git.test.ts \
  test/lifecycle/marketplace-mutation-verification.test.ts \
  test/lifecycle/marketplace-mutation-verification-production.test.ts \
  test/lifecycle/marketplace-adoption-receipt.test.ts \
  test/lifecycle/marketplace-review-anchor.test.ts \
  test/lifecycle/marketplace-mutation-adoption.test.ts \
  test/lifecycle/marketplace-mutation-adoption-production.test.ts \
  test/lifecycle/marketplace-solution-recovery.test.ts \
  test/lifecycle/marketplace-solution-vertical.test.ts
```

Expected: all focused marketplace tests pass with pristine output.

- [ ] **Step 6: Run complete repository verification**

Run in Node 22:

```bash
yarn typecheck
yarn test
yarn verify:source
yarn build
yarn verify:dist
git diff --check
```

Expected:

- TypeScript passes.
- Full Vitest suite passes; documented pre-existing skips only.
- Sole-engine/source verification passes.
- Distribution builds and verifies.
- Build leaves only the intended Task 10 source and test changes.

- [ ] **Step 7: Commit vertical acceptance and any focused fixes**

```bash
git add test/lifecycle/marketplace-solution-vertical.test.ts \
  test/lifecycle/marketplace-solution-recovery.test.ts \
  test/lifecycle/active-runtime-production.test.ts \
  test/lifecycle/controller.test.ts \
  test/run-autopilot-v2-entrypoint.test.ts \
  src/lifecycle/active-runtime-production.ts \
  src/lifecycle/controller.ts \
  scripts/run-autopilot-v2.ts \
  README.md
git commit -m "feat: complete marketplace solution adoption"
```

- [ ] **Step 8: Prepare whole-branch review evidence**

Record:

```bash
git status --short
git diff --exit-code
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
```

Expected: clean worktree, design/plan plus ten reviewed implementation commits, and only scoped standalone Autopilot changes.
