import { describe, expect, it } from 'vitest';
import { parseIssueRelayConfig } from '../../src/issue-relay/config.js';

function validConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    repository: 'Jinn-Network/mono',
    label: 'engine:marketplace',
    relayBotLogin: 'jinn-relay',
    managedForkRepository: 'jinn-relay/mono',
    targetBase: 'main',
    solverNet: 'jinn-repo',
    verificationProfile: 'jinn-mono.v1',
    requiredChecks: ['test', 'typecheck'],
    pollSeconds: 30,
    budget: {
      maxGlobalActiveGenerations: 20,
      maxActivePerRepository: 10,
      maxActivePerAuthor: 2,
      maxRoundsPerGeneration: 5,
      maxGenerationSpendWei: '1000000000000000000',
      maxGlobalSpendWeiPerUtcDay: '5000000000000000000',
      generationDeadlineMs: 86_400_000,
    },
  };
}

describe('parseIssueRelayConfig', () => {
  it('decodes the exact secret-free public Jinn mono V0 profile', () => {
    expect(parseIssueRelayConfig(validConfig())).toEqual({
      ...validConfig(),
      budget: {
        ...(validConfig().budget as Record<string, unknown>),
        maxGenerationSpendWei: 1_000_000_000_000_000_000n,
        maxGlobalSpendWeiPerUtcDay: 5_000_000_000_000_000_000n,
      },
    });
  });

  it.each([
    ['repository', 'someone/example'],
    ['label', 'relay'],
    ['verificationProfile', 'other.v1'],
  ])('rejects a non-V0 %s', (key, value) => {
    expect(() => parseIssueRelayConfig({ ...validConfig(), [key]: value }))
      .toThrow(/config/i);
  });

  it.each([
    ['unsafe owner', 'other/mono'],
    ['target repository', 'Jinn-Network/mono'],
    ['path traversal', 'jinn-relay/../mono'],
    ['URL', 'https://github.com/jinn-relay/mono'],
  ])('rejects an unsafe managed fork: %s', (_label, managedForkRepository) => {
    expect(() => parseIssueRelayConfig({
      ...validConfig(),
      managedForkRepository,
    })).toThrow(/fork|config/i);
  });

  it.each([
    ['pollSeconds', 0],
    ['pollSeconds', Number.POSITIVE_INFINITY],
  ])('rejects invalid %s', (key, value) => {
    expect(() => parseIssueRelayConfig({ ...validConfig(), [key]: value }))
      .toThrow(/config/i);
  });

  it.each([
    ['maxGlobalActiveGenerations', 0],
    ['maxActivePerRepository', -1],
    ['maxActivePerAuthor', 1.5],
    ['maxRoundsPerGeneration', Number.POSITIVE_INFINITY],
    ['generationDeadlineMs', 0],
  ])('rejects invalid finite positive budget %s', (key, value) => {
    expect(() => parseIssueRelayConfig({
      ...validConfig(),
      budget: {
        ...(validConfig().budget as Record<string, unknown>),
        [key]: value,
      },
    })).toThrow(/config/i);
  });

  it.each([
    ['number', 100],
    ['negative', '-1'],
    ['leading zero', '01'],
    ['plus sign', '+1'],
    ['fraction', '1.0'],
    ['zero', '0'],
  ])('rejects non-canonical positive wei: %s', (_label, wei) => {
    expect(() => parseIssueRelayConfig({
      ...validConfig(),
      budget: {
        ...(validConfig().budget as Record<string, unknown>),
        maxGenerationSpendWei: wei,
      },
    })).toThrow(/config/i);
  });

  it('rejects duplicate and empty required check names', () => {
    expect(() => parseIssueRelayConfig({
      ...validConfig(),
      requiredChecks: ['test', 'Test'],
    })).toThrow(/config/i);
    expect(() => parseIssueRelayConfig({
      ...validConfig(),
      requiredChecks: [''],
    })).toThrow(/config/i);
  });

  it.each([
    ['top-level unknown key', { secret: 'do-not-store' }],
    ['GitHub token', { githubToken: 'ghp_secret' }],
    ['creator key', { creatorKey: 'wallet-secret' }],
  ])('rejects %s', (_label, extra) => {
    expect(() => parseIssueRelayConfig({ ...validConfig(), ...extra }))
      .toThrow(/config/i);
  });

  it('rejects unknown nested keys', () => {
    expect(() => parseIssueRelayConfig({
      ...validConfig(),
      budget: {
        ...(validConfig().budget as Record<string, unknown>),
        token: 'secret',
      },
    })).toThrow(/config/i);
  });
});
