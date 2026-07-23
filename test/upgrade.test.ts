import { describe, expect, it } from 'vitest';
import {
  upgradeAutopilot,
  type UpgradeDependencies,
} from '../src/upgrade.js';

function dependencies(calls: string[], failure?: string): UpgradeDependencies {
  return {
    installation: {
      kind: 'npm-global',
      packageRoot: '/global/lib/node_modules/@jinn-network/autopilot',
      executable: '/global/bin/autopilot',
      version: '0.1.0',
    },
    wasRunning: async () => true,
    stop: async () => { calls.push('stop'); },
    waitStopped: async () => { calls.push('wait-stopped'); },
    packCurrent: async () => {
      calls.push('pack-current');
      return '/rollback/jinn-network-autopilot-0.1.0.tgz';
    },
    install: async (specification) => {
      calls.push(`install:${specification}`);
    },
    migrate: async () => { calls.push('migrate'); },
    doctor: async () => {
      calls.push('doctor');
      if (failure === 'doctor' && calls.filter((call) => call === 'doctor').length === 1) {
        throw new Error('new doctor failed');
      }
    },
    start: async () => { calls.push('start'); },
  };
}

describe('npm-global upgrade safety', () => {
  it('quiesces, packs rollback material, verifies, and restarts on success', async () => {
    const calls: string[] = [];
    const result = await upgradeAutopilot('0.2.0', dependencies(calls));
    expect(result).toEqual({
      status: 'upgraded',
      fromVersion: '0.1.0',
      toVersion: '0.2.0',
      restarted: true,
    });
    expect(calls).toEqual([
      'stop',
      'wait-stopped',
      'pack-current',
      'install:@jinn-network/autopilot@0.2.0',
      'migrate',
      'doctor',
      'start',
    ]);
  });

  it('reinstalls and verifies the rollback tarball after failed doctor', async () => {
    const calls: string[] = [];
    await expect(upgradeAutopilot('0.2.0', dependencies(calls, 'doctor')))
      .rejects.toThrow(/rolled back/i);
    expect(calls).toEqual([
      'stop',
      'wait-stopped',
      'pack-current',
      'install:@jinn-network/autopilot@0.2.0',
      'migrate',
      'doctor',
      'install:/rollback/jinn-network-autopilot-0.1.0.tgz',
      'doctor',
      'start',
    ]);
  });

  it('refuses unsupported installation methods without mutation', async () => {
    const calls: string[] = [];
    const deps = dependencies(calls);
    deps.installation = {
      kind: 'unsupported',
      packageRoot: '/checkout/packages/autopilot',
      executable: '/checkout/bin/autopilot',
      version: '0.1.0',
    };
    await expect(upgradeAutopilot(undefined, deps)).rejects.toThrow(
      /npm install --global @jinn-network\/autopilot@latest/,
    );
    expect(calls).toEqual([]);
  });
});
