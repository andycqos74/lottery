-- 0009_bank_transaction_no_balance_feed — the real bank export (GAP-33, B-10)
-- is a transaction history, not a statement: it carries no opening/closing
-- balance, so FR-5.8.2 continuity cannot be verified against it. Andy Cowan's
-- direction: drop the balance check for this feed, dedupe by transaction
-- identity instead, and revisit continuity checking as future-phase work if a
-- balance-bearing export ever becomes available.

ALTER TABLE bank_statement ALTER COLUMN opening_balance_pence DROP NOT NULL;
ALTER TABLE bank_statement ALTER COLUMN closing_balance_pence DROP NOT NULL;

-- `BankCredit.externalId` already existed on the port for exactly this
-- purpose (per-row identity from the source) but ingestion never used it.
-- Without it, two exports whose date ranges overlap would double-count every
-- transaction they share.
ALTER TABLE bank_transaction ADD COLUMN external_id text;
CREATE UNIQUE INDEX bank_transaction_external_id_uniq ON bank_transaction (external_id) WHERE external_id IS NOT NULL;

COMMENT ON COLUMN bank_statement.opening_balance_pence IS
  'NULL when the source is a transaction history with no balance figure (GAP-33, B-10) — chain_verified is false in that case, by fact rather than failure.';
COMMENT ON COLUMN bank_transaction.external_id IS
  'Stable per-row identity from the source feed, used to dedupe overlapping uploads. NULL for older rows ingested before this column existed.';
