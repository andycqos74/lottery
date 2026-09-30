import { describe, expect, it } from 'vitest';
import { MAX_DRAWS_PER_SCHEDULE, planOneOffDraw, planRecurringDraws, recurringDates, shiftLocalDateTime } from './draw-schedule.js';

describe('recurringDates (#4)', () => {
  it('steps weekly, inclusive of both ends', () => {
    expect(recurringDates('2026-10-02', '2026-10-23', 'weekly')).toEqual(['2026-10-02', '2026-10-09', '2026-10-16', '2026-10-23']);
  });

  it('steps fortnightly', () => {
    expect(recurringDates('2026-10-02', '2026-10-31', 'fortnightly')).toEqual(['2026-10-02', '2026-10-16', '2026-10-30']);
  });

  it('keeps the day of month, clamped to shorter months', () => {
    expect(recurringDates('2027-01-31', '2027-04-30', 'monthly')).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
  });

  it('crosses a year end', () => {
    expect(recurringDates('2026-12-25', '2027-01-08', 'weekly')).toEqual(['2026-12-25', '2027-01-01', '2027-01-08']);
  });

  it('is empty for an inverted or invalid range', () => {
    expect(recurringDates('2026-10-10', '2026-10-01', 'weekly')).toEqual([]);
    expect(recurringDates('2026-02-30', '2026-03-10', 'weekly')).toEqual([]);
  });
});

describe('shiftLocalDateTime', () => {
  it('moves back across midnight and month ends', () => {
    expect(shiftLocalDateTime('2026-10-02T12:00', -12)).toBe('2026-10-02T00:00');
    expect(shiftLocalDateTime('2026-11-01T08:00', -10)).toBe('2026-10-31T22:00');
  });
});

describe('planOneOffDraw (#4)', () => {
  it('accepts a cutoff at or before the draw', () => {
    const plan = planOneOffDraw({ drawNumber: 7, drawAtLocal: '2026-10-02T12:00', entriesCloseAtLocal: '2026-10-02T00:00' });
    expect(plan).toEqual({
      kind: 'ok',
      draws: [{ drawNumber: 7, drawAtLocal: '2026-10-02T12:00', entriesCloseAtLocal: '2026-10-02T00:00' }],
    });
  });

  it('rejects a cutoff after the draw', () => {
    const plan = planOneOffDraw({ drawNumber: 7, drawAtLocal: '2026-10-02T12:00', entriesCloseAtLocal: '2026-10-02T13:00' });
    expect(plan.kind).toBe('rejected');
  });

  it('rejects a missing draw time rather than defaulting to today', () => {
    expect(planOneOffDraw({ drawNumber: 7, drawAtLocal: '', entriesCloseAtLocal: '2026-10-02T00:00' }).kind).toBe('rejected');
  });
});

describe('planRecurringDraws (#4)', () => {
  const base = {
    firstDrawNumber: 40,
    startDate: '2026-10-02',
    endDate: '2026-10-16',
    recurrence: 'weekly' as const,
    drawTimeLocal: '12:00',
    cutoffHoursBefore: 10,
  };

  it('numbers draws consecutively and applies the cutoff offset to each', () => {
    const plan = planRecurringDraws(base);
    expect(plan).toEqual({
      kind: 'ok',
      draws: [
        { drawNumber: 40, drawAtLocal: '2026-10-02T12:00', entriesCloseAtLocal: '2026-10-02T02:00' },
        { drawNumber: 41, drawAtLocal: '2026-10-09T12:00', entriesCloseAtLocal: '2026-10-09T02:00' },
        { drawNumber: 42, drawAtLocal: '2026-10-16T12:00', entriesCloseAtLocal: '2026-10-16T02:00' },
      ],
    });
  });

  it('refuses a range producing too many draws', () => {
    const plan = planRecurringDraws({ ...base, endDate: '2030-01-01' });
    expect(plan.kind).toBe('rejected');
    expect(plan.kind === 'rejected' && plan.reason).toContain(String(MAX_DRAWS_PER_SCHEDULE));
  });

  it('refuses a negative cutoff', () => {
    expect(planRecurringDraws({ ...base, cutoffHoursBefore: -1 }).kind).toBe('rejected');
  });
});
