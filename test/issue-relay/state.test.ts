import { describe, expect, it } from 'vitest';
import { relayGeneration, relayTaskKey } from '../../src/issue-relay/identity.js';
import { buildRelaySnapshot } from '../../src/issue-relay/snapshot.js';
import type { RelayIssueInput } from '../../src/issue-relay/snapshot.js';
import {
  deriveRelayAction,
  deriveRelayReady,
  persistRelayCancellation,
  type RelayAuthoritativeFacts,
  type RelayGenerationRecordV1,
  type RelayPhase,
  type RelayReadyInput,
  type RelayRoundRecordV1,
} from '../../src/issue-relay/state.js';
import {
  aggregateRelayChecks,
  relayAdoptionReceiptDigest,
} from '../../src/issue-relay/checks.js';
import type { AcceptedRelayAdoption } from '../../src/issue-relay/adoption.js';
import type { VerifiedIssueRelayVerdictObservation } from '../../src/issue-relay/marketplace-cli.js';

const BASE = '1111111111111111111111111111111111111111';
const HEAD = '2222222222222222222222222222222222222222';
const STALE = '3333333333333333333333333333333333333333';
const DIGEST = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

const issueInput: RelayIssueInput = {
  repository: {
    slug: 'Jinn-Network/mono',
    nodeId: 'R_kgDOExample',
    visibility: 'PUBLIC',
    defaultBranch: 'main',
    baseOid: BASE,
  },
  issue: {
    number: 42,
    url: 'https://github.com/Jinn-Network/mono/issues/42',
    title: 'Fix the relay',
    body: '## Acceptance\n\n- [ ] exact-head evaluation passes',
    authorLogin: 'alice',
    authorId: 'U_kgDOAlice',
    updatedAt: '2026-07-28T12:00:00.000Z',
  },
  optIn: {
    label: 'engine:marketplace',
    actorLogin: 'alice',
    createdAt: '2026-07-28T12:00:01.000Z',
    permission: 'MAINTAIN',
  },
  language: 'typescript',
  verificationProfile: 'jinn-mono.v1',
  acceptanceEvidence: ['exact-head evaluation passes'],
  admissionPolicyVersion: 'jinn-issue-relay-admission.v1',
  capturedAt: '2026-07-28T12:00:02.000Z',
};

const snapshot = buildRelaySnapshot(issueInput);
const generation = relayGeneration(snapshot);

const task = {
  taskKey: relayTaskKey(generation, 0),
  taskId: '501',
  taskCid: `f01551220${'4'.repeat(64)}`,
  spendWei: '1000000000000000',
  fundedAt: '2026-07-28T12:05:00.000Z',
};
const solution = {
  envelopeCid: `f01551220${'c'.repeat(64)}`,
  operatorSafe: `0x${'a'.repeat(40)}`,
  observedAt: '2026-07-28T12:10:00.000Z',
};
const acceptedAdoption: AcceptedRelayAdoption = {
  status: 'accepted',
  branch: 'jinn/issue-relay/example',
  resultingHead: HEAD,
  prNumber: 68,
  receipt: {
    schemaVersion: 'jinn-issue-relay-adoption.v1',
    disposition: 'accepted',
    correlation: {
      generation,
      round: 0,
      snapshotDigest: snapshot.snapshotDigest,
      taskId: task.taskId,
      attemptIndex: 0,
      requestId: `0x${'b'.repeat(64)}`,
      deliveryEnvelopeCid: solution.envelopeCid,
    },
    targetRepository: 'Jinn-Network/mono',
    workspaceRepository: 'Jinn-Network/mono',
    issueNumber: 42,
    prNumber: 68,
    headRef: 'jinn/issue-relay/example',
    inputHead: BASE,
    resultingHead: HEAD,
    patchDigest: `sha256:${'d'.repeat(64)}`,
    solutionSafe: solution.operatorSafe,
    adoptedAt: '2026-07-28T12:15:00.000Z',
  },
};
const readyChecks = aggregateRelayChecks({
  head: HEAD,
  branchRequiredChecks: [],
  profile: { name: 'jinn-mono.v1', requiredChecks: [] },
  checks: [],
});
const evaluationAnchor = {
  schemaVersion: 'jinn-issue-relay-evaluation-anchor.v1' as const,
  correlation: acceptedAdoption.receipt.correlation,
  targetRepository: 'Jinn-Network/mono',
  workspaceRepository: 'Jinn-Network/mono',
  prNumber: 68,
  targetBase: 'main',
  baseOid: BASE,
  headRef: acceptedAdoption.branch,
  evaluatedHead: HEAD,
  adoptionReceiptDigest: relayAdoptionReceiptDigest(acceptedAdoption),
  checksDigest: readyChecks.digest,
  anchoredAt: '2026-07-28T12:20:00.000Z',
};
const authenticatedVerdict: VerifiedIssueRelayVerdictObservation = {
  status: 'verified',
  role: 'verdict',
  task: {
    taskId: task.taskId,
    taskCid: task.taskCid,
  },
  attempt: {
    attemptIndex: 0,
    requestId: acceptedAdoption.receipt.correlation.requestId,
    operator: `0x${'e'.repeat(40)}`,
  },
  delivery: {
    envelopeCid: `f01551220${'f'.repeat(64)}`,
    transactionHash: `0x${'6'.repeat(64)}`,
    blockNumber: 130,
  },
  round: {
    schemaVersion: 'jinn-issue-relay-round.v1',
    generation,
    round: 0,
    snapshotDigest: snapshot.snapshotDigest,
    targetRepository: 'Jinn-Network/mono',
    workspaceRepository: 'Jinn-Network/mono',
    inputHead: BASE,
    purpose: 'initial',
    findings: [],
  },
  payload: {
    schemaVersion: 'jinn-issue-relay-verdict.v1',
    outcome: 'pass',
    correlation: acceptedAdoption.receipt.correlation,
    evaluatedHead: HEAD,
    summary: 'The complete head passes independent evaluation.',
    findings: [],
  },
};
const adoption = {
  disposition: 'accepted' as const,
  resultingHead: HEAD,
  receiptDigest: evaluationAnchor.adoptionReceiptDigest,
};
const passedChecks = {
  head: HEAD,
  status: 'passed' as const,
  digest: readyChecks.digest,
};
const passingVerdict = {
  outcome: 'pass' as const,
  evaluatedHead: HEAD,
  envelopeCid: authenticatedVerdict.delivery.envelopeCid,
};
const repairVerdict = {
  outcome: 'request-changes' as const,
  evaluatedHead: HEAD,
  envelopeCid: 'bafy-verdict-repair',
};

function completedInitialRound(): RelayRoundRecordV1 {
  return round({
    task,
    solution,
    adoption,
    checks: passedChecks,
    verdict: repairVerdict,
  });
}

function deliveredRepairRound(inputHead: string): RelayRoundRecordV1 {
  return {
    round: 1,
    purpose: 'repair',
    workspaceRepository: 'Jinn-Network/mono-fork',
    inputHead,
    task: {
      taskKey: relayTaskKey(generation, 1),
      taskId: 'task-1',
      taskCid: 'bafy-task-1',
      spendWei: '1000000000000000',
      fundedAt: '2026-07-28T12:21:00.000Z',
    },
    solution: {
      envelopeCid: 'bafy-solution-1',
      operatorSafe: '0x1111111111111111111111111111111111111111',
      observedAt: '2026-07-28T12:25:00.000Z',
    },
  };
}

function round(overrides: Partial<RelayRoundRecordV1> = {}): RelayRoundRecordV1 {
  return {
    round: 0,
    purpose: 'initial',
    workspaceRepository: 'Jinn-Network/mono',
    inputHead: BASE,
    ...overrides,
  };
}

function durable(
  phase: RelayPhase,
  overrides: Partial<RelayGenerationRecordV1> = {},
): RelayGenerationRecordV1 {
  return {
    schemaVersion: 'jinn-issue-relay-generation.v1',
    generation,
    snapshot,
    phase,
    deadlineAt: '2026-07-28T13:00:02.000Z',
    rounds: [],
    updatedAt: '2026-07-28T12:20:00.000Z',
    ...overrides,
  };
}

function facts(
  record: RelayGenerationRecordV1 | undefined,
  overrides: Partial<RelayAuthoritativeFacts> = {},
): RelayAuthoritativeFacts {
  return {
    ...(record === undefined ? {} : { durable: record }),
    issue: { open: true, optedIn: true },
    currentBaseOid: BASE,
    now: '2026-07-28T12:30:00.000Z',
    ...overrides,
  };
}

const policy = {
  maxRoundsPerGeneration: 3,
  generationDeadlineMs: 60 * 60 * 1_000,
};

function readyInput(
  overrides: Partial<RelayReadyInput> = {},
): RelayReadyInput {
  return {
    currentHead: HEAD,
    currentBaseOid: BASE,
    targetBase: 'main',
    draft: {
      number: 68,
      branch: acceptedAdoption.branch,
      head: HEAD,
      base: 'main',
      open: true,
      draft: true,
      generation,
    },
    adoption: acceptedAdoption,
    checks: readyChecks,
    evaluationAnchor,
    verdict: authenticatedVerdict,
    cancelled: false,
    exhausted: false,
    ...overrides,
  };
}

function livePr(head = HEAD) {
  return {
    number: 68,
    branch: acceptedAdoption.branch,
    head,
    base: 'main',
    open: true,
    draft: true,
    generation,
  };
}

describe('pure exact-head Relay readiness', () => {
  it('returns draft-missing when the exact draft PR fact is absent', () => {
    expect(deriveRelayReady(readyInput({ draft: undefined })))
      .toEqual({ ready: false, reason: 'draft-missing' });
  });

  it('returns draft-missing when the live draft PR is closed', () => {
    expect(deriveRelayReady(readyInput({
      draft: {
        ...readyInput().draft!,
        open: false,
      },
    } as unknown as Partial<RelayReadyInput>)))
      .toEqual({ ready: false, reason: 'draft-missing' });
  });

  it('returns checks-pending when a required check is pending', () => {
    const checks = aggregateRelayChecks({
      head: HEAD,
      branchRequiredChecks: [{ name: 'build', appId: 101 }],
      profile: { name: 'jinn-mono.v1', requiredChecks: [] },
      checks: [{
        kind: 'check-run',
        name: 'build',
        appId: 101,
        head: HEAD,
        status: 'queued',
        conclusion: null,
      }],
    });
    expect(deriveRelayReady(readyInput({
      checks,
      evaluationAnchor: undefined,
    }))).toEqual({ ready: false, reason: 'checks-pending' });
  });

  it('returns checks-failed when a required check failed', () => {
    const checks = aggregateRelayChecks({
      head: HEAD,
      branchRequiredChecks: [{ name: 'build', appId: 101 }],
      profile: { name: 'jinn-mono.v1', requiredChecks: [] },
      checks: [{
        kind: 'check-run',
        name: 'build',
        appId: 101,
        head: HEAD,
        status: 'completed',
        conclusion: 'failure',
      }],
    });
    expect(deriveRelayReady(readyInput({
      checks,
      evaluationAnchor: undefined,
    }))).toEqual({ ready: false, reason: 'checks-failed' });
  });

  it('returns verdict-pending when no authenticated verdict has arrived', () => {
    expect(deriveRelayReady(readyInput({ verdict: undefined })))
      .toEqual({ ready: false, reason: 'verdict-pending' });
  });

  it('returns verdict-failed when the evaluator is not distinct', () => {
    expect(deriveRelayReady(readyInput({
      verdict: {
        ...authenticatedVerdict,
        attempt: {
          ...authenticatedVerdict.attempt,
          operator: acceptedAdoption.receipt.solutionSafe.toUpperCase()
            .replace('0X', '0x'),
        },
      },
    }))).toEqual({ ready: false, reason: 'verdict-failed' });
  });

  it.each([
    [
      'a noncanonical accepted adoption receipt',
      {
        adoption: {
          ...acceptedAdoption,
          receipt: {
            ...acceptedAdoption.receipt,
            untrusted: true,
          },
        },
      },
      'verdict-failed',
    ],
    [
      'a noncanonical evaluation anchor',
      {
        evaluationAnchor: {
          ...evaluationAnchor,
          untrusted: true,
        },
      },
      'verdict-failed',
    ],
    [
      'a pending marketplace observation',
      {
        verdict: {
          status: 'pending',
          reason: 'verdict-not-delivered',
        },
      },
      'verdict-pending',
    ],
    [
      'a solution-shaped marketplace observation',
      {
        verdict: {
          ...authenticatedVerdict,
          role: 'solution',
          payload: {
            schemaVersion: 'jinn-repo-solution.v1',
            patch: 'diff --git a/a b/a\n',
          },
        },
      },
      'verdict-failed',
    ],
    [
      'a verdict payload missing correlation',
      {
        verdict: {
          ...authenticatedVerdict,
          payload: {
            schemaVersion: 'jinn-issue-relay-verdict.v1',
            outcome: 'pass',
            evaluatedHead: HEAD,
            summary: 'Forged without correlation.',
            findings: [],
          },
        },
      },
      'verdict-failed',
    ],
    [
      'a noncanonical verified verdict observation',
      {
        verdict: {
          ...authenticatedVerdict,
          untrusted: true,
        },
      },
      'verdict-failed',
    ],
  ] as const)('fails closed without throwing for %s', (
    _label,
    overrides,
    reason,
  ) => {
    expect(deriveRelayReady(readyInput(
      overrides as unknown as Partial<RelayReadyInput>,
    ))).toEqual({ ready: false, reason });
  });

  it('returns stale-head when any approval belongs to another current head', () => {
    expect(deriveRelayReady(readyInput({ currentHead: STALE })))
      .toEqual({ ready: false, reason: 'stale-head' });
  });

  it('returns stale-base when the evaluation anchor names another base', () => {
    expect(deriveRelayReady(readyInput({ currentBaseOid: STALE })))
      .toEqual({ ready: false, reason: 'stale-base' });
  });

  it('returns stale-base when the live PR was retargeted without a head change', () => {
    expect(deriveRelayReady(readyInput({
      draft: {
        ...readyInput().draft!,
        base: 'release',
      },
    }))).toEqual({ ready: false, reason: 'stale-base' });
  });

  it('returns stale-head when the live PR marker belongs to another generation', () => {
    expect(deriveRelayReady(readyInput({
      draft: {
        ...readyInput().draft!,
        generation: 'other-generation',
      },
    }))).toEqual({ ready: false, reason: 'stale-head' });
  });

  it('returns stale-head when the live PR branch differs from the adoption', () => {
    expect(deriveRelayReady(readyInput({
      draft: {
        ...readyInput().draft!,
        branch: 'jinn/issue-relay/other',
      },
    }))).toEqual({ ready: false, reason: 'stale-head' });
  });

  it('returns cancelled even if every exact-head approval passed', () => {
    expect(deriveRelayReady(readyInput({ cancelled: true })))
      .toEqual({ ready: false, reason: 'cancelled' });
  });

  it('returns exhausted even if every exact-head approval passed', () => {
    expect(deriveRelayReady(readyInput({ exhausted: true })))
      .toEqual({ ready: false, reason: 'exhausted' });
  });

  it('returns ready only for an exact draft, base, checks, and distinct evaluator pass', () => {
    expect(deriveRelayReady(readyInput())).toEqual({ ready: true, head: HEAD });
  });
});

describe('Relay state/action transition table', () => {
  it('missing durable snapshot -> publish-snapshot', () => {
    expect(deriveRelayAction(facts(undefined), policy))
      .toEqual({ kind: 'publish-snapshot' });
  });

  it('missing durable snapshot plus absent opt-in -> none', () => {
    expect(deriveRelayAction(facts(undefined, {
      issue: { open: true, optedIn: false },
    }), policy)).toMatchObject({ kind: 'none' });
  });

  it('admitted with exact base -> persist funding intent before submit-round 0', () => {
    expect(deriveRelayAction(facts(durable('admitted')), policy))
      .toEqual({ kind: 'prepare-round', round: 0 });
  });

  it('funding intent with exact immutable spend -> submit-round 0', () => {
    const record = durable('funding', {
      rounds: [{
        round: 0,
        purpose: 'initial',
        workspaceRepository: 'Jinn-Network/mono',
        inputHead: BASE,
        fundingIntent: {
          taskKey: relayTaskKey(generation, 0),
          creatorSafe: `0x${'1'.repeat(40)}`,
          solverNetManifestCid: `f01551220${'2'.repeat(64)}`,
          requestDigest: `sha256:${'3'.repeat(64)}`,
          maximumSpendWei: '2000000000000000',
          spendWei: '1000000000000000',
          preparedAt: '2026-07-28T12:04:00.000Z',
        },
      }],
    });

    expect(deriveRelayAction(facts(record), policy))
      .toEqual({ kind: 'submit-round', round: 0 });
  });

  it('admitted with a stale snapshot base -> none', () => {
    expect(deriveRelayAction(facts(durable('admitted'), {
      currentBaseOid: STALE,
    }), policy)).toMatchObject({ kind: 'none' });
  });

  it('admitted with a zero-round budget -> close-exhausted', () => {
    expect(deriveRelayAction(facts(durable('admitted')), {
      ...policy,
      maxRoundsPerGeneration: 0,
    })).toEqual({ kind: 'close-exhausted' });
  });

  it('submitted with funded task evidence -> observe-solution', () => {
    const record = durable('submitted', { rounds: [round({ task })] });

    expect(deriveRelayAction(facts(record), policy))
      .toEqual({ kind: 'observe-solution', round: 0 });
  });

  it('solution-delivered with authenticated delivery -> adopt-solution', () => {
    const record = durable('solution-delivered', {
      rounds: [round({ task, solution })],
    });

    expect(deriveRelayAction(facts(record), policy))
      .toEqual({ kind: 'adopt-solution', round: 0 });
  });

  it('solution-delivered without authenticated delivery evidence -> none', () => {
    const record = durable('solution-delivered', {
      rounds: [round({ task })],
    });

    expect(deriveRelayAction(facts(record), policy)).toMatchObject({ kind: 'none' });
  });

  it('repair delivery with an arbitrary input head cannot be adopted', () => {
    const record = durable('solution-delivered', {
      rounds: [completedInitialRound(), deliveredRepairRound(STALE)],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: STALE, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: livePr(STALE),
    }), policy)).toMatchObject({ kind: 'none' });
  });

  it.each([
    ['missing durable PR', undefined, livePr()],
    [
      'different live PR number',
      { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
      { ...livePr(), number: 69 },
    ],
    [
      'non-draft live PR',
      { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
      { ...livePr(), draft: false },
    ],
  ] as const)('repair delivery with %s cannot be adopted', (_label, pr, currentPr) => {
    const record = durable('solution-delivered', {
      rounds: [completedInitialRound(), deliveredRepairRound(HEAD)],
      ...(pr === undefined ? {} : { pr }),
    });

    expect(deriveRelayAction(facts(record, { currentPr }), policy))
      .toMatchObject({ kind: 'none' });
  });

  it('draft-open with accepted adoption and passed exact-head checks -> publish-evaluation-anchor', () => {
    const record = durable('draft-open', {
      rounds: [round({ task, solution, adoption, checks: passedChecks })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: livePr(),
    }), policy)).toEqual({ kind: 'publish-evaluation-anchor', round: 0 });
  });

  it('draft-open with a retargeted live PR cannot publish an evaluation anchor', () => {
    const record = durable('draft-open', {
      rounds: [round({ task, solution, adoption, checks: passedChecks })],
      pr: {
        number: 68,
        branch: acceptedAdoption.branch,
        head: HEAD,
        draft: true,
      },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: { ...livePr(), base: 'release' },
    }), policy)).toMatchObject({ kind: 'none' });
  });

  it.each([
    ['missing adoption', round({ task, solution, checks: passedChecks })],
    ['rejected adoption', round({
      task,
      solution,
      adoption: { disposition: 'rejected', receiptDigest: DIGEST },
      checks: passedChecks,
    })],
    ['failed checks', round({
      task,
      solution,
      adoption,
      checks: { ...passedChecks, status: 'failed' },
    })],
  ])('draft-open with %s -> none', (_label, currentRound) => {
    const record = durable('draft-open', {
      rounds: [currentRound],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: livePr(),
    }), policy)).toMatchObject({ kind: 'none' });
  });

  it.each([
    ['missing', round({ task, solution, adoption })],
    ['pending', round({
      task,
      solution,
      adoption,
      checks: { ...passedChecks, status: 'pending' },
    })],
  ])('draft-open with %s checks -> observe exact-head checks', (_label, currentRound) => {
    const record = durable('draft-open', {
      rounds: [currentRound],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: livePr(),
    }), policy)).toEqual({ kind: 'observe-checks', round: 0 });
  });

  it('draft-open cannot skip authenticated delivery evidence -> none', () => {
    const record = durable('draft-open', {
      rounds: [round({ adoption, checks: passedChecks })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: livePr(),
    }), policy)).toMatchObject({ kind: 'none' });
  });

  it('draft-open with a stale live PR head -> none', () => {
    const record = durable('draft-open', {
      rounds: [round({ task, solution, adoption, checks: passedChecks })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: livePr(STALE),
    }), policy)).toMatchObject({ kind: 'none' });
  });

  it('evaluating with an exact anchor and no verdict -> observe-verdict', () => {
    const record = durable('evaluating', {
      rounds: [round({ task, solution, adoption, checks: passedChecks })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: livePr(),
    }), policy)).toEqual({ kind: 'observe-verdict', round: 0 });
  });

  it('evaluating with a passing exact-head verdict -> mark-ready', () => {
    const record = durable('evaluating', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: passingVerdict,
      })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: livePr(),
      readiness: {
        adoption: acceptedAdoption,
        checks: readyChecks,
        evaluationAnchor,
        verdict: authenticatedVerdict,
      },
    }), policy)).toEqual({ kind: 'mark-ready' });
  });

  it('evaluating cannot promote minimal marker evidence without authenticated readiness facts', () => {
    const record = durable('evaluating', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: passingVerdict,
      })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: livePr(),
    }), policy)).toMatchObject({ kind: 'none' });
  });

  it('evaluating never promotes a TypeScript-shaped forged anchor', () => {
    const record = durable('evaluating', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: passingVerdict,
      })],
      pr: {
        number: 68,
        branch: acceptedAdoption.branch,
        head: HEAD,
        draft: true,
      },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: livePr(),
      readiness: {
        adoption: acceptedAdoption,
        checks: readyChecks,
        evaluationAnchor: {
          ...evaluationAnchor,
          untrusted: true,
        } as unknown as typeof evaluationAnchor,
        verdict: authenticatedVerdict,
      },
    }), policy)).toMatchObject({ kind: 'none' });
  });

  it('evaluating never marks a closed draft PR ready', () => {
    const record = durable('evaluating', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: passingVerdict,
      })],
      pr: {
        number: 68,
        branch: acceptedAdoption.branch,
        head: HEAD,
        draft: true,
      },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: {
        ...livePr(),
        open: false,
      } as unknown as RelayAuthoritativeFacts['currentPr'],
      readiness: {
        adoption: acceptedAdoption,
        checks: readyChecks,
        evaluationAnchor,
        verdict: authenticatedVerdict,
      },
    }), policy)).toMatchObject({ kind: 'none' });
  });

  it('replays readiness after the exact pull request mutation committed before its marker', () => {
    const record = durable('evaluating', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: passingVerdict,
      })],
      pr: {
        number: 68,
        branch: acceptedAdoption.branch,
        head: HEAD,
        draft: true,
      },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: { ...livePr(), draft: false },
      readiness: {
        adoption: acceptedAdoption,
        checks: readyChecks,
        evaluationAnchor,
        verdict: authenticatedVerdict,
      },
    }), policy)).toEqual({ kind: 'mark-ready' });
  });

  it('evaluating does not carry readiness across contradictory Task delivery facts', () => {
    const record = durable('evaluating', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: passingVerdict,
      })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: livePr(),
      readiness: {
        adoption: acceptedAdoption,
        checks: readyChecks,
        evaluationAnchor,
        verdict: {
          ...authenticatedVerdict,
          task: {
            ...authenticatedVerdict.task,
            taskCid: `f01551220${'9'.repeat(64)}`,
          },
        },
      },
    }), policy)).toMatchObject({ kind: 'none' });
  });

  it('evaluating with pass on a stale live head -> none', () => {
    const record = durable('evaluating', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: passingVerdict,
      })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: livePr(STALE),
    }), policy)).toMatchObject({ kind: 'none' });
  });

  it('evaluating with pass after the base advances -> none', () => {
    const record = durable('evaluating', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: passingVerdict,
      })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentBaseOid: STALE,
      currentPr: livePr(),
    }), policy)).toMatchObject({ kind: 'none' });
  });

  it('repair-needed with request changes -> persist the next funding intent before submission', () => {
    const record = durable('repair-needed', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: repairVerdict,
      })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: livePr(),
    }), policy)).toEqual({ kind: 'prepare-round', round: 1 });
  });

  it('repair-needed at the round limit -> close-exhausted', () => {
    const record = durable('repair-needed', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: repairVerdict,
      })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: livePr(),
    }), { ...policy, maxRoundsPerGeneration: 1 }))
      .toEqual({ kind: 'close-exhausted' });
  });

  it('repair-needed at its immutable deadline -> close-exhausted', () => {
    const record = durable('repair-needed', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: repairVerdict,
      })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: livePr(),
      now: '2026-07-28T13:00:02.000Z',
    }), policy)).toEqual({ kind: 'close-exhausted' });
  });

  it('uses the durable deadline instead of recomputing it from policy on continuation', () => {
    const record = durable('repair-needed', {
      deadlineAt: '2026-07-28T13:00:02.000Z',
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: repairVerdict,
      })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      currentPr: livePr(),
    }), { ...policy, generationDeadlineMs: 1 }))
      .toEqual({ kind: 'prepare-round', round: 1 });
    expect(record.deadlineAt).toBe('2026-07-28T13:00:02.000Z');
  });

  it.each([
    ['closed issue', { open: false, optedIn: true }, 'issue-closed'],
    ['removed label', { open: true, optedIn: false }, 'label-removed'],
  ] as const)('%s after funding persists cancellation before settling', (
    _label,
    issue,
    reason,
  ) => {
    const record = durable('evaluating', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: passingVerdict,
      })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      issue,
      currentPr: livePr(),
    }), policy)).toEqual({ kind: 'record-cancellation', reason });
  });

  it('an operator request persists cancellation before any other action', () => {
    const record = durable('repair-needed', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: repairVerdict,
      })],
      pr: { number: 68, branch: acceptedAdoption.branch, head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(record, {
      operatorCancellationRequested: true,
      currentPr: livePr(),
    }), policy)).toEqual({
      kind: 'record-cancellation',
      reason: 'operator',
    });
  });

  it('persists pre-funding withdrawal so an admitted generation cannot submit later', () => {
    const admitted = durable('admitted');

    expect(deriveRelayAction(facts(admitted, {
      issue: { open: false, optedIn: true },
    }), policy)).toEqual({
      kind: 'record-cancellation',
      reason: 'issue-closed',
    });

    const cancelling = persistRelayCancellation(admitted, {
      requestedAt: '2026-07-28T12:30:00.000Z',
      reason: 'issue-closed',
    });
    expect(deriveRelayAction(facts(cancelling, {
      issue: { open: false, optedIn: true },
    }), policy)).toEqual({ kind: 'finish-cancellation' });
  });

  it('persists cancellation without mutating frozen round or PR evidence', () => {
    const current = durable('evaluating', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: passingVerdict,
      })],
      pr: { number: 68, branch: acceptedAdoption.branch, head: HEAD, draft: true },
    });

    const cancelled = persistRelayCancellation(current, {
      requestedAt: '2026-07-28T12:30:00.000Z',
      reason: 'issue-closed',
    });

    expect(cancelled).toEqual({
      ...current,
      phase: 'cancelling',
      cancellation: {
        requestedAt: '2026-07-28T12:30:00.000Z',
        reason: 'issue-closed',
      },
      updatedAt: '2026-07-28T12:30:00.000Z',
    });
    expect(current.cancellation).toBeUndefined();
    expect(cancelled.rounds).toEqual(current.rounds);
    expect(cancelled.pr).toEqual(current.pr);
  });

  it('replays the same persisted cancellation intent idempotently', () => {
    const cancelled = durable('cancelling', {
      rounds: [round({ task })],
      cancellation: {
        requestedAt: '2026-07-28T12:25:00.000Z',
        reason: 'operator',
      },
      updatedAt: '2026-07-28T12:25:00.000Z',
    });

    expect(persistRelayCancellation(cancelled, {
      requestedAt: '2026-07-28T12:25:00.000Z',
      reason: 'operator',
    })).toBe(cancelled);
  });

  it('a persisted cancellation observes only the already-funded current round', () => {
    const record = durable('cancelling', {
      rounds: [round({ task })],
      cancellation: {
        requestedAt: '2026-07-28T12:25:00.000Z',
        reason: 'operator',
      },
    });

    expect(deriveRelayAction(facts(record), policy))
      .toEqual({ kind: 'observe-solution', round: 0 });
  });

  it('a persisted cancellation settles an already-delivered current round', () => {
    const record = durable('cancelling', {
      rounds: [round({ task, solution })],
      cancellation: {
        requestedAt: '2026-07-28T12:25:00.000Z',
        reason: 'operator',
      },
    });

    expect(deriveRelayAction(facts(record), policy))
      .toEqual({ kind: 'adopt-solution', round: 0 });
  });

  it('a persisted cancellation finishes only after current adoption or rejection settles', () => {
    const record = durable('cancelling', {
      rounds: [round({ task, solution, adoption })],
      cancellation: {
        requestedAt: '2026-07-28T12:25:00.000Z',
        reason: 'operator',
      },
    });

    expect(deriveRelayAction(facts(record), policy))
      .toEqual({ kind: 'finish-cancellation' });
  });

  it('cancellation dominance never submits a repair or marks a passing head ready', () => {
    const repair = durable('repair-needed', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: repairVerdict,
      })],
      pr: { number: 68, branch: acceptedAdoption.branch, head: HEAD, draft: true },
    });
    const passing = durable('evaluating', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: passingVerdict,
      })],
      pr: { number: 68, branch: acceptedAdoption.branch, head: HEAD, draft: true },
    });

    expect(deriveRelayAction(facts(repair, {
      issue: { open: true, optedIn: false },
      currentPr: livePr(),
    }), policy)).toEqual({
      kind: 'record-cancellation',
      reason: 'label-removed',
    });
    expect(deriveRelayAction(facts(passing, {
      issue: { open: false, optedIn: true },
      currentPr: livePr(),
      readiness: {
        adoption: acceptedAdoption,
        checks: readyChecks,
        evaluationAnchor,
        verdict: authenticatedVerdict,
      },
    }), policy)).toEqual({
      kind: 'record-cancellation',
      reason: 'issue-closed',
    });
  });

  it.each([
    ['awaiting-clarification', durable('awaiting-clarification')],
    ['refused', durable('refused')],
    ['ready', durable('ready', {
      rounds: [round({
        task,
        solution,
        adoption,
        checks: passedChecks,
        verdict: passingVerdict,
      })],
      pr: { number: 68, branch: 'jinn/issue-relay/example', head: HEAD, draft: false },
    })],
    ['closed', durable('closed')],
    ['exhausted', durable('exhausted')],
  ] as const)('%s terminal -> none', (_phase, record) => {
    expect(deriveRelayAction(facts(record), policy)).toMatchObject({ kind: 'none' });
  });

  it.each([
    ['invalid now', facts(durable('admitted'), { now: 'not-a-time' })],
    ['missing immutable deadline', facts({
      ...durable('admitted'),
      deadlineAt: undefined,
    } as unknown as RelayGenerationRecordV1)],
  ])('%s fails closed -> none', (_label, inputFacts) => {
    expect(deriveRelayAction(inputFacts, policy)).toMatchObject({ kind: 'none' });
  });
});
