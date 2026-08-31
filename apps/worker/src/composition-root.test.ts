import { describe, expect, it } from 'vitest';
import { buildProviderRegistry } from './composition-root.js';
import { describeRegistry } from '@qosfc/ports';

const base = { RANDOMNESS_SOURCE: 'csprng', SANDBOX_PROVIDERS_URL: 'http://localhost:9090' };

describe('provider selection', () => {
  it('defaults every external system to the sandbox in development', () => {
    const registry = buildProviderRegistry({ ...base, NODE_ENV: 'development' });
    const sandboxed = describeRegistry(registry).filter((d) => d.isSandbox).map((d) => d.port);
    expect(sandboxed).toEqual(['paymentGateway', 'bacsBureau', 'bankFeed', 'notifier', 'printHandoff']);
  });

  it('REFUSES to start in production with sandbox providers', () => {
    expect(() => buildProviderRegistry({ ...base, NODE_ENV: 'production' })).toThrow(
      /Refusing to start in production with sandbox providers/,
    );
  });

  it('names the gap when an adapter does not exist yet', () => {
    expect(() => buildProviderRegistry({ ...base, PAYMENT_GATEWAY: 'opayo' })).toThrow(/GAP-09 is unresolved/);
    expect(() => buildProviderRegistry({ ...base, BACS_BUREAU: 'gocardless' })).toThrow(/GAP-10 is unresolved/);
    expect(() => buildProviderRegistry({ ...base, BANK_FEED: 'open_banking' })).toThrow(/GAP-33 is unresolved/);
  });

  it('GAP-33: builds the CSV bank feed once selected — CSV, not Open Banking, was confirmed first', () => {
    const registry = buildProviderRegistry({ ...base, NODE_ENV: 'development', BANK_FEED: 'csv' });
    expect(registry.bankFeed.providerName).toBe('live:csv-upload');
  });
});

describe('GAP-21 — the draw cannot run on an unapproved entropy source', () => {
  it('refuses to build a randomness source when unset', () => {
    expect(() => buildProviderRegistry({ SANDBOX_PROVIDERS_URL: 'http://x' })).toThrow(/GAP-21/);
    expect(() => buildProviderRegistry({ ...base, RANDOMNESS_SOURCE: 'unset' })).toThrow(/licensing authority/);
  });

  it('builds the CSPRNG source once explicitly selected', () => {
    expect(buildProviderRegistry({ ...base, NODE_ENV: 'development' }).randomness.kind).toBe('csprng');
  });

  it('rejects an unknown source rather than falling back', () => {
    expect(() => buildProviderRegistry({ ...base, RANDOMNESS_SOURCE: 'rand()' })).toThrow(/Unknown RANDOMNESS_SOURCE/);
  });
});
