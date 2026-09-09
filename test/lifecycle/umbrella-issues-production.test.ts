import { describe, expect, it } from 'vitest';
import { executeProductionUmbrellaClosure } from '../../src/lifecycle/umbrella-issues-production.js';

const ACTION = {
  kind: 'close-umbrella' as const,
  issueNumber: 2448,
  childIssueNumbers: [2449, 2450],
};

const UMBRELLA_BODY = 'umbrella; children own implementation\n- [x] #2449\n- [x] #2450\n';

function state(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    data: {
      repository: {
        umbrella: {
          number: 2448,
          state: 'OPEN',
          body: UMBRELLA_BODY,
          labels: { nodes: [] },
        },
        child0: { __typename: 'Issue', number: 2449, state: 'CLOSED' },
        child1: { __typename: 'PullRequest', number: 2450, state: 'MERGED' },
        ...overrides,
      },
    },
  });
}

function runnerFor(responses: readonly string[]) {
  const calls: string[][] = [];
  let index = 0;
  const run = async (cmd: string, args: string[]): Promise<string> => {
    calls.push([cmd, ...args]);
    const response = responses[index] ?? '';
    index += 1;
    return response;
  };
  return { run, calls };
}

describe('production umbrella closure (#160)', () => {
  it('closes the umbrella with reason completed and never comments', async () => {
    const { run, calls } = runnerFor([
      state(),
      '',
      state({ umbrella: { number: 2448, state: 'CLOSED', body: UMBRELLA_BODY, labels: { nodes: [] } } }),
    ]);

    await expect(executeProductionUmbrellaClosure(ACTION, {
      runner: run,
      repo: 'Jinn-Network/mono',
    })).resolves.toEqual({ status: 'closed', detail: 'children #2449, #2450' });

    const close = calls.find((call) => call[1] === 'issue' && call[2] === 'close');
    expect(close).toEqual([
      'gh', 'issue', 'close', '2448', '--repo', 'Jinn-Network/mono', '--reason', 'completed',
    ]);
    // The pinned prohibition: this engine never writes a comment on an issue.
    expect(calls.flat()).not.toContain('--comment');
  });

  it('refuses when a child is open underneath the plan', async () => {
    const { run, calls } = runnerFor([
      state({ child0: { __typename: 'Issue', number: 2449, state: 'OPEN' } }),
    ]);

    await expect(executeProductionUmbrellaClosure(ACTION, {
      runner: run,
      repo: 'Jinn-Network/mono',
    })).resolves.toEqual({
      status: 'skipped',
      reason: 'Child #2449 is open',
    });
    expect(calls.some((call) => call[2] === 'close')).toBe(false);
  });

  it('refuses when a child cannot be read at all', async () => {
    const { run } = runnerFor([state({ child1: null })]);

    await expect(executeProductionUmbrellaClosure(ACTION, {
      runner: run,
      repo: 'Jinn-Network/mono',
    })).resolves.toEqual({
      status: 'skipped',
      reason: 'Child #2450 could not be read',
    });
  });

  it('refuses when the umbrella stopped being one underneath', async () => {
    const { run } = runnerFor([state({
      umbrella: {
        number: 2448,
        state: 'OPEN',
        body: 'Rewritten as ordinary work.',
        labels: { nodes: [] },
      },
    })]);

    await expect(executeProductionUmbrellaClosure(ACTION, {
      runner: run,
      repo: 'Jinn-Network/mono',
    })).resolves.toEqual({
      status: 'skipped',
      reason: 'Issue #2448 no longer declares itself an umbrella',
    });
  });

  it('refuses when a human took the umbrella underneath', async () => {
    const { run } = runnerFor([state({
      umbrella: {
        number: 2448,
        state: 'OPEN',
        body: UMBRELLA_BODY,
        labels: { nodes: [{ name: 'review:needs-human' }] },
      },
    })]);

    await expect(executeProductionUmbrellaClosure(ACTION, {
      runner: run,
      repo: 'Jinn-Network/mono',
    })).resolves.toEqual({
      status: 'skipped',
      reason: 'Issue #2448 carries review:needs-human',
    });
  });

  it('reports an already-closed umbrella as a skip, not a failure', async () => {
    const { run } = runnerFor([state({
      umbrella: { number: 2448, state: 'CLOSED', body: UMBRELLA_BODY, labels: { nodes: [] } },
    })]);

    await expect(executeProductionUmbrellaClosure(ACTION, {
      runner: run,
      repo: 'Jinn-Network/mono',
    })).resolves.toEqual({
      status: 'skipped',
      reason: 'Issue #2448 is already closed',
    });
  });

  it('throws when the close was accepted but the issue is still open', async () => {
    const { run } = runnerFor([state(), '', state()]);

    await expect(executeProductionUmbrellaClosure(ACTION, {
      runner: run,
      repo: 'Jinn-Network/mono',
    })).rejects.toThrow('Umbrella #2448 is still open after its close');
  });

  it('refuses an action that names no child', async () => {
    const { run } = runnerFor([]);

    await expect(executeProductionUmbrellaClosure(
      { ...ACTION, childIssueNumbers: [] },
      { runner: run, repo: 'Jinn-Network/mono' },
    )).rejects.toThrow('Close-umbrella action names no child');
  });
});
