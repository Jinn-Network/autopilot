import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  allInfantLine,
  canaryLine,
  dispatchHalted,
  INFANT_CYCLES_TO_HALT,
  INFANT_STDERR_CHARS,
  infantDeathsLaneReason,
  readWorkerInfancy,
  recordWorkerCycle,
  stderrExcerpt,
  WORKER_INFANCY_FILE,
  WORKER_INFANT_DEATH_MS,
  WorkerInfancyWatch,
  workersSummaryLine,
} from '../../src/lifecycle/worker-infancy.js';

/** Verbatim shape of the exits the 2026-09-12 fleet logged (#186). */
const DEAD_SOCKET_STDERR =
  'Error: connect ENOENT /tmp/cc-socks/51448.sock\n    at PipeConnectWrap.afterConnect\n';

function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'worker-infancy-')), WORKER_INFANCY_FILE);
}

describe('worker infancy (#186)', () => {
  it('pins the thresholds as literals', () => {
    expect(WORKER_INFANT_DEATH_MS).toBe(30_000);
    expect(INFANT_CYCLES_TO_HALT).toBe(3);
    expect(INFANT_STDERR_CHARS).toBe(200);
    expect(WORKER_INFANCY_FILE).toBe('worker-infancy.json');
  });

  describe('the streak across cycles', () => {
    const allInfant = { dispatched: 3, infantDeaths: 3, lastStderr: 'connect ENOENT' };

    it('reads a missing or malformed file as no streak', () => {
      const path = statePath();
      expect(readWorkerInfancy(path)).toEqual({ version: 1, consecutiveAllInfantCycles: 0 });
      writeFileSync(path, '{not json');
      expect(readWorkerInfancy(path)).toEqual({ version: 1, consecutiveAllInfantCycles: 0 });
    });

    it('halts after three consecutive all-infant cycles, persisted between engine processes', () => {
      const path = statePath();

      expect(dispatchHalted(recordWorkerCycle(path, allInfant))).toBe(false);
      expect(dispatchHalted(recordWorkerCycle(path, allInfant))).toBe(false);
      const halted = recordWorkerCycle(path, allInfant);

      expect(halted).toMatchObject({ consecutiveAllInfantCycles: 3, lastStderr: 'connect ENOENT' });
      expect(dispatchHalted(halted)).toBe(true);
      expect(readWorkerInfancy(path)).toEqual(halted);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 1 });
    });

    it('resets on one worker that survived', () => {
      const path = statePath();
      recordWorkerCycle(path, allInfant);
      recordWorkerCycle(path, allInfant);

      const reset = recordWorkerCycle(path, { dispatched: 2, infantDeaths: 1 });

      expect(reset).toEqual({ version: 1, consecutiveAllInfantCycles: 0 });
      expect(dispatchHalted(reset)).toBe(false);
    });

    /**
     * #188: while halted the controller dispatches one canary per cycle. It
     * is an ordinary dispatch to the streak — one survivor ends it, one
     * infant extends it — so the halt clears exactly when a worker lives.
     */
    it('clears the halt on a surviving canary and keeps it on a dying one', () => {
      const path = statePath();
      recordWorkerCycle(path, allInfant);
      recordWorkerCycle(path, allInfant);
      recordWorkerCycle(path, allInfant);

      const died = recordWorkerCycle(path, { dispatched: 1, infantDeaths: 1, lastStderr: 'session limit' });
      expect(died).toEqual({ version: 1, consecutiveAllInfantCycles: 4, lastStderr: 'session limit' });
      expect(dispatchHalted(died)).toBe(true);

      const survived = recordWorkerCycle(path, { dispatched: 1, infantDeaths: 0 });
      expect(survived).toEqual({ version: 1, consecutiveAllInfantCycles: 0 });
      expect(dispatchHalted(survived)).toBe(false);
    });

    it('leaves the streak alone on a cycle that dispatched nothing', () => {
      const path = statePath();
      recordWorkerCycle(path, allInfant);

      expect(recordWorkerCycle(path, { dispatched: 0, infantDeaths: 0 }))
        .toMatchObject({ consecutiveAllInfantCycles: 1 });
    });
  });

  describe('the watch over one cycle\'s dispatches', () => {
    /** A clock the test moves by hand; a sleep that moves it. */
    function clock() {
      let at = 1_000_000;
      const waits: number[] = [];
      return {
        now: () => at,
        sleep: async (ms: number) => { waits.push(ms); at += ms; },
        waits,
        elapse: (ms: number) => { at = 1_000_000 + ms; },
      };
    }

    it('counts a non-zero exit inside 30s as an infant death, and nothing else', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'worker-infancy-watch-'));
      const infantLog = join(dir, 'a.log');
      writeFileSync(infantLog, `\n===== active dispatch t pid=pending =====\n${DEAD_SOCKET_STDERR}`);
      const c = clock();
      const watch = new WorkerInfancyWatch({ now: c.now, sleep: c.sleep });

      const a = watch.dispatched(infantLog);
      const b = watch.dispatched(join(dir, 'b.log'));
      const d = watch.dispatched(join(dir, 'd.log'));
      const e = watch.dispatched(join(dir, 'e.log'));
      c.elapse(1_000);
      a(1, null);              // dead in 1s: infant
      b(0, null);              // clean exit: not
      d(null, 'SIGTERM');      // a signal: not
      c.elapse(40_000);
      e(1, null);              // dead, but after 40s: not

      expect(await watch.settle()).toEqual({
        dispatched: 4,
        infantDeaths: 1,
        lastStderr: 'Error: connect ENOENT /tmp/cc-socks/51448.sock at PipeConnectWrap.afterConnect',
      });
    });

    it('waits for the youngest dispatch to outlive infancy before summarising, then drains', async () => {
      const c = clock();
      const watch = new WorkerInfancyWatch({ now: c.now, sleep: c.sleep });
      watch.dispatched(undefined);
      c.elapse(5_000);
      watch.dispatched(undefined);

      const summary = await watch.settle();

      // 25s to the first's deadline, then 5s more to the second's.
      expect(c.waits).toEqual([25_000, 5_000]);
      expect(summary).toEqual({ dispatched: 2, infantDeaths: 0 });
      expect(await watch.settle()).toEqual({ dispatched: 0, infantDeaths: 0 });
      expect(c.waits).toEqual([25_000, 5_000]);
    });

    it('stops waiting once every dispatch has exited', async () => {
      const c = clock();
      const watch = new WorkerInfancyWatch({ now: c.now, sleep: c.sleep });
      const exit = watch.dispatched(undefined);
      exit(1, null);

      expect(await watch.settle()).toEqual({ dispatched: 1, infantDeaths: 1 });
      expect(c.waits).toEqual([]);
    });
  });

  describe('the stderr excerpt', () => {
    it('quotes the first 200 chars after the latest dispatch header, whitespace collapsed', () => {
      const dir = mkdtempSync(join(tmpdir(), 'worker-infancy-log-'));
      const log = join(dir, 'session.log');
      writeFileSync(log, [
        '',
        '===== active dispatch 2026-09-12T20:21:00.000Z pid=pending =====',
        'old output from an earlier dispatch',
        '',
        '===== active dispatch 2026-09-12T20:31:00.000Z pid=pending =====',
        `x${'y'.repeat(300)}`,
        '',
      ].join('\n'));

      const excerpt = stderrExcerpt(log)!;
      expect(excerpt.startsWith('xyyy')).toBe(true);
      expect(excerpt).toHaveLength(INFANT_STDERR_CHARS + 1);
      expect(excerpt.endsWith('…')).toBe(true);
      expect(excerpt).not.toContain('old output');
    });

    it('reads nothing from a missing log, or one holding only the header', () => {
      const dir = mkdtempSync(join(tmpdir(), 'worker-infancy-log-'));
      expect(stderrExcerpt(join(dir, 'absent.log'))).toBeUndefined();
      const log = join(dir, 'header.log');
      writeFileSync(log, '\n===== active dispatch t pid=pending =====\n');
      expect(stderrExcerpt(log)).toBeUndefined();
    });
  });

  describe('the lines', () => {
    it('renders the summary, the all-infant line, and the lane reason', () => {
      expect(workersSummaryLine({ dispatched: 3, infantDeaths: 3 }))
        .toBe('workers: dispatched=3 infant-deaths=3 canary=none');
      expect(allInfantLine({ dispatched: 3, infantDeaths: 3, lastStderr: 'connect ENOENT' }))
        .toBe('[autopilot] every worker this cycle died within 30s; last stderr: connect ENOENT');
      expect(allInfantLine({ dispatched: 1, infantDeaths: 1 }))
        .toBe('[autopilot] every worker this cycle died within 30s; last stderr: none captured');
      expect(infantDeathsLaneReason({ version: 1, consecutiveAllInfantCycles: 3 }, 5))
        .toBe('3 consecutive cycle(s) of every worker dying within 30s; '
          + '5 candidate(s) withheld until a canary survives or the daemon is restarted');
    });

    it('names the canary on the summary and on its own line (#188)', () => {
      const survived = { session: 'implement-4188', survived: true } as const;
      const died = { session: 'review-4190', survived: false } as const;
      expect(workersSummaryLine({ dispatched: 1, infantDeaths: 0 }, survived))
        .toBe('workers: dispatched=1 infant-deaths=0 canary=survived');
      expect(workersSummaryLine({ dispatched: 1, infantDeaths: 1 }, died))
        .toBe('workers: dispatched=1 infant-deaths=1 canary=died');
      expect(canaryLine(survived, { dispatched: 1, infantDeaths: 0 }))
        .toBe('[autopilot] infant-death halt: canary implement-4188 survived; resuming dispatch');
      expect(canaryLine(died, {
        dispatched: 1,
        infantDeaths: 1,
        lastStderr: "You've hit your session limit",
      })).toBe(
        "[autopilot] infant-death halt: canary review-4190 died (You've hit your session limit); "
          + 'halt continues',
      );
      expect(canaryLine(died, { dispatched: 1, infantDeaths: 1 }))
        .toBe('[autopilot] infant-death halt: canary review-4190 died (no stderr captured); halt continues');
    });
  });
});
