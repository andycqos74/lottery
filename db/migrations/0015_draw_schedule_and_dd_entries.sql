-- 0015_draw_schedule_and_dd_entries — testing-feedback round (GitHub #4, #5, #9).
--
-- #4/#5: a draw carries an optional human name, an exact draw time, and the
-- moment entries close. `draw_date` stays (every existing query and the
-- portal read it) and is kept equal to the London calendar date of `draw_at`.
-- Rows created before this migration have neither timestamp — every reader
-- treats a NULL `entries_close_at` as "no cutoff", which is how they behaved.
--
-- A recurring series is recorded in `draw_schedule` purely as provenance: the
-- individual draws are materialised up front (one row each, all 'open'), so
-- nothing here needs a scheduler to exist before a draw can be entered.

CREATE TABLE draw_schedule (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text,
  start_date          date NOT NULL,
  end_date            date NOT NULL,
  recurrence          text NOT NULL CHECK (recurrence IN ('weekly','fortnightly','monthly')),
  draw_time_local     time NOT NULL,
  -- Entries close this many hours before each draw (the admin form's "-10 hours").
  cutoff_hours_before int  NOT NULL CHECK (cutoff_hours_before >= 0),
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedule_ends_after_start CHECK (end_date >= start_date)
);

ALTER TABLE draw
  ADD COLUMN name             text,
  ADD COLUMN draw_at          timestamptz,
  ADD COLUMN entries_close_at timestamptz,
  ADD COLUMN draw_schedule_id uuid REFERENCES draw_schedule(id),
  ADD CONSTRAINT entries_close_before_draw
    CHECK (entries_close_at IS NULL OR draw_at IS NULL OR entries_close_at <= draw_at);

CREATE INDEX draw_open_by_time_idx ON draw (draw_at) WHERE status = 'open';

-- #9: a member paying by Direct Debit is entered into every draw while their
-- mandate is active, rather than drawing down prepaid blocks — the client's
-- instruction on the testing-feedback round. The entry records that funding.
ALTER TYPE entry_funding ADD VALUE 'direct_debit';
