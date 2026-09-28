import { describe, expect, it } from 'vitest';
import { buildProviderRegistry } from './composition-root.js';
import { describeRegistry } from '@qosfc/ports';
import type { Pool } from '@qosfc/db';

const base = { RANDOMNESS_SOURCE: 'csprng', SANDBOX_PROVIDERS_URL: 'http://localhost:9090' };
// None of these tests select NOTIFIER=socketlabs (the only branch that touches
// the pool), so a real connection is never needed here.
const pool = {} as Pool;

describe('provider selection', () => {
  it('defaults every external system to the sandbox in development', () => {
    const registry = buildProviderRegistry({ ...base, NODE_ENV: 'development' }, pool);
    const sandboxed = describeRegistry(registry).filter((d) => d.isSandbox).map((d) => d.port);
    expect(sandboxed).toEqual(['paymentGateway', 'bacsBureau', 'bankFeed', 'notifier', 'printHandoff']);
  });

  it('REFUSES to start in production with sandbox providers', () => {
    expect(() => buildProviderRegistry({ ...base, NODE_ENV: 'production' }, pool)).toThrow(
      /Refusing to start in production with sandbox providers/,
    );
  });

  it('names the gap when an adapter does not exist yet', () => {
    expect(() => buildProviderRegistry({ ...base, PAYMENT_GATEWAY: 'opayo' }, pool)).toThrow(/GAP-09/);
    expect(() => buildProviderRegistry({ ...base, BACS_BUREAU: 'gocardless' }, pool)).toThrow(/GAP-10/);
    expect(() => buildProviderRegistry({ ...base, BANK_FEED: 'open_banking' }, pool)).toThrow(/GAP-33/);
  });

  it('GAP-09/10: the assumed shapes exist but refuse to run — no provider is confirmed yet', async () => {
    const registry = buildProviderRegistry({ ...base, PAYMENT_GATEWAY: 'card_portal', BACS_BUREAU: 'own_sun' }, pool);
    expect(registry.paymentGateway.providerName).toBe('live:card-portal');
    await expect(registry.paymentGateway.getPaymentStatus('s1')).rejects.toThrow(/GAP-09/);
    expect(registry.bacsBureau.providerName).toBe('live:bacs-own-sun');
    await expect(registry.bacsBureau.getMandate('m1')).rejects.toThrow(/GAP-10/);
  });

  it('GAP-33, resolved: csv is a real, working adapter', () => {
    const registry = buildProviderRegistry({ ...base, BANK_FEED: 'csv', BANK_CSV_UPLOADS_DIR: '/tmp' }, pool);
    expect(registry.bankFeed.providerName).toBe('live:csv-upload');
    expect(registry.bankFeed.source).toBe('csv');
  });

  it('GAP-33: builds the CSV bank feed once selected — CSV, not Open Banking, was confirmed first', () => {
    const registry = buildProviderRegistry({ ...base, NODE_ENV: 'development', BANK_FEED: 'csv' }, pool);
    expect(registry.bankFeed.providerName).toBe('live:csv-upload');
  });
});

describe('GAP-21 — the draw cannot run on an unapproved entropy source', () => {
  it('refuses to build a randomness source when unset', () => {
    expect(() => buildProviderRegistry({ SANDBOX_PROVIDERS_URL: 'http://x' }, pool)).toThrow(/GAP-21/);
    expect(() => buildProviderRegistry({ ...base, RANDOMNESS_SOURCE: 'unset' }, pool)).toThrow(/licensing authority/);
  });

  it('builds the CSPRNG source once explicitly selected', () => {
    expect(buildProviderRegistry({ ...base, NODE_ENV: 'development' }, pool).randomness.kind).toBe('csprng');
  });

  it('rejects an unknown source rather than falling back', () => {
    expect(() => buildProviderRegistry({ ...base, RANDOMNESS_SOURCE: 'rand()' }, pool)).toThrow(/Unknown RANDOMNESS_SOURCE/);
  });
});
