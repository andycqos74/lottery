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
import type { PaymentGateway } from '@qosfc/ports';

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

function readSecret(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
}
