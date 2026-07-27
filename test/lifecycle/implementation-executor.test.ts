// @ts-nocheck — Stage 5 leftover fixtures for deleted merge-prep/review-fix/project APIs.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TaskSubmitRequestV1Schema } from '@jinn-network/sdk/autopilot';
import type { AttemptManifest } from '../../src/lifecycle/attempt-workspace.js';
import { CredentialPool } from '../../src/lifecycle/credentials.js';
import {
  executeImplementationAction,
  runCanonicalImplementationRealityCheck,
  type ImplementationExecutorDeps,
  type ImplementationIssue,
  type ImplementationPullRequest,
} from '../../src/lifecycle/implementation-executor.js';
import {
  makeImplementationSessionProtocol,
  type ImplementationSessionPort,
} from '../../src/lifecycle/implementation-session.js';
import {
  gitOid,
  gitRefName,
  type BranchClaim,
  type ClaimOutcome,
  type GitOid,
} from '../../src/lifecycle/types.js';

const BASE = gitOid('1'.repeat(40));
const CLAIM_A = gitOid('2'.repeat(40));
const CLAIM_B = gitOid('3'.repeat(40));
const ADOPTED_HEAD = gitOid('4'.repeat(40));
const WORK = gitOid('5'.repeat(40));
const ATTEMPT_A = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_B = '22222222-2222-4222-8222-222222222222';
const HTTPS_REMOTE = 'https://github.com/Jinn-Network/mono.git';

function issue(overrides: Partial<ImplementationIssue> = {}): ImplementationIssue {
  return {
    number: 42,
    title: 'Implement exact lifecycle ownership',
    body: 'Authoritative issue body for #42.',
    open: true,
    eligible: true,
    targetBase: gitRefName('next'),
    effort: 'High',
    ...overrides,
  };
}

function pr(overrides: Partial<ImplementationPullRequest> = {}): ImplementationPullRequest {
  return {
    number: 84,
    headRefName: gitRefName('existing/issue-42'),
    head: ADOPTED_HEAD,
    baseRefName: gitRefName('next'),
    draft: true,
    labels: ['engine:review'],
    body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=existing/issue-42 -->',
    ...overrides,
  };
}

function pool(): CredentialPool {
  return new CredentialPool([{
    login: 'implementation-bot',
    normalizedLogin: 'implementation-bot',
    implementationToken: 'selected-secret',
  }]);
}

function claimOutcome(
  status: ClaimOutcome['status'],
  published: GitOid,
  observed: GitOid | null = published,
): ClaimOutcome {
  return {
    status,
    expected: null,
    published,
    observed,
  };
}

function harness(overrides: Partial<ImplementationExecutorDeps> = {}) {
  const events: string[] = [];
  const claims: Array<{
    branch: string;
    candidateParent: GitOid;
    expectedRemoteHead: GitOid | null;
    claimOid: GitOid;
    remoteUrl: string;
    login: string;
  }> = [];
  const human: unknown[] = [];
  let attemptIndex = 0;
  const attemptIds = [ATTEMPT_A, ATTEMPT_B];
  const deps: ImplementationExecutorDeps = {
    readIssue: async () => issue(),
    readStaleRecovery: async () => staleRecoveryState(),
    runRealityCheck: async () => ({
      classification: 'clear',
      evidence: {},
      suggestedBlockedOn: null,
      suggestedComment: null,
    }),
    listOpenPullRequests: async () => [],
    credentials: pool(),
    remoteUrl: HTTPS_REMOTE,
    readTargetBaseHead: async () => BASE,
    createClaimCommit: async ({ attempt }) => attempt === ATTEMPT_A ? CLAIM_A : CLAIM_B,
    claimBranch: async (input) => {
      events.push('claim');
      claims.push(input);
      return claimOutcome('won', input.claimOid);
    },
    ensureDraftPullRequest: async (input) => {
      events.push('pr');
      return pr({
        number: 84,
        headRefName: input.branch,
        head: input.claimOid,
        baseRefName: input.targetBase,
        body: input.body,
      });
    },
    setProjectInProgress: async () => {
      events.push('project');
    },
    createAttempt: async (input) => {
      events.push('attempt');
      return {
        attemptId: input.attemptId,
        paths: {
          worktree: `/tmp/${input.attemptId}/worktree`,
          manifest: `/tmp/${input.attemptId}/manifest.json`,
          log: `/tmp/${input.attemptId}/session.log`,
          ghConfigDir: `/tmp/${input.attemptId}/gh-config`,
          askpass: `/tmp/${input.attemptId}/askpass`,
        },
      };
    },
    startSession: async (request) => {
      events.push('spawn');
      const input = request.local.spawnInput;
      expect(input.environment.GH_TOKEN).toBe('selected-secret');
      expect(input.environment.GITHUB_TOKEN).toBeUndefined();
      expect(input.environment.GIT_SSH_COMMAND).toBe('false');
      expect(input.environment.JINN_AUTOPILOT_SESSION_MANIFEST)
        .toBe(`/tmp/${input.attemptId}/manifest.json`);
      events.push('track');
      return { status: 'started', backend: 'local', pid: 4242 };
    },
    escalateHuman: async (input) => {
      human.push(input);
    },
    ambientEnvironment: {
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'ambient-secret',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    },
    nextAttemptId: () => attemptIds[attemptIndex++]!,
    runnerId: 'runner-a',
    now: () => new Date('2026-07-20T12:00:00.000Z'),
    ...overrides,
  };
  return { deps, events, claims, human };
}

function staleRecoveryState(overrides: Record<string, unknown> = {}) {
  const claim: BranchClaim = {
    kind: 'branch-claim',
    protocolVersion: 2,
    phase: 'implement',
    issueNumber: 42,
    prNumber: 84,
    attempt: ATTEMPT_A,
    runner: 'runner-old',
    login: 'implementation-bot',
    expectedHead: BASE,
    targetBase: gitRefName('next'),
    claimedAt: '2026-07-20T08:00:00.000Z',
  };
  const pullRequest = { ...pr(), state: 'OPEN' as const };
  return {
    issue: issue({
      eligible: false,
      eligibilityDetail: 'Project status is In Progress',
    }),
    projectStatus: 'In Progress',
    humanHold: false,
    pullRequest,
    openPullRequests: [pullRequest],
    claim,
    ...overrides,
  };
}

function freshAction(issueNumber = 42) {
  return {
    kind: 'claim-implementation' as const,
    intent: 'fresh' as const,
    issueNumber,
  };
}

describe('implementation action executor', () => {
  it('rejects an implementation action without an explicit intent before any read', async () => {
    let reads = 0;
    const { deps } = harness({
      readIssue: async () => {
        reads += 1;
        return issue();
      },
    });

    await expect(executeImplementationAction({ issueNumber: 42 }, deps))
      .rejects.toThrow('explicit fresh or stale-recovery intent');
    expect(reads).toBe(0);
  });

  it('exposes the canonical gather-and-classify reality check for production injection', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const verdict = await runCanonicalImplementationRealityCheck(
      42,
      async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === 'git' && args.includes('fetch')) return '';
        if (cmd === 'gh' && args.includes('search')) return '[]';
        if (cmd === 'gh' && args.includes('issue')) {
          return '{"closedByPullRequestsReferences":[]}';
        }
        if (cmd === 'git' && args.includes('log')) return '';
        throw new Error(`unexpected call: ${cmd} ${args.join(' ')}`);
      },
    );

    expect(verdict.classification).toBe('clear');
    expect(calls[0]).toMatchObject({ cmd: 'git', args: expect.arrayContaining(['fetch']) });
  });

  it('elects one concurrent claim, creates one draft PR, and spawns one child', async () => {
    const shared = harness();
    let remoteHead: GitOid | null = null;
    shared.deps.claimBranch = async (input) => {
      shared.events.push('claim');
      shared.claims.push(input);
      if (remoteHead !== null) {
        return {
          status: 'lost',
          expected: input.expectedRemoteHead,
          published: input.claimOid,
          observed: remoteHead,
        };
      }
      remoteHead = input.claimOid;
      return {
        status: 'won',
        expected: input.expectedRemoteHead,
        published: input.claimOid,
        observed: input.claimOid,
      };
    };

    const [first, second] = await Promise.all([
      executeImplementationAction(freshAction(), shared.deps),
      executeImplementationAction(freshAction(), shared.deps),
    ]);

    expect([first.status, second.status].sort()).toEqual(['lost', 'spawned']);
    expect(shared.claims).toHaveLength(2);
    expect(shared.events.filter((event) => event === 'pr')).toHaveLength(1);
    expect(shared.events.filter((event) => event === 'spawn')).toHaveLength(1);
    expect(shared.events.indexOf('pr')).toBeLessThan(shared.events.indexOf('attempt'));
    expect(shared.events.indexOf('pr')).toBeLessThan(shared.events.indexOf('spawn'));
  });

  it('uses the stable branch and exact claim metadata for brand-new work', async () => {
    const { deps, claims, events } = harness();

    const result = await executeImplementationAction(freshAction(), deps);

    expect(result).toMatchObject({
      status: 'spawned',
      issueNumber: 42,
      prNumber: 84,
      branch: 'autopilot/42',
      claimOid: CLAIM_A,
      attemptId: ATTEMPT_A,
    });
    expect(claims).toEqual([expect.objectContaining({
      branch: 'autopilot/42',
      candidateParent: BASE,
      expectedRemoteHead: null,
      claimOid: CLAIM_A,
      remoteUrl: HTTPS_REMOTE,
      login: 'implementation-bot',
    })]);
    expect(events).toEqual(['claim', 'pr', 'project', 'attempt', 'spawn', 'track']);
  });

  it('starts a local implementation session with the full sanitized launch request after attempt setup', async () => {
    const requests: unknown[] = [];
    const { deps, events } = harness({
      startSession: async (request) => {
        events.push('start');
        requests.push(request);
        return { status: 'started', backend: 'local', pid: 4242 };
      },
    });

    await expect(executeImplementationAction(freshAction(), deps))
      .resolves.toMatchObject({ status: 'spawned', attemptId: ATTEMPT_A });
    expect(events).toEqual(['claim', 'pr', 'project', 'attempt', 'start']);
    expect(requests).toEqual([{
      kind: 'implementation',
      workflow: 'implementation',
      backend: 'local',
      manifestPath: `/tmp/${ATTEMPT_A}/manifest.json`,
      attemptId: ATTEMPT_A,
      issueNumber: 42,
      prNumber: 84,
      branch: 'autopilot/42',
      targetBase: 'next',
      worktreePath: `/tmp/${ATTEMPT_A}/worktree`,
      logPath: `/tmp/${ATTEMPT_A}/session.log`,
      local: {
        spawnInput: expect.objectContaining({
          attemptId: ATTEMPT_A,
          issue: expect.objectContaining({ number: 42 }),
          prNumber: 84,
          branch: 'autopilot/42',
          targetBase: 'next',
          environment: expect.objectContaining({
            GH_TOKEN: 'selected-secret',
            GIT_SSH_COMMAND: 'false',
            JINN_AUTOPILOT_SESSION_MANIFEST: `/tmp/${ATTEMPT_A}/manifest.json`,
          }),
          worktreePath: `/tmp/${ATTEMPT_A}/worktree`,
          logPath: `/tmp/${ATTEMPT_A}/session.log`,
        }),
      },
    }]);
  });

  it.skip('carries a brand-new executor claim into an authoritative session checkpoint', async () => {
    let initialClaim: BranchClaim | undefined;
    let createdAttempt: Parameters<ImplementationExecutorDeps['createAttempt']>[0] | undefined;
    const { deps } = harness({
      createClaimCommit: async ({ claim }) => {
        initialClaim = claim;
        return CLAIM_A;
      },
      createAttempt: async (input) => {
        createdAttempt = input;
        return {
          attemptId: input.attemptId,
          paths: {
            worktree: '/tmp/new-branch/worktree',
            manifest: '/tmp/new-branch/manifest.json',
            log: '/tmp/new-branch/session.log',
            ghConfigDir: '/tmp/new-branch/gh-config',
            askpass: '/tmp/new-branch/askpass',
          },
        };
      },
      startSession: async () => ({ status: 'started', backend: 'local', pid: 4242 }),
    });
    await expect(executeImplementationAction(freshAction(), deps))
      .resolves.toMatchObject({ status: 'spawned', prNumber: 84 });
    expect(initialClaim).not.toHaveProperty('prNumber');

    const manifest: AttemptManifest = {
      version: 2,
      attemptId: createdAttempt!.attemptId,
      runnerId: 'runner-a',
      host: 'host-a',
      phase: 'implement',
      subject: 'issue-42',
      issueNumber: 42,
      prNumber: createdAttempt!.prNumber,
      branch: createdAttempt!.branch,
      targetBase: createdAttempt!.targetBase,
      expectedHead: CLAIM_A,
      claimOid: CLAIM_A,
      selectedLogin: createdAttempt!.selectedLogin,
      repository: {
        root: '/repo',
        gitCommonDir: '/repo/.git',
        remoteName: 'jinn-autopilot-v2',
        remoteUrlHash: 'a'.repeat(64),
      },
      processState: 'running',
      pid: 4242,
      paths: {
        attemptDir: '/tmp/new-branch',
        worktree: '/tmp/new-branch/worktree',
        manifest: '/tmp/new-branch/manifest.json',
        log: '/tmp/new-branch/session.log',
        ghConfigDir: '/tmp/new-branch/gh-config',
        askpass: '/tmp/new-branch/askpass',
        tokenFile: '/tmp/new-branch/gh-token',
      },
      timestamps: {
        createdAt: '2026-07-20T12:00:00.000Z',
        updatedAt: '2026-07-20T12:01:00.000Z',
        childStartedAt: '2026-07-20T12:01:00.000Z',
      },
    };
    let progressiveHead = CLAIM_A;
    const port: ImplementationSessionPort = {
      readManifest: () => ({ ...manifest, expectedHead: progressiveHead }),
      readAuthority: async () => ({
        remoteHead: CLAIM_A,
        latestClaimOid: CLAIM_A,
        latestClaim: initialClaim!,
      }),
      readLocalHead: async () => WORK,
      readBranchClaim: async () => null,
      readCompletionSummary: async () => null,
      isAncestor: async (_manifest, ancestor, descendant) =>
        ancestor === descendant || (ancestor === CLAIM_A && descendant === WORK),
      treesDiffer: async () => true,
      publishBranch: async ({ expectedRemoteHead, newHead }) => ({
        status: 'won',
        expected: expectedRemoteHead,
        published: newHead,
        observed: newHead,
      }),
      advanceManifestHead: (_path, _expected, next) => {
        progressiveHead = next;
        return { ...manifest, expectedHead: next };
      },
      createCompletionCommit: async () => {
        throw new Error('not used');
      },
      readPullRequest: async () => ({
        number: 84,
        head: CLAIM_A,
        headRefName: 'autopilot/42',
        baseRefName: 'next',
        draft: true,
        labels: ['engine:review'],
        body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
      }),
      readPullRequestHead: async () => CLAIM_A,
      sleep: async () => {},
      ensureCompletionSummary: async () => {},
      setPullRequestLabel: async () => {},
      setProjectStatus: async () => {},
      readProjectStatus: async () => 'In Progress',
      setPullRequestDraft: async () => {},
      hasHumanComment: async () => false,
      ensureHumanComment: async () => {},
    };

    await expect(makeImplementationSessionProtocol(port).checkpoint(manifest))
      .resolves.toEqual({ status: 'published', head: WORK });
  });

  it('adopts one unambiguous open PR branch unchanged', async () => {
    const adopted = pr();
    const { deps, claims } = harness({
      listOpenPullRequests: async () => [adopted],
      runRealityCheck: async () => ({
        classification: 'pr-open',
        evidence: { prNumber: adopted.number },
        suggestedBlockedOn: 'Another issue',
        suggestedComment: 'Open PR exists.',
      }),
    });

    const result = await executeImplementationAction(freshAction(), deps);

    expect(result).toMatchObject({
      status: 'spawned',
      branch: adopted.headRefName,
      prNumber: adopted.number,
    });
    expect(claims[0]).toMatchObject({
      branch: adopted.headRefName,
      candidateParent: adopted.head,
      expectedRemoteHead: adopted.head,
    });
  });

  it('resumes stale work only from the pinned durable claim state', async () => {
    const state = staleRecoveryState();
    const { deps, claims, events } = harness({
      readIssue: async () => state.issue,
      readStaleRecovery: async () => state,
      listOpenPullRequests: async () => [state.pullRequest],
      runRealityCheck: async () => ({
        classification: 'pr-open',
        evidence: { prNumber: 84 },
        suggestedBlockedOn: 'Another issue',
        suggestedComment: 'Open PR exists.',
      }),
    });

    const result = await executeImplementationAction({
      kind: 'claim-implementation',
      intent: 'stale-recovery',
      issueNumber: 42,
      prNumber: 84,
      expectedHead: ADOPTED_HEAD,
      branch: gitRefName('existing/issue-42'),
      claimAttempt: ATTEMPT_A,
    }, deps);

    expect(result).toMatchObject({
      status: 'spawned',
      issueNumber: 42,
      prNumber: 84,
      branch: 'existing/issue-42',
    });
    expect(claims).toEqual([
      expect.objectContaining({
        branch: 'existing/issue-42',
        candidateParent: ADOPTED_HEAD,
        expectedRemoteHead: ADOPTED_HEAD,
      }),
    ]);
    expect(events).toEqual(['claim', 'pr', 'project', 'attempt', 'spawn', 'track']);
  });

  it('resumes pinned stale work after the live draft and issue are retargeted together', async () => {
    const historicalBase = gitRefName('stacked/original-base');
    const state = staleRecoveryState({
      claim: {
        ...staleRecoveryState().claim,
        targetBase: historicalBase,
      },
    });
    const createdClaims: BranchClaim[] = [];
    const { deps, claims, events } = harness({
      readStaleRecovery: async () => state,
      runRealityCheck: async () => ({
        classification: 'pr-open',
        evidence: { prNumber: 84 },
        suggestedBlockedOn: 'Another issue',
        suggestedComment: 'Open PR exists.',
      }),
      createClaimCommit: async ({ claim }) => {
        createdClaims.push(claim);
        return CLAIM_A;
      },
    });

    await expect(executeImplementationAction({
      kind: 'claim-implementation',
      intent: 'stale-recovery',
      issueNumber: 42,
      prNumber: 84,
      expectedHead: ADOPTED_HEAD,
      branch: gitRefName('existing/issue-42'),
      claimAttempt: ATTEMPT_A,
    }, deps)).resolves.toMatchObject({
      status: 'spawned',
      issueNumber: 42,
      prNumber: 84,
      branch: 'existing/issue-42',
    });
    expect(createdClaims).toEqual([
      expect.objectContaining({
        issueNumber: 42,
        prNumber: 84,
        expectedHead: ADOPTED_HEAD,
        targetBase: 'next',
      }),
    ]);
    expect(claims).toEqual([
      expect.objectContaining({
        branch: 'existing/issue-42',
        candidateParent: ADOPTED_HEAD,
        expectedRemoteHead: ADOPTED_HEAD,
      }),
    ]);
    expect(events).toEqual(['claim', 'pr', 'project', 'attempt', 'spawn', 'track']);
  });

  it('rejects stale recovery without authorized current target evidence before every mutation', async () => {
    const state = staleRecoveryState({ issue: null });
    const mutations: string[] = [];
    const { deps, claims, events, human } = harness({
      readStaleRecovery: async () => state,
      createClaimCommit: async () => {
        mutations.push('claim-commit');
        return CLAIM_A;
      },
    });

    await expect(executeImplementationAction({
      kind: 'claim-implementation',
      intent: 'stale-recovery',
      issueNumber: 42,
      prNumber: 84,
      expectedHead: ADOPTED_HEAD,
      branch: gitRefName('existing/issue-42'),
      claimAttempt: ATTEMPT_A,
    }, deps)).resolves.toEqual(expect.objectContaining({
      status: 'ineligible',
      detail: expect.stringContaining('has no authority projection'),
    }));
    expect(claims).toEqual([]);
    expect(events).toEqual([]);
    expect(human).toEqual([]);
    expect(mutations).toEqual([]);
  });

  // R5 — the stale-recovery path skips `issue.eligible` (see the test above:
  // an issue in recovery always reports `eligible: false` because its lifecycle
  // item is a pull-request), so the canon §5.1 projection gate did not reach it.
  // A follow-up claimed before the gate could observe its parent would be
  // resumed straight back into the escalation the gate exists to prevent.
  const followUpBody = (parentPr: number) =>
    `<!-- jinn-autopilot:review-follow-up pr=${parentPr} head=${'a'.repeat(40)} index=0 -->\n\nFix it.`;

  it('refuses stale recovery of a review follow-up while its parent PR is open', async () => {
    const state = staleRecoveryState({
      issue: issue({
        eligible: false,
        eligibilityDetail: 'Project status is In Progress',
        body: followUpBody(2065),
      }),
    });
    const { deps, claims, events, human } = harness({
      readStaleRecovery: async () => state,
      // The production port resolves OPEN pull requests only.
      readParentPullRequest: async () => pr({ number: 2065 }),
    });

    await expect(executeImplementationAction({
      kind: 'claim-implementation',
      intent: 'stale-recovery',
      issueNumber: 42,
      prNumber: 84,
      expectedHead: ADOPTED_HEAD,
      branch: gitRefName('existing/issue-42'),
      claimAttempt: ATTEMPT_A,
    }, deps)).resolves.toEqual(expect.objectContaining({
      status: 'ineligible',
      detail: expect.stringContaining('open parent PR #2065'),
    }));
    expect(claims).toEqual([]);
    expect(events).toEqual([]);
    expect(human).toEqual([]);
  });

  it('resumes stale recovery of a review follow-up once its parent PR is gone', async () => {
    const state = staleRecoveryState({
      issue: issue({
        eligible: false,
        eligibilityDetail: 'Project status is In Progress',
        body: followUpBody(2065),
      }),
    });
    const { deps, events } = harness({
      readStaleRecovery: async () => state,
      readParentPullRequest: async () => null,
      runRealityCheck: async () => ({
        classification: 'pr-open',
        evidence: { prNumber: 84 },
        suggestedBlockedOn: 'Another issue',
        suggestedComment: 'Open PR exists.',
      }),
    });

    await expect(executeImplementationAction({
      kind: 'claim-implementation',
      intent: 'stale-recovery',
      issueNumber: 42,
      prNumber: 84,
      expectedHead: ADOPTED_HEAD,
      branch: gitRefName('existing/issue-42'),
      claimAttempt: ATTEMPT_A,
    }, deps)).resolves.toMatchObject({ status: 'spawned', issueNumber: 42 });
    expect(events).toEqual(['claim', 'pr', 'project', 'attempt', 'spawn', 'track']);
  });

  it('refuses stale recovery when the review follow-up marker is unparseable', async () => {
    const state = staleRecoveryState({
      issue: issue({
        eligible: false,
        eligibilityDetail: 'Project status is In Progress',
        body: '<!-- jinn-autopilot:review-follow-up pr=2065 head=abc -->\n\nFix it.',
      }),
    });
    const parentReads: number[] = [];
    const { deps, claims } = harness({
      readStaleRecovery: async () => state,
      readParentPullRequest: async (number: number) => {
        parentReads.push(number);
        return null;
      },
    });

    await expect(executeImplementationAction({
      kind: 'claim-implementation',
      intent: 'stale-recovery',
      issueNumber: 42,
      prNumber: 84,
      expectedHead: ADOPTED_HEAD,
      branch: gitRefName('existing/issue-42'),
      claimAttempt: ATTEMPT_A,
    }, deps)).resolves.toEqual(expect.objectContaining({
      status: 'ineligible',
      detail: expect.stringContaining('unparseable review follow-up marker'),
    }));
    // No parent number is readable, so no parent lookup is attempted.
    expect(parentReads).toEqual([]);
    expect(claims).toEqual([]);
  });

  // Same trigger as the snapshot gate: the R5 refusal is permanent for the
  // life of the body, so it must not fire on an issue that merely quotes the
  // canon §5.1 marker template.
  it('resumes stale recovery of an issue quoting the canon §5.1 marker template', async () => {
    const canon = readFileSync(
      new URL('../../assets/canon/single-surface-lifecycle.md', import.meta.url),
      'utf8',
    );
    const template = canon.match(/`(<!-- jinn-autopilot:review-follow-up [^`]*-->)`/)?.[1];
    expect(template).toBeDefined();

    const state = staleRecoveryState({
      issue: issue({
        eligible: false,
        eligibilityDetail: 'Project status is In Progress',
        body: `Canon §5.1 requires the body marker:\n\n\`\`\`\n${template}\n\`\`\`\n`,
      }),
    });
    const parentReads: number[] = [];
    const { deps, events } = harness({
      readStaleRecovery: async () => state,
      readParentPullRequest: async (number: number) => {
        parentReads.push(number);
        return null;
      },
      runRealityCheck: async () => ({
        classification: 'pr-open',
        evidence: { prNumber: 84 },
        suggestedBlockedOn: 'Another issue',
        suggestedComment: 'Open PR exists.',
      }),
    });

    await expect(executeImplementationAction({
      kind: 'claim-implementation',
      intent: 'stale-recovery',
      issueNumber: 42,
      prNumber: 84,
      expectedHead: ADOPTED_HEAD,
      branch: gitRefName('existing/issue-42'),
      claimAttempt: ATTEMPT_A,
    }, deps)).resolves.toMatchObject({ status: 'spawned', issueNumber: 42 });
    // Not marker-shaped at all, so the gate never engages.
    expect(parentReads).toEqual([]);
    expect(events).toEqual(['claim', 'pr', 'project', 'attempt', 'spawn', 'track']);
  });

  // Fail closed on a missing optional dep, matching the child-claim gate: a
  // parseable follow-up marker states a dependency that cannot be checked
  // without the lookup, so the claim is refused rather than waved through.
  it('refuses stale recovery of a review follow-up when parent PR lookup is unavailable', async () => {
    const state = staleRecoveryState({
      issue: issue({
        eligible: false,
        eligibilityDetail: 'Project status is In Progress',
        body: followUpBody(2065),
      }),
    });
    const { deps, claims, events, human } = harness({
      readStaleRecovery: async () => state,
      readParentPullRequest: undefined,
    });

    await expect(executeImplementationAction({
      kind: 'claim-implementation',
      intent: 'stale-recovery',
      issueNumber: 42,
      prNumber: 84,
      expectedHead: ADOPTED_HEAD,
      branch: gitRefName('existing/issue-42'),
      claimAttempt: ATTEMPT_A,
    }, deps)).resolves.toEqual(expect.objectContaining({
      status: 'ineligible',
      detail: expect.stringContaining('Parent PR lookup is unavailable'),
    }));
    expect(claims).toEqual([]);
    expect(events).toEqual([]);
    expect(human).toEqual([]);
  });

  it('escalates duplicate open implementation PRs without publishing a recovery claim', async () => {
    const pinned = { ...pr(), state: 'OPEN' as const };
    const duplicate = {
      ...pr({
        number: 85,
        headRefName: gitRefName('other/issue-42'),
      }),
      state: 'OPEN' as const,
    };
    const state = staleRecoveryState({
      pullRequest: pinned,
      openPullRequests: [pinned, duplicate],
    });
    const { deps, claims, events, human } = harness({
      readStaleRecovery: async () => state,
      runRealityCheck: async () => ({
        classification: 'pr-open',
        evidence: { prNumber: 84 },
        suggestedBlockedOn: 'Another issue',
        suggestedComment: 'Open PR exists.',
      }),
    });

    await expect(executeImplementationAction({
      kind: 'claim-implementation',
      intent: 'stale-recovery',
      issueNumber: 42,
      prNumber: 84,
      expectedHead: ADOPTED_HEAD,
      branch: gitRefName('existing/issue-42'),
      claimAttempt: ATTEMPT_A,
    }, deps)).resolves.toEqual({
      status: 'human',
      issueNumber: 42,
      code: 'branch-mapping-ambiguous',
    });
    expect(claims).toEqual([]);
    expect(events).toEqual([]);
    expect(human).toEqual([expect.objectContaining({
      issueNumber: 42,
      reason: expect.objectContaining({
        code: 'branch-mapping-ambiguous',
        detail: expect.stringMatching(/PR #84.*PR #85/),
      }),
    })]);
  });

  it.each([
    // Each of the three issue-authority causes carries its own message; they
    // were previously one collapsed "missing or closed" string.
    ['missing issue', { issue: null }, 'has no authority projection'],
    ['attributed missing issue', {
      issue: null,
      issueRefusal: 'issue #42 is absent from the snapshot issue index',
    }, 'has no authority projection: issue #42 is absent from the snapshot issue index'],
    ['closed issue', { issue: issue({ open: false }) }, 'issue #42 is closed.'],
    ['changed issue', { issue: issue({ number: 43 }) }, 'changed to issue #43'],
    ['missing PR', { pullRequest: null }, 'is missing'],
    ['changed PR', { pullRequest: { ...pr(), number: 85, state: 'OPEN' } }, 'PR #84'],
    ['closed PR', { pullRequest: { ...pr(), state: 'CLOSED' } }, 'not open'],
    ['non-draft PR', { pullRequest: { ...pr(), state: 'OPEN', draft: false } }, 'not a draft'],
    ['changed head', {
      pullRequest: { ...pr(), state: 'OPEN', head: WORK },
    }, 'head changed'],
    ['changed branch', {
      pullRequest: {
        ...pr(),
        state: 'OPEN',
        headRefName: gitRefName('other/issue-42'),
      },
    }, 'branch changed'],
    ['changed issue target base', {
      issue: issue({ targetBase: gitRefName('release/next') }),
    }, 'target base changed'],
    ['changed PR target base', {
      pullRequest: {
        ...pr(),
        state: 'OPEN',
        baseRefName: gitRefName('release/next'),
      },
    }, 'target base changed'],
    ['changed bounded PR mapping', { openPullRequests: [] }, 'bounded open mapping'],
    ['missing claim', { claim: null }, 'matching implementation claim'],
    ['changed claim phase', {
      claim: {
        ...staleRecoveryState().claim,
        phase: 'review',
      },
    }, 'matching implementation claim'],
    ['changed claim issue', {
      claim: {
        ...staleRecoveryState().claim,
        issueNumber: 43,
      },
    }, 'matching implementation claim'],
    ['changed claim PR', {
      claim: {
        ...staleRecoveryState().claim,
        prNumber: 85,
      },
    }, 'matching implementation claim'],
    ['changed claim', {
      claim: {
        ...staleRecoveryState().claim,
        attempt: ATTEMPT_B,
      },
    }, 'claim attempt changed'],
    ['finished claim', {
      claim: {
        ...staleRecoveryState().claim,
        phaseComplete: true,
      },
    }, 'claim is finished'],
    ['Human state', { humanHold: true }, 'Human'],
    ['changed Project status', { projectStatus: 'Todo' }, 'Project status changed'],
  ])('rejects stale recovery with specific evidence for %s and never falls back', async (
    _name,
    changed,
    detail,
  ) => {
    const state = staleRecoveryState(changed);
    const mutations: string[] = [];
    const { deps, claims, events, human } = harness({
      readIssue: async () => state.issue,
      readStaleRecovery: async () => state,
      listOpenPullRequests: async () => [state.pullRequest],
      createClaimCommit: async () => {
        mutations.push('claim-commit');
        return CLAIM_A;
      },
    });

    await expect(executeImplementationAction({
      kind: 'claim-implementation',
      intent: 'stale-recovery',
      issueNumber: 42,
      prNumber: 84,
      expectedHead: ADOPTED_HEAD,
      branch: gitRefName('existing/issue-42'),
      claimAttempt: ATTEMPT_A,
    }, deps)).resolves.toEqual(expect.objectContaining({
      status: 'ineligible',
      detail: expect.stringContaining(detail),
    }));
    expect(claims).toEqual([]);
    expect(events).toEqual([]);
    expect(human).toEqual([]);
    expect(mutations).toEqual([]);
  });

  // The collapsed "missing or closed" message named a cause the production
  // port cannot produce (its projection hardcodes `open: true` and copies the
  // matched number), so an issue withheld for a stacking reason was reported
  // as missing. Each condition must now be separately identifiable, and the
  // port's own attribution must reach the operator-facing line verbatim.
  it('reports each stale recovery issue-authority cause distinguishably', async () => {
    const reject = async (changed: Record<string, unknown>) => {
      const state = staleRecoveryState(changed);
      const { deps } = harness({
        readIssue: async () => state.issue,
        readStaleRecovery: async () => state,
        listOpenPullRequests: async () => [state.pullRequest],
      });
      const result = await executeImplementationAction({
        kind: 'claim-implementation',
        intent: 'stale-recovery',
        issueNumber: 42,
        prNumber: 84,
        expectedHead: ADOPTED_HEAD,
        branch: gitRefName('existing/issue-42'),
        claimAttempt: ATTEMPT_A,
      }, deps);
      expect(result.status).toBe('ineligible');
      return (result as { detail: string }).detail;
    };

    const absent = await reject({ issue: null });
    const closed = await reject({ issue: issue({ open: false }) });
    const changed = await reject({ issue: issue({ number: 43 }) });
    expect(new Set([absent, closed, changed]).size).toBe(3);
    expect(absent).not.toContain('closed');
    expect(closed).not.toContain('changed');

    // The stacking refusal the live #2040 strand actually hit: present, open,
    // and withheld only because no blocker PR cleared the author boundary.
    const attributed = await reject({
      issue: null,
      issueRefusal:
        'issue #2040 is open but has no authorized stacking base — blocker issue #2039 '
        + 'has an open PR #2081 by outsider, and no author is on the dispatch author allowlist',
    });
    expect(attributed).toContain('#2039');
    expect(attributed).toContain('PR #2081');
    expect(attributed).toContain('allowlist');
    expect(attributed).not.toBe(absent);
  });

  it('rejects ordinary In Progress work with its specific eligibility evidence', async () => {
    const { deps, claims } = harness({
      readIssue: async () => issue({
        eligible: false,
        eligibilityDetail: 'Project status is In Progress',
      }),
    });

    await expect(executeImplementationAction({
      kind: 'claim-implementation',
      intent: 'fresh',
      issueNumber: 42,
    }, deps)).resolves.toEqual({
      status: 'ineligible',
      issueNumber: 42,
      detail: 'Project status is In Progress',
    });
    expect(claims).toEqual([]);
  });

  it('does not claim missing, ineligible, or resolved work', async () => {
    const cases: Array<Partial<ImplementationExecutorDeps>> = [
      { readIssue: async () => null },
      { readIssue: async () => issue({ eligible: false }) },
      {
        runRealityCheck: async () => ({
          classification: 'fixed-on-trunk',
          evidence: { sha: BASE, branch: 'next' },
          suggestedBlockedOn: 'Human',
          suggestedComment: 'Already fixed.',
        }),
      },
    ];

    for (const override of cases) {
      const { deps, claims, events } = harness(override);
      await expect(executeImplementationAction(freshAction(), deps))
        .resolves.toMatchObject({ status: 'ineligible' });
      expect(claims).toEqual([]);
      expect(events).toEqual([]);
    }
  });

  it('escalates contradictory branch mappings without a claim', async () => {
    const { deps, claims, human } = harness({
      listOpenPullRequests: async () => [
        pr(),
        pr({ number: 85, headRefName: gitRefName('other/issue-42') }),
      ],
    });

    await expect(executeImplementationAction(freshAction(), deps))
      .resolves.toMatchObject({ status: 'human', code: 'branch-mapping-ambiguous' });
    expect(claims).toEqual([]);
    expect(human).toEqual([expect.objectContaining({
      issueNumber: 42,
      reason: expect.objectContaining({
        phase: 'eligible',
        code: 'branch-mapping-ambiguous',
      }),
    })]);
  });

  it('preserves the fresh-work target-base gate for a sole retargeted PR', async () => {
    const retargeted = pr({ baseRefName: gitRefName('release/next') });
    const { deps, claims, events, human } = harness({
      listOpenPullRequests: async () => [retargeted],
      runRealityCheck: async () => ({
        classification: 'pr-open',
        evidence: { prNumber: retargeted.number },
        suggestedBlockedOn: 'Another issue',
        suggestedComment: 'Open PR exists.',
      }),
    });

    await expect(executeImplementationAction(freshAction(), deps))
      .resolves.toEqual({
        status: 'human',
        issueNumber: 42,
        code: 'branch-mapping-ambiguous',
      });
    expect(claims).toEqual([]);
    expect(events).toEqual([]);
    expect(human).toEqual([expect.objectContaining({
      issueNumber: 42,
      reason: expect.objectContaining({
        code: 'branch-mapping-ambiguous',
        detail: expect.stringMatching(/release\/next/),
      }),
    })]);
  });

  it('escalates multiple open PRs before applying the pr-open reality verdict', async () => {
    const existing = pr();
    const { deps, claims, human } = harness({
      listOpenPullRequests: async () => [
        existing,
        pr({ number: 85, headRefName: gitRefName('other/issue-42') }),
      ],
      runRealityCheck: async () => ({
        classification: 'pr-open',
        evidence: { prNumber: existing.number },
        suggestedBlockedOn: 'Another issue',
        suggestedComment: 'Open PR exists.',
      }),
    });

    await expect(executeImplementationAction(freshAction(), deps))
      .resolves.toMatchObject({ status: 'human', code: 'branch-mapping-ambiguous' });
    expect(claims).toEqual([]);
    expect(human).toHaveLength(1);
  });

  it('escalates a sole mapped PR that contradicts canonical pr-open reality evidence', async () => {
    const mapped = pr({ number: 85 });
    const { deps, claims, human } = harness({
      listOpenPullRequests: async () => [mapped],
      runRealityCheck: async () => ({
        classification: 'pr-open',
        evidence: { prNumber: 84 },
        suggestedBlockedOn: 'Another issue',
        suggestedComment: 'Canonical reality evidence names PR #84.',
      }),
    });

    await expect(executeImplementationAction(freshAction(), deps))
      .resolves.toMatchObject({ status: 'human', code: 'branch-mapping-ambiguous' });
    expect(claims).toEqual([]);
    expect(human).toEqual([expect.objectContaining({
      issueNumber: 42,
      reason: expect.objectContaining({
        phase: 'eligible',
        code: 'branch-mapping-ambiguous',
        detail: expect.stringMatching(/PR #84.*PR #85/),
      }),
    })]);
  });

  it('escalates when canonical pr-open reality has no bounded PR mapping', async () => {
    const { deps, claims, events, human } = harness({
      listOpenPullRequests: async () => [],
      runRealityCheck: async () => ({
        classification: 'pr-open',
        evidence: { prNumber: 84 },
        suggestedBlockedOn: 'Another issue',
        suggestedComment: 'Canonical reality evidence names PR #84.',
      }),
    });

    await expect(executeImplementationAction(freshAction(), deps))
      .resolves.toMatchObject({ status: 'human', code: 'branch-mapping-ambiguous' });
    expect(claims).toEqual([]);
    expect(events).toEqual([]);
    expect(human).toEqual([expect.objectContaining({
      issueNumber: 42,
      reason: expect.objectContaining({
        phase: 'eligible',
        code: 'branch-mapping-ambiguous',
        detail: expect.stringMatching(/PR #84.*no open PR/),
      }),
    })]);
  });

  it('preserves structural PR ambiguity as Human before ordinary eligibility', async () => {
    let realityChecks = 0;
    const { deps, claims, human } = harness({
      readIssue: async () => issue({ eligible: false }),
      runRealityCheck: async () => {
        realityChecks += 1;
        return {
          classification: 'fixed-on-trunk',
          evidence: { sha: BASE, branch: 'next' },
          suggestedBlockedOn: 'Human',
          suggestedComment: 'Already fixed.',
        };
      },
      listOpenPullRequests: async () => [
        pr(),
        pr({ number: 85, headRefName: gitRefName('other/issue-42') }),
      ],
    });

    await expect(executeImplementationAction(freshAction(), deps))
      .resolves.toMatchObject({ status: 'human', code: 'branch-mapping-ambiguous' });
    expect(realityChecks).toBe(1);
    expect(claims).toEqual([]);
    expect(human).toHaveLength(1);
  });

  it('fails closed when target-base authority changes after the claim', async () => {
    let reads = 0;
    const { deps, events } = harness({
      readIssue: async () => reads++ === 0
        ? issue()
        : issue({ targetBase: gitRefName('release/next') }),
    });

    await expect(executeImplementationAction(freshAction(), deps))
      .resolves.toMatchObject({
        status: 'partial',
        code: 'target-base-changed',
        claimOid: CLAIM_A,
      });
    expect(events).toEqual(['claim']);
  });

  it('continues after claim when eligibility flips off the ready queue', async () => {
    let reads = 0;
    const { deps, events } = harness({
      readIssue: async () => reads++ === 0
        ? issue()
        : issue({ eligible: false }),
    });

    await expect(executeImplementationAction(freshAction(), deps))
      .resolves.toMatchObject({ status: 'spawned', issueNumber: 42 });
    expect(events).toEqual(['claim', 'pr', 'project', 'attempt', 'spawn', 'track']);
  });

  it.each([
    ['review-finding', 'fix'],
    ['reconcile', 'reconcile'],
    ['ci-failure', 'fix'],
  ] as const)(
    'claims the parent branch and starts the shared implementation session for %s children',
    async (childKind, phase) => {
      const parent = pr({
        number: 2065,
        headRefName: gitRefName('autopilot/2044'),
        head: ADOPTED_HEAD,
        baseRefName: gitRefName('next'),
        draft: false,
      });
      const starts: unknown[] = [];
      const claimCommits: BranchClaim[] = [];
      const { deps, claims } = harness({
        readIssue: async () => issue({
          number: 2069,
          title: `Address ${childKind} work for PR #2065`,
          child: { parentPr: 2065, kind: childKind },
        }),
        readParentPullRequest: async () => parent,
        createClaimCommit: async ({ claim }) => {
          claimCommits.push(claim);
          return CLAIM_A;
        },
        startSession: async (request) => {
          starts.push(request);
          return { status: 'started', backend: 'local', pid: 4242 };
        },
      });

      const result = await executeImplementationAction(freshAction(2069), deps);

      expect(result).toMatchObject({
        status: 'spawned',
        issueNumber: 2069,
        prNumber: 2065,
        branch: parent.headRefName,
      });
      expect(claimCommits[0]).toMatchObject({
        phase,
        issueNumber: 2069,
        prNumber: 2065,
      });
      expect(claims[0]).toMatchObject({
        branch: parent.headRefName,
        candidateParent: parent.head,
        expectedRemoteHead: parent.head,
        claimOid: CLAIM_A,
        remoteUrl: HTTPS_REMOTE,
        login: 'implementation-bot',
      });
      expect(starts[0]).toMatchObject({
        kind: 'implementation',
        workflow: childKind,
        local: {
          spawnInput: {
            issue: expect.objectContaining({
              number: 2069,
              child: { parentPr: 2065, kind: childKind },
            }),
            prNumber: 2065,
            branch: parent.headRefName,
          },
        },
      });
    },
  );

  it('builds an immutable ordinary marketplace request from claim authority without constructing local spawn data', async () => {
    let createdAttempt: unknown;
    let startedRequest: unknown;
    let targetBaseReads = 0;
    const credentials = new CredentialPool([{
      login: 'implementation-bot',
      normalizedLogin: 'implementation-bot',
      implementationToken: 'selected-secret',
    }, {
      login: 'review-bot',
      normalizedLogin: 'review-bot',
      reviewToken: 'review-secret',
    }]);
    const { deps } = harness({
      executionBackend: 'marketplace',
      marketplace: {
        repository: 'Jinn-Network/mono',
        language: 'typescript',
        verificationProfile: 'jinn-mono.v1',
      },
      credentials,
      readTargetBaseHead: async () => {
        targetBaseReads += 1;
        return BASE;
      },
      createAttempt: async (input) => {
        createdAttempt = input;
        return {
          attemptId: input.attemptId,
          paths: {
            worktree: `/tmp/${input.attemptId}/worktree`,
            manifest: `/tmp/${input.attemptId}/manifest.json`,
            log: `/tmp/${input.attemptId}/session.log`,
            ghConfigDir: `/tmp/${input.attemptId}/gh-config`,
            askpass: `/tmp/${input.attemptId}/askpass`,
          },
        };
      },
      startSession: async (request) => {
        startedRequest = request;
        return {
          status: 'started',
          backend: 'marketplace',
          id: `autopilot:${ATTEMPT_A}`,
          taskId: 'task-42',
          taskCid: 'bafy-task-42',
        };
      },
    });

    await expect(executeImplementationAction(freshAction(), deps))
      .resolves.toMatchObject({ status: 'spawned', attemptId: ATTEMPT_A });
    expect(targetBaseReads).toBe(1);
    expect(startedRequest).toMatchObject({
      kind: 'implementation',
      workflow: 'implementation',
      backend: 'marketplace',
      attemptId: ATTEMPT_A,
    });
    expect(startedRequest).not.toHaveProperty('local');
    expect(JSON.stringify(startedRequest)).not.toContain('selected-secret');
    expect(createdAttempt).toMatchObject({
      targetBaseOid: BASE,
      marketplacePreparation: {
        workflow: 'implementation',
        baseSha: BASE,
      },
    });
    const preparation = createdAttempt.marketplacePreparation;
    const request = TaskSubmitRequestV1Schema.parse(preparation.request);
    expect(request.spec.session).toMatchObject({
      schemaVersion: 'jinn-autopilot-session.v1',
      workflow: 'implement',
      issueNumber: 42,
      prNumber: 84,
      branch: 'autopilot/42',
      targetBase: 'next',
      claimOid: CLAIM_A,
      expectedHead: CLAIM_A,
      v2AttemptId: ATTEMPT_A,
      runnerId: 'runner-a',
      receiptAuthors: ['implementation-bot', 'review-bot'],
      taskSnapshot: {
        title: 'Implement exact lifecycle ownership',
        body: 'Authoritative issue body for #42.',
        prBody: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
        baseSha: BASE,
        targetBaseOid: BASE,
      },
    });
    expect(request.spec.problem_statement)
      .toBe('Authoritative issue body for #42.');
  });

  it('reads exact target-base authority for an adopted marketplace branch while preserving its pre-claim head as baseSha', async () => {
    const adopted = pr();
    let targetBaseReads = 0;
    let preparation: unknown;
    const { deps } = harness({
      executionBackend: 'marketplace',
      marketplace: {
        repository: 'Jinn-Network/mono',
        language: 'typescript',
        verificationProfile: 'jinn-mono.v1',
      },
      listOpenPullRequests: async () => [adopted],
      runRealityCheck: async () => ({
        classification: 'pr-open',
        evidence: { prNumber: adopted.number },
        suggestedBlockedOn: null,
        suggestedComment: null,
      }),
      readTargetBaseHead: async () => {
        targetBaseReads += 1;
        return BASE;
      },
      createAttempt: async (input) => {
        preparation = input.marketplacePreparation;
        return {
          attemptId: input.attemptId,
          paths: {
            worktree: `/tmp/${input.attemptId}/worktree`,
            manifest: `/tmp/${input.attemptId}/manifest.json`,
            log: `/tmp/${input.attemptId}/session.log`,
            ghConfigDir: `/tmp/${input.attemptId}/gh-config`,
            askpass: `/tmp/${input.attemptId}/askpass`,
          },
        };
      },
      startSession: async () => ({
        status: 'started',
        backend: 'marketplace',
        id: `autopilot:${ATTEMPT_A}`,
        taskId: 'task-42',
        taskCid: 'bafy-task-42',
      }),
    });

    await expect(executeImplementationAction(freshAction(), deps))
      .resolves.toMatchObject({ status: 'spawned', branch: adopted.headRefName });
    expect(targetBaseReads).toBe(1);
    expect(preparation).toMatchObject({ baseSha: adopted.head });
    expect(TaskSubmitRequestV1Schema.parse(preparation.request).spec.session.taskSnapshot)
      .toMatchObject({
        baseSha: adopted.head,
        targetBaseOid: BASE,
      });
  });

  it.each([
    ['review-finding', 'fix-child'],
    ['reconcile', 'reconcile'],
    ['ci-failure', 'ci-failure'],
  ] as const)(
    'builds the authoritative %s child marketplace request on the parent branch without local spawn data',
    async (childKind, sdkWorkflow) => {
      const parent = pr({
        number: 2065,
        headRefName: gitRefName('autopilot/2044'),
        head: ADOPTED_HEAD,
        baseRefName: gitRefName('next'),
        draft: false,
        body: 'Authoritative parent PR body.',
      });
      let targetBaseReads = 0;
      let createdAttempt: unknown;
      let startedRequest: unknown;
      const { deps } = harness({
        executionBackend: 'marketplace',
        marketplace: {
          repository: 'Jinn-Network/mono',
          language: 'typescript',
          verificationProfile: 'jinn-mono.v1',
        },
        readIssue: async () => issue({
          number: 2069,
          title: `Address ${childKind} work for PR #2065`,
          body: `Authoritative ${childKind} child body.`,
          child: { parentPr: 2065, kind: childKind },
        }),
        readParentPullRequest: async () => parent,
        readTargetBaseHead: async () => {
          targetBaseReads += 1;
          return BASE;
        },
        createAttempt: async (input) => {
          createdAttempt = input;
          return {
            attemptId: input.attemptId,
            paths: {
              worktree: `/tmp/${input.attemptId}/worktree`,
              manifest: `/tmp/${input.attemptId}/manifest.json`,
              log: `/tmp/${input.attemptId}/session.log`,
              ghConfigDir: `/tmp/${input.attemptId}/gh-config`,
              askpass: `/tmp/${input.attemptId}/askpass`,
            },
          };
        },
        startSession: async (request) => {
          startedRequest = request;
          return {
            status: 'started',
            backend: 'marketplace',
            id: `autopilot:${ATTEMPT_A}`,
            taskId: 'task-child',
            taskCid: 'bafy-task-child',
          };
        },
      });

      await expect(executeImplementationAction(freshAction(2069), deps))
        .resolves.toMatchObject({
          status: 'spawned',
          prNumber: 2065,
          branch: parent.headRefName,
        });
      expect(targetBaseReads).toBe(1);
      expect(startedRequest).toMatchObject({
        backend: 'marketplace',
        workflow: childKind,
        issueNumber: 2069,
        prNumber: 2065,
        branch: parent.headRefName,
      });
      expect(startedRequest).not.toHaveProperty('local');
      expect(createdAttempt).toMatchObject({
        targetBaseOid: BASE,
        marketplacePreparation: {
          workflow: childKind,
          baseSha: parent.head,
        },
      });
      const request = TaskSubmitRequestV1Schema.parse(
        createdAttempt.marketplacePreparation.request,
      );
      expect(request.spec.session).toMatchObject({
        workflow: sdkWorkflow,
        issueNumber: 2069,
        childIssueNumber: 2069,
        prNumber: 2065,
        parentPrNumber: 2065,
        branch: parent.headRefName,
        claimOid: CLAIM_A,
        expectedHead: CLAIM_A,
        taskSnapshot: {
          title: `Address ${childKind} work for PR #2065`,
          body: `Authoritative ${childKind} child body.`,
          prBody: 'Authoritative parent PR body.',
          baseSha: parent.head,
          targetBaseOid: BASE,
        },
      });
      expect(JSON.stringify({ startedRequest, request }))
        .not.toContain('selected-secret');
    },
  );

  it('fails closed when the claim result remains ambiguous', async () => {
    const { deps, events } = harness({
      claimBranch: async (input) => ({
        status: 'ambiguous',
        expected: input.expectedRemoteHead,
        published: input.claimOid,
        observed: null,
      }),
    });

    await expect(executeImplementationAction(freshAction(), deps))
      .resolves.toMatchObject({ status: 'ambiguous' });
    expect(events).toEqual([]);
  });
});
