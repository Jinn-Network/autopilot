import { describe, expect, it } from 'vitest';
import { relayBranch } from '../../src/issue-relay/identity.js';
import {
  RelayGitPublisherError,
  createRelayGitPublisher,
  formatRelayAdoptionReceiptBlock,
  formatRelayPullRequestMarker,
  parseRelayAdoptionReceiptBlock,
  parseRelayPullRequestMarker,
  type RelayGitCommand,
  type RelayGitHubCommand,
  type RelayPullRequest,
} from '../../src/issue-relay/git-publisher.js';
import type { IssueRelayAdoptionReceiptV1 } from '../../src/issue-relay/contracts.js';

const GENERATION =
  `R_kgDOExample:42:sha256:${'a'.repeat(64)}`;
const BRANCH = relayBranch(GENERATION);
const INPUT = '1'.repeat(40);
const TREE = '2'.repeat(40);
const RESULT = '3'.repeat(40);
const PATCH_DIGEST = `sha256:${'4'.repeat(64)}` as const;
const REPOSITORY_AUTHORITY = {
  targetRepositoryId: 'R_target',
  forkRepositoryId: 'R_fork',
  forkParentRepositoryId: 'R_target',
} as const;

function acceptedReceipt(): Extract<
IssueRelayAdoptionReceiptV1,
{ readonly disposition: 'accepted' }
> {
  return {
    schemaVersion: 'jinn-issue-relay-adoption.v1',
    disposition: 'accepted',
    correlation: {
      generation: GENERATION,
      round: 0,
      snapshotDigest: `sha256:${'a'.repeat(64)}`,
      taskId: '77',
      attemptIndex: 0,
      requestId: `0x${'5'.repeat(64)}`,
      deliveryEnvelopeCid: `f01551220${'6'.repeat(64)}`,
    },
    targetRepository: 'Jinn-Network/mono',
    workspaceRepository: 'Jinn-Network/mono',
    issueNumber: 42,
    prNumber: 68,
    headRef: BRANCH,
    inputHead: INPUT,
    resultingHead: RESULT,
    patchDigest: PATCH_DIGEST,
    solutionSafe: `0x${'7'.repeat(40)}`,
    adoptedAt: '2026-07-28T11:00:00.000Z',
  };
}

function pullRequest(
  overrides: Partial<RelayPullRequest> = {},
): RelayPullRequest {
  return {
    number: 68,
    branch: BRANCH,
    head: RESULT,
    base: 'main',
    open: true,
    draft: true,
    generation: GENERATION,
    ...REPOSITORY_AUTHORITY,
    ...overrides,
  };
}

function publisherFixture(input: {
  readonly forkHead?: string;
  readonly pullRequests?: readonly RelayPullRequest[];
  readonly createPrThrows?: boolean;
  readonly assuranceBody?: string;
  readonly pullRequestReadbacks?: readonly RelayPullRequest[];
} = {}) {
  let localHead = INPUT;
  let forkHead = input.forkHead;
  let prs = [...(input.pullRequests ?? [])];
  let assuranceBody = input.assuranceBody;
  let assuranceCommentId: number | undefined =
    assuranceBody === undefined ? undefined : 900;
  let prOpen = prs[0]?.open ?? true;
  let pullRequestReads = 0;
  const gitCommands: RelayGitCommand[] = [];
  const githubCommands: RelayGitHubCommand[] = [];
  const gitMutations: RelayGitCommand[] = [];
  const githubMutations: RelayGitHubCommand[] = [];
  const commitMessage: { value?: string } = {};

  const publisher = createRelayGitPublisher({
    git: async (command) => {
      gitCommands.push(command);
      switch (command.kind) {
        case 'read-applied-tree':
          return { kind: 'applied-tree', head: localHead, tree: TREE, exact: true };
        case 'read-local-head':
          return { kind: 'local-head', head: localHead };
        case 'create-commit':
          gitMutations.push(command);
          commitMessage.value = command.message;
          localHead = RESULT;
          return { kind: 'mutated' };
        case 'read-commit':
        case 'read-fork-commit':
          return {
            kind: 'commit',
            head: command.head,
            tree: TREE,
            parents: [INPUT],
            message: commitMessage.value ?? command.expectedMessage,
          };
        case 'read-fork-ref':
          return { kind: 'fork-ref', head: forkHead };
        case 'push-fork':
          gitMutations.push(command);
          forkHead = RESULT;
          return { kind: 'mutated' };
        default: {
          const exhaustive: never = command;
          throw new Error(`Unhandled Git command: ${JSON.stringify(exhaustive)}`);
        }
      }
    },
    github: async (command) => {
      githubCommands.push(command);
      switch (command.kind) {
        case 'list-pull-requests':
          return { kind: 'pull-requests', pullRequests: prs };
        case 'create-draft-pull-request':
          githubMutations.push(command);
          prs = [pullRequest()];
          if (input.createPrThrows === true) throw new Error('ambiguous create');
          return { kind: 'mutated' };
        case 'read-pull-request': {
          const pr = prs.find(({ number }) => number === command.prNumber);
          if (pr === undefined) throw new Error('missing PR');
          const override = input.pullRequestReadbacks?.[pullRequestReads];
          pullRequestReads += 1;
          return {
            kind: 'pull-request',
            pullRequest: { ...pr, open: prOpen, ...override },
          };
        }
        case 'close-pull-request':
          githubMutations.push(command);
          prOpen = false;
          prs = prs.map((pr) => pr.number === command.prNumber
            ? { ...pr, open: false }
            : pr);
          return { kind: 'mutated' };
        case 'list-assurance-comments':
          return {
            kind: 'assurance-comments',
            comments: assuranceBody === undefined || assuranceCommentId === undefined
              ? []
              : [{
                id: assuranceCommentId,
                authorLogin: 'jinn-relay[bot]',
                body: assuranceBody,
              }],
          };
        case 'create-assurance-comment':
          githubMutations.push(command);
          assuranceCommentId = 900;
          assuranceBody = command.body;
          return { kind: 'mutated' };
        case 'edit-assurance-comment':
          githubMutations.push(command);
          assuranceBody = command.body;
          return { kind: 'mutated' };
        default: {
          const exhaustive: never = command;
          throw new Error(`Unhandled GitHub command: ${JSON.stringify(exhaustive)}`);
        }
      }
    },
  });

  return {
    publisher,
    gitCommands,
    githubCommands,
    gitMutations,
    githubMutations,
    commitMessage,
    currentForkHead: () => forkHead,
    resetLocalHead: () => {
      localHead = INPUT;
    },
    pullRequests: () => prs,
    assuranceBody: () => assuranceBody,
  };
}

const commitInput = {
  generation: GENERATION,
  round: 0,
  branch: BRANCH,
  targetRepository: 'Jinn-Network/mono' as const,
  ...REPOSITORY_AUTHORITY,
  forkRepository: 'Jinn-Network/mono-relay',
  worktreePath: '/relay/worktree',
  inputHead: INPUT,
  expectedTree: TREE,
  expectedForkHead: undefined,
  summary: 'Apply Relay solution',
  taskId: '77',
  deliveryEnvelopeCid: `f01551220${'6'.repeat(64)}`,
  patchDigest: PATCH_DIGEST,
};

describe('managed-fork Relay Git publisher', () => {
  it('round-trips only one exact hidden generation marker', () => {
    const marker = formatRelayPullRequestMarker(GENERATION);

    expect(parseRelayPullRequestMarker(marker)).toBe(GENERATION);
    expect(parseRelayPullRequestMarker(`${marker}\n${marker}`)).toBeNull();
    expect(parseRelayPullRequestMarker(
      marker.replace('"generation"', '"other"'),
    )).toBeNull();
  });

  it('rejects a nondeterministic branch before any mutation', async () => {
    const fixture = publisherFixture();

    await expect(fixture.publisher.commitAndPush({
      ...commitInput,
      branch: 'jinn/issue-relay/not-the-generation',
    })).rejects.toMatchObject({
      name: 'RelayGitPublisherError',
      reason: 'branch-contradiction',
    });
    expect(fixture.gitMutations).toEqual([]);
  });

  it('refuses a case-insensitive upstream repository alias before mutation', async () => {
    const fixture = publisherFixture();

    await expect(fixture.publisher.commitAndPush({
      ...commitInput,
      forkRepository: 'jinn-network/MONO',
    })).rejects.toMatchObject({
      name: 'RelayGitPublisherError',
      reason: 'branch-contradiction',
    });
    expect(fixture.gitMutations).toEqual([]);
  });

  it.each([
    ['the same immutable repository', {
      forkRepositoryId: 'R_target',
      forkParentRepositoryId: 'R_target',
    }],
    ['a repository without the target parent', {
      forkRepositoryId: 'R_other',
      forkParentRepositoryId: 'R_unrelated',
    }],
  ])('refuses %s as the managed fork before mutation', async (_label, ids) => {
    const fixture = publisherFixture();

    await expect(fixture.publisher.commitAndPush({
      ...commitInput,
      ...ids,
    })).rejects.toMatchObject({
      name: 'RelayGitPublisherError',
      reason: 'branch-contradiction',
    });
    expect(fixture.gitMutations).toEqual([]);
  });

  it('recovers an exact host commit and fork ref without mutation', async () => {
    const fixture = publisherFixture();
    await fixture.publisher.commitAndPush(commitInput);
    fixture.gitMutations.length = 0;
    fixture.resetLocalHead();

    await expect(fixture.publisher.recoverPublished({
      generation: GENERATION,
      round: 0,
      branch: BRANCH,
      targetRepository: 'Jinn-Network/mono',
      targetRepositoryId: 'R_target',
      forkRepository: 'Jinn-Network/mono-relay',
      forkRepositoryId: 'R_fork',
      forkParentRepositoryId: 'R_target',
      worktreePath: '/relay/worktree',
      inputHead: INPUT,
      summary: 'Apply Relay solution',
      taskId: '77',
      deliveryEnvelopeCid: `f01551220${'6'.repeat(64)}`,
      patchDigest: PATCH_DIGEST,
    })).resolves.toEqual({
      branch: BRANCH,
      resultingHead: RESULT,
      tree: TREE,
    });
    expect(fixture.gitMutations).toEqual([]);
  });

  it('creates the exact Relay commit and expected-old pushes only to the fork', async () => {
    const fixture = publisherFixture();

    const result = await fixture.publisher.commitAndPush(commitInput);

    expect(result).toEqual({ branch: BRANCH, resultingHead: RESULT });
    expect(fixture.currentForkHead()).toBe(RESULT);
    expect(fixture.gitMutations.map(({ kind }) => kind)).toEqual([
      'create-commit',
      'push-fork',
    ]);
    expect(fixture.gitMutations.at(-1)).toMatchObject({
      kind: 'push-fork',
      repository: 'Jinn-Network/mono-relay',
      branch: BRANCH,
      expectedOldHead: undefined,
      newHead: RESULT,
    });
    expect(fixture.gitMutations.some((command) =>
      command.kind === 'push-fork'
      && command.repository === 'Jinn-Network/mono')).toBe(false);
    expect(fixture.commitMessage.value).toBe([
      'Apply Relay solution',
      '',
      `Jinn-Relay-Generation: ${GENERATION}`,
      'Jinn-Relay-Round: 0',
      'Jinn-Relay-Task: 77',
      `Jinn-Relay-Envelope: f01551220${'6'.repeat(64)}`,
      `Jinn-Relay-Patch: ${PATCH_DIGEST}`,
    ].join('\n'));
  });

  it('carries immutable repository authority through every fork and GitHub command', async () => {
    const fixture = publisherFixture();
    await fixture.publisher.commitAndPush(commitInput);
    const pr = await fixture.publisher.ensureDraftPullRequest({
      generation: GENERATION,
      targetRepository: 'Jinn-Network/mono',
      targetRepositoryId: 'R_target',
      forkRepository: 'Jinn-Network/mono-relay',
      forkRepositoryId: 'R_fork',
      forkParentRepositoryId: 'R_target',
      branch: BRANCH,
      resultingHead: RESULT,
      defaultBranch: 'main',
      issueNumber: 42,
    });
    await fixture.publisher.publishAdoptionReceipt({
      targetRepository: 'Jinn-Network/mono',
      targetRepositoryId: 'R_target',
      forkRepositoryId: 'R_fork',
      forkParentRepositoryId: 'R_target',
      pr,
      serviceLogin: 'jinn-relay[bot]',
      receipt: acceptedReceipt(),
    });

    for (const command of fixture.gitCommands.filter(({ kind }) =>
      kind === 'read-fork-ref'
      || kind === 'read-fork-commit'
      || kind === 'push-fork')) {
      expect(command).toMatchObject({
        targetRepositoryId: 'R_target',
        forkRepositoryId: 'R_fork',
        forkParentRepositoryId: 'R_target',
      });
    }
    for (const command of fixture.githubCommands) {
      expect(command).toMatchObject({
        targetRepositoryId: 'R_target',
        forkRepositoryId: 'R_fork',
        forkParentRepositoryId: 'R_target',
      });
    }
  });

  it('refuses a stale fork head before commit or push', async () => {
    const fixture = publisherFixture({ forkHead: 'a'.repeat(40) });

    await expect(fixture.publisher.commitAndPush({
      ...commitInput,
      expectedForkHead: INPUT,
    })).rejects.toMatchObject({
      name: 'RelayGitPublisherError',
      reason: 'stale-fork',
    });
    expect(fixture.gitMutations).toEqual([]);
  });

  it('creates one draft PR on the exact default base and recovers ambiguous creation', async () => {
    const fixture = publisherFixture({ forkHead: RESULT, createPrThrows: true });

    const created = await fixture.publisher.ensureDraftPullRequest({
      ...REPOSITORY_AUTHORITY,
      generation: GENERATION,
      targetRepository: 'Jinn-Network/mono',
      forkRepository: 'Jinn-Network/mono-relay',
      branch: BRANCH,
      resultingHead: RESULT,
      defaultBranch: 'main',
      issueNumber: 42,
    });
    const replay = await fixture.publisher.ensureDraftPullRequest({
      ...REPOSITORY_AUTHORITY,
      generation: GENERATION,
      targetRepository: 'Jinn-Network/mono',
      forkRepository: 'Jinn-Network/mono-relay',
      branch: BRANCH,
      resultingHead: RESULT,
      defaultBranch: 'main',
      issueNumber: 42,
    });

    expect(created).toEqual(pullRequest());
    expect(replay).toEqual(created);
    expect(fixture.pullRequests()).toHaveLength(1);
    expect(fixture.githubMutations.filter(({ kind }) =>
      kind === 'create-draft-pull-request')).toHaveLength(1);
    expect(fixture.githubMutations[0]).toMatchObject({
      kind: 'create-draft-pull-request',
      draft: true,
      base: 'main',
      head: `Jinn-Network:${BRANCH}`,
      body: formatRelayPullRequestMarker(GENERATION),
    });
  });

  it('recovers an existing PR only from the exact marker and exact readback', async () => {
    const fixture = publisherFixture({
      forkHead: RESULT,
      pullRequests: [pullRequest()],
    });

    await expect(fixture.publisher.ensureDraftPullRequest({
      ...REPOSITORY_AUTHORITY,
      generation: GENERATION,
      targetRepository: 'Jinn-Network/mono',
      forkRepository: 'Jinn-Network/mono-relay',
      branch: BRANCH,
      resultingHead: RESULT,
      defaultBranch: 'main',
      issueNumber: 42,
      existingPrNumber: 68,
    })).resolves.toEqual(pullRequest());
    expect(fixture.githubMutations).toEqual([]);
  });

  it.each([
    ['wrong generation marker', pullRequest({ generation: 'other-generation' })],
    ['stale PR head', pullRequest({ head: INPUT })],
    ['wrong base', pullRequest({ base: 'next' })],
    ['not draft', pullRequest({ draft: false })],
  ])('fails closed on a %s', async (_label, contradictoryPr) => {
    const fixture = publisherFixture({
      forkHead: RESULT,
      pullRequests: [contradictoryPr],
    });

    await expect(fixture.publisher.ensureDraftPullRequest({
      ...REPOSITORY_AUTHORITY,
      generation: GENERATION,
      targetRepository: 'Jinn-Network/mono',
      forkRepository: 'Jinn-Network/mono-relay',
      branch: BRANCH,
      resultingHead: RESULT,
      defaultBranch: 'main',
      issueNumber: 42,
      existingPrNumber: 68,
    })).rejects.toBeInstanceOf(RelayGitPublisherError);
    expect(fixture.githubMutations).toEqual([]);
  });

  it('closes a cancelled adopted draft and reads back the closed state', async () => {
    const fixture = publisherFixture({
      forkHead: RESULT,
      pullRequests: [pullRequest()],
    });

    await fixture.publisher.closeDraftPullRequest({
      ...REPOSITORY_AUTHORITY,
      targetRepository: 'Jinn-Network/mono',
      pr: pullRequest(),
      expectedHead: RESULT,
      reason: 'Relay generation was cancelled',
    });

    expect(fixture.githubMutations).toContainEqual(expect.objectContaining({
      kind: 'close-pull-request',
      repository: 'Jinn-Network/mono',
      prNumber: 68,
      expectedGeneration: GENERATION,
      expectedBranch: BRANCH,
      expectedHead: RESULT,
      expectedBase: 'main',
      expectedDraft: true,
      expectedOpen: true,
      reason: 'Relay generation was cancelled',
    }));
  });

  it('recovers an already-closed cancelled draft without another mutation', async () => {
    const closed = pullRequest({ open: false });
    const fixture = publisherFixture({
      forkHead: RESULT,
      pullRequests: [closed],
    });

    await fixture.publisher.closeDraftPullRequest({
      ...REPOSITORY_AUTHORITY,
      targetRepository: 'Jinn-Network/mono',
      pr: closed,
      expectedHead: RESULT,
      reason: 'Relay generation was cancelled',
    });

    expect(fixture.githubMutations).toEqual([]);
  });

  it('appends one strict adoption receipt to one assurance comment and reads it back', async () => {
    const fixture = publisherFixture({
      forkHead: RESULT,
      pullRequests: [pullRequest()],
      assuranceBody: '<!-- jinn-issue-relay:assurance:v1 -->\n\nIN PROGRESS',
    });
    const receipt = acceptedReceipt();

    const published = await fixture.publisher.publishAdoptionReceipt({
      ...REPOSITORY_AUTHORITY,
      targetRepository: 'Jinn-Network/mono',
      pr: pullRequest(),
      serviceLogin: 'jinn-relay[bot]',
      receipt,
    });
    const replay = await fixture.publisher.publishAdoptionReceipt({
      ...REPOSITORY_AUTHORITY,
      targetRepository: 'Jinn-Network/mono',
      pr: pullRequest(),
      serviceLogin: 'jinn-relay[bot]',
      receipt,
    });

    expect(published).toEqual(receipt);
    expect(replay).toEqual(receipt);
    expect(parseRelayAdoptionReceiptBlock(fixture.assuranceBody()!)).toEqual(receipt);
    expect(fixture.assuranceBody()).toContain(formatRelayAdoptionReceiptBlock(receipt));
    expect(fixture.githubMutations.filter(({ kind }) =>
      kind === 'edit-assurance-comment')).toHaveLength(1);
  });

  it('rechecks the exact PR after recovering an existing receipt', async () => {
    const receipt = acceptedReceipt();
    const fixture = publisherFixture({
      forkHead: RESULT,
      pullRequests: [pullRequest()],
      assuranceBody: [
        '<!-- jinn-issue-relay:assurance:v1 -->',
        '',
        formatRelayAdoptionReceiptBlock(receipt),
      ].join('\n'),
      pullRequestReadbacks: [
        pullRequest(),
        pullRequest({ head: '9'.repeat(40) }),
      ],
    });

    await expect(fixture.publisher.publishAdoptionReceipt({
      ...REPOSITORY_AUTHORITY,
      targetRepository: 'Jinn-Network/mono',
      pr: pullRequest(),
      serviceLogin: 'jinn-relay[bot]',
      receipt,
    })).rejects.toMatchObject({
      name: 'RelayGitPublisherError',
      reason: 'receipt-contradiction',
    });
    expect(fixture.githubMutations).toEqual([]);
  });

  it('rejects a contradictory receipt in the Relay assurance comment', async () => {
    const contradictory = {
      ...acceptedReceipt(),
      resultingHead: '9'.repeat(40),
    };
    const fixture = publisherFixture({
      forkHead: RESULT,
      pullRequests: [pullRequest()],
      assuranceBody: [
        '<!-- jinn-issue-relay:assurance:v1 -->',
        '',
        formatRelayAdoptionReceiptBlock(contradictory),
      ].join('\n'),
    });

    await expect(fixture.publisher.publishAdoptionReceipt({
      ...REPOSITORY_AUTHORITY,
      targetRepository: 'Jinn-Network/mono',
      pr: pullRequest(),
      serviceLogin: 'jinn-relay[bot]',
      receipt: acceptedReceipt(),
    })).rejects.toMatchObject({
      name: 'RelayGitPublisherError',
      reason: 'receipt-contradiction',
    });
    expect(fixture.githubMutations).toEqual([]);
  });

  it('recovers an accepted receipt from an exact closed draft during cancellation', async () => {
    const receipt = acceptedReceipt();
    const fixture = publisherFixture({
      forkHead: RESULT,
      pullRequests: [pullRequest({ open: false })],
      assuranceBody: [
        '<!-- jinn-issue-relay:assurance:v1 -->',
        '',
        formatRelayAdoptionReceiptBlock(receipt),
      ].join('\n'),
    });

    await expect(fixture.publisher.recoverAccepted({
      ...REPOSITORY_AUTHORITY,
      generation: GENERATION,
      targetRepository: 'Jinn-Network/mono',
      forkRepository: 'Jinn-Network/mono-relay',
      branch: BRANCH,
      prNumber: 68,
      defaultBranch: 'main',
      serviceLogin: 'jinn-relay[bot]',
      correlation: receipt.correlation,
      allowClosed: true,
    })).resolves.toEqual(receipt);
  });
});
