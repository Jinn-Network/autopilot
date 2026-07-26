import { createHash } from 'node:crypto';
import {
  gitOid,
  gitRefName,
  isoTimestamp,
  type BranchClaim,
  type GitOid,
  type GitRefName,
  type HumanReason,
  type MappingDiagnosticAuthority,
  type MappingRereadRequest,
  type ReviewClaimRecord,
  type ReviewClaimState,
  type ReviewVerdictState,
} from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const SAFE_TEXT_PATTERN = /^[^\u0000-\u001f\u007f:][^\u0000-\u001f\u007f]*$/;
const REVIEW_STATES: readonly ReviewClaimState[] = [
  'active',
  'verdict-intent',
  'terminal-approved',
  'mapping-reread',
  'human-intent',
  'human',
  'stale',
];
const VERDICT_STATES: readonly ReviewVerdictState[] = ['APPROVE', 'REQUEST_CHANGES'];

const BRANCH_TRAILERS = {
  protocolVersion: 'Jinn-Autopilot-Protocol',
  phase: 'Jinn-Autopilot-Phase',
  issueNumber: 'Jinn-Autopilot-Issue',
  prNumber: 'Jinn-Autopilot-PR',
  attempt: 'Jinn-Autopilot-Attempt',
  runner: 'Jinn-Autopilot-Runner',
  login: 'Jinn-Autopilot-Login',
  expectedHead: 'Jinn-Autopilot-Expected-Head',
  targetBase: 'Jinn-Autopilot-Target-Base',
  targetBaseOid: 'Jinn-Autopilot-Target-Base-Oid',
  claimedAt: 'Jinn-Autopilot-Claimed-At',
  phaseComplete: 'Jinn-Autopilot-Phase-Complete',
} as const;

const ALLOWED_BRANCH_TRAILERS = new Set<string>(Object.values(BRANCH_TRAILERS));

function positiveInteger(value: unknown, name: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && POSITIVE_INTEGER_PATTERN.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`Invalid ${name}`);
}

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== 'number') throw new Error(`Invalid ${name}`);
  return positiveInteger(value, name);
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function safeText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !SAFE_TEXT_PATTERN.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) throw new Error(`Unknown field: ${unknown}`);
}

function canonicalIssueNumbers(
  values: readonly number[],
  name = 'diagnostic issue numbers',
  requireNonEmpty = true,
): readonly number[] {
  if (!Array.isArray(values)) throw new Error(`Invalid ${name}`);
  const canonical = [...new Set(values.map((value) => positiveNumber(value, name)))]
    .sort((left, right) => left - right);
  if (requireNonEmpty && canonical.length === 0) throw new Error(`Invalid ${name}`);
  return canonical;
}

export function mappingDiagnosticSignature(input: {
  readonly issueNumbers: readonly number[];
  readonly detail: string;
}): string {
  const issueNumbers = canonicalIssueNumbers(
    input.issueNumbers,
    'diagnostic issue numbers',
    false,
  );
  const detail = safeText(input.detail, 'mapping diagnostic detail');
  return createHash('sha256')
    .update(JSON.stringify({ issueNumbers, detail }))
    .digest('hex');
}

function mappingRequestFromUnknown(value: unknown): MappingRereadRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid mapping request');
  }
  const request = value as Record<string, unknown>;
  exactKeys(request, ['selectedIssueNumber', 'headRefName', 'baseRefName']);
  return {
    selectedIssueNumber: positiveNumber(
      request.selectedIssueNumber,
      'selected issue number',
    ),
    headRefName: gitRefName(safeText(request.headRefName, 'mapping head ref name')),
    baseRefName: gitRefName(safeText(request.baseRefName, 'mapping base ref name')),
  };
}

function mappingDiagnosticFromUnknown(value: unknown): MappingDiagnosticAuthority {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid mapping diagnostic');
  }
  const diagnostic = value as Record<string, unknown>;
  exactKeys(diagnostic, [
    'selectedIssueNumber',
    'issueNumbers',
    'detail',
    'signature',
  ]);
  const selectedIssueNumber = positiveNumber(
    diagnostic.selectedIssueNumber,
    'selected issue number',
  );
  const issueNumbers = canonicalIssueNumbers(
    diagnostic.issueNumbers as readonly number[],
  );
  if (!issueNumbers.includes(selectedIssueNumber)) {
    throw new Error('Mapping diagnostic does not contain the selected issue');
  }
  const detail = safeText(diagnostic.detail, 'mapping diagnostic detail');
  if (
    typeof diagnostic.signature !== 'string'
    || !/^[0-9a-f]{64}$/.test(diagnostic.signature)
    || diagnostic.signature !== mappingDiagnosticSignature({ issueNumbers, detail })
  ) {
    throw new Error('Invalid mapping diagnostic signature');
  }
  return {
    selectedIssueNumber,
    issueNumbers,
    detail,
    signature: diagnostic.signature,
  };
}

function validateBranchClaim(claim: BranchClaim): BranchClaim {
  exactKeys(claim as unknown as Record<string, unknown>, [
    'kind',
    'protocolVersion',
    'phase',
    'issueNumber',
    'prNumber',
    'attempt',
    'runner',
    'login',
    'expectedHead',
    'targetBase',
    'targetBaseOid',
    'claimedAt',
    'phaseComplete',
  ]);
  if (claim.kind !== 'branch-claim') throw new Error('Invalid branch claim kind');
  if (claim.protocolVersion !== 2) throw new Error('Unsupported protocol version');
  positiveNumber(claim.issueNumber, 'issue number');
  if (claim.prNumber !== undefined) positiveNumber(claim.prNumber, 'PR number');
  if (
    claim.phase !== 'implement'
    && claim.phase !== 'fix'
    && claim.phase !== 'reconcile'
  ) {
    throw new Error('Invalid branch claim phase');
  }
  if (
    (claim.phase === 'fix' || claim.phase === 'reconcile')
    && claim.prNumber === undefined
  ) {
    throw new Error(`Contradictory phase fields: ${claim.phase} requires parent PR`);
  }
  uuid(claim.attempt, 'attempt');
  safeText(claim.runner, 'runner');
  safeText(claim.login, 'login');
  gitOid(claim.expectedHead);
  gitRefName(claim.targetBase);
  if ('targetBaseOid' in claim && (claim as { targetBaseOid?: unknown }).targetBaseOid !== undefined) {
    throw new Error('Contradictory phase fields: target base OID is not valid');
  }
  isoTimestamp(claim.claimedAt);
  if (claim.phaseComplete !== undefined && claim.phaseComplete !== true) {
    throw new Error('Invalid phase-complete marker');
  }
  return claim;
}

export function encodeBranchClaimTrailers(claim: BranchClaim): string {
  validateBranchClaim(claim);
  const lines = [
    `${BRANCH_TRAILERS.protocolVersion}: 2`,
    `${BRANCH_TRAILERS.phase}: ${claim.phase}`,
    `${BRANCH_TRAILERS.issueNumber}: ${claim.issueNumber}`,
  ];
  if (claim.prNumber !== undefined) lines.push(`${BRANCH_TRAILERS.prNumber}: ${claim.prNumber}`);
  lines.push(
    `${BRANCH_TRAILERS.attempt}: ${claim.attempt}`,
    `${BRANCH_TRAILERS.runner}: ${claim.runner}`,
    `${BRANCH_TRAILERS.login}: ${claim.login}`,
    `${BRANCH_TRAILERS.expectedHead}: ${claim.expectedHead}`,
    `${BRANCH_TRAILERS.targetBase}: ${claim.targetBase}`,
    `${BRANCH_TRAILERS.claimedAt}: ${claim.claimedAt}`,
  );
  if (claim.phaseComplete === true) lines.push(`${BRANCH_TRAILERS.phaseComplete}: true`);
  return lines.join('\n');
}

export function terminalBranchClaimTrailers(message: string): string | null {
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  while (lines.at(-1) === '') lines.pop();
  let start = lines.length;
  while (start > 0 && lines[start - 1]!.startsWith('Jinn-Autopilot-')) {
    start -= 1;
  }
  if (start === lines.length) return null;
  const trailers = lines.slice(start).join('\n');
  return trailers.includes(`${BRANCH_TRAILERS.protocolVersion}: 2`)
    ? trailers
    : null;
}

export function extractImplementationCompletionSummary(
  message: string,
  trailers: string,
): string | null {
  const claim = decodeBranchClaimTrailers(trailers);
  if (claim.phase !== 'implement' || claim.phaseComplete !== true) return null;
  const normalized = message.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const prefix = 'Autopilot implementation phase complete\n\n';
  const suffix = `\n\n${trailers}`;
  if (!normalized.startsWith(prefix) || !normalized.endsWith(suffix)) {
    throw new Error('Implementation completion commit is missing its durable summary envelope');
  }
  return normalized.slice(prefix.length, -suffix.length);
}


export function decodeBranchClaimTrailers(value: string): BranchClaim {
  const fields = new Map<string, string>();
  for (const line of value.split('\n')) {
    if (line.length === 0) continue;
    const separator = line.indexOf(': ');
    if (separator <= 0) throw new Error(`Malformed branch claim trailer: ${line}`);
    const key = line.slice(0, separator);
    const fieldValue = line.slice(separator + 2);
    if (!ALLOWED_BRANCH_TRAILERS.has(key)) throw new Error(`Unknown branch claim trailer: ${key}`);
    if (fields.has(key)) throw new Error(`Duplicate branch claim trailer: ${key}`);
    fields.set(key, fieldValue);
  }

  const required = (key: string): string => {
    const field = fields.get(key);
    if (field === undefined) throw new Error(`Missing branch claim trailer: ${key}`);
    return field;
  };
  if (required(BRANCH_TRAILERS.protocolVersion) !== '2') {
    throw new Error('Unsupported protocol version');
  }
  const phase = required(BRANCH_TRAILERS.phase);
  if (
    phase !== 'implement'
    && phase !== 'fix'
    && phase !== 'reconcile'
  ) {
    throw new Error('Invalid branch claim phase');
  }
  const prRaw = fields.get(BRANCH_TRAILERS.prNumber);
  const phaseComplete = fields.get(BRANCH_TRAILERS.phaseComplete);
  if (phaseComplete !== undefined && phaseComplete !== 'true') {
    throw new Error('Invalid phase-complete marker');
  }
  const common = {
    kind: 'branch-claim' as const,
    protocolVersion: 2 as const,
    issueNumber: positiveInteger(required(BRANCH_TRAILERS.issueNumber), 'issue number'),
    attempt: uuid(required(BRANCH_TRAILERS.attempt), 'attempt'),
    runner: safeText(required(BRANCH_TRAILERS.runner), 'runner'),
    login: safeText(required(BRANCH_TRAILERS.login), 'login'),
    expectedHead: gitOid(required(BRANCH_TRAILERS.expectedHead)),
    targetBase: gitRefName(required(BRANCH_TRAILERS.targetBase)),
    claimedAt: isoTimestamp(required(BRANCH_TRAILERS.claimedAt)),
    ...(phaseComplete === undefined ? {} : { phaseComplete: true as const }),
  };
  if (phase === 'fix' || phase === 'reconcile') {
    if (prRaw === undefined) {
      throw new Error(`Contradictory phase fields: ${phase} requires parent PR`);
    }
    return validateBranchClaim({
      ...common,
      phase,
      prNumber: positiveInteger(prRaw, 'PR number'),
    });
  }
  return validateBranchClaim({
    ...common,
    phase,
    ...(prRaw === undefined ? {} : { prNumber: positiveInteger(prRaw, 'PR number') }),
  });
}

function reviewRecordFromUnknown(
  value: unknown,
  requireRuntimeDiscriminator: boolean,
): ReviewClaimRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid review claim payload');
  }
  const record = value as Record<string, unknown>;
  exactKeys(record, [
    ...(requireRuntimeDiscriminator ? ['kind'] : []),
    'protocolVersion',
    'prNumber',
    'generation',
    'attempt',
    'reviewer',
    'head',
    'state',
    'recordedAt',
    'verdict',
    'mappingRequest',
    'mappingDiagnostic',
  ]);
  if (
    (requireRuntimeDiscriminator && record.kind !== 'review-claim')
    || (record.kind !== undefined && record.kind !== 'review-claim')
  ) {
    throw new Error('Invalid review claim kind');
  }
  if (record.protocolVersion !== 2) throw new Error('Unsupported protocol version');
  if (typeof record.state !== 'string' || !REVIEW_STATES.includes(record.state as ReviewClaimState)) {
    throw new Error('Invalid review claim state');
  }
  const state = record.state as ReviewClaimState;
  const mappingRequest = record.mappingRequest === undefined
    ? undefined
    : mappingRequestFromUnknown(record.mappingRequest);
  const mappingDiagnostic = record.mappingDiagnostic === undefined
    ? undefined
    : mappingDiagnosticFromUnknown(record.mappingDiagnostic);
  let verdict: ReviewClaimRecord['verdict'];
  if (record.verdict !== undefined) {
    if (typeof record.verdict !== 'object' || record.verdict === null || Array.isArray(record.verdict)) {
      throw new Error('Invalid verdict');
    }
    const verdictRecord = record.verdict as Record<string, unknown>;
    exactKeys(verdictRecord, ['marker', 'state']);
    const verdictState = verdictRecord.state;
    if (typeof verdictState !== 'string'
      || !VERDICT_STATES.includes(verdictState as ReviewVerdictState)) {
      throw new Error('Invalid verdict state');
    }
    verdict = {
      marker: uuid(verdictRecord.marker, 'verdict marker'),
      state: verdictState as ReviewVerdictState,
    };
  }
  if ((state === 'verdict-intent' || state === 'terminal-approved') && verdict === undefined) {
    throw new Error(`${state} requires verdict metadata`);
  }
  if (state === 'terminal-approved' && verdict?.state !== 'APPROVE') {
    throw new Error('terminal-approved requires APPROVE verdict');
  }
  if (!['verdict-intent', 'terminal-approved'].includes(state) && verdict !== undefined) {
    throw new Error(`Contradictory verdict fields for ${state}`);
  }
  if ((state === 'mapping-reread') !== (mappingRequest !== undefined)) {
    throw new Error(`${state} has contradictory mapping request metadata`);
  }
  if (
    (state === 'human-intent' && mappingDiagnostic === undefined)
    || (!['human-intent', 'human'].includes(state) && mappingDiagnostic !== undefined)
  ) {
    throw new Error(`${state} has contradictory mapping diagnostic metadata`);
  }
  const common = {
    kind: 'review-claim' as const,
    protocolVersion: 2 as const,
    prNumber: positiveNumber(record.prNumber, 'PR number'),
    generation: uuid(record.generation, 'generation'),
    attempt: uuid(record.attempt, 'attempt'),
    reviewer: safeText(record.reviewer, 'reviewer'),
    head: gitOid(safeText(record.head, 'head')),
    recordedAt: isoTimestamp(safeText(record.recordedAt, 'recorded-at')),
  };
  if (state === 'verdict-intent') {
    return { ...common, state, verdict: verdict! };
  }
  if (state === 'terminal-approved') {
    return {
      ...common,
      state,
      verdict: { ...verdict!, state: 'APPROVE' },
    };
  }
  if (state === 'mapping-reread') {
    return { ...common, state, mappingRequest: mappingRequest! };
  }
  if (state === 'human-intent') {
    return { ...common, state, mappingDiagnostic: mappingDiagnostic! };
  }
  if (state === 'human' && mappingDiagnostic !== undefined) {
    return { ...common, state, mappingDiagnostic };
  }
  return { ...common, state };
}

export function encodeReviewClaimPayload(record: ReviewClaimRecord): string {
  const valid = reviewRecordFromUnknown(record, true);
  const payload = {
    protocolVersion: valid.protocolVersion,
    prNumber: valid.prNumber,
    generation: valid.generation,
    attempt: valid.attempt,
    reviewer: valid.reviewer,
    head: valid.head,
    state: valid.state,
    recordedAt: valid.recordedAt,
    ...(valid.verdict === undefined ? {} : { verdict: valid.verdict }),
    ...('mappingRequest' in valid ? { mappingRequest: valid.mappingRequest } : {}),
    ...('mappingDiagnostic' in valid && valid.mappingDiagnostic !== undefined
      ? { mappingDiagnostic: valid.mappingDiagnostic }
      : {}),
  };
  return JSON.stringify(payload);
}

export function decodeReviewClaimPayload(payload: string): ReviewClaimRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error('Invalid review claim payload JSON');
  }
  return reviewRecordFromUnknown(parsed, false);
}

export function branchNameForIssue(issueNumber: number): GitRefName {
  return gitRefName(`autopilot/${positiveNumber(issueNumber, 'issue number')}`);
}

export function reviewClaimRef(prNumber: number): GitRefName {
  return gitRefName(
    `refs/jinn-autopilot/review-claims/v1/${positiveNumber(prNumber, 'PR number')}`,
  );
}

export interface AutomatedReviewMarker {
  readonly generation: string;
  readonly attempt: string;
  readonly intent: string;
  readonly reviewer: string;
  readonly head: GitOid;
  readonly verdict: ReviewVerdictState;
}

export function formatAutomatedReviewMarker(marker: AutomatedReviewMarker): string {
  uuid(marker.generation, 'generation');
  uuid(marker.attempt, 'attempt');
  uuid(marker.intent, 'intent');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(marker.reviewer)) {
    throw new Error('Invalid reviewer login');
  }
  gitOid(marker.head);
  if (!VERDICT_STATES.includes(marker.verdict)) throw new Error('Invalid verdict state');
  return `<!-- jinn-autopilot-review:v2 generation=${marker.generation} attempt=${marker.attempt} `
    + `intent=${marker.intent} reviewer=${marker.reviewer} `
    + `head=${marker.head} verdict=${marker.verdict} -->`;
}

const REVIEW_MARKER_PATTERN =
  /^<!-- jinn-autopilot-review:v2 generation=([0-9a-f-]+) attempt=([0-9a-f-]+) intent=([0-9a-f-]+) reviewer=([A-Za-z0-9-]+) head=([0-9a-f]+) verdict=([A-Z_]+) -->$/;

export function parseAutomatedReviewMarker(marker: string): AutomatedReviewMarker {
  const match = REVIEW_MARKER_PATTERN.exec(marker);
  if (match === null) throw new Error('Invalid automated review marker');
  const [, generation, attempt, intent, reviewer, head, verdict] = match;
  if (
    generation === undefined
    || attempt === undefined
    || intent === undefined
    || reviewer === undefined
    || head === undefined
    || verdict === undefined
  ) {
    throw new Error('Invalid automated review marker');
  }
  if (!VERDICT_STATES.includes(verdict as ReviewVerdictState)) {
    throw new Error('Invalid automated review marker verdict');
  }
  return {
    generation: uuid(generation, 'generation'),
    attempt: uuid(attempt, 'attempt'),
    intent: uuid(intent, 'intent'),
    reviewer,
    head: gitOid(head),
    verdict: verdict as ReviewVerdictState,
  };
}

export interface HumanCommentEvidence {
  readonly issueNumber?: number;
  readonly prNumber: number;
  readonly head?: GitOid;
  readonly generation?: string;
  readonly diagnosticIssueNumbers?: readonly number[];
  readonly diagnosticSignature?: string;
  readonly reason: HumanReason;
}

const HUMAN_MARKER_PATTERN =
  /^<!-- jinn-autopilot-human:v2(?: issue=([1-9][0-9]*))? pr=([1-9][0-9]*) phase=([a-z-]+) code=([a-z-]+)(?: head=([0-9a-f]{40}) generation=([0-9a-f-]+))?(?: issues=([1-9][0-9]*(?:,[1-9][0-9]*)*) diagnostic=([0-9a-f]{64}))? -->$/;

function humanReason(phase: string, code: string, detail: string): HumanReason {
  if (
    (phase === 'eligible' || phase === 'implementing')
    && [
      'first-push',
      'implementation-escalation',
      'branch-mapping-ambiguous',
      'invalid-branch-progress-time',
    ].includes(code)
  ) {
    return { phase, code: code as Extract<HumanReason, { phase: typeof phase }>['code'], detail };
  }
  if (
    (phase === 'awaiting-review' || phase === 'reviewing')
    && [
      'review-escalation',
      'branch-mapping-ambiguous',
      'reviewer-identity-unavailable',
      'invalid-review-progress-time',
    ].includes(code)
  ) {
    return { phase, code: code as Extract<HumanReason, { phase: typeof phase }>['code'], detail };
  }
  if (
    (phase === 'merge-ready')
    && [
      'semantic-conflict',
      'codeowner-sensitive-conflict',
      'invalid-merge-progress-time',
      'runaway-child',
    ].includes(code)
  ) {
    return { phase, code: code as Extract<HumanReason, { phase: typeof phase }>['code'], detail };
  }
  throw new Error('Invalid Human reason phase/code');
}

export function formatHumanCommentMarker(input: {
  readonly issueNumber?: number;
  readonly prNumber: number;
  readonly head?: GitOid;
  readonly generation?: string;
  readonly diagnosticIssueNumbers?: readonly number[];
  readonly diagnosticSignature?: string;
  readonly reason: HumanReason;
}): string {
  if (input.issueNumber !== undefined) positiveNumber(input.issueNumber, 'issue number');
  positiveNumber(input.prNumber, 'PR number');
  humanReason(input.reason.phase, input.reason.code, input.reason.detail);
  if ((input.head === undefined) !== (input.generation === undefined)) {
    throw new Error('Human comment provenance requires both head and generation');
  }
  if (input.head !== undefined) gitOid(input.head);
  if (input.generation !== undefined) uuid(input.generation, 'generation');
  if (
    (input.diagnosticIssueNumbers === undefined)
    !== (input.diagnosticSignature === undefined)
  ) {
    throw new Error('Human mapping diagnostic requires both issues and signature');
  }
  let diagnostic = '';
  if (
    input.diagnosticIssueNumbers !== undefined
    && input.diagnosticSignature !== undefined
  ) {
    if (input.reason.code !== 'branch-mapping-ambiguous') {
      throw new Error('Only mapping Human comments may carry a diagnostic signature');
    }
    const issueNumbers = canonicalIssueNumbers(input.diagnosticIssueNumbers);
    if (
      input.issueNumber === undefined
      || !issueNumbers.includes(input.issueNumber)
      || input.diagnosticSignature !== mappingDiagnosticSignature({
        issueNumbers,
        detail: input.reason.detail,
      })
    ) {
      throw new Error('Invalid Human mapping diagnostic signature');
    }
    diagnostic = ` issues=${issueNumbers.join(',')} diagnostic=${input.diagnosticSignature}`;
  }
  return `<!-- jinn-autopilot-human:v2`
    + (input.issueNumber === undefined ? '' : ` issue=${input.issueNumber}`)
    + ` pr=${input.prNumber} phase=${input.reason.phase} code=${input.reason.code}`
    + (input.head === undefined
      ? ''
      : ` head=${input.head} generation=${input.generation}`)
    + diagnostic
    + ' -->';
}

export function parseHumanCommentEvidence(body: string): HumanCommentEvidence | null {
  const [marker, ...paragraphs] = body.split('\n\n');
  if (marker === undefined) return null;
  const match = HUMAN_MARKER_PATTERN.exec(marker);
  if (match === null) return null;
  const [
    ,
    issueRaw,
    prRaw,
    phase,
    code,
    headRaw,
    generationRaw,
    diagnosticIssuesRaw,
    diagnosticSignature,
  ] = match;
  if (prRaw === undefined || phase === undefined || code === undefined) return null;
  const detail = paragraphs.at(-1)?.trim() ?? '';
  if (detail.length === 0 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(detail)) {
    throw new Error('Invalid Human reason detail');
  }
  const reason = humanReason(phase, code, detail);
  let diagnosticIssueNumbers: readonly number[] | undefined;
  if (diagnosticIssuesRaw !== undefined && diagnosticSignature !== undefined) {
    try {
      diagnosticIssueNumbers = canonicalIssueNumbers(
        diagnosticIssuesRaw.split(',').map(Number),
      );
      if (
        issueRaw === undefined
        || !diagnosticIssueNumbers.includes(Number(issueRaw))
        || reason.code !== 'branch-mapping-ambiguous'
        || mappingDiagnosticSignature({
          issueNumbers: diagnosticIssueNumbers,
          detail,
        }) !== diagnosticSignature
      ) {
        return null;
      }
    } catch {
      return null;
    }
  }
  return {
    ...(issueRaw === undefined
      ? {}
      : { issueNumber: positiveInteger(issueRaw, 'issue number') }),
    prNumber: positiveInteger(prRaw, 'PR number'),
    ...(headRaw === undefined ? {} : { head: gitOid(headRaw) }),
    ...(generationRaw === undefined ? {} : { generation: uuid(generationRaw, 'generation') }),
    ...(diagnosticIssueNumbers === undefined
      ? {}
      : { diagnosticIssueNumbers, diagnosticSignature }),
    reason,
  };
}

/**
 * Conservatively recognizes explicit maintainer-authored Human hold prose
 * when no machine-readable Human marker is present. Callers must retain the
 * comment author separately; this only identifies the hold instruction.
 */
export function isUnstructuredHumanHoldComment(body: string): boolean {
  const clauses: string[] = [];
  let fenced = false;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line.startsWith('>')) continue;
    const unquoted = line
      .replaceAll(/`[^`]*`/g, ' ')
      .replaceAll(/“[^”]*”|‘[^’]*’|"[^"]*"/g, ' ')
      // A straight apostrophe is a quote delimiter only at a word boundary;
      // contraction apostrophes (`don't`, `can't`) must survive normalization.
      .replace(/(^|[\s([{])'[^'\n]+'(?=$|[\s.,!?;:)\]}])/g, '$1 ');
    for (const clause of unquoted
      .replaceAll(/[’‘]/g, "'")
      .replaceAll(/\bdon't\b/gi, 'do not')
      .replaceAll(/\bcannot\b/gi, 'can not')
      .replaceAll(/\bcan't\b/gi, 'can not')
      .split(/[.!?;]+/)) {
      const normalized = clause.toLowerCase()
        .replaceAll(/[^a-z]+/g, ' ')
        .trim()
        .replaceAll(/\s+/g, ' ');
      if (normalized.length > 0) clauses.push(normalized);
    }
  }

  // This is intentionally a small direct-intent grammar rather than a word
  // proximity heuristic. Historical quotations and policy/documentation
  // discussion are evidence about language, not current merge authority.
  const alreadyTerminalMergeExplanation =
    /^(?:this(?: (?:pr|pull request|change))?|the (?:pr|pull request|change)) can not (?:be (?:merged|landed)|merge|land) because (?:it|this(?: (?:pr|pull request|change))?|the (?:pr|pull request|change)) (?:(?:is|was) already (?:merged|landed)|has already been (?:merged|landed)|already (?:merged|landed))\b/;
  const directHoldPatterns = [
    /^(?:please |kindly )?(?:do not|never) (?:merge|land)(?:$| (?:this|the (?:pr|pull request|change)|until|before|yet|while)\b)/,
    /^(?:this(?: (?:pr|pull request|change))?|the (?:pr|pull request|change)) (?:must|should|may) not be (?:merged|landed)\b/,
    /^(?:this(?: (?:pr|pull request|change))?|the (?:pr|pull request|change)) can not (?:be (?:merged|landed)|merge|land)(?:$| (?:until|before|unless|without|pending|yet|because|while)\b)/,
    /^(?:please |kindly )?(?:refrain from|avoid) (?:merging|landing)(?:$| (?:this|the (?:pr|pull request|change))\b)/,
    /^(?:please |kindly )?hold off on (?:merging|landing)(?:$| (?:this|the (?:pr|pull request|change))\b)/,
    /^(?:please |kindly )?(?:block|hold|pause|stop) (?:this|the) (?:pr|pull request|merge|automation|review)\b/,
    /^(?:please |kindly )?wait (?:before|until) (?:merging|landing)\b/,
    /^(?:please |kindly )?wait for (?:a )?(?:human|maintainer) (?:review|approval) before (?:merging|landing)\b/,
    /^(?:merging|landing|the merge) is (?:currently )?blocked pending (?:a )?(?:human|maintainer) (?:review|approval)\b/,
    /^(?:this(?: (?:pr|pull request|change))?|the (?:pr|pull request|change)) is (?:currently )?blocked (?:on|pending) (?:a )?(?:human|maintainer) (?:review|approval)\b/,
    /^(?:please |kindly )?(?:merge|land)(?: this (?:pr|pull request))? only (?:after|when) (?:a )?(?:human|maintainer) (?:review|approval)\b/,
    /^(?:please |kindly )?do not automate\b/,
    /^(?:this|the (?:pr|pull request)|we) (?:still )?(?:need|needs|require|requires) (?:a )?(?:human|maintainer) (?:review|approval)\b/,
    /^(?:a )?(?:human|maintainer) (?:review|approval) (?:is )?(?:needed|required)\b/,
    /^(?:this|the (?:pr|pull request)) is (?:on )?(?:a )?human hold\b/,
  ];

  for (const clause of clauses) {
    if (alreadyTerminalMergeExplanation.test(clause)) continue;
    if (directHoldPatterns.some((pattern) => pattern.test(clause))) return true;
  }
  return false;
}
