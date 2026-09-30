import { withTransaction, type Pool } from '@qosfc/db';

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
       (SELECT count(*) FROM human_task WHERE status = 'open' AND due_at IS NOT NULL AND due_at < now()) AS overdue_tasks,
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
  };
}

const TASK_COLUMNS = `id, kind, title, detail, consequence_if_ignored, gap_id, entity_type, entity_id, workflow_id, run_id,
       signal_name, update_name, opened_at, due_at, status, requires_second_approver,
       first_approver_id, second_approver_id, resolved_by, resolved_at`;

/**
 * `status: 'all'` drops the WHERE clause; `'open'` keeps the urgency-first
 * ordering (soonest due date first) since that's the working inbox view,
 * everything else is most-recent-first (a history view).
 */
export async function listTasksByStatus(
  pool: Pool,
  status: HumanTask['status'] | 'all',
  limit = 200,
): Promise<HumanTask[]> {
  if (status === 'open') {
    const { rows } = await pool.query(
      `SELECT ${TASK_COLUMNS} FROM human_task WHERE status = 'open' ORDER BY due_at NULLS LAST, opened_at LIMIT $1`,
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
       (SELECT count(*) FROM entry e WHERE e.draw_id = d.id) AS live_entries_count,
       d.jackpot_pre_draw_pence, d.rollover_in_pence, d.winning_numbers, d.winners_count, d.jackpot_paid_pence,
       d.rollover_out_pence, d.drawn_at, d.settled_at, d.workflow_id`;

export async function listDraws(pool: Pool, limit = 200): Promise<DrawSummary[]> {
  const { rows } = await pool.query<DrawRow>(`SELECT ${DRAW_COLUMNS} FROM draw d ORDER BY d.draw_number DESC LIMIT $1`, [limit]);
  return rows.map(mapDrawRow);
}

export async function getDraw(pool: Pool, id: string): Promise<DrawSummary | undefined> {
  const { rows } = await pool.query<DrawRow>(`SELECT ${DRAW_COLUMNS} FROM draw d WHERE d.id = $1`, [id]);
  const row = rows[0];
  return row ? mapDrawRow(row) : undefined;
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

export async function countEntries(pool: Pool, drawId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM entry WHERE draw_id = $1`, [drawId]);
  return Number(rows[0]!.n);
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

export async function closeDrawAndRecordWorkflow(
  pool: Pool,
  drawId: string,
  workflowId: string,
  entriesCount: number,
): Promise<void> {
  await pool.query(
    `UPDATE draw SET status = 'closed', workflow_id = $2, entries_count = $3 WHERE id = $1`,
    [drawId, workflowId, entriesCount],
  );
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
       FROM member m LEFT JOIN entry e ON e.member_id = m.id
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
