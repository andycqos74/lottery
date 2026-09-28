/**
 * Creating draws with times and cutoffs (GitHub #4, #5), against a real
 * PostgreSQL — the Europe/London conversion happens in SQL, so only a real
 * database proves it. Also checks the member portal's `getOpenDraw` picks the
 * draw those cutoffs say is on sale.
 *
 * Set TEST_APP_DB_URL to run. Without it the suite skips rather than silently
 * passing, so a green CI run with no database does not look like proof.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPool, migrate, type Pool } from '@qosfc/db';
import { addEntry, createDraws, getDraw, renameDraw } from './db.js';
import { planRecurringDraws } from './draw-schedule.js';
// The portal's read of the same rows — the other half of the cutoff behaviour.
import { getOpenDraw } from '../../api/src/db.js';

const url = process.env['TEST_APP_DB_URL'];
const describeDb = url ? describe : describe.skip;

describeDb('draw creation with times, cutoffs and names (GitHub #4, #5)', () => {
  let pool: Pool;
  let adminId: string;

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, applicationName: 'qosfc-admin-draws-test', max: 4 });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const here = dirname(fileURLToPath(import.meta.url));
    await migrate(pool, resolve(here, '../../../db/migrations'), () => {});
    await pool.query(`INSERT INTO config_version (note, is_active) VALUES ('draws fixture', true)`);
    adminId = '00000000-0000-0000-0000-000000000001';
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('stores a one-off draw in UK time, BST and GMT alike, with its name', async () => {
    const outcome = await createDraws(pool, {
      name: 'Summer Special',
      createdBy: adminId,
      draws: [
        { drawNumber: 1, drawAtLocal: '2026-07-03T12:00', entriesCloseAtLocal: '2026-07-03T00:00' },
        { drawNumber: 2, drawAtLocal: '2026-12-04T12:00', entriesCloseAtLocal: '2026-12-03T23:30' },
      ],
    });
    expect(outcome.kind).toBe('created');
    const [summer, winter] = await Promise.all(outcome.kind === 'created' ? outcome.ids.map((id) => getDraw(pool, id)) : []);

    expect(summer!.name).toBe('Summer Special');
    expect(summer!.drawAt!.toISOString()).toBe('2026-07-03T11:00:00.000Z'); // BST
    expect(summer!.entriesCloseAt!.toISOString()).toBe('2026-07-02T23:00:00.000Z');
    expect(winter!.drawAt!.toISOString()).toBe('2026-12-04T12:00:00.000Z'); // GMT
    expect(winter!.drawDate.getDate()).toBe(4);
  });

  it('creates a whole recurring series, or none of it when a number clashes', async () => {
    const clashing = planRecurringDraws({
      firstDrawNumber: 2,
      startDate: '2027-01-01',
      endDate: '2027-01-15',
      recurrence: 'weekly',
      drawTimeLocal: '12:00',
      cutoffHoursBefore: 12,
    });
    if (clashing.kind !== 'ok') throw new Error('plan should be valid');
    const rejected = await createDraws(pool, { name: null, createdBy: adminId, draws: clashing.draws, schedule: scheduleOf(clashing) });
    expect(rejected).toEqual({ kind: 'rejected', reason: 'Draw number 2 already exists.' });
    expect((await pool.query(`SELECT count(*)::int AS n FROM draw`)).rows[0].n).toBe(2);

    const plan = planRecurringDraws({
      firstDrawNumber: 10,
      startDate: '2027-01-01',
      endDate: '2027-01-15',
      recurrence: 'weekly',
      drawTimeLocal: '12:00',
      cutoffHoursBefore: 12,
    });
    if (plan.kind !== 'ok') throw new Error('plan should be valid');
    const created = await createDraws(pool, { name: 'Weekly', createdBy: adminId, draws: plan.draws, schedule: scheduleOf(plan) });
    expect(created.kind === 'created' && created.ids).toHaveLength(3);
    const { rows } = await pool.query(
      `SELECT draw_number, draw_schedule_id IS NOT NULL AS scheduled FROM draw WHERE draw_number >= 10 ORDER BY draw_number`,
    );
    expect(rows).toEqual([
      { draw_number: 10, scheduled: true },
      { draw_number: 11, scheduled: true },
      { draw_number: 12, scheduled: true },
    ]);
  });

  it('refuses entries after the cutoff, and the portal offers the next draw instead', async () => {
    const closed = await createDraws(pool, {
      name: null,
      createdBy: adminId,
      draws: [{ drawNumber: 20, drawAtLocal: '2026-01-02T12:00', entriesCloseAtLocal: '2026-01-02T00:00' }],
    });
    if (closed.kind !== 'created') throw new Error('should create');
    const memberId = (await pool.query(`INSERT INTO member (forename, surname) VALUES ('Late','Entrant') RETURNING id`)).rows[0].id;

    const late = await addEntry(pool, { drawId: closed.ids[0]!, memberId, selection: [1, 2, 3, 4] });
    expect(late).toEqual({ kind: 'rejected', reason: 'Entries for this draw have closed.' });

    // Draws 20 (January) and 1 (July 2026) are still 'open' — never run — but
    // their cutoffs have passed; draw 2 (December 2026) is the soonest on sale,
    // ahead of the higher-numbered January 2027 series.
    const onSale = await getOpenDraw(pool);
    expect(onSale?.drawNumber).toBe(2);
  });

  it('renames a draw', async () => {
    const id = (await pool.query(`SELECT id FROM draw WHERE draw_number = 10`)).rows[0].id;
    await renameDraw(pool, id, 'New Year Draw');
    expect((await getDraw(pool, id))!.name).toBe('New Year Draw');
  });
});

function scheduleOf(plan: { draws: readonly { drawAtLocal: string }[] }) {
  return {
    startDate: plan.draws[0]!.drawAtLocal.slice(0, 10),
    endDate: plan.draws.at(-1)!.drawAtLocal.slice(0, 10),
    recurrence: 'weekly',
    drawTimeLocal: '12:00',
    cutoffHoursBefore: 12,
  };
}
