/**
 * Rollover in (GitHub #10, functional spec §5.3). An unwon jackpot is rolled
 * forward by `settleDraw` into the rollover account and recorded as that
 * draw's `rollover_out_pence`; the next draw to run starts from it. Before
 * this existed DrawWorkflow started every draw from zero, so after a no-winner
 * draw the next jackpot fell straight back to the floor and the rollover
 * appeared to vanish.
 *
 * "The previous draw" is the most recent settled draw ordered before this one
 * (draw time, then date, then number) — the same figure the member portal
 * already shows as the estimated jackpot. Draws are expected to be run in
 * order; a draw run while an earlier one is still unsettled (e.g. blocked on
 * GAP-24) would start from the draw before that instead.
 */
import type { Pool } from '@qosfc/db';

export interface GetRolloverInRequest {
  readonly drawId: string;
}

export interface GetRolloverInResult {
  /** Pence crosses the Temporal wire as a string — bigint isn't JSON-serialisable. */
  readonly rolloverInPence: string;
  readonly fromDrawId: string | null;
}

export async function getRolloverIn(pool: Pool, request: GetRolloverInRequest): Promise<GetRolloverInResult> {
  const { rows: thisRows } = await pool.query<{ draw_at: Date | null; draw_date: string; draw_number: number }>(
    `SELECT draw_at, draw_date::text AS draw_date, draw_number FROM draw WHERE id = $1`,
    [request.drawId],
  );
  const current = thisRows[0];
  if (!current) throw new Error(`Draw ${request.drawId} does not exist.`);

  const { rows } = await pool.query<{ id: string; rollover_out_pence: bigint | null }>(
    `SELECT id, rollover_out_pence
       FROM draw
      WHERE status = 'settled' AND id <> $1
        AND (COALESCE(draw_at, draw_date::timestamptz), draw_date, draw_number)
          < (COALESCE($2::timestamptz, $3::date::timestamptz), $3::date, $4)
      ORDER BY COALESCE(draw_at, draw_date::timestamptz) DESC, draw_date DESC, draw_number DESC
      LIMIT 1`,
    [request.drawId, current.draw_at, current.draw_date, current.draw_number],
  );
  const previous = rows[0];
  return {
    rolloverInPence: (previous?.rollover_out_pence ?? 0n).toString(),
    fromDrawId: previous?.id ?? null,
  };
}
