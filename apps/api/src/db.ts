import { createHash, randomBytes } from 'node:crypto';
import { withTransaction, type Pool } from '@qosfc/db';
import { estimateStandingOrderEntries } from '@qosfc/activities';
import { DEFAULT_JACKPOT_FLOOR_PENCE, jackpotPosition, pence, revenueFor, TICKET_PRICE_PENCE, type BasisPoints } from '@qosfc/domain';

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

const PASSWORD_RESET_TTL = "interval '1 hour'";

/**
 * Returns undefined if there's no active member with a portal login for this
 * email — the caller must respond identically either way (T-1.3-style
 * enumeration guard, same convention as /register's "Could not register with
 * those details" and /login's "Invalid email or password").
 *
 * Any previous unresolved request for this member is superseded (deleted) so
 * only the most recently requested link ever works.
 */
export async function createPasswordReset(
  pool: Pool,
  email: string,
): Promise<{ readonly memberId: string; readonly token: string } | undefined> {
  const member = await findMemberByEmail(pool, email);
  if (!member) return undefined;

  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');

  await withTransaction(pool, async (client) => {
    await client.query(`DELETE FROM member_password_reset WHERE member_id = $1 AND used_at IS NULL`, [member.id]);
    await client.query(
      `INSERT INTO member_password_reset (member_id, token_hash, expires_at) VALUES ($1, $2, now() + ${PASSWORD_RESET_TTL})`,
      [member.id, tokenHash],
    );
  });

  return { memberId: member.id, token };
}

export type ConsumePasswordResetOutcome =
  | { readonly kind: 'reset'; readonly memberId: string }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'expired' };

export async function consumePasswordReset(
  pool: Pool,
  token: string,
  newPasswordHash: string,
): Promise<ConsumePasswordResetOutcome> {
  const tokenHash = createHash('sha256').update(token).digest('hex');

  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string; member_id: string; expires_at: string; used_at: string | null }>(
      `SELECT id, member_id, expires_at, used_at FROM member_password_reset WHERE token_hash = $1 FOR UPDATE`,
      [tokenHash],
    );
    const row = rows[0];
    if (!row || row.used_at) return { kind: 'invalid' };
    if (new Date(row.expires_at).getTime() < Date.now()) return { kind: 'expired' };

    await client.query(`UPDATE member_password_reset SET used_at = now() WHERE id = $1`, [row.id]);
    await client.query(`UPDATE member_credential SET password_hash = $1 WHERE member_id = $2`, [newPasswordHash, row.member_id]);
    return { kind: 'reset', memberId: row.member_id };
  });
}

export interface OpenDraw {
  readonly id: string;
  readonly drawNumber: number;
  readonly drawDate: string;
  /** GitHub #5 — may be NULL. */
  readonly name: string | null;
  /** GitHub #4 — NULL on draws created before draw times/cutoffs existed. */
  readonly drawAt: Date | null;
  readonly entriesCloseAt: Date | null;
}

/**
 * The draw a member entering now would go into: the soonest open draw whose
 * entries haven't closed (GitHub #4). With recurring draws created ahead of
 * time several can be open at once — the next one is the one on sale, not
 * the highest-numbered.
 */
export async function getOpenDraw(pool: Pool): Promise<OpenDraw | undefined> {
  const { rows } = await pool.query<{
    id: string;
    draw_number: number;
    draw_date: string;
    name: string | null;
    draw_at: Date | null;
    entries_close_at: Date | null;
  }>(
    `SELECT id, draw_number, draw_date::text AS draw_date, name, draw_at, entries_close_at
       FROM draw
      WHERE status = 'open' AND (entries_close_at IS NULL OR entries_close_at > now())
      ORDER BY COALESCE(draw_at, draw_date::timestamptz), draw_number
      LIMIT 1`,
  );
  const row = rows[0];
  return row
    ? {
        id: row.id,
        drawNumber: row.draw_number,
        drawDate: row.draw_date,
        name: row.name,
        drawAt: row.draw_at,
        entriesCloseAt: row.entries_close_at,
      }
    : undefined;
}

export interface DrawStats {
  readonly entriesCount: number;
  /** MAX(floor, this draw's prize contribution so far + rollover in) — grows as more entries arrive; not the final figure until the draw closes. */
  readonly jackpotEstimatePence: bigint;
}

export async function getDrawStats(pool: Pool, drawId: string): Promise<DrawStats> {
  const [{ rows: entryRows }, { rows: splitRows }, { rows: lastRows }, standingOrders] = await Promise.all([
    pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM entry WHERE draw_id = $1 AND voided_at IS NULL`, [drawId]),
    pool.query<{ split_prize_bp: number }>(`SELECT split_prize_bp FROM config_version WHERE is_active = true`),
    pool.query<{ rollover_out_pence: string | null }>(
      `SELECT rollover_out_pence::text AS rollover_out_pence FROM draw WHERE status = 'settled' ORDER BY draw_number DESC LIMIT 1`,
    ),
    estimateStandingOrderEntries(pool, [drawId]),
  ]);
  const entriesCount = Number(entryRows[0]!.n);
  const prizeBp = (splitRows[0]?.split_prize_bp ?? 5000) as BasisPoints;
  const rolloverIn = pence(BigInt(lastRows[0]?.rollover_out_pence ?? '0'));
  // Standing orders expected to have paid by the draw count toward the estimate, not toward "entries this week".
  const expected = entriesCount + (standingOrders.get(drawId) ?? 0);
  const contribution = pence((revenueFor(expected, TICKET_PRICE_PENCE) * BigInt(prizeBp)) / 10_000n);
  const position = jackpotPosition(contribution, rolloverIn, DEFAULT_JACKPOT_FLOOR_PENCE);
  return { entriesCount, jackpotEstimatePence: position.jackpotPreDrawPence };
}

/** Every set of numbers the member currently holds — one per line (db/migrations/0018). */
export async function listStandingSelections(pool: Pool, memberId: string): Promise<number[][]> {
  const { rows } = await pool.query<{ selection: number[] }>(
    `SELECT ss.selection
       FROM selection_standing ss
       JOIN member_number mn ON mn.prize_draw_no = ss.prize_draw_no
      WHERE mn.member_id = $1 AND ss.effective_to IS NULL
      ORDER BY ss.prize_draw_no, ss.slot`,
    [memberId],
  );
  return rows.map((r) => r.selection);
}

export interface MemberDetails {
  readonly id: string;
  readonly forename: string | null;
  readonly surname: string | null;
  readonly email: string | null;
  readonly telephone: string | null;
  readonly address1: string | null;
  readonly address2: string | null;
  readonly address3: string | null;
  readonly postCode: string | null;
  readonly preferredContact: string;
}

export async function getMemberDetails(pool: Pool, id: string): Promise<MemberDetails | undefined> {
  const { rows } = await pool.query<{
    id: string;
    forename: string | null;
    surname: string | null;
    email: string | null;
    telephone: string | null;
    address_1: string | null;
    address_2: string | null;
    address_3: string | null;
    post_code: string | null;
    preferred_contact: string;
  }>(
    `SELECT id, forename, surname, email, telephone, address_1, address_2, address_3, post_code, preferred_contact
       FROM member WHERE id = $1 AND status = 'active'`,
    [id],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    forename: row.forename,
    surname: row.surname,
    email: row.email,
    telephone: row.telephone,
    address1: row.address_1,
    address2: row.address_2,
    address3: row.address_3,
    postCode: row.post_code,
    preferredContact: row.preferred_contact,
  };
}

export async function updateMemberDetails(
  pool: Pool,
  id: string,
  input: {
    telephone: string;
    address1: string;
    address2: string;
    address3: string;
    postCode: string;
    preferredContact: 'post' | 'email' | 'phone';
  },
): Promise<void> {
  await pool.query(
    `UPDATE member
        SET telephone = $2, address_1 = $3, address_2 = $4, address_3 = $5,
            post_code = $6, post_code_valid = false, preferred_contact = $7, updated_at = now()
      WHERE id = $1`,
    [id, input.telephone || null, input.address1 || null, input.address2 || null, input.address3 || null, input.postCode || null, input.preferredContact],
  );
}

export interface MyEntry {
  readonly id: string;
  readonly drawNumber: number;
  readonly drawDate: string;
  readonly drawStatus: string;
  readonly selection: number[];
  readonly winningNumbers: number[] | null;
  readonly createdAt: string;
}

export async function listMyEntries(pool: Pool, memberId: string): Promise<MyEntry[]> {
  const { rows } = await pool.query<{
    id: string;
    draw_number: number;
    draw_date: string;
    draw_status: string;
    selection: number[];
    winning_numbers: number[] | null;
    created_at: string;
  }>(
    `SELECT e.id, d.draw_number, d.draw_date::text AS draw_date, d.status::text AS draw_status,
            e.selection, d.winning_numbers, e.created_at::text AS created_at
       FROM entry e JOIN draw d ON d.id = e.draw_id
      WHERE e.member_id = $1 AND e.voided_at IS NULL
      ORDER BY d.draw_number DESC
      LIMIT 50`,
    [memberId],
  );
  return rows.map((r) => ({
    id: r.id,
    drawNumber: r.draw_number,
    drawDate: r.draw_date,
    drawStatus: r.draw_status,
    selection: r.selection,
    winningNumbers: r.winning_numbers,
    createdAt: r.created_at,
  }));
}

export interface SettledDraw {
  readonly drawNumber: number;
  readonly drawDate: string;
  readonly winningNumbers: number[];
  readonly jackpotPaidPence: string | null;
  readonly rolloverOutPence: string | null;
  readonly winnersCount: number | null;
}

export async function listSettledDraws(pool: Pool, limit = 20): Promise<SettledDraw[]> {
  const { rows } = await pool.query<{
    draw_number: number;
    draw_date: string;
    winning_numbers: number[];
    jackpot_paid_pence: string | null;
    rollover_out_pence: string | null;
    winners_count: number | null;
  }>(
    `SELECT draw_number, draw_date::text AS draw_date, winning_numbers,
            jackpot_paid_pence::text AS jackpot_paid_pence,
            rollover_out_pence::text AS rollover_out_pence,
            winners_count
       FROM draw
      WHERE status = 'settled'
      ORDER BY draw_number DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    drawNumber: r.draw_number,
    drawDate: r.draw_date,
    winningNumbers: r.winning_numbers,
    jackpotPaidPence: r.jackpot_paid_pence,
    rolloverOutPence: r.rollover_out_pence,
    winnersCount: r.winners_count,
  }));
}

export interface LifetimeTotals {
  /** Every jackpot actually paid to winners, across all settled draws. */
  readonly prizePaidPence: bigint;
}

/**
 * The landing page's running totals. Only prize money is counted: what has
 * gone to the good cause is not recorded anywhere yet — entry-purchase-time
 * revenue recognition (the good-cause and admin shares) is unbuilt, gated on
 * GAP-09/10/27 — so the page shows no charity figure rather than an invented one.
 */
export async function getLifetimeTotals(pool: Pool): Promise<LifetimeTotals> {
  const { rows } = await pool.query<{ paid: string }>(
    `SELECT COALESCE(SUM(jackpot_paid_pence), 0)::text AS paid FROM draw WHERE status = 'settled'`,
  );
  return { prizePaidPence: BigInt(rows[0]!.paid) };
}

export interface RevenueSplit {
  readonly prizeBp: number;
  readonly goodCauseBp: number;
  readonly adminBp: number;
}

/** How each £1 is divided, from the active config (T-2.2: the three always sum to 10,000). */
export async function getRevenueSplit(pool: Pool): Promise<RevenueSplit> {
  const { rows } = await pool.query<{ split_prize_bp: number; split_good_cause_bp: number; split_admin_bp: number }>(
    `SELECT split_prize_bp, split_good_cause_bp, split_admin_bp FROM config_version WHERE is_active = true`,
  );
  const row = rows[0];
  // The schema defaults, for a database with no active config row yet.
  return row
    ? { prizeBp: row.split_prize_bp, goodCauseBp: row.split_good_cause_bp, adminBp: row.split_admin_bp }
    : { prizeBp: 5000, goodCauseBp: 4000, adminBp: 1000 };
}
