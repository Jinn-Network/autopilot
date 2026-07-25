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

## Fix Round 1 — reviewed request boundaries and local conformance

### Changes

- Added explicit `backend: 'local' | 'marketplace'` discrimination to request
  types and made `SessionExecutionBackend` generic over its matching backend
  and request type.
- `MarketplaceSessionExecutionBackend` now accepts only
  `MarketplaceSessionExecutionRequest`, which declares `local?: never`; a
  `LocalSessionExecutionRequest` (and its credential-bearing launch input)
  cannot be passed without a type escape. The local adapter accepts only the
  local request type in all three methods.
- Added `reviewedHead` and non-secret `reviewerLogin` to the exact-head review
  common request, so marketplace review has the precise fenced head and review
  identity without inspecting local launch data.
- Expanded local adapter conformance coverage for both implementations and
  exact-head reviews: correct spawner only, observable spawn → PID-read →
  track order, and no track on an absent PID. The marketplace adapter remains
  capability-free by construction.

### TDD and verification

1. Added the backend discriminator, exact-head identity, type-boundary, and
   spawn-order expectations before changing the adapter types.
2. Ran `yarn typecheck` and observed the expected RED: the old module did not
   export `MarketplaceSessionExecutionRequest`, had no request `backend`
   discriminator, and its broad marketplace method type could not satisfy the
   new type contract.
3. Added the minimum backend-specific request types and method signatures.
4. `yarn typecheck` — passed.
5. `yarn vitest run test/lifecycle/session-execution-backend.test.ts test/config/execution-backend.test.ts` — passed (2 files, 16 tests).
6. `yarn test` — passed (138 files; 1,871 passed, 40 skipped).

### Fix Round 1 self-review

- Marketplace methods have no path to a `local` payload: differing literal
  backend discriminators and `local?: never` make the public parameter types
  disjoint.
- The exact-head review request now has only non-secret routing identity;
  credential-bearing environment data remains solely under the local request.
- The newly observed call order is tied to real PID reads via a getter, so
  swapping tracking ahead of validation or dispatching the wrong spawner fails
  focused coverage.
