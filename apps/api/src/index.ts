#!/usr/bin/env node
/**
 * Member-facing API and public results.
 *
 * Reads come from PostgreSQL; writes go through Temporal clients — start,
 * signal, update, query (technical spec §1). The API never writes business state
 * directly, so every state change carries a workflow's durability, idempotency
 * and audit trail rather than depending on a request completing.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { appDbConnectionFromEnv, createPool } from '@qosfc/db';
import { findMemberByEmail, getOpenDraw, registerMember, touchMemberLastLogin } from './db.js';
import { completeEntryPurchase, startEntryPurchase } from './entries.js';
import { buildPaymentGateway } from './providers.js';
import { cookieOpts, currentMember, requireCsrf, SESSION_COOKIE, type SessionPayload } from './auth.js';

const port = Number(process.env['PORT'] ?? 8080);
const nodeEnv = process.env['NODE_ENV'] ?? 'development';
const sessionSecretFile = process.env['SESSION_SECRET_FILE'];
if (!sessionSecretFile) throw new Error('SESSION_SECRET_FILE must be set.');
const sessionSecret = readFileSync(sessionSecretFile, 'utf8').trim();
const publicBaseUrl = process.env['PUBLIC_BASE_URL'] ?? `http://localhost:${port}`;

const pool = createPool({
  ...appDbConnectionFromEnv(),
  applicationName: 'qosfc-api',
  max: 10,
});
const paymentGateway = buildPaymentGateway({
  PAYMENT_GATEWAY: process.env['PAYMENT_GATEWAY'],
  SANDBOX_PROVIDERS_URL: process.env['SANDBOX_PROVIDERS_URL'],
  SANDBOX_WEBHOOK_SECRET_FILE: process.env['SANDBOX_WEBHOOK_SECRET_FILE'],
});

const app = Fastify({
  logger: {
    // T-9.5 / NFR-6: personal data must not leak into operational infrastructure
    // that is outside the system's own retention and access controls. Logs are
    // exactly that, so the obvious carriers are redacted at the serialiser.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.body.email',
        'req.body.password',
        'req.body.surname',
        'req.body.postcode',
      ],
      censor: '[redacted]',
    },
  },
  // Trust the single reverse proxy in front of us, so rate limiting and logging
  // see the real client address rather than Caddy's.
  trustProxy: true,
  bodyLimit: 1024 * 1024,
});

await app.register(cookie, { secret: sessionSecret });

app.get('/healthz', async () => ({ ok: true }));

app.get('/readyz', async (_request, reply) => {
  try {
    await pool.query('SELECT 1');
    return { ok: true };
  } catch {
    return reply.code(503).send({ ok: false, reason: 'database unavailable' });
  }
});

/**
 * Public results. No authentication and no personal data — FR-6 output only.
 * GAP-29 (whether winners' names are published, and what consent is captured)
 * is unresolved, so no name is exposed here under any circumstances.
 */
app.get('/results', async () => {
  const { rows } = await pool.query(
    `SELECT draw_number, draw_date, winning_numbers,
            jackpot_paid_pence::text  AS jackpot_paid_pence,
            rollover_out_pence::text  AS rollover_out_pence,
            winners_count
       FROM draw
      WHERE status = 'settled'
      ORDER BY draw_number DESC
      LIMIT 20`,
  );
  return { draws: rows };
});

// ── Member accounts (GAP-04) ─────────────────────────────────────────────────
// A new-member portal login. Translating an existing legacy member (most of
// whom have no email on file — GAP-05) into a portal login is deferred
// future-phase work, not attempted here.

app.post('/register', async (request, reply) => {
  const body = request.body as { forename?: string; surname?: string; email?: string; password?: string };
  const forename = (body.forename ?? '').trim();
  const surname = (body.surname ?? '').trim();
  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';

  if (!forename || !surname || !email || password.length < 10) {
    return reply.code(400).send({ error: 'forename, surname, email, and a password of at least 10 characters are required.' });
  }

  const passwordHash = await argon2Hash(password);
  const outcome = await registerMember(pool, { forename, surname, email, passwordHash });
  if (outcome.kind === 'email_taken') {
    // Same shape as a validation error, not a 409 — confirming which emails
    // are registered is exactly the enumeration a login form must not offer.
    return reply.code(400).send({ error: 'Could not register with those details.' });
  }
  return reply.code(201).send({ memberId: outcome.memberId });
});

app.post('/login', async (request, reply) => {
  const body = request.body as { email?: string; password?: string };
  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';
  const invalid = () => reply.code(401).send({ error: 'Invalid email or password.' });
  if (!email || !password) return invalid();

  const member = await findMemberByEmail(pool, email);
  if (!member) return invalid();
  const ok = await argon2Verify(member.passwordHash, password).catch(() => false);
  if (!ok) return invalid();

  await touchMemberLastLogin(pool, member.id);
  const csrf = randomBytes(16).toString('hex');
  const payload: SessionPayload = { mid: member.id, csrf };
  reply.setCookie(SESSION_COOKIE, JSON.stringify(payload), cookieOpts(nodeEnv));
  return { memberId: member.id, csrf };
});

app.post('/logout', async (request, reply) => {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  return { ok: true };
});

app.get('/me', async (request, reply) => {
  const auth = await currentMember(pool, request);
  if (!auth) return reply.code(401).send({ error: 'Not logged in.' });
  return { member: auth.member, csrf: auth.session.csrf };
});

// ── Play online (GAP-09, dummy transaction simulator until an acquirer is
// chosen; GAP-17/19 do not apply — this is a direct one-off paid entry) ─────

app.get('/draws/current', async () => {
  const draw = await getOpenDraw(pool);
  return { draw: draw ?? null };
});

app.post('/entries/purchase', async (request, reply) => {
  const auth = await currentMember(pool, request);
  if (!auth) return reply.code(401).send({ error: 'Not logged in.' });
  if (!requireCsrf(request, reply, auth.session.csrf)) return;

  const body = request.body as { selection?: number[] };
  const outcome = await startEntryPurchase(pool, paymentGateway, {
    memberId: auth.member.id,
    selection: body.selection ?? [],
    returnUrl: `${publicBaseUrl}/entries/purchase/return`,
    cancelUrl: `${publicBaseUrl}/entries/purchase/cancelled`,
  });
  if (outcome.kind === 'rejected') return reply.code(400).send({ error: outcome.reason });
  return { redirectUrl: outcome.redirectUrl, sessionId: outcome.sessionId };
});

app.get('/entries/purchase/return', async (request, reply) => {
  const { session } = request.query as { session?: string };
  if (!session) return reply.code(400).send({ error: 'Missing session.' });

  const outcome = await completeEntryPurchase(pool, paymentGateway, session);
  switch (outcome.kind) {
    case 'entry_created':
    case 'already_completed':
      return { status: 'paid', entryId: outcome.entryId };
    case 'pending':
      return reply.code(202).send({ status: 'pending' });
    case 'payment_failed':
      return reply.code(402).send({ status: 'failed', reason: outcome.reason });
    case 'not_found':
      return reply.code(404).send({ error: 'Unknown purchase session.' });
  }
});

await app.listen({ port, host: '0.0.0.0' });
