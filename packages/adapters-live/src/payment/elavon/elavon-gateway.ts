/**
 * Card payments through the Elavon Payment Gateway (EPG) — GitHub #12, GAP-09.
 * Selected with `PAYMENT_GATEWAY=elavon`; the sandbox stays the default, so
 * switching provider is configuration, not code (the `PaymentGateway` port).
 *
 * Hosted payment page, full-page redirect, exactly as the client's Wix
 * integration does it: create an EPG order, create a payment session with
 * `doCreateTransaction`, send the member to the session URL. Card details are
 * only ever entered on Elavon's page (T-9.1, PCI SAQ A).
 *
 * The member's return is never trusted: `getPaymentStatus` re-reads the
 * session and its transaction from EPG and checks the transaction belongs to
 * our order, for the amount and currency we asked for, before reporting it.
 */
import { randomBytes } from 'node:crypto';
import type { Pool } from '@qosfc/db';
import type {
  CreateSessionRequest,
  HostedPaymentSession,
  IdempotencyKey,
  PaymentGateway,
  PaymentOutcome,
  PenceString,
} from '@qosfc/ports';
import {
  EpgError,
  decimalToPence,
  penceToDecimal,
  resourceId,
  verifyEpgNotification,
  type EpgClient,
  type EpgTransaction,
  type EpgWebhookConfig,
} from './epg.js';

// EPG TransactionState values (from the Wix integration's payments.js).
const APPROVED_STATES = new Set(['authorized', 'captured', 'settled', 'settlementDelayed']);
const IN_PROGRESS_STATES = new Set(['authorizationPending', 'heldForReview', 'unknown']);
const VOIDABLE_STATES = new Set(['authorized', 'captured', 'heldForReview']);
// EPG's first failure says where a decline happened; later ones say why.
const CHAIN_CODES = new Set(['declinedByGateway', 'declinedByProcessor', 'declinedByIssuer']);

export interface ElavonSessionRecord {
  readonly reference: string;
  readonly idempotencyKey: string;
  readonly epgOrderId: string;
  readonly epgSessionId: string;
  readonly redirectUrl: string;
  readonly amountPence: string;
  readonly currency: string;
  readonly expiresAt: string | null;
}

/** Where the reference ↔ EPG order/session mapping lives. Postgres in production, in memory in tests. */
export interface ElavonSessionStore {
  findByReference(reference: string): Promise<ElavonSessionRecord | undefined>;
  findByIdempotencyKey(key: string): Promise<ElavonSessionRecord | undefined>;
  findBySessionId(epgSessionId: string): Promise<ElavonSessionRecord | undefined>;
  /** Insert, or — for an expired unpaid session being restarted — replace the EPG side of an existing reference. */
  save(record: ElavonSessionRecord): Promise<void>;
  findRefund(idempotencyKey: string): Promise<{ readonly refundRef: string } | undefined>;
  saveRefund(refund: { idempotencyKey: string; saleRef: string; refundRef: string; method: 'void' | 'refund'; amountPence: string }): Promise<void>;
}

export interface ElavonGatewayOptions {
  readonly epg: EpgClient;
  readonly store: ElavonSessionStore;
  readonly webhook?: EpgWebhookConfig;
  readonly now?: () => Date;
  readonly newReference?: () => string;
}

/** Our reference: also sent as EPG's invoiceNumber, which is limited to 25 characters. */
export function generateElavonReference(): string {
  return `QL${Date.now().toString(36)}${randomBytes(8).toString('hex')}`.toUpperCase().slice(0, 25);
}

function withQuery(url: string, name: string, value: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${name}=${encodeURIComponent(value)}`;
}

export class ElavonPaymentGateway implements PaymentGateway {
  readonly providerName = 'live:elavon-epg';

  private readonly epg: EpgClient;
  private readonly store: ElavonSessionStore;
  private readonly webhook: EpgWebhookConfig;
  private readonly now: () => Date;
  private readonly newReference: () => string;

  constructor(options: ElavonGatewayOptions) {
    this.epg = options.epg;
    this.store = options.store;
    this.webhook = options.webhook ?? {};
    this.now = options.now ?? (() => new Date());
    this.newReference = options.newReference ?? generateElavonReference;
  }

  /**
   * Idempotent per key: a retry gets the same hosted page back. If that page
   * has expired unpaid, a fresh EPG order and session are made under the same
   * reference, so the member can try again without a new purchase row.
   */
  async createHostedSession(request: CreateSessionRequest): Promise<HostedPaymentSession> {
    const existing = await this.store.findByIdempotencyKey(request.idempotencyKey);
    if (existing && !(await this.isExpiredUnpaid(existing))) return this.toHostedSession(existing);

    const reference = existing?.reference ?? this.newReference();
    const amount = penceToDecimal(request.amountPence);
    const order = await this.epg.createOrder({
      total: { amount, currencyCode: request.currency },
      description: 'QOSFC lottery entry',
      orderReference: reference,
      // An identifier only — never a member name (T-1.3).
      customReference: request.reference.slice(0, 255),
    });
    const session = await this.epg.createPaymentSession({
      order: order.href,
      hppType: 'fullPageRedirect',
      // The portal finds the purchase by ?session=, and this reference is what
      // this adapter hands back as the session ID.
      returnUrl: withQuery(request.returnUrl, 'session', reference),
      cancelUrl: request.cancelUrl,
      doCreateTransaction: true,
      invoiceNumber: reference,
      customReference: reference,
    });
    if (!session?.url) throw new EpgError('EPG did not return a hosted payment page URL');

    const record: ElavonSessionRecord = {
      reference,
      idempotencyKey: request.idempotencyKey,
      epgOrderId: order.id ?? resourceId(order.href),
      epgSessionId: session.id ?? resourceId(session.href),
      redirectUrl: session.url,
      amountPence: request.amountPence,
      currency: request.currency,
      expiresAt: session.expiresAt ?? null,
    };
    await this.store.save(record);
    return this.toHostedSession(record);
  }

  async getPaymentStatus(sessionId: string): Promise<PaymentOutcome> {
    const record = await this.store.findByReference(sessionId);
    if (!record) throw new Error(`Elavon: unknown payment reference ${sessionId}.`);

    const session = await this.epg.getPaymentSession(record.epgSessionId);
    if (!session?.transaction) {
      const expiresAt = session?.expiresAt ?? record.expiresAt;
      if (expiresAt && new Date(expiresAt) < this.now()) {
        return { status: 'failed', reasonCode: 'SESSION_EXPIRED', reason: 'The payment page expired before payment was made.' };
      }
      return { status: 'pending' };
    }
    return this.evaluate(record, await this.epg.getTransaction(session.transaction));
  }

  verifyWebhookSignature(rawBody: string, headers: Readonly<Record<string, string | undefined>>): boolean {
    return verifyEpgNotification(headers, rawBody, this.webhook) === null;
  }

  /**
   * EPG notifications carry only a resource link — never an outcome — so
   * there is nothing trustworthy to parse into a `PaymentOutcome`, and mapping
   * the link back to our reference needs the database (this method is
   * synchronous). A webhook handler must verify, then call `getPaymentStatus`
   * via `resolveNotification`. Nothing in the portal consumes webhooks yet.
   */
  parseWebhook(_rawBody: string): { readonly sessionId: string; readonly outcome: PaymentOutcome } {
    throw new Error('Elavon notifications carry no payment outcome: use resolveNotification() and then getPaymentStatus().');
  }

  /** Our reference for an EPG notification about a payment session or a sale transaction, if it is one of ours. */
  async resolveNotification(rawBody: string): Promise<string | undefined> {
    const body = JSON.parse(rawBody) as { resourceType?: string; resource?: string };
    if (!body.resource) return undefined;
    let sessionRef: string | undefined;
    if (body.resourceType === 'paymentSession') sessionRef = body.resource;
    if (body.resourceType === 'transaction') sessionRef = (await this.epg.getTransaction(body.resource)).paymentSession;
    if (!sessionRef) return undefined;
    return (await this.store.findBySessionId(resourceId(sessionRef)))?.reference;
  }

  /**
   * Full refund of a sale that hasn't settled → EPG void; otherwise a refund
   * of the amount. Idempotent per key, recorded in `elavon_refund`.
   */
  async refund(request: { readonly idempotencyKey: IdempotencyKey; readonly providerRef: string; readonly amountPence: PenceString }): Promise<{ readonly refundRef: string }> {
    const done = await this.store.findRefund(request.idempotencyKey);
    if (done) return { refundRef: done.refundRef };

    const sale = await this.epg.getTransaction(request.providerRef);
    const salePence = decimalToPence(sale.total?.amount ?? '0');
    const method: 'void' | 'refund' = request.amountPence === salePence && VOIDABLE_STATES.has(sale.state ?? '') ? 'void' : 'refund';

    const result = await this.epg.createTransaction(
      method === 'void'
        ? { type: 'void', parentTransaction: sale.href }
        : { type: 'refund', parentTransaction: sale.href, total: { amount: penceToDecimal(request.amountPence), currencyCode: sale.total?.currencyCode ?? 'GBP' } },
    );
    if (!result || result.isAuthorized !== true || result.state === 'declined') {
      throw new EpgError(`Elavon refused the ${method}: ${describeFailure(result).reason}`, { failures: result?.failures ?? [] });
    }

    const refundRef = result.id ?? resourceId(result.href);
    await this.store.saveRefund({ idempotencyKey: request.idempotencyKey, saleRef: request.providerRef, refundRef, method, amountPence: request.amountPence });
    return { refundRef };
  }

  /** Proves the credentials work — for a readiness check. */
  async checkCredentials(): Promise<void> {
    await this.epg.listMerchants();
  }

  private evaluate(record: ElavonSessionRecord, txn: EpgTransaction): PaymentOutcome {
    let paidPence: string | undefined;
    try {
      paidPence = decimalToPence(txn.total?.amount ?? '');
    } catch {
      paidPence = undefined;
    }
    const orderMatches = txn.order ? resourceId(txn.order) === record.epgOrderId : resourceId(txn.paymentSession) === record.epgSessionId;
    if (
      txn.type !== 'sale' ||
      !orderMatches ||
      paidPence !== record.amountPence ||
      String(txn.total?.currencyCode ?? '').toUpperCase() !== record.currency
    ) {
      return { status: 'failed', reasonCode: 'TRANSACTION_MISMATCH', reason: 'The Elavon transaction does not match this payment.' };
    }

    if (APPROVED_STATES.has(txn.state ?? '') && txn.isAuthorized !== false) {
      return { status: 'succeeded', providerRef: txn.id ?? resourceId(txn.href), amountPence: paidPence };
    }
    // heldForReview included: not paid yet, not declined either.
    if (IN_PROGRESS_STATES.has(txn.state ?? '')) return { status: 'pending' };
    return { status: 'failed', ...describeFailure(txn) };
  }

  private async isExpiredUnpaid(record: ElavonSessionRecord): Promise<boolean> {
    if (!record.expiresAt || new Date(record.expiresAt) >= this.now()) return false;
    const session = await this.epg.getPaymentSession(record.epgSessionId);
    return !session?.transaction;
  }

  private toHostedSession(record: ElavonSessionRecord): HostedPaymentSession {
    return { sessionId: record.reference, redirectUrl: record.redirectUrl, expiresAt: record.expiresAt ?? '' };
  }
}

function describeFailure(txn: EpgTransaction | undefined): { reasonCode: string; reason: string } {
  const failures = txn?.failures ?? [];
  const first = failures.find((f) => f.code && !CHAIN_CODES.has(f.code)) ?? failures[0];
  if (!first && txn?.state === 'expired') return { reasonCode: 'EXPIRED', reason: 'The transaction expired.' };
  return {
    reasonCode: first?.code ?? String(txn?.state ?? 'declined'),
    reason: first?.description ?? `Payment ${txn?.state ?? 'declined'}.`,
  };
}

/** Postgres-backed store (db/migrations/0016). */
export class PgElavonSessionStore implements ElavonSessionStore {
  constructor(private readonly pool: Pool) {}

  private async one(where: string, value: string): Promise<ElavonSessionRecord | undefined> {
    const { rows } = await this.pool.query<{
      reference: string;
      idempotency_key: string;
      epg_order_id: string;
      epg_session_id: string;
      redirect_url: string;
      amount_pence: string;
      currency: string;
      expires_at: Date | null;
    }>(
      `SELECT reference, idempotency_key, epg_order_id, epg_session_id, redirect_url, amount_pence::text AS amount_pence,
              currency, expires_at
         FROM elavon_payment_session WHERE ${where} = $1`,
      [value],
    );
    const r = rows[0];
    return r
      ? {
          reference: r.reference,
          idempotencyKey: r.idempotency_key,
          epgOrderId: r.epg_order_id,
          epgSessionId: r.epg_session_id,
          redirectUrl: r.redirect_url,
          amountPence: r.amount_pence,
          currency: r.currency,
          expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
        }
      : undefined;
  }

  findByReference(reference: string) {
    return this.one('reference', reference);
  }

  findByIdempotencyKey(key: string) {
    return this.one('idempotency_key', key);
  }

  findBySessionId(epgSessionId: string) {
    return this.one('epg_session_id', epgSessionId);
  }

  async save(record: ElavonSessionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO elavon_payment_session
         (reference, idempotency_key, epg_order_id, epg_session_id, redirect_url, amount_pence, currency, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (reference) DO UPDATE
         SET epg_order_id = EXCLUDED.epg_order_id, epg_session_id = EXCLUDED.epg_session_id,
             redirect_url = EXCLUDED.redirect_url, expires_at = EXCLUDED.expires_at`,
      [record.reference, record.idempotencyKey, record.epgOrderId, record.epgSessionId, record.redirectUrl, record.amountPence, record.currency, record.expiresAt],
    );
  }

  async findRefund(idempotencyKey: string) {
    const { rows } = await this.pool.query<{ refund_ref: string }>(`SELECT refund_ref FROM elavon_refund WHERE idempotency_key = $1`, [idempotencyKey]);
    return rows[0] ? { refundRef: rows[0].refund_ref } : undefined;
  }

  async saveRefund(refund: { idempotencyKey: string; saleRef: string; refundRef: string; method: 'void' | 'refund'; amountPence: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO elavon_refund (idempotency_key, sale_ref, refund_ref, method, amount_pence) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [refund.idempotencyKey, refund.saleRef, refund.refundRef, refund.method, refund.amountPence],
    );
  }
}
