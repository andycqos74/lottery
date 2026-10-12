/**
 * Codec server (T-10.11), black-box: the real process, HTTP only.
 *
 * It is a decryption oracle for member data in workflow history. These tests
 * pin that it authenticates every caller (#41), restricts CORS to the Temporal
 * UI origin, and round-trips honestly.
 *
 * Needs no database, so it always runs.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { METADATA_ENCODING_KEY } from '@temporalio/common';
import { EncryptionCodec, FileKeyProvider } from '@qosfc/temporal-common';
import { startServer, type RunningServer } from '../../../tools/test-support/server-process.js';

const UI_ORIGIN = 'https://temporal.qosfc.example';
const TOKEN = randomBytes(32).toString('hex');
const BEARER = { authorization: `Bearer ${TOKEN}` };

interface WirePayload {
  metadata: Record<string, string>;
  data: string;
}

const toWire = (p: { metadata?: Record<string, Uint8Array> | null; data?: Uint8Array | null }): WirePayload => ({
  metadata: Object.fromEntries(Object.entries(p.metadata ?? {}).map(([k, v]) => [k, Buffer.from(v).toString('base64')])),
  data: Buffer.from(p.data ?? new Uint8Array()).toString('base64'),
});

describe('codec server (T-10.11)', () => {
  let server: RunningServer;
  let codec: EncryptionCodec;

  /** Authenticated with the Bearer token unless `headers` says otherwise. */
  async function post(path: string, payloads: WirePayload[], headers: Record<string, string> = {}) {
    const res = await fetch(server.baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...BEARER, ...headers },
      body: JSON.stringify({ payloads }),
    });
    return { status: res.status, headers: res.headers, body: (await res.json()) as { payloads?: WirePayload[] } };
  }

  async function encryptedMarker(): Promise<WirePayload> {
    const [encrypted] = await codec.encode([
      {
        metadata: { [METADATA_ENCODING_KEY]: Buffer.from('json/plain') },
        data: Buffer.from(JSON.stringify({ surname: 'SENSITIVE-MARKER' })),
      },
    ]);
    return toWire(encrypted!);
  }

  const plaintextOf = (p: WirePayload) => Buffer.from(p.data, 'base64').toString('utf8');

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qosfc-codec-e2e-'));
    writeFileSync(join(dir, 'k1.key'), randomBytes(32).toString('base64'));
    codec = new EncryptionCodec(new FileKeyProvider(dir, 'k1'));
    const tokenDir = mkdtempSync(join(tmpdir(), 'qosfc-codec-token-'));
    writeFileSync(join(tokenDir, 'token'), `${TOKEN}\n`);
    server = await startServer('services/codec-server/src/index.ts', {
      ALLOWED_ORIGIN: UI_ORIGIN,
      CODEC_AUTH_TOKEN_FILE: join(tokenDir, 'token'),
      TEMPORAL_CODEC_KEY_DIR: dir,
      TEMPORAL_CODEC_ACTIVE_KEY_ID: 'k1',
    });
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('decodes a payload the workers encrypted, for the Temporal UI origin', async () => {
    const res = await post('/decode', [await encryptedMarker()], { origin: UI_ORIGIN });
    expect(res.status).toBe(200);
    expect(plaintextOf(res.body.payloads![0]!)).toContain('SENSITIVE-MARKER');
    expect(res.headers.get('access-control-allow-origin')).toBe(UI_ORIGIN);
    expect(res.headers.get('vary')).toMatch(/origin/i);
  });

  it('encode → decode round-trips, and encode leaves nothing readable', async () => {
    const plain: WirePayload = {
      metadata: { [METADATA_ENCODING_KEY]: Buffer.from('json/plain').toString('base64') },
      data: Buffer.from('{"note":"ROUND-TRIP"}').toString('base64'),
    };
    const enc = await post('/encode', [plain], { origin: UI_ORIGIN });
    expect(plaintextOf(enc.body.payloads![0]!)).not.toContain('ROUND-TRIP');
    const dec = await post('/decode', enc.body.payloads!, { origin: UI_ORIGIN });
    expect(plaintextOf(dec.body.payloads![0]!)).toBe('{"note":"ROUND-TRIP"}');
  });

  it.each(['https://evil.example', 'https://temporal.qosfc.example.evil.example', 'null', UI_ORIGIN + '/'])(
    'refuses origin %s with 403 and no plaintext',
    async (origin) => {
      const res = await post('/decode', [await encryptedMarker()], { origin });
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('SENSITIVE-MARKER');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    },
  );

  it('answers a CORS preflight from the UI origin', async () => {
    const res = await fetch(server.baseUrl + '/decode', {
      method: 'OPTIONS',
      headers: { origin: UI_ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('refuses a payload whose key id tries to escape the key directory', async () => {
    const wire = await encryptedMarker();
    // The codec stores the key id in metadata; point it at a path.
    const keyIdField = Object.keys(wire.metadata).find((k) => Buffer.from(wire.metadata[k]!, 'base64').toString() === 'k1');
    expect(keyIdField).toBeDefined();
    wire.metadata[keyIdField!] = Buffer.from('../../etc/passwd').toString('base64');
    const res = await post('/decode', [wire], { origin: UI_ORIGIN });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).not.toContain('SENSITIVE-MARKER');
  });

  describe('authentication (#41)', () => {
    it('refuses to decrypt for a caller that presents no credentials (no Origin header at all)', async () => {
      // curl, a script, or any container on the `edge` network sends no Origin.
      const res = await post('/decode', [await encryptedMarker()], { authorization: '' });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Basic /);
      expect(JSON.stringify(res.body)).not.toContain('SENSITIVE-MARKER');
    });

    it('refuses the UI origin without credentials, and a wrong token', async () => {
      expect((await post('/decode', [await encryptedMarker()], { origin: UI_ORIGIN, authorization: '' })).status).toBe(401);
      expect((await post('/decode', [await encryptedMarker()], { authorization: `Bearer ${TOKEN.slice(1)}x` })).status).toBe(401);
      expect((await post('/encode', [await encryptedMarker()], { authorization: 'Bearer ' })).status).toBe(401);
    });

    it('accepts the token as HTTP Basic auth from the browser, with credentialed CORS', async () => {
      const basic = `Basic ${Buffer.from(`operator:${TOKEN}`).toString('base64')}`;
      const res = await post('/decode', [await encryptedMarker()], { origin: UI_ORIGIN, authorization: basic });
      expect(res.status).toBe(200);
      expect(plaintextOf(res.body.payloads![0]!)).toContain('SENSITIVE-MARKER');
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    });

    it('accepts the Bearer token from a script that sends no Origin', async () => {
      const res = await post('/decode', [await encryptedMarker()]);
      expect(res.status).toBe(200);
      expect(plaintextOf(res.body.payloads![0]!)).toContain('SENSITIVE-MARKER');
    });
  });
});
