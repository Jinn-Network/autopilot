import 'tsx/esm';
import { writeFile } from 'node:fs/promises';

const {
  LifecycleDiscoveryCacheStore,
} = await import('../../src/lifecycle/lifecycle-cache.ts');
const {
  LifecycleSnapshotCoordinator,
} = await import('../../src/lifecycle/runner-snapshot.ts');
const {
  loadDaemonCadenceSeed,
} = await import('../../scripts/run-autopilot-v2.ts');

const now = new Date(process.env.TEST_NOW);
const stateDirectory = process.env.TEST_STATE_DIRECTORY;
const resultPath = process.env.TEST_RESULT_PATH;
const sourceMarker = process.env.TEST_SOURCE_MARKER;
const arguments_ = process.argv.slice(2);
const modeIndex = arguments_.indexOf('--mode');
const mode = modeIndex < 0 ? undefined : arguments_[modeIndex + 1];
if (
  !Number.isFinite(now.getTime())
  || stateDirectory === undefined
  || resultPath === undefined
  || sourceMarker === undefined
  || arguments_[0] !== 'internal'
  || arguments_[1] !== 'engine'
  || (mode !== 'observe' && mode !== 'recover' && mode !== 'active')
) {
  throw new Error('daemon cadence child fixture environment is incomplete');
}

let cacheValidationAttempted = false;
let githubCallsBeforeValidation = 0;
const store = new LifecycleDiscoveryCacheStore({ stateDirectory });
const cadenceSeed = await loadDaemonCadenceSeed(
  { mode, once: arguments_.includes('--once') },
  process.env,
  async () => {
    try {
      return await store.readCadenceSeed();
    } finally {
      cacheValidationAttempted = true;
    }
  },
);

const reads = [];
const resetUsage = [];
const coordinator = new LifecycleSnapshotCoordinator({
  source: {
    async read(options) {
      if (!cacheValidationAttempted) githubCallsBeforeValidation += 1;
      reads.push(options.mode);
      resetUsage.push(options.resetUsage ?? null);
      const marker = options.mode === 'full' ? now.toISOString() : sourceMarker;
      return {
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
        diagnostics: [],
        lifecycle: { items: [] },
        capturedAt: now.toISOString(),
        snapshotMode: options.mode,
        snapshotComplete: true,
        lastFullReconciliationAt: marker,
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
      };
    },
  },
  configuredMode: 'incremental',
  fullReconcileMs: 60 * 60_000,
  startupFull: true,
  allowPartial: false,
  cadenceSeed,
  now: () => now,
});
const snapshot = await coordinator.read(500);

await writeFile(resultPath, JSON.stringify({
  arguments: arguments_,
  internalMarker: process.env.JINN_AUTOPILOT_INTERNAL_DAEMON_ACTIVE_ONCE,
  cadenceSeed,
  reads,
  resetUsage,
  snapshotMode: snapshot.snapshotMode,
  githubCallsBeforeValidation,
}));
