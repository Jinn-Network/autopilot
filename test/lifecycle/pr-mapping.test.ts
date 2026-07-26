import { describe, expect, it } from 'vitest';
import {
  resolveStructuredPullRequestMappings,
  type StructuredMappingInput,
} from '../../src/lifecycle/pr-mapping.js';
import { gitOid } from '../../src/lifecycle/types.js';

const HEAD = gitOid('1'.repeat(40));
const OTHER_HEAD = gitOid('2'.repeat(40));

function stackedInput(
  overrides: Partial<StructuredMappingInput> = {},
): StructuredMappingInput {
  return {
    defaultBranch: 'next',
    issues: [{
      number: 2084,
      blockedOn: 'Another issue',
      blockedByIssues: [2083],
    }],
    pullRequests: [{
      number: 84,
      state: 'OPEN',
      head: HEAD,
      headRefName: 'autopilot/2084',
      baseRefName: 'autopilot/2083',
      closingIssueNumbers: [],
      body: '<!-- jinn-autopilot:v2 issue=2084 branch=autopilot/2084 -->',
    }],
    stableBranches: [{
      issueNumber: 2084,
      phase: 'implement',
      head: HEAD,
      headRefName: 'autopilot/2084',
      targetBase: 'autopilot/2083',
    }],
    ...overrides,
  };
}

describe('canonical structured PR-to-issue mapping', () => {
  it('resolves the complete #2084 empty-closing stack shape and pins its parent branch', () => {
    expect(resolveStructuredPullRequestMappings(stackedInput())).toEqual([{
      status: 'resolved',
      prNumber: 84,
      issueNumber: 2084,
      expectedBaseRefName: 'autopilot/2083',
      evidence: 'stacked-empty-closing',
    }]);
  });

  it.each([
    {
      name: 'lifecycle marker is missing',
      mutate: (input: StructuredMappingInput): StructuredMappingInput => ({
        ...input,
        pullRequests: [{ ...input.pullRequests[0]!, body: '' }],
      }),
      detail: /single lifecycle marker/i,
    },
    {
      name: 'stable claim head differs',
      mutate: (input: StructuredMappingInput): StructuredMappingInput => ({
        ...input,
        stableBranches: [{ ...input.stableBranches[0]!, head: OTHER_HEAD }],
      }),
      detail: /stable branch claim.*head/i,
    },
    {
      name: 'parent dependency is absent',
      mutate: (input: StructuredMappingInput): StructuredMappingInput => ({
        ...input,
        issues: [{ ...input.issues[0]!, blockedByIssues: [] }],
      }),
      detail: /dependency.*2083/i,
    },
    {
      name: 'another open PR claims the issue',
      mutate: (input: StructuredMappingInput): StructuredMappingInput => ({
        ...input,
        pullRequests: [
          ...input.pullRequests,
          {
            ...input.pullRequests[0]!,
            number: 85,
            head: OTHER_HEAD,
            headRefName: 'feature/also-2084',
            closingIssueNumbers: [2084],
            body: '',
          },
        ],
      }),
      detail: /unique open PR/i,
    },
  ])('fails closed with structured evidence when $name', ({ mutate, detail }) => {
    const [resolution] = resolveStructuredPullRequestMappings(mutate(stackedInput()));

    expect(resolution).toMatchObject({
      status: 'ambiguous',
      prNumber: 84,
      issueNumbers: [2084],
    });
    expect(resolution).toHaveProperty('details');
    expect((resolution as { details: readonly string[] }).details.join(' ')).toMatch(detail);
  });

  it('resolves one closing reference on the configured default branch', () => {
    const input = stackedInput({
      issues: [{ number: 42, blockedOn: 'Nothing', blockedByIssues: [] }],
      pullRequests: [{
        number: 84,
        state: 'OPEN',
        head: HEAD,
        headRefName: 'autopilot/42',
        baseRefName: 'main',
        closingIssueNumbers: [42],
        body: 'Closes #42',
      }],
      stableBranches: [],
      defaultBranch: 'main',
    });

    expect(resolveStructuredPullRequestMappings(input)).toEqual([{
      status: 'resolved',
      prNumber: 84,
      issueNumber: 42,
      expectedBaseRefName: 'main',
      evidence: 'closing-reference',
    }]);
  });

  it('rejects empty closing references on the default branch without an issue dependency', () => {
    const input = stackedInput({
      issues: [{ number: 2084, blockedOn: 'Nothing', blockedByIssues: [] }],
      pullRequests: [{
        ...stackedInput().pullRequests[0]!,
        baseRefName: 'next',
      }],
      stableBranches: [{
        ...stackedInput().stableBranches[0]!,
        targetBase: 'next',
      }],
    });

    expect(resolveStructuredPullRequestMappings(input)).toEqual([
      expect.objectContaining({
        status: 'ambiguous',
        prNumber: 84,
        issueNumbers: [2084],
        details: [expect.stringMatching(/empty closing references.*dependency/i)],
      }),
    ]);
  });

  it('rejects a normal closing-reference PR retargeted away from its exact stable claim base', () => {
    const input = stackedInput({
      pullRequests: [{
        ...stackedInput().pullRequests[0]!,
        baseRefName: 'next',
        closingIssueNumbers: [2084],
      }],
    });

    expect(resolveStructuredPullRequestMappings(input)).toEqual([
      expect.objectContaining({
        status: 'ambiguous',
        prNumber: 84,
        issueNumbers: [2084],
        details: [expect.stringMatching(/stable branch claim.*base/i)],
      }),
    ]);
  });

  it('authorizes an exact unique open dependency PR branch without trusting its name', () => {
    const input = stackedInput({
      issues: [
        { number: 42, blockedOn: 'Another issue', blockedByIssues: [7] },
        { number: 7, blockedOn: 'Nothing', blockedByIssues: [] },
      ],
      pullRequests: [{
        number: 84,
        state: 'OPEN',
        head: HEAD,
        headRefName: 'autopilot/42',
        baseRefName: 'stack/live-blocker',
        closingIssueNumbers: [42],
        body: '<!-- jinn-autopilot:v2 issue=42 branch=autopilot/42 -->',
      }, {
        number: 7,
        state: 'OPEN',
        head: OTHER_HEAD,
        headRefName: 'stack/live-blocker',
        baseRefName: 'next',
        closingIssueNumbers: [7],
        body: '<!-- jinn-autopilot:v2 issue=7 branch=stack/live-blocker -->',
      }],
      stableBranches: [],
    });

    expect(resolveStructuredPullRequestMappings(input)[0]).toEqual({
      status: 'resolved',
      prNumber: 84,
      issueNumber: 42,
      expectedBaseRefName: 'stack/live-blocker',
      evidence: 'closing-reference',
    });
  });

  it('does not let a non-default live base authorize itself', () => {
    const input = stackedInput({
      issues: [{ number: 42, blockedOn: 'Nothing', blockedByIssues: [] }],
      pullRequests: [{
        number: 84,
        state: 'OPEN',
        head: HEAD,
        headRefName: 'autopilot/42',
        baseRefName: 'attacker/retarget',
        closingIssueNumbers: [42],
        body: 'Closes #42',
      }],
      stableBranches: [],
    });

    expect(resolveStructuredPullRequestMappings(input)).toEqual([
      expect.objectContaining({
        status: 'ambiguous',
        prNumber: 84,
        issueNumbers: [42],
        details: [expect.stringMatching(/authorized base/i)],
      }),
    ]);
  });
});
