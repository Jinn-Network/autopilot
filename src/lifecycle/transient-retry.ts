/**
 * Bounded retry for transport-level faults on provably idempotent reads.
 *
 * One dropped packet used to fail a managed lifecycle action outright: every
 * `gh` and `git` invocation funnels through a single `CommandRunner`
 * (`src/dispatcher/issue-source.ts:99`) with no retry and no transport-fault
 * classification at any layer. Two live canary symptoms from one cycle:
 *
 *   - `claim-review pr:1928` aborted by a TLS handshake timeout raised while
 *     hydrating an unrelated PR #2150.
 *   - `merge pr:2081` aborted by a read timeout on an unrelated PR #2144.
 *
 * Neither failure was in the managed subject; both were incidental reads. In a
 * long autonomous run that makes routine network noise indistinguishable from
 * real lifecycle blockage.
 *
 * THE IDEMPOTENCY BOUNDARY. This engine's operating contract is "no duplicate
 * claims, no duplicate children, no unauthorized merges". A retried mutation
 * breaks it: it can double-merge, double-comment, double-review or create a
 * duplicate pull request. Retry is therefore an allowlist over reads that are
 * provably free of side effects, never a general resilience wrapper. Three
 * rules keep the boundary closed:
 *
 *   1. POSITIVE RECOGNITION, NOT SKIPPING. {@link isRetryableReadCommand}
 *      refuses any argument it does not recognise exactly, rather than ignoring
 *      it. `gh` parses flags with pflag, which accepts attached shorthand values
 *      (`-XPOST`, `-fbody=x`, and clustered `-iXPOST`), so a parser that skipped
 *      unknown tokens would classify a review POST as a read. Every token of a
 *      `gh api` invocation must be a known flag, a known flag's value, or the
 *      single endpoint operand; anything else refuses the command.
 *   2. OPERAND-DRIVEN ROUTING. The GraphQL document check is selected by finding
 *      the `graphql` endpoint operand wherever it appears, never by position, so
 *      `gh api -X GET graphql -f query=mutation…` cannot slip past the document
 *      check into the REST branch.
 *   3. TRANSPORT FAULTS ONLY. {@link classifyTransportFault} admits only faults
 *      that prove the request never completed a round trip — connection reset,
 *      TLS handshake failure, DNS failure, connection/read timeout. Anything the
 *      server actually returned (any HTTP status, auth failure, primary or
 *      secondary rate limiting) is refused first, as a veto: a returned response
 *      means the request was received, so re-sending it risks a duplicate side
 *      effect even for a read-shaped call, and re-sending a throttled request
 *      worsens quota. Rate limiting has backoff semantics handled elsewhere.
 *
 * COVERAGE, STATED EXACTLY. Retry reaches only commands crossing the metered
 * command boundary (`makeGitHubUsageCommandRunner`,
 * `src/lifecycle/github-usage.ts:421`), and no attempt is made here to widen
 * that boundary. In the production orchestrator it is one shared runner
 * (`scripts/run-autopilot-v2.ts:496`) threaded into the lifecycle reader
 * (`:510`), the conditional REST client (`:519`) and the active runtime
 * (`:740` → `src/lifecycle/active-runtime-production.ts:400`), which passes it
 * to the action ports (`:964` → `src/lifecycle/enqueue-executor-production.ts`,
 * whose queue-authority read is therefore covered — as a `gh api graphql`
 * query admitted by the GraphQL document check below, not by the `pr view`
 * porcelain shape it used before `isInMergeQueue` forced it onto GraphQL).
 *
 * NOT covered, and deliberately left so:
 *   - Any port constructed without an explicit runner, which falls back to
 *     `defaultRunner` (`src/lifecycle/active-runtime-production.ts:285`,
 *     `:400`) — the CLI and triage entry points among them.
 *   - Every `git ls-remote` prefixed with credential options, which the git
 *     shape below refuses on principle rather than parsing.
 * Those keep exactly today's single-attempt behaviour.
 */

import type { CommandRunner } from '../dispatcher/issue-source.js';

/** Total attempts for one allowlisted read: the first plus at most two retries. */
export const MAX_READ_ATTEMPTS = 3;

/** Fixed backoff before each retry, indexed by the failed attempt. */
export const BACKOFF_MS: readonly number[] = [250, 1_000];

// ---------------------------------------------------------------------------
// Transport-fault classification
// ---------------------------------------------------------------------------

/**
 * Markers proving the server returned a response. Checked first and treated as
 * a veto: a served response — including 5xx, throttling and auth failures — is
 * never a transport fault, no matter what else the same text says. A 504 whose
 * message also mentions a dial timeout was still received by GitHub.
 */
const SERVED_RESPONSE = [
  /\bHTTP\/[0-9.]+\s+[1-5][0-9]{2}\b/,
  /\bHTTP\s+[1-5][0-9]{2}\b/i,
  /\(HTTP\s+[1-5][0-9]{2}\)/i,
  /\brate limit\b/i,
  /\babuse detection\b/i,
  /\bbad credentials\b/i,
  /\brequires authentication\b/i,
] as const;

/**
 * Transport faults: the request never completed a round trip. Deliberately
 * narrow — each entry names one concrete failure of connect, TLS, DNS or I/O.
 */
const TRANSPORT_FAULT: ReadonlyArray<readonly [string, RegExp]> = [
  ['connection reset', /\bconnection reset by peer\b/i],
  ['connection reset', /\bECONNRESET\b/],
  ['TLS handshake failure', /\bTLS handshake timeout\b/i],
  ['TLS handshake failure', /\btls: handshake failure\b/i],
  ['DNS failure', /\bno such host\b/i],
  ['DNS failure', /\bcould not resolve host\b/i],
  ['DNS failure', /\btemporary failure in name resolution\b/i],
  ['DNS failure', /\b(?:EAI_AGAIN|ENOTFOUND)\b/],
  ['connection timeout', /\bi\/o timeout\b/i],
  ['connection timeout', /\bconnection timed out\b/i],
  ['connection timeout', /\boperation timed out\b/i],
  ['connection timeout', /\bETIMEDOUT\b/],
  ['read timeout', /\bClient\.Timeout exceeded\b/i],
];

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Buffer) return value.toString('utf8');
  return '';
}

const COMMAND_FAILED_PREFIX = 'Command failed: ';

/**
 * Node's `execFile` rejection message is `Command failed: ${cmd}\n${stderr}`,
 * where `cmd` is the whole argument vector joined with spaces, so a command's
 * own arguments are inside its message. A read whose GraphQL document or search
 * term merely contains the words "connection reset by peer" must never be
 * classified by that text, so the echoed argv is stripped before the message is
 * used at all.
 *
 * The argv is stripped by LENGTH, not by scanning for a newline. An argument may
 * itself contain newlines — every GraphQL document this engine issues is
 * multi-line — so `cmd` spans several lines and the first newline in the message
 * usually falls *inside* the echoed argv rather than at its end. Cutting there
 * strips one line of the argv and leaves the rest of the caller's own document
 * standing as "evidence".
 *
 * The exact extent comes from the rejection's own `cmd` field, which Node sets
 * to the same string it interpolated (`child_process`'s `exithandler` assigns
 * `ex.cmd = cmd`). A STRICT PREFIX is not that extent: Node interpolates the
 * argv and then either ends the message or writes `\n` before stderr, so the
 * remainder after `cmd` must be empty or start with `\n`. Anything else means
 * `cmd` names less than the whole echoed argv and the rest is still the
 * caller's own argument text. So when the field is missing, when the message
 * does not begin with the argv `cmd` names, or when it names only a prefix of
 * it, the boundary is unknowable and the whole message is refused as evidence —
 * the fail-closed direction, and lossless in practice: an `execFile` rejection
 * whose `stderr` is empty has nothing after the argv anyway, and message
 * evidence is consulted only when stderr is empty.
 */
function messageEvidence(message: string, echoedArgv: string): string {
  if (!message.startsWith(COMMAND_FAILED_PREFIX)) return message;
  const body = message.slice(COMMAND_FAILED_PREFIX.length);
  if (echoedArgv.length === 0 || !body.startsWith(echoedArgv)) return '';
  const rest = body.slice(echoedArgv.length);
  if (rest.length !== 0 && !rest.startsWith('\n')) return '';
  return rest.startsWith('\n') ? rest.slice(1) : rest;
}

/**
 * The transport fault a failed subprocess proves, or `null` when the failure is
 * anything else. Evidence is `stderr`, falling back to the message only when
 * stderr is empty. `stdout` is never read as fault evidence — it carries the
 * response payload, whose text is attacker-influenced (a pull-request body
 * saying "connection reset by peer" must not make anything retryable) — but a
 * served HTTP response on `stdout`, which `gh api --include` retains on a
 * non-zero exit, does veto the fault.
 */
export function classifyTransportFault(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const fields = error as Record<string, unknown>;
  if (/^\s*HTTP\/[0-9.]+\s+[1-5][0-9]{2}\b/m.test(text(fields.stdout))) return null;
  const stderr = text(fields.stderr);
  const evidence = stderr.trim().length > 0
    ? stderr
    : messageEvidence(text(fields.message), text(fields.cmd));
  if (SERVED_RESPONSE.some((pattern) => pattern.test(evidence))) return null;
  for (const [fault, pattern] of TRANSPORT_FAULT) {
    if (pattern.test(evidence)) return fault;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Positive read allowlist
// ---------------------------------------------------------------------------

/**
 * `gh api` flags that consume the following argument, exactly as `gh api --help`
 * spells them. Only the separated form (`-X GET`) and the long attached form
 * (`--method=GET`) are recognised; pflag's attached shorthand (`-XGET`) and
 * clustered shorthand (`-iXPOST`) are refused rather than parsed, because
 * mis-parsing one of them is the difference between a read and a merge.
 */
const GH_API_VALUE_FLAGS = new Set([
  '--cache',
  '-F', '--field',
  '-H', '--header',
  '--hostname',
  '--input',
  '-q', '--jq',
  '-X', '--method',
  '-p', '--preview',
  '-t', '--template',
  '-f', '--raw-field',
]);

const GH_API_BOOLEAN_FLAGS = new Set([
  '-i', '--include',
  '--paginate',
  '--silent',
  '--slurp',
  '--verbose',
]);

const FIELD_FLAGS = new Set(['-f', '-F', '--field', '--raw-field']);
const METHOD_FLAGS = new Set(['-X', '--method']);
const READ_METHODS = new Set(['GET', 'HEAD']);

interface GhApiInvocation {
  /** The single endpoint operand, e.g. `repos/o/r/pulls/1` or `graphql`. */
  readonly endpoint: string;
  readonly method: string | null;
  readonly fields: readonly string[];
}

/**
 * Fully parse a `gh api` invocation, or return `null` to refuse it. Every token
 * must be positively recognised: an unknown flag, an attached shorthand value, a
 * `--` separator, a flag missing its value, an opaque `--input` body, or any
 * operand count other than one refuses the command.
 */
function parseGhApi(args: readonly string[]): GhApiInvocation | null {
  let method: string | null = null;
  const fields: string[] = [];
  const operands: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--' || arg === '-') return null;
    if (!arg.startsWith('-')) {
      operands.push(arg);
      continue;
    }
    let name = arg;
    let value: string | null = null;
    const separator = arg.indexOf('=');
    if (arg.startsWith('--') && separator !== -1) {
      name = arg.slice(0, separator);
      value = arg.slice(separator + 1);
    }
    if (GH_API_BOOLEAN_FLAGS.has(name)) {
      // `--paginate=true` parses in pflag, but recognising only the bare form
      // keeps the accepted grammar as small as the engine's own call sites.
      if (value !== null) return null;
      continue;
    }
    if (!GH_API_VALUE_FLAGS.has(name)) return null;
    if (value === null) {
      index += 1;
      if (index >= args.length) return null;
      value = args[index]!;
    }
    // A body supplied by file is opaque to argument inspection, so such a
    // request can never be proven to be a read.
    if (name === '--input') return null;
    if (METHOD_FLAGS.has(name)) method = value;
    else if (FIELD_FLAGS.has(name)) fields.push(value);
  }
  if (operands.length !== 1) return null;
  return { endpoint: operands[0]!, method, fields };
}

/**
 * A GraphQL request is a read only when its document is positively a query.
 * `gh api graphql` is transported as a POST, so the document — not the HTTP
 * verb — is the evidence: the single `query=` field must open with `query` or an
 * anonymous selection set, and no argument anywhere may mention `mutation`.
 *
 * An explicit method must still be a read verb. No call site supplies one — `gh
 * api graphql` is always left implicit — so admitting `-X POST graphql` would
 * widen the accepted grammar past anything this engine issues, for nothing.
 */
function isGraphQlRead(args: readonly string[], invocation: GhApiInvocation): boolean {
  const method = invocation.method?.toUpperCase() ?? null;
  if (method !== null && !READ_METHODS.has(method)) return false;
  if (args.some((arg) => /\bmutation\b/i.test(arg))) return false;
  const documents = invocation.fields.filter((field) => field.startsWith('query='));
  if (documents.length !== 1) return false;
  return /^\s*(?:query\b|\{)/.test(documents[0]!.slice('query='.length));
}

/**
 * A REST request is a read only when it provably issues a GET or HEAD. `gh api`
 * defaults to GET but silently switches to POST as soon as any field flag is
 * present, so fields without an explicit read method are refused.
 */
function isRestRead(invocation: GhApiInvocation): boolean {
  if (invocation.method === null) return invocation.fields.length === 0;
  return READ_METHODS.has(invocation.method.toUpperCase());
}

/** `gh` porcelain subcommands that only ever read. */
const GH_PORCELAIN_READS: ReadonlyArray<readonly [string, string]> = [
  ['pr', 'view'],
  ['pr', 'list'],
  ['issue', 'view'],
  ['issue', 'list'],
];

function isRetryableGhRead(args: readonly string[]): boolean {
  if (args[0] === 'api') {
    const invocation = parseGhApi(args);
    if (invocation === null) return false;
    return invocation.endpoint === 'graphql'
      ? isGraphQlRead(args, invocation)
      : isRestRead(invocation);
  }
  return GH_PORCELAIN_READS.some(([group, action]) => args[0] === group && args[1] === action);
}

/**
 * `git ls-remote` is the only `git` read on the allowlist. It opens a network
 * connection, prints the remote's advertised refs and writes nothing — no
 * object, no ref, no index, no working tree — so N invocations are
 * indistinguishable from one.
 *
 * Only one operand shape is admitted: an optional leading `-C <path>` followed
 * by exactly `ls-remote <remote> <ref>`, which is what the reader's own git
 * reads emit (`src/lifecycle/github-reader.ts:854`, feeding `:866`, `:880`,
 * `:895`, `:1094`, `:1658`) and what the bare protocol read emits
 * (`src/lifecycle/git-protocol.ts:65`).
 *
 * Everything else is refused, including options this engine itself emits,
 * because several `git` options turn an ostensible read into code execution or
 * a write: `--upload-pack=<program>` and `-u <program>` name an executable git
 * runs, `-c core.hooksPath=…` installs hooks, and `-c protocol.ext.allow=always`
 * enables `ext::` remotes that spawn a shell. Refusing on option *shape* rather
 * than on a denylist of dangerous names is what makes that closed. The cost is
 * that the `ls-remote` reads prefixed with `gitPublicationArgs`' `-c
 * credential.helper= -c core.askPass=…` (`src/lifecycle/credentials.ts:414`) —
 * `src/lifecycle/ci-rerun-production.ts:58`,
 * `src/lifecycle/review-session-production.ts:677`,
 * `src/lifecycle/implementation-session-production.ts:259` — are not retried.
 * They keep today's single-attempt behaviour, which is the safe direction.
 *
 * `git fetch` is refused too: it converges local remote-tracking refs, which is
 * ref-writing by the letter of the boundary.
 */
function isRetryableGitRead(args: readonly string[]): boolean {
  let index = 0;
  if (args[0] === '-C') {
    const path = args[1];
    if (path === undefined || path.length === 0 || path.startsWith('-')) return false;
    index = 2;
  }
  if (args[index] !== 'ls-remote') return false;
  const operands = args.slice(index + 1);
  if (operands.length !== 2) return false;
  // `ext::`/`fd::` style remotes name a transport helper program to execute.
  return operands.every((operand) => (
    operand.length > 0 && !operand.startsWith('-') && !operand.includes('::')
  ));
}

/**
 * Whether one command is a read this engine can prove is idempotent. Fails
 * closed: anything not positively recognised is refused, so an unrecognised or
 * newly-added command keeps today's single-attempt behaviour.
 */
export function isRetryableReadCommand(command: string, args: readonly string[]): boolean {
  if (command === 'gh') return isRetryableGhRead(args);
  if (command === 'git') return isRetryableGitRead(args);
  return false;
}

// ---------------------------------------------------------------------------
// The retrying runner
// ---------------------------------------------------------------------------

/**
 * One retried attempt, surfaced so a retry is never silently invisible. The
 * command's arguments are deliberately absent: arguments can carry credentials,
 * and nothing downstream may log them.
 */
export interface TransientReadRetryEvent {
  readonly command: string;
  /** The 1-based attempt that faulted; the next attempt is `attempt + 1`. */
  readonly attempt: number;
  /** The classified transport fault, e.g. `TLS handshake failure`. */
  readonly fault: string;
}

export interface TransientReadRetryOptions {
  readonly onRetry?: (event: TransientReadRetryEvent) => void;
  /**
   * Test seam for the fixed backoff. Not reachable from production
   * configuration: the metered command boundary never forwards one, so the
   * engine always waits for real.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Runners this module already wrapped, so wrapping twice cannot multiply attempts. */
const alreadyRetrying = new WeakSet<CommandRunner>();

/**
 * Wrap a command runner so allowlisted reads survive a transport fault.
 * Mutations, unrecognised commands and every failure the server actually
 * returned pass through with exactly one attempt, unchanged. When the attempt
 * cap is exhausted the original error is rethrown — never a synthetic one — so
 * the failure the operator sees is the failure that happened.
 *
 * Wrapping is idempotent: re-wrapping an already-wrapped runner returns it
 * unchanged, so a caller that nests the metered boundary cannot turn 3 attempts
 * into 9.
 */
export function withTransientReadRetry(
  run: CommandRunner,
  options: TransientReadRetryOptions = {},
): CommandRunner {
  if (alreadyRetrying.has(run)) return run;
  const sleep = options.sleep ?? defaultSleep;
  const retrying: CommandRunner = async (command, args, commandOptions) => {
    if (!isRetryableReadCommand(command, args)) return run(command, args, commandOptions);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await run(command, args, commandOptions);
      } catch (error) {
        const fault = classifyTransportFault(error);
        if (fault === null || attempt >= MAX_READ_ATTEMPTS) throw error;
        options.onRetry?.({ command, attempt, fault });
        await sleep(BACKOFF_MS[attempt - 1]!);
      }
    }
  };
  alreadyRetrying.add(retrying);
  return retrying;
}
