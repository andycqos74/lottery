/**
 * Random allocation sweep (GAP-13).
 *
 * Runs on the `selection-random-allocation` Temporal Schedule: gives
 * RANDOM.ORG numbers to every line still without any a week after it was
 * issued, and tells the member by email or by a task to post them. The
 * database is the queue — see `allocateRandomSelections` in
 * @qosfc/activities — so a missed tick only delays an allocation by one
 * interval.
 *
 * The RANDOM.ORG call happens in the activity, never here (T-6.1). Returns
 * counts only (TG-11).
 */
import * as workflow from '@temporalio/workflow';
import type { createActivities } from '@qosfc/activities';

const { allocateRandomSelections } = workflow.proxyActivities<ReturnType<typeof createActivities>>({
  // Up to 200 sequential RANDOM.ORG calls.
  startToCloseTimeout: '15 minutes',
  retry: { initialInterval: '30s', backoffCoefficient: 2, maximumAttempts: 5 },
});

export interface RandomAllocationSweepResult {
  readonly allocated: number;
  readonly emailed: number;
  readonly postTasks: number;
}

export async function RandomAllocationSweepWorkflow(): Promise<RandomAllocationSweepResult> {
  return allocateRandomSelections({});
}
