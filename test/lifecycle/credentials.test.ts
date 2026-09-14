// @ts-nocheck — Stage 5: deleted merge-prep/review-fix/project-status fixtures.
import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import {
  buildSanitizedChildEnv,
  gitPublicationArgs,
  resolveCredentialPool,
  selectCredential,
} from '../../src/lifecycle/credentials.js';
import { isRetryableReadCommand } from '../../src/lifecycle/transient-retry.js';

function loginRunner(byToken: Readonly<Record<string, string>>): CommandRunner {
  return vi.fn(async (cmd, args, opts) => {
    expect(cmd).toBe('gh');
    expect(args).toEqual(['api', 'user', '--jq', '.login']);
    const env = opts?.env ?? {};
    const token = env.GH_TOKEN ?? '';
    expect(Object.entries(env).filter(([key, value]) =>
      /(?:token|pat)/i.test(key) && value !== '',
    )).toEqual([['GH_TOKEN', token]]);
    return `${byToken[token] ?? ''}\n`;
  });
}

describe('credential pool', () => {
  it('resolves and deduplicates one token configured for both preferences', async () => {
    const runner = loginRunner({ shared: 'Jinn-Bot' });
    const pool = await resolveCredentialPool({
      JINN_IMPL_GH_TOKEN: 'shared',
      JINN_REVIEW_GH_TOKEN: 'shared',
      JINN_REVIEW_BOT_LOGIN: 'jinn-bot',
    }, runner);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(pool.logins()).toEqual(['Jinn-Bot']);
    expect(selectCredential(pool, { phase: 'implement' })).toMatchObject({
      status: 'selected',
      login: 'Jinn-Bot',
      preference: 'implementation',
    });
    expect(selectCredential(pool, {
      phase: 'review',
      prAuthor: 'someone-else',
    })).toMatchObject({
      status: 'selected',
      login: 'Jinn-Bot',
      preference: 'review',
    });
  });

  it('uses env names as phase preferences and rejects self-review case-insensitively', async () => {
    const pool = await resolveCredentialPool({
      JINN_IMPL_GH_TOKEN: 'impl-secret',
      JINN_REVIEW_GH_TOKEN: 'review-secret',
    }, loginRunner({
      'impl-secret': 'Impl-Bot',
      'review-secret': 'Review-Bot',
    }));

    const implementation = selectCredential(pool, { phase: 'merge-prep' });
    expect(implementation).toMatchObject({
      status: 'selected',
      login: 'Impl-Bot',
      preference: 'implementation',
    });
    const review = selectCredential(pool, {
      phase: 'review',
      prAuthor: 'REVIEW-bot',
    });
    expect(review).toMatchObject({
      status: 'selected',
      login: 'Impl-Bot',
      preference: 'implementation',
    });
    expect(review.status === 'selected' && review.credential.secret()).toBe('impl-secret');
  });

  it('preserves the previous reviewer for recovery and fails explicitly when changing is unsafe', async () => {
    const pool = await resolveCredentialPool({
      JINN_IMPL_GH_TOKEN: 'i',
      JINN_REVIEW_GH_TOKEN: 'r',
    }, loginRunner({ i: 'impl', r: 'review' }));

    expect(selectCredential(pool, {
      phase: 'review',
      prAuthor: 'author',
      previousReviewerLogin: 'impl',
    })).toMatchObject({
      status: 'selected',
      login: 'impl',
      recoveredPreviousReviewer: true,
    });

    const unavailable = selectCredential(pool, {
      phase: 'review',
      prAuthor: 'author',
      previousReviewerLogin: 'missing-reviewer',
      nativeRequestedChanges: true,
    });
    expect(unavailable).toEqual({
      status: 'identity-unavailable',
      code: 'identity-unavailable',
      detail: 'Previous reviewer missing-reviewer is unavailable; native requested changes make switching reviewer unsafe.',
    });

    expect(selectCredential(pool, {
      phase: 'review',
      prAuthor: 'author',
      nativeRequestedChanges: true,
    })).toEqual({
      status: 'identity-unavailable',
      code: 'identity-unavailable',
      detail: 'Previous reviewer identity is unavailable; native requested changes make reviewer recovery unsafe.',
    });
  });

  it('fails a mismatched optional review-login assertion without exposing secrets', async () => {
    const secret = 'review-super-secret';
    await expect(resolveCredentialPool({
      JINN_REVIEW_GH_TOKEN: secret,
      JINN_REVIEW_BOT_LOGIN: 'expected-reviewer',
    }, loginRunner({ [secret]: 'actual-reviewer' }))).rejects.toThrow(
      'review credential resolves to actual-reviewer, not asserted login expected-reviewer',
    );

    try {
      await resolveCredentialPool({
        JINN_REVIEW_GH_TOKEN: secret,
        JINN_REVIEW_BOT_LOGIN: 'expected-reviewer',
      }, loginRunner({ [secret]: 'actual-reviewer' }));
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('keeps credential secrets out of JSON diagnostics', async () => {
    const pool = await resolveCredentialPool({
      JINN_IMPL_GH_TOKEN: 'never-serialize-me',
    }, loginRunner({ 'never-serialize-me': 'impl' }));
    const selected = selectCredential(pool, { phase: 'merge' });

    expect(JSON.stringify(pool)).not.toContain('never-serialize-me');
    expect(JSON.stringify(selected)).not.toContain('never-serialize-me');
  });

  it('restricts action selection to locally free identity lanes', async () => {
    const pool = await resolveCredentialPool({
      JINN_IMPL_GH_TOKEN: 'i',
      JINN_REVIEW_GH_TOKEN: 'r',
    }, loginRunner({ i: 'impl', r: 'review' }));

    const free = pool.restrictedTo(['review']);
    expect(free.logins()).toEqual(['review']);
    expect(selectCredential(free, { phase: 'implement' })).toMatchObject({
      status: 'selected',
      login: 'review',
    });
  });

  it('redacts credential-resolution failures that contain a secret', async () => {
    const secret = 'resolution-secret';
    const runner: CommandRunner = async () => {
      throw new Error(`gh rejected ${secret}`);
    };
    try {
      await resolveCredentialPool({ JINN_IMPL_GH_TOKEN: secret }, runner);
      throw new Error('expected credential resolution to fail');
    } catch (error) {
      expect(String(error)).toContain('implementation credential');
      expect(String(error)).not.toContain(secret);
    }
  });
});

/**
 * #186: a GitHub 502 blip made the unretried `gh api user` fail eight cycles
 * in a row, with the underlying error swallowed behind `login resolution
 * failed`. The probe is a REST GET the engine's own read allowlist admits, so
 * it goes through the same bounded ladder as every other GitHub read, plus the
 * served gateway statuses a proxy answers with when GitHub gave up — nothing a
 * re-sent GET can duplicate — and the failure it finally throws quotes the
 * stderr it saw.
 */
describe('credential probe retry (#186)', () => {
  const noSleep = async (): Promise<void> => {};

  function subprocessFault(stderr: string): Error & { stderr: string } {
    return Object.assign(
      new Error(`Command failed: gh api user --jq .login\n${stderr}`),
      { stderr, code: 1 },
    );
  }

  function flakyRunner(
    failures: readonly Error[],
    login = 'Jinn-Bot',
  ): { runner: CommandRunner; calls: () => number } {
    let calls = 0;
    const runner: CommandRunner = async (cmd, args) => {
      expect([cmd, ...args]).toEqual(['gh', 'api', 'user', '--jq', '.login']);
      const failure = failures[calls];
      calls += 1;
      if (failure !== undefined) throw failure;
      return `${login}\n`;
    };
    return { runner, calls: () => calls };
  }

  it('is a read the engine can prove idempotent', () => {
    expect(isRetryableReadCommand('gh', ['api', 'user', '--jq', '.login'])).toBe(true);
  });

  it('resolves the credential when a 502 is served twice and then the login', async () => {
    const gateway = subprocessFault('gh: Bad Gateway (HTTP 502)');
    const { runner, calls } = flakyRunner([gateway, gateway]);
    const retries: Array<{ attempt: number; fault: string }> = [];

    const pool = await resolveCredentialPool(
      { JINN_IMPL_GH_TOKEN: 'impl' },
      runner,
      { sleep: noSleep, onRetry: (event) => retries.push(event) },
    );

    expect(pool.logins()).toEqual(['Jinn-Bot']);
    expect(calls()).toBe(3);
    expect(retries).toEqual([
      { preference: 'implementation', attempt: 1, fault: 'HTTP 502' },
      { preference: 'implementation', attempt: 2, fault: 'HTTP 502' },
    ]);
  });

  it('retries a transport fault through the same ladder', async () => {
    const { runner, calls } = flakyRunner([
      subprocessFault('Post "https://api.github.com/user": net/http: TLS handshake timeout'),
    ]);

    await resolveCredentialPool({ JINN_REVIEW_GH_TOKEN: 'rev' }, runner, { sleep: noSleep });

    expect(calls()).toBe(2);
  });

  it('throws after three 502s, quoting the stderr it saw', async () => {
    const gateway = subprocessFault('gh: Bad Gateway (HTTP 502)');
    const { runner, calls } = flakyRunner([gateway, gateway, gateway]);

    await expect(resolveCredentialPool(
      { JINN_IMPL_GH_TOKEN: 'impl' },
      runner,
      { sleep: noSleep },
    )).rejects.toThrow(
      'implementation credential GitHub login resolution failed: gh: Bad Gateway (HTTP 502)',
    );
    expect(calls()).toBe(3);
  });

  it('never retries a failure that is not transport or gateway shaped', async () => {
    const { runner, calls } = flakyRunner([
      subprocessFault('gh: Bad credentials (HTTP 401)'),
    ]);

    await expect(resolveCredentialPool(
      { JINN_REVIEW_GH_TOKEN: 'rev' },
      runner,
      { sleep: noSleep },
    )).rejects.toThrow(
      'review credential GitHub login resolution failed: gh: Bad credentials (HTTP 401)',
    );
    expect(calls()).toBe(1);
  });

  it('waits the pinned backoff between attempts', async () => {
    const gateway = subprocessFault('gh: Service Unavailable (HTTP 503)');
    const { runner } = flakyRunner([gateway, gateway]);
    const waits: number[] = [];

    await resolveCredentialPool({ JINN_IMPL_GH_TOKEN: 'impl' }, runner, {
      sleep: async (ms) => { waits.push(ms); },
    });

    expect(waits).toEqual([250, 1_000]);
  });

  it('redacts a secret the quoted stderr happens to echo', async () => {
    const secret = 'echoed-secret';
    const { runner } = flakyRunner([subprocessFault(`gh: token ${secret} rejected (HTTP 401)`)]);

    try {
      await resolveCredentialPool({ JINN_IMPL_GH_TOKEN: secret }, runner, { sleep: noSleep });
      throw new Error('expected credential resolution to fail');
    } catch (error) {
      expect(String(error)).toContain('HTTP 401');
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe('sanitized child authentication', () => {
  it('passes exactly one token, isolated gh config, askpass, and required runtime variables', async () => {
    const pool = await resolveCredentialPool({
      JINN_IMPL_GH_TOKEN: 'selected-secret',
    }, loginRunner({ 'selected-secret': 'impl' }));
    const selected = selectCredential(pool, { phase: 'implement' });
    if (selected.status !== 'selected') throw new Error('test fixture did not select');

    const env = buildSanitizedChildEnv({
      PATH: '/bin',
      HOME: '/home/runner',
      HERMES_HOME: '/hermes',
      JINN_DISPATCHER_HERMES_MODEL: 'model',
      GH_TOKEN: 'ambient-gh',
      GITHUB_TOKEN: 'ambient-github',
      JINN_IMPL_GH_TOKEN: 'ambient-impl',
      JINN_REVIEW_GH_TOKEN: 'ambient-review',
      GH_ENTERPRISE_TOKEN: 'ambient-enterprise',
      GITHUB_PAT: 'ambient-pat',
      MY_GITHUB_API_TOKEN: 'ambient-equivalent',
      GIT_CONFIG_GLOBAL: '/home/runner/.gitconfig',
      GIT_CONFIG_SYSTEM: '/etc/gitconfig',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: 'ambient-helper',
      SSH_AUTH_SOCK: '/ambient/agent.sock',
      SSH_AGENT_PID: '999',
      GIT_SSH: '/ambient/git-ssh',
      GIT_SSH_COMMAND: 'ambient-ssh-command',
    }, selected.credential, {
      ghConfigDir: '/attempt/gh-config',
      askpassPath: '/attempt/askpass',
      manifestPath: '/attempt/manifest.json',
    });

    expect(env).toMatchObject({
      PATH: '/bin',
      HOME: '/home/runner',
      HERMES_HOME: '/hermes',
      JINN_DISPATCHER_HERMES_MODEL: 'model',
      GH_TOKEN: 'selected-secret',
      GH_CONFIG_DIR: '/attempt/gh-config',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/attempt/askpass',
      SSH_ASKPASS: '/attempt/askpass',
      JINN_AUTOPILOT_SESSION_MANIFEST: '/attempt/manifest.json',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'core.askPass',
      GIT_CONFIG_VALUE_1: '/attempt/askpass',
      GIT_SSH_COMMAND: 'false',
    });
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.SSH_AGENT_PID).toBeUndefined();
    expect(env.GIT_SSH).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.JINN_IMPL_GH_TOKEN).toBeUndefined();
    expect(env.JINN_REVIEW_GH_TOKEN).toBeUndefined();
    expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(env.GITHUB_PAT).toBeUndefined();
    expect(env.MY_GITHUB_API_TOKEN).toBeUndefined();
    expect(Object.entries(env).filter(([key]) =>
      key !== 'GH_TOKEN' && /(?:^|_)(?:GH|GITHUB).*?(?:TOKEN|PAT)(?:_|$)/i.test(key),
    )).toEqual([]);
  });

  it('pins git publication to the attempt askpass and disables credential helpers', () => {
    // credential.interactive=never is deliberately absent: git counts the
    // askpass helper as interactive prompting, so that flag turns every
    // HTTPS auth into "unable to get password from user" (found live by the
    // capability probe).
    expect(gitPublicationArgs('/attempt/askpass', ['push', 'origin', 'HEAD:refs/heads/topic']))
      .toEqual([
        '-c', 'credential.helper=',
        '-c', 'core.askPass=/attempt/askpass',
        'push', 'origin', 'HEAD:refs/heads/topic',
      ]);
  });
});
