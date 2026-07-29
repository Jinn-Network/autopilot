import {
  chmod,
  lstat,
  mkdir,
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
  runIssueRelayProductionFromEnvironment,
} from '../../src/issue-relay/runtime-production.js';
import { runIssueRelayCycle } from '../../src/issue-relay/reconciler.js';
import {
  parseRelayIssueCommentMarker,
  renderRelayIssueComment,
} from '../../src/issue-relay/report.js';
import { relayGeneration, relayTaskKey } from '../../src/issue-relay/identity.js';
import { buildRelaySnapshot } from '../../src/issue-relay/snapshot.js';
import {
  buildRelayMarketplaceRequest,
  buildRelayTaskSpec,
  persistRelayMarketplaceRequest,
} from '../../src/issue-relay/task.js';
import {
  createRelayGitHubProductionPorts,
  type RelayGitHubApiRequest,
} from '../../src/issue-relay/github-production.js';
import type { IssueRelayConfig } from '../../src/issue-relay/config.js';

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
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

  it('holds one fail-closed writer lease for a V0 state directory', async () => {
    const runtime = await import('../../src/issue-relay/runtime-production.js');
    const acquire = (
      runtime as unknown as {
        readonly acquireIssueRelayRuntimeLease?: (
          stateDirectory: string,
        ) => { readonly release: () => void };
      }
    ).acquireIssueRelayRuntimeLease;
    expect(typeof acquire).toBe('function');
    if (acquire === undefined) return;

    const parent = await mkdtemp(join(tmpdir(), 'relay-lease-'));
    directories.push(parent);
    const state = join(parent, 'state');
    const first = acquire(state);
    try {
      expect(() => acquire(state)).toThrow(/lease|writer|active/i);
      expect((await lstat(join(state, 'runtime.lock'))).mode & 0o777)
        .toBe(0o600);
    } finally {
      first.release();
    }

    const next = acquire(state);
    next.release();
  });

  it('prepares an empty verification workspace without dropping Git metadata files', async () => {
    const runtime = await import('../../src/issue-relay/runtime-production.js');
    const prepare = (
      runtime as unknown as {
        readonly prepareRelayVerificationWorkspace?: (input: {
          readonly sourcePath: string;
          readonly workspacePath: string;
        }) => Promise<void>;
      }
    ).prepareRelayVerificationWorkspace;
    expect(typeof prepare).toBe('function');
    if (prepare === undefined) return;

    const parent = await mkdtemp(join(tmpdir(), 'relay-verification-'));
    directories.push(parent);
    const sourcePath = join(parent, 'source');
    const workspacePath = join(parent, 'workspace');
    const { mkdir, readFile } = await import('node:fs/promises');
    await mkdir(join(sourcePath, '.git'), { recursive: true });
    await mkdir(join(sourcePath, '.github', 'workflows'), { recursive: true });
    await mkdir(workspacePath);
    await writeFile(join(sourcePath, '.git', 'config'), 'secret git state');
    await writeFile(join(sourcePath, '.gitignore'), 'dist\n');
    await writeFile(join(sourcePath, '.gitattributes'), '* text=auto\n');
    await writeFile(
      join(sourcePath, '.github', 'workflows', 'test.yml'),
      'name: test\n',
    );
    await writeFile(join(workspacePath, 'deleted-upstream.ts'), 'stale');

    await prepare({ sourcePath, workspacePath });

    await expect(readFile(join(workspacePath, 'deleted-upstream.ts')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(workspacePath, '.git', 'config')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(workspacePath, '.gitignore'), 'utf8'))
      .resolves.toBe('dist\n');
    await expect(readFile(join(workspacePath, '.gitattributes'), 'utf8'))
      .resolves.toBe('* text=auto\n');
    await expect(readFile(
      join(workspacePath, '.github', 'workflows', 'test.yml'),
      'utf8',
    )).resolves.toBe('name: test\n');
  });

  it('rejects same-SHA check reruns that drift after durable observation', async () => {
    const runtime = await import('../../src/issue-relay/runtime-production.js');
    const read = (
      runtime as unknown as {
        readonly readRelayPublicationAuthority?: (input: {
          readonly config: IssueRelayConfig;
          readonly record: {
            readonly generation: string;
            readonly snapshot: {
              readonly repository: {
                readonly baseOid: string;
                readonly defaultBranch: string;
              };
            };
            readonly pr: {
              readonly number: number;
              readonly branch: string;
              readonly head: string;
              readonly draft: boolean;
            };
          };
          readonly githubRead: {
            readDefaultBranchHead(): Promise<string>;
          };
          readonly githubAuthority: {
            readPullRequest(number: number): Promise<unknown>;
            readChecks(input: { head: string; base: string }): Promise<unknown>;
          };
          readonly allowReady: boolean;
          readonly expectedChecksDigest?: string;
        }) => Promise<{
          readonly checks: { readonly digest: string; readonly status?: string };
        }>;
      }
    ).readRelayPublicationAuthority;
    expect(typeof read).toBe('function');
    if (read === undefined) return;

    const head = 'b'.repeat(40);
    const generation = 'generation-authority';
    let rerunPending = false;
    const pr = {
      number: 68,
      generation,
      targetRepositoryId: 'R_target',
      forkRepositoryId: 'R_fork',
      forkParentRepositoryId: 'R_target',
      branch: 'jinn/issue-relay/authority',
      base: 'main',
      head,
      open: true,
      draft: true,
    };
    const input = {
      config: config(),
      record: {
        generation,
        snapshot: {
          repository: {
            baseOid: 'a'.repeat(40),
            defaultBranch: 'main',
          },
        },
        pr: {
          number: 68,
          branch: pr.branch,
          head,
          draft: true,
        },
      },
      githubRead: {
        readDefaultBranchHead: vi.fn(async () => 'a'.repeat(40)),
      },
      githubAuthority: {
        readPullRequest: vi.fn(async () => pr),
        readChecks: vi.fn(async () => ({
          branchRequiredChecks: [],
          checks: [{
            kind: 'check-run' as const,
            name: 'test',
            appId: 101,
            head,
            status: rerunPending ? 'in_progress' as const : 'completed' as const,
            conclusion: rerunPending ? null : 'success' as const,
          }],
        })),
      },
      allowReady: false,
    };
    const accepted = await read(input);
    rerunPending = true;

    await expect(read({
      ...input,
      expectedChecksDigest: accepted.checks.digest,
    })).rejects.toThrow(/check|authority|changed/i);
  });

  it('recovers a crash after READY mutation but before the marker update', async () => {
    const runtime = await import('../../src/issue-relay/runtime-production.js');
    const read = runtime.readRelayPublicationAuthority;
    const head = 'b'.repeat(40);
    const generation = 'generation-ready-recovery';
    const pr = {
      number: 68,
      generation,
      targetRepositoryId: 'R_target',
      forkRepositoryId: 'R_fork',
      forkParentRepositoryId: 'R_target',
      branch: 'jinn/issue-relay/ready-recovery',
      base: 'main',
      head,
      open: true,
      draft: false,
    };
    const input = {
      config: config(),
      record: {
        generation,
        snapshot: {
          repository: {
            baseOid: 'a'.repeat(40),
            defaultBranch: 'main',
          },
        },
        pr: {
          number: 68,
          branch: pr.branch,
          head,
          draft: true,
        },
      } as never,
      githubRead: {
        readDefaultBranchHead: vi.fn(async () => 'a'.repeat(40)),
      } as never,
      githubAuthority: {
        readPullRequest: vi.fn(async () => pr),
        readChecks: vi.fn(async () => ({
          branchRequiredChecks: [],
          checks: [{
            kind: 'check-run' as const,
            name: 'test',
            appId: 101,
            head,
            status: 'completed' as const,
            conclusion: 'success' as const,
          }],
        })),
      } as never,
    };

    await expect(read({ ...input, allowReady: false }))
      .rejects.toThrow(/pull request|authority/i);
    await expect(read({ ...input, allowReady: true })).resolves.toMatchObject({
      pr: { draft: false, head },
      currentBaseOid: 'a'.repeat(40),
    });
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

  it('holds the writer lease around recover/active loops and releases on failure', async () => {
    const events: string[] = [];
    await expect(runIssueRelayRuntime({
      mode: 'active',
      once: true,
      pollSeconds: 30,
      acquireWriterLease: () => {
        events.push('lease');
        return { release: () => events.push('release') };
      },
      preflight: async () => {
        events.push('preflight');
      },
      cycle: async () => {
        events.push('cycle');
        throw new Error('cycle failed');
      },
    } as never)).rejects.toThrow(/cycle failed/i);

    expect(events).toEqual(['lease', 'preflight', 'cycle', 'release']);
  });

  it('runs strict observe without creating state or marketplace artifacts', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'relay-observe-'));
    directories.push(parent);
    const state = join(parent, 'missing-state');
    const target = {
      full_name: 'Jinn-Network/mono',
      node_id: 'R_target',
      visibility: 'public',
      private: false,
      default_branch: 'main',
      owner: { login: 'Jinn-Network' },
      parent: null,
    };
    const fork = {
      ...target,
      full_name: 'jinn-relay/mono',
      node_id: 'R_fork',
      owner: { login: 'jinn-relay' },
      parent: target,
    };
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      requests.push(`${url.pathname}${url.search}`);
      const body = url.pathname === '/user'
        ? { login: 'jinn-relay' }
        : url.pathname === '/repos/Jinn-Network/mono'
          ? target
          : url.pathname === '/repos/jinn-relay/mono'
            ? fork
            : url.pathname.includes('/labels/')
              ? { name: 'engine:marketplace' }
              : url.pathname.endsWith('/branches/main')
                ? { name: 'main', commit: { sha: 'a'.repeat(40) } }
                : url.pathname.endsWith('/commits/main')
                  ? { sha: 'a'.repeat(40) }
                : url.pathname === '/search/issues'
                  ? { items: [] }
                  : url.pathname === '/repos/Jinn-Network/mono/issues'
                    ? []
                    : (() => {
                      throw new Error(`Unexpected observe URL ${url}`);
                    })();
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const raw = config();

    let failure: unknown;
    try {
      await runIssueRelayProductionFromEnvironment({
        mode: 'observe',
        once: true,
        environment: {
          PATH: process.env.PATH,
          JINN_ISSUE_RELAY_CONFIG: join(parent, 'config.json'),
          JINN_ISSUE_RELAY_GITHUB_TOKEN: 'test-token',
          JINN_ISSUE_RELAY_JINN_BINARY: join(parent, 'reviewed-jinn'),
          JINN_ISSUE_RELAY_STATE_DIRECTORY: state,
        },
      }, {
        readConfig: () => ({
          ...raw,
          budget: {
            ...raw.budget,
            maxGenerationSpendWei: raw.budget.maxGenerationSpendWei.toString(),
            maxGlobalSpendWeiPerUtcDay:
              raw.budget.maxGlobalSpendWeiPerUtcDay.toString(),
          },
        }),
        resolveJinnBinary: () => {
          throw new Error('registry Jinn client must not be resolved');
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeUndefined();
    const { access } = await import('node:fs/promises');
    await expect(access(state)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(requests.every((path) => !path.startsWith('/graphql'))).toBe(true);
  });
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
      submit: vi.fn(async () => {
        const record = parseRelayIssueCommentMarker(
          comment!.body,
          comment!.authorLogin,
          'jinn-relay',
        )!;
        return {
          id: record.rounds[0]!.fundingIntent!.taskKey,
          taskId: '1',
          taskCid: `f01551220${'a'.repeat(64)}`,
          creationTx: `0x${'b'.repeat(64)}`,
          creationBlock: 1,
          solverNetManifestCid: 'manifest',
          idempotent: false,
        };
      }),
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

    const requestPath = join(
      state,
      'rounds',
      '17',
      record!.snapshot.snapshotDigest.slice('sha256:'.length),
      '0',
      'request.json',
    );
    const { rm } = await import('node:fs/promises');
    await rm(requestPath);

    const submitted = await runIssueRelayCycle(runtime);
    expect(submitted.actions).toMatchObject([
      { action: 'submit-round', outcome: 'completed' },
    ]);
    expect(marketplace.submit).toHaveBeenCalledTimes(1);
  });

  it('refreshes GitHub funding reservations between generations in one pass', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'relay-state-'));
    directories.push(parent);
    const state = join(parent, 'state');
    const artifacts = createRelayDurableArtifactStore(state);
    const base = 'a'.repeat(40);
    const comments = new Map<number, {
      readonly id: number;
      readonly authorLogin: string;
      readonly body: string;
    }>();
    const issue = (number: number) => ({
      repository: {
        slug: 'Jinn-Network/mono',
        nodeId: 'R_target',
        visibility: 'PUBLIC' as const,
        defaultBranch: 'main',
      },
      issue: {
        number,
        url: `https://github.com/Jinn-Network/mono/issues/${number}`,
        title: `Bounded generation ${number}`,
        body: '- [ ] exact funding remains within the daily bound',
        authorLogin: `maintainer-${number}`,
        authorId: `U_${number}`,
        updatedAt: `2026-07-28T00:00:0${number - 17}.000Z`,
        state: 'OPEN' as const,
        isPullRequest: false,
        labels: ['engine:marketplace'],
      },
    });
    const githubRead = {
      searchOptedInIssues: vi.fn(async () => ({
        issues: [issue(17), issue(18)],
      })),
      readIssue: vi.fn(async (number: number) => issue(number)),
      listLabelEvents: vi.fn(async (number: number) => [{
        action: 'labeled' as const,
        label: 'engine:marketplace',
        actorLogin: `maintainer-${number}`,
        actorId: `U_${number}`,
        createdAt: '2026-07-28T00:00:01.000Z',
      }]),
      readRepositoryPermission: vi.fn(async () => 'MAINTAIN' as const),
      readDefaultBranchHead: vi.fn(async () => base),
    };
    const githubAuthority = {
      listIssueNumbersForMarkerRecovery: vi.fn(async () => [17, 18]),
      listIssueComments: vi.fn(async (number: number) => {
        const comment = comments.get(number);
        return comment === undefined ? [] : [comment];
      }),
      createIssueCommentExact: vi.fn(async (
        input: { readonly issueNumber: number; readonly body: string },
      ) => {
        const comment = {
          id: 100 + input.issueNumber,
          authorLogin: 'jinn-relay',
          body: input.body,
        };
        comments.set(input.issueNumber, comment);
        return comment;
      }),
      editIssueCommentExact: vi.fn(async (
        input: {
          readonly issueNumber: number;
          readonly commentId: number;
          readonly expectedBody: string;
          readonly body: string;
        },
      ) => {
        expect(comments.get(input.issueNumber)).toMatchObject({
          id: input.commentId,
          body: input.expectedBody,
        });
        const comment = {
          id: input.commentId,
          authorLogin: 'jinn-relay',
          body: input.body,
        };
        comments.set(input.issueNumber, comment);
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
    const relayConfig = {
      ...config(),
      budget: {
        ...config().budget,
        maxGlobalSpendWeiPerUtcDay: 1n,
      },
    };
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

    await runIssueRelayCycle(runtime);
    const reservations = await runIssueRelayCycle(runtime);

    expect(reservations.actions).toMatchObject([
      { action: 'prepare-round', outcome: 'completed' },
      { action: 'prepare-round', outcome: 'refused' },
    ]);
    expect(
      [...comments.values()].filter(({ body }) =>
        parseRelayIssueCommentMarker(body, 'jinn-relay', 'jinn-relay')
          ?.phase === 'funding'),
    ).toHaveLength(1);
  });

  it('refreshes unrelated funding reservations without hydrating marketplace readiness', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'relay-state-'));
    directories.push(parent);
    const state = join(parent, 'state');
    const durableArtifacts = createRelayDurableArtifactStore(state);
    const artifactCalls: string[] = [];
    const artifacts = {
      installImmutable: vi.fn(async (input: {
        readonly relativePath: string;
        readonly bytes: Buffer;
      }) => {
        artifactCalls.push(`install:${input.relativePath}`);
        return durableArtifacts.installImmutable(input);
      }),
      read: vi.fn(async (relativePath: string) => {
        artifactCalls.push(`read:${relativePath}`);
        return durableArtifacts.read(relativePath);
      }),
    };
    const base = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    const capturedAt = '2026-07-28T00:00:02.000Z';
    const deadlineAt = '2026-07-29T00:00:02.000Z';
    const snapshot = (number: number) => buildRelaySnapshot({
      repository: {
        slug: 'Jinn-Network/mono',
        nodeId: 'R_target',
        visibility: 'PUBLIC',
        defaultBranch: 'main',
        baseOid: base,
      },
      issue: {
        number,
        url: `https://github.com/Jinn-Network/mono/issues/${number}`,
        title: `Isolated funding ledger ${number}`,
        body: '- [ ] funding refresh remains read-only outside this generation',
        authorLogin: `maintainer-${number}`,
        authorId: `U_${number}`,
        updatedAt: '2026-07-28T00:00:00.000Z',
      },
      optIn: {
        label: 'engine:marketplace',
        actorLogin: `maintainer-${number}`,
        createdAt: '2026-07-28T00:00:01.000Z',
        permission: 'MAINTAIN',
      },
      language: 'typescript',
      verificationProfile: 'jinn-mono.v1',
      acceptanceEvidence: ['funding refresh remains isolated'],
      admissionPolicyVersion: 'jinn-issue-relay-admission.v1',
      capturedAt,
    });
    const snapshotA = snapshot(17);
    const snapshotB = snapshot(18);
    const snapshotC = snapshot(19);
    const recordA = {
      schemaVersion: 'jinn-issue-relay-generation.v1' as const,
      generation: relayGeneration(snapshotA),
      snapshot: snapshotA,
      phase: 'admitted' as const,
      deadlineAt,
      rounds: [],
      updatedAt: capturedAt,
    };
    const maximumSpendWei = 2n;
    const taskB = buildRelayTaskSpec({
      snapshot: snapshotB,
      round: 0,
      purpose: 'initial',
      workspaceRepository: snapshotB.repository.slug,
      inputHead: base,
      findings: [],
    });
    const roundB = join(
      state,
      'rounds',
      '18',
      snapshotB.snapshotDigest.slice('sha256:'.length),
      '0',
    );
    await mkdir(roundB, { recursive: true, mode: 0o700 });
    const preparedB = persistRelayMarketplaceRequest(
      join(roundB, 'request.json'),
      buildRelayMarketplaceRequest({
        task: taskB,
        solverNet: 'jinn-repo',
        maximumSpendWei,
        specPath: join(roundB, 'spec.json'),
        createdAt: capturedAt,
        submitBy: deadlineAt,
      }),
    );
    const fundingIntentB = {
      taskKey: taskB.spec.instance_id,
      creatorSafe: `0x${'1'.repeat(40)}`,
      solverNetManifestCid: 'manifest',
      requestDigest: preparedB.requestDigest,
      maximumSpendWei: maximumSpendWei.toString(),
      spendWei: '1',
      preparedAt: capturedAt,
    };
    const roundWithoutVerdict = {
      round: 0,
      purpose: 'initial' as const,
      workspaceRepository: snapshotB.repository.slug,
      inputHead: base,
      findings: [],
      fundingIntent: fundingIntentB,
      task: {
        taskKey: taskB.spec.instance_id,
        taskId: 'task-b',
        taskCid: 'bafy-task-b',
        spendWei: '1',
        fundedAt: capturedAt,
      },
      solution: {
        envelopeCid: 'bafy-solution-b',
        operatorSafe: `0x${'2'.repeat(40)}`,
        observedAt: '2026-07-28T00:00:03.000Z',
      },
      adoption: {
        disposition: 'accepted' as const,
        resultingHead: head,
        receiptDigest:
          `sha256:${'3'.repeat(64)}` as const,
      },
      checks: {
        head,
        status: 'passed' as const,
        digest: `sha256:${'4'.repeat(64)}` as const,
      },
    };
    const recordB = {
      schemaVersion: 'jinn-issue-relay-generation.v1' as const,
      generation: relayGeneration(snapshotB),
      snapshot: snapshotB,
      phase: 'evaluating' as const,
      deadlineAt,
      rounds: [roundWithoutVerdict],
      pr: {
        number: 68,
        branch: `issue-relay/${relayGeneration(snapshotB)}`,
        head,
        draft: true,
      },
      updatedAt: '2026-07-28T00:00:06.000Z',
    };
    const recordC = {
      schemaVersion: 'jinn-issue-relay-generation.v1' as const,
      generation: relayGeneration(snapshotC),
      snapshot: snapshotC,
      phase: 'admitted' as const,
      deadlineAt,
      rounds: [],
      updatedAt: capturedAt,
    };
    const comments = new Map([
      [17, {
        id: 117,
        authorLogin: 'jinn-relay',
        body: renderRelayIssueComment({
          record: recordA,
          generation: recordA.generation,
          phase: recordA.phase,
          round: 0,
          summary: 'Candidate A is admitted.',
          nextAction: 'Reserve exact funding.',
        }),
      }],
      [18, {
        id: 118,
        authorLogin: 'jinn-relay',
        body: renderRelayIssueComment({
          record: recordB,
          generation: recordB.generation,
          phase: recordB.phase,
          prNumber: 68,
          round: 0,
          summary: 'Candidate B is evaluating.',
          nextAction: 'Observe evaluator verdict.',
        }),
      }],
      [19, {
        id: 119,
        authorLogin: 'jinn-relay',
        body: renderRelayIssueComment({
          record: recordC,
          generation: recordC.generation,
          phase: recordC.phase,
          round: 0,
          summary: 'Candidate C is admitted.',
          nextAction: 'Respect the exact daily ledger.',
        }),
      }],
    ]);
    const issue = (number: number) => ({
      repository: {
        slug: 'Jinn-Network/mono',
        nodeId: 'R_target',
        visibility: 'PUBLIC' as const,
        defaultBranch: 'main',
      },
      issue: {
        number,
        url: `https://github.com/Jinn-Network/mono/issues/${number}`,
        title: `Isolated funding ledger ${number}`,
        body: '- [ ] funding refresh remains read-only outside this generation',
        authorLogin: `maintainer-${number}`,
        authorId: `U_${number}`,
        updatedAt: '2026-07-28T00:00:00.000Z',
        state: 'OPEN' as const,
        isPullRequest: false,
        labels: ['engine:marketplace'],
      },
    });
    const githubRead = {
      searchOptedInIssues: vi.fn(async () => ({
        issues: [issue(17), issue(18), issue(19), issue(20)],
      })),
      readIssue: vi.fn(async (number: number) => issue(number)),
      listLabelEvents: vi.fn(async (number: number) => [{
        action: 'labeled' as const,
        label: 'engine:marketplace',
        actorLogin: `maintainer-${number}`,
        actorId: `U_${number}`,
        createdAt: '2026-07-28T00:00:01.000Z',
      }]),
      readRepositoryPermission: vi.fn(async () => 'MAINTAIN' as const),
      readDefaultBranchHead: vi.fn(async () => base),
    };
    const githubAuthority = {
      listIssueNumbersForMarkerRecovery: vi.fn(async () => [17, 18, 19, 20]),
      listIssueComments: vi.fn(async (number: number) => {
        const comment = comments.get(number);
        return comment === undefined ? [] : [comment];
      }),
      editIssueCommentExact: vi.fn(async (input: {
        readonly issueNumber: number;
        readonly commentId: number;
        readonly expectedBody: string;
        readonly body: string;
      }) => {
        expect(comments.get(input.issueNumber)).toMatchObject({
          id: input.commentId,
          body: input.expectedBody,
        });
        const comment = {
          id: input.commentId,
          authorLogin: 'jinn-relay',
          body: input.body,
        };
        comments.set(input.issueNumber, comment);
        return comment;
      }),
      readPullRequest: vi.fn(async () => ({
        number: 68,
        generation: recordB.generation,
        branch: recordB.pr.branch,
        head,
        base: 'main',
        open: true,
        draft: true,
      })),
      readChecks: vi.fn(),
      listAssuranceComments: vi.fn(),
      editAssuranceCommentExact: vi.fn(),
    };
    const marketplace = {
      dryRun: vi.fn(async (requestPath: string) => {
        if (requestPath.includes('/18/')) {
          throw new Error(
            'unrelated evaluating generation reached marketplace during ledger refresh',
          );
        }
        return {
          id: 'candidate-a',
          creatorSafe: `0x${'1'.repeat(40)}`,
          solverNetManifestCid: 'manifest',
          proposedSpendWei: 1n,
        };
      }),
      submit: vi.fn(),
      observe: vi.fn(),
    };
    const relayConfig = {
      ...config(),
      budget: {
        ...config().budget,
        maxGlobalSpendWeiPerUtcDay: 2n,
      },
    };
    const reconciliation = createIssueRelayProductionReconciliation({
      config: relayConfig,
      stateDirectory: state,
      githubRead,
      githubWrite: {} as never,
      githubAuthority: githubAuthority as never,
      marketplace: marketplace as never,
      adopter: {} as never,
      artifacts,
      now: () => new Date('2026-07-28T00:00:07.000Z'),
    });
    const ports = {
      config: relayConfig,
      githubRead,
      githubWrite: {} as never,
      marketplace: marketplace as never,
      adopter: {} as never,
      artifacts,
      now: () => new Date('2026-07-28T00:00:07.000Z'),
    };
    const candidates = await reconciliation.scan({
      discover: true,
      recover: true,
    });
    const candidateA = candidates.find(({ issueNumber }) => issueNumber === 17);
    const candidateC = candidates.find(({ issueNumber }) => issueNumber === 19);
    expect(candidateA).toBeDefined();
    expect(candidateC).toBeDefined();

    const passedRecordB = {
      ...recordB,
      rounds: [{
        ...roundWithoutVerdict,
        verdict: {
          outcome: 'pass' as const,
          evaluatedHead: head,
          envelopeCid: 'bafy-verdict-b',
        },
      }],
      updatedAt: '2026-07-28T00:00:08.000Z',
    };
    comments.set(18, {
      id: 118,
      authorLogin: 'jinn-relay',
      body: renderRelayIssueComment({
        record: passedRecordB,
        generation: passedRecordB.generation,
        phase: passedRecordB.phase,
        prNumber: 68,
        round: 0,
        summary: 'Candidate B has an evaluator pass.',
        nextAction: 'Check exact readiness.',
      }),
    });
    marketplace.dryRun.mockClear();
    marketplace.submit.mockClear();
    marketplace.observe.mockClear();
    githubAuthority.readPullRequest.mockClear();
    githubAuthority.readChecks.mockClear();
    githubAuthority.listAssuranceComments.mockClear();
    artifactCalls.length = 0;

    await expect(reconciliation.execute({
      candidate: candidateA!,
      action: { kind: 'prepare-round', round: 0 },
      ports,
    })).resolves.toMatchObject({
      outcome: 'completed',
    });
    await expect(reconciliation.execute({
      candidate: candidateC!,
      action: { kind: 'prepare-round', round: 0 },
      ports,
    })).resolves.toMatchObject({
      outcome: 'refused',
      detail: 'Funding intent deferred',
    });

    expect(marketplace.dryRun).toHaveBeenCalledTimes(2);
    expect(marketplace.submit).not.toHaveBeenCalled();
    expect(marketplace.observe).not.toHaveBeenCalled();
    expect(githubAuthority.readPullRequest).not.toHaveBeenCalled();
    expect(githubAuthority.readChecks).not.toHaveBeenCalled();
    expect(githubAuthority.listAssuranceComments).not.toHaveBeenCalled();
    expect(artifactCalls.filter((call) => call.includes('/18/'))).toEqual([]);
    expect(parseRelayIssueCommentMarker(
      comments.get(17)!.body,
      'jinn-relay',
      'jinn-relay',
    )).toMatchObject({
      phase: 'funding',
      rounds: [{
        fundingIntent: { spendWei: '1' },
      }],
    });
    expect(parseRelayIssueCommentMarker(
      comments.get(18)!.body,
      'jinn-relay',
      'jinn-relay',
    )).toEqual(passedRecordB);
    expect(parseRelayIssueCommentMarker(
      comments.get(19)!.body,
      'jinn-relay',
      'jinn-relay',
    )).toEqual(recordC);
  });

  it('rejects a bot marker copied onto a different live GitHub issue', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'relay-state-'));
    directories.push(parent);
    const state = join(parent, 'state');
    const artifacts = createRelayDurableArtifactStore(state);
    const base = 'a'.repeat(40);
    const snapshot = buildRelaySnapshot({
      repository: {
        slug: 'Jinn-Network/mono',
        nodeId: 'R_target',
        visibility: 'PUBLIC',
        defaultBranch: 'main',
        baseOid: base,
      },
      issue: {
        number: 17,
        url: 'https://github.com/Jinn-Network/mono/issues/17',
        title: 'Original issue',
        body: '- [ ] bind the live issue identity',
        authorLogin: 'maintainer',
        authorId: 'U_maintainer',
        updatedAt: '2026-07-28T00:00:00.000Z',
      },
      optIn: {
        label: 'engine:marketplace',
        actorLogin: 'maintainer',
        createdAt: '2026-07-28T00:00:01.000Z',
        permission: 'MAINTAIN',
      },
      language: 'typescript',
      verificationProfile: 'jinn-mono.v1',
      acceptanceEvidence: ['bind the live issue identity'],
      admissionPolicyVersion: 'jinn-issue-relay-admission.v1',
      capturedAt: '2026-07-28T00:00:02.000Z',
    });
    const record = {
      schemaVersion: 'jinn-issue-relay-generation.v1' as const,
      generation: relayGeneration(snapshot),
      snapshot,
      phase: 'admitted' as const,
      deadlineAt: '2026-07-29T00:00:02.000Z',
      rounds: [],
      updatedAt: '2026-07-28T00:00:02.000Z',
    };
    const copiedBody = renderRelayIssueComment({
      record,
      generation: record.generation,
      phase: record.phase,
      round: 0,
      summary: 'Copied marker',
      nextAction: 'Must fail closed',
    });
    const copiedIssue = {
      repository: {
        slug: 'Jinn-Network/mono',
        nodeId: 'R_target',
        visibility: 'PUBLIC' as const,
        defaultBranch: 'main',
      },
      issue: {
        number: 18,
        url: 'https://github.com/Jinn-Network/mono/issues/18',
        title: 'Different issue',
        body: '- [ ] never accept a copied marker',
        authorLogin: 'maintainer',
        authorId: 'U_maintainer',
        updatedAt: '2026-07-28T00:00:00.000Z',
        state: 'OPEN' as const,
        isPullRequest: false,
        labels: ['engine:marketplace'],
      },
    };
    const reconciliation = createIssueRelayProductionReconciliation({
      config: config(),
      stateDirectory: state,
      githubRead: {
        searchOptedInIssues: vi.fn(async () => ({ issues: [copiedIssue] })),
        readIssue: vi.fn(async () => copiedIssue),
        listLabelEvents: vi.fn(async () => [{
          action: 'labeled' as const,
          label: 'engine:marketplace',
          actorLogin: 'maintainer',
          actorId: 'U_maintainer',
          createdAt: '2026-07-28T00:00:01.000Z',
        }]),
        readRepositoryPermission: vi.fn(async () => 'MAINTAIN' as const),
        readDefaultBranchHead: vi.fn(async () => base),
      },
      githubWrite: {} as never,
      githubAuthority: {
        listIssueNumbersForMarkerRecovery: vi.fn(async () => [18]),
        listIssueComments: vi.fn(async () => [{
          id: 118,
          authorLogin: 'jinn-relay',
          body: copiedBody,
        }]),
        readPullRequest: vi.fn(),
      } as never,
      marketplace: {} as never,
      adopter: {} as never,
      artifacts,
      now: () => new Date('2026-07-28T00:00:02.000Z'),
    });

    const [candidate] = await reconciliation.scan({
      discover: true,
      recover: true,
    });

    expect(candidate).toMatchObject({
      issueNumber: 18,
      authority: 'ambiguous',
    });
  });

  it('reconstructs an exact repair request from GitHub authority before submit', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'relay-state-'));
    directories.push(parent);
    const state = join(parent, 'state');
    const artifacts = createRelayDurableArtifactStore(state);
    const base = 'a'.repeat(40);
    const repairHead = 'b'.repeat(40);
    const snapshot = buildRelaySnapshot({
      repository: {
        slug: 'Jinn-Network/mono',
        nodeId: 'R_target',
        visibility: 'PUBLIC',
        defaultBranch: 'main',
        baseOid: base,
      },
      issue: {
        number: 17,
        url: 'https://github.com/Jinn-Network/mono/issues/17',
        title: 'Repair exact request',
        body: '- [ ] rebuild the repair request',
        authorLogin: 'maintainer',
        authorId: 'U_maintainer',
        updatedAt: '2026-07-28T00:00:00.000Z',
      },
      optIn: {
        label: 'engine:marketplace',
        actorLogin: 'maintainer',
        createdAt: '2026-07-28T00:00:01.000Z',
        permission: 'MAINTAIN',
      },
      language: 'typescript',
      verificationProfile: 'jinn-mono.v1',
      acceptanceEvidence: ['rebuild the repair request'],
      admissionPolicyVersion: 'jinn-issue-relay-admission.v1',
      capturedAt: '2026-07-28T00:00:02.000Z',
    });
    const generation = relayGeneration(snapshot);
    const finding = {
      code: 'test-failed',
      title: 'Repair the regression',
      detail: 'The exact-head evaluator requested this change.',
      path: 'client/src/example.ts',
    };
    const relativeRound =
      `rounds/17/${snapshot.snapshotDigest.slice('sha256:'.length)}/1`;
    const absoluteRound = join(state, relativeRound);
    await artifacts.installImmutable({
      relativePath: `${relativeRound}/identity`,
      bytes: Buffer.from(`${generation}\n`),
    });
    const repairTask = buildRelayTaskSpec({
      snapshot,
      round: 1,
      purpose: 'repair',
      workspaceRepository: 'jinn-relay/mono',
      inputHead: repairHead,
      findings: [finding],
      prNumber: 68,
      repairAuthority: {
        managedFork: true,
        workspaceRepository: 'jinn-relay/mono',
        visibility: 'PUBLIC',
        prNumber: 68,
        currentHead: repairHead,
      },
    });
    const preparedAt = '2026-07-28T00:30:00.000Z';
    const persisted = persistRelayMarketplaceRequest(
      join(absoluteRound, 'request.json'),
      buildRelayMarketplaceRequest({
        task: repairTask,
        solverNet: 'jinn-repo',
        maximumSpendWei: 2n,
        specPath: join(absoluteRound, 'spec.json'),
        createdAt: preparedAt,
        submitBy: '2026-07-29T00:00:02.000Z',
      }),
    );
    const record = {
      schemaVersion: 'jinn-issue-relay-generation.v1' as const,
      generation,
      snapshot,
      phase: 'funding' as const,
      deadlineAt: '2026-07-29T00:00:02.000Z',
      rounds: [{
        round: 0,
        purpose: 'initial' as const,
        workspaceRepository: 'Jinn-Network/mono',
        inputHead: base,
        task: {
          taskKey: relayTaskKey(generation, 0),
          taskId: '1',
          taskCid: `f01551220${'1'.repeat(64)}`,
          spendWei: '1',
          fundedAt: '2026-07-28T00:05:00.000Z',
        },
        solution: {
          envelopeCid: `f01551220${'2'.repeat(64)}`,
          operatorSafe: `0x${'1'.repeat(40)}`,
          observedAt: '2026-07-28T00:10:00.000Z',
        },
        adoption: {
          disposition: 'accepted' as const,
          resultingHead: repairHead,
          prNumber: 68,
          receiptDigest:
            `sha256:${'3'.repeat(64)}` as const,
          recordedAt: '2026-07-28T00:15:00.000Z',
        },
        checks: {
          head: repairHead,
          status: 'passed' as const,
          digest: `sha256:${'4'.repeat(64)}` as const,
          observedAt: '2026-07-28T00:16:00.000Z',
        },
        verdict: {
          outcome: 'request-changes' as const,
          evaluatedHead: repairHead,
          evaluatorSafe: `0x${'2'.repeat(40)}`,
          envelopeCid: `f01551220${'5'.repeat(64)}`,
          observedAt: '2026-07-28T00:20:00.000Z',
        },
      }, {
        round: 1,
        purpose: 'repair' as const,
        workspaceRepository: 'jinn-relay/mono',
        inputHead: repairHead,
        findings: [finding],
        prNumber: 68,
        fundingIntent: {
          taskKey: relayTaskKey(generation, 1),
          creatorSafe: `0x${'1'.repeat(40)}`,
          solverNetManifestCid: 'manifest',
          requestDigest: persisted.requestDigest,
          maximumSpendWei: '2',
          spendWei: '1',
          preparedAt,
        },
      }],
      pr: {
        number: 68,
        branch: `jinn/issue-relay/${generation}`,
        head: repairHead,
        draft: true,
        targetRepository: 'Jinn-Network/mono',
        targetRepositoryId: 'R_target',
        forkRepository: 'jinn-relay/mono',
        forkRepositoryId: 'R_fork',
        forkParentRepositoryId: 'R_target',
        visibility: 'PUBLIC' as const,
        managedFork: true as const,
      },
      updatedAt: preparedAt,
    };
    let comment = {
      id: 117,
      authorLogin: 'jinn-relay',
      body: renderRelayIssueComment({
        record,
        generation,
        phase: 'funding',
        prNumber: 68,
        round: 1,
        summary: 'Repair funding intent pinned.',
        nextAction: 'Submit exact repair.',
      }),
    };
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
        title: snapshot.issue.title,
        body: snapshot.issue.body,
        authorLogin: 'maintainer',
        authorId: 'U_maintainer',
        updatedAt: snapshot.issue.updatedAt,
        state: 'OPEN' as const,
        isPullRequest: false,
        labels: ['engine:marketplace'],
      },
    };
    const pullRequest = {
      number: 68,
      generation,
      targetRepositoryId: 'R_target',
      forkRepositoryId: 'R_fork',
      forkParentRepositoryId: 'R_target',
      branch: `jinn/issue-relay/${generation}`,
      base: 'main',
      head: repairHead,
      open: true,
      draft: true,
    };
    const marketplace = {
      dryRun: vi.fn(async () => ({
        id: relayTaskKey(generation, 1),
        creatorSafe: `0x${'1'.repeat(40)}`,
        solverNetManifestCid: 'manifest',
        proposedSpendWei: 1n,
      })),
      submit: vi.fn(async () => ({
        id: relayTaskKey(generation, 1),
        taskId: '2',
        taskCid: `f01551220${'6'.repeat(64)}`,
        creationTx: `0x${'7'.repeat(64)}`,
        creationBlock: 2,
        solverNetManifestCid: 'manifest',
        idempotent: false,
      })),
      observe: vi.fn(),
    };
    const reconciliation = createIssueRelayProductionReconciliation({
      config: config(),
      stateDirectory: state,
      githubRead: {
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
      },
      githubWrite: {} as never,
      githubAuthority: {
        listIssueNumbersForMarkerRecovery: vi.fn(async () => [17]),
        listIssueComments: vi.fn(async () => [comment]),
        readPullRequest: vi.fn(async () => pullRequest),
        editIssueCommentExact: vi.fn(async (input) => {
          expect(input.expectedBody).toBe(comment.body);
          comment = { ...comment, body: input.body };
          return comment;
        }),
      } as never,
      marketplace: marketplace as never,
      adopter: {} as never,
      artifacts,
      now: () => new Date('2026-07-28T00:31:00.000Z'),
    });
    const { rm } = await import('node:fs/promises');
    await rm(join(absoluteRound, 'request.json'));
    await rm(join(absoluteRound, 'spec.json'));

    const report = await runIssueRelayCycle({
      mode: 'active',
      config: config(),
      githubRead: {} as never,
      githubWrite: {} as never,
      marketplace: marketplace as never,
      adopter: {} as never,
      artifacts,
      reconciliation,
      now: () => new Date('2026-07-28T00:31:00.000Z'),
    });

    expect(report.actions).toMatchObject([
      { action: 'submit-round', outcome: 'completed' },
    ]);
    expect(marketplace.submit).toHaveBeenCalledTimes(1);
    expect(
      parseRelayIssueCommentMarker(comment.body, 'jinn-relay', 'jinn-relay'),
    ).toMatchObject({
      phase: 'submitted',
      rounds: [{ round: 0 }, { round: 1, task: { taskId: '2' } }],
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

  it('edits READY assurance on the exact open non-draft pull request', async () => {
    let body = 'before';
    const comment = () => ({
      id: 91,
      issue_url: 'https://api.github.com/repos/Jinn-Network/mono/issues/68',
      user: { login: 'jinn-relay' },
      body,
    });
    const pull = {
      number: 68,
      node_id: 'PR_68',
      state: 'open',
      draft: false,
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
    };
    const request = vi.fn(async (input: RelayGitHubApiRequest) => {
      if (input.path === '/repos/Jinn-Network/mono/pulls/68') {
        return { status: 200, headers: {}, body: pull };
      }
      if (
        input.path === '/repos/Jinn-Network/mono/issues/comments/91'
        && input.method === 'GET'
      ) {
        return { status: 200, headers: {}, body: comment() };
      }
      if (
        input.path === '/repos/Jinn-Network/mono/issues/comments/91'
        && input.method === 'PATCH'
      ) {
        body = (input.body as { readonly body: string }).body;
        return { status: 200, headers: {}, body: comment() };
      }
      throw new Error(`Unexpected request ${input.method} ${input.path}`);
    });
    const ports = createRelayGitHubProductionPorts({
      config: config(),
      token: 'test-token',
      request,
    });

    await expect(ports.authority.editAssuranceCommentExact({
      prNumber: 68,
      commentId: 91,
      expectedHead: 'a'.repeat(40),
      expectedBody: 'before',
      body: 'ready',
    })).resolves.toMatchObject({ id: 91, body: 'ready' });
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
