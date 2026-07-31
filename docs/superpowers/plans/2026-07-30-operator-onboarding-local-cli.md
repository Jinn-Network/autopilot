# Operator Onboarding Local CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the standalone Autopilot product CLI honestly installable from a local clone, expose capability refresh on `doctor`, prove doctor-green + `observe --once` on a real target, and rewrite the README so a colleague can get started without mono/`supervise.sh` folklore.

**Architecture:** Keep the existing product shell (`bin/autopilot.ts` → `src/service.ts` / `scripts/run-autopilot-v2.ts`). Add one doctor flag that reuses `ensureCapabilityAttestation`, update the doctor remedy copy, then smoke the built CLI against the fastest-clearable canary target and rewrite README to match the proven commands.

**Tech Stack:** Node 22, Yarn 4, TypeScript, Vitest, GitHub CLI (`gh`), existing Autopilot product CLI.

## Global Constraints

- Install path is local clone (`yarn install && yarn build` + `yarn link` or `node dist/autopilot.js`); do not claim npm global install works.
- Smoke depth is `doctor` non-blocking + `observe --once` only; do not leave `autopilot start` running.
- Smoke target is whichever existing configured canary clears doctor fastest.
- Concurrency caps stay in `.autopilot/config.json` `scheduler.*`; no new init UI.
- Capability refresh must reuse `ensureCapabilityAttestation` from `src/capability-setup.ts`.
- Keep `init` default `safety.diskFloorGb: 10`; only lower it on the smoke target config if disk blocks.
- Do not migrate mono `supervise.sh`.
- Do not edit the approved spec file.

## File map

| File | Responsibility |
|---|---|
| `src/cli/arguments.ts` | Parse `doctor --refresh-capabilities`; update usage string |
| `test/cli/arguments.test.ts` | Grammar coverage for the new flag |
| `src/doctor.ts` | Exact remedy text for `git-ref-capabilities` |
| `bin/autopilot.ts` | Wire refresh before doctor report |
| `test/doctor.test.ts` | Assert remedy names the new command (if practical without live probe) |
| `README.md` | Colleague onboarding guide matching proven commands |
| Target `.autopilot/config.json` (smoke only) | Temporary disk-floor override if needed |

---

### Task 1: Parse `doctor --refresh-capabilities`

**Files:**
- Modify: `src/cli/arguments.ts`
- Modify: `test/cli/arguments.test.ts`

**Interfaces:**
- Consumes: existing `parseAutopilotArguments` / `flags` helpers
- Produces: `AutopilotCommand` doctor variant `{ kind: 'doctor'; json: boolean; refreshCapabilities: boolean }`

- [ ] **Step 1: Write the failing parser tests**

In `test/cli/arguments.test.ts`, add cases to the `it.each` table and keep unknown-option rejection:

```typescript
[['doctor'], { kind: 'doctor', json: false, refreshCapabilities: false }],
[['doctor', '--json'], { kind: 'doctor', json: true, refreshCapabilities: false }],
[['doctor', '--refresh-capabilities'], {
  kind: 'doctor',
  json: false,
  refreshCapabilities: true,
}],
[['doctor', '--json', '--refresh-capabilities'], {
  kind: 'doctor',
  json: true,
  refreshCapabilities: true,
}],
```

Also assert status still rejects the new flag:

```typescript
expect(() => parseAutopilotArguments(['status', '--refresh-capabilities']))
  .toThrow(/unknown option/i);
```

Update the existing `[['doctor', '--json'], { kind: 'doctor', json: true }]` row so it includes `refreshCapabilities: false`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn vitest run test/cli/arguments.test.ts`

Expected: FAIL — doctor command type/shape does not include `refreshCapabilities`, and/or `--refresh-capabilities` is rejected as unknown.

- [ ] **Step 3: Implement parser support**

In `src/cli/arguments.ts`:

1. Change the doctor command type:

```typescript
| { readonly kind: 'doctor'; readonly json: boolean; readonly refreshCapabilities: boolean }
```

2. Update usage:

```text
autopilot doctor [--json] [--refresh-capabilities]
```

3. Split `doctor` from `status` parsing. Status keeps only `--json`. Doctor accepts both:

```typescript
if (command === 'doctor') {
  const parsed = flags(tail, ['--json', '--refresh-capabilities']);
  if (parsed.positionals.length > 0) throw new Error(`Unexpected doctor input; ${AUTOPILOT_USAGE}`);
  return {
    kind: 'doctor',
    json: parsed.booleans.has('--json'),
    refreshCapabilities: parsed.booleans.has('--refresh-capabilities'),
  };
}
if (command === 'status') {
  const parsed = flags(tail, ['--json']);
  if (parsed.positionals.length > 0) throw new Error(`Unexpected status input; ${AUTOPILOT_USAGE}`);
  return { kind: 'status', json: parsed.booleans.has('--json') };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn vitest run test/cli/arguments.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/arguments.ts test/cli/arguments.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): parse doctor --refresh-capabilities

Expose a first-class flag so operators can refresh Git ref capability
attestation without source-repo yarn scripts.
EOF
)"
```

---

### Task 2: Wire refresh into `doctor` and update remedy copy

**Files:**
- Modify: `bin/autopilot.ts`
- Modify: `src/doctor.ts`
- Modify: `test/doctor.test.ts` (only if a hermetic assertion fits existing fixtures)

**Interfaces:**
- Consumes: `ensureCapabilityAttestation({ loaded, environment, runner })` from `src/capability-setup.ts`
- Consumes: doctor command `{ refreshCapabilities: boolean }`
- Produces: doctor flow that optionally refreshes attestation before `runDoctor`

- [ ] **Step 1: Write the failing remedy assertion**

In `test/doctor.test.ts`, add a focused assertion that the capability remedy names the CLI command. Prefer asserting against the exported/constant string if one exists after the change; otherwise assert on a doctor report fixture path that already exercises `git-ref-capabilities`.

If the existing suite never reaches a missing-attestation blocking check hermetically, extract the remedy string into a named export in `src/doctor.ts`:

```typescript
export const GIT_REF_CAPABILITIES_REMEDY =
  'Run `autopilot doctor --refresh-capabilities`, then rerun `autopilot doctor`.';
```

Then add:

```typescript
import { GIT_REF_CAPABILITIES_REMEDY } from '../src/doctor.js';

it('names the product CLI capability refresh command in the remedy', () => {
  expect(GIT_REF_CAPABILITIES_REMEDY).toContain('autopilot doctor --refresh-capabilities');
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `yarn vitest run test/doctor.test.ts -t "names the product CLI capability refresh"`

Expected: FAIL — constant missing or still has old copy.

- [ ] **Step 3: Update remedy and wire CLI**

In `src/doctor.ts`, replace the old remedy:

```typescript
'Run the capability probe for this repository, then rerun `autopilot doctor`.',
```

with `GIT_REF_CAPABILITIES_REMEDY` (or the equivalent inline string above).

In `bin/autopilot.ts` doctor branch, refresh before doctor when requested:

```typescript
if (command.kind === 'doctor') {
  if (command.refreshCapabilities) {
    await ensureCapabilityAttestation({
      loaded,
      environment: process.env,
      runner: defaultRunner,
    });
  }
  const report = await doctorFor(loaded);
  process.stdout.write(command.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${renderDoctor(report)}\n`);
  if (report.blocking) process.exitCode = 1;
  return;
}
```

Ensure `ensureCapabilityAttestation` is imported from `../src/capability-setup.js` (same module already used by `init`).

- [ ] **Step 4: Run targeted tests**

Run:

```bash
yarn vitest run test/cli/arguments.test.ts test/doctor.test.ts
yarn typecheck
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bin/autopilot.ts src/doctor.ts test/doctor.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): refresh capability attestation from doctor

Reuse ensureCapabilityAttestation and point the doctor remedy at the
new --refresh-capabilities flag.
EOF
)"
```

---

### Task 3: Build the local CLI and prove doctor + observe smoke

**Files:**
- Possibly modify smoke-target only:  
  `/Users/adrianobradley/life's-work/autopilot-canary-20260723/.autopilot/config.json`  
  and/or  
  `/Users/adrianobradley/life's-work/jinn-mono/.worktrees/autopilot-full-loop-canary/.autopilot/config.json`
- Do **not** commit smoke-target config changes unless they belong in this repo (they usually do not).

**Interfaces:**
- Consumes: built `dist/autopilot.js`
- Produces: recorded exact smoke commands + outcomes for README Task 4

- [ ] **Step 1: Build the distribution**

From the autopilot product repo:

```bash
yarn install
yarn build
yarn verify:dist
node dist/autopilot.js --help
```

Expected: usage includes `autopilot doctor [--json] [--refresh-capabilities]`.

- [ ] **Step 2: Probe candidate targets for doctor blockers**

Run against each candidate with the built binary (cwd = target repo):

```bash
AUTOPILOT_BIN="/Users/adrianobradley/life's-work/autopilot/dist/autopilot.js"

cd "/Users/adrianobradley/life's-work/autopilot-canary-20260723"
node "$AUTOPILOT_BIN" doctor --json | tee /tmp/autopilot-doctor-canary.json

cd "/Users/adrianobradley/life's-work/jinn-mono/.worktrees/autopilot-full-loop-canary"
node "$AUTOPILOT_BIN" doctor --json | tee /tmp/autopilot-doctor-mono-canary.json
```

Choose the target with fewer blocking checks / faster path to green.
Prefer `autopilot-canary-20260723` when credentials are restorable.

- [ ] **Step 3: Clear blocking checks on the chosen target**

Apply only what is needed:

1. **credentials** — export `AUTOPILOT_GITHUB_IMPLEMENT_TOKEN` (and optional distinct review token), or ensure `~/.autopilot/repositories/<stateKey>/credentials.json` is present and mode `0600`.
2. **disk** — if free space `< safety.diskFloorGb`, lower that target’s `safety.diskFloorGb` in its `.autopilot/config.json` (smoke-only; keep product init default at 10).
3. **git-ref-capabilities** — run:

```bash
node "$AUTOPILOT_BIN" doctor --refresh-capabilities --json
```

Re-run `doctor --json` until `"blocking": false`.

Do not invent a brand-new target repo unless both candidates cannot be repaired quickly.

- [ ] **Step 4: Run observe smoke**

From the chosen target cwd:

```bash
node "$AUTOPILOT_BIN" observe --once --json | tee /tmp/autopilot-observe-once.json
echo "exit=$?"
```

Expected: process exits successfully for product-shell wiring purposes (exit 0, or an explicit lifecycle status that is not “CLI missing config / unknown command”). Record the exact binary path, cwd, env vars used (names only — never tokens), and outcome in the commit message notes / README draft notes.

- [ ] **Step 5: Commit product-repo changes only**

If Task 3 required no product-repo code changes, create an empty commit is **not** allowed. Instead, write a short smoke note into the upcoming README (Task 4) and proceed. If you adjusted only external canary configs, leave them uncommitted in this repo.

If any product-repo helper was needed during smoke, commit that separately with a clear message.

---

### Task 4: Rewrite README for colleague onboarding

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: proven commands from Task 3
- Produces: accurate local-install onboarding doc

- [ ] **Step 1: Replace README contents**

Rewrite `README.md` to this structure (keep concise; use the exact commands proven in smoke):

```markdown
# Autopilot

Autopilot is a self-hosted GitHub lifecycle engine for open-source
maintainers. It watches a repository’s GitHub Project, claims ready issues,
launches isolated workers, reviews exact PR heads, recovers durable work
after interruption, and leaves merge control with the maintainer by default.

## Status

The npm global package is not published yet. Install from a local clone of
this repository.

## Prerequisites

- macOS or Linux
- Node 22
- Git and authenticated GitHub CLI (`gh`)
- Authenticated Hermes with the Jinn plugin installed and enabled
- An organization-owned public GitHub repository where you have admin rights
- An implementation GitHub token (`AUTOPILOT_GITHUB_IMPLEMENT_TOKEN`), and
  optionally a distinct review token (`AUTOPILOT_GITHUB_REVIEW_TOKEN`)

## Install from this clone

```text
cd /path/to/autopilot
yarn install
yarn build
yarn link
# or: alias autopilot="node /path/to/autopilot/dist/autopilot.js"
```

## Initialize a target repository

Run Autopilot against the repository it should operate — not against this
product repo unless that is intentional.

```text
cd /path/to/target-repo
export AUTOPILOT_GITHUB_IMPLEMENT_TOKEN=...
# optional: export AUTOPILOT_GITHUB_REVIEW_TOKEN=...
autopilot init
autopilot doctor
```

If Git ref capability attestation is missing or stale:

```text
autopilot doctor --refresh-capabilities
autopilot doctor
```

`mergePolicy` defaults to `manual`. In manual mode Autopilot can bring work
to `merge-ready`, but cannot construct or execute a merge action.

## Concurrency caps

Edit `<target>/.autopilot/config.json`:

```json
"scheduler": {
  "pollSeconds": 600,
  "fullReconcileSeconds": 3600,
  "implementationConcurrency": 1,
  "reviewConcurrency": 1,
  "openPrBackpressure": 30
}
```

`init` defaults both concurrency fields to `1`. After changing them, restart
the daemon (`autopilot stop` then `autopilot start`) so the new config loads.

Optional one-off overrides:

- `JINN_AUTOPILOT_IMPLEMENTATION_CAP`
- `JINN_AUTOPILOT_REVIEW_CAP`
- `JINN_AUTOPILOT_BACKPRESSURE`

If `doctor` blocks on disk space, free space or deliberately lower
`safety.diskFloorGb` in that target config (default remains `10`).

## Read-only smoke

```text
autopilot observe --once
```

## Daily operation

```text
autopilot start
autopilot status
autopilot explain issue 123
autopilot logs --follow
autopilot stop
```

## Where state lives

- Repository config and maintainer skill lock: `<repo>/.autopilot/`
- Machine-local credentials, attestation, logs, attempts: `~/.autopilot/`
```

Adapt paths/examples only if smoke proved a clearer local invocation style (for example documenting `node dist/autopilot.js` before `yarn link`).

- [ ] **Step 2: Sanity-check README against the built CLI**

```bash
node dist/autopilot.js --help
rg -n "npm install --global|supervise.sh|JINN_IMPL_GH_TOKEN" README.md || true
```

Expected: help matches documented flags; README has no npm-global install claim and no mono supervise instructions.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: rewrite README for local CLI onboarding

Document clone/build install, concurrency caps, capability refresh, and
the doctor + observe smoke path a colleague can follow today.
EOF
)"
```

---

### Task 5: Final verification gate

**Files:** none required

- [ ] **Step 1: Run product-shell regression**

```bash
yarn typecheck
yarn vitest run test/cli/arguments.test.ts test/doctor.test.ts
yarn build && yarn verify:dist
```

Expected: all PASS.

- [ ] **Step 2: Reconfirm smoke still works with the final binary**

From the chosen target cwd:

```bash
node /Users/adrianobradley/life's-work/autopilot/dist/autopilot.js doctor --json
node /Users/adrianobradley/life's-work/autopilot/dist/autopilot.js observe --once --json
```

Expected: doctor `"blocking": false`; observe completes as in Task 3.

- [ ] **Step 3: Summarize for the human**

Report:
- commits on `docs/operator-onboarding-local-cli`
- which target was smoked
- exact install + doctor + observe commands that worked
- any smoke-only config tweaks left outside this repo

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| Local build/link install path | 3, 4 |
| `doctor --refresh-capabilities` | 1, 2 |
| Doctor remedy names that command | 2 |
| Keep diskFloorGb default 10; target-only override | 3, 4 |
| Caps documented via config | 4 |
| Smoke: doctor green + observe --once | 3, 5 |
| README rewrite, no false npm claim | 4 |
| No mono supervise migration / no active start | Global + Task 3 |

## Placeholder / consistency check

- Command name is consistently `autopilot doctor --refresh-capabilities`.
- Doctor command type always includes `refreshCapabilities: boolean`.
- Status does not accept the new flag.
- No npm-publish or supervise migration tasks.
