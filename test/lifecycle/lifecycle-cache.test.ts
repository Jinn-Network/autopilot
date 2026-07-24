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
    version: 1,
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
});
