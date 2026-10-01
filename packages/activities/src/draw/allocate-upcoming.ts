/**
 * Entering members into upcoming draws as soon as those draws exist.
 *
 * Draws are created ahead of time (one-off or a recurring series). So that
 * members can see they are entered, and so each draw's jackpot counts every
 * entry it will have, entries are made up front rather than when a draw is
 * run:
 *
 *  - Direct Debit (GitHub #9): an active mandate enters each of the member's
 *    numbers into every draw still on sale. Cancelling voids those entries
 *    in draws still taking entries (`voidDirectDebitEntries`).
 *  - Prepaid weeks (card blocks, physical tickets, and standing-order /
 *    Giro / branch money matched from imported bank statements): the soonest
 *    draws on sale, one entry per number per draw, until the weeks run out.
 *    Weeks beyond the draws that exist wait for more draws to be created.
 *
 * Run after a purchase, a ticket, a Direct Debit setup, a bank statement
 * import or match, and whenever draws are created. `generateDueEntries` still
 * runs when a draw is run, as the backstop. Idempotent.
 *
 * Remaining prepaid weeks = allocated standing-order-shaped payments ÷ ticket
 * price − live prepaid/card entries. Entries placed here count as used, so
 * running a draw later can never spend the same week twice.
 */
import { withTransaction, type Pool } from '@qosfc/db';
import type { PoolClient } from 'pg';
import { entriesDue, TICKET_PRICE_PENCE, ZERO, type EntryGenerationConfig } from '@qosfc/domain';
import { writeAudit } from '../audit.js';
import { ON_SALE_DRAWS_SQL, placeEntry } from './place-entry.js';

const STANDING_ORDER_CHANNELS = ['so_fps', 'giro', 'branch_cash', 'direct_debit', 'agent_cash', 'card'] as const;

export interface AllocateUpcomingEntriesRequest {
  /** One member (after their purchase or setup), or everyone with a standing selection when omitted. */
  readonly memberId?: string;
  readonly actorLabel: string;
  readonly actorId?: string;
}

export interface AllocateUpcomingEntriesResult {
  readonly membersConsidered: number;
  /** Every entry placed, Direct Debit ones included. */
  readonly entriesPlaced: number;
  readonly directDebitEntriesPlaced: number;
  /** Prepaid weeks still unplaced because there are not enough upcoming draws yet. */
  readonly weeksWaitingForDraws: number;
  /** Entries already placed whose numbers were brought up to date with the member's current numbers. */
  readonly selectionsUpdated: number;
}

async function loadConfig(client: PoolClient): Promise<EntryGenerationConfig> {
  const { rows } = await client.query<{
    entry_strategy: string | null;
    entry_strategy_confirmed_by: string | null;
    per_person_entry_cap: number | null;
  }>(`SELECT entry_strategy, entry_strategy_confirmed_by, per_person_entry_cap FROM config_version WHERE is_active`);
  const row = rows[0];
  return {
    strategy: (row?.entry_strategy ?? undefined) as EntryGenerationConfig['strategy'],
    ticketPricePence: TICKET_PRICE_PENCE,
    ...(row?.entry_strategy_confirmed_by ? { confirmedBy: row.entry_strategy_confirmed_by } : {}),
    ...(row?.per_person_entry_cap != null ? { perPersonEntryCap: row.per_person_entry_cap } : {}),
  };
}

export async function allocateUpcomingEntries(pool: Pool, request: AllocateUpcomingEntriesRequest): Promise<AllocateUpcomingEntriesResult> {
  return withTransaction(pool, async (client) => {
    const cfg = await loadConfig(client);
    const { rows: draws } = await client.query<{ id: string }>(`${ON_SALE_DRAWS_SQL} FOR UPDATE`);
    const drawIds = draws.map((d) => d.id);

    // A member who changed their numbers since entries were placed: draws
    // still on sale carry the new numbers (closed or drawn ones keep theirs).
    const { rowCount: selectionsUpdated } = await client.query(
      `UPDATE entry e SET selection = ss.selection
         FROM selection_standing ss
        WHERE ss.prize_draw_no = e.prize_draw_no AND ss.slot = 1 AND ss.effective_to IS NULL
          AND e.voided_at IS NULL AND e.draw_id = ANY($1::uuid[]) AND e.selection <> ss.selection
          AND ($2::uuid IS NULL OR e.member_id = $2)`,
      [drawIds, request.memberId ?? null],
    );

    const { rows: candidates } = await client.query<{ member_id: string; prize_draw_no: number; selection: number[] }>(
      `SELECT mn.member_id, ss.prize_draw_no, ss.selection
         FROM selection_standing ss
         JOIN member_number mn ON mn.prize_draw_no = ss.prize_draw_no AND mn.row_type = 'member'
        WHERE ss.effective_to IS NULL AND ss.slot = 1 AND mn.member_id IS NOT NULL
          AND ($1::uuid IS NULL OR mn.member_id = $1)
        ORDER BY mn.member_id, ss.prize_draw_no`,
      [request.memberId ?? null],
    );

    // A member can hold several numbers (an agent's tickets); their prepaid
    // weeks are one pool, as in generateDueEntries.
    const byMember = new Map<string, { prize_draw_no: number; selection: number[] }[]>();
    for (const c of candidates) byMember.set(c.member_id, [...(byMember.get(c.member_id) ?? []), c]);

    let entriesPlaced = 0;
    let directDebitEntriesPlaced = 0;
    let weeksWaitingForDraws = 0;
    const hasLiveEntry = async (drawId: string, prizeDrawNo: number) =>
      (await client.query(`SELECT 1 FROM entry WHERE draw_id = $1 AND prize_draw_no = $2 AND voided_at IS NULL LIMIT 1`, [drawId, prizeDrawNo]))
        .rows.length > 0;

    for (const [memberId, numbers] of byMember) {
      // Serialise concurrent purchases by the same member.
      await client.query(`SELECT id FROM member WHERE id = $1 FOR UPDATE`, [memberId]);

      // Direct Debit: every draw on sale, nothing consumed.
      const { rows: mandate } = await client.query(
        `SELECT 1 FROM payment_method
          WHERE member_id = $1 AND type = 'direct_debit' AND active
            AND COALESCE(mandate_status, '') NOT IN ('cancelled', 'failed')
          LIMIT 1`,
        [memberId],
      );
      if (mandate.length > 0) {
        for (const drawId of drawIds) {
          for (const number of numbers) {
            if (await hasLiveEntry(drawId, number.prize_draw_no)) continue;
            const placed = await placeEntry(client, {
              drawId,
              memberId,
              prizeDrawNo: number.prize_draw_no,
              selection: number.selection,
              stakePence: cfg.ticketPricePence,
              funding: 'direct_debit',
            });
            if (placed) {
              entriesPlaced++;
              directDebitEntriesPlaced++;
            }
          }
        }
        // Prepaid weeks are kept for if the Direct Debit stops.
        continue;
      }

      const { rows: paid } = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_pence), 0)::text AS total FROM payment
          WHERE member_id = $1 AND status = 'allocated' AND channel = ANY($2::payment_channel[])`,
        [memberId, STANDING_ORDER_CHANNELS],
      );
      const { rows: used } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM entry WHERE member_id = $1 AND funding_source IN ('prepaid', 'card') AND voided_at IS NULL`,
        [memberId],
      );
      let remaining = Number(BigInt(paid[0]!.total) / cfg.ticketPricePence) - Number(used[0]!.n);
      if (remaining <= 0) continue;

      // The GAP-17 gate: halts if the entry strategy isn't confirmed.
      const due = entriesDue(
        { memberId, balancePence: ZERO, prepaidEntriesRemaining: remaining, scheduledEntriesPerDraw: 0, isAgentCollected: false },
        cfg,
      );
      if (due.count === 0) continue;

      // Soonest draw first; within a draw, each of the member's numbers gets
      // one entry — the shape running each draw would have produced.
      for (const drawId of drawIds) {
        for (const number of numbers) {
          if (remaining === 0) break;
          if (await hasLiveEntry(drawId, number.prize_draw_no)) continue;
          const placed = await placeEntry(client, {
            drawId,
            memberId,
            prizeDrawNo: number.prize_draw_no,
            selection: number.selection,
            stakePence: cfg.ticketPricePence,
            funding: 'prepaid',
          });
          if (placed) {
            remaining--;
            entriesPlaced++;
          }
        }
        if (remaining === 0) break;
      }
      weeksWaitingForDraws += remaining;
    }

    const result = {
      membersConsidered: byMember.size,
      entriesPlaced,
      directDebitEntriesPlaced,
      weeksWaitingForDraws,
      selectionsUpdated: selectionsUpdated ?? 0,
    };
    if (entriesPlaced > 0 || result.selectionsUpdated > 0) {
      await writeAudit(client, {
        ...(request.actorId ? { actorId: request.actorId } : {}),
        actorLabel: request.actorLabel,
        action: 'entries.upcoming_allocated',
        entity: request.memberId ? 'member' : 'draw',
        ...(request.memberId ? { entityId: request.memberId } : {}),
        after: result,
      });
    }
    return result;
  });
}

/**
 * A cancelled Direct Debit: withdraw its entries from every draw still taking
 * entries. Entries in draws whose entries have already closed stand — the
 * member was committed to those when entries closed. Never deletes (0007);
 * the 0007 trigger refuses this for any drawn draw regardless.
 */
export async function voidDirectDebitEntries(
  pool: Pool,
  request: { memberId: string; reason: string; actorLabel: string; actorId?: string },
): Promise<{ readonly voided: number }> {
  return withTransaction(pool, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE entry SET voided_at = now(), void_reason = $2
        WHERE member_id = $1 AND funding_source = 'direct_debit' AND voided_at IS NULL
          AND draw_id IN (${ON_SALE_DRAWS_SQL})`,
      [request.memberId, request.reason],
    );
    const voided = rowCount ?? 0;
    if (voided > 0) {
      await writeAudit(client, {
        ...(request.actorId ? { actorId: request.actorId } : {}),
        actorLabel: request.actorLabel,
        action: 'entries.direct_debit_voided',
        entity: 'member',
        entityId: request.memberId,
        after: { voided, reason: request.reason },
      });
    }
    return { voided };
  });
}
