/**
 * Online entry purchase (GAP-09, GAP-04) — "play online".
 *
 * GAP-09 (the real card acquirer) is unresolved, so this runs against the
 * sandbox `PaymentGateway` as a dummy transaction simulator: a real hosted
 * session, a real async webhook-shaped round trip, real declines — just not a
 * real bank. Swapping in a live acquirer later is a `PAYMENT_GATEWAY` env var
 * change (`providers.ts`), not a change to this file.
 *
 * Mirrors `apps/admin/src/db.ts`'s `addEntry`: a fresh `prize_draw_no` is
 * minted for the entry (the legacy number concept does not apply to a member
 * who joined through the portal), and the same GAP-17 bypass applies — this
 * is a direct, one-off paid entry, not a subscription-funded one.
 */
import { withTransaction, type Pool } from '@qosfc/db';
import { idempotencyKey, type PaymentGateway } from '@qosfc/ports';
import { TICKET_PRICE_PENCE } from '@qosfc/domain';
import { getOpenDraw } from './db.js';

export type StartPurchaseOutcome =
  | { readonly kind: 'started'; readonly redirectUrl: string; readonly sessionId: string }
  | { readonly kind: 'rejected'; readonly reason: string };

export async function startEntryPurchase(
  pool: Pool,
  gateway: PaymentGateway,
  input: { memberId: string; selection: readonly number[]; returnUrl: string; cancelUrl: string },
): Promise<StartPurchaseOutcome> {
  const selection = [...new Set(input.selection)].sort((a, b) => a - b);
  if (selection.length !== 4 || selection.some((n) => n < 1 || n > 20)) {
    return { kind: 'rejected', reason: 'A selection must be four distinct numbers between 1 and 20.' };
  }

  const draw = await getOpenDraw(pool);
  if (!draw) {
    return { kind: 'rejected', reason: 'No draw is currently open for entries.' };
  }

  const amountPence = TICKET_PRICE_PENCE.toString();
  const session = await gateway.createHostedSession({
    idempotencyKey: idempotencyKey(`entry-purchase:${input.memberId}:${draw.id}:${selection.join('-')}`),
    amountPence,
    currency: 'GBP',
    // An identifier only — never a member name (T-1.3).
    reference: `entry:${input.memberId}:${draw.id}`,
    returnUrl: input.returnUrl,
    cancelUrl: input.cancelUrl,
  });

  await pool.query(
    `INSERT INTO pending_entry_purchase (session_id, member_id, draw_id, selection, amount_pence)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (session_id) DO NOTHING`,
    [session.sessionId, input.memberId, draw.id, selection, amountPence],
  );

  return { kind: 'started', redirectUrl: session.redirectUrl, sessionId: session.sessionId };
}

export type CompletePurchaseOutcome =
  | { readonly kind: 'entry_created'; readonly entryId: string }
  | { readonly kind: 'already_completed'; readonly entryId: string }
  | { readonly kind: 'payment_failed'; readonly reason: string }
  | { readonly kind: 'pending' }
  | { readonly kind: 'not_found' };

/**
 * Called from the member's return-from-redirect request AND independently
 * from the sandbox's webhook (once wired) — a browser that never comes back
 * must not lose a payment. Idempotent: a session already resolved returns
 * what actually happened rather than acting twice.
 */
export async function completeEntryPurchase(
  pool: Pool,
  gateway: PaymentGateway,
  sessionId: string,
): Promise<CompletePurchaseOutcome> {
  const { rows } = await pool.query<{
    member_id: string;
    draw_id: string;
    selection: number[];
    amount_pence: string;
    status: string;
    entry_id: string | null;
  }>(`SELECT member_id, draw_id, selection, amount_pence, status, entry_id FROM pending_entry_purchase WHERE session_id = $1`, [
    sessionId,
  ]);
  const pending = rows[0];
  if (!pending) return { kind: 'not_found' };
  if (pending.status === 'completed') return { kind: 'already_completed', entryId: pending.entry_id! };
  if (pending.status === 'failed') return { kind: 'payment_failed', reason: 'Payment was not successful.' };

  const outcome = await gateway.getPaymentStatus(sessionId);
  if (outcome.status === 'pending') return { kind: 'pending' };
  if (outcome.status === 'failed') {
    await pool.query(`UPDATE pending_entry_purchase SET status = 'failed' WHERE session_id = $1`, [sessionId]);
    return { kind: 'payment_failed', reason: outcome.reason };
  }

  return withTransaction(pool, async (client) => {
    // Re-check under the transaction: the webhook and the return request can race.
    const { rows: recheck } = await client.query<{ status: string; entry_id: string | null }>(
      `SELECT status, entry_id FROM pending_entry_purchase WHERE session_id = $1 FOR UPDATE`,
      [sessionId],
    );
    const current = recheck[0]!;
    if (current.status === 'completed') return { kind: 'already_completed', entryId: current.entry_id! };

    const { rows: drawRows } = await client.query<{ status: string }>(`SELECT status FROM draw WHERE id = $1`, [pending.draw_id]);
    if (drawRows[0]?.status !== 'open') {
      await client.query(`UPDATE pending_entry_purchase SET status = 'failed' WHERE session_id = $1`, [sessionId]);
      return { kind: 'payment_failed', reason: 'The draw closed before this payment completed. Contact QOSFC for a refund.' };
    }

    const { rows: nextNoRows } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(prize_draw_no), 99999) + 1 AS next FROM member_number`,
    );
    const prizeDrawNo = nextNoRows[0]!.next;
    await client.query(`INSERT INTO member_number (prize_draw_no, member_id, row_type) VALUES ($1, $2, 'member')`, [
      prizeDrawNo,
      pending.member_id,
    ]);

    const { rows: entryRows } = await client.query<{ id: string }>(
      `INSERT INTO entry (draw_id, member_id, prize_draw_no, selection, stake_pence, funding_source, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,'card',$6)
       RETURNING id`,
      [pending.draw_id, pending.member_id, prizeDrawNo, pending.selection, pending.amount_pence, `entry-purchase:${sessionId}`],
    );
    const entryId = entryRows[0]!.id;

    await client.query(
      `INSERT INTO payment (member_id, channel, received_date, amount_pence, status, idempotency_key)
       VALUES ($1,'card',CURRENT_DATE,$2,'allocated',$3)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [pending.member_id, pending.amount_pence, `entry-purchase:${sessionId}`],
    );

    await client.query(`UPDATE pending_entry_purchase SET status = 'completed', entry_id = $2 WHERE session_id = $1`, [
      sessionId,
      entryId,
    ]);

    return { kind: 'entry_created', entryId };
  });
}

