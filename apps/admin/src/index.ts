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
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { verify as argon2Verify } from '@node-rs/argon2';
import { appDbConnectionFromEnv, createPool } from '@qosfc/db';
import { ingestNewStatements } from '@qosfc/activities';
import { CsvBankFeed } from '@qosfc/adapters-live';
import {
  addEntry,
  countEntries,
  closeDrawAndRecordWorkflow,
  createDraw,
  createMember,
  dashboardCounts,
  findUserByEmail,
  findUserById,
  getBankStatement,
  getDraw,
  getTask,
  insertAuditLog,
  listBankStatements,
  listDraws,
  listMembers,
  listTasksByStatus,
  resolveTaskStep,
  touchLastLogin,
  type AppUser,
} from './db.js';
import {
  bankStatementDetailPage,
  bankStatementsPage,
  dashboardPage,
  drawDetailPage,
  drawsPage,
  loginPage,
  membersPage,
  mfaPage,
  newDrawPage,
  taskDetailPage,
  tasksPage,
} from './views.js';
import { decryptSecret } from './secret-box.js';
import { verifyTotp } from './totp.js';
import { deliverTaskDecision, startDrawWorkflow } from './temporal.js';

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
const bankFeedCsvDir = process.env['BANK_FEED_CSV_DIR'] ?? '/data/bank-statements';

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
  const { status } = request.query as { status?: string };
  const filter: 'open' | 'resolved' | 'all' = status === 'resolved' || status === 'all' ? status : 'open';
  const tasks = await listTasksByStatus(pool, filter);
  reply.type('text/html').send(tasksPage({ user: viewUser(request), tasks, filter }));
});

app.get('/draws', async (request, reply) => {
  const draws = await listDraws(pool);
  reply.type('text/html').send(drawsPage({ user: viewUser(request), draws }));
});

app.get('/draws/new', async (request, reply) => {
  reply.type('text/html').send(newDrawPage({ user: viewUser(request) }));
});

app.post('/draws', async (request, reply) => {
  if (!requireCsrf(request, reply, request.authCsrf!)) return;

  const body = request.body as { drawNumber?: string };
  const drawNumber = Number.parseInt(body.drawNumber ?? '', 10);
  if (!Number.isInteger(drawNumber) || drawNumber <= 0) {
    return reply
      .type('text/html')
      .send(newDrawPage({ user: viewUser(request), error: 'Draw number must be a positive whole number.' }));
  }

  const outcome = await createDraw(pool, { drawNumber });
  if (outcome.kind === 'rejected') {
    return reply.type('text/html').send(newDrawPage({ user: viewUser(request), error: outcome.reason }));
  }

  await insertAuditLog(pool, {
    actorId: request.authUser!.id,
    actorLabel: request.authUser!.email,
    action: 'draw_created',
    entity: 'draw',
    entityId: outcome.id,
  });
  reply.redirect(`/draws/${outcome.id}`);
});

app.get('/draws/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const draw = await getDraw(pool, id);
  if (!draw) return reply.code(404).type('text/html').send('<p>Draw not found.</p>');
  const open = draw.status === 'open';
  const members = open ? await listMembers(pool) : undefined;
  const liveEntryCount = open ? await countEntries(pool, id) : undefined;
  reply.type('text/html').send(
    drawDetailPage({
      user: viewUser(request),
      draw,
      ...(members ? { members } : {}),
      ...(liveEntryCount !== undefined ? { liveEntryCount } : {}),
    }),
  );
});

app.post('/draws/:id/entries', async (request, reply) => {
  if (!requireCsrf(request, reply, request.authCsrf!)) return;

  const { id } = request.params as { id: string };
  const draw = await getDraw(pool, id);
  if (!draw) return reply.code(404).type('text/html').send('<p>Draw not found.</p>');

  const body = request.body as { memberId?: string; selection?: string };
  const memberId = (body.memberId ?? '').trim();
  const selection = (body.selection ?? '')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));

  const respond = async (error: string) => {
    const members = await listMembers(pool);
    return reply.type('text/html').send(drawDetailPage({ user: viewUser(request), draw, members, error }));
  };

  if (!memberId) return respond('A member is required.');

  const outcome = await addEntry(pool, { drawId: id, memberId, selection });
  if (outcome.kind === 'rejected') return respond(outcome.reason);

  await insertAuditLog(pool, {
    actorId: request.authUser!.id,
    actorLabel: request.authUser!.email,
    action: 'entry_added',
    entity: 'entry',
    entityId: outcome.entryId,
  });

  const refreshed = (await getDraw(pool, id))!;
  const members = await listMembers(pool);
  reply.type('text/html').send(drawDetailPage({ user: viewUser(request), draw: refreshed, members, flash: 'Entry added.' }));
});

app.post('/draws/:id/run', async (request, reply) => {
  if (!requireCsrf(request, reply, request.authCsrf!)) return;

  const { id } = request.params as { id: string };
  const draw = await getDraw(pool, id);
  if (!draw) return reply.code(404).type('text/html').send('<p>Draw not found.</p>');
  if (draw.status !== 'open') {
    return reply
      .type('text/html')
      .send(drawDetailPage({ user: viewUser(request), draw, error: `Draw is already '${draw.status}'.` }));
  }

  const entriesCount = await countEntries(pool, id);
  const { workflowId } = await startDrawWorkflow({ drawId: id, drawNumber: draw.drawNumber, entriesCount });
  await closeDrawAndRecordWorkflow(pool, id, workflowId, entriesCount);

  await insertAuditLog(pool, {
    actorId: request.authUser!.id,
    actorLabel: request.authUser!.email,
    action: 'draw_run',
    entity: 'draw',
    entityId: id,
    workflowId,
    after: { entriesCount },
  });

  reply.redirect(`/draws/${id}`);
});

app.get('/members', async (request, reply) => {
  const members = await listMembers(pool);
  reply.type('text/html').send(membersPage({ user: viewUser(request), members }));
});

app.post('/members', async (request, reply) => {
  if (!requireCsrf(request, reply, request.authCsrf!)) return;

  const body = request.body as { forename?: string; surname?: string };
  const forename = (body.forename ?? '').trim();
  const surname = (body.surname ?? '').trim();
  if (!forename || !surname) {
    const members = await listMembers(pool);
    return reply
      .type('text/html')
      .send(membersPage({ user: viewUser(request), members, error: 'Forename and surname are both required.' }));
  }

  const { id } = await createMember(pool, { forename, surname });
  await insertAuditLog(pool, {
    actorId: request.authUser!.id,
    actorLabel: request.authUser!.email,
    action: 'member_created',
    entity: 'member',
    entityId: id,
  });

  const members = await listMembers(pool);
  reply.type('text/html').send(membersPage({ user: viewUser(request), members, flash: 'Member added.' }));
});

app.get('/bank-statements', async (request, reply) => {
  const statements = await listBankStatements(pool);
  reply.type('text/html').send(bankStatementsPage({ user: viewUser(request), statements }));
});

app.post('/bank-statements', async (request, reply) => {
  if (!requireCsrf(request, reply, request.authCsrf!)) return;

  const body = request.body as { csv?: string };
  const csv = (body.csv ?? '').trim();
  if (!csv) {
    const statements = await listBankStatements(pool);
    return reply
      .type('text/html')
      .send(bankStatementsPage({ user: viewUser(request), statements, error: 'CSV content is required.' }));
  }

  const filePath = join(bankFeedCsvDir, `upload-${randomUUID()}.csv`);
  try {
    await mkdir(bankFeedCsvDir, { recursive: true });
    await writeFile(filePath, csv, 'utf8');

    const bankFeed = new CsvBankFeed(bankFeedCsvDir);
    const results = await ingestNewStatements(pool, bankFeed, {
      actorId: request.authUser!.id,
      actorLabel: request.authUser!.email,
    });
    const statements = await listBankStatements(pool);
    const ingested = results.find((r) => !r.alreadyIngested);
    const flash = ingested
      ? `Statement ${ingested.statementNumber} ingested: ${ingested.matched} matched, ` +
        `${ingested.ambiguous + ingested.unmatched} sent for review.`
      : 'Nothing new to ingest — this statement number is already recorded.';
    reply.type('text/html').send(bankStatementsPage({ user: viewUser(request), statements, flash }));
  } catch (error) {
    const statements = await listBankStatements(pool);
    reply.type('text/html').send(
      bankStatementsPage({
        user: viewUser(request),
        statements,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
});

app.get('/bank-statements/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const statement = await getBankStatement(pool, id);
  if (!statement) return reply.code(404).type('text/html').send('<p>Statement not found.</p>');
  reply.type('text/html').send(bankStatementDetailPage({ user: viewUser(request), statement }));
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
  const body = request.body as { note?: string; mechanism?: string };
  const task = await getTask(pool, id);
  if (!task) return reply.code(404).type('text/html').send('<p>Task not found.</p>');

  const note = (body.note ?? '').trim();
  if (!note) {
    return reply.type('text/html').send(taskDetailPage({ user: viewUser(request), task, error: 'A resolution note is required.' }));
  }

  // GAP-24 is still undecided — collected from the human, never defaulted.
  const mechanism = (body.mechanism ?? '').trim();
  if (task.kind === 'must_be_won_decision' && !mechanism) {
    return reply
      .type('text/html')
      .send(taskDetailPage({ user: viewUser(request), task, error: 'A must-be-won mechanism is required.' }));
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

  if (outcome.kind !== 'resolved') {
    return reply.type('text/html').send(
      taskDetailPage({
        user: viewUser(request),
        task: refreshed,
        flash: 'First approval recorded — a different person must approve it a second time.',
      }),
    );
  }

  // Fully resolved. The DB write above already happened — a Temporal signal,
  // once accepted, can't be rolled back, so the human decision stays recorded
  // regardless of what happens next.
  let flash = 'Task resolved.';
  if (refreshed.firstApproverId && refreshed.secondApproverId) {
    const [firstApprover, secondApprover] = await Promise.all([
      findUserById(pool, refreshed.firstApproverId),
      findUserById(pool, refreshed.secondApproverId),
    ]);
    const delivery = await deliverTaskDecision(refreshed, {
      decidedBy: firstApprover?.email ?? refreshed.firstApproverId,
      secondApproverId: secondApprover?.email ?? refreshed.secondApproverId,
      mechanism,
      note,
    });

    if (delivery.kind === 'delivered') {
      await insertAuditLog(pool, {
        actorId: request.authUser!.id,
        actorLabel: request.authUser!.email,
        action: 'human_task_signal_delivered',
        entity: 'human_task',
        entityId: id,
        ...(refreshed.workflowId ? { workflowId: refreshed.workflowId } : {}),
        ...(refreshed.runId ? { runId: refreshed.runId } : {}),
        after: { signalName: refreshed.signalName },
      });
    } else if (delivery.kind === 'failed') {
      flash = `Task resolved, but delivering the decision to the running process failed: ${delivery.reason} — an operator must check Temporal directly.`;
      await insertAuditLog(pool, {
        actorId: request.authUser!.id,
        actorLabel: request.authUser!.email,
        action: 'human_task_signal_delivery_failed',
        entity: 'human_task',
        entityId: id,
        ...(refreshed.workflowId ? { workflowId: refreshed.workflowId } : {}),
        ...(refreshed.runId ? { runId: refreshed.runId } : {}),
        after: { reason: delivery.reason },
      });
    }
    // 'skipped' — no signal to deliver for this task; nothing to report.
  }

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
