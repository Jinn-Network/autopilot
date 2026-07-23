import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { AutopilotConfig } from './config/config.js';
import { packageRoot } from './package-paths.js';

export const MAINTAINER_SKILL_PACK_VERSION = '0.1.0';

type SkillHost = AutopilotConfig['maintainerSkills']['host'];

const HOST_DIRECTORIES: Record<SkillHost, string> = {
  claude: '.claude/skills',
  codex: '.codex/skills',
  cursor: '.cursor/skills',
};

export interface MaintainerSkillsLock {
  readonly schemaVersion: 1;
  readonly host: SkillHost;
  readonly version: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface MaintainerSkillsReport {
  readonly host: SkillHost;
  readonly version: string;
  readonly apply: boolean;
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
  readonly conflicts: readonly string[];
}

function hash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function sourceFiles(root: string): readonly string[] {
  const visit = (directory: string, prefix = ''): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const relativePath = prefix === '' ? entry.name : join(prefix, entry.name);
      return entry.isDirectory()
        ? visit(join(directory, entry.name), relativePath)
        : [relativePath];
    });
  return visit(root).sort();
}

function loadLock(path: string): MaintainerSkillsLock | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MaintainerSkillsLock>;
  if (
    parsed.schemaVersion !== 1
    || (parsed.host !== 'claude' && parsed.host !== 'codex' && parsed.host !== 'cursor')
    || typeof parsed.version !== 'string'
    || typeof parsed.files !== 'object'
    || parsed.files == null
  ) {
    throw new Error(`Invalid maintainer skill lock at ${path}`);
  }
  return parsed as MaintainerSkillsLock;
}

function atomicWrite(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode });
  renameSync(temporary, path);
}

export function updateMaintainerSkills(input: {
  readonly repositoryRoot: string;
  readonly config: AutopilotConfig;
  readonly apply: boolean;
  readonly force: boolean;
  readonly sourceRoot?: string;
}): MaintainerSkillsReport {
  const sourceRoot = input.sourceRoot
    ?? join(packageRoot(), 'assets', 'maintainer-skills');
  const host = input.config.maintainerSkills.host;
  const destinationRoot = join(input.repositoryRoot, HOST_DIRECTORIES[host]);
  const lockPath = join(input.repositoryRoot, '.autopilot', 'skills.lock.json');
  const previous = loadLock(lockPath);
  const desired = new Map<string, { content: Buffer; digest: string }>();
  for (const relativePath of sourceFiles(sourceRoot)) {
    const content = readFileSync(join(sourceRoot, relativePath));
    desired.set(relativePath, { content, digest: hash(content) });
  }

  const changed: string[] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];
  for (const [relativePath, target] of desired) {
    const destination = join(destinationRoot, relativePath);
    if (!existsSync(destination)) {
      changed.push(relativePath);
      continue;
    }
    const currentDigest = hash(readFileSync(destination));
    if (currentDigest === target.digest) {
      unchanged.push(relativePath);
      continue;
    }
    const priorDigest = previous?.host === host
      ? previous.files[relativePath]
      : undefined;
    if (priorDigest === undefined || currentDigest !== priorDigest) {
      conflicts.push(relativePath);
    } else {
      changed.push(relativePath);
    }
  }

  if (input.apply && (conflicts.length === 0 || input.force)) {
    for (const [relativePath, target] of desired) {
      const destination = join(destinationRoot, relativePath);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      atomicWrite(destination, target.content.toString('utf8'), 0o600);
    }
    const lock: MaintainerSkillsLock = {
      schemaVersion: 1,
      host,
      version: MAINTAINER_SKILL_PACK_VERSION,
      files: Object.fromEntries(
        [...desired].map(([relativePath, target]) => [
          relativePath,
          target.digest,
        ]),
      ),
    };
    atomicWrite(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 0o600);
  }

  return {
    host,
    version: MAINTAINER_SKILL_PACK_VERSION,
    apply: input.apply && (conflicts.length === 0 || input.force),
    changed,
    unchanged,
    conflicts,
  };
}

export function removeMaintainerSkillTemporary(path: string): void {
  rmSync(path, { force: true });
}
