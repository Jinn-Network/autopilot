import { REPO } from '../dispatcher/constants.js';
import { parseHumanCommentEvidence } from './codecs.js';
import { GitHubRestSchemaError } from './github-rest-discovery.js';
import type { ConditionalRestClient, ConditionalRestResponse } from './github-rest.js';
import type { PullRequestEvidenceProbe } from './incremental-snapshot-source.js';
import type {
  CheckSummary,
  NativeReviewSnapshot,
  NativeReviewState,
  PullRequestSnapshot,
} from './snapshot.js';
import { gitOid, type GitOid } from './types.js';

export interface BaseBranchTipReader {
  readBaseBranchTipOid(baseRefName: string): Promise<GitOid | 'unavailable'>;
}

function mergePathPullRequest(pr: PullRequestSnapshot): boolean {
  return pr.mergeability === 'MERGEABLE'
    && ['CLEAN', 'UNSTABLE', 'HAS_HOOKS'].includes(pr.mergeStateStatus);
}

async function compareEvidenceNeedsRefresh(
  pr: PullRequestSnapshot,
  baseBranchTipReader: BaseBranchTipReader | undefined,
): Promise<boolean> {
  if (!mergePathPullRequest(pr)) return false;
  if (pr.compareStatus === undefined || pr.compareStatus === 'unknown') return true;
  if (pr.compareBaseTipOid === undefined) return true;
  if (baseBranchTipReader === undefined) return true;
  const liveTip = await baseBranchTipReader.readBaseBranchTipOid(pr.baseRefName);
  if (liveTip === 'unavailable') return true;
  return liveTip !== pr.compareBaseTipOid;
}

function record(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GitHubRestSchemaError(`${subject} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rows(value: unknown, subject: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new GitHubRestSchemaError(`${subject} must be an array`);
  return value;
}

function string(value: unknown, subject: string): string {
  if (typeof value !== 'string') throw new GitHubRestSchemaError(`${subject} must be a string`);
  return value;
}

function nonEmptyString(value: unknown, subject: string): string {
  const decoded = string(value, subject);
  if (decoded.length === 0) throw new GitHubRestSchemaError(`${subject} must not be empty`);
  return decoded;
}

function nonNegativeInteger(value: unknown, subject: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GitHubRestSchemaError(`${subject} must be a non-negative integer`);
  }
  return value as number;
}

function exactTimestamp(value: unknown, subject: string): string {
  const decoded = nonEmptyString(value, subject);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/
    .exec(decoded);
  if (match === null) throw new GitHubRestSchemaError(`${subject} must be an exact UTC timestamp`);
  const parts = match.slice(1).map((part) => Number(part ?? '0'));
  const parsed = new Date(Date.parse(decoded));
  if (
    !Number.isFinite(parsed.getTime())
    || parsed.getUTCFullYear() !== parts[0]
    || parsed.getUTCMonth() + 1 !== parts[1]
    || parsed.getUTCDate() !== parts[2]
    || parsed.getUTCHours() !== parts[3]
    || parsed.getUTCMinutes() !== parts[4]
    || parsed.getUTCSeconds() !== parts[5]
    || parsed.getUTCMilliseconds() !== parts[6]
  ) {
    throw new GitHubRestSchemaError(`${subject} contains an impossible calendar value`);
  }
  return decoded;
}

function completeBody(response: ConditionalRestResponse, subject: string): unknown {
  if (response.nextEndpoint !== null) {
    throw new GitHubRestSchemaError(`${subject} pagination is truncated`);
  }
  return response.body;
}

function reviews(value: unknown): readonly NativeReviewSnapshot[] {
  const validStates = new Set<NativeReviewState>([
    'APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING',
  ]);
  return rows(value, 'PR reviews').map((raw, index): NativeReviewSnapshot => {
    const review = record(raw, `PR review ${index}`);
    const user = record(review.user, `PR review ${index}.user`);
    const state = nonEmptyString(review.state, `PR review ${index}.state`);
    if (!validStates.has(state as NativeReviewState)) {
      throw new GitHubRestSchemaError(`PR review ${index}.state is unknown`);
    }
    return {
      reviewer: nonEmptyString(user.login, `PR review ${index}.user.login`),
      state: state as NativeReviewState,
      commitId: gitOid(nonEmptyString(review.commit_id, `PR review ${index}.commit_id`)),
      body: string(review.body, `PR review ${index}.body`),
      submittedAt: exactTimestamp(review.submitted_at, `PR review ${index}.submitted_at`),
    };
  });
}

function exactPullRequestDetail(
  value: unknown,
  expected: PullRequestSnapshot,
): {
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly isDraft: boolean;
  readonly state: 'OPEN' | 'CLOSED';
  readonly labels: readonly string[];
  readonly mergeability: PullRequestSnapshot['mergeability'];
  readonly mergeStateStatus: string;
} {
  const detail = record(value, 'PR detail');
  if (detail.number !== expected.number) {
    throw new GitHubRestSchemaError(
      `PR detail identity #${String(detail.number)} does not match #${expected.number}`,
    );
  }
  const head = record(detail.head, 'PR detail.head');
  const headOid = nonEmptyString(head.sha, 'PR detail.head.sha');
  gitOid(headOid);
  if (headOid !== expected.headOid) {
    throw new GitHubRestSchemaError('PR detail exact head does not match cached evidence');
  }
  const base = record(detail.base, 'PR detail.base');
  const user = detail.user === null ? null : record(detail.user, 'PR detail.user');
  const rawState = nonEmptyString(detail.state, 'PR detail.state');
  if (rawState !== 'open' && rawState !== 'closed') {
    throw new GitHubRestSchemaError('PR detail.state is unknown');
  }
  if (typeof detail.draft !== 'boolean') {
    throw new GitHubRestSchemaError('PR detail.draft must be boolean');
  }
  const closedAt = detail.closed_at === null
    ? null
    : exactTimestamp(detail.closed_at, 'PR detail.closed_at');
  const mergedAt = detail.merged_at === null
    ? null
    : exactTimestamp(detail.merged_at, 'PR detail.merged_at');
  if (rawState === 'open' && (closedAt !== null || mergedAt !== null)) {
    throw new GitHubRestSchemaError('open PR detail has closed or merged timestamps');
  }
  if (rawState === 'closed' && closedAt === null) {
    throw new GitHubRestSchemaError('closed PR detail has no closed_at timestamp');
  }
  const mergeable = detail.mergeable;
  if (mergeable !== true && mergeable !== false && mergeable !== null) {
    throw new GitHubRestSchemaError('PR detail.mergeable must be boolean or null');
  }
  const labels = rows(detail.labels, 'PR detail.labels').map((raw, index) => (
    nonEmptyString(record(raw, `PR detail label ${index}`).name, `PR detail label ${index}.name`)
  ));
  return {
    title: string(detail.title, 'PR detail.title'),
    body: detail.body === null ? '' : string(detail.body, 'PR detail.body'),
    author: user === null ? '' : nonEmptyString(user.login, 'PR detail.user.login'),
    baseRefName: nonEmptyString(base.ref, 'PR detail.base.ref'),
    headRefName: nonEmptyString(head.ref, 'PR detail.head.ref'),
    isDraft: detail.draft,
    state: rawState.toUpperCase() as 'OPEN' | 'CLOSED',
    labels,
    mergeability: mergeable === null ? 'UNKNOWN' : mergeable ? 'MERGEABLE' : 'CONFLICTING',
    mergeStateStatus: nonEmptyString(
      detail.mergeable_state,
      'PR detail.mergeable_state',
    ).toUpperCase(),
  };
}

function latestHuman(
  value: unknown,
  prNumber: number,
): {
  readonly issueNumber?: number;
  readonly author?: string;
  readonly head?: PullRequestSnapshot['humanHead'];
  readonly generation?: string;
  readonly diagnosticIssueNumbers?: readonly number[];
  readonly diagnosticSignature?: string;
  readonly reason: NonNullable<PullRequestSnapshot['humanReason']>;
} | null {
  const comments = rows(value, 'PR comments').map((raw, index) => {
    const comment = record(raw, `PR comment ${index}`);
    const id = nonNegativeInteger(comment.id, `PR comment ${index}.id`);
    if (id === 0) throw new GitHubRestSchemaError(`PR comment ${index}.id must be positive`);
    const body = string(comment.body, `PR comment ${index}.body`);
    const user = typeof comment.user === 'object' && comment.user !== null
      ? comment.user as Record<string, unknown>
      : undefined;
    const author = typeof user?.login === 'string' && user.login.length > 0
      ? user.login
      : undefined;
    return { id: String(id), body, author };
  });

  let structured: {
    readonly id: bigint;
    readonly parsed: NonNullable<ReturnType<typeof parseHumanCommentEvidence>>;
    readonly author?: string;
  } | undefined;
  const structuredIds = new Set<string>();
  for (const [index, comment] of comments.entries()) {
    const parsed = parseHumanCommentEvidence(comment.body);
    if (parsed === null) {
      if (comment.body.includes('<!-- jinn-autopilot-human:')) {
        throw new GitHubRestSchemaError(
          `PR comment ${index} has an invalid structured Human marker or diagnostic signature`,
        );
      }
      continue;
    }
    if (parsed.prNumber !== prNumber) {
      throw new GitHubRestSchemaError(
        `PR comment ${index} Human marker names PR #${parsed.prNumber}, expected #${prNumber}`,
      );
    }
    if (structuredIds.has(comment.id)) {
      throw new GitHubRestSchemaError('PR comments have duplicate database IDs');
    }
    structuredIds.add(comment.id);
    const candidate = {
      id: BigInt(comment.id),
      parsed,
      ...(comment.author === undefined ? {} : { author: comment.author }),
    };
    if (structured === undefined || structured.id < candidate.id) structured = candidate;
  }
  if (structured === undefined) return null;
  return {
    ...(structured.parsed.issueNumber === undefined
      ? {}
      : { issueNumber: structured.parsed.issueNumber }),
    ...(structured.author === undefined ? {} : { author: structured.author }),
    ...(structured.parsed.head === undefined ? {} : { head: structured.parsed.head }),
    ...(structured.parsed.generation === undefined
      ? {}
      : { generation: structured.parsed.generation }),
    ...(structured.parsed.diagnosticIssueNumbers === undefined
      ? {}
      : {
          diagnosticIssueNumbers: structured.parsed.diagnosticIssueNumbers,
          diagnosticSignature: structured.parsed.diagnosticSignature,
        }),
    reason: structured.parsed.reason,
  };
}

function currentSurfaceActors(
  value: unknown,
  humanLabelPresent: boolean,
  draft: boolean,
): {
  readonly humanLabelActor?: string;
  readonly draftActor?: string;
} {
  const events = rows(value, 'PR events').flatMap((raw, index) => {
    const event = record(raw, `PR event ${index}`);
    const kind = nonEmptyString(event.event, `PR event ${index}.event`);
    if (!['labeled', 'unlabeled', 'convert_to_draft', 'ready_for_review'].includes(kind)) {
      return [];
    }
    const createdAt = exactTimestamp(event.created_at, `PR event ${index}.created_at`);
    const actor = event.actor === null
      ? undefined
      : nonEmptyString(record(event.actor, `PR event ${index}.actor`).login, `PR event ${index}.actor.login`);
    const label = kind === 'labeled' || kind === 'unlabeled'
      ? nonEmptyString(record(event.label, `PR event ${index}.label`).name, `PR event ${index}.label.name`)
      : undefined;
    return [{ kind, createdAt, actor, label }];
  }).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const latestLabel = [...events].reverse().find((event) => (
    (event.kind === 'labeled' || event.kind === 'unlabeled')
    && event.label === 'review:needs-human'
  ));
  const latestDraft = [...events].reverse().find((event) => (
    event.kind === 'convert_to_draft' || event.kind === 'ready_for_review'
  ));
  return {
    ...(humanLabelPresent && latestLabel?.kind === 'labeled' && latestLabel.actor !== undefined
      ? { humanLabelActor: latestLabel.actor }
      : {}),
    ...(draft && latestDraft?.kind === 'convert_to_draft' && latestDraft.actor !== undefined
      ? { draftActor: latestDraft.actor }
      : {}),
  };
}

export function workflowRunIdFromDetailsUrl(url: unknown): number | undefined {
  if (typeof url !== 'string') return undefined;
  const match = url.match(/\/actions\/runs\/(\d+)(?:\/|$)/);
  if (match === null) return undefined;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function checkRuns(value: unknown): readonly CheckSummary[] {
  const response = record(value, 'check-runs response');
  const parsed = rows(response.check_runs, 'check-runs response.check_runs').map((raw, index) => {
    const check = record(raw, `check run ${index}`);
    const conclusion = check.conclusion;
    if (conclusion !== null && typeof conclusion !== 'string') {
      throw new GitHubRestSchemaError(`check run ${index}.conclusion must be a string or null`);
    }
    const runAttempt = check.run_attempt;
    const suite = check.check_suite === null || check.check_suite === undefined
      ? null
      : record(check.check_suite, `check run ${index}.check_suite`);
    const workflowRunId = workflowRunIdFromDetailsUrl(check.details_url)
      ?? workflowRunIdFromDetailsUrl(
        suite === null
          ? undefined
          : (suite as { workflow_run?: { html_url?: unknown } }).workflow_run?.html_url,
      );
    return {
      name: nonEmptyString(check.name, `check run ${index}.name`),
      status: nonEmptyString(check.status, `check run ${index}.status`).toUpperCase(),
      conclusion: conclusion?.toUpperCase() ?? null,
      source: 'check-run' as const,
      ...(workflowRunId === undefined ? {} : { runId: workflowRunId }),
      ...(suite === null ? {} : {
        checkSuiteId: nonNegativeInteger(suite.id, `check run ${index}.check_suite.id`),
      }),
      ...(runAttempt === undefined || runAttempt === null ? {} : {
        runAttempt: nonNegativeInteger(runAttempt, `check run ${index}.run_attempt`),
      }),
    };
  });
  if (nonNegativeInteger(response.total_count, 'check-runs response.total_count') !== parsed.length) {
    throw new GitHubRestSchemaError('check-runs response is incomplete');
  }
  return parsed;
}

function commitStatuses(value: unknown): readonly CheckSummary[] {
  const response = record(value, 'commit-status response');
  nonEmptyString(response.state, 'commit-status response.state');
  const parsed = rows(response.statuses, 'commit-status response.statuses').map((raw, index) => {
    const status = record(raw, `commit status ${index}`);
    return {
      name: nonEmptyString(status.context, `commit status ${index}.context`),
      status: 'COMPLETED',
      conclusion: nonEmptyString(status.state, `commit status ${index}.state`).toUpperCase(),
      source: 'commit-status' as const,
    };
  });
  if (nonNegativeInteger(response.total_count, 'commit-status response.total_count') !== parsed.length) {
    throw new GitHubRestSchemaError('commit-status response is incomplete');
  }
  return parsed;
}

function canonical<Value>(values: readonly Value[]): string {
  return JSON.stringify([...values].sort((left, right) => (
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  )));
}

function normalizeCheckForComparison(check: CheckSummary): {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly runId?: number;
} {
  return {
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
    ...(check.runId === undefined ? {} : { runId: check.runId }),
  };
}

function canonicalChecks(checks: readonly CheckSummary[]): string {
  return canonical(checks.map(normalizeCheckForComparison));
}

export class ConditionalPullRequestEvidenceProbe implements PullRequestEvidenceProbe {
  constructor(
    private readonly rest: ConditionalRestClient,
    private readonly repositorySlug: string = REPO,
    private readonly baseBranchTipReader?: BaseBranchTipReader,
  ) {}

  async changed(pr: PullRequestSnapshot): Promise<boolean> {
    if (pr.state !== 'OPEN') return false;
    if (pr.evidenceIncompleteReason !== undefined) return true;
    // Merge-path PRs without proven compare evidence must refresh before any
    // conditional reuse. The live base-tip read is deferred until after the
    // conditional evidence below so schema and identity guards keep running.
    if (
      mergePathPullRequest(pr)
      && (
        pr.compareStatus === undefined
        || pr.compareStatus === 'unknown'
        || pr.compareBaseTipOid === undefined
      )
    ) {
      return true;
    }
    const detailResponse = await this.rest.getJson(
      `repos/${this.repositorySlug}/pulls/${pr.number}`,
    );
    const detailRaw = completeBody(detailResponse, 'PR detail');
    const detailRecord = record(detailRaw, 'PR detail');
    if (detailRecord.number !== pr.number) {
      throw new GitHubRestSchemaError(
        `PR detail identity #${String(detailRecord.number)} does not match #${pr.number}`,
      );
    }
    const head = record(detailRecord.head, 'PR detail.head');
    const liveHeadOid = nonEmptyString(head.sha, 'PR detail.head.sha');
    gitOid(liveHeadOid);
    if (liveHeadOid !== pr.headOid) {
      // Index/cache head can lag a push. Mark it changed so the incremental
      // refresh continues rather than aborting the entire lifecycle cycle.
      return true;
    }
    const reviewResponse = await this.rest.getJson(
      `repos/${this.repositorySlug}/pulls/${pr.number}/reviews?per_page=100&page=1`,
    );
    const commentResponse = await this.rest.getJson(
      `repos/${this.repositorySlug}/issues/${pr.number}/comments?per_page=100&page=1`,
    );
    const eventResponse = await this.rest.getJson(
      `repos/${this.repositorySlug}/issues/${pr.number}/events?per_page=100&page=1`,
    );
    const checkResponse = await this.rest.getJson(
      `repos/${this.repositorySlug}/commits/${pr.headOid}/check-runs?per_page=100&page=1`,
    );
    const statusResponse = await this.rest.getJson(
      `repos/${this.repositorySlug}/commits/${pr.headOid}/status?per_page=100&page=1`,
    );
    const detail = exactPullRequestDetail(detailRaw, pr);
    const currentReviews = reviews(completeBody(reviewResponse, 'PR reviews'));
    let currentHuman: ReturnType<typeof latestHuman>;
    try {
      currentHuman = latestHuman(
        completeBody(commentResponse, 'PR comments'),
        pr.number,
      );
    } catch {
      // Comments are audit/migration evidence only. If that audit surface is
      // malformed or truncated, force a canonical refresh; never let comment
      // prose or marker shape abort the lifecycle cycle.
      return true;
    }
    const currentActors = currentSurfaceActors(
      completeBody(eventResponse, 'PR events'),
      detail.labels.includes('review:needs-human'),
      detail.isDraft,
    );
    const currentChecks = [
      ...checkRuns(completeBody(checkResponse, 'check runs')),
      ...commitStatuses(completeBody(statusResponse, 'commit statuses')),
    ];
    const cachedHuman = pr.humanReason === undefined
      ? null
      : {
          ...(pr.humanIssueNumber === undefined ? {} : { issueNumber: pr.humanIssueNumber }),
          ...(pr.humanAuthor === undefined ? {} : { author: pr.humanAuthor }),
          ...(pr.humanHead === undefined ? {} : { head: pr.humanHead }),
          ...(pr.humanGeneration === undefined ? {} : { generation: pr.humanGeneration }),
          ...(pr.humanDiagnosticIssueNumbers === undefined
            ? {}
            : {
                diagnosticIssueNumbers: pr.humanDiagnosticIssueNumbers,
                diagnosticSignature: pr.humanDiagnosticSignature,
              }),
          reason: pr.humanReason,
        };
    const cachedActors = {
      ...(pr.humanLabelActor === undefined ? {} : { humanLabelActor: pr.humanLabelActor }),
      ...(pr.draftActor === undefined ? {} : { draftActor: pr.draftActor }),
    };
    const cachedDetail = {
      title: pr.title,
      body: pr.body,
      author: pr.author,
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      isDraft: pr.isDraft,
      state: pr.state,
      labels: pr.labels,
      mergeability: pr.mergeability,
      mergeStateStatus: pr.mergeStateStatus,
      // Merge-queue membership is GraphQL-only evidence — `isInMergeQueue` and
      // `mergeQueueEntry` have no counterpart on the REST pull detail read
      // above — so the live side of this comparison is silence, and a cached
      // membership never matches it. That is the intended reading, not a gap:
      // membership is the one lifecycle fact that can lapse with every other
      // term of this predicate reading identical, because an ejection changes
      // no review, comment, event, check or label. A stale `true` would
      // suppress the re-enqueue of an ejected head forever, so a PR proven to
      // be sitting in the queue is always re-read canonically.
      //
      // Only a proven membership joins the key, and deliberately not the
      // entry's position or state: those churn as the queue advances, and
      // paying a canonical read for each move would spend the whole incremental
      // budget on PRs the engine is already correctly leaving alone. A cached
      // *absence* costs nothing either — a PR a human queued behind the
      // engine's back is caught at the mutation, which answers already-enqueued.
      ...(pr.mergeQueue?.enqueued === true ? { inMergeQueue: true } : {}),
    };
    return (await compareEvidenceNeedsRefresh(pr, this.baseBranchTipReader))
      || JSON.stringify({ ...detail, labels: [...detail.labels].sort() })
        !== JSON.stringify({ ...cachedDetail, labels: [...cachedDetail.labels].sort() })
      || canonical(currentReviews) !== canonical(pr.reviews)
      || JSON.stringify(currentHuman) !== JSON.stringify(cachedHuman)
      || JSON.stringify(currentActors) !== JSON.stringify(cachedActors)
      || canonicalChecks(currentChecks) !== canonicalChecks(pr.checks);
  }
}
