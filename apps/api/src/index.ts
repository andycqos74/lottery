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
import type { FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { appDbConnectionFromEnv, createPool } from '@qosfc/db';
import {
  findMemberByEmail,
  getDrawStats,
  getMemberDetails,
  getOpenDraw,
  getStandingSelection,
  listMyEntries,
  listSettledDraws,
  registerMember,
  touchMemberLastLogin,
  updateMemberDetails,
} from './db.js';
import { completeEntryPurchase, PURCHASE_BLOCK_SIZES, startEntryPurchase } from './entries.js';
import { buildPaymentGateway } from './providers.js';
import { cookieOpts, currentMember, requireCsrf, SESSION_COOKIE, type SessionPayload } from './auth.js';
import {
  accountPage,
  detailsPage,
  drawPage,
  loginPage,
  pastDrawsPage,
  paymentPage,
  purchaseReturnPage,
  registerPage,
  type ViewMember,
} from './views.js';

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

// The browser-facing pages below post regular HTML forms; the routes they
// share with the JSON API (register/login/logout) tell the two apart by
// content type and answer with a redirect instead of a JSON body.
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
  try {
    // Object.fromEntries would silently keep only the last value for a
    // repeated key (the numbers-picker checkboxes all share name="selection"),
    // so build the object by hand and collect repeats into an array.
    const parsed: Record<string, string | string[]> = {};
    for (const [key, value] of new URLSearchParams(body as string)) {
      const existing = parsed[key];
      if (existing === undefined) parsed[key] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else parsed[key] = [existing, value];
    }
    done(null, parsed);
  } catch (err) {
    done(err as Error, undefined);
  }
});

function isFormRequest(request: FastifyRequest): boolean {
  return (request.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded');
}

async function viewMember(request: FastifyRequest): Promise<{ auth: NonNullable<Awaited<ReturnType<typeof currentMember>>>; view: ViewMember } | undefined> {
  const auth = await currentMember(pool, request);
  if (!auth) return undefined;
  return { auth, view: { forename: auth.member.forename, csrf: auth.session.csrf } };
}

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

app.get('/register', async (request, reply) => {
  const found = await viewMember(request);
  if (found) return reply.redirect('/account');
  const openDraw = await getOpenDraw(pool);
  reply.type('text/html').send(registerPage({ ...(openDraw ? { openDraw } : {}) }));
});

app.post('/register', async (request, reply) => {
  const form = isFormRequest(request);
  const body = request.body as { forename?: string; surname?: string; email?: string; password?: string };
  const forename = (body.forename ?? '').trim();
  const surname = (body.surname ?? '').trim();
  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';

  const reject = (message: string) =>
    form
      ? reply.type('text/html').code(400).send(registerPage({ error: message }))
      : reply.code(400).send({ error: message });

  if (!forename || !surname || !email || password.length < 10) {
    return reject('forename, surname, email, and a password of at least 10 characters are required.');
  }

  const passwordHash = await argon2Hash(password);
  const outcome = await registerMember(pool, { forename, surname, email, passwordHash });
  if (outcome.kind === 'email_taken') {
    // Same shape as a validation error, not a 409 — confirming which emails
    // are registered is exactly the enumeration a login form must not offer.
    return reject('Could not register with those details.');
  }

  if (!form) return reply.code(201).send({ memberId: outcome.memberId });

  await touchMemberLastLogin(pool, outcome.memberId);
  const csrf = randomBytes(16).toString('hex');
  const payload: SessionPayload = { mid: outcome.memberId, csrf };
  reply.setCookie(SESSION_COOKIE, JSON.stringify(payload), cookieOpts(nodeEnv));
  return reply.redirect('/draw');
});

app.get('/login', async (request, reply) => {
  const found = await viewMember(request);
  if (found) return reply.redirect('/account');
  const openDraw = await getOpenDraw(pool);
  reply.type('text/html').send(loginPage({ ...(openDraw ? { openDraw } : {}) }));
});

app.post('/login', async (request, reply) => {
  const form = isFormRequest(request);
  const body = request.body as { email?: string; password?: string };
  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';
  const invalid = () =>
    form
      ? reply.type('text/html').code(401).send(loginPage({ error: 'Invalid email or password.' }))
      : reply.code(401).send({ error: 'Invalid email or password.' });
  if (!email || !password) return invalid();

  const member = await findMemberByEmail(pool, email);
  if (!member) return invalid();
  const ok = await argon2Verify(member.passwordHash, password).catch(() => false);
  if (!ok) return invalid();

  await touchMemberLastLogin(pool, member.id);
  const csrf = randomBytes(16).toString('hex');
  const payload: SessionPayload = { mid: member.id, csrf };
  reply.setCookie(SESSION_COOKIE, JSON.stringify(payload), cookieOpts(nodeEnv));
  if (form) return reply.redirect('/draw');
  return { memberId: member.id, csrf };
});

app.post('/logout', async (request, reply) => {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  if (isFormRequest(request)) return reply.redirect('/login');
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

  const body = request.body as { selection?: number[]; blocks?: number };
  const outcome = await startEntryPurchase(pool, paymentGateway, {
    memberId: auth.member.id,
    selection: body.selection ?? [],
    blocks: body.blocks ?? 1,
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

// ── Browser pages ────────────────────────────────────────────────────────────

function parseSelectionInput(raw: string | string[] | undefined): number[] {
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).map((s) => Number.parseInt(s, 10)).filter((n) => !Number.isNaN(n));
}

app.get('/draw', async (request, reply) => {
  const found = await viewMember(request);
  if (!found) return reply.redirect('/login');
  const openDraw = await getOpenDraw(pool);
  if (!openDraw) return reply.type('text/html').send(drawPage({ member: found.view }));

  const [stats, entries] = await Promise.all([getDrawStats(pool, openDraw.id), listMyEntries(pool, found.auth.member.id)]);
  const currentEntry = entries.find((e) => e.drawNumber === openDraw.drawNumber);
  reply.type('text/html').send(drawPage({ member: found.view, openDraw, stats, ...(currentEntry ? { currentEntry } : {}) }));
});

app.get('/draw/pay', async (request, reply) => {
  const found = await viewMember(request);
  if (!found) return reply.redirect('/login');
  const openDraw = await getOpenDraw(pool);
  if (!openDraw) return reply.redirect('/draw');

  const query = request.query as { selection?: string | string[]; blocks?: string };
  const selection = [...new Set(parseSelectionInput(query.selection))].sort((a, b) => a - b);
  if (selection.length !== 4 || selection.some((n) => n < 1 || n > 20)) {
    const stats = await getDrawStats(pool, openDraw.id);
    return reply
      .type('text/html')
      .send(drawPage({ member: found.view, openDraw, stats, error: 'Pick four distinct numbers between 1 and 20 first.' }));
  }
  const blocks = PURCHASE_BLOCK_SIZES.includes(Number(query.blocks) as (typeof PURCHASE_BLOCK_SIZES)[number])
    ? Number(query.blocks)
    : 4;
  reply.type('text/html').send(paymentPage({ member: found.view, openDraw, selection, blocks }));
});

app.post('/draw/enter', async (request, reply) => {
  const found = await viewMember(request);
  if (!found) return reply.redirect('/login');
  if (!requireCsrf(request, reply, found.auth.session.csrf)) return;

  const body = request.body as { selection?: string | string[]; blocks?: string; csrf?: string };
  const selection = [...new Set(parseSelectionInput(body.selection))].sort((a, b) => a - b);
  const blocks = Number.parseInt(body.blocks ?? '', 10);

  const openDraw = await getOpenDraw(pool);
  if (!openDraw) return reply.type('text/html').send(drawPage({ member: found.view, error: 'No draw is currently open for entries.' }));

  const outcome = await startEntryPurchase(pool, paymentGateway, {
    memberId: found.auth.member.id,
    selection,
    blocks,
    returnUrl: `${publicBaseUrl}/draw/return`,
    cancelUrl: `${publicBaseUrl}/draw`,
  });
  if (outcome.kind === 'rejected') {
    return reply.type('text/html').send(
      paymentPage({
        member: found.view,
        openDraw,
        selection,
        blocks: PURCHASE_BLOCK_SIZES.includes(blocks as (typeof PURCHASE_BLOCK_SIZES)[number]) ? blocks : 4,
        error: outcome.reason,
      }),
    );
  }
  return reply.redirect(outcome.redirectUrl);
});

app.get('/draw/return', async (request, reply) => {
  const found = await viewMember(request);
  if (!found) return reply.redirect('/login');

  const { session } = request.query as { session?: string };
  if (!session) return reply.code(400).type('text/html').send(purchaseReturnPage({ member: found.view, status: 'not_found' }));

  const outcome = await completeEntryPurchase(pool, paymentGateway, session);
  const status =
    outcome.kind === 'entry_created' || outcome.kind === 'already_completed'
      ? 'paid'
      : outcome.kind === 'not_found'
        ? 'not_found'
        : outcome.kind === 'payment_failed'
          ? 'failed'
          : 'pending';
  reply.type('text/html').send(
    purchaseReturnPage({
      member: found.view,
      status,
      ...(outcome.kind === 'payment_failed' ? { reason: outcome.reason } : {}),
    }),
  );
});

app.get('/account', async (request, reply) => {
  const found = await viewMember(request);
  if (!found) return reply.redirect('/login');
  const [openDraw, standingSelection, entries] = await Promise.all([
    getOpenDraw(pool),
    getStandingSelection(pool, found.auth.member.id),
    listMyEntries(pool, found.auth.member.id),
  ]);
  reply.type('text/html').send(
    accountPage({ member: found.view, ...(openDraw ? { openDraw } : {}), ...(standingSelection ? { standingSelection } : {}), entries }),
  );
});

app.get('/details', async (request, reply) => {
  const found = await viewMember(request);
  if (!found) return reply.redirect('/login');
  const [openDraw, details] = await Promise.all([getOpenDraw(pool), getMemberDetails(pool, found.auth.member.id)]);
  reply.type('text/html').send(detailsPage({ member: found.view, ...(openDraw ? { openDraw } : {}), details: details! }));
});

app.post('/details', async (request, reply) => {
  const found = await viewMember(request);
  if (!found) return reply.redirect('/login');
  if (!requireCsrf(request, reply, found.auth.session.csrf)) return;

  const body = request.body as {
    telephone?: string;
    address1?: string;
    address2?: string;
    address3?: string;
    postCode?: string;
    preferredContact?: string;
  };
  const preferredContact = body.preferredContact === 'phone' || body.preferredContact === 'post' ? body.preferredContact : 'email';

  await updateMemberDetails(pool, found.auth.member.id, {
    telephone: (body.telephone ?? '').trim(),
    address1: (body.address1 ?? '').trim(),
    address2: (body.address2 ?? '').trim(),
    address3: (body.address3 ?? '').trim(),
    postCode: (body.postCode ?? '').trim(),
    preferredContact,
  });

  const [openDraw, details] = await Promise.all([getOpenDraw(pool), getMemberDetails(pool, found.auth.member.id)]);
  reply.type('text/html').send(
    detailsPage({ member: found.view, ...(openDraw ? { openDraw } : {}), details: details!, flash: 'Details saved.' }),
  );
});

app.get('/past-draws', async (request, reply) => {
  const found = await viewMember(request);
  const [openDraw, draws] = await Promise.all([getOpenDraw(pool), listSettledDraws(pool)]);
  reply.type('text/html').send(
    pastDrawsPage({ ...(found ? { member: found.view } : {}), ...(openDraw ? { openDraw } : {}), draws }),
  );
});

await app.listen({ port, host: '0.0.0.0' });
