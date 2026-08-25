import type { BlockedOn } from '../dispatcher/types.js';

/**
 * The label a human applies — or the engine applies on their behalf — to take a
 * pull request off the engine's hands. Exported from here rather than from the
 * dispatcher's merge sweep because this module is the authority on what human
 * authority *is*; the sweep was only the first file that happened to need the
 * string.
 */
export const NEEDS_HUMAN_LABEL = 'review:needs-human';

const HUMAN_LABELS = new Set([
  NEEDS_HUMAN_LABEL,
  'autopilot:human',
]);

export function hasExternalHumanLabel(labels: readonly string[]): boolean {
  return labels.some((label) => HUMAN_LABELS.has(label));
}

export function hasExternalHumanAuthority(input: {
  readonly pullRequestLabels?: readonly string[];
  readonly nativeIssueLabels?: readonly string[];
  readonly projectBlockedOn?: BlockedOn | null;
}): boolean {
  return hasExternalHumanLabel(input.pullRequestLabels ?? [])
    || hasExternalHumanLabel(input.nativeIssueLabels ?? [])
    || input.projectBlockedOn === 'Human';
}
