/**
 * The run log: one plain-language line per finished Temporal workflow run,
 * for the admin console's Log page (db/migrations/0023).
 *
 * Read from Temporal's own record of each run (`RunHistory`, implemented in
 * the worker over the Temporal client) rather than written by the workflows,
 * so failures, timeouts and terminations are caught as surely as successes,
 * and no workflow's history changes.
 *
 * - error   — the run failed, timed out or was terminated, or it found
 *             something a person must deal with (a draw overdue, a Direct
 *             Debit stopped or refused by the bank).
 * - success — the run did something (a draw settled, money collected, …).
 * - info    — anything else. Routine ticks that found nothing to do are
 *             marked quiet: hidden by default, pruned after 30 days.
 */
import type { Pool } from '@qosfc/db';
import { formatPence, pence } from '@qosfc/domain';

/** A finished run, as Temporal's visibility records it. */
export interface FinishedRun {
  readonly workflowType: string;
  readonly workflowId: string;
  readonly runId: string;
  /** COMPLETED | FAILED | TIMED_OUT | TERMINATED | CANCELLED | CONTINUED_AS_NEW */
  readonly status: string;
  readonly startedAt: Date | null;
  readonly closedAt: Date;
}

export type RunOutcome = { readonly result: unknown } | { readonly failure: string };

export interface RunHistory {
  /** Runs that finished at or after `since`, oldest first. */
  listFinishedRuns(since: Date, limit: number): Promise<readonly FinishedRun[]>;
  /** A completed run's result, or a failed run's failure message (decrypted). */
  outcome(run: FinishedRun): Promise<RunOutcome>;
}

export type RunLogCategory = 'success' | 'info' | 'error';

export interface RunLogLine {
  readonly category: RunLogCategory;
  readonly message: string;
  readonly quiet?: boolean;
}

/** Never logged: the sweep itself would add a line every minute about adding lines. */
export const RUN_LOG_SWEEP_TYPE = 'RunLogSweepWorkflow';

/** Re-read this far back each time; the unique (workflow, run) key makes a repeat harmless. */
const OVERLAP_MS = 10 * 60 * 1000;
const FIRST_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const QUIET_RETENTION_DAYS = 30;

export interface RecordRunLogResult {
  readonly logged: number;
  readonly pruned: number;
}

export async function recordRunLog(pool: Pool, history: RunHistory, request: { readonly limit?: number }): Promise<RecordRunLogResult> {
  const { rows } = await pool.query<{ last: Date | null }>(`SELECT max(closed_at) AS last FROM run_log`);
  const since = rows[0]?.last ? new Date(rows[0].last.getTime() - OVERLAP_MS) : new Date(Date.now() - FIRST_LOOKBACK_MS);
  const runs = await history.listFinishedRuns(since, request.limit ?? 500);

  let logged = 0;
  for (const run of runs) {
    if (run.workflowType === RUN_LOG_SWEEP_TYPE || run.status === 'CONTINUED_AS_NEW') continue;
    const { rows: seen } = await pool.query(`SELECT 1 FROM run_log WHERE workflow_id = $1 AND run_id = $2`, [run.workflowId, run.runId]);
    if (seen.length > 0) continue;

    const line = await describeRun(pool, run, run.status === 'COMPLETED' || run.status === 'FAILED' ? await history.outcome(run) : undefined);
    const { rowCount } = await pool.query(
      `INSERT INTO run_log (workflow_type, workflow_id, run_id, status, category, message, quiet, started_at, closed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (workflow_id, run_id) DO NOTHING`,
      [run.workflowType, run.workflowId, run.runId, run.status, line.category, line.message, line.quiet ?? false, run.startedAt, run.closedAt],
    );
    logged += rowCount ?? 0;
  }

  const { rowCount: pruned } = await pool.query(
    `DELETE FROM run_log WHERE quiet AND closed_at < now() - make_interval(days => $1)`,
    [QUIET_RETENTION_DAYS],
  );
  return { logged, pruned: pruned ?? 0 };
}

// ── Plain-language lines ────────────────────────────────────────────────────

const LABELS: Record<string, string> = {
  DrawDispatchWorkflow: 'Draw scheduler',
  DrawWorkflow: 'Draw run',
  DrawWatchdogWorkflow: 'Draw watchdog',
  EscalationSweepWorkflow: 'Task escalation check',
  EscalationWorkflow: 'Task escalation',
  RandomAllocationSweepWorkflow: 'Random number allocation',
  DirectDebitWorkflow: 'Direct Debit run',
  StackVerificationWorkflow: 'Stack check',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const money = (p: string | number | bigint | undefined) => formatPence(pence(BigInt(p ?? 0)));
const trim = (s: string, max = 240) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

async function drawLabel(pool: Pool, drawIds: readonly string[]): Promise<string> {
  if (drawIds.length === 0) return '';
  const { rows } = await pool.query<{ draw_number: number }>(
    `SELECT draw_number FROM draw WHERE id = ANY($1::uuid[]) ORDER BY draw_number`,
    [drawIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id))],
  );
  const numbers = rows.map((r) => r.draw_number);
  return numbers.length === 0 ? 'a draw' : `${numbers.length === 1 ? 'Draw' : 'Draws'} ${numbers.join(', ')}`;
}

/** The draw a draw-run or watchdog workflow is for, from its ID (`draw-<id>`, `draw-watchdog-<id>`). */
const drawIdFrom = (workflowId: string) => workflowId.replace(/^draw-(watchdog-)?/, '');

async function taskTitle(pool: Pool, workflowId: string): Promise<string> {
  const id = workflowId.replace(/^escalation-/, '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return 'a task';
  const { rows } = await pool.query<{ title: string }>(`SELECT title FROM human_task WHERE id = $1`, [id]);
  return rows[0] ? `"${trim(rows[0].title, 80)}"` : 'a task';
}

/** What a person needs to read about this run, in one sentence. */
export async function describeRun(pool: Pool, run: FinishedRun, outcome: RunOutcome | undefined): Promise<RunLogLine> {
  let label = LABELS[run.workflowType] ?? run.workflowType;
  if (run.workflowType === 'DrawWorkflow' || run.workflowType === 'DrawWatchdogWorkflow') {
    label = `${label} for ${await drawLabel(pool, [drawIdFrom(run.workflowId)])}`;
  }

  switch (run.status) {
    case 'FAILED':
      return { category: 'error', message: `${label} failed: ${trim(outcome && 'failure' in outcome ? outcome.failure : 'no reason given')}` };
    case 'TIMED_OUT':
      return { category: 'error', message: `${label} timed out before finishing.` };
    case 'TERMINATED':
      return { category: 'error', message: `${label} was stopped (terminated) before finishing.` };
    case 'CANCELLED':
      return { category: 'info', message: `${label} was cancelled.` };
    case 'COMPLETED':
      break;
    default:
      return { category: 'info', message: `${label} ended (${run.status.toLowerCase()}).` };
  }

  const result = outcome && 'result' in outcome ? outcome.result : undefined;
  switch (run.workflowType) {
    case 'DrawDispatchWorkflow':
      return describeDispatch(pool, result as { started?: string[]; alreadyRunning?: string[] } | undefined);
    case 'DrawWorkflow':
      return describeDraw(label, result as DrawResultShape | undefined);
    case 'DrawWatchdogWorkflow':
      return result === 'raised'
        ? { category: 'error', message: `${label}: still not finished after 2 hours — a task has been raised.` }
        : result === 'blocked_on_task'
          ? { category: 'info', message: `${label}: waiting on a task, so not raised as overdue.` }
          : { category: 'info', message: `${label}: finished in time.` };
    case 'EscalationSweepWorkflow': {
      const started = (result as { started?: number } | undefined)?.started ?? 0;
      return started > 0
        ? { category: 'info', message: `Task escalation check: now watching ${plural(started, 'new task')}.` }
        : { category: 'info', message: 'Task escalation check: no new tasks.', quiet: true };
    }
    case 'EscalationWorkflow':
      return { category: 'info', message: `Stopped watching ${await taskTitle(pool, run.workflowId)} for escalation: the task is closed.` };
    case 'RandomAllocationSweepWorkflow': {
      const r = (result ?? {}) as { allocated?: number; emailed?: number; postTasks?: number };
      if (!r.allocated) return { category: 'info', message: 'Random number allocation: no lines waiting for numbers.', quiet: true };
      const told = [r.emailed ? `${r.emailed} emailed` : '', r.postTasks ? `${r.postTasks} to post` : ''].filter(Boolean).join(', ');
      return { category: 'success', message: `Gave random numbers to ${plural(r.allocated, 'line')}${told ? ` (${told})` : ''}.` };
    }
    case 'DirectDebitWorkflow':
      return describeDirectDebit(result as DirectDebitResultShape | undefined);
    case 'StackVerificationWorkflow':
      return { category: 'success', message: 'Stack check passed.' };
    default:
      return { category: 'success', message: `${label} completed.` };
  }
}

async function describeDispatch(pool: Pool, r: { started?: string[]; alreadyRunning?: string[] } | undefined): Promise<RunLogLine> {
  const started = r?.started ?? [];
  const running = r?.alreadyRunning ?? [];
  if (started.length > 0) return { category: 'success', message: `Draw scheduler: started the run for ${await drawLabel(pool, started)}.` };
  if (running.length > 0) return { category: 'info', message: `Draw scheduler: ${await drawLabel(pool, running)} already running.` };
  return { category: 'info', message: 'Draw scheduler: no draws due.', quiet: true };
}

interface DrawResultShape {
  status?: string;
  blockedOn?: string;
  jackpotPreDrawPence?: string;
  winnersCount?: number;
  jackpotPaidPence?: string;
  winnersNotificationPending?: number;
  mustBeWonTier?: number;
}

function describeDraw(label: string, r: DrawResultShape | undefined): RunLogLine {
  const subject = label.replace(/^Draw run for /, '');
  if (r?.status !== 'settled') return { category: 'info', message: `${label} ended with the draw ${r?.status ?? 'in an unknown state'}.` };
  const pending = r.winnersNotificationPending ? ` ${plural(r.winnersNotificationPending, 'winner')} still to be told.` : '';
  if (!r.winnersCount) {
    return { category: 'success', message: `${subject} settled: no winner, the ${money(r.jackpotPreDrawPence)} jackpot rolls over.` };
  }
  const tier = r.mustBeWonTier ? ` (must be won — paid at match ${r.mustBeWonTier})` : '';
  return {
    category: 'success',
    message: `${subject} settled: ${plural(r.winnersCount, 'winner')} share ${money(r.jackpotPaidPence)}${tier}.${pending}`,
  };
}

interface DirectDebitResultShape {
  events?: { applied?: number };
  bureauCancellations?: { cancelled?: number };
  prepared?: { collectionMonth?: string; scheduled?: number; postTasks?: number };
  submitted?: { submitted?: number; rejected?: number };
  results?: { collected?: number; retrying?: number; stopped?: number };
}

function describeDirectDebit(r: DirectDebitResultShape | undefined): RunLogLine {
  const month = r?.prepared?.collectionMonth
    ? new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(new Date(`${r.prepared.collectionMonth}T12:00:00Z`))
    : '';
  const parts = [
    r?.events?.applied ? `${plural(r.events.applied, 'bank message')} applied` : '',
    r?.bureauCancellations?.cancelled ? `${plural(r.bureauCancellations.cancelled, 'mandate')} cancelled with the bank` : '',
    r?.prepared?.scheduled ? `${plural(r.prepared.scheduled, 'collection')} for ${month} scheduled and members notified` : '',
    r?.submitted?.submitted ? `${plural(r.submitted.submitted, 'collection')} sent to the bank` : '',
    r?.submitted?.rejected ? `${r.submitted.rejected} refused by the bank` : '',
    r?.results?.collected ? `${r.results.collected} collected` : '',
    r?.results?.retrying ? `${r.results.retrying} failed and will be retried` : '',
    r?.results?.stopped ? `${plural(r.results.stopped, 'Direct Debit')} stopped after a second failure` : '',
  ].filter(Boolean);
  if (parts.length === 0) return { category: 'info', message: 'Direct Debit run: nothing due.', quiet: true };
  const needsAPerson = (r?.results?.stopped ?? 0) > 0 || (r?.submitted?.rejected ?? 0) > 0;
  return { category: needsAPerson ? 'error' : 'success', message: `Direct Debit run: ${parts.join('; ')}.` };
}
