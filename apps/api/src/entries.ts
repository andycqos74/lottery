/**
 * Online entry purchase (GAP-09, GAP-04) — "play online".
 *
 * GAP-09 (the real card acquirer) is unresolved, so this runs against the
 * sandbox `PaymentGateway` as a dummy transaction simulator: a real hosted
 * session, a real async webhook-shaped round trip, real declines — just not a
 * real bank. Swapping in a live acquirer later is a `PAYMENT_GATEWAY` env var
 * change (`providers.ts`), not a change to this file.
 *
 * Each purchase buys whole weeks (GAP-17 prepaid blocks) on one or more of
 * the member's lines (GitHub #19), the same number of weeks on each — see
 * `completeEntryPurchase`.
 */
import { withTransaction, type Pool } from '@qosfc/db';
import { idempotencyKey, type PaymentGateway } from '@qosfc/ports';
import { formatPence, pence, TICKET_PRICE_PENCE } from '@qosfc/domain';
import { allocateUpcomingEntries, describeLineOutcome, resolveLine, type ResolvedLine } from '@qosfc/activities';
import { getOpenDraw } from './db.js';

export type StartPurchaseOutcome =
  | { readonly kind: 'started'; readonly redirectUrl: string; readonly sessionId: string }
  | { readonly kind: 'rejected'; readonly reason: string };

// A member paying for more than one draw at once is buying prepaid blocks
// (GAP-17) exactly like a standing order or an agent-collected physical
// ticket does — these are the block sizes the payment page offers.
export const PURCHASE_BLOCK_SIZES = [1, 4, 12] as const;

/** GitHub #19: how many lines (sets of numbers) one card payment can buy. */
export const MAX_LINES_PER_PURCHASE = 5;

export type LinesOutcome = { readonly kind: 'ok'; readonly lines: number[][] } | { readonly kind: 'rejected'; readonly reason: string };

/**
 * The lines a member picked, each sorted, in the order picked. Lines left
 * completely empty are ignored (an unused picker on the page); anything
 * else must be four distinct numbers from 1 to 20. The same numbers twice
 * in one purchase are refused: a member never has two entries in one draw
 * with the same numbers.
 */
export function normaliseLines(raw: readonly (readonly number[])[]): LinesOutcome {
  const picked = raw.filter((line) => line.length > 0);
  if (picked.length === 0) return { kind: 'rejected', reason: 'Pick four numbers between 1 and 20.' };
  if (picked.length > MAX_LINES_PER_PURCHASE) {
    return { kind: 'rejected', reason: `You can buy up to ${MAX_LINES_PER_PURCHASE} lines of numbers at once.` };
  }
  const lines: number[][] = [];
  for (const [i, line] of picked.entries()) {
    const sorted = [...new Set(line)].sort((a, b) => a - b);
    if (sorted.length !== 4 || sorted.some((n) => !Number.isInteger(n) || n < 1 || n > 20)) {
      return {
        kind: 'rejected',
        reason: picked.length === 1 ? 'A selection must be four distinct numbers between 1 and 20.' : `Line ${i + 1} must be four distinct numbers between 1 and 20.`,
      };
    }
    const key = sorted.join(',');
    if (lines.some((l) => l.join(',') === key)) {
      return {
        kind: 'rejected',
        reason: `You've picked ${sorted.join(', ')} more than once. Each line needs different numbers — you can't have two entries in one draw with the same numbers.`,
      };
    }
    lines.push(sorted);
  }
  return { kind: 'ok', lines };
}

export async function startEntryPurchase(
  pool: Pool,
  gateway: PaymentGateway,
  input: { memberId: string; selections: readonly (readonly number[])[]; blocks: number; returnUrl: string; cancelUrl: string },
): Promise<StartPurchaseOutcome> {
  const checked = normaliseLines(input.selections);
  if (checked.kind === 'rejected') return checked;
  const { lines } = checked;
  if (!PURCHASE_BLOCK_SIZES.includes(input.blocks as (typeof PURCHASE_BLOCK_SIZES)[number])) {
    return { kind: 'rejected', reason: 'Choose 1, 4, or 12 draws.' };
  }

  const draw = await getOpenDraw(pool);
  if (!draw) {
    return { kind: 'rejected', reason: 'No draw is currently open for entries.' };
  }

  // Every line is bought for the same number of draws.
  const amountPence = (TICKET_PRICE_PENCE * BigInt(input.blocks) * BigInt(lines.length)).toString();
  const session = await gateway.createHostedSession({
    idempotencyKey: idempotencyKey(`entry-purchase:${input.memberId}:${draw.id}:${lines.map((l) => l.join('-')).join('+')}:${input.blocks}`),
    amountPence,
    currency: 'GBP',
    // An identifier only — never a member name (T-1.3).
    reference: `entry:${input.memberId}:${draw.id}`,
    returnUrl: input.returnUrl,
    cancelUrl: input.cancelUrl,
  });

  await pool.query(
    `INSERT INTO pending_entry_purchase (session_id, member_id, draw_id, selection, selections, amount_pence, blocks)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (session_id) DO NOTHING`,
    [session.sessionId, input.memberId, draw.id, lines[0], lines, amountPence, input.blocks],
  );

  return { kind: 'started', redirectUrl: session.redirectUrl, sessionId: session.sessionId };
}

/**
 * What to tell the member about a purchase, read back from what was done.
 * Several lines get a sentence saying what the payment covered, then one
 * paragraph per line.
 */
async function describePurchase(
  pool: Pool,
  memberId: string,
  lines: readonly ResolvedLine[],
  selections: readonly (readonly number[])[],
  weeks: number,
): Promise<string> {
  if (lines.length === 1) {
    return describeLineOutcome(pool, { memberId, line: lines[0]!, selection: selections[0]!, event: { kind: 'card', weeks } });
  }
  const total = formatPence(pence(TICKET_PRICE_PENCE * BigInt(weeks) * BigInt(lines.length)));
  const each: string[] = [];
  for (const [i, line] of lines.entries()) {
    each.push(await describeLineOutcome(pool, { memberId, line, selection: selections[i]!, event: { kind: 'card', weeks, ofSeveral: true } }));
  }
  return [`Thank you — your ${total} payment covers ${lines.length} lines of numbers, ${weeks} draw${weeks === 1 ? '' : 's'} each.`, ...each].join('\n\n');
}

export type CompletePurchaseOutcome =
  | {
      readonly kind: 'purchased';
      readonly memberId: string;
      /** Every line bought, in the order picked. */
      readonly selections: readonly (readonly number[])[];
      readonly amountPence: string;
      readonly blocks: number;
      /** What was done with the purchase, in plain words, for the member. */
      readonly message: string;
    }
  | { readonly kind: 'already_completed'; readonly message: string }
  | { readonly kind: 'payment_failed'; readonly reason: string }
  | { readonly kind: 'pending' }
  | { readonly kind: 'not_found' };

/**
 * Called from the member's return-from-redirect request AND independently
 * from the sandbox's webhook (once wired) — a browser that never comes back
 * must not lose a payment. Idempotent: a session already resolved returns
 * what actually happened rather than acting twice.
 *
 * The payment buys weeks on a line (db/migrations/0018): the member's
 * existing line if these are numbers they already have — more weeks — or a
 * new line if not — an extra entry alongside. Paid weeks are always used
 * before any Direct Debit on the same line, which pauses meanwhile.
 * `allocateUpcomingEntries` then places the entries in the draws on sale.
 */
export async function completeEntryPurchase(
  pool: Pool,
  gateway: PaymentGateway,
  sessionId: string,
): Promise<CompletePurchaseOutcome> {
  const { rows } = await pool.query<{
    member_id: string;
    selection: number[];
    selections: number[][] | null;
    amount_pence: string;
    blocks: number;
    status: string;
    outcome_message: string | null;
  }>(
    `SELECT member_id, selection, selections, amount_pence, blocks, status, outcome_message FROM pending_entry_purchase WHERE session_id = $1`,
    [sessionId],
  );
  const pending = rows[0];
  if (!pending) return { kind: 'not_found' };
  // Purchases started before 0019 bought one line.
  const selections = pending.selections ?? [pending.selection];
  if (pending.status === 'completed') return { kind: 'already_completed', message: pending.outcome_message ?? 'Payment received.' };
  if (pending.status === 'failed') return { kind: 'payment_failed', reason: 'Payment was not successful.' };

  const outcome = await gateway.getPaymentStatus(sessionId);
  if (outcome.status === 'pending') return { kind: 'pending' };
  if (outcome.status === 'failed') {
    await pool.query(`UPDATE pending_entry_purchase SET status = 'failed' WHERE session_id = $1`, [sessionId]);
    return { kind: 'payment_failed', reason: outcome.reason };
  }

  const recorded = await withTransaction(pool, async (client) => {
    // Re-check under the transaction: the webhook and the return request can race.
    const { rows: recheck } = await client.query<{ status: string; outcome_message: string | null }>(
      `SELECT status, outcome_message FROM pending_entry_purchase WHERE session_id = $1 FOR UPDATE`,
      [sessionId],
    );
    if (recheck[0]!.status === 'completed') return { done: true as const, message: recheck[0]!.outcome_message ?? 'Payment received.' };

    // One payment row per line, so each line's weeks are counted on that line
    // (0018); together they add up to the one card charge. The first keeps
    // the key a single-line purchase has always had.
    const linePence = BigInt(pending.amount_pence) / BigInt(selections.length);
    const lines: ResolvedLine[] = [];
    for (const [i, selection] of selections.entries()) {
      const line = await resolveLine(client, pending.member_id, selection);
      await client.query(
        `INSERT INTO payment (member_id, channel, received_date, amount_pence, status, idempotency_key, line_prize_draw_no, line_slot)
         VALUES ($1,'card',CURRENT_DATE,$2,'allocated',$3,$4,$5)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [pending.member_id, linePence.toString(), i === 0 ? `entry-purchase:${sessionId}` : `entry-purchase:${sessionId}:${i + 1}`, line.prizeDrawNo, line.slot],
      );
      lines.push(line);
    }
    await client.query(`UPDATE pending_entry_purchase SET status = 'completed' WHERE session_id = $1`, [sessionId]);
    return { done: false as const, lines };
  });
  if (recorded.done) return { kind: 'already_completed', message: recorded.message };

  // The payment is committed. If placing entries can't run now, each draw
  // still picks its week up when it is run, so this must not fail the purchase.
  await allocateUpcomingEntries(pool, { memberId: pending.member_id, actorLabel: 'portal:card-purchase' }).catch(() => undefined);
  const message = await describePurchase(pool, pending.member_id, recorded.lines, selections, pending.blocks);
  await pool.query(`UPDATE pending_entry_purchase SET outcome_message = $2 WHERE session_id = $1`, [sessionId, message]);

  return {
    kind: 'purchased',
    memberId: pending.member_id,
    selections,
    amountPence: pending.amount_pence,
    blocks: pending.blocks,
    message,
  };
}
