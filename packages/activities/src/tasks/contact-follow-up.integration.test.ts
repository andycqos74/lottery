/**
 * GAP-05 — a follow-up task for each live member with no email address,
 * closed once one is added and never re-raised once a person resolved it.
 *
 * Set TEST_APP_DB_URL to run. Without it the suite skips rather than silently
 * passing, so a green CI run with no database does not look like proof.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPool, migrate, type Pool } from '@qosfc/db';
import { MISSING_EMAIL_TASK_KIND, syncMissingEmailTasks } from './contact-follow-up.js';

const url = process.env['TEST_APP_DB_URL'];
const describeDb = url ? describe : describe.skip;

describeDb('member contact follow-up (GAP-05)', () => {
  let pool: Pool;

  async function member(fields: { surname: string; email?: string; status?: string; address?: boolean }): Promise<string> {
    return (
      await pool.query(
        `INSERT INTO member (forename, surname, email, status, address_1, post_code)
         VALUES ('Test', $1, $2, $3::member_status, $4, $5) RETURNING id`,
        [fields.surname, fields.email ?? null, fields.status ?? 'active', fields.address ? '1 High St' : null, fields.address ? 'AB1 2CD' : null],
      )
    ).rows[0].id;
  }

  async function tasksFor(memberId: string): Promise<{ id: string; status: string; title: string; detail: string }[]> {
    return (
      await pool.query(
        `SELECT id, status, title, detail FROM human_task WHERE kind = $1 AND entity_id = $2 ORDER BY opened_at`,
        [MISSING_EMAIL_TASK_KIND, memberId],
      )
    ).rows;
  }

  beforeAll(async () => {
    pool = createPool({ connectionString: url!, applicationName: 'qosfc-contact-follow-up-test', max: 4 });
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const here = dirname(fileURLToPath(import.meta.url));
    await migrate(pool, resolve(here, '../../../../db/migrations'), () => {});
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('opens one task per live member without an email, and only once', async () => {
    const noEmail = await member({ surname: 'Noemail', address: true });
    const hasEmail = await member({ surname: 'Hasemail', email: 'has@example.com' });
    const deceased = await member({ surname: 'Gone', status: 'deceased' });

    expect(await syncMissingEmailTasks(pool, {})).toEqual({ opened: 1, closed: 0 });
    const [task] = await tasksFor(noEmail);
    expect(task).toMatchObject({ status: 'open', title: 'Get an email address for Test Noemail' });
    expect(task!.detail).toContain('postal address is on their member page');
    expect(await tasksFor(hasEmail)).toEqual([]);
    expect(await tasksFor(deceased)).toEqual([]);

    // A second sweep finds nothing new.
    expect(await syncMissingEmailTasks(pool, {})).toEqual({ opened: 0, closed: 0 });
  });

  it('closes the task once the email address is added', async () => {
    const id = await member({ surname: 'Later' });
    await syncMissingEmailTasks(pool, {});
    await pool.query(`UPDATE member SET email = 'later@example.com' WHERE id = $1`, [id]);

    const result = await syncMissingEmailTasks(pool, {});
    expect(result.closed).toBe(1);
    expect((await tasksFor(id)).map((t) => t.status)).toEqual(['cancelled']);
    const { rows } = await pool.query(`SELECT 1 FROM audit_log WHERE action = 'human_task.cancelled' AND after->>'memberId' = $1`, [id]);
    expect(rows).toHaveLength(1);
  });

  it('does not re-raise a task a person has resolved', async () => {
    const id = await member({ surname: 'Postonly' });
    await syncMissingEmailTasks(pool, {});
    const user = (
      await pool.query(`INSERT INTO app_user (email, display_name, password_hash) VALUES ('a@example.com', 'Admin', 'x') RETURNING id`)
    ).rows[0].id;
    await pool.query(
      `UPDATE human_task SET status = 'resolved', resolved_by = $2, resolved_at = now() WHERE kind = $1 AND entity_id = $3`,
      [MISSING_EMAIL_TASK_KIND, user, id],
    );

    await syncMissingEmailTasks(pool, {});
    expect((await tasksFor(id)).map((t) => t.status)).toEqual(['resolved']);
  });
});
