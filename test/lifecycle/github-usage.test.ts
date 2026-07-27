import { describe, expect, it } from 'vitest';
import {
  EXPECTED_ACCOUNTING_APPROXIMATION_PREFIX,
  FULL_SCAN_RESERVE,
  GitHubUsageMeter,
  OPAQUE_SPAN_SKEW_APPROXIMATION,
  TARGETED_PR_RESERVE,
  assertRateLimitReserve,
  makeGitHubUsageCommandRunner,
  slurpedRestPageCount,
} from '../../src/lifecycle/github-usage.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

describe('GitHubUsageMeter', () => {
  it('aggregates GraphQL cost and remaining plus REST, 304, and cache-hit counts', () => {
    const meter = new GitHubUsageMeter();

    meter.recordGraphQlResponse({
      data: {
        rateLimit: {
          cost: 7,
          remaining: 4_993,
          resetAt: '2026-07-22T13:00:00.000Z',
        },
      },
    });
    meter.recordGraphQlResponse({
      data: {
        rateLimit: {
          cost: 11,
          remaining: 4_982,
          resetAt: '2026-07-22T13:00:00.000Z',
        },
      },
    });
    meter.recordRestRequest(200);
    meter.recordRestRequest(304);
    meter.recordCacheHit();

    expect(meter.read()).toEqual({
      graphqlRequests: 2,
      graphqlCost: 18,
      graphqlRemaining: 4_982,
      graphqlResetAt: '2026-07-22T13:00:00.000Z',
      restRequests: 2,
      restNotModified: 1,
      cacheHits: 1,
      accountingComplete: true,
    });
  });

  it('fails closed without mutating usage when GraphQL rate-limit evidence is incomplete', () => {
    const meter = new GitHubUsageMeter();

    expect(() => meter.recordGraphQlResponse({ data: { rateLimit: { remaining: 42 } } }))
      .toThrow(/rateLimit|cost|resetAt/i);
    expect(meter.read()).toMatchObject({ graphqlRequests: 0, graphqlCost: 0 });
  });

  it('returns a successful GraphQL mutation with no rate-limit evidence and records incomplete known-request usage', async () => {
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(async () => JSON.stringify({
      data: { updateIssueIssueType: { issue: { number: 99 } } },
    }), meter);

    await expect(run('gh', ['api', 'graphql', '-f', 'query=mutation { updateIssueIssueType { issue { number } } }']))
      .resolves.toContain('updateIssueIssueType');
    expect(meter.read()).toEqual({
      graphqlRequests: 1,
      graphqlCost: 0,
      graphqlRemaining: null,
      graphqlResetAt: null,
      restRequests: 0,
      restNotModified: 0,
      cacheHits: 0,
      accountingComplete: false,
      incompleteReason: expect.stringMatching(/rate-limit evidence/i),
    });
  });

  it.each([
    ['transport failure', async () => {
      throw new Error('network unavailable');
    }],
    ['invalid JSON', async () => '{not-json'],
    ['non-empty GraphQL errors', async () => JSON.stringify({
      data: { updateIssueIssueType: null },
      errors: [{ message: 'Issue Type assignment was rejected' }],
    })],
  ])('fails closed on explicit GraphQL %s', async (_label, raw) => {
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(raw, meter);

    await expect(run('gh', ['api', 'graphql', '-f', 'query=mutation { updateIssueIssueType { issue { number } } }']))
      .rejects.toThrow();
  });

  it('keeps remaining and resetAt paired to the newest quota window', () => {
    const meter = new GitHubUsageMeter();
    meter.recordGraphQlResponse({
      data: {
        rateLimit: {
          cost: 3,
          remaining: 2,
          resetAt: '2026-07-22T13:00:00.000Z',
        },
      },
    });
    meter.recordGraphQlResponse({
      data: {
        rateLimit: {
          cost: 1,
          remaining: 4_999,
          resetAt: '2026-07-22T14:00:00.000Z',
        },
      },
    });
    // A late response from the old window must not re-pair its low balance
    // with the newer window's reset timestamp.
    meter.recordGraphQlResponse({
      data: {
        rateLimit: {
          cost: 2,
          remaining: 1,
          resetAt: '2026-07-22T13:00:00.000Z',
        },
      },
    });

    expect(meter.read()).toMatchObject({
      graphqlRequests: 3,
      graphqlCost: 6,
      graphqlRemaining: 4_999,
      graphqlResetAt: '2026-07-22T14:00:00.000Z',
    });
  });

  it('reconciles opaque gh GraphQL usage with credential-preserving probes', async () => {
    const calls: Array<{
      readonly args: readonly string[];
      readonly token: string | undefined;
    }> = [];
    let probe = 0;
    const raw: CommandRunner = async (_command, args, options) => {
      calls.push({ args, token: options?.env?.GH_TOKEN });
      if (args[0] !== 'api' || args[1] !== 'graphql') return 'edited';
      probe += 1;
      return JSON.stringify({
        data: {
          rateLimit: probe === 1
            ? {
                cost: 1,
                remaining: 998,
                resetAt: '2026-07-22T13:00:00.000Z',
                used: 2,
                limit: 1_000,
              }
            : {
                cost: 1,
                remaining: 990,
                resetAt: '2026-07-22T13:00:00.000Z',
                used: 10,
                limit: 1_000,
              },
        },
      });
    };
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(raw, meter);

    await expect(run('gh', ['project', 'item-edit'], {
      env: { GH_TOKEN: 'selected-token' },
    })).resolves.toBe('edited');

    expect(calls).toHaveLength(3);
    expect(calls[0]?.args).toEqual([
      'api',
      'graphql',
      '-f',
      expect.stringContaining('rateLimit { cost remaining resetAt used limit }'),
    ]);
    expect(calls[1]?.args).toEqual(['project', 'item-edit']);
    expect(calls[2]?.args).toEqual(calls[0]?.args);
    expect(calls.map((call) => call.token)).toEqual([
      'selected-token',
      'selected-token',
      'selected-token',
    ]);
    expect(meter.read()).toMatchObject({
      graphqlRequests: 2,
      graphqlCost: 9,
      graphqlRemaining: 990,
      graphqlResetAt: '2026-07-22T13:00:00.000Z',
    });
  });

  it('surfaces eventually-consistent counter skew as non-fatal incomplete accounting', async () => {
    // GitHub's rateLimit.used/remaining counters are eventually consistent:
    // under dozens of concurrent GraphQL reads on one token the before/after
    // probes disagree (here remaining fell by 10 while used rose by 12). That
    // skew is expected, not corrupt — the opaque command still succeeded, so
    // it must return its stdout and the read must stay non-fatal. Accounting
    // completeness is observability, never a correctness gate.
    let probe = 0;
    const raw: CommandRunner = async (_command, args) => {
      if (args[0] !== 'api' || args[1] !== 'graphql') return 'viewed';
      probe += 1;
      return JSON.stringify({
        data: {
          rateLimit: probe === 1
            ? {
                cost: 1,
                remaining: 1_000,
                resetAt: '2026-07-22T13:00:00.000Z',
                used: 0,
                limit: 5_000,
              }
            : {
                cost: 1,
                remaining: 990,
                resetAt: '2026-07-22T13:00:00.000Z',
                used: 12,
                limit: 5_000,
              },
        },
      });
    };
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(raw, meter);

    await expect(run('gh', ['pr', 'view', '42'])).resolves.toBe('viewed');

    const usage = meter.read();
    expect(usage.accountingComplete).toBe(false);
    // Skew is an EXPECTED approximation, not an anomaly: it is a property of
    // GitHub's counters, it fires on essentially every cycle, and it leaves the
    // quota numbers themselves exact. Reported as such, so it stops being
    // indistinguishable from a cycle that genuinely failed to evidence
    // something. The flag itself is unchanged — graphqlCost IS a lower bound.
    expect(usage.incompleteReason)
      .toMatch(new RegExp(`^${EXPECTED_ACCOUNTING_APPROXIMATION_PREFIX}`));
    expect(usage.incompleteReason).toContain('graphqlCost is a lower bound');
    expect(usage.incompleteReason).toContain('remain exact');
    // Best-effort quota evidence from both probes still advances.
    expect(usage.graphqlRequests).toBe(2);
    expect(usage.graphqlRemaining).toBe(990);
    expect(usage.graphqlResetAt).toBe('2026-07-22T13:00:00.000Z');
  });

  it('collapses repeated counter skew into one approximation rather than one per command', async () => {
    // The same approximation fires on every opaque command in a cycle. It must
    // read as one statement about the cycle, not N copies of the same sentence.
    let probe = 0;
    const raw: CommandRunner = async (_command, args) => {
      if (args[0] !== 'api' || args[1] !== 'graphql') return 'viewed';
      probe += 1;
      return JSON.stringify({
        data: {
          rateLimit: {
            cost: 1,
            remaining: 1_000 - probe * 10,
            resetAt: '2026-07-22T13:00:00.000Z',
            used: probe * 12,
            limit: 5_000,
          },
        },
      });
    };
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(raw, meter);

    await expect(run('gh', ['pr', 'view', '42'])).resolves.toBe('viewed');
    await expect(run('gh', ['pr', 'view', '43'])).resolves.toBe('viewed');

    const reason = meter.read().incompleteReason!;
    expect(reason.split('graphqlCost is a lower bound')).toHaveLength(2);
  });

  it('never lets an expected approximation demote a genuine accounting anomaly', async () => {
    // A cycle that both skewed AND failed to evidence something is an anomaly.
    // The prefix is the report's severity switch, so an approximation recorded
    // alongside a real gap must not be allowed to flip it.
    const meter = new GitHubUsageMeter();
    meter.markApproximate(OPAQUE_SPAN_SKEW_APPROXIMATION);
    meter.markIncomplete('the closing opaque-command quota probe failed');

    const usage = meter.read();
    expect(usage.accountingComplete).toBe(false);
    expect(usage.incompleteReason)
      .not.toMatch(new RegExp(`^${EXPECTED_ACCOUNTING_APPROXIMATION_PREFIX}`));
    // Both are still reported; neither masks the other.
    expect(usage.incompleteReason).toContain('closing opaque-command quota probe failed');
    expect(usage.incompleteReason).toContain('graphqlCost is a lower bound');
  });

  it('clears recorded approximations on reset', async () => {
    const meter = new GitHubUsageMeter();
    meter.markApproximate(OPAQUE_SPAN_SKEW_APPROXIMATION);
    expect(meter.read().accountingComplete).toBe(false);
    meter.reset();
    expect(meter.read()).toMatchObject({ accountingComplete: true });
    expect(meter.read().incompleteReason).toBeUndefined();
  });

  it('keeps a successful opaque command whose closing quota probe fails to transport', async () => {
    // A closing-probe transport failure is an accounting problem, never the
    // command's result: a command that already succeeded must return its
    // stdout, and the read must stay non-fatal.
    let probe = 0;
    const raw: CommandRunner = async (_command, args) => {
      if (args[0] === 'api' && args[1] === 'graphql') {
        probe += 1;
        if (probe === 1) {
          return JSON.stringify({
            data: {
              rateLimit: {
                cost: 1,
                remaining: 1_000,
                resetAt: '2026-07-22T13:00:00.000Z',
                used: 0,
                limit: 5_000,
              },
            },
          });
        }
        throw new Error('closing probe network failure');
      }
      return 'viewed';
    };
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(raw, meter);

    await expect(run('gh', ['pr', 'view', '42'])).resolves.toBe('viewed');
    expect(meter.read().accountingComplete).toBe(false);
  });

  it('fails before an opaque command when its opening probe evidence is malformed', async () => {
    let opaqueExecuted = false;
    const raw: CommandRunner = async (_command, args) => {
      if (args[0] === 'api' && args[1] === 'graphql') {
        return JSON.stringify({ data: { rateLimit: { remaining: 999 } } });
      }
      opaqueExecuted = true;
      return 'edited';
    };
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(raw, meter);

    await expect(run('gh', ['project', 'item-edit'])).rejects.toThrow(/rateLimit|cost/i);
    expect(opaqueExecuted).toBe(false);
    // read() surfaces incompleteness as a non-fatal flag rather than throwing:
    // GitHub used/remaining counters are eventually consistent under
    // concurrency, so accounting skew must be observable, never fatal.
    expect(meter.read().accountingComplete).toBe(false);
  });

  it('does not start an opaque mutation span below floor plus its modeled reserve', async () => {
    const meter = new GitHubUsageMeter();
    meter.recordGraphQlResponse({
      data: {
        rateLimit: {
          cost: 1,
          remaining: 509,
          resetAt: '2026-07-22T13:00:00.000Z',
        },
      },
    });
    let called = false;
    const run = makeGitHubUsageCommandRunner(async () => {
      called = true;
      return 'unexpected';
    }, meter, { rateLimitFloor: 500 });

    await expect(run('gh', ['project', 'item-edit']))
      .rejects.toThrow(/510|reserve|rate-limit/i);
    expect(called).toBe(false);
  });

  it('uses the fresh opening probe to enforce the opaque reserve with no prior evidence', async () => {
    const calls: string[] = [];
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(async (_command, args) => {
      if (args[0] === 'api') {
        calls.push('opening-probe');
        return JSON.stringify({
          data: {
            rateLimit: {
              cost: 1,
              remaining: 509,
              resetAt: '2026-07-22T13:00:00.000Z',
              used: 491,
              limit: 1_000,
            },
          },
        });
      }
      calls.push('opaque-mutation');
      return 'unexpected';
    }, meter, { rateLimitFloor: 500 });

    await expect(run('gh', ['project', 'item-edit']))
      .rejects.toThrow(/510|reserve|rate-limit/i);
    expect(calls).toEqual(['opening-probe']);
    expect(meter.read()).toMatchObject({
      graphqlRequests: 1,
      graphqlCost: 1,
      graphqlRemaining: 509,
    });
  });

  it('uses the fresh opening probe when quota drifted below the prior metered balance', async () => {
    const calls: string[] = [];
    const meter = new GitHubUsageMeter();
    meter.recordGraphQlResponse({
      data: {
        rateLimit: {
          cost: 1,
          remaining: 700,
          resetAt: '2026-07-22T13:00:00.000Z',
        },
      },
    });
    const run = makeGitHubUsageCommandRunner(async (_command, args) => {
      if (args[0] === 'api') {
        calls.push('opening-probe');
        return JSON.stringify({
          data: {
            rateLimit: {
              cost: 1,
              remaining: 509,
              resetAt: '2026-07-22T13:00:00.000Z',
              used: 491,
              limit: 1_000,
            },
          },
        });
      }
      calls.push('opaque-mutation');
      return 'unexpected';
    }, meter, { rateLimitFloor: 500 });

    await expect(run('gh', ['project', 'item-edit']))
      .rejects.toThrow(/510|reserve|rate-limit/i);
    expect(calls).toEqual(['opening-probe']);
    expect(meter.read().graphqlRemaining).toBe(509);
  });

  it('publishes the minimum remaining quota paired to its credential window', async () => {
    const raw: CommandRunner = async (_command, _args, options) => JSON.stringify({
      data: {
        rateLimit: options?.env?.GH_TOKEN === 'implementer-secret'
          ? {
              cost: 3,
              remaining: 501,
              resetAt: '2026-07-22T13:00:00.000Z',
            }
          : {
              cost: 2,
              remaining: 4_999,
              resetAt: '2026-07-22T14:00:00.000Z',
            },
      },
    });
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(raw, meter);

    await run('gh', ['api', 'graphql'], { env: { GH_TOKEN: 'implementer-secret' } });
    await run('gh', ['api', 'graphql'], { env: { GH_TOKEN: 'reviewer-secret' } });

    expect(meter.read()).toMatchObject({
      graphqlCost: 5,
      graphqlRemaining: 501,
      graphqlResetAt: '2026-07-22T13:00:00.000Z',
    });
    expect(JSON.stringify(meter.read())).not.toMatch(/implementer-secret|reviewer-secret/);
  });

  it('serializes concurrent opaque commands into disjoint probe intervals', async () => {
    const ledger: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const probes = [
      { cost: 1, remaining: 999, used: 1 },
      { cost: 1, remaining: 993, used: 7 },
      { cost: 1, remaining: 992, used: 8 },
      { cost: 1, remaining: 988, used: 12 },
    ];
    let probeIndex = 0;
    const raw: CommandRunner = async (_command, args) => {
      if (args[0] === 'api') {
        ledger.push(`probe-${probeIndex + 1}`);
        const evidence = probes[probeIndex++]!;
        return JSON.stringify({
          data: {
            rateLimit: {
              ...evidence,
              resetAt: '2026-07-22T13:00:00.000Z',
              limit: 1_000,
            },
          },
        });
      }
      const name = args[2]!;
      ledger.push(`command-${name}`);
      if (name === 'first') {
        markFirstStarted();
        await firstBlocked;
      }
      return name;
    };
    const run = makeGitHubUsageCommandRunner(raw, new GitHubUsageMeter());

    const first = run('gh', ['project', 'item-edit', 'first']);
    await firstStarted;
    const second = run('gh', ['project', 'item-edit', 'second']);
    await Promise.resolve();
    await Promise.resolve();

    expect(ledger).toEqual(['probe-1', 'command-first']);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(ledger).toEqual([
      'probe-1',
      'command-first',
      'probe-2',
      'probe-3',
      'command-second',
      'probe-4',
    ]);
  });

  it('runs hidden REST pagination best-effort instead of crashing the loop', async () => {
    let called = false;
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(async () => {
      called = true;
      return '[]';
    }, meter);

    // --paginate collapses N HTTP pages into one gh invocation, so the exact
    // per-page request count is unobservable. Per #2013 (never crash the loop
    // on incomplete usage accounting), that must not fail the command: the
    // review and reconciliation paths legitimately page a PR's comments and
    // reviews via `--paginate --slurp`. The command runs; the undercount is
    // recorded at the one-request floor and surfaced as incomplete, not thrown.
    const raw = await run('gh', [
      'api',
      'repos/Jinn-Network/mono/issues/42/comments',
      '--paginate',
    ]);
    expect(raw).toBe('[]');
    expect(called).toBe(true);
    const usage = meter.read();
    expect(usage.restRequests).toBe(1);
    expect(usage.accountingComplete).toBe(false);
    expect(usage.incompleteReason).toMatch(/page count/i);
  });

  // The page count is only hidden for the `--paginate` forms that merge or
  // filter the pages away. `--slurp` returns one array element PER HTTP page,
  // so the count is carried in the response and just needed reading — which is
  // what made every cycle that reads a PR's comments or changed files report
  // incomplete accounting. `--slurp` is mutually exclusive with `--jq` and
  // `--template` in gh, so a slurped payload is always the raw page array.
  it('counts `--paginate --slurp` pages exactly and keeps accounting complete', async () => {
    let seen: readonly string[] | undefined;
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(async (_command, args) => {
      seen = args;
      return JSON.stringify([[{ id: 1 }], [{ id: 2 }], []]);
    }, meter);

    const raw = await run('gh', [
      'api',
      'repos/Jinn-Network/mono/issues/42/comments',
      '--paginate',
      '--slurp',
    ]);

    expect(JSON.parse(raw)).toHaveLength(3);
    // Same argv, run exactly once: this is accounting only, never a request
    // behaviour change.
    expect(seen).toEqual([
      'api',
      'repos/Jinn-Network/mono/issues/42/comments',
      '--paginate',
      '--slurp',
    ]);
    const usage = meter.read();
    expect(usage.restRequests).toBe(3);
    expect(usage.accountingComplete).toBe(true);
    expect(usage.incompleteReason).toBeUndefined();
  });

  it('falls back to the one-request floor when a slurped page array is unreadable', async () => {
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(
      async () => '{"message":"Not Found"}',
      meter,
    );

    await expect(run('gh', ['api', 'repos/o/r/x', '--paginate', '--slurp']))
      .resolves.toBe('{"message":"Not Found"}');

    const usage = meter.read();
    expect(usage.restRequests).toBe(1);
    expect(usage.accountingComplete).toBe(false);
    expect(usage.incompleteReason).toMatch(/not a page array/i);
  });

  it('keeps a failed paginated command failing and records the request floor', async () => {
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(async () => {
      throw new Error('gh exploded');
    }, meter);

    await expect(run('gh', ['api', 'repos/o/r/x', '--paginate', '--slurp']))
      .rejects.toThrow('gh exploded');

    const usage = meter.read();
    expect(usage.restRequests).toBe(1);
    expect(usage.accountingComplete).toBe(false);
    expect(usage.incompleteReason).toMatch(/before its page count/i);
  });

  it.each([
    ['a non-array payload', '{"a":1}'],
    ['an empty page array', '[]'],
    ['unparseable JSON', 'not json'],
  ] as const)('reads no page count from %s', (_label, raw) => {
    expect(slurpedRestPageCount(raw)).toBeNull();
  });

  it('records the HTTP status exposed by an included REST response', async () => {
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(async () => [
      'HTTP/2.0 304 Not Modified',
      'etag: "cached"',
      '',
      '',
    ].join('\r\n'), meter);

    await run('gh', ['api', '--include', 'repos/Jinn-Network/mono/issues']);

    expect(meter.read()).toMatchObject({
      restRequests: 1,
      restNotModified: 1,
    });
  });

  it('records a thrown included 304 from error stdout exactly once and rethrows it', async () => {
    const meter = new GitHubUsageMeter();
    const failure = Object.assign(new Error('Command failed: gh api --include'), {
      stdout: [
        'HTTP/2.0 304 Not Modified',
        'etag: "cached"',
        '',
        '',
      ].join('\r\n'),
      stderr: 'gh: HTTP 304',
      code: 1,
    });
    const run = makeGitHubUsageCommandRunner(async () => {
      throw failure;
    }, meter);

    await expect(run('gh', ['api', '--include', 'repos/Jinn-Network/mono/issues']))
      .rejects.toBe(failure);
    expect(meter.read()).toMatchObject({
      restRequests: 1,
      restNotModified: 1,
      cacheHits: 0,
    });
  });
});

describe('GitHub quota reserves', () => {
  it('pins the full-scan and targeted-PR reserves', () => {
    expect(FULL_SCAN_RESERVE).toBe(450);
    expect(TARGETED_PR_RESERVE).toBe(10);
  });

  it('allows the exact reserve boundary and rejects one point below it', () => {
    expect(() => assertRateLimitReserve(950, FULL_SCAN_RESERVE)).not.toThrow();
    expect(() => assertRateLimitReserve(949, FULL_SCAN_RESERVE)).toThrow(/950/);
    expect(() => assertRateLimitReserve(510, TARGETED_PR_RESERVE)).not.toThrow();
    expect(() => assertRateLimitReserve(509, TARGETED_PR_RESERVE)).toThrow(/510/);
  });

  it('retains the absolute 500-point floor even when callers request a lower floor', () => {
    expect(() => assertRateLimitReserve(949, FULL_SCAN_RESERVE, 100)).toThrow(/950/);
  });
});
