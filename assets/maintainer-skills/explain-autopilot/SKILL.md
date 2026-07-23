---
name: explain-autopilot
description: Explain Autopilot lifecycle state for a repository, issue, or pull request from read-only engine evidence.
---

# Explain Autopilot

Use only Autopilot's read-only evidence commands:

```text
autopilot status --json
autopilot explain issue <N> --json
autopilot explain pr <N> --json
```

Choose the narrowest command that answers the maintainer's question. Translate
the returned evidence into plain language: current derived state, exact head or
claim generation when present, gates already satisfied, the next possible
transition, and the precise reason work is waiting.

Never infer a state that the command did not return. Distinguish `merge-ready`
from merged: under the default manual policy, merge-ready is a stable waiting
state. Do not mutate Project fields, issues, pull requests, refs, daemon state,
or plugin state while explaining.
