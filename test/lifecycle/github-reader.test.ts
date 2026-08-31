import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import {
  extractImplementationCompletionSummary,
  GhLifecycleReader,
} from '../../src/lifecycle/github-reader.js';
import {
  GitHubUsageMeter,
  makeGitHubUsageCommandRunner,
} from '../../src/lifecycle/github-usage.js';

const OPEN_HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MERGED_HEAD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const REVIEW_CLAIM_GLOB = 'refs/jinn-autopilot/review-claims/v1/*';
const CI_RERUN_REF_GLOB = 'refs/jinn-autopilot/ci-reruns/v1/pr-*';
const AUTOPILOT_BRANCH_GLOB = 'refs/heads/autopilot/*';

/**
 * Every review-claim read now goes over the git transport (a single
 * `git ls-remote <remote> '<glob>'` per snapshot, see github-reader.ts) —
 * GitHub's GraphQL `ref(qualifiedName:)` permanently returns null for this
 * custom ref namespace (jinn-mono#1883-follow-up, proven live). Fakes below
 * that don't care about review claims answer every `git` call with "no refs
 * yet" so every PR's `reviewClaim` resolves to null, matching the old
 * always-absent GraphQL stub they replace.
 */
function noReviewClaimRefs(command: string): string | undefined {
  return command === 'git' ? '' : undefined;
}

function isReviewClaimListingCall(args: string[]): boolean {
  return args[2] === 'ls-remote' && args[4] === REVIEW_CLAIM_GLOB;
}

function rateLimit() {
  return {
    cost: 1,
    remaining: 4_999,
    resetAt: '2026-07-22T13:00:00.000Z',
  };
}

it('extracts the durable summary from an exact phase-complete commit envelope', () => {
  const trailers = [
    'Jinn-Autopilot-Protocol: 2',
    'Jinn-Autopilot-Phase: implement',
    'Jinn-Autopilot-Issue: 42',
    'Jinn-Autopilot-PR: 101',
    'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
    'Jinn-Autopilot-Runner: runner-a',
    'Jinn-Autopilot-Login: implementer',
    `Jinn-Autopilot-Expected-Head: ${OPEN_HEAD}`,
    'Jinn-Autopilot-Target-Base: next',
    'Jinn-Autopilot-Claimed-At: 2026-07-20T12:00:00.000Z',
    'Jinn-Autopilot-Phase-Complete: true',
  ].join('\n');
  const message = [
    'Autopilot implementation phase complete',
    '',
    'Implemented exact lifecycle ownership.',
    '',
    trailers,
  ].join('\n');

  expect(extractImplementationCompletionSummary(message, trailers))
    .toBe('Implemented exact lifecycle ownership.');
});

function graphQlPr(input: {
  readonly number: number;
  readonly state: 'OPEN' | 'MERGED' | 'CLOSED';
  readonly head: string;
  readonly comments?: readonly string[];
  readonly commentAuthor?: string;
  readonly timelineItems?: readonly {
    readonly __typename: 'LabeledEvent' | 'UnlabeledEvent' | 'ConvertToDraftEvent' | 'ReadyForReviewEvent';
    readonly actor: { readonly login: string } | null;
    readonly createdAt: string;
    readonly label?: { readonly name: string };
  }[];
  readonly headRefName?: string;
  readonly historyTruncated?: boolean;
  readonly commentsTruncated?: boolean;
  readonly labels?: readonly string[];
  readonly message?: string;
  readonly closingIssueNumber?: number;
  readonly statusCheckRollup?: unknown;
}) {
  return {
    number: input.number,
    title: `PR ${input.number}`,
    body: 'Lifecycle PR',
    updatedAt: '2026-07-20T09:30:00.000Z',
    author: { login: 'trusted' },
    baseRefName: 'next',
    headRefName: input.headRefName ?? `autopilot/${input.number === 101 ? 42 : 41}`,
    headRefOid: input.head,
    isDraft: input.state === 'OPEN',
    state: input.state,
    labels: {
      pageInfo: { hasNextPage: false },
      nodes: (input.labels ?? ['engine:review']).map((name) => ({ name })),
    },
    closingIssuesReferences: {
      pageInfo: { hasNextPage: false },
      nodes: [{ number: input.closingIssueNumber ?? (input.number === 101 ? 42 : 41) }],
    },
    mergeable: 'MERGEABLE',
    // Deliberately off the compare-evidence path. These tests are about claim
    // parsing, paging, transport and usage accounting, and none of them stubs
    // the exact REST compare read that every queue-eligible merge state now
    // pays for — BLOCKED included, since issue #82. UNKNOWN keeps the fixture
    // out of that read without asserting anything about mergeability.
    mergeStateStatus: 'UNKNOWN',
    mergedAt: input.state === 'MERGED' ? '2026-07-20T10:00:00.000Z' : null,
    mergeCommit: input.state === 'MERGED' ? { oid: input.head } : null,
    commits: {
      pageInfo: { hasPreviousPage: input.historyTruncated ?? false },
      nodes: [{
        commit: {
          oid: input.head,
          committedDate: '2026-07-20T09:00:00.000Z',
          message: input.message ?? 'work',
        },
      }],
    },
    reviews: {
      pageInfo: { hasNextPage: false },
      nodes: [],
    },
    comments: {
      pageInfo: { hasPreviousPage: input.commentsTruncated ?? false },
      nodes: (input.comments ?? []).map((body, index) => ({
        fullDatabaseId: String(10_000 + index),
        body,
        author: input.commentAuthor === undefined ? null : { login: input.commentAuthor },
      })),
    },
    timelineItems: {
      pageInfo: { hasPreviousPage: false },
      nodes: [...(input.timelineItems ?? [])],
    },
    statusCheckRollup: input.statusCheckRollup ?? null,
  };
}

describe('GhLifecycleReader', () => {
  it('reads exact live GraphQL remaining evidence from the uncharged REST quota resource', async () => {
    const calls: string[][] = [];
    const reader = new GhLifecycleReader(async (_command, args) => {
      calls.push(args);
      return JSON.stringify({
        resources: {
          graphql: {
            limit: 5_000,
            used: 4_490,
            remaining: 510,
            reset: 1_784_725_200,
          },
        },
      });
    });

    await expect(reader.readGraphQlRemaining()).resolves.toBe(510);
    expect(calls[0]).toEqual([
      'api',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2026-03-10',
      '/rate_limit',
    ]);
    expect(reader.githubUsage()).toMatchObject({
      graphqlRequests: 0,
      graphqlCost: 0,
      graphqlRemaining: 510,
      graphqlResetAt: '2026-07-22T13:00:00.000Z',
      restRequests: 1,
    });
  });

  it('rejects opaque gh subcommands on the full lifecycle reader runner path', async () => {
    const reader = new GhLifecycleReader(async (command, args) => {
      if (command === 'gh' && args[0] !== 'api') {
        throw new Error(`opaque gh command blocked: ${args[0]}`);
      }
      return JSON.stringify({
        resources: {
          graphql: {
            limit: 5_000,
            used: 0,
            remaining: 5_000,
            reset: 1_784_725_200,
          },
        },
      });
    });

    await expect(reader.readGraphQlRemaining()).resolves.toBe(5_000);
  });

  it.each([
    ['missing resources', {}],
    ['missing graphql resource', { resources: {} }],
    ['invalid remaining', {
      resources: { graphql: { limit: 5_000, used: 5_001, remaining: -1, reset: 1_784_725_200 } },
    }],
    ['missing reset', {
      resources: { graphql: { limit: 5_000, used: 4_490, remaining: 510 } },
    }],
    ['inconsistent limit and used', {
      resources: { graphql: { limit: 5_000, used: 4_000, remaining: 510, reset: 1_784_725_200 } },
    }],
  ])('fails closed when the REST quota response has %s', async (_label, response) => {
    const reader = new GhLifecycleReader(async () => JSON.stringify(response));

    await expect(reader.readGraphQlRemaining()).rejects.toThrow(/rate-limit.*remaining|graphql/i);
  });

  it('fails closed when a requested native Project issue alias resolves to null', async () => {
    let query = '';
    const reader = new GhLifecycleReader(async (_command, args) => {
      query = args.find((arg) => arg.startsWith('query=')) ?? '';
      return JSON.stringify({
        data: {
          rateLimit: { cost: 2, remaining: 518, resetAt: '2026-07-22T13:00:00.000Z' },
          repository: {
            issue42: {
              closedByPullRequestsReferences: {
                pageInfo: { hasNextPage: false },
                nodes: [{ number: 101, state: 'OPEN' }, { number: 99, state: 'MERGED' }],
              },
            },
            issue43: null,
          },
        },
      });
    });

    await expect(reader.readPullRequestNumbersClosingIssues([43, 42, 42]))
      .rejects.toThrow(/issue #43.*null|issue #43.*missing/i);
    expect(query).toContain('rateLimit { cost remaining resetAt }');
    expect(query).toContain('issue42: issue(number: 42)');
    expect(query).toContain('nodes { number state }');
    expect(reader.githubUsage()).toMatchObject({
      graphqlRequests: 1,
      graphqlCost: 2,
      graphqlRemaining: 518,
    });
  });

  it('discovers only open PR numbers closing targeted issues with strict quota evidence', async () => {
    const reader = new GhLifecycleReader(async () => JSON.stringify({
      data: {
        rateLimit: { cost: 2, remaining: 518, resetAt: '2026-07-22T13:00:00.000Z' },
        repository: {
          issue42: {
            closedByPullRequestsReferences: {
              pageInfo: { hasNextPage: false },
              nodes: [{ number: 101, state: 'OPEN' }, { number: 99, state: 'MERGED' }],
            },
          },
        },
      },
    }));

    await expect(reader.readPullRequestNumbersClosingIssues([42, 42]))
      .resolves.toEqual(new Set([101]));
  });

  it('discovers open and merged blocker outcomes for targeted recovery', async () => {
    const reader = new GhLifecycleReader(async () => JSON.stringify({
      data: {
        rateLimit: { cost: 2, remaining: 518, resetAt: '2026-07-22T13:00:00.000Z' },
        repository: {
          issue42: {
            closedByPullRequestsReferences: {
              pageInfo: { hasNextPage: false },
              nodes: [
                { number: 101, state: 'OPEN' },
                { number: 99, state: 'MERGED' },
                { number: 98, state: 'CLOSED' },
              ],
            },
          },
        },
      },
    }));

    await expect(reader.readPullRequestOutcomeNumbersClosingIssues([42, 42]))
      .resolves.toEqual(new Set([99, 101]));
  });

  it('rejects blocker-outcome discovery above its exact two-point reserve', async () => {
    const reader = new GhLifecycleReader(async () => JSON.stringify({
      data: {
        rateLimit: { cost: 3, remaining: 517, resetAt: '2026-07-22T13:00:00.000Z' },
        repository: {
          issue42: {
            closedByPullRequestsReferences: {
              pageInfo: { hasNextPage: false },
              nodes: [{ number: 99, state: 'MERGED' }],
            },
          },
        },
      },
    }));

    await expect(reader.readPullRequestOutcomeNumbersClosingIssues([42]))
      .rejects.toThrow(/cost 3 exceeded.*2-point reserve/i);
  });

  it.each([
    ['partial data with GraphQL errors', [{ message: 'issue lookup failed' }]],
    ['a malformed GraphQL errors member', { message: 'not an array' }],
  ] as const)('fails closed on %s', async (_label, errors) => {
    const reader = new GhLifecycleReader(async () => JSON.stringify({
      errors,
      data: {
        rateLimit: { cost: 1, remaining: 518, resetAt: '2026-07-22T13:00:00.000Z' },
        repository: {
          issue42: {
            closedByPullRequestsReferences: {
              pageInfo: { hasNextPage: false },
              nodes: [{ number: 101, state: 'OPEN' }],
            },
          },
        },
      },
    }));

    await expect(reader.readPullRequestNumbersClosingIssues([42]))
      .rejects.toThrow(/GraphQL errors/i);
  });

  it('fails closed when targeted issue-to-closing-PR discovery is truncated', async () => {
    const reader = new GhLifecycleReader(async () => JSON.stringify({
      data: {
        rateLimit: { cost: 1, remaining: 518, resetAt: '2026-07-22T13:00:00.000Z' },
        repository: {
          issue42: {
            closedByPullRequestsReferences: {
              pageInfo: { hasNextPage: true },
              nodes: [{ number: 101, state: 'OPEN' }],
            },
          },
        },
      },
    }));

    await expect(reader.readPullRequestNumbersClosingIssues([42]))
      .rejects.toThrow(/truncated|pagination/i);
  });

  it('continues targeted issue-to-closing-PR discovery when quota evidence is omitted', async () => {
    const reader = new GhLifecycleReader(async () => JSON.stringify({
      data: {
        repository: {
          issue42: {
            closedByPullRequestsReferences: {
              pageInfo: { hasNextPage: false },
              nodes: [],
            },
          },
        },
      },
    }));

    await expect(reader.readPullRequestNumbersClosingIssues([42])).resolves.toEqual(new Set());
    expect(reader.githubUsage()).toMatchObject({
      graphqlRequests: 1,
      graphqlCost: 0,
      graphqlRemaining: null,
      graphqlResetAt: null,
      accountingComplete: false,
    });
  });

  it('reuses a shared metered runner without counting reader traffic twice', async () => {
    const raw: CommandRunner = async () => '[]';
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(raw, meter);
    const reader = new GhLifecycleReader(run, {
      usageMeter: meter,
      runnerIsMetered: true,
    });

    await expect(reader.readIssues({
      currentSprintIterationId: null,
      getIssue: () => null,
    })).resolves.toEqual([]);
    expect(reader.githubUsage().restRequests).toBe(1);
  });

  it('reads every open issue in a repository that has more than 200 (regression)', async () => {
    // 207 open issues: three REST pages. The old guard broke the pagination
    // loop at 200 and then read that stop as proof of truncation, so a
    // repository crossing 200 open issues could never complete a full
    // reconciliation.
    const rows = Array.from({ length: 207 }, (_, index) => ({
      number: index + 1,
      title: `Issue ${index + 1}`,
      labels: [],
      body: '',
      state: 'open',
      user: { login: 'maintainer' },
    }));
    const run = async (_command: string, args: string[]) => {
      const endpoint = args[1] ?? '';
      if (endpoint.endsWith('&page=1')) return JSON.stringify(rows.slice(0, 100));
      if (endpoint.endsWith('&page=2')) return JSON.stringify(rows.slice(100, 200));
      if (endpoint.endsWith('&page=3')) return JSON.stringify(rows.slice(200));
      throw new Error(`unexpected call: ${args.join(' ')}`);
    };
    const reader = new GhLifecycleReader(run);

    const issues = await reader.readIssues({
      currentSprintIterationId: null,
      getIssue: () => null,
    });

    expect(issues).toHaveLength(207);
  });

  it('counts each explicit REST page used to read open issues', async () => {
    const calls: string[][] = [];
    const rows = Array.from({ length: 101 }, (_, index) => ({
      number: index + 1,
      title: `Issue ${index + 1}`,
      labels: [],
      author: { login: 'trusted' },
      user: { login: 'trusted' },
    }));
    const run: CommandRunner = async (command, args) => {
      calls.push(args);
      if (command !== 'gh') throw new Error('unexpected command');
      if (args[0] === 'issue') return JSON.stringify(rows);
      const endpoint = args[1] ?? '';
      if (endpoint.endsWith('&page=1')) return JSON.stringify(rows.slice(0, 100));
      if (endpoint.endsWith('&page=2')) return JSON.stringify(rows.slice(100));
      throw new Error(`unexpected call: ${args.join(' ')}`);
    };
    const reader = new GhLifecycleReader(run);

    const issues = await reader.readIssues({
      currentSprintIterationId: null,
      getIssue: () => null,
    });

    expect(issues).toHaveLength(101);
    expect(calls).toEqual([
      ['api', 'repos/Jinn-Network/mono/issues?state=open&per_page=100&page=1'],
      ['api', 'repos/Jinn-Network/mono/issues?state=open&per_page=100&page=2'],
    ]);
    expect(reader.githubUsage().restRequests).toBe(2);
  });

  it('uses one injected non-Jinn identity across REST and GraphQL reads', async () => {
    const calls: string[][] = [];
    const reader = new GhLifecycleReader(async (command, args) => {
      calls.push(args);
      if (command === 'gh' && args[1]?.includes('/issues?')) return '[]';
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
          repository: { issue42: {
            closedByPullRequestsReferences: {
              pageInfo: { hasNextPage: false },
              nodes: [],
            },
          } },
        },
      });
    }, {
      repositorySlug: 'Octo-Labs/widget',
      projectOwner: 'Octo-Labs',
      projectNumber: 7,
      remoteName: 'https://github.com/Octo-Labs/widget.git',
    });

    await reader.readIssues({
      currentSprintIterationId: null,
      getIssue: () => null,
    });
    await reader.readPullRequestNumbersClosingIssues([42]);

    expect(calls[0]).toEqual([
      'api',
      'repos/Octo-Labs/widget/issues?state=open&per_page=100&page=1',
    ]);
    expect(calls[1]).toContain('owner=Octo-Labs');
    expect(calls[1]).toContain('name=widget');
    expect(calls.flat().join(' ')).not.toContain('Jinn-Network/mono');
  });

  it('counts each explicit REST page used to read matching branch refs', async () => {
    const calls: string[][] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      ref: `refs/heads/not-autopilot-${index}`,
      object: { sha: `${index}`.padStart(40, '0') },
    }));
    const run: CommandRunner = async (_command, args) => {
      calls.push(args);
      if (args.includes('--paginate')) return JSON.stringify([firstPage, []]);
      const endpoint = args[1] ?? '';
      if (endpoint.endsWith('&page=1')) return JSON.stringify(firstPage);
      if (endpoint.endsWith('&page=2')) return JSON.stringify([]);
      throw new Error(`unexpected call: ${args.join(' ')}`);
    };
    const reader = new GhLifecycleReader(run);

    await expect(reader.readBranchClaims()).resolves.toEqual([]);

    expect(calls).toEqual([
      ['api', 'repos/Jinn-Network/mono/git/matching-refs/heads/autopilot/?per_page=100&page=1'],
      ['api', 'repos/Jinn-Network/mono/git/matching-refs/heads/autopilot/?per_page=100&page=2'],
    ]);
    expect(reader.githubUsage().restRequests).toBe(2);
  });

  it('requests and meters top-level GraphQL rate-limit evidence', async () => {
    let query = '';
    const run: CommandRunner = async (_command, args) => {
      query = args.find((arg) => arg.startsWith('query=')) ?? '';
      return JSON.stringify({
        data: {
          rateLimit: {
            cost: 3,
            remaining: 4_997,
            resetAt: '2026-07-22T13:00:00.000Z',
          },
          repository: {
            issue: {
              issueType: { name: 'fix' },
              projectItems: {
                pageInfo: { hasNextPage: false },
                nodes: [{
                  id: 'PVTI_42',
                  project: { number: 1 },
                  status: { name: 'In Review' },
                  priority: { name: 'P1' },
                  effort: { name: 'Medium' },
                  blockedOn: { name: 'Nothing' },
                }],
              },
            },
          },
        },
      });
    };
    const reader = new GhLifecycleReader(run);

    await expect(reader.readProjectItemForReconciliation(42)).resolves.toEqual({
      id: 'PVTI_42',
      status: 'In Review',
      priority: 'P1',
      effort: 'Medium',
      blockedOn: 'Nothing',
      issueType: 'fix',
    });

    expect(query).toContain('rateLimit { cost remaining resetAt }');
    expect(query).toContain('fieldValueByName(name: "Priority")');
    expect(query).toContain('fieldValueByName(name: "Effort")');
    expect(reader.githubUsage()).toMatchObject({
      graphqlRequests: 1,
      graphqlCost: 3,
      graphqlRemaining: 4_997,
    });
  });

  it('reads the native issue type, which GraphQL never exposes as a Project field', async () => {
    // GitHub's GraphQL API has no ProjectV2 "Type" field: the board column is a
    // projection of the native issue type, and `fieldValueByName(name: "Type")`
    // resolves to null on every item. Only `Issue.issueType` carries it.
    let query = '';
    const run: CommandRunner = async (_command, args) => {
      query = args.find((arg) => arg.startsWith('query=')) ?? '';
      return JSON.stringify({
        data: {
          rateLimit: { cost: 1, remaining: 4_999, resetAt: '2026-07-22T13:00:00.000Z' },
          repository: {
            issue: {
              issueType: { name: 'fix' },
              projectItems: {
                pageInfo: { hasNextPage: false },
                nodes: [{
                  id: 'PVTI_42',
                  project: { number: 1 },
                  status: { name: 'Todo' },
                  priority: { name: 'P3' },
                  effort: { name: 'Medium' },
                  blockedOn: { name: 'Nothing' },
                }],
              },
            },
          },
        },
      });
    };

    await expect(new GhLifecycleReader(run).readProjectItemForReconciliation(42))
      .resolves.toEqual({
        id: 'PVTI_42',
        status: 'Todo',
        priority: 'P3',
        effort: 'Medium',
        blockedOn: 'Nothing',
        issueType: 'fix',
      });
    expect(query).toContain('issueType { name }');
    expect(query).not.toContain('fieldValueByName(name: "Type")');
  });

  it('fails closed when the native issue type is unset or unrecognised', async () => {
    const readerFor = (issueType: unknown): GhLifecycleReader => new GhLifecycleReader(
      async () => JSON.stringify({
        data: {
          rateLimit: { cost: 1, remaining: 4_999, resetAt: '2026-07-22T13:00:00.000Z' },
          repository: {
            issue: {
              issueType,
              projectItems: {
                pageInfo: { hasNextPage: false },
                nodes: [{
                  id: 'PVTI_42',
                  project: { number: 1 },
                  status: { name: 'Todo' },
                  priority: { name: 'P3' },
                  effort: { name: 'Medium' },
                  blockedOn: { name: 'Nothing' },
                }],
              },
            },
          },
        },
      }),
    );

    // Genuinely unset: refuse, do not invent a shape.
    await expect(readerFor(null).readProjectItemForReconciliation(42))
      .resolves.toMatchObject({ issueType: null });
    // Field absent entirely — what `issue?.issueType` actually yields when the
    // selection is missing. Must behave like `null`, not throw on `node.name`.
    await expect(readerFor(undefined).readProjectItemForReconciliation(42))
      .resolves.toMatchObject({ issueType: null });
    // Malformed `name`: refuse rather than propagate a non-shape value. The
    // vocabulary lookup already rejects it, so this pins the outcome, not the
    // `typeof` guard — that guard exists to narrow `name` for the cast.
    await expect(readerFor({ name: 123 }).readProjectItemForReconciliation(42))
      .resolves.toMatchObject({ issueType: null });
    // Organisation-defined type outside the lifecycle vocabulary: refuse, and do
    // not throw — an unknown type is an ineligible issue, not a broken cycle.
    await expect(readerFor({ name: 'Bug' }).readProjectItemForReconciliation(42))
      .resolves.toMatchObject({ issueType: null });
  });

  it('fails closed when the direct targeted Project-item lookup exceeds its fixed limit', async () => {
    const run: CommandRunner = async () => JSON.stringify({
      data: {
        rateLimit: { cost: 1, remaining: 4_999, resetAt: '2026-07-22T13:00:00.000Z' },
        repository: {
          issue: {
            projectItems: { pageInfo: { hasNextPage: true }, nodes: [] },
          },
        },
      },
    });

    await expect(new GhLifecycleReader(run).readProjectItemForReconciliation(42))
      .rejects.toThrow(/Project-item.*pagination|pagination.*fixed limit/i);
  });

  it('combines targeted Project and open closing-PR relation evidence in one query', async () => {
    let query = '';
    const run: CommandRunner = async (_command, args) => {
      query = args.find((arg) => arg.startsWith('query=')) ?? '';
      return JSON.stringify({
        data: {
          rateLimit: { cost: 2, remaining: 4_998, resetAt: '2026-07-22T13:00:00.000Z' },
          repository: {
            issue: {
              issueType: { name: 'fix' },
              projectItems: {
                pageInfo: { hasNextPage: false },
                nodes: [{
                  id: 'PVTI_42',
                  project: { number: 1 },
                  status: { name: 'In Progress' },
                  priority: { name: 'P1' },
                  effort: { name: 'Medium' },
                  blockedOn: { name: 'Nothing' },
                }],
              },
              closedByPullRequestsReferences: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  { number: 101, state: 'OPEN' },
                  { number: 99, state: 'MERGED' },
                ],
              },
            },
          },
        },
      });
    };
    const reader = new GhLifecycleReader(run);

    await expect(reader.readIssueActionContextForReconciliation(42)).resolves.toEqual({
      projectItem: expect.objectContaining({
        id: 'PVTI_42',
        status: 'In Progress',
        issueType: 'fix',
      }),
      openPullRequestNumbers: new Set([101]),
    });
    expect(query).toContain('projectItems(first: 10)');
    expect(query).toContain('closedByPullRequestsReferences(first: 100, includeClosedPrs: true)');
    expect(query).toContain('issueType { name }');
    expect(query).not.toContain('fieldValueByName(name: "Type")');
    expect(reader.githubUsage()).toMatchObject({ graphqlRequests: 1, graphqlCost: 2 });
  });

  it('fails closed when the combined targeted issue context is paginated', async () => {
    const run: CommandRunner = async () => JSON.stringify({
      data: {
        rateLimit: { cost: 2, remaining: 4_998, resetAt: '2026-07-22T13:00:00.000Z' },
        repository: {
          issue: {
            projectItems: { pageInfo: { hasNextPage: false }, nodes: [] },
            closedByPullRequestsReferences: {
              pageInfo: { hasNextPage: true },
              nodes: [],
            },
          },
        },
      },
    });

    await expect(new GhLifecycleReader(run).readIssueActionContextForReconciliation(42))
      .rejects.toThrow(/pagination/i);
  });

  it('fails closed when the combined context reports more than its two-point reserve', async () => {
    const run: CommandRunner = async () => JSON.stringify({
      data: {
        rateLimit: { cost: 3, remaining: 4_997, resetAt: '2026-07-22T13:00:00.000Z' },
        repository: {
          issue: {
            projectItems: { pageInfo: { hasNextPage: false }, nodes: [] },
            closedByPullRequestsReferences: {
              pageInfo: { hasNextPage: false },
              nodes: [],
            },
          },
        },
      },
    });

    await expect(new GhLifecycleReader(run).readIssueActionContextForReconciliation(42))
      .rejects.toThrow(/exceeded 2-point reserve/i);
  });

  it('reads an empty targeted Project item result when rate-limit evidence is omitted', async () => {
    const run: CommandRunner = async () => JSON.stringify({
      data: {
        repository: {
          issue: { projectItems: { pageInfo: { hasNextPage: false }, nodes: [] } },
        },
      },
    });

    const reader = new GhLifecycleReader(run);
    await expect(reader.readProjectItemForReconciliation(42)).resolves.toBeNull();
    expect(reader.githubUsage()).toMatchObject({
      graphqlRequests: 1,
      graphqlCost: 0,
      graphqlRemaining: null,
      graphqlResetAt: null,
      accountingComplete: false,
    });
  });

  it('parses lifecycle metadata only from the terminal trailer block', async () => {
    const trailers = [
      'Jinn-Autopilot-Protocol: 2',
      'Jinn-Autopilot-Phase: implement',
      'Jinn-Autopilot-Issue: 42',
      'Jinn-Autopilot-PR: 101',
      'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
      'Jinn-Autopilot-Runner: runner-a',
      'Jinn-Autopilot-Login: implementer',
      `Jinn-Autopilot-Expected-Head: ${OPEN_HEAD}`,
      'Jinn-Autopilot-Target-Base: next',
      'Jinn-Autopilot-Claimed-At: 2026-07-20T12:00:00.000Z',
      'Jinn-Autopilot-Phase-Complete: true',
    ].join('\n');
    const summary = [
      'Implemented lifecycle recovery.',
      'Jinn-Autopilot-Login: this line is summary content',
      'Preserved exact authority.',
    ].join('\n');
    const message = [
      'Autopilot implementation phase complete',
      '',
      summary,
      '',
      trailers,
    ].join('\n');
    const run: CommandRunner = async (command, args) => {
      const stub = noReviewClaimRefs(command);
      if (stub !== undefined) return stub;
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('closedByPullRequestsReferences')) {
        return JSON.stringify({
          data: {
            rateLimit: rateLimit(),
            repository: {
              issue42: {
                closedByPullRequestsReferences: {
                  pageInfo: { hasNextPage: false },
                  nodes: [],
                },
              },
            },
          },
        });
      }
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [graphQlPr({
                number: 101,
                state: 'OPEN',
                head: OPEN_HEAD,
                message,
              })],
            },
          },
        },
      });
    };

    const page = await new GhLifecycleReader(run).readPullRequests(null, [42]);

    expect(page.nodes[0]?.implementationCompletionSummary).toBe(summary);
  });

  it('uses the workflow run database id for GraphQL check reruns', async () => {
    let openQuery = '';
    const run: CommandRunner = async (command, args) => {
      const stub = noReviewClaimRefs(command);
      if (stub !== undefined) return stub;
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('closedByPullRequestsReferences')) {
        return JSON.stringify({
          data: {
            rateLimit: rateLimit(),
            repository: {
              issue42: {
                closedByPullRequestsReferences: {
                  pageInfo: { hasNextPage: false },
                  nodes: [],
                },
              },
            },
          },
        });
      }
      openQuery = query;
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [graphQlPr({
                number: 101,
                state: 'OPEN',
                head: OPEN_HEAD,
                statusCheckRollup: {
                  contexts: {
                    pageInfo: { hasNextPage: false },
                    nodes: [{
                      __typename: 'CheckRun',
                      name: 'test',
                      status: 'COMPLETED',
                      conclusion: 'FAILURE',
                      databaseId: 999,
                      checkSuite: { workflowRun: { databaseId: 123 } },
                    }],
                  },
                },
              })],
            },
          },
        },
      });
    };

    const page = await new GhLifecycleReader(run).readPullRequests(null, [42]);

    expect(openQuery).toContain('checkSuite { workflowRun { databaseId } }');
    expect(page.nodes[0]?.checks).toEqual([{
      name: 'test',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      source: 'check-run',
      runId: 123,
    }]);
  });

  it('scopes open reads, batches merged outcomes, reads refs only for open PRs, and parses Human evidence', async () => {
    const calls: string[][] = [];
    const humanComment = '<!-- jinn-autopilot-human:v2 issue=42 pr=101 '
      + 'phase=implementing code=implementation-escalation -->\n\n'
      + 'Autopilot parked this item for Human review.\n\nNeeds product judgment';
    const run: CommandRunner = async (command, args) => {
      calls.push(args);
      const stub = noReviewClaimRefs(command);
      if (stub !== undefined) return stub;
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('closedByPullRequestsReferences')) {
        return JSON.stringify({
          data: {
            rateLimit: rateLimit(),
            repository: {
              issue42: {
                closedByPullRequestsReferences: {
                  pageInfo: { hasNextPage: false },
                  nodes: [graphQlPr({
                    number: 99,
                    state: 'MERGED',
                    head: MERGED_HEAD,
                  }), graphQlPr({
                    number: 98,
                    state: 'CLOSED',
                    head: 'cccccccccccccccccccccccccccccccccccccccc',
                  })],
                },
              },
            },
          },
        });
      }
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [graphQlPr({
                number: 101,
                state: 'OPEN',
                head: OPEN_HEAD,
                comments: [humanComment],
              })],
            },
          },
        },
      });
    };
    const reader = new GhLifecycleReader(run);

    const page = await reader.readPullRequests(null, [42]);

    expect(page.nodes.map((pr) => pr.number)).toEqual([101, 99]);
    expect(page.nodes[0]?.humanReason).toEqual({
      phase: 'implementing',
      code: 'implementation-escalation',
      detail: 'Needs product judgment',
    });
    const queries = calls.map((args) => args.find((arg) => arg.startsWith('query=')) ?? '');
    expect(queries[0]).toContain('states: [OPEN]');
    expect(queries[0]).not.toContain('labels: ["engine:review"]');
    const mergedQuery = queries.find((query) => query.includes('closedByPullRequestsReferences'));
    expect(mergedQuery).toContain('issue42: issue(number: 42)');
    expect(mergedQuery).toContain(
      'closedByPullRequestsReferences(first: 100, includeClosedPrs: true)',
    );
    expect(mergedQuery).not.toContain('reviews(');
    expect(mergedQuery).not.toContain('comments(');
    expect(mergedQuery).not.toContain('statusCheckRollup');
    // Replaces the old per-PR GraphQL ref(qualifiedName) query-count assertion:
    // review-claim reads are now one shared git-transport listing per page,
    // not one GraphQL call per PR (jinn-mono#1883-follow-up).
    expect(calls.filter(isReviewClaimListingCall)).toHaveLength(1);
    expect(page.nodes.map((pr) => [pr.number, pr.state])).toEqual([
      [101, 'OPEN'],
      [99, 'MERGED'],
    ]);
  });

  // Issue #62. The CLOSED nodes of this connection were discarded outright, so
  // "closed unmerged", "merged and pruned" and "never existed" all reached the
  // snapshot as absence, and a review follow-up whose parent was closed
  // unmerged was released to implement against a base that never received the
  // parent's code. The connection is queried only for non-Done board issues,
  // costs nothing extra, and survives close-unmerged — so the numbers are
  // collected here rather than discarded, and the resolution predicate is the
  // query itself. MERGED and OPEN nodes keep their existing handling.
  it('reports CLOSED closing-PR nodes as closed-unmerged parents', async () => {
    const run: CommandRunner = async (command, args) => {
      const stub = noReviewClaimRefs(command);
      if (stub !== undefined) return stub;
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('closedByPullRequestsReferences')) {
        return JSON.stringify({
          data: {
            rateLimit: rateLimit(),
            repository: {
              issue42: {
                closedByPullRequestsReferences: {
                  pageInfo: { hasNextPage: false },
                  nodes: [graphQlPr({
                    number: 99,
                    state: 'MERGED',
                    head: MERGED_HEAD,
                  }), graphQlPr({
                    number: 98,
                    state: 'CLOSED',
                    head: 'cccccccccccccccccccccccccccccccccccccccc',
                  })],
                },
              },
              issue43: {
                closedByPullRequestsReferences: {
                  pageInfo: { hasNextPage: false },
                  nodes: [graphQlPr({
                    number: 97,
                    state: 'CLOSED',
                    head: 'dddddddddddddddddddddddddddddddddddddddd',
                  })],
                },
              },
            },
          },
        });
      }
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    };

    const page = await new GhLifecycleReader(run).readPullRequests(null, [42, 43]);

    // Only CLOSED nodes, sorted, and none of them enters the PR node list.
    expect(page.closedUnmergedParentPrs).toEqual([97, 98]);
    expect(page.nodes.map((pr) => [pr.number, pr.state])).toEqual([[99, 'MERGED']]);
  });

  it('reports no closed-unmerged parents when every closing PR merged', async () => {
    const run: CommandRunner = async (command, args) => {
      const stub = noReviewClaimRefs(command);
      if (stub !== undefined) return stub;
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('closedByPullRequestsReferences')) {
        return JSON.stringify({
          data: {
            rateLimit: rateLimit(),
            repository: {
              issue42: {
                closedByPullRequestsReferences: {
                  pageInfo: { hasNextPage: false },
                  nodes: [graphQlPr({
                    number: 99,
                    state: 'MERGED',
                    head: MERGED_HEAD,
                  })],
                },
              },
            },
          },
        });
      }
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    };

    const page = await new GhLifecycleReader(run).readPullRequests(null, [42]);

    expect(page.closedUnmergedParentPrs).toBeUndefined();
    expect(page.nodes.map((pr) => [pr.number, pr.state])).toEqual([[99, 'MERGED']]);
  });

  // Structural, not a filter: a Done issue is never in `nonDoneIssueNumbers`,
  // so the query never asks about it and its parents cannot be reported. That
  // is the whole machine exit for the follow-up hold.
  it('never asks a Done issue for closing PRs, so its parents cannot be reported', async () => {
    const queries: string[] = [];
    const run: CommandRunner = async (command, args) => {
      const stub = noReviewClaimRefs(command);
      if (stub !== undefined) return stub;
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      queries.push(query);
      if (query.includes('closedByPullRequestsReferences')) {
        return JSON.stringify({
          data: {
            rateLimit: rateLimit(),
            repository: {
              issue43: {
                closedByPullRequestsReferences: {
                  pageInfo: { hasNextPage: false },
                  nodes: [],
                },
              },
            },
          },
        });
      }
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    };

    // #42 is Done, so the caller leaves it out of the non-Done list entirely.
    const page = await new GhLifecycleReader(run).readPullRequests(null, [43]);

    const mergedQuery = queries.find((query) => (
      query.includes('closedByPullRequestsReferences')
    ));
    expect(mergedQuery).toContain('issue43: issue(number: 43)');
    expect(mergedQuery).not.toContain('issue42: issue(number: 42)');
    expect(page.closedUnmergedParentPrs).toBeUndefined();
  });

  it('retains exact mapping-comment and current Human label/draft timeline provenance', async () => {
    const generation = '22222222-2222-4222-8222-222222222222';
    const marker = '<!-- jinn-autopilot-human:v2 issue=42 pr=101 '
      + 'phase=implementing code=branch-mapping-ambiguous '
      + `head=${OPEN_HEAD} generation=${generation} -->`;
    const reader = new GhLifecycleReader(async (command, args) => {
      const stub = noReviewClaimRefs(command);
      if (stub !== undefined) return stub;
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('closedByPullRequestsReferences')) {
        return JSON.stringify({
          data: {
            rateLimit: rateLimit(),
            repository: {},
          },
        });
      }
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [graphQlPr({
                number: 101,
                state: 'OPEN',
                head: OPEN_HEAD,
                labels: ['engine:review', 'review:needs-human'],
                comments: [`${marker}\n\nMapping was ambiguous.`],
                commentAuthor: 'maintenance-bot',
                timelineItems: [{
                  __typename: 'LabeledEvent',
                  actor: { login: 'maintenance-bot' },
                  createdAt: '2026-07-20T09:10:00.000Z',
                  label: { name: 'review:needs-human' },
                }, {
                  __typename: 'ConvertToDraftEvent',
                  actor: { login: 'maintenance-bot' },
                  createdAt: '2026-07-20T09:11:00.000Z',
                }],
              })],
            },
          },
        },
      });
    });

    await expect(reader.readPullRequests(null)).resolves.toMatchObject({
      nodes: [{
        humanAuthor: 'maintenance-bot',
        humanHead: OPEN_HEAD,
        humanGeneration: generation,
        humanLabelActor: 'maintenance-bot',
        draftActor: 'maintenance-bot',
      }],
    });
  });

  it('paginates adopted-branch ancestry until it finds the latest v2 marker', async () => {
    const calls: string[][] = [];
    const claimMessage = [
      'claim',
      '',
      'Jinn-Autopilot-Protocol: 2',
      'Jinn-Autopilot-Phase: implement',
      'Jinn-Autopilot-Issue: 42',
      'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
      'Jinn-Autopilot-Runner: runner-a',
      'Jinn-Autopilot-Login: trusted',
      `Jinn-Autopilot-Expected-Head: ${MERGED_HEAD}`,
      'Jinn-Autopilot-Target-Base: next',
      'Jinn-Autopilot-Claimed-At: 2026-07-20T08:00:00.000Z',
    ].join('\n');
    const historyPage = (page: number) => Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => ({
      sha: page === 1 && index === 0 ? OPEN_HEAD : `${page}${String(index).padStart(39, '0')}`,
      commit: {
        message: page === 2 ? claimMessage : `checkpoint ${index}`,
        committer: { date: '2026-07-20T09:00:00.000Z' },
      },
    }));
    const run: CommandRunner = async (command, args) => {
      calls.push(args);
      const stub = noReviewClaimRefs(command);
      if (stub !== undefined) return stub;
      if (args[1]?.includes('/commits?')) {
        const page = args[1].includes('page=2') ? 2 : 1;
        return JSON.stringify(historyPage(page));
      }
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [graphQlPr({
                number: 101,
                state: 'OPEN',
                head: OPEN_HEAD,
                headRefName: 'feature/adopted-42',
                historyTruncated: true,
              })],
            },
          },
        },
      });
    };

    const page = await new GhLifecycleReader(run).readPullRequests(null);

    expect(page.nodes[0]?.branchClaimTrailers).toContain('Jinn-Autopilot-Protocol: 2');
    expect(calls.some((args) => args[1]?.includes('page=2'))).toBe(true);
  });

  it('paginates stable-branch ancestry after checkpoint commits', async () => {
    const calls: string[][] = [];
    const claimMessage = [
      'claim',
      '',
      'Jinn-Autopilot-Protocol: 2',
      'Jinn-Autopilot-Phase: implement',
      'Jinn-Autopilot-Issue: 42',
      'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
      'Jinn-Autopilot-Runner: runner-a',
      'Jinn-Autopilot-Login: trusted',
      `Jinn-Autopilot-Expected-Head: ${MERGED_HEAD}`,
      'Jinn-Autopilot-Target-Base: next',
      'Jinn-Autopilot-Claimed-At: 2026-07-20T08:00:00.000Z',
    ].join('\n');
    const run: CommandRunner = async (_command, args) => {
      calls.push(args);
      if (args[1]?.includes('matching-refs')) {
        return JSON.stringify([{
          ref: 'refs/heads/autopilot/42',
          object: { sha: OPEN_HEAD },
        }]);
      }
      if (args[1]?.includes('/commits?')) {
        const second = args[1].includes('page=2');
        return JSON.stringify(Array.from({ length: second ? 1 : 100 }, (_, index) => ({
          sha: !second && index === 0 ? OPEN_HEAD : `${second ? 2 : 1}${String(index).padStart(39, '0')}`,
          commit: {
            message: second ? claimMessage : `checkpoint ${index}`,
            committer: { date: '2026-07-20T09:00:00.000Z' },
          },
        })));
      }
      throw new Error(`Unexpected call: ${args.join(' ')}`);
    };

    const claims = await new GhLifecycleReader(run).readBranchClaims();

    expect(claims).toHaveLength(1);
    expect(claims[0]?.claimTrailers).toContain('Jinn-Autopilot-Protocol: 2');
    expect(calls.some((args) => args[1]?.includes('page=2'))).toBe(true);
  });

  it('rereads one exact stable-branch claim for reconciliation', async () => {
    const claimMessage = [
      'claim',
      '',
      'Jinn-Autopilot-Protocol: 2',
      'Jinn-Autopilot-Phase: implement',
      'Jinn-Autopilot-Issue: 42',
      'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
      'Jinn-Autopilot-Runner: runner-a',
      'Jinn-Autopilot-Login: trusted',
      `Jinn-Autopilot-Expected-Head: ${OPEN_HEAD}`,
      'Jinn-Autopilot-Target-Base: next',
      'Jinn-Autopilot-Claimed-At: 2026-07-20T08:00:00.000Z',
    ].join('\n');
    const run: CommandRunner = async (command, args) => {
      if (command === 'git') {
        expect(args.slice(-3)).toEqual([
          'ls-remote',
          'https://github.com/Jinn-Network/mono.git',
          'refs/heads/autopilot/42',
        ]);
        return `${OPEN_HEAD}\trefs/heads/autopilot/42\n`;
      }
      if (args[1]?.includes('/commits?')) {
        return JSON.stringify([{
          sha: OPEN_HEAD,
          commit: {
            message: claimMessage,
            committer: { date: '2026-07-20T09:00:00.000Z' },
          },
        }]);
      }
      throw new Error(`Unexpected call: ${args.join(' ')}`);
    };

    await expect(
      new GhLifecycleReader(run).readBranchClaimForReconciliation('autopilot/42'),
    ).resolves.toMatchObject({
      issueNumber: 42,
      headRefName: 'autopilot/42',
      headOid: OPEN_HEAD,
      claimTrailers: expect.stringContaining('Jinn-Autopilot-Target-Base: next'),
    });
  });

  it('discovers incremental Autopilot branch claims through git transport', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const claimMessage = [
      'claim',
      '',
      'Jinn-Autopilot-Protocol: 2',
      'Jinn-Autopilot-Phase: implement',
      'Jinn-Autopilot-Issue: 42',
      'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
      'Jinn-Autopilot-Runner: runner-a',
      'Jinn-Autopilot-Login: trusted',
      `Jinn-Autopilot-Expected-Head: ${MERGED_HEAD}`,
      'Jinn-Autopilot-Target-Base: next',
      'Jinn-Autopilot-Claimed-At: 2026-07-20T08:00:00.000Z',
    ].join('\n');
    const run: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === 'git') {
        expect(args[2]).toBe('ls-remote');
        expect(args[4]).toBe(AUTOPILOT_BRANCH_GLOB);
        return `${OPEN_HEAD}\trefs/heads/autopilot/42\n`;
      }
      if (args[1]?.includes('/commits?')) {
        return JSON.stringify([{
          sha: OPEN_HEAD,
          commit: {
            message: claimMessage,
            committer: { date: '2026-07-20T09:00:00.000Z' },
          },
        }]);
      }
      throw new Error(`Unexpected call: ${args.join(' ')}`);
    };

    const claims = await new GhLifecycleReader(run).readIncrementalBranchClaims();

    expect(claims).toEqual([
      expect.objectContaining({ issueNumber: 42, headOid: OPEN_HEAD }),
    ]);
    expect(calls.some(({ args }) => args[1]?.includes('matching-refs'))).toBe(false);
  });

  it('ignores well-formed nonnumeric and nested refs around numeric incremental claims', async () => {
    const ignoredOne = 'cccccccccccccccccccccccccccccccccccccccc';
    const ignoredTwo = 'dddddddddddddddddddddddddddddddddddddddd';
    const claimMessage = (issueNumber: number) => [
      'claim',
      '',
      'Jinn-Autopilot-Protocol: 2',
      'Jinn-Autopilot-Phase: implement',
      `Jinn-Autopilot-Issue: ${issueNumber}`,
      'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
      'Jinn-Autopilot-Runner: runner-a',
      'Jinn-Autopilot-Login: trusted',
      `Jinn-Autopilot-Expected-Head: ${MERGED_HEAD}`,
      'Jinn-Autopilot-Target-Base: next',
      'Jinn-Autopilot-Claimed-At: 2026-07-20T08:00:00.000Z',
    ].join('\n');
    const run: CommandRunner = async (command, args) => {
      if (command === 'git') {
        return [
          `${ignoredOne}\trefs/heads/autopilot/capability-probe`,
          `${OPEN_HEAD}\trefs/heads/autopilot/42`,
          `${ignoredTwo}\trefs/heads/autopilot/temporary/nested`,
          `${MERGED_HEAD}\trefs/heads/autopilot/43`,
          '',
        ].join('\n');
      }
      if (args[1]?.includes('/commits?')) {
        const issueNumber = args[1].includes(OPEN_HEAD) ? 42 : 43;
        const head = issueNumber === 42 ? OPEN_HEAD : MERGED_HEAD;
        return JSON.stringify([{
          sha: head,
          commit: {
            message: claimMessage(issueNumber),
            committer: { date: '2026-07-20T09:00:00.000Z' },
          },
        }]);
      }
      throw new Error(`Unexpected call: ${args.join(' ')}`);
    };

    await expect(new GhLifecycleReader(run).readIncrementalBranchClaims()).resolves.toEqual([
      expect.objectContaining({ issueNumber: 42, headOid: OPEN_HEAD }),
      expect.objectContaining({ issueNumber: 43, headOid: MERGED_HEAD }),
    ]);
  });

  it.each([
    ['a missing tab', `${OPEN_HEAD} refs/heads/autopilot/42\n`],
    ['an extra tab', `${OPEN_HEAD}\trefs/heads/autopilot/42\textra\n`],
    ['a trailing empty tab field', `${OPEN_HEAD}\trefs/heads/autopilot/42\t\n`],
    ['a trailing space in the ref', `${OPEN_HEAD}\trefs/heads/autopilot/42 \n`],
    ['a whitespace-only line', ' \n'],
    ['a non-head ref', `${OPEN_HEAD}\trefs/tags/autopilot/42\n`],
    ['a ref outside the requested prefix', `${OPEN_HEAD}\trefs/heads/not-autopilot/42\n`],
    ['a control character', `${OPEN_HEAD}\trefs/heads/autopilot/bad\u0001ref\n`],
    ['an invalid OID', `not-an-oid\trefs/heads/autopilot/42\n`],
    [
      'a numeric issue outside the safe integer range',
      `${OPEN_HEAD}\trefs/heads/autopilot/99999999999999999999\n`,
    ],
  ])('fails closed when an incremental branch listing contains %s', async (_label, listing) => {
    const reader = new GhLifecycleReader(async (command) => (
      command === 'git' ? listing : '[]'
    ));

    await expect(reader.readIncrementalBranchClaims())
      .rejects.toThrow(/branch ref listing|Git OID|Git ref/i);
  });

  it('fails closed on duplicate numeric incremental branch refs', async () => {
    const reader = new GhLifecycleReader(async (command) => (
      command === 'git'
        ? `${OPEN_HEAD}\trefs/heads/autopilot/42\n${MERGED_HEAD}\trefs/heads/autopilot/42\n`
        : '[]'
    ));

    await expect(reader.readIncrementalBranchClaims()).rejects.toThrow(/branch ref listing/i);
  });

  it('retries a transient ancestry read failure on the next cycle', async () => {
    let ancestryAttempts = 0;
    const claimMessage = [
      'claim',
      '',
      'Jinn-Autopilot-Protocol: 2',
      'Jinn-Autopilot-Phase: implement',
      'Jinn-Autopilot-Issue: 42',
      'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
      'Jinn-Autopilot-Runner: runner-a',
      'Jinn-Autopilot-Login: trusted',
      `Jinn-Autopilot-Expected-Head: ${MERGED_HEAD}`,
      'Jinn-Autopilot-Target-Base: next',
      'Jinn-Autopilot-Claimed-At: 2026-07-20T08:00:00.000Z',
    ].join('\n');
    const run: CommandRunner = async (_command, args) => {
      if (args[1]?.includes('matching-refs')) {
        return JSON.stringify([{
          ref: 'refs/heads/autopilot/42',
          object: { sha: OPEN_HEAD },
        }]);
      }
      if (args[1]?.includes('/commits?')) {
        ancestryAttempts += 1;
        if (ancestryAttempts === 1) throw new Error('transient GitHub read failure');
        return JSON.stringify([{
          sha: OPEN_HEAD,
          commit: {
            message: claimMessage,
            committer: { date: '2026-07-20T09:00:00.000Z' },
          },
        }]);
      }
      throw new Error(`Unexpected call: ${args.join(' ')}`);
    };
    const reader = new GhLifecycleReader(run);

    await expect(reader.readBranchClaims()).rejects.toThrow(/transient/);
    await expect(reader.readBranchClaims()).resolves.toHaveLength(1);
  });

  it('rediscovers an adopted v2 PR whose engine:review projection is missing', async () => {
    const claimMessage = [
      'claim',
      '',
      'Jinn-Autopilot-Protocol: 2',
      'Jinn-Autopilot-Phase: implement',
      'Jinn-Autopilot-Issue: 42',
      'Jinn-Autopilot-PR: 101',
      'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
      'Jinn-Autopilot-Runner: runner-a',
      'Jinn-Autopilot-Login: trusted',
      `Jinn-Autopilot-Expected-Head: ${MERGED_HEAD}`,
      'Jinn-Autopilot-Target-Base: next',
      'Jinn-Autopilot-Claimed-At: 2026-07-20T08:00:00.000Z',
    ].join('\n');
    const adopted = graphQlPr({
      number: 101,
      state: 'OPEN',
      head: OPEN_HEAD,
      headRefName: 'feature/adopted-42',
      labels: [],
      message: claimMessage,
    });
    const run: CommandRunner = async (command, args) => {
      const stub = noReviewClaimRefs(command);
      if (stub !== undefined) return stub;
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('closedByPullRequestsReferences')) {
        return JSON.stringify({
          data: {
            rateLimit: rateLimit(),
            repository: {
              issue42: {
                closedByPullRequestsReferences: {
                  pageInfo: { hasNextPage: false },
                  nodes: [adopted],
                },
              },
            },
          },
        });
      }
      if (query.includes('pullRequest(number:')) {
        return JSON.stringify({
          data: { rateLimit: rateLimit(), repository: { pullRequest: adopted } },
        });
      }
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    };

    const page = await new GhLifecycleReader(run).readPullRequests(null, [42]);

    expect(page.nodes).toEqual([
      expect.objectContaining({
        number: 101,
        headRefName: 'feature/adopted-42',
        labels: [],
        branchClaimTrailers: expect.stringContaining('Jinn-Autopilot-Issue: 42'),
      }),
    ]);
  });

  it('ignores a foreign protocol marker before the candidate branch claim', async () => {
    const messageForIssue = (issueNumber: number) => [
      'claim',
      '',
      'Jinn-Autopilot-Protocol: 2',
      'Jinn-Autopilot-Phase: implement',
      `Jinn-Autopilot-Issue: ${issueNumber}`,
      'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
      'Jinn-Autopilot-Runner: runner-a',
      'Jinn-Autopilot-Login: trusted',
      `Jinn-Autopilot-Expected-Head: ${MERGED_HEAD}`,
      'Jinn-Autopilot-Target-Base: next',
      'Jinn-Autopilot-Claimed-At: 2026-07-20T08:00:00.000Z',
    ].join('\n');
    const run: CommandRunner = async (_command, args) => {
      if (args[1]?.includes('matching-refs')) {
        return JSON.stringify([{
          ref: 'refs/heads/autopilot/42',
          object: { sha: OPEN_HEAD },
        }]);
      }
      if (args[1]?.includes('/commits?')) {
        return JSON.stringify([
          {
            sha: OPEN_HEAD,
            commit: {
              message: messageForIssue(99),
              committer: { date: '2026-07-20T09:00:00.000Z' },
            },
          },
          {
            sha: MERGED_HEAD,
            commit: {
              message: messageForIssue(42),
              committer: { date: '2026-07-20T08:00:00.000Z' },
            },
          },
        ]);
      }
      throw new Error(`Unexpected call: ${args.join(' ')}`);
    };

    const claims = await new GhLifecycleReader(run).readBranchClaims();

    expect(claims[0]?.claimTrailers).toContain('Jinn-Autopilot-Issue: 42');
    expect(claims[0]?.claimTrailers).not.toContain('Jinn-Autopilot-Issue: 99');
  });

  function pageOf(...nodes: ReturnType<typeof graphQlPr>[]): CommandRunner {
    return async (command) => {
      const stub = noReviewClaimRefs(command);
      if (stub !== undefined) return stub;
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes,
            },
          },
        },
      });
    };
  }

  it('marks incomplete non-comment PR evidence explicitly without synthesizing Human', async () => {
    const incomplete = graphQlPr({
      number: 200,
      state: 'OPEN',
      head: 'b'.repeat(40),
      headRefName: 'feature/200',
    });
    incomplete.reviews.pageInfo.hasNextPage = true;

    const page = await new GhLifecycleReader(pageOf(incomplete)).readPullRequests(null);

    expect(page.nodes[0]).toMatchObject({
      number: 200,
      evidenceIncompleteReason: expect.stringMatching(/reviews.*truncated/i),
      humanReason: null,
    });
  });

  it('does not retain a partial closing-issue mapping when that evidence is truncated', async () => {
    const incomplete = graphQlPr({
      number: 203,
      state: 'OPEN',
      head: 'e'.repeat(40),
      headRefName: 'feature/shared-closure',
    });
    incomplete.closingIssuesReferences.nodes = [{ number: 42 }];
    incomplete.closingIssuesReferences.pageInfo.hasNextPage = true;

    const page = await new GhLifecycleReader(pageOf(incomplete)).readPullRequests(null);

    expect(page.nodes[0]).toMatchObject({
      number: 203,
      closingIssueNumbers: [],
      closingIssueNumbersIncomplete: true,
      evidenceIncompleteReason:
        expect.stringMatching(/closing issue references.*truncated/i),
      humanReason: null,
    });
  });

  function checkContextNode(name: string) {
    return {
      __typename: 'CheckRun' as const,
      name,
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      databaseId: 900,
      checkSuite: { workflowRun: { databaseId: 123 } },
    };
  }

  /**
   * One open PR whose check-context connection is served across `pages`
   * pages of a single context each — the shape mono PR #2918 produces live
   * (a dependabot bump that touches the workflows, fanning out to 144 check
   * contexts behind GitHub's 100-node page cap). Records every follow-up
   * context read's argv so the tests can assert the query is scoped to the
   * one PR and carries the previous page's cursor.
   */
  function checkContextPages(
    prNumber: number,
    head: string,
    pages: number,
  ): { run: CommandRunner; followUps: string[][] } {
    const followUps: string[][] = [];
    const pageInfoFor = (index: number) => ({
      hasNextPage: index < pages - 1,
      endCursor: `cursor-${index}`,
    });
    const run: CommandRunner = async (command, args) => {
      const stub = noReviewClaimRefs(command);
      if (stub !== undefined) return stub;
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('contexts(first: 100, after: $cursor)')) {
        followUps.push(args);
        const cursor = args.find((arg) => arg.startsWith('cursor='))?.slice(7) ?? '';
        const index = Number(cursor.slice('cursor-'.length)) + 1;
        return JSON.stringify({
          data: {
            rateLimit: rateLimit(),
            repository: {
              pullRequest: {
                statusCheckRollup: {
                  contexts: {
                    pageInfo: pageInfoFor(index),
                    nodes: [checkContextNode(`check-${index}`)],
                  },
                },
              },
            },
          },
        });
      }
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [graphQlPr({
                number: prNumber,
                state: 'OPEN',
                head,
                statusCheckRollup: {
                  contexts: {
                    pageInfo: pageInfoFor(0),
                    nodes: [checkContextNode('check-0')],
                  },
                },
              })],
            },
          },
        },
      });
    };
    return { run, followUps };
  }

  it('paginates a PR check-context connection past the first 100-node page', async () => {
    const { run, followUps } = checkContextPages(101, OPEN_HEAD, 3);

    const page = await new GhLifecycleReader(run).readPullRequests(null);

    expect(page.nodes[0]?.evidenceIncompleteReason).toBeUndefined();
    expect(page.nodes[0]?.checks.map((check) => check.name))
      .toEqual(['check-0', 'check-1', 'check-2']);
    expect(followUps).toHaveLength(2);
    expect(followUps[0]).toContain('number=101');
    expect(followUps[0]).toContain('cursor=cursor-0');
    expect(followUps[1]).toContain('cursor=cursor-1');
    expect(followUps[0]?.find((arg) => arg.startsWith('query=')))
      .toContain('pullRequest(number: $number)');
  });

  it('issues no follow-up context read when the first check-context page is complete', async () => {
    const { run, followUps } = checkContextPages(103, 'f'.repeat(40), 1);

    const page = await new GhLifecycleReader(run).readPullRequests(null);

    expect(followUps).toEqual([]);
    expect(page.nodes[0]?.evidenceIncompleteReason).toBeUndefined();
    expect(page.nodes[0]?.checks.map((check) => check.name)).toEqual(['check-0']);
  });

  it('fails closed when a PR check-context connection outruns the pagination cap', async () => {
    const { run, followUps } = checkContextPages(102, 'd'.repeat(40), 40);

    const page = await new GhLifecycleReader(run).readPullRequests(null);

    expect(followUps).toHaveLength(9);
    expect(page.nodes[0]).toMatchObject({
      number: 102,
      checks: [],
      evidenceIncompleteReason: expect.stringMatching(/checks.*truncated/i),
    });
  });

  it('does not synthesize Human authority from an undecodable audit comment', async () => {
    const hostile = graphQlPr({
      number: 201,
      state: 'OPEN',
      head: 'c'.repeat(40),
      headRefName: 'feature/201',
      comments: [
        '<!-- jinn-autopilot-human:v2 pr=201 phase=awaiting-review code=review-escalation -->\n\n',
      ],
    });
    const healthy = graphQlPr({
      number: 202,
      state: 'OPEN',
      head: 'd'.repeat(40),
      headRefName: 'feature/202',
    });

    const page = await new GhLifecycleReader(pageOf(hostile, healthy)).readPullRequests(null);

    expect(page.nodes.map((pr) => pr.number)).toEqual([201, 202]);
    const degraded = page.nodes[0];
    expect(degraded?.humanReason).toBeNull();
    expect(degraded?.reviewClaim).toBeNull();
    expect(page.nodes[1]?.humanReason).toBeNull();
  });

  it('treats unstructured maintainer prose as lifecycle-inert audit text', async () => {
    const held = graphQlPr({
      number: 205,
      state: 'OPEN',
      head: 'a'.repeat(40),
      headRefName: 'feature/205',
      comments: ['Please do not merge this PR until I investigate.'],
      commentAuthor: 'maintainer',
    });

    const page = await new GhLifecycleReader(pageOf(held)).readPullRequests(null);

    expect(page.nodes[0]?.humanAuthor).toBeNull();
    expect(page.nodes[0]?.humanIssueNumber).toBeNull();
    expect(page.nodes[0]?.humanHead).toBeNull();
    expect(page.nodes[0]?.humanGeneration).toBeNull();
    expect(page.nodes[0]?.humanReason).toBeNull();
  });

  it('does not synthesize Human authority from a contradictory audit comment', async () => {
    const hostile = graphQlPr({
      number: 203,
      state: 'OPEN',
      head: 'e'.repeat(40),
      headRefName: 'feature/203',
      comments: [
        '<!-- jinn-autopilot-human:v2 pr=999 phase=awaiting-review code=review-escalation -->'
        + '\n\nA real detail sentence.',
      ],
    });
    const healthy = graphQlPr({
      number: 204,
      state: 'OPEN',
      head: 'f'.repeat(40),
      headRefName: 'feature/204',
    });

    const page = await new GhLifecycleReader(pageOf(hostile, healthy)).readPullRequests(null);

    expect(page.nodes.map((pr) => pr.number)).toEqual([203, 204]);
    expect(page.nodes[0]?.humanReason).toBeNull();
    expect(page.nodes[1]?.humanReason).toBeNull();
  });

  it('treats truncated comments as unavailable audit, not Human authority', async () => {
    const hostile = graphQlPr({
      number: 205,
      state: 'OPEN',
      head: '1'.repeat(40),
      headRefName: 'feature/205',
      commentsTruncated: true,
    });
    const healthy = graphQlPr({
      number: 206,
      state: 'OPEN',
      head: '2'.repeat(40),
      headRefName: 'feature/206',
    });

    const page = await new GhLifecycleReader(pageOf(hostile, healthy)).readPullRequests(null);

    expect(page.nodes.map((pr) => pr.number)).toEqual([205, 206]);
    expect(page.nodes[0]?.humanReason).toBeNull();
    expect(page.nodes[1]?.humanReason).toBeNull();
  });

  it('still fails the whole page on errors unrelated to per-PR evidence decoding', async () => {
    const run: CommandRunner = async (command) => {
      if (command === 'git') throw new Error('transient GitHub network failure');
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [graphQlPr({ number: 301, state: 'OPEN', head: '3'.repeat(40) })],
            },
          },
        },
      });
    };

    await expect(new GhLifecycleReader(run).readPullRequests(null))
      .rejects.toThrow(/transient GitHub network failure/);
  });

  function mergedOutcomesRun(
    nodes: ReturnType<typeof graphQlPr>[],
    issueConnectionHasNextPage = false,
  ): CommandRunner {
    return async (command, args) => {
      const stub = noReviewClaimRefs(command);
      if (stub !== undefined) return stub;
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('closedByPullRequestsReferences')) {
        return JSON.stringify({
          data: {
            rateLimit: rateLimit(),
            repository: {
              issue42: {
                closedByPullRequestsReferences: {
                  pageInfo: { hasNextPage: issueConnectionHasNextPage },
                  nodes,
                },
              },
            },
          },
        });
      }
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    };
  }

  it('skips a merged PR whose branch was garbage-collected post-merge (PR #1710) instead of failing the snapshot', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Mirrors the real PR #1710: MERGED, mergeCommit null, and commits(last:1)
    // no longer matches headRefOid because the branch was deleted after merge.
    const survivingCommitOid = 'c'.repeat(40);
    const staleHeadRefOid = 'd'.repeat(40);
    const goneBranch = {
      ...graphQlPr({
        number: 1710,
        state: 'MERGED',
        head: survivingCommitOid,
        closingIssueNumber: 42,
      }),
      headRefOid: staleHeadRefOid,
      mergeCommit: null,
    };
    const healthy = graphQlPr({
      number: 99,
      state: 'MERGED',
      head: MERGED_HEAD,
      closingIssueNumber: 42,
    });

    const page = await new GhLifecycleReader(mergedOutcomesRun([goneBranch, healthy]))
      .readPullRequests(null, [42]);

    expect(page.nodes.map((pr) => pr.number)).toEqual([99]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('skipping merged PR #1710 evidence'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('missing its exact merged head commit'),
    );
    warnSpy.mockRestore();
  });

  it('skips a merged PR whose labels were truncated instead of failing the snapshot', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const truncated = {
      ...graphQlPr({
        number: 1712,
        state: 'MERGED',
        head: 'e'.repeat(40),
        closingIssueNumber: 42,
      }),
      labels: { pageInfo: { hasNextPage: true }, nodes: [] },
    };
    const healthy = graphQlPr({
      number: 99,
      state: 'MERGED',
      head: MERGED_HEAD,
      closingIssueNumber: 42,
    });

    const page = await new GhLifecycleReader(mergedOutcomesRun([truncated, healthy]))
      .readPullRequests(null, [42]);

    expect(page.nodes.map((pr) => pr.number)).toEqual([99]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('labels were truncated'));
    warnSpy.mockRestore();
  });

  it('propagates global incompleteness when merged PR closure evidence is truncated', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const truncated = {
      ...graphQlPr({
        number: 1713,
        state: 'MERGED',
        head: 'f'.repeat(40),
        closingIssueNumber: 42,
      }),
      closingIssuesReferences: { pageInfo: { hasNextPage: true }, nodes: [] },
    };
    const healthy = graphQlPr({
      number: 99,
      state: 'MERGED',
      head: MERGED_HEAD,
      closingIssueNumber: 42,
    });

    const page = await new GhLifecycleReader(mergedOutcomesRun([truncated, healthy]))
      .readPullRequests(null, [42]);

    expect(page.nodes.map((pr) => pr.number)).toEqual([99]);
    expect(page.closingIssueEvidenceIncomplete).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('closing issue references were truncated'),
    );
    warnSpy.mockRestore();
  });

  it('propagates global incompleteness when an issue closed-by PR page is truncated', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const page = await new GhLifecycleReader(mergedOutcomesRun([], true))
      .readPullRequests(null, [42]);

    expect(page.nodes).toEqual([]);
    expect(page.closingIssueEvidenceIncomplete).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('closing PR outcomes were truncated'),
    );
    warnSpy.mockRestore();
  });

  it('still fails the whole page on a network failure reading merged outcomes', async () => {
    const run: CommandRunner = async (command, args) => {
      const stub = noReviewClaimRefs(command);
      if (stub !== undefined) return stub;
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('closedByPullRequestsReferences')) {
        throw new Error('transient GitHub network failure');
      }
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    };

    await expect(new GhLifecycleReader(run).readPullRequests(null, [42]))
      .rejects.toThrow(/transient GitHub network failure/);
  });

  it('does not swallow a non-evidence error while decoding a single merged PR', async () => {
    // A malformed node (missing `labels` entirely) is a genuinely different
    // failure than the per-PR evidence-trust conditions the catch targets —
    // it must still fail the whole read, proving the catch isn't overbroad.
    const malformed = {
      ...graphQlPr({
        number: 1714,
        state: 'MERGED',
        head: MERGED_HEAD,
        closingIssueNumber: 42,
      }),
      labels: undefined,
    } as unknown as ReturnType<typeof graphQlPr>;

    await expect(
      new GhLifecycleReader(mergedOutcomesRun([malformed])).readPullRequests(null, [42]),
    ).rejects.toBeInstanceOf(TypeError);
  });

  describe('review-claim git transport', () => {
    function openPrPage(...nodes: ReturnType<typeof graphQlPr>[]): string {
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes,
            },
          },
        },
      });
    }

    it('resolves a review claim via ls-remote + cat-file, returning the same shape as before', async () => {
      const oid = 'c'.repeat(40);
      const payload = '{"protocolVersion":2}';
      const ref = 'refs/jinn-autopilot/review-claims/v1/101';
      const gitCalls: string[][] = [];
      const run: CommandRunner = async (command, args) => {
        if (command !== 'git') {
          return openPrPage(graphQlPr({ number: 101, state: 'OPEN', head: OPEN_HEAD }));
        }
        const rest = args.slice(2);
        gitCalls.push(rest);
        if (rest[0] === 'ls-remote' && rest[2] === REVIEW_CLAIM_GLOB) return `${oid}\t${ref}\n`;
        if (rest[0] === 'ls-remote' && rest[2] === CI_RERUN_REF_GLOB) return '';
        if (rest[0] === 'cat-file' && rest[1] === '-e') return ''; // object already present locally
        if (rest[0] === 'cat-file' && rest[1] === '-p') return payload;
        throw new Error(`unexpected git call: ${rest.join(' ')}`);
      };

      const page = await new GhLifecycleReader(run).readPullRequests(null);

      expect(page.nodes[0]?.reviewClaim).toEqual({ oid, payload });
      // Objects already present locally (this scenario) never trigger a fetch.
      expect(gitCalls.some((call) => call[0] === 'fetch')).toBe(false);
    });

    it('caches a review-claim payload by OID: no fetch on a repeated OID, one fetch per changed OID', async () => {
      const oidX = 'd'.repeat(40);
      const oidY = 'e'.repeat(40);
      const ref = 'refs/jinn-autopilot/review-claims/v1/101';
      let currentOid = oidX;
      const localObjects = new Set<string>();
      const fetchCalls: string[][] = [];
      const run: CommandRunner = async (command, args) => {
        if (command !== 'git') {
          return openPrPage(graphQlPr({ number: 101, state: 'OPEN', head: OPEN_HEAD }));
        }
        const rest = args.slice(2);
        if (rest[0] === 'ls-remote' && rest[2] === REVIEW_CLAIM_GLOB) {
          return `${currentOid}\t${ref}\n`;
        }
        if (rest[0] === 'ls-remote' && rest[2] === CI_RERUN_REF_GLOB) return '';
        if (rest[0] === 'cat-file' && rest[1] === '-e') {
          if (localObjects.has(rest[2] ?? '')) return '';
          throw new Error('object not found locally');
        }
        if (rest[0] === 'fetch') {
          fetchCalls.push(rest);
          localObjects.add(currentOid);
          return '';
        }
        if (rest[0] === 'cat-file' && rest[1] === '-p') {
          const [payloadOid] = (rest[2] ?? '').split(':');
          return `{"oid":"${payloadOid}"}`;
        }
        throw new Error(`unexpected git call: ${rest.join(' ')}`);
      };
      const reader = new GhLifecycleReader(run);

      const first = await reader.readPullRequests(null);
      expect(fetchCalls).toHaveLength(1);
      expect(first.nodes[0]?.reviewClaim?.oid).toBe(oidX);

      const second = await reader.readPullRequests(null);
      expect(fetchCalls).toHaveLength(1);
      expect(second.nodes[0]?.reviewClaim?.oid).toBe(oidX);

      currentOid = oidY;
      const third = await reader.readPullRequests(null);
      expect(fetchCalls).toHaveLength(2);
      expect(third.nodes[0]?.reviewClaim?.oid).toBe(oidY);
    });

    it('serializes review-claim cache-miss fetches into one Git checkout', async () => {
      const oid101 = 'd'.repeat(40);
      const oid102 = 'e'.repeat(40);
      const ref101 = 'refs/jinn-autopilot/review-claims/v1/101';
      const ref102 = 'refs/jinn-autopilot/review-claims/v1/102';
      const oidByRef = new Map([
        [ref101, oid101],
        [ref102, oid102],
      ]);
      const localObjects = new Set<string>();
      let inFlightFetches = 0;
      let maximumInFlightFetches = 0;
      const run: CommandRunner = async (command, args) => {
        if (command !== 'git') {
          return openPrPage(
            graphQlPr({
              number: 101,
              state: 'OPEN',
              head: '1'.repeat(40),
              headRefName: 'feature/101',
            }),
            graphQlPr({
              number: 102,
              state: 'OPEN',
              head: '2'.repeat(40),
              headRefName: 'feature/102',
            }),
          );
        }
        const rest = args.slice(2);
        if (rest[0] === 'ls-remote' && rest[2] === REVIEW_CLAIM_GLOB) {
          return `${oid101}\t${ref101}\n${oid102}\t${ref102}\n`;
        }
        if (rest[0] === 'ls-remote' && rest[2] === CI_RERUN_REF_GLOB) return '';
        if (rest[0] === 'cat-file' && rest[1] === '-e') {
          if (localObjects.has(rest[2] ?? '')) return '';
          throw new Error('object not found locally');
        }
        if (rest[0] === 'fetch') {
          inFlightFetches += 1;
          maximumInFlightFetches = Math.max(maximumInFlightFetches, inFlightFetches);
          await new Promise<void>((resolve) => setImmediate(resolve));
          const oid = oidByRef.get(rest.at(-1) ?? '');
          if (oid === undefined) throw new Error('unexpected review-claim ref');
          localObjects.add(oid);
          inFlightFetches -= 1;
          return '';
        }
        if (rest[0] === 'cat-file' && rest[1] === '-p') {
          return '{"protocolVersion":2}';
        }
        throw new Error(`unexpected git call: ${rest.join(' ')}`);
      };

      const page = await new GhLifecycleReader(run).readPullRequests(null);

      expect(page.nodes).toHaveLength(2);
      expect(maximumInFlightFetches).toBe(1);
    });

    it('resolves an absent review claim to null from empty ls-remote output', async () => {
      const run: CommandRunner = async (command) => {
        if (command === 'git') return '';
        return openPrPage(graphQlPr({ number: 101, state: 'OPEN', head: OPEN_HEAD }));
      };

      const page = await new GhLifecycleReader(run).readPullRequests(null);

      expect(page.nodes[0]?.reviewClaim).toBeNull();
    });

    it('fails loud on malformed git ls-remote output for review-claim refs', async () => {
      const run: CommandRunner = async (command) => {
        if (command === 'git') return 'not-a-valid-tab-separated-line\n';
        return openPrPage(graphQlPr({ number: 101, state: 'OPEN', head: OPEN_HEAD }));
      };

      await expect(new GhLifecycleReader(run).readPullRequests(null))
        .rejects.toThrow(/Malformed git ls-remote output/);
    });

    it('performs exactly one review-claim ls-remote listing for a snapshot with several PRs', async () => {
      const listingCalls: string[][] = [];
      const run: CommandRunner = async (command, args) => {
        if (command === 'git') {
          const rest = args.slice(2);
          if (rest[0] === 'ls-remote' && rest[2] === REVIEW_CLAIM_GLOB) listingCalls.push(rest);
          return '';
        }
        return openPrPage(
          graphQlPr({ number: 101, state: 'OPEN', head: '1'.repeat(40), headRefName: 'feature/101' }),
          graphQlPr({ number: 102, state: 'OPEN', head: '2'.repeat(40), headRefName: 'feature/102' }),
          graphQlPr({ number: 103, state: 'OPEN', head: '3'.repeat(40), headRefName: 'feature/103' }),
        );
      };

      const page = await new GhLifecycleReader(run).readPullRequests(null);

      expect(page.nodes).toHaveLength(3);
      expect(listingCalls).toHaveLength(1);
    });
  });
});

/**
 * Merge-queue evidence (#82). The engine's integration stage enqueues into
 * GitHub's merge queue instead of merging directly, so a snapshot must carry
 * the PR node id the `enqueuePullRequest` mutation needs and the queue state
 * that makes a re-enqueue a no-op.
 */
describe('merge-queue snapshot evidence', () => {
  function queueAwarePr(overrides: Record<string, unknown> = {}) {
    return {
      ...graphQlPr({ number: 101, state: 'OPEN', head: OPEN_HEAD }),
      id: 'PR_kwDOABCD123',
      isInMergeQueue: false,
      mergeQueueEntry: null,
      ...overrides,
    };
  }

  function queueRun(
    node: ReturnType<typeof queueAwarePr>,
    gitRefs: Readonly<Record<string, string>> = {},
  ): { run: CommandRunner; queries: string[] } {
    const queries: string[] = [];
    const run: CommandRunner = async (command, args) => {
      if (command === 'git') {
        const rest = args.slice(2);
        if (rest[0] === 'ls-remote') return gitRefs[rest[2] ?? ''] ?? '';
        return '';
      }
      const query = args.find((arg) => arg.startsWith('query='));
      if (query !== undefined) queries.push(query);
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [node],
            },
          },
        },
      });
    };
    return { run, queries };
  }

  it('asks GraphQL for the PR node id and merge-queue entry', async () => {
    const { run, queries } = queueRun(queueAwarePr());

    await new GhLifecycleReader(run).readPullRequests(null);

    expect(queries[0]).toMatch(/\bisInMergeQueue\b/);
    expect(queries[0]).toMatch(/mergeQueueEntry\s*\{[^}]*\bposition\b/);
    expect(queries[0]).toMatch(/mergeQueueEntry\s*\{[^}]*\bstate\b/);
    expect(queries[0]).toMatch(/mergeQueueEntry\s*\{[^}]*\benqueuedAt\b/);
  });

  it('surfaces the PR node id and an absent queue entry', async () => {
    const { run } = queueRun(queueAwarePr());

    const page = await new GhLifecycleReader(run).readPullRequests(null);

    expect(page.nodes[0]).toMatchObject({
      graphqlId: 'PR_kwDOABCD123',
      mergeQueue: { enqueued: false },
    });
  });

  it('surfaces the live queue position and state for an enqueued head', async () => {
    const { run } = queueRun(queueAwarePr({
      isInMergeQueue: true,
      mergeQueueEntry: {
        position: 3,
        state: 'QUEUED',
        enqueuedAt: '2026-07-20T11:00:00.000Z',
      },
    }));

    const page = await new GhLifecycleReader(run).readPullRequests(null);

    expect(page.nodes[0]?.mergeQueue).toEqual({
      enqueued: true,
      position: 3,
      state: 'QUEUED',
    });
  });

  /**
   * BLOCKED is what a queued pull request reports, and what one waiting on a
   * merge-group-only context reports. GraphQL cannot tell "behind the base"
   * from "conflicts with it" for either, so the exact REST compare read has to
   * cover BLOCKED just as it covers CLEAN — otherwise the head derives with no
   * compare evidence at all.
   */
  it('reads exact compare evidence for a BLOCKED head', async () => {
    const endpoints: string[] = [];
    const base = 'b'.repeat(40);
    const { run: graphQl } = queueRun(queueAwarePr({ mergeStateStatus: 'BLOCKED' }));
    const run: CommandRunner = async (command, args) => {
      if (command === 'gh' && args[0] === 'api' && args[1] !== 'graphql') {
        const endpoint = args[1]!;
        endpoints.push(endpoint);
        if (endpoint.includes('/compare/')) {
          return JSON.stringify({ status: 'behind', base_commit: { sha: base } });
        }
        return JSON.stringify({
          head: { sha: OPEN_HEAD },
          base: { ref: 'next', sha: base },
        });
      }
      return graphQl(command, args);
    };

    const page = await new GhLifecycleReader(run).readPullRequests(null);

    expect(endpoints.some((endpoint) => endpoint.includes('/compare/'))).toBe(true);
    expect(page.nodes[0]?.compareStatus).toBe('behind');
    expect(page.nodes[0]?.compareBaseTipOid).toBe(base);
  });

  const MOVED_HEAD = '9'.repeat(40);
  const SIBLING_HEAD = 'e'.repeat(40);

  /**
   * A concurrent worker pushing to one PR's head between the GraphQL listing
   * and that PR's REST reread is routine. It used to abort the whole page —
   * the refusal was a bare `Error`, and the per-PR isolation only tolerates
   * `PrEvidenceInconsistentError` — so one racing push cost the entire cycle.
   * The refusal now lands on the racing PR alone, as `unknown` compare
   * evidence, which derives `blocked` downstream.
   */
  function racingHeadRun(): { run: CommandRunner; endpoints: string[] } {
    const endpoints: string[] = [];
    const base = 'b'.repeat(40);
    const racing = queueAwarePr({ mergeStateStatus: 'BLOCKED' });
    const sibling = {
      ...graphQlPr({ number: 102, state: 'OPEN', head: SIBLING_HEAD }),
      id: 'PR_kwDOABCD456',
      isInMergeQueue: false,
      mergeQueueEntry: null,
      mergeStateStatus: 'BLOCKED',
    };
    const run: CommandRunner = async (command, args) => {
      if (command === 'git') return '';
      if (args[0] === 'api' && args[1] !== 'graphql') {
        const endpoint = args[1]!;
        endpoints.push(endpoint);
        if (endpoint.includes('/compare/')) {
          return JSON.stringify({ status: 'behind', base_commit: { sha: base } });
        }
        return JSON.stringify({
          // PR #101's head moved under us; PR #102's reread is consistent.
          head: { sha: endpoint.endsWith('/pulls/101') ? MOVED_HEAD : SIBLING_HEAD },
          base: { ref: 'next', sha: base },
        });
      }
      return JSON.stringify({
        data: {
          rateLimit: rateLimit(),
          repository: {
            pullRequests: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [racing, sibling],
            },
          },
        },
      });
    };
    return { run, endpoints };
  }

  it('keeps the snapshot complete when a concurrent push moves the head mid-compare', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { run, endpoints } = racingHeadRun();

    const page = await new GhLifecycleReader(run).readPullRequests(null);

    expect(page.nodes.map((pr) => pr.number)).toEqual([101, 102]);
    // The racing PR is refused per-PR, not by invalidating the page's evidence.
    expect(page.nodes[0]?.evidenceIncompleteReason).toBeUndefined();
    // Stamped explicitly: an omitted compareStatus on a queue-eligible PR
    // derives `clean`, which would be a fail-open.
    expect(page.nodes[0]?.compareStatus).toBe('unknown');
    expect(page.nodes[0]).not.toHaveProperty('compareBaseTipOid');
    // The unaffected sibling still gets real compare evidence.
    expect(page.nodes[1]?.compareStatus).toBe('behind');

    const compares = endpoints.filter((endpoint) => endpoint.includes('/compare/'));
    expect(compares).toHaveLength(1);
    expect(compares[0]).toContain(SIBLING_HEAD);
    // Zero extra API calls are spent on a head that is already known stale.
    expect(compares[0]).not.toContain(OPEN_HEAD);
    warnSpy.mockRestore();
  });

  it('warns which PR lost head authority instead of failing silently', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { run } = racingHeadRun();

    await new GhLifecycleReader(run).readPullRequests(null);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('#101'));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('head-authority-moved'),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('#102'));
    warnSpy.mockRestore();
  });
});
