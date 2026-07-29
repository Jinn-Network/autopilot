import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcceptedRelayAdoption } from '../../src/issue-relay/adoption.js';
import type { IssueRelayConfig } from '../../src/issue-relay/config.js';
import {
  IssueRelayAdoptionReceiptV1Schema,
  IssueRelayRoundV1Schema,
  type IssueRelayAdoptionReceiptV1,
  type IssueRelayRoundV1,
} from '../../src/issue-relay/contracts.js';
import {
  formatRelayAdoptionReceiptBlock,
  type RelayPullRequest,
} from '../../src/issue-relay/git-publisher.js';
import { relayBranch } from '../../src/issue-relay/identity.js';
import type {
  IssueRelayDeliveryExpectation,
} from '../../src/issue-relay/marketplace-state.js';
import {
  parseRelayIssueCommentMarker,
} from '../../src/issue-relay/report.js';
import {
  createIssueRelayProductionReconciliation,
  createRelayDurableArtifactStore,
} from '../../src/issue-relay/runtime-production.js';
import {
  runIssueRelayCycle,
  type IssueRelayRuntimePorts,
  type RelayCycleReport,
} from '../../src/issue-relay/reconciler.js';

const directories: string[] = [];
const BASE = '1'.repeat(40);
const HEADS = ['2'.repeat(40), '3'.repeat(40)] as const;
const TARGET_REPOSITORY_ID = 'R_target';
const FORK_REPOSITORY_ID = 'R_fork';
const ISSUE_NUMBER = 1889;
const SERVICE_LOGIN = 'jinn-relay';
const EVALUATOR_SAFE = `0x${'b'.repeat(40)}`;
const CREATOR_SAFE = `0x${'c'.repeat(40)}`;
const ASSURANCE_MARKER = '<!-- jinn-issue-relay:assurance:v1 -->';
const ADOPTION_MARKER = '<!-- jinn-issue-relay:adoption:v1 -->';
const ANCHOR_MARKER = '<!-- jinn-issue-relay:evaluation-anchor:v1 -->';

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

function cid(character: string): string {
  return `f01551220${character.repeat(64)}`;
}

function tx(character: string): string {
  return `0x${character.repeat(64)}`;
}

function relayConfig(maxRoundsPerGeneration = 2): IssueRelayConfig {
  return {
    schemaVersion: 1,
    repository: 'Jinn-Network/mono',
    label: 'engine:marketplace',
    relayBotLogin: SERVICE_LOGIN,
    managedForkRepository: 'jinn-relay/mono',
    targetBase: 'main',
    solverNet: 'jinn-repo',
    verificationProfile: 'jinn-mono.v1',
    requiredChecks: ['test'],
    pollSeconds: 30,
    budget: {
      maxGlobalActiveGenerations: 1,
      maxActivePerRepository: 1,
      maxActivePerAuthor: 1,
      maxRoundsPerGeneration,
      maxGenerationSpendWei: BigInt(maxRoundsPerGeneration),
      maxGlobalSpendWeiPerUtcDay: BigInt(maxRoundsPerGeneration),
      generationDeadlineMs: 86_400_000,
    },
  };
}

async function canonicalFixtures(): Promise<{
  readonly round: IssueRelayRoundV1;
  readonly adoption: Extract<
  IssueRelayAdoptionReceiptV1,
  { readonly disposition: 'accepted' }
  >;
}> {
  const [roundBytes, adoptionBytes] = await Promise.all([
    readFile(new URL('../fixtures/issue-relay-round.v1.json', import.meta.url)),
    readFile(new URL('../fixtures/issue-relay-adoption.v1.json', import.meta.url)),
  ]);
  const round = IssueRelayRoundV1Schema.parse(
    JSON.parse(roundBytes.toString('utf8')) as unknown,
  ) as IssueRelayRoundV1;
  const adoption = IssueRelayAdoptionReceiptV1Schema.parse(
    JSON.parse(adoptionBytes.toString('utf8')) as unknown,
  ) as IssueRelayAdoptionReceiptV1;
  if (adoption.disposition !== 'accepted') {
    throw new Error('Canonical adoption fixture must be accepted');
  }
  return { round, adoption };
}

interface VerticalOptions {
  readonly verdicts: readonly ('request-changes' | 'pass')[];
  readonly crashAfterFirstForkPush?: boolean;
  readonly cancelAfterInitialAdoption?: boolean;
}

async function createVerticalFixture(options: VerticalOptions) {
  const contracts = await canonicalFixtures();
  const root = await mkdtemp(join(tmpdir(), 'issue-relay-vertical-'));
  directories.push(root);
  const stateDirectory = join(root, 'state');
  const artifacts = createRelayDurableArtifactStore(stateDirectory);
  const config = relayConfig(options.verdicts.length);
  const issue = {
    repository: {
      slug: 'Jinn-Network/mono',
      nodeId: TARGET_REPOSITORY_ID,
      visibility: 'PUBLIC' as const,
      defaultBranch: 'main',
    },
    issue: {
      number: ISSUE_NUMBER,
      url: `https://github.com/Jinn-Network/mono/issues/${ISSUE_NUMBER}`,
      title: 'Prove the Relay vertical loop',
      body: '## Acceptance\n\n- [ ] the complete exact-head loop is retained',
      authorLogin: 'maintainer',
      authorId: 'U_maintainer',
      updatedAt: '2026-07-28T10:00:00.000Z',
      state: 'OPEN' as const,
      isPullRequest: false,
      labels: ['engine:marketplace'],
    },
  };
  let issueComment:
    | { readonly id: number; readonly authorLogin: string; readonly body: string }
    | undefined;
  let assuranceComment:
    | { readonly id: number; readonly authorLogin: string; readonly body: string }
    | undefined;
  let pullRequest: RelayPullRequest | undefined;
  let forkHead: string | undefined;
  let clock = '2026-07-28T10:02:00.000Z';
  let crashPending = options.crashAfterFirstForkPush === true;
  const branchNames = new Set<string>();
  const fundedTaskCounts = new Map<number, number>();
  const submissions = new Map<number, {
    readonly id: string;
    readonly taskId: string;
    readonly taskCid: string;
    readonly creationTx: string;
    readonly creationBlock: number;
    readonly solverNetManifestCid: string;
  }>();
  const adoptionReceipts = new Map<number, AcceptedRelayAdoption['receipt']>();
  let issueCommentCreations = 0;
  let assuranceCommentCreations = 0;
  let pullRequestCreations = 0;

  const githubRead = {
    searchOptedInIssues: vi.fn(async () => ({ issues: [issue] })),
    readIssue: vi.fn(async () => issue),
    listLabelEvents: vi.fn(async () => [{
      action: 'labeled' as const,
      label: 'engine:marketplace',
      actorLogin: 'maintainer',
      actorId: 'U_maintainer',
      createdAt: '2026-07-28T10:01:00.000Z',
    }]),
    readRepositoryPermission: vi.fn(async () => 'MAINTAIN' as const),
    readDefaultBranchHead: vi.fn(async () => BASE),
  };

  const githubAuthority = {
    listIssueNumbersForMarkerRecovery: vi.fn(async () => [ISSUE_NUMBER]),
    listIssueComments: vi.fn(async () =>
      issueComment === undefined ? [] : [issueComment]),
    createIssueCommentExact: vi.fn(async (
      input: { readonly issueNumber: number; readonly body: string },
    ) => {
      expect(input.issueNumber).toBe(ISSUE_NUMBER);
      expect(issueComment).toBeUndefined();
      issueCommentCreations += 1;
      issueComment = {
        id: 71,
        authorLogin: SERVICE_LOGIN,
        body: input.body,
      };
      return issueComment;
    }),
    editIssueCommentExact: vi.fn(async (input: {
      readonly issueNumber: number;
      readonly commentId: number;
      readonly expectedBody: string;
      readonly body: string;
    }) => {
      expect(input).toMatchObject({
        issueNumber: ISSUE_NUMBER,
        commentId: issueComment?.id,
        expectedBody: issueComment?.body,
      });
      issueComment = {
        id: input.commentId,
        authorLogin: SERVICE_LOGIN,
        body: input.body,
      };
      return issueComment;
    }),
    readPullRequest: vi.fn(async (prNumber: number) => {
      expect(prNumber).toBe(42);
      if (pullRequest === undefined) {
        throw new Error('Draft pull request has not been created');
      }
      return pullRequest;
    }),
    readChecks: vi.fn(async (input: {
      readonly head: string;
      readonly base: string;
    }) => {
      expect(input).toEqual({ head: pullRequest?.head, base: 'main' });
      return {
        branchRequiredChecks: [{ name: 'test', appId: 7 }],
        checks: [{
          kind: 'check-run' as const,
          name: 'test',
          appId: 7,
          head: input.head,
          status: 'completed' as const,
          conclusion: 'success' as const,
          url: `https://github.com/Jinn-Network/mono/actions/runs/${input.head}`,
        }],
      };
    }),
    listAssuranceComments: vi.fn(async (prNumber: number) => {
      expect(prNumber).toBe(42);
      return assuranceComment === undefined ? [] : [assuranceComment];
    }),
    editAssuranceCommentExact: vi.fn(async (input: {
      readonly prNumber: number;
      readonly commentId: number;
      readonly expectedHead: string;
      readonly expectedBody: string;
      readonly body: string;
    }) => {
      expect(input).toMatchObject({
        prNumber: 42,
        commentId: assuranceComment?.id,
        expectedHead: pullRequest?.head,
        expectedBody: assuranceComment?.body,
      });
      assuranceComment = {
        id: input.commentId,
        authorLogin: SERVICE_LOGIN,
        body: input.body,
      };
      return assuranceComment;
    }),
  };

  const githubWrite = {
    markPullRequestReady: vi.fn(async (input: {
      readonly prNumber: number;
      readonly expectedHead: string;
    }) => {
      expect(input).toEqual({
        prNumber: pullRequest?.number,
        expectedHead: pullRequest?.head,
      });
      pullRequest = { ...pullRequest!, draft: false };
    }),
    closePullRequest: vi.fn(async (input: {
      readonly prNumber: number;
      readonly expectedHead: string;
    }) => {
      expect(input).toMatchObject({
        prNumber: pullRequest?.number,
        expectedHead: pullRequest?.head,
      });
      pullRequest = { ...pullRequest!, open: false };
    }),
  };

  const marketplace = {
    dryRun: vi.fn(async () => ({
      id: 'dry-run',
      creatorSafe: CREATOR_SAFE,
      solverNetManifestCid: 'bafy-solvernet',
      proposedSpendWei: 1n,
    })),
    submit: vi.fn(async (requestPath: string) => {
      const request = JSON.parse(
        await readFile(requestPath, 'utf8'),
      ) as { readonly specBytes: string };
      const spec = JSON.parse(request.specBytes) as {
        readonly instance_id: string;
        readonly relay: IssueRelayRoundV1;
      };
      const round = spec.relay.round;
      const prior = submissions.get(round);
      if (prior !== undefined) {
        return { ...prior, idempotent: true };
      }
      fundedTaskCounts.set(round, (fundedTaskCounts.get(round) ?? 0) + 1);
      const submission = {
        id: spec.instance_id,
        taskId: String(round + 1),
        taskCid: cid(String(round + 1)),
        creationTx: tx(String(round + 1)),
        creationBlock: round + 1,
        solverNetManifestCid: 'bafy-solvernet',
      };
      submissions.set(round, submission);
      return { ...submission, idempotent: false };
    }),
    observe: vi.fn(async (expectationPath: string) => {
      const expectation = JSON.parse(
        await readFile(expectationPath, 'utf8'),
      ) as IssueRelayDeliveryExpectation;
      const round = expectation.round.round;
      const requestId = tx(String(round + 4));
      const envelopeCid = cid(String(round + 4));
      const common = {
        status: 'verified' as const,
        task: {
          taskId: expectation.taskId,
          taskCid: expectation.taskCid,
        },
        attempt: {
          attemptIndex: expectation.attemptIndex ?? 0,
          requestId: expectation.requestId ?? requestId,
          operator: expectation.role === 'solution'
            ? contracts.adoption.solutionSafe
            : EVALUATOR_SAFE,
        },
        delivery: {
          envelopeCid: expectation.deliveryEnvelopeCid ?? envelopeCid,
          transactionHash: tx(String(round + 6)),
          blockNumber: round + 10,
        },
        round: expectation.round,
      };
      if (expectation.role === 'solution') {
        return {
          ...common,
          role: 'solution' as const,
          payload: {
            schemaVersion: 'jinn-repo-solution.v1' as const,
            patch:
              'diff --git a/relay.txt b/relay.txt\n'
              + 'new file mode 100644\n'
              + 'index 0000000..257cc56\n'
              + '--- /dev/null\n'
              + '+++ b/relay.txt\n'
              + '@@ -0,0 +1 @@\n'
              + `+round ${round}\n`,
          },
        };
      }
      const outcome = options.verdicts[round]!;
      return {
        ...common,
        role: 'verdict' as const,
        payload: {
          schemaVersion: 'jinn-issue-relay-verdict.v1' as const,
          outcome,
          correlation: {
            generation: expectation.round.generation,
            round,
            snapshotDigest: expectation.round.snapshotDigest,
            taskId: expectation.taskId,
            attemptIndex: expectation.attemptIndex!,
            requestId: expectation.requestId!,
            deliveryEnvelopeCid: expectation.deliveryEnvelopeCid!,
          },
          evaluatedHead: pullRequest!.head,
          summary: outcome === 'pass'
            ? 'The full cumulative head passes.'
            : 'The cumulative head needs the canonical repair.',
          findings: outcome === 'pass' ? [] : contracts.round.findings,
        },
      };
    }),
  };

  const adopter = {
    adopt: vi.fn(async (input: {
      readonly authority: {
        readonly generation: string;
        readonly round: number;
        readonly workspaceRepository: string;
        readonly inputHead: string;
        readonly branch: string;
        readonly existingPrNumber?: number;
      };
      readonly observation: {
        readonly task: { readonly taskId: string };
        readonly attempt: {
          readonly attemptIndex: number;
          readonly requestId: string;
          readonly operator: string;
        };
        readonly delivery: { readonly envelopeCid: string };
        readonly round: IssueRelayRoundV1;
      };
      readonly snapshot: {
        readonly snapshotDigest: `sha256:${string}`;
        readonly issue: { readonly number: number };
      };
    }): Promise<AcceptedRelayAdoption> => {
      const round = input.authority.round;
      const resultingHead = HEADS[round]!;
      branchNames.add(input.authority.branch);
      forkHead = resultingHead;
      if (round === 0 && crashPending) {
        crashPending = false;
        throw new Error('injected crash after fork push before PR readback');
      }
      if (pullRequest === undefined) {
        pullRequestCreations += 1;
        pullRequest = {
          number: 42,
          generation: input.authority.generation,
          targetRepositoryId: TARGET_REPOSITORY_ID,
          forkRepositoryId: FORK_REPOSITORY_ID,
          forkParentRepositoryId: TARGET_REPOSITORY_ID,
          branch: relayBranch(input.authority.generation),
          head: resultingHead,
          base: 'main',
          open: true,
          draft: true,
        };
      } else {
        expect(input.authority.existingPrNumber).toBe(pullRequest.number);
        expect(input.authority.workspaceRepository).toBe('jinn-relay/mono');
        expect(input.authority.inputHead).toBe(pullRequest.head);
        pullRequest = { ...pullRequest, head: resultingHead };
      }
      const receipt = IssueRelayAdoptionReceiptV1Schema.parse({
        schemaVersion: 'jinn-issue-relay-adoption.v1',
        disposition: 'accepted',
        correlation: {
          generation: input.authority.generation,
          round,
          snapshotDigest: input.snapshot.snapshotDigest,
          taskId: input.observation.task.taskId,
          attemptIndex: input.observation.attempt.attemptIndex,
          requestId: input.observation.attempt.requestId,
          deliveryEnvelopeCid: input.observation.delivery.envelopeCid,
        },
        targetRepository: 'Jinn-Network/mono',
        workspaceRepository: input.authority.workspaceRepository,
        issueNumber: input.snapshot.issue.number,
        prNumber: pullRequest.number,
        headRef: input.authority.branch,
        inputHead: input.authority.inputHead,
        resultingHead,
        patchDigest: `sha256:${String(round + 8).repeat(64)}`,
        solutionSafe: input.observation.attempt.operator,
        adoptedAt: '2026-07-28T10:02:00.000Z',
      }) as IssueRelayAdoptionReceiptV1;
      if (receipt.disposition !== 'accepted') {
        throw new Error('Vertical fixture produced a rejected receipt');
      }
      adoptionReceipts.set(round, receipt);
      const receiptBlock = formatRelayAdoptionReceiptBlock(receipt);
      if (assuranceComment === undefined) {
        assuranceCommentCreations += 1;
        assuranceComment = {
          id: 81,
          authorLogin: SERVICE_LOGIN,
          body: `${ASSURANCE_MARKER}\n\nIN PROGRESS\n\n${receiptBlock}`,
        };
      } else if (!assuranceComment.body.includes(receiptBlock)) {
        assuranceComment = {
          ...assuranceComment,
          body: `${assuranceComment.body.trimEnd()}\n\n${receiptBlock}`,
        };
      }
      return {
        status: 'accepted',
        receipt,
        branch: input.authority.branch,
        resultingHead,
        prNumber: pullRequest.number,
      };
    }),
  };

  const now = () => new Date(clock);
  const reconciliation = createIssueRelayProductionReconciliation({
    config,
    stateDirectory,
    githubRead,
    githubWrite: githubWrite as never,
    githubAuthority: githubAuthority as never,
    marketplace: marketplace as never,
    adopter: adopter as never,
    artifacts,
    now,
  });
  const runtime: IssueRelayRuntimePorts = {
    mode: 'active',
    config,
    githubRead,
    githubWrite: githubWrite as never,
    marketplace: marketplace as never,
    adopter: adopter as never,
    artifacts,
    reconciliation,
    now,
  };

  return {
    async runUntilTerminal(): Promise<readonly RelayCycleReport[]> {
      const reports: RelayCycleReport[] = [];
      for (let pass = 0; pass < 40; pass += 1) {
        reports.push(await runIssueRelayCycle(runtime));
        const record = issueComment === undefined
          ? null
          : parseRelayIssueCommentMarker(
            issueComment.body,
            issueComment.authorLogin,
            SERVICE_LOGIN,
          );
        if (
          options.cancelAfterInitialAdoption === true
          && record?.phase === 'draft-open'
          && issue.issue.labels.length > 0
        ) {
          issue.issue.labels.splice(0);
          clock = '2026-07-28T10:04:00.000Z';
        }
        if (
          record !== null
          && ['ready', 'closed', 'exhausted'].includes(record.phase)
        ) {
          return reports;
        }
      }
      throw new Error(
        `Vertical fixture did not reach a terminal state: ${JSON.stringify(
          reports.flatMap(({ actions }) => actions),
        )}`,
      );
    },
    record: () => issueComment === undefined
      ? null
      : parseRelayIssueCommentMarker(
        issueComment.body,
        issueComment.authorLogin,
        SERVICE_LOGIN,
      ),
    assuranceBody: () => assuranceComment?.body,
    pullRequest: () => pullRequest,
    forkHead: () => forkHead,
    branchNames,
    fundedTaskCounts,
    adoptionReceipts,
    counts: () => ({
      issueCommentCreations,
      assuranceCommentCreations,
      pullRequestCreations,
    }),
  };
}

describe('Jinn mono Issue Relay vertical', () => {
  it('recovers a post-push crash and retains both funded rounds in one ready PR', async () => {
    const fixture = await createVerticalFixture({
      verdicts: ['request-changes', 'pass'],
      crashAfterFirstForkPush: true,
    });

    const reports = await fixture.runUntilTerminal();

    expect(reports.flatMap(({ actions }) => actions)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'adopt-solution',
          outcome: 'failed',
        }),
        expect.objectContaining({
          action: 'mark-ready',
          outcome: 'completed',
        }),
      ]),
    );
    expect(fixture.record()).toMatchObject({
      phase: 'ready',
      pr: { number: 42, head: HEADS[1], draft: false },
      rounds: [
        {
          round: 0,
          purpose: 'initial',
          workspaceRepository: 'Jinn-Network/mono',
          inputHead: BASE,
          verdict: { outcome: 'request-changes', evaluatedHead: HEADS[0] },
        },
        {
          round: 1,
          purpose: 'repair',
          workspaceRepository: 'jinn-relay/mono',
          inputHead: HEADS[0],
          prNumber: 42,
          verdict: { outcome: 'pass', evaluatedHead: HEADS[1] },
        },
      ],
    });
    expect(fixture.fundedTaskCounts).toEqual(new Map([[0, 1], [1, 1]]));
    expect(fixture.branchNames).toEqual(new Set([
      fixture.pullRequest()!.branch,
    ]));
    expect(fixture.forkHead()).toBe(HEADS[1]);
    expect(fixture.counts()).toEqual({
      issueCommentCreations: 1,
      assuranceCommentCreations: 1,
      pullRequestCreations: 1,
    });
    expect(fixture.adoptionReceipts.size).toBe(2);
    expect(fixture.assuranceBody()?.match(new RegExp(ADOPTION_MARKER, 'g')))
      .toHaveLength(2);
    expect(fixture.assuranceBody()?.match(new RegExp(ANCHOR_MARKER, 'g')))
      .toHaveLength(2);
    expect(fixture.assuranceBody()).toContain('READY FOR HUMAN REVIEW');
    expect(fixture.assuranceBody()).toContain('ready for human review');
    expect(fixture.assuranceBody()).toContain('Round 0');
    expect(fixture.assuranceBody()).toContain('Round 1');
  });

  it('settles the funded round fairly after cancellation and closes the draft', async () => {
    const fixture = await createVerticalFixture({
      verdicts: ['pass'],
      cancelAfterInitialAdoption: true,
    });

    const reports = await fixture.runUntilTerminal();
    const actions = reports.flatMap(({ actions: passActions }) => passActions);

    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'record-cancellation',
        outcome: 'completed',
      }),
      expect.objectContaining({
        action: 'finish-cancellation',
        outcome: 'completed',
      }),
    ]));
    expect(actions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'mark-ready' }),
    ]));
    expect(fixture.record()).toMatchObject({
      phase: 'closed',
      cancellation: {
        reason: 'label-removed',
      },
      rounds: [{
        round: 0,
        task: { taskId: '1' },
        adoption: { disposition: 'accepted' },
      }],
    });
    expect(fixture.fundedTaskCounts).toEqual(new Map([[0, 1]]));
    expect(fixture.pullRequest()).toMatchObject({
      number: 42,
      open: false,
      draft: true,
    });
    expect(fixture.counts()).toEqual({
      issueCommentCreations: 1,
      assuranceCommentCreations: 1,
      pullRequestCreations: 1,
    });
  });

  it('stops funding after repeated actionable failures and reports EXHAUSTED', async () => {
    const fixture = await createVerticalFixture({
      verdicts: ['request-changes', 'request-changes'],
    });

    const reports = await fixture.runUntilTerminal();
    const actions = reports.flatMap(({ actions: passActions }) => passActions);

    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'close-exhausted',
        outcome: 'completed',
      }),
    ]));
    expect(actions.filter(({ action }) =>
      action === 'prepare-round' || action === 'submit-round')).toHaveLength(4);
    expect(fixture.record()).toMatchObject({
      phase: 'exhausted',
      rounds: [
        { round: 0, verdict: { outcome: 'request-changes' } },
        { round: 1, verdict: { outcome: 'request-changes' } },
      ],
    });
    expect(fixture.fundedTaskCounts).toEqual(new Map([[0, 1], [1, 1]]));
    expect(fixture.pullRequest()).toMatchObject({
      number: 42,
      open: false,
      draft: true,
    });
    expect(fixture.assuranceBody()).toContain('# EXHAUSTED');
    expect(fixture.assuranceBody()?.match(new RegExp(ADOPTION_MARKER, 'g')))
      .toHaveLength(2);
  });
});
