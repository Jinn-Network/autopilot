/**
 * Process-group teardown for detached children.
 *
 * A child spawned with `detached: true` is a group (and session) leader, so
 * `kill(-pid, …)` reaches everything it started. Signalling only the direct
 * child leaves those descendants behind as orphans (`ppid 1`) — in #167,
 * three `vitest` trees from a finished attempt were still running an hour
 * later against a worktree the sweep was deleting underneath them.
 *
 * The primitives live here, rather than inside one caller, because the relay
 * evaluator (`issue-relay/evaluator/supervised-process.ts`) and the worker
 * lifecycle both need exactly this and must not drift apart.
 */

/** Milliseconds a group gets to leave on SIGTERM before SIGKILL. */
export const DEFAULT_PROCESS_GROUP_GRACE_MS = 10_000;

/**
 * Signals a whole process group. The negative PID is the group id, so this
 * only means "the group" for a process that leads one — i.e. one spawned
 * `detached`.
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  process.kill(-pid, signal);
}

/**
 * Whether any member of `pid`'s process group is still alive.
 *
 * `EPERM` counts as alive: the group exists and this process merely may not
 * signal it, which must never be read as "nothing left to tear down".
 */
export function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface TerminateProcessGroupOptions {
  /** The detached child's PID, which is also its process-group id. */
  readonly pid: number;
  /** Defaults to DEFAULT_PROCESS_GROUP_GRACE_MS. */
  readonly graceMs?: number;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly isAlive?: (pid: number) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Deliberately a REF'd timer. Unreffing it would let the signalling process
 * exit during the grace period and skip the SIGKILL escalation, which is the
 * half of the sequence that reaps a group ignoring SIGTERM — exactly the case
 * the grace exists for.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Bounded SIGTERM -> grace -> SIGKILL over one process group.
 *
 * Returns how many signals were delivered: `0` when the group was already
 * gone (callers use that to stay silent), `1` when SIGTERM was enough, `2`
 * when the group had to be killed. A signal the group refuses because it
 * vanished mid-sequence still counts — it was sent, and the vanishing is the
 * outcome this function wanted.
 */
export async function terminateProcessGroup(
  options: TerminateProcessGroupOptions,
): Promise<number> {
  const isAlive = options.isAlive ?? isProcessGroupAlive;
  if (!isAlive(options.pid)) return 0;
  const kill = options.kill ?? killProcessGroup;
  const sleep = options.sleep ?? defaultSleep;
  const graceMs = options.graceMs ?? DEFAULT_PROCESS_GROUP_GRACE_MS;
  const signal = (value: NodeJS.Signals): void => {
    try {
      kill(options.pid, value);
    } catch {
      // ESRCH is the group leaving between the liveness check and the signal,
      // and EPERM is a group this process may observe but not signal. Neither
      // is worth failing an exit path over; the escalation below is bounded
      // either way.
    }
  };
  signal('SIGTERM');
  await sleep(graceMs);
  if (!isAlive(options.pid)) return 1;
  signal('SIGKILL');
  return 2;
}
