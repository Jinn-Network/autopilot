import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeAttemptManifest,
} from '../../src/lifecycle/attempt-workspace.js';
import {
  encodeBranchClaimTrailers,
} from '../../src/lifecycle/codecs.js';
import {
  CredentialPool,
} from '../../src/lifecycle/credentials.js';
import {
  makeProductionMarketplaceAdoptionReceiptPorts,
  makeProductionMarketplaceMutationAdoptionCoordinator,
  makeProductionMarketplaceMutationAuthorityPort,
  makeProductionMarketplacePatchPorts,
  secureMarketplaceAdoptionGitHubRunner,
  shouldExcludeWorktreeVerificationCopyPath,
  copyWorktreeForVerification,
} from '../../src/lifecycle/marketplace-mutation-adoption-production.js';
import {
  runMarketplacePatchGit,
} from '../../src/lifecycle/marketplace-patch.js';
import {
  buildJinnMonoV1VerificationPlan,
  marketplaceVerificationPlanDigest,
} from '../../src/lifecycle/marketplace-mutation-verification.js';
import {
  buildMarketplaceVerificationDockerInvocation,
  createProductionMarketplaceVerificationPort,
  JINN_MONO_V1_VERIFICATION_NODE_IMAGE,
} from '../../src/lifecycle/marketplace-mutation-verification-production.js';
import {
  buildMarketplaceTaskRequest,
  persistMarketplaceTaskRequest,
} from '../../src/lifecycle/marketplace-task.js';
import { gitOid, gitRefName } from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));
const directories: string[] = [];

function snapshotForMapping(
  mapping: {
    readonly status: 'resolved' | 'ambiguous' | 'missing';
    readonly issueNumber?: number;
    readonly issueNumbers?: number[];
    readonly labels?: readonly string[];
    readonly blockedOn?: 'Nothing' | 'Human';
    readonly isDraft?: boolean;
  },
) {
  const issueNumber = mapping.issueNumber ?? 2001;
  const blockedOn = mapping.blockedOn ?? 'Nothing';
  const isDraft = mapping.isDraft ?? false;
  const base = {
    capturedAt: '2026-07-24T12:00:00.000Z',
    snapshotComplete: true,
    issues: [{
      number: issueNumber,
      title: 'Implement contracts',
      labels: mapping.labels ?? [],
      shape: 'feat' as const,
      blockedOn,
      blockedByIssues: [],
      effort: 'High' as const,
      priority: 'P1' as const,
      status: 'Todo' as const,
      onBoard: true,
      author: 'jinn-autopilot',
      projectItemId: 'PVTI_issue',
      inCurrentSprint: false,
    }],
    project: {
      rateLimit: { remaining: 5000, used: 1, resetAt: '2026-07-24T13:00:00.000Z' },
      currentSprintIterationId: null,
      items: [{
        id: 'PVTI_issue',
        number: issueNumber,
        contentType: 'Issue' as const,
        status: 'Todo' as const,
        priority: 'P1' as const,
        effort: 'High' as const,
        blockedOn,
        issueType: 'feat' as const,
        blockedByIssues: [],
        sprintIterationId: null,
      }],
    },
    branches: [],
    diagnostics: [],
    pullRequests: [{
      number: 2101,
      title: 'Implement contracts',
      body: '',
      author: 'jinn-autopilot',
      baseRefName: 'next',
      headRefName: 'codex/issue-2001',
      headOid: HEAD,
      headCommittedAt: '2026-07-24T12:00:00.000Z',
      isDraft,
      state: 'OPEN' as const,
      labels: mapping.labels ?? [],
      closingIssueNumbers: [issueNumber],
      mergeability: 'MERGEABLE' as const,
      mergeStateStatus: 'CLEAN',
      checks: [],
      reviews: [],
    }],
    lifecycle: {
      items: [{
        kind: 'pull-request' as const,
        issueNumber,
        prNumber: 2101,
        v2Marked: true,
        projectStatus: 'Todo' as const,
        labels: mapping.labels ?? [],
        head: HEAD,
        headChangedAt: '2026-07-24T12:00:00.000Z',
        isDraft,
        merged: false,
        needsReview: true,
        approved: false,
        mergeState: 'clean' as const,
      }],
    },
  };
  if (mapping.status === 'missing') {
    return { ...base, pullRequestMappings: [] };
  }
  if (mapping.status === 'ambiguous') {
    return {
      ...base,
      pullRequestMappings: [{
        status: 'ambiguous' as const,
        prNumber: 2101,
        issueNumbers: mapping.issueNumbers ?? [2001, 2002],
        details: ['PR maps to multiple issues'],
      }],
    };
  }
  return {
    ...base,
    pullRequestMappings: [{
      status: 'resolved' as const,
      prNumber: 2101,
      issueNumber,
      expectedBaseRefName: 'next',
      evidence: 'closing-reference' as const,
    }],
  };
}

function credentialPool(): CredentialPool {
  return new CredentialPool([{
    login: 'jinn-autopilot',
    normalizedLogin: 'jinn-autopilot',
    implementationToken: 'implementation-secret',
    reviewToken: 'review-secret',
  }]);
}

function mutatingGhApiVerbsInCall(call: readonly unknown[]): string[] {
  if (call[0] !== 'gh') return [];
  const args = (call[1] ?? []) as readonly string[];
  if (!args.includes('api')) return [];
  const mutating = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
  return args.filter((arg) => mutating.has(arg));
}

function expectNoMutatingGhApiCalls(
  calls: readonly (readonly unknown[])[],
): void {
  const violations = calls.flatMap((call) => mutatingGhApiVerbsInCall(call));
  expect(violations).toEqual([]);
}

function authorityRunner(manifest: ReturnType<typeof fixture>['manifest']) {
  return vi.fn(async (
    command: string,
    args: string[],
    options?: { readonly env?: Record<string, string> },
  ) => {
    if (command === 'gh' && args[0] === 'pr') {
      return JSON.stringify({
        number: 2101,
        headRefOid: HEAD,
        headRefName: 'codex/issue-2001',
        baseRefName: 'next',
        isDraft: false,
        labels: [],
        body: '',
        state: 'OPEN',
      });
    }
    if (command === 'gh' && args[0] === 'api') {
      const path = args[1] ?? '';
      if (path.includes('/pulls/2101/files')) {
        return JSON.stringify([[]]);
      }
      if (path.includes('/pulls/2101')) {
        return JSON.stringify({
          changed_files: 0,
          head: { sha: HEAD },
          base: { ref: 'next', sha: '4'.repeat(40) },
        });
      }
      if (path.includes('/contents/.github/CODEOWNERS')) {
        return JSON.stringify({
          encoding: 'base64',
          content: Buffer.from('/\n').toString('base64'),
        });
      }
    }
    if (command === 'git') {
      if (args.includes('remote') && args.includes('get-url')) {
        return 'https://github.com/Jinn-Network/mono.git\n';
      }
      if (args.includes('ls-remote')) {
        return `${manifest.claimOid}\trefs/heads/codex/issue-2001\n`;
      }
      if (args.includes('fetch')) return '';
      if (args.includes('rev-list')) return `${manifest.claimOid}\n`;
      if (args.includes('rev-parse')) return `${HEAD}\n`;
      if (args.includes('show')) {
        return [
          'Autopilot implementation claim',
          '',
          encodeBranchClaimTrailers({
            kind: 'branch-claim',
            protocolVersion: 2,
            phase: 'implement',
            issueNumber: 2001,
            prNumber: 2101,
            attempt: '123e4567-e89b-42d3-a456-426614174001',
            runner: 'runner-1',
            login: 'jinn-autopilot',
            expectedHead: HEAD,
            targetBase: gitRefName('next'),
            claimedAt: '2026-07-24T12:00:00.000Z',
          }),
        ].join('\n');
      }
    }
    if (command === 'gh' && args.includes('user')) return 'jinn-autopilot\n';
    if (command === 'gh' && args.some((arg) => arg.includes('comments'))) return '[]';
    void options;
    throw new Error(`unexpected ${command} ${args.join(' ')}`);
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'jinn-adoption-production-'));
  directories.push(root);
  const manifestPath = join(root, 'manifest.json');
  const tokenFile = join(root, 'gh-token');
  const requestPath = join(root, 'marketplace-request.json');
  writeFileSync(tokenFile, 'attempt-secret\n', { mode: 0o600 });
  const built = buildMarketplaceTaskRequest({
    workflow: 'implementation',
    repository: 'Jinn-Network/mono',
    language: 'typescript',
    verificationProfile: 'jinn-mono.v1',
    issueNumber: 2001,
    prNumber: 2101,
    targetBase: 'next',
    branch: 'codex/issue-2001',
    claimOid: '2'.repeat(40),
    expectedHead: HEAD,
    v2AttemptId: '123e4567-e89b-42d3-a456-426614174001',
    runnerId: 'runner-1',
    taskSnapshot: {
      title: 'Implement contracts',
      body: 'Body',
      prBody: '<!-- jinn-autopilot:v2 issue=2001 branch=codex/issue-2001 -->',
      baseSha: 'a'.repeat(40),
      targetBaseOid: 'b'.repeat(40),
    },
    receiptAuthors: ['jinn-autopilot'],
    createdAt: Date.parse('2026-07-24T12:00:00.000Z'),
  });
  const persisted = persistMarketplaceTaskRequest(requestPath, built.request);
  const requestDigest = persisted.requestDigest;
  const manifest = decodeAttemptManifest({
    version: 2,
    attemptId: '123e4567-e89b-42d3-a456-426614174001',
    runnerId: 'runner-1',
    host: 'host-1',
    phase: 'implement',
    subject: 'issue-2001',
    issueNumber: 2001,
    prNumber: 2101,
    branch: 'codex/issue-2001',
    targetBase: 'next',
    expectedHead: HEAD,
    claimOid: '2'.repeat(40),
    selectedLogin: 'jinn-autopilot',
    repository: {
      root,
      gitCommonDir: join(root, '.git'),
      remoteName: 'jinn-autopilot-v2',
      remoteUrlHash: 'c'.repeat(64),
    },
    execution: {
      backend: 'marketplace',
      state: {
        schemaVersion: 'marketplace-execution-v3',
        status: 'submitted',
        requestPath,
        requestDigest,
        solverNetSelectionPath: persisted.solverNetSelectionPath,
        preparedAt: '2026-07-24T12:00:00.000Z',
        agentSoftDeadline: '2026-07-24T13:00:00.000Z',
        adoptionDeadline: '2026-07-24T14:00:00.000Z',
        submission: {
          schemaVersion: 1,
          generatedAt: '2026-07-24T12:00:00.000Z',
          verb: 'tasks submit',
          id: 'autopilot:123e4567-e89b-42d3-a456-426614174001',
          creatorMultisig: `0x${'a'.repeat(40)}`,
          taskId: '501',
          taskCid: 'bafybeigdyrzt5m6u2r3o4exampletaskcid',
          creationTx: `0x${'d'.repeat(64)}`,
          creationBlock: 501,
          solverNetManifestCid: 'bafybeigdyrzt5m6u2r3o4examplesolvercid',
          status: 'submitted',
          idempotent: false,
        },
        submittedAt: '2026-07-24T12:00:00.000Z',
      },
    },
    processState: 'running',
    pid: 42,
    paths: {
      attemptDir: root,
      worktree: join(root, 'worktree'),
      manifest: manifestPath,
      log: join(root, 'session.log'),
      ghConfigDir: join(root, 'gh-config'),
      askpass: join(root, 'askpass.sh'),
      tokenFile,
    },
    timestamps: {
      createdAt: '2026-07-24T12:00:00.000Z',
      updatedAt: '2026-07-24T12:00:00.000Z',
      childStartedAt: '2026-07-24T12:00:00.000Z',
    },
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return { manifest, manifestPath, requestDigest };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('production marketplace adoption receipt ports', () => {
  it('uses the attempt credential and preserves exact-head comment readback', async () => {
    const { manifest } = fixture();
    const calls: Array<{
      readonly command: string;
      readonly args: readonly string[];
      readonly environment: Readonly<Record<string, string>>;
    }> = [];
    const runner = vi.fn(async (
      command: string,
      args: string[],
      options?: { readonly env?: Record<string, string> },
    ) => {
      calls.push({
        command,
        args,
        environment: options?.env ?? {},
      });
      if (args[0] === 'pr') {
        return JSON.stringify({
          number: 2101,
          headRefOid: HEAD,
          headRefName: 'codex/issue-2001',
          baseRefName: 'next',
          isDraft: false,
          labels: [],
          body: '',
          state: 'OPEN',
        });
      }
      if (args.includes('POST')) return JSON.stringify({ id: 73, user: { login: 'jinn-autopilot' } });
      return JSON.stringify([
        {
          id: 72,
          user: { login: 'jinn-autopilot' },
          body: 'receipt',
          created_at: '2026-07-24T12:01:00.000Z',
          updated_at: '2026-07-24T12:01:00.000Z',
        },
      ]);
    });
    const ports = makeProductionMarketplaceAdoptionReceiptPorts({
      manifestPath: manifest.paths.manifest,
      runner,
      environment: {
        PATH: '/usr/bin',
        GITHUB_TOKEN: 'ambient-secret',
      },
    });

    await expect(ports.listPrIssueComments({ prNumber: 2101 }))
      .resolves.toEqual({
        comments: [{
          id: 72,
          authorLogin: 'jinn-autopilot',
          body: 'receipt',
          createdAt: '2026-07-24T12:01:00.000Z',
          updatedAt: '2026-07-24T12:01:00.000Z',
        }],
      });
    await expect(ports.verifyReceiptFacts({
      expected: {
        role: 'solution',
        correlation: {
          taskId: '501',
          attemptIndex: 0,
          requestId: 'request',
          deliveryEnvelopeCid: 'bafy-envelope',
          v2AttemptId: manifest.attemptId,
          claimOid: gitOid(manifest.claimOid),
          prNumber: 2101,
          expectedHead: HEAD,
        },
        prNumber: 2101,
        publicationHead: HEAD,
        receiptAuthors: ['jinn-autopilot'],
        disposition: 'rejected',
        reason: 'stale-head',
      },
      receipt: {
        schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
        disposition: 'rejected',
        role: 'solution',
        taskId: '501',
        attemptIndex: 0,
        requestId: 'request',
        deliveryEnvelopeCid: 'bafy-envelope',
        v2AttemptId: manifest.attemptId,
        claimOid: manifest.claimOid,
        prNumber: 2101,
        expectedHead: HEAD,
        reason: 'stale-head',
        detail: 'stale head',
        recordedAt: '2026-07-24T12:01:00.000Z',
      },
    })).resolves.toBe(true);
    await expect(ports.createPrComment({
      prNumber: 2101,
      expectedHead: HEAD,
      body: 'canonical receipt',
    })).resolves.toEqual({ commentId: 73, author: 'jinn-autopilot' });
    expect(calls).not.toHaveLength(0);
    for (const call of calls) {
      expect(call.environment.GH_TOKEN).toBe('attempt-secret');
      expect(call.environment.GITHUB_TOKEN).toBe('');
    }
  });

  it('fails closed when the PR head changes during receipt publication', async () => {
    const { manifest } = fixture();
    let headReads = 0;
    const runner = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === 'pr') {
        headReads += 1;
        return JSON.stringify({
          number: 2101,
          headRefOid: headReads === 1 ? HEAD : '9'.repeat(40),
          headRefName: 'codex/issue-2001',
          baseRefName: 'next',
          isDraft: false,
          labels: [],
          body: '',
          state: 'OPEN',
        });
      }
      return JSON.stringify({ id: 73, user: { login: 'jinn-autopilot' } });
    });
    const ports = makeProductionMarketplaceAdoptionReceiptPorts({
      manifestPath: manifest.paths.manifest,
      runner,
    });

    await expect(ports.createPrComment({
      prNumber: 2101,
      expectedHead: HEAD,
      body: 'canonical receipt',
    })).rejects.toThrow(
      'Marketplace adoption receipt head changed during publication',
    );
  });
});

describe('production marketplace mutation authority port', () => {
  it('rejects ambiguous canonical mapping from the lifecycle snapshot', async () => {
    const { manifest, manifestPath } = fixture();
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === 'gh' && args[0] === 'pr') {
        return JSON.stringify({
          number: 2101,
          headRefOid: HEAD,
          headRefName: 'codex/issue-2001',
          baseRefName: 'next',
          isDraft: false,
          labels: [],
          body: '',
          state: 'OPEN',
        });
      }
      if (command === 'git') {
        if (args.includes('remote') && args.includes('get-url')) {
          return 'https://github.com/Jinn-Network/mono.git\n';
        }
        if (args.includes('ls-remote')) {
          return `${manifest.claimOid}\trefs/heads/codex/issue-2001\n`;
        }
        if (args.includes('fetch')) return '';
        if (args.includes('rev-list')) return `${manifest.claimOid}\n`;
        if (args.includes('rev-parse')) return `${HEAD}\n`;
        if (args.includes('show')) {
          return [
            'Autopilot implementation claim',
            '',
            encodeBranchClaimTrailers({
              kind: 'branch-claim',
              protocolVersion: 2,
              phase: 'implement',
              issueNumber: 2001,
              prNumber: 2101,
              attempt: '123e4567-e89b-42d3-a456-426614174001',
              runner: 'runner-1',
              login: 'jinn-autopilot',
              expectedHead: HEAD,
              targetBase: gitRefName('next'),
              claimedAt: '2026-07-24T12:00:00.000Z',
            }),
          ].join('\n');
        }
      }
      if (command === 'gh' && args.includes('user')) return 'jinn-autopilot\n';
      if (command === 'gh' && args.some((arg) => arg.includes('comments'))) return '[]';
      throw new Error(`unexpected ${command} ${args.join(' ')}`);
    });
    const port = makeProductionMarketplaceMutationAuthorityPort({
      originManifestPath: manifestPath,
      repositoryPath: manifest.repository.root,
      worktreeBase: '/tmp/worktrees',
      runnerId: manifest.runnerId,
      readSnapshot: async () => ({
        snapshotComplete: true,
        issues: [],
        pullRequests: [],
        project: { items: [] },
        lifecycle: { items: [] },
        diagnostics: [],
        pullRequestMappings: [{
          status: 'ambiguous',
          prNumber: 2101,
          issueNumbers: [2001, 2002],
          details: ['PR maps to multiple issues'],
        }],
      } as never),
      runner,
      environment: { PATH: '/usr/bin' },
    });

    const authority = await port.readExactAuthority({
      manifestPath,
      touchedPaths: [],
    });
    expect(authority.pullRequest.mappingStatus).toBe('ambiguous');
    expect(authority.pullRequest.canonicalIssueNumber).toBe(2001);
    expect(authority.receiptAuthors).toEqual(['jinn-autopilot']);
  });

  it('isolates attempt credentials from ambient GitHub tokens', () => {
    const { manifestPath } = fixture();
    const runner = vi.fn(async () => '');
    const secure = secureMarketplaceAdoptionGitHubRunner(
      manifestPath,
      runner,
      { GH_TOKEN: 'ambient', GITHUB_TOKEN: 'also-ambient', PATH: '/usr/bin' },
    );
    secure('gh', ['api', 'user']);
    expect(runner).toHaveBeenCalledWith(
      'gh',
      ['api', 'user'],
      expect.objectContaining({
        env: expect.objectContaining({
          GH_TOKEN: 'attempt-secret',
          GITHUB_TOKEN: '',
        }),
      }),
    );
  });
});

describe('production marketplace patch application ports', () => {
  it('wires the hardened marketplace patch git runner into production applyPatch', () => {
    const ports = makeProductionMarketplacePatchPorts({
      prove: async () => { throw new Error('unused'); },
    });
    expect(ports.runGit).toBe(runMarketplacePatchGit);
  });
});

describe('makeProductionMarketplaceMutationAdoptionCoordinator', () => {
  it('does not require review credentials before an evaluator manifest exists', () => {
    const { manifestPath } = fixture();
    expect(() => makeProductionMarketplaceMutationAdoptionCoordinator({
      originManifestPath: manifestPath,
      repositoryPath: '/repo',
      worktreeBase: '/tmp/worktrees',
      runnerId: 'runner-1',
      credentials: credentialPool(),
      readSnapshot: async () => ({ snapshotComplete: true } as never),
      staleAfterMs: 60_000,
      environment: {
        PATH: '/usr/bin',
      },
      verification: {
        preflight: async () => ({ ok: true }),
        verify: async () => {
          throw new Error('verification must not run during construction');
        },
      },
    })).not.toThrow();
  });

  it('constructs a coordinator with production ports', () => {
    const { manifestPath } = fixture();
    const coordinator = makeProductionMarketplaceMutationAdoptionCoordinator({
      originManifestPath: manifestPath,
      repositoryPath: '/repo',
      worktreeBase: '/tmp/worktrees',
      runnerId: 'runner-1',
      credentials: { logins: () => ['jinn-autopilot'] } as never,
      readSnapshot: async () => ({ snapshotComplete: true } as never),
      staleAfterMs: 60_000,
      environment: {
        JINN_AUTOPILOT_SESSION_MANIFEST: manifestPath,
        GH_TOKEN: 'attempt-secret',
      },
      verification: {
        preflight: async () => ({ ok: true }),
        verify: async () => {
          throw new Error('verification must not run during construction');
        },
      },
    });
    expect(coordinator.adopt).toBeTypeOf('function');
  });

  it('wires the default docker sandbox with inspector instead of a success stub', async () => {
    const verificationModule = await import(
      '../../src/lifecycle/marketplace-mutation-verification-production.js'
    );
    const spy = vi.spyOn(verificationModule, 'createProductionMarketplaceVerificationPort');
    const { manifestPath } = fixture();
    makeProductionMarketplaceMutationAdoptionCoordinator({
      originManifestPath: manifestPath,
      repositoryPath: '/repo',
      worktreeBase: '/tmp/worktrees',
      runnerId: 'runner-1',
      credentials: credentialPool(),
      readSnapshot: async () => ({ snapshotComplete: true } as never),
      staleAfterMs: 60_000,
      environment: {
        PATH: '/usr/bin',
        JINN_AUTOPILOT_SESSION_MANIFEST: manifestPath,
      },
    });
    expect(spy).toHaveBeenCalledOnce();
    const portOptions = spy.mock.calls[0]![0];
    expect(portOptions.dockerInspector).toBeDefined();
    expect(portOptions.dockerRunner).toBeDefined();
    spy.mockRestore();
  });
});

describe('production worktree verification copy filter', () => {
  it('excludes only the .git directory, not .gitignore or .github paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-adoption-copy-filter-'));
    directories.push(root);
    const gitDir = join(root, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'node_modules\n');
    mkdirSync(join(root, '.github'), { recursive: true });
    writeFileSync(join(root, '.github', 'CODEOWNERS'), '/\n');
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

    expect(shouldExcludeWorktreeVerificationCopyPath(root, join(root, '.gitignore')))
      .toBe(false);
    expect(shouldExcludeWorktreeVerificationCopyPath(root, join(root, '.github', 'CODEOWNERS')))
      .toBe(false);
    expect(shouldExcludeWorktreeVerificationCopyPath(root, gitDir)).toBe(true);
    expect(shouldExcludeWorktreeVerificationCopyPath(root, join(gitDir, 'HEAD'))).toBe(true);
  });

  it('copies .gitignore and .github while omitting .git metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-adoption-copy-'));
    const workspace = join(root, 'workspace');
    directories.push(root);
    const gitDir = join(root, 'source', '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(root, 'source', '.gitignore'), 'dist\n');
    mkdirSync(join(root, 'source', '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, 'source', '.github', 'workflows', 'ci.yml'), 'on: push\n');
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

    await copyWorktreeForVerification(join(root, 'source'), workspace);
    expect(existsSync(join(workspace, '.gitignore'))).toBe(true);
    expect(existsSync(join(workspace, '.github', 'workflows', 'ci.yml'))).toBe(true);
    expect(existsSync(join(workspace, '.git', 'HEAD'))).toBe(false);
  });

  it('preserves relative skill symlinks for repository tests', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jinn-adoption-copy-symlink-'));
    const source = join(root, 'source');
    const workspace = join(root, 'workspace');
    directories.push(root);
    mkdirSync(join(source, '.claude', 'skills', 'runtime'), { recursive: true });
    mkdirSync(join(source, '.codex', 'skills'), { recursive: true });
    writeFileSync(join(source, '.claude', 'skills', 'runtime', 'SKILL.md'), '# runtime\n');
    symlinkSync('../../.claude/skills/runtime', join(source, '.codex', 'skills', 'runtime'));

    await copyWorktreeForVerification(source, workspace);

    expect(readlinkSync(join(workspace, '.codex', 'skills', 'runtime')))
      .toBe('../../.claude/skills/runtime');
  });
});

describe('production default docker verification sandbox', () => {
  it('builds network-disabled verification docker argv for verify-phase commands', () => {
    const plan = buildJinnMonoV1VerificationPlan({
      repositoryPath: '/repo',
      touchedPaths: ['packages/autopilot/src/engine.ts'],
    });
    const typecheck = plan.commands.find((entry) => entry.label.startsWith('typecheck'));
    if (typecheck === undefined) throw new Error('missing typecheck command');
    const invocation = buildMarketplaceVerificationDockerInvocation({
      repositoryPath: '/repo',
      workspacePath: '/workspace',
      command: typecheck,
      network: 'none',
      environment: { PATH: '/usr/bin', CI: 'true' },
    });
    expect(invocation.argv).toContain('--network');
    expect(invocation.argv[invocation.argv.indexOf('--network') + 1]).toBe('none');
    expect(invocation.argv).toContain(JINN_MONO_V1_VERIFICATION_NODE_IMAGE);
  });

  it('fails closed when the production docker runner returns a non-zero exit code', async () => {
    const port = createProductionMarketplaceVerificationPort({
      dockerRunner: async (invocation) => ({
        exitCode: invocation.label.startsWith('install:') ? 0 : 1,
        stdout: invocation.label,
        stderr: invocation.label.startsWith('install:') ? '' : 'type error',
      }),
      dockerInspector: {
        inspectDaemon: async () => true,
        inspectImage: async () => true,
      },
      cleanup: async () => 'confirmed',
      prepareWorkspace: async () => {},
      now: () => new Date('2020-01-01T00:00:00.000Z'),
    });

    await expect(port.verify({
      profile: 'jinn-mono.v1',
      repositoryPath: '/repo',
      touchedPaths: ['packages/autopilot/src/engine.ts'],
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      expectedTree: gitOid('b'.repeat(40)),
      deadline: '2020-01-01T02:00:00.000Z',
    })).rejects.toMatchObject({
      reason: 'command-failed',
      disposition: 'stable-rejection',
    });
  });

  it('fails closed in verify before docker when the daemon or pinned image is unavailable', async () => {
    const dockerRunner = vi.fn();
    const port = createProductionMarketplaceVerificationPort({
      dockerRunner,
      dockerInspector: {
        inspectDaemon: async () => false,
        inspectImage: async () => true,
      },
      cleanup: async () => 'confirmed',
      prepareWorkspace: async () => {},
      now: () => new Date('2020-01-01T00:00:00.000Z'),
    });

    await expect(port.verify({
      profile: 'jinn-mono.v1',
      repositoryPath: '/repo',
      touchedPaths: ['packages/autopilot/src/engine.ts'],
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      expectedTree: gitOid('b'.repeat(40)),
      deadline: '2020-01-01T02:00:00.000Z',
    })).rejects.toMatchObject({
      reason: 'runner-failed',
      disposition: 'recoverable',
      message: expect.stringMatching(/docker daemon/i),
    });
    expect(dockerRunner).not.toHaveBeenCalled();
  });

  it('honours bounded verification command labels from the jinn-mono.v1 plan', () => {
    const plan = buildJinnMonoV1VerificationPlan({
      repositoryPath: '/repo',
      touchedPaths: ['packages/autopilot/src/engine.ts'],
    });
    expect(plan.commands.map((entry) => entry.label)).toEqual([
      'install:packages/sdk',
      'install:packages/autopilot',
      'build:packages/sdk',
      'typecheck:packages/autopilot',
      'test:packages/autopilot',
    ]);
    expect(marketplaceVerificationPlanDigest(plan)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe('production marketplace authority surfaces', () => {
  it('reuses one authoritative snapshot for mapping and review-candidate facts', async () => {
    const { manifest, manifestPath } = fixture();
    const runner = authorityRunner(manifest);
    const readSnapshot = vi.fn(
      async () => snapshotForMapping({ status: 'resolved' }) as never,
    );
    const port = makeProductionMarketplaceMutationAuthorityPort({
      originManifestPath: manifestPath,
      repositoryPath: manifest.repository.root,
      worktreeBase: '/tmp/worktrees',
      runnerId: manifest.runnerId,
      readSnapshot,
      runner,
      environment: { PATH: '/usr/bin' },
    });

    await port.readExactAuthority({
      manifestPath,
      touchedPaths: [],
    });

    expect(readSnapshot).toHaveBeenCalledTimes(1);
  });

  it('returns live open PR head, branch, base, and claim facts', async () => {
    const { manifest, manifestPath } = fixture();
    const runner = authorityRunner(manifest);
    const port = makeProductionMarketplaceMutationAuthorityPort({
      originManifestPath: manifestPath,
      repositoryPath: manifest.repository.root,
      worktreeBase: '/tmp/worktrees',
      runnerId: manifest.runnerId,
      readSnapshot: async () => snapshotForMapping({ status: 'resolved' }) as never,
      runner,
      environment: { PATH: '/usr/bin' },
    });

    const authority = await port.readExactAuthority({
      manifestPath,
      touchedPaths: [],
    });
    expect(authority.pullRequest).toMatchObject({
      number: 2101,
      head: HEAD,
      headRefName: 'codex/issue-2001',
      baseRefName: 'next',
      open: true,
      mappingStatus: 'resolved',
      canonicalIssueNumber: 2001,
    });
    expect(authority.latestClaimOid).toBe(gitOid(manifest.claimOid));
    expect(authority.remoteHead).toBe(gitOid(manifest.claimOid));
  });

  it('accepts a stacked base when the live PR base matches the session target', async () => {
    const { manifest, manifestPath } = fixture();
    const stackedBase = 'codex/issue-1999';
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === 'gh' && args[0] === 'pr') {
        return JSON.stringify({
          number: 2101,
          headRefOid: HEAD,
          headRefName: 'codex/issue-2001',
          baseRefName: stackedBase,
          isDraft: false,
          labels: [],
          body: '',
          state: 'OPEN',
        });
      }
      return authorityRunner(manifest)(command, args);
    });
    const port = makeProductionMarketplaceMutationAuthorityPort({
      originManifestPath: manifestPath,
      repositoryPath: manifest.repository.root,
      worktreeBase: '/tmp/worktrees',
      runnerId: manifest.runnerId,
      readSnapshot: async () => snapshotForMapping({ status: 'resolved' }) as never,
      runner,
      environment: { PATH: '/usr/bin' },
    });

    const authority = await port.readExactAuthority({
      manifestPath,
      touchedPaths: [],
    });
    expect(authority.pullRequest.baseRefName).toBe(stackedBase);
    expect(authority.latestClaim.targetBase).toBe(gitRefName('next'));
  });

  it('surfaces a retargeted PR base from live GitHub facts', async () => {
    const { manifest, manifestPath } = fixture();
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === 'gh' && args[0] === 'pr') {
        return JSON.stringify({
          number: 2101,
          headRefOid: HEAD,
          headRefName: 'codex/issue-2001',
          baseRefName: 'attacker/retarget',
          isDraft: false,
          labels: [],
          body: '',
          state: 'OPEN',
        });
      }
      return authorityRunner(manifest)(command, args);
    });
    const port = makeProductionMarketplaceMutationAuthorityPort({
      originManifestPath: manifestPath,
      repositoryPath: manifest.repository.root,
      worktreeBase: '/tmp/worktrees',
      runnerId: manifest.runnerId,
      readSnapshot: async () => snapshotForMapping({ status: 'resolved' }) as never,
      runner,
      environment: { PATH: '/usr/bin' },
    });

    const authority = await port.readExactAuthority({
      manifestPath,
      touchedPaths: [],
    });
    expect(authority.pullRequest.baseRefName).toBe('attacker/retarget');
  });

  it('keeps a production-order draft PR separate from Human authority', async () => {
    const { manifest, manifestPath } = fixture();
    const baseline = authorityRunner(manifest);
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === 'gh' && args[0] === 'pr') {
        return JSON.stringify({
          number: 2101,
          headRefOid: HEAD,
          headRefName: 'codex/issue-2001',
          baseRefName: 'next',
          isDraft: true,
          labels: [{ name: 'engine:review' }],
          body: '',
          state: 'OPEN',
        });
      }
      if (
        command === 'gh'
        && args.some((arg) => arg.endsWith('/contents/.github/CODEOWNERS'))
      ) {
        return JSON.stringify({
          encoding: 'base64',
          content: Buffer.from('/SPEC.md @Jinn-Network/codeowners\n').toString('base64'),
        });
      }
      return baseline(command, args);
    });
    const port = makeProductionMarketplaceMutationAuthorityPort({
      originManifestPath: manifestPath,
      repositoryPath: manifest.repository.root,
      worktreeBase: '/tmp/worktrees',
      runnerId: manifest.runnerId,
      readSnapshot: async () => snapshotForMapping({
        status: 'resolved',
        labels: ['engine:review'],
        isDraft: true,
      }) as never,
      runner,
      environment: { PATH: '/usr/bin' },
    });

    const authority = await port.readExactAuthority({
      manifestPath,
      touchedPaths: [],
    });
    expect(authority.pullRequest).toMatchObject({
      draft: true,
      humanActive: false,
      codeOwnerRequired: false,
    });
    expectNoMutatingGhApiCalls(runner.mock.calls);
  });

  it.each(['review:needs-human', 'autopilot:human'])(
    'marks Human dominance from the live %s label without mutating GitHub state',
    async (label) => {
      const { manifest, manifestPath } = fixture();
      const runner = vi.fn(async (command: string, args: string[]) => {
        if (command === 'gh' && args[0] === 'pr') {
          return JSON.stringify({
            number: 2101,
            headRefOid: HEAD,
            headRefName: 'codex/issue-2001',
            baseRefName: 'next',
            isDraft: false,
            labels: [{ name: label }],
            body: '',
            state: 'OPEN',
          });
        }
        return authorityRunner(manifest)(command, args);
      });
      const readSnapshot = vi.fn(async () => snapshotForMapping({
        status: 'resolved',
        labels: [label],
      }) as never);
      const port = makeProductionMarketplaceMutationAuthorityPort({
        originManifestPath: manifestPath,
        repositoryPath: manifest.repository.root,
        worktreeBase: '/tmp/worktrees',
        runnerId: manifest.runnerId,
        readSnapshot,
        runner,
        environment: { PATH: '/usr/bin' },
      });

      const authority = await port.readExactAuthority({
        manifestPath,
        touchedPaths: [],
      });
      expect(authority.pullRequest.humanActive).toBe(true);
      expect(readSnapshot).toHaveBeenCalled();
      expectNoMutatingGhApiCalls(runner.mock.calls);
    },
  );

  it('marks Human dominance from Project Blocked on Human without mutating GitHub state', async () => {
    const { manifest, manifestPath } = fixture();
    const runner = authorityRunner(manifest);
    const port = makeProductionMarketplaceMutationAuthorityPort({
      originManifestPath: manifestPath,
      repositoryPath: manifest.repository.root,
      worktreeBase: '/tmp/worktrees',
      runnerId: manifest.runnerId,
      readSnapshot: async () => snapshotForMapping({
        status: 'resolved',
        blockedOn: 'Human',
      }) as never,
      runner,
      environment: { PATH: '/usr/bin' },
    });

    const authority = await port.readExactAuthority({
      manifestPath,
      touchedPaths: [],
    });
    expect(authority.pullRequest.humanActive).toBe(true);
    expectNoMutatingGhApiCalls(runner.mock.calls);
  });

  it('marks Human dominance from a Human protocol comment without mutating GitHub state', async () => {
    const { manifest, manifestPath } = fixture();
    const baseline = authorityRunner(manifest);
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (
        command === 'gh'
        && args.some((arg) => arg.includes('/issues/2101/comments'))
      ) {
        return JSON.stringify([{
          id: 73,
          user: { login: 'jinn-autopilot' },
          body: '<!-- jinn-autopilot:v2-human issue=2001 -->',
          created_at: '2026-07-24T12:01:00.000Z',
          updated_at: '2026-07-24T12:01:00.000Z',
        }]);
      }
      return baseline(command, args);
    });
    const port = makeProductionMarketplaceMutationAuthorityPort({
      originManifestPath: manifestPath,
      repositoryPath: manifest.repository.root,
      worktreeBase: '/tmp/worktrees',
      runnerId: manifest.runnerId,
      readSnapshot: async () => snapshotForMapping({ status: 'resolved' }) as never,
      runner,
      environment: { PATH: '/usr/bin' },
    });

    const authority = await port.readExactAuthority({
      manifestPath,
      touchedPaths: [],
    });
    expect(authority.pullRequest.humanActive).toBe(true);
    expectNoMutatingGhApiCalls(runner.mock.calls);
  });

  it('marks CODEOWNER review policy from the live review candidate', async () => {
    const { manifest, manifestPath } = fixture();
    const runner = vi.fn(async (command: string, args: string[]) => {
      if (command === 'gh' && args.some((arg) => arg === `repos/Jinn-Network/mono/pulls/2101`)) {
        return JSON.stringify({
          changed_files: 1,
          head: { sha: HEAD },
          base: { ref: 'next', sha: '4'.repeat(40) },
        });
      }
      if (command === 'gh' && args.some((arg) => arg.includes('/pulls/2101/files'))) {
        return JSON.stringify([
          [{ filename: 'packages/autopilot/src/engine.ts' }],
        ]);
      }
      if (command === 'gh' && args.some((arg) => arg.endsWith('/contents/.github/CODEOWNERS'))) {
        return JSON.stringify({
          encoding: 'base64',
          content: Buffer.from('/packages/autopilot/ @Jinn-Network/codeowners\n').toString('base64'),
        });
      }
      return authorityRunner(manifest)(command, args);
    });
    const port = makeProductionMarketplaceMutationAuthorityPort({
      originManifestPath: manifestPath,
      repositoryPath: manifest.repository.root,
      worktreeBase: '/tmp/worktrees',
      runnerId: manifest.runnerId,
      readSnapshot: async () => snapshotForMapping({ status: 'resolved' }) as never,
      runner,
      environment: { PATH: '/usr/bin' },
    });
    const authority = await port.readExactAuthority({
      manifestPath,
      touchedPaths: ['packages/autopilot/src/engine.ts'],
    });
    expect(authority.pullRequest.codeOwnerRequired).toBe(true);
    expectNoMutatingGhApiCalls(runner.mock.calls);
  });

  it('reads authority through the implementation session manifest binding', async () => {
    const { manifest, manifestPath } = fixture();
    const runner = authorityRunner(manifest);
    const port = makeProductionMarketplaceMutationAuthorityPort({
      originManifestPath: manifestPath,
      repositoryPath: manifest.repository.root,
      worktreeBase: '/tmp/worktrees',
      runnerId: manifest.runnerId,
      readSnapshot: async () => snapshotForMapping({ status: 'resolved' }) as never,
      runner,
      environment: {
        PATH: '/usr/bin',
        GH_TOKEN: 'ambient-secret',
        GITHUB_TOKEN: 'also-ambient',
        JINN_AUTOPILOT_SESSION_MANIFEST: '/wrong-manifest.json',
      },
    });

    await port.readExactAuthority({ manifestPath, touchedPaths: [] });
    const ghCalls = runner.mock.calls.filter((call) => call[0] === 'gh');
    const prViewCall = ghCalls.find((call) => call[1][0] === 'pr');
    expect(prViewCall).toBeDefined();
    expect(prViewCall?.[2]?.env?.GH_TOKEN).toBe('attempt-secret');
    expect(prViewCall?.[2]?.env?.GITHUB_TOKEN).toBe('');
  });
});
