/**
 * Opening credit for legacy standing orders — switch-over decision D2 (c),
 * gap G1 in docs/SWITCHOVER_DRY_RUN.md.
 *
 * A legacy member whose standing order pays monthly, quarterly, six-monthly
 * or annually has, on the day of the switch-over, usually already paid for
 * some weeks the old lottery never drew. The new system only turns money
 * into entries when it reads it off a bank statement, and the statements it
 * reads start after the cut-off, so without this those weeks are lost and
 * the member has no entry until their next payment arrives.
 *
 * This reads the OLD lottery's bank statements (everything up to the
 * cut-off), works out for each prize draw number how much it paid and how
 * many of the old lottery's weekly draws that money already covered, and
 * says how many whole weeks are left over to carry into the new draws from
 * the first draw date.
 *
 * The calculation, per prize draw number, is a running balance in pence:
 *
 *   - every credit quoting the number adds its amount;
 *   - every old weekly draw (the cut-off's weekday, or `oldDrawWeekday`, up
 *     to and including the cut-off) uses one ticket price (£2) whenever the
 *     number is in credit at all — money arriving on the draw day counts
 *     for it. The old lottery entered a paying member every week, so a draw
 *     that takes the balance a few pence below zero is not skipped; the
 *     next payment makes it up. (Requiring a full £2 would skip a draw in
 *     every five-week month for a monthly £8.68 payer, and hand that week
 *     back as credit they never had.)
 *   - what is left at the cut-off, in whole ticket prices, is the opening
 *     credit; the pennies under £2 are the residual (FR-4.3) and are not
 *     credited. A balance below zero (a member slightly behind) credits
 *     nothing and is not carried as a debt.
 *
 * So nobody is credited more weeks than they paid for, less the old draws
 * those payments covered — the risk D2 (b) carried. Weeks are weeks: if
 * there is a gap between the old lottery's last draw and the new Draw 1, the
 * weeks are not lost in it, they start at Draw 1.
 *
 * The statements need to reach back at least as far as the longest
 * frequency (a year, for annual payers): money paid before the first
 * statement line is invisible, and a number whose payment cycle reaches back
 * past the window is flagged.
 *
 * Pure: no I/O and no `Date` (workflow code imports this package), so dates
 * are ISO `yyyy-mm-dd` strings and day arithmetic.
 */
import { TICKET_PRICE_PENCE } from './allocation.js';
import type { LegacyFrequency } from './legacy-register.js';
import type { Pence } from './money.js';

/** One bank statement line, as the statement parsers produce it (amounts in pence, unsigned). */
export interface OpeningCreditStatementLine {
  /** Stable per row across overlapping exports — the same id `bank_transaction.external_id` uses. */
  readonly externalId: string;
  /** yyyy-mm-dd */
  readonly valueDate: string;
  readonly amountPence: Pence;
  readonly isCredit: boolean;
  /** 'Standing Order', 'Transfer', 'Giro', 'Branch', … */
  readonly typeRaw: string;
  readonly reference?: string | null;
  readonly description: string;
  readonly name?: string | null;
}

/** A prize draw number as loaded from the register. */
export interface OpeningCreditNumber {
  readonly prizeDrawNo: number;
  readonly memberId: string;
  /** Who it is, for the report only. */
  readonly memberName?: string;
  readonly memberStatus: string;
  /** The standing order the register recorded for this number, if any. */
  readonly standingOrder: { readonly amountPence: Pence; readonly frequency: LegacyFrequency } | null;
}

export interface OpeningCreditOptions {
  /**
   * yyyy-mm-dd: the old lottery's last draw. Credits dated after it belong to
   * the new lottery — they are imported on the Bank statements page, not
   * here — and are left out.
   */
  readonly cutoff: string;
  /** yyyy-mm-dd: the new lottery's Draw 1. Opening weeks are entered from it. */
  readonly firstDraw: string;
  /** 0 = Sunday … 6 = Saturday. The old lottery's draw day; defaults to the cut-off's weekday. */
  readonly oldDrawWeekday?: number;
  /**
   * Decisions for credits the reference does not settle, by `externalId`: a
   * prize draw number, or null for "not lottery money for a number — ignore".
   */
  readonly assignments?: ReadonlyMap<string, number | null>;
  readonly ticketPricePence?: Pence;
}

export type OpeningCreditFlag =
  /** Money arrived for it, but the register has no standing order on it. */
  | 'no_standing_order'
  /** The register has a standing order, but no payment for it is in the statements. */
  | 'no_payment_in_window'
  /** A payment differs from the register's standing order amount. */
  | 'amount_differs'
  /** The payment cycle reaches back before the first statement line, so an earlier payment may be missing. */
  | 'window_shorter_than_cycle'
  /** The member is not active in the register (lapsed or quarantined). */
  | 'member_not_active';

export interface OpeningCreditPayment {
  readonly externalId: string;
  readonly valueDate: string;
  readonly amountPence: Pence;
  /** How the credit was tied to this number. */
  readonly matchedBy: 'reference' | 'reference_and_amount' | 'assigned';
}

export interface OpeningCreditLine {
  readonly prizeDrawNo: number;
  readonly memberId: string;
  readonly memberName?: string;
  readonly memberStatus: string;
  readonly standingOrder: OpeningCreditNumber['standingOrder'];
  readonly payments: readonly OpeningCreditPayment[];
  readonly paidPence: Pence;
  /** Old weekly draws in the window that this number's money covered. */
  readonly oldDrawsCovered: number;
  /** Balance at the cut-off, pence. */
  readonly balancePence: Pence;
  /** Whole weeks already paid for and not yet drawn: the opening credit. */
  readonly weeks: number;
  /** balance − weeks × ticket price: under one ticket, not credited. */
  readonly residualPence: Pence;
  /** weeks × ticket price — what the opening-credit payment is worth. */
  readonly creditPence: Pence;
  readonly lastPaymentDate: string | null;
  /** The weekly new-draw dates the weeks cover, assuming one draw a week from Draw 1. Null when weeks = 0. */
  readonly coversFrom: string | null;
  readonly coversTo: string | null;
  readonly flags: readonly OpeningCreditFlag[];
}

export type OpeningCreditExceptionReason =
  /** No prize draw number in the reference or description. */
  | 'no_number_in_reference'
  /** Several prize draw numbers, and the amount does not single one out. */
  | 'several_numbers'
  /** Assigned to a number that is not a loaded member number. */
  | 'assigned_number_unknown';

export interface OpeningCreditException {
  readonly line: OpeningCreditStatementLine;
  readonly reason: OpeningCreditExceptionReason;
  readonly candidates: readonly number[];
}

export interface OpeningCreditPlan {
  readonly cutoff: string;
  readonly firstDraw: string;
  readonly oldDrawWeekday: number;
  /** First and last statement line dates read (credits and debits, before the cut-off). */
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
  /** The old weekly draw dates inside the window, oldest first. */
  readonly oldDraws: readonly string[];
  /** Every number with a payment or a standing order, by prize draw number. */
  readonly lines: readonly OpeningCreditLine[];
  /** Credits that need a person to say which number they belong to (or that they are not lottery money). */
  readonly exceptions: readonly OpeningCreditException[];
  /** Credits a person has already decided (`assignments`): carried into the exception report so the file round-trips. */
  readonly decided: readonly { readonly line: OpeningCreditStatementLine; readonly assigned: number | null }[];
  readonly ignored: {
    /** Credits after the cut-off: the new lottery's, imported on the Bank statements page. */
    readonly afterCutoff: number;
    readonly debits: number;
    /** 'Branch' credits — agents' bulk lodgements, not one member's standing order. */
    readonly agentLodgements: number;
    /** Lines repeated in overlapping statement files. */
    readonly duplicates: number;
    /** Credits a person assigned as "ignore". */
    readonly assignedIgnore: number;
  };
  readonly totals: {
    readonly numbersCredited: number;
    readonly weeks: number;
    readonly creditPence: Pence;
    readonly matchedCredits: number;
    readonly matchedPence: Pence;
  };
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Dates, without `Date`.

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** yyyy-mm-dd → days since 1970-01-01. */
export function isoToDays(iso: string): number {
  const m = ISO.exec(iso);
  if (!m) throw new RangeError(`Expected a yyyy-mm-dd date, got "${iso}".`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const yy = mo <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const days = era * 146_097 + doe - 719_468;
  if (daysToIso(days) !== iso) throw new RangeError(`"${iso}" is not a real date.`);
  return days;
}

/** Days since 1970-01-01 → yyyy-mm-dd. */
export function daysToIso(days: number): string {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const mo = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (mo <= 2 ? 1 : 0);
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 0 = Sunday … 6 = Saturday. 1970-01-01 was a Thursday. */
export const weekdayOf = (iso: string): number => (((isoToDays(iso) + 4) % 7) + 7) % 7;

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** How far back one payment's cycle reaches, in days — generous, so a short window is flagged rather than missed. */
const CYCLE_DAYS: Record<LegacyFrequency, number> = {
  weekly: 7,
  fortnightly: 14,
  monthly: 31,
  quarterly: 92,
  '6monthly': 183,
  annual: 365,
};

// ---------------------------------------------------------------------------
// Matching a credit to a number — the same reading as bank matching
// (packages/activities/src/reconcile/match-transactions.ts): every run of
// digits in the reference (or, with no reference, the description) that is a
// loaded member number is a candidate.

export function candidateNumbers(line: Pick<OpeningCreditStatementLine, 'reference' | 'description'>, known: ReadonlySet<number>): number[] {
  const text = line.reference && line.reference.trim() !== '' ? line.reference : line.description;
  const groups = text.match(/\d+/g) ?? [];
  return [...new Set(groups.map(Number))].filter((n) => known.has(n));
}

const isAgentLodgement = (typeRaw: string) => typeRaw.trim().toLowerCase() === 'branch';

// ---------------------------------------------------------------------------
// The plan

export function planOpeningCredit(
  statementLines: readonly OpeningCreditStatementLine[],
  numbers: readonly OpeningCreditNumber[],
  options: OpeningCreditOptions,
): OpeningCreditPlan {
  const price = options.ticketPricePence ?? TICKET_PRICE_PENCE;
  const cutoffDay = isoToDays(options.cutoff);
  const firstDrawDay = isoToDays(options.firstDraw);
  if (firstDrawDay <= cutoffDay) {
    throw new RangeError(`The first draw (${options.firstDraw}) must be after the cut-off (${options.cutoff}).`);
  }
  const oldDrawWeekday = options.oldDrawWeekday ?? weekdayOf(options.cutoff);
  if (!Number.isInteger(oldDrawWeekday) || oldDrawWeekday < 0 || oldDrawWeekday > 6) {
    throw new RangeError(`The old draw weekday must be 0 (Sunday) to 6 (Saturday), got ${oldDrawWeekday}.`);
  }

  const byNumber = new Map(numbers.map((n) => [n.prizeDrawNo, n]));
  const known = new Set(byNumber.keys());
  const assignments = options.assignments ?? new Map<string, number | null>();
  const warnings: string[] = [];
  const ignored = { afterCutoff: 0, debits: 0, agentLodgements: 0, duplicates: 0, assignedIgnore: 0 };

  // Overlapping exports repeat rows; the external id is the row's identity.
  const seen = new Set<string>();
  const inWindow: OpeningCreditStatementLine[] = [];
  for (const line of statementLines) {
    if (seen.has(line.externalId)) {
      ignored.duplicates++;
      continue;
    }
    seen.add(line.externalId);
    if (isoToDays(line.valueDate) > cutoffDay) {
      if (line.isCredit) ignored.afterCutoff++;
      continue;
    }
    inWindow.push(line);
  }

  const dates = inWindow.map((l) => l.valueDate).sort();
  const windowStart = dates[0] ?? null;
  const windowEnd = dates[dates.length - 1] ?? null;
  const windowStartDay = windowStart === null ? cutoffDay : isoToDays(windowStart);

  // The old lottery's weekly draws inside the window, up to the cut-off.
  const lastOldDraw = cutoffDay - ((((weekdayOf(options.cutoff) - oldDrawWeekday) % 7) + 7) % 7);
  const oldDrawDays: number[] = [];
  for (let d = lastOldDraw; d >= windowStartDay; d -= 7) oldDrawDays.unshift(d);

  // Tie each credit to a number, or set it aside for a person.
  const paymentsByNumber = new Map<number, OpeningCreditPayment[]>();
  const exceptions: OpeningCreditException[] = [];
  const credit = (prizeDrawNo: number, line: OpeningCreditStatementLine, matchedBy: OpeningCreditPayment['matchedBy']) => {
    const list = paymentsByNumber.get(prizeDrawNo) ?? [];
    list.push({ externalId: line.externalId, valueDate: line.valueDate, amountPence: line.amountPence, matchedBy });
    paymentsByNumber.set(prizeDrawNo, list);
  };

  const decided: { line: OpeningCreditStatementLine; assigned: number | null }[] = [];
  for (const line of inWindow) {
    if (!line.isCredit) {
      ignored.debits++;
      continue;
    }
    if (assignments.has(line.externalId)) {
      const assigned = assignments.get(line.externalId)!;
      decided.push({ line, assigned });
      if (assigned === null) ignored.assignedIgnore++;
      else if (!known.has(assigned)) exceptions.push({ line, reason: 'assigned_number_unknown', candidates: [assigned] });
      else credit(assigned, line, 'assigned');
      continue;
    }
    if (isAgentLodgement(line.typeRaw)) {
      ignored.agentLodgements++;
      continue;
    }
    const candidates = candidateNumbers(line, known);
    if (candidates.length === 1) {
      credit(candidates[0]!, line, 'reference');
      continue;
    }
    if (candidates.length > 1) {
      const byAmount = candidates.filter((n) => byNumber.get(n)!.standingOrder?.amountPence === line.amountPence);
      if (byAmount.length === 1) credit(byAmount[0]!, line, 'reference_and_amount');
      else exceptions.push({ line, reason: 'several_numbers', candidates });
      continue;
    }
    exceptions.push({ line, reason: 'no_number_in_reference', candidates: [] });
  }

  // Run each number's balance through the old draws.
  const lines: OpeningCreditLine[] = [];
  const involved = new Set<number>([
    ...paymentsByNumber.keys(),
    ...numbers.filter((n) => n.standingOrder !== null && n.memberStatus === 'active').map((n) => n.prizeDrawNo),
  ]);
  for (const prizeDrawNo of [...involved].sort((a, b) => a - b)) {
    const number = byNumber.get(prizeDrawNo)!;
    const payments = (paymentsByNumber.get(prizeDrawNo) ?? []).sort((a, b) => (a.valueDate < b.valueDate ? -1 : a.valueDate > b.valueDate ? 1 : 0));

    let balance = 0n;
    let covered = 0;
    let p = 0;
    for (const drawDay of oldDrawDays) {
      while (p < payments.length && isoToDays(payments[p]!.valueDate) <= drawDay) balance += payments[p++]!.amountPence;
      if (balance > 0n) {
        balance -= price;
        covered++;
      }
    }
    while (p < payments.length) balance += payments[p++]!.amountPence;

    const weeks = balance > 0n ? Number(balance / price) : 0;
    const creditPence = (BigInt(weeks) * price) as Pence;
    const paidPence = payments.reduce((sum, x) => sum + x.amountPence, 0n) as Pence;
    const so = number.standingOrder;

    const flags: OpeningCreditFlag[] = [];
    if (number.memberStatus !== 'active') flags.push('member_not_active');
    if (!so) flags.push('no_standing_order');
    if (so && payments.length === 0) flags.push('no_payment_in_window');
    if (so && payments.some((x) => x.amountPence !== so.amountPence)) flags.push('amount_differs');
    if (so && cutoffDay - CYCLE_DAYS[so.frequency] < windowStartDay) flags.push('window_shorter_than_cycle');

    lines.push({
      prizeDrawNo,
      memberId: number.memberId,
      ...(number.memberName !== undefined ? { memberName: number.memberName } : {}),
      memberStatus: number.memberStatus,
      standingOrder: so,
      payments,
      paidPence,
      oldDrawsCovered: covered,
      balancePence: balance as Pence,
      weeks,
      residualPence: (balance - creditPence) as Pence,
      creditPence,
      lastPaymentDate: payments.length > 0 ? payments[payments.length - 1]!.valueDate : null,
      coversFrom: weeks > 0 ? options.firstDraw : null,
      coversTo: weeks > 0 ? daysToIso(firstDrawDay + 7 * (weeks - 1)) : null,
      flags,
    });
  }

  if (windowStart === null) warnings.push('No statement lines on or before the cut-off were read.');
  else {
    const days = cutoffDay - windowStartDay;
    const annual = numbers.some((n) => n.standingOrder?.frequency === 'annual' && n.memberStatus === 'active');
    if (annual && days < 365) {
      warnings.push(
        `The statements cover ${days} days before the cut-off; annual standing orders need a full year (from ${daysToIso(cutoffDay - 365)}) ` +
          'or their last payment may be missing.',
      );
    }
  }
  if (oldDrawDays.length === 0 && windowStart !== null) warnings.push('No old-lottery draw falls inside the statement window.');
  if (exceptions.length > 0) {
    warnings.push(`${exceptions.length} credit(s) could not be tied to one prize draw number — assign them (or mark them "ignore") and run again.`);
  }

  const credited = lines.filter((l) => l.weeks > 0);
  const matched = lines.flatMap((l) => l.payments);
  return {
    cutoff: options.cutoff,
    firstDraw: options.firstDraw,
    oldDrawWeekday,
    windowStart,
    windowEnd,
    oldDraws: oldDrawDays.map(daysToIso),
    lines,
    exceptions,
    decided,
    ignored,
    totals: {
      numbersCredited: credited.length,
      weeks: credited.reduce((n, l) => n + l.weeks, 0),
      creditPence: credited.reduce((sum, l) => sum + l.creditPence, 0n) as Pence,
      matchedCredits: matched.length,
      matchedPence: matched.reduce((sum, x) => sum + x.amountPence, 0n) as Pence,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Reports — CSV, for a spreadsheet. They name members: keep them off the
// repository and off dev machines (B-2), like the register's own report.

const csvCell = (v: string | number | bigint | null | undefined): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRow = (cells: readonly (string | number | bigint | null | undefined)[]) => cells.map(csvCell).join(',');
const pounds = (p: bigint) => {
  const neg = p < 0n;
  const a = neg ? -p : p;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
};

/** One row per prize draw number: what it paid, what the old draws used, and the weeks carried into the new lottery. */
export function openingCreditReport(plan: OpeningCreditPlan): string {
  const header = [
    'prize_draw_no', 'member', 'member_status', 'register_amount', 'register_frequency', 'payments_in_window', 'paid_in_window',
    'last_payment_date', 'old_draws_covered', 'balance_at_cutoff', 'opening_weeks', 'credit', 'residual_not_credited',
    'covers_from', 'covers_to', 'flags',
  ];
  const rows = plan.lines.map((l) =>
    csvRow([
      l.prizeDrawNo, l.memberName, l.memberStatus, l.standingOrder ? pounds(l.standingOrder.amountPence) : '', l.standingOrder?.frequency,
      l.payments.length, pounds(l.paidPence), l.lastPaymentDate, l.oldDrawsCovered, pounds(l.balancePence), l.weeks, pounds(l.creditPence),
      pounds(l.residualPence), l.coversFrom, l.coversTo, l.flags.join(' '),
    ]),
  );
  return [csvRow(header), ...rows].join('\n') + '\n';
}

/**
 * The credits a person must decide. Fill in `assign` with the prize draw
 * number the money is for, or `ignore` if it is not a member's lottery
 * money, and pass the file back with --assign. Credits already decided
 * are listed after them with their decision, so the same file can be
 * edited and passed back again without losing anything.
 */
export function openingCreditExceptionReport(plan: OpeningCreditPlan): string {
  const header = ['external_id', 'value_date', 'amount', 'type', 'reference', 'description', 'reason', 'candidates', 'assign'];
  const open = new Set(plan.exceptions.map((e) => e.line.externalId));
  const rows = [
    ...plan.exceptions.map((e) =>
      csvRow([
        e.line.externalId, e.line.valueDate, pounds(e.line.amountPence), e.line.typeRaw, e.line.reference, e.line.description, e.reason,
        e.candidates.join(' '), '',
      ]),
    ),
    ...plan.decided
      .filter((d) => !open.has(d.line.externalId))
      .map((d) =>
        csvRow([
          d.line.externalId, d.line.valueDate, pounds(d.line.amountPence), d.line.typeRaw, d.line.reference, d.line.description, 'decided',
          '', d.assigned === null ? 'ignore' : d.assigned,
        ]),
      ),
  ];
  return [csvRow(header), ...rows].join('\n') + '\n';
}

/**
 * Reads a filled-in exception report (or any CSV with `external_id` and
 * `assign` columns): `assign` is a prize draw number, `ignore`, or blank
 * (still undecided — left out).
 */
export function readOpeningCreditAssignments(cells: readonly (readonly string[])[]): Map<string, number | null> {
  const [header, ...data] = cells;
  if (!header) return new Map();
  const at = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name);
  const idCol = at('external_id');
  const assignCol = at('assign');
  if (idCol < 0 || assignCol < 0) throw new Error('The assignments file needs "external_id" and "assign" columns.');
  const out = new Map<string, number | null>();
  data.forEach((row, i) => {
    const id = (row[idCol] ?? '').trim();
    const value = (row[assignCol] ?? '').trim();
    if (id === '' || value === '') return;
    if (value.toLowerCase() === 'ignore') out.set(id, null);
    else if (/^\d+$/.test(value)) out.set(id, Number(value));
    else throw new Error(`Assignments row ${i + 2}: "assign" must be a prize draw number or "ignore", got "${value}".`);
  });
  return out;
}
