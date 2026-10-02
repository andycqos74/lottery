/**
 * The lines a member picks for one card payment (GitHub #19): validated
 * before any payment is taken.
 */
import { describe, expect, it } from 'vitest';
import { MAX_LINES_PER_PURCHASE, normaliseLines } from './entries.js';

describe('normaliseLines (GitHub #19)', () => {
  it('sorts each line and keeps them in the order picked, ignoring empty pickers', () => {
    expect(normaliseLines([[14, 2, 9, 4], [], [20, 1, 5, 3]])).toEqual({ kind: 'ok', lines: [[2, 4, 9, 14], [1, 3, 5, 20]] });
  });

  it('refuses the same numbers twice, whatever order they were picked in', () => {
    const outcome = normaliseLines([[1, 2, 3, 4], [4, 3, 2, 1]]);
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.reason).toMatch(/1, 2, 3, 4 more than once/);
  });

  it('names the line that is incomplete or out of range', () => {
    expect(normaliseLines([[1, 2, 3, 4], [5, 6, 7]])).toEqual({
      kind: 'rejected',
      reason: 'Line 2 must be four distinct numbers between 1 and 20.',
    });
    expect(normaliseLines([[1, 2, 3, 4], [5, 6, 7, 21]])).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('Line 2') });
    expect(normaliseLines([[1, 2, 3]])).toEqual({ kind: 'rejected', reason: 'A selection must be four distinct numbers between 1 and 20.' });
  });

  it('needs at least one line, and no more than the most one payment can buy', () => {
    expect(normaliseLines([[]]).kind).toBe('rejected');
    const tooMany = Array.from({ length: MAX_LINES_PER_PURCHASE + 1 }, (_, i) => [i + 1, i + 2, i + 3, i + 4]);
    expect(normaliseLines(tooMany)).toMatchObject({ kind: 'rejected', reason: expect.stringContaining(`up to ${MAX_LINES_PER_PURCHASE} lines`) });
    expect(normaliseLines(tooMany.slice(0, MAX_LINES_PER_PURCHASE)).kind).toBe('ok');
  });
});
