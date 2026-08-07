import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IssueRelayEvaluationBundleV2Schema } from '../../src/issue-relay/contracts.js';

describe('Relay V2 cross-repository contract fixture', () => {
  it('is byte-identical to the canonical published SDK fixture', () => {
    const localPath = fileURLToPath(new URL(
      '../fixtures/issue-relay-evaluation-bundle.v2.json',
      import.meta.url,
    ));
    const canonicalPath = createRequire(import.meta.url).resolve(
      '@jinn-network/sdk/fixtures/autopilot/issue-relay-evaluation-bundle.v2.json',
    );
    const local = readFileSync(localPath);
    const canonical = readFileSync(canonicalPath);
    expect(local.equals(canonical)).toBe(true);
    expect(IssueRelayEvaluationBundleV2Schema.parse(
      JSON.parse(local.toString('utf8')) as unknown,
    )).toEqual(JSON.parse(canonical.toString('utf8')));
  });
});
