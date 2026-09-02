import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_REVIEW_FOLLOW_UPS_PER_PASS,
  fileReviewFollowUps,
  hasReviewFollowUpMarkerTag,
  formatReviewFollowUpMarker,
  formatReviewFollowUpMarkerKey,
  parseReviewFollowUpMarker,
  parseReviewFollowUpsPayload,
  type ReviewFollowUpPort,
} from '../../src/lifecycle/review-follow-ups.js';

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);

/**
 * The marker template as canon §5.1 literally prints it. Read from the canon
 * asset rather than retyped, so the test tracks the file that agents quote.
 */
const CANON_MARKER_TEMPLATE = (() => {
  const canon = readFileSync(
    new URL('../../assets/canon/single-surface-lifecycle.md', import.meta.url),
    'utf8',
  );
  const match = canon.match(/`(<!-- jinn-autopilot:review-follow-up [^`]*-->)`/);
  if (match === null) {
    throw new Error('canon §5.1 no longer prints a review-follow-up marker template');
  }
  return match[1]!;
})();

/**
 * In-memory issue store shaped like the production port: `searchOpenByMarker`
 * is a substring match over **open** issue bodies, exactly as
 * `review-follow-ups-production.ts` implements it.
 */
function followUpHarness(seed: readonly {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
}[] = []) {
  const issues = seed.map((issue) => ({ ...issue }));
  const created: Array<{ title: string; body: string; type: string }> = [];
  const triageCalls: Array<{
    issueNumber: number;
    type: string;
    effort: string;
    priority: string;
  }> = [];
  const searches: string[] = [];
  let next = 100;
  const port: ReviewFollowUpPort = {
    async searchOpenByMarker(marker) {
      searches.push(marker);
      return issues
        .filter((issue) => issue.state === 'open' && issue.body.includes(marker))
        .map((issue) => ({ number: issue.number, title: issue.title }));
    },
    async createIssue(input) {
      created.push({ title: input.title, body: input.body, type: input.type });
      const number = next;
      next += 1;
      issues.push({ number, title: input.title, body: input.body, state: 'open' });
      return { number };
    },
    async ensureTriageComplete(input) {
      triageCalls.push({ ...input });
    },
  };
  return { port, issues, created, triageCalls, searches };
}

function entry(overrides: Partial<{
  type: 'feat' | 'chore' | 'fix' | 'refactor';
  title: string;
  body: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  priority: 'p0' | 'p1' | 'p2' | 'p3' | 'p4';
}> = {}) {
  return {
    type: 'feat' as const,
    title: 'Follow-up A',
    body: 'Debt note',
    effort: 'medium' as const,
    priority: 'p2' as const,
    ...overrides,
  };
}

describe('review-follow-up marker', () => {
  it('round-trips pr+head+index and never looks like a child marker', () => {
    const marker = formatReviewFollowUpMarker(84, HEAD, 0);
    expect(marker).toBe(
      `<!-- jinn-autopilot:review-follow-up pr=84 head=${HEAD} index=0 -->`,
    );
    expect(parseReviewFollowUpMarker(`${marker}\n\nbody`)).toEqual({
      parentPr: 84,
      head: HEAD,
      index: 0,
    });
    expect(marker).not.toContain('jinn-autopilot:child');
    expect(marker).not.toMatch(/\bkind=(review-finding|reconcile)\b/);
  });

  // Canon §5.1 is what agents are told to treat as authoritative, and it used
  // to print the defect as the contract ("idempotent on pr+head+index").
  it('is described by canon as parent-scoped, not head-scoped', () => {
    const canon = readFileSync(
      new URL('../../assets/canon/single-surface-lifecycle.md', import.meta.url),
      'utf8',
    );
    expect(canon).not.toContain('idempotent on `pr+head+index`');
    expect(canon).toMatch(/dedups on the \*\*parent-scoped marker prefix/);
  });

  // The dedup identity, mirroring `formatChildMarkerKey`: everything through
  // `pr=<N>`, with neither of the two components that move between passes.
  it('exposes a parent-scoped key that is a prefix of every head/index marker', () => {
    const key = formatReviewFollowUpMarkerKey(84);
    expect(key).toBe('<!-- jinn-autopilot:review-follow-up pr=84 ');
    expect(formatReviewFollowUpMarker(84, HEAD, 0)).toContain(key);
    expect(formatReviewFollowUpMarker(84, NEXT_HEAD, 4)).toContain(key);
    expect(() => formatReviewFollowUpMarkerKey(0)).toThrow(/parent PR/i);
  });

  // The key is consumed by a *substring* search, so the field boundary after
  // the digits is load-bearing: without it PR #84's key matches PR #845's
  // markers and dedup silently borrows another parent's follow-ups.
  it('does not match a longer parent number', () => {
    expect(formatReviewFollowUpMarker(845, HEAD, 0))
      .not.toContain(formatReviewFollowUpMarkerKey(84));
  });
});

describe('parseReviewFollowUpsPayload', () => {
  it('accepts ≤5 valid entries and rejects >5', () => {
    const one = {
      followUps: [{
        type: 'chore',
        title: 'Tidy timeout constant',
        body: 'Non-blocking nit.',
        effort: 'low',
        priority: 'p3',
      }],
    };
    expect(parseReviewFollowUpsPayload(JSON.stringify(one))).toHaveLength(1);
    const six = {
      followUps: Array.from({ length: 6 }, (_, i) => ({
        type: 'fix',
        title: `Item ${i}`,
        body: 'x',
        effort: 'low',
        priority: 'p2',
      })),
    };
    expect(() => parseReviewFollowUpsPayload(JSON.stringify(six)))
      .toThrow(/at most 5/i);
    expect(MAX_REVIEW_FOLLOW_UPS_PER_PASS).toBe(5);
  });

  it('rejects title or body that embeds a child marker (fail-closed)', () => {
    const childMarker = '<!-- jinn-autopilot:child pr=84 kind=review-finding -->';
    const withBody = {
      followUps: [{
        type: 'chore',
        title: 'Innocent title',
        body: `Debt note\n\n${childMarker}\n`,
        effort: 'low',
        priority: 'p3',
      }],
    };
    expect(() => parseReviewFollowUpsPayload(JSON.stringify(withBody)))
      .toThrow(/child marker|jinn-autopilot:child/i);

    const withTitle = {
      followUps: [{
        type: 'fix',
        title: `Hijack ${childMarker}`,
        body: 'Looks fine',
        effort: 'low',
        priority: 'p2',
      }],
    };
    expect(() => parseReviewFollowUpsPayload(JSON.stringify(withTitle)))
      .toThrow(/child marker|jinn-autopilot:child/i);

    // Substring without a full parseable marker still rejected.
    const substringOnly = {
      followUps: [{
        type: 'feat',
        title: 'Also bad',
        body: 'mentions jinn-autopilot:child in prose',
        effort: 'medium',
        priority: 'p2',
      }],
    };
    expect(() => parseReviewFollowUpsPayload(JSON.stringify(substringOnly)))
      .toThrow(/child marker|jinn-autopilot:child/i);
  });
});

describe('fileReviewFollowUps', () => {
  it('is idempotent on a same-pass retry and applies Project triage without child labels', async () => {
    const h = followUpHarness();
    const entries = [entry()];
    const first = await fileReviewFollowUps(h.port, {
      parentPr: 84,
      head: HEAD,
      entries,
    });
    const second = await fileReviewFollowUps(h.port, {
      parentPr: 84,
      head: HEAD,
      entries,
    });
    expect(first).toEqual([{ number: 100, created: true, index: 0 }]);
    expect(second).toEqual([{ number: 100, created: false, index: 0 }]);
    expect(h.created).toHaveLength(1);
    expect(h.triageCalls).toEqual([
      { issueNumber: 100, type: 'feat', effort: 'medium', priority: 'p2' },
      { issueNumber: 100, type: 'feat', effort: 'medium', priority: 'p2' },
    ]);
    expect(h.created[0]!.body).toContain(formatReviewFollowUpMarker(84, HEAD, 0));
    expect(h.created[0]!.body).not.toContain('jinn-autopilot:child');
    expect(h.created[0]!.type).toBe('feat');
  });

  // The #124 regression. `head` moves on exactly the event that causes a
  // re-review, so a head-keyed lookup can only ever catch a retry of the same
  // pass. mono #3285 paid this tax on five consecutive laps.
  it('does not re-file an open follow-up when the head moved between passes', async () => {
    const h = followUpHarness();
    await fileReviewFollowUps(h.port, {
      parentPr: 84,
      head: HEAD,
      entries: [entry({ title: 'Publish the renamed reader alias' })],
    });
    const second = await fileReviewFollowUps(h.port, {
      parentPr: 84,
      head: NEXT_HEAD,
      entries: [entry({ title: 'Publish the renamed reader alias' })],
    });

    expect(second).toEqual([{ number: 100, created: false, index: 0 }]);
    expect(h.created).toHaveLength(1);
    // One parent-scoped lookup per pass, not one per entry.
    expect(h.searches).toEqual([
      formatReviewFollowUpMarkerKey(84),
      formatReviewFollowUpMarkerKey(84),
    ]);
  });

  it('still triages the existing issue on a cross-pass dedup hit', async () => {
    const h = followUpHarness();
    await fileReviewFollowUps(h.port, {
      parentPr: 84,
      head: HEAD,
      entries: [entry({ effort: 'low', priority: 'p4' })],
    });
    h.triageCalls.length = 0;
    await fileReviewFollowUps(h.port, {
      parentPr: 84,
      head: NEXT_HEAD,
      entries: [entry({ effort: 'high', priority: 'p1' })],
    });
    expect(h.triageCalls).toEqual([
      { issueNumber: 100, type: 'feat', effort: 'high', priority: 'p1' },
    ]);
  });

  it('matches titles up to whitespace, case, and trailing punctuation only', async () => {
    const h = followUpHarness();
    await fileReviewFollowUps(h.port, {
      parentPr: 84,
      head: HEAD,
      entries: [entry({ title: 'Publish the renamed reader alias' })],
    });
    const second = await fileReviewFollowUps(h.port, {
      parentPr: 84,
      head: NEXT_HEAD,
      entries: [
        entry({ title: '  publish   THE renamed reader  alias.  ' }),
        // Internal punctuation is identity, not noise: a package path is the
        // whole point of the finding, so it must not be normalized away.
        entry({ title: 'Publish @colophon-claims/check' }),
      ],
    });
    expect(second).toEqual([
      { number: 100, created: false, index: 0 },
      { number: 101, created: true, index: 1 },
    ]);
    expect(h.created).toHaveLength(2);
  });

  it('files a genuinely new entry at a different head', async () => {
    const h = followUpHarness();
    await fileReviewFollowUps(h.port, {
      parentPr: 84,
      head: HEAD,
      entries: [entry({ title: 'Publish the renamed reader alias' })],
    });
    const second = await fileReviewFollowUps(h.port, {
      parentPr: 84,
      head: NEXT_HEAD,
      entries: [entry({ title: 'Prove the alias forwards, in CI' })],
    });
    expect(second).toEqual([{ number: 101, created: true, index: 0 }]);
    expect(h.created.map((issue) => issue.title)).toEqual([
      'Publish the renamed reader alias',
      'Prove the alias forwards, in CI',
    ]);
  });

  // The machine exit: dedup reads open issues only, so a finding that recurs
  // after its follow-up was closed must be fileable again.
  it('re-files when the prior follow-up is closed', async () => {
    const h = followUpHarness([{
      number: 100,
      title: 'Publish the renamed reader alias',
      body: `${formatReviewFollowUpMarker(84, HEAD, 0)}\n\nold`,
      state: 'closed',
    }]);
    const filed = await fileReviewFollowUps(h.port, {
      parentPr: 84,
      head: NEXT_HEAD,
      entries: [entry({ title: 'Publish the renamed reader alias' })],
    });
    expect(filed).toEqual([{ number: 100, created: true, index: 0 }]);
    expect(h.created).toHaveLength(1);
  });

  it('never dedups against another parent whose number shares the prefix', async () => {
    const h = followUpHarness([{
      number: 900,
      title: 'Publish the renamed reader alias',
      body: `${formatReviewFollowUpMarker(845, HEAD, 0)}\n\nother parent`,
      state: 'open',
    }]);
    const filed = await fileReviewFollowUps(h.port, {
      parentPr: 84,
      head: HEAD,
      entries: [entry({ title: 'Publish the renamed reader alias' })],
    });
    expect(filed).toEqual([{ number: 100, created: true, index: 0 }]);
  });

  // head/index stay on the written marker: they say which pass filed what.
  // They just stop being the dedup key.
  it('keeps head and index on the written marker', async () => {
    const h = followUpHarness();
    await fileReviewFollowUps(h.port, {
      parentPr: 84,
      head: NEXT_HEAD,
      entries: [entry({ title: 'A' }), entry({ title: 'B' })],
    });
    expect(h.created[0]!.body)
      .toContain(formatReviewFollowUpMarker(84, NEXT_HEAD, 0));
    expect(h.created[1]!.body)
      .toContain(formatReviewFollowUpMarker(84, NEXT_HEAD, 1));
    expect(parseReviewFollowUpMarker(h.created[1]!.body)).toEqual({
      parentPr: 84,
      head: NEXT_HEAD,
      index: 1,
    });
  });

  it('keeps the per-pass cap exactly where it was', async () => {
    const h = followUpHarness();
    const entries = Array.from(
      { length: MAX_REVIEW_FOLLOW_UPS_PER_PASS },
      (_unused, index) => entry({ title: `Item ${index}` }),
    );
    const filed = await fileReviewFollowUps(h.port, {
      parentPr: 84,
      head: HEAD,
      entries,
    });
    expect(filed).toHaveLength(MAX_REVIEW_FOLLOW_UPS_PER_PASS);
    await expect(fileReviewFollowUps(h.port, {
      parentPr: 84,
      head: HEAD,
      entries: [...entries, entry({ title: 'Item 5' })],
    })).rejects.toThrow(/cap of 5/i);
  });

  it('rejects entries whose title/body embed a child marker and creates no issue', async () => {
    const created: Array<{ title: string; body: string }> = [];
    const port: ReviewFollowUpPort = {
      async searchOpenByMarker() {
        return [];
      },
      async createIssue(input) {
        created.push({ title: input.title, body: input.body });
        return { number: 999 };
      },
      async ensureTriageComplete() {},
    };

    const childMarker = '<!-- jinn-autopilot:child pr=84 kind=reconcile -->';
    await expect(
      fileReviewFollowUps(port, {
        parentPr: 84,
        head: HEAD,
        entries: [{
          type: 'chore',
          title: 'Looks fine',
          body: `Non-blocking\n${childMarker}`,
          effort: 'low',
          priority: 'p3',
        }],
      }),
    ).rejects.toThrow(/child marker|jinn-autopilot:child/i);
    expect(created).toHaveLength(0);

    await expect(
      fileReviewFollowUps(port, {
        parentPr: 84,
        head: HEAD,
        entries: [{
          type: 'fix',
          title: `Poison ${childMarker}`,
          body: 'ok body',
          effort: 'low',
          priority: 'p2',
        }],
      }),
    ).rejects.toThrow(/child marker|jinn-autopilot:child/i);
    expect(created).toHaveLength(0);
  });
});

describe('hasReviewFollowUpMarkerTag', () => {
  // Separates "no marker" from "marker present but malformed" so eligibility
  // can fail closed on the second without gating ordinary issues.
  it('matches a machine marker whose head or index is corrupt', () => {
    expect(hasReviewFollowUpMarkerTag(formatReviewFollowUpMarker(84, HEAD, 0))).toBe(true);
    expect(hasReviewFollowUpMarkerTag('<!-- jinn-autopilot:review-follow-up pr=84 -->')).toBe(true);
    expect(
      hasReviewFollowUpMarkerTag('<!--jinn-autopilot:review-follow-up pr=84 head=abc-->'),
    ).toBe(true);
    expect(
      hasReviewFollowUpMarkerTag(
        `<!-- jinn-autopilot:review-follow-up pr=84 head=${HEAD} index=x -->`,
      ),
    ).toBe(true);
  });

  it('does not match prose, a different tag, or a longer tag name', () => {
    expect(hasReviewFollowUpMarkerTag('See jinn-autopilot:review-follow-up for the format.')).toBe(false);
    expect(hasReviewFollowUpMarkerTag('<!-- jinn-autopilot:child pr=84 kind=review-finding -->')).toBe(false);
    expect(hasReviewFollowUpMarkerTag('<!-- jinn-autopilot:review-follow-ups pr=84 -->')).toBe(false);
    // The separator before `pr=` is required, not optional: the pattern is the
    // full marker regex truncated, not a loose prefix that lets the tag run on
    // into the first field.
    expect(hasReviewFollowUpMarkerTag('<!-- jinn-autopilot:review-follow-uppr=84 -->')).toBe(false);
    expect(hasReviewFollowUpMarkerTag('')).toBe(false);
  });

  // The permanent hold must not fire on documentation. Issues in this repo are
  // routinely written by agents told to cite canon, and canon §5.1 prints the
  // marker *template* verbatim; before the `pr=\d` requirement that template
  // matched, stranding any such issue at `eligible: false` forever.
  it('does not match the canon §5.1 marker template, bare or fenced', () => {
    expect(CANON_MARKER_TEMPLATE).toContain('jinn-autopilot:review-follow-up');
    expect(parseReviewFollowUpMarker(CANON_MARKER_TEMPLATE)).toBeNull();

    expect(hasReviewFollowUpMarkerTag(CANON_MARKER_TEMPLATE)).toBe(false);
    expect(
      hasReviewFollowUpMarkerTag(
        `Per canon §5.1 the body marker is:\n\n\`\`\`\n${CANON_MARKER_TEMPLATE}\n\`\`\`\n`,
      ),
    ).toBe(false);
    expect(
      hasReviewFollowUpMarkerTag(`Body marker: \`${CANON_MARKER_TEMPLATE}\`.`),
    ).toBe(false);
  });

  // The deliberate cost of requiring `pr=<digit>`: a corruption that eats the
  // `pr=` field itself is no longer detectable as a marker, and such a body
  // falls through to ordinary triage instead of the permanent hold. Pinned so
  // the trade stays a decision rather than a regression.
  it('gives up on corruption that destroys the pr= field itself', () => {
    expect(hasReviewFollowUpMarkerTag('<!--jinn-autopilot:review-follow-up garbage-->')).toBe(false);
    expect(hasReviewFollowUpMarkerTag('<!-- jinn-autopilot:review-follow-up pr= -->')).toBe(false);
  });
});
