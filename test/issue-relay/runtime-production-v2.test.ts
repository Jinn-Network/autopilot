import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IssueRelayConfigV2 } from '../../src/issue-relay/config.js';
import type { RelayGitHubProductionAuthorityPort } from '../../src/issue-relay/github-production.js';
import type { RelayGitHubReadPort, RelayGitHubWritePort } from '../../src/issue-relay/github-port.js';
import type { IssueRelayMarketplaceCli } from '../../src/issue-relay/marketplace-cli.js';
import { parseRelayIssueMarkerV2 } from '../../src/issue-relay/markers-v2.js';
import { runIssueRelayCycleV2 } from '../../src/issue-relay/reconciler-v2.js';
import {
  createRelayDurableArtifactStore,
} from '../../src/issue-relay/runtime-production.js';
import {
  createIssueRelayProductionReconciliationV2,
} from '../../src/issue-relay/runtime-production-v2.js';
import type { RelayAdoptionCoordinator } from '../../src/issue-relay/adoption.js';

const directories: string[] = [];
const base = '1'.repeat(40);

const config: IssueRelayConfigV2 = {
  schemaVersion: 2,
  repository: 'Jinn-Network/mono',
  label: 'engine:marketplace',
  relayBotLogin: 'jinn-relay',
  managedForkRepository: 'jinn-relay/mono',
  targetBase: 'main',
  solverNet: 'jinn-repo',
  verificationProfile: 'jinn-mono.v1',
  requiredChecks: ['test'],
  pollSeconds: 30,
  generationProtocol: 'v2',
  dualLaneEvaluationEnabled: true,
  humanDecisionCommandsEnabled: true,
  decisionImplementationEnabled: true,
  laneSpecifications: {
    security: `sha256:${'a'.repeat(64)}`,
    quality: `sha256:${'b'.repeat(64)}`,
  },
  safePreimplementationReasonCodes: ['compatibility-choice'],
  budget: {
    maxGlobalActiveGenerations: 10,
    maxActivePerRepository: 10,
    maxActivePerAuthor: 3,
    maxRoundsPerGeneration: 4,
    maxGenerationSpendWei: 4_000n,
    maxGlobalSpendWeiPerUtcDay: 100_000n,
    generationDeadlineMs: 60 * 60_000,
    maxEvaluationAttemptsPerLanePerHead: 2,
    maxEvaluationRetrySpendWei: 500n,
    maxDecisionRequestsPerGeneration: 3,
    maxDecisionImplementationRoundsPerGeneration: 2,
    maxDecisionImplementationSpendWei: 2_000n,
    humanDecisionTtlMs: 14 * 24 * 60 * 60_000,
    maxHumanDeferrals: 1,
    humanDeferralExtensionMs: 14 * 24 * 60 * 60_000,
    decisionContinuationDeadlineMs: 24 * 60 * 60_000,
  },
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Relay V2 production composition', () => {
  it('publishes the V2 generation and pins funding before marketplace submission', async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'relay-v2-production-'));
    directories.push(stateDirectory);
    chmodSync(stateDirectory, 0o700);
    let now = new Date('2026-08-06T12:00:00.000Z');
    const comments: { id: number; authorLogin: string; body: string }[] = [];
    const issue = {
      repository: {
        slug: 'Jinn-Network/mono', nodeId: 'R_mono', visibility: 'PUBLIC' as const,
        defaultBranch: 'main',
      },
      issue: {
        number: 42,
        url: 'https://github.com/Jinn-Network/mono/issues/42',
        title: 'Add exact Relay V2 recovery',
        body: '- [ ] V2 state survives restart.\n- [ ] Existing V1 remains green.',
        authorLogin: 'alice', authorId: 'U_alice',
        updatedAt: '2026-08-06T11:59:00.000Z', state: 'OPEN' as const,
        isPullRequest: false, labels: ['engine:marketplace'],
      },
    };
    const githubRead: RelayGitHubReadPort = {
      async searchOptedInIssues() { return { issues: [issue] }; },
      async readIssue() { return issue; },
      async listLabelEvents() {
        return [{
          action: 'labeled', label: 'engine:marketplace', actorLogin: 'alice',
          actorId: 'U_alice', createdAt: '2026-08-06T11:59:30.000Z',
        }];
      },
      async readRepositoryPermission() { return 'WRITE'; },
      async readDefaultBranchHead() { return base; },
    };
    const githubAuthority: RelayGitHubProductionAuthorityPort = {
      async listIssueNumbersForMarkerRecovery() { return comments.length === 0 ? [] : [42]; },
      async listIssueComments() { return comments; },
      async createIssueCommentExact(input) {
        const created = { id: 1, authorLogin: config.relayBotLogin, body: input.body };
        comments.push(created);
        return created;
      },
      async editIssueCommentExact(input) {
        const current = comments.find(({ id }) => id === input.commentId);
        if (current?.body !== input.expectedBody) throw new Error('expected-body mismatch');
        const edited = { ...current, body: input.body };
        comments.splice(comments.indexOf(current), 1, edited);
        return edited;
      },
      async readPullRequest() { throw new Error('not reached'); },
      async readChecks() { throw new Error('not reached'); },
      async listAssuranceComments() { return []; },
      async editAssuranceCommentExact() { throw new Error('not reached'); },
    };
    let allowSubmit = false;
    const marketplace = {
      async dryRun() {
        return {
          id: 'dry-run', creatorSafe: `0x${'1'.repeat(40)}`,
          solverNetManifestCid: 'bafy-solver-net', proposedSpendWei: 900n,
        };
      },
      async submit() {
        if (!allowSubmit) throw new Error('submission must occur only after funding is durable');
        return {
          id: parseRelayIssueMarkerV2(comments[0]!.body)!.rounds[0]!.fundingIntent!.taskKey,
          taskId: '501', taskCid: `f01551220${'c'.repeat(64)}`,
          creationTx: `0x${'d'.repeat(64)}`, creationBlock: 100,
          solverNetManifestCid: 'bafy-solver-net', idempotent: false,
        };
      },
      async observe() { throw new Error('not reached'); },
    } as unknown as IssueRelayMarketplaceCli;
    const reconciliation = createIssueRelayProductionReconciliationV2({
      config,
      stateDirectory,
      githubRead,
      githubWrite: {} as RelayGitHubWritePort,
      githubAuthority,
      marketplace,
      adopter: {} as RelayAdoptionCoordinator,
      artifacts: createRelayDurableArtifactStore(stateDirectory, { deferCreation: true }),
      now: () => now,
    });

    const admitted = await runIssueRelayCycleV2({ config, mode: 'active', reconciliation });
    expect(admitted.actions).toMatchObject([{ action: 'publish-generation', outcome: 'completed' }]);
    expect(parseRelayIssueMarkerV2(comments[0]!.body)?.phase).toBe('admitted');

    now = new Date('2026-08-06T12:00:01.000Z');
    const funding = await runIssueRelayCycleV2({ config, mode: 'active', reconciliation });
    expect(funding.actions).toMatchObject([{ action: 'prepare-round', outcome: 'completed' }]);
    const record = parseRelayIssueMarkerV2(comments[0]!.body);
    expect(record?.phase).toBe('funding');
    expect(record?.rounds[0]?.fundingIntent).toMatchObject({
      spendWei: '900',
      maximumSpendWei: '1000',
    });
    expect(record?.rounds[0]?.task).toBeUndefined();

    allowSubmit = true;
    now = new Date('2026-08-06T12:00:02.000Z');
    const submitted = await runIssueRelayCycleV2({ config, mode: 'active', reconciliation });
    expect(submitted.actions).toMatchObject([{ action: 'submit-round', outcome: 'completed' }]);
    expect(parseRelayIssueMarkerV2(comments[0]!.body)).toMatchObject({
      phase: 'submitted',
      rounds: [{ task: { taskId: '501', spendWei: '900' } }],
    });
  });
});
