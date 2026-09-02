-- 0012_online_prepaid_blocks — the online purchase flow (apps/api/src/entries.ts)
-- gains the same "buy N whole tickets up front" option the admin console
-- already offers for physical/agent tickets (GAP-17, prepaid_blocks). A
-- member paying by card for 4 or 12 draws at once is buying prepaid blocks
-- exactly like a standing order or an agent-collected physical ticket does,
-- not a single one-off entry, so it needs to be recorded before the payment
-- resolves — `blocks` defaults to 1 so every pre-existing row (all one-off
-- purchases) reads unchanged.

ALTER TABLE pending_entry_purchase ADD COLUMN blocks int NOT NULL DEFAULT 1 CHECK (blocks > 0);
