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

function canonicalJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(
        (value as Record<string, unknown>)[key],
      )}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

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
  workspaceRepository: 'jinn-relay/mono',
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
  workspaceRepository: 'jinn-relay/mono',
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
  workspaceRepository: 'jinn-relay/mono',
  prNumber: 42,
  targetBase: 'main',
  baseOid: oid,
  headRef: 'relay/1889',
  evaluatedHead: '2222222222222222222222222222222222222222',
  adoptionReceiptDigest: canonicalDigest(acceptedReceipt),
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
    workspaceRepository: 'jinn-relay/mono',
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

    expect(bytes.length).toBe(581);
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('df3b9f8cf8db25bc1a0273f5b4a02efb93623d3e356ea32a6b5da40877b845c6');
    expect(IssueRelayRoundV1Schema.parse(JSON.parse(bytes.toString('utf8'))))
      .toMatchObject({ purpose: 'repair', prNumber: 42 });
  });

  it('decodes the canonical accepted-adoption fixture and preserves its bytes', () => {
    const bytes = fixture('issue-relay-adoption.v1');

    expect(bytes.length).toBe(926);
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('4f8a60bc5bf1a9f6c4cd67034fdc43b9e81b2405d401ed1efde10484b4d6c740');
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

  it('keeps an initial solver input upstream while reviewing the adopted managed-fork head', () => {
    const managedFork = 'jinn-relay/mono';
    const initialCorrelation = { ...correlation, round: 0 };
    const initialReceipt = {
      ...acceptedReceipt,
      correlation: initialCorrelation,
      workspaceRepository: managedFork,
    };
    const initialAnchor = {
      ...anchor,
      correlation: initialCorrelation,
      workspaceRepository: managedFork,
      adoptionReceiptDigest: canonicalDigest(initialReceipt),
    };
    const initialContext = {
      ...context,
      round: {
        ...repairRound,
        round: 0,
        purpose: 'initial' as const,
        findings: [],
        prNumber: undefined,
        workspaceRepository: acceptedReceipt.targetRepository,
      },
      correlation: initialCorrelation,
      reviewTarget: {
        ...context.reviewTarget,
        workspaceRepository: managedFork,
      },
      adoptionReceipt: initialReceipt,
      evaluationAnchor: initialAnchor,
    };

    expect(IssueRelayEvaluationContextV1Schema.safeParse(initialContext).success)
      .toBe(true);
  });

  it('rejects initial findings and bounds evaluation collections', () => {
    expect(IssueRelayRoundV1Schema.safeParse({
      ...repairRound,
      purpose: 'initial',
      prNumber: undefined,
    }).success).toBe(false);
    expect(IssueRelayEvaluationContextV1Schema.safeParse({
      ...context,
      goal: {
        ...context.goal,
        acceptanceEvidence: Array.from(
          { length: 51 },
          (_, index) => `Acceptance item ${index}`,
        ),
      },
    }).success).toBe(false);
    expect(IssueRelayEvaluationContextV1Schema.safeParse({
      ...context,
      checks: {
        ...context.checks,
        required: Array.from(
          { length: 1001 },
          (_, index) => ({ name: `required-${index}`, status: 'passed' as const }),
        ),
      },
    }).success).toBe(false);
  });

  /**
   * mono PR #2918 — a dependabot bump that touches the workflows — carries 144
   * check contexts on its head commit. The Relay now reads that head whole
   * rather than at GitHub's 100-row page boundary, so the context that carries
   * the evidence has to admit every context the bounded walk can return.
   */
  it('admits a head whose check evidence outruns a single GitHub page', () => {
    const optional = Array.from(
      { length: 144 },
      (_, index) => ({ name: `check-${index}`, status: 'passed' as const }),
    );

    expect(IssueRelayEvaluationContextV1Schema.safeParse({
      ...context,
      checks: { ...context.checks, optional },
    }).success).toBe(true);
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
