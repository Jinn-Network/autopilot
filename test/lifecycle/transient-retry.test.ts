import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MS,
  MAX_READ_ATTEMPTS,
  classifyTransportFault,
  isRetryableReadCommand,
  withTransientReadRetry,
} from '../../src/lifecycle/transient-retry.js';
import {
  GitHubUsageMeter,
  makeGitHubUsageCommandRunner,
} from '../../src/lifecycle/github-usage.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

/**
 * A `gh`/`git` subprocess rejection shaped like Node's `execFile` rejection:
 * the message echoes the command line, and stderr carries the real diagnosis.
 */
function subprocessFault(stderr: string, commandLine = 'gh api graphql'): Error & {
  stderr: string;
  code: number;
} {
  return Object.assign(
    new Error(`Command failed: ${commandLine}\n${stderr}`),
    { stderr, code: 1 },
  );
}

const READ_QUERY = 'query PullRequest($n: Int!) { repository { pullRequest(number: $n) { id } } }';
const PR_READ = ['api', 'graphql', '-f', `query=${READ_QUERY}`];

const noSleep = async (): Promise<void> => {};

function countingRunner(
  responses: ReadonlyArray<() => Promise<string>>,
): { run: CommandRunner; calls: () => number } {
  let index = 0;
  return {
    run: async () => {
      const next = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      return next();
    },
    calls: () => index,
  };
}

describe('retry bounds', () => {
  it('caps one read at exactly three attempts with a fixed 250ms/1s backoff', () => {
    // Pinned as literals, not against the constants themselves: raising the cap
    // or flattening the backoff is a behaviour change that must fail a test.
    expect(MAX_READ_ATTEMPTS).toBe(3);
    expect(BACKOFF_MS).toEqual([250, 1_000]);
    expect(BACKOFF_MS).toHaveLength(MAX_READ_ATTEMPTS - 1);
  });
});

describe('classifyTransportFault', () => {
  it.each([
    ['TLS handshake timeout', 'Post "https://api.github.com/graphql": net/http: TLS handshake timeout'],
    ['read timeout', 'Client.Timeout exceeded while awaiting headers'],
    ['connection reset', 'read tcp 10.0.0.2:54321->140.82.121.6:443: read: connection reset by peer'],
    ['DNS failure', 'dial tcp: lookup api.github.com: no such host'],
    ['git DNS failure', "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com"],
    ['connection timeout', 'dial tcp 140.82.121.6:443: i/o timeout'],
  ])('classifies a %s as a transport fault', (_label, stderr) => {
    expect(classifyTransportFault(subprocessFault(stderr))).not.toBeNull();
  });

  it.each([
    ['a returned 404', 'gh: Not Found (HTTP 404)'],
    ['a returned 500', 'gh: Internal Server Error (HTTP 500)'],
    ['a returned 502', 'gh: Bad Gateway (HTTP 502)'],
    ['primary rate limiting', 'gh: API rate limit exceeded (HTTP 403)'],
    ['secondary rate limiting', 'You have exceeded a secondary rate limit'],
    ['an auth failure', 'gh: Bad credentials (HTTP 401)'],
    ['a missing binary', 'spawn gh ENOENT'],
    ['an unrelated failure', 'unexpected end of JSON input'],
  ])('does not classify %s as a transport fault', (_label, stderr) => {
    expect(classifyTransportFault(subprocessFault(stderr))).toBeNull();
  });

  // The served-response veto must be checked BEFORE the transport patterns.
  // Each of these contains both markers; classifying them as faults would retry
  // a request GitHub already received and answered.
  it.each([
    [
      'a 504 whose text also names a dial timeout',
      'gh: Gateway Timeout (HTTP 504): dial tcp 140.82.121.6:443: i/o timeout',
    ],
    [
      'a 403 rate limit whose text also names a connection reset',
      'gh: API rate limit exceeded (HTTP 403); upstream logged read: connection reset by peer',
    ],
    [
      'a 502 whose text also names a TLS handshake timeout',
      'gh: Bad Gateway (HTTP 502) - net/http: TLS handshake timeout',
    ],
  ])('vetoes %s even though a transport marker is present', (_label, stderr) => {
    expect(classifyTransportFault(subprocessFault(stderr))).toBeNull();
  });

  it('never reads stdout as fault evidence', () => {
    // stdout is the response payload. A pull-request body quoting a transport
    // fault must not make an unrelated failure look retryable.
    const served = Object.assign(new Error('Command failed: gh api repos/o/r/pulls/1'), {
      stderr: '',
      stdout: '{"body":"CI log said read: connection reset by peer"}',
    });
    expect(classifyTransportFault(served)).toBeNull();
  });

  it('vetoes a fault when stdout carries the HTTP response gh --include retained', () => {
    const served = Object.assign(new Error('Command failed: gh'), {
      stdout: 'HTTP/2.0 504 \r\nx-github-request-id: abc\r\n\r\n{"message":"Gateway Timeout"}',
      stderr: 'dial tcp 140.82.121.6:443: i/o timeout',
    });
    expect(classifyTransportFault(served)).toBeNull();
  });

  it('never reads the echoed command line as fault evidence', () => {
    // Node's execFile puts the full argument vector in the message, so a read
    // whose own GraphQL document mentions a fault would otherwise self-classify.
    const unrelated = Object.assign(
      new Error(
        'Command failed: gh api graphql -f query=query { search(query: "connection reset by peer") { nodes { id } } }\n',
      ),
      { stderr: '' },
    );
    expect(classifyTransportFault(unrelated)).toBeNull();
  });

  it('falls back to the message when stderr is empty and no command line was echoed', () => {
    expect(classifyTransportFault(new Error('net/http: TLS handshake timeout')))
      .toBe('TLS handshake failure');
  });

  it('prefers stderr over the message', () => {
    const fault = Object.assign(
      new Error('Command failed: gh api graphql -f query=query { pullRequest { id } }\nboom'),
      { stderr: 'dial tcp: lookup api.github.com: no such host' },
    );
    expect(classifyTransportFault(fault)).toBe('DNS failure');
  });
});

describe('isRetryableReadCommand', () => {
  it.each([
    ['a GraphQL query document', 'gh', PR_READ],
    ['an anonymous GraphQL query document', 'gh', ['api', 'graphql', '-f', 'query={ viewer { login } }']],
    ['a GraphQL query with variables and a jq filter', 'gh', ['api', 'graphql', '-F', 'owner=o', '-F', 'name=r', '-q', '.data', '-f', `query=${READ_QUERY}`]],
    ['a GraphQL read whose endpoint operand is not second', 'gh', ['api', '-q', '.data', 'graphql', '-f', 'query={ viewer { login } }']],
    ['a plain REST GET', 'gh', ['api', 'repos/o/r/pulls/1']],
    ['a conditional REST GET', 'gh', ['api', '--include', 'repos/o/r/pulls/1', '-H', 'If-None-Match: "e"']],
    ['an explicit REST GET', 'gh', ['api', '--method', 'GET', 'repos/o/r/pulls/1']],
    ['an explicit REST GET with an attached long value', 'gh', ['api', '--method=GET', 'repos/o/r/pulls/1']],
    ['a paginated REST GET', 'gh', ['api', '--paginate', '--slurp', 'repos/o/r/pulls/1/comments']],
    ['a pull-request view', 'gh', ['pr', 'view', '2150', '--repo', 'o/r', '--json', 'files']],
    ['an issue view', 'gh', ['issue', 'view', '19', '--repo', 'o/r', '--json', 'labels']],
    ['a remote ref listing', 'git', ['ls-remote', 'https://github.com/o/r.git', 'refs/heads/main']],
    ['a repository-scoped remote ref listing', 'git', ['-C', '/repo', 'ls-remote', 'origin', 'refs/jinn-autopilot/review-claim/*']],
  ])('admits %s', (_label, command, args) => {
    expect(isRetryableReadCommand(command, args)).toBe(true);
  });

  it.each([
    // --- separated-form mutations -----------------------------------------
    ['a merge PUT', 'gh', ['api', '-X', 'PUT', 'repos/o/r/pulls/2081/merge', '-f', 'merge_method=squash']],
    ['a review POST', 'gh', ['api', '--method', 'POST', 'repos/o/r/pulls/1928/reviews', '-f', 'event=APPROVE']],
    ['a comment PATCH', 'gh', ['api', '--method', 'PATCH', 'repos/o/r/issues/comments/7', '-f', 'body=x']],
    ['a DELETE', 'gh', ['api', '-X', 'DELETE', 'repos/o/r/git/refs/heads/x']],
    ['an attached long-form mutation', 'gh', ['api', '--method=POST', 'repos/o/r/pulls/1928/reviews']],
    ['an implicit POST carrying fields', 'gh', ['api', 'repos/o/r/issues/1/comments', '-f', 'body=x']],
    // --- pflag attached shorthand: the parser must refuse, never skip ------
    ['an attached-shorthand review POST', 'gh', ['api', '-XPOST', 'repos/o/r/pulls/1928/reviews', '-fevent=APPROVE']],
    ['an attached-shorthand DELETE', 'gh', ['api', '-XDELETE', 'repos/o/r/git/refs/heads/x']],
    ['a lowercase attached-shorthand merge PUT', 'gh', ['api', '-Xput', 'repos/o/r/pulls/2081/merge']],
    ['an attached-shorthand raw field', 'gh', ['api', 'repos/o/r/issues/1/comments', '-fbody=x']],
    ['an attached-shorthand typed field', 'gh', ['api', 'repos/o/r/issues/1/comments', '-Fbody=x']],
    ['a clustered shorthand', 'gh', ['api', '-iXPOST', 'repos/o/r/pulls/1928/reviews']],
    // --- GraphQL routing must not depend on operand position ---------------
    ['a GraphQL mutation', 'gh', ['api', 'graphql', '-f', 'query=mutation { addComment(input: {}) { clientMutationId } }']],
    ['a GraphQL mutation smuggled behind an explicit GET', 'gh', ['api', '-X', 'GET', 'graphql', '-f', 'query=mutation { addComment(input: {}) { clientMutationId } }']],
    ['a GraphQL mutation smuggled behind an explicit long GET', 'gh', ['api', '--method', 'GET', 'graphql', '-f', 'query=mutation { addComment(input: {}) { clientMutationId } }']],
    ['a GraphQL document with a trailing mutation', 'gh', ['api', 'graphql', '-f', 'query=query { viewer { login } }\nmutation Add { addComment { id } }']],
    ['a GraphQL document supplied twice', 'gh', ['api', 'graphql', '-f', 'query={ viewer { login } }', '-f', 'query={ rateLimit { cost } }']],
    ['a query document behind an explicit write verb', 'gh', ['api', '-X', 'POST', 'graphql', '-f', 'query={ viewer { login } }']],
    ['a GraphQL document with no query field at all', 'gh', ['api', 'graphql', '-F', 'owner=o']],
    ['an opaque GraphQL body', 'gh', ['api', 'graphql', '--input', '/tmp/request.json']],
    ['an opaque REST body', 'gh', ['api', '--method', 'GET', 'repos/o/r/pulls/1', '--input', '/tmp/body.json']],
    // --- malformed or unrecognised gh api grammar --------------------------
    ['an unknown flag', 'gh', ['api', '--follow-redirects', 'repos/o/r/pulls/1']],
    ['an option-value separator', 'gh', ['api', '--', 'repos/o/r/pulls/1']],
    ['a value flag missing its value', 'gh', ['api', 'repos/o/r/pulls/1', '-q']],
    ['two endpoint operands', 'gh', ['api', 'repos/o/r/pulls/1', 'repos/o/r/pulls/2']],
    ['no endpoint operand', 'gh', ['api', '--include']],
    ['a boolean flag given a value', 'gh', ['api', '--paginate=true', 'repos/o/r/pulls/1']],
    // --- porcelain mutations ------------------------------------------------
    ['a pull-request creation', 'gh', ['pr', 'create', '--repo', 'o/r', '--title', 't', '--body', 'b']],
    ['a pull-request merge', 'gh', ['pr', 'merge', '2081', '--repo', 'o/r', '--squash']],
    ['a pull-request review', 'gh', ['pr', 'review', '1928', '--repo', 'o/r', '--approve']],
    ['a pull-request comment', 'gh', ['pr', 'comment', '1928', '--repo', 'o/r', '--body', 'x']],
    ['a pull-request edit', 'gh', ['pr', 'edit', '1928', '--repo', 'o/r', '--add-label', 'x']],
    ['a branch update', 'gh', ['pr', 'update-branch', '2081', '--repo', 'o/r']],
    ['an issue edit', 'gh', ['issue', 'edit', '19', '--repo', 'o/r', '--add-label', 'x']],
    ['an issue close', 'gh', ['issue', 'close', '19', '--repo', 'o/r']],
    // --- git --------------------------------------------------------------
    ['a push', 'git', ['push', 'origin', 'HEAD:refs/heads/x']],
    ['a repository-scoped push', 'git', ['-C', '/repo', 'push', '--force-with-lease', 'origin', 'x']],
    ['a commit', 'git', ['commit', '-m', 'x']],
    ['a fetch that writes local refs', 'git', ['fetch', 'origin', 'main']],
    ['ls-remote naming an upload-pack program', 'git', ['ls-remote', '--upload-pack=/tmp/evil', 'origin', 'refs/heads/main']],
    ['ls-remote naming a short upload-pack program', 'git', ['ls-remote', '-u', '/tmp/evil', 'origin', 'refs/heads/main']],
    ['ls-remote behind a hooks-path override', 'git', ['-c', 'core.hooksPath=/tmp/evil', 'ls-remote', 'origin', 'refs/heads/main']],
    ['ls-remote behind a transport-helper override', 'git', ['-c', 'protocol.ext.allow=always', 'ls-remote', 'ext::sh -c evil', 'refs/heads/main']],
    ['ls-remote against a transport-helper remote', 'git', ['ls-remote', 'ext::sh -c evil', 'refs/heads/main']],
    ['ls-remote with an extra operand', 'git', ['ls-remote', 'origin', 'refs/heads/main', 'refs/heads/other']],
    ['ls-remote with a missing operand', 'git', ['ls-remote', 'origin']],
    ['a -C option missing its path', 'git', ['-C', 'ls-remote', 'origin']],
    // --- unrecognised -------------------------------------------------------
    ['an unrecognised gh command', 'gh', ['workflow', 'run', 'ci.yml']],
    ['an unrecognised binary', 'kubectl', ['get', 'pods']],
  ])('refuses %s', (_label, command, args) => {
    expect(isRetryableReadCommand(command, args)).toBe(false);
  });
});

describe('withTransientReadRetry', () => {
  it('retries an allowlisted read through a transport fault and returns the eventual success', async () => {
    const inner = countingRunner([
      async () => {
        throw subprocessFault('Post "https://api.github.com/graphql": net/http: TLS handshake timeout');
      },
      async () => '{"data":{"repository":{"pullRequest":{"id":"PR_2150"}}}}',
    ]);
    const attempts: number[] = [];
    const run = withTransientReadRetry(inner.run, {
      sleep: noSleep,
      onRetry: (event) => attempts.push(event.attempt),
    });

    await expect(run('gh', PR_READ)).resolves.toContain('PR_2150');
    expect(inner.calls()).toBe(2);
    expect(attempts).toEqual([1]);
  });

  it('surfaces the original error, not a synthetic one, after exactly three attempts', async () => {
    const fault = subprocessFault('read tcp 10.0.0.2:1->140.82.121.6:443: read: connection reset by peer');
    const inner = countingRunner([async () => {
      throw fault;
    }]);
    const run = withTransientReadRetry(inner.run, { sleep: noSleep });

    await expect(run('gh', PR_READ)).rejects.toBe(fault);
    expect(inner.calls()).toBe(3);
  });

  it.each([
    ['a merge PUT', 'gh', ['api', '-X', 'PUT', 'repos/o/r/pulls/2081/merge', '-f', 'merge_method=squash']],
    ['an attached-shorthand merge PUT', 'gh', ['api', '-XPUT', 'repos/o/r/pulls/2081/merge']],
    ['a pull-request creation', 'gh', ['pr', 'create', '--repo', 'o/r', '--title', 't', '--body', 'b']],
    ['a review submission', 'gh', ['api', '--method', 'POST', 'repos/o/r/pulls/1928/reviews', '-f', 'event=APPROVE']],
    ['an attached-shorthand review submission', 'gh', ['api', '-XPOST', 'repos/o/r/pulls/1928/reviews', '-fevent=APPROVE']],
    ['a review submission via the porcelain', 'gh', ['pr', 'review', '1928', '--repo', 'o/r', '--approve']],
    ['a GraphQL mutation', 'gh', ['api', 'graphql', '-f', 'query=mutation { addComment(input: {}) { clientMutationId } }']],
    ['a GraphQL mutation smuggled behind an explicit GET', 'gh', ['api', '-X', 'GET', 'graphql', '-f', 'query=mutation { addComment(input: {}) { clientMutationId } }']],
    ['an implicit comment POST', 'gh', ['api', 'repos/o/r/issues/1/comments', '-fbody=x']],
    ['a push', 'git', ['push', 'origin', 'HEAD:refs/heads/x']],
  ])('never retries %s, even on a transport fault', async (_label, command, args) => {
    const fault = subprocessFault('Post "https://api.github.com": net/http: TLS handshake timeout');
    const inner = countingRunner([async () => {
      throw fault;
    }]);
    const retried: unknown[] = [];
    const run = withTransientReadRetry(inner.run, {
      sleep: noSleep,
      onRetry: (event) => retried.push(event),
    });

    await expect(run(command, args)).rejects.toBe(fault);
    expect(inner.calls()).toBe(1);
    expect(retried).toEqual([]);
  });

  it('does not retry a failure the server actually returned', async () => {
    const fault = subprocessFault('gh: Internal Server Error (HTTP 500)');
    const inner = countingRunner([async () => {
      throw fault;
    }]);
    const run = withTransientReadRetry(inner.run, { sleep: noSleep });

    await expect(run('gh', PR_READ)).rejects.toBe(fault);
    expect(inner.calls()).toBe(1);
  });

  it('does not retry an unrecognised command', async () => {
    const fault = subprocessFault('dial tcp: lookup api.github.com: no such host');
    const inner = countingRunner([async () => {
      throw fault;
    }]);
    const run = withTransientReadRetry(inner.run, { sleep: noSleep });

    await expect(run('gh', ['workflow', 'run', 'ci.yml'])).rejects.toBe(fault);
    expect(inner.calls()).toBe(1);
  });

  it('waits the pinned backoff between attempts', async () => {
    const waits: number[] = [];
    const inner = countingRunner([async () => {
      throw subprocessFault('dial tcp 140.82.121.6:443: i/o timeout');
    }]);
    const run = withTransientReadRetry(inner.run, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    await expect(run('gh', PR_READ)).rejects.toThrow(/i\/o timeout/);
    expect(waits).toEqual([250, 1_000]);
  });

  it('does not multiply attempts when a runner is wrapped twice', async () => {
    const inner = countingRunner([async () => {
      throw subprocessFault('net/http: TLS handshake timeout');
    }]);
    const once = withTransientReadRetry(inner.run, { sleep: noSleep });
    const twice = withTransientReadRetry(once, { sleep: noSleep });

    expect(twice).toBe(once);
    await expect(twice('gh', PR_READ)).rejects.toThrow();
    expect(inner.calls()).toBe(3);
  });

  it('passes the command but never the arguments to a retry observer', async () => {
    const inner = countingRunner([
      async () => {
        throw subprocessFault('net/http: TLS handshake timeout');
      },
      async () => 'ok',
    ]);
    const events: Array<Record<string, unknown>> = [];
    const run = withTransientReadRetry(inner.run, {
      sleep: noSleep,
      onRetry: (event) => events.push({ ...event }),
    });

    await run('gh', ['api', 'repos/o/r/pulls/1?token=secret']);
    expect(events).toEqual([{ command: 'gh', attempt: 1, fault: 'TLS handshake failure' }]);
  });
});

describe('retry accounting through the GitHub usage boundary', () => {
  it('counts one REST request for a retried read and surfaces the retry in cycle usage', async () => {
    const meter = new GitHubUsageMeter();
    let calls = 0;
    const run = makeGitHubUsageCommandRunner(async () => {
      calls += 1;
      if (calls === 1) throw subprocessFault('read tcp: read: connection reset by peer');
      return '{"number":2144}';
    }, meter);

    await expect(run('gh', ['api', 'repos/o/r/pulls/2144'])).resolves.toContain('2144');
    expect(calls).toBe(2);
    expect(meter.read()).toMatchObject({
      restRequests: 1,
      transientRetries: 1,
      accountingComplete: false,
      incompleteReason: expect.stringMatching(/retried through a transport fault/i),
    });
  });

  it('omits the retry counter entirely from a cycle that never retried', async () => {
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(async () => '{"number":2144}', meter);

    await run('gh', ['api', 'repos/o/r/pulls/2144']);
    expect(meter.read()).not.toHaveProperty('transientRetries');
    expect(meter.read()).toMatchObject({ accountingComplete: true });
  });

  it('reports a later genuine skew reason alongside the retry rather than masking it', async () => {
    const meter = new GitHubUsageMeter();
    meter.recordTransientReadRetry('gh', 'connection reset');
    meter.markIncomplete('eventually-consistent rate-limit counter skew');

    const usage = meter.read();
    expect(usage.accountingComplete).toBe(false);
    expect(usage.incompleteReason).toMatch(/rate-limit counter skew/);
    expect(usage.incompleteReason).toMatch(/retried through a transport fault/);
  });

  it('clears the retry counter and its reason when the cycle meter is reset', async () => {
    const meter = new GitHubUsageMeter();
    meter.recordTransientReadRetry('gh', 'TLS handshake failure');

    expect(meter.read()).toMatchObject({ transientRetries: 1, accountingComplete: false });
    meter.reset();
    expect(meter.read()).not.toHaveProperty('transientRetries');
    expect(meter.read()).toMatchObject({ accountingComplete: true });
    expect(meter.read()).not.toHaveProperty('incompleteReason');
  });

  it('never retries a merge PUT that crosses the usage boundary', async () => {
    const meter = new GitHubUsageMeter();
    let calls = 0;
    const fault = subprocessFault('net/http: TLS handshake timeout');
    const run = makeGitHubUsageCommandRunner(async () => {
      calls += 1;
      throw fault;
    }, meter);

    await expect(run('gh', ['api', '-X', 'PUT', 'repos/o/r/pulls/2081/merge'])).rejects.toBe(fault);
    expect(calls).toBe(1);
    expect(meter.read()).not.toHaveProperty('transientRetries');
  });

  it('never retries an attached-shorthand review POST that crosses the usage boundary', async () => {
    const meter = new GitHubUsageMeter();
    let calls = 0;
    const fault = subprocessFault('net/http: TLS handshake timeout');
    const run = makeGitHubUsageCommandRunner(async () => {
      calls += 1;
      throw fault;
    }, meter);

    await expect(run('gh', ['api', '-XPOST', 'repos/o/r/pulls/1928/reviews', '-fevent=APPROVE']))
      .rejects.toBe(fault);
    expect(calls).toBe(1);
    expect(meter.read()).not.toHaveProperty('transientRetries');
  });

  it("retries the meter's own quota probe, which the allowlist must keep admitting", async () => {
    // The meter brackets every opaque `gh` command with its own GraphQL probe.
    // A stricter allowlist that refused that probe would leave the meter unable
    // to survive a blip on the very command it exists to account for, so the
    // probe's exact shape is exercised through the real boundary, not asserted
    // against a copy of its document.
    const meter = new GitHubUsageMeter();
    let probes = 0;
    let probeFaults = 0;
    const run = makeGitHubUsageCommandRunner(async (_command, args) => {
      if (args[0] !== 'api' || args[1] !== 'graphql') return 'edited';
      probes += 1;
      if (probes === 1) {
        probeFaults += 1;
        throw subprocessFault('net/http: TLS handshake timeout', 'gh api graphql');
      }
      return JSON.stringify({
        data: {
          rateLimit: {
            cost: 1,
            remaining: probes === 2 ? 998 : 990,
            resetAt: '2026-07-22T13:00:00.000Z',
            used: probes === 2 ? 2 : 10,
            limit: 1_000,
          },
        },
      });
    }, meter);

    await expect(run('gh', ['pr', 'edit', '1', '--repo', 'o/r', '--add-label', 'x']))
      .resolves.toBe('edited');
    expect(probeFaults).toBe(1);
    expect(meter.read()).toMatchObject({ transientRetries: 1 });
  });
});
