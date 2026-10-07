-- 0022_direct_debit_collections — collecting Direct Debit money, and keeping
-- mandates in step with the bank (GAP-10 shape; GAP-11 and GAP-12 resolved).
--
-- Client decisions, 2026-10-07:
--  * Monthly collection, in advance: early each month the line's Direct Debit
--    entries for that month's draws (plus any earlier ones never yet
--    collected for) are collected in one amount, after an advance notice.
--  * A failed collection is retried once; a second failure withdraws the
--    Direct Debit (GAP-11).
--  * A refund claim under the Direct Debit Guarantee removes the Direct
--    Debit and the entries it paid for, from draws still taking entries (GAP-12).
--  * A mandate the bank has not yet confirmed enters nothing.
--
-- The bank route itself (GAP-10) is still open: everything here goes through
-- the BacsBureau port, so a real bureau or own-SUN adapter slots in later.

ALTER TABLE payment_method
  -- When the bank confirmed the mandate. Entries count from here, not from sign-up.
  ADD COLUMN mandate_active_at timestamptz,
  ADD COLUMN ended_at timestamptz,
  -- 'member_cancelled' | 'admin_cancelled' | 'payer_cancelled_at_bank' |
  -- 'mandate_failed' | 'collection_failed' | 'refund_claim' | 'replaced'
  ADD COLUMN end_reason text,
  -- Ended here but not yet cancelled with the bureau: the Direct Debit
  -- workflow does that, so only the worker ever talks to the bank.
  ADD COLUMN bureau_cancel_pending boolean NOT NULL DEFAULT false;

-- Mandates recorded before confirmation was tracked were treated as live from
-- sign-up; keep them that way rather than silently withdrawing their entries.
UPDATE payment_method
   SET mandate_status = 'active', mandate_active_at = created_at
 WHERE type = 'direct_debit' AND active AND COALESCE(mandate_status, '') IN ('pending', 'active');

CREATE INDEX payment_method_mandate_ref_idx ON payment_method (mandate_ref) WHERE mandate_ref IS NOT NULL;

-- One month's collection run.
CREATE TABLE dd_collection_cycle (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- First day of the month being paid for.
  collection_month date NOT NULL UNIQUE CHECK (extract(day FROM collection_month) = 1),
  collection_date  date NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- One attempt to collect from one mandate. A failed first attempt gets a
-- second row (attempt 2) covering the same entries.
CREATE TABLE dd_collection (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id            uuid NOT NULL REFERENCES dd_collection_cycle(id),
  payment_method_id   uuid NOT NULL REFERENCES payment_method(id),
  member_id           uuid NOT NULL REFERENCES member(id),
  mandate_ref         text NOT NULL,
  attempt             int  NOT NULL DEFAULT 1 CHECK (attempt IN (1, 2)),
  amount_pence        bigint NOT NULL CHECK (amount_pence > 0),
  draws_covered       int  NOT NULL CHECK (draws_covered > 0),
  submit_on           date NOT NULL,
  collection_date     date NOT NULL,
  status              text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'submitted', 'collected', 'failed', 'rejected', 'cancelled', 'refunded')),
  submission_id       text,
  results_expected_at timestamptz,
  failure_code        text,
  failure_reason      text,
  payment_id          uuid REFERENCES payment(id),
  notified_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, payment_method_id, attempt)
);
CREATE INDEX dd_collection_due_idx ON dd_collection (submit_on) WHERE status = 'scheduled';
CREATE INDEX dd_collection_submitted_idx ON dd_collection (submission_id) WHERE status = 'submitted';
CREATE INDEX dd_collection_member_idx ON dd_collection (member_id, created_at DESC);

-- Which entries a collection pays for. An entry in a scheduled, submitted or
-- collected collection is protected: cancelling, or buying weeks on the same
-- numbers, never withdraws or re-funds it.
CREATE TABLE dd_collection_entry (
  collection_id uuid NOT NULL REFERENCES dd_collection(id),
  entry_id      uuid NOT NULL REFERENCES entry(id),
  PRIMARY KEY (collection_id, entry_id)
);
CREATE INDEX dd_collection_entry_entry_idx ON dd_collection_entry (entry_id);

-- Mandate messages from the bank (AUDDIS/ADDACS-shaped), each applied once.
CREATE TABLE dd_mandate_event (
  event_id     text PRIMARY KEY,
  mandate_ref  text NOT NULL,
  kind         text NOT NULL,
  occurred_at  timestamptz NOT NULL,
  detail       text NOT NULL DEFAULT '',
  amount_pence bigint,
  outcome      text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
