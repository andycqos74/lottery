/**
 * The activities behind scheduled draws, the GAP-24 roll-down and task
 * escalation, against a real PostgreSQL instance — so the draw-row
 * constraints, the balanced-ledger trigger and the human_task indexes all run.
 *
 * Set TEST_APP_DB_URL to run. Without it the suite skips rather than silently
 * passing, so a green CI run with no database does not look like proof.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPool, migrate, type Pool } from '@qosfc/db';
import { checkDrawProgress, closeDrawForRun, findDueDraws } from './run.js';
import { countRollDownTiers } from './winners.js';
import { settleDraw } from './settle.js';
import { openHumanTask } from '../tasks/human-tasks.js';
import {
  ESCALATION_INTERVAL_MS,
  escalateTask,
  getTaskEscalationState,
  listTasksAwaitingEscalation,
  markEscalationStarted,
} from '../tasks/escalation.js';

const url = process.env['TEST_APP_DB_URL'];
const describeDb = url ? describe : describe.skip;

describeDb('scheduled draws, roll-down and escalation (activities)', () => {
  let pool: Pool;
  let cfgId: string;
  let nextDrawNumber = 1;
  let nextPrizeDrawNo = 7000;

  async function draw(opts: { drawAt?: string; status?: string } = {}): Promise<string> {
    return (
      await pool.query(
        `INSERT INTO draw (draw_number, draw_date, config_version_id, draw_at)
         VALUES ($1, current_date, $2, $3) RETURNING id`,
        [nextDrawNumber++, cfgId, opts.drawAt ?? null],
      )
    ).rows[0].id;
  }

  async function member(): Promise<{ memberId: string; prizeDrawNo: number }> {
    const memberId = (await pool.query(`INSERT INTO member (forename, surname) VALUES ('Test','Member') RETURNING id`)).rows[0].id;
    const prizeDrawNo = nextPrizeDrawNo++;
    await pool.query(`INSERT INTO member_number (prize_draw_no, member_id, row_type) VALUES ($1, $2, 'member')`, [
      prizeDrawNo,
      memberId,
    ]);
    return { memberId, prizeDrawNo };
  }

  async function entry(drawId: string, selection: number[]): Promise<string> {
    const { memberId, prizeDrawNo } = await member();
    return (
      await pool.query(
        `INSERT INTO entry (draw_id, member_id, prize_draw_no, selection, funding_source, idempotency_key)
         VALUES ($1, $2, $3, $4, 'card', gen_random_uuid()::text) RETURNING id`,
        [drawId, memberId, prizeDrawNo, selection],
      )
    ).rows[0].id;
  }

  /** What the RNG activity leaves behind: closed, then drawn with provenance. */
  async function markDrawn(drawId: string, numbers: number[]): Promise<void> {
    await closeDrawForRun(pool, { drawId, workflowId: `draw-${drawId}` });
    await pool.query(
      `UPDATE draw SET status = 'drawn', winning_numbers = $2, rng_source = 'test', drawn_at = now() WHERE id = $1`,
      [drawId, numbers],
    );
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, applicationName: 'qosfc-run-test', max: 4 });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const here = dirname(fileURLToPath(import.meta.url));
    await migrate(pool, resolve(here, '../../../../db/migrations'), () => {});
    cfgId = (await pool.query(`INSERT INTO config_version (note, is_active) VALUES ('run fixture', true) RETURNING id`)).rows[0]
      .id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('findDueDraws', () => {
    it('returns open draws whose draw time has passed — not future ones, nor ones with no time', async () => {
      const due = await draw({ drawAt: new Date(Date.now() - 60_000).toISOString() });
      await draw({ drawAt: new Date(Date.now() + 3_600_000).toISOString() });
      await draw();
      const { draws } = await findDueDraws(pool);
      expect(draws.map((d) => d.drawId)).toEqual([due]);
    });
  });

  describe('closeDrawForRun', () => {
    it('freezes the entry count, is idempotent for its own run, and refuses another run', async () => {
      const drawId = await draw();
      await entry(drawId, [1, 2, 3, 4]);
      await entry(drawId, [5, 6, 7, 8]);

      expect(await closeDrawForRun(pool, { drawId, workflowId: 'draw-run-a' })).toEqual({ entriesCount: 2 });
      const { rows } = await pool.query(`SELECT status, workflow_id, entries_count FROM draw WHERE id = $1`, [drawId]);
      expect(rows[0]).toEqual({ status: 'closed', workflow_id: 'draw-run-a', entries_count: 2 });

      // A retry after the commit landed returns what was frozen.
      expect(await closeDrawForRun(pool, { drawId, workflowId: 'draw-run-a' })).toEqual({ entriesCount: 2 });
      await expect(closeDrawForRun(pool, { drawId, workflowId: 'draw-run-b' })).rejects.toThrow(/owned by run draw-run-a/);
    });
  });

  describe('checkDrawProgress', () => {
    it('reports the status, and an open task about the draw other than the watchdog’s own', async () => {
      const drawId = await draw();
      expect(await checkDrawProgress(pool, { drawId })).toEqual({ status: 'open', openTaskId: null });

      await openHumanTask(pool, {
        kind: 'draw_overdue',
        title: 'overdue',
        detail: '',
        consequenceIfIgnored: '',
        entityType: 'draw',
        entityId: drawId,
        dedupeKey: `draw_overdue:${drawId}`,
      });
      expect((await checkDrawProgress(pool, { drawId })).openTaskId).toBeNull();

      const { taskId } = await openHumanTask(pool, {
        kind: 'draw_entries_failed',
        title: 'failed',
        detail: '',
        consequenceIfIgnored: '',
        entityType: 'draw',
        entityId: drawId,
        dedupeKey: `draw_entries_failed:${drawId}`,
      });
      expect((await checkDrawProgress(pool, { drawId })).openTaskId).toBe(taskId);
    });
  });

  describe('GAP-24 roll-down', () => {
    it('counts each tier, then pays the highest tier with a winner, split equally, to the penny', async () => {
      const drawId = await draw();
      const match2a = await entry(drawId, [1, 2, 10, 11]);
      const match2b = await entry(drawId, [3, 4, 12, 13]);
      await entry(drawId, [1, 14, 15, 16]); // match 1
      await entry(drawId, [17, 18, 19, 20]); // match 0
      await markDrawn(drawId, [1, 2, 3, 4]);

      expect(await countRollDownTiers(pool, { drawId })).toEqual({ match3: 0, match2: 2, match1: 1 });

      // An odd jackpot: 2,000,001p between two winners — one penny of remainder.
      const settled = await settleDraw(pool, {
        drawId,
        winningEntries: [],
        jackpotPreDrawPence: '2000001',
        mustBeWonRollDown: true,
      });
      expect(settled).toEqual({ winnersCount: 2, jackpotPaidPence: '2000001', rolloverOutPence: '0', mustBeWonTier: 2 });

      const prizes = await pool.query<{ entry_id: string; amount_pence: bigint }>(
        `SELECT entry_id, amount_pence FROM prize WHERE draw_id = $1 ORDER BY amount_pence DESC`,
        [drawId],
      );
      expect(prizes.rows.map((p) => p.entry_id).sort()).toEqual([match2a, match2b].sort());
      expect(prizes.rows.map((p) => p.amount_pence)).toEqual([1000001n, 1000000n]);

      const row = (
        await pool.query(`SELECT status, must_be_won_triggered, must_be_won_decision FROM draw WHERE id = $1`, [drawId])
      ).rows[0];
      expect(row).toMatchObject({ status: 'settled', must_be_won_triggered: true, must_be_won_decision: { tier: 2 } });

      // Idempotent: a retried activity reports what was paid, tier included.
      expect(
        await settleDraw(pool, { drawId, winningEntries: [], jackpotPreDrawPence: '2000001', mustBeWonRollDown: true }),
      ).toEqual(settled);
    });

    it('refuses a roll-down when somebody matched all four', async () => {
      const drawId = await draw();
      const winner = await entry(drawId, [1, 2, 3, 4]);
      await markDrawn(drawId, [1, 2, 3, 4]);
      await expect(
        settleDraw(pool, {
          drawId,
          winningEntries: [{ entryId: winner, memberId: 'irrelevant' }],
          jackpotPreDrawPence: '2000000',
          mustBeWonRollDown: true,
        }),
      ).rejects.toThrow(/only applies when nobody matched all four/);
    });
  });

  describe('task escalation', () => {
    async function task(dedupeKey: string, dueAt?: Date): Promise<string> {
      return (
        await openHumanTask(pool, {
          kind: 'test',
          title: 'test',
          detail: '',
          consequenceIfIgnored: '',
          dedupeKey,
          ...(dueAt ? { dueAt } : {}),
        })
      ).taskId;
    }

    it('lists open tasks without an escalation workflow, until they are marked', async () => {
      const a = await task('esc-list-a');
      const b = await task('esc-list-b');
      const before = (await listTasksAwaitingEscalation(pool, {})).taskIds;
      expect(before).toEqual(expect.arrayContaining([a, b]));

      await markEscalationStarted(pool, { tasks: [{ taskId: a, workflowId: `escalation-${a}` }] });
      const after = (await listTasksAwaitingEscalation(pool, {})).taskIds;
      expect(after).toContain(b);
      expect(after).not.toContain(a);
    });

    it('is next overdue at due_at, or opened + interval; escalates once per level; reports closed tasks', async () => {
      const noDue = await task('esc-state-a');
      const state = await getTaskEscalationState(pool, { taskId: noDue });
      expect(state.status).toBe('open');
      expect(state.escalationLevel).toBe(0);
      expect(state.msUntilOverdue).toBeGreaterThan(ESCALATION_INTERVAL_MS - 60_000);
      expect(state.msUntilOverdue).toBeLessThanOrEqual(ESCALATION_INTERVAL_MS);

      const pastDue = await task('esc-state-b', new Date(Date.now() - 60_000));
      expect((await getTaskEscalationState(pool, { taskId: pastDue })).msUntilOverdue).toBe(0);

      expect(await escalateTask(pool, { taskId: pastDue, fromLevel: 0, workflowId: 'w' })).toEqual({
        escalated: true,
        escalationLevel: 1,
      });
      // A retried activity with the same fromLevel is a no-op.
      expect(await escalateTask(pool, { taskId: pastDue, fromLevel: 0, workflowId: 'w' })).toEqual({
        escalated: false,
        escalationLevel: 1,
      });
      // After escalating, the next deadline is a full interval away.
      const escalated = await getTaskEscalationState(pool, { taskId: pastDue });
      expect(escalated.escalationLevel).toBe(1);
      expect(escalated.msUntilOverdue).toBeGreaterThan(ESCALATION_INTERVAL_MS - 60_000);

      const audit = await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'human_task.escalated' AND entity_id = $1`, [
        pastDue,
      ]);
      expect(audit.rows[0].n).toBe(1);

      await pool.query(
        `UPDATE human_task SET status = 'cancelled' WHERE id = $1`,
        [pastDue],
      );
      expect((await getTaskEscalationState(pool, { taskId: pastDue })).status).toBe('cancelled');
      expect((await escalateTask(pool, { taskId: pastDue, fromLevel: 1, workflowId: 'w' })).escalated).toBe(false);
    });
  });
});
