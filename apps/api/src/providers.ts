/**
 * Card payments (GAP-09, GitHub #12). Which provider takes card payments is
 * configuration: `PAYMENT_GATEWAY` picks one of the adapters below, each
 * behind the same `PaymentGateway` port, so switching provider is an env var
 * change and adding one is a new adapter plus one line here — no route code
 * changes. The sandbox (a dummy transaction simulator) stays the default.
 */
import { readFileSync } from 'node:fs';
import { SandboxBacsBureau, SandboxNotifier, SandboxPaymentGateway } from '@qosfc/adapters-sandbox';
import { buildElavonPaymentGateway, SocketLabsNotifier, type ElavonEnv } from '@qosfc/adapters-live';
import type { Pool } from '@qosfc/db';
import type { BacsBureau, Notifier, PaymentGateway } from '@qosfc/ports';

export interface PaymentProviderEnv extends ElavonEnv {
  readonly PAYMENT_GATEWAY?: string | undefined;
  readonly SANDBOX_PROVIDERS_URL?: string | undefined;
  readonly SANDBOX_WEBHOOK_SECRET_FILE?: string | undefined;
}

const PAYMENT_GATEWAYS: Record<string, (pool: Pool, env: PaymentProviderEnv) => PaymentGateway> = {
  sandbox: (_pool, env) =>
    new SandboxPaymentGateway({
      baseUrl: env.SANDBOX_PROVIDERS_URL ?? 'http://sandbox-providers:9090',
      webhookSecret: readSecret(env.SANDBOX_WEBHOOK_SECRET_FILE) ?? 'sandbox-development-secret',
    }),
  // Elavon Payment Gateway, hosted payment page (client's choice, GitHub #12).
  elavon: (pool, env) => buildElavonPaymentGateway(pool, env),
};

export function buildPaymentGateway(pool: Pool, env: PaymentProviderEnv): PaymentGateway {
  const chosen = env.PAYMENT_GATEWAY || 'sandbox';
  const build = PAYMENT_GATEWAYS[chosen];
  if (!build) {
    throw new Error(`PAYMENT_GATEWAY="${chosen}" has no adapter. Known values: ${Object.keys(PAYMENT_GATEWAYS).map((k) => `"${k}"`).join(', ')}.`);
  }
  return build(pool, env);
}

export interface BacsBureauEnv {
  readonly BACS_BUREAU?: string | undefined;
  readonly SANDBOX_PROVIDERS_URL?: string | undefined;
  readonly SANDBOX_WEBHOOK_SECRET_FILE?: string | undefined;
}

// GAP-10 — Bacs route (bureau vs GoCardless vs own SUN) is still unconfirmed.
// Unblocked for *build* purposes only, same shape as GAP-09: the portal's
// Direct Debit setup runs against the sandbox bureau as a dummy mandate
// simulator that always approves — there is no live adapter reachable from
// the member portal yet (own_sun exists but refuses every method until
// Bacstel-IP access exists to build against).
export function buildBacsBureau(env: BacsBureauEnv): BacsBureau {
  const chosen = env.BACS_BUREAU ?? 'sandbox';
  if (chosen !== 'sandbox') {
    throw new Error(
      `GAP-10 is unresolved, so BACS_BUREAU="${chosen}" has no adapter reachable from the member portal. Only "sandbox" exists today.`,
    );
  }
  return new SandboxBacsBureau({
    baseUrl: env.SANDBOX_PROVIDERS_URL ?? 'http://sandbox-providers:9090',
    webhookSecret: readSecret(env.SANDBOX_WEBHOOK_SECRET_FILE) ?? 'sandbox-development-secret',
  });
}

export interface NotifierEnv {
  readonly NOTIFIER?: string | undefined;
  readonly SANDBOX_PROVIDERS_URL?: string | undefined;
  readonly SANDBOX_WEBHOOK_SECRET_FILE?: string | undefined;
  readonly SOCKETLABS_SERVER_ID_FILE?: string | undefined;
  readonly SOCKETLABS_API_KEY_FILE?: string | undefined;
  readonly SOCKETLABS_FROM_EMAIL?: string | undefined;
  readonly SOCKETLABS_FROM_NAME?: string | undefined;
}

// GAP-30, resolved for email: SocketLabs (client decision, 2026-09-24, sending
// domain qosfc.com). Other channels (sms/post/via_agent) remain undecided —
// SocketLabsNotifier itself refuses anything that isn't 'email'.
export function buildNotifier(pool: Pool, env: NotifierEnv): Notifier {
  const chosen = env.NOTIFIER ?? 'sandbox';
  if (chosen === 'sandbox') {
    return new SandboxNotifier({
      baseUrl: env.SANDBOX_PROVIDERS_URL ?? 'http://sandbox-providers:9090',
      webhookSecret: readSecret(env.SANDBOX_WEBHOOK_SECRET_FILE) ?? 'sandbox-development-secret',
    });
  }
  if (chosen === 'socketlabs') {
    const serverId = readSecret(env.SOCKETLABS_SERVER_ID_FILE);
    const apiKey = readSecret(env.SOCKETLABS_API_KEY_FILE);
    const fromEmail = env.SOCKETLABS_FROM_EMAIL;
    if (!serverId || !apiKey || !fromEmail) {
      throw new Error(
        'NOTIFIER=socketlabs needs SOCKETLABS_SERVER_ID_FILE, SOCKETLABS_API_KEY_FILE, and SOCKETLABS_FROM_EMAIL to be set and readable.',
      );
    }
    return new SocketLabsNotifier(pool, { serverId, apiKey, fromEmail, fromName: env.SOCKETLABS_FROM_NAME });
  }
  throw new Error(`GAP-30: NOTIFIER="${chosen}" has no adapter. Known values: "sandbox", "socketlabs".`);
}

function readSecret(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
}
