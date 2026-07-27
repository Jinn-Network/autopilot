import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultRunner } from '../../src/dispatcher/issue-source.js';
import { CredentialPool, SelectedCredential } from '../../src/lifecycle/credentials.js';
import {
  createAttemptWorkspace,
  readAttemptManifest,
} from '../../src/lifecycle/attempt-workspace.js';
import { installMarketplaceEvaluatorLeg } from '../../src/lifecycle/marketplace-adoption-state.js';
import {
  anchorMarketplaceEvaluatorReview,
  releaseMarketplaceReviewAnchor,
} from '../../src/lifecycle/marketplace-review-anchor.js';
import type {
  ReviewActionCandidate,
  ReviewClaimAcquisitionDeps,
} from '../../src/lifecycle/review-executor.js';
import type { ReviewSessionPort } from '../../src/lifecycle/review-session.js';
import { gitOid, gitRefName } from '../../src/lifecycle/types.js';

const ORIGIN_ATTEMPT = '11111111-1111-4111-8111-111111111111';
const REVIEW_ATTEMPT = '22222222-2222-4222-8222-222222222222';
const GENERATION = '33333333-3333-4333-8333-333333333333';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const NOW = '2026-07-27T12:07:00.000Z';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function repositoryFixture(): {
  root: string;
  repo: string;
  remote: string;
  base: string;
  oid: string;
  runnerId: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'marketplace-review-anchor-'));
  roots.push(root);
  const remote = join(root, 'remote.git');
  const repo = join(root, 'repo');
  const base = join(root, 'worktrees');
  execFileSync('git', ['init', '--bare', remote]);
  execFileSync('git', ['init', repo]);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'base']);
  git(repo, ['branch', '-M', 'main']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-u', 'origin', 'main']);
  return {
    root,
    repo,
    remote,
    base,
    oid: git(repo, ['rev-parse', 'HEAD']),
    runnerId: 'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  };
}

function buildCandidate(
  head: string,
  overrides: Partial<ReviewActionCandidate> = {},
): ReviewActionCandidate {
  return {
    issueNumber: 42,
    number: 84,
    open: true,
    head: gitOid(head),
    headChangedAt: '2026-07-20T08:00:00.000Z',
    headRefName: gitRefName('autopilot/42'),
    baseRefName: gitRefName('next'),
    draft: false,
    author: 'implementation-bot',
    labels: ['engine:review'],
    body: 'Closes #42',
    humanHold: false,
    approvalPolicy: 'approve-eligible',
    nativeReviews: [],
    ...overrides,
  };
}

function claimAcquisition(
  head: string,
  overrides: Partial<ReviewClaimAcquisitionDeps> = {},
): ReviewClaimAcquisitionDeps {
  const recordOid = gitOid('3'.repeat(40));
  const confirmed = buildCandidate(head);
  return {
    readCandidate: async () => confirmed,
    confirmAcquisition: async ({ expectedHead, expectedReviewRefOid }) => buildCandidate(expectedHead, {
      reviewRef: {
        oid: expectedReviewRefOid,
        record: {
          kind: 'review-claim',
          protocolVersion: 2,
          prNumber: 84,
          generation: GENERATION,
          attempt: REVIEW_ATTEMPT,
          reviewer: 'review-bot',
          head: expectedHead,
          state: 'active',
          recordedAt: NOW,
        },
      },
    }),
    credentials: new CredentialPool([{
      login: 'review-bot',
      normalizedLogin: 'review-bot',
      reviewToken: 'review-secret',
    }]),
    createReviewRecord: async () => recordOid,
    publishReviewClaim: async () => ({
      status: 'won',
      expected: null,
      published: recordOid,
      observed: recordOid,
    }),
    createAttempt: async (input) => ({
      attemptId: input.attemptId,
      paths: {
        worktree: '/tmp/worktree',
        manifest: `/tmp/${input.attemptId}/manifest.json`,
        log: '/tmp/session.log',
        ghConfigDir: '/tmp/gh-config',
        askpass: '/tmp/askpass',
      },
    }),
    repairProjection: async () => {},
    escalateHuman: async () => {},
    ambientEnvironment: {},
    nextAttemptId: () => REVIEW_ATTEMPT,
    nextGeneration: () => GENERATION,
    runnerId: 'runner-a',
    now: () => new Date(NOW),
    staleAfterMs: 3_600_000,
    sleep: async () => {},
    ...overrides,
  };
}

function originManifestPath(fixture: ReturnType<typeof repositoryFixture>): string {
  return join(
    fixture.base,
    'v2',
    fixture.runnerId,
    'implement',
    `issue-42-${ORIGIN_ATTEMPT}`,
    'manifest.json',
  );
}

describe('marketplace review anchor', () => {
  it('recovers an exact existing anchored evaluator-leg review', async () => {
    const fixture = repositoryFixture();
    const credential = new SelectedCredential('review-bot', 'review', 'review-secret');
    const originPath = originManifestPath(fixture);
    const reviewManifest = await createAttemptWorkspace({
      repositoryPath: fixture.repo,
      worktreeBase: fixture.base,
      runnerId: fixture.runnerId,
      phase: 'review',
      subject: 'pr-84',
      issueNumber: 42,
      prNumber: 84,
      branch: 'autopilot/42',
      targetBase: 'next',
      expectedHead: fixture.oid,
      claimOid: fixture.oid,
      reviewGeneration: GENERATION,
      reviewRefOid: fixture.oid,
      reviewApprovalPolicy: 'approve-eligible',
      selectedLogin: 'review-bot',
      credential,
      attemptId: REVIEW_ATTEMPT,
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v2',
          status: 'prepared',
          requestPath: join(fixture.root, 'evaluator-leg.request.json'),
          requestDigest: DIGEST,
          solverNetSelectionPath: join(fixture.root, 'evaluator-leg.solvernet-selection.json'),
          preparedAt: NOW,
          agentSoftDeadline: '2026-07-27T13:07:00.000Z',
          adoptionDeadline: '2026-07-27T14:07:00.000Z',
        },
      },
      now: () => new Date(NOW),
    }, defaultRunner);
    installMarketplaceEvaluatorLeg(
      reviewManifest.paths.manifest,
      {
        originManifestPath: originPath,
        originV2AttemptId: ORIGIN_ATTEMPT,
        originRequestDigest: DIGEST,
        taskId: '501',
        taskCid: 'bafybeigdyrzt5m6u2r3o4exampletaskcid',
        taskCreationBlock: 501,
        prNumber: 84,
        expectedHead: fixture.oid,
        generation: GENERATION,
        reviewRefOid: fixture.oid,
        reviewer: 'review-bot',
      },
      () => new Date(NOW),
    );
    const installed = readAttemptManifest(reviewManifest.paths.manifest);
    const legState = installed.execution.state;
    expect(legState.schemaVersion).toBe('marketplace-evaluator-leg-v1');
    const result = await anchorMarketplaceEvaluatorReview({
      origin: {
        originManifestPath: legState.originManifestPath,
        originV2AttemptId: legState.originV2AttemptId,
        originRequestDigest: legState.originRequestDigest,
        taskId: legState.taskId,
        taskCid: legState.taskCid,
        taskCreationBlock: legState.taskCreationBlock,
        correlation: {
          taskId: '501',
          attemptIndex: 0,
          requestId: `0x${'9'.repeat(64)}`,
          deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid',
          v2AttemptId: ORIGIN_ATTEMPT,
          claimOid: fixture.oid,
          prNumber: 84,
          expectedHead: fixture.oid,
        },
      },
      prNumber: 84,
      expectedHead: gitOid(fixture.oid),
      v2Base: join(fixture.base, 'v2'),
    }, {
      claimAcquisition: {
        readCandidate: async () => {
          throw new Error('claim acquisition must not run during recovery');
        },
      } as ReviewClaimAcquisitionDeps,
      createEvaluatorReviewWorkspace: async () => reviewManifest,
      now: () => new Date(NOW),
    });
    expect(result).toEqual({
      status: 'anchored',
      anchor: {
        attemptId: REVIEW_ATTEMPT,
        manifestPath: reviewManifest.paths.manifest,
        head: fixture.oid,
        generation: GENERATION,
        refOid: fixture.oid,
        reviewer: 'review-bot',
        anchoredAt: NOW,
      },
    });
  });

  it('anchors a new claim without local spawn or Task submission', async () => {
    const fixture = repositoryFixture();
    const credential = new SelectedCredential('review-bot', 'review', 'review-secret');
    const originPath = originManifestPath(fixture);
    let createdManifest: Awaited<ReturnType<typeof createAttemptWorkspace>>;
    const createWorkspace = vi.fn(async () => {
      createdManifest = await createAttemptWorkspace({
        repositoryPath: fixture.repo,
        worktreeBase: fixture.base,
        runnerId: fixture.runnerId,
        phase: 'review',
        subject: 'pr-84',
        issueNumber: 42,
        prNumber: 84,
        branch: 'autopilot/42',
        targetBase: 'next',
        expectedHead: fixture.oid,
        claimOid: gitOid('3'.repeat(40)),
        reviewGeneration: GENERATION,
        reviewRefOid: gitOid('3'.repeat(40)),
        reviewApprovalPolicy: 'approve-eligible',
        selectedLogin: 'review-bot',
        credential,
        attemptId: REVIEW_ATTEMPT,
        execution: {
          backend: 'marketplace',
          state: {
            schemaVersion: 'marketplace-execution-v2',
            status: 'prepared',
            requestPath: join(fixture.root, 'evaluator-leg.request.json'),
            requestDigest: DIGEST,
            solverNetSelectionPath: join(fixture.root, 'evaluator-leg.solvernet-selection.json'),
            preparedAt: NOW,
            agentSoftDeadline: '2026-07-27T13:07:00.000Z',
            adoptionDeadline: '2026-07-27T14:07:00.000Z',
          },
        },
        now: () => new Date(NOW),
      }, defaultRunner);
      return createdManifest;
    });
    const result = await anchorMarketplaceEvaluatorReview({
      origin: {
        originManifestPath: originPath,
        originV2AttemptId: ORIGIN_ATTEMPT,
        originRequestDigest: DIGEST,
        taskId: '501',
        taskCid: 'bafybeigdyrzt5m6u2r3o4exampletaskcid',
        taskCreationBlock: 501,
        correlation: {
          taskId: '501',
          attemptIndex: 0,
          requestId: `0x${'9'.repeat(64)}`,
          deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid',
          v2AttemptId: ORIGIN_ATTEMPT,
          claimOid: fixture.oid,
          prNumber: 84,
          expectedHead: fixture.oid,
        },
      },
      prNumber: 84,
      expectedHead: gitOid(fixture.oid),
      v2Base: join(fixture.base, 'v2'),
    }, {
      claimAcquisition: claimAcquisition(fixture.oid),
      createEvaluatorReviewWorkspace: createWorkspace,
      now: () => new Date(NOW),
    });
    expect(result.status).toBe('anchored');
    expect(createWorkspace).toHaveBeenCalledOnce();
    const manifest = readAttemptManifest(createdManifest.paths.manifest);
    expect(manifest.execution.state.schemaVersion).toBe('marketplace-evaluator-leg-v1');
    expect(manifest.execution.state).toMatchObject({
      originManifestPath: originPath,
      originV2AttemptId: ORIGIN_ATTEMPT,
      originRequestDigest: DIGEST,
      taskId: '501',
      expectedHead: fixture.oid,
      generation: GENERATION,
      reviewer: 'review-bot',
      status: 'anchored',
    });
    expect(existsSync(join(fixture.root, 'marketplace-request.json'))).toBe(false);
  });

  it('rejects CODEOWNER review claims for marketplace anchoring', async () => {
    const fixture = repositoryFixture();
    const result = await anchorMarketplaceEvaluatorReview({
      origin: {
        originManifestPath: originManifestPath(fixture),
        originV2AttemptId: ORIGIN_ATTEMPT,
        originRequestDigest: DIGEST,
        taskId: '501',
        taskCid: 'bafybeigdyrzt5m6u2r3o4exampletaskcid',
        taskCreationBlock: 501,
        correlation: {
          taskId: '501',
          attemptIndex: 0,
          requestId: `0x${'9'.repeat(64)}`,
          deliveryEnvelopeCid: 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid',
          v2AttemptId: ORIGIN_ATTEMPT,
          claimOid: fixture.oid,
          prNumber: 84,
          expectedHead: fixture.oid,
        },
      },
      prNumber: 84,
      expectedHead: gitOid(fixture.oid),
      v2Base: join(fixture.base, 'v2'),
    }, {
      claimAcquisition: claimAcquisition(fixture.oid, {
        readCandidate: async () => buildCandidate(fixture.oid, { approvalPolicy: 'human-codeowner' }),
        confirmAcquisition: async ({ expectedHead, expectedReviewRefOid }) =>
          buildCandidate(expectedHead, {
            approvalPolicy: 'human-codeowner',
            reviewRef: {
              oid: expectedReviewRefOid,
              record: {
                kind: 'review-claim',
                protocolVersion: 2,
                prNumber: 84,
                generation: GENERATION,
                attempt: REVIEW_ATTEMPT,
                reviewer: 'review-bot',
                head: expectedHead,
                state: 'active',
                recordedAt: NOW,
              },
            },
          }),
      }),
      createEvaluatorReviewWorkspace: async () => {
        throw new Error('workspace should not be created');
      },
    });
    expect(result).toEqual({
      status: 'rejected',
      detail: 'CODEOWNER review claims cannot anchor marketplace evaluators.',
    });
  });

  it('releases an anchor through the review-session stale protocol', async () => {
    const fixture = repositoryFixture();
    const credential = new SelectedCredential('review-bot', 'review', 'review-secret');
    const originPath = originManifestPath(fixture);
    const reviewManifest = await createAttemptWorkspace({
      repositoryPath: fixture.repo,
      worktreeBase: fixture.base,
      runnerId: fixture.runnerId,
      phase: 'review',
      subject: 'pr-84',
      issueNumber: 42,
      prNumber: 84,
      branch: 'autopilot/42',
      targetBase: 'next',
      expectedHead: fixture.oid,
      claimOid: fixture.oid,
      reviewGeneration: GENERATION,
      reviewRefOid: fixture.oid,
      reviewApprovalPolicy: 'approve-eligible',
      selectedLogin: 'review-bot',
      credential,
      attemptId: REVIEW_ATTEMPT,
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v2',
          status: 'prepared',
          requestPath: join(fixture.root, 'evaluator-leg.request.json'),
          requestDigest: DIGEST,
          solverNetSelectionPath: join(fixture.root, 'evaluator-leg.solvernet-selection.json'),
          preparedAt: NOW,
          agentSoftDeadline: '2026-07-27T13:07:00.000Z',
          adoptionDeadline: '2026-07-27T14:07:00.000Z',
        },
      },
      now: () => new Date(NOW),
    }, defaultRunner);
    installMarketplaceEvaluatorLeg(
      reviewManifest.paths.manifest,
      {
        originManifestPath: originPath,
        originV2AttemptId: ORIGIN_ATTEMPT,
        originRequestDigest: DIGEST,
        taskId: '501',
        taskCid: 'bafybeigdyrzt5m6u2r3o4exampletaskcid',
        taskCreationBlock: 501,
        prNumber: 84,
        expectedHead: fixture.oid,
        generation: GENERATION,
        reviewRefOid: fixture.oid,
        reviewer: 'review-bot',
      },
      () => new Date(NOW),
    );
    const port: ReviewSessionPort = {
      readManifest: (path) => readAttemptManifest(path),
      readAuthority: async () => ({
        reviewRefOid: gitOid(fixture.oid),
        record: {
          kind: 'review-claim',
          protocolVersion: 2,
          prNumber: 84,
          generation: GENERATION,
          attempt: REVIEW_ATTEMPT,
          reviewer: 'review-bot',
          head: gitOid(fixture.oid),
          state: 'active',
          recordedAt: NOW,
        },
      }),
      readPullRequest: async () => ({
        number: 84,
        issueNumber: 42,
        open: true,
        head: gitOid(fixture.oid),
        headRefName: gitRefName('autopilot/42'),
        baseRefName: gitRefName('next'),
        draft: false,
        author: 'implementation-bot',
        labels: [],
        body: '',
        approvalPolicy: 'approve-eligible',
      }),
      readNativeReviews: async () => [],
      hasHumanHold: async () => false,
      createReviewRecord: vi.fn(async () => gitOid('4'.repeat(40))),
      publishReviewClaim: vi.fn(async () => ({
        status: 'won',
        expected: fixture.oid,
        published: gitOid('4'.repeat(40)),
        observed: gitOid('4'.repeat(40)),
      })),
      submitNativeReview: async () => {},
      createPrComment: async () => ({ id: 1 }),
      createChildIssue: async () => ({ number: 99 }),
      now: () => new Date(NOW),
    };
    await releaseMarketplaceReviewAnchor({
      attemptId: REVIEW_ATTEMPT,
      manifestPath: reviewManifest.paths.manifest,
      head: gitOid(fixture.oid),
      generation: GENERATION,
      refOid: gitOid(fixture.oid),
      reviewer: 'review-bot',
      anchoredAt: NOW,
    }, port, () => new Date(NOW));
    const released = readAttemptManifest(reviewManifest.paths.manifest);
    expect(released.execution.state.status).toBe('released');
    expect(port.createReviewRecord).toHaveBeenCalled();
    expect(port.publishReviewClaim).toHaveBeenCalled();
  });
});
