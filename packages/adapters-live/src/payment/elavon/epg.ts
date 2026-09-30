/**
 * Minimal client for the Elavon Payment Gateway (EPG) REST API — GitHub #12.
 * https://developer.elavon.com/products/elavon-payment-gateway/v1/api-reference
 *
 * Ported from the client's own Wix EPG integration (github.com/andycqos74/elavon,
 * `src/backend/elavon/epg.js`, `money.js`, `webhook.js`), which is the
 * reference for every request shape here. Auth is HTTP Basic with the
 * merchant alias and secret key; `fetch` is injected so tests never reach
 * the network.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** Hosts from the EPG API reference ("servers"). Elavon may issue another — see `apiBaseUrl`. */
export const EPG_API_BASE_URLS = {
  sandbox: 'https://api.sandbox.elavonpayments.com',
  production: 'https://api.eu.convergepay.com',
} as const;

export type EpgEnvironment = keyof typeof EPG_API_BASE_URLS;

export interface EpgFailure {
  readonly code?: string;
  readonly description?: string;
  readonly field?: string;
}

export class EpgError extends Error {
  readonly status: number | undefined;
  readonly failures: readonly EpgFailure[];

  constructor(message: string, opts: { status?: number; failures?: readonly EpgFailure[] } = {}) {
    super(message);
    this.name = 'EpgError';
    this.status = opts.status;
    this.failures = opts.failures ?? [];
  }

  hasFailure(...codes: string[]): boolean {
    return this.failures.some((f) => f.code !== undefined && codes.includes(f.code));
  }
}

/**
 * EPG links resources by URL ("href"). Only our configured host is ever
 * called, so an href — which may come from a webhook body — is reduced to its
 * ID and re-requested from that host.
 */
export function resourceId(ref: string | undefined | null): string {
  if (!ref) return '';
  const id = ref.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() ?? '';
  if (!/^[A-Za-z0-9]{1,256}$/.test(id)) throw new EpgError(`Invalid EPG resource reference: ${ref}`);
  return id;
}

/** Removes null / undefined / empty-string values (recursively) — EPG rejects empty fields. */
export function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || v === null || v === '') continue;
      const c = compact(v);
      if (c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === 0) continue;
      out[k] = c;
    }
    return out;
  }
  return value;
}

// ── Money: the lottery keeps integer pence as strings; EPG wants decimal pounds ──

/** "250" → "2.50". Integer string arithmetic only — never a float (README rule 1). */
export function penceToDecimal(pence: string): string {
  if (!/^\d+$/.test(pence)) throw new Error(`Invalid pence amount: ${pence}`);
  const padded = pence.padStart(3, '0');
  return `${padded.slice(0, -2).replace(/^0+(?=\d)/, '')}.${padded.slice(-2)}`;
}

/** "2.50" → "250". Refuses sub-penny precision rather than rounding it away. */
export function decimalToPence(decimal: string): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(decimal).trim());
  if (!match) throw new Error(`Invalid decimal amount: ${decimal}`);
  const fraction = (match[2] ?? '').padEnd(2, '0');
  if (/[1-9]/.test(fraction.slice(2))) throw new Error(`Amount ${decimal} has more precision than GBP allows`);
  return `${match[1]}${fraction.slice(0, 2)}`.replace(/^0+(?=\d)/, '');
}

// ── Webhook verification ─────────────────────────────────────────────────────

export interface EpgWebhookConfig {
  readonly username?: string | undefined;
  readonly password?: string | undefined;
  readonly signerId?: string | undefined;
  readonly sharedSecret?: string | undefined;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** base64(SHA-512(base64decode(sharedSecret) || body)), per EPG's webhook documentation. */
export function signEpgNotification(body: string, sharedSecret: string): string {
  return createHash('sha512')
    .update(Buffer.concat([Buffer.from(sharedSecret, 'base64'), Buffer.from(body, 'utf8')]))
    .digest('base64');
}

/**
 * Returns null when a notification passes every check that is configured,
 * otherwise a short reason. With nothing configured every notification passes
 * this — which is safe only because the body is never trusted: whoever
 * handles it must re-read the resource from EPG (`getPaymentStatus`).
 */
export function verifyEpgNotification(
  headers: Readonly<Record<string, string | undefined>>,
  body: string,
  config: EpgWebhookConfig,
): string | null {
  const header = (name: string): string => {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return String(value ?? '');
    return '';
  };

  if (config.username || config.password) {
    const expected = `Basic ${Buffer.from(`${config.username ?? ''}:${config.password ?? ''}`, 'utf8').toString('base64')}`;
    const auth = header('authorization').trim();
    if (!auth || !safeEqual(auth, expected)) return 'bad authorization';
  }

  if (config.signerId && config.sharedSecret) {
    const signature = header(`signature-${config.signerId}`).trim();
    if (!signature) return 'missing signature';
    // EPG signs the compact JSON serialisation; accept the raw body as sent too.
    const candidates = [body];
    try {
      candidates.push(JSON.stringify(JSON.parse(body)));
    } catch {
      return 'invalid JSON';
    }
    if (!candidates.some((c) => safeEqual(signEpgNotification(c, config.sharedSecret!), signature))) return 'bad signature';
  }
  return null;
}

// ── HTTP client ─────────────────────────────────────────────────────────────

export interface EpgResource {
  readonly id?: string;
  readonly href?: string;
  readonly [key: string]: unknown;
}

export interface EpgTransaction extends EpgResource {
  readonly type?: string;
  readonly state?: string;
  readonly isAuthorized?: boolean;
  readonly order?: string;
  readonly paymentSession?: string;
  readonly total?: { readonly amount?: string; readonly currencyCode?: string };
  readonly failures?: readonly EpgFailure[];
}

export interface EpgPaymentSession extends EpgResource {
  readonly url?: string;
  readonly transaction?: string;
  readonly expiresAt?: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

export interface EpgClientConfig {
  readonly apiBaseUrl: string;
  readonly merchantAlias: string;
  readonly secretKey: string;
  readonly timeoutMs?: number;
}

function failureMessage(failures: readonly EpgFailure[], status: number): string {
  const specific = failures.filter((f) => f.code !== 'badRequest');
  const list = (specific.length ? specific : failures)
    .map((f) => (f.field ? `${f.field}: ${f.description ?? ''}` : (f.description ?? f.code ?? '')))
    .filter(Boolean);
  return list.length ? list.join('; ') : `EPG request failed with HTTP ${status}`;
}

export function createEpgClient(config: EpgClientConfig, fetchImpl: FetchLike = fetch as unknown as FetchLike) {
  const authorization = `Basic ${Buffer.from(`${config.merchantAlias}:${config.secretKey}`, 'utf8').toString('base64')}`;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json;charset=UTF-8',
      'Accept-Version': '1',
      Authorization: authorization,
    };
    const init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal } = {
      method,
      headers,
      signal: AbortSignal.timeout(config.timeoutMs ?? 20_000),
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(compact(body));
    }

    const res = await fetchImpl(`${config.apiBaseUrl}${path}`, init);
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const failures = data && typeof data === 'object' && Array.isArray((data as { failures?: unknown }).failures)
        ? ((data as { failures: EpgFailure[] }).failures)
        : [];
      throw new EpgError(failureMessage(failures, res.status), { status: res.status, failures });
    }
    return data as T;
  }

  return {
    listMerchants: () => call<unknown>('GET', '/merchants'),
    createOrder: (order: unknown) => call<EpgResource>('POST', '/orders', order),
    createPaymentSession: (session: unknown) => call<EpgPaymentSession>('POST', '/payment-sessions', session),
    getPaymentSession: (ref: string) => call<EpgPaymentSession>('GET', `/payment-sessions/${resourceId(ref)}`),
    getTransaction: (ref: string) => call<EpgTransaction>('GET', `/transactions/${resourceId(ref)}`),
    createTransaction: (transaction: unknown) => call<EpgTransaction>('POST', '/transactions', transaction),
  };
}

export type EpgClient = ReturnType<typeof createEpgClient>;
