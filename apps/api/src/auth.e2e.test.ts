/**
 * Member portal authentication (GAP-04), black-box: the real API process, a
 * real PostgreSQL, HTTP only.
 *
 * Set TEST_APP_DB_URL to run. Without it the suite skips rather than silently
 * passing, so a green CI run with no database does not look like proof.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrate, type Pool } from '@qosfc/db';
import { CookieJar, http, REPO_ROOT, startServer, type RunningServer } from '../../../tools/test-support/server-process.js';
import { createPasswordReset, registerMember } from './db.js';

const url = process.env['TEST_APP_DB_URL'];
const describeDb = url ? describe : describe.skip;

const SESSION = 'qosfc_member_session';
const PASSWORD = 'a perfectly long password';

describeDb('member portal authentication (GAP-04)', () => {
  let pool: Pool;
  let server: RunningServer;
  let seq = 0;
  const freshEmail = () => `member${++seq}-${Date.now()}@example.com`;

  async function register(email: string, password = PASSWORD) {
    return http(server.baseUrl, '/register', { json: { forename: 'Pat', surname: 'Member', email, password } });
  }

  async function login(email: string, password = PASSWORD): Promise<{ jar: CookieJar; csrf: string; status: number }> {
    const jar = new CookieJar();
    const res = await http(server.baseUrl, '/login', { json: { email, password }, jar });
    return { jar, status: res.status, csrf: res.status === 200 ? (JSON.parse(res.text) as { csrf: string }).csrf : '' };
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, applicationName: 'qosfc-member-auth-e2e', max: 2 });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await migrate(pool, resolve(REPO_ROOT, 'db/migrations'), () => {});

    const dir = mkdtempSync(join(tmpdir(), 'qosfc-api-e2e-'));
    writeFileSync(join(dir, 'session'), randomBytes(32).toString('hex'));
    server = await startServer('apps/api/src/index.ts', {
      APP_DB_URL: url!,
      SESSION_SECRET_FILE: join(dir, 'session'),
      // Nothing listens here: notifications are best-effort and must fail fast.
      SANDBOX_PROVIDERS_URL: 'http://127.0.0.1:9',
    });
  });

  afterAll(async () => {
    await server?.stop();
    await pool?.end();
  });

  describe('registration', () => {
    it('creates an active member with an argon2id credential, never the plaintext', async () => {
      const email = freshEmail();
      const res = await register(email);
      expect(res.status).toBe(201);
      const { rows } = await pool.query(
        `SELECT m.status, c.password_hash FROM member m JOIN member_credential c ON c.member_id = m.id WHERE m.email = $1`,
        [email],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('active');
      expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
      expect(rows[0].password_hash).not.toContain(PASSWORD);
    });

    it('refuses a password under 10 characters', async () => {
      expect((await register(freshEmail(), 'short')).status).toBe(400);
    });

    it('does not confirm that an email is already registered (no 409, generic message)', async () => {
      const email = freshEmail();
      await register(email);
      const again = await register(email.toUpperCase());
      expect(again.status).toBe(400);
      expect(JSON.parse(again.text)).toEqual({ error: 'Could not register with those details.' });
    });
  });

  describe('login', () => {
    it('gives an unknown email and a wrong password the identical response and no cookie', async () => {
      const email = freshEmail();
      await register(email);
      const unknown = await http(server.baseUrl, '/login', { json: { email: freshEmail(), password: PASSWORD } });
      const wrong = await http(server.baseUrl, '/login', { json: { email, password: 'wrong password!!' } });
      expect(unknown.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(unknown.text).toBe(wrong.text);
      expect(unknown.res.headers.getSetCookie()).toEqual([]);
      expect(wrong.res.headers.getSetCookie()).toEqual([]);
    });

    it('sets an httpOnly, SameSite=Lax session cookie and /me then knows the member', async () => {
      const email = freshEmail();
      await register(email);
      const jar = new CookieJar();
      const res = await http(server.baseUrl, '/login', { json: { email, password: PASSWORD }, jar });
      expect(res.status).toBe(200);
      const cookie = res.res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION}=`))!;
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      const me = await http(server.baseUrl, '/me', { jar });
      expect(me.status).toBe(200);
      const body = JSON.parse(me.text) as { member: Record<string, unknown> };
      expect(body.member['email']).toBe(email);
      expect(body.member).not.toHaveProperty('passwordHash');
    });

    it('/me without a session is 401', async () => {
      expect((await http(server.baseUrl, '/me')).status).toBe(401);
    });

    it('a member who is no longer active cannot log in, and their session stops working', async () => {
      const email = freshEmail();
      await register(email);
      const { jar } = await login(email);
      await pool.query(`UPDATE member SET status = 'lapsed' WHERE email = $1`, [email]);
      expect((await login(email)).status).toBe(401);
      expect((await http(server.baseUrl, '/me', { jar })).status).toBe(401);
    });

    it('rejects a session cookie whose payload was edited to another member', async () => {
      const victim = freshEmail();
      const attacker = freshEmail();
      const victimId = (JSON.parse((await register(victim)).text) as { memberId: string }).memberId;
      await register(attacker);
      const { jar } = await login(attacker);
      const raw = decodeURIComponent(jar.get(SESSION)!);
      const sig = raw.slice(raw.lastIndexOf('.'));
      jar.set(SESSION, encodeURIComponent(JSON.stringify({ mid: victimId, csrf: 'x' }) + sig));
      expect((await http(server.baseUrl, '/me', { jar })).status).toBe(401);
    });
  });

  describe('post-login redirect (no open redirect)', () => {
    it.each([
      ['/draw', '/draw'],
      ['/draw/pay?lines=1', '/draw/pay?lines=1'],
      ['https://evil.example/draw', '/draw'],
      ['//evil.example/draw', '/draw'],
      ['/\\evil.example', '/draw'],
      ['/draw/../account', '/draw'],
      ['/account', '/draw'],
      ['javascript:alert(1)', '/draw'],
    ])('next=%j → %s', async (next, expected) => {
      const email = freshEmail();
      await register(email);
      const res = await http(server.baseUrl, '/login', { form: { email, password: PASSWORD, next } });
      expect(res.status).toBe(302);
      expect(res.location).toBe(expected);
    });
  });

  describe('CSRF on state-changing member routes', () => {
    it('refuses a JSON purchase with no or the wrong CSRF token, before doing anything', async () => {
      const email = freshEmail();
      await register(email);
      const { jar, csrf } = await login(email);
      for (const headers of [{}, { 'x-csrf-token': 'nope' }]) {
        const res = await http(server.baseUrl, '/entries/purchase', { json: { selection: [1, 2, 3, 4] }, jar, headers });
        expect(res.status).toBe(403);
      }
      const ok = await http(server.baseUrl, '/entries/purchase', { json: { selection: [1, 2, 3, 4] }, jar, headers: { 'x-csrf-token': csrf } });
      expect(ok.status).not.toBe(403);
    });

    it('refuses a /details form post without the token and leaves the details unchanged', async () => {
      const email = freshEmail();
      await register(email);
      const { jar, csrf } = await login(email);
      const res = await http(server.baseUrl, '/details', { form: { telephone: '07000 000000' }, jar });
      expect(res.status).toBe(403);
      const { rows } = await pool.query(`SELECT telephone FROM member WHERE email = $1`, [email]);
      expect(rows[0].telephone ?? '').toBe('');
      const saved = await http(server.baseUrl, '/details', { form: { telephone: '07000 000000', csrf }, jar });
      expect(saved.status).toBe(200);
      expect((await pool.query(`SELECT telephone FROM member WHERE email = $1`, [email])).rows[0].telephone).toBe('07000 000000');
    });
  });

  describe('password reset', () => {
    it('answers identically for a registered and an unregistered email, and stores only a token hash', async () => {
      const email = freshEmail();
      await register(email);
      const known = await http(server.baseUrl, '/forgot-password', { form: { email } });
      const unknown = await http(server.baseUrl, '/forgot-password', { form: { email: freshEmail() } });
      expect(known.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(known.text).toBe(unknown.text);
      const { rows } = await pool.query(
        `SELECT r.token_hash FROM member_password_reset r JOIN member m ON m.id = r.member_id WHERE m.email = $1`,
        [email],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('a valid token sets the new password once; the old password and the token then stop working', async () => {
      const email = freshEmail();
      await register(email);
      const { token } = (await createPasswordReset(pool, email))!;
      const newPassword = 'a brand new long password';

      const reset = await http(server.baseUrl, '/reset-password', { form: { token, password: newPassword } });
      expect(reset.status).toBe(200);
      expect((await login(email)).status).toBe(401);
      expect((await login(email, newPassword)).status).toBe(200);

      const replay = await http(server.baseUrl, '/reset-password', { form: { token, password: 'yet another long password' } });
      expect(replay.status).toBe(400);
      expect((await login(email, newPassword)).status).toBe(200);
    });

    it('refuses an expired token', async () => {
      const email = freshEmail();
      await register(email);
      const { token } = (await createPasswordReset(pool, email))!;
      await pool.query(
        `UPDATE member_password_reset SET expires_at = now() - interval '1 second'
          WHERE member_id = (SELECT id FROM member WHERE email = $1)`,
        [email],
      );
      const res = await http(server.baseUrl, '/reset-password', { form: { token, password: 'a brand new long password' } });
      expect(res.status).toBe(400);
      expect(res.text).toContain('expired');
      expect((await login(email)).status).toBe(200);
    });

    it('requesting a new link invalidates the previous one', async () => {
      const email = freshEmail();
      await register(email);
      const first = (await createPasswordReset(pool, email))!.token;
      await createPasswordReset(pool, email);
      const res = await http(server.baseUrl, '/reset-password', { form: { token: first, password: 'a brand new long password' } });
      expect(res.status).toBe(400);
    });

    it('refuses a too-short new password without consuming the token', async () => {
      const email = freshEmail();
      await register(email);
      const { token } = (await createPasswordReset(pool, email))!;
      expect((await http(server.baseUrl, '/reset-password', { form: { token, password: 'short' } })).status).toBe(400);
      expect((await http(server.baseUrl, '/reset-password', { form: { token, password: 'long enough password' } })).status).toBe(200);
    });
  });

  describe('known gaps (it.fails — flip to it() when fixed)', () => {
    it.fails('a password reset ends sessions opened with the old password', async () => {
      const email = freshEmail();
      await register(email);
      const { jar: stolen } = await login(email);
      const { token } = (await createPasswordReset(pool, email))!;
      await http(server.baseUrl, '/reset-password', { form: { token, password: 'a brand new long password' } });
      expect((await http(server.baseUrl, '/me', { jar: stolen })).status).toBe(401);
    });

    it.fails('concurrent registrations with one email create one member (member.email is not unique)', async () => {
      // Exercised at the function /register calls: over HTTP the argon2 hash
      // staggers requests enough to hide the race, but two members double-
      // clicking "Register" (or a retrying proxy) can still land together.
      // registerMember() checks then inserts, and nothing in the schema stops
      // the second insert. Reproduces on every attempt at this concurrency.
      const email = freshEmail();
      const racePool = createPool({ connectionString: url!, applicationName: 'qosfc-register-race', max: 20 });
      try {
        await Promise.all(
          Array.from({ length: 20 }, () => registerMember(racePool, { forename: 'Pat', surname: 'Member', email, passwordHash: 'x' })),
        );
      } finally {
        await racePool.end();
      }
      const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM member WHERE email = $1`, [email]);
      expect(Number(rows[0]!.n)).toBe(1);
    });

    it.fails('GAP-04: a legacy member with an email on file can get a portal login', async () => {
      // An imported register member: email on file, no member_credential.
      const email = freshEmail();
      await pool.query(`INSERT INTO member (forename, surname, email, status) VALUES ('Legacy', 'Member', $1, 'active')`, [email]);
      // /register says the email is taken; /forgot-password finds no portal
      // login to reset. One of them has to let this person in.
      const registered = (await register(email)).status === 201;
      const resetIssued = (await createPasswordReset(pool, email)) !== undefined;
      expect(registered || resetIssued).toBe(true);
    });

    it.fails('repeated wrong passwords are throttled', async () => {
      const email = freshEmail();
      await register(email);
      const statuses: number[] = [];
      for (let i = 0; i < 30; i += 1) {
        statuses.push((await http(server.baseUrl, '/login', { json: { email, password: `guess-number-${i}` } })).status);
      }
      expect(statuses).toContain(429);
    });
  });
});
