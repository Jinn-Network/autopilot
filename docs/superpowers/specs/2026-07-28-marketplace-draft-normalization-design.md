# Marketplace Draft Normalization Design

## Context

Live marketplace Task `1200` delivered a byte-exact Solution for pull request
`#2273`. Autopilot observed and correlated the Solution to the exact Task,
attempt, request, claim, pull request, and initial branch head. Before patch
verification, it published an immutable rejection receipt:

```text
reason: policy-human
detail: Marketplace v1 excludes Human and CODEOWNER surfaces
```

No external Human or CODEOWNER policy was active:

- the pull request carried only `engine:review`;
- the issue carried no labels;
- Project `Blocked on` was `Nothing`;
- there were no Human protocol comments, assignees, requested reviewers, or
  reviews;
- the exact marker path did not match CODEOWNERS; and
- the live review candidate was approve-eligible.

Exactly one production predicate caused the rejection. Marketplace authority
normalized a draft pull request as active Human authority:

```ts
const humanActive = hasExternalHumanAuthority({
  pullRequestLabels: pullRequest.labels,
  nativeIssueLabels: issue?.labels,
  projectBlockedOn: projectItem?.blockedOn ?? null,
}) || pullRequest.draft || humanComment;
```

That conflicts with the implementation lifecycle. Fresh implementation claims
deliberately create draft pull requests, and implementation completion
deliberately keeps them draft until summary and review labels are durable.
Only then does completion mark the pull request ready. Marketplace adoption
must pass its initial authority gate before it can verify, commit, and invoke
that completion sequence.

The shared external-Human policy already keeps draft state separate. It
recognizes only:

- pull-request or issue label `review:needs-human`;
- pull-request or issue label `autopilot:human`; and
- Project `Blocked on` value `Human`.

Marketplace authority additionally recognizes a qualifying Human protocol
comment. Draft is a lifecycle state, not one of those authority sources.

Task `1200`, pull request `#2273`, and their authenticated rejection receipt
are terminal and remain immutable.

## Goals

- Treat a normal draft implementation pull request as lifecycle state rather
  than Human authority during marketplace Solution adoption.
- Keep marketplace Human authority aligned with the shared external-Human
  policy plus qualifying Human protocol comments.
- Preserve fail-closed rejection for `review:needs-human`,
  `autopilot:human`, Project `Blocked on = Human`, and qualifying Human
  comments.
- Preserve CODEOWNER classification and rejection as a separate policy gate.
- Preserve every claim, process, head, mapping, workflow, child, receipt, and
  correlation fence.
- Cover the production ordering `claim -> draft PR -> Solution adoption ->
  verification -> host commit -> implementation completion -> ready PR`.

## Non-goals

- Editing, rerunning, superseding, or recovering Task `1200`, pull request
  `#2273`, or its authenticated receipt.
- Starting another live issue, Task, active cycle, or recovery cycle before
  implementation is independently reviewed, pushed to pull request `#68`, and
  exact-head CI is green.
- Changing marketplace request, result, receipt, attempt, or evaluator schemas.
- Weakening explicit Human, CODEOWNER, canonical mapping, exact-head, or
  receipt-author policy.
- Changing when implementation pull requests are created, drafted, or marked
  ready.
- Refactoring unrelated marketplace authority or implementation lifecycle code.

## Approaches considered

### 1. Align marketplace Human normalization with the shared policy — selected

Remove draft state from marketplace `humanActive`. Keep the existing
`pullRequest.draft` field intact and compute:

```ts
const humanActive = hasExternalHumanAuthority({
  pullRequestLabels: pullRequest.labels,
  nativeIssueLabels: issue?.labels,
  projectBlockedOn: projectItem?.blockedOn ?? null,
}) || humanComment;
```

`codeOwnerRequired` remains independently derived from the live review
candidate.

This is the narrowest repair. It restores one policy vocabulary and lets the
existing implementation-completion protocol own the draft-to-ready
transition.

### 2. Exempt draft implementations inside the adoption consumer

`authorityFailure()` could retain `humanActive = true` for drafts and add a
workflow- and progress-aware exception. That would preserve misleading
normalized state, duplicate lifecycle semantics in the consumer, and make
future reads of `humanActive` context-dependent.

### 3. Mark the pull request ready before adoption

Autopilot could undraft the pull request before verification. That would expose
unverified work for review, mutate GitHub before the Solution passes its
effect-free gates, and defeat the deliberate implementation completion order.

## Authority contract

Marketplace mutation authority exposes these independent facts:

| Fact | Meaning |
| --- | --- |
| `pullRequest.draft` | Pull-request lifecycle state |
| `pullRequest.humanActive` | Explicit external or protocol Human authority |
| `pullRequest.codeOwnerRequired` | Exact changed-path CODEOWNER policy |

The facts must not imply one another.

`humanActive` is true if and only if at least one of these inputs is present:

1. `hasExternalHumanAuthority()` returns true for live pull-request labels,
   issue labels, or Project `Blocked on`;
2. a paginated pull-request issue comment carries the qualifying
   `<!-- jinn-autopilot:v2-human` marker.

Draft state does not contribute to `humanActive`.

`codeOwnerRequired` remains true if and only if the live review candidate
classifies the exact changed-file set as `human-codeowner`. Unsupported or
incomplete CODEOWNERS evidence continues to fail closed through the existing
review-candidate implementation.

The adoption consumer remains unchanged:

```ts
if (
  pullRequest.codeOwnerRequired
  || (!options.allowHuman && pullRequest.humanActive)
) {
  return {
    reason: 'policy-human',
    detail: 'Marketplace v1 excludes Human and CODEOWNER surfaces',
  };
}
```

Mutation-complete Solutions use `allowHuman: false`, so every explicit Human
source and every CODEOWNER surface still rejects before effects.

## Production data flow

1. The implementation executor publishes the initial branch claim.
2. It creates or repairs an exact-head draft pull request.
3. A marketplace solver delivers a correlated mutation result.
4. Adoption reads the exact implementation claim and live pull-request facts.
5. The authority port reads the lifecycle snapshot, live review candidate, and
   paginated comments.
6. The authority port records draft, Human, and CODEOWNER facts independently.
7. `authorityFailure()` rejects explicit Human or CODEOWNER policy and
   otherwise continues to verification.
8. Existing adoption logic verifies the patch, creates the host commit, and
   runs implementation completion.
9. Existing implementation completion publishes summary and `engine:review`,
   then marks the pull request ready.

No new state, transition, or migration is introduced.

## Error handling and safety

- Missing or ambiguous canonical mapping continues to reject.
- Incomplete changed-file or CODEOWNERS evidence continues to classify the
  candidate as Human CODEOWNER policy.
- A live Human label, Project hold, or Human protocol comment continues to set
  `humanActive` immediately.
- The Human-comment scan retains its bounded pagination and exact marker
  requirement.
- Draft state remains visible to downstream implementation and review
  protocols; only its incorrect aliasing as Human authority is removed.
- The repair does not alter the order or durability of patch verification,
  host commit, lifecycle completion, evaluator anchoring, or receipt
  publication.

## Test strategy

Testing follows strict RED-GREEN order.

### Production-order positive regression

Use the production marketplace authority port with:

- a live draft pull request;
- exact claim/head/base and resolved issue mapping;
- no Human labels, Project hold, or Human comments;
- complete changed-file evidence; and
- CODEOWNERS that do not own the changed path.

Before the repair, assert the test fails because `humanActive` is unexpectedly
true. After the repair, require:

```text
draft = true
humanActive = false
codeOwnerRequired = false
```

The regression represents the live ordering that rejected Task `1200`.

### Preserved negative policy

Production authority tests independently prove:

- `review:needs-human` sets `humanActive`;
- `autopilot:human` sets `humanActive`;
- Project `Blocked on = Human` sets `humanActive`;
- a qualifying Human protocol comment sets `humanActive`; and
- an exact CODEOWNERS match sets `codeOwnerRequired`.

Core adoption tests prove both `humanActive` and `codeOwnerRequired` reject a
mutation-complete Solution before patch effects.

### Verification

After focused regressions pass:

- run the complete marketplace adoption and vertical suites;
- run TypeScript typecheck;
- run the complete test suite;
- run the production build;
- verify source and distribution entry points and generated distribution
  parity;
- obtain independent review; and
- push the reviewed exact head to pull request `#68` and require exact-head CI
  green.

## Live-state consequence

The repair cannot change Task `1200` because its authenticated rejection
receipt is terminal. No fresh live issue or Task is authorized by this design.
Any later canary requires separate authorization after the implementation is
reviewed, pushed, and exact-head CI is green.
