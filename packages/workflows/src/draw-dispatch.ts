/**
 * Running draws on time, without anyone pressing "run" (GAP-16).
 *
 * `DrawDispatchWorkflow` is started every few minutes by a Temporal Schedule
 * (`draw-dispatch`, see packages/temporal-common/src/schedules.ts). It asks
 * the database which open draws have reached their `draw_at` and starts a
 * `DrawWorkflow` for each — plus a `DrawWatchdogWorkflow` to notice if that
 * run never finishes. Draws are materialised one row each, so the schedule
 * only has to be frequent, not to know the calendar.
 *
 * Duplicate runs are impossible by construction (T-8.1): the run's workflow ID
 * is `draw-<drawId>`, the same ID the admin console's manual "run" uses, and
 * Temporal will not start a second workflow with an ID that is already running
 * or has already run.
 */
import * as workflow from '@temporalio/workflow';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import type { createActivities } from '@qosfc/activities';
import { DrawWorkflow } from './draw.js';
import { DRAW_QUEUE, drawWatchdogId, drawWorkflowId } from './ids.js';

const { findDueDraws, checkDrawProgress, openHumanTask } = workflow.proxyActivities<ReturnType<typeof createActivities>>({
  startToCloseTimeout: '1 minute',
  retry: { initialInterval: '1s', backoffCoefficient: 2, maximumAttempts: 5 },
});

/** How long a run may take before the watchdog raises it. A run blocked on its own task is exempt. */
export const DRAW_COMPLETION_DEADLINE = '2 hours';

export interface DrawDispatchResult {
  readonly started: readonly string[];
  readonly alreadyRunning: readonly string[];
}

export async function DrawDispatchWorkflow(): Promise<DrawDispatchResult> {
  const { draws } = await findDueDraws();
  const started: string[] = [];
  const alreadyRunning: string[] = [];

  for (const draw of draws) {
    try {
      await workflow.startChild(DrawWorkflow, {
        workflowId: drawWorkflowId(draw.drawId),
        taskQueue: DRAW_QUEUE,
        args: [{ drawId: draw.drawId, drawNumber: draw.drawNumber }],
        // The run belongs to the draw, not to this dispatch pass — it must
        // outlive the parent, which completes within seconds.
        parentClosePolicy: workflow.ParentClosePolicy.ABANDON,
        // A failed run is for a human to look at (the watchdog raises it),
        // not for the next dispatch pass to silently retry every few minutes.
        workflowIdReusePolicy: workflow.WorkflowIdReusePolicy.REJECT_DUPLICATE,
      });
      started.push(draw.drawId);
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        alreadyRunning.push(draw.drawId);
        continue;
      }
      throw error;
    }

    try {
      await workflow.startChild(DrawWatchdogWorkflow, {
        workflowId: drawWatchdogId(draw.drawId),
        taskQueue: DRAW_QUEUE,
        args: [{ drawId: draw.drawId, drawNumber: draw.drawNumber }],
        parentClosePolicy: workflow.ParentClosePolicy.ABANDON,
        workflowIdReusePolicy: workflow.WorkflowIdReusePolicy.REJECT_DUPLICATE,
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
  }

  return { started, alreadyRunning };
}

export interface DrawWatchdogInput {
  readonly drawId: string;
  readonly drawNumber: number;
}

export type DrawWatchdogOutcome = 'completed' | 'blocked_on_task' | 'raised';

/**
 * Wakes once, after the deadline, and checks the database rather than the run
 * itself — so it notices a run that failed, timed out or was terminated just
 * as well as one that is merely slow. A run parked on its own human task is
 * waiting by design; that task's escalation covers it.
 */
export async function DrawWatchdogWorkflow(input: DrawWatchdogInput): Promise<DrawWatchdogOutcome> {
  await workflow.sleep(DRAW_COMPLETION_DEADLINE);

  const progress = await checkDrawProgress({ drawId: input.drawId });
  if (progress.status === 'settled' || progress.status === 'void') return 'completed';
  if (progress.openTaskId) return 'blocked_on_task';

  await openHumanTask({
    kind: 'draw_overdue',
    title: `Draw ${input.drawNumber} has not finished`,
    detail:
      `The draw started automatically at its draw time but is still '${progress.status}' ${DRAW_COMPLETION_DEADLINE} ` +
      'later, and it is not waiting on any task. The run may have failed — check it in the Temporal UI ' +
      `(workflow draw-${input.drawId}), then resolve this task once the draw is settled.`,
    consequenceIfIgnored:
      'Winners are not identified or paid, and the next draw starts from a jackpot that may be wrong.',
    entityType: 'draw',
    entityId: input.drawId,
    workflowId: workflow.workflowInfo().workflowId,
    runId: workflow.workflowInfo().runId,
    dedupeKey: `draw_overdue:${input.drawId}`,
  });
  return 'raised';
}
