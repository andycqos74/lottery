/**
 * Revenue allocation and jackpot determination — FR-6 / tech spec §2.
 *
 * This is the most audit-sensitive logic in the system, which is why it lives in
 * pure domain code called from workflow code rather than in an activity (T-6.4):
 * it is replayable and unit-testable without any infrastructure.
 */
import { type BasisPoints, type Pence, addPence, applyBasisPoints, maxPence, pence, subPence, ZERO } from './money.js';
import { unresolvedGap } from './gaps.js';
import { shareJackpot, type SharedJackpot, type WinningEntry } from './prize-sharing.js';

export interface SplitConfig {
  readonly prizeBp: BasisPoints;
  readonly goodCauseBp: BasisPoints;
  readonly adminBp: BasisPoints;
}

export interface DrawParameters {
  readonly ticketPricePence: Pence;
  readonly split: SplitConfig;
  readonly jackpotFloorPence: Pence;
  readonly mustBeWonCapPence: Pence;
}

export interface Allocation {
  readonly revenuePence: Pence;
  readonly prizeContributionPence: Pence;
  readonly goodCausePence: Pence;
  readonly adminPence: Pence;
}

/**
 * D7: 50% prizes / 40% good causes / 10% admin, every week.
 *
 * T-2.3: the allocation must sum EXACTLY to revenue. Two components are computed
 * and the third is derived as the remainder, so truncated pennies land somewhere
 * defined rather than vanishing. Rounding three shares independently would leave
 * the books out by a penny in most weeks.
 *
 * Admin takes the remainder deliberately: the good-cause share is reported to the
 * licensing authority against a statutory floor (FR-8.3, GAP-31), so it must never
 * be the line that absorbs a rounding loss.
 */
export function allocate(revenuePence: Pence, split: SplitConfig): Allocation {
  assertSplitSumsToWhole(split);
  const prizeContributionPence = applyBasisPoints(revenuePence, split.prizeBp);
  const goodCausePence = applyBasisPoints(revenuePence, split.goodCauseBp);
  const adminPence = subPence(revenuePence, addPence(prizeContributionPence, goodCausePence));
  return { revenuePence, prizeContributionPence, goodCausePence, adminPence };
}

export function assertSplitSumsToWhole(split: SplitConfig): void {
  const total = split.prizeBp + split.goodCauseBp + split.adminBp;
  if (total !== 10_000) {
    throw new RangeError(
      `T-2.2: the active split must sum to 10000 basis points; ${split.prizeBp}+${split.goodCauseBp}+${split.adminBp}=${total}.`,
    );
  }
}

export function revenueFor(entriesCount: number, ticketPricePence: Pence): Pence {
  if (!Number.isInteger(entriesCount) || entriesCount < 0) {
    throw new RangeError(`Entry count must be a non-negative whole number, got ${entriesCount}.`);
  }
  return (BigInt(entriesCount) * ticketPricePence) as Pence;
}

export interface JackpotPosition {
  readonly rolloverInPence: Pence;
  readonly jackpotPreDrawPence: Pence;
  /** The amount the floor added over and above contribution + rollover. Funding rule is GAP-25. */
  readonly floorTopupPence: Pence;
}

/**
 * D8 / FR-6.1: the £500 minimum is a FLOOR, not an additive seed.
 *
 *     jackpot = MAX(floor, contribution + rollover)
 *
 * A week contributing £600 with £0 rollover offers £600, not £1,100. This exact
 * error occurred in the client's financial model and was corrected by them; the
 * regression test in allocation.test.ts exists specifically to stop it returning.
 */
export function jackpotPosition(
  prizeContributionPence: Pence,
  rolloverInPence: Pence,
  jackpotFloorPence: Pence,
): JackpotPosition {
  const earned = addPence(prizeContributionPence, rolloverInPence);
  const jackpotPreDrawPence = maxPence(jackpotFloorPence, earned);
  return {
    rolloverInPence,
    jackpotPreDrawPence,
    floorTopupPence: subPence(jackpotPreDrawPence, earned),
  };
}

export interface DrawOutcome {
  readonly jackpotPaidPence: Pence;
  readonly rolloverOutPence: Pence;
  readonly winnersCount: number;
}

/**
 * D5 / D6: if anyone matches all four the jackpot pays and rollover resets;
 * otherwise nothing pays and the whole jackpot rolls forward.
 */
export function settleOutcome(jackpotPreDrawPence: Pence, winnersCount: number): DrawOutcome {
  if (winnersCount < 0 || !Number.isInteger(winnersCount)) {
    throw new RangeError(`Winner count must be a non-negative whole number, got ${winnersCount}.`);
  }
  return winnersCount > 0
    ? { jackpotPaidPence: jackpotPreDrawPence, rolloverOutPence: ZERO, winnersCount }
    : { jackpotPaidPence: ZERO, rolloverOutPence: jackpotPreDrawPence, winnersCount };
}

/**
 * D9: the must-be-won cap forces a win at £20,000.
 *
 * GAP-24, resolved by the client (2026-08-30, see docs/gap-register.md): roll
 * down to match 3, then match 2, then match 1 — the first of those tiers that
 * has a winning entry pays, split equally among the winners in that tier. This
 * ladder exists ONLY for the must-be-won escape valve; D4 still stands for the
 * ordinary weekly game, where matching 3 or fewer pays nothing (FR-6.2).
 */
export function mustBeWonTriggered(
  jackpotPreDrawPence: Pence,
  winnersCount: number,
  mustBeWonCapPence: Pence,
): boolean {
  return jackpotPreDrawPence >= mustBeWonCapPence && winnersCount === 0;
}

/** Entries at each rung of the GAP-24 roll-down ladder, by number of numbers matched. */
export interface MustBeWonMatchTiers {
  readonly match3: readonly WinningEntry[];
  readonly match2: readonly WinningEntry[];
  readonly match1: readonly WinningEntry[];
}

export interface MustBeWonRollDown {
  /** Which rung actually paid. */
  readonly tier: 3 | 2 | 1;
  readonly shared: SharedJackpot;
}

/**
 * This is the roll-down policy the client confirmed for GAP-24 specifically —
 * separate from GAP-22 (`config_version.share_basis`), which still governs how
 * an ORDINARY match-4 jackpot is shared and remains unresolved. The two happen
 * to share a shape (equal split, largest-remainder-to-winners) because that is
 * what "split equally between winners in the winning tier" means, not because
 * one setting drives the other.
 */
const MUST_BE_WON_ROLLDOWN_CONFIRMED_BY = 'GAP-24 roll-down (client decision, see docs/gap-register.md)';

/**
 * Roll a must-be-won jackpot down the ladder and split it.
 *
 * Pure and deterministic (T-6.4): the caller supplies each tier's winning
 * entries — from a frozen entry set already matched against the drawn numbers
 * (`countMatches` in selection.ts) — and this decides nothing about identity or
 * timing, only the money.
 */
export function resolveMustBeWon(jackpotPaidPence: Pence, tiers: MustBeWonMatchTiers): MustBeWonRollDown {
  const ladder: readonly (readonly [3 | 2 | 1, readonly WinningEntry[]])[] = [
    [3, tiers.match3],
    [2, tiers.match2],
    [1, tiers.match1],
  ];
  for (const [tier, entries] of ladder) {
    if (entries.length === 0) continue;
    const shared = shareJackpot(jackpotPaidPence, entries, {
      basis: 'per_winner',
      remainder: 'largest_remainder_to_winners',
      confirmedBy: MUST_BE_WON_ROLLDOWN_CONFIRMED_BY,
    });
    return { tier, shared };
  }
  // Not reached in practice at N=20/K=4 against a real membership base, but the
  // client's decision did not cover "nobody matched even one number" — that
  // residual stays a real gap rather than an invented default.
  unresolvedGap(
    'GAP-24',
    'the must-be-won roll-down reached match-1 with no winning entries at any tier. The confirmed ' +
      'roll-down (match 3 → 2 → 1, split equally) did not cover this residual case',
    'the client',
  );
}

export const TICKET_PRICE_PENCE = pence(200);
export const DEFAULT_JACKPOT_FLOOR_PENCE = pence(50_000);
export const MUST_BE_WON_CAP_PENCE = pence(2_000_000);
