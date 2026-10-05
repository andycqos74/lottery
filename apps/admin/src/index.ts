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
import {
  acceptBankTransactionMatchTx,
  allocateUpcomingEntries,
  generateDueEntries,
  ingestNewStatements,
  recordManualTicket,
  type ManualTicketSelectionInput,
} from '@qosfc/activities';
import { CsvBankFeed } from '@qosfc/adapters-live';
import { formatPence, pence, TICKET_PRICE_PENCE } from '@qosfc/domain';
import {
  addEntry,
  createDraws,
  createMember,
  dashboardCounts,
  findUserByEmail,
  findUserById,
  getBankStatement,
  getBankTransactionForReview,
  getDraw,
  getDrawFormDefaults,
  getJackpotInputs,
  getMemberPage,
  getTask,
  insertAuditLog,
  listBankStatements,
  listDrawEntrants,
  listDraws,
  listAgentMembers,
  listMembers,
  listTasksByStatus,
  nextDrawNumber,
  renameDraw,
  resolveTaskStep,
  touchLastLogin,
  type AppUser,
} from './db.js';
import {
  bankStatementDetailPage,
  bankStatementsPage,
  dashboardPage,
  drawDetailPage,
  drawEntrantsPage,
  drawsPage,
  loginPage,
  memberDetailPage,
  membersPage,
  mfaPage,
  newDrawPage,
  taskDetailPage,
  tasksPage,
  type NewDrawFormValues,
} from './views.js';
import { planOneOffDraw, planRecurringDraws, type Recurrence } from './draw-schedule.js';
import { decryptSecret } from './secret-box.js';
import { verifyTotp } from './totp.js';
import { deliverTaskDecision, notifyEscalationTaskClosed, startDrawWorkflow } from './temporal.js';

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
  const [draws, jackpotInputs] = await Promise.all([listDraws(pool), getJackpotInputs(pool)]);
  reply.type('text/html').send(drawsPage({ user: viewUser(request), draws, jackpotInputs }));
});

async function newDrawFormDefaults(): Promise<NewDrawFormValues> {
  const [drawNumber, defaults] = await Promise.all([nextDrawNumber(pool), getDrawFormDefaults(pool)]);
  // #4: deliberately no default draw date — it used to be silently "today".
  return {
    mode: 'one_off',
    name: '',
    drawNumber: String(drawNumber),
    drawAt: '',
    entriesCloseAt: '',
    startDate: '',
    endDate: '',
    recurrence: 'weekly',
    drawTime: defaults.drawTimeLocal,
    cutoffHours: String(defaults.cutoffHoursBefore),
  };
}

app.get('/draws/new', async (request, reply) => {
  reply.type('text/html').send(newDrawPage({ user: viewUser(request), values: await newDrawFormDefaults() }));
});

app.post('/draws', async (request, reply) => {
  if (!requireCsrf(request, reply, request.authCsrf!)) return;

  const body = request.body as Partial<Record<keyof NewDrawFormValues, string>>;
  const values: NewDrawFormValues = {
    mode: body.mode === 'recurring' ? 'recurring' : 'one_off',
    name: (body.name ?? '').trim(),
    drawNumber: (body.drawNumber ?? '').trim(),
    drawAt: (body.drawAt ?? '').trim(),
    entriesCloseAt: (body.entriesCloseAt ?? '').trim(),
    startDate: (body.startDate ?? '').trim(),
    endDate: (body.endDate ?? '').trim(),
    recurrence: (body.recurrence ?? 'weekly').trim(),
    drawTime: (body.drawTime ?? '').trim(),
    cutoffHours: (body.cutoffHours ?? '').trim(),
  };
  const respond = (error: string) => reply.type('text/html').send(newDrawPage({ user: viewUser(request), values, error }));

  const drawNumber = /^\d+$/.test(values.drawNumber) ? Number(values.drawNumber) : NaN;
  if (!Number.isInteger(drawNumber) || drawNumber <= 0) return respond('Draw number must be a positive whole number.');
  if (values.name.length > 120) return respond('Draw name must be 120 characters or fewer.');

  const plan =
    values.mode === 'recurring'
      ? planRecurringDraws({
          firstDrawNumber: drawNumber,
          startDate: values.startDate,
          endDate: values.endDate,
          recurrence: values.recurrence as Recurrence,
          drawTimeLocal: values.drawTime,
          cutoffHoursBefore: /^\d+$/.test(values.cutoffHours) ? Number(values.cutoffHours) : NaN,
        })
      : planOneOffDraw({ drawNumber, drawAtLocal: values.drawAt, entriesCloseAtLocal: values.entriesCloseAt });
  if (plan.kind === 'rejected') return respond(plan.reason);

  const outcome = await createDraws(pool, {
    name: values.name || null,
    draws: plan.draws,
    createdBy: request.authUser!.id,
    ...(values.mode === 'recurring'
      ? {
          schedule: {
            startDate: values.startDate,
            endDate: values.endDate,
            recurrence: values.recurrence,
            drawTimeLocal: values.drawTime,
            cutoffHoursBefore: Number(values.cutoffHours),
          },
        }
      : {}),
  });
  if (outcome.kind === 'rejected') return respond(outcome.reason);

  for (const [i, id] of outcome.ids.entries()) {
    await insertAuditLog(pool, {
      actorId: request.authUser!.id,
      actorLabel: request.authUser!.email,
      action: 'draw_created',
      entity: 'draw',
      entityId: id,
      after: { ...plan.draws[i], name: values.name || null, mode: values.mode },
    });
  }
  // Prepaid weeks waiting for draws to exist go into the new ones now. Not
  // fatal: running each draw still enters anyone with weeks left.
  await allocateUpcomingEntries(pool, { actorId: request.authUser!.id, actorLabel: request.authUser!.email }).catch((error: unknown) =>
    request.log.warn({ err: error }, 'could not place prepaid weeks into newly created draws'),
  );
  reply.redirect(outcome.ids.length === 1 ? `/draws/${outcome.ids[0]}` : '/draws');
});

/** Re-reads the draw (and, while it is open, the entry forms' pick lists) and renders its page. */
async function sendDrawPage(
  request: FastifyRequest,
  reply: FastifyReply,
  id: string,
  message: { error?: string; flash?: string } = {},
): Promise<FastifyReply> {
  const draw = await getDraw(pool, id);
  if (!draw) return reply.code(404).type('text/html').send('<p>Draw not found.</p>');
  const open = draw.status === 'open';
  const [jackpotInputs, members, agents] = await Promise.all([
    getJackpotInputs(pool),
    open ? listMembers(pool) : undefined,
    open ? listAgentMembers(pool) : undefined,
  ]);
  return reply.type('text/html').send(
    drawDetailPage({
      user: viewUser(request),
      draw,
      jackpotInputs,
      ...(members ? { members } : {}),
      ...(agents ? { agents } : {}),
      ...message,
    }),
  );
}

app.get('/draws/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  return sendDrawPage(request, reply, id);
});

app.get('/draws/:id/entrants', async (request, reply) => {
  const { id } = request.params as { id: string };
  const draw = await getDraw(pool, id);
  if (!draw) return reply.code(404).type('text/html').send('<p>Draw not found.</p>');
  const entrants = await listDrawEntrants(pool, id);
  return reply.type('text/html').send(drawEntrantsPage({ user: viewUser(request), draw, entrants }));
});

app.post('/draws/:id/name', async (request, reply) => {
  if (!requireCsrf(request, reply, request.authCsrf!)) return;

  const { id } = request.params as { id: string };
  const draw = await getDraw(pool, id);
  if (!draw) return reply.code(404).type('text/html').send('<p>Draw not found.</p>');

  const name = ((request.body as { name?: string }).name ?? '').trim();
  if (name.length > 120) return sendDrawPage(request, reply, id, { error: 'Draw name must be 120 characters or fewer.' });

  await renameDraw(pool, id, name || null);
  await insertAuditLog(pool, {
    actorId: request.authUser!.id,
    actorLabel: request.authUser!.email,
    action: 'draw_renamed',
    entity: 'draw',
    entityId: id,
    before: { name: draw.name },
    after: { name: name || null },
  });
  return sendDrawPage(request, reply, id, { flash: name ? `Draw name saved.` : 'Draw name cleared.' });
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

  if (!memberId) return sendDrawPage(request, reply, id, { error: 'A member is required.' });

  const outcome = await addEntry(pool, { drawId: id, memberId, selection });
  if (outcome.kind === 'rejected') return sendDrawPage(request, reply, id, { error: outcome.reason });

  await insertAuditLog(pool, {
    actorId: request.authUser!.id,
    actorLabel: request.authUser!.email,
    action: 'entry_added',
    entity: 'entry',
    entityId: outcome.entryId,
  });

  return sendDrawPage(request, reply, id, { flash: 'Entry added.' });
});

// A physical ticket can cover up to two years of weekly draws.
const MAX_TICKET_WEEKS = 104;

app.post('/draws/:id/manual-tickets', async (request, reply) => {
  if (!requireCsrf(request, reply, request.authCsrf!)) return;

  const { id } = request.params as { id: string };
  const draw = await getDraw(pool, id);
  if (!draw) return reply.code(404).type('text/html').send('<p>Draw not found.</p>');

  const body = request.body as {
    agentMemberId?: string;
    physicalTicketNumber?: string;
    purchaseDate?: string;
    weeks?: string;
    confirmPaid?: string;
    selectionMode?: string;
    selection?: string;
  };
  const respond = (error: string) => sendDrawPage(request, reply, id, { error });

  const agentMemberId = (body.agentMemberId ?? '').trim();
  const physicalTicketNumber = (body.physicalTicketNumber ?? '').trim();
  const purchaseDate = (body.purchaseDate ?? '').trim();
  if (!agentMemberId) return respond('An agent is required.');
  if (!physicalTicketNumber) return respond('A physical ticket number is required.');
  if (!purchaseDate) return respond('A purchase date is required.');

  // #6: the admin enters weeks; the amount is derived, never typed.
  const weeksRaw = (body.weeks ?? '').trim();
  const weeks = /^\d+$/.test(weeksRaw) ? Number(weeksRaw) : NaN;
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > MAX_TICKET_WEEKS) {
    return respond(`Number of weeks must be a whole number from 1 to ${MAX_TICKET_WEEKS}.`);
  }
  if (body.confirmPaid !== 'yes') return respond('Tick the box to confirm the money for this ticket has been paid.');
  const amountPence = TICKET_PRICE_PENCE * BigInt(weeks);

  const selection: ManualTicketSelectionInput =
    body.selectionMode === 'manual'
      ? {
          mode: 'manual',
          numbers: (body.selection ?? '')
            .split(',')
            .map((s) => Number.parseInt(s.trim(), 10))
            .filter((n) => !Number.isNaN(n)),
        }
      : { mode: 'random' };

  const outcome = await recordManualTicket(pool, {
    memberId: agentMemberId,
    physicalTicketNumber,
    purchaseDate,
    amountPence,
    selection,
    actorId: request.authUser!.id,
    actorLabel: request.authUser!.email,
  });

  if (outcome.kind === 'rejected') return respond(outcome.reason);
  if (outcome.kind === 'already_recorded') return respond(`Ticket ${physicalTicketNumber} was already recorded.`);

  // Every week bought goes into the next draws on sale right away — this one
  // first if entries are still open, then each following draw (one entry per
  // draw), so they all show on the Draws page now. Weeks beyond the draws that
  // exist are placed when more draws are created, or when a draw is run.
  // GAP-17 may still be unactivated in a given environment — the ticket is
  // already recorded at this point, so that failure must not look like the
  // whole action failed; report it as a flash, not a 500.
  let entryFlash = '';
  try {
    const placed = await allocateUpcomingEntries(pool, { memberId: agentMemberId, actorId: request.authUser!.id, actorLabel: request.authUser!.email });
    entryFlash =
      `Entered into ${placed.entriesPlaced} upcoming draw${placed.entriesPlaced === 1 ? '' : 's'}.` +
      (placed.weeksWaitingForDraws > 0 ? ` ${placed.weeksWaitingForDraws} week(s) will be entered as more draws are created.` : '');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    entryFlash = `Recorded, but could not enter it into draws yet: ${message}`;
  }

  await insertAuditLog(pool, {
    actorId: request.authUser!.id,
    actorLabel: request.authUser!.email,
    action: 'manual_ticket_entered',
    entity: 'draw',
    entityId: id,
    after: {
      paymentId: outcome.paymentId,
      prizeDrawNo: outcome.prizeDrawNo,
      weeks,
      amountPence: amountPence.toString(),
      paymentConfirmed: true,
      blocksPurchased: outcome.blocksPurchased,
    },
  });

  return sendDrawPage(request, reply, id, {
    flash: `Recorded ticket ${physicalTicketNumber}: ${weeks} week${weeks === 1 ? '' : 's'}, ${formatPence(pence(amountPence))} paid. ${entryFlash}`,
  });
});

app.post('/draws/:id/generate-entries', async (request, reply) => {
  if (!requireCsrf(request, reply, request.authCsrf!)) return;

  const { id } = request.params as { id: string };
  const draw = await getDraw(pool, id);
  if (!draw) return reply.code(404).type('text/html').send('<p>Draw not found.</p>');

  try {
    const result = await generateDueEntries(pool, { drawId: id, actorId: request.authUser!.id, actorLabel: request.authUser!.email });
    await insertAuditLog(pool, {
      actorId: request.authUser!.id,
      actorLabel: request.authUser!.email,
      action: 'draw_entries_generated',
      entity: 'draw',
      entityId: id,
      after: result,
    });
    return sendDrawPage(request, reply, id, {
      flash: `Generated ${result.generated} entries (${result.directDebitGenerated} Direct Debit, ${result.generated - result.directDebitGenerated} prepaid) from ${result.candidatesConsidered} members considered.`,
    });
  } catch (error) {
    // GAP-17 is resolved (prepaid_blocks), but that only takes effect once
    // `pnpm activate-config` has actually written and activated a
    // config_version row carrying it — until then entriesDue() halts here
    // exactly as it's meant to (gap-register.md), and this is where that
    // becomes a readable message instead of a 500.
    const message = error instanceof Error ? error.message : String(error);
    return sendDrawPage(request, reply, id, { error: message });
  }
});

app.post('/draws/:id/run', async (request, reply) => {
  if (!requireCsrf(request, reply, request.authCsrf!)) return;

  const { id } = request.params as { id: string };
  const draw = await getDraw(pool, id);
  if (!draw) return reply.code(404).type('text/html').send('<p>Draw not found.</p>');
  if (draw.status !== 'open') return sendDrawPage(request, reply, id, { error: `Draw is already '${draw.status}'.` });

  // #9/#11: the workflow itself enters every Direct Debit member and every
  // member with prepaid weeks left, then closes the draw — so the same run
  // happens whether a human presses this or the scheduled dispatcher reaches
  // the draw's time first. If entries can't be generated (e.g. GAP-17 not
  // activated) the run blocks on a task in the inbox rather than going ahead
  // without paid-up members.
  let workflowId: string;
  try {
    ({ workflowId } = await startDrawWorkflow({ drawId: id, drawNumber: draw.drawNumber }));
  } catch (error) {
    if (error instanceof Error && error.name === 'WorkflowExecutionAlreadyStartedError') {
      return sendDrawPage(request, reply, id, { error: 'This draw is already running — it may have been started automatically at its draw time.' });
    }
    throw error;
  }

  await insertAuditLog(pool, {
    actorId: request.authUser!.id,
    actorLabel: request.authUser!.email,
    action: 'draw_run',
    entity: 'draw',
    entityId: id,
    workflowId,
  });

  reply.redirect(`/draws/${id}`);
});

app.get('/members', async (request, reply) => {
  const members = await listMembers(pool);
  reply.type('text/html').send(membersPage({ user: viewUser(request), members }));
});

app.post('/members', async (request, reply) => {
  if (!requireCsrf(request, reply, request.authCsrf!)) return;

  const body = request.body as { forename?: string; surname?: string; memberType?: string };
  const forename = (body.forename ?? '').trim();
  const surname = (body.surname ?? '').trim();
  const memberType = body.memberType === 'agent' ? 'agent' : 'player';
  if (!forename || !surname) {
    const members = await listMembers(pool);
    return reply
      .type('text/html')
      .send(membersPage({ user: viewUser(request), members, error: 'Forename and surname are both required.' }));
  }

  const { id } = await createMember(pool, { forename, surname, memberType });
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

app.get('/members/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const member = await getMemberPage(pool, id);
  if (!member) return reply.code(404).type('text/html').send('<p>Member not found.</p>');
  return reply.type('text/html').send(memberDetailPage({ user: viewUser(request), member }));
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
  const bankTransaction =
    task.kind === 'bank_transaction_review' && task.entityId ? await getBankTransactionForReview(pool, task.entityId) : undefined;
  reply.type('text/html').send(taskDetailPage({ user: viewUser(request), task, ...(bankTransaction ? { bankTransaction } : {}) }));
});

app.post('/tasks/:id/resolve', async (request, reply) => {
  if (!requireCsrf(request, reply, request.authCsrf!)) return;

  const { id } = request.params as { id: string };
  const body = request.body as { note?: string; mechanism?: string; acceptedPrizeDrawNo?: string };
  const task = await getTask(pool, id);
  if (!task) return reply.code(404).type('text/html').send('<p>Task not found.</p>');

  const rerender = async (error: string) => {
    const bankTransaction =
      task.kind === 'bank_transaction_review' && task.entityId ? await getBankTransactionForReview(pool, task.entityId) : undefined;
    return reply
      .type('text/html')
      .send(taskDetailPage({ user: viewUser(request), task, ...(bankTransaction ? { bankTransaction } : {}), error }));
  };

  const note = (body.note ?? '').trim();
  if (!note) {
    return rerender('A resolution note is required.');
  }

  // GAP-24 is still undecided — collected from the human, never defaulted.
  const mechanism = (body.mechanism ?? '').trim();
  if (task.kind === 'must_be_won_decision' && !mechanism) {
    return rerender('A must-be-won mechanism is required.');
  }

  // FR-5.8.3: picking a candidate is what creates the payment — the task
  // resolution below is just the paper trail that a human looked at it.
  // Applied BEFORE resolving the task, so a rejected match leaves the task
  // open rather than silently closing it with nothing allocated.
  let paymentFlash = '';
  const acceptedPrizeDrawNoRaw = (body.acceptedPrizeDrawNo ?? '').trim();
  if (task.kind === 'bank_transaction_review' && task.entityId && acceptedPrizeDrawNoRaw) {
    const prizeDrawNo = Number.parseInt(acceptedPrizeDrawNoRaw, 10);
    const matchOutcome = await acceptBankTransactionMatchTx(pool, task.entityId, prizeDrawNo, request.authUser!.id);
    if (matchOutcome.kind !== 'accepted') {
      const reason =
        matchOutcome.kind === 'already_decided'
          ? 'This transaction was already matched — refresh and check its current status.'
          : matchOutcome.kind === 'unlinked_prize_draw_no'
            ? 'That prize draw number is not linked to a member, so no payment can be allocated to it.'
            : 'That candidate no longer exists for this transaction.';
      return rerender(reason);
    }
    await insertAuditLog(pool, {
      actorId: request.authUser!.id,
      actorLabel: request.authUser!.email,
      action: 'bank_transaction_matched',
      entity: 'payment',
      entityId: matchOutcome.paymentId,
      after: { bankTransactionId: task.entityId, prizeDrawNo },
    });
    paymentFlash = ` Payment ${matchOutcome.paymentId} allocated to prize draw no. ${prizeDrawNo}.`;
    // The matched money enters the member's upcoming draws now.
    await allocateUpcomingEntries(pool, { actorId: request.authUser!.id, actorLabel: request.authUser!.email }).catch((error: unknown) =>
      request.log.warn({ err: error }, 'could not place matched payment into upcoming draws'),
    );
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
  let flash = `Task resolved.${paymentFlash}`;
  await notifyEscalationTaskClosed(id).catch((error: unknown) =>
    request.log.warn({ err: error }, 'could not tell the escalation workflow its task closed; it will notice on its next check'),
  );

  // GAP-44: a two-approver task only reaches here once both have approved, and
  // the workflow re-checks the quorum itself. A single-approver task (e.g.
  // retry_draw) is decided by whoever resolved it.
  if (refreshed.workflowId && refreshed.signalName) {
    const [firstApprover, secondApprover] = await Promise.all([
      refreshed.firstApproverId ? findUserById(pool, refreshed.firstApproverId) : undefined,
      refreshed.secondApproverId ? findUserById(pool, refreshed.secondApproverId) : undefined,
    ]);
    const delivery = await deliverTaskDecision(refreshed, {
      decidedBy: firstApprover?.email ?? refreshed.firstApproverId ?? request.authUser!.email,
      secondApproverId: secondApprover?.email ?? refreshed.secondApproverId ?? '',
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
