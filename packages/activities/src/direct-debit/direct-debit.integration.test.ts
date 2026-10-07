/**
 * Direct Debit, end to end against a real PostgreSQL and a scripted bureau:
 * confirmation before entry, monthly collection in advance, one retry then
 * withdrawal (GAP-11), refund claim = removal (GAP-12), and cancellation
 * keeping what has been paid for.
 *
 * Set TEST_APP_DB_URL to run. Without it the suite skips rather than silently
 * passing, so a green CI run with no database does not look like proof.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPool, migrate, type Pool } from '@qosfc/db';
import type {
  BacsBureau,
  CollectionResult,
  DeliveryOutcome,
  MandateEvent,
  NotificationRequest,
  Notifier,
  SubmissionReceipt,
} from '@qosfc/ports';
import { allocateUpcomingEntries } from '../draw/allocate-upcoming.js';
import { prepareCollections, processCollectionResults, submitDueCollections } from './collections.js';
import { cancelMandatesAtBureau, endDirectDebit } from './mandates.js';
import { processMandateEvents } from './mandate-events.js';

const url = process.env['TEST_APP_DB_URL'];
const describeDb = url ? describe : describe.skip;

/** A bureau whose collections succeed unless told to fail for a mandate, and whose messages are queued by the test. */
class ScriptedBureau implements BacsBureau {
  readonly providerName = 'test:bacs';
  readonly settlementDays = 3;
  readonly events: MandateEvent[] = [];
  readonly cancelled: string[] = [];
  readonly failing = new Set<string>();
  private readonly submissions = new Map<string, { mandateRef: string; memberRef: string; amountPence: string }[]>();

  async createMandate(): Promise<never> {
    throw new Error('not used');
  }
  async getMandate(): Promise<never> {
    throw new Error('not used');
  }
  async cancelMandate(request: { mandateRef: string }): Promise<void> {
    this.cancelled.push(request.mandateRef);
  }
  async submitCollections(request: {
    cycleKey: string;
    instructions: readonly { memberRef: string; mandateRef: string; amountPence: string }[];
  }): Promise<SubmissionReceipt> {
    const submissionId = `sub-${this.submissions.size + 1}`;
    this.submissions.set(submissionId, [...request.instructions]);
    return { submissionId, acceptedCount: request.instructions.length, rejectedCount: 0, rejections: [], resultsExpectedAt: new Date(0).toISOString() };
  }
  async fetchCollectionResults(submissionId: string): Promise<{ ready: true; results: CollectionResult[] }> {
    return {
      ready: true,
      results: (this.submissions.get(submissionId) ?? []).map((i) =>
        this.failing.has(i.mandateRef)
          ? { memberRef: i.memberRef, mandateRef: i.mandateRef, status: 'failed' as const, reasonCode: 'ARUDD-0', reason: 'Refer to payer' }
          : { memberRef: i.memberRef, mandateRef: i.mandateRef, status: 'collected' as const, amountPence: i.amountPence },
      ),
    };
  }
  async fetchMandateEvents(): Promise<readonly MandateEvent[]> {
    return this.events;
  }
}

function recordingNotifier(): Notifier & { sent: NotificationRequest[] } {
  const sent: NotificationRequest[] = [];
  return {
    providerName: 'test',
    sent,
    send: async (request): Promise<DeliveryOutcome> => {
      sent.push(request);
      return { status: 'accepted', providerRef: `ref-${sent.length}` };
    },
    fetchDeliveryEvents: async () => [],
  };
}

// Collection month March 2027: collected Mon 1 March, prepared 15–19 Feb, submitted Thu 25 Feb.
const MARCH_DRAWS = ['2027-03-05', '2027-03-12', '2027-03-19'];
const APRIL_DRAW = '2027-04-02';

describeDb('Direct Debit collections and mandates', () => {
  let pool: Pool;
  let cfgId: string;
  let drawNumber = 1;
  let prizeDrawNo = 9000;
  let eventNo = 0;
  const bureau = new ScriptedBureau();
  const notifier = recordingNotifier();

  async function draw(day: string): Promise<string> {
    return (
      await pool.query(
        `INSERT INTO draw (draw_number, draw_date, draw_at, entries_close_at, config_version_id, status)
         VALUES ($1, $2::date, ($2::date + time '12:00') AT TIME ZONE 'Europe/London', ($2::date) AT TIME ZONE 'Europe/London', $3, 'open')
         RETURNING id`,
        [drawNumber++, day, cfgId],
      )
    ).rows[0].id;
  }

  /** A player with one line and a Direct Debit on it, in the given state. */
  async function ddMember(status: 'pending' | 'active'): Promise<{ memberId: string; pmId: string; mandateRef: string; no: number }> {
    const memberId = (await pool.query(`INSERT INTO member (forename, surname, email) VALUES ('Dee', 'Debit', $1) RETURNING id`, [`dd${prizeDrawNo}@example.com`]))
      .rows[0].id;
    const no = prizeDrawNo++;
    await pool.query(`INSERT INTO member_number (prize_draw_no, member_id, row_type) VALUES ($1, $2, 'member')`, [no, memberId]);
    await pool.query(`INSERT INTO selection_standing (prize_draw_no, slot, selection, source) VALUES ($1, 1, '{2,4,6,8}', 'member_chosen')`, [no]);
    const mandateRef = `MD-${no}`;
    const pmId = (
      await pool.query(
        `INSERT INTO payment_method (member_id, type, mandate_ref, mandate_status, mandate_active_at, active, line_prize_draw_no, line_slot)
         VALUES ($1, 'direct_debit', $2, $3, CASE WHEN $3 = 'active' THEN now() END, true, $4, 1) RETURNING id`,
        [memberId, mandateRef, status, no],
      )
    ).rows[0].id;
    await allocateUpcomingEntries(pool, { memberId, actorLabel: 'test' });
    return { memberId, pmId, mandateRef, no };
  }

  async function liveEntries(memberId: string): Promise<{ draw_date: string; funding: string }[]> {
    return (
      await pool.query(
        `SELECT to_char(d.draw_date, 'YYYY-MM-DD') AS draw_date, e.funding_source::text AS funding
           FROM entry e JOIN draw d ON d.id = e.draw_id
          WHERE e.member_id = $1 AND e.voided_at IS NULL ORDER BY d.draw_date`,
        [memberId],
      )
    ).rows;
  }

  async function collections(pmId: string): Promise<{ attempt: number; status: string; amount_pence: string; draws_covered: number }[]> {
    return (
      await pool.query(
        `SELECT attempt, status, amount_pence::text, draws_covered FROM dd_collection WHERE payment_method_id = $1 ORDER BY attempt`,
        [pmId],
      )
    ).rows;
  }

  /** Prepare in the window, submit on the day, read results. */
  async function runMarch(): Promise<void> {
    await prepareCollections(pool, notifier, { asOf: '2027-02-15' });
    await submitDueCollections(pool, bureau, { asOf: '2027-02-25' });
    await processCollectionResults(pool, bureau, notifier, { asOf: '2027-02-27' });
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, applicationName: 'qosfc-direct-debit-test', max: 4 });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const here = dirname(fileURLToPath(import.meta.url));
    await migrate(pool, resolve(here, '../../../../db/migrations'), () => {});
    cfgId = (
      await pool.query(
        `INSERT INTO config_version (entry_strategy, entry_strategy_confirmed_by, note, is_active)
         VALUES ('prepaid_blocks', 'test fixture', 'direct debit fixture', true) RETURNING id`,
      )
    ).rows[0].id;
    for (const day of [...MARCH_DRAWS, APRIL_DRAW]) await draw(day);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('enters nothing until the bank confirms the mandate', async () => {
    const dd = await ddMember('pending');
    expect(await liveEntries(dd.memberId)).toEqual([]);

    bureau.events.push({
      eventId: `ev-${++eventNo}`,
      mandateRef: dd.mandateRef,
      memberRef: dd.memberId,
      kind: 'mandate_active',
      occurredAt: new Date().toISOString(),
      detail: '',
    });
    expect(await processMandateEvents(pool, bureau)).toEqual({ applied: 1 });
    expect((await liveEntries(dd.memberId)).map((e) => e.funding)).toEqual(['direct_debit', 'direct_debit', 'direct_debit', 'direct_debit']);
    // Applied once only.
    expect(await processMandateEvents(pool, bureau)).toEqual({ applied: 0 });
    await endDirectDebit(pool, { paymentMethodId: dd.pmId, reason: 'admin_cancelled', actorLabel: 'test' });
  });

  it('collects monthly in advance for that month\'s draws, after an advance notice', async () => {
    const dd = await ddMember('active');
    const before = await prepareCollections(pool, notifier, { asOf: '2027-02-10' });
    expect(before).toMatchObject({ collectionMonth: '2027-03-01', inWindow: false, scheduled: 0 });

    const prepared = await prepareCollections(pool, notifier, { asOf: '2027-02-15' });
    expect(prepared).toMatchObject({ inWindow: true, scheduled: 1, emailed: 1 });
    expect(await collections(dd.pmId)).toEqual([{ attempt: 1, status: 'scheduled', amount_pence: '600', draws_covered: 3 }]);
    expect(notifier.sent.at(-1)).toMatchObject({ templateId: 'dd_advance_notice', memberRef: dd.memberId });
    expect(notifier.sent.at(-1)!.mergeData).toMatchObject({ amount: '£6.00', date: 'Monday 1 March 2027', draws: '3' });

    expect(await submitDueCollections(pool, bureau, { asOf: '2027-02-24' })).toMatchObject({ submitted: 0 });
    expect(await submitDueCollections(pool, bureau, { asOf: '2027-02-25' })).toMatchObject({ batches: 1, submitted: 1 });
    expect(await processCollectionResults(pool, bureau, notifier, { asOf: '2027-02-27' })).toMatchObject({ collected: 1 });

    expect((await collections(dd.pmId))[0]!.status).toBe('collected');
    const { rows: paid } = await pool.query(`SELECT channel::text, amount_pence::text, status::text FROM payment WHERE member_id = $1`, [dd.memberId]);
    expect(paid).toEqual([{ channel: 'direct_debit', amount_pence: '600', status: 'allocated' }]);

    // Cancelling keeps the three paid March draws and withdraws only April's.
    await endDirectDebit(pool, { paymentMethodId: dd.pmId, memberId: dd.memberId, reason: 'member_cancelled', actorLabel: 'test' });
    expect((await liveEntries(dd.memberId)).map((e) => e.draw_date)).toEqual(MARCH_DRAWS);
    expect(await cancelMandatesAtBureau(pool, bureau)).toEqual({ cancelled: 2 });
    expect(bureau.cancelled).toContain(dd.mandateRef);
  });

  it('retries a failed collection once, then stops the Direct Debit and withdraws its unpaid entries', async () => {
    const dd = await ddMember('active');
    bureau.failing.add(dd.mandateRef);
    await runMarch();

    expect((await collections(dd.pmId)).map((c) => [c.attempt, c.status])).toEqual([
      [1, 'failed'],
      [2, 'scheduled'],
    ]);
    expect(notifier.sent.at(-1)).toMatchObject({ templateId: 'dd_collection_failed', memberRef: dd.memberId });
    expect(notifier.sent.at(-1)!.mergeData['retryDate']).toBe('Monday 8 March 2027');
    // Still entered while the retry is pending.
    expect(await liveEntries(dd.memberId)).toHaveLength(4);

    await submitDueCollections(pool, bureau, { asOf: '2027-03-04' });
    expect(await processCollectionResults(pool, bureau, notifier, { asOf: '2027-03-08' })).toMatchObject({ stopped: 1 });

    expect((await collections(dd.pmId)).map((c) => c.status)).toEqual(['failed', 'failed']);
    expect(await liveEntries(dd.memberId)).toEqual([]);
    const { rows: pm } = await pool.query(`SELECT active, end_reason, bureau_cancel_pending FROM payment_method WHERE id = $1`, [dd.pmId]);
    expect(pm[0]).toEqual({ active: false, end_reason: 'collection_failed', bureau_cancel_pending: true });
    expect(notifier.sent.at(-1)).toMatchObject({ templateId: 'dd_stopped' });
    const { rows: tasks } = await pool.query(`SELECT 1 FROM human_task WHERE kind = 'dd_collection_stopped' AND entity_id = $1`, [dd.memberId]);
    expect(tasks).toHaveLength(1);
  });

  it('treats a refund claim as removal: the collection is refunded and the entries it paid for withdrawn', async () => {
    const dd = await ddMember('active');
    await runMarch();
    expect((await collections(dd.pmId)).map((c) => c.status)).toEqual(['collected']);

    bureau.events.push({
      eventId: `ev-${++eventNo}`,
      mandateRef: dd.mandateRef,
      memberRef: dd.memberId,
      kind: 'indemnity_claim',
      occurredAt: new Date().toISOString(),
      detail: 'refund',
      amountPence: '600',
    });
    await processMandateEvents(pool, bureau);

    expect((await collections(dd.pmId)).map((c) => c.status)).toEqual(['refunded']);
    expect(await liveEntries(dd.memberId)).toEqual([]);
    const { rows: paid } = await pool.query(`SELECT status::text FROM payment WHERE member_id = $1`, [dd.memberId]);
    expect(paid).toEqual([{ status: 'reversed' }]);
    const { rows: pm } = await pool.query(`SELECT active, end_reason FROM payment_method WHERE id = $1`, [dd.pmId]);
    expect(pm[0]).toEqual({ active: false, end_reason: 'refund_claim' });
    const { rows: tasks } = await pool.query(`SELECT title FROM human_task WHERE kind = 'dd_refund_claim' AND entity_id = $1`, [dd.memberId]);
    expect(tasks).toEqual([{ title: 'Direct Debit refund claim of £6.00' }]);
  });

  it('keeps entries already in a collection when paid weeks arrive on the same numbers', async () => {
    const dd = await ddMember('active');
    await prepareCollections(pool, notifier, { asOf: '2027-02-15' });
    await pool.query(
      `INSERT INTO payment (member_id, channel, received_date, amount_pence, status, idempotency_key, line_prize_draw_no, line_slot)
       VALUES ($1, 'card', CURRENT_DATE, 400, 'allocated', gen_random_uuid()::text, $2, 1)`,
      [dd.memberId, dd.no],
    );
    await allocateUpcomingEntries(pool, { memberId: dd.memberId, actorLabel: 'test' });
    // The three March draws are being collected for, so stay Direct Debit; the card weeks go to April and beyond.
    expect((await liveEntries(dd.memberId)).map((e) => e.funding)).toEqual(['direct_debit', 'direct_debit', 'direct_debit', 'prepaid']);
  });
});
