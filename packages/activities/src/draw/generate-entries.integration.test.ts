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

  // ── Testing-feedback round (GitHub #9, #11) ─────────────────────────────────
  // Config is prepaid_blocks from here on (activated above). Each test makes
  // its own members and draws so it reads on its own.

  let nextDrawNumber = 100;
  async function openDraw(entriesCloseAt?: string): Promise<string> {
    const cfgId = (await pool.query(`SELECT id FROM config_version WHERE is_active`)).rows[0].id;
    return (
      await pool.query(
        `INSERT INTO draw (draw_number, draw_date, config_version_id, status, entries_close_at)
         VALUES ($1, CURRENT_DATE, $2, 'open', $3) RETURNING id`,
        [nextDrawNumber++, cfgId, entriesCloseAt ?? null],
      )
    ).rows[0].id;
  }

  async function entriesFor(memberId: string): Promise<{ draw_id: string; funding_source: string }[]> {
    return (
      await pool.query(`SELECT draw_id, funding_source::text FROM entry WHERE member_id = $1 ORDER BY created_at`, [memberId])
    ).rows;
  }

  it('#11: a 4-week purchase enters the next four draws, then stops', async () => {
    const memberId = await makeMemberWithStanding(5101, [2, 4, 6, 8]);
    await pool.query(
      `INSERT INTO payment (member_id, channel, received_date, amount_pence, status, idempotency_key)
       VALUES ($1, 'agent_cash', CURRENT_DATE, 800, 'allocated', 'test-4-weeks')`,
      [memberId],
    );

    const draws = [await openDraw(), await openDraw(), await openDraw(), await openDraw(), await openDraw()];
    for (const drawId of draws) await generateDueEntries(pool, { drawId, actorLabel: 'test' });

    const entries = await entriesFor(memberId);
    expect(entries.map((e) => e.draw_id)).toEqual(draws.slice(0, 4));
    expect(entries.every((e) => e.funding_source === 'prepaid')).toBe(true);
  });

  it('#11: does not enter a card buyer twice into the draw their checkout already entered them in', async () => {
    const memberId = await makeMemberWithStanding(5102, [1, 3, 5, 7]);
    await pool.query(
      `INSERT INTO payment (member_id, channel, received_date, amount_pence, status, idempotency_key)
       VALUES ($1, 'card', CURRENT_DATE, 800, 'allocated', 'test-card-4')`,
      [memberId],
    );
    const [first, second, third, fourth, fifth] = [await openDraw(), await openDraw(), await openDraw(), await openDraw(), await openDraw()];
    // What completeEntryPurchase does at checkout: the first draw is entered straight away.
    await pool.query(
      `INSERT INTO entry (draw_id, member_id, prize_draw_no, selection, funding_source, idempotency_key)
       VALUES ($1, $2, 5102, '{1,3,5,7}', 'card', 'entry-purchase:test-session')`,
      [first, memberId],
    );

    for (const drawId of [first, second, third, fourth, fifth]) await generateDueEntries(pool, { drawId, actorLabel: 'test' });

    const entries = await entriesFor(memberId);
    expect(entries.map((e) => e.draw_id)).toEqual([first, second, third, fourth]);
    expect(entries.map((e) => e.funding_source)).toEqual(['card', 'prepaid', 'prepaid', 'prepaid']);
  });

  it('#9: an active Direct Debit enters every draw, without using prepaid weeks, until cancelled', async () => {
    const memberId = await makeMemberWithStanding(5103, [9, 10, 11, 12]);
    await pool.query(
      `INSERT INTO payment_method (member_id, type, mandate_ref, mandate_status, active) VALUES ($1, 'direct_debit', 'MANDATE-5103', 'active', true)`,
      [memberId],
    );
    // A prepaid week the DD must not consume — it's still there after cancelling.
    await pool.query(
      `INSERT INTO payment (member_id, channel, received_date, amount_pence, status, idempotency_key)
       VALUES ($1, 'card', CURRENT_DATE, 200, 'allocated', 'test-dd-member-card')`,
      [memberId],
    );

    const ddDraws = [await openDraw(), await openDraw(), await openDraw()];
    for (const drawId of ddDraws) {
      const result = await generateDueEntries(pool, { drawId, actorLabel: 'test' });
      expect(result.directDebitGenerated).toBe(1);
    }

    await pool.query(`UPDATE payment_method SET active = false, mandate_status = 'cancelled' WHERE member_id = $1`, [memberId]);
    const afterCancel = [await openDraw(), await openDraw()];
    for (const drawId of afterCancel) await generateDueEntries(pool, { drawId, actorLabel: 'test' });

    const entries = await entriesFor(memberId);
    expect(entries.map((e) => e.draw_id)).toEqual([...ddDraws, afterCancel[0]]);
    expect(entries.map((e) => e.funding_source)).toEqual(['direct_debit', 'direct_debit', 'direct_debit', 'prepaid']);
  });

  it('#4: money paid after a draw closed to entries waits for the next draw', async () => {
    const memberId = await makeMemberWithStanding(5104, [13, 14, 15, 16]);
    const closedAnHourAgo = await openDraw(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    const next = await openDraw(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
    await pool.query(
      `INSERT INTO payment (member_id, channel, received_date, amount_pence, status, idempotency_key)
       VALUES ($1, 'agent_cash', CURRENT_DATE, 200, 'allocated', 'test-late-ticket')`,
      [memberId],
    );

    await generateDueEntries(pool, { drawId: closedAnHourAgo, actorLabel: 'test' });
    await generateDueEntries(pool, { drawId: next, actorLabel: 'test' });

    expect((await entriesFor(memberId)).map((e) => e.draw_id)).toEqual([next]);
  });
});
