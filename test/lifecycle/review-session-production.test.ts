// @ts-nocheck — Stage 5 leftover fixtures for deleted merge-prep/review-fix/project APIs.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AttemptManifest } from '../../src/lifecycle/attempt-workspace.js';
import {
  encodeReviewClaimPayload,
  formatAutomatedReviewMarker,
} from '../../src/lifecycle/codecs.js';
import {
  makeProductionReviewSessionPort as makeRawProductionReviewSessionPort,
  type ProductionReviewSessionPortOptions,
} from '../../src/lifecycle/review-session-production.js';
import { makeReviewSessionProtocol } from '../../src/lifecycle/review-session.js';
import {
  gitOid,
  type ReviewClaimRecord,
} from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));
const BASE = gitOid('6'.repeat(40));
const REVIEW = gitOid('2'.repeat(40));
const RECORD = gitOid('3'.repeat(40));
const TREE = gitOid('4'.repeat(40));
const BLOB = gitOid('5'.repeat(40));
const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const GENERATION = '22222222-2222-4222-8222-222222222222';
const FIX_ONE = gitOid('2'.repeat(40));
const PRIOR_ATTEMPT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRIOR_GENERATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MARKER = '33333333-3333-4333-8333-333333333333';

function claim() {
  return {
    kind: 'review-claim',
    protocolVersion: 2,
    prNumber: 84,
    generation: GENERATION,
    attempt: ATTEMPT,
    reviewer: 'review-bot',
    head: HEAD,
    state: 'active',
    recordedAt: '2026-07-20T12:00:00.000Z',
  } satisfies ReviewClaimRecord;
}

function terminalClaim(): ReviewClaimRecord {
  return {
    ...claim(),
    state: 'terminal-approved',
    verdict: {
      state: 'APPROVE',
      marker: '33333333-3333-4333-8333-333333333333',
    },
  };
}

function humanClaim(): ReviewClaimRecord {
  return {
    ...claim(),
    state: 'human',
  };
}

function manifest(): AttemptManifest {
  return {
    version: 2,
    attemptId: ATTEMPT,
    runnerId: 'runner',
    host: 'host',
    phase: 'review',
    subject: 'pr-84',
    issueNumber: 42,
    prNumber: 84,
    branch: 'autopilot/42',
    targetBase: 'next',
    expectedHead: HEAD,
    claimOid: REVIEW,
    reviewGeneration: GENERATION,
    reviewRefOid: REVIEW,
    reviewApprovalPolicy: 'approve-eligible',
    selectedLogin: 'review-bot',
    repository: {
      root: '/repo',
      gitCommonDir: '/repo/.git',
      remoteName: 'origin',
      remoteUrlHash: 'a'.repeat(64),
    },
    processState: 'running',
    pid: 42,
    paths: {
      attemptDir: '/attempt',
      worktree: '/attempt/worktree',
      manifest: '/attempt/manifest.json',
      log: '/attempt/log',
      ghConfigDir: '/attempt/gh',
      askpass: '/attempt/askpass',
      tokenFile: '/attempt/gh-token',
    },
    timestamps: {
      createdAt: '2026-07-20T12:00:00.000Z',
      updatedAt: '2026-07-20T12:00:00.000Z',
      childStartedAt: '2026-07-20T12:00:00.000Z',
    },
  };
}

function completeMappingAuthority(
  bound: AttemptManifest,
  overrides: {
    readonly blockedOn?: 'Another issue' | null;
    readonly blockedByIssues?: readonly number[];
    readonly stableTargetBase?: string;
  } = {},
) {
  const stacked = bound.issueNumber === 2084;
  return {
    defaultBranch: 'next',
    issues: [{
      number: bound.issueNumber,
      blockedOn: overrides.blockedOn ?? (stacked ? 'Another issue' : null),
      blockedByIssues:
        overrides.blockedByIssues ?? (stacked ? [2083] : []),
    }],
    stableBranches: stacked
      ? [{
          issueNumber: 2084,
          phase: 'implement' as const,
          head: bound.expectedHead,
          headRefName: bound.branch,
          targetBase: overrides.stableTargetBase ?? bound.targetBase,
        }]
      : [],
  };
}

function makeProductionReviewSessionPort(
  options: ProductionReviewSessionPortOptions = {},
) {
  const originalRunner = options.runner;
  const fixtureRunner = originalRunner === undefined
    ? undefined
    : async (...args: Parameters<NonNullable<typeof originalRunner>>) => {
        const output = await originalRunner(...args);
        const [command, commandArgs] = args;
        if (
          command !== 'gh'
          || commandArgs[0] !== 'pr'
          || commandArgs[1] !== 'list'
        ) {
          return output;
        }
        const bound = options.readManifest?.('/attempt/manifest.json') ?? manifest();
        const parsed = JSON.parse(output);
        return JSON.stringify(parsed.map((record) => {
          const branch = record.headRefName;
          const branchMatch = /^autopilot\/([1-9][0-9]*)$/.exec(branch);
          const issueNumber = record.closingIssuesReferences?.[0]?.number
            ?? (branchMatch === null ? bound.issueNumber : Number(branchMatch[1]));
          return {
            ...record,
            baseRefName: record.baseRefName
              ?? (record.number === bound.prNumber ? bound.targetBase : 'next'),
            body: record.body
              ?? `<!-- jinn-autopilot:v2 issue=${issueNumber} branch=${branch} -->`,
          };
        }));
      };
  return makeRawProductionReviewSessionPort({
    readProjectHumanAuthority: async () => false,
    readMappingAuthority: async ({ manifest: bound }) =>
      completeMappingAuthority(bound),
    ...options,
    ...(fixtureRunner === undefined ? {} : { runner: fixtureRunner }),
  });
}

function projectSnapshot(status: 'Todo' | 'In Review' | 'Human'): string {
  return JSON.stringify({
    data: {
      rateLimit: {
        remaining: 4999,
        used: 1,
        resetAt: '2026-07-20T13:00:00.000Z',
      },
      organization: {
        projectV2: {
          sprintField: null,
          items: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{
              id: 'PVTI_issue_42',
              content: {
                __typename: 'Issue',
                number: 42,
                issueType: { name: 'feat' },
                blockedBy: { nodes: [] },
              },
              status: { name: status },
              priority: { name: 'P1' },
              effort: { name: 'High' },
              blockedOn: { name: 'Nothing' },
              sprint: null,
            }],
          },
        },
      },
    },
  });
}

function projectFields(): string {
  return JSON.stringify({
    fields: [
      {
        id: 'status-field',
        name: 'Status',
        options: [
          { id: 'todo', name: 'Todo' },
          { id: 'in-progress', name: 'In Progress' },
          { id: 'human', name: 'Human' },
          { id: 'in-review', name: 'In Review' },
          { id: 'done', name: 'Done' },
        ],
      },
      {
        id: 'blocked-field',
        name: 'Blocked on',
        options: [
          { id: 'nothing', name: 'Nothing' },
          { id: 'human-blocked', name: 'Human' },
          { id: 'another-issue', name: 'Another issue' },
        ],
      },
    ],
  });
}

describe('production review session port', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function tokenFileFixture(token: string): AttemptManifest {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-review-session-token-'));
    roots.push(dir);
    const tokenFile = join(dir, 'gh-token');
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    return { ...manifest(), paths: { ...manifest().paths, tokenFile } };
  }

  it('regression (#1883): resolves the GH token from the attempt token file when the coordinator runtime scrubbed GH_TOKEN from ambient env', async () => {
    const bound = tokenFileFixture('file-secret');
    const calls: Array<{ env?: Record<string, string> }> = [];
    const port = makeProductionReviewSessionPort({
      environment: { JINN_AUTOPILOT_SESSION_MANIFEST: bound.paths.manifest },
      readManifest: () => bound,
      runner: async (cmd, args, options) => {
        calls.push({ env: options?.env });
        if (cmd === 'gh') return 'review-bot\n';
        if (args.includes('get-url')) return 'https://github.com/Jinn-Network/mono.git\n';
        if (args.includes('ls-remote')) {
          return `${REVIEW}\trefs/jinn-autopilot/review-claims/v1/84\n`;
        }
        if (args.includes('fetch')) return '';
        if (args.includes('show')) return `${encodeReviewClaimPayload(claim())}\n`;
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });

    await expect(port.readAuthority(bound)).resolves.toEqual({
      reviewRefOid: REVIEW,
      record: claim(),
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.env?.GH_TOKEN === 'file-secret')).toBe(true);
  });

  it('prefers ambient GH_TOKEN over the token file when both are available', async () => {
    const bound = tokenFileFixture('file-secret');
    const calls: Array<{ env?: Record<string, string> }> = [];
    const port = makeProductionReviewSessionPort({
      environment: {
        GH_TOKEN: 'env-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: bound.paths.manifest,
      },
      readManifest: () => bound,
      runner: async (cmd, args, options) => {
        calls.push({ env: options?.env });
        if (cmd === 'gh') return 'review-bot\n';
        if (args.includes('get-url')) return 'https://github.com/Jinn-Network/mono.git\n';
        if (args.includes('ls-remote')) {
          return `${REVIEW}\trefs/jinn-autopilot/review-claims/v1/84\n`;
        }
        if (args.includes('fetch')) return '';
        if (args.includes('show')) return `${encodeReviewClaimPayload(claim())}\n`;
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });

    await expect(port.readAuthority(bound)).resolves.toEqual({
      reviewRefOid: REVIEW,
      record: claim(),
    });
    expect(calls.every((call) => call.env?.GH_TOKEN === 'env-secret')).toBe(true);
  });

  it('throws closed when neither ambient GH_TOKEN nor a readable token file is available', () => {
    expect(() => makeProductionReviewSessionPort({
      environment: { JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json' },
      readManifest: () => manifest(),
    })).toThrow(/requires its selected GH_TOKEN/);
  });

  it('freshly rederives the unique open issue/branch mapping and pinned-base CODEOWNER policy', async () => {
    const port = makeProductionReviewSessionPort({
      environment: {
        GH_TOKEN: 'selected-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
      readManifest: () => manifest(),
      runner: async (cmd, args) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          expect(args.at(-1)).toContain('closingIssuesReferences');
          expect(args.at(-1)).not.toMatch(/(?:^|,)closingIssues(?:,|$)/);
          return JSON.stringify({
            number: 84,
            state: 'OPEN',
            headRefOid: HEAD,
            headRefName: 'autopilot/42',
            baseRefName: 'next',
            baseRefOid: BASE,
            isDraft: true,
            body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
            author: { login: 'implementation-bot' },
            labels: [{ name: 'engine:review' }],
            closingIssuesReferences: [{ number: 42 }],
            files: [{ path: 'client/src/dashboard/spa/src/pages/Home.tsx' }],
          });
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          expect(args.at(-1)).toContain('closingIssuesReferences');
          expect(args.at(-1)).not.toMatch(/(?:^|,)closingIssues(?:,|$)/);
          return JSON.stringify([{
            number: 84,
            headRefOid: HEAD,
            headRefName: 'autopilot/42',
            closingIssuesReferences: [{ number: 42 }],
          }]);
        }
        if (cmd === 'git' && args.includes('ls-tree')) {
          if (args.at(-1) === BASE) return '.github/CODEOWNERS\n';
          throw new Error('unexpected tree ref');
        }
        if (cmd === 'git' && args.includes('show')) {
          if (args.at(-1) === `${BASE}:.github/CODEOWNERS`) {
            return '/client/src/dashboard/spa/src/pages/ @Jinn-Network/codeowners\n';
          }
          throw new Error('path does not exist');
        }
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });

    const pullRequest = await port.readPullRequest(84, HEAD);
    expect(pullRequest).toMatchObject({
      number: 84,
      issueNumber: 42,
      open: true,
      approvalPolicy: 'human-codeowner',
    });
    expect(pullRequest).not.toHaveProperty('mappingProblem');
  });

  it('accepts an empty closing set only for the exact unique manifest-pinned stacked PR', async () => {
    const stackedManifest: AttemptManifest = {
      ...manifest(),
      issueNumber: 2084,
      branch: 'autopilot/2084',
      targetBase: 'autopilot/2083',
    };
    const port = makeProductionReviewSessionPort({
      environment: {
        GH_TOKEN: 'selected-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
      readManifest: () => stackedManifest,
      runner: async (cmd, args) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({
            number: 84,
            state: 'OPEN',
            headRefOid: HEAD,
            headRefName: 'autopilot/2084',
            baseRefName: 'autopilot/2083',
            baseRefOid: BASE,
            isDraft: false,
            body: '<!-- jinn-autopilot:v2 issue=2084 branch=autopilot/2084 -->',
            author: { login: 'implementation-bot' },
            labels: [{ name: 'engine:review' }],
            closingIssuesReferences: [],
            files: [],
          });
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          return JSON.stringify([{
            number: 84,
            headRefOid: HEAD,
            headRefName: 'autopilot/2084',
            closingIssuesReferences: [],
          }]);
        }
        if (cmd === 'git' && args.includes('ls-tree')) return '';
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });

    const pullRequest = await port.readPullRequest(84, HEAD);
    expect(pullRequest).toMatchObject({
      issueNumber: 2084,
      headRefName: 'autopilot/2084',
      baseRefName: 'autopilot/2083',
    });
    expect(pullRequest).not.toHaveProperty('mappingProblem');
  });

  it.each([
    {
      name: 'complete dependency authority is unavailable',
      authority: null,
    },
    {
      name: 'the issue no longer depends on its parent',
      authority: completeMappingAuthority({
        ...manifest(),
        issueNumber: 2084,
        branch: 'autopilot/2084',
        targetBase: 'autopilot/2083',
      }, {
        blockedOn: null,
        blockedByIssues: [],
      }),
    },
    {
      name: 'the exact stable claim was retargeted',
      authority: completeMappingAuthority({
        ...manifest(),
        issueNumber: 2084,
        branch: 'autopilot/2084',
        targetBase: 'autopilot/2083',
      }, {
        stableTargetBase: 'next',
      }),
    },
  ])('requires coordinator mapping reread when $name', async ({ authority }) => {
    const stackedManifest: AttemptManifest = {
      ...manifest(),
      issueNumber: 2084,
      branch: 'autopilot/2084',
      targetBase: 'autopilot/2083',
    };
    const port = makeRawProductionReviewSessionPort({
      environment: {
        GH_TOKEN: 'selected-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
      readManifest: () => stackedManifest,
      readProjectHumanAuthority: async () => false,
      readMappingAuthority: async () => authority,
      runner: async (cmd, args) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({
            number: 84,
            state: 'OPEN',
            headRefOid: HEAD,
            headRefName: 'autopilot/2084',
            baseRefName: 'autopilot/2083',
            baseRefOid: BASE,
            isDraft: false,
            body: '<!-- jinn-autopilot:v2 issue=2084 branch=autopilot/2084 -->',
            author: { login: 'implementation-bot' },
            labels: [{ name: 'engine:review' }],
            closingIssuesReferences: [],
            files: [],
          });
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          return JSON.stringify([{
            number: 84,
            headRefOid: HEAD,
            headRefName: 'autopilot/2084',
            baseRefName: 'autopilot/2083',
            body: '<!-- jinn-autopilot:v2 issue=2084 branch=autopilot/2084 -->',
            closingIssuesReferences: [],
          }]);
        }
        if (cmd === 'git' && args.includes('ls-tree')) return '';
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });

    await expect(port.readPullRequest(84, HEAD)).resolves.toMatchObject({
      mappingProblem: expect.stringMatching(/authority|dependency|stable|mapping/i),
    });
  });

  it.each([
    {
      name: 'Project Blocked on Human remains active',
      labels: ['engine:review'],
      projectHumanAuthority: true,
      mappingAuthority: null,
      expectedStatus: 'human' as const,
    },
    {
      name: 'fresh Project Human overrides non-Human mapping evidence',
      labels: ['engine:review'],
      projectHumanAuthority: true,
      mappingAuthority: completeMappingAuthority(manifest()),
      expectedStatus: 'human' as const,
    },
    {
      name: 'the external Human label remains active',
      labels: ['engine:review', 'review:needs-human'],
      projectHumanAuthority: null,
      mappingAuthority: null,
      expectedStatus: 'human' as const,
    },
    {
      name: 'external Human evidence is unavailable',
      labels: ['engine:review'],
      projectHumanAuthority: null,
      mappingAuthority: null,
      expectedError: /Human authority is unavailable or inconsistent/i,
    },
  ])(
    'publishes no mapping reread when $name',
    async ({
      labels,
      projectHumanAuthority,
      mappingAuthority,
      expectedStatus,
      expectedError,
    }) => {
      const bound = manifest();
      const publications: string[] = [];
      const options = {
        environment: {
          GH_TOKEN: 'selected-secret',
          JINN_AUTOPILOT_SESSION_MANIFEST: bound.paths.manifest,
        },
        readManifest: () => bound,
        readMappingAuthority: async () => mappingAuthority,
        readProjectHumanAuthority: async () => projectHumanAuthority,
        runner: async (cmd: string, args: readonly string[]) => {
          if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
            return JSON.stringify({
              number: 84,
              state: 'OPEN',
              headRefOid: HEAD,
              headRefName: 'autopilot/42',
              baseRefName: 'next',
              baseRefOid: BASE,
              isDraft: true,
              body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
              author: { login: 'implementation-bot' },
              labels: labels.map((name) => ({ name })),
              closingIssuesReferences: [{ number: 42 }],
              files: [],
            });
          }
          if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
            return JSON.stringify([{
              number: 84,
              headRefOid: HEAD,
              headRefName: 'autopilot/42',
              baseRefName: 'next',
              body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
              closingIssuesReferences: [{ number: 42 }],
            }]);
          }
          if (
            cmd === 'gh'
            && args[0] === 'api'
            && args[1] === 'repos/Jinn-Network/mono/pulls/84/reviews'
          ) {
            return '[[]]';
          }
          if (cmd === 'git' && args.includes('ls-tree')) return '';
          throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
        },
      } as ProductionReviewSessionPortOptions & {
        readonly readProjectHumanAuthority: () => Promise<boolean | null>;
      };
      const production = makeRawProductionReviewSessionPort(options);
      const protocol = makeReviewSessionProtocol({
        ...production,
        readAuthority: async () => ({
          reviewRefOid: REVIEW,
          record: claim(),
        }),
        createReviewRecord: async ({ record }) => {
          publications.push(`record:${record.state}`);
          return RECORD;
        },
        publishReviewClaim: async ({
          expectedRemoteRecordOid,
          recordOid,
          record,
        }) => {
          publications.push(`claim:${record.state}`);
          return {
            status: 'lost',
            expected: expectedRemoteRecordOid,
            published: recordOid,
            observed: REVIEW,
          };
        },
      });

      const verdict = protocol.reviewVerdict(bound, 'APPROVE', 'Clean.');
      if (expectedError === undefined) {
        await expect(verdict).resolves.toEqual({
          status: expectedStatus,
          head: HEAD,
        });
      } else {
        await expect(verdict).rejects.toThrow(expectedError);
      }
      expect(publications).toEqual([]);
    },
  );

  it('ignores a CODEOWNERS edit that only exists in the PR head tree', async () => {
    const port = makeProductionReviewSessionPort({
      environment: {
        GH_TOKEN: 'selected-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
      readManifest: () => manifest(),
      runner: async (cmd, args) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({
            number: 84,
            state: 'OPEN',
            headRefOid: HEAD,
            headRefName: 'autopilot/42',
            baseRefName: 'next',
            baseRefOid: BASE,
            isDraft: true,
            body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
            author: { login: 'implementation-bot' },
            labels: [{ name: 'engine:review' }],
            closingIssuesReferences: [{ number: 42 }],
            files: [{ path: 'client/src/dashboard/spa/src/pages/Home.tsx' }],
          });
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          return JSON.stringify([{
            number: 84,
            headRefOid: HEAD,
            headRefName: 'autopilot/42',
            closingIssuesReferences: [{ number: 42 }],
          }]);
        }
        if (cmd === 'git' && args.includes('ls-tree')) {
          if (args.at(-1) === BASE) return '.github/CODEOWNERS\n';
          throw new Error('An attacker-controlled head tree must never be read');
        }
        if (cmd === 'git' && args.includes('show')) {
          if (args.at(-1) === `${BASE}:.github/CODEOWNERS`) {
            return '/client/src/dashboard/spa/src/pages/ @Jinn-Network/codeowners\n';
          }
          throw new Error('An attacker-controlled head tree must never be read');
        }
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });

    const pullRequest = await port.readPullRequest(84, HEAD);
    expect(pullRequest.approvalPolicy).toBe('human-codeowner');
  });

  it('reports duplicate open issue or branch mappings instead of trusting the manifest', async () => {
    const port = makeProductionReviewSessionPort({
      environment: {
        GH_TOKEN: 'selected-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
      readManifest: () => manifest(),
      runner: async (cmd, args) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({
            number: 84,
            state: 'OPEN',
            headRefOid: HEAD,
            headRefName: 'autopilot/42',
            baseRefName: 'next',
            baseRefOid: BASE,
            isDraft: true,
            body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
            author: { login: 'implementation-bot' },
            labels: [{ name: 'engine:review' }],
            closingIssuesReferences: [{ number: 42 }],
            files: [],
          });
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          return JSON.stringify([
            {
              number: 84,
              headRefOid: HEAD,
              headRefName: 'autopilot/42',
              closingIssuesReferences: [{ number: 42 }],
            },
            {
              number: 85,
              headRefOid: '9'.repeat(40),
              headRefName: 'feature/duplicate-42',
              closingIssuesReferences: [{ number: 42 }],
            },
          ]);
        }
        if (cmd === 'git' && args.includes('ls-tree')) return '';
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });

    const pullRequest = await port.readPullRequest(84, HEAD);
    expect(pullRequest).toMatchObject({
      mappingProblem: expect.stringMatching(/unique|duplicate|mapping/i),
    });
    expect(pullRequest).not.toHaveProperty('mappingDiagnostic');
  });

  it('uses only the selected credential and explicit review commit_id/event/body', async () => {
    const calls: Array<{
      cmd: string;
      args: string[];
      env?: Record<string, string>;
    }> = [];
    const port = makeProductionReviewSessionPort({
      environment: {
        GH_TOKEN: 'selected-secret',
        GITHUB_TOKEN: 'ambient-secret',
        JINN_IMPL_GH_TOKEN: 'other-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
      readManifest: () => manifest(),
      runner: async (cmd, args, options) => {
        calls.push({ cmd, args, env: options?.env });
        if (cmd === 'gh' && args.join(' ') === 'api user --jq .login') {
          return 'review-bot\n';
        }
        if (cmd === 'gh' && args.includes('view')) {
          return JSON.stringify({
            number: 84,
            state: 'OPEN',
            headRefOid: HEAD,
            headRefName: 'autopilot/42',
            baseRefName: 'next',
            baseRefOid: BASE,
            isDraft: false,
            body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
            author: { login: 'implementation-bot' },
            labels: [{ name: 'engine:review' }],
            closingIssuesReferences: [{ number: 42 }],
            files: [],
          });
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          return JSON.stringify([{
            number: 84,
            headRefOid: HEAD,
            headRefName: 'autopilot/42',
            closingIssuesReferences: [{ number: 42 }],
          }]);
        }
        if (cmd === 'git' && args.includes('ls-tree')) return '';
        if (cmd === 'gh' && args.join(' ').includes('repos/Jinn-Network/mono/pulls/84/reviews')) {
          return '{}';
        }
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });

    await port.submitNativeReview({
      manifest: manifest(),
      prNumber: 84,
      commitId: HEAD,
      reviewer: 'review-bot',
      state: 'APPROVE',
      body: 'exact body',
    });

    const mutation = calls.find((call) => call.args.includes('--method'));
    expect(mutation?.args).toEqual([
      'api', '--method', 'POST',
      'repos/Jinn-Network/mono/pulls/84/reviews',
      '-f', `commit_id=${HEAD}`,
      '-f', 'event=APPROVE',
      '-f', 'body=exact body',
    ]);
    expect(mutation?.env).toMatchObject({ GH_TOKEN: 'selected-secret' });
    expect(mutation?.env?.GITHUB_TOKEN).toBe('');
    expect(mutation?.env?.JINN_IMPL_GH_TOKEN).toBe('');
  });

  it('regression: publishes a review verdict with no JINN_REVIEW_* env vars, resolving the reviewer credential from the attempt token file', async () => {
    // Mirrors the live Hermes-scrubbed session shape: the non-secret-shaped
    // JINN_REVIEW_BOT_LOGIN survives the coordinator runtime's env scrub,
    // while the secret-shaped GH_TOKEN / JINN_REVIEW_GH_TOKEN do not. The
    // port must never consult JINN_REVIEW_BOT_LOGIN or demand
    // JINN_REVIEW_GH_TOKEN — it resolves the reviewer's credential solely
    // from the attempt-scoped token file (#1883 credential-handoff fix) and
    // must complete the native review submission without throwing.
    const bound = tokenFileFixture('file-secret');
    const calls: Array<{ cmd: string; args: string[]; env?: Record<string, string> }> = [];
    const port = makeProductionReviewSessionPort({
      environment: {
        JINN_REVIEW_BOT_LOGIN: 'review-bot',
        JINN_AUTOPILOT_SESSION_MANIFEST: bound.paths.manifest,
      },
      readManifest: () => bound,
      runner: async (cmd, args, options) => {
        calls.push({ cmd, args, env: options?.env });
        if (cmd === 'gh' && args.join(' ') === 'api user --jq .login') {
          return 'review-bot\n';
        }
        if (cmd === 'gh' && args.includes('view')) {
          return JSON.stringify({
            number: 84,
            state: 'OPEN',
            headRefOid: HEAD,
            headRefName: 'autopilot/42',
            baseRefName: 'next',
            baseRefOid: BASE,
            isDraft: false,
            body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
            author: { login: 'implementation-bot' },
            labels: [{ name: 'engine:review' }],
            closingIssuesReferences: [{ number: 42 }],
            files: [],
          });
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          return JSON.stringify([{
            number: 84,
            headRefOid: HEAD,
            headRefName: 'autopilot/42',
            closingIssuesReferences: [{ number: 42 }],
          }]);
        }
        if (cmd === 'git' && args.includes('ls-tree')) return '';
        if (cmd === 'gh' && args.join(' ').includes('repos/Jinn-Network/mono/pulls/84/reviews')) {
          return '{}';
        }
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });

    await expect(port.submitNativeReview({
      manifest: bound,
      prNumber: 84,
      commitId: HEAD,
      reviewer: 'review-bot',
      state: 'APPROVE',
      body: 'exact body',
    })).resolves.toBeUndefined();

    const mutation = calls.find((call) => call.args.includes('--method'));
    expect(mutation?.env?.GH_TOKEN).toBe('file-secret');
    // The demand this regression guards against never fires: no code path
    // here reads JINN_REVIEW_BOT_LOGIN, and none of the recorded calls carry
    // JINN_REVIEW_GH_TOKEN (it was never set in this environment at all).
    expect(calls.every((call) => call.env?.JINN_REVIEW_GH_TOKEN === undefined
      || call.env.JINN_REVIEW_GH_TOKEN === '')).toBe(true);
  });

  it('rejects submitNativeReview when the resolved gh identity no longer matches the manifest reviewer', async () => {
    const port = makeProductionReviewSessionPort({
      environment: {
        GH_TOKEN: 'stale-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
      readManifest: () => manifest(),
      runner: async (cmd, args) => {
        if (cmd === 'gh' && args.join(' ') === 'api user --jq .login') return 'someone-else\n';
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });

    await expect(port.submitNativeReview({
      manifest: manifest(),
      prNumber: 84,
      commitId: HEAD,
      reviewer: 'review-bot',
      state: 'APPROVE',
      body: 'exact body',
    })).rejects.toThrow(/no longer matches the manifest identity/);
  });

  it('reads the exact review ref payload and validates selected identity and canonical HTTPS remote', async () => {
    const calls: string[] = [];
    const port = makeProductionReviewSessionPort({
      environment: {
        GH_TOKEN: 'selected-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
      readManifest: () => manifest(),
      runner: async (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        if (cmd === 'gh') return 'review-bot\n';
        if (args.includes('get-url')) return 'https://github.com/Jinn-Network/mono.git\n';
        if (args.includes('ls-remote')) {
          return `${REVIEW}\trefs/jinn-autopilot/review-claims/v1/84\n`;
        }
        if (args.includes('fetch')) return '';
        if (args.includes('show')) return `${encodeReviewClaimPayload(claim())}\n`;
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });

    await expect(port.readAuthority(manifest())).resolves.toEqual({
      reviewRefOid: REVIEW,
      record: claim(),
    });
    expect(calls.some((call) => call.includes('ls-remote'))).toBe(true);
    expect(calls.some((call) => call.includes('jinn-autopilot-review.json'))).toBe(true);
  });

  it('creates append-only metadata commits with the exact sole parent', async () => {
    const calls: string[][] = [];
    const port = makeProductionReviewSessionPort({
      environment: {
        GH_TOKEN: 'selected-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
      readManifest: () => manifest(),
      writeMetadataFile: () => '/attempt/metadata.json',
      removeMetadataFile: () => undefined,
      runner: async (cmd, args) => {
        expect(cmd).toBe('git');
        calls.push(args);
        if (args.includes('hash-object')) return `${BLOB}\n`;
        if (args.includes('write-tree')) return `${TREE}\n`;
        if (args.includes('commit-tree')) return `${RECORD}\n`;
        return '';
      },
    });

    await expect(port.createReviewRecord({
      manifest: manifest(),
      parent: REVIEW,
      record: claim(),
    })).resolves.toBe(RECORD);

    const commit = calls.find((args) => args.includes('commit-tree'));
    expect(commit).toEqual(expect.arrayContaining([
      'commit-tree', TREE, '-p', REVIEW,
    ]));
    expect(calls.find((args) => args.includes('update-index')))
      .toEqual(expect.arrayContaining([
        '--cacheinfo', `100644,${BLOB},jinn-autopilot-review.json`,
      ]));
  });

  it.each(['label', 'ready', 'draft', 'comment'] as const)(
    'accepts a lost %s response only after exact mutation readback',
    async (mutation) => {
      let labels = ['engine:review'];
      let draft = mutation !== 'draft';
      const comments: string[] = [];
      const marker = '<!-- exact-human-marker -->';
      const port = makeProductionReviewSessionPort({
        environment: {
          GH_TOKEN: 'selected-secret',
          JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
        },
        readManifest: () => manifest(),
        runner: async (cmd, args) => {
          if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
            return JSON.stringify({
              number: 84,
              state: 'OPEN',
              headRefOid: HEAD,
              headRefName: 'autopilot/42',
              baseRefName: 'next',
              baseRefOid: BASE,
              isDraft: draft,
              body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
              author: { login: 'implementation-bot' },
              labels: labels.map((name) => ({ name })),
              closingIssuesReferences: [{ number: 42 }],
              files: [],
            });
          }
          if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
            return JSON.stringify([{
              number: 84,
              headRefOid: HEAD,
              headRefName: 'autopilot/42',
              closingIssuesReferences: [{ number: 42 }],
            }]);
          }
          if (cmd === 'git' && args.includes('ls-tree')) return '';
          if (mutation === 'comment' && cmd === 'gh' && args.join(' ') === 'api user --jq .login') {
            return 'review-bot\n';
          }
          if (mutation === 'comment' && cmd === 'git' && args.includes('get-url')) {
            return 'https://github.com/Jinn-Network/mono.git\n';
          }
          if (mutation === 'comment' && cmd === 'git' && args.includes('ls-remote')) {
            return `${REVIEW}\trefs/jinn-autopilot/review-claims/v1/84\n`;
          }
          if (mutation === 'comment' && cmd === 'git' && args.includes('fetch')) return '';
          if (mutation === 'comment' && cmd === 'git' && args.includes('show')) {
            return `${encodeReviewClaimPayload(humanClaim())}\n`;
          }
          if (
            mutation === 'ready'
            && cmd === 'gh'
            && args.join(' ') === 'api user --jq .login'
          ) {
            return 'review-bot\n';
          }
          if (mutation === 'ready' && cmd === 'git' && args.includes('get-url')) {
            return 'https://github.com/Jinn-Network/mono.git\n';
          }
          if (mutation === 'ready' && cmd === 'git' && args.includes('ls-remote')) {
            return `${REVIEW}\trefs/jinn-autopilot/review-claims/v1/84\n`;
          }
          if (mutation === 'ready' && cmd === 'git' && args.includes('fetch')) {
            return '';
          }
          if (mutation === 'ready' && cmd === 'git' && args.includes('show')) {
            return `${encodeReviewClaimPayload(terminalClaim())}\n`;
          }
          if (
            mutation === 'ready'
            && cmd === 'gh'
            && args[0] === 'api'
            && args[1] === 'graphql'
          ) {
            return projectSnapshot('In Review');
          }
          if (
            mutation === 'ready'
            && cmd === 'gh'
            && args[0] === 'api'
            && args[1]?.endsWith('/reviews')
          ) {
            return JSON.stringify([[{
              user: { login: 'review-bot' },
              state: 'APPROVED',
              commit_id: HEAD,
              body: formatAutomatedReviewMarker({
                generation: GENERATION,
                attempt: ATTEMPT,
                intent: MARKER,
                reviewer: 'review-bot',
                head: HEAD,
                verdict: 'APPROVE',
              }),
              submitted_at: '2026-07-20T12:00:20.000Z',
            }]]);
          }
          if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'edit') {
            labels = [...labels, 'review:approved'];
            throw new Error('accepted label response lost');
          }
          if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'ready') {
            draft = args.includes('--undo');
            throw new Error('accepted draft response lost');
          }
          if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'comment') {
            comments.push(args.at(-1)!);
            throw new Error('accepted comment response lost');
          }
          if (cmd === 'gh' && args[0] === 'api' && args[1]?.includes('/comments')) {
            return JSON.stringify(comments.map((body) => ({ body })));
          }
          throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
        },
      });

      const operation = mutation === 'label'
        ? port.setPullRequestLabel(84, HEAD, 'review:approved', true)
        : mutation === 'ready'
          ? port.setPullRequestDraft(84, HEAD, false)
          : mutation === 'draft'
            ? port.setPullRequestDraft(84, HEAD, true)
            : port.ensureHumanComment(
                84, HEAD, REVIEW, GENERATION, 'human', marker, marker,
              );
      await expect(operation).resolves.toBeUndefined();
    },
  );

  it.skip('accepts a lost Project response only after exact status readback', async () => {
    let status: 'Todo' | 'In Review' | 'Human' = 'Todo';
    const port = makeProductionReviewSessionPort({
      environment: {
        GH_TOKEN: 'selected-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
      readManifest: () => manifest(),
      runner: async (cmd, args) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({
            number: 84,
            state: 'OPEN',
            headRefOid: HEAD,
            headRefName: 'autopilot/42',
            baseRefName: 'next',
            baseRefOid: BASE,
            isDraft: true,
            body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
            author: { login: 'implementation-bot' },
            labels: [{ name: 'engine:review' }],
            closingIssuesReferences: [{ number: 42 }],
            files: [],
          });
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          return JSON.stringify([{
            number: 84,
            headRefOid: HEAD,
            headRefName: 'autopilot/42',
            closingIssuesReferences: [{ number: 42 }],
          }]);
        }
        if (cmd === 'git' && args.includes('ls-tree')) return '';
        if (cmd === 'gh' && args.join(' ') === 'api user --jq .login') {
          return 'review-bot\n';
        }
        if (cmd === 'git' && args.includes('get-url')) {
          return 'https://github.com/Jinn-Network/mono.git\n';
        }
        if (cmd === 'git' && args.includes('ls-remote')) {
          return `${REVIEW}\trefs/jinn-autopilot/review-claims/v1/84\n`;
        }
        if (cmd === 'git' && args.includes('fetch')) return '';
        if (cmd === 'git' && args.includes('show')) {
          return `${encodeReviewClaimPayload(humanClaim())}\n`;
        }
        if (cmd === 'gh' && args[0] === 'api' && args[1] === 'graphql') {
          return projectSnapshot(status);
        }
        if (cmd === 'gh' && args[0] === 'project' && args[1] === 'field-list') {
          return projectFields();
        }
        if (cmd === 'gh' && args[0] === 'project' && args[1] === 'item-edit') {
          status = 'In Review';
          throw new Error('accepted Project response lost');
        }
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });

    await expect(port.setProjectStatus(42, HEAD, 'In Review')).resolves.toBeUndefined();
  });

  it('does not accept a lost Human comment response from a copied marker in a different body', async () => {
    const marker = '<!-- exact-human-marker -->';
    const port = makeProductionReviewSessionPort({
      environment: {
        GH_TOKEN: 'selected-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
      readManifest: () => manifest(),
      runner: async (cmd, args) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({
            number: 84,
            state: 'OPEN',
            headRefOid: HEAD,
            headRefName: 'autopilot/42',
            baseRefName: 'next',
            baseRefOid: BASE,
            isDraft: true,
            body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
            author: { login: 'implementation-bot' },
            labels: [{ name: 'engine:review' }],
            closingIssuesReferences: [{ number: 42 }],
            files: [],
          });
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          return JSON.stringify([{
            number: 84,
            headRefOid: HEAD,
            headRefName: 'autopilot/42',
            closingIssuesReferences: [{ number: 42 }],
          }]);
        }
        if (cmd === 'git' && args.includes('ls-tree')) return '';
        if (cmd === 'gh' && args.join(' ') === 'api user --jq .login') {
          return 'review-bot\n';
        }
        if (cmd === 'git' && args.includes('get-url')) {
          return 'https://github.com/Jinn-Network/mono.git\n';
        }
        if (cmd === 'git' && args.includes('ls-remote')) {
          return `${REVIEW}\trefs/jinn-autopilot/review-claims/v1/84\n`;
        }
        if (cmd === 'git' && args.includes('fetch')) return '';
        if (cmd === 'git' && args.includes('show')) {
          return `${encodeReviewClaimPayload(humanClaim())}\n`;
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'comment') {
          throw new Error('accepted comment response lost');
        }
        if (cmd === 'gh' && args[0] === 'api' && args[1]?.includes('/comments')) {
          return JSON.stringify([{ body: `copied ${marker}` }]);
        }
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });

    await expect(port.ensureHumanComment(
      84, HEAD, REVIEW, GENERATION, 'human', marker, `${marker}\n\nExact body.`,
    ))
      .rejects.toThrow('accepted comment response lost');
  });

  it.skip.each([
    {
      name: 'a durable Human review record',
      remoteOid: RECORD,
      remoteRecord: humanClaim(),
      projectStatus: 'In Review' as const,
      reviews: [],
      error: /authority|Human/i,
    },
    {
      name: 'a projected Human hold',
      remoteOid: REVIEW,
      remoteRecord: terminalClaim(),
      projectStatus: 'Human' as const,
      reviews: [],
      error: /Human/i,
    },
    {
      name: 'an effective native requested-changes blocker',
      remoteOid: REVIEW,
      remoteRecord: terminalClaim(),
      projectStatus: 'In Review' as const,
      reviews: [{
        user: { login: 'late-human-reviewer' },
        state: 'CHANGES_REQUESTED',
        commit_id: HEAD,
        body: 'Arrived after the session checks.',
        submitted_at: '2026-07-20T12:05:00.000Z',
      }],
      error: /requested changes.*block/i,
    },
  ])('fails the production ready boundary closed when $name arrives', async ({
    remoteOid,
    remoteRecord,
    projectStatus,
    reviews,
    error,
  }) => {
    let readyCalls = 0;
    let draft = true;
    const port = makeProductionReviewSessionPort({
      environment: {
        GH_TOKEN: 'selected-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
      readManifest: () => manifest(),
      runner: async (cmd, args) => {
        if (cmd === 'gh' && args.join(' ') === 'api user --jq .login') {
          return 'review-bot\n';
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({
            number: 84,
            state: 'OPEN',
            headRefOid: HEAD,
            headRefName: 'autopilot/42',
            baseRefName: 'next',
            baseRefOid: BASE,
            isDraft: draft,
            body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
            author: { login: 'implementation-bot' },
            labels: [{ name: 'engine:review' }],
            closingIssuesReferences: [{ number: 42 }],
            files: [],
          });
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          return JSON.stringify([{
            number: 84,
            headRefOid: HEAD,
            headRefName: 'autopilot/42',
            closingIssuesReferences: [{ number: 42 }],
          }]);
        }
        if (cmd === 'gh' && args[0] === 'api' && args[1] === 'graphql') {
          return projectSnapshot(projectStatus);
        }
        if (cmd === 'gh' && args[0] === 'api' && args[1]?.endsWith('/reviews')) {
          return JSON.stringify([reviews]);
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'ready') {
          readyCalls += 1;
          draft = false;
          return '';
        }
        if (cmd === 'git' && args.includes('get-url')) {
          return 'https://github.com/Jinn-Network/mono.git\n';
        }
        if (cmd === 'git' && args.includes('ls-remote')) {
          return `${remoteOid}\trefs/jinn-autopilot/review-claims/v1/84\n`;
        }
        if (cmd === 'git' && args.includes('fetch')) return '';
        if (cmd === 'git' && args.includes('show')) {
          return `${encodeReviewClaimPayload(remoteRecord)}\n`;
        }
        if (cmd === 'git' && args.includes('ls-tree')) return '';
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });

    await expect(port.setPullRequestDraft(84, HEAD, false)).rejects.toThrow(error);
    expect(readyCalls).toBe(0);
  });

  it('does not block draft-to-ready on a superseded owned REQUEST_CHANGES review', async () => {
    let readyCalls = 0;
    let reviewReads = 0;
    let draft = true;
    const port = makeProductionReviewSessionPort({
      environment: {
        GH_TOKEN: 'selected-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
      readManifest: () => manifest(),
      runner: async (cmd, args) => {
        if (cmd === 'gh' && args.join(' ') === 'api user --jq .login') {
          return 'review-bot\n';
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({
            number: 84,
            state: 'OPEN',
            headRefOid: HEAD,
            headRefName: 'autopilot/42',
            baseRefName: 'next',
            baseRefOid: BASE,
            isDraft: draft,
            body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
            author: { login: 'implementation-bot' },
            labels: [{ name: 'engine:review' }],
            closingIssuesReferences: [{ number: 42 }],
            files: [],
          });
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          return JSON.stringify([{
            number: 84,
            headRefOid: HEAD,
            headRefName: 'autopilot/42',
            closingIssuesReferences: [{ number: 42 }],
          }]);
        }
        if (cmd === 'gh' && args[0] === 'api' && args[1] === 'graphql') {
          return projectSnapshot('In Review');
        }
        if (cmd === 'gh' && args[0] === 'api' && args[1]?.endsWith('/reviews')) {
          reviewReads += 1;
          return JSON.stringify([[{
            user: { login: 'review-bot' },
            state: 'CHANGES_REQUESTED',
            commit_id: FIX_ONE,
            body: formatAutomatedReviewMarker({
              generation: PRIOR_GENERATION,
              attempt: PRIOR_ATTEMPT,
              intent: MARKER,
              reviewer: 'review-bot',
              head: FIX_ONE,
              verdict: 'REQUEST_CHANGES',
            }),
            submitted_at: '2026-07-20T12:00:10.000Z',
          }, {
            user: { login: 'review-bot' },
            state: 'APPROVED',
            commit_id: HEAD,
            body: formatAutomatedReviewMarker({
              generation: GENERATION,
              attempt: ATTEMPT,
              intent: MARKER,
              reviewer: 'review-bot',
              head: HEAD,
              verdict: 'APPROVE',
            }),
            submitted_at: '2026-07-20T12:00:20.000Z',
          }]]);
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'ready') {
          readyCalls += 1;
          draft = false;
          return '';
        }
        if (cmd === 'git' && args.includes('get-url')) {
          return 'https://github.com/Jinn-Network/mono.git\n';
        }
        if (cmd === 'git' && args.includes('ls-remote')) {
          return `${REVIEW}\trefs/jinn-autopilot/review-claims/v1/84\n`;
        }
        if (cmd === 'git' && args.includes('fetch')) return '';
        if (cmd === 'git' && args.includes('show')) {
          return `${encodeReviewClaimPayload(terminalClaim())}\n`;
        }
        if (cmd === 'git' && args.includes('ls-tree')) return '';
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });

    await expect(port.setPullRequestDraft(84, HEAD, false)).resolves.toBeUndefined();
    expect(readyCalls).toBe(1);
    expect(reviewReads).toBe(1);
  });

  it.each([
    {
      name: 'the current approval is missing',
      currentState: undefined,
      error: /current-head approval/i,
    },
    {
      name: 'the current approval is dismissed',
      currentState: 'DISMISSED',
      error: /current-head approval/i,
    },
    {
      name: 'the current approval marker is malformed',
      currentState: 'APPROVED',
      currentBody: '<!-- jinn-autopilot-review:v2 malformed -->',
      error: /current-head approval/i,
    },
    {
      name: 'another reviewer has an effective requested-changes blocker',
      currentState: 'APPROVED',
      foreignBlocker: true,
      error: /requested changes.*block/i,
    },
  ])('does not ready when $name', async ({
    currentState,
    currentBody,
    foreignBlocker,
    error,
  }) => {
    let readyCalls = 0;
    let reviewReads = 0;
    let draft = true;
    const reviews = [{
      user: { login: 'review-bot' },
      state: 'CHANGES_REQUESTED',
      commit_id: FIX_ONE,
      body: formatAutomatedReviewMarker({
        generation: PRIOR_GENERATION,
        attempt: PRIOR_ATTEMPT,
        intent: MARKER,
        reviewer: 'review-bot',
        head: FIX_ONE,
        verdict: 'REQUEST_CHANGES',
      }),
      submitted_at: '2026-07-20T12:00:10.000Z',
    }];
    if (currentState !== undefined) {
      reviews.push({
        user: { login: 'review-bot' },
        state: currentState,
        commit_id: HEAD,
        body: currentBody ?? formatAutomatedReviewMarker({
          generation: GENERATION,
          attempt: ATTEMPT,
          intent: MARKER,
          reviewer: 'review-bot',
          head: HEAD,
          verdict: 'APPROVE',
        }),
        submitted_at: '2026-07-20T12:00:20.000Z',
      });
    }
    if (foreignBlocker === true) {
      reviews.push({
        user: { login: 'oaksprout' },
        state: 'CHANGES_REQUESTED',
        commit_id: HEAD,
        body: 'Needs changes.',
        submitted_at: '2026-07-20T12:00:30.000Z',
      });
    }
    const port = makeProductionReviewSessionPort({
      environment: {
        GH_TOKEN: 'selected-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
      readManifest: () => manifest(),
      runner: async (cmd, args) => {
        if (cmd === 'gh' && args.join(' ') === 'api user --jq .login') return 'review-bot\n';
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({
            number: 84, state: 'OPEN', headRefOid: HEAD, headRefName: 'autopilot/42',
            baseRefName: 'next', baseRefOid: BASE, isDraft: draft,
            body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
            author: { login: 'implementation-bot' }, labels: [{ name: 'engine:review' }],
            closingIssuesReferences: [{ number: 42 }], files: [],
          });
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          return JSON.stringify([{ number: 84, headRefOid: HEAD, headRefName: 'autopilot/42', closingIssuesReferences: [{ number: 42 }] }]);
        }
        if (cmd === 'gh' && args[0] === 'api' && args[1] === 'graphql') return projectSnapshot('In Review');
        if (cmd === 'gh' && args[0] === 'api' && args[1]?.endsWith('/reviews')) {
          reviewReads += 1;
          return JSON.stringify([reviews]);
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'ready') {
          readyCalls += 1;
          draft = false;
          return '';
        }
        if (cmd === 'git' && args.includes('get-url')) return 'https://github.com/Jinn-Network/mono.git\n';
        if (cmd === 'git' && args.includes('ls-remote')) return `${REVIEW}\trefs/jinn-autopilot/review-claims/v1/84\n`;
        if (cmd === 'git' && args.includes('fetch')) return '';
        if (cmd === 'git' && args.includes('show')) return `${encodeReviewClaimPayload(terminalClaim())}\n`;
        if (cmd === 'git' && args.includes('ls-tree')) return '';
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });

    await expect(port.setPullRequestDraft(84, HEAD, false))
      .rejects.toThrow(error);
    expect(readyCalls).toBe(0);
    expect(reviewReads).toBe(1);
  });

  it('uses gh pagination slurp and exactly flattens every native-review page', async () => {
    const reviewPages = [
      [{
        user: { login: 'reviewer-one' },
        state: 'APPROVED',
        commit_id: HEAD,
        body: 'First page.',
        submitted_at: '2026-07-20T12:00:00.000Z',
      }],
      [{
        user: { login: 'reviewer-two' },
        state: 'CHANGES_REQUESTED',
        commit_id: HEAD,
        body: 'Second page.',
        submitted_at: '2026-07-20T12:01:00.000Z',
      }],
    ];
    let reviewArgs: readonly string[] | undefined;
    const port = makeProductionReviewSessionPort({
      environment: {
        GH_TOKEN: 'selected-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
      readManifest: () => manifest(),
      runner: async (cmd, args) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({
            number: 84,
            state: 'OPEN',
            headRefOid: HEAD,
            headRefName: 'autopilot/42',
            baseRefName: 'next',
            baseRefOid: BASE,
            isDraft: true,
            body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
            author: { login: 'implementation-bot' },
            labels: [{ name: 'engine:review' }],
            closingIssuesReferences: [{ number: 42 }],
            files: [],
          });
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          return JSON.stringify([{
            number: 84,
            headRefOid: HEAD,
            headRefName: 'autopilot/42',
            closingIssuesReferences: [{ number: 42 }],
          }]);
        }
        if (cmd === 'gh' && args[0] === 'api' && args[1]?.endsWith('/reviews')) {
          reviewArgs = args;
          return JSON.stringify(reviewPages);
        }
        if (cmd === 'git' && args.includes('ls-tree')) return '';
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });

    await expect(port.readNativeReviews(84, HEAD)).resolves.toEqual([
      expect.objectContaining({ reviewer: 'reviewer-one', state: 'APPROVED' }),
      expect.objectContaining({
        reviewer: 'reviewer-two',
        state: 'CHANGES_REQUESTED',
      }),
    ]);
    expect(reviewArgs).toEqual([
      'api', 'repos/Jinn-Network/mono/pulls/84/reviews',
      '--paginate', '--slurp',
    ]);
  });

  it('matches Human-comment idempotency by complete canonical body', async () => {
    const marker = '<!-- exact-human-marker -->';
    const canonicalBody = `${marker}\n\nAutopilot parked this review for Human judgment.`;
    const port = makeProductionReviewSessionPort({
      environment: {
        GH_TOKEN: 'selected-secret',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      },
      readManifest: () => manifest(),
      runner: async (cmd, args) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({
            number: 84,
            state: 'OPEN',
            headRefOid: HEAD,
            headRefName: 'autopilot/42',
            baseRefName: 'next',
            baseRefOid: BASE,
            isDraft: true,
            body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
            author: { login: 'implementation-bot' },
            labels: [{ name: 'engine:review' }],
            closingIssuesReferences: [{ number: 42 }],
            files: [],
          });
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          return JSON.stringify([{
            number: 84,
            headRefOid: HEAD,
            headRefName: 'autopilot/42',
            closingIssuesReferences: [{ number: 42 }],
          }]);
        }
        if (cmd === 'gh' && args[0] === 'api' && args[1]?.includes('/comments')) {
          return JSON.stringify([[{ body: `copied ${canonicalBody}` }]]);
        }
        if (cmd === 'git' && args.includes('ls-tree')) return '';
        if (cmd === 'gh' && args.join(' ') === 'api user --jq .login') {
          return 'review-bot\n';
        }
        if (cmd === 'git' && args.includes('get-url')) {
          return 'https://github.com/Jinn-Network/mono.git\n';
        }
        if (cmd === 'git' && args.includes('ls-remote')) {
          return `${REVIEW}\trefs/jinn-autopilot/review-claims/v1/84\n`;
        }
        if (cmd === 'git' && args.includes('fetch')) return '';
        if (cmd === 'git' && args.includes('show')) {
          return `${encodeReviewClaimPayload(humanClaim())}\n`;
        }
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });

    await expect(port.hasHumanComment(
      84, HEAD, REVIEW, GENERATION, 'human', canonicalBody,
    )).resolves.toBe(false);
  });
});
