import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  IssueRelayAdoptionReceiptV1Schema,
  IssueRelayEvaluationAnchorV1Schema,
  IssueRelayEvaluationContextV1Schema,
  IssueRelayRoundV1Schema,
  IssueRelayVerdictV1Schema,
} from '../../src/issue-relay/contracts.js';

const fixture = (name: string) => readFileSync(
  new URL(`../fixtures/${name}.json`, import.meta.url),
);

const digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const oid = '1111111111111111111111111111111111111111';
const correlation = {
  generation: 'R_kgDOExample:42:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  round: 1,
  snapshotDigest: digest,
  taskId: 'task-42',
  attemptIndex: 0,
  requestId: 'request-42',
  deliveryEnvelopeCid: 'bafyrelay42',
};
const repairRound = {
  schemaVersion: 'jinn-issue-relay-round.v1' as const,
  generation: correlation.generation,
  round: 1,
  snapshotDigest: digest,
  targetRepository: 'Jinn-Network/mono',
  workspaceRepository: 'Jinn-Network/mono',
  inputHead: oid,
  purpose: 'repair' as const,
  findings: [{ code: 'test-failure', title: 'Test fails', detail: 'The test fails.' }],
  prNumber: 42,
};
const acceptedReceipt = {
  schemaVersion: 'jinn-issue-relay-adoption.v1' as const,
  disposition: 'accepted' as const,
  correlation,
  targetRepository: 'Jinn-Network/mono',
  workspaceRepository: 'Jinn-Network/mono',
  issueNumber: 1889,
  prNumber: 42,
  headRef: 'relay/1889',
  inputHead: oid,
  resultingHead: '2222222222222222222222222222222222222222',
  patchDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  solutionSafe: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  adoptedAt: '2026-07-28T12:00:00.000Z',
};
const anchor = {
  schemaVersion: 'jinn-issue-relay-evaluation-anchor.v1' as const,
  correlation,
  targetRepository: 'Jinn-Network/mono',
  workspaceRepository: 'Jinn-Network/mono',
  prNumber: 42,
  targetBase: 'main',
  baseOid: oid,
  headRef: 'relay/1889',
  evaluatedHead: '2222222222222222222222222222222222222222',
  adoptionReceiptDigest: 'sha256:3dafed6b323a92e7d5aa1c011490270f24f853da52da2fd18aba43cfbdc398c3',
  checksDigest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  anchoredAt: '2026-07-28T12:01:00.000Z',
};
const context = {
  schemaVersion: 'jinn-issue-relay-evaluation-context.v1' as const,
  goal: {
    snapshotDigest: digest,
    problemStatement: 'Repair the reported test failure.',
    acceptanceEvidence: ['The focused test passes.'],
    verificationProfile: 'jinn-mono.v1' as const,
  },
  operators: {
    solutionSafe: acceptedReceipt.solutionSafe,
    evaluatorSafe: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  },
  round: repairRound,
  correlation,
  reviewTarget: {
    targetRepository: 'Jinn-Network/mono',
    workspaceRepository: 'Jinn-Network/mono',
    issueNumber: 1889,
    prNumber: 42,
    targetBase: 'main',
    baseOid: oid,
    headRef: 'relay/1889',
    evaluatedHead: '2222222222222222222222222222222222222222',
  },
  adoptionReceipt: acceptedReceipt,
  evaluationAnchor: anchor,
  checks: {
    digest: anchor.checksDigest,
    required: [{ name: 'typecheck', status: 'passed' as const }],
    optional: [{ name: 'lint', status: 'pending' as const }],
  },
};

describe('local Issue Relay wire mirrors', () => {
  it('decodes the canonical repair-round fixture and preserves its bytes', () => {
    const bytes = fixture('issue-relay-round.v1');

    expect(bytes.length).toBe(583);
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('c1452710d36c6c4bc674e43c1ffb689c4b784e7886e68a6650a6232602a038ed');
    expect(IssueRelayRoundV1Schema.parse(JSON.parse(bytes.toString('utf8'))))
      .toMatchObject({ purpose: 'repair', prNumber: 42 });
  });

  it('decodes the canonical accepted-adoption fixture and preserves its bytes', () => {
    const bytes = fixture('issue-relay-adoption.v1');

    expect(bytes.length).toBe(928);
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('3967e7f0150718cbe1b65f9c801ba87ee9a74ce6af2536bc8fe26b3b738b1671');
    expect(IssueRelayAdoptionReceiptV1Schema.parse(JSON.parse(bytes.toString('utf8'))))
      .toMatchObject({ disposition: 'accepted', issueNumber: 1889 });
  });

  it('rejects an otherwise-valid round with an unrecognized wire field', () => {
    const round = JSON.parse(fixture('issue-relay-round.v1').toString('utf8'));

    expect(IssueRelayRoundV1Schema.safeParse({ ...round, injected: true }).success)
      .toBe(false);
  });

  it('decodes the evaluation anchor and binds every evaluation-context correlation', () => {
    expect(IssueRelayEvaluationAnchorV1Schema.parse(anchor)).toEqual(anchor);
    expect(IssueRelayEvaluationContextV1Schema.parse(context)).toEqual(context);
    expect(IssueRelayEvaluationContextV1Schema.safeParse({
      ...context,
      operators: { ...context.operators, evaluatorSafe: acceptedReceipt.solutionSafe },
    }).success).toBe(false);
  });

  it('requires outcome-specific verdict findings', () => {
    const pass = {
      schemaVersion: 'jinn-issue-relay-verdict.v1' as const,
      outcome: 'pass' as const,
      correlation,
      evaluatedHead: anchor.evaluatedHead,
      summary: 'All checks passed.',
      findings: [],
    };

    expect(IssueRelayVerdictV1Schema.safeParse(pass).success).toBe(true);
    expect(IssueRelayVerdictV1Schema.safeParse({
      ...pass,
      outcome: 'request-changes',
    }).success).toBe(false);
    expect(IssueRelayVerdictV1Schema.safeParse({
      ...pass,
      findings: [{ code: 'x', title: 'Problem', detail: 'Needs fixing.' }],
    }).success).toBe(false);
  });
});
