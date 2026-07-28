import { isDeepStrictEqual } from 'node:util';
import {
  formatRelayEvaluationAnchorBlock,
  parseRelayEvaluationAnchorBlock,
  type RelayCheckSummary,
} from './checks.js';
import {
  formatRelayAdoptionReceiptBlock,
  parseRelayAdoptionReceiptBlock,
} from './git-publisher.js';
import {
  formatRelayIssueMarker,
  parseRelayIssueMarker,
  prepareRelayIssueMarkerUpdate,
} from './markers.js';
import type {
  RelayGenerationRecordV1,
  RelayPhase,
} from './state.js';

const ISSUE_MARKER = '<!-- jinn-issue-relay:generation:v1 -->';
const ASSURANCE_MARKER = '<!-- jinn-issue-relay:assurance:v1 -->';
const MAX_DISPLAY_BYTES = 1_024;
const MAX_REPORT_ITEMS = 100;

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
    | 'rejected';
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
  const normalized = value.normalize('NFC');
  let result = '';
  for (const character of normalized) {
    if (Buffer.byteLength(result + character, 'utf8') > MAX_DISPLAY_BYTES) {
      return `${result}…`;
    }
    result += character;
  }
  return result;
}

/**
 * Untrusted issue and marketplace prose is rendered as one inert display line.
 * Authority continues to come only from the strict hidden codecs.
 */
function safeDisplay(value: string): string {
  return bounded(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
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
    .replace(/@/g, '@\u200b')
    .replace(/\bhttps?:\/\//gi, (match) =>
      match.toLocaleLowerCase('en-US').startsWith('https')
        ? 'hxxps://'
        : 'hxxp://')
    .replace(/\bwww\./gi, 'www․')
    .replace(
      /\b(close[sd]?|closing|fix(?:e[sd]?|ing)?|resolve[sd]?|resolving)\b/gi,
      (match) => `${match.slice(0, 3)}\u200b${match.slice(3)}`,
    )
    .replace(/\bsafe to merge\b/gi, 'safe to mer\u200bge')
    .replace(/\bguaranteed\b/gi, 'guaran\u200bteed')
    .replace(/\bmaintainer approved\b/gi, 'maintainer appro\u200bved');
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
  if (
    model.record.generation !== model.generation
    || model.record.phase !== model.phase
  ) {
    throw new TypeError('Relay visible issue status contradicts its durable marker');
  }
  safeRound(model.round);
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

function safeHttpsUrl(value: string, label: string): string {
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
  ) {
    throw new TypeError(`${label} must be an unauthenticated HTTPS URL`);
  }
  return parsed.href.replace(/>/g, '%3E');
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

  const head = model.head === undefined
    ? undefined
    : exactOid(model.head, 'Relay assurance head');
  if (model.status === 'READY FOR HUMAN REVIEW') {
    if (
      head === undefined
      || model.solutionOperator === undefined
      || model.evaluator === undefined
      || model.solutionOperator.toLocaleLowerCase('en-US')
        === model.evaluator.toLocaleLowerCase('en-US')
      || model.checks.some(({ status }) => status !== 'passed')
      || lastVerdict(model) !== 'passed'
    ) {
      throw new TypeError(
        'Ready assurance requires a distinct evaluator and passed exact-head evidence',
      );
    }
  }

  const headLabel = head === undefined ? 'not yet recorded' : `\`${head}\``;
  const solution = model.solutionOperator === undefined
    ? 'not yet recorded'
    : `\`${safeDisplay(model.solutionOperator)}\``;
  const evaluator = model.evaluator === undefined
    ? 'not yet recorded'
    : `\`${safeDisplay(model.evaluator)}\``;
  const distinct = model.solutionOperator !== undefined
    && model.evaluator !== undefined
    && model.solutionOperator.toLocaleLowerCase('en-US')
      !== model.evaluator.toLocaleLowerCase('en-US');
  const limitations = [
    ...(model.status === 'READY FOR HUMAN REVIEW'
      ? [READY_FOR_REVIEW_LIMITATION]
      : []),
    ...model.limitations.map(safeDisplay).filter((value) => value.length > 0),
  ];
  const checkLines = model.checks.length === 0
    ? ['- No required GitHub checks were usable; Relay verification and semantic evaluation remain recorded above.']
    : model.checks.map(renderCheck);
  const timeline = model.rounds.length === 0
    ? ['- No funded round has been recorded.']
    : model.rounds.map((item) => {
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
    `- Recorded verdict: ${lastVerdict(model)} at ${headLabel}.`,
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
  const blocks: string[] = [];
  const receipt = parseRelayAdoptionReceiptBlock(body);
  if (receipt !== null) {
    blocks.push(formatRelayAdoptionReceiptBlock(receipt));
  }
  const anchor = parseRelayEvaluationAnchorBlock(body);
  if (anchor !== null) {
    blocks.push(formatRelayEvaluationAnchorBlock(anchor));
  }
  return blocks;
}

function composeAssurance(
  model: RelayAssuranceModel,
  technicalBlocks: readonly string[],
): string {
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
