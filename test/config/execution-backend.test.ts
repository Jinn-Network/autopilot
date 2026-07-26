import { describe, expect, it } from 'vitest';
import {
  parseAutopilotExecutionBackend,
} from '../../src/config/execution-backend.js';

describe('parseAutopilotExecutionBackend', () => {
  it.each([
    [undefined, 'local'],
    ['', 'local'],
    ['   ', 'local'],
    ['local', 'local'],
    ['marketplace', 'marketplace'],
  ] as const)('parses %j as %s', (raw, expected) => {
    expect(parseAutopilotExecutionBackend(raw)).toBe(expected);
  });

  it.each([
    [' local'],
    ['local '],
    [' marketplace '],
    ['LOCAL'],
    ['remote'],
  ])('rejects unsupported backend value %j', (raw) => {
    expect(() => parseAutopilotExecutionBackend(raw)).toThrow(
      `Unsupported JINN_AUTOPILOT_EXECUTION_BACKEND value: ${JSON.stringify(raw)}`,
    );
  });
});
