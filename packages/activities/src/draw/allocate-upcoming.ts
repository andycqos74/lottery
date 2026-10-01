/**
 * Entering members into upcoming draws as soon as those draws exist, line
 * by line (db/migrations/0018).
 *
 * A member holds one or more lines — a set of numbers (prize_draw_no + slot)
 * — each funded by its own paid weeks (card blocks, physical tickets,
 * standing-order money matched from bank statements) and/or its own Direct
 * Debit. Client rules (2026-10-01):
 *
 *  - Paid weeks are always used first. A Direct Debit on the same line is
 *    paused for the draws those weeks cover and resumes after them.
 *  - A line is entered once per draw, and a member never has two entries in
 *    one draw with the same numbers (agents excepted: their physical
 *    tickets belong to different players).
 *
 * For every line this walks the draws still on sale, soonest first, and
 * makes each draw's entry what the rules say it should be — placing it,
 * switching its funding (weeks ↔ Direct Debit), voiding it (Direct Debit
 * cancelled, a duplicate of the same numbers, or weeks now used by an
 * earlier draw), or bringing its numbers up to date. Draws whose entries
 * have closed are never changed, except that running a draw
 * (`includeDrawId`) may still add entries funded before its cutoff.
 *
 * Runs after a purchase, a ticket, a Direct Debit setup or cancellation, a
 * bank statement import or match, whenever draws are created, and when a
 * draw is run (`generateDueEntries`). Idempotent.
 */
import { withTransaction, type Pool } from '@qosfc/db';
import type { PoolClient } from 'pg';
import { entriesDue, TICKET_PRICE_PENCE, ZERO, type EntryGenerationConfig } from '@qosfc/domain';
import { writeAudit } from '../audit.js';
import { placeEntry } from './place-entry.js';

/** Channels whose money buys weeks. Direct Debit collections fund DD entries, not extra weeks. */
export const WEEK_CHANNELS = ['so_fps', 'giro', 'branch_cash', 'agent_cash', 'card'] as const;

export interface AllocateUpcomingEntriesRequest {
  /** One member, or everyone with a line when omitted. */
  readonly memberId?: string;
  /** Running a draw: include it even though its entries have closed (only adding entries funded before its cutoff). */
  readonly includeDrawId?: string;
  readonly actorLabel: string;
  readonly actorId?: string;
}

export interface AllocateUpcomingEntriesResult {
  readonly membersConsidered: number;
  /** New entries placed (or voided ones revived), Direct Debit ones included. */
  readonly entriesPlaced: number;
  readonly directDebitEntriesPlaced: number;
  /** Existing entries whose funding switched between paid weeks and Direct Debit. */
  readonly fundingSwitched: number;
  /** Entries withdrawn: Direct Debit cancelled, duplicate numbers, or weeks moved to an earlier draw. */
  readonly voided: number;
  /** Paid weeks still unplaced because there are not enough upcoming draws yet. */
  readonly weeksWaitingForDraws: number;
  /** Entries whose numbers were brought up to date with their line's numbers. */
  readonly selectionsUpdated: number;
  /** For `includeDrawId`: entries in that draw placed by this run. */
  readonly placedInIncludedDraw: number;
  readonly directDebitPlacedInIncludedDraw: number;
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

interface Line {
  readonly memberId: string;
  readonly memberType: string;
  readonly prizeDrawNo: number;
  readonly slot: number;
  readonly selection: number[];
  /** The member's first line — where payments and mandates with no line recorded are counted. */
  readonly isDefault: boolean;
}

interface WalkDraw {
  readonly id: string;
  /** Entries closed: only ever add here, never change or withdraw. */
  readonly closed: boolean;
  readonly cutoff: Date | null;
}

interface LiveEntry {
  readonly id: string;
  readonly prizeDrawNo: number;
  readonly slot: number;
  readonly selection: number[];
  readonly funding: string;
}

const sameNumbers = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i]);

/** SQL for "attributed to this line": its own rows, plus unattributed ones when it is the member's first line. */
const LINE_FILTER = `member_id = $1 AND ((line_prize_draw_no = $2 AND line_slot = $3) OR ($4 AND line_prize_draw_no IS NULL))`;

export async function allocateUpcomingEntries(pool: Pool, request: AllocateUpcomingEntriesRequest): Promise<AllocateUpcomingEntriesResult> {
  return withTransaction(pool, async (client) => {
    const cfg = await loadConfig(client);

    const { rows: drawRows } = await client.query<{ id: string; entries_close_at: Date | null; closed: boolean }>(
      `SELECT id, entries_close_at, COALESCE(entries_close_at <= now(), false) AS closed FROM draw
        WHERE status = 'open' AND (entries_close_at IS NULL OR entries_close_at > now() OR id = $1)
        ORDER BY COALESCE(draw_at, draw_date::timestamptz), draw_number
        FOR UPDATE`,
      [request.includeDrawId ?? null],
    );
    const draws: WalkDraw[] = drawRows.map((d) => ({ id: d.id, closed: d.closed, cutoff: d.entries_close_at }));
    const walkIds = draws.map((d) => d.id);

    const { rows: lineRows } = await client.query<{
      member_id: string;
      member_type: string;
      prize_draw_no: number;
      slot: number;
      selection: number[];
    }>(
      `SELECT mn.member_id, m.member_type, ss.prize_draw_no, ss.slot, ss.selection
         FROM selection_standing ss
         JOIN member_number mn ON mn.prize_draw_no = ss.prize_draw_no AND mn.row_type = 'member'
         JOIN member m ON m.id = mn.member_id
        WHERE ss.effective_to IS NULL AND ($1::uuid IS NULL OR mn.member_id = $1)
        ORDER BY mn.member_id, ss.prize_draw_no, ss.slot`,
      [request.memberId ?? null],
    );
    const byMember = new Map<string, Line[]>();
    for (const r of lineRows) {
      const lines = byMember.get(r.member_id) ?? [];
      lines.push({
        memberId: r.member_id,
        memberType: r.member_type,
        prizeDrawNo: r.prize_draw_no,
        slot: r.slot,
        selection: r.selection,
        isDefault: lines.length === 0,
      });
      byMember.set(r.member_id, lines);
    }

    const totals = {
      entriesPlaced: 0,
      directDebitEntriesPlaced: 0,
      fundingSwitched: 0,
      voided: 0,
      weeksWaitingForDraws: 0,
      selectionsUpdated: 0,
      placedInIncludedDraw: 0,
      directDebitPlacedInIncludedDraw: 0,
    };

    const voidEntry = async (id: string, reason: string) => {
      await client.query(`UPDATE entry SET voided_at = now(), void_reason = $2 WHERE id = $1`, [id, reason]);
      totals.voided++;
    };

    for (const [memberId, lines] of byMember) {
      // Serialise concurrent purchases by the same member.
      await client.query(`SELECT id FROM member WHERE id = $1 FOR UPDATE`, [memberId]);
      const isAgent = lines[0]!.memberType === 'agent';

      for (const line of lines) {
        const lineArgs = [memberId, line.prizeDrawNo, line.slot, line.isDefault];
        const { rows: paidRows } = await client.query<{ total: string }>(
          `SELECT COALESCE(SUM(amount_pence), 0)::text AS total FROM payment
            WHERE ${LINE_FILTER} AND status = 'allocated' AND channel = ANY($5::payment_channel[])`,
          [...lineArgs, WEEK_CHANNELS],
        );
        const paidWeeks = Number(BigInt(paidRows[0]!.total) / cfg.ticketPricePence);

        // Weeks already spent on draws outside this walk (run, or closed and not being run now).
        const { rows: usedRows } = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM entry
            WHERE member_id = $1 AND prize_draw_no = $2 AND selection_slot = $3
              AND funding_source IN ('prepaid', 'card') AND voided_at IS NULL AND NOT (draw_id = ANY($4::uuid[]))`,
          [memberId, line.prizeDrawNo, line.slot, walkIds],
        );
        let weeksLeft = Math.max(0, paidWeeks - Number(usedRows[0]!.n));

        const { rows: mandateRows } = await client.query<{ created_at: Date }>(
          `SELECT created_at FROM payment_method
            WHERE ${LINE_FILTER} AND type = 'direct_debit' AND active
              AND COALESCE(mandate_status, '') NOT IN ('cancelled', 'failed')
            ORDER BY created_at LIMIT 1`,
          lineArgs,
        );
        const mandateSince = mandateRows[0]?.created_at;

        // The GAP-17 gate: halts if the entry strategy isn't confirmed.
        if (weeksLeft > 0) {
          entriesDue(
            { memberId, balancePence: ZERO, prepaidEntriesRemaining: weeksLeft, scheduledEntriesPerDraw: 0, isAgentCollected: false },
            cfg,
          );
        }

        for (const draw of draws) {
          // This line's entries in the draw: its own, plus (players only) any
          // other entry of theirs with the same numbers — the duplicates rule.
          const { rows: entryRows } = await client.query<{
            id: string;
            prize_draw_no: number;
            selection_slot: number;
            selection: number[];
            funding_source: string;
          }>(
            `SELECT id, prize_draw_no, selection_slot, selection, funding_source::text FROM entry
              WHERE draw_id = $1 AND member_id = $2 AND voided_at IS NULL
                AND ((prize_draw_no = $3 AND selection_slot = $4) OR (NOT $5 AND selection = $6::int[]))
              ORDER BY CASE funding_source WHEN 'card' THEN 0 WHEN 'prepaid' THEN 1 ELSE 2 END, created_at`,
            [draw.id, memberId, line.prizeDrawNo, line.slot, isAgent, line.selection],
          );
          const mine: LiveEntry[] = entryRows.map((r) => ({
            id: r.id,
            prizeDrawNo: r.prize_draw_no,
            slot: r.selection_slot,
            selection: r.selection,
            funding: r.funding_source,
          }));
          // An entry belonging to another of this member's lines with these numbers is that line's to manage.
          const keeper = mine[0];

          if (draw.closed) {
            // Entries have closed: nothing is changed or withdrawn; a draw being
            // run may still gain what was paid for before its cutoff.
            if (keeper) {
              if (keeper.funding === 'card' || keeper.funding === 'prepaid') weeksLeft = Math.max(0, weeksLeft - 1);
              continue;
            }
            const { rows: before } = await client.query<{ total: string }>(
              `SELECT COALESCE(SUM(amount_pence), 0)::text AS total FROM payment
                WHERE ${LINE_FILTER} AND status = 'allocated' AND channel = ANY($5::payment_channel[]) AND created_at <= $6`,
              [...lineArgs, WEEK_CHANNELS, draw.cutoff],
            );
            const paidBefore = Number(BigInt(before[0]!.total) / cfg.ticketPricePence) - Number(usedRows[0]!.n);
            const funding = weeksLeft > 0 && paidBefore > 0 ? 'prepaid' : mandateSince && draw.cutoff && mandateSince <= draw.cutoff ? 'direct_debit' : undefined;
            if (!funding) continue;
            if (await placeEntry(client, { drawId: draw.id, memberId, prizeDrawNo: line.prizeDrawNo, slot: line.slot, selection: line.selection, stakePence: cfg.ticketPricePence, funding })) {
              totals.entriesPlaced++;
              if (funding === 'prepaid') weeksLeft--;
              else totals.directDebitEntriesPlaced++;
              if (draw.id === request.includeDrawId) {
                totals.placedInIncludedDraw++;
                if (funding === 'direct_debit') totals.directDebitPlacedInIncludedDraw++;
              }
            }
            continue;
          }

          // Same numbers twice in one draw: keep one, withdraw the rest (a
          // withdrawn paid entry's week goes back to the line).
          for (const extra of mine.slice(1)) await voidEntry(extra.id, 'Duplicate of the same numbers in this draw');

          const desired = weeksLeft > 0 ? 'week' : mandateSince ? 'direct_debit' : undefined;

          if (!keeper) {
            if (!desired) continue;
            const funding = desired === 'week' ? 'prepaid' : 'direct_debit';
            if (await placeEntry(client, { drawId: draw.id, memberId, prizeDrawNo: line.prizeDrawNo, slot: line.slot, selection: line.selection, stakePence: cfg.ticketPricePence, funding })) {
              totals.entriesPlaced++;
              if (funding === 'direct_debit') totals.directDebitEntriesPlaced++;
              if (draw.id === request.includeDrawId) {
                totals.placedInIncludedDraw++;
                if (funding === 'direct_debit') totals.directDebitPlacedInIncludedDraw++;
              }
            }
            if (desired === 'week') weeksLeft--;
            continue;
          }

          if (!sameNumbers(keeper.selection, line.selection) && keeper.prizeDrawNo === line.prizeDrawNo && keeper.slot === line.slot) {
            await client.query(`UPDATE entry SET selection = $2 WHERE id = $1`, [keeper.id, line.selection]);
            totals.selectionsUpdated++;
          }

          if (keeper.funding === 'card') {
            // Paid for at checkout: always a week, whatever else is going on.
            weeksLeft = Math.max(0, weeksLeft - 1);
          } else if (desired === 'week') {
            weeksLeft--;
            if (keeper.funding === 'direct_debit') {
              // Paid weeks come first: the Direct Debit pauses for this draw.
              await client.query(`UPDATE entry SET funding_source = 'prepaid' WHERE id = $1`, [keeper.id]);
              totals.fundingSwitched++;
            }
          } else if (desired === 'direct_debit') {
            if (keeper.funding === 'prepaid') {
              // Weeks have run out by this draw (an earlier draw took them): the Direct Debit carries it.
              await client.query(`UPDATE entry SET funding_source = 'direct_debit' WHERE id = $1`, [keeper.id]);
              totals.fundingSwitched++;
            }
          } else {
            await voidEntry(
              keeper.id,
              keeper.funding === 'direct_debit' ? 'Direct Debit cancelled' : 'Paid weeks used by an earlier draw',
            );
          }
        }
        totals.weeksWaitingForDraws += weeksLeft;
      }
    }

    const result: AllocateUpcomingEntriesResult = { membersConsidered: byMember.size, ...totals };
    if (totals.entriesPlaced + totals.fundingSwitched + totals.voided + totals.selectionsUpdated > 0) {
      await writeAudit(client, {
        ...(request.actorId ? { actorId: request.actorId } : {}),
        actorLabel: request.actorLabel,
        action: 'entries.upcoming_allocated',
        entity: request.memberId ? 'member' : 'draw',
        ...(request.memberId ? { entityId: request.memberId } : request.includeDrawId ? { entityId: request.includeDrawId } : {}),
        after: result,
      });
    }
    return result;
  });
}
