import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

const OID = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RELAY_COMMAND = 'observe-issue-relay-delivery';

function distributionRoot(binaryPath: string): string {
  if (!isAbsolute(binaryPath)) {
    throw new Error('Issue Relay Jinn binary path must be absolute');
  }
  const root = resolve(dirname(binaryPath), '..');
  if (relative(root, binaryPath).split(sep).join('/') !== 'bin/jinn.js') {
    throw new Error(
      'Issue Relay Jinn binary must be the dist/bin/jinn.js entrypoint',
    );
  }
  return root;
}

function distributionFiles(root: string): readonly string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error('Issue Relay Jinn distribution contains a symlink');
      }
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push(relative(root, path).split(sep).join('/'));
      } else {
        throw new Error(
          'Issue Relay Jinn distribution contains a non-regular entry',
        );
      }
    }
  };
  visit(root);
  return files.sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0);
}

export function digestIssueRelayJinnDistribution(
  binaryPath: string,
): string {
  const root = distributionRoot(binaryPath);
  const hash = createHash('sha256');
  const files = distributionFiles(root);
  if (files.length === 0) {
    throw new Error('Issue Relay Jinn distribution is empty');
  }
  for (const path of files) {
    hash.update(path, 'utf8');
    hash.update('\0');
    hash.update(readFileSync(join(root, path)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function verifyIssueRelayJinnDistribution(input: {
  readonly binaryPath: string;
  readonly expectedCommit: string;
  readonly expectedDigest: string;
}): {
  readonly binaryPath: string;
  readonly distributionRoot: string;
  readonly digest: string;
} {
  if (!OID.test(input.expectedCommit)) {
    throw new Error('Issue Relay reviewed Jinn commit must be a full Git OID');
  }
  if (!SHA256.test(input.expectedDigest)) {
    throw new Error('Issue Relay reviewed Jinn distribution digest is invalid');
  }
  const root = distributionRoot(input.binaryPath);
  const binary = lstatSync(input.binaryPath);
  if (!binary.isFile() || (binary.mode & 0o111) === 0) {
    throw new Error('Issue Relay reviewed Jinn binary is not executable');
  }
  const metadataPath = join(root, 'build-meta.json');
  const metadataStat = lstatSync(metadataPath);
  if (!metadataStat.isFile()) {
    throw new Error('Issue Relay Jinn build metadata is not a regular file');
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error('Issue Relay Jinn build metadata is malformed', {
      cause: error,
    });
  }
  if (
    typeof metadata !== 'object'
    || metadata === null
    || !('commit' in metadata)
    || metadata.commit !== input.expectedCommit
  ) {
    throw new Error('Issue Relay Jinn build metadata commit is not reviewed');
  }
  for (const relativePath of [
    'cli/commands/tasks.js',
    'cli/commands/tasks-observe-issue-relay.js',
  ]) {
    const path = join(root, relativePath);
    const stat = lstatSync(path);
    if (
      !stat.isFile()
      || !readFileSync(path, 'utf8').includes(RELAY_COMMAND)
    ) {
      throw new Error(
        'Issue Relay Jinn distribution lacks the delivery observation command',
      );
    }
  }
  const digest = digestIssueRelayJinnDistribution(input.binaryPath);
  if (digest !== input.expectedDigest) {
    throw new Error('Issue Relay reviewed Jinn distribution digest changed');
  }
  return {
    binaryPath: input.binaryPath,
    distributionRoot: root,
    digest,
  };
}
