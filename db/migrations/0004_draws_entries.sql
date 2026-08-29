-- 0004_draws_entries — the draw, its frozen entry set, and standing selections
-- (functional spec §8-§10, tech spec §4.3).

CREATE TYPE draw_status AS ENUM ('open','closed','drawn','settled','void');
CREATE TYPE entry_funding AS ENUM ('balance','card','prepaid','agent');
CREATE TYPE selection_source AS ENUM ('member_chosen','randomly_allocated');

CREATE TABLE draw (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draw_number              int NOT NULL UNIQUE,
  draw_date                date NOT NULL,
  status                   draw_status NOT NULL DEFAULT 'open',
  -- T-3.2: makes any historical draw reconstructible under the rules that applied.
  config_version_id        uuid NOT NULL REFERENCES config_version(id),
  workflow_id              text,             -- 'draw-2026-W37'

  entries_count            int,
  revenue_pence            bigint,
  prize_contribution_pence bigint,
  good_cause_pence         bigint,
  admin_pence              bigint,
  rollover_in_pence        bigint,
  floor_topup_pence        bigint,           -- GAP-25: funding rule undefined
  jackpot_pre_draw_pence   bigint,

  winning_numbers          int[],
  -- NFR-1 / FR-5.3.6: the draw must be reproducible from stored data alone.
  -- GAP-21 ⛔: the acceptable entropy source has not been agreed with the
  -- licensing authority, so what goes in rng_source is not yet decided — but
  -- whatever it is, it is recorded here alongside the evidence.
  rng_source               text,
  rng_seed                 text,
  rng_evidence             jsonb,
  drawn_at                 timestamptz,
  drawn_by                 uuid,

  winners_count            int,
  jackpot_paid_pence       bigint,
  rollover_out_pence       bigint,
  must_be_won_triggered    boolean NOT NULL DEFAULT false,
  must_be_won_decision     jsonb,            -- GAP-24: the recorded human decision
  void_reason              text,             -- FR-5.3.4
  voided_by                uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  settled_at               timestamptz,

  -- T-12.1 invariants, enforced by the database and not only by tests.
  CONSTRAINT allocation_sums_to_revenue CHECK (
    revenue_pence IS NULL
    OR prize_contribution_pence + good_cause_pence + admin_pence = revenue_pence),
  CONSTRAINT payout_sums_to_jackpot CHECK (
    jackpot_paid_pence IS NULL
    OR jackpot_paid_pence + rollover_out_pence = jackpot_pre_draw_pence),
  CONSTRAINT winning_numbers_are_four_distinct_sorted CHECK (
    winning_numbers IS NULL
    OR (array_length(winning_numbers, 1) = 4
        AND winning_numbers[1] < winning_numbers[2]
        AND winning_numbers[2] < winning_numbers[3]
        AND winning_numbers[3] < winning_numbers[4]
        AND winning_numbers[1] >= 1 AND winning_numbers[4] <= 20)),
  -- FR-5.3.6: a drawn draw must carry its RNG provenance. No numbers without evidence.
  CONSTRAINT drawn_requires_rng_provenance CHECK (
    status NOT IN ('drawn','settled')
    OR (winning_numbers IS NOT NULL AND rng_source IS NOT NULL AND drawn_at IS NOT NULL))
);

CREATE INDEX draw_status_idx ON draw (status) WHERE status IN ('open','closed','drawn');
CREATE INDEX draw_date_idx ON draw (draw_date DESC);

CREATE TABLE entry (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draw_id        uuid NOT NULL REFERENCES draw(id),
  member_id      uuid NOT NULL REFERENCES member(id),
  prize_draw_no  int  NOT NULL REFERENCES member_number(prize_draw_no),
  selection      int[] NOT NULL,
  stake_pence    bigint NOT NULL DEFAULT 200,
  funding_source entry_funding NOT NULL,
  ledger_txn_id  uuid,
  -- T-8.2: '<draw_id>:<prize_draw_no>:<slot>'. Deterministic from workflow state,
  -- so a retried activity cannot double-enter a member into a draw.
  idempotency_key text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT selection_is_four_distinct_sorted CHECK (
    array_length(selection, 1) = 4
    AND selection[1] < selection[2] AND selection[2] < selection[3] AND selection[3] < selection[4]
    AND selection[1] >= 1 AND selection[4] <= 20)
);

CREATE UNIQUE INDEX entry_idempotency_key_uniq ON entry (idempotency_key);
CREATE INDEX entry_draw_idx ON entry (draw_id);
CREATE INDEX entry_member_idx ON entry (member_id, created_at DESC);
-- The winner scan: find every entry in a draw matching the drawn numbers.
CREATE INDEX entry_draw_selection_idx ON entry (draw_id, selection);

-- GAP-14: persistence of selections is undefined (standing until changed, vs
-- chosen per draw). The table supports standing selections with effective dates,
-- which accommodates both readings without pre-empting the decision.
CREATE TABLE selection_standing (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prize_draw_no  int NOT NULL REFERENCES member_number(prize_draw_no),
  slot           int NOT NULL DEFAULT 1,
  selection      int[] NOT NULL,
  -- GAP-13 ⛔: 'randomly_allocated' exists as a value but the POLICY permitting
  -- it is drafted and unconfirmed. Nothing may write this value until it is.
  source         selection_source NOT NULL,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT standing_selection_is_four_distinct_sorted CHECK (
    array_length(selection, 1) = 4
    AND selection[1] < selection[2] AND selection[2] < selection[3] AND selection[3] < selection[4]
    AND selection[1] >= 1 AND selection[4] <= 20)
);
CREATE UNIQUE INDEX selection_standing_current_uniq
  ON selection_standing (prize_draw_no, slot) WHERE effective_to IS NULL;
