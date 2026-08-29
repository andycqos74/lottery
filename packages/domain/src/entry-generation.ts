/**
 * Turning money into entries — FR-4 / GAP-17 ⛔ / T-5.4.
 *
 * A density of 0.521 tickets/week is a modelling average, not an instruction.
 * Three materially different implementations were identified, and the choice
 * changes what a member is owed:
 *
 *   (a) balance ledger  — payments credit a balance, each draw debits £2 while
 *                         funds allow, residuals accumulate
 *   (b) fixed schedule  — pre-computed weeks regardless of payment
 *   (c) prepaid blocks  — each payment buys N whole tickets
 *
 * T-5.4 requires all three to exist behind one interface with the unselected ones
 * failing explicitly rather than falling through. That is what this module is.
 */
import { type Pence, ZERO } from './money.js';
import { unresolvedGap } from './gaps.js';

export type EntryStrategyName = 'balance_ledger' | 'fixed_schedule' | 'prepaid_blocks';

export interface MemberEntryState {
  readonly memberId: string;
  /** Cleared funds available to buy entries, in pence. */
  readonly balancePence: Pence;
  /** Entries already bought and not yet consumed, under the prepaid model. */
  readonly prepaidEntriesRemaining: number;
  /** Whole entries per week under the fixed-schedule model, derived from annual basis. */
  readonly scheduledEntriesPerDraw: number;
  /** True when the member is agent-collected — GAP-19, no entry model exists at all. */
  readonly isAgentCollected: boolean;
}

export interface EntriesDue {
  readonly count: number;
  readonly costPence: Pence;
  readonly balanceAfterPence: Pence;
}

export interface EntryGenerationConfig {
  readonly strategy: EntryStrategyName | undefined;
  readonly ticketPricePence: Pence;
  /** Who confirmed the strategy, and when. Absent means it is not in force. */
  readonly confirmedBy?: string;
  /** GAP-26: a per-person cap closes the syndicate exposure. No value has ever been set. */
  readonly perPersonEntryCap?: number;
}

/**
 * How many entries is this member due in this draw, and what does it cost them?
 *
 * Pure and deterministic: called from workflow code (T-5.4), so it must replay
 * identically forever.
 */
export function entriesDue(state: MemberEntryState, cfg: EntryGenerationConfig): EntriesDue {
  if (state.isAgentCollected) {
    // GAP-19 ⛔ — 782 of 1,591 members, 49% of the register, with no functional
    // design at all. The write-up defers it: conversion "will need to be based on
    // the agent's bulk collection total divided across their members". Until that
    // exists these members generate nothing and surface as a task; they are never
    // silently given zero entries while their money is banked.
    unresolvedGap(
      'GAP-19',
      'the entry model for agent-collected members — 782 of 1,591 (49% of the register) have no ' +
        'functional design. Their cash arrives as one bulk branch lodgement with no per-member ' +
        'breakdown in the bank, so there is no evidenced rule for how many entries each is due',
      'the client, and it should be scoped before the schema is frozen',
    );
  }

  if (!cfg.strategy || !cfg.confirmedBy) {
    unresolvedGap(
      'GAP-17',
      'the entry generation mechanism — balance ledger, fixed schedule, or prepaid blocks. ' +
        'All three are implemented; none may be selected by default because each gives a ' +
        'different member a different number of entries for the same money',
      'the client',
    );
  }

  const due = computeByStrategy(state, cfg, cfg.strategy);
  return applyPerPersonCap(due, cfg);
}

function computeByStrategy(
  state: MemberEntryState,
  cfg: EntryGenerationConfig,
  strategy: EntryStrategyName,
): EntriesDue {
  const price = cfg.ticketPricePence;
  switch (strategy) {
    case 'balance_ledger': {
      // "No payment, no entry" becomes automatic, and each member gets a
      // defensible statement. Residual pence accumulate toward the next entry.
      const count = Number(state.balancePence / price);
      const costPence = (BigInt(count) * price) as Pence;
      return { count, costPence, balanceAfterPence: (state.balancePence - costPence) as Pence };
    }
    case 'prepaid_blocks': {
      // Each payment bought whole tickets up front; the draw consumes them.
      const count = state.prepaidEntriesRemaining > 0 ? 1 : 0;
      return { count, costPence: ZERO, balanceAfterPence: state.balancePence };
    }
    case 'fixed_schedule': {
      // Entries are generated on a pre-computed schedule regardless of whether
      // this period's payment has arrived — a credit model, per GAP-18.
      const count = state.scheduledEntriesPerDraw;
      const costPence = (BigInt(count) * price) as Pence;
      return { count, costPence, balanceAfterPence: (state.balancePence - costPence) as Pence };
    }
  }
}

/**
 * GAP-26: a syndicate buying all 4,845 combinations becomes profitable once the
 * rollover exceeds roughly £3,876, and the modelled average jackpot is ~£5,053 —
 * so the exposure is live from day one. A per-person cap closes it entirely, and
 * no value has ever been set.
 *
 * This does not halt: an unset cap is the status quo, not a wrong answer. It is
 * reported so the compliance monitor can raise it rather than silently allowing
 * an unbounded position.
 */
function applyPerPersonCap(due: EntriesDue, cfg: EntryGenerationConfig): EntriesDue {
  const cap = cfg.perPersonEntryCap;
  if (cap === undefined || due.count <= cap) return due;
  const count = cap;
  const costPence = (BigInt(count) * cfg.ticketPricePence) as Pence;
  return { count, costPence, balanceAfterPence: due.balanceAfterPence };
}

/**
 * FR-4.2: convert a legacy standing order to a weekly ticket density.
 *   annual £ basis ÷ £2 ÷ 52
 * e.g. £104.16/yr → 1.042 tickets/wk; £52.08/yr → 0.521.
 *
 * Returned as whole entries per year plus a residual (FR-4.3): £104.16 → 52
 * entries + £4.16 spare. Deliberately NOT rounded to a per-draw integer — which
 * of those is owed in a given week is exactly GAP-17.
 */
export function convertAnnualBasis(
  annualBasisPence: Pence,
  ticketPricePence: Pence,
): { entriesPerYear: number; residualPence: Pence; densityPerWeek: number } {
  const entriesPerYear = Number(annualBasisPence / ticketPricePence);
  const residualPence = (annualBasisPence % ticketPricePence) as Pence;
  return { entriesPerYear, residualPence, densityPerWeek: entriesPerYear / 52 };
}
