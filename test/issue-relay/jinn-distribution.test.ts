import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  digestIssueRelayJinnDistribution,
  verifyIssueRelayJinnDistribution,
} from '../../src/issue-relay/jinn-distribution.js';

const directories: string[] = [];
const COMMIT = 'a'.repeat(40);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  readonly binaryPath: string;
  readonly commandPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'relay-jinn-dist-'));
  directories.push(root);
  const dist = join(root, 'dist');
  const binaryPath = join(dist, 'bin', 'jinn.js');
  const commandPath = join(
    dist,
    'cli',
    'commands',
    'tasks-observe-issue-relay.js',
  );
  await mkdir(join(dist, 'bin'), { recursive: true });
  await mkdir(join(dist, 'cli', 'commands'), { recursive: true });
  await writeFile(binaryPath, '#!/usr/bin/env node\nimport "../cli/index.js";\n');
  await chmod(binaryPath, 0o755);
  await writeFile(
    join(dist, 'build-meta.json'),
    `${JSON.stringify({ commit: COMMIT })}\n`,
  );
  await writeFile(
    join(dist, 'cli', 'commands', 'tasks.js'),
    'const command = "observe-issue-relay-delivery";\n',
  );
  await writeFile(
    commandPath,
    'const command = "observe-issue-relay-delivery";\n',
  );
  return { binaryPath, commandPath };
}

describe('reviewed Jinn client distribution pin', () => {
  it('binds the complete executable distribution, commit, and Relay command', async () => {
    const { binaryPath, commandPath } = await fixture();
    const digest = digestIssueRelayJinnDistribution(binaryPath);

    expect(verifyIssueRelayJinnDistribution({
      binaryPath,
      expectedCommit: COMMIT,
      expectedDigest: digest,
    })).toMatchObject({ binaryPath, digest });

    await writeFile(
      commandPath,
      'const command = "observe-issue-relay-delivery"; // tampered\n',
    );
    expect(() => verifyIssueRelayJinnDistribution({
      binaryPath,
      expectedCommit: COMMIT,
      expectedDigest: digest,
    })).toThrow(/digest changed/i);
  });

  it('rejects a missing capability, wrong commit, and symlinked distribution', async () => {
    const { binaryPath, commandPath } = await fixture();
    const digest = digestIssueRelayJinnDistribution(binaryPath);

    await writeFile(commandPath, 'const command = "other";\n');
    expect(() => verifyIssueRelayJinnDistribution({
      binaryPath,
      expectedCommit: COMMIT,
      expectedDigest: digest,
    })).toThrow(/lacks the delivery observation command/i);

    await writeFile(
      commandPath,
      'const command = "observe-issue-relay-delivery";\n',
    );
    expect(() => verifyIssueRelayJinnDistribution({
      binaryPath,
      expectedCommit: 'b'.repeat(40),
      expectedDigest: digestIssueRelayJinnDistribution(binaryPath),
    })).toThrow(/commit is not reviewed/i);

    const external = join(directories[0]!, 'external.js');
    await writeFile(external, 'external\n');
    await symlink(external, join(directories[0]!, 'dist', 'linked.js'));
    expect(() => digestIssueRelayJinnDistribution(binaryPath))
      .toThrow(/contains a symlink/i);
  });
});
