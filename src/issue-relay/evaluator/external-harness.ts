import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  type ExternalHarnessFactory,
  type HarnessContext,
  type ReadyStatus,
  type Solution,
  type Task,
} from '@jinn-network/sdk/harness';

import {
  IssueRelayApplicationSolutionSchema,
  IssueRelayMarketplaceTaskSchema,
  MarketplaceEvaluationProvenanceV1Schema,
  issueRelayApplicationVerdict,
} from '../marketplace-application.js';
import {
  createIssueRelayEvaluationContextResolver,
} from './evaluation-context-resolver.js';
import {
  createIssueRelayGitHubRestReadPort,
} from './github-receipt-observer.js';
import { ClaudeJsonSemanticRunner } from './claude-semantic-runner.js';
import {
  ClaudeIssueRelayReviewSkillRunner,
} from './issue-relay-review-skills.js';
import {
  createIssueRelayRepositoryGuidanceChecker,
} from './issue-relay-repository-guidance.js';
import {
  snykIssueRelayScannerFromEnvironment,
} from './issue-relay-security-scanner.js';
import {
  createIssueRelayLaneAdjudicator,
  runIssueRelayDualLaneReview,
} from './issue-relay-v2-semantic.js';

const PROVENANCE_CONTEXT_KEY = 'jinn.marketplace.evaluation-provenance.v1';

const SolutionEnvelopeSchema = z.object({
  solverType: z.literal('jinn-repo.v1'),
  role: z.enum(['solution', 'restoration']),
  participant: z.object({
    safeAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  }).passthrough(),
  payload: IssueRelayApplicationSolutionSchema,
}).passthrough();

type ParsedEvaluationTask = {
  readonly task: z.infer<typeof IssueRelayMarketplaceTaskSchema>;
  readonly solution: z.infer<typeof IssueRelayApplicationSolutionSchema>['payload'];
  readonly provenance: z.infer<typeof MarketplaceEvaluationProvenanceV1Schema>;
};

async function resolveEvaluationContext(parsed: ParsedEvaluationTask) {
  const evaluation = parsed.task.application.payload.evaluation;
  return await createIssueRelayEvaluationContextResolver({
    github: createIssueRelayGitHubRestReadPort({
      requiredCheckNames: evaluation.requiredChecks,
    }),
    relayBotLogin: evaluation.relayBotLogin,
    laneSpecifications: {
      security: evaluation.laneSpecifications.security as `sha256:${string}`,
      quality: evaluation.laneSpecifications.quality as `sha256:${string}`,
    },
  }).resolve({
    task: parsed.task,
    solution: parsed.solution,
    provenance: parsed.provenance,
  });
}

function parseEvaluationTask(task: Task): ParsedEvaluationTask {
  if (task.role !== 'evaluation') throw new Error('Relay evaluator requires evaluation role');
  const sourceTask = IssueRelayMarketplaceTaskSchema.parse(task.spec);
  const provenance = MarketplaceEvaluationProvenanceV1Schema.parse(
    task.context?.[PROVENANCE_CONTEXT_KEY],
  );
  if (
    task.attemptNumber !== provenance.attemptIndex
    || task.restorationRequestId !== provenance.solutionRequestId
  ) {
    throw new Error('Relay evaluation task and marketplace provenance disagree');
  }
  const rawEnvelope = task.context?.['restorationResult'];
  if (typeof rawEnvelope !== 'string') {
    throw new Error('Relay evaluation requires the signed Solution envelope');
  }
  const envelope = SolutionEnvelopeSchema.parse(JSON.parse(rawEnvelope) as unknown);
  if (
    envelope.participant.safeAddress.toLowerCase()
      !== provenance.solutionOperatorSafe.toLowerCase()
  ) {
    throw new Error('Relay Solution envelope operator disagrees with marketplace provenance');
  }
  return {
    task: sourceTask,
    solution: envelope.payload.payload,
    provenance,
  };
}

function evaluatorEnvironment(secrets: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR'] as const) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  const anthropicApiKey = secrets['ANTHROPIC_API_KEY']
    ?? process.env['ANTHROPIC_API_KEY'];
  if (anthropicApiKey) {
    environment['ANTHROPIC_API_KEY'] = anthropicApiKey;
  }
  const snykToken = secrets['SNYK_TOKEN'] ?? process.env['SNYK_TOKEN'];
  if (snykToken) environment['SNYK_TOKEN'] = snykToken;
  if (process.env['JINN_ISSUE_RELAY_SNYK_ENABLED'] === '1') {
    environment['JINN_ISSUE_RELAY_SNYK_ENABLED'] = '1';
  }
  return environment;
}

const factory: ExternalHarnessFactory = (external) => {
  const environment = evaluatorEnvironment(external.secrets);
  const semantic = new ClaudeJsonSemanticRunner(environment);
  const reviewSkills = new ClaudeIssueRelayReviewSkillRunner({
    environment,
    qualitySkillPath: process.env['JINN_ISSUE_RELAY_CLAUDE_CODE_REVIEW_SKILL_PATH'],
    securitySkillPath: process.env['JINN_ISSUE_RELAY_CLAUDE_SECURITY_REVIEW_SKILL_PATH'],
  });
  const scanner = snykIssueRelayScannerFromEnvironment(environment);

  const ready = async (): Promise<ReadyStatus> => {
    if (external.stub) return { ready: false, reason: 'requires live daemon' };
    const [semanticStatus, reviewStatus, scannerStatus] = await Promise.all([
      semantic.isReady!(),
      reviewSkills.isReady!(),
      scanner?.isReady?.(),
    ]);
    if (!semanticStatus.ready) return semanticStatus;
    if (!reviewStatus.ready) return reviewStatus;
    if (scannerStatus !== undefined && !scannerStatus.ready) return scannerStatus;
    return { ready: true };
  };

  return {
    name: external.implName,
    version: external.implVersion,
    supports: ({ solverType, role }) =>
      solverType === 'jinn-repo.v1' && role === 'evaluation',
    async canAttempt(task) {
      try {
        const parsed = parseEvaluationTask(task);
        const observation = await resolveEvaluationContext(parsed);
        return observation.state === 'accepted'
          ? { ok: true }
          : {
              ok: false,
              reason: `Issue Relay evaluation evidence is ${observation.state}: ${observation.detail}`,
            };
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
    isReady: ready,
    async run(ctx: HarnessContext): Promise<Solution> {
      const parsed = parseEvaluationTask(ctx.task);
      const observation = await resolveEvaluationContext(parsed);
      if (observation.state !== 'accepted') {
        throw new Error(
          `Issue Relay evaluation evidence changed to ${observation.state}: ${observation.detail}`,
        );
      }
      const context = observation.context;
      const requiredChecks = context.checks.required.map(({ name }) => name);
      const bundle = await runIssueRelayDualLaneReview({
        context,
        runMechanical: async () => ({
          passed: true,
          summary: requiredChecks.length === 0
            ? 'The exact-head Relay anchor records no required repository checks.'
            : `Authenticated exact-head repository checks passed: ${requiredChecks.join(', ')}.`,
          findings: [],
        }),
        runReviewSkill: reviewSkills,
        adjudicateLane: createIssueRelayLaneAdjudicator({
          runner: semantic,
          abort: ctx.abort,
          ...(process.env['JINN_ISSUE_RELAY_CLAUDE_MODEL'] === undefined
            ? {}
            : { model: process.env['JINN_ISSUE_RELAY_CLAUDE_MODEL'] }),
        }),
        checkRepositoryGuidance: createIssueRelayRepositoryGuidanceChecker({
          runner: semantic,
          abort: ctx.abort,
          ...(process.env['JINN_ISSUE_RELAY_CLAUDE_MODEL'] === undefined
            ? {}
            : { model: process.env['JINN_ISSUE_RELAY_CLAUDE_MODEL'] }),
        }),
        ...(scanner === undefined ? {} : { securityScanner: scanner }),
        abort: ctx.abort,
        ...(process.env['JINN_ISSUE_RELAY_CLAUDE_MODEL'] === undefined
          ? {}
          : { reviewSkillModel: process.env['JINN_ISSUE_RELAY_CLAUDE_MODEL'] }),
      });
      const artifactPath = 'jinn-issue-relay-evaluation-bundle.json';
      await writeFile(
        join(ctx.workingDir, artifactPath),
        `${JSON.stringify(bundle, null, 2)}\n`,
        'utf8',
      );
      const verdictPayload = issueRelayApplicationVerdict(bundle);
      return {
        venueRef: { name: 'jinn-repo' },
        gating: bundle.overallProjection === 'pass'
          ? { passed: true, verdict: 'PASS', verdictCode: 1 }
          : bundle.overallProjection === 'fail'
            ? { passed: false, verdict: 'FAIL', verdictCode: 2 }
            : { passed: false, verdict: 'UNRESOLVED', verdictCode: 4 },
        informational: {
          application: 'autopilot.issue-relay',
          evaluatedHead: bundle.evaluatedHead,
          laneEvaluatorsShareOperator: true,
          solutionOperatorSafe: parsed.provenance.solutionOperatorSafe,
          evaluatorOperatorSafe: parsed.provenance.evaluatorOperatorSafe,
        },
        verdictPayload: verdictPayload as unknown as Record<string, unknown>,
        artifacts: [{
          path: artifactPath,
          artifactType: 'jinn_issue_relay_evaluation_bundle',
          overallProjection: bundle.overallProjection,
          evaluatedHead: bundle.evaluatedHead,
        }],
      };
    },
  };
};

export default factory;
