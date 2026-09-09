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
  optionally a distinct review token (`AUTOPILOT_GITHUB_REVIEW_TOKEN`) — only
  when credentials are not already stored under `~/.autopilot/` (see
  [Where state lives](#where-state-lives))

## Install from this clone

```text
cd /path/to/autopilot
yarn install
yarn build
node dist/autopilot.js --help
```

Invoke from any directory with the built bundle (this is the proven local path):

```text
node /path/to/autopilot/dist/autopilot.js --help
```

Optional: add a shell alias so the examples below can use `autopilot`:

```text
alias autopilot="node /path/to/autopilot/dist/autopilot.js"
```

Yarn 4 (`yarn link`) does not put `autopilot` on your PATH; use
`node /path/to/autopilot/dist/autopilot.js` or the alias above.

## Initialize a target repository

Run Autopilot against the repository it should operate — not against this
product repo unless that is intentional.

```text
cd /path/to/target-repo
# skip exports when credentials already live in ~/.autopilot/
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

The implementation token must be allowed to push disposable Git refs on the
target repository; `doctor --refresh-capabilities` uses that permission to
probe and record live ref capabilities. When `AUTOPILOT_GITHUB_REVIEW_TOKEN`
is set, it must belong to a different GitHub identity than the
implementation token.

`mergePolicy` defaults to `manual`. In manual mode Autopilot can bring work
to `merge-ready`, but cannot construct or execute a merge action.

## Concurrency caps

Edit `<target>/.autopilot/config.json`:

```json
"scheduler": {
  "pollSeconds": 600,
  "fullReconcileSeconds": 3600,
  "implementationConcurrency": 1,
  "childConcurrency": 1,
  "debtConcurrency": 0,
  "reviewConcurrency": 1,
  "codexOverflowSlots": 0,
  "openPrBackpressure": 30
}
```

Three independent lanes. `implementationConcurrency` bounds fresh claims on
new issues; `childConcurrency` bounds machine-child work (review-finding,
reconcile, and CI-failure fixes on branches that already exist);
`reviewConcurrency` bounds review sessions. They are separate so a burst in
one lane cannot starve the others — a deep child queue is the moment the
engine most needs children to run and least needs new branches opened.

`codexOverflowSlots` (default 0, off) adds a pool of Codex sessions that the
implementation and child lanes may spill into when they are full: a fresh
claim a lane cannot seat runs on `codex exec` in its own worktree instead of
waiting. The review lane never overflows — it is the quality gate and stays
on the process-wide runtime. The pool also carries a session-limit fallback:
when two `claude` workers in ten minutes die within a minute of starting (the
signature of an exhausted Claude session), new implementation work prefers the
pool for thirty minutes, and a `claude` worker that runs normally closes the
circuit again. The Codex CLI must be installed and logged in
(`codex login`); `worker.codexModel` optionally pins its model.

`debtConcurrency` (default `0`, off) gives debt sweeps — the batched review
follow-ups the engine files itself — their own lane. A sweep is capped at P2
by design, so while it shares the implementation lane it loses every cycle to
P0/P1 work and the follow-up backlog only grows. Set it to `1` or more and
sweeps schedule from their own slots instead, appearing as `lane:debt` in the
starvation and fall-through lines; at `0` nothing is tagged for the lane and
scheduling is exactly as it was.

`init` defaults every concurrency field to `1`, and `childConcurrency` is
optional: a config written before the lane existed keeps loading and gets the
same `1`. After changing them, restart the daemon (`autopilot stop` then
`autopilot start`) so the new config loads.

Optional one-off overrides:

- `JINN_AUTOPILOT_IMPLEMENTATION_CAP`
- `JINN_AUTOPILOT_CHILD_CAP`
- `JINN_AUTOPILOT_DEBT_CAP`
- `JINN_AUTOPILOT_REVIEW_CAP`
- `JINN_AUTOPILOT_BACKPRESSURE`

If `doctor` blocks on disk space, free space or deliberately lower
`safety.diskFloorGb` in that target config (default remains `10`). When the
shortfall is smaller than what the engine's own trash is already queued to
reclaim, `doctor` says so instead: those bytes are coming back on their own.

The floor is evaluated against *projected* free space, not only current free
space: a spawn's worktree lands minutes after the spawn, so the scheduler
charges every attempt still settling — and every spawn this cycle already made
— its expected footprint before admitting the next one. Expected footprint
comes from what attempts have actually cost on this host, falling back to
`safety.attemptFootprintGb` (default `{ "implement": 8, "review": 1 }`, in GB)
until there is history. Measured costs are kept in
`~/.autopilot/repositories/<repo>/attempts/attempt-footprints.json` so they
survive the attempt sweep. That key is optional: a config written before it
existed keeps loading and gets those defaults. Every active cycle logs one
`disk: free=… reserved=… floor=… settling=… trash=… admits=…` line, and a
candidate the floor holds back reports `disk-floor` with the arithmetic that
produced it. `trash=N (xG)` is the dead worktrees whose bytes have not come
back yet, so `admits=none` can be read as a reclaim backlog rather than as a
full disk.

## Reclaiming dead worktrees

```json
"cleanup": {
  "reclaimConcurrency": 3
}
```

A dead attempt's worktree leaves `attempts/v2` in one rename, but its bytes
stay on the volume until an `rm -rf` finishes, and a node_modules-heavy 6 GB
checkout takes minutes. Dispatch produces dead worktrees faster than one
removal at a time frees them, which is how 18 of them came to hold ~40 GB
while admission starved under a 20 GB floor. `cleanup.reclaimConcurrency`
(default `3`) is how many of those removals run at once on this host, biggest
worktrees first, so the volume comes back faster than the engine spends it.
When the queue is deeper than one cycle can start, the sweep also logs
`cleanup reclaim backlog: N worktree(s), xG`. The pool is host-wide and
survives restarts: each removal is owned by a
recorded pid, and the next sweep tops the pool up rather than starting a
second removal of the same directory. Raise it on a host with disk to spare;
`0` is refused, because a pool that never frees a byte is the failure it
exists to prevent. The key is optional — a config written before it existed
keeps loading and gets the three.

## Board triage defaults

An issue on the Project board with no **Priority**, no native **Issue Type**,
or an empty **Blocked on** is refused by the eligibility cascade and never
claimed. Autopilot fills those three gaps itself:

```json
"triage": {
  "allowedAuthors": ["octocat"],
  "defaultPriority": "P3",
  "inferIssueType": true
}
```

`defaultPriority` (default `P3`) is written to any ordinary board issue that
has none, through the same `gh project item-edit` path and readback guard the
machine-child repair uses. `inferIssueType` (default `true`) sets a missing
Issue Type **only** from an explicit conventional title prefix — `fix:`,
`feat(scope)`, `chore …`, `refactor`, `docs`, `test`, `design`, `spike`,
`incident`. A title with no prefix keeps no type and is never guessed at: the
type decides what kind of session runs, so a wrong guess costs more than the
wait. An empty `Blocked on` is written `Nothing` — the absence of a block
spelled out, which is what the cascade requires; `Human` and `Another issue`
are deliberate operator holds and are never touched. Machine children are left
to their own repair.

Both keys are optional — a config written before they existed keeps loading
and gets these defaults. At most ten issues are triaged per cycle, so a first
run over a neglected board cannot turn one cycle into a mutation burst; the
rest are picked up by later cycles. Every cycle also logs one
`untriaged: no-type=… no-priority=… no-blocked-on=…` line, and
`backlog: ordinary=` counts only issues that pass the triage cascade — the
claimable number, not the open-issue number.

## Worker session lifetime

```json
"worker": {
  "backgroundWaitCeilingMs": 3600000,
  "mcpServers": {}
}
```

`claude -p` waits for the background tasks a session started after its final
turn, then terminates the session. Its own ceiling is 600 s, which kills
engine sessions at the finish line: a session that has worked for hours,
checkpointed its fix and is re-running verification in the background is
terminated before it can mark the implementation phase complete, and the whole
multi-stage skill is re-run on the next claim. `worker.backgroundWaitCeilingMs`
raises that ceiling to an hour by default and is passed to every `claude -p`
worker as `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`. `0` means wait indefinitely.
The key is optional: a config written before it existed keeps loading and gets
the hour. An operator who exports `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`
themselves outranks the config — the exported value is passed through
untouched. The ceiling is a `claude -p` knob only; hermes, cursor and codex
workers never see it.

`worker.mcpServers` is the whole set of MCP servers a worker may reach. Every
`claude -p` worker is launched with `--strict-mcp-config` and an engine-owned
document naming exactly these servers, so the operator's user-level
`~/.claude.json` and any repository `.mcp.json` no longer reach a worker at
all. The default is empty — no MCP servers — which is what the lifecycle
needs: no packaged engine skill uses one. Before this, a worker's toolset was
decided by whoever had last run `claude` on the host, which on the machine
that motivated it meant a live Chrome DevTools bridge and the operator's
personal data store under every session, plus two extra processes per worker
across the whole concurrency width. An operator who wants a server grants it
here by name, and the entry is passed to the CLI verbatim:

```json
"worker": {
  "mcpServers": {
    "jinn-notes": { "command": "npx", "args": ["-y", "jinn-notes-mcp"] }
  }
}
```

The document is written to `mcp-config.json` in the attempt directory, beside
`session.log`, so what a worker was granted is inspectable after the run. The
key is optional: a config written before it existed keeps loading and grants
nothing. The first `claude -p` worker of a cycle whose ambient
`~/.claude.json` declares servers the engine is dropping logs one
`[autopilot] worker mcp: ignoring 2 ambient server(s) (chrome-devtools, personal-os)`
line; a `~/.claude.json` that cannot be read is not an error and logs nothing.
Like the wait ceiling, this is a `claude -p` knob only — hermes, cursor and
codex workers are launched exactly as before.

When a worker exits, its process group is torn down — `SIGTERM`, a ten-second
grace, then `SIGKILL` — so background jobs it started (test runners, servers)
cannot outlive it as orphans holding a worktree that is about to be deleted.
A teardown that found something alive logs one
`[autopilot] coordinator teardown session=… pgid=… signalled=…` line.
Independently, the attempt sweep refuses to remove a worktree that still hosts
a live process, retaining it with a `live` reason until a later cycle finds
the process gone.

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

Internal operators running the separate Jinn mono marketplace canary should
use the [Jinn Issue Relay runbook](docs/runbooks/jinn-issue-relay-jinn-mono.md).
It is not part of the normal Project lifecycle or an authorization to deploy a
continuous active loop.

The initialization command installs a generic maintainer skill pack for
filing, triaging, and explaining Autopilot work. The Jinn Plugin owns its own
capture, retrieval, privacy, corpus, and publication behavior; Autopilot only
requires it to be installed and enabled in each Hermes worker.

## Where state lives

- Repository config and maintainer skill lock: `<repo>/.autopilot/`
- Machine-local credentials, attestation, logs, attempts: `~/.autopilot/`
