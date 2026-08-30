-- 0001_foundation — roles, extensions, and the configuration table.
--
-- Security note (T-9.4): migrations run as the OWNER role; the application
-- connects as `lottery_app`, which is granted only what each table's policy
-- allows. The application can never DROP, ALTER, or grant itself more.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";     -- case-insensitive email

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'lottery_app') THEN
    CREATE ROLE lottery_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'lottery_readonly') THEN
    CREATE ROLE lottery_readonly NOLOGIN;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Configuration and parameter versioning (tech spec §3).
--
-- T-3.1: a DrawWorkflow resolves the parameter set ONCE at start and carries it
-- for its whole life, so a mid-week change cannot alter a draw already in
-- flight. That requires config to be immutable and versioned, not editable —
-- hence a new row per version rather than an UPDATE.
-- ---------------------------------------------------------------------------
CREATE TABLE config_version (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  note             text NOT NULL DEFAULT '',
  -- Confirmed decisions D1-D9 (functional spec §4).
  ticket_price_pence      bigint NOT NULL DEFAULT 200 CHECK (ticket_price_pence > 0),
  numbers_pool_n          int    NOT NULL DEFAULT 20  CHECK (numbers_pool_n > 0),
  numbers_pick_k          int    NOT NULL DEFAULT 4   CHECK (numbers_pick_k > 0),
  split_prize_bp          int    NOT NULL DEFAULT 5000,
  split_good_cause_bp     int    NOT NULL DEFAULT 4000,
  split_admin_bp          int    NOT NULL DEFAULT 1000,
  jackpot_floor_pence     bigint NOT NULL DEFAULT 50000,
  must_be_won_cap_pence   bigint NOT NULL DEFAULT 2000000,

  -- UNSET values. NULL here is not "missing data" — it is an unresolved decision
  -- that halts the relevant process (FR-5.6). Each names its gap.
  draw_day_of_week        int    NULL,      -- GAP-16
  draw_time_local         time   NULL,      -- GAP-16
  selection_cutoff_before interval NULL,    -- GAP-16
  claim_period_days       int    NULL,      -- GAP-28
  reply_by_days           int    NULL,      -- GAP-45
  payment_grace_days      int    NULL,      -- GAP-11
  per_person_entry_cap    int    NULL,      -- GAP-26
  recon_auto_threshold    numeric(4,3) NULL,-- TG-04
  good_cause_floor_bp     int    NULL,      -- GAP-31
  max_per_draw_proceeds_pence bigint NULL,  -- GAP-36
  max_annual_proceeds_pence   bigint NULL,  -- GAP-36
  max_single_prize_pence      bigint NULL,  -- GAP-36

  -- Strategy selections. Each requires a named confirmer; a value without one
  -- is a suggestion, and tech spec §15.2 forbids shipping a suggestion as final.
  entry_strategy          text NULL,        -- GAP-17
  entry_strategy_confirmed_by text NULL,
  share_basis             text NULL,        -- GAP-22
  share_remainder_rule    text NULL,        -- GAP-23
  share_policy_confirmed_by text NULL,
  rng_source              text NULL,        -- GAP-21
  rng_source_confirmed_by text NULL,

  is_active               boolean NOT NULL DEFAULT false,

  CONSTRAINT split_sums_to_whole
    CHECK (split_prize_bp + split_good_cause_bp + split_admin_bp = 10000),   -- T-2.2
  CONSTRAINT entry_strategy_valid
    CHECK (entry_strategy IS NULL OR entry_strategy IN ('balance_ledger','fixed_schedule','prepaid_blocks')),
  CONSTRAINT share_basis_valid
    CHECK (share_basis IS NULL OR share_basis IN ('per_winning_entry','per_winner')),
  CONSTRAINT share_remainder_valid
    CHECK (share_remainder_rule IS NULL
           OR share_remainder_rule IN ('largest_remainder_to_winners','to_rollover','to_good_cause')),
  -- A strategy may not be in force without a named human behind it.
  CONSTRAINT entry_strategy_needs_confirmer
    CHECK (entry_strategy_confirmed_by IS NULL OR entry_strategy IS NOT NULL),
  CONSTRAINT share_policy_needs_confirmer
    CHECK (share_policy_confirmed_by IS NULL OR (share_basis IS NOT NULL AND share_remainder_rule IS NOT NULL))
);

-- Exactly one active configuration at a time.
CREATE UNIQUE INDEX config_version_one_active ON config_version ((is_active)) WHERE is_active;

COMMENT ON TABLE config_version IS
  'Immutable, versioned parameter sets. Never UPDATE a row: insert a new version and flip is_active. T-3.1/T-3.2.';
