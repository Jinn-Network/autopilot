#!/usr/bin/env tsx

import { isAbsolute } from 'node:path';
import { digestIssueRelayJinnDistribution } from '../src/issue-relay/jinn-distribution.js';

const binaryPath = process.argv[2];
if (binaryPath === undefined || !isAbsolute(binaryPath)) {
  throw new Error(
    'Usage: digest-jinn-issue-relay-client.ts /absolute/dist/bin/jinn.js',
  );
}

process.stdout.write(`${digestIssueRelayJinnDistribution(binaryPath)}\n`);
