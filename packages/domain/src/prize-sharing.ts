/**
 * Splitting a won jackpot — FR-5.7 / T-2.4.
 *
 * Two unresolved decisions sit here, and T-2.4 requires this to "fail loudly
 * rather than default". Both are one-line changes once answered; neither may be
 * guessed, because both change what a real winner is actually paid.
 */
import { type Pence, ZERO, pence, sumPence } from './money.js';
import { unresolvedGap } from './gaps.js';

/**
 * GAP-22: is the jackpot shared per WINNER or per WINNING ENTRY?
 *
 * D5 says "shared equally between all entrants matching all 4", which is ambiguous
 * when a member holds the winning selection on two entries. Two shares or one?
 * The functional spec's unconfirmed suggestion is per winning entry, since each
 * entry paid its own £2 — but a member holding 5 tickets (prize draw no 22 does)
 * taking 5/6 of a jackpot is exactly the kind of outcome that generates complaints,
 * so it is a published game rule, not an implementation detail.
 */
export type ShareBasis = 'per_winning_entry' | 'per_winner';

/**
 * GAP-23: how is the remainder of an indivisible jackpot handled?
 *
 * £5,000 across 3 winners leaves 2p. Candidates: largest-remainder to winners,
 * carry to rollover, or donate to the good cause. It needs an auditable rule
 * because the ledger must balance to the penny either way (T-12.1).
 */
export type RemainderRule = 'largest_remainder_to_winners' | 'to_rollover' | 'to_good_cause';

export interface SharePolicy {
  readonly basis: ShareBasis;
  readonly remainder: RemainderRule;
  /** Who signed these off and when. Absent means the policy is not in force. */
  readonly confirmedBy?: string;
}

export interface WinningEntry {
  readonly entryId: string;
  readonly memberId: string;
}

export interface PrizeShare {
  readonly entryId: string;
  readonly memberId: string;
  readonly amountPence: Pence;
}

export interface SharedJackpot {
  readonly shares: readonly PrizeShare[];
  /** Pennies not paid to winners, destined for rollover or good cause per the rule. */
  readonly remainderPence: Pence;
  readonly remainderDestination: 'winners' | 'rollover' | 'good_cause';
}

/**
 * Divide a won jackpot among winning entries.
 *
 * Refuses to run without a confirmed policy. This is the single injected policy
 * function T-2.4 requires — there is no code path that shares a jackpot without
 * an explicit, recorded decision behind it.
 */
export function shareJackpot(
  jackpotPaidPence: Pence,
  winningEntries: readonly WinningEntry[],
  policy: SharePolicy | undefined,
): SharedJackpot {
  if (winningEntries.length === 0) {
    throw new RangeError('shareJackpot called with no winning entries; use settleOutcome instead.');
  }
  if (!policy?.confirmedBy) {
    unresolvedGap(
      'GAP-22',
      'whether a shared jackpot divides per winning entry or per winner (GAP-22), and where the ' +
        'indivisible remainder goes (GAP-23). Both are published game rules affecting what a real ' +
        'winner is paid, and T-2.4 requires this function to fail rather than assume',
      'the client, before any draw can pay out',
    );
  }

  const groups = groupByBasis(winningEntries, policy.basis);
  const shareCount = BigInt(groups.length);
  const baseShare = (jackpotPaidPence / shareCount) as Pence;
  const remainder = (jackpotPaidPence % shareCount) as Pence;

  if (policy.remainder === 'largest_remainder_to_winners') {
    // Every share is equal here, so "largest remainder" degenerates to a stable,
    // auditable order: the first N groups by entry id take one extra penny each.
    const shares = groups.flatMap((group, index) =>
      distributeWithinGroup(group, index < Number(remainder) ? (baseShare + 1n) as Pence : baseShare),
    );
    return { shares, remainderPence: ZERO, remainderDestination: 'winners' };
  }

  const shares = groups.flatMap((group) => distributeWithinGroup(group, baseShare));
  return {
    shares,
    remainderPence: remainder,
    remainderDestination: policy.remainder === 'to_rollover' ? 'rollover' : 'good_cause',
  };
}

function groupByBasis(entries: readonly WinningEntry[], basis: ShareBasis): WinningEntry[][] {
  const ordered = [...entries].sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
  if (basis === 'per_winning_entry') return ordered.map((e) => [e]);

  // per_winner: one share per distinct member, however many entries they hold.
  const byMember = new Map<string, WinningEntry[]>();
  for (const e of ordered) {
    const existing = byMember.get(e.memberId);
    if (existing) existing.push(e);
    else byMember.set(e.memberId, [e]);
  }
  return [...byMember.keys()].sort().map((memberId) => byMember.get(memberId) ?? []);
}

/**
 * A per-winner share is recorded against that member's first winning entry, so
 * every prize row still traces to a specific £2 stake for the audit trail.
 */
function distributeWithinGroup(group: readonly WinningEntry[], amountPence: Pence): PrizeShare[] {
  const [primary, ...rest] = group;
  if (!primary) return [];
  return [
    { entryId: primary.entryId, memberId: primary.memberId, amountPence },
    ...rest.map((e) => ({ entryId: e.entryId, memberId: e.memberId, amountPence: pence(0) })),
  ];
}

/** T-12.1: the sum of prize amounts must equal jackpot_paid, to the penny. */
export function totalShared(result: SharedJackpot): Pence {
  return sumPence([...result.shares.map((s) => s.amountPence), result.remainderPence]);
}
