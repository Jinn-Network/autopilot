import { describe, expect, it } from 'vitest';
import { admitRelayIssue } from '../../src/issue-relay/admission.js';
import type {
  RelayAdmissionPolicy,
  RelayIssueCandidateFacts,
  RelayLabelEvent,
} from '../../src/issue-relay/github-port.js';

const policy: RelayAdmissionPolicy = {
  repository: 'Jinn-Network/mono',
  label: 'engine:marketplace',
  maxIssueBytes: 4_096,
  maxAcceptanceItems: 3,
  forbiddenRequestPatterns: [
    /\bprivate key\b/i,
    /\bproduction secret\b/i,
  ],
};

const issue: RelayIssueCandidateFacts = {
  repository: {
    slug: 'Jinn-Network/mono',
    nodeId: 'R_kgDOExample',
    visibility: 'PUBLIC',
    defaultBranch: 'main',
  },
  issue: {
    number: 42,
    url: 'https://github.com/Jinn-Network/mono/issues/42',
    title: 'Keep the relay deterministic',
    body: [
      'Avoid order-dependent relay output.',
      '',
      '## Acceptance',
      '- [ ] The focused relay tests pass.',
    ].join('\n'),
    authorLogin: 'Alice',
    authorId: 'U_kgDOAlice',
    updatedAt: '2026-07-28T11:30:00.000Z',
    state: 'OPEN',
    isPullRequest: false,
    labels: ['engine:marketplace', 'kind:feature'],
  },
};

const labelEvents: readonly RelayLabelEvent[] = [
  {
    action: 'labeled',
    label: 'kind:feature',
    actorLogin: 'triager',
    actorId: 'U_kgDOTriager',
    createdAt: '2026-07-28T10:00:00.000Z',
  },
  {
    action: 'labeled',
    label: 'engine:marketplace',
    actorLogin: 'Alice',
    actorId: 'U_kgDOAlice',
    createdAt: '2026-07-28T11:00:00.000Z',
  },
];

const baseInput = {
  issue,
  labelEvents,
  currentPermission: 'WRITE' as const,
  currentBaseOid: '0123456789012345678901234567890123456789',
  policy,
  now: new Date('2026-07-28T12:00:00.000Z'),
};

describe('Relay issue admission authority', () => {
  it('admits a current WRITE author who applied the effective opt-in label', () => {
    const decision = admitRelayIssue(baseInput);

    expect(decision).toEqual({
      status: 'admitted',
      input: {
        repository: {
          slug: 'Jinn-Network/mono',
          nodeId: 'R_kgDOExample',
          visibility: 'PUBLIC',
          defaultBranch: 'main',
          baseOid: '0123456789012345678901234567890123456789',
        },
        issue: {
          number: 42,
          url: 'https://github.com/Jinn-Network/mono/issues/42',
          title: 'Keep the relay deterministic',
          body: [
            'Avoid order-dependent relay output.',
            '',
            '## Acceptance',
            '- [ ] The focused relay tests pass.',
          ].join('\n'),
          authorLogin: 'Alice',
          authorId: 'U_kgDOAlice',
          updatedAt: '2026-07-28T11:30:00.000Z',
        },
        optIn: {
          label: 'engine:marketplace',
          actorLogin: 'Alice',
          createdAt: '2026-07-28T11:00:00.000Z',
          permission: 'WRITE',
        },
        language: 'typescript',
        verificationProfile: 'jinn-mono.v1',
        acceptanceEvidence: ['The focused relay tests pass.'],
        admissionPolicyVersion: 'jinn-issue-relay-admission.v1',
        capturedAt: '2026-07-28T12:00:00.000Z',
      },
    });
  });

  it('refuses a maintainer-authored issue labelled by another maintainer', () => {
    const decision = admitRelayIssue({
      ...baseInput,
      labelEvents: [
        labelEvents[0]!,
        {
          action: 'labeled',
          label: 'engine:marketplace',
          actorLogin: 'Bob',
          actorId: 'U_kgDOBob',
          createdAt: '2026-07-28T11:00:00.000Z',
        },
      ],
      currentPermission: 'MAINTAIN',
    });

    expect(decision).toMatchObject({
      status: 'refused',
      code: 'not-self-labelled',
    });
  });

  it('refuses an outside author even when a maintainer labelled the issue', () => {
    const decision = admitRelayIssue({
      ...baseInput,
      labelEvents: [
        labelEvents[0]!,
        {
          action: 'labeled',
          label: 'engine:marketplace',
          actorLogin: 'Bob',
          actorId: 'U_kgDOBob',
          createdAt: '2026-07-28T11:00:00.000Z',
        },
      ],
      currentPermission: 'READ',
    });

    expect(decision).toMatchObject({
      status: 'refused',
      code: 'not-maintainer-authored',
    });
  });

  it('refuses the author when WRITE permission has since been revoked', () => {
    const decision = admitRelayIssue({
      ...baseInput,
      currentPermission: 'TRIAGE',
    });

    expect(decision).toMatchObject({
      status: 'refused',
      code: 'not-maintainer-authored',
    });
  });

  it('compares logins case-insensitively while requiring the immutable actor ID', () => {
    const decision = admitRelayIssue({
      ...baseInput,
      labelEvents: [
        labelEvents[0]!,
        {
          action: 'labeled',
          label: 'ENGINE:MARKETPLACE',
          actorLogin: 'aLiCe',
          actorId: 'U_kgDOAlice',
          createdAt: '2026-07-28T11:00:00.000Z',
        },
      ],
    });

    expect(decision).toMatchObject({
      status: 'admitted',
      input: {
        issue: {
          authorLogin: 'Alice',
          authorId: 'U_kgDOAlice',
        },
        optIn: {
          actorLogin: 'aLiCe',
        },
      },
    });

    const mismatchedId = admitRelayIssue({
      ...baseInput,
      labelEvents: [
        labelEvents[0]!,
        {
          action: 'labeled',
          label: 'engine:marketplace',
          actorLogin: 'alice',
          actorId: 'U_kgDOImposter',
          createdAt: '2026-07-28T11:00:00.000Z',
        },
      ],
    });

    expect(mismatchedId).toMatchObject({
      status: 'refused',
      code: 'not-self-labelled',
    });
  });
});

describe('Relay issue admission candidate boundaries', () => {
  it('refuses a pull request returned by the Issues API', () => {
    const decision = admitRelayIssue({
      ...baseInput,
      issue: {
        ...issue,
        issue: { ...issue.issue, isPullRequest: true },
      },
    });

    expect(decision).toMatchObject({ status: 'refused', code: 'not-issue' });
  });

  it('refuses a non-public repository', () => {
    const decision = admitRelayIssue({
      ...baseInput,
      issue: {
        ...issue,
        repository: { ...issue.repository, visibility: 'PRIVATE' },
      },
    });

    expect(decision).toMatchObject({ status: 'refused', code: 'not-public' });
  });

  it('refuses a closed issue', () => {
    const decision = admitRelayIssue({
      ...baseInput,
      issue: {
        ...issue,
        issue: { ...issue.issue, state: 'CLOSED' },
      },
    });

    expect(decision).toMatchObject({ status: 'refused', code: 'not-open' });
  });

  it('refuses a candidate outside the source-level repository capability', () => {
    const decision = admitRelayIssue({
      ...baseInput,
      issue: {
        ...issue,
        repository: { ...issue.repository, slug: 'example/other' },
      },
    });

    expect(decision).toMatchObject({
      status: 'refused',
      code: 'unsupported-capability',
    });
  });

  it('refuses a request matching a forbidden secret pattern', () => {
    const decision = admitRelayIssue({
      ...baseInput,
      issue: {
        ...issue,
        issue: {
          ...issue.issue,
          body: [
            'Read the production secret to verify deployment.',
            '',
            '- [ ] Deployment succeeds.',
          ].join('\n'),
        },
      },
    });

    expect(decision).toMatchObject({
      status: 'refused',
      code: 'requires-secrets',
    });
  });

  it('admits exactly maxIssueBytes and refuses one additional UTF-8 byte', () => {
    const exactBody = '- [ ] ok';
    const exactTitle = 'x'.repeat(policy.maxIssueBytes - Buffer.byteLength(exactBody));
    const exact = admitRelayIssue({
      ...baseInput,
      issue: {
        ...issue,
        issue: { ...issue.issue, title: exactTitle, body: exactBody },
      },
    });
    const over = admitRelayIssue({
      ...baseInput,
      issue: {
        ...issue,
        issue: { ...issue.issue, title: `${exactTitle}x`, body: exactBody },
      },
    });

    expect(exact.status).toBe('admitted');
    expect(over).toMatchObject({ status: 'refused', code: 'oversized' });
  });
});

describe('Relay label history admission', () => {
  it('treats a later removal as no effective opt-in', () => {
    const decision = admitRelayIssue({
      ...baseInput,
      issue: {
        ...issue,
        issue: {
          ...issue.issue,
          labels: ['kind:feature'],
        },
      },
      labelEvents: [
        ...labelEvents,
        {
          action: 'unlabeled',
          label: 'engine:marketplace',
          actorLogin: 'Alice',
          actorId: 'U_kgDOAlice',
          createdAt: '2026-07-28T11:15:00.000Z',
        },
      ],
    });

    expect(decision).toMatchObject({
      status: 'refused',
      code: 'not-self-labelled',
    });
  });

  it('uses event time rather than API order to find the effective add', () => {
    const decision = admitRelayIssue({
      ...baseInput,
      labelEvents: [
        {
          action: 'labeled',
          label: 'engine:marketplace',
          actorLogin: 'ALICE',
          actorId: 'U_kgDOAlice',
          createdAt: '2026-07-28T11:20:00.000Z',
        },
        {
          action: 'unlabeled',
          label: 'engine:marketplace',
          actorLogin: 'Alice',
          actorId: 'U_kgDOAlice',
          createdAt: '2026-07-28T11:10:00.000Z',
        },
        labelEvents[0]!,
        labelEvents[1]!,
      ],
    });

    expect(decision).toMatchObject({
      status: 'admitted',
      input: {
        optIn: {
          actorLogin: 'ALICE',
          createdAt: '2026-07-28T11:20:00.000Z',
        },
      },
    });
  });

  it('fails closed when equally recent events make the effective action ambiguous', () => {
    const decision = admitRelayIssue({
      ...baseInput,
      labelEvents: [
        ...labelEvents,
        {
          action: 'unlabeled',
          label: 'engine:marketplace',
          actorLogin: 'Alice',
          actorId: 'U_kgDOAlice',
          createdAt: '2026-07-28T11:00:00.000Z',
        },
      ],
    });

    expect(decision).toMatchObject({
      status: 'refused',
      code: 'not-self-labelled',
    });
  });

  it('fails closed when the issue label set and event timeline disagree', () => {
    const decision = admitRelayIssue({
      ...baseInput,
      issue: {
        ...issue,
        issue: {
          ...issue.issue,
          labels: ['kind:feature'],
        },
      },
    });

    expect(decision).toMatchObject({
      status: 'refused',
      code: 'not-self-labelled',
    });
  });
});

describe('Relay acceptance clarity', () => {
  it('extracts a bounded plain-text item under a recognized heading', () => {
    const decision = admitRelayIssue({
      ...baseInput,
      issue: {
        ...issue,
        issue: {
          ...issue.issue,
          body: [
            '## Expected result',
            'The relay returns the same task key after a retry.',
          ].join('\n'),
        },
      },
    });

    expect(decision).toMatchObject({
      status: 'admitted',
      input: {
        acceptanceEvidence: [
          'The relay returns the same task key after a retry.',
        ],
      },
    });
  });

  it('extracts explicit checklist items and bounded items under recognized headings', () => {
    const decision = admitRelayIssue({
      ...baseInput,
      issue: {
        ...issue,
        issue: {
          ...issue.issue,
          body: [
            'Clarify relay behavior.',
            '',
            '- [x] Preserve the existing identity.',
            '',
            '## Expected behavior',
            '1. A duplicate round returns duplicate.',
            '- UTC cutoffs use midnight.',
          ].join('\n'),
        },
      },
    });

    expect(decision).toMatchObject({
      status: 'admitted',
      input: {
        acceptanceEvidence: [
          'Preserve the existing identity.',
          'A duplicate round returns duplicate.',
          'UTC cutoffs use midnight.',
        ],
      },
    });
  });

  it('awaits clarification when no bounded acceptance evidence exists', () => {
    const decision = admitRelayIssue({
      ...baseInput,
      issue: {
        ...issue,
        issue: {
          ...issue.issue,
          body: 'Please make the relay better.',
        },
      },
    });

    expect(decision).toMatchObject({
      status: 'awaiting-clarification',
      code: 'missing-acceptance-evidence',
    });
  });

  it('ignores checklist examples inside fenced code blocks', () => {
    const decision = admitRelayIssue({
      ...baseInput,
      issue: {
        ...issue,
        issue: {
          ...issue.issue,
          body: [
            'This is only an issue-template example:',
            '',
            '```markdown',
            '- [ ] Replace this example with a real criterion.',
            '```',
          ].join('\n'),
        },
      },
    });

    expect(decision).toMatchObject({
      status: 'awaiting-clarification',
      code: 'missing-acceptance-evidence',
    });
  });

  it('ignores checklist examples inside HTML comments', () => {
    const decision = admitRelayIssue({
      ...baseInput,
      issue: {
        ...issue,
        issue: {
          ...issue.issue,
          body: [
            'Describe the desired behavior.',
            '<!--',
            '- [ ] Hidden issue-template guidance.',
            '-->',
          ].join('\n'),
        },
      },
    });

    expect(decision).toMatchObject({
      status: 'awaiting-clarification',
      code: 'missing-acceptance-evidence',
    });
  });

  it('keeps acceptance context through nested child headings', () => {
    const decision = admitRelayIssue({
      ...baseInput,
      issue: {
        ...issue,
        issue: {
          ...issue.issue,
          body: [
            '## Acceptance',
            '### CLI',
            '- The command exits zero.',
          ].join('\n'),
        },
      },
    });

    expect(decision).toMatchObject({
      status: 'admitted',
      input: {
        acceptanceEvidence: ['The command exits zero.'],
      },
    });
  });

  it('awaits clarification when acceptance evidence exceeds the item bound', () => {
    const decision = admitRelayIssue({
      ...baseInput,
      issue: {
        ...issue,
        issue: {
          ...issue.issue,
          body: [
            '## Done when',
            '- First behavior works.',
            '- Second behavior works.',
            '- Third behavior works.',
            '- Fourth behavior works.',
          ].join('\n'),
        },
      },
    });

    expect(decision).toMatchObject({
      status: 'awaiting-clarification',
      code: 'ambiguous-scope',
    });
  });
});
