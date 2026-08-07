# Jinn mono Issue Relay V2 internal canary

This runbook operates the separate Jinn Issue Relay composition for one
maintainer-authored `Jinn-Network/mono` issue. It does not authorize the
Autopilot V2 Project lifecycle, native GitHub reviews, merging, deployment, or
continuous active mode. Use the
[Autopilot V2 marketplace canary](https://github.com/Jinn-Network/mono/blob/main/docs/canary/autopilot-v2-marketplace.md)
only for shared creator Safe, escrow, SolverNet, indexer, gateway, RPC, and
Docker-verifier infrastructure.

This runbook exercises only the Relay V2 product contract. A V2 marketplace
solution is not a patch-only artifact: it contains the complete patch, PR
title, and PR description that the maintainer will review. Autopilot's external
evaluator harness emits separate exact-head `security` and `quality`
attestations in one signed application bundle. The assurance comment must
disclose that the same evaluator operator performed both lanes. Jinn
authenticates and transports that opaque bundle; it does not define Relay's
evaluation policy or decide whether the PR is ready.

## Landing order

Autopilot owns the Relay V2 task, result, lane, decision, and readiness
contracts. Jinn mono supplies only the generic marketplace boundary needed by
that product: an opaque application Task/result envelope, authenticated source
Task and Solution provenance for evaluation, generic settlement projection,
and `observe-application-delivery`.

Land and deploy the reviewed generic Jinn backend first. Then build and sign
the Autopilot-owned external evaluator package and deploy the Autopilot host
changes. Do not copy Relay V2 schemas or evaluator policy back into the Mono
SDK or its built-in evaluator. Do not enable V2 admission until a clean
Autopilot build, the reviewed Jinn client, and the signed external harness pass
the cross-repository application-boundary tests.

## Scope and prerequisites

Use reviewed, clean, dedicated worktrees. Never run this procedure from a
dirty primary checkout.

```sh
export AUTOPILOT_WORKTREE=/absolute/path/to/autopilot-issue-relay-worktree
export JINN_MONO_WORKTREE=/absolute/path/to/jinn-mono-issue-relay-worktree
export JINN_MONO_COMMIT=<reviewed-40-character-companion-commit>
export RELAY_CONFIG=/absolute/private/path/jinn-issue-relay.json
export RELAY_STATE_DIRECTORY=/absolute/private/path/jinn-issue-relay-state

for path in "$AUTOPILOT_WORKTREE" "$JINN_MONO_WORKTREE" \
  "$RELAY_CONFIG" "$RELAY_STATE_DIRECTORY"; do
  case "$path" in /*) ;; *) echo "not absolute: $path" >&2; exit 1 ;; esac
done

test -d "$AUTOPILOT_WORKTREE/.git" -o -f "$AUTOPILOT_WORKTREE/.git"
test -d "$JINN_MONO_WORKTREE/.git" -o -f "$JINN_MONO_WORKTREE/.git"
test -z "$(git -C "$AUTOPILOT_WORKTREE" status --short)"
test -z "$(git -C "$JINN_MONO_WORKTREE" status --short)"
test "$(git -C "$JINN_MONO_WORKTREE" rev-parse HEAD)" = "$JINN_MONO_COMMIT"
test "${#JINN_MONO_COMMIT}" -eq 40
case "$JINN_MONO_COMMIT" in
  *[!0-9a-f]*) echo "invalid reviewed Jinn commit" >&2; exit 1 ;;
esac
test "$(node --version | cut -d. -f1)" = v22
```

Install and verify the reviewed sources before any networked run:

```sh
cd "$AUTOPILOT_WORKTREE"
yarn install --immutable
yarn build
yarn typecheck
yarn vitest run test/issue-relay

cd "$JINN_MONO_WORKTREE"
yarn --cwd packages/sdk install --immutable
yarn --cwd packages/sdk build
yarn --cwd packages/sdk test
yarn --cwd packages/sdk typecheck
yarn --cwd client install --immutable
JINN_BUILD_COMMIT="$JINN_MONO_COMMIT" yarn --cwd client build
yarn --cwd client vitest run \
  test/adapters/mech/adapter.test.ts \
  test/application-delivery \
  test/cli/tasks-observe-application.test.ts
yarn --cwd client typecheck
```

Pin the Relay to that reviewed worktree build, never to Autopilot's registry
`@jinn-network/client` dependency:

```sh
export JINN_ISSUE_RELAY_JINN_BINARY="$JINN_MONO_WORKTREE/client/dist/bin/jinn.js"
test -x "$JINN_ISSUE_RELAY_JINN_BINARY"
rg -q 'observe-application-delivery' \
  "$JINN_MONO_WORKTREE/client/dist/cli/commands"
node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const meta = JSON.parse(fs.readFileSync(
    path.join(process.env.JINN_MONO_WORKTREE, "client/dist/build-meta.json"),
    "utf8",
  ));
  if (meta.commit !== process.env.JINN_MONO_COMMIT) process.exit(1);
'
export JINN_ISSUE_RELAY_JINN_COMMIT="$JINN_MONO_COMMIT"
export JINN_ISSUE_RELAY_JINN_DISTRIBUTION_SHA256="$(
  yarn --cwd "$AUTOPILOT_WORKTREE" tsx \
    scripts/digest-jinn-issue-relay-client.ts \
    "$JINN_ISSUE_RELAY_JINN_BINARY"
)"
test "${#JINN_ISSUE_RELAY_JINN_DISTRIBUTION_SHA256}" -eq 64
```

Record the companion commit, absolute binary path, and canonical whole-`dist`
SHA-256 in the rollout approval and retained evidence. Stop if any differs
after preflight. Runtime requires and verifies all three pins, including the
build metadata and compiled Relay command modules, at process startup. The
digest is also checked before every approved pass.

The existing V1 compatibility fixtures still agree before rollout:

```sh
cmp \
  "$JINN_MONO_WORKTREE/packages/sdk/fixtures/autopilot/issue-relay-round.v1.json" \
  "$AUTOPILOT_WORKTREE/test/fixtures/issue-relay-round.v1.json"
cmp \
  "$JINN_MONO_WORKTREE/packages/sdk/fixtures/autopilot/issue-relay-adoption.v1.json" \
  "$AUTOPILOT_WORKTREE/test/fixtures/issue-relay-adoption.v1.json"
cmp \
  "$JINN_MONO_WORKTREE/packages/sdk/fixtures/autopilot/issue-relay-assurance.v1.md" \
  "$AUTOPILOT_WORKTREE/test/fixtures/issue-relay-assurance.v1.md"
```

There is deliberately no Mono copy of the V2 fixture. Validate it inside
Autopilot and validate only its opaque outer application envelope in Mono.

V0 has a single-host, single-state-directory writer lease. Exactly one
`recover` or `active` process may use `RELAY_STATE_DIRECTORY`; another host,
another container, or a second process is not coordinated by that lease.
`observe` is read-only and does not take it. The directory must be owned by the
service account with mode `0700`; artifacts and `runtime.lock` are `0600`.

## Configuration and environment

Create `RELAY_CONFIG` with reviewed bounds. Replace only the bot/fork, check
names, SolverNet name, cadence, and numeric limits:

```json
{
  "schemaVersion": 2,
  "repository": "Jinn-Network/mono",
  "label": "engine:marketplace",
  "relayBotLogin": "jinn-relay",
  "managedForkRepository": "jinn-relay/mono",
  "targetBase": "main",
  "solverNet": "jinn-repo",
  "verificationProfile": "jinn-mono.v1",
  "requiredChecks": ["test"],
  "pollSeconds": 30,
  "generationProtocol": "v2",
  "dualLaneEvaluationEnabled": true,
  "humanDecisionCommandsEnabled": true,
  "decisionImplementationEnabled": true,
  "laneSpecifications": {
    "security": "sha256:REVIEWED_SECURITY_SPEC_DIGEST",
    "quality": "sha256:REVIEWED_QUALITY_SPEC_DIGEST"
  },
  "safePreimplementationReasonCodes": ["compatibility-choice"],
  "budget": {
    "maxGlobalActiveGenerations": 1,
    "maxActivePerRepository": 1,
    "maxActivePerAuthor": 1,
    "maxRoundsPerGeneration": 4,
    "maxGenerationSpendWei": "REVIEWED_GENERATION_CAP_WEI",
    "maxGlobalSpendWeiPerUtcDay": "REVIEWED_DAILY_CAP_WEI",
    "generationDeadlineMs": 86400000,
    "maxEvaluationAttemptsPerLanePerHead": 2,
    "maxEvaluationRetrySpendWei": "REVIEWED_EVALUATION_RETRY_CAP_WEI",
    "maxDecisionRequestsPerGeneration": 3,
    "maxDecisionImplementationRoundsPerGeneration": 2,
    "maxDecisionImplementationSpendWei": "REVIEWED_DECISION_CAP_WEI",
    "humanDecisionTtlMs": 1209600000,
    "maxHumanDeferrals": 1,
    "humanDeferralExtensionMs": 1209600000,
    "decisionContinuationDeadlineMs": 86400000
  }
}
```

Every digest and Wei placeholder must be replaced with a reviewed canonical
value before the config is used. The managed fork must be public, distinct
from the target, owned by `relayBotLogin`, and have the target repository as
its parent. An empty or invented lane specification digest is a hard stop.
For V2, the lane specification digest is the raw SHA-256 of the exact upstream
Claude command file used for that lane:

- quality: Anthropic's `plugins/code-review/commands/code-review.md` command;
- security: Anthropic's `.claude/commands/security-review.md` command from
  `claude-code-security-review`.

Check out both upstream repositories at reviewed immutable commits. Do not
point the evaluator at a moving branch. Compute the two values and copy the
prefixed values into `laneSpecifications`:

```sh
QUALITY_SKILL_PATH='/absolute/reviewed/claude-code/plugins/code-review/commands/code-review.md'
SECURITY_SKILL_PATH='/absolute/reviewed/claude-code-security-review/.claude/commands/security-review.md'
QUALITY_SKILL_DIGEST="sha256:$(shasum -a 256 "$QUALITY_SKILL_PATH" | awk '{print $1}')"
SECURITY_SKILL_DIGEST="sha256:$(shasum -a 256 "$SECURITY_SKILL_PATH" | awk '{print $1}')"
```

The Autopilot host places those exact digests in every application Task. The
external evaluator verifies the configured command bytes against the Task
digests before each review, and Autopilot rejects a signed lane attestation
whose digest differs from its host configuration. It runs Claude Code in bare
mode and therefore requires `ANTHROPIC_API_KEY`; OAuth/keychain state is
intentionally unavailable.

```sh
export JINN_ISSUE_RELAY_CLAUDE_CODE_REVIEW_SKILL_PATH="$QUALITY_SKILL_PATH"
export JINN_ISSUE_RELAY_CLAUDE_SECURITY_REVIEW_SKILL_PATH="$SECURITY_SKILL_PATH"
export ANTHROPIC_API_KEY='<evaluator key from the secret store>'
```

Build `dist/issue-relay-evaluator` from the reviewed Autopilot commit. Replace
the release placeholders in its manifest, compute the package hash/CID, sign
the manifest with the trusted evaluator publisher, and install that directory
through Jinn's `harnesses.externalImpls` mechanism. The operator trust store
must contain that exact publisher key and the installed harness version must
be pinned. The review skill files remain outside the package: the quality
command is subject to Anthropic's commercial terms, and both files are loaded
from the reviewed paths above and bound by their Task digests.

Use a dedicated evaluator operator for the first canary. On that operator,
include `jinn-repo-evaluator` in `harnesses.disabled` so registry first-match
dispatch reaches `autopilot-issue-relay-evaluator`. Do not disable the built-in
evaluator fleet-wide: ordinary `jinn-repo.v1` evaluation remains available
from other operators. Confirm the external harness rejects every non-Relay
application Task before the operator joins the canary.

`/code-review` is normally GitHub-facing and skips draft PRs. Relay loads the
reviewed command unchanged but supplies a credential-free, read-only local
`gh` projection of the immutable head, reports the evaluation view as
reviewable, and never passes `--comment`. The shim rejects every mutation.
`/security-review` reads the same exact checkout with local `origin/HEAD`
anchored to the frozen base. A separate tool-less adjudicator translates the
two skill reports into Relay's portable lane objects; it does not conduct a
second code review.

Optional Snyk Code evidence is enabled only when both variables are set. Snyk
is an automated pre-step outside Claude; its token is never copied into the
Claude process. Once enabled, scanner failure is fail-closed evaluation
`provider-unavailable`, while successful output contributes a digest and status to
the security attestation and PR assurance report.
This opt-in is not a local-only check: the operator must approve the configured
Snyk organization and its data-handling policy before source-derived analysis
leaves the evaluator. The V0 canary remains public-repository-only.

```sh
export JINN_ISSUE_RELAY_SNYK_ENABLED=1
export SNYK_TOKEN='<Snyk token from the evaluator secret store>'
```

Set the six Relay variables. Keep the GitHub token in the process secret
store, not the config or state directory:

```sh
export JINN_ISSUE_RELAY_CONFIG="$RELAY_CONFIG"
export JINN_ISSUE_RELAY_STATE_DIRECTORY="$RELAY_STATE_DIRECTORY"
export JINN_ISSUE_RELAY_JINN_BINARY="$JINN_MONO_WORKTREE/client/dist/bin/jinn.js"
export JINN_ISSUE_RELAY_JINN_COMMIT="$JINN_MONO_COMMIT"
# Retain the whole-distribution SHA-256 computed and approved above.
test "${#JINN_ISSUE_RELAY_JINN_DISTRIBUTION_SHA256}" -eq 64
export JINN_ISSUE_RELAY_GITHUB_TOKEN='<bot token from the secret store>'
```

Set the marketplace variables required by the installed Jinn client:
`BASE_RPC_URL`, `BASE_SEPOLIA_RPC_URL`, `JINN_CONFIG_HOME`,
`JINN_CONFIG_PATH`, `JINN_PASSWORD`, `JINN_WALLET_PASSWORD`,
`JINN_EARNING_DIR`, `JINN_NETWORK`, `JINN_RPC_URL`,
`JINN_ARCHIVE_RPC_URL`, `JINN_DISCOVERY_MODE`, `JINN_DISCOVERY_URL`,
`JINN_IPFS_GATEWAY_URL`, `JINN_STATE_DIR`, and `JINN_DB_PATH`, as applicable
to the reviewed environment. The Relay passes only this allowlisted
marketplace environment and strips GitHub secrets and `GH_CONFIG_DIR` before
launching Jinn.

## Preflight

Before the first write-capable pass, confirm:

1. The token authenticates exactly as `relayBotLogin`; the target is public
   `Jinn-Network/mono`, the base is `main`, and `engine:marketplace` exists.
2. The public managed fork is owned by the bot, has a different repository
   node ID, and its parent node ID equals the target node ID.
3. The creator Safe is the intended Safe, its keystore is available to the
   Jinn client, and escrow plus gas cover the reviewed generation cap.
4. Discovery resolves exactly the reviewed `jinn-repo` SolverNet and the
   dry-run proposed spend is positive and no greater than the generation cap.
5. RPC, archive RPC, discovery/indexer, IPFS gateway, and delivery observation
   are healthy.
6. Docker is available and the immutable `jinn-mono.v1` verification
   preflight succeeds.
7. Both reviewed Claude command paths are regular files, their raw SHA-256
   values equal the configured lane specifications, and a credential-free
   dry review cannot invoke the real `gh` binary or mutate GitHub.
8. If Snyk is enabled, `snyk code test --json` succeeds with the reviewed
   organization and its result digest appears only in the security lane.
9. The solution operator and evaluator are separate Safes. Neither worker
   receives the bot token, creator key, repository secret, or upstream write
   authority.
10. The dedicated evaluator disables only its local built-in
    `jinn-repo-evaluator`; other operators remain available for normal tasks.
11. The pinned client selects the signed Autopilot external evaluator for the
    application Task, transports its opaque result, and never routes Relay V2
    through Mono's built-in `jinn-repo` evaluator policy.

Stop on any failed preflight. Do not bypass it by changing mode, using a local
backend, lowering verification, or deleting durable evidence.

## Mode progression

Run each command from `AUTOPILOT_WORKTREE` with the same config, credentials,
state directory, and marketplace environment.

```sh
cd "$AUTOPILOT_WORKTREE"
test "$(
  yarn tsx scripts/digest-jinn-issue-relay-client.ts \
    "$JINN_ISSUE_RELAY_JINN_BINARY"
)" = "$JINN_ISSUE_RELAY_JINN_DISTRIBUTION_SHA256"
yarn issue-relay --mode observe --once
test "$(
  yarn tsx scripts/digest-jinn-issue-relay-client.ts \
    "$JINN_ISSUE_RELAY_JINN_BINARY"
)" = "$JINN_ISSUE_RELAY_JINN_DISTRIBUTION_SHA256"
yarn issue-relay --mode recover --once
test "$(
  yarn tsx scripts/digest-jinn-issue-relay-client.ts \
    "$JINN_ISSUE_RELAY_JINN_BINARY"
)" = "$JINN_ISSUE_RELAY_JINN_DISTRIBUTION_SHA256"
yarn issue-relay --mode active --once
```

`observe --once` may discover and derive the next action but performs no
writes. `recover --once` performs recovery writes but neither discovery nor
new funding. `active --once` may discover and fund one derived action per
generation. Inspect evidence after every pass and repeat only the next
explicitly approved `recover --once` or `active --once`. Do not start the
continuous loop for the first canary.

## First issue

1. A current `WRITE`, `MAINTAIN`, or `ADMIN` maintainer authors one open issue
   in `Jinn-Network/mono`. Do not use a pull request.
2. Give it a bounded TypeScript change, an immutable problem statement, and
   explicit Markdown checklist acceptance evidence, for example:

   ```md
   ## Acceptance

   - [ ] the named behavior is covered by a focused test
   - [ ] the Jinn client typecheck passes
   ```

3. Exclude secrets, private repositories, production operations,
   deploy/release work, ambiguous scope, and verification-control changes.
4. The same maintainer who authored the issue applies
   `engine:marketplace`. A bot, different maintainer, or later permission
   change does not satisfy self-label admission.
5. Run `observe --once`; record the candidate and derived
   `publish-snapshot`. Only then authorize the next `active --once`.

## Complete deliverable and repository guidance

Every submitted V2 solution must decode as
`jinn-issue-relay-solution.v2` and include all three maintainer-facing parts:

- the complete patch;
- a concise PR title; and
- a useful PR description explaining the change and its verification.

Relay does not synthesize missing PR metadata from the issue and does not
accept a patch-only fallback. Adoption opens or updates the one owned draft PR
with those exact solver-authored values plus Relay's hidden authority marker.
A later repair or decision-implementation round may update code, the PR title,
the PR description, or all three. The same exact open-draft authority and
readback rules apply to metadata-only repair.

Before quality can pass, the evaluator discovers the applicable guidance from
the frozen base revision, never from candidate-modified policy files. The
bounded corpus includes root and changed-path ancestor `README.md`,
`CONTRIBUTING.md`, `AGENTS.md`, and `CLAUDE.md`, plus the default and named
GitHub PR templates. Nested guidance applies only to changed paths under its
directory. Descriptive README prose is not automatically a rule, and multiple
named PR templates are alternatives rather than cumulative requirements.

The guidance checker receives the full cumulative diff and exact PR title and
description. Repository, issue, diff, and PR text are untrusted evidence: they
cannot change the review method, tools, authority, or output contract. Every
guidance violation must cite a concrete base-revision file and becomes a
lane-attributed quality finding for the next bounded repair round. If the
applicable guidance cannot be discovered or bounded, quality fails closed as
an evaluator capability failure; Relay does not guess or silently pass.

The quality attestation and assurance comment must contain the canonical
`repository-guidance@v1` evidence digest and whether it passed or produced
findings. Both lanes bind the digest of the live PR title and body. Any title or
body edit after evaluation makes the attestations stale and prevents READY
until checks, anchoring, and both evaluations are repeated for the new exact
deliverable.

## Inspect every pass

Retain the one bot-authored issue status comment and inspect its hidden
generation marker. The snapshot digest, immutable deadline, task key, task
ID/CID, spend, round, workspace repository, input head, draft PR number, and
resulting head must agree with:

- `RELAY_STATE_DIRECTORY/rounds/<issue>/<snapshot-digest>/<round>/`, including
  `identity`, `spec.json`, `request.json`, `submission.json`,
  `solution-expectation-v2.json`, `solution-observation-v2.json`,
  `evaluation-bundle-expectation-v2.json`, and
  `evaluation-bundle-observation-v2.json` as they appear;
- the creator Safe transaction and escrow record for the Task ID;
- the authenticated Solution operator, request ID, attempt index, delivery
  envelope CID, transaction, and block;
- the deterministic `jinn/issue-relay/<generation-digest>` branch and the one
  draft PR from the public managed fork;
- the accepted adoption receipt in the one bot-owned PR assurance comment;
- the exact PR head/base, branch-required and configured checks, checks
  digest, and evaluation anchor;
- the exact PR title/body digest and `repository-guidance@v1` quality evidence
  derived from the frozen base guidance;
- the distinct evaluator Safe and both full-cumulative-head lane attestations;
- the explicit same-operator limitation for the compatibility canary; and
- for lane changes-required, the next round's lane-attributed findings,
  previous PR head as `inputHead`, same branch/PR, new receipt and anchor, and
  a fresh dual-lane bundle for the complete new head.

READY is acceptable only when the same open PR reads back non-draft at the
latest adopted head, all required checks pass at that head, the latest
authenticated security and quality gates are both satisfied for that full
head, and the assurance comment says “ready for human review” while retaining
every round and human receipt. A human exception or interpretation must never
be rendered as an evaluator pass. Relay never submits a native GitHub review
and never merges.

## Decision conversation drill

The first V2 canary must deliberately exercise one bounded decision. Relay
publishes the request in its existing PR assurance comment. The authorized
maintainer copies one exact generated command into a new, unedited PR comment:

```text
/jinn-relay decide sha256:REQUEST EXACT_HEAD option-id
```

Do not shorten the digest or head. Do not use reactions, labels, reviews, or
edited comments. For a critical security block, an administrator is offered
only the exact generated `cancel`, `defer`, or `clarify` command; there is no
security override command. If `clarify` is selected, edit the issue into a
materially different admissible scope before the next pass. Verify that Relay
pins the successor snapshot, closes the predecessor draft, and publishes a
new linked generation marker without rewriting the predecessor.

If a selected option changes code, verify that Relay creates exactly one
`decision-implementation` round, stays within both generation and decision
caps, adopts a new exact head, and reruns checks plus both lanes. The selected
lane must attest conformance to the exact decision key, option, and
implementation round. A repeated command or repeated `(decisionKey,
optionId)` must not commission another task.

## Canary completion evidence

Do not enable continuous operation until retained evidence demonstrates:

1. one V2 solution, including patch, PR title, and PR description, adopted into
   a draft PR;
2. two exact-head lane objects and honest same-operator disclosure;
3. frozen-base repository guidance evidence passed for the exact final patch
   and PR metadata;
4. one safe recommendation implementation or decision-before-implementation;
5. one immutable authorized PR command and durable receipt;
6. both lane gates satisfied at the final head and the PR changed to ready;
7. a restart after at least one external effect caused no duplicate task,
   branch push, comment, receipt, or PR mutation; and
8. no native review, merge, deployment, worker GitHub credential, or
   restricted security evidence appeared.

## Stop, cancel, and spend

Stop immediately on a changed base/head, ambiguous or duplicate owned
comment, unexpected receipt author, correlation mismatch, stale check or
anchor, same solution/evaluator Safe, rejected patch, failed verifier,
rate-limit stop, unplanned spend, cap/deadline exhaustion, credential
exposure, native GitHub review, merge, or any proposed deploy/release action.
Preserve the state directory and GitHub markers.

For soft cancellation, remove `engine:marketplace` or close the issue, then
run approved `recover --once`/`active --once` passes against the same state
directory. Do not delete the Task, branch, comment, lock, or artifacts. After
funding, Relay must fund no new round, finish only the official current-round
settlement path, never mark ready, close any draft PR, and publish CANCELLED.
If a process crashed and left `runtime.lock`, first prove no writer exists on
the single host; only then remove that exact lock file and run
`recover --once`. Never remove the state directory.

Before and after every funding pass, compare the config's generation and UTC
daily caps with the sum of durable `fundingIntent.spendWei`/`task.spendWei`
entries. Cross-check each Task ID in the Jinn operator dashboard/activity
view, creator Safe transaction history, escrow balance, and Relay process
logs. Stop before another pass if the remaining daily or generation allowance
cannot cover the next reviewed round.

For the first successful loop retain, without secrets: issue URL and label
event; snapshot and generation; config commit/digest; reviewed Jinn companion
commit, resolved binary path, build metadata, and SHA-256; Task keys, IDs/CIDs,
creation transactions, blocks, SolverNet manifest, and spends; Solution and
Verdict observation files/digests; branch and PR URL; every head/base/check
digest; every receipt and anchor; READY assurance; mode command timestamps;
and restart evidence proving no duplication.

For the first failed or cancelled loop retain the same evidence plus the exact
failure/stop reason, last authoritative marker, rejection or exhaustion
report, draft-close evidence, remaining escrow and caps, relevant sanitized
logs, and the recovery decision. Never retain the GitHub token, creator key,
wallet password, repository secret, or worker-provider credential.
