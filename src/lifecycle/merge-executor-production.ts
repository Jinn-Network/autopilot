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
} from './merge-executor.js';
import { readExactChangedFiles } from './github-changed-files.js';
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
    const { baseOid, files } = changedFiles;
    let codeownersResponse: string;
    try {
      codeownersResponse = await runner('gh', [
        'api', `repos/${repositorySlug}/contents/.github/CODEOWNERS?ref=${baseOid}`,
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
    const compare = JSON.parse(await runner('gh', [
      'api',
      `repos/${repositorySlug}/compare/${baseOid}...${pr.headOid}`,
    ])) as { status?: unknown };
    const compareStatus = decodeCompareStatus(compare.status);
    const effectiveReviews = effectiveCurrentHeadReviews(pr);
    const reviewClaim = lifecycle.reviewClaim;
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
    const terminalApprovalMatches = reviewClaim?.state === 'terminal-approved'
      && reviewClaim.head === pr.headOid
      && lifecycle.terminalVerdict?.head === pr.headOid
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

    updateBranch: ({ prNumber, expectedHead, credential }) =>
      withCredential(credential, async ({ run }) => {
        try {
          await run('gh', [
            'pr', 'update-branch', String(prNumber),
            '--repo', repositorySlug,
          ]);
        } catch {
          // Exact readback below classifies the outcome.
        }
        const readback = JSON.parse(await run('gh', [
          'pr', 'view', String(prNumber), '--repo', repositorySlug,
          '--json', 'headRefOid',
        ])) as { headRefOid?: unknown };
        if (typeof readback.headRefOid !== 'string') {
          return { status: 'rejected' as const, head: expectedHead };
        }
        const head = gitOid(readback.headRefOid);
        if (head === expectedHead) {
          return { status: 'rejected' as const, head };
        }
        return { status: 'updated' as const, head };
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
