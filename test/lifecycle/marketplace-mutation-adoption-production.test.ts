import {
  mkdtempSync,
  rmSync,
  writeFileSync,
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
  makeProductionMarketplaceAdoptionReceiptPorts,
  makeProductionMarketplaceMutationAdoptionCoordinator,
  makeProductionMarketplaceMutationAuthorityPort,
  secureMarketplaceAdoptionGitHubRunner,
} from '../../src/lifecycle/marketplace-mutation-adoption-production.js';
import {
  buildMarketplaceTaskRequest,
  persistMarketplaceTaskRequest,
} from '../../src/lifecycle/marketplace-task.js';
import { gitOid, gitRefName } from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));
const directories: string[] = [];

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

describe('makeProductionMarketplaceMutationAdoptionCoordinator', () => {
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
});
