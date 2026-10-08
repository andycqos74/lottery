/**
 * The legacy register load (T-11): people, their immutable numbers, blank
 * reserved numbers, still-paying standing orders, all or nothing.
 *
 * Set TEST_APP_DB_URL to run. Without it the suite skips rather than silently
 * passing, so a green CI run with no database does not look like proof.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPool, migrate, type Pool } from '@qosfc/db';
import { LEGACY_REGISTER_COLUMNS, parseDelimited, planLegacyRegister, readLegacyRegister } from '@qosfc/domain';
import { estimateStandingOrderEntries } from '../draw/standing-order-estimate.js';
import { importLegacyRegister, LegacyRegisterAlreadyLoadedError } from './import-legacy-register.js';

const url = process.env['TEST_APP_DB_URL'];
const describeDb = url ? describe : describe.skip;

// Synthetic (B-2), in the register's own column order, as pasted from the spreadsheet.
const REGISTER = [
  Object.values(LEGACY_REGISTER_COLUMNS).join('\t'),
  '1002\tMr\tKen\tExample\t1 Test Road\tCorstorphine\tEdinburgh\tEH12 6NS\t0131 000 0000\tSO\tDirect (bank)\t\t£8.68 monthly\t8.68\tmonthly\tAlso 1030\tMEMBER\tPAYING\t12\t104.16\tmonthly',
  '1030\tMr\tKen\tExample\t1 Test Road\tCorstorphine\tEdinburgh\tEH12 6NS\t0131 000 0000\tSO\tDirect (bank)\t01/06/2015\t£4.34 monthly\t4.34\tmonthly\t\tMEMBER\tPAYING\t12\t52.08\tmonthly',
  '1040\tMrs\tJean\tSample\t2 Test Street\t\tGlasgow\tG1 1AA\t\tSO\tDirect (bank)\t\tSO\t\t\t\tMEMBER\tNOT PAYING\t0\t0\t',
  '1050\tMr\tAl\tAgentPlayer\t3 Test Lane\t\tPaisley\tPA1 1AA\t\tBob\tAgent\t\t£1 weekly\t1.00\tweekly\t\tMEMBER\tPAYING\t52\t52.00\tweekly',
  '1253\tMr\tDup\tOne\t\t\t\t\t\tSO\tDirect (bank)\t\t\t\t\t\tMEMBER\tPAYING\t\t\t',
  '1253\tMr\tDup\tTwo\t\t\t\t\t\tSO\tDirect (bank)\t\t\t\t\t\tMEMBER\tPAYING\t\t\t',
  '3001\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\tBLANK RESERVED\t\t\t\t',
].join('\n');

describeDb('importing the legacy register (T-11)', () => {
  let pool: Pool;
  const plan = planLegacyRegister(readLegacyRegister(parseDelimited(REGISTER)));

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, applicationName: 'qosfc-legacy-register-test', max: 4 });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const here = dirname(fileURLToPath(import.meta.url));
    await migrate(pool, resolve(here, '../../../../db/migrations'), () => {});
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('refuses a plan whose counts do not reconcile, writing nothing (GAP-40)', async () => {
    const failing = planLegacyRegister(readLegacyRegister(parseDelimited(REGISTER)), { expect: { rows: 99 } });
    await expect(importLegacyRegister(pool, { plan: failing, sourceFileHash: 'abc', actorLabel: 'test' })).rejects.toThrow(/GAP-40/);
    expect((await pool.query(`SELECT count(*)::int AS n FROM member`)).rows[0].n).toBe(0);
  });

  it('loads people, numbers and still-paying standing orders', async () => {
    const counts = await importLegacyRegister(pool, { plan, sourceFileHash: 'abc', actorLabel: 'test' });
    expect(counts).toMatchObject({ rowsRead: 7, memberRows: 4, blankReservedRows: 1, rejectedRows: 2, people: 3, standingOrders: 2 });

    const { rows: numbers } = await pool.query(
      `SELECT mn.prize_draw_no, mn.row_type, mn.legacy_channel, mn.legacy_payment_raw, mn.legacy_amount_pence,
              mn.legacy_frequency, mn.legacy_payments_12m, mn.legacy_total_12m_pence, mn.legacy_observed_frequency,
              m.forename, m.status, m.joining_date::text AS joining_date, m.source_file_hash, m.migrated_from_row
         FROM member_number mn LEFT JOIN member m ON m.id = mn.member_id ORDER BY mn.prize_draw_no`,
    );
    expect(numbers.map((n) => n.prize_draw_no)).toEqual([1002, 1030, 1040, 1050, 3001]);
    expect(numbers[0]).toMatchObject({
      row_type: 'member', legacy_channel: 'direct_bank', legacy_payment_raw: '£8.68 monthly', legacy_amount_pence: 868n,
      legacy_frequency: 'monthly', legacy_payments_12m: 12, legacy_total_12m_pence: 10416n, legacy_observed_frequency: 'monthly',
      forename: 'Ken', status: 'active', joining_date: '2015-06-01', source_file_hash: 'abc', migrated_from_row: 2,
    });
    expect(numbers[2]).toMatchObject({ forename: 'Jean', status: 'lapsed', legacy_amount_pence: null });
    expect(numbers[3]).toMatchObject({ legacy_channel: 'agent_collected' });
    expect(numbers[4]).toMatchObject({ row_type: 'blank_reserved', forename: null });

    // 1002 and 1030 are one person ("Also 1030").
    const { rows: holders } = await pool.query(`SELECT count(DISTINCT member_id)::int AS n FROM member_number WHERE prize_draw_no IN (1002, 1030)`);
    expect(holders[0].n).toBe(1);

    const { rows: subs } = await pool.query(
      `SELECT pm.type, pm.reference, s.amount_pence, s.frequency, s.annual_basis_pence, s.basis_source, s.status
         FROM subscription s JOIN payment_method pm ON pm.id = s.payment_method_id ORDER BY pm.reference`,
    );
    expect(subs).toEqual([
      { type: 'standing_order', reference: '1002', amount_pence: 868n, frequency: 'monthly', annual_basis_pence: 10416n, basis_source: 'register', status: 'active' },
      { type: 'standing_order', reference: '1030', amount_pence: 434n, frequency: 'monthly', annual_basis_pence: 5208n, basis_source: 'register', status: 'active' },
    ]);

    const { rows: flags } = await pool.query(`SELECT verify_flags FROM member WHERE forename = 'Jean'`);
    expect(flags[0].verify_flags).toContain('amount_unknown');

    const { rows: audit } = await pool.query(`SELECT after FROM audit_log WHERE action = 'legacy_register.imported'`);
    expect(audit).toHaveLength(1);
    expect(audit[0].after).toMatchObject({ sourceFileHash: 'abc', rejected: 2 });
  });

  it('counts the loaded standing orders in a draw\'s jackpot estimate', async () => {
    const { rows: config } = await pool.query(
      `INSERT INTO config_version (entry_strategy, entry_strategy_confirmed_by, note, is_active)
       VALUES ('prepaid_blocks', 'test fixture', 'legacy register fixture', true) RETURNING id`,
    );
    const { rows } = await pool.query(
      `INSERT INTO draw (draw_number, draw_date, config_version_id, status) VALUES (1, CURRENT_DATE + 7, $1, 'open') RETURNING id`,
      [config[0].id],
    );
    const estimates = await estimateStandingOrderEntries(pool, [rows[0].id]);
    // (£104.16 → 52 entries + £52.08 → 26 entries) a year ÷ 52 draws = 1.5, rounded down.
    expect(estimates.get(rows[0].id)).toBe(1);
  });

  it('refuses to load the same numbers twice, writing nothing (FR-1.3)', async () => {
    await expect(importLegacyRegister(pool, { plan, sourceFileHash: 'abc', actorLabel: 'test' })).rejects.toBeInstanceOf(LegacyRegisterAlreadyLoadedError);
    expect((await pool.query(`SELECT count(*)::int AS n FROM member`)).rows[0].n).toBe(3);
  });
});
