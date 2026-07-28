import type {
  RelayAdmissionDecision,
  RelayAdmissionPolicy,
  RelayIssueCandidateFacts,
  RelayLabelEvent,
} from './github-port.js';

type RepositoryPermission =
  | 'NONE'
  | 'READ'
  | 'TRIAGE'
  | 'WRITE'
  | 'MAINTAIN'
  | 'ADMIN';

const MAINTAINER_PERMISSIONS: ReadonlySet<RepositoryPermission> = new Set([
  'WRITE',
  'MAINTAIN',
  'ADMIN',
]);

type MaintainerPermission = 'WRITE' | 'MAINTAIN' | 'ADMIN';

function isMaintainerPermission(
  permission: RepositoryPermission,
): permission is MaintainerPermission {
  return MAINTAINER_PERMISSIONS.has(permission);
}

function sameGitHubName(left: string, right: string): boolean {
  return left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US');
}

function canonicalUtcTimestamp(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    return undefined;
  }
  return timestamp;
}

function validateAdmissionPolicy(policy: RelayAdmissionPolicy): void {
  if (
    policy.repository !== 'Jinn-Network/mono'
    || policy.label !== 'engine:marketplace'
    || !Number.isSafeInteger(policy.maxIssueBytes)
    || policy.maxIssueBytes <= 0
    || !Number.isSafeInteger(policy.maxAcceptanceItems)
    || policy.maxAcceptanceItems <= 0
    || !Array.isArray(policy.forbiddenRequestPatterns)
    || !policy.forbiddenRequestPatterns.every((pattern) => pattern instanceof RegExp)
  ) {
    throw new TypeError('Invalid Relay admission policy');
  }
}

function refusal(
  code: Extract<RelayAdmissionDecision, { status: 'refused' }>['code'],
  message: string,
): RelayAdmissionDecision {
  return { status: 'refused', code, message };
}

function relevantEffectiveLabelEvent(input: {
  readonly events: readonly RelayLabelEvent[];
  readonly label: string;
  readonly nowMs: number;
}): RelayLabelEvent | undefined {
  const relevant = input.events
    .filter((event) => sameGitHubName(event.label, input.label))
    .map((event) => ({ event, timestamp: canonicalUtcTimestamp(event.createdAt) }));

  if (
    relevant.length === 0
    || relevant.some(({ timestamp }) => timestamp === undefined || timestamp > input.nowMs)
  ) {
    return undefined;
  }

  const latestTimestamp = Math.max(...relevant.map(({ timestamp }) => timestamp!));
  const latest = relevant.filter(({ timestamp }) => timestamp === latestTimestamp);

  if (latest.length !== 1 || latest[0]!.event.action !== 'labeled') {
    return undefined;
  }

  return latest[0]!.event;
}

function stripBoundedItem(line: string): string | undefined {
  const item = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+?)\s*$/)?.[1]?.trim();
  return item === undefined || item.length === 0 ? undefined : item;
}

function markdownColumnWidth(value: string): number {
  let column = 0;
  for (const character of value) {
    column = character === '\t'
      ? column + (4 - (column % 4))
      : column + 1;
  }
  return column;
}

function markdownListContentIndent(line: string): number | undefined {
  const marker = line.match(
    /^([ \t]*)([-*+]|\d{1,9}[.)])((?: {1,4}|\t))(?=\S)/,
  );
  return marker === null
    ? undefined
    : markdownColumnWidth(`${marker[1]}${marker[2]}${marker[3]}`);
}

function acceptanceEvidence(body: string): readonly string[] {
  const evidence: string[] = [];
  let recognizedSectionDepth: number | undefined;
  let fence: { readonly character: string; readonly length: number } | undefined;
  let inHtmlComment = false;
  let listContentIndent: number | undefined;
  let pendingPlainLine:
    | { readonly text: string; readonly inRecognizedSection: boolean }
    | undefined;

  const flushPendingPlainLine = (): void => {
    if (pendingPlainLine?.inRecognizedSection === true) {
      evidence.push(
        stripBoundedItem(pendingPlainLine.text) ?? pendingPlainLine.text.trim(),
      );
    }
    pendingPlainLine = undefined;
  };

  for (const rawLine of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence !== undefined) {
      const closingMarker = rawLine.match(/^\s{0,3}(`+|~+)\s*$/)?.[1];
      if (
        closingMarker !== undefined
        && closingMarker[0] === fence.character
        && closingMarker.length >= fence.length
      ) {
        fence = undefined;
      }
      continue;
    }

    let line = '';
    let cursor = 0;
    while (cursor < rawLine.length) {
      if (inHtmlComment) {
        const commentEnd = rawLine.indexOf('-->', cursor);
        if (commentEnd === -1) {
          cursor = rawLine.length;
        } else {
          inHtmlComment = false;
          cursor = commentEnd + 3;
        }
        continue;
      }

      const commentStart = rawLine.indexOf('<!--', cursor);
      if (commentStart === -1) {
        line += rawLine.slice(cursor);
        break;
      }
      line += rawLine.slice(cursor, commentStart);
      inHtmlComment = true;
      cursor = commentStart + 4;
    }

    const nestedTaskIndent = line.match(
      /^([ \t]+)[-*+]\s+\[[ xX]\]\s+/,
    )?.[1];
    const nestedTaskIndentColumns = nestedTaskIndent === undefined
      ? undefined
      : markdownColumnWidth(nestedTaskIndent);
    const nestedTaskListItem = listContentIndent !== undefined
      && nestedTaskIndentColumns !== undefined
      && nestedTaskIndentColumns >= listContentIndent
      && nestedTaskIndentColumns < listContentIndent + 4;
    if (/^(?: {4}|\t)/.test(line) && !nestedTaskListItem) {
      flushPendingPlainLine();
      continue;
    }

    const openingMarker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
    if (openingMarker !== undefined) {
      flushPendingPlainLine();
      fence = {
        character: openingMarker[0]!,
        length: openingMarker.length,
      };
      listContentIndent = undefined;
      continue;
    }

    const setextUnderline = line.match(/^\s{0,3}(=+|-+)\s*$/)?.[1];
    if (setextUnderline !== undefined && pendingPlainLine !== undefined) {
      const headingDepth = setextUnderline[0] === '=' ? 1 : 2;
      if (/\b(?:acceptance|expected|done when)\b/i.test(pendingPlainLine.text)) {
        recognizedSectionDepth = headingDepth;
      } else if (
        recognizedSectionDepth !== undefined
        && headingDepth <= recognizedSectionDepth
      ) {
        recognizedSectionDepth = undefined;
      }
      pendingPlainLine = undefined;
      listContentIndent = undefined;
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading !== null) {
      flushPendingPlainLine();
      const headingDepth = line.trimStart().match(/^#+/)![0].length;
      if (/\b(?:acceptance|expected|done when)\b/i.test(heading[1]!)) {
        recognizedSectionDepth = headingDepth;
      } else if (
        recognizedSectionDepth !== undefined
        && headingDepth <= recognizedSectionDepth
      ) {
        recognizedSectionDepth = undefined;
      }
      listContentIndent = undefined;
      continue;
    }

    const checklist = line.match(/^\s*[-*+]\s+\[[ xX]\]\s+(.+?)\s*$/)?.[1]?.trim();
    if (checklist !== undefined && checklist.length > 0) {
      flushPendingPlainLine();
      evidence.push(checklist);
      listContentIndent = markdownListContentIndent(line);
      continue;
    }

    if (line.trim().length === 0) {
      flushPendingPlainLine();
      continue;
    }

    flushPendingPlainLine();
    pendingPlainLine = {
      text: line,
      inRecognizedSection: recognizedSectionDepth !== undefined,
    };
    listContentIndent = markdownListContentIndent(line);
  }

  flushPendingPlainLine();
  return evidence;
}

function matchesForbiddenPattern(
  patterns: readonly RegExp[],
  request: string,
): boolean {
  return patterns.some((pattern) => new RegExp(pattern.source, pattern.flags).test(request));
}

export function admitRelayIssue(input: {
  readonly issue: RelayIssueCandidateFacts;
  readonly labelEvents: readonly RelayLabelEvent[];
  readonly currentPermission: RepositoryPermission;
  readonly currentBaseOid: string;
  readonly policy: RelayAdmissionPolicy;
  readonly now: Date;
}): RelayAdmissionDecision {
  validateAdmissionPolicy(input.policy);

  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs)) {
    return refusal('unsupported-capability', 'Admission requires a valid capture time.');
  }
  const issueUpdatedAt = canonicalUtcTimestamp(input.issue.issue.updatedAt);
  if (issueUpdatedAt === undefined || issueUpdatedAt > nowMs) {
    return refusal(
      'unsupported-capability',
      'Issue facts require a canonical UTC update timestamp.',
    );
  }

  if (input.issue.repository.visibility !== 'PUBLIC') {
    return refusal('not-public', 'Issue Relay only accepts public repository demand.');
  }
  if (input.issue.issue.isPullRequest) {
    return refusal('not-issue', 'Pull requests are not Issue Relay demand.');
  }
  if (input.issue.issue.state !== 'OPEN') {
    return refusal('not-open', 'Issue Relay demand must remain open.');
  }
  if (!sameGitHubName(input.issue.repository.slug, input.policy.repository)) {
    return refusal(
      'unsupported-capability',
      'The issue is outside the source-level Relay repository.',
    );
  }

  const issueBytes = Buffer.byteLength(input.issue.issue.title, 'utf8')
    + Buffer.byteLength(input.issue.issue.body, 'utf8');
  if (issueBytes > input.policy.maxIssueBytes) {
    return refusal('oversized', 'The issue exceeds the configured UTF-8 byte limit.');
  }

  const request = `${input.issue.issue.title}\n${input.issue.issue.body}`;
  if (matchesForbiddenPattern(input.policy.forbiddenRequestPatterns, request)) {
    return refusal('requires-secrets', 'The request requires forbidden secret access.');
  }

  if (!isMaintainerPermission(input.currentPermission)) {
    return refusal(
      'not-maintainer-authored',
      'The issue author does not currently have repository write authority.',
    );
  }

  const issueHasLabel = input.issue.issue.labels.some(
    (label) => sameGitHubName(label, input.policy.label),
  );
  const effectiveLabelEvent = relevantEffectiveLabelEvent({
    events: input.labelEvents,
    label: input.policy.label,
    nowMs,
  });
  if (
    !issueHasLabel
    || effectiveLabelEvent === undefined
    || effectiveLabelEvent.actorId !== input.issue.issue.authorId
    || !sameGitHubName(effectiveLabelEvent.actorLogin, input.issue.issue.authorLogin)
  ) {
    return refusal(
      'not-self-labelled',
      'The issue author did not apply the currently effective opt-in label.',
    );
  }

  const evidence = acceptanceEvidence(input.issue.issue.body);
  if (evidence.length === 0) {
    return {
      status: 'awaiting-clarification',
      code: 'missing-acceptance-evidence',
      message: 'Add at least one explicit, bounded acceptance item.',
    };
  }
  if (evidence.length > input.policy.maxAcceptanceItems) {
    return {
      status: 'awaiting-clarification',
      code: 'ambiguous-scope',
      message: 'The issue contains more acceptance items than the configured scope bound.',
    };
  }

  return {
    status: 'admitted',
    input: {
      repository: {
        slug: input.issue.repository.slug,
        nodeId: input.issue.repository.nodeId,
        visibility: 'PUBLIC',
        defaultBranch: input.issue.repository.defaultBranch,
        baseOid: input.currentBaseOid,
      },
      issue: {
        number: input.issue.issue.number,
        url: input.issue.issue.url,
        title: input.issue.issue.title,
        body: input.issue.issue.body,
        authorLogin: input.issue.issue.authorLogin,
        authorId: input.issue.issue.authorId,
        updatedAt: input.issue.issue.updatedAt,
      },
      optIn: {
        label: input.policy.label,
        actorLogin: effectiveLabelEvent.actorLogin,
        createdAt: effectiveLabelEvent.createdAt,
        permission: input.currentPermission,
      },
      language: 'typescript',
      verificationProfile: 'jinn-mono.v1',
      acceptanceEvidence: evidence,
      admissionPolicyVersion: 'jinn-issue-relay-admission.v1',
      capturedAt: input.now.toISOString(),
    },
  };
}
