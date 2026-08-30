/**
 * Revenue allocation and jackpot determination — FR-6 / tech spec §2.
 *
 * This is the most audit-sensitive logic in the system, which is why it lives in
 * pure domain code called from workflow code rather than in an activity (T-6.4):
 * it is replayable and unit-testable without any infrastructure.
 */
import { type BasisPoints, type Pence, addPence, applyBasisPoints, maxPence, pence, subPence, ZERO } from './money.js';
import { matchCount, type Selection } from './selection.js';

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
 */
export function mustBeWonTriggered(
  jackpotPreDrawPence: Pence,
  winnersCount: number,
  mustBeWonCapPence: Pence,
): boolean {
  return jackpotPreDrawPence >= mustBeWonCapPence && winnersCount === 0;
}

/** An entry as seen by the must-be-won roll-down: who holds it, and what they picked. */
export interface MustBeWonEntry {
  readonly entryId: string;
  readonly memberId: string;
  readonly selection: Selection;
}

export interface MustBeWonShare {
  readonly memberId: string;
  readonly amountPence: Pence;
}

export interface MustBeWonRollDown {
  /** The tier the roll-down landed on. */
  readonly tier: 3 | 2 | 1;
  readonly winningEntries: readonly MustBeWonEntry[];
  /** The whole jackpot, split equally between winning MEMBERS (not entries) in this tier. */
  readonly shares: readonly MustBeWonShare[];
}

/**
 * GAP-24, resolved: at the £20,000 must-be-won cap, roll down to the highest
 * populated tier among match-3, match-2, match-1 in that order. D4 removed those
 * tiers from the ordinary game — nobody below a match-4 wins in a normal draw —
 * but the must-be-won mechanism specifically reintroduces them as a last resort,
 * and only then. The total jackpot is split equally between winners in whichever
 * tier is reached (per member, not per entry — a member holding two winning
 * tickets in the tier still takes one share).
 *
 * Returns `undefined` only in the practically-impossible case where no entry
 * matches even a single number. No rule covers that; DrawWorkflow must still
 * raise a human task rather than invent one.
 */
export function resolveMustBeWonRollDown(
  entries: readonly MustBeWonEntry[],
  winningNumbers: Selection,
  jackpotPreDrawPence: Pence,
): MustBeWonRollDown | undefined {
  for (const tier of [3, 2, 1] as const) {
    const winningEntries = entries.filter((e) => matchCount(e.selection, winningNumbers) === tier);
    if (winningEntries.length === 0) continue;

    const memberIds = [...new Set(winningEntries.map((e) => e.memberId))].sort();
    const shareCount = BigInt(memberIds.length);
    const baseShare = (jackpotPreDrawPence / shareCount) as Pence;
    const remainder = jackpotPreDrawPence % shareCount;
    // Equal shares with an indivisible remainder: same auditable rule as
    // shareJackpot's 'largest_remainder_to_winners' — the first N members by id
    // take one extra penny each, so the total still balances to the pound (T-12.1).
    const shares = memberIds.map((memberId, index) => ({
      memberId,
      amountPence: (index < Number(remainder) ? baseShare + 1n : baseShare) as Pence,
    }));

    return { tier, winningEntries, shares };
  }
  return undefined;
}

export const TICKET_PRICE_PENCE = pence(200);
export const DEFAULT_JACKPOT_FLOOR_PENCE = pence(50_000);
export const MUST_BE_WON_CAP_PENCE = pence(2_000_000);
