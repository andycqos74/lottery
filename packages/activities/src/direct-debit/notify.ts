/**
 * Telling a member about their Direct Debit: by email when they have an
 * address and the send is accepted, otherwise by a task for a person to post
 * the same thing (the GAP-05 pattern).
 */
import type { Pool } from '@qosfc/db';
import { idempotencyKey, type Notifier } from '@qosfc/ports';
import { openHumanTask } from '../tasks/human-tasks.js';

export const POST_DD_NOTICE_TASK_KIND = 'post_dd_notice';

export interface MemberNotice {
  readonly memberId: string;
  readonly templateId: string;
  readonly mergeData: Readonly<Record<string, string>>;
  /** Stable per notice, so a retry neither re-sends nor raises a second task. */
  readonly key: string;
  /** For the post task: what to tell them, in a sentence or two. */
  readonly postTitle: string;
  readonly postDetail: string;
}

export async function noticeMember(pool: Pool, notifier: Notifier, notice: MemberNotice): Promise<'emailed' | 'post_task'> {
  const { rows } = await pool.query<{ has_email: boolean; forename: string | null; surname: string | null }>(
    `SELECT email IS NOT NULL AS has_email, forename, surname FROM member WHERE id = $1`,
    [notice.memberId],
  );
  const member = rows[0];
  if (member?.has_email) {
    const outcome = await notifier.send({
      idempotencyKey: idempotencyKey(`${notice.templateId}:${notice.key}`.slice(0, 200)),
      memberRef: notice.memberId,
      channel: 'email',
      templateId: notice.templateId,
      mergeData: { forename: member.forename ?? '', ...notice.mergeData },
    });
    if (outcome.status === 'accepted') return 'emailed';
  }

  const name = [member?.forename, member?.surname].filter(Boolean).join(' ') || 'a member with no name recorded';
  await openHumanTask(pool, {
    kind: POST_DD_NOTICE_TASK_KIND,
    title: `${notice.postTitle} — ${name}`,
    detail: `${member?.has_email ? 'The email to this member could not be sent' : 'This member has no email address'}. ${notice.postDetail} Their postal address is on their member page.`,
    consequenceIfIgnored: 'The member is not told about their Direct Debit, which the Direct Debit Guarantee requires.',
    gapId: 'GAP-10',
    entityType: 'member',
    entityId: notice.memberId,
    dedupeKey: `${POST_DD_NOTICE_TASK_KIND}:${notice.templateId}:${notice.key}`.slice(0, 200),
  });
  return 'post_task';
}
