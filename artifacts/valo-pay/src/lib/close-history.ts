import { queueDay } from './queue-filters';

type Close = { id: string; createdAt: string; data?: Record<string, any> };
export function validReportDay(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

/** Compare stored closing positions. These snapshots must never be summed as receipts. */
export function closeHistory<T extends Close>(closes: T[], from: string, to: string) {
  const error = (from && !validReportDay(from)) || (to && !validReportDay(to))
    ? 'Enter a real date in From date and To date.' : from && to && from > to ? 'The From date must be on or before the To date.' : '';
  const items = error ? [] : closes.filter(close => {
    const day = queueDay(close.createdAt);
    return day && (!from || day >= from) && (!to || day <= to);
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const first = items.at(-1), latest = items[0];
  const metrics = [
    // The close list carries the naira value only; each close's details list money in another currency.
    { label: 'Unallocated payments at close (naira only)', money: true, read: (row: Close) => row.data?.report?.unallocated?.kobo },
    { label: 'Open exceptions at close', money: false, read: (row: Close) => row.data?.report?.exceptions?.openAtClose },
  ].map(({ read, ...metric }) => {
    const before = first ? read(first) : undefined, after = latest ? read(latest) : undefined;
    return { ...metric, before, after, change: items.length > 1 && typeof before === 'number' && Number.isFinite(before) && typeof after === 'number' && Number.isFinite(after) ? after - before : null };
  });
  return { items, first, latest, metrics, error };
}
