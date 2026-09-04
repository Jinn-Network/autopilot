import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CIRCUIT_OPEN_MS,
  INSTANT_EXIT_MS,
  INSTANT_FAILURE_WINDOW_MS,
  isInstantFailure,
  readRuntimeCircuit,
  recordRuntimeExit,
  type RuntimeExitObservation,
} from '../../src/lifecycle/runtime-circuit.js';

const T0 = Date.parse('2026-09-04T10:00:00.000Z');
const at = (ms: number): Date => new Date(T0 + ms);
const iso = (ms: number): string => at(ms).toISOString();

function circuitPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'jinn-circuit-')), 'state', 'runtime-circuit.json');
}

/** A claude child that died half a second after starting, non-zero. */
function instant(startMs: number): RuntimeExitObservation {
  return {
    runtime: 'claude',
    exitCode: 1,
    childStartedAt: iso(startMs),
    childExitedAt: iso(startMs + 500),
  };
}

describe('runtime circuit (#152)', () => {
  it('is closed when nothing has been recorded', () => {
    expect(readRuntimeCircuit(circuitPath(), at(0)))
      .toEqual({ preferCodex: false, recentInstantFailures: 0 });
  });

  it('classifies an instant failure by exit code and duration, never by guesswork', () => {
    expect(isInstantFailure(instant(0))).toBe(true);
    expect(isInstantFailure({ ...instant(0), exitCode: 0 })).toBe(false);
    expect(isInstantFailure({
      runtime: 'claude',
      exitCode: 1,
      childStartedAt: iso(0),
      childExitedAt: iso(INSTANT_EXIT_MS),
    })).toBe(false);
    expect(isInstantFailure({ runtime: 'claude', exitCode: 1 })).toBe(false);
  });

  it('opens after two instant failures inside the window, for the open period', () => {
    const path = circuitPath();
    const first = recordRuntimeExit(path, instant(0), at(1_000));
    expect(first).toMatchObject({ preferCodex: false, opened: false, recentInstantFailures: 1 });

    const second = recordRuntimeExit(path, instant(60_000), at(61_000));
    expect(second).toMatchObject({ preferCodex: true, opened: true, recentInstantFailures: 2 });
    expect(second.openUntil?.getTime()).toBe(T0 + 61_000 + CIRCUIT_OPEN_MS);

    expect(readRuntimeCircuit(path, at(61_000 + CIRCUIT_OPEN_MS - 1)).preferCodex).toBe(true);
    expect(readRuntimeCircuit(path, at(61_000 + CIRCUIT_OPEN_MS)).preferCodex).toBe(false);
  });

  it('does not count a failure that has fallen out of the window', () => {
    const path = circuitPath();
    recordRuntimeExit(path, instant(0), at(1_000));
    const later = recordRuntimeExit(
      path,
      instant(INSTANT_FAILURE_WINDOW_MS + 5_000),
      at(INSTANT_FAILURE_WINDOW_MS + 6_000),
    );
    expect(later).toMatchObject({ preferCodex: false, opened: false, recentInstantFailures: 1 });
  });

  it('closes on proof of service: a session that ran, or one that exited zero', () => {
    const path = circuitPath();
    recordRuntimeExit(path, instant(0), at(1_000));
    recordRuntimeExit(path, instant(1_000), at(2_000));
    expect(readRuntimeCircuit(path, at(3_000)).preferCodex).toBe(true);

    const ran = recordRuntimeExit(path, {
      runtime: 'claude',
      exitCode: 1,
      childStartedAt: iso(3_000),
      childExitedAt: iso(3_000 + INSTANT_EXIT_MS),
    }, at(4_000 + INSTANT_EXIT_MS));
    expect(ran).toMatchObject({ preferCodex: false, closed: true, recentInstantFailures: 0 });
  });

  it('ignores exits on every other runtime', () => {
    const path = circuitPath();
    recordRuntimeExit(path, instant(0), at(1_000));
    const codex = recordRuntimeExit(path, { ...instant(1_000), runtime: 'codex' }, at(2_000));
    expect(codex).toMatchObject({
      preferCodex: false,
      opened: false,
      closed: false,
      recentInstantFailures: 1,
    });
  });

  it('treats a malformed file as closed and overwrites it on the next record', () => {
    const path = circuitPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{not json');
    expect(readRuntimeCircuit(path, at(0)).preferCodex).toBe(false);
    recordRuntimeExit(path, instant(0), at(1_000));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 1 });
  });
});
