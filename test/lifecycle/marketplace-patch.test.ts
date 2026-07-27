import { execFile, spawn } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyMarketplacePatchToWorktree,
  MAX_MARKETPLACE_PATCH_BYTES,
  MarketplacePatchPolicyError,
  runMarketplacePatchGit,
  type MarketplaceAttemptWorktreeProof,
  type MarketplaceAttemptWorktreeProofPort,
  type MarketplacePatchGitRunner,
  validateMarketplacePatch,
} from '../../src/lifecycle/marketplace-patch.js';
import { gitOid, type GitOid } from '../../src/lifecycle/types.js';

const encoder = new TextEncoder();
const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function ordinaryPatch(path = 'src/value.ts'): Uint8Array {
  return bytes([
    `diff --git a/${path} b/${path}`,
    'index 7898192..422c2b7 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n'));
}

function patchLines(lines: readonly string[]): Uint8Array {
  return bytes([...lines, ''].join('\n'));
}

function expectPolicyReason(artifact: Uint8Array, reason: MarketplacePatchPolicyError['reason']): void {
  try {
    validateMarketplacePatch(artifact);
    throw new Error('Expected marketplace patch rejection');
  } catch (error) {
    expect(error).toMatchObject({
      name: 'MarketplacePatchPolicyError',
      reason,
    });
  }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...args], { cwd, encoding: 'utf8' });
  return result.stdout;
}

function gitWithInput(
  cwd: string,
  args: readonly string[],
  input: Uint8Array | undefined,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Uint8Array.from(Buffer.concat(stdout)));
      else reject(new Error(Buffer.concat(stderr).toString('utf8')));
    });
    child.stdin.end(input === undefined ? undefined : Buffer.from(input));
  });
}

interface RepositoryFixture {
  readonly root: string;
  readonly worktreePath: string;
  readonly manifestPath: string;
  readonly head: GitOid;
}

async function repositoryFixture(): Promise<RepositoryFixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autopilot-marketplace-patch-')));
  roots.push(root);
  const worktreePath = join(root, 'repo');
  mkdirSync(worktreePath);
  await git(worktreePath, ['init']);
  await git(worktreePath, ['config', 'user.name', 'Jinn Test']);
  await git(worktreePath, ['config', 'user.email', 'jinn@example.test']);
  mkdirSync(join(worktreePath, 'src'));
  writeFileSync(join(worktreePath, 'src/value.ts'), 'old\n');
  writeFileSync(join(worktreePath, '.gitignore'), 'generated/\n');
  await git(worktreePath, ['add', '.gitignore', 'src/value.ts']);
  await git(worktreePath, ['commit', '-m', 'base']);
  const head = gitOid((await git(worktreePath, ['rev-parse', 'HEAD'])).trim());
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify({ registeredWorktreePath: worktreePath })}\n`);
  return { root, worktreePath, manifestPath, head };
}

function proof(overrides: Partial<MarketplaceAttemptWorktreeProof> = {}): MarketplaceAttemptWorktreeProofPort {
  return {
    async prove(input) {
      return {
        manifestPath: input.manifestPath,
        registeredWorktreePath: input.worktreePath,
        expectedHead: input.expectedHead,
        currentHead: input.expectedHead,
        indexClean: true,
        worktreeClean: true,
        untrackedPaths: [],
        ...overrides,
      } as MarketplaceAttemptWorktreeProof;
    },
  };
}

function applicationInput(fixture: RepositoryFixture, artifact = ordinaryPatch()) {
  return {
    artifact,
    manifestPath: fixture.manifestPath,
    worktreePath: fixture.worktreePath,
    expectedHead: fixture.head,
  };
}

describe('marketplace patch validation', () => {
  it('rejects an artifact one byte above the byte limit', () => {
    const artifact = new Uint8Array(MAX_MARKETPLACE_PATCH_BYTES + 1);

    expect(() => validateMarketplacePatch(artifact)).toThrowError(
      expect.objectContaining<Partial<MarketplacePatchPolicyError>>({
        name: 'MarketplacePatchPolicyError',
        reason: 'artifact-too-large',
      }),
    );
  });

  it('accepts an ordinary patch and reports its byte identity and touched path', () => {
    const artifact = ordinaryPatch();
    const result = validateMarketplacePatch(artifact);

    expect(result).toMatchObject({
      byteLength: 131,
      artifactDigest: 'sha256:d4d30ac1c78a621963a23ada7d68180fcfe7551cbb23668e4b3a301f7576a8a3',
      touchedPaths: ['src/value.ts'],
    });
    expect(result.artifact).toEqual(artifact);
    expect(result.artifact).not.toBe(artifact);
  });

  it('counts a multibyte UTF-8 path by bytes and detaches the result from the caller', () => {
    const artifact = ordinaryPatch('src/café.ts');
    const original = Uint8Array.from(artifact);
    const result = validateMarketplacePatch(artifact);
    artifact.fill(0x78);

    expect(result.byteLength).toBe(131);
    expect(result.touchedPaths).toEqual(['src/café.ts']);
    expect(result.artifact).toEqual(original);
    expect(result.artifactDigest).toBe(
      'sha256:55d82ae87d1fff94b9ff5b86b3ee4cc4248f69245d1f0c8d3d53fbdf7bb27f7f',
    );
  });

  it.each([
    ['one byte below', MAX_MARKETPLACE_PATCH_BYTES - 1],
    ['exactly at', MAX_MARKETPLACE_PATCH_BYTES],
  ])('accepts an artifact %s the byte limit', (_label, byteLength) => {
    const prefix = ordinaryPatch();
    const artifact = new Uint8Array(byteLength);
    artifact.set(prefix);
    artifact.fill(0x0a, prefix.byteLength);

    expect(validateMarketplacePatch(artifact).byteLength).toBe(byteLength);
  });

  it('rejects invalid UTF-8', () => {
    expectPolicyReason(Uint8Array.of(0xff), 'invalid-utf8');
  });

  it('rejects a NUL byte', () => {
    const artifact = ordinaryPatch();
    artifact[artifact.byteLength - 1] = 0;
    expectPolicyReason(artifact, 'nul-byte');
  });

  it.each([
    ['GIT binary patch', 'GIT binary patch'],
    ['Binary files', 'Binary files a/image.png and b/image.png differ'],
  ])('rejects the %s binary surface', (_label, marker) => {
    expectPolicyReason(patchLines([
      'diff --git a/image.png b/image.png',
      'new file mode 100644',
      'index 0000000..1234567',
      marker,
    ]), 'binary-diff');
  });

  it.each([
    ['diff --cc', 'diff --cc src/value.ts'],
    ['diff --combined', 'diff --combined src/value.ts'],
    ['combined hunk', '@@@ -1,1 -1,1 +1,1 @@@'],
  ])('rejects the %s combined-diff surface', (_label, marker) => {
    expectPolicyReason(patchLines([
      marker,
      '--- a/src/value.ts',
      '+++ b/src/value.ts',
    ]), 'combined-diff');
  });

  it.each([
    ['addition', patchLines([
      'diff --git a/src/added.ts b/src/added.ts',
      'new file mode 100644',
      'index 0000000..1234567',
      '--- /dev/null',
      '+++ b/src/added.ts',
      '@@ -0,0 +1 @@',
      '+added',
    ]), ['src/added.ts']],
    ['deletion', patchLines([
      'diff --git a/src/deleted.ts b/src/deleted.ts',
      'deleted file mode 100644',
      'index 1234567..0000000',
      '--- a/src/deleted.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-deleted',
    ]), ['src/deleted.ts']],
    ['rename', patchLines([
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 100%',
      'rename from src/old.ts',
      'rename to src/new.ts',
    ]), ['src/new.ts', 'src/old.ts']],
    ['copy', patchLines([
      'diff --git a/src/source.ts b/src/copy.ts',
      'similarity index 100%',
      'copy from src/source.ts',
      'copy to src/copy.ts',
    ]), ['src/copy.ts', 'src/source.ts']],
    ['mode-only', patchLines([
      'diff --git a/src/script.ts b/src/script.ts',
      'old mode 100644',
      'new mode 100755',
    ]), ['src/script.ts']],
  ])('accepts an ordinary %s patch', (_label, artifact, touchedPaths) => {
    expect(validateMarketplacePatch(artifact).touchedPaths).toEqual(touchedPaths);
  });

  it('does not strip repository components from rename and copy metadata paths', () => {
    const artifact = patchLines([
      'diff --git a/a/old.ts b/b/new.ts',
      'similarity index 100%',
      'rename from a/old.ts',
      'rename to b/new.ts',
    ]);

    expect(validateMarketplacePatch(artifact).touchedPaths).toEqual([
      'a/old.ts',
      'b/new.ts',
    ]);
  });

  it('parses Git-generated unquoted spaces in diff headers', () => {
    const artifact = patchLines([
      'diff --git a/src/Envelope Index.ts b/src/Envelope Index.ts',
      'index 7898192..422c2b7 100644',
      '--- a/src/Envelope Index.ts',
      '+++ b/src/Envelope Index.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ]);

    expect(validateMarketplacePatch(artifact).touchedPaths).toEqual([
      'src/Envelope Index.ts',
    ]);
  });

  it('disambiguates Git-generated unquoted paths containing an internal b/ component', () => {
    const artifact = patchLines([
      'diff --git a/src/a b/file.ts b/src/a b/file.ts',
      'index 7898192..422c2b7 100644',
      '--- a/src/a b/file.ts',
      '+++ b/src/a b/file.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ]);

    expect(validateMarketplacePatch(artifact).touchedPaths).toEqual([
      'src/a b/file.ts',
    ]);
  });

  it('rejects a literal tab in rename metadata instead of truncating the destination', () => {
    expectPolicyReason(patchLines([
      'diff --git a/src/value.ts b/src/safe.ts',
      'similarity index 100%',
      'rename from src/value.ts',
      'rename to src/safe.ts\t/tests/escaped.test.ts',
    ]), 'unsafe-path');
  });

  it.each([
    ['same-path rename', [
      'diff --git a/src/value.ts b/src/value.ts',
      'similarity index 100%',
      'rename from src/value.ts',
      'rename to src/value.ts',
    ]],
    ['lone old mode', [
      'diff --git a/src/value.ts b/src/value.ts',
      'old mode 100644',
    ]],
    ['same mode pair', [
      'diff --git a/src/value.ts b/src/value.ts',
      'old mode 100644',
      'new mode 100644',
    ]],
  ] as const)('rejects structurally valid-looking no-effect metadata: %s', (_label, lines) => {
    expectPolicyReason(patchLines(lines), 'malformed-patch');
  });

  it('rejects a replacement hunk whose removed and added bytes are identical', () => {
    expectPolicyReason(patchLines([
      'diff --git a/src/value.ts b/src/value.ts',
      'index 7898192..422c2b7 100644',
      '--- a/src/value.ts',
      '+++ b/src/value.ts',
      '@@ -1 +1 @@',
      '-same',
      '+same',
    ]), 'malformed-patch');
  });

  it.each([
    ['spaces', '"a/src/spaced file.ts"', '"b/src/spaced file.ts"', 'src/spaced file.ts'],
    ['octal UTF-8', '"a/src/caf\\303\\251.ts"', '"b/src/caf\\303\\251.ts"', 'src/café.ts'],
    ['escaped quote', '"a/src/say\\\"hi.ts"', '"b/src/say\\\"hi.ts"', 'src/say"hi.ts'],
  ])('decodes %s in quoted Git header paths', (_label, oldPath, newPath, touchedPath) => {
    const artifact = patchLines([
      `diff --git ${oldPath} ${newPath}`,
      'index 7898192..422c2b7 100644',
      `--- ${oldPath}`,
      `+++ ${newPath}`,
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ]);

    expect(validateMarketplacePatch(artifact).touchedPaths).toEqual([touchedPath]);
  });

  it.each([
    ['POSIX absolute', '/etc/passwd'],
    ['Windows backslash drive', 'C:\\temp\\owned.ts'],
    ['Windows slash drive', 'C:/temp/owned.ts'],
    ['UNC', '\\\\server\\share\\owned.ts'],
    ['slash traversal', 'src/../owned.ts'],
    ['backslash traversal', 'src\\..\\owned.ts'],
    ['backslash separator', 'src\\owned.ts'],
    ['empty segment', 'src//owned.ts'],
    ['dot segment', 'src/./owned.ts'],
    ['control character', 'src/bad\u0007.ts'],
    ['non-NFC', 'src/cafe\u0301.ts'],
  ])('rejects the %s path form', (_label, path) => {
    expectPolicyReason(patchLines([
      `diff --git "a/src/value.ts" "b/src/value.ts"`,
      'index 7898192..422c2b7 100644',
      `--- ${path}`,
      '+++ b/src/value.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ]), 'unsafe-path');
  });

  const gitPathSurfaceCases = [
    ['diff old', 'diff --git a/.GiT/config b/src/value.ts'],
    ['diff new', 'diff --git a/src/value.ts b/.gIt/config'],
    ['old header', '--- a/.GIT/config'],
    ['new header', '+++ b/.git/config'],
    ['rename from', 'rename from .Git/config'],
    ['rename to', 'rename to .gIT/config'],
    ['copy from', 'copy from .GIT/config'],
    ['copy to', 'copy to .git/config'],
  ] as const;

  it.each(gitPathSurfaceCases)('rejects case-insensitive .git on the %s surface', (surface, replacement) => {
    const lines = [
      'diff --git a/src/value.ts b/src/value.ts',
      'similarity index 100%',
      'rename from src/value.ts',
      'rename to src/other.ts',
      '--- a/src/value.ts',
      '+++ b/src/value.ts',
    ];
    const indexBySurface: Readonly<Record<typeof surface, number>> = {
      'diff old': 0,
      'diff new': 0,
      'old header': 4,
      'new header': 5,
      'rename from': 2,
      'rename to': 3,
      'copy from': 2,
      'copy to': 3,
    };
    lines[indexBySurface[surface]] = replacement;
    expectPolicyReason(patchLines(lines), 'unsafe-path');
  });

  it.each([
    ['old mode', 'old mode 120000'],
    ['new mode', 'new mode 160000'],
    ['new file mode', 'new file mode 120000'],
    ['deleted file mode', 'deleted file mode 160000'],
    ['index symlink mode', 'index 7898192..422c2b7 120000'],
    ['index gitlink mode', 'index 7898192..422c2b7 160000'],
  ])('rejects forbidden mode on the %s surface', (_label, modeLine) => {
    expectPolicyReason(patchLines([
      'diff --git a/src/value.ts b/src/value.ts',
      modeLine,
      '--- a/src/value.ts',
      '+++ b/src/value.ts',
    ]), 'forbidden-mode');
  });

  it.each([
    ['trailing space', 'new file mode 120000 '],
    ['double separator', 'new file mode  120000'],
    ['trailing tab', 'new file mode 120000\t'],
    ['leading octal zero', 'new file mode 0120000'],
    ['trailing data', 'new file mode 120000 junk'],
  ])('rejects Git-permissive noncanonical symlink mode with %s', (_label, modeLine) => {
    expectPolicyReason(patchLines([
      'diff --git a/src/link.ts b/src/link.ts',
      modeLine,
      '--- /dev/null',
      '+++ b/src/link.ts',
      '@@ -0,0 +1 @@',
      '+target',
    ]), 'forbidden-mode');
  });

  it.each([
    ['package manifest', 'packages/app/package.json'],
    ['npm lock', 'package-lock.json'],
    ['Yarn lock', 'yarn.lock'],
    ['pnpm lock', 'pnpm-lock.yaml'],
    ['Yarn metadata', '.yarn/install-state.gz'],
    ['Yarn config', '.yarnrc.yml'],
    ['PnP loader', '.pnp.cjs'],
    ['PnP data', '.pnp.data.json'],
    ['pnpm workspace manifest', 'pnpm-workspace.yaml'],
    ['node_modules', 'packages/app/node_modules/pkg/index.js'],
    ['tsconfig', 'packages/app/tsconfig.build.json'],
    ['Vitest config', 'vitest.config.ts'],
    ['Vite config', 'vite.config.ts'],
    ['Vitest workspace', 'vitest.workspace.ts'],
    ['Vitest projects', 'vitest.projects.ts'],
    ['Jest config', 'jest.config.js'],
    ['generic test config', 'test.config.ts'],
    ['test directory', 'test/lifecycle/new-policy.ts'],
    ['tests directory', 'src/tests/new-policy.ts'],
    ['__tests__ directory', 'src/__tests__/new-policy.ts'],
    ['test file', 'src/value.test.ts'],
    ['spec file', 'src/value.spec.ts'],
    ['snapshot file', 'src/value.snap'],
    ['snapshot directory', 'src/__snapshots__/value.ts.snap'],
    ['snapshots directory', 'src/snapshots/value.json'],
  ])('rejects the %s verification-control surface', (_label, path) => {
    expectPolicyReason(ordinaryPatch(path), 'verification-control');
  });

  it('rejects a traditional second file diff appended after a completed Git hunk', () => {
    const artifact = bytes([
      new TextDecoder().decode(ordinaryPatch()).trimEnd(),
      '--- /dev/null',
      '+++ b/tests/escaped-policy.test.ts',
      '@@ -0,0 +1 @@',
      '+escaped',
      '',
    ].join('\n'));

    expectPolicyReason(artifact, 'malformed-patch');
  });
});

describe('marketplace patch worktree application', () => {
  it('terminates the real bounded Git runner at its timeout', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'autopilot-marketplace-git-runner-')));
    roots.push(root);
    const fakeGit = join(root, 'git');
    writeFileSync(fakeGit, '#!/bin/sh\nwhile :; do :; done\n');
    chmodSync(fakeGit, 0o755);
    const priorPath = process.env.PATH;
    process.env.PATH = `${root}:${priorPath ?? ''}`;
    try {
      await expect(runMarketplacePatchGit(['version'], {
        cwd: root,
        timeoutMs: 100,
        outputLimitBytes: 64,
      })).rejects.toMatchObject({ reason: 'git-timeout' });
    } finally {
      process.env.PATH = priorPath;
    }
  });

  it('terminates the real bounded Git runner when combined output exceeds its cap', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'autopilot-marketplace-git-runner-')));
    roots.push(root);
    const fakeGit = join(root, 'git');
    writeFileSync(fakeGit, [
      '#!/bin/sh',
      'i=0',
      'while [ "$i" -lt 100 ]; do',
      '  printf x',
      '  i=$((i + 1))',
      'done',
      '',
    ].join('\n'));
    chmodSync(fakeGit, 0o755);
    const priorPath = process.env.PATH;
    process.env.PATH = `${root}:${priorPath ?? ''}`;
    try {
      await expect(runMarketplacePatchGit(['version'], {
        cwd: root,
        timeoutMs: 5_000,
        outputLimitBytes: 64,
      })).rejects.toMatchObject({ reason: 'git-output-limit' });
    } finally {
      process.env.PATH = priorPath;
    }
  });

  it('rejects a no-effect diff before authority or Git', async () => {
    const fixture = await repositoryFixture();
    const runGit = vi.fn<MarketplacePatchGitRunner>();
    const worktreeProof = { prove: vi.fn(proof().prove) };

    await expect(applyMarketplacePatchToWorktree(
      applicationInput(fixture, patchLines(['diff --git a/src/value.ts b/src/value.ts'])),
      { worktreeProof, runGit },
    )).rejects.toMatchObject({ reason: 'malformed-patch' });

    expect(worktreeProof.prove).not.toHaveBeenCalled();
    expect(runGit).not.toHaveBeenCalled();
  });

  it.each([
    ['oversize', new Uint8Array(MAX_MARKETPLACE_PATCH_BYTES + 1), 'artifact-too-large'],
    ['invalid UTF-8', Uint8Array.of(0xff), 'invalid-utf8'],
    ['NUL', Uint8Array.of(0), 'nul-byte'],
    ['binary', patchLines(['diff --git a/a.png b/a.png', 'GIT binary patch']), 'binary-diff'],
    ['combined', patchLines(['diff --cc src/value.ts']), 'combined-diff'],
    ['unsafe path', ordinaryPatch('../escape.ts'), 'unsafe-path'],
    ['forbidden mode', patchLines([
      'diff --git a/src/value.ts b/src/value.ts',
      'old mode 120000',
      'new mode 100644',
    ]), 'forbidden-mode'],
    ['verification control', ordinaryPatch('package.json'), 'verification-control'],
  ] as const)('rejects an %s artifact before authority or Git', async (_label, artifact, reason) => {
    const fixture = await repositoryFixture();
    const runGit = vi.fn<MarketplacePatchGitRunner>();
    const worktreeProof = { prove: vi.fn(proof().prove) };

    await expect(applyMarketplacePatchToWorktree(
      applicationInput(fixture, artifact),
      { worktreeProof, runGit },
    )).rejects.toMatchObject({ name: 'MarketplacePatchPolicyError', reason });

    expect(worktreeProof.prove).not.toHaveBeenCalled();
    expect(runGit).not.toHaveBeenCalled();
  });

  it.each([
    ['manifest path', { manifestPath: '/different/manifest.json' }],
    ['registered worktree', { registeredWorktreePath: '/different/worktree' }],
    ['expected start head', { expectedHead: gitOid('1'.repeat(40)) }],
    ['current HEAD', { currentHead: gitOid('2'.repeat(40)) }],
    ['dirty index', { indexClean: false }],
    ['tracked worktree modification', { worktreeClean: false }],
    ['untracked path', { untrackedPaths: ['untracked.ts'] }],
  ] as const)('rejects a mismatched %s proof before any Git command', async (_label, overrides) => {
    const fixture = await repositoryFixture();
    const runGit = vi.fn<MarketplacePatchGitRunner>();

    await expect(applyMarketplacePatchToWorktree(
      applicationInput(fixture),
      { worktreeProof: proof(overrides as Partial<MarketplaceAttemptWorktreeProof>), runGit },
    )).rejects.toMatchObject({
      name: 'MarketplacePatchPolicyError',
      reason: 'authority-mismatch',
    });

    expect(runGit).not.toHaveBeenCalled();
    expect(readFileSync(join(fixture.worktreePath, 'src/value.ts'), 'utf8')).toBe('old\n');
  });

  it('propagates an unregistered-worktree authority rejection before any Git command', async () => {
    const fixture = await repositoryFixture();
    const runGit = vi.fn<MarketplacePatchGitRunner>();
    const worktreeProof: MarketplaceAttemptWorktreeProofPort = {
      async prove() {
        throw new MarketplacePatchPolicyError(
          'authority-mismatch',
          'Attempt worktree is not registered',
        );
      },
    };

    await expect(applyMarketplacePatchToWorktree(
      applicationInput(fixture),
      { worktreeProof, runGit },
    )).rejects.toMatchObject({ reason: 'authority-mismatch' });
    expect(runGit).not.toHaveBeenCalled();
  });

  it('rejects an ignored untracked symlink at a touched path', async () => {
    const fixture = await repositoryFixture();
    mkdirSync(join(fixture.worktreePath, 'generated'));
    symlinkSync(join(fixture.root, 'outside.ts'), join(fixture.worktreePath, 'generated/link.ts'));

    await expect(applyMarketplacePatchToWorktree(
      applicationInput(fixture, ordinaryPatch('generated/link.ts')),
      { worktreeProof: proof() },
    )).rejects.toMatchObject({ reason: 'unsafe-filesystem-entry' });
  });

  it('rejects an ignored untracked symlink ancestor of a touched path', async () => {
    const fixture = await repositoryFixture();
    mkdirSync(join(fixture.root, 'outside'));
    symlinkSync(join(fixture.root, 'outside'), join(fixture.worktreePath, 'generated'));

    await expect(applyMarketplacePatchToWorktree(
      applicationInput(fixture, ordinaryPatch('generated/child.ts')),
      { worktreeProof: proof() },
    )).rejects.toMatchObject({ reason: 'unsafe-filesystem-entry' });
  });

  it.each([
    ['target', 'tracked-link'],
    ['ancestor', 'tracked-link/child.ts'],
  ])('rejects a tracked 120000 symlink %s from the index', async (_label, touchedPath) => {
    const fixture = await repositoryFixture();
    symlinkSync('src/value.ts', join(fixture.worktreePath, 'tracked-link'));
    await git(fixture.worktreePath, ['add', 'tracked-link']);
    await git(fixture.worktreePath, ['commit', '-m', 'track symlink']);
    const head = gitOid((await git(fixture.worktreePath, ['rev-parse', 'HEAD'])).trim());

    await expect(applyMarketplacePatchToWorktree(
      { ...applicationInput(fixture, ordinaryPatch(touchedPath)), expectedHead: head },
      { worktreeProof: proof() },
    )).rejects.toMatchObject({ reason: 'unsafe-index-entry' });
  });

  it.each([
    ['target', 'vendor'],
    ['ancestor', 'vendor/child.ts'],
    ['case-folded ancestor', 'Vendor/child.ts'],
  ])('rejects a tracked 160000 gitlink %s from the index', async (_label, touchedPath) => {
    const fixture = await repositoryFixture();
    const vendor = join(fixture.worktreePath, 'vendor');
    mkdirSync(vendor);
    await git(vendor, ['init']);
    await git(vendor, ['config', 'user.name', 'Jinn Test']);
    await git(vendor, ['config', 'user.email', 'jinn@example.test']);
    writeFileSync(join(vendor, 'child.ts'), 'old\n');
    await git(vendor, ['add', 'child.ts']);
    await git(vendor, ['commit', '-m', 'vendor base']);
    await git(fixture.worktreePath, ['add', 'vendor']);
    await git(fixture.worktreePath, ['commit', '-m', 'track gitlink']);
    const head = gitOid((await git(fixture.worktreePath, ['rev-parse', 'HEAD'])).trim());

    await expect(applyMarketplacePatchToWorktree(
      { ...applicationInput(fixture, ordinaryPatch(touchedPath)), expectedHead: head },
      { worktreeProof: proof() },
    )).rejects.toMatchObject({ reason: 'unsafe-index-entry' });
  });

  it('allows regular file and directory ancestors, checks, then applies through stdin', async () => {
    const fixture = await repositoryFixture();
    const calls: Array<{ readonly args: readonly string[]; readonly stdin?: Uint8Array }> = [];
    const runGit: MarketplacePatchGitRunner = async (args, options) => {
      calls.push({ args, stdin: options.stdin === undefined ? undefined : Uint8Array.from(options.stdin) });
      return gitWithInput(options.cwd, args, options.stdin);
    };
    const artifact = ordinaryPatch();

    const result = await applyMarketplacePatchToWorktree(
      applicationInput(fixture, artifact),
      { worktreeProof: proof(), runGit },
    );

    expect(calls.map((call) => call.args)).toEqual([
      ['--literal-pathspecs', 'ls-files', '--stage', '-z'],
      ['apply', '--check'],
      ['apply'],
    ]);
    expect(calls[1]!.stdin).toEqual(artifact);
    expect(calls[2]!.stdin).toEqual(artifact);
    expect(calls.flatMap((call) => call.args)).not.toContain('--3way');
    expect(readFileSync(join(fixture.worktreePath, 'src/value.ts'), 'utf8')).toBe('new\n');
    expect(result.touchedPaths).toEqual(['src/value.ts']);
  });

  it('does not apply or mutate when git apply --check fails', async () => {
    const fixture = await repositoryFixture();
    writeFileSync(join(fixture.worktreePath, 'src/value.ts'), 'does not match\n');

    await expect(applyMarketplacePatchToWorktree(
      applicationInput(fixture),
      { worktreeProof: proof() },
    )).rejects.toMatchObject({ reason: 'git-check-failed' });

    expect(readFileSync(join(fixture.worktreePath, 'src/value.ts'), 'utf8')).toBe('does not match\n');
  });

  it('passes fixed timeout and output bounds to every Git command', async () => {
    const fixture = await repositoryFixture();
    const limits: Array<{ readonly timeoutMs: number; readonly outputLimitBytes: number }> = [];
    const runGit: MarketplacePatchGitRunner = async (args, options) => {
      limits.push({ timeoutMs: options.timeoutMs, outputLimitBytes: options.outputLimitBytes });
      if (args.includes('ls-files')) return new Uint8Array();
      return new Uint8Array();
    };

    await applyMarketplacePatchToWorktree(
      applicationInput(fixture),
      { worktreeProof: proof(), runGit },
    );

    expect(limits).toEqual([
      { timeoutMs: 30_000, outputLimitBytes: 1024 * 1024 },
      { timeoutMs: 30_000, outputLimitBytes: 1024 * 1024 },
      { timeoutMs: 30_000, outputLimitBytes: 1024 * 1024 },
    ]);
  });

  it('keeps the validated artifact immutable after the caller buffer changes', async () => {
    const fixture = await repositoryFixture();
    const artifact = ordinaryPatch();
    const expected = Uint8Array.from(artifact);
    const seen: Uint8Array[] = [];
    const runGit: MarketplacePatchGitRunner = async (args, options) => {
      if (args.includes('ls-files')) {
        artifact.fill(0x78);
        return new Uint8Array();
      }
      seen.push(Uint8Array.from(options.stdin!));
      return new Uint8Array();
    };

    const result = await applyMarketplacePatchToWorktree(
      applicationInput(fixture, artifact),
      { worktreeProof: proof(), runGit },
    );

    expect(seen).toEqual([expected, expected]);
    expect(result.artifact).toEqual(expected);
  });
});
