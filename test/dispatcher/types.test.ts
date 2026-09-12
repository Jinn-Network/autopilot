import { describe, it, expect } from 'vitest';
import {
  EFFORTS,
  EFFORT_SET,
  ISSUE_SHAPES,
  ISSUE_SHAPE_SET,
} from '../../src/dispatcher/types.js';
import { DEFAULT_CONFIG } from '../../src/dispatcher/types.js';
import type { PolledPr, ReviewablePr, InFlightReview } from '../../src/dispatcher/types.js';

describe('dispatcher taxonomy literals', () => {
  it('derives validation sets from the canonical shape/effort arrays', () => {
    expect([...ISSUE_SHAPE_SET]).toEqual([...ISSUE_SHAPES]);
    expect([...EFFORT_SET]).toEqual([...EFFORTS]);
  });
});

describe('review-loop types', () => {
  it('DEFAULT_CONFIG carries review-loop fields', () => {
    expect(DEFAULT_CONFIG.reviewCap).toBe(3);
    expect(DEFAULT_CONFIG.engineReviewLabel).toBe('engine:review');
    expect(DEFAULT_CONFIG.reviewBotLogin).toBe('');
  });

  it('DEFAULT_CONFIG gives machine-child work its own lane', () => {
    expect(DEFAULT_CONFIG.childCap).toBe(1);
    // The debt lane is off by default (#168): sweeps draw from concurrencyCap.
    expect(DEFAULT_CONFIG.debtCap).toBe(0);
  });

  it('ReviewablePr narrows PolledPr', () => {
    const pr: ReviewablePr = {
      number: 42, title: 't', headRefName: 'feat/42-x', headRefOid: 'abc',
      isDraft: true, author: 'alice', hasReviewLabel: true, needsReview: true,
    };
    const widened: PolledPr = pr;
    expect(widened.number).toBe(42);
  });

  it('InFlightReview is PR-keyed', () => {
    const s: InFlightReview = { prNumber: 42, branch: 'feat/42-x', worktreePath: '/p/pr-42', pid: 1, startedAt: 0 };
    expect(s.prNumber).toBe(42);
  });

  it('DEFAULT_CONFIG uses one process-wide Claude runtime', () => {
    expect(DEFAULT_CONFIG.runtime).toBe('claude');
  });

  // #184: the ceiling was declared here for months with no reader. Now that
  // it is enforced, the default must be the per-phase pair the config decodes
  // to, and never a session-wide "forever".
  it('DEFAULT_CONFIG bounds a worker session per phase', () => {
    expect(DEFAULT_CONFIG.wallClockMs)
      .toEqual({ implement: 4 * 60 * 60 * 1000, review: 2 * 60 * 60 * 1000 });
  });

  // #182: the fallback a worker is launched under when nothing configured one
  // must be the empty MCP grant, never the operator's ambient server set.
  it('DEFAULT_CONFIG grants workers no MCP servers', () => {
    expect(DEFAULT_CONFIG.mcpServers).toEqual({});
  });
});
