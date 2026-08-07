import { z } from 'zod';
import {
  IssueRelayEvaluationBundleV2Schema,
  IssueRelayRoundV2Schema,
  IssueRelaySolutionV2Schema,
  type IssueRelayEvaluationBundleV2,
  type IssueRelayRoundV2,
  type IssueRelaySolutionV2,
} from './contracts.js';

export const ISSUE_RELAY_APPLICATION = {
  id: 'autopilot.issue-relay',
  version: 'v2',
} as const;

export const IssueRelayApplicationTaskExtensionSchema = z.object({
  id: z.literal(ISSUE_RELAY_APPLICATION.id),
  version: z.literal(ISSUE_RELAY_APPLICATION.version),
  payload: z.object({
    round: IssueRelayRoundV2Schema,
    evaluation: z.object({
      relayBotLogin: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/),
      requiredChecks: z.array(z.string().min(1).max(200)).max(100),
      laneSpecifications: z.object({
        security: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        quality: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      }).strict(),
    }).strict(),
  }).strict(),
}).strict();

export const IssueRelayMarketplaceTaskSchema = z.object({
  schemaVersion: z.literal('jinn-repo.v1'),
  source: z.literal('live-issue'),
  instance_id: z.string().min(1),
  repo: z.literal('Jinn-Network/mono'),
  language: z.literal('typescript'),
  base_commit: z.string().regex(/^[0-9a-f]{40}$/),
  problem_statement: z.string().min(1),
  issue_number: z.number().int().safe().positive(),
  application: IssueRelayApplicationTaskExtensionSchema,
}).strict();

export const MarketplaceEvaluationProvenanceV1Schema = z.object({
  schemaVersion: z.literal('jinn-marketplace-evaluation-provenance.v1'),
  sourceTaskId: z.string().regex(/^(0|[1-9][0-9]*)$/),
  sourceTaskCid: z.string().regex(/^f01551220[0-9a-f]{64}$/),
  attemptIndex: z.number().int().safe().nonnegative(),
  solutionRequestId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  solutionEnvelopeCid: z.string().regex(/^f01551220[0-9a-f]{64}$/),
  solutionOperatorSafe: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  evaluatorOperatorSafe: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
}).strict();

export type IssueRelayMarketplaceTask = z.infer<
  typeof IssueRelayMarketplaceTaskSchema
>;

export interface IssueRelayEvaluationBinding {
  readonly relayBotLogin: string;
  readonly requiredChecks: readonly string[];
  readonly laneSpecifications: {
    readonly security: `sha256:${string}`;
    readonly quality: `sha256:${string}`;
  };
}

const ApplicationEnvelopeFields = {
  schemaVersion: z.literal('jinn-repo-application-payload.v1'),
  application: z.object({
    id: z.literal(ISSUE_RELAY_APPLICATION.id),
    version: z.literal(ISSUE_RELAY_APPLICATION.version),
  }).strict(),
};

export const IssueRelayApplicationSolutionSchema = z.object({
  ...ApplicationEnvelopeFields,
  role: z.literal('solution'),
  payload: IssueRelaySolutionV2Schema,
}).strict();

export const IssueRelayApplicationVerdictSchema = z.object({
  ...ApplicationEnvelopeFields,
  role: z.literal('verdict'),
  projection: z.enum(['pass', 'fail', 'unresolved']),
  payload: IssueRelayEvaluationBundleV2Schema,
}).strict();

export function issueRelayApplicationExtension(
  round: IssueRelayRoundV2,
  evaluation: IssueRelayEvaluationBinding,
): z.infer<typeof IssueRelayApplicationTaskExtensionSchema> & {
  readonly payload: {
    readonly round: IssueRelayRoundV2;
    readonly evaluation: IssueRelayEvaluationBinding;
  };
} {
  return IssueRelayApplicationTaskExtensionSchema.parse({
    ...ISSUE_RELAY_APPLICATION,
    payload: { round, evaluation },
  }) as z.infer<typeof IssueRelayApplicationTaskExtensionSchema> & {
    readonly payload: {
      readonly round: IssueRelayRoundV2;
      readonly evaluation: IssueRelayEvaluationBinding;
    };
  };
}

export function issueRelayApplicationSolution(
  payload: IssueRelaySolutionV2,
): z.infer<typeof IssueRelayApplicationSolutionSchema> {
  return IssueRelayApplicationSolutionSchema.parse({
    schemaVersion: 'jinn-repo-application-payload.v1',
    application: ISSUE_RELAY_APPLICATION,
    role: 'solution',
    payload,
  });
}

export function issueRelayApplicationVerdict(
  payload: IssueRelayEvaluationBundleV2,
): z.infer<typeof IssueRelayApplicationVerdictSchema> {
  return IssueRelayApplicationVerdictSchema.parse({
    schemaVersion: 'jinn-repo-application-payload.v1',
    application: ISSUE_RELAY_APPLICATION,
    role: 'verdict',
    projection: payload.overallProjection,
    payload,
  });
}
