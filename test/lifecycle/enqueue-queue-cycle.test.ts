import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/dispatcher/types.js';
import { makeProductionActiveRuntime } from '../../src/lifecycle/active-runtime-production.js';
import { runLifecycleCycle } from '../../src/lifecycle/controller.js';
import { CredentialPool } from '../../src/lifecycle/credentials.js';
import {
  encodeEnqueueRecord,
  enqueueRef,
} from '../../src/lifecycle/enqueue-record.js';
import {
  enqueueHoldRef,
  type EnqueueHoldKind,
} from '../../src/lifecycle/enqueue-hold.js';
import { phaseStatus } from '../../src/lifecycle/projection.js';
import type { ReconciliationWriter } from '../../src/lifecycle/reconciler.js';
import { deriveMergeState } from '../../src/lifecycle/snapshot.js';
import type {
  CheckSummary,
  GitHubLifecycleSnapshot,
  MergeQueueSnapshot,
  PullRequestSnapshot,
} from '../../src/lifecycle/snapshot.js';
import type { ChildKind } from '../../src/lifecycle/child-issues.js';
import { gitOid, gitRefName, isoTimestamp } from '../../src/lifecycle/types.js';
import type { CompareStatus, GitOid } from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));
const NEW_HEAD = gitOid('4'.repeat(40));
const FORK_POINT = gitOid('3'.repeat(40));
const NOW = new Date('2026-07-20T12:00:00.000Z');
const SLUG = 'Jinn-Network/mono';
const DEFAULT_BRANCH = 'next';
const GRAPHQL_ID = 'PR_kwDOABCD84';
const GENERATION = '22222222-2222-4222-8222-222222222222';
const ATTEMPT = '33333333-3333-4333-8333-333333333333';
const INTENT = '44444444-4444-4444-8444-444444444444';
const REVIEWER = 'review-bot';

function marker(head: string): string {
  return '<!-- jinn-autopilot-review:v2 '
    + `generation=${GENERATION} `
    + `attempt=${ATTEMPT} `
    + `intent=${INTENT} `
    + `reviewer=${REVIEWER} `
    + `head=${head} `
    + 'verdict=APPROVE -->';
}

/**
 * The ten contexts Jinn-Network/mono actually requires. Six run on the pull
 * request; four are merge-group-only and never report a PR-level check, which
 * is the shape that would make a "wait for every required context" gate wait
 * forever.
 */
const FAST_LANE_CONTEXTS = [
  'canonical-docs-gate',
  'console-ci-gate',
  'jinn-agent-gate',
  'operator-ci-gate',
  'repo-structure-gate',
  'stack-fixture-gate',
] as const;

const MERGE_GROUP_ONLY_CONTEXTS = [
  'hermetic-gate',
  'layer-ci-gate',
  'platform-architecture-control',
  'platform-verification',
] as const;

const REQUIRED_CONTEXTS = [
  ...FAST_LANE_CONTEXTS,
  ...MERGE_GROUP_ONLY_CONTEXTS,
] as const;

const FIELD_LIST_JSON = JSON.stringify({
  fields: [
    {
      id: 'PVTSSF_blocked',
      name: 'Blocked on',
      options: [
        { id: 'opt_nothing', name: 'Nothing' },
        { id: 'opt_human', name: 'Human' },
      ],
    },
    {
      id: 'PVTSSF_effort',
      name: 'Effort',
      options: [
        { id: 'opt_low', name: 'Low' },
        { id: 'opt_medium', name: 'Medium' },
        { id: 'opt_high', name: 'High' },
        { id: 'opt_xhigh', name: 'XHigh' },
        { id: 'opt_max', name: 'Max' },
      ],
    },
    {
      id: 'PVTSSF_priority',
      name: 'Priority',
      options: [
        { id: 'opt_p0', name: 'P0' },
        { id: 'opt_p1', name: 'P1' },
        { id: 'opt_p2', name: 'P2' },
        { id: 'opt_p3', name: 'P3' },
        { id: 'opt_p4', name: 'P4' },
      ],
    },
  ],
});

function green(names: readonly string[]): readonly CheckSummary[] {
  return names.map((name) => ({
    source: 'check-run' as const,
    name,
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
  }));
}

interface Fixture {
  readonly head?: GitOid;
  readonly state?: 'OPEN' | 'MERGED';
  readonly mergeQueue?: MergeQueueSnapshot;
  readonly checks?: readonly CheckSummary[];
  readonly compareStatus?: CompareStatus;
  readonly mergeability?: PullRequestSnapshot['mergeability'];
  readonly mergeStateStatus?: string;
  readonly baseRefName?: string;
  readonly openChildKinds?: readonly ChildKind[];
}

/**
 * `holdAtHead` stands in for the reader's `listEnqueueHoldHeads` stamp, and is
 * resolved against the SAME remote ref map the executor pushes hold refs into.
 * That keeps the two halves of the mechanism honest in one fixture: a hold this
 * cycle writes is a hold the next cycle's snapshot carries, and a hold recorded
 * at a head that has since been replaced stamps nothing.
 */
function snapshotFor(
  fixture: Fixture = {},
  holdAtHead: (head: GitOid) => EnqueueHoldKind | undefined = () => undefined,
): GitHubLifecycleSnapshot {
  const head = fixture.head ?? HEAD;
  const state = fixture.state ?? 'OPEN';
  const baseRefName = fixture.baseRefName ?? DEFAULT_BRANCH;
  const checks = fixture.checks ?? green(FAST_LANE_CONTEXTS);
  const merged = state === 'MERGED';
  const pullRequest: PullRequestSnapshot = {
    number: 84,
    title: 'feat: lifecycle',
    body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
    author: 'implementation-bot',
    baseRefName,
    headRefName: 'autopilot/42',
    headOid: head,
    headCommittedAt: isoTimestamp('2026-07-20T11:00:00.000Z'),
    graphqlId: GRAPHQL_ID,
    isDraft: false,
    state,
    labels: ['engine:review'],
    closingIssueNumbers: [42],
    mergeability: fixture.mergeability ?? 'MERGEABLE',
    mergeStateStatus: fixture.mergeStateStatus ?? 'CLEAN',
    compareStatus: fixture.compareStatus ?? 'ahead',
    checks,
    reviews: [{
      reviewer: REVIEWER,
      state: 'APPROVED',
      commitId: head,
      body: `${marker(head)}\n\nApproved.`,
      submittedAt: '2026-07-20T11:30:00.000Z',
    }],
    ...(fixture.mergeQueue === undefined ? {} : { mergeQueue: fixture.mergeQueue }),
    branchClaim: {
      kind: 'branch-claim',
      protocolVersion: 2,
      phase: 'implement',
      phaseComplete: true,
      issueNumber: 42,
      prNumber: 84,
      attempt: '11111111-1111-4111-8111-111111111111',
      runner: 'runner-a',
      login: 'implementation-bot',
      expectedHead: head,
      targetBase: gitRefName(baseRefName),
      claimedAt: '2026-07-20T11:00:00.000Z',
    },
  };
  // The projection under test, not a restatement of it. `deriveMergeState` is
  // the production derivation `composeGitHubLifecycleSnapshot` runs, so a
  // fixture that says MERGEABLE/BLOCKED reaches the scheduler through exactly
  // the code path a live snapshot would — which is the whole point of an
  // acceptance suite, and what a hand-rolled copy of this ladder silently
  // stopped doing the moment the real one changed.
  const mergeState = deriveMergeState(pullRequest);
  return {
    project: {
      items: [],
      rateLimit: {
        remaining: 4_000,
        used: 1_000,
        resetAt: '2026-07-20T13:00:00.000Z',
      },
      currentSprintIterationId: null,
    },
    issues: [],
    branches: [],
    diagnostics: [],
    snapshotMode: 'full',
    snapshotComplete: true,
    lastFullReconciliationAt: NOW.toISOString(),
    capturedAt: NOW.toISOString(),
    githubUsage: {
      graphqlRequests: 1,
      graphqlCost: 1,
      graphqlRemaining: 4_000,
      graphqlResetAt: '2026-07-20T13:00:00.000Z',
      restRequests: 0,
      restNotModified: 0,
      cacheHits: 0,
      accountingComplete: true,
    },
    pullRequests: [pullRequest],
    pullRequestMappings: [{
      status: 'resolved',
      prNumber: 84,
      issueNumber: 42,
      expectedBaseRefName: baseRefName,
      evidence: 'closing-reference',
    }],
    lifecycle: {
      items: [{
        kind: 'pull-request' as const,
        issueNumber: 42,
        prNumber: 84,
        v2Marked: true,
        projectStatus: merged ? 'Done' : 'In Review',
        labels: ['engine:review'],
        head,
        expectedBaseRefName: baseRefName,
        headChangedAt: '2026-07-20T11:00:00.000Z',
        isDraft: false,
        merged,
        needsReview: false,
        approved: true,
        mergeState,
        checks,
        ...(holdAtHead(head) === undefined ? {} : { enqueueHold: holdAtHead(head) }),
        ...(fixture.mergeQueue?.enqueued === true ? { inMergeQueue: true } : {}),
        ...(fixture.openChildKinds === undefined
          ? {}
          : { openChildKinds: fixture.openChildKinds }),
        reviewClaim: {
          kind: 'review-claim',
          protocolVersion: 2,
          prNumber: 84,
          head,
          generation: GENERATION,
          attempt: ATTEMPT,
          reviewer: REVIEWER,
          recordedAt: '2026-07-20T11:30:00.000Z',
          state: 'terminal-approved',
          verdict: { state: 'APPROVE', marker: INTENT },
        },
        terminalVerdict: {
          state: 'APPROVE',
          head,
          marker: INTENT,
          recordedAt: '2026-07-20T11:30:00.000Z',
        },
      }],
    },
  };
}

function oidFor(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

interface HarnessOptions {
  /** Seeds the remote enqueue-attempt ledger for this head. */
  readonly seedRecord?: { readonly attempts: number; readonly linkedIssue?: number };
  /** Answer of the pre-mutation GraphQL authority read. */
  readonly authorityInMergeQueue?: boolean;
  /** Seeds a durable enqueue hold on the remote, as an earlier cycle would. */
  readonly seedHold?: { readonly kind: EnqueueHoldKind; readonly head?: GitOid };
}

function harness(fixture: Fixture = {}, options: HarnessOptions = {}) {
  let current = fixture;
  const head = fixture.head ?? HEAD;
  const baseRefName = fixture.baseRefName ?? DEFAULT_BRANCH;
  const remoteRefs = new Map<string, string>();
  const objects = new Map<string, string>();
  const holdAtHead = (candidate: GitOid): EnqueueHoldKind | undefined => (
    (['flake', 'rejected'] as const).find(
      (kind) => remoteRefs.has(enqueueHoldRef(kind, 84, candidate)),
    )
  );
  if (options.seedHold !== undefined) {
    const message = 'Autopilot enqueue hold';
    const oid = oidFor(message);
    objects.set(oid, message);
    remoteRefs.set(
      enqueueHoldRef(options.seedHold.kind, 84, options.seedHold.head ?? head),
      oid,
    );
  }
  let snapshot = snapshotFor(current, holdAtHead);
  // The head GitHub itself would report. Tracks `advance`, so a fixture that
  // pushes a new commit is answered as a new commit by every read the executor
  // takes — otherwise the enqueue would refuse on a changed head rather than
  // proving the hold released.
  let liveHead = head;
  if (options.seedRecord !== undefined) {
    const message = encodeEnqueueRecord({
      prNumber: 84,
      head,
      attempts: options.seedRecord.attempts,
      enqueuedAt: '2026-07-20T11:45:00.000Z',
      ...(options.seedRecord.linkedIssue === undefined
        ? {}
        : { linkedIssue: options.seedRecord.linkedIssue }),
    });
    const oid = oidFor(message);
    objects.set(oid, message);
    remoteRefs.set(enqueueRef(84, head), oid);
  }
  const enqueueMutations: string[] = [];
  const childIssueCreates: string[][] = [];
  const commands: string[][] = [];

  const runner = async (command: string, args: readonly string[]): Promise<string> => {
    commands.push([command, ...args]);
    const endpoint = args.find((arg) => arg.startsWith('repos/'));
    if (endpoint === `repos/${SLUG}/pulls/84`) {
      return JSON.stringify({
        changed_files: 1,
        head: { sha: liveHead },
        base: { ref: baseRefName, sha: FORK_POINT },
      });
    }
    if (endpoint?.startsWith(`repos/${SLUG}/pulls/84/files?`)) {
      return JSON.stringify([[{ filename: 'README.md' }]]);
    }
    if (endpoint?.startsWith(`repos/${SLUG}/contents/.github/CODEOWNERS`)) {
      return JSON.stringify({ content: Buffer.from('').toString('base64') });
    }
    if (endpoint?.startsWith(`repos/${SLUG}/compare/`)) {
      return JSON.stringify({ status: current.compareStatus ?? 'ahead' });
    }
    // `isInMergeQueue` is GraphQL-only; gh 2.78.0 refuses the whole
    // `gh pr view --json` invocation when it is named.
    if (args[0] === 'pr' && args[1] === 'view') {
      throw new Error(
        `Command failed: gh ${args.join(' ')}\nUnknown JSON field: "isInMergeQueue"`,
      );
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      const query = args.find((arg) => arg.startsWith('query=')) ?? '';
      if (query.includes('isInMergeQueue')) {
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                state: current.state ?? 'OPEN',
                headRefOid: liveHead,
                baseRefName,
                isInMergeQueue: options.authorityInMergeQueue
                  ?? current.mergeQueue?.enqueued
                  ?? false,
              },
            },
          },
        });
      }
      if (query.includes('enqueuePullRequest')) {
        enqueueMutations.push(
          args.find((arg) => arg.startsWith('expectedHeadOid=')) ?? '',
        );
        return JSON.stringify({
          data: {
            enqueuePullRequest: { mergeQueueEntry: { position: 1, state: 'QUEUED' } },
          },
        });
      }
      if (query.includes('issueTypes')) {
        return JSON.stringify({
          data: {
            organization: {
              issueTypes: { nodes: [{ id: 'IT_fix', name: 'fix', isEnabled: true }] },
            },
          },
        });
      }
      return '{"data":{}}';
    }
    if (args[0] === 'issue' && args[1] === 'list') return '[]';
    if (args[0] === 'issue' && args[1] === 'create') {
      childIssueCreates.push([...args]);
      return `https://github.com/${SLUG}/issues/9001\n`;
    }
    if (args[0] === 'issue' && args[1] === 'view') return 'I_kwIssue9001\n';
    if (args[0] === 'issue' && args[1] === 'edit') return '';
    if (args[0] === 'label' && args[1] === 'create') return '';
    if (args[0] === 'project' && args[1] === 'field-list') return FIELD_LIST_JSON;
    if (args[0] === 'project' && args[1] === 'item-add') {
      return JSON.stringify({ id: 'PVTI_child9001' });
    }
    if (args[0] === 'project' && args[1] === 'item-edit') return '';
    if (args[0] === 'project' && args[1] === 'item-list') return JSON.stringify({ items: [] });
    if (args.includes('ls-remote')) {
      const ref = args.at(-1)!;
      const oid = remoteRefs.get(ref);
      return oid === undefined ? '' : `${oid}\t${ref}\n`;
    }
    // The record commit lives on the remote; a clone that did not push it has
    // to fetch the object before it can read it.
    if (args.includes('fetch')) {
      const ref = args.at(-1)!;
      if (!remoteRefs.has(ref)) throw new Error(`couldn't find remote ref ${ref}`);
      return '';
    }
    if (args.includes('cat-file')) {
      const oid = args.at(-1)!;
      const message = objects.get(oid);
      if (message === undefined) throw new Error(`bad object ${oid}`);
      return `tree ${'0'.repeat(40)}\n\n${message}\n`;
    }
    if (args.includes('commit-tree')) {
      const message = args[args.indexOf('-m') + 1]!;
      const oid = oidFor(message);
      objects.set(oid, message);
      return `${oid}\n`;
    }
    if (args.includes('push')) {
      const lease = args.find((arg) => arg.startsWith('--force-with-lease='))!;
      const [ref, expected] = lease.slice('--force-with-lease='.length).split(':');
      const observed = remoteRefs.get(ref!) ?? '';
      if (observed !== (expected ?? '')) throw new Error('stale lease');
      const spec = args.at(-1)!;
      const [published, target] = spec.split(':');
      remoteRefs.set(target!, published!);
      return '';
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  const runtime = makeProductionActiveRuntime({
    executionBackend: 'local',
    repositoryPath: '/repo',
    repositoryUrl: `https://github.com/${SLUG}.git`,
    worktreeBase: '/worktrees',
    runnerId: 'runner-a',
    credentials: new CredentialPool([
      {
        login: 'implementation-bot',
        normalizedLogin: 'implementation-bot',
        implementationToken: 'secret',
      },
      // The approving reviewer's login: the enqueue gate now asserts the
      // terminal-approval reviewer is one of this deployment's own
      // authenticated identities, drawn from this same pool.
      { login: REVIEWER, normalizedLogin: REVIEWER },
    ]),
    authorAllowlist: new Set(['implementation-bot']),
    readReviewSnapshot: async () => snapshot,
    readReservedReviewSnapshot: async () => snapshot,
    readImplementationSnapshot: async () => snapshot,
    reserveReviewCohort: async () => {},
    readPullRequestByNumber: async () => null,
    readProjectItemForReconciliation: async () => null,
    readBranchHeadByName: async () => liveHead,
    readBranchClaimByName: async () => null,
    readIssueByNumber: async () => null,
    readBlockedByIssueNumbers: async () => [],
    readOpenPullRequestsByIssue: async () => [],
    readIssueActionContext: async () => ({ projectItem: null, openPullRequests: [] }),
    config: DEFAULT_CONFIG,
    spawn: () => {
      throw new Error('the enqueue stage must not spawn a session');
    },
    caps: { implementation: 0, review: 0 },
    implementationBackpressureThreshold: 30,
    staleAfterMs: 2 * 60 * 60_000,
    repositorySlug: SLUG,
    defaultBranch: DEFAULT_BRANCH,
    now: () => NOW,
    runner,
  });

  const executed: { action: unknown; result: unknown }[] = [];
  const instrumented = {
    ...runtime,
    // Deliberate bypass, and the only one in this suite. The capability
    // attestation is a separate concern with its own suite; this one is about
    // what the enqueue stage does once the runtime is armed, and every layer
    // below it — derivation, scheduling, the gate, the executor, the attempt
    // ledger — is the real production code.
    preflight: async () => ({ ok: true }),
    executeAction: async (action: unknown, cycleSnapshot: unknown) => {
      const result = await runtime.executeAction(action as never, cycleSnapshot as never);
      executed.push({ action, result });
      return result;
    },
  };

  const writes: string[] = [];
  const writer = new Proxy({} as ReconciliationWriter, {
    get(_target, property) {
      return async (...args: unknown[]) => {
        writes.push(`${String(property)}:${JSON.stringify(args)}`);
        return null;
      };
    },
  });

  return {
    get snapshot() { return snapshot; },
    /** Advance to the next cycle's snapshot, as a fresh read would produce it. */
    advance(next: Fixture = {}) {
      current = { ...current, ...next };
      liveHead = current.head ?? HEAD;
      snapshot = snapshotFor(current, holdAtHead);
    },
    remoteRefs,
    objects,
    enqueueMutations,
    childIssueCreates,
    commands,
    executed,
    writes,
    run: () => runLifecycleCycle('active', {
      readSnapshot: async () => snapshot,
      writer,
      now: () => NOW,
      staleAfterMs: 2 * 60 * 60_000,
      runnerId: 'runner-a',
      cycleId: () => 'cycle-1',
      mergePolicy: 'safe-auto',
      active: instrumented,
    }),
  };
}

function recordAt(harnessValue: ReturnType<typeof harness>, head = HEAD) {
  const oid = harnessValue.remoteRefs.get(enqueueRef(84, head));
  return oid === undefined ? null : harnessValue.objects.get(oid) ?? null;
}

describe('enqueue queue cycle', () => {
  it('enqueues the exact head and never claims the change merged', async () => {
    const enqueue = harness();
    const report = await enqueue.run();

    expect(report.items[0]).toMatchObject({ phase: 'merge-ready' });
    expect(enqueue.executed).toHaveLength(1);
    expect(enqueue.executed[0]!.action).toMatchObject({ kind: 'enqueue', prNumber: 84 });
    expect(enqueue.executed[0]!.result).toEqual({ outcome: 'enqueued' });
    expect(enqueue.enqueueMutations).toEqual([`expectedHeadOid=${HEAD}`]);
    // No status in the enqueue stage's vocabulary asserts a merge, and the
    // board projection for this phase is In Review, not Done.
    expect(phaseStatus(report.items[0]!.phase)).toBe('In Review');
    expect(enqueue.writes.join('|')).not.toContain('Done');
  });

  /**
   * The whole point of the stage, in the order it actually happens. Nothing in
   * the enqueue cycle asserts a merge; the merge is GitHub's, and Done arrives
   * one cycle later off the MERGED snapshot through the projection that already
   * existed.
   */
  it('goes enqueued, then queued, then Done across successive cycles', async () => {
    const lifecycleRun = harness();

    const enqueued = await lifecycleRun.run();
    expect(enqueued.items[0]).toMatchObject({ phase: 'merge-ready' });
    expect(lifecycleRun.executed[0]!.result).toEqual({ outcome: 'enqueued' });
    expect(phaseStatus(enqueued.items[0]!.phase)).not.toBe('Done');
    expect(lifecycleRun.writes.join('|')).not.toContain('Done');

    // GitHub took it. The engine reads membership and does nothing.
    lifecycleRun.advance({ mergeQueue: { enqueued: true, position: 1, state: 'QUEUED' } });
    const waiting = await lifecycleRun.run();
    expect(waiting.items[0]).toMatchObject({ phase: 'merge-ready' });
    expect(lifecycleRun.enqueueMutations).toHaveLength(1);

    // The queue merged it. Done comes from the merged fact, not from anything
    // this stage wrote.
    lifecycleRun.advance({ state: 'MERGED', mergeQueue: { enqueued: false } });
    const landed = await lifecycleRun.run();
    expect(landed.items[0]).toMatchObject({ phase: 'merged' });
    expect(phaseStatus(landed.items[0]!.phase)).toBe('Done');
    expect(lifecycleRun.enqueueMutations).toHaveLength(1);
  });

  it('reaches Done from a later cycle reading a MERGED snapshot', async () => {
    const landed = harness({
      state: 'MERGED',
      mergeQueue: { enqueued: false },
    });
    const report = await landed.run();

    expect(report.items[0]).toMatchObject({ phase: 'merged' });
    expect(phaseStatus(report.items[0]!.phase)).toBe('Done');
    // The merge belongs to GitHub. Nothing was enqueued, nothing was mutated.
    expect(landed.executed).toEqual([]);
    expect(landed.enqueueMutations).toEqual([]);
  });

  it('does not enqueue a pull request that is already in the queue', async () => {
    const queued = harness({
      mergeQueue: { enqueued: true, position: 3, state: 'QUEUED' },
    });
    const report = await queued.run();

    expect(report.items[0]).toMatchObject({ phase: 'merge-ready' });
    expect(queued.executed).toEqual([]);
    expect(queued.enqueueMutations).toEqual([]);
  });

  /**
   * An ejection is not an event the engine receives; it is a shape it reads. A
   * record exists for this head — so the queue took it once — the PR is still
   * open, and it is no longer in the queue. That is exactly one re-enqueue.
   */
  it('re-enqueues exactly once after an observed ejection', async () => {
    const ejected = harness({ mergeQueue: { enqueued: false } }, {
      seedRecord: { attempts: 1 },
    });
    const report = await ejected.run();

    expect(report.items[0]).toMatchObject({ phase: 'merge-ready' });
    expect(ejected.enqueueMutations).toEqual([`expectedHeadOid=${HEAD}`]);
    expect(ejected.executed[0]!.result).toEqual({ outcome: 'enqueued' });
    expect(recordAt(ejected)).toContain('attempts=2');
  });

  /**
   * The second failure at one head is a signal, not a flake. The engine stops
   * feeding the queue, files the `ci-failure` child that says why, and writes
   * the child's number into the record so a later cycle can tell "held and
   * explained" from "held and silent".
   */
  it('holds after a second ejection, files a ci-failure child, and links it', async () => {
    const held = harness({ mergeQueue: { enqueued: false } }, {
      seedRecord: { attempts: 2 },
    });
    await held.run();

    expect(held.enqueueMutations).toEqual([]);
    expect(held.executed[0]!.result).toMatchObject({ outcome: 'flake-hold' });
    expect(held.childIssueCreates).toHaveLength(1);
    expect(held.childIssueCreates[0]!.join(' ')).toContain('Merge queue rejected PR #84 twice');
    expect(recordAt(held)).toContain('linked-issue=9001');
  });

  it('releases the hold once the record carries the explaining issue', async () => {
    const explained = harness({ mergeQueue: { enqueued: false } }, {
      seedRecord: { attempts: 2, linkedIssue: 9001 },
    });
    await explained.run();

    expect(explained.enqueueMutations).toEqual([`expectedHeadOid=${HEAD}`]);
    expect(explained.childIssueCreates).toEqual([]);
  });

  /**
   * The hold re-arms. A human closed the `ci-failure` child, the sanctioned
   * retry went to the queue and was ejected again, so the record now reads
   * three attempts at this head. Releasing on the linked issue a second time
   * would re-enqueue on every cycle forever; the third attempt is terminal for
   * this head, and pushing a fix is what resets it.
   */
  it('holds again when the issue-sanctioned retry also ejects', async () => {
    const exhausted = harness({ mergeQueue: { enqueued: false } }, {
      seedRecord: { attempts: 3, linkedIssue: 9001 },
    });
    await exhausted.run();

    expect(exhausted.enqueueMutations).toEqual([]);
    expect(exhausted.executed[0]!.result).toMatchObject({ outcome: 'flake-hold' });
    // The issue that explains this head already exists; a second one would be
    // noise, and an unbounded supply of it.
    expect(exhausted.childIssueCreates).toEqual([]);
    expect(recordAt(exhausted)).toContain('attempts=3');
  });

  /**
   * The cost the hold exists to remove. Today a terminal hold is re-derived
   * every cycle: two full `readCandidate` passes (each a targeted GraphQL read
   * plus `pulls/84`, `pulls/84/files`, the CODEOWNERS blob and a compare), a
   * third snapshot read, and the attempt-ledger read LAST — after everything
   * else has already been spent. A stamped hold makes the whole of that zero.
   */
  it('pays nothing for a head on a terminal flake hold', async () => {
    const held = harness({ mergeQueue: { enqueued: false } }, {
      seedHold: { kind: 'flake' },
    });

    const report = await held.run();

    expect(report.items[0]).toMatchObject({ phase: 'merge-ready', enqueueHold: 'flake' });
    expect(held.executed).toEqual([]);
    expect(held.enqueueMutations).toEqual([]);
    expect(held.commands.filter((call) => call.join(' ').includes('pulls/84'))).toEqual([]);
    expect(held.commands.filter((call) => call.join(' ').includes('CODEOWNERS'))).toEqual([]);
    expect(held.commands.filter((call) => call.join(' ').includes('compare/'))).toEqual([]);
  });

  it('pays nothing for a head on a durable rejected hold either', async () => {
    const held = harness({ mergeQueue: { enqueued: false } }, {
      seedHold: { kind: 'rejected' },
    });

    await held.run();

    expect(held.executed).toEqual([]);
    expect(held.commands.filter((call) => call.join(' ').includes('pulls/84'))).toEqual([]);
  });

  /**
   * The invariant, end to end: the hold ref is never stickier than the decision
   * it caches. The hold names a head, so a push mints a head the hold does not
   * name and the enqueue runs again — no expiry, no sweeper, no release path to
   * get wrong.
   */
  it('releases the hold when a new head is pushed', async () => {
    const released = harness({ mergeQueue: { enqueued: false } }, {
      seedHold: { kind: 'flake' },
    });

    await released.run();
    expect(released.enqueueMutations).toEqual([]);

    released.advance({ head: NEW_HEAD });
    const report = await released.run();

    expect(report.items[0]).toMatchObject({ phase: 'merge-ready' });
    expect(report.items[0]).not.toHaveProperty('enqueueHold');
    expect(released.enqueueMutations).toEqual([`expectedHeadOid=${NEW_HEAD}`]);
  });

  /**
   * The write and the read, in one run. The sanctioned retry ejects, the hold
   * becomes terminal, and the ref this cycle publishes is what the NEXT cycle's
   * snapshot reads to skip the candidate entirely.
   */
  it('writes the hold when the sanctioned retry also ejects, and pays nothing next cycle', async () => {
    const exhausted = harness({ mergeQueue: { enqueued: false } }, {
      seedRecord: { attempts: 3, linkedIssue: 9001 },
    });

    await exhausted.run();
    expect(exhausted.executed[0]!.result).toMatchObject({ outcome: 'flake-hold' });
    expect(exhausted.remoteRefs.has(enqueueHoldRef('flake', 84, HEAD))).toBe(true);

    const before = exhausted.commands.length;
    exhausted.advance();
    await exhausted.run();

    expect(exhausted.executed).toHaveLength(1);
    expect(exhausted.commands.slice(before)).toEqual([]);
  });

  it('derives blocked-by-child while the ci-failure child is open', async () => {
    const blocked = harness({
      mergeQueue: { enqueued: false },
      openChildKinds: ['ci-failure'],
    });
    const report = await blocked.run();

    expect(report.items[0]).toMatchObject({ phase: 'blocked-by-child' });
    expect(blocked.executed).toEqual([]);
    expect(blocked.enqueueMutations).toEqual([]);
  });

  /**
   * mono requires ten contexts. Six report on the pull request; four run only
   * against the merge-group commit the queue builds, so they are absent from
   * PR-level checks by design. A gate that waited for all ten before enqueueing
   * would wait forever, and the four it waited for can only ever run *after*
   * the enqueue it was blocking.
   */
  it('enqueues on the fast lane while merge-group-only contexts are absent', async () => {
    const fastLane = harness({ checks: green(FAST_LANE_CONTEXTS) });
    await fastLane.run();

    for (const context of MERGE_GROUP_ONLY_CONTEXTS) {
      expect(fastLane.snapshot.pullRequests[0]!.checks.map((check) => check.name))
        .not.toContain(context);
    }
    expect(fastLane.enqueueMutations).toEqual([`expectedHeadOid=${HEAD}`]);
  });

  it('enqueues when every required context reports green on the pull request', async () => {
    const fullLane = harness({ checks: green(REQUIRED_CONTEXTS) });
    await fullLane.run();

    expect(fullLane.enqueueMutations).toEqual([`expectedHeadOid=${HEAD}`]);
  });

  // Zero reported checks is not "nothing required"; it is "nothing read yet".
  it('waits rather than enqueueing when no check has reported at all', async () => {
    const unreported = harness({ checks: [] });
    const report = await unreported.run();

    expect(report.items[0]).toMatchObject({ phase: 'ci-blocked' });
    expect(unreported.enqueueMutations).toEqual([]);
  });

  it('waits while a required context is still pending', async () => {
    const pending = harness({
      checks: [
        ...green(FAST_LANE_CONTEXTS.slice(1)),
        {
          source: 'check-run',
          name: FAST_LANE_CONTEXTS[0],
          status: 'IN_PROGRESS',
          conclusion: null,
        },
      ],
    });
    const report = await pending.run();

    expect(report.items[0]).toMatchObject({ phase: 'ci-blocked' });
    expect(pending.enqueueMutations).toEqual([]);
  });

  /**
   * Issue #82, end to end. GitHub reports BLOCKED for a pull request waiting on
   * a required context — which includes every merge-group-only context, by
   * construction — and for one already admitted to the queue. The fixture says
   * MERGEABLE/BLOCKED and nothing else; the merge state that reaches the
   * scheduler is derived from it by production code, so this asserts the real
   * derivation, not a restatement of it.
   */
  it('enqueues a BLOCKED head that is approved and green', async () => {
    const blocked = harness({ mergeStateStatus: 'BLOCKED' });
    const report = await blocked.run();

    expect(report.items[0]).toMatchObject({ phase: 'merge-ready' });
    expect(blocked.executed[0]!.action).toMatchObject({ kind: 'enqueue', prNumber: 84 });
    expect(blocked.enqueueMutations).toEqual([`expectedHeadOid=${HEAD}`]);
  });

  /**
   * The one shape BLOCKED must not launder. The queue rebases its own
   * candidate, so behind is fine and blocked-on-a-context is fine; a head that
   * conflicts is a head it cannot build a candidate from at all, and the
   * reconcile child still owns the next mutation.
   */
  it('files a reconcile child for a BLOCKED head that conflicts', async () => {
    const conflicting = harness({
      mergeStateStatus: 'BLOCKED',
      mergeability: 'CONFLICTING',
      compareStatus: 'diverged',
    });
    await conflicting.run();

    expect(conflicting.enqueueMutations).toEqual([]);
    expect(conflicting.executed[0]!.action).toMatchObject({
      kind: 'file-reconcile-child',
      prNumber: 84,
    });
  });

  /**
   * Stacked-PR pin. A merge queue belongs to one protected branch, so a pull
   * request whose base is another Autopilot work branch has no queue to be
   * admitted to. Its parent/child sequencing stays custom until the stack
   * collapses onto a root pull request.
   */
  it('never enqueues a pull request based on another autopilot work branch', async () => {
    const stacked = harness({ baseRefName: 'autopilot/41' });
    await stacked.run();

    expect(stacked.enqueueMutations).toEqual([]);
    expect(stacked.executed[0]!.result).toMatchObject({
      outcome: 'ineligible',
      reason: expect.stringContaining('stacked-base'),
    });
    // Refused before the mutation, so no attempt was burned against a head that
    // did nothing wrong.
    expect(recordAt(stacked)).toBeNull();
  });

  // Nothing in one cycle may enqueue the same head twice: not the derivation,
  // not the scheduler, not a retry inside the executor.
  it('never enqueues the same pull request twice in one cycle', async () => {
    const single = harness({ mergeQueue: { enqueued: false } }, {
      seedRecord: { attempts: 1 },
    });
    await single.run();

    expect(single.enqueueMutations).toHaveLength(1);
    expect(single.executed.filter(
      (entry) => (entry.action as { kind: string }).kind === 'enqueue',
    )).toHaveLength(1);
    expect(recordAt(single)).toContain('attempts=2');
  });
});
