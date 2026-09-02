import { parseChildMarker } from './child-issues.js';
import { gitOid } from './types.js';

const REVIEW_FOLLOW_UP_MARKER_TAG = 'jinn-autopilot:review-follow-up';
const REVIEW_FOLLOW_UP_MARKER_RE = new RegExp(
  `<!--\\s*${REVIEW_FOLLOW_UP_MARKER_TAG}\\s+pr=(\\d+)\\s+head=([0-9a-fA-F]{40})\\s+index=(\\d+)\\s*-->`,
);
/** Fail-closed: follow-up title/body must never inject a child marker (§5.1 / AC2). */
const CHILD_MARKER_SUBSTRING = 'jinn-autopilot:child';

export const MAX_REVIEW_FOLLOW_UPS_PER_PASS = 5;

export type ReviewFollowUpType = 'feat' | 'chore' | 'fix' | 'refactor';
export type ReviewFollowUpEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ReviewFollowUpPriority = 'p0' | 'p1' | 'p2' | 'p3' | 'p4';

export interface ReviewFollowUpEntry {
  readonly type: ReviewFollowUpType;
  readonly title: string;
  readonly body: string;
  readonly effort: ReviewFollowUpEffort;
  readonly priority: ReviewFollowUpPriority;
}

export interface FiledReviewFollowUp {
  readonly number: number;
  readonly created: boolean;
  readonly index: number;
}

export interface OpenReviewFollowUp {
  readonly number: number;
  readonly title: string;
}

export interface ReviewFollowUpPort {
  searchOpenByMarker(marker: string): Promise<readonly OpenReviewFollowUp[]>;
  createIssue(input: {
    readonly title: string;
    readonly body: string;
    readonly type: ReviewFollowUpType;
  }): Promise<{ readonly number: number }>;
  ensureTriageComplete(input: {
    readonly issueNumber: number;
    readonly type: ReviewFollowUpType;
    readonly effort: ReviewFollowUpEffort;
    readonly priority: ReviewFollowUpPriority;
  }): Promise<void>;
}

export function formatReviewFollowUpMarker(
  parentPr: number,
  head: string,
  index: number,
): string {
  if (!Number.isSafeInteger(parentPr) || parentPr <= 0) {
    throw new Error(`Invalid parent PR number: ${parentPr}`);
  }
  let normalizedHead: string;
  try {
    normalizedHead = gitOid(head.toLowerCase());
  } catch {
    throw new Error(`Invalid head SHA: ${head}`);
  }
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error(`Invalid follow-up index: ${index}`);
  }
  return `<!-- ${REVIEW_FOLLOW_UP_MARKER_TAG} pr=${parentPr} head=${normalizedHead} index=${index} -->`;
}

/**
 * The parent-scoped prefix, which is what follow-up dedup keys on.
 *
 * Deliberately head-less and index-less, for the same reason
 * `formatChildMarkerKey` is base-less (#114): the full marker is the
 * *record*, this is the *identity*. `head` moves on exactly the event that
 * causes a re-review and `index` is list position within one pass, so keying
 * dedup on the full marker could only ever catch a retry of the same pass —
 * never the cross-pass duplicate it exists to prevent. mono #3285 accumulated
 * seventeen open follow-ups over five passes proving it (#124).
 *
 * The trailing space is load-bearing, not cosmetic. The key is consumed by a
 * *substring* search over open issue bodies, so without the field boundary
 * after the digits, PR #84's key matches PR #845's markers and one parent
 * dedups against another's follow-ups.
 */
export function formatReviewFollowUpMarkerKey(parentPr: number): string {
  const marker = formatReviewFollowUpMarker(parentPr, '0'.repeat(40), 0);
  return marker.slice(0, marker.indexOf('head='));
}

/**
 * Identity of a follow-up *finding*, as opposed to the review coordinate it
 * was found at. Titles are model-authored prose, so byte equality across
 * passes is not a realistic bar; this folds only the differences that carry no
 * meaning — surrounding and internal whitespace, letter case, and terminal
 * punctuation, none of which can be the difference between two findings.
 *
 * Internal punctuation is *not* folded: `@colophon-claims/check` is the whole
 * identity of the finding that names it, and normalizing it away would merge
 * genuinely distinct entries.
 *
 * This is the deterministic backstop only. The observed duplicates are
 * semantic rather than lexical — "Publish @colophon-claims/check, then
 * republish the verify alias" and "Publish the renamed Colophon reader and its
 * retired-name alias" are the same task with no title overlap — so the primary
 * defense is giving the review session the open follow-ups it must not
 * re-derive (see `ExactHeadReviewSessionExecutionRequest.openFollowUps`).
 */
function normalizeFollowUpTitle(title: string): string {
  return title
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/[.,;:!?]+$/, '')
    .trim();
}

/**
 * True when the body carries a *marker-shaped* review-follow-up comment.
 * Callers pair this with {@link parseReviewFollowUpMarker} to tell "no marker"
 * apart from "marker present but malformed"; the second fails closed into a
 * hold that never self-heals, so the shape must be one only the machine
 * writes.
 *
 * The pattern is exactly {@link REVIEW_FOLLOW_UP_MARKER_RE} truncated after
 * the first digit of `pr=`: every marker `formatReviewFollowUpMarker` emits
 * matches, and so does one whose `head` or `index` is corrupt. Requiring that
 * digit is what keeps documentation out. Canon §5.1 prints the template
 * `<!-- jinn-autopilot:review-follow-up pr=<N> head=<sha> index=<i> -->`
 * verbatim, and issues here are routinely written by agents told to cite
 * canon; on the bare tag that template matched, so quoting canon stranded an
 * issue at `eligible: false` forever under a reason that reads like an
 * ordinary triage miss. `pr=<` is not `pr=<digit>`, so it no longer does.
 *
 * The trade: corruption that destroys the `pr=` field itself is no longer
 * detected, and such a body falls through to ordinary triage. That is the
 * cheaper failure — it is recoverable and visible, where a false positive is
 * neither — and `pr=` is the one field the hold actually reads.
 */
const REVIEW_FOLLOW_UP_MARKER_TAG_RE = new RegExp(
  `<!--\\s*${REVIEW_FOLLOW_UP_MARKER_TAG}\\s+pr=\\d`,
);

export function hasReviewFollowUpMarkerTag(body: string): boolean {
  return REVIEW_FOLLOW_UP_MARKER_TAG_RE.test(body);
}

export function parseReviewFollowUpMarker(
  body: string,
): { readonly parentPr: number; readonly head: string; readonly index: number } | null {
  const match = body.match(REVIEW_FOLLOW_UP_MARKER_RE);
  if (match === null) return null;
  const parentPr = Number(match[1]);
  const index = Number(match[3]);
  if (!Number.isSafeInteger(parentPr) || parentPr <= 0) return null;
  if (!Number.isSafeInteger(index) || index < 0) return null;
  return { parentPr, head: match[2]!.toLowerCase(), index };
}

const TYPES = new Set(['feat', 'chore', 'fix', 'refactor']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const PRIORITIES = new Set(['p0', 'p1', 'p2', 'p3', 'p4']);

/**
 * Reject (do not strip) any follow-up title/body that would look like a
 * machine child issue to `parseChildMarker` / `openChildrenByParent`.
 */
export function assertNoChildMarkerInFollowUp(
  title: string,
  body: string,
  entryIndex?: number,
): void {
  const where =
    entryIndex === undefined ? 'Follow-up entry' : `Follow-up entry ${entryIndex}`;
  for (const [field, value] of [
    ['title', title],
    ['body', body],
  ] as const) {
    if (value.includes(CHILD_MARKER_SUBSTRING) || parseChildMarker(value) !== null) {
      throw new Error(
        `${where} ${field} must not contain a child marker (jinn-autopilot:child)`,
      );
    }
  }
}

export function parseReviewFollowUpsPayload(raw: string): ReviewFollowUpEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Follow-ups file is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Follow-ups file must be an object with followUps[]');
  }
  const followUps = (parsed as { followUps?: unknown }).followUps;
  if (!Array.isArray(followUps)) {
    throw new Error('Follow-ups file must include followUps[]');
  }
  if (followUps.length > MAX_REVIEW_FOLLOW_UPS_PER_PASS) {
    throw new Error(
      `Follow-ups file has ${followUps.length} entries; at most ${MAX_REVIEW_FOLLOW_UPS_PER_PASS} allowed per pass`,
    );
  }
  return followUps.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Follow-up entry ${index} is malformed`);
    }
    const record = entry as Record<string, unknown>;
    const type = record.type;
    const title = record.title;
    const body = record.body;
    const effort = record.effort;
    const priority = record.priority;
    if (typeof type !== 'string' || !TYPES.has(type)) {
      throw new Error(`Follow-up entry ${index} has invalid type`);
    }
    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new Error(`Follow-up entry ${index} requires a non-empty title`);
    }
    if (typeof body !== 'string') {
      throw new Error(`Follow-up entry ${index} requires a body string`);
    }
    if (typeof effort !== 'string' || !EFFORTS.has(effort)) {
      throw new Error(`Follow-up entry ${index} has invalid effort`);
    }
    if (typeof priority !== 'string' || !PRIORITIES.has(priority)) {
      throw new Error(`Follow-up entry ${index} has invalid priority`);
    }
    const trimmedTitle = title.trim();
    assertNoChildMarkerInFollowUp(trimmedTitle, body, index);
    return {
      type: type as ReviewFollowUpType,
      title: trimmedTitle,
      body,
      effort: effort as ReviewFollowUpEffort,
      priority: priority as ReviewFollowUpPriority,
    };
  });
}

export async function fileReviewFollowUps(
  port: ReviewFollowUpPort,
  input: {
    readonly parentPr: number;
    readonly head: string;
    readonly entries: readonly ReviewFollowUpEntry[];
  },
): Promise<readonly FiledReviewFollowUp[]> {
  if (input.entries.length > MAX_REVIEW_FOLLOW_UPS_PER_PASS) {
    throw new Error(
      `Follow-ups exceed cap of ${MAX_REVIEW_FOLLOW_UPS_PER_PASS}`,
    );
  }
  // Dedup on the finding, never on the review coordinate: a parent whose head
  // moved between two passes is the same parent, and the moved head is the
  // very event that triggered the second pass. One parent-scoped lookup per
  // pass, not one per entry — the production port's search is a substring
  // match over open issue bodies, so the prefix returns every open follow-up
  // for this parent regardless of the head and index recorded on it.
  const openForParent = await port.searchOpenByMarker(
    formatReviewFollowUpMarkerKey(input.parentPr),
  );
  const openByTitle = new Map<string, number>();
  for (const existing of openForParent) {
    const key = normalizeFollowUpTitle(existing.title);
    // Oldest wins: two open duplicates already exist on some parents, and
    // collapsing onto the first keeps the survivor stable across passes.
    if (!openByTitle.has(key)) openByTitle.set(key, existing.number);
  }

  const filed: FiledReviewFollowUp[] = [];
  for (let index = 0; index < input.entries.length; index += 1) {
    const entry = input.entries[index]!;
    assertNoChildMarkerInFollowUp(entry.title, entry.body, index);
    const marker = formatReviewFollowUpMarker(input.parentPr, input.head, index);
    const titleKey = normalizeFollowUpTitle(entry.title);
    const existingNumber = openByTitle.get(titleKey);
    if (existingNumber !== undefined) {
      // Create is skipped; triage still runs so a partial prior failure heals.
      await port.ensureTriageComplete({
        issueNumber: existingNumber,
        type: entry.type,
        effort: entry.effort,
        priority: entry.priority,
      });
      filed.push({ number: existingNumber, created: false, index });
      continue;
    }
    const prose =
      `${entry.body.trim()}\n\nFiled from Autopilot review of PR #${input.parentPr} @ \`${input.head.toLowerCase()}\`.`;
    const body = `${marker}\n\n${prose}`;
    const created = await port.createIssue({
      title: entry.title,
      body,
      type: entry.type,
    });
    await port.ensureTriageComplete({
      issueNumber: created.number,
      type: entry.type,
      effort: entry.effort,
      priority: entry.priority,
    });
    // Visible to the rest of this pass too: one pass restating a finding twice
    // is the same duplicate as two passes doing it.
    openByTitle.set(titleKey, created.number);
    filed.push({ number: created.number, created: true, index });
  }
  return filed;
}
