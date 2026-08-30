/**
 * The human task inbox (FR-5.3, GAP-43).
 *
 * "Every process that waits for a human blocks visibly. A blocked process appears
 * in the administrator's task inbox with: what it is waiting for, since when,
 * what it will do if nobody responds, and who can respond. Nothing waits
 * silently."
 *
 * Deliberately a database table rendered by the admin console, never the Temporal
 * Web UI — a volunteer treasurer must not be asked to send a raw signal from a
 * developer tool to release a stuck prize payment.
 */
import { withTransaction, type Pool } from '@qosfc/db';
import { writeAudit } from '../audit.js';

export interface OpenTaskRequest {
  readonly kind: string;
  /** Business language, not developer language. The treasurer reads this. */
  readonly title: string;
  readonly detail: string;
  /** FR-5.3: what happens if nobody responds. */
  readonly consequenceIfIgnored: string;
  /** Set when the task exists because a rule is undecided, e.g. 'GAP-24'. */
  readonly gapId?: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly workflowId?: string;
  readonly runId?: string;
  /** How the admin console unblocks the process. */
  readonly signalName?: string;
  readonly updateName?: string;
  /** Zod-derived JSON schema: what the human must supply. Drives the form. */
  readonly payloadSchema?: unknown;
  readonly dueAt?: Date;
  /** GAP-44: two distinct humans, for anything like a £20,000 payout. */
  readonly requiresSecondApprover?: boolean;
  /**
   * Idempotency. A retried activity must not flood the inbox with duplicates of
   * the same decision, so one OPEN task per dedupe key (enforced by a partial
   * unique index, not by a SELECT-then-INSERT race).
   */
  readonly dedupeKey: string;
}

export interface OpenTaskResult {
  readonly taskId: string;
  readonly created: boolean;
}

export async function openHumanTask(pool: Pool, request: OpenTaskRequest): Promise<OpenTaskResult> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO human_task
         (kind, title, detail, consequence_if_ignored, gap_id, entity_type, entity_id,
          workflow_id, run_id, signal_name, update_name, payload_schema, due_at,
          requires_second_approver, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (dedupe_key) WHERE status = 'open' DO NOTHING
       RETURNING id`,
      [
        request.kind,
        request.title,
        request.detail,
        request.consequenceIfIgnored,
        request.gapId ?? null,
        request.entityType ?? null,
        request.entityId ?? null,
        request.workflowId ?? null,
        request.runId ?? null,
        request.signalName ?? null,
        request.updateName ?? null,
        JSON.stringify(request.payloadSchema ?? {}),
        request.dueAt ?? null,
        request.requiresSecondApprover ?? false,
        request.dedupeKey,
      ],
    );

    if (rows.length > 0) {
      await writeAudit(client, {
        actorLabel: 'system',
        action: 'human_task.opened',
        entity: 'human_task',
        entityId: rows[0]!.id,
        after: { kind: request.kind, title: request.title, gapId: request.gapId },
        ...(request.workflowId ? { workflowId: request.workflowId } : {}),
        ...(request.runId ? { runId: request.runId } : {}),
      });
      return { taskId: rows[0]!.id, created: true };
    }

    // The task already exists and is open — a retry, not a new decision.
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM human_task WHERE dedupe_key = $1 AND status = 'open'`,
      [request.dedupeKey],
    );
    return { taskId: existing.rows[0]!.id, created: false };
  });
}
