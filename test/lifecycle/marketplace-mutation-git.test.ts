import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMarketplaceMutationGitPort,
  MarketplaceMutationGitError,
  type MarketplaceMutationCommitIdentity,
} from '../../src/lifecycle/marketplace-mutation-git.js';
import { runMarketplacePatchGit } from '../../src/lifecycle/marketplace-patch.js';
import { gitOid, type GitOid } from '../../src/lifecycle/types.js';

const encoder = new TextEncoder();
const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...args], { cwd, encoding: 'utf8' });
  return result.stdout;
}

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

/**
 * A real repository whose second commit holds the exact content the patch
 * describes, so the test knows the target tree without asking the code
 * under test to compute it. `HEAD` is left at the first commit.
 */
interface Fixture {
  readonly root: string;
  readonly baseHead: GitOid;
  readonly targetTree: GitOid;
  /** A second root-side commit usable as a reconcile merge parent. */
  readonly sideHead: GitOid;
  /** An ancestor of `baseHead`, usable as an already-merged reconcile base. */
  readonly ancestorHead: GitOid;
}

/** Writes a commit object with exact tree/parents/message and moves HEAD to it. */
async function handCommit(
  root: string,
  tree: GitOid,
  parents: readonly GitOid[],
  message: string,
): Promise<GitOid> {
  const created = gitOid((await git(root, [
    'commit-tree', tree,
    ...parents.flatMap((parent) => ['-p', parent]),
    '-m', message,
  ])).trim());
  await git(root, ['update-ref', 'HEAD', created]);
  return created;
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'marketplace-mutation-git-'));
  roots.push(root);
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.email', 'autopilot@example.com']);
  await git(root, ['config', 'user.name', 'Autopilot']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  write(root, 'README.md', 'readme\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'ancestor']);
  const ancestorHead = gitOid((await git(root, ['rev-parse', 'HEAD'])).trim());
  write(root, 'src/value.ts', 'old\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'base']);
  const baseHead = gitOid((await git(root, ['rev-parse', 'HEAD'])).trim());
  write(root, 'src/value.ts', 'new\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'target']);
  const targetTree = gitOid((await git(root, ['rev-parse', 'HEAD^{tree}'])).trim());
  await git(root, ['reset', '--hard', baseHead]);
  await git(root, ['checkout', '-b', 'side']);
  write(root, 'BASE.md', 'base moved on\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'side']);
  const sideHead = gitOid((await git(root, ['rev-parse', 'HEAD'])).trim());
  await git(root, ['checkout', 'main']);
  await git(root, ['reset', '--hard', baseHead]);
  return { root, baseHead, targetTree, sideHead, ancestorHead };
}

const VALUE_PATCH = bytes([
  'diff --git a/src/value.ts b/src/value.ts',
  '--- a/src/value.ts',
  '+++ b/src/value.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n'));

function identity(
  fix: Fixture,
  overrides: Partial<MarketplaceMutationCommitIdentity> = {},
): MarketplaceMutationCommitIdentity {
  const artifact = overrides.artifact ?? VALUE_PATCH;
  return {
    worktreePath: fix.root,
    expectedHead: fix.baseHead,
    artifact,
    artifactDigest: sha256(artifact),
    workflow: 'implement',
    touchedPaths: ['src/value.ts'],
    summary: 'Apply marketplace solution',
    taskId: 'task-7',
    requestId: 'request-9',
    deliveryEnvelopeCid: 'bafyenvelope',
    v2AttemptId: 'attempt-11',
    ...overrides,
  };
}

/** The exact host-commit message this port is expected to write. */
function hostMessage(childIssueNumber?: number): string {
  return [
    'Apply marketplace solution',
    '',
    'Jinn-Marketplace-Task: task-7',
    'Jinn-Marketplace-Request: request-9',
    'Jinn-Marketplace-Envelope: bafyenvelope',
    'Jinn-Autopilot-Attempt: attempt-11',
    `Jinn-Marketplace-Artifact: ${sha256(VALUE_PATCH)}`,
    ...(childIssueNumber === undefined
      ? []
      : [`Jinn-Autopilot-Issue: ${String(childIssueNumber)}`]),
  ].join('\n');
}

describe('marketplace mutation git port', () => {
  it('reports clean state with the expected tree before the patch is applied', async () => {
    const fix = await fixture();
    const port = createMarketplaceMutationGitPort();

    const state = await port.readState(identity(fix));

    expect(state).toEqual({ status: 'clean', expectedTree: fix.targetTree });
  });

  it('reports pending once the worktree holds exactly the delivered tree', async () => {
    const fix = await fixture();
    write(fix.root, 'src/value.ts', 'new\n');
    const port = createMarketplaceMutationGitPort();

    const state = await port.readState(identity(fix));

    expect(state).toEqual({ status: 'pending', expectedTree: fix.targetTree });
  });

  it('creates one host commit and reconstructs the same evidence on retry', async () => {
    const fix = await fixture();
    write(fix.root, 'src/value.ts', 'new\n');
    const port = createMarketplaceMutationGitPort();

    const created = await port.commit(identity(fix));

    expect(created.tree).toBe(fix.targetTree);
    expect(created.parents).toEqual([fix.baseHead]);
    expect(created.artifactDigest).toBe(sha256(VALUE_PATCH));
    expect(created.correlationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await git(fix.root, ['rev-parse', 'HEAD'])).trim()).toBe(created.head);

    // A crash after the commit must reconstruct, not duplicate.
    const recovered = await port.readState(identity(fix));
    expect(recovered).toEqual({
      status: 'committed',
      expectedTree: fix.targetTree,
      commit: created,
    });

    const retried = await port.commit(identity(fix));
    expect(retried).toEqual(created);
    const walked = (await git(fix.root, ['rev-list', `${fix.baseHead}..HEAD`]))
      .trim().split('\n').filter((line) => line.length > 0);
    expect(walked).toEqual([created.head]);
  });

  it('rejects a delivered patch that leaves the attempt tree unchanged', async () => {
    const fix = await fixture();
    const baseTree = (await git(fix.root, ['rev-parse', `${fix.baseHead}^{tree}`])).trim();
    // Task 3's parser already refuses the obvious identical-hunk no-op, so the
    // only way to reach this guard is at the Git boundary itself: everything
    // stays real except the tree the scratch index reports back.
    const port = createMarketplaceMutationGitPort({
      runGit: async (args, options) => (args[0] === 'write-tree'
        ? encoder.encode(`${baseTree}\n`)
        : runMarketplacePatchGit(args, options)),
    });

    await expect(port.readState(identity(fix)))
      .rejects.toMatchObject({
        name: 'MarketplaceMutationGitError',
        reason: 'no-op-patch',
      });
    expect(MarketplaceMutationGitError).toBeTypeOf('function');
  });

  it('contradicts when the worktree carries a path outside the delivered patch', async () => {
    const fix = await fixture();
    write(fix.root, 'src/value.ts', 'new\n');
    write(fix.root, 'docs/notes.md', 'stray\n');
    const port = createMarketplaceMutationGitPort();

    const state = await port.readState(identity(fix));

    expect(state.status).toBe('contradiction');
    expect(state.status === 'contradiction' && state.detail).toContain('docs/notes.md');
  });

  it('contradicts when the delivered path holds content the patch never produced', async () => {
    const fix = await fixture();
    write(fix.root, 'src/value.ts', 'newer\n');
    const port = createMarketplaceMutationGitPort();

    const state = await port.readState(identity(fix));

    expect(state.status).toBe('contradiction');
    expect(state.status === 'contradiction' && state.detail).toContain('src/value.ts');
  });

  it('never adopts an arbitrary local commit as the host commit', async () => {
    const fix = await fixture();
    write(fix.root, 'src/value.ts', 'new\n');
    await git(fix.root, ['add', '-A']);
    await git(fix.root, ['commit', '-m', 'a human committed the delivered tree']);
    const port = createMarketplaceMutationGitPort();

    const state = await port.readState(identity(fix));

    // Right tree, no correlation evidence: this commit is not ours to claim.
    expect(state.status).toBe('contradiction');
    expect(state.status === 'contradiction' && state.detail).toContain('correlation trailers');
  });

  it('leaves the attempt worktree index untouched while reading state', async () => {
    const fix = await fixture();
    write(fix.root, 'src/value.ts', 'new\n');
    const port = createMarketplaceMutationGitPort();

    expect((await port.readState(identity(fix))).status).toBe('pending');

    expect((await git(fix.root, ['diff', '--cached', '--name-only'])).trim()).toBe('');
    expect((await git(fix.root, ['status', '--porcelain'])).trimEnd())
      .toBe(' M src/value.ts');
  });

  it('carries the child issue trailer for child workflows only', async () => {
    const fix = await fixture();
    write(fix.root, 'src/value.ts', 'new\n');
    const port = createMarketplaceMutationGitPort();

    const created = await port.commit(identity(fix, {
      workflow: 'fix-child',
      childIssueNumber: 77,
    }));

    expect(created.trailers.childIssueNumber).toBe(77);
    const message = await git(fix.root, ['log', '-n', '1', '--format=%B', created.head]);
    expect(message.trimEnd().split('\n').slice(-6)).toEqual([
      'Jinn-Marketplace-Task: task-7',
      'Jinn-Marketplace-Request: request-9',
      'Jinn-Marketplace-Envelope: bafyenvelope',
      'Jinn-Autopilot-Attempt: attempt-11',
      'Jinn-Marketplace-Artifact: ' + sha256(VALUE_PATCH),
      'Jinn-Autopilot-Issue: 77',
    ]);
  });

  it('omits the child issue trailer for the implement workflow', async () => {
    const fix = await fixture();
    write(fix.root, 'src/value.ts', 'new\n');
    const port = createMarketplaceMutationGitPort();

    const created = await port.commit(identity(fix));

    expect(created.trailers.childIssueNumber).toBeUndefined();
    const message = await git(fix.root, ['log', '-n', '1', '--format=%B', created.head]);
    expect(message).not.toContain('Jinn-Autopilot-Issue');
  });

  it('gives a reconcile host commit the current merge-parent topology', async () => {
    const fix = await fixture();
    write(fix.root, 'src/value.ts', 'new\n');
    const port = createMarketplaceMutationGitPort();
    const reconcile = identity(fix, {
      workflow: 'reconcile',
      childIssueNumber: 91,
      reconcileBase: fix.sideHead,
    });

    const created = await port.commit(reconcile);

    expect(created.parents).toEqual([fix.baseHead, fix.sideHead]);
    // The reconcile leg exists to make the base an ancestor of the PR branch.
    await expect(git(fix.root, [
      'merge-base', '--is-ancestor', fix.sideHead, created.head,
    ])).resolves.toBeDefined();
    expect(await port.readState(reconcile))
      .toEqual({ status: 'committed', expectedTree: fix.targetTree, commit: created });
  });

  it('contradicts a merge host commit that is not rooted at the attempt head', async () => {
    const fix = await fixture();
    write(fix.root, 'src/value.ts', 'new\n');
    const reconcile = identity(fix, {
      workflow: 'reconcile',
      childIssueNumber: 91,
      reconcileBase: fix.sideHead,
    });
    const port = createMarketplaceMutationGitPort();
    await handCommit(
      fix.root, fix.targetTree, [fix.sideHead, fix.baseHead], hostMessage(91),
    );

    const state = await port.readState(reconcile);

    expect(state.status).toBe('contradiction');
  });

  it('contradicts merge parents that hold the right set in the wrong order', async () => {
    const fix = await fixture();
    write(fix.root, 'src/value.ts', 'new\n');
    // An already-merged reconcile base: the mainline parent and the merged-in
    // parent carry the same two oids, so only their order distinguishes a
    // correct host commit from one that re-roots the PR branch.
    const reconcile = identity(fix, {
      workflow: 'reconcile',
      childIssueNumber: 91,
      reconcileBase: fix.ancestorHead,
    });
    const port = createMarketplaceMutationGitPort();
    const swapped = await handCommit(
      fix.root, fix.targetTree, [fix.ancestorHead, fix.baseHead], hostMessage(91),
    );

    const state = await port.readState(reconcile);

    expect(state.status).toBe('contradiction');
    expect(state.status === 'contradiction' && state.detail).toContain(swapped);
  });

  it('contradicts a host commit missing a merge parent the identity requires', async () => {
    const fix = await fixture();
    write(fix.root, 'src/value.ts', 'new\n');
    const port = createMarketplaceMutationGitPort();
    const created = await port.commit(identity(fix, {
      workflow: 'fix-child',
      childIssueNumber: 91,
    }));

    const state = await port.readState(identity(fix, {
      workflow: 'reconcile',
      childIssueNumber: 91,
      reconcileBase: fix.sideHead,
    }));

    expect(state.status).toBe('contradiction');
    expect(state.status === 'contradiction' && state.detail).toContain(created.head);
  });

  it.each([
    ['missing', ['Jinn-Marketplace-Task: task-7']],
    ['wrong', [
      'Jinn-Marketplace-Task: task-7',
      'Jinn-Marketplace-Request: request-9',
      'Jinn-Marketplace-Envelope: bafyenvelope',
      'Jinn-Autopilot-Attempt: attempt-OTHER',
      'Jinn-Marketplace-Artifact: sha256:' + '0'.repeat(64),
    ]],
    ['duplicate', [
      'Jinn-Marketplace-Task: task-7',
      'Jinn-Marketplace-Task: task-7',
      'Jinn-Marketplace-Request: request-9',
      'Jinn-Marketplace-Envelope: bafyenvelope',
      'Jinn-Autopilot-Attempt: attempt-11',
      'Jinn-Marketplace-Artifact: SHA',
    ]],
  ])('contradicts %s correlation trailers', async (_label, trailers) => {
    const fix = await fixture();
    write(fix.root, 'src/value.ts', 'new\n');
    const port = createMarketplaceMutationGitPort();
    const message = ['Apply marketplace solution', '', ...trailers]
      .join('\n').replace('SHA', sha256(VALUE_PATCH));
    await handCommit(fix.root, fix.targetTree, [fix.baseHead], message);

    const state = await port.readState(identity(fix));

    expect(state.status).toBe('contradiction');
  });

  it('recovers the host commit under an implementation phase-complete marker', async () => {
    const fix = await fixture();
    write(fix.root, 'src/value.ts', 'new\n');
    const port = createMarketplaceMutationGitPort();
    const created = await port.commit(identity(fix));

    // The existing implementation protocol stacks an empty-diff completion
    // marker on top of whatever the phase produced.
    const marker = await handCommit(fix.root, fix.targetTree, [created.head], [
      'Autopilot implementation phase complete',
      '',
      'Applied the marketplace solution.',
      '',
      'Jinn-Autopilot-Protocol: 2',
      'Jinn-Autopilot-Phase: implement',
      'Jinn-Autopilot-Issue: 42',
      'Jinn-Autopilot-PR: 43',
      'Jinn-Autopilot-Attempt: 3f1d9c2e-0b7a-4c1e-9d55-2a6b8e4f7c10',
      'Jinn-Autopilot-Runner: runner-1',
      'Jinn-Autopilot-Login: autopilot-bot',
      `Jinn-Autopilot-Expected-Head: ${created.head}`,
      'Jinn-Autopilot-Target-Base: main',
      'Jinn-Autopilot-Claimed-At: 2026-07-27T00:00:00Z',
      'Jinn-Autopilot-Phase-Complete: true',
    ].join('\n'));

    const state = await port.readState(identity(fix));

    expect(state).toEqual({
      status: 'committed',
      expectedTree: fix.targetTree,
      commit: created,
    });
    expect((await git(fix.root, ['rev-parse', 'HEAD'])).trim()).toBe(marker);
  });

  it('contradicts an unrelated commit stacked above the host commit', async () => {
    const fix = await fixture();
    write(fix.root, 'src/value.ts', 'new\n');
    const port = createMarketplaceMutationGitPort();
    const created = await port.commit(identity(fix));
    await git(fix.root, ['reset', '--hard', created.head]);
    write(fix.root, 'docs/notes.md', 'someone kept working\n');
    await git(fix.root, ['add', '-A']);
    await git(fix.root, ['commit', '-m', 'unrelated local work']);

    const state = await port.readState(identity(fix));

    expect(state.status).toBe('contradiction');
    expect(state.status === 'contradiction' && state.detail)
      .toContain('phase-complete marker');
  });

  it('refuses an artifact digest that does not bind the delivered bytes', async () => {
    const fix = await fixture();
    const port = createMarketplaceMutationGitPort();

    await expect(port.readState(identity(fix, {
      artifactDigest: `sha256:${'0'.repeat(64)}`,
    }))).rejects.toMatchObject({
      name: 'MarketplaceMutationGitError',
      reason: 'artifact-mismatch',
    });
  });

  it('refuses touched paths that disagree with the delivered patch', async () => {
    const fix = await fixture();
    const port = createMarketplaceMutationGitPort();

    await expect(port.readState(identity(fix, {
      touchedPaths: ['src/other.ts'],
    }))).rejects.toMatchObject({
      name: 'MarketplaceMutationGitError',
      reason: 'path-mismatch',
    });
  });

  it.each([
    ['implement carrying a child issue', { childIssueNumber: 5 } as const],
    ['a child workflow without its issue', { workflow: 'fix-child' } as const],
    ['implement carrying a reconcile base', { reconcileBase: gitOid('0'.repeat(40)) } as const],
    ['an empty summary', { summary: '   ' } as const],
  ])('refuses %s', async (_label, overrides) => {
    const fix = await fixture();
    const port = createMarketplaceMutationGitPort();

    await expect(port.readState(identity(fix, overrides)))
      .rejects.toMatchObject({
        name: 'MarketplaceMutationGitError',
        reason: 'identity-invalid',
      });
  });

  it('produces evidence shaped exactly as the execution-state decoder demands', async () => {
    const fix = await fixture();
    write(fix.root, 'src/value.ts', 'new\n');
    const port = createMarketplaceMutationGitPort();

    const created = await port.commit(identity(fix, {
      workflow: 'ci-failure',
      childIssueNumber: 12,
    }));

    expect(Object.keys(created).sort()).toEqual([
      'artifactDigest', 'correlationDigest', 'createdAt', 'head', 'parents',
      'trailers', 'tree',
    ]);
    expect(Object.keys(created.trailers).sort()).toEqual([
      'artifactDigest', 'childIssueNumber', 'deliveryEnvelopeCid', 'requestId',
      'taskId', 'v2AttemptId',
    ]);
    expect(created.correlationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(created.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(created.trailers.artifactDigest).toBe(created.artifactDigest);
  });

  it('binds the correlation digest to the delivered identity, not to chance', async () => {
    const fix = await fixture();
    write(fix.root, 'src/value.ts', 'new\n');
    const port = createMarketplaceMutationGitPort();
    const first = await port.commit(identity(fix));

    const other = await fixture();
    write(other.root, 'src/value.ts', 'new\n');
    const same = await port.commit(identity(other));
    const different = createMarketplaceMutationGitPort();
    const otherRequest = await fixture();
    write(otherRequest.root, 'src/value.ts', 'new\n');
    const changed = await different.commit(identity(otherRequest, {
      requestId: 'request-DIFFERENT',
    }));

    expect(same.correlationDigest).toBe(first.correlationDigest);
    expect(changed.correlationDigest).not.toBe(first.correlationDigest);
  });
});
