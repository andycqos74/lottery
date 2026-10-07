/**
 * Temporal Schedules — the system's only clock-driven starts.
 *
 * All are sweeps that ask the database what is due, rather than schedules
 * that encode the calendar themselves: draws are materialised one row each
 * with an exact `draw_at` (GAP-16, migration 0015), and tasks carry their own
 * `opened_at`/`due_at`. So a missed or late tick only delays work by one
 * interval — the next tick finds the same rows.
 *
 * Ensured at worker startup (the `draw` worker only, so exactly one process
 * owns them) rather than provisioned by hand, so a fresh environment cannot
 * silently lack the thing that runs its draws. Created once and then left
 * alone: pausing one in the Temporal UI survives a restart.
 */
import { ScheduleAlreadyRunning, ScheduleOverlapPolicy, type Client } from '@temporalio/client';
import { TASK_QUEUES } from './task-queues.js';

export interface ScheduleDefinition {
  readonly scheduleId: string;
  readonly workflowType: string;
  readonly taskQueue: string;
  readonly every: string;
  readonly note: string;
}

export const SCHEDULES: readonly ScheduleDefinition[] = [
  {
    scheduleId: 'draw-dispatch',
    workflowType: 'DrawDispatchWorkflow',
    taskQueue: TASK_QUEUES.draw,
    // A draw starts at most this long after its draw time.
    every: '5 minutes',
    note: 'Starts DrawWorkflow for each open draw whose draw_at has passed (GAP-16).',
  },
  {
    scheduleId: 'task-escalation-sweep',
    workflowType: 'EscalationSweepWorkflow',
    taskQueue: TASK_QUEUES.comms,
    every: '15 minutes',
    note: 'Starts an EscalationWorkflow for every open human task that has none (FR-5.6, GAP-42).',
  },
  {
    scheduleId: 'selection-random-allocation',
    workflowType: 'RandomAllocationSweepWorkflow',
    taskQueue: TASK_QUEUES.comms,
    every: '1 hour',
    note: 'Gives RANDOM.ORG numbers to lines still without any a week after they were issued, and tells the member (GAP-13).',
  },
  {
    scheduleId: 'direct-debit',
    workflowType: 'DirectDebitWorkflow',
    taskQueue: TASK_QUEUES.payments,
    every: '15 minutes',
    note: 'Applies bank mandate messages, cancels ended mandates with the bureau, and runs the monthly Direct Debit collections (GAP-10/11/12).',
  },
  {
    scheduleId: 'run-log',
    workflowType: 'RunLogSweepWorkflow',
    taskQueue: TASK_QUEUES.comms,
    every: '1 minute',
    note: 'Writes a plain-language line for every finished workflow run, for the admin Log page.',
  },
];

export interface EnsureSchedulesResult {
  readonly created: readonly string[];
  readonly existing: readonly string[];
}

export async function ensureSchedules(client: Client): Promise<EnsureSchedulesResult> {
  const created: string[] = [];
  const existing: string[] = [];
  for (const schedule of SCHEDULES) {
    try {
      await client.schedule.create({
        scheduleId: schedule.scheduleId,
        spec: { intervals: [{ every: schedule.every }] },
        action: {
          type: 'startWorkflow',
          workflowType: schedule.workflowType,
          taskQueue: schedule.taskQueue,
          workflowId: schedule.scheduleId,
        },
        // A sweep still running when the next tick fires has nothing to gain
        // from a second copy racing it over the same rows.
        policies: { overlap: ScheduleOverlapPolicy.SKIP },
        state: { note: schedule.note },
      });
      created.push(schedule.scheduleId);
    } catch (error) {
      if (!(error instanceof ScheduleAlreadyRunning)) throw error;
      existing.push(schedule.scheduleId);
    }
  }
  return { created, existing };
}
