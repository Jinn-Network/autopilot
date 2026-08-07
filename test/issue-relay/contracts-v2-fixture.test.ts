import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IssueRelayEvaluationBundleV2Schema } from '../../src/issue-relay/contracts.js';

describe('Relay V2 Autopilot contract fixture', () => {
  it('parses the canonical Autopilot-owned fixture', () => {
    const localPath = fileURLToPath(new URL(
      '../fixtures/issue-relay-evaluation-bundle.v2.json',
      import.meta.url,
    ));
    const fixture = JSON.parse(readFileSync(localPath, 'utf8')) as unknown;
    expect(IssueRelayEvaluationBundleV2Schema.parse(fixture)).toEqual(fixture);
  });
});
