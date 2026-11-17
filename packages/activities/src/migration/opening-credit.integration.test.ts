/**
 * Legacy standing-order opening credit (switch-over D2 (c)) written to a real
 * PostgreSQL instance: the weeks become payments that the ordinary upcoming-
 * entries run places, once, and never twice.
 *
 * Set TEST_APP_DB_URL to run. Without it the suite skips rather than silently
 * passing, so a green CI run with no database does not look like proof.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPool, migrate, type Pool } from '@qosfc/db';
import { pence, planOpeningCredit, type OpeningCreditStatementLine } from '@qosfc/domain';
import {
  applyOpeningCredit,
  countImportedCreditsUpTo,
  existingOpeningCredits,
  loadOpeningCreditNumbers,
  OpeningCreditOverlapError,
  OpeningCreditUnresolvedError,
} from './opening-credit.js';

const url = process.env['TEST_APP_DB_URL'];
const describeDb = url ? describe : describe.skip;

const CUTOFF = '2026-11-21';
const FIRST_DRAW = '2026-11-27';
let nextId = 1;
const credit = (valueDate: string, amount: number, reference: string): OpeningCreditStatementLine => ({
  externalId: `csv-real:test-${nextId++}`,
  valueDate,
  amountPence: pence(amount),
  isCredit: true,
  typeRaw: 'Standing Order',
  reference,
  description: `STANDING ORDER ${reference}`,
});

describeDb('applyOpeningCredit — weeks paid before the switch-over enter the new draws', () => {
  let pool: Pool;
  let monthly: string; // 8001: £8.68 monthly, numbers chosen
  let quarterly: string; // 8002: £26 quarterly, no numbers yet (GAP-13 week still running)

  async function member(prizeDrawNo: number, amountPence: number, frequency: string, selection?: number[]): Promise<string> {
    const id = (await pool.query(`INSERT INTO member (forename, surname) VALUES ('Test', $1) RETURNING id`, [`No${prizeDrawNo}`])).rows[0].id;
    await pool.query(`INSERT INTO member_number (prize_draw_no, member_id, row_type) VALUES ($1, $2, 'member')`, [prizeDrawNo, id]);
    const pm = (await pool.query(`INSERT INTO payment_method (member_id, type, reference) VALUES ($1, 'standing_order', $2) RETURNING id`, [id, String(prizeDrawNo)])).rows[0].id;
    await pool.query(
      `INSERT INTO subscription (member_id, payment_method_id, amount_pence, frequency, basis_source) VALUES ($1, $2, $3, $4::pay_frequency, 'register')`,
      [id, pm, amountPence, frequency],
    );
    if (selection) {
      await pool.query(`INSERT INTO selection_standing (prize_draw_no, slot, selection, source) VALUES ($1, 1, $2, 'member_chosen')`, [prizeDrawNo, selection]);
    }
    return id;
  }

  async function entryCount(memberId: string): Promise<number> {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM entry WHERE member_id = $1 AND voided_at IS NULL`, [memberId]);
    return rows[0].n;
  }

  async function plan(extra: OpeningCreditStatementLine[] = []) {
    const numbers = await loadOpeningCreditNumbers(pool);
    return planOpeningCredit(
      [credit('2026-11-01', 868, '8001'), credit('2026-10-01', 2600, 'PRIZE DRAW 8002'), credit('2026-11-24', 868, '8001'), ...extra],
      numbers,
      { cutoff: CUTOFF, firstDraw: FIRST_DRAW },
    );
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, applicationName: 'qosfc-opening-credit-test', max: 4 });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const here = dirname(fileURLToPath(import.meta.url));
    await migrate(pool, resolve(here, '../../../../db/migrations'), () => {});
    const cfgId = (
      await pool.query(
        `INSERT INTO config_version (entry_strategy, entry_strategy_confirmed_by, note, is_active)
         VALUES ('prepaid_blocks', 'test fixture', 'opening credit fixture', true) RETURNING id`,
      )
    ).rows[0].id;
    // Eight weekly draws on sale.
    for (let n = 1; n <= 8; n++) {
      await pool.query(
        `INSERT INTO draw (draw_number, draw_date, draw_at, entries_close_at, config_version_id, status)
         VALUES ($1, (now() + make_interval(days => $2))::date, now() + make_interval(days => $2),
                 now() + make_interval(days => $2) - interval '12 hours', $3, 'open')`,
        [n, 7 * n, cfgId],
      );
    }
    monthly = await member(8001, 868, 'monthly', [1, 2, 3, 4]);
    quarterly = await member(8002, 2600, 'quarterly');
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('reads each number with the standing order the register recorded', async () => {
    const numbers = await loadOpeningCreditNumbers(pool);
    expect(numbers).toEqual([
      expect.objectContaining({ prizeDrawNo: 8001, memberId: monthly, memberStatus: 'active', standingOrder: { amountPence: 868n, frequency: 'monthly' } }),
      expect.objectContaining({ prizeDrawNo: 8002, memberId: quarterly, standingOrder: { amountPence: 2600n, frequency: 'quarterly' } }),
    ]);
  });

  it('credits the weeks left at the cut-off and enters them in the open draws', async () => {
    const p = await plan();
    expect(p.lines.map((l) => [l.prizeDrawNo, l.weeks])).toEqual([[8001, 1], [8002, 5]]);
    expect(p.ignored.afterCutoff).toBe(1); // 24 Nov is the new lottery's

    const result = await applyOpeningCredit(pool, { plan: p, sourceFileHashes: ['abc'], actorLabel: 'test' });
    expect(result).toMatchObject({ numbersCredited: 2, weeksCredited: 6, alreadyCredited: [] });

    const { rows } = await pool.query(
      `SELECT line_prize_draw_no, channel::text, amount_pence::int, received_date::text, status::text, allocation_method, allocation_evidence->>'oldDrawsCovered' AS covered
         FROM payment ORDER BY line_prize_draw_no`,
    );
    expect(rows).toEqual([
      { line_prize_draw_no: 8001, channel: 'so_fps', amount_pence: 200, received_date: CUTOFF, status: 'allocated', allocation_method: 'legacy_opening_credit', covered: '3' },
      { line_prize_draw_no: 8002, channel: 'so_fps', amount_pence: 1000, received_date: CUTOFF, status: 'allocated', allocation_method: 'legacy_opening_credit', covered: '8' },
    ]);

    // 8001 has numbers: its week is in Draw 1. 8002 has none yet: its weeks wait for GAP-13.
    expect(await entryCount(monthly)).toBe(1);
    expect(await entryCount(quarterly)).toBe(0);
    const { rows: first } = await pool.query(
      `SELECT d.draw_number FROM entry e JOIN draw d ON d.id = e.draw_id WHERE e.member_id = $1`,
      [monthly],
    );
    expect(first).toEqual([{ draw_number: 1 }]);

    // Once 8002's numbers exist, the next ordinary run places its five weeks.
    await pool.query(`INSERT INTO selection_standing (prize_draw_no, slot, selection, source) VALUES (8002, 1, '{7,8,9,10}', 'member_chosen')`);
    const { allocateUpcomingEntries } = await import('../draw/allocate-upcoming.js');
    await allocateUpcomingEntries(pool, { actorLabel: 'test' });
    expect(await entryCount(quarterly)).toBe(5);

    const { rows: audit } = await pool.query(`SELECT after->>'weeksCredited' AS weeks FROM audit_log WHERE action = 'legacy_opening_credit.applied'`);
    expect(audit).toEqual([{ weeks: '6' }]);
  });

  it('never credits a number twice', async () => {
    const again = await applyOpeningCredit(pool, { plan: await plan(), sourceFileHashes: ['abc'], actorLabel: 'test' });
    expect(again.numbersCredited).toBe(0);
    expect(again.alreadyCredited).toEqual([
      { prizeDrawNo: 8001, weeksBefore: 1, weeksNow: 1 },
      { prizeDrawNo: 8002, weeksBefore: 5, weeksNow: 5 },
    ]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM payment`)).rows[0].n).toBe(2);
    expect(await entryCount(monthly)).toBe(1);
    expect([...(await existingOpeningCredits(pool)).entries()]).toEqual([
      [8001, { weeks: 1, amountPence: 200n }],
      [8002, { weeks: 5, amountPence: 1000n }],
    ]);
  });

  it('refuses while credits are unassigned, unless told to leave them out', async () => {
    const p = await plan([credit('2026-11-05', 500, 'J SMITH')]);
    expect(p.exceptions).toHaveLength(1);
    await expect(applyOpeningCredit(pool, { plan: p, sourceFileHashes: [], actorLabel: 'test' })).rejects.toBeInstanceOf(OpeningCreditUnresolvedError);
    await expect(applyOpeningCredit(pool, { plan: p, sourceFileHashes: [], actorLabel: 'test', allowUnresolved: true })).resolves.toMatchObject({ numbersCredited: 0 });
  });

  it('refuses when the new system already holds statement credits from before the cut-off', async () => {
    const st = (
      await pool.query(
        `INSERT INTO bank_statement (statement_number, period_start, period_end, opening_balance_pence, closing_balance_pence, source, source_ref)
         VALUES (1, '2026-11-15', '2026-11-30', 0, 0, 'csv', 'test') RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO bank_transaction (statement_id, value_date, amount_pence, is_credit, external_id) VALUES ($1, '2026-11-20', 868, true, 'x1'), ($1, '2026-11-25', 868, true, 'x2')`,
      [st],
    );
    expect(await countImportedCreditsUpTo(pool, CUTOFF)).toBe(1);
    await expect(applyOpeningCredit(pool, { plan: await plan(), sourceFileHashes: [], actorLabel: 'test' })).rejects.toBeInstanceOf(OpeningCreditOverlapError);
  });
});
