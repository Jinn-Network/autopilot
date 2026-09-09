import { describe, expect, it } from 'vitest';
import {
  MAX_UMBRELLA_CLOSURES_PER_CYCLE,
  UMBRELLA_LABEL,
  isUmbrellaIssue,
  parseUmbrellaParent,
  planUmbrellaClosures,
  umbrellaDeclaredChildren,
  type UmbrellaClosureIssue,
} from '../../src/lifecycle/umbrella-issues.js';

function issue(
  number: number,
  overrides: Partial<UmbrellaClosureIssue> = {},
): UmbrellaClosureIssue {
  return { number, body: '', labels: [], blockedOn: 'Nothing', ...overrides };
}

describe('umbrella recognition (#160)', () => {
  it('recognises the operator label, case- and space-insensitively', () => {
    expect(isUmbrellaIssue({ labels: [UMBRELLA_LABEL] })).toBe(true);
    expect(isUmbrellaIssue({ labels: ['area:core', 'Umbrella'] })).toBe(true);
    expect(isUmbrellaIssue({ labels: [' UMBRELLA '] })).toBe(true);
  });

  it('recognises the handbook body declarations', () => {
    // mono#2448, verbatim shape: the declaration rides mid-line.
    expect(isUmbrellaIssue({
      body: 'Type: `feat` — umbrella; children own implementation\n',
    })).toBe(true);
    // mono#2396, verbatim shape: the declaration opens a bolded line.
    expect(isUmbrellaIssue({
      body: '**Umbrella only — no direct implementation in this issue.**\n'
        + 'Child issues and stacked PRs own execution.',
    })).toBe(true);
    expect(isUmbrellaIssue({ body: '## Umbrella only\n' })).toBe(true);
    expect(isUmbrellaIssue({ body: '- Umbrella only\n' })).toBe(true);
  });

  it('is a marker or a label, never a substring', () => {
    // The word in prose names nothing; only the declaration does.
    for (const body of [
      'This sits under the umbrella epic for Q3.',
      'An umbrella clause covers the remaining cases.',
      'The umbrella owns implementation of nothing at all.',
      'children own implementations elsewhere',
      '',
    ]) {
      expect(isUmbrellaIssue({ body })).toBe(false);
    }
    expect(isUmbrellaIssue({ labels: ['umbrella-ish', 'epic'] })).toBe(false);
    expect(isUmbrellaIssue({})).toBe(false);
  });
});

describe('declared children (#160)', () => {
  it('reads issue numbers off task-list lines only', () => {
    const body = [
      'Acceptance: child issues exist.',
      '',
      '- [ ] #101 poller',
      '* [x] #102 — writer',
      '+ [X] ship the reader (#103)',
      '',
      'See #999 for context.',
      '- not a task list #998',
    ].join('\n');
    expect(umbrellaDeclaredChildren(body)).toEqual([101, 102, 103]);
  });

  it('takes the first reference on a line and de-duplicates', () => {
    expect(umbrellaDeclaredChildren('- [ ] #7 blocks #8\n- [x] #7 again\n'))
      .toEqual([7]);
  });

  it('reads an explicit parent declaration, anchored to its own line', () => {
    expect(parseUmbrellaParent('Parent: #2448\n')).toBe(2448);
    expect(parseUmbrellaParent('**Parent:** #2448\n')).toBe(2448);
    expect(parseUmbrellaParent('body\n> Parent: #12\n')).toBe(12);
    expect(parseUmbrellaParent('the parent: #12 is named mid-sentence')).toBeNull();
    expect(parseUmbrellaParent('')).toBeNull();
  });
});

describe('umbrella closure planning (#160)', () => {
  const UMBRELLA = 'umbrella; children own implementation\n- [ ] #11\n- [ ] #12\n';

  it('closes an umbrella whose every declared child is gone from the open set', () => {
    expect(planUmbrellaClosures([issue(10, { body: UMBRELLA })])).toEqual([
      { issueNumber: 10, childIssueNumbers: [11, 12] },
    ]);
  });

  it('holds while any declared child is still open', () => {
    expect(planUmbrellaClosures([
      issue(10, { body: UMBRELLA }),
      issue(12),
    ])).toEqual([]);
  });

  it('holds while an issue still declares it as parent', () => {
    expect(planUmbrellaClosures([
      issue(10, { body: UMBRELLA }),
      issue(40, { body: 'Parent: #10\n' }),
    ])).toEqual([]);
  });

  it('never closes an umbrella that declared no children at all', () => {
    // "Child issues exist" is the acceptance criterion; an umbrella whose
    // children were never filed has not met it, and absence is not completion.
    expect(planUmbrellaClosures([
      issue(10, { body: 'umbrella; children own implementation\n' }),
    ])).toEqual([]);
  });

  it('never closes a non-umbrella, however its task list reads', () => {
    expect(planUmbrellaClosures([
      issue(10, { body: 'Ordinary work.\n- [x] #11\n' }),
    ])).toEqual([]);
  });

  it('leaves an umbrella a human is holding alone', () => {
    for (const held of [
      { blockedOn: 'Human' as const },
      { labels: ['umbrella', 'review:needs-human'] },
    ]) {
      expect(planUmbrellaClosures([issue(10, { body: UMBRELLA, ...held })])).toEqual([]);
    }
  });

  it('ignores a self-reference in the umbrella own task list', () => {
    expect(planUmbrellaClosures([
      issue(10, { body: 'umbrella; children own implementation\n- [x] #10\n' }),
    ])).toEqual([]);
  });

  it('caps one cycle and takes the oldest umbrellas first', () => {
    const many = Array.from(
      { length: MAX_UMBRELLA_CLOSURES_PER_CYCLE + 2 },
      (_unused, index) => issue(100 + index, {
        body: `umbrella; children own implementation\n- [x] #${900 + index}\n`,
      }),
    );
    expect(planUmbrellaClosures([...many].reverse()).map((plan) => plan.issueNumber))
      .toEqual([100, 101, 102]);
  });
});
