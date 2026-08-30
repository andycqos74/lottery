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
 */
import Fastify from 'fastify';
import { EncryptionCodec, FileKeyProvider } from '@qosfc/temporal-common';
import type { Payload } from '@temporalio/common';

const port = Number(process.env['PORT'] ?? 8082);
const allowedOrigin = required('ALLOWED_ORIGIN');
const codec = new EncryptionCodec(
  new FileKeyProvider(required('TEMPORAL_CODEC_KEY_DIR'), required('TEMPORAL_CODEC_ACTIVE_KEY_ID')),
);

const app = Fastify({ logger: true, bodyLimit: 4 * 1024 * 1024 });

app.addHook('onRequest', async (request, reply) => {
  const origin = request.headers.origin;
  // Exact-match only. A permissive CORS policy on a decryption oracle would let
  // any page the operator visits read member data out of workflow history.
  if (origin && origin !== allowedOrigin) {
    return reply.code(403).send({ error: 'origin not allowed' });
  }
  if (origin) {
    reply.header('access-control-allow-origin', origin);
    reply.header('access-control-allow-headers', 'content-type,x-namespace,authorization');
    reply.header('access-control-allow-methods', 'POST,OPTIONS');
    reply.header('vary', 'origin');
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
