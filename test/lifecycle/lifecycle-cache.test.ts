import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LifecycleDiscoveryCacheCorruptError,
  LifecycleDiscoveryCacheStore,
  type LifecycleDiscoveryState,
} from '../../src/lifecycle/lifecycle-cache.js';
import { gitOid } from '../../src/lifecycle/types.js';
import { gitRefName } from '../../src/lifecycle/types.js';
import type { BranchClaimSnapshot, PullRequestSnapshot } from '../../src/lifecycle/snapshot.js';

const CAPTURED_AT = '2026-07-22T10:00:00.000Z';

function state(): LifecycleDiscoveryState {
  const pullRequest: PullRequestSnapshot = {
    number: 101,
    title: 'feat: cached lifecycle',
    body: 'Closes #42',
    author: 'oaksprout',
    baseRefName: 'next',
    headRefName: 'autopilot/42',
    headOid: gitOid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    headCommittedAt: '2026-07-22T09:00:00.000Z',
    isDraft: false,
    state: 'OPEN',
    labels: ['engine:review'],
    closingIssueNumbers: [42],
    mergeability: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    checks: [],
    reviews: [],
  };
  return {
    version: 4,
    evidence: {
      project: {
        items: [{
          id: 'PVTI_42',
          number: 42,
          contentType: 'Issue',
          status: 'Todo',
          priority: 'P1',
          effort: 'Medium',
          blockedOn: 'Nothing',
          issueType: 'feat',
          blockedByIssues: [],
          sprintIterationId: 'sprint',
        }],
        rateLimit: {
          remaining: 4_000,
          used: 1_000,
          resetAt: '2026-07-22T11:00:00.000Z',
        },
        currentSprintIterationId: 'sprint',
      },
      issues: [{
        number: 42,
        title: 'Cached issue',
        labels: ['engine'],
        shape: 'feat',
        blockedOn: 'Nothing',
        blockedByIssues: [],
        effort: 'Medium',
        priority: 'P1',
        status: 'Todo',
        onBoard: true,
        author: 'oaksprout',
        projectItemId: 'PVTI_42',
        inCurrentSprint: true,
      }],
      pullRequests: [pullRequest],
      branches: [],
      capturedAt: CAPTURED_AT,
      snapshotMode: 'full',
      lastFullReconciliationAt: CAPTURED_AT,
      githubUsage: {
        graphqlRequests: 2,
        graphqlCost: 390,
        graphqlRemaining: 4_000,
        graphqlResetAt: '2026-07-22T11:00:00.000Z',
        restRequests: 0,
        restNotModified: 0,
        cacheHits: 0,
        accountingComplete: true,
      },
    },
    terminalClaims: [],
    openPullRequestEvidence: [pullRequest],
    openPullRequests: null,
    recentlyClosedPullRequests: [],
    recentlyClosedCutoff: '2026-07-22T09:55:00.000Z',
    restCache: [{
      endpoint: 'repos/Jinn-Network/mono/issues?state=open&page=1',
      etag: '"issues-v1"',
      body: '[]',
      nextEndpoint: null,
    }],
  };
}

function incrementalRestAuthorityState(
  usage: Partial<LifecycleDiscoveryState['evidence']['githubUsage']> = {},
): LifecycleDiscoveryState {
  const base = state();
  return {
    ...base,
    openPullRequests: [{
      number: 101,
      title: 'feat: cached lifecycle',
      state: 'OPEN',
      updatedAt: '2026-07-22T09:00:00.000Z',
      headOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      headRefName: 'autopilot/42',
      baseRefName: 'next',
      isDraft: false,
      closedAt: null,
      mergedAt: null,
    }],
    evidence: {
      ...base.evidence,
      snapshotMode: 'incremental',
      capturedAt: '2026-07-22T10:10:00.000Z',
      githubUsage: {
        ...base.evidence.githubUsage,
        graphqlRequests: 0,
        graphqlCost: 0,
        graphqlRemaining: 3_999,
        restRequests: 5,
        ...usage,
      },
    },
  };
}

function branch(): BranchClaimSnapshot {
  return {
    issueNumber: 42,
    headRefName: 'autopilot/42',
    headOid: gitOid('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    headCommittedAt: '2026-07-22T09:30:00.000Z',
    claim: {
      kind: 'branch-claim',
      protocolVersion: 2,
      phase: 'implement',
      issueNumber: 42,
      prNumber: 202,
      attempt: '11111111-1111-4111-8111-111111111111',
      runner: 'runner-a',
      login: 'oaksprout',
      expectedHead: gitOid('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      targetBase: gitRefName('next'),
      claimedAt: '2026-07-22T09:30:00.000Z',
    },
  };
}

function stateWithTerminalClaim(): LifecycleDiscoveryState {
  const claimedBranch = branch();
  return {
    ...state(),
    evidence: {
      ...state().evidence,
      branches: [claimedBranch],
    },
    terminalClaims: [{
      issueNumber: 42,
      prNumber: 202,
      headRefName: 'autopilot/42',
      headOid: gitOid('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      claimAttempt: '11111111-1111-4111-8111-111111111111',
      targetBase: gitRefName('next'),
      claimFingerprint: '78a9c342d92eba807e79dcf2f595877f01f4bec051e8ba8db553b2f640c63b8b',
      mergedAt: '2026-07-22T09:45:00.000Z',
      mergeCommitOid: gitOid('dddddddddddddddddddddddddddddddddddddddd'),
    }],
  };
}

describe('LifecycleDiscoveryCacheStore', () => {
  it('atomically round-trips a strict owner-only non-secret discovery envelope', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });

    await store.save(state());

    await expect(store.load()).resolves.toEqual(state());
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, 'lifecycle-cache.json'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(directory, 'lifecycle-cache.json'), 'utf8'))
      .not.toMatch(/GH_TOKEN|credential|authorization/i);
  });

  it('round-trips the usage of a cycle that retried a read through a transport fault', async () => {
    // The envelope schema is `.strict()`, so a cycle whose meter counted a
    // retry can only be persisted while `transientRetries` is declared on it.
    // Dropping the field would make every retried cycle's cache unreadable.
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });
    const base = state();
    const retried: LifecycleDiscoveryState = {
      ...base,
      evidence: {
        ...base.evidence,
        githubUsage: {
          ...base.evidence.githubUsage,
          accountingComplete: false,
          incompleteReason: '1 read was retried through a transport fault '
            + "(latest: gh, TLS handshake failure); the faulted attempts' quota "
            + 'cost is unevidenced',
          transientRetries: 2,
        },
      },
    };

    await store.save(retried);

    await expect(store.load()).resolves.toEqual(retried);
  });

  it('exposes only the validated durable cadence marker without a network dependency', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });
    await store.save(state());

    await expect(store.readCadenceSeed()).resolves.toBe(CAPTURED_AT);
  });

  it('returns no cadence marker when no lifecycle cache exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });

    await expect(store.readCadenceSeed()).resolves.toBeNull();
  });

  it('round-trips terminal claim evidence after merged PR evidence is no longer retained', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });
    const terminal = stateWithTerminalClaim();

    await store.save(terminal);

    await expect(store.load()).resolves.toEqual(terminal);
  });

  /**
   * Every `compareStatus` a version-1 cache holds was computed against the PR's
   * pinned fork point and is therefore `ahead` by construction. Those values
   * must not survive the deploy, so a version-1 envelope has to be rejected —
   * the incremental source quarantines a corrupt cache and reseeds from a full
   * read, which is exactly the migration we want.
   */
  it('rejects a version 1 envelope so pre-fix compareStatus values cannot survive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    await chmod(directory, 0o700);
    await writeFile(
      join(directory, 'lifecycle-cache.json'),
      JSON.stringify({ ...state(), version: 1 }),
      { mode: 0o600 },
    );
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });

    await expect(store.load()).rejects.toBeInstanceOf(LifecycleDiscoveryCacheCorruptError);
  });

  it('rejects a version 2 envelope so compareStatus without base-tip keys cannot survive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    await chmod(directory, 0o700);
    await writeFile(
      join(directory, 'lifecycle-cache.json'),
      JSON.stringify({ ...state(), version: 2 }),
      { mode: 0o600 },
    );
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });

    await expect(store.load()).rejects.toBeInstanceOf(LifecycleDiscoveryCacheCorruptError);
  });

  /**
   * A version-3 cache predates the merge-queue read (#82): its PR entries carry
   * no `graphqlId` and no `mergeQueue`, so absence there is indistinguishable
   * from "read and proven not queued". Reading a stale cache as proof of queue
   * membership either skips an enqueue that never happened or repeats one that
   * did, so the envelope is discarded and reseeded from a full read.
   */
  it('rejects a version 3 envelope so pre-merge-queue PR evidence cannot survive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    await chmod(directory, 0o700);
    await writeFile(
      join(directory, 'lifecycle-cache.json'),
      JSON.stringify({ ...state(), version: 3 }),
      { mode: 0o600 },
    );
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });

    await expect(store.load()).rejects.toBeInstanceOf(LifecycleDiscoveryCacheCorruptError);
  });

  it('round-trips merge-queue evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });
    const base = state();
    const queueEvidence = {
      graphqlId: 'PR_kwDOABCD123',
      mergeQueue: { enqueued: true, position: 2, state: 'QUEUED' },
    } as const;
    const withQueue: LifecycleDiscoveryState = {
      ...base,
      evidence: {
        ...base.evidence,
        pullRequests: [{ ...base.evidence.pullRequests[0]!, ...queueEvidence }],
      },
      openPullRequestEvidence: [{
        ...base.openPullRequestEvidence[0]!,
        ...queueEvidence,
      }],
    };

    await expect(store.save(withQueue)).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual(withQueue);
  });

  /**
   * `enqueueRecorded` (review finding N2) is dead plumbing: nothing threads
   * it into a written cache entry any more, and nothing ever read it back to
   * make a decision. `pullRequestSchema` still tolerates the key so a v4
   * cache written before this cleanup -- which may carry
   * `enqueueRecorded: true` on some PR entries -- keeps loading instead of
   * being rejected as corrupt.
   */
  it('tolerates a legacy stray enqueueRecorded field on a v4 cache entry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    await chmod(directory, 0o700);
    const base = state();
    const legacy = {
      ...base,
      evidence: {
        ...base.evidence,
        pullRequests: [{ ...base.evidence.pullRequests[0]!, enqueueRecorded: true }],
      },
      openPullRequestEvidence: [{
        ...base.openPullRequestEvidence[0]!,
        enqueueRecorded: true,
      }],
    };
    await writeFile(
      join(directory, 'lifecycle-cache.json'),
      JSON.stringify(legacy),
      { mode: 0o600 },
    );
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });

    await expect(store.load()).resolves.toEqual(legacy);
  });

  it('loads a legacy cache without terminal claim evidence as an empty fail-closed ledger', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    await chmod(directory, 0o700);
    const { terminalClaims: _terminalClaims, ...legacy } = state();
    await writeFile(
      join(directory, 'lifecycle-cache.json'),
      JSON.stringify(legacy),
      { mode: 0o600 },
    );
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });

    await expect(store.load()).resolves.toEqual(state());
  });

  it.each([
    ['missing branch', () => ({
      ...stateWithTerminalClaim(),
      evidence: { ...stateWithTerminalClaim().evidence, branches: [] },
    })],
    ['changed issue', () => ({
      ...stateWithTerminalClaim(),
      terminalClaims: [{
        ...stateWithTerminalClaim().terminalClaims[0]!,
        issueNumber: 43,
      }],
    })],
    ['changed PR', () => ({
      ...stateWithTerminalClaim(),
      terminalClaims: [{
        ...stateWithTerminalClaim().terminalClaims[0]!,
        prNumber: 203,
      }],
    })],
    ['changed branch', () => ({
      ...stateWithTerminalClaim(),
      terminalClaims: [{
        ...stateWithTerminalClaim().terminalClaims[0]!,
        headRefName: 'autopilot/42-r2',
      }],
    })],
    ['changed head', () => ({
      ...stateWithTerminalClaim(),
      terminalClaims: [{
        ...stateWithTerminalClaim().terminalClaims[0]!,
        headOid: gitOid('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
      }],
    })],
    ['changed attempt', () => ({
      ...stateWithTerminalClaim(),
      terminalClaims: [{
        ...stateWithTerminalClaim().terminalClaims[0]!,
        claimAttempt: '22222222-2222-4222-8222-222222222222',
      }],
    })],
    ['changed target base', () => ({
      ...stateWithTerminalClaim(),
      terminalClaims: [{
        ...stateWithTerminalClaim().terminalClaims[0]!,
        targetBase: gitRefName('release/next'),
      }],
    })],
    ['changed runner', () => ({
      ...stateWithTerminalClaim(),
      evidence: {
        ...stateWithTerminalClaim().evidence,
        branches: [{
          ...stateWithTerminalClaim().evidence.branches[0]!,
          claim: {
            ...stateWithTerminalClaim().evidence.branches[0]!.claim,
            runner: 'runner-b',
          },
        }],
      },
    })],
    ['changed login', () => ({
      ...stateWithTerminalClaim(),
      evidence: {
        ...stateWithTerminalClaim().evidence,
        branches: [{
          ...stateWithTerminalClaim().evidence.branches[0]!,
          claim: {
            ...stateWithTerminalClaim().evidence.branches[0]!.claim,
            login: 'different-login',
          },
        }],
      },
    })],
    ['changed expected head', () => ({
      ...stateWithTerminalClaim(),
      evidence: {
        ...stateWithTerminalClaim().evidence,
        branches: [{
          ...stateWithTerminalClaim().evidence.branches[0]!,
          claim: {
            ...stateWithTerminalClaim().evidence.branches[0]!.claim,
            expectedHead: gitOid('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
          },
        }],
      },
    })],
    ['changed claimed time', () => ({
      ...stateWithTerminalClaim(),
      evidence: {
        ...stateWithTerminalClaim().evidence,
        branches: [{
          ...stateWithTerminalClaim().evidence.branches[0]!,
          claim: {
            ...stateWithTerminalClaim().evidence.branches[0]!.claim,
            claimedAt: '2026-07-22T09:31:00.000Z',
          },
        }],
      },
    })],
    ['changed phase completion', () => ({
      ...stateWithTerminalClaim(),
      evidence: {
        ...stateWithTerminalClaim().evidence,
        branches: [{
          ...stateWithTerminalClaim().evidence.branches[0]!,
          claim: {
            ...stateWithTerminalClaim().evidence.branches[0]!.claim,
            phaseComplete: true as const,
          },
        }],
      },
    })],
  ] as const)('rejects terminal evidence with a %s identity', async (_label, makeState) => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });

    await expect(store.save(makeState())).rejects
      .toBeInstanceOf(LifecycleDiscoveryCacheCorruptError);
  });

  // The engine mints `fix` and `reconcile` branch claims for child issues
  // (`implementation-executor.ts`). If the persistence envelope cannot encode
  // them, the first snapshot that observes such a claim becomes unsaveable and
  // discovery freezes on its last good cache.
  it.each([
    ['fix', 'fix'],
    ['reconcile', 'reconcile'],
  ] as const)('round-trips a child %s branch claim on PR evidence', async (_label, phase) => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });
    const base = state();
    const branchClaim = {
      kind: 'branch-claim',
      protocolVersion: 2,
      phase,
      issueNumber: 43,
      prNumber: 101,
      attempt: '22222222-2222-4222-8222-222222222222',
      runner: 'runner-a',
      login: 'oaksprout',
      expectedHead: gitOid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      targetBase: gitRefName('next'),
      claimedAt: '2026-07-22T09:30:00.000Z',
    } as const;
    const withChildClaim: LifecycleDiscoveryState = {
      ...base,
      evidence: {
        ...base.evidence,
        pullRequests: [{ ...base.evidence.pullRequests[0]!, branchClaim }],
      },
      openPullRequestEvidence: [{ ...base.openPullRequestEvidence[0]!, branchClaim }],
    };

    await expect(store.save(withChildClaim)).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual(withChildClaim);
  });

  it('round-trips a runaway-child merge-ready Human escalation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });
    const base = state();
    const humanReason = {
      phase: 'merge-ready',
      code: 'runaway-child',
      detail: 'Child issue fan-out exceeded its budget.',
    } as const;
    const escalated: LifecycleDiscoveryState = {
      ...base,
      evidence: {
        ...base.evidence,
        pullRequests: [{ ...base.evidence.pullRequests[0]!, humanReason }],
      },
      openPullRequestEvidence: [{ ...base.openPullRequestEvidence[0]!, humanReason }],
    };

    await expect(store.save(escalated)).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual(escalated);
  });

  it('round-trips ci rerun evidence in snapshot and open-PR cache state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });
    const base = state();
    const withCiRerunRecorded: LifecycleDiscoveryState = {
      ...base,
      evidence: {
        ...base.evidence,
        pullRequests: [{
          ...base.evidence.pullRequests[0]!,
          ciRerunRecorded: true,
        }],
      },
      openPullRequestEvidence: [{
        ...base.openPullRequestEvidence[0]!,
        ciRerunRecorded: true,
      }],
    };

    await expect(store.save(withCiRerunRecorded)).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual(withCiRerunRecorded);
  });

  it('round-trips exact compare evidence in snapshot and open-PR cache state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });
    const base = state();
    const withCompareStatus: LifecycleDiscoveryState = {
      ...base,
      evidence: {
        ...base.evidence,
        pullRequests: [{
          ...base.evidence.pullRequests[0]!,
          compareStatus: 'behind',
          compareBaseTipOid: gitOid('cccccccccccccccccccccccccccccccccccccccc'),
        }],
      },
      openPullRequestEvidence: [{
        ...base.openPullRequestEvidence[0]!,
        compareStatus: 'behind',
        compareBaseTipOid: gitOid('cccccccccccccccccccccccccccccccccccccccc'),
      }],
    };

    await expect(store.save(withCompareStatus)).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual(withCompareStatus);
  });

  it('rejects malformed exact compare evidence from the cache', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });
    const base = state();
    await writeFile(join(directory, 'lifecycle-cache.json'), JSON.stringify({
      ...base,
      evidence: {
        ...base.evidence,
        pullRequests: [{ ...base.evidence.pullRequests[0]!, compareStatus: 'clean' }],
      },
    }), { mode: 0o600 });

    await expect(store.load()).rejects.toBeInstanceOf(LifecycleDiscoveryCacheCorruptError);
  });

  it('persists complete incremental quota evidence supplied by zero-point REST authority', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });
    const incremental = incrementalRestAuthorityState();

    await expect(store.save(incremental)).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual(incremental);
  });

  it('round-trips a closed PR whose close timestamp follows its update timestamp', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });
    const base = state();
    const withDelayedClose: LifecycleDiscoveryState = {
      ...base,
      recentlyClosedPullRequests: [{
        number: 1951,
        title: 'Feed intermediate failure diffs',
        state: 'CLOSED',
        updatedAt: '2026-07-23T23:24:45.000Z',
        headOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        headRefName: 'feature/1951',
        baseRefName: 'next',
        isDraft: false,
        closedAt: '2026-07-23T23:24:47.000Z',
        mergedAt: null,
      }],
    };

    await expect(store.save(withDelayedClose)).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual(withDelayedClose);
  });

  it.each([
    ['no live REST request', { restRequests: 0 }],
    ['nonzero GraphQL cost without a GraphQL request', { graphqlCost: 1 }],
  ])('rejects incremental zero-GraphQL authority with %s', async (_label, usage) => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });

    await expect(store.save(incrementalRestAuthorityState(usage)))
      .rejects.toThrow(/quota authority|REST|GraphQL/i);
  });

  it('returns null when no complete cache exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });

    await expect(store.load()).resolves.toBeNull();
  });

  it.each([
    ['malformed JSON', '{broken'],
    ['unknown top-level member', JSON.stringify({ ...state(), credential: 'secret' })],
    ['invalid nested evidence', JSON.stringify({
      ...state(),
      evidence: {
        ...state().evidence,
        project: {
          ...state().evidence.project,
          items: [{ ...state().evidence.project.items[0], surprise: true }],
        },
      },
    })],
    ['impossible cutoff', JSON.stringify({
      ...state(),
      recentlyClosedCutoff: '2026-02-30T00:00:00.000Z',
    })],
  ])('fails closed on %s', async (_label, body) => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });
    await writeFile(join(directory, 'lifecycle-cache.json'), body, { mode: 0o600 });

    await expect(store.load()).rejects.toBeInstanceOf(LifecycleDiscoveryCacheCorruptError);
  });

  it('fails closed when the cache directory is not owner-only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });
    await store.save(state());
    await chmod(directory, 0o755);

    await expect(store.load()).rejects.toThrow(/directory permissions.*owner-only/i);
  });

  it('rejects an existing insecure state directory without changing its mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-shared-'));
    await chmod(directory, 0o755);
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });

    await expect(store.save(state())).rejects.toThrow(/permissions|0700|owner-only/i);
    expect((await stat(directory)).mode & 0o777).toBe(0o755);
    await expect(readFile(join(directory, 'lifecycle-cache.json'), 'utf8')).rejects.toThrow();
  });

  it('accepts an existing private directory owned by the runner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-private-'));
    await chmod(directory, 0o700);
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });

    await expect(store.save(state())).resolves.toBeUndefined();
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it('creates a missing final state directory with mode 0700', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-parent-'));
    const directory = join(parent, 'dedicated-state');
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });

    await expect(store.save(state())).resolves.toBeUndefined();
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it('rejects a symlink state directory immediately before writing', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-parent-'));
    const target = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-target-'));
    const linked = join(parent, 'state');
    await symlink(target, linked);
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: linked });

    await expect(store.save(state())).rejects.toThrow(/directory|symbolic|unsafe/i);
    await expect(readFile(join(target, 'lifecycle-cache.json'), 'utf8')).rejects.toThrow();
  });

  it.each([
    ['last full after capture', () => ({
      ...state(),
      evidence: {
        ...state().evidence,
        lastFullReconciliationAt: '2026-07-22T10:01:00.000Z',
      },
    })],
    ['duplicate Project identity', () => ({
      ...state(),
      evidence: {
        ...state().evidence,
        project: {
          ...state().evidence.project,
          items: [state().evidence.project.items[0]!, state().evidence.project.items[0]!],
        },
      },
    })],
    ['duplicate issue identity', () => ({
      ...state(),
      evidence: { ...state().evidence, issues: [state().evidence.issues[0]!, state().evidence.issues[0]!] },
    })],
    ['duplicate PR identity', () => ({
      ...state(),
      evidence: {
        ...state().evidence,
        pullRequests: [state().evidence.pullRequests[0]!, state().evidence.pullRequests[0]!],
      },
    })],
    ['duplicate exact open evidence identity', () => ({
      ...state(),
      openPullRequestEvidence: [
        state().openPullRequestEvidence[0]!,
        state().openPullRequestEvidence[0]!,
      ],
    })],
    ['duplicate branch identity', () => ({
      ...state(),
      evidence: { ...state().evidence, branches: [branch(), branch()] },
    })],
    ['duplicate open index identity', () => ({
      ...state(),
      openPullRequests: [
        {
          number: 101,
          title: 'cached',
          state: 'OPEN' as const,
          updatedAt: '2026-07-22T09:30:00.000Z',
          headOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          headRefName: 'autopilot/42',
          baseRefName: 'next',
          isDraft: false,
          closedAt: null,
          mergedAt: null,
        },
        {
          number: 101,
          title: 'cached',
          state: 'OPEN' as const,
          updatedAt: '2026-07-22T09:30:00.000Z',
          headOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          headRefName: 'autopilot/42',
          baseRefName: 'next',
          isDraft: false,
          closedAt: null,
          mergedAt: null,
        },
      ],
    })],
    ['closed row in open index', () => ({
      ...state(),
      openPullRequests: [{
        number: 101,
        title: 'cached',
        state: 'CLOSED' as const,
        updatedAt: '2026-07-22T09:30:00.000Z',
        headOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        headRefName: 'autopilot/42',
        baseRefName: 'next',
        isDraft: false,
        closedAt: '2026-07-22T09:30:00.000Z',
        mergedAt: null,
      }],
    })],
    ['open row in closed index', () => ({
      ...state(),
      recentlyClosedPullRequests: [{
        number: 101,
        title: 'cached',
        state: 'OPEN' as const,
        updatedAt: '2026-07-22T09:30:00.000Z',
        headOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        headRefName: 'autopilot/42',
        baseRefName: 'next',
        isDraft: false,
        closedAt: null,
        mergedAt: null,
      }],
    })],
    ['duplicate closed index identity', () => {
      const closed = {
        number: 101,
        title: 'cached',
        state: 'CLOSED' as const,
        updatedAt: '2026-07-22T09:30:00.000Z',
        headOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        headRefName: 'autopilot/42',
        baseRefName: 'next',
        isDraft: false,
        closedAt: '2026-07-22T09:30:00.000Z',
        mergedAt: null,
      };
      return { ...state(), recentlyClosedPullRequests: [closed, closed] };
    }],
    ['unsafe REST cache endpoint', () => ({
      ...state(),
      restCache: [{
        ...state().restCache[0]!,
        endpoint: 'https://attacker.invalid/repos/Jinn-Network/mono/issues',
      }],
    })],
    ['unsafe REST cache next endpoint', () => ({
      ...state(),
      restCache: [{
        ...state().restCache[0]!,
        nextEndpoint: '../outside?page=2',
      }],
    })],
    ['duplicate REST cache endpoint', () => ({
      ...state(),
      restCache: [state().restCache[0]!, state().restCache[0]!],
    })],
    ['OPEN evidence with merged timestamp', () => ({
      ...state(),
      evidence: {
        ...state().evidence,
        pullRequests: [{ ...state().evidence.pullRequests[0]!, mergedAt: '2026-07-22T09:45:00.000Z' }],
      },
    })],
    ['MERGED evidence without merged timestamp', () => ({
      ...state(),
      evidence: {
        ...state().evidence,
        pullRequests: [{ ...state().evidence.pullRequests[0]!, state: 'MERGED' as const }],
      },
    })],
  ] as const)('rejects semantic corruption: %s', async (_label, makeState) => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });
    await writeFile(
      join(directory, 'lifecycle-cache.json'),
      JSON.stringify(makeState()),
      { mode: 0o600 },
    );

    await expect(store.load()).rejects.toBeInstanceOf(LifecycleDiscoveryCacheCorruptError);
  });

  it('accepts user-controlled and clock-skewed commit, review, ref, and merge timestamps', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });
    const base = state();
    const futureHead = '2026-07-22T12:00:00.000Z';
    const skewed: LifecycleDiscoveryState = {
      ...base,
      evidence: {
        ...base.evidence,
        pullRequests: [{
          ...base.evidence.pullRequests[0]!,
          state: 'MERGED',
          headCommittedAt: futureHead,
          reviews: [{
            reviewer: 'reviewer',
            state: 'APPROVED',
            commitId: gitOid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
            body: 'approved despite a skewed clock',
            submittedAt: '2026-07-22T13:00:00.000Z',
          }],
          reviewClaim: {
            oid: gitOid('cccccccccccccccccccccccccccccccccccccccc'),
            record: {
              kind: 'review-claim',
              protocolVersion: 2,
              prNumber: 101,
              generation: '11111111-1111-4111-8111-111111111111',
              attempt: '22222222-2222-4222-8222-222222222222',
              reviewer: 'reviewer',
              head: gitOid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
              recordedAt: '2026-07-22T14:00:00.000Z',
              state: 'active',
            },
          },
          mergedAt: '2026-07-22T08:00:00.000Z',
          mergeCommitOid: gitOid('dddddddddddddddddddddddddddddddddddddddd'),
        }],
        branches: [{
          ...branch(),
          headCommittedAt: futureHead,
          claim: {
            ...branch().claim,
            claimedAt: '2026-07-22T15:00:00.000Z',
          },
        }],
      },
      openPullRequestEvidence: [],
      openPullRequests: null,
    };

    await expect(store.save(skewed)).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual(skewed);
  });

  it('persists reviewed-diff digests and refuses malformed ones', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jinn-lifecycle-cache-'));
    const store = new LifecycleDiscoveryCacheStore({ stateDirectory: directory });
    const base = state();
    const digest = `v1:${'c'.repeat(64)}`;
    const pullRequest: PullRequestSnapshot = {
      ...base.evidence.pullRequests[0]!,
      reviewedDiffDigest: digest,
      reviewClaim: {
        oid: gitOid('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
        record: {
          kind: 'review-claim',
          protocolVersion: 2,
          prNumber: 101,
          generation: '22222222-2222-4222-8222-222222222222',
          attempt: '33333333-3333-4333-8333-333333333333',
          reviewer: 'reviewer',
          head: gitOid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
          recordedAt: '2026-07-22T14:00:00.000Z',
          state: 'terminal-approved',
          verdict: { marker: '44444444-4444-4444-8444-444444444444', state: 'APPROVE' },
          reviewedDiffDigest: digest,
        },
      },
    };
    const withDigest: LifecycleDiscoveryState = {
      ...base,
      evidence: { ...base.evidence, pullRequests: [pullRequest] },
      openPullRequestEvidence: [pullRequest],
    };

    await expect(store.save(withDigest)).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual(withDigest);

    // A cache written before the field existed still loads, and still loads
    // without a digest — which is what keeps the merge gate on exact heads.
    const legacyPr = { ...withDigest.evidence.pullRequests[0]! };
    delete (legacyPr as Record<string, unknown>).reviewedDiffDigest;
    delete (legacyPr.reviewClaim!.record as unknown as Record<string, unknown>).reviewedDiffDigest;
    const legacy: LifecycleDiscoveryState = {
      ...withDigest,
      evidence: { ...withDigest.evidence, pullRequests: [legacyPr] },
      openPullRequestEvidence: [legacyPr],
    };
    await expect(store.save(legacy)).resolves.toBeUndefined();
    const loaded = await store.load();
    expect(loaded!.evidence.pullRequests[0]).not.toHaveProperty('reviewedDiffDigest');
    expect(loaded!.evidence.pullRequests[0]!.reviewClaim!.record)
      .not.toHaveProperty('reviewedDiffDigest');

    await writeFile(
      join(directory, 'lifecycle-cache.json'),
      JSON.stringify({
        ...legacy,
        evidence: {
          ...legacy.evidence,
          pullRequests: [{ ...legacyPr, reviewedDiffDigest: 'not-a-digest' }],
        },
      }),
    );
    await expect(store.load()).rejects.toBeInstanceOf(LifecycleDiscoveryCacheCorruptError);
  });
});
