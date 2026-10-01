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
import { allocatePrepaidEntries } from './allocate-prepaid.js';
import { generateDueEntries } from './generate-entries.js';

const url = process.env['TEST_APP_DB_URL'];
const describeDb = url ? describe : describe.skip;

describeDb('allocatePrepaidEntries — a 4-week purchase shows in each of the next four draws', () => {
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

    const result = await allocatePrepaidEntries(pool, { memberId: agent, actorLabel: 'test' });
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

    await allocatePrepaidEntries(pool, { memberId: buyer, actorLabel: 'test' });
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

    await allocatePrepaidEntries(pool, { memberId: agent, actorLabel: 'test' });
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

    await allocatePrepaidEntries(pool, { memberId: agent, actorLabel: 'test' });
    // Two tickets × two weeks: both tickets in each of the first two draws.
    expect(await entryDraws(agent)).toEqual([draws[0], draws[0], draws[1], draws[1]]);
  });

  it('places weeks left over once more draws are created, and running a draw never spends one twice', async () => {
    const [d1, d2] = [await draw(2), await draw(9)];
    const agent = await member('agent');
    await standing(agent, [13, 14, 15, 16]);
    await pay(agent, 'agent_cash', 800);

    expect(await allocatePrepaidEntries(pool, { memberId: agent, actorLabel: 'test' })).toMatchObject({ entriesPlaced: 2, weeksWaitingForDraws: 2 });

    // An admin creates the next two draws; the waiting weeks follow.
    const [d3, d4, d5] = [await draw(16), await draw(23), await draw(30)];
    await allocatePrepaidEntries(pool, { actorLabel: 'test' });
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
    await allocatePrepaidEntries(pool, { memberId: agent, actorLabel: 'test' });
    expect(await allocatePrepaidEntries(pool, { memberId: agent, actorLabel: 'test' })).toMatchObject({ entriesPlaced: 0 });
    expect(await entryDraws(agent)).toHaveLength(2);
  });
});
