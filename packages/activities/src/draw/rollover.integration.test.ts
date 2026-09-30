/**
 * GitHub #10 — a no-winner draw's jackpot rolls into the next draw. Verified
 * against a real PostgreSQL instance so the draw-row constraints, the
 * settled-draw immutability trigger and the balanced-ledger trigger all run.
 *
 * Set TEST_APP_DB_URL to run. Without it the suite skips rather than silently
 * passing, so a green CI run with no database does not look like proof.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPool, migrate, type Pool } from '@qosfc/db';
import { getRolloverIn } from './rollover.js';
import { settleDraw } from './settle.js';

const url = process.env['TEST_APP_DB_URL'];
const describeDb = url ? describe : describe.skip;

describeDb('rollover between draws (GitHub #10)', () => {
  let pool: Pool;
  let cfgId: string;

  async function drawnDraw(drawNumber: number, drawDate: string): Promise<string> {
    // settleDraw expects the RNG activity to have recorded the numbers already.
    return (
      await pool.query(
        `INSERT INTO draw (draw_number, draw_date, config_version_id, status, winning_numbers, rng_source, drawn_at)
         VALUES ($1, $2, $3, 'drawn', '{1,2,3,4}', 'test', now()) RETURNING id`,
        [drawNumber, drawDate, cfgId],
      )
    ).rows[0].id;
  }

  async function rolloverAccountBalance(): Promise<bigint> {
    const { rows } = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(le.amount_pence), 0)::text AS total
         FROM ledger_entry le JOIN ledger_account la ON la.id = le.account_id
        WHERE la.kind = 'rollover' AND la.member_id IS NULL`,
    );
    return BigInt(rows[0]!.total);
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, applicationName: 'qosfc-rollover-test', max: 4 });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const here = dirname(fileURLToPath(import.meta.url));
    await migrate(pool, resolve(here, '../../../../db/migrations'), () => {});
    cfgId = (await pool.query(`INSERT INTO config_version (note, is_active) VALUES ('rollover fixture', true) RETURNING id`)).rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('the first draw has nothing to roll in', async () => {
    const first = await drawnDraw(1, '2026-10-02');
    expect(await getRolloverIn(pool, { drawId: first })).toEqual({ rolloverInPence: '0', fromDrawId: null });

    await settleDraw(pool, { drawId: first, winningEntries: [], jackpotPreDrawPence: '50000', rolloverInPence: '0', floorTopupPence: '49000' });
    const { rows } = await pool.query(
      `SELECT rollover_out_pence::text, rollover_in_pence::text, jackpot_pre_draw_pence::text FROM draw WHERE id = $1`,
      [first],
    );
    expect(rows[0]).toEqual({ rollover_out_pence: '50000', rollover_in_pence: '0', jackpot_pre_draw_pence: '50000' });
    expect(await rolloverAccountBalance()).toBe(50_000n);
  });

  it('the next draw starts from the unwon jackpot, and moves it out of the rollover account', async () => {
    const second = await drawnDraw(2, '2026-10-09');
    const rollover = await getRolloverIn(pool, { drawId: second });
    expect(rollover.rolloverInPence).toBe('50000');

    // 50,000p rolled in + 1,000p of this draw's own prize share.
    await settleDraw(pool, { drawId: second, winningEntries: [], jackpotPreDrawPence: '51000', rolloverInPence: '50000', floorTopupPence: '0' });
    const { rows } = await pool.query(
      `SELECT rollover_out_pence::text, rollover_in_pence::text, jackpot_pre_draw_pence::text FROM draw WHERE id = $1`,
      [second],
    );
    expect(rows[0]).toEqual({ rollover_out_pence: '51000', rollover_in_pence: '50000', jackpot_pre_draw_pence: '51000' });
    // 50,000 in, 50,000 out to draw 2, 51,000 rolled on again.
    expect(await rolloverAccountBalance()).toBe(51_000n);
  });

  it('takes the rollover from the latest draw before this one, not a later one', async () => {
    const third = await drawnDraw(3, '2026-10-16');
    expect((await getRolloverIn(pool, { drawId: third })).rolloverInPence).toBe('51000');

    // A draw dated earlier than the settled ones sees only what preceded it.
    const backdated = await drawnDraw(4, '2026-10-05');
    expect((await getRolloverIn(pool, { drawId: backdated })).rolloverInPence).toBe('50000');
  });
});
