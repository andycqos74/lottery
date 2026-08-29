-- 0005_ledger_prizes — double-entry ledger and prize settlement
-- (functional spec §11, tech spec §4.4).

CREATE TYPE ledger_account_kind AS ENUM
  ('member_balance','prize_fund','rollover','good_cause','admin','reserve','bank');
CREATE TYPE prize_status AS ENUM
  ('pending_notification','notified','claimed','paid','unclaimed','void');

CREATE TABLE ledger_account (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind      ledger_account_kind NOT NULL,
  member_id uuid REFERENCES member(id),
  name      text NOT NULL,
  CONSTRAINT member_balance_has_member
    CHECK ((kind = 'member_balance') = (member_id IS NOT NULL))
);
CREATE UNIQUE INDEX ledger_account_member_uniq
  ON ledger_account (kind, member_id) WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_account_singleton_uniq
  ON ledger_account (kind) WHERE member_id IS NULL;

-- FR-13.2 / T-8.4: append-only. Corrections are compensating entries, never
-- edits or deletes. The UPDATE/DELETE revocation is applied in 0007.
CREATE TABLE ledger_entry (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  txn_id       uuid NOT NULL,
  account_id   uuid NOT NULL REFERENCES ledger_account(id),
  amount_pence bigint NOT NULL,              -- signed; debits negative
  draw_id      uuid REFERENCES draw(id),
  payment_id   uuid REFERENCES payment(id),
  entry_id     uuid REFERENCES entry(id),
  prize_id     uuid,
  posted_at    timestamptz NOT NULL DEFAULT now(),
  description  text NOT NULL,
  -- Set when this entry reverses another (T-8.4). The reversal is itself visible.
  reverses_txn_id uuid
);
CREATE INDEX ledger_entry_txn_idx     ON ledger_entry (txn_id);
CREATE INDEX ledger_entry_account_idx ON ledger_entry (account_id, posted_at DESC);
CREATE INDEX ledger_entry_draw_idx    ON ledger_entry (draw_id) WHERE draw_id IS NOT NULL;

-- T-12.1: every ledger transaction sums to zero.
--
-- This is a DEFERRED constraint trigger, checked at COMMIT rather than per row,
-- because the two halves of a transaction are inserted as separate statements.
-- Enforcing it here rather than in application code means a bug in a workflow
-- cannot produce unbalanced books — the transaction simply refuses to commit.
CREATE FUNCTION assert_ledger_txn_balances() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  imbalance bigint;
BEGIN
  SELECT COALESCE(SUM(amount_pence), 0) INTO imbalance
    FROM ledger_entry WHERE txn_id = NEW.txn_id;
  IF imbalance <> 0 THEN
    RAISE EXCEPTION
      'T-12.1 violated: ledger transaction % does not balance (out by % pence). Books must never be unbalanced.',
      NEW.txn_id, imbalance
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ledger_txn_must_balance
  AFTER INSERT ON ledger_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_txn_balances();

CREATE TABLE prize (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draw_id        uuid NOT NULL REFERENCES draw(id),
  entry_id       uuid NOT NULL REFERENCES entry(id),
  member_id      uuid NOT NULL REFERENCES member(id),
  amount_pence   bigint NOT NULL CHECK (amount_pence >= 0),
  status         prize_status NOT NULL DEFAULT 'pending_notification',
  workflow_id    text,                       -- 'prize-<uuid>'
  notified_at    timestamptz,
  claimed_at     timestamptz,
  paid_at        timestamptz,
  -- GAP-30: notification channel and payment mechanism both undefined.
  payment_method text,
  -- T-8.2: derived from prize_id, so a retried payout cannot pay twice.
  payout_idempotency_key text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  -- One prize per entry per draw: structural protection against double award.
  UNIQUE (draw_id, entry_id)
);
CREATE UNIQUE INDEX prize_payout_idempotency_uniq
  ON prize (payout_idempotency_key) WHERE payout_idempotency_key IS NOT NULL;
CREATE INDEX prize_status_idx ON prize (status) WHERE status <> 'paid';
CREATE INDEX prize_member_idx ON prize (member_id);

ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_prize_fk
  FOREIGN KEY (prize_id) REFERENCES prize(id);
