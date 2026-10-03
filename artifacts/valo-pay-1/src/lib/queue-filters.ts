import { useSearchParams } from 'wouter';
import { deadlinePassed } from '@workspace/valo-pay-1-schema';
import { TIME_ZONE } from './formatters';

const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Queue dates use the same lender timezone as the date displayed beside them. */
export function queueDay(value: string | number | Date): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = dayFormatter.formatToParts(date);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-');
}

/**
 * Whether a deadline has passed, as the API reads every deadline (an
 * instalment's due date, an exception's dueBy, a mandate's activation
 * deadline): a day-only deadline lasts the whole day in West Africa Time, a
 * timed one expires at its stated instant, and an impossible date is none.
 */
export function isOverdue(value: unknown, now = Date.now()): boolean {
  return deadlinePassed(value, now);
}

export function isDueToday(value: unknown, now = Date.now()): boolean {
  const deadline = String(value || '');
  return !!deadline && queueDay(deadline) === queueDay(now);
}

export function deadlineOrder(left: unknown, right: unknown): number {
  const date = (value: unknown) => { const time = Date.parse(String(value || '')); return Number.isFinite(time) ? time : Infinity; };
  const a = date(left), b = date(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Filters survive a copied URL, browser navigation and a visit from the overview. */
export function useQueueFilters<T extends string>(views: readonly T[], fallback: T) {
  const [search, setSearch] = useSearchParams();
  const candidate = search.get('view') as T;
  const view = views.includes(candidate) ? candidate : fallback;
  const owner = search.get('owner') || '';
  const setFilter = (key: 'view' | 'owner' | 'type', value: string) => setSearch(current => {
    const next = new URLSearchParams(current);
    next.delete('page');
    if (!value || (key === 'view' && value === fallback)) next.delete(key);
    else next.set(key, value);
    return next;
  });
  return { view, owner, type: search.get('type') || '', setView: (value: T) => setFilter('view', value), setOwner: (value: string) => setFilter('owner', value), setType: (value: string) => setFilter('type', value) };
}
