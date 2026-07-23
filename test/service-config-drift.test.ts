import { describe, expect, it } from 'vitest';
import { shouldRunDaemonCycle } from '../src/service.js';

describe('daemon configuration immutability', () => {
  it('runs immediately and while the startup configuration hash is unchanged', () => {
    expect(shouldRunDaemonCycle({
      stopping: false,
      startupConfigHash: 'sha256:a',
      currentConfigHash: 'sha256:a',
    })).toEqual({ run: true });
  });

  it('pauses all new mutations after configuration drift', () => {
    expect(shouldRunDaemonCycle({
      stopping: false,
      startupConfigHash: 'sha256:a',
      currentConfigHash: 'sha256:b',
    })).toEqual({
      run: false,
      reason: 'config-drift',
    });
  });

  it('does not begin another controller boundary after a graceful stop', () => {
    expect(shouldRunDaemonCycle({
      stopping: true,
      startupConfigHash: 'sha256:a',
      currentConfigHash: 'sha256:a',
    })).toEqual({
      run: false,
      reason: 'stopping',
    });
  });
});
