/**
 * Delivering a resolved human task's decision to the Temporal workflow it was
 * blocking (B-9, gap-register.md) — never the Temporal Web UI, per the same
 * reasoning that put the task inbox here instead: a volunteer treasurer must
 * not be asked to send a raw signal from a developer tool.
 *
 * Scoped to the signal kinds that exist today: `must_be_won_decision` (GAP-24,
 * two approvers) and `retry_draw` (entries failed to generate; no payload). A
 * generic `payload_schema`-driven delivery mechanism for hypothetical future
 * task kinds is deliberately out of scope — this warns and skips rather than
 * guessing a payload shape it can't construct.
 */
import { createClient, connectionConfigFromEnv, workflowIds } from '@qosfc/temporal-common';
import type { HumanTask } from './db.js';

export interface MustBeWonDeliveryInput {
  readonly decidedBy: string;
  readonly secondApproverId: string;
  readonly mechanism: string;
  readonly note: string;
}

export type DeliverDecisionResult =
  | { readonly kind: 'delivered' }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

export async function deliverTaskDecision(task: HumanTask, input: MustBeWonDeliveryInput): Promise<DeliverDecisionResult> {
  if (!task.workflowId) {
    return { kind: 'skipped', reason: 'Task carries no workflow_id — nothing to signal.' };
  }
  if (task.signalName !== 'must_be_won_decision' && task.signalName !== 'retry_draw') {
    const named = task.signalName ?? task.updateName;
    return {
      kind: 'skipped',
      reason: named
        ? `No delivery logic exists yet for "${named}".`
        : 'Task carries no signal or update name.',
    };
  }

  try {
    const client = await createClient(connectionConfigFromEnv());
    try {
      const handle = client.workflow.getHandle(task.workflowId, task.runId ?? undefined);
      if (task.signalName === 'retry_draw') {
        await handle.signal(task.signalName);
      } else {
        await handle.signal(task.signalName, {
          mechanism: input.mechanism,
          decidedBy: input.decidedBy,
          secondApproverId: input.secondApproverId,
          note: input.note,
        });
      }
    } finally {
      client.connection.close();
    }
    return { kind: 'delivered' };
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Tells a resolved task's EscalationWorkflow to stop now rather than at its
 * next wake-up. Best effort: the workflow re-reads the task before every
 * escalation anyway, and a task the sweep has not reached yet has no workflow.
 */
export async function notifyEscalationTaskClosed(taskId: string): Promise<void> {
  const client = await createClient(connectionConfigFromEnv());
  try {
    await client.workflow.getHandle(workflowIds.escalation(taskId)).signal('task_closed');
  } catch (error) {
    // By name: this app reaches Temporal only through @qosfc/temporal-common.
    if (!(error instanceof Error && error.name === 'WorkflowNotFoundError')) throw error;
  } finally {
    client.connection.close();
  }
}

/**
 * Starts a real DrawWorkflow execution — the manual counterpart of the
 * scheduled dispatcher, using the same `draw-<id>` workflow ID, so a
 * double-submitted "run" click, or a click racing the dispatcher, hits
 * Temporal's already-exists error rather than starting a second execution.
 *
 * The workflow generates the due entries and closes the draw itself. No
 * execution timeout: the run may wait indefinitely on a human task (FR-5.4),
 * and the task's escalation is what keeps that wait visible.
 */
export async function startDrawWorkflow(input: {
  readonly drawId: string;
  readonly drawNumber: number;
}): Promise<{ readonly workflowId: string }> {
  const client = await createClient(connectionConfigFromEnv());
  try {
    const handle = await client.workflow.start('DrawWorkflow', {
      taskQueue: 'draw',
      workflowId: workflowIds.draw(input.drawId),
      args: [{ drawId: input.drawId, drawNumber: input.drawNumber }],
    });
    return { workflowId: handle.workflowId };
  } finally {
    client.connection.close();
  }
}
