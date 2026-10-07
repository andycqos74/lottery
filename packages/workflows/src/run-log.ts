/**
 * Run log sweep — every minute, writes one plain-language line for each
 * workflow run that has finished since the last sweep (the admin console's
 * Log page). See `recordRunLog` in @qosfc/activities. It never logs itself.
 */
import * as workflow from '@temporalio/workflow';
import type { createActivities, RecordRunLogResult } from '@qosfc/activities';

const { recordRunLog } = workflow.proxyActivities<ReturnType<typeof createActivities>>({
  startToCloseTimeout: '5 minutes',
  retry: { initialInterval: '10s', backoffCoefficient: 2, maximumAttempts: 3 },
});

export async function RunLogSweepWorkflow(): Promise<RecordRunLogResult> {
  return recordRunLog({});
}
