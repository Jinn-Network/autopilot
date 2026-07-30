# Autopilot V2 Marketplace Solution Adoption Design

**Date:** 2026-07-27

**Status:** Approved design, ready for implementation planning

**Repository:** `Jinn-Network/autopilot`

**Baseline:** `origin/main` at `8a6b4232be8eb9d39c00e3dbc9620a433f2ab66d`

## Summary

Add the host-side Solution-adoption leg for marketplace-backed Autopilot V2
mutation sessions.

Autopilot already creates the V2 attempt, worktree, branch claim, draft pull
request, immutable marketplace request, and marketplace Task. This change
keeps those responsibilities and adds deterministic recovery that:

1. observes an exact remote Solution through the released Jinn client;
2. verifies live V2 and GitHub authority;
3. validates, applies, verifies, and commits the returned patch in the
   existing attempt worktree;
4. completes the existing implementation or child protocol;
5. acquires an exact-head review generation without dispatching another
   session;
6. publishes an authenticated adoption receipt on the pull request.

The remote daemon network remains responsible for claiming the Solution after
it observes the accepted receipt and for running the Task's evaluator leg.
Autopilot does not run a marketplace daemon or make Router claims.

This slice ends after the Solution receipt activates the evaluator leg.
Verdict observation and adoption are a separate follow-up.

## Goals

- Make marketplace mutation Tasks progress from submission to safely adopted
  pull-request changes.
- Preserve the V2 rule that Autopilot owns all deterministic lifecycle and
  GitHub mutations.
- Never spawn a local agent in marketplace mode.
- Reuse the existing checkpoint, implementation completion, child completion,
  Human, and exact-head review-claim protocols.
- Recover idempotently after a crash at every side-effect boundary.
- Keep the released SDK and CLI as the only marketplace protocol boundary used
  by standalone Autopilot.
- Preserve the canonical mapping and Human-authority rules introduced by
  Autopilot PR #42.

## Non-goals

- Verdict observation or review-result adoption.
- Local review-worker dispatch in marketplace mode.
- Independent marketplace Tasks for review sessions.
- A programmatic transaction client in Autopilot.
- A local marketplace daemon, launcher, or generator.
- Generic repository verification profiles.
- Repository bundles, streaming patches, binary patches, or three-way apply.
- Human/CODEOWNER issues in the initial marketplace canary.
- Relaxing the existing `Jinn-Network/mono`, `typescript`, and
  `jinn-mono.v1` restriction.

## Existing public boundary

Standalone Autopilot consumes the released packages:

- `@jinn-network/sdk@0.1.1`;
- `@jinn-network/client@0.2.2`.

It imports contracts only from `@jinn-network/sdk/autopilot` and invokes the
installed client binary. It must not import Jinn monorepo source or client
internals.

The delivery command is:

```text
jinn tasks observe-autopilot-delivery \
  --expectation-file <path> \
  --json
```

Autopilot constructs the expectation with
`AutopilotDeliveryExpectationSchema` and parses the complete output with
`AutopilotDeliveryCommandResultV1Schema`.

The public observer already verifies:

- the exact indexed Task, attempt, and envelope join;
- the Router `TaskCreated` event;
- the authoritative attempt operator;
- the Mech `Deliver` event through RPC;
- the historical ERC-8004 publisher identity;
- the IPFS envelope digest and signature;
- the participant Safe, agent EOA, and signer relationship;
- the typed mutation result and complete Autopilot correlation.

Autopilot must not repeat those marketplace protocol checks with private
indexer, RPC, or IPFS integrations. It verifies that the resulting observation
also agrees with its own immutable request and current attempt manifest.

## Chosen implementation approach

The old private Autopilot package in the Jinn monorepo contains a hardened
reference implementation. Its pure patch, exact-Git, verification-plan, and
receipt ideas are ported and adapted. Its coordinator and production wiring
are treated as a behavioral reference rather than copied wholesale.

Two alternatives were rejected:

1. **Port the private package wholesale.** Its flat optional marketplace
   execution fields predate standalone Autopilot's strict
   `marketplace-execution-v2` state, crash journals, and PR #42 authority.
2. **Rebuild every primitive from scratch.** This would discard extensive
   adversarial coverage for patch parsing, exact Git reconstruction, receipts,
   and crash recovery.

The legacy `src/dispatcher/delivery-pr-bridge.ts` is not reused. It is a
`live-issue` bridge that creates a new worktree, branch, and pull request from
`origin/next`. V2 adoption must mutate only the already-owned attempt
worktree and use existing lifecycle protocols.

## Architecture

The implementation is split into small policy and adapter modules:

- `marketplace-delivery.ts`
  - writes the strict observation expectation;
  - invokes the installed client binary with a sanitized environment;
  - parses the SDK wrapper;
  - persists the exact authenticated observation.
- `marketplace-patch.ts`
  - performs pure byte, diff, path, and mode validation;
  - proves the existing worktree surfaces are safe;
  - runs `git apply --check` and plain `git apply` through stdin.
- `marketplace-mutation-git.ts`
  - computes the exact delivered tree;
  - creates the correlation-bound host commit;
  - reconstructs clean, pending-change, committed, and contradictory states.
- `marketplace-mutation-verification.ts`
  - owns the pure `jinn-mono.v1` affected-workspace plan.
- `marketplace-mutation-verification-production.ts`
  - runs the plan in the bounded production sandbox.
- `marketplace-adoption-state.ts`
  - owns strict codecs and monotonic manifest transitions.
- `marketplace-review-anchor.ts`
  - acquires or recovers an exact-head evaluator-leg review claim without
    dispatching a local session or another Task.
- `marketplace-adoption-receipt.ts`
  - reads, authenticates, publishes, and reads back canonical SDK receipts.
- `marketplace-mutation-adoption.ts`
  - coordinates the port-driven deterministic state machine.
- `marketplace-mutation-adoption-production.ts`
  - wires current standalone GitHub, worktree, implementation-session, review,
    credentials, and recovery ports.

The exact module names may be combined where that materially reduces
duplication, but policy codecs, the coordinator, and process/GitHub adapters
remain separated for testing.

## Runtime integration

`recoverPreparedMarketplaceAttempts` already runs in the controller's
pre-snapshot recovery hook. Add submitted-attempt adoption recovery to the
same hook, after prepared Task recovery and before the lifecycle snapshot.

The ordering is:

```text
initialization
  -> recover prepared Task submissions
  -> recover submitted Solution adoption
  -> read canonical lifecycle snapshot
  -> derive and dispatch new actions
```

Adoption must scan all runner directories, matching current submission
recovery. It is not limited to the current runner's local capacity view.

If recovery encounters malformed or contradictory durable state, the
pre-snapshot hook fails closed. Autopilot must not schedule against a state it
could not reconcile.

## Internal execution state

Marketplace adoption introduces a new internal execution schema rather than
adding a flat set of optional fields to `marketplace-execution-v2`.

New marketplace mutation attempts use `marketplace-execution-v3`. Existing v2
`prepared` and `submitted` attempts remain readable and are upgraded
atomically after their immutable request and submission identity have been
reverified. Existing cancelled attempts remain terminal.

The mutation progression is:

```text
prepared
  -> submitted
  -> solution-observed
  -> solution-verified
  -> host-committed
  -> lifecycle-completed
  -> review-anchored
  -> receipt-published
```

Stable rejection can transition from any stage after sufficient correlation
exists to construct an authenticated rejection receipt. Infrastructure
ambiguity remains at the current recoverable stage.

Every state is a strict discriminated variant that carries the complete prior
identity required for local validation. Dedicated transition functions:

- compare the exact prior state;
- are idempotent for byte-identical evidence;
- reject contradictory evidence;
- update the manifest atomically;
- preserve the immutable request and submission;
- update timestamps monotonically.

Generic attempt-manifest update functions remain prohibited for marketplace
execution v2/v3.

### Persisted observation

The SDK-validated observation is written canonically to an attempt-scoped
0600 file before the worktree is touched. The manifest records its absolute
path and SHA-256 digest.

The `solution-observed` state records:

- Task ID and CID;
- Task creation transaction and block;
- selected SolverNet manifest CID;
- attempt index and request ID;
- delivery envelope CID and digest;
- delivery transaction and block;
- solver Safe, agent EOA, signer, and publisher identity;
- observation path and digest;
- observed timestamp;
- complete correlation identity.

The patch itself is not duplicated into the manifest.

### Durable adoption evidence

Later states add:

- artifact SHA-256, byte length, sorted touched paths, and expected tree;
- verification profile, artifact/tree binding, commands, outcomes, and time;
- host commit head, tree, parents, and correlation-trailer identity;
- completion operation, resulting head, and exact readback facts;
- evaluator-leg review attempt, manifest, generation, ref OID, reviewer, and
  head;
- canonical SDK receipt, comment ID, authenticated author, and recorded time.

There is deliberately no authoritative `patch-applied` state. If the process
crashes after application, recovery reconstructs the exact pending tree from
Git and the immutable artifact. A matching pending tree resumes verification;
any unrelated change is a contradiction.

## Delivery observation

For a submitted attempt, Autopilot:

1. re-verifies the immutable request file and its digest;
2. re-verifies the persisted Task submission and manifest correlation;
3. constructs the strict Solution expectation;
4. pins any already-known attempt, request, envelope, and delivery fields;
5. invokes the client command with marketplace configuration but without
   GitHub credentials;
6. parses the complete SDK result wrapper.

Results are handled as follows:

- `pending`: keep the attempt recoverable until its adoption deadline;
- `contradiction`: fail closed and surface deterministic diagnostics;
- `verified`: persist the observation before any repository mutation.

Malformed command output is a protocol failure. Operational CLI failures
remain recoverable according to their existing error classifications.

## Live authority and PR #42

The immutable session capsule is correlation evidence, not current GitHub
permission.

Before patch application, and again before lifecycle completion, Autopilot
performs a fresh authoritative read that requires:

- one canonical resolved PR-to-issue mapping;
- the expected issue or child identity;
- the exact open pull request;
- the exact branch and current head;
- the expected target base;
- a canonical stacked-parent chain when the target base is not the default;
- the current implementation branch claim;
- no contradictory open child work;
- no dominant external Human authority;
- no unsupported CODEOWNER surface.

`targetBaseOid` remains submission-time snapshot evidence. If topology,
mapping, target base, or parent authority changed, adoption does not infer
permission from the old capsule.

Mapping ambiguity uses PR #42's machine-owned reread/pause semantics and must
not be converted into an ordinary manual-label workflow.

## Patch policy

Validation occurs on the exact raw UTF-8 bytes before worktree mutation.

The patch must:

- be non-empty and at most 2 MiB;
- be valid UTF-8 with no NUL bytes;
- contain no binary or combined diff;
- use normalized NFC repository-relative paths;
- contain no POSIX, Windows-drive, or UNC absolute path;
- contain no `.` or `..` traversal, including backslash variants;
- contain no case-insensitive `.git` path;
- contain no malformed, control-character, or contradictory header path;
- use only regular executable or non-executable file modes (`100755` or
  `100644`);
- contain no symlink (`120000`) or gitlink/submodule (`160000`) mutation;
- avoid unsupported verification-control surfaces in v1.

Verification-control surfaces include package manifests and lockfiles,
Yarn/PnP and dependency trees, compiler/test-runner configuration, tests, and
snapshots. This is a conservative v1 canary restriction: a candidate may not
weaken the mechanism used to evaluate its own patch.

Before `git apply`, Autopilot:

- uses `lstat` semantics on every touched path and ancestor;
- checks the Git index for tracked symlinks and gitlinks;
- proves the attempt worktree is the one registered in the manifest;
- proves its starting head and cleanliness;
- sends the immutable bytes to `git apply --check`.

Application uses plain `git apply` through stdin. There is no temporary
attacker-named path, three-way fallback, or fuzzy retry.

## Exact Git reconstruction

The Git adapter computes the expected result tree using a temporary index
without mutating the real index. It binds the artifact to:

- the expected attempt head;
- exact touched paths;
- resulting tree;
- workflow;
- Task, request, envelope, and V2 attempt identity.

After successful verification, it creates exactly one host commit with strict
trailers for that identity. Child workflows include the existing
`Jinn-Autopilot-Issue: <child>` trailer required by `child-complete`.

Reconcile workflows preserve the current reconcile protocol's parent
topology; the port does not blindly copy the older mono implementation.

On recovery, Git state is one of:

- `clean`: the patch has not been applied;
- `pending`: the worktree/index exactly matches the expected delivered tree;
- `committed`: the exact host commit already exists;
- `contradiction`: unrelated changes, tree, parent, trailer, or commit state.

Only the first three states can progress.

## Verification profile

`jinn-mono.v1` maps touched paths to an ordered affected-workspace closure.
For every affected workspace it runs the immutable installation and current
typecheck/compile and test commands, stopping at the first failure.

Production execution uses a pinned Node 22 container with:

- no GitHub, marketplace-wallet, or operator credentials;
- a read-only source mount copied into disposable storage;
- bounded CPU, memory, PIDs, output, command time, total time, and cleanup;
- lifecycle scripts disabled during dependency installation;
- immutable lockfile enforcement;
- network disabled for the actual typecheck/compile and test phase;
- guaranteed container cleanup or a fail-closed unsafe-cleanup result.

Dependency acquisition may use the public registry during the bounded
immutable installation phase. It is separated from credentialed host state
and from the network-disabled verification phase.

Verification evidence can be reused after a crash only when its profile,
artifact digest, exact expected tree, command plan, and result all match.
Otherwise verification runs again.

## Existing lifecycle handoff

The adopter invokes:

```ts
makeImplementationSessionProtocol(
  makeProductionImplementationSessionPort(...)
)
```

with the attempt-scoped manifest environment and credential already owned by
the V2 attempt.

For `implement`:

1. invoke `implementationComplete` with the delivered summary;
2. allow its existing checkpoint path to CAS-publish the host commit;
3. allow it to create/recover the phase-complete marker;
4. allow it to project summary, `engine:review`, and ready state;
5. read back the exact phase-complete claim, summary, label, draft state, and
   resulting PR head.

For `fix-child`, `reconcile`, and `ci-failure`:

1. invoke `checkpoint`;
2. confirm the exact parent PR head;
3. invoke `childComplete`;
4. read back that the exact child is closed.

For a solver `human` result:

1. invoke the existing implementation-session `human` protocol;
2. confirm the Human projection;
3. publish a `policy-human` rejection receipt.

No GitHub lifecycle mutation is duplicated inside the adopter.

## Exact-head evaluator anchor

An accepted Solution receipt requires `resultingHead`, `reviewGeneration`, and
`reviewRefOid`. These must exist before the remote solver may claim the
Solution and activate evaluation.

Refactor the current review executor into two conceptual operations:

1. deterministic exact-head claim acquisition and attempt creation;
2. agent-session dispatch.

Local mode calls both operations and remains behaviorally unchanged.
Marketplace adoption calls only the first operation in an explicit
`marketplace-evaluator-leg` mode.

The claim-only path:

- uses the current PR #42-aware candidate and mapping rereads;
- preserves Human dominance and CODEOWNER exclusion;
- preserves exact-parent ref publication and GraphQL-lag confirmation;
- creates or recovers one review attempt bound to the originating Task;
- never submits a second marketplace Task;
- never spawns a local agent;
- returns the exact active review generation and ref OID.

The evaluator-leg review manifest records its origin mutation manifest and
Task identity. It remains live after the accepted Solution receipt so the
follow-up Verdict-adoption slice can recover it.

Normal marketplace review scheduling for PRs without an originating
marketplace Task remains unavailable/Human in v1.

## Adoption receipts

Receipts use `AutopilotAdoptionReceiptSchema` and
`formatAutopilotAdoptionReceiptComment` from the SDK.

Before publication, Autopilot paginates pull-request issue comments and:

- authenticates authors against the attempt's persisted receipt allowlist;
- parses only canonical SDK receipt frames;
- accepts one exact matching receipt as already published;
- rejects contradictory accepted/rejected receipts;
- ignores forged or unrelated comments while recording diagnostics;
- verifies accepted-receipt head and review-claim facts.

Before and after creating a comment, Autopilot rechecks the exact pull-request
head. The manifest records the read-back comment ID and author only after the
exact receipt is visible and valid.

Stable validation, policy, or verification failures receive a typed rejection
receipt and remain unclaimed in the marketplace. Infrastructure ambiguity
does not publish a stable rejection.

The remote client observes the accepted receipt and calls
`claimSolutionDelivery`. Autopilot never calls that Router method.

After an accepted receipt, the mutation attempt and its evaluator-leg review
attempt remain live and linked. Pre-snapshot recovery recognizes
`receipt-published/accepted`, does not observe or adopt the Solution again, and
leaves the pair ready for the Verdict follow-up.

After a rejected receipt, recovery releases any review claim created during a
partially completed acceptance path, then marks the mutation and linked review
attempts exited only after exact release/readback. Rejection never activates
the evaluator leg.

## Deadlines and failure classification

The session's agent deadline plus the existing 30-minute adoption reserve
defines the final Solution-adoption cutoff.

- Missing delivery remains recoverable until the cutoff.
- Durable effects already started before the cutoff may be reconciled to a
  safe receipt after it, rather than abandoned mid-protocol.
- Stable input, policy, stale-authority, patch, or verification failures
  publish the corresponding SDK rejection reason.
- Transient CLI, indexer, RPC, IPFS, Docker-startup, GitHub-read, or
  publication ambiguity remains recoverable.
- Contradictory durable evidence fails closed and blocks new scheduling.

Error detail placed in receipts is sanitized, UTF-8 bounded, and stable.
Sensitive command output and credentials are never placed in comments or
manifests.

## Crash recovery

Recovery behavior by boundary:

| Crash point | Recovery behavior |
| --- | --- |
| Task posted before local bookkeeping | Existing submission recovery finds and persists the Task. |
| Delivery observed before manifest update | Re-observe the same exact delivery and persist it. |
| Observation persisted | Resume from the immutable observation file. |
| Patch applied | Reconstruct the exact pending tree; never reapply unrelated changes. |
| Verification passed | Reuse only exact bound evidence; otherwise rerun. |
| Host commit created | Recover the exact trailers/tree/parents; never recommit. |
| Checkpoint pushed | Existing checkpoint protocol/readback resumes without duplicate push. |
| Completion projected | Existing completion protocol/readback resumes without duplicate summary, label, undraft, or child close. |
| Review claim published | Recover the exact active claim and linked manifest; never create a second generation. |
| Receipt comment created | Find and authenticate the exact comment; persist its ID without duplication. |

Every injected crash test must prove that Task posting, patch application,
commit creation, branch publication, lifecycle projection, review generation,
and receipt publication occur at most once.

## Preflight

Marketplace capability preflight is extended to include:

- the existing Task submission dry-run;
- construction and round-trip validation of the SDK delivery expectation;
- installed client help exposing the observation command;
- verification-container runtime and pinned image readiness;
- ability to create and clean an isolated verification container.

Preflight performs no live Task submission, GitHub mutation, or agent spawn.

## Testing strategy

Implementation follows test-first slices:

1. execution-v3 codecs, migration, and CAS transitions;
2. SDK delivery adapter and immutable observation persistence;
3. patch policy and real-worktree safety;
4. exact Git reconstruction and host commit;
5. verification planning and production sandbox;
6. current-authority and lifecycle adapters;
7. claim-only exact-head review acquisition;
8. receipt publication and contradiction handling;
9. pre-snapshot production recovery;
10. crash-injected vertical acceptance.

Required coverage includes:

- existing local backend conformance remains unchanged;
- marketplace mode never spawns a local agent;
- v2 prepared/submitted attempt migration;
- pending, verified, malformed, forged, stale, and contradictory delivery data;
- byte-accurate 2 MiB limits and every prohibited patch path/mode case;
- tracked and untracked symlinks, symlink ancestors, gitlinks, and gitlink
  ancestors;
- no Git command on pure validation failure;
- check-before-apply, stdin-only apply, and no `--3way`;
- verification-control surface rejection;
- affected-workspace verification closure and order;
- sandbox credential/network/output/timeout/cleanup boundaries;
- PR #42 resolved, ambiguous, retargeted, and stacked-base mapping cases;
- Human and CODEOWNER fail-closed behavior;
- implementation and every child workflow completion;
- exact review-claim recovery with no second Task;
- authorized, forged, duplicate, and contradictory receipts;
- a crash after every durable or external side effect.

The final vertical test covers:

```text
submitted mutation Task
  -> authenticated Solution observation
  -> exact patch adoption
  -> existing V2 completion
  -> exact-head evaluator anchor
  -> accepted GitHub receipt
```

The test asserts that the origin mutation attempt and linked evaluator-leg
attempt are durably recoverable for the later Verdict slice.

## Rollout

The feature remains behind:

- `JINN_AUTOPILOT_EXECUTION_BACKEND=marketplace`;
- the existing issue allowlist;
- `Jinn-Network/mono`;
- `typescript`;
- `jinn-mono.v1`.

Initial live canaries are low-effort, non-Human, non-CODEOWNER issues whose
solutions do not require verification-control changes. Expansion waits for at
least five Tasks to pass correctness, recovery, receipt, and evaluator-quality
checks.

## Follow-up

The next design/implementation slice will:

- observe the evaluator's exact Verdict;
- adopt approval, aggregated review findings, or Human through the existing
  review-session protocol;
- publish the Verdict adoption receipt;
- close both linked attempts;
- allow the evaluator client to claim the Verdict;
- start a new mutation Task for any review-finding child and repeat full-head
  evaluation.
