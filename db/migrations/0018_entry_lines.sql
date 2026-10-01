-- 0018_entry_lines — a member can hold several sets of numbers ("lines"),
-- each funded by its own paid weeks and/or its own Direct Debit.
--
-- Client rules (2026-10-01):
--  * A card purchase or Direct Debit setup with numbers the member already
--    has adds to that line (more weeks / a mandate behind it). Different
--    numbers start a new line: extra entries alongside the existing ones.
--  * Paid weeks are always used first; a Direct Debit on the same line is
--    paused while they last and resumes after.
--  * A member never has two entries in one draw with the same numbers.
--
-- A line is (prize_draw_no, slot) — `selection_standing` already keys
-- standing selections that way, and the entry idempotency key already ends
-- in the slot (`<draw>:<prize_draw_no>:<slot>`). This adds the slot to the
-- entry itself, and says which line a payment or mandate funds.

ALTER TABLE entry ADD COLUMN selection_slot int NOT NULL DEFAULT 1 CHECK (selection_slot >= 1);

ALTER TABLE payment
  ADD COLUMN line_prize_draw_no int REFERENCES member_number(prize_draw_no),
  ADD COLUMN line_slot int CHECK (line_slot >= 1),
  ADD CONSTRAINT payment_line_complete CHECK ((line_prize_draw_no IS NULL) = (line_slot IS NULL));

ALTER TABLE payment_method
  ADD COLUMN line_prize_draw_no int REFERENCES member_number(prize_draw_no),
  ADD COLUMN line_slot int CHECK (line_slot >= 1),
  ADD CONSTRAINT payment_method_line_complete CHECK ((line_prize_draw_no IS NULL) = (line_slot IS NULL));

-- What the member was told about a purchase or setup, so reloading the
-- confirmation page shows the same thing. A purchase may add weeks without
-- creating an entry of its own, so it no longer has to point at one.
ALTER TABLE pending_entry_purchase
  ADD COLUMN outcome_message text,
  DROP CONSTRAINT completed_purchases_record_their_entry;
ALTER TABLE pending_dd_setup ADD COLUMN outcome_message text;

-- ── Backfill: attribute what already exists ────────────────────────────────
-- Physical tickets: the ticket's own number, from the audit row written in
-- the same transaction (record-manual-ticket.ts).
UPDATE payment p
   SET line_prize_draw_no = (a.after->>'prizeDrawNo')::int, line_slot = 1
  FROM audit_log a
 WHERE p.channel = 'agent_cash' AND p.line_prize_draw_no IS NULL
   AND a.action = 'manual_ticket_recorded' AND a.entity_id = p.id
   AND EXISTS (SELECT 1 FROM member_number mn WHERE mn.prize_draw_no = (a.after->>'prizeDrawNo')::int);

-- Everything else (card blocks, matched standing orders, mandates): the
-- member's first number. Unattributed rows are treated the same way at
-- runtime, so this only makes it explicit.
UPDATE payment p
   SET line_prize_draw_no = first_no.prize_draw_no, line_slot = 1
  FROM (SELECT member_id, min(prize_draw_no) AS prize_draw_no FROM member_number WHERE member_id IS NOT NULL GROUP BY member_id) first_no
 WHERE p.line_prize_draw_no IS NULL AND p.member_id = first_no.member_id;

UPDATE payment_method pm
   SET line_prize_draw_no = first_no.prize_draw_no, line_slot = 1
  FROM (SELECT member_id, min(prize_draw_no) AS prize_draw_no FROM member_number WHERE member_id IS NOT NULL GROUP BY member_id) first_no
 WHERE pm.type = 'direct_debit' AND pm.line_prize_draw_no IS NULL AND pm.member_id = first_no.member_id;
