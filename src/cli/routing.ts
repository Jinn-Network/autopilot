// Side-effect-free routing helper extracted from `scripts/run-autopilot.ts`
// so unit tests (and any other consumer) can import it WITHOUT triggering the
// script's top-level `main().catch(...)` — which would spawn `gh project
// field-list` during `yarn test`, surfacing noisy stderr locally and hanging
// CI runs that lack `gh` auth. Keep this module zero-side-effect.

/** Route the singular, attempt-internal lifecycle protocol shell. */
export function shouldRouteToSession(argv: string[]): boolean {
  return argv[2] === 'session';
}
