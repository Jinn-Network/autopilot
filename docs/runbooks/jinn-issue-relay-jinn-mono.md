# Jinn mono Issue Relay internal canary

This runbook operates the separate Jinn Issue Relay composition for one
maintainer-authored `Jinn-Network/mono` issue. It does not authorize the
Autopilot V2 Project lifecycle, native GitHub reviews, merging, deployment, or
continuous active mode. Use the
[Autopilot V2 marketplace canary](https://github.com/Jinn-Network/mono/blob/main/docs/canary/autopilot-v2-marketplace.md)
only for shared creator Safe, escrow, SolverNet, indexer, gateway, RPC, and
Docker-verifier infrastructure.

## Scope and prerequisites

Use reviewed, clean, dedicated worktrees. Never run this procedure from a
dirty primary checkout.

```sh
export AUTOPILOT_WORKTREE=/absolute/path/to/autopilot-issue-relay-worktree
export JINN_MONO_WORKTREE=/absolute/path/to/jinn-mono-issue-relay-worktree
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
yarn --cwd client build
yarn --cwd client vitest run \
  test/issue-relay \
  test/harnesses/jinn-repo-evaluator \
  test/cli/commands/tasks-observe-issue-relay.test.ts
yarn --cwd client typecheck
```

The Relay resolves the installed `@jinn-network/client` package from the
Autopilot worktree and executes its declared `jinn` binary. Confirm that the
installed package is the reviewed Issue Relay-capable build and that its
`dist/bin/jinn.js` is executable.

The SDK contract bytes must agree before rollout:

```sh
cmp \
  "$JINN_MONO_WORKTREE/packages/sdk/fixtures/autopilot/issue-relay-round.v1.json" \
  "$AUTOPILOT_WORKTREE/test/fixtures/issue-relay-round.v1.json"
cmp \
  "$JINN_MONO_WORKTREE/packages/sdk/fixtures/autopilot/issue-relay-adoption.v1.json" \
  "$AUTOPILOT_WORKTREE/test/fixtures/issue-relay-adoption.v1.json"
```

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
  "schemaVersion": 1,
  "repository": "Jinn-Network/mono",
  "label": "engine:marketplace",
  "relayBotLogin": "jinn-relay",
  "managedForkRepository": "jinn-relay/mono",
  "targetBase": "main",
  "solverNet": "jinn-repo",
  "verificationProfile": "jinn-mono.v1",
  "requiredChecks": ["test"],
  "pollSeconds": 30,
  "budget": {
    "maxGlobalActiveGenerations": 1,
    "maxActivePerRepository": 1,
    "maxActivePerAuthor": 1,
    "maxRoundsPerGeneration": 2,
    "maxGenerationSpendWei": "REVIEWED_GENERATION_CAP_WEI",
    "maxGlobalSpendWeiPerUtcDay": "REVIEWED_DAILY_CAP_WEI",
    "generationDeadlineMs": 86400000
  }
}
```

Both Wei placeholders must be replaced by positive decimal integers before
the config is used. The managed fork must be public, distinct from the target,
owned by `relayBotLogin`, and have the target repository as its parent.

Set the three Relay variables. Keep the GitHub token in the process secret
store, not the config or state directory:

```sh
export JINN_ISSUE_RELAY_CONFIG="$RELAY_CONFIG"
export JINN_ISSUE_RELAY_STATE_DIRECTORY="$RELAY_STATE_DIRECTORY"
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
7. The solution operator and evaluator are separate Safes. Neither worker
   receives the bot token, creator key, repository secret, or upstream write
   authority.

Stop on any failed preflight. Do not bypass it by changing mode, using a local
backend, lowering verification, or deleting durable evidence.

## Mode progression

Run each command from `AUTOPILOT_WORKTREE` with the same config, credentials,
state directory, and marketplace environment.

```sh
cd "$AUTOPILOT_WORKTREE"
yarn issue-relay --mode observe --once
yarn issue-relay --mode recover --once
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

## Inspect every pass

Retain the one bot-authored issue status comment and inspect its hidden
generation marker. The snapshot digest, immutable deadline, task key, task
ID/CID, spend, round, workspace repository, input head, draft PR number, and
resulting head must agree with:

- `RELAY_STATE_DIRECTORY/rounds/<issue>/<snapshot-digest>/<round>/`, including
  `identity`, `spec.json`, `request.json`, `submission.json`,
  `solution-expectation.json`, `solution-observation.json`,
  `verdict-expectation.json`, and `verdict-observation.json` as they appear;
- the creator Safe transaction and escrow record for the Task ID;
- the authenticated Solution operator, request ID, attempt index, delivery
  envelope CID, transaction, and block;
- the deterministic `jinn/issue-relay/<generation-digest>` branch and the one
  draft PR from the public managed fork;
- the accepted adoption receipt in the one bot-owned PR assurance comment;
- the exact PR head/base, branch-required and configured checks, checks
  digest, and evaluation anchor;
- the distinct evaluator Safe and its full-cumulative-head verdict; and
- for request-changes, the next round's findings, managed-fork workspace,
  previous PR head as `inputHead`, same branch/PR, new receipt and anchor, and
  a fresh verdict for the complete new head.

READY is acceptable only when the same open PR reads back non-draft at the
latest adopted head, all required checks pass at that head, the latest
authenticated evaluator verdict passes that full head, and the assurance
comment says “ready for human review” while retaining every round in its
timeline. Relay never submits a native GitHub review and never merges.

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
event; snapshot and generation; config commit/digest; Task keys, IDs/CIDs,
creation transactions, blocks, SolverNet manifest, and spends; Solution and
Verdict observation files/digests; branch and PR URL; every head/base/check
digest; every receipt and anchor; READY assurance; mode command timestamps;
and restart evidence proving no duplication.

For the first failed or cancelled loop retain the same evidence plus the exact
failure/stop reason, last authoritative marker, rejection or exhaustion
report, draft-close evidence, remaining escrow and caps, relevant sanitized
logs, and the recovery decision. Never retain the GitHub token, creator key,
wallet password, repository secret, or worker-provider credential.
