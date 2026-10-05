/**
 * Escalation of open human tasks (FR-5.6, GAP-42).
 *
 * Every blocking wait in this system is allowed to be indefinite (FR-5.4) on
 * one condition: something stops it being forgotten. That is this file.
 *
 * - `EscalationSweepWorkflow` runs on a Temporal Schedule
 *   (`task-escalation-sweep`) and starts one `EscalationWorkflow` for every
 *   open task that has none — whether a workflow opened the task or the admin
 *   console did (a bank transaction to review, say).
 * - `EscalationWorkflow` (`escalation-<taskId>`) sleeps until its task is
 *   overdue, raises its escalation level, and repeats until the task closes.
 *
 * GAP-42 ⛔: there is no escalation policy and no named on-call, so escalating
 * makes the task louder in the admin inbox and in audit_log — it never sends
 * anything to someone the code has guessed. The cadence is a placeholder
 * (ESCALATION_INTERVAL_MS in @qosfc/activities).
 */
import * as workflow from '@temporalio/workflow';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import type { createActivities } from '@qosfc/activities';
import { COMMS_QUEUE, escalationWorkflowId } from './ids.js';

const { listTasksAwaitingEscalation, markEscalationStarted, getTaskEscalationState, escalateTask } =
  workflow.proxyActivities<ReturnType<typeof createActivities>>({
    startToCloseTimeout: '1 minute',
    retry: { initialInterval: '1s', backoffCoefficient: 2, maximumAttempts: 5 },
  });

/** Sent by the admin console when it resolves the task, so the workflow ends now rather than at its next wake-up. */
export const taskClosed = workflow.defineSignal('task_closed');

export interface EscalationInput {
  readonly taskId: string;
}

/** Bounds history: a task ignored for weeks continues as new rather than growing one history forever. */
const ESCALATIONS_PER_RUN = 20;

export async function EscalationWorkflow(input: EscalationInput): Promise<'task_closed'> {
  let closed = false;
  workflow.setHandler(taskClosed, () => {
    closed = true;
  });

  for (let i = 0; i < ESCALATIONS_PER_RUN; i++) {
    const state = await getTaskEscalationState({ taskId: input.taskId });
    if (state.status !== 'open') return 'task_closed';

    if (state.msUntilOverdue > 0) {
      // Wakes early only if the console says the task closed.
      if (await workflow.condition(() => closed, state.msUntilOverdue)) return 'task_closed';
      // Re-read rather than escalate blind: the task may have been resolved
      // without a signal reaching us (a bank review resolved in the console).
      continue;
    }

    await escalateTask({
      taskId: input.taskId,
      fromLevel: state.escalationLevel,
      workflowId: workflow.workflowInfo().workflowId,
    });
  }

  return workflow.continueAsNew<typeof EscalationWorkflow>(input);
}

export interface EscalationSweepResult {
  readonly started: number;
}

export async function EscalationSweepWorkflow(): Promise<EscalationSweepResult> {
  const { taskIds } = await listTasksAwaitingEscalation({});
  const startedFor: { taskId: string; workflowId: string }[] = [];

  for (const taskId of taskIds) {
    const workflowId = escalationWorkflowId(taskId);
    try {
      await workflow.startChild(EscalationWorkflow, {
        workflowId,
        taskQueue: COMMS_QUEUE,
        args: [{ taskId }],
        // Outlives this sweep, which completes in seconds.
        parentClosePolicy: workflow.ParentClosePolicy.ABANDON,
      });
    } catch (error) {
      // Started by an earlier sweep that died before recording it — still ours.
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
    startedFor.push({ taskId, workflowId });
  }

  await markEscalationStarted({ tasks: startedFor });
  return { started: startedFor.length };
}
