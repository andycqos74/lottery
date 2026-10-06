import { withTransaction, type Pool } from '@qosfc/db';
import { estimateStandingOrderEntries, WEEK_CHANNELS } from '@qosfc/activities';
import { TICKET_PRICE_PENCE } from '@qosfc/domain';

/** Route ids are checked before they reach Postgres, so a bad link is a 404 rather than a uuid cast error. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AppUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly totpSecretEnc: Buffer | null;
  readonly mfaEnrolled: boolean;
  readonly isActive: boolean;
}

export async function findUserByEmail(pool: Pool, email: string): Promise<AppUser | undefined> {
  const { rows } = await pool.query<{
    id: string;
    email: string;
    display_name: string;
    password_hash: string;
    totp_secret_enc: Buffer | null;
    mfa_enrolled: boolean;
    is_active: boolean;
  }>(
    `SELECT id, email, display_name, password_hash, totp_secret_enc, mfa_enrolled, is_active
       FROM app_user WHERE email = $1`,
    [email],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    totpSecretEnc: row.totp_secret_enc,
    mfaEnrolled: row.mfa_enrolled,
    isActive: row.is_active,
  };
}

export async function findUserById(pool: Pool, id: string): Promise<AppUser | undefined> {
  const { rows } = await pool.query<{
    id: string;
    email: string;
    display_name: string;
    password_hash: string;
    totp_secret_enc: Buffer | null;
    mfa_enrolled: boolean;
    is_active: boolean;
  }>(
    `SELECT id, email, display_name, password_hash, totp_secret_enc, mfa_enrolled, is_active
       FROM app_user WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    totpSecretEnc: row.totp_secret_enc,
    mfaEnrolled: row.mfa_enrolled,
    isActive: row.is_active,
  };
}

export async function touchLastLogin(pool: Pool, userId: string): Promise<void> {
  await pool.query(`UPDATE app_user SET last_login_at = now() WHERE id = $1`, [userId]);
}

export interface AuditEntry {
  readonly actorId?: string;
  readonly actorLabel: string;
  readonly action: string;
  readonly entity: string;
  readonly entityId?: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly workflowId?: string;
  readonly runId?: string;
}

export async function insertAuditLog(pool: Pool, entry: AuditEntry): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log (actor_id, actor_label, action, entity, entity_id, before, after, workflow_id, run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.actorId ?? null,
      entry.actorLabel,
      entry.action,
      entry.entity,
      entry.entityId ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.workflowId ?? null,
      entry.runId ?? null,
    ],
  );
}

export interface DashboardCounts {
  readonly openTasks: number;
  readonly overdueTasks: number;
  readonly members: number;
  readonly draws: number;
}

export async function dashboardCounts(pool: Pool): Promise<DashboardCounts> {
  const { rows } = await pool.query<{ open_tasks: string; overdue_tasks: string; members: string; draws: string }>(
    `SELECT
       (SELECT count(*) FROM human_task WHERE status = 'open')                                     AS open_tasks,
       (SELECT count(*) FROM human_task WHERE status = 'open'
          AND ((due_at IS NOT NULL AND due_at < now()) OR escalation_level > 0))                   AS overdue_tasks,
       (SELECT count(*) FROM member)                                                                AS members,
       (SELECT count(*) FROM draw)                                                                  AS draws`,
  );
  const row = rows[0]!;
  return {
    openTasks: Number(row.open_tasks),
    overdueTasks: Number(row.overdue_tasks),
    members: Number(row.members),
    draws: Number(row.draws),
  };
}

export interface HumanTask {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly detail: string;
  readonly consequenceIfIgnored: string;
  readonly gapId: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly workflowId: string | null;
  readonly runId: string | null;
  readonly signalName: string | null;
  readonly updateName: string | null;
  readonly openedAt: Date;
  readonly dueAt: Date | null;
  readonly status: 'open' | 'resolved' | 'expired' | 'cancelled';
  readonly requiresSecondApprover: boolean;
  readonly firstApproverId: string | null;
  readonly secondApproverId: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: Date | null;
  /** FR-5.6: how many times EscalationWorkflow has raised this task for being overdue. */
  readonly escalationLevel: number;
  readonly lastEscalatedAt: Date | null;
}

function mapTaskRow(row: {
  id: string;
  kind: string;
  title: string;
  detail: string;
  consequence_if_ignored: string;
  gap_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  workflow_id: string | null;
  run_id: string | null;
  signal_name: string | null;
  update_name: string | null;
  opened_at: Date;
  due_at: Date | null;
  status: 'open' | 'resolved' | 'expired' | 'cancelled';
  requires_second_approver: boolean;
  first_approver_id: string | null;
  second_approver_id: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  escalation_level: number;
  last_escalated_at: Date | null;
}): HumanTask {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    detail: row.detail,
    consequenceIfIgnored: row.consequence_if_ignored,
    gapId: row.gap_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    workflowId: row.workflow_id,
    runId: row.run_id,
    signalName: row.signal_name,
    updateName: row.update_name,
    openedAt: row.opened_at,
    dueAt: row.due_at,
    status: row.status,
    requiresSecondApprover: row.requires_second_approver,
    firstApproverId: row.first_approver_id,
    secondApproverId: row.second_approver_id,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    escalationLevel: row.escalation_level,
    lastEscalatedAt: row.last_escalated_at,
  };
}

const TASK_COLUMNS = `id, kind, title, detail, consequence_if_ignored, gap_id, entity_type, entity_id, workflow_id, run_id,
       signal_name, update_name, opened_at, due_at, status, requires_second_approver,
       first_approver_id, second_approver_id, resolved_by, resolved_at, escalation_level, last_escalated_at`;

/**
 * `status: 'all'` drops the WHERE clause; `'open'` keeps the urgency-first
 * ordering (most escalated, then soonest due date) since that's the working inbox view,
 * everything else is most-recent-first (a history view).
 */
export async function listTasksByStatus(
  pool: Pool,
  status: HumanTask['status'] | 'all',
  limit = 200,
): Promise<HumanTask[]> {
  if (status === 'open') {
    const { rows } = await pool.query(
      // GAP-05 contact follow-ups can number in the hundreds after the data
      // load; they sort after everything else so they never bury a blocked draw.
      `SELECT ${TASK_COLUMNS} FROM human_task WHERE status = 'open'
        ORDER BY (kind = 'member_missing_email'), escalation_level DESC, due_at NULLS LAST, opened_at LIMIT $1`,
      [limit],
    );
    return rows.map(mapTaskRow);
  }
  if (status === 'all') {
    const { rows } = await pool.query(`SELECT ${TASK_COLUMNS} FROM human_task ORDER BY opened_at DESC LIMIT $1`, [
      limit,
    ]);
    return rows.map(mapTaskRow);
  }
  const { rows } = await pool.query(
    `SELECT ${TASK_COLUMNS} FROM human_task WHERE status = $1 ORDER BY opened_at DESC LIMIT $2`,
    [status, limit],
  );
  return rows.map(mapTaskRow);
}

export async function getTask(pool: Pool, id: string): Promise<HumanTask | undefined> {
  const { rows } = await pool.query(`SELECT ${TASK_COLUMNS} FROM human_task WHERE id = $1`, [id]);
  const row = rows[0];
  return row ? mapTaskRow(row) : undefined;
}

export type ResolveOutcome =
  | { readonly kind: 'resolved' }
  | { readonly kind: 'awaiting-second-approver' }
  | { readonly kind: 'rejected'; readonly reason: string };

/**
 * GAP-44: a single-person override on a gambling payout is not defensible.
 * Mirrors the `approvers_must_be_different` constraint the database already
 * enforces (0006_recon_tasks_audit.sql) so a same-user second approval fails
 * here with a readable message rather than a raw constraint-violation error.
 */
export async function resolveTaskStep(
  pool: Pool,
  taskId: string,
  userId: string,
  note: string,
): Promise<ResolveOutcome> {
  const task = await getTask(pool, taskId);
  if (!task) return { kind: 'rejected', reason: 'Task not found.' };
  if (task.status !== 'open') return { kind: 'rejected', reason: 'Task is no longer open.' };

  if (!task.requiresSecondApprover) {
    await pool.query(
      `UPDATE human_task SET status = 'resolved', resolved_by = $2, resolved_at = now(), resolution = $3
         WHERE id = $1`,
      [taskId, userId, JSON.stringify({ note })],
    );
    return { kind: 'resolved' };
  }

  if (!task.firstApproverId) {
    await pool.query(`UPDATE human_task SET first_approver_id = $2 WHERE id = $1`, [taskId, userId]);
    return { kind: 'awaiting-second-approver' };
  }

  if (task.firstApproverId === userId) {
    return { kind: 'rejected', reason: 'The second approver must be a different person from the first.' };
  }

  await pool.query(
    `UPDATE human_task
        SET second_approver_id = $2, status = 'resolved', resolved_by = $2, resolved_at = now(), resolution = $3
      WHERE id = $1`,
    [taskId, userId, JSON.stringify({ note })],
  );
  return { kind: 'resolved' };
}

export interface DrawSummary {
  readonly id: string;
  readonly drawNumber: number;
  /** #5: free-text name, e.g. "Christmas Special". */
  readonly name: string | null;
  readonly drawDate: Date;
  /** #4: when the draw takes place, and when entries close. NULL on draws created before either existed. */
  readonly drawAt: Date | null;
  readonly entriesCloseAt: Date | null;
  readonly status: string;
  /** Frozen at close — NULL while the draw is still open. */
  readonly entriesCount: number | null;
  /** #7: counted from `entry` directly, so it is meaningful while the draw is open too. */
  readonly liveEntriesCount: number;
  /** Entries expected from active standing orders whose money hasn't arrived yet — for the jackpot estimate only, never real entries. */
  readonly expectedStandingOrderEntries: number;
  readonly jackpotPreDrawPence: bigint | null;
  readonly rolloverInPence: bigint | null;
  readonly winningNumbers: number[] | null;
  readonly winnersCount: number | null;
  readonly jackpotPaidPence: bigint | null;
  readonly rolloverOutPence: bigint | null;
  readonly drawnAt: Date | null;
  readonly settledAt: Date | null;
  readonly workflowId: string | null;
}

interface DrawRow {
  id: string;
  draw_number: number;
  name: string | null;
  draw_date: Date;
  draw_at: Date | null;
  entries_close_at: Date | null;
  status: string;
  entries_count: number | null;
  live_entries_count: string;
  jackpot_pre_draw_pence: bigint | null;
  rollover_in_pence: bigint | null;
  winning_numbers: number[] | null;
  winners_count: number | null;
  jackpot_paid_pence: bigint | null;
  rollover_out_pence: bigint | null;
  drawn_at: Date | null;
  settled_at: Date | null;
  workflow_id: string | null;
}

function mapDrawRow(row: DrawRow): DrawSummary {
  return {
    id: row.id,
    drawNumber: row.draw_number,
    name: row.name,
    drawDate: row.draw_date,
    drawAt: row.draw_at,
    entriesCloseAt: row.entries_close_at,
    status: row.status,
    entriesCount: row.entries_count,
    liveEntriesCount: Number(row.live_entries_count),
    expectedStandingOrderEntries: 0,
    jackpotPreDrawPence: row.jackpot_pre_draw_pence,
    rolloverInPence: row.rollover_in_pence,
    winningNumbers: row.winning_numbers,
    winnersCount: row.winners_count,
    jackpotPaidPence: row.jackpot_paid_pence,
    rolloverOutPence: row.rollover_out_pence,
    drawnAt: row.drawn_at,
    settledAt: row.settled_at,
    workflowId: row.workflow_id,
  };
}

const DRAW_COLUMNS = `d.id, d.draw_number, d.name, d.draw_date, d.draw_at, d.entries_close_at, d.status, d.entries_count,
       (SELECT count(*) FROM entry e WHERE e.draw_id = d.id AND e.voided_at IS NULL) AS live_entries_count,
       d.jackpot_pre_draw_pence, d.rollover_in_pence, d.winning_numbers, d.winners_count, d.jackpot_paid_pence,
       d.rollover_out_pence, d.drawn_at, d.settled_at, d.workflow_id`;

export async function listDraws(pool: Pool, limit = 200): Promise<DrawSummary[]> {
  const { rows } = await pool.query<DrawRow>(`SELECT ${DRAW_COLUMNS} FROM draw d ORDER BY d.draw_number DESC LIMIT $1`, [limit]);
  return withStandingOrderEstimates(pool, rows.map(mapDrawRow));
}

export async function getDraw(pool: Pool, id: string): Promise<DrawSummary | undefined> {
  if (!UUID.test(id)) return undefined;
  const { rows } = await pool.query<DrawRow>(`SELECT ${DRAW_COLUMNS} FROM draw d WHERE d.id = $1`, [id]);
  const row = rows[0];
  return row ? (await withStandingOrderEstimates(pool, [mapDrawRow(row)]))[0] : undefined;
}

async function withStandingOrderEstimates(pool: Pool, draws: DrawSummary[]): Promise<DrawSummary[]> {
  const open = draws.filter((d) => d.status === 'open').map((d) => d.id);
  const estimates = await estimateStandingOrderEntries(pool, open);
  return draws.map((d) => ({ ...d, expectedStandingOrderEntries: estimates.get(d.id) ?? 0 }));
}

export interface JackpotInputs {
  readonly prizeBp: number;
  readonly floorPence: bigint;
  /** What the next draw to settle carries in — the most recent settled draw's rollover out. */
  readonly pendingRolloverPence: bigint;
}

/** #7: what the jackpot figures for draws that haven't settled yet are estimated from. */
export async function getJackpotInputs(pool: Pool): Promise<JackpotInputs> {
  const [{ rows: cfgRows }, { rows: lastRows }] = await Promise.all([
    pool.query<{ split_prize_bp: number; jackpot_floor_pence: bigint }>(
      `SELECT split_prize_bp, jackpot_floor_pence FROM config_version WHERE is_active = true`,
    ),
    pool.query<{ rollover_out_pence: bigint | null }>(
      `SELECT rollover_out_pence FROM draw WHERE status = 'settled' ORDER BY draw_date DESC, draw_number DESC LIMIT 1`,
    ),
  ]);
  return {
    prizeBp: cfgRows[0]?.split_prize_bp ?? 5000,
    floorPence: cfgRows[0]?.jackpot_floor_pence ?? 50_000n,
    pendingRolloverPence: lastRows[0]?.rollover_out_pence ?? 0n,
  };
}

export async function nextDrawNumber(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ next: number }>(`SELECT COALESCE(MAX(draw_number), 0) + 1 AS next FROM draw`);
  return rows[0]!.next;
}

/**
 * GAP-16's confirmed schedule (Friday 12:00, entries close 12h before) as the
 * starting values of the recurring-draw form — only a default for a human to
 * change, so an unset config falls back to the same values rather than halting.
 */
export async function getDrawFormDefaults(pool: Pool): Promise<{ drawTimeLocal: string; cutoffHoursBefore: number }> {
  const { rows } = await pool.query<{ draw_time: string | null; cutoff_hours: string | null }>(
    `SELECT to_char(draw_time_local, 'HH24:MI') AS draw_time,
            (EXTRACT(EPOCH FROM selection_cutoff_before) / 3600)::int::text AS cutoff_hours
       FROM config_version WHERE is_active = true`,
  );
  return {
    drawTimeLocal: rows[0]?.draw_time ?? '12:00',
    cutoffHoursBefore: rows[0]?.cutoff_hours != null ? Number(rows[0].cutoff_hours) : 12,
  };
}

export async function getActiveConfigVersionId(pool: Pool): Promise<string | undefined> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM config_version WHERE is_active = true`);
  return rows[0]?.id;
}

export type CreateDrawsOutcome =
  | { readonly kind: 'created'; readonly ids: readonly string[] }
  | { readonly kind: 'rejected'; readonly reason: string };

export interface DrawScheduleRecord {
  readonly startDate: string;
  readonly endDate: string;
  readonly recurrence: string;
  readonly drawTimeLocal: string;
  readonly cutoffHoursBefore: number;
}

/**
 * #4/#5: inserts every planned draw in one transaction — a series with one
 * clashing draw number creates none of it. Wall-clock values are naive
 * Europe/London times, converted to instants here so BST/GMT comes from the
 * tz database; `draw_date` is kept as the London calendar date of the draw.
 */
export async function createDraws(
  pool: Pool,
  input: {
    name: string | null;
    draws: readonly { drawNumber: number; drawAtLocal: string; entriesCloseAtLocal: string }[];
    schedule?: DrawScheduleRecord;
    createdBy: string;
  },
): Promise<CreateDrawsOutcome> {
  const configVersionId = await getActiveConfigVersionId(pool);
  if (!configVersionId) return { kind: 'rejected', reason: 'No active configuration exists — cannot create a draw.' };

  const { rows: clashes } = await pool.query<{ draw_number: number }>(
    `SELECT draw_number FROM draw WHERE draw_number = ANY($1::int[]) ORDER BY draw_number`,
    [input.draws.map((d) => d.drawNumber)],
  );
  if (clashes.length > 0) {
    const list = clashes.map((c) => c.draw_number).join(', ');
    return clashes.length === 1
      ? { kind: 'rejected', reason: `Draw number ${list} already exists.` }
      : { kind: 'rejected', reason: `Draw numbers ${list} already exist.` };
  }

  try {
    const ids = await withTransaction(pool, async (client) => {
      let scheduleId: string | null = null;
      if (input.schedule) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO draw_schedule (name, start_date, end_date, recurrence, draw_time_local, cutoff_hours_before, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            input.name,
            input.schedule.startDate,
            input.schedule.endDate,
            input.schedule.recurrence,
            input.schedule.drawTimeLocal,
            input.schedule.cutoffHoursBefore,
            input.createdBy,
          ],
        );
        scheduleId = rows[0]!.id;
      }

      const created: string[] = [];
      for (const draw of input.draws) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO draw (draw_number, name, draw_date, draw_at, entries_close_at, draw_schedule_id, status, config_version_id)
           VALUES ($1, $2, ($3::timestamp)::date, $3::timestamp AT TIME ZONE 'Europe/London',
                   $4::timestamp AT TIME ZONE 'Europe/London', $5, 'open', $6)
           RETURNING id`,
          [draw.drawNumber, input.name, draw.drawAtLocal, draw.entriesCloseAtLocal, scheduleId, configVersionId],
        );
        created.push(rows[0]!.id);
      }
      return created;
    });
    return { kind: 'created', ids };
  } catch (error) {
    // Lost a race with another admin creating the same number between the check above and the insert.
    if (error instanceof Error && /duplicate key/.test(error.message)) {
      return { kind: 'rejected', reason: 'One of those draw numbers was just taken — reload and try again.' };
    }
    throw error;
  }
}

/** #5: a draw's name is presentation only, so it may be changed at any status. */
export async function renameDraw(pool: Pool, drawId: string, name: string | null): Promise<void> {
  await pool.query(`UPDATE draw SET name = $2 WHERE id = $1`, [drawId, name]);
}

export interface MemberSummary {
  readonly id: string;
  readonly forename: string | null;
  readonly surname: string | null;
  readonly status: string;
  readonly memberType: string;
  readonly entryCount: number;
}

export async function listMembers(pool: Pool, limit = 200): Promise<MemberSummary[]> {
  const { rows } = await pool.query<{
    id: string;
    forename: string | null;
    surname: string | null;
    status: string;
    member_type: string;
    entry_count: string;
  }>(
    `SELECT m.id, m.forename, m.surname, m.status, m.member_type, count(e.id) AS entry_count
       FROM member m LEFT JOIN entry e ON e.member_id = m.id AND e.voided_at IS NULL
      GROUP BY m.id
      ORDER BY m.created_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    forename: r.forename,
    surname: r.surname,
    status: r.status,
    memberType: r.member_type,
    entryCount: Number(r.entry_count),
  }));
}

/**
 * Agent-type members only — who a physical/agent ticket (GAP-17 prepaid
 * blocks via recordManualTicket) is attributed to, since the actual player
 * has no account and QOSFC cannot identify or contact them directly
 * (db/migrations/0011). Deliberately not the legacy `agent` table.
 */
export async function listAgentMembers(pool: Pool, limit = 200): Promise<MemberSummary[]> {
  const all = await listMembers(pool, limit);
  return all.filter((m) => m.memberType === 'agent');
}

export async function createMember(
  pool: Pool,
  input: { forename: string; surname: string; memberType?: 'player' | 'agent' },
): Promise<{ id: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO member (forename, surname, status, member_type) VALUES ($1, $2, 'active', $3) RETURNING id`,
    [input.forename, input.surname, input.memberType ?? 'player'],
  );
  return { id: rows[0]!.id };
}

/**
 * One live entry, with how it is paid for (GitHub #16, #17). An entry paid
 * from a line's weeks (card blocks, physical tickets, matched standing
 * orders) is the xth of the n weeks that line has paid for — weeks are used
 * by draws soonest first (allocate-upcoming.ts), so x is this draw's place
 * among the line's paid entries. A Direct Debit entry has no x of n.
 */
export interface EntryFundingDetail {
  readonly entryId: string;
  readonly memberId: string;
  readonly selection: number[];
  /** entry_funding: 'prepaid' | 'card' | 'direct_debit' | 'balance' | 'agent'. */
  readonly funding: string;
  /** Paid weeks only: this entry is week `paidIndex` of `paidWeeks`. */
  readonly paidIndex: number | null;
  readonly paidWeeks: number | null;
}

interface EntryFundingRow {
  entry_id: string;
  member_id: string;
  selection: number[];
  funding: string;
  paid_index: string | null;
  paid_pence: string | null;
  paid_entries: string | null;
}

/**
 * Live entries matching `where` (over `e` entry and `d` draw), with their
 * x of n. Payments and entries are counted per line exactly as
 * allocate-upcoming.ts does: a line's own rows, plus rows with no line
 * recorded when it is the member's first line.
 */
async function entryFunding(pool: Pool, where: string, params: unknown[]): Promise<Map<string, EntryFundingDetail>> {
  const { rows } = await pool.query<EntryFundingRow>(
    `WITH first_line AS (
       SELECT DISTINCT ON (mn.member_id) mn.member_id, ss.prize_draw_no, ss.slot
         FROM selection_standing ss JOIN member_number mn ON mn.prize_draw_no = ss.prize_draw_no AND mn.row_type = 'member'
        WHERE ss.effective_to IS NULL
        ORDER BY mn.member_id, ss.prize_draw_no, ss.slot
     ),
     chosen AS (
       SELECT e.id, e.member_id, e.prize_draw_no, e.selection_slot, e.selection, e.funding_source::text AS funding,
              COALESCE(d.draw_at, d.draw_date::timestamptz) AS draw_time, d.draw_number,
              (fl.prize_draw_no = e.prize_draw_no AND fl.slot = e.selection_slot) IS TRUE AS is_first_line
         FROM entry e JOIN draw d ON d.id = e.draw_id
         LEFT JOIN first_line fl ON fl.member_id = e.member_id
        WHERE e.voided_at IS NULL AND (${where})
     )
     SELECT c.id AS entry_id, c.member_id, c.selection, c.funding,
            CASE WHEN c.funding IN ('prepaid', 'card') THEN (
              SELECT count(*) FROM entry e2 JOIN draw d2 ON d2.id = e2.draw_id
               WHERE e2.member_id = c.member_id AND e2.prize_draw_no = c.prize_draw_no AND e2.selection_slot = c.selection_slot
                 AND e2.funding_source IN ('prepaid', 'card') AND e2.voided_at IS NULL
                 AND (COALESCE(d2.draw_at, d2.draw_date::timestamptz), d2.draw_number) <= (c.draw_time, c.draw_number)
            ) END AS paid_index,
            CASE WHEN c.funding IN ('prepaid', 'card') THEN (
              SELECT COALESCE(SUM(p.amount_pence), 0) FROM payment p
               WHERE p.member_id = c.member_id AND p.status = 'allocated' AND p.channel = ANY($${params.length + 1}::payment_channel[])
                 AND ((p.line_prize_draw_no = c.prize_draw_no AND p.line_slot = c.selection_slot)
                      OR (p.line_prize_draw_no IS NULL AND c.is_first_line))
            ) END AS paid_pence,
            CASE WHEN c.funding IN ('prepaid', 'card') THEN (
              SELECT count(*) FROM entry e3
               WHERE e3.member_id = c.member_id AND e3.prize_draw_no = c.prize_draw_no AND e3.selection_slot = c.selection_slot
                 AND e3.funding_source IN ('prepaid', 'card') AND e3.voided_at IS NULL
            ) END AS paid_entries
       FROM chosen c`,
    [...params, WEEK_CHANNELS],
  );
  return new Map(
    rows.map((r) => [
      r.entry_id,
      {
        entryId: r.entry_id,
        memberId: r.member_id,
        selection: r.selection,
        funding: r.funding,
        paidIndex: r.paid_index === null ? null : Number(r.paid_index),
        // Never fewer weeks than entries already paid from them (e.g. a payment later reversed).
        paidWeeks: r.paid_pence === null ? null : Math.max(Number(BigInt(r.paid_pence) / TICKET_PRICE_PENCE), Number(r.paid_entries ?? 0)),
      },
    ]),
  );
}

export interface DrawEntrant {
  readonly memberId: string;
  readonly forename: string | null;
  readonly surname: string | null;
  readonly email: string | null;
  readonly memberType: string;
  readonly entries: readonly EntryFundingDetail[];
}

/** GitHub #16: everyone entered in a draw, one row per member, with each entry's x of n (or DD). */
export async function listDrawEntrants(pool: Pool, drawId: string): Promise<DrawEntrant[]> {
  const [funding, { rows }] = await Promise.all([
    entryFunding(pool, 'e.draw_id = $1', [drawId]),
    pool.query<{ entry_id: string; member_id: string; forename: string | null; surname: string | null; email: string | null; member_type: string }>(
      `SELECT e.id AS entry_id, m.id AS member_id, m.forename, m.surname, m.email, m.member_type
         FROM entry e JOIN member m ON m.id = e.member_id
        WHERE e.draw_id = $1 AND e.voided_at IS NULL
        ORDER BY lower(m.surname), lower(m.forename), m.id, e.selection_slot, e.selection`,
      [drawId],
    ),
  ]);
  const byMember = new Map<string, DrawEntrant & { entries: EntryFundingDetail[] }>();
  for (const r of rows) {
    const entrant = byMember.get(r.member_id) ?? {
      memberId: r.member_id,
      forename: r.forename,
      surname: r.surname,
      email: r.email,
      memberType: r.member_type,
      entries: [],
    };
    const detail = funding.get(r.entry_id);
    if (detail) entrant.entries.push(detail);
    byMember.set(r.member_id, entrant);
  }
  return [...byMember.values()];
}

export interface MemberProfile {
  readonly id: string;
  readonly forename: string | null;
  readonly surname: string | null;
  readonly email: string | null;
  readonly telephone: string | null;
  readonly address1: string | null;
  readonly address2: string | null;
  /** Town. */
  readonly address3: string | null;
  readonly county: string | null;
  readonly postCode: string | null;
  readonly preferredContact: string;
  readonly status: string;
  readonly memberType: string;
  readonly prizeDrawNumbers: readonly number[];
  readonly createdAt: Date;
}

export interface MemberPayment {
  readonly id: string;
  readonly receivedDate: Date;
  readonly channel: string;
  readonly amountPence: bigint;
  readonly status: string;
  readonly reference: string | null;
  /** The numbers of the line it paid for, when one is recorded. */
  readonly lineSelection: number[] | null;
}

export interface MemberUpcomingEntry extends EntryFundingDetail {
  readonly drawId: string;
  readonly drawNumber: number;
  readonly drawName: string | null;
  readonly drawStatus: string;
  readonly drawAt: Date | null;
  readonly drawDate: Date;
}

export interface MemberPage {
  readonly profile: MemberProfile;
  readonly payments: readonly MemberPayment[];
  readonly upcoming: readonly MemberUpcomingEntry[];
}

/** GitHub #17: a member's details, every payment, and the draws not yet run that they are entered in. */
export async function getMemberPage(pool: Pool, memberId: string): Promise<MemberPage | undefined> {
  if (!UUID.test(memberId)) return undefined;
  const { rows: memberRows } = await pool.query<{
    id: string;
    forename: string | null;
    surname: string | null;
    email: string | null;
    telephone: string | null;
    address_1: string | null;
    address_2: string | null;
    address_3: string | null;
    county: string | null;
    post_code: string | null;
    preferred_contact: string;
    status: string;
    member_type: string;
    created_at: Date;
    numbers: number[] | null;
  }>(
    `SELECT m.id, m.forename, m.surname, m.email, m.telephone, m.address_1, m.address_2, m.address_3, m.county,
            m.post_code, m.preferred_contact, m.status, m.member_type, m.created_at,
            (SELECT array_agg(prize_draw_no ORDER BY prize_draw_no) FROM member_number WHERE member_id = m.id) AS numbers
       FROM member m WHERE m.id = $1`,
    [memberId],
  );
  const m = memberRows[0];
  if (!m) return undefined;

  // Not yet drawn: still open, or closed and waiting to be run.
  const upcomingWhere = `e.member_id = $1 AND d.status IN ('open', 'closed')`;
  const [{ rows: paymentRows }, funding, { rows: upcomingRows }] = await Promise.all([
    pool.query<{
      id: string;
      received_date: Date;
      channel: string;
      amount_pence: string;
      status: string;
      source_reference: string | null;
      line_selection: number[] | null;
    }>(
      `SELECT p.id, p.received_date, p.channel, p.amount_pence::text, p.status, p.source_reference,
              (SELECT ss.selection FROM selection_standing ss
                WHERE ss.prize_draw_no = p.line_prize_draw_no AND ss.slot = p.line_slot
                ORDER BY ss.effective_to IS NULL DESC, ss.effective_from DESC LIMIT 1) AS line_selection
         FROM payment p
        WHERE p.member_id = $1
        ORDER BY p.received_date DESC, p.created_at DESC`,
      [memberId],
    ),
    entryFunding(pool, upcomingWhere, [memberId]),
    pool.query<{ entry_id: string; draw_id: string; draw_number: number; name: string | null; status: string; draw_at: Date | null; draw_date: Date }>(
      `SELECT e.id AS entry_id, d.id AS draw_id, d.draw_number, d.name, d.status, d.draw_at, d.draw_date
         FROM entry e JOIN draw d ON d.id = e.draw_id
        WHERE e.voided_at IS NULL AND ${upcomingWhere}
        ORDER BY COALESCE(d.draw_at, d.draw_date::timestamptz), d.draw_number, e.selection_slot, e.selection`,
      [memberId],
    ),
  ]);

  return {
    profile: {
      id: m.id,
      forename: m.forename,
      surname: m.surname,
      email: m.email,
      telephone: m.telephone,
      address1: m.address_1,
      address2: m.address_2,
      address3: m.address_3,
      county: m.county,
      postCode: m.post_code,
      preferredContact: m.preferred_contact,
      status: m.status,
      memberType: m.member_type,
      prizeDrawNumbers: m.numbers ?? [],
      createdAt: m.created_at,
    },
    payments: paymentRows.map((p) => ({
      id: p.id,
      receivedDate: p.received_date,
      channel: p.channel,
      amountPence: BigInt(p.amount_pence),
      status: p.status,
      reference: p.source_reference,
      lineSelection: p.line_selection,
    })),
    upcoming: upcomingRows.flatMap((r) => {
      const detail = funding.get(r.entry_id);
      return detail
        ? [{ ...detail, drawId: r.draw_id, drawNumber: r.draw_number, drawName: r.name, drawStatus: r.status, drawAt: r.draw_at, drawDate: r.draw_date }]
        : [];
    }),
  };
}

export type AddEntryOutcome =
  | { readonly kind: 'added'; readonly entryId: string }
  | { readonly kind: 'rejected'; readonly reason: string };

/**
 * Assigns a fresh `prize_draw_no` (legacy concept, irrelevant to manually
 * added test data) and inserts the member_number + entry together. Rejects
 * — rather than letting `forbid_entry_change_after_draw()` raise a raw
 * constraint error — when the draw isn't open, with a readable message.
 */
export async function addEntry(
  pool: Pool,
  input: { drawId: string; memberId: string; selection: readonly number[] },
): Promise<AddEntryOutcome> {
  const selection = [...new Set(input.selection)].sort((a, b) => a - b);
  if (selection.length !== 4 || selection.some((n) => n < 1 || n > 20)) {
    return { kind: 'rejected', reason: 'A selection must be four distinct numbers between 1 and 20.' };
  }

  return withTransaction(pool, async (client) => {
    const { rows: drawRows } = await client.query<{ status: string; past_cutoff: boolean }>(
      `SELECT status, COALESCE(entries_close_at <= now(), false) AS past_cutoff FROM draw WHERE id = $1 FOR UPDATE`,
      [input.drawId],
    );
    const draw = drawRows[0];
    if (!draw) return { kind: 'rejected', reason: 'Draw not found.' };
    if (draw.status !== 'open') {
      return { kind: 'rejected', reason: `Draw is '${draw.status}' — entries can only be added while a draw is open.` };
    }
    // #4: the cutoff is the point after which entries are not allowed.
    if (draw.past_cutoff) return { kind: 'rejected', reason: 'Entries for this draw have closed.' };

    // A member never has two entries in one draw with the same numbers.
    // Agents are exempt: their tickets belong to different players.
    const { rows: dupRows } = await client.query(
      `SELECT 1 FROM entry e JOIN member m ON m.id = e.member_id
        WHERE e.draw_id = $1 AND e.member_id = $2 AND e.selection = $3::int[] AND e.voided_at IS NULL AND m.member_type <> 'agent'
        LIMIT 1`,
      [input.drawId, input.memberId, selection],
    );
    if (dupRows.length > 0) return { kind: 'rejected', reason: 'This member is already entered in this draw with those numbers.' };

    const { rows: nextNoRows } = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(prize_draw_no), 99999) + 1 AS next FROM member_number`,
    );
    const prizeDrawNo = nextNoRows[0]!.next;

    await client.query(`INSERT INTO member_number (prize_draw_no, member_id, row_type) VALUES ($1, $2, 'member')`, [
      prizeDrawNo,
      input.memberId,
    ]);

    const { rows: entryRows } = await client.query<{ id: string }>(
      `INSERT INTO entry (draw_id, member_id, prize_draw_no, selection, funding_source, idempotency_key)
       VALUES ($1, $2, $3, $4, 'balance', $5)
       RETURNING id`,
      [input.drawId, input.memberId, prizeDrawNo, selection, `${input.drawId}:${prizeDrawNo}:1`],
    );

    return { kind: 'added', entryId: entryRows[0]!.id };
  });
}

export const CONTACT_CHANNELS = ['post', 'email', 'phone', 'via_agent'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export interface MemberContactInput {
  readonly email: string;
  readonly telephone: string;
  readonly address1: string;
  readonly address2: string;
  readonly address3: string;
  readonly county: string;
  readonly postCode: string;
  readonly preferredContact: ContactChannel;
}

export type UpdateMemberContactOutcome = { kind: 'updated' } | { kind: 'rejected'; reason: string } | { kind: 'not_found' };

/**
 * Email, telephone and postal address (GAP-05), all optional — blank clears
 * the field. Adding an email address is what closes a member's
 * `member_missing_email` follow-up task, on the next contact follow-up sweep.
 */
export async function updateMemberContact(
  pool: Pool,
  memberId: string,
  input: MemberContactInput,
  actor: { id: string; label: string },
): Promise<UpdateMemberContactOutcome> {
  if (!UUID.test(memberId)) return { kind: 'not_found' };
  const email = input.email.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { kind: 'rejected', reason: 'That email address does not look right.' };
  }
  if (input.preferredContact === 'email' && !email) {
    return { kind: 'rejected', reason: 'Preferred contact is email, but no email address is given.' };
  }

  return withTransaction(pool, async (client) => {
    const { rows: beforeRows } = await client.query<Record<string, string | null>>(
      `SELECT email, telephone, address_1, address_2, address_3, county, post_code, preferred_contact
         FROM member WHERE id = $1 FOR UPDATE`,
      [memberId],
    );
    const before = beforeRows[0];
    if (!before) return { kind: 'not_found' };

    // The member portal signs in by email, so two members cannot share one.
    if (email) {
      const { rows: clash } = await client.query(`SELECT 1 FROM member WHERE email = $1 AND id <> $2 LIMIT 1`, [email, memberId]);
      if (clash.length > 0) return { kind: 'rejected', reason: 'Another member already has that email address.' };
    }

    const blank = (v: string) => v.trim() || null;
    const postCode = input.postCode.trim().toUpperCase() || null;
    const { rows: afterRows } = await client.query<Record<string, string | null>>(
      `UPDATE member
          SET email = $2, telephone = $3, address_1 = $4, address_2 = $5, address_3 = $6, county = $7,
              post_code = $8, post_code_valid = CASE WHEN post_code IS NOT DISTINCT FROM $8 THEN post_code_valid ELSE false END,
              preferred_contact = $9, updated_at = now()
        WHERE id = $1
        RETURNING email, telephone, address_1, address_2, address_3, county, post_code, preferred_contact`,
      [
        memberId,
        email || null,
        blank(input.telephone),
        blank(input.address1),
        blank(input.address2),
        blank(input.address3),
        blank(input.county),
        postCode,
        input.preferredContact,
      ],
    );
    await client.query(
      `INSERT INTO audit_log (actor_id, actor_label, action, entity, entity_id, before, after)
       VALUES ($1, $2, 'member_contact_updated', 'member', $3, $4, $5)`,
      [actor.id, actor.label, memberId, JSON.stringify(before), JSON.stringify(afterRows[0])],
    );
    return { kind: 'updated' };
  });
}

// ── Bank reconciliation (GAP-33) ────────────────────────────────────────────

export interface BankStatementSummary {
  readonly id: string;
  readonly statementNumber: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly source: string;
  readonly ingestedAt: string;
  readonly transactionCount: number;
  readonly matched: number;
  readonly ambiguous: number;
  readonly unmatched: number;
}

export async function listBankStatements(pool: Pool, limit = 100): Promise<BankStatementSummary[]> {
  const { rows } = await pool.query<{
    id: string;
    statement_number: number;
    period_start: string;
    period_end: string;
    source: string;
    ingested_at: string;
    total: string;
    matched: string;
    ambiguous: string;
    unmatched: string;
  }>(
    `SELECT s.id, s.statement_number, s.period_start::text, s.period_end::text, s.source::text, s.ingested_at::text,
            count(t.id) AS total,
            count(t.id) FILTER (WHERE t.match_status = 'matched')   AS matched,
            count(t.id) FILTER (WHERE t.match_status = 'ambiguous') AS ambiguous,
            count(t.id) FILTER (WHERE t.match_status = 'unmatched') AS unmatched
       FROM bank_statement s LEFT JOIN bank_transaction t ON t.statement_id = s.id
      GROUP BY s.id
      ORDER BY s.statement_number DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    statementNumber: r.statement_number,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    source: r.source,
    ingestedAt: r.ingested_at,
    transactionCount: Number(r.total),
    matched: Number(r.matched),
    ambiguous: Number(r.ambiguous),
    unmatched: Number(r.unmatched),
  }));
}

export interface BankTransactionRow {
  readonly id: string;
  readonly valueDate: string;
  readonly description: string | null;
  readonly typeRaw: string | null;
  readonly amountPence: string;
  readonly extractedReference: string | null;
  readonly matchStatus: string;
  readonly candidatePrizeDrawNos: readonly number[];
}

export interface BankStatementDetail extends BankStatementSummary {
  readonly transactions: readonly BankTransactionRow[];
}

export async function getBankStatement(pool: Pool, id: string): Promise<BankStatementDetail | undefined> {
  const { rows: statementRows } = await pool.query<{
    id: string;
    statement_number: number;
    period_start: string;
    period_end: string;
    source: string;
    ingested_at: string;
  }>(
    `SELECT id, statement_number, period_start::text, period_end::text, source::text, ingested_at::text
       FROM bank_statement WHERE id = $1`,
    [id],
  );
  const statement = statementRows[0];
  if (!statement) return undefined;

  const { rows: txnRows } = await pool.query<{
    id: string;
    value_date: string;
    description: string | null;
    type_raw: string | null;
    amount_pence: string;
    extracted_reference: string | null;
    match_status: string;
    candidate_prize_draw_nos: number[] | null;
  }>(
    `SELECT t.id, t.value_date::text, t.description, t.type_raw, t.amount_pence::text,
            t.extracted_reference, t.match_status::text,
            array_agg(c.prize_draw_no) FILTER (WHERE c.prize_draw_no IS NOT NULL) AS candidate_prize_draw_nos
       FROM bank_transaction t LEFT JOIN match_candidate c ON c.bank_transaction_id = t.id
      WHERE t.statement_id = $1
      GROUP BY t.id
      ORDER BY t.value_date, t.id`,
    [id],
  );

  const transactions = txnRows.map((r) => ({
    id: r.id,
    valueDate: r.value_date,
    description: r.description,
    typeRaw: r.type_raw,
    amountPence: r.amount_pence,
    extractedReference: r.extracted_reference,
    matchStatus: r.match_status,
    candidatePrizeDrawNos: r.candidate_prize_draw_nos ?? [],
  }));

  return {
    id: statement.id,
    statementNumber: statement.statement_number,
    periodStart: statement.period_start,
    periodEnd: statement.period_end,
    source: statement.source,
    ingestedAt: statement.ingested_at,
    transactionCount: transactions.length,
    matched: transactions.filter((t) => t.matchStatus === 'matched').length,
    ambiguous: transactions.filter((t) => t.matchStatus === 'ambiguous').length,
    unmatched: transactions.filter((t) => t.matchStatus === 'unmatched').length,
    transactions,
  };
}

// ── Bank transaction review (FR-5.8.3) ──────────────────────────────────────
// What a `bank_transaction_review` human_task needs to let a person actually
// pick a candidate, rather than just close the task with a note and leave the
// money unallocated — see match-transactions.ts's `acceptBankTransactionMatchTx`.

export interface BankMatchCandidate {
  readonly prizeDrawNo: number;
  readonly confidence: number;
  readonly memberName: string | null;
  readonly decision: string;
}

export interface BankTransactionForReview {
  readonly id: string;
  readonly valueDate: string;
  readonly description: string | null;
  readonly amountPence: string;
  readonly extractedReference: string | null;
  readonly matchStatus: string;
  readonly candidates: readonly BankMatchCandidate[];
}

export async function getBankTransactionForReview(pool: Pool, bankTransactionId: string): Promise<BankTransactionForReview | undefined> {
  const { rows: txnRows } = await pool.query<{
    id: string;
    value_date: string;
    description: string | null;
    amount_pence: string;
    extracted_reference: string | null;
    match_status: string;
  }>(
    `SELECT id, value_date::text, description, amount_pence::text, extracted_reference, match_status::text
       FROM bank_transaction WHERE id = $1`,
    [bankTransactionId],
  );
  const txn = txnRows[0];
  if (!txn) return undefined;

  const { rows: candRows } = await pool.query<{
    prize_draw_no: number;
    confidence: string;
    decision: string;
    forename: string | null;
    surname: string | null;
  }>(
    `SELECT mc.prize_draw_no, mc.confidence::text, mc.decision::text, m.forename, m.surname
       FROM match_candidate mc
       JOIN member_number mn ON mn.prize_draw_no = mc.prize_draw_no
       LEFT JOIN member m ON m.id = mn.member_id
      WHERE mc.bank_transaction_id = $1
      ORDER BY mc.confidence DESC`,
    [bankTransactionId],
  );

  return {
    id: txn.id,
    valueDate: txn.value_date,
    description: txn.description,
    amountPence: txn.amount_pence,
    extractedReference: txn.extracted_reference,
    matchStatus: txn.match_status,
    candidates: candRows.map((c) => ({
      prizeDrawNo: c.prize_draw_no,
      confidence: Number(c.confidence),
      memberName: c.forename && c.surname ? `${c.forename} ${c.surname}` : null,
      decision: c.decision,
    })),
  };
}
