-- 0008_gap_resolutions — the first batch of blocker answers (docs/gap-register.md).
--
-- Per the register's own rule ("When a decision arrives — a strategy: set the
-- value AND its *_confirmed_by column"): this inserts one new config_version row
-- carrying the two decisions that are genuine strategy selections rather than
-- infrastructure/adapter choices (those live in deploy/.env, not the database).
-- Never UPDATE config_version — insert-and-activate, per T-3.1.

-- Deactivate whatever is currently active first — the unique index allows at
-- most one active row, and INSERT ... is_active = true would otherwise race it.
UPDATE config_version SET is_active = false WHERE is_active;

INSERT INTO config_version (
  note,
  entry_strategy, entry_strategy_confirmed_by,
  rng_source, rng_source_confirmed_by,
  is_active
)
VALUES (
  'GAP-17: prepaid blocks set as standard. GAP-21: random.org (generateSignedIntegers, ' ||
    'https://www.random.org/clients/http/) as the chosen entropy source; licence sign-off on this ' ||
    'source with the registering authority remains outstanding — see docs/gap-register.md.',
  'prepaid_blocks', 'client decision recorded 2026-08-30',
  'external_certified', 'client decision recorded 2026-08-30',
  true
);
