import { describe, expect, it } from 'vitest';
import { formatRelayEvaluationAnchorBlock } from '../../src/issue-relay/checks.js';
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
} from '../../src/issue-relay/report.js';
import type { RelayGenerationRecordV1 } from '../../src/issue-relay/state.js';
import { buildRelaySnapshot } from '../../src/issue-relay/snapshot.js';

const BASE = '1111111111111111111111111111111111111111';
const HEAD_1 = '2222222222222222222222222222222222222222';
const HEAD_2 = '3333333333333333333333333333333333333333';
const DIGEST = `sha256:${'a'.repeat(64)}` as const;
const CHECKS_DIGEST = `sha256:${'b'.repeat(64)}` as const;

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
    requestId: 'request-1',
    deliveryEnvelopeCid: 'bafy-envelope',
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
  adoptionReceiptDigest: DIGEST,
  checksDigest: CHECKS_DIGEST,
  anchoredAt: '2026-07-28T10:11:00.000Z',
} as const;

const readyModel = {
  status: 'READY FOR HUMAN REVIEW' as const,
  head: HEAD_2,
  solutionOperator: `0x${'1'.repeat(40)}`,
  evaluator: `0x${'2'.repeat(40)}`,
  checks: [
    {
      kind: 'check-run' as const,
      name: 'build',
      appId: 101,
      status: 'passed' as const,
      url: 'https://github.com/Jinn-Network/mono/actions/runs/1',
    },
    {
      kind: 'status-context' as const,
      name: 'relay/typecheck',
      status: 'passed' as const,
    },
  ],
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
