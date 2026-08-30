/**
 * Card payments — GAP-09 ⛔ (provider undecided).
 *
 * The real constraint is gambling-MCC acquirer underwriting, not the API, so the
 * provider may change late. This interface is what makes that survivable.
 *
 * T-9.1: no card data touches this application. The member is sent to hosted
 * fields or a redirect; what comes back is a token. Nothing here accepts a PAN,
 * which is a structural guarantee rather than a coding convention.
 */
import type { IdempotencyKey } from './errors.js';

/** An amount in integer pence. Serialised as a string across the wire — never a float. */
export type PenceString = string;

export interface HostedPaymentSession {
  readonly sessionId: string;
  /** Where to send the member's browser. Card details are entered on the PSP's page. */
  readonly redirectUrl: string;
  readonly expiresAt: string;
}

export interface CreateSessionRequest {
  readonly idempotencyKey: IdempotencyKey;
  readonly amountPence: PenceString;
  readonly currency: 'GBP';
  /** Our reference, an identifier only — never a member name (T-1.3). */
  readonly reference: string;
  readonly returnUrl: string;
  readonly cancelUrl: string;
}

export type PaymentOutcome =
  | { readonly status: 'succeeded'; readonly providerRef: string; readonly amountPence: PenceString;
      readonly cardToken?: string; readonly last4?: string }
  | { readonly status: 'failed'; readonly reasonCode: string; readonly reason: string }
  | { readonly status: 'pending' };

export interface PaymentGateway {
  readonly providerName: string;

  /** Begin a hosted payment. Idempotent: the same key returns the same session. */
  createHostedSession(request: CreateSessionRequest): Promise<HostedPaymentSession>;

  /**
   * Authoritative status. Called after the redirect returns AND from the webhook
   * handler, because a browser that never comes back must not lose a payment.
   */
  getPaymentStatus(sessionId: string): Promise<PaymentOutcome>;

  /**
   * Verify a webhook's signature before its body is trusted.
   *
   * A webhook endpoint is unauthenticated by nature; without this, anyone who
   * learns the URL can assert that a payment succeeded. Every adapter must
   * implement it, which is why it is on the interface rather than left to each.
   */
  verifyWebhookSignature(rawBody: string, headers: Readonly<Record<string, string | undefined>>): boolean;

  parseWebhook(rawBody: string): { readonly sessionId: string; readonly outcome: PaymentOutcome };

  refund(request: {
    readonly idempotencyKey: IdempotencyKey;
    readonly providerRef: string;
    readonly amountPence: PenceString;
  }): Promise<{ readonly refundRef: string }>;
}
