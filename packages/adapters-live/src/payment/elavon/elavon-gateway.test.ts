import { describe, expect, it } from 'vitest';
import { idempotencyKey } from '@qosfc/ports';
import { createEpgClient, decimalToPence, EpgError, penceToDecimal, signEpgNotification, verifyEpgNotification, type FetchLike } from './epg.js';
import { ElavonPaymentGateway, type ElavonSessionRecord, type ElavonSessionStore } from './elavon-gateway.js';

describe('EPG money conversion', () => {
  it('converts integer pence to and from EPG decimal pounds', () => {
    expect(penceToDecimal('200')).toBe('2.00');
    expect(penceToDecimal('5')).toBe('0.05');
    expect(penceToDecimal('2400')).toBe('24.00');
    expect(decimalToPence('24.00')).toBe('2400');
    expect(decimalToPence('0.5')).toBe('50');
    expect(decimalToPence('8')).toBe('800');
  });

  it('refuses sub-penny amounts and floats', () => {
    expect(() => decimalToPence('1.005')).toThrow(/precision/);
    expect(() => penceToDecimal('2.5')).toThrow();
  });
});

describe('EPG webhook verification', () => {
  // Test vector from the EPG webhook documentation (as used by the client's Wix integration).
  const SECRET = 'h/vw9kedkaXDZ2p/JCwi/VsHO4J3pBfJCQZkEPmfq0/PEYPKip/5uqsvY4LbdZxKdxE/Kp68LA5sMRhHJwRPvA==';
  const NOTIFICATION = {
    href: 'http://localhost:8443/notifications/42gvd623v6gjwj9pprmxm93vvkvb',
    id: '42gvd623v6gjwj9pprmxm93vvkvb',
    merchant: 'http://localhost:8443/merchants/kff2tbyqbmqycycqbt48ythm89yx',
    createdAt: '2023-11-03T20:48:30.476Z',
    eventType: 'saleAuthorized',
    resourceType: 'transaction',
    resource: 'http://localhost:8443/transactions/7qkxtkjpb23fpmfckjfpw2fxqphr',
  };
  const EXPECTED = 'BYPhl69vk6S5A4lEc/asiPWZMz+gUiIsx7DopUWU79uXqqHhCBJ17u+I32iVdlmugEZxxv7kQbNXOVNkmYFHhQ==';

  it('matches the documented signature', () => {
    expect(signEpgNotification(JSON.stringify(NOTIFICATION), SECRET)).toBe(EXPECTED);
  });

  it('enforces the signature and basic auth when configured', () => {
    const pretty = JSON.stringify(NOTIFICATION, null, 2);
    const cfg = { signerId: 'SIGNER1', sharedSecret: SECRET };
    expect(verifyEpgNotification({ 'Signature-SIGNER1': EXPECTED }, pretty, cfg)).toBeNull();
    expect(verifyEpgNotification({}, pretty, cfg)).toBe('missing signature');
    const tampered = JSON.stringify({ ...NOTIFICATION, resource: 'http://x/transactions/other' });
    expect(verifyEpgNotification({ 'signature-SIGNER1': EXPECTED }, tampered, cfg)).toBe('bad signature');

    const auth = { username: 'myElavonWebhookService', password: 'e3MnN!?pf4' };
    expect(verifyEpgNotification({ Authorization: 'Basic bXlFbGF2b25XZWJob29rU2VydmljZTplM01uTiE/cGY0' }, pretty, auth)).toBeNull();
    expect(verifyEpgNotification({ Authorization: 'Basic d3Jvbmc6d3Jvbmc=' }, pretty, auth)).toBe('bad authorization');
  });
});

describe('EPG client', () => {
  it('authenticates with the merchant alias and secret key, and drops empty fields', async () => {
    const calls: { url: string; headers: Record<string, string>; body?: string }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers, ...(init.body ? { body: init.body } : {}) });
      return { ok: true, status: 201, text: async () => '{"id":"ord1","href":"https://api/orders/ord1"}' };
    };
    const client = createEpgClient({ apiBaseUrl: 'https://api.test', merchantAlias: 'alias', secretKey: 'sk_x' }, fetchImpl);
    await client.createOrder({ total: { amount: '2.00', currencyCode: 'GBP' }, description: '', shopperEmailAddress: undefined });

    expect(calls[0]!.url).toBe('https://api.test/orders');
    expect(calls[0]!.headers['Authorization']).toBe(`Basic ${Buffer.from('alias:sk_x').toString('base64')}`);
    expect(calls[0]!.headers['Accept-Version']).toBe('1');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ total: { amount: '2.00', currencyCode: 'GBP' } });
  });

  it('turns an EPG error body into an EpgError with its failures', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 400,
      text: async () => '{"failures":[{"code":"badRequest"},{"code":"invalidAmount","field":"total.amount","description":"too small"}]}',
    });
    const client = createEpgClient({ apiBaseUrl: 'https://api.test', merchantAlias: 'a', secretKey: 'b' }, fetchImpl);
    const error = await client.createOrder({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EpgError);
    expect((error as EpgError).message).toBe('total.amount: too small');
    expect((error as EpgError).hasFailure('invalidAmount')).toBe(true);
  });

  it('never follows an href to another host', async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => '{}' };
    };
    const client = createEpgClient({ apiBaseUrl: 'https://api.test', merchantAlias: 'a', secretKey: 'b' }, fetchImpl);
    await client.getTransaction('https://evil.example/transactions/abc123');
    expect(urls).toEqual(['https://api.test/transactions/abc123']);
  });
});

// ── The gateway, against a fake EPG ───────────────────────────────────────────

class MemoryStore implements ElavonSessionStore {
  readonly sessions = new Map<string, ElavonSessionRecord>();
  readonly refunds = new Map<string, { refundRef: string; method: string }>();
  async findByReference(reference: string) {
    return this.sessions.get(reference);
  }
  async findByIdempotencyKey(key: string) {
    return [...this.sessions.values()].find((s) => s.idempotencyKey === key);
  }
  async findBySessionId(id: string) {
    return [...this.sessions.values()].find((s) => s.epgSessionId === id);
  }
  async save(record: ElavonSessionRecord) {
    this.sessions.set(record.reference, record);
  }
  async findRefund(key: string) {
    return this.refunds.get(key);
  }
  async saveRefund(r: { idempotencyKey: string; refundRef: string; method: 'void' | 'refund' }) {
    this.refunds.set(r.idempotencyKey, { refundRef: r.refundRef, method: r.method });
  }
}

function fakeEpg() {
  let n = 0;
  const state = {
    requests: [] as { op: string; body?: unknown }[],
    session: {} as { transaction?: string; expiresAt?: string },
    transaction: {} as Record<string, unknown>,
    refundResult: { id: 'rf1', isAuthorized: true, state: 'authorized' } as Record<string, unknown>,
  };
  const epg = {
    listMerchants: async () => ({}),
    createOrder: async (body: unknown) => {
      state.requests.push({ op: 'createOrder', body });
      n++;
      return { id: `ord${n}`, href: `https://api.test/orders/ord${n}` };
    },
    createPaymentSession: async (body: unknown) => {
      state.requests.push({ op: 'createPaymentSession', body });
      return { id: `ses${n}`, href: `https://api.test/payment-sessions/ses${n}`, url: `https://hpp.test/ses${n}`, expiresAt: '2026-10-01T12:00:00Z' };
    },
    getPaymentSession: async () => state.session,
    getTransaction: async () => state.transaction,
    createTransaction: async (body: unknown) => {
      state.requests.push({ op: 'createTransaction', body });
      return state.refundResult;
    },
  };
  return { epg: epg as unknown as ConstructorParameters<typeof ElavonPaymentGateway>[0]['epg'], state };
}

const START = {
  idempotencyKey: idempotencyKey('entry-purchase:m1:d1:1-2-3-4:4'),
  amountPence: '800',
  currency: 'GBP' as const,
  reference: 'entry:m1:d1',
  returnUrl: 'https://portal.test/draw/return',
  cancelUrl: 'https://portal.test/draw',
};

function gateway(now = new Date('2026-10-01T11:00:00Z')) {
  const { epg, state } = fakeEpg();
  const store = new MemoryStore();
  const gw = new ElavonPaymentGateway({ epg, store, now: () => now, newReference: () => 'QLREF1' });
  return { gw, state, store };
}

describe('ElavonPaymentGateway (GitHub #12)', () => {
  it('creates an EPG order and hosted session, returning to the portal with our reference', async () => {
    const { gw, state } = gateway();
    const session = await gw.createHostedSession(START);

    expect(session).toEqual({ sessionId: 'QLREF1', redirectUrl: 'https://hpp.test/ses1', expiresAt: '2026-10-01T12:00:00Z' });
    expect(state.requests[0]).toMatchObject({ op: 'createOrder', body: { total: { amount: '8.00', currencyCode: 'GBP' }, orderReference: 'QLREF1' } });
    expect(state.requests[1]).toMatchObject({
      op: 'createPaymentSession',
      body: {
        order: 'https://api.test/orders/ord1',
        hppType: 'fullPageRedirect',
        doCreateTransaction: true,
        returnUrl: 'https://portal.test/draw/return?session=QLREF1',
        cancelUrl: 'https://portal.test/draw',
        invoiceNumber: 'QLREF1',
      },
    });
  });

  it('is idempotent: the same key returns the same hosted page without calling EPG again', async () => {
    const { gw, state } = gateway();
    await gw.createHostedSession(START);
    const again = await gw.createHostedSession(START);
    expect(again.redirectUrl).toBe('https://hpp.test/ses1');
    expect(state.requests).toHaveLength(2);
  });

  it('restarts an expired, unpaid page under the same reference', async () => {
    const { gw, state } = gateway(new Date('2026-10-01T13:00:00Z'));
    await gw.createHostedSession(START);
    state.session = {};
    const again = await gw.createHostedSession(START);
    expect(again).toMatchObject({ sessionId: 'QLREF1', redirectUrl: 'https://hpp.test/ses2' });
  });

  it('reports pending until EPG has a transaction for the session', async () => {
    const { gw, state } = gateway();
    await gw.createHostedSession(START);
    state.session = {};
    expect(await gw.getPaymentStatus('QLREF1')).toEqual({ status: 'pending' });
  });

  it('reports success only for a sale on our order, for our amount and currency', async () => {
    const { gw, state } = gateway();
    await gw.createHostedSession(START);
    state.session = { transaction: 'https://api.test/transactions/tx1' };
    state.transaction = {
      id: 'tx1',
      type: 'sale',
      state: 'authorized',
      isAuthorized: true,
      order: 'https://api.test/orders/ord1',
      total: { amount: '8.00', currencyCode: 'GBP' },
    };
    expect(await gw.getPaymentStatus('QLREF1')).toEqual({ status: 'succeeded', providerRef: 'tx1', amountPence: '800' });

    state.transaction = { ...state.transaction, total: { amount: '2.00', currencyCode: 'GBP' } };
    expect(await gw.getPaymentStatus('QLREF1')).toMatchObject({ status: 'failed', reasonCode: 'TRANSACTION_MISMATCH' });

    state.transaction = { ...state.transaction, total: { amount: '8.00', currencyCode: 'GBP' }, order: 'https://api.test/orders/someoneelse' };
    expect(await gw.getPaymentStatus('QLREF1')).toMatchObject({ status: 'failed', reasonCode: 'TRANSACTION_MISMATCH' });
  });

  it('reports a decline with its specific reason, and review as pending', async () => {
    const { gw, state } = gateway();
    await gw.createHostedSession(START);
    state.session = { transaction: 'tx1' };
    const base = { id: 'tx1', type: 'sale', order: 'ord1', total: { amount: '8.00', currencyCode: 'GBP' } };

    state.transaction = {
      ...base,
      state: 'declined',
      isAuthorized: false,
      failures: [{ code: 'declinedByIssuer', description: 'Declined' }, { code: 'insufficientFunds', description: 'Insufficient funds' }],
    };
    expect(await gw.getPaymentStatus('QLREF1')).toEqual({ status: 'failed', reasonCode: 'insufficientFunds', reason: 'Insufficient funds' });

    state.transaction = { ...base, state: 'heldForReview' };
    expect(await gw.getPaymentStatus('QLREF1')).toEqual({ status: 'pending' });
  });

  it('reports an expired, unpaid page as failed', async () => {
    const { gw, state } = gateway(new Date('2026-10-01T13:00:00Z'));
    await gw.createHostedSession(START);
    state.session = { expiresAt: '2026-10-01T12:00:00Z' };
    expect(await gw.getPaymentStatus('QLREF1')).toMatchObject({ status: 'failed', reasonCode: 'SESSION_EXPIRED' });
  });

  it('voids an unsettled full refund, refunds a partial one, and never refunds twice', async () => {
    const { gw, state, store } = gateway();
    state.transaction = { id: 'tx1', href: 'https://api.test/transactions/tx1', state: 'captured', total: { amount: '8.00', currencyCode: 'GBP' } };

    const full = await gw.refund({ idempotencyKey: idempotencyKey('refund-1'), providerRef: 'tx1', amountPence: '800' });
    expect(full).toEqual({ refundRef: 'rf1' });
    expect(state.requests.at(-1)).toEqual({ op: 'createTransaction', body: { type: 'void', parentTransaction: 'https://api.test/transactions/tx1' } });

    await gw.refund({ idempotencyKey: idempotencyKey('refund-1'), providerRef: 'tx1', amountPence: '800' });
    expect(state.requests.filter((r) => r.op === 'createTransaction')).toHaveLength(1);

    await gw.refund({ idempotencyKey: idempotencyKey('refund-2'), providerRef: 'tx1', amountPence: '200' });
    expect(state.requests.at(-1)).toEqual({
      op: 'createTransaction',
      body: { type: 'refund', parentTransaction: 'https://api.test/transactions/tx1', total: { amount: '2.00', currencyCode: 'GBP' } },
    });
    expect(store.refunds.get('refund-2')?.method).toBe('refund');
  });
});
