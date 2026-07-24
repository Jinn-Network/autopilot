import { describe, expect, it, vi } from 'vitest';
import {
  decodeCiRerunRecord,
  encodeCiRerunRecord,
  executeFileCiFailureChildAction,
  executeRerunFailedChecksAction,
} from '../../src/lifecycle/ci-rerun.js';
import { gitOid, type CheckSummary } from '../../src/lifecycle/types.js';

const HEAD = gitOid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

function check(over: Partial<CheckSummary> & Pick<CheckSummary, 'name'>): CheckSummary {
  return {
    status: 'COMPLETED',
    conclusion: 'FAILURE',
    ...over,
  };
}

describe('ci-rerun', () => {
  it('round-trips rerun record markers', () => {
    const record = {
      prNumber: 101,
      head: HEAD,
      fingerprint: 'abc123',
      runIds: [9, 10],
      requestedAt: '2026-07-20T12:00:00.000Z',
    };
    expect(decodeCiRerunRecord(encodeCiRerunRecord(record))).toEqual(record);
  });

  it('requests one rerun for rerunnable failures', async () => {
    const rerunFailedJobs = vi.fn(async () => {});
    const publishRecord = vi.fn(async () => ({
      status: 'won' as const,
      expected: null,
      published: HEAD,
      observed: HEAD,
    }));
    const result = await executeRerunFailedChecksAction(
      { prNumber: 101, head: HEAD },
      {
        readChecks: async () => [
          check({ name: 'test', source: 'check-run', runId: 55 }),
        ],
        readRecord: async () => null,
        rerunFailedJobs,
        publishRecord,
        fileCiFailureChild: async () => ({
          status: 'filed',
          childNumber: 1,
        }),
      },
    );
    expect(result).toMatchObject({ status: 'rerun-requested', prNumber: 101, head: HEAD });
    expect(rerunFailedJobs).toHaveBeenCalledWith(55);
    expect(publishRecord).toHaveBeenCalledOnce();
  });

  it.each([
    'gh: Not Found (HTTP 404)',
    'gh: Gone (HTTP 410)',
  ])('skips stale workflow-run ids on %s and still publishes a rerun record', async (failure) => {
    const rerunFailedJobs = vi.fn(async () => {
      throw new Error(`Command failed: gh api ... -X POST\n${failure}`);
    });
    const publishRecord = vi.fn(async () => ({
      status: 'won' as const,
      expected: null,
      published: HEAD,
      observed: HEAD,
    }));
    const result = await executeRerunFailedChecksAction(
      { prNumber: 101, head: HEAD },
      {
        readChecks: async () => [
          check({ name: 'test', source: 'check-run', runId: 55 }),
        ],
        readRecord: async () => null,
        rerunFailedJobs,
        publishRecord,
        fileCiFailureChild: async () => ({
          status: 'filed',
          childNumber: 1,
        }),
      },
    );
    expect(result).toMatchObject({ status: 'rerun-requested', prNumber: 101, head: HEAD });
    expect(rerunFailedJobs).toHaveBeenCalledWith(55);
    expect(publishRecord).toHaveBeenCalledOnce();
  });

  it('does not treat unrelated not-found failures as stale workflow runs', async () => {
    const publishRecord = vi.fn(async () => ({
      status: 'won' as const,
      expected: null,
      published: HEAD,
      observed: HEAD,
    }));

    await expect(executeRerunFailedChecksAction(
      { prNumber: 101, head: HEAD },
      {
        readChecks: async () => [
          check({ name: 'test', source: 'check-run', runId: 55 }),
        ],
        readRecord: async () => null,
        rerunFailedJobs: async () => {
          throw new Error('GitHub credential not found');
        },
        publishRecord,
        fileCiFailureChild: async () => ({
          status: 'filed',
          childNumber: 1,
        }),
      },
    )).rejects.toThrow(/credential not found/i);
    expect(publishRecord).not.toHaveBeenCalled();
  });

  it('does not spend a retry when a record already exists', async () => {
    const rerunFailedJobs = vi.fn(async () => {});
    const result = await executeRerunFailedChecksAction(
      { prNumber: 101, head: HEAD },
      {
        readChecks: async () => [
          check({ name: 'test', source: 'check-run', runId: 55 }),
        ],
        readRecord: async () => ({
          prNumber: 101,
          head: HEAD,
          fingerprint: 'deadbeef',
          runIds: [55],
          requestedAt: '2026-07-20T12:00:00.000Z',
        }),
        rerunFailedJobs,
        publishRecord: async () => ({
          status: 'won',
          expected: null,
          published: HEAD,
          observed: HEAD,
        }),
        fileCiFailureChild: async () => ({
          status: 'filed',
          childNumber: 1,
        }),
      },
    );
    expect(result).toMatchObject({
      status: 'waiting',
      reason: 'rerun-already-recorded',
    });
    expect(rerunFailedJobs).not.toHaveBeenCalled();
  });

  it('files a child immediately for external-only failures', async () => {
    const fileCiFailureChild = vi.fn(async () => ({
      status: 'filed' as const,
      childNumber: 77,
    }));
    const result = await executeRerunFailedChecksAction(
      { prNumber: 101, head: HEAD },
      {
        readChecks: async () => [
          check({ name: 'codecov', source: 'commit-status' }),
        ],
        readRecord: async () => null,
        rerunFailedJobs: async () => {},
        publishRecord: async () => ({
          status: 'won',
          expected: null,
          published: HEAD,
          observed: HEAD,
        }),
        fileCiFailureChild,
      },
    );
    expect(result).toMatchObject({ status: 'filed', childNumber: 77 });
    expect(fileCiFailureChild).toHaveBeenCalledOnce();
  });

  it('files a child after rerun when checks still fail', async () => {
    const fileCiFailureChild = vi.fn(async () => ({
      status: 'filed' as const,
      childNumber: 88,
    }));
    const result = await executeFileCiFailureChildAction(
      { prNumber: 101, head: HEAD },
      {
        readChecks: async () => [
          check({ name: 'test', source: 'check-run', runId: 55 }),
        ],
        readRecord: async () => ({
          prNumber: 101,
          head: HEAD,
          fingerprint: 'deadbeef',
          runIds: [55],
          requestedAt: '2026-07-20T12:00:00.000Z',
        }),
        rerunFailedJobs: async () => {},
        publishRecord: async () => ({
          status: 'won',
          expected: null,
          published: HEAD,
          observed: HEAD,
        }),
        fileCiFailureChild,
      },
    );
    expect(result).toMatchObject({ status: 'filed', childNumber: 88 });
  });
});
