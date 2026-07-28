import { createHash } from 'node:crypto';
import type { IssueRelaySnapshotV1 } from './snapshot.js';

export function relayGeneration(snapshot: IssueRelaySnapshotV1): string {
  return `${snapshot.repository.nodeId}:${snapshot.issue.number}:${snapshot.snapshotDigest}`;
}

export function relayRoundKey(generation: string, round: number): string {
  return `issue-relay:${generation}:round:${round}`;
}

export function relayTaskKey(generation: string, round: number): string {
  return relayRoundKey(generation, round);
}

export function relayBranch(generation: string): string {
  const short = createHash('sha256')
    .update(generation)
    .digest('hex')
    .slice(0, 24);

  return `jinn/issue-relay/${short}`;
}
