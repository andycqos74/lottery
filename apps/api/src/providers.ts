/**
 * GAP-09 — payment service provider (real gambling-MCC acquirer) is still
 * unresolved. Unblocked for *build* purposes only: the portal's online
 * purchase flow (`entries.ts`) runs end to end against the sandbox PSP as a
 * dummy transaction simulator, so the flow is provable now and swaps to a
 * live acquirer the same way every other port does — a new adapter plus an
 * env var, no route code changes — once an acquirer is actually chosen.
 */
import { readFileSync } from 'node:fs';
import { SandboxBacsBureau, SandboxNotifier, SandboxPaymentGateway } from '@qosfc/adapters-sandbox';
import { SocketLabsNotifier } from '@qosfc/adapters-live';
import type { Pool } from '@qosfc/db';
import type { BacsBureau, Notifier, PaymentGateway } from '@qosfc/ports';

export interface PaymentProviderEnv {
  readonly PAYMENT_GATEWAY?: string | undefined;
  readonly SANDBOX_PROVIDERS_URL?: string | undefined;
  readonly SANDBOX_WEBHOOK_SECRET_FILE?: string | undefined;
}

export function buildPaymentGateway(env: PaymentProviderEnv): PaymentGateway {
  const chosen = env.PAYMENT_GATEWAY ?? 'sandbox';
  if (chosen !== 'sandbox') {
    throw new Error(
      `GAP-09 is unresolved, so PAYMENT_GATEWAY="${chosen}" has no adapter. Only "sandbox" exists today. ` +
        `Implement the live adapter in packages/adapters-live and make it pass the shared contract suite.`,
    );
  }
  return new SandboxPaymentGateway({
    baseUrl: env.SANDBOX_PROVIDERS_URL ?? 'http://sandbox-providers:9090',
    webhookSecret: readSecret(env.SANDBOX_WEBHOOK_SECRET_FILE) ?? 'sandbox-development-secret',
  });
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
