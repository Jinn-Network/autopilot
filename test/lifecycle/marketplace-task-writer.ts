import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  persistMarketplaceTaskRequest,
} from '../../src/lifecycle/marketplace-task.js';
import type { TaskSubmitRequestV1 } from '@jinn-network/sdk/autopilot';

const input = JSON.parse(process.argv[2] ?? '{}') as {
  readonly startPath: string;
  readonly requestPath: string;
  readonly request: TaskSubmitRequestV1;
};

process.stdout.write('ready\n');
while (!existsSync(input.startPath)) {
  await delay(5);
}

try {
  const artifact = persistMarketplaceTaskRequest(input.requestPath, input.request);
  process.stdout.write(`${JSON.stringify({ ok: true, artifact })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`);
}
