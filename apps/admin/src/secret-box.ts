/**
 * AES-256-GCM for one thing only: `app_user.totp_secret_enc` at rest.
 *
 * Deliberately separate from `packages/temporal-common`'s codec — that key
 * protects Temporal workflow history (TG-11) and rotates on its own schedule;
 * conflating the two would mean a codec key rotation silently re-keys (or
 * breaks) admin MFA secrets, or vice versa.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const CIPHER = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function encryptSecret(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(blob: Buffer, key: Buffer): string {
  if (blob.length < IV_BYTES + TAG_BYTES) throw new Error('Encrypted secret is truncated.');
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(CIPHER, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
