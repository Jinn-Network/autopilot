import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat as fsLstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitOid } from './types.js';

export const MAX_MARKETPLACE_PATCH_BYTES = 2 * 1024 * 1024;

export type MarketplacePatchPolicyReason =
  | 'artifact-too-large'
  | 'invalid-utf8'
  | 'nul-byte'
  | 'binary-diff'
  | 'combined-diff'
  | 'malformed-patch'
  | 'unsafe-path'
  | 'forbidden-mode'
  | 'verification-control'
  | 'authority-mismatch'
  | 'git-inspection-failed'
  | 'unsafe-index-entry'
  | 'unsafe-filesystem-entry'
  | 'git-check-failed'
  | 'git-apply-failed'
  | 'git-timeout'
  | 'git-output-limit';

export class MarketplacePatchPolicyError extends Error {
  readonly reason: MarketplacePatchPolicyReason;

  constructor(reason: MarketplacePatchPolicyReason, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'MarketplacePatchPolicyError';
    this.reason = reason;
  }
}

export interface ValidatedMarketplacePatch {
  readonly artifact: Uint8Array;
  readonly artifactDigest: string;
  readonly byteLength: number;
  readonly touchedPaths: readonly string[];
}

function reject(reason: MarketplacePatchPolicyReason, message: string, cause?: unknown): never {
  throw new MarketplacePatchPolicyError(reason, message, cause);
}

function decodeUtf8(bytes: Uint8Array, reason: MarketplacePatchPolicyReason): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    reject(reason, 'Marketplace patch contains invalid UTF-8', error);
  }
}

interface ParsedToken {
  readonly value: string;
  readonly end: number;
}

function parseGitToken(input: string, start = 0): ParsedToken {
  if (input[start] !== '"') {
    let end = start;
    while (end < input.length && input[end] !== ' ' && input[end] !== '\t') end += 1;
    if (end === start) reject('malformed-patch', 'Marketplace patch has an empty path token');
    return { value: input.slice(start, end), end };
  }

  const decoded: number[] = [];
  for (let cursor = start + 1; cursor < input.length; cursor += 1) {
    const character = input[cursor]!;
    if (character === '"') {
      return {
        value: decodeUtf8(Uint8Array.from(decoded), 'malformed-patch'),
        end: cursor + 1,
      };
    }
    if (character !== '\\') {
      const codePoint = input.codePointAt(cursor)!;
      const decodedCharacter = String.fromCodePoint(codePoint);
      decoded.push(...new TextEncoder().encode(decodedCharacter));
      cursor += decodedCharacter.length - 1;
      continue;
    }
    cursor += 1;
    if (cursor >= input.length) break;
    const escaped = input[cursor]!;
    const simpleEscapes: Readonly<Record<string, number>> = {
      a: 0x07,
      b: 0x08,
      t: 0x09,
      n: 0x0a,
      v: 0x0b,
      f: 0x0c,
      r: 0x0d,
      '"': 0x22,
      '\\': 0x5c,
    };
    const simple = simpleEscapes[escaped];
    if (simple !== undefined) {
      decoded.push(simple);
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && cursor + 1 < input.length && /[0-7]/.test(input[cursor + 1]!)) {
        cursor += 1;
        octal += input[cursor]!;
      }
      const byte = Number.parseInt(octal, 8);
      if (byte > 0xff) {
        reject('malformed-patch', 'Marketplace patch has an invalid quoted path octal escape');
      }
      decoded.push(byte);
      continue;
    }
    reject('malformed-patch', 'Marketplace patch has an invalid quoted path escape');
  }
  reject('malformed-patch', 'Marketplace patch has an unterminated quoted path');
}

interface DiffPathCandidate {
  readonly oldPath: string;
  readonly newPath: string;
}

function parseDiffPathCandidates(line: string): readonly DiffPathCandidate[] {
  const rest = line.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    const first = parseGitToken(rest);
    let cursor = first.end;
    while (rest[cursor] === ' ' || rest[cursor] === '\t') cursor += 1;
    if (cursor >= rest.length) {
      reject('malformed-patch', 'Marketplace patch diff header is missing a path');
    }
    if (rest[cursor] === '"') {
      const second = parseGitToken(rest, cursor);
      if (rest.slice(second.end).trim().length !== 0) {
        reject('malformed-patch', 'Marketplace patch diff header has trailing data');
      }
      return [{ oldPath: first.value, newPath: second.value }];
    }
    return [{ oldPath: first.value, newPath: rest.slice(cursor) }];
  }

  const quotedBoundary = rest.indexOf(' "b/');
  if (quotedBoundary !== -1) {
    const second = parseGitToken(rest, quotedBoundary + 1);
    if (rest.slice(second.end).trim().length !== 0) {
      reject('malformed-patch', 'Marketplace patch diff header has trailing data');
    }
    return [{ oldPath: rest.slice(0, quotedBoundary), newPath: second.value }];
  }
  const boundaries: number[] = [];
  let boundary = rest.indexOf(' b/');
  while (boundary !== -1) {
    boundaries.push(boundary);
    boundary = rest.indexOf(' b/', boundary + 1);
  }
  const samePathBoundaries = boundaries.filter((candidate) => {
    const oldPath = rest.slice(0, candidate);
    const newPath = rest.slice(candidate + 1);
    return oldPath.startsWith('a/')
      && newPath.startsWith('b/')
      && oldPath.slice(2) === newPath.slice(2);
  });
  if (samePathBoundaries.length === 1) {
    const selectedBoundary = samePathBoundaries[0]!;
    return [{
      oldPath: rest.slice(0, selectedBoundary),
      newPath: rest.slice(selectedBoundary + 1),
    }];
  }
  if (boundaries.length === 0) {
    reject('malformed-patch', 'Marketplace patch diff header paths are missing or ambiguous');
  }
  return boundaries.map((selectedBoundary) => ({
    oldPath: rest.slice(0, selectedBoundary),
    newPath: rest.slice(selectedBoundary + 1),
  }));
}

function parseSinglePath(raw: string, allowTimestamp: boolean): string {
  if (raw.startsWith('"')) {
    const parsed = parseGitToken(raw);
    const trailing = raw.slice(parsed.end);
    if (
      trailing.length !== 0
      && (!allowTimestamp || !trailing.startsWith('\t'))
    ) {
      reject('malformed-patch', 'Marketplace patch path header has trailing data');
    }
    return parsed.value;
  }
  if (!allowTimestamp) return raw;
  const tab = raw.indexOf('\t');
  return tab === -1 ? raw : raw.slice(0, tab);
}

const PACKAGE_CONTROL_FILES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  'npmrc',
  '.pnpmrc',
  '.pnpmfile.cjs',
  '.pnpmfile.js',
  'bun.lock',
  'bun.lockb',
  'bunfig.toml',
  'deno.json',
  'deno.jsonc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pnp.cjs',
  '.pnp.js',
  '.pnp.loader.mjs',
  'mocha.opts',
  'jasmine.json',
]);

function isVerificationControl(path: string, segments: readonly string[]): boolean {
  const basename = segments.at(-1)!;
  const lowerBasename = basename.toLowerCase();
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  return PACKAGE_CONTROL_FILES.has(lowerBasename)
    || lowerSegments.some((segment) =>
      segment === '.yarn'
      || segment === 'node_modules'
      || segment === 'test'
      || segment === 'tests'
      || segment === '__tests__'
      || segment === 'spec'
      || segment === 'specs'
      || segment === '__specs__'
      || segment === '__snapshots__'
      || segment === 'snapshots')
    || lowerBasename.startsWith('.pnp.')
    || lowerBasename.startsWith('.yarnrc')
    || /^tsconfig(?:\.[^.]+)*\.json$/i.test(basename)
    || /^(?:vite|vitest|jest|playwright|cypress|ava|test)(?:\.[^.]+)*\.(?:config|workspace|projects|preset)(?:\.[^.]+)+$/i.test(basename)
    || /^(?:karma|wdio)(?:\.[^.]+)*\.conf(?:\.[^.]+)+$/i.test(basename)
    || /^\.mocharc(?:\.[^.]+)?$/i.test(basename)
    || /^(?:vitest|jest)\.(?:setup|global-setup|global-teardown)\.[^.]+$/i.test(basename)
    || /^setupTests\.[^.]+$/i.test(basename)
    || /\.(?:test|spec|e2e|integration)\.[^.]+$/i.test(basename)
    || /\.snap$/i.test(basename)
    || path === '';
}

function validatePath(
  rawPath: string,
  options: {
    readonly allowDevNull?: boolean;
    readonly expectedPrefix?: 'a/' | 'b/';
  } = {},
): string | null {
  if (options.allowDevNull === true && rawPath === '/dev/null') return null;
  if (
    rawPath.length === 0
    || rawPath.startsWith('/')
    || rawPath.includes('\\')
    || /^[A-Za-z]:/.test(rawPath)
    || /[\u0000-\u001f\u007f]/.test(rawPath)
    || rawPath !== rawPath.normalize('NFC')
  ) {
    reject('unsafe-path', `Marketplace patch path is unsafe: ${JSON.stringify(rawPath)}`);
  }
  const rawSegments = rawPath.split(/[\\/]/);
  if (
    rawSegments.some((segment) =>
      segment.length === 0
      || segment === '.'
      || segment === '..'
      || segment.toLowerCase() === '.git')
  ) {
    reject('unsafe-path', `Marketplace patch path is unsafe: ${JSON.stringify(rawPath)}`);
  }
  if (options.expectedPrefix !== undefined && !rawPath.startsWith(options.expectedPrefix)) {
    reject('malformed-patch', 'Marketplace patch does not use canonical a/ and b/ path prefixes');
  }
  const path = options.expectedPrefix === undefined ? rawPath : rawPath.slice(2);
  if (
    path.length === 0
    || path.startsWith('/')
    || path.startsWith('\\')
    || /^[A-Za-z]:/.test(path)
    || /[\u0000-\u001f\u007f]/.test(path)
    || path !== path.normalize('NFC')
  ) {
    reject('unsafe-path', `Marketplace patch path is unsafe: ${JSON.stringify(path)}`);
  }
  const segments = path.split(/[\\/]/);
  if (
    segments.some((segment) =>
      segment.length === 0
      || segment === '.'
      || segment === '..'
      || segment.toLowerCase() === '.git')
  ) {
    reject('unsafe-path', `Marketplace patch path is unsafe: ${JSON.stringify(path)}`);
  }
  if (isVerificationControl(path, segments)) {
    reject(
      'verification-control',
      `Marketplace patch may not change verification controls: ${JSON.stringify(path)}`,
    );
  }
  return path;
}

type DirectModeKind = 'oldMode' | 'newMode' | 'newFileMode' | 'deletedFileMode';

interface DirectMode {
  readonly kind: DirectModeKind;
  readonly mode: '100644' | '100755';
}

function validateModeLine(line: string): DirectMode | null {
  const directPrefixes = ['old mode', 'new mode', 'new file mode', 'deleted file mode'] as const;
  const directPrefix = directPrefixes.find((prefix) => line.startsWith(prefix));
  if (directPrefix !== undefined) {
    if (
      line !== `${directPrefix} 100644`
      && line !== `${directPrefix} 100755`
    ) {
      reject('forbidden-mode', 'Marketplace patch contains a noncanonical or forbidden mode');
    }
    const kindByPrefix: Readonly<Record<typeof directPrefix, DirectModeKind>> = {
      'old mode': 'oldMode',
      'new mode': 'newMode',
      'new file mode': 'newFileMode',
      'deleted file mode': 'deletedFileMode',
    };
    return {
      kind: kindByPrefix[directPrefix],
      mode: line.endsWith('100755') ? '100755' : '100644',
    };
  }
  if (line.startsWith('index ')) {
    if (!/^index [0-9a-f]{7,64}\.\.[0-9a-f]{7,64}(?: (?:100644|100755))?$/.test(line)) {
      reject('forbidden-mode', 'Marketplace patch contains a noncanonical or forbidden index mode');
    }
  }
  return null;
}

interface HunkCounts {
  readonly oldLines: number;
  readonly newLines: number;
}

interface FileEffect {
  changedLines: boolean;
  readonly diffPathCandidates: readonly DiffPathCandidate[];
  oldHeaderPath?: string | null;
  newHeaderPath?: string | null;
  oldMode?: DirectMode['mode'];
  newMode?: DirectMode['mode'];
  newFileMode?: DirectMode['mode'];
  deletedFileMode?: DirectMode['mode'];
  renameFrom?: string;
  renameTo?: string;
  copyFrom?: string;
  copyTo?: string;
}

function finishFileEffect(effect: FileEffect | null, touchedPaths: Set<string>): void {
  if (effect === null) return;
  const oldEvidence = [effect.oldHeaderPath, effect.renameFrom, effect.copyFrom]
    .filter((path): path is string => path !== undefined && path !== null);
  const newEvidence = [effect.newHeaderPath, effect.renameTo, effect.copyTo]
    .filter((path): path is string => path !== undefined && path !== null);
  const selectedCandidate = effect.diffPathCandidates.length === 1
    ? effect.diffPathCandidates[0]!
    : (() => {
      const matchingCandidates = effect.diffPathCandidates.filter((candidate) =>
        candidate.oldPath.startsWith('a/')
        && candidate.newPath.startsWith('b/')
        && oldEvidence.every((path) => candidate.oldPath.slice(2) === path)
        && newEvidence.every((path) => candidate.newPath.slice(2) === path));
      if (matchingCandidates.length !== 1) {
        reject('malformed-patch', 'Marketplace patch diff header paths are missing or ambiguous');
      }
      return matchingCandidates[0]!;
    })();
  const oldPath = validatePath(selectedCandidate.oldPath, { expectedPrefix: 'a/' });
  const newPath = validatePath(selectedCandidate.newPath, { expectedPrefix: 'b/' });
  if (oldPath !== null) touchedPaths.add(oldPath);
  if (newPath !== null) touchedPaths.add(newPath);

  if (
    (effect.oldMode === undefined) !== (effect.newMode === undefined)
    || (effect.renameFrom === undefined) !== (effect.renameTo === undefined)
    || (effect.copyFrom === undefined) !== (effect.copyTo === undefined)
    || (effect.newFileMode !== undefined && effect.deletedFileMode !== undefined)
  ) {
    reject('malformed-patch', 'Marketplace patch contains incomplete or contradictory metadata');
  }
  const hasEffect = effect.changedLines
    || effect.newFileMode !== undefined
    || effect.deletedFileMode !== undefined
    || (
      effect.oldMode !== undefined
      && effect.newMode !== undefined
      && effect.oldMode !== effect.newMode
    )
    || (
      effect.renameFrom !== undefined
      && effect.renameTo !== undefined
      && effect.renameFrom !== effect.renameTo
    )
    || (
      effect.copyFrom !== undefined
      && effect.copyTo !== undefined
      && effect.copyFrom !== effect.copyTo
    );
  if (!hasEffect) {
    reject('malformed-patch', 'Marketplace patch does not contain an effect');
  }
}

function parseHunkCounts(line: string): HunkCounts {
  const match = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?:.*)$/.exec(line);
  if (match === null) {
    reject('malformed-patch', 'Marketplace patch contains a malformed hunk header');
  }
  return {
    oldLines: match[1] === undefined ? 1 : Number.parseInt(match[1], 10),
    newLines: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
  };
}

function parsePatchPaths(text: string): readonly string[] {
  const touchedPaths = new Set<string>();
  let phase: 'outside' | 'header' | 'hunk' | 'body' = 'outside';
  let oldLines = 0;
  let newLines = 0;
  let removedLines: string[] = [];
  let addedLines: string[] = [];
  let oldNoNewline = false;
  let newNoNewline = false;
  let lastHunkSide: 'old' | 'new' | 'context' | null = null;
  let hunkPending = false;
  let fileEffect: FileEffect | null = null;
  const recordNoNewlineMarker = (line: string): void => {
    if (line !== '\\ No newline at end of file' || !hunkPending || lastHunkSide === null) {
      reject('malformed-patch', 'Marketplace patch contains a misplaced newline marker');
    }
    if (lastHunkSide === 'old' || lastHunkSide === 'context') oldNoNewline = true;
    if (lastHunkSide === 'new' || lastHunkSide === 'context') newNoNewline = true;
  };
  const finishHunk = (): void => {
    if (!hunkPending) return;
    if (
      oldNoNewline !== newNoNewline
      || removedLines.length !== addedLines.length
      || removedLines.some((removed, index) => removed !== addedLines[index])
    ) {
      fileEffect!.changedLines = true;
    }
    hunkPending = false;
    lastHunkSide = null;
  };
  for (const line of text.split('\n')) {
    if (
      line.startsWith('diff --cc ')
      || line.startsWith('diff --combined ')
      || line.startsWith('@@@')
    ) {
      reject('combined-diff', 'Marketplace patch contains a combined diff');
    }
    if (line === 'GIT binary patch' || line.startsWith('Binary files ')) {
      reject('binary-diff', 'Marketplace patch contains a binary diff');
    }
    if (phase === 'hunk') {
      if (line.startsWith('\\ ')) {
        recordNoNewlineMarker(line);
        continue;
      }
      const prefix = line[0];
      if (prefix === ' ') {
        oldLines -= 1;
        newLines -= 1;
        lastHunkSide = 'context';
      } else if (prefix === '-') {
        oldLines -= 1;
        removedLines.push(line.slice(1));
        lastHunkSide = 'old';
      } else if (prefix === '+') {
        newLines -= 1;
        addedLines.push(line.slice(1));
        lastHunkSide = 'new';
      } else {
        reject('malformed-patch', 'Marketplace patch hunk has an invalid content line');
      }
      if (oldLines < 0 || newLines < 0) {
        reject('malformed-patch', 'Marketplace patch hunk contains too many lines');
      }
      if (oldLines === 0 && newLines === 0) {
        phase = 'body';
      }
      continue;
    }
    if (line.startsWith('diff --git ')) {
      finishHunk();
      finishFileEffect(fileEffect, touchedPaths);
      fileEffect = {
        changedLines: false,
        diffPathCandidates: parseDiffPathCandidates(line),
      };
      phase = 'header';
      continue;
    }
    if (line.startsWith('@@ ')) {
      if (phase !== 'header' && phase !== 'body') {
        reject('malformed-patch', 'Marketplace patch hunk is outside a Git file diff');
      }
      finishHunk();
      const counts = parseHunkCounts(line);
      oldLines = counts.oldLines;
      newLines = counts.newLines;
      removedLines = [];
      addedLines = [];
      oldNoNewline = false;
      newNoNewline = false;
      lastHunkSide = null;
      hunkPending = true;
      phase = oldLines === 0 && newLines === 0 ? 'body' : 'hunk';
      continue;
    }
    if (phase === 'outside') {
      if (line.length !== 0) {
        reject('malformed-patch', 'Marketplace patch contains data outside a Git file diff');
      }
      continue;
    }
    if (phase === 'body') {
      if (line.startsWith('\\ ')) {
        recordNoNewlineMarker(line);
        continue;
      }
      if (line.length === 0) continue;
      reject('malformed-patch', 'Marketplace patch contains a file diff without diff --git');
    }
    const directMode = validateModeLine(line);
    if (directMode !== null) {
      if (fileEffect![directMode.kind] !== undefined) {
        reject('malformed-patch', 'Marketplace patch repeats mode metadata');
      }
      fileEffect![directMode.kind] = directMode.mode;
    }
    const pathPrefixes = ['--- ', '+++ ', 'rename from ', 'rename to ', 'copy from ', 'copy to '] as const;
    const prefix = pathPrefixes.find((candidate) => line.startsWith(candidate));
    if (prefix !== undefined) {
      const isFileHeader = prefix === '--- ' || prefix === '+++ ';
      const rawPath = parseSinglePath(line.slice(prefix.length), isFileHeader);
      const path = validatePath(rawPath, prefix === '--- '
        ? { allowDevNull: true, expectedPrefix: 'a/' }
        : prefix === '+++ '
          ? { allowDevNull: true, expectedPrefix: 'b/' }
          : {});
      if (path !== null) touchedPaths.add(path);
      if (prefix === '--- ' || prefix === '+++ ') {
        const kind = prefix === '--- ' ? 'oldHeaderPath' : 'newHeaderPath';
        if (Object.hasOwn(fileEffect!, kind)) {
          reject('malformed-patch', 'Marketplace patch repeats file path metadata');
        }
        fileEffect![kind] = path;
      }
      if (
        prefix === 'rename from '
        || prefix === 'rename to '
        || prefix === 'copy from '
        || prefix === 'copy to '
      ) {
        const kind = prefix === 'rename from '
          ? 'renameFrom'
          : prefix === 'rename to '
            ? 'renameTo'
            : prefix === 'copy from '
              ? 'copyFrom'
              : 'copyTo';
        if (fileEffect![kind] !== undefined) {
          reject('malformed-patch', 'Marketplace patch repeats rename or copy metadata');
        }
        fileEffect![kind] = path!;
      }
    }
  }
  if (phase === 'hunk') {
    reject('malformed-patch', 'Marketplace patch ends inside an incomplete hunk');
  }
  finishHunk();
  finishFileEffect(fileEffect, touchedPaths);
  if (touchedPaths.size === 0) {
    reject('malformed-patch', 'Marketplace patch does not contain a file diff');
  }
  return [...touchedPaths].sort();
}

export function validateMarketplacePatch(
  artifact: Uint8Array,
): ValidatedMarketplacePatch {
  if (artifact.byteLength > MAX_MARKETPLACE_PATCH_BYTES) {
    throw new MarketplacePatchPolicyError(
      'artifact-too-large',
      'Marketplace patch exceeds the byte limit',
    );
  }
  const copy = Uint8Array.from(artifact);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(copy);
  } catch (error) {
    reject('invalid-utf8', 'Marketplace patch contains invalid UTF-8', error);
  }
  if (text.includes('\0')) reject('nul-byte', 'Marketplace patch contains a NUL byte');
  const touchedPaths = parsePatchPaths(text);
  return {
    artifact: copy,
    artifactDigest: `sha256:${createHash('sha256').update(copy).digest('hex')}`,
    byteLength: copy.byteLength,
    touchedPaths,
  };
}

export type MarketplacePatchGitRunner = (
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly stdin?: Uint8Array;
    readonly timeoutMs: number;
    readonly outputLimitBytes: number;
  },
) => Promise<Uint8Array>;

export type MarketplacePatchLstat = (
  path: string,
) => Promise<'missing' | 'regular-file' | 'directory' | 'symlink' | 'other'>;

export interface MarketplaceAttemptWorktreeProof {
  readonly manifestPath: string;
  readonly registeredWorktreePath: string;
  readonly expectedHead: GitOid;
  readonly currentHead: GitOid;
  readonly indexClean: true;
  readonly worktreeClean: true;
  readonly untrackedPaths: readonly [];
}

export interface MarketplaceAttemptWorktreeProofPort {
  prove(input: {
    readonly manifestPath: string;
    readonly worktreePath: string;
    readonly expectedHead: GitOid;
  }): Promise<MarketplaceAttemptWorktreeProof>;
}

export interface MarketplacePatchApplicationPorts {
  readonly runGit?: MarketplacePatchGitRunner;
  readonly lstat?: MarketplacePatchLstat;
  readonly worktreeProof: MarketplaceAttemptWorktreeProofPort;
}

const MARKETPLACE_PATCH_GIT_TIMEOUT_MS = 30_000;
const MARKETPLACE_PATCH_GIT_OUTPUT_LIMIT_BYTES = 1024 * 1024;

export const runMarketplacePatchGit: MarketplacePatchGitRunner = (
  args,
  options,
) => new Promise((resolve, rejectPromise) => {
  const child = spawn('git', [...args], {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let settled = false;
  let timedOut = false;
  let exceededOutput = false;

  const stop = (reason: 'timeout' | 'output'): void => {
    if (settled) return;
    if (reason === 'timeout') timedOut = true;
    else exceededOutput = true;
    child.kill('SIGKILL');
  };
  const timer = setTimeout(() => stop('timeout'), options.timeoutMs);
  const collect = (target: Buffer[], chunk: Buffer): void => {
    if (settled) return;
    outputBytes += chunk.byteLength;
    if (outputBytes > options.outputLimitBytes) {
      stop('output');
      return;
    }
    target.push(chunk);
  };
  child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
  child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
  child.stdin.on('error', (error: NodeJS.ErrnoException) => {
    if (settled || error.code === 'EPIPE') return;
    settled = true;
    clearTimeout(timer);
    child.kill('SIGKILL');
    rejectPromise(error);
  });
  child.on('error', (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    rejectPromise(error);
  });
  child.on('close', (exitCode, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (timedOut) {
      rejectPromise(new MarketplacePatchPolicyError(
        'git-timeout',
        `git ${args.join(' ')} exceeded ${options.timeoutMs}ms`,
      ));
      return;
    }
    if (exceededOutput) {
      rejectPromise(new MarketplacePatchPolicyError(
        'git-output-limit',
        `git ${args.join(' ')} exceeded its output limit`,
      ));
      return;
    }
    if (exitCode !== 0) {
      const diagnostic = Buffer.concat(stderr).toString('utf8').trim();
      rejectPromise(new Error(
        `git ${args.join(' ')} exited ${String(exitCode)}`
        + (signal === null ? '' : ` (${signal})`)
        + (diagnostic.length === 0 ? '' : `: ${diagnostic}`),
      ));
      return;
    }
    resolve(Uint8Array.from(Buffer.concat(stdout)));
  });
  if (options.stdin === undefined) child.stdin.end();
  else child.stdin.end(Buffer.from(options.stdin));
});

const marketplacePatchLstat: MarketplacePatchLstat = async (path) => {
  try {
    const metadata = await fsLstat(path);
    if (metadata.isSymbolicLink()) return 'symlink';
    if (metadata.isFile()) return 'regular-file';
    if (metadata.isDirectory()) return 'directory';
    return 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
};

function assertExactAuthority(
  input: {
    readonly manifestPath: string;
    readonly worktreePath: string;
    readonly expectedHead: GitOid;
  },
  proof: MarketplaceAttemptWorktreeProof,
): void {
  if (
    proof.manifestPath !== input.manifestPath
    || proof.registeredWorktreePath !== input.worktreePath
    || proof.expectedHead !== input.expectedHead
    || proof.currentHead !== input.expectedHead
    || proof.indexClean !== true
    || proof.worktreeClean !== true
    || !Array.isArray(proof.untrackedPaths)
    || proof.untrackedPaths.length !== 0
  ) {
    reject(
      'authority-mismatch',
      'Marketplace patch worktree authority does not match the exact attempt',
    );
  }
}

interface IndexEntry {
  readonly mode: string;
  readonly path: string;
}

function parseIndexEntries(bytes: Uint8Array): readonly IndexEntry[] {
  const entries: IndexEntry[] = [];
  let start = 0;
  for (let cursor = 0; cursor <= bytes.byteLength; cursor += 1) {
    if (cursor !== bytes.byteLength && bytes[cursor] !== 0) continue;
    if (cursor === start) {
      start = cursor + 1;
      continue;
    }
    const record = decodeUtf8(bytes.subarray(start, cursor), 'unsafe-index-entry');
    const match = /^([0-7]{6}) [0-9a-f]{40,64} ([0-3])\t(.+)$/s.exec(record);
    if (match === null || match[2] !== '0') {
      reject('unsafe-index-entry', 'Marketplace patch encountered an invalid index entry');
    }
    const path = match[3]!;
    if (path.includes('\0')) {
      reject('unsafe-index-entry', 'Marketplace patch encountered an invalid index path');
    }
    entries.push({ mode: match[1]!, path });
    start = cursor + 1;
  }
  return entries;
}

function touchedPathAndAncestors(path: string): readonly string[] {
  const segments = path.split('/');
  return segments.map((_segment, index) => segments.slice(0, index + 1).join('/'));
}

async function proveIndexAndFilesystem(
  validated: ValidatedMarketplacePatch,
  worktreePath: string,
  runGit: MarketplacePatchGitRunner,
  lstat: MarketplacePatchLstat,
): Promise<void> {
  let listing: Uint8Array;
  try {
    listing = await runGit(
      ['--literal-pathspecs', 'ls-files', '--stage', '-z'],
      {
        cwd: worktreePath,
        timeoutMs: MARKETPLACE_PATCH_GIT_TIMEOUT_MS,
        outputLimitBytes: MARKETPLACE_PATCH_GIT_OUTPUT_LIMIT_BYTES,
      },
    );
  } catch (error) {
    if (error instanceof MarketplacePatchPolicyError) throw error;
    reject('git-inspection-failed', 'Could not inspect the marketplace worktree index', error);
  }
  const indexModes = new Map<string, string>();
  for (const entry of parseIndexEntries(listing)) {
    const foldedPath = entry.path.normalize('NFC').toLowerCase();
    const priorMode = indexModes.get(foldedPath);
    if (
      priorMode === undefined
      || entry.mode === '120000'
      || entry.mode === '160000'
    ) {
      indexModes.set(foldedPath, entry.mode);
    }
  }
  for (const touchedPath of validated.touchedPaths) {
    for (const candidate of touchedPathAndAncestors(touchedPath)) {
      const mode = indexModes.get(candidate.normalize('NFC').toLowerCase());
      if (mode === '120000' || mode === '160000') {
        reject(
          'unsafe-index-entry',
          `Marketplace patch path crosses forbidden index mode ${mode}: ${candidate}`,
        );
      }
      let kind: Awaited<ReturnType<MarketplacePatchLstat>>;
      try {
        kind = await lstat(join(worktreePath, ...candidate.split('/')));
      } catch (error) {
        reject(
          'unsafe-filesystem-entry',
          `Could not inspect marketplace patch path: ${candidate}`,
          error,
        );
      }
      if (kind === 'symlink' || kind === 'other') {
        reject(
          'unsafe-filesystem-entry',
          `Marketplace patch path crosses an unsafe filesystem entry: ${candidate}`,
        );
      }
    }
  }
}

async function runApplyStage(
  runGit: MarketplacePatchGitRunner,
  worktreePath: string,
  artifact: Uint8Array,
  check: boolean,
): Promise<void> {
  try {
    await runGit(
      check ? ['apply', '--check'] : ['apply'],
      {
        cwd: worktreePath,
        stdin: artifact,
        timeoutMs: MARKETPLACE_PATCH_GIT_TIMEOUT_MS,
        outputLimitBytes: MARKETPLACE_PATCH_GIT_OUTPUT_LIMIT_BYTES,
      },
    );
  } catch (error) {
    if (
      error instanceof MarketplacePatchPolicyError
      && (error.reason === 'git-timeout' || error.reason === 'git-output-limit')
    ) {
      throw error;
    }
    reject(
      check ? 'git-check-failed' : 'git-apply-failed',
      check
        ? 'Marketplace patch failed git apply --check'
        : 'Marketplace patch failed git apply',
      error,
    );
  }
}

export async function applyMarketplacePatchToWorktree(
  input: {
    readonly artifact: Uint8Array;
    readonly manifestPath: string;
    readonly worktreePath: string;
    readonly expectedHead: GitOid;
  },
  ports: MarketplacePatchApplicationPorts,
): Promise<ValidatedMarketplacePatch> {
  const validated = validateMarketplacePatch(input.artifact);
  const canonicalArtifact = Uint8Array.from(validated.artifact);
  const authority = await ports.worktreeProof.prove({
    manifestPath: input.manifestPath,
    worktreePath: input.worktreePath,
    expectedHead: input.expectedHead,
  });
  assertExactAuthority(input, authority);

  const runGit = ports.runGit ?? runMarketplacePatchGit;
  const lstat = ports.lstat ?? marketplacePatchLstat;
  await proveIndexAndFilesystem(validated, input.worktreePath, runGit, lstat);
  await runApplyStage(runGit, input.worktreePath, Uint8Array.from(canonicalArtifact), true);
  await runApplyStage(runGit, input.worktreePath, Uint8Array.from(canonicalArtifact), false);
  return { ...validated, artifact: Uint8Array.from(canonicalArtifact) };
}
