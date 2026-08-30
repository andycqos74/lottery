import type { Pool } from '@qosfc/db';

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
}

export async function insertAuditLog(pool: Pool, entry: AuditEntry): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log (actor_id, actor_label, action, entity, entity_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [entry.actorId ?? null, entry.actorLabel, entry.action, entry.entity, entry.entityId ?? null],
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

const TASK_COLUMNS = `id, kind, title, detail, consequence_if_ignored, gap_id, workflow_id, run_id,
       signal_name, update_name, opened_at, due_at, status, requires_second_approver,
       first_approver_id, second_approver_id, resolved_by, resolved_at`;

export async function listOpenTasks(pool: Pool): Promise<HumanTask[]> {
  const { rows } = await pool.query(
    `SELECT ${TASK_COLUMNS} FROM human_task WHERE status = 'open' ORDER BY due_at NULLS LAST, opened_at`,
  );
  return rows.map(mapTaskRow);
}

export async function listRecentTasks(pool: Pool, limit = 20): Promise<HumanTask[]> {
  const { rows } = await pool.query(`SELECT ${TASK_COLUMNS} FROM human_task ORDER BY opened_at DESC LIMIT $1`, [limit]);
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
