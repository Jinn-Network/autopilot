import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_REVIEW_FOLLOW_UPS_PER_PASS,
  fileReviewFollowUps,
  hasReviewFollowUpMarkerTag,
  formatReviewFollowUpMarker,
  parseReviewFollowUpMarker,
  parseReviewFollowUpsPayload,
  type ReviewFollowUpPort,
} from '../../src/lifecycle/review-follow-ups.js';

const HEAD = 'a'.repeat(40);

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
  it('is idempotent per pr+head+index and applies Project triage without child labels', async () => {
    const created: Array<{ title: string; body: string; type: string }> = [];
    const triageCalls: Array<{ issueNumber: number; type: string; effort: string; priority: string }> = [];
    const issues: Array<{ number: number; body: string; state: 'open' | 'closed' }> = [];
    let next = 100;
    const port: ReviewFollowUpPort = {
      async searchOpenByMarker(marker) {
        return issues
          .filter((i) => i.state === 'open' && i.body.includes(marker))
          .map((i) => ({ number: i.number }));
      },
      async createIssue(input) {
        created.push({ title: input.title, body: input.body, type: input.type });
        const number = next++;
        issues.push({ number, body: input.body, state: 'open' });
        return { number };
      },
      async ensureTriageComplete(input) {
        triageCalls.push({ ...input });
      },
    };

    const entries = [{
      type: 'feat' as const,
      title: 'Follow-up A',
      body: 'Debt note',
      effort: 'medium' as const,
      priority: 'p2' as const,
    }];
    const first = await fileReviewFollowUps(port, {
      parentPr: 84,
      head: HEAD,
      entries,
    });
    const second = await fileReviewFollowUps(port, {
      parentPr: 84,
      head: HEAD,
      entries,
    });
    expect(first).toEqual([{ number: 100, created: true, index: 0 }]);
    expect(second).toEqual([{ number: 100, created: false, index: 0 }]);
    expect(created).toHaveLength(1);
    expect(triageCalls).toEqual([
      { issueNumber: 100, type: 'feat', effort: 'medium', priority: 'p2' },
      { issueNumber: 100, type: 'feat', effort: 'medium', priority: 'p2' },
    ]);
    expect(created[0]!.body).toContain(formatReviewFollowUpMarker(84, HEAD, 0));
    expect(created[0]!.body).not.toContain('jinn-autopilot:child');
    expect(created[0]!.type).toBe('feat');
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
