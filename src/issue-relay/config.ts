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

const configSchema = z.object({
  schemaVersion: z.literal(1),
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
  budget: budgetSchema,
}).strict().superRefine((config, context) => {
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

export interface IssueRelayConfig
  extends Omit<IssueRelayConfigFileV1, 'budget'> {
  readonly budget: RelayBudgetPolicy;
}

export function parseIssueRelayConfig(input: unknown): IssueRelayConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    throw new TypeError('Invalid Jinn Issue Relay config', {
      cause: parsed.error,
    });
  }
  const config = parsed.data;
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
