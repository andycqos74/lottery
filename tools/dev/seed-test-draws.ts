#!/usr/bin/env tsx
/**
 * DEV ONLY — wipe the draw/entry/payment data and seed a month of weekly
 * draws with a few hundred entries, for testing rollovers and multi-week
 * entries. Never point this at production.
 *
 * Wipes: draws (and their schedule, prizes, ledger rows, draw tasks),
 * entries, payments, Direct Debits / payment methods, lines
 * (selection_standing) and pending purchases. Payments go too: a paid week
 * with no entry is simply placed again, so old card payments would re-enter
 * the new draws. Members, logins, admin users, config and the audit log stay.
 *
 * Seeds: weekly draws, ~70 extra test members ("Seed" surname) and 3 agents,
 * and one or more lines each, funded by a mix of card (1, 4, 12 weeks),
 * standing order (4, 13 weeks), Direct Debit, card + Direct Debit on the same
 * line (DD paused while the weeks last), and agent physical tickets
 * (1-8 weeks). Entries are then placed by the real allocateUpcomingEntries.
 *
 * Usage:
 *   APP_DB_MIGRATION_URL=postgres://lottery_owner@<host>:5432/lottery_app \
 *   APP_DB_MIGRATION_PASSWORD_FILE=deploy/secrets/app_db_password \
 *   pnpm exec tsx tools/dev/seed-test-draws.ts [--start 2026-10-10] [--end 2026-10-31] [--seed 2026]
 */
import { createPool, withTransaction, type Pool } from '@qosfc/db';
import { allocateUpcomingEntries, resolveLine } from '../../packages/activities/src/index.js';
import { TICKET_PRICE_PENCE } from '../../packages/domain/src/index.js';
import { createDraws, getDrawFormDefaults } from '../../apps/admin/src/db.js';
import { planRecurringDraws } from '../../apps/admin/src/draw-schedule.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const url = process.env['APP_DB_MIGRATION_URL'];
if (!url) throw new Error('Set APP_DB_MIGRATION_URL (the schema owner — the wipe needs it).');
const START = arg('start', '2026-10-10');
const END = arg('end', '2026-10-31');

// Deterministic, so a re-run seeds the same data.
let state = Number(arg('seed', '2026')) >>> 0;
function rand(): number {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
function numbers(): number[] {
  const set = new Set<number>();
  while (set.size < 4) set.add(1 + Math.floor(rand() * 20));
  return [...set].sort((a, b) => a - b);
}

type Funding =
  | { kind: 'card'; weeks: number }
  | { kind: 'standing_order'; weeks: number }
  | { kind: 'direct_debit' }
  | { kind: 'card_then_dd'; weeks: number }
  | { kind: 'agent'; weeks: number };

function playerFunding(): Funding {
  const r = rand();
  if (r < 0.15) return { kind: 'card', weeks: 1 };
  if (r < 0.37) return { kind: 'card', weeks: 4 };
  if (r < 0.47) return { kind: 'card', weeks: 12 };
  if (r < 0.57) return { kind: 'standing_order', weeks: 4 };
  if (r < 0.64) return { kind: 'standing_order', weeks: 13 };
  if (r < 0.9) return { kind: 'direct_debit' };
  return { kind: 'card_then_dd', weeks: pick([1, 2, 4]) };
}

const FORENAMES = ['Ally', 'Bea', 'Cal', 'Dot', 'Ewan', 'Fiona', 'Gus', 'Hamish', 'Isla', 'Jock', 'Kirsty', 'Lachie', 'Morag', 'Neil', 'Orla', 'Pat', 'Rab', 'Shona', 'Tam', 'Una'];

async function wipe(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    // Entries in drawn draws, prizes and the ledger are frozen by triggers
    // (0007) — rightly, everywhere but a dev reset. Owner/superuser only.
    await client.query(`SET LOCAL session_replication_role = replica`);
    for (const sql of [
      `DELETE FROM ledger_entry`,
      `DELETE FROM prize`,
      `DELETE FROM pending_entry_purchase`,
      `DELETE FROM pending_dd_setup`,
      `DELETE FROM entry`,
      `DELETE FROM human_task WHERE entity_type = 'draw'`,
      `DELETE FROM draw`,
      `DELETE FROM draw_schedule`,
      `DELETE FROM subscription`,
      `DELETE FROM payment`,
      `DELETE FROM payment_method`,
      `DELETE FROM selection_standing`,
    ]) {
      const { rowCount } = await client.query(sql);
      console.log(`  ${sql.padEnd(52)} ${rowCount}`);
    }
  });
}

async function main() {
  const pool = createPool({
    connectionString: url!,
    passwordFile: process.env['APP_DB_MIGRATION_PASSWORD_FILE'],
    applicationName: 'qosfc-dev-seed',
    max: 4,
  });
  try {
    console.log('── Wiping draws, entries, payments, Direct Debits, lines');
    await wipe(pool);

    console.log(`── Creating weekly draws ${START} to ${END}`);
    const defaults = await getDrawFormDefaults(pool);
    const plan = planRecurringDraws({
      firstDrawNumber: 1,
      startDate: START,
      endDate: END,
      recurrence: 'weekly',
      drawTimeLocal: defaults.drawTimeLocal,
      cutoffHoursBefore: defaults.cutoffHoursBefore,
    });
    if (plan.kind !== 'ok') throw new Error(plan.reason);
    const created = await createDraws(pool, {
      name: 'Test draws',
      createdBy: '00000000-0000-0000-0000-000000000000',
      draws: plan.draws,
      schedule: {
        startDate: START,
        endDate: END,
        recurrence: 'weekly',
        drawTimeLocal: defaults.drawTimeLocal,
        cutoffHoursBefore: defaults.cutoffHoursBefore,
      },
    });
    if (created.kind !== 'created') throw new Error(created.reason);
    console.log(`  ${created.ids.length} draws`);

    console.log('── Members');
    const { rows: existing } = await pool.query<{ id: string }>(
      `SELECT id FROM member WHERE member_type = 'player' AND status = 'active' AND surname IS DISTINCT FROM 'Seed' ORDER BY created_at`,
    );
    const players = existing.map((r) => r.id);
    const { rows: seededAlready } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM member WHERE surname = 'Seed'`);
    for (let i = seededAlready[0]!.n; i < 70; i++) {
      const forename = `${FORENAMES[i % FORENAMES.length]}${Math.floor(i / FORENAMES.length) + 1}`;
      await pool.query(
        `INSERT INTO member (forename, surname, email, member_type, status) VALUES ($1, 'Seed', $2, 'player', 'active')`,
        [forename, `${forename.toLowerCase()}.seed@example.test`],
      );
    }
    players.push(...(await pool.query<{ id: string }>(`SELECT id FROM member WHERE surname = 'Seed' ORDER BY created_at`)).rows.map((r) => r.id));
    for (const name of ['Seed Agent North', 'Seed Agent South', 'Seed Agent Town']) {
      await pool.query(
        `INSERT INTO member (forename, surname, member_type, status)
         SELECT $1, 'Agent', 'agent', 'active' WHERE NOT EXISTS (SELECT 1 FROM member WHERE forename = $1)`,
        [name],
      );
    }
    const agents = (await pool.query<{ id: string }>(`SELECT id FROM member WHERE member_type = 'agent' AND status = 'active'`)).rows.map((r) => r.id);
    console.log(`  ${players.length} players, ${agents.length} agents`);

    console.log('── Lines and payments');
    const tally = new Map<string, number>();
    let n = 0;
    const fund = async (memberId: string, funding: Funding) => {
      n++;
      const label = 'weeks' in funding ? `${funding.kind} ${funding.weeks}w` : funding.kind;
      tally.set(label, (tally.get(label) ?? 0) + 1);
      await withTransaction(pool, async (client) => {
        const line = await resolveLine(client, memberId, numbers());
        const pay = (channel: string, weeks: number) =>
          client.query(
            `INSERT INTO payment (member_id, channel, received_date, amount_pence, status, idempotency_key, line_prize_draw_no, line_slot, source_reference)
             VALUES ($1, $2, CURRENT_DATE - $3::int, $4, 'allocated', $5, $6, $7, $8)`,
            [memberId, channel, Math.floor(rand() * 10), (TICKET_PRICE_PENCE * BigInt(weeks)).toString(), `dev-seed:${n}`, line.prizeDrawNo, line.slot, `SEED-${n}`],
          );
        const mandate = () =>
          client.query(
            `INSERT INTO payment_method (member_id, type, mandate_ref, mandate_status, active, line_prize_draw_no, line_slot)
             VALUES ($1, 'direct_debit', $2, 'active', true, $3, $4)`,
            [memberId, `SEED-DD-${n}`, line.prizeDrawNo, line.slot],
          );
        if (funding.kind === 'card') await pay('card', funding.weeks);
        else if (funding.kind === 'standing_order') await pay('so_fps', funding.weeks);
        else if (funding.kind === 'agent') await pay('agent_cash', funding.weeks);
        else if (funding.kind === 'direct_debit') await mandate();
        else {
          await pay('card', funding.weeks);
          await mandate();
        }
      });
    };
    for (const memberId of players) {
      const r = rand();
      const lines = r < 0.72 ? 1 : r < 0.93 ? 2 : 3;
      for (let i = 0; i < lines; i++) await fund(memberId, playerFunding());
    }
    for (const agentId of agents) {
      const tickets = 8 + Math.floor(rand() * 8);
      for (let i = 0; i < tickets; i++) await fund(agentId, { kind: 'agent', weeks: 1 + Math.floor(rand() * 8) });
    }
    for (const [label, count] of [...tally].sort()) console.log(`  ${label.padEnd(20)} ${count} lines`);

    console.log('── Placing entries (allocateUpcomingEntries)');
    const result = await allocateUpcomingEntries(pool, { actorLabel: 'dev-seed' });
    console.log(`  placed ${result.entriesPlaced} (${result.directDebitEntriesPlaced} Direct Debit); ${result.weeksWaitingForDraws} paid weeks waiting for more draws`);

    const { rows } = await pool.query(
      `SELECT d.draw_number, to_char(d.draw_at AT TIME ZONE 'Europe/London', 'Dy DD Mon HH24:MI') AS draw_at,
              count(e.id) FILTER (WHERE e.funding_source = 'prepaid') AS paid_weeks,
              count(e.id) FILTER (WHERE e.funding_source = 'direct_debit') AS dd,
              count(e.id) AS total
         FROM draw d LEFT JOIN entry e ON e.draw_id = d.id AND e.voided_at IS NULL
        GROUP BY d.id ORDER BY d.draw_at`,
    );
    console.table(rows);
  } finally {
    await pool.end();
  }
}

await main();
