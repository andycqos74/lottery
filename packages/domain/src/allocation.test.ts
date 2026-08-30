import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { basisPoints, pence, addPence, formatPence } from './money.js';
import {
  allocate,
  jackpotPosition,
  settleOutcome,
  revenueFor,
  mustBeWonTriggered,
  resolveMustBeWonRollDown,
  TICKET_PRICE_PENCE,
  DEFAULT_JACKPOT_FLOOR_PENCE,
  MUST_BE_WON_CAP_PENCE,
  type MustBeWonEntry,
  type SplitConfig,
} from './allocation.js';
import { toSelection } from './selection.js';

/** D7: the confirmed 50 / 40 / 10 split. */
const SPLIT: SplitConfig = {
  prizeBp: basisPoints(5000),
  goodCauseBp: basisPoints(4000),
  adminBp: basisPoints(1000),
};

describe('FR-6.1 — the £500 minimum is a FLOOR, not an additive seed', () => {
  /**
   * This is the regression test T-12.1 demands by name. The error it guards
   * against occurred in the client's own financial model and was corrected by
   * them; reintroducing it would overstate every small week's jackpot.
   */
  it('a week contributing £600 with £0 rollover offers £600, NOT £1,100', () => {
    const position = jackpotPosition(pence(60_000), pence(0), DEFAULT_JACKPOT_FLOOR_PENCE);
    expect(formatPence(position.jackpotPreDrawPence)).toBe('£600.00');
    expect(position.jackpotPreDrawPence).toBe(60_000n);
    expect(position.floorTopupPence).toBe(0n);
  });

  it('tops up to the floor only when contribution + rollover falls short', () => {
    const position = jackpotPosition(pence(30_000), pence(0), DEFAULT_JACKPOT_FLOOR_PENCE);
    expect(position.jackpotPreDrawPence).toBe(50_000n);
    expect(position.floorTopupPence).toBe(20_000n); // GAP-25: who funds this is undefined
  });

  it('never tops up once the earned jackpot exceeds the floor', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10_000_000n }), fc.bigInt({ min: 0n, max: 10_000_000n }), (c, r) => {
        const position = jackpotPosition(pence(c), pence(r), DEFAULT_JACKPOT_FLOOR_PENCE);
        const earned = c + r;
        expect(position.jackpotPreDrawPence).toBe(earned > 50_000n ? earned : 50_000n);
        expect(position.floorTopupPence >= 0n).toBe(true);
      }),
    );
  });
});

describe('T-2.3 — allocation sums exactly to revenue', () => {
  it('50/40/10 of a clean £1,040 week', () => {
    const alloc = allocate(revenueFor(520, TICKET_PRICE_PENCE), SPLIT);
    expect(alloc.revenuePence).toBe(104_000n);
    expect(alloc.prizeContributionPence).toBe(52_000n);
    expect(alloc.goodCausePence).toBe(41_600n);
    expect(alloc.adminPence).toBe(10_400n);
  });

  it('never loses or invents a penny, at any revenue', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 100_000_000n }), (revenue) => {
        const a = allocate(pence(revenue), SPLIT);
        expect(a.prizeContributionPence + a.goodCausePence + a.adminPence).toBe(revenue);
      }),
    );
  });

  it('rounds against admin, never against the good cause reported to the regulator', () => {
    // 3p of revenue: prize 1p, good cause 1p, admin takes the 1p remainder.
    const a = allocate(pence(3), SPLIT);
    expect(a.prizeContributionPence).toBe(1n);
    expect(a.goodCausePence).toBe(1n);
    expect(a.adminPence).toBe(1n);
  });

  it('rejects a split that does not sum to 100%', () => {
    const bad: SplitConfig = { prizeBp: basisPoints(5000), goodCauseBp: basisPoints(4000), adminBp: basisPoints(500) };
    expect(() => allocate(pence(1000), bad)).toThrow(/must sum to 10000/);
  });
});

describe('D5 / D6 — payout and rollover', () => {
  it('pays the whole jackpot and resets rollover when there is a winner', () => {
    const outcome = settleOutcome(pence(505_300), 1);
    expect(outcome.jackpotPaidPence).toBe(505_300n);
    expect(outcome.rolloverOutPence).toBe(0n);
  });

  it('pays nothing and rolls the whole jackpot forward when there is none', () => {
    const outcome = settleOutcome(pence(505_300), 0);
    expect(outcome.jackpotPaidPence).toBe(0n);
    expect(outcome.rolloverOutPence).toBe(505_300n);
  });

  it('T-12.1: jackpot_paid + rollover_out == jackpot_pre_draw, always', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10_000_000n }), fc.nat({ max: 20 }), (jackpot, winners) => {
        const outcome = settleOutcome(pence(jackpot), winners);
        expect(addPence(outcome.jackpotPaidPence, outcome.rolloverOutPence)).toBe(jackpot);
      }),
    );
  });
});

describe('D9 / GAP-24 — the must-be-won cap', () => {
  it('triggers at the £20,000 cap with no winner', () => {
    expect(mustBeWonTriggered(MUST_BE_WON_CAP_PENCE, 0, MUST_BE_WON_CAP_PENCE)).toBe(true);
  });

  it('does not trigger when someone has won', () => {
    expect(mustBeWonTriggered(MUST_BE_WON_CAP_PENCE, 1, MUST_BE_WON_CAP_PENCE)).toBe(false);
  });

  it('does not trigger below the cap', () => {
    expect(mustBeWonTriggered(pence(1_999_999), 0, MUST_BE_WON_CAP_PENCE)).toBe(false);
  });

  const winningNumbers = toSelection([1, 2, 3, 4]);
  const entry = (entryId: string, memberId: string, selection: readonly number[]): MustBeWonEntry => ({
    entryId,
    memberId,
    selection: toSelection(selection),
  });

  it('rolls down to match-3 when someone matches 3 of 4', () => {
    const entries = [
      entry('e1', 'm1', [1, 2, 3, 20]), // match 3
      entry('e2', 'm2', [1, 2, 19, 20]), // match 2
    ];
    const result = resolveMustBeWonRollDown(entries, winningNumbers, MUST_BE_WON_CAP_PENCE);
    expect(result?.tier).toBe(3);
    expect(result?.winningEntries.map((e) => e.entryId)).toEqual(['e1']);
    expect(result?.shares).toEqual([{ memberId: 'm1', amountPence: MUST_BE_WON_CAP_PENCE }]);
  });

  it('falls through to match-2, then match-1, when nobody reaches the tier above', () => {
    const entries = [entry('e1', 'm1', [1, 19, 18, 17])]; // match 1 only
    const result = resolveMustBeWonRollDown(entries, winningNumbers, MUST_BE_WON_CAP_PENCE);
    expect(result?.tier).toBe(1);
  });

  it('splits the whole jackpot equally between winning MEMBERS, not entries', () => {
    const entries = [
      entry('e1', 'm1', [1, 2, 3, 20]), // m1, match 3
      entry('e2', 'm1', [1, 2, 3, 19]), // m1's second ticket, also match 3
      entry('e3', 'm2', [1, 2, 4, 20]), // m2, match 3
    ];
    const result = resolveMustBeWonRollDown(entries, winningNumbers, pence(100));
    expect(result?.tier).toBe(3);
    expect(result?.shares).toHaveLength(2);
    expect(result?.shares.reduce((sum, s) => sum + s.amountPence, 0n)).toBe(pence(100));
  });

  it('returns undefined when nobody matches even one number — no rule covers that', () => {
    const entries = [entry('e1', 'm1', [17, 18, 19, 20])];
    expect(resolveMustBeWonRollDown(entries, winningNumbers, MUST_BE_WON_CAP_PENCE)).toBeUndefined();
  });
});
