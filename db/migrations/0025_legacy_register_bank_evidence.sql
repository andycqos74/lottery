-- 0025_legacy_register_bank_evidence — the legacy register import (T-11).
--
-- The working copy of the register QOSFC hands over carries, beside each
-- prize draw number's own columns, what the bank statements showed for it
-- over the last twelve months: how many payments, their total, and the
-- frequency they actually arrived at. That is evidence, not the register's
-- word — it can disagree with "Payment Type" (GAP-41) — so it is kept beside
-- the register's columns, verbatim, rather than overwriting them.
--
-- Written once, by tools/import-legacy-register.ts. Nothing reads these
-- columns to decide anything yet; they are there so a person looking at a
-- number can see what the bank said when it was loaded.

ALTER TABLE member_number
  ADD COLUMN legacy_payments_12m       int,
  ADD COLUMN legacy_total_12m_pence    bigint,
  ADD COLUMN legacy_observed_frequency text;

COMMENT ON COLUMN member_number.legacy_payments_12m IS
  'Legacy register import: payments seen on bank statements in the 12 months before the load.';
COMMENT ON COLUMN member_number.legacy_total_12m_pence IS
  'Legacy register import: total of those payments, pence.';
COMMENT ON COLUMN member_number.legacy_observed_frequency IS
  'Legacy register import: the frequency the payments actually arrived at, verbatim from the register.';
