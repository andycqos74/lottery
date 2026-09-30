/**
 * The Elavon reference ↔ EPG order/session mapping (db/migrations/0016),
 * against a real PostgreSQL.
 *
 * Set TEST_APP_DB_URL to run. Without it the suite skips rather than silently
 * passing, so a green CI run with no database does not look like proof.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPool, migrate, type Pool } from '@qosfc/db';
import { PgElavonSessionStore } from './elavon-gateway.js';

const url = process.env['TEST_APP_DB_URL'];
const describeDb = url ? describe : describe.skip;

describeDb('PgElavonSessionStore (GitHub #12)', () => {
  let pool: Pool;
  let store: PgElavonSessionStore;

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, applicationName: 'qosfc-elavon-test', max: 2 });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const here = dirname(fileURLToPath(import.meta.url));
    await migrate(pool, resolve(here, '../../../../../db/migrations'), () => {});
    store = new PgElavonSessionStore(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  const record = {
    reference: 'QLREF1',
    idempotencyKey: 'entry-purchase:m1:d1',
    epgOrderId: 'ord1',
    epgSessionId: 'ses1',
    redirectUrl: 'https://hpp.test/ses1',
    amountPence: '800',
    currency: 'GBP',
    expiresAt: '2026-10-01T12:00:00.000Z',
  };

  it('saves and finds a session by reference, idempotency key and EPG session', async () => {
    await store.save(record);
    expect(await store.findByReference('QLREF1')).toEqual(record);
    expect(await store.findByIdempotencyKey('entry-purchase:m1:d1')).toEqual(record);
    expect(await store.findBySessionId('ses1')).toEqual(record);
    expect(await store.findByReference('nope')).toBeUndefined();
  });

  it('replaces the EPG side of a restarted session under the same reference', async () => {
    await store.save({ ...record, epgOrderId: 'ord2', epgSessionId: 'ses2', redirectUrl: 'https://hpp.test/ses2', expiresAt: null });
    expect(await store.findByReference('QLREF1')).toMatchObject({ epgSessionId: 'ses2', amountPence: '800', expiresAt: null });
    expect(await store.findBySessionId('ses1')).toBeUndefined();
  });

  it('records a refund once per idempotency key', async () => {
    await store.saveRefund({ idempotencyKey: 'r1', saleRef: 'tx1', refundRef: 'rf1', method: 'void', amountPence: '800' });
    await store.saveRefund({ idempotencyKey: 'r1', saleRef: 'tx1', refundRef: 'rf-other', method: 'void', amountPence: '800' });
    expect(await store.findRefund('r1')).toEqual({ refundRef: 'rf1' });
  });
});
