import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('random.org (resolved as the chosen source) still refuses without an API key file', () => {
    expect(() =>
      buildProviderRegistry({ ...base, NODE_ENV: 'development', RANDOMNESS_SOURCE: 'external_certified' }),
    ).toThrow(/RANDOM_ORG_API_KEY_FILE/);
  });

  it('builds the random.org source once an API key file is supplied', () => {
    const apiKeyFile = join(mkdtempSync(join(tmpdir(), 'random-org-')), 'api-key');
    writeFileSync(apiKeyFile, 'test-key');
    const registry = buildProviderRegistry({
      ...base,
      NODE_ENV: 'development',
      RANDOMNESS_SOURCE: 'external_certified',
      RANDOM_ORG_API_KEY_FILE: apiKeyFile,
    });
    expect(registry.randomness.kind).toBe('external_certified');
  });
});

describe('GAP-10 / GAP-33 — assumed routes, left open to change', () => {
  it('defaults the Bacs route to own_sun', () => {
    const registry = buildProviderRegistry({ ...base, NODE_ENV: 'development' });
    expect(registry.bacsBureau.providerName).toBe('sandbox:bacs:own_sun');
  });

  it('honours an explicit BACS_ROUTE override', () => {
    const registry = buildProviderRegistry({ ...base, NODE_ENV: 'development', BACS_ROUTE: 'bureau' });
    expect(registry.bacsBureau.providerName).toBe('sandbox:bacs:bureau');
  });

  it('defaults the bank feed source to csv', () => {
    const registry = buildProviderRegistry({ ...base, NODE_ENV: 'development' });
    expect((registry.bankFeed as { source: string }).source).toBe('csv');
  });
});
