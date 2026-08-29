/**
 * Money.
 *
 * T-2.1 / NFR-2: every monetary value is integer pence held as a bigint. There is
 * no floating point anywhere in this system, including in workflow arguments and
 * database round-trips (see packages/db/src/types.ts for the int8 parser, which is
 * the other half of this guarantee).
 */

/** Integer pence. Branded so a raw bigint cannot be passed where money is expected. */
export type Pence = bigint & { readonly __brand: 'Pence' };

/** Basis points; 10000 = 100%. T-2.2. */
export type BasisPoints = number & { readonly __brand: 'BasisPoints' };

export function pence(value: bigint | number): Pence {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new RangeError(`Money must be whole pence, got ${value}. T-2.1 forbids fractional pence.`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`${value} exceeds safe integer range; pass a bigint.`);
    }
    return BigInt(value) as Pence;
  }
  return value as Pence;
}

export function basisPoints(value: number): BasisPoints {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new RangeError(`Basis points must be a whole number in 0..10000, got ${value}.`);
  }
  return value as BasisPoints;
}

export const ZERO = pence(0n);

export const addPence = (a: Pence, b: Pence): Pence => (a + b) as Pence;
export const subPence = (a: Pence, b: Pence): Pence => (a - b) as Pence;
export const maxPence = (a: Pence, b: Pence): Pence => (a > b ? a : b);
export const minPence = (a: Pence, b: Pence): Pence => (a < b ? a : b);
export const sumPence = (xs: readonly Pence[]): Pence => xs.reduce(addPence, ZERO);

/**
 * Apply a basis-point share, truncating toward zero.
 *
 * Truncation is deliberate and never used alone: T-2.3 requires that a split be
 * made exact by deriving the last component as a remainder, so the pennies lost
 * to truncation here are always recovered by the caller rather than dropped.
 */
export function applyBasisPoints(amount: Pence, bp: BasisPoints): Pence {
  return ((amount * BigInt(bp)) / 10_000n) as Pence;
}

/** Format for display and audit output only. Never parse money back from this. */
export function formatPence(amount: Pence): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const pounds = abs / 100n;
  const remainder = abs % 100n;
  return `${negative ? '-' : ''}£${pounds.toLocaleString('en-GB')}.${remainder.toString().padStart(2, '0')}`;
}
