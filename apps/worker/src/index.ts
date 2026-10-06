#!/usr/bin/env node
/**
 * Worker process.
 *
 * One image, one task queue per container, selected by TASK_QUEUE (T-10.19). The
 * separation by workload class is what stops a slow OCR batch starving the draw,
 * and it is enforced by the deployment rather than by convention.
 */
import { NativeConnection, Worker } from '@temporalio/worker';
import { appDbConnectionFromEnv, createPool } from '@qosfc/db';
import { createActivities } from '@qosfc/activities';
import {
  EncryptionCodec,
  SEARCH_ATTRIBUTES,
  TASK_QUEUES,
  assertTaskQueue,
  connectionConfigFromEnv,
  createClient,
  ensureSchedules,
} from '@qosfc/temporal-common';
import { describeRegistry } from '@qosfc/ports';
import { buildProviderRegistry } from './composition-root.js';

const taskQueue = assertTaskQueue(process.env['TASK_QUEUE'] ?? 'draw');
const config = connectionConfigFromEnv();

const pool = createPool({
  ...appDbConnectionFromEnv(),
  applicationName: `qosfc-worker-${taskQueue}`,
  max: 10,
});

const providers = buildProviderRegistry(process.env, pool);
const activities = createActivities({ pool, providers });

const connection = await NativeConnection.connect({ address: config.address });

/**
 * T-10.7: custom search attributes are namespace-scoped on SQL-backed
 * visibility, and workflow code that sets an unregistered one fails at RUNTIME —
 * mid-draw, not at deploy. Assert them at startup so a missed provisioning step
 * is a refused boot rather than a Saturday-night incident.
 */
await assertSearchAttributesRegistered();

/**
 * The draw-dispatch, task-escalation and random-allocation schedules (schedules.ts). Owned by the
 * draw worker alone so exactly one process creates them; idempotent, so every
 * restart is safe. TEMPORAL_SCHEDULES=off leaves them uncreated — for a dev
 * stack whose seeded draws should not start running on their own.
 */
const schedulesEnabled = process.env['TEMPORAL_SCHEDULES'] !== 'off';
const schedules =
  taskQueue === TASK_QUEUES.draw && schedulesEnabled ? await ensureSchedulesWithClient() : undefined;

const worker = await Worker.create({
  connection,
  namespace: config.namespace,
  taskQueue,
  workflowsPath: new URL('../../../packages/workflows/dist/index.js', import.meta.url).pathname,
  activities,
  ...(config.keyProvider
    ? { dataConverter: { payloadCodecs: [new EncryptionCodec(config.keyProvider)] } }
    : {}),
  // The draw fan-out at cut-off is the only meaningful load spike in the system,
  // and T-10.1 jitters it across a window so it never arrives all at once.
  maxConcurrentActivityTaskExecutions: 20,
  maxConcurrentWorkflowTaskExecutions: 20,
});

console.log(
  JSON.stringify({
    msg: 'worker starting',
    taskQueue,
    namespace: config.namespace,
    payloadEncryption: config.keyProvider ? 'enabled' : 'DISABLED (non-production only)',
    ...(taskQueue === TASK_QUEUES.draw ? { schedules: schedules ?? 'disabled (TEMPORAL_SCHEDULES=off)' } : {}),
    providers: describeRegistry(providers),
  }),
);

process.on('SIGTERM', () => worker.shutdown());
process.on('SIGINT', () => worker.shutdown());

try {
  await worker.run();
} finally {
  connection.close();
  await pool.end();
}

async function ensureSchedulesWithClient() {
  const client = await createClient(config);
  try {
    return await ensureSchedules(client);
  } finally {
    await client.connection.close();
  }
}

async function assertSearchAttributesRegistered(): Promise<void> {
  const response = await connection.operatorService.listSearchAttributes({ namespace: config.namespace });
  const present = new Set(Object.keys(response.customAttributes ?? {}));
  const missing = Object.keys(SEARCH_ATTRIBUTES).filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Search attributes not registered in namespace "${config.namespace}": ${missing.join(', ')}. ` +
        `Run deploy/bootstrap/bootstrap-temporal.sh. Workflow code setting an unregistered attribute ` +
        `fails at runtime, which on a draw workflow means mid-draw.`,
    );
  }
}
