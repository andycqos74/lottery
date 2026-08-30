/**
 * PostgreSQL type parsing.
 *
 * This module is the other half of the money guarantee in @qosfc/domain.
 *
 * node-postgres returns int8 (bigint) columns as JavaScript STRINGS by default,
 * because an int8 does not fit a Number. Left alone, the first developer who
 * writes `Number(row.amount_pence)` silently reintroduces floating-point money —
 * fine for £4.34, wrong above £90 trillion, and wrong in the corrosive way where
 * everything looks right until a total is a penny out.
 *
 * NFR-2 forbids that, so int8 is parsed to BigInt globally, once, here. Any code
 * that reads money from this database gets a bigint or nothing.
 */
import pg from 'pg';

const INT8_OID = 20;
const NUMERIC_OID = 1700;

let configured = false;

export function configurePgTypes(): void {
  if (configured) return;

  // int8 -> BigInt (T-2.1). Never Number.
  pg.types.setTypeParser(INT8_OID, (value: string) => BigInt(value));

  // numeric -> string. Confidence scores are the only numerics in this schema and
  // they are compared as strings or parsed deliberately at the call site; making
  // them Number here would be an invisible precision decision.
  pg.types.setTypeParser(NUMERIC_OID, (value: string) => value);

  configured = true;
}

/**
 * Read a money value that came back as PostgreSQL `numeric`.
 *
 * ⚠ The trap this exists for: an aggregate over a bigint column does NOT return
 * bigint. `SUM(amount_pence)` over an int8 column returns NUMERIC (OID 1700), so
 * it never reaches the int8 parser above and arrives as a string. Anyone who then
 * writes `Number(total)` has quietly reintroduced floating-point money in exactly
 * the place it does most damage — a total.
 *
 * Two defences, use either:
 *   1. Cast in SQL:  SUM(amount_pence)::bigint   ← preferred, keeps it typed
 *   2. Call this at the boundary.
 *
 * Money aggregates in this system are bounded by the annual proceeds limit, so
 * they always fit a bigint; the numeric is an artefact of SUM's return type, not
 * a range requirement.
 */
export function numericToPence(value: unknown, column: string): bigint {
  if (typeof value === 'bigint') return value;
  if (value === null || value === undefined) return 0n;
  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value)) {
      throw new TypeError(
        `${column} is ${value}, which is not whole pence. Money must never carry a fractional part (NFR-2).`,
      );
    }
    return BigInt(value);
  }
  throw new TypeError(`${column} came back as ${typeof value}; expected a bigint or a numeric string.`);
}

/** Guard for the boundary where a database row becomes domain money. */
export function assertBigint(value: unknown, column: string): bigint {
  if (typeof value !== 'bigint') {
    throw new TypeError(
      `${column} came back as ${typeof value}, not bigint. configurePgTypes() must run before the first query, ` +
        `or money will silently become floating point (NFR-2).`,
    );
  }
  return value;
}
