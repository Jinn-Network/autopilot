---
name: file-issue
description: Prepare and file a GitHub issue that is complete enough for Autopilot to claim without a second interpretation pass.
---

# File an issue for Autopilot

Use this skill when the maintainer wants to file a bug, feature, refactor,
investigation, documentation task, test task, incident, or design task.

## Interview

Ask only for facts that are still missing. Keep the interview concise:

1. What observable behavior should change, and why?
2. What is in scope and explicitly out of scope?
3. What repository evidence, paths, errors, or reproduction steps matter?
4. What independently checkable outcomes prove completion?

Turn completion outcomes into binary acceptance criteria. Each criterion must
be decidable as pass or fail from repository state, tests, or named observable
behavior. Do not use criteria such as "works well", "is robust", or "looks
good" without a concrete measurement.

Confirm the Issue Type (`feat`, `fix`, `refactor`, `spike`, `chore`, `docs`,
`test`, `incident`, or `design`), Effort (`low`, `medium`, `high`, `xhigh`, or
`max`), and Priority (`p0`–`p4`) with the maintainer.

## Preview and create

Write an owner-only temporary JSON file with this strict shape:

```json
{
  "title": "concise outcome-oriented title",
  "body": "context, scope, evidence, and constraints",
  "acceptanceCriteria": [
    "an independently checkable pass/fail outcome"
  ],
  "type": "feat",
  "effort": "medium",
  "priority": "p2"
}
```

Run `autopilot issue create --input <json-file>` first. Show its preview
verbatim. Creation is a mutation and requires explicit maintainer confirmation.
Only after confirmation run:

```text
autopilot issue create --input <json-file> --apply
```

Never call `gh issue create` directly, never place token values in commands,
and always remove the exact temporary file when finished.
