import type { BlockedOn } from '../dispatcher/types.js';
import type { GitOid } from './types.js';

export interface StructuredMappingIssue {
  readonly number: number;
  readonly blockedOn: BlockedOn | null;
  readonly blockedByIssues: readonly number[];
}

export interface StructuredMappingPullRequest {
  readonly number: number;
  readonly state: 'OPEN' | 'MERGED';
  readonly head: GitOid;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly closingIssueNumbers: readonly number[];
  readonly body: string;
}

export interface StructuredMappingStableBranch {
  readonly issueNumber: number;
  readonly phase: 'implement' | 'fix' | 'reconcile';
  readonly head: GitOid;
  readonly headRefName: string;
  readonly targetBase: string;
}

export interface StructuredMappingInput {
  readonly defaultBranch: string;
  readonly issues: readonly StructuredMappingIssue[];
  readonly pullRequests: readonly StructuredMappingPullRequest[];
  readonly stableBranches: readonly StructuredMappingStableBranch[];
}

export type StructuredPullRequestMapping =
  | {
      readonly status: 'resolved';
      readonly prNumber: number;
      readonly issueNumber: number;
      readonly expectedBaseRefName: string;
      readonly evidence: 'closing-reference' | 'stacked-empty-closing';
    }
  | {
      readonly status: 'ambiguous';
      readonly prNumber: number;
      readonly issueNumbers: readonly number[];
      readonly details: readonly string[];
    };

interface LifecycleMarker {
  readonly issueNumber: number;
  readonly headRefName: string;
}

const STABLE_BRANCH_PATTERN = /^autopilot\/([1-9][0-9]*)$/;
const LIFECYCLE_MARKER_PATTERN =
  /<!-- jinn-autopilot:v2 issue=([1-9][0-9]*) branch=([^ >]+) -->/g;

function stableBranchIssue(headRefName: string): number | undefined {
  const match = STABLE_BRANCH_PATTERN.exec(headRefName);
  if (match?.[1] === undefined) return undefined;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : undefined;
}

function lifecycleMarkers(body: string): readonly LifecycleMarker[] {
  return [...body.matchAll(LIFECYCLE_MARKER_PATTERN)].map((match) => ({
    issueNumber: Number(match[1]),
    headRefName: match[2]!,
  }));
}

/**
 * Every issue a pull request is evidence for. This is the predicate that
 * decides contention here: it feeds the unique-open-PR-per-issue count and the
 * parent-contender count. Any caller deciding whether some other PR bears on a
 * PR's mapping must reuse this exact predicate, because a narrower private copy
 * silently classifies a live contender as unrelated.
 *
 * The parameter is widened past {@link StructuredMappingPullRequest} so a REST
 * index row, which carries only a head ref name, reads through the same
 * predicate. An absent field simply contributes no evidence.
 */
export function evidencedIssueNumbers(
  pr: {
    readonly closingIssueNumbers?: readonly number[];
    readonly headRefName: string;
    readonly body?: string;
  },
): Set<number> {
  const numbers = new Set(pr.closingIssueNumbers ?? []);
  const branchIssue = stableBranchIssue(pr.headRefName);
  if (branchIssue !== undefined) numbers.add(branchIssue);
  for (const marker of lifecycleMarkers(pr.body ?? '')) numbers.add(marker.issueNumber);
  return numbers;
}

function inferredIssueNumbers(
  pr: StructuredMappingPullRequest,
  knownIssues: ReadonlySet<number>,
): Set<number> {
  return new Set(
    [...evidencedIssueNumbers(pr)].filter((issueNumber) => knownIssues.has(issueNumber)),
  );
}

export function resolveStructuredPullRequestMappings(
  input: StructuredMappingInput,
): readonly StructuredPullRequestMapping[] {
  const issues = new Map(input.issues.map((issue) => [issue.number, issue]));
  const knownIssues = new Set(issues.keys());
  const inferredByPr = new Map(input.pullRequests.map((pr) => [
    pr.number,
    inferredIssueNumbers(pr, knownIssues),
  ]));
  const openPrsByIssue = new Map<number, Set<number>>();
  for (const pr of input.pullRequests) {
    if (pr.state !== 'OPEN') continue;
    for (const issueNumber of inferredByPr.get(pr.number) ?? []) {
      const prs = openPrsByIssue.get(issueNumber) ?? new Set<number>();
      prs.add(pr.number);
      openPrsByIssue.set(issueNumber, prs);
    }
  }
  const selectedParentByChild = new Map<number, {
    readonly prNumber: number;
    readonly issueNumber: number;
  }>();
  const exactParentDependency = (
    childPrNumber: number,
    issue: StructuredMappingIssue,
    baseRefName: string,
  ): number | undefined => {
    if (issue.blockedOn !== 'Another issue') return undefined;
    const candidates = input.pullRequests.filter((candidate) => {
      if (
        candidate.state !== 'OPEN'
        || candidate.headRefName !== baseRefName
        || candidate.closingIssueNumbers.length !== 1
      ) {
        return false;
      }
      const dependency = candidate.closingIssueNumbers[0]!;
      if (!issue.blockedByIssues.includes(dependency)) return false;
      const markers = lifecycleMarkers(candidate.body);
      return markers.length === 0 || (
        markers.length === 1
        && markers[0]!.issueNumber === dependency
        && markers[0]!.headRefName === candidate.headRefName
      );
    });
    if (candidates.length !== 1) return undefined;
    const dependency = candidates[0]!.closingIssueNumbers[0]!;
    const parentEvidence = evidencedIssueNumbers(candidates[0]!);
    const parentContenders = input.pullRequests.filter((candidate) => (
      candidate.state === 'OPEN'
      && evidencedIssueNumbers(candidate).has(dependency)
    ));
    const exact = parentEvidence.size === 1
      && parentEvidence.has(dependency)
      && parentContenders.length === 1;
    if (!exact) return undefined;
    selectedParentByChild.set(childPrNumber, {
      prNumber: candidates[0]!.number,
      issueNumber: dependency,
    });
    return dependency;
  };

  const initial = input.pullRequests.map((pr): StructuredPullRequestMapping => {
    const details: string[] = [];
    const inferred = inferredByPr.get(pr.number) ?? new Set<number>();
    const closing = new Set(pr.closingIssueNumbers);
    const markers = lifecycleMarkers(pr.body);
    const branchIssue = stableBranchIssue(pr.headRefName);
    const primaryIssue = closing.size === 1
      ? [...closing][0]
      : pr.closingIssueNumbers.length === 0 && markers.length === 1
        ? markers[0]!.issueNumber
        : branchIssue;
    const issue = primaryIssue === undefined ? undefined : issues.get(primaryIssue);

    if (closing.size !== pr.closingIssueNumbers.length || closing.size > 1) {
      details.push('Closing-reference mapping is duplicated or names multiple issues.');
    }
    if (
      pr.closingIssueNumbers.length > 0
      && (primaryIssue === undefined || !knownIssues.has(primaryIssue))
    ) {
      details.push('Closing-reference mapping does not name one known lifecycle issue.');
    }
    if (
      branchIssue !== undefined
      && primaryIssue !== undefined
      && branchIssue !== primaryIssue
    ) {
      details.push(
        `Stable branch ${pr.headRefName} contradicts issue #${primaryIssue}.`,
      );
    }
    if (markers.length > 1) {
      details.push('PR body contains more than one lifecycle marker.');
    } else if (
      markers.length === 1
      && primaryIssue !== undefined
      && (
        markers[0]!.issueNumber !== primaryIssue
        || markers[0]!.headRefName !== pr.headRefName
      )
    ) {
      details.push('Lifecycle marker contradicts the resolved issue or exact PR branch.');
    }
    const stableClaim = primaryIssue === undefined
      ? undefined
      : input.stableBranches.find((branch) => (
          branch.issueNumber === primaryIssue
          && branch.phase === 'implement'
          && branch.headRefName === `autopilot/${primaryIssue}`
        ));
    if (
      stableClaim !== undefined
      && (
        stableClaim.headRefName !== pr.headRefName
        || stableClaim.head !== pr.head
        || stableClaim.targetBase !== pr.baseRefName
      )
    ) {
      details.push('stable branch claim does not match the exact PR branch, head, and base.');
    }

    const emptyClosing = pr.closingIssueNumbers.length === 0;
    let evidence: 'closing-reference' | 'stacked-empty-closing' = 'closing-reference';
    if (emptyClosing) {
      evidence = 'stacked-empty-closing';
      if (pr.state !== 'OPEN') {
        details.push('Empty closing references require the exact unique open PR.');
      }
      if (
        markers.length !== 1
        || markers[0]!.issueNumber !== primaryIssue
        || markers[0]!.headRefName !== pr.headRefName
      ) {
        details.push('Empty closing references require one exact single lifecycle marker.');
      }
      if (
        primaryIssue === undefined
        || branchIssue !== primaryIssue
        || stableClaim === undefined
        || stableClaim.head !== pr.head
        || stableClaim.headRefName !== pr.headRefName
        || stableClaim.targetBase !== pr.baseRefName
      ) {
        details.push('Empty closing references require an exact stable branch claim and head.');
      }
      if (
        issue?.blockedOn !== 'Another issue'
        || issue.blockedByIssues.length === 0
        || pr.baseRefName === input.defaultBranch
      ) {
        details.push(
          'Empty closing references require exact issue dependency evidence for the parent base.',
        );
      }
    }

    let expectedBaseRefName: string | undefined;
    if (pr.baseRefName === input.defaultBranch) {
      expectedBaseRefName = input.defaultBranch;
    } else {
      const namedDependency = stableBranchIssue(pr.baseRefName);
      const exactDependency = issue === undefined
        ? undefined
        : exactParentDependency(pr.number, issue, pr.baseRefName);
      const dependency = exactDependency ?? namedDependency;
      if (
        issue !== undefined
        && dependency !== undefined
        && issue.blockedOn === 'Another issue'
        && issue.blockedByIssues.includes(dependency)
        && (
          exactDependency !== undefined
          || (
            stableClaim !== undefined
            && stableClaim.head === pr.head
            && stableClaim.headRefName === pr.headRefName
            && stableClaim.targetBase === pr.baseRefName
          )
        )
      ) {
        expectedBaseRefName = pr.baseRefName;
      } else {
        details.push(
          `PR base ${pr.baseRefName} is not an authorized base from the configured default `
          + 'branch or an exact issue dependency.',
        );
        if (dependency !== undefined) {
          details.push(`Issue dependency evidence for parent #${dependency} is missing or contradictory.`);
        }
      }
    }

    if (
      primaryIssue === undefined
      || issue === undefined
      || inferred.size !== 1
    ) {
      details.push('PR evidence does not resolve to one known lifecycle issue.');
    } else if (
      pr.state === 'OPEN'
      && (openPrsByIssue.get(primaryIssue)?.size ?? 0) !== 1
    ) {
      details.push(`Issue #${primaryIssue} does not have one unique open PR.`);
    }

    if (details.length > 0 || primaryIssue === undefined || expectedBaseRefName === undefined) {
      return {
        status: 'ambiguous',
        prNumber: pr.number,
        issueNumbers: [...inferred].sort((left, right) => left - right),
        details: [...new Set(details)],
      };
    }
    return {
      status: 'resolved',
      prNumber: pr.number,
      issueNumber: primaryIssue,
      expectedBaseRefName,
      evidence,
    };
  });

  const initialByPr = new Map(initial.map((mapping) => [
    mapping.prNumber,
    mapping,
  ]));
  const parentIsCanonical = (
    prNumber: number,
    visiting: ReadonlySet<number>,
  ): boolean => {
    const mapping = initialByPr.get(prNumber);
    if (mapping?.status !== 'resolved') return false;
    const parent = selectedParentByChild.get(prNumber);
    if (parent === undefined) return true;
    if (parent.prNumber === prNumber || visiting.has(parent.prNumber)) return false;
    const parentPr = input.pullRequests.find(
      (candidate) => candidate.number === parent.prNumber,
    );
    if (parentPr === undefined) return false;
    // A targeted/scoped recovery may carry the exact parent PR relation while
    // omitting the parent's issue record. Only the visible parent's configured
    // default base is self-contained in that scoped evidence; a custom base,
    // self relation, or cycle needs the omitted issue authority and fails
    // closed instead of treating omission as permission.
    if (!knownIssues.has(parent.issueNumber)) {
      return parentPr.baseRefName === input.defaultBranch;
    }
    const parentMapping = initialByPr.get(parent.prNumber);
    if (
      parentMapping?.status !== 'resolved'
      || parentMapping.issueNumber !== parent.issueNumber
    ) {
      return false;
    }
    return parentIsCanonical(
      parent.prNumber,
      new Set([...visiting, parent.prNumber]),
    );
  };

  return initial.map((mapping): StructuredPullRequestMapping => {
    if (
      mapping.status !== 'resolved'
      || parentIsCanonical(mapping.prNumber, new Set([mapping.prNumber]))
    ) {
      return mapping;
    }
    return {
      status: 'ambiguous',
      prNumber: mapping.prNumber,
      issueNumbers: [mapping.issueNumber],
      details: [
        'Selected custom parent PR is canonically ambiguous or cyclic.',
      ],
    };
  });
}
