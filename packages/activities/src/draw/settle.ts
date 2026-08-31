/**
 * Draw settlement — Phase 6 (functional spec §5.3/§11, technical spec §4.4/§5.1).
 *
 * Writes the draw row, its ledger postings and its prize rows together, in one
 * transaction (T-5.2) — the deferred `ledger_txn_must_balance` trigger requires
 * every leg of one economic transaction to be inserted before commit.
 *
 * Idempotent by construction, exactly like `generateWinningNumbers` (T-12.4:
 * "worker killed between generate_winning_numbers and settle_draw" must not
 * double-pay): if the draw is already settled, this returns the figures
 * already committed to `draw`, without recomputing — so a retried activity can
 * never report a different result than what was actually paid, even if the
 * share policy changes between the original run and the retry.
 */
import { randomUUID } from 'node:crypto';
import { withTransaction, type Pool } from '@qosfc/db';
import type { PoolClient } from 'pg';
import { pence, settleOutcome, shareJackpot, type Pence, type SharePolicy, type WinningEntry } from '@qosfc/domain';
import { writeAudit } from '../audit.js';

export interface SettleDrawRequest {
  readonly drawId: string;
  readonly winningEntries: readonly WinningEntry[];
  /** Pence crosses the Temporal wire as a string — bigint isn't JSON-serialisable. */
  readonly jackpotPreDrawPence: string;
}

export interface SettleDrawResult {
  readonly winnersCount: number;
  readonly jackpotPaidPence: string;
  readonly rolloverOutPence: string;
}

async function getOrCreateSingletonAccount(client: PoolClient, kind: string, name: string): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO ledger_account (kind, name) VALUES ($1, $2)
     ON CONFLICT (kind) WHERE member_id IS NULL DO NOTHING
     RETURNING id`,
    [kind, name],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM ledger_account WHERE kind = $1 AND member_id IS NULL`,
    [kind],
  );
  return existing.rows[0]!.id;
}

async function getOrCreateMemberBalanceAccount(client: PoolClient, memberId: string): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO ledger_account (kind, member_id, name) VALUES ('member_balance', $1, 'Member balance')
     ON CONFLICT (kind, member_id) WHERE member_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [memberId],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM ledger_account WHERE kind = 'member_balance' AND member_id = $1`,
    [memberId],
  );
  return existing.rows[0]!.id;
}

/** Only inserts a ledger leg when money actually moves — a zero-pence line is not a real posting. */
async function postLeg(
  client: PoolClient,
  args: { txnId: string; accountId: string; amountPence: Pence; drawId: string; entryId?: string; description: string },
): Promise<void> {
  if (args.amountPence === 0n) return;
  await client.query(
    `INSERT INTO ledger_entry (txn_id, account_id, amount_pence, draw_id, entry_id, description)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [args.txnId, args.accountId, args.amountPence, args.drawId, args.entryId ?? null, args.description],
  );
}

export async function settleDraw(pool: Pool, request: SettleDrawRequest): Promise<SettleDrawResult> {
  return withTransaction(pool, async (client) => {
    const existing = await client.query<{
      status: string;
      winners_count: number | null;
      jackpot_paid_pence: bigint | null;
      rollover_out_pence: bigint | null;
    }>(`SELECT status, winners_count, jackpot_paid_pence, rollover_out_pence FROM draw WHERE id = $1 FOR UPDATE`, [
      request.drawId,
    ]);
    const draw = existing.rows[0];
    if (!draw) throw new Error(`Draw ${request.drawId} does not exist.`);

    if (draw.status === 'settled') {
      return {
        winnersCount: draw.winners_count ?? 0,
        jackpotPaidPence: (draw.jackpot_paid_pence ?? 0n).toString(),
        rolloverOutPence: (draw.rollover_out_pence ?? 0n).toString(),
      };
    }

    const jackpotPreDrawPence = pence(BigInt(request.jackpotPreDrawPence));
    const winnersCount = request.winningEntries.length;
    const outcome = settleOutcome(jackpotPreDrawPence, winnersCount);
    const txnId = randomUUID();

    // Runs net negative until entry-purchase-time revenue recognition posts
    // credits here — a later, unbuilt phase (GAP-09/10/27). Expected, not a bug.
    const prizeFundId = await getOrCreateSingletonAccount(client, 'prize_fund', 'Prize fund');

    if (winnersCount > 0) {
      const { rows: configRows } = await client.query<{
        share_basis: 'per_winning_entry' | 'per_winner' | null;
        share_remainder_rule: 'largest_remainder_to_winners' | 'to_rollover' | 'to_good_cause' | null;
        share_policy_confirmed_by: string | null;
      }>(
        `SELECT share_basis, share_remainder_rule, share_policy_confirmed_by
           FROM config_version WHERE is_active = true`,
      );
      const config = configRows[0];
      // GAP-22/23: an unconfirmed policy on a winning draw is an operational
      // precondition failure, not a runtime business event (unlike GAP-24) — it
      // should have been resolved before any draw ran. shareJackpot() throws
      // UnresolvedGapError below; that's deliberate. Fix the config, don't retry
      // — every retry will fail identically until it is.
      const policy: SharePolicy | undefined = config?.share_basis
        ? {
            basis: config.share_basis,
            remainder: config.share_remainder_rule!,
            ...(config.share_policy_confirmed_by ? { confirmedBy: config.share_policy_confirmed_by } : {}),
          }
        : undefined;

      const shared = shareJackpot(outcome.jackpotPaidPence, request.winningEntries, policy);

      await postLeg(client, {
        txnId,
        accountId: prizeFundId,
        amountPence: pence(-outcome.jackpotPaidPence),
        drawId: request.drawId,
        description: `Jackpot paid out — draw ${request.drawId}`,
      });

      for (const share of shared.shares) {
        const memberAccountId = await getOrCreateMemberBalanceAccount(client, share.memberId);
        await postLeg(client, {
          txnId,
          accountId: memberAccountId,
          amountPence: share.amountPence,
          drawId: request.drawId,
          entryId: share.entryId,
          description: `Prize share — draw ${request.drawId}`,
        });
        await client.query(
          `INSERT INTO prize (draw_id, entry_id, member_id, amount_pence, status)
           VALUES ($1, $2, $3, $4, 'pending_notification')`,
          [request.drawId, share.entryId, share.memberId, share.amountPence],
        );
      }

      if (shared.remainderPence > 0n) {
        const destKind = shared.remainderDestination === 'good_cause' ? 'good_cause' : 'rollover';
        const destName = destKind === 'good_cause' ? 'Good cause' : 'Rollover';
        const destAccountId = await getOrCreateSingletonAccount(client, destKind, destName);
        await postLeg(client, {
          txnId,
          accountId: destAccountId,
          amountPence: shared.remainderPence,
          drawId: request.drawId,
          description: `Indivisible remainder to ${destKind} — draw ${request.drawId}`,
        });
      }
    } else {
      const rolloverId = await getOrCreateSingletonAccount(client, 'rollover', 'Rollover');
      await postLeg(client, {
        txnId,
        accountId: prizeFundId,
        amountPence: pence(-outcome.rolloverOutPence),
        drawId: request.drawId,
        description: `Unwon jackpot rolled forward — draw ${request.drawId}`,
      });
      await postLeg(client, {
        txnId,
        accountId: rolloverId,
        amountPence: outcome.rolloverOutPence,
        drawId: request.drawId,
        description: `Rollover in from draw ${request.drawId}`,
      });
    }

    await client.query(
      `UPDATE draw
          SET status = 'settled', winners_count = $2, jackpot_paid_pence = $3,
              rollover_out_pence = $4, settled_at = now()
        WHERE id = $1`,
      [request.drawId, winnersCount, outcome.jackpotPaidPence, outcome.rolloverOutPence],
    );

    await writeAudit(client, {
      actorLabel: 'system',
      action: 'draw.settled',
      entity: 'draw',
      entityId: request.drawId,
      after: {
        winnersCount,
        jackpotPaidPence: outcome.jackpotPaidPence.toString(),
        rolloverOutPence: outcome.rolloverOutPence.toString(),
      },
    });

    return {
      winnersCount,
      jackpotPaidPence: outcome.jackpotPaidPence.toString(),
      rolloverOutPence: outcome.rolloverOutPence.toString(),
    };
  });
}
