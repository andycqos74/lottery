/**
 * Builds the Elavon gateway from the environment — shared by the member
 * portal and the workers so `PAYMENT_GATEWAY=elavon` means the same thing in
 * both. The secret key only ever comes from a file (deploy/secrets/), never
 * an environment variable or the repository.
 */
import { readFileSync } from 'node:fs';
import type { Pool } from '@qosfc/db';
import { createEpgClient, EPG_API_BASE_URLS, type EpgEnvironment, type EpgWebhookConfig } from './epg.js';
import { ElavonPaymentGateway, PgElavonSessionStore } from './elavon-gateway.js';

export interface ElavonEnv {
  /** "sandbox" (default) or "production". */
  readonly ELAVON_ENVIRONMENT?: string | undefined;
  /** Only if Elavon issued a host other than the documented one for the environment. */
  readonly ELAVON_API_BASE_URL?: string | undefined;
  /** The merchant alias — EPG's API username. */
  readonly ELAVON_MERCHANT_ALIAS?: string | undefined;
  /** File holding the secret API key (`sk_…`). */
  readonly ELAVON_SECRET_KEY_FILE?: string | undefined;
  /** Optional file holding webhook auth as JSON: {"username","password","signerId","sharedSecret"}. */
  readonly ELAVON_WEBHOOK_FILE?: string | undefined;
}

function readFile(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

export function buildElavonPaymentGateway(pool: Pool, env: ElavonEnv): ElavonPaymentGateway {
  const environment = (env.ELAVON_ENVIRONMENT || 'sandbox').toLowerCase();
  if (!(environment in EPG_API_BASE_URLS)) {
    throw new Error(`ELAVON_ENVIRONMENT="${env.ELAVON_ENVIRONMENT}" is not "sandbox" or "production".`);
  }
  const apiBaseUrl = (env.ELAVON_API_BASE_URL || EPG_API_BASE_URLS[environment as EpgEnvironment]).replace(/\/+$/, '');
  if (!/^https:\/\//.test(apiBaseUrl)) throw new Error('ELAVON_API_BASE_URL must be an https:// URL.');

  const merchantAlias = env.ELAVON_MERCHANT_ALIAS?.trim();
  const secretKey = readFile(env.ELAVON_SECRET_KEY_FILE);
  if (!merchantAlias || !secretKey) {
    throw new Error('PAYMENT_GATEWAY=elavon needs ELAVON_MERCHANT_ALIAS and a readable ELAVON_SECRET_KEY_FILE.');
  }

  let webhook: EpgWebhookConfig = {};
  const webhookRaw = readFile(env.ELAVON_WEBHOOK_FILE);
  if (webhookRaw) {
    try {
      webhook = JSON.parse(webhookRaw) as EpgWebhookConfig;
    } catch {
      throw new Error('ELAVON_WEBHOOK_FILE is not valid JSON.');
    }
  }

  return new ElavonPaymentGateway({
    epg: createEpgClient({ apiBaseUrl, merchantAlias, secretKey }),
    store: new PgElavonSessionStore(pool),
    webhook,
  });
}
