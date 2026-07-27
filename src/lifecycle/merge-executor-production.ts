import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import { parseOwnedPrefixes, touchesCodeOwnedPath } from '../dispatcher/code-owned.js';
import { REPO } from '../dispatcher/constants.js';
import { ensureFieldIds } from '../dispatcher/field-cache.js';
import { fetchProjectSnapshot } from '../dispatcher/project-snapshot.js';
import { formatAutomatedReviewMarker } from './codecs.js';
import type { SelectedCredential } from './credentials.js';
import { fileChildIssue } from './child-issues.js';
import { makeProductionChildIssuePort } from './child-issues-production.js';
import type {
  MergeCandidate,
  MergeExecutorDeps,
  ExactMergeOutcome,
  UpdateBranchFailureClass,
  UpdateBranchOutcome,
} from './merge-executor.js';
import { DURABLE_UPDATE_BRANCH_FAILURES } from './merge-executor.js';
import { readExactChangedFiles } from './github-changed-files.js';
import { reviewedDiffDigestFromCompare } from './reviewed-diff-digest.js';
import { withSelectedCredential } from './production-auth.js';
import type {
  GitHubLifecycleSnapshot,
  NativeReviewSnapshot,
  PullRequestSnapshot,
} from './snapshot.js';
import { decodeCompareStatus, gitOid, gitRefName } from './types.js';
import type { ProjectMapping } from '../config/config.js';
import { hasExternalHumanAuthority } from './human-authority.js';

export interface ProductionMergeActionPortOptions {
  readonly readSnapshot: () => Promise<GitHubLifecycleSnapshot>;
  readonly authorAllowlist: ReadonlySet<string>;
  readonly expectedBaseRefName?: string;
  readonly repositorySlug?: string;
  readonly projectOwner?: string;
  readonly projectNumber?: number;
  readonly projectMapping?: ProjectMapping;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * Injection seam for the bounded `update-branch` readback poll. Tests supply
   * a no-op so the 202-async path costs no wall clock.
   */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly updateBranchReadback?: {
    readonly attempts?: number;
    readonly delayMs?: number;
  };
}

/**
 * Bounded poll for the documented 202 Accepted behaviour of
 * `PUT /repos/{owner}/{repo}/pulls/{n}/update-branch`. Four reads spanning
 * ~4.5s is enough for GitHub's queue in the overwhelming majority of cases and
 * short enough that a genuinely stuck update still surfaces inside one cycle.
 * Exceeding the budget is not an error — it yields `pending`, never `updated`.
 */
const UPDATE_BRANCH_READBACK_ATTEMPTS = 4;
const UPDATE_BRANCH_READBACK_DELAY_MS = 1_500;

/**
 * `gh pr update-branch` compares before it mutates. When `behind_by == 0` it
 * prints this to **stdout** and exits 0 without calling the API at all
 * (`cli/cli` v2.78, `pkg/cmd/pr/update-branch/update_branch.go`). `defaultRunner`
 * returns stdout, so this is directly observable — unlike gh's failure messages,
 * which go to stderr.
 */
const ALREADY_UP_TO_DATE_PATTERN = /already\s+up[-\s]?to[-\s]?date/i;

function errorText(error: unknown): string {
  return error instanceof Error
    ? `${error.message}\n${String((error as { stderr?: unknown }).stderr ?? '')}`
    : String(error);
}

/**
 * Map an `update-branch` failure onto the smallest set of classes that lead to
 * different operator actions.
 *
 * Ordering is load-bearing. GitHub serves *secondary* rate limits as HTTP 403,
 * so the rate-limit probe must run before the permission probe or every
 * throttle would be misreported as a branch-protection refusal — which is
 * exactly the class of false diagnosis this function exists to stop.
 *
 * Both transports are covered. `gh pr update-branch` drives the GraphQL
 * `updatePullRequestBranch` mutation, whose conflict answer is the literal
 * `GraphQL: merge conflict between base and head (updatePullRequestBranch)`,
 * and gh's own pre-flight refusal is `Cannot update PR branch due to conflicts`
 * — neither carries an HTTP status. The REST endpoint answers HTTP 422 for the
 * same condition. Conflict prose and 422 are both matched so the classification
 * does not depend on which transport produced the failure.
 *
 * Anything unrecognised is `unclassified`, never `conflict`: asserting a
 * conflict we cannot see is the failure mode that misled the operator on
 * PR #2130.
 */
export function classifyUpdateBranchFailure(text: string): UpdateBranchFailureClass {
  if (/\b(429|rate limit|secondary rate|abuse detection|retry-after)\b/i.test(text)
    || /HTTP 429/i.test(text)) {
    return 'rate-limited';
  }
  if (/HTTP 422/i.test(text)
    || /\bunprocessable\b/i.test(text)
    || /merge conflict/i.test(text)
    || /\bconflict/i.test(text)
    || /not mergeable|cannot be merged/i.test(text)) {
    return 'conflict';
  }
  if (/HTTP 40[134]/i.test(text)
    || /bad credentials|requires authentication|not authorized|unauthorized/i.test(text)
    || /resource not accessible|must have|permission|protected branch|forbidden/i.test(text)) {
    return 'forbidden';
  }
  if (/HTTP 5\d\d/i.test(text)
    || /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE/i.test(text)
    || /timed out|timeout|connection reset|socket hang up|network is unreachable|TLS handshake|EOF/i
      .test(text)) {
    return 'unavailable';
  }
  return 'unclassified';
}

export type ProductionMergeActionPort = Pick<
MergeExecutorDeps,
'readCandidate' | 'mergeExactHead' | 'reconcileDone' | 'updateBranch' | 'fileReconcileChild'
>;

function decodeBase64(value: string): string {
  return Buffer.from(value.replace(/\n/g, ''), 'base64').toString('utf8');
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

export function makeProductionMergeActionPort(
  options: ProductionMergeActionPortOptions,
): ProductionMergeActionPort {
  const runner = options.runner ?? defaultRunner;
  const ambient = options.environment ?? process.env;
  const pause = options.sleep
    ?? ((milliseconds: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    }));
  const expectedBase = gitRefName(options.expectedBaseRefName ?? 'next');
  const repositorySlug = options.repositorySlug ?? REPO;
  const withCredential = <Value>(
    credential: SelectedCredential,
    operation: Parameters<typeof withSelectedCredential<Value>>[2],
  ) => withSelectedCredential(credential, ambient, operation, runner);
  const readCandidate = async (prNumber: number): Promise<MergeCandidate | null> => {
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
    };
  };

  return {
    readCandidate,
    mergeExactHead: ({
      prNumber,
      head,
      expectedBaseRefName,
      credential,
    }): Promise<ExactMergeOutcome> =>
      withCredential(credential, async ({ run }) => {
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
            reason: 'Canonical mapping authority changed before the exact-head merge',
          };
        }
        const authority = JSON.parse(await run('gh', [
          'pr', 'view', String(prNumber), '--repo', repositorySlug,
          '--json', 'state,headRefOid,baseRefName',
        ])) as {
          state?: unknown;
          headRefOid?: unknown;
          baseRefName?: unknown;
        };
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
            reason: 'Merge base authority changed before the exact-head merge',
          };
        }
        try {
          const response = JSON.parse(await run('gh', [
            'api', '-X', 'PUT', `repos/${repositorySlug}/pulls/${prNumber}/merge`,
            '-f', `sha=${head}`,
            '-f', 'merge_method=squash',
          ])) as { merged?: unknown; sha?: unknown; message?: unknown };
          if (response.merged === true && typeof response.sha === 'string') {
            return {
              status: 'merged',
              head,
              mergeCommitOid: gitOid(response.sha),
            };
          }
        } catch {
          // Exact PR readback below classifies accepted ambiguity versus rejection.
        }
        const readback = JSON.parse(await run('gh', [
          'pr', 'view', String(prNumber), '--repo', repositorySlug,
          '--json', 'state,headRefOid,baseRefName,mergeCommit',
        ])) as {
          state?: unknown;
          headRefOid?: unknown;
          baseRefName?: unknown;
          mergeCommit?: { oid?: unknown } | null;
        };
        if (
          readback.state === 'MERGED'
          && readback.headRefOid === head
          && readback.baseRefName === expectedBaseRefName
          && typeof readback.mergeCommit?.oid === 'string'
        ) {
          return {
            status: 'already-merged',
            head,
            mergeCommitOid: gitOid(readback.mergeCommit.oid),
          };
        }
        if (typeof readback.headRefOid === 'string' && readback.headRefOid !== head) {
          return { status: 'changed-head', head: gitOid(readback.headRefOid) };
        }
        return { status: 'rejected', head, reason: 'GitHub rejected the exact-head merge gate' };
      }),

    reconcileDone: ({ issueNumber, prNumber, expectedHead, credential }) =>
      withCredential(credential, async ({ run }) => {
        const pr = JSON.parse(await run('gh', [
          'pr', 'view', String(prNumber), '--repo', repositorySlug,
          '--json', 'state,headRefOid,mergeCommit',
        ])) as { state?: unknown; headRefOid?: unknown; mergeCommit?: unknown };
        if (pr.state !== 'MERGED' || pr.headRefOid !== expectedHead || pr.mergeCommit === null) {
          throw new Error('Merged readback is not exact');
        }
        const snapshot = await fetchProjectSnapshot(run, {
          projectOwner: options.projectOwner,
          projectNumber: options.projectNumber,
        });
        const item = snapshot.items.find((entry) =>
          entry.contentType === 'Issue' && entry.number === issueNumber);
        if (item === undefined) throw new Error('Merged issue is missing from Project');
        if (item.status !== 'Done') {
          const fields = options.projectMapping === undefined
            ? await ensureFieldIds(run)
            : {
                projectId: options.projectMapping.id,
                status: {
                  fieldId: options.projectMapping.fields.status.id,
                  options: {
                    Done: options.projectMapping.fields.status.options.done,
                  },
                },
              };
          let mutationError: unknown;
          try {
            await run('gh', [
              'project', 'item-edit',
              '--id', item.id,
              '--project-id', fields.projectId,
              '--field-id', fields.status.fieldId,
              '--single-select-option-id', fields.status.options.Done,
            ]);
          } catch (error) {
            mutationError = error;
          }
          const after = await fetchProjectSnapshot(run, {
            projectOwner: options.projectOwner,
            projectNumber: options.projectNumber,
          });
          const current = after.items.find((entry) =>
            entry.contentType === 'Issue' && entry.number === issueNumber);
          if (current?.status !== 'Done') {
            if (mutationError !== undefined) throw mutationError;
            throw new Error('Merged Done projection was ambiguous');
          }
        }
      }),

    /**
     * The old shape was `try { update } catch {} ; read head once ; unchanged
     * => rejected`. That single readback conflated five distinguishable
     * outcomes — 422 conflict, 401/403 refusal, 429/secondary throttle, network
     * failure, and the endpoint's documented 202 Accepted queueing — into one
     * verdict that reads as "merge conflict" to an operator. Observed live on
     * PR #2130: reported `rejected`, then succeeded unchanged.
     *
     * Now: capture and classify the error text, and give an accepted-but-queued
     * update a bounded readback window before deciding anything. A durable
     * refusal (conflict/forbidden) skips the poll entirely, so the common
     * conflict case costs no extra wall clock.
     */
    updateBranch: ({ prNumber, expectedHead, credential }): Promise<UpdateBranchOutcome> =>
      withCredential(credential, async ({ run }) => {
        let failure: UpdateBranchFailureClass | undefined;
        let alreadyUpToDate = false;
        try {
          const output = await run('gh', [
            'pr', 'update-branch', String(prNumber),
            '--repo', repositorySlug,
          ]);
          alreadyUpToDate = ALREADY_UP_TO_DATE_PATTERN.test(output);
        } catch (error) {
          failure = classifyUpdateBranchFailure(errorText(error));
        }
        // A non-zero exit is not proof the request failed to land, so even a
        // durable-looking refusal gets one readback — it just gets no poll.
        // Nothing is in flight when gh never called the API, so an
        // already-up-to-date answer skips the poll for the same reason.
        const durable = failure !== undefined
          && DURABLE_UPDATE_BRANCH_FAILURES.has(failure);
        const attempts = durable || alreadyUpToDate
          ? 1
          : Math.max(1, options.updateBranchReadback?.attempts
            ?? UPDATE_BRANCH_READBACK_ATTEMPTS);
        const delayMs = options.updateBranchReadback?.delayMs
          ?? UPDATE_BRANCH_READBACK_DELAY_MS;
        let readbackFailed = false;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          if (attempt > 0) await pause(delayMs);
          let head: string | undefined;
          try {
            const readback = JSON.parse(await run('gh', [
              'pr', 'view', String(prNumber), '--repo', repositorySlug,
              '--json', 'headRefOid',
            ])) as { headRefOid?: unknown };
            if (typeof readback.headRefOid === 'string') head = readback.headRefOid;
          } catch {
            // Fall through: an unreadable head is undetermined, not a refusal.
          }
          if (head === undefined) {
            readbackFailed = true;
            continue;
          }
          readbackFailed = false;
          const observed = gitOid(head);
          if (observed !== expectedHead) {
            return { status: 'updated' as const, head: observed };
          }
        }
        if (failure !== undefined) {
          return {
            status: durable ? ('rejected' as const) : ('pending' as const),
            head: expectedHead,
            failure,
          };
        }
        if (alreadyUpToDate) {
          // gh compared and found `behind_by == 0`. The head correctly did not
          // move; that is success with nothing to do, not a refusal.
          return { status: 'already-up-to-date' as const, head: expectedHead };
        }
        // The queue call itself succeeded. An unchanged head after the whole
        // readback budget is the 202-async case (or a readback we could not
        // complete) — undetermined, and explicitly not `updated`.
        return {
          status: 'pending' as const,
          head: expectedHead,
          failure: readbackFailed
            ? ('unavailable' as const)
            : ('queued' as const),
        };
      }),

    fileReconcileChild: ({ prNumber, effort, credential }) =>
      withCredential(credential, async ({ run }) => {
        const port = makeProductionChildIssuePort({
          runner: run,
          repo: repositorySlug,
          fixIssueTypeId: options.projectMapping?.fields.type.options.fix,
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
