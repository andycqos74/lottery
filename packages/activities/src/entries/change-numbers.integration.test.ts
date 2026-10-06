/**
 * Changing a line's numbers: the line keeps its paid weeks, draws still on
 * sale take the new numbers, draws closed to entries keep the old ones, and a
 * player can never end up with two lines with the same numbers (GAP-15).
 *
 * Set TEST_APP_DB_URL to run. Without it the suite skips rather than silently
 * passing, so a green CI run with no database does not look like proof.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPool, migrate, type Pool } from '@qosfc/db';
import { allocateUpcomingEntries } from '../draw/allocate-upcoming.js';
import { changeLineNumbers, describeNumbersChange } from './change-numbers.js';

const url = process.env['TEST_APP_DB_URL'];
const describeDb = url ? describe : describe.skip;

describeDb('changing the numbers on a line', () => {
  let pool: Pool;
  let cfgId: string;
  let drawNumber = 1;
  let prizeDrawNo = 8000;

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

  /** A line with `weeks` paid card weeks behind it. */
  async function line(memberId: string, selection: number[], weeks: number, slot = 1, no?: number): Promise<number> {
    const number = no ?? prizeDrawNo++;
    if (slot === 1) {
      await pool.query(`INSERT INTO member_number (prize_draw_no, member_id, row_type) VALUES ($1, $2, 'member')`, [number, memberId]);
    }
    await pool.query(`INSERT INTO selection_standing (prize_draw_no, slot, selection, source) VALUES ($1, $2, $3, 'randomly_allocated')`, [
      number,
      slot,
      selection,
    ]);
    await pool.query(
      `INSERT INTO payment (member_id, channel, received_date, amount_pence, status, idempotency_key, line_prize_draw_no, line_slot)
       VALUES ($1, 'card', CURRENT_DATE, $2, 'allocated', gen_random_uuid()::text, $3, $4)`,
      [memberId, weeks * 200, number, slot],
    );
    return number;
  }

  async function entries(memberId: string): Promise<{ draw_id: string; selection: number[] }[]> {
    return (
      await pool.query(
        `SELECT e.draw_id, e.selection FROM entry e JOIN draw d ON d.id = e.draw_id
          WHERE e.member_id = $1 AND e.voided_at IS NULL ORDER BY d.draw_at, e.selection_slot`,
        [memberId],
      )
    ).rows;
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, applicationName: 'qosfc-change-numbers-test', max: 4 });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const here = dirname(fileURLToPath(import.meta.url));
    await migrate(pool, resolve(here, '../../../../db/migrations'), () => {});
    cfgId = (
      await pool.query(
        `INSERT INTO config_version (entry_strategy, entry_strategy_confirmed_by, note, is_active)
         VALUES ('prepaid_blocks', 'test fixture', 'change numbers fixture', true) RETURNING id`,
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('moves entries still on sale to the new numbers and leaves a closed draw alone', async () => {
    const [closing, a, b] = [await draw(1), await draw(8), await draw(15)];
    const m = await member();
    const no = await line(m, [1, 2, 3, 4], 3);
    await allocateUpcomingEntries(pool, { memberId: m, actorLabel: 'test' });
    await pool.query(`UPDATE draw SET entries_close_at = now() - interval '1 minute' WHERE id = $1`, [closing]);

    const result = await changeLineNumbers(pool, { memberId: m, prizeDrawNo: no, slot: 1, selection: [18, 5, 11, 7], actorLabel: 'test' });
    expect(result).toEqual({ kind: 'changed', selection: [5, 7, 11, 18], entriesUpdated: 2, closedDrawsKeepingOldNumbers: 1 });
    expect(describeNumbersChange(result as Extract<typeof result, { kind: 'changed' }>)).toBe(
      'Numbers changed to 5 · 7 · 11 · 18. They replace the old numbers in 2 upcoming draws already entered. One draw has already closed to entries and will be drawn with the old numbers.',
    );

    expect(await entries(m)).toEqual([
      { draw_id: closing, selection: [1, 2, 3, 4] },
      { draw_id: a, selection: [5, 7, 11, 18] },
      { draw_id: b, selection: [5, 7, 11, 18] },
    ]);

    const { rows: history } = await pool.query(
      `SELECT selection, source::text, effective_to IS NULL AS current FROM selection_standing WHERE prize_draw_no = $1 ORDER BY created_at`,
      [no],
    );
    expect(history).toEqual([
      { selection: [1, 2, 3, 4], source: 'randomly_allocated', current: false },
      { selection: [5, 7, 11, 18], source: 'member_chosen', current: true },
    ]);
    const { rows: audit } = await pool.query(`SELECT before->'selection' AS before FROM audit_log WHERE action = 'selection.changed'`);
    expect(audit).toEqual([{ before: [1, 2, 3, 4] }]);
  });

  it('refuses numbers already on another of a player\'s lines, but not an agent\'s', async () => {
    const player = await member();
    const no = await line(player, [1, 2, 3, 4], 1);
    await line(player, [9, 10, 11, 12], 1, 2, no);
    expect(await changeLineNumbers(pool, { memberId: player, prizeDrawNo: no, slot: 1, selection: [9, 10, 11, 12], actorLabel: 'test' })).toEqual({
      kind: 'rejected',
      reason: 'You already have those numbers on another line.',
    });

    const agent = await member('agent');
    const agentNo = await line(agent, [1, 2, 3, 4], 1);
    await line(agent, [9, 10, 11, 12], 1, 2, agentNo);
    expect(
      (await changeLineNumbers(pool, { memberId: agent, prizeDrawNo: agentNo, slot: 1, selection: [9, 10, 11, 12], actorLabel: 'test' })).kind,
    ).toBe('changed');
  });

  it('refuses a bad selection, another member\'s line, and treats the same numbers as no change', async () => {
    const m = await member();
    const other = await member();
    const no = await line(m, [1, 2, 3, 4], 1);

    expect((await changeLineNumbers(pool, { memberId: m, prizeDrawNo: no, slot: 1, selection: [1, 2, 3], actorLabel: 'test' })).kind).toBe('rejected');
    expect((await changeLineNumbers(pool, { memberId: m, prizeDrawNo: no, slot: 1, selection: [1, 2, 3, 21], actorLabel: 'test' })).kind).toBe(
      'rejected',
    );
    expect((await changeLineNumbers(pool, { memberId: other, prizeDrawNo: no, slot: 1, selection: [5, 6, 7, 8], actorLabel: 'test' })).kind).toBe(
      'rejected',
    );
    expect(await changeLineNumbers(pool, { memberId: m, prizeDrawNo: no, slot: 1, selection: [4, 3, 2, 1], actorLabel: 'test' })).toEqual({
      kind: 'unchanged',
    });
  });
});
