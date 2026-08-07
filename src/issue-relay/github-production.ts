import type { IssueRelayConfig } from './config.js';
import type {
  RelayGitHubReadPort,
  RelayGitHubWritePort,
  RelayIssueCandidateFacts,
  RelayLabelEvent,
  RelayPullRequestCommentFacts,
} from './github-port.js';
import { IssueRelayRateLimitError } from './reconciler.js';
import type { IssueRelayGitHubPreflight } from './runtime-production.js';
import {
  parseRelayPullRequestMarker,
  type RelayGitHubCommandRunner,
  type RelayPullRequest,
} from './git-publisher.js';
import type {
  RelayBranchRequiredCheck,
  RelayGitHubCheckFact,
} from './checks.js';

const DISCOVERY_QUERY =
  'repo:Jinn-Network/mono is:issue is:open label:"engine:marketplace"';
const RECOVERY_ACTIVE_MARKER = 'jinn-issue-relay:active:v1';
const GITHUB_SEARCH_RESULT_CAP = 1000;
const MAX_PAGES = 10;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const OID = /^[0-9a-f]{40}$/;

export interface RelayGitHubApiRequest {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface RelayGitHubApiResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export type RelayGitHubApiTransport = (
  input: RelayGitHubApiRequest,
) => Promise<RelayGitHubApiResponse>;

export interface RelayGitHubOwnedMarkerComment {
  readonly id: number;
  readonly authorLogin: string;
  readonly body: string;
}

export interface RelayGitHubProductionAuthorityPort {
  listIssueNumbersForMarkerRecovery(): Promise<readonly number[]>;
  listIssueComments(
    issueNumber: number,
  ): Promise<readonly RelayGitHubOwnedMarkerComment[]>;
  createIssueCommentExact(input: {
    readonly issueNumber: number;
    readonly body: string;
  }): Promise<RelayGitHubOwnedMarkerComment>;
  editIssueCommentExact(input: {
    readonly issueNumber: number;
    readonly commentId: number;
    readonly expectedBody: string;
    readonly body: string;
  }): Promise<RelayGitHubOwnedMarkerComment>;
  readPullRequest(prNumber: number): Promise<RelayPullRequest>;
  readChecks(input: {
    readonly head: string;
    readonly base: string;
  }): Promise<{
    readonly checks: readonly RelayGitHubCheckFact[];
    readonly branchRequiredChecks: readonly RelayBranchRequiredCheck[];
  }>;
  listAssuranceComments(
    prNumber: number,
  ): Promise<readonly RelayGitHubOwnedMarkerComment[]>;
  editAssuranceCommentExact(input: {
    readonly prNumber: number;
    readonly commentId: number;
    readonly expectedHead: string;
    readonly expectedBody: string;
    readonly body: string;
  }): Promise<RelayGitHubOwnedMarkerComment>;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} returned a malformed object`);
  }
  return value as JsonObject;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} returned a malformed string`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} returned a malformed positive integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} returned a malformed non-negative integer`);
  }
  return value as number;
}

function canonicalTimestamp(value: unknown, label: string): string {
  const timestamp = Date.parse(string(value, label));
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} returned a malformed timestamp`);
  }
  return new Date(timestamp).toISOString();
}

function sameName(left: string, right: string): boolean {
  return left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US');
}

function header(
  response: RelayGitHubApiResponse,
  name: string,
): string | undefined {
  const found = Object.entries(response.headers).find(
    ([key]) => key.toLocaleLowerCase('en-US') === name,
  );
  return found?.[1];
}

function apiError(
  request: RelayGitHubApiRequest,
  response: RelayGitHubApiResponse,
): never {
  if (
    response.status === 403
    || response.status === 429
    || header(response, 'x-ratelimit-remaining') === '0'
  ) {
    throw new IssueRelayRateLimitError(
      `GitHub rate limit refused ${request.method} ${request.path}`,
    );
  }
  throw new Error(
    `GitHub API refused ${request.method} ${request.path} (${response.status})`,
  );
}

function nextPage(
  response: RelayGitHubApiResponse,
  current: number,
  expectedPath: string,
): number | undefined {
  const link = header(response, 'link');
  if (link === undefined) return undefined;
  const links = link.split(',').map((entry) => entry.trim());
  const next = links.find((entry) => /;\s*rel="next"$/.test(entry));
  if (next === undefined) return undefined;
  const target = next.match(/^<([^>]+)>/)?.[1];
  if (target === undefined) {
    throw new Error('GitHub pagination link is malformed');
  }
  const url = new URL(target);
  const page = Number(url.searchParams.get('page'));
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'api.github.com'
    || url.pathname !== expectedPath
    || !Number.isSafeInteger(page)
    || page <= current
    || page > MAX_PAGES
  ) {
    throw new Error('GitHub pagination is cyclic or exceeds its bound');
  }
  return page;
}

function visibility(repository: JsonObject): 'PUBLIC' | 'PRIVATE' | 'INTERNAL' {
  if (repository.private === true) return 'PRIVATE';
  const value = typeof repository.visibility === 'string'
    ? repository.visibility.toLocaleUpperCase('en-US')
    : 'PUBLIC';
  if (value === 'PUBLIC' || value === 'PRIVATE' || value === 'INTERNAL') {
    return value;
  }
  throw new Error('GitHub repository visibility is malformed');
}

interface RepositoryIdentity {
  readonly slug: string;
  readonly nodeId: string;
  readonly visibility: 'PUBLIC' | 'PRIVATE' | 'INTERNAL';
  readonly defaultBranch: string;
  readonly owner: string;
  readonly parentNodeId?: string;
}

function repositoryIdentity(value: unknown): RepositoryIdentity {
  const repository = object(value, 'GitHub repository');
  const parent = repository.parent === null || repository.parent === undefined
    ? undefined
    : object(repository.parent, 'GitHub fork parent');
  return {
    slug: string(repository.full_name, 'GitHub repository full name'),
    nodeId: string(repository.node_id, 'GitHub repository node ID'),
    visibility: visibility(repository),
    defaultBranch: string(
      repository.default_branch,
      'GitHub repository default branch',
    ),
    owner: string(
      object(repository.owner, 'GitHub repository owner').login,
      'GitHub repository owner login',
    ),
    ...(parent === undefined
      ? {}
      : {
        parentNodeId: string(
          parent.node_id,
          'GitHub fork parent repository node ID',
        ),
      }),
  };
}

function issueFacts(
  value: unknown,
  repository: RepositoryIdentity,
): RelayIssueCandidateFacts {
  const issue = object(value, 'GitHub issue');
  const user = object(issue.user, 'GitHub issue author');
  if (!Array.isArray(issue.labels)) {
    throw new Error('GitHub issue labels are malformed');
  }
  return {
    repository: {
      slug: repository.slug,
      nodeId: repository.nodeId,
      visibility: repository.visibility,
      defaultBranch: repository.defaultBranch,
    },
    issue: {
      number: positiveInteger(issue.number, 'GitHub issue number'),
      url: string(issue.html_url, 'GitHub issue URL'),
      title: string(issue.title, 'GitHub issue title'),
      body: issue.body === null ? '' : string(issue.body, 'GitHub issue body'),
      authorLogin: string(user.login, 'GitHub issue author login'),
      authorId: string(user.node_id, 'GitHub issue author ID'),
      updatedAt: canonicalTimestamp(issue.updated_at, 'GitHub issue updated time'),
      state: string(issue.state, 'GitHub issue state').toLocaleUpperCase('en-US')
        === 'OPEN' ? 'OPEN' : 'CLOSED',
      isPullRequest: issue.pull_request !== undefined,
      labels: issue.labels.map((label) =>
        string(object(label, 'GitHub label').name, 'GitHub label name')),
    },
  };
}

function pullRequest(value: unknown): {
  readonly number: number;
  readonly nodeId: string;
  readonly open: boolean;
  readonly draft: boolean;
  readonly author: string;
  readonly head: string;
  readonly branch: string;
  readonly headRepository: string;
  readonly headRepositoryId: string;
  readonly base: string;
  readonly baseRepository: string;
  readonly baseRepositoryId: string;
  readonly title: string;
  readonly body: string;
} {
  const pr = object(value, 'GitHub pull request');
  const head = object(pr.head, 'GitHub pull request head');
  const base = object(pr.base, 'GitHub pull request base');
  const headRepository = object(head.repo, 'GitHub pull request head repository');
  const baseRepository = object(base.repo, 'GitHub pull request base repository');
  return {
    number: positiveInteger(pr.number, 'GitHub pull request number'),
    nodeId: string(pr.node_id, 'GitHub pull request node ID'),
    open: string(pr.state, 'GitHub pull request state') === 'open',
    draft: pr.draft === true,
    author: string(
      object(pr.user, 'GitHub pull request author').login,
      'GitHub pull request author login',
    ),
    head: string(head.sha, 'GitHub pull request head OID'),
    branch: string(head.ref, 'GitHub pull request head branch'),
    headRepository: string(
      headRepository.full_name,
      'GitHub pull request head repository',
    ),
    headRepositoryId: string(
      headRepository.node_id,
      'GitHub pull request head repository ID',
    ),
    base: string(base.ref, 'GitHub pull request base branch'),
    baseRepository: string(
      baseRepository.full_name,
      'GitHub pull request base repository',
    ),
    baseRepositoryId: string(
      baseRepository.node_id,
      'GitHub pull request base repository ID',
    ),
    title: string(pr.title, 'GitHub pull request title'),
    body: typeof pr.body === 'string' ? pr.body : '',
  };
}

async function defaultTransport(
  token: string,
  input: RelayGitHubApiRequest,
): Promise<RelayGitHubApiResponse> {
  const url = new URL(input.path, 'https://api.github.com');
  for (const [name, value] of Object.entries(input.query ?? {})) {
    url.searchParams.set(name, value);
  }
  const response = await fetch(url, {
    method: input.method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'jinn-issue-relay-v1',
      'x-github-api-version': '2022-11-28',
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    signal: AbortSignal.timeout(30_000),
  });
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new Error('GitHub API response exceeds the Relay byte bound');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new Error('GitHub API response exceeds the Relay byte bound');
  }
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new Error('GitHub API returned malformed JSON');
    }
  }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  };
}

export function createRelayGitHubProductionPorts(options: {
  readonly config: IssueRelayConfig;
  readonly token: string;
  readonly request?: RelayGitHubApiTransport;
}): {
  readonly read: RelayGitHubReadPort;
  readonly write: RelayGitHubWritePort;
  readonly authority: RelayGitHubProductionAuthorityPort;
  readonly publisher: RelayGitHubCommandRunner;
  readonly preflight: () => Promise<IssueRelayGitHubPreflight>;
} {
  if (options.token.length === 0) {
    throw new Error('Issue Relay GitHub token is required');
  }
  const transport = options.request
    ?? ((input: RelayGitHubApiRequest) => defaultTransport(options.token, input));
  const request = async (
    input: RelayGitHubApiRequest,
    expected: readonly number[] = [200],
  ): Promise<RelayGitHubApiResponse> => {
    const response = await transport(input);
    if (!expected.includes(response.status)) apiError(input, response);
    return response;
  };
  const getRepository = async (slug: string): Promise<RepositoryIdentity> =>
    repositoryIdentity((await request({
      method: 'GET',
      path: `/repos/${slug}`,
    })).body);
  const readPr = async (number: number) => pullRequest((await request({
    method: 'GET',
    path: `/repos/${options.config.repository}/pulls/${number}`,
  })).body);
  const assertPrAuthority = async (
    pr: ReturnType<typeof pullRequest>,
    input: {
      readonly expectedHead: string;
      readonly expectedDraft: boolean;
      readonly expectedOpen: boolean;
    },
  ): Promise<void> => {
    if (!OID.test(input.expectedHead)) {
      throw new Error('Relay expected pull request head is invalid');
    }
    const target = await getRepository(options.config.repository);
    const fork = await getRepository(options.config.managedForkRepository);
    if (
      pr.head !== input.expectedHead
      || pr.draft !== input.expectedDraft
      || pr.open !== input.expectedOpen
      || !sameName(pr.author, options.config.relayBotLogin)
      || pr.base !== options.config.targetBase
      || pr.baseRepository !== target.slug
      || pr.baseRepositoryId !== target.nodeId
      || pr.headRepository !== fork.slug
      || pr.headRepositoryId !== fork.nodeId
      || fork.parentNodeId !== target.nodeId
    ) {
      throw new Error('Relay pull request exact authority changed');
    }
  };

  const read: RelayGitHubReadPort = {
    async searchOptedInIssues(input) {
      if (
        input.repository !== options.config.repository
        || input.label !== options.config.label
      ) {
        throw new Error('Issue Relay discovery is outside the exact V0 query');
      }
      const page = input.cursor === undefined
        ? 1
        : Number(input.cursor.match(/^page:([1-9][0-9]*)$/)?.[1]);
      if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGES) {
        throw new Error('Issue Relay discovery cursor is invalid or out of bounds');
      }
      const repository = await getRepository(options.config.repository);
      const response = await request({
        method: 'GET',
        path: '/search/issues',
        query: {
          q: DISCOVERY_QUERY,
          per_page: '100',
          page: String(page),
        },
      });
      const body = object(response.body, 'GitHub issue search');
      if (!Array.isArray(body.items) || body.items.length > 100) {
        throw new Error('GitHub issue search result is malformed or oversized');
      }
      const following = nextPage(response, page, '/search/issues');
      return {
        issues: body.items.map((issue) => issueFacts(issue, repository))
          .filter(({ issue }) => !issue.isPullRequest),
        ...(following === undefined ? {} : { nextCursor: `page:${following}` }),
      };
    },

    async readIssue(number) {
      const repository = await getRepository(options.config.repository);
      return issueFacts((await request({
        method: 'GET',
        path: `/repos/${options.config.repository}/issues/${number}`,
      })).body, repository);
    },

    async listLabelEvents(number) {
      const events: RelayLabelEvent[] = [];
      let page = 1;
      for (;;) {
        const path =
          `/repos/${options.config.repository}/issues/${number}/timeline`;
        const response = await request({
          method: 'GET',
          path,
          query: { per_page: '100', page: String(page) },
        });
        if (!Array.isArray(response.body) || response.body.length > 100) {
          throw new Error('GitHub issue timeline is malformed or oversized');
        }
        for (const value of response.body) {
          const event = object(value, 'GitHub timeline event');
          if (event.event !== 'labeled' && event.event !== 'unlabeled') continue;
          const actor = object(event.actor, 'GitHub label actor');
          events.push({
            action: event.event,
            label: string(
              object(event.label, 'GitHub timeline label').name,
              'GitHub timeline label name',
            ),
            actorLogin: string(actor.login, 'GitHub label actor login'),
            actorId: string(actor.node_id, 'GitHub label actor ID'),
            createdAt: canonicalTimestamp(
              event.created_at,
              'GitHub label event time',
            ),
          });
        }
        const following = nextPage(response, page, path);
        if (following === undefined) return events;
        page = following;
      }
    },

    async readRepositoryPermission(login) {
      const response = await request({
        method: 'GET',
        path:
          `/repos/${options.config.repository}/collaborators/`
          + `${encodeURIComponent(login)}/permission`,
      });
      const permission = string(
        object(response.body, 'GitHub permission').permission,
        'GitHub permission',
      ).toLocaleUpperCase('en-US');
      return (
        ['NONE', 'READ', 'TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN']
          .includes(permission)
          ? permission
          : 'NONE'
      ) as Awaited<ReturnType<RelayGitHubReadPort['readRepositoryPermission']>>;
    },

    async listPullRequestComments(prNumber) {
      if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
        throw new Error('Relay pull request number is invalid');
      }
      const comments: RelayPullRequestCommentFacts[] = [];
      let page = 1;
      for (;;) {
        const path = `/repos/${options.config.repository}/issues/${prNumber}/comments`;
        const response = await request({
          method: 'GET',
          path,
          query: { per_page: '100', page: String(page), direction: 'asc' },
        });
        if (!Array.isArray(response.body) || response.body.length > 100) {
          throw new Error('GitHub pull request comments are malformed or oversized');
        }
        for (const value of response.body) {
          const comment = object(value, 'GitHub pull request comment');
          const actor = object(comment.user, 'GitHub pull request comment actor');
          const body = typeof comment.body === 'string' ? comment.body : undefined;
          if (body === undefined || Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
            throw new Error('GitHub pull request comment body is malformed or oversized');
          }
          comments.push({
            commentId: positiveInteger(comment.id, 'GitHub pull request comment ID'),
            nodeId: string(comment.node_id, 'GitHub pull request comment node ID'),
            actorLogin: string(actor.login, 'GitHub pull request comment actor login'),
            actorUserId: string(actor.node_id, 'GitHub pull request comment actor ID'),
            body,
            createdAt: canonicalTimestamp(comment.created_at, 'GitHub pull request comment created time'),
            updatedAt: canonicalTimestamp(comment.updated_at, 'GitHub pull request comment updated time'),
          });
        }
        const following = nextPage(response, page, path);
        if (following === undefined) return comments;
        page = following;
      }
    },

    async readDefaultBranchHead() {
      const repository = await getRepository(options.config.repository);
      const commit = object((await request({
        method: 'GET',
        path:
          `/repos/${options.config.repository}/commits/`
          + encodeURIComponent(repository.defaultBranch),
      })).body, 'GitHub default branch commit');
      const sha = string(commit.sha, 'GitHub default branch OID');
      if (!OID.test(sha)) throw new Error('GitHub default branch OID is malformed');
      return sha;
    },
  };

  const exactComment = (
    value: unknown,
    expected: { readonly id: number; readonly body: string; readonly issueNumber: number },
  ): void => {
    const comment = object(value, 'GitHub comment');
    const issueUrl = string(comment.issue_url, 'GitHub comment issue URL');
    if (
      comment.id !== expected.id
      || comment.body !== expected.body
      || !sameName(
        string(
          object(comment.user, 'GitHub comment author').login,
          'GitHub comment author',
        ),
        options.config.relayBotLogin,
      )
      || issueUrl !==
        `https://api.github.com/repos/${options.config.repository}/issues/`
          + expected.issueNumber
    ) {
      throw new Error('Relay GitHub comment did not read back exactly');
    }
  };
  const upsertComment = async (input: {
    readonly issueNumber: number;
    readonly expectedCommentId?: number;
    readonly body: string;
  }): Promise<{ readonly commentId: number }> => {
    let id = input.expectedCommentId;
    if (id === undefined) {
      const created = await request({
        method: 'POST',
        path:
          `/repos/${options.config.repository}/issues/`
          + `${input.issueNumber}/comments`,
        body: { body: input.body },
      }, [201]);
      id = positiveInteger(
        object(created.body, 'GitHub created comment').id,
        'GitHub created comment ID',
      );
    } else {
      const before = await request({
        method: 'GET',
        path: `/repos/${options.config.repository}/issues/comments/${id}`,
      });
      const current = object(before.body, 'GitHub existing comment');
      if (!sameName(
        string(
          object(current.user, 'GitHub comment author').login,
          'GitHub comment author',
        ),
        options.config.relayBotLogin,
      )) {
        throw new Error('Relay cannot edit a comment it does not own');
      }
      await request({
        method: 'PATCH',
        path: `/repos/${options.config.repository}/issues/comments/${id}`,
        body: { body: input.body },
      });
    }
    const readback = await request({
      method: 'GET',
      path: `/repos/${options.config.repository}/issues/comments/${id}`,
    });
    exactComment(readback.body, {
      id,
      body: input.body,
      issueNumber: input.issueNumber,
    });
    return { commentId: id };
  };

  const write: RelayGitHubWritePort = {
    upsertIssueStatusComment: upsertComment,
    async upsertPullRequestAssuranceComment(input) {
      const result = await upsertComment({
        issueNumber: input.prNumber,
        expectedCommentId: input.expectedCommentId,
        body: input.body,
      });
      const pr = await readPr(input.prNumber);
      if (!pr.open || !sameName(pr.author, options.config.relayBotLogin)) {
        throw new Error('Relay assurance comment lost pull request authority');
      }
      return result;
    },

    async createDraftPullRequest(input) {
      await request({
        method: 'POST',
        path: `/repos/${options.config.repository}/pulls`,
        body: {
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
          draft: true,
        },
      }, [201]);
      const response = await request({
        method: 'GET',
        path: `/repos/${options.config.repository}/pulls`,
        query: { state: 'open', head: input.head, base: input.base },
      });
      if (!Array.isArray(response.body) || response.body.length !== 1) {
        throw new Error('Relay draft pull request is not unique on readback');
      }
      const pr = pullRequest(response.body[0]);
      await assertPrAuthority(pr, {
        expectedHead: pr.head,
        expectedDraft: true,
        expectedOpen: true,
      });
      return { number: pr.number, headOid: pr.head };
    },

    async markPullRequestReady(input) {
      const before = await readPr(input.prNumber);
      await assertPrAuthority(before, {
        expectedHead: input.expectedHead,
        expectedDraft: true,
        expectedOpen: true,
      });
      await request({
        method: 'POST',
        path: '/graphql',
        body: {
          query:
            'mutation MarkReady($pullRequestId: ID!) { '
            + 'markPullRequestReadyForReview(input: {pullRequestId: $pullRequestId}) '
            + '{ pullRequest { id isDraft } } }',
          variables: { pullRequestId: before.nodeId },
        },
      });
      const after = await readPr(input.prNumber);
      await assertPrAuthority(after, {
        expectedHead: input.expectedHead,
        expectedDraft: false,
        expectedOpen: true,
      });
    },

    async closePullRequest(input) {
      const before = await readPr(input.prNumber);
      await assertPrAuthority(before, {
        expectedHead: input.expectedHead,
        expectedDraft: input.expectedDraft,
        expectedOpen: true,
      });
      await request({
        method: 'PATCH',
        path:
          `/repos/${options.config.repository}/pulls/${input.prNumber}`,
        body: { state: 'closed' },
      });
      const after = await readPr(input.prNumber);
      await assertPrAuthority(after, {
        expectedHead: input.expectedHead,
        expectedDraft: input.expectedDraft,
        expectedOpen: false,
      });
    },
  };

  const authority: RelayGitHubProductionAuthorityPort = {
    async listIssueNumbersForMarkerRecovery() {
      const numbers: number[] = [];
      const seen = new Set<number>();
      let page = 1;
      let expectedTotal: number | undefined;
      const query =
        `repo:${options.config.repository} is:issue in:comments `
        + `"${RECOVERY_ACTIVE_MARKER}" `
        + `commenter:"${options.config.relayBotLogin}"`;
      for (;;) {
        const path = '/search/issues';
        const response = await request({
          method: 'GET',
          path,
          query: {
            q: query,
            per_page: '100',
            page: String(page),
          },
        });
        const body = object(response.body, 'GitHub recovery search');
        const total = nonNegativeInteger(
          body.total_count,
          'GitHub recovery search total_count',
        );
        if (total > GITHUB_SEARCH_RESULT_CAP) {
          throw new Error(
            `GitHub recovery search exceeds its ${GITHUB_SEARCH_RESULT_CAP}-result cap`,
          );
        }
        if (body.incomplete_results !== false) {
          throw new Error('GitHub recovery search is incomplete');
        }
        if (expectedTotal === undefined) {
          expectedTotal = total;
        } else if (expectedTotal !== total) {
          throw new Error('GitHub recovery search total changed across pages');
        }
        if (!Array.isArray(body.items) || body.items.length > 100) {
          throw new Error('GitHub recovery search items are malformed');
        }
        const repositoryUrl =
          `https://api.github.com/repos/${options.config.repository}`;
        for (const value of body.items) {
          const issue = object(value, 'GitHub recovery search issue');
          const number = positiveInteger(
            issue.number,
            'GitHub recovery issue number',
          );
          if (
            issue.pull_request !== undefined
            || issue.repository_url !== repositoryUrl
            || issue.url !== `${repositoryUrl}/issues/${number}`
            || seen.has(number)
          ) {
            throw new Error(
              'GitHub recovery search returned a contradictory issue identity',
            );
          }
          seen.add(number);
          numbers.push(number);
        }
        const following = nextPage(response, page, path);
        if (following === undefined) {
          if (numbers.length !== expectedTotal) {
            throw new Error('GitHub recovery search result count is incomplete');
          }
          return numbers;
        }
        if (numbers.length >= expectedTotal) {
          throw new Error('GitHub recovery search pagination is contradictory');
        }
        page = following;
      }
    },
    async listIssueComments(issueNumber) {
      const comments: RelayGitHubOwnedMarkerComment[] = [];
      let page = 1;
      for (;;) {
        const path =
          `/repos/${options.config.repository}/issues/${issueNumber}/comments`;
        const response = await request({
          method: 'GET',
          path,
          query: { per_page: '100', page: String(page) },
        });
        if (!Array.isArray(response.body) || response.body.length > 100) {
          throw new Error('GitHub issue comments are malformed or oversized');
        }
        for (const value of response.body) {
          const comment = object(value, 'GitHub issue comment');
          comments.push({
            id: positiveInteger(comment.id, 'GitHub issue comment ID'),
            authorLogin: string(
              object(comment.user, 'GitHub issue comment author').login,
              'GitHub issue comment author login',
            ),
            body: typeof comment.body === 'string' ? comment.body : '',
          });
        }
        const following = nextPage(response, page, path);
        if (following === undefined) return comments;
        page = following;
      }
    },
    async createIssueCommentExact(input) {
      const created = await request({
        method: 'POST',
        path:
          `/repos/${options.config.repository}/issues/`
          + `${input.issueNumber}/comments`,
        body: { body: input.body },
      }, [201]);
      const id = positiveInteger(
        object(created.body, 'GitHub created comment').id,
        'GitHub created comment ID',
      );
      const readback = await request({
        method: 'GET',
        path: `/repos/${options.config.repository}/issues/comments/${id}`,
      });
      exactComment(readback.body, {
        id,
        body: input.body,
        issueNumber: input.issueNumber,
      });
      return {
        id,
        authorLogin: options.config.relayBotLogin,
        body: input.body,
      };
    },
    async editIssueCommentExact(input) {
      const before = await request({
        method: 'GET',
        path:
          `/repos/${options.config.repository}/issues/comments/`
          + input.commentId,
      });
      exactComment(before.body, {
        id: input.commentId,
        body: input.expectedBody,
        issueNumber: input.issueNumber,
      });
      await request({
        method: 'PATCH',
        path:
          `/repos/${options.config.repository}/issues/comments/`
          + input.commentId,
        body: { body: input.body },
      });
      const after = await request({
        method: 'GET',
        path:
          `/repos/${options.config.repository}/issues/comments/`
          + input.commentId,
      });
      exactComment(after.body, {
        id: input.commentId,
        body: input.body,
        issueNumber: input.issueNumber,
      });
      return {
        id: input.commentId,
        authorLogin: options.config.relayBotLogin,
        body: input.body,
      };
    },
    async readPullRequest(prNumber) {
      const pr = await readPr(prNumber);
      const target = await getRepository(options.config.repository);
      const fork = await getRepository(options.config.managedForkRepository);
      const generation = parseRelayPullRequestMarker(pr.body);
      if (
        generation === null
        || pr.baseRepositoryId !== target.nodeId
        || pr.headRepositoryId !== fork.nodeId
        || fork.parentNodeId !== target.nodeId
      ) {
        throw new Error('Relay pull request marker or repository authority is invalid');
      }
      return {
        number: pr.number,
        title: pr.title,
        body: pr.body,
        generation,
        targetRepositoryId: target.nodeId,
        forkRepositoryId: fork.nodeId,
        forkParentRepositoryId: fork.parentNodeId,
        branch: pr.branch,
        base: pr.base,
        head: pr.head,
        open: pr.open,
        draft: pr.draft,
      };
    },
    async readChecks(input) {
      if (!OID.test(input.head) || input.base !== options.config.targetBase) {
        throw new Error('Relay check read requires exact configured head/base');
      }
      const runsResponse = await request({
        method: 'GET',
        path:
          `/repos/${options.config.repository}/commits/${input.head}/check-runs`,
        query: { per_page: '100' },
      });
      const runsBody = object(runsResponse.body, 'GitHub check runs');
      if (!Array.isArray(runsBody.check_runs) || runsBody.check_runs.length > 100) {
        throw new Error('GitHub check runs are malformed or oversized');
      }
      const checks: RelayGitHubCheckFact[] = runsBody.check_runs.map((value) => {
        const run = object(value, 'GitHub check run');
        const app = object(run.app, 'GitHub check run App');
        return {
          kind: 'check-run',
          name: string(run.name, 'GitHub check run name'),
          appId: positiveInteger(app.id, 'GitHub check run App ID'),
          head: string(run.head_sha, 'GitHub check run head'),
          status: string(run.status, 'GitHub check run status') as
            Extract<RelayGitHubCheckFact, { kind: 'check-run' }>['status'],
          conclusion: (run.conclusion === null ? null : string(
            run.conclusion,
            'GitHub check run conclusion',
          )) as Extract<
          RelayGitHubCheckFact,
          { kind: 'check-run' }
          >['conclusion'],
          ...(typeof run.html_url === 'string' ? { url: run.html_url } : {}),
        };
      });
      const statusesResponse = await request({
        method: 'GET',
        path:
          `/repos/${options.config.repository}/commits/${input.head}/status`,
      });
      const combinedStatus = object(
        statusesResponse.body,
        'GitHub combined status',
      );
      const combinedHead = string(
        combinedStatus.sha,
        'GitHub combined status head',
      );
      if (combinedHead !== input.head) {
        throw new Error('GitHub combined status is tied to a stale head');
      }
      const statuses = combinedStatus.statuses;
      if (!Array.isArray(statuses) || statuses.length > 100) {
        throw new Error('GitHub status contexts are malformed or oversized');
      }
      for (const value of statuses) {
        const status = object(value, 'GitHub status context');
        checks.push({
          kind: 'status-context',
          name: string(status.context, 'GitHub status context name'),
          head: typeof status.sha === 'string' ? status.sha : combinedHead,
          state: string(status.state, 'GitHub status state') as
            Extract<RelayGitHubCheckFact, { kind: 'status-context' }>['state'],
          ...(typeof status.target_url === 'string'
            ? { url: status.target_url }
            : {}),
        });
      }
      const requiredResponse = await request({
        method: 'GET',
        path:
          `/repos/${options.config.repository}/branches/`
          + `${encodeURIComponent(input.base)}/protection/required_status_checks`,
      }, [200, 404]);
      const branchRequiredChecks: RelayBranchRequiredCheck[] = [];
      if (requiredResponse.status === 200) {
        const required = object(
          requiredResponse.body,
          'GitHub required status checks',
        ).checks;
        if (!Array.isArray(required) || required.length > 100) {
          throw new Error('GitHub required status checks are malformed');
        }
        required.forEach((value) => {
          const check = object(value, 'GitHub required check');
          const appId = check.app_id;
          branchRequiredChecks.push({
            name: string(check.context, 'GitHub required check context'),
            appId: appId === null || appId === -1
              ? null
              : positiveInteger(appId, 'GitHub required check App ID'),
          });
        });
      }
      return { checks, branchRequiredChecks };
    },
    async listAssuranceComments(prNumber) {
      return this.listIssueComments(prNumber);
    },
    async editAssuranceCommentExact(input) {
      const pr = await readPr(input.prNumber);
      if (pr.head !== input.expectedHead || !pr.open) {
        throw new Error('Relay assurance edit lost exact open head authority');
      }
      return this.editIssueCommentExact({
        issueNumber: input.prNumber,
        commentId: input.commentId,
        expectedBody: input.expectedBody,
        body: input.body,
      });
    },
  };

  const publisher: RelayGitHubCommandRunner = async (command) => {
    const assertAuthority = async (): Promise<void> => {
      const target = await getRepository(options.config.repository);
      const fork = await getRepository(options.config.managedForkRepository);
      if (
        command.targetRepositoryId !== target.nodeId
        || command.forkRepositoryId !== fork.nodeId
        || command.forkParentRepositoryId !== target.nodeId
        || fork.parentNodeId !== target.nodeId
      ) {
        throw new Error('Relay publisher repository authority changed');
      }
    };
    await assertAuthority();
    switch (command.kind) {
      case 'list-pull-requests': {
        const [owner] = command.forkRepository.split('/');
        if (owner === undefined || owner.length === 0) {
          throw new Error('Relay managed fork owner is malformed');
        }
        const response = await request({
          method: 'GET',
          path: `/repos/${command.repository}/pulls`,
          query: {
            state: 'all',
            head: `${owner}:${command.branch}`,
            per_page: '100',
          },
        });
        if (!Array.isArray(response.body) || response.body.length > 100) {
          throw new Error('Relay pull request listing is malformed or oversized');
        }
        return {
          kind: 'pull-requests',
          pullRequests: response.body.map((value) => {
            const parsed = pullRequest(value);
            const generation = parseRelayPullRequestMarker(parsed.body);
            if (generation === null) {
              throw new Error('Relay pull request listing contains an unowned marker');
            }
            return {
              number: parsed.number,
              title: parsed.title,
              body: parsed.body,
              branch: parsed.branch,
              head: parsed.head,
              base: parsed.base,
              open: parsed.open,
              draft: parsed.draft,
              generation,
              targetRepositoryId: parsed.baseRepositoryId,
              forkRepositoryId: parsed.headRepositoryId,
              forkParentRepositoryId: command.forkParentRepositoryId,
            };
          }),
        };
      }
      case 'create-draft-pull-request': {
        await request({
          method: 'POST',
          path: `/repos/${command.repository}/pulls`,
          body: {
            title: command.title,
            body: command.body,
            head: command.head,
            base: command.base,
            draft: true,
          },
        }, [201]);
        return { kind: 'mutated' };
      }
      case 'read-pull-request':
        return {
          kind: 'pull-request',
          pullRequest: await authority.readPullRequest(command.prNumber),
        };
      case 'update-draft-pull-request': {
        const before = await authority.readPullRequest(command.prNumber);
        if (
          before.generation !== command.expectedGeneration
          || before.branch !== command.expectedBranch
          || before.head !== command.expectedHead
          || before.base !== command.expectedBase
          || before.title !== command.expectedTitle
          || before.body !== command.expectedBody
          || !before.open
          || !before.draft
        ) {
          throw new Error('Relay metadata update lost exact pull request authority');
        }
        await request({
          method: 'PATCH',
          path: `/repos/${command.repository}/pulls/${command.prNumber}`,
          body: { title: command.title, body: command.body },
        });
        return { kind: 'mutated' };
      }
      case 'close-pull-request': {
        const before = await authority.readPullRequest(command.prNumber);
        if (
          before.generation !== command.expectedGeneration
          || before.branch !== command.expectedBranch
          || before.head !== command.expectedHead
          || before.base !== command.expectedBase
          || before.draft !== command.expectedDraft
          || before.open !== command.expectedOpen
        ) {
          throw new Error('Relay close command lost exact pull request authority');
        }
        await write.closePullRequest({
          prNumber: command.prNumber,
          expectedHead: command.expectedHead,
          expectedDraft: command.expectedDraft,
          reason: command.reason,
        });
        return { kind: 'mutated' };
      }
      case 'list-assurance-comments':
        return {
          kind: 'assurance-comments',
          comments: await authority.listAssuranceComments(command.prNumber),
        };
      case 'create-assurance-comment':
        await authority.createIssueCommentExact({
          issueNumber: command.prNumber,
          body: command.body,
        });
        return { kind: 'mutated' };
      case 'edit-assurance-comment': {
        const comments = await authority.listAssuranceComments(command.prNumber);
        const current = comments.find(({ id }) => id === command.commentId);
        if (current === undefined) {
          throw new Error('Relay assurance comment disappeared before edit');
        }
        await authority.editAssuranceCommentExact({
          prNumber: command.prNumber,
          commentId: command.commentId,
          expectedHead: command.expectedHead,
          expectedBody: current.body,
          body: command.body,
        });
        return { kind: 'mutated' };
      }
      default: {
        const exhaustive: never = command;
        throw new Error(`Unsupported Relay GitHub command ${JSON.stringify(exhaustive)}`);
      }
    }
  };

  return {
    read,
    write,
    authority,
    publisher,
    async preflight() {
      const viewer = object((await request({
        method: 'GET',
        path: '/user',
      })).body, 'GitHub authenticated user');
      const target = await getRepository(options.config.repository);
      const fork = await getRepository(options.config.managedForkRepository);
      const label = object((await request({
        method: 'GET',
        path:
          `/repos/${options.config.repository}/labels/`
          + encodeURIComponent(options.config.label),
      })).body, 'GitHub Relay label');
      const branch = object((await request({
        method: 'GET',
        path:
          `/repos/${options.config.repository}/branches/`
          + encodeURIComponent(options.config.targetBase),
      })).body, 'GitHub target branch');
      return {
        authenticatedLogin: string(
          viewer.login,
          'GitHub authenticated login',
        ),
        targetRepository: target.slug,
        targetRepositoryId: target.nodeId,
        targetVisibility: target.visibility,
        targetBase: string(branch.name, 'GitHub target base'),
        label: string(label.name, 'GitHub Relay label'),
        forkRepository: fork.slug,
        forkRepositoryId: fork.nodeId,
        forkOwner: fork.owner,
        forkParentRepositoryId: fork.parentNodeId ?? '',
        forkVisibility: fork.visibility,
      };
    },
  };
}
