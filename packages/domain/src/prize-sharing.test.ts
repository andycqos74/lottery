import { describe, expect, it } from 'vitest';
import { pence } from './money.js';
import { shareJackpot, totalShared, type SharePolicy } from './prize-sharing.js';
import { UnresolvedGapError } from './gaps.js';

const winners = [
  { entryId: 'e1', memberId: 'm1' },
  { entryId: 'e2', memberId: 'm1' },
  { entryId: 'e3', memberId: 'm2' },
];

describe('T-2.4 / GAP-22 / GAP-23 — sharing refuses to default', () => {
  it('throws rather than assume a policy', () => {
    expect(() => shareJackpot(pence(500_000), winners, undefined)).toThrow(UnresolvedGapError);
  });

  it('throws when a policy exists but nobody has confirmed it', () => {
    const unconfirmed: SharePolicy = { basis: 'per_winning_entry', remainder: 'to_rollover' };
    expect(() => shareJackpot(pence(500_000), winners, unconfirmed)).toThrow(/GAP-22/);
  });
});

describe('once a policy IS confirmed', () => {
  it('per winning entry: three entries take a third each', () => {
    const policy: SharePolicy = {
      basis: 'per_winning_entry',
      remainder: 'largest_remainder_to_winners',
      confirmedBy: 'test-fixture',
    };
    const result = shareJackpot(pence(500_000), winners, policy);
    expect(result.shares.map((s) => s.amountPence)).toEqual([166_667n, 166_667n, 166_666n]);
    expect(totalShared(result)).toBe(500_000n);
  });

  it('per winner: m1 takes one share despite holding two winning entries', () => {
    const policy: SharePolicy = { basis: 'per_winner', remainder: 'to_rollover', confirmedBy: 'test-fixture' };
    const result = shareJackpot(pence(500_000), winners, policy);
    const byMember = new Map<string, bigint>();
    for (const s of result.shares) byMember.set(s.memberId, (byMember.get(s.memberId) ?? 0n) + s.amountPence);
    expect(byMember.get('m1')).toBe(250_000n);
    expect(byMember.get('m2')).toBe(250_000n);
  });

  it('T-12.1: shares plus remainder always equal jackpot_paid, to the penny', () => {
    for (const remainder of ['largest_remainder_to_winners', 'to_rollover', 'to_good_cause'] as const) {
      const policy: SharePolicy = { basis: 'per_winning_entry', remainder, confirmedBy: 'test-fixture' };
      const result = shareJackpot(pence(500_002), winners, policy);
      expect(totalShared(result)).toBe(500_002n);
    }
  });

  it('routes an indivisible remainder to the configured destination', () => {
    // GAP-23's own example: £5,000 across 3 winners leaves 2p.
    const policy: SharePolicy = { basis: 'per_winning_entry', remainder: 'to_good_cause', confirmedBy: 'test-fixture' };
    const result = shareJackpot(pence(500_000), winners, policy);
    expect(result.shares.map((s) => s.amountPence)).toEqual([166_666n, 166_666n, 166_666n]);
    expect(result.remainderPence).toBe(2n);
    expect(result.remainderDestination).toBe('good_cause');
  });
});
