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
import type { FastifyReply, FastifyRequest } from 'fastify';
import { findMemberById, type Member } from './db.js';
import type { Pool } from '@qosfc/db';

export const SESSION_COOKIE = 'qosfc_member_session';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface SessionPayload {
  readonly mid: string;
  readonly csrf: string;
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
): Promise<{ member: Omit<Member, 'passwordHash'>; session: SessionPayload } | undefined> {
  const value = readSignedCookie(request, SESSION_COOKIE);
  if (!value) return undefined;
  let session: SessionPayload;
  try {
    session = JSON.parse(value) as SessionPayload;
  } catch {
    return undefined;
  }
  const member = await findMemberById(pool, session.mid);
  if (!member) return undefined;
  return { member, session };
}

export function requireCsrf(request: FastifyRequest, reply: FastifyReply, expected: string): boolean {
  const supplied = (request.body as { csrf?: string } | undefined)?.csrf ?? request.headers['x-csrf-token'];
  if (supplied !== expected) {
    reply.code(403).send({ error: 'csrf_mismatch' });
    return false;
  }
  return true;
}
