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
import type { MustBeWonMatchTiers, WinningEntry } from '@qosfc/domain';

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
    `SELECT id AS entry_id, member_id FROM entry WHERE draw_id = $1 AND selection = $2::int[] AND voided_at IS NULL`,
    [request.drawId, draw.winning_numbers],
  );

  return { winningEntries: rows.map((r) => ({ entryId: r.entry_id, memberId: r.member_id })) };
}

export interface CountRollDownTiersRequest {
  readonly drawId: string;
}

export interface CountRollDownTiersResult {
  readonly match3: number;
  readonly match2: number;
  readonly match1: number;
}

/**
 * How many entries sit at each rung of GAP-24's roll-down ladder. Counts, not
 * entries: match-1 can be most of the entry set, which is far too much to
 * carry through workflow history. `settleDraw` reads the tiers themselves
 * (`fetchRollDownTiers`) inside its own transaction — the entry set is frozen,
 * so it sees exactly what was counted here.
 */
export async function countRollDownTiers(pool: Pool, request: CountRollDownTiersRequest): Promise<CountRollDownTiersResult> {
  const tiers = await fetchRollDownTiers(pool, request.drawId);
  return { match3: tiers.match3.length, match2: tiers.match2.length, match1: tiers.match1.length };
}

/**
 * GAP-24's roll-down ladder: the entries matching exactly 3, 2 and 1 of the
 * drawn numbers. Only ever needed when the must-be-won cap is reached with no
 * match-4 winner — D4 still stands for the ordinary game, where matching 3 or
 * fewer pays nothing.
 *
 * Counts in SQL with the same rule as `countMatches` (@qosfc/domain): both
 * arrays hold four distinct numbers, so the size of their intersection is the
 * number matched. Read-only, so safe on retry and replay.
 */
export async function fetchRollDownTiers(db: Pick<Pool, 'query'>, drawId: string): Promise<MustBeWonMatchTiers> {
  const { rows: drawRows } = await db.query<{ winning_numbers: number[] | null }>(
    `SELECT winning_numbers FROM draw WHERE id = $1`,
    [drawId],
  );
  const draw = drawRows[0];
  if (!draw) throw new Error(`Draw ${drawId} does not exist.`);
  if (!draw.winning_numbers) {
    throw new Error(`Draw ${drawId} has no winning numbers yet — numbers must be generated first.`);
  }

  const { rows } = await db.query<{ entry_id: string; member_id: string; matched: number }>(
    `SELECT id AS entry_id, member_id,
            cardinality(ARRAY(SELECT unnest(selection) INTERSECT SELECT unnest($2::int[])))::int AS matched
       FROM entry
      WHERE draw_id = $1 AND voided_at IS NULL
      ORDER BY id`,
    [drawId, draw.winning_numbers],
  );

  const tier = (n: number): WinningEntry[] =>
    rows.filter((r) => r.matched === n).map((r) => ({ entryId: r.entry_id, memberId: r.member_id }));
  return { match3: tier(3), match2: tier(2), match1: tier(1) };
}
