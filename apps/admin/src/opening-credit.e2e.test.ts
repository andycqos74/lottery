/**
 * The admin console's opening-credit page (switch-over D2 (c), SETUP §2.2.3),
 * black-box: the real server process, a real PostgreSQL, HTTP only. Upload
 * old statements, check, assign a payment on the page, credit — once.
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
const PASSWORD = 'correct horse battery staple';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (isoDate: string, days: number) => iso(new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000));
const bankDate = (isoDate: string) => isoDate.replace(/-/g, '');

const unescapeHtml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

describeDb('admin console — opening credit for legacy standing orders', () => {
  let pool: Pool;
  let server: RunningServer;
  let jar: CookieJar;
  let csrf: string;
  const mfaKey = randomBytes(32);
  const totpSecret = generateTotpSecret();

  let firstDraw: string;
  let cutoff: string;
  let statement: string;

  /** The form fields every step carries. */
  const base = (extra: Record<string, string> = {}): Record<string, string> => ({
    csrf,
    statements: JSON.stringify([{ name: 'old-lottery.csv', content: statement }]),
    cutoff,
    firstDraw,
    oldDrawDay: '',
    ...extra,
  });

  const count = async (sql: string) => Number(Object.values((await pool.query<Record<string, string>>(sql)).rows[0]!)[0]);

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, applicationName: 'qosfc-admin-opening-credit-e2e', max: 2 });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await migrate(pool, resolve(REPO_ROOT, 'db/migrations'), () => {});

    await pool.query(
      `INSERT INTO app_user (email, display_name, password_hash, totp_secret_enc, mfa_enrolled, is_active)
       VALUES ('jo@qosfc.example', 'jo', $1, $2, true, true)`,
      [await argon2Hash(PASSWORD), encryptSecret(totpSecret, mfaKey)],
    );
    const cfgId = (
      await pool.query(
        `INSERT INTO config_version (entry_strategy, entry_strategy_confirmed_by, note, is_active)
         VALUES ('prepaid_blocks', 'test fixture', 'opening credit e2e', true) RETURNING id`,
      )
    ).rows[0].id;
    for (let n = 1; n <= 8; n++) {
      await pool.query(
        `INSERT INTO draw (draw_number, draw_date, draw_at, entries_close_at, config_version_id, status)
         VALUES ($1, (now() + make_interval(days => $2))::date, now() + make_interval(days => $2),
                 now() + make_interval(days => $2) - interval '12 hours', $3, 'open')`,
        [n, 7 * n, cfgId],
      );
    }
    firstDraw = (await pool.query<{ d: string }>(`SELECT draw_date::text AS d FROM draw WHERE draw_number = 1`)).rows[0]!.d;
    cutoff = addDays(firstDraw, -6);

    // 8001: £8.68 monthly, numbers chosen. 8002: £26 quarterly, numbers chosen.
    for (const [no, amount, frequency, selection] of [[8001, 868, 'monthly', '{1,2,3,4}'], [8002, 2600, 'quarterly', '{5,6,7,8}']] as const) {
      const id = (await pool.query(`INSERT INTO member (forename, surname) VALUES ('Test', $1) RETURNING id`, [`No${no}`])).rows[0].id;
      await pool.query(`INSERT INTO member_number (prize_draw_no, member_id, row_type) VALUES ($1, $2, 'member')`, [no, id]);
      const pm = (await pool.query(`INSERT INTO payment_method (member_id, type, reference) VALUES ($1, 'standing_order', $2) RETURNING id`, [id, String(no)])).rows[0].id;
      await pool.query(
        `INSERT INTO subscription (member_id, payment_method_id, amount_pence, frequency, basis_source) VALUES ($1, $2, $3, $4::pay_frequency, 'register')`,
        [id, pm, amount, frequency],
      );
      await pool.query(`INSERT INTO selection_standing (prize_draw_no, slot, selection, source) VALUES ($1, 1, $2, 'member_chosen')`, [no, selection]);
    }

    // The old lottery drew on the cut-off's weekday. Quarterly paid 7 weeks before the
    // cut-off: 8 old draws, 5 weeks left. Monthly paid 2 weeks before: 3 old draws, 1 week left.
    statement = [
      'TransactionDate,ValueDate,Account,AccountName,Debit-Credit,TransactionCode,TransactionType,Amount,Description,Reference,Source,Currency',
      `${bankDate(addDays(cutoff, -49))},,1,AAA,CR,,Standing Order,26.00,Test No8002, 8002,8002 PRIZE DRAW,"00000000000000",GBP`,
      `${bankDate(addDays(cutoff, -14))},,1,AAA,CR,,Standing Order,8.68,FPS, Test No8001, 8001,8001,"00000000000000",GBP`,
      `${bankDate(addDays(cutoff, -10))},,1,AAA,CR,,Transfer,5.00,FPS, J Smith, 0001,J SMITH,"00000000000000",GBP`,
      `${bankDate(addDays(cutoff, 1))},,1,AAA,CR,,Standing Order,8.68,FPS, Test No8001, 8001,8001,"00000000000000",GBP`,
    ].join('\n');

    const dir = mkdtempSync(join(tmpdir(), 'qosfc-admin-oc-e2e-'));
    writeFileSync(join(dir, 'session'), randomBytes(32).toString('hex'));
    writeFileSync(join(dir, 'mfa'), mfaKey.toString('base64'));
    server = await startServer('apps/admin/src/index.ts', {
      APP_DB_URL: url!,
      SESSION_SECRET_FILE: join(dir, 'session'),
      ADMIN_MFA_KEY_FILE: join(dir, 'mfa'),
      BANK_FEED_CSV_DIR: join(dir, 'bank'),
    });

    jar = new CookieJar();
    const login = await http(server.baseUrl, '/login', { form: { email: 'jo@qosfc.example', password: PASSWORD }, jar });
    expect(login.status, login.text).toBe(302);
    const mfa = await http(server.baseUrl, '/login/mfa', { form: { code: currentTotp(totpSecret) }, jar });
    expect(mfa.status, mfa.text).toBe(302);
    const json = decodeURIComponent(jar.get(SESSION)!).replace(/\.[^.]+$/, '');
    csrf = (JSON.parse(json) as { csrf: string }).csrf;
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
    await pool?.end();
  });

  it('is behind the login, and linked from Members', async () => {
    const res = await http(server.baseUrl, '/opening-credit');
    expect(res.status).toBe(302);
    expect(res.location).toBe('/login');
    expect((await http(server.baseUrl, '/members', { jar })).text).toContain('href="/opening-credit"');
  });

  it('offers the first open draw as Draw 1, and shows nothing credited yet', async () => {
    const res = await http(server.baseUrl, '/opening-credit', { jar });
    expect(res.status).toBe(200);
    expect(res.text).toContain(`name="firstDraw" value="${firstDraw}"`);
    expect(res.text).toContain('0 numbers, 0 weeks.');
  });

  it('refuses a check without the CSRF token', async () => {
    const res = await http(server.baseUrl, '/opening-credit/preview', { form: { ...base(), csrf: 'wrong' }, jar });
    expect(res.status).toBe(403);
  });

  it('shows a bad date or file as an error on the form, not a 500', async () => {
    const bad = await http(server.baseUrl, '/opening-credit/preview', { form: base({ cutoff: '2026-02-30' }), jar });
    expect(bad.status).toBe(200);
    expect(bad.text).toContain('not a real date');
    const junk = await http(server.baseUrl, '/opening-credit/preview', {
      form: base({ statements: JSON.stringify([{ name: 'junk.csv', content: 'hello' }]) }),
      jar,
    });
    expect(junk.text).toContain('junk.csv:');
  });

  it('checks, takes an assignment on the page, credits once, and refuses a changed or repeated credit', async () => {
    const check = await http(server.baseUrl, '/opening-credit/preview', { form: base(), jar });
    expect(check.status, check.text).toBe(200);
    expect(check.text).toContain('2 — 6 weeks (£12.00)');
    expect(check.text).toContain('Nothing has been written yet.');
    const assignName = /name="(assign:csv-real:[0-9a-f]+)"/.exec(check.text)?.[1];
    expect(assignName).toBeDefined();
    // Still one to assign: crediting needs it left out explicitly.
    expect(check.text).toContain('name="allowUnresolved"');

    // Assign it on the page ("ignore") and check again.
    const again = await http(server.baseUrl, '/opening-credit/preview', { form: base({ [unescapeHtml(assignName!)]: 'ignore' }), jar });
    expect(again.text).toContain('1 marked "ignore"');
    expect(again.text).not.toContain('name="allowUnresolved"');
    const planHash = /name="planHash" value="([0-9a-f]+)"/.exec(again.text)![1]!;
    const decisions = unescapeHtml(/<textarea name="decisions" hidden>([^<]*)<\/textarea>/.exec(again.text)![1]!);
    expect(JSON.parse(decisions)).toEqual({ [unescapeHtml(assignName!).slice('assign:'.length)]: null });

    // A credit of anything other than what was checked is refused.
    const changed = await http(server.baseUrl, '/opening-credit/apply', { form: base({ decisions: '{}', planHash, confirm: 'yes' }), jar });
    expect(changed.text).toContain('changed after they were checked');
    expect(await count(`SELECT count(*) FROM payment`)).toBe(0);

    const credit = await http(server.baseUrl, '/opening-credit/apply', { form: base({ decisions, planHash, confirm: 'yes' }), jar });
    expect(credit.status, credit.text).toBe(200);
    expect(credit.text).toContain('Opening credit: 6 weeks credited to 2 numbers.');
    expect(await count(`SELECT count(*) FROM payment WHERE allocation_method = 'legacy_opening_credit'`)).toBe(2);
    expect(await count(`SELECT count(*) FROM entry WHERE voided_at IS NULL`)).toBe(6);
    expect(credit.text).toContain('2 numbers, 6 weeks.');
    expect(await count(`SELECT count(*) FROM audit_log WHERE action = 'legacy_opening_credit.applied' AND actor_label = 'jo@qosfc.example'`)).toBe(1);

    const twice = await http(server.baseUrl, '/opening-credit/apply', { form: base({ decisions, planHash, confirm: 'yes' }), jar });
    expect(twice.text).toContain('0 weeks credited to 0 numbers. 2 numbers already had one');
    expect(await count(`SELECT count(*) FROM payment`)).toBe(2);
  });

  it('refuses once the system holds statement credits from before the cut-off', async () => {
    const st = (
      await pool.query(
        `INSERT INTO bank_statement (statement_number, period_start, period_end, opening_balance_pence, closing_balance_pence, source, source_ref)
         VALUES (1, $1, $1, 0, 0, 'csv', 'test') RETURNING id`,
        [cutoff],
      )
    ).rows[0].id;
    await pool.query(`INSERT INTO bank_transaction (statement_id, value_date, amount_pence, is_credit, external_id) VALUES ($1, $2, 868, true, 'x1')`, [st, cutoff]);
    const check = await http(server.baseUrl, '/opening-credit/preview', { form: base(), jar });
    expect(check.text).toContain('already holds 1 bank statement credit(s) dated on or before the cut-off');
    expect(check.text).not.toContain('action="/opening-credit/apply"');
  });
});
