import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { basisPoints, pence, addPence, formatPence } from './money.js';
import {
  allocate,
  jackpotPosition,
  settleOutcome,
  revenueFor,
  mustBeWonTriggered,
  resolveMustBeWon,
  TICKET_PRICE_PENCE,
  DEFAULT_JACKPOT_FLOOR_PENCE,
  MUST_BE_WON_CAP_PENCE,
  type SplitConfig,
} from './allocation.js';
import { UnresolvedGapError } from './gaps.js';

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

  const NO_MATCHES = { match3: [], match2: [], match1: [] };

  it('rolls down to match-3 when match-3 has winners, ignoring lower tiers', () => {
    const result = resolveMustBeWon(pence(2_000_000), {
      match3: [{ entryId: 'e1', memberId: 'm1' }, { entryId: 'e2', memberId: 'm2' }],
      match2: [{ entryId: 'e3', memberId: 'm3' }],
      match1: [],
    });
    expect(result.tier).toBe(3);
    expect(result.shared.shares).toHaveLength(2);
    expect(result.shared.shares.every((s) => s.amountPence === pence(1_000_000))).toBe(true);
  });

  it('rolls down to match-2 when match-3 is empty', () => {
    const result = resolveMustBeWon(pence(300_000), { match3: [], match2: [{ entryId: 'e1', memberId: 'm1' }], match1: [] });
    expect(result.tier).toBe(2);
    expect(result.shared.shares).toEqual([{ entryId: 'e1', memberId: 'm1', amountPence: pence(300_000) }]);
  });

  it('rolls down to match-1 when match-3 and match-2 are both empty', () => {
    const result = resolveMustBeWon(pence(300_000), { match3: [], match2: [], match1: [{ entryId: 'e1', memberId: 'm1' }] });
    expect(result.tier).toBe(1);
  });

  it('splits equally per winner within the winning tier, one share per member', () => {
    // Same member holds two winning entries at match-3: one share, not two.
    const result = resolveMustBeWon(pence(300_000), {
      match3: [
        { entryId: 'e1', memberId: 'm1' },
        { entryId: 'e2', memberId: 'm1' },
        { entryId: 'e3', memberId: 'm2' },
      ],
      match2: [],
      match1: [],
    });
    const byMember = new Map<string, bigint>();
    for (const s of result.shared.shares) byMember.set(s.memberId, (byMember.get(s.memberId) ?? 0n) + s.amountPence);
    expect(byMember.get('m1')).toBe(pence(150_000));
    expect(byMember.get('m2')).toBe(pence(150_000));
  });

  it('an indivisible amount still sums exactly to the jackpot paid (T-12.1)', () => {
    const result = resolveMustBeWon(pence(100_001), {
      match3: [{ entryId: 'e1', memberId: 'm1' }, { entryId: 'e2', memberId: 'm2' }, { entryId: 'e3', memberId: 'm3' }],
      match2: [],
      match1: [],
    });
    const total = result.shared.shares.reduce((sum, s) => addPence(sum, s.amountPence), pence(0));
    expect(total).toBe(pence(100_001));
  });

  it('the residual case — nobody matched even one number — remains a real gap', () => {
    expect(() => resolveMustBeWon(pence(2_000_000), NO_MATCHES)).toThrow(UnresolvedGapError);
    expect(() => resolveMustBeWon(pence(2_000_000), NO_MATCHES)).toThrow(/GAP-24/);
  });
});
