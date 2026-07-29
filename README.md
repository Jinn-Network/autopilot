# Autopilot

Autopilot is a self-hosted GitHub lifecycle engine for open-source
maintainers. It watches a repository’s GitHub Project, claims ready issues,
launches isolated Hermes workers, reviews exact PR heads, recovers durable work
after interruption, and leaves merge control with the maintainer by default.

Marketplace mode supports Solution adoption for submitted mutation Tasks.
Verdict adoption is the next slice.

## Install

Requirements: macOS or Linux, Node 22, Git, GitHub CLI, authenticated Hermes,
and an organization-owned public GitHub repository.

```text
npm install --global @jinn-network/autopilot
cd /path/to/repository
autopilot init
autopilot doctor
autopilot start
```

`mergePolicy` is `manual` by default. In manual mode Autopilot can bring work
to `merge-ready`, but cannot construct or execute a merge action.

## Daily operation

```text
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

Machine-local state defaults to `~/.autopilot`. Repository configuration and
the maintainer skill lock live under `.autopilot/` in the repository.
