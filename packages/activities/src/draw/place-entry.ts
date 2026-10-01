/**
 * The one way a funded entry is written. Keyed `<drawId>:<prizeDrawNo>:1`
 * (T-8.2), so a retry can never enter the same number twice in a draw. If
 * an entry with that key was voided (db/migrations/0017 — e.g. a cancelled
 * Direct Debit), it is revived with the new funding and numbers rather than
 * silently blocking the number from that draw forever.
 */
import type { PoolClient } from 'pg';

export type EntryFunding = 'prepaid' | 'direct_debit';

export async function placeEntry(
  client: PoolClient,
  entry: { drawId: string; memberId: string; prizeDrawNo: number; selection: readonly number[]; stakePence: bigint; funding: EntryFunding },
): Promise<boolean> {
  const { rows } = await client.query(
    `INSERT INTO entry (draw_id, member_id, prize_draw_no, selection, stake_pence, funding_source, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (idempotency_key) DO UPDATE
       SET member_id = EXCLUDED.member_id, selection = EXCLUDED.selection, funding_source = EXCLUDED.funding_source,
           stake_pence = EXCLUDED.stake_pence, voided_at = NULL, void_reason = NULL
       WHERE entry.voided_at IS NOT NULL
     RETURNING id`,
    [entry.drawId, entry.memberId, entry.prizeDrawNo, entry.selection, entry.stakePence, entry.funding, `${entry.drawId}:${entry.prizeDrawNo}:1`],
  );
  return rows.length > 0;
}

/** Draws a member can still be entered into: open, entries not yet closed. Soonest first. */
export const ON_SALE_DRAWS_SQL = `
  SELECT id FROM draw
   WHERE status = 'open' AND (entries_close_at IS NULL OR entries_close_at > now())
   ORDER BY COALESCE(draw_at, draw_date::timestamptz), draw_number`;
