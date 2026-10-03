#!/usr/bin/env tsx
/**
 * DEV ONLY — move an open draw's date/time (UK local time) and its entries
 * cutoff, e.g. to bring a draw forward so it can be run from the admin
 * console now. Then re-runs allocateUpcomingEntries, because paid weeks are
 * used by draws in date order and Direct Debit entries only go into draws
 * still taking entries.
 *
 * Usage:
 *   pnpm exec tsx tools/dev/set-draw-time.ts list
 *   pnpm exec tsx tools/dev/set-draw-time.ts <drawNumber> <YYYY-MM-DDTHH:MM> [<cutoff YYYY-MM-DDTHH:MM> | <hours before>]
 *   pnpm exec tsx tools/dev/set-draw-time.ts 1 now          # draw at now, entries already closed: ready to run
 * (with APP_DB_MIGRATION_URL / APP_DB_MIGRATION_PASSWORD_FILE set, as for migrations)
 */
import { createPool } from '@qosfc/db';
import { allocateUpcomingEntries } from '../../packages/activities/src/index.js';

const url = process.env['APP_DB_MIGRATION_URL'];
if (!url) throw new Error('Set APP_DB_MIGRATION_URL.');
const pool = createPool({ connectionString: url, passwordFile: process.env['APP_DB_MIGRATION_PASSWORD_FILE'], applicationName: 'qosfc-dev-draw-time', max: 2 });

async function list(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT d.draw_number AS draw, d.status,
            to_char(d.draw_at AT TIME ZONE 'Europe/London', 'Dy DD Mon YYYY HH24:MI') AS draw_at_uk,
            to_char(d.entries_close_at AT TIME ZONE 'Europe/London', 'Dy DD Mon YYYY HH24:MI') AS entries_close_uk,
            (SELECT count(*) FROM entry e WHERE e.draw_id = d.id AND e.voided_at IS NULL) AS entries
       FROM draw d ORDER BY COALESCE(d.draw_at, d.draw_date::timestamptz), d.draw_number`,
  );
  console.table(rows);
}

try {
  const [drawArg, whenArg, cutoffArg] = process.argv.slice(2);
  if (!drawArg || drawArg === 'list') {
    await list();
  } else {
    const drawNumber = Number(drawArg);
    if (!whenArg) throw new Error('Give the new draw time, e.g. 2026-10-05T19:00, or "now".');
    // "now": drawn now, entries closed a minute ago — ready for "Close entries & run".
    const now = whenArg === 'now';
    const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
    if (!now && !LOCAL.test(whenArg)) throw new Error('Draw time must look like 2026-10-05T19:00 (UK time).');
    const cutoffLocal = cutoffArg && LOCAL.test(cutoffArg) ? cutoffArg : null;
    const cutoffHours = now ? null : cutoffArg && !cutoffLocal ? Number(cutoffArg) : cutoffLocal ? null : 12;
    const { rows } = await pool.query<{ draw_number: number }>(
      `WITH t AS (
         SELECT CASE WHEN $2 THEN now() ELSE ($3::timestamp AT TIME ZONE 'Europe/London') END AS draw_at)
       UPDATE draw d
          SET draw_at = t.draw_at,
              draw_date = (t.draw_at AT TIME ZONE 'Europe/London')::date,
              entries_close_at = CASE
                WHEN $2 THEN now() - interval '1 minute'
                WHEN $4::timestamp IS NOT NULL THEN $4::timestamp AT TIME ZONE 'Europe/London'
                ELSE t.draw_at - make_interval(hours => $5::int) END
         FROM t
        WHERE d.draw_number = $1 AND d.status = 'open'
        RETURNING d.draw_number`,
      [drawNumber, now, now ? null : whenArg, cutoffLocal, cutoffHours ?? 0],
    );
    if (rows.length === 0) throw new Error(`Draw ${drawNumber} not found, or not open (only open draws can be moved).`);
    const result = await allocateUpcomingEntries(pool, { actorLabel: 'dev:set-draw-time' });
    console.log(
      `Draw ${drawNumber} moved. Re-allocated: ${result.entriesPlaced} placed, ${result.fundingSwitched} switched, ${result.voided} voided, ${result.weeksWaitingForDraws} paid weeks waiting.`,
    );
    await list();
  }
} finally {
  await pool.end();
}
