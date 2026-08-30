#!/usr/bin/env tsx
/**
 * Activate a new config_version row — T-3.1/T-3.2: config is versioned by
 * insertion, never UPDATEd, so a draw already in flight cannot be altered by a
 * mid-week change and every historical draw stays reconstructible under the
 * rules that applied to it.
 *
 * Carries every column forward from the currently active row (or the schema
 * defaults, if there has never been one) and overrides only what you pass —
 * so activating a decision on one gap can never silently reset another. A
 * strategy field only takes effect with its confirmer set alongside it
 * (tech spec §15.2: a value without a named confirmer is a suggestion).
 *
 *   ENTRY_STRATEGY=prepaid_blocks ENTRY_STRATEGY_CONFIRMED_BY="A. Client, 2026-08-30" \
 *   RNG_SOURCE=random_org RNG_SOURCE_CONFIRMED_BY="A. Client, 2026-08-30" \
 *   NOTE="GAP-17, GAP-21 resolved" \
 *   pnpm activate-config
 */
import { createPool, withTransaction } from '../pool.js';
import { appDbConnectionFromEnv } from '../pool.js';

interface ConfigRow {
  readonly id: string;
  // T-2.1: int8 columns parse as BigInt, not string — see packages/db/src/types.ts.
  readonly ticket_price_pence: bigint;
  readonly numbers_pool_n: number;
  readonly numbers_pick_k: number;
  readonly split_prize_bp: number;
  readonly split_good_cause_bp: number;
  readonly split_admin_bp: number;
  readonly jackpot_floor_pence: bigint;
  readonly must_be_won_cap_pence: bigint;
  readonly draw_day_of_week: number | null;
  readonly draw_time_local: string | null;
  readonly selection_cutoff_before: string | null;
  readonly claim_period_days: number | null;
  readonly reply_by_days: number | null;
  readonly payment_grace_days: number | null;
  readonly per_person_entry_cap: number | null;
  readonly recon_auto_threshold: string | null;
  readonly good_cause_floor_bp: number | null;
  readonly max_per_draw_proceeds_pence: bigint | null;
  readonly max_annual_proceeds_pence: bigint | null;
  readonly max_single_prize_pence: bigint | null;
  readonly entry_strategy: string | null;
  readonly entry_strategy_confirmed_by: string | null;
  readonly share_basis: string | null;
  readonly share_remainder_rule: string | null;
  readonly share_policy_confirmed_by: string | null;
  readonly rng_source: string | null;
  readonly rng_source_confirmed_by: string | null;
}

const OVERRIDABLE_COLUMNS = [
  'entry_strategy',
  'entry_strategy_confirmed_by',
  'share_basis',
  'share_remainder_rule',
  'share_policy_confirmed_by',
  'rng_source',
  'rng_source_confirmed_by',
  'per_person_entry_cap',
  'draw_day_of_week',
  'draw_time_local',
  'claim_period_days',
  'reply_by_days',
  'payment_grace_days',
] as const;

const pool = createPool({ ...appDbConnectionFromEnv(), applicationName: 'qosfc-activate-config', max: 1 });

try {
  const note = process.env['NOTE'] ?? '';

  const result = await withTransaction(pool, async (client) => {
    const { rows } = await client.query<ConfigRow>(
      `SELECT * FROM config_version WHERE is_active LIMIT 1`,
    );
    const current = rows[0];

    const overrides: Record<string, string | number | null> = {};
    for (const column of OVERRIDABLE_COLUMNS) {
      const envVar = column.toUpperCase();
      const raw = process.env[envVar];
      if (raw !== undefined) overrides[column] = raw;
    }

    const base = (current ?? {}) as unknown as Record<string, unknown>;
    const values: Record<string, unknown> = { ...base, ...overrides, note };

    if (current) {
      await client.query(`UPDATE config_version SET is_active = false WHERE id = $1`, [current.id]);
    }

    const allColumns = [
      'ticket_price_pence', 'numbers_pool_n', 'numbers_pick_k',
      'split_prize_bp', 'split_good_cause_bp', 'split_admin_bp',
      'jackpot_floor_pence', 'must_be_won_cap_pence',
      'draw_day_of_week', 'draw_time_local', 'selection_cutoff_before',
      'claim_period_days', 'reply_by_days', 'payment_grace_days',
      'per_person_entry_cap', 'recon_auto_threshold', 'good_cause_floor_bp',
      'max_per_draw_proceeds_pence', 'max_annual_proceeds_pence', 'max_single_prize_pence',
      'entry_strategy', 'entry_strategy_confirmed_by',
      'share_basis', 'share_remainder_rule', 'share_policy_confirmed_by',
      'rng_source', 'rng_source_confirmed_by',
      'note',
    ] as const;

    // Only columns with a real value are named in the INSERT. Naming a column
    // with NULL would override its schema DEFAULT — fine when carrying a value
    // forward from `current`, wrong for the very first row, where every unset
    // column should get its default (e.g. ticket_price_pence = 200) rather than
    // a NULL that violates its NOT NULL constraint.
    const columns = allColumns.filter((c) => values[c] !== undefined && values[c] !== null);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const params = columns.map((c) => values[c]);

    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO config_version (${columns.join(', ')}, is_active)
       VALUES (${placeholders}, true) RETURNING id`,
      params,
    );
    return { id: inserted[0]!.id, hadPrevious: Boolean(current) };
  });

  console.log(
    `Activated config_version ${result.id}` +
      (result.hadPrevious ? ' (superseding the previous active row).' : ' (first active row).'),
  );
  if (Object.keys(process.env).some((k) => (OVERRIDABLE_COLUMNS as readonly string[]).includes(k.toLowerCase()))) {
    console.log('Changed: ' + OVERRIDABLE_COLUMNS.filter((c) => process.env[c.toUpperCase()] !== undefined).join(', '));
  }
} finally {
  await pool.end();
}
