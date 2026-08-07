import type {
  IssueRelayEvaluationContextV2,
  IssueRelayFindingV1,
} from '../contracts.js';

export interface SemanticAgentRunnerInput {
  readonly prompt: string;
  readonly abort: AbortSignal;
  readonly model?: string;
}

export interface SemanticRuntimeReadiness {
  readonly ready: boolean;
  readonly reason?: string;
}

export interface SemanticAgentRunner {
  isReady?(): Promise<SemanticRuntimeReadiness>;
  run(input: SemanticAgentRunnerInput): Promise<string>;
}

export type IssueRelayMechanicalRunner = (input: {
  readonly checkoutPath: string;
  readonly verificationProfile: 'jinn-mono.v1';
}) => Promise<{
  readonly passed: boolean;
  readonly summary: string;
  readonly findings: readonly IssueRelayFindingV1[];
}>;

export type IssueRelayRepositoryGit = (input: {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
}) => Promise<string>;

export type IssueRelayEvaluationChecks = IssueRelayEvaluationContextV2['checks'];
