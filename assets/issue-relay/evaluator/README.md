# Autopilot Issue Relay evaluator

This directory is the release input for Autopilot's external Jinn evaluator
harness. It evaluates only `autopilot.issue-relay` V2 application tasks carried
by the generic `jinn-repo.v1` marketplace backend.

The harness:

- reconstructs adoption, exact-head checks, and the draft PR from public,
  bot-authored GitHub receipts;
- runs pinned upstream Claude `/security-review` and `/code-review` commands;
- checks the patch and PR description against base-revision repository
  guidance;
- optionally adds Snyk Code evidence;
- emits separate security and quality lane attestations inside Autopilot's
  application-owned result contract.

It has no GitHub token, wallet, signer, or repository mutation authority. The
Jinn daemon authenticates and transports its signed verdict; it does not own
the Relay evaluation policy.

For the first canary, run this package on a dedicated evaluator operator and
disable Mono's built-in `jinn-repo-evaluator` there. Jinn's evaluator dispatch
otherwise selects that earlier built-in first for `jinn-repo.v1`. Other
operators may continue to provide the ordinary evaluator. The external
harness receives only evaluation Tasks and rejects every Task that is not an
exact `autopilot.issue-relay` V2 application Task.

`jinn.manifest.template.json` is deliberately not installable. A release must
replace the package CID and hash, sign the manifest with the trusted evaluator
publisher key, and rename it to `jinn.manifest.json`. Never check a private
publisher key into this repository.

The skill files are deliberately not redistributed in this package. The
operator must set:

- `JINN_ISSUE_RELAY_CLAUDE_CODE_REVIEW_SKILL_PATH`
- `JINN_ISSUE_RELAY_CLAUDE_SECURITY_REVIEW_SKILL_PATH`

to local copies of the exact upstream commands below. Each admitted Relay task
pins the expected SHA-256 digest for both files; the evaluator refuses to run
if the configured bytes differ. This keeps the review methodology immutable
without treating third-party command text as Autopilot-owned code.

Reviewed sources:

- Claude `/code-review`: `anthropics/claude-code` at
  `66edf5358349356774812264b75b8ea792f0d0a3`.
- Claude `/security-review`: `anthropics/claude-code-security-review` at
  `0c6a49f1fa56a1d472575da86a94dbc1edb78eda`.

The Claude Code repository currently distributes its command under
Anthropic's commercial terms, so its text must not be copied into the
Autopilot package. The security-review repository is MIT licensed; it is also
kept external so both lanes have the same operator-pinned loading model.
