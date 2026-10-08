/**
 * Writes a legacy register plan (`planLegacyRegister`, packages/domain) —
 * T-11, the one-off load of QOSFC's register.
 *
 * All or nothing, in one transaction. It refuses a plan whose counts do not
 * reconcile (GAP-40), and it refuses to touch a prize draw number that is
 * already in `member_number`: FR-1.3 makes those immutable, so a second load
 * over the first is never an update — it is a mistake.
 *
 * Every number's `created_at` is the load time. GAP-13's week to choose
 * numbers runs from it, so a week after loading the random allocation sweep
 * gives every active player number with no numbers chosen its RANDOM.ORG
 * numbers and asks for a letter to be posted (the register holds no emails).
 */
import type { Pool } from '@qosfc/db';
import { withTransaction } from '@qosfc/db';
import type { LegacyRegisterCounts, LegacyRegisterPlan } from '@qosfc/domain';
import { writeAudit } from '../audit.js';

export interface ImportLegacyRegisterRequest {
  readonly plan: LegacyRegisterPlan;
  /** sha256 of the file the plan was read from — `member.source_file_hash` (T-11.2). */
  readonly sourceFileHash: string;
  /** Who ran the load, for the audit log. */
  readonly actorLabel: string;
}

export class LegacyRegisterAlreadyLoadedError extends Error {
  constructor(readonly existing: readonly number[]) {
    super(
      `${existing.length} prize draw number(s) in this register are already loaded ` +
        `(${existing.slice(0, 20).join(', ')}${existing.length > 20 ? ', …' : ''}). ` +
        'Prize draw numbers are immutable (FR-1.3); nothing was written.',
    );
  }
}

export async function importLegacyRegister(pool: Pool, request: ImportLegacyRegisterRequest): Promise<LegacyRegisterCounts> {
  const { plan, sourceFileHash, actorLabel } = request;
  if (plan.reconciliationFailures.length > 0) {
    throw new Error(`GAP-40: the register's counts do not reconcile, so nothing was written — ${plan.reconciliationFailures.join('; ')}`);
  }

  return withTransaction(pool, async (client) => {
    const { rows: existing } = await client.query<{ prize_draw_no: number }>(
      `SELECT prize_draw_no FROM member_number WHERE prize_draw_no = ANY($1::int[]) ORDER BY prize_draw_no`,
      [plan.numbers.map((n) => n.prizeDrawNo)],
    );
    if (existing.length > 0) throw new LegacyRegisterAlreadyLoadedError(existing.map((r) => r.prize_draw_no));

    const memberIds: string[] = [];
    for (const m of plan.members) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO member (status, title, forename, surname, address_1, address_2, address_3, post_code, post_code_valid,
                             telephone, preferred_contact, joining_date, migrated_from_row, source_file_hash, verify_flags)
         VALUES ($1::member_status, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'post', $11::date, $12, $13, $14::jsonb)
         RETURNING id`,
        [m.status, m.title, m.forename, m.surname, m.address1, m.address2, m.address3, m.postCode, m.postCodeValid,
          m.telephone, m.joiningDate, m.sourceRow, sourceFileHash, JSON.stringify(m.flags)],
      );
      memberIds.push(rows[0]!.id);
    }

    for (const n of plan.numbers) {
      const memberId = n.memberIndex === null ? null : memberIds[n.memberIndex]!;
      await client.query(
        `INSERT INTO member_number (prize_draw_no, member_id, row_type, legacy_agent, legacy_channel, legacy_payment_raw,
                                    legacy_amount_pence, legacy_frequency, legacy_status_text, legacy_info, migrated_from_row,
                                    legacy_payments_12m, legacy_total_12m_pence, legacy_observed_frequency)
         VALUES ($1, $2, $3, $4, $5::legacy_channel, $6, $7, $8::pay_frequency, $9, $10, $11, $12, $13, $14)`,
        [n.prizeDrawNo, memberId, n.rowType, n.legacyAgent, n.legacyChannel, n.legacyPaymentRaw,
          n.legacyAmountPence?.toString() ?? null, n.legacyFrequency, n.legacyStatusText, n.legacyInfo, n.sourceRow,
          n.payments12m, n.total12mPence?.toString() ?? null, n.observedFrequency],
      );

      // GAP-04: the standing order keeps running at the bank, unchanged. This
      // records it so bank matching recognises its amount and the jackpot
      // estimate counts it — the payment_method's reference is the number the
      // member quotes on it.
      if (n.standingOrder && memberId) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO payment_method (member_id, type, reference) VALUES ($1, 'standing_order', $2) RETURNING id`,
          [memberId, String(n.prizeDrawNo)],
        );
        await client.query(
          `INSERT INTO subscription (member_id, payment_method_id, amount_pence, frequency, annual_basis_pence, basis_source)
           VALUES ($1, $2, $3, $4::pay_frequency, $5, 'register')`,
          [memberId, rows[0]!.id, n.standingOrder.amountPence.toString(), n.standingOrder.frequency,
            n.standingOrder.annualBasisPence.toString()],
        );
      }
    }

    await writeAudit(client, {
      actorLabel,
      action: 'legacy_register.imported',
      entity: 'legacy_register',
      after: { sourceFileHash, counts: plan.counts, rejected: plan.rejected.length, findings: plan.findings.length },
    });
    return plan.counts;
  });
}
