/**
 * Number selections.
 *
 * D3 / FR-3.1: a selection is 4 distinct integers from 1..20, order irrelevant,
 * stored sorted ascending. T-5.1: winning-number comparison uses the sorted
 * canonical form, never positional — a member who picked {3,9,14,20} and a draw
 * that produced [14,3,20,9] is a win.
 */
import { unresolvedGap } from './gaps.js';

export const NUMBERS_POOL_N = 20;
export const NUMBERS_PICK_K = 4;

/** C(20,4) = 4845. Derived, not hard-coded, so a rule change cannot desynchronise it. */
export const COMBINATIONS = combinations(NUMBERS_POOL_N, NUMBERS_PICK_K);

export function combinations(n: number, k: number): number {
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return Math.round(result);
}

/** Four distinct numbers, sorted ascending. The only valid in-memory form. */
export type Selection = readonly [number, number, number, number];

export class InvalidSelectionError extends Error {
  override readonly name = 'InvalidSelectionError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * Validate and canonicalise a selection.
 *
 * Used by the `change_selection` Workflow Update validator (T-5.2 / FR-3.3), which
 * is why it returns a typed error rather than a boolean: the member gets an
 * immediate, specific accept or reject, not a silent queued change.
 */
export function toSelection(input: readonly number[]): Selection {
  if (input.length !== NUMBERS_PICK_K) {
    throw new InvalidSelectionError(
      `A selection is ${NUMBERS_PICK_K} numbers; received ${input.length}.`,
    );
  }
  for (const n of input) {
    if (!Number.isInteger(n)) {
      throw new InvalidSelectionError(`Selections are whole numbers; received ${n}.`);
    }
    if (n < 1 || n > NUMBERS_POOL_N) {
      throw new InvalidSelectionError(`Numbers run 1 to ${NUMBERS_POOL_N}; received ${n}.`);
    }
  }
  const unique = new Set(input);
  if (unique.size !== NUMBERS_PICK_K) {
    throw new InvalidSelectionError('The four numbers must be different from each other.');
  }
  const sorted = [...input].sort((a, b) => a - b);
  return sorted as unknown as Selection;
}

/** Parse without throwing, for form handling. */
export function parseSelection(
  input: readonly number[],
): { ok: true; selection: Selection } | { ok: false; reason: string } {
  try {
    return { ok: true, selection: toSelection(input) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'Invalid selection.' };
  }
}

/**
 * Does a selection match the drawn numbers in full?
 *
 * D4: there is one prize tier. Matching 3 or fewer pays nothing (FR-6.2), so this
 * is deliberately a boolean and not a match-count — there is no lower tier for a
 * count to feed, and returning one would invite someone to invent one.
 */
export function isWinningSelection(selection: Selection, winningNumbers: Selection): boolean {
  return (
    selection[0] === winningNumbers[0] &&
    selection[1] === winningNumbers[1] &&
    selection[2] === winningNumbers[2] &&
    selection[3] === winningNumbers[3]
  );
}

export const formatSelection = (s: Selection): string => s.join(' · ');

/**
 * GAP-15: must a member holding multiple tickets carry DISTINCT selections?
 * Member_Conversion shows up to 5 tickets/week (prize draw no 22). Unresolved,
 * and it interacts with GAP-22 on how a shared jackpot is counted, so it cannot
 * be answered independently.
 */
export function assertMultiTicketSelectionsPermitted(selections: readonly Selection[]): void {
  if (selections.length <= 1) return;
  unresolvedGap(
    'GAP-15',
    'whether a member holding multiple tickets in one draw must use distinct selections ' +
      '(interacts with GAP-22: shares per winner vs per winning entry)',
    'the client',
  );
}
