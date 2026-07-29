import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { argv, env } from 'node:process';
import { runIssueRelayProductionFromEnvironment } from '../src/issue-relay/index.js';

export interface IssueRelayArguments {
  readonly mode: 'observe' | 'recover' | 'active';
  readonly once: boolean;
}

const USAGE =
  'Usage: tsx scripts/run-jinn-issue-relay.ts '
  + '--mode <observe|recover|active> [--once]';

export function parseIssueRelayArguments(
  input: readonly string[],
): IssueRelayArguments {
  let mode: IssueRelayArguments['mode'] | undefined;
  let once = false;
  for (let index = 0; index < input.length; index += 1) {
    const argument = input[index];
    if (argument === '--mode' && mode === undefined) {
      const value = input[index + 1];
      if (value !== 'observe' && value !== 'recover' && value !== 'active') {
        throw new Error(USAGE);
      }
      mode = value;
      index += 1;
      continue;
    }
    if (argument === '--once' && !once) {
      once = true;
      continue;
    }
    throw new Error(`Unsupported Issue Relay argument. ${USAGE}`);
  }
  if (mode === undefined) throw new Error(USAGE);
  return { mode, once };
}

export function isDirectIssueRelayEntrypoint(
  entrypoint: string | undefined,
  moduleUrl: string,
): boolean {
  return entrypoint !== undefined
    && pathToFileURL(resolve(entrypoint)).href === moduleUrl;
}

export async function main(
  input: readonly string[] = argv.slice(2),
  environment: NodeJS.ProcessEnv = env,
  run: (options: {
    readonly mode: IssueRelayArguments['mode'];
    readonly once: boolean;
    readonly environment: NodeJS.ProcessEnv;
  }) => Promise<void> = runIssueRelayProductionFromEnvironment,
): Promise<void> {
  const parsed = parseIssueRelayArguments(input);
  await run({ ...parsed, environment });
}

if (isDirectIssueRelayEntrypoint(argv[1], import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Jinn Issue Relay failed: ${message}\n`);
    process.exitCode = 1;
  });
}
