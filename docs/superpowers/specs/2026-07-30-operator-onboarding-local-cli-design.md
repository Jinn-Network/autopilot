# Operator onboarding via local CLI

Date: 2026-07-30  
Status: approved for planning  
Branch: `docs/operator-onboarding-local-cli`

## Problem

Autopilot’s product CLI (`init` / `doctor` / `start` / `observe`) already
exists in this repository, but a colleague cannot follow the README today:

1. `@jinn-network/autopilot` is not published on npm, so
   `npm install --global @jinn-network/autopilot` fails.
2. Live `doctor` still blocks `start` on common first-run cliffs
   (credentials, disk floor, missing/mismatched capability attestation).
3. Doctor’s remedy for capability attestation says “run the capability
   probe,” but the published/local CLI has no first-class command for that;
   the probe is only exposed as a source-repo yarn script.
4. Production canary operation has historically used the mono-embedded
   `yarn autopilot --mode active` + `supervise.sh` path, which is not what
   this package’s README describes.

We are not migrating the mono canary in this work. We are making the
**standalone product path** honest, locally installable, and smoke-tested.

## Goals

- A colleague can clone this repo, build once, and run Autopilot against a
  target repository without tribal knowledge.
- Concurrency caps are clearly configurable by that colleague.
- We prove the path with a real smoke test: **doctor green** +
  **`observe --once`** against whichever configured target we can clear
  fastest.
- README matches reality (local build/link first; no false npm-global claim).

## Non-goals

- Publishing `@jinn-network/autopilot` to npm (later).
- Migrating `~/.jinn-client/eng-loop/supervise.sh` / mono embed operation.
- Active-mode claiming / leaving a long-running daemon up during smoke.
- New interactive UI for concurrency caps during `init`.
- Rewriting `init`’s GitHub/Project/Hermes permission bar.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Install path | Local clone: `yarn install && yarn build`, then `yarn link` or `node dist/autopilot.js` | Package is unpublished; this is proveable today |
| Smoke depth | `doctor` non-blocking + `observe --once` | Proves product path without claiming work |
| Smoke target | Whichever configured target clears doctor fastest | Bias toward a normal init-shaped canary if credentials restore easily |
| Cap configuration | Edit `.autopilot/config.json` `scheduler.*` | Already supported; env overrides remain available for experiments |
| Capability probe | Expose via product CLI | Doctor remedy must work without source-repo scripts |

## Operator flow (target)

```text
# 1. Build the CLI from this repo
cd /path/to/autopilot
yarn install
yarn build
yarn link                  # optional; or invoke node dist/autopilot.js

# 2. Operate a target repository (not this product repo)
cd /path/to/target-repo
export AUTOPILOT_GITHUB_IMPLEMENT_TOKEN=...   # if not already in ~/.autopilot credentials
# optional: AUTOPILOT_GITHUB_REVIEW_TOKEN=...  # must be a distinct identity

autopilot init             # once per target, if .autopilot/config.json missing
# edit .autopilot/config.json scheduler caps if desired

autopilot doctor           # must exit 0 / blocking: false
autopilot observe --once   # read-only smoke

# later, when ready for continuous operation:
autopilot start
autopilot status
autopilot stop
```

### Concurrency caps

Persistent (recommended) — in `<target>/.autopilot/config.json`:

```json
"scheduler": {
  "pollSeconds": 600,
  "fullReconcileSeconds": 3600,
  "implementationConcurrency": 1,
  "reviewConcurrency": 1,
  "openPrBackpressure": 30
}
```

`init` defaults both concurrency fields to `1`. A colleague raises them by
editing the file and restarting the daemon (`stop` then `start`) so the new
config hash is loaded.

Optional runtime overrides (experiments only):

- `JINN_AUTOPILOT_IMPLEMENTATION_CAP`
- `JINN_AUTOPILOT_REVIEW_CAP`
- `JINN_AUTOPILOT_BACKPRESSURE`

## Product-shell changes

### 1. Keep local build runnable

Verify `yarn build` produces `dist/autopilot.js` that implements the CLI
surface documented above. Fix only what blocks that path.

### 2. First-class capability refresh

Add a single CLI flag on doctor that re-runs the existing
`ensureCapabilityAttestation` path against the loaded target config:

```text
autopilot doctor --refresh-capabilities
```

Then run the normal doctor checks (including `git-ref-capabilities`) and
report the result. Update the `git-ref-capabilities` doctor remedy string to
name exactly: `autopilot doctor --refresh-capabilities`.

Do not invent a second probe implementation — reuse
[`src/capability-setup.ts`](../../../../src/capability-setup.ts).

### 3. Disk floor honesty

Keep `init`’s default `safety.diskFloorGb: 10` (fail-closed for claim work).
README and the existing doctor remedy must say an operator may deliberately
lower `safety.diskFloorGb` when the host has less free space.

For the smoke target only: if disk is blocking, lower that target’s
`safety.diskFloorGb` in its `.autopilot/config.json` (do not change the
global init default in this work).

### 4. README rewrite

Replace the current npm-global-first README with:

1. What Autopilot is (one short paragraph)
2. Prerequisites (Node 22, Git, `gh`, Hermes + Jinn plugin, org repo, tokens)
3. Local install from this clone
4. `init` against a **target** repo
5. Configuring concurrency caps
6. `doctor` / capability refresh
7. Read-only smoke (`observe --once`)
8. Daily daemon commands (`start` / `status` / `logs` / `stop`)
9. Where state lives (`~/.autopilot/…` vs `<repo>/.autopilot/`)
10. Explicit note that npm global install is not available yet

## Smoke verification

1. Build CLI from this repo.
2. Choose the fastest doctor-clearable target among existing canaries
   (`autopilot-canary-20260723` preferred if credentials restore easily;
   otherwise mono full-loop canary after attestation refresh).
3. Clear blocking doctor checks without inventing a new target repo unless
   none of the existing ones can be repaired quickly.
4. Run `autopilot observe --once` and confirm the process completes without
   a hard failure attributable to missing product-shell wiring.
5. Record the exact commands used so the README can mirror them.

Do **not** leave `autopilot start` running as part of this smoke.

## Testing expectations

- Unit/CLI tests for any new argument parsing and capability-refresh wiring.
- Existing doctor/service/init tests remain green.
- Live smoke is operator verification, not a CI hermetic test.

## Success criteria

- Colleague instructions in README work from a fresh clone of this repo
  without referencing mono `supervise.sh`.
- `doctor` remedy for capability attestation names a command that exists on
  the built CLI.
- At least one real target has been taken through doctor-green +
  `observe --once` using that CLI.
- Concurrency caps are documented as config edits, not env folklore.

## Out-of-scope follow-ups (explicit)

- npm publish workflow exercise / first public release
- Aligning mono canary to `autopilot start`
- Interactive `init` prompts for concurrency caps
- `autopilot upgrade` support for yarn-link installs
