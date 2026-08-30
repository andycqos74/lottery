-- 0007_append_only_security — T-9.4 / FR-13.2.
--
-- "Database-level protection against UPDATE/DELETE on ledger_entry, entry, and
-- draw post-settlement."
--
-- This is the migration that makes the audit guarantees real. Everything above
-- describes intent; this makes the intent unbypassable by application code, by a
-- bug in a workflow, or by an operator with the application's own credentials.
-- Corrections are compensating entries, never edits (T-8.4).

-- ---------------------------------------------------------------------------
-- 1. Grants. The application role gets the least privilege each table allows.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO lottery_app, lottery_readonly;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lottery_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO lottery_readonly;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lottery_app;

-- Append-only tables: the application may read and insert, and nothing more.
-- Revoking is what makes this real — a compromised application session cannot
-- rewrite the books, because the privilege does not exist to be misused.
REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entry FROM lottery_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log    FROM lottery_app;
REVOKE DELETE, TRUNCATE          ON entry       FROM lottery_app;
REVOKE DELETE, TRUNCATE          ON draw        FROM lottery_app;
REVOKE DELETE, TRUNCATE          ON payment     FROM lottery_app;
REVOKE DELETE, TRUNCATE          ON prize       FROM lottery_app;
REVOKE UPDATE, DELETE, TRUNCATE  ON config_version FROM lottery_app;
-- config_version is versioned by insertion (T-3.1); only is_active may move.
GRANT UPDATE (is_active) ON config_version TO lottery_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lottery_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO lottery_readonly;

-- ---------------------------------------------------------------------------
-- 2. Immutability after settlement.
--
-- FR-5.3.3: "Once winning numbers are generated, the entry set is frozen. No
-- entry may be added, amended, or voided against that draw thereafter."
--
-- Tech spec §4.3 requires this by TRIGGER, not application code, and that
-- distinction matters: the freeze must hold even when the code that would have
-- honoured it is the thing that has gone wrong.
-- ---------------------------------------------------------------------------
CREATE FUNCTION forbid_entry_change_after_draw() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d_status draw_status;
  d_number int;
BEGIN
  SELECT status, draw_number INTO d_status, d_number
    FROM draw WHERE id = COALESCE(NEW.draw_id, OLD.draw_id);

  IF d_status IN ('drawn','settled') THEN
    RAISE EXCEPTION
      'FR-5.3.3: draw % is % — its entry set is frozen. Entries cannot be added, amended or voided after the numbers are generated.',
      d_number, d_status
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER entry_frozen_after_draw
  BEFORE INSERT OR UPDATE OR DELETE ON entry
  FOR EACH ROW EXECUTE FUNCTION forbid_entry_change_after_draw();

-- A settled draw's financial facts are final. Only operational columns that
-- cannot change the money — the workflow pointer — may still move.
CREATE FUNCTION forbid_settled_draw_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'settled' THEN
    IF NEW.draw_number            IS DISTINCT FROM OLD.draw_number
       OR NEW.revenue_pence       IS DISTINCT FROM OLD.revenue_pence
       OR NEW.prize_contribution_pence IS DISTINCT FROM OLD.prize_contribution_pence
       OR NEW.good_cause_pence    IS DISTINCT FROM OLD.good_cause_pence
       OR NEW.admin_pence         IS DISTINCT FROM OLD.admin_pence
       OR NEW.winning_numbers     IS DISTINCT FROM OLD.winning_numbers
       OR NEW.jackpot_pre_draw_pence IS DISTINCT FROM OLD.jackpot_pre_draw_pence
       OR NEW.jackpot_paid_pence  IS DISTINCT FROM OLD.jackpot_paid_pence
       OR NEW.rollover_out_pence  IS DISTINCT FROM OLD.rollover_out_pence
       OR NEW.rng_source          IS DISTINCT FROM OLD.rng_source
       OR NEW.rng_seed            IS DISTINCT FROM OLD.rng_seed
       OR NEW.status              IS DISTINCT FROM OLD.status
    THEN
      RAISE EXCEPTION
        'FR-13.2: draw % is settled and immutable. Correct it with compensating ledger entries, never by editing the draw.',
        OLD.draw_number
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER draw_immutable_once_settled
  BEFORE UPDATE ON draw
  FOR EACH ROW EXECUTE FUNCTION forbid_settled_draw_change();

-- A paid prize is final. FR-5.7.1 records every transition; none of them is a rewrite.
CREATE FUNCTION forbid_paid_prize_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'paid' AND (NEW.amount_pence IS DISTINCT FROM OLD.amount_pence
                              OR NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION
      'FR-13.2: prize % is paid and immutable. Reverse it with a compensating ledger entry.', OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER prize_immutable_once_paid
  BEFORE UPDATE ON prize
  FOR EACH ROW EXECUTE FUNCTION forbid_paid_prize_change();

-- ---------------------------------------------------------------------------
-- 3. Self-exclusion takes effect immediately (FR-11.3), including against any
--    code path that would otherwise enter an excluded member into a draw.
-- ---------------------------------------------------------------------------
CREATE FUNCTION forbid_entry_for_excluded_member() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  m_status member_status;
BEGIN
  SELECT status INTO m_status FROM member WHERE id = NEW.member_id;
  IF m_status IN ('self_excluded','deceased','cancelled','quarantined') THEN
    RAISE EXCEPTION
      'FR-11.3: member % is %; no entry may be created for them.', NEW.member_id, m_status
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER entry_blocked_for_excluded_member
  BEFORE INSERT ON entry
  FOR EACH ROW EXECUTE FUNCTION forbid_entry_for_excluded_member();
