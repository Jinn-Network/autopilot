import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import fixture from './fixtures/non-jinn-autopilot-config.json';
import * as probeEntrypoint from '../scripts/probe-autopilot-v2-capabilities.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('capability probe script entrypoint', () => {
  it('loads the canonical publication URL from the target repository config', async () => {
    const repositoryRoot = mkdtempSync(
      join(tmpdir(), 'autopilot-capability-probe-entrypoint-'),
    );
    roots.push(repositoryRoot);
    mkdirSync(join(repositoryRoot, '.autopilot'), { recursive: true });
    writeFileSync(
      join(repositoryRoot, '.autopilot', 'config.json'),
      `${JSON.stringify(fixture)}\n`,
    );
    const resolveRepository = Reflect.get(
      probeEntrypoint,
      'resolveCapabilityProbeRepository',
    ) as ((
      repositoryRoot: string,
      environment: NodeJS.ProcessEnv,
    ) => Promise<{
      readonly repositoryPath: string;
      readonly repositoryUrl: string;
    }>) | undefined;

    expect(resolveRepository).toBeTypeOf('function');
    await expect(resolveRepository!(
      repositoryRoot,
      { AUTOPILOT_HOME: join(repositoryRoot, 'state') },
    )).resolves.toEqual({
      repositoryPath: repositoryRoot,
      repositoryUrl: fixture.repository.remote.url,
    });
  });
});
