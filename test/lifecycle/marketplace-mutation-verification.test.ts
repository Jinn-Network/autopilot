import { describe, expect, it } from 'vitest';
import {
  buildJinnMonoV1VerificationPlan,
  createSequentialMarketplaceVerificationPort,
  MarketplaceVerificationError,
  marketplaceVerificationPlanDigest,
  type MarketplaceVerificationCommandRunner,
} from '../../src/lifecycle/marketplace-mutation-verification.js';
import {
  decodeMarketplaceExecutionV3State,
  type MarketplaceVerificationEvidence,
} from '../../src/lifecycle/marketplace-execution-state.js';
import { gitOid } from '../../src/lifecycle/types.js';

const REPO = '/srv/attempt/mono';
const ARTIFACT_DIGEST = `sha256:${'a'.repeat(64)}`;
const EXPECTED_TREE = gitOid('b'.repeat(40));
const DEADLINE = '2020-01-01T02:00:00.000Z';

/** A clock that advances one second per read, so ordering is observable. */
function clock(start = '2020-01-01T00:00:00.000Z'): () => Date {
  let tick = Date.parse(start);
  return () => {
    const now = new Date(tick);
    tick += 1_000;
    return now;
  };
}

function digestOf(label: string): string {
  return `sha256:${label.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, '0')}`;
}

/** A runner that passes every command, digesting its label. */
const passing: MarketplaceVerificationCommandRunner = async ({ command }) => ({
  exitCode: 0,
  stdoutDigest: digestOf(command.label),
  stderrDigest: digestOf('e'),
});

const DECODER_ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const DECODER_ATTEMPT_DIR =
  `/tmp/autopilot/v2/runner-a/implement/issue-42-${DECODER_ATTEMPT_ID}`;
const DECODER_TASK_ID = '501';
const DECODER_TASK_CID = 'bafybeigdyrzt5m6u2r3o4exampletaskcid';
const DECODER_SOLVER_CID = 'bafybeigdyrzt5m6u2r3o4examplesolvercid';
const DECODER_CREATION_TX = `0x${'d'.repeat(64)}`;
const DECODER_REQUEST_ID = `0x${'9'.repeat(64)}`;
const DECODER_ENVELOPE_CID = 'bafybeigdyrzt5m6u2r3o4exampleenvelopecid';

/**
 * A complete `solution-verified` execution state carrying the evidence under
 * test. Every other field is decoder-legal so the only thing that can make the
 * decode fail is the verification evidence itself.
 */
function solutionVerifiedState(evidence: MarketplaceVerificationEvidence): unknown {
  return {
    schemaVersion: 'marketplace-execution-v3',
    status: 'solution-verified',
    requestPath: `${DECODER_ATTEMPT_DIR}/marketplace-request.json`,
    requestDigest: `sha256:${'b'.repeat(64)}`,
    solverNetSelectionPath:
      `${DECODER_ATTEMPT_DIR}/marketplace-request.json.solvernet-selection.json`,
    preparedAt: '2020-01-01T00:00:00.000Z',
    agentSoftDeadline: '2020-01-01T01:00:00.000Z',
    adoptionDeadline: DEADLINE,
    submission: {
      schemaVersion: 1,
      generatedAt: '2020-01-01T00:00:00.000Z',
      verb: 'tasks submit',
      id: `autopilot:${DECODER_ATTEMPT_ID}`,
      creatorMultisig: `0x${'c'.repeat(40)}`,
      taskId: DECODER_TASK_ID,
      taskCid: DECODER_TASK_CID,
      creationTx: DECODER_CREATION_TX,
      creationBlock: 501,
      solverNetManifestCid: DECODER_SOLVER_CID,
      status: 'submitted',
      idempotent: false,
    },
    submittedAt: '2020-01-01T00:00:00.000Z',
    delivery: {
      observationPath: `${DECODER_ATTEMPT_DIR}/delivery.json`,
      observationDigest: `sha256:${'b'.repeat(64)}`,
      taskId: DECODER_TASK_ID,
      taskCid: DECODER_TASK_CID,
      taskCreationTransaction: DECODER_CREATION_TX,
      taskCreationBlock: 501,
      solverNetManifestCid: DECODER_SOLVER_CID,
      attemptIndex: 0,
      requestId: DECODER_REQUEST_ID,
      deliveryEnvelopeCid: DECODER_ENVELOPE_CID,
      deliveryEnvelopeDigest: `sha256:${'e'.repeat(64)}`,
      deliveryTransaction: `0x${'f'.repeat(64)}`,
      deliveryBlock: 502,
      solverSafe: `0x${'1'.repeat(40)}`,
      solverAgentEoa: `0x${'2'.repeat(40)}`,
      signer: `0x${'2'.repeat(40)}`,
      publisherAgentId: '501',
      correlation: {
        taskId: DECODER_TASK_ID,
        attemptIndex: 0,
        requestId: DECODER_REQUEST_ID,
        deliveryEnvelopeCid: DECODER_ENVELOPE_CID,
        v2AttemptId: DECODER_ATTEMPT_ID,
        claimOid: gitOid('c'.repeat(40)),
        prNumber: 42,
        expectedHead: gitOid('d'.repeat(40)),
      },
      observedAt: '2020-01-01T00:00:00.000Z',
    },
    artifact: {
      digest: ARTIFACT_DIGEST,
      byteLength: 512,
      touchedPaths: ['packages/autopilot/src/engine.ts'],
      expectedTree: EXPECTED_TREE,
    },
    verification: evidence,
  };
}

const verifyInput = {
  profile: 'jinn-mono.v1',
  repositoryPath: REPO,
  touchedPaths: ['packages/autopilot/src/engine.ts'],
  artifactDigest: ARTIFACT_DIGEST,
  expectedTree: EXPECTED_TREE,
  deadline: DEADLINE,
} as const;

describe('buildJinnMonoV1VerificationPlan', () => {
  it('plans install, then typecheck, then test for the workspace a path belongs to', () => {
    const plan = buildJinnMonoV1VerificationPlan({
      repositoryPath: REPO,
      touchedPaths: ['packages/autopilot/src/engine.ts'],
    });

    expect(plan).toEqual({
      profile: 'jinn-mono.v1',
      workspaces: ['packages/sdk', 'packages/autopilot'],
      atRiskWorkspaces: ['packages/autopilot'],
      commands: [
        {
          label: 'install:packages/sdk',
          command: 'corepack',
          args: ['yarn', 'install', '--immutable'],
          cwd: `${REPO}/packages/sdk`,
        },
        {
          label: 'install:packages/autopilot',
          command: 'corepack',
          args: ['yarn', 'install', '--immutable'],
          cwd: `${REPO}/packages/autopilot`,
        },
        {
          label: 'build:packages/sdk',
          command: 'corepack',
          args: ['yarn', 'build'],
          cwd: `${REPO}/packages/sdk`,
        },
        {
          label: 'typecheck:packages/autopilot',
          command: 'corepack',
          args: ['yarn', 'typecheck'],
          cwd: `${REPO}/packages/autopilot`,
        },
        {
          label: 'test:packages/autopilot',
          command: 'corepack',
          args: ['yarn', 'test'],
          cwd: `${REPO}/packages/autopilot`,
        },
      ],
    });
  });

  // `contracts` is the one workspace that declares `compile` and no
  // `typecheck`. A builder that hardcodes `typecheck` turns every contracts
  // delivery into a missing-script exit — an infrastructure fault the caller
  // would read as a solver failure and reject the patch for.
  it('type-checks contracts through its compile script', () => {
    const plan = buildJinnMonoV1VerificationPlan({
      repositoryPath: REPO,
      touchedPaths: ['contracts/src/Jinn.sol'],
    });

    expect(plan.workspaces).toEqual(['contracts']);
    expect(plan.commands.map((entry) => [entry.label, ...entry.args])).toEqual([
      ['install:contracts', 'yarn', 'install', '--immutable'],
      ['typecheck:contracts', 'yarn', 'compile'],
      ['test:contracts', 'yarn', 'test'],
    ]);
  });

  // A path outside the profile is a permanent property of the delivery, so it
  // must be classified `stable-rejection`. A bare `Error` leaves Task 8 unable
  // to tell it from infrastructure ambiguity: it would either publish a
  // rejection receipt for a transient fault or retry a hopeless patch forever.
  it.each([
    'README.md',
    'docs/architecture.md',
    'scripts/release.mjs',
    'scripts/yarn.lock',
    'packages/not-a-workspace/src/index.ts',
    'apps/other-bot/src/index.ts',
    // Sibling directories whose names *begin* with a workspace path. Matching
    // on a bare prefix rather than on `<workspace>/` claims a workspace these
    // paths do not live in, so the plan would verify the wrong code and pass.
    'clientele/src/index.ts',
    'contracts-legacy/src/Old.sol',
    'packages/sdk-extra/src/index.ts',
    'packages/coreutils/src/index.ts',
  ])('refuses %s as outside the jinn-mono.v1 profile', (path) => {
    expect(() => buildJinnMonoV1VerificationPlan({
      repositoryPath: REPO,
      touchedPaths: [path],
    })).toThrowError(expect.objectContaining({
      name: 'MarketplaceVerificationError',
      reason: 'unsupported-path',
      disposition: 'stable-rejection',
    }));
  });

  // Prefix matching alone accepts `packages/plugin/../../etc/passwd`: it starts
  // with `packages/plugin/`, so the plan would claim a workspace the path does
  // not live in. Every path must already be the canonical relative POSIX form
  // Task 3 promises, and anything else fails closed rather than being repaired.
  it.each([
    ['an empty path', ''],
    ['a dot-relative path', './packages/plugin/index.ts'],
    ['a traversal escaping the workspace', 'packages/plugin/../../etc/passwd'],
    ['an interior traversal', 'packages/plugin/src/../index.ts'],
    ['a doubled separator', 'packages/plugin//index.ts'],
    ['a trailing separator', 'packages/plugin/src/'],
    ['an absolute path', '/packages/plugin/index.ts'],
    ['a backslash path', 'packages\\plugin\\index.ts'],
  ])('refuses %s', (_label, path) => {
    expect(() => buildJinnMonoV1VerificationPlan({
      repositoryPath: REPO,
      touchedPaths: [path],
    })).toThrowError(expect.objectContaining({
      name: 'MarketplaceVerificationError',
      reason: 'unnormalized-path',
      disposition: 'stable-rejection',
    }));
  });

  // With no workspaces the plan degenerates to `yarn install` alone, which
  // exits zero and would let a patch be committed on the strength of a
  // successful dependency install having verified nothing.
  it('refuses a delivery that selects no workspace at all', () => {
    expect(() => buildJinnMonoV1VerificationPlan({
      repositoryPath: REPO,
      touchedPaths: [],
    })).toThrowError(expect.objectContaining({
      name: 'MarketplaceVerificationError',
      reason: 'empty-selection',
      disposition: 'stable-rejection',
    }));
  });
});

/**
 * The closure rule, stated once so the literals below can be read against it:
 *
 * 1. `A` (at-risk) = touched ∪ transitive *dependents* of touched — every
 *    workspace whose behaviour the patch can change.
 * 2. `B` (the plan) = `A` ∪ transitive *dependencies* of `A` — build
 *    prerequisites, added only so the at-risk set's commands can run. Nothing
 *    added in this step re-expands dependents: an unchanged `packages/sdk`
 *    pulled in to build `client` is not itself at risk.
 * 3. `B` is ordered dependency-first, ties broken by the declared
 *    `JinnMonoWorkspace` union order, so the order is total and literal.
 */
describe('buildJinnMonoV1VerificationPlan dependency closure', () => {
  const CORE_CLOSURE = [
    'packages/plugin', 'packages/core', 'packages/layer', 'packages/sdk', 'client',
  ];
  const INDEXER_CLOSURE = [
    'packages/sdk', 'packages/indexer', 'packages/indexer-enrichment',
  ];
  const ALL_MONO_WORKSPACES = [
    'apps/broadcast-bot', 'client', 'contracts', 'packages/autopilot',
    'packages/core', 'packages/indexer', 'packages/indexer-enrichment',
    'packages/layer', 'packages/plugin', 'packages/sdk',
  ];

  // One literal expected array per supported root. A closure computed rather
  // than asserted is a closure nobody has read: these literals are the
  // specification, and any edge added to or dropped from the graph must show
  // up here as a deliberate edit.
  it.each([
    ['apps/broadcast-bot/src/index.ts', ['apps/broadcast-bot']],
    ['client/src/app.ts', CORE_CLOSURE],
    ['contracts/src/Jinn.sol', ['contracts']],
    ['packages/autopilot/src/engine.ts', ['packages/sdk', 'packages/autopilot']],
    ['packages/core/src/index.ts', CORE_CLOSURE],
    ['packages/indexer/src/index.ts', INDEXER_CLOSURE],
    ['packages/indexer-enrichment/src/index.ts', INDEXER_CLOSURE],
    ['packages/layer/src/index.ts', CORE_CLOSURE],
    ['packages/plugin/src/index.ts', CORE_CLOSURE],
    ['packages/sdk/src/index.ts', [
      'packages/plugin', 'packages/core', 'packages/layer', 'packages/sdk', 'client',
      'packages/autopilot', 'packages/indexer', 'packages/indexer-enrichment',
    ]],
  ])('closes %s over dependents then dependencies', (path, expected) => {
    expect(buildJinnMonoV1VerificationPlan({
      repositoryPath: REPO,
      touchedPaths: [path],
    }).workspaces).toEqual(expected);
  });

  it('closes a multi-workspace delivery to the union, ordered dependency-first', () => {
    expect(buildJinnMonoV1VerificationPlan({
      repositoryPath: REPO,
      touchedPaths: [
        'packages/plugin/src/index.ts',
        'packages/core/src/index.ts',
        'packages/layer/src/index.ts',
        'client/src/app.ts',
      ],
    }).workspaces).toEqual(CORE_CLOSURE);
  });

  // The rule is directional, and this is the case that proves it. Under the
  // naive "verify the whole connected component" rule both directions would
  // return the same seven workspaces, and every other closure test here would
  // still pass. `packages/indexer` reaching only three workspaces — and
  // *never* `client` — is the observation that separates the two rules.
  it('is directional: sdk reaches indexer, indexer does not reach client', () => {
    const fromSdk = buildJinnMonoV1VerificationPlan({
      repositoryPath: REPO,
      touchedPaths: ['packages/sdk/src/index.ts'],
    }).workspaces;
    const fromIndexer = buildJinnMonoV1VerificationPlan({
      repositoryPath: REPO,
      touchedPaths: ['packages/indexer/src/index.ts'],
    }).workspaces;

    expect(fromSdk).toContain('packages/indexer');
    expect(fromSdk).toContain('packages/indexer-enrichment');
    expect(fromIndexer).not.toContain('client');
    expect(fromIndexer).not.toContain('packages/core');
    expect(fromIndexer).not.toContain('packages/layer');
    expect(fromIndexer).not.toContain('packages/plugin');
    expect(fromIndexer).toEqual(INDEXER_CLOSURE);
  });

  // Step 2 adds dependencies to make the at-risk set buildable; it must not
  // then treat them as at risk. `client` pulls in `packages/sdk`, and
  // `packages/indexer` depends on `packages/sdk` — but the patch cannot have
  // changed an untouched `packages/sdk`, so the indexer is not implicated.
  it('does not re-expand dependents from a workspace added as a prerequisite', () => {
    const plan = buildJinnMonoV1VerificationPlan({
      repositoryPath: REPO,
      touchedPaths: ['client/src/app.ts'],
    });

    expect(plan.workspaces).toContain('packages/sdk');
    expect(plan.workspaces).not.toContain('packages/indexer');
    expect(plan.workspaces).not.toContain('packages/indexer-enrichment');
  });

  // A package.json edit can declare a dependency the literal graph does not
  // encode. Widening to the full workspace set is the conservative mitigation
  // until Task 5b can distinguish registry outages from lockfile drift.
  it('widens closure to every workspace when a package.json or yarn.lock is touched', () => {
    const plan = buildJinnMonoV1VerificationPlan({
      repositoryPath: REPO,
      touchedPaths: ['apps/broadcast-bot/package.json', 'packages/sdk/src/index.ts'],
    });

    expect(new Set(plan.workspaces)).toEqual(new Set(ALL_MONO_WORKSPACES));
    expect(plan.workspaces).toHaveLength(ALL_MONO_WORKSPACES.length);
    expect(plan.atRiskWorkspaces).toEqual(plan.workspaces);
  });

  it('widens closure to every workspace when the root yarn.lock is touched', () => {
    const plan = buildJinnMonoV1VerificationPlan({
      repositoryPath: REPO,
      touchedPaths: ['yarn.lock'],
    });

    expect(new Set(plan.workspaces)).toEqual(new Set(ALL_MONO_WORKSPACES));
    expect(plan.workspaces).toHaveLength(ALL_MONO_WORKSPACES.length);
    expect(plan.atRiskWorkspaces).toEqual(plan.workspaces);
  });

  it('widens closure to every workspace when the root package.json is touched', () => {
    const plan = buildJinnMonoV1VerificationPlan({
      repositoryPath: REPO,
      touchedPaths: ['package.json'],
    });

    expect(new Set(plan.workspaces)).toEqual(new Set(ALL_MONO_WORKSPACES));
    expect(plan.workspaces).toHaveLength(ALL_MONO_WORKSPACES.length);
    expect(plan.atRiskWorkspaces).toEqual(plan.workspaces);
  });

  // The at-risk/prerequisite split has to be readable off the plan, not
  // reconstructed by whoever maintains this next. A prerequisite is built so
  // the at-risk set can compile against it; it is not itself type-checked or
  // tested, because the patch cannot have changed it.
  it('separates at-risk workspaces from build-only prerequisites', () => {
    const plan = buildJinnMonoV1VerificationPlan({
      repositoryPath: REPO,
      touchedPaths: ['client/src/app.ts'],
    });

    expect(plan.atRiskWorkspaces).toEqual(['client']);
    expect(plan.commands.map((entry) => entry.label)).toEqual([
      'install:packages/plugin',
      'install:packages/core',
      'install:packages/layer',
      'install:packages/sdk',
      'install:client',
      'build:packages/plugin',
      'build:packages/core',
      'build:packages/layer',
      'build:packages/sdk',
      'build:client',
      'typecheck:client',
      'test:client',
    ]);
  });

  it('type-checks and tests every at-risk workspace, dependency-first', () => {
    const plan = buildJinnMonoV1VerificationPlan({
      repositoryPath: REPO,
      touchedPaths: ['packages/indexer/src/index.ts'],
    });

    expect(plan.atRiskWorkspaces)
      .toEqual(['packages/indexer', 'packages/indexer-enrichment']);
    expect(plan.commands.map((entry) => entry.label)).toEqual([
      'install:packages/sdk',
      'install:packages/indexer',
      'install:packages/indexer-enrichment',
      'build:packages/sdk',
      'build:packages/indexer',
      'build:packages/indexer-enrichment',
      'typecheck:packages/indexer',
      'typecheck:packages/indexer-enrichment',
      'test:packages/indexer',
      'test:packages/indexer-enrichment',
    ]);
  });

  // `contracts` declares no `build`, so a build phase that assumes every
  // workspace has one turns a contracts delivery into a missing-script exit —
  // read by the caller as the solver's fault.
  it('omits a build command for a workspace that declares none', () => {
    for (const [path, omittedBuild] of [
      ['contracts/src/Jinn.sol', 'build:contracts'],
      ['packages/autopilot/src/engine.ts', 'build:packages/autopilot'],
    ] as const) {
      const labels = buildJinnMonoV1VerificationPlan({
        repositoryPath: REPO,
        touchedPaths: [path],
      }).commands.map((entry) => entry.label);
      expect(labels).not.toContain(omittedBuild);
    }
  });

  // The plan is the reuse key. If the order of the touched paths — an artifact
  // of how the delivery envelope happened to be serialised — leaks into the
  // plan, the same patch digests two ways and sound evidence is discarded.
  it('is invariant to the order and multiplicity of the touched paths', () => {
    const forward = buildJinnMonoV1VerificationPlan({
      repositoryPath: REPO,
      touchedPaths: ['packages/core/src/a.ts', 'client/src/b.ts'],
    });
    const shuffled = buildJinnMonoV1VerificationPlan({
      repositoryPath: REPO,
      touchedPaths: [
        'client/src/b.ts', 'packages/core/src/a.ts', 'client/src/b.ts',
        'packages/core/src/c.ts',
      ],
    });

    expect(shuffled.workspaces).toEqual(forward.workspaces);
    expect(shuffled.atRiskWorkspaces).toEqual(forward.atRiskWorkspaces);
    expect(marketplaceVerificationPlanDigest(shuffled))
      .toBe(marketplaceVerificationPlanDigest(forward));
  });

  // A prerequisite that runs before the thing it is a prerequisite for is not
  // a prerequisite. Stated as a graph property rather than a literal so a
  // future edge cannot satisfy the literals above while breaking the ordering.
  it('emits no workspace before a workspace in its own closure that it needs', () => {
    const plan = buildJinnMonoV1VerificationPlan({
      repositoryPath: REPO,
      touchedPaths: ['packages/plugin/src/index.ts', 'packages/sdk/src/index.ts'],
    });
    const position = new Map<string, number>(
      plan.workspaces.map((workspace, index) => [workspace, index] as const),
    );
    const edges: readonly (readonly [string, string])[] = [
      ['packages/plugin', 'packages/core'],
      ['packages/plugin', 'packages/layer'],
      ['packages/core', 'packages/layer'],
      ['packages/core', 'client'],
      ['packages/plugin', 'client'],
      ['packages/layer', 'client'],
      ['packages/sdk', 'client'],
      ['packages/sdk', 'packages/autopilot'],
      ['packages/sdk', 'packages/indexer'],
      ['packages/indexer', 'packages/indexer-enrichment'],
    ];

    for (const [dependency, dependent] of edges) {
      if (position.has(dependency) && position.has(dependent)) {
        expect(position.get(dependency)!).toBeLessThan(position.get(dependent)!);
      }
    }
    expect(plan.workspaces.length).toBe(8);
  });
});

describe('marketplaceVerificationPlanDigest', () => {
  const touchedPaths = ['packages/autopilot/src/engine.ts'];

  // The digest is part of the idempotent reuse key. Folding the absolute `cwd`
  // into it makes the same delivery digest differently on a host that
  // reclaimed the attempt at another path, so crash recovery would discard
  // sound evidence and re-run the whole sandbox.
  it('is identical for the same delivery at a different repository path', () => {
    const here = marketplaceVerificationPlanDigest(
      buildJinnMonoV1VerificationPlan({ repositoryPath: '/srv/a/mono', touchedPaths }),
    );
    const there = marketplaceVerificationPlanDigest(
      buildJinnMonoV1VerificationPlan({ repositoryPath: '/var/b/other', touchedPaths }),
    );

    expect(here).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(there).toBe(here);
  });

  // The digest must cover the exact argv, not merely which workspaces ran.
  // Otherwise a plan that silently swapped `--immutable` away would reuse the
  // evidence of a plan that had it.
  it('changes when a command argument changes', () => {
    const plan = buildJinnMonoV1VerificationPlan({ repositoryPath: REPO, touchedPaths });
    const loosened = {
      ...plan,
      commands: plan.commands.map((entry, index) => (
        index === 0 ? { ...entry, args: ['yarn', 'install'] } : entry
      )),
    };

    expect(marketplaceVerificationPlanDigest(loosened))
      .not.toBe(marketplaceVerificationPlanDigest(plan));
  });

  it('changes when a command program name changes', () => {
    const plan = buildJinnMonoV1VerificationPlan({ repositoryPath: REPO, touchedPaths });
    const swapped = {
      ...plan,
      commands: plan.commands.map((entry, index) => (
        index === 1 ? { ...entry, command: 'npx' } : entry
      )),
    };

    expect(marketplaceVerificationPlanDigest(swapped))
      .not.toBe(marketplaceVerificationPlanDigest(plan));
  });

  it('changes when a command label changes', () => {
    const plan = buildJinnMonoV1VerificationPlan({ repositoryPath: REPO, touchedPaths });
    const relabeled = {
      ...plan,
      commands: plan.commands.map((entry, index) => (
        index === 1 ? { ...entry, label: 'typecheck:packages/autopilot:probe' } : entry
      )),
    };

    expect(marketplaceVerificationPlanDigest(relabeled))
      .not.toBe(marketplaceVerificationPlanDigest(plan));
  });

  it('changes when a command repository-relative cwd changes', () => {
    const plan = buildJinnMonoV1VerificationPlan({ repositoryPath: REPO, touchedPaths });
    const relocated = {
      ...plan,
      commands: plan.commands.map((entry, index) => (
        index === 1 ? { ...entry, cwd: `${REPO}/elsewhere` } : entry
      )),
    };

    expect(marketplaceVerificationPlanDigest(relocated))
      .not.toBe(marketplaceVerificationPlanDigest(plan));
  });

  // Touching `client` and touching `packages/plugin` both close over exactly
  // the same five workspaces; only which of them are at risk differs. A digest
  // taken over the workspace list alone collides here, and a plugin delivery
  // would reuse the evidence of a client delivery that never type-checked it.
  it('distinguishes two deliveries with an identical workspace closure', () => {
    const fromClient = marketplaceVerificationPlanDigest(
      buildJinnMonoV1VerificationPlan({
        repositoryPath: REPO,
        touchedPaths: ['client/src/app.ts'],
      }),
    );
    const fromPlugin = buildJinnMonoV1VerificationPlan({
      repositoryPath: REPO,
      touchedPaths: ['packages/plugin/src/index.ts'],
    });

    expect(fromPlugin.workspaces).toEqual(
      buildJinnMonoV1VerificationPlan({
        repositoryPath: REPO,
        touchedPaths: ['client/src/app.ts'],
      }).workspaces,
    );
    expect(marketplaceVerificationPlanDigest(fromPlugin)).not.toBe(fromClient);
  });

  // The command list does not determine the closure. A prerequisite that
  // declares no `build` contributes no command at all, so it would be invisible
  // to a digest taken over commands alone. Today's graph happens to have no
  // such prerequisite — `contracts` and `packages/autopilot` are the only
  // build-less workspaces and nothing depends on either — but the reuse key
  // must not rest on that accident, because one added edge would silently make
  // two different closures digest the same.
  it('changes when the workspace closure widens without changing a command', () => {
    const plan = buildJinnMonoV1VerificationPlan({
      repositoryPath: REPO,
      touchedPaths: ['packages/autopilot/src/engine.ts'],
    });
    const widened = {
      ...plan,
      workspaces: [...plan.workspaces, 'contracts'] as const,
    };

    expect(marketplaceVerificationPlanDigest(widened))
      .not.toBe(marketplaceVerificationPlanDigest(plan));
  });

  it('changes when the at-risk selection widens', () => {
    const plan = buildJinnMonoV1VerificationPlan({
      repositoryPath: REPO,
      touchedPaths: ['client/src/app.ts'],
    });
    const widened = {
      ...plan,
      atRiskWorkspaces: [...plan.atRiskWorkspaces, 'packages/sdk'] as const,
    };

    expect(marketplaceVerificationPlanDigest(widened))
      .not.toBe(marketplaceVerificationPlanDigest(plan));
  });
});

describe('createSequentialMarketplaceVerificationPort', () => {
  // Task 8 gates adoption on `preflight` before it starts a sandbox. This port
  // runs whatever runner it was handed and has no daemon or image of its own to
  // check, so it must say so rather than reporting a fault the caller would
  // treat as infrastructure ambiguity and retry against forever.
  it('reports preflight ok because an injected runner has nothing to check', async () => {
    const port = createSequentialMarketplaceVerificationPort({ run: passing, now: clock() });

    await expect(port.preflight()).resolves.toEqual({ ok: true });
  });

  // Evidence that omits a command, or records a command the plan never
  // contained, breaks the reuse key: a later resume compares the persisted
  // command list against a freshly built plan and must find them identical.
  it('records every planned command, in order, bound to the delivery identity', async () => {
    const port = createSequentialMarketplaceVerificationPort({
      run: passing,
      now: clock(),
    });

    const evidence = await port.verify(verifyInput);

    expect(evidence.profile).toBe('jinn-mono.v1');
    expect(evidence.artifactDigest).toBe(ARTIFACT_DIGEST);
    expect(evidence.expectedTree).toBe(EXPECTED_TREE);
    expect(evidence.planDigest).toBe(marketplaceVerificationPlanDigest(
      buildJinnMonoV1VerificationPlan({
        repositoryPath: REPO,
        touchedPaths: ['packages/autopilot/src/engine.ts'],
      }),
    ));
    expect(evidence.commands.map((entry) => [entry.label, entry.cwdRelative])).toEqual([
      ['install:packages/sdk', 'packages/sdk'],
      ['install:packages/autopilot', 'packages/autopilot'],
      ['build:packages/sdk', 'packages/sdk'],
      ['typecheck:packages/autopilot', 'packages/autopilot'],
      ['test:packages/autopilot', 'packages/autopilot'],
    ]);
    expect(evidence.commands.every((entry) => entry.status === 'passed'
      && entry.exitCode === 0)).toBe(true);
    // The strict decoder rejects evidence whose `verifiedAt` predates a
    // command, or whose command completes before it starts.
    const stamps = evidence.commands.flatMap(
      (entry) => [entry.startedAt, entry.completedAt],
    );
    expect([...stamps].sort()).toEqual(stamps);
    expect(evidence.verifiedAt >= stamps[stamps.length - 1]!).toBe(true);
    expect(stamps.every((stamp) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
      .test(stamp))).toBe(true);
  });

  // The evidence type can only express `status: 'passed'` / `exitCode: 0`. A
  // port that records a non-zero exit anyway produces evidence asserting a
  // failing typecheck succeeded, and the patch is committed on it. The run must
  // also stop dead: later commands would run against known-broken code.
  it('stops at the first failing command and calls it a stable rejection', async () => {
    const attempted: string[] = [];
    const port = createSequentialMarketplaceVerificationPort({
      now: clock(),
      run: async ({ command }) => {
        attempted.push(command.label);
        return command.label.startsWith('typecheck:')
          ? { exitCode: 2, stdoutDigest: digestOf('a'), stderrDigest: digestOf('b') }
          : { exitCode: 0, stdoutDigest: digestOf('c'), stderrDigest: digestOf('d') };
      },
    });

    await expect(port.verify(verifyInput)).rejects.toMatchObject({
      name: 'MarketplaceVerificationError',
      reason: 'command-failed',
      disposition: 'stable-rejection',
    });
    expect(attempted).toEqual([
      'install:packages/sdk',
      'install:packages/autopilot',
      'build:packages/sdk',
      'typecheck:packages/autopilot',
    ]);
  });

  // Install is the only network-enabled command. A registry outage exits
  // non-zero too, and blaming that on the solver publishes a rejection receipt
  // for a patch whose verification never actually ran.
  it('classifies an install non-zero exit as recoverable rather than a verdict', async () => {
    const port = createSequentialMarketplaceVerificationPort({
      now: clock(),
      run: async ({ command }) => (
        command.label.startsWith('install:')
          ? { exitCode: 1, stdoutDigest: digestOf('a'), stderrDigest: digestOf('b') }
          : { exitCode: 0, stdoutDigest: digestOf('c'), stderrDigest: digestOf('d') }
      ),
    });

    await expect(port.verify(verifyInput)).rejects.toMatchObject({
      name: 'MarketplaceVerificationError',
      reason: 'command-failed',
      disposition: 'recoverable',
    });
  });

  // The deadline guard must reject malformed timestamps before any command
  // runs, and classify them as abandoned rather than a solver verdict.
  it('abandons when the adoption deadline is not an exact UTC timestamp', async () => {
    const attempted: string[] = [];
    const port = createSequentialMarketplaceVerificationPort({
      run: async ({ command }) => {
        attempted.push(command.label);
        return { exitCode: 0, stdoutDigest: digestOf('a'), stderrDigest: digestOf('b') };
      },
    });

    await expect(port.verify({ ...verifyInput, deadline: 'not-a-timestamp' }))
      .rejects.toMatchObject({
        name: 'MarketplaceVerificationError',
        reason: 'invalid-deadline',
        disposition: 'abandoned',
      });
    expect(attempted).toEqual([]);
  });

  // Starting a sandbox whose adoption window already closed burns minutes of
  // CPU on work whose result can never be adopted, and leaves a container
  // running past the point the coordinator stops waiting for it.
  it('runs nothing when the adoption deadline has already passed', async () => {
    const attempted: string[] = [];
    const port = createSequentialMarketplaceVerificationPort({
      now: clock('2020-01-01T03:00:00.000Z'),
      run: async ({ command }) => {
        attempted.push(command.label);
        return { exitCode: 0, stdoutDigest: digestOf('a'), stderrDigest: digestOf('b') };
      },
    });

    await expect(port.verify(verifyInput)).rejects.toMatchObject({
      name: 'MarketplaceVerificationError',
      reason: 'deadline-expired',
      disposition: 'abandoned',
    });
    expect(attempted).toEqual([]);
  });

  // Checking only before the first command lets a slow install carry the run
  // hours past the adoption window: every later command still starts, and the
  // coordinator has long since stopped waiting.
  it('stops before the next command once the deadline passes mid-run', async () => {
    const attempted: string[] = [];
    const port = createSequentialMarketplaceVerificationPort({
      now: clock(),
      run: async ({ command }) => {
        attempted.push(command.label);
        return { exitCode: 0, stdoutDigest: digestOf('a'), stderrDigest: digestOf('b') };
      },
    });

    await expect(port.verify({ ...verifyInput, deadline: '2020-01-01T00:00:03.000Z' }))
      .rejects.toMatchObject({
        name: 'MarketplaceVerificationError',
        reason: 'deadline-expired',
        disposition: 'abandoned',
      });
    expect(attempted).toEqual(['install:packages/sdk']);
  });

  // A dead daemon is not a verdict on the patch. Letting the raw error escape
  // leaves Task 8 with nothing to classify on, and the safe-looking default —
  // treating any thrown error as a failed verification — publishes a rejection
  // receipt blaming a solver whose patch was never actually run.
  it('classifies a runner fault as recoverable rather than a verdict', async () => {
    const fault = new Error('cannot connect to the Docker daemon');
    const port = createSequentialMarketplaceVerificationPort({
      now: clock(),
      run: async () => { throw fault; },
    });

    await expect(port.verify(verifyInput)).rejects.toMatchObject({
      name: 'MarketplaceVerificationError',
      reason: 'runner-failed',
      disposition: 'recoverable',
      cause: fault,
    });
  });

  // The sandbox raises its own classified failures — an unsafe teardown above
  // all. Re-wrapping those as `recoverable` tells the coordinator to retry, and
  // each retry strands another container holding the attempt worktree.
  it('preserves a classified failure the runner raised itself', async () => {
    const port = createSequentialMarketplaceVerificationPort({
      now: clock(),
      run: async () => {
        throw new MarketplaceVerificationError(
          'unsafe-cleanup',
          'unsafe',
          'container teardown could not be confirmed',
        );
      },
    });

    await expect(port.verify(verifyInput)).rejects.toMatchObject({
      name: 'MarketplaceVerificationError',
      reason: 'unsafe-cleanup',
      disposition: 'unsafe',
    });
  });

  // Task 4's review caught a fixture the strict, exact-key decoder would have
  // rejected. Asserting the shape of what this port returns proves nothing;
  // only the real decoder does. If this evidence cannot be persisted, the
  // adoption crashes *after* the sandbox ran and can never resume.
  it('produces evidence the execution-state decoder accepts unchanged', async () => {
    const port = createSequentialMarketplaceVerificationPort({ run: passing, now: clock() });

    const evidence = await port.verify(verifyInput);

    const decoded = decodeMarketplaceExecutionV3State(
      solutionVerifiedState(evidence),
      DECODER_ATTEMPT_DIR,
    );
    expect(decoded.status).toBe('solution-verified');
    expect(decoded.status === 'solution-verified' && decoded.verification).toEqual(evidence);
    expect(Object.keys(evidence).sort()).toEqual([
      'artifactDigest', 'commands', 'expectedTree', 'planDigest', 'profile', 'verifiedAt',
    ]);
    expect(Object.keys(evidence.commands[0]!).sort()).toEqual([
      'args', 'command', 'completedAt', 'cwdRelative', 'exitCode', 'label',
      'startedAt', 'status', 'stderrDigest', 'stdoutDigest',
    ]);
  });
});
