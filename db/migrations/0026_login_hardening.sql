-- 0026_login_hardening — fixes from the test plan (docs/TEST_PLAN.md).
--
-- #45 (F-6): sessions are signed cookies, so clearing one in a browser leaves
-- any copy valid until it expires. Each account now has a session epoch,
-- carried in its cookie and checked on every request; raising it ends every
-- session issued before. Admin logout raises it; a member password reset
-- raises it.
ALTER TABLE app_user          ADD COLUMN session_epoch int NOT NULL DEFAULT 0;
ALTER TABLE member_credential ADD COLUMN session_epoch int NOT NULL DEFAULT 0;

-- #46 (F-7): RFC 6238 §5.2 — a TOTP code must not be accepted twice. The
-- 30-second step of the last accepted code; a code is accepted only for a
-- later step.
ALTER TABLE app_user ADD COLUMN totp_last_step bigint;

-- #43 (F-4): two registrations racing with one email both passed the
-- check-then-insert in registerMember(). email is citext, so this is
-- case-insensitive. NULL stays allowed and repeatable: the legacy register
-- holds no email addresses (GAP-05).
CREATE UNIQUE INDEX member_email_unique ON member (email) WHERE email IS NOT NULL;
