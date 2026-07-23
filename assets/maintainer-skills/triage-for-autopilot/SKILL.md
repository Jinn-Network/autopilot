---
name: triage-for-autopilot
description: Audit selected GitHub issues for Autopilot eligibility and apply only maintainer-confirmed triage changes.
---

# Triage issues for Autopilot

Start with the read-only inventory:

```text
autopilot triage --json
```

Let the maintainer select issues; do not silently triage the whole backlog.
For each selected issue, explain every missing or contradictory eligibility
fact: Issue Type, Effort, Priority, Blocked on, Sprint, author allowlist, open
state, and existing claim or pull request evidence.

Propose the smallest correction. Confirm Issue Type (`feat`, `fix`,
`refactor`, `spike`, `chore`, `docs`, `test`, `incident`, or `design`), Effort
(`low`, `medium`, `high`, `xhigh`, or `max`), Priority (`p0`–`p4`), and Blocked
on (`nothing`, `human`, or `anotherIssue`). Never invent a Sprint.

Write one owner-only JSON input per issue, then preview:

```text
autopilot issue triage <N> --input <json-file>
```

Show the deterministic preview and ask for confirmation. Apply only confirmed
issues:

```text
autopilot issue triage <N> --input <json-file> --apply
```

If one issue fails after a partial GitHub response, stop and rerun its preview;
the helper reads back current state and safely completes only missing changes.
Never pass token values in commands and remove exact temporary files.
