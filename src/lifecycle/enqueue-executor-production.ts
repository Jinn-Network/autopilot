import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { parseOwnedPrefixes, touchesCodeOwnedPath } from '../dispatcher/code-owned.js';
import { REPO } from '../dispatcher/constants.js';
import { formatAutomatedReviewMarker } from './codecs.js';
import type { SelectedCredential } from './credentials.js';
import { fileChildIssue } from './child-issues.js';
import { makeProductionChildIssuePort } from './child-issues-production.js';
import type {
  EnqueueCandidate,
  EnqueueExecutorDeps,
  ExactEnqueueOutcome,
} from './enqueue-executor.js';
import { emptyTreeOid } from './ci-rerun.js';
import {
  decideReEnqueue,
  decodeEnqueueRecord,
  encodeEnqueueRecord,
  enqueueRef,
  type EnqueueRecord,
} from './enqueue-record.js';
import { CANONICAL_GITHUB_HTTPS_REMOTE } from './implementation-executor.js';
import { gitPublicationArgs } from './credentials.js';
import { readExactChangedFiles } from './github-changed-files.js';
import { reviewedDiffDigestFromCompare } from './reviewed-diff-digest.js';
import { withSelectedCredential } from './production-auth.js';
import type {
  GitHubLifecycleSnapshot,
  NativeReviewSnapshot,
  PullRequestSnapshot,
} from './snapshot.js';
import { decodeCompareStatus, gitOid, gitRefName, type GitOid } from './types.js';
import type { ProjectMapping } from '../config/config.js';
import { hasExternalHumanAuthority } from './human-authority.js';

export interface ProductionEnqueueActionPortOptions {
  readonly readSnapshot: () => Promise<GitHubLifecycleSnapshot>;
  readonly authorAllowlist: ReadonlySet<string>;
  readonly expectedBaseRefName?: string;
  /**
   * The repository's protected integration branch, the only branch a merge
   * queue is configured on. Supplied, it refuses a stacked pull request before
   * any mutation; absent, the gate simply does not assert anything about the
   * base beyond the canonical mapping match.
   */
  readonly defaultBranch?: string;
  readonly repositorySlug?: string;
  readonly projectOwner?: string;
  readonly projectNumber?: number;
  readonly projectMapping?: ProjectMapping;
  /** Issue-type node id for `fix`, used when the flake hold files its child. */
  readonly fixIssueTypeId?: string;
  /**
   * Logins the repository's CODEOWNERS policy names. Empty (the default) proves
   * nobody is an owner, so every codeowner-sensitive change refuses — exactly
   * what the unconditional `codeowner-sensitive` refusal did before, kept as
   * the fail-safe default rather than an accident of configuration.
   */
  readonly codeOwnerLogins?: ReadonlySet<string>;
  /**
   * Local clone the enqueue-attempt CAS records are pushed from. Absent means
   * no record can be read or written, so the flake policy cannot hold a head
   * back — it degrades to "always allow", never to "always refuse".
   */
  readonly repositoryPath?: string;
  readonly repositoryUrl?: string;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? `${error.message}\n${String((error as { stderr?: unknown }).stderr ?? '')}`
    : String(error);
}

export const ENQUEUE_MUTATION = `mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) {
  enqueuePullRequest(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid }) {
    mergeQueueEntry { position state }
  }
}`;

/**
 * How an `enqueuePullRequest` failure should be read. Classified once, here, at
 * the only place that can still see the raw error text.
 *
 * `already-enqueued` and `changed-head` are *answers*, not failures: GitHub is
 * saying the queue already holds this PR, or that the head we pinned is no
 * longer the head. `rejected` is durable — the queue keeps refusing until a
 * human changes something. `undetermined` covers everything a retry could still
 * resolve, and is the only class that earns a queue readback.
 *
 * Ordering is load-bearing: GitHub serves *secondary* rate limits as HTTP 403,
 * so the throttle probe must run before the permission probe, or every throttle
 * would be reported as a durable branch-protection refusal.
 *
 * Anything unrecognised is `undetermined`, never `rejected`: asserting a durable
 * refusal we cannot see would strand a PR that only needed a retry.
 */
export type EnqueueFailureClass =
  | 'already-enqueued'
  | 'changed-head'
  | 'rejected'
  | 'undetermined';

export function classifyEnqueueFailure(text: string): EnqueueFailureClass {
  if (/already\s+(?:queued|in\s+(?:the\s+)?merge\s+queue|enqueued)/i.test(text)
    || /\bis\s+in\s+the\s+merge\s+queue\b/i.test(text)) {
    return 'already-enqueued';
  }
  if (/expected\s*head\s*oid/i.test(text)
    || /head\s+sha\s+did\s+not\s+match/i.test(text)
    || /head\s+(?:oid|sha)[^.]*(?:mismatch|did not match|changed)/i.test(text)) {
    return 'changed-head';
  }
  if (/\b(429|rate limit|secondary rate|abuse detection|retry-after)\b/i.test(text)
    || /HTTP 429/i.test(text)) {
    return 'undetermined';
  }
  if (/not\s+mergeable|cannot\s+be\s+merged|merge\s+conflict/i.test(text)
    || /merge\s+queue\s+is\s+not\s+enabled|queue\s+is\s+not\s+enabled|no\s+merge\s+queue/i
      .test(text)
    || /HTTP 40[134]/i.test(text)
    || /bad credentials|requires authentication|not authorized|unauthorized/i.test(text)
    || /resource not accessible|must have|permission|protected branch|forbidden/i.test(text)) {
    return 'rejected';
  }
  return 'undetermined';
}

export type ProductionEnqueueActionPort = Pick<
EnqueueExecutorDeps,
'readCandidate' | 'enqueueAtHead' | 'fileReconcileChild'
>;

function decodeBase64(value: string): string {
  return Buffer.from(value.replace(/\n/g, ''), 'base64').toString('utf8');
}

interface RecordTransport {
  readonly run: CommandRunner;
  readonly repositoryPath: string;
  readonly askpass: string;
  readonly environment: Record<string, string>;
  readonly repositoryUrl: string;
}

async function remoteRefOid(
  transport: RecordTransport,
  ref: string,
): Promise<GitOid | null> {
  const raw = await transport.run('git', [
    ...gitPublicationArgs(transport.askpass, []),
    '-C', transport.repositoryPath,
    'ls-remote', transport.repositoryUrl, ref,
  ], { env: transport.environment }).catch(() => '');
  const line = raw.trimEnd().split('\n').find((entry) => entry.endsWith(`\t${ref}`));
  if (line === undefined) return null;
  const oid = line.split('\t')[0];
  return oid === undefined || oid.length === 0 ? null : gitOid(oid);
}

async function readEnqueueRecord(
  transport: RecordTransport,
  prNumber: number,
  head: GitOid,
): Promise<EnqueueRecord | null> {
  const ref = enqueueRef(prNumber, head);
  const oid = await remoteRefOid(transport, ref);
  if (oid === null) return null;
  const raw = await transport.run('git', [
    ...gitPublicationArgs(transport.askpass, []),
    '-C', transport.repositoryPath,
    'cat-file', '-p', oid,
  ], { env: transport.environment }).catch(() => '');
  const message = raw.split('\n\n').slice(1).join('\n\n').trim();
  return message.length === 0 ? null : decodeEnqueueRecord(message);
}

/**
 * CAS-publish an enqueue-attempt record, leased against the ref value we read.
 * `won` and `already-applied` both mean the record now says what we intended;
 * anything else means another writer moved the ref underneath us and this
 * head's attempt count is no longer something we can assert.
 */
async function publishEnqueueRecord(
  transport: RecordTransport,
  record: EnqueueRecord,
  expected: GitOid | null,
): Promise<'won' | 'already-applied' | 'lost'> {
  const ref = enqueueRef(record.prNumber, record.head);
  const published = gitOid((await transport.run('git', [
    ...gitPublicationArgs(transport.askpass, []),
    '-C', transport.repositoryPath,
    'commit-tree', emptyTreeOid(),
    '-m', encodeEnqueueRecord(record),
  ], { env: transport.environment })).trim());
  if (expected === published) return 'already-applied';
  try {
    await transport.run('git', [
      ...gitPublicationArgs(transport.askpass, []),
      '-C', transport.repositoryPath,
      'push', `--force-with-lease=${ref}:${expected ?? ''}`,
      transport.repositoryUrl, `${published}:${ref}`,
    ], { env: transport.environment });
    return 'won';
  } catch {
    const observed = await remoteRefOid(transport, ref);
    return observed === published ? 'already-applied' : 'lost';
  }
}

function effectiveCurrentHeadReviews(
  pr: PullRequestSnapshot,
): readonly NativeReviewSnapshot[] {
  const latest = new Map<string, NativeReviewSnapshot>();
  for (const review of pr.reviews
    .filter((candidate) => candidate.commitId === pr.headOid)
    .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt))) {
    latest.set(review.reviewer.toLowerCase(), review);
  }
  return [...latest.values()];
}

function hasExactCanonicalMergeAuthority(
  snapshot: GitHubLifecycleSnapshot,
  prNumber: number,
  head: string,
  expectedBaseRefName: string,
): boolean {
  if (snapshot.snapshotComplete !== true) return false;
  const pr = snapshot.pullRequests.find((entry) => entry.number === prNumber);
  const lifecycle = snapshot.lifecycle.items.find((entry) => (
    entry.kind === 'pull-request' && entry.prNumber === prNumber
  ));
  const mappings = snapshot.pullRequestMappings?.filter(
    (entry) => entry.prNumber === prNumber,
  ) ?? [];
  const mapping = mappings.length === 1 ? mappings[0] : undefined;
  return pr?.state === 'OPEN'
    && pr.headOid === head
    && pr.baseRefName === expectedBaseRefName
    && lifecycle?.kind === 'pull-request'
    && lifecycle.head === head
    && mapping?.status === 'resolved'
    && mapping.issueNumber === lifecycle.issueNumber
    && mapping.expectedBaseRefName === expectedBaseRefName;
}

export function makeProductionEnqueueActionPort(
  options: ProductionEnqueueActionPortOptions,
): ProductionEnqueueActionPort {
  const runner = options.runner ?? defaultRunner;
  const ambient = options.environment ?? process.env;
  const expectedBase = gitRefName(options.expectedBaseRefName ?? 'next');
  const repositorySlug = options.repositorySlug ?? REPO;
  const withCredential = <Value>(
    credential: SelectedCredential,
    operation: Parameters<typeof withSelectedCredential<Value>>[2],
  ) => withSelectedCredential(credential, ambient, operation, runner);
  const readCandidate = async (prNumber: number): Promise<EnqueueCandidate | null> => {
    const snapshot = await options.readSnapshot();
    const pr = snapshot.pullRequests.find((entry) => entry.number === prNumber);
    if (pr === undefined) return null;
    const lifecycle = snapshot.lifecycle.items.find((entry) =>
      entry.kind === 'pull-request' && entry.prNumber === prNumber);
    if (
      lifecycle?.kind !== 'pull-request'
      || !hasExactCanonicalMergeAuthority(
        snapshot,
        prNumber,
        pr.headOid,
        expectedBase,
      )
    ) return null;
    const nativeIssue = (snapshot.issues ?? []).find((issue) => (
      issue.number === lifecycle.issueNumber
    ));
    const projectItem = (snapshot.project?.items ?? []).find((item) => (
      item.contentType === 'Issue' && item.number === lifecycle.issueNumber
    ));
    const changedFiles = await readExactChangedFiles({
      run: runner,
      prNumber: pr.number,
      expectedHead: pr.headOid,
      expectedBaseRefName: expectedBase,
      context: 'Merge',
      repositorySlug,
    });
    const { baseRefName: compareBaseRefName, files } = changedFiles;
    // CODEOWNERS is read at the base branch *tip*, not at the PR's pinned fork
    // point (`baseOid`), because the tip is what GitHub enforces at merge time.
    // This makes `codeownerSensitive` agree with the enforcing authority.
    //
    // The fork-point read could disagree in BOTH directions, and neither
    // direction is safe to hand-wave:
    //   - a rule ADDED to the base after the PR forked was absent from the
    //     fork-point blob, so a change touching a newly-owned path
    //     under-reported as not sensitive — the fail-open direction;
    //   - a rule DELETED or NARROWED on the base after the PR forked was still
    //     present in the fork-point blob, so a change over-reported as
    //     sensitive and was routed to a human GitHub would not have asked for.
    //
    // Note explicitly that this fix is therefore NOT monotone: moving to the
    // tip can turn `codeownerSensitive` from `true` to `false` whenever a rule
    // was removed, and an ordinary commit is enough to do that. The
    // justification is correctness — one authority, the one that actually
    // gates the merge — not conservatism. Do not restate it as "can only add
    // sensitivity"; that claim is false.
    //
    // `baseOid` stays the authority for the changed-files diff, which is
    // genuinely computed against the fork point. The `heads/` prefix keeps a
    // same-named tag from hijacking ref resolution, matching the compare call
    // below; `compareBaseRefName` is a `gitRefName`, so no unsafe ref reaches
    // the network.
    let codeownersResponse: string;
    try {
      codeownersResponse = await runner('gh', [
        'api',
        `repos/${repositorySlug}/contents/.github/CODEOWNERS`
        + `?ref=heads/${compareBaseRefName}`,
      ]);
    } catch (error) {
      if (error instanceof Error && /HTTP 404/i.test(error.message)) {
        codeownersResponse = JSON.stringify({
          content: Buffer.from('').toString('base64'),
        });
      } else {
        throw error;
      }
    }
    const codeownersRaw = JSON.parse(codeownersResponse) as { content?: unknown };
    if (typeof codeownersRaw.content !== 'string') {
      throw new Error('Merge CODEOWNERS read was incomplete');
    }
    // `baseOid` is the PR's pinned fork point. It never advances with the base
    // branch, so comparing against it can only ever yield `ahead`/`identical`
    // and made the `behind` merge-gate reason unreachable. Compare against the
    // base branch so GitHub resolves it to the current tip. The `heads/` prefix
    // keeps a same-named tag from hijacking the resolution. See
    // `readExactCompareStatus` for the full race analysis.
    const compare = JSON.parse(await runner('gh', [
      'api',
      `repos/${repositorySlug}/compare/heads/${compareBaseRefName}...${pr.headOid}`,
    ])) as { status?: unknown; files?: unknown };
    const compareStatus = decodeCompareStatus(compare.status);
    const effectiveReviews = effectiveCurrentHeadReviews(pr);
    const reviewClaim = lifecycle.reviewClaim;
    // The approval is anchored to the head the reviewer read, which is the head
    // the claim, the terminal verdict, the native review's `commitId` and the
    // signed marker all name. When that is still the PR head this is exactly
    // `pr.headOid` and nothing below differs from the previous behaviour.
    const approvalHead = reviewClaim?.head;
    // Only relevant when the head has moved. `update-branch` mints a new head
    // commit without changing what was reviewed; a worker push changes it. The
    // digest is the evidence that separates the two, and it is consulted only
    // to relax the *head-identity* conjunct of the approval — never any other
    // gate reason.
    //
    // Recomputed here from the compare response `readCandidate` already fetches
    // and the exact changed-file list it already proved complete, so carrying
    // costs no additional API call.
    const reviewedDiffCarry = reviewClaim?.state === 'terminal-approved'
      && approvalHead !== pr.headOid
      && reviewClaim.reviewedDiffDigest !== undefined
      ? reviewedDiffDigestFromCompare(compare.files, changedFiles)
      : undefined;
    const carriedApproval = reviewedDiffCarry?.status === 'digest'
      && reviewClaim?.state === 'terminal-approved'
      && reviewedDiffCarry.digest === reviewClaim.reviewedDiffDigest;
    // Unchanged: still the reviewer's effective review at the *current* head.
    // Measured on Jinn-Network/mono, GitHub re-points an existing review's
    // `commit_id` onto the merge commit that `update-branch` creates (PR #2130
    // carries three reviews whose signed markers name three different heads and
    // whose `commit_id` all read as the final head), while an ordinary worker
    // push leaves `commit_id` alone (PR #2232). So the carried review is found
    // here, and the dismissal/supersession semantics of "effective at the
    // current head" are preserved exactly.
    const terminalReview = reviewClaim === undefined
      ? undefined
      : effectiveReviews.find((review) =>
        review.reviewer.toLowerCase() === reviewClaim.reviewer.toLowerCase());
    const signedMarker = reviewClaim?.state === 'terminal-approved'
      ? formatAutomatedReviewMarker({
          generation: reviewClaim.generation,
          attempt: reviewClaim.attempt,
          intent: reviewClaim.verdict.marker,
          reviewer: reviewClaim.reviewer,
          head: reviewClaim.head,
          verdict: reviewClaim.verdict.state,
        })
      : undefined;
    // The marker encodes `head=<reviewClaim.head>`, so it is *not* re-signed for
    // a carried head and must not be: re-signing would mint a claim of review at
    // a commit nobody reviewed. It stays the reviewer-authored, head-bound proof
    // for the head that was actually read, verified here against the recorded
    // head — and it is the *only* head binding on the native review that GitHub
    // does not rewrite, which is precisely why it is the one that is kept.
    //
    // Read the `terminalVerdict.head` conjunct below for what it actually is.
    // `snapshot.ts` derives `terminalVerdict.head` as `claim.head` by
    // definition, so `terminalVerdict.head === reviewClaim.head` is a *tautology*
    // for any snapshot-derived item: it degenerates to "a verdict exists" and
    // binds no head. It is retained only because it is free and still rejects a
    // foreign lifecycle projection whose verdict metadata contradicts its own
    // claim — not because it proves anything about which commit was reviewed.
    // The head binding that does the work is the signed-marker check on the
    // native review, on the last line of this conjunction.
    const terminalApprovalMatches = reviewClaim?.state === 'terminal-approved'
      && (approvalHead === pr.headOid || carriedApproval)
      && lifecycle.terminalVerdict?.head === reviewClaim.head
      && lifecycle.terminalVerdict.state === 'APPROVE'
      && lifecycle.terminalVerdict.marker === reviewClaim.verdict.marker
      && signedMarker !== undefined
      && terminalReview?.state === 'APPROVED'
      && terminalReview.body.includes(signedMarker);
    return {
      issueNumber: lifecycle.issueNumber,
      prNumber: pr.number,
      open: pr.state === 'OPEN',
      merged: pr.state === 'MERGED',
      head: pr.headOid,
      baseRefName: gitRefName(pr.baseRefName),
      expectedBaseRefName: expectedBase,
      ...(options.defaultBranch === undefined
        ? {}
        : { defaultBaseRefName: gitRefName(options.defaultBranch) }),
      draft: pr.isDraft,
      labels: [...pr.labels],
      humanHold: hasExternalHumanAuthority({
        pullRequestLabels: pr.labels,
        nativeIssueLabels: nativeIssue?.labels,
        projectBlockedOn: projectItem?.blockedOn,
      }),
      author: pr.author,
      authorAllowed: options.authorAllowlist.has(pr.author.toLowerCase()),
      uniqueIssueMapping: true,
      terminalApprovalMatches,
      ...(lifecycle.reviewClaim?.reviewer === undefined
        ? {}
        : { terminalApprovalReviewer: lifecycle.reviewClaim.reviewer }),
      effectiveReviews: effectiveReviews.map((review) => ({
          reviewer: review.reviewer,
          state: review.state,
          commitId: review.commitId,
        })),
      checks: pr.checks.map((check) => ({ ...check })),
      mergeable: pr.mergeability,
      mergeStateStatus: pr.mergeStateStatus,
      compareStatus,
      changedFilesComplete: changedFiles.complete,
      codeownersComplete: true,
      codeownerSensitive: touchesCodeOwnedPath(
        [...files],
        parseOwnedPrefixes(decodeBase64(codeownersRaw.content)),
      ),
      codeOwnerLogins: options.codeOwnerLogins ?? new Set<string>(),
      ...(pr.graphqlId === undefined ? {} : { graphqlId: pr.graphqlId }),
      inMergeQueue: pr.mergeQueue?.enqueued === true,
    };
  };

  return {
    readCandidate,
    enqueueAtHead: ({
      prNumber,
      issueNumber,
      head,
      graphqlId,
      expectedBaseRefName,
      credential,
    }): Promise<ExactEnqueueOutcome> =>
      withCredential(credential, async ({ run, askpass, environment }) => {
        const canonical = await options.readSnapshot();
        const canonicalPr = canonical.pullRequests.find(
          (entry) => entry.number === prNumber,
        );
        if (canonicalPr !== undefined && canonicalPr.headOid !== head) {
          return { status: 'changed-head', head: canonicalPr.headOid };
        }
        if (!hasExactCanonicalMergeAuthority(
          canonical,
          prNumber,
          head,
          expectedBaseRefName,
        )) {
          return {
            status: 'rejected',
            head,
            reason: 'Canonical mapping authority changed before the exact-head enqueue',
          };
        }
        type PrAuthority = {
          state?: unknown;
          headRefOid?: unknown;
          baseRefName?: unknown;
          isInMergeQueue?: unknown;
        };
        const readAuthority = async (): Promise<PrAuthority> => JSON.parse(await run('gh', [
          'pr', 'view', String(prNumber), '--repo', repositorySlug,
          '--json', 'state,headRefOid,baseRefName,isInMergeQueue',
        ])) as Record<string, unknown>;
        const authority = await readAuthority();
        if (typeof authority.headRefOid === 'string' && authority.headRefOid !== head) {
          return { status: 'changed-head', head: gitOid(authority.headRefOid) };
        }
        if (
          authority.state !== 'OPEN'
          || authority.headRefOid !== head
          || authority.baseRefName !== expectedBaseRefName
        ) {
          return {
            status: 'rejected',
            head,
            reason: 'Enqueue base authority changed before the exact-head enqueue',
          };
        }
        if (authority.isInMergeQueue === true) {
          return { status: 'already-enqueued', head };
        }
        const transport = options.repositoryPath === undefined
          ? null
          : {
              run,
              repositoryPath: options.repositoryPath,
              askpass,
              environment,
              repositoryUrl: options.repositoryUrl ?? CANONICAL_GITHUB_HTTPS_REMOTE,
            } satisfies RecordTransport;
        // The attempt ledger for *this head*. No transport means no ledger, and
        // an absent ledger reads as "no attempt recorded" — the flake policy
        // degrades to always-allow, never to always-refuse.
        const existingRef = transport === null
          ? null
          : await remoteRefOid(transport, enqueueRef(prNumber, head));
        const existing = transport === null
          ? null
          : await readEnqueueRecord(transport, prNumber, head);
        const decision = decideReEnqueue(existing);
        if (!decision.allow && transport !== null && existing !== null) {
          // Two failed attempts at one head is a signal. Stop feeding the
          // queue, file the child that explains it, and write the child's
          // number into the record so a later cycle can tell "held and
          // explained" from "held and silent".
          const child = await fileChildIssue(makeProductionChildIssuePort({
            runner: run,
            repo: repositorySlug,
            fixIssueTypeId: options.fixIssueTypeId
              ?? options.projectMapping?.fields.type.options.fix,
            projectOwner: options.projectOwner,
            projectNumber: options.projectNumber,
            projectMapping: options.projectMapping,
          }), {
            parentPr: prNumber,
            kind: 'ci-failure',
            title: `Merge queue rejected PR #${prNumber} twice`,
            body: [
              `Parent pull request: #${prNumber}`,
              `Parent issue: #${issueNumber}`,
              `Head: ${head}`,
              `Enqueue attempts at this head: ${existing.attempts}`,
              `First enqueued at: ${existing.enqueuedAt}`,
              '',
              'The merge queue has rejected or ejected this head more than once.',
              'Diagnose the failure before the engine enqueues it again; pushing a',
              'new commit resets the attempt count.',
            ].join('\n'),
            effort: 'medium',
            priority: 'p1',
          }).catch(() => null);
          if (child !== null && !('runawayHold' in child && child.runawayHold)) {
            await publishEnqueueRecord(
              transport,
              { ...existing, linkedIssue: child.number },
              existingRef,
            ).catch(() => 'lost' as const);
          }
          return {
            status: 'flake-hold',
            head,
            reason: `Enqueue held after ${existing.attempts} attempts at this head`,
          };
        }
        // Mutate first, record second. A record written before the mutation
        // would burn an attempt for a call that never reached GitHub, and two
        // of those would put a perfectly healthy head on a flake hold.
        let entry: { position?: unknown; state?: unknown } | null = null;
        let failure: EnqueueFailureClass | undefined;
        let failureText = '';
        try {
          const response = JSON.parse(await run('gh', [
            'api', 'graphql',
            '-f', `query=${ENQUEUE_MUTATION}`,
            '-f', `pullRequestId=${graphqlId}`,
            '-f', `expectedHeadOid=${head}`,
          ])) as {
            data?: { enqueuePullRequest?: { mergeQueueEntry?: unknown } | null };
            errors?: readonly { message?: unknown }[];
          };
          if (Array.isArray(response.errors) && response.errors.length > 0) {
            throw new Error(response.errors
              .map((error) => String(error.message ?? ''))
              .join('; '));
          }
          const raw = response.data?.enqueuePullRequest?.mergeQueueEntry;
          entry = raw === null || raw === undefined
            ? null
            : raw as { position?: unknown; state?: unknown };
        } catch (error) {
          failureText = errorText(error);
          failure = classifyEnqueueFailure(failureText);
        }
        if (failure === 'changed-head') {
          const after = await readAuthority().catch((): PrAuthority => ({}));
          return typeof after.headRefOid === 'string' && after.headRefOid !== head
            ? { status: 'changed-head', head: gitOid(after.headRefOid) }
            : { status: 'ambiguous', head, reason: failureText };
        }
        if (failure === 'rejected') {
          return { status: 'rejected', head, reason: failureText };
        }
        if (failure === 'undetermined') {
          // A dropped connection is not proof the mutation did not land. Only
          // an observed queue entry at the expected head resolves it.
          const after = await readAuthority().catch((): PrAuthority => ({}));
          if (typeof after.headRefOid === 'string' && after.headRefOid !== head) {
            return { status: 'changed-head', head: gitOid(after.headRefOid) };
          }
          if (after.isInMergeQueue !== true) {
            return { status: 'ambiguous', head, reason: failureText };
          }
        }
        const succeeded = failure === undefined || failure === 'undetermined';
        const status = failure === 'already-enqueued'
          ? 'already-enqueued' as const
          : 'enqueued' as const;
        if (transport === null || !succeeded) {
          return {
            status,
            head,
            ...(typeof entry?.position === 'number' ? { position: entry.position } : {}),
            ...(typeof entry?.state === 'string' ? { queueState: entry.state } : {}),
          };
        }
        const published = await publishEnqueueRecord(transport, {
          prNumber,
          head,
          attempts: (existing?.attempts ?? 0) + 1,
          enqueuedAt: new Date().toISOString(),
          ...(existing?.linkedIssue === undefined
            ? {}
            : { linkedIssue: existing.linkedIssue }),
        }, existingRef).catch(() => 'lost' as const);
        if (published === 'lost') {
          // Another writer moved the ref. The enqueue may well have landed, but
          // this head's attempt count is no longer something we can assert.
          return {
            status: 'ambiguous',
            head,
            reason: 'Enqueue attempt record publication was lost',
          };
        }
        return {
          status,
          head,
          ...(typeof entry?.position === 'number' ? { position: entry.position } : {}),
          ...(typeof entry?.state === 'string' ? { queueState: entry.state } : {}),
        };
      }),

    fileReconcileChild: ({ prNumber, effort, credential }) =>
      withCredential(credential, async ({ run }) => {
        const port = makeProductionChildIssuePort({
          runner: run,
          repo: repositorySlug,
          fixIssueTypeId: options.fixIssueTypeId
            ?? options.projectMapping?.fields.type.options.fix,
          projectOwner: options.projectOwner,
          projectNumber: options.projectNumber,
          projectMapping: options.projectMapping,
        });
        const filed = await fileChildIssue(port, {
          parentPr: prNumber,
          kind: 'reconcile',
          title: `Reconcile conflicts for PR #${prNumber}`,
          body: [
            `Parent pull request: #${prNumber}`,
            '',
            'Merge `origin/<base>` into the PR branch (never rebase).',
            'Classify every conflict before editing; escalate when intent is undeterminable.',
          ].join('\n'),
          effort,
          priority: 'p1',
        });
        if ('runawayHold' in filed && filed.runawayHold) {
          throw new Error(
            `Reconcile child runaway hold for PR #${prNumber} (prior=${filed.priorCount})`,
          );
        }
        return { number: filed.number, created: filed.created };
      }),
  };
}
