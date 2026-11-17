/**
 * Writes a legacy standing-order opening credit (`planOpeningCredit`,
 * packages/domain) — switch-over decision D2 (c), gap G1 in
 * docs/SWITCHOVER_DRY_RUN.md. Run once, after the register is loaded and
 * the draws are created.
 *
 * Each prize draw number with weeks left at the cut-off gets one payment:
 * channel `so_fps` (it was standing-order money), worth weeks × £2,
 * `allocation_method = 'legacy_opening_credit'`, attributed to that
 * number's line. That is exactly the shape of matched standing-order money,
 * so `allocateUpcomingEntries` places the weeks in the open draws, soonest
 * first, with no special case — and a number whose numbers are not chosen
 * yet keeps its weeks until GAP-13 gives it some.
 *
 * Idempotent per number (`legacy_opening_credit:<prize draw no>`): running
 * it again never adds a second credit, and never changes one already made —
 * a number already credited is reported, not topped up.
 *
 * It refuses to run when the new system already holds bank statement credits
 * dated on or before the cut-off. Those were matched (or are waiting to be)
 * as new-lottery money at full value, without the old draws they paid for
 * taken off — counting them again here would pay those weeks twice.
 */
import type { Pool } from '@qosfc/db';
import { withTransaction } from '@qosfc/db';
import type { LegacyFrequency, OpeningCreditNumber, OpeningCreditPlan } from '@qosfc/domain';
import { pence } from '@qosfc/domain';
import { writeAudit } from '../audit.js';
import { allocateUpcomingEntries, type AllocateUpcomingEntriesResult } from '../draw/allocate-upcoming.js';

export const OPENING_CREDIT_METHOD = 'legacy_opening_credit';
const idempotencyKey = (prizeDrawNo: number) => `${OPENING_CREDIT_METHOD}:${prizeDrawNo}`;

/** Every loaded member number, with the standing order the register recorded on it. */
export async function loadOpeningCreditNumbers(pool: Pool): Promise<OpeningCreditNumber[]> {
  const { rows } = await pool.query<{
    prize_draw_no: number;
    member_id: string;
    status: string;
    name: string;
    amount_pence: string | null;
    frequency: LegacyFrequency | null;
  }>(
    `SELECT mn.prize_draw_no, mn.member_id, m.status::text AS status,
            concat_ws(' ', m.forename, m.surname) AS name, so.amount_pence::text AS amount_pence, so.frequency::text AS frequency
       FROM member_number mn
       JOIN member m ON m.id = mn.member_id
       LEFT JOIN LATERAL (
         SELECT s.amount_pence, s.frequency FROM payment_method pm JOIN subscription s ON s.payment_method_id = pm.id
          WHERE pm.member_id = mn.member_id AND pm.type = 'standing_order' AND pm.reference = mn.prize_draw_no::text
            AND s.status = 'active'
          ORDER BY s.created_at LIMIT 1
       ) so ON true
      WHERE mn.row_type = 'member'
      ORDER BY mn.prize_draw_no`,
  );
  return rows.map((r) => ({
    prizeDrawNo: r.prize_draw_no,
    memberId: r.member_id,
    memberName: r.name,
    memberStatus: r.status,
    standingOrder: r.amount_pence !== null && r.frequency !== null ? { amountPence: pence(BigInt(r.amount_pence)), frequency: r.frequency } : null,
  }));
}

/** Bank statement credits the new system already holds, dated on or before the cut-off. Must be none. */
export async function countImportedCreditsUpTo(pool: Pool, cutoff: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM bank_transaction WHERE is_credit AND value_date <= $1::date`,
    [cutoff],
  );
  return Number(rows[0]!.n);
}

/** Numbers that already have an opening credit, and what it was. */
export async function existingOpeningCredits(pool: Pool): Promise<Map<number, { weeks: number; amountPence: bigint }>> {
  const { rows } = await pool.query<{ prize_draw_no: number; amount_pence: string }>(
    `SELECT line_prize_draw_no AS prize_draw_no, amount_pence::text FROM payment WHERE allocation_method = $1`,
    [OPENING_CREDIT_METHOD],
  );
  return new Map(rows.map((r) => [r.prize_draw_no, { amountPence: BigInt(r.amount_pence), weeks: Number(BigInt(r.amount_pence) / 200n) }]));
}

export class OpeningCreditOverlapError extends Error {
  constructor(readonly count: number, readonly cutoff: string) {
    super(
      `The system already holds ${count} bank statement credit(s) dated on or before the cut-off (${cutoff}). ` +
        'Those are counted as new-lottery money at full value, so an opening credit on top would pay for the same weeks twice. ' +
        'Statements uploaded on the Bank statements page must start the day after the cut-off. Nothing was written.',
    );
  }
}

export class OpeningCreditUnresolvedError extends Error {
  constructor(readonly count: number) {
    super(
      `${count} credit(s) in the statements are not tied to a prize draw number. Assign each one (or mark it "ignore") ` +
        'in the exception report and pass it back, or accept leaving them out explicitly. Nothing was written.',
    );
  }
}

export interface ApplyOpeningCreditRequest {
  readonly plan: OpeningCreditPlan;
  /** sha256 of each statement file the plan was read from, for the audit log. */
  readonly sourceFileHashes: readonly string[];
  readonly actorLabel: string;
  readonly actorId?: string;
  /** Write the credits even though some statement credits are still unassigned. */
  readonly allowUnresolved?: boolean;
}

export interface ApplyOpeningCreditResult {
  readonly numbersCredited: number;
  readonly weeksCredited: number;
  /** Numbers that already had an opening credit: left exactly as they were. */
  readonly alreadyCredited: readonly { readonly prizeDrawNo: number; readonly weeksBefore: number; readonly weeksNow: number }[];
  /** The upcoming-entries run that placed the weeks — or why it could not run (the credits stand either way). */
  readonly allocation: AllocateUpcomingEntriesResult | { readonly error: string };
}

export async function applyOpeningCredit(pool: Pool, request: ApplyOpeningCreditRequest): Promise<ApplyOpeningCreditResult> {
  const { plan } = request;
  if (plan.exceptions.length > 0 && !request.allowUnresolved) throw new OpeningCreditUnresolvedError(plan.exceptions.length);

  const written = await withTransaction(pool, async (client) => {
    // Serialise against a statement upload happening at the same moment.
    await client.query(`LOCK TABLE bank_transaction IN SHARE MODE`);
    const { rows: overlap } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM bank_transaction WHERE is_credit AND value_date <= $1::date`,
      [plan.cutoff],
    );
    if (Number(overlap[0]!.n) > 0) throw new OpeningCreditOverlapError(Number(overlap[0]!.n), plan.cutoff);

    let numbersCredited = 0;
    let weeksCredited = 0;
    const alreadyCredited: { prizeDrawNo: number; weeksBefore: number; weeksNow: number }[] = [];
    for (const line of plan.lines) {
      if (line.weeks <= 0) continue;
      const evidence = {
        cutoff: plan.cutoff,
        firstDraw: plan.firstDraw,
        window: [plan.windowStart, plan.windowEnd],
        oldDrawWeekday: plan.oldDrawWeekday,
        payments: line.payments.map((p) => ({ externalId: p.externalId, valueDate: p.valueDate, amountPence: p.amountPence.toString(), matchedBy: p.matchedBy })),
        paidPence: line.paidPence.toString(),
        oldDrawsCovered: line.oldDrawsCovered,
        balancePence: line.balancePence.toString(),
        residualPence: line.residualPence.toString(),
        flags: line.flags,
      };
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO payment (member_id, channel, received_date, amount_pence, source_reference, allocation_confidence, allocation_method,
                              allocation_evidence, status, idempotency_key, line_prize_draw_no, line_slot)
         SELECT mn.member_id, 'so_fps', $2::date, $3, $4, 1, $5, $6::jsonb, 'allocated', $7, mn.prize_draw_no, 1
           FROM member_number mn WHERE mn.prize_draw_no = $1 AND mn.member_id = $8
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [
          line.prizeDrawNo,
          plan.cutoff,
          line.creditPence.toString(),
          `Opening credit: ${line.weeks} week${line.weeks === 1 ? '' : 's'} paid before the switch-over`,
          OPENING_CREDIT_METHOD,
          JSON.stringify(evidence),
          idempotencyKey(line.prizeDrawNo),
          line.memberId,
        ],
      );
      if (rows[0]) {
        numbersCredited++;
        weeksCredited += line.weeks;
        continue;
      }
      const { rows: before } = await client.query<{ amount_pence: string; member_id: string }>(
        `SELECT amount_pence::text, member_id FROM payment WHERE idempotency_key = $1`,
        [idempotencyKey(line.prizeDrawNo)],
      );
      if (!before[0]) throw new Error(`Prize draw number ${line.prizeDrawNo} is no longer ${line.memberId}'s — re-run the plan. Nothing was written.`);
      alreadyCredited.push({ prizeDrawNo: line.prizeDrawNo, weeksBefore: Number(BigInt(before[0].amount_pence) / 200n), weeksNow: line.weeks });
    }

    await writeAudit(client, {
      ...(request.actorId ? { actorId: request.actorId } : {}),
      actorLabel: request.actorLabel,
      action: 'legacy_opening_credit.applied',
      entity: 'legacy_register',
      after: {
        cutoff: plan.cutoff,
        firstDraw: plan.firstDraw,
        window: [plan.windowStart, plan.windowEnd],
        sourceFileHashes: request.sourceFileHashes,
        numbersCredited,
        weeksCredited,
        alreadyCredited: alreadyCredited.length,
        unresolvedCredits: plan.exceptions.length,
      },
    });
    return { numbersCredited, weeksCredited, alreadyCredited };
  });

  // The weeks enter the open draws now, so Draw 1 shows them before it runs.
  // Not fatal: the credits are committed, and running each draw enters anyone
  // with weeks left (e.g. if GAP-17's entry strategy isn't confirmed yet).
  const allocation = await allocateUpcomingEntries(pool, { actorLabel: request.actorLabel, ...(request.actorId ? { actorId: request.actorId } : {}) }).catch(
    (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
  );
  return { ...written, allocation };
}
