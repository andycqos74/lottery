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
 * Nothing is entered until the bank confirms the mandate (client decision,
 * 2026-10-07): that arrives as a mandate event, applied by the Direct Debit
 * workflow. From then the line is entered into every draw until cancelled,
 * and the money is collected monthly in advance
 * (packages/activities/src/direct-debit/).
 */
import { withTransaction, type Pool } from '@qosfc/db';
import { idempotencyKey, type BacsBureau } from '@qosfc/ports';
import { allocateUpcomingEntries, describeLineOutcome, endDirectDebit, resolveLine } from '@qosfc/activities';

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
    // The earlier mandate is cancelled with the bureau too (the Direct Debit workflow does that).
    await client.query(
      `UPDATE payment_method SET active = false, mandate_status = 'cancelled', ended_at = now(), end_reason = 'replaced',
              bureau_cancel_pending = mandate_ref IS NOT NULL
        WHERE member_id = $1 AND type = 'direct_debit' AND active AND line_prize_draw_no = $2 AND line_slot = $3`,
      [pending.member_id, line.prizeDrawNo, line.slot],
    );
    // Client decision, 2026-10-07: a mandate the bank hasn't confirmed enters
    // nothing. The bank's confirmation arrives as a mandate event, which the
    // Direct Debit workflow applies (activateMandate).
    await client.query(
      `INSERT INTO payment_method (member_id, type, mandate_ref, mandate_status, mandate_active_at, active, line_prize_draw_no, line_slot)
       VALUES ($1, 'direct_debit', $2, $3, CASE WHEN $3 = 'active' THEN now() END, true, $4, $5)`,
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
    event: { kind: 'direct_debit', pending: mandate.status !== 'active' },
  });
  await pool.query(`UPDATE pending_dd_setup SET outcome_message = $2 WHERE mandate_ref = $1`, [mandateRef, message]);
  return { kind: 'active', memberId: pending.member_id, message };
}

export interface DirectDebitCollectionView {
  /** YYYY-MM-DD, UK. */
  readonly collectionDate: string;
  readonly amountPence: bigint;
  readonly draws: number;
  readonly attempt: number;
  /** scheduled | submitted | collected | failed | rejected | cancelled | refunded */
  readonly status: string;
}

export interface DirectDebitStatus {
  /** The payment_method row — what the member cancels. */
  readonly id: string;
  readonly mandateRef: string | null;
  readonly since: Date;
  /** False while the bank has yet to confirm the mandate: nothing is entered until it does. */
  readonly confirmed: boolean;
  /** The numbers this Direct Debit enters. */
  readonly selection: readonly number[] | null;
  /** The next collection the member has been told about, if any. */
  readonly next: DirectDebitCollectionView | null;
  /** Past collections, newest first. */
  readonly history: readonly DirectDebitCollectionView[];
}

/** The member's live Direct Debits, one per line — what keeps those numbers entered into every draw (GitHub #9). */
export async function listActiveDirectDebits(pool: Pool, memberId: string): Promise<DirectDebitStatus[]> {
  const { rows } = await pool.query<{
    id: string;
    mandate_ref: string | null;
    created_at: Date;
    mandate_status: string | null;
    selection: number[] | null;
  }>(
    `SELECT pm.id, pm.mandate_ref, pm.created_at, pm.mandate_status, ss.selection
       FROM payment_method pm
       LEFT JOIN selection_standing ss
         ON ss.prize_draw_no = pm.line_prize_draw_no AND ss.slot = pm.line_slot AND ss.effective_to IS NULL
      WHERE pm.member_id = $1 AND pm.type = 'direct_debit' AND pm.active
        AND COALESCE(pm.mandate_status, '') NOT IN ('cancelled', 'failed')
      ORDER BY pm.created_at`,
    [memberId],
  );
  if (rows.length === 0) return [];
  const { rows: collections } = await pool.query<{
    payment_method_id: string;
    collection_date: string;
    amount_pence: string;
    draws_covered: number;
    attempt: number;
    status: string;
    notified_at: Date | null;
  }>(
    `SELECT payment_method_id, to_char(collection_date, 'YYYY-MM-DD') AS collection_date, amount_pence::text, draws_covered, attempt, status, notified_at
       FROM dd_collection WHERE payment_method_id = ANY($1::uuid[])
      ORDER BY collection_date DESC, attempt DESC`,
    [rows.map((r) => r.id)],
  );
  const view = (c: (typeof collections)[number]): DirectDebitCollectionView => ({
    collectionDate: c.collection_date,
    amountPence: BigInt(c.amount_pence),
    draws: c.draws_covered,
    attempt: c.attempt,
    status: c.status,
  });
  return rows.map((r) => {
    const mine = collections.filter((c) => c.payment_method_id === r.id);
    const upcoming = mine.filter((c) => (c.status === 'scheduled' || c.status === 'submitted') && c.notified_at);
    return {
      id: r.id,
      mandateRef: r.mandate_ref,
      since: r.created_at,
      confirmed: r.mandate_status === 'active',
      selection: r.selection,
      next: upcoming.length > 0 ? view(upcoming[upcoming.length - 1]!) : null,
      history: mine.filter((c) => c.status !== 'scheduled' && c.status !== 'cancelled').map(view),
    };
  });
}

/**
 * Stops one Direct Debit entering its numbers into further draws (GitHub #9
 * — "until cancelled"): `endDirectDebit` withdraws its entries from draws
 * still taking entries, except any a collection has already paid for, calls
 * off collections not yet sent, and has the Direct Debit workflow cancel the
 * mandate with the bureau.
 */
export async function cancelDirectDebit(pool: Pool, memberId: string, paymentMethodId: string): Promise<{ readonly cancelled: number }> {
  const { ended } = await endDirectDebit(pool, { paymentMethodId, memberId, reason: 'member_cancelled', actorLabel: 'portal:direct-debit-cancel' });
  return { cancelled: ended ? 1 : 0 };
}
