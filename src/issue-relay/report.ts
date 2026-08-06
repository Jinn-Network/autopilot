import { isDeepStrictEqual } from 'node:util';
import {
  formatRelayEvaluationAnchorBlock,
  parseRelayEvaluationAnchorBlock,
  parseRelayEvaluationAnchorBlocks,
  type RelayCheckSummary,
} from './checks.js';
import type { AcceptedRelayAdoption } from './adoption.js';
import type { IssueRelayEvaluationAnchorV1 } from './contracts.js';
import {
  formatRelayAdoptionReceiptBlock,
  parseRelayAdoptionReceiptBlock,
  parseRelayAdoptionReceiptBlocks,
} from './git-publisher.js';
import type { VerifiedIssueRelayVerdictObservation } from './marketplace-cli.js';
import {
  formatRelayIssueMarker,
  parseRelayIssueMarker,
  prepareRelayIssueMarkerUpdate,
} from './markers.js';
import {
  deriveRelayReady,
  type RelayGenerationRecordV1,
  type RelayPhase,
  type RelayReadyInput,
} from './state.js';

const ISSUE_MARKER = '<!-- jinn-issue-relay:generation:v1 -->';
const ACTIVE_ISSUE_MARKER = '<!-- jinn-issue-relay:active:v1 -->';
const ASSURANCE_MARKER = '<!-- jinn-issue-relay:assurance:v1 -->';
const MAX_DISPLAY_BYTES = 1_024;
const MAX_REPORT_ITEMS = 100;
const TERMINAL_ISSUE_PHASES: ReadonlySet<RelayPhase> = new Set([
  'awaiting-clarification',
  'refused',
  'ready',
  'closed',
  'exhausted',
]);

export const READY_FOR_REVIEW_LIMITATION =
  'Jinn has independently evaluated this exact revision and the recorded checks\n'
  + 'passed. This is evidence for maintainer review, not a guarantee of correctness\n'
  + 'or approval to merge.';

export interface RelayRoundTimelineItem {
  readonly round: number;
  readonly purpose: 'initial' | 'repair';
  readonly head: string;
  readonly outcome:
    | 'funded'
    | 'solution-delivered'
    | 'adopted'
    | 'request-changes'
    | 'passed'
    | 'rejected'
    | 'human'
    | 'unresolved';
  readonly summary: string;
}

export interface RelayEvidenceLink {
  readonly label: string;
  readonly url: string;
  readonly digest?: `sha256:${string}`;
}

export interface RelayIssueStatusModel {
  readonly record: RelayGenerationRecordV1;
  readonly generation: string;
  readonly phase: RelayPhase;
  readonly prNumber?: number;
  readonly round: number;
  readonly summary: string;
  readonly nextAction: string;
}

export type RelayReadyPullRequestAuthority =
  NonNullable<RelayReadyInput['draft']> & {
    readonly targetRepository: string;
    readonly targetRepositoryId: string;
    readonly forkRepository: string;
    readonly forkRepositoryId: string;
    readonly forkParentRepositoryId: string;
    readonly visibility: 'PUBLIC';
    readonly managedFork: true;
  };

export interface RelayReadyAssuranceEvidence {
  readonly record: RelayGenerationRecordV1;
  readonly currentHead: string;
  readonly currentBaseOid: string;
  readonly targetBase: string;
  /** Exact open, non-draft PR facts read after the mark-ready transition. */
  readonly currentPr: Omit<RelayReadyPullRequestAuthority, 'draft'> & {
    readonly draft: false;
  };
  /** Exact open draft facts used by Task 10 immediately before mark-ready. */
  readonly draft: NonNullable<RelayReadyInput['draft']>;
  readonly adoption: AcceptedRelayAdoption;
  readonly checks: RelayCheckSummary;
  readonly evaluationAnchor: IssueRelayEvaluationAnchorV1;
  readonly verdict: VerifiedIssueRelayVerdictObservation;
  readonly adoptionReceiptBlock: string;
  readonly evaluationAnchorBlock: string;
}

export interface RelayAssuranceModel {
  readonly status:
    | 'IN PROGRESS'
    | 'REPAIR IN PROGRESS'
    | 'READY FOR HUMAN REVIEW'
    | 'CANCELLED'
    | 'EXHAUSTED'
    | 'FAILED';
  readonly head?: string;
  readonly solutionOperator?: string;
  readonly evaluator?: string;
  readonly checks: ReadonlyArray<RelayCheckSummary['required'][number]>;
  readonly readyEvidence?: RelayReadyAssuranceEvidence;
  readonly rounds: readonly RelayRoundTimelineItem[];
  readonly limitations: readonly string[];
  readonly technicalEvidence: readonly RelayEvidenceLink[];
}

export interface RelayOwnedComment {
  readonly id: number;
  readonly authorLogin: string;
  readonly body: string;
}

export interface RelayOwnedCommentPort {
  listIssueComments(input: {
    readonly repository: string;
    readonly issueNumber: number;
  }): Promise<readonly RelayOwnedComment[]>;
  editIssueComment(input: {
    readonly repository: string;
    readonly issueNumber: number;
    readonly commentId: number;
    readonly expectedBody: string;
    readonly body: string;
  }): Promise<void>;
  listAssuranceComments(input: {
    readonly repository: string;
    readonly prNumber: number;
  }): Promise<readonly RelayOwnedComment[]>;
  editAssuranceComment(input: {
    readonly repository: string;
    readonly prNumber: number;
    readonly commentId: number;
    readonly expectedHead: string;
    readonly expectedBody: string;
    readonly body: string;
  }): Promise<void>;
}

function sameLogin(left: string, right: string): boolean {
  return left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US');
}

function bounded(value: string): string {
  const characters: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > MAX_DISPLAY_BYTES) {
      const ellipsis = '…';
      const ellipsisBytes = Buffer.byteLength(ellipsis, 'utf8');
      while (
        characters.length > 0
        && bytes + ellipsisBytes > MAX_DISPLAY_BYTES
      ) {
        const removed = characters.pop()!;
        bytes -= Buffer.byteLength(removed, 'utf8');
      }
      return `${characters.join('')}${ellipsis}`;
    }
    characters.push(character);
    bytes += characterBytes;
  }
  return characters.join('');
}

/**
 * Untrusted issue and marketplace prose is rendered as one inert display line.
 * Authority continues to come only from the strict hidden codecs.
 */
function safeDisplay(value: string): string {
  const sanitized = value
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, 'ˋ')
    .replace(/\[/g, '［')
    .replace(/\]/g, '］')
    .replace(/!/g, '！')
    .replace(/#/g, '＃')
    .replace(/\*/g, '＊')
    .replace(/_/g, '＿')
    .replace(/~/g, '～')
    .replace(/\|/g, '｜')
    .replace(/^-/, '‐')
    .replace(/^\+/, '＋')
    .replace(/^(\d+)\./, '$1․')
    .replace(/@/g, '＠')
    .replace(/\bhttps?:\/\//gi, (match) =>
      match.toLocaleLowerCase('en-US').startsWith('https')
        ? 'hxxps://'
        : 'hxxp://')
    .replace(/\bwww\./gi, 'www․')
    .replace(
      /\b(close[sd]?|closing|fix(?:e[sd]?|ing)?|resolve[sd]?|resolving)\b/gi,
      (match) => `${match.slice(0, 3)}·${match.slice(3)}`,
    )
    .replace(/\bsafe to merge\b/gi, 'safe to mer·ge')
    .replace(/\bguaranteed\b/gi, 'guaran·teed')
    .replace(/\bmaintainer approved\b/gi, 'maintainer appro·ved');
  return bounded(sanitized);
}

function exactOid(value: string, label: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new TypeError(`${label} must be an exact Git OID`);
  }
  return value;
}

function safePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function safeRound(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Relay report round must be a non-negative safe integer');
  }
  return value;
}

function requireBoundedItems(
  items: readonly unknown[],
  label: string,
): void {
  if (items.length > MAX_REPORT_ITEMS) {
    throw new RangeError(`${label} exceeds the deterministic report item limit`);
  }
}

function issueStatus(model: RelayIssueStatusModel): string {
  if (
    model.record.cancellation !== undefined
    || model.phase === 'cancelling'
  ) {
    return 'CANCELLED';
  }
  return model.phase.toLocaleUpperCase('en-US');
}

export function renderRelayIssueComment(
  model: RelayIssueStatusModel,
): string {
  const durableRound = model.record.rounds.at(-1)?.round ?? 0;
  if (
    model.record.generation !== model.generation
    || model.record.phase !== model.phase
  ) {
    throw new TypeError('Relay visible issue status contradicts its durable marker');
  }
  safeRound(model.round);
  if (model.round !== durableRound) {
    throw new TypeError(
      'Relay visible issue round contradicts the durable latest round',
    );
  }
  if (model.prNumber !== model.record.pr?.number) {
    throw new TypeError(
      'Relay visible pull request contradicts the durable marker',
    );
  }
  const marker = formatRelayIssueMarker(model.record);
  const lines = [
    `## Jinn Issue Relay — ${issueStatus(model)}`,
    '',
    `- Generation: \`${safeDisplay(model.generation)}\``,
    `- Round: ${model.round}`,
    ...(model.prNumber === undefined
      ? []
      : [`- Pull request: #${safePositiveInteger(model.prNumber, 'Pull request')}`]),
    `- Summary: ${safeDisplay(model.summary)}`,
    `- Next action: ${safeDisplay(model.nextAction)}`,
    '',
    'Closing the issue or removing `engine:marketplace` requests soft cancellation. '
      + 'Already-funded marketplace work cannot be withdrawn on-chain.',
    '',
    ...(TERMINAL_ISSUE_PHASES.has(model.phase)
      ? []
      : [ACTIVE_ISSUE_MARKER, '']),
    marker,
  ];
  return lines.join('\n');
}

export function parseRelayIssueCommentMarker(
  body: string,
  authorLogin: string,
  expectedAuthorLogin = authorLogin,
): RelayGenerationRecordV1 | null {
  const structuralPrefix = `${ISSUE_MARKER}\n\n\`\`\`json\n`;
  const candidates: number[] = [];
  let offset = 0;
  while (offset < body.length) {
    const found = body.indexOf(structuralPrefix, offset);
    if (found === -1) break;
    if (found === 0 || body[found - 1] === '\n') {
      candidates.push(found);
    }
    offset = found + structuralPrefix.length;
  }
  if (candidates.length !== 1 || candidates[0] === undefined) return null;
  return parseRelayIssueMarker({
    body: body.slice(candidates[0]),
    authorLogin,
    expectedAuthorLogin,
  });
}

function lastVerdict(model: RelayAssuranceModel): string {
  const latest = [...model.rounds].reverse().find(({ outcome }) =>
    ['request-changes', 'passed', 'rejected'].includes(outcome));
  switch (latest?.outcome) {
    case 'passed':
      return 'passed';
    case 'request-changes':
      return 'requested changes';
    case 'rejected':
      return 'rejected';
    case undefined:
      return 'pending';
    default:
      return 'pending';
  }
}

interface ValidatedReadyAssurance {
  readonly head: string;
  readonly targetRepository: string;
  readonly prNumber: number;
  readonly solutionOperator: string;
  readonly evaluator: string;
  readonly checks: RelayCheckSummary['required'];
  readonly timeline: readonly RelayRoundTimelineItem[];
  readonly technicalBlocks: readonly [string, string];
}

export function canonicalRelayTimeline(
  record: RelayGenerationRecordV1,
): readonly RelayRoundTimelineItem[] {
  const timeline: RelayRoundTimelineItem[] = [];
  for (const round of record.rounds) {
    const identity = {
      round: round.round,
      purpose: round.purpose,
    };
    if (round.task !== undefined) {
      timeline.push({
        ...identity,
        head: round.inputHead,
        outcome: 'funded',
        summary: 'Round funded.',
      });
    }
    if (round.solution !== undefined) {
      timeline.push({
        ...identity,
        head: round.inputHead,
        outcome: 'solution-delivered',
        summary: 'Solution delivery observed.',
      });
    }
    if (round.adoption !== undefined) {
      timeline.push({
        ...identity,
        head: round.adoption.resultingHead ?? round.inputHead,
        outcome: round.adoption.disposition === 'accepted'
          ? 'adopted'
          : 'rejected',
        summary: round.adoption.disposition === 'accepted'
          ? 'Solution adopted.'
          : 'Solution rejected.',
      });
    }
    if (round.verdict !== undefined) {
      const verdict = (() => {
        switch (round.verdict.outcome) {
          case 'pass':
            return {
              outcome: 'passed' as const,
              summary: 'Independent evaluation passed.',
            };
          case 'request-changes':
            return {
              outcome: 'request-changes' as const,
              summary: 'Evaluator requested changes.',
            };
          case 'human':
            return {
              outcome: 'human' as const,
              summary: 'Evaluator requested human review.',
            };
          case 'unresolved':
            return {
              outcome: 'unresolved' as const,
              summary: 'Evaluation remained unresolved.',
            };
        }
      })();
      timeline.push({
        ...identity,
        head: round.verdict.evaluatedHead,
        ...verdict,
      });
    }
  }
  return timeline;
}

function validateReadyAssurance(
  model: RelayAssuranceModel,
): ValidatedReadyAssurance {
  const candidate = model.readyEvidence as unknown;
  if (
    candidate === null
    || typeof candidate !== 'object'
    || Array.isArray(candidate)
  ) {
    throw new TypeError('Ready assurance requires structured exact evidence');
  }
  const evidence = candidate as Partial<RelayReadyAssuranceEvidence>;
  if (
    typeof evidence.adoptionReceiptBlock !== 'string'
    || typeof evidence.evaluationAnchorBlock !== 'string'
    || evidence.adoption === undefined
    || evidence.checks === undefined
    || evidence.evaluationAnchor === undefined
    || evidence.verdict === undefined
    || evidence.draft === undefined
    || evidence.currentPr === undefined
    || evidence.record === undefined
    || typeof evidence.currentHead !== 'string'
    || typeof evidence.currentBaseOid !== 'string'
    || typeof evidence.targetBase !== 'string'
  ) {
    throw new TypeError('Ready assurance evidence is incomplete');
  }

  try {
    formatRelayIssueMarker(evidence.record);
  } catch (error) {
    throw new TypeError('Ready assurance durable generation is invalid', {
      cause: error,
    });
  }

  let parsedReceipt: ReturnType<typeof parseRelayAdoptionReceiptBlock>;
  let parsedAnchor: ReturnType<typeof parseRelayEvaluationAnchorBlock>;
  try {
    parsedReceipt = parseRelayAdoptionReceiptBlock(
      evidence.adoptionReceiptBlock,
    );
    parsedAnchor = parseRelayEvaluationAnchorBlock(
      evidence.evaluationAnchorBlock,
    );
  } catch (error) {
    throw new TypeError('Ready assurance technical evidence is malformed', {
      cause: error,
    });
  }
  if (
    parsedReceipt === null
    || parsedAnchor === null
    || !isDeepStrictEqual(parsedReceipt, evidence.adoption.receipt)
    || !isDeepStrictEqual(parsedAnchor, evidence.evaluationAnchor)
    || evidence.adoptionReceiptBlock
      !== formatRelayAdoptionReceiptBlock(parsedReceipt)
    || evidence.evaluationAnchorBlock
      !== formatRelayEvaluationAnchorBlock(parsedAnchor)
  ) {
    throw new TypeError(
      'Ready assurance preserved receipt or anchor evidence does not match',
    );
  }

  const durableRound = evidence.record.rounds.at(-1);
  const initialRound = evidence.record.rounds[0];
  const currentPr = evidence.currentPr;
  const receipt = evidence.adoption.receipt;
  const cancelled = evidence.record.cancellation !== undefined
    || evidence.record.phase === 'cancelling'
    || evidence.record.phase === 'closed';
  const exhausted = evidence.record.phase === 'exhausted';
  if (
    evidence.record.phase !== 'ready'
    || cancelled
    || exhausted
    || evidence.record.generation !== receipt.correlation.generation
    || evidence.record.snapshot.snapshotDigest
      !== receipt.correlation.snapshotDigest
    || evidence.record.snapshot.repository.slug !== receipt.targetRepository
    || initialRound?.round !== 0
    || initialRound.purpose !== 'initial'
    || initialRound.workspaceRepository
      !== evidence.record.snapshot.repository.slug
    || initialRound.inputHead !== evidence.record.snapshot.repository.baseOid
    || evidence.record.snapshot.repository.defaultBranch
      !== evidence.evaluationAnchor.targetBase
    || evidence.record.snapshot.repository.baseOid
      !== evidence.evaluationAnchor.baseOid
    || evidence.record.snapshot.issue.number !== receipt.issueNumber
    || evidence.record.pr?.number !== receipt.prNumber
    || evidence.record.pr.branch !== receipt.headRef
    || evidence.record.pr.head !== receipt.resultingHead
    || evidence.record.pr.draft !== false
    || typeof evidence.currentPr.targetRepository !== 'string'
    || typeof evidence.currentPr.targetRepositoryId !== 'string'
    || typeof evidence.currentPr.forkRepository !== 'string'
    || typeof evidence.currentPr.forkRepositoryId !== 'string'
    || typeof evidence.currentPr.forkParentRepositoryId !== 'string'
    || evidence.currentPr.targetRepository.length === 0
    || evidence.currentPr.targetRepositoryId.length === 0
    || evidence.currentPr.forkRepository.length === 0
    || evidence.currentPr.forkRepositoryId.length === 0
    || evidence.currentPr.targetRepository
      !== evidence.record.snapshot.repository.slug
    || evidence.currentPr.targetRepositoryId
      !== evidence.record.snapshot.repository.nodeId
    || evidence.currentPr.forkRepository.toLocaleLowerCase('en-US')
      === evidence.currentPr.targetRepository.toLocaleLowerCase('en-US')
    || evidence.currentPr.forkRepositoryId
      === evidence.currentPr.targetRepositoryId
    || evidence.currentPr.forkParentRepositoryId
      !== evidence.currentPr.targetRepositoryId
    || evidence.currentPr.visibility !== 'PUBLIC'
    || evidence.currentPr.managedFork !== true
    || evidence.record.pr.targetRepository
      !== evidence.currentPr.targetRepository
    || evidence.record.pr.targetRepositoryId
      !== evidence.currentPr.targetRepositoryId
    || evidence.record.pr.forkRepository
      !== evidence.currentPr.forkRepository
    || evidence.record.pr.forkRepositoryId
      !== evidence.currentPr.forkRepositoryId
    || evidence.record.pr.forkParentRepositoryId
      !== evidence.currentPr.forkParentRepositoryId
    || evidence.record.pr.visibility !== evidence.currentPr.visibility
    || evidence.record.pr.managedFork !== evidence.currentPr.managedFork
    || evidence.currentPr.number !== receipt.prNumber
    || evidence.currentPr.forkRepository !== receipt.workspaceRepository
    || evidence.currentPr.branch !== receipt.headRef
    || evidence.currentPr.head !== receipt.resultingHead
    || evidence.currentPr.base !== evidence.evaluationAnchor.targetBase
    || evidence.currentPr.generation !== receipt.correlation.generation
    || evidence.currentPr.open !== true
    || evidence.currentPr.draft !== false
    || evidence.draft.number !== evidence.currentPr.number
    || evidence.draft.branch !== evidence.currentPr.branch
    || evidence.draft.head !== evidence.currentPr.head
    || evidence.draft.base !== evidence.currentPr.base
    || evidence.draft.generation !== evidence.currentPr.generation
    || evidence.draft.open !== true
    || evidence.draft.draft !== true
    || evidence.record.generation !== evidence.verdict.round.generation
    || evidence.record.rounds.slice(1).some((round) =>
      round.purpose !== 'repair'
      || round.workspaceRepository !== currentPr.forkRepository)
    || durableRound?.round !== receipt.correlation.round
    || durableRound.round !== evidence.verdict.round.round
    || durableRound.purpose !== evidence.verdict.round.purpose
    || durableRound.workspaceRepository
      !== evidence.verdict.round.workspaceRepository
    || durableRound.inputHead !== receipt.inputHead
    || durableRound.inputHead !== evidence.verdict.round.inputHead
    || (
      durableRound.purpose === 'initial'
      && (
        durableRound.workspaceRepository !== receipt.targetRepository
        || receipt.workspaceRepository !== currentPr.forkRepository
        || evidence.evaluationAnchor.workspaceRepository
          !== currentPr.forkRepository
        || evidence.verdict.round.workspaceRepository
          !== receipt.targetRepository
        || durableRound.inputHead
          !== evidence.record.snapshot.repository.baseOid
        || evidence.verdict.round.prNumber !== undefined
      )
    )
    || (
      durableRound.purpose === 'repair'
      && (
        durableRound.workspaceRepository === receipt.targetRepository
        || durableRound.workspaceRepository !== receipt.workspaceRepository
        || currentPr.forkRepository !== receipt.workspaceRepository
        || currentPr.forkRepository
          !== evidence.evaluationAnchor.workspaceRepository
        || currentPr.forkRepository
          !== evidence.verdict.round.workspaceRepository
        || evidence.verdict.round.prNumber !== receipt.prNumber
      )
    )
    || durableRound.task?.taskId !== receipt.correlation.taskId
    || durableRound.task.taskCid !== evidence.verdict.task.taskCid
    || durableRound.solution?.envelopeCid
      !== receipt.correlation.deliveryEnvelopeCid
    || durableRound.solution.operatorSafe.toLocaleLowerCase('en-US')
      !== receipt.solutionSafe.toLocaleLowerCase('en-US')
    || durableRound.adoption?.disposition !== 'accepted'
    || durableRound.adoption.resultingHead !== receipt.resultingHead
    || durableRound.adoption.receiptDigest
      !== evidence.evaluationAnchor.adoptionReceiptDigest
    || durableRound.checks?.head !== evidence.checks.head
    || durableRound.checks.status !== 'passed'
    || durableRound.checks.digest !== evidence.checks.digest
    || durableRound.verdict?.outcome !== 'pass'
    || durableRound.verdict.evaluatedHead
      !== evidence.verdict.payload.evaluatedHead
    || durableRound.verdict.envelopeCid
      !== evidence.verdict.delivery.envelopeCid
  ) {
    throw new TypeError(
      'Ready assurance does not match the current durable generation',
    );
  }

  let decision: ReturnType<typeof deriveRelayReady>;
  try {
    decision = deriveRelayReady({
      currentHead: evidence.currentHead,
      currentBaseOid: evidence.currentBaseOid,
      targetBase: evidence.targetBase,
      draft: evidence.draft,
      adoption: evidence.adoption,
      checks: evidence.checks,
      evaluationAnchor: evidence.evaluationAnchor,
      verdict: evidence.verdict,
      cancelled,
      exhausted,
    });
  } catch (error) {
    throw new TypeError('Ready assurance evidence is invalid', { cause: error });
  }
  if (!decision.ready || model.head !== decision.head) {
    throw new TypeError('Ready assurance evidence does not bind the exact head');
  }
  const timeline = canonicalRelayTimeline(evidence.record);
  if (!isDeepStrictEqual(model.rounds, timeline)) {
    throw new TypeError(
      'Ready assurance timeline is not the complete durable event history',
    );
  }
  const passed = timeline
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.outcome === 'passed');
  const authenticatedPass = passed[0];
  if (
    passed.length !== 1
    || authenticatedPass === undefined
    || authenticatedPass.index !== timeline.length - 1
    || authenticatedPass.item.round
      !== evidence.adoption.receipt.correlation.round
    || authenticatedPass.item.purpose !== durableRound.purpose
    || authenticatedPass.item.head !== decision.head
  ) {
    throw new TypeError(
      'Ready assurance timeline does not match the authenticated verdict',
    );
  }

  return {
    head: decision.head,
    targetRepository: evidence.adoption.receipt.targetRepository,
    prNumber: evidence.adoption.receipt.prNumber,
    solutionOperator: evidence.adoption.receipt.solutionSafe,
    evaluator: evidence.verdict.attempt.operator,
    checks: evidence.checks.required,
    timeline,
    technicalBlocks: [
      evidence.adoptionReceiptBlock,
      evidence.evaluationAnchorBlock,
    ],
  };
}

function safeHttpsUrl(value: string, label: string): string {
  if (
    Buffer.byteLength(value, 'utf8') > MAX_DISPLAY_BYTES
    || !value.startsWith('https://')
    || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
  ) {
    throw new TypeError(`${label} must be a bounded canonical HTTPS URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute HTTPS URL`);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
    || parsed.href !== value
  ) {
    throw new TypeError(
      `${label} must be a canonical unauthenticated HTTPS URL without query or fragment`,
    );
  }
  for (const match of value.matchAll(/%([0-9A-Fa-f]{2})/g)) {
    const encoded = match[1]!;
    const byte = Number.parseInt(encoded, 16);
    const unreserved =
      (byte >= 0x41 && byte <= 0x5a)
      || (byte >= 0x61 && byte <= 0x7a)
      || (byte >= 0x30 && byte <= 0x39)
      || [0x2d, 0x2e, 0x5f, 0x7e].includes(byte);
    if (encoded !== encoded.toLocaleUpperCase('en-US') || unreserved) {
      throw new TypeError(
        `${label} URL contains noncanonical percent encoding`,
      );
    }
  }
  try {
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(
      decodeURIComponent(parsed.pathname),
    )) {
      throw new TypeError(`${label} URL path contains a control character`);
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(label)) {
      throw error;
    }
    throw new TypeError(`${label} URL path is not canonical`, { cause: error });
  }
  return value;
}

function renderCheck(
  check: RelayAssuranceModel['checks'][number],
): string {
  const status = check.status.toLocaleUpperCase('en-US');
  const link = check.url === undefined
    ? ''
    : ` ([details](<${safeHttpsUrl(check.url, 'Check URL')}>))`;
  return `- ${status} — ${safeDisplay(check.name)}${link}`;
}

function renderEvidence(evidence: RelayEvidenceLink): string {
  if (
    evidence.digest !== undefined
    && !/^sha256:[0-9a-f]{64}$/.test(evidence.digest)
  ) {
    throw new TypeError('Evidence digest must be a canonical SHA-256 digest');
  }
  const digest = evidence.digest === undefined ? '' : ` — \`${evidence.digest}\``;
  return `- [${safeDisplay(evidence.label)}](<${safeHttpsUrl(
    evidence.url,
    'Evidence URL',
  )}>)${digest}`;
}

export function renderRelayAssuranceComment(
  model: RelayAssuranceModel,
): string {
  requireBoundedItems(model.checks, 'Relay checks');
  requireBoundedItems(model.rounds, 'Relay timeline');
  requireBoundedItems(model.limitations, 'Relay limitations');
  requireBoundedItems(model.technicalEvidence, 'Relay technical evidence');

  const ready = model.status === 'READY FOR HUMAN REVIEW'
    ? validateReadyAssurance(model)
    : undefined;
  const head = ready?.head ?? (model.head === undefined
    ? undefined
    : exactOid(model.head, 'Relay assurance head'));
  const checks = ready?.checks ?? model.checks;
  const solutionOperator = ready?.solutionOperator ?? model.solutionOperator;
  const evaluatorOperator = ready?.evaluator ?? model.evaluator;
  const rounds = ready?.timeline ?? model.rounds;
  if (model.status === 'READY FOR HUMAN REVIEW') {
    if (
      head === undefined
      || solutionOperator === undefined
      || evaluatorOperator === undefined
      || solutionOperator.toLocaleLowerCase('en-US')
        === evaluatorOperator.toLocaleLowerCase('en-US')
      || checks.some(({ status }) => status !== 'passed')
    ) {
      throw new TypeError(
        'Ready assurance requires a distinct evaluator and passed exact-head evidence',
      );
    }
  }

  const headLabel = head === undefined ? 'not yet recorded' : `\`${head}\``;
  const solution = solutionOperator === undefined
    ? 'not yet recorded'
    : `\`${safeDisplay(solutionOperator)}\``;
  const evaluator = evaluatorOperator === undefined
    ? 'not yet recorded'
    : `\`${safeDisplay(evaluatorOperator)}\``;
  const distinct = solutionOperator !== undefined
    && evaluatorOperator !== undefined
    && solutionOperator.toLocaleLowerCase('en-US')
      !== evaluatorOperator.toLocaleLowerCase('en-US');
  const limitations = [
    ...(model.status === 'READY FOR HUMAN REVIEW'
      ? [READY_FOR_REVIEW_LIMITATION]
      : []),
    ...model.limitations.map(safeDisplay).filter((value) => value.length > 0),
  ];
  const checkLines = checks.length === 0
    ? ['- No required GitHub checks were usable; Relay verification and semantic evaluation remain recorded above.']
    : checks.map(renderCheck);
  const timeline = rounds.length === 0
    ? ['- No funded round has been recorded.']
    : rounds.map((item) => {
      safeRound(item.round);
      return `- Round ${item.round} · ${item.purpose} · ${item.outcome} · `
        + `\`${exactOid(item.head, 'Timeline head')}\` — ${safeDisplay(item.summary)}`;
    });
  const evidence = model.technicalEvidence.length === 0
    ? ['- No linked technical evidence has been recorded yet.']
    : model.technicalEvidence.map(renderEvidence);

  return [
    ASSURANCE_MARKER,
    '',
    `# ${model.status}`,
    '',
    `## Assurance for exact revision ${headLabel}`,
    '',
    ...(ready === undefined ? [] : ['- Readiness: ready for human review.']),
    `- Recorded verdict: ${ready === undefined ? lastVerdict(model) : 'passed'} at ${headLabel}.`,
    `- Solution operator: ${solution}.`,
    `- Separate evaluator: ${evaluator}.`,
    `- Role separation: ${distinct
      ? 'the recorded solution and evaluator identities are distinct.'
      : 'distinct recorded identities are not yet available.'}`,
    `- Evaluation scope: the complete cumulative change through ${headLabel}.`,
    '- GitHub authority: marketplace workers supplied artifacts; Relay performed the recorded host mutations.',
    '',
    `### Required checks at ${headLabel}`,
    '',
    ...checkLines,
    ...(limitations.length === 0
      ? []
      : [
          '',
          '### Limitation',
          '',
          ...limitations.flatMap((limitation, index) =>
            index === 0 ? [limitation] : ['', limitation]),
        ]),
    '',
    '## Timeline',
    '',
    ...timeline,
    '',
    '<details>',
    '<summary>Technical receipts and evidence</summary>',
    '',
    ...evidence,
    '',
    '</details>',
  ].join('\n');
}

function preserveTechnicalBlocks(body: string): readonly string[] {
  return [
    ...parseRelayAdoptionReceiptBlocks(body)
      .map(formatRelayAdoptionReceiptBlock),
    ...parseRelayEvaluationAnchorBlocks(body)
      .map(formatRelayEvaluationAnchorBlock),
  ];
}

function composeAssurance(
  model: RelayAssuranceModel,
  technicalBlocks: readonly string[],
): string {
  if (model.status === 'READY FOR HUMAN REVIEW') {
    const ready = validateReadyAssurance(model);
    if (ready.technicalBlocks.some((expected) =>
      technicalBlocks.filter((block) => block === expected).length !== 1
    )) {
      throw new Error(
        'Ready assurance requires its exact preserved receipt and anchor blocks',
      );
    }
  }
  const visible = renderRelayAssuranceComment(model);
  if (technicalBlocks.length === 0) return visible;
  const closing = '\n</details>';
  if (!visible.endsWith(closing)) {
    throw new Error('Relay assurance renderer lost its technical evidence boundary');
  }
  return `${visible.slice(0, -closing.length)}\n\n${technicalBlocks.join('\n\n')}`
    + closing;
}

export function createRelayReportPublisher(options: {
  readonly port: RelayOwnedCommentPort;
}) {
  return {
    async publishIssue(input: {
      readonly repository: string;
      readonly issueNumber: number;
      readonly serviceLogin: string;
      readonly model: RelayIssueStatusModel;
    }): Promise<string> {
      const key = {
        repository: input.repository,
        issueNumber: input.issueNumber,
      };
      const owned = (await options.port.listIssueComments(key))
        .filter((comment) =>
          sameLogin(comment.authorLogin, input.serviceLogin)
          && parseRelayIssueCommentMarker(
            comment.body,
            comment.authorLogin,
            input.serviceLogin,
          ) !== null);
      if (owned.length !== 1 || owned[0] === undefined) {
        throw new Error('Relay must own exactly one durable issue status comment');
      }
      const current = owned[0];
      const currentRecord = parseRelayIssueCommentMarker(
        current.body,
        current.authorLogin,
        input.serviceLogin,
      )!;
      if (!isDeepStrictEqual(currentRecord, input.model.record)) {
        const inner = current.body.slice(current.body.indexOf(ISSUE_MARKER));
        const update = prepareRelayIssueMarkerUpdate({
          current: {
            body: inner,
            authorLogin: current.authorLogin,
            expectedAuthorLogin: input.serviceLogin,
          },
          proposed: input.model.record,
        });
        if (update === null) {
          throw new Error('Relay issue marker update is stale or contradictory');
        }
      }
      const body = renderRelayIssueComment(input.model);
      if (body !== current.body) {
        try {
          await options.port.editIssueComment({
            ...key,
            commentId: current.id,
            expectedBody: current.body,
            body,
          });
        } catch {
          // The edit may have committed before transport failure.
        }
      }
      const readback = (await options.port.listIssueComments(key))
        .filter((comment) =>
          sameLogin(comment.authorLogin, input.serviceLogin)
          && parseRelayIssueCommentMarker(
            comment.body,
            comment.authorLogin,
            input.serviceLogin,
          ) !== null);
      if (
        readback.length !== 1
        || readback[0]?.id !== current.id
        || readback[0].body !== body
        || !isDeepStrictEqual(
          parseRelayIssueCommentMarker(
            readback[0].body,
            readback[0].authorLogin,
            input.serviceLogin,
          ),
          input.model.record,
        )
      ) {
        throw new Error('Relay issue status comment did not read back exactly');
      }
      return body;
    },

    async publishAssurance(input: {
      readonly repository: string;
      readonly prNumber: number;
      readonly expectedHead: string;
      readonly serviceLogin: string;
      readonly model: RelayAssuranceModel;
    }): Promise<string> {
      exactOid(input.expectedHead, 'Expected PR head');
      if (input.model.head !== undefined && input.model.head !== input.expectedHead) {
        throw new Error('Relay assurance model does not describe the expected PR head');
      }
      if (input.model.status === 'READY FOR HUMAN REVIEW') {
        const ready = validateReadyAssurance(input.model);
        if (
          ready.targetRepository !== input.repository
          || ready.prNumber !== input.prNumber
        ) {
          throw new Error(
            'Ready assurance repository or pull request contradicts its evidence',
          );
        }
      }
      const key = {
        repository: input.repository,
        prNumber: input.prNumber,
      };
      const owned = (await options.port.listAssuranceComments(key))
        .filter((comment) =>
          sameLogin(comment.authorLogin, input.serviceLogin)
          && comment.body.startsWith(`${ASSURANCE_MARKER}\n`));
      if (owned.length !== 1 || owned[0] === undefined) {
        throw new Error('Relay must own exactly one PR assurance comment');
      }
      const current = owned[0];
      const technicalBlocks = preserveTechnicalBlocks(current.body);
      const body = composeAssurance(input.model, technicalBlocks);
      if (body !== current.body) {
        try {
          await options.port.editAssuranceComment({
            ...key,
            commentId: current.id,
            expectedHead: input.expectedHead,
            expectedBody: current.body,
            body,
          });
        } catch {
          // The edit may have committed before transport failure.
        }
      }
      const readback = (await options.port.listAssuranceComments(key))
        .filter((comment) =>
          sameLogin(comment.authorLogin, input.serviceLogin)
          && comment.body.startsWith(`${ASSURANCE_MARKER}\n`));
      if (
        readback.length !== 1
        || readback[0]?.id !== current.id
        || readback[0].body !== body
        || !isDeepStrictEqual(
          preserveTechnicalBlocks(readback[0].body),
          technicalBlocks,
        )
      ) {
        throw new Error('Relay assurance comment did not read back exactly');
      }
      return body;
    },
  };
}
