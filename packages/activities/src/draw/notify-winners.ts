/**
 * Winner notification — GAP-30 (email). `settleDraw` leaves every winning
 * share as a `prize` row with `status = 'pending_notification'`; this picks
 * those up for one draw and tells each winner.
 *
 * Idempotent per prize (T-8.2's convention for anything money-adjacent — the
 * idempotency key is derived from `prize.id`, never generated at call time),
 * so a retried activity or a re-run after a partial failure only resends to
 * whoever is still `pending_notification`.
 *
 * A REJECTED send (no email on file, address bounced at submission) is a
 * real business outcome, not a fault: GAP-46 (notification retry/abandonment
 * policy) is unresolved, so this leaves that prize exactly as `settleDraw`
 * left it — `pending_notification` — for a human to eventually notice,
 * rather than either silently marking an untold winner as told or inventing
 * a retry policy nobody has decided. A THROWN provider error (network,
 * misconfigured credentials) is different: that is Temporal's own activity
 * retry's job, so it propagates rather than being swallowed here.
 */
import type { Pool } from '@qosfc/db';
import { formatPence, pence } from '@qosfc/domain';
import { idempotencyKey, type Notifier } from '@qosfc/ports';

export interface NotifyWinnersRequest {
  readonly drawId: string;
  readonly drawNumber: number;
}

export interface NotifyWinnersResult {
  readonly notified: number;
  readonly pending: number;
}

export async function notifyWinners(pool: Pool, notifier: Notifier, request: NotifyWinnersRequest): Promise<NotifyWinnersResult> {
  const { rows } = await pool.query<{ id: string; member_id: string; amount_pence: string }>(
    `SELECT id, member_id, amount_pence FROM prize WHERE draw_id = $1 AND status = 'pending_notification'`,
    [request.drawId],
  );

  let notified = 0;
  for (const row of rows) {
    const outcome = await notifier.send({
      idempotencyKey: idempotencyKey(`prize_notification:${row.id}`),
      memberRef: row.member_id,
      channel: 'email',
      templateId: 'draw_winner',
      mergeData: {
        drawNumber: String(request.drawNumber),
        amount: formatPence(pence(BigInt(row.amount_pence))),
      },
    });

    if (outcome.status === 'accepted') {
      await pool.query(`UPDATE prize SET status = 'notified', notified_at = now() WHERE id = $1`, [row.id]);
      notified++;
    }
  }

  return { notified, pending: rows.length - notified };
}
