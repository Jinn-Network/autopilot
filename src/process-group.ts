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

/**
 * The direct children of `pid`, via `pgrep -P`.
 *
 * `pgrep` exits non-zero with no output when nothing matches — a leaf, the
 * common case — and that is not distinguishable here from a host without
 * `pgrep` at all. Answering "none" leaves such a host with exactly the group
 * signal it had before this walk existed.
 */
export async function childProcessesOf(
  pid: number,
  runner: (command: string, args: string[]) => Promise<string>,
): Promise<readonly number[]> {
  let output: string;
  try {
    output = await runner('pgrep', ['-P', String(pid)]);
  } catch {
    return [];
  }
  return output
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

/**
 * Descendants a runaway tree can plausibly hold. Bounds the walk against a
 * fork bomb; a tree wider than this is not one a bounded teardown can reap.
 */
const MAX_TREE_WALK = 4_096;

/** Every descendant of `pid`, breadth first, nearest first. */
async function listDescendants(
  pid: number,
  listChildren: (pid: number) => Promise<readonly number[]>,
): Promise<number[]> {
  const seen = new Set<number>([pid]);
  const descendants: number[] = [];
  const queue = [pid];
  while (queue.length > 0 && descendants.length < MAX_TREE_WALK) {
    const parent = queue.shift()!;
    let children: readonly number[];
    try {
      children = await listChildren(parent);
    } catch {
      children = [];
    }
    for (const child of children) {
      if (seen.has(child)) continue;
      seen.add(child);
      descendants.push(child);
      queue.push(child);
    }
  }
  return descendants;
}

function isPidAliveDefault(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface TerminateProcessTreeOptions extends TerminateProcessGroupOptions {
  /** Direct children of one PID — `childProcessesOf` in production. */
  readonly listChildren: (pid: number) => Promise<readonly number[]>;
  readonly killPid?: (pid: number, signal: NodeJS.Signals) => void;
  readonly isPidAlive?: (pid: number) => boolean;
}

/**
 * `terminateProcessGroup`, then every survivor by its own PID (#184).
 *
 * The group signal is the right primitive and usually enough, but on the host
 * that motivated this it did not take effect on three 42-hour session trees
 * while explicit PIDs did, and a teardown that cannot be relied on is no
 * teardown. The descendants are enumerated BEFORE the group is signalled: a
 * signal that kills the leader re-parents its children to PID 1, and a walk
 * from the leader afterwards would find nothing left to reap.
 *
 * Returns how many signals were delivered across both passes.
 */
export async function terminateProcessTree(
  options: TerminateProcessTreeOptions,
): Promise<number> {
  const descendants = await listDescendants(options.pid, options.listChildren);
  let signalled = await terminateProcessGroup(options);
  const isPidAlive = options.isPidAlive ?? isPidAliveDefault;
  const killPid = options.killPid ?? ((pid, signal) => { process.kill(pid, signal); });
  const sleep = options.sleep ?? defaultSleep;
  const graceMs = options.graceMs ?? DEFAULT_PROCESS_GROUP_GRACE_MS;
  const signal = (pids: readonly number[], value: NodeJS.Signals): void => {
    for (const pid of pids) {
      try {
        killPid(pid, value);
        signalled += 1;
      } catch {
        // Gone between the liveness check and the signal, or not ours to
        // signal: either way the bounded sequence below is the whole remedy.
      }
    }
  };
  const survivors = [options.pid, ...descendants].filter(isPidAlive);
  if (survivors.length === 0) return signalled;
  signal(survivors, 'SIGTERM');
  await sleep(graceMs);
  signal(survivors.filter(isPidAlive), 'SIGKILL');
  return signalled;
}
