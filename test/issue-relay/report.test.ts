import { describe, expect, it } from 'vitest';
import {
  aggregateRelayChecks,
  formatRelayEvaluationAnchorBlock,
  relayAdoptionReceiptDigest,
} from '../../src/issue-relay/checks.js';
import {
  formatRelayAdoptionReceiptBlock,
  parseRelayAdoptionReceiptBlock,
} from '../../src/issue-relay/git-publisher.js';
import { formatRelayIssueMarker } from '../../src/issue-relay/markers.js';
import {
  READY_FOR_REVIEW_LIMITATION,
  createRelayReportPublisher,
  parseRelayIssueCommentMarker,
  renderRelayAssuranceComment,
  renderRelayIssueComment,
  type RelayOwnedCommentPort,
  type RelayReadyAssuranceEvidence,
} from '../../src/issue-relay/report.js';
import type { RelayGenerationRecordV1 } from '../../src/issue-relay/state.js';
import { buildRelaySnapshot } from '../../src/issue-relay/snapshot.js';

const BASE = '1111111111111111111111111111111111111111';
const HEAD_1 = '2222222222222222222222222222222222222222';
const HEAD_2 = '3333333333333333333333333333333333333333';
const DIGEST = `sha256:${'a'.repeat(64)}` as const;

const snapshot = buildRelaySnapshot({
  repository: {
    slug: 'Jinn-Network/mono',
    nodeId: 'R_kgDOExample',
    visibility: 'PUBLIC',
    defaultBranch: 'main',
    baseOid: BASE,
  },
  issue: {
    number: 101,
    url: 'https://github.com/Jinn-Network/mono/issues/101',
    title: 'Render the Relay report',
    body: 'The body is frozen.',
    authorLogin: 'maintainer',
    authorId: 'MDQ6VXNlcjE=',
    updatedAt: '2026-07-28T10:00:00.000Z',
  },
  optIn: {
    label: 'engine:marketplace',
    actorLogin: 'maintainer',
    createdAt: '2026-07-28T10:01:00.000Z',
    permission: 'MAINTAIN',
  },
  language: 'typescript',
  verificationProfile: 'jinn-mono.v1',
  acceptanceEvidence: ['The report is inspectable.'],
  admissionPolicyVersion: 'jinn-issue-relay-admission.v1',
  capturedAt: '2026-07-28T10:02:00.000Z',
});

const generation = `${snapshot.repository.nodeId}:${snapshot.issue.number}:${snapshot.snapshotDigest}`;
const record: RelayGenerationRecordV1 = {
  schemaVersion: 'jinn-issue-relay-generation.v1',
  generation,
  snapshot,
  phase: 'submitted',
  deadlineAt: '2026-07-28T13:02:00.000Z',
  rounds: [{
    round: 0,
    purpose: 'initial',
    workspaceRepository: 'Jinn-Network/mono',
    inputHead: BASE,
    task: {
      taskKey: `issue-relay:${generation}:round:0`,
      taskId: '123',
      taskCid: 'bafy-task',
      fundedAt: '2026-07-28T10:03:00.000Z',
    },
  }],
  updatedAt: '2026-07-28T10:03:00.000Z',
};

const receipt = {
  schemaVersion: 'jinn-issue-relay-adoption.v1',
  disposition: 'accepted',
  correlation: {
    generation,
    round: 1,
    snapshotDigest: snapshot.snapshotDigest,
    taskId: '124',
    attemptIndex: 0,
    requestId: `0x${'9'.repeat(64)}`,
    deliveryEnvelopeCid: `f01551220${'4'.repeat(64)}`,
  },
  targetRepository: 'Jinn-Network/mono',
  workspaceRepository: 'jinn-relay/mono',
  issueNumber: 101,
  prNumber: 68,
  headRef: 'jinn/issue-relay/example',
  inputHead: HEAD_1,
  resultingHead: HEAD_2,
  patchDigest: DIGEST,
  solutionSafe: `0x${'1'.repeat(40)}`,
  adoptedAt: '2026-07-28T10:10:00.000Z',
} as const;
const adoption = {
  status: 'accepted',
  receipt,
  branch: receipt.headRef,
  resultingHead: receipt.resultingHead,
  prNumber: receipt.prNumber,
} as const;
const checks = aggregateRelayChecks({
  head: HEAD_2,
  branchRequiredChecks: [{ name: 'build', appId: 101 }],
  profile: {
    name: 'jinn-mono.v1',
    requiredChecks: ['relay/typecheck'],
  },
  checks: [
    {
      kind: 'check-run',
      name: 'build',
      appId: 101,
      head: HEAD_2,
      status: 'completed',
      conclusion: 'success',
      url: 'https://github.com/Jinn-Network/mono/actions/runs/1',
    },
    {
      kind: 'status-context',
      name: 'relay/typecheck',
      head: HEAD_2,
      state: 'success',
    },
  ],
});
const anchor = {
  schemaVersion: 'jinn-issue-relay-evaluation-anchor.v1',
  correlation: receipt.correlation,
  targetRepository: receipt.targetRepository,
  workspaceRepository: receipt.workspaceRepository,
  prNumber: receipt.prNumber,
  targetBase: 'main',
  baseOid: BASE,
  headRef: receipt.headRef,
  evaluatedHead: HEAD_2,
  adoptionReceiptDigest: relayAdoptionReceiptDigest(adoption),
  checksDigest: checks.digest,
  anchoredAt: '2026-07-28T10:11:00.000Z',
} as const;
const verdict = {
  status: 'verified',
  role: 'verdict',
  task: {
    taskId: receipt.correlation.taskId,
    taskCid: `f01551220${'5'.repeat(64)}`,
  },
  attempt: {
    attemptIndex: receipt.correlation.attemptIndex,
    requestId: receipt.correlation.requestId,
    operator: `0x${'2'.repeat(40)}`,
  },
  delivery: {
    envelopeCid: `f01551220${'6'.repeat(64)}`,
    transactionHash: `0x${'7'.repeat(64)}`,
    blockNumber: 130,
  },
  round: {
    schemaVersion: 'jinn-issue-relay-round.v1',
    generation,
    round: 1,
    snapshotDigest: snapshot.snapshotDigest,
    targetRepository: receipt.targetRepository,
    workspaceRepository: receipt.workspaceRepository,
    inputHead: HEAD_1,
    purpose: 'repair',
    findings: [{
      code: 'test-failure',
      title: 'Regression missing',
      detail: 'Add a focused regression test.',
    }],
    prNumber: receipt.prNumber,
  },
  payload: {
    schemaVersion: 'jinn-issue-relay-verdict.v1',
    outcome: 'pass',
    correlation: receipt.correlation,
    evaluatedHead: HEAD_2,
    summary: 'The complete cumulative head passed evaluation.',
    findings: [],
  },
} as const;
const readyRecord = {
  ...record,
  phase: 'ready',
  rounds: [
    {
      ...record.rounds[0]!,
      solution: {
        envelopeCid: `f01551220${'0'.repeat(64)}`,
        operatorSafe: `0x${'3'.repeat(40)}`,
        observedAt: '2026-07-28T10:04:00.000Z',
      },
      adoption: {
        disposition: 'accepted',
        resultingHead: HEAD_1,
        receiptDigest: `sha256:${'0'.repeat(64)}`,
      },
      checks: {
        head: HEAD_1,
        status: 'passed',
        digest: `sha256:${'1'.repeat(64)}`,
      },
      verdict: {
        outcome: 'request-changes',
        evaluatedHead: HEAD_1,
        envelopeCid: `f01551220${'1'.repeat(64)}`,
      },
    },
    {
      round: 1,
      purpose: 'repair',
      workspaceRepository: receipt.workspaceRepository,
      inputHead: HEAD_1,
      task: {
        taskKey: `issue-relay:${generation}:round:1`,
        taskId: receipt.correlation.taskId,
        taskCid: verdict.task.taskCid,
        fundedAt: '2026-07-28T10:05:00.000Z',
      },
      solution: {
        envelopeCid: receipt.correlation.deliveryEnvelopeCid,
        operatorSafe: receipt.solutionSafe,
        observedAt: '2026-07-28T10:06:00.000Z',
      },
      adoption: {
        disposition: 'accepted',
        resultingHead: HEAD_2,
        receiptDigest: anchor.adoptionReceiptDigest,
      },
      checks: {
        head: HEAD_2,
        status: 'passed',
        digest: checks.digest,
      },
      verdict: {
        outcome: 'pass',
        evaluatedHead: HEAD_2,
        envelopeCid: verdict.delivery.envelopeCid,
      },
    },
  ],
  pr: {
    number: receipt.prNumber,
    branch: receipt.headRef,
    head: HEAD_2,
    draft: false,
  },
  updatedAt: '2026-07-28T10:12:00.000Z',
} satisfies RelayGenerationRecordV1;
const supersededSnapshot = buildRelaySnapshot({
  repository: snapshot.repository,
  issue: {
    ...snapshot.issue,
    updatedAt: '2026-07-28T10:20:00.000Z',
  },
  optIn: snapshot.optIn,
  language: snapshot.language,
  verificationProfile: snapshot.verificationProfile,
  acceptanceEvidence: snapshot.acceptanceEvidence,
  admissionPolicyVersion: snapshot.admissionPolicyVersion,
  capturedAt: '2026-07-28T10:20:01.000Z',
});
const supersededGeneration =
  `${supersededSnapshot.repository.nodeId}:${supersededSnapshot.issue.number}:`
  + supersededSnapshot.snapshotDigest;
const supersededRecord = {
  ...readyRecord,
  generation: supersededGeneration,
  snapshot: supersededSnapshot,
  rounds: readyRecord.rounds.map((round) => ({
    ...round,
    task: round.task === undefined
      ? undefined
      : {
          ...round.task,
          taskKey: `issue-relay:${supersededGeneration}:round:${round.round}`,
        },
  })),
} satisfies RelayGenerationRecordV1;
const readyEvidence = {
  record: readyRecord,
  currentHead: HEAD_2,
  currentBaseOid: BASE,
  targetBase: 'main',
  draft: {
    number: receipt.prNumber,
    branch: receipt.headRef,
    head: HEAD_2,
    base: 'main',
    open: true,
    draft: true,
    generation,
  },
  currentPr: {
    number: receipt.prNumber,
    branch: receipt.headRef,
    head: HEAD_2,
    base: 'main',
    open: true,
    draft: false,
    generation,
  },
  adoption,
  checks,
  evaluationAnchor: anchor,
  verdict,
  adoptionReceiptBlock: formatRelayAdoptionReceiptBlock(receipt),
  evaluationAnchorBlock: formatRelayEvaluationAnchorBlock(anchor),
} satisfies RelayReadyAssuranceEvidence;

const readyModel = {
  status: 'READY FOR HUMAN REVIEW' as const,
  head: HEAD_2,
  readyEvidence,
  solutionOperator: receipt.solutionSafe,
  evaluator: verdict.attempt.operator,
  checks: checks.required,
  rounds: [
    {
      round: 0,
      purpose: 'initial' as const,
      head: HEAD_1,
      outcome: 'adopted' as const,
      summary: 'Initial solution adopted.',
    },
    {
      round: 0,
      purpose: 'initial' as const,
      head: HEAD_1,
      outcome: 'request-changes' as const,
      summary: 'Evaluator found a missing regression test.',
    },
    {
      round: 1,
      purpose: 'repair' as const,
      head: HEAD_2,
      outcome: 'adopted' as const,
      summary: 'Repair added the regression test.',
    },
    {
      round: 1,
      purpose: 'repair' as const,
      head: HEAD_2,
      outcome: 'passed' as const,
      summary: 'Full cumulative head passed evaluation.',
    },
  ],
  limitations: [],
  technicalEvidence: [{
    label: 'Adoption receipt',
    url: 'https://jinn.example/evidence/adoption',
    digest: DIGEST,
  }],
};

describe('Relay issue status rendering', () => {
  it('composes visible status with exactly one strict durable marker', () => {
    const rendered = renderRelayIssueComment({
      record,
      generation,
      phase: 'submitted',
      round: 0,
      summary: 'Task funded; waiting for a solution.',
      nextAction: 'Relay will observe the funded round.',
    });

    expect(rendered).toMatchInlineSnapshot(`
      "## Jinn Issue Relay — SUBMITTED

      - Generation: \`R＿kgDOExample:101:sha256:dd2241a3f2e4865b572fc038b6d52fd91823f7c534c6672507c3a31a46d152b1\`
      - Round: 0
      - Summary: Task funded; waiting for a solution.
      - Next action: Relay will observe the funded round.

      Closing the issue or removing \`engine:marketplace\` requests soft cancellation. Already-funded marketplace work cannot be withdrawn on-chain.

      <!-- jinn-issue-relay:generation:v1 -->

      \`\`\`json
      {"schemaVersion":"jinn-issue-relay-generation.v1","generation":"R_kgDOExample:101:sha256:dd2241a3f2e4865b572fc038b6d52fd91823f7c534c6672507c3a31a46d152b1","snapshot":{"repository":{"slug":"Jinn-Network/mono","nodeId":"R_kgDOExample","visibility":"PUBLIC","defaultBranch":"main","baseOid":"1111111111111111111111111111111111111111"},"issue":{"number":101,"url":"https://github.com/Jinn-Network/mono/issues/101","title":"Render the Relay report","body":"The body is frozen.","authorLogin":"maintainer","authorId":"MDQ6VXNlcjE=","updatedAt":"2026-07-28T10:00:00.000Z"},"optIn":{"label":"engine:marketplace","actorLogin":"maintainer","createdAt":"2026-07-28T10:01:00.000Z","permission":"MAINTAIN"},"language":"typescript","verificationProfile":"jinn-mono.v1","acceptanceEvidence":["The report is inspectable."],"admissionPolicyVersion":"jinn-issue-relay-admission.v1","capturedAt":"2026-07-28T10:02:00.000Z","schemaVersion":"jinn-issue-relay-snapshot.v1","snapshotDigest":"sha256:dd2241a3f2e4865b572fc038b6d52fd91823f7c534c6672507c3a31a46d152b1"},"phase":"submitted","deadlineAt":"2026-07-28T13:02:00.000Z","rounds":[{"round":0,"purpose":"initial","workspaceRepository":"Jinn-Network/mono","inputHead":"1111111111111111111111111111111111111111","task":{"taskKey":"issue-relay:R_kgDOExample:101:sha256:dd2241a3f2e4865b572fc038b6d52fd91823f7c534c6672507c3a31a46d152b1:round:0","taskId":"123","taskCid":"bafy-task","fundedAt":"2026-07-28T10:03:00.000Z"}}],"updatedAt":"2026-07-28T10:03:00.000Z"}
      \`\`\`"
    `);
    expect(rendered.match(/<!-- jinn-issue-relay:generation:v1 -->/g))
      .toHaveLength(1);
    expect(parseRelayIssueCommentMarker(rendered, 'jinn-relay[bot]'))
      .toEqual(record);
    expect(formatRelayIssueMarker(record)).not.toContain('Task funded');
  });

  it('renders cancellation visibly and neutralizes issue/marketplace Markdown injection', () => {
    const cancelled = {
      ...record,
      phase: 'cancelling',
      cancellation: {
        requestedAt: '2026-07-28T10:04:00.000Z',
        reason: 'operator',
      },
      updatedAt: '2026-07-28T10:04:00.000Z',
    } satisfies RelayGenerationRecordV1;
    const rendered = renderRelayIssueComment({
      record: cancelled,
      generation,
      phase: 'cancelling',
      round: 0,
      summary: '# @maintainer [click](https://evil.test)\nCloses #9\n```html\n<b>x</b>',
      nextAction: '<!-- jinn-issue-relay:generation:v1 -->',
    });

    expect(rendered).toContain('## Jinn Issue Relay — CANCELLED');
    expect(rendered.match(/<!-- jinn-issue-relay:generation:v1 -->/g))
      .toHaveLength(1);
    expect(rendered).not.toContain('@maintainer');
    expect(rendered).not.toContain('[click](');
    expect(rendered).not.toContain('Closes #9');
    expect(rendered).not.toContain('```html');
    expect(rendered).not.toContain('<b>');
    expect(parseRelayIssueCommentMarker(rendered, 'jinn-relay[bot]'))
      .toEqual(cancelled);
  });

  it('rejects an issue status round that is not the durable latest round', () => {
    expect(() => renderRelayIssueComment({
      record,
      generation,
      phase: 'submitted',
      round: 1,
      summary: 'Waiting.',
      nextAction: 'Observe.',
    })).toThrow(/round|durable|marker/i);
  });

  it('rejects missing, invented, or contradictory PR numbers', () => {
    expect(() => renderRelayIssueComment({
      record,
      generation,
      phase: 'submitted',
      prNumber: 68,
      round: 0,
      summary: 'Waiting.',
      nextAction: 'Observe.',
    })).toThrow(/pull request|durable|marker/i);

    const withPr = {
      ...record,
      phase: 'draft-open',
      pr: {
        number: 68,
        branch: 'jinn/issue-relay/example',
        head: HEAD_1,
        draft: true,
      },
    } satisfies RelayGenerationRecordV1;
    expect(() => renderRelayIssueComment({
      record: withPr,
      generation,
      phase: 'draft-open',
      round: 0,
      summary: 'Draft open.',
      nextAction: 'Evaluate.',
    })).toThrow(/pull request|durable|marker/i);
    expect(() => renderRelayIssueComment({
      record: withPr,
      generation,
      phase: 'draft-open',
      prNumber: 69,
      round: 0,
      summary: 'Draft open.',
      nextAction: 'Evaluate.',
    })).toThrow(/pull request|durable|marker/i);
  });

  it('finds the structural marker when frozen issue prose contains marker text', () => {
    const embeddedSnapshot = buildRelaySnapshot({
      repository: snapshot.repository,
      issue: {
        ...snapshot.issue,
        body: 'Untrusted prose names <!-- jinn-issue-relay:generation:v1 -->.',
      },
      optIn: snapshot.optIn,
      language: snapshot.language,
      verificationProfile: snapshot.verificationProfile,
      acceptanceEvidence: snapshot.acceptanceEvidence,
      admissionPolicyVersion: snapshot.admissionPolicyVersion,
      capturedAt: snapshot.capturedAt,
    });
    const embeddedGeneration =
      `${embeddedSnapshot.repository.nodeId}:${embeddedSnapshot.issue.number}:`
      + embeddedSnapshot.snapshotDigest;
    const embeddedRecord: RelayGenerationRecordV1 = {
      ...record,
      generation: embeddedGeneration,
      snapshot: embeddedSnapshot,
      rounds: [{
        ...record.rounds[0]!,
        task: {
          ...record.rounds[0]!.task!,
          taskKey: `issue-relay:${embeddedGeneration}:round:0`,
        },
      }],
    };
    const rendered = renderRelayIssueComment({
      record: embeddedRecord,
      generation: embeddedGeneration,
      phase: 'submitted',
      round: 0,
      summary: 'Waiting.',
      nextAction: 'Observe.',
    });

    expect(parseRelayIssueCommentMarker(rendered, 'jinn-relay[bot]'))
      .toEqual(embeddedRecord);
  });
});

describe('Relay PR assurance rendering', () => {
  const model = readyModel;

  it('leads with exact-head assurance, keeps failures/repairs visible, then shows the timeline', () => {
    const rendered = renderRelayAssuranceComment(model);

    expect(rendered).toMatchInlineSnapshot(`
      "<!-- jinn-issue-relay:assurance:v1 -->

      # READY FOR HUMAN REVIEW

      ## Assurance for exact revision \`3333333333333333333333333333333333333333\`

      - Recorded verdict: passed at \`3333333333333333333333333333333333333333\`.
      - Solution operator: \`0x1111111111111111111111111111111111111111\`.
      - Separate evaluator: \`0x2222222222222222222222222222222222222222\`.
      - Role separation: the recorded solution and evaluator identities are distinct.
      - Evaluation scope: the complete cumulative change through \`3333333333333333333333333333333333333333\`.
      - GitHub authority: marketplace workers supplied artifacts; Relay performed the recorded host mutations.

      ### Required checks at \`3333333333333333333333333333333333333333\`

      - PASSED — build ([details](<https://github.com/Jinn-Network/mono/actions/runs/1>))
      - PASSED — relay/typecheck

      ### Limitation

      Jinn has independently evaluated this exact revision and the recorded checks
      passed. This is evidence for maintainer review, not a guarantee of correctness
      or approval to merge.

      ## Timeline

      - Round 0 · initial · adopted · \`2222222222222222222222222222222222222222\` — Initial solution adopted.
      - Round 0 · initial · request-changes · \`2222222222222222222222222222222222222222\` — Evaluator found a missing regression test.
      - Round 1 · repair · adopted · \`3333333333333333333333333333333333333333\` — Repair added the regression test.
      - Round 1 · repair · passed · \`3333333333333333333333333333333333333333\` — Full cumulative head passed evaluation.

      <details>
      <summary>Technical receipts and evidence</summary>

      - [Adoption receipt](<https://jinn.example/evidence/adoption>) — \`sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\`

      </details>"
    `);
    expect(rendered.indexOf('## Assurance')).toBeLessThan(
      rendered.indexOf('## Timeline'),
    );
    expect(rendered).toContain(READY_FOR_REVIEW_LIMITATION);
    expect(rendered).not.toMatch(/safe to merge|guaranteed|maintainer approved/i);
  });

  it('derives READY head, operators, and checks from validated authority', () => {
    const rendered = renderRelayAssuranceComment({
      ...readyModel,
      head: HEAD_2,
      solutionOperator: `0x${'a'.repeat(40)}`,
      evaluator: `0x${'b'.repeat(40)}`,
      checks: [{
        kind: 'status-context',
        name: 'spoofed/display-only',
        status: 'passed',
      }],
    });

    expect(rendered).toContain(receipt.solutionSafe);
    expect(rendered).toContain(verdict.attempt.operator);
    expect(rendered).toContain('PASSED — build');
    expect(rendered).not.toContain(`0x${'a'.repeat(40)}`);
    expect(rendered).not.toContain(`0x${'b'.repeat(40)}`);
    expect(rendered).not.toContain('spoofed/display-only');
  });

  it('allows an empty required-check set only when its exact digest is anchored', () => {
    const emptyChecks = aggregateRelayChecks({
      head: HEAD_2,
      branchRequiredChecks: [],
      profile: { name: 'jinn-mono.v1', requiredChecks: [] },
      checks: [],
    });
    const emptyAnchor = {
      ...anchor,
      checksDigest: emptyChecks.digest,
    };
    const rendered = renderRelayAssuranceComment({
      ...readyModel,
      checks: [],
      readyEvidence: {
        ...readyEvidence,
        record: {
          ...readyRecord,
          rounds: readyRecord.rounds.map((round) =>
            round.round === 1
              ? {
                  ...round,
                  checks: {
                    ...round.checks!,
                    digest: emptyChecks.digest,
                  },
                }
              : round),
        },
        checks: emptyChecks,
        evaluationAnchor: emptyAnchor,
        evaluationAnchorBlock: formatRelayEvaluationAnchorBlock(emptyAnchor),
      },
    });

    expect(rendered).toContain('No required GitHub checks were usable');
    expect(rendered).toContain('Recorded verdict: passed');
  });

  it('does not hide negative evidence and neutralizes every untrusted display string', () => {
    const attack = '# @maintainer [fix](https://evil.test) Closes #9 ``` <b>x</b>';
    const rendered = renderRelayAssuranceComment({
      ...model,
      status: 'REPAIR IN PROGRESS',
      evaluator: attack,
      checks: [{ ...model.checks[0], name: attack, url: undefined }],
      rounds: [{
        ...model.rounds[1],
        summary: attack,
      }],
      limitations: [attack],
      technicalEvidence: [{
        label: attack,
        url: 'https://evidence.example/receipt',
      }],
    });

    expect(rendered).toContain('request-changes');
    expect(rendered).not.toContain('@maintainer');
    expect(rendered).not.toContain('[fix](');
    expect(rendered).not.toContain('Closes #9');
    expect(rendered).not.toContain('```');
    expect(rendered).not.toContain('<b>');
    expect(rendered).not.toContain('\n# @\u200bmaintainer');
  });

  it('removes Unicode controls and bounds the fully sanitized display bytes deterministically', () => {
    const attack = [
      '\u0007',
      '\u0085',
      '\u061c',
      '\u200b',
      '\u200d',
      '\u2028',
      '\u2029',
      '\u202e',
      '\u2066',
      '\u2069',
      '\ufeff',
      '@'.repeat(2_000),
    ].join('');
    const model = {
      ...readyModel,
      status: 'IN PROGRESS' as const,
      readyEvidence: undefined,
      evaluator: attack,
    };

    const rendered = renderRelayAssuranceComment(model);
    const replay = renderRelayAssuranceComment(model);
    const line = rendered.split('\n')
      .find((candidate) => candidate.startsWith('- Separate evaluator:'));
    const display = line === undefined ? undefined : /`(.*)`/.exec(line)?.[1];

    expect(replay).toBe(rendered);
    expect(display).toBeDefined();
    expect(Buffer.byteLength(display!, 'utf8')).toBeLessThanOrEqual(1_024);
    expect(display).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(rendered.replaceAll('\n', ''))
      .not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  });

  it('rejects a runtime-invalid technical digest before Markdown rendering', () => {
    expect(() => renderRelayAssuranceComment({
      ...model,
      technicalEvidence: [{
        label: 'Receipt',
        url: 'https://evidence.example/receipt',
        digest: 'sha256:bad`\n</details>\n@maintainer',
      }],
    } as unknown as Parameters<typeof renderRelayAssuranceComment>[0]))
      .toThrow(/digest/i);
  });

  it.each([
    ['userinfo', 'https://user:secret@evidence.example/receipt'],
    ['token query', 'https://evidence.example/receipt?token=secret'],
    ['fragment', 'https://evidence.example/receipt#token'],
    ['raw control', 'https://evidence.example/\u0000receipt'],
    ['encoded control', 'https://evidence.example/%0Areceipt'],
    ['oversized URL', `https://evidence.example/${'a'.repeat(1_025)}`],
    ['noncanonical scheme', 'HTTPS://evidence.example/receipt'],
    ['noncanonical host', 'https://EVIDENCE.example/receipt'],
    ['noncanonical port', 'https://evidence.example:443/receipt'],
    ['lowercase percent escape', 'https://evidence.example/%2freceipt'],
    ['percent-encoded unreserved byte', 'https://evidence.example/%41'],
  ])('rejects a %s evidence URL instead of emitting it', (_label, url) => {
    expect(() => renderRelayAssuranceComment({
      ...readyModel,
      status: 'IN PROGRESS',
      readyEvidence: undefined,
      technicalEvidence: [{
        label: 'Receipt',
        url,
      }],
    })).toThrow(/URL|evidence|canonical|HTTPS/i);
  });

  it('rejects READY when structured exact authority is missing even if display claims pass', () => {
    expect(() => renderRelayAssuranceComment({
      ...readyModel,
      readyEvidence: undefined,
      solutionOperator: receipt.solutionSafe,
      evaluator: verdict.attempt.operator,
      checks: checks.required,
    } as unknown as Parameters<typeof renderRelayAssuranceComment>[0]))
      .toThrow(/ready|evidence|authority/i);
  });

  it.each([
    [
      'missing durable record',
      {
        ...readyEvidence,
        record: undefined,
      },
    ],
    [
      'persisted cancellation',
      {
        ...readyEvidence,
        record: {
          ...readyRecord,
          phase: 'cancelling',
          cancellation: {
            requestedAt: '2026-07-28T10:13:00.000Z',
            reason: 'operator',
          },
          updatedAt: '2026-07-28T10:13:00.000Z',
        },
      },
    ],
    [
      'cancellation marker on a ready-shaped record',
      {
        ...readyEvidence,
        record: {
          ...readyRecord,
          cancellation: {
            requestedAt: '2026-07-28T10:13:00.000Z',
            reason: 'operator',
          },
          updatedAt: '2026-07-28T10:13:00.000Z',
        },
      },
    ],
    [
      'exhausted generation',
      {
        ...readyEvidence,
        record: {
          ...readyRecord,
          phase: 'exhausted',
        },
      },
    ],
    [
      'closed generation',
      {
        ...readyEvidence,
        record: {
          ...readyRecord,
          phase: 'closed',
        },
      },
    ],
    [
      'superseded generation',
      {
        ...readyEvidence,
        record: supersededRecord,
      },
    ],
    [
      'durable check digest mismatch',
      {
        ...readyEvidence,
        record: {
          ...readyRecord,
          rounds: readyRecord.rounds.map((round) =>
            round.round === 1
              ? {
                  ...round,
                  checks: {
                    ...round.checks!,
                    digest: `sha256:${'8'.repeat(64)}`,
                  },
                }
              : round),
        },
      },
    ],
  ] as const)('rejects READY with %s state', (_label, invalidEvidence) => {
    expect(() => renderRelayAssuranceComment({
      ...readyModel,
      readyEvidence: invalidEvidence,
    } as unknown as Parameters<typeof renderRelayAssuranceComment>[0]))
      .toThrow(/ready|durable|cancel|exhaust|closed|generation/i);
  });

  it('rejects a durable READY record whose PR is still draft', () => {
    expect(() => renderRelayAssuranceComment({
      ...readyModel,
      readyEvidence: {
        ...readyEvidence,
        record: {
          ...readyRecord,
          pr: {
            ...readyRecord.pr,
            draft: true,
          },
        },
      },
    })).toThrow(/ready|durable|draft/i);
  });

  it.each([
    ['closed', { ...readyEvidence.currentPr, open: false }],
    ['still draft', { ...readyEvidence.currentPr, draft: true }],
  ] as const)('rejects READY when the current PR authority is %s', (
    _label,
    currentPr,
  ) => {
    expect(() => renderRelayAssuranceComment({
      ...readyModel,
      readyEvidence: {
        ...readyEvidence,
        currentPr,
      } as unknown as RelayReadyAssuranceEvidence,
    })).toThrow(/ready|durable|draft|open/i);
  });

  it('rejects READY when the captured Task 10 proof is no longer a draft', () => {
    expect(() => renderRelayAssuranceComment({
      ...readyModel,
      readyEvidence: {
        ...readyEvidence,
        draft: {
          ...readyEvidence.draft,
          draft: false,
        },
      },
    })).toThrow(/ready|evidence|draft/i);
  });

  it('rejects READY when the durable latest round uses a different workspace', () => {
    expect(() => renderRelayAssuranceComment({
      ...readyModel,
      readyEvidence: {
        ...readyEvidence,
        record: {
          ...readyRecord,
          rounds: readyRecord.rounds.map((round) =>
            round.round === 1
              ? {
                  ...round,
                  workspaceRepository: receipt.targetRepository,
                }
              : round),
        },
      },
    })).toThrow(/ready|durable|workspace/i);
  });

  it('rejects READY when the durable latest round uses a different input head', () => {
    const alternateInput = '4444444444444444444444444444444444444444';
    const recordWithAlternateInput = {
      ...readyRecord,
      rounds: readyRecord.rounds.map((round) => {
        if (round.round === 0) {
          return {
            ...round,
            adoption: {
              ...round.adoption!,
              resultingHead: alternateInput,
            },
            checks: {
              ...round.checks!,
              head: alternateInput,
            },
            verdict: {
              ...round.verdict!,
              evaluatedHead: alternateInput,
            },
          };
        }
        return {
          ...round,
          inputHead: alternateInput,
        };
      }),
    } satisfies RelayGenerationRecordV1;

    expect(() => renderRelayAssuranceComment({
      ...readyModel,
      readyEvidence: {
        ...readyEvidence,
        record: recordWithAlternateInput,
      },
    })).toThrow(/ready|durable|input|head/i);
  });

  it('rejects READY when the verdict describes a different round purpose', () => {
    const { prNumber: _prNumber, ...initialRound } = verdict.round;

    expect(() => renderRelayAssuranceComment({
      ...readyModel,
      readyEvidence: {
        ...readyEvidence,
        verdict: {
          ...verdict,
          round: {
            ...initialRound,
            purpose: 'initial',
            findings: [],
          },
        },
      },
    })).toThrow(/ready|durable|purpose/i);
  });

  it('rejects READY when the repair verdict names a different PR', () => {
    expect(() => renderRelayAssuranceComment({
      ...readyModel,
      readyEvidence: {
        ...readyEvidence,
        verdict: {
          ...verdict,
          round: {
            ...verdict.round,
            prNumber: receipt.prNumber + 1,
          },
        },
      },
    })).toThrow(/ready|durable|PR/i);
  });

  it.each([
    [
      'stale anchor',
      {
        ...readyEvidence,
        evaluationAnchor: { ...anchor, evaluatedHead: HEAD_1 },
      },
    ],
    [
      'missing anchor',
      {
        ...readyEvidence,
        evaluationAnchor: undefined,
      },
    ],
    [
      'wrong receipt block',
      {
        ...readyEvidence,
        adoptionReceiptBlock: '',
      },
    ],
    [
      'wrong anchor block',
      {
        ...readyEvidence,
        evaluationAnchorBlock: formatRelayEvaluationAnchorBlock({
          ...anchor,
          checksDigest: `sha256:${'8'.repeat(64)}`,
        }),
      },
    ],
    [
      'wrong check digest',
      {
        ...readyEvidence,
        evaluationAnchor: {
          ...anchor,
          checksDigest: `sha256:${'8'.repeat(64)}`,
        },
      },
    ],
    [
      'wrong receipt digest',
      {
        ...readyEvidence,
        evaluationAnchor: {
          ...anchor,
          adoptionReceiptDigest: `sha256:${'8'.repeat(64)}`,
        },
        evaluationAnchorBlock: formatRelayEvaluationAnchorBlock({
          ...anchor,
          adoptionReceiptDigest: `sha256:${'8'.repeat(64)}`,
        }),
      },
    ],
    [
      'same evaluator',
      {
        ...readyEvidence,
        verdict: {
          ...verdict,
          attempt: {
            ...verdict.attempt,
            operator: receipt.solutionSafe,
          },
        },
      },
    ],
    [
      'non-verdict role',
      {
        ...readyEvidence,
        verdict: {
          ...verdict,
          role: 'solution',
        },
      },
    ],
    [
      'non-pass verdict',
      {
        ...readyEvidence,
        verdict: {
          ...verdict,
          payload: {
            ...verdict.payload,
            outcome: 'human',
            summary: 'A human decision is required.',
          },
        },
      },
    ],
    [
      'stale verdict head',
      {
        ...readyEvidence,
        verdict: {
          ...verdict,
          payload: {
            ...verdict.payload,
            evaluatedHead: HEAD_1,
          },
        },
      },
    ],
    [
      'wrong verdict correlation',
      {
        ...readyEvidence,
        verdict: {
          ...verdict,
          payload: {
            ...verdict.payload,
            correlation: {
              ...verdict.payload.correlation,
              round: 0,
            },
          },
        },
      },
    ],
  ] as const)('rejects READY with %s authority', (_label, invalidEvidence) => {
    expect(() => renderRelayAssuranceComment({
      ...readyModel,
      readyEvidence: invalidEvidence,
    } as unknown as Parameters<typeof renderRelayAssuranceComment>[0]))
      .toThrow(/ready|evidence|authority/i);
  });

  it('rejects READY when its passed timeline names another head', () => {
    expect(() => renderRelayAssuranceComment({
      ...readyModel,
      rounds: readyModel.rounds.map((item) =>
        item.outcome === 'passed' ? { ...item, head: HEAD_1 } : item),
    })).toThrow(/ready|timeline|head/i);
  });

  it('rejects an earlier stale pass even when the final pass is authentic', () => {
    expect(() => renderRelayAssuranceComment({
      ...readyModel,
      rounds: [
        {
          round: 0,
          purpose: 'initial',
          head: HEAD_1,
          outcome: 'passed',
          summary: 'Unauthenticated stale pass.',
        },
        ...readyModel.rounds,
      ],
    })).toThrow(/ready|timeline|pass|head/i);
  });

  it('accepts uppercase percent encoding only for a reserved path byte', () => {
    const rendered = renderRelayAssuranceComment({
      ...readyModel,
      status: 'IN PROGRESS',
      readyEvidence: undefined,
      technicalEvidence: [{
        label: 'Canonical evidence',
        url: 'https://evidence.example/round%2F1',
      }],
    });

    expect(rendered).toContain('https://evidence.example/round%2F1');
  });
});

describe('owned Relay report edits', () => {
  it('edits and reads back the one existing issue comment without a create port', async () => {
    let body = `Visible old status\n\n${formatRelayIssueMarker(record)}`;
    const edits: Array<{ readonly id: number; readonly body: string }> = [];
    const port: RelayOwnedCommentPort = {
      async listIssueComments() {
        return [{ id: 7, authorLogin: 'jinn-relay[bot]', body }];
      },
      async editIssueComment(input) {
        edits.push({ id: input.commentId, body: input.body });
        body = input.body;
      },
      async listAssuranceComments() {
        return [];
      },
      async editAssuranceComment() {
        throw new Error('not used');
      },
    };
    const publisher = createRelayReportPublisher({ port });

    await publisher.publishIssue({
      repository: 'Jinn-Network/mono',
      issueNumber: 101,
      serviceLogin: 'jinn-relay[bot]',
      model: {
        record,
        generation,
        phase: 'submitted',
        round: 0,
        summary: 'Waiting for the solution.',
        nextAction: 'Observe the current funded round.',
      },
    });

    expect(edits).toHaveLength(1);
    expect(edits[0]?.id).toBe(7);
    expect(parseRelayIssueCommentMarker(body, 'jinn-relay[bot]')).toEqual(record);
  });

  it('edits and reads back one separate assurance comment while preserving strict receipt and anchor blocks', async () => {
    const receiptBlock = formatRelayAdoptionReceiptBlock(receipt);
    const anchorBlock = formatRelayEvaluationAnchorBlock(anchor);
    let body = [
      '<!-- jinn-issue-relay:assurance:v1 -->',
      '',
      'IN PROGRESS',
      '',
      receiptBlock,
      '',
      anchorBlock,
    ].join('\n');
    const edits: Array<{ readonly id: number; readonly body: string }> = [];
    const port: RelayOwnedCommentPort = {
      async listIssueComments() {
        return [];
      },
      async editIssueComment() {
        throw new Error('not used');
      },
      async listAssuranceComments() {
        return [{ id: 9, authorLogin: 'jinn-relay[bot]', body }];
      },
      async editAssuranceComment(input) {
        edits.push({ id: input.commentId, body: input.body });
        body = input.body;
      },
    };
    const publisher = createRelayReportPublisher({ port });

    await publisher.publishAssurance({
      repository: 'Jinn-Network/mono',
      prNumber: 68,
      expectedHead: HEAD_2,
      serviceLogin: 'jinn-relay[bot]',
      model: readyModel,
    });

    expect(edits).toHaveLength(1);
    expect(edits[0]?.id).toBe(9);
    expect(body).toContain(receiptBlock);
    expect(body).toContain(anchorBlock);
    expect(parseRelayAdoptionReceiptBlock(body)).toEqual(receipt);
    expect(body.indexOf('## Assurance')).toBeLessThan(body.indexOf('## Timeline'));
  });

  it.each([
    [
      'missing',
      [
        '<!-- jinn-issue-relay:assurance:v1 -->',
        '',
        'IN PROGRESS',
      ].join('\n'),
    ],
    [
      'stale',
      [
        '<!-- jinn-issue-relay:assurance:v1 -->',
        '',
        'IN PROGRESS',
        '',
        formatRelayAdoptionReceiptBlock(receipt),
        '',
        formatRelayEvaluationAnchorBlock({
          ...anchor,
          checksDigest: `sha256:${'8'.repeat(64)}`,
        }),
      ].join('\n'),
    ],
  ])('refuses READY when the owned comment has %s technical authority', async (
    _label,
    initialBody,
  ) => {
    let body = initialBody;
    const port: RelayOwnedCommentPort = {
      async listIssueComments() {
        return [];
      },
      async editIssueComment() {
        throw new Error('not used');
      },
      async listAssuranceComments() {
        return [{ id: 9, authorLogin: 'jinn-relay[bot]', body }];
      },
      async editAssuranceComment(input) {
        body = input.body;
      },
    };

    await expect(createRelayReportPublisher({ port }).publishAssurance({
      repository: 'Jinn-Network/mono',
      prNumber: 68,
      expectedHead: HEAD_2,
      serviceLogin: 'jinn-relay[bot]',
      model: readyModel,
    })).rejects.toThrow(/ready|receipt|anchor|evidence/i);
    expect(body).toBe(initialBody);
  });

  it('refuses to publish READY on a repository or PR outside its structured evidence', async () => {
    let body = [
      '<!-- jinn-issue-relay:assurance:v1 -->',
      '',
      'IN PROGRESS',
      '',
      formatRelayAdoptionReceiptBlock(receipt),
      '',
      formatRelayEvaluationAnchorBlock(anchor),
    ].join('\n');
    const initialBody = body;
    const port: RelayOwnedCommentPort = {
      async listIssueComments() {
        return [];
      },
      async editIssueComment() {
        throw new Error('not used');
      },
      async listAssuranceComments() {
        return [{ id: 9, authorLogin: 'jinn-relay[bot]', body }];
      },
      async editAssuranceComment(input) {
        body = input.body;
      },
    };
    const publisher = createRelayReportPublisher({ port });

    await expect(publisher.publishAssurance({
      repository: 'Jinn-Network/other',
      prNumber: 69,
      expectedHead: HEAD_2,
      serviceLogin: 'jinn-relay[bot]',
      model: readyModel,
    })).rejects.toThrow(/repository|pull request|evidence|ready/i);
    expect(body).toBe(initialBody);
  });

  it('fails closed rather than selecting between duplicate owned comments', async () => {
    const port: RelayOwnedCommentPort = {
      async listIssueComments() {
        const body = `Visible\n\n${formatRelayIssueMarker(record)}`;
        return [
          { id: 7, authorLogin: 'jinn-relay[bot]', body },
          { id: 8, authorLogin: 'jinn-relay[bot]', body },
        ];
      },
      async editIssueComment() {
        throw new Error('must not edit');
      },
      async listAssuranceComments() {
        return [];
      },
      async editAssuranceComment() {
        throw new Error('must not edit');
      },
    };

    await expect(createRelayReportPublisher({ port }).publishIssue({
      repository: 'Jinn-Network/mono',
      issueNumber: 101,
      serviceLogin: 'jinn-relay[bot]',
      model: {
        record,
        generation,
        phase: 'submitted',
        round: 0,
        summary: 'Waiting.',
        nextAction: 'Observe.',
      },
    })).rejects.toThrow(/exactly one/i);
  });
});
