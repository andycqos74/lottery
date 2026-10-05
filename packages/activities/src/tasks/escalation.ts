/**
 * Escalation of open human tasks (FR-5.6, GAP-42).
 *
 * "Nothing waits silently": a process may block for a human indefinitely
 * (FR-5.4) only because each open task has an `EscalationWorkflow` that
 * raises it again every time it goes overdue.
 *
 * GAP-42 ⛔ — there is no escalation policy and no named on-call. So the
 * cadence below is a visibility default, not a decided policy, and escalating
 * means a louder inbox (level, last escalated, sort order) and an audit_log
 * row — never a message to someone the code has guessed should receive it.
 */
import { withTransaction, type Pool } from '@qosfc/db';
import { writeAudit } from '../audit.js';

/**
 * GAP-42 placeholder: a task with no `due_at` first goes overdue this long
 * after it opened, and escalates again this long after each escalation.
 */
export const ESCALATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ListTasksAwaitingEscalationRequest {
  readonly limit?: number;
}

export interface ListTasksAwaitingEscalationResult {
  readonly taskIds: readonly string[];
}

/** Open tasks that have no escalation workflow yet — from any origin, workflow or admin console. */
export async function listTasksAwaitingEscalation(
  pool: Pool,
  request: ListTasksAwaitingEscalationRequest,
): Promise<ListTasksAwaitingEscalationResult> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM human_task
      WHERE status = 'open' AND escalation_workflow_id IS NULL
      ORDER BY opened_at LIMIT $1`,
    [request.limit ?? 200],
  );
  return { taskIds: rows.map((r) => r.id) };
}

export interface MarkEscalationStartedRequest {
  readonly tasks: readonly { readonly taskId: string; readonly workflowId: string }[];
}

export async function markEscalationStarted(pool: Pool, request: MarkEscalationStartedRequest): Promise<void> {
  if (request.tasks.length === 0) return;
  await pool.query(
    `UPDATE human_task t SET escalation_workflow_id = m.workflow_id
       FROM unnest($1::uuid[], $2::text[]) AS m(task_id, workflow_id)
      WHERE t.id = m.task_id AND t.escalation_workflow_id IS NULL`,
    [request.tasks.map((t) => t.taskId), request.tasks.map((t) => t.workflowId)],
  );
}

export interface GetTaskEscalationStateRequest {
  readonly taskId: string;
}

export interface TaskEscalationState {
  readonly status: string;
  readonly escalationLevel: number;
  /**
   * How long until the task is next overdue: `due_at` (or opened + interval)
   * before the first escalation, last escalation + interval after it. Zero
   * when already overdue. Computed here, not in the workflow, because workflow
   * code reads no clock (T-6.2) — the activity result is in history, so replay
   * sees the same number.
   */
  readonly msUntilOverdue: number;
}

export async function getTaskEscalationState(pool: Pool, request: GetTaskEscalationStateRequest): Promise<TaskEscalationState> {
  const { rows } = await pool.query<{ status: string; escalation_level: number; ms_until_overdue: string }>(
    `SELECT status, escalation_level,
            GREATEST(0, EXTRACT(EPOCH FROM (
              CASE WHEN last_escalated_at IS NOT NULL
                   THEN last_escalated_at + make_interval(secs => $2 / 1000.0)
                   ELSE COALESCE(due_at, opened_at + make_interval(secs => $2 / 1000.0))
              END - now())) * 1000)::bigint::text AS ms_until_overdue
       FROM human_task WHERE id = $1`,
    [request.taskId, ESCALATION_INTERVAL_MS],
  );
  const row = rows[0];
  if (!row) throw new Error(`Human task ${request.taskId} does not exist.`);
  return { status: row.status, escalationLevel: row.escalation_level, msUntilOverdue: Number(row.ms_until_overdue) };
}

export interface EscalateTaskRequest {
  readonly taskId: string;
  /** The level the workflow last saw — makes a retried activity a no-op rather than a double escalation. */
  readonly fromLevel: number;
  readonly workflowId: string;
}

export interface EscalateTaskResult {
  /** False when the task closed, or was already escalated past `fromLevel`, in the meantime. */
  readonly escalated: boolean;
  readonly escalationLevel: number;
}

export async function escalateTask(pool: Pool, request: EscalateTaskRequest): Promise<EscalateTaskResult> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ escalation_level: number; title: string; kind: string }>(
      `UPDATE human_task SET escalation_level = escalation_level + 1, last_escalated_at = now()
        WHERE id = $1 AND status = 'open' AND escalation_level = $2
        RETURNING escalation_level, title, kind`,
      [request.taskId, request.fromLevel],
    );
    const row = rows[0];
    if (!row) {
      const current = await client.query<{ escalation_level: number }>(
        `SELECT escalation_level FROM human_task WHERE id = $1`,
        [request.taskId],
      );
      return { escalated: false, escalationLevel: current.rows[0]?.escalation_level ?? request.fromLevel };
    }

    await writeAudit(client, {
      actorLabel: 'system',
      action: 'human_task.escalated',
      entity: 'human_task',
      entityId: request.taskId,
      before: { escalationLevel: request.fromLevel },
      after: { escalationLevel: row.escalation_level, kind: row.kind, gapId: 'GAP-42' },
      workflowId: request.workflowId,
    });
    return { escalated: true, escalationLevel: row.escalation_level };
  });
}
