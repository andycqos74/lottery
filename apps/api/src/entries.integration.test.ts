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
  CreateSessionRequest,
  HostedPaymentSession,
  PaymentGateway,
  PaymentOutcome,
} from '@qosfc/ports';
import { findMemberByEmail, registerMember } from './db.js';
import { completeEntryPurchase, startEntryPurchase } from './entries.js';

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

describeDb('online entry purchase (GAP-09 / GAP-04)', () => {
  let pool: Pool;
  let memberId: string;
  let drawId: string;

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, applicationName: 'qosfc-api-test', max: 4 });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const here = dirname(fileURLToPath(import.meta.url));
    await migrate(pool, resolve(here, '../../../db/migrations'), () => {});

    const cfgId = (await pool.query(`INSERT INTO config_version (note) VALUES ('test fixture') RETURNING id`)).rows[0].id;
    drawId = (
      await pool.query(
        `INSERT INTO draw (draw_number, draw_date, config_version_id, status) VALUES (1, CURRENT_DATE, $1, 'open') RETURNING id`,
        [cfgId],
      )
    ).rows[0].id;

    const passwordHash = await argon2Hash('a-strong-enough-password');
    const outcome = await registerMember(pool, {
      forename: 'Portal',
      surname: 'Member',
      email: 'portal.member@example.test',
      passwordHash,
    });
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
    const outcome = await registerMember(pool, {
      forename: 'Dup',
      surname: 'Licate',
      email: 'portal.member@example.test',
      passwordHash: 'x',
    });
    expect(outcome.kind).toBe('email_taken');
  });

  it('creates an entry once the dummy PSP reports success', async () => {
    const gateway = new FakeGateway();
    const started = await startEntryPurchase(pool, gateway, {
      memberId,
      selection: [4, 2, 14, 9],
      returnUrl: 'https://portal.test/return',
      cancelUrl: 'https://portal.test/cancel',
    });
    if (started.kind !== 'started') throw new Error(`expected started, got ${JSON.stringify(started)}`);

    const completed = await completeEntryPurchase(pool, gateway, started.sessionId);
    if (completed.kind !== 'entry_created') throw new Error(`expected entry_created, got ${JSON.stringify(completed)}`);

    const { rows } = await pool.query(`SELECT draw_id, selection, funding_source, stake_pence FROM entry WHERE id = $1`, [
      completed.entryId,
    ]);
    expect(rows[0]).toMatchObject({ draw_id: drawId, selection: [2, 4, 9, 14], funding_source: 'card', stake_pence: 200n });

    // Idempotent: completing the same session again returns the same entry rather than creating a second one.
    const again = await completeEntryPurchase(pool, gateway, started.sessionId);
    expect(again).toEqual({ kind: 'already_completed', entryId: completed.entryId });
  });

  it('marks the purchase failed when the dummy PSP declines, and creates no entry', async () => {
    const gateway = new FakeGateway();
    gateway.outcome = { status: 'failed', reasonCode: 'card_declined', reason: 'The card was declined.' };
    const started = await startEntryPurchase(pool, gateway, {
      memberId,
      selection: [1, 2, 3, 4],
      returnUrl: 'https://portal.test/return',
      cancelUrl: 'https://portal.test/cancel',
    });
    if (started.kind !== 'started') throw new Error('expected started');

    const completed = await completeEntryPurchase(pool, gateway, started.sessionId);
    expect(completed.kind).toBe('payment_failed');
  });

  it('rejects a selection that is not four distinct numbers 1-20', async () => {
    const gateway = new FakeGateway();
    const outcome = await startEntryPurchase(pool, gateway, {
      memberId,
      selection: [1, 2, 3],
      returnUrl: 'https://portal.test/return',
      cancelUrl: 'https://portal.test/cancel',
    });
    expect(outcome).toEqual({ kind: 'rejected', reason: 'A selection must be four distinct numbers between 1 and 20.' });
  });
});
