/**
 * Revenue allocation and jackpot determination — FR-6 / tech spec §2.
 *
 * This is the most audit-sensitive logic in the system, which is why it lives in
 * pure domain code called from workflow code rather than in an activity (T-6.4):
 * it is replayable and unit-testable without any infrastructure.
 */
import { type BasisPoints, type Pence, addPence, applyBasisPoints, maxPence, pence, subPence, ZERO } from './money.js';
import { unresolvedGap } from './gaps.js';

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
 * GAP-24 ⛔: WITH WHAT? D4 excluded every lower tier, so there is nothing to roll
 * down to. The four candidate mechanisms (roll down to nearest match, draw further
 * numbers, share among all entries, guaranteed-winner mechanic) are materially
 * different to members and to the books. `lottery_modelcomparison.xlsx` has a
 * `Forced (cap)` column that is empty in every modelled week — the model never
 * exercised it either.
 *
 * So this reports the condition and never resolves it. DrawWorkflow opens a
 * human_task and blocks (FR-5.3.5).
 */
export function mustBeWonTriggered(
  jackpotPreDrawPence: Pence,
  winnersCount: number,
  mustBeWonCapPence: Pence,
): boolean {
  return jackpotPreDrawPence >= mustBeWonCapPence && winnersCount === 0;
}

export function resolveMustBeWon(): never {
  unresolvedGap(
    'GAP-24',
    'the must-be-won mechanism at the £20,000 cap — D4 removed every lower tier, so there is ' +
      'nothing to roll down to. Options (roll down to nearest match / draw further numbers / ' +
      'share among all entries / guaranteed-winner mechanic) differ materially for members',
    'the client, and it must be published to members before go-live',
  );
}

export const TICKET_PRICE_PENCE = pence(200);
export const DEFAULT_JACKPOT_FLOOR_PENCE = pence(50_000);
export const MUST_BE_WON_CAP_PENCE = pence(2_000_000);
