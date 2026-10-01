/**
 * Online Direct Debit setup (GAP-10, GAP-04) — "pay by standing Direct
 * Debit" on the member portal, the same redirect-round-trip shape as the
 * online card flow (`entries.ts`): bank details are never collected by this
 * application (T-9.1's boundary applies to Direct Debit exactly as it does
 * to a card), the bureau's `createMandate` hands back a redirect, and
 * `pending_dd_setup` bridges the round trip until the member's browser
 * returns — mirrors `pending_entry_purchase`.
 *
 * GAP-10 (which bureau) is unconfirmed, so this runs against the sandbox
 * `BacsBureau`, which — unlike the card PSP sandbox — has no decline path at
 * all: `createMandate` always succeeds. This is a stub for exercising the
 * sign-up flow, not a simulation of a real bureau's underwriting.
 *
 * Completing setup only records the mandate and (like the card flow) sets
 * the member's standing selection — it does NOT fabricate a `payment` row.
 * No money has moved yet; that only happens on an actual collection cycle,
 * which this system does not yet run (BacsBureau.submitCollections has no
 * caller). Entries don't wait for it: an active mandate enters the member
 * into every draw until it is cancelled — entered into each upcoming draw as
 * soon as the draw exists (`allocateUpcomingEntries`, funding source
 * 'direct_debit') — the collection pipeline, once built, is
 * what reconciles the money against those entries.
 */
import { withTransaction, type Pool } from '@qosfc/db';
import { idempotencyKey, type BacsBureau } from '@qosfc/ports';
import { allocateUpcomingEntries, describeLineOutcome, ON_SALE_DRAWS_SQL, resolveLine } from '@qosfc/activities';

export type StartDdSetupOutcome =
  | { readonly kind: 'started'; readonly redirectUrl: string; readonly mandateRef: string }
  | { readonly kind: 'rejected'; readonly reason: string };

export async function startDirectDebitSetup(
  pool: Pool,
  bacsBureau: BacsBureau,
  input: { memberId: string; selection: readonly number[]; returnUrl: string },
): Promise<StartDdSetupOutcome> {
  const selection = [...new Set(input.selection)].sort((a, b) => a - b);
  if (selection.length !== 4 || selection.some((n) => n < 1 || n > 20)) {
    return { kind: 'rejected', reason: 'A selection must be four distinct numbers between 1 and 20.' };
  }

  const mandate = await bacsBureau.createMandate({
    idempotencyKey: idempotencyKey(`dd-setup:${input.memberId}:${selection.join('-')}`),
    memberRef: input.memberId,
    returnUrl: input.returnUrl,
  });

  await pool.query(
    `INSERT INTO pending_dd_setup (mandate_ref, member_id, selection) VALUES ($1,$2,$3) ON CONFLICT (mandate_ref) DO NOTHING`,
    [mandate.mandateRef, input.memberId, selection],
  );

  return { kind: 'started', redirectUrl: mandate.setupRedirectUrl ?? input.returnUrl, mandateRef: mandate.mandateRef };
}

export type CompleteDdSetupOutcome =
  | { readonly kind: 'active'; readonly memberId: string; readonly message: string }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'not_found' };

/**
 * Idempotent, same convention as `completeEntryPurchase`: a session already
 * resolved returns what actually happened rather than acting twice.
 *
 * The mandate funds one line (db/migrations/0018): the member's existing
 * line if these are numbers they already have — any paid weeks on it are
 * used first and the Direct Debit starts after them — or a new line if not,
 * an extra entry in every draw alongside their existing numbers.
 */
export async function completeDirectDebitSetup(pool: Pool, bacsBureau: BacsBureau, mandateRef: string): Promise<CompleteDdSetupOutcome> {
  const { rows } = await pool.query<{ member_id: string; selection: number[]; status: string; outcome_message: string | null }>(
    `SELECT member_id, selection, status, outcome_message FROM pending_dd_setup WHERE mandate_ref = $1`,
    [mandateRef],
  );
  const pending = rows[0];
  if (!pending) return { kind: 'not_found' };
  if (pending.status === 'completed') {
    return { kind: 'active', memberId: pending.member_id, message: pending.outcome_message ?? 'Your Direct Debit is set up.' };
  }
  if (pending.status === 'failed') return { kind: 'failed', reason: 'The Direct Debit setup was not successful.' };

  const mandate = await bacsBureau.getMandate(mandateRef);
  if (mandate.status === 'cancelled' || mandate.status === 'failed') {
    await pool.query(`UPDATE pending_dd_setup SET status = 'failed' WHERE mandate_ref = $1`, [mandateRef]);
    return { kind: 'failed', reason: 'The Direct Debit setup was not successful.' };
  }

  // 'pending' or 'active' both finalize here — a stub with no decline path
  // (GAP-10) has nothing meaningful left to wait for.
  const recorded = await withTransaction(pool, async (client) => {
    const { rows: recheck } = await client.query<{ status: string; outcome_message: string | null }>(
      `SELECT status, outcome_message FROM pending_dd_setup WHERE mandate_ref = $1 FOR UPDATE`,
      [mandateRef],
    );
    if (recheck[0]?.status === 'completed') return { done: true as const, message: recheck[0].outcome_message ?? 'Your Direct Debit is set up.' };

    const line = await resolveLine(client, pending.member_id, pending.selection);
    // One mandate per line: setting up again for the same numbers replaces
    // the earlier mandate rather than entering them twice a draw.
    await client.query(
      `UPDATE payment_method SET active = false, mandate_status = 'cancelled'
        WHERE member_id = $1 AND type = 'direct_debit' AND active AND line_prize_draw_no = $2 AND line_slot = $3`,
      [pending.member_id, line.prizeDrawNo, line.slot],
    );
    await client.query(
      `INSERT INTO payment_method (member_id, type, mandate_ref, mandate_status, active, line_prize_draw_no, line_slot)
       VALUES ($1, 'direct_debit', $2, $3, true, $4, $5)`,
      [pending.member_id, mandateRef, mandate.status, line.prizeDrawNo, line.slot],
    );
    await client.query(`UPDATE pending_dd_setup SET status = 'completed' WHERE mandate_ref = $1`, [mandateRef]);
    return { done: false as const, line };
  });
  if (recorded.done) return { kind: 'active', memberId: pending.member_id, message: recorded.message };

  // Entered into the draws already on sale, so the member sees it straight
  // away. The mandate is committed either way: if this fails, each draw still
  // enters them when it is run.
  await allocateUpcomingEntries(pool, { memberId: pending.member_id, actorLabel: 'portal:direct-debit-setup' }).catch(() => undefined);
  const message = await describeLineOutcome(pool, {
    memberId: pending.member_id,
    line: recorded.line,
    selection: pending.selection,
    event: { kind: 'direct_debit' },
  });
  await pool.query(`UPDATE pending_dd_setup SET outcome_message = $2 WHERE mandate_ref = $1`, [mandateRef, message]);
  return { kind: 'active', memberId: pending.member_id, message };
}

export interface DirectDebitStatus {
  /** The payment_method row — what the member cancels. */
  readonly id: string;
  readonly mandateRef: string | null;
  readonly since: Date;
  /** The numbers this Direct Debit enters. */
  readonly selection: readonly number[] | null;
}

/** The member's active Direct Debits, one per line — what keeps those numbers entered into every draw (GitHub #9). */
export async function listActiveDirectDebits(pool: Pool, memberId: string): Promise<DirectDebitStatus[]> {
  const { rows } = await pool.query<{ id: string; mandate_ref: string | null; created_at: Date; selection: number[] | null }>(
    `SELECT pm.id, pm.mandate_ref, pm.created_at, ss.selection
       FROM payment_method pm
       LEFT JOIN selection_standing ss
         ON ss.prize_draw_no = pm.line_prize_draw_no AND ss.slot = pm.line_slot AND ss.effective_to IS NULL
      WHERE pm.member_id = $1 AND pm.type = 'direct_debit' AND pm.active
        AND COALESCE(pm.mandate_status, '') NOT IN ('cancelled', 'failed')
      ORDER BY pm.created_at`,
    [memberId],
  );
  return rows.map((r) => ({ id: r.id, mandateRef: r.mandate_ref, since: r.created_at, selection: r.selection }));
}

/**
 * Stops one Direct Debit entering its numbers into further draws (GitHub #9
 * — "until cancelled"). Its entries in draws still taking entries are
 * withdrawn; draws whose entries have already closed keep them. Any paid
 * weeks on the same numbers then take those places.
 *
 * GAP-10: the `BacsBureau` port has no cancellation call yet, so this is
 * recorded here only. Once a real bureau is chosen the mandate must also be
 * cancelled there, or collections would continue without entries.
 */
export async function cancelDirectDebit(pool: Pool, memberId: string, paymentMethodId: string): Promise<{ readonly cancelled: number }> {
  const { rows } = await pool.query<{ line_prize_draw_no: number | null; line_slot: number | null }>(
    `UPDATE payment_method SET active = false, mandate_status = 'cancelled'
      WHERE id = $2 AND member_id = $1 AND type = 'direct_debit' AND active
      RETURNING line_prize_draw_no, line_slot`,
    [memberId, paymentMethodId],
  );
  const line = rows[0];
  if (!line) return { cancelled: 0 };
  // Withdrawn even if the allocation below can't run (e.g. GAP-17 not
  // activated) — a cancelled Direct Debit must never stay entered.
  await pool.query(
    `UPDATE entry SET voided_at = now(), void_reason = 'Direct Debit cancelled'
      WHERE member_id = $1 AND funding_source = 'direct_debit' AND voided_at IS NULL
        AND ($2::int IS NULL OR (prize_draw_no = $2 AND selection_slot = $3))
        AND draw_id IN (${ON_SALE_DRAWS_SQL})`,
    [memberId, line.line_prize_draw_no, line.line_slot],
  );
  await allocateUpcomingEntries(pool, { memberId, actorLabel: 'portal:direct-debit-cancel' }).catch(() => undefined);
  return { cancelled: 1 };
}
