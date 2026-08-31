/**
 * Payload encryption codec (TG-11, T-9.5).
 *
 * Temporal persists workflow inputs, signal arguments, and activity arguments in
 * its own datastore. Without this, any personal data that reaches a payload sits
 * in that store under ITS retention and access controls rather than the
 * application's — which NFR-6 forbids.
 *
 * There are two mitigations and this project uses both. Identifier-only payload
 * discipline is the primary one and is enforced by lint and by the guard in
 * pii-guard.ts. This codec is the secondary one: defence in depth for the day
 * somebody adds a field that should not have been there.
 *
 * It cannot sensibly be retrofitted — history written in plaintext stays
 * plaintext unless it is re-encrypted or discarded — which is why it ships in
 * Phase 1 rather than "when there is time".
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Payload, PayloadCodec } from '@temporalio/common';
import { METADATA_ENCODING_KEY } from '@temporalio/common';
import type { KeyProvider } from './key-provider.js';

const ENCODING = 'binary/encrypted';
const CIPHER = 'aes-256-gcm';
const IV_BYTES = 12;   // 96-bit nonce, the GCM standard
const TAG_BYTES = 16;

const METADATA_ENCRYPTION_KEY_ID = 'encryption-key-id';

/**
 * AES-256-GCM. Authenticated encryption, so a tampered payload fails to decrypt
 * rather than decrypting to something plausible — which matters when the payload
 * is an instruction to pay a prize.
 */
export class EncryptionCodec implements PayloadCodec {
  constructor(private readonly keys: KeyProvider) {}

  async encode(payloads: Payload[]): Promise<Payload[]> {
    return Promise.all(payloads.map((p) => this.encodeOne(p)));
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return Promise.all(payloads.map((p) => this.decodeOne(p)));
  }

  private async encodeOne(payload: Payload): Promise<Payload> {
    const { keyId, key } = await this.keys.activeKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(CIPHER, key, iv);

    // Real wire payloads carry metadata/data as plain Uint8Array, not Node's
    // Buffer subclass — JSON.stringify has no toJSON for a bare Uint8Array, so it
    // serialises as an index-keyed object ({"0":1,"1":2,...}) with no `.length`,
    // which Buffer.from() cannot reconstruct on the way back out. Base64-encode
    // explicitly so decodeOne's `Buffer.from(v, 'base64')` always has a real string.
    const metadataB64 = payload.metadata
      ? Object.fromEntries(
          Object.entries(payload.metadata).map(([k, v]) => [k, Buffer.from(v).toString('base64')]),
        )
      : null;
    const dataB64 = payload.data ? Buffer.from(payload.data).toString('base64') : null;

    const serialised = Buffer.from(JSON.stringify({ metadata: metadataB64, data: dataB64 }), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(serialised), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      metadata: {
        [METADATA_ENCODING_KEY]: Buffer.from(ENCODING, 'utf8'),
        [METADATA_ENCRYPTION_KEY_ID]: Buffer.from(keyId, 'utf8'),
      },
      data: Buffer.concat([iv, tag, ciphertext]),
    };
  }

  private async decodeOne(payload: Payload): Promise<Payload> {
    const encoding = payload.metadata?.[METADATA_ENCODING_KEY];
    if (!encoding || Buffer.from(encoding).toString('utf8') !== ENCODING) {
      // Not ours — plaintext written before the codec, or a Temporal-internal
      // payload. Pass it through rather than failing the whole history.
      return payload;
    }

    const keyIdBytes = payload.metadata?.[METADATA_ENCRYPTION_KEY_ID];
    if (!keyIdBytes) throw new Error('Encrypted payload carries no key id; cannot decrypt.');
    const keyId = Buffer.from(keyIdBytes).toString('utf8');

    const key = await this.keys.keyById(keyId);
    if (!key) {
      throw new Error(
        `Payload was encrypted with key "${keyId}", which this process cannot load. ` +
          `Retired keys must remain available for decryption — see TG-11 key custody.`,
      );
    }

    const blob = Buffer.from(payload.data ?? new Uint8Array());
    if (blob.length < IV_BYTES + TAG_BYTES) throw new Error('Encrypted payload is truncated.');

    const iv = blob.subarray(0, IV_BYTES);
    const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv(CIPHER, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    const { metadata, data } = JSON.parse(plaintext.toString('utf8')) as {
      metadata: Record<string, string> | null;
      data: string | null;
    };

    return {
      metadata: metadata
        ? Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, Buffer.from(v, 'base64')]))
        : null,
      data: data ? Buffer.from(data, 'base64') : null,
    };
  }
}
