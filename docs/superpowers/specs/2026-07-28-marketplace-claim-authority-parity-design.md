# Marketplace Claim Authority Parity Design

## Context

Live marketplace Task `1199` produced a valid Solution for pull request `#2271`.
Autopilot verified and persisted the delivery, recovered the attempt's process
lease, and then published an immutable rejection receipt:

```text
reason: stale-claim
detail: Implementation attempt no longer owns the exact claim
```

The claim was current. Its commit OID, branch head, pull-request head, issue,
attempt, runner, login, and target base all matched the delivered session.
Exactly one predicate failed: the initial implementation claim had no
`prNumber`, while the session created after the pull request existed carried
`prNumber: 2271`.

That state is produced deliberately:

1. fresh implementation publishes the claim commit before a pull request
   exists;
2. the fresh claim therefore omits `prNumber`;
3. Autopilot creates the draft pull request on that exact claim head; and
4. the attempt manifest and marketplace session then record the new pull
   request number.

The branch-claim type, lifecycle mapping, stale recovery, GitHub reader, and
implementation-session authority already recognize this state. The
marketplace adoption gate independently reimplemented the policy and required
an exact pull-request number on every claim.

Task `1197` carried the same initial-claim shape, but its earlier process-state
rejection masked this second defect. Task `1199` is terminal and remains
immutable.

## Goals

- Make marketplace adoption accept the legitimate fresh ordering
  `claim -> pull request -> manifest/session`.
- Keep omitted pull-request authority narrowly fenced to the original,
  non-terminal implementation claim.
- Reject an explicit wrong pull-request number in every state.
- Require a phase-complete claim to carry the exact pull-request number and be
  the exact remote branch head.
- Share the pull-request/OID transition policy between implementation-session
  and marketplace adoption so the two gates cannot drift again.
- Preserve all other exact phase, issue, attempt, runner, login, target-base,
  ancestry, pull-request mapping, process, head, Human, CODEOWNER, receipt, and
  correlation checks.

## Non-goals

- Reusing, editing, or superseding Task `1199`, Task `1197`, or either
  authenticated rejection receipt.
- Starting another live issue or marketplace Task before implementation is
  independently reviewed, pushed, and exact-head CI is green.
- Changing branch-claim trailers, marketplace request/result/receipt schemas,
  SDK contracts, or GitHub mapping policy.
- Moving pull-request creation before branch-claim publication.
- Rewriting an initial claim after pull-request creation.
- General authority-gate refactoring outside the pull-request/OID transition
  that drifted.

## Approaches considered

### 1. Narrow shared pull-request/OID predicate — selected

Add one pure helper that owns only the relationship among:

- the decoded branch claim;
- the expected pull-request number;
- the original manifest claim OID;
- the latest claim OID in branch ancestry; and
- the current remote branch head.

Both implementation-session and marketplace adoption use the helper while
retaining their existing caller-specific identity and policy checks.

This is the smallest boundary that removes the duplicated rule. It also makes
the fresh and phase-complete transitions independently testable as a truth
table.

### 2. Share the complete implementation-session authority gate

A broad shared gate would deduplicate more code, but the callers intentionally
have different responsibilities. Marketplace adoption additionally verifies
the delivered workflow, process lease, PR mapping, session correlation, Human
policy, receipt authors, and advanced-head recovery. Implementation-session
accepts multiple implementation phases from a manifest that does not encode a
marketplace workflow. Combining those gates would couple unrelated policy and
expand this repair.

### 3. Mirror the implementation-session ternary locally

Changing only marketplace adoption would be the smallest textual diff, but it
would leave two independent encodings of the same claim transition. The live
failure is evidence that local duplication is not a durable design.

## Shared authority contract

Add a focused module:

```text
src/lifecycle/implementation-claim-authority.ts
```

It exports:

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

The helper owns no GitHub reads and performs no mutation. Its complete policy
is:

| Claim state | Pull-request rule | OID rule | Result |
| --- | --- | --- | --- |
| Non-terminal implement claim, PR omitted | Omission is allowed | `latestClaimOid === originClaimOid` | Match |
| Non-terminal implement claim, exact PR | `claim.prNumber === expectedPrNumber` | `latestClaimOid === originClaimOid` | Match |
| Non-terminal fix/reconcile claim | Exact PR required | `latestClaimOid === originClaimOid` | Match |
| Any non-terminal claim with wrong explicit PR | Mismatch | Irrelevant | Reject |
| Any non-terminal claim after a newer claim OID | Exact or omitted | `latestClaimOid !== originClaimOid` | Reject |
| Phase-complete claim | Exact PR required | `latestClaimOid === remoteHead` | Match |
| Phase-complete claim with omitted/wrong PR | Mismatch | Irrelevant | Reject |
| Phase-complete claim below the remote head | Exact PR | `latestClaimOid !== remoteHead` | Reject |

In executable terms:

```ts
if (claim.phaseComplete === true) {
  return claim.prNumber === expectedPrNumber
    && latestClaimOid === remoteHead;
}
if (latestClaimOid !== originClaimOid) return false;
return claim.prNumber === undefined
  ? claim.phase === 'implement'
  : claim.prNumber === expectedPrNumber;
```

The helper does not decide whether the claim has the expected workflow phase,
issue, attempt, runner, login, or target base. Those checks remain beside the
caller-specific authority facts.

## Integration

### Implementation session

`requireAuthority()` replaces its local optional-PR branch with
`branchClaimPrAuthorityMatches()`.

It keeps:

- the allowed implementation-phase check;
- exact attempt, issue, runner, login, and target base;
- original-claim and latest-claim ancestry checks.

The shared helper makes the already-intended initial-claim allowance explicit
and adds the same terminal exact-head rule used by marketplace adoption.
Downstream completion readback remains unchanged.

### Marketplace adoption

`authorityFailure()` replaces the separate `claim.prNumber` comparison and
phase-dependent claim-OID comparison with the shared helper.

It keeps:

- exact workflow phase, issue, attempt, runner, and target base;
- manifest/session correlation;
- current process ownership;
- canonical PR mapping;
- exact branch and PR head checks;
- open/draft/Human/CODEOWNER policy;
- child/parent facts; and
- receipt-author policy.

For Task `1199`'s pre-effect authority shape, the helper returns true because
the claim is a non-terminal implement claim with no PR and
`latestClaimOid === originClaimOid`. Adoption can then proceed to patch,
verification, host commit, checkpoint, and completion.

Completion creates the existing terminal implementation claim. That claim
contains the exact manifest PR number and becomes the exact remote head before
completion readback can pass.

## Error handling and safety

- The helper returns only a boolean; existing caller errors and stable receipt
  reasons remain unchanged.
- An omitted PR never acts as a general wildcard. It is accepted only for an
  `implement` claim, only while the claim is not phase-complete, and only while
  the latest claim OID is the immutable origin claim OID.
- A claim with an explicit different PR always fails, including at the origin
  OID.
- A phase-complete claim without the exact PR always fails.
- A phase-complete claim below a later remote head always fails.
- No local or remote state is repaired, rewritten, or inferred by this helper.

## Test strategy

Testing follows production order and begins RED for every changed behavior.

1. Pure helper truth table:
   - accepts an initial non-terminal implement claim with omitted PR at the
     origin claim OID;
   - accepts an exact explicit PR at the origin claim OID;
   - rejects omitted PR after the latest claim OID changes;
   - rejects omitted PR when phase-complete;
   - rejects every explicit wrong PR;
   - accepts a phase-complete exact PR only at the remote head;
   - rejects a phase-complete claim below the remote head; and
   - requires exact PR for fix/reconcile.
2. Claim-before-PR to session:
   - capture the real fresh claim produced by
     `executeImplementationAction()`;
   - prove it omits `prNumber`;
   - create the later manifest with the returned PR number; and
   - prove the existing session checkpoint owns and advances that claim.
3. Claim-before-PR to adoption:
   - use a production-shaped manifest/session with a later PR number;
   - supply an exact initial implement claim with no PR;
   - observe the current `stale-claim` RED result with zero effects;
   - integrate the helper; and
   - prove adoption reaches an accepted receipt.
4. Negative adoption cases:
   - explicit wrong PR rejects before patch effects;
   - omitted PR with a foreign latest-claim OID rejects;
   - phase-complete omitted/wrong PR rejects; and
   - phase-complete exact PR below the remote head rejects.
5. Regression:
   - focused claim/session/adoption/vertical suites;
   - TypeScript typecheck;
   - complete test suite;
   - production build;
   - source and distribution verification.

## Live-canary consequence

Task `1199` cannot validate this repair because its authenticated rejection
receipt is terminal. After the implementation is independently reviewed,
pushed to pull request `#68`, and all checks are exact-head green, validation
requires one new disposable issue and one new marketplace Task under the
existing canary guardrails.
