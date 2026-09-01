/**
 * GAP-17, resolved: prepaid blocks. Verified against a real PostgreSQL
 * instance — the same pattern as the other integration suites in this repo.
 *
 * Set TEST_APP_DB_URL to run. Without it the suite skips rather than silently
 * passing, so a green CI run with no database does not look like proof.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPool, migrate, type Pool } from '@qosfc/db';
import { generateDueEntries } from './generate-entries.js';

const url = process.env['TEST_APP_DB_URL'];
const describeDb = url ? describe : describe.skip;

describeDb('generateDueEntries (GAP-17: prepaid blocks)', () => {
  let pool: Pool;
  let drawId: string;
  let paidMemberId: string;
  let unpaidMemberId: string;

  async function activateConfig(entryStrategy: string | null, confirmedBy: string | null): Promise<void> {
    await pool.query(`UPDATE config_version SET is_active = false WHERE is_active`);
    await pool.query(
      `INSERT INTO config_version (entry_strategy, entry_strategy_confirmed_by, note, is_active) VALUES ($1, $2, 'test fixture', true)`,
      [entryStrategy, confirmedBy],
    );
  }

  async function makeMemberWithStanding(prizeDrawNo: number, selection: number[]): Promise<string> {
    const memberId = (
      await pool.query(`INSERT INTO member (forename, surname) VALUES ('Test','Member') RETURNING id`)
    ).rows[0].id;
    await pool.query(`INSERT INTO member_number (prize_draw_no, member_id, row_type) VALUES ($1, $2, 'member')`, [
      prizeDrawNo,
      memberId,
    ]);
    await pool.query(
      `INSERT INTO selection_standing (prize_draw_no, slot, selection, source) VALUES ($1, 1, $2, 'member_chosen')`,
      [prizeDrawNo, selection],
    );
    return memberId;
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, applicationName: 'qosfc-entries-test', max: 4 });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const here = dirname(fileURLToPath(import.meta.url));
    await migrate(pool, resolve(here, '../../../../db/migrations'), () => {});

    paidMemberId = await makeMemberWithStanding(5001, [1, 2, 3, 4]);
    unpaidMemberId = await makeMemberWithStanding(5002, [5, 6, 7, 8]);

    // One allocated standing-order payment of £2 — exactly one ticket block.
    await pool.query(
      `INSERT INTO payment (member_id, channel, received_date, amount_pence, status, idempotency_key)
       VALUES ($1, 'so_fps', CURRENT_DATE, 200, 'allocated', 'test-payment-1')`,
      [paidMemberId],
    );

    const cfgId = (await pool.query(`INSERT INTO config_version (note) VALUES ('unresolved fixture') RETURNING id`)).rows[0].id;
    drawId = (
      await pool.query(
        `INSERT INTO draw (draw_number, draw_date, config_version_id, status) VALUES (1, CURRENT_DATE, $1, 'open') RETURNING id`,
        [cfgId],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('GAP-17 unresolved: halts rather than guessing a strategy', async () => {
    // No config_version row with entry_strategy set is active yet at this point.
    await expect(generateDueEntries(pool, { drawId, actorLabel: 'test' })).rejects.toThrow(/GAP-17 is unresolved/);
  });

  it('generates one prepaid entry for a member with an allocated block, and none for a member with no payment', async () => {
    await activateConfig('prepaid_blocks', 'Andy Cowan (test fixture)');

    const result = await generateDueEntries(pool, { drawId, actorLabel: 'test' });
    expect(result).toMatchObject({ candidatesConsidered: 2, generated: 1 });

    const { rows: paidEntries } = await pool.query(
      `SELECT selection, stake_pence::text, funding_source::text FROM entry WHERE member_id = $1`,
      [paidMemberId],
    );
    expect(paidEntries).toHaveLength(1);
    expect(paidEntries[0]).toMatchObject({ selection: [1, 2, 3, 4], stake_pence: '200', funding_source: 'prepaid' });

    const { rows: unpaidEntries } = await pool.query(`SELECT id FROM entry WHERE member_id = $1`, [unpaidMemberId]);
    expect(unpaidEntries).toHaveLength(0);
  });

  it('is idempotent — re-running for the same draw does not consume a second block', async () => {
    const result = await generateDueEntries(pool, { drawId, actorLabel: 'test' });
    expect(result).toMatchObject({ candidatesConsidered: 2, generated: 0 });

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM entry WHERE member_id = $1`, [paidMemberId]);
    expect(rows[0].n).toBe(1);
  });

  it('refuses to generate entries once the draw is no longer open', async () => {
    await pool.query(`UPDATE draw SET status = 'closed' WHERE id = $1`, [drawId]);
    await expect(generateDueEntries(pool, { drawId, actorLabel: 'test' })).rejects.toThrow(/is 'closed', not 'open'/);
    await pool.query(`UPDATE draw SET status = 'open' WHERE id = $1`, [drawId]);
  });
});
