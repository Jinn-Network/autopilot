import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnDaemonActiveOnce } from '../src/service.js';

const CHILD_ENTRY = fileURLToPath(
  new URL('./fixtures/daemon-cadence-child.mjs', import.meta.url),
);

function cacheState(lastFullReconciliationAt: string): unknown {
  return {
    version: 1,
    evidence: {
      project: {
        items: [],
        rateLimit: {
          remaining: 4_000,
          used: 1_000,
          resetAt: '2026-07-22T11:00:00.000Z',
        },
        currentSprintIterationId: null,
      },
      issues: [],
      pullRequests: [],
      branches: [],
      capturedAt: lastFullReconciliationAt,
      snapshotMode: 'full',
      lastFullReconciliationAt,
      githubUsage: {
        graphqlRequests: 1,
        graphqlCost: 1,
        graphqlRemaining: 4_000,
        graphqlResetAt: '2026-07-22T11:00:00.000Z',
        restRequests: 0,
        restNotModified: 0,
        cacheHits: 0,
        accountingComplete: true,
      },
    },
    terminalClaims: [],
    openPullRequestEvidence: [],
    openPullRequests: null,
    recentlyClosedPullRequests: [],
    recentlyClosedCutoff: lastFullReconciliationAt,
    restCache: [],
  };
}

async function runChild(input: {
  readonly cacheBody: string;
  readonly sourceMarker: string;
}): Promise<{
  readonly arguments: readonly string[];
  readonly internalMarker: string | undefined;
  readonly cadenceSeed: string | null;
  readonly reads: readonly string[];
  readonly resetUsage: readonly (boolean | null)[];
  readonly snapshotMode: string;
  readonly githubCallsBeforeValidation: number;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'autopilot-cadence-process-'));
  await chmod(directory, 0o700);
  await writeFile(join(directory, 'lifecycle-cache.json'), input.cacheBody, { mode: 0o600 });
  const resultPath = join(directory, 'result.json');
  const child = spawnDaemonActiveOnce({
    entryPath: CHILD_ENTRY,
    cwd: directory,
    environment: {
      PATH: process.env.PATH,
      TEST_STATE_DIRECTORY: directory,
      TEST_RESULT_PATH: resultPath,
      TEST_NOW: '2026-07-22T10:30:00.000Z',
      TEST_SOURCE_MARKER: input.sourceMarker,
    },
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  expect(exitCode).toBe(0);

  return JSON.parse(await readFile(resultPath, 'utf8')) as {
    readonly arguments: readonly string[];
    readonly internalMarker: string | undefined;
    readonly cadenceSeed: string | null;
    readonly reads: readonly string[];
    readonly resetUsage: readonly (boolean | null)[];
    readonly snapshotMode: string;
    readonly githubCallsBeforeValidation: number;
  };
}

describe('daemon active-once process boundary', () => {
  it.each([
    [
      'recent',
      JSON.stringify(cacheState('2026-07-22T10:00:00.000Z')),
      '2026-07-22T10:00:00.000Z',
      '2026-07-22T10:00:00.000Z',
      ['incremental'],
      [null],
      'incremental',
    ],
    [
      'due',
      JSON.stringify(cacheState('2026-07-22T08:00:00.000Z')),
      '2026-07-22T08:00:00.000Z',
      '2026-07-22T08:00:00.000Z',
      ['full'],
      [null],
      'full',
    ],
    [
      'changed after seed',
      JSON.stringify(cacheState('2026-07-22T10:00:00.000Z')),
      '2026-07-22T08:00:00.000Z',
      '2026-07-22T10:00:00.000Z',
      ['incremental', 'full'],
      [null, false],
      'full',
    ],
    [
      'corrupt',
      '{broken',
      '2026-07-22T10:00:00.000Z',
      null,
      ['full'],
      [null],
      'full',
    ],
  ] as const)(
    'carries validated %s cache cadence across the spawned entry boundary',
    async (
      _label,
      cacheBody,
      sourceMarker,
      cadenceSeed,
      reads,
      resetUsage,
      snapshotMode,
    ) => {
      const result = await runChild({ cacheBody, sourceMarker });

      expect(result.arguments).toEqual([
        'internal', 'engine', '--mode', 'active', '--once',
      ]);
      expect(result.internalMarker).toBe('1');
      expect(result.cadenceSeed).toBe(cadenceSeed);
      expect(result.reads).toEqual(reads);
      expect(result.resetUsage).toEqual(resetUsage);
      expect(result.snapshotMode).toBe(snapshotMode);
      expect(result.githubCallsBeforeValidation).toBe(0);
    },
  );
});
