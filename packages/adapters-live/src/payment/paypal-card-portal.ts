/**
 * GAP-09 — PayPal chosen as the card acquirer for build/proof purposes (client
 * decision, 2026-09-04, tested against PayPal's sandbox first). Debit/credit
 * card details are collected through PayPal's Advanced Card Fields — hosted
 * iframes served by PayPal and embedded in our payment page, so a card number
 * still never reaches this application (T-9.1) even though the member never
 * leaves our page. `createHostedSession` only creates the PayPal order; the
 * card fields JS SDK confirms it directly from the browser, and this
 * adapter's `getPaymentStatus` performs the authoritative server-side capture
 * once the member returns.
 *
 * NOTE on the real acquiring question GAP-09 is actually about: PayPal's
 * standard merchant agreement excludes gambling/lottery transactions in most
 * regions. Using it here proves the payment flow end to end; it is not by
 * itself confirmation that PayPal can be the *production* acquirer for a
 * licensed society lottery — that still needs an explicit answer before this
 * goes live with real money (see docs/gap-register.md GAP-09).
 */
import type {
  CreateSessionRequest,
  HostedPaymentSession,
  IdempotencyKey,
  PaymentGateway,
  PaymentOutcome,
  PenceString,
} from '@qosfc/ports';

const PROVIDER = 'live:paypal';

export interface PayPalConfig {
  /** e.g. https://api-m.sandbox.paypal.com in sandbox, https://api-m.paypal.com live. */
  readonly apiBase: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Webhook verification is not wired yet (no endpoint receives PayPal webhooks) — see verifyWebhookSignature below. */
  readonly webhookId?: string | undefined;
}

interface PayPalLink {
  readonly rel: string;
  readonly href: string;
}

interface PayPalCapture {
  readonly id: string;
  readonly status: string;
  readonly amount: { readonly currency_code: string; readonly value: string };
}

interface PayPalOrder {
  readonly id: string;
  readonly status: string;
  readonly links?: readonly PayPalLink[];
  readonly payment_source?: { readonly card?: { readonly last_digits?: string } };
  readonly purchase_units?: readonly {
    readonly amount?: { readonly value: string };
    readonly payments?: { readonly captures?: readonly PayPalCapture[] };
  }[];
}

/** "8.00" -> "800". PayPal amounts are always two-decimal strings for GBP. */
function penceFromAmount(value: string): PenceString {
  const [pounds = '0', fraction = '0'] = value.split('.');
  const pence = fraction.padEnd(2, '0').slice(0, 2);
  return (BigInt(pounds) * 100n + BigInt(pence)).toString();
}

function amountFromPence(pence: PenceString): string {
  const n = BigInt(pence);
  const whole = n / 100n;
  const frac = (n % 100n).toString().padStart(2, '0');
  return `${whole}.${frac}`;
}

export class PayPalCardPortalGateway implements PaymentGateway {
  readonly providerName = PROVIDER;
  private cachedToken: { readonly value: string; readonly expiresAt: number } | undefined;

  constructor(private readonly config: PayPalConfig) {}

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 30_000) return this.cachedToken.value;

    const res = await fetch(`${this.config.apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${PROVIDER}: OAuth token request failed (${res.status}): ${text}`);
    const body = JSON.parse(text) as { access_token: string; expires_in: number };
    this.cachedToken = { value: body.access_token, expiresAt: now + body.expires_in * 1000 };
    return this.cachedToken.value;
  }

  private async call<T>(path: string, init: { method: string; body?: unknown; idempotencyKey?: string }): Promise<T> {
    const token = await this.accessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (init.idempotencyKey) headers['PayPal-Request-Id'] = init.idempotencyKey;
    const res = await fetch(`${this.config.apiBase}${path}`, {
      method: init.method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${PROVIDER}: ${init.method} ${path} failed (${res.status}): ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async createHostedSession(request: CreateSessionRequest): Promise<HostedPaymentSession> {
    const order = await this.call<PayPalOrder>('/v2/checkout/orders', {
      method: 'POST',
      idempotencyKey: request.idempotencyKey,
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: request.reference,
            amount: { currency_code: request.currency, value: amountFromPence(request.amountPence) },
          },
        ],
        application_context: {
          return_url: request.returnUrl,
          cancel_url: request.cancelUrl,
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
        },
      },
    });
    // The approve link is a fallback for a redirect-based caller. The embedded
    // Advanced Card Fields flow (apps/api/src/views.ts) never follows it — it
    // confirms the order id returned as sessionId directly from the browser.
    const approve = order.links?.find((l) => l.rel === 'approve')?.href ?? request.returnUrl;
    return {
      sessionId: order.id,
      redirectUrl: approve,
      // PayPal orders are valid for 3 hours by default; not returned on the create response.
      expiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    };
  }

  async getPaymentStatus(sessionId: string): Promise<PaymentOutcome> {
    const order = await this.call<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(sessionId)}`, { method: 'GET' });

    if (order.status === 'COMPLETED') return this.outcomeFromCaptured(order);

    if (order.status === 'APPROVED') {
      // The card fields SDK confirmed the order in the browser; the capture
      // itself is the authoritative, server-side "money actually moved" step.
      const captured = await this.call<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(sessionId)}/capture`, {
        method: 'POST',
        idempotencyKey: `capture:${sessionId}`,
      });
      if (captured.status === 'COMPLETED') return this.outcomeFromCaptured(captured);
      const cap = captured.purchase_units?.[0]?.payments?.captures?.[0];
      return {
        status: 'failed',
        reasonCode: cap?.status ?? captured.status ?? 'capture_failed',
        reason: `PayPal did not complete the capture (status: ${cap?.status ?? captured.status}).`,
      };
    }

    if (order.status === 'VOIDED') {
      return { status: 'failed', reasonCode: 'voided', reason: 'The order was voided.' };
    }

    // CREATED / PAYER_ACTION_REQUIRED / SAVED — the member has not finished confirming yet.
    return { status: 'pending' };
  }

  private outcomeFromCaptured(order: PayPalOrder): PaymentOutcome {
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
    const value = capture?.amount.value ?? order.purchase_units?.[0]?.amount?.value;
    if (!capture || !value) {
      return { status: 'failed', reasonCode: 'no_capture', reason: 'PayPal reported the order complete with no capture record.' };
    }
    return {
      status: 'succeeded',
      providerRef: capture.id,
      amountPence: penceFromAmount(value),
      ...(order.payment_source?.card?.last_digits ? { last4: order.payment_source.card.last_digits } : {}),
    };
  }

  /**
   * Not wired: no route in apps/api receives PayPal webhooks yet (the return-URL
   * round trip after card-fields confirmation already drives getPaymentStatus,
   * which is enough to prove the flow). PayPal's own verification is a network
   * call (POST /v1/notifications/verify-webhook-signature), which does not fit
   * this port's synchronous signature — implementing it properly needs either
   * that call restructured as async here, or local cert-pinned RSA verification.
   * Refusing rather than pretending, same convention as ThirdPartyCardPortalGateway.
   */
  verifyWebhookSignature(_rawBody: string, _headers: Readonly<Record<string, string | undefined>>): boolean {
    return false;
  }

  parseWebhook(_rawBody: string): { readonly sessionId: string; readonly outcome: PaymentOutcome } {
    throw new Error(`${PROVIDER}: no webhook receiver is wired yet — see verifyWebhookSignature.`);
  }

  async refund(request: {
    readonly idempotencyKey: IdempotencyKey;
    readonly providerRef: string;
    readonly amountPence: PenceString;
  }): Promise<{ readonly refundRef: string }> {
    const result = await this.call<{ id: string }>(`/v2/payments/captures/${encodeURIComponent(request.providerRef)}/refund`, {
      method: 'POST',
      idempotencyKey: request.idempotencyKey,
      body: { amount: { currency_code: 'GBP', value: amountFromPence(request.amountPence) } },
    });
    return { refundRef: result.id };
  }
}
