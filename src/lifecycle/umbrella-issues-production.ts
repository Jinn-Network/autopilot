/**
 * Production umbrella closer (#160).
 *
 * One readback, one `gh issue close`, one confirming readback — the same
 * readback-before-write shape the board-triage writer uses, and for the same
 * reason: the plan was derived from a snapshot, and everything it asserted may
 * have changed underneath. Here the assertion is "every child of this umbrella
 * is closed", so the readback re-proves it against live state and refuses,
 * naming the child, when it cannot.
 *
 * Closed WITHOUT a comment, deliberately. The engine does not write comments on
 * issues, so the evidence goes where the rest of this cycle's evidence goes —
 * the cycle log, which names the children by number — and the close itself
 * carries `--reason completed`, which is the state-change reason GitHub records
 * on the issue for anyone reading it later.
 *
 * Children are read as `issueOrPullRequest`, so an umbrella whose task list
 * names a pull request resolves it rather than tripping over it: an Issue
 * counts as done at `CLOSED`, a PullRequest at `CLOSED` or `MERGED`. A child
 * that resolves to nothing at all is NOT read as closed — it is unverifiable,
 * and this action refuses rather than close an issue on evidence it could not
 * read.
 */

import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { REPO } from '../dispatcher/constants.js';
import { externalHumanLabel } from './human-authority.js';
import { isUmbrellaIssue } from './umbrella-issues.js';
import type { NewWorkAction } from './types.js';

type CloseUmbrellaAction = Extract<NewWorkAction, { kind: 'close-umbrella' }>;

export interface ProductionUmbrellaClosureOptions {
  readonly runner?: CommandRunner;
  readonly repo?: string;
}

interface UmbrellaState {
  readonly open: boolean;
  readonly body: string;
  readonly labels: readonly string[];
  /** `true` closed, `false` open, `null` unreadable — never conflated. */
  readonly children: ReadonlyMap<number, boolean | null>;
}

function splitRepo(repo: string): readonly [string, string] {
  const [owner, name, ...unexpected] = repo.split('/');
  if (
    owner === undefined || owner.length === 0
    || name === undefined || name.length === 0
    || unexpected.length > 0
  ) {
    throw new Error('Umbrella closure repository must be owner/name');
  }
  return [owner, name];
}

/**
 * One round trip for the umbrella and every child it names. The child fields
 * are aliased into the query text rather than passed as variables because
 * GraphQL has no way to parameterise a field selection — which is exactly why
 * every number is re-validated as a safe positive integer first, before it can
 * reach the query string.
 */
function stateQuery(childIssueNumbers: readonly number[]): string {
  const children = childIssueNumbers.map((child, index) => (
    `    child${index}: issueOrPullRequest(number: ${child}) {\n`
    + '      __typename\n'
    + '      ... on Issue { number state }\n'
    + '      ... on PullRequest { number state }\n'
    + '    }'
  )).join('\n');
  return 'query UmbrellaClosureState($owner: String!, $name: String!, $number: Int!) {\n'
    + '  repository(owner: $owner, name: $name) {\n'
    + '    umbrella: issue(number: $number) {\n'
    + '      number\n'
    + '      state\n'
    + '      body\n'
    + '      labels(first: 100) { nodes { name } }\n'
    + '    }\n'
    + `${children}\n`
    + '  }\n'
    + '}\n';
}

function childClosed(node: unknown): boolean | null {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return null;
  const state = (node as { state?: unknown }).state;
  if (typeof state !== 'string') return null;
  // MERGED is a pull-request terminal state; an issue never carries it.
  return state === 'CLOSED' || state === 'MERGED';
}

async function readUmbrellaState(
  runner: CommandRunner,
  action: CloseUmbrellaAction,
  repo: string,
): Promise<UmbrellaState> {
  const [owner, name] = splitRepo(repo);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await runner('gh', [
      'api',
      'graphql',
      '-f',
      `query=${stateQuery(action.childIssueNumbers)}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-F',
      `number=${action.issueNumber}`,
    ])) as unknown;
  } catch {
    throw new Error('Malformed umbrella closure state readback');
  }
  const repository = (parsed as {
    data?: { repository?: Record<string, unknown> | null };
  }).data?.repository;
  const umbrella = repository?.umbrella;
  if (
    typeof umbrella !== 'object'
    || umbrella === null
    || Array.isArray(umbrella)
    || typeof (umbrella as { state?: unknown }).state !== 'string'
  ) {
    throw new Error(`Umbrella #${action.issueNumber} is missing or malformed`);
  }
  const labelNodes = (umbrella as {
    labels?: { nodes?: readonly { name?: unknown }[] | null } | null;
  }).labels?.nodes ?? [];
  const children = new Map<number, boolean | null>();
  action.childIssueNumbers.forEach((child, index) => {
    children.set(child, childClosed(repository?.[`child${index}`]));
  });
  return {
    open: (umbrella as { state: string }).state === 'OPEN',
    body: typeof (umbrella as { body?: unknown }).body === 'string'
      ? (umbrella as { body: string }).body
      : '',
    labels: labelNodes.flatMap((node) => (
      typeof node.name === 'string' ? [node.name] : []
    )),
    children,
  };
}

/**
 * Closes one umbrella, or reports why it did not.
 *
 * Every refusal is a `skipped` with a reason, never a failure: an umbrella a
 * human already closed, took over, rewrote, or re-opened a child of is the
 * mechanism working, not breaking. The one thrown error is a close GitHub
 * accepted without applying — reporting that as closed would leave the next
 * cycle re-deriving the identical action with nothing in the log to explain it.
 */
export async function executeProductionUmbrellaClosure(
  action: CloseUmbrellaAction,
  options: ProductionUmbrellaClosureOptions = {},
): Promise<{
  readonly status: string;
  readonly detail?: string;
  readonly reason?: string;
}> {
  if (action.childIssueNumbers.length === 0) {
    throw new Error('Close-umbrella action names no child');
  }
  for (const child of action.childIssueNumbers) {
    if (!Number.isSafeInteger(child) || child <= 0) {
      throw new Error(`Invalid umbrella child number: ${child}`);
    }
  }
  const runner = options.runner ?? defaultRunner;
  const repo = options.repo ?? REPO;

  const current = await readUmbrellaState(runner, action, repo);
  if (!current.open) {
    return { status: 'skipped', reason: `Issue #${action.issueNumber} is already closed` };
  }
  const humanLabel = externalHumanLabel(current.labels);
  if (humanLabel !== undefined) {
    return { status: 'skipped', reason: `Issue #${action.issueNumber} carries ${humanLabel}` };
  }
  if (!isUmbrellaIssue({ body: current.body, labels: current.labels })) {
    return {
      status: 'skipped',
      reason: `Issue #${action.issueNumber} no longer declares itself an umbrella`,
    };
  }
  for (const child of action.childIssueNumbers) {
    const closed = current.children.get(child);
    if (closed === null || closed === undefined) {
      return { status: 'skipped', reason: `Child #${child} could not be read` };
    }
    if (!closed) return { status: 'skipped', reason: `Child #${child} is open` };
  }

  await runner('gh', [
    'issue',
    'close',
    String(action.issueNumber),
    '--repo',
    repo,
    '--reason',
    'completed',
  ]);

  const final = await readUmbrellaState(runner, action, repo);
  if (final.open) {
    throw new Error(`Umbrella #${action.issueNumber} is still open after its close`);
  }
  return {
    status: 'closed',
    detail: `children ${action.childIssueNumbers.map((child) => `#${child}`).join(', ')}`,
  };
}
