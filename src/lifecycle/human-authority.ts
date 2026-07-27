import type { BlockedOn } from '../dispatcher/types.js';

const HUMAN_LABELS = new Set([
  'review:needs-human',
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
