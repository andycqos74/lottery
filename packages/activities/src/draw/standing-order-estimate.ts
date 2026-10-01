/**
 * Expected standing-order entries for draws that haven't been run yet.
 *
 * A standing order's money only becomes entries once a bank statement is
 * imported and matched (prepaid blocks, GAP-17) — and then it is placed in
 * the upcoming draws straight away (`allocateUpcomingEntries`). Money not yet
 * received can't be an entry, but a draw's jackpot should still reflect the
 * standing orders that will normally have paid by the time it runs. This is
 * that estimate: an ESTIMATE for the jackpot figure only, never an entry.
 *
 * Per FR-4.2 a standing order is worth (annual amount ÷ £2) entries a year,
 * spread over 52 weekly draws (GAP-16: draws are weekly). Each draw's
 * estimate is the sum of that weekly density over active standing orders
 * covering the draw's date whose member is not already entered in it (so
 * money that has arrived is never counted twice), rounded down.
 *
 * Source: `subscription` rows with a standing-order or Giro payment method
 * (or none recorded). Until the legacy register is imported into
 * `subscription` (GAP-04, future-phase work) there are none, and the
 * estimate is zero.
 */
import type { Pool } from '@qosfc/db';
import { TICKET_PRICE_PENCE } from '@qosfc/domain';

export async function estimateStandingOrderEntries(pool: Pool, drawIds: readonly string[]): Promise<Map<string, number>> {
  const estimates = new Map<string, number>(drawIds.map((id) => [id, 0]));
  if (drawIds.length === 0) return estimates;

  const { rows } = await pool.query<{ draw_id: string; expected: string }>(
    `WITH standing_order AS (
       SELECT s.member_id, s.start_date, s.end_date,
              floor(COALESCE(s.annual_basis_pence,
                             s.amount_pence * CASE s.frequency WHEN 'weekly' THEN 52 WHEN 'fortnightly' THEN 26
                                                               WHEN 'monthly' THEN 12 WHEN 'quarterly' THEN 4
                                                               WHEN '6monthly' THEN 2 ELSE 1 END) / $2::numeric) AS entries_per_year
         FROM subscription s
         LEFT JOIN payment_method pm ON pm.id = s.payment_method_id
        WHERE s.status = 'active' AND (pm.id IS NULL OR pm.type IN ('standing_order', 'giro'))
     )
     SELECT d.id AS draw_id, floor(COALESCE(sum(so.entries_per_year) / 52.0, 0))::text AS expected
       FROM draw d
       LEFT JOIN standing_order so
         ON so.start_date <= d.draw_date AND (so.end_date IS NULL OR so.end_date >= d.draw_date)
        AND NOT EXISTS (SELECT 1 FROM entry e WHERE e.draw_id = d.id AND e.member_id = so.member_id AND e.voided_at IS NULL)
      WHERE d.id = ANY($1::uuid[]) AND d.status = 'open'
      GROUP BY d.id`,
    [drawIds, TICKET_PRICE_PENCE.toString()],
  );
  for (const row of rows) estimates.set(row.draw_id, Number(row.expected));
  return estimates;
}
