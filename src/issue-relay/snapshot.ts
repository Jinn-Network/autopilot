import { createHash } from 'node:crypto';

export interface RelayIssueInput {
  readonly repository: {
    readonly slug: string;
    readonly nodeId: string;
    readonly visibility: 'PUBLIC';
    readonly defaultBranch: string;
    readonly baseOid: string;
  };
  readonly issue: {
    readonly number: number;
    readonly url: string;
    readonly title: string;
    readonly body: string;
    readonly authorLogin: string;
    readonly authorId: string;
    readonly updatedAt: string;
  };
  readonly optIn: {
    readonly label: 'engine:marketplace';
    readonly actorLogin: string;
    readonly createdAt: string;
    readonly permission: 'WRITE' | 'MAINTAIN' | 'ADMIN';
  };
  readonly language: 'typescript';
  readonly verificationProfile: 'jinn-mono.v1';
  readonly acceptanceEvidence: readonly string[];
  readonly admissionPolicyVersion: 'jinn-issue-relay-admission.v1';
  readonly capturedAt: string;
}

export interface IssueRelaySnapshotV1 extends RelayIssueInput {
  readonly schemaVersion: 'jinn-issue-relay-snapshot.v1';
  readonly snapshotDigest: `sha256:${string}`;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function canonicalRelayInput(input: RelayIssueInput): RelayIssueInput {
  return {
    repository: {
      slug: normalizeLineEndings(input.repository.slug),
      nodeId: normalizeLineEndings(input.repository.nodeId),
      visibility: input.repository.visibility,
      defaultBranch: normalizeLineEndings(input.repository.defaultBranch),
      baseOid: normalizeLineEndings(input.repository.baseOid),
    },
    issue: {
      number: input.issue.number,
      url: normalizeLineEndings(input.issue.url),
      title: normalizeLineEndings(input.issue.title),
      body: normalizeLineEndings(input.issue.body),
      authorLogin: normalizeLineEndings(input.issue.authorLogin),
      authorId: normalizeLineEndings(input.issue.authorId),
      updatedAt: normalizeLineEndings(input.issue.updatedAt),
    },
    optIn: {
      label: input.optIn.label,
      actorLogin: normalizeLineEndings(input.optIn.actorLogin),
      createdAt: normalizeLineEndings(input.optIn.createdAt),
      permission: input.optIn.permission,
    },
    language: input.language,
    verificationProfile: input.verificationProfile,
    acceptanceEvidence: input.acceptanceEvidence.map(normalizeLineEndings),
    admissionPolicyVersion: input.admissionPolicyVersion,
    capturedAt: normalizeLineEndings(input.capturedAt),
  };
}

export function canonicalRelaySnapshotBytes(input: RelayIssueInput): Buffer {
  return Buffer.from(JSON.stringify(canonicalRelayInput(input)), 'utf8');
}

export function buildRelaySnapshot(input: RelayIssueInput): IssueRelaySnapshotV1 {
  const canonical = canonicalRelayInput(input);
  const snapshotDigest = `sha256:${createHash('sha256')
    .update(canonicalRelaySnapshotBytes(input))
    .digest('hex')}` as const;

  return {
    ...canonical,
    schemaVersion: 'jinn-issue-relay-snapshot.v1',
    snapshotDigest,
  };
}
