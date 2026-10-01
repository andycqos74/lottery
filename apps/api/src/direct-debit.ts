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
import { allocateUpcomingEntries, voidDirectDebitEntries } from '@qosfc/activities';

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
  | { readonly kind: 'active'; readonly memberId: string }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'not_found' };

/**
 * Idempotent, same convention as `completeEntryPurchase`: a session already
 * resolved returns what actually happened rather than acting twice.
 */
export async function completeDirectDebitSetup(pool: Pool, bacsBureau: BacsBureau, mandateRef: string): Promise<CompleteDdSetupOutcome> {
  const { rows } = await pool.query<{ member_id: string; selection: number[]; status: string }>(
    `SELECT member_id, selection, status FROM pending_dd_setup WHERE mandate_ref = $1`,
    [mandateRef],
  );
  const pending = rows[0];
  if (!pending) return { kind: 'not_found' };
  if (pending.status === 'completed') return { kind: 'active', memberId: pending.member_id };
  if (pending.status === 'failed') return { kind: 'failed', reason: 'The Direct Debit setup was not successful.' };

  const mandate = await bacsBureau.getMandate(mandateRef);
  if (mandate.status === 'cancelled' || mandate.status === 'failed') {
    await pool.query(`UPDATE pending_dd_setup SET status = 'failed' WHERE mandate_ref = $1`, [mandateRef]);
    return { kind: 'failed', reason: 'The Direct Debit setup was not successful.' };
  }

  // 'pending' or 'active' both finalize here — a stub with no decline path
  // (GAP-10) has nothing meaningful left to wait for.
  const result = await withTransaction(pool, async (client): Promise<CompleteDdSetupOutcome> => {
    const { rows: recheck } = await client.query<{ status: string }>(
      `SELECT status FROM pending_dd_setup WHERE mandate_ref = $1 FOR UPDATE`,
      [mandateRef],
    );
    if (recheck[0]?.status === 'completed') return { kind: 'active', memberId: pending.member_id };

    // Same "reuse an existing prize_draw_no, else mint one" logic as the
    // online card flow (entries.ts) — one identifier per member, not one per
    // funding channel.
    const { rows: existingNoRows } = await client.query<{ prize_draw_no: number }>(
      `SELECT prize_draw_no FROM member_number WHERE member_id = $1 LIMIT 1`,
      [pending.member_id],
    );
    let prizeDrawNo = existingNoRows[0]?.prize_draw_no;
    if (prizeDrawNo === undefined) {
      const { rows: nextNoRows } = await client.query<{ next: number }>(
        `SELECT COALESCE(MAX(prize_draw_no), 99999) + 1 AS next FROM member_number`,
      );
      prizeDrawNo = nextNoRows[0]!.next;
      await client.query(`INSERT INTO member_number (prize_draw_no, member_id, row_type) VALUES ($1, $2, 'member')`, [
        prizeDrawNo,
        pending.member_id,
      ]);
    }

    await client.query(
      `UPDATE selection_standing SET effective_to = CURRENT_DATE WHERE prize_draw_no = $1 AND slot = 1 AND effective_to IS NULL`,
      [prizeDrawNo],
    );
    await client.query(
      `INSERT INTO selection_standing (prize_draw_no, slot, selection, source) VALUES ($1, 1, $2, 'member_chosen')`,
      [prizeDrawNo, pending.selection],
    );

    // One Direct Debit per member: setting up again (e.g. to change numbers)
    // replaces the earlier mandate rather than entering them twice a draw.
    await client.query(
      `UPDATE payment_method SET active = false, mandate_status = 'cancelled'
        WHERE member_id = $1 AND type = 'direct_debit' AND active`,
      [pending.member_id],
    );
    await client.query(
      `INSERT INTO payment_method (member_id, type, mandate_ref, mandate_status, active) VALUES ($1, 'direct_debit', $2, $3, true)`,
      [pending.member_id, mandateRef, mandate.status],
    );

    await client.query(`UPDATE pending_dd_setup SET status = 'completed' WHERE mandate_ref = $1`, [mandateRef]);

    return { kind: 'active', memberId: pending.member_id };
  });

  // Entered into every draw already on sale, so the member sees it straight
  // away. The mandate is committed either way: if this fails, each draw still
  // enters them when it is run.
  if (result.kind === 'active') {
    await allocateUpcomingEntries(pool, { memberId: result.memberId, actorLabel: 'portal:direct-debit-setup' }).catch(() => undefined);
  }
  return result;
}

export interface DirectDebitStatus {
  readonly mandateRef: string | null;
  readonly since: Date;
}

/** The member's active Direct Debit, if any — what keeps them entered into every draw (GitHub #9). */
export async function getActiveDirectDebit(pool: Pool, memberId: string): Promise<DirectDebitStatus | undefined> {
  const { rows } = await pool.query<{ mandate_ref: string | null; created_at: Date }>(
    `SELECT mandate_ref, created_at FROM payment_method
      WHERE member_id = $1 AND type = 'direct_debit' AND active
        AND COALESCE(mandate_status, '') NOT IN ('cancelled', 'failed')
      ORDER BY created_at DESC LIMIT 1`,
    [memberId],
  );
  const row = rows[0];
  return row ? { mandateRef: row.mandate_ref, since: row.created_at } : undefined;
}

/**
 * Stops the member being entered into further draws by Direct Debit
 * (GitHub #9 — "until cancelled"). Its entries in draws still taking
 * entries are voided; draws whose entries have already closed keep them.
 *
 * GAP-10: the `BacsBureau` port has no cancellation call yet, so this is
 * recorded here only. Once a real bureau is chosen the mandate must also be
 * cancelled there, or collections would continue without entries.
 */
export async function cancelDirectDebit(pool: Pool, memberId: string): Promise<{ readonly cancelled: number }> {
  const { rowCount } = await pool.query(
    `UPDATE payment_method SET active = false, mandate_status = 'cancelled'
      WHERE member_id = $1 AND type = 'direct_debit' AND active`,
    [memberId],
  );
  const cancelled = rowCount ?? 0;
  if (cancelled > 0) {
    // Out of every draw still taking entries; any prepaid weeks the member
    // also holds then take those places.
    await voidDirectDebitEntries(pool, { memberId, reason: 'Direct Debit cancelled by member', actorLabel: 'portal:direct-debit-cancel' });
    await allocateUpcomingEntries(pool, { memberId, actorLabel: 'portal:direct-debit-cancel' }).catch(() => undefined);
  }
  return { cancelled };
}
