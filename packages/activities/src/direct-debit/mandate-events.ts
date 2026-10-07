/**
 * Mandate messages from the bank (AUDDIS/ADDACS-shaped), applied once each.
 *
 * - `mandate_active` — the bank confirmed it: the line is entered from now
 *   (a pending mandate enters nothing — client decision, 2026-10-07).
 * - `mandate_cancelled` / `mandate_failed` — the payer or their bank ended
 *   it: the Direct Debit ends here too, keeping entries already paid for.
 * - `indemnity_claim` — a refund under the Direct Debit Guarantee (GAP-12,
 *   resolved): removal. The refunded collections no longer count as paid,
 *   the Direct Debit ends, and every entry they paid for in a draw still
 *   taking entries is withdrawn. A task tells the treasurer, including any
 *   refunded draws that were already played.
 * - `mandate_amended` — recorded only.
 */
import { withTransaction, type Pool } from '@qosfc/db';
import { formatPence, pence } from '@qosfc/domain';
import type { BacsBureau, MandateEvent } from '@qosfc/ports';
import { writeAudit } from '../audit.js';
import { allocateUpcomingEntries } from '../draw/allocate-upcoming.js';
import { openHumanTask } from '../tasks/human-tasks.js';
import { activateMandate, endDirectDebit, withdrawUncollectedEntries } from './mandates.js';

export const DD_REFUND_CLAIM_TASK_KIND = 'dd_refund_claim';

/** Re-read this far back each time; the event id makes a repeat harmless, and messages can arrive out of order. */
const OVERLAP_DAYS = 7;

export interface ProcessMandateEventsResult {
  readonly applied: number;
}

export async function processMandateEvents(pool: Pool, bureau: BacsBureau): Promise<ProcessMandateEventsResult> {
  const { rows: last } = await pool.query<{ since: string | null }>(
    `SELECT to_char((max(occurred_at) - make_interval(days => $1)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS since FROM dd_mandate_event`,
    [OVERLAP_DAYS],
  );
  const events = await bureau.fetchMandateEvents(last[0]?.since ?? '1970-01-01T00:00:00Z');

  let applied = 0;
  for (const event of events) {
    const { rows: seen } = await pool.query(`SELECT 1 FROM dd_mandate_event WHERE event_id = $1`, [event.eventId]);
    if (seen.length > 0) continue;
    // Applied before it is recorded: if applying fails, the next run tries again,
    // and every step below is a no-op the second time.
    const outcome = await applyEvent(pool, event);
    await pool.query(
      `INSERT INTO dd_mandate_event (event_id, mandate_ref, kind, occurred_at, detail, amount_pence, outcome)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (event_id) DO NOTHING`,
      [event.eventId, event.mandateRef, event.kind, event.occurredAt, event.detail, event.amountPence ?? null, outcome],
    );
    applied++;
  }
  return { applied };
}

async function paymentMethodFor(pool: Pool, mandateRef: string): Promise<{ id: string; member_id: string } | undefined> {
  const { rows } = await pool.query<{ id: string; member_id: string }>(
    `SELECT id, member_id FROM payment_method WHERE mandate_ref = $1 AND type = 'direct_debit' ORDER BY created_at DESC LIMIT 1`,
    [mandateRef],
  );
  return rows[0];
}

async function applyEvent(pool: Pool, event: MandateEvent): Promise<string> {
  switch (event.kind) {
    case 'mandate_active':
      return (await activateMandate(pool, event.mandateRef, 'bank:mandate-active')).activated ? 'activated' : 'already_active_or_unknown';
    case 'mandate_cancelled':
    case 'mandate_failed': {
      const pm = await paymentMethodFor(pool, event.mandateRef);
      if (!pm) return 'unknown_mandate';
      const ended = await endDirectDebit(pool, {
        paymentMethodId: pm.id,
        reason: event.kind === 'mandate_failed' ? 'mandate_failed' : 'payer_cancelled_at_bank',
        actorLabel: `bank:${event.kind}`,
      });
      return ended.ended ? 'ended' : 'already_ended';
    }
    case 'indemnity_claim':
      return applyRefundClaim(pool, event);
    case 'mandate_amended':
      return 'recorded';
  }
}

async function applyRefundClaim(pool: Pool, event: MandateEvent): Promise<string> {
  const pm = await paymentMethodFor(pool, event.mandateRef);
  if (!pm) return 'unknown_mandate';

  const claimed = BigInt(event.amountPence ?? '0');
  const refunded = await withTransaction(pool, async (client) => {
    const { rows: collections } = await client.query<{ id: string; amount_pence: string; payment_id: string | null }>(
      `SELECT id, amount_pence::text, payment_id FROM dd_collection
        WHERE payment_method_id = $1 AND status = 'collected'
        ORDER BY collection_date DESC, created_at DESC
        FOR UPDATE`,
      [pm.id],
    );
    // Newest first until the claimed amount is covered; a claim with no amount refunds the latest.
    const picked: typeof collections = [];
    let covered = 0n;
    for (const c of collections) {
      if (picked.length > 0 && covered >= claimed) break;
      picked.push(c);
      covered += BigInt(c.amount_pence);
    }
    for (const c of picked) {
      await client.query(`UPDATE dd_collection SET status = 'refunded', updated_at = now() WHERE id = $1`, [c.id]);
      if (c.payment_id) await client.query(`UPDATE payment SET status = 'reversed' WHERE id = $1`, [c.payment_id]);
    }
    const { rows: line } = await client.query<{ line_prize_draw_no: number | null; line_slot: number | null }>(
      `SELECT line_prize_draw_no, line_slot FROM payment_method WHERE id = $1`,
      [pm.id],
    );
    const withdrawn = await withdrawUncollectedEntries(
      client,
      { memberId: pm.member_id, prizeDrawNo: line[0]?.line_prize_draw_no ?? null, slot: line[0]?.line_slot ?? null },
      'Direct Debit refunded',
    );
    const { rows: played } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM dd_collection_entry ce JOIN entry e ON e.id = ce.entry_id
        WHERE ce.collection_id = ANY($1::uuid[]) AND e.voided_at IS NULL`,
      [picked.map((c) => c.id)],
    );
    await writeAudit(client, {
      actorLabel: 'bank:indemnity-claim',
      action: 'direct_debit.refund_claim',
      entity: 'payment_method',
      entityId: pm.id,
      after: { eventId: event.eventId, claimedPence: claimed.toString(), refundedCollections: picked.map((c) => c.id), entriesWithdrawn: withdrawn, gapId: 'GAP-12' },
    });
    return { collections: picked.length, amount: covered, withdrawn, played: Number(played[0]!.n) };
  });

  const ended = await endDirectDebit(pool, { paymentMethodId: pm.id, reason: 'refund_claim', actorLabel: 'bank:indemnity-claim' });
  if (!ended.ended) await allocateUpcomingEntries(pool, { memberId: pm.member_id, actorLabel: 'bank:indemnity-claim' }).catch(() => undefined);

  const withdrawn = refunded.withdrawn + ended.entriesWithdrawn;
  await openHumanTask(pool, {
    kind: DD_REFUND_CLAIM_TASK_KIND,
    title: `Direct Debit refund claim of ${formatPence(pence(claimed))}`,
    detail:
      `The member's bank has refunded ${formatPence(pence(claimed))} under the Direct Debit Guarantee. ` +
      `${refunded.collections} collection${refunded.collections === 1 ? '' : 's'} now count as refunded, the Direct Debit has ended, and ` +
      `${withdrawn} entr${withdrawn === 1 ? 'y was' : 'ies were'} removed from draws still taking entries. ` +
      `${refunded.played} refunded draw${refunded.played === 1 ? ' had' : 's had'} already closed to entries or been drawn.`,
    consequenceIfIgnored: 'The refund is not reflected in the accounts.',
    gapId: 'GAP-12',
    entityType: 'member',
    entityId: pm.member_id,
    dedupeKey: `${DD_REFUND_CLAIM_TASK_KIND}:${event.eventId}`,
  });
  return 'refunded';
}
