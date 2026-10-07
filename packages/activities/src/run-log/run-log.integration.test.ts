/**
 * The run log: one plain-language, categorised line per finished run, from a
 * scripted run history standing in for Temporal's.
 *
 * Set TEST_APP_DB_URL to run. Without it the suite skips rather than silently
 * passing, so a green CI run with no database does not look like proof.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPool, migrate, type Pool } from '@qosfc/db';
import { recordRunLog, type FinishedRun, type RunHistory, type RunOutcome } from './run-log.js';

const url = process.env['TEST_APP_DB_URL'];
const describeDb = url ? describe : describe.skip;

class ScriptedHistory implements RunHistory {
  readonly runs: { run: FinishedRun; outcome: RunOutcome }[] = [];
  add(workflowType: string, workflowId: string, status: string, outcome: RunOutcome): void {
    this.runs.push({
      run: { workflowType, workflowId, runId: `run-${this.runs.length}`, status, startedAt: new Date(), closedAt: new Date() },
      outcome,
    });
  }
  async listFinishedRuns(): Promise<FinishedRun[]> {
    return this.runs.map((r) => r.run);
  }
  async outcome(run: FinishedRun): Promise<RunOutcome> {
    return this.runs.find((r) => r.run.runId === run.runId)!.outcome;
  }
}

describeDb('run log', () => {
  let pool: Pool;
  let drawId: string;

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, applicationName: 'qosfc-run-log-test', max: 4 });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const here = dirname(fileURLToPath(import.meta.url));
    await migrate(pool, resolve(here, '../../../../db/migrations'), () => {});
    const cfgId = (await pool.query(`INSERT INTO config_version (note, is_active) VALUES ('run log fixture', true) RETURNING id`)).rows[0].id;
    drawId = (
      await pool.query(`INSERT INTO draw (draw_number, draw_date, config_version_id, status) VALUES (42, '2026-11-06', $1, 'open') RETURNING id`, [cfgId])
    ).rows[0].id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('writes one concise, categorised line per finished run, once', async () => {
    const history = new ScriptedHistory();
    history.add('DrawDispatchWorkflow', 'draw-dispatch', 'COMPLETED', { result: { started: [], alreadyRunning: [] } });
    history.add('DrawDispatchWorkflow', 'draw-dispatch', 'COMPLETED', { result: { started: [drawId], alreadyRunning: [] } });
    history.add('DrawWorkflow', `draw-${drawId}`, 'COMPLETED', {
      result: { status: 'settled', winnersCount: 2, jackpotPaidPence: '120000', jackpotPreDrawPence: '120000' },
    });
    history.add('DrawWorkflow', `draw-${drawId}`, 'FAILED', { failure: 'GAP-17: entry strategy not confirmed' });
    history.add('DrawWatchdogWorkflow', `draw-watchdog-${drawId}`, 'COMPLETED', { result: 'raised' });
    history.add('DirectDebitWorkflow', 'direct-debit', 'COMPLETED', {
      result: {
        events: { applied: 0 },
        bureauCancellations: { cancelled: 0 },
        prepared: { collectionMonth: '2026-11-01', scheduled: 0 },
        submitted: { submitted: 0, rejected: 0 },
        results: { collected: 31, retrying: 7, stopped: 0 },
      },
    });
    history.add('DirectDebitWorkflow', 'direct-debit', 'COMPLETED', {
      result: { results: { collected: 6, retrying: 0, stopped: 1 } },
    });
    history.add('RandomAllocationSweepWorkflow', 'selection-random-allocation', 'COMPLETED', { result: { allocated: 7, emailed: 0, postTasks: 5 } });
    history.add('EscalationSweepWorkflow', 'task-escalation-sweep', 'TIMED_OUT', { result: null });
    history.add('EscalationWorkflow', 'escalation-x', 'CONTINUED_AS_NEW', { result: null });
    history.add('RunLogSweepWorkflow', 'run-log', 'COMPLETED', { result: { logged: 3 } });

    expect(await recordRunLog(pool, history, {})).toEqual({ logged: 9, pruned: 0 });
    const { rows } = await pool.query(`SELECT category, message, quiet FROM run_log ORDER BY id`);
    expect(rows).toEqual([
      { category: 'info', message: 'Draw scheduler: no draws due.', quiet: true },
      { category: 'success', message: 'Draw scheduler: started the run for Draw 42.', quiet: false },
      { category: 'success', message: 'Draw 42 settled: 2 winners share £1,200.00.', quiet: false },
      { category: 'error', message: 'Draw run for Draw 42 failed: GAP-17: entry strategy not confirmed', quiet: false },
      { category: 'error', message: 'Draw watchdog for Draw 42: still not finished after 2 hours — a task has been raised.', quiet: false },
      { category: 'success', message: 'Direct Debit run: 31 collected; 7 failed and will be retried.', quiet: false },
      { category: 'error', message: 'Direct Debit run: 6 collected; 1 Direct Debit stopped after a second failure.', quiet: false },
      { category: 'success', message: 'Gave random numbers to 7 lines (5 to post).', quiet: false },
      { category: 'error', message: 'Task escalation check timed out before finishing.', quiet: false },
    ]);

    // The next sweep sees the same runs and adds nothing.
    expect(await recordRunLog(pool, history, {})).toEqual({ logged: 0, pruned: 0 });
  });
});
