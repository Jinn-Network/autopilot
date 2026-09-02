import { describe, expect, it } from 'vitest';
import {
  LifecycleDiscoveryCacheCorruptError,
  LifecycleDiscoveryCacheUnsafePathError,
} from '../src/lifecycle/lifecycle-cache.js';
import {
  loadDaemonCadenceSeed,
  shouldRecordCycleHeartbeat,
} from '../scripts/run-autopilot-v2.js';

describe('cycle heartbeat arming', () => {
  it('arms only for the daemon-spawned active one-shot cycle child', () => {
    const marked = { JINN_AUTOPILOT_INTERNAL_DAEMON_ACTIVE_ONCE: '1' };

    expect(shouldRecordCycleHeartbeat({ mode: 'active', once: true }, marked))
      .toBe(true);
    for (const [context, environment] of [
      [{ mode: 'active', once: true }, {}],
      [
        { mode: 'active', once: true },
        { JINN_AUTOPILOT_INTERNAL_DAEMON_ACTIVE_ONCE: 'yes' },
      ],
      [{ mode: 'active', once: false }, marked],
      [{ mode: 'recover', once: true }, marked],
      [{ mode: 'observe', once: true }, marked],
    ] as const) {
      expect(shouldRecordCycleHeartbeat(context, environment)).toBe(false);
    }
  });
});

describe('daemon child reconciliation cadence', () => {
  it('does not resume cadence for generic active, recover, or observe startup', async () => {
    let reads = 0;
    const readSeed = async (): Promise<string> => {
      reads += 1;
      return '2026-07-22T10:00:00.000Z';
    };
    const marked = { JINN_AUTOPILOT_INTERNAL_DAEMON_ACTIVE_ONCE: '1' };

    await expect(loadDaemonCadenceSeed(
      { mode: 'active', once: true },
      marked,
      readSeed,
    )).resolves.toBe('2026-07-22T10:00:00.000Z');
    expect(reads).toBe(1);

    for (const [context, environment] of [
      [{ mode: 'active', once: true }, {}],
      [{ mode: 'active', once: false }, marked],
      [{ mode: 'recover', once: true }, marked],
      [{ mode: 'observe', once: true }, marked],
    ] as const) {
      await expect(loadDaemonCadenceSeed(context, environment, readSeed))
        .resolves.toBeNull();
    }
    expect(reads).toBe(1);
  });

  it('fails a corrupt daemon cadence cache closed to a startup full seed', async () => {
    await expect(loadDaemonCadenceSeed(
      { mode: 'active', once: true },
      { JINN_AUTOPILOT_INTERNAL_DAEMON_ACTIVE_ONCE: '1' },
      async () => {
        throw new LifecycleDiscoveryCacheCorruptError('invalid JSON');
      },
    )).resolves.toBeNull();
  });

  it('fails an unsafe daemon cadence cache path closed without trusting its marker', async () => {
    await expect(loadDaemonCadenceSeed(
      { mode: 'active', once: true },
      { JINN_AUTOPILOT_INTERNAL_DAEMON_ACTIVE_ONCE: '1' },
      async () => {
        throw new LifecycleDiscoveryCacheUnsafePathError('symlink cache file');
      },
    )).resolves.toBeNull();
  });

  it('does not hide unrelated cache read failures', async () => {
    await expect(loadDaemonCadenceSeed(
      { mode: 'active', once: true },
      { JINN_AUTOPILOT_INTERNAL_DAEMON_ACTIVE_ONCE: '1' },
      async () => {
        throw new Error('filesystem unavailable');
      },
    )).rejects.toThrow('filesystem unavailable');
  });
});
