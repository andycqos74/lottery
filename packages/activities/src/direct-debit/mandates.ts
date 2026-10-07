/**
 * A Direct Debit mandate's life on our side: confirmed by the bank, ended —
 * by the member, by staff, by the bank, or by us after a second failed
 * collection or a refund claim — and cancelled with the bureau.
 *
 * Every ending goes through `endDirectDebit`, so the rules hold whichever way
 * it happens: scheduled collections are called off, and the line's Direct
 * Debit entries in draws still taking entries are withdrawn — except entries
 * a collection has already paid for (or is collecting for), which stay.
 *
 * Only the worker talks to the bureau. Ending a mandate here just flags it
 * (`bureau_cancel_pending`); `cancelMandatesAtBureau` does the call on the
 * Direct Debit workflow's next run, and keeps retrying until it succeeds.
 */
import { withTransaction, type Pool } from '@qosfc/db';
import type { PoolClient } from 'pg';
import { idempotencyKey, type BacsBureau } from '@qosfc/ports';
import { writeAudit } from '../audit.js';
import { allocateUpcomingEntries } from '../draw/allocate-upcoming.js';
import { ON_SALE_DRAWS_SQL } from '../draw/place-entry.js';

export type DirectDebitEndReason =
  | 'member_cancelled'
  | 'admin_cancelled'
  | 'payer_cancelled_at_bank'
  | 'mandate_failed'
  | 'collection_failed'
  | 'refund_claim';

/** Raised with the bank by us — the others already came from the bank. */
const CANCEL_AT_BUREAU: ReadonlySet<DirectDebitEndReason> = new Set(['member_cancelled', 'admin_cancelled', 'collection_failed', 'refund_claim']);

export interface EndDirectDebitRequest {
  readonly paymentMethodId: string;
  /** When given, the mandate must belong to this member (the portal's check). */
  readonly memberId?: string;
  readonly reason: DirectDebitEndReason;
  readonly actorLabel: string;
  readonly actorId?: string;
}

export interface EndDirectDebitResult {
  readonly ended: boolean;
  readonly entriesWithdrawn: number;
}

/**
 * Withdraws the line's Direct Debit entries from draws still taking entries,
 * leaving any a collection has paid for or is collecting for.
 */
export async function withdrawUncollectedEntries(
  client: PoolClient,
  line: { memberId: string; prizeDrawNo: number | null; slot: number | null },
  reason: string,
): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE entry SET voided_at = now(), void_reason = $4
      WHERE member_id = $1 AND funding_source = 'direct_debit' AND voided_at IS NULL
        AND ($2::int IS NULL OR (prize_draw_no = $2 AND selection_slot = $3))
        AND draw_id IN (${ON_SALE_DRAWS_SQL})
        AND NOT EXISTS (
              SELECT 1 FROM dd_collection_entry ce JOIN dd_collection c ON c.id = ce.collection_id
               WHERE ce.entry_id = entry.id AND c.status IN ('scheduled', 'submitted', 'collected'))`,
    [line.memberId, line.prizeDrawNo, line.slot, reason],
  );
  return rowCount ?? 0;
}

export async function endDirectDebit(pool: Pool, request: EndDirectDebitRequest): Promise<EndDirectDebitResult> {
  const result = await withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ member_id: string; line_prize_draw_no: number | null; line_slot: number | null; mandate_ref: string | null }>(
      `UPDATE payment_method
          SET active = false, mandate_status = $3, ended_at = now(), end_reason = $4,
              bureau_cancel_pending = $5 AND mandate_ref IS NOT NULL
        WHERE id = $1 AND type = 'direct_debit' AND active AND ($2::uuid IS NULL OR member_id = $2)
        RETURNING member_id, line_prize_draw_no, line_slot, mandate_ref`,
      [
        request.paymentMethodId,
        request.memberId ?? null,
        request.reason === 'mandate_failed' ? 'failed' : 'cancelled',
        request.reason,
        CANCEL_AT_BUREAU.has(request.reason),
      ],
    );
    const ended = rows[0];
    if (!ended) return undefined;

    const { rowCount: callsOff } = await client.query(
      `UPDATE dd_collection SET status = 'cancelled', updated_at = now() WHERE payment_method_id = $1 AND status = 'scheduled'`,
      [request.paymentMethodId],
    );
    const withdrawn = await withdrawUncollectedEntries(
      client,
      { memberId: ended.member_id, prizeDrawNo: ended.line_prize_draw_no, slot: ended.line_slot },
      'Direct Debit cancelled',
    );
    await writeAudit(client, {
      ...(request.actorId ? { actorId: request.actorId } : {}),
      actorLabel: request.actorLabel,
      action: 'direct_debit.ended',
      entity: 'payment_method',
      entityId: request.paymentMethodId,
      after: { reason: request.reason, mandateRef: ended.mandate_ref, collectionsCalledOff: callsOff ?? 0, entriesWithdrawn: withdrawn },
    });
    return { memberId: ended.member_id, withdrawn };
  });
  if (!result) return { ended: false, entriesWithdrawn: 0 };

  // Any paid weeks on the same numbers take the places just given up. The
  // ending is committed either way; each draw re-checks when it is run.
  await allocateUpcomingEntries(pool, { memberId: result.memberId, actorLabel: request.actorLabel }).catch(() => undefined);
  return { ended: true, entriesWithdrawn: result.withdrawn };
}

/** The bank confirmed the mandate: its line starts being entered, from now. */
export async function activateMandate(pool: Pool, mandateRef: string, actorLabel: string): Promise<{ readonly activated: boolean }> {
  const { rows } = await pool.query<{ id: string; member_id: string }>(
    `UPDATE payment_method SET mandate_status = 'active', mandate_active_at = COALESCE(mandate_active_at, now())
      WHERE mandate_ref = $1 AND type = 'direct_debit' AND active AND mandate_status IS DISTINCT FROM 'active'
      RETURNING id, member_id`,
    [mandateRef],
  );
  const pm = rows[0];
  if (!pm) return { activated: false };
  await allocateUpcomingEntries(pool, { memberId: pm.member_id, actorLabel });
  return { activated: true };
}

/** Cancels with the bureau every mandate ended here and not yet cancelled there. */
export async function cancelMandatesAtBureau(pool: Pool, bureau: BacsBureau): Promise<{ readonly cancelled: number }> {
  const { rows } = await pool.query<{ id: string; mandate_ref: string }>(
    `SELECT id, mandate_ref FROM payment_method WHERE bureau_cancel_pending AND mandate_ref IS NOT NULL ORDER BY ended_at LIMIT 200`,
  );
  for (const pm of rows) {
    await bureau.cancelMandate({ idempotencyKey: idempotencyKey(`dd-cancel:${pm.id}`), mandateRef: pm.mandate_ref });
    await pool.query(`UPDATE payment_method SET bureau_cancel_pending = false WHERE id = $1`, [pm.id]);
  }
  return { cancelled: rows.length };
}
