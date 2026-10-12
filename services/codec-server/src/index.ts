#!/usr/bin/env node
/**
 * Codec server (T-10.11).
 *
 * The Temporal Web UI decodes payloads by calling this endpoint FROM THE
 * OPERATOR'S BROWSER — not from the nodes — so it needs a route from admin
 * machines, TLS, a CORS origin restricted to the UI, and its own authentication.
 *
 * It is an oracle that decrypts member data. Treat it as one: it sits behind the
 * same IP allowlist as the admin console, and without it the UI shows unreadable
 * ciphertext during exactly the incident when someone needs to read it.
 *
 * Authentication (#41): every /encode and /decode call must present the shared
 * token in CODEC_AUTH_TOKEN_FILE — as `Authorization: Bearer <token>` from a
 * script, or as the password of HTTP Basic auth (any username) from a browser.
 * The Origin check alone is not authentication: a caller that sends no Origin
 * (curl, any container on the `edge` network) skipped it entirely. A refusal
 * carries a Basic challenge, so an operator opens the codec URL once, enters
 * the token, and the Temporal UI (TEMPORAL_CODEC_INCLUDE_CREDENTIALS) sends
 * those credentials with every decode from then on.
 */
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { EncryptionCodec, FileKeyProvider } from '@qosfc/temporal-common';
import type { Payload } from '@temporalio/common';

const port = Number(process.env['PORT'] ?? 8082);
const allowedOrigin = required('ALLOWED_ORIGIN');
const authToken = readFileSync(required('CODEC_AUTH_TOKEN_FILE'), 'utf8').trim();
if (authToken.length < 32) throw new Error('CODEC_AUTH_TOKEN_FILE must hold a token of at least 32 characters.');
const codec = new EncryptionCodec(
  new FileKeyProvider(required('TEMPORAL_CODEC_KEY_DIR'), required('TEMPORAL_CODEC_ACTIVE_KEY_ID')),
);

const app = Fastify({ logger: { redact: ['req.headers.authorization'] }, bodyLimit: 4 * 1024 * 1024 });

/** The token from a Bearer header, or the password of a Basic one. */
function presentedToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, value = ''] = header.split(' ', 2);
  if (scheme?.toLowerCase() === 'bearer') return value;
  if (scheme?.toLowerCase() === 'basic') {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    return decoded.slice(decoded.indexOf(':') + 1);
  }
  return undefined;
}

function authorised(header: string | undefined): boolean {
  const presented = Buffer.from(presentedToken(header) ?? '');
  const expected = Buffer.from(authToken);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

app.addHook('onRequest', async (request, reply) => {
  const origin = request.headers.origin;
  // Exact-match only. A permissive CORS policy on a decryption oracle would let
  // any page the operator visits read member data out of workflow history.
  if (origin && origin !== allowedOrigin) {
    return reply.code(403).send({ error: 'origin not allowed' });
  }
  if (origin) {
    reply.header('access-control-allow-origin', origin);
    reply.header('access-control-allow-credentials', 'true');
    reply.header('access-control-allow-headers', 'content-type,x-namespace,authorization');
    reply.header('access-control-allow-methods', 'POST,OPTIONS');
    reply.header('vary', 'origin');
  }
  // A CORS preflight carries no credentials by design, and decrypts nothing.
  if (request.method === 'OPTIONS' || request.url === '/healthz') return;
  if (!authorised(request.headers.authorization)) {
    return reply.code(401).header('www-authenticate', 'Basic realm="QOSFC codec", charset="UTF-8"').send({ error: 'authentication required' });
  }
});

app.options('/*', async (_request, reply) => reply.code(204).send());
app.get('/healthz', async () => ({ ok: true }));

app.post<{ Body: { payloads: Payload[] } }>('/encode', async (request) => ({
  payloads: await codec.encode(toBuffers(request.body.payloads)),
}));

app.post<{ Body: { payloads: Payload[] } }>('/decode', async (request) => ({
  payloads: await codec.decode(toBuffers(request.body.payloads)),
}));

/** The UI sends payload bytes base64-encoded in JSON; the codec works on Buffers. */
function toBuffers(payloads: Payload[]): Payload[] {
  return payloads.map((p) => ({
    metadata: p.metadata
      ? Object.fromEntries(
          Object.entries(p.metadata).map(([k, v]) => [k, Buffer.from(v as unknown as string, 'base64')]),
        )
      : null,
    data: p.data ? Buffer.from(p.data as unknown as string, 'base64') : null,
  }));
}

await app.listen({ port, host: '0.0.0.0' });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. The codec server cannot run without its key.`);
  return value;
}
