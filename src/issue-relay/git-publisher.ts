import { isDeepStrictEqual } from 'node:util';
import {
  IssueRelayAdoptionReceiptV1Schema,
  type IssueRelayAdoptionReceiptV1,
} from './contracts.js';
import { relayBranch } from './identity.js';

const OID = /^[0-9a-f]{40}$/;
const PR_MARKER = '<!-- jinn-issue-relay:pull-request:v1 -->';
const ASSURANCE_MARKER = '<!-- jinn-issue-relay:assurance:v1 -->';
const ADOPTION_MARKER = '<!-- jinn-issue-relay:adoption:v1 -->';

export type RelayGitPublisherReason =
  | 'branch-contradiction'
  | 'commit-contradiction'
  | 'stale-fork'
  | 'fork-push-contradiction'
  | 'pr-contradiction'
  | 'receipt-contradiction';

export class RelayGitPublisherError extends Error {
  readonly reason: RelayGitPublisherReason;

  constructor(reason: RelayGitPublisherReason, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RelayGitPublisherError';
    this.reason = reason;
  }
}

export interface RelayRepositoryAuthority {
  readonly targetRepositoryId: string;
  readonly forkRepositoryId: string;
  readonly forkParentRepositoryId: string;
}

export interface RelayPullRequest extends RelayRepositoryAuthority {
  readonly number: number;
  readonly branch: string;
  readonly head: string;
  readonly base: string;
  readonly open: boolean;
  readonly draft: boolean;
  readonly generation: string;
}

export interface RelayAssuranceComment {
  readonly id: number;
  readonly authorLogin: string;
  readonly body: string;
}

export type RelayGitCommand =
  | {
      readonly kind: 'read-applied-tree';
      readonly worktreePath: string;
      readonly inputHead: string;
    }
  | {
      readonly kind: 'read-local-head';
      readonly worktreePath: string;
    }
  | {
      readonly kind: 'create-commit';
      readonly worktreePath: string;
      readonly expectedHead: string;
      readonly expectedTree: string;
      readonly message: string;
    }
  | {
      readonly kind: 'read-commit';
      readonly worktreePath: string;
      readonly head: string;
      readonly expectedMessage: string;
    }
  | (RelayRepositoryAuthority & {
      readonly kind: 'read-fork-commit';
      readonly repository: string;
      readonly branch: string;
      readonly head: string;
      readonly expectedMessage: string;
    })
  | (RelayRepositoryAuthority & {
      readonly kind: 'read-fork-ref';
      readonly repository: string;
      readonly branch: string;
    })
  | (RelayRepositoryAuthority & {
      readonly kind: 'push-fork';
      readonly repository: string;
      readonly branch: string;
      readonly expectedOldHead?: string;
      readonly newHead: string;
    });

export type RelayGitCommandResult =
  | {
      readonly kind: 'applied-tree';
      readonly head: string;
      readonly tree: string;
      readonly exact: boolean;
    }
  | { readonly kind: 'local-head'; readonly head: string }
  | {
      readonly kind: 'commit';
      readonly head: string;
      readonly tree: string;
      readonly parents: readonly string[];
      readonly message: string;
    }
  | { readonly kind: 'fork-ref'; readonly head?: string }
  | { readonly kind: 'mutated' };

export type RelayGitCommandRunner = (
  command: RelayGitCommand,
) => Promise<RelayGitCommandResult>;

export type RelayGitHubCommand = RelayRepositoryAuthority & (
  | {
      readonly kind: 'list-pull-requests';
      readonly repository: string;
      readonly forkRepository: string;
      readonly branch: string;
    }
  | {
      readonly kind: 'create-draft-pull-request';
      readonly repository: string;
      readonly title: string;
      readonly body: string;
      readonly head: string;
      readonly base: string;
      readonly draft: true;
    }
  | {
      readonly kind: 'read-pull-request';
      readonly repository: string;
      readonly prNumber: number;
    }
  | {
      readonly kind: 'close-pull-request';
      readonly repository: string;
      readonly prNumber: number;
      readonly expectedGeneration: string;
      readonly expectedBranch: string;
      readonly expectedHead: string;
      readonly expectedBase: string;
      readonly expectedDraft: true;
      readonly expectedOpen: true;
      readonly reason: string;
    }
  | {
      readonly kind: 'list-assurance-comments';
      readonly repository: string;
      readonly prNumber: number;
    }
  | {
      readonly kind: 'create-assurance-comment';
      readonly repository: string;
      readonly prNumber: number;
      readonly expectedHead: string;
      readonly body: string;
    }
  | {
      readonly kind: 'edit-assurance-comment';
      readonly repository: string;
      readonly prNumber: number;
      readonly commentId: number;
      readonly expectedHead: string;
      readonly body: string;
    }
);

export type RelayGitHubCommandResult =
  | {
      readonly kind: 'pull-requests';
      readonly pullRequests: readonly RelayPullRequest[];
    }
  | { readonly kind: 'pull-request'; readonly pullRequest: RelayPullRequest }
  | {
      readonly kind: 'assurance-comments';
      readonly comments: readonly RelayAssuranceComment[];
    }
  | { readonly kind: 'mutated' };

export type RelayGitHubCommandRunner = (
  command: RelayGitHubCommand,
) => Promise<RelayGitHubCommandResult>;

export interface RelayCommitAndPushInput extends RelayRepositoryAuthority {
  readonly generation: string;
  readonly round: number;
  readonly branch: string;
  readonly targetRepository: string;
  readonly forkRepository: string;
  readonly worktreePath: string;
  readonly inputHead: string;
  readonly expectedTree: string;
  readonly expectedForkHead?: string;
  readonly summary: string;
  readonly taskId: string;
  readonly deliveryEnvelopeCid: string;
  readonly patchDigest: string;
}

export type RelayPublicationRecoveryInput = Omit<
RelayCommitAndPushInput,
'expectedTree' | 'expectedForkHead'
>;

export interface RelayDraftPullRequestInput extends RelayRepositoryAuthority {
  readonly generation: string;
  readonly targetRepository: string;
  readonly forkRepository: string;
  readonly branch: string;
  readonly resultingHead: string;
  readonly defaultBranch: string;
  readonly issueNumber: number;
  readonly existingPrNumber?: number;
}

export interface RelayAdoptionPublisher {
  recoverAccepted(input: RelayRepositoryAuthority & {
    readonly generation: string;
    readonly targetRepository: string;
    readonly forkRepository: string;
    readonly branch: string;
    readonly prNumber?: number;
    readonly defaultBranch: string;
    readonly serviceLogin: string;
    readonly correlation: IssueRelayAdoptionReceiptV1['correlation'];
    readonly allowClosed?: boolean;
  }): Promise<
    Extract<IssueRelayAdoptionReceiptV1, { readonly disposition: 'accepted' }>
    | undefined
  >;
  recoverPublished(input: RelayPublicationRecoveryInput): Promise<{
    readonly branch: string;
    readonly resultingHead: string;
    readonly tree: string;
  } | undefined>;
  readAppliedTree(input: {
    readonly worktreePath: string;
    readonly inputHead: string;
  }): Promise<string>;
  commitAndPush(input: RelayCommitAndPushInput): Promise<{
    readonly branch: string;
    readonly resultingHead: string;
  }>;
  ensureDraftPullRequest(input: RelayDraftPullRequestInput): Promise<RelayPullRequest>;
  closeDraftPullRequest(input: RelayRepositoryAuthority & {
    readonly targetRepository: string;
    readonly pr: RelayPullRequest;
    readonly expectedHead: string;
    readonly reason: string;
  }): Promise<void>;
  publishAdoptionReceipt(input: RelayRepositoryAuthority & {
    readonly targetRepository: string;
    readonly pr: RelayPullRequest;
    readonly serviceLogin: string;
    readonly receipt: IssueRelayAdoptionReceiptV1;
  }): Promise<IssueRelayAdoptionReceiptV1>;
}

function sameLogin(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function requireOid(value: string, label: string): void {
  if (!OID.test(value)) {
    throw new RelayGitPublisherError(
      'commit-contradiction',
      `${label} is not an exact Git OID`,
    );
  }
}

function assertDeterministicBranch(generation: string, branch: string): void {
  if (branch !== relayBranch(generation)) {
    throw new RelayGitPublisherError(
      'branch-contradiction',
      'Relay branch does not match the deterministic generation branch',
    );
  }
}

function assertManagedFork(input: {
  readonly targetRepository: string;
  readonly targetRepositoryId: string;
  readonly forkRepository: string;
  readonly forkRepositoryId: string;
  readonly forkParentRepositoryId: string;
}): void {
  if (
    input.targetRepository.toLowerCase()
      === input.forkRepository.toLowerCase()
    || input.targetRepositoryId.length === 0
    || input.forkRepositoryId.length === 0
    || input.targetRepositoryId === input.forkRepositoryId
    || input.forkParentRepositoryId !== input.targetRepositoryId
  ) {
    throw new RelayGitPublisherError(
      'branch-contradiction',
      'Relay publication target is not the authoritative managed fork',
    );
  }
}

function relayCommitMessage(input: RelayCommitAndPushInput): string {
  const summary = input.summary.trim();
  if (summary.length === 0 || /[\u0000]/.test(summary)) {
    throw new RelayGitPublisherError(
      'commit-contradiction',
      'Relay commit summary is empty or unsafe',
    );
  }
  return [
    summary,
    '',
    `Jinn-Relay-Generation: ${input.generation}`,
    `Jinn-Relay-Round: ${input.round}`,
    `Jinn-Relay-Task: ${input.taskId}`,
    `Jinn-Relay-Envelope: ${input.deliveryEnvelopeCid}`,
    `Jinn-Relay-Patch: ${input.patchDigest}`,
  ].join('\n');
}

export function formatRelayPullRequestMarker(generation: string): string {
  if (generation.length === 0 || generation.includes('\u0000')) {
    throw new RelayGitPublisherError(
      'pr-contradiction',
      'Relay generation marker is empty or unsafe',
    );
  }
  return `${PR_MARKER}\n\n\`\`\`json\n${JSON.stringify({ generation })}\n\`\`\``;
}

export function parseRelayPullRequestMarker(body: string): string | null {
  const marker = /^<!-- jinn-issue-relay:pull-request:v1 -->\n\n```json\n([^\r\n]+)\n```$/;
  const match = marker.exec(body);
  if (match?.[1] === undefined) return null;
  try {
    const value: unknown = JSON.parse(match[1]);
    if (
      value === null
      || typeof value !== 'object'
      || Array.isArray(value)
      || Object.keys(value).length !== 1
      || typeof (value as { readonly generation?: unknown }).generation
        !== 'string'
    ) {
      return null;
    }
    const generation = (value as { readonly generation: string }).generation;
    return JSON.stringify({ generation }) === match[1] ? generation : null;
  } catch {
    return null;
  }
}

export function formatRelayAdoptionReceiptBlock(
  receipt: IssueRelayAdoptionReceiptV1,
): string {
  const canonical = IssueRelayAdoptionReceiptV1Schema.parse(receipt);
  return `${ADOPTION_MARKER}\n\n\`\`\`json\n${JSON.stringify(canonical)}\n\`\`\``;
}

export function parseRelayAdoptionReceiptBlock(
  body: string,
): IssueRelayAdoptionReceiptV1 | null {
  const first = body.indexOf(ADOPTION_MARKER);
  if (first === -1) return null;
  if (body.indexOf(ADOPTION_MARKER, first + ADOPTION_MARKER.length) !== -1) {
    throw new RelayGitPublisherError(
      'receipt-contradiction',
      'Relay assurance comment contains multiple adoption receipt markers',
    );
  }
  const block = body.slice(first);
  const match = /^<!-- jinn-issue-relay:adoption:v1 -->\n\n```json\n([^\r\n]+)\n```(?:\n|$)/.exec(block);
  if (match?.[1] === undefined) {
    throw new RelayGitPublisherError(
      'receipt-contradiction',
      'Relay adoption receipt marker is malformed',
    );
  }
  try {
    const parsed = IssueRelayAdoptionReceiptV1Schema.parse(
      JSON.parse(match[1]) as unknown,
    ) as IssueRelayAdoptionReceiptV1;
    if (JSON.stringify(parsed) !== match[1]) {
      throw new Error('noncanonical receipt JSON');
    }
    return parsed;
  } catch (error) {
    if (error instanceof RelayGitPublisherError) throw error;
    throw new RelayGitPublisherError(
      'receipt-contradiction',
      'Relay adoption receipt marker does not contain a canonical receipt',
      error,
    );
  }
}

function exactPr(
  candidate: RelayPullRequest,
  input: RelayDraftPullRequestInput,
): boolean {
  return candidate.generation === input.generation
    && candidate.targetRepositoryId === input.targetRepositoryId
    && candidate.forkRepositoryId === input.forkRepositoryId
    && candidate.forkParentRepositoryId === input.forkParentRepositoryId
    && candidate.branch === input.branch
    && candidate.head === input.resultingHead
    && candidate.base === input.defaultBranch
    && candidate.open
    && candidate.draft
    && (
      input.existingPrNumber === undefined
      || candidate.number === input.existingPrNumber
    );
}

function sameExactPrIdentity(
  left: RelayPullRequest,
  right: RelayPullRequest,
): boolean {
  return left.number === right.number
    && left.targetRepositoryId === right.targetRepositoryId
    && left.forkRepositoryId === right.forkRepositoryId
    && left.forkParentRepositoryId === right.forkParentRepositoryId
    && left.generation === right.generation
    && left.branch === right.branch
    && left.head === right.head
    && left.base === right.base
    && left.open === right.open
    && left.draft === right.draft;
}

function assertExactPr(
  candidate: RelayPullRequest,
  input: RelayDraftPullRequestInput,
): RelayPullRequest {
  if (!exactPr(candidate, input)) {
    throw new RelayGitPublisherError(
      'pr-contradiction',
      'Relay pull request marker or exact head/base/draft facts contradict adoption',
    );
  }
  return candidate;
}

function exactReceiptCorrelation(
  left: IssueRelayAdoptionReceiptV1['correlation'],
  right: IssueRelayAdoptionReceiptV1['correlation'],
): boolean {
  return isDeepStrictEqual(left, right);
}

export function createRelayGitPublisher(options: {
  readonly git: RelayGitCommandRunner;
  readonly github: RelayGitHubCommandRunner;
}): RelayAdoptionPublisher {
  const git = options.git;
  const github = options.github;

  const listPrs = async (
    input: Pick<
    RelayDraftPullRequestInput,
    | 'targetRepository'
    | 'targetRepositoryId'
    | 'forkRepository'
    | 'forkRepositoryId'
    | 'forkParentRepositoryId'
    | 'branch'
    >,
  ): Promise<readonly RelayPullRequest[]> => {
    const result = await github({
      kind: 'list-pull-requests',
      repository: input.targetRepository,
      targetRepositoryId: input.targetRepositoryId,
      forkRepository: input.forkRepository,
      forkRepositoryId: input.forkRepositoryId,
      forkParentRepositoryId: input.forkParentRepositoryId,
      branch: input.branch,
    });
    if (result.kind !== 'pull-requests') {
      throw new RelayGitPublisherError(
        'pr-contradiction',
        'Relay pull request listing returned the wrong result kind',
      );
    }
    return result.pullRequests;
  };

  const readPr = async (
    authority: RelayRepositoryAuthority,
    repository: string,
    number: number,
  ): Promise<RelayPullRequest> => {
    const result = await github({
      kind: 'read-pull-request',
      repository,
      ...authority,
      prNumber: number,
    });
    if (result.kind !== 'pull-request') {
      throw new RelayGitPublisherError(
        'pr-contradiction',
        'Relay pull request readback returned the wrong result kind',
      );
    }
    return result.pullRequest;
  };

  const listAssurance = async (
    authority: RelayRepositoryAuthority,
    repository: string,
    prNumber: number,
  ): Promise<readonly RelayAssuranceComment[]> => {
    const result = await github({
      kind: 'list-assurance-comments',
      repository,
      ...authority,
      prNumber,
    });
    if (result.kind !== 'assurance-comments') {
      throw new RelayGitPublisherError(
        'receipt-contradiction',
        'Relay assurance comment listing returned the wrong result kind',
      );
    }
    return result.comments;
  };

  const ownedAssurance = async (
    authority: RelayRepositoryAuthority,
    repository: string,
    prNumber: number,
    serviceLogin: string,
  ): Promise<RelayAssuranceComment | undefined> => {
    const owned = (await listAssurance(authority, repository, prNumber)).filter(
      (comment) =>
        sameLogin(comment.authorLogin, serviceLogin)
        && comment.body.includes(ASSURANCE_MARKER),
    );
    if (owned.length > 1) {
      throw new RelayGitPublisherError(
        'receipt-contradiction',
        'Relay has more than one owned assurance comment',
      );
    }
    return owned[0];
  };

  return {
    async recoverAccepted(input) {
      assertDeterministicBranch(input.generation, input.branch);
      if (input.prNumber === undefined) return undefined;
      const prs = await listPrs(input);
      if (prs.length === 0) return undefined;
      if (prs.length !== 1 || prs[0]!.number !== input.prNumber) {
        throw new RelayGitPublisherError(
          'pr-contradiction',
          'Relay replay found contradictory pull requests for the generation branch',
        );
      }
      const pr = await readPr(input, input.targetRepository, input.prNumber);
      if (
        pr.generation !== input.generation
        || pr.targetRepositoryId !== input.targetRepositoryId
        || pr.forkRepositoryId !== input.forkRepositoryId
        || pr.forkParentRepositoryId !== input.forkParentRepositoryId
        || pr.branch !== input.branch
        || pr.base !== input.defaultBranch
        || (!pr.open && input.allowClosed !== true)
        || !pr.draft
      ) {
        throw new RelayGitPublisherError(
          'pr-contradiction',
          'Relay replay pull request marker or state is contradictory',
        );
      }
      const comment = await ownedAssurance(
        input,
        input.targetRepository,
        input.prNumber,
        input.serviceLogin,
      );
      if (comment === undefined) return undefined;
      const receipt = parseRelayAdoptionReceiptBlock(comment.body);
      if (receipt === null) return undefined;
      if (
        receipt.disposition !== 'accepted'
        || !exactReceiptCorrelation(receipt.correlation, input.correlation)
        || receipt.prNumber !== pr.number
        || receipt.resultingHead !== pr.head
        || receipt.headRef !== pr.branch
      ) {
        throw new RelayGitPublisherError(
          'receipt-contradiction',
          'Relay replay receipt contradicts the exact pull request',
        );
      }
      return receipt;
    },

    async recoverPublished(input) {
      assertDeterministicBranch(input.generation, input.branch);
      assertManagedFork(input);
      requireOid(input.inputHead, 'Relay input head');
      const message = relayCommitMessage({
        ...input,
        expectedTree: input.inputHead,
        expectedForkHead: undefined,
      });
      const fork = await git({
        kind: 'read-fork-ref',
        targetRepositoryId: input.targetRepositoryId,
        forkRepositoryId: input.forkRepositoryId,
        forkParentRepositoryId: input.forkParentRepositoryId,
        repository: input.forkRepository,
        branch: input.branch,
      });
      if (fork.kind !== 'fork-ref') {
        throw new RelayGitPublisherError(
          'stale-fork',
          'Relay recovery fork ref returned the wrong result kind',
        );
      }
      if (fork.head === undefined || fork.head === input.inputHead) {
        return undefined;
      }
      requireOid(fork.head, 'Relay recovery fork head');
      const commit = await git({
        kind: 'read-fork-commit',
        targetRepositoryId: input.targetRepositoryId,
        forkRepositoryId: input.forkRepositoryId,
        forkParentRepositoryId: input.forkParentRepositoryId,
        repository: input.forkRepository,
        branch: input.branch,
        head: fork.head,
        expectedMessage: message,
      });
      if (
        commit.kind !== 'commit'
        || commit.head !== fork.head
        || !OID.test(commit.tree)
        || commit.parents.length !== 1
        || commit.parents[0] !== input.inputHead
        || commit.message !== message
      ) {
        throw new RelayGitPublisherError(
          'commit-contradiction',
          'Relay recovery commit failed exact parent or trailer readback',
        );
      }
      return {
        branch: input.branch,
        resultingHead: fork.head,
        tree: commit.tree,
      };
    },

    async readAppliedTree(input) {
      requireOid(input.inputHead, 'Relay input head');
      const result = await git({
        kind: 'read-applied-tree',
        worktreePath: input.worktreePath,
        inputHead: input.inputHead,
      });
      if (
        result.kind !== 'applied-tree'
        || result.head !== input.inputHead
        || !result.exact
        || !OID.test(result.tree)
      ) {
        throw new RelayGitPublisherError(
          'commit-contradiction',
          'Relay worktree does not contain exactly the applied solution tree',
        );
      }
      return result.tree;
    },

    async commitAndPush(input) {
      assertDeterministicBranch(input.generation, input.branch);
      assertManagedFork(input);
      requireOid(input.inputHead, 'Relay input head');
      requireOid(input.expectedTree, 'Relay expected tree');
      if (
        input.expectedForkHead !== undefined
        && !OID.test(input.expectedForkHead)
      ) {
        throw new RelayGitPublisherError(
          'stale-fork',
          'Relay expected-old fork head is invalid',
        );
      }
      const message = relayCommitMessage(input);
      const localResult = await git({
        kind: 'read-local-head',
        worktreePath: input.worktreePath,
      });
      if (localResult.kind !== 'local-head' || !OID.test(localResult.head)) {
        throw new RelayGitPublisherError(
          'commit-contradiction',
          'Relay local head readback is malformed',
        );
      }
      const forkBeforeResult = await git({
        kind: 'read-fork-ref',
        targetRepositoryId: input.targetRepositoryId,
        forkRepositoryId: input.forkRepositoryId,
        forkParentRepositoryId: input.forkParentRepositoryId,
        repository: input.forkRepository,
        branch: input.branch,
      });
      if (forkBeforeResult.kind !== 'fork-ref') {
        throw new RelayGitPublisherError(
          'stale-fork',
          'Relay fork ref readback returned the wrong result kind',
        );
      }
      let resultingHead = localResult.head;
      if (localResult.head === input.inputHead) {
        if (forkBeforeResult.head !== input.expectedForkHead) {
          throw new RelayGitPublisherError(
            'stale-fork',
            'Relay fork branch no longer equals its expected-old head',
          );
        }
        try {
          await git({
            kind: 'create-commit',
            worktreePath: input.worktreePath,
            expectedHead: input.inputHead,
            expectedTree: input.expectedTree,
            message,
          });
        } catch {
          // commit-tree/update-ref can succeed before the runner reports an
          // error; the exact commit readback below is authoritative.
        }
        const after = await git({
          kind: 'read-local-head',
          worktreePath: input.worktreePath,
        });
        if (
          after.kind !== 'local-head'
          || after.head === input.inputHead
          || !OID.test(after.head)
        ) {
          throw new RelayGitPublisherError(
            'commit-contradiction',
            'Relay host commit did not advance the exact local head',
          );
        }
        resultingHead = after.head;
      }
      const commit = await git({
        kind: 'read-commit',
        worktreePath: input.worktreePath,
        head: resultingHead,
        expectedMessage: message,
      });
      if (
        commit.kind !== 'commit'
        || commit.head !== resultingHead
        || commit.tree !== input.expectedTree
        || commit.parents.length !== 1
        || commit.parents[0] !== input.inputHead
        || commit.message !== message
      ) {
        throw new RelayGitPublisherError(
          'commit-contradiction',
          'Relay host commit failed exact tree, parent, or trailer readback',
        );
      }
      const forkBefore = forkBeforeResult.head;
      if (
        forkBefore !== resultingHead
        && forkBefore !== input.expectedForkHead
      ) {
        throw new RelayGitPublisherError(
          'stale-fork',
          'Relay fork branch changed before expected-old publication',
        );
      }
      if (forkBefore !== resultingHead) {
        try {
          await git({
            kind: 'push-fork',
            targetRepositoryId: input.targetRepositoryId,
            forkRepositoryId: input.forkRepositoryId,
            forkParentRepositoryId: input.forkParentRepositoryId,
            repository: input.forkRepository,
            branch: input.branch,
            expectedOldHead: input.expectedForkHead,
            newHead: resultingHead,
          });
        } catch {
          // An expected-old push may succeed before transport failure. The
          // exact ref readback below decides whether the mutation committed.
        }
      }
      const forkAfter = await git({
        kind: 'read-fork-ref',
        targetRepositoryId: input.targetRepositoryId,
        forkRepositoryId: input.forkRepositoryId,
        forkParentRepositoryId: input.forkParentRepositoryId,
        repository: input.forkRepository,
        branch: input.branch,
      });
      if (forkAfter.kind !== 'fork-ref' || forkAfter.head !== resultingHead) {
        throw new RelayGitPublisherError(
          'fork-push-contradiction',
          'Relay fork push did not read back the exact host commit',
        );
      }
      return { branch: input.branch, resultingHead };
    },

    async ensureDraftPullRequest(input) {
      assertDeterministicBranch(input.generation, input.branch);
      const forkOwner = input.forkRepository.split('/')[0];
      if (forkOwner === undefined || forkOwner.length === 0) {
        throw new RelayGitPublisherError(
          'pr-contradiction',
          'Relay fork repository does not have an owner',
        );
      }
      let candidates = await listPrs(input);
      if (candidates.length === 0) {
        try {
          await github({
            kind: 'create-draft-pull-request',
            targetRepositoryId: input.targetRepositoryId,
            forkRepositoryId: input.forkRepositoryId,
            forkParentRepositoryId: input.forkParentRepositoryId,
            repository: input.targetRepository,
            title: `Jinn Issue Relay: #${input.issueNumber}`,
            body: formatRelayPullRequestMarker(input.generation),
            head: `${forkOwner}:${input.branch}`,
            base: input.defaultBranch,
            draft: true,
          });
        } catch {
          // PR creation is ambiguous on transport failure; branch+marker
          // search is the durable recovery source.
        }
        candidates = await listPrs(input);
      }
      if (candidates.length !== 1) {
        throw new RelayGitPublisherError(
          'pr-contradiction',
          'Relay generation does not own exactly one pull request',
        );
      }
      const listed = assertExactPr(candidates[0]!, input);
      const readback = await readPr(input, input.targetRepository, listed.number);
      return assertExactPr(readback, input);
    },

    async closeDraftPullRequest(input) {
      if (
        input.pr.targetRepositoryId !== input.targetRepositoryId
        || input.pr.forkRepositoryId !== input.forkRepositoryId
        || input.pr.forkParentRepositoryId !== input.forkParentRepositoryId
        || input.pr.head !== input.expectedHead
        || !input.pr.draft
      ) {
        throw new RelayGitPublisherError(
          'pr-contradiction',
          'Relay cancellation does not own the exact open draft PR head',
        );
      }
      if (!input.pr.open) {
        const alreadyClosed = await readPr(
          input,
          input.targetRepository,
          input.pr.number,
        );
        if (!sameExactPrIdentity(alreadyClosed, input.pr)) {
          throw new RelayGitPublisherError(
            'pr-contradiction',
            'Relay cancelled pull request closed-state readback is contradictory',
          );
        }
        return;
      }
      try {
        await github({
          kind: 'close-pull-request',
          targetRepositoryId: input.targetRepositoryId,
          forkRepositoryId: input.forkRepositoryId,
          forkParentRepositoryId: input.forkParentRepositoryId,
          repository: input.targetRepository,
          prNumber: input.pr.number,
          expectedGeneration: input.pr.generation,
          expectedBranch: input.pr.branch,
          expectedHead: input.expectedHead,
          expectedBase: input.pr.base,
          expectedDraft: true,
          expectedOpen: true,
          reason: input.reason,
        });
      } catch {
        // Close may commit before transport failure; exact readback follows.
      }
      const readback = await readPr(input, input.targetRepository, input.pr.number);
      if (!sameExactPrIdentity(readback, { ...input.pr, open: false })) {
        throw new RelayGitPublisherError(
          'pr-contradiction',
          'Relay cancelled pull request did not read back closed at the exact head',
        );
      }
    },

    async publishAdoptionReceipt(input) {
      if (
        input.pr.targetRepositoryId !== input.targetRepositoryId
        || input.pr.forkRepositoryId !== input.forkRepositoryId
        || input.pr.forkParentRepositoryId !== input.forkParentRepositoryId
      ) {
        throw new RelayGitPublisherError(
          'receipt-contradiction',
          'Relay receipt target repository identity is contradictory',
        );
      }
      const canonical = IssueRelayAdoptionReceiptV1Schema.parse(
        input.receipt,
      ) as IssueRelayAdoptionReceiptV1;
      const prBefore = await readPr(
        input,
        input.targetRepository,
        input.pr.number,
      );
      if (!sameExactPrIdentity(prBefore, input.pr)) {
        throw new RelayGitPublisherError(
          'receipt-contradiction',
          'Relay lost exact draft PR authority before receipt publication',
        );
      }
      const existing = await ownedAssurance(
        input,
        input.targetRepository,
        input.pr.number,
        input.serviceLogin,
      );
      const block = formatRelayAdoptionReceiptBlock(canonical);
      let alreadyPublished = false;
      if (existing !== undefined) {
        const prior = parseRelayAdoptionReceiptBlock(existing.body);
        if (prior !== null) {
          if (isDeepStrictEqual(prior, canonical)) {
            alreadyPublished = true;
          } else {
            throw new RelayGitPublisherError(
              'receipt-contradiction',
              'Relay assurance comment contains a contradictory adoption receipt',
            );
          }
        }
      }
      const body = existing === undefined
        ? `${ASSURANCE_MARKER}\n\nIN PROGRESS\n\n${block}`
        : alreadyPublished
          ? existing.body
          : `${existing.body.trimEnd()}\n\n${block}`;
      if (!alreadyPublished) {
        try {
          await github(existing === undefined
            ? {
              kind: 'create-assurance-comment',
              targetRepositoryId: input.targetRepositoryId,
              forkRepositoryId: input.forkRepositoryId,
              forkParentRepositoryId: input.forkParentRepositoryId,
              repository: input.targetRepository,
              prNumber: input.pr.number,
              expectedHead: input.pr.head,
              body,
            }
            : {
              kind: 'edit-assurance-comment',
              targetRepositoryId: input.targetRepositoryId,
              forkRepositoryId: input.forkRepositoryId,
              forkParentRepositoryId: input.forkParentRepositoryId,
              repository: input.targetRepository,
              prNumber: input.pr.number,
              commentId: existing.id,
              expectedHead: input.pr.head,
              body,
            });
        } catch {
          // Comment create/edit may be committed before a transport error. The
          // one-comment exact body and receipt readback below is authoritative.
        }
      }
      const prAfter = await readPr(input, input.targetRepository, input.pr.number);
      if (!sameExactPrIdentity(prAfter, input.pr)) {
        throw new RelayGitPublisherError(
          'receipt-contradiction',
          'Relay draft PR head changed during receipt publication',
        );
      }
      const readback = await ownedAssurance(
        input,
        input.targetRepository,
        input.pr.number,
        input.serviceLogin,
      );
      if (readback === undefined || readback.body !== body) {
        throw new RelayGitPublisherError(
          'receipt-contradiction',
          'Relay assurance comment did not read back exactly',
        );
      }
      const parsed = parseRelayAdoptionReceiptBlock(readback.body);
      if (parsed === null || !isDeepStrictEqual(parsed, canonical)) {
        throw new RelayGitPublisherError(
          'receipt-contradiction',
          'Relay adoption receipt did not parse exactly after publication',
        );
      }
      return parsed;
    },
  };
}
