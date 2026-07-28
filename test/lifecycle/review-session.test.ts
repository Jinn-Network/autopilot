// @ts-nocheck — Stage 5: deleted merge-prep/review-fix/project-status fixtures.
import { describe, expect, it } from 'vitest';
import type { AttemptManifest } from '../../src/lifecycle/attempt-workspace.js';
import { formatAutomatedReviewMarker } from '../../src/lifecycle/codecs.js';
import {
  makeReviewSessionProtocol,
  type ReviewSessionAuthority,
  type ReviewSessionPort,
} from '../../src/lifecycle/review-session.js';
import {
  gitOid,
  type GitOid,
  type ReviewClaimRecord,
  type ReviewVerdictState,
} from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));
const FIX_ONE = gitOid('2'.repeat(40));
const FIX_TWO = gitOid('3'.repeat(40));
const ACTIVE = gitOid('4'.repeat(40));
const INTENT = gitOid('5'.repeat(40));
const FIXING = gitOid('6'.repeat(40));
const NEXT_ACTIVE = gitOid('7'.repeat(40));
const TERMINAL = gitOid('8'.repeat(40));
const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const GENERATION = '22222222-2222-4222-8222-222222222222';
const PRIOR_ATTEMPT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRIOR_GENERATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MARKER = '33333333-3333-4333-8333-333333333333';

function record(
  state: ReviewClaimRecord['state'] = 'active',
  overrides: Partial<ReviewClaimRecord> = {},
): ReviewClaimRecord {
  const common = {
    kind: 'review-claim' as const,
    protocolVersion: 2 as const,
    prNumber: 84,
    generation: GENERATION,
    attempt: ATTEMPT,
    reviewer: 'review-bot',
    head: HEAD,
    recordedAt: '2026-07-20T12:00:00.000Z',
  };
  if (state === 'verdict-intent') {
    return {
      ...common,
      state,
      verdict: { state: 'REQUEST_CHANGES', marker: MARKER },
      ...overrides,
    } as ReviewClaimRecord;
  }
  if (state === 'terminal-approved') {
    return {
      ...common,
      state,
      verdict: { state: 'APPROVE', marker: MARKER },
      ...overrides,
    } as ReviewClaimRecord;
  }
  return { ...common, state, ...overrides } as ReviewClaimRecord;
}

function manifest(
  expectedHead: GitOid = HEAD,
  reviewRefOid: GitOid = ACTIVE,
  approvalPolicy: 'approve-eligible' | 'human-codeowner' = 'approve-eligible',
): AttemptManifest {
  return {
    version: 2,
    attemptId: ATTEMPT,
    runnerId: 'runner-a',
    host: 'host-a',
    phase: 'review',
    subject: 'pr-84',
    issueNumber: 42,
    prNumber: 84,
    branch: 'autopilot/42',
    targetBase: 'next',
    expectedHead,
    claimOid: ACTIVE,
    reviewGeneration: GENERATION,
    reviewRefOid,
    reviewApprovalPolicy: approvalPolicy,
    selectedLogin: 'review-bot',
    repository: {
      root: '/repo',
      gitCommonDir: '/repo/.git',
      remoteName: 'jinn-autopilot-v2',
      remoteUrlHash: 'a'.repeat(64),
    },
    processState: 'running',
    pid: 42,
    paths: {
      attemptDir: '/attempt',
      worktree: '/attempt/worktree',
      manifest: '/attempt/manifest.json',
      log: '/attempt/session.log',
      ghConfigDir: '/attempt/gh',
      askpass: '/attempt/askpass',
      tokenFile: '/attempt/gh-token',
    },
    timestamps: {
      createdAt: '2026-07-20T12:00:00.000Z',
      updatedAt: '2026-07-20T12:00:00.000Z',
      childStartedAt: '2026-07-20T12:00:00.000Z',
    },
  } as AttemptManifest;
}

function nativeBody(state: ReviewVerdictState, head: GitOid = HEAD): string {
  return formatAutomatedReviewMarker({
    generation: GENERATION,
    attempt: ATTEMPT,
    intent: MARKER,
    reviewer: 'review-bot',
    head,
    verdict: state,
  });
}

function harness(options: {
  state?: ReviewClaimRecord['state'];
  verdictState?: ReviewVerdictState;
  draft?: boolean;
  policy?: 'approve-eligible' | 'human-codeowner';
  localHead?: GitOid;
  clean?: boolean;
  treeChanged?: boolean;
  nativeExists?: boolean;
  humanChecks?: boolean[];
} = {}) {
  let currentManifest = manifest(HEAD, ACTIVE, options.policy);
  let authority: ReviewSessionAuthority = {
    reviewRefOid: ACTIVE,
    record: options.state === 'verdict-intent'
      ? record('verdict-intent', {
          verdict: {
            state: options.verdictState ?? 'REQUEST_CHANGES',
            marker: MARKER,
          },
        })
      : record(options.state),
  };
  if (options.state !== undefined && options.state !== 'active') {
    currentManifest = manifest(HEAD, ACTIVE, options.policy);
  }
  let draft = options.draft ?? false;
  let labels = new Set(['engine:review']);
  let project: 'In Review' | 'Human' = 'In Review';
  let localHead = options.localHead ?? FIX_ONE;
  let native = options.nativeExists
    ? [{
        reviewer: 'review-bot',
        state: (options.verdictState ?? 'REQUEST_CHANGES') === 'APPROVE'
          ? 'APPROVED' as const
          : 'CHANGES_REQUESTED' as const,
        commitId: HEAD,
        body: nativeBody(options.verdictState ?? 'REQUEST_CHANGES'),
        submittedAt: '2026-07-20T12:01:00.000Z',
      }]
    : [];
  const events: string[] = [];
  const humanChecks = [...(options.humanChecks ?? [])];
  const comments = new Set<string>();

  const port: ReviewSessionPort = {
    readManifest: () => currentManifest,
    readAuthority: async () => authority,
    readPullRequest: async () => ({
      number: 84,
      issueNumber: 42,
      open: true,
      head: currentManifest.expectedHead as GitOid,
      headRefName: 'autopilot/42',
      baseRefName: 'next',
      draft,
      author: 'implementation-bot',
      labels: [...labels],
      body: 'Closes #42\n\n<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
      approvalPolicy: options.policy ?? 'approve-eligible',
    }),
    readNativeReviews: async () => native,
    hasHumanHold: async () => (
      humanChecks.shift()
      ?? (labels.has('review:needs-human') || project === 'Human')
    ),
    createReviewRecord: async ({ record: next }) => {
      events.push(`record:${next.state}`);
      if (next.state === 'verdict-intent') return INTENT;
      if (next.state === 'fixing') return FIXING;
      if (next.state === 'terminal-approved') return TERMINAL;
      return NEXT_ACTIVE;
    },
    publishReviewClaim: async ({ recordOid, expectedRemoteRecordOid, record: next }) => {
      events.push(`claim:${next.state}`);
      if (authority.reviewRefOid !== expectedRemoteRecordOid) {
        return {
          status: 'lost',
          expected: expectedRemoteRecordOid,
          published: recordOid,
          observed: authority.reviewRefOid,
        };
      }
      authority = { reviewRefOid: recordOid, record: next };
      currentManifest = { ...currentManifest, reviewRefOid: recordOid };
      return {
        status: 'won',
        expected: expectedRemoteRecordOid,
        published: recordOid,
        observed: recordOid,
      };
    },
    submitNativeReview: async ({ state, commitId, body }) => {
      events.push(`native:${state}:${commitId}`);
      native = [...native, {
        reviewer: 'review-bot',
        state: state === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED',
        commitId,
        body,
        submittedAt: '2026-07-20T12:01:00.000Z',
      }];
    },
    setPullRequestLabel: async (_pr, _head, label, present) => {
      events.push(`label:${label}:${present}`);
      if (present) labels.add(label);
      else labels.delete(label);
    },
    setProjectStatus: async (_issue, _head, status) => {
      events.push(`project:${status}`);
      project = status;
    },
    setPullRequestDraft: async (_pr, _head, next) => {
      events.push(`draft:${next}`);
      draft = next;
    },
    fileFindingChild: async ({ title, body }) => {
      events.push(`child:${title}`);
      expect(body.length).toBeGreaterThan(0);
      return { number: 9001, created: true };
    },
    hasHumanComment: async (
      _pr,
      _head,
      _ref,
      _generation,
      _state,
      body,
    ) => comments.has(body),
    ensureHumanComment: async (
      _pr,
      _head,
      _ref,
      _generation,
      _state,
      _marker,
      body,
    ) => {
      events.push('human-comment');
      comments.add(body);
    },
    nextMarker: () => MARKER,
    now: () => new Date('2026-07-20T12:01:00.000Z'),
  };
  return {
    port,
    protocol: makeReviewSessionProtocol(port),
    events,
    get manifest() { return currentManifest; },
    get authority() { return authority; },
    set authority(next: ReviewSessionAuthority) { authority = next; },
    get draft() { return draft; },
    get labels() { return labels; },
    get comments() { return comments; },
    get project() { return project; },
    get native() { return native; },
    set localHead(next: GitOid) { localHead = next; },
  };
}

describe('review session protocol', () => {

  it('does not complete an exact intent from a copied marker with the wrong login', async () => {
    const h = harness({
      state: 'verdict-intent',
      verdictState: 'REQUEST_CHANGES',
    });
    h.native.push({
      reviewer: 'marker-copying-bot',
      state: 'CHANGES_REQUESTED',
      commitId: HEAD,
      body: nativeBody('REQUEST_CHANGES'),
      submittedAt: '2026-07-20T12:01:00.000Z',
    });

    await h.protocol.reviewVerdict(h.manifest, 'REQUEST_CHANGES', 'Retry body');

    expect(h.events.filter((event) => event.startsWith('native:'))).toEqual([
      `native:REQUEST_CHANGES:${HEAD}`,
    ]);
  });

  it('approves the exact final head, appends terminal, reconciles, and makes ready last', async () => {
    const h = harness({ draft: true });

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .resolves.toMatchObject({ status: 'approved', head: HEAD });

    expect(h.events.at(-1)).toBe('draft:false');
    expect(h.events.indexOf('claim:terminal-approved'))
      .toBeLessThan(h.events.indexOf('draft:false'));
    expect(h.events).toContain(`native:APPROVE:${HEAD}`);
  });

  it('files a review-findings child, publishes REQUEST_CHANGES, and releases the claim', async () => {
    const h = harness();

    await expect(
      h.protocol.reviewFindings!(h.manifest, '## Findings\n\n- Fix the race.'),
    ).resolves.toEqual({
      status: 'filed',
      head: HEAD,
      childNumber: 9001,
      created: true,
    });

    expect(h.events).toContain('child:Address review findings for PR #84');
    expect(h.events).toContain(`native:REQUEST_CHANGES:${HEAD}`);
    expect(h.events).toContain('claim:stale');
    expect(h.labels.has('review:changes-requested')).toBe(true);
    expect(h.events).not.toContain('draft:true');
  });

  it.skip('never approves a human-codeowner surface and preserves a draft Human hold', async () => {
    const h = harness({ policy: 'human-codeowner', draft: true });

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Engine clean.'))
      .resolves.toMatchObject({ status: 'human' });

    expect(h.events.some((event) => event.startsWith('native:'))).toBe(false);
    expect(h.events).toContain('human-comment');
    expect(h.events).toContain('human-comment');
    expect(h.draft).toBe(true);
  });

  it('keeps any native requested-changes verdict as an approval blocker', async () => {
    const h = harness({ draft: true });
    h.native.push({
      reviewer: 'late-stale-reviewer',
      state: 'CHANGES_REQUESTED',
      commitId: HEAD,
      body: '<!-- stale generation -->',
      submittedAt: '2026-07-20T12:00:30.000Z',
    });

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .rejects.toThrow(/requested changes.*block/i);
    expect(h.events).not.toContain(`native:APPROVE:${HEAD}`);
    expect(h.draft).toBe(true);
  });

  it('keeps an effective requested-changes review on an older head as a blocker', async () => {
    const h = harness({ draft: true });
    h.native.push({
      reviewer: 'stale-head-reviewer',
      state: 'CHANGES_REQUESTED',
      commitId: FIX_ONE,
      body: 'Still unresolved.',
      submittedAt: '2026-07-20T12:00:30.000Z',
    });

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .rejects.toThrow(/requested changes.*block/i);
    expect(h.events).not.toContain(`native:APPROVE:${HEAD}`);
  });

  it('exempts an owned marker-valid REQUEST_CHANGES on a superseded head across attempts', async () => {
    const h = harness({ draft: true });
    h.native.push({
      reviewer: 'review-bot',
      state: 'CHANGES_REQUESTED',
      commitId: FIX_ONE,
      body: formatAutomatedReviewMarker({
        generation: PRIOR_GENERATION,
        attempt: PRIOR_ATTEMPT,
        intent: MARKER,
        reviewer: 'review-bot',
        head: FIX_ONE,
        verdict: 'REQUEST_CHANGES',
      }),
      submittedAt: '2026-07-20T12:00:10.000Z',
    });

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .resolves.toMatchObject({ status: 'approved' });
    expect(h.events).toContain(`native:APPROVE:${HEAD}`);
  });

  it.each([
    {
      name: 'a foreign reviewer with a valid marker',
      review: {
        reviewer: 'oaksprout',
        commitId: FIX_ONE,
        body: formatAutomatedReviewMarker({
          generation: PRIOR_GENERATION,
          attempt: PRIOR_ATTEMPT,
          intent: MARKER,
          reviewer: 'oaksprout',
          head: FIX_ONE,
          verdict: 'REQUEST_CHANGES',
        }),
      },
    },
    {
      name: 'the selected reviewer on the current head with a valid marker',
      review: {
        reviewer: 'review-bot',
        commitId: HEAD,
        body: nativeBody('REQUEST_CHANGES'),
      },
    },
    {
      name: 'a malformed marker',
      review: {
        reviewer: 'review-bot',
        commitId: FIX_ONE,
        body: '<!-- jinn-autopilot-review:v2 malformed -->',
      },
    },
    {
      name: 'a copied marker with a mismatched reviewer',
      review: {
        reviewer: 'review-bot',
        commitId: FIX_ONE,
        body: formatAutomatedReviewMarker({
          generation: PRIOR_GENERATION,
          attempt: PRIOR_ATTEMPT,
          intent: MARKER,
          reviewer: 'oaksprout',
          head: FIX_ONE,
          verdict: 'REQUEST_CHANGES',
        }),
      },
    },
    {
      name: 'a copied marker with a mismatched head',
      review: {
        reviewer: 'review-bot',
        commitId: FIX_ONE,
        body: formatAutomatedReviewMarker({
          generation: PRIOR_GENERATION,
          attempt: PRIOR_ATTEMPT,
          intent: MARKER,
          reviewer: 'review-bot',
          head: FIX_TWO,
          verdict: 'REQUEST_CHANGES',
        }),
      },
    },
  ])('keeps $name as an approval blocker', async ({ review }) => {
    const h = harness({ draft: true });
    h.native.push({
      ...review,
      state: 'CHANGES_REQUESTED',
      submittedAt: '2026-07-20T12:00:10.000Z',
    });

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .rejects.toThrow(/requested changes.*block/i);
    expect(h.events).not.toContain(`native:APPROVE:${HEAD}`);
  });

  it('does not exempt a current requested-changes blocker by matching marker substrings', async () => {
    const h = harness({ draft: true });
    h.native.push({
      reviewer: 'review-bot',
      state: 'CHANGES_REQUESTED',
      commitId: HEAD,
      body: `generation=${GENERATION} attempt=${ATTEMPT}`,
      submittedAt: '2026-07-20T12:00:30.000Z',
    });

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .rejects.toThrow(/requested changes.*block/i);
    expect(h.events).not.toContain(`native:APPROVE:${HEAD}`);
  });

  it('uses each reviewer login latest decisive current-head review as the effective blocker', async () => {
    const h = harness({ draft: true });
    h.native.push(
      {
        reviewer: 'human-reviewer',
        state: 'CHANGES_REQUESTED',
        commitId: HEAD,
        body: 'Old blocker.',
        submittedAt: '2026-07-20T12:00:10.000Z',
      },
      {
        reviewer: 'human-reviewer',
        state: 'APPROVED',
        commitId: HEAD,
        body: 'Resolved.',
        submittedAt: '2026-07-20T12:00:20.000Z',
      },
    );

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .resolves.toMatchObject({ status: 'approved' });
  });

  it('rechecks native blockers after approval readback before terminal publication', async () => {
    const h = harness({ draft: true });
    const read = h.port.readNativeReviews;
    let reads = 0;
    h.port.readNativeReviews = async (...args) => {
      reads += 1;
      const reviews = [...await read(...args)];
      if (reads >= 4) {
        reviews.push({
          reviewer: 'late-human-reviewer',
          state: 'CHANGES_REQUESTED',
          commitId: HEAD,
          body: 'Arrived after approval.',
          submittedAt: '2026-07-20T12:01:30.000Z',
        });
      }
      return reviews;
    };

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .rejects.toThrow(/requested changes.*block/i);
    expect(h.events).not.toContain('claim:terminal-approved');
  });

  it('rechecks native blockers immediately before ready', async () => {
    const h = harness({
      state: 'terminal-approved',
      verdictState: 'APPROVE',
      nativeExists: true,
      draft: true,
    });
    const read = h.port.readNativeReviews;
    let reads = 0;
    h.port.readNativeReviews = async (...args) => {
      reads += 1;
      const reviews = [...await read(...args)];
      if (reads >= 4) {
        reviews.push({
          reviewer: 'late-human-reviewer',
          state: 'CHANGES_REQUESTED',
          commitId: HEAD,
          body: 'Arrived before ready.',
          submittedAt: '2026-07-20T12:02:00.000Z',
        });
      }
      return reviews;
    };

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .rejects.toThrow(/requested changes.*block/i);
    expect(h.events).not.toContain('draft:false');
  });

  it('stops when Human arrives immediately before an inverse mutation or ready', async () => {
    const beforeLabelRemoval = harness({
      draft: true,
      humanChecks: [false, true],
    });
    beforeLabelRemoval.labels.add('review:changes-requested');
    await expect(
      beforeLabelRemoval.protocol.reviewVerdict(
        beforeLabelRemoval.manifest,
        'APPROVE',
        'Clean.',
      ),
    ).resolves.toMatchObject({ status: 'human' });
    expect(beforeLabelRemoval.events).not.toContain('label:review:changes-requested:false');
    expect(beforeLabelRemoval.events).not.toContain('draft:false');

    const beforeReady = harness({
      draft: true,
      humanChecks: [false, false, true],
    });
    await expect(
      beforeReady.protocol.reviewVerdict(beforeReady.manifest, 'APPROVE', 'Clean.'),
    ).resolves.toMatchObject({ status: 'human' });
    expect(beforeReady.events).not.toContain('draft:false');
  });

  it('rejects stale manifests, changed PR authority, wrong reviewer, and late stale approval', async () => {
    const h = harness();
    h.authority = {
      reviewRefOid: ACTIVE,
      record: record('active', { reviewer: 'someone-else' }),
    };
    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'No.'))
      .rejects.toThrow(/owns|authority|reviewer/i);
    expect(h.events).toEqual([]);
  });

  it('parks review attempts on the external Human label before writing internal audit evidence', async () => {
    const h = harness({ state: 'active', draft: true });
    await expect(h.protocol.human(h.manifest, 'Needs architectural judgment.'))
      .resolves.toMatchObject({ status: 'human', head: HEAD });
    expect(h.events.slice(0, 3)).toEqual([
      'label:review:needs-human:true',
      'record:human',
      'claim:human',
    ]);
    expect(h.events).toContain('human-comment');
    expect(h.events.some((event) => event.startsWith('draft:'))).toBe(false);
    expect(h.labels.has('review:needs-human')).toBe(true);
    expect([...h.comments]).toEqual([
      expect.stringContaining(
        `head=${HEAD} generation=22222222-2222-4222-8222-222222222222`,
      ),
    ]);
  });

  it('retains external Human authority when the internal audit record loses its CAS', async () => {
    const h = harness({ state: 'active', draft: false });
    h.port.publishReviewClaim = async ({ recordOid, expectedRemoteRecordOid }) => ({
      status: 'lost',
      expected: expectedRemoteRecordOid,
      published: recordOid,
      observed: TERMINAL,
    });

    await expect(h.protocol.human(h.manifest, 'Needs judgment.'))
      .rejects.toThrow(/Human.*record|authority/i);
    expect(h.events).toEqual([
      'label:review:needs-human:true',
      'record:human',
    ]);
    expect(h.labels.has('review:needs-human')).toBe(true);
  });

  it('delegates a lost mapping to the coordinator without publishing Human state', async () => {
    const h = harness({ state: 'active', draft: true });
    const read = h.port.readPullRequest;
    h.port.readPullRequest = async (...args) => ({
      ...await read(...args),
      mappingProblem: 'PR now maps to both issue #42 and issue #43.',
    });

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .resolves.toMatchObject({ status: 'mapping-pending', head: HEAD });

    expect(h.events).toEqual(['record:mapping-reread', 'claim:mapping-reread']);
    expect(h.authority.record).toMatchObject({
      state: 'mapping-reread',
      mappingRequest: {
        selectedIssueNumber: 42,
        headRefName: 'autopilot/42',
        baseRefName: 'next',
      },
    });
    expect([...h.comments]).toEqual([]);
    expect(h.events.some((event) => event.startsWith('draft:'))).toBe(false);
    expect(h.events.some((event) => event.startsWith('label:'))).toBe(false);
  });

  it('accepts a canonical closing-reference mapping without a lifecycle marker', async () => {
    const h = harness({ state: 'active', draft: false });
    const read = h.port.readPullRequest;
    h.port.readPullRequest = async (...args) => ({
      ...await read(...args),
      body: 'Closes #42',
    });

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .resolves.toMatchObject({ status: 'approved', head: HEAD });
    expect(h.events).not.toContain('record:mapping-reread');
    expect(h.events).not.toContain('claim:mapping-reread');
  });

  it.each([
    {
      name: 'verdict',
      run: (h: ReturnType<typeof harness>) => (
        h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.')
      ),
    },
    {
      name: 'findings',
      run: (h: ReturnType<typeof harness>) => (
        h.protocol.reviewFindings!(h.manifest, '## Findings\n\n- Fix the race.')
      ),
    },
  ])(
    'preserves exact external Human authority before a $name mapping reread',
    async ({ run }) => {
      const h = harness({ state: 'active', draft: true });
      h.labels.add('review:needs-human');
      const read = h.port.readPullRequest;
      h.port.readPullRequest = async (...args) => ({
        ...await read(...args),
        mappingProblem: 'PR now maps to both issue #42 and issue #43.',
      });

      await expect(run(h)).resolves.toMatchObject({ status: 'human', head: HEAD });

      expect(h.authority.reviewRefOid).toBe(ACTIVE);
      expect(h.authority.record.state).toBe('active');
      expect(h.events).toEqual([]);
    },
  );

  it('restarts idempotently from an already published mapping reread request', async () => {
    const h = harness({
      state: 'mapping-reread',
      draft: true,
    });
    h.authority = {
      ...h.authority,
      record: record('mapping-reread', {
        mappingRequest: {
          selectedIssueNumber: 42,
          headRefName: 'autopilot/42',
          baseRefName: 'next',
        },
      }),
    };
    const read = h.port.readPullRequest;
    h.port.readPullRequest = async (...args) => ({
      ...await read(...args),
      mappingProblem: 'PR now maps to both issue #42 and issue #43.',
    });

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .resolves.toMatchObject({ status: 'mapping-pending', head: HEAD });

    expect(h.events).toEqual([]);
    expect([...h.comments]).toEqual([]);
  });

  it.each(['human', 'human-intent'] as const)(
    'replaces legacy internal %s audit state with a machine-owned mapping reread',
    async (state) => {
      const h = harness({ state, draft: true });
      const read = h.port.readPullRequest;
      h.port.readPullRequest = async (...args) => ({
        ...await read(...args),
        mappingProblem: 'PR now maps to both issue #42 and issue #43.',
      });

      await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
        .resolves.toMatchObject({ status: 'mapping-pending', head: HEAD });

      expect(h.events).toEqual(['record:mapping-reread', 'claim:mapping-reread']);
      expect(h.authority.record).toMatchObject({
        state: 'mapping-reread',
        mappingRequest: {
          selectedIssueNumber: 42,
          headRefName: 'autopilot/42',
          baseRefName: 'next',
        },
      });
    },
  );

  it.each([
    {
      name: 'closed PR',
      expectedStatus: 'human',
      expectedState: 'human',
      mutate: (pullRequest: Awaited<ReturnType<ReviewSessionPort['readPullRequest']>>) => ({
        ...pullRequest,
        open: false,
      }),
    },
    {
      name: 'changed issue mapping',
      expectedStatus: 'mapping-pending',
      expectedState: 'mapping-reread',
      mutate: (pullRequest: Awaited<ReturnType<ReviewSessionPort['readPullRequest']>>) => ({
        ...pullRequest,
        issueNumber: 43,
        mappingProblem: 'PR now maps to issue #43.',
      }),
    },
    {
      name: 'changed CODEOWNER policy',
      expectedStatus: 'human',
      expectedState: 'human',
      mutate: (pullRequest: Awaited<ReturnType<ReviewSessionPort['readPullRequest']>>) => ({
        ...pullRequest,
        approvalPolicy: 'human-codeowner' as const,
      }),
    },
  ])('parks safely when verdict authority sees a $name', async ({
    mutate,
    expectedStatus,
    expectedState,
  }) => {
    const h = harness({ draft: true });
    const read = h.port.readPullRequest;
    h.port.readPullRequest = async (...args) => mutate(await read(...args));

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .resolves.toMatchObject({ status: expectedStatus });
    expect(h.authority.record.state).toBe(expectedState);
    expect(h.events).not.toContain(`native:APPROVE:${HEAD}`);
  });

  it('approves and files follow-ups before terminal publish without child labels', async () => {
    const h = harness({ draft: true });
    const followUpsFiled: unknown[] = [];
    h.port.fileReviewFollowUps = async (input) => {
      followUpsFiled.push(input);
      h.events.push('follow-ups:filed');
      return [{ number: 501, created: true, index: 0 }];
    };

    const result = await h.protocol.reviewVerdict(
      h.manifest,
      'APPROVE',
      'LGTM',
      [{
        type: 'chore',
        title: 'Rename helper',
        body: 'Non-blocking',
        effort: 'low',
        priority: 'p3',
      }],
    );

    expect(result).toMatchObject({
      status: 'approved',
      head: HEAD,
      followUpNumbers: [501],
    });
    expect(followUpsFiled).toHaveLength(1);
    expect(h.events.indexOf('follow-ups:filed'))
      .toBeLessThan(h.events.indexOf('claim:terminal-approved'));
    expect(h.native.some((review) => review.body.includes('#501'))).toBe(true);
    expect(h.events.some((event) => event.startsWith('child:'))).toBe(false);
  });

  it('rejects follow-ups on REQUEST_CHANGES verdict', async () => {
    const h = harness();
    await expect(h.protocol.reviewVerdict(
      h.manifest,
      'REQUEST_CHANGES',
      'needs work',
      [{ type: 'fix', title: 'x', body: 'y', effort: 'low', priority: 'p1' }],
    )).rejects.toThrow(/only valid with APPROVE/i);
  });

  it('retries approve with same head reuse follow-ups then re-confirms APPROVE', async () => {
    const h = harness({ draft: true });
    let fileCalls = 0;
    h.port.fileReviewFollowUps = async () => {
      fileCalls += 1;
      h.events.push('follow-ups:filed');
      return [{ number: 502, created: fileCalls === 1, index: 0 }];
    };
    const entries = [{
      type: 'feat' as const,
      title: 'Debt',
      body: 'note',
      effort: 'medium' as const,
      priority: 'p2' as const,
    }];

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'LGTM', entries))
      .resolves.toMatchObject({ status: 'approved', followUpNumbers: [502] });

    const second = harness({
      state: 'terminal-approved',
      verdictState: 'APPROVE',
      draft: false,
      nativeExists: true,
    });
    second.port.fileReviewFollowUps = async () => {
      fileCalls += 1;
      second.events.push('follow-ups:filed');
      return [{ number: 502, created: false, index: 0 }];
    };

    await expect(second.protocol.reviewVerdict(
      second.manifest,
      'APPROVE',
      'LGTM again',
      entries,
    )).resolves.toMatchObject({
      status: 'approved',
      followUpNumbers: [502],
    });
    expect(fileCalls).toBe(2);
    expect(second.events).toContain('follow-ups:filed');
  });

  it('throws when follow-ups are supplied without a filing port', async () => {
    const h = harness({ draft: true });
    await expect(h.protocol.reviewVerdict(
      h.manifest,
      'APPROVE',
      'LGTM',
      [{ type: 'chore', title: 'x', body: 'y', effort: 'low', priority: 'p3' }],
    )).rejects.toThrow(/follow-up filing port/i);
  });

  it('approves without filing when follow-ups are empty or omitted', async () => {
    let filed = false;
    const omitted = harness({ draft: true });
    omitted.port.fileReviewFollowUps = async () => {
      filed = true;
      return [];
    };
    await expect(omitted.protocol.reviewVerdict(omitted.manifest, 'APPROVE', 'Clean.'))
      .resolves.toMatchObject({ status: 'approved', head: HEAD });
    expect(filed).toBe(false);

    const empty = harness({ draft: true });
    empty.port.fileReviewFollowUps = async () => {
      filed = true;
      return [];
    };
    await expect(empty.protocol.reviewVerdict(empty.manifest, 'APPROVE', 'Clean.', []))
      .resolves.toMatchObject({ status: 'approved', head: HEAD });
    expect(filed).toBe(false);
  });


  const DIGEST = `v1:${'d'.repeat(64)}`;

  it('records the reviewed diff digest on the intent and the terminal approval', async () => {
    const h = harness();
    const heads: GitOid[] = [];
    h.port.readReviewedDiffDigest = async (prNumber, expectedHead) => {
      expect(prNumber).toBe(84);
      heads.push(expectedHead);
      return { status: 'digest', digest: DIGEST };
    };

    const outcome = await h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.');
    expect(outcome).toMatchObject({ status: 'approved', head: HEAD });
    // A recorded digest is reported by the absence of an attribution, so the
    // field is never ambiguous about which of the two states it describes.
    expect(outcome).not.toHaveProperty('reviewedDiffDigestRefusal');

    // Digested once, at the head the reviewer read.
    expect(heads).toEqual([HEAD]);
    expect(h.authority.record).toMatchObject({
      state: 'terminal-approved',
      head: HEAD,
      reviewedDiffDigest: DIGEST,
    });
  });

  it('does not digest a REQUEST_CHANGES verdict', async () => {
    const h = harness();
    let calls = 0;
    h.port.readReviewedDiffDigest = async () => {
      calls += 1;
      return { status: 'digest', digest: DIGEST };
    };

    await h.protocol.reviewVerdict(h.manifest, 'REQUEST_CHANGES', 'Not yet.');
    expect(calls).toBe(0);
    expect(h.authority.record).not.toHaveProperty('reviewedDiffDigest');
  });

  it.each([
    // The measured canary cause: a session build whose port predates the
    // method. It is required by the type now, so only a foreign build can
    // present this shape — and it must be named, never silent.
    ['the port does not implement it', undefined, 'port-unavailable'],
    [
      'the port cannot prove a digest',
      async () => ({ status: 'unavailable', reason: 'unrepresented-patch' }),
      'unrepresented-patch',
    ],
    [
      'the compare file list is at the cap',
      async () => ({ status: 'unavailable', reason: 'compare-files-truncated' }),
      'compare-files-truncated',
    ],
    [
      'the port throws',
      async () => { throw new Error('HTTP 500'); },
      'port-threw: HTTP 500',
    ],
    ['the port resolves to nothing', async () => undefined, 'port-malformed'],
    [
      'the port resolves to a malformed digest',
      async () => ({ status: 'digest', digest: 'not-a-digest' }),
      'port-malformed',
    ],
  ])('approves without a digest and names the cause when %s', async (
    _name,
    reader,
    refusal,
  ) => {
    const h = harness();
    if (reader === undefined) delete h.port.readReviewedDiffDigest;
    else h.port.readReviewedDiffDigest = reader;

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .resolves.toMatchObject({
        status: 'approved',
        head: HEAD,
        reviewedDiffDigestRefusal: refusal,
      });
    // No digest recorded means the merge gate keeps requiring exact head
    // identity: today's behaviour, never a silent carry.
    expect(h.authority.record).toMatchObject({ state: 'terminal-approved' });
    expect(h.authority.record).not.toHaveProperty('reviewedDiffDigest');
  });

  it('names a reused digest-less intent rather than re-reading a digest for it', async () => {
    const h = harness({ state: 'verdict-intent', verdictState: 'APPROVE' });
    let calls = 0;
    h.port.readReviewedDiffDigest = async () => {
      calls += 1;
      return { status: 'digest', digest: DIGEST };
    };

    await expect(h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.'))
      .resolves.toMatchObject({
        status: 'approved',
        reviewedDiffDigestRefusal: 'recorded-without-digest',
      });
    // The digest must describe the diff the reviewer read, so a retry never
    // recomputes one for the durable intent it is resuming.
    expect(calls).toBe(0);
    expect(h.authority.record).not.toHaveProperty('reviewedDiffDigest');
  });

  it('reuses the durable intent digest on a retry instead of re-reading it', async () => {
    const h = harness({ state: 'verdict-intent', verdictState: 'APPROVE' });
    h.authority = {
      reviewRefOid: h.authority.reviewRefOid,
      record: {
        ...h.authority.record,
        reviewedDiffDigest: DIGEST,
      },
    };
    let calls = 0;
    h.port.readReviewedDiffDigest = async () => {
      calls += 1;
      return { status: 'digest', digest: `v1:${'e'.repeat(64)}` };
    };

    const outcome = await h.protocol.reviewVerdict(h.manifest, 'APPROVE', 'Clean.');
    expect(outcome).toMatchObject({ status: 'approved', head: HEAD });
    expect(outcome).not.toHaveProperty('reviewedDiffDigestRefusal');
    expect(calls).toBe(0);
    expect(h.authority.record).toMatchObject({
      state: 'terminal-approved',
      reviewedDiffDigest: DIGEST,
    });
  });
});
