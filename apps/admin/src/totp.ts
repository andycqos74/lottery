/**
 * TOTP (RFC 6238), built on HOTP (RFC 4226).
 *
 * T-9.3: individual named accounts with MFA. No dependency needed — HMAC-SHA1
 * time-stepped codes are ~15 lines over node:crypto, and pulling in a whole
 * authenticator library for that is not worth the extra supply-chain surface
 * on an admin login path.
 */
import { createHmac, randomBytes } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** `otpauth://` URI for a QR code — scan once during account creation. */
export function totpUri(secret: string, accountEmail: string, issuer = 'QOSFC Lottery'): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function currentTotp(secret: string, at: number = Date.now()): string {
  return hotp(secret, Math.floor(at / 1000 / STEP_SECONDS));
}

/**
 * Accepts the current step and one step either side, so a slightly slow phone
 * clock or the second it takes to type six digits doesn't fail a real code.
 */
export function verifyTotp(secret: string, token: string, at: number = Date.now()): boolean {
  const normalised = token.trim();
  if (!/^\d{6}$/.test(normalised)) return false;
  const counter = Math.floor(at / 1000 / STEP_SECONDS);
  for (const drift of [0, -1, 1]) {
    if (timingSafeEqual(hotp(secret, counter + drift), normalised)) return true;
  }
  return false;
}

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));

  const hmac = createHmac('sha1', key).update(counterBuf).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const b0 = hmac[offset] ?? 0;
  const b1 = hmac[offset + 1] ?? 0;
  const b2 = hmac[offset + 2] ?? 0;
  const b3 = hmac[offset + 3] ?? 0;
  const binary = ((b0 & 0x7f) << 24) | (b1 << 16) | (b2 << 8) | b3;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
