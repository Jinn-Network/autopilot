import { randomUUID } from 'node:crypto';
import {
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { REPO } from '../dispatcher/constants.js';
import { loadAutopilotConfig } from '../config/config.js';
import {
  parseOwnedPrefixes,
  touchesCodeOwnedPath,
} from '../dispatcher/code-owned.js';
import type { AttemptManifest } from './attempt-workspace.js';
import {
  advanceAttemptReviewPair,
  readAttemptManifest,
} from './attempt-workspace.js';
import {
  decodeReviewClaimPayload,
  decodeBranchClaimTrailers,
  encodeReviewClaimPayload,
  formatAutomatedReviewMarker,
} from './codecs.js';
import {
  gitPublicationArgs,
  isolatedGitCommandOverlay,
  readAttemptTokenFile,
  sanitizedGitHubCommandOverlay,
} from './credentials.js';
import { makeGitProtocolPort } from './git-protocol.js';
import { readReviewedDiffDigest } from './github-changed-files.js';
import { validateCanonicalGitHubHttpsRemote } from './implementation-executor.js';
import { GhLifecycleReader } from './github-reader.js';
import { ConditionalRestClient } from './github-rest.js';
import { GitHubRestDiscoveryReader } from './github-rest-discovery.js';
import { fileChildIssue } from './child-issues.js';
import { makeProductionChildIssuePort } from './child-issues-production.js';
import { fileReviewFollowUps } from './review-follow-ups.js';
import { makeProductionReviewFollowUpPort } from './review-follow-ups-production.js';
import {
  effectiveNativeReviews,
  isSupersededOwnedNativeRequest,
} from './native-review.js';
import type { ReviewSessionPort } from './review-session.js';
import type { ReviewNativeReview } from './review-executor.js';
import {
  resolveStructuredPullRequestMappings,
  stableBranchMapping,
  type StructuredMappingInput,
  type StructuredMappingPullRequest,
} from './pr-mapping.js';
import {
  gitOid,
  type GitOid,
} from './types.js';
import {
  NEEDS_HUMAN_LABEL,
  hasExternalHumanAuthority,
  hasExternalHumanLabel,
} from './human-authority.js';

export interface ProductionReviewSessionPortOptions {
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly readManifest?: (path: string) => AttemptManifest;
  readonly writeMetadataFile?: (payload: string) => string;
  readonly removeMetadataFile?: (path: string) => void;
  /**
   * Complete dependency/stable-claim authority for the canonical PR mapping
   * resolver. Tests/coordinators may inject a cycle-scoped reader; production
   * otherwise builds the same authority from fresh targeted reads.
   */
  readonly readMappingAuthority?: (input: {
    readonly manifest: AttemptManifest;
    readonly pullRequests: readonly StructuredMappingPullRequest[];
  }) => Promise<Pick<
    StructuredMappingInput,
    'defaultBranch' | 'issues' | 'stableBranches'
  > | null>;
  /**
   * Fresh Project `Blocked on: Human` authority for the manifest issue.
   * This remains readable when the broader mapping graph is unavailable.
   * `null` means the external Human boundary could not be read completely.
   */
  readonly readProjectHumanAuthority?: (input: {
    readonly manifest: AttemptManifest;
  }) => Promise<boolean | null>;
  /** Fresh native issue Human-label authority for the manifest issue. */
  readonly readNativeIssueHumanAuthority?: (input: {
    readonly manifest: AttemptManifest;
  }) => Promise<boolean | null>;
}

export function makeProductionReviewSessionPort(
  options: ProductionReviewSessionPortOptions = {},
): ReviewSessionPort {
  const runner = options.runner ?? defaultRunner;
  const ambient = options.environment ?? process.env;
  const readManifest = options.readManifest ?? readAttemptManifest;
  const manifestPath = ambient.JINN_AUTOPILOT_SESSION_MANIFEST;
  const currentManifest = (): AttemptManifest => {
    if (manifestPath === undefined || manifestPath.length === 0) {
      throw new Error('Review session manifest path is unavailable');
    }
    return readManifest(manifestPath);
  };
  // Resolution order (#1883): ambient `GH_TOKEN` first, else the
  // attempt-scoped token file located through the (non-secret-shaped)
  // manifest path — see implementation-session-production.ts for the full
  // rationale. Only once neither resolves does this fail closed.
  const token = ((): string => {
    if (ambient.GH_TOKEN !== undefined && ambient.GH_TOKEN.length > 0) {
      return ambient.GH_TOKEN;
    }
    if (manifestPath !== undefined && manifestPath.length > 0) {
      try {
        const fromFile = readAttemptTokenFile(readManifest(manifestPath).paths.tokenFile);
        if (fromFile !== undefined) return fromFile;
      } catch {
        // Fall through to the closed failure below.
      }
    }
    throw new Error('Review session requires its selected GH_TOKEN');
  })();
  const environmentFor = (
    manifest: AttemptManifest,
    extra: Record<string, string> = {},
  ): Record<string, string> => ({
    ...sanitizedGitHubCommandOverlay(ambient, { GH_TOKEN: token }),
    ...isolatedGitCommandOverlay(ambient, manifest.paths.askpass),
    GH_CONFIG_DIR: manifest.paths.ghConfigDir,
    ...extra,
  });
  const run = (
    manifest: AttemptManifest,
    command: string,
    args: string[],
    extra: Record<string, string> = {},
  ): Promise<string> => runner(command, args, {
    env: environmentFor(manifest, extra),
  });
  const runGit = (
    manifest: AttemptManifest,
    args: readonly string[],
    extra: Record<string, string> = {},
  ): Promise<string> => run(manifest, 'git', [
    ...gitPublicationArgs(manifest.paths.askpass, []),
    '-C', manifest.paths.worktree,
    ...args,
  ], extra);
  const secureGitRunner = (manifest: AttemptManifest) =>
    (_command: 'git', args: readonly string[]) => runGit(manifest, args);
  const defaultProjectHumanAuthority = async (
    manifest: AttemptManifest,
  ): Promise<boolean | null> => {
    try {
      const loaded = await loadAutopilotConfig(manifest.repository.root, ambient);
      const sessionRunner: CommandRunner = (command, args, commandOptions) => {
        const extra = Object.fromEntries(
          Object.entries(commandOptions?.env ?? {})
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        );
        return run(manifest, command, [...args], extra);
      };
      const reader = new GhLifecycleReader(sessionRunner, {
        repositoryPath: manifest.repository.root,
        remoteName: loaded.config.repository.remote.url,
        repositorySlug: loaded.config.repository.slug,
        projectOwner: loaded.config.project.owner,
        projectNumber: loaded.config.project.number,
      });
      const project = await reader.readProjectItemForReconciliation(
        manifest.issueNumber,
      );
      return project === null ? null : project.blockedOn === 'Human';
    } catch {
      return null;
    }
  };
  const defaultNativeIssueHumanAuthority = async (
    manifest: AttemptManifest,
  ): Promise<boolean | null> => {
    try {
      const value = JSON.parse(await run(manifest, 'gh', [
        'issue', 'view', String(manifest.issueNumber),
        '--repo', REPO,
        '--json', 'number,state,labels',
      ])) as {
        readonly number?: unknown;
        readonly state?: unknown;
        readonly labels?: unknown;
      };
      if (
        value.number !== manifest.issueNumber
        || !['OPEN', 'CLOSED'].includes(String(value.state))
        || !Array.isArray(value.labels)
      ) return null;
      const labels = value.labels.map((label) => (
        typeof label === 'object' && label !== null
          ? (label as { readonly name?: unknown }).name
          : undefined
      ));
      if (labels.some((label) => typeof label !== 'string')) return null;
      return hasExternalHumanLabel(labels as string[]);
    } catch {
      return null;
    }
  };
  const defaultMappingAuthority = async (
    manifest: AttemptManifest,
    pullRequests: readonly StructuredMappingPullRequest[],
  ): Promise<Pick<
    StructuredMappingInput,
    'defaultBranch' | 'issues' | 'stableBranches'
  > | null> => {
    try {
      const loaded = await loadAutopilotConfig(manifest.repository.root, ambient);
      const sessionRunner: CommandRunner = (command, args, commandOptions) => {
        const extra = Object.fromEntries(
          Object.entries(commandOptions?.env ?? {})
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        );
        return run(manifest, command, [...args], extra);
      };
      const reader = new GhLifecycleReader(sessionRunner, {
        repositoryPath: manifest.repository.root,
        remoteName: loaded.config.repository.remote.url,
        repositorySlug: loaded.config.repository.slug,
        projectOwner: loaded.config.project.owner,
        projectNumber: loaded.config.project.number,
      });
      const discovery = new GitHubRestDiscoveryReader(
        new ConditionalRestClient(sessionRunner),
        {
          repositorySlug: loaded.config.repository.slug,
          repositoryRestDatabaseId: loaded.config.repository.restDatabaseId,
          projectOwner: loaded.config.project.owner,
          projectNumber: loaded.config.project.number,
        },
      );
      const issueNumbers = new Set<number>([manifest.issueNumber]);
      const addStableNumber = (ref: string): void => {
        const match = /^autopilot\/([1-9][0-9]*)$/.exec(ref);
        if (match?.[1] !== undefined) issueNumbers.add(Number(match[1]));
      };
      for (const pullRequest of pullRequests) {
        for (const number of pullRequest.closingIssueNumbers) issueNumbers.add(number);
        addStableNumber(pullRequest.headRefName);
        addStableNumber(pullRequest.baseRefName);
        for (const match of pullRequest.body.matchAll(
          /<!-- jinn-autopilot:v2 issue=([1-9][0-9]*) branch=[^ >]+ -->/g,
        )) {
          issueNumbers.add(Number(match[1]));
        }
      }

      const issues: StructuredMappingInput['issues'][number][] = [];
      const pending = [...issueNumbers];
      const read = new Set<number>();
      while (pending.length > 0) {
        const issueNumber = pending.shift()!;
        if (read.has(issueNumber)) continue;
        read.add(issueNumber);
        if (read.size > 1_000) return null;
        const [project, blockedByIssues] = await Promise.all([
          reader.readProjectItemForReconciliation(issueNumber),
          discovery.readBlockedByIssueNumbersForAction(issueNumber),
        ]);
        if (project === null) return null;
        issues.push({
          number: issueNumber,
          blockedOn: project.blockedOn,
          blockedByIssues,
        });
        for (const dependency of blockedByIssues) {
          if (!read.has(dependency)) pending.push(dependency);
        }
      }

      const stableBranches: StructuredMappingInput['stableBranches'][number][] = [];
      for (const issue of issues) {
        const raw = await reader.readBranchClaimForReconciliation(
          `autopilot/${issue.number}`,
        );
        if (raw === null) continue;
        const claim = decodeBranchClaimTrailers(raw.claimTrailers);
        if (claim.issueNumber !== issue.number) return null;
        stableBranches.push(stableBranchMapping({
          issueNumber: issue.number,
          headRefName: raw.headRefName,
          headOid: gitOid(raw.headOid),
          claim,
        }));
      }
      return {
        defaultBranch: loaded.config.repository.defaultBranch,
        issues,
        stableBranches,
      };
    } catch {
      return null;
    }
  };
  const validateIdentity = async (manifest: AttemptManifest): Promise<void> => {
    const login = (await run(manifest, 'gh', ['api', 'user', '--jq', '.login'])).trim();
    if (login.toLowerCase() !== manifest.selectedLogin.toLowerCase()) {
      throw new Error('Review session credential no longer matches the manifest identity');
    }
  };
  const validateRemote = async (manifest: AttemptManifest): Promise<void> => {
    const remote = (await runGit(manifest, [
      'remote', 'get-url', manifest.repository.remoteName,
    ])).trim();
    validateCanonicalGitHubHttpsRemote(remote);
  };
  const exactRemoteOid = (raw: string, ref: string): GitOid => {
    const lines = raw.trimEnd().split('\n').filter((line) => line.endsWith(`\t${ref}`));
    if (lines.length !== 1) throw new Error('Remote review ref readback is ambiguous');
    const [oid, observed, extra] = lines[0]!.split('\t');
    if (oid === undefined || observed !== ref || extra !== undefined) {
      throw new Error('Malformed remote review ref readback');
    }
    return gitOid(oid);
  };
  const parsePullRequest = (raw: string) => {
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('Malformed review PR readback');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Malformed review PR readback');
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.number !== 'number'
      || typeof record.state !== 'string'
      || typeof record.headRefOid !== 'string'
      || typeof record.headRefName !== 'string'
      || typeof record.baseRefName !== 'string'
      || typeof record.baseRefOid !== 'string'
      || typeof record.isDraft !== 'boolean'
      || typeof record.body !== 'string'
      || typeof record.author !== 'object'
      || record.author === null
      || !Array.isArray(record.labels)
      || !Array.isArray(record.closingIssuesReferences)
      || !Array.isArray(record.files)
    ) {
      throw new Error('Malformed review PR readback');
    }
    const author = (record.author as { login?: unknown }).login;
    if (typeof author !== 'string') throw new Error('Malformed review PR author');
    const labels = record.labels.map((label) => {
      const name = typeof label === 'object' && label !== null
        ? (label as { name?: unknown }).name
        : undefined;
      if (typeof name !== 'string') throw new Error('Malformed review PR labels');
      return name;
    });
    const closingIssueNumbers = record.closingIssuesReferences.map((issue) => {
      const number = typeof issue === 'object' && issue !== null
        ? (issue as { number?: unknown }).number
        : undefined;
      if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
        throw new Error('Malformed review PR closing issues');
      }
      return number;
    });
    const files = record.files.map((file) => {
      const path = typeof file === 'object' && file !== null
        ? (file as { path?: unknown }).path
        : undefined;
      if (typeof path !== 'string' || path.length === 0) {
        throw new Error('Malformed review PR files');
      }
      return path;
    });
    if (!['OPEN', 'CLOSED', 'MERGED'].includes(record.state)) {
      throw new Error('Malformed review PR state');
    }
    return {
      number: record.number,
      head: gitOid(record.headRefOid),
      base: gitOid(record.baseRefOid),
      headRefName: record.headRefName,
      baseRefName: record.baseRefName,
      open: record.state === 'OPEN',
      draft: record.isDraft,
      author,
      labels,
      body: record.body,
      closingIssueNumbers,
      files,
    };
  };
  const parseOpenPullRequests = (raw: string): Array<{
    readonly number: number;
    readonly head: GitOid;
    readonly branch: string;
    readonly baseRefName: string;
    readonly body: string;
    readonly closingIssueNumbers: readonly number[];
  }> => {
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('Malformed open review PR mapping readback');
    }
    if (!Array.isArray(value)) throw new Error('Malformed open review PR mapping readback');
    return value.map((entry) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error('Malformed open review PR mapping readback');
      }
      const record = entry as Record<string, unknown>;
      if (
        typeof record.number !== 'number'
        || !Number.isSafeInteger(record.number)
        || record.number <= 0
        || typeof record.headRefOid !== 'string'
        || typeof record.headRefName !== 'string'
        || typeof record.baseRefName !== 'string'
        || typeof record.body !== 'string'
        || !Array.isArray(record.closingIssuesReferences)
      ) {
        throw new Error('Malformed open review PR mapping readback');
      }
      const closingIssueNumbers = record.closingIssuesReferences.map((issue) => {
        const number = typeof issue === 'object' && issue !== null
          ? (issue as { number?: unknown }).number
          : undefined;
        if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
          throw new Error('Malformed open review PR mapping readback');
        }
        return number;
      });
      return {
        number: record.number,
        head: gitOid(record.headRefOid),
        branch: record.headRefName,
        baseRefName: record.baseRefName,
        body: record.body,
        closingIssueNumbers,
      };
    });
  };
  const readPullRequest = async (
    manifest: AttemptManifest,
    prNumber: number,
  ) => {
    const pullRequest = parsePullRequest(await run(manifest, 'gh', [
      'pr', 'view', String(prNumber),
      '--repo', REPO,
      '--json',
      'number,state,headRefName,baseRefName,headRefOid,baseRefOid,isDraft,labels,body,author,closingIssuesReferences,files',
    ]));
    const openPullRequests = parseOpenPullRequests(await run(manifest, 'gh', [
      'pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '1000',
      '--json', 'number,headRefName,baseRefName,headRefOid,body,closingIssuesReferences',
    ]));
    const listedTarget = openPullRequests.filter(
      (candidate) => candidate.number === pullRequest.number,
    );
    const duplicateNumbers = new Set<number>();
    const seenNumbers = new Set<number>();
    for (const candidate of openPullRequests) {
      if (seenNumbers.has(candidate.number)) duplicateNumbers.add(candidate.number);
      seenNumbers.add(candidate.number);
    }
    const targetListConsistent = listedTarget.length === 1
      && listedTarget[0]!.head === pullRequest.head
      && listedTarget[0]!.branch === pullRequest.headRefName
      && listedTarget[0]!.baseRefName === pullRequest.baseRefName
      && listedTarget[0]!.body === pullRequest.body
      && JSON.stringify(listedTarget[0]!.closingIssueNumbers)
        === JSON.stringify(pullRequest.closingIssueNumbers);
    const mappingPullRequests: StructuredMappingPullRequest[] =
      openPullRequests.map((candidate) => ({
        number: candidate.number,
        state: 'OPEN',
        head: candidate.number === pullRequest.number
          ? pullRequest.head
          : candidate.head,
        headRefName: candidate.number === pullRequest.number
          ? pullRequest.headRefName
          : candidate.branch,
        baseRefName: candidate.number === pullRequest.number
          ? pullRequest.baseRefName
          : candidate.baseRefName,
        closingIssueNumbers: candidate.number === pullRequest.number
          ? pullRequest.closingIssueNumbers
          : candidate.closingIssueNumbers,
        body: candidate.number === pullRequest.number
          ? pullRequest.body
          : candidate.body,
      }));
    let mappingProblem: string | undefined;
    let issueNumber = manifest.issueNumber;
    let mappingAuthority: Pick<
      StructuredMappingInput,
      'defaultBranch' | 'issues' | 'stableBranches'
    > | null = null;
    if (
      openPullRequests.length >= 1_000
      || duplicateNumbers.size > 0
      || !targetListConsistent
      || pullRequest.number !== prNumber
      || pullRequest.number !== manifest.prNumber
      || !pullRequest.open
    ) {
      mappingProblem =
        'Complete open pull-request mapping authority is unavailable or inconsistent.';
    } else {
      try {
        mappingAuthority = options.readMappingAuthority === undefined
          ? await defaultMappingAuthority(manifest, mappingPullRequests)
          : await options.readMappingAuthority({
              manifest,
              pullRequests: mappingPullRequests,
            });
      } catch {
        mappingAuthority = null;
      }
      if (mappingAuthority === null) {
        mappingProblem =
          'Complete dependency and stable-branch mapping authority is unavailable.';
      } else {
        const resolution = resolveStructuredPullRequestMappings({
          ...mappingAuthority,
          pullRequests: mappingPullRequests,
        }).find((candidate) => candidate.prNumber === pullRequest.number);
        if (resolution === undefined) {
          mappingProblem = 'Canonical pull-request mapping authority is absent.';
        } else if (resolution.status === 'ambiguous') {
          mappingProblem = resolution.details.join(' ');
        } else {
          issueNumber = resolution.issueNumber;
          if (
            resolution.issueNumber !== manifest.issueNumber
            || resolution.expectedBaseRefName !== pullRequest.baseRefName
            || resolution.expectedBaseRefName !== manifest.targetBase
            || pullRequest.head !== manifest.expectedHead
            || pullRequest.headRefName !== manifest.branch
          ) {
            mappingProblem =
              'Canonical pull-request mapping changed from the manifest authority.';
          }
        }
      }
    }
    const externalHumanLabel = hasExternalHumanLabel(pullRequest.labels);
    let projectHumanAuthority: boolean | null | undefined;
    let nativeIssueHumanAuthority: boolean | null | undefined;
    if (!externalHumanLabel) {
      try {
        [projectHumanAuthority, nativeIssueHumanAuthority] = await Promise.all([
          options.readProjectHumanAuthority === undefined
            ? defaultProjectHumanAuthority(manifest)
            : options.readProjectHumanAuthority({ manifest }),
          options.readNativeIssueHumanAuthority === undefined
            ? defaultNativeIssueHumanAuthority(manifest)
            : options.readNativeIssueHumanAuthority({ manifest }),
        ]);
      } catch {
        projectHumanAuthority = null;
        nativeIssueHumanAuthority = null;
      }
      if (
        projectHumanAuthority === null
        || nativeIssueHumanAuthority === null
      ) {
        throw new Error(
          'Complete external Human authority is unavailable or inconsistent.',
        );
      }
    }
    const treePaths = (await runGit(manifest, [
      'ls-tree', '-r', '--name-only', pullRequest.base,
    ])).trim().split('\n').filter(Boolean);
    const codeownersPath = [
      '.github/CODEOWNERS',
      'CODEOWNERS',
      'docs/CODEOWNERS',
    ].find((path) => treePaths.includes(path));
    const codeownersText = codeownersPath === undefined
      ? ''
      : await runGit(manifest, ['show', `${pullRequest.base}:${codeownersPath}`]);
    const approvalPolicy = touchesCodeOwnedPath(
      [...pullRequest.files],
      parseOwnedPrefixes(codeownersText),
    )
      ? 'human-codeowner' as const
      : 'approve-eligible' as const;
    return {
      number: pullRequest.number,
      issueNumber,
      open: pullRequest.open,
      head: pullRequest.head,
      headRefName: pullRequest.headRefName,
      baseRefName: pullRequest.baseRefName,
      draft: pullRequest.draft,
      author: pullRequest.author,
      labels: pullRequest.labels,
      body: pullRequest.body,
      approvalPolicy,
      humanHold: externalHumanLabel || hasExternalHumanAuthority({
        nativeIssueLabels: nativeIssueHumanAuthority === true
          ? [NEEDS_HUMAN_LABEL]
          : [],
        projectBlockedOn: projectHumanAuthority === true ? 'Human' : null,
      }),
      ...(mappingProblem === undefined ? {} : { mappingProblem }),
    };
  };
  const requireHead = async (
    manifest: AttemptManifest,
    prNumber: number,
    expectedHead: GitOid,
  ) => {
    const pullRequest = await readPullRequest(manifest, prNumber);
    if (pullRequest.head !== expectedHead) throw new Error('Review PR head changed');
    return pullRequest;
  };
  const defaultWriteMetadata = (payload: string): string => {
    const path = join(
      currentManifest().paths.attemptDir,
      `.review-metadata-${process.pid}-${randomUUID()}.json`,
    );
    writeFileSync(path, `${payload}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return path;
  };
  const writeMetadata = options.writeMetadataFile ?? defaultWriteMetadata;
  const removeMetadata = options.removeMetadataFile ?? ((path: string) => rmSync(path, {
    force: true,
  }));
  const readCommentBodies = async (
    manifest: AttemptManifest,
    prNumber: number,
  ): Promise<readonly string[]> => {
    const raw = await run(manifest, 'gh', [
      'api', `repos/${REPO}/issues/${prNumber}/comments`,
      '--paginate', '--slurp',
    ]);
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('Malformed review Human comment readback');
    }
    if (!Array.isArray(value)) throw new Error('Malformed review Human comment readback');
    const comments = value.every((entry) => Array.isArray(entry))
      ? value.flat()
      : value;
    return comments.map((comment) => {
      const body = typeof comment === 'object' && comment !== null
        ? (comment as { body?: unknown }).body
        : undefined;
      if (typeof body !== 'string') {
        throw new Error('Malformed review Human comment readback');
      }
      return body;
    });
  };
  const readAuthority = async (manifest: AttemptManifest) => {
    await validateRemote(manifest);
    await validateIdentity(manifest);
    const ref = `refs/jinn-autopilot/review-claims/v1/${manifest.prNumber}`;
    const oid = exactRemoteOid(
      await runGit(manifest, [
        'ls-remote', manifest.repository.remoteName, ref,
      ]),
      ref,
    );
    await runGit(manifest, [
      'fetch', '--quiet', manifest.repository.remoteName, ref,
    ]);
    const payload = await runGit(manifest, [
      'show', `${oid}:jinn-autopilot-review.json`,
    ]);
    return { reviewRefOid: oid, record: decodeReviewClaimPayload(payload.trim()) };
  };
  const readNativeReviews = async (
    manifest: AttemptManifest,
    prNumber: number,
    expectedHead: GitOid,
  ): Promise<readonly ReviewNativeReview[]> => {
    await requireHead(manifest, prNumber, expectedHead);
    const raw = await run(manifest, 'gh', [
      'api', `repos/${REPO}/pulls/${prNumber}/reviews`,
      '--paginate', '--slurp',
    ]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('Malformed native review readback');
    }
    if (
      !Array.isArray(parsed)
      || !parsed.every((page) => Array.isArray(page))
    ) {
      throw new Error('Malformed native review readback');
    }
    return parsed.flat().map((value) => {
      if (typeof value !== 'object' || value === null) {
        throw new Error('Malformed native review readback');
      }
      const review = value as Record<string, unknown>;
      const user = review.user as { login?: unknown } | undefined;
      if (
        typeof user?.login !== 'string'
        || typeof review.state !== 'string'
        || typeof review.commit_id !== 'string'
        || typeof review.body !== 'string'
        || typeof review.submitted_at !== 'string'
      ) {
        throw new Error('Malformed native review readback');
      }
      if (![
        'APPROVED',
        'CHANGES_REQUESTED',
        'COMMENTED',
        'DISMISSED',
        'PENDING',
      ].includes(review.state)) {
        throw new Error('Malformed native review state');
      }
      return {
        reviewer: user.login,
        state: review.state as 'APPROVED' | 'CHANGES_REQUESTED'
          | 'COMMENTED' | 'DISMISSED' | 'PENDING',
        commitId: gitOid(review.commit_id),
        body: review.body,
        submittedAt: review.submitted_at,
      };
    });
  };
  const effectiveNativeBlocker = (
    reviews: readonly ReviewNativeReview[],
    manifest: AttemptManifest,
    head: GitOid,
  ): ReviewNativeReview | undefined => {
    return effectiveNativeReviews(reviews).find((review) => {
      if (review.state !== 'CHANGES_REQUESTED') return false;
      return !isSupersededOwnedNativeRequest(review, manifest.selectedLogin, head);
    });
  };
  const requireReadyBoundary = async (
    manifest: AttemptManifest,
    prNumber: number,
    expectedHead: GitOid,
  ): Promise<void> => {
    const authority = await readAuthority(manifest);
    const record = authority.record;
    if (
      authority.reviewRefOid !== manifest.reviewRefOid
      || record.state !== 'terminal-approved'
      || record.prNumber !== prNumber
      || record.generation !== manifest.reviewGeneration
      || record.attempt !== manifest.attemptId
      || record.reviewer.toLowerCase() !== manifest.selectedLogin.toLowerCase()
      || record.head !== expectedHead
    ) {
      throw new Error('Review ready boundary lost exact terminal authority');
    }
    const pullRequest = await requireHead(manifest, prNumber, expectedHead);
    if (pullRequest.humanHold === true) {
      throw new Error('Review ready boundary stopped because Human is dominant');
    }
    const reviews = await readNativeReviews(manifest, prNumber, expectedHead);
    const selectedReview = effectiveNativeReviews(reviews).find(
      (review) => review.reviewer.toLowerCase() === manifest.selectedLogin.toLowerCase(),
    );
    const approvalMarker = formatAutomatedReviewMarker({
      generation: record.generation,
      attempt: record.attempt,
      intent: record.verdict.marker,
      reviewer: record.reviewer,
      head: expectedHead,
      verdict: 'APPROVE',
    });
    if (
      selectedReview?.state !== 'APPROVED'
      || selectedReview.commitId !== expectedHead
      || !selectedReview.body.includes(approvalMarker)
    ) {
      throw new Error('Review ready boundary lost exact current-head approval');
    }
    const blocker = effectiveNativeBlocker(
      reviews,
      manifest,
      expectedHead,
    );
    if (blocker !== undefined) {
      throw new Error(
        `Native requested changes by ${blocker.reviewer} block automated approval`,
      );
    }
  };
  const mutateWithExactReadback = async (
    mutate: () => Promise<unknown>,
    confirmed: () => Promise<boolean>,
    ambiguityMessage: string,
  ): Promise<void> => {
    let mutationError: unknown;
    try {
      await mutate();
    } catch (error) {
      mutationError = error;
    }
    let exact = false;
    try {
      exact = await confirmed();
    } catch (readbackError) {
      if (mutationError !== undefined) throw mutationError;
      throw readbackError;
    }
    if (exact) return;
    if (mutationError !== undefined) throw mutationError;
    throw new Error(ambiguityMessage);
  };

  return {
    readManifest: options.readManifest ?? readAttemptManifest,

    readAuthority,

    async readPullRequest(prNumber, expectedHead) {
      return requireHead(currentManifest(), prNumber, expectedHead);
    },

    async readNativeReviews(prNumber, expectedHead) {
      return readNativeReviews(currentManifest(), prNumber, expectedHead);
    },

    /**
     * Identity of the diff being reviewed, recorded on the claim so that a
     * later `update-branch` head can be proven to present the same diff.
     *
     * `readReviewedDiffDigest` never throws; an unprovable digest comes back as
     * `unavailable` and is recorded as nothing at all, leaving the merge gate's
     * exact-head requirement in place. The result is returned whole rather than
     * narrowed to `string | undefined`: the reason is the only thing that lets
     * an operator distinguish a fail-closed carry from a broken one, and
     * discarding it here was one half of why this feature ran dead unnoticed.
     */
    async readReviewedDiffDigest(prNumber, expectedHead) {
      const manifest = currentManifest();
      return readReviewedDiffDigest({
        run: (command, args) => run(manifest, command, args),
        prNumber,
        expectedHead,
        expectedBaseRefName: manifest.targetBase,
        context: 'Review',
      });
    },

    async hasHumanHold(_issueNumber, prNumber, expectedHead) {
      const manifest = currentManifest();
      const pullRequest = await requireHead(manifest, prNumber, expectedHead);
      return pullRequest.humanHold === true;
    },

    async createReviewRecord({ manifest, parent, record }) {
      const payloadPath = writeMetadata(encodeReviewClaimPayload(record));
      const indexPath = join(
        manifest.paths.attemptDir,
        `.review-index-${process.pid}-${randomUUID()}`,
      );
      try {
        const extra = { GIT_INDEX_FILE: indexPath };
        await runGit(manifest, ['read-tree', '--empty'], extra);
        const blob = gitOid((await runGit(manifest, [
          'hash-object', '-w', payloadPath,
        ], extra)).trim());
        await runGit(manifest, [
          'update-index', '--add',
          '--cacheinfo', `100644,${blob},jinn-autopilot-review.json`,
        ], extra);
        const tree = gitOid((await runGit(manifest, ['write-tree'], extra)).trim());
        return gitOid((await runGit(manifest, [
          'commit-tree', tree,
          '-p', parent,
          '-m', `Autopilot review metadata: ${record.state}`,
        ], extra)).trim());
      } finally {
        removeMetadata(payloadPath);
        rmSync(indexPath, { force: true });
      }
    },

    async publishReviewClaim({
      manifest,
      recordParent,
      expectedRemoteRecordOid,
      recordOid,
    }) {
      await validateRemote(manifest);
      await validateIdentity(manifest);
      const outcome = await makeGitProtocolPort(
        secureGitRunner(manifest),
        { remote: manifest.repository.remoteName },
      ).publishReviewClaim({
        prNumber: manifest.prNumber!,
        recordParent,
        expectedRemoteRecordOid,
        recordOid,
      });
      if (
        (outcome.status === 'won' || outcome.status === 'already-applied')
        && outcome.observed === recordOid
      ) {
        advanceAttemptReviewPair(
          manifest.paths.manifest,
          manifest.expectedHead,
          manifest.reviewRefOid!,
          manifest.expectedHead,
          recordOid,
          options.now,
        );
      }
      return outcome;
    },

    async submitNativeReview({ manifest, prNumber, commitId, reviewer, state, body }) {
      await validateIdentity(manifest);
      if (reviewer.toLowerCase() !== manifest.selectedLogin.toLowerCase()) {
        throw new Error('Native review reviewer differs from selected identity');
      }
      await requireHead(manifest, prNumber, commitId);
      await run(manifest, 'gh', [
        'api', '--method', 'POST',
        `repos/${REPO}/pulls/${prNumber}/reviews`,
        '-f', `commit_id=${commitId}`,
        '-f', `event=${state}`,
        '-f', `body=${body}`,
      ]);
    },

    async setPullRequestLabel(prNumber, expectedHead, label, present) {
      const manifest = currentManifest();
      const before = await requireHead(manifest, prNumber, expectedHead);
      if (before.labels.includes(label) === present) return;
      await mutateWithExactReadback(
        () => run(manifest, 'gh', [
          'pr', 'edit', String(prNumber), '--repo', REPO,
          present ? '--add-label' : '--remove-label', label,
        ]),
        async () => (
          await requireHead(manifest, prNumber, expectedHead)
        ).labels.includes(label) === present,
        'Review label mutation was ambiguous',
      );
    },


    async setPullRequestDraft(prNumber, expectedHead, draft) {
      const manifest = currentManifest();
      const before = await requireHead(manifest, prNumber, expectedHead);
      if (before.draft === draft) return;
      if (!draft) {
        await requireReadyBoundary(manifest, prNumber, expectedHead);
      }
      await mutateWithExactReadback(
        () => run(manifest, 'gh', [
          'pr', 'ready', String(prNumber), '--repo', REPO,
          ...(draft ? ['--undo'] : []),
        ]),
        async () => (
          await requireHead(manifest, prNumber, expectedHead)
        ).draft === draft,
        'Review draft mutation was ambiguous',
      );
    },

    async hasHumanComment(
      prNumber,
      expectedHead,
      expectedReviewRefOid,
      expectedGeneration,
      expectedReviewState,
      body,
    ) {
      const manifest = currentManifest();
      await requireHead(manifest, prNumber, expectedHead);
      const authority = await readAuthority(manifest);
      if (
        authority.reviewRefOid !== expectedReviewRefOid
        || authority.record.head !== expectedHead
        || authority.record.generation !== expectedGeneration
        || authority.record.state !== expectedReviewState
      ) {
        throw new Error('Review Human comment lost exact review-ref authority');
      }
      return (await readCommentBodies(manifest, prNumber)).includes(body);
    },

    async ensureHumanComment(
      prNumber,
      expectedHead,
      expectedReviewRefOid,
      expectedGeneration,
      expectedReviewState,
      marker,
      body,
    ) {
      const manifest = currentManifest();
      if (!body.includes(marker)) {
        throw new Error('Review Human comment body is missing its exact marker');
      }
      const requireExactAuthority = async (): Promise<void> => {
        await requireHead(manifest, prNumber, expectedHead);
        const authority = await readAuthority(manifest);
        if (
          authority.reviewRefOid !== expectedReviewRefOid
          || authority.record.head !== expectedHead
          || authority.record.generation !== expectedGeneration
          || authority.record.state !== expectedReviewState
        ) {
          throw new Error('Review Human comment lost exact review-ref authority');
        }
      };
      await requireExactAuthority();
      await mutateWithExactReadback(
        () => run(manifest, 'gh', [
          'pr', 'comment', String(prNumber), '--repo', REPO, '--body', body,
        ]),
        async () => {
          await requireExactAuthority();
          return (await readCommentBodies(manifest, prNumber)).includes(body);
        },
        'Review Human comment was ambiguous',
      );
    },

    async fileFindingChild(input) {
      const manifest = currentManifest();
      const port = makeProductionChildIssuePort({
        runner: (command, args) => run(manifest, command, args),
      });
      const filed = await fileChildIssue(port, {
        parentPr: input.parentPr,
        kind: 'review-finding',
        title: input.title,
        body: input.body,
        effort: input.effort,
        priority: 'p1',
        ...(input.parentBase === undefined ? {} : { parentBase: input.parentBase }),
      });
      // Return the hold arm the port contract declares — review-session's
      // pure logic turns it into enterHuman (§6.3). Throwing here escaped
      // fileFindingChild and burned the attempt with no hold recorded.
      if ('runawayHold' in filed && filed.runawayHold) {
        return { runawayHold: true, priorCount: filed.priorCount };
      }
      return { number: filed.number, created: filed.created };
    },

    async fileReviewFollowUps(input) {
      const manifest = currentManifest();
      const port = makeProductionReviewFollowUpPort({
        runner: (command, args) => run(manifest, command, args),
      });
      return fileReviewFollowUps(port, {
        parentPr: input.parentPr,
        head: String(input.head),
        entries: input.entries,
      });
    },

    nextMarker: randomUUID,
    now: options.now ?? (() => new Date()),
  };
}
