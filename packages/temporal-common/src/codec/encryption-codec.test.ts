import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { METADATA_ENCODING_KEY } from '@temporalio/common';
import { EncryptionCodec } from './encryption-codec.js';
import { InMemoryKeyProvider } from './key-provider.js';

const keyA = randomBytes(32);
const keyB = randomBytes(32);
const providerA = new InMemoryKeyProvider(new Map([['k1', keyA]]), 'k1');
const bothKeys = new InMemoryKeyProvider(
  new Map([
    ['k1', keyA],
    ['k2', keyB],
  ]),
  'k2',
);

const payloadOf = (obj: unknown) => ({
  metadata: { [METADATA_ENCODING_KEY]: Buffer.from('json/plain', 'utf8') },
  data: Buffer.from(JSON.stringify(obj), 'utf8'),
});

describe('TG-11 — payload encryption', () => {
  it('round-trips a payload', async () => {
    const codec = new EncryptionCodec(providerA);
    const original = payloadOf({ memberId: 'a3f1', drawId: 'b7c2' });
    const [decoded] = await codec.decode(await codec.encode([original]));
    expect(Buffer.from(decoded!.data!).toString('utf8')).toBe(Buffer.from(original.data).toString('utf8'));
  });

  it('leaves nothing readable at rest — the whole point of the exercise', async () => {
    const codec = new EncryptionCodec(providerA);
    const [encrypted] = await codec.encode([payloadOf({ note: 'SENSITIVE-MARKER-STRING' })]);
    const onDisk = Buffer.from(encrypted!.data!).toString('binary');
    expect(onDisk).not.toContain('SENSITIVE-MARKER-STRING');
    expect(onDisk).not.toContain('note');
    expect(Buffer.from(encrypted!.metadata![METADATA_ENCODING_KEY]!).toString()).toBe('binary/encrypted');
  });

  it('produces different ciphertext each time (fresh nonce per payload)', async () => {
    const codec = new EncryptionCodec(providerA);
    const same = payloadOf({ memberId: 'a3f1' });
    const [first] = await codec.encode([same]);
    const [second] = await codec.encode([same]);
    expect(Buffer.from(first!.data!).equals(Buffer.from(second!.data!))).toBe(false);
  });

  it('refuses a tampered payload rather than decrypting it to something plausible', async () => {
    const codec = new EncryptionCodec(providerA);
    const [encrypted] = await codec.encode([payloadOf({ amountPence: '200' })]);
    const tampered = Buffer.from(encrypted!.data!);
    tampered[tampered.length - 1] ^= 0xff;
    await expect(codec.decode([{ ...encrypted!, data: tampered }])).rejects.toThrow();
  });

  it('decrypts payloads written under a retired key after rotation', async () => {
    const oldCodec = new EncryptionCodec(providerA);      // active key k1
    const [written] = await oldCodec.encode([payloadOf({ prizeId: 'p1' })]);

    const newCodec = new EncryptionCodec(bothKeys);       // active key now k2
    const [decoded] = await newCodec.decode([written!]);
    expect(JSON.parse(Buffer.from(decoded!.data!).toString('utf8'))).toEqual({ prizeId: 'p1' });
  });

  it('says so clearly when the key is gone, rather than failing obscurely', async () => {
    const [written] = await new EncryptionCodec(providerA).encode([payloadOf({ x: 1 })]);
    const noKeys = new EncryptionCodec(new InMemoryKeyProvider(new Map([['k9', keyB]]), 'k9'));
    await expect(noKeys.decode([written!])).rejects.toThrow(/key custody/);
  });

  it('passes through plaintext written before the codec existed', async () => {
    const codec = new EncryptionCodec(providerA);
    const plain = payloadOf({ legacy: true });
    const [decoded] = await codec.decode([plain]);
    expect(decoded).toBe(plain);
  });

  it('round-trips a real wire payload, whose metadata/data are plain Uint8Array — not Buffer', async () => {
    // Buffer.toJSON() special-cases JSON.stringify (-> {type:'Buffer',data:[...]}),
    // masking a bug that only shows up against the bare Uint8Array the Temporal
    // core bridge actually hands the codec. Regression for that gap.
    const codec = new EncryptionCodec(providerA);
    const original = {
      metadata: { [METADATA_ENCODING_KEY]: new Uint8Array(Buffer.from('json/plain', 'utf8')) },
      data: new Uint8Array(Buffer.from(JSON.stringify({ memberId: 'a3f1' }), 'utf8')),
    };
    expect(original.data).not.toBeInstanceOf(Buffer);
    const [decoded] = await codec.decode(await codec.encode([original]));
    expect(Buffer.from(decoded!.data!).toString('utf8')).toBe(Buffer.from(original.data).toString('utf8'));
  });
});
