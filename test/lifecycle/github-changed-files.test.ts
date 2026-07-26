import { describe, expect, it } from 'vitest';
import { readExactCompareStatus } from '../../src/lifecycle/github-changed-files.js';
import { gitOid } from '../../src/lifecycle/types.js';

const HEAD = gitOid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const BASE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('readExactCompareStatus', () => {
  it('binds compare status to a fresh exact head/base read', async () => {
    const calls: string[] = [];
    const status = await readExactCompareStatus({
      run: async (_command, args) => {
        calls.push(args[1]!);
        if (args[1] === 'repos/Jinn-Network/mono/pulls/101') {
          return JSON.stringify({
            head: { sha: HEAD },
            base: { ref: 'next', sha: BASE },
          });
        }
        return JSON.stringify({ status: 'behind' });
      },
      prNumber: 101,
      expectedHead: HEAD,
      expectedBaseRefName: 'next',
      repositorySlug: 'Jinn-Network/mono',
    });

    expect(status).toBe('behind');
    expect(calls).toEqual([
      'repos/Jinn-Network/mono/pulls/101',
      `repos/Jinn-Network/mono/compare/${BASE}...${HEAD}`,
    ]);
  });

  it('rejects a compare when the fresh PR reread no longer has the expected head or base', async () => {
    await expect(readExactCompareStatus({
      run: async () => JSON.stringify({
        head: { sha: 'cccccccccccccccccccccccccccccccccccccccc' },
        base: { ref: 'next', sha: BASE },
      }),
      prNumber: 101,
      expectedHead: HEAD,
      expectedBaseRefName: 'next',
      repositorySlug: 'Jinn-Network/mono',
    })).rejects.toThrow(/exact PR authority/i);
  });
});
