/**
 * Umbrella issues (#160).
 *
 * An **umbrella** is an issue that declares, in its own body or by its own
 * label, that it will never be implemented directly: child issues own the
 * work and its acceptance criterion is satisfied by those children existing
 * and landing. The scheduler had no notion of the shape, so it read one as an
 * ordinary fresh claim — mono#2448 and mono#2396 each cost a claim commit, a
 * draft pull request, a worker session, and a human park before the session
 * discovered at Stage 0 that there was nothing to build.
 *
 * Two facts come out of this module, and only these two:
 *
 *  - `isUmbrellaIssue` — the shape. Consumed by the eligibility cascade, which
 *    refuses a fresh implementation claim and says why, and by the backlog
 *    summary, which stops counting an umbrella as claimable work.
 *  - `planUmbrellaClosures` — the umbrella's actual end state. When every child
 *    it declared is gone from the open set and nothing still names it as a
 *    parent, the umbrella is finished and a human is otherwise left to
 *    remember to close it.
 *
 * Pure and total: this module decides, it never writes. The mutation lives in
 * `umbrella-issues-production.ts`, behind the same `CommandRunner` seam as
 * every other `gh` action.
 *
 * Recognition is a MARKER or a LABEL, never a substring. An issue that merely
 * uses the word "umbrella" in prose is ordinary work, and mis-reading one as
 * an umbrella would strand it below the claim horizon forever — a strictly
 * worse failure than the one this module exists to fix.
 */

import { hasExternalHumanAuthority } from './human-authority.js';
import type { BlockedOn } from '../dispatcher/types.js';

/**
 * The operator-facing label. Compared case-insensitively and trimmed, because
 * a label set is typed by hand; `umbrella-ish` and `epic` are different labels
 * and match nothing.
 */
export const UMBRELLA_LABEL = 'umbrella';

/**
 * The handbook's own declaration, as both instances on mono actually wrote it.
 *
 * `children own implementation` rides mid-line ("Type: `feat` — umbrella;
 * children own implementation") and is distinctive enough as a three-word
 * phrase to match free — word-bounded on the tail, so the ordinary sentence
 * "children own implementations elsewhere" declares nothing. `Umbrella only`
 * is short enough to appear inside an ordinary sentence, so it is anchored to
 * the start of a line, past the markdown decoration a heading, list item,
 * quote or bold run puts there.
 */
const CHILDREN_OWN_IMPLEMENTATION = /children\s+own\s+implementation\b/i;
const UMBRELLA_ONLY_DECLARATION = /^[ \t>*_#-]*umbrella\s+only\b/im;

/**
 * A markdown task-list item naming an issue — the convention an umbrella body
 * uses to declare its children, and the only line shape read as one. A bare
 * `#123` in prose is a cross-reference, not a child, and counting it would let
 * an unrelated closed issue stand as evidence that this umbrella is finished.
 */
const DECLARED_CHILD = /^[ \t]*[-*+][ \t]+\[[ xX]\][^\n]*?#(\d+)\b/gm;

/**
 * The reverse edge: a child that names its parent. Anchored to its own line
 * (past `>` quoting and `**` bolding) for the same reason as above — "the
 * parent: #12 is named mid-sentence" declares nothing.
 */
const PARENT_DECLARATION = /^[ \t>*_]*parent:\**[ \t]*#(\d+)\b/im;

/**
 * How many umbrellas one cycle may close.
 *
 * `planUmbrellaClosures` is complete by design: the first armed cycle over a
 * board with a backlog of finished umbrellas would close all of them at once,
 * and a burst of closures against a board a human is also reading is not
 * recoverable by waiting. The remainder is: nothing about a finished umbrella
 * decays, and the next cycle re-derives it unchanged.
 */
export const MAX_UMBRELLA_CLOSURES_PER_CYCLE = 3;

/** The facts recognition reads — structurally a subset of `PolledIssue`. */
export interface UmbrellaSubject {
  readonly body?: string | null;
  readonly labels?: readonly string[];
}

export function isUmbrellaIssue(issue: UmbrellaSubject): boolean {
  for (const label of issue.labels ?? []) {
    if (label.trim().toLowerCase() === UMBRELLA_LABEL) return true;
  }
  const body = issue.body ?? '';
  return CHILDREN_OWN_IMPLEMENTATION.test(body) || UMBRELLA_ONLY_DECLARATION.test(body);
}

/**
 * The issue numbers an umbrella body declares as its children, in body order
 * and de-duplicated. At most one per task-list line: the first reference is
 * the child, and anything after it on the same line is that child's own prose.
 */
export function umbrellaDeclaredChildren(body: string): readonly number[] {
  const declared: number[] = [];
  for (const match of body.matchAll(DECLARED_CHILD)) {
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    if (!declared.includes(number)) declared.push(number);
  }
  return declared;
}

/** The umbrella an issue declares itself a child of, or `null`. */
export function parseUmbrellaParent(body: string): number | null {
  const match = PARENT_DECLARATION.exec(body);
  if (match === null) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** One OPEN issue, as the closure planner reads it. */
export interface UmbrellaClosureIssue {
  readonly number: number;
  readonly body?: string | null;
  readonly labels?: readonly string[];
  readonly blockedOn?: BlockedOn | null;
}

export interface UmbrellaClosurePlanItem {
  readonly issueNumber: number;
  /** The children whose closure is the evidence, ascending as declared. */
  readonly childIssueNumbers: readonly number[];
}

/**
 * Derives at most `MAX_UMBRELLA_CLOSURES_PER_CYCLE` closures, ascending by
 * issue number so the oldest finished umbrella goes first and the order is
 * identical on every cycle.
 *
 * `openIssues` MUST be the whole open set. Absence from it is the entire
 * evidence that a child closed, and on a scoped or incomplete view every child
 * this planner cannot see reads as closed — so the caller refuses to derive at
 * all there, exactly as debt-sweep filing does.
 *
 * Three conditions, and all three are about not closing something early:
 *
 *  - The umbrella must DECLARE at least one child. "Child issues exist" is the
 *    umbrella's own acceptance criterion, so an umbrella whose children were
 *    never filed has not met it; an empty declaration is an unstarted umbrella,
 *    not a finished one.
 *  - No declared child may still be open, and nothing open may still declare
 *    this umbrella as its parent — the two directions the edge is written in.
 *  - No human hold may stand. `Blocked on: Human` or an external human label
 *    is a person saying they are handling this issue, and closing it out from
 *    under them is the failure mode this engine may never have.
 */
export function planUmbrellaClosures(
  openIssues: readonly UmbrellaClosureIssue[],
): readonly UmbrellaClosurePlanItem[] {
  const openNumbers = new Set(openIssues.map((issue) => issue.number));
  const claimedParents = new Set<number>();
  for (const issue of openIssues) {
    const parent = parseUmbrellaParent(issue.body ?? '');
    if (parent !== null) claimedParents.add(parent);
  }
  const planned: UmbrellaClosurePlanItem[] = [];
  for (const issue of [...openIssues].sort((left, right) => left.number - right.number)) {
    if (!isUmbrellaIssue(issue)) continue;
    if (claimedParents.has(issue.number)) continue;
    if (hasExternalHumanAuthority({
      nativeIssueLabels: issue.labels ?? [],
      projectBlockedOn: issue.blockedOn ?? null,
    })) continue;
    // A task list that names the umbrella itself declares no child.
    const children = umbrellaDeclaredChildren(issue.body ?? '')
      .filter((child) => child !== issue.number);
    if (children.length === 0) continue;
    if (children.some((child) => openNumbers.has(child))) continue;
    planned.push({ issueNumber: issue.number, childIssueNumbers: children });
    if (planned.length === MAX_UMBRELLA_CLOSURES_PER_CYCLE) break;
  }
  return planned;
}
