import { z } from 'zod';
import type { RelayBudgetPolicy } from './budget.js';

const UINT256_MAX = (1n << 256n) - 1n;
const githubName = z.string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);
const safeName = z.string()
  .min(1)
  .max(200)
  .refine((value) => !/[\u0000-\u001f\u007f\s]/u.test(value));
const positiveInteger = z.number().int().safe().positive();
const canonicalWei = z.string()
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => (
    /^[1-9][0-9]*$/.test(value) && BigInt(value) <= UINT256_MAX
  ));

const budgetSchema = z.object({
  maxGlobalActiveGenerations: positiveInteger,
  maxActivePerRepository: positiveInteger,
  maxActivePerAuthor: positiveInteger,
  maxRoundsPerGeneration: positiveInteger,
  maxGenerationSpendWei: canonicalWei,
  maxGlobalSpendWeiPerUtcDay: canonicalWei,
  generationDeadlineMs: positiveInteger,
}).strict();

const commonConfigFields = {
  repository: z.literal('Jinn-Network/mono'),
  label: z.literal('engine:marketplace'),
  relayBotLogin: githubName,
  managedForkRepository: z.string()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/),
  targetBase: safeName,
  solverNet: safeName,
  verificationProfile: z.literal('jinn-mono.v1'),
  requiredChecks: z.array(safeName).max(100),
  pollSeconds: positiveInteger,
};

const configV1Schema = z.object({
  schemaVersion: z.literal(1),
  ...commonConfigFields,
  budget: budgetSchema,
}).strict();

const configV2Schema = z.object({
  schemaVersion: z.literal(2),
  ...commonConfigFields,
  generationProtocol: z.literal('v2'),
  dualLaneEvaluationEnabled: z.boolean(),
  humanDecisionCommandsEnabled: z.boolean(),
  decisionImplementationEnabled: z.boolean(),
  laneSpecifications: z.object({
    security: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    quality: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }).strict(),
  safePreimplementationReasonCodes: z.array(safeName).max(100),
  budget: budgetSchema.extend({
    maxEvaluationAttemptsPerLanePerHead: positiveInteger,
    maxEvaluationRetrySpendWei: canonicalWei,
    maxDecisionRequestsPerGeneration: positiveInteger,
    maxDecisionImplementationRoundsPerGeneration: positiveInteger,
    maxDecisionImplementationSpendWei: canonicalWei,
    humanDecisionTtlMs: positiveInteger,
    maxHumanDeferrals: z.number().int().safe().nonnegative(),
    humanDeferralExtensionMs: positiveInteger,
    decisionContinuationDeadlineMs: positiveInteger,
  }).strict(),
}).strict();

const configSchema = z.discriminatedUnion('schemaVersion', [
  configV1Schema,
  configV2Schema,
]).superRefine((config, context) => {
  const [forkOwner] = config.managedForkRepository.split('/');
  if (
    forkOwner?.toLocaleLowerCase('en-US')
      !== config.relayBotLogin.toLocaleLowerCase('en-US')
    || config.managedForkRepository.toLocaleLowerCase('en-US')
      === config.repository.toLocaleLowerCase('en-US')
  ) {
    context.addIssue({
      code: 'custom',
      path: ['managedForkRepository'],
      message: 'Managed fork must be owned by the configured Relay bot',
    });
  }
  const normalized = new Set<string>();
  for (const [index, check] of config.requiredChecks.entries()) {
    const key = check.toLocaleLowerCase('en-US');
    if (normalized.has(key)) {
      context.addIssue({
        code: 'custom',
        path: ['requiredChecks', index],
        message: 'Required check names must be unique',
      });
    }
    normalized.add(key);
  }
});

export interface IssueRelayConfigFileV1 {
  readonly schemaVersion: 1;
  readonly repository: 'Jinn-Network/mono';
  readonly label: 'engine:marketplace';
  readonly relayBotLogin: string;
  readonly managedForkRepository: string;
  readonly targetBase: string;
  readonly solverNet: string;
  readonly verificationProfile: 'jinn-mono.v1';
  readonly requiredChecks: readonly string[];
  readonly pollSeconds: number;
  readonly budget: {
    readonly maxGlobalActiveGenerations: number;
    readonly maxActivePerRepository: number;
    readonly maxActivePerAuthor: number;
    readonly maxRoundsPerGeneration: number;
    readonly maxGenerationSpendWei: string;
    readonly maxGlobalSpendWeiPerUtcDay: string;
    readonly generationDeadlineMs: number;
  };
}

export interface IssueRelayConfigV1
  extends Omit<IssueRelayConfigFileV1, 'budget'> {
  readonly budget: RelayBudgetPolicy;
}

/** Common runtime surface retained for V1 production composition. */
export interface IssueRelayConfig
  extends Omit<IssueRelayConfigFileV1, 'schemaVersion' | 'budget'> {
  readonly schemaVersion: 1 | 2;
  readonly budget: RelayBudgetPolicy;
}

export interface IssueRelayConfigFileV2
  extends Omit<IssueRelayConfigFileV1, 'schemaVersion' | 'budget'> {
  readonly schemaVersion: 2;
  readonly generationProtocol: 'v2';
  readonly dualLaneEvaluationEnabled: boolean;
  readonly humanDecisionCommandsEnabled: boolean;
  readonly decisionImplementationEnabled: boolean;
  readonly laneSpecifications: {
    readonly security: `sha256:${string}`;
    readonly quality: `sha256:${string}`;
  };
  readonly safePreimplementationReasonCodes: readonly string[];
  readonly budget: IssueRelayConfigFileV1['budget'] & {
    readonly maxEvaluationAttemptsPerLanePerHead: number;
    readonly maxEvaluationRetrySpendWei: string;
    readonly maxDecisionRequestsPerGeneration: number;
    readonly maxDecisionImplementationRoundsPerGeneration: number;
    readonly maxDecisionImplementationSpendWei: string;
    readonly humanDecisionTtlMs: number;
    readonly maxHumanDeferrals: number;
    readonly humanDeferralExtensionMs: number;
    readonly decisionContinuationDeadlineMs: number;
  };
}

export interface IssueRelayConfigV2
  extends Omit<IssueRelayConfigFileV2, 'budget'> {
  readonly budget: RelayBudgetPolicy & {
    readonly maxEvaluationAttemptsPerLanePerHead: number;
    readonly maxEvaluationRetrySpendWei: bigint;
    readonly maxDecisionRequestsPerGeneration: number;
    readonly maxDecisionImplementationRoundsPerGeneration: number;
    readonly maxDecisionImplementationSpendWei: bigint;
    readonly humanDecisionTtlMs: number;
    readonly maxHumanDeferrals: number;
    readonly humanDeferralExtensionMs: number;
    readonly decisionContinuationDeadlineMs: number;
  };
}

export type AnyIssueRelayConfig = IssueRelayConfigV1 | IssueRelayConfigV2;

export function parseIssueRelayConfig(input: unknown): IssueRelayConfig | IssueRelayConfigV2 {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    throw new TypeError('Invalid Jinn Issue Relay config', {
      cause: parsed.error,
    });
  }
  const config = parsed.data;
  if (config.schemaVersion === 2) {
    return {
      ...config,
      requiredChecks: [...config.requiredChecks],
      safePreimplementationReasonCodes: [...config.safePreimplementationReasonCodes],
      budget: {
        ...config.budget,
        maxGenerationSpendWei: BigInt(config.budget.maxGenerationSpendWei),
        maxGlobalSpendWeiPerUtcDay: BigInt(config.budget.maxGlobalSpendWeiPerUtcDay),
        maxEvaluationRetrySpendWei: BigInt(config.budget.maxEvaluationRetrySpendWei),
        maxDecisionImplementationSpendWei: BigInt(config.budget.maxDecisionImplementationSpendWei),
      },
    } as IssueRelayConfigV2;
  }
  return {
    ...config,
    requiredChecks: [...config.requiredChecks],
    budget: {
      ...config.budget,
      maxGenerationSpendWei: BigInt(config.budget.maxGenerationSpendWei),
      maxGlobalSpendWeiPerUtcDay:
        BigInt(config.budget.maxGlobalSpendWeiPerUtcDay),
    },
  };
}
