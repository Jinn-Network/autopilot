import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  issueRelayCanonicalDigest,
  type IssueRelayAdoptionReceiptV1,
  type IssueRelayEvaluationAnchorV1,
  type IssueRelayRoundV2,
} from '../../../src/issue-relay/contracts.js';
import {
  formatIssueRelayAdoptionReceiptComment,
  formatIssueRelayEvaluationAnchorComment,
} from '../../../src/issue-relay/evaluator/issue-relay-comment.js';
import {
  createIssueRelayEvaluationContextResolver,
} from '../../../src/issue-relay/evaluator/evaluation-context-resolver.js';
import type {
  IssueRelayGitHubReadPort,
} from '../../../src/issue-relay/evaluator/github-receipt-observer.js';
import { relayGeneration, relayTaskKey } from '../../../src/issue-relay/identity.js';
import { IssueRelayMarketplaceTaskSchema } from '../../../src/issue-relay/marketplace-application.js';
import { formatRelayIssueMarkerV2 } from '../../../src/issue-relay/markers-v2.js';
import { buildRelaySnapshot } from '../../../src/issue-relay/snapshot.js';
import type { RelayGenerationRecordV2 } from '../../../src/issue-relay/state-v2.js';
import { buildRelayTaskSpecV2 } from '../../../src/issue-relay/task.js';

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const baseOid = '1'.repeat(40);
const head = '2'.repeat(40);
const solutionSafe = `0x${'1'.repeat(40)}`;
const evaluatorSafe = `0x${'2'.repeat(40)}`;
const checksDigest = digest('b');
const solutionEnvelopeCid = `f01551220${'3'.repeat(64)}`;
const taskCid = `f01551220${'4'.repeat(64)}`;
const requestId = `0x${'5'.repeat(64)}`;

const snapshot = buildRelaySnapshot({
  repository: {
    slug: 'Jinn-Network/mono',
    nodeId: 'R_kgDOExample',
    visibility: 'PUBLIC',
    defaultBranch: 'next',
    baseOid,
  },
  issue: {
    number: 42,
    url: 'https://github.com/Jinn-Network/mono/issues/42',
    title: 'Evaluate Relay V2',
    body: 'Review both exact-head lanes.',
    authorLogin: 'maintainer',
    authorId: 'U_maintainer',
    updatedAt: '2026-08-06T12:00:00.000Z',
  },
  optIn: {
    label: 'engine:marketplace',
    actorLogin: 'maintainer',
    createdAt: '2026-08-06T12:01:00.000Z',
    permission: 'MAINTAIN',
  },
  language: 'typescript',
  verificationProfile: 'jinn-mono.v1',
  acceptanceEvidence: ['Both lanes evaluate the exact adopted head.'],
  admissionPolicyVersion: 'jinn-issue-relay-admission.v1',
  capturedAt: '2026-08-06T12:02:00.000Z',
});
const generation = relayGeneration(snapshot);
const round: IssueRelayRoundV2 = {
  schemaVersion: 'jinn-issue-relay-round.v2',
  generation,
  round: 0,
  snapshotDigest: snapshot.snapshotDigest,
  targetRepository: 'Jinn-Network/mono',
  workspaceRepository: 'Jinn-Network/mono',
  inputHead: baseOid,
  purpose: 'initial',
  findings: [],
};
const evaluation = {
  relayBotLogin: 'jinn-relay[bot]',
  requiredChecks: ['test'],
  laneSpecifications: {
    security: digest('c'),
    quality: digest('d'),
  },
};
const task = IssueRelayMarketplaceTaskSchema.parse(
  buildRelayTaskSpecV2({ snapshot, round, evaluation }).spec,
);
const correlation = {
  generation,
  round: 0,
  snapshotDigest: snapshot.snapshotDigest,
  taskId: '501',
  attemptIndex: 0,
  requestId,
  deliveryEnvelopeCid: solutionEnvelopeCid,
};
const patch = 'diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n';
const solution = {
  schemaVersion: 'jinn-issue-relay-solution.v2' as const,
  patch,
  pullRequest: {
    title: 'Evaluate Relay V2 safely',
    body: '## Summary\n\nEvaluates the exact adopted head.\n\n## Testing\n\n- test',
  },
};
const receipt: Extract<IssueRelayAdoptionReceiptV1, { disposition: 'accepted' }> = {
  schemaVersion: 'jinn-issue-relay-adoption.v1',
  disposition: 'accepted',
  correlation,
  targetRepository: 'Jinn-Network/mono',
  workspaceRepository: 'jinn-relay/mono',
  issueNumber: 42,
  prNumber: 314,
  headRef: 'jinn/relay-v2',
  inputHead: baseOid,
  resultingHead: head,
  patchDigest: `sha256:${createHash('sha256').update(patch).digest('hex')}`,
  solutionSafe,
  adoptedAt: '2026-08-06T12:10:00.000Z',
};
const adoptionReceiptDigest = issueRelayCanonicalDigest(receipt);
const anchor: IssueRelayEvaluationAnchorV1 = {
  schemaVersion: 'jinn-issue-relay-evaluation-anchor.v1',
  correlation,
  targetRepository: 'Jinn-Network/mono',
  workspaceRepository: receipt.workspaceRepository,
  prNumber: receipt.prNumber,
  targetBase: 'next',
  baseOid,
  headRef: receipt.headRef,
  evaluatedHead: head,
  adoptionReceiptDigest,
  checksDigest,
  anchoredAt: '2026-08-06T12:12:00.000Z',
};

function generationMarker(): string {
  const record: RelayGenerationRecordV2 = {
    schemaVersion: 'jinn-issue-relay-generation.v2',
    generation,
    snapshot,
    phase: 'evaluating',
    executionDeadlineAt: '2026-08-07T12:02:00.000Z',
    rounds: [{
      round: 0,
      purpose: 'initial',
      workspaceRepository: 'Jinn-Network/mono',
      inputHead: baseOid,
      fundingIntent: {
        taskKey: relayTaskKey(generation, 0),
        creatorSafe: `0x${'6'.repeat(40)}`,
        solverNetManifestCid: 'bafy-jinn-repo',
        requestDigest: digest('7'),
        maximumSpendWei: '1',
        spendWei: '1',
        preparedAt: '2026-08-06T12:04:00.000Z',
      },
      task: {
        taskKey: relayTaskKey(generation, 0),
        taskId: correlation.taskId,
        taskCid,
        spendWei: '1',
        fundedAt: '2026-08-06T12:05:00.000Z',
      },
      solution: {
        envelopeCid: solutionEnvelopeCid,
        operatorSafe: solutionSafe,
        observedAt: '2026-08-06T12:08:00.000Z',
      },
      adoption: {
        disposition: 'accepted',
        resultingHead: head,
        prNumber: 314,
        receiptDigest: adoptionReceiptDigest,
        recordedAt: receipt.adoptedAt,
      },
      checks: {
        head,
        status: 'passed',
        digest: checksDigest,
        observedAt: '2026-08-06T12:11:00.000Z',
      },
      evaluation: {
        head,
        anchorDigest: issueRelayCanonicalDigest(anchor),
        anchoredAt: anchor.anchoredAt,
      },
      laneAttempts: { security: [], quality: [] },
    }],
    decisions: [],
    pr: {
      number: 314,
      branch: receipt.headRef,
      head,
      draft: true,
      targetRepository: 'Jinn-Network/mono',
      targetRepositoryId: 'R_kgDOExample',
      forkRepository: receipt.workspaceRepository,
      forkRepositoryId: 'R_kgDOFork',
      forkParentRepositoryId: 'R_kgDOExample',
      visibility: 'PUBLIC',
      managedFork: true,
    },
    updatedAt: anchor.anchoredAt,
  };
  return formatRelayIssueMarkerV2(record);
}

function github(): IssueRelayGitHubReadPort {
  const timestamp = anchor.anchoredAt;
  const assurance = [
    '<!-- jinn-issue-relay:assurance:v2 -->',
    '',
    formatIssueRelayAdoptionReceiptComment(receipt),
    '',
    formatIssueRelayEvaluationAnchorComment(anchor),
  ].join('\n');
  return {
    listIssueComments: async () => ({
      comments: [{
        id: 1,
        authorLogin: 'jinn-relay[bot]',
        body: generationMarker(),
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
    }),
    listPullRequestComments: async () => ({
      comments: [{
        id: 2,
        authorLogin: 'jinn-relay[bot]',
        body: assurance,
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
    }),
    readPullRequest: async () => ({
      number: 314,
      title: solution.pullRequest.title,
      body: solution.pullRequest.body,
      targetRepository: 'Jinn-Network/mono',
      workspaceRepository: receipt.workspaceRepository,
      targetBase: 'next',
      baseOid,
      headRef: receipt.headRef,
      headSha: head,
      checks: {
        digest: checksDigest,
        required: [{ name: 'test', status: 'passed' }],
        optional: [],
      },
    }),
  };
}

const provenance = {
  sourceTaskId: correlation.taskId,
  sourceTaskCid: taskCid,
  attemptIndex: correlation.attemptIndex,
  solutionRequestId: correlation.requestId,
  solutionEnvelopeCid: correlation.deliveryEnvelopeCid,
  solutionOperatorSafe: solutionSafe,
  evaluatorOperatorSafe: evaluatorSafe,
};

describe('Issue Relay V2 evaluation context resolver', () => {
  it('reconstructs exact Autopilot evaluation policy from authenticated marketplace and public host facts', async () => {
    const observation = await createIssueRelayEvaluationContextResolver({
      github: github(),
      relayBotLogin: evaluation.relayBotLogin,
      laneSpecifications: evaluation.laneSpecifications,
    }).resolve({ task, solution, provenance });

    expect(observation).toMatchObject({
      state: 'accepted',
      context: {
        schemaVersion: 'jinn-issue-relay-evaluation-context.v2',
        operators: { solutionSafe, evaluatorSafe },
        reviewTarget: {
          evaluatedHead: head,
          pullRequest: {
            title: solution.pullRequest.title,
            body: solution.pullRequest.body,
          },
        },
        laneSpecifications: evaluation.laneSpecifications,
        priorDecisions: [],
      },
    });
  });

  it('rejects a marketplace patch that differs from the host adoption receipt', async () => {
    const observation = await createIssueRelayEvaluationContextResolver({
      github: github(),
      relayBotLogin: evaluation.relayBotLogin,
      laneSpecifications: evaluation.laneSpecifications,
    }).resolve({
      task,
      solution: { ...solution, patch: `${solution.patch}\nmalicious replacement` },
      provenance,
    });

    expect(observation).toMatchObject({
      state: 'contradictory',
      detail: 'Relay Solution patch digest is contradictory',
    });
  });
});
