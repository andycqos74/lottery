import { withTransaction, type Pool } from '@qosfc/db';

export interface Member {
  readonly id: string;
  readonly email: string | null;
  readonly forename: string | null;
  readonly surname: string | null;
  readonly passwordHash: string;
}

export async function findMemberByEmail(pool: Pool, email: string): Promise<Member | undefined> {
  const { rows } = await pool.query<{
    id: string;
    email: string | null;
    forename: string | null;
    surname: string | null;
    password_hash: string;
  }>(
    `SELECT m.id, m.email, m.forename, m.surname, c.password_hash
       FROM member m JOIN member_credential c ON c.member_id = m.id
      WHERE m.email = $1 AND m.status = 'active'`,
    [email],
  );
  const row = rows[0];
  return row
    ? { id: row.id, email: row.email, forename: row.forename, surname: row.surname, passwordHash: row.password_hash }
    : undefined;
}

export async function findMemberById(pool: Pool, id: string): Promise<Omit<Member, 'passwordHash'> | undefined> {
  const { rows } = await pool.query<{ id: string; email: string | null; forename: string | null; surname: string | null }>(
    `SELECT id, email, forename, surname FROM member WHERE id = $1 AND status = 'active'`,
    [id],
  );
  return rows[0];
}

export type RegisterOutcome =
  | { readonly kind: 'registered'; readonly memberId: string }
  | { readonly kind: 'email_taken' };

/**
 * GAP-04: this is the login path for a NEW member registering through the
 * portal. It does not touch, and cannot create, a legacy `prize_draw_no` —
 * translating an existing legacy member into a portal login is separate,
 * deferred future-phase work (gap-register.md GAP-04).
 */
export async function registerMember(
  pool: Pool,
  input: { forename: string; surname: string; email: string; passwordHash: string },
): Promise<RegisterOutcome> {
  return withTransaction(pool, async (client) => {
    const existing = await client.query(`SELECT 1 FROM member WHERE email = $1`, [input.email]);
    if (existing.rows.length > 0) return { kind: 'email_taken' };

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO member (forename, surname, email, status, preferred_contact) VALUES ($1, $2, $3, 'active', 'email') RETURNING id`,
      [input.forename, input.surname, input.email],
    );
    const memberId = rows[0]!.id;
    await client.query(`INSERT INTO member_credential (member_id, password_hash) VALUES ($1, $2)`, [
      memberId,
      input.passwordHash,
    ]);
    return { kind: 'registered', memberId };
  });
}

export async function touchMemberLastLogin(pool: Pool, memberId: string): Promise<void> {
  await pool.query(`UPDATE member_credential SET last_login_at = now() WHERE member_id = $1`, [memberId]);
}

export interface OpenDraw {
  readonly id: string;
  readonly drawNumber: number;
}

export async function getOpenDraw(pool: Pool): Promise<OpenDraw | undefined> {
  const { rows } = await pool.query<{ id: string; draw_number: number }>(
    `SELECT id, draw_number FROM draw WHERE status = 'open' ORDER BY draw_number DESC LIMIT 1`,
  );
  const row = rows[0];
  return row ? { id: row.id, drawNumber: row.draw_number } : undefined;
}
