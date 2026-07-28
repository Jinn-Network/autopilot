import type { RelayIssueInput } from './snapshot.js';

export interface RelayIssueCandidateFacts {
  readonly repository: {
    readonly slug: string;
    readonly nodeId: string;
    readonly visibility: 'PUBLIC' | 'PRIVATE' | 'INTERNAL';
    readonly defaultBranch: string;
  };
  readonly issue: {
    readonly number: number;
    readonly url: string;
    readonly title: string;
    readonly body: string;
    readonly authorLogin: string;
    readonly authorId: string;
    readonly updatedAt: string;
    readonly state: 'OPEN' | 'CLOSED';
    readonly isPullRequest: boolean;
    readonly labels: readonly string[];
  };
}

export interface RelayLabelEvent {
  readonly action: 'labeled' | 'unlabeled';
  readonly label: string;
  readonly actorLogin: string;
  readonly actorId: string;
  readonly createdAt: string;
}

export interface RelayGitHubReadPort {
  searchOptedInIssues(input: {
    readonly repository: 'Jinn-Network/mono';
    readonly label: 'engine:marketplace';
    readonly cursor?: string;
  }): Promise<{
    readonly issues: readonly RelayIssueCandidateFacts[];
    readonly nextCursor?: string;
  }>;
  readIssue(number: number): Promise<RelayIssueCandidateFacts>;
  listLabelEvents(number: number): Promise<readonly RelayLabelEvent[]>;
  readRepositoryPermission(login: string): Promise<
    'NONE' | 'READ' | 'TRIAGE' | 'WRITE' | 'MAINTAIN' | 'ADMIN'
  >;
  readDefaultBranchHead(): Promise<string>;
}

export interface RelayGitHubWritePort {
  upsertIssueStatusComment(input: {
    readonly issueNumber: number;
    readonly expectedCommentId?: number;
    readonly body: string;
  }): Promise<{ readonly commentId: number }>;
  upsertPullRequestAssuranceComment(input: {
    readonly prNumber: number;
    readonly expectedCommentId?: number;
    readonly body: string;
  }): Promise<{ readonly commentId: number }>;
  createDraftPullRequest(input: {
    readonly title: string;
    readonly body: string;
    readonly head: string;
    readonly base: string;
  }): Promise<{ readonly number: number; readonly headOid: string }>;
  markPullRequestReady(input: {
    readonly prNumber: number;
    readonly expectedHead: string;
  }): Promise<void>;
  closePullRequest(input: {
    readonly prNumber: number;
    readonly expectedHead: string;
    readonly reason: string;
  }): Promise<void>;
}

export interface RelayAdmissionPolicy {
  readonly repository: 'Jinn-Network/mono';
  readonly label: 'engine:marketplace';
  readonly maxIssueBytes: number;
  readonly maxAcceptanceItems: number;
  readonly forbiddenRequestPatterns: readonly RegExp[];
}

export type RelayAdmissionDecision =
  | { readonly status: 'admitted'; readonly input: RelayIssueInput }
  | {
      readonly status: 'awaiting-clarification';
      readonly code: 'missing-acceptance-evidence' | 'ambiguous-scope';
      readonly message: string;
    }
  | {
      readonly status: 'refused';
      readonly code:
        | 'not-public'
        | 'not-issue'
        | 'not-open'
        | 'not-self-labelled'
        | 'not-maintainer-authored'
        | 'requires-secrets'
        | 'unsupported-capability'
        | 'oversized';
      readonly message: string;
    };
