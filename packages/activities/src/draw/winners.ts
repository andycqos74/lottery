/**
 * Winner identification — Phase 6 (functional spec §5.3, technical spec §5.1).
 *
 * Read-only: matches the frozen entry set for a draw against its winning
 * numbers. Both `entry.selection` and `draw.winning_numbers` are stored sorted
 * ascending (`selection_is_four_distinct_sorted`, `entry_draw_selection_idx`),
 * so plain array equality is a correct, order-independent match and hits the
 * existing (draw_id, selection) index directly.
 *
 * Pure read, so naturally idempotent: safe to call again on activity retry or
 * workflow replay without any special-casing.
 */
import type { Pool } from '@qosfc/db';
import type { WinningEntry } from '@qosfc/domain';

export interface IdentifyWinnersRequest {
  readonly drawId: string;
}

export interface IdentifyWinnersResult {
  readonly winningEntries: readonly WinningEntry[];
}

export async function identifyWinners(pool: Pool, request: IdentifyWinnersRequest): Promise<IdentifyWinnersResult> {
  const { rows: drawRows } = await pool.query<{ winning_numbers: number[] | null }>(
    `SELECT winning_numbers FROM draw WHERE id = $1`,
    [request.drawId],
  );
  const draw = drawRows[0];
  if (!draw) throw new Error(`Draw ${request.drawId} does not exist.`);
  if (!draw.winning_numbers) {
    throw new Error(`Draw ${request.drawId} has no winning numbers yet — numbers must be generated first.`);
  }

  const { rows } = await pool.query<{ entry_id: string; member_id: string }>(
    `SELECT id AS entry_id, member_id FROM entry WHERE draw_id = $1 AND selection = $2::int[]`,
    [request.drawId, draw.winning_numbers],
  );

  return { winningEntries: rows.map((r) => ({ entryId: r.entry_id, memberId: r.member_id })) };
}
