/**
 * Encryption key custody (TG-11).
 *
 * Keys are behind an interface so the storage decision can change without
 * touching the codec. Today they come from Docker secrets on the VPS; a hosted
 * KMS is a new implementation of this interface, not a rewrite.
 *
 * The residual TG-11 question this does NOT answer: who holds the recovery copy,
 * and where. Losing the key makes workflow history permanently unreadable during
 * exactly the incident when someone needs to read it. That is a custody decision,
 * not a code one — see docs/gap-register.md.
 */
import { readFile } from 'node:fs/promises';

/** A key and the id it is published under, so keys can rotate without a flag day. */
export interface VersionedKey {
  readonly keyId: string;
  readonly key: Buffer;
}

export interface KeyProvider {
  /** The key new payloads are encrypted with. */
  activeKey(): Promise<VersionedKey>;
  /** Any key an existing payload might have been encrypted with, by id. */
  keyById(keyId: string): Promise<Buffer | undefined>;
}

const AES_256_KEY_BYTES = 32;

/**
 * Reads keys from files — Docker secrets in production, a fixture in dev.
 *
 * Format: one key per file, base64, named `<keyId>.key`. The active key id is
 * given explicitly so rotation is a deliberate configuration change: add the new
 * file, deploy, then point ACTIVE at it. Old keys stay readable for decryption.
 */
export class FileKeyProvider implements KeyProvider {
  private readonly cache = new Map<string, Buffer>();

  constructor(
    private readonly directory: string,
    private readonly activeKeyId: string,
  ) {}

  async activeKey(): Promise<VersionedKey> {
    const key = await this.keyById(this.activeKeyId);
    if (!key) {
      throw new Error(
        `Active encryption key "${this.activeKeyId}" not found in ${this.directory}. ` +
          `Refusing to start: without it, workflow payloads would be written in plaintext (TG-11).`,
      );
    }
    return { keyId: this.activeKeyId, key };
  }

  async keyById(keyId: string): Promise<Buffer | undefined> {
    const cached = this.cache.get(keyId);
    if (cached) return cached;

    // Key ids appear in payload metadata, which is attacker-influenceable in
    // principle; refuse anything that could escape the key directory.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) {
      throw new Error(`Invalid key id "${keyId}".`);
    }

    let raw: string;
    try {
      raw = await readFile(`${this.directory}/${keyId}.key`, 'utf8');
    } catch {
      return undefined;
    }

    const key = Buffer.from(raw.trim(), 'base64');
    if (key.length !== AES_256_KEY_BYTES) {
      throw new Error(
        `Key "${keyId}" is ${key.length} bytes; AES-256-GCM requires ${AES_256_KEY_BYTES}. ` +
          `Generate one with: openssl rand -base64 32`,
      );
    }
    this.cache.set(keyId, key);
    return key;
  }
}

/** In-memory provider for tests. Never usable in production — there is no file to leak. */
export class InMemoryKeyProvider implements KeyProvider {
  constructor(private readonly keys: ReadonlyMap<string, Buffer>, private readonly activeKeyId: string) {}

  async activeKey(): Promise<VersionedKey> {
    const key = this.keys.get(this.activeKeyId);
    if (!key) throw new Error(`No key "${this.activeKeyId}".`);
    return { keyId: this.activeKeyId, key };
  }

  async keyById(keyId: string): Promise<Buffer | undefined> {
    return this.keys.get(keyId);
  }
}
