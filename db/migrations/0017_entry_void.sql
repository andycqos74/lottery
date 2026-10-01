-- 0017_entry_void — entries made ahead of time can be withdrawn.
--
-- Direct Debit members are now entered into every upcoming draw as soon as
-- it is created, so members see they are in it and the jackpot counts them.
-- When a mandate is cancelled, entries in draws still taking entries must
-- come out again. Entries are never deleted (0007 revokes DELETE from the
-- app role, and the audit trail depends on it), so they are voided instead.
--
-- A voided entry is not an entry: every count, winner scan and member view
-- excludes rows with voided_at set. 0007's trigger still freezes the whole
-- entry set once a draw is drawn, so nothing can be voided after the numbers
-- are generated (FR-5.3.3).

ALTER TABLE entry
  ADD COLUMN voided_at   timestamptz,
  ADD COLUMN void_reason text,
  ADD CONSTRAINT void_has_reason CHECK (voided_at IS NULL OR void_reason IS NOT NULL);

CREATE INDEX entry_live_draw_idx ON entry (draw_id) WHERE voided_at IS NULL;
