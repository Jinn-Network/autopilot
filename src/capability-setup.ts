import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { LoadedAutopilotConfig } from './config/config.js';
import type { CommandRunner } from './dispatcher/issue-source.js';
import {
  runCapabilityProbe,
  writeCapabilityAttestation,
  type CapabilityProbeGitRunner,
} from './lifecycle/capability-probe.js';
import {
  gitPublicationArgs,
  SelectedCredential,
} from './lifecycle/credentials.js';
import { withSelectedCredential } from './lifecycle/production-auth.js';

interface CredentialProfile {
  readonly implementation?: {
    readonly login?: unknown;
    readonly token?: unknown;
  } | null;
}

function storedCredential(loaded: LoadedAutopilotConfig): {
  readonly login?: string;
  readonly token?: string;
} {
  if (!existsSync(loaded.paths.credentials)) return {};
  const profile = JSON.parse(
    readFileSync(loaded.paths.credentials, 'utf8'),
  ) as CredentialProfile;
  return {
    ...(typeof profile.implementation?.login === 'string'
      ? { login: profile.implementation.login }
      : {}),
    ...(typeof profile.implementation?.token === 'string'
      ? { token: profile.implementation.token }
      : {}),
  };
}

export async function ensureCapabilityAttestation(input: {
  readonly loaded: LoadedAutopilotConfig;
  readonly environment: NodeJS.ProcessEnv;
  readonly runner: CommandRunner;
}): Promise<void> {
  const stored = storedCredential(input.loaded);
  const token = input.environment.AUTOPILOT_GITHUB_IMPLEMENT_TOKEN
    ?? stored.token;
  if (token == null || token === '') {
    throw new Error(
      'An implementation GitHub token is required for the live Git ref capability probe',
    );
  }
  const resolvedLogin = (await input.runner('gh', [
    'api',
    'user',
    '--jq',
    '.login',
  ], {
    env: { GH_TOKEN: token },
  })).trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(resolvedLogin)) {
    throw new Error('Implementation GitHub token resolved to an invalid login');
  }
  if (
    stored.login != null
    && stored.login.toLowerCase() !== resolvedLogin.toLowerCase()
  ) {
    throw new Error('Stored implementation identity no longer matches its token');
  }

  const credential = new SelectedCredential(
    resolvedLogin,
    'implementation',
    token,
  );
  const attestation = await withSelectedCredential(
    credential,
    input.environment,
    async ({ askpass, run }) => {
      const runGit: CapabilityProbeGitRunner = (_command, args) => run('git', [
        ...gitPublicationArgs(askpass, []),
        ...args,
      ]);
      return runCapabilityProbe({
        repositoryPath: input.loaded.repositoryRoot,
        repositoryUrl: input.loaded.config.repository.remote.url,
        remoteName: input.loaded.config.repository.remote.name,
        implementerLogin: resolvedLogin,
        runGit,
      });
    },
    input.runner,
  );

  mkdirSync(dirname(input.loaded.paths.capabilityAttestation), {
    recursive: true,
    mode: 0o700,
  });
  const staging = `${input.loaded.paths.capabilityAttestation}.next-${process.pid}`;
  try {
    writeCapabilityAttestation(staging, attestation);
    renameSync(staging, input.loaded.paths.capabilityAttestation);
  } finally {
    rmSync(staging, { force: true });
  }
}
