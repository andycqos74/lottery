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
import {
  buildElavonPaymentGateway,
  CsvBankFeed,
  OwnSunBacsBureau,
  RandomOrgRandomnessSource,
  SocketLabsNotifier,
  ThirdPartyCardPortalGateway,
  type ElavonEnv,
} from '@qosfc/adapters-live';
import type { Pool } from '@qosfc/db';
import {
  assertNoSandboxInProduction,
  type BacsBureau,
  type BankFeed,
  type Notifier,
  type PaymentGateway,
  type ProviderRegistry,
  type RandomnessSource,
} from '@qosfc/ports';

export interface ProviderEnv extends ElavonEnv {
  readonly PAYMENT_GATEWAY?: string | undefined;
  readonly BACS_BUREAU?: string | undefined;
  readonly BANK_FEED?: string | undefined;
  readonly BANK_FEED_CSV_DIR?: string | undefined;
  readonly NOTIFIER?: string | undefined;
  readonly SOCKETLABS_SERVER_ID_FILE?: string | undefined;
  readonly SOCKETLABS_API_KEY_FILE?: string | undefined;
  readonly SOCKETLABS_FROM_EMAIL?: string | undefined;
  readonly SOCKETLABS_FROM_NAME?: string | undefined;
  readonly RANDOMNESS_SOURCE?: string | undefined;
  readonly SANDBOX_PROVIDERS_URL?: string | undefined;
  readonly SANDBOX_WEBHOOK_SECRET_FILE?: string | undefined;
  readonly NODE_ENV?: string | undefined;
}

export function buildProviderRegistry(env: ProviderEnv, pool: Pool): ProviderRegistry {
  const sandbox = {
    baseUrl: env.SANDBOX_PROVIDERS_URL ?? 'http://sandbox-providers:9090',
    webhookSecret: readSecret(env.SANDBOX_WEBHOOK_SECRET_FILE) ?? 'sandbox-development-secret',
  };

  const registry: ProviderRegistry = {
    // GAP-09: Elavon Payment Gateway (GitHub #12) is the live card provider.
    // card_portal remains the refusing placeholder shape for any other one.
    paymentGateway: select<PaymentGateway>(env.PAYMENT_GATEWAY, 'PAYMENT_GATEWAY', 'GAP-09', {
      sandbox: () => new SandboxPaymentGateway(sandbox),
      elavon: () => buildElavonPaymentGateway(pool, env),
      card_portal: () => new ThirdPartyCardPortalGateway(),
    }),
    // GAP-10 remains unconfirmed — own_sun is the client's working assumption
    // (submit under the society's own Bacs Service User Number rather than a
    // bureau), shape-only until Bacstel-IP access exists to build against.
    bacsBureau: select<BacsBureau>(env.BACS_BUREAU, 'BACS_BUREAU', 'GAP-10', {
      sandbox: () => new SandboxBacsBureau(sandbox),
      own_sun: () => new OwnSunBacsBureau(),
    }),
    // GAP-33, resolved for now: manual CSV upload. Open Banking and OCR remain
    // options for later — the port already carries the confidence signal that
    // makes swapping to either one a new adapter, not a rewrite.
    bankFeed: select<BankFeed>(env.BANK_FEED, 'BANK_FEED', 'GAP-33', {
      sandbox: () => new SandboxBankFeed(sandbox),
      csv: () => new CsvBankFeed(env.BANK_FEED_CSV_DIR ?? '/data/bank-statements'),
    }),
    // GAP-30, resolved for email: SocketLabs (client decision, 2026-09-24).
    notifier: select<Notifier>(env.NOTIFIER, 'NOTIFIER', 'GAP-30', {
      sandbox: () => new SandboxNotifier(sandbox),
      socketlabs: () => buildSocketLabsNotifier(pool, env),
    }),
    printHandoff: new SandboxPrintHandoff(sandbox),
    randomness: buildRandomnessSource(env.RANDOMNESS_SOURCE),
  };

  // Belt and braces against the mistake that would look exactly like everything
  // working: dummy providers still wired in on the day real money moves.
  assertNoSandboxInProduction(registry, env.NODE_ENV);
  return registry;
}

/**
 * GAP-21, resolved (client decision, see docs/gap-register.md): draw from
 * RANDOM.ORG's HTTP client interface. `unset` remains the shipped default —
 * this still REFUSES to build a source until an operator sets
 * `RANDOMNESS_SOURCE=random_org` deliberately, because whether independent
 * assurance is ALSO required for the licensing authority's sign-off is a
 * residual question the source decision did not cover, and numbers nobody has
 * approved must never be generated for a real draw.
 */
function buildRandomnessSource(value: string | undefined): RandomnessSource {
  switch (value) {
    case 'csprng':
      return new CsprngRandomnessSource();
    case 'random_org':
      return new RandomOrgRandomnessSource();
    case 'external_certified':
      return new ExternalCertifiedRandomnessSource();
    case 'manual_physical_draw':
      return new ManualPhysicalDrawSource();
    case undefined:
    case '':
    case 'unset':
      throw new Error(
        'GAP-21: RANDOMNESS_SOURCE is unset. The source itself is decided (random_org) but nobody has ' +
          'set the environment variable, and whether independent assurance is also required for the ' +
          'licensing authority has not been confirmed. Set random_org (or csprng | external_certified | ' +
          'manual_physical_draw) once ready.',
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
    `${varName}="${chosen}" has no adapter (${gapId} — see docs/gap-register.md). Available: ` +
      `${Object.keys(options).join(', ')}. A new live adapter belongs in packages/adapters-live and must pass ` +
      `the shared contract suite before it is wired in here.`,
  );
}

function buildSocketLabsNotifier(pool: Pool, env: ProviderEnv): SocketLabsNotifier {
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

function readSecret(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
}
