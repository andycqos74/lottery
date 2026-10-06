/**
 * Winner notification — GAP-30 (email) and GAP-05 (no email). `settleDraw`
 * leaves every winning share as a `prize` row with
 * `status = 'pending_notification'`; this picks those up for one draw and
 * tells each winner.
 *
 * GAP-05 (client decision, 2026-10-06): a winner with no email address on
 * record gets a `winner_missing_email` task instead — a person contacts them
 * by post, from the address on their member page. Resolving that task in the
 * admin console marks their prizes notified. This is the only point a missing
 * email address raises anything: it does not matter until someone wins.
 *
 * Idempotent per prize (T-8.2's convention for anything money-adjacent — the
 * idempotency key is derived from `prize.id`, never generated at call time),
 * and the task per (draw, member) by its dedupe key, so a retried activity or
 * a re-run after a partial failure only resends to whoever is still
 * `pending_notification`.
 *
 * A REJECTED send (address bounced at submission) is a real business outcome,
 * not a fault: GAP-46 (notification retry/abandonment policy) is unresolved,
 * so this leaves that prize exactly as `settleDraw` left it —
 * `pending_notification` — for a human to eventually notice, rather than
 * either silently marking an untold winner as told or inventing a retry
 * policy nobody has decided. A THROWN provider error (network, misconfigured
 * credentials) is different: that is Temporal's own activity retry's job, so
 * it propagates rather than being swallowed here.
 */
import type { Pool } from '@qosfc/db';
import { formatPence, pence } from '@qosfc/domain';
import { idempotencyKey, type Notifier } from '@qosfc/ports';
import { openHumanTask } from '../tasks/human-tasks.js';

export const WINNER_MISSING_EMAIL_TASK_KIND = 'winner_missing_email';

export interface NotifyWinnersRequest {
  readonly drawId: string;
  readonly drawNumber: number;
}

export interface NotifyWinnersResult {
  readonly notified: number;
  readonly pending: number;
  /** Winners with no email address, each now a task to contact them by post (GAP-05). */
  readonly postFollowUps: number;
}

export async function notifyWinners(pool: Pool, notifier: Notifier, request: NotifyWinnersRequest): Promise<NotifyWinnersResult> {
  const { rows } = await pool.query<{
    id: string;
    member_id: string;
    amount_pence: string;
    has_email: boolean;
    forename: string | null;
    surname: string | null;
    has_address: boolean;
    has_telephone: boolean;
  }>(
    `SELECT p.id, p.member_id, p.amount_pence, m.email IS NOT NULL AS has_email, m.forename, m.surname,
            (m.address_1 IS NOT NULL AND m.post_code IS NOT NULL) AS has_address, m.telephone IS NOT NULL AS has_telephone
       FROM prize p JOIN member m ON m.id = p.member_id
      WHERE p.draw_id = $1 AND p.status = 'pending_notification'
      ORDER BY p.member_id, p.id`,
    [request.drawId],
  );

  let notified = 0;
  const withoutEmail = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) {
    if (!row.has_email) {
      withoutEmail.set(row.member_id, [...(withoutEmail.get(row.member_id) ?? []), row]);
      continue;
    }
    const outcome = await notifier.send({
      idempotencyKey: idempotencyKey(`prize_notification:${row.id}`),
      memberRef: row.member_id,
      channel: 'email',
      templateId: 'draw_winner',
      mergeData: {
        drawNumber: String(request.drawNumber),
        amount: formatPence(pence(BigInt(row.amount_pence))),
      },
    });

    if (outcome.status === 'accepted') {
      await pool.query(`UPDATE prize SET status = 'notified', notified_at = now() WHERE id = $1`, [row.id]);
      notified++;
    }
  }

  for (const [memberId, prizes] of withoutEmail) {
    const first = prizes[0]!;
    const name = [first.forename, first.surname].filter(Boolean).join(' ') || 'a member with no name recorded';
    const total = formatPence(pence(prizes.reduce((sum, p) => sum + BigInt(p.amount_pence), 0n)));
    const howToReach = first.has_address
      ? 'Their postal address is on their member page.'
      : first.has_telephone
        ? 'There is no full postal address on record, but there is a telephone number on their member page.'
        : 'There is no postal address or telephone number on record either — check the source records.';
    await openHumanTask(pool, {
      kind: WINNER_MISSING_EMAIL_TASK_KIND,
      title: `Tell ${name} they won ${total} in Draw ${request.drawNumber}`,
      detail:
        `This winner has no email address on record, so they have not been told. ${howToReach} ` +
        'Contact them by post. Resolving this task records that they have been told.',
      consequenceIfIgnored: 'The winner does not know they have won, and their prize stays unclaimed.',
      gapId: 'GAP-05',
      entityType: 'member',
      entityId: memberId,
      dedupeKey: `${WINNER_MISSING_EMAIL_TASK_KIND}:${request.drawId}:${memberId}`,
    });
  }

  return { notified, pending: rows.length - notified, postFollowUps: withoutEmail.size };
}
