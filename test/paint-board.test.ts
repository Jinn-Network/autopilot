import { describe, expect, it } from 'vitest';
import {
  archiveProjectItemArgs,
  buildIssueRowsQuery,
} from '../scripts/paint-board.js';

describe('paint-board GitHub operations', () => {
  it('meters the issue-row GraphQL read in the same response', () => {
    const query = buildIssueRowsQuery('outside-owner', 'outside-repo', [7, 42]);

    expect(query).toContain(
      'repository(owner: "outside-owner", name: "outside-repo")',
    );
    expect(query).toContain('i0: issue(number: 7)');
    expect(query).toContain('i1: issue(number: 42)');
    expect(query).toContain(
      'rateLimit { cost remaining resetAt used limit }',
    );
  });

  it('archives through the high-level project command', () => {
    expect(archiveProjectItemArgs(17, 'outside-owner', 'PVTI_123')).toEqual([
      'project',
      'item-archive',
      '17',
      '--owner',
      'outside-owner',
      '--id',
      'PVTI_123',
    ]);
  });
});
