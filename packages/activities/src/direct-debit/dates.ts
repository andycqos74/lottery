/**
 * Direct Debit calendar (client decision, 2026-10-07: monthly, in advance).
 *
 * Dates are UK calendar dates as 'YYYY-MM-DD'. Working days skip weekends
 * only: bank holidays come from the bureau's processing calendar, which is
 * part of the still-open GAP-10 — until then a collection that lands on a
 * bank holiday simply settles on the bank's next working day.
 */

/** Money is collected on the 1st of the month (or the next working day) for that month's draws. */
export const COLLECTION_DAY_OF_MONTH = 1;
/** The month's collections are worked out, and members told, this many days before the collection date… */
export const PREPARE_DAYS_BEFORE = 14;
/** …and no later than this: the Direct Debit Guarantee's advance notice (10 days unless agreed otherwise). */
export const ADVANCE_NOTICE_DAYS = 10;
/** Bacs needs the instruction this many working days before the money moves. */
export const SUBMIT_WORKING_DAYS_BEFORE = 2;
/** A failed first collection is tried again this long after the failure is reported. */
export const RETRY_AFTER_DAYS = 7;

const toDate = (iso: string) => new Date(`${iso}T12:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

export function isWorkingDay(iso: string): boolean {
  const day = toDate(iso).getUTCDay();
  return day !== 0 && day !== 6;
}

/** The date itself if it is a working day, otherwise the next one. */
export function onOrNextWorkingDay(iso: string): string {
  let d = iso;
  while (!isWorkingDay(d)) d = addDays(d, 1);
  return d;
}

export function workingDaysBefore(iso: string, n: number): string {
  let d = iso;
  for (let left = n; left > 0; ) {
    d = addDays(d, -1);
    if (isWorkingDay(d)) left--;
  }
  return d;
}

export function firstOfNextMonth(iso: string): string {
  const d = toDate(iso);
  return toIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 12)));
}

export function collectionDateFor(month: string): string {
  return onOrNextWorkingDay(`${month.slice(0, 8)}${String(COLLECTION_DAY_OF_MONTH).padStart(2, '0')}`);
}

/** Today's date in the UK. */
export function ukToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** "Monday 2 November 2026" — for notices. */
export function formatUkDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(toDate(iso)).replace(',', '');
}
