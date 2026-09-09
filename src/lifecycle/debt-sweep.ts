/**
 * Debt sweeps (#126): batch one parent PR's open review follow-ups into a
 * single elevated sweep issue.
 *
 * Review follow-ups are real debt, but they are filed at P2–P4 and the
 * implementation lane claims strictly by priority, so they sit permanently
 * below the claim horizon while more are filed on every review pass. Follow-ups
 * from the same parent PR are about the same code, so working eight of them in
 * one session costs about what working one costs. Batching is the only lever
 * whose slope beats the generation rate.
 *
 * The sweep issue is ORDINARY implementation work. It carries its own marker
 * and nothing else: the lifecycle stays strictly 1:1, its PR closes only the
 * sweep issue, and the members are closed as a side effect by the session that
 * actually addressed them. Nothing here is persisted beyond the marker.
 *
 * Sessions do not always keep that last promise (#154): a merged sweep whose
 * members were left open looks, to the next derivation, exactly like debt that
 * was never swept, and the open-only dedup then files the identical marker
 * again. So filing also reads the parent's CLOSED sweeps: a member a merged
 * sweep addressed (named in its marker and not deferred in its PR body) is
 * closed here, late, and never re-filed; a member of a sweep closed without a
 * merge was declined by a person and is not re-filed either.
 */

import {
  assertNoChildMarkerInFollowUp,
  formatReviewFollowUpMarkerKey,
  hasReviewFollowUpMarkerTag,
  parseReviewFollowUpMarker,
} from './review-follow-ups.js';

/**
 * The marker tag is a CONTRACT, shared verbatim with the implement-issue skill
 * (which detects a sweep by it) and with backlog classification (which must not
 * count a sweep as one more follow-up). It may not drift in either direction.
 */
export const DEBT_SWEEP_MARKER_TAG = 'jinn-autopilot:debt-sweep';

/**
 * Cluster size bounds, and the policy behind them.
 *
 * MIN: a sweep exists to make a batch worth a claim slot. Below three members
 * the batch saves nothing over working the follow-ups as they are, and it would
 * launder two ordinary P4s into a P2 claim. A parent under the minimum simply
 * waits; the next review pass on that parent may take it over the line.
 *
 * MAX: a session has to hold every member's context at once, and its PR has to
 * stay reviewable as one coherent change set. Eight is the point past which
 * both stop being true. The remainder is not dropped — it waits for the next
 * sweep, which becomes fileable the moment this one closes: open-sweep dedup
 * no longer holds it, and a closed sweep only holds the members it addressed.
 *
 * Both are policy, not physics, and are meant to be adjusted from observed
 * sweep outcomes rather than treated as invariants.
 */
export const DEBT_SWEEP_MIN_MEMBERS = 3;
export const DEBT_SWEEP_MAX_MEMBERS = 8;

/**
 * How many sweeps one cycle may file.
 *
 * `planDebtSweeps` is complete by design — on a repository with a real backlog
 * it can name dozens of qualifying parents at once, and the first armed cycle
 * would otherwise create dozens of P2/P3 issues in one pass and pay a full
 * open-issue listing for each. Neither is recoverable by waiting.
 *
 * The bound is not a throttle on the mechanism, only on its rate: the
 * unfiled clusters are re-derived from the next snapshot, unchanged, and
 * nothing about them decays. Sized against what the implementation lane can
 * actually work: filing sweeps faster than they can be claimed only relocates
 * the backlog. Policy, adjustable from observed sweep throughput.
 */
export const DEBT_SWEEP_MAX_PER_CYCLE = 3;

export type DebtSweepPriority = 'p0' | 'p1' | 'p2' | 'p3' | 'p4';
export type DebtSweepEffort = 'medium' | 'high' | 'xhigh';

/**
 * The elevation ceiling, and the whole point of the mechanism.
 *
 * An unelevated sweep sits below the claim horizon exactly like its members, so
 * it would never be worked and nothing would change. Lifting it one step above
 * its most urgent member is the stated policy "k accumulated debt items justify
 * a session" — k being at least `DEBT_SWEEP_MIN_MEMBERS`.
 *
 * The cap is what keeps that policy honest. Accumulated debt earns a session;
 * it does not earn precedence over P0/P1 work, which is incident- and
 * release-shaped. So a sweep never ranks above P2 no matter how urgent one
 * member happens to be — which also means a cluster containing a P1 member
 * produces a P2 sweep rather than a P0 one. Adjustable policy: raise this only
 * with evidence that sweeps are still starving at P2.
 */
export const DEBT_SWEEP_PRIORITY_CAP: DebtSweepPriority = 'p2';

const PRIORITY_ORDER: readonly DebtSweepPriority[] = [
  'p0',
  'p1',
  'p2',
  'p3',
  'p4',
];

const DEBT_SWEEP_MARKER_RE = new RegExp(
  `<!--\\s*${DEBT_SWEEP_MARKER_TAG}\\s+pr=(\\d+)\\s+members=([0-9,]+)\\s*-->`,
);

/**
 * The residue variant (#168): a sweep whose members come from SEVERAL merged
 * parents, none of which has enough follow-ups left to reach
 * {@link DEBT_SWEEP_MIN_MEMBERS} on its own.
 *
 * `residue=1` sits exactly where `pr=<N>` sits on a parent sweep, so the two
 * markers are mutually exclusive by shape: `DEBT_SWEEP_MARKER_RE` cannot match
 * a residue marker and `formatDebtSweepMarkerKey`'s `pr=<N> ` substring cannot
 * appear in one. Parent-sweep dedup and the #154 closed-sweep settlement
 * therefore keep working byte-for-byte; residue sweeps get their own key and
 * their own settlement beside them.
 */
const RESIDUE_SWEEP_MARKER_RE = new RegExp(
  `<!--\\s*${DEBT_SWEEP_MARKER_TAG}\\s+residue=1\\s+members=([0-9,]+)\\s*-->`,
);

/**
 * The prefix every sweep marker of either kind carries, used by residue filing
 * to read all open sweeps in one search rather than one search per parent.
 * The trailing space is the field boundary, for the same reason it is on
 * {@link formatDebtSweepMarkerKey}.
 */
const ANY_DEBT_SWEEP_MARKER_KEY = `<!-- ${DEBT_SWEEP_MARKER_TAG} `;

export interface DebtSweepMember {
  readonly number: number;
  readonly priority: DebtSweepPriority;
}

export interface DebtSweepCluster {
  readonly parentPr: number;
  /** The members this sweep would carry, capped at {@link DEBT_SWEEP_MAX_MEMBERS}. */
  readonly members: readonly DebtSweepMember[];
  readonly priority: DebtSweepPriority;
  readonly effort: DebtSweepEffort;
  /** Open follow-ups on this parent the cap left for a later sweep. */
  readonly remainingMembers: number;
}

export function formatDebtSweepMarker(
  parentPr: number,
  members: readonly number[],
): string {
  if (!Number.isSafeInteger(parentPr) || parentPr <= 0) {
    throw new Error(`Invalid parent PR number: ${parentPr}`);
  }
  if (members.length === 0) {
    throw new Error('A debt sweep marker requires at least one member');
  }
  for (const member of members) {
    if (!Number.isSafeInteger(member) || member <= 0) {
      throw new Error(`Invalid sweep member issue number: ${member}`);
    }
  }
  return `<!-- ${DEBT_SWEEP_MARKER_TAG} pr=${parentPr} members=${members.join(',')} -->`;
}

/**
 * The parent-scoped prefix, which is what sweep dedup keys on — the same shape
 * and the same reason as `formatChildMarkerKey` (#114) and
 * `formatReviewFollowUpMarkerKey` (#124): the full marker is the *record*, this
 * is the *identity*. The member list changes with every re-derivation, so
 * keying on it would file a second sweep for a parent that already has one.
 *
 * The trailing space is load-bearing, not cosmetic. The key is consumed by a
 * *substring* search over open issue bodies, so without the field boundary
 * after the digits PR #84's key matches PR #845's marker and one parent dedups
 * against another's sweep.
 */
export function formatDebtSweepMarkerKey(parentPr: number): string {
  const marker = formatDebtSweepMarker(parentPr, [1]);
  return marker.slice(0, marker.indexOf('members='));
}

export function parseDebtSweepMarker(
  body: string,
): { readonly parentPr: number; readonly members: readonly number[] } | null {
  const match = body.match(DEBT_SWEEP_MARKER_RE);
  if (match === null) return null;
  const parentPr = Number(match[1]);
  if (!Number.isSafeInteger(parentPr) || parentPr <= 0) return null;
  const members = match[2]!
    .split(',')
    .filter((entry) => entry.length > 0)
    .map(Number);
  if (members.length === 0) return null;
  if (members.some((member) => !Number.isSafeInteger(member) || member <= 0)) {
    return null;
  }
  return { parentPr, members };
}

/**
 * Members of a residue sweep, whose subject is an area rather than a parent.
 *
 * Formatted with `residue=1` in the `pr=<N>` slot so the two marker kinds can
 * never be confused, and read back with the same member semantics: the list is
 * the record of what one sweep session was handed.
 */
export function formatResidueSweepMarker(members: readonly number[]): string {
  if (members.length === 0) {
    throw new Error('A residue sweep marker requires at least one member');
  }
  for (const member of members) {
    if (!Number.isSafeInteger(member) || member <= 0) {
      throw new Error(`Invalid sweep member issue number: ${member}`);
    }
  }
  return `<!-- ${DEBT_SWEEP_MARKER_TAG} residue=1 members=${members.join(',')} -->`;
}

/**
 * The residue key. Unlike the parent key this identifies the KIND, not one
 * subject: residue sweeps are not one-per-anything, so dedup is member-level
 * (see {@link fileResidueSweep}) and this key is what finds the open and
 * closed residue sweeps whose members that dedup reads.
 */
export function formatResidueSweepMarkerKey(): string {
  const marker = formatResidueSweepMarker([1]);
  return marker.slice(0, marker.indexOf('members='));
}

export function parseResidueSweepMarker(
  body: string,
): { readonly members: readonly number[] } | null {
  const match = body.match(RESIDUE_SWEEP_MARKER_RE);
  if (match === null) return null;
  const members = match[1]!
    .split(',')
    .filter((entry) => entry.length > 0)
    .map(Number);
  if (members.length === 0) return null;
  if (members.some((member) => !Number.isSafeInteger(member) || member <= 0)) {
    return null;
  }
  return { members };
}

/**
 * The area bucket for residue whose members cite no readable repository path.
 *
 * Not an exclusion: such members are still real debt and still batched, they
 * are simply batched on "oldest first" alone rather than on a shared area. A
 * session handed this bucket gets the same contract, only with less coherence
 * to lean on — which is strictly better than leaving the members unreachable,
 * which is the status quo this whole mechanism exists to change.
 */
export const RESIDUE_AREA_UNKNOWN = 'unknown';

/**
 * A repository-relative path cited anywhere in the follow-up's own body.
 *
 * Requires at least one `/` and a file extension, so prose, issue references
 * and bare words cannot masquerade as paths. URLs are stripped first: a link
 * to `https://github.com/<org>/<repo>/…` is about the repository, not a path
 * inside it, and would otherwise key every follow-up that cites one to the
 * same fictitious area.
 */
const RESIDUE_PATH_RE = /(?:^|[\s`'"(\[<])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)/;

/**
 * The area a residue member belongs to, derived from the member issue's own
 * body — `packages/<name>` when the cited path names a package, otherwise its
 * first path segment.
 *
 * The design (#168) names the parent PR's changed files as the primary source.
 * Those are not available here: residue parents are MERGED, so they are not in
 * the snapshot's pull-request set at all, and reading them would cost one REST
 * call per parent per cycle across the ~118 parents the residue spans. The
 * member issue IS in the snapshot, with its body, and a review finding names
 * the file it is about — so the same area key is derived from the member for
 * free, and a member that names no path falls back to
 * {@link RESIDUE_AREA_UNKNOWN}, which is the oldest-first grouping.
 */
export function residueAreaKey(body: string): string {
  const withoutUrls = body.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g, ' ');
  const match = withoutUrls.match(RESIDUE_PATH_RE);
  if (match === null) return RESIDUE_AREA_UNKNOWN;
  const segments = match[1]!.split('/');
  return segments[0] === 'packages' && segments.length > 2
    ? `packages/${segments[1]}`
    : segments[0]!;
}

function priorityRank(priority: DebtSweepPriority): number {
  return PRIORITY_ORDER.indexOf(priority);
}

/**
 * One step above the most urgent member, floored at the cap. See
 * {@link DEBT_SWEEP_PRIORITY_CAP} for why the ceiling exists.
 */
export function debtSweepPriority(
  members: readonly DebtSweepPriority[],
): DebtSweepPriority {
  if (members.length === 0) {
    throw new Error('A debt sweep requires at least one member priority');
  }
  const mostUrgent = Math.min(...members.map(priorityRank));
  const capped = Math.max(priorityRank(DEBT_SWEEP_PRIORITY_CAP), mostUrgent - 1);
  return PRIORITY_ORDER[capped]!;
}

/**
 * Effort by member count. Never `low`: low-effort `chore` compresses Stages 1–2
 * in the implement-issue skill, and a sweep needs the full pipeline because its
 * members are unrelated findings that each need their own read.
 *
 * Adjustable policy, sized so the session's declared effort matches how much
 * independent context it actually has to hold.
 */
export function debtSweepEffort(memberCount: number): DebtSweepEffort {
  if (memberCount <= 4) return 'medium';
  if (memberCount <= 6) return 'high';
  return 'xhigh';
}

export function formatDebtSweepTitle(
  parentPr: number,
  memberCount: number,
): string {
  return `Sweep review follow-ups for PR #${parentPr} (${memberCount} items)`;
}

export interface DebtSweepSourceIssue {
  readonly number: number;
  readonly body?: string | null;
  /** Project Priority as read from the board (`P0`…`P4`), or unset. */
  readonly priority?: string | null;
}

export interface PlanDebtSweepsInput {
  /** Every OPEN issue in the snapshot. Sweeps are derived from open state only. */
  readonly issues: readonly DebtSweepSourceIssue[];
  /** PR numbers proven OPEN in this snapshot. */
  readonly openPullRequestNumbers: ReadonlySet<number>;
  /** Parents proven CLOSED unmerged (canon §5.1 / #62). */
  readonly closedUnmergedParentPrs?: ReadonlySet<number>;
}

function memberPriority(raw: string | null | undefined): DebtSweepPriority {
  const normalized = (raw ?? '').toLowerCase();
  return (PRIORITY_ORDER as readonly string[]).includes(normalized)
    ? normalized as DebtSweepPriority
    // Unset or unrecognized ranks last, exactly as the claim lane ranks it, so
    // an untriaged member can never elevate a sweep by accident.
    : 'p4';
}

/**
 * Every open follow-up that is sweepable at all, grouped by parent, plus each
 * member's area key.
 *
 * The single place the three exclusions documented on {@link planDebtSweeps}
 * are applied, so the per-parent planner and the residue planner (#168) can
 * never disagree about what is in play. Members of an open sweep of EITHER
 * kind are excluded: a residue sweep names members from several parents, and
 * without reading its marker here the next derivation would file them again.
 */
function sweepableFollowUps(input: PlanDebtSweepsInput): {
  readonly byParent: ReadonlyMap<number, DebtSweepMember[]>;
  readonly areaByMember: ReadonlyMap<number, string>;
} {
  const sweptParents = new Set<number>();
  const sweptMembers = new Set<number>();
  for (const issue of input.issues) {
    const body = issue.body ?? '';
    const sweep = parseDebtSweepMarker(body);
    if (sweep !== null) {
      sweptParents.add(sweep.parentPr);
      for (const member of sweep.members) sweptMembers.add(member);
      continue;
    }
    const residue = parseResidueSweepMarker(body);
    if (residue === null) continue;
    for (const member of residue.members) sweptMembers.add(member);
  }

  const byParent = new Map<number, DebtSweepMember[]>();
  const areaByMember = new Map<number, string>();
  for (const issue of input.issues) {
    if (sweptMembers.has(issue.number)) continue;
    const body = issue.body ?? '';
    const marker = parseReviewFollowUpMarker(body);
    if (marker === null) continue;
    const parentPr = marker.parentPr;
    if (sweptParents.has(parentPr)) continue;
    if (input.openPullRequestNumbers.has(parentPr)) continue;
    if (input.closedUnmergedParentPrs?.has(parentPr) === true) continue;
    const members = byParent.get(parentPr) ?? [];
    members.push({
      number: issue.number,
      priority: memberPriority(issue.priority),
    });
    byParent.set(parentPr, members);
    areaByMember.set(issue.number, residueAreaKey(body));
  }
  return { byParent, areaByMember };
}

/**
 * Cluster open review follow-ups into fileable sweeps.
 *
 * Pure, and derived from one snapshot: the caller re-checks against live
 * GitHub before it files (see {@link fileDebtSweep}).
 *
 * Three exclusions, each for its own reason:
 *
 * - **Parent still OPEN.** Its follow-ups may still be folded into that PR's
 *   own lifecycle, and canon §5.1 already holds them for exactly that reason.
 * - **Parent CLOSED unmerged.** The same §5.1 hold applies with more force: the
 *   parent's code never landed anywhere, so its follow-ups describe code that
 *   does not exist on the base. Sweeping them would launder held debt into an
 *   ordinary, unheld sweep issue and hand a session an unworkable batch. (#126
 *   says "merged or closed"; this narrows it, because the alternative defeats a
 *   hold the engine already enforces.)
 * - **Already covered by an open sweep**, by parent and by member. Parent-level
 *   dedup is normally sufficient, since members are parent-scoped; member-level
 *   exclusion additionally survives a sweep whose marker names members from a
 *   cluster that has since been re-derived.
 */
export function planDebtSweeps(
  input: PlanDebtSweepsInput,
): readonly DebtSweepCluster[] {
  const { byParent } = sweepableFollowUps(input);

  const clusters: DebtSweepCluster[] = [];
  for (const [parentPr, all] of [...byParent.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    if (all.length < DEBT_SWEEP_MIN_MEMBERS) continue;
    // Oldest first, so the cap leaves the newest behind and the remainder is
    // the batch that has had the least chance to be worked any other way.
    const ordered = [...all].sort((left, right) => left.number - right.number);
    const members = ordered.slice(0, DEBT_SWEEP_MAX_MEMBERS);
    clusters.push({
      parentPr,
      members,
      priority: debtSweepPriority(members.map((member) => member.priority)),
      effort: debtSweepEffort(members.length),
      remainingMembers: ordered.length - members.length,
    });
  }
  return clusters;
}

/**
 * The clusters one cycle should actually file, biggest debt first.
 *
 * Separate from {@link planDebtSweeps} on purpose: the plan says what is
 * sweepable, and is complete; this says how fast to spend it, and is policy.
 * Largest cluster first is the highest-leverage ordering — a sweep costs one
 * claim slot whatever its size — with the parent number as a deterministic tie
 * break so two cycles reading the same snapshot choose the same work.
 */
export function rankDebtSweeps(
  clusters: readonly DebtSweepCluster[],
  limit = DEBT_SWEEP_MAX_PER_CYCLE,
): readonly DebtSweepCluster[] {
  return [...clusters]
    .sort((left, right) => (
      right.members.length - left.members.length
      || left.parentPr - right.parentPr
    ))
    .slice(0, limit);
}

/**
 * A residue sweep: members drawn from SEVERAL merged parents, each of which is
 * below the per-parent floor on its own (#168).
 *
 * The per-parent floor is what makes the residue unreachable. Once a parent's
 * cluster has been swept, one or two follow-ups are typically left over, and
 * no per-parent sweep will ever include them again — on mono that residue was
 * 171 of 260 open follow-ups across 118 parents. They are all P3/P4 and Low,
 * so an ordinary claim never reaches them either. Grouping across parents is
 * the only thing that turns them back into work.
 */
export interface ResidueSweepCluster {
  /** {@link residueAreaKey}, shared by every member. */
  readonly area: string;
  readonly members: readonly DebtSweepMember[];
  /** The merged parents the members came from, ascending. */
  readonly parentPrs: readonly number[];
  readonly priority: DebtSweepPriority;
  readonly effort: DebtSweepEffort;
  /** Residue in this area the cap left for a later sweep. */
  readonly remainingMembers: number;
}

/**
 * Group the residue — follow-ups on merged parents that are below the
 * per-parent floor — into fileable sweeps, keyed by area so one session sees
 * one change set.
 *
 * Same exclusions as {@link planDebtSweeps}, from the same derivation: a
 * parent that is still open, closed unmerged, or already carrying an open
 * sweep contributes nothing here either. Members are ordered oldest first
 * within an area, and areas are walked in name order, so two cycles reading
 * the same snapshot choose the same batches.
 */
export function planResidueSweeps(
  input: PlanDebtSweepsInput,
): readonly ResidueSweepCluster[] {
  const { byParent, areaByMember } = sweepableFollowUps(input);
  const byArea = new Map<string, { member: DebtSweepMember; parentPr: number }[]>();
  for (const [parentPr, all] of byParent) {
    // At or above the floor the parent earns its own sweep; only what a
    // per-parent sweep can never reach is residue.
    if (all.length >= DEBT_SWEEP_MIN_MEMBERS) continue;
    for (const member of all) {
      const area = areaByMember.get(member.number) ?? RESIDUE_AREA_UNKNOWN;
      const entries = byArea.get(area) ?? [];
      entries.push({ member, parentPr });
      byArea.set(area, entries);
    }
  }

  const clusters: ResidueSweepCluster[] = [];
  for (const [area, entries] of [...byArea.entries()].sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  )) {
    if (entries.length < DEBT_SWEEP_MIN_MEMBERS) continue;
    const ordered = [...entries].sort(
      (left, right) => left.member.number - right.member.number,
    );
    const taken = ordered.slice(0, residueMemberCap(ordered.map((entry) => entry.member)));
    const members = taken.map((entry) => entry.member);
    clusters.push({
      area,
      members,
      parentPrs: [...new Set(taken.map((entry) => entry.parentPr))]
        .sort((left, right) => left - right),
      priority: debtSweepPriority(members.map((member) => member.priority)),
      effort: debtSweepEffort(members.length),
      remainingMembers: ordered.length - taken.length,
    });
  }
  return clusters;
}

/** Member cap for a residue batch. Widened for all-Low batches by #168 part 2. */
function residueMemberCap(_members: readonly DebtSweepMember[]): number {
  return DEBT_SWEEP_MAX_MEMBERS;
}

/**
 * How much residue there is, for the `backlog:` line (#168).
 *
 * Counts every open follow-up a per-parent sweep can never reach — merged
 * parent, below the floor, not already in an open sweep — whether or not it
 * has enough company in its area to be filed yet. That is the number an
 * operator needs: it is what the residue mechanism is working against, and a
 * count that only reported what was fileable this cycle would read as zero
 * exactly when the residue is most fragmented.
 */
export function countResidueFollowUps(input: PlanDebtSweepsInput): number {
  const { byParent } = sweepableFollowUps(input);
  let residue = 0;
  for (const members of byParent.values()) {
    if (members.length >= DEBT_SWEEP_MIN_MEMBERS) continue;
    residue += members.length;
  }
  return residue;
}

/**
 * The residue clusters one cycle should file, biggest first — the same policy
 * and the same reasoning as {@link rankDebtSweeps}, with the area name as the
 * deterministic tie break. Its own budget rather than a share of the parent
 * one: the two mechanisms reach disjoint debt, and making them compete for one
 * budget would let the parent path (which is always ranked larger) spend it
 * all and leave the residue exactly where it is.
 */
export function rankResidueSweeps(
  clusters: readonly ResidueSweepCluster[],
  limit = DEBT_SWEEP_MAX_PER_CYCLE,
): readonly ResidueSweepCluster[] {
  return [...clusters]
    .sort((left, right) => (
      right.members.length - left.members.length
      || (left.area < right.area ? -1 : left.area > right.area ? 1 : 0)
    ))
    .slice(0, limit);
}

export function formatResidueSweepTitle(
  area: string,
  memberCount: number,
): string {
  return `Sweep residual review follow-ups in ${area} (${memberCount} items)`;
}

export interface OpenDebtSweepIssue {
  readonly number: number;
  readonly title: string;
}

export interface ClosedDebtSweepIssue {
  readonly number: number;
  readonly body: string;
}

/** The merged pull request that closed a sweep issue. */
export interface MergedSweepPullRequest {
  readonly number: number;
  readonly body: string;
}

export interface DebtSweepPort {
  /** Substring search over OPEN issue bodies. Must refuse a truncated read. */
  searchOpenByMarker(marker: string): Promise<readonly OpenDebtSweepIssue[]>;
  createIssue(input: {
    readonly title: string;
    readonly body: string;
    readonly type: 'chore';
  }): Promise<{ readonly number: number }>;
  ensureTriageComplete(input: {
    readonly issueNumber: number;
    readonly type: 'chore';
    readonly effort: DebtSweepEffort;
    readonly priority: DebtSweepPriority;
  }): Promise<void>;
  /**
   * Substring search over CLOSED issue bodies, newest first. A bounded window
   * of recent closures, never refused for truncation: a duplicate this misses
   * is the status quo, not a new failure.
   */
  searchClosedByMarker(marker: string): Promise<readonly ClosedDebtSweepIssue[]>;
  /** The merged pull request that closed the issue, or null when none merged. */
  mergedClosingPullRequest(issueNumber: number): Promise<MergedSweepPullRequest | null>;
  closeIssue(issueNumber: number, comment: string): Promise<void>;
}

export type FileDebtSweepResult =
  | {
      readonly status: 'filed';
      readonly number: number;
      readonly members: readonly number[];
      readonly priority: DebtSweepPriority;
      readonly effort: DebtSweepEffort;
      readonly closedMembers?: readonly number[];
    }
  | { readonly status: 'already-open'; readonly number: number }
  | {
      readonly status: 'below-minimum';
      readonly openMembers: number;
      readonly closedMembers?: readonly number[];
    }
  | {
      /** Every live member was addressed or declined by a closed sweep. */
      readonly status: 'already-swept';
      readonly number: number;
      readonly closedMembers: readonly number[];
      readonly declinedMembers: readonly number[];
    };

/**
 * Members a sweep session named under a `Deferred` heading in its PR body —
 * the heading `sessionInstructions` asks for. Everything from that heading to
 * the next heading counts; nothing else in the body does.
 */
export function parseDeferredMembers(body: string): ReadonlySet<number> {
  const deferred = new Set<number>();
  let inSection = false;
  for (const line of body.split('\n')) {
    if (/^#{1,6}\s/.test(line)) {
      inSection = /^#{1,6}\s*deferred\b/i.test(line);
      continue;
    }
    if (!inSection) continue;
    for (const match of line.matchAll(/#(\d+)\b/g)) {
      deferred.add(Number(match[1]));
    }
  }
  return deferred;
}

interface SweptMembers {
  /** member → the merged sweep that addressed it. */
  readonly addressed: ReadonlyMap<number, { readonly sweep: number; readonly pr: number }>;
  /** member → the closed-unmerged sweep a person declined it in. */
  readonly declined: ReadonlyMap<number, number>;
}

/**
 * What the parent's closed sweeps already settled, for the members still open.
 *
 * Merged sweeps are read first, so a member addressed by an older merged sweep
 * is addressed even when a newer duplicate of it was closed unmerged — the
 * duplicate is a symptom of the gap this closes, not a verdict on the member.
 */
async function resolveSweptMembers(
  port: DebtSweepPort,
  scope: {
    /** Marker key the closed listing is filtered on. */
    readonly key: string;
    /** The members a closed sweep of this kind names, or none. */
    readonly members: (body: string) => readonly number[];
  },
  liveMembers: readonly number[],
): Promise<SweptMembers> {
  const addressed = new Map<number, { readonly sweep: number; readonly pr: number }>();
  const declined = new Map<number, number>();
  const live = new Set(liveMembers);
  const closedSweeps = (await port.searchClosedByMarker(scope.key))
    .map((issue) => ({
      number: issue.number,
      members: scope.members(issue.body).filter((member) => live.has(member)),
    }))
    .filter((sweep) => sweep.members.length > 0);
  const unmerged: typeof closedSweeps = [];
  for (const sweep of closedSweeps) {
    const pr = await port.mergedClosingPullRequest(sweep.number);
    if (pr === null) {
      unmerged.push(sweep);
      continue;
    }
    const deferred = parseDeferredMembers(pr.body);
    for (const member of sweep.members) {
      if (deferred.has(member) || addressed.has(member)) continue;
      addressed.set(member, { sweep: sweep.number, pr: pr.number });
    }
  }
  for (const sweep of unmerged) {
    for (const member of sweep.members) {
      if (addressed.has(member) || declined.has(member)) continue;
      declined.set(member, sweep.number);
    }
  }
  return { addressed, declined };
}

/**
 * The session contract, written into the sweep body itself so it travels with
 * the issue rather than depending on which skill happened to be loaded.
 *
 * The one hard rule is the closing reference. A PR that closes several issues
 * makes the branch↔issue mapping ambiguous (`branch-mapping-ambiguous`,
 * `snapshot.ts`), and the whole item parks under Human — so the sweep's PR
 * closes the sweep issue and nothing else, and the members are closed as a
 * side effect by the session that addressed them.
 */
function sessionInstructions(parentPr: number): string {
  return [
    '## How to work this sweep',
    '',
    'These findings are all against the code delivered by PR '
      + `#${parentPr}, so they read as one change set. For each member, either`,
    'fix it in this PR or record it as deferred with the reason.',
    '',
    '- Keep the PR to a single coherent change set. Same TDD and verification',
    '  bar as any implementation.',
    '- The PR body closes only the sweep issue. Never write '
      + '`Closes #<member>`',
    '  (or Fixes/Resolves) for a member: a PR with several closing references',
    '  trips `branch-mapping-ambiguous` and parks the item under Human. Plain',
    '  `#<member>` mentions are fine and are how a deferred member gets a',
    '  visible cross-reference.',
    '- On completion, before finishing the session, close each member you',
    '  actually addressed:',
    '',
    '  ```bash',
    '  gh issue close <member> -c "Addressed in sweep PR #<pr>"',
    '  ```',
    '',
    '- Leave every member you did not address OPEN, and name it under a',
    '  `Deferred` heading in the PR body with the reason. It stays ordinary',
    '  debt and becomes eligible for the next sweep once this one closes.',
  ].join('\n');
}

function formatDebtSweepBody(input: {
  readonly parentPr: number;
  readonly marker: string;
  readonly members: readonly OpenDebtSweepIssue[];
}): string {
  return [
    input.marker,
    '',
    `Batched review follow-ups for PR #${input.parentPr}.`,
    '',
    `### Members (${input.members.length})`,
    '',
    ...input.members.map((member) => `- #${member.number} — ${member.title}`),
    '',
    sessionInstructions(input.parentPr),
  ].join('\n');
}

/**
 * File one sweep for one parent, re-checked against live GitHub.
 *
 * Two reads, both from the same open-issue surface the follow-up path already
 * uses:
 *
 * 1. the parent's sweep key, which is the dedup — never a second open sweep for
 *    a parent that has one;
 * 2. the parent's follow-up key, which is the live member set. A member closed
 *    independently between the snapshot and now is simply absent from it and is
 *    skipped, and its title comes from here rather than from the snapshot so
 *    the body cannot quote a stale one.
 *
 * A cluster that fell below the minimum in that window is not filed; the next
 * cycle re-derives it from a fresh snapshot, which is also how the remainder
 * left behind by the cap comes back.
 */
export async function fileDebtSweep(
  port: DebtSweepPort,
  input: {
    readonly parentPr: number;
    readonly members: readonly DebtSweepMember[];
  },
): Promise<FileDebtSweepResult> {
  const openSweeps = await port.searchOpenByMarker(
    formatDebtSweepMarkerKey(input.parentPr),
  );
  if (openSweeps.length > 0) {
    return { status: 'already-open', number: openSweeps[0]!.number };
  }

  const openFollowUps = await port.searchOpenByMarker(
    formatReviewFollowUpMarkerKey(input.parentPr),
  );
  const titleByNumber = new Map(
    openFollowUps.map((issue) => [issue.number, issue.title]),
  );
  const live = input.members.filter((member) =>
    titleByNumber.has(member.number));

  // What a closed sweep already settled (#154). Addressed members are closed
  // here, late, with the reference their session should have left; declined
  // members stay open but are not re-filed. Neither returns to the batch.
  const swept = await resolveSweptMembers(
    port,
    {
      key: formatDebtSweepMarkerKey(input.parentPr),
      members: (body) => {
        const marker = parseDebtSweepMarker(body);
        return marker === null || marker.parentPr !== input.parentPr ? [] : marker.members;
      },
    },
    live.map((member) => member.number),
  );
  const closedMembers: number[] = [];
  for (const [member, { sweep, pr }] of swept.addressed) {
    await port.closeIssue(
      member,
      `Addressed in sweep #${sweep} (merged in PR #${pr}); closed by Autopilot `
        + 'because the sweep session left it open.',
    );
    closedMembers.push(member);
  }
  const surviving = live.filter((member) => (
    !swept.addressed.has(member.number) && !swept.declined.has(member.number)
  ));
  const withClosed = closedMembers.length === 0 ? {} : { closedMembers };
  if (surviving.length === 0 && (swept.addressed.size > 0 || swept.declined.size > 0)) {
    const settledBy = swept.addressed.values().next().value?.sweep
      ?? swept.declined.values().next().value!;
    return {
      status: 'already-swept',
      number: settledBy,
      closedMembers,
      declinedMembers: [...swept.declined.keys()],
    };
  }
  if (surviving.length < DEBT_SWEEP_MIN_MEMBERS) {
    return { status: 'below-minimum', openMembers: surviving.length, ...withClosed };
  }
  const members = surviving.slice(0, DEBT_SWEEP_MAX_MEMBERS);

  const numbers = members.map((member) => member.number);
  const marker = formatDebtSweepMarker(input.parentPr, numbers);
  const title = formatDebtSweepTitle(input.parentPr, members.length);
  const body = formatDebtSweepBody({
    parentPr: input.parentPr,
    marker,
    members: members.map((member) => ({
      number: member.number,
      title: titleByNumber.get(member.number)!,
    })),
  });
  // Fail closed on a sweep that would read as some other machine artifact.
  // Member titles are model-authored prose carried verbatim into this body: a
  // title carrying a child marker would make the sweep a machine child, and one
  // carrying a follow-up marker would make it hold on its own parent forever.
  assertNoChildMarkerInFollowUp(title, body);
  if (hasReviewFollowUpMarkerTag(body)) {
    throw new Error(
      'Debt sweep body must not contain a review-follow-up marker',
    );
  }

  const priority = debtSweepPriority(members.map((member) => member.priority));
  const effort = debtSweepEffort(members.length);
  const created = await port.createIssue({ title, body, type: 'chore' });
  await port.ensureTriageComplete({
    issueNumber: created.number,
    type: 'chore',
    effort,
    priority,
  });
  return { status: 'filed', number: created.number, members: numbers, priority, effort, ...withClosed };
}

/** An open issue read with its body, for member-level residue dedup. */
export interface OpenDebtSweepIssueBody extends OpenDebtSweepIssue {
  readonly body: string;
}

/**
 * The residue filing surface: the parent-sweep port plus one read it cannot
 * do — open sweep BODIES.
 *
 * Parent-sweep dedup asks a yes/no question ("does this parent have an open
 * sweep?") that a marker-key hit answers on its own. Residue dedup is
 * member-level, because residue sweeps are not one-per-anything, so it has to
 * read what the open sweeps actually name. A separate interface rather than a
 * wider `DebtSweepPort` so nothing on the parent path changes.
 */
export interface ResidueSweepPort extends DebtSweepPort {
  /** Substring search over OPEN issue bodies, returning them. Must refuse a truncated read. */
  searchOpenBodiesByMarker(marker: string): Promise<readonly OpenDebtSweepIssueBody[]>;
}

export type FileResidueSweepResult =
  | {
      readonly status: 'filed';
      readonly number: number;
      readonly area: string;
      readonly members: readonly number[];
      readonly priority: DebtSweepPriority;
      readonly effort: DebtSweepEffort;
      readonly closedMembers?: readonly number[];
    }
  | {
      readonly status: 'below-minimum';
      readonly openMembers: number;
      readonly closedMembers?: readonly number[];
    }
  | {
      /** Every live member was addressed or declined by a closed residue sweep. */
      readonly status: 'already-swept';
      readonly number: number;
      readonly closedMembers: readonly number[];
      readonly declinedMembers: readonly number[];
    };

/**
 * The residue session contract. Differs from the per-parent one in exactly one
 * respect — the members come from several merged parents — and the difference
 * is stated rather than hidden, because it changes what "one coherent change
 * set" means for the session holding it.
 */
function residueSessionInstructions(
  area: string,
  parentPrs: readonly number[],
): string {
  return [
    '## How to work this sweep',
    '',
    `These findings all touch \`${area}\`, but they come from several different`,
    `merged pull requests (${parentPrs.map((pr) => `#${pr}`).join(', ')}) — each`,
    'left too few follow-ups behind to be worth a session on its own. The area',
    'is what makes them one change set; the parents are not.',
    '',
    '- For each member, either fix it in this PR or record it as deferred with',
    '  the reason. A member that no longer applies to the code as it stands is',
    '  a legitimate deferral — say so and move on.',
    '- Keep the PR to a single coherent change set. Same TDD and verification',
    '  bar as any implementation. If the fixes stop cohering, fix the subset',
    '  that does and defer the rest.',
    '- The PR body closes only this sweep issue. Never write '
      + '`Closes #<member>`',
    '  (or Fixes/Resolves) for a member: a PR with several closing references',
    '  trips `branch-mapping-ambiguous` and parks the item under Human. Plain',
    '  `#<member>` mentions are fine and are how a deferred member gets a',
    '  visible cross-reference.',
    '- On completion, before finishing the session, close each member you',
    '  actually addressed:',
    '',
    '  ```bash',
    '  gh issue close <member> -c "Addressed in sweep PR #<pr>"',
    '  ```',
    '',
    '- Leave every member you did not address OPEN, and name it under a',
    '  `Deferred` heading in the PR body with the reason. It stays ordinary',
    '  debt and becomes eligible for the next sweep once this one closes.',
  ].join('\n');
}

function formatResidueSweepBody(input: {
  readonly area: string;
  readonly parentPrs: readonly number[];
  readonly marker: string;
  readonly members: readonly OpenDebtSweepIssue[];
}): string {
  return [
    input.marker,
    '',
    `Residual review follow-ups in \`${input.area}\`, batched across `
      + `${input.parentPrs.length} merged parent pull request(s).`,
    '',
    `### Members (${input.members.length})`,
    '',
    ...input.members.map((member) => `- #${member.number} — ${member.title}`),
    '',
    residueSessionInstructions(input.area, input.parentPrs),
  ].join('\n');
}

/**
 * File one residue sweep, re-checked against live GitHub.
 *
 * Three reads, all off the one open-issue listing the port caches plus one
 * closed listing:
 *
 * 1. every OPEN sweep of either kind, whose markers name the members and
 *    parents already spoken for — this is the dedup, and it is member-level
 *    because a residue sweep is not one-per-parent;
 * 2. each contributing parent's follow-up key, which is the live member set,
 *    and the source of the titles the body quotes;
 * 3. the CLOSED residue sweeps (#154, applied to this kind): a member a merged
 *    residue sweep addressed is closed here, late, and never re-filed; a
 *    member of one closed without a merge was declined and is not re-filed
 *    either.
 *
 * A batch that fell below the minimum in that window is not filed; the next
 * cycle re-derives it from a fresh snapshot.
 */
export async function fileResidueSweep(
  port: ResidueSweepPort,
  input: {
    readonly area: string;
    readonly members: readonly DebtSweepMember[];
    readonly parentPrs: readonly number[];
  },
): Promise<FileResidueSweepResult> {
  const openSweeps = await port.searchOpenBodiesByMarker(ANY_DEBT_SWEEP_MARKER_KEY);
  const sweptParents = new Set<number>();
  const sweptMembers = new Set<number>();
  for (const sweep of openSweeps) {
    const parent = parseDebtSweepMarker(sweep.body);
    if (parent !== null) {
      sweptParents.add(parent.parentPr);
      for (const member of parent.members) sweptMembers.add(member);
      continue;
    }
    for (const member of parseResidueSweepMarker(sweep.body)?.members ?? []) {
      sweptMembers.add(member);
    }
  }

  const titleByNumber = new Map<number, string>();
  const parentByNumber = new Map<number, number>();
  for (const parentPr of [...new Set(input.parentPrs)].sort((left, right) => left - right)) {
    if (sweptParents.has(parentPr)) continue;
    for (const issue of await port.searchOpenByMarker(
      formatReviewFollowUpMarkerKey(parentPr),
    )) {
      titleByNumber.set(issue.number, issue.title);
      parentByNumber.set(issue.number, parentPr);
    }
  }
  const live = input.members.filter((member) => (
    titleByNumber.has(member.number) && !sweptMembers.has(member.number)
  ));

  const swept = await resolveSweptMembers(
    port,
    {
      key: formatResidueSweepMarkerKey(),
      members: (body) => parseResidueSweepMarker(body)?.members ?? [],
    },
    live.map((member) => member.number),
  );
  const closedMembers: number[] = [];
  for (const [member, { sweep, pr }] of swept.addressed) {
    await port.closeIssue(
      member,
      `Addressed in sweep #${sweep} (merged in PR #${pr}); closed by Autopilot `
        + 'because the sweep session left it open.',
    );
    closedMembers.push(member);
  }
  const surviving = live.filter((member) => (
    !swept.addressed.has(member.number) && !swept.declined.has(member.number)
  ));
  const withClosed = closedMembers.length === 0 ? {} : { closedMembers };
  if (surviving.length === 0 && (swept.addressed.size > 0 || swept.declined.size > 0)) {
    const settledBy = swept.addressed.values().next().value?.sweep
      ?? swept.declined.values().next().value!;
    return {
      status: 'already-swept',
      number: settledBy,
      closedMembers,
      declinedMembers: [...swept.declined.keys()],
    };
  }
  if (surviving.length < DEBT_SWEEP_MIN_MEMBERS) {
    return { status: 'below-minimum', openMembers: surviving.length, ...withClosed };
  }
  const members = surviving.slice(0, residueMemberCap(surviving));

  const numbers = members.map((member) => member.number);
  const parentPrs = [...new Set(numbers.map((number) => parentByNumber.get(number)!))]
    .sort((left, right) => left - right);
  const marker = formatResidueSweepMarker(numbers);
  const title = formatResidueSweepTitle(input.area, members.length);
  const body = formatResidueSweepBody({
    area: input.area,
    parentPrs,
    marker,
    members: members.map((member) => ({
      number: member.number,
      title: titleByNumber.get(member.number)!,
    })),
  });
  // Same fail-closed guard as the per-parent path: member titles are
  // model-authored prose carried verbatim into this body, and one carrying a
  // child or follow-up marker would make the sweep a different machine
  // artifact entirely.
  assertNoChildMarkerInFollowUp(title, body);
  if (hasReviewFollowUpMarkerTag(body)) {
    throw new Error(
      'Residue sweep body must not contain a review-follow-up marker',
    );
  }

  const priority = debtSweepPriority(members.map((member) => member.priority));
  const effort = debtSweepEffort(members.length);
  const created = await port.createIssue({ title, body, type: 'chore' });
  await port.ensureTriageComplete({
    issueNumber: created.number,
    type: 'chore',
    effort,
    priority,
  });
  return {
    status: 'filed',
    number: created.number,
    area: input.area,
    members: numbers,
    priority,
    effort,
    ...withClosed,
  };
}
