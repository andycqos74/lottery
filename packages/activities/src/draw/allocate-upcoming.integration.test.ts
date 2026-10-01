/**
 * Prepaid weeks placed into upcoming draws at purchase time. Verified against
 * a real PostgreSQL instance.
 *
 * Set TEST_APP_DB_URL to run. Without it the suite skips rather than silently
 * passing, so a green CI run with no database does not look like proof.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPool, migrate, type Pool } from '@qosfc/db';
import { allocateUpcomingEntries, voidDirectDebitEntries } from './allocate-upcoming.js';
import { estimateStandingOrderEntries } from './standing-order-estimate.js';
import { identifyWinners } from './winners.js';
import { generateDueEntries } from './generate-entries.js';

const url = process.env['TEST_APP_DB_URL'];
const describeDb = url ? describe : describe.skip;

describeDb('allocateUpcomingEntries — a 4-week purchase shows in each of the next four draws', () => {
  let pool: Pool;
  let cfgId: string;
  let drawNumber = 1;
  let prizeDrawNo = 7000;

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

  async function member(memberType = 'player'): Promise<string> {
    return (await pool.query(`INSERT INTO member (forename, surname, member_type) VALUES ('T','M',$1) RETURNING id`, [memberType])).rows[0].id;
  }

  async function standing(memberId: string, selection: number[]): Promise<number> {
    const no = prizeDrawNo++;
    await pool.query(`INSERT INTO member_number (prize_draw_no, member_id, row_type) VALUES ($1, $2, 'member')`, [no, memberId]);
    await pool.query(`INSERT INTO selection_standing (prize_draw_no, slot, selection, source) VALUES ($1, 1, $2, 'member_chosen')`, [no, selection]);
    return no;
  }

  async function pay(memberId: string, channel: string, pence: number): Promise<void> {
    await pool.query(
      `INSERT INTO payment (member_id, channel, received_date, amount_pence, status, idempotency_key)
       VALUES ($1, $2, CURRENT_DATE, $3, 'allocated', gen_random_uuid()::text)`,
      [memberId, channel, pence],
    );
  }

  async function entryDraws(memberId: string): Promise<string[]> {
    const { rows } = await pool.query(
      `SELECT e.draw_id FROM entry e JOIN draw d ON d.id = e.draw_id WHERE e.member_id = $1 ORDER BY d.draw_at, e.prize_draw_no`,
      [memberId],
    );
    return rows.map((r) => r.draw_id);
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, applicationName: 'qosfc-allocate-test', max: 4 });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const here = dirname(fileURLToPath(import.meta.url));
    await migrate(pool, resolve(here, '../../../../db/migrations'), () => {});
    cfgId = (
      await pool.query(
        `INSERT INTO config_version (entry_strategy, entry_strategy_confirmed_by, note, is_active)
         VALUES ('prepaid_blocks', 'test fixture', 'allocate fixture', true) RETURNING id`,
      )
    ).rows[0].id;
  });

  beforeEach(async () => {
    // Each test starts with no draws on sale.
    await pool.query(`UPDATE draw SET status = 'void' WHERE status = 'open'`);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('places a 4-week physical ticket into the next four draws on sale, soonest first', async () => {
    const draws = [await draw(9), await draw(2), await draw(16), await draw(23), await draw(30)];
    const agent = await member('agent');
    await standing(agent, [1, 2, 3, 4]);
    await pay(agent, 'agent_cash', 800);

    const result = await allocateUpcomingEntries(pool, { memberId: agent, actorLabel: 'test' });
    expect(result).toMatchObject({ entriesPlaced: 4, weeksWaitingForDraws: 0 });
    // Ordered by draw time, not creation order: days 2, 9, 16, 23 — not day 30.
    expect(await entryDraws(agent)).toEqual([draws[1], draws[0], draws[2], draws[3]]);
  });

  it('a card buyer already entered at checkout gets the other three weeks, not a duplicate', async () => {
    const [first, second, third, fourth, fifth] = [await draw(2), await draw(9), await draw(16), await draw(23), await draw(30)];
    const buyer = await member();
    const no = await standing(buyer, [5, 6, 7, 8]);
    await pay(buyer, 'card', 800);
    await pool.query(
      `INSERT INTO entry (draw_id, member_id, prize_draw_no, selection, funding_source, idempotency_key)
       VALUES ($1, $2, $3, '{5,6,7,8}', 'card', 'entry-purchase:test')`,
      [first, buyer, no],
    );

    await allocateUpcomingEntries(pool, { memberId: buyer, actorLabel: 'test' });
    expect(await entryDraws(buyer)).toEqual([first, second, third, fourth]);
    void fifth;
  });

  it('skips draws already closed to entries', async () => {
    const closed = (
      await pool.query(
        `INSERT INTO draw (draw_number, draw_date, draw_at, entries_close_at, config_version_id, status)
         VALUES ($1, CURRENT_DATE, now() + interval '2 hours', now() - interval '1 hour', $2, 'open') RETURNING id`,
        [drawNumber++, cfgId],
      )
    ).rows[0].id;
    const next = await draw(7);
    const agent = await member('agent');
    await standing(agent, [9, 10, 11, 12]);
    await pay(agent, 'agent_cash', 200);

    await allocateUpcomingEntries(pool, { memberId: agent, actorLabel: 'test' });
    expect(await entryDraws(agent)).toEqual([next]);
    expect(closed).toBeDefined();
  });

  it("enters each of an agent's tickets into the same draws, from one pool of weeks", async () => {
    const draws = [await draw(2), await draw(9), await draw(16)];
    const agent = await member('agent');
    await standing(agent, [1, 3, 5, 7]);
    await pay(agent, 'agent_cash', 400);
    await standing(agent, [2, 4, 6, 8]);
    await pay(agent, 'agent_cash', 400);

    await allocateUpcomingEntries(pool, { memberId: agent, actorLabel: 'test' });
    // Two tickets × two weeks: both tickets in each of the first two draws.
    expect(await entryDraws(agent)).toEqual([draws[0], draws[0], draws[1], draws[1]]);
  });

  it('places weeks left over once more draws are created, and running a draw never spends one twice', async () => {
    const [d1, d2] = [await draw(2), await draw(9)];
    const agent = await member('agent');
    await standing(agent, [13, 14, 15, 16]);
    await pay(agent, 'agent_cash', 800);

    expect(await allocateUpcomingEntries(pool, { memberId: agent, actorLabel: 'test' })).toMatchObject({ entriesPlaced: 2, weeksWaitingForDraws: 2 });

    // An admin creates the next two draws; the waiting weeks follow.
    const [d3, d4, d5] = [await draw(16), await draw(23), await draw(30)];
    await allocateUpcomingEntries(pool, { actorLabel: 'test' });
    expect(await entryDraws(agent)).toEqual([d1, d2, d3, d4]);

    // Running the next draw adds nothing for this member: the week is already there.
    await generateDueEntries(pool, { drawId: d1, actorLabel: 'test' });
    await generateDueEntries(pool, { drawId: d5, actorLabel: 'test' });
    expect(await entryDraws(agent)).toEqual([d1, d2, d3, d4]);
  });

  it('is idempotent', async () => {
    await draw(2);
    await draw(9);
    const agent = await member('agent');
    await standing(agent, [17, 18, 19, 20]);
    await pay(agent, 'agent_cash', 400);
    await allocateUpcomingEntries(pool, { memberId: agent, actorLabel: 'test' });
    expect(await allocateUpcomingEntries(pool, { memberId: agent, actorLabel: 'test' })).toMatchObject({ entriesPlaced: 0 });
    expect(await entryDraws(agent)).toHaveLength(2);
  });

  // ── Direct Debit entries at draw creation ──────────────────────────────────

  async function liveEntries(memberId: string): Promise<{ draw_id: string; funding_source: string; selection: number[] }[]> {
    const { rows } = await pool.query(
      `SELECT e.draw_id, e.funding_source::text, e.selection FROM entry e JOIN draw d ON d.id = e.draw_id
        WHERE e.member_id = $1 AND e.voided_at IS NULL ORDER BY d.draw_at`,
      [memberId],
    );
    return rows;
  }

  async function mandate(memberId: string, active = true): Promise<void> {
    await pool.query(
      `INSERT INTO payment_method (member_id, type, mandate_ref, mandate_status, active) VALUES ($1, 'direct_debit', gen_random_uuid()::text, $2, $3)`,
      [memberId, active ? 'active' : 'cancelled', active],
    );
  }

  it('enters a Direct Debit member into every draw on sale, without spending prepaid weeks', async () => {
    const draws = [await draw(2), await draw(9), await draw(16)];
    const dd = await member();
    await standing(dd, [1, 5, 10, 15]);
    await mandate(dd);
    await pay(dd, 'card', 200); // a prepaid week kept for if the DD stops

    const result = await allocateUpcomingEntries(pool, { actorLabel: 'test' });
    expect(result.directDebitEntriesPlaced).toBeGreaterThanOrEqual(3);
    expect((await liveEntries(dd)).map((e) => [e.draw_id, e.funding_source])).toEqual(draws.map((d) => [d, 'direct_debit']));

    // A draw created later picks the member up too.
    const later = await draw(23);
    await allocateUpcomingEntries(pool, { actorLabel: 'test' });
    expect((await liveEntries(dd)).map((e) => e.draw_id)).toEqual([...draws, later]);
  });

  it('cancelling voids entries in draws still taking entries, keeps closed ones, and prepaid weeks take over', async () => {
    const closed = (
      await pool.query(
        `INSERT INTO draw (draw_number, draw_date, draw_at, entries_close_at, config_version_id, status)
         VALUES ($1, CURRENT_DATE, now() + interval '2 hours', now() + interval '1 minute', $2, 'open') RETURNING id`,
        [drawNumber++, cfgId],
      )
    ).rows[0].id;
    const [a, b] = [await draw(9), await draw(16)];
    const dd = await member();
    await standing(dd, [2, 6, 11, 16]);
    await mandate(dd);
    await pay(dd, 'card', 200);
    await allocateUpcomingEntries(pool, { memberId: dd, actorLabel: 'test' });
    expect((await liveEntries(dd)).map((e) => e.draw_id)).toEqual([closed, a, b]);

    // Entries for the first draw close before the member cancels.
    await pool.query(`UPDATE draw SET entries_close_at = now() - interval '1 second' WHERE id = $1`, [closed]);
    await pool.query(`UPDATE payment_method SET active = false, mandate_status = 'cancelled' WHERE member_id = $1`, [dd]);
    expect(await voidDirectDebitEntries(pool, { memberId: dd, reason: 'test cancel', actorLabel: 'test' })).toEqual({ voided: 2 });
    await allocateUpcomingEntries(pool, { memberId: dd, actorLabel: 'test' });

    expect((await liveEntries(dd)).map((e) => [e.draw_id, e.funding_source])).toEqual([
      [closed, 'direct_debit'],
      [a, 'prepaid'],
    ]);
  });

  it('setting a Direct Debit up again revives the voided entries, with the new numbers', async () => {
    const [a, b] = [await draw(2), await draw(9)];
    const dd = await member();
    const no = await standing(dd, [3, 7, 12, 17]);
    await mandate(dd);
    await allocateUpcomingEntries(pool, { memberId: dd, actorLabel: 'test' });
    await pool.query(`UPDATE payment_method SET active = false, mandate_status = 'cancelled' WHERE member_id = $1`, [dd]);
    await voidDirectDebitEntries(pool, { memberId: dd, reason: 'test cancel', actorLabel: 'test' });
    expect(await liveEntries(dd)).toEqual([]);

    await pool.query(`UPDATE selection_standing SET selection = '{4,8,13,18}' WHERE prize_draw_no = $1`, [no]);
    await mandate(dd);
    await allocateUpcomingEntries(pool, { memberId: dd, actorLabel: 'test' });
    expect(await liveEntries(dd)).toEqual([
      { draw_id: a, funding_source: 'direct_debit', selection: [4, 8, 13, 18] },
      { draw_id: b, funding_source: 'direct_debit', selection: [4, 8, 13, 18] },
    ]);
  });

  it('changed numbers carry to entries already placed in draws still on sale', async () => {
    const [a, b] = [await draw(2), await draw(9)];
    const buyer = await member();
    const no = await standing(buyer, [1, 2, 3, 4]);
    await pay(buyer, 'card', 400);
    await allocateUpcomingEntries(pool, { memberId: buyer, actorLabel: 'test' });

    await pool.query(`UPDATE selection_standing SET selection = '{17,18,19,20}' WHERE prize_draw_no = $1`, [no]);
    const result = await allocateUpcomingEntries(pool, { memberId: buyer, actorLabel: 'test' });
    expect(result.selectionsUpdated).toBe(2);
    expect((await liveEntries(buyer)).map((e) => [e.draw_id, e.selection])).toEqual([
      [a, [17, 18, 19, 20]],
      [b, [17, 18, 19, 20]],
    ]);
  });

  it('a voided entry cannot win', async () => {
    const d = await draw(2);
    const dd = await member();
    await standing(dd, [1, 2, 3, 4]);
    await mandate(dd);
    await allocateUpcomingEntries(pool, { memberId: dd, actorLabel: 'test' });
    await pool.query(`UPDATE payment_method SET active = false WHERE member_id = $1`, [dd]);
    await voidDirectDebitEntries(pool, { memberId: dd, reason: 'test cancel', actorLabel: 'test' });
    await pool.query(
      `UPDATE draw SET status = 'drawn', winning_numbers = '{1,2,3,4}', rng_source = 'test', drawn_at = now() WHERE id = $1`,
      [d],
    );
    const { winningEntries } = await identifyWinners(pool, { drawId: d });
    expect(winningEntries.filter((w) => w.memberId === dd)).toEqual([]);
  });

  it('estimates standing-order entries not yet paid for, and stops counting a member once their money is in', async () => {
    const [a, b] = [await draw(2), await draw(9)];
    // £104/yr = 52 entries/yr = 1 a week; £52/yr = half a week each.
    for (const annual of [10400, 5200, 5200]) {
      const m = await member();
      await standing(m, [5, 10, 15, 20]);
      const pm = (await pool.query(`INSERT INTO payment_method (member_id, type) VALUES ($1, 'standing_order') RETURNING id`, [m])).rows[0].id;
      await pool.query(
        `INSERT INTO subscription (member_id, payment_method_id, amount_pence, frequency, annual_basis_pence, start_date)
         VALUES ($1, $2, $3, 'annual', $3, CURRENT_DATE - 30)`,
        [m, pm, annual],
      );
      if (annual === 10400) {
        // This one's money has been imported: a real entry, not an estimate.
        await pay(m, 'so_fps', 200);
      }
    }
    await allocateUpcomingEntries(pool, { actorLabel: 'test' });

    const estimates = await estimateStandingOrderEntries(pool, [a, b]);
    // Draw a: the £104 member is entered (paid), the two £52 members make one expected entry.
    expect(estimates.get(a)).toBe(1);
    // Draw b: nobody has paid for it yet, so 1 + 0.5 + 0.5 = 2 expected.
    expect(estimates.get(b)).toBe(2);
  });
});
