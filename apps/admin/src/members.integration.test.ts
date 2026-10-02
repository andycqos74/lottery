/**
 * The draw entrants page (GitHub #16) and the member page (GitHub #17),
 * against a real PostgreSQL: "x of n" is worked out in SQL from the same
 * line rules allocate-upcoming.ts places entries by.
 *
 * Set TEST_APP_DB_URL to run. Without it the suite skips rather than silently
 * passing, so a green CI run with no database does not look like proof.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPool, migrate, type Pool } from '@qosfc/db';
import { allocateUpcomingEntries } from '@qosfc/activities';
import { getDraw, getMemberPage, listDrawEntrants } from './db.js';

const url = process.env['TEST_APP_DB_URL'];
const describeDb = url ? describe : describe.skip;

describeDb('draw entrants and member pages (GitHub #16, #17)', () => {
  let pool: Pool;
  let cfgId: string;
  let drawNumber = 1;
  const draws: string[] = [];
  let alice: string;
  let bob: string;

  /** An open draw `days` from now, with entries closing an hour before it. */
  async function draw(days: number): Promise<string> {
    return (
      await pool.query(
        `INSERT INTO draw (draw_number, draw_date, draw_at, entries_close_at, config_version_id, status)
         VALUES ($1, (now() + make_interval(days => $2))::date, now() + make_interval(days => $2),
                 now() + make_interval(days => $2) - interval '1 hour', $3, 'open') RETURNING id`,
        [drawNumber++, days, cfgId],
      )
    ).rows[0].id;
  }

  async function member(forename: string, surname: string, email: string): Promise<string> {
    return (await pool.query(`INSERT INTO member (forename, surname, email) VALUES ($1, $2, $3) RETURNING id`, [forename, surname, email]))
      .rows[0].id;
  }

  async function line(memberId: string, prizeDrawNo: number, slot: number, selection: number[]): Promise<void> {
    if (slot === 1) {
      await pool.query(`INSERT INTO member_number (prize_draw_no, member_id, row_type) VALUES ($1, $2, 'member')`, [prizeDrawNo, memberId]);
    }
    await pool.query(`INSERT INTO selection_standing (prize_draw_no, slot, selection, source) VALUES ($1, $2, $3, 'member_chosen')`, [
      prizeDrawNo,
      slot,
      selection,
    ]);
  }

  async function payCard(memberId: string, pence: number, prizeDrawNo: number, slot: number): Promise<void> {
    await pool.query(
      `INSERT INTO payment (member_id, channel, received_date, amount_pence, status, idempotency_key, line_prize_draw_no, line_slot)
       VALUES ($1, 'card', '2026-09-30', $2, 'allocated', gen_random_uuid()::text, $3, $4)`,
      [memberId, pence, prizeDrawNo, slot],
    );
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, applicationName: 'qosfc-admin-members-test', max: 4 });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const here = dirname(fileURLToPath(import.meta.url));
    await migrate(pool, resolve(here, '../../../db/migrations'), () => {});
    cfgId = (
      await pool.query(
        `INSERT INTO config_version (entry_strategy, entry_strategy_confirmed_by, note, is_active)
         VALUES ('prepaid_blocks', 'test fixture', 'members fixture', true) RETURNING id`,
      )
    ).rows[0].id;
    for (const days of [2, 9, 16, 23]) draws.push(await draw(days));

    // Alice: 4 paid weeks on 1-2-3-4, and a Direct Debit on a second line 5-6-7-8.
    alice = await member('Alice', 'Archer', 'alice@example.test');
    await line(alice, 8001, 1, [1, 2, 3, 4]);
    await line(alice, 8001, 2, [5, 6, 7, 8]);
    await payCard(alice, 800, 8001, 1);
    await pool.query(
      `INSERT INTO payment_method (member_id, type, mandate_ref, mandate_status, active, line_prize_draw_no, line_slot)
       VALUES ($1, 'direct_debit', 'MANDATE-A', 'active', true, 8001, 2)`,
      [alice],
    );
    // Bob: 2 paid weeks, so he is in the first two draws only.
    bob = await member('Bob', 'Baker', 'bob@example.test');
    await line(bob, 8002, 1, [9, 10, 11, 12]);
    await payCard(bob, 400, 8002, 1);

    await allocateUpcomingEntries(pool, { actorLabel: 'test' });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('lists each entrant once, with their number of entries and x of n (or DD) per entry', async () => {
    const entrants = await listDrawEntrants(pool, draws[1]!);
    expect(
      entrants.map((e) => ({
        name: `${e.forename} ${e.surname}`,
        email: e.email,
        entries: e.entries.map((x) => [x.selection.join('-'), x.funding, x.paidIndex, x.paidWeeks]),
      })),
    ).toEqual([
      {
        name: 'Alice Archer',
        email: 'alice@example.test',
        entries: [
          ['1-2-3-4', 'prepaid', 2, 4],
          ['5-6-7-8', 'direct_debit', null, null],
        ],
      },
      { name: 'Bob Baker', email: 'bob@example.test', entries: [['9-10-11-12', 'prepaid', 2, 2]] },
    ]);

    const last = await listDrawEntrants(pool, draws[3]!);
    expect(last.map((e) => [e.forename, e.entries.map((x) => [x.paidIndex, x.paidWeeks, x.funding])])).toEqual([
      ['Alice', [[4, 4, 'prepaid'], [null, null, 'direct_debit']]],
    ]);
  });

  it('shows a member their details, payments and the upcoming draws they are in', async () => {
    const page = await getMemberPage(pool, alice);
    expect(page!.profile).toMatchObject({ forename: 'Alice', email: 'alice@example.test', prizeDrawNumbers: [8001] });
    expect(page!.payments.map((p) => [p.channel, p.amountPence, p.lineSelection])).toEqual([['card', 800n, [1, 2, 3, 4]]]);
    expect(page!.upcoming.map((u) => [u.drawNumber, u.selection.join('-'), u.paidIndex ?? u.funding])).toEqual([
      [1, '1-2-3-4', 1],
      [1, '5-6-7-8', 'direct_debit'],
      [2, '1-2-3-4', 2],
      [2, '5-6-7-8', 'direct_debit'],
      [3, '1-2-3-4', 3],
      [3, '5-6-7-8', 'direct_debit'],
      [4, '1-2-3-4', 4],
      [4, '5-6-7-8', 'direct_debit'],
    ]);
  });

  it('leaves drawn draws out of upcoming, and treats a bad id as not found', async () => {
    await pool.query(
      `UPDATE draw SET status = 'drawn', winning_numbers = '{1,2,3,4}', rng_source = 'test', drawn_at = now() WHERE id = $1`,
      [draws[0]],
    );
    const page = await getMemberPage(pool, bob);
    expect(page!.upcoming.map((u) => u.drawNumber)).toEqual([2]);

    expect(await getMemberPage(pool, 'not-a-uuid')).toBeUndefined();
    expect(await getMemberPage(pool, '00000000-0000-0000-0000-000000000000')).toBeUndefined();
    expect(await getDraw(pool, 'not-a-uuid')).toBeUndefined();
  });
});
