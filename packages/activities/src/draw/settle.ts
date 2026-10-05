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
import {
  pence,
  resolveMustBeWon,
  settleOutcome,
  shareJackpot,
  type Pence,
  type SharedJackpot,
  type SharePolicy,
  type WinningEntry,
} from '@qosfc/domain';
import { writeAudit } from '../audit.js';
import { fetchRollDownTiers } from './winners.js';

export interface SettleDrawRequest {
  readonly drawId: string;
  readonly winningEntries: readonly WinningEntry[];
  /** Pence crosses the Temporal wire as a string — bigint isn't JSON-serialisable. */
  readonly jackpotPreDrawPence: string;
  /**
   * GitHub #10: what this draw carried in from the previous one, and what the
   * floor added on top. Optional only so a workflow started before these
   * existed can still settle; absent means zero.
   */
  readonly rolloverInPence?: string;
  readonly floorTopupPence?: string;
  /**
   * GAP-24: the must-be-won cap was reached with no match-4 winner, so the
   * jackpot rolls down to the first of match 3 → 2 → 1 with a winning entry
   * (`resolveMustBeWon`). The tiers are read here, from the frozen entry set,
   * rather than passed in. Only valid with no `winningEntries`.
   */
  readonly mustBeWonRollDown?: boolean;
}

export interface SettleDrawResult {
  readonly winnersCount: number;
  /** Set when the must-be-won roll-down paid: which tier won. */
  readonly mustBeWonTier?: 3 | 2 | 1;
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
      must_be_won_decision: { tier?: 3 | 2 | 1 } | null;
    }>(
      `SELECT status, winners_count, jackpot_paid_pence, rollover_out_pence, must_be_won_decision
         FROM draw WHERE id = $1 FOR UPDATE`,
      [request.drawId],
    );
    const draw = existing.rows[0];
    if (!draw) throw new Error(`Draw ${request.drawId} does not exist.`);

    if (draw.status === 'settled') {
      return {
        winnersCount: draw.winners_count ?? 0,
        jackpotPaidPence: (draw.jackpot_paid_pence ?? 0n).toString(),
        rolloverOutPence: (draw.rollover_out_pence ?? 0n).toString(),
        ...(draw.must_be_won_decision?.tier ? { mustBeWonTier: draw.must_be_won_decision.tier } : {}),
      };
    }

    if (request.mustBeWonRollDown && request.winningEntries.length > 0) {
      throw new Error('A must-be-won roll-down only applies when nobody matched all four numbers.');
    }

    const jackpotPreDrawPence = pence(BigInt(request.jackpotPreDrawPence));
    // GAP-24: resolveMustBeWon() throws UnresolvedGapError if no tier has an
    // entry — the workflow checks for that residual case and blocks for a
    // human before ever asking for a roll-down, so reaching it here is a bug.
    const rollDown = request.mustBeWonRollDown
      ? resolveMustBeWon(jackpotPreDrawPence, await fetchRollDownTiers(client, request.drawId))
      : undefined;
    const winnersCount = rollDown ? rollDown.shared.shares.length : request.winningEntries.length;
    const outcome = settleOutcome(jackpotPreDrawPence, winnersCount);
    const txnId = randomUUID();

    // Runs net negative until entry-purchase-time revenue recognition posts
    // credits here — a later, unbuilt phase (GAP-09/10/27). Expected, not a bug.
    const prizeFundId = await getOrCreateSingletonAccount(client, 'prize_fund', 'Prize fund');

    // GitHub #10: the rollover this draw's jackpot was built on leaves the
    // rollover account and joins the prize fund, so the money a no-winner
    // draw rolled forward is paid out (or rolled on again) from here.
    const rolloverInPence = pence(BigInt(request.rolloverInPence ?? '0'));
    if (rolloverInPence > 0n) {
      const rolloverAccountId = await getOrCreateSingletonAccount(client, 'rollover', 'Rollover');
      await postLeg(client, {
        txnId,
        accountId: rolloverAccountId,
        amountPence: pence(-rolloverInPence),
        drawId: request.drawId,
        description: `Rollover out to draw ${request.drawId}`,
      });
      await postLeg(client, {
        txnId,
        accountId: prizeFundId,
        amountPence: rolloverInPence,
        drawId: request.drawId,
        description: `Rollover in — draw ${request.drawId}`,
      });
    }

    if (rollDown) {
      await payShares(client, { txnId, prizeFundId, drawId: request.drawId, jackpotPaidPence: outcome.jackpotPaidPence, shared: rollDown.shared });
    } else if (winnersCount > 0) {
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
      await payShares(client, { txnId, prizeFundId, drawId: request.drawId, jackpotPaidPence: outcome.jackpotPaidPence, shared });
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
              rollover_out_pence = $4, settled_at = now(),
              jackpot_pre_draw_pence = $5, rollover_in_pence = $6, floor_topup_pence = $7,
              must_be_won_triggered = must_be_won_triggered OR $8, must_be_won_decision = COALESCE($9, must_be_won_decision)
        WHERE id = $1`,
      [
        request.drawId,
        winnersCount,
        outcome.jackpotPaidPence,
        outcome.rolloverOutPence,
        jackpotPreDrawPence,
        rolloverInPence,
        BigInt(request.floorTopupPence ?? '0'),
        rollDown !== undefined,
        rollDown ? JSON.stringify({ rule: 'GAP-24 roll-down: match 3 → 2 → 1, split equally per winner', tier: rollDown.tier }) : null,
      ],
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
        rolloverInPence: rolloverInPence.toString(),
        jackpotPreDrawPence: jackpotPreDrawPence.toString(),
        ...(rollDown ? { mustBeWonTier: rollDown.tier } : {}),
      },
    });

    return {
      winnersCount,
      jackpotPaidPence: outcome.jackpotPaidPence.toString(),
      rolloverOutPence: outcome.rolloverOutPence.toString(),
      ...(rollDown ? { mustBeWonTier: rollDown.tier } : {}),
    };
  });
}

/**
 * Pay a won jackpot out of the prize fund: one prize row and member-balance
 * leg per share, and any indivisible remainder to wherever the policy sends
 * it. The same postings whether the jackpot was won outright or rolled down
 * under GAP-24.
 */
async function payShares(
  client: PoolClient,
  args: { txnId: string; prizeFundId: string; drawId: string; jackpotPaidPence: Pence; shared: SharedJackpot },
): Promise<void> {
  const { txnId, prizeFundId, drawId, shared } = args;
  await postLeg(client, {
    txnId,
    accountId: prizeFundId,
    amountPence: pence(-args.jackpotPaidPence),
    drawId,
    description: `Jackpot paid out — draw ${drawId}`,
  });

  for (const share of shared.shares) {
    const memberAccountId = await getOrCreateMemberBalanceAccount(client, share.memberId);
    await postLeg(client, {
      txnId,
      accountId: memberAccountId,
      amountPence: share.amountPence,
      drawId,
      entryId: share.entryId,
      description: `Prize share — draw ${drawId}`,
    });
    await client.query(
      `INSERT INTO prize (draw_id, entry_id, member_id, amount_pence, status)
       VALUES ($1, $2, $3, $4, 'pending_notification')`,
      [drawId, share.entryId, share.memberId, share.amountPence],
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
      drawId,
      description: `Indivisible remainder to ${destKind} — draw ${drawId}`,
    });
  }
}
