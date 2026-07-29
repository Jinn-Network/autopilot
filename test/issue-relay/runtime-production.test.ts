import {
  chmod,
  lstat,
  mkdtemp,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createIssueRelayProductionReconciliation,
  createRelayDurableArtifactStore,
  preflightIssueRelayProduction,
  runIssueRelayRuntime,
} from '../../src/issue-relay/runtime-production.js';
import { runIssueRelayCycle } from '../../src/issue-relay/reconciler.js';
import { parseRelayIssueCommentMarker } from '../../src/issue-relay/report.js';
import {
  createRelayGitHubProductionPorts,
  type RelayGitHubApiRequest,
} from '../../src/issue-relay/github-production.js';
import type { IssueRelayConfig } from '../../src/issue-relay/config.js';

const directories: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

function config(): IssueRelayConfig {
  return {
    schemaVersion: 1,
    repository: 'Jinn-Network/mono',
    label: 'engine:marketplace',
    relayBotLogin: 'jinn-relay',
    managedForkRepository: 'jinn-relay/mono',
    targetBase: 'main',
    solverNet: 'jinn-repo',
    verificationProfile: 'jinn-mono.v1',
    requiredChecks: ['test'],
    pollSeconds: 30,
    budget: {
      maxGlobalActiveGenerations: 20,
      maxActivePerRepository: 10,
      maxActivePerAuthor: 2,
      maxRoundsPerGeneration: 5,
      maxGenerationSpendWei: 10n,
      maxGlobalSpendWeiPerUtcDay: 100n,
      generationDeadlineMs: 86_400_000,
    },
  };
}

describe('Relay durable artifact store', () => {
  it('creates owner-only directories and create-only immutable regular files', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'relay-state-'));
    directories.push(parent);
    const state = join(parent, 'state');
    const store = createRelayDurableArtifactStore(state);

    await expect(store.installImmutable({
      relativePath: 'generations/a/snapshot.json',
      bytes: Buffer.from('one'),
    })).resolves.toBe('created');
    await expect(store.installImmutable({
      relativePath: 'generations/a/snapshot.json',
      bytes: Buffer.from('one'),
    })).resolves.toBe('identical');
    await expect(store.installImmutable({
      relativePath: 'generations/a/snapshot.json',
      bytes: Buffer.from('two'),
    })).rejects.toThrow(/conflict/i);
    await expect(store.read('generations/a/snapshot.json'))
      .resolves.toEqual(Buffer.from('one'));

    expect((await lstat(state)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(state, 'generations'))).mode & 0o777).toBe(0o700);
    expect(
      (await lstat(join(state, 'generations/a/snapshot.json'))).mode & 0o777,
    ).toBe(0o600);
  });

  it('rejects traversal, symlinks, and a state directory not owned privately', async () => {
    const state = await mkdtemp(join(tmpdir(), 'relay-state-'));
    directories.push(state);
    await chmod(state, 0o755);
    expect(() => createRelayDurableArtifactStore(state)).toThrow(/0700|owner/i);

    await chmod(state, 0o700);
    const store = createRelayDurableArtifactStore(state);
    await expect(store.read('../secret')).rejects.toThrow(/relative|path/i);
    const outside = join(state, '..', 'outside-relay-file');
    await writeFile(outside, 'secret', { mode: 0o600 });
    directories.push(outside);
    await symlink(outside, join(state, 'link'));
    await expect(store.read('link')).rejects.toThrow(/regular|symbolic/i);
  });
});

describe('production Relay preflight', () => {
  it('validates GitHub identity/repository/fork, real dry-run economics, state, and verification before the loop', async () => {
    const state = await mkdtemp(join(tmpdir(), 'relay-state-'));
    directories.push(state);
    await chmod(state, 0o700);
    const calls: string[] = [];

    await expect(preflightIssueRelayProduction({
      config: config(),
      stateDirectory: state,
      github: async () => {
        calls.push('github');
        return {
          authenticatedLogin: 'jinn-relay',
          targetRepository: 'Jinn-Network/mono',
          targetRepositoryId: 'R_target',
          targetVisibility: 'PUBLIC',
          targetBase: 'main',
          label: 'engine:marketplace',
          forkRepository: 'jinn-relay/mono',
          forkRepositoryId: 'R_fork',
          forkOwner: 'jinn-relay',
          forkParentRepositoryId: 'R_target',
          forkVisibility: 'PUBLIC',
        };
      },
      resolveJinnBinary: async () => {
        calls.push('binary');
        return '/installed/jinn';
      },
      marketplaceDryRun: async ({ solverNet }) => {
        calls.push(`dry-run:${solverNet}`);
        return {
          creatorSafe: '0x1111111111111111111111111111111111111111',
          solverNet,
          escrowReady: true,
          proposedSpendWei: 1n,
        };
      },
      verificationRuntime: async (profile) => {
        calls.push(`verification:${profile}`);
        return true;
      },
    })).resolves.toMatchObject({
      jinnBinary: '/installed/jinn',
      creatorSafe: '0x1111111111111111111111111111111111111111',
    });
    expect(calls).toEqual([
      'github',
      'binary',
      'dry-run:jinn-repo',
      'verification:jinn-mono.v1',
    ]);
  });

  it.each([
    ['wrong bot', { authenticatedLogin: 'other' }],
    ['private target', { targetVisibility: 'PRIVATE' }],
    ['wrong fork parent', { forkParentRepositoryId: 'R_other' }],
    ['unfunded escrow', { escrowReady: false }],
  ])('fails closed for %s before runtime cycles', async (_label, override) => {
    const state = await mkdtemp(join(tmpdir(), 'relay-state-'));
    directories.push(state);
    await chmod(state, 0o700);
    const githubResult = {
      authenticatedLogin: 'jinn-relay',
      targetRepository: 'Jinn-Network/mono',
      targetRepositoryId: 'R_target',
      targetVisibility: 'PUBLIC' as const,
      targetBase: 'main',
      label: 'engine:marketplace',
      forkRepository: 'jinn-relay/mono',
      forkRepositoryId: 'R_fork',
      forkOwner: 'jinn-relay',
      forkParentRepositoryId: 'R_target',
      forkVisibility: 'PUBLIC' as const,
      ...override,
    };

    await expect(preflightIssueRelayProduction({
      config: config(),
      stateDirectory: state,
      github: async () => githubResult as never,
      resolveJinnBinary: async () => '/installed/jinn',
      marketplaceDryRun: async () => ({
        creatorSafe: '0x1111111111111111111111111111111111111111',
        solverNet: 'jinn-repo',
        escrowReady: !('escrowReady' in override)
          || override.escrowReady !== false,
        proposedSpendWei: 1n,
      }),
      verificationRuntime: async () => true,
    })).rejects.toThrow(/preflight/i);
  });
});

describe('production Relay cadence', () => {
  it.each(['observe', 'recover', 'active'] as const)(
    'runs preflight before one %s cycle',
    async (mode) => {
      const events: string[] = [];
      const result = await runIssueRelayRuntime({
        mode,
        once: true,
        pollSeconds: 30,
        preflight: async () => {
          events.push('preflight');
        },
        cycle: async () => {
          events.push(`cycle:${mode}`);
          return { discovered: 0, admitted: 0, refused: 0, actions: [] };
        },
        sleep: vi.fn(),
      });

      expect(events).toEqual(['preflight', `cycle:${mode}`]);
      expect(result).toHaveLength(1);
    },
  );
});

describe('production Relay reconciliation composition', () => {
  it('publishes one durable snapshot then pins funding intent on a later pass', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'relay-state-'));
    directories.push(parent);
    const state = join(parent, 'state');
    const artifacts = createRelayDurableArtifactStore(state);
    const base = 'a'.repeat(40);
    let comment:
      | { readonly id: number; readonly authorLogin: string; readonly body: string }
      | undefined;
    const issue = {
      repository: {
        slug: 'Jinn-Network/mono',
        nodeId: 'R_target',
        visibility: 'PUBLIC' as const,
        defaultBranch: 'main',
      },
      issue: {
        number: 17,
        url: 'https://github.com/Jinn-Network/mono/issues/17',
        title: 'Compose the production loop',
        body: '## Acceptance\n\n- [ ] the exact cycle is recoverable',
        authorLogin: 'maintainer',
        authorId: 'U_maintainer',
        updatedAt: '2026-07-28T00:00:00.000Z',
        state: 'OPEN' as const,
        isPullRequest: false,
        labels: ['engine:marketplace'],
      },
    };
    const githubRead = {
      searchOptedInIssues: vi.fn(async () => ({ issues: [issue] })),
      readIssue: vi.fn(async () => issue),
      listLabelEvents: vi.fn(async () => [{
        action: 'labeled' as const,
        label: 'engine:marketplace',
        actorLogin: 'maintainer',
        actorId: 'U_maintainer',
        createdAt: '2026-07-28T00:00:01.000Z',
      }]),
      readRepositoryPermission: vi.fn(async () => 'MAINTAIN' as const),
      readDefaultBranchHead: vi.fn(async () => base),
    };
    const githubAuthority = {
      listIssueNumbersForMarkerRecovery: vi.fn(async () => [17]),
      listIssueComments: vi.fn(async () => comment === undefined ? [] : [comment]),
      createIssueCommentExact: vi.fn(async ({ body }: { readonly body: string }) => {
        comment = { id: 91, authorLogin: 'jinn-relay', body };
        return comment;
      }),
      editIssueCommentExact: vi.fn(async (
        input: { readonly commentId: number; readonly expectedBody: string; readonly body: string },
      ) => {
        expect(comment).toMatchObject({
          id: input.commentId,
          body: input.expectedBody,
        });
        comment = { id: input.commentId, authorLogin: 'jinn-relay', body: input.body };
        return comment;
      }),
      readPullRequest: vi.fn(),
      readChecks: vi.fn(),
      listAssuranceComments: vi.fn(),
      editAssuranceCommentExact: vi.fn(),
    };
    const marketplace = {
      dryRun: vi.fn(async () => ({
        id: 'unused',
        creatorSafe: `0x${'1'.repeat(40)}`,
        solverNetManifestCid: 'manifest',
        proposedSpendWei: 1n,
      })),
      submit: vi.fn(),
      observe: vi.fn(),
    };
    const fixedNow = () => new Date('2026-07-28T00:00:02.000Z');
    const relayConfig = config();
    const reconciliation = createIssueRelayProductionReconciliation({
      config: relayConfig,
      stateDirectory: state,
      githubRead,
      githubWrite: {} as never,
      githubAuthority: githubAuthority as never,
      marketplace: marketplace as never,
      adopter: {} as never,
      artifacts,
      now: fixedNow,
    });
    const runtime = {
      mode: 'active' as const,
      config: relayConfig,
      githubRead,
      githubWrite: {} as never,
      marketplace: marketplace as never,
      adopter: {} as never,
      artifacts,
      reconciliation,
      now: fixedNow,
    };

    const admitted = await runIssueRelayCycle(runtime);
    const funding = await runIssueRelayCycle(runtime);

    expect(admitted.actions).toMatchObject([
      { action: 'publish-snapshot', outcome: 'completed' },
    ]);
    expect(funding.actions).toMatchObject([
      { action: 'prepare-round', outcome: 'completed' },
    ]);
    expect(marketplace.submit).not.toHaveBeenCalled();
    const record = parseRelayIssueCommentMarker(
      comment!.body,
      comment!.authorLogin,
      'jinn-relay',
    );
    expect(record).toMatchObject({
      phase: 'funding',
      rounds: [{
        round: 0,
        fundingIntent: {
          creatorSafe: `0x${'1'.repeat(40)}`,
          spendWei: '1',
        },
      }],
    });
  });
});

describe('bounded production GitHub ports', () => {
  const repository = {
    full_name: 'Jinn-Network/mono',
    node_id: 'R_target',
    visibility: 'public',
    private: false,
    default_branch: 'main',
    owner: { login: 'Jinn-Network' },
    parent: null,
  };

  it('uses only the exact V0 discovery query and rejects cycling pagination', async () => {
    const requests: RelayGitHubApiRequest[] = [];
    const request = vi.fn(async (
      input: RelayGitHubApiRequest,
    ): Promise<{
      status: number;
      headers: Readonly<Record<string, string>>;
      body: unknown;
    }> => {
      requests.push(input);
      if (input.path === '/repos/Jinn-Network/mono') {
        return { status: 200, headers: {}, body: repository };
      }
      return {
        status: 200,
        headers: {
          link: '<https://api.github.com/search/issues?page=1>; rel="next"',
        },
        body: {
          items: [{
            number: 17,
            html_url: 'https://github.com/Jinn-Network/mono/issues/17',
            title: 'Bounded change',
            body: '- [ ] passes',
            user: { login: 'maintainer', node_id: 'U_1' },
            updated_at: '2026-07-28T00:00:00.000Z',
            state: 'open',
            labels: [{ name: 'engine:marketplace' }],
          }],
        },
      };
    });
    const ports = createRelayGitHubProductionPorts({
      config: config(),
      token: 'test-token',
      request,
    });

    await expect(ports.read.searchOptedInIssues({
      repository: 'Jinn-Network/mono',
      label: 'engine:marketplace',
    })).rejects.toThrow(/pagination|cycle/i);
    expect(requests.find(({ path }) => path === '/search/issues')?.query)
      .toEqual({
        q: 'repo:Jinn-Network/mono is:issue is:open label:"engine:marketplace"',
        per_page: '100',
        page: '1',
      });
  });

  it('reads back exact PR authority immediately around mark-ready', async () => {
    const calls: RelayGitHubApiRequest[] = [];
    let draft = true;
    const pull = () => ({
      number: 68,
      node_id: 'PR_68',
      state: 'open',
      draft,
      user: { login: 'jinn-relay' },
      head: {
        ref: 'issue-relay/abc',
        sha: 'a'.repeat(40),
        repo: { full_name: 'jinn-relay/mono', node_id: 'R_fork' },
      },
      base: {
        ref: 'main',
        repo: { full_name: 'Jinn-Network/mono', node_id: 'R_target' },
      },
      body: '<!-- jinn-issue-relay:pull-request:v1 -->',
    });
    const request = vi.fn(async (input: RelayGitHubApiRequest) => {
      calls.push(input);
      if (input.path === '/repos/Jinn-Network/mono') {
        return { status: 200, headers: {}, body: repository };
      }
      if (input.path === '/repos/jinn-relay/mono') {
        return {
          status: 200,
          headers: {},
          body: {
            ...repository,
            full_name: 'jinn-relay/mono',
            node_id: 'R_fork',
            owner: { login: 'jinn-relay' },
            parent: repository,
          },
        };
      }
      if (input.path === '/repos/Jinn-Network/mono/pulls/68') {
        return { status: 200, headers: {}, body: pull() };
      }
      if (input.path === '/graphql') {
        draft = false;
        return {
          status: 200,
          headers: {},
          body: { data: { markPullRequestReadyForReview: { pullRequest: {
            id: 'PR_68',
            isDraft: false,
          } } } },
        };
      }
      throw new Error(`Unexpected path ${input.path}`);
    });
    const ports = createRelayGitHubProductionPorts({
      config: config(),
      token: 'test-token',
      request,
    });

    await ports.write.markPullRequestReady({
      prNumber: 68,
      expectedHead: 'a'.repeat(40),
    });

    expect(calls.map(({ path }) => path)).toEqual([
      '/repos/Jinn-Network/mono/pulls/68',
      '/repos/Jinn-Network/mono',
      '/repos/jinn-relay/mono',
      '/graphql',
      '/repos/Jinn-Network/mono/pulls/68',
      '/repos/Jinn-Network/mono',
      '/repos/jinn-relay/mono',
    ]);
    expect(calls[3]).toMatchObject({
      method: 'POST',
      body: {
        query: expect.stringContaining('markPullRequestReadyForReview'),
        variables: { pullRequestId: 'PR_68' },
      },
    });
  });

  it('exposes the exact repository-fenced GitHub command adapter used by adoption', async () => {
    const calls: RelayGitHubApiRequest[] = [];
    const request = vi.fn(async (input: RelayGitHubApiRequest) => {
      calls.push(input);
      if (input.path === '/repos/Jinn-Network/mono') {
        return { status: 200, headers: {}, body: repository };
      }
      if (input.path === '/repos/jinn-relay/mono') {
        return {
          status: 200,
          headers: {},
          body: {
            ...repository,
            full_name: 'jinn-relay/mono',
            node_id: 'R_fork',
            owner: { login: 'jinn-relay' },
            parent: repository,
          },
        };
      }
      if (
        input.method === 'POST'
        && input.path === '/repos/Jinn-Network/mono/pulls'
      ) {
        return { status: 201, headers: {}, body: { number: 68 } };
      }
      throw new Error(`Unexpected request ${input.method} ${input.path}`);
    });
    const ports = createRelayGitHubProductionPorts({
      config: config(),
      token: 'test-token',
      request,
    });

    await expect(ports.publisher({
      kind: 'create-draft-pull-request',
      targetRepositoryId: 'R_target',
      forkRepositoryId: 'R_fork',
      forkParentRepositoryId: 'R_target',
      repository: 'Jinn-Network/mono',
      title: 'Jinn Issue Relay: #17',
      body: '<!-- jinn-issue-relay:pull-request:v1 -->',
      head: 'jinn-relay:jinn/issue-relay/example',
      base: 'main',
      draft: true,
    })).resolves.toEqual({ kind: 'mutated' });
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/repos/Jinn-Network/mono/pulls',
      body: {
        draft: true,
        base: 'main',
      },
    });
  });
});
