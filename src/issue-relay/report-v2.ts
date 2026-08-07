import {
  IssueRelayAdoptionReceiptV1Schema,
  IssueRelayDecisionRequestV1Schema,
  IssueRelayEvaluationAnchorV1Schema,
  IssueRelayHumanDecisionReceiptV1Schema,
  formatIssueRelayDecisionRequestComment,
  formatIssueRelayHumanDecisionReceiptComment,
  issueRelayCanonicalDigest,
  type IssueRelayAdoptionReceiptV1,
  type IssueRelayDecisionRequestV1,
  type IssueRelayEvaluationAnchorV1,
  type IssueRelayHumanDecisionReceiptV1,
} from './contracts.js';
import { renderRelayDecisionCommand } from './decision-protocol.js';
import { formatRelayEvaluationAnchorBlock } from './checks.js';
import { formatRelayAdoptionReceiptBlock } from './git-publisher.js';
import type { RelayLaneGateV2 } from './state-v2.js';

export const RELAY_ASSURANCE_V2_MARKER = '<!-- jinn-issue-relay:assurance:v2 -->';
const RELAY_ASSURANCE_COMPATIBILITY_MARKER =
  '<!-- jinn-issue-relay:assurance:v1 -->';

export interface RelayAssuranceLaneV2 {
  readonly lane: 'security' | 'quality';
  readonly status:
    | 'evaluating'
    | 'retrying'
    | 'passed'
    | 'changes-required'
    | 'decision-required'
    | 'exception-authorised'
    | 'interpretation-authorised'
    | 'blocked'
    | 'operator-required';
  readonly publicSummary: string;
  readonly reviewMethod?: string;
  readonly evaluatorIdentity?: string;
  readonly evidenceDigest?: `sha256:${string}`;
  readonly humanActor?: string;
  readonly automatedEvidence?: readonly {
    readonly tool: string;
    readonly version: string;
    readonly status: 'passed' | 'findings';
    readonly digest: string;
    readonly summary: string;
  }[];
}

function statusTitle(lane: RelayAssuranceLaneV2): string {
  const prefix = lane.lane.toUpperCase();
  switch (lane.status) {
    case 'passed': return `${prefix} PASSED`;
    case 'changes-required': return `${prefix} CHANGES REQUIRED`;
    case 'decision-required': return `${prefix} DECISION REQUIRED`;
    case 'exception-authorised': return `${prefix} EXCEPTION AUTHORISED`;
    case 'interpretation-authorised': return `${prefix} INTERPRETATION AUTHORISED`;
    case 'blocked': return `${prefix} BLOCKED`;
    case 'retrying': return `${prefix} EVALUATION RETRYING`;
    case 'operator-required': return `${prefix} OPERATOR REQUIRED`;
    case 'evaluating': return `${prefix} EVALUATING`;
  }
}

function renderLane(lane: RelayAssuranceLaneV2): string {
  const identity = lane.evaluatorIdentity === undefined
    ? []
    : [`- Evaluator: \`${lane.evaluatorIdentity}\``];
  const method = lane.reviewMethod === undefined
    ? []
    : [`- Review method: ${lane.reviewMethod}`];
  const human = lane.humanActor === undefined
    ? []
    : [`- Human authority: @${lane.humanActor}`];
  const evidence = lane.evidenceDigest === undefined
    ? []
    : [`- Evidence: \`${lane.evidenceDigest}\``];
  const automated = lane.automatedEvidence?.flatMap((item) => {
    const label = item.tool === 'repository-guidance'
      ? 'Repository guidance'
      : 'Automated evidence';
    return [
      `- ${label}: \`${item.tool}@${item.version}\` — ${item.status} — \`${item.digest}\``,
      `  - ${item.summary}`,
    ];
  }) ?? [];
  return [
    `### ${statusTitle(lane)}`,
    '',
    lane.publicSummary,
    ...method,
    ...identity,
    ...human,
    ...evidence,
    ...automated,
  ].join('\n');
}

function renderDecision(request: IssueRelayDecisionRequestV1): string {
  const parsed = IssueRelayDecisionRequestV1Schema.parse(request) as IssueRelayDecisionRequestV1;
  const commandFor = (option: IssueRelayDecisionRequestV1['proposal']['options'][number]) => {
    if (option.effect === 'cancel') {
      return `/jinn-relay cancel ${parsed.requestDigest} ${parsed.exactHead}`;
    }
    if (option.effect === 'clarify-scope') {
      return `/jinn-relay clarify ${parsed.requestDigest} ${parsed.exactHead}`;
    }
    return renderRelayDecisionCommand(parsed, option.optionId);
  };
  const options = parsed.proposal.options.flatMap((option, index) => [
    `#### ${String.fromCharCode(65 + index)} — ${option.title}${option.optionId === parsed.proposal.recommendedOptionId ? ' — recommended' : ''}`,
    '',
    option.description,
    `- Option ID: \`${option.optionId}\``,
    `- Consequences: ${option.consequences.join(' ')}`,
    `- Trade-offs: ${option.tradeoffs.join(' ')}`,
    '',
    '```text',
    commandFor(option),
    '```',
    '',
  ]);
  return [
    `## ${parsed.lane.toUpperCase()} DECISION REQUIRED`,
    '',
    parsed.proposal.question,
    '',
    ...options,
    `Relay recommends \`${parsed.proposal.recommendedOptionId}\` with ${parsed.proposal.recommendationConfidence} confidence.`,
    '',
    parsed.proposal.recommendationRationale,
    '',
    `Required authority: \`${parsed.requiredRole}\`. Expires: ${parsed.expiresAt}.`,
    '',
    '<details><summary>Machine-readable decision request</summary>',
    '',
    formatIssueRelayDecisionRequestComment(parsed),
    '</details>',
  ].join('\n');
}

export function renderRelayAssuranceV2(input: {
  readonly generation: string;
  readonly exactHead: string;
  readonly baseOid: string;
  readonly solutionOperator: string;
  readonly security: RelayAssuranceLaneV2;
  readonly quality: RelayAssuranceLaneV2;
  readonly checksDigest: `sha256:${string}`;
  readonly adoptionReceiptDigest: `sha256:${string}`;
  readonly adoptionReceipt: Extract<IssueRelayAdoptionReceiptV1, { disposition: 'accepted' }>;
  readonly evaluationAnchor: IssueRelayEvaluationAnchorV1;
  readonly humanDecisionReceipts?: readonly IssueRelayHumanDecisionReceiptV1[];
  readonly decisionRequest?: IssueRelayDecisionRequestV1;
  readonly ready?: {
    readonly security: RelayLaneGateV2;
    readonly quality: RelayLaneGateV2;
  };
}): string {
  const receipt = IssueRelayAdoptionReceiptV1Schema.parse(
    input.adoptionReceipt,
  ) as Extract<IssueRelayAdoptionReceiptV1, { disposition: 'accepted' }>;
  const anchor = IssueRelayEvaluationAnchorV1Schema.parse(
    input.evaluationAnchor,
  ) as IssueRelayEvaluationAnchorV1;
  const humanDecisionReceipts = (input.humanDecisionReceipts ?? []).map((value) =>
    IssueRelayHumanDecisionReceiptV1Schema.parse(value) as IssueRelayHumanDecisionReceiptV1);
  if (
    new Set(humanDecisionReceipts.map(({ receiptDigest }) => receiptDigest)).size
      !== humanDecisionReceipts.length
    || humanDecisionReceipts.some(({ generation }) => generation !== input.generation)
  ) throw new TypeError('Relay V2 assurance human decision lineage is contradictory');
  if (
    receipt.disposition !== 'accepted'
    || issueRelayCanonicalDigest(receipt) !== input.adoptionReceiptDigest
    || anchor.adoptionReceiptDigest !== input.adoptionReceiptDigest
    || anchor.checksDigest !== input.checksDigest
    || anchor.evaluatedHead !== input.exactHead
    || receipt.resultingHead !== input.exactHead
  ) {
    throw new TypeError('Relay V2 assurance evidence does not bind the exact head');
  }
  const sameEvaluator = input.security.evaluatorIdentity !== undefined
    && input.security.evaluatorIdentity === input.quality.evaluatorIdentity;
  const readiness = input.ready === undefined
    ? 'This pull request remains draft until both exact-head gates are satisfied.'
    : 'Both exact-head gates are satisfied. This pull request is ready for maintainer review.';
  return [
    RELAY_ASSURANCE_COMPATIBILITY_MARKER,
    RELAY_ASSURANCE_V2_MARKER,
    '# Jinn Issue Relay assurance',
    '',
    readiness,
    '',
    `- Generation: \`${input.generation}\``,
    `- Exact head: \`${input.exactHead}\``,
    `- Frozen base: \`${input.baseOid}\``,
    `- Solution operator: \`${input.solutionOperator}\``,
    `- Adoption receipt: \`${input.adoptionReceiptDigest}\``,
    `- Checks: \`${input.checksDigest}\``,
    '',
    ...(sameEvaluator ? [
      '> Canary limitation: one authenticated evaluator operator performed two separate evaluations. This is not two independent reviews.',
      '',
    ] : []),
    renderLane(input.security),
    '',
    renderLane(input.quality),
    ...(input.decisionRequest === undefined ? [] : ['', renderDecision(input.decisionRequest)]),
    '',
    '> Relay does not auto-merge. Maintainers retain the final repository decision.',
    '',
    '<details><summary>Authenticated marketplace and exact-head evidence</summary>',
    '',
    formatRelayAdoptionReceiptBlock(receipt),
    '',
    formatRelayEvaluationAnchorBlock(anchor),
    ...humanDecisionReceipts.flatMap((receipt) => [
      '',
      formatIssueRelayHumanDecisionReceiptComment(receipt),
    ]),
    '',
    '</details>',
  ].join('\n');
}

export function relayLaneFromGateV2(
  lane: 'security' | 'quality',
  gate: RelayLaneGateV2,
): RelayAssuranceLaneV2 {
  if (gate.status === 'evaluator-pass') {
    return {
      lane,
      status: 'passed',
      publicSummary: `${lane === 'security' ? 'Security' : 'Quality'} evaluation passed for the exact head.`,
      reviewMethod: lane === 'security' ? 'Claude `/security-review`' : 'Claude `/code-review`',
      evaluatorIdentity: gate.evaluatorIdentity,
      evidenceDigest: gate.attestationDigest,
    };
  }
  return {
    lane,
    status: gate.status === 'authorised-noncritical-exception'
      ? 'exception-authorised'
      : 'interpretation-authorised',
    publicSummary: gate.status === 'authorised-noncritical-exception'
      ? 'A repository administrator authorised a noncritical security exception. The evaluator did not pass this behavior.'
      : 'The original authorising maintainer accepted this quality interpretation for the exact head. This is not an independent evaluator pass.',
    reviewMethod: lane === 'security' ? 'Claude `/security-review`' : 'Claude `/code-review`',
    humanActor: gate.humanActor,
    evidenceDigest: gate.attestationDigest,
  };
}
