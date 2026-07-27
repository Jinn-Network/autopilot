/**
 * `jinn-mono.v1` deterministic verification: the pure affected-workspace plan
 * builder for `Jinn-Network/mono`.
 *
 * The plan is a function of the delivered touched paths alone. It never reads
 * the repository, so the same delivery yields the same plan — and the same
 * plan digest — wherever it is adopted.
 */

import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { MarketplaceVerificationEvidence } from './marketplace-execution-state.js';
import { exactUtcTimestampMs } from './exact-utc-time.js';
import type { GitOid } from './types.js';

/**
 * How the adoption coordinator must treat a verification failure.
 *
 * - `stable-rejection` — a permanent property of the delivered patch. Re-running
 *   verification can only produce the same answer, so the delivery earns an SDK
 *   rejection receipt.
 * - `recoverable` — infrastructure ambiguity (no daemon, image unavailable, the
 *   sandbox died for reasons unrelated to the patch). The delivery is not
 *   judged; adoption may be retried.
 * - `unsafe` — the sandbox could not be proven torn down. Fail closed: neither
 *   accept the patch nor retry automatically, because a container that may
 *   still be alive holds the attempt worktree.
 * - `abandoned` — the adoption window closed before the work could be done. The
 *   delivery is not judged and retrying is pointless, so this is neither a
 *   rejection receipt nor a recoverable retry.
 */
export type MarketplaceVerificationDisposition =
  | 'stable-rejection'
  | 'recoverable'
  | 'unsafe'
  | 'abandoned';

export type MarketplaceVerificationReason =
  | 'unsupported-path'
  | 'unnormalized-path'
  | 'empty-selection'
  | 'command-failed'
  | 'invalid-deadline'
  | 'deadline-expired'
  | 'runner-failed'
  | 'unsafe-cleanup';

export class MarketplaceVerificationError extends Error {
  readonly reason: MarketplaceVerificationReason;

  readonly disposition: MarketplaceVerificationDisposition;

  constructor(
    reason: MarketplaceVerificationReason,
    disposition: MarketplaceVerificationDisposition,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'MarketplaceVerificationError';
    this.reason = reason;
    this.disposition = disposition;
  }
}

export interface MarketplaceVerificationCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly label: string;
}

export type JinnMonoWorkspace =
  | 'apps/broadcast-bot'
  | 'client'
  | 'contracts'
  | 'packages/autopilot'
  | 'packages/core'
  | 'packages/indexer'
  | 'packages/indexer-enrichment'
  | 'packages/layer'
  | 'packages/plugin'
  | 'packages/sdk';

export interface MarketplaceVerificationPlan {
  readonly profile: 'jinn-mono.v1';
  /**
   * Every workspace the plan touches, ordered dependency-first. The union of
   * the at-risk set and the build prerequisites it needs.
   */
  readonly workspaces: readonly JinnMonoWorkspace[];
  /**
   * The subset of `workspaces` whose behaviour the patch can actually change:
   * the touched workspaces and everything that depends on them. Only these are
   * type-checked and tested. The remainder are prerequisites, built so the
   * at-risk set has something to compile against, and carried in the plan
   * explicitly so the distinction survives the next person to read it.
   */
  readonly atRiskWorkspaces: readonly JinnMonoWorkspace[];
  readonly commands: readonly MarketplaceVerificationCommand[];
}

/**
 * The literal `jinn-mono.v1` workspace policy. Declaration order is protocol
 * surface: it is the total tie-break for otherwise-unordered workspaces, so
 * reordering these entries changes every plan digest ever computed.
 *
 * `dependsOn` is the intra-repository `@jinn-network/*` dependency edge set.
 * `buildScript` is `null` where the workspace declares no `build`, because
 * planning a script a workspace does not have exits non-zero and reads as the
 * solver's fault.
 */
const JINN_MONO_V1_WORKSPACES = [
  { path: 'apps/broadcast-bot', dependsOn: [], typeCheckScript: 'typecheck', buildScript: 'build' },
  {
    path: 'client',
    dependsOn: ['packages/core', 'packages/plugin', 'packages/layer', 'packages/sdk'],
    typeCheckScript: 'typecheck',
    buildScript: 'build',
  },
  // `contracts` declares `compile` and no `typecheck`, and no `build`.
  { path: 'contracts', dependsOn: [], typeCheckScript: 'compile', buildScript: null },
  { path: 'packages/autopilot', dependsOn: [], typeCheckScript: 'typecheck', buildScript: null },
  {
    path: 'packages/core',
    dependsOn: ['packages/plugin'],
    typeCheckScript: 'typecheck',
    buildScript: 'build',
  },
  {
    path: 'packages/indexer',
    dependsOn: ['packages/sdk'],
    typeCheckScript: 'typecheck',
    buildScript: 'build',
  },
  {
    path: 'packages/indexer-enrichment',
    dependsOn: ['packages/indexer'],
    typeCheckScript: 'typecheck',
    buildScript: 'build',
  },
  {
    path: 'packages/layer',
    dependsOn: ['packages/core', 'packages/plugin'],
    typeCheckScript: 'typecheck',
    buildScript: 'build',
  },
  { path: 'packages/plugin', dependsOn: [], typeCheckScript: 'typecheck', buildScript: 'build' },
  { path: 'packages/sdk', dependsOn: [], typeCheckScript: 'typecheck', buildScript: 'build' },
] as const satisfies readonly {
  readonly path: JinnMonoWorkspace;
  readonly dependsOn: readonly JinnMonoWorkspace[];
  readonly typeCheckScript: 'typecheck' | 'compile';
  readonly buildScript: 'build' | null;
}[];

type JinnMonoWorkspaceEntry = (typeof JINN_MONO_V1_WORKSPACES)[number];

function entryOf(workspace: JinnMonoWorkspace): JinnMonoWorkspaceEntry {
  return JINN_MONO_V1_WORKSPACES.find((candidate) => candidate.path === workspace)!;
}

/** Transitive closure of `seeds` under `step`, seeds included. */
function closure(
  seeds: Iterable<JinnMonoWorkspace>,
  step: (workspace: JinnMonoWorkspace) => readonly JinnMonoWorkspace[],
): Set<JinnMonoWorkspace> {
  const reached = new Set<JinnMonoWorkspace>();
  const pending = [...seeds];
  while (pending.length > 0) {
    const workspace = pending.pop()!;
    if (reached.has(workspace)) continue;
    reached.add(workspace);
    pending.push(...step(workspace));
  }
  return reached;
}

function dependenciesOf(workspace: JinnMonoWorkspace): readonly JinnMonoWorkspace[] {
  return entryOf(workspace).dependsOn;
}

function dependentsOf(workspace: JinnMonoWorkspace): readonly JinnMonoWorkspace[] {
  return JINN_MONO_V1_WORKSPACES
    .filter((candidate) => (candidate.dependsOn as readonly JinnMonoWorkspace[])
      .includes(workspace))
    .map((candidate) => candidate.path);
}

/**
 * Order `selected` dependency-first, breaking ties by declaration order so the
 * result is total and reproducible rather than merely valid. The graph is a
 * literal DAG, so no cycle is reachable.
 */
function dependencyFirstOrder(
  selected: ReadonlySet<JinnMonoWorkspace>,
): readonly JinnMonoWorkspace[] {
  const emitted: JinnMonoWorkspace[] = [];
  const remaining = new Set(selected);
  while (remaining.size > 0) {
    // Declaration order drives the scan, so among the workspaces whose
    // selected dependencies are already emitted the earliest-declared wins.
    const next = JINN_MONO_V1_WORKSPACES.find((candidate) => remaining.has(candidate.path)
      && (candidate.dependsOn as readonly JinnMonoWorkspace[])
        .every((dependency) => !remaining.has(dependency)));
    /* c8 ignore next */
    if (next === undefined) throw new Error('jinn-mono.v1 workspace graph is cyclic');
    emitted.push(next.path);
    remaining.delete(next.path);
  }
  return emitted;
}

/**
 * Task 3 promises canonical relative POSIX paths. This module re-proves it
 * rather than trusting the promise, because prefix matching on a path that is
 * not canonical selects a workspace the path does not live in.
 */
function canonicalPath(path: string): string {
  if (
    typeof path !== 'string'
    || path.length === 0
    || path.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(path)
    || posix.isAbsolute(path)
    // `normalize` preserves a trailing separator, so reject that explicitly.
    || path.endsWith('/')
    || posix.normalize(path) !== path
    || path === '.'
    || path === '..'
    || path.startsWith('../')
  ) {
    throw new MarketplaceVerificationError(
      'unnormalized-path',
      'stable-rejection',
      `Marketplace patch touched path is not canonical: ${JSON.stringify(path)}`,
    );
  }
  return path;
}

function workspaceOf(rawPath: string): JinnMonoWorkspace {
  const path = canonicalPath(rawPath);
  const entry = JINN_MONO_V1_WORKSPACES.find(
    (candidate) => path === candidate.path || path.startsWith(`${candidate.path}/`),
  );
  if (entry === undefined) {
    throw new MarketplaceVerificationError(
      'unsupported-path',
      'stable-rejection',
      `Marketplace patch touches a path outside jinn-mono.v1: ${path}`,
    );
  }
  return entry.path;
}

function touchesPackageManifestOrLockfile(rawPaths: readonly string[]): boolean {
  return rawPaths.some((rawPath) => {
    const path = canonicalPath(rawPath);
    return path === 'package.json'
      || path === 'yarn.lock'
      || path.endsWith('/package.json')
      || path.endsWith('/yarn.lock');
  });
}

/**
 * Build the plan from the touched paths alone.
 *
 * 1. `atRisk` = touched ∪ transitive *dependents*. These are the workspaces the
 *    patch can have changed the behaviour of, so these are what verification is
 *    actually about.
 * 2. `workspaces` = `atRisk` ∪ transitive *dependencies* of `atRisk`. These are
 *    build prerequisites, present only so the at-risk set's commands can run.
 *    Dependents are deliberately *not* re-expanded from anything this step
 *    adds: an unchanged `packages/sdk` pulled in to build `client` is not
 *    itself at risk, so `packages/indexer` does not join the plan.
 * 3. Order dependency-first, ties broken by declaration order.
 */
export function buildJinnMonoV1VerificationPlan(input: {
  readonly repositoryPath: string;
  readonly touchedPaths: readonly string[];
}): MarketplaceVerificationPlan {
  const touched = new Set(input.touchedPaths.map(workspaceOf));
  if (touched.size === 0) {
    throw new MarketplaceVerificationError(
      'empty-selection',
      'stable-rejection',
      'Marketplace patch selects no jinn-mono.v1 workspace to verify',
    );
  }
  const allWorkspaces = JINN_MONO_V1_WORKSPACES.map((entry) => entry.path);
  const widenToAllWorkspaces = touchesPackageManifestOrLockfile(input.touchedPaths);
  const atRiskSet = widenToAllWorkspaces
    ? new Set(allWorkspaces)
    : closure(touched, dependentsOf);
  const atRiskWorkspaces = widenToAllWorkspaces
    ? dependencyFirstOrder(new Set(allWorkspaces))
    : dependencyFirstOrder(atRiskSet);
  const workspaces = widenToAllWorkspaces
    ? atRiskWorkspaces
    : dependencyFirstOrder(closure(atRiskSet, dependenciesOf));
  const workspaceCwd = (workspace: JinnMonoWorkspace): string =>
    `${input.repositoryPath}/${workspace}`;
  return {
    profile: 'jinn-mono.v1',
    workspaces,
    atRiskWorkspaces,
    commands: [
      {
        label: 'install',
        command: 'corepack',
        args: ['yarn', 'install', '--immutable'],
        cwd: input.repositoryPath,
      },
      ...workspaces
        .filter((workspace) => entryOf(workspace).buildScript !== null)
        .map((workspace) => ({
          label: `build:${workspace}`,
          command: 'corepack',
          args: ['yarn', entryOf(workspace).buildScript!],
          cwd: workspaceCwd(workspace),
        })),
      ...atRiskWorkspaces.map((workspace) => ({
        label: `typecheck:${workspace}`,
        command: 'corepack',
        args: ['yarn', entryOf(workspace).typeCheckScript],
        cwd: workspaceCwd(workspace),
      })),
      ...atRiskWorkspaces.map((workspace) => ({
        label: `test:${workspace}`,
        command: 'corepack',
        args: ['yarn', 'test'],
        cwd: workspaceCwd(workspace),
      })),
    ],
  };
}

/**
 * The command's working directory relative to the repository root. The install
 * command runs at the root by construction, so its `cwd` defines the root
 * without the plan having to carry a host-specific path.
 */
export function marketplaceVerificationCommandCwdRelative(
  plan: MarketplaceVerificationPlan,
  command: MarketplaceVerificationCommand,
): string {
  const root = plan.commands[0]?.cwd ?? command.cwd;
  const relative = posix.relative(root, command.cwd);
  return relative === '' ? '.' : relative;
}

/**
 * Canonical digest of the exact work the plan describes: profile, workspace
 * selection, and every command's label, program, argument vector, and
 * repository-relative working directory.
 *
 * Absolute paths are deliberately excluded so that the same delivery digests
 * identically wherever the attempt worktree happens to live — the digest is
 * part of the idempotent reuse key, and a host-specific digest would discard
 * sound evidence after a crash.
 */
export function marketplaceVerificationPlanDigest(
  plan: MarketplaceVerificationPlan,
): string {
  const canonical = JSON.stringify({
    profile: plan.profile,
    workspaces: [...plan.workspaces],
    atRiskWorkspaces: [...plan.atRiskWorkspaces],
    commands: plan.commands.map((command) => ({
      label: command.label,
      command: command.command,
      args: [...command.args],
      cwdRelative: marketplaceVerificationCommandCwdRelative(plan, command),
    })),
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

export interface MarketplaceVerificationRunResult {
  readonly exitCode: number;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
}

export type MarketplaceVerificationCommandRunner = (input: {
  readonly command: MarketplaceVerificationCommand;
}) => Promise<MarketplaceVerificationRunResult>;

export interface MarketplaceMutationVerificationPort {
  preflight(): Promise<{ readonly ok: boolean; readonly detail?: string }>;
  verify(input: {
    readonly profile: 'jinn-mono.v1';
    readonly repositoryPath: string;
    readonly touchedPaths: readonly string[];
    readonly artifactDigest: string;
    readonly expectedTree: GitOid;
    readonly deadline: string;
  }): Promise<MarketplaceVerificationEvidence>;
}

export function createSequentialMarketplaceVerificationPort(options: {
  readonly run: MarketplaceVerificationCommandRunner;
  readonly now?: () => Date;
}): MarketplaceMutationVerificationPort {
  const now = options.now ?? (() => new Date());
  return {
    preflight: async () => ({ ok: true }),
    verify: async (input) => {
      const plan = buildJinnMonoV1VerificationPlan({
        repositoryPath: input.repositoryPath,
        touchedPaths: input.touchedPaths,
      });
      const deadlineMs = exactUtcTimestampMs(input.deadline);
      if (deadlineMs === null) {
        throw new MarketplaceVerificationError(
          'invalid-deadline',
          'abandoned',
          `Marketplace adoption deadline is not an exact UTC timestamp: ${input.deadline}`,
        );
      }
      const commands: MarketplaceVerificationEvidence['commands'][number][] = [];
      for (const command of plan.commands) {
        // Re-checked before every command, not only before the first: a slow
        // install must not carry the run past the adoption window.
        if (now().getTime() >= deadlineMs) {
          throw new MarketplaceVerificationError(
            'deadline-expired',
            'abandoned',
            `Marketplace adoption deadline ${input.deadline} passed before `
              + `verification command ${command.label}`,
          );
        }
        const startedAt = now().toISOString();
        let result: MarketplaceVerificationRunResult;
        try {
          result = await options.run({ command });
        } catch (error) {
          // A sandbox that never ran the command has said nothing about the
          // patch, and a sandbox that classified its own failure has already
          // said the truer thing. Only an exit code is a verdict.
          if (error instanceof MarketplaceVerificationError) throw error;
          throw new MarketplaceVerificationError(
            'runner-failed',
            'recoverable',
            `Marketplace verification command ${command.label} could not be run`,
            error,
          );
        }
        if (result.exitCode !== 0) {
          const isInstall = command.label === 'install';
          throw new MarketplaceVerificationError(
            'command-failed',
            isInstall ? 'recoverable' : 'stable-rejection',
            `Marketplace verification command ${command.label} exited ${result.exitCode}`,
          );
        }
        commands.push({
          label: command.label,
          command: command.command,
          args: [...command.args],
          cwdRelative: marketplaceVerificationCommandCwdRelative(plan, command),
          status: 'passed',
          exitCode: 0,
          stdoutDigest: result.stdoutDigest,
          stderrDigest: result.stderrDigest,
          startedAt,
          completedAt: now().toISOString(),
        });
      }
      return {
        profile: 'jinn-mono.v1',
        artifactDigest: input.artifactDigest,
        expectedTree: input.expectedTree,
        planDigest: marketplaceVerificationPlanDigest(plan),
        commands,
        verifiedAt: now().toISOString(),
      };
    },
  };
}
