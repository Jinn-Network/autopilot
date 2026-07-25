export type AutopilotExecutionBackend = 'local' | 'marketplace';

/**
 * Reads the standalone execution-backend selector. This deliberately remains
 * outside the strict repository product configuration: it is a process-local
 * deployment choice, not checked-in repository policy.
 */
export function parseAutopilotExecutionBackend(
  raw: string | undefined,
): AutopilotExecutionBackend {
  if (raw === undefined || raw.trim().length === 0) return 'local';
  if (raw === 'local' || raw === 'marketplace') return raw;
  throw new Error(
    `Unsupported JINN_AUTOPILOT_EXECUTION_BACKEND value: ${JSON.stringify(raw)}`,
  );
}
