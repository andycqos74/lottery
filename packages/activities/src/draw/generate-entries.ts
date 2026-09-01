/**
 * Turning standing-order money into entries — GAP-17, resolved (client
 * decision, see docs/gap-register.md): prepaid blocks. Each allocated payment
 * bought whole tickets up front; each open draw consumes one until the block
 * runs out.
 *
 * `entriesDue()` (`@qosfc/domain`) is the audited decision of how many
 * entries a member is owed — pure, deterministic, no I/O. This activity's
 * only job is assembling the real `MemberEntryState` that decision needs from
 * the database, and writing the entries it returns. Split this way so the
 * money arithmetic stays exactly as testable/replayable as everywhere else in
 * the system (T-6.4), even though nothing here runs inside workflow code.
 *
 * "Blocks purchased" is derived, not stored: total pence ever allocated to a
 * member from a standing-order-shaped channel, divided by the ticket price,
 * minus entries already drawn against that member with funding_source
 * 'prepaid'. Re-running this for a draw that already has an entry for a given
 * prize draw number is a no-op — the same idempotency key
 * (`<drawId>:<prizeDrawNo>:1`) the manual admin entry path already uses
 * (T-8.2) makes a second attempt harmless.
 */
import { withTransaction, type Pool } from '@qosfc/db';
import { entriesDue, TICKET_PRICE_PENCE, ZERO, type EntryGenerationConfig, type MemberEntryState } from '@qosfc/domain';
import { writeAudit } from '../audit.js';

export interface GenerateDueEntriesRequest {
  readonly drawId: string;
  readonly actorLabel: string;
  readonly actorId?: string;
}

export interface GenerateDueEntriesResult {
  readonly candidatesConsidered: number;
  readonly generated: number;
}

const STANDING_ORDER_CHANNELS = ['so_fps', 'giro', 'branch_cash', 'direct_debit'] as const;

export async function generateDueEntries(pool: Pool, request: GenerateDueEntriesRequest): Promise<GenerateDueEntriesResult> {
  return withTransaction(pool, async (client) => {
    const { rows: drawRows } = await client.query<{ status: string }>(`SELECT status FROM draw WHERE id = $1`, [request.drawId]);
    const draw = drawRows[0];
    if (!draw) throw new Error(`Draw ${request.drawId} does not exist.`);
    if (draw.status !== 'open') {
      throw new Error(`Draw ${request.drawId} is '${draw.status}', not 'open' — entries can only be generated before a draw closes.`);
    }

    const { rows: cfgRows } = await client.query<{
      entry_strategy: string | null;
      entry_strategy_confirmed_by: string | null;
      per_person_entry_cap: number | null;
    }>(`SELECT entry_strategy, entry_strategy_confirmed_by, per_person_entry_cap FROM config_version WHERE is_active`);
    const cfgRow = cfgRows[0];
    const cfg: EntryGenerationConfig = {
      strategy: (cfgRow?.entry_strategy ?? undefined) as EntryGenerationConfig['strategy'],
      ticketPricePence: TICKET_PRICE_PENCE,
      ...(cfgRow?.entry_strategy_confirmed_by ? { confirmedBy: cfgRow.entry_strategy_confirmed_by } : {}),
      ...(cfgRow?.per_person_entry_cap != null ? { perPersonEntryCap: cfgRow.per_person_entry_cap } : {}),
    };

    // One row per member with a linked, active persistent selection (GAP-14).
    // Slot 1 only — a second standing slot is a second candidate this query
    // does not yet enumerate, tracked as a follow-up rather than guessed at.
    const { rows: candidates } = await client.query<{ member_id: string; prize_draw_no: number; selection: number[] }>(
      `SELECT mn.member_id, ss.prize_draw_no, ss.selection
         FROM selection_standing ss
         JOIN member_number mn ON mn.prize_draw_no = ss.prize_draw_no AND mn.row_type = 'member'
        WHERE ss.effective_to IS NULL AND ss.slot = 1 AND mn.member_id IS NOT NULL`,
    );

    let generated = 0;
    for (const candidate of candidates) {
      const { rows: purchasedRows } = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_pence), 0)::text AS total
           FROM payment
          WHERE member_id = $1 AND status = 'allocated' AND channel = ANY($2::payment_channel[])`,
        [candidate.member_id, STANDING_ORDER_CHANNELS],
      );
      const { rows: consumedRows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM entry WHERE member_id = $1 AND funding_source = 'prepaid'`,
        [candidate.member_id],
      );
      const totalBlocks = Number(BigInt(purchasedRows[0]!.total) / cfg.ticketPricePence);
      const state: MemberEntryState = {
        memberId: candidate.member_id,
        balancePence: ZERO,
        prepaidEntriesRemaining: Math.max(0, totalBlocks - Number(consumedRows[0]!.n)),
        scheduledEntriesPerDraw: 0,
        isAgentCollected: false,
      };

      const due = entriesDue(state, cfg);
      if (due.count === 0) continue;

      const idempotencyKey = `${request.drawId}:${candidate.prize_draw_no}:1`;
      const { rows: insertedRows } = await client.query<{ id: string }>(
        `INSERT INTO entry (draw_id, member_id, prize_draw_no, selection, stake_pence, funding_source, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,'prepaid',$6)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [request.drawId, candidate.member_id, candidate.prize_draw_no, candidate.selection, cfg.ticketPricePence, idempotencyKey],
      );
      if (insertedRows[0]) generated++;
    }

    await writeAudit(client, {
      ...(request.actorId ? { actorId: request.actorId } : {}),
      actorLabel: request.actorLabel,
      action: 'draw.entries_generated',
      entity: 'draw',
      entityId: request.drawId,
      after: { candidatesConsidered: candidates.length, generated },
    });

    return { candidatesConsidered: candidates.length, generated };
  });
}
