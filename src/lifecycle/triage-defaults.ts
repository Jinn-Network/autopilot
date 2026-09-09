/**
 * Board triage defaults (#166).
 *
 * The eligibility cascade refuses an issue with no Priority or no native Issue
 * Type — correctly, because untriaged work must not jump a queue the operator
 * set. The defect this module closes is that nothing ever *resolved* that
 * refusal: twenty ordinary issues sat unclaimable on the mono board, some for
 * twelve days, while both implementation lanes reported starvation.
 *
 * So the engine fills the three gaps it can fill safely, and reports the rest:
 *
 *  - A missing Priority becomes the configured default. Priority decides claim
 *    order, and a conservative default only makes the issue reachable — it
 *    cannot outrank anything a human ranked.
 *  - A missing Issue Type is inferred ONLY from an explicit conventional title
 *    prefix. The type decides what kind of session runs (a `design` issue
 *    produces a spec, a `refactor` expects stacked PRs), so a wrong guess is
 *    worse than a wait: with no prefix, the type stays unset forever and the
 *    issue is reported as `no-type` instead.
 *  - An EMPTY `Blocked on` becomes `Nothing` (#171). A board row added without
 *    touching the field reads neither `Nothing` nor `Human`, and the cascade
 *    refuses it as "Project Blocked on is unset" — which is what still held
 *    nineteen of the twenty issues #166 was written for. `Nothing` is the
 *    absence of a block spelled out, so writing it asserts nothing new.
 *
 * Pure and total: this module decides, it never writes. The board mutation and
 * its readback guard live in `triage-defaults-production.ts`.
 */

import { isMachineChildIssue } from './child-issues.js';
import { isUmbrellaIssue } from './umbrella-issues.js';
import type { BlockedOn, IssueShape, Priority, ProjectStatus } from '../dispatcher/types.js';

/**
 * How many issues one cycle may triage.
 *
 * `planTriageDefaults` is complete by design: the first armed cycle over a
 * neglected board can name dozens of issues at once, and each of them costs a
 * readback plus up to three Project mutations. Turning one cycle into a
 * mutation burst against a board a human is also editing is not recoverable by
 * waiting; the remainder is, because nothing about an untriaged issue decays
 * and the next cycle re-derives it unchanged.
 */
export const MAX_TRIAGE_DEFAULTS_PER_CYCLE = 10;

/**
 * The nine work shapes as a conventional-commit-style title prefix, anchored
 * and case-sensitive.
 *
 * Case-sensitive on purpose: `Fix: …` is prose that happens to start with a
 * word, while `fix: …` is a deliberate convention. The separator set is the
 * three ways the convention is actually written — `fix:`, `fix(scope):`,
 * `fix the poller` — and requiring one is what keeps `fixture:` and
 * `feature request:` from inferring a shape they do not name.
 */
const TITLE_PREFIX_PATTERN =
  /^(fix|feat|chore|refactor|docs|test|design|spike|incident)(\(|:|\s)/;

export function inferIssueShapeFromTitle(title: string): IssueShape | null {
  const match = TITLE_PREFIX_PATTERN.exec(title);
  return match === null ? null : match[1] as IssueShape;
}

/**
 * The issue facts triage reads. Structurally a subset of `PolledIssue`, named
 * here so the planner can be exercised without composing a whole snapshot.
 */
export interface TriageDefaultsIssue {
  readonly number: number;
  readonly title: string;
  readonly body?: string;
  /** Native GitHub labels; read only for the umbrella exclusion (#160). */
  readonly labels?: readonly string[];
  /** The repository's NATIVE Issue Type, not a board field. */
  readonly shape: IssueShape | null;
  readonly priority: Priority | null;
  /** The Project board field, not a native one; `null` is the unset gap. */
  readonly blockedOn: BlockedOn | null;
  readonly status: ProjectStatus | null;
  readonly onBoard: boolean;
  readonly projectItemId: string | null;
}

export interface TriageDefaultsPolicy {
  readonly defaultPriority: Priority;
  readonly inferIssueType: boolean;
}

/** One issue's open triage gaps, named exactly as the summary line names them. */
export interface TriageGaps {
  readonly noType: boolean;
  readonly noPriority: boolean;
  readonly noBlockedOn: boolean;
}

/** The facts every gap is read from — structurally a subset of `PolledIssue`. */
type TriageSubject = {
  readonly shape: IssueShape | null;
  readonly priority: Priority | null;
  readonly blockedOn: BlockedOn | null;
};

/**
 * The three gaps the eligibility cascade refuses on, read independently so the
 * summary can count them separately. An issue with no board row necessarily
 * has no Priority — Priority is a board field — so it lands in `noPriority`
 * without needing a bucket of its own.
 *
 * `Blocked on: Human` and `Blocked on: Another issue` are deliberately NOT
 * gaps: they are holds an operator chose, not fields nobody filled in, and
 * folding them in here would relabel parked work as neglected work. Only the
 * empty field is a gap.
 */
export function triageGaps(issue: TriageSubject): TriageGaps {
  return {
    noType: issue.shape === null,
    noPriority: issue.priority === null,
    noBlockedOn: issue.blockedOn === null,
  };
}

export function isUntriaged(issue: TriageSubject): boolean {
  const gaps = triageGaps(issue);
  return gaps.noType || gaps.noPriority || gaps.noBlockedOn;
}

/**
 * One issue's planned defaults. At least one of `issueType` / `priority` /
 * `blockedOn` is always present — an issue with nothing to write is not
 * planned at all. `blockedOn` is `'Nothing'` or absent: the other two board
 * values are operator decisions this planner never produces.
 */
export interface TriageDefaultsPlanItem {
  readonly issueNumber: number;
  readonly projectItemId: string;
  readonly issueType?: IssueShape;
  readonly priority?: Priority;
  readonly blockedOn?: 'Nothing';
}

/**
 * Derives at most `MAX_TRIAGE_DEFAULTS_PER_CYCLE` triage writes, ascending by
 * issue number so the oldest neglected issue is closed first and the order is
 * identical on every cycle.
 *
 * Machine children are excluded categorically: they carry their own expected
 * triage on their marker and the machine-child repair owns it. Two writers for
 * one field is how a board starts oscillating.
 *
 * Umbrellas are excluded for the opposite reason (#160): triage exists to make
 * an issue claimable, an umbrella never is however completely it is triaged,
 * and one of the ten capped writes spent on it is one a claimable issue does
 * not get.
 */
export function planTriageDefaults(
  issues: readonly TriageDefaultsIssue[],
  policy: TriageDefaultsPolicy,
): readonly TriageDefaultsPlanItem[] {
  const planned: TriageDefaultsPlanItem[] = [];
  for (const issue of [...issues].sort((left, right) => left.number - right.number)) {
    if (isMachineChildIssue({ body: issue.body })) continue;
    if (isUmbrellaIssue({ body: issue.body, labels: issue.labels })) continue;
    // Every write needs a Project item to edit — the two board writes
    // literally, and the type write because an issue off the board is not
    // work this engine has been handed at all.
    if (!issue.onBoard || issue.projectItemId === null) continue;
    if (issue.status === 'Done') continue;
    const gaps = triageGaps(issue);
    const issueType = gaps.noType && policy.inferIssueType
      ? inferIssueShapeFromTitle(issue.title)
      : null;
    const priority = gaps.noPriority ? policy.defaultPriority : null;
    const blockedOn = gaps.noBlockedOn ? 'Nothing' as const : null;
    if (issueType === null && priority === null && blockedOn === null) continue;
    planned.push({
      issueNumber: issue.number,
      projectItemId: issue.projectItemId,
      ...(issueType === null ? {} : { issueType }),
      ...(priority === null ? {} : { priority }),
      ...(blockedOn === null ? {} : { blockedOn }),
    });
    if (planned.length === MAX_TRIAGE_DEFAULTS_PER_CYCLE) break;
  }
  return planned;
}
