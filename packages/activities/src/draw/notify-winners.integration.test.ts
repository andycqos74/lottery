/**
 * GAP-05 — a winner with an email is emailed; a winner without one gets a
 * single task to contact them by post, and nothing else ever asks for an
 * email address.
 *
 * Set TEST_APP_DB_URL to run. Without it the suite skips rather than silently
 * passing, so a green CI run with no database does not look like proof.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPool, migrate, type Pool } from '@qosfc/db';
import type { DeliveryOutcome, NotificationRequest, Notifier } from '@qosfc/ports';
import { notifyWinners, WINNER_MISSING_EMAIL_TASK_KIND } from './notify-winners.js';

const url = process.env['TEST_APP_DB_URL'];
const describeDb = url ? describe : describe.skip;

describeDb('winner notification (GAP-05)', () => {
  let pool: Pool;
  let drawId: string;
  let prizeDrawNo = 7000;
  const sent: NotificationRequest[] = [];
  const notifier: Notifier = {
    providerName: 'test',
    send: async (request): Promise<DeliveryOutcome> => {
      sent.push(request);
      return { status: 'accepted', providerRef: `ref-${sent.length}` };
    },
    fetchDeliveryEvents: async () => [],
  };

  async function winner(surname: string, email: string | null, prizes: number[]): Promise<string> {
    const memberId = (await pool.query(`INSERT INTO member (forename, surname, email) VALUES ('Test', $1, $2) RETURNING id`, [surname, email]))
      .rows[0].id;
    for (const amount of prizes) {
      const no = prizeDrawNo++;
      await pool.query(`INSERT INTO member_number (prize_draw_no, member_id, row_type) VALUES ($1, $2, 'member')`, [no, memberId]);
      const entryId = (
        await pool.query(
          `INSERT INTO entry (draw_id, member_id, prize_draw_no, selection, funding_source, idempotency_key)
           VALUES ($1, $2, $3, '{1,2,3,4}', 'balance', $4) RETURNING id`,
          [drawId, memberId, no, `${drawId}:${no}:1`],
        )
      ).rows[0].id;
      await pool.query(`INSERT INTO prize (draw_id, entry_id, member_id, amount_pence) VALUES ($1, $2, $3, $4)`, [drawId, entryId, memberId, amount]);
    }
    return memberId;
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, applicationName: 'qosfc-notify-winners-test', max: 4 });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const here = dirname(fileURLToPath(import.meta.url));
    await migrate(pool, resolve(here, '../../../../db/migrations'), () => {});
    const cfgId = (await pool.query(`INSERT INTO config_version (note, is_active) VALUES ('notify fixture', true) RETURNING id`)).rows[0].id;
    drawId = (
      await pool.query(`INSERT INTO draw (draw_number, draw_date, config_version_id, status) VALUES (1, '2026-10-09', $1, 'open') RETURNING id`, [
        cfgId,
      ])
    ).rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('emails winners who have an address, and raises one post task per winner who has none', async () => {
    const emailed = await winner('Emailed', 'w@example.com', [5000]);
    const posted = await winner('Posted', null, [2500, 2500]);

    const result = await notifyWinners(pool, notifier, { drawId, drawNumber: 1 });
    expect(result).toEqual({ notified: 1, pending: 2, postFollowUps: 1 });
    expect(sent.map((s) => s.memberRef)).toEqual([emailed]);

    const { rows: tasks } = await pool.query(`SELECT entity_id, title FROM human_task WHERE kind = $1`, [WINNER_MISSING_EMAIL_TASK_KIND]);
    expect(tasks).toEqual([{ entity_id: posted, title: 'Tell Test Posted they won £50.00 in Draw 1' }]);

    // A retry neither re-emails nor duplicates the task.
    await notifyWinners(pool, notifier, { drawId, drawNumber: 1 });
    expect(sent).toHaveLength(1);
    expect((await pool.query(`SELECT 1 FROM human_task WHERE kind = $1`, [WINNER_MISSING_EMAIL_TASK_KIND])).rows).toHaveLength(1);
  });
});
