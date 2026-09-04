/**
 * GAP-09 — payment service provider (real gambling-MCC acquirer) is still
 * unresolved. Unblocked for *build* purposes only: the portal's online
 * purchase flow (`entries.ts`) runs end to end against the sandbox PSP as a
 * dummy transaction simulator, so the flow is provable now and swaps to a
 * live acquirer the same way every other port does — a new adapter plus an
 * env var, no route code changes — once an acquirer is actually chosen.
 */
import { readFileSync } from 'node:fs';
import { SandboxPaymentGateway } from '@qosfc/adapters-sandbox';
import { PayPalCardPortalGateway } from '@qosfc/adapters-live';
import type { PaymentGateway } from '@qosfc/ports';

export interface PaymentProviderEnv {
  readonly PAYMENT_GATEWAY?: string | undefined;
  readonly SANDBOX_PROVIDERS_URL?: string | undefined;
  readonly SANDBOX_WEBHOOK_SECRET_FILE?: string | undefined;
  readonly PAYPAL_API_BASE?: string | undefined;
  readonly PAYPAL_CLIENT_ID_FILE?: string | undefined;
  readonly PAYPAL_CLIENT_SECRET_FILE?: string | undefined;
}

export function buildPaymentGateway(env: PaymentProviderEnv): PaymentGateway {
  const chosen = env.PAYMENT_GATEWAY ?? 'sandbox';
  if (chosen === 'sandbox') {
    return new SandboxPaymentGateway({
      baseUrl: env.SANDBOX_PROVIDERS_URL ?? 'http://sandbox-providers:9090',
      webhookSecret: readSecret(env.SANDBOX_WEBHOOK_SECRET_FILE) ?? 'sandbox-development-secret',
    });
  }
  if (chosen === 'paypal_sandbox' || chosen === 'paypal') {
    const clientId = readSecret(env.PAYPAL_CLIENT_ID_FILE);
    const clientSecret = readSecret(env.PAYPAL_CLIENT_SECRET_FILE);
    if (!clientId || !clientSecret) {
      throw new Error('PAYMENT_GATEWAY=paypal_sandbox needs PAYPAL_CLIENT_ID_FILE and PAYPAL_CLIENT_SECRET_FILE to be set and readable.');
    }
    return new PayPalCardPortalGateway({
      apiBase: env.PAYPAL_API_BASE ?? 'https://api-m.sandbox.paypal.com',
      clientId,
      clientSecret,
    });
  }
  throw new Error(
    `GAP-09: PAYMENT_GATEWAY="${chosen}" has no adapter. Known values: "sandbox", "paypal_sandbox". ` +
      `Implement any other live adapter in packages/adapters-live and make it pass the shared contract suite.`,
  );
}

/**
 * The client ID is not a secret (PayPal's own JS SDK is loaded with it in
 * plain sight on every merchant's checkout page) — this is what lets the
 * embedded Advanced Card Fields on /draw/pay render at all. Returns undefined
 * for the sandbox gateway, which has no browser-side component.
 */
export function paypalBrowserConfig(env: PaymentProviderEnv): { readonly clientId: string } | undefined {
  const chosen = env.PAYMENT_GATEWAY ?? 'sandbox';
  if (chosen !== 'paypal_sandbox' && chosen !== 'paypal') return undefined;
  const clientId = readSecret(env.PAYPAL_CLIENT_ID_FILE);
  return clientId ? { clientId } : undefined;
}

function readSecret(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
}
