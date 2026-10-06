/**
 * Contact follow-up sweep (GAP-05).
 *
 * Runs on the `member-contact-follow-up` Temporal Schedule: opens a
 * `member_missing_email` human task for each live member with no email
 * address, and closes those whose member has since been given one. The
 * database is the queue — see `syncMissingEmailTasks` in @qosfc/activities —
 * so a missed tick only delays a task by one interval.
 *
 * Identifier-free by construction (TG-11): the activity returns counts only;
 * names and addresses never enter workflow history.
 */
import * as workflow from '@temporalio/workflow';
import type { createActivities } from '@qosfc/activities';

const { syncMissingEmailTasks } = workflow.proxyActivities<ReturnType<typeof createActivities>>({
  startToCloseTimeout: '5 minutes',
  retry: { initialInterval: '1s', backoffCoefficient: 2, maximumAttempts: 5 },
});

export interface ContactFollowUpSweepResult {
  readonly opened: number;
  readonly closed: number;
}

export async function ContactFollowUpSweepWorkflow(): Promise<ContactFollowUpSweepResult> {
  return syncMissingEmailTasks({});
}
