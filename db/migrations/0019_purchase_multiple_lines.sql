-- 0019_purchase_multiple_lines — one card payment can buy several lines
-- (GitHub #19).
--
-- A member may pick more than one set of numbers at checkout and pay for
-- them all at once, each for the same number of draws. `selection` keeps
-- the first line, so every existing reader and every row written before
-- this migration reads unchanged; `selections` holds all of them, one row
-- of four numbers per line. NULL means the purchase had just `selection`.
--
-- The duplicates rule still holds: the same numbers twice in one purchase
-- are refused before payment, and numbers the member already has add weeks
-- to that line (0018) rather than a second entry with the same numbers.

ALTER TABLE pending_entry_purchase
  ADD COLUMN selections int[],
  ADD CONSTRAINT selections_are_lines_of_four CHECK (
    selections IS NULL OR (array_ndims(selections) = 2 AND array_length(selections, 2) = 4));
