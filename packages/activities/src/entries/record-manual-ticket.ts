/**
 * Recording a physical/agent-collected ticket, keyed in by admin staff.
 *
 * Distinct from GAP-19 (still ⛔): GAP-19 is a bulk agent lodgement with no
 * per-member breakdown at all. This is the opposite case — a specific,
 * identified member's physical ticket, with a known purchase date and amount,
 * handed to a member of staff to key in. Client decision: treat it exactly
 * like an online ticket — the money buys whole prepaid blocks (GAP-17,
 * resolved), consumed one per open draw via the same `entriesDue()` /
 * `generateDueEntries()` path a standing order uses. This activity's only job
 * is recording the purchase and the selection; entering it into whichever
 * draw is currently open is `generateDueEntries()`'s job, unchanged, called
 * again by the caller after this succeeds (see apps/admin/src/index.ts).
 */
import { withTransaction, type Pool } from '@qosfc/db';
import {
  parseSelection,
  randomSelection,
  TICKET_PRICE_PENCE,
  type Selection,
} from '@qosfc/domain';
import { writeAudit } from '../audit.js';

export type ManualTicketSelectionInput = { readonly mode: 'random' } | { readonly mode: 'manual'; readonly numbers: readonly number[] };

export interface RecordManualTicketRequest {
  readonly memberId: string;
  readonly physicalTicketNumber: string;
  readonly purchaseDate: string; // ISO date, e.g. '2026-08-30'
  readonly amountPence: bigint;
  readonly selection: ManualTicketSelectionInput;
  readonly actorLabel: string;
  readonly actorId?: string;
}

export type RecordManualTicketOutcome =
  | {
      readonly kind: 'recorded';
      readonly paymentId: string;
      readonly prizeDrawNo: number;
      readonly blocksPurchased: number;
      readonly selection: Selection;
    }
  | { readonly kind: 'already_recorded'; readonly paymentId: string }
  | { readonly kind: 'rejected'; readonly reason: string };

export async function recordManualTicket(pool: Pool, request: RecordManualTicketRequest): Promise<RecordManualTicketOutcome> {
  const physicalTicketNumber = request.physicalTicketNumber.trim();
  if (!physicalTicketNumber) {
    return { kind: 'rejected', reason: 'A physical ticket number is required.' };
  }
  if (request.amountPence <= 0n || request.amountPence % TICKET_PRICE_PENCE !== 0n) {
    return {
      kind: 'rejected',
      reason: `Amount paid must be a whole multiple of the £${Number(TICKET_PRICE_PENCE) / 100} ticket price.`,
    };
  }
  const blocksPurchased = Number(request.amountPence / TICKET_PRICE_PENCE);

  const selectionResult =
    request.selection.mode === 'random' ? { ok: true as const, selection: randomSelection(Math.random) } : parseSelection(request.selection.numbers);
  if (!selectionResult.ok) return { kind: 'rejected', reason: selectionResult.reason };
  const selection = selectionResult.selection;
  const source = request.selection.mode === 'random' ? 'quick_pick' : 'member_chosen';

  const idempotencyKey = `manual-ticket:${physicalTicketNumber}`;

  return withTransaction(pool, async (client) => {
    const { rows: existing } = await client.query<{ id: string }>(`SELECT id FROM payment WHERE idempotency_key = $1`, [idempotencyKey]);
    if (existing[0]) return { kind: 'already_recorded', paymentId: existing[0].id };

    const { rows: memberRows } = await client.query<{ id: string }>(`SELECT id FROM member WHERE id = $1`, [request.memberId]);
    if (!memberRows[0]) return { kind: 'rejected', reason: 'Member not found.' };

    const { rows: nextNoRows } = await client.query<{ next: number }>(`SELECT COALESCE(MAX(prize_draw_no), 99999) + 1 AS next FROM member_number`);
    const prizeDrawNo = nextNoRows[0]!.next;
    await client.query(`INSERT INTO member_number (prize_draw_no, member_id, row_type) VALUES ($1, $2, 'member')`, [prizeDrawNo, request.memberId]);

    await client.query(`INSERT INTO selection_standing (prize_draw_no, slot, selection, source) VALUES ($1, 1, $2, $3)`, [
      prizeDrawNo,
      selection,
      source,
    ]);

    const { rows: paymentRows } = await client.query<{ id: string }>(
      `INSERT INTO payment (member_id, channel, received_date, amount_pence, status, physical_ticket_number, idempotency_key)
       VALUES ($1, 'agent_cash', $2, $3, 'allocated', $4, $5)
       RETURNING id`,
      [request.memberId, request.purchaseDate, request.amountPence, physicalTicketNumber, idempotencyKey],
    );
    const paymentId = paymentRows[0]!.id;

    await writeAudit(client, {
      ...(request.actorId ? { actorId: request.actorId } : {}),
      actorLabel: request.actorLabel,
      action: 'manual_ticket_recorded',
      entity: 'payment',
      entityId: paymentId,
      after: { memberId: request.memberId, prizeDrawNo, physicalTicketNumber, amountPence: request.amountPence.toString(), blocksPurchased, selection },
    });

    return { kind: 'recorded', paymentId, prizeDrawNo, blocksPurchased, selection };
  });
}
