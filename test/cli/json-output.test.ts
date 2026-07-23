import { describe, expect, it } from 'vitest';
import { parseTrailingJson } from '../../src/cli/json-output.js';

describe('lifecycle JSON output', () => {
  it('parses a pretty-printed report after runtime diagnostics', () => {
    expect(parseTrailingJson([
      '[autopilot:v2] runtime=hermes',
      '{',
      '  "status": "ok",',
      '  "items": [',
      '    { "issueNumber": 2, "eligible": true }',
      '  ]',
      '}',
      '',
    ].join('\n'))).toEqual({
      status: 'ok',
      items: [{ issueNumber: 2, eligible: true }],
    });
  });

  it('rejects output without a trailing JSON object', () => {
    expect(() => parseTrailingJson('[autopilot:v2] runtime=hermes\n'))
      .toThrow('Lifecycle engine did not return a JSON report');
  });
});
