# Task 2 report — execution-backend configuration and adapters

## Scope completed

- Added `parseAutopilotExecutionBackend(raw)` with the process-local
  `JINN_AUTOPILOT_EXECUTION_BACKEND` contract: unset, empty, and whitespace-only
  values select `local`; only exact `local` and `marketplace` nonblank values
  are accepted; all other values, including surrounding whitespace, fail with
  one deterministic error.
- Kept the selector separate from the strict repository product schema and did
  not read or modify `JINN_EXECUTION_MODE` or `DispatcherConfig.executionMode`.
- Added a generic `SessionExecutionBackend` interface with `start`, `recover`,
  and `cancel`, plus discriminated implementation and exact-head-review session
  requests.
- Added `LocalSessionExecutionBackend`, which receives injected local launch
  and tracking functions. Its `start` owns the existing spawn → PID check →
  tracking sequence. Its recovery and cancellation outcomes explicitly report
  unsupported because existing V2 semantics recover from attempt/worktree state
  and have no safe per-session control protocol.
- Added `MarketplaceSessionExecutionBackend`, whose constructor accepts no
  local capabilities and whose operations consistently return the stable
  foundation outcome: `Marketplace session submission and adoption are not
  enabled yet.` The marketplace request surface has no local launch input or
  credential-bearing environment.
- Did not change executor or production-runtime wiring; Task 4 remains the
  owner of that integration.

## TDD evidence

1. Added the focused parser and backend conformance tests before the production
   modules.
2. Ran `yarn vitest run test/config/execution-backend.test.ts
   test/lifecycle/session-execution-backend.test.ts`; it produced the expected
   RED because both new production modules were unresolved.
3. Added the minimal parser and adapters.
4. Re-ran the focused tests GREEN: 2 files, 14 tests passed.

## Verification

- `yarn vitest run test/config/execution-backend.test.ts test/lifecycle/session-execution-backend.test.ts` — passed (2 files, 14 tests).
- `yarn typecheck` — passed.
- `yarn test` — passed (138 files; 1,869 passed, 40 skipped).
- `git diff --check` — passed.

## Self-review

- Local functions and tracking dependencies are private to the local adapter;
  the marketplace adapter cannot hold or invoke them.
- The shared marketplace request excludes the local spawn input, so it cannot
  expose the per-attempt sanitized GitHub credential environment.
- Existing configuration schemas and legacy execution-mode fields are unchanged.

## Concerns

None for this slice. The intentionally unsupported local recover/cancel and
marketplace unavailable outcomes need production wiring and preflight handling
in Task 4; marketplace submission/adoption is intentionally deferred.
