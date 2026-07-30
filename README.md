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
node dist/autopilot.js --help
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
