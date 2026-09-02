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
  readonly drawDate: Date;
  readonly status: string;
  readonly entriesCount: number | null;
  readonly jackpotPreDrawPence: bigint | null;
  readonly winningNumbers: number[] | null;
  readonly winnersCount: number | null;
  readonly jackpotPaidPence: bigint | null;
  readonly rolloverOutPence: bigint | null;
  readonly drawnAt: Date | null;
  readonly settledAt: Date | null;
  readonly workflowId: string | null;
}

function mapDrawRow(row: {
  id: string;
  draw_number: number;
  draw_date: Date;
  status: string;
  entries_count: number | null;
  jackpot_pre_draw_pence: bigint | null;
  winning_numbers: number[] | null;
  winners_count: number | null;
  jackpot_paid_pence: bigint | null;
  rollover_out_pence: bigint | null;
  drawn_at: Date | null;
  settled_at: Date | null;
  workflow_id: string | null;
}): DrawSummary {
  return {
    id: row.id,
    drawNumber: row.draw_number,
    drawDate: row.draw_date,
    status: row.status,
    entriesCount: row.entries_count,
    jackpotPreDrawPence: row.jackpot_pre_draw_pence,
    winningNumbers: row.winning_numbers,
    winnersCount: row.winners_count,
    jackpotPaidPence: row.jackpot_paid_pence,
    rolloverOutPence: row.rollover_out_pence,
    drawnAt: row.drawn_at,
    settledAt: row.settled_at,
    workflowId: row.workflow_id,
  };
}

const DRAW_COLUMNS = `id, draw_number, draw_date, status, entries_count, jackpot_pre_draw_pence,
       winning_numbers, winners_count, jackpot_paid_pence, rollover_out_pence, drawn_at, settled_at, workflow_id`;

export async function listDraws(pool: Pool, limit = 50): Promise<DrawSummary[]> {
  const { rows } = await pool.query(`SELECT ${DRAW_COLUMNS} FROM draw ORDER BY draw_number DESC LIMIT $1`, [limit]);
  return rows.map(mapDrawRow);
}

export async function getDraw(pool: Pool, id: string): Promise<DrawSummary | undefined> {
  const { rows } = await pool.query(`SELECT ${DRAW_COLUMNS} FROM draw WHERE id = $1`, [id]);
  const row = rows[0];
  return row ? mapDrawRow(row) : undefined;
}

export async function countEntries(pool: Pool, drawId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM entry WHERE draw_id = $1`, [drawId]);
  return Number(rows[0]!.n);
}

export async function getActiveConfigVersionId(pool: Pool): Promise<string | undefined> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM config_version WHERE is_active = true`);
  return rows[0]?.id;
}

export type CreateDrawOutcome = { readonly kind: 'created'; readonly id: string } | { readonly kind: 'rejected'; readonly reason: string };

export async function createDraw(pool: Pool, input: { drawNumber: number }): Promise<CreateDrawOutcome> {
  const configVersionId = await getActiveConfigVersionId(pool);
  if (!configVersionId) return { kind: 'rejected', reason: 'No active configuration exists — cannot create a draw.' };
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO draw (draw_number, draw_date, status, config_version_id)
       VALUES ($1, CURRENT_DATE, 'open', $2) RETURNING id`,
      [input.drawNumber, configVersionId],
    );
    return { kind: 'created', id: rows[0]!.id };
  } catch (error) {
    if (error instanceof Error && /duplicate key/.test(error.message)) {
      return { kind: 'rejected', reason: `Draw number ${input.drawNumber} already exists.` };
    }
    throw error;
  }
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
    const { rows: drawRows } = await client.query<{ status: string }>(
      `SELECT status FROM draw WHERE id = $1 FOR UPDATE`,
      [input.drawId],
    );
    const draw = drawRows[0];
    if (!draw) return { kind: 'rejected', reason: 'Draw not found.' };
    if (draw.status !== 'open') {
      return { kind: 'rejected', reason: `Draw is '${draw.status}' — entries can only be added while a draw is open.` };
    }

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
