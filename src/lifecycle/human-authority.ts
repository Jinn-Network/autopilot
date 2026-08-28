import type { BlockedOn } from '../dispatcher/types.js';

/**
 * The label a human applies — or the engine applies on their behalf — to take a
 * pull request off the engine's hands. Exported from here rather than from the
 * dispatcher's merge sweep because this module is the authority on what human
 * authority *is*; the sweep was only the first file that happened to need the
 * string.
 */
export const NEEDS_HUMAN_LABEL = 'review:needs-human';

/**
 * The pre-convergence alias. Tolerated on read so repositories initialized
 * before the convergence keep working, but never provisioned and never
 * written: `autopilot init` creates only NEEDS_HUMAN_LABEL. Remove once no
 * live repository carries it.
 */
export const LEGACY_NEEDS_HUMAN_LABEL = 'autopilot:human';

/** Canonical first, so `externalHumanLabel` reports the canonical name when both are present. */
export const HUMAN_HOLD_LABELS = [
  NEEDS_HUMAN_LABEL,
  LEGACY_NEEDS_HUMAN_LABEL,
] as const;

/** The human-hold label present on `labels`, or undefined. Callers report this
 *  rather than naming the strings themselves. */
export function externalHumanLabel(
  labels: readonly string[],
): string | undefined {
  return HUMAN_HOLD_LABELS.find((label) => labels.includes(label));
}

export function hasExternalHumanLabel(labels: readonly string[]): boolean {
  return externalHumanLabel(labels) !== undefined;
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
