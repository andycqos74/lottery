-- 0008_member_login — GAP-04 resolved: legacy members will get logins too;
-- their existing standing orders keep running unchanged in the meantime.
-- Translating those legacy payment records into `payment_method`/
-- `subscription` and provisioning legacy members with credentials is
-- explicit future-phase work (gap-register.md GAP-04), not attempted here.
-- This migration only adds the credential a member can register for
-- themselves through the portal.

-- One member, one password. Unlike app_user (admin), MFA is not mandated here
-- — T-9.3's mandatory-MFA requirement is scoped to admin accounts.
CREATE TABLE member_credential (
  member_id     uuid PRIMARY KEY REFERENCES member(id) ON DELETE CASCADE,
  password_hash text NOT NULL,          -- argon2id, same algorithm as app_user
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- GAP-09: the online purchase flow runs against the sandbox PaymentGateway as
-- a dummy transaction simulator until a real acquirer is chosen (functional
-- spec §7, T-9.1 — no card data ever reaches this table or any other).
-- This bridges the hosted-redirect round trip: created when the session
-- starts, resolved when the member's browser returns AND independently by the
-- webhook, because a browser that never comes back must not lose a payment.
CREATE TABLE pending_entry_purchase (
  session_id   text PRIMARY KEY,
  member_id    uuid NOT NULL REFERENCES member(id),
  draw_id      uuid NOT NULL REFERENCES draw(id),
  selection    int[] NOT NULL,
  amount_pence bigint NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  entry_id     uuid REFERENCES entry(id),
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT completed_purchases_record_their_entry
    CHECK (status <> 'completed' OR entry_id IS NOT NULL)
);
