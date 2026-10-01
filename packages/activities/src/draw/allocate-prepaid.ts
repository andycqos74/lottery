/**
 * Placing prepaid weeks into upcoming draws up front (GitHub #11 follow-up).
 *
 * Now that draws are created ahead of time (one-off or a recurring series),
 * a member who buys 4 weeks should see an entry in each of the next four
 * draws straight away — in the admin Draws page and in their own history —
 * rather than each one appearing only when that draw is run. This fills the
 * soonest draws still on sale (open, entries not yet closed), one entry per
 * draw, until the member's remaining prepaid weeks run out. Weeks left over
 * when there are too few draws are placed when more draws are created, or
 * at the latest when a draw is run (`generateDueEntries`).
 *
 * Same arithmetic as `generateDueEntries`: remaining weeks = allocated
 * standing-order-shaped payments ÷ ticket price − prepaid/card entries
 * already made. Entries placed here count as consumed, so running the draw
 * later can never spend the same week twice. Direct Debit members are not
 * pre-entered — a mandate enters each draw when it is run (GitHub #9).
 */
import { withTransaction, type Pool } from '@qosfc/db';
import type { PoolClient } from 'pg';
import { entriesDue, TICKET_PRICE_PENCE, ZERO, type EntryGenerationConfig } from '@qosfc/domain';
import { writeAudit } from '../audit.js';

const STANDING_ORDER_CHANNELS = ['so_fps', 'giro', 'branch_cash', 'direct_debit', 'agent_cash', 'card'] as const;

export interface AllocatePrepaidEntriesRequest {
  /** One member (after their purchase), or every member with a standing selection when omitted (after draws are created). */
  readonly memberId?: string;
  readonly actorLabel: string;
  readonly actorId?: string;
}

export interface AllocatePrepaidEntriesResult {
  readonly membersConsidered: number;
  readonly entriesPlaced: number;
  /** Weeks still unplaced because there are not enough upcoming draws yet. */
  readonly weeksWaitingForDraws: number;
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

export async function allocatePrepaidEntries(pool: Pool, request: AllocatePrepaidEntriesRequest): Promise<AllocatePrepaidEntriesResult> {
  return withTransaction(pool, async (client) => {
    const cfg = await loadConfig(client);

    const { rows: candidates } = await client.query<{ member_id: string; prize_draw_no: number; selection: number[] }>(
      `SELECT mn.member_id, ss.prize_draw_no, ss.selection
         FROM selection_standing ss
         JOIN member_number mn ON mn.prize_draw_no = ss.prize_draw_no AND mn.row_type = 'member'
        WHERE ss.effective_to IS NULL AND ss.slot = 1 AND mn.member_id IS NOT NULL
          AND ($1::uuid IS NULL OR mn.member_id = $1)
        ORDER BY mn.member_id, ss.prize_draw_no`,
      [request.memberId ?? null],
    );

    // Draws still on sale, soonest first.
    const { rows: draws } = await client.query<{ id: string }>(
      `SELECT id FROM draw
        WHERE status = 'open' AND (entries_close_at IS NULL OR entries_close_at > now())
        ORDER BY COALESCE(draw_at, draw_date::timestamptz), draw_number
        FOR UPDATE`,
    );

    // A member can hold several standing numbers (an agent with several
    // physical tickets); their weeks are one pool, as in generateDueEntries.
    const byMember = new Map<string, { prize_draw_no: number; selection: number[] }[]>();
    for (const c of candidates) byMember.set(c.member_id, [...(byMember.get(c.member_id) ?? []), c]);

    let entriesPlaced = 0;
    let weeksWaitingForDraws = 0;
    for (const [memberId, numbers] of byMember) {
      // Serialise concurrent purchases by the same member.
      await client.query(`SELECT id FROM member WHERE id = $1 FOR UPDATE`, [memberId]);

      const { rows: paid } = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_pence), 0)::text AS total FROM payment
          WHERE member_id = $1 AND status = 'allocated' AND channel = ANY($2::payment_channel[])`,
        [memberId, STANDING_ORDER_CHANNELS],
      );
      const { rows: used } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM entry WHERE member_id = $1 AND funding_source IN ('prepaid', 'card')`,
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

      // Soonest draw first; within a draw, each of the member's numbers (an
      // agent's tickets) gets one entry — the same shape running each draw
      // would have produced, just made now.
      for (const draw of draws) {
        for (const number of numbers) {
          if (remaining === 0) break;
          const { rows: existing } = await client.query(`SELECT 1 FROM entry WHERE draw_id = $1 AND prize_draw_no = $2 LIMIT 1`, [
            draw.id,
            number.prize_draw_no,
          ]);
          if (existing.length > 0) continue;
          const { rows: inserted } = await client.query(
            `INSERT INTO entry (draw_id, member_id, prize_draw_no, selection, stake_pence, funding_source, idempotency_key)
             VALUES ($1,$2,$3,$4,$5,'prepaid',$6)
             ON CONFLICT (idempotency_key) DO NOTHING
             RETURNING id`,
            [draw.id, memberId, number.prize_draw_no, number.selection, cfg.ticketPricePence, `${draw.id}:${number.prize_draw_no}:1`],
          );
          if (inserted.length > 0) {
            remaining--;
            entriesPlaced++;
          }
        }
        if (remaining === 0) break;
      }
      weeksWaitingForDraws += remaining;
    }

    if (entriesPlaced > 0) {
      await writeAudit(client, {
        ...(request.actorId ? { actorId: request.actorId } : {}),
        actorLabel: request.actorLabel,
        action: 'entries.prepaid_allocated',
        entity: request.memberId ? 'member' : 'draw',
        ...(request.memberId ? { entityId: request.memberId } : {}),
        after: { membersConsidered: byMember.size, entriesPlaced, weeksWaitingForDraws },
      });
    }

    return { membersConsidered: byMember.size, entriesPlaced, weeksWaitingForDraws };
  });
}
