---
name: reconcile
description: Use when Autopilot v2 dispatches a reconcile child issue. Merge origin/base into the parent PR branch (never rebase); resolve conflicts; close via child-complete.
---

# reconcile

You are the coordinator for one Autopilot v2 **reconcile** child attempt.
Merge the target base **into** the parent PR branch. Never rebase.

## Runtime adapter

Read [`autopilot-runtime`](../autopilot-runtime/SKILL.md). The prompt already
contains the packaged lifecycle canon and every repository instruction file
explicitly configured for this repository.

## Input contract

Autopilot v2 has already claimed the parent PR branch with phase `reconcile`,
created a detached attempt worktree, and set
`JINN_AUTOPILOT_SESSION_MANIFEST`. Fail closed if that context is missing.

```bash
SESSION_REPORT_DIR="$(dirname -- "$JINN_AUTOPILOT_SESSION_MANIFEST")/reports"
mkdir -p -- "$SESSION_REPORT_DIR"
chmod 700 -- "$SESSION_REPORT_DIR"
```

Shared mutations:

```bash
autopilot session checkpoint
autopilot session child-complete
autopilot session human --reason-file "$SESSION_REPORT_DIR/human-reason.md"
```

## Conflict taxonomy (routing, not refusal)

**Mechanical** — one behavior-preserving resolution visible from the two
patches: lockfile regeneration, import/formatting collisions, adjacent
non-overlapping edits, rename/path ports.

**Semantic** — choosing behavior or redesigning overlapping logic:
incompatible changes to the same function, competing abstractions/schemas,
resolutions that depend on product intent, CODEOWNER-sensitive paths.

Semantic resolutions are legitimate autonomous work when intent is clear from
both sides' issues/PRs/design record. Gather that context before editing.
Escalate when intent is genuinely undeterminable — never guess.

## Method

1. Confirm detached head matches the attempt context.
2. Merge `origin/<target-base>` **into** HEAD (never rebase).
3. Inspect every conflict before editing. Classify Mechanical vs Semantic.
4. For Semantic: gather both sides' issues, PRs, and design intent first.
5. Resolve inside the merge commit; regenerate lockfiles with their canonical
   tool (do not hand-edit generated output).
6. Write a summary that flags any judgment-call hunks to
   `$SESSION_REPORT_DIR/reconcile-summary.md`.
7. Publish with ordinary checkpoints (`session checkpoint` — append-only
   fast-forward). Trailers must reference this child issue.
8. Finish with `session child-complete`.

The parent receives a **full fresh review with no approval carry-over**.

## Escalation

Use `session human` on **this child** when confidence fails or a CODEOWNER
surface is involved. Hard is not a reason; undeterminable intent is.
