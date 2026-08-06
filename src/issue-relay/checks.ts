import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  IssueRelayAdoptionReceiptV1Schema,
  IssueRelayEvaluationAnchorV1Schema,
  type IssueRelayFindingV1,
  type IssueRelayEvaluationAnchorV1,
} from './contracts.js';
import {
  ISSUE_RELAY_MAX_FINDING_BODY_BYTES,
  ISSUE_RELAY_MAX_FINDINGS,
} from './limits.js';
import type { AcceptedRelayAdoption } from './adoption.js';
import {
  findRelayAdoptionReceiptBlock,
  type RelayPullRequest,
  type RelayRepositoryAuthority,
} from './git-publisher.js';

const OID = /^[0-9a-f]{40}$/;
const ASSURANCE_MARKER = '<!-- jinn-issue-relay:assurance:v1 -->';
const EVALUATION_ANCHOR_MARKER =
  '<!-- jinn-issue-relay:evaluation-anchor:v1 -->';

export interface RelayCheck {
  readonly kind: 'check-run' | 'status-context' | 'any';
  readonly name: string;
  /** GitHub App id for the producer, when the check came from an App. */
  readonly appId?: number;
  readonly status: 'passed' | 'failed' | 'pending';
  readonly url?: string;
}

export interface RelayCheckSummary {
  readonly head: string;
  readonly required: readonly RelayCheck[];
  readonly optional: readonly RelayCheck[];
  readonly digest: `sha256:${string}`;
}

function boundedFailureName(name: string): string {
  const maximumNameBytes = ISSUE_RELAY_MAX_FINDING_BODY_BYTES - 256;
  const encoded = new TextEncoder().encode(name);
  if (encoded.byteLength <= maximumNameBytes) return name;
  return `${new TextDecoder().decode(encoded.slice(0, maximumNameBytes - 3))}...`;
}

export function relayFailedCheckFindings(
  summary: RelayCheckSummary,
): readonly IssueRelayFindingV1[] {
  verifyRelayCheckSummary(summary);
  const failed = summary.required.filter(({ status }) => status === 'failed');
  if (failed.length === 0) {
    throw new Error('Relay check repair requires a failed required check');
  }
  const direct = failed.slice(
    0,
    failed.length > ISSUE_RELAY_MAX_FINDINGS
      ? ISSUE_RELAY_MAX_FINDINGS - 1
      : ISSUE_RELAY_MAX_FINDINGS,
  );
  const findings: IssueRelayFindingV1[] = direct.map((check, index) => ({
    code: `required-check-failed-${index + 1}`,
    title: 'Required repository check failed',
    detail:
      `Required check "${boundedFailureName(check.name)}" failed on exact head `
      + `${summary.head}. Repair the underlying regression and make this check pass.`,
  }));
  if (failed.length > direct.length) {
    findings.push({
      code: 'required-check-failure-overflow',
      title: 'Additional required repository checks failed',
      detail:
        `${failed.length - direct.length} additional required checks failed on `
        + `exact head ${summary.head}. Repair the remaining required checks.`,
    });
  }
  return findings;
}

type RelayCheckRunConclusion =
  | 'action_required'
  | 'cancelled'
  | 'failure'
  | 'neutral'
  | 'skipped'
  | 'stale'
  | 'startup_failure'
  | 'success'
  | 'timed_out';

export type RelayGitHubCheckFact =
  | {
      readonly kind: 'check-run';
      readonly name: string;
      readonly appId: number;
      readonly head: string;
      readonly status:
        | 'queued'
        | 'in_progress'
        | 'completed'
        | 'waiting'
        | 'requested'
        | 'pending';
      readonly conclusion: RelayCheckRunConclusion | null;
      readonly url?: string;
    }
  | {
      readonly kind: 'status-context';
      readonly name: string;
      readonly head: string;
      readonly state: 'error' | 'failure' | 'pending' | 'success';
      readonly url?: string;
    };

export interface RelayCheckProfile {
  readonly name: 'jinn-mono.v1';
  readonly requiredChecks: readonly string[];
}

export interface RelayBranchRequiredCheck {
  readonly name: string;
  /** `null` and GitHub's `-1` sentinel both mean any producer App. */
  readonly appId: number | null;
}

function canonicalJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function order(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function checkOrder(left: RelayCheck, right: RelayCheck): number {
  const kindRank = {
    'check-run': 0,
    'status-context': 1,
    any: 2,
  } as const;
  return order(left.name, right.name)
    || kindRank[left.kind] - kindRank[right.kind]
    || (left.appId ?? -1) - (right.appId ?? -1);
}

function validName(name: unknown, label: string): asserts name is string {
  if (
    typeof name !== 'string'
    || name.length === 0
    || name.trim() !== name
    || /[\u0000\r\n]/.test(name)
  ) {
    throw new Error(`${label} is incomplete or unsafe`);
  }
}

function validUrl(url: unknown, label: string): asserts url is string | undefined {
  if (
    url !== undefined
    && (
      typeof url !== 'string'
      || url.length === 0
      || /[\u0000\r\n]/.test(url)
    )
  ) {
    throw new Error(`${label} URL is incomplete or unsafe`);
  }
}

function branchRequirementAppId(
  appId: unknown,
  label: string,
): number | undefined {
  if (appId === null || appId === -1) return undefined;
  if (!Number.isSafeInteger(appId) || (appId as number) <= 0) {
    throw new Error(`${label} App id is invalid`);
  }
  return appId as number;
}

function observedAppId(appId: unknown, label: string): number {
  if (!Number.isSafeInteger(appId) || (appId as number) <= 0) {
    throw new Error(`${label} App id is incomplete or invalid`);
  }
  return appId as number;
}

function normalizeCheck(fact: RelayGitHubCheckFact, head: string): RelayCheck {
  validName(fact.name, 'GitHub check name');
  validUrl(fact.url, `GitHub check ${fact.name}`);
  if (!OID.test(fact.head) || fact.head !== head) {
    throw new Error(`GitHub check ${fact.name} is tied to a stale head`);
  }
  if (fact.kind === 'status-context') {
    switch (fact.state) {
      case 'success':
        return { kind: fact.kind, name: fact.name, status: 'passed', ...(fact.url === undefined ? {} : { url: fact.url }) };
      case 'failure':
      case 'error':
        return { kind: fact.kind, name: fact.name, status: 'failed', ...(fact.url === undefined ? {} : { url: fact.url }) };
      case 'pending':
        return { kind: fact.kind, name: fact.name, status: 'pending', ...(fact.url === undefined ? {} : { url: fact.url }) };
      default:
        throw new Error(`GitHub status context ${fact.name} has an incomplete state`);
    }
  }
  if (fact.kind !== 'check-run') {
    throw new Error('GitHub check has an invalid kind');
  }
  const appId = observedAppId(fact.appId, `GitHub check ${fact.name}`);
  if (![
    'queued',
    'in_progress',
    'completed',
    'waiting',
    'requested',
    'pending',
  ].includes(fact.status)) {
    throw new Error(`GitHub check ${fact.name} has an invalid status`);
  }
  if (fact.status !== 'completed') {
    if (fact.conclusion !== null) {
      throw new Error(`GitHub check ${fact.name} has a conclusion before completion`);
    }
    return {
      kind: fact.kind,
      name: fact.name,
      appId,
      status: 'pending',
      ...(fact.url === undefined ? {} : { url: fact.url }),
    };
  }
  if (fact.conclusion === null) {
    throw new Error(`GitHub check ${fact.name} is completed without a conclusion`);
  }
  if (![
    'action_required',
    'cancelled',
    'failure',
    'neutral',
    'skipped',
    'stale',
    'startup_failure',
    'success',
    'timed_out',
  ].includes(fact.conclusion)) {
    throw new Error(`GitHub check ${fact.name} has an invalid conclusion`);
  }
  const status = fact.conclusion === 'success'
    || fact.conclusion === 'neutral'
    || fact.conclusion === 'skipped'
    ? 'passed'
    : 'failed';
  return {
    kind: fact.kind,
    name: fact.name,
    appId,
    status,
    ...(fact.url === undefined ? {} : { url: fact.url }),
  };
}

function canonicalSummary(input: Omit<RelayCheckSummary, 'digest'>) {
  return {
    schemaVersion: 'jinn-issue-relay-checks.v1',
    head: input.head,
    required: input.required,
    optional: input.optional,
  };
}

export function aggregateRelayChecks(input: {
  readonly head: string;
  readonly branchRequiredChecks: readonly RelayBranchRequiredCheck[];
  readonly profile: RelayCheckProfile;
  readonly checks: readonly RelayGitHubCheckFact[];
}): RelayCheckSummary {
  if (!OID.test(input.head)) throw new Error('Relay check head is invalid');
  if (input.profile.name !== 'jinn-mono.v1') {
    throw new Error('Relay check profile is unsupported');
  }
  const requirements: Array<{
    readonly kind: 'check-run' | 'any';
    readonly name: string;
    readonly appId?: number;
  }> = [];
  const requirementKeys = new Set<string>();
  const branchRequirementNames = new Set<string>();
  const addRequirement = (
    requirement: {
      readonly kind: 'check-run' | 'any';
      readonly name: string;
      readonly appId?: number;
    },
  ) => {
    const key =
      `${requirement.kind}\u0000${requirement.name}\u0000${requirement.appId ?? '*'}`;
    if (requirementKeys.has(key)) {
      throw new Error(`Relay contains a duplicate required check requirement ${requirement.name}`);
    }
    requirementKeys.add(key);
    requirements.push(requirement);
  };
  for (const requirement of input.branchRequiredChecks) {
    const name = requirement.name;
    validName(name, 'Branch-required check');
    branchRequirementNames.add(name);
    const appId = branchRequirementAppId(
      requirement.appId,
      `Branch-required check ${name}`,
    );
    addRequirement({
      kind: appId === undefined ? 'any' : 'check-run',
      name,
      ...(appId === undefined ? {} : { appId }),
    });
  }
  const profileRequirementNames = new Set<string>();
  for (const name of input.profile.requiredChecks) {
    validName(name, 'Profile-required check');
    if (profileRequirementNames.has(name)) {
      throw new Error(`Relay contains a duplicate required check requirement ${name}`);
    }
    profileRequirementNames.add(name);
    if (branchRequirementNames.has(name)) continue;
    addRequirement({ kind: 'any', name });
  }

  const observed = new Map<string, RelayCheck>();
  for (const fact of input.checks) {
    const check = normalizeCheck(fact, input.head);
    const key =
      `${check.kind}\u0000${check.name}\u0000${check.appId ?? '*'}`;
    if (observed.has(key)) {
      throw new Error(`GitHub check facts contain duplicate identity ${check.name}`);
    }
    observed.set(key, check);
  }

  const required: RelayCheck[] = [];
  const optional: RelayCheck[] = [];
  if (observed.size > 0) {
    const consumed = new Set<string>();
    const candidates = [...observed.entries()];
    const statusRank = { passed: 0, pending: 1, failed: 2 } as const;
    const orderedRequirements = [...requirements].sort((left, right) =>
      (left.kind === right.kind ? 0 : left.kind === 'check-run' ? -1 : 1)
      || order(left.name, right.name)
      || (left.appId ?? -1) - (right.appId ?? -1));
    for (const requirement of orderedRequirements) {
      const exactKey = requirement.kind === 'check-run'
        ? `check-run\u0000${requirement.name}\u0000${requirement.appId}`
        : undefined;
      const match = exactKey === undefined
        ? candidates
          .filter(([key, check]) =>
            !consumed.has(key) && check.name === requirement.name)
          .sort((left, right) =>
            statusRank[left[1].status] - statusRank[right[1].status]
            || checkOrder(left[1], right[1]))[0]
        : candidates.find(([key]) => key === exactKey && !consumed.has(key));
      if (match !== undefined) {
        const [key, check] = match;
        required.push(check);
        consumed.add(key);
      } else {
        required.push({
          kind: requirement.kind,
          name: requirement.name,
          ...(requirement.appId === undefined
            ? {}
            : { appId: requirement.appId }),
          status: 'pending',
        });
      }
    }
    for (const [key, check] of observed) {
      if (!consumed.has(key)) optional.push(check);
    }
  }
  required.sort(checkOrder);
  optional.sort(checkOrder);
  const summary = { head: input.head, required, optional };
  return { ...summary, digest: sha256(canonicalSummary(summary)) };
}

export function verifyRelayCheckSummary(summary: RelayCheckSummary): void {
  if (!OID.test(summary.head)) throw new Error('Relay check summary head is invalid');
  const names = new Set<string>();
  for (const [label, checks] of [
    ['required', summary.required],
    ['optional', summary.optional],
  ] as const) {
    let prior: RelayCheck | undefined;
    for (const check of checks) {
      validName(check.name, `Relay ${label} check name`);
      validUrl(check.url, `Relay ${label} check ${check.name}`);
      if (!['passed', 'failed', 'pending'].includes(check.status)) {
        throw new Error(`Relay ${label} check has an invalid status`);
      }
      if (!['check-run', 'status-context', 'any'].includes(check.kind)) {
        throw new Error(`Relay ${label} check has an invalid kind`);
      }
      if (check.kind === 'check-run') {
        observedAppId(check.appId, `Relay ${label} check ${check.name}`);
      } else if (check.appId !== undefined) {
        throw new Error(`Relay ${label} check ${check.name} has a contradictory App id`);
      }
      if (
        check.kind === 'any'
        && (label !== 'required' || check.status !== 'pending' || check.url !== undefined)
      ) {
        throw new Error(`Relay ${label} wildcard check ${check.name} is contradictory`);
      }
      const key =
        `${check.kind}\u0000${check.name}\u0000${check.appId ?? '*'}`;
      if (names.has(key)) throw new Error(`Relay check summary duplicates ${check.name}`);
      names.add(key);
      if (prior !== undefined && checkOrder(prior, check) >= 0) {
        throw new Error(`Relay ${label} checks are not canonically ordered`);
      }
      prior = check;
    }
  }
  const expected = sha256(canonicalSummary({
    head: summary.head,
    required: summary.required,
    optional: summary.optional,
  }));
  if (summary.digest !== expected) {
    throw new Error('Relay check summary digest does not match its canonical facts');
  }
}

export function relayRequiredCheckStatus(
  summary: RelayCheckSummary,
): 'passed' | 'failed' | 'pending' {
  verifyRelayCheckSummary(summary);
  if (summary.required.some(({ status }) => status === 'failed')) return 'failed';
  if (summary.required.some(({ status }) => status === 'pending')) return 'pending';
  return 'passed';
}

export function relayAdoptionReceiptDigest(
  adoption: AcceptedRelayAdoption,
): `sha256:${string}` {
  const receipt = IssueRelayAdoptionReceiptV1Schema.parse(adoption.receipt);
  if (receipt.disposition !== 'accepted') {
    throw new Error('Relay evaluation requires an accepted adoption receipt');
  }
  return sha256(receipt);
}

export function formatRelayEvaluationAnchorBlock(
  anchor: IssueRelayEvaluationAnchorV1,
): string {
  const canonical = IssueRelayEvaluationAnchorV1Schema.parse(anchor);
  return `${EVALUATION_ANCHOR_MARKER}\n\n\`\`\`json\n${JSON.stringify(canonical)}\n\`\`\``;
}

export function parseRelayEvaluationAnchorBlock(
  body: string,
): IssueRelayEvaluationAnchorV1 | null {
  const anchors = parseRelayEvaluationAnchorBlocks(body);
  if (anchors.length === 0) return null;
  if (anchors.length !== 1) {
    throw new Error('Relay assurance comment contains multiple evaluation anchors');
  }
  return anchors[0]!;
}

export function parseRelayEvaluationAnchorBlocks(
  body: string,
): readonly IssueRelayEvaluationAnchorV1[] {
  const anchors: IssueRelayEvaluationAnchorV1[] = [];
  const correlations = new Set<string>();
  let cursor = 0;
  while (true) {
    const marker = body.indexOf(EVALUATION_ANCHOR_MARKER, cursor);
    if (marker === -1) return anchors;
    const match =
      /^<!-- jinn-issue-relay:evaluation-anchor:v1 -->\n\n```json\n([^\r\n]+)\n```(?:\n|$)/
        .exec(body.slice(marker));
    if (match?.[1] === undefined) {
      throw new Error('Relay evaluation anchor marker is malformed');
    }
    try {
      const parsed = IssueRelayEvaluationAnchorV1Schema.parse(
        JSON.parse(match[1]) as unknown,
      ) as IssueRelayEvaluationAnchorV1;
      if (JSON.stringify(parsed) !== match[1]) {
        throw new Error('noncanonical anchor JSON');
      }
      const key = JSON.stringify(parsed.correlation);
      if (correlations.has(key)) {
        throw new Error(
          'Relay assurance comment duplicates an evaluation anchor correlation',
        );
      }
      correlations.add(key);
      anchors.push(parsed);
    } catch (error) {
      throw new Error('Relay evaluation anchor is not canonical', {
        cause: error,
      });
    }
    cursor = marker + match[0].length;
  }
}

export function findRelayEvaluationAnchorBlock(
  body: string,
  correlation: IssueRelayEvaluationAnchorV1['correlation'],
): IssueRelayEvaluationAnchorV1 | null {
  return parseRelayEvaluationAnchorBlocks(body).find((anchor) =>
    isDeepStrictEqual(anchor.correlation, correlation)) ?? null;
}

export interface RelayEvaluationAnchorComment {
  readonly id: number;
  readonly authorLogin: string;
  readonly body: string;
}

export interface RelayEvaluationAnchorPort {
  readPullRequest(input: RelayRepositoryAuthority & {
    readonly repository: string;
    readonly prNumber: number;
  }): Promise<RelayPullRequest>;
  listAssuranceComments(input: RelayRepositoryAuthority & {
    readonly repository: string;
    readonly prNumber: number;
  }): Promise<readonly RelayEvaluationAnchorComment[]>;
  editAssuranceComment(input: RelayRepositoryAuthority & {
    readonly repository: string;
    readonly prNumber: number;
    readonly commentId: number;
    readonly expectedHead: string;
    readonly body: string;
  }): Promise<void>;
}

function sameLogin(left: string, right: string): boolean {
  return left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US');
}

function exactPr(left: RelayPullRequest, right: RelayPullRequest): boolean {
  return isDeepStrictEqual(left, right);
}

function anchorBindings(
  anchor: IssueRelayEvaluationAnchorV1,
  input: {
    readonly pr: RelayPullRequest;
    readonly currentBaseOid: string;
    readonly adoption: AcceptedRelayAdoption;
    readonly checks: RelayCheckSummary;
  },
): boolean {
  return isDeepStrictEqual(anchor.correlation, input.adoption.receipt.correlation)
    && anchor.targetRepository === input.adoption.receipt.targetRepository
    && anchor.workspaceRepository === input.adoption.receipt.workspaceRepository
    && anchor.prNumber === input.pr.number
    && anchor.targetBase === input.pr.base
    && anchor.baseOid === input.currentBaseOid
    && anchor.headRef === input.pr.branch
    && anchor.evaluatedHead === input.pr.head
    && anchor.adoptionReceiptDigest
      === relayAdoptionReceiptDigest(input.adoption)
    && anchor.checksDigest === input.checks.digest;
}

export function createRelayEvaluationAnchorPublisher(options: {
  readonly port: RelayEvaluationAnchorPort;
  readonly now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());

  return {
    async publish(input: {
      readonly authority: RelayRepositoryAuthority;
      readonly targetRepository: string;
      readonly targetBase: string;
      readonly serviceLogin: string;
      readonly pr: RelayPullRequest;
      readonly currentBaseOid: string;
      readonly adoption: AcceptedRelayAdoption;
      readonly checks: RelayCheckSummary;
    }): Promise<IssueRelayEvaluationAnchorV1> {
      const authority = input.authority;
      if (!OID.test(input.currentBaseOid)) {
        throw new Error('Relay current base OID is invalid');
      }
      validName(input.targetBase, 'Relay target base');
      verifyRelayCheckSummary(input.checks);
      if (relayRequiredCheckStatus(input.checks) !== 'passed') {
        throw new Error('Relay required checks have not all passed');
      }
      const receipt = IssueRelayAdoptionReceiptV1Schema.parse(
        input.adoption.receipt,
      ) as AcceptedRelayAdoption['receipt'];
      if (
        receipt.disposition !== 'accepted'
        || input.adoption.status !== 'accepted'
        || input.adoption.resultingHead !== receipt.resultingHead
        || input.adoption.prNumber !== receipt.prNumber
        || input.adoption.branch !== receipt.headRef
        || input.targetRepository !== receipt.targetRepository
        || input.pr.number !== receipt.prNumber
        || input.pr.base !== input.targetBase
        || input.pr.branch !== receipt.headRef
        || input.pr.head !== receipt.resultingHead
        || input.pr.generation !== receipt.correlation.generation
        || input.checks.head !== receipt.resultingHead
        || input.pr.base.length === 0
        || !input.pr.open
        || !input.pr.draft
        || input.pr.targetRepositoryId !== authority.targetRepositoryId
        || input.pr.forkRepositoryId !== authority.forkRepositoryId
        || input.pr.forkParentRepositoryId !== authority.forkParentRepositoryId
      ) {
        throw new Error(
          'Relay repository, adoption, checks, and draft PR head do not agree',
        );
      }
      const readInput = {
        ...authority,
        repository: input.targetRepository,
        prNumber: input.pr.number,
      };
      const before = await options.port.readPullRequest(readInput);
      if (!exactPr(before, input.pr)) {
        throw new Error('Relay draft PR changed before evaluation anchoring');
      }
      const owned = (await options.port.listAssuranceComments(readInput))
        .filter((comment) =>
          sameLogin(comment.authorLogin, input.serviceLogin)
          && comment.body.includes(ASSURANCE_MARKER)
        );
      if (owned.length !== 1 || owned[0] === undefined) {
        throw new Error('Relay does not own exactly one PR assurance marker');
      }
      const comment = owned[0];
      if (!isDeepStrictEqual(
        findRelayAdoptionReceiptBlock(comment.body, receipt.correlation),
        receipt,
      )) {
        throw new Error('Relay assurance marker adoption receipt is contradictory');
      }
      const existing = findRelayEvaluationAnchorBlock(
        comment.body,
        receipt.correlation,
      );
      if (existing !== null) {
        if (!anchorBindings(existing, input)) {
          throw new Error('Relay assurance marker evaluation anchor is contradictory');
        }
        const after = await options.port.readPullRequest(readInput);
        if (!exactPr(after, input.pr)) {
          throw new Error('Relay draft PR changed during evaluation anchoring');
        }
        return existing;
      }
      const anchor = IssueRelayEvaluationAnchorV1Schema.parse({
        schemaVersion: 'jinn-issue-relay-evaluation-anchor.v1',
        correlation: receipt.correlation,
        targetRepository: receipt.targetRepository,
        workspaceRepository: receipt.workspaceRepository,
        prNumber: input.pr.number,
        targetBase: input.pr.base,
        baseOid: input.currentBaseOid,
        headRef: input.pr.branch,
        evaluatedHead: input.pr.head,
        adoptionReceiptDigest: relayAdoptionReceiptDigest(input.adoption),
        checksDigest: input.checks.digest,
        anchoredAt: now().toISOString(),
      }) as IssueRelayEvaluationAnchorV1;
      const body =
        `${comment.body.trimEnd()}\n\n${formatRelayEvaluationAnchorBlock(anchor)}`;
      try {
        await options.port.editAssuranceComment({
          ...readInput,
          commentId: comment.id,
          expectedHead: input.pr.head,
          body,
        });
      } catch {
        // The edit may have committed before a transport failure. Exact
        // authoritative readback below decides whether publication succeeded.
      }
      const after = await options.port.readPullRequest(readInput);
      if (!exactPr(after, input.pr)) {
        throw new Error('Relay draft PR changed during evaluation anchoring');
      }
      const readback = (await options.port.listAssuranceComments(readInput))
        .filter((candidate) =>
          sameLogin(candidate.authorLogin, input.serviceLogin)
          && candidate.body.includes(ASSURANCE_MARKER)
        );
      if (
        readback.length !== 1
        || readback[0]?.id !== comment.id
        || readback[0].body !== body
      ) {
        throw new Error('Relay evaluation anchor did not read back exactly');
      }
      const parsed = findRelayEvaluationAnchorBlock(
        readback[0].body,
        receipt.correlation,
      );
      if (parsed === null || !isDeepStrictEqual(parsed, anchor)) {
        throw new Error('Relay evaluation anchor did not parse after publication');
      }
      const finalPr = await options.port.readPullRequest(readInput);
      if (!exactPr(finalPr, input.pr)) {
        throw new Error('Relay draft PR changed during evaluation anchoring');
      }
      return parsed;
    },
  };
}
