import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeRelayAdoptionCoordinator,
  type AcceptedRelayAdoption,
} from '../../src/issue-relay/adoption.js';
import type { IssueRelayConfig } from '../../src/issue-relay/config.js';
import {
  IssueRelayAdoptionReceiptV1Schema,
  IssueRelayRoundV1Schema,
  type IssueRelayAdoptionReceiptV1,
  type IssueRelayRoundV1,
} from '../../src/issue-relay/contracts.js';
import {
  createRelayGitPublisher,
  parseRelayAdoptionReceiptBlocks,
  type RelayGitCommand,
  type RelayGitHubCommand,
  type RelayPullRequest,
} from '../../src/issue-relay/git-publisher.js';
import { relayBranch } from '../../src/issue-relay/identity.js';
import { validateMarketplacePatch } from '../../src/lifecycle/marketplace-patch.js';
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
  createRelayGitHubProductionPorts,
  type RelayGitHubApiRequest,
} from '../../src/issue-relay/github-production.js';
import {
  runIssueRelayCycle,
  type IssueRelayRuntimePorts,
  type RelayCycleReport,
} from '../../src/issue-relay/reconciler.js';

const directories: string[] = [];
const BASE = '1'.repeat(40);
const HEADS = ['2'.repeat(40), '3'.repeat(40)] as const;
const TREES = ['4'.repeat(40), '5'.repeat(40)] as const;
const TARGET_REPOSITORY_ID = 'R_target';
const FORK_REPOSITORY_ID = 'R_fork';
const ISSUE_NUMBER = 1889;
const SERVICE_LOGIN = 'jinn-relay';
const EVALUATOR_SAFE = `0x${'b'.repeat(40)}`;
const CREATOR_SAFE = `0x${'c'.repeat(40)}`;
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
  readonly crashAfterTerminalMutations?: boolean;
  readonly cancelAfterRepairFunding?: boolean;
  readonly crashAfterReadyMutation?:
    | 'deadline'
    | 'stale-base'
    | 'cancellation';
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
  let currentBase = BASE;
  let readyCrashIssueBody: string | undefined;
  let readyMutationCrashPending =
    options.crashAfterReadyMutation !== undefined;
  let crashPending = options.crashAfterFirstForkPush === true;
  let terminalAssuranceCrashPending =
    options.crashAfterTerminalMutations === true;
  let terminalCloseCrashPending =
    options.crashAfterTerminalMutations === true;
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
    readDefaultBranchHead: vi.fn(async () => currentBase),
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
      if (
        terminalAssuranceCrashPending
        && pullRequest?.open === true
        && (
          assuranceComment?.body.includes('# CANCELLED')
          || assuranceComment?.body.includes('# EXHAUSTED')
        )
      ) {
        terminalAssuranceCrashPending = false;
        throw new Error(
          'injected crash after terminal assurance edit before readback',
        );
      }
      return assuranceComment === undefined ? [] : [assuranceComment];
    }),
    editAssuranceCommentExact: vi.fn(async (input: {
      readonly prNumber: number;
      readonly commentId: number;
      readonly expectedHead: string;
      readonly expectedBody: string;
      readonly body: string;
    }) => {
      if (pullRequest?.open !== true) {
        throw new Error('Relay assurance edit lost exact open head authority');
      }
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

  const targetRepository = {
    full_name: 'Jinn-Network/mono',
    node_id: TARGET_REPOSITORY_ID,
    visibility: 'public',
    private: false,
    default_branch: 'main',
    owner: { login: 'Jinn-Network' },
    parent: null,
  };
  const forkRepository = {
    ...targetRepository,
    full_name: 'jinn-relay/mono',
    node_id: FORK_REPOSITORY_ID,
    owner: { login: SERVICE_LOGIN },
    parent: targetRepository,
  };
  const productionGitHub = createRelayGitHubProductionPorts({
    config,
    token: 'vertical-test-token',
    request: vi.fn(async (input: RelayGitHubApiRequest) => {
      if (input.path === '/repos/Jinn-Network/mono') {
        return { status: 200, headers: {}, body: targetRepository };
      }
      if (input.path === '/repos/jinn-relay/mono') {
        return { status: 200, headers: {}, body: forkRepository };
      }
      if (input.path === '/repos/Jinn-Network/mono/pulls/42') {
        if (pullRequest === undefined) {
          throw new Error('Production writer read a missing pull request');
        }
        if (input.method === 'PATCH') {
          expect(input.body).toEqual({ state: 'closed' });
          pullRequest = { ...pullRequest, open: false };
        }
        return {
          status: 200,
          headers: {},
          body: {
            number: pullRequest.number,
            node_id: 'PR_42',
            state: pullRequest.open ? 'open' : 'closed',
            draft: pullRequest.draft,
            user: { login: SERVICE_LOGIN },
            head: {
              ref: pullRequest.branch,
              sha: pullRequest.head,
              repo: {
                full_name: forkRepository.full_name,
                node_id: forkRepository.node_id,
              },
            },
            base: {
              ref: pullRequest.base,
              repo: {
                full_name: targetRepository.full_name,
                node_id: targetRepository.node_id,
              },
            },
            body: '<!-- jinn-issue-relay:pull-request:v1 -->',
          },
        };
      }
      if (input.path === '/graphql') {
        if (pullRequest === undefined || !pullRequest.draft) {
          throw new Error('Production writer cannot mark this pull request ready');
        }
        pullRequest = { ...pullRequest, draft: false };
        return {
          status: 200,
          headers: {},
          body: {
            data: {
              markPullRequestReadyForReview: {
                pullRequest: { id: 'PR_42', isDraft: false },
              },
            },
          },
        };
      }
      throw new Error(
        `Unexpected production writer request ${input.method} ${input.path}`,
      );
    }),
  });

  const githubWrite = {
    markPullRequestReady: vi.fn(async (input: {
      readonly prNumber: number;
      readonly expectedHead: string;
    }) => {
      await productionGitHub.write.markPullRequestReady(input);
      if (readyMutationCrashPending) {
        readyMutationCrashPending = false;
        readyCrashIssueBody = issueComment?.body;
        switch (options.crashAfterReadyMutation) {
          case 'deadline':
            clock = '2026-07-29T10:02:00.000Z';
            break;
          case 'stale-base':
            currentBase = '9'.repeat(40);
            break;
          case 'cancellation':
            issue.issue.labels.splice(0);
            clock = '2026-07-28T10:04:00.000Z';
            break;
          case undefined:
            break;
        }
        throw new Error(
          'injected crash after mark-ready mutation before durable marker',
        );
      }
    }),
    closePullRequest: vi.fn(async (input: Parameters<
      typeof productionGitHub.write.closePullRequest
    >[0]) => {
      await productionGitHub.write.closePullRequest(input);
      if (terminalCloseCrashPending) {
        terminalCloseCrashPending = false;
        throw new Error('injected crash after terminal close before readback');
      }
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

  const localHeads = new Map<string, string>();
  const appliedTrees = new Map<string, string>();
  const commits = new Map<string, {
    readonly tree: string;
    readonly parent: string;
    readonly message: string;
  }>();
  let pushMutations = 0;

  const captureReceipts = (body: string) => {
    for (const receipt of parseRelayAdoptionReceiptBlocks(body)) {
      if (receipt.disposition === 'accepted') {
        adoptionReceipts.set(receipt.correlation.round, receipt);
      }
    }
  };
  const roundForWorktree = (path: string): number => {
    const match = /worktree-(\d+)$/.exec(path);
    if (match?.[1] === undefined) {
      throw new Error(`Unexpected Relay worktree path ${path}`);
    }
    return Number(match[1]);
  };

  const publisher = createRelayGitPublisher({
    git: vi.fn(async (command: RelayGitCommand) => {
      switch (command.kind) {
        case 'read-applied-tree':
          return {
            kind: 'applied-tree' as const,
            head: localHeads.get(command.worktreePath) ?? command.inputHead,
            tree: appliedTrees.get(command.worktreePath)
              ?? TREES[roundForWorktree(command.worktreePath)]!,
            exact: true,
          };
        case 'read-local-head':
          return {
            kind: 'local-head' as const,
            head: localHeads.get(command.worktreePath) ?? BASE,
          };
        case 'create-commit': {
          const round = roundForWorktree(command.worktreePath);
          const head = HEADS[round]!;
          expect(command.expectedTree).toBe(TREES[round]);
          localHeads.set(command.worktreePath, head);
          commits.set(head, {
            tree: command.expectedTree,
            parent: command.expectedHead,
            message: command.message,
          });
          return { kind: 'mutated' as const };
        }
        case 'read-commit':
        case 'read-fork-commit': {
          const commit = commits.get(command.head);
          if (commit === undefined) {
            throw new Error(`Missing hermetic commit ${command.head}`);
          }
          return {
            kind: 'commit' as const,
            head: command.head,
            tree: commit.tree,
            parents: [commit.parent],
            message: commit.message,
          };
        }
        case 'read-fork-ref':
          return { kind: 'fork-ref' as const, head: forkHead };
        case 'push-fork':
          expect(forkHead).toBe(command.expectedOldHead);
          pushMutations += 1;
          branchNames.add(command.branch);
          forkHead = command.newHead;
          if (pullRequest !== undefined) {
            pullRequest = { ...pullRequest, head: command.newHead };
          }
          return { kind: 'mutated' as const };
        default: {
          const exhaustive: never = command;
          throw new Error(`Unhandled hermetic Git command ${JSON.stringify(exhaustive)}`);
        }
      }
    }),
    github: vi.fn(async (command: RelayGitHubCommand) => {
      switch (command.kind) {
        case 'list-pull-requests':
          if (
            crashPending
            && forkHead === HEADS[0]
            && pullRequest === undefined
          ) {
            crashPending = false;
            throw new Error('injected crash after fork push before PR readback');
          }
          return {
            kind: 'pull-requests' as const,
            pullRequests: pullRequest === undefined ? [] : [pullRequest],
          };
        case 'create-draft-pull-request': {
          if (forkHead === undefined) {
            throw new Error('Cannot create the draft before fork publication');
          }
          const record = issueComment === undefined
            ? null
            : parseRelayIssueCommentMarker(
              issueComment.body,
              issueComment.authorLogin,
              SERVICE_LOGIN,
            );
          if (record === null) {
            throw new Error('Draft creation lacks durable generation authority');
          }
          pullRequestCreations += 1;
          pullRequest = {
            number: 42,
            generation: record.generation,
            targetRepositoryId: TARGET_REPOSITORY_ID,
            forkRepositoryId: FORK_REPOSITORY_ID,
            forkParentRepositoryId: TARGET_REPOSITORY_ID,
            branch: relayBranch(record.generation),
            head: forkHead,
            base: 'main',
            open: true,
            draft: true,
          };
          return { kind: 'mutated' as const };
        }
        case 'read-pull-request':
          if (
            pullRequest === undefined
            || command.prNumber !== pullRequest.number
          ) {
            throw new Error('Hermetic pull request is missing');
          }
          return {
            kind: 'pull-request' as const,
            pullRequest,
          };
        case 'close-pull-request':
          if (
            pullRequest === undefined
            || pullRequest.head !== command.expectedHead
            || !pullRequest.open
          ) {
            throw new Error('Hermetic close lost exact open head authority');
          }
          pullRequest = { ...pullRequest, open: false };
          return { kind: 'mutated' as const };
        case 'list-assurance-comments':
          return {
            kind: 'assurance-comments' as const,
            comments: assuranceComment === undefined ? [] : [assuranceComment],
          };
        case 'create-assurance-comment':
          if (
            pullRequest?.open !== true
            || pullRequest.head !== command.expectedHead
            || assuranceComment !== undefined
          ) {
            throw new Error('Hermetic assurance create lost exact open head authority');
          }
          assuranceCommentCreations += 1;
          assuranceComment = {
            id: 81,
            authorLogin: SERVICE_LOGIN,
            body: command.body,
          };
          captureReceipts(command.body);
          return { kind: 'mutated' as const };
        case 'edit-assurance-comment':
          if (
            pullRequest?.open !== true
            || pullRequest.head !== command.expectedHead
            || assuranceComment?.id !== command.commentId
          ) {
            throw new Error('Hermetic assurance edit lost exact open head authority');
          }
          assuranceComment = { ...assuranceComment, body: command.body };
          captureReceipts(command.body);
          return { kind: 'mutated' as const };
        default: {
          const exhaustive: never = command;
          throw new Error(
            `Unhandled hermetic GitHub command ${JSON.stringify(exhaustive)}`,
          );
        }
      }
    }),
  });

  const adopter = makeRelayAdoptionCoordinator({
    authority: {
      readExact: vi.fn(async ({ authority, snapshot }) => {
        const worktreePath = join(root, `worktree-${authority.round}`);
        return {
          generation: authority.generation,
          round: authority.round,
          snapshotDigest: snapshot.snapshotDigest,
          targetRepository: authority.targetRepository,
          workspaceRepository: authority.workspaceRepository,
          inputHead: authority.inputHead,
          forkRepository: authority.forkRepository,
          branch: authority.branch,
          taskId: submissions.get(authority.round)!.taskId,
          solutionOperator: contracts.adoption.solutionSafe,
          issueNumber: ISSUE_NUMBER,
          defaultBranch: 'main',
          targetRepositoryId: TARGET_REPOSITORY_ID,
          forkRepositoryId: FORK_REPOSITORY_ID,
          forkParentRepositoryId: TARGET_REPOSITORY_ID,
          ...(forkHead === undefined ? {} : { expectedForkHead: forkHead }),
          cancellationRequested: authority.cancellationRequested,
          serviceLogin: SERVICE_LOGIN,
          adoptionDeadline: '2026-07-29T10:02:00.000Z',
          worktree: {
            manifestPath: join(root, `manifest-${authority.round}.json`),
            path: worktreePath,
          },
          ...(pullRequest === undefined ? {} : { pr: pullRequest }),
        };
      }),
    },
    worktrees: {
      prepareExact: vi.fn(async (input) => {
        localHeads.set(input.worktreePath, input.expectedHead);
        return {
          manifestPath: input.manifestPath,
          path: input.worktreePath,
          expectedHead: input.expectedHead,
        };
      }),
    },
    applyPatch: vi.fn(async (input) => {
      const patch = validateMarketplacePatch(input.artifact);
      appliedTrees.set(
        input.worktreePath,
        TREES[roundForWorktree(input.worktreePath)]!,
      );
      return patch;
    }),
    verification: {
      preflight: vi.fn(async () => ({ ok: true })),
      verify: vi.fn(async (input) => ({
        profile: input.profile,
        artifactDigest: input.artifactDigest,
        expectedTree: input.expectedTree,
        planDigest: `sha256:${'9'.repeat(64)}`,
        commands: [],
        verifiedAt: clock,
      })),
    },
    publisher,
    now: () => new Date(clock),
  });

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
        const latest = record?.rounds.at(-1);
        if (
          options.cancelAfterRepairFunding === true
          && latest?.round === 1
          && latest.task !== undefined
          && latest.solution === undefined
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
    issueBody: () => issueComment?.body,
    readyCrashIssueBody: () => readyCrashIssueBody,
    pullRequest: () => pullRequest,
    forkHead: () => forkHead,
    branchNames,
    fundedTaskCounts,
    adoptionReceipts,
    counts: () => ({
      issueCommentCreations,
      assuranceCommentCreations,
      pullRequestCreations,
      pushMutations,
    }),
  };
}

describe('Jinn mono Issue Relay vertical', () => {
  it.each([
    {
      trigger: 'deadline' as const,
      phase: 'ready' as const,
      terminalAction: 'mark-ready',
      assurance: 'READY FOR HUMAN REVIEW',
      open: true,
    },
    {
      trigger: 'stale-base' as const,
      phase: 'exhausted' as const,
      terminalAction: 'close-exhausted',
      assurance: '# EXHAUSTED',
      open: false,
    },
    {
      trigger: 'cancellation' as const,
      phase: 'closed' as const,
      terminalAction: 'finish-cancellation',
      assurance: '# CANCELLED',
      open: false,
    },
  ])(
    'converges a live non-draft crash replay under $trigger authority',
    async ({ trigger, phase, terminalAction, assurance, open }) => {
      const fixture = await createVerticalFixture({
        verdicts: ['pass'],
        crashAfterReadyMutation: trigger,
      });

      const reports = await fixture.runUntilTerminal();
      const actions = reports.flatMap(({ actions: passActions }) => passActions);

      expect(actions.filter(({ action, outcome }) =>
        action === 'mark-ready' && outcome === 'failed'
      )).toHaveLength(1);
      expect(
        actions.filter(({ outcome }) => outcome === 'failed'),
        JSON.stringify(actions),
      )
        .toHaveLength(1);
      expect(actions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          action: terminalAction,
          outcome: 'completed',
        }),
      ]));
      if (trigger !== 'deadline') {
        expect(actions).not.toEqual(expect.arrayContaining([
          expect.objectContaining({
            action: 'mark-ready',
            outcome: 'completed',
          }),
        ]));
      }
      if (trigger === 'cancellation') {
        expect(actions).toEqual(expect.arrayContaining([
          expect.objectContaining({
            action: 'record-cancellation',
            outcome: 'completed',
          }),
        ]));
      }
      expect(fixture.record()).toMatchObject({
        phase,
        pr: { number: 42, head: HEADS[0], draft: false },
      });
      expect(fixture.pullRequest()).toMatchObject({
        number: 42,
        head: HEADS[0],
        open,
        draft: false,
      });
      expect(fixture.assuranceBody()).toContain(assurance);
      expect(fixture.readyCrashIssueBody())
        .toContain('<!-- jinn-issue-relay:active:v1 -->');
      expect(fixture.issueBody())
        .not.toContain('<!-- jinn-issue-relay:active:v1 -->');
      if (trigger !== 'deadline') {
        expect(fixture.assuranceBody())
          .not.toContain('READY FOR HUMAN REVIEW');
      }
      expect(fixture.fundedTaskCounts).toEqual(new Map([[0, 1]]));
    },
  );

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
      pushMutations: 2,
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

  it('settles the already-funded repair after cancellation and closes the draft', async () => {
    const fixture = await createVerticalFixture({
      verdicts: ['request-changes', 'pass'],
      crashAfterTerminalMutations: true,
      cancelAfterRepairFunding: true,
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
    expect(actions.filter(({ action, outcome }) =>
      action === 'finish-cancellation' && outcome === 'failed'
    )).toHaveLength(2);
    expect(actions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'mark-ready' }),
    ]));
    expect(fixture.record()).toMatchObject({
      phase: 'closed',
      cancellation: {
        reason: 'label-removed',
      },
      rounds: [
        {
          round: 0,
          task: { taskId: '1' },
          adoption: { disposition: 'accepted' },
        },
        {
          round: 1,
          task: { taskId: '2' },
          solution: { envelopeCid: cid('5') },
          adoption: { disposition: 'rejected' },
        },
      ],
    });
    expect(fixture.fundedTaskCounts).toEqual(new Map([[0, 1], [1, 1]]));
    expect(fixture.pullRequest()).toMatchObject({
      number: 42,
      open: false,
      draft: true,
    });
    expect(fixture.counts()).toEqual({
      issueCommentCreations: 1,
      assuranceCommentCreations: 1,
      pullRequestCreations: 1,
      pushMutations: 1,
    });
    expect(fixture.assuranceBody()).toContain('# CANCELLED');
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
