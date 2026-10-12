/**
 * Member sessions (GAP-04) — a portal login, distinct from `apps/admin`'s
 * `app_user` (T-9.3 mandates MFA for admin accounts; that requirement is not
 * extended to members here).
 *
 * A signed, httpOnly cookie carrying only a member id and a CSRF token —
 * exactly `apps/admin`'s pattern, minus the MFA step. This is a JSON API, not
 * an HTML form target, so classic form-based CSRF (a cross-site <form> POST)
 * cannot reach it: the browser cannot send `application/json` from a plain
 * form post, and Fastify's JSON parser only fires on that content type. The
 * CSRF token is still threaded through so a future HTML/portal frontend can
 * use it without a redesign.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { findMemberById, type Member } from './db.js';
import type { Pool } from '@qosfc/db';

export const SESSION_COOKIE = 'qosfc_member_session';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface SessionPayload {
  /** #40: what this signed value is, so no other signed cookie can pass as a session. */
  readonly p: 'member_session';
  readonly mid: string;
  readonly csrf: string;
  /** #45: the credential's session epoch when this session began. */
  readonly ep: number;
}

/** Starts a session for a member who has just proved who they are. Returns its CSRF token. */
export function issueSession(reply: FastifyReply, nodeEnv: string, member: { id: string; sessionEpoch: number }): string {
  const payload: SessionPayload = { p: 'member_session', mid: member.id, csrf: randomBytes(16).toString('hex'), ep: member.sessionEpoch };
  reply.setCookie(SESSION_COOKIE, JSON.stringify(payload), cookieOpts(nodeEnv));
  return payload.csrf;
}

export function cookieOpts(nodeEnv: string, maxAgeSeconds = SESSION_MAX_AGE_SECONDS) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: nodeEnv === 'production',
    signed: true,
    maxAge: maxAgeSeconds,
  };
}

export function readSignedCookie(request: FastifyRequest, name: string): string | undefined {
  const raw = request.cookies[name];
  if (!raw) return undefined;
  const result = request.unsignCookie(raw);
  return result.valid && result.value ? result.value : undefined;
}

export async function currentMember(
  pool: Pool,
  request: FastifyRequest,
): Promise<{ member: Omit<Member, 'passwordHash' | 'sessionEpoch'>; session: SessionPayload } | undefined> {
  const value = readSignedCookie(request, SESSION_COOKIE);
  if (!value) return undefined;
  let session: Partial<SessionPayload> | null;
  try {
    session = JSON.parse(value) as Partial<SessionPayload> | null;
  } catch {
    return undefined;
  }
  if (session?.p !== 'member_session' || typeof session.mid !== 'string' || typeof session.csrf !== 'string' || session.csrf === '') {
    return undefined;
  }
  const found = await findMemberById(pool, session.mid);
  if (!found || found.sessionEpoch !== session.ep) return undefined;
  const { sessionEpoch: _epoch, ...member } = found;
  return { member, session: session as SessionPayload };
}

export function requireCsrf(request: FastifyRequest, reply: FastifyReply, expected: string): boolean {
  const supplied = (request.body as { csrf?: string } | undefined)?.csrf ?? request.headers['x-csrf-token'];
  if (supplied !== expected) {
    reply.code(403).send({ error: 'csrf_mismatch' });
    return false;
  }
  return true;
}
