/**
 * T-9.3 — admin MFA. The TOTP implementation is hand-rolled (see totp.ts for
 * why), so it is checked against the RFC 6238 Appendix B reference vectors
 * rather than against itself.
 */
import { describe, expect, it } from 'vitest';
import { currentTotp, generateTotpSecret, totpUri, verifyTotp } from './totp.js';

// RFC 6238 Appendix B, SHA-1 seed: ASCII "12345678901234567890", base32-encoded.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
// The RFC prints 8-digit codes; a 6-digit code is the same value mod 10^6.
const RFC_VECTORS: ReadonlyArray<readonly [seconds: number, code: string]> = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

describe('TOTP (RFC 6238)', () => {
  it.each(RFC_VECTORS)('produces the reference code at T=%is', (seconds, code) => {
    expect(currentTotp(RFC_SECRET, seconds * 1000)).toBe(code);
    expect(verifyTotp(RFC_SECRET, code, seconds * 1000)).toBe(true);
  });

  it('keeps leading zeros (a code is a string, not a number)', () => {
    expect(currentTotp(RFC_SECRET, 1234567890 * 1000)).toBe('005924');
    expect(verifyTotp(RFC_SECRET, '5924', 1234567890 * 1000)).toBe(false);
  });

  it('accepts exactly one 30s step of clock drift either side, and no more', () => {
    const at = 1_700_000_000_000;
    const step = 30_000;
    const code = currentTotp(RFC_SECRET, at);
    expect(verifyTotp(RFC_SECRET, code, at - step)).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, at + step)).toBe(true);
    // Codes two steps away must fail — unless the HOTP values happen to
    // collide, which for this fixed instant they do not.
    expect(verifyTotp(RFC_SECRET, code, at - 2 * step)).toBe(false);
    expect(verifyTotp(RFC_SECRET, code, at + 2 * step)).toBe(false);
  });

  it('tolerates surrounding whitespace from a pasted code', () => {
    const at = 1_700_000_000_000;
    expect(verifyTotp(RFC_SECRET, `  ${currentTotp(RFC_SECRET, at)}\n`, at)).toBe(true);
  });

  it.each(['', '12345', '1234567', 'abcdef', '12 345', '１２３４５６', '-12345', '123.45'])('rejects malformed code %j', (bad) => {
    expect(verifyTotp(RFC_SECRET, bad, 1_700_000_000_000)).toBe(false);
  });

  it('rejects the right code for a different secret', () => {
    const at = 1_700_000_000_000;
    const other = generateTotpSecret();
    expect(verifyTotp(other, currentTotp(RFC_SECRET, at), at)).toBe(false);
  });

  it('generates 160-bit secrets (32 base32 chars), unique per call', () => {
    const secrets = new Set(Array.from({ length: 50 }, generateTotpSecret));
    expect(secrets.size).toBe(50);
    for (const s of secrets) expect(s).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('round-trips a generated secret through base32 (encode → decode → same HMAC key)', () => {
    const secret = generateTotpSecret();
    const at = Date.now();
    expect(verifyTotp(secret, currentTotp(secret, at), at)).toBe(true);
  });

  it('builds an otpauth:// URI an authenticator app can scan', () => {
    const uri = new URL(totpUri('ABCDEFGH', 'jo+admin@qosfc.example'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/QOSFC Lottery:jo+admin@qosfc.example');
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: 'ABCDEFGH',
      issuer: 'QOSFC Lottery',
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    });
  });
});
