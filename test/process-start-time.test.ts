import { describe, expect, it } from 'vitest';
import {
  isProcessStartTimeReading,
  readProcessStartTime,
} from '../src/process-start-time.js';

describe('process start time (#161)', () => {
  it('reads one stable line for a live process and nothing for a PID that owns none', () => {
    const reading = readProcessStartTime(process.pid);
    expect(reading).not.toBeNull();
    expect(isProcessStartTimeReading(reading)).toBe(true);
    // The identity is only worth recording if it is the same on every read.
    expect(readProcessStartTime(process.pid)).toBe(reading);

    // Above every PID this platform hands out, so nothing is signalled here.
    expect(readProcessStartTime(2 ** 30)).toBeNull();
  });

  it('accepts only a single printable line as a recordable reading', () => {
    expect(isProcessStartTimeReading('Mon Jul 20 00:00:59 2026')).toBe(true);
    expect(isProcessStartTimeReading('')).toBe(false);
    expect(isProcessStartTimeReading('Mon Jul 20 00:00:59 2026\n')).toBe(false);
    expect(isProcessStartTimeReading('x'.repeat(65))).toBe(false);
    expect(isProcessStartTimeReading(42)).toBe(false);
    expect(isProcessStartTimeReading(null)).toBe(false);
  });
});
