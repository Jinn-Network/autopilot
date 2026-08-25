import { describe, expect, it } from 'vitest';
import {
  classifyEnqueueFailure,
  classifyUpdateBranchFailure,
  makeProductionEnqueueActionPort,
} from '../../src/lifecycle/enqueue-executor-production.js';
import {
  executeEnqueueAction,
  executeUpdateBranchAction,
} from '../../src/lifecycle/enqueue-executor.js';
import { CredentialPool, selectCredential } from '../../src/lifecycle/credentials.js';
import type {
  GitHubLifecycleSnapshot,
  NativeReviewSnapshot,
} from '../../src/lifecycle/snapshot.js';
import { gitOid, gitRefName, isoTimestamp } from '../../src/lifecycle/types.js';
import { resolveStructuredPullRequestMappings } from '../../src/lifecycle/pr-mapping.js';
import { evaluateEnqueueGate } from '../../src/lifecycle/enqueue-executor.js';
import { reviewedDiffDigestFromCompare } from '../../src/lifecycle/reviewed-diff-digest.js';

const HEAD = gitOid('1'.repeat(40));
const OTHER_HEAD = gitOid('2'.repeat(40));
const BASE = gitOid('3'.repeat(40));
const GENERATION = '22222222-2222-4222-8222-222222222222';
const ATTEMPT = '33333333-3333-4333-8333-333333333333';
const INTENT = '44444444-4444-4444-8444-444444444444';
const REVIEWER = 'review-bot';
const MARKER = '<!-- jinn-autopilot-review:v2 '
  + 'generation=22222222-2222-4222-8222-222222222222 '
  + 'attempt=33333333-3333-4333-8333-333333333333 '
  + 'intent=44444444-4444-4444-8444-444444444444 '
  + 'reviewer=review-bot '
  + 'head=1111111111111111111111111111111111111111 '
  + 'verdict=APPROVE -->';

function approvedReview(
  overrides: Partial<NativeReviewSnapshot> = {},
): NativeReviewSnapshot {
  return {
    reviewer: REVIEWER,
    state: 'APPROVED',
    commitId: HEAD,
    body: `${MARKER}\n\nApproved.`,
    submittedAt: '2026-07-20T00:01:00.000Z',
    ...overrides,
  };
}

function snapshot(
  reviews: readonly NativeReviewSnapshot[] = [approvedReview()],
): GitHubLifecycleSnapshot {
  return {
    snapshotComplete: true,
    pullRequests: [{
      number: 84,
      title: 'PR',
      body: '',
      author: 'implementation-bot',
      baseRefName: 'stack/base',
      headRefName: 'autopilot/84',
      headOid: HEAD,
      headCommittedAt: isoTimestamp('2026-07-20T00:00:00.000Z'),
      graphqlId: 'PR_kwDOABCD84',
      isDraft: false,
      state: 'OPEN',
      labels: ['engine:review'],
      closingIssueNumbers: [84],
      mergeability: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      checks: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      reviews,
      branchClaim: {
        version: 2,
        phase: 'implement',
        issueNumber: 84,
        prNumber: 84,
        attempt: '11111111-1111-4111-8111-111111111111',
        runner: 'runner-a',
        login: 'implementation-bot',
        expectedHead: BASE,
        targetBase: 'stack/base',
        startedAt: isoTimestamp('2026-07-20T00:00:00.000Z'),
        phaseComplete: true,
      },
    }],
    lifecycle: {
      capturedAt: isoTimestamp('2026-07-20T00:00:00.000Z'),
      items: [{
        kind: 'pull-request',
        issueNumber: 84,
        prNumber: 84,
        v2Marked: true,
        projectStatus: 'In Review',
        labels: ['engine:review'],
        head: HEAD,
        headChangedAt: isoTimestamp('2026-07-20T00:00:00.000Z'),
        isDraft: false,
        merged: false,
        needsReview: false,
        approved: true,
        mergeState: 'clean',
        reviewClaim: {
          kind: 'review-claim',
          protocolVersion: 2,
          prNumber: 84,
          head: HEAD,
          generation: GENERATION,
          attempt: ATTEMPT,
          reviewer: REVIEWER,
          recordedAt: isoTimestamp('2026-07-20T00:00:00.000Z'),
          state: 'terminal-approved',
          verdict: {
            state: 'APPROVE',
            marker: INTENT,
          },
        },
        terminalVerdict: {
          state: 'APPROVE',
          head: HEAD,
          marker: INTENT,
          recordedAt: isoTimestamp('2026-07-20T00:01:00.000Z'),
        },
      }],
    },
    diagnostics: [],
    pullRequestMappings: [{
      status: 'resolved',
      prNumber: 84,
      issueNumber: 84,
      expectedBaseRefName: 'stack/base',
      evidence: 'closing-reference',
    }],
  } as unknown as GitHubLifecycleSnapshot;
}

function snapshotWithBase(baseRefName: string): GitHubLifecycleSnapshot {
  const current = snapshot();
  return {
    ...current,
    pullRequests: current.pullRequests.map((pr) => ({ ...pr, baseRefName })),
    pullRequestMappings: current.pullRequestMappings?.map((mapping) => (
      mapping.status === 'resolved'
        ? { ...mapping, expectedBaseRefName: baseRefName }
        : mapping
    )),
  };
}

function candidateRunner(changedFiles: number, filenames: readonly string[]) {
  return async (command: string, args: readonly string[]): Promise<string> => {
    expect(command).toBe('gh');
    const endpoint = args.find((arg) => arg.startsWith('repos/'));
    if (endpoint === 'repos/Jinn-Network/mono/pulls/84') {
      return JSON.stringify({
        changed_files: changedFiles,
        head: { sha: HEAD },
        base: { ref: 'stack/base', sha: BASE },
      });
    }
    if (endpoint?.startsWith('repos/Jinn-Network/mono/pulls/84/files?')) {
      return JSON.stringify([filenames.map((filename) => ({ filename }))]);
    }
    if (endpoint?.startsWith('repos/Jinn-Network/mono/contents/.github/CODEOWNERS')) {
      // GitHub enforces the CODEOWNERS at the base branch *tip*. Reading the
      // PR's pinned fork point (BASE) misses every rule added since the fork
      // and lets `codeownerSensitive` under-report.
      expect(endpoint).toBe(
        'repos/Jinn-Network/mono/contents/.github/CODEOWNERS?ref=heads/stack/base',
      );
      expect(endpoint).not.toContain(BASE);
      return JSON.stringify({
        content: Buffer.from('# no owned paths\n').toString('base64'),
      });
    }
    if (endpoint?.startsWith('repos/Jinn-Network/mono/compare/')) {
      // Compare resolves the base *branch* at request time. The pinned
      // `base.sha` fork point (BASE) stays reserved for the CODEOWNERS blob
      // read above; using it here can never report `behind`.
      expect(endpoint).toBe(`repos/Jinn-Network/mono/compare/heads/stack/base...${HEAD}`);
      expect(endpoint).not.toContain(BASE);
      return JSON.stringify({ status: 'ahead' });
    }
    throw new Error(`unexpected ${command} ${args.join(' ')}`);
  };
}

describe('production head-pinned enqueue port', () => {
  it('does not treat stale painter-owned Project Status Human as authority', async () => {
    const current = snapshot();
    const staleStatus: GitHubLifecycleSnapshot = {
      ...current,
      lifecycle: {
        ...current.lifecycle,
        items: current.lifecycle.items.map((item) => (
          item.kind === 'pull-request'
            ? { ...item, projectStatus: 'Human' as const }
            : item
        )),
      },
    };
    const port = makeProductionEnqueueActionPort({
      readSnapshot: async () => staleStatus,
      authorAllowlist: new Set(['implementation-bot']),
      expectedBaseRefName: 'stack/base',
      runner: candidateRunner(1, ['GREETING.md']),
    });

    await expect(port.readCandidate(84)).resolves.toMatchObject({
      humanHold: false,
      issueNumber: 84,
    });
  });

  it.each([
    {
      name: 'the terminal approval is dismissed',
      finalReviews: [
        approvedReview(),
        approvedReview({
          state: 'DISMISSED',
          body: '',
          submittedAt: '2026-07-20T00:02:00.000Z',
        }),
      ],
    },
    {
      name: 'the signed approval belongs to the wrong reviewer',
      finalReviews: [approvedReview({ reviewer: 'marker-copying-bot' })],
    },
    {
      name: 'the signed approval belongs to the wrong head',
      finalReviews: [approvedReview({ commitId: OTHER_HEAD })],
    },
    {
      name: 'the terminal reviewer removes approval',
      finalReviews: [
        approvedReview(),
        approvedReview({
          state: 'COMMENTED',
          body: 'Approval removed.',
          submittedAt: '2026-07-20T00:02:00.000Z',
        }),
      ],
    },
  ])('does not enqueue when $name before the final reread', async ({ finalReviews }) => {
    let candidateReads = 0;
    let mergeCalls = 0;
    const port = makeProductionEnqueueActionPort({
      readSnapshot: async () => snapshot(candidateReads++ === 0 ? undefined : finalReviews),
      authorAllowlist: new Set(['implementation-bot']),
      expectedBaseRefName: 'stack/base',
      runner: candidateRunner(1, ['GREETING.md']),
    });

    const result = await executeEnqueueAction({
      prNumber: 84,
      expectedHead: HEAD,
      expectedBaseRefName: gitRefName('stack/base'),
    }, {
      ...port,
      credentials: new CredentialPool([{
        login: 'implementation-bot',
        normalizedLogin: 'implementation-bot',
        implementationToken: 'selected-secret',
      }]),
      enqueueAtHead: async ({ head }) => {
        mergeCalls += 1;
        return { status: 'enqueued', head };
      },
    });

    expect(result).toMatchObject({
      status: 'ineligible',
      reasons: ['terminal-approval'],
    });
    expect(candidateReads).toBe(2);
    expect(mergeCalls).toBe(0);
  });

  it('uses each reviewer latest exact-head state when checking native blockers', async () => {
    let mergeCalls = 0;
    const port = makeProductionEnqueueActionPort({
      readSnapshot: async () => snapshot([
        approvedReview(),
        approvedReview({
          reviewer: 'human-reviewer',
          state: 'CHANGES_REQUESTED',
          body: 'Old blocker.',
          submittedAt: '2026-07-20T00:01:30.000Z',
        }),
        approvedReview({
          reviewer: 'human-reviewer',
          body: 'Resolved.',
          submittedAt: '2026-07-20T00:02:00.000Z',
        }),
      ]),
      authorAllowlist: new Set(['implementation-bot']),
      expectedBaseRefName: 'stack/base',
      runner: candidateRunner(1, ['GREETING.md']),
    });

    const result = await executeEnqueueAction({
      prNumber: 84,
      expectedHead: HEAD,
      expectedBaseRefName: gitRefName('stack/base'),
    }, {
      ...port,
      credentials: new CredentialPool([{
        login: 'implementation-bot',
        normalizedLogin: 'implementation-bot',
        implementationToken: 'selected-secret',
      }]),
      enqueueAtHead: async ({ head }) => {
        mergeCalls += 1;
        return { status: 'enqueued', head };
      },
    });

    expect(result).toMatchObject({ status: 'enqueued', head: HEAD });
    expect(mergeCalls).toBe(1);
  });

  it('uses the selected identity, exact SHA, and no admin or bypass flag', async () => {
    const calls: Array<{ command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner = async (
      command: string,
      args: readonly string[],
      options?: { readonly env?: NodeJS.ProcessEnv },
    ): Promise<string> => {
      calls.push({ command, args, env: options?.env });
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          state: 'OPEN',
          headRefOid: HEAD,
          baseRefName: 'next',
        });
      }
      if (command === 'gh' && args[0] === 'api' && args[1] === 'graphql') {
        return JSON.stringify({
          data: {
            enqueuePullRequest: { mergeQueueEntry: { position: 1, state: 'QUEUED' } },
          },
        });
      }
      throw new Error(`unexpected ${command} ${args.join(' ')}`);
    };
    const port = makeProductionEnqueueActionPort({
      readSnapshot: async () => snapshotWithBase('next'),
      authorAllowlist: new Set(['implementation-bot']),
      runner,
      environment: { GH_TOKEN: 'ambient-secret' },
    });
    const selection = selectCredential(new CredentialPool([{
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'selected-secret',
    }]), { phase: 'merge' });
    if (selection.status !== 'selected') throw new Error('selection failed');

    await expect(port.enqueueAtHead({
      prNumber: 84,
      issueNumber: 84,
      head: HEAD,
      graphqlId: 'PR_kwDOABCD84',
      expectedBaseRefName: gitRefName('next'),
      credential: selection.credential,
    })).resolves.toMatchObject({ status: 'enqueued', head: HEAD });

    const mutation = calls.find((call) =>
      call.args[0] === 'api' && call.args[1] === 'graphql');
    expect(mutation?.args).toContain(`expectedHeadOid=${HEAD}`);
    expect(mutation?.args).toContain('pullRequestId=PR_kwDOABCD84');
    expect(mutation?.args.join(' ')).not.toMatch(/admin|bypass|--auto/i);
    expect(mutation?.env?.GH_TOKEN).toBe('selected-secret');
    expect(mutation?.env?.GITHUB_TOKEN).toBe('');
  });

  it('rereads and rejects a retargeted base immediately before the merge PUT', async () => {
    let mergeCalls = 0;
    const runner = async (
      command: string,
      args: readonly string[],
    ): Promise<string> => {
      expect(command).toBe('gh');
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          state: 'OPEN',
          headRefOid: HEAD,
          baseRefName: 'attacker/base',
        });
      }
      if (args.includes('-X') && args.includes('PUT')) {
        mergeCalls += 1;
        return JSON.stringify({ merged: true, sha: OTHER_HEAD });
      }
      throw new Error(`unexpected ${args.join(' ')}`);
    };
    const port = makeProductionEnqueueActionPort({
      readSnapshot: async () => snapshot(),
      authorAllowlist: new Set(['implementation-bot']),
      expectedBaseRefName: 'stack/base',
      runner,
    });
    const selection = selectCredential(new CredentialPool([{
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'selected-secret',
    }]), { phase: 'merge' });
    if (selection.status !== 'selected') throw new Error('selection failed');

    await expect(port.enqueueAtHead({
      prNumber: 84,
      issueNumber: 84,
      head: HEAD,
      graphqlId: 'PR_kwDOABCD84',
      expectedBaseRefName: gitRefName('stack/base'),
      credential: selection.credential,
    })).resolves.toMatchObject({
      status: 'rejected',
      reason: expect.stringMatching(/base authority changed/i),
    });
    expect(mergeCalls).toBe(0);
  });

  it.each([
    {
      name: 'a newly opened unlabeled duplicate',
      livePullRequests: [
        {
          number: 84,
          state: 'OPEN' as const,
          head: HEAD,
          headRefName: 'autopilot/84',
          baseRefName: 'stack/base',
          closingIssueNumbers: [84],
          body: '',
        },
        {
          number: 83,
          state: 'OPEN' as const,
          head: BASE,
          headRefName: 'stack/base',
          baseRefName: 'next',
          closingIssueNumbers: [83],
          body: 'Closes #83',
        },
        {
          number: 85,
          state: 'OPEN' as const,
          head: OTHER_HEAD,
          headRefName: 'feature/retry-84',
          baseRefName: 'next',
          closingIssueNumbers: [84],
          body: 'Closes #84',
        },
      ],
    },
    {
      name: 'a custom parent that disappeared from the complete open-PR world',
      livePullRequests: [{
        number: 84,
        state: 'OPEN' as const,
        head: HEAD,
        headRefName: 'autopilot/84',
        baseRefName: 'stack/base',
        closingIssueNumbers: [84],
        body: '',
      }],
    },
  ])(
    'rejects $name from a distinctly recomputed final canonical snapshot before enqueue',
    async ({ livePullRequests }) => {
    let mergeCalls = 0;
    const current = snapshot();
    const mappings = resolveStructuredPullRequestMappings({
      defaultBranch: 'next',
      issues: [
        { number: 84, blockedOn: 'Another issue', blockedByIssues: [83] },
        { number: 83, blockedOn: 'Nothing', blockedByIssues: [] },
      ],
      pullRequests: livePullRequests,
      stableBranches: [],
    });
    expect(mappings.find((mapping) => mapping.prNumber === 84)?.status).toBe('ambiguous');
    const ambiguous: GitHubLifecycleSnapshot = {
      ...current,
      pullRequests: [
        current.pullRequests[0]!,
        ...livePullRequests
          .filter((pr) => pr.number !== 84)
          .map((pr) => ({
            ...current.pullRequests[0]!,
            number: pr.number,
            headOid: pr.head,
            headRefName: pr.headRefName,
            baseRefName: pr.baseRefName,
            closingIssueNumbers: pr.closingIssueNumbers,
            body: pr.body,
            labels: [],
          })),
      ],
      pullRequestMappings: mappings,
    } as unknown as GitHubLifecycleSnapshot;
    const port = makeProductionEnqueueActionPort({
      readSnapshot: async () => ambiguous,
      authorAllowlist: new Set(['implementation-bot']),
      expectedBaseRefName: 'stack/base',
      runner: async (_command, args) => {
        if (args.includes('-X') && args.includes('PUT')) mergeCalls += 1;
        throw new Error(`unexpected ${args.join(' ')}`);
      },
    });
    const selection = selectCredential(new CredentialPool([{
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'selected-secret',
    }]), { phase: 'merge' });
    if (selection.status !== 'selected') throw new Error('selection failed');

    await expect(port.enqueueAtHead({
      prNumber: 84,
      issueNumber: 84,
      head: HEAD,
      graphqlId: 'PR_kwDOABCD84',
      expectedBaseRefName: gitRefName('stack/base'),
      credential: selection.credential,
    })).resolves.toMatchObject({
      status: 'rejected',
      reason: expect.stringMatching(/canonical mapping authority changed/i),
    });
    expect(mergeCalls).toBe(0);
  });

  it('fails closed when the candidate snapshot omits canonical mapping authority', async () => {
    const current = snapshot();
    const port = makeProductionEnqueueActionPort({
      readSnapshot: async () => ({ ...current, pullRequestMappings: undefined }),
      authorAllowlist: new Set(['implementation-bot']),
      expectedBaseRefName: 'stack/base',
      runner: candidateRunner(1, ['GREETING.md']),
    });

    await expect(port.readCandidate(84)).resolves.toBeNull();
  });

  it.each([
    { name: 'REST total exceeds returned filenames', total: 2, files: ['src/a.ts'] },
    { name: 'GitHub file endpoint ceiling is exceeded', total: 3_001, files: ['src/a.ts'] },
    { name: 'returned filenames are duplicated', total: 2, files: ['src/a.ts', 'src/a.ts'] },
  ])('fails changed-file completeness when $name', async ({ total, files }) => {
    const port = makeProductionEnqueueActionPort({
      readSnapshot: async () => snapshot(),
      authorAllowlist: new Set(['implementation-bot']),
      expectedBaseRefName: 'stack/base',
      runner: candidateRunner(total, files),
    });

    await expect(port.readCandidate(84)).resolves.toMatchObject({
      changedFilesComplete: false,
      codeownersComplete: true,
    });
  });

  it('binds complete files and CODEOWNERS to the exact candidate base OID', async () => {
    const port = makeProductionEnqueueActionPort({
      readSnapshot: async () => snapshot(),
      authorAllowlist: new Set(['implementation-bot']),
      expectedBaseRefName: 'stack/base',
      runner: candidateRunner(2, ['src/a.ts', 'src/b.ts']),
    });

    await expect(port.readCandidate(84)).resolves.toMatchObject({
      baseRefName: 'stack/base',
      changedFilesComplete: true,
      codeownersComplete: true,
    });
  });

  it('treats an absent CODEOWNERS file as a complete empty policy', async () => {
    const runner = async (
      command: string,
      args: readonly string[],
    ): Promise<string> => {
      const endpoint = args.find((arg) => arg.startsWith('repos/'));
      if (endpoint?.startsWith(
        'repos/Jinn-Network/mono/contents/.github/CODEOWNERS',
      )) {
        throw new Error('gh: Not Found (HTTP 404)');
      }
      return candidateRunner(1, ['GREETING.md'])(command, args);
    };
    const port = makeProductionEnqueueActionPort({
      readSnapshot: async () => snapshot(),
      authorAllowlist: new Set(['implementation-bot']),
      expectedBaseRefName: 'stack/base',
      runner,
    });

    await expect(port.readCandidate(84)).resolves.toMatchObject({
      changedFilesComplete: true,
      codeownersComplete: true,
      codeownerSensitive: false,
    });
  });
});

/**
 * CODEOWNERS authority. `ExactChangedFiles` carries both `baseOid` (the PR's
 * pinned fork point, correct for the changed-files diff) and `baseRefName` (the
 * base branch, which resolves to its tip at request time). GitHub enforces the
 * CODEOWNERS in effect at the *tip*, so the sensitivity signal must be read
 * there. Reading the fork point could only under-report — a fail OPEN.
 */
describe('merge candidate CODEOWNERS authority', () => {
  const OWNED_FILE = 'client/src/dashboard/spa/src/pages/Home.tsx';

  function codeownersRunner(input: {
    readonly atForkPoint: string;
    readonly atTip: string;
    readonly seen: string[];
  }) {
    return async (command: string, args: readonly string[]): Promise<string> => {
      const endpoint = args.find((arg) => arg.startsWith('repos/'));
      if (endpoint?.startsWith('repos/Jinn-Network/mono/contents/.github/CODEOWNERS')) {
        input.seen.push(endpoint);
        const forkPoint = endpoint.includes(`ref=${BASE}`);
        return JSON.stringify({
          content: Buffer.from(forkPoint ? input.atForkPoint : input.atTip)
            .toString('base64'),
        });
      }
      return candidateRunner(1, [OWNED_FILE])(command, args);
    };
  }

  it('reads CODEOWNERS at the base branch tip, not at the pinned fork point', async () => {
    const seen: string[] = [];
    const port = makeProductionEnqueueActionPort({
      readSnapshot: async () => snapshot(),
      authorAllowlist: new Set(['implementation-bot']),
      expectedBaseRefName: 'stack/base',
      runner: codeownersRunner({
        // The rule was added to the base branch *after* this PR forked.
        atForkPoint: '# no owned paths\n',
        atTip: '/client/src/dashboard/spa/src/pages/ @Jinn-Network/codeowners\n',
        seen,
      }),
    });

    await expect(port.readCandidate(84)).resolves.toMatchObject({
      codeownersComplete: true,
      codeownerSensitive: true,
    });
    expect(seen).toEqual([
      'repos/Jinn-Network/mono/contents/.github/CODEOWNERS?ref=heads/stack/base',
    ]);
  });

  /**
   * The other direction, stated explicitly because it refutes the tempting
   * "reading the tip can only ADD sensitivity" argument. CODEOWNERS entries can
   * be deleted or narrowed by an ordinary commit, so the tip policy is NOT a
   * superset of the fork-point policy and this fix is NOT monotone: it can turn
   * `codeownerSensitive` from `true` to `false`.
   *
   * That is correct behaviour — GitHub will not enforce a rule that no longer
   * exists at the tip, so the old fork-point read was over-reporting and
   * routing changes to a human GitHub never asked for. The justification for
   * the fix is agreement with the enforcing authority, not conservatism.
   */
  it('drops sensitivity for a rule deleted from the base after the PR forked', async () => {
    const seen: string[] = [];
    const port = makeProductionEnqueueActionPort({
      readSnapshot: async () => snapshot(),
      authorAllowlist: new Set(['implementation-bot']),
      expectedBaseRefName: 'stack/base',
      runner: codeownersRunner({
        atForkPoint: '/client/src/dashboard/spa/src/pages/ @Jinn-Network/codeowners\n',
        // The rule was removed from the base branch after this PR forked, so
        // GitHub will not enforce it at merge time.
        atTip: '# ownership withdrawn\n',
        seen,
      }),
    });

    await expect(port.readCandidate(84)).resolves.toMatchObject({
      codeownersComplete: true,
      codeownerSensitive: false,
    });
  });

  it('pins CODEOWNERS through heads/ so a same-named tag cannot hijack it', async () => {
    const seen: string[] = [];
    const port = makeProductionEnqueueActionPort({
      readSnapshot: async () => snapshot(),
      authorAllowlist: new Set(['implementation-bot']),
      expectedBaseRefName: 'stack/base',
      runner: codeownersRunner({
        atForkPoint: '',
        atTip: '',
        seen,
      }),
    });

    await port.readCandidate(84);
    expect(seen[0]).toContain('ref=heads/stack/base');
  });
});

/**
 * `update-branch` diagnosis. `PUT /pulls/{n}/update-branch` answers **202
 * Accepted**: GitHub queues the update and the head has not moved when the call
 * returns. The old port read the head back exactly once and called any
 * unchanged head `rejected`, which reported a merge conflict for an update
 * merely in flight — and identically for a 403 refusal, a secondary rate limit,
 * and a dropped socket. Live evidence: PR #2130 was reported `rejected`, then
 * the identical operation later succeeded unchanged.
 */
describe('update-branch failure classification', () => {
  const ACCOUNT = {
    login: 'implementation-bot',
    normalizedLogin: 'implementation-bot',
    implementationToken: 'selected-secret',
  } as const;

  function credential() {
    const selection = selectCredential(new CredentialPool([ACCOUNT]), { phase: 'merge' });
    if (selection.status !== 'selected') throw new Error('selection failed');
    return selection.credential;
  }

  function updateBranchPort(input: {
    readonly updateBranch: () => Promise<string>;
    readonly heads: readonly string[];
    readonly sleeps: number[];
  }) {
    let readbacks = 0;
    const runner = async (command: string, args: readonly string[]): Promise<string> => {
      if (args[0] === 'pr' && args[1] === 'update-branch') {
        return input.updateBranch();
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        const head = input.heads[Math.min(readbacks, input.heads.length - 1)];
        readbacks += 1;
        if (head === undefined) throw new Error('gh: connection reset by peer');
        return JSON.stringify({ headRefOid: head });
      }
      // These cases are about a head that genuinely needs updating, so the
      // executor's up-to-date staleness guard must not short-circuit them.
      if (args.some((arg) => arg.includes('/compare/'))) {
        return JSON.stringify({ status: 'behind' });
      }
      return candidateRunner(1, ['GREETING.md'])(command, args);
    };
    return {
      readbacks: () => readbacks,
      port: makeProductionEnqueueActionPort({
        readSnapshot: async () => snapshot(),
        authorAllowlist: new Set(['implementation-bot']),
        expectedBaseRefName: 'stack/base',
        runner,
        sleep: async (milliseconds: number) => { input.sleeps.push(milliseconds); },
      }),
    };
  }

  it.each([
    ['422 unprocessable', 'gh: HTTP 422: Unprocessable Entity', 'conflict'],
    ['merge conflict prose', 'merge conflict between base and head', 'conflict'],
    ['403 refusal', 'gh: HTTP 403: Resource not accessible by integration', 'forbidden'],
    ['401 credentials', 'gh: HTTP 401: Bad credentials', 'forbidden'],
    ['secondary rate limit', 'HTTP 403: You have exceeded a secondary rate limit', 'rate-limited'],
    ['primary rate limit', 'gh: HTTP 429: API rate limit exceeded', 'rate-limited'],
    ['server error', 'gh: HTTP 502: Bad Gateway', 'unavailable'],
    ['socket failure', 'dial tcp: ECONNRESET', 'unavailable'],
    ['nothing recognisable', 'gh: something nobody has seen before', 'unclassified'],
  ] as const)('classifies %s as %s', (_name, text, expected) => {
    expect(classifyUpdateBranchFailure(text)).toBe(expected);
  });

  it('never guesses conflict for an unrecognised failure', () => {
    expect(classifyUpdateBranchFailure('totally novel gh failure')).not.toBe('conflict');
  });

  it('tolerates the documented 202 async queue and reports the later head move', async () => {
    const sleeps: number[] = [];
    const { port } = updateBranchPort({
      updateBranch: async () => '\u2713 PR branch updated\n',
      // 202 Accepted: the head has not moved yet on the first readback.
      heads: [HEAD, HEAD, OTHER_HEAD],
      sleeps,
    });

    await expect(port.updateBranch!({
      prNumber: 84,
      expectedHead: HEAD,
      credential: credential(),
    })).resolves.toEqual({ status: 'updated', head: OTHER_HEAD });
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it('reports a still-queued update as pending, never rejected', async () => {
    const sleeps: number[] = [];
    const { port } = updateBranchPort({
      updateBranch: async () => '\u2713 PR branch updated\n',
      heads: [HEAD],
      sleeps,
    });

    await expect(port.updateBranch!({
      prNumber: 84,
      expectedHead: HEAD,
      credential: credential(),
    })).resolves.toEqual({ status: 'pending', head: HEAD, failure: 'queued' });
  });

  it.each([
    ['gh: HTTP 422: Unprocessable Entity', 'rejected', 'conflict'],
    ['gh: HTTP 403: Resource not accessible by integration', 'rejected', 'forbidden'],
    ['HTTP 403: You have exceeded a secondary rate limit', 'pending', 'rate-limited'],
    ['gh: HTTP 503: Service Unavailable', 'pending', 'unavailable'],
    ['gh: unexplained failure', 'pending', 'unclassified'],
  ] as const)('maps %s to %s/%s', async (message, status, failure) => {
    const sleeps: number[] = [];
    const { port } = updateBranchPort({
      updateBranch: async () => { throw new Error(message); },
      heads: [HEAD],
      sleeps,
    });

    await expect(port.updateBranch!({
      prNumber: 84,
      expectedHead: HEAD,
      credential: credential(),
    })).resolves.toEqual({ status, head: HEAD, failure });
  });

  it('does not burn the readback budget on a durable conflict', async () => {
    const sleeps: number[] = [];
    const harness = updateBranchPort({
      updateBranch: async () => { throw new Error('gh: HTTP 422: Unprocessable Entity'); },
      heads: [HEAD],
      sleeps,
    });

    await harness.port.updateBranch!({
      prNumber: 84,
      expectedHead: HEAD,
      credential: credential(),
    });
    expect(harness.readbacks()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('accepts a head move even when the update-branch call reported an error', async () => {
    const sleeps: number[] = [];
    const { port } = updateBranchPort({
      updateBranch: async () => { throw new Error('gh: HTTP 422: Unprocessable Entity'); },
      heads: [OTHER_HEAD],
      sleeps,
    });

    await expect(port.updateBranch!({
      prNumber: 84,
      expectedHead: HEAD,
      credential: credential(),
    })).resolves.toEqual({ status: 'updated', head: OTHER_HEAD });
  });

  it('treats an unreadable head as undetermined rather than a refusal', async () => {
    const sleeps: number[] = [];
    const { port } = updateBranchPort({
      updateBranch: async () => '\u2713 PR branch updated\n',
      heads: [undefined as unknown as string],
      sleeps,
    });

    await expect(port.updateBranch!({
      prNumber: 84,
      expectedHead: HEAD,
      credential: credential(),
    })).resolves.toEqual({ status: 'pending', head: HEAD, failure: 'unavailable' });
  });

  it('surfaces a throttled update to the executor as pending, not rejected', async () => {
    const sleeps: number[] = [];
    const { port } = updateBranchPort({
      updateBranch: async () => {
        throw new Error('HTTP 403: You have exceeded a secondary rate limit');
      },
      heads: [HEAD],
      sleeps,
    });

    await expect(executeUpdateBranchAction({ prNumber: 84, expectedHead: HEAD }, {
      ...port,
      credentials: new CredentialPool([ACCOUNT]),
    })).resolves.toEqual({
      status: 'pending',
      prNumber: 84,
      reason: 'update-branch-rate-limited',
    });
  });
});

/**
 * The `already-up-to-date` outcome, straight from `gh`'s own behaviour.
 *
 * `gh pr update-branch` (cli/cli v2.78, `pkg/cmd/pr/update-branch/update_branch.go`)
 * runs its own compare first. When `behind_by == 0` it prints
 * `PR branch already up-to-date` to **stdout** and returns nil — exit 0, no API
 * mutation at all. `defaultRunner` returns stdout, so this is observable;
 * gh's failure messages go to stderr and are not.
 *
 * That is the exact shape of PR #2229: `ahead_by=4, behind_by=0`, reported by
 * the old code as `rejected (update-branch-rejected)` — the same string it
 * emitted for PR #2130, whose true cause was the opposite.
 */
describe('update-branch reports nothing-to-do as success', () => {
  const ACCOUNT_2229 = {
    login: 'implementation-bot',
    normalizedLogin: 'implementation-bot',
    implementationToken: 'selected-secret',
  } as const;

  function pick() {
    const selection = selectCredential(new CredentialPool([ACCOUNT_2229]), { phase: 'merge' });
    if (selection.status !== 'selected') throw new Error('selection failed');
    return selection.credential;
  }

  function port(update: () => Promise<string>, sleeps: number[]) {
    let readbacks = 0;
    return {
      readbacks: () => readbacks,
      value: makeProductionEnqueueActionPort({
        readSnapshot: async () => snapshot(),
        authorAllowlist: new Set(['implementation-bot']),
        expectedBaseRefName: 'stack/base',
        runner: async (command, args) => {
          if (args[0] === 'pr' && args[1] === 'update-branch') return update();
          if (args[0] === 'pr' && args[1] === 'view') {
            readbacks += 1;
            return JSON.stringify({ headRefOid: HEAD });
          }
          return candidateRunner(1, ['GREETING.md'])(command, args);
        },
        sleep: async (milliseconds: number) => { sleeps.push(milliseconds); },
      }),
    };
  }

  it.each([
    ['gh success line', '✓ PR branch already up-to-date\n'],
    ['unstyled variant', 'PR branch already up to date\n'],
  ])('reports %s as already-up-to-date, not rejected', async (_name, output) => {
    const sleeps: number[] = [];
    const harness = port(async () => output, sleeps);

    await expect(harness.value.updateBranch!({
      prNumber: 2229,
      expectedHead: HEAD,
      credential: pick(),
    })).resolves.toEqual({ status: 'already-up-to-date', head: HEAD });
    // Nothing is queued, so nothing is worth waiting for.
    expect(harness.readbacks()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('does not mistake a real update for an up-to-date no-op', async () => {
    const sleeps: number[] = [];
    const harness = port(async () => '✓ PR branch updated\n', sleeps);

    await expect(harness.value.updateBranch!({
      prNumber: 2130,
      expectedHead: HEAD,
      credential: pick(),
    })).resolves.toMatchObject({ status: 'pending', failure: 'queued' });
  });

  it.each([
    ['gh pre-flight refusal', 'Cannot update PR branch due to conflicts'],
    [
      'GraphQL mutation refusal',
      'GraphQL: merge conflict between base and head (updatePullRequestBranch)',
    ],
  ])('classifies the real gh conflict wording (%s) as conflict', (_name, text) => {
    expect(classifyUpdateBranchFailure(text)).toBe('conflict');
  });
});

/**
 * Carrying an approval across an `update-branch` head.
 *
 * `update-branch` merges the base into the PR branch. That mints a new head
 * commit but changes nothing the reviewer read, and GitHub re-points the
 * existing review's `commit_id` onto the merge commit (measured on
 * Jinn-Network/mono PR #2130: three reviews, three different signed marker
 * heads, one shared `commit_id`). The signed marker still names the head that
 * was actually reviewed, and the reviewed-diff digest is what proves the new
 * head presents the same diff.
 */
const CARRIED_HEAD = gitOid('5'.repeat(40));

const REVIEWED_FILES = [
  {
    filename: 'GREETING.md',
    status: 'modified',
    sha: 'a'.repeat(40),
    additions: 1,
    deletions: 1,
    patch: '@@ -1,1 +1,1 @@\n-hello\n+hi',
  },
] as const;

function digestFor(files: readonly Record<string, unknown>[]): string {
  const result = reviewedDiffDigestFromCompare(files, {
    baseOid: BASE,
    baseRefName: gitRefName('stack/base'),
    files: files.map((file) => file.filename as string),
    complete: true,
  });
  if (result.status !== 'digest') throw new Error(`expected a digest: ${result.reason}`);
  return result.digest;
}

const REVIEWED_DIGEST = digestFor(REVIEWED_FILES);

interface CarriedSnapshotOptions {
  readonly recordedDigest?: string;
  readonly reviews?: readonly NativeReviewSnapshot[];
  readonly prOverrides?: Record<string, unknown>;
}

/**
 * The PR head has moved from HEAD to CARRIED_HEAD; the claim, the terminal
 * verdict and the signed marker are all still bound to HEAD.
 */
function carriedSnapshot(options: CarriedSnapshotOptions = {}): GitHubLifecycleSnapshot {
  const base = snapshot();
  const recordedDigest = 'recordedDigest' in options
    ? options.recordedDigest
    : REVIEWED_DIGEST;
  return {
    ...base,
    pullRequests: base.pullRequests.map((pr) => ({
      ...pr,
      headOid: CARRIED_HEAD,
      // GitHub re-points the prior review onto the merge commit.
      reviews: options.reviews ?? [approvedReview({ commitId: CARRIED_HEAD })],
      ...options.prOverrides,
    })),
    lifecycle: {
      ...base.lifecycle,
      items: base.lifecycle.items.map((item) => (
        item.kind === 'pull-request'
          ? {
              ...item,
              head: CARRIED_HEAD,
              reviewClaim: {
                ...item.reviewClaim,
                ...(recordedDigest === undefined
                  ? {}
                  : { reviewedDiffDigest: recordedDigest }),
              },
            }
          : item
      )),
    },
  } as unknown as GitHubLifecycleSnapshot;
}

function carriedRunner(compareFiles: unknown, filenames: readonly string[] = ['GREETING.md']) {
  return async (command: string, args: readonly string[]): Promise<string> => {
    expect(command).toBe('gh');
    const endpoint = args.find((arg) => arg.startsWith('repos/'));
    if (endpoint === 'repos/Jinn-Network/mono/pulls/84') {
      return JSON.stringify({
        changed_files: filenames.length,
        head: { sha: CARRIED_HEAD },
        base: { ref: 'stack/base', sha: BASE },
      });
    }
    if (endpoint?.startsWith('repos/Jinn-Network/mono/pulls/84/files?')) {
      return JSON.stringify([filenames.map((filename) => ({ filename }))]);
    }
    if (endpoint?.startsWith('repos/Jinn-Network/mono/contents/.github/CODEOWNERS')) {
      return JSON.stringify({
        content: Buffer.from('# no owned paths\n').toString('base64'),
      });
    }
    if (endpoint?.startsWith('repos/Jinn-Network/mono/compare/')) {
      expect(endpoint).toBe(
        `repos/Jinn-Network/mono/compare/heads/stack/base...${CARRIED_HEAD}`,
      );
      return JSON.stringify({ status: 'ahead', files: compareFiles });
    }
    throw new Error(`unexpected ${command} ${args.join(' ')}`);
  };
}

function carriedPort(
  snapshotValue: GitHubLifecycleSnapshot,
  compareFiles: unknown,
  filenames: readonly string[] = ['GREETING.md'],
) {
  return makeProductionEnqueueActionPort({
    readSnapshot: async () => snapshotValue,
    authorAllowlist: new Set(['implementation-bot']),
    expectedBaseRefName: 'stack/base',
    runner: carriedRunner(compareFiles, filenames),
  });
}

describe('approval carry across an update-branch head', () => {
  it('carries the approval when the new head presents the reviewed diff', async () => {
    const candidate = await carriedPort(carriedSnapshot(), REVIEWED_FILES)
      .readCandidate(84);
    expect(candidate).not.toBeNull();
    expect(candidate!.head).toBe(CARRIED_HEAD);
    expect(candidate!.terminalApprovalMatches).toBe(true);
    expect(evaluateEnqueueGate(candidate!)).toEqual({ pass: true, reasons: [] });
  });

  it('enqueues at the new head under the carried approval', async () => {
    const enqueued = await executeEnqueueAction(
      {
        prNumber: 84,
        expectedHead: CARRIED_HEAD,
        expectedBaseRefName: gitRefName('stack/base'),
      },
      {
        ...carriedPort(carriedSnapshot(), REVIEWED_FILES),
        credentials: new CredentialPool([{
          login: 'implementation-bot',
          normalizedLogin: 'implementation-bot',
          implementationToken: 'selected-secret',
        }]),
        enqueueAtHead: async () => ({ status: 'enqueued', head: CARRIED_HEAD }),
      },
    );
    expect(enqueued).toMatchObject({ status: 'enqueued', head: CARRIED_HEAD });
  });

  it('does not carry when a base change altered a file the PR also changed', async () => {
    // Same paths, different merged result: the base moved lines the PR's hunk
    // is anchored on, so the patch — and therefore the digest — differs.
    const rebased = [{
      ...REVIEWED_FILES[0],
      patch: '@@ -7,1 +7,1 @@\n-hello\n+hi',
    }];
    const candidate = await carriedPort(carriedSnapshot(), rebased).readCandidate(84);
    expect(candidate!.terminalApprovalMatches).toBe(false);
    expect(evaluateEnqueueGate(candidate!).reasons).toContain('terminal-approval');
  });

  it('does not carry when a worker pushed a real code change', async () => {
    const pushed = [
      REVIEWED_FILES[0],
      {
        filename: 'src/backdoor.ts',
        status: 'added',
        sha: 'b'.repeat(40),
        additions: 1,
        deletions: 0,
        patch: '@@ -0,0 +1 @@\n+exfiltrate();',
      },
    ];
    const candidate = await carriedPort(
      carriedSnapshot(),
      pushed,
      ['GREETING.md', 'src/backdoor.ts'],
    ).readCandidate(84);
    expect(candidate!.terminalApprovalMatches).toBe(false);
    expect(evaluateEnqueueGate(candidate!).reasons).toContain('terminal-approval');
  });

  it('does not carry a claim written before digests existed', async () => {
    const candidate = await carriedPort(
      carriedSnapshot({ recordedDigest: undefined }),
      REVIEWED_FILES,
    ).readCandidate(84);
    expect(candidate!.terminalApprovalMatches).toBe(false);
    expect(evaluateEnqueueGate(candidate!).reasons).toContain('terminal-approval');
  });

  it.each([
    [
      'a file GitHub cannot represent as a patch',
      [{ filename: 'GREETING.md', status: 'modified', sha: 'a'.repeat(40) }],
      ['GREETING.md'],
    ],
    [
      'a compare response carrying no files at all',
      undefined,
      ['GREETING.md'],
    ],
    [
      'a compare file set that disagrees with the proven changed-file list',
      REVIEWED_FILES,
      ['GREETING.md', 'src/hidden.ts'],
    ],
  ])('does not carry with %s', async (_name, compareFiles, filenames) => {
    const candidate = await carriedPort(
      carriedSnapshot(),
      compareFiles,
      filenames,
    ).readCandidate(84);
    expect(candidate!.terminalApprovalMatches).toBe(false);
    expect(evaluateEnqueueGate(candidate!).reasons).toContain('terminal-approval');
  });

  it('does not carry a digest that matches some other PR head state', async () => {
    const candidate = await carriedPort(
      carriedSnapshot({ recordedDigest: digestFor([{
        filename: 'GREETING.md',
        status: 'modified',
        sha: 'a'.repeat(40),
        additions: 1,
        deletions: 1,
        patch: '@@ -1,1 +1,1 @@\n-hello\n+something-else',
      }]) }),
      REVIEWED_FILES,
    ).readCandidate(84);
    expect(candidate!.terminalApprovalMatches).toBe(false);
  });

  it('still requires the signed marker naming the reviewed head', async () => {
    const candidate = await carriedPort(
      carriedSnapshot({
        reviews: [approvedReview({
          commitId: CARRIED_HEAD,
          body: 'Approved, but with no engine signature.',
        })],
      }),
      REVIEWED_FILES,
    ).readCandidate(84);
    expect(candidate!.terminalApprovalMatches).toBe(false);
  });

  it('still refuses a superseding dismissal at the new head', async () => {
    const candidate = await carriedPort(
      carriedSnapshot({
        reviews: [
          approvedReview({ commitId: CARRIED_HEAD }),
          approvedReview({
            commitId: CARRIED_HEAD,
            state: 'DISMISSED',
            body: '',
            submittedAt: '2026-07-20T00:02:00.000Z',
          }),
        ],
      }),
      REVIEWED_FILES,
    ).readCandidate(84);
    expect(candidate!.terminalApprovalMatches).toBe(false);
  });

  it.each([
    [
      'draft',
      { prOverrides: { isDraft: true } },
      'draft',
    ],
    [
      'human',
      { prOverrides: { labels: ['engine:review', 'autopilot:human'] } },
      'human',
    ],
    [
      'checks-not-green',
      {
        prOverrides: {
          checks: [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }],
        },
      },
      'checks-not-green',
    ],
    [
      'a conflicting head',
      { prOverrides: { mergeability: 'CONFLICTING', mergeStateStatus: 'DIRTY' } },
      'conflicting',
    ],
    [
      'review-label',
      { prOverrides: { labels: [] } },
      'review-label',
    ],
    [
      'changes-requested',
      {
        reviews: [
          approvedReview({ commitId: CARRIED_HEAD }),
          approvedReview({
            reviewer: 'human-dev',
            state: 'CHANGES_REQUESTED',
            commitId: CARRIED_HEAD,
            body: 'Not yet.',
            submittedAt: '2026-07-20T00:03:00.000Z',
          }),
        ],
      },
      'changes-requested',
    ],
  ])('a matching digest does not unblock %s', async (_name, options, reason) => {
    const candidate = await carriedPort(
      carriedSnapshot(options as CarriedSnapshotOptions),
      REVIEWED_FILES,
    ).readCandidate(84);
    // The approval itself still carries — only the independent reason blocks.
    expect(candidate!.terminalApprovalMatches).toBe(true);
    const gate = evaluateEnqueueGate(candidate!);
    expect(gate.pass).toBe(false);
    expect(gate.reasons).toContain(reason);
    expect(gate.reasons).not.toContain('terminal-approval');
  });

  it('a matching digest does not unblock a disallowed author', async () => {
    const port = makeProductionEnqueueActionPort({
      readSnapshot: async () => carriedSnapshot(),
      authorAllowlist: new Set(['someone-else']),
      expectedBaseRefName: 'stack/base',
      runner: carriedRunner(REVIEWED_FILES),
    });
    const candidate = await port.readCandidate(84);
    expect(candidate!.terminalApprovalMatches).toBe(true);
    expect(evaluateEnqueueGate(candidate!).reasons).toContain('author');
  });

  /**
   * A behind head is the merge queue's ordinary input, not a refusal — the
   * queue rebases onto the base it merges into. What the carry must still not
   * do is *manufacture* an approval, which the surrounding cases pin.
   */
  it('does not refuse a behind head once the digest carries', async () => {
    const port = makeProductionEnqueueActionPort({
      readSnapshot: async () => carriedSnapshot(),
      authorAllowlist: new Set(['implementation-bot']),
      expectedBaseRefName: 'stack/base',
      runner: async (command, args) => {
        const endpoint = args.find((arg) => arg.startsWith('repos/'));
        if (endpoint?.startsWith('repos/Jinn-Network/mono/compare/')) {
          return JSON.stringify({ status: 'behind', files: REVIEWED_FILES });
        }
        return carriedRunner(REVIEWED_FILES)(command, args);
      },
    });
    const candidate = await port.readCandidate(84);
    expect(candidate!.terminalApprovalMatches).toBe(true);
    expect(evaluateEnqueueGate(candidate!)).toEqual({ pass: true, reasons: [] });
  });
});

/**
 * The enqueue mutation itself (#82). The engine no longer merges: it hands the
 * PR to GitHub's merge queue with `enqueuePullRequest`, pinned to the exact head
 * it gated. `gh pr merge` — with or without `--auto` — must never run, because
 * it would either merge outside the queue or hand GitHub a standing instruction
 * the engine cannot retract.
 */
describe('enqueue mutation', () => {
  const ACCOUNT = {
    login: 'implementation-bot',
    normalizedLogin: 'implementation-bot',
    implementationToken: 'selected-secret',
  } as const;

  function credential() {
    const selection = selectCredential(new CredentialPool([ACCOUNT]), { phase: 'merge' });
    if (selection.status !== 'selected') throw new Error('selection failed');
    return selection.credential;
  }

  interface EnqueueHarness {
    readonly calls: Array<{ command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }>;
    readonly port: ReturnType<typeof makeProductionEnqueueActionPort>;
  }

  function enqueuePort(input: {
    readonly mutation?: () => Promise<string>;
    readonly view?: (call: number) => Promise<string>;
    readonly refs?: Record<string, string>;
    readonly catFile?: (oid: string) => string;
    readonly pushFails?: boolean;
    readonly onPush?: (args: readonly string[]) => void;
    readonly childNumber?: number;
  } = {}): EnqueueHarness {
    let views = 0;
    const calls: Array<{
      command: string;
      args: readonly string[];
      env?: NodeJS.ProcessEnv;
    }> = [];
    const refs = { ...(input.refs ?? {}) };
    const runner = async (
      command: string,
      args: readonly string[],
      options?: { readonly env?: NodeJS.ProcessEnv },
    ): Promise<string> => {
      calls.push({ command, args, env: options?.env });
      if (command === 'git') {
        const rest = args.slice(args.indexOf('-C') + 2);
        if (rest[0] === 'ls-remote') {
          const ref = rest[2] ?? '';
          return refs[ref] === undefined ? '' : `${refs[ref]}\t${ref}\n`;
        }
        if (rest[0] === 'commit-tree') return `${'e'.repeat(40)}\n`;
        if (rest[0] === 'cat-file') return input.catFile?.(rest[2] ?? '') ?? '';
        if (rest[0] === 'push') {
          input.onPush?.(rest);
          if (input.pushFails === true) throw new Error('stale info');
          return '';
        }
        return '';
      }
      if (
        args[0] === 'api'
        && args[1] === 'graphql'
        && args.some((arg) => arg.includes('enqueuePullRequest'))
      ) {
        return (input.mutation ?? (async () => JSON.stringify({
          data: {
            enqueuePullRequest: { mergeQueueEntry: { position: 4, state: 'QUEUED' } },
          },
        })))();
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        const call = views;
        views += 1;
        return (input.view ?? ((): Promise<string> => Promise.resolve(JSON.stringify({
          state: 'OPEN',
          headRefOid: HEAD,
          baseRefName: 'stack/base',
          isInMergeQueue: false,
        }))))(call);
      }
      // The `ci-failure` child the flake hold files, and everything the child
      // port does around it.
      if (args[0] === 'project' && args[1] === 'field-list') {
        return JSON.stringify({
          fields: [
            {
              id: 'F_blocked',
              name: 'Blocked on',
              options: [
                { id: 'O_nothing', name: 'Nothing' },
                { id: 'O_human', name: 'Human' },
              ],
            },
            {
              id: 'F_effort',
              name: 'Effort',
              options: ['Low', 'Medium', 'High', 'XHigh', 'Max']
                .map((name) => ({ id: `O_effort_${name}`, name })),
            },
            {
              id: 'F_priority',
              name: 'Priority',
              options: ['P0', 'P1', 'P2', 'P3', 'P4']
                .map((name) => ({ id: `O_priority_${name}`, name })),
            },
          ],
        });
      }
      if (args[0] === 'project' && args[1] === 'item-add') {
        return JSON.stringify({ id: 'PVTI_child' });
      }
      if (args[0] === 'project') return JSON.stringify({});
      if (args[0] === 'issue' && args[1] === 'create') {
        return `https://github.com/${'Jinn-Network/mono'}/issues/${input.childNumber ?? 4242}\n`;
      }
      if (args[0] === 'issue' && args[1] === 'view') return 'I_kwDOissue\n';
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'issue' || args[0] === 'label' || args[0] === 'search'
        || args[0] === 'project' || args[0] === 'api') {
        return JSON.stringify([]);
      }
      return candidateRunner(1, ['GREETING.md'])(command, args);
    };
    return {
      calls,
      port: makeProductionEnqueueActionPort({
        readSnapshot: async () => snapshot(),
        authorAllowlist: new Set(['implementation-bot']),
        expectedBaseRefName: 'stack/base',
        repositoryPath: '/tmp/repo',
        fixIssueTypeId: 'IT_kwDOfix',
        runner,
        environment: { GH_TOKEN: 'ambient-secret' },
      }),
    };
  }

  function enqueue(harness: EnqueueHarness) {
    return harness.port.enqueueAtHead({
      prNumber: 84,
      issueNumber: 84,
      head: HEAD,
      graphqlId: 'PR_kwDOABCD84',
      expectedBaseRefName: gitRefName('stack/base'),
      credential: credential(),
    });
  }

  it('sends enqueuePullRequest pinned to the exact head under the selected identity', async () => {
    const harness = enqueuePort();

    await expect(enqueue(harness)).resolves.toMatchObject({
      status: 'enqueued',
      head: HEAD,
      position: 4,
      queueState: 'QUEUED',
    });

    const mutation = harness.calls.find((call) =>
      call.command === 'gh' && call.args[0] === 'api' && call.args[1] === 'graphql');
    expect(mutation).toBeDefined();
    expect(mutation!.args).toContain('-f');
    expect(mutation!.args).toContain('pullRequestId=PR_kwDOABCD84');
    expect(mutation!.args).toContain(`expectedHeadOid=${HEAD}`);
    expect(mutation!.args.join(' ')).toMatch(/enqueuePullRequest\(input:/);
    expect(mutation!.env?.GH_TOKEN).toBe('selected-secret');
    expect(mutation!.env?.GITHUB_TOKEN).toBe('');
  });

  it('never runs gh pr merge and never arms auto-merge', async () => {
    const harness = enqueuePort();

    await enqueue(harness);

    for (const call of harness.calls) {
      expect(`${call.command} ${call.args.join(' ')}`).not.toMatch(/\bpr merge\b/);
      expect(call.args).not.toContain('--auto');
      expect(call.args.join(' ')).not.toMatch(/pulls\/\d+\/merge/);
    }
  });

  it.each([
    ['already queued prose', 'Pull request is already queued', 'already-enqueued'],
    ['not mergeable', 'GraphQL: Pull request is not mergeable', 'rejected'],
    ['queue not enabled', 'GraphQL: Merge queue is not enabled for this branch', 'rejected'],
    ['a 403 refusal', 'gh: HTTP 403: Resource not accessible by integration', 'rejected'],
    ['a stale expected head', 'GraphQL: Head sha did not match the expected head oid', 'changed-head'],
    ['a 502', 'gh: HTTP 502: Bad Gateway', 'undetermined'],
    ['a socket failure', 'dial tcp: ECONNRESET', 'undetermined'],
    ['a secondary rate limit', 'HTTP 403: You have exceeded a secondary rate limit', 'undetermined'],
    ['nothing recognisable', 'gh: something nobody has seen before', 'undetermined'],
  ] as const)('classifies %s as %s', (_name, text, expected) => {
    expect(classifyEnqueueFailure(text)).toBe(expected);
  });

  it('reports an already-queued refusal as success, not as a rejection', async () => {
    const harness = enqueuePort({
      mutation: async () => { throw new Error('GraphQL: Pull request is already queued'); },
    });

    await expect(enqueue(harness)).resolves.toMatchObject({ status: 'already-enqueued' });
  });

  it('rereads the head when GitHub refuses the expected head oid', async () => {
    const harness = enqueuePort({
      mutation: async () => {
        throw new Error('GraphQL: Head sha did not match the expected head oid');
      },
      view: async (): Promise<string> => JSON.stringify({
        state: 'OPEN',
        headRefOid: OTHER_HEAD,
        baseRefName: 'stack/base',
        isInMergeQueue: false,
      }),
    });

    await expect(enqueue(harness)).resolves.toMatchObject({
      status: 'changed-head',
      head: OTHER_HEAD,
    });
  });

  it('reports a durable refusal as rejected and names it', async () => {
    const harness = enqueuePort({
      mutation: async () => {
        throw new Error('GraphQL: Merge queue is not enabled for this branch');
      },
    });

    await expect(enqueue(harness)).resolves.toMatchObject({
      status: 'rejected',
      reason: expect.stringMatching(/merge queue is not enabled/i),
    });
  });

  /**
   * A dropped connection is not proof the mutation did not land. The readback
   * is the only thing that can tell "never reached GitHub" from "landed and the
   * response was lost", and only an observed queue entry at the expected head
   * resolves it as success.
   */
  it('resolves an undetermined failure by reading the queue back', async () => {
    const harness = enqueuePort({
      mutation: async () => { throw new Error('gh: HTTP 502: Bad Gateway'); },
      // Not queued when the pre-flight authority read runs; queued afterwards,
      // which is the only evidence that the lost mutation actually landed.
      view: async (call) => JSON.stringify({
        state: 'OPEN',
        headRefOid: HEAD,
        baseRefName: 'stack/base',
        isInMergeQueue: call > 0,
      }),
    });

    await expect(enqueue(harness)).resolves.toMatchObject({ status: 'enqueued' });
  });

  it('stays ambiguous when the readback does not show the PR queued', async () => {
    const harness = enqueuePort({
      mutation: async () => { throw new Error('gh: HTTP 502: Bad Gateway'); },
      view: async (): Promise<string> => JSON.stringify({
        state: 'OPEN',
        headRefOid: HEAD,
        baseRefName: 'stack/base',
        isInMergeQueue: false,
      }),
    });

    await expect(enqueue(harness)).resolves.toMatchObject({ status: 'ambiguous' });
  });

  it('does not accept a readback queued at some other head', async () => {
    const harness = enqueuePort({
      mutation: async () => { throw new Error('gh: HTTP 502: Bad Gateway'); },
      view: async (): Promise<string> => JSON.stringify({
        state: 'OPEN',
        headRefOid: OTHER_HEAD,
        baseRefName: 'stack/base',
        isInMergeQueue: true,
      }),
    });

    await expect(enqueue(harness)).resolves.toMatchObject({ status: 'changed-head' });
  });

  /**
   * Mutate first, record second. A record written before the mutation would
   * burn an attempt for a call that never reached GitHub, and two of those
   * would put a perfectly healthy head on a flake hold.
   */
  it('publishes the attempt record only after the mutation succeeded', async () => {
    const order: string[] = [];
    const harness = enqueuePort({
      mutation: async () => {
        order.push('mutation');
        return JSON.stringify({
          data: { enqueuePullRequest: { mergeQueueEntry: { position: 1, state: 'QUEUED' } } },
        });
      },
      onPush: () => order.push('push'),
    });

    await enqueue(harness);

    expect(order).toEqual(['mutation', 'push']);
  });

  it('does not burn an attempt when the mutation durably failed', async () => {
    const pushes: string[][] = [];
    const harness = enqueuePort({
      mutation: async () => {
        throw new Error('GraphQL: Merge queue is not enabled for this branch');
      },
      onPush: (args) => pushes.push([...args]),
    });

    await enqueue(harness);

    expect(pushes).toEqual([]);
  });

  it('CAS-publishes the first attempt against an absent ref', async () => {
    const leases: string[] = [];
    const harness = enqueuePort({
      onPush: (args) => {
        leases.push(args.find((arg) => arg.startsWith('--force-with-lease=')) ?? '');
      },
    });

    await enqueue(harness);

    expect(leases).toEqual([
      `--force-with-lease=refs/jinn-autopilot/enqueues/v1/pr-84/${HEAD}:`,
    ]);
  });

  it('increments the attempt count against the recorded one', async () => {
    const messages: string[] = [];
    const ref = `refs/jinn-autopilot/enqueues/v1/pr-84/${HEAD}`;
    const harness = enqueuePort({
      refs: { [ref]: 'd'.repeat(40) },
      catFile: () => [
        'Autopilot enqueue record',
        '',
        `<!-- jinn-autopilot:enqueue:v1 pr=84 head=${HEAD} attempts=1 -->`,
        'enqueued-at=2026-07-20T12:00:00.000Z',
      ].join('\n'),
    });
    const runner = harness.calls;
    await enqueue(harness);
    for (const call of runner) {
      if (call.command === 'git' && call.args.includes('commit-tree')) {
        messages.push(call.args[call.args.indexOf('-m') + 1] ?? '');
      }
    }

    expect(messages[0]).toContain('attempts=2');
  });

  /**
   * A lost CAS publish means another writer moved the ref underneath us and we
   * cannot say how many attempts this head has now had. The enqueue itself may
   * well have landed, so the honest answer is `ambiguous`.
   */
  it('reports a lost record publication as ambiguous', async () => {
    const harness = enqueuePort({ pushFails: true });

    await expect(enqueue(harness)).resolves.toMatchObject({ status: 'ambiguous' });
  });

  /**
   * The flake hold. Two failed attempts at the same head is a signal, not
   * noise: the engine stops feeding the queue, files a `ci-failure` child so a
   * human can see why, and writes the child's number into the record so a
   * later cycle can tell "held and explained" from "held and silent".
   */
  describe('flake hold', () => {
    const ref = `refs/jinn-autopilot/enqueues/v1/pr-84/${HEAD}`;

    function twoAttempts(overrides: Partial<Parameters<typeof enqueuePort>[0]> = {}) {
      return enqueuePort({
        refs: { [ref]: 'd'.repeat(40) },
        catFile: () => [
          'Autopilot enqueue record',
          '',
          `<!-- jinn-autopilot:enqueue:v1 pr=84 head=${HEAD} attempts=2 -->`,
          'enqueued-at=2026-07-20T12:00:00.000Z',
        ].join('\n'),
        ...overrides,
      });
    }

    it('refuses a third attempt and never reaches the mutation', async () => {
      let mutations = 0;
      const harness = twoAttempts({
        mutation: async () => {
          mutations += 1;
          return JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: null } } });
        },
      });

      await expect(enqueue(harness)).resolves.toMatchObject({ status: 'flake-hold' });
      expect(mutations).toBe(0);
    });

    it('files a ci-failure child and links it into the record', async () => {
      const messages: string[] = [];
      const harness = twoAttempts();

      await enqueue(harness);

      for (const call of harness.calls) {
        if (call.command === 'git' && call.args.includes('commit-tree')) {
          messages.push(call.args[call.args.indexOf('-m') + 1] ?? '');
        }
      }
      expect(messages.some((message) => /^linked-issue=\d+$/m.test(message))).toBe(true);
    });

    it('lets a record that already names its issue through', async () => {
      let mutations = 0;
      const harness = enqueuePort({
        refs: { [ref]: 'd'.repeat(40) },
        catFile: () => [
          'Autopilot enqueue record',
          '',
          `<!-- jinn-autopilot:enqueue:v1 pr=84 head=${HEAD} attempts=2 -->`,
          'enqueued-at=2026-07-20T12:00:00.000Z',
          'linked-issue=4242',
        ].join('\n'),
        mutation: async () => {
          mutations += 1;
          return JSON.stringify({
            data: { enqueuePullRequest: { mergeQueueEntry: { position: 1, state: 'QUEUED' } } },
          });
        },
      });

      await expect(enqueue(harness)).resolves.toMatchObject({ status: 'enqueued' });
      expect(mutations).toBe(1);
    });
  });
});
