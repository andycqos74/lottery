#!/usr/bin/env node
/**
 * Admin console (build plan §5, GAP-43).
 *
 * The human task inbox lives here as a rendered database table, deliberately
 * NOT the Temporal Web UI — a volunteer treasurer must never be asked to send
 * a raw signal from a developer tool to release a stuck prize payment.
 *
 * T-9.3: individual named accounts, mandatory MFA, no shared logins. Accounts
 * are created by `deploy/bootstrap/create-admin-user.ts` — there is no
 * self-service signup for an admin console.
 */
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { verify as argon2Verify } from '@node-rs/argon2';
import { appDbConnectionFromEnv, createPool } from '@qosfc/db';
import {
  dashboardCounts,
  findUserByEmail,
  findUserById,
  getTask,
  insertAuditLog,
  listOpenTasks,
  resolveTaskStep,
  touchLastLogin,
  type AppUser,
} from './db.js';
import { dashboardPage, loginPage, mfaPage, taskDetailPage, tasksPage } from './views.js';
import { decryptSecret } from './secret-box.js';
import { verifyTotp } from './totp.js';

const port = Number(process.env['PORT'] ?? 8081);
const nodeEnv = process.env['NODE_ENV'] ?? 'development';
const requireMfa = (process.env['REQUIRE_MFA'] ?? 'true') !== 'false';
const sessionSecretFile = process.env['SESSION_SECRET_FILE'];
const mfaKeyFile = process.env['ADMIN_MFA_KEY_FILE'];

if (!sessionSecretFile) throw new Error('SESSION_SECRET_FILE must be set.');
if (requireMfa && !mfaKeyFile) throw new Error('ADMIN_MFA_KEY_FILE must be set when REQUIRE_MFA is on.');

const { readFileSync } = await import('node:fs');
const sessionSecret = readFileSync(sessionSecretFile, 'utf8').trim();
const mfaKey = mfaKeyFile ? Buffer.from(readFileSync(mfaKeyFile, 'utf8').trim(), 'base64') : null;

const pool = createPool({ ...appDbConnectionFromEnv(), applicationName: 'qosfc-admin', max: 10 });

const app = Fastify({
  logger: {
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password', 'req.body.code'], censor: '[redacted]' },
  },
  trustProxy: true,
  bodyLimit: 1024 * 1024,
});

await app.register(cookie, { secret: sessionSecret });

const SESSION_COOKIE = 'qosfc_admin_session';
const PENDING_MFA_COOKIE = 'qosfc_admin_mfa_pending';
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const PENDING_MFA_MAX_AGE_SECONDS = 5 * 60;

interface SessionPayload {
  readonly uid: string;
  readonly csrf: string;
}

function cookieOpts(maxAgeSeconds: number) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: nodeEnv === 'production',
    signed: true,
    maxAge: maxAgeSeconds,
  };
}

// application/x-www-form-urlencoded — the only body shape this server accepts.
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
  try {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  } catch (err) {
    done(err as Error, undefined);
  }
});

function readSignedCookie(request: FastifyRequest, name: string): string | undefined {
  const raw = request.cookies[name];
  if (!raw) return undefined;
  const result = request.unsignCookie(raw);
  return result.valid && result.value ? result.value : undefined;
}

async function currentUser(request: FastifyRequest): Promise<{ user: AppUser; session: SessionPayload } | undefined> {
  const value = readSignedCookie(request, SESSION_COOKIE);
  if (!value) return undefined;
  let session: SessionPayload;
  try {
    session = JSON.parse(value) as SessionPayload;
  } catch {
    return undefined;
  }
  const user = await findUserById(pool, session.uid);
  if (!user || !user.isActive) return undefined;
  return { user, session };
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

// ── Login ────────────────────────────────────────────────────────────────────
app.get('/login', async (request, reply) => {
  const auth = await currentUser(request);
  if (auth) return reply.redirect('/');
  reply.type('text/html').send(loginPage({}));
});

app.post('/login', async (request, reply) => {
  const body = request.body as { email?: string; password?: string };
  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';

  const genericError = () => reply.type('text/html').code(401).send(loginPage({ error: 'Invalid email or password.' }));

  if (!email || !password) return genericError();

  const user = await findUserByEmail(pool, email);
  if (!user || !user.isActive) {
    // Same response either way: an invalid email must not be distinguishable
    // from a wrong password.
    await insertAuditLog(pool, { actorLabel: email, action: 'admin_login_failed', entity: 'app_user' });
    return genericError();
  }

  const ok = await argon2Verify(user.passwordHash, password).catch(() => false);
  if (!ok) {
    await insertAuditLog(pool, { actorId: user.id, actorLabel: user.email, action: 'admin_login_failed', entity: 'app_user', entityId: user.id });
    return genericError();
  }

  if (requireMfa && !user.mfaEnrolled) {
    return reply
      .type('text/html')
      .code(403)
      .send(loginPage({ error: 'This account has no MFA enrolled yet. Ask an operator to re-run create-admin-user.' }));
  }

  if (requireMfa) {
    reply.setCookie(PENDING_MFA_COOKIE, JSON.stringify({ uid: user.id }), cookieOpts(PENDING_MFA_MAX_AGE_SECONDS));
    return reply.redirect('/login/mfa');
  }

  await establishSession(reply, user.id);
  await touchLastLogin(pool, user.id);
  await insertAuditLog(pool, { actorId: user.id, actorLabel: user.email, action: 'admin_login', entity: 'app_user', entityId: user.id });
  return reply.redirect('/');
});

app.get('/login/mfa', async (request, reply) => {
  const pending = readSignedCookie(request, PENDING_MFA_COOKIE);
  if (!pending) return reply.redirect('/login');
  reply.type('text/html').send(mfaPage({}));
});

app.post('/login/mfa', async (request, reply) => {
  const pendingRaw = readSignedCookie(request, PENDING_MFA_COOKIE);
  if (!pendingRaw) return reply.redirect('/login');
  const { uid } = JSON.parse(pendingRaw) as { uid: string };

  const user = await findUserById(pool, uid);
  const body = request.body as { code?: string };
  const code = (body.code ?? '').trim();

  const reject = (message: string) => reply.type('text/html').code(401).send(mfaPage({ error: message }));

  if (!user || !user.isActive || !mfaKey || !user.totpSecretEnc) return reject('Verification failed. Log in again.');

  const secret = decryptSecret(user.totpSecretEnc, mfaKey);
  if (!verifyTotp(secret, code)) {
    await insertAuditLog(pool, { actorId: user.id, actorLabel: user.email, action: 'admin_mfa_failed', entity: 'app_user', entityId: user.id });
    return reject('That code is not valid. Codes refresh every 30 seconds — try the current one.');
  }

  reply.clearCookie(PENDING_MFA_COOKIE, { path: '/' });
  await establishSession(reply, user.id);
  await touchLastLogin(pool, user.id);
  await insertAuditLog(pool, { actorId: user.id, actorLabel: user.email, action: 'admin_login', entity: 'app_user', entityId: user.id });
  return reply.redirect('/');
});

async function establishSession(reply: FastifyReply, userId: string): Promise<void> {
  const payload: SessionPayload = { uid: userId, csrf: randomBytes(16).toString('hex') };
  reply.setCookie(SESSION_COOKIE, JSON.stringify(payload), cookieOpts(SESSION_MAX_AGE_SECONDS));
}

app.post('/logout', async (request, reply) => {
  if (!requireCsrf(request, reply, request.authCsrf!)) return;
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  await insertAuditLog(pool, {
    actorId: request.authUser!.id,
    actorLabel: request.authUser!.email,
    action: 'admin_logout',
    entity: 'app_user',
    entityId: request.authUser!.id,
  });
  return reply.redirect('/login');
});

// ── Authenticated pages ───────────────────────────────────────────────────────
const PUBLIC_PATHS = new Set(['/login', '/login/mfa', '/healthz', '/readyz']);

app.addHook('onRequest', async (request, reply) => {
  if (PUBLIC_PATHS.has(request.url.split('?')[0] ?? '')) return;
  const auth = await currentUser(request);
  if (!auth) return reply.redirect('/login');
  request.authUser = auth.user;
  request.authCsrf = auth.session.csrf;
});

function requireCsrf(request: FastifyRequest, reply: FastifyReply, expected: string): boolean {
  const body = request.body as { csrf?: string } | undefined;
  if (body?.csrf && body.csrf === expected) return true;
  reply.code(403).type('text/html').send('<p>Session expired. Go back and try again.</p>');
  return false;
}

function viewUser(request: FastifyRequest): { id: string; displayName: string; csrf: string } {
  const { authUser, authCsrf } = request;
  return { id: authUser!.id, displayName: authUser!.displayName, csrf: authCsrf! };
}

app.get('/', async (request, reply) => {
  const counts = await dashboardCounts(pool);
  reply.type('text/html').send(dashboardPage({ user: viewUser(request), counts }));
});

app.get('/tasks', async (request, reply) => {
  const tasks = await listOpenTasks(pool);
  reply.type('text/html').send(tasksPage({ user: viewUser(request), tasks }));
});

app.get('/tasks/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const task = await getTask(pool, id);
  if (!task) return reply.code(404).type('text/html').send('<p>Task not found.</p>');
  reply.type('text/html').send(taskDetailPage({ user: viewUser(request), task }));
});

app.post('/tasks/:id/resolve', async (request, reply) => {
  if (!requireCsrf(request, reply, request.authCsrf!)) return;

  const { id } = request.params as { id: string };
  const body = request.body as { note?: string };
  const task = await getTask(pool, id);
  if (!task) return reply.code(404).type('text/html').send('<p>Task not found.</p>');

  const note = (body.note ?? '').trim();
  if (!note) {
    return reply.type('text/html').send(taskDetailPage({ user: viewUser(request), task, error: 'A resolution note is required.' }));
  }

  const outcome = await resolveTaskStep(pool, id, request.authUser!.id, note);
  const refreshed = (await getTask(pool, id))!;

  if (outcome.kind === 'rejected') {
    return reply.type('text/html').send(taskDetailPage({ user: viewUser(request), task: refreshed, error: outcome.reason }));
  }

  await insertAuditLog(pool, {
    actorId: request.authUser!.id,
    actorLabel: request.authUser!.email,
    action: outcome.kind === 'resolved' ? 'human_task_resolved' : 'human_task_first_approval',
    entity: 'human_task',
    entityId: id,
  });

  const flash = outcome.kind === 'resolved' ? 'Task resolved.' : 'First approval recorded — a different person must approve it a second time.';
  reply.type('text/html').send(taskDetailPage({ user: viewUser(request), task: refreshed, flash }));
});

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AppUser;
    authCsrf?: string;
  }
}

app.log.info({ msg: 'admin console starting', port, requireMfa });
await app.listen({ port, host: '0.0.0.0' });
