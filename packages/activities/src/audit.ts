/**
 * The audit log (FR-13.1).
 *
 * "Record every financially significant action in an append-only audit log: who,
 * what, before/after, when — including every human decision that unblocked a
 * process."
 *
 * Written by the same database client as the effect it describes wherever
 * possible, so an action and its audit record commit together. An audit trail
 * that can disagree with the ledger is worse than none, because it is trusted.
 */
import type { PoolClient } from 'pg';

export interface AuditRecord {
  readonly actorId?: string;
  /** 'system', or a named user. T-9.3 forbids shared logins, so this is a person. */
  readonly actorLabel: string;
  readonly action: string;
  readonly entity: string;
  readonly entityId?: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly workflowId?: string;
  readonly runId?: string;
}

export async function writeAudit(client: PoolClient, record: AuditRecord): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (actor_id, actor_label, action, entity, entity_id, before, after, workflow_id, run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      record.actorId ?? null,
      record.actorLabel,
      record.action,
      record.entity,
      record.entityId ?? null,
      record.before === undefined ? null : JSON.stringify(record.before),
      record.after === undefined ? null : JSON.stringify(record.after),
      record.workflowId ?? null,
      record.runId ?? null,
    ],
  );
}
