import { describe, expect, it } from 'vitest';
import { deadlineOrder, isDueToday, isOverdue, queueDay } from '@/lib/queue-filters';

describe('queue deadlines in West Africa Time', () => {
  it('keeps a date-only instalment due all day, and uses Lagos midnight for today', () => {
    const beforeMidnight = Date.parse('2026-09-18T22:59:59Z');
    const midnight = Date.parse('2026-09-18T23:00:00Z');
    expect(queueDay(midnight)).toBe('2026-09-19');
    expect(isDueToday('2026-09-18', beforeMidnight)).toBe(true);
    expect(isOverdue('2026-09-18', beforeMidnight)).toBe(false);
    expect(isOverdue('2026-09-18', midnight)).toBe(true);
    expect(isDueToday('2026-09-19', midnight)).toBe(true);
  });

  it('uses the actual instant for timed exception and activation deadlines', () => {
    const deadline = '2026-09-18T09:30:00Z';
    expect(isOverdue(deadline, Date.parse(deadline))).toBe(false);
    expect(isOverdue(deadline, Date.parse(deadline) + 1)).toBe(true);
    expect(isDueToday(deadline, Date.parse('2026-09-18T23:00:00Z'))).toBe(false);
    expect(isOverdue('not a date')).toBe(false);
    expect(isDueToday(undefined)).toBe(false);
    expect(deadlineOrder(undefined, deadline)).toBeGreaterThan(0);
    expect(deadlineOrder(undefined, undefined)).toBe(0);
  });

  it('keeps a day-only exception or activation deadline due all day, as the API does (23 September audit)', () => {
    // An imported deadline without a time used to be overdue from 01:00 WAT on its own date.
    const sameDay = Date.parse('2026-09-18T10:00:00Z'), lastInstant = Date.parse('2026-09-18T22:59:59.999Z');
    expect(isOverdue('2026-09-18', sameDay)).toBe(false);
    expect(isOverdue('2026-09-18', lastInstant)).toBe(false);
    expect(isOverdue('2026-09-18', lastInstant + 1)).toBe(true);
    expect(isDueToday('2026-09-18', sameDay)).toBe(true);
    // An impossible date is no deadline, as the API reads it, rather than a text comparison.
    expect(isOverdue('2026-02-30', Date.parse('2027-01-01T00:00:00Z'))).toBe(false);
  });
});
