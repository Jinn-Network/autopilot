/**
 * Child-issue library for the single-surface lifecycle (Stage 2).
 *
 * Findings and reconcile work become ordinary issues targeting a parent PR.
 * Filing is idempotent: at most one open child per parent per kind, keyed by
 * the body marker.
 */

export const CHILD_KINDS = ['review-finding', 'reconcile', 'ci-failure'] as const;
export type ChildKind = (typeof CHILD_KINDS)[number];

export const CHILD_MARKER_PREFIX = '<!-- jinn-autopilot:child';
export const CHILD_TRIAGE_MARKER_PREFIX = '<!-- jinn-autopilot:child-triage';

export interface ChildTriageExpectation {
  readonly issueType: 'fix';
  readonly effort: FileChildIssueInput['effort'];
  readonly priority: FileChildIssueInput['priority'];
}

const CHILD_MARKER_RE =
  /<!--\s*jinn-autopilot:child\s+pr=(\d+)\s+kind=(review-finding|reconcile|ci-failure)(?:\s+base=([^\s>]+))?\s*-->/;

/**
 * Structured body marker naming the parent PR, the child kind, and — since
 * issue #114 — the base the parent pull request actually carried **at filing
 * time**.
 *
 * The recorded base exists so the executor's retarget check can compare live
 * base against *recorded* base and regain its true meaning ("someone moved the
 * pull request"). Comparing against the repository default instead also fired
 * on every legitimately stacked parent, which is what stranded mono #3462.
 *
 * It is filing-time evidence, not a cache: nothing refreshes it, nothing
 * expires it, and it never outranks live state — a parent moved back onto the
 * recorded base is claimable again on the very next cycle.
 */
export function formatChildMarker(
  parentPr: number,
  kind: ChildKind,
  parentBase?: string,
): string {
  if (!Number.isSafeInteger(parentPr) || parentPr <= 0) {
    throw new Error(`Invalid parent PR number: ${parentPr}`);
  }
  if (!CHILD_KINDS.includes(kind)) {
    throw new Error(`Invalid child kind: ${kind}`);
  }
  if (parentBase !== undefined && !/^[^\s>]+$/.test(parentBase)) {
    throw new Error(`Invalid recorded parent base: ${parentBase}`);
  }
  const base = parentBase === undefined ? '' : ` base=${parentBase}`;
  return `<!-- jinn-autopilot:child pr=${parentPr} kind=${kind}${base} -->`;
}

/**
 * The parent+kind prefix, which is what child dedup keys on.
 *
 * Deliberately base-less. The full marker is the *record*; this is the
 * *identity*. Keying dedup on the full marker would let a parent whose base
 * moved between two filings look like a different child and file a duplicate,
 * which is exactly the invariant `fileChildIssue` exists to hold.
 */
export function formatChildMarkerKey(parentPr: number, kind: ChildKind): string {
  const marker = formatChildMarker(parentPr, kind);
  return marker.slice(0, marker.indexOf(' -->'));
}

export function parseChildMarker(
  body: string,
): {
  readonly parentPr: number;
  readonly kind: ChildKind;
  /** Parent base recorded at filing time. Absent on markers filed before #114. */
  readonly base?: string;
} | null {
  const match = body.match(CHILD_MARKER_RE);
  if (match === null) return null;
  const parentPr = Number(match[1]);
  const kind = match[2] as ChildKind;
  if (!Number.isSafeInteger(parentPr) || parentPr <= 0) return null;
  return match[3] === undefined
    ? { parentPr, kind }
    : { parentPr, kind, base: match[3] };
}

export function formatChildTriageIntent(input: ChildTriageExpectation): string {
  return `${CHILD_TRIAGE_MARKER_PREFIX} type=${input.issueType} `
    + `effort=${input.effort} priority=${input.priority} -->`;
}

function hasChildTriageIntentPrefix(body: string): boolean {
  return /<!--\s*jinn-autopilot:child-triage/.test(body);
}

export function parseChildTriageIntent(body: string): ChildTriageExpectation | null {
  const prefixes = [...body.matchAll(/<!--\s*jinn-autopilot:child-triage\b/g)];
  const matches = [...body.matchAll(
    /<!--\s*jinn-autopilot:child-triage\s+type=(fix)\s+effort=(low|medium|high)\s+priority=(p1|p2)\s*-->/g,
  )];
  if (prefixes.length !== 1 || matches.length !== 1) return null;
  const match = matches[0]!;
  return {
    issueType: match[1] as ChildTriageExpectation['issueType'],
    effort: match[2] as ChildTriageExpectation['effort'],
    priority: match[3] as ChildTriageExpectation['priority'],
  };
}

export function resolveChildTriageExpectation(
  body: string,
  kind: ChildKind,
): ChildTriageExpectation | null {
  const explicit = parseChildTriageIntent(body);
  if (explicit !== null) return explicit;
  if (hasChildTriageIntentPrefix(body)) return null;
  return kind === 'reconcile'
    ? { issueType: 'fix', effort: 'medium', priority: 'p1' }
    : null;
}

export function isChildIssueBody(body: string): boolean {
  return parseChildMarker(body) !== null;
}

const CHILD_KIND_LABELS = new Set<string>(CHILD_KINDS);

export function hasChildKindLabel(labels: readonly string[] | undefined): boolean {
  return (labels ?? []).some((label) => CHILD_KIND_LABELS.has(label));
}

/**
 * Machine-created child issues are identified by the structured body marker.
 * Kind labels are best-effort discovery tags; CI-red is derived from the parent
 * PR, not from the child label. Triage lives on the Project board.
 */
export function isMachineChildIssue(input: {
  readonly body?: string;
  readonly labels?: readonly string[];
}): boolean {
  return isChildIssueBody(input.body ?? '');
}

export interface FileChildIssueInput {
  readonly parentPr: number;
  readonly kind: ChildKind;
  readonly title: string;
  readonly body: string;
  readonly effort: 'low' | 'medium' | 'high';
  readonly priority: 'p1' | 'p2';
  /**
   * The base ref the parent pull request carries right now (issue #114).
   * Recorded on the marker as filing-time evidence. Optional so a caller with
   * no parent-base evidence files exactly the marker it filed before — an
   * unrecorded base is *unknown*, never "the default branch".
   */
  readonly parentBase?: string;
}

export interface ChildIssueRecord {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
  readonly labels: readonly string[];
  readonly parentPr: number;
  readonly kind: ChildKind;
}

export interface ChildIssuePort {
  searchOpenByMarker(marker: string): Promise<readonly ChildIssueRecord[]>;
  listByParentAndKind(
    parentPr: number,
    kind: ChildKind,
  ): Promise<readonly ChildIssueRecord[]>;
  createIssue(input: {
    readonly title: string;
    readonly body: string;
    readonly labels: readonly string[];
  }): Promise<{ readonly number: number }>;
  setIssueTypeFix(issueNumber: number): Promise<void>;
  ensureTriageComplete(input: {
    readonly issueNumber: number;
    readonly effort: FileChildIssueInput['effort'];
    readonly priority: FileChildIssueInput['priority'];
  }): Promise<void>;
  closeIssue(issueNumber: number, comment: string): Promise<void>;
}

export type FileChildIssueResult =
  | { readonly number: number; readonly created: boolean; readonly runawayHold?: undefined }
  | { readonly runawayHold: true; readonly priorCount: number };

/**
 * Idempotent child filing. If an open issue already carries the marker for
 * this parent+kind, returns it without creating another. When prior children
 * of the same kind already hit the runaway limit (open or closed), returns
 * `runawayHold` instead of filing another — callers escalate the parent.
 */
export async function fileChildIssue(
  port: ChildIssuePort,
  input: FileChildIssueInput,
): Promise<FileChildIssueResult> {
  // Dedup on the base-less identity, never on the recorded base: a parent
  // whose base moved between two filings is the same parent, and must not
  // acquire a second open child of the same kind.
  const markerKey = formatChildMarkerKey(input.parentPr, input.kind);
  const marker = formatChildMarker(input.parentPr, input.kind, input.parentBase);
  const existing = await port.searchOpenByMarker(markerKey);
  if (existing.length > 0) {
    // Existing marker authority is recovery input, never an invitation to
    // overwrite triage inline. The controller emits a field-aware maintenance
    // action from the next complete snapshot.
    return { number: existing[0]!.number, created: false };
  }

  const priorCount = await countChildrenOfKind(port, input.parentPr, input.kind);
  if (shouldFileRunawayHold(priorCount)) {
    return { runawayHold: true, priorCount };
  }

  const triageIntent = formatChildTriageIntent({
    issueType: 'fix',
    effort: input.effort,
    priority: input.priority,
  });
  const bodyWithMarker = input.body.includes(markerKey)
    ? input.body
    : `${marker}\n\n${input.body.trim()}`;
  // Anchor the triage intent on the marker the body actually carries, which
  // may already record a different base than the one supplied here.
  const anchor = bodyWithMarker.match(CHILD_MARKER_RE)?.[0] ?? marker;
  const existingTriageIntent = parseChildTriageIntent(bodyWithMarker);
  if (hasChildTriageIntentPrefix(bodyWithMarker)) {
    if (
      existingTriageIntent === null
      || existingTriageIntent.issueType !== 'fix'
      || existingTriageIntent.effort !== input.effort
      || existingTriageIntent.priority !== input.priority
    ) {
      throw new Error('Child body contains invalid or contradictory triage intent');
    }
  }
  const body = existingTriageIntent === null
    ? bodyWithMarker.replace(anchor, `${anchor}\n\n${triageIntent}`)
    : bodyWithMarker;
  const created = await port.createIssue({
    title: input.title,
    body,
    labels: [input.kind],
  });
  await port.setIssueTypeFix(created.number);
  await port.ensureTriageComplete({
    issueNumber: created.number,
    effort: input.effort,
    priority: input.priority,
  });
  return { number: created.number, created: true };
}

export async function findOpenChildren(
  port: ChildIssuePort,
  parentPr: number,
): Promise<readonly ChildIssueRecord[]> {
  const out: ChildIssueRecord[] = [];
  for (const kind of CHILD_KINDS) {
    const listed = await port.listByParentAndKind(parentPr, kind);
    for (const issue of listed) {
      if (issue.state === 'open' && issue.parentPr === parentPr) out.push(issue);
    }
  }
  return out;
}

export async function closeChildrenFor(
  port: ChildIssuePort,
  parentPr: number,
  comment: string,
): Promise<readonly number[]> {
  const open = await findOpenChildren(port, parentPr);
  const closed: number[] = [];
  for (const child of open) {
    await port.closeIssue(child.number, comment);
    closed.push(child.number);
  }
  return closed;
}

/**
 * Count prior children of one kind on one parent (open or closed). Used by
 * the Stage 4 runaway guard (default N=3).
 */
export async function countChildrenOfKind(
  port: ChildIssuePort,
  parentPr: number,
  kind: ChildKind,
): Promise<number> {
  const listed = await port.listByParentAndKind(parentPr, kind);
  return listed.filter((issue) => issue.parentPr === parentPr && issue.kind === kind)
    .length;
}

/** Env knob: when unset or truthy (not 0/false/no/off), children path is armed. */
export function childrenPathEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.JINN_AUTOPILOT_CHILDREN;
  if (raw === undefined || raw === '') return true;
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}

export const RUNAWAY_CHILD_LIMIT = 3;

/**
 * Stage 4 runaway guard: the Nth child of a kind should hold the parent
 * instead of filing again.
 */
export function shouldFileRunawayHold(priorCount: number, limit = RUNAWAY_CHILD_LIMIT): boolean {
  return priorCount >= limit;
}
