-- 0013_member_password_reset — GAP-30's first real use of the email channel
-- (SocketLabs) beyond the welcome email: self-service "forgot password" for
-- the member portal.
--
-- The token itself is never stored — only its SHA-256 hash — so a read of
-- this table (a backup, a leaked snapshot) cannot be used to reset anyone's
-- password; only the raw token in the email the member received can. It is
-- high-entropy and single-use, so a fast hash is appropriate here, unlike
-- `member_credential.password_hash` which is argon2id because a password is
-- low-entropy and human-chosen.
CREATE TABLE member_password_reset (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id    uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Every unresolved request for a member, looked up by whoever clicks the link.
CREATE INDEX member_password_reset_member_idx ON member_password_reset (member_id) WHERE used_at IS NULL;
