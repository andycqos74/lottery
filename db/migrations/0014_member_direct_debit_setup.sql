-- 0014_member_direct_debit_setup — self-service Direct Debit setup on the
-- member portal (GAP-10 stub, mirroring the GAP-09 online card flow). Bank
-- details are never collected by this application (same T-9.1 boundary as
-- card payments) — the bureau's `createMandate` returns a redirect, and this
-- table bridges that round trip exactly like `pending_entry_purchase` does
-- for a card session: created when the mandate is requested, resolved when
-- the member's browser returns.
--
-- GAP-10 is unconfirmed and the sandbox bureau auto-approves unconditionally
-- (no decline path exists to model here, unlike the card PSP's
-- SANDBOX_DECLINE_RATE) — this is a stub for exercising the signup flow, not
-- a simulation of a real bureau's underwriting.
CREATE TABLE pending_dd_setup (
  mandate_ref  text PRIMARY KEY,
  member_id    uuid NOT NULL REFERENCES member(id),
  selection    int[] NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
