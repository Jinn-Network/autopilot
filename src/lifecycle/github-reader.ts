import {
  GhIssueSource,
  defaultRunner,
  type CommandRunner,
} from '../dispatcher/issue-source.js';
import {
  fetchProjectSnapshot,
  type ProjectSnapshot,
} from '../dispatcher/project-snapshot.js';
import type { IssueBoardState } from '../dispatcher/issue-source.js';
import { PROJECT_NUMBER, REPO } from '../dispatcher/constants.js';
import type {
  BlockedOn,
  Effort,
  IssueShape,
  Priority,
  ProjectStatus,
} from '../dispatcher/types.js';
import { ISSUE_SHAPE_SET } from '../dispatcher/types.js';
import type {
  GitHubLifecycleReader,
  PullRequestPage,
  RawBranchClaim,
  RawNativeReview,
  RawPullRequest,
} from './snapshot.js';
import { queueEligibleMergeStateStatus } from './snapshot.js';
import {
  decodeBranchClaimTrailers,
  decodeReviewClaimPayload,
  extractImplementationCompletionSummary,
  parseHumanCommentEvidence,
  reviewClaimRef,
  terminalBranchClaimTrailers,
} from './codecs.js';
import { CANONICAL_GITHUB_HTTPS_REMOTE } from './implementation-executor.js';
import { readExactCompareEvidence } from './github-changed-files.js';
import { classifyTransportFault, gatewayStatusFromFailure } from './transient-retry.js';
import { gitOid, gitRefName, type GitOid, type GitRefName } from './types.js';
import {
  ENQUEUE_HOLD_REF_GLOB,
  parseEnqueueHoldRef,
  type EnqueueHoldKind,
} from './enqueue-hold.js';
import {
  GitHubUsageMeter,
  makeGitHubUsageCommandRunner,
  TARGETED_RELATION_RESERVE,
  type GitHubUsage,
} from './github-usage.js';
export { extractImplementationCompletionSummary } from './codecs.js';

export const REVIEW_CLAIM_PAYLOAD_FILE = 'jinn-autopilot-review.json';
const PR_PAGE_SIZE = 50;
/**
 * The adaptive downshift's floor and attempt cap for the full-reconciliation
 * page read (#130). One page carries `PR_FIELDS` per node — reviews(100),
 * labels(100), closingIssuesReferences(20) and a 100-context check rollup — so
 * its server-side execution cost grows with the repository, and past some size
 * GitHub stops executing and either resets the HTTP/2 stream instead of
 * answering (#130) or serves a gateway status in its place (#134).
 * Re-sending that same page at that same size is the one retry that cannot
 * work, and it is exactly what the transport retry beneath this
 * (`withTransientReadRetry`) does; halving the page is the retry that can.
 *
 * From the default the ladder is 50 → 25 → 12 → 10, where the two bounds agree:
 * the third downshift is also the point at which halving stops making progress
 * against the floor. Below ~10 a page buys too little per round trip to be
 * worth another attempt, and a repository whose 10-node page cannot execute has
 * a fault this read cannot route around — so it fails, as before.
 */
const MIN_PR_PAGE_SIZE = 10;
const MAX_PR_PAGE_DOWNSHIFTS = 3;
const MERGED_ISSUE_BATCH_SIZE = 20;
const COMMIT_HISTORY_PAGE_SIZE = 100;
const MAX_COMMIT_HISTORY_PAGES = 100;
const CHECK_CONTEXT_PAGE_SIZE = 100;
/**
 * Total check-context pages one PR's status rollup may span, first page
 * included — 1000 contexts. A workflow-touching change fans CI out well past
 * the single 100-node page GitHub returns by default (mono PR #2918, a
 * dependabot `actions/upload-artifact` bump, carries 144 contexts on its head
 * commit), so a single page is not enough to call the check evidence complete.
 * Past this cap the read still fails closed with the truncation error rather
 * than paginating without bound.
 */
const MAX_CHECK_CONTEXT_PAGES = 10;

const CHECK_CONTEXT_FIELDS = `
            pageInfo { hasNextPage endCursor }
            nodes {
              __typename
              ... on CheckRun {
                name
                status
                conclusion
                databaseId
                checkSuite { workflowRun { databaseId } }
              }
              ... on StatusContext { context state }
            }`;

const PR_FIELDS = `
        id number title body updatedAt baseRefName headRefName headRefOid isDraft state
        isInMergeQueue
        mergeQueueEntry { position state enqueuedAt }
        author { login }
        labels(first: 100) { pageInfo { hasNextPage } nodes { name } }
        closingIssuesReferences(first: 20) { pageInfo { hasNextPage } nodes { number } }
        mergeable mergeStateStatus mergedAt mergeCommit { oid }
        commits(last: 100) {
          pageInfo { hasPreviousPage }
          nodes { commit { oid committedDate message } }
        }
        reviews(first: 100) {
          pageInfo { hasNextPage }
          nodes {
            author { login }
            state
            commit { oid }
            body
            submittedAt
          }
        }
        comments(last: 100) {
          pageInfo { hasPreviousPage }
          nodes { fullDatabaseId body author { login } }
        }
        timelineItems(last: 100, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, CONVERT_TO_DRAFT_EVENT, READY_FOR_REVIEW_EVENT]) {
          pageInfo { hasPreviousPage }
          nodes {
            __typename
            ... on LabeledEvent { actor { login } createdAt label { name } }
            ... on UnlabeledEvent { actor { login } createdAt label { name } }
            ... on ConvertToDraftEvent { actor { login } createdAt }
            ... on ReadyForReviewEvent { actor { login } createdAt }
          }
        }
        statusCheckRollup {
          contexts(first: ${CHECK_CONTEXT_PAGE_SIZE}) {${CHECK_CONTEXT_FIELDS}
          }
        }`;

/**
 * Follow-up read for one PR's remaining check-context pages. Scoped to the
 * single PR whose first page reported `hasNextPage`, so a 144-context outlier
 * costs one extra targeted query instead of widening the batched page read for
 * every PR. Runs through the same metered `gh api graphql` path as every other
 * read, so its cost lands in the cycle's usage meter.
 */
const CHECK_CONTEXTS_PAGE_QUERY =
  `query($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      statusCheckRollup {
        contexts(first: ${CHECK_CONTEXT_PAGE_SIZE}, after: $cursor) {${CHECK_CONTEXT_FIELDS}
        }
      }
    }
  }
}`;

const MERGED_PR_FIELDS = `
        number title body baseRefName headRefName headRefOid isDraft state
        author { login }
        labels(first: 100) { pageInfo { hasNextPage } nodes { name } }
        closingIssuesReferences(first: 20) { pageInfo { hasNextPage } nodes { number } }
        mergeable mergeStateStatus mergedAt mergeCommit { oid }
        commits(last: 1) {
          nodes { commit { oid committedDate } }
        }`;

/**
 * The full-reconciliation page read, at a given page size. The size is the only
 * thing the adaptive downshift varies: the field set is identical at every rung,
 * so a downshifted page yields the same evidence per node as a full one and no
 * decode path sees a different shape.
 */
function pullRequestPageQuery(pageSize: number): string {
  return `query($owner: String!, $name: String!, $cursor: String) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequests(first: ${pageSize}, after: $cursor, states: [OPEN], orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${PR_FIELDS}
      }
    }
  }
}`;
}

const PR_BY_NUMBER_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${PR_FIELDS}
    }
  }
}`;

const TARGETED_CLOSING_ISSUE_LIMIT = 20;

function closingPullRequestNumbersQuery(issueNumbers: readonly number[]): string {
  const issues = issueNumbers.map((number) => `
    issue${number}: issue(number: ${number}) {
      closedByPullRequestsReferences(first: 100, includeClosedPrs: true) {
        pageInfo { hasNextPage }
        nodes { number state }
      }
    }`).join('\n');
  return `query IncrementalClosingPullRequests($owner: String!, $name: String!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
${issues}
  }
}`;
}

function mergedOutcomesQuery(issueNumbers: readonly number[]): string {
  const issues = issueNumbers.map((number) => `
    issue${number}: issue(number: ${number}) {
      closedByPullRequestsReferences(first: 100, includeClosedPrs: true) {
        pageInfo { hasNextPage }
        nodes { ${MERGED_PR_FIELDS} }
      }
    }`).join('\n');
  return `query($owner: String!, $name: String!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
${issues}
  }
}`;
}

// GitHub's GraphQL `repository.ref(qualifiedName:)` returns null forever for
// refs under a custom namespace like `refs/jinn-autopilot/...` — proven live
// (jinn-mono#1883-follow-up): a direct query against a ref that demonstrably
// exists via `git ls-remote` still resolves to null, while the identical
// query shape against `refs/heads/next` resolves fine. Every review-claim
// read below therefore goes over the git transport instead (the mechanism
// the live capability probe already validates — see capability-probe.ts).
export const REVIEW_CLAIM_REF_PREFIX = 'refs/jinn-autopilot/review-claims/v1/';
export const REVIEW_CLAIM_REF_GLOB = `${REVIEW_CLAIM_REF_PREFIX}*`;
export const CI_RERUN_REF_PREFIX = 'refs/jinn-autopilot/ci-reruns/v1/pr-';
export const CI_RERUN_REF_GLOB = `${CI_RERUN_REF_PREFIX}*`;
const AUTOPILOT_BRANCH_REF_PREFIX = 'refs/heads/autopilot/';
export const AUTOPILOT_BRANCH_REF_GLOB = `${AUTOPILOT_BRANCH_REF_PREFIX}*`;

/**
 * Parses `git ls-remote <remote> '<REVIEW_CLAIM_REF_GLOB>'` output into a
 * map of ref suffix (the text after the fixed prefix) -> OID. A line that
 * cannot be split into an exact (oid, ref) pair, or whose ref falls outside
 * the requested prefix, is a transport-level parsing failure and throws.
 * A well-formed ref under the prefix whose suffix is not a PR number (e.g. a
 * capability-probe's disposable `capability-<uuid>` ref, see
 * capability-probe.ts) is not itself malformed — callers filter by shape.
 */
export function parseReviewClaimRefGitListing(raw: string): Map<string, GitOid> {
  const trimmed = raw.trimEnd();
  const listing = new Map<string, GitOid>();
  if (trimmed.length === 0) return listing;
  for (const line of trimmed.split('\n')) {
    const fields = line.split('\t');
    const [oid, ref] = fields;
    if (
      fields.length !== 2
      || oid === undefined || oid.length === 0
      || ref === undefined || !ref.startsWith(REVIEW_CLAIM_REF_PREFIX)
    ) {
      throw new Error('Malformed git ls-remote output for review-claim refs');
    }
    listing.set(ref.slice(REVIEW_CLAIM_REF_PREFIX.length), gitOid(oid));
  }
  return listing;
}

function parseSingleReviewClaimRef(raw: string, ref: GitRefName): GitOid | null {
  const trimmed = raw.trimEnd();
  if (trimmed.length === 0) return null;
  const lines = trimmed.split('\n');
  if (lines.length !== 1) {
    throw new Error(`Review claim ${ref} ls-remote is ambiguous`);
  }
  const fields = lines[0]!.split('\t');
  const [oid, matchedRef] = fields;
  if (fields.length !== 2 || oid === undefined || oid.length === 0 || matchedRef !== ref) {
    throw new Error('Malformed git ls-remote output for review-claim ref');
  }
  return gitOid(oid);
}

/**
 * Single-issue targeted read of its Project item's `Status` / `Blocked on`
 * fields (jinn-mono#1883 cost defect): the same `fieldValueByName` shape the
 * world Project-board snapshot (`fetchProjectSnapshot`) reads for every
 * item, scoped to one issue via `Issue.projectItems` instead of paginating
 * the whole board (~91 pages measured on the live board).
 *
 * The issue type is read off the native `Issue.issueType`, not off the board:
 * the Project's "Type" column is a read-only projection of the native type and
 * GraphQL exposes no `ProjectV2` field by that name, so
 * `fieldValueByName(name: "Type")` resolves to null for every item. Only REST
 * projects the native type as a board field (`data_type: 'issue_type'`), which
 * is why the incremental snapshot reads it from REST while every GraphQL path
 * reads the native field: `content { ... on Issue { issueType } }` in the board
 * snapshot, `issue { issueType }` here.
 */
const PROJECT_ITEM_BY_ISSUE_QUERY =
`query($owner: String!, $name: String!, $number: Int!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      issueType { name }
      projectItems(first: 10) {
        pageInfo { hasNextPage }
        nodes {
          id
          project { number }
          status:    fieldValueByName(name: "Status")     { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          priority:  fieldValueByName(name: "Priority")   { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          effort:    fieldValueByName(name: "Effort")     { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          blockedOn: fieldValueByName(name: "Blocked on") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
        }
      }
    }
  }
}`;

/**
 * Same trap as `PROJECT_ITEM_BY_ISSUE_QUERY` above: the issue type must be read
 * off the native `Issue.issueType`, never off a `fieldValueByName(name: "Type")`
 * that GraphQL will silently resolve to null forever.
 */
const ISSUE_ACTION_CONTEXT_QUERY =
`query($owner: String!, $name: String!, $number: Int!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      issueType { name }
      projectItems(first: 10) {
        pageInfo { hasNextPage }
        nodes {
          id
          project { number }
          status:    fieldValueByName(name: "Status")     { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          priority:  fieldValueByName(name: "Priority")   { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          effort:    fieldValueByName(name: "Effort")     { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          blockedOn: fieldValueByName(name: "Blocked on") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
        }
      }
      closedByPullRequestsReferences(first: 100, includeClosedPrs: true) {
        pageInfo { hasNextPage }
        nodes { number state }
      }
    }
  }
}`;

interface ProjectItemByIssueNode {
  readonly id: string;
  readonly project: { readonly number: number };
  readonly status: { readonly name: string } | null;
  readonly priority: { readonly name: string } | null;
  readonly effort: { readonly name: string } | null;
  readonly blockedOn: { readonly name: string } | null;
}

/** Native `Issue.issueType`; absent or null when the issue has no type set. */
type NativeIssueTypeNode = { readonly name: string } | null | undefined;

interface ProjectItemByIssueResponse {
  data: {
    repository: {
      issue: {
        issueType: NativeIssueTypeNode;
        projectItems: {
          pageInfo: { hasNextPage: boolean };
          nodes: ProjectItemByIssueNode[];
        };
      } | null;
    };
  };
}

interface IssueActionContextResponse {
  data: {
    rateLimit: { cost: number; remaining: number; resetAt: string };
    repository: {
      issue: null | {
        issueType: NativeIssueTypeNode;
        projectItems: {
          pageInfo: { hasNextPage: boolean };
          nodes: ProjectItemByIssueNode[];
        };
        closedByPullRequestsReferences: {
          pageInfo: { hasNextPage: boolean };
          nodes: Array<{ number: number; state: 'OPEN' | 'MERGED' | 'CLOSED' }>;
        };
      };
    };
  };
}

const VALID_PROJECT_STATUS = new Set<string>([
  'Todo', 'In Progress', 'Human', 'In Review', 'Done',
]);
const VALID_BLOCKED_ON = new Set<string>(['Nothing', 'Human', 'Another issue']);
const VALID_PRIORITY = new Set<string>(['P0', 'P1', 'P2', 'P3', 'P4']);
const VALID_EFFORT = new Set<string>(['Low', 'Medium', 'High', 'XHigh', 'Max']);

function parseProjectStatus(name: string | undefined): ProjectStatus | null {
  return name !== undefined && VALID_PROJECT_STATUS.has(name) ? (name as ProjectStatus) : null;
}

function parseBlockedOn(name: string | undefined): BlockedOn | null {
  return name !== undefined && VALID_BLOCKED_ON.has(name) ? (name as BlockedOn) : null;
}

function parseSelected<Value extends string>(
  node: { readonly name: string } | null,
  values: ReadonlySet<string>,
  subject: string,
): Value | null {
  if (node === null) return null;
  if (typeof node.name !== 'string' || !values.has(node.name)) {
    throw new Error(`Targeted Project ${subject} value is unknown`);
  }
  return node.name as Value;
}

/**
 * Coerce an unrecognised native issue type to `null` rather than throwing, so
 * an organisation-defined type outside the lifecycle vocabulary makes the issue
 * ineligible instead of aborting the cycle. Mirrors `parseShape` in
 * `dispatcher/project-snapshot.ts`, which decodes the same native field, and
 * shares its `ISSUE_SHAPE_SET`: re-listing the shapes here would let a tenth
 * shape be accepted by the observer and decoded as `null` by the claim path —
 * the exact divergence this parser exists to close.
 */
function parseNativeIssueType(node: NativeIssueTypeNode): IssueShape | null {
  const name = node?.name;
  if (typeof name !== 'string') return null;
  return ISSUE_SHAPE_SET.has(name as IssueShape) ? (name as IssueShape) : null;
}

function decodeTargetedProjectItem(
  nodes: readonly ProjectItemByIssueNode[],
  nativeIssueType: NativeIssueTypeNode,
  projectNumber = PROJECT_NUMBER,
): {
  readonly id: string;
  readonly status: ProjectStatus | null;
  readonly priority: Priority | null;
  readonly effort: Effort | null;
  readonly blockedOn: BlockedOn | null;
  readonly issueType: IssueShape | null;
} | null {
  const node = nodes.find((candidate) => candidate.project.number === projectNumber);
  if (node === undefined) return null;
  return {
    id: node.id,
    status: parseProjectStatus(node.status?.name),
    priority: parseSelected<Priority>(node.priority, VALID_PRIORITY, 'Priority'),
    effort: parseSelected<Effort>(node.effort, VALID_EFFORT, 'Effort'),
    blockedOn: parseBlockedOn(node.blockedOn?.name),
    issueType: parseNativeIssueType(nativeIssueType),
  };
}

interface GraphQlPage {
  data: {
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: GraphQlPr[];
      };
    };
  };
}

interface GraphQlPrResponse {
  data: {
    repository: {
      pullRequest: GraphQlPr | null;
    };
  };
}

interface GraphQlPr {
  /**
   * The PR's GraphQL node id — the `pullRequestId` the `enqueuePullRequest`
   * mutation takes. Optional so a fixture or a cached page written before #82
   * still decodes; absence means "cannot enqueue", never "enqueue anyway".
   */
  id?: string;
  isInMergeQueue?: boolean;
  mergeQueueEntry?: {
    position?: number | null;
    state?: string | null;
    enqueuedAt?: string | null;
  } | null;
  number: number;
  title: string;
  body: string;
  updatedAt: string;
  author: { login?: string } | null;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  isDraft: boolean;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  labels: {
    pageInfo: { hasNextPage: boolean };
    nodes: Array<{ name: string }>;
  };
  closingIssuesReferences: {
    pageInfo: { hasNextPage: boolean };
    nodes: Array<{ number: number }>;
  };
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  mergedAt: string | null;
  mergeCommit: { oid: string } | null;
  commits: {
    pageInfo: { hasPreviousPage: boolean };
    nodes: Array<{ commit: { oid: string; committedDate: string; message: string } }>;
  };
  reviews: {
    pageInfo: { hasNextPage: boolean };
    nodes: Array<{
      author: { login?: string } | null;
      state: RawNativeReview['state'];
      commit: { oid: string } | null;
      body: string;
      submittedAt: string;
    }>;
  };
  comments: {
    pageInfo: { hasPreviousPage: boolean };
    nodes: Array<{
      fullDatabaseId: string;
      body: string;
      author?: { login?: string } | null;
    }>;
  };
  timelineItems: {
    pageInfo: { hasPreviousPage: boolean };
    nodes: Array<{
      __typename:
        | 'LabeledEvent'
        | 'UnlabeledEvent'
        | 'ConvertToDraftEvent'
        | 'ReadyForReviewEvent';
      actor: { login?: string } | null;
      createdAt: string;
      label?: { name: string };
    }>;
  };
  statusCheckRollup: {
    contexts: GraphQlCheckContexts;
  } | null;
}

interface GraphQlCheckContexts {
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  nodes: Array<{
    __typename: 'CheckRun' | 'StatusContext';
    name?: string;
    status?: string;
    conclusion?: string | null;
    databaseId?: number | null;
    context?: string;
    state?: string;
    checkSuite?: {
      workflowRun?: { databaseId?: number | null } | null;
    } | null;
  }>;
}

interface CheckContextsPageResponse {
  data?: {
    repository: {
      pullRequest: {
        statusCheckRollup: { contexts: GraphQlCheckContexts } | null;
      } | null;
    } | null;
  };
}

interface GraphQlMergedPr {
  number: number;
  title: string;
  body: string;
  author: { login?: string } | null;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  isDraft: boolean;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  labels: {
    pageInfo: { hasNextPage: boolean };
    nodes: Array<{ name: string }>;
  };
  closingIssuesReferences: {
    pageInfo: { hasNextPage: boolean };
    nodes: Array<{ number: number }>;
  };
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  mergedAt: string | null;
  mergeCommit: { oid: string } | null;
  commits: {
    nodes: Array<{ commit: { oid: string; committedDate: string } }>;
  };
}

interface MergedOutcomesResponse {
  data: {
    repository: Record<string, {
      closedByPullRequestsReferences: {
        pageInfo: { hasNextPage: boolean };
        nodes: GraphQlMergedPr[];
      };
    } | null>;
  };
}

function branchTrailers(message: string): string | null {
  return terminalBranchClaimTrailers(message);
}

function matchingBranchTrailers(
  message: string,
  issueNumber?: number,
  prNumber?: number,
): string | null {
  const trailers = branchTrailers(message);
  if (trailers === null) return null;
  let claim: ReturnType<typeof decodeBranchClaimTrailers>;
  try {
    claim = decodeBranchClaimTrailers(trailers);
  } catch {
    return null;
  }
  if (issueNumber !== undefined && claim.issueNumber !== issueNumber) return null;
  if (
    prNumber !== undefined
    && claim.prNumber !== undefined
    && claim.prNumber !== prNumber
  ) {
    return null;
  }
  return trailers;
}

/**
 * Raised for evidence that is scoped to a single PR node and whose validity
 * depends on content any GitHub user can post (comments) or on a page-size
 * cap being exceeded (pagination truncation). Callers isolate this error to
 * the one PR it concerns instead of failing the whole snapshot read — see
 * `readPullRequests` / `readMergedOutcomes`.
 */
export class PrEvidenceInconsistentError extends Error {
  constructor(
    readonly prNumber: number,
    message: string,
    readonly closingIssueNumbersIncomplete = false,
  ) {
    super(message);
    this.name = 'PrEvidenceInconsistentError';
  }
}

/**
 * `contexts` is the PR's check-context connection *after* pagination
 * (`GhLifecycleReader.checkContexts`), not the raw first page off the node —
 * a first page that reported `hasNextPage` is only truncated once the
 * follow-up reads have run out of room.
 */
function assertCompletePrNode(
  pr: GraphQlPr,
  contexts: GraphQlCheckContexts | null,
): void {
  if (pr.labels.pageInfo.hasNextPage) {
    throw new PrEvidenceInconsistentError(pr.number, `PR #${pr.number} labels were truncated`);
  }
  if (pr.closingIssuesReferences.pageInfo.hasNextPage) {
    throw new PrEvidenceInconsistentError(
      pr.number,
      `PR #${pr.number} closing issue references were truncated`,
      true,
    );
  }
  if (pr.reviews.pageInfo.hasNextPage) {
    throw new PrEvidenceInconsistentError(pr.number, `PR #${pr.number} reviews were truncated`);
  }
  if (pr.timelineItems.pageInfo.hasPreviousPage) {
    throw new PrEvidenceInconsistentError(pr.number, `PR #${pr.number} timeline was truncated`);
  }
  if (contexts?.pageInfo.hasNextPage === true) {
    throw new PrEvidenceInconsistentError(pr.number, `PR #${pr.number} checks were truncated`);
  }
}

/**
 * Per-PR completeness check for the merged-outcomes decode path
 * (`readMergedOutcomes`), mirroring `assertCompleteMergedPrNode`'s
 * open-PR sibling `assertCompletePrNode`. Raises `PrEvidenceInconsistentError`
 * so the caller can skip just this one merged PR's contribution instead of
 * failing the whole snapshot (jinn-mono#1883-follow-up: PR #1710 — a real
 * merged PR whose branch was garbage-collected post-merge — was tripping a
 * bare `Error` here and halting every v2 cycle).
 */
function assertCompleteMergedPrNode(pr: GraphQlMergedPr): void {
  if (pr.labels.pageInfo.hasNextPage) {
    throw new PrEvidenceInconsistentError(pr.number, `PR #${pr.number} labels were truncated`);
  }
  if (pr.closingIssuesReferences.pageInfo.hasNextPage) {
    throw new PrEvidenceInconsistentError(
      pr.number,
      `PR #${pr.number} closing issue references were truncated`,
      true,
    );
  }
}

/**
 * Decodes one merged-outcomes PR node, or raises `PrEvidenceInconsistentError`
 * when its evidence can't be trusted (truncated pagination, or a head commit
 * that no longer matches `headRefOid` — e.g. a merged PR whose branch was
 * garbage-collected). Callers must skip the PR on that error rather than
 * assert a Done projection from unverifiable data. Callers must only invoke
 * this for a node already known to be in the `MERGED` state (the caller's
 * OPEN/CLOSED branches are handled separately).
 */
function rawMergedPullRequest(pr: GraphQlMergedPr): RawPullRequest {
  assertCompleteMergedPrNode(pr);
  const latest = pr.commits.nodes.at(-1)?.commit;
  if (latest === undefined || latest.oid !== pr.headRefOid) {
    throw new PrEvidenceInconsistentError(
      pr.number,
      `PR #${pr.number} is missing its exact merged head commit`,
    );
  }
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: pr.author?.login ?? '',
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    headOid: pr.headRefOid,
    headCommittedAt: latest.committedDate,
    isDraft: pr.isDraft,
    state: 'MERGED',
    labels: pr.labels.nodes.map((label) => label.name),
    closingIssueNumbers: pr.closingIssuesReferences.nodes.map((issue) => issue.number),
    mergeability: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    checks: [],
    reviews: [],
    branchClaimTrailers: null,
    reviewClaim: null,
    humanIssueNumber: null,
    humanAuthor: null,
    humanReason: null,
    mergedAt: pr.mergedAt,
    mergeCommitOid: pr.mergeCommit?.oid ?? null,
  };
}

/**
 * Merge-queue membership, read from the two fields that answer it: the boolean
 * GitHub sets on the PR and the entry it exposes while the PR sits in a queue.
 * `enqueued` is true when either says so, because an entry with a state but no
 * flag (or the reverse) still means the PR is in the queue — and a candidate
 * already in the queue must short-circuit rather than be enqueued twice.
 */
function mergeQueueEvidence(pr: GraphQlPr): {
  readonly enqueued: boolean;
  readonly position?: number;
  readonly state?: string;
} {
  const entry = pr.mergeQueueEntry ?? null;
  const enqueued = pr.isInMergeQueue === true || entry !== null;
  return {
    enqueued,
    ...(typeof entry?.position === 'number' && Number.isSafeInteger(entry.position)
      ? { position: entry.position }
      : {}),
    ...(typeof entry?.state === 'string' && entry.state.length > 0
      ? { state: entry.state }
      : {}),
  };
}

function inconsistentPullRequest(
  pr: GraphQlPr,
  error: PrEvidenceInconsistentError,
): RawPullRequest {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: pr.author?.login ?? '',
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    headOid: pr.headRefOid,
    headCommittedAt: pr.commits.nodes.at(-1)?.commit.committedDate ?? new Date(0).toISOString(),
    isDraft: pr.isDraft,
    state: 'OPEN',
    labels: pr.labels.nodes.map((label) => label.name),
    closingIssueNumbers: error.closingIssueNumbersIncomplete
      ? []
      : pr.closingIssuesReferences.nodes.map((issue) => issue.number),
    ...(error.closingIssueNumbersIncomplete
      ? { closingIssueNumbersIncomplete: true as const }
      : {}),
    mergeability: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    checks: [],
    reviews: [],
    evidenceIncompleteReason: error.message,
    branchClaimTrailers: null,
    reviewClaim: null,
    humanIssueNumber: null,
    humanAuthor: null,
    humanReason: null,
    mergedAt: pr.mergedAt,
    mergeCommitOid: pr.mergeCommit?.oid ?? null,
  };
}

/**
 * Is an approval carry in question for this PR right now?
 *
 * True only for a terminal-approved claim that recorded a reviewed-diff digest
 * at a head that is no longer the PR head — exactly the shape `update-branch`
 * produces. Everything else answers false, so the extra changed-file read that
 * proving a digest costs is confined to the PRs that can actually use it.
 *
 * An undecodable payload answers false: an unreadable claim is not evidence
 * that a carry is available.
 */
function reviewedDiffCarryInQuestion(
  reviewClaim: { readonly oid: string; readonly payload: string } | null,
  headOid: string,
): boolean {
  if (reviewClaim === null) return false;
  try {
    const record = decodeReviewClaimPayload(reviewClaim.payload);
    return record.state === 'terminal-approved'
      && record.reviewedDiffDigest !== undefined
      && record.head !== headOid;
  } catch {
    return false;
  }
}

/**
 * Does this pull request need the exact REST compare read?
 *
 * GraphQL's `mergeStateStatus` cannot separate "behind the base" from "conflicts
 * with the base" on its own, and the enqueue stage needs that distinction:
 * behind is the queue's ordinary input, conflicting is the one shape it cannot
 * build a candidate from. So every state the queue can still take gets the
 * compare read — BLOCKED included (issue #82), because a queued pull request
 * and one waiting on a merge-group-only context both report BLOCKED, and
 * skipping the read would leave them with `unknown` compare evidence, which
 * derives as `blocked` and strands them outside the stage.
 */
function queueEligibleMergeState(
  mergeability: RawPullRequest['mergeability'],
  mergeStateStatus: string,
): boolean {
  return mergeability === 'MERGEABLE'
    && queueEligibleMergeStateStatus(mergeStateStatus);
}

function checks(contexts: GraphQlCheckContexts | null): RawPullRequest['checks'] {
  return (contexts?.nodes ?? []).map((node) => (
    node.__typename === 'CheckRun'
      ? {
          name: node.name ?? '',
          status: node.status ?? 'UNKNOWN',
          conclusion: node.conclusion ?? null,
          source: 'check-run' as const,
          ...(node.checkSuite?.workflowRun?.databaseId === undefined
            || node.checkSuite?.workflowRun?.databaseId === null
            ? {}
            : { runId: node.checkSuite.workflowRun.databaseId }),
        }
      : {
          name: node.context ?? '',
          status: 'COMPLETED',
          conclusion: node.state ?? null,
          source: 'commit-status' as const,
        }
  ));
}

export interface GhLifecycleReaderOptions {
  /**
   * Local checkout the git-transport review-claim reads run against
   * (`git -C <repositoryPath> ...`). Defaults to `.` (the process cwd) —
   * production callers (scripts/run-autopilot-v2.ts) always pass the
   * coordinator's own worktree root explicitly.
   */
  readonly repositoryPath?: string;
  /**
   * Remote argument for `ls-remote`/`fetch` — accepts either a configured
   * remote name or a bare URL (git treats both identically). Defaults to
   * the canonical HTTPS URL directly so review-claim reads need no local
   * `git remote add` precondition and work in every mode (observe/recover
   * run this before the runbook's "configure jinn-autopilot-v2" step).
   */
  readonly remoteName?: string;
  /** GitHub owner/name and linked Project number supplied by repository config. */
  readonly repositorySlug?: string;
  readonly projectOwner?: string;
  readonly projectNumber?: number;
  /** Share a cycle-scoped meter with future conditional REST readers. */
  readonly usageMeter?: GitHubUsageMeter;
  /** The supplied runner already records into `usageMeter`. */
  readonly runnerIsMetered?: boolean;
}

export class GhLifecycleReader implements GitHubLifecycleReader {
  private readonly run: CommandRunner;
  private readonly issues: GhIssueSource;
  private readonly repositoryPath: string;
  private readonly remoteName: string;
  private readonly usageMeter: GitHubUsageMeter;
  private readonly repositorySlug: string;
  private readonly repositoryOwner: string;
  private readonly repositoryName: string;
  private readonly projectOwner: string;
  private readonly projectNumber: number;
  // Review-claim metadata commits are content-addressed and append-only: an
  // OID's payload never changes, so this cache never needs invalidation for
  // the life of the reader (jinn-mono#1883-follow-up).
  private readonly reviewClaimPayloadByOid = new Map<GitOid, string>();
  private reviewClaimFetchTail: Promise<void> = Promise.resolve();
  /**
   * The page size the current full reconciliation is reading at. Process-local
   * and nothing else: a downshift lives only until the next reconciliation
   * starts, which `readPullRequests` detects by its null cursor and resets. A
   * page that was momentarily too heavy must not permanently shrink pages.
   */
  private prPageSize = PR_PAGE_SIZE;
  private readonly ancestryByCandidate = new Map<string, Promise<{
    readonly headCommittedAt: string;
    readonly claimTrailers: string | null;
    readonly completionSummary: string | null;
  }>>();

  constructor(
    run: CommandRunner = defaultRunner,
    options: GhLifecycleReaderOptions = {},
  ) {
    this.usageMeter = options.usageMeter ?? new GitHubUsageMeter();
    this.run = options.runnerIsMetered === true
      ? run
      : makeGitHubUsageCommandRunner(run, this.usageMeter);
    this.repositorySlug = options.repositorySlug ?? REPO;
    const [repositoryOwner, repositoryName, ...unexpected] =
      this.repositorySlug.split('/');
    if (
      repositoryOwner === undefined
      || repositoryOwner.length === 0
      || repositoryName === undefined
      || repositoryName.length === 0
      || unexpected.length > 0
    ) {
      throw new Error('repositorySlug must be owner/name');
    }
    this.repositoryOwner = repositoryOwner;
    this.repositoryName = repositoryName;
    this.projectOwner = options.projectOwner ?? repositoryOwner;
    this.projectNumber = options.projectNumber ?? PROJECT_NUMBER;
    this.issues = new GhIssueSource(this.run, {
      repositorySlug: this.repositorySlug,
    });
    this.repositoryPath = options.repositoryPath ?? '.';
    this.remoteName = options.remoteName ?? CANONICAL_GITHUB_HTTPS_REMOTE;
  }

  resetGitHubUsage(): void {
    this.usageMeter.reset();
  }

  githubUsage(): GitHubUsage {
    return this.usageMeter.read();
  }

  readProjectSnapshot(): Promise<ProjectSnapshot> {
    return fetchProjectSnapshot(this.run, {
      projectOwner: this.projectOwner,
      projectNumber: this.projectNumber,
      repositorySlug: this.repositorySlug,
    });
  }

  private repositoryVariables(): string[] {
    return [
      '-F', `owner=${this.repositoryOwner}`,
      '-F', `name=${this.repositoryName}`,
    ];
  }

  async readIssues(board: IssueBoardState) {
    // No count guard: a full page is not evidence of truncation. The source
    // paginates to a short page and throws `Open issue pagination exceeded
    // safety limit` if it ever reaches MAX_ISSUE_PAGES, which is the only
    // condition that can actually truncate the set.
    return this.issues.poll(board);
  }

  private gitRun(args: string[]): Promise<string> {
    // GIT_TERMINAL_PROMPT=0: these reads never need a credential (the
    // review-claims repo is public); fail fast instead of hanging if a
    // misconfigured transport ever tries to prompt for one.
    return this.run('git', ['-C', this.repositoryPath, ...args], {
      env: { GIT_TERMINAL_PROMPT: '0' },
    });
  }

  /**
   * One `git ls-remote` for every review-claim ref, replacing the N
   * per-PR GraphQL `ref(qualifiedName:)` reads that GitHub permanently
   * returns null for (jinn-mono#1883-follow-up). Called once per
   * `readPullRequests` page and shared across its open + merged-outcome PRs.
   */
  private async listReviewClaimRefs(): Promise<Map<number, GitOid>> {
    const raw = await this.gitRun(['ls-remote', this.remoteName, REVIEW_CLAIM_REF_GLOB]);
    const bySuffix = parseReviewClaimRefGitListing(raw);
    const byPrNumber = new Map<number, GitOid>();
    for (const [suffix, oid] of bySuffix) {
      if (/^[1-9][0-9]*$/.test(suffix)) byPrNumber.set(Number(suffix), oid);
    }
    return byPrNumber;
  }

  async readReviewClaimRefs(): Promise<ReadonlyMap<number, GitOid>> {
    return this.listReviewClaimRefs();
  }

  /**
   * The enqueue-hold namespace, as one listing per page read — the same shape,
   * and for the same reason, as the ci-rerun listing beside it: a per-pull-
   * request ref read would be one network round trip per PR for a namespace
   * that is empty in the ordinary case.
   *
   * Keyed by `<prNumber>/<head>` so the caller's stamp is head-exact. A ref the
   * strict parser refuses is simply not in the map: the glob is a prefix match
   * and sees every ref anyone puts under the namespace, and none of those may
   * cause a head to be skipped.
   *
   * Public because the transient-retry suite drives it to prove the argv this
   * emits is still on the idempotent-read allowlist.
   */
  async listEnqueueHoldHeads(): Promise<Map<string, EnqueueHoldKind>> {
    const raw = await this.gitRun(['ls-remote', this.remoteName, ENQUEUE_HOLD_REF_GLOB]);
    const trimmed = raw.trimEnd();
    const held = new Map<string, EnqueueHoldKind>();
    if (trimmed.length === 0) return held;
    for (const line of trimmed.split('\n')) {
      const [, ref] = line.split('\t');
      if (ref === undefined) continue;
      const parsed = parseEnqueueHoldRef(ref);
      if (parsed === null) continue;
      held.set(`${parsed.prNumber}/${parsed.head}`, parsed.kind);
    }
    return held;
  }

  private async listCiRerunRecordedHeads(): Promise<Set<string>> {
    const raw = await this.gitRun(['ls-remote', this.remoteName, CI_RERUN_REF_GLOB]);
    const trimmed = raw.trimEnd();
    const recorded = new Set<string>();
    if (trimmed.length === 0) return recorded;
    for (const line of trimmed.split('\n')) {
      const [, ref] = line.split('\t');
      if (ref === undefined || !ref.startsWith(CI_RERUN_REF_PREFIX)) continue;
      recorded.add(ref.slice(CI_RERUN_REF_PREFIX.length));
    }
    return recorded;
  }

  async readBranchHeadForReconciliation(headRefName: string): Promise<GitOid | null> {
    const branch = gitRefName(headRefName);
    const ref = `refs/heads/${branch}`;
    const raw = await this.gitRun(['ls-remote', this.remoteName, ref]);
    const trimmed = raw.trimEnd();
    if (trimmed.length === 0) return null;
    const lines = trimmed.split('\n');
    if (lines.length !== 1) throw new Error(`Branch ${branch} readback is ambiguous`);
    const fields = lines[0]!.split('\t');
    if (fields.length !== 2 || fields[1] !== ref || fields[0] === undefined) {
      throw new Error(`Branch ${branch} readback is malformed`);
    }
    return gitOid(fields[0]);
  }

  async readBranchClaimForReconciliation(
    headRefName: string,
  ): Promise<RawBranchClaim | null> {
    const branch = gitRefName(headRefName);
    const match = /^autopilot\/([1-9][0-9]*)$/.exec(branch);
    if (match?.[1] === undefined) {
      throw new Error(`Branch ${branch} is not a stable Autopilot issue branch`);
    }
    const head = await this.readBranchHeadForReconciliation(branch);
    if (head === null) return null;
    const claims = await this.branchClaimsFromRefs([{
      name: `refs/heads/${branch}`,
      oid: head,
    }]);
    if (claims.length > 1) {
      throw new Error(`Branch ${branch} claim readback is ambiguous`);
    }
    const claim = claims[0];
    if (
      claim === undefined
      || claim.issueNumber !== Number(match[1])
      || claim.headRefName !== branch
      || claim.headOid !== head
    ) {
      return null;
    }
    return claim;
  }

  async readGraphQlRemaining(): Promise<number> {
    const raw = await this.run('gh', [
      'api',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2026-03-10',
      '/rate_limit',
    ]);
    const response = JSON.parse(raw) as {
      resources?: {
        graphql?: {
          remaining?: unknown;
          reset?: unknown;
          limit?: unknown;
          used?: unknown;
        };
      };
    };
    const graphql = response.resources?.graphql;
    const remaining = graphql?.remaining;
    const reset = graphql?.reset;
    const limit = graphql?.limit;
    const used = graphql?.used;
    if (
      !Number.isSafeInteger(remaining)
      || (remaining as number) < 0
      || !Number.isSafeInteger(reset)
      || (reset as number) <= 0
      || !Number.isSafeInteger(limit)
      || (limit as number) <= 0
      || !Number.isSafeInteger(used)
      || (used as number) < 0
      || (remaining as number) + (used as number) !== limit
    ) {
      throw new Error(
        'GitHub REST rate-limit response has invalid resources.graphql quota evidence',
      );
    }
    const resetAt = new Date((reset as number) * 1_000).toISOString();
    this.usageMeter.recordGraphQlQuotaEvidence(remaining, resetAt);
    return remaining as number;
  }

  async readPullRequestNumbersClosingIssues(
    issueNumbers: readonly number[],
  ): Promise<ReadonlySet<number>> {
    return this.readPullRequestNumbersClosingIssuesByState(issueNumbers, false);
  }

  async readPullRequestOutcomeNumbersClosingIssues(
    issueNumbers: readonly number[],
  ): Promise<ReadonlySet<number>> {
    return this.readPullRequestNumbersClosingIssuesByState(issueNumbers, true);
  }

  private async readPullRequestNumbersClosingIssuesByState(
    issueNumbers: readonly number[],
    includeMerged: boolean,
  ): Promise<ReadonlySet<number>> {
    const unique = [...new Set(issueNumbers)].sort((left, right) => left - right);
    for (const number of unique) {
      if (!Number.isSafeInteger(number) || number <= 0) {
        throw new Error('Invalid issue number for closing-PR discovery');
      }
    }
    if (unique.length === 0) return new Set();
    if (unique.length > TARGETED_CLOSING_ISSUE_LIMIT) {
      throw new Error(
        `Targeted closing-PR discovery exceeded ${TARGETED_CLOSING_ISSUE_LIMIT} issues`,
      );
    }
    const raw = await this.run('gh', [
      'api', 'graphql', '-f', `query=${closingPullRequestNumbersQuery(unique)}`,
      ...this.repositoryVariables(),
    ]);
    const decoded = JSON.parse(raw) as unknown;
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      throw new Error('Targeted closing-PR response must be an object');
    }
    if (Object.hasOwn(decoded, 'errors')) {
      const errors = (decoded as { errors?: unknown }).errors;
      if (!Array.isArray(errors)) {
        throw new Error('Targeted closing-PR GraphQL errors member is malformed');
      }
      if (errors.length > 0) {
        throw new Error('Targeted closing-PR response contains GraphQL errors');
      }
    }
    const data = (decoded as { data?: unknown }).data;
    if (typeof data !== 'object' || data === null) {
      throw new Error('Targeted closing-PR response data is missing');
    }
    const rateLimit = (data as { rateLimit?: unknown }).rateLimit;
    const cost = typeof rateLimit === 'object' && rateLimit !== null
      ? (rateLimit as { cost?: unknown }).cost
      : undefined;
    if (typeof cost === 'number' && cost > TARGETED_RELATION_RESERVE) {
      throw new Error(
        `Targeted closing-PR context cost ${cost} exceeded `
        + `${TARGETED_RELATION_RESERVE}-point reserve`,
      );
    }
    const repository = (data as { repository?: unknown }).repository;
    if (typeof repository !== 'object' || repository === null) {
      throw new Error('Targeted closing-PR repository is missing');
    }
    const result = new Set<number>();
    for (const issueNumber of unique) {
      const issue = (repository as Record<string, unknown>)[`issue${issueNumber}`];
      if (issue === null) {
        throw new Error(`Targeted closing-PR issue #${issueNumber} resolved to null`);
      }
      if (typeof issue !== 'object') {
        throw new Error(`Targeted closing-PR issue #${issueNumber} is malformed`);
      }
      const connection = (issue as { closedByPullRequestsReferences?: unknown })
        .closedByPullRequestsReferences;
      if (typeof connection !== 'object' || connection === null) {
        throw new Error(`Targeted closing-PR issue #${issueNumber} connection is missing`);
      }
      const pageInfo = (connection as { pageInfo?: unknown }).pageInfo;
      if (typeof pageInfo !== 'object' || pageInfo === null) {
        throw new Error(`Targeted closing-PR issue #${issueNumber} pageInfo is missing`);
      }
      const hasNextPage = (pageInfo as { hasNextPage?: unknown }).hasNextPage;
      if (typeof hasNextPage !== 'boolean') {
        throw new Error(`Targeted closing-PR issue #${issueNumber} pagination is malformed`);
      }
      if (hasNextPage) {
        throw new Error(`Targeted closing-PR issue #${issueNumber} pagination is truncated`);
      }
      const nodes = (connection as { nodes?: unknown }).nodes;
      if (!Array.isArray(nodes)) {
        throw new Error(`Targeted closing-PR issue #${issueNumber} nodes are missing`);
      }
      for (const node of nodes) {
        if (typeof node !== 'object' || node === null) {
          throw new Error(`Targeted closing-PR issue #${issueNumber} node is malformed`);
        }
        const number = (node as { number?: unknown }).number;
        const state = (node as { state?: unknown }).state;
        if (!Number.isSafeInteger(number) || (number as number) <= 0) {
          throw new Error(`Targeted closing-PR issue #${issueNumber} PR number is invalid`);
        }
        if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') {
          throw new Error(`Targeted closing-PR issue #${issueNumber} PR state is unknown`);
        }
        if (state === 'OPEN' || (includeMerged && state === 'MERGED')) {
          result.add(number as number);
        }
      }
    }
    return result;
  }

  /** Targeted single-ref read for the reconciliation single-PR path. */
  private async readSingleReviewClaimRef(ref: GitRefName): Promise<GitOid | null> {
    const raw = await this.gitRun(['ls-remote', this.remoteName, ref]);
    return parseSingleReviewClaimRef(raw, ref);
  }

  private async objectExistsLocally(oid: GitOid): Promise<boolean> {
    try {
      await this.gitRun(['cat-file', '-e', oid]);
      return true;
    } catch {
      return false;
    }
  }

  private async fetchReviewClaimRef(ref: GitRefName): Promise<void> {
    const pending = this.reviewClaimFetchTail.then(async () => {
      await this.gitRun(['fetch', '--no-tags', '--depth=1', this.remoteName, ref]);
    });
    this.reviewClaimFetchTail = pending.catch(() => undefined);
    await pending;
  }

  /**
   * Reads the `jinn-autopilot-review.json` payload for a review-claim
   * commit OID, fetching it over git only on a local cache miss (an OID
   * already present locally — e.g. just pushed by this same process —
   * costs no network call). Cached by OID afterward: content-addressed,
   * append-only, so an OID's payload never needs refetching.
   */
  private async readReviewClaimPayload(ref: GitRefName, oid: GitOid): Promise<string> {
    const cached = this.reviewClaimPayloadByOid.get(oid);
    if (cached !== undefined) return cached;
    if (!(await this.objectExistsLocally(oid))) {
      await this.fetchReviewClaimRef(ref);
    }
    let payload: string;
    try {
      payload = await this.gitRun(['cat-file', '-p', `${oid}:${REVIEW_CLAIM_PAYLOAD_FILE}`]);
    } catch {
      throw new Error(`Review claim ${ref} is missing ${REVIEW_CLAIM_PAYLOAD_FILE}`);
    }
    this.reviewClaimPayloadByOid.set(oid, payload);
    return payload;
  }

  private async reviewClaim(
    prNumber: number,
    listing?: ReadonlyMap<number, GitOid>,
  ): Promise<RawPullRequest['reviewClaim']> {
    const ref = reviewClaimRef(prNumber);
    const oid = listing !== undefined
      ? listing.get(prNumber) ?? null
      : await this.readSingleReviewClaimRef(ref);
    if (oid === null) return null;
    const payload = await this.readReviewClaimPayload(ref, oid);
    return { oid, payload };
  }

  private branchAncestry(
    headOid: string,
    issueNumber?: number,
    prNumber?: number,
  ): Promise<{
    readonly headCommittedAt: string;
    readonly claimTrailers: string | null;
    readonly completionSummary: string | null;
  }> {
    const cacheKey = `${headOid}:${issueNumber ?? '*'}:${prNumber ?? '*'}`;
    const cached = this.ancestryByCandidate.get(cacheKey);
    if (cached !== undefined) return cached;
    const pending = this.readBranchAncestry(headOid, issueNumber, prNumber)
      .catch((error: unknown) => {
        this.ancestryByCandidate.delete(cacheKey);
        throw error;
      });
    this.ancestryByCandidate.set(cacheKey, pending);
    return pending;
  }

  private async readBranchAncestry(
    headOid: string,
    issueNumber?: number,
    prNumber?: number,
  ): Promise<{
    readonly headCommittedAt: string;
    readonly claimTrailers: string | null;
    readonly completionSummary: string | null;
  }> {
    let headCommittedAt: string | undefined;
    for (let page = 1; page <= MAX_COMMIT_HISTORY_PAGES; page += 1) {
      const endpoint = `repos/${this.repositorySlug}/commits?sha=${encodeURIComponent(headOid)}`
        + `&per_page=${COMMIT_HISTORY_PAGE_SIZE}&page=${page}`;
      const raw = await this.run('gh', ['api', endpoint]);
      const commits = JSON.parse(raw) as Array<{
        sha?: string;
        commit?: { message?: string; committer?: { date?: string } };
      }>;
      if (!Array.isArray(commits)) throw new Error(`Branch ${headOid} ancestry is malformed`);
      if (page === 1) {
        const head = commits[0];
        if (head?.sha !== headOid) {
          throw new Error(`Branch ${headOid} ancestry is missing its exact head`);
        }
        headCommittedAt = head.commit?.committer?.date;
        if (typeof headCommittedAt !== 'string') {
          throw new Error(`Branch ${headOid} is missing its GitHub commit time`);
        }
      }
      const evidence = commits
        .map((commit) => {
          const message = commit.commit?.message ?? '';
          const claimTrailers = matchingBranchTrailers(message, issueNumber, prNumber);
          return claimTrailers === null
            ? null
            : {
                claimTrailers,
                completionSummary: extractImplementationCompletionSummary(
                  message,
                  claimTrailers,
                ),
              };
        })
        .find((candidate) => candidate !== null) ?? null;
      if (evidence !== null) return { headCommittedAt: headCommittedAt!, ...evidence };
      if (commits.length < COMMIT_HISTORY_PAGE_SIZE) {
        return {
          headCommittedAt: headCommittedAt!,
          claimTrailers: null,
          completionSummary: null,
        };
      }
    }
    throw new Error(`Branch ${headOid} ancestry pagination exceeded safety limit`);
  }

  /**
   * Completes one PR's check-context evidence when its rollup ran past the
   * first page.
   *
   * The batched PR read asks for the first `CHECK_CONTEXT_PAGE_SIZE` contexts;
   * a change that touches the workflows fans CI out beyond that (mono PR #2918
   * carries 144 contexts), and a first page alone is *not* complete evidence —
   * `assertCompletePrNode` rightly refuses it, which used to strand the whole
   * snapshot as incomplete and, with no cache to fall back on, killed every
   * bootstrap. So walk that one PR's remaining pages and merge them, rather
   * than weaken the completeness invariant.
   *
   * Returns the node's own connection untouched when its first page already
   * held every context, and `null` when the PR has no status rollup at all.
   * Past `MAX_CHECK_CONTEXT_PAGES` the returned connection still reports
   * `hasNextPage`, so the caller's truncation guard fires exactly as before —
   * bounded work, fail-closed at the bound.
   */
  private async checkContexts(pr: GraphQlPr): Promise<GraphQlCheckContexts | null> {
    const rollup = pr.statusCheckRollup ?? null;
    if (rollup === null) return null;
    if (!rollup.contexts.pageInfo.hasNextPage) return rollup.contexts;
    const nodes = [...rollup.contexts.nodes];
    let pageInfo = rollup.contexts.pageInfo;
    for (let page = 1; page < MAX_CHECK_CONTEXT_PAGES; page += 1) {
      const cursor = pageInfo.endCursor;
      // A connection that claims a next page but hands back no cursor cannot
      // be followed: leave `hasNextPage` set so the truncation guard fires.
      if (typeof cursor !== 'string' || cursor.length === 0) break;
      const raw = await this.run('gh', [
        'api', 'graphql',
        '-f', `query=${CHECK_CONTEXTS_PAGE_QUERY}`,
        ...this.repositoryVariables(),
        '-F', `number=${pr.number}`,
        '-f', `cursor=${cursor}`,
      ]);
      const response = JSON.parse(raw) as CheckContextsPageResponse;
      const contexts =
        response.data?.repository?.pullRequest?.statusCheckRollup?.contexts;
      if (contexts === undefined || contexts === null) {
        throw new PrEvidenceInconsistentError(
          pr.number,
          `PR #${pr.number} checks were truncated`,
        );
      }
      nodes.push(...contexts.nodes);
      pageInfo = contexts.pageInfo;
      if (!pageInfo.hasNextPage) break;
    }
    return { pageInfo, nodes };
  }

  private async rawPullRequest(
    pr: GraphQlPr,
    includeReviewClaim: boolean,
    reviewClaimListing?: ReadonlyMap<number, GitOid>,
  ): Promise<RawPullRequest> {
    if (pr.state === 'CLOSED') {
      throw new Error(`Closed-unmerged PR #${pr.number} is not an active lifecycle item`);
    }
    const contexts = await this.checkContexts(pr);
    assertCompletePrNode(pr, contexts);
    const latest = pr.commits.nodes.at(-1)?.commit;
    if (latest === undefined || latest.oid !== pr.headRefOid) {
      throw new Error(`PR #${pr.number} is missing its exact current head commit`);
    }
    const branchIssues = new Set(pr.closingIssuesReferences.nodes.map((issue) => issue.number));
    const stableMatch = /^autopilot\/([1-9][0-9]*)$/.exec(pr.headRefName);
    if (stableMatch !== null) branchIssues.add(Number(stableMatch[1]));
    const branchIssue = branchIssues.size === 1 ? [...branchIssues][0] : undefined;
    let claimEvidence = [...pr.commits.nodes]
      .reverse()
      .map((node) => {
        const claimTrailers = matchingBranchTrailers(
          node.commit.message,
          branchIssue,
          pr.number,
        );
        return claimTrailers === null
          ? null
          : {
              claimTrailers,
              completionSummary: extractImplementationCompletionSummary(
                node.commit.message,
                claimTrailers,
              ),
            };
      })
      .find((candidate) => candidate !== null) ?? null;
    if (claimEvidence === null && includeReviewClaim && pr.commits.pageInfo.hasPreviousPage) {
      const ancestry = await this.branchAncestry(pr.headRefOid, branchIssue, pr.number);
      if (ancestry.claimTrailers !== null) {
        claimEvidence = {
          claimTrailers: ancestry.claimTrailers,
          completionSummary: ancestry.completionSummary,
        };
      }
    }
    const reviews: RawNativeReview[] = pr.reviews.nodes.map((review) => {
      if (review.commit === null) {
        throw new Error(`PR #${pr.number} review is missing exact commit_id`);
      }
      return {
        reviewer: review.author?.login ?? '',
        state: review.state,
        commitId: review.commit.oid,
        body: review.body,
        submittedAt: review.submittedAt,
      };
    });
    let humanEvidence: (
      NonNullable<ReturnType<typeof parseHumanCommentEvidence>>
      & { readonly author?: string }
    ) | undefined;
    try {
      if (pr.comments.pageInfo.hasPreviousPage) {
        throw new Error('structured comment audit is truncated');
      }
      let structured: {
        readonly id: bigint;
        readonly evidence: NonNullable<ReturnType<typeof parseHumanCommentEvidence>>
          & { readonly author?: string };
      } | undefined;
      const structuredIds = new Set<string>();
      for (const comment of pr.comments.nodes) {
        const evidence = parseHumanCommentEvidence(comment.body);
        if (evidence === null) {
          if (comment.body.includes('<!-- jinn-autopilot-human:')) {
            throw new Error('invalid structured Human marker or diagnostic signature');
          }
          continue;
        }
        if (
          !/^[1-9][0-9]*$/.test(comment.fullDatabaseId)
          || structuredIds.has(comment.fullDatabaseId)
        ) {
          throw new Error('invalid structured Human comment database ID order');
        }
        structuredIds.add(comment.fullDatabaseId);
        const candidate = {
          id: BigInt(comment.fullDatabaseId),
          evidence: {
            ...evidence,
            ...(comment.author?.login === undefined
              ? {}
              : { author: comment.author.login }),
          },
        };
        if (structured === undefined || structured.id < candidate.id) {
          structured = candidate;
        }
      }
      humanEvidence = structured?.evidence;
    } catch {
      // Comments are audit-only. Malformed, contradictory, or truncated
      // comment evidence disables signed migration repair for this read, but
      // must not replace the PR's lifecycle authority.
      humanEvidence = undefined;
    }
    if (humanEvidence !== undefined && humanEvidence.prNumber !== pr.number) {
      humanEvidence = undefined;
    }
    const latestHumanLabelEvent = [...pr.timelineItems.nodes]
      .reverse()
      .find((event) => (
        (event.__typename === 'LabeledEvent' || event.__typename === 'UnlabeledEvent')
        && event.label?.name === 'review:needs-human'
      ));
    const latestDraftEvent = [...pr.timelineItems.nodes]
      .reverse()
      .find((event) => (
        event.__typename === 'ConvertToDraftEvent'
        || event.__typename === 'ReadyForReviewEvent'
      ));
    const humanLabelActor = pr.labels.nodes.some((label) => label.name === 'review:needs-human')
      && latestHumanLabelEvent?.__typename === 'LabeledEvent'
      ? latestHumanLabelEvent.actor?.login
      : undefined;
    const draftActor = pr.isDraft
      && latestDraftEvent?.__typename === 'ConvertToDraftEvent'
      ? latestDraftEvent.actor?.login
      : undefined;
    const reviewClaim = includeReviewClaim
      ? await this.reviewClaim(pr.number, reviewClaimListing)
      : null;
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      author: pr.author?.login ?? '',
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      headOid: pr.headRefOid,
      headCommittedAt: latest.committedDate,
      updatedAt: pr.updatedAt,
      ...(typeof pr.id === 'string' && pr.id.length > 0 ? { graphqlId: pr.id } : {}),
      ...(pr.isInMergeQueue === undefined && pr.mergeQueueEntry === undefined
        ? {}
        : { mergeQueue: mergeQueueEvidence(pr) }),
      isDraft: pr.isDraft,
      state: pr.state,
      labels: pr.labels.nodes.map((label) => label.name),
      closingIssueNumbers: pr.closingIssuesReferences.nodes.map((issue) => issue.number),
      mergeability: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
      checks: checks(contexts),
      reviews,
      branchClaimTrailers: claimEvidence?.claimTrailers ?? null,
      implementationCompletionSummary: claimEvidence?.completionSummary ?? null,
      reviewClaim,
      humanIssueNumber: humanEvidence?.issueNumber ?? null,
      humanAuthor: humanEvidence?.author ?? null,
      humanHead: humanEvidence?.head ?? null,
      humanGeneration: humanEvidence?.generation ?? null,
      humanDiagnosticIssueNumbers:
        humanEvidence?.diagnosticIssueNumbers ?? null,
      humanDiagnosticSignature:
        humanEvidence?.diagnosticSignature ?? null,
      humanLabelActor: humanLabelActor ?? null,
      draftActor: draftActor ?? null,
      humanReason: humanEvidence?.reason ?? null,
      mergedAt: pr.mergedAt,
      mergeCommitOid: pr.mergeCommit?.oid ?? null,
      // The compare request answers whether the head is behind its base, and its
      // `files[]` answers what diff the head presents against it. The second
      // answer additionally needs the exact changed-file proof so that this
      // reading is identical to the merge gate's — see `proveReviewedDiff` — and
      // that proof is only paid for when a carry is actually in question, i.e.
      // for a PR that was just update-branched under a recorded approval.
      ...(pr.state === 'OPEN' && queueEligibleMergeState(pr.mergeable, pr.mergeStateStatus)
        ? await readExactCompareEvidence({
            run: this.run,
            prNumber: pr.number,
            expectedHead: gitOid(pr.headRefOid),
            expectedBaseRefName: pr.baseRefName,
            repositorySlug: this.repositorySlug,
            proveReviewedDiff: reviewedDiffCarryInQuestion(reviewClaim, pr.headRefOid),
          }).then((evidence) => {
            if (evidence.unavailableReason !== undefined) {
              // The compare refused: either a concurrent push moved this head
              // between the GraphQL listing and the REST reread (transient —
              // self-heals next cycle), or this PR's base ref is unsafely
              // named (durable — see #108, stays refused until the branch is
              // renamed). Either way `status` is the fail-closed `unknown` and
              // this PR derives `blocked`; the rest of the page is unaffected.
              // `readExactCompareEvidence` already warned with the offending
              // ref for the unsafe-base-ref case; this one is the generic,
              // reason-agnostic backstop.
              console.warn(
                `[github-reader] refusing compare evidence for PR #${pr.number} `
                  + `(continuing): ${evidence.unavailableReason}`,
              );
            }
            // `compareStatus` is stamped unconditionally, `unknown` included:
            // omitting it on a queue-eligible PR derives `clean`, which would
            // turn this refusal into a fail-open.
            return {
              compareStatus: evidence.status,
              ...(evidence.compareBaseTipOid === undefined
                ? {}
                : { compareBaseTipOid: evidence.compareBaseTipOid }),
              ...(evidence.reviewedDiffDigest === undefined
                ? {}
                : { reviewedDiffDigest: evidence.reviewedDiffDigest }),
            };
          })
        : {}),
    };
  }

  private async readMergedOutcomes(
    nonDoneIssueNumbers: readonly number[],
    reviewClaimListing: ReadonlyMap<number, GitOid>,
  ): Promise<{
    readonly nodes: readonly RawPullRequest[];
    readonly closingIssueEvidenceIncomplete: boolean;
    readonly closedUnmergedParentPrs: readonly number[];
  }> {
    const unique = [...new Set(nonDoneIssueNumbers)].sort((left, right) => left - right);
    for (const number of unique) {
      if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Invalid issue number');
    }
    const merged: RawPullRequest[] = [];
    // Issue #62. A closed-unmerged PR is not an active lifecycle item and never
    // becomes one, so it stays out of `merged` — but discarding its *number*
    // collapsed "closed unmerged", "merged and pruned" and "never existed" into
    // one indistinguishable absence, and the review-follow-up hold fails open on
    // absence. This connection is the exact inverse of `closingIssuesReferences`,
    // survives close-unmerged, and is already read for every non-Done board
    // issue — so the numbers are collected here at zero additional API cost.
    // Because the query covers only non-Done issues, a parent leaves this set
    // as soon as every issue it evidences reaches Done: the query *is* the
    // resolution predicate, and needs no separate lookup or persisted state.
    const closedUnmergedParentPrs = new Set<number>();
    let closingIssueEvidenceIncomplete = false;
    for (let offset = 0; offset < unique.length; offset += MERGED_ISSUE_BATCH_SIZE) {
      const batch = unique.slice(offset, offset + MERGED_ISSUE_BATCH_SIZE);
      const query = mergedOutcomesQuery(batch);
      const raw = await this.run('gh', [
        'api', 'graphql', '-f', `query=${query}`,
        ...this.repositoryVariables(),
      ]);
      const response = JSON.parse(raw) as MergedOutcomesResponse;
      for (const number of batch) {
        const connection = response.data.repository[`issue${number}`]
          ?.closedByPullRequestsReferences;
        if (connection === undefined) continue;
        if (connection.pageInfo.hasNextPage) {
          // Pagination cap on this one issue's closing-PR connection — skip only
          // this issue's merged-outcome contribution, not the whole batch/snapshot.
          console.warn(
            `[github-reader] skipping merged outcomes for issue #${number} (continuing): `
              + `closing PR outcomes were truncated`,
          );
          closingIssueEvidenceIncomplete = true;
          continue;
        }
        for (const pr of connection.nodes) {
          if (pr.state === 'OPEN') {
            if (pr.labels.nodes.some((label) => label.name === 'engine:review')) continue;
            const full = await this.readPullRequestByNumber(pr.number);
            if (full.state !== 'OPEN') continue;
            merged.push(
              await this.rawPullRequest(full, true, reviewClaimListing).catch((error: unknown) => {
                if (!(error instanceof PrEvidenceInconsistentError)) throw error;
                return inconsistentPullRequest(full, error);
              }),
            );
            continue;
          }
          if (pr.state === 'CLOSED') {
            closedUnmergedParentPrs.add(pr.number);
            continue;
          }
          // A single merged PR's evidence (truncated pagination, or a head
          // commit that no longer matches headRefOid — e.g. a garbage-collected
          // branch, see PR #1710) must not abort the whole snapshot. Skip just
          // this PR's contribution to merged outcomes: we cannot verify it, so
          // we must not assert a Done projection from it (fail-closed-safe).
          try {
            merged.push(rawMergedPullRequest(pr));
          } catch (error: unknown) {
            if (!(error instanceof PrEvidenceInconsistentError)) throw error;
            closingIssueEvidenceIncomplete = true;
            console.warn(
              `[github-reader] skipping merged PR #${pr.number} evidence (continuing): `
                + error.message,
            );
          }
        }
      }
    }
    return {
      nodes: merged,
      closingIssueEvidenceIncomplete,
      closedUnmergedParentPrs: [...closedUnmergedParentPrs].sort((left, right) => left - right),
    };
  }

  private async readPullRequestByNumber(prNumber: number): Promise<GraphQlPr> {
    const raw = await this.run('gh', [
      'api', 'graphql',
      '-f', `query=${PR_BY_NUMBER_QUERY}`,
      ...this.repositoryVariables(),
      '-F', `number=${prNumber}`,
    ]);
    const response = JSON.parse(raw) as GraphQlPrResponse;
    const pr = response.data.repository.pullRequest;
    if (pr === null) throw new Error(`PR #${prNumber} disappeared during lifecycle read`);
    return pr;
  }

  /**
   * Single-PR read for reconciliation exact-state pre-checks/read-backs
   * (jinn-mono#1883 cost defect): the same per-node GraphQL shape and
   * review-claim ref read (`readPullRequestByNumber` / `reviewClaim`) the
   * world snapshot uses for each PR, without walking the whole open-PR +
   * Project graph to inspect one. ~7-8 GraphQL points versus ~390 for a full
   * `buildGitHubLifecycleSnapshot` call. Returns `null` for a PR that is not
   * open or merged (closed-unmerged is not an active lifecycle item, matching
   * how the world snapshot already excludes it).
   */
  async readPullRequestForReconciliation(prNumber: number): Promise<RawPullRequest | null> {
    const raw = await this.readPullRequestByNumber(prNumber);
    if (raw.state === 'CLOSED') return null;
    return this.rawPullRequest(raw, true).catch((error: unknown) => {
      if (!(error instanceof PrEvidenceInconsistentError)) throw error;
      return inconsistentPullRequest(raw, error);
    });
  }

  /**
   * Single-issue read of its Project item's `id` / `Status` / `Blocked on`
   * (jinn-mono#1883 cost defect): a targeted `Issue.projectItems` lookup
   * instead of paginating the whole Project board to find one item.
   * Returns `null` when the issue has no item on this Project.
   */
  async readProjectItemForReconciliation(issueNumber: number): Promise<{
    readonly id: string;
    readonly status: ProjectStatus | null;
    readonly priority: Priority | null;
    readonly effort: Effort | null;
    readonly blockedOn: BlockedOn | null;
    readonly issueType: IssueShape | null;
  } | null> {
    const raw = await this.run('gh', [
      'api', 'graphql',
      '-f', `query=${PROJECT_ITEM_BY_ISSUE_QUERY}`,
      ...this.repositoryVariables(),
      '-F', `number=${issueNumber}`,
    ]);
    const response = JSON.parse(raw) as ProjectItemByIssueResponse;
    const issue = response.data.repository.issue;
    const projectItems = issue?.projectItems;
    if (projectItems?.pageInfo.hasNextPage === true) {
      throw new Error('Targeted Project-item pagination exceeded its fixed limit');
    }
    const nodes = projectItems?.nodes ?? [];
    return decodeTargetedProjectItem(nodes, issue?.issueType, this.projectNumber);
  }

  /**
   * One issue-scoped query for all GraphQL relation context needed by an
   * action: its Project item and the open PR numbers that close it.
   */
  async readIssueActionContextForReconciliation(issueNumber: number): Promise<{
    readonly projectItem: ReturnType<typeof decodeTargetedProjectItem>;
    readonly openPullRequestNumbers: ReadonlySet<number>;
  }> {
    const raw = await this.run('gh', [
      'api', 'graphql',
      '-f', `query=${ISSUE_ACTION_CONTEXT_QUERY}`,
      ...this.repositoryVariables(),
      '-F', `number=${issueNumber}`,
    ]);
    const response = JSON.parse(raw) as IssueActionContextResponse;
    if (response.data.rateLimit.cost > TARGETED_RELATION_RESERVE) {
      throw new Error(
        `Targeted issue-action context cost ${response.data.rateLimit.cost} exceeded `
        + `${TARGETED_RELATION_RESERVE}-point reserve`,
      );
    }
    const issue = response.data.repository.issue;
    if (issue === null) {
      return { projectItem: null, openPullRequestNumbers: new Set() };
    }
    if (
      issue.projectItems.pageInfo.hasNextPage
      || issue.closedByPullRequestsReferences.pageInfo.hasNextPage
    ) {
      throw new Error('Targeted issue-action context pagination exceeded its fixed limit');
    }
    const openPullRequestNumbers = new Set<number>();
    for (const node of issue.closedByPullRequestsReferences.nodes) {
      if (!Number.isSafeInteger(node.number) || node.number <= 0) {
        throw new Error('Targeted issue-action context returned an invalid PR number');
      }
      if (!['OPEN', 'MERGED', 'CLOSED'].includes(node.state)) {
        throw new Error('Targeted issue-action context returned an unknown PR state');
      }
      if (node.state === 'OPEN') openPullRequestNumbers.add(node.number);
    }
    return {
      projectItem: decodeTargetedProjectItem(
        issue.projectItems.nodes,
        issue.issueType,
        this.projectNumber,
      ),
      openPullRequestNumbers,
    };
  }

  /**
   * One full-reconciliation page, retried at a halved page size when the
   * failure beneath it is the shape of a page GitHub would not execute (#130,
   * #134). The retry that already sits under this one re-sends the identical
   * request, which is the right move for a dropped packet and the wrong one for
   * a page too heavy to answer; only once that has been spent does the size
   * come down.
   *
   * Two presentations of the one fault drive the ladder, because GitHub reports
   * an over-budget page either way: a *classified* transport fault — the stream
   * torn down before an answer exists (#130) — and a served **502/503/504**, a
   * proxy that got to answer first (#134, the shape the live mono stall took
   * fifteen minutes after #130 shipped). The gateway reading is a separate,
   * single-caller classifier ({@link gatewayStatusFromFailure}); the
   * served-response veto that governs every other command, mutations included,
   * is untouched, and the retry beneath this still refuses to re-send a served
   * response at all. Halving is not a re-send: it is a different, smaller
   * request, and this read is idempotent.
   *
   * Every other failure is rethrown on the first attempt exactly as before — a
   * 4xx, a throttle, any other 5xx and a GraphQL `errors` payload, none of which
   * a smaller page answers. A decode failure is not a page-weight signal at all:
   * `JSON.parse` is deliberately outside the loop, so a malformed body fails the
   * read rather than spending the ladder on it.
   *
   * When the ladder is exhausted the failure names the rung it died on, so the
   * operator reads "page size 10 at cursor X still failed" rather than the
   * generic warning; the original error is both quoted and kept as the `cause`.
   */
  private async readPullRequestPage(cursor: string | null): Promise<GraphQlPage> {
    for (let downshift = 0; ; downshift += 1) {
      const pageSize = this.prPageSize;
      const args = [
        'api', 'graphql', '-f', `query=${pullRequestPageQuery(pageSize)}`,
        ...this.repositoryVariables(),
      ];
      if (cursor !== null) args.push('-F', `cursor=${cursor}`);
      let raw: string;
      try {
        raw = await this.run('gh', args);
      } catch (error: unknown) {
        const gateway = gatewayStatusFromFailure(error);
        const reason = classifyTransportFault(error)
          ?? (gateway === null ? null : `HTTP ${gateway}`);
        // Not a page-weight signal: the original error, never a synthetic one,
        // and the reconciliation fails exactly as it did before.
        if (reason === null) throw error;
        const halved = Math.max(MIN_PR_PAGE_SIZE, Math.floor(pageSize / 2));
        if (downshift >= MAX_PR_PAGE_DOWNSHIFTS || halved >= pageSize) {
          throw new Error(
            `full reconciliation: page size ${pageSize} at cursor ${cursor ?? 'null'} `
              + `still failed: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        this.prPageSize = halved;
        console.warn(
          `[github-reader] full reconciliation: page size ${pageSize} → ${halved} `
            + `after ${reason}`,
        );
        continue;
      }
      return JSON.parse(raw) as GraphQlPage;
    }
  }

  async readPullRequests(
    cursor: string | null,
    nonDoneIssueNumbers: readonly number[] = [],
  ): Promise<PullRequestPage> {
    // A null cursor is the first page of a fresh full reconciliation, and the
    // only place the downshift is released. Nothing is persisted; a process
    // restart starts at the default too.
    if (cursor === null) this.prPageSize = PR_PAGE_SIZE;
    const response = await this.readPullRequestPage(cursor);
    const connection = response.data.repository.pullRequests;
    // One git-transport listing serves every open + merged-outcome PR's
    // review-claim lookup below (jinn-mono#1883-follow-up) instead of one
    // GraphQL ref read per PR.
    const reviewClaimListing = await this.listReviewClaimRefs();
    const ciRerunRecorded = await this.listCiRerunRecordedHeads();
    const enqueueHolds = await this.listEnqueueHoldHeads();
    const openNodes = await Promise.all(connection.nodes.map((pr) => (
      this.rawPullRequest(pr, true, reviewClaimListing).catch((error: unknown) => {
        if (!(error instanceof PrEvidenceInconsistentError)) throw error;
        return inconsistentPullRequest(pr, error);
      })
    ))).then((nodes) => nodes.map((pr) => {
      const key = `${pr.number}/${pr.headOid}`;
      const enqueueHold = enqueueHolds.get(key);
      return {
        ...pr,
        ...(ciRerunRecorded.has(key) ? { ciRerunRecorded: true as const } : {}),
        // Head-exact by construction: a hold left behind at a head this pull
        // request has since replaced is not at `key`, so it stamps nothing and
        // the enqueue proceeds. That is the entire release mechanism.
        ...(enqueueHold === undefined ? {} : { enqueueHold }),
      };
    }));
    const mergedOutcomes = cursor === null
      ? await this.readMergedOutcomes(nonDoneIssueNumbers, reviewClaimListing)
      : {
          nodes: [],
          closingIssueEvidenceIncomplete: false,
          closedUnmergedParentPrs: [] as readonly number[],
        };
    const byNumber = new Map<number, RawPullRequest>();
    for (const pr of [...openNodes, ...mergedOutcomes.nodes]) {
      if (!byNumber.has(pr.number)) byNumber.set(pr.number, pr);
    }
    return {
      nodes: [...byNumber.values()],
      pageInfo: connection.pageInfo,
      ...(mergedOutcomes.closingIssueEvidenceIncomplete
        ? { closingIssueEvidenceIncomplete: true as const }
        : {}),
      ...(mergedOutcomes.closedUnmergedParentPrs.length === 0
        ? {}
        : { closedUnmergedParentPrs: mergedOutcomes.closedUnmergedParentPrs }),
    };
  }

  private async branchClaimsFromRefs(
    refs: readonly { readonly name: string; readonly oid: string }[],
  ): Promise<readonly RawBranchClaim[]> {
    const claims: RawBranchClaim[] = [];
    for (const ref of refs) {
      const match = /^refs\/heads\/autopilot\/([1-9][0-9]*)$/.exec(ref.name);
      if (match?.[1] === undefined) continue;
      const issueNumber = Number(match[1]);
      const ancestry = await this.branchAncestry(ref.oid, issueNumber);
      const trailers = ancestry.claimTrailers;
      if (trailers === null) continue;
      claims.push({
        issueNumber,
        headRefName: `autopilot/${match[1]}`,
        headOid: ref.oid,
        headCommittedAt: ancestry.headCommittedAt,
        claimTrailers: trailers,
        implementationCompletionSummary: ancestry.completionSummary,
      });
    }
    return claims;
  }

  async readIncrementalBranchClaims(): Promise<readonly RawBranchClaim[]> {
    const raw = await this.gitRun([
      'ls-remote', this.remoteName, AUTOPILOT_BRANCH_REF_GLOB,
    ]);
    const refs: Array<{ readonly name: string; readonly oid: string }> = [];
    const seenIssues = new Set<number>();
    const lines = raw.length === 0 ? [] : raw.split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (const line of lines) {
      const fields = line.split('\t');
      const [oid, name] = fields;
      if (
        fields.length !== 2
        || oid === undefined
        || name === undefined
        || !name.startsWith(AUTOPILOT_BRANCH_REF_PREFIX)
      ) {
        throw new Error('Malformed git ls-remote Autopilot branch ref listing');
      }
      let parsedOid: GitOid;
      try {
        parsedOid = gitOid(oid);
        gitRefName(name);
      } catch {
        throw new Error('Malformed git ls-remote Autopilot branch ref listing');
      }
      const issueText = name.slice(AUTOPILOT_BRANCH_REF_PREFIX.length);
      if (!/^[1-9][0-9]*$/.test(issueText)) continue;
      const issueNumber = Number(issueText);
      if (!Number.isSafeInteger(issueNumber) || seenIssues.has(issueNumber)) {
        throw new Error('Malformed git ls-remote Autopilot branch ref listing');
      }
      seenIssues.add(issueNumber);
      refs.push({ name, oid: parsedOid });
    }
    return this.branchClaimsFromRefs(refs);
  }

  async readBranchClaims(): Promise<readonly RawBranchClaim[]> {
    const refs: Array<{
      ref?: string;
      object?: { sha?: string };
    }> = [];
    const pageSize = 100;
    const maxPages = 100;
    for (let page = 1; page <= maxPages; page += 1) {
      const endpoint = `repos/${this.repositorySlug}/git/matching-refs/heads/autopilot/`
        + `?per_page=${pageSize}&page=${page}`;
      const raw = await this.run('gh', ['api', endpoint]);
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) throw new Error('Branch ref REST page is malformed');
      refs.push(...parsed as typeof refs);
      if (parsed.length < pageSize) break;
      if (page === maxPages) throw new Error('Branch ref pagination exceeded safety limit');
    }
    return this.branchClaimsFromRefs(refs.flatMap((ref) => (
      ref.ref === undefined || ref.object?.sha === undefined
        ? []
        : [{ name: ref.ref, oid: ref.object.sha }]
    )));
  }
}
