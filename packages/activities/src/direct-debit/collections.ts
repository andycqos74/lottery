/**
 * Collecting Direct Debit money — monthly, in advance (client decision,
 * 2026-10-07). Three steps, each safe to run any number of times, driven by
 * `DirectDebitWorkflow` on a Schedule:
 *
 * 1. `prepareCollections` — in the window 14 to 10 days before the month's
 *    collection date, works out each confirmed mandate's amount and tells the
 *    member (the advance notice). The amount is £2 for each of the line's
 *    Direct Debit entries in draws up to the end of that month not already
 *    collected for: that month's draws in advance, plus any earlier ones the
 *    mandate entered before its first collection. Paid weeks on the same
 *    numbers are used first (B-18), so those draws simply aren't Direct Debit
 *    entries and cost nothing here.
 * 2. `submitDueCollections` — sends the bureau each batch due to go.
 * 3. `processCollectionResults` — once results are in: money collected
 *    becomes a payment; a first failure is retried once, a week later, with
 *    the member told; a second failure ends the Direct Debit and withdraws its
 *    unpaid entries from draws still taking entries (GAP-11).
 *
 * Every function takes an optional `asOf` UK date, which only the Direct
 * Debit workflow's manual dev runs set, to bring a month forward for testing.
 */
import { createHash } from 'node:crypto';
import { withTransaction, type Pool } from '@qosfc/db';
import { formatPence, pence } from '@qosfc/domain';
import { idempotencyKey, type BacsBureau, type Notifier } from '@qosfc/ports';
import { writeAudit } from '../audit.js';
import { openHumanTask } from '../tasks/human-tasks.js';
import {
  ADVANCE_NOTICE_DAYS,
  PREPARE_DAYS_BEFORE,
  RETRY_AFTER_DAYS,
  SUBMIT_WORKING_DAYS_BEFORE,
  addDays,
  collectionDateFor,
  firstOfNextMonth,
  formatUkDate,
  onOrNextWorkingDay,
  ukToday,
  workingDaysBefore,
} from './dates.js';
import { endDirectDebit } from './mandates.js';
import { noticeMember } from './notify.js';

export const DD_STOPPED_TASK_KIND = 'dd_collection_stopped';
export const DD_REJECTED_TASK_KIND = 'dd_submission_rejected';

export interface DirectDebitStepRequest {
  /** UK date to act as if it were today — dev runs only. */
  readonly asOf?: string;
}

const money = (p: string | bigint) => formatPence(pence(BigInt(p)));
const numbersLabel = (s: readonly number[] | null) => (s ? s.join(' · ') : 'your numbers');

// ── 1. Prepare ──────────────────────────────────────────────────────────────

export interface PrepareCollectionsResult {
  readonly collectionMonth: string;
  readonly inWindow: boolean;
  readonly scheduled: number;
  readonly emailed: number;
  readonly postTasks: number;
}

export async function prepareCollections(pool: Pool, notifier: Notifier, request: DirectDebitStepRequest): Promise<PrepareCollectionsResult> {
  const today = request.asOf ?? ukToday();
  const month = firstOfNextMonth(today);
  const collectionDate = collectionDateFor(month);
  const inWindow = today >= addDays(collectionDate, -PREPARE_DAYS_BEFORE) && today <= addDays(collectionDate, -ADVANCE_NOTICE_DAYS);

  let scheduled = 0;
  if (inWindow) {
    const { rows: cycleRows } = await pool.query<{ id: string }>(
      `INSERT INTO dd_collection_cycle (collection_month, collection_date) VALUES ($1, $2)
       ON CONFLICT (collection_month) DO UPDATE SET collection_month = EXCLUDED.collection_month
       RETURNING id`,
      [month, collectionDate],
    );
    const cycleId = cycleRows[0]!.id;
    const monthEnd = firstOfNextMonth(month);

    // Confirmed mandates with no collection in this cycle yet. A mandate
    // confirmed after the window waits for next month's, which also picks
    // up the draws it entered in the meantime.
    const { rows: mandates } = await pool.query<{
      id: string;
      member_id: string;
      mandate_ref: string;
      line_prize_draw_no: number | null;
      line_slot: number | null;
    }>(
      `SELECT pm.id, pm.member_id, pm.mandate_ref, pm.line_prize_draw_no, pm.line_slot
         FROM payment_method pm
        WHERE pm.type = 'direct_debit' AND pm.active AND pm.mandate_status = 'active' AND pm.mandate_ref IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM dd_collection c WHERE c.cycle_id = $1 AND c.payment_method_id = pm.id)
        ORDER BY pm.created_at`,
      [cycleId],
    );

    for (const pm of mandates) {
      const created = await withTransaction(pool, async (client) => {
        await client.query(`SELECT 1 FROM payment_method WHERE id = $1 FOR UPDATE`, [pm.id]);
        const { rows: entries } = await client.query<{ id: string; stake_pence: string }>(
          `SELECT e.id, e.stake_pence::text FROM entry e JOIN draw d ON d.id = e.draw_id
            WHERE e.member_id = $1 AND e.funding_source = 'direct_debit' AND e.voided_at IS NULL
              AND ($2::int IS NULL OR (e.prize_draw_no = $2 AND e.selection_slot = $3))
              AND COALESCE(d.draw_at, d.draw_date::timestamptz) < ($4::date::timestamp AT TIME ZONE 'Europe/London')
              AND NOT EXISTS (
                    SELECT 1 FROM dd_collection_entry ce JOIN dd_collection c ON c.id = ce.collection_id
                     WHERE ce.entry_id = e.id AND c.status IN ('scheduled', 'submitted', 'collected'))
            ORDER BY COALESCE(d.draw_at, d.draw_date::timestamptz)`,
          [pm.member_id, pm.line_prize_draw_no, pm.line_slot, monthEnd],
        );
        if (entries.length === 0) return false;
        const amount = entries.reduce((sum, e) => sum + BigInt(e.stake_pence), 0n);
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO dd_collection
             (cycle_id, payment_method_id, member_id, mandate_ref, attempt, amount_pence, draws_covered, submit_on, collection_date)
           VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8)
           ON CONFLICT (cycle_id, payment_method_id, attempt) DO NOTHING
           RETURNING id`,
          [cycleId, pm.id, pm.member_id, pm.mandate_ref, amount.toString(), entries.length, workingDaysBefore(collectionDate, SUBMIT_WORKING_DAYS_BEFORE), collectionDate],
        );
        const collectionId = rows[0]?.id;
        if (!collectionId) return false;
        await client.query(
          `INSERT INTO dd_collection_entry (collection_id, entry_id) SELECT $1, unnest($2::uuid[])`,
          [collectionId, entries.map((e) => e.id)],
        );
        await writeAudit(client, {
          actorLabel: 'system',
          action: 'direct_debit.collection_scheduled',
          entity: 'dd_collection',
          entityId: collectionId,
          after: { paymentMethodId: pm.id, amountPence: amount.toString(), draws: entries.length, collectionDate },
        });
        return true;
      });
      if (created) scheduled++;
    }
  }

  // The advance notice, for every first attempt not yet told.
  const { emailed, postTasks } = await sendNotices(pool, notifier, 'attempt = 1', (c) => ({
    templateId: 'dd_advance_notice',
    mergeData: { amount: money(c.amount_pence), date: formatUkDate(c.collection_date), draws: String(c.draws_covered), numbers: numbersLabel(c.selection) },
    postTitle: 'Post a Direct Debit advance notice',
    postDetail: `Tell them ${money(c.amount_pence)} will be collected by Direct Debit on or just after ${formatUkDate(c.collection_date)}, for ${c.draws_covered} draw${c.draws_covered === 1 ? '' : 's'} on the numbers ${numbersLabel(c.selection)}.`,
  }));

  return { collectionMonth: month, inWindow, scheduled, emailed, postTasks };
}

interface NoticeRow {
  id: string;
  member_id: string;
  amount_pence: string;
  draws_covered: number;
  collection_date: string;
  selection: number[] | null;
}

async function sendNotices(
  pool: Pool,
  notifier: Notifier,
  which: string,
  build: (c: NoticeRow) => { templateId: string; mergeData: Record<string, string>; postTitle: string; postDetail: string },
): Promise<{ emailed: number; postTasks: number }> {
  const { rows } = await pool.query<NoticeRow>(
    `SELECT c.id, c.member_id, c.amount_pence::text, c.draws_covered, to_char(c.collection_date, 'YYYY-MM-DD') AS collection_date,
            (SELECT ss.selection FROM selection_standing ss
              WHERE ss.prize_draw_no = pm.line_prize_draw_no AND ss.slot = pm.line_slot AND ss.effective_to IS NULL) AS selection
       FROM dd_collection c JOIN payment_method pm ON pm.id = c.payment_method_id
      WHERE c.status = 'scheduled' AND c.notified_at IS NULL AND ${which}
      ORDER BY c.created_at LIMIT 500`,
  );
  let emailed = 0;
  let postTasks = 0;
  for (const c of rows) {
    const notice = build(c);
    const how = await noticeMember(pool, notifier, { memberId: c.member_id, key: c.id, ...notice });
    if (how === 'emailed') emailed++;
    else postTasks++;
    await pool.query(`UPDATE dd_collection SET notified_at = now(), updated_at = now() WHERE id = $1`, [c.id]);
  }
  return { emailed, postTasks };
}

// ── 2. Submit ───────────────────────────────────────────────────────────────

export interface SubmitDueCollectionsResult {
  readonly batches: number;
  readonly submitted: number;
  readonly rejected: number;
}

export async function submitDueCollections(pool: Pool, bureau: BacsBureau, request: DirectDebitStepRequest): Promise<SubmitDueCollectionsResult> {
  const today = request.asOf ?? ukToday();
  // Not before the member has been told (the advance notice), and only for mandates still live.
  const { rows } = await pool.query<{
    id: string;
    member_id: string;
    mandate_ref: string;
    amount_pence: string;
    collection_month: string;
    attempt: number;
    submit_on: string;
  }>(
    `SELECT c.id, c.member_id, c.mandate_ref, c.amount_pence::text, to_char(cy.collection_month, 'YYYY-MM') AS collection_month,
            c.attempt, to_char(c.submit_on, 'YYYY-MM-DD') AS submit_on
       FROM dd_collection c
       JOIN dd_collection_cycle cy ON cy.id = c.cycle_id
       JOIN payment_method pm ON pm.id = c.payment_method_id
      WHERE c.status = 'scheduled' AND c.submit_on <= $1::date AND c.notified_at IS NOT NULL
        AND pm.active AND pm.mandate_status = 'active'
      ORDER BY c.submit_on, c.id`,
    [today],
  );

  const batches = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.collection_month}:attempt-${r.attempt}:${r.submit_on}`;
    batches.set(key, [...(batches.get(key) ?? []), r]);
  }

  let submitted = 0;
  let rejected = 0;
  for (const [cycleKey, batch] of batches) {
    // Keyed on exactly what is in the batch, so a retry after a timeout resends the same thing.
    const digest = createHash('sha256').update(batch.map((c) => c.id).join(',')).digest('hex').slice(0, 24);
    const receipt = await bureau.submitCollections({
      idempotencyKey: idempotencyKey(`dd-submit:${cycleKey}:${digest}`),
      cycleKey,
      instructions: batch.map((c) => ({ memberRef: c.member_id, mandateRef: c.mandate_ref, amountPence: c.amount_pence })),
    });
    const rejectedMembers = new Map(receipt.rejections.map((r) => [r.memberRef, r]));

    await withTransaction(pool, async (client) => {
      for (const c of batch) {
        const rejection = rejectedMembers.get(c.member_id);
        if (rejection) {
          await client.query(
            `UPDATE dd_collection SET status = 'rejected', failure_code = $2, failure_reason = $3, updated_at = now() WHERE id = $1`,
            [c.id, rejection.reasonCode, rejection.reason],
          );
          rejected++;
        } else {
          await client.query(
            `UPDATE dd_collection SET status = 'submitted', submission_id = $2, results_expected_at = $3, updated_at = now() WHERE id = $1`,
            [c.id, receipt.submissionId, receipt.resultsExpectedAt],
          );
          submitted++;
        }
      }
      await writeAudit(client, {
        actorLabel: 'system',
        action: 'direct_debit.batch_submitted',
        entity: 'dd_collection_cycle',
        after: { cycleKey, submissionId: receipt.submissionId, accepted: receipt.acceptedCount, rejected: receipt.rejectedCount },
      });
    });

    // T-5.6: a validation rejection is permanent — a person looks, nothing resubmits it.
    for (const c of batch.filter((b) => rejectedMembers.has(b.member_id))) {
      const rejection = rejectedMembers.get(c.member_id)!;
      await openHumanTask(pool, {
        kind: DD_REJECTED_TASK_KIND,
        title: `Direct Debit collection of ${money(c.amount_pence)} rejected by the bank`,
        detail: `The bank refused this collection before it was attempted: ${rejection.reason} (${rejection.reasonCode}). It will not be resubmitted. Check the mandate with the member.`,
        consequenceIfIgnored: 'The entries this collection was for stay unpaid.',
        gapId: 'GAP-10',
        entityType: 'member',
        entityId: c.member_id,
        dedupeKey: `${DD_REJECTED_TASK_KIND}:${c.id}`,
      });
    }
  }
  return { batches: batches.size, submitted, rejected };
}

// ── 3. Results ──────────────────────────────────────────────────────────────

export interface ProcessCollectionResultsResult {
  readonly collected: number;
  readonly retrying: number;
  readonly stopped: number;
}

export async function processCollectionResults(
  pool: Pool,
  bureau: BacsBureau,
  notifier: Notifier,
  request: DirectDebitStepRequest,
): Promise<ProcessCollectionResultsResult> {
  const today = request.asOf ?? ukToday();
  const { rows: submissions } = await pool.query<{ submission_id: string }>(
    `SELECT DISTINCT submission_id FROM dd_collection
      WHERE status = 'submitted' AND submission_id IS NOT NULL AND (results_expected_at IS NULL OR results_expected_at <= now())`,
  );

  let collected = 0;
  let retrying = 0;
  let stopped = 0;
  for (const { submission_id: submissionId } of submissions) {
    const results = await bureau.fetchCollectionResults(submissionId);
    if (!results.ready) continue;

    for (const result of results.results) {
      const { rows } = await pool.query<{
        id: string;
        cycle_id: string;
        payment_method_id: string;
        member_id: string;
        mandate_ref: string;
        attempt: number;
        amount_pence: string;
        draws_covered: number;
        collection_date: string;
        line_prize_draw_no: number | null;
        line_slot: number | null;
      }>(
        `SELECT c.id, c.cycle_id, c.payment_method_id, c.member_id, c.mandate_ref, c.attempt, c.amount_pence::text, c.draws_covered,
                to_char(c.collection_date, 'YYYY-MM-DD') AS collection_date, pm.line_prize_draw_no, pm.line_slot
           FROM dd_collection c JOIN payment_method pm ON pm.id = c.payment_method_id
          WHERE c.submission_id = $1 AND c.mandate_ref = $2 AND c.status = 'submitted'`,
        [submissionId, result.mandateRef],
      );
      const c = rows[0];
      if (!c) continue;

      if (result.status === 'collected') {
        await withTransaction(pool, async (client) => {
          const { rows: paid } = await client.query<{ id: string }>(
            `INSERT INTO payment (member_id, channel, received_date, amount_pence, status, idempotency_key, source_reference, line_prize_draw_no, line_slot)
             VALUES ($1, 'direct_debit', $2, $3, 'allocated', $4, $5, $6, $7)
             ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
             RETURNING id`,
            [c.member_id, c.collection_date, c.amount_pence, `dd-collection:${c.id}`, c.mandate_ref, c.line_prize_draw_no, c.line_slot],
          );
          await client.query(`UPDATE dd_collection SET status = 'collected', payment_id = $2, updated_at = now() WHERE id = $1`, [c.id, paid[0]!.id]);
          await writeAudit(client, {
            actorLabel: 'system',
            action: 'direct_debit.collected',
            entity: 'dd_collection',
            entityId: c.id,
            after: { paymentId: paid[0]!.id, amountPence: c.amount_pence, attempt: c.attempt },
          });
        });
        collected++;
        continue;
      }

      await pool.query(
        `UPDATE dd_collection SET status = 'failed', failure_code = $2, failure_reason = $3, updated_at = now() WHERE id = $1`,
        [c.id, result.reasonCode, result.reason],
      );

      if (c.attempt === 1) {
        // GAP-11: tried once more, a week on, for the same draws.
        const retryDate = onOrNextWorkingDay(addDays(today, RETRY_AFTER_DAYS));
        const submitOn = workingDaysBefore(retryDate, SUBMIT_WORKING_DAYS_BEFORE);
        const retryId = await withTransaction(pool, async (client) => {
          const { rows: retry } = await client.query<{ id: string }>(
            `INSERT INTO dd_collection
               (cycle_id, payment_method_id, member_id, mandate_ref, attempt, amount_pence, draws_covered, submit_on, collection_date, notified_at)
             VALUES ($1, $2, $3, $4, 2, $5, $6, $7, $8, now())
             ON CONFLICT (cycle_id, payment_method_id, attempt) DO NOTHING
             RETURNING id`,
            [c.cycle_id, c.payment_method_id, c.member_id, c.mandate_ref, c.amount_pence, c.draws_covered, submitOn < today ? today : submitOn, retryDate],
          );
          const id = retry[0]?.id;
          if (id) {
            await client.query(
              `INSERT INTO dd_collection_entry (collection_id, entry_id) SELECT $1, entry_id FROM dd_collection_entry WHERE collection_id = $2`,
              [id, c.id],
            );
            await writeAudit(client, {
              actorLabel: 'system',
              action: 'direct_debit.collection_failed',
              entity: 'dd_collection',
              entityId: c.id,
              after: { reasonCode: result.reasonCode, reason: result.reason, retryCollectionId: id, retryDate },
            });
          }
          return id;
        });
        if (retryId) {
          await noticeMember(pool, notifier, {
            memberId: c.member_id,
            templateId: 'dd_collection_failed',
            key: c.id,
            mergeData: { amount: money(c.amount_pence), retryDate: formatUkDate(retryDate) },
            postTitle: 'Post a failed Direct Debit notice',
            postDetail: `Their Direct Debit of ${money(c.amount_pence)} could not be collected (${result.reason}). It will be tried once more on or just after ${formatUkDate(retryDate)}; if that fails too, their Direct Debit stops.`,
          });
          retrying++;
        }
        continue;
      }

      // Second failure: the Direct Debit stops (GAP-11).
      const ended = await endDirectDebit(pool, { paymentMethodId: c.payment_method_id, reason: 'collection_failed', actorLabel: 'system' });
      const { rows: unpaid } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM dd_collection_entry ce JOIN entry e ON e.id = ce.entry_id
          WHERE ce.collection_id = $1 AND e.voided_at IS NULL`,
        [c.id],
      );
      await noticeMember(pool, notifier, {
        memberId: c.member_id,
        templateId: 'dd_stopped',
        key: c.id,
        mergeData: { amount: money(c.amount_pence) },
        postTitle: 'Post a Direct Debit stopped notice',
        postDetail: `Their Direct Debit could not be collected twice, so it has stopped and their numbers are no longer entered by Direct Debit.`,
      });
      await openHumanTask(pool, {
        kind: DD_STOPPED_TASK_KIND,
        title: `Direct Debit stopped after two failed collections of ${money(c.amount_pence)}`,
        detail:
          `The collection failed again (${result.reason}), so the Direct Debit has ended and ${ended.entriesWithdrawn} entr${ended.entriesWithdrawn === 1 ? 'y was' : 'ies were'} withdrawn from draws still taking entries. ` +
          `${unpaid[0]!.n} of the ${c.draws_covered} draws it was for had already closed to entries or been drawn, so were played unpaid.`,
        consequenceIfIgnored: 'The unpaid amount is not followed up with the member.',
        gapId: 'GAP-11',
        entityType: 'member',
        entityId: c.member_id,
        dedupeKey: `${DD_STOPPED_TASK_KIND}:${c.id}`,
      });
      stopped++;
    }
  }
  return { collected, retrying, stopped };
}
