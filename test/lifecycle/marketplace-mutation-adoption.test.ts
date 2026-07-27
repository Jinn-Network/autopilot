import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AutopilotAdoptionReceiptSchema,
  formatAutopilotAdoptionReceiptComment,
  type AutopilotCorrelation,
  type AutopilotMutationResult,
  type AutopilotSessionCapsule,
} from '@jinn-network/sdk/autopilot';
import {
  decodeAttemptManifest,
  readAttemptManifest,
  type AttemptManifest,
} from '../../src/lifecycle/attempt-workspace.js';
import { transitionMarketplaceAdoption } from '../../src/lifecycle/marketplace-adoption-state.js';
import type { AdoptionReceiptComment, AdoptionReceiptPorts } from '../../src/lifecycle/marketplace-adoption-receipt.js';
import {
  buildMarketplaceTaskRequest,
  persistMarketplaceTaskRequest,
} from '../../src/lifecycle/marketplace-task.js';
import type { VerifiedSolutionObservation } from '../../src/lifecycle/marketplace-delivery.js';
import type {
  MarketplaceArtifactEvidence,
  MarketplaceHostCommitEvidence,
  MarketplaceReviewAnchorEvidence,
  MarketplaceSolutionDeliveryEvidence,
  MarketplaceVerificationEvidence,
} from '../../src/lifecycle/marketplace-execution-state.js';
import {
  makeMarketplaceMutationAdoptionCoordinator,
  type MarketplaceMutationAdoptionBoundary,
  type MarketplaceMutationAuthority,
  type MarketplaceMutationAuthorityPort,
} from '../../src/lifecycle/marketplace-mutation-adoption.js';
import type {
  MarketplaceMutationCommitIdentity,
  MarketplaceMutationGitPort,
  MarketplaceMutationGitState,
} from '../../src/lifecycle/marketplace-mutation-git.js';
import {
  MarketplaceVerificationError,
  type MarketplaceMutationVerificationPort,
} from '../../src/lifecycle/marketplace-mutation-verification.js';
import {
  MarketplacePatchPolicyError,
  validateMarketplacePatch,
  type ValidatedMarketplacePatch,
} from '../../src/lifecycle/marketplace-patch.js';
import type { MarketplaceReviewAnchorPort } from '../../src/lifecycle/marketplace-review-anchor.js';
import type { ImplementationSessionProtocol } from '../../src/lifecycle/implementation-session.js';
import { gitOid, gitRefName, type BranchClaim, type GitOid } from '../../src/lifecycle/types.js';

const ATTEMPT_ID = '123e4567-e89b-42d3-a456-426614174001';
const REVIEW_ATTEMPT = '22222222-2222-4222-8222-222222222222';
const GENERATION = '33333333-3333-4333-8333-333333333333';
const CLAIM = gitOid('1'.repeat(40));
const EXPECTED = gitOid('2'.repeat(40));
const HOST_COMMIT = gitOid('3'.repeat(40));
const HOST_TREE = gitOid('4'.repeat(40));
const COMPLETION = gitOid('5'.repeat(40));
const REVIEW_REF = gitOid('6'.repeat(40));
const STALE = gitOid('9'.repeat(40));
const NOW = '2026-07-27T12:08:00.000Z';
const REQUEST_ID = `0x${'1'.repeat(64)}`;
const ENVELOPE_CID = 'bafy-envelope-solution';
const PATCH = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n');

type MutationWorkflow = 'implement' | 'fix-child' | 'reconcile' | 'ci-failure';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workflowContract(workflow: MutationWorkflow) {
  return {
    skill: workflow === 'implement'
      ? 'implement-issue'
      : workflow === 'reconcile'
        ? 'reconcile'
        : 'fix-child',
    version: 'v2',
    resultSchema: 'jinn-autopilot-mutation-result.v1',
  } as const;
}

function correlation(): AutopilotCorrelation {
  return {
    taskId: '501',
    attemptIndex: 0,
    requestId: REQUEST_ID,
    deliveryEnvelopeCid: ENVELOPE_CID,
    v2AttemptId: ATTEMPT_ID,
    claimOid: CLAIM,
    prNumber: 2101,
    expectedHead: EXPECTED,
  };
}

function session(workflow: MutationWorkflow): AutopilotSessionCapsule {
  return {
    schemaVersion: 'jinn-autopilot-session.v1',
    workflow,
    repository: 'Jinn-Network/mono',
    language: 'typescript',
    verificationProfile: 'jinn-mono.v1',
    issueNumber: 2001,
    ...(workflow === 'implement'
      ? {}
      : { childIssueNumber: 2069, parentPrNumber: 2101 }),
    prNumber: 2101,
    targetBase: 'next',
    branch: 'codex/issue-2001',
    claimOid: CLAIM,
    expectedHead: EXPECTED,
    v2AttemptId: ATTEMPT_ID,
    runnerId: 'runner-1',
    taskSnapshot: {
      title: 'Implement exact marketplace contracts',
      body: 'Add the approved contract surface.',
      prBody: '<!-- jinn-autopilot:v2 issue=2001 branch=codex/issue-2001 -->',
      baseSha: gitOid('a'.repeat(40)),
      targetBaseOid: gitOid('b'.repeat(40)),
    },
    deadline: '2026-07-27T13:00:00.000Z',
    receiptAuthors: ['jinn-autopilot'],
    workflowContract: workflowContract(workflow),
  } as AutopilotSessionCapsule;
}

function mutationResult(
  outcome: 'mutation-complete' | 'human' = 'mutation-complete',
): AutopilotMutationResult {
  if (outcome === 'human') {
    return {
      schemaVersion: 'jinn-autopilot-mutation-result.v1',
      outcome,
      correlation: correlation(),
      reason: {
        code: 'semantic-conflict',
        detail: 'The requested change needs Human judgment.',
      },
    };
  }
  return {
    schemaVersion: 'jinn-autopilot-mutation-result.v1',
    outcome,
    correlation: correlation(),
    patch: PATCH,
    summary: 'Implemented the requested contract.',
    evidence: { commands: ['yarn typecheck'], tests: ['yarn test'] },
  };
}

function observation(
  workflow: MutationWorkflow,
  result: AutopilotMutationResult = mutationResult(),
): VerifiedSolutionObservation {
  return {
    status: 'verified',
    role: 'solution',
    task: {
      taskId: '501',
      taskCid: 'bafy-task',
      taskCidDigest: `0x${'a'.repeat(64)}`,
      createdAtBlock: 100,
      createdAtTx: `0x${'a'.repeat(64)}`,
    },
    attempt: {
      attemptIndex: 0,
      requestId: REQUEST_ID,
      operator: `0x${'1'.repeat(40)}`,
      createdAtBlock: 101,
    },
    delivery: {
      envelopeCid: ENVELOPE_CID,
      envelopeDigest: `0x${'c'.repeat(64)}`,
      publisherAgentId: '42',
      transactionHash: `0x${'d'.repeat(64)}`,
      blockNumber: 102,
    },
    envelope: {
      cid: ENVELOPE_CID,
      digest: `0x${'c'.repeat(64)}`,
      executionSchema: 'jinn.execution.v1',
      solverType: 'jinn-repo.v1',
      role: 'solution',
      participant: {
        safeAddress: `0x${'1'.repeat(40)}`,
        agentEoa: `0x${'2'.repeat(40)}`,
      },
      signer: `0x${'2'.repeat(40)}`,
    },
    session: session(workflow),
    result,
    correlation: correlation(),
  };
}

function deliveryEvidence(
  attemptDir: string,
  obs: VerifiedSolutionObservation,
): MarketplaceSolutionDeliveryEvidence {
  const observationPath = join(attemptDir, 'marketplace-solution-observation.json');
  const bytes = Buffer.from(`${JSON.stringify(obs, null, 2)}\n`);
  return {
    observationPath,
    observationDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    taskId: obs.task.taskId,
    taskCid: obs.task.taskCid,
    taskCreationTransaction: obs.task.createdAtTx,
    taskCreationBlock: obs.task.createdAtBlock,
    solverNetManifestCid: 'bafy-solvernet',
    attemptIndex: obs.attempt.attemptIndex,
    requestId: obs.attempt.requestId,
    deliveryEnvelopeCid: obs.delivery.envelopeCid,
    deliveryEnvelopeDigest: `sha256:${obs.delivery.envelopeDigest.slice(2).toLowerCase()}`,
    deliveryTransaction: obs.delivery.transactionHash,
    deliveryBlock: obs.delivery.blockNumber,
    solverSafe: obs.envelope.participant.safeAddress,
    solverAgentEoa: obs.envelope.participant.agentEoa,
    signer: obs.envelope.signer,
    publisherAgentId: obs.delivery.publisherAgentId,
    correlation: obs.correlation,
    observedAt: '2026-07-26T12:02:00.000Z',
  };
}

function branchClaim(workflow: MutationWorkflow): BranchClaim {
  const child = workflow !== 'implement';
  return {
    kind: 'branch-claim',
    protocolVersion: 2,
    phase: workflow === 'implement'
      ? 'implement'
      : workflow === 'reconcile'
        ? 'reconcile'
        : 'fix',
    issueNumber: child ? 2069 : 2001,
    prNumber: 2101,
    attempt: ATTEMPT_ID,
    runner: 'runner-1',
    login: 'jinn-autopilot',
    expectedHead: CLAIM,
    targetBase: gitRefName('next'),
    claimedAt: NOW,
  };
}

function verificationEvidence(expectedTree: GitOid): MarketplaceVerificationEvidence {
  return {
    profile: 'jinn-mono.v1',
    artifactDigest: validateMarketplacePatch(new TextEncoder().encode(PATCH)).artifactDigest,
    expectedTree,
    planDigest: `sha256:${'e'.repeat(64)}`,
    commands: [{
      label: 'typecheck',
      command: 'yarn',
      args: ['typecheck'],
      cwdRelative: 'packages/autopilot',
      status: 'passed',
      exitCode: 0,
      stdoutDigest: `sha256:${'f'.repeat(64)}`,
      stderrDigest: `sha256:${'0'.repeat(64)}`,
      startedAt: NOW,
      completedAt: NOW,
    }],
    verifiedAt: NOW,
  };
}

function reviewManifestPath(attemptDir: string): string {
  const runnerDir = resolve(attemptDir, '..', '..');
  return join(runnerDir, 'review', `pr-2101-${REVIEW_ATTEMPT}`, 'manifest.json');
}

function hostCommitEvidence(childIssueNumber?: number): MarketplaceHostCommitEvidence {
  return {
    head: HOST_COMMIT,
    tree: HOST_TREE,
    parents: [EXPECTED],
    artifactDigest: validateMarketplacePatch(new TextEncoder().encode(PATCH)).artifactDigest,
    correlationDigest: `sha256:${'1'.repeat(64)}`,
    trailers: {
      taskId: '501',
      requestId: REQUEST_ID,
      deliveryEnvelopeCid: ENVELOPE_CID,
      v2AttemptId: ATTEMPT_ID,
      artifactDigest: validateMarketplacePatch(new TextEncoder().encode(PATCH)).artifactDigest,
      ...(childIssueNumber === undefined ? {} : { childIssueNumber }),
    },
    createdAt: NOW,
  };
}

function reviewAnchorEvidence(
  attemptDir: string,
  head: GitOid = HOST_COMMIT,
): MarketplaceReviewAnchorEvidence {
  return {
    attemptId: REVIEW_ATTEMPT,
    manifestPath: reviewManifestPath(attemptDir),
    head,
    generation: GENERATION,
    refOid: REVIEW_REF,
    reviewer: 'review-bot',
    anchoredAt: NOW,
  };
}

class Harness implements
  MarketplaceMutationAuthorityPort,
  MarketplaceMutationGitPort,
  MarketplaceMutationVerificationPort,
  MarketplaceReviewAnchorPort,
  AdoptionReceiptPorts {
  readonly comments: AdoptionReceiptComment[] = [];
  readonly boundaries: MarketplaceMutationAdoptionBoundary[] = [];
  currentManifest: AttemptManifest;
  manifestPath: string;
  attemptDir: string;
  requestDigest: string;
  delivery: MarketplaceSolutionDeliveryEvidence;
  currentClaim: BranchClaim;
  currentClaimOid: GitOid = CLAIM;
  remoteHead: GitOid = EXPECTED;
  prHead: GitOid = EXPECTED;
  gitState: MarketplaceMutationGitState = { status: 'clean', expectedTree: HOST_TREE };
  reviewAnchor?: MarketplaceReviewAnchorEvidence;
  workflow: MutationWorkflow;
  child?: MarketplaceMutationAuthority['child'];
  verificationThrows?: MarketplaceVerificationError;
  codeOwnerRequired = false;
  mappingStatus: 'resolved' | 'ambiguous' | 'missing' = 'resolved';
  humanActive = false;
  crashBoundary?: MarketplaceMutationAdoptionBoundary;
  staleOnAuthorityRead?: number;
  authorityReads = 0;
  applyMutations = 0;
  commitMutations = 0;
  checkpointMutations = 0;
  completionMutations = 0;
  childCloseMutations = 0;
  humanMutations = 0;
  reviewAnchorMutations = 0;
  reviewAnchorReleases = 0;
  patchError?: Error;
  observeCalls = 0;
  nextCommentId = 9001;
  clock: () => Date = (() => {
    let tick = Date.parse(NOW);
    return () => new Date(tick += 60_000);
  })();

  constructor(workflow: MutationWorkflow = 'implement', status: 'submitted' | 'solution-observed' = 'solution-observed') {
    this.workflow = workflow;
    const root = mkdtempSync(join(tmpdir(), 'marketplace-mutation-adoption-'));
    roots.push(root);
    const attemptDir = join(root, 'attempt');
    mkdirSync(join(attemptDir, 'worktree'), { recursive: true });
    const requestPath = join(attemptDir, 'marketplace-request.json');
    const built = buildMarketplaceTaskRequest({
      workflow: 'implementation',
      repository: 'Jinn-Network/mono',
      language: 'typescript',
      verificationProfile: 'jinn-mono.v1',
      issueNumber: 2001,
      prNumber: 2101,
      targetBase: 'next',
      branch: 'codex/issue-2001',
      claimOid: CLAIM,
      expectedHead: EXPECTED,
      v2AttemptId: ATTEMPT_ID,
      runnerId: 'runner-1',
      taskSnapshot: {
        title: 'Implement exact marketplace contracts',
        body: 'Add the approved contract surface.',
        prBody: 'Draft implementation PR.',
        baseSha: '3'.repeat(40),
        targetBaseOid: '3'.repeat(40),
      },
      receiptAuthors: ['jinn-autopilot'],
      createdAt: Date.parse('2026-07-26T12:00:00.000Z'),
    });
    const persisted = persistMarketplaceTaskRequest(requestPath, built.request);
    this.requestDigest = persisted.requestDigest;
    const obs = observation(workflow);
    this.delivery = deliveryEvidence(attemptDir, obs);
    writeFileSync(this.delivery.observationPath, `${JSON.stringify(obs, null, 2)}\n`, { mode: 0o600 });
    this.attemptDir = attemptDir;
    this.manifestPath = join(attemptDir, 'manifest.json');
    this.currentClaim = branchClaim(workflow);
    this.currentManifest = decodeAttemptManifest({
      version: 2,
      attemptId: ATTEMPT_ID,
      runnerId: 'runner-1',
      host: 'test-host',
      phase: 'implement',
      execution: {
        backend: 'marketplace',
        state: {
          schemaVersion: 'marketplace-execution-v3',
          status,
          requestPath,
          requestDigest: persisted.requestDigest,
          solverNetSelectionPath: persisted.solverNetSelectionPath,
          preparedAt: '2026-07-26T12:00:00.000Z',
          agentSoftDeadline: built.agentSoftDeadline,
          adoptionDeadline: built.adoptionDeadline,
          submission: {
            schemaVersion: 1,
            generatedAt: '2026-07-26T12:01:00.000Z',
            verb: 'tasks submit',
            id: `autopilot:${ATTEMPT_ID}`,
            creatorMultisig: `0x${'a'.repeat(40)}`,
            taskId: '501',
            taskCid: 'bafy-task',
            creationTx: `0x${'a'.repeat(64)}`,
            creationBlock: 100,
            solverNetManifestCid: 'bafy-solvernet',
            status: 'submitted',
            idempotent: false,
          },
          submittedAt: '2026-07-26T12:02:00.000Z',
          ...(status === 'solution-observed' ? { delivery: this.delivery } : {}),
        },
      },
      subject: workflow === 'implement' ? 'issue-2001' : 'issue-2069',
      issueNumber: workflow === 'implement' ? 2001 : 2069,
      prNumber: 2101,
      branch: 'codex/issue-2001',
      targetBase: 'next',
      targetBaseOid: '3'.repeat(40),
      expectedHead: EXPECTED,
      claimOid: CLAIM,
      selectedLogin: 'jinn-autopilot',
      repository: {
        root,
        gitCommonDir: root,
        remoteName: 'origin',
        remoteUrlHash: 'a'.repeat(64),
      },
      processState: 'running',
      pid: 4242,
      paths: {
        attemptDir,
        worktree: join(attemptDir, 'worktree'),
        manifest: this.manifestPath,
        log: join(attemptDir, 'session.log'),
        ghConfigDir: join(attemptDir, 'gh-config'),
        askpass: join(attemptDir, 'askpass'),
        tokenFile: join(attemptDir, 'token'),
      },
      timestamps: {
        createdAt: '2026-07-26T12:00:00.000Z',
        updatedAt: '2026-07-26T12:02:00.000Z',
        childStartedAt: '2026-07-26T12:01:00.000Z',
      },
    });
    writeFileSync(this.manifestPath, `${JSON.stringify(this.currentManifest, null, 2)}\n`, { mode: 0o600 });
    if (workflow !== 'implement') {
      this.child = {
        number: 2069,
        parentPrNumber: 2101,
        kind: workflow === 'fix-child' ? 'review-finding' : workflow === 'reconcile' ? 'reconcile' : 'ci-failure',
        open: true,
      };
    }
  }

  transition = (
    manifestPath: string,
    expectedRequestDigest: string,
    transition: Parameters<typeof transitionMarketplaceAdoption>[2],
    now?: () => Date,
  ) => {
    const updated = transitionMarketplaceAdoption(
      manifestPath,
      expectedRequestDigest,
      transition,
      now ?? this.clock,
    );
    this.currentManifest = updated;
    writeFileSync(this.manifestPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
    return updated;
  };

  async readExactAuthority(): Promise<MarketplaceMutationAuthority> {
    this.authorityReads += 1;
    if (this.staleOnAuthorityRead === this.authorityReads) {
      this.remoteHead = STALE;
      this.prHead = STALE;
    }
    const authorityExpectedHead = this.remoteHead === HOST_COMMIT
      && this.currentManifest.expectedHead === EXPECTED
      ? HOST_COMMIT
      : this.currentManifest.expectedHead;
    return {
      manifest: {
        ...this.currentManifest,
        expectedHead: authorityExpectedHead,
      },
      latestClaimOid: this.currentClaimOid,
      latestClaim: this.currentClaim,
      remoteHead: this.remoteHead,
      pullRequest: {
        number: 2101,
        head: this.prHead,
        headRefName: 'codex/issue-2001',
        baseRefName: 'next',
        open: true,
        draft: this.workflow === 'implement' && this.currentClaim.phaseComplete !== true,
        labels: ['engine:review'],
        implementationSummary: this.currentClaim.phaseComplete === true
          ? 'Implemented the requested contract.'
          : undefined,
        canonicalIssueNumber: 2001,
        mappingStatus: this.mappingStatus,
        humanActive: this.humanActive || this.humanMutations > 0,
        codeOwnerRequired: this.codeOwnerRequired,
      },
      ...(this.child === undefined ? {} : { child: this.child }),
      receiptAuthors: ['jinn-autopilot'],
    };
  }

  async readState() {
    return this.gitState;
  }

  async commit(input: MarketplaceMutationCommitIdentity) {
    expect(this.gitState.status).not.toBe('clean');
    this.commitMutations += 1;
    const commit = hostCommitEvidence(input.childIssueNumber);
    this.gitState = {
      status: 'committed',
      expectedTree: HOST_TREE,
      commit,
    };
    expect(new TextDecoder().decode(input.artifact)).toBe(PATCH);
    return commit;
  }

  async preflight() {
    return { ok: true };
  }

  async verify() {
    if (this.verificationThrows !== undefined) throw this.verificationThrows;
    return verificationEvidence(HOST_TREE);
  }

  async acquireOrRecover(input: { readonly expectedHead: GitOid }) {
    if (this.reviewAnchor === undefined) {
      this.reviewAnchorMutations += 1;
      this.reviewAnchor = {
        ...reviewAnchorEvidence(this.attemptDir, input.expectedHead),
        anchoredAt: this.clock().toISOString(),
      };
    }
    return { status: 'anchored' as const, anchor: this.reviewAnchor };
  }

  async release(anchor: MarketplaceReviewAnchorEvidence) {
    expect(anchor).toEqual(this.reviewAnchor);
    this.reviewAnchorReleases += 1;
  }

  readonly protocol: ImplementationSessionProtocol = {
    checkpoint: async () => {
      this.checkpointMutations += 1;
      this.remoteHead = HOST_COMMIT;
      this.prHead = HOST_COMMIT;
      this.currentManifest = {
        ...this.currentManifest,
        expectedHead: HOST_COMMIT,
      };
      return { status: 'already-applied', head: HOST_COMMIT };
    },
    implementationComplete: async (_manifest, summary) => {
      expect(summary).toBe('Implemented the requested contract.');
      if (this.currentClaim.phaseComplete !== true) {
        this.completionMutations += 1;
        this.currentClaim = { ...this.currentClaim, phaseComplete: true };
        this.currentClaimOid = HOST_COMMIT;
        this.remoteHead = HOST_COMMIT;
        this.prHead = HOST_COMMIT;
        this.currentManifest = {
          ...this.currentManifest,
          expectedHead: HOST_COMMIT,
        };
      }
      return { status: 'complete', head: HOST_COMMIT };
    },
    childComplete: async () => {
      if (this.child?.open === true) {
        this.childCloseMutations += 1;
        this.child = { ...this.child, open: false };
        this.remoteHead = HOST_COMMIT;
        this.prHead = HOST_COMMIT;
        this.currentManifest = {
          ...this.currentManifest,
          expectedHead: HOST_COMMIT,
        };
      }
      return { status: 'closed' };
    },
    reviewVerdict: async () => {
      throw new Error('not used');
    },
    human: async () => {
      this.humanMutations += 1;
      this.humanActive = true;
      return { status: 'human', head: this.remoteHead };
    },
  };

  async listPrIssueComments() {
    return { comments: this.comments };
  }

  async verifyReceiptFacts() {
    return true;
  }

  async readCurrentPrHead() {
    return this.prHead;
  }

  async createPrComment(input: { readonly expectedHead: GitOid; readonly body: string }) {
    const comment = {
      id: this.nextCommentId,
      authorLogin: 'jinn-autopilot',
      body: input.body,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.nextCommentId += 1;
    this.comments.push(comment);
    return { commentId: comment.id, author: comment.authorLogin };
  }

  async applyPatch(): Promise<ValidatedMarketplacePatch> {
    if (this.patchError !== undefined) throw this.patchError;
    this.applyMutations += 1;
    this.gitState = { status: 'pending', expectedTree: HOST_TREE };
    return validateMarketplacePatch(new TextEncoder().encode(PATCH));
  }

  async observe(manifestPath: string) {
    this.observeCalls += 1;
    this.transition(manifestPath, this.requestDigest, {
      status: 'solution-observed',
      delivery: this.delivery,
    }, this.clock);
    return {
      status: 'verified' as const,
      observation: observation(this.workflow),
      observationPath: this.delivery.observationPath,
      observationDigest: this.delivery.observationDigest,
    };
  }

  async boundary(boundary: MarketplaceMutationAdoptionBoundary) {
    this.boundaries.push(boundary);
    if (this.crashBoundary === boundary) {
      this.crashBoundary = undefined;
      throw new Error(`crash after ${boundary}`);
    }
  }

  coordinator() {
    return makeMarketplaceMutationAdoptionCoordinator({
      observe: (path) => this.observe(path),
      readAuthority: this,
      validatePatch: validateMarketplacePatch,
      applyPatch: () => this.applyPatch(),
      git: this,
      verification: this,
      implementation: this.protocol,
      reviewAnchors: this,
      receipts: this,
      transition: this.transition,
      now: () => this.clock(),
      onBoundary: (boundary) => this.boundary(boundary),
    });
  }
}

async function adopt(harness: Harness) {
  return harness.coordinator().adopt(harness.manifestPath);
}

describe('marketplace mutation adoption validation', () => {
  it('rejects correlation mismatch before patch effects', async () => {
    const harness = new Harness();
    const obs = observation('implement', {
      ...mutationResult(),
      correlation: { ...correlation(), requestId: `0x${'f'.repeat(64)}` },
    });
    writeFileSync(harness.delivery.observationPath, `${JSON.stringify(obs, null, 2)}\n`);
    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'correlation-mismatch',
    });
    expect(harness.applyMutations).toBe(0);
    expect(harness.comments).toHaveLength(1);
  });

  it('rejects stale claim before effects', async () => {
    const harness = new Harness();
    harness.currentClaim = { ...harness.currentClaim, attempt: '123e4567-e89b-42d3-a456-426614174099' };
    await expect(adopt(harness)).resolves.toMatchObject({ status: 'rejected', reason: 'stale-claim' });
    expect(harness.applyMutations).toBe(0);
  });

  it('rejects stale head before effects', async () => {
    const harness = new Harness();
    harness.remoteHead = STALE;
    harness.prHead = STALE;
    await expect(adopt(harness)).resolves.toMatchObject({ status: 'rejected', reason: 'stale-head' });
    expect(harness.applyMutations).toBe(0);
  });

  it('rejects ambiguous PR mapping before effects', async () => {
    const harness = new Harness();
    harness.mappingStatus = 'ambiguous';
    await expect(adopt(harness)).resolves.toMatchObject({ status: 'rejected', reason: 'policy-human' });
    expect(harness.applyMutations).toBe(0);
  });

  it('rejects CODEOWNER surface before effects', async () => {
    const harness = new Harness();
    harness.codeOwnerRequired = true;
    await expect(adopt(harness)).resolves.toMatchObject({ status: 'rejected', reason: 'policy-human' });
    expect(harness.applyMutations).toBe(0);
  });

  it('calls Human protocol before publishing policy-human', async () => {
    const harness = new Harness();
    const obs = observation('implement', mutationResult('human'));
    writeFileSync(harness.delivery.observationPath, `${JSON.stringify(obs, null, 2)}\n`);
    const result = await adopt(harness);
    expect(result).toMatchObject({ status: 'rejected', reason: 'policy-human' });
    expect(harness.humanMutations).toBe(1);
    expect(harness.applyMutations).toBe(0);
  });

  it('keeps authority transport ambiguity recoverable', async () => {
    const harness = new Harness();
    harness.readExactAuthority = async () => {
      throw new Error('authority transport unavailable');
    };
    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'recoverable',
      detail: 'authority transport unavailable',
    });
    expect(harness.comments).toHaveLength(0);
  });
});

describe('marketplace mutation adoption success', () => {
  it('adopts through verify, commit, completion, anchor, and receipt', async () => {
    const harness = new Harness();
    const result = await adopt(harness);
    expect(result).toMatchObject({
      status: 'accepted',
      resultingHead: HOST_COMMIT,
      reviewAnchor: { generation: GENERATION, refOid: REVIEW_REF },
    });
    expect(harness.applyMutations).toBe(1);
    expect(harness.commitMutations).toBe(1);
    expect(harness.completionMutations).toBe(1);
    expect(harness.reviewAnchorMutations).toBe(1);
    expect(harness.comments).toHaveLength(1);
    expect(readAttemptManifest(harness.manifestPath).execution).toMatchObject({
      backend: 'marketplace',
      state: { status: 'receipt-published' },
    });
  });

  it('reuses bound verification evidence after crash', async () => {
    const harness = new Harness();
    harness.gitState = { status: 'pending', expectedTree: HOST_TREE };
    harness.transition(harness.manifestPath, harness.requestDigest, {
      status: 'solution-verified',
      artifact: {
        digest: validateMarketplacePatch(new TextEncoder().encode(PATCH)).artifactDigest,
        byteLength: PATCH.length,
        touchedPaths: ['a.ts'],
        expectedTree: HOST_TREE,
      },
      verification: verificationEvidence(HOST_TREE),
    }, harness.clock);
    await adopt(harness);
    expect(harness.verificationThrows).toBeUndefined();
    const verifySpy = vi.spyOn(harness, 'verify');
    await adopt(harness);
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('rejects verification failure with a typed receipt', async () => {
    const harness = new Harness();
    harness.verificationThrows = new MarketplaceVerificationError(
      'command-failed',
      'stable-rejection',
      'typecheck failed',
    );
    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'verification-failed',
    });
    expect(harness.commitMutations).toBe(0);
    expect(harness.comments).toHaveLength(1);
  });

  it('maps patch check failure to patch-does-not-apply', async () => {
    const harness = new Harness();
    harness.patchError = new MarketplacePatchPolicyError(
      'git-check-failed',
      'does not apply',
    );
    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'patch-does-not-apply',
    });
  });

  it('re-reads authority after verification and refuses stale commit', async () => {
    const harness = new Harness();
    harness.staleOnAuthorityRead = 2;
    await expect(adopt(harness)).resolves.toMatchObject({ status: 'rejected', reason: 'stale-head' });
    expect(harness.applyMutations).toBe(1);
    expect(harness.commitMutations).toBe(0);
  });

  it('child workflow checkpoints and childCompletes before anchoring', async () => {
    const harness = new Harness('fix-child');
    const result = await adopt(harness);
    expect(result).toMatchObject({ status: 'accepted', resultingHead: HOST_COMMIT });
    expect(harness.checkpointMutations).toBe(1);
    expect(harness.childCloseMutations).toBe(1);
    expect(harness.completionMutations).toBe(0);
  });
});

describe('marketplace mutation adoption recovery', () => {
  it.each([
    'patch-applied',
    'verification-persisted',
    'host-commit-created',
    'checkpoint-published',
    'completion-confirmed',
    'review-anchor-published',
  ] as const)('recovers idempotently after %s', async (boundary) => {
    const harness = new Harness();
    harness.crashBoundary = boundary;
    await expect(adopt(harness)).resolves.toMatchObject({ status: 'recoverable' });
    await expect(adopt(harness)).resolves.toMatchObject({ status: 'accepted' });
    expect(harness.applyMutations).toBe(1);
    expect(harness.comments).toHaveLength(1);
  });

  it('releases review anchor on receipt contradiction', async () => {
    const harness = new Harness();
    const existing = AutopilotAdoptionReceiptSchema.parse({
      schemaVersion: 'jinn-autopilot-marketplace-adoption.v1',
      disposition: 'rejected',
      role: 'solution',
      reason: 'stale-head',
      detail: 'earlier exact rejection',
      ...correlation(),
      recordedAt: NOW,
    });
    harness.comments.push({
      id: 8001,
      authorLogin: 'jinn-autopilot',
      body: formatAutopilotAdoptionReceiptComment(existing),
      createdAt: NOW,
      updatedAt: NOW,
    });
    const result = await adopt(harness);
    expect(result).toMatchObject({ status: 'rejected', reason: 'receipt-contradiction' });
    expect(harness.humanMutations).toBe(1);
    expect(harness.reviewAnchorReleases).toBe(1);
    expect(harness.comments).toHaveLength(1);
  });

  it('rejects at adoption cutoff before durable effects', async () => {
    const harness = new Harness('implement', 'submitted');
    harness.clock = () => new Date('2026-07-27T13:30:00.000Z');
    await expect(adopt(harness)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'internal-adoption-failure',
    });
    expect(harness.observeCalls).toBe(1);
    expect(harness.applyMutations).toBe(0);
  });
});
