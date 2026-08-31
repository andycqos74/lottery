/**
 * Delivering a resolved human task's decision to the Temporal workflow it was
 * blocking (B-9, gap-register.md) — never the Temporal Web UI, per the same
 * reasoning that put the task inbox here instead: a volunteer treasurer must
 * not be asked to send a raw signal from a developer tool.
 *
 * Scoped to the ONE signal kind that exists today (`must_be_won_decision`). A
 * generic `payload_schema`-driven delivery mechanism for hypothetical future
 * task kinds is deliberately out of scope — this warns and skips rather than
 * guessing a payload shape it can't construct.
 */
import { createClient, connectionConfigFromEnv } from '@qosfc/temporal-common';
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
  if (task.signalName !== 'must_be_won_decision') {
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
      await client.workflow.getHandle(task.workflowId, task.runId ?? undefined).signal(task.signalName, {
        mechanism: input.mechanism,
        decidedBy: input.decidedBy,
        secondApproverId: input.secondApproverId,
        note: input.note,
      });
    } finally {
      client.connection.close();
    }
    return { kind: 'delivered' };
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Starts a real DrawWorkflow execution. A stable `draw-<id>` workflow ID means
 * a double-submitted "run" click hits Temporal's already-exists error rather
 * than silently starting a second execution for the same draw.
 */
export async function startDrawWorkflow(input: {
  readonly drawId: string;
  readonly drawNumber: number;
  readonly entriesCount: number;
}): Promise<{ readonly workflowId: string }> {
  const client = await createClient(connectionConfigFromEnv());
  try {
    const handle = await client.workflow.start('DrawWorkflow', {
      taskQueue: 'draw',
      workflowId: `draw-${input.drawId}`,
      args: [{ drawId: input.drawId, drawNumber: input.drawNumber, entriesCount: input.entriesCount }],
      workflowExecutionTimeout: '15 minutes',
    });
    return { workflowId: handle.workflowId };
  } finally {
    client.connection.close();
  }
}
