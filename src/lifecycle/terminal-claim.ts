import { createHash } from 'node:crypto';
export interface ImplementationClaim {
  readonly protocolVersion: 2;
  readonly phase: 'implement';
  readonly issueNumber: number;
  readonly prNumber?: number;
  readonly attempt: string;
  readonly runner: string;
  readonly login: string;
  readonly expectedHead: string;
  readonly targetBase: string;
  readonly claimedAt: string;
  readonly phaseComplete?: true;
}

/**
 * Binds retained terminal evidence to every field in the implementation claim
 * that was exact-hydrated at seed time without expanding that evidence into
 * general PR or merge authority.
 */
export function implementationClaimFingerprint(claim: ImplementationClaim): string {
  const canonical = JSON.stringify({
    protocolVersion: claim.protocolVersion,
    phase: claim.phase,
    issueNumber: claim.issueNumber,
    prNumber: claim.prNumber ?? null,
    attempt: claim.attempt,
    runner: claim.runner,
    login: claim.login,
    expectedHead: claim.expectedHead,
    targetBase: claim.targetBase,
    claimedAt: claim.claimedAt,
    phaseComplete: claim.phaseComplete === true,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
