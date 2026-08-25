/**
 * Rate-limit guard — floor constant for gating a dispatcher cycle on GraphQL
 * budget.
 *
 * The floor exists to leave headroom for in-flight sessions, which call `gh`
 * independently of the dispatcher's per-cycle budget. Without it, a
 * dispatcher cycle that succeeds with `remaining=1` could leave nothing for a
 * session mid-`gh pr create`.
 *
 * Tracking: jinn-mono#585.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum GraphQL points that must remain before the dispatcher will run a
 * cycle. Below this, the gate trips and the orchestrator sleeps until the
 * rate-limit window resets.
 *
 * 500 points is comfortable headroom — a typical session consumes 50-200
 * points over its lifetime, so 500 covers at least one concurrent session
 * completing its work even if the dispatcher's own consumption ticks up.
 */
export const DEFAULT_FLOOR = 500;
