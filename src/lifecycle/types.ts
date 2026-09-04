// `stack-authority.ts` imports nothing, so this keeps the leaf-module shape:
// the stack vocabulary has exactly one definition and both the lifecycle and
// the dispatcher can reach it without a cycle.
import type { StackVerdict } from './stack-authority.js';
import type { AutopilotRuntime } from '../autopilot-runtime.js';

export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type GitOid = Brand<string, 'GitOid'>;
export type GitRefName = Brand<string, 'GitRefName'>;
export type IsoTimestamp = Brand<string, 'IsoTimestamp'>;

export const COMPARE_STATUSES = ['ahead', 'identical', 'behind', 'diverged', 'unknown'] as const;
export type CompareStatus = typeof COMPARE_STATUSES[number];

export function decodeCompareStatus(value: unknown): CompareStatus {
  return typeof value === 'string' && (COMPARE_STATUSES as readonly string[]).includes(value)
    ? value as CompareStatus
    : 'unknown';
}

const OID_PATTERN = /^[0-9a-f]{40}$/;
/**
 * Exactly the single characters `git check-ref-format` forbids: ASCII control
 * characters and space (`\u0000`-`\u0020`), DEL (`\u007f`), and `~ ^ : ? * [ \`.
 *
 * `]` is deliberately absent. Git accepts it -- `git check-ref-format
 * refs/heads/feat/x]y` exits 0 -- and it is inert in a URL path, so rejecting
 * it only ever produced false negatives. That became load-bearing once
 * `github-reader` started passing arbitrary PR base refs through `gitRefName`:
 * one PR based on a branch containing `]` threw and aborted the *entire*
 * snapshot read, not just that PR. Fail-closed with a repo-wide blast radius is
 * still an outage.
 *
 * Everything that can change what a compare/contents URL means is still
 * rejected, here or by the structural rules in `gitRefName`. `..` in particular
 * must stay rejected: it is what stops a base branch named `x...y` from
 * injecting a second `...` separator into `compare/heads/{base}...{head}` and
 * silently changing which comparison is performed.
 */
const INVALID_REF_PATTERN = /[\u0000-\u0020\u007f~^:?*[\\]/;

export function gitOid(value: string): GitOid {
  if (!OID_PATTERN.test(value)) {
    throw new Error(`Invalid Git OID: ${value}`);
  }
  return value as GitOid;
}

export function gitRefName(value: string): GitRefName {
  const segments = value.split('/');
  if (
    value.length === 0
    || value === '@'
    || value.startsWith('/')
    || value.endsWith('/')
    || value.startsWith('.')
    || value.endsWith('.')
    || value.includes('..')
    || value.includes('//')
    || value.includes('@{')
    || INVALID_REF_PATTERN.test(value)
    || segments.some((segment) => segment.length === 0
      || segment.startsWith('.')
      || segment.endsWith('.')
      || segment.endsWith('.lock'))
  ) {
    throw new Error(`Invalid Git ref name: ${value}`);
  }
  return value as GitRefName;
}

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function isoTimestamp(value: string): IsoTimestamp {
  const time = Date.parse(value);
  if (!ISO_TIMESTAMP_PATTERN.test(value) || !Number.isFinite(time)) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return value as IsoTimestamp;
}

export type AutopilotMode = 'observe' | 'recover' | 'active';

export type LifecyclePhase =
  | 'eligible'
  | 'implementing'
  | 'awaiting-review'
  | 'reviewing'
  | 'blocked-by-child'
  | 'ci-blocked'
  | 'merge-ready'
  | 'human'
  | 'merged';

export type BranchClaimPhase = 'implement' | 'fix' | 'reconcile';

interface BranchClaimBase {
  readonly kind: 'branch-claim';
  readonly protocolVersion: 2;
  readonly issueNumber: number;
  readonly attempt: string;
  readonly runner: string;
  readonly login: string;
  readonly expectedHead: GitOid;
  readonly targetBase: GitRefName;
  readonly claimedAt: string;
  readonly phaseComplete?: true;
}

export type BranchClaim =
  | (BranchClaimBase & {
      readonly phase: 'implement';
      readonly prNumber?: number;
    })
  | (BranchClaimBase & {
      readonly phase: 'fix' | 'reconcile';
      readonly prNumber: number;
    });

export type ReviewClaimState =
  | 'active'
  | 'verdict-intent'
  | 'terminal-approved'
  | 'mapping-reread'
  | 'human-intent'
  | 'human'
  | 'stale';

export type ReviewVerdictState = 'APPROVE' | 'REQUEST_CHANGES';

export interface ReviewVerdict {
  readonly marker: string;
  readonly state: ReviewVerdictState;
}

/**
 * Bounded identity captured by an isolated review worker when its scheduled
 * PR mapping no longer proves unique. It deliberately carries no diagnostic:
 * only the coordinator's complete canonical snapshot may produce one.
 */
export interface MappingRereadRequest {
  readonly selectedIssueNumber: number;
  readonly headRefName: string;
  readonly baseRefName: string;
}

/** Exact, deterministic authority for one canonical mapping diagnostic. */
export interface MappingDiagnosticAuthority {
  readonly selectedIssueNumber: number;
  readonly issueNumbers: readonly number[];
  readonly detail: string;
  readonly signature: string;
}

interface ReviewClaimBase {
  readonly kind: 'review-claim';
  readonly protocolVersion: 2;
  readonly prNumber: number;
  readonly generation: string;
  readonly attempt: string;
  readonly reviewer: string;
  readonly head: GitOid;
  readonly recordedAt: string;
  /**
   * Identity of the diff this claim's head presented against its base at the
   * moment the reviewer read it — see `reviewed-diff-digest.ts` for the exact
   * construction and its `v1:<sha256>` shape.
   *
   * Optional, and its absence is load-bearing: claims written before this field
   * existed, and claims whose digest could not be proven, carry no digest, and
   * the merge gate must then keep requiring exact head identity. Never treat a
   * missing digest as "the diff did not change".
   */
  readonly reviewedDiffDigest?: string;
}

export type ReviewClaimRecord =
  | (ReviewClaimBase & {
      readonly state: 'active' | 'stale';
      readonly verdict?: never;
    })
  | (ReviewClaimBase & {
      readonly state: 'mapping-reread';
      readonly mappingRequest: MappingRereadRequest;
      readonly verdict?: never;
    })
  | (ReviewClaimBase & {
      readonly state: 'human-intent';
      readonly mappingDiagnostic: MappingDiagnosticAuthority;
      readonly verdict?: never;
    })
  | (ReviewClaimBase & {
      readonly state: 'human';
      readonly mappingDiagnostic?: MappingDiagnosticAuthority;
      readonly verdict?: never;
    })
  | (ReviewClaimBase & {
      readonly state: 'verdict-intent';
      readonly verdict: ReviewVerdict;
    })
  | (ReviewClaimBase & {
      readonly state: 'terminal-approved';
      readonly verdict: ReviewVerdict & { readonly state: 'APPROVE' };
    });

export type HumanReason =
  | {
      readonly phase: 'eligible' | 'implementing';
      readonly code:
        | 'first-push'
        | 'implementation-escalation'
        | 'branch-mapping-ambiguous'
        | 'invalid-branch-progress-time';
      readonly detail: string;
    }
  | {
      readonly phase: 'awaiting-review' | 'reviewing';
      readonly code:
        | 'review-escalation'
        | 'branch-mapping-ambiguous'
        | 'reviewer-identity-unavailable'
        | 'invalid-review-progress-time';
      readonly detail: string;
    }
  | {
      readonly phase: 'merge-ready';
      readonly code:
        | 'semantic-conflict'
        | 'codeowner-sensitive-conflict'
        | 'invalid-merge-progress-time'
        | 'runaway-child';
      readonly detail: string;
    };

export type IssueEligibilityReason =
  | 'eligible'
  | 'dependency-blocked'
  | 'author-disallowed'
  | 'not-selected';

export interface LifecycleItemBase {
  readonly issueNumber: number;
  readonly v2Marked: boolean;
  readonly projectStatus: 'Todo' | 'In Progress' | 'Human' | 'In Review' | 'Done' | null;
  readonly labels: readonly string[];
  readonly humanHold?: boolean;
  readonly humanReason?: HumanReason;
}

export interface IssueLifecycleItem extends LifecycleItemBase {
  readonly kind: 'issue';
  readonly eligible: boolean;
  readonly eligibilityReason?: IssueEligibilityReason;
  readonly eligibilityDetail?: string;
}

export interface TerminalVerdictEvidence {
  readonly head: GitOid;
  readonly state: ReviewVerdictState;
  readonly recordedAt: string;
  readonly marker: string;
}

export interface CheckSummary {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly source?: 'check-run' | 'commit-status';
  readonly runId?: number;
  readonly checkSuiteId?: number;
  readonly runAttempt?: number;
}

export interface PullRequestLifecycleItem extends LifecycleItemBase {
  readonly kind: 'pull-request';
  readonly prNumber: number;
  readonly head: GitOid;
  /** Base authority derived independently from configured default/dependency evidence. */
  readonly expectedBaseRefName?: string;
  /**
   * Exact machine-authored mapping hold that may be repaired under review-ref
   * CAS after the canonical mapping has become uniquely resolvable.
   */
  readonly obsoleteMachineMappingHuman?: {
    readonly generation: string;
    readonly author: string;
    readonly mappingDiagnostic: MappingDiagnosticAuthority;
    readonly reason: {
      readonly phase: 'eligible' | 'implementing' | 'awaiting-review' | 'reviewing';
      readonly code: 'branch-mapping-ambiguous';
      readonly detail: string;
    };
  };
  readonly headChangedAt: string;
  readonly isDraft: boolean;
  readonly merged: boolean;
  readonly needsReview: boolean;
  readonly approved: boolean;
  readonly mergeState: 'clean' | 'behind' | 'conflict' | 'blocked';
  readonly checks?: readonly CheckSummary[];
  /** True when a CAS-fenced CI rerun record exists for this PR head. */
  readonly ciRerunRecorded?: boolean;
  /**
   * A durable enqueue hold is recorded for this PR head: the terminal flake
   * hold (`flake`), or a merge-queue refusal that is durable for this pull
   * request (`rejected`). Head-keyed, so pushing a commit releases it.
   *
   * Distinct from `LifecycleStatusItem.enqueueHolds`, which names the
   * *repository-wide kill switches* engaged this cycle. This one is a fact
   * about this head, read from the remote.
   *
   * Absent is not proof there is no hold — only the full reader stamps it — so
   * absence reproduces today's behaviour rather than asserting anything.
   */
  readonly enqueueHold?: 'flake' | 'rejected';
  /**
   * Where this pull request sits in the dependency-stack graph (issue #114),
   * derived by `stack-authority.ts` from the head/base/state of every pull
   * request in the same snapshot: `root` when it is based on the default
   * branch, `stacked-valid` when its base chain reaches the default branch
   * through open pull requests, `stacked-broken` when the chain reaches a ref
   * no open pull request owns, or a cycle.
   *
   * Recomputed every cycle and never persisted as a decision, so a stack
   * releases on its own the moment its root merges and GitHub retargets the
   * children. Absent means *not derived* — a scoped snapshot, or a reader that
   * never composed one — and must never be read as `stacked-broken`.
   */
  readonly stackVerdict?: StackVerdict;
  /**
   * Bottom-most open pull request of this one's stack: the root that has to
   * land first. The pull request itself when it is already the root. Absent
   * whenever `stackVerdict` is absent or `stacked-broken`.
   */
  readonly stackRootPr?: number;
  /**
   * The PR is sitting in GitHub's merge queue. Absent means *not proven
   * queued*, never "proven not queued": an unreadable membership must not
   * license a second enqueue, and a proven one must not be enqueued again.
   */
  readonly inMergeQueue?: boolean;
  /** Open child issues targeting this PR (Stage 2 single-surface children). */
  readonly openChildKinds?: readonly ('review-finding' | 'reconcile' | 'ci-failure')[];
  readonly branchClaim?: BranchClaim;
  readonly implementationSummary?: string;
  readonly reviewClaim?: ReviewClaimRecord;
  readonly terminalVerdict?: TerminalVerdictEvidence;
  /**
   * The claim reviewer's effective native review at `head` is APPROVED and
   * carries the signed marker naming the reviewed head — the merge gate's
   * `terminalReview` conjunct, projected so the lifecycle view can require the
   * same thing the gate will. Absent means false; absence must never let an
   * approval carry.
   */
  readonly reviewerApprovedAtHead?: boolean;
  /**
   * Identity of the diff `head` presents against its base branch tip — the same
   * construction as `ReviewClaimRecord.reviewedDiffDigest`, computed for the
   * head that exists now. Equality of the two is the only evidence that an
   * approval recorded at an older head still describes this one.
   *
   * Absent whenever it could not be proven. Absent is *unknown*, never
   * "unchanged".
   */
  readonly reviewedDiffDigest?: string;
}

export type LifecycleItem = IssueLifecycleItem | PullRequestLifecycleItem;

export interface LifecycleSnapshot {
  readonly items: readonly LifecycleItem[];
}

export interface LifecycleMappingDiagnostic {
  readonly code: 'branch-mapping-ambiguous';
  readonly detail: string;
  readonly issueNumbers: readonly number[];
  readonly signature: string;
  readonly issues: readonly {
    readonly number: number;
    readonly projectStatus: LifecycleItemBase['projectStatus'];
  }[];
  readonly pullRequests: readonly {
    readonly number: number;
    readonly head: GitOid;
    readonly draft: boolean;
    readonly labels: readonly string[];
  }[];
}

export interface LifecycleViewItem {
  readonly item: LifecycleItem;
  readonly phase: LifecyclePhase;
  readonly underlyingPhase?: Exclude<LifecyclePhase, 'human'>;
  readonly humanReason?: HumanReason;
  readonly stale: boolean;
  readonly staleSince?: string;
  readonly staleReason?: 'branch-head-unchanged' | 'review-progress-unchanged';
  readonly supersededReview: boolean;
}

export interface LifecycleView {
  readonly items: readonly LifecycleViewItem[];
}

export interface LocalCapacity {
  readonly implementationSlots: number;
  readonly reviewSlots: number;
  readonly usableCredentialLanes: number;
}

export type ImplementationClaimAction =
  | {
      readonly kind: 'claim-implementation';
      readonly intent: 'fresh';
      readonly issueNumber: number;
      /**
       * Schedule-time runtime routing (#152): set when the scheduler seated
       * this claim in the Codex overflow pool instead of a lane slot. Absent,
       * the session runs on the process-wide runtime as before.
       */
      readonly runtime?: AutopilotRuntime;
      /**
       * Schedule-time lane tag: this claim was admitted under the `child`
       * concurrency lane rather than the implementation one (#122). Advisory
       * only — it decides which lane's slot and fall-through budget the claim
       * spends, never what the executor does. Execution authority stays with
       * the issue's own child marker, which is also the sole source for the
       * attempt manifest's `childKind`.
       */
      readonly child?: true;
    }
  | {
      readonly kind: 'claim-implementation';
      readonly intent: 'stale-recovery';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly expectedHead: GitOid;
      readonly branch: GitRefName;
      readonly claimAttempt: string;
    };

export type NewWorkAction =
  | ImplementationClaimAction
  | {
      readonly kind: 'repair-machine-child';
      readonly issueNumber: number;
      readonly parentPr: number;
      readonly childKind: 'review-finding' | 'reconcile' | 'ci-failure';
      readonly expectedType: 'fix';
      readonly expectedEffort: 'low' | 'medium' | 'high';
      readonly expectedPriority: 'p1' | 'p2';
    }
  | {
      readonly kind: 'claim-review';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly head: GitOid;
    }
  | {
      readonly kind: 'file-reconcile-child';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly head: GitOid;
      readonly expectedBaseRefName: GitRefName;
      readonly effort: 'low' | 'medium' | 'high';
    }
  | {
      readonly kind: 'rerun-failed-checks';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly head: GitOid;
    }
  | {
      readonly kind: 'file-ci-failure-child';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly head: GitOid;
    }
  | {
      /**
       * File one debt sweep batching a merged/closed parent's open review
       * follow-ups (#126). Not head-pinned and not bound to a lifecycle item:
       * the subject is the parent pull request, whose lifecycle is already
       * over, and the members are ordinary open issues. Dedup lives at
       * execution time, on the parent-scoped sweep marker.
       */
      readonly kind: 'file-debt-sweep';
      readonly parentPr: number;
      /**
       * Structurally `DebtSweepMember` (`debt-sweep.ts`), spelled out here so
       * this module stays the leaf it is. Each member's Project Priority rides
       * along because the sweep's own priority is derived from the members that
       * are still open at filing time, not from the ones the snapshot saw.
       */
      readonly members: readonly {
        readonly number: number;
        readonly priority: 'p0' | 'p1' | 'p2' | 'p3' | 'p4';
      }[];
    }
  | {
      /**
       * Hand the exact head to GitHub's merge queue. The queue, not this
       * engine, constructs and lands the merge commit, so nothing downstream of
       * a successful enqueue may claim the change is merged.
       */
      readonly kind: 'enqueue';
      readonly issueNumber: number;
      readonly prNumber: number;
      readonly head: GitOid;
      readonly expectedBaseRefName: GitRefName;
    };

/** The three capped concurrency lanes new work draws its slots from. */
export type NewWorkLane = 'implementation' | 'child' | 'review';

/**
 * Which lane an action spends a slot from, or `null` for the actions that
 * spend none (machine-child repair, child filing, debt sweeps, rerun,
 * enqueue). Those are bounded where they are derived, not by a lane.
 *
 * One definition for the two places that must agree — the runtime's
 * per-action capacity guard and the controller's fall-through bookkeeping.
 * They disagreeing is how a claim gets refused against one lane's capacity and
 * charged to another lane's budget.
 */
export function laneForNewWorkAction(action: NewWorkAction): NewWorkLane | null {
  if (action.kind === 'claim-review') return 'review';
  if (action.kind !== 'claim-implementation') return null;
  return action.intent === 'fresh' && action.child === true
    ? 'child'
    : 'implementation';
}

export type RecoveryAction =
  | {
      readonly kind: 'mark-review-stale';
      readonly prNumber: number;
      readonly expectedGeneration: string;
      readonly expectedHead: GitOid;
    };

export type PlannedAction = NewWorkAction | RecoveryAction;

export type ScalarOidState = {
  readonly expected: GitOid | null;
  readonly published: GitOid;
  readonly observed: GitOid | null;
};

export type ClaimOutcome =
  | ({ readonly status: 'won' | 'lost' | 'already-applied' } & ScalarOidState)
  | ({ readonly status: 'ambiguous' } & ScalarOidState);

export type PublicationOutcome =
  | ({ readonly status: 'won' | 'lost' | 'already-applied' } & ScalarOidState)
  | ({ readonly status: 'ambiguous' } & ScalarOidState);
