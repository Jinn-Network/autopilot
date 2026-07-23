export type AutopilotCommand =
  | {
      readonly kind: 'init';
      readonly nonInteractive: boolean;
      readonly project?: string;
    }
  | { readonly kind: 'doctor'; readonly json: boolean }
  | { readonly kind: 'start'; readonly foreground: boolean }
  | { readonly kind: 'stop'; readonly force: boolean }
  | { readonly kind: 'status'; readonly json: boolean }
  | {
      readonly kind: 'explain';
      readonly subject: 'issue' | 'pr';
      readonly number: number;
      readonly json: boolean;
    }
  | {
      readonly kind: 'logs';
      readonly attempt?: string;
      readonly follow: boolean;
    }
  | {
      readonly kind: 'observe';
      readonly once: boolean;
      readonly json: boolean;
      readonly fullReconcile: boolean;
    }
  | { readonly kind: 'recover'; readonly once: boolean; readonly json: boolean }
  | {
      readonly kind: 'skills-update';
      readonly apply: boolean;
      readonly force: boolean;
    }
  | { readonly kind: 'upgrade'; readonly version?: string }
  | { readonly kind: 'triage'; readonly json: boolean }
  | {
      readonly kind: 'issue-create';
      readonly input: string;
      readonly apply: boolean;
    }
  | {
      readonly kind: 'issue-triage';
      readonly number: number;
      readonly input: string;
      readonly apply: boolean;
    }
  | { readonly kind: 'session'; readonly arguments: readonly string[] }
  | { readonly kind: 'internal'; readonly arguments: readonly string[] }
  | { readonly kind: 'help' }
  | { readonly kind: 'version' };

export const AUTOPILOT_USAGE = `usage:
  autopilot init [--non-interactive] [--project <owner/number>]
  autopilot doctor [--json]
  autopilot start [--foreground]
  autopilot stop [--force]
  autopilot status [--json]
  autopilot explain issue|pr <N> [--json]
  autopilot logs [attempt] [--follow]
  autopilot observe [--once] [--json] [--full-reconcile]
  autopilot recover [--once] [--json]
  autopilot skills update [--apply] [--force]
  autopilot upgrade [--version <version>]
  autopilot triage --json
  autopilot issue create --input <json-file> [--apply]
  autopilot issue triage <N> --input <json-file> [--apply]`;

function positiveInteger(raw: string | undefined, name: string): number {
  if (raw == null || !/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe positive integer`);
  }
  return value;
}

function rejectSecretArguments(args: readonly string[]): void {
  const secret = args.find((arg) => (
    /^--(?:implement-|review-)?token(?:=|$)/i.test(arg)
    || /^--github-(?:implement-|review-)?token(?:=|$)/i.test(arg)
  ));
  if (secret !== undefined) {
    throw new Error(
      `Token values are never accepted on the command line (${secret}); `
      + 'use hidden input, AUTOPILOT_GITHUB_*_TOKEN, or the owner-only profile',
    );
  }
}

function flags(
  args: readonly string[],
  booleanFlags: readonly string[],
  valueFlags: readonly string[] = [],
): { booleans: ReadonlySet<string>; values: ReadonlyMap<string, string>; positionals: string[] } {
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (booleanFlags.includes(arg)) {
      if (booleans.has(arg)) throw new Error(`Duplicate option: ${arg}`);
      booleans.add(arg);
    } else if (valueFlags.includes(arg)) {
      if (values.has(arg)) throw new Error(`Duplicate option: ${arg}`);
      const value = args[index + 1];
      if (value == null || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      values.set(arg, value);
      index += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  return { booleans, values, positionals };
}

export function parseAutopilotArguments(args: readonly string[]): AutopilotCommand {
  rejectSecretArguments(args);
  const [command, ...tail] = args;
  if (command == null || command === 'help' || command === '--help' || command === '-h') {
    return { kind: 'help' };
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    if (tail.length > 0) throw new Error(`Version takes no arguments; ${AUTOPILOT_USAGE}`);
    return { kind: 'version' };
  }
  if (command === 'session') return { kind: 'session', arguments: tail };
  if (command === 'internal') return { kind: 'internal', arguments: tail };

  if (command === 'init') {
    const parsed = flags(tail, ['--non-interactive'], ['--project']);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected init input; ${AUTOPILOT_USAGE}`);
    return {
      kind: 'init',
      nonInteractive: parsed.booleans.has('--non-interactive'),
      ...(parsed.values.has('--project')
        ? { project: parsed.values.get('--project') }
        : {}),
    };
  }
  if (command === 'doctor' || command === 'status') {
    const parsed = flags(tail, ['--json']);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected ${command} input; ${AUTOPILOT_USAGE}`);
    return { kind: command, json: parsed.booleans.has('--json') };
  }
  if (command === 'start') {
    const parsed = flags(tail, ['--foreground']);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected start input; ${AUTOPILOT_USAGE}`);
    return { kind: 'start', foreground: parsed.booleans.has('--foreground') };
  }
  if (command === 'stop') {
    const parsed = flags(tail, ['--force']);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected stop input; ${AUTOPILOT_USAGE}`);
    return { kind: 'stop', force: parsed.booleans.has('--force') };
  }
  if (command === 'explain') {
    const parsed = flags(tail, ['--json']);
    const [subject, rawNumber, ...rest] = parsed.positionals;
    if ((subject !== 'issue' && subject !== 'pr') || rest.length > 0) {
      throw new Error(`Expected explain issue|pr <N>; ${AUTOPILOT_USAGE}`);
    }
    return {
      kind: 'explain',
      subject,
      number: positiveInteger(rawNumber, `${subject} number`),
      json: parsed.booleans.has('--json'),
    };
  }
  if (command === 'logs') {
    const parsed = flags(tail, ['--follow']);
    if (parsed.positionals.length > 1) throw new Error(`Unexpected logs input; ${AUTOPILOT_USAGE}`);
    return {
      kind: 'logs',
      ...(parsed.positionals[0] === undefined
        ? {}
        : { attempt: parsed.positionals[0] }),
      follow: parsed.booleans.has('--follow'),
    };
  }
  if (command === 'observe') {
    const parsed = flags(tail, ['--once', '--json', '--full-reconcile']);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected observe input; ${AUTOPILOT_USAGE}`);
    return {
      kind: 'observe',
      once: parsed.booleans.has('--once') || parsed.booleans.has('--full-reconcile'),
      json: parsed.booleans.has('--json'),
      fullReconcile: parsed.booleans.has('--full-reconcile'),
    };
  }
  if (command === 'recover') {
    const parsed = flags(tail, ['--once', '--json']);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected recover input; ${AUTOPILOT_USAGE}`);
    return {
      kind: 'recover',
      once: parsed.booleans.has('--once'),
      json: parsed.booleans.has('--json'),
    };
  }
  if (command === 'skills') {
    const [subcommand, ...rest] = tail;
    if (subcommand !== 'update') throw new Error(`Expected skills update; ${AUTOPILOT_USAGE}`);
    const parsed = flags(rest, ['--apply', '--force']);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected skills update input; ${AUTOPILOT_USAGE}`);
    return {
      kind: 'skills-update',
      apply: parsed.booleans.has('--apply'),
      force: parsed.booleans.has('--force'),
    };
  }
  if (command === 'upgrade') {
    const parsed = flags(tail, [], ['--version']);
    if (parsed.positionals.length > 0) throw new Error(`Unexpected upgrade input; ${AUTOPILOT_USAGE}`);
    return {
      kind: 'upgrade',
      ...(parsed.values.has('--version')
        ? { version: parsed.values.get('--version') }
        : {}),
    };
  }
  if (command === 'triage') {
    const parsed = flags(tail, ['--json']);
    if (!parsed.booleans.has('--json') || parsed.positionals.length > 0) {
      throw new Error(`triage requires --json; ${AUTOPILOT_USAGE}`);
    }
    return { kind: 'triage', json: true };
  }
  if (command === 'issue') {
    const [subcommand, ...rest] = tail;
    if (subcommand === 'create') {
      const parsed = flags(rest, ['--apply'], ['--input']);
      if (parsed.positionals.length > 0 || !parsed.values.has('--input')) {
        throw new Error(`issue create requires --input <json-file>; ${AUTOPILOT_USAGE}`);
      }
      return {
        kind: 'issue-create',
        input: parsed.values.get('--input') as string,
        apply: parsed.booleans.has('--apply'),
      };
    }
    if (subcommand === 'triage') {
      const parsed = flags(rest, ['--apply'], ['--input']);
      if (parsed.positionals.length !== 1 || !parsed.values.has('--input')) {
        throw new Error(`issue triage requires <N> --input <json-file>; ${AUTOPILOT_USAGE}`);
      }
      return {
        kind: 'issue-triage',
        number: positiveInteger(parsed.positionals[0], 'issue number'),
        input: parsed.values.get('--input') as string,
        apply: parsed.booleans.has('--apply'),
      };
    }
    throw new Error(`Expected issue create|triage; ${AUTOPILOT_USAGE}`);
  }
  throw new Error(`Unknown command: ${command}; ${AUTOPILOT_USAGE}`);
}
