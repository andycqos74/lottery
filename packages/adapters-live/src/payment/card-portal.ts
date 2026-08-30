/**
 * GAP-09 — card payments, STILL UNCONFIRMED. The client's working assumption is
 * a third-party hosted card processing portal (redirect-based, no card data
 * touching this application — T-9.1), alongside standing orders (handled
 * entirely by bank-feed matching, no gateway involved) and Direct Debit
 * (GAP-10). This class exists so that shape is visible in code, matching
 * `ExternalCertifiedRandomnessSource`'s pattern elsewhere in this codebase:
 * every method refuses explicitly rather than pretending to work, because
 * shipping a plausible stand-in for a payment integration is exactly what
 * technical spec §15.2 forbids — and unlike the sandbox (which fakes an HTTP
 * round trip on purpose, to prove out webhook/settlement handling), there is no
 * real acquirer to gambling-MCC underwrite here yet, so there is nothing to
 * simulate honestly.
 *
 * Becomes real once GAP-09 names a provider: swap the method bodies for real
 * API calls, keep the port, done — no workflow or activity changes (build plan
 * §5). Model each on `SandboxPaymentGateway` for the request/response shapes
 * already proven against the sandbox's fake acquirer.
 */
import type {
  CreateSessionRequest,
  HostedPaymentSession,
  IdempotencyKey,
  PaymentGateway,
  PaymentOutcome,
  PenceString,
} from '@qosfc/ports';

const PROVIDER = 'live:card-portal';

function notConfirmed(method: string): never {
  throw new Error(
    `GAP-09: ${PROVIDER}.${method}() has no provider to call — the third-party card processing portal ` +
      'has not been chosen (gambling-MCC acquirer underwriting is the real constraint, not the API). ' +
      'Pick a provider, then implement this method against its API; the port and the rest of the ' +
      'payment workflow do not change.',
  );
}

export class ThirdPartyCardPortalGateway implements PaymentGateway {
  readonly providerName = PROVIDER;

  async createHostedSession(_request: CreateSessionRequest): Promise<HostedPaymentSession> {
    notConfirmed('createHostedSession');
  }

  async getPaymentStatus(_sessionId: string): Promise<PaymentOutcome> {
    notConfirmed('getPaymentStatus');
  }

  verifyWebhookSignature(_rawBody: string, _headers: Readonly<Record<string, string | undefined>>): boolean {
    notConfirmed('verifyWebhookSignature');
  }

  parseWebhook(_rawBody: string): { readonly sessionId: string; readonly outcome: PaymentOutcome } {
    notConfirmed('parseWebhook');
  }

  async refund(_request: {
    readonly idempotencyKey: IdempotencyKey;
    readonly providerRef: string;
    readonly amountPence: PenceString;
  }): Promise<{ readonly refundRef: string }> {
    notConfirmed('refund');
  }
}
