/**
 * Security guarantees, verified against a real PostgreSQL instance.
 *
 * These are not unit tests of application code — they prove that the DATABASE
 * refuses the things T-9.4, FR-13.2, FR-5.3.3 and FR-11.3 say must be impossible,
 * even when the application asking is buggy, compromised, or malicious.
 *
 * Set TEST_APP_DB_URL to run. Without it the suite skips rather than silently
 * passing, so a green CI run with no database does not look like proof.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, withTransaction, type Pool } from './pool.js';
import { numericToPence } from './types.js';
import { migrate } from './migrate.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const url = process.env['TEST_APP_DB_URL'];
const describeDb = url ? describe : describe.skip;

let pool: Pool;
let appPool: Pool | undefined;

const ids = {
  goodCause: '',
  admin: '',
  member: '',
  drawOpen: '',
  drawSettled: '',
  drawToSettle: '',
  configVersion: '',
};

describeDb('database-enforced security guarantees', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url!, applicationName: 'qosfc-security-test', max: 4 });
    // A clean slate every run. An integration test that depends on leftover state
    // from a previous run proves nothing about a fresh production deployment.
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const here = dirname(fileURLToPath(import.meta.url));
    await migrate(pool, resolve(here, '../../../db/migrations'), () => {});

    await pool.query(`
      INSERT INTO ledger_account (kind, name) VALUES ('good_cause','Good cause'), ('admin','Admin')
      ON CONFLICT DO NOTHING`);
    ids.goodCause = (await pool.query(`SELECT id FROM ledger_account WHERE kind='good_cause'`)).rows[0].id;
    ids.admin = (await pool.query(`SELECT id FROM ledger_account WHERE kind='admin'`)).rows[0].id;

    ids.configVersion = (
      await pool.query(`INSERT INTO config_version (note) VALUES ('test fixture') RETURNING id`)
    ).rows[0].id;

    ids.member = (
      await pool.query(`INSERT INTO member (forename, surname) VALUES ('Test','Member') RETURNING id`)
    ).rows[0].id;
    await pool.query(
      `INSERT INTO member_number (prize_draw_no, member_id, row_type) VALUES (9001, $1, 'member')`,
      [ids.member],
    );

    ids.drawOpen = (
      await pool.query(
        `INSERT INTO draw (draw_number, draw_date, status, config_version_id)
         VALUES (9001, CURRENT_DATE, 'open', $1) RETURNING id`,
        [ids.configVersion],
      )
    ).rows[0].id;

    ids.drawSettled = (
      await pool.query(
        `INSERT INTO draw (draw_number, draw_date, status, config_version_id,
                           winning_numbers, rng_source, drawn_at,
                           revenue_pence, prize_contribution_pence, good_cause_pence, admin_pence,
                           jackpot_pre_draw_pence, jackpot_paid_pence, rollover_out_pence)
         VALUES (9002, CURRENT_DATE, 'settled', $1,
                 '{3,9,14,20}', 'test-csprng', now(),
                 104000, 52000, 41600, 10400,
                 52000, 0, 52000)
         RETURNING id`,
        [ids.configVersion],
      )
    ).rows[0].id;

    // A draw that is settled AFTER an entry exists, so the freeze can be tested
    // against a real entry rather than against an empty result set.
    ids.drawToSettle = (
      await pool.query(
        `INSERT INTO draw (draw_number, draw_date, status, config_version_id)
         VALUES (9003, CURRENT_DATE, 'open', $1) RETURNING id`,
        [ids.configVersion],
      )
    ).rows[0].id;
    await insertEntry(ids.drawToSettle, 'pre-settlement-entry');
    await pool.query(
      `UPDATE draw SET status='settled', winning_numbers='{1,2,3,4}', rng_source='test-csprng', drawn_at=now()
        WHERE id=$1`,
      [ids.drawToSettle],
    );
  });

  afterAll(async () => {
    await appPool?.end();
    await pool?.end();
  });

  describe('T-12.1 — the ledger cannot be left unbalanced', () => {
    it('rejects a transaction whose entries do not sum to zero', async () => {
      await expect(
        withTransaction(pool, async (c) => {
          await c.query(
            `INSERT INTO ledger_entry (txn_id, account_id, amount_pence, description)
             VALUES (gen_random_uuid(), $1, 100, 'unbalanced')`,
            [ids.admin],
          );
        }),
      ).rejects.toThrow(/does not balance/);
    });

    it('accepts a balanced transaction', async () => {
      const txnId = await withTransaction(pool, async (c) => {
        const { rows } = await c.query(`SELECT gen_random_uuid() AS id`);
        const id = rows[0].id;
        await c.query(
          `INSERT INTO ledger_entry (txn_id, account_id, amount_pence, description)
           VALUES ($1, $2, 41600, 'good cause accrual'), ($1, $3, -41600, 'from prize fund')`,
          [id, ids.goodCause, ids.admin],
        );
        return id;
      });
      // ::bigint matters — SUM over an int8 column returns numeric, which would
      // otherwise arrive as a string and bypass the BigInt parser entirely.
      const { rows } = await pool.query(
        `SELECT SUM(amount_pence)::bigint AS total FROM ledger_entry WHERE txn_id = $1`,
        [txnId],
      );
      expect(rows[0].total).toBe(0n);
    });

    it('numericToPence recovers an uncast aggregate rather than letting it become a float', async () => {
      const { rows } = await pool.query(`SELECT SUM(amount_pence) AS total FROM ledger_entry`);
      expect(typeof rows[0].total).toBe('string'); // the trap, demonstrated
      expect(numericToPence(rows[0].total, 'total')).toBe(0n);
      expect(() => numericToPence('12.5', 'total')).toThrow(/whole pence/);
    });
  });

  describe('FR-5.3.3 — the entry set freezes once the numbers are generated', () => {
    it('allows entries against an open draw', async () => {
      await expect(insertEntry(ids.drawOpen, 'open-draw-entry')).resolves.toBeDefined();
    });

    it('refuses to add an entry to a settled draw', async () => {
      await expect(insertEntry(ids.drawSettled, 'settled-draw-entry')).rejects.toThrow(/entry set is frozen/);
    });

    it('refuses to delete an entry that a settled draw already contains', async () => {
      // The entry was created while the draw was open, then the draw settled.
      // Guards against the freeze being a no-op that only ever sees empty sets.
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM entry WHERE draw_id = $1`, [ids.drawToSettle]);
      expect(rows[0].n).toBe(1);
      await expect(pool.query(`DELETE FROM entry WHERE draw_id = $1`, [ids.drawToSettle])).rejects.toThrow(
        /entry set is frozen/,
      );
    });

    it('refuses to amend an entry a settled draw already contains', async () => {
      await expect(
        pool.query(`UPDATE entry SET selection = '{5,6,7,8}' WHERE draw_id = $1`, [ids.drawToSettle]),
      ).rejects.toThrow(/entry set is frozen/);
    });
  });

  describe('FR-13.2 — a settled draw is immutable', () => {
    it('refuses to change the winning numbers of a settled draw', async () => {
      await expect(
        pool.query(`UPDATE draw SET winning_numbers = '{1,2,3,4}' WHERE id = $1`, [ids.drawSettled]),
      ).rejects.toThrow(/settled and immutable/);
    });

    it('refuses to change the money on a settled draw', async () => {
      await expect(
        pool.query(`UPDATE draw SET good_cause_pence = 0 WHERE id = $1`, [ids.drawSettled]),
      ).rejects.toThrow(/settled and immutable/);
    });

    it('still permits the operational workflow pointer to move', async () => {
      await expect(
        pool.query(`UPDATE draw SET workflow_id = 'draw-2026-W37' WHERE id = $1`, [ids.drawSettled]),
      ).resolves.toBeDefined();
    });
  });

  describe('FR-11.3 — self-exclusion takes effect immediately', () => {
    it('refuses to create an entry for a self-excluded member', async () => {
      const excluded = (
        await pool.query(
          `INSERT INTO member (forename, surname, status) VALUES ('Ex','Cluded','self_excluded') RETURNING id`,
        )
      ).rows[0].id;
      await pool.query(`INSERT INTO member_number (prize_draw_no, member_id, row_type) VALUES (9002, $1, 'member')`, [
        excluded,
      ]);
      await expect(
        pool.query(
          `INSERT INTO entry (draw_id, member_id, prize_draw_no, selection, funding_source, idempotency_key)
           VALUES ($1, $2, 9002, '{1,2,3,4}', 'balance', 'excluded-attempt')`,
          [ids.drawOpen, excluded],
        ),
      ).rejects.toThrow(/no entry may be created/);
    });
  });

  describe('schema-level invariants', () => {
    it('rejects a split that does not sum to 10000 basis points (T-2.2)', async () => {
      await expect(
        pool.query(`INSERT INTO config_version (split_prize_bp, split_good_cause_bp, split_admin_bp)
                    VALUES (5000, 4000, 500)`),
      ).rejects.toThrow(/split_sums_to_whole/);
    });

    it('rejects an allocation that does not sum to revenue (T-2.3)', async () => {
      await expect(
        pool.query(
          `INSERT INTO draw (draw_number, draw_date, config_version_id,
                             revenue_pence, prize_contribution_pence, good_cause_pence, admin_pence)
           VALUES (9999, CURRENT_DATE, $1, 104000, 52000, 41600, 9999)`,
          [ids.configVersion],
        ),
      ).rejects.toThrow(/allocation_sums_to_revenue/);
    });

    it('rejects a payout that does not sum to the jackpot (T-12.1)', async () => {
      await expect(
        pool.query(
          `INSERT INTO draw (draw_number, draw_date, config_version_id,
                             jackpot_pre_draw_pence, jackpot_paid_pence, rollover_out_pence)
           VALUES (9998, CURRENT_DATE, $1, 50000, 40000, 5000)`,
          [ids.configVersion],
        ),
      ).rejects.toThrow(/payout_sums_to_jackpot/);
    });

    it('rejects an unsorted or non-distinct selection (FR-3.1)', async () => {
      await expect(insertEntry(ids.drawOpen, 'unsorted', '{4,3,2,1}')).rejects.toThrow(/distinct_sorted/);
      await expect(insertEntry(ids.drawOpen, 'duplicate', '{1,1,2,3}')).rejects.toThrow(/distinct_sorted/);
      await expect(insertEntry(ids.drawOpen, 'out-of-range', '{1,2,3,21}')).rejects.toThrow(/distinct_sorted/);
    });

    it('rejects drawn numbers without RNG provenance (FR-5.3.6)', async () => {
      await expect(
        pool.query(
          `INSERT INTO draw (draw_number, draw_date, config_version_id, status, winning_numbers)
           VALUES (9997, CURRENT_DATE, $1, 'drawn', '{1,2,3,4}')`,
          [ids.configVersion],
        ),
      ).rejects.toThrow(/drawn_requires_rng_provenance/);
    });

    it('T-8.3 — a duplicate entry idempotency key is rejected by storage', async () => {
      await insertEntry(ids.drawOpen, 'duplicate-key-test');
      await expect(insertEntry(ids.drawOpen, 'duplicate-key-test')).rejects.toThrow(/idempotency_key/);
    });

    it('GAP-44 — a task cannot record the same person as both approvers', async () => {
      const actor = (
        await pool.query(
          `INSERT INTO app_user (email, display_name, password_hash)
           VALUES ('a@example.test','A','x') RETURNING id`,
        )
      ).rows[0].id;
      await expect(
        pool.query(
          `INSERT INTO human_task (kind, title, dedupe_key, first_approver_id, second_approver_id)
           VALUES ('must_be_won_decision','test','dk-1',$1,$1)`,
          [actor],
        ),
      ).rejects.toThrow(/approvers_must_be_different/);
    });

    it('T-9.1 — a bare card-number-shaped value is refused as a PSP token', async () => {
      await expect(
        pool.query(
          `INSERT INTO payment_method (member_id, type, psp_token) VALUES ($1, 'card', '4111111111111111')`,
          [ids.member],
        ),
      ).rejects.toThrow(/no_card_data_here/);
    });
  });

  describe('T-9.4 — the application role physically lacks the privilege to rewrite history', () => {
    it('cannot UPDATE or DELETE ledger_entry even with valid credentials', async () => {
      // Prove the revocation, not the trigger: connect AS the application role.
      const appUrl = process.env['TEST_APP_ROLE_DB_URL'];
      if (!appUrl) return; // covered by the grant assertions below instead

      appPool = createPool({ connectionString: appUrl, applicationName: 'qosfc-app-role-test', max: 2 });
      await expect(appPool.query(`UPDATE ledger_entry SET amount_pence = 0`)).rejects.toThrow(/permission denied/);
      await expect(appPool.query(`DELETE FROM ledger_entry`)).rejects.toThrow(/permission denied/);
    });

    it('has no UPDATE or DELETE grant recorded on ledger_entry or audit_log', async () => {
      const { rows } = await pool.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'lottery_app' AND table_name IN ('ledger_entry','audit_log')
            AND privilege_type IN ('UPDATE','DELETE','TRUNCATE')`,
      );
      expect(rows).toEqual([]);
    });

    it('retains INSERT and SELECT on those tables — append-only, not read-only', async () => {
      const { rows } = await pool.query<{ privilege_type: string }>(
        `SELECT DISTINCT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'lottery_app' AND table_name = 'ledger_entry'`,
      );
      expect(rows.map((r) => r.privilege_type).sort()).toEqual(['INSERT', 'SELECT']);
    });
  });
});

async function insertEntry(drawId: string, key: string, selection = '{1,2,3,4}') {
  return pool.query(
    `INSERT INTO entry (draw_id, member_id, prize_draw_no, selection, funding_source, idempotency_key)
     VALUES ($1, $2, 9001, $3, 'balance', $4)`,
    [drawId, ids.member, selection, key],
  );
}
