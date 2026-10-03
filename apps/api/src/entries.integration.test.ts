/**
 * The online purchase flow (GAP-09 dummy transaction simulator, GAP-04
 * portal registration), verified against a real PostgreSQL instance — the
 * same pattern as packages/db/src/security.integration.test.ts.
 *
 * Set TEST_APP_DB_URL to run. Without it the suite skips rather than silently
 * passing, so a green CI run with no database does not look like proof.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { hash as argon2Hash } from '@node-rs/argon2';
import { createPool, migrate, type Pool } from '@qosfc/db';
import type {
  BacsBureau,
  CreateSessionRequest,
  Mandate,
  HostedPaymentSession,
  PaymentGateway,
  PaymentOutcome,
} from '@qosfc/ports';
import { findMemberByEmail, registerMember } from './db.js';
import { completeEntryPurchase, startEntryPurchase } from './entries.js';
import { cancelDirectDebit, completeDirectDebitSetup, listActiveDirectDebits, startDirectDebitSetup } from './direct-debit.js';

const url = process.env['TEST_APP_DB_URL'];
const describeDb = url ? describe : describe.skip;

class FakeGateway implements PaymentGateway {
  readonly providerName = 'fake:test';
  outcome: PaymentOutcome = { status: 'succeeded', providerRef: 'ref1', amountPence: '200' };
  lastSessionId = '';

  async createHostedSession(request: CreateSessionRequest): Promise<HostedPaymentSession> {
    this.lastSessionId = `sess_${request.idempotencyKey}`;
    return { sessionId: this.lastSessionId, redirectUrl: `${request.returnUrl}?session=${this.lastSessionId}`, expiresAt: new Date().toISOString() };
  }
  async getPaymentStatus(): Promise<PaymentOutcome> {
    return this.outcome;
  }
  verifyWebhookSignature(): boolean {
    return true;
  }
  parseWebhook(): { sessionId: string; outcome: PaymentOutcome } {
    return { sessionId: this.lastSessionId, outcome: this.outcome };
  }
  async refund(): Promise<{ refundRef: string }> {
    return { refundRef: 'r1' };
  }
}

class FakeBureau {
  readonly providerName = 'fake:bacs';
  readonly settlementDays = 3;
  private n = 0;
  async createMandate(request: { returnUrl: string }): Promise<Mandate> {
    const mandateRef = `MANDATE${++this.n}${Date.now()}`;
    return { mandateRef, status: 'pending', setupRedirectUrl: `${request.returnUrl}?mandate=${mandateRef}` };
  }
  async getMandate(mandateRef: string): Promise<Mandate> {
    return { mandateRef, status: 'active' };
  }
}

describeDb('online entry purchase and Direct Debit — lines, card first (GAP-09 / GAP-04 / client rules 2026-10-01)', () => {
  let pool: Pool;
  let memberId: string;
  /** Six weekly draws on sale, soonest first. */
  const draws: string[] = [];
  const bureau = new FakeBureau() as unknown as BacsBureau;

  async function newMember(email: string): Promise<string> {
    const outcome = await registerMember(pool, { forename: 'Portal', surname: 'Member', email, passwordHash: 'x' });
    if (outcome.kind !== 'registered') throw new Error('fixture setup failed');
    return outcome.memberId;
  }

  async function buy(member: string, selection: number[], blocks: number) {
    return buyLines(member, [selection], blocks);
  }

  /** One card payment for several lines (GitHub #19). */
  async function buyLines(member: string, selections: number[][], blocks: number) {
    const gateway = new FakeGateway();
    gateway.outcome = { status: 'succeeded', providerRef: 'ref', amountPence: String(200 * blocks * selections.length) };
    const started = await startEntryPurchase(pool, gateway, {
      memberId: member,
      selections,
      blocks,
      returnUrl: 'https://portal.test/return',
      cancelUrl: 'https://portal.test/cancel',
    });
    if (started.kind !== 'started') throw new Error(`expected started, got ${JSON.stringify(started)}`);
    const completed = await completeEntryPurchase(pool, gateway, started.sessionId);
    if (completed.kind !== 'purchased') throw new Error(`expected purchased, got ${JSON.stringify(completed)}`);
    return { ...completed, sessionId: started.sessionId, gateway };
  }

  async function setUpDirectDebit(member: string, selection: number[]) {
    const started = await startDirectDebitSetup(pool, bureau, { memberId: member, selection, returnUrl: 'https://portal.test/dd' });
    if (started.kind !== 'started') throw new Error('expected started');
    const completed = await completeDirectDebitSetup(pool, bureau, started.mandateRef);
    if (completed.kind !== 'active') throw new Error(`expected active, got ${JSON.stringify(completed)}`);
    return completed;
  }

  /** Per draw (in order): the member's live entries as "numbers:funding". */
  async function entriesByDraw(member: string): Promise<string[][]> {
    const result: string[][] = [];
    for (const drawId of draws) {
      const { rows } = await pool.query<{ selection: number[]; funding_source: string }>(
        `SELECT selection, funding_source::text FROM entry WHERE draw_id = $1 AND member_id = $2 AND voided_at IS NULL ORDER BY selection`,
        [drawId, member],
      );
      result.push(rows.map((r) => `${r.selection.join('-')}:${r.funding_source}`));
    }
    return result;
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, applicationName: 'qosfc-api-test', max: 4 });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const here = dirname(fileURLToPath(import.meta.url));
    await migrate(pool, resolve(here, '../../../db/migrations'), () => {});

    const cfgId = (
      await pool.query(
        `INSERT INTO config_version (entry_strategy, entry_strategy_confirmed_by, note, is_active)
         VALUES ('prepaid_blocks', 'test fixture', 'portal fixture', true) RETURNING id`,
      )
    ).rows[0].id;
    for (let week = 0; week < 6; week++) {
      draws.push(
        (
          await pool.query(
            `INSERT INTO draw (draw_number, draw_date, draw_at, entries_close_at, config_version_id, status)
             VALUES ($1, CURRENT_DATE + $2 * 7, now() + make_interval(days => $2 * 7, hours => 2),
                     now() + make_interval(days => $2 * 7, hours => 1), $3, 'open')
             RETURNING id`,
            [101 + week, week, cfgId],
          )
        ).rows[0].id,
      );
    }

    const passwordHash = await argon2Hash('a-strong-enough-password');
    const outcome = await registerMember(pool, { forename: 'Portal', surname: 'Member', email: 'portal.member@example.test', passwordHash });
    if (outcome.kind !== 'registered') throw new Error('fixture setup failed');
    memberId = outcome.memberId;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('registers a member with a login, without touching the legacy prize_draw_no model', async () => {
    const member = await findMemberByEmail(pool, 'portal.member@example.test');
    expect(member?.id).toBe(memberId);
    const { rows } = await pool.query(`SELECT prize_draw_no FROM member_number WHERE member_id = $1`, [memberId]);
    expect(rows).toHaveLength(0);
  });

  it('refuses to register the same email twice', async () => {
    const outcome = await registerMember(pool, { forename: 'Dup', surname: 'Licate', email: 'portal.member@example.test', passwordHash: 'x' });
    expect(outcome.kind).toBe('email_taken');
  });

  it('a 1-draw purchase enters the next draw, says so, and is idempotent', async () => {
    const bought = await buy(memberId, [4, 2, 14, 9], 1);
    expect(await entriesByDraw(memberId)).toEqual([['2-4-9-14:prepaid'], [], [], [], [], []]);
    expect(bought.message).toContain('Draw 101');

    // Completing the same session again: same message, nothing bought twice.
    const again = await completeEntryPurchase(pool, bought.gateway, bought.sessionId);
    expect(again).toEqual({ kind: 'already_completed', message: bought.message });
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM payment WHERE member_id = $1`, [memberId]);
    expect(rows[0].n).toBe(1);
  });

  it('marks the purchase failed when the dummy PSP declines, and creates no entry', async () => {
    const gateway = new FakeGateway();
    gateway.outcome = { status: 'failed', reasonCode: 'card_declined', reason: 'The card was declined.' };
    const started = await startEntryPurchase(pool, gateway, {
      memberId,
      selections: [[1, 2, 3, 4]],
      blocks: 1,
      returnUrl: 'https://portal.test/return',
      cancelUrl: 'https://portal.test/cancel',
    });
    if (started.kind !== 'started') throw new Error('expected started');
    expect((await completeEntryPurchase(pool, gateway, started.sessionId)).kind).toBe('payment_failed');
  });

  it('rejects a selection that is not four distinct numbers 1-20', async () => {
    const outcome = await startEntryPurchase(pool, new FakeGateway(), {
      memberId,
      selections: [[1, 2, 3]],
      blocks: 1,
      returnUrl: 'https://portal.test/return',
      cancelUrl: 'https://portal.test/cancel',
    });
    expect(outcome).toEqual({ kind: 'rejected', reason: 'A selection must be four distinct numbers between 1 and 20.' });
  });

  it('rejects a block size other than 1, 4, or 12', async () => {
    const outcome = await startEntryPurchase(pool, new FakeGateway(), {
      memberId,
      selections: [[1, 2, 3, 4]],
      blocks: 2,
      returnUrl: 'https://portal.test/return',
      cancelUrl: 'https://portal.test/cancel',
    });
    expect(outcome).toEqual({ kind: 'rejected', reason: 'Choose 1, 4, or 12 draws.' });
  });

  it('same numbers again: the purchase adds weeks to them — never a second entry in a draw', async () => {
    const m = await newMember('same.numbers@example.test');
    await buy(m, [1, 6, 11, 16], 4);
    const second = await buy(m, [16, 11, 6, 1], 1);
    expect(await entriesByDraw(m)).toEqual([
      ['1-6-11-16:prepaid'],
      ['1-6-11-16:prepaid'],
      ['1-6-11-16:prepaid'],
      ['1-6-11-16:prepaid'],
      ['1-6-11-16:prepaid'],
      [],
    ]);
    expect(second.message).toContain('You already had the numbers 1, 6, 11, 16');
    // One prize draw number, one line.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM selection_standing ss JOIN member_number mn USING (prize_draw_no) WHERE mn.member_id = $1`,
      [m],
    );
    expect(rows[0].n).toBe(1);
  });

  it('different numbers: an extra entry in the selected draws, alongside the existing ones', async () => {
    const m = await newMember('new.numbers@example.test');
    await buy(m, [1, 2, 3, 4], 4);
    const second = await buy(m, [5, 6, 7, 8], 4);
    expect(await entriesByDraw(m)).toEqual([
      ['1-2-3-4:prepaid', '5-6-7-8:prepaid'],
      ['1-2-3-4:prepaid', '5-6-7-8:prepaid'],
      ['1-2-3-4:prepaid', '5-6-7-8:prepaid'],
      ['1-2-3-4:prepaid', '5-6-7-8:prepaid'],
      [],
      [],
    ]);
    expect(second.message).toContain('These are new numbers');
    expect(second.message).toContain('1, 2, 3, 4');
  });

  it('several lines in one payment (#19): each line is entered in every draw paid for, and each line has its own payment', async () => {
    const m = await newMember('two.lines@example.test');
    const bought = await buyLines(m, [[4, 3, 2, 1], [5, 6, 7, 8]], 4);
    expect(String(bought.amountPence)).toBe('1600');
    expect(bought.selections).toEqual([[1, 2, 3, 4], [5, 6, 7, 8]]);
    expect(await entriesByDraw(m)).toEqual([
      ['1-2-3-4:prepaid', '5-6-7-8:prepaid'],
      ['1-2-3-4:prepaid', '5-6-7-8:prepaid'],
      ['1-2-3-4:prepaid', '5-6-7-8:prepaid'],
      ['1-2-3-4:prepaid', '5-6-7-8:prepaid'],
      [],
      [],
    ]);
    const { rows } = await pool.query(
      `SELECT p.amount_pence::int AS pence, ss.selection FROM payment p
         JOIN selection_standing ss ON ss.prize_draw_no = p.line_prize_draw_no AND ss.slot = p.line_slot
        WHERE p.member_id = $1 ORDER BY p.line_slot`,
      [m],
    );
    expect(rows).toEqual([
      { pence: 800, selection: [1, 2, 3, 4] },
      { pence: 800, selection: [5, 6, 7, 8] },
    ]);
    expect(bought.message).toContain('your £16.00 payment covers 2 lines of numbers, 4 draws each');
    expect(bought.message).toContain('New numbers 5, 6, 7, 8.');

    // Completing it again changes nothing.
    expect((await completeEntryPurchase(pool, bought.gateway, bought.sessionId)).kind).toBe('already_completed');
    expect((await pool.query(`SELECT count(*)::int AS n FROM payment WHERE member_id = $1`, [m])).rows[0].n).toBe(2);
  });

  it('refuses the same numbers twice in one payment (#19), in any order, before taking payment', async () => {
    const m = await newMember('dup.lines@example.test');
    const gateway = new FakeGateway();
    const outcome = await startEntryPurchase(pool, gateway, {
      memberId: m,
      selections: [[1, 2, 3, 4], [9, 10, 11, 12], [4, 3, 2, 1]],
      blocks: 1,
      returnUrl: 'https://portal.test/return',
      cancelUrl: 'https://portal.test/cancel',
    });
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.reason).toContain("You've picked 1, 2, 3, 4 more than once");
    expect(gateway.lastSessionId).toBe('');
    expect((await pool.query(`SELECT count(*)::int AS n FROM pending_entry_purchase WHERE member_id = $1`, [m])).rows[0].n).toBe(0);
  });

  it('a line the member already has adds weeks to it, while new numbers in the same payment start a new line (#19)', async () => {
    const m = await newMember('mixed.lines@example.test');
    await buy(m, [1, 2, 3, 4], 1);
    const bought = await buyLines(m, [[9, 10, 11, 12], [4, 3, 2, 1]], 1);
    expect(await entriesByDraw(m)).toEqual([['1-2-3-4:prepaid', '9-10-11-12:prepaid'], ['1-2-3-4:prepaid'], [], [], [], []]);
    expect(bought.message).toContain('New numbers 9, 10, 11, 12.');
    expect(bought.message).toContain('You already had the numbers 1, 2, 3, 4, so this draw has been added to them.');
    // Still never two entries with the same numbers in one draw.
    const { rows } = await pool.query(
      `SELECT draw_id, selection, count(*)::int AS n FROM entry WHERE member_id = $1 AND voided_at IS NULL GROUP BY 1, 2 HAVING count(*) > 1`,
      [m],
    );
    expect(rows).toEqual([]);
  });

  it('Direct Debit set up after a card payment: the paid draws are used first, then the Direct Debit starts', async () => {
    const m = await newMember('card.then.dd@example.test');
    await buy(m, [3, 7, 12, 18], 4);
    const dd = await setUpDirectDebit(m, [3, 7, 12, 18]);
    expect(await entriesByDraw(m)).toEqual([
      ['3-7-12-18:prepaid'],
      ['3-7-12-18:prepaid'],
      ['3-7-12-18:prepaid'],
      ['3-7-12-18:prepaid'],
      ['3-7-12-18:direct_debit'],
      ['3-7-12-18:direct_debit'],
    ]);
    expect(dd.message).toContain('so those are used first');
    expect(dd.message).toContain('Direct Debit starts from Draw 105');
  });

  it('card payment while a Direct Debit is in place: the Direct Debit pauses for the paid draws and resumes after', async () => {
    const m = await newMember('dd.then.card@example.test');
    await setUpDirectDebit(m, [2, 9, 13, 20]);
    expect((await entriesByDraw(m)).flat()).toEqual(Array(6).fill('2-9-13-20:direct_debit'));

    const bought = await buy(m, [2, 9, 13, 20], 4);
    expect(await entriesByDraw(m)).toEqual([
      ['2-9-13-20:prepaid'],
      ['2-9-13-20:prepaid'],
      ['2-9-13-20:prepaid'],
      ['2-9-13-20:prepaid'],
      ['2-9-13-20:direct_debit'],
      ['2-9-13-20:direct_debit'],
    ]);
    expect(bought.message).toContain('Your Direct Debit for these numbers is paused while your paid draws are used, and starts again from Draw 105');
  });

  it('a Direct Debit with different numbers adds an extra entry in every draw; cancelling it leaves the other numbers alone', async () => {
    const m = await newMember('dd.new.numbers@example.test');
    await buy(m, [1, 3, 5, 7], 4);
    const dd = await setUpDirectDebit(m, [2, 4, 6, 8]);
    expect(dd.message).toContain('These are new numbers, so your Direct Debit adds an extra entry in every draw');
    expect((await entriesByDraw(m)).map((d) => d.join(' '))).toEqual([
      '1-3-5-7:prepaid 2-4-6-8:direct_debit',
      '1-3-5-7:prepaid 2-4-6-8:direct_debit',
      '1-3-5-7:prepaid 2-4-6-8:direct_debit',
      '1-3-5-7:prepaid 2-4-6-8:direct_debit',
      '2-4-6-8:direct_debit',
      '2-4-6-8:direct_debit',
    ]);

    const [mandate] = await listActiveDirectDebits(pool, m);
    expect(mandate?.selection).toEqual([2, 4, 6, 8]);
    expect(await cancelDirectDebit(pool, m, mandate!.id)).toEqual({ cancelled: 1 });
    expect((await entriesByDraw(m)).map((d) => d.join(' '))).toEqual([
      '1-3-5-7:prepaid',
      '1-3-5-7:prepaid',
      '1-3-5-7:prepaid',
      '1-3-5-7:prepaid',
      '',
      '',
    ]);
  });

  it('cancelling a Direct Debit behind paid draws keeps the paid draws', async () => {
    const m = await newMember('cancel.keeps.paid@example.test');
    await setUpDirectDebit(m, [10, 11, 12, 13]);
    await buy(m, [10, 11, 12, 13], 1);
    const [mandate] = await listActiveDirectDebits(pool, m);
    await cancelDirectDebit(pool, m, mandate!.id);
    expect(await entriesByDraw(m)).toEqual([['10-11-12-13:prepaid'], [], [], [], [], []]);
  });
});
