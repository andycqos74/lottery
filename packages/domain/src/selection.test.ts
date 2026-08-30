import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { COMBINATIONS, isWinningSelection, parseSelection, toSelection, InvalidSelectionError } from './selection.js';

describe('D3 / FR-3.1 — pick 4 distinct from 1..20', () => {
  it('C(20,4) is 4845', () => {
    expect(COMBINATIONS).toBe(4845);
  });

  it('stores sorted ascending regardless of input order', () => {
    expect(toSelection([14, 3, 20, 9])).toEqual([3, 9, 14, 20]);
  });

  it.each([
    [[1, 2, 3], 'A selection is 4 numbers'],
    [[1, 2, 3, 4, 5], 'A selection is 4 numbers'],
    [[1, 1, 2, 3], 'must be different'],
    [[0, 1, 2, 3], 'Numbers run 1 to 20'],
    [[1, 2, 3, 21], 'Numbers run 1 to 20'],
    [[1.5, 2, 3, 4], 'whole numbers'],
  ])('rejects %j', (input, expected) => {
    expect(() => toSelection(input)).toThrow(InvalidSelectionError);
    expect(() => toSelection(input)).toThrow(new RegExp(expected));
  });

  it('FR-3.3: parseSelection returns a specific reason rather than throwing', () => {
    const result = parseSelection([1, 1, 2, 3]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/different/);
  });
});

describe('T-5.1 — matching uses the sorted canonical form, never positional', () => {
  it('matches irrespective of the order the numbers were drawn in', () => {
    const picked = toSelection([3, 9, 14, 20]);
    const drawn = toSelection([14, 3, 20, 9]);
    expect(isWinningSelection(picked, drawn)).toBe(true);
  });

  it('D4 / FR-6.2: three matching numbers is not a win', () => {
    expect(isWinningSelection(toSelection([1, 2, 3, 4]), toSelection([1, 2, 3, 5]))).toBe(false);
  });

  it('canonicalisation makes matching order-independent for any permutation', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 20 }), { minLength: 4, maxLength: 4 }),
        fc.integer({ min: 0, max: 23 }),
        (numbers, shuffleSeed) => {
          const shuffled = [...numbers].sort(() => (shuffleSeed % 2 === 0 ? 1 : -1));
          expect(isWinningSelection(toSelection(numbers), toSelection(shuffled))).toBe(true);
        },
      ),
    );
  });
});
