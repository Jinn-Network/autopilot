import { describe, expect, it } from 'vitest';
import type { AcceptedRelayAdoption } from '../../src/issue-relay/adoption.js';
import {
  aggregateRelayChecks,
  createRelayEvaluationAnchorPublisher,
  parseRelayEvaluationAnchorBlock,
  type RelayEvaluationAnchorPort,
  type RelayGitHubCheckFact,
} from '../../src/issue-relay/checks.js';
import {
  formatRelayAdoptionReceiptBlock,
  type RelayPullRequest,
} from '../../src/issue-relay/git-publisher.js';

const HEAD = '2'.repeat(40);
const BASE = '1'.repeat(40);
const DIGEST = `sha256:${'a'.repeat(64)}` as const;
const SOLUTION_SAFE = `0x${'a'.repeat(40)}`;

const adoption: AcceptedRelayAdoption = {
  status: 'accepted',
  branch: 'jinn/issue-relay/example',
  resultingHead: HEAD,
  prNumber: 68,
  receipt: {
    schemaVersion: 'jinn-issue-relay-adoption.v1',
    disposition: 'accepted',
    correlation: {
      generation: `R_kgDOExample:42:${DIGEST}`,
      round: 0,
      snapshotDigest: DIGEST,
      taskId: '501',
      attemptIndex: 0,
      requestId: `0x${'b'.repeat(64)}`,
      deliveryEnvelopeCid: `f01551220${'c'.repeat(64)}`,
    },
    targetRepository: 'Jinn-Network/mono',
    workspaceRepository: 'Jinn-Network/mono',
    issueNumber: 42,
    prNumber: 68,
    headRef: 'jinn/issue-relay/example',
    inputHead: BASE,
    resultingHead: HEAD,
    patchDigest: `sha256:${'d'.repeat(64)}`,
    solutionSafe: SOLUTION_SAFE,
    adoptedAt: '2026-07-28T12:00:00.000Z',
  },
};

const success: RelayGitHubCheckFact = {
  kind: 'check-run',
  name: 'build',
  head: HEAD,
  status: 'completed',
  conclusion: 'success',
  url: 'https://github.com/Jinn-Network/mono/actions/runs/1',
};

function aggregate(
  checks: readonly RelayGitHubCheckFact[],
  overrides: Partial<Parameters<typeof aggregateRelayChecks>[0]> = {},
) {
  return aggregateRelayChecks({
    head: HEAD,
    branchRequiredChecks: ['build'],
    profile: {
      name: 'jinn-mono.v1',
      requiredChecks: ['relay/typecheck'],
    },
    checks,
    ...overrides,
  });
}

describe('exact-head Relay check aggregation', () => {
  it('unions visible branch rules with configured profile checks and leaves optional failures non-gating', () => {
    const summary = aggregate([
      success,
      {
        kind: 'status-context',
        name: 'relay/typecheck',
        head: HEAD,
        state: 'success',
        url: 'https://ci.example/typecheck',
      },
      {
        kind: 'check-run',
        name: 'optional/coverage',
        head: HEAD,
        status: 'completed',
        conclusion: 'failure',
      },
    ]);

    expect(summary.required).toEqual([
      {
        name: 'build',
        status: 'passed',
        url: 'https://github.com/Jinn-Network/mono/actions/runs/1',
      },
      {
        name: 'relay/typecheck',
        status: 'passed',
        url: 'https://ci.example/typecheck',
      },
    ]);
    expect(summary.optional).toEqual([
      { name: 'optional/coverage', status: 'failed' },
    ]);
  });

  it('treats queued and in-progress check runs and pending status contexts as pending', () => {
    const summary = aggregate([
      { ...success, status: 'queued', conclusion: null },
      {
        kind: 'status-context',
        name: 'relay/typecheck',
        head: HEAD,
        state: 'pending',
      },
    ]);

    expect(summary.required.map(({ status }) => status))
      .toEqual(['pending', 'pending']);
  });

  it.each([
    'failure',
    'timed_out',
    'cancelled',
    'action_required',
    'startup_failure',
    'stale',
  ] as const)('normalizes completed %s check runs to failed', (conclusion) => {
    expect(aggregate([
      { ...success, conclusion },
      {
        kind: 'status-context',
        name: 'relay/typecheck',
        head: HEAD,
        state: 'success',
      },
    ]).required[0]?.status).toBe('failed');
  });

  it.each(['neutral', 'skipped'] as const)(
    'normalizes GitHub %s conclusions to passed',
    (conclusion) => {
      expect(aggregate([
        { ...success, conclusion },
        {
          kind: 'status-context',
          name: 'relay/typecheck',
          head: HEAD,
          state: 'success',
        },
      ]).required[0]?.status).toBe('passed');
    },
  );

  it('records an empty required set when GitHub exposes no usable checks', () => {
    expect(aggregate([])).toMatchObject({
      head: HEAD,
      required: [],
      optional: [],
    });
  });

  it('records configured or branch-required checks missing from a nonempty observation as pending', () => {
    expect(aggregate([success]).required).toEqual([
      {
        name: 'build',
        status: 'passed',
        url: 'https://github.com/Jinn-Network/mono/actions/runs/1',
      },
      { name: 'relay/typecheck', status: 'pending' },
    ]);
  });

  it('requires a branch-rule check from the exact GitHub App when one is pinned', () => {
    const wrongApp = aggregate([{
      ...success,
      appId: 202,
    }], {
      branchRequiredChecks: [{ name: 'build', appId: 101 }],
      profile: { name: 'jinn-mono.v1', requiredChecks: [] },
    });
    const correctApp = aggregate([{
      ...success,
      appId: 101,
    }], {
      branchRequiredChecks: [{ name: 'build', appId: 101 }],
      profile: { name: 'jinn-mono.v1', requiredChecks: [] },
    });

    expect(wrongApp.required).toEqual([
      { name: 'build', appId: 101, status: 'pending' },
    ]);
    expect(wrongApp.optional).toEqual([{
      name: 'build',
      appId: 202,
      status: 'passed',
      url: 'https://github.com/Jinn-Network/mono/actions/runs/1',
    }]);
    expect(correctApp.required).toEqual([{
      name: 'build',
      appId: 101,
      status: 'passed',
      url: 'https://github.com/Jinn-Network/mono/actions/runs/1',
    }]);
    expect(correctApp.optional).toEqual([]);
    expect(wrongApp.digest).not.toBe(correctApp.digest);
  });

  it('allows any producer only when a branch rule explicitly has no App pin', () => {
    expect(aggregate([{ ...success, appId: 202 }], {
      branchRequiredChecks: [{ name: 'build', appId: null }],
      profile: { name: 'jinn-mono.v1', requiredChecks: [] },
    }).required).toEqual([{
      name: 'build',
      appId: 202,
      status: 'passed',
      url: 'https://github.com/Jinn-Network/mono/actions/runs/1',
    }]);
  });

  it('rejects duplicate names instead of selecting an arbitrary delivery', () => {
    expect(() => aggregate([
      success,
      { ...success, conclusion: 'failure' },
    ])).toThrow(/duplicate.*build/i);
  });

  it('rejects stale-head and incomplete GitHub facts', () => {
    expect(() => aggregate([
      { ...success, head: '3'.repeat(40) },
    ])).toThrow(/head/i);
    expect(() => aggregate([
      { ...success, conclusion: null },
    ])).toThrow(/conclusion/i);
    expect(() => aggregate([
      { ...success, status: 'queued', conclusion: 'success' },
    ])).toThrow(/conclusion/i);
    expect(() => aggregate([
      {
        ...success,
        status: 'unknown',
        conclusion: null,
      } as unknown as RelayGitHubCheckFact,
    ])).toThrow(/status/i);
    expect(() => aggregate([
      {
        ...success,
        conclusion: 'unknown',
      } as unknown as RelayGitHubCheckFact,
    ])).toThrow(/conclusion/i);
  });

  it('sorts canonical entries and produces the same digest for any observation order', () => {
    const status = {
      kind: 'status-context',
      name: 'relay/typecheck',
      head: HEAD,
      state: 'success',
    } as const;
    const optional = {
      kind: 'check-run',
      name: 'analysis',
      head: HEAD,
      status: 'completed',
      conclusion: 'neutral',
    } as const;

    const left = aggregate([status, success, optional]);
    const right = aggregate([optional, success, status]);

    expect(left).toEqual(right);
    expect(left.required.map(({ name }) => name))
      .toEqual(['build', 'relay/typecheck']);
    expect(left.optional.map(({ name }) => name)).toEqual(['analysis']);
    expect(left.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('Relay evaluation-anchor publication', () => {
  function fixture() {
    const pr: RelayPullRequest = {
      targetRepositoryId: 'R_target',
      forkRepositoryId: 'R_fork',
      forkParentRepositoryId: 'R_target',
      number: 68,
      branch: adoption.branch,
      head: HEAD,
      base: 'main',
      open: true,
      draft: true,
      generation: adoption.receipt.correlation.generation,
    };
    let body = [
      '<!-- jinn-issue-relay:assurance:v1 -->',
      '',
      'IN PROGRESS',
      '',
      formatRelayAdoptionReceiptBlock(adoption.receipt),
    ].join('\n');
    const writes: string[] = [];
    const port: RelayEvaluationAnchorPort = {
      async readPullRequest() {
        return pr;
      },
      async listAssuranceComments() {
        return [{ id: 9, authorLogin: 'jinn-relay', body }];
      },
      async editAssuranceComment(input) {
        writes.push(input.body);
        body = input.body;
      },
    };
    return { port, pr, writes, body: () => body };
  }

  it('appends one strict anchor after exact required checks pass and parses exact readback', async () => {
    const current = fixture();
    const checks = aggregate([
      success,
      {
        kind: 'status-context',
        name: 'relay/typecheck',
        head: HEAD,
        state: 'success',
      },
    ]);
    const publisher = createRelayEvaluationAnchorPublisher({
      port: current.port,
      now: () => new Date('2026-07-28T12:10:00.000Z'),
    });

    const anchor = await publisher.publish({
      authority: {
        targetRepositoryId: 'R_target',
        forkRepositoryId: 'R_fork',
        forkParentRepositoryId: 'R_target',
      },
      targetRepository: 'Jinn-Network/mono',
      targetBase: 'main',
      serviceLogin: 'jinn-relay',
      pr: current.pr,
      currentBaseOid: BASE,
      adoption,
      checks,
    });

    expect(current.writes).toHaveLength(1);
    expect(parseRelayEvaluationAnchorBlock(current.body())).toEqual(anchor);
    expect(anchor).toMatchObject({
      correlation: adoption.receipt.correlation,
      targetRepository: 'Jinn-Network/mono',
      workspaceRepository: 'Jinn-Network/mono',
      prNumber: 68,
      targetBase: 'main',
      baseOid: BASE,
      headRef: adoption.branch,
      evaluatedHead: HEAD,
      checksDigest: checks.digest,
      anchoredAt: '2026-07-28T12:10:00.000Z',
    });

    expect(await publisher.publish({
      authority: {
        targetRepositoryId: 'R_target',
        forkRepositoryId: 'R_fork',
        forkParentRepositoryId: 'R_target',
      },
      targetRepository: 'Jinn-Network/mono',
      targetBase: 'main',
      serviceLogin: 'jinn-relay',
      pr: current.pr,
      currentBaseOid: BASE,
      adoption,
      checks,
    })).toEqual(anchor);
    expect(current.writes).toHaveLength(1);
  });

  it('does not publish for pending required checks or a stale adoption head', async () => {
    const current = fixture();
    const publisher = createRelayEvaluationAnchorPublisher({
      port: current.port,
      now: () => new Date('2026-07-28T12:10:00.000Z'),
    });
    const pending = aggregate([success]);

    await expect(publisher.publish({
      authority: {
        targetRepositoryId: 'R_target',
        forkRepositoryId: 'R_fork',
        forkParentRepositoryId: 'R_target',
      },
      targetRepository: 'Jinn-Network/mono',
      targetBase: 'main',
      serviceLogin: 'jinn-relay',
      pr: current.pr,
      currentBaseOid: BASE,
      adoption,
      checks: pending,
    })).rejects.toThrow(/required checks/i);
    await expect(publisher.publish({
      authority: {
        targetRepositoryId: 'R_target',
        forkRepositoryId: 'R_fork',
        forkParentRepositoryId: 'R_target',
      },
      targetRepository: 'Jinn-Network/mono',
      targetBase: 'main',
      serviceLogin: 'jinn-relay',
      pr: { ...current.pr, head: '3'.repeat(40) },
      currentBaseOid: BASE,
      adoption,
      checks: aggregate([
        { ...success, head: '3'.repeat(40) },
        {
          kind: 'status-context',
          name: 'relay/typecheck',
          head: '3'.repeat(40),
          state: 'success',
        },
      ], { head: '3'.repeat(40) }),
    })).rejects.toThrow(/head/i);
    expect(current.writes).toHaveLength(0);
  });

  it('does not publish through a repository target that contradicts the accepted receipt', async () => {
    const current = fixture();
    const publisher = createRelayEvaluationAnchorPublisher({
      port: current.port,
      now: () => new Date('2026-07-28T12:10:00.000Z'),
    });
    const checks = aggregate([
      success,
      {
        kind: 'status-context',
        name: 'relay/typecheck',
        head: HEAD,
        state: 'success',
      },
    ]);

    await expect(publisher.publish({
      authority: {
        targetRepositoryId: 'R_target',
        forkRepositoryId: 'R_fork',
        forkParentRepositoryId: 'R_target',
      },
      targetRepository: 'attacker/fork',
      targetBase: 'main',
      serviceLogin: 'jinn-relay',
      pr: current.pr,
      currentBaseOid: BASE,
      adoption,
      checks,
    })).rejects.toThrow(/repository/i);
    expect(current.writes).toHaveLength(0);
  });

  it('rejects a pull request marker from another generation before anchoring', async () => {
    const current = fixture();
    const publisher = createRelayEvaluationAnchorPublisher({
      port: current.port,
    });

    await expect(publisher.publish({
      authority: {
        targetRepositoryId: 'R_target',
        forkRepositoryId: 'R_fork',
        forkParentRepositoryId: 'R_target',
      },
      targetRepository: 'Jinn-Network/mono',
      targetBase: 'main',
      serviceLogin: 'jinn-relay',
      pr: { ...current.pr, generation: 'other-generation' },
      currentBaseOid: BASE,
      adoption,
      checks: aggregate([
        success,
        {
          kind: 'status-context',
          name: 'relay/typecheck',
          head: HEAD,
          state: 'success',
        },
      ]),
    })).rejects.toThrow(/generation|repository/i);
    expect(current.writes).toHaveLength(0);
  });

  it('rejects a retargeted pull request even when its head is unchanged', async () => {
    const current = fixture();
    const publisher = createRelayEvaluationAnchorPublisher({
      port: current.port,
    });

    await expect(publisher.publish({
      authority: {
        targetRepositoryId: 'R_target',
        forkRepositoryId: 'R_fork',
        forkParentRepositoryId: 'R_target',
      },
      targetRepository: 'Jinn-Network/mono',
      targetBase: 'main',
      serviceLogin: 'jinn-relay',
      pr: { ...current.pr, base: 'release' },
      currentBaseOid: BASE,
      adoption,
      checks: aggregate([
        success,
        {
          kind: 'status-context',
          name: 'relay/typecheck',
          head: HEAD,
          state: 'success',
        },
      ]),
    })).rejects.toThrow(/base|repository/i);
    expect(current.writes).toHaveLength(0);
  });

  it('re-reads the PR before returning an existing anchor', async () => {
    const current = fixture();
    const checks = aggregate([
      success,
      {
        kind: 'status-context',
        name: 'relay/typecheck',
        head: HEAD,
        state: 'success',
      },
    ]);
    const publisher = createRelayEvaluationAnchorPublisher({
      port: current.port,
    });
    const input = {
      authority: {
        targetRepositoryId: 'R_target',
        forkRepositoryId: 'R_fork',
        forkParentRepositoryId: 'R_target',
      },
      targetRepository: 'Jinn-Network/mono',
      targetBase: 'main',
      serviceLogin: 'jinn-relay',
      pr: current.pr,
      currentBaseOid: BASE,
      adoption,
      checks,
    } as const;
    await publisher.publish(input);

    let reads = 0;
    current.port.readPullRequest = async () => {
      reads += 1;
      return reads === 1 ? current.pr : { ...current.pr, head: '3'.repeat(40) };
    };

    await expect(publisher.publish(input)).rejects.toThrow(/changed|head/i);
    expect(reads).toBe(2);
  });
});
