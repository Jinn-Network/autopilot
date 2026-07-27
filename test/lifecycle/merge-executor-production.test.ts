import { describe, expect, it } from 'vitest';
import {
  makeProductionMergeActionPort,
} from '../../src/lifecycle/merge-executor-production.js';
import { executeMergeAction } from '../../src/lifecycle/merge-executor.js';
import { CredentialPool, selectCredential } from '../../src/lifecycle/credentials.js';
import type {
  GitHubLifecycleSnapshot,
  NativeReviewSnapshot,
} from '../../src/lifecycle/snapshot.js';
import { gitOid, gitRefName, isoTimestamp } from '../../src/lifecycle/types.js';
import { resolveStructuredPullRequestMappings } from '../../src/lifecycle/pr-mapping.js';

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
      expect(endpoint).toContain(`ref=${BASE}`);
      return JSON.stringify({
        content: Buffer.from('# no owned paths\n').toString('base64'),
      });
    }
    if (endpoint?.startsWith('repos/Jinn-Network/mono/compare/')) {
      expect(endpoint).toBe(`repos/Jinn-Network/mono/compare/${BASE}...${HEAD}`);
      return JSON.stringify({ status: 'ahead' });
    }
    throw new Error(`unexpected ${command} ${args.join(' ')}`);
  };
}

describe('production head-pinned merge port', () => {
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
    const port = makeProductionMergeActionPort({
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
  ])('does not merge when $name before the final reread', async ({ finalReviews }) => {
    let candidateReads = 0;
    let mergeCalls = 0;
    const port = makeProductionMergeActionPort({
      readSnapshot: async () => snapshot(candidateReads++ === 0 ? undefined : finalReviews),
      authorAllowlist: new Set(['implementation-bot']),
      expectedBaseRefName: 'stack/base',
      runner: candidateRunner(1, ['GREETING.md']),
    });

    const result = await executeMergeAction({
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
      mergeExactHead: async ({ head }) => {
        mergeCalls += 1;
        return { status: 'merged', head, mergeCommitOid: OTHER_HEAD };
      },
      reconcileDone: async () => {},
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
    const port = makeProductionMergeActionPort({
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

    const result = await executeMergeAction({
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
      mergeExactHead: async ({ head }) => {
        mergeCalls += 1;
        return { status: 'merged', head, mergeCommitOid: OTHER_HEAD };
      },
      reconcileDone: async () => {},
    });

    expect(result).toMatchObject({ status: 'merged', head: HEAD });
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
      if (command === 'gh' && args.includes('-X') && args.includes('PUT')) {
        return JSON.stringify({ merged: true, sha: '2'.repeat(40), message: 'merged' });
      }
      throw new Error(`unexpected ${command} ${args.join(' ')}`);
    };
    const port = makeProductionMergeActionPort({
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

    await expect(port.mergeExactHead({
      prNumber: 84,
      head: HEAD,
      expectedBaseRefName: gitRefName('next'),
      credential: selection.credential,
    })).resolves.toMatchObject({ status: 'merged', head: HEAD });

    const merge = calls.find((call) =>
      call.args.some((arg) => arg.endsWith('pulls/84/merge')));
    expect(merge?.args).toContain(`sha=${HEAD}`);
    expect(merge?.args).toContain('merge_method=squash');
    expect(merge?.args.join(' ')).not.toMatch(/admin|bypass/i);
    expect(merge?.env?.GH_TOKEN).toBe('selected-secret');
    expect(merge?.env?.GITHUB_TOKEN).toBe('');
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
    const port = makeProductionMergeActionPort({
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

    await expect(port.mergeExactHead({
      prNumber: 84,
      head: HEAD,
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
    'rejects $name from a distinctly recomputed final canonical snapshot before merge',
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
    const port = makeProductionMergeActionPort({
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

    await expect(port.mergeExactHead({
      prNumber: 84,
      head: HEAD,
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
    const port = makeProductionMergeActionPort({
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
    const port = makeProductionMergeActionPort({
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
    const port = makeProductionMergeActionPort({
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
    const port = makeProductionMergeActionPort({
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
