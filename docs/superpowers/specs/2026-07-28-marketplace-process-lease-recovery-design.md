# Marketplace Process Lease Recovery Design

## Context

A live marketplace Solution for `Jinn-Network/mono#2266` reached Autopilot with
valid Task, delivery, envelope, correlation, and patch evidence. Autopilot
persisted the verified observation, then published a stable `stale-claim`
rejection with:

```text
Marketplace attempt is no longer running
```

The attempt was not stale. Its branch claim, pull-request mapping, head, Task,
and delivery were exact. The manifest had remained
`processState=preparing,pid=null` since creation.

Production currently has no transition that can change that state:

- `createAttemptWorkspace()` creates marketplace attempts as `preparing`;
- `MarketplaceSessionExecutionBackend.submitAndPersist()` persists only the
  marketplace execution transition to `submitted`;
- `recover(submitted)` returns the durable Task identity without changing the
  process state;
- submitted attempts bypass prepared-submission recovery and enter adoption
  directly; and
- evaluator-leg workspaces are also created `preparing`, while anchoring
  changes only their marketplace execution state.

Adoption deliberately requires `processState=running`. Capacity accounting
also deliberately counts mid-adoption mutation attempts and anchored evaluator
legs only while their recorded PID is alive. Tests hid the missing production
transition by constructing manifests as `running` or rewriting fixture state
directly.

## Goals

- Give every nonterminal marketplace mutation attempt an explicit lease on the
  Autopilot process currently responsible for advancing it.
- Acquire the lease only after Task submission is durable and before any
  Solution observation or host mutation.
- Recover the crash window where submission is durable but the process lease
  is absent.
- Rebind a lease held by a dead prior process without replaying Task
  submission.
- Refuse a live foreign lease before observation, receipt publication, Docker,
  Git, or GitHub mutation.
- Give an anchored evaluator leg the same live process semantics.
- Preserve all marketplace request, submission, delivery, adoption, Git, and
  review evidence byte-for-byte while changing only process metadata.
- Keep local execution behavior unchanged.

## Non-goals

- Reclassifying, deleting, or superseding an authenticated marketplace
  rejection receipt.
- Repairing or reusing Task `1197`; its rejection is immutable evidence and an
  accepted receipt with the same correlation would be contradictory.
- Adding a daemon, heartbeat, database, timeout, or marketplace Task retry.
- Weakening the exact-claim or `processState=running` adoption guard.
- Changing marketplace request, receipt, or SDK schemas.

## Approaches considered

### 1. Dedicated recoverable marketplace process lease — selected

Add a marketplace-only process transition that acquires or recovers the
manifest's `running` PID. Fresh submission, submitted recovery, pre-adoption
recovery, and evaluator anchoring use the same primitive.

This preserves the existing stale-owner fence and the live-PID capacity model.
It also makes the previously implicit process ownership explicit and testable.

### 2. Accept `preparing` during adoption

This is smaller, but removes positive evidence that the attempt has a current
owner. It conflicts with the recent capacity-accounting decision that
mid-adoption and evaluator-leg work is live only under a live PID.

### 3. Treat marketplace execution state as the only liveness signal

This would require redesigning capacity, cleanup, adoption authority, and
evaluator readiness together. A crashed mid-adoption attempt could remain
logically live indefinitely, and concurrent recovery would lose its early
owner fence. That expansion is unnecessary for this defect.

## Process lease model

The recorded PID is the Autopilot process currently authorized to advance the
marketplace attempt. It is not the PID of the external solver.

The dedicated transition accepts:

```ts
interface MarketplaceAttemptProcessClaimOptions {
  readonly pid?: number;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly now?: () => Date;
}

function claimMarketplaceAttemptProcess(
  manifestPath: string,
  options?: MarketplaceAttemptProcessClaimOptions,
): AttemptManifest;
```

Production defaults are `process.pid`, a `process.kill(pid, 0)` liveness
probe, and the current time. Tests inject literal PIDs, liveness, and time.

The transition is valid only for:

- a v2 or v3 mutation execution in `submitted` or a nonterminal v3 adoption
  progress state; or
- an evaluator-leg execution in `anchored`.

It rejects `prepared`, `cancelled`, `receipt-published`, `released`, local, and
exited manifests.

State behavior is exact:

| Current process metadata | Result |
| --- | --- |
| `preparing,pid=null` | Write `running` with the claimant PID and claim time. |
| `running` with claimant PID | Return the manifest without a write or timestamp drift. |
| `running` with another live PID | Refuse the claim without changing the manifest. |
| `running` with another dead PID | Rebind PID and start/update timestamps to the claimant. |
| `exited` | Refuse the claim without changing the manifest. |

Acquisition and rebind update only:

- `processState`;
- `pid`;
- `timestamps.updatedAt`; and
- `timestamps.childStartedAt`.

All other manifest fields, including the complete execution state, remain
identical. A claim timestamp older than `timestamps.updatedAt` fails closed.
The complete claim read/validate/write sequence shares the existing
marketplace execution-state transition lock, so a process claim cannot
overwrite a simultaneous adoption-state transition.

## Integration

### Submission backend

`MarketplaceSessionExecutionBackend` claims the process immediately after a
matching `submitted` state is durable and before it returns `started`.

The same path runs for:

- fresh `start()` submission;
- replayed prepared submission through `recover()`; and
- direct `recover()` of an already-submitted manifest.

Task submission remains idempotent and unchanged. The lease transition occurs
after submission evidence, so a failed or cancelled submission never becomes
running.

### Adoption recovery

`recoverSubmittedMarketplaceAttempts()` claims or recovers the process before
constructing or invoking the adopter for every adoption-progress status.

This boundary is required even though the backend also claims on submission:

- the process that submitted a Task may have exited normally before delivery;
- a process may crash after durable submission and before its first lease
  write; and
- a process may crash at any later durable adoption boundary.

A live foreign lease makes the recovery cycle fail without calling the
adopter. A dead lease is rebound and crash replay proceeds from existing
durable evidence.

### Evaluator anchor

`anchorMarketplaceEvaluatorReview()` claims the evaluator-leg process after
the evaluator execution is durably `anchored` and before returning anchor
evidence. Recovery of an already-anchored leg runs the same claim path.

This closes both creation windows:

- crash after evaluator workspace creation but before anchor installation; and
- crash after anchor installation but before process acquisition.

## Error handling and safety

- Lease refusal is infrastructure/recovery failure, not a stable Solution
  judgment. It occurs outside the adopter, so it cannot publish a rejection
  receipt.
- The existing exact request, attempt, branch claim, pull-request mapping,
  head, delivery, patch, verification, and receipt checks remain unchanged.
- No Task submission is replayed from a durable `submitted` state.
- No process claim is permitted for terminal marketplace execution.
- General `markAttemptRunning()` remains local-only. The new API bypasses its
  intentional marketplace-state guard while preserving the execution state.
- A recovery process can take ownership only when the prior PID is absent or
  proven dead.

## Test strategy

Tests begin from real decoded `preparing,pid=null` marketplace manifests.

1. Process primitive:
   - acquire from preparing;
   - same-PID byte-identical replay;
   - live foreign PID refusal;
   - dead foreign PID rebind;
   - exited and terminal-state refusal;
   - clock-regression refusal;
   - unchanged execution and identity evidence.
2. Submission backend:
   - fresh start returns only after `submitted+running`;
   - prepared replay reaches `submitted+running`;
   - direct submitted recovery acquires without adapter replay;
   - injected crash after durable submission is repaired on recovery.
3. Adoption recovery:
   - preparing submitted and mid-adoption manifests are claimed before the
     adopter;
   - live foreign ownership prevents adopter invocation and receipt effects;
   - dead ownership is rebound;
   - terminal receipts remain outside process acquisition.
4. Evaluator anchor:
   - new and recovered anchors return with a live process lease;
   - live foreign ownership remains recoverable and mutation-free.
5. Vertical:
   - a production-shaped preparing manifest traverses recovery to an accepted
     receipt without fabricated process state;
   - crash replay remains idempotent and submits no second marketplace Task.

## Live-canary consequence

Task `1197` cannot validate the fix. Its authenticated rejected receipt is a
terminal marketplace judgment, and publishing an accepted receipt with the
same correlation would create a contradiction by design. After this fix is
reviewed, built, and deployed, the end-to-end canary requires one fresh
disposable issue and one fresh Task under the same existing guardrails.
