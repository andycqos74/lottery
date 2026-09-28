/**
 * Creating draws (GitHub #4, #5): a one-off draw with an explicit draw time
 * and entry cutoff, or a recurring series between two dates.
 *
 * Pure date arithmetic only — every wall-clock value here is a naive
 * Europe/London local time ("YYYY-MM-DD", "HH:MM", "YYYY-MM-DDTHH:MM" as a
 * `datetime-local` input submits it). Conversion to an instant happens in
 * Postgres (`::timestamp AT TIME ZONE 'Europe/London'`), so BST/GMT is
 * handled by the tz database rather than re-implemented here.
 */

export type Recurrence = 'weekly' | 'fortnightly' | 'monthly';
export const RECURRENCES: readonly Recurrence[] = ['weekly', 'fortnightly', 'monthly'];

/** A generous ceiling — two years of weekly draws — against a typo'd end date creating thousands of rows. */
export const MAX_DRAWS_PER_SCHEDULE = 104;

export interface PlannedDraw {
  readonly drawNumber: number;
  /** Naive London local date-time, "YYYY-MM-DDTHH:MM". */
  readonly drawAtLocal: string;
  /** Naive London local date-time, "YYYY-MM-DDTHH:MM". */
  readonly entriesCloseAtLocal: string;
}

export type PlanOutcome = { readonly kind: 'ok'; readonly draws: readonly PlannedDraw[] } | { readonly kind: 'rejected'; readonly reason: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

function parseDate(value: string): Date | undefined {
  if (!DATE_RE.test(value)) return undefined;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? undefined : d;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Shift a naive local date-time by whole hours, treating it as UTC so no DST rule leaks in — the offset is "hours on the clock". */
export function shiftLocalDateTime(localDateTime: string, hours: number): string {
  const d = new Date(`${localDateTime}:00Z`);
  d.setUTCHours(d.getUTCHours() + hours);
  return d.toISOString().slice(0, 16);
}

export function isLocalDateTime(value: string): boolean {
  return DATETIME_RE.test(value) && parseDate(value.slice(0, 10)) !== undefined;
}

/**
 * The dates of a recurring series, inclusive of both ends. Monthly draws keep
 * the start date's day of month, clamped to the last day of shorter months
 * (a series starting on the 31st draws on 30 April, 28/29 February).
 */
export function recurringDates(startDate: string, endDate: string, recurrence: Recurrence): string[] {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (!start || !end || end < start) return [];

  const dates: string[] = [];
  for (let i = 0; dates.length <= MAX_DRAWS_PER_SCHEDULE; i++) {
    let next: Date;
    if (recurrence === 'monthly') {
      const year = start.getUTCFullYear();
      const month = start.getUTCMonth() + i;
      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      next = new Date(Date.UTC(year, month, Math.min(start.getUTCDate(), lastDay)));
    } else {
      next = new Date(start);
      next.setUTCDate(start.getUTCDate() + i * (recurrence === 'weekly' ? 7 : 14));
    }
    if (next > end) break;
    dates.push(formatDate(next));
  }
  return dates;
}

export function planOneOffDraw(input: { drawNumber: number; drawAtLocal: string; entriesCloseAtLocal: string }): PlanOutcome {
  if (!isLocalDateTime(input.drawAtLocal)) return { kind: 'rejected', reason: 'Enter the draw date and time.' };
  if (!isLocalDateTime(input.entriesCloseAtLocal)) return { kind: 'rejected', reason: 'Enter the date and time entries close.' };
  // Same-format strings compare chronologically.
  if (input.entriesCloseAtLocal > input.drawAtLocal) {
    return { kind: 'rejected', reason: 'Entries must close at or before the draw time.' };
  }
  return { kind: 'ok', draws: [{ drawNumber: input.drawNumber, drawAtLocal: input.drawAtLocal, entriesCloseAtLocal: input.entriesCloseAtLocal }] };
}

export function planRecurringDraws(input: {
  firstDrawNumber: number;
  startDate: string;
  endDate: string;
  recurrence: Recurrence;
  drawTimeLocal: string;
  cutoffHoursBefore: number;
}): PlanOutcome {
  if (!parseDate(input.startDate)) return { kind: 'rejected', reason: 'Enter a start date.' };
  if (!parseDate(input.endDate)) return { kind: 'rejected', reason: 'Enter an end date.' };
  if (input.endDate < input.startDate) return { kind: 'rejected', reason: 'The end date must be on or after the start date.' };
  if (!RECURRENCES.includes(input.recurrence)) return { kind: 'rejected', reason: 'Choose how often the draw recurs.' };
  if (!TIME_RE.test(input.drawTimeLocal)) return { kind: 'rejected', reason: 'Enter the draw time, e.g. 12:00.' };
  if (!Number.isInteger(input.cutoffHoursBefore) || input.cutoffHoursBefore < 0 || input.cutoffHoursBefore > 24 * 14) {
    return { kind: 'rejected', reason: 'Entry cutoff must be a whole number of hours before the draw (0 to 336).' };
  }

  const dates = recurringDates(input.startDate, input.endDate, input.recurrence);
  if (dates.length === 0) return { kind: 'rejected', reason: 'That date range contains no draws.' };
  if (dates.length > MAX_DRAWS_PER_SCHEDULE) {
    return { kind: 'rejected', reason: `That would create more than ${MAX_DRAWS_PER_SCHEDULE} draws — shorten the date range.` };
  }

  return {
    kind: 'ok',
    draws: dates.map((date, i) => {
      const drawAtLocal = `${date}T${input.drawTimeLocal}`;
      return {
        drawNumber: input.firstDrawNumber + i,
        drawAtLocal,
        entriesCloseAtLocal: shiftLocalDateTime(drawAtLocal, -input.cutoffHoursBefore),
      };
    }),
  };
}
