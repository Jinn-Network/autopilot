import { admitRelayIssue } from './admission.js';
import type { IssueRelayConfigV2 } from './config.js';
import type { RelayGitHubProductionAuthorityPort } from './github-production.js';
import type { RelayGitHubReadPort } from './github-port.js';
import { relayGeneration } from './identity.js';
import { parseRelayIssueMarkerV2 } from './markers-v2.js';
import { issueRelayPullRequestMetadataDigest } from './contracts.js';
import type {
  RelayReconciliationCandidateV2,
  RelayReconciliationPortV2,
  RelayV2ActionExecutionResult,
} from './reconciler-v2.js';
import { parseRelayIssueCommentMarker } from './report.js';
import { buildRelaySnapshot } from './snapshot.js';
import type { RelayActionV2, RelayGenerationRecordV2 } from './state-v2.js';

const sameName = (left: string, right: string): boolean =>
  left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US');

function admittedRecord(
  config: IssueRelayConfigV2,
  snapshot: ReturnType<typeof buildRelaySnapshot>,
): RelayGenerationRecordV2 {
  return {
    schemaVersion: 'jinn-issue-relay-generation.v2',
    generation: relayGeneration(snapshot),
    snapshot,
    phase: 'admitted',
    executionDeadlineAt: new Date(
      Date.parse(snapshot.capturedAt) + config.budget.generationDeadlineMs,
    ).toISOString(),
    rounds: [],
    decisions: [],
    updatedAt: snapshot.capturedAt,
  };
}

/**
 * GitHub is the only durable authority. This adapter deliberately has no
 * local-state recovery path and never reinterprets a V1 marker as V2.
 */
export function createIssueRelayV2GitHubReconciliation(input: {
  readonly config: IssueRelayConfigV2;
  readonly githubRead: RelayGitHubReadPort;
  readonly githubAuthority: RelayGitHubProductionAuthorityPort;
  readonly now: () => Date;
  readonly execute: (input: {
    readonly candidate: RelayReconciliationCandidateV2;
    readonly action: Exclude<RelayActionV2, { readonly kind: 'none' }>;
  }) => Promise<RelayV2ActionExecutionResult>;
  readonly maxSearchPages?: number;
  /** Local values are locators only; every issue is reread from GitHub. */
  readonly knownIssueNumbers?: () => Promise<readonly number[]>;
}): RelayReconciliationPortV2 {
  const maxPages = input.maxSearchPages ?? 20;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    throw new TypeError('Relay V2 GitHub search page bound is invalid');
  }

  const readCandidate = async (
    issueNumber: number,
    expectedGeneration?: string,
  ): Promise<RelayReconciliationCandidateV2 | undefined> => {
    const issue = await input.githubRead.readIssue(issueNumber);
    const [labelEvents, permission, currentBaseOid, comments] = await Promise.all([
      input.githubRead.listLabelEvents(issueNumber),
      input.githubRead.readRepositoryPermission(issue.issue.authorLogin),
      input.githubRead.readDefaultBranchHead(),
      input.githubAuthority.listIssueComments(issueNumber),
    ]);
    const owned = comments.filter(({ authorLogin }) =>
      sameName(authorLogin, input.config.relayBotLogin));
    const v1 = owned.filter(({ body, authorLogin }) =>
      parseRelayIssueCommentMarker(
        body,
        authorLogin,
        input.config.relayBotLogin,
      ) !== null);
    const v2 = owned.flatMap((comment) => {
      const record = parseRelayIssueMarkerV2(comment.body);
      return record === null ? [] : [{ ...comment, record }];
    });
    if (v1.length > 0 && v2.length === 0) return undefined;
    const lineageIsValid = v2.every(({ record }) => {
      if (record.predecessor === undefined) return true;
      const predecessor = v2.find(({ record: candidate }) =>
        candidate.generation === record.predecessor?.generation);
      return predecessor?.record.snapshot.snapshotDigest
          === record.predecessor.snapshotDigest
        && predecessor.record.supersession?.successorGeneration
          === record.generation
        && predecessor.record.supersession.successorSnapshotDigest
          === record.snapshot.snapshotDigest;
    });
    const terminal = new Set([
      'awaiting-clarification', 'refused', 'ready', 'closed', 'exhausted',
      'superseded',
    ]);
    const active = v2.filter(({ record }) => !terminal.has(record.phase));
    if (v1.length > 0 || !lineageIsValid || active.length > 1) {
      return {
        generation: `ambiguous:${issue.repository.nodeId}:${issueNumber}`,
        repository: issue.repository.slug,
        issueNumber,
        transitionedAt: issue.issue.updatedAt,
        authority: 'ambiguous',
        facts: {
          issue: {
            open: issue.issue.state === 'OPEN',
            optedIn: issue.issue.labels.some((label) =>
              sameName(label, input.config.label)),
          },
          currentBaseOid,
          now: input.now().toISOString(),
        },
      };
    }
    const pendingSuccessor = v2.filter(({ record }) =>
      record.phase === 'superseded'
      && record.supersession !== undefined
      && !v2.some(({ record: candidate }) =>
        candidate.generation === record.supersession?.successorGeneration));
    const marker = expectedGeneration === undefined
      ? active[0]
        ?? (pendingSuccessor.length === 1 ? pendingSuccessor[0] : undefined)
        ?? [...v2].sort((left, right) =>
          Date.parse(right.record.updatedAt) - Date.parse(left.record.updatedAt))[0]
      : v2.find(({ record }) => record.generation === expectedGeneration);
    if (marker !== undefined) {
      const record = marker.record;
      if (
        record.snapshot.repository.slug !== issue.repository.slug
        || record.snapshot.repository.nodeId !== issue.repository.nodeId
        || record.snapshot.issue.number !== issueNumber
      ) {
        return {
          generation: record.generation,
          repository: issue.repository.slug,
          issueNumber,
          transitionedAt: record.updatedAt,
          authority: 'ambiguous',
          facts: {
            issue: { open: false, optedIn: false },
            currentBaseOid,
            now: input.now().toISOString(),
          },
        };
      }
      const currentPr = record.pr === undefined
        ? undefined
        : await input.githubAuthority.readPullRequest(record.pr.number);
      return {
        generation: record.generation,
        repository: record.snapshot.repository.slug,
        issueNumber,
        transitionedAt: record.updatedAt,
        authority: 'github',
        facts: {
          durable: record,
          issue: {
            open: issue.issue.state === 'OPEN',
            optedIn: issue.issue.labels.some((label) =>
              sameName(label, input.config.label)),
          },
          currentBaseOid,
          ...(currentPr === undefined ? {} : {
            currentPr: {
              number: currentPr.number,
              branch: currentPr.branch,
              head: currentPr.head,
              base: currentPr.base,
              open: currentPr.open,
              draft: currentPr.draft,
              generation: currentPr.generation,
              pullRequestMetadataDigest:
                issueRelayPullRequestMetadataDigest({
                  title: currentPr.title,
                  body: currentPr.body,
                }),
            },
          }),
          now: input.now().toISOString(),
          ...(record.supersession === undefined ? {} : {
            successorPresent: v2.some(({ record: candidate }) =>
              candidate.generation === record.supersession?.successorGeneration),
          }),
        },
        production: {
          issueCommentId: marker.id,
          issueCommentBody: marker.body,
        },
      };
    }
    const admission = admitRelayIssue({
      issue,
      labelEvents,
      currentPermission: permission,
      currentBaseOid,
      policy: {
        repository: input.config.repository,
        label: input.config.label,
        maxIssueBytes: 256 * 1024,
        maxAcceptanceItems: 50,
        forbiddenRequestPatterns: [
          /\b(?:private key|seed phrase|repository secret)\b/i,
          /\b(?:deploy|release to production)\b/i,
        ],
      },
      now: input.now(),
    });
    if (admission.status !== 'admitted') return undefined;
    const proposed = admittedRecord(input.config, buildRelaySnapshot(admission.input));
    return {
      generation: proposed.generation,
      repository: proposed.snapshot.repository.slug,
      issueNumber,
      transitionedAt: proposed.updatedAt,
      authority: 'github',
      facts: {
        admission: proposed,
        issue: { open: true, optedIn: true },
        currentBaseOid,
        now: input.now().toISOString(),
      },
      production: {},
    };
  };

  return {
    async scan({ discover }) {
      const candidates = new Map<string, RelayReconciliationCandidateV2>();
      const issueNumbers = new Set(await input.knownIssueNumbers?.() ?? []);
      let cursor: string | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const result = await input.githubRead.searchOptedInIssues({
          repository: input.config.repository,
          label: input.config.label,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const issue of result.issues) {
          issueNumbers.add(issue.issue.number);
        }
        if (result.nextCursor === undefined) break;
        cursor = result.nextCursor;
        if (page === maxPages - 1) {
          throw new Error('Relay V2 GitHub discovery exceeded its page bound');
        }
      }
      for (const issueNumber of issueNumbers) {
        if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
          throw new TypeError('Relay V2 recovery issue locator is invalid');
        }
        const candidate = await readCandidate(issueNumber);
        if (
          candidate !== undefined
          && (discover || candidate.facts.durable !== undefined)
        ) {
          candidates.set(`${candidate.repository}#${candidate.issueNumber}`, candidate);
        }
      }
      return [...candidates.values()];
    },
    async reread(candidate) {
      const current = await readCandidate(candidate.issueNumber, candidate.generation);
      if (current === undefined || current.generation !== candidate.generation) {
        throw new Error('Relay V2 GitHub authority changed on reread');
      }
      return current;
    },
    execute: input.execute,
  };
}
