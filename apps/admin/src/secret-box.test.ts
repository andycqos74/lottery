/**
 * `app_user.totp_secret_enc` at rest — AES-256-GCM. The properties that matter:
 * a fresh IV every time, and any tampering or wrong key is an error, never a
 * silently wrong plaintext (which would surface as "MFA code always fails").
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './secret-box.js';

const key = randomBytes(32);

describe('secret-box (AES-256-GCM for TOTP secrets)', () => {
  it('round-trips', () => {
    expect(decryptSecret(encryptSecret('JBSWY3DPEHPK3PXP', key), key)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('round-trips the empty string and non-ASCII text', () => {
    expect(decryptSecret(encryptSecret('', key), key)).toBe('');
    expect(decryptSecret(encryptSecret('£ünïcødé', key), key)).toBe('£ünïcødé');
  });

  it('uses a fresh IV per encryption, so equal secrets do not produce equal blobs', () => {
    const a = encryptSecret('same', key);
    const b = encryptSecret('same', key);
    expect(a.equals(b)).toBe(false);
    expect(a.subarray(0, 12).equals(b.subarray(0, 12))).toBe(false);
  });

  it('lays out iv(12) ‖ tag(16) ‖ ciphertext', () => {
    expect(encryptSecret('abcd', key).length).toBe(12 + 16 + 4);
  });

  it('rejects the wrong key', () => {
    expect(() => decryptSecret(encryptSecret('secret', key), randomBytes(32))).toThrow();
  });

  it.each([
    ['iv', 0],
    ['tag', 12],
    ['ciphertext', 28],
  ])('rejects a flipped bit in the %s', (_part, offset) => {
    const blob = encryptSecret('secret', key);
    blob[offset] = blob[offset]! ^ 0x01;
    expect(() => decryptSecret(blob, key)).toThrow();
  });

  it('rejects a truncated blob with a clear message', () => {
    expect(() => decryptSecret(Buffer.alloc(27), key)).toThrow(/truncated/);
  });

  it('refuses a key that is not 256 bits', () => {
    expect(() => encryptSecret('secret', randomBytes(16))).toThrow();
  });
});
