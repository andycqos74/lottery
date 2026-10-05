/**
 * The draw's lifecycle around `DrawWorkflow`: which draws are due, freezing a
 * draw's entry set when its run starts, and whether a run has finished — the
 * I/O behind the scheduled dispatcher and the watchdog (GAP-16).
 *
 * Draws are materialised up front, one row each with an exact `draw_at`
 * (0015), so "due" is a property of the row, not of a cron expression: the
 * dispatcher asks the database rather than knowing the schedule itself.
 */
import { withTransaction, type Pool } from '@qosfc/db';
import { writeAudit } from '../audit.js';

export interface DueDraw {
  readonly drawId: string;
  readonly drawNumber: number;
}

export interface FindDueDrawsResult {
  readonly draws: readonly DueDraw[];
}

/**
 * Open draws whose draw time has passed. A draw with no `draw_at` (created
 * before 0015) is never due — it has no time to be due at, so it still needs a
 * human to run it.
 */
export async function findDueDraws(pool: Pool): Promise<FindDueDrawsResult> {
  const { rows } = await pool.query<{ id: string; draw_number: number }>(
    `SELECT id, draw_number FROM draw
      WHERE status = 'open' AND draw_at IS NOT NULL AND draw_at <= now()
      ORDER BY draw_at, draw_number`,
  );
  return { draws: rows.map((r) => ({ drawId: r.id, drawNumber: r.draw_number })) };
}

export interface CloseDrawForRunRequest {
  readonly drawId: string;
  readonly workflowId: string;
}

export interface CloseDrawForRunResult {
  readonly entriesCount: number;
}

/**
 * Freeze the entry set (FR-5.3.3): status 'open' → 'closed', recording the
 * count the jackpot arithmetic is computed from and the run that owns it.
 *
 * Idempotent: a retry after the commit landed finds the draw already closed by
 * this same workflow and returns the count it froze, rather than recounting.
 * A draw closed by a DIFFERENT run is refused — two runs of one draw is
 * exactly what the business-key workflow ID exists to prevent.
 */
export async function closeDrawForRun(pool: Pool, request: CloseDrawForRunRequest): Promise<CloseDrawForRunResult> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: string; workflow_id: string | null; entries_count: number | null }>(
      `SELECT status, workflow_id, entries_count FROM draw WHERE id = $1 FOR UPDATE`,
      [request.drawId],
    );
    const draw = rows[0];
    if (!draw) throw new Error(`Draw ${request.drawId} does not exist.`);

    if (draw.status !== 'open') {
      if (draw.workflow_id === request.workflowId && draw.entries_count !== null) {
        return { entriesCount: draw.entries_count };
      }
      throw new Error(
        `Draw ${request.drawId} is '${draw.status}' and owned by run ${draw.workflow_id ?? '(none)'}, not ${request.workflowId}.`,
      );
    }

    const counted = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM entry WHERE draw_id = $1 AND voided_at IS NULL`,
      [request.drawId],
    );
    const entriesCount = Number(counted.rows[0]!.n);

    await client.query(`UPDATE draw SET status = 'closed', workflow_id = $2, entries_count = $3 WHERE id = $1`, [
      request.drawId,
      request.workflowId,
      entriesCount,
    ]);
    await writeAudit(client, {
      actorLabel: 'system',
      action: 'draw.closed',
      entity: 'draw',
      entityId: request.drawId,
      after: { entriesCount },
      workflowId: request.workflowId,
    });
    return { entriesCount };
  });
}

export interface CheckDrawProgressRequest {
  readonly drawId: string;
}

export interface CheckDrawProgressResult {
  readonly status: string;
  /** An open human task about this draw — the run is parked by design, and that task has its own escalation. */
  readonly openTaskId: string | null;
}

export async function checkDrawProgress(pool: Pool, request: CheckDrawProgressRequest): Promise<CheckDrawProgressResult> {
  const { rows } = await pool.query<{ status: string; open_task_id: string | null }>(
    `SELECT d.status,
            (SELECT t.id FROM human_task t
              WHERE t.entity_type = 'draw' AND t.entity_id = d.id AND t.status = 'open'
                AND t.kind <> 'draw_overdue'
              ORDER BY t.opened_at LIMIT 1) AS open_task_id
       FROM draw d WHERE d.id = $1`,
    [request.drawId],
  );
  const row = rows[0];
  if (!row) throw new Error(`Draw ${request.drawId} does not exist.`);
  return { status: row.status, openTaskId: row.open_task_id };
}
