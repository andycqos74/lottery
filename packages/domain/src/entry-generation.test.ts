import { describe, expect, it } from 'vitest';
import { pence } from './money.js';
import { convertAnnualBasis, entriesDue, type EntryGenerationConfig, type MemberEntryState } from './entry-generation.js';
import { TICKET_PRICE_PENCE } from './allocation.js';
import { UnresolvedGapError } from './gaps.js';

const member: MemberEntryState = {
  memberId: 'm1',
  balancePence: pence(1000),
  prepaidEntriesRemaining: 3,
  scheduledEntriesPerDraw: 1,
  isAgentCollected: false,
};

describe('GAP-17 — no strategy may be selected by default', () => {
  it('halts when no strategy is configured', () => {
    const cfg: EntryGenerationConfig = { strategy: undefined, ticketPricePence: TICKET_PRICE_PENCE };
    expect(() => entriesDue(member, cfg)).toThrow(UnresolvedGapError);
    expect(() => entriesDue(member, cfg)).toThrow(/GAP-17/);
  });

  it('halts when a strategy is named but unconfirmed — a suggested default is not a decision', () => {
    const cfg: EntryGenerationConfig = { strategy: 'balance_ledger', ticketPricePence: TICKET_PRICE_PENCE };
    expect(() => entriesDue(member, cfg)).toThrow(/GAP-17/);
  });
});

describe('GAP-19 — agent-collected members have no entry model at all', () => {
  it('halts for the 49% of the register behind an agent, whatever the strategy', () => {
    const cfg: EntryGenerationConfig = {
      strategy: 'balance_ledger',
      ticketPricePence: TICKET_PRICE_PENCE,
      confirmedBy: 'test-fixture',
    };
    expect(() => entriesDue({ ...member, isAgentCollected: true }, cfg)).toThrow(/GAP-19/);
  });
});

describe('the three strategies, once confirmed', () => {
  const confirmed = (strategy: EntryGenerationConfig['strategy']): EntryGenerationConfig => ({
    strategy,
    ticketPricePence: TICKET_PRICE_PENCE,
    confirmedBy: 'test-fixture',
  });

  it('balance ledger: £10 buys five entries and leaves nothing', () => {
    const due = entriesDue(member, confirmed('balance_ledger'));
    expect(due).toEqual({ count: 5, costPence: 1000n, balanceAfterPence: 0n });
  });

  it('balance ledger: a residual under £2 buys nothing and is carried', () => {
    const due = entriesDue({ ...member, balancePence: pence(150) }, confirmed('balance_ledger'));
    expect(due).toEqual({ count: 0, costPence: 0n, balanceAfterPence: 150n });
  });

  it('prepaid blocks: one entry consumed per draw while blocks remain', () => {
    expect(entriesDue(member, confirmed('prepaid_blocks')).count).toBe(1);
    expect(entriesDue({ ...member, prepaidEntriesRemaining: 0 }, confirmed('prepaid_blocks')).count).toBe(0);
  });

  it('fixed schedule: entries generate regardless of balance (a credit model — GAP-18)', () => {
    const due = entriesDue({ ...member, balancePence: pence(0) }, confirmed('fixed_schedule'));
    expect(due.count).toBe(1);
    expect(due.balanceAfterPence).toBe(-200n); // member now owes; GAP-18 decides if this is allowed
  });

  it('GAP-26: a per-person cap, when set, bounds the syndicate exposure', () => {
    const capped = { ...confirmed('balance_ledger'), perPersonEntryCap: 2 };
    expect(entriesDue(member, capped).count).toBe(2);
  });
});

describe('FR-4.2 / FR-4.3 — legacy standing order conversion', () => {
  it('£104.16/yr becomes 52 entries plus £4.16 spare, density 1.0 per week', () => {
    const result = convertAnnualBasis(pence(10_416), TICKET_PRICE_PENCE);
    expect(result.entriesPerYear).toBe(52);
    expect(result.residualPence).toBe(16n);
    expect(result.densityPerWeek).toBeCloseTo(1.0, 3);
  });

  it('£52.08/yr becomes a density of ~0.5 per week', () => {
    const result = convertAnnualBasis(pence(5208), TICKET_PRICE_PENCE);
    expect(result.entriesPerYear).toBe(26);
    expect(result.densityPerWeek).toBeCloseTo(0.5, 3);
  });
});
