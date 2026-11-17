import { describe, expect, it } from 'vitest';
import { parseDelimited } from './legacy-register.js';
import { pence, type Pence } from './money.js';
import {
  candidateNumbers,
  daysToIso,
  isoToDays,
  openingCreditExceptionReport,
  openingCreditReport,
  planOpeningCredit,
  readOpeningCreditAssignments,
  weekdayOf,
  type OpeningCreditNumber,
  type OpeningCreditStatementLine,
} from './opening-credit.js';

// Synthetic — B-2 keeps real member data out of the repository.
// Old lottery: Saturday draws, last one 2026-11-21. New Draw 1: Friday 2026-11-27.
const CUTOFF = '2026-11-21';
const FIRST_DRAW = '2026-11-27';

let nextId = 1;
const credit = (valueDate: string, amount: number, reference: string, over: Partial<OpeningCreditStatementLine> = {}): OpeningCreditStatementLine => ({
  externalId: `t${nextId++}`,
  valueDate,
  amountPence: pence(amount),
  isCredit: true,
  typeRaw: 'Standing Order',
  reference,
  description: `STANDING ORDER ${reference}`,
  ...over,
});
const so = (amount: number, frequency: NonNullable<OpeningCreditNumber['standingOrder']>['frequency']) => ({ amountPence: pence(amount) as Pence, frequency });
const num = (prizeDrawNo: number, standingOrder: OpeningCreditNumber['standingOrder'], memberStatus = 'active'): OpeningCreditNumber => ({
  prizeDrawNo,
  memberId: `member-${prizeDrawNo}`,
  memberStatus,
  standingOrder,
});
const plan = (lines: OpeningCreditStatementLine[], numbers: OpeningCreditNumber[], over: Partial<Parameters<typeof planOpeningCredit>[2]> = {}) =>
  planOpeningCredit(lines, numbers, { cutoff: CUTOFF, firstDraw: FIRST_DRAW, ...over });
const line = (p: ReturnType<typeof plan>, n: number) => p.lines.find((l) => l.prizeDrawNo === n)!;

describe('dates without Date', () => {
  it('round-trips days and knows the weekday', () => {
    expect(isoToDays('1970-01-01')).toBe(0);
    expect(daysToIso(isoToDays('2024-02-29'))).toBe('2024-02-29');
    expect(weekdayOf('1970-01-01')).toBe(4); // Thursday
    expect(weekdayOf(CUTOFF)).toBe(6); // Saturday
    expect(weekdayOf(FIRST_DRAW)).toBe(5); // Friday
  });

  it('rejects dates that are not dates', () => {
    expect(() => isoToDays('2026-02-30')).toThrow(/not a real date/);
    expect(() => isoToDays('21/11/2026')).toThrow(/yyyy-mm-dd/);
  });
});

describe('weeks already paid for at the cut-off', () => {
  it('monthly £8.68 paid on the 1st: November is paid, so one week is left for Draw 1', () => {
    const lines = Array.from({ length: 12 }, (_, i) => {
      const [y, m] = i === 0 ? [2025, 12] : [2026, i];
      return credit(`${y}-${String(m).padStart(2, '0')}-01`, 868, '1002');
    });
    const p = plan(lines, [num(1002, so(868, 'monthly'))]);
    expect(p.oldDraws).toHaveLength(51); // Saturdays 2025-12-06 … 2026-11-21
    expect(line(p, 1002)).toMatchObject({
      paidPence: 10416n,
      oldDrawsCovered: 51, // every week, including the fifth Saturdays
      weeks: 1,
      creditPence: 200n,
      residualPence: 16n,
      coversFrom: '2026-11-27',
      coversTo: '2026-11-27',
      lastPaymentDate: '2026-11-01',
      flags: [],
    });
  });

  it('quarterly £26 paid 1 October: 13 weeks, 8 drawn by the old lottery, 5 carried into the new draws', () => {
    const p = plan([credit('2026-10-01', 2600, 'PRIZE DRAW 1003')], [num(1003, so(2600, 'quarterly'))]);
    expect(line(p, 1003)).toMatchObject({ oldDrawsCovered: 8, weeks: 5, creditPence: 1000n, coversFrom: '2026-11-27', coversTo: '2026-12-25' });
  });

  it('annual £104 paid in March: 36 old draws used, 16 weeks carried', () => {
    const p = plan([credit('2025-11-21', 500, 'other'), credit('2026-03-15', 10400, '1004')], [num(1004, so(10400, 'annual'))]);
    expect(line(p, 1004)).toMatchObject({ oldDrawsCovered: 36, weeks: 16, flags: [] });
  });

  it('money arriving on a draw day counts for that draw', () => {
    const p = plan([credit('2026-11-21', 200, '1005')], [num(1005, so(200, 'weekly'))]);
    expect(line(p, 1005)).toMatchObject({ oldDrawsCovered: 1, weeks: 0 });
  });

  it('a payment after the last old draw but on or before the cut-off is all credit', () => {
    const p = plan([credit('2026-11-01', 0, 'x'), credit('2026-11-22', 868, '1006')], [num(1006, so(868, 'monthly'))], { cutoff: '2026-11-23', oldDrawWeekday: 6 });
    expect(line(p, 1006)).toMatchObject({ oldDrawsCovered: 0, weeks: 4, residualPence: 68n });
  });

  it('a number that stopped paying has nothing left, and is not carried as a debt', () => {
    const p = plan([credit('2026-06-01', 868, '1007')], [num(1007, so(868, 'monthly'))]);
    expect(line(p, 1007)).toMatchObject({ oldDrawsCovered: 5, weeks: 0, creditPence: 0n, coversFrom: null });
    expect(line(p, 1007).balancePence).toBeLessThan(0n);
  });

  it('the old draw day can be given when the cut-off is not a draw day', () => {
    // Cut-off Sunday 22 Nov, draws on Saturdays: the last old draw is still 21 Nov.
    const p = plan([credit('2026-10-01', 2600, '1003')], [num(1003, so(2600, 'quarterly'))], { cutoff: '2026-11-22', oldDrawWeekday: 6 });
    expect(p.oldDraws.at(-1)).toBe('2026-11-21');
    expect(line(p, 1003).weeks).toBe(5);
  });

  it('refuses a first draw that is not after the cut-off', () => {
    expect(() => plan([], [], { firstDraw: CUTOFF })).toThrow(/must be after the cut-off/);
  });
});

describe('which lines count', () => {
  it('leaves out the new lottery’s credits, debits, agent lodgements and repeated rows', () => {
    const dup = credit('2026-11-01', 868, '1002');
    const p = plan(
      [
        dup,
        { ...dup },
        credit('2026-11-24', 868, '1002'),
        credit('2026-11-02', 5000, '', { typeRaw: 'Branch', description: 'AGENT LODGEMENT' }),
        credit('2026-11-03', 1200, '1002', { isCredit: false }),
      ],
      [num(1002, so(868, 'monthly'))],
    );
    expect(p.ignored).toEqual({ afterCutoff: 1, debits: 1, agentLodgements: 1, duplicates: 1, assignedIgnore: 0 });
    expect(line(p, 1002).payments).toHaveLength(1);
    expect(p.windowEnd).toBe('2026-11-03');
  });

  it('reads the number from the description when there is no reference, like bank matching does', () => {
    expect(candidateNumbers({ reference: null, description: 'FPS, J Smith, 1002' }, new Set([1002]))).toEqual([1002]);
    expect(candidateNumbers({ reference: '1643 DD1113 B KIRK', description: '' }, new Set([1643, 1113, 9]))).toEqual([1643, 1113]);
  });

  it('lets the amount pick between two numbers in one reference, and asks a person otherwise', () => {
    const numbers = [num(1643, so(868, 'monthly')), num(1113, so(2600, 'quarterly'))];
    const picked = credit('2026-11-01', 868, '1643 DD1113');
    const unclear = credit('2026-11-02', 500, '1643 DD1113');
    const none = credit('2026-11-03', 868, 'J SMITH');
    const p = plan([picked, unclear, none], numbers);
    expect(line(p, 1643).payments).toEqual([expect.objectContaining({ externalId: picked.externalId, matchedBy: 'reference_and_amount' })]);
    expect(p.exceptions.map((e) => [e.line.externalId, e.reason, e.candidates])).toEqual([
      [unclear.externalId, 'several_numbers', [1643, 1113]],
      [none.externalId, 'no_number_in_reference', []],
    ]);
    expect(p.warnings.join(' ')).toMatch(/2 credit\(s\) could not be tied/);

    // A person decides: the unclear one is 1113's; the unreferenced one is not lottery money.
    const decided = plan([picked, unclear, none], numbers, {
      assignments: new Map<string, number | null>([[unclear.externalId, 1113], [none.externalId, null]]),
    });
    expect(decided.exceptions).toEqual([]);
    expect(decided.ignored.assignedIgnore).toBe(1);
    expect(line(decided, 1113).payments).toEqual([expect.objectContaining({ matchedBy: 'assigned', amountPence: 500n })]);
  });

  it('keeps an assignment to an unknown number as an exception rather than guessing', () => {
    const c = credit('2026-11-01', 868, '1002');
    const p = plan([c], [num(1002, so(868, 'monthly'))], { assignments: new Map([[c.externalId, 4444]]) });
    expect(p.exceptions).toEqual([expect.objectContaining({ reason: 'assigned_number_unknown', candidates: [4444] })]);
  });
});

describe('flags for a person to look at', () => {
  it('flags standing orders with no payment, payments with no standing order, odd amounts, short windows and lapsed members', () => {
    const p = plan(
      [credit('2026-11-01', 900, '1002'), credit('2026-11-02', 868, '1009'), credit('2026-11-03', 868, '1010')],
      [num(1002, so(868, 'monthly')), num(1008, so(10400, 'annual')), num(1009, null), num(1010, so(868, 'monthly'), 'lapsed'), num(1011, so(868, 'monthly'), 'lapsed')],
    );
    expect(line(p, 1002).flags).toEqual(['amount_differs', 'window_shorter_than_cycle']);
    expect(line(p, 1008).flags).toEqual(['no_payment_in_window', 'window_shorter_than_cycle']);
    expect(line(p, 1009).flags).toEqual(['no_standing_order']);
    expect(line(p, 1010).flags).toContain('member_not_active');
    expect(p.lines.some((l) => l.prizeDrawNo === 1011)).toBe(false); // lapsed and paid nothing: not listed
    expect(p.warnings.join(' ')).toMatch(/annual standing orders need a full year \(from 2025-11-21\)/);
  });
});

describe('reports', () => {
  it('writes the per-number report and an exception report that reads back as assignments', () => {
    const odd = credit('2026-11-02', 500, 'MR "JOHN", SMITH');
    const p = plan([credit('2026-10-01', 2600, '1003'), odd], [num(1003, so(2600, 'quarterly'))]);
    expect(p.totals).toEqual({ numbersCredited: 1, weeks: 5, creditPence: 1000n, matchedCredits: 1, matchedPence: 2600n });

    const report = parseDelimited(openingCreditReport(p));
    expect(report[0]).toContain('opening_weeks');
    expect(report[1]!.slice(0, 1)).toEqual(['1003']);
    expect(report[1]![report[0]!.indexOf('opening_weeks')]).toBe('5');
    expect(report[1]![report[0]!.indexOf('credit')]).toBe('10.00');

    const exceptions = parseDelimited(openingCreditExceptionReport(p));
    expect(exceptions[1]![exceptions[0]!.indexOf('reference')]).toBe('MR "JOHN", SMITH');
    // The treasurer fills in "assign" and passes the file back.
    exceptions[1]![exceptions[0]!.indexOf('assign')] = 'ignore';
    expect(readOpeningCreditAssignments(exceptions)).toEqual(new Map([[odd.externalId, null]]));
    expect(() => readOpeningCreditAssignments([['external_id', 'assign'], ['t1', 'maybe']])).toThrow(/prize draw number or "ignore"/);

    // Run again with that file: the decision is carried in the new report, so the file can be passed back again.
    const again = plan([credit('2026-10-01', 2600, '1003'), odd], [num(1003, so(2600, 'quarterly'))], {
      assignments: readOpeningCreditAssignments(exceptions),
    });
    expect(again.exceptions).toEqual([]);
    const carried = parseDelimited(openingCreditExceptionReport(again));
    expect(readOpeningCreditAssignments(carried)).toEqual(new Map([[odd.externalId, null]]));
  });
});
