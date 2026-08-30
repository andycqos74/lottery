/**
 * The composition root.
 *
 * The ONE place that decides which adapter set is in use. Nothing downstream
 * knows the answer, which is what makes swapping a sandbox provider for a live
 * one an environment-variable change rather than a code change (build plan §5).
 */
import { readFileSync } from 'node:fs';
import {
  CsprngRandomnessSource,
  ExternalCertifiedRandomnessSource,
  ManualPhysicalDrawSource,
  SandboxBacsBureau,
  SandboxBankFeed,
  SandboxNotifier,
  SandboxPaymentGateway,
  SandboxPrintHandoff,
} from '@qosfc/adapters-sandbox';
import { assertNoSandboxInProduction, type ProviderRegistry, type RandomnessSource } from '@qosfc/ports';

export interface ProviderEnv {
  readonly PAYMENT_GATEWAY?: string | undefined;
  readonly BACS_BUREAU?: string | undefined;
  /** GAP-10, held for now: own_sun | bureau | third_party. Default own_sun. */
  readonly BACS_ROUTE?: string | undefined;
  readonly BANK_FEED?: string | undefined;
  /** GAP-33, held for now: open_banking | csv | ocr_pdf. Default csv. */
  readonly BANK_FEED_SOURCE?: string | undefined;
  readonly NOTIFIER?: string | undefined;
  readonly RANDOMNESS_SOURCE?: string | undefined;
  /** Required when RANDOMNESS_SOURCE=external_certified (random.org). */
  readonly RANDOM_ORG_API_KEY_FILE?: string | undefined;
  readonly SANDBOX_PROVIDERS_URL?: string | undefined;
  readonly SANDBOX_WEBHOOK_SECRET_FILE?: string | undefined;
  readonly NODE_ENV?: string | undefined;
}

export function buildProviderRegistry(env: ProviderEnv): ProviderRegistry {
  const sandbox = {
    baseUrl: env.SANDBOX_PROVIDERS_URL ?? 'http://sandbox-providers:9090',
    webhookSecret: readSecret(env.SANDBOX_WEBHOOK_SECRET_FILE) ?? 'sandbox-development-secret',
  };

  const bacsRoute = (env.BACS_ROUTE ?? 'own_sun') as 'own_sun' | 'bureau' | 'third_party';
  const bankFeedSource = (env.BANK_FEED_SOURCE ?? 'csv') as 'open_banking' | 'csv' | 'ocr_pdf';

  const registry: ProviderRegistry = {
    // GAP-09, held for now: three dummy channels stand in for the eventual PSP —
    // an existing bank standing order (seen only via the bank feed, no PSP
    // integration at all), third-party Direct Debit creation (BacsBureau below),
    // and a third-party card processing portal (this hosted-session gateway).
    paymentGateway: select(env.PAYMENT_GATEWAY, 'PAYMENT_GATEWAY', 'GAP-09', {
      sandbox: () => new SandboxPaymentGateway(sandbox),
    }),
    bacsBureau: select(env.BACS_BUREAU, 'BACS_BUREAU', 'GAP-10', {
      sandbox: () => new SandboxBacsBureau(sandbox, 3, bacsRoute),
    }),
    bankFeed: select(env.BANK_FEED, 'BANK_FEED', 'GAP-33', {
      sandbox: () => new SandboxBankFeed(sandbox, bankFeedSource),
    }),
    notifier: select(env.NOTIFIER, 'NOTIFIER', 'GAP-30', {
      sandbox: () => new SandboxNotifier(sandbox),
    }),
    printHandoff: new SandboxPrintHandoff(sandbox),
    randomness: buildRandomnessSource(env.RANDOMNESS_SOURCE, env.RANDOM_ORG_API_KEY_FILE),
  };

  // Belt and braces against the mistake that would look exactly like everything
  // working: dummy providers still wired in on the day real money moves.
  assertNoSandboxInProduction(registry, env.NODE_ENV);
  return registry;
}

/**
 * GAP-21 ⛔ — the entropy source is a LICENCE CONDITION question for the
 * registering authority, not a technical preference.
 *
 * `unset` is the shipped default and it REFUSES to build a source. The draw then
 * cannot run, which is the correct behaviour: numbers nobody has approved must
 * never be generated for a real draw.
 */
function buildRandomnessSource(value: string | undefined, apiKeyFile: string | undefined): RandomnessSource {
  switch (value) {
    case 'csprng':
      return new CsprngRandomnessSource();
    case 'external_certified': {
      // GAP-21, resolved (source): random.org's HTTP API — see
      // packages/adapters-sandbox/src/randomness/csprng.ts. Licence sign-off on
      // this specific source is the half of GAP-21 that remains open, so this
      // still requires explicit selection, never a default.
      const apiKey = readSecret(apiKeyFile);
      if (!apiKey) {
        throw new Error(
          'GAP-21: RANDOMNESS_SOURCE=external_certified requires RANDOM_ORG_API_KEY_FILE to point at a ' +
            'readable file holding a random.org API key (https://api.random.org/api-keys).',
        );
      }
      return new ExternalCertifiedRandomnessSource({ apiKey });
    }
    case 'manual_physical_draw':
      return new ManualPhysicalDrawSource();
    case undefined:
    case '':
    case 'unset':
      throw new Error(
        'GAP-21: RANDOMNESS_SOURCE is unset. The acceptable entropy source, and whether independent ' +
          'assurance is required, must be agreed with the licensing authority before a draw can run. ' +
          'Set csprng | external_certified | manual_physical_draw once decided.',
      );
    default:
      throw new Error(`Unknown RANDOMNESS_SOURCE "${value}".`);
  }
}

function select<T>(
  value: string | undefined,
  varName: string,
  gapId: string,
  options: Record<string, () => T>,
): T {
  const chosen = value ?? 'sandbox';
  const factory = options[chosen];
  if (factory) return factory();
  throw new Error(
    `${varName}="${chosen}" has no adapter. ${gapId} is unresolved, so only "sandbox" exists today. ` +
      `Implement the live adapter in packages/adapters-live and make it pass the shared contract suite.`,
  );
}

function readSecret(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
}
