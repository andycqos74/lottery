/**
 * Sandbox adapters for every external system (build plan §5).
 *
 * Each speaks the same wire protocol its real counterpart would, so the internal
 * process and data flow can be built and verified before GAP-09, GAP-10, GAP-30
 * and GAP-33 are answered.
 *
 * Swapping to live is a new adapter plus an environment variable — no workflow or
 * activity code changes. A live adapter is "done" when it passes the same
 * contract suite these pass.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  BacsBureau,
  BankFeed,
  CollectionResult,
  DeliveryOutcome,
  Mandate,
  MandateEvent,
  MandateRequest,
  Notifier,
  NotificationRequest,
  PaymentGateway,
  PaymentOutcome,
  PrintHandoff,
  CreateSessionRequest,
  HostedPaymentSession,
  StatementSummary,
  BankCredit,
  CollectionInstruction,
  SubmissionReceipt,
  IdempotencyKey,
  PenceString,
} from '@qosfc/ports';
import { SANDBOX_PREFIX } from '@qosfc/ports';
import { sandboxRequest, type SandboxHttpOptions } from './http/client.js';

export interface SandboxConfig {
  readonly baseUrl: string;
  /** Shared with the sandbox so webhook signatures can be verified as a real PSP's would. */
  readonly webhookSecret: string;
}

export class SandboxPaymentGateway implements PaymentGateway {
  readonly providerName = `${SANDBOX_PREFIX}psp`;
  private readonly http: SandboxHttpOptions;

  constructor(private readonly config: SandboxConfig) {
    this.http = { baseUrl: config.baseUrl, provider: this.providerName };
  }

  createHostedSession(request: CreateSessionRequest): Promise<HostedPaymentSession> {
    return sandboxRequest(this.http, '/psp/sessions', {
      method: 'POST',
      body: request,
      idempotencyKey: request.idempotencyKey,
    });
  }

  getPaymentStatus(sessionId: string): Promise<PaymentOutcome> {
    return sandboxRequest(this.http, `/psp/sessions/${encodeURIComponent(sessionId)}`, { method: 'GET' });
  }

  /**
   * A webhook endpoint is unauthenticated by nature: anyone who learns the URL
   * can POST to it. Without a verified signature, "this payment succeeded" is an
   * assertion by a stranger. Every adapter must implement this, which is why it
   * is on the port rather than left to each one's discretion.
   */
  verifyWebhookSignature(rawBody: string, headers: Readonly<Record<string, string | undefined>>): boolean {
    const provided = headers['x-sandbox-signature'];
    if (!provided) return false;
    const expected = createHmac('sha256', this.config.webhookSecret).update(rawBody).digest('hex');
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    // Constant-time: a fast-failing comparison leaks the signature byte by byte.
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(rawBody: string): { sessionId: string; outcome: PaymentOutcome } {
    return JSON.parse(rawBody) as { sessionId: string; outcome: PaymentOutcome };
  }

  refund(request: {
    idempotencyKey: IdempotencyKey;
    providerRef: string;
    amountPence: PenceString;
  }): Promise<{ refundRef: string }> {
    return sandboxRequest(this.http, '/psp/refunds', {
      method: 'POST',
      body: request,
      idempotencyKey: request.idempotencyKey,
    });
  }
}

/**
 * GAP-10, held for now: "own SUN" (Service User Number) is the assumed route —
 * the client submits Direct Debit collections directly, rather than through a
 * bureau or a third party like GoCardless — with the option left open to switch
 * later. `route` names which of the three the sandbox is standing in for; only
 * the message shapes and settlement timing would differ for a live adapter.
 */
export type BacsRoute = 'own_sun' | 'bureau' | 'third_party';

export class SandboxBacsBureau implements BacsBureau {
  readonly providerName: string;
  private readonly http: SandboxHttpOptions;

  constructor(config: SandboxConfig, readonly settlementDays = 3, readonly route: BacsRoute = 'own_sun') {
    this.providerName = `${SANDBOX_PREFIX}bacs:${route}`;
    this.http = { baseUrl: config.baseUrl, provider: this.providerName };
  }

  createMandate(request: MandateRequest): Promise<Mandate> {
    return sandboxRequest(this.http, '/bacs/mandates', {
      method: 'POST',
      body: request,
      idempotencyKey: request.idempotencyKey,
    });
  }

  getMandate(mandateRef: string): Promise<Mandate> {
    return sandboxRequest(this.http, `/bacs/mandates/${encodeURIComponent(mandateRef)}`, { method: 'GET' });
  }

  submitCollections(request: {
    idempotencyKey: IdempotencyKey;
    cycleKey: string;
    instructions: readonly CollectionInstruction[];
  }): Promise<SubmissionReceipt> {
    return sandboxRequest(this.http, '/bacs/submissions', {
      method: 'POST',
      body: request,
      // T-5.6: the cycle key IS the idempotency key, so a retry after a timeout
      // cannot collect from ~600 members a second time.
      idempotencyKey: request.idempotencyKey,
    });
  }

  fetchCollectionResults(
    submissionId: string,
  ): Promise<{ ready: false } | { ready: true; results: readonly CollectionResult[] }> {
    return sandboxRequest(this.http, `/bacs/submissions/${encodeURIComponent(submissionId)}/results`, {
      method: 'GET',
    });
  }

  fetchMandateEvents(since: string): Promise<readonly MandateEvent[]> {
    return sandboxRequest(this.http, `/bacs/mandate-events?since=${encodeURIComponent(since)}`, { method: 'GET' });
  }
}

export class SandboxBankFeed implements BankFeed {
  readonly providerName = `${SANDBOX_PREFIX}bank`;
  private readonly http: SandboxHttpOptions;

  /**
   * The sandbox serves all three GAP-33 candidate shapes from the same fixtures,
   * so the matching engine can be built and proven before the decision lands.
   *
   * GAP-33, held for now: manual CSV upload is the assumed route, with Open
   * Banking and continued OCR left as options for future development — hence
   * `csv` as the default rather than `ocr_pdf`.
   */
  constructor(config: SandboxConfig, readonly source: 'open_banking' | 'csv' | 'ocr_pdf' = 'csv') {
    this.http = { baseUrl: config.baseUrl, provider: this.providerName };
  }

  listStatements(request: { since?: number; limit?: number }): Promise<readonly StatementSummary[]> {
    const params = new URLSearchParams({ source: this.source });
    if (request.since !== undefined) params.set('since', String(request.since));
    if (request.limit !== undefined) params.set('limit', String(request.limit));
    return sandboxRequest(this.http, `/bank/statements?${params}`, { method: 'GET' });
  }

  extractCredits(request: {
    statementNumber: number;
    fromIndex?: number;
  }): Promise<{ credits: readonly BankCredit[]; nextIndex?: number }> {
    const params = new URLSearchParams({ source: this.source, from: String(request.fromIndex ?? 0) });
    return sandboxRequest(this.http, `/bank/statements/${request.statementNumber}/credits?${params}`, {
      method: 'GET',
    });
  }
}

export class SandboxNotifier implements Notifier {
  readonly providerName = `${SANDBOX_PREFIX}notifier`;
  private readonly http: SandboxHttpOptions;

  constructor(config: SandboxConfig) {
    this.http = { baseUrl: config.baseUrl, provider: this.providerName };
  }

  send(request: NotificationRequest): Promise<DeliveryOutcome> {
    return sandboxRequest(this.http, '/notify/send', {
      method: 'POST',
      body: request,
      idempotencyKey: request.idempotencyKey,
    });
  }

  fetchDeliveryEvents(since: string) {
    return sandboxRequest<readonly { providerRef: string; status: 'delivered' | 'bounced' | 'complained'; at: string }[]>(
      this.http,
      `/notify/events?since=${encodeURIComponent(since)}`,
      { method: 'GET' },
    );
  }
}

export class SandboxPrintHandoff implements PrintHandoff {
  readonly providerName = `${SANDBOX_PREFIX}print`;
  private readonly http: SandboxHttpOptions;

  constructor(config: SandboxConfig) {
    this.http = { baseUrl: config.baseUrl, provider: this.providerName };
  }

  submitBatch(request: {
    idempotencyKey: IdempotencyKey;
    campaignRef: string;
    mergeDataRef: string;
    itemCount: number;
  }): Promise<{ batchRef: string; acceptedCount: number }> {
    return sandboxRequest(this.http, '/print/batches', {
      method: 'POST',
      body: request,
      idempotencyKey: request.idempotencyKey,
    });
  }
}
