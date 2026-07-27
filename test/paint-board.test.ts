import { describe, expect, it } from 'vitest';
import {
  archiveProjectItemArgs,
  buildIssueRowsQuery,
  runPaintBoard,
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

  it('paints an empty-closing stacked PR through the canonical production resolver', async () => {
    const head = 'a'.repeat(40);
    const mutations: string[][] = [];
    const run = async (_command: string, args: string[]): Promise<string> => {
      if (
        args[0] === 'api'
        && args[1] === 'graphql'
        && args.some((arg) => arg.startsWith('owner='))
      ) {
        return JSON.stringify({
          data: {
            rateLimit: {
              cost: 1,
              remaining: 4_999,
              used: 1,
              resetAt: '2026-07-20T13:00:00.000Z',
            },
            organization: {
              projectV2: {
                sprintField: null,
                items: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{
                    id: 'PVTI_2084',
                    content: {
                      __typename: 'Issue',
                      number: 2084,
                      repository: { nameWithOwner: 'outside-owner/outside-repo' },
                      issueType: { name: 'feat' },
                      blockedBy: { nodes: [{ number: 2083 }] },
                    },
                    status: { name: 'In Progress' },
                    priority: { name: 'P1' },
                    effort: { name: 'Medium' },
                    blockedOn: { name: 'Another issue' },
                    sprint: null,
                  }],
                },
              },
            },
          },
        });
      }
      if (args[0] === 'pr' && args[1] === 'list') {
        return JSON.stringify([{
          number: 84,
          headRefOid: head,
          headRefName: 'autopilot/2084',
          baseRefName: 'autopilot/2083',
          body: '<!-- jinn-autopilot:v2 issue=2084 branch=autopilot/2084 -->',
          isDraft: false,
          labels: [{ name: 'engine:review' }],
          closingIssuesReferences: [],
        }]);
      }
      if (args[0] === 'api' && args[1]?.includes('/git/matching-refs/')) {
        return JSON.stringify([[
          { ref: 'refs/heads/autopilot/2084', object: { sha: head } },
        ]]);
      }
      if (args[0] === 'api' && args[1]?.includes(`/commits/${head}`)) {
        return [
          'Jinn-Autopilot-Protocol: 2',
          'Jinn-Autopilot-Phase: implement',
          'Jinn-Autopilot-Issue: 2084',
          'Jinn-Autopilot-PR: 84',
          'Jinn-Autopilot-Attempt: 11111111-1111-4111-8111-111111111111',
          'Jinn-Autopilot-Runner: runner-a',
          'Jinn-Autopilot-Login: implementation-bot',
          `Jinn-Autopilot-Expected-Head: ${head}`,
          'Jinn-Autopilot-Target-Base: autopilot/2083',
          'Jinn-Autopilot-Claimed-At: 2026-07-20T08:00:00.000Z',
        ].join('\n');
      }
      if (args[0] === 'issue' && args[1] === 'list') return '[]';
      if (args[0] === 'api' && args[1] === 'graphql') {
        return JSON.stringify({
          data: {
            repository: {
              i0: {
                number: 2084,
                state: 'OPEN',
                labels: { nodes: [] },
              },
            },
          },
        });
      }
      if (args[0] === 'project' && args[1] === 'item-edit') {
        mutations.push(args);
        return '';
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    };

    await expect(runPaintBoard(run, new Date('2026-07-20T12:00:00.000Z'), {
      repositorySlug: 'outside-owner/outside-repo',
      repositoryOwner: 'outside-owner',
      repositoryName: 'outside-repo',
      projectOwner: 'outside-owner',
      projectNumber: 17,
      projectId: 'PVT_17',
      statusFieldId: 'PVTSSF_status',
      statusOptions: {
        Todo: 'todo',
        'In Progress': 'in-progress',
        Human: 'human',
        'In Review': 'in-review',
        Done: 'done',
      },
      defaultBranch: 'next',
    })).resolves.toMatchObject({ paintsApplied: 1 });
    expect(mutations).toEqual([expect.arrayContaining([
      '--id', 'PVTI_2084',
      '--single-select-option-id', 'in-review',
    ])]);
  });
});
