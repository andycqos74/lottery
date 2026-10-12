/**
 * Admin console authentication (T-9.3), black-box: the real server process,
 * a real PostgreSQL, HTTP only.
 *
 * Set TEST_APP_DB_URL to run. Without it the suite skips rather than silently
 * passing, so a green CI run with no database does not look like proof.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash as argon2Hash } from '@node-rs/argon2';
import { createPool, migrate, type Pool } from '@qosfc/db';
import { CookieJar, http, REPO_ROOT, startServer, type RunningServer } from '../../../tools/test-support/server-process.js';
import { encryptSecret } from './secret-box.js';
import { currentTotp, generateTotpSecret } from './totp.js';

const url = process.env['TEST_APP_DB_URL'];
const describeDb = url ? describe : describe.skip;

const SESSION = 'qosfc_admin_session';
const PENDING = 'qosfc_admin_mfa_pending';
const PASSWORD = 'correct horse battery staple';

describeDb('admin console authentication (T-9.3)', () => {
  let pool: Pool;
  let server: RunningServer;
  const mfaKey = randomBytes(32);
  const totpSecret = generateTotpSecret();
  const users: Record<'active' | 'noMfa' | 'inactive', string> = { active: '', noMfa: '', inactive: '' };

  async function addUser(email: string, opts: { mfa: boolean; active: boolean }): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO app_user (email, display_name, password_hash, totp_secret_enc, mfa_enrolled, is_active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [email, email.split('@')[0], await argon2Hash(PASSWORD), opts.mfa ? encryptSecret(totpSecret, mfaKey) : null, opts.mfa, opts.active],
    );
    return rows[0]!.id;
  }

  async function auditCount(action: string, label?: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = $1 AND ($2::text IS NULL OR actor_label = $2)`,
      [action, label ?? null],
    );
    return Number(rows[0]!.n);
  }

  /** Password step only — returns a jar holding just the pending-MFA cookie. */
  async function passwordStep(email = 'jo@qosfc.example'): Promise<CookieJar> {
    const jar = new CookieJar();
    const res = await http(server.baseUrl, '/login', { form: { email, password: PASSWORD }, jar });
    expect(res.status, res.text).toBe(302);
    expect(res.location).toBe('/login/mfa');
    return jar;
  }

  async function fullLogin(): Promise<{ jar: CookieJar; csrf: string }> {
    const jar = await passwordStep();
    const res = await http(server.baseUrl, '/login/mfa', { form: { code: currentTotp(totpSecret) }, jar });
    expect(res.status, res.text).toBe(302);
    const session = jar.get(SESSION);
    expect(session).toBeDefined();
    // The signed value is `<json>.<sig>`, URI-encoded.
    const json = decodeURIComponent(session!).replace(/\.[^.]+$/, '');
    return { jar, csrf: (JSON.parse(json) as { csrf: string }).csrf };
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, applicationName: 'qosfc-admin-auth-e2e', max: 2 });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await migrate(pool, resolve(REPO_ROOT, 'db/migrations'), () => {});

    users.active = await addUser('jo@qosfc.example', { mfa: true, active: true });
    users.noMfa = await addUser('nomfa@qosfc.example', { mfa: false, active: true });
    users.inactive = await addUser('gone@qosfc.example', { mfa: true, active: false });

    const dir = mkdtempSync(join(tmpdir(), 'qosfc-admin-e2e-'));
    writeFileSync(join(dir, 'session'), randomBytes(32).toString('hex'));
    writeFileSync(join(dir, 'mfa'), mfaKey.toString('base64'));
    server = await startServer('apps/admin/src/index.ts', {
      APP_DB_URL: url!,
      SESSION_SECRET_FILE: join(dir, 'session'),
      ADMIN_MFA_KEY_FILE: join(dir, 'mfa'),
      BANK_FEED_CSV_DIR: join(dir, 'bank'),
    });
  });

  afterAll(async () => {
    await server?.stop();
    await pool?.end();
  });

  describe('the auth wall', () => {
    it.each(['/', '/draws', '/draws/new', '/members', '/tasks', '/log', '/direct-debits', '/bank-statements', '/draws?next=/login'])(
      'GET %s without a session redirects to /login',
      async (path) => {
        const res = await http(server.baseUrl, path);
        expect(res.status).toBe(302);
        expect(res.location).toBe('/login');
      },
    );

    it('POST to a mutating route without a session redirects rather than acting', async () => {
      const res = await http(server.baseUrl, '/members', { form: { forename: 'X', surname: 'Y' } });
      expect(res.status).toBe(302);
      expect(res.location).toBe('/login');
      expect((await pool.query(`SELECT 1 FROM member WHERE forename = 'X'`)).rowCount).toBe(0);
    });

    it('serves /healthz and /readyz without a session', async () => {
      expect((await http(server.baseUrl, '/healthz')).status).toBe(200);
      expect((await http(server.baseUrl, '/readyz')).status).toBe(200);
    });
  });

  describe('password step', () => {
    it('gives an unknown email and a wrong password the identical response, and audits both', async () => {
      const before = await auditCount('admin_login_failed');
      const unknown = await http(server.baseUrl, '/login', { form: { email: 'nobody@qosfc.example', password: PASSWORD } });
      const wrong = await http(server.baseUrl, '/login', { form: { email: 'jo@qosfc.example', password: 'not the password' } });
      expect(unknown.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(unknown.text).toBe(wrong.text);
      expect(unknown.res.headers.getSetCookie()).toEqual([]);
      expect(wrong.res.headers.getSetCookie()).toEqual([]);
      expect(await auditCount('admin_login_failed')).toBe(before + 2);
    });

    it('treats a deactivated account exactly like an unknown one', async () => {
      const gone = await http(server.baseUrl, '/login', { form: { email: 'gone@qosfc.example', password: PASSWORD } });
      const unknown = await http(server.baseUrl, '/login', { form: { email: 'nobody@qosfc.example', password: PASSWORD } });
      expect(gone.status).toBe(401);
      expect(gone.text).toBe(unknown.text);
    });

    it('normalises email case and whitespace', async () => {
      const jar = new CookieJar();
      const res = await http(server.baseUrl, '/login', { form: { email: '  JO@QOSFC.example ', password: PASSWORD }, jar });
      expect(res.location).toBe('/login/mfa');
    });

    it('refuses an account with no MFA enrolled, even with the right password', async () => {
      const res = await http(server.baseUrl, '/login', { form: { email: 'nomfa@qosfc.example', password: PASSWORD } });
      expect(res.status).toBe(403);
      expect(res.res.headers.getSetCookie()).toEqual([]);
    });

    it('a correct password alone sets only the pending-MFA cookie, which does not open the console', async () => {
      const jar = await passwordStep();
      expect(jar.get(SESSION)).toBeUndefined();
      expect(jar.get(PENDING)).toBeDefined();
      const res = await http(server.baseUrl, '/members', { jar });
      expect(res.status).toBe(302);
      expect(res.location).toBe('/login');
    });
  });

  describe('MFA step', () => {
    it('without a pending cookie, bounces back to /login', async () => {
      const res = await http(server.baseUrl, '/login/mfa', { form: { code: currentTotp(totpSecret) } });
      expect(res.status).toBe(302);
      expect(res.location).toBe('/login');
    });

    it('rejects a wrong code, audits it, and issues no session', async () => {
      const jar = await passwordStep();
      const before = await auditCount('admin_mfa_failed', 'jo@qosfc.example');
      const good = currentTotp(totpSecret);
      const bad = good === '000000' ? '111111' : '000000';
      const res = await http(server.baseUrl, '/login/mfa', { form: { code: bad }, jar });
      expect(res.status).toBe(401);
      expect(jar.get(SESSION)).toBeUndefined();
      expect(await auditCount('admin_mfa_failed', 'jo@qosfc.example')).toBe(before + 1);
    });

    it('a correct code establishes a session, clears the pending cookie, and audits the login', async () => {
      const before = await auditCount('admin_login', 'jo@qosfc.example');
      const { jar } = await fullLogin();
      expect(jar.get(PENDING)).toBeUndefined();
      const home = await http(server.baseUrl, '/', { jar });
      expect(home.status).toBe(200);
      expect(await auditCount('admin_login', 'jo@qosfc.example')).toBe(before + 1);
      const { rows } = await pool.query(`SELECT last_login_at FROM app_user WHERE id = $1`, [users.active]);
      expect(rows[0].last_login_at).not.toBeNull();
    });
  });

  describe('session integrity', () => {
    it('rejects a session cookie whose payload was edited (signature no longer matches)', async () => {
      const { jar } = await fullLogin();
      const raw = decodeURIComponent(jar.get(SESSION)!);
      const sig = raw.slice(raw.lastIndexOf('.'));
      const tampered = jar.clone();
      tampered.set(SESSION, encodeURIComponent(JSON.stringify({ uid: users.noMfa, csrf: 'x' }) + sig));
      const res = await http(server.baseUrl, '/', { jar: tampered });
      expect(res.status).toBe(302);
      expect(res.location).toBe('/login');
    });

    it('rejects an unsigned session cookie', async () => {
      const jar = new CookieJar();
      jar.set(SESSION, encodeURIComponent(JSON.stringify({ uid: users.active, csrf: 'x' })));
      const res = await http(server.baseUrl, '/', { jar });
      expect(res.location).toBe('/login');
    });

    it('ends an existing session as soon as the account is deactivated', async () => {
      const email = `temp-${Date.now()}@qosfc.example`;
      const id = await addUser(email, { mfa: true, active: true });
      const jar = await passwordStep(email);
      await http(server.baseUrl, '/login/mfa', { form: { code: currentTotp(totpSecret) }, jar });
      expect((await http(server.baseUrl, '/', { jar })).status).toBe(200);
      await pool.query(`UPDATE app_user SET is_active = false WHERE id = $1`, [id]);
      expect((await http(server.baseUrl, '/', { jar })).location).toBe('/login');
    });
  });

  describe('CSRF', () => {
    it('refuses a mutating POST with no token or the wrong token, and does not act', async () => {
      const { jar } = await fullLogin();
      for (const csrf of [undefined, 'wrong']) {
        const form: Record<string, string> = { forename: 'Csrf', surname: 'Victim' };
        if (csrf) form['csrf'] = csrf;
        const res = await http(server.baseUrl, '/members', { form, jar });
        expect(res.status).toBe(403);
      }
      expect((await pool.query(`SELECT 1 FROM member WHERE forename = 'Csrf'`)).rowCount).toBe(0);
    });

    it("refuses another admin's CSRF token", async () => {
      const a = await fullLogin();
      const b = await fullLogin();
      expect(a.csrf).not.toBe(b.csrf);
      const res = await http(server.baseUrl, '/logout', { form: { csrf: b.csrf }, jar: a.jar });
      expect(res.status).toBe(403);
    });

    it('logout with the right token clears the session cookie and audits it', async () => {
      const { jar, csrf } = await fullLogin();
      const before = await auditCount('admin_logout', 'jo@qosfc.example');
      const res = await http(server.baseUrl, '/logout', { form: { csrf }, jar });
      expect(res.status).toBe(302);
      expect(res.location).toBe('/login');
      expect(jar.get(SESSION)).toBeUndefined();
      expect(await auditCount('admin_logout', 'jo@qosfc.example')).toBe(before + 1);
    });
  });

  describe('known gaps (it.fails — flip to it() when fixed)', () => {
    it.fails('a pending-MFA cookie value replayed under the session cookie name does not bypass MFA', async () => {
      // @fastify/cookie signs the VALUE, not the name. The pending cookie's
      // value is `{"uid":…}` — the same shape currentUser() reads from the
      // session cookie — so a password alone must not be enough to forge one.
      //
      // Today the auth hook ACCEPTS the forged cookie and sets authUser; every
      // page then 500s only because escapeHtml(undefined) throws on the missing
      // csrf. Any route that doesn't render the csrf token would serve data to
      // someone holding the password but not the second factor.
      const jar = await passwordStep();
      const forged = new CookieJar();
      forged.set(SESSION, jar.get(PENDING)!);
      const res = await http(server.baseUrl, '/members', { jar: forged });
      expect(res.status).toBe(302);
      expect(res.location).toBe('/login');
    });
    it.fails('a session cookie captured before logout stops working after logout', async () => {
      const { jar, csrf } = await fullLogin();
      const stolen = jar.clone();
      await http(server.baseUrl, '/logout', { form: { csrf }, jar });
      expect((await http(server.baseUrl, '/', { jar: stolen })).location).toBe('/login');
    });

    it.fails('a TOTP code cannot be used twice', async () => {
      const code = currentTotp(totpSecret);
      const first = await passwordStep();
      await http(server.baseUrl, '/login/mfa', { form: { code }, jar: first });
      const second = await passwordStep();
      const replay = await http(server.baseUrl, '/login/mfa', { form: { code }, jar: second });
      expect(replay.status).toBe(401);
    });

    it.fails('repeated wrong passwords are throttled', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 30; i += 1) {
        statuses.push((await http(server.baseUrl, '/login', { form: { email: 'jo@qosfc.example', password: `guess-${i}` } })).status);
      }
      expect(statuses).toContain(429);
    });
  });
});
