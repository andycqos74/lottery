/**
 * Manual follow-up for members with no email address (GAP-05).
 *
 * The legacy register holds no email addresses; the final data load fills in
 * some. Client decision (2026-10-06): every live member still without one gets
 * a `member_missing_email` task, so a person chases it by post or phone rather
 * than the member silently missing every emailed notice.
 *
 * Run by `ContactFollowUpSweepWorkflow` on a Schedule, so it needs no hook in
 * the data load, the admin console or the portal: whichever way a member
 * arrives without an email, the next sweep finds them. Each task is one
 * member, so it can be worked and resolved on its own.
 *
 * - A task is opened at most once per member: once someone has resolved it
 *   ("no email, contact by post"), the sweep does not re-open it.
 * - Adding the email address (admin member page, or the member themselves)
 *   closes the open task on the next sweep, as `cancelled` — nobody resolved
 *   it, the reason for it went away.
 */
import { withTransaction, type Pool } from '@qosfc/db';
import { writeAudit } from '../audit.js';
import { openHumanTask } from './human-tasks.js';

export const MISSING_EMAIL_TASK_KIND = 'member_missing_email';

/**
 * Not urgent, and there may be hundreds at once after the data load, so the
 * task first goes overdue (GAP-42 escalation) four weeks after it opens rather
 * than after the default 24 hours.
 */
export const MISSING_EMAIL_FOLLOW_UP_DAYS = 28;

/** Members who can still be entered or contacted. Cancelled, deceased, self-excluded and quarantined are not chased. */
const LIVE_STATUSES = `('active', 'lapsed')`;

export const missingEmailDedupeKey = (memberId: string) => `${MISSING_EMAIL_TASK_KIND}:${memberId}`;

export interface SyncMissingEmailTasksRequest {
  /** Tasks opened per run; the next scheduled run carries on from there. */
  readonly limit?: number;
}

export interface SyncMissingEmailTasksResult {
  readonly opened: number;
  readonly closed: number;
}

export async function syncMissingEmailTasks(
  pool: Pool,
  request: SyncMissingEmailTasksRequest,
): Promise<SyncMissingEmailTasksResult> {
  const closed = await closeSatisfiedTasks(pool);

  const { rows } = await pool.query<{
    id: string;
    forename: string | null;
    surname: string | null;
    numbers: number[] | null;
    has_address: boolean;
    telephone: string | null;
  }>(
    `SELECT m.id, m.forename, m.surname, m.telephone,
            (m.address_1 IS NOT NULL AND m.post_code IS NOT NULL) AS has_address,
            (SELECT array_agg(prize_draw_no ORDER BY prize_draw_no) FROM member_number WHERE member_id = m.id) AS numbers
       FROM member m
      WHERE m.email IS NULL AND m.status IN ${LIVE_STATUSES}
        AND NOT EXISTS (
              SELECT 1 FROM human_task t
               WHERE t.kind = $1 AND t.entity_type = 'member' AND t.entity_id = m.id
                 AND t.status IN ('open', 'resolved'))
      ORDER BY m.created_at
      LIMIT $2`,
    [MISSING_EMAIL_TASK_KIND, request.limit ?? 200],
  );

  let opened = 0;
  for (const m of rows) {
    const name = [m.forename, m.surname].filter(Boolean).join(' ') || 'a member with no name recorded';
    const numbers = m.numbers && m.numbers.length > 0 ? ` (prize draw no. ${m.numbers.join(', ')})` : '';
    const howToReach = m.has_address
      ? 'Their postal address is on their member page.'
      : m.telephone
        ? 'There is no full postal address on record, but there is a telephone number on their member page.'
        : 'There is no postal address or telephone number on record either — check the source records or their agent.';
    const result = await openHumanTask(pool, {
      kind: MISSING_EMAIL_TASK_KIND,
      title: `Get an email address for ${name}${numbers}`,
      detail:
        `This member has no email address on record. ${howToReach} ` +
        'Contact them and add their email address on their member page — that closes this task by itself. ' +
        'If they have no email or do not want to give one, resolve this task saying so; it will not be raised again.',
      consequenceIfIgnored:
        'The member receives nothing by email — winner notices, payment confirmations and draw news reach them only by post, if at all.',
      gapId: 'GAP-05',
      entityType: 'member',
      entityId: m.id,
      dueAt: new Date(Date.now() + MISSING_EMAIL_FOLLOW_UP_DAYS * 24 * 60 * 60 * 1000),
      dedupeKey: missingEmailDedupeKey(m.id),
    });
    if (result.created) opened++;
  }

  return { opened, closed };
}

/** Open follow-ups whose member now has an email address, or is no longer someone to chase. */
async function closeSatisfiedTasks(pool: Pool): Promise<number> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string; member_id: string; reason: string }>(
      `UPDATE human_task t
          SET status = 'cancelled', resolved_at = now(),
              resolution = jsonb_build_object('closedBy', 'system',
                'reason', CASE WHEN m.email IS NOT NULL THEN 'email_added' ELSE 'member_' || m.status::text END)
         FROM member m
        WHERE t.kind = $1 AND t.status = 'open' AND t.entity_type = 'member' AND t.entity_id = m.id
          AND (m.email IS NOT NULL OR m.status NOT IN ${LIVE_STATUSES})
        RETURNING t.id, m.id AS member_id, t.resolution->>'reason' AS reason`,
      [MISSING_EMAIL_TASK_KIND],
    );
    for (const row of rows) {
      await writeAudit(client, {
        actorLabel: 'system',
        action: 'human_task.cancelled',
        entity: 'human_task',
        entityId: row.id,
        after: { kind: MISSING_EMAIL_TASK_KIND, memberId: row.member_id, reason: row.reason, gapId: 'GAP-05' },
      });
    }
    return rows.length;
  });
}
