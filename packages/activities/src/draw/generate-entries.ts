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
 *
 * Direct Debit (GitHub #9) is the exception to prepaid blocks: a member with
 * an active mandate is entered into every draw until it is cancelled. The
 * admin console runs this automatically before a draw is closed (GitHub #11),
 * so multi-week purchases reach every future draw without anyone having to
 * remember a button.
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
  /** Every entry created, Direct Debit ones included. */
  readonly generated: number;
  readonly directDebitGenerated: number;
}

// 'agent_cash': manually-recorded physical tickets (recordManualTicket) buy
// prepaid blocks exactly like a standing order does, so they count here too.
// 'card': the portal's own multi-draw purchase (apps/api/src/entries.ts) is
// the same thing again — a member paying online for 4 or 12 draws at once.
const STANDING_ORDER_CHANNELS = ['so_fps', 'giro', 'branch_cash', 'direct_debit', 'agent_cash', 'card'] as const;

export async function generateDueEntries(pool: Pool, request: GenerateDueEntriesRequest): Promise<GenerateDueEntriesResult> {
  return withTransaction(pool, async (client) => {
    const { rows: drawRows } = await client.query<{ status: string; entries_close_at: Date | null }>(
      `SELECT status, entries_close_at FROM draw WHERE id = $1`,
      [request.drawId],
    );
    const draw = drawRows[0];
    if (!draw) throw new Error(`Draw ${request.drawId} does not exist.`);
    if (draw.status !== 'open') {
      throw new Error(`Draw ${request.drawId} is '${draw.status}', not 'open' — entries can only be generated before a draw closes.`);
    }
    // Money or a mandate arriving after entries closed buys the NEXT draw, not
    // this one — even though this runs (at the latest) when the draw is run,
    // which is after the cutoff. NULL on draws that predate cutoffs.
    const cutoff = draw.entries_close_at;

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
    let directDebitGenerated = 0;
    for (const candidate of candidates) {
      // Already in this draw under this number — most often the portal's card
      // checkout, which enters the member's first draw immediately under its
      // own idempotency key. Generating again would enter them twice and burn
      // one of the weeks they paid for on a duplicate.
      const { rows: existingRows } = await client.query(`SELECT 1 FROM entry WHERE draw_id = $1 AND prize_draw_no = $2 LIMIT 1`, [
        request.drawId,
        candidate.prize_draw_no,
      ]);
      if (existingRows.length > 0) continue;

      const idempotencyKey = `${request.drawId}:${candidate.prize_draw_no}:1`;

      // #9: an active Direct Debit enters the member into every draw until it
      // is cancelled. It is a recurring subscription, not a prepaid block, so
      // it neither consults nor consumes the prepaid balance below — any
      // prepaid weeks the member also holds are kept for if the DD stops.
      const { rows: ddRows } = await client.query(
        `SELECT 1 FROM payment_method
          WHERE member_id = $1 AND type = 'direct_debit' AND active
            AND COALESCE(mandate_status, '') NOT IN ('cancelled', 'failed')
            AND ($2::timestamptz IS NULL OR created_at <= $2)
          LIMIT 1`,
        [candidate.member_id, cutoff],
      );
      if (ddRows.length > 0) {
        const { rows: insertedRows } = await client.query<{ id: string }>(
          `INSERT INTO entry (draw_id, member_id, prize_draw_no, selection, stake_pence, funding_source, idempotency_key)
           VALUES ($1,$2,$3,$4,$5,'direct_debit',$6)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id`,
          [request.drawId, candidate.member_id, candidate.prize_draw_no, candidate.selection, cfg.ticketPricePence, idempotencyKey],
        );
        if (insertedRows[0]) {
          generated++;
          directDebitGenerated++;
        }
        continue;
      }

      const { rows: purchasedRows } = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_pence), 0)::text AS total
           FROM payment
          WHERE member_id = $1 AND status = 'allocated' AND channel = ANY($2::payment_channel[])
            AND ($3::timestamptz IS NULL OR created_at <= $3)`,
        [candidate.member_id, STANDING_ORDER_CHANNELS, cutoff],
      );
      // 'card': the portal credits the member's very first entry immediately
      // at checkout (apps/api/src/entries.ts), synchronously, rather than
      // waiting for this activity to run — it consumes a block exactly like a
      // 'prepaid' one does, so it must count here too or the balance below
      // would over-credit by one entry's worth.
      const { rows: consumedRows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM entry WHERE member_id = $1 AND funding_source IN ('prepaid', 'card')`,
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
      // Nothing to spend: don't ask entriesDue(), which halts on an unset
      // GAP-17 strategy — a member with no prepaid weeks must not block a
      // draw that only has Direct Debit members in it.
      if (state.prepaidEntriesRemaining === 0) continue;

      const due = entriesDue(state, cfg);
      if (due.count === 0) continue;

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
      after: { candidatesConsidered: candidates.length, generated, directDebitGenerated },
    });

    return { candidatesConsidered: candidates.length, generated, directDebitGenerated };
  });
}
