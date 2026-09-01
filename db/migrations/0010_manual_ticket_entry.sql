-- 0010_manual_ticket_entry — recording a physical/agent-collected ticket
-- (functional spec §7/§8, GAP-19's neighbouring but distinct case: this is
-- for an IDENTIFIED member whose physical ticket has a known purchase date
-- and amount, not GAP-19's bulk agent lodgement with no per-member split).
--
-- Reuses the GAP-17 prepaid-blocks machinery: the money buys whole tickets
-- up front (amount ÷ ticket price), consumed one per open draw exactly like
-- a standing order, via the existing `entriesDue()`/`generateDueEntries()`
-- path — this migration only adds what that path was missing.

-- A one-off, admin-recorded cash channel, distinct from the bank-statement
-- channels above it: this money never passes through reconciliation, it is
-- entered directly the same way an online card purchase is.
ALTER TYPE payment_channel ADD VALUE 'agent_cash';

-- The member (or whoever is keying in their physical ticket) asked for
-- random numbers rather than choosing their own — a "quick pick", same as
-- 'member_chosen' in that it is the member's own request, NOT the same as
-- 'randomly_allocated' (GAP-13 ⛔, still blocked: the system silently
-- defaulting a non-responder's selection). Recording 'quick_pick' must never
-- be read as satisfying GAP-13.
ALTER TYPE selection_source ADD VALUE 'quick_pick';

-- Recorded for reference/audit only (per the client decision behind this
-- migration) — never joined against member_number.prize_draw_no or used in
-- any matching logic. A fresh prize_draw_no is still minted for the entry,
-- exactly as addEntry() and the online purchase flow already do.
ALTER TABLE payment ADD COLUMN physical_ticket_number text;

CREATE INDEX payment_physical_ticket_number_idx
  ON payment (physical_ticket_number) WHERE physical_ticket_number IS NOT NULL;
