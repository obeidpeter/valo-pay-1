import { deadlineEnds, WAT_OFFSET_MS } from '@workspace/valopay-schema';
import { foldForSearch } from './valopay-list';
import type { ValopayRecord } from '../domain/types';

export const queueViews = {
  exceptions: ['open', 'high', 'overdue', 'due-today', 'resolved'],
  mandates: ['all', 'awaiting-activation', 'overdue', 'due-today'],
  collections: ['all', 'overdue', 'due-today', 'failed'],
} as const;
export type QueueName = keyof typeof queueViews;
export interface QueueQuery { q?: string; view?: string; owner?: string; type?: string; limit?: number; offset?: number; record?: string; target?: string }
export function queueView(queue: QueueName, view?: string) {
  if (view && !(queueViews[queue] as readonly string[]).includes(view)) throw Object.assign(new Error('This view is not available. Choose a view from the list.'), { status: 400 });
  return view || queueViews[queue][0];
}
/** The WAT day of an instant, or '' for none. */
const watDay = (time: number) => Number.isFinite(time) ? new Date(time + WAT_OFFSET_MS).toISOString().slice(0, 10) : '';
const instant = (value: unknown) => { const n = Date.parse(String(value || '')); return Number.isFinite(n) ? n : Infinity; };
/** When a deadline passes (deadlineEnds): a date-only one lasts its whole WAT day; an impossible one never passes and sorts last. */
const deadlineAt = (value: unknown) => { const n = deadlineEnds(value); return Number.isFinite(n) ? n : Infinity; };
const unpaid = (row?: ValopayRecord) => !!row && !['paid', 'closed', 'cancelled'].includes(row.status);

/** Reference implementation for the in-memory API; production filters and pages in PostgreSQL. */
export function pageQueue(records: ValopayRecord[], queue: QueueName, query: QueueQuery, now: string) {
  const view = queueView(queue, query.view), time = Date.parse(now), today = watDay(time);
  const byId = new Map(records.map(row => [row.id, row]));
  const base = records.filter(row => queue === 'collections' ? row.kind === 'due-items' || row.kind === 'attempts' && row.status === 'failed' : row.kind === queue);
  const due = (row: ValopayRecord) => row.kind === 'attempts' ? byId.get(String(row.data.dueItemId)) : row;
  const deadline = (row: ValopayRecord) => queue === 'exceptions' ? row.data.dueBy : queue === 'mandates' ? row.data.activationDeadline : due(row)?.data.dueDate;
  const owner = (row: ValopayRecord) => String((queue === 'collections' ? due(row) : row)?.data.owner || (queue === 'collections' ? 'unassigned' : 'Unassigned'));
  // A date-only deadline is due all of its WAT day and overdue after it, in every queue (as the SQL reads it).
  const overdue = (row: ValopayRecord) => deadlineAt(deadline(row)) < time;
  const dueToday = (row: ValopayRecord) => watDay(deadlineAt(deadline(row))) === today;
  const matches = (row: ValopayRecord, key: string) => {
    if (queue === 'exceptions') {
      const open = !['closed', 'resolved'].includes(row.status);
      return key === 'resolved' ? !open : open && (key === 'high' ? row.data.severity === 'high' : key === 'overdue' ? overdue(row) : key === 'due-today' ? dueToday(row) : true);
    }
    if (queue === 'mandates') return key === 'all' || row.status === 'pending_activation' && (key === 'overdue' ? overdue(row) : key === 'due-today' ? dueToday(row) : true);
    return key === 'failed' ? row.kind === 'attempts' : row.kind === 'due-items' && (key === 'all' || unpaid(row) && (key === 'overdue' ? overdue(row) : dueToday(row)));
  };
  const search = foldForSearch(query.q || '');
  const owned = base.filter(row => (!search || foldForSearch([row.name,row.reference,byId.get(row.customerId)?.name,byId.get(row.customerId)?.reference].join(' ')).includes(search)) && (!query.owner || owner(row) === query.owner) && (!query.type || row.data.type === query.type));
  const counts = Object.fromEntries(queueViews[queue].map(key => [key, owned.filter(row => matches(row, key)).length]));
  const severity: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const compare = (a: number, b: number) => a === b ? 0 : a < b ? -1 : 1;
  const items = owned.filter(row => query.record ? row.id === query.record : matches(row, view)).sort((a, b) => {
    const priority = queue === 'exceptions' ? Number(overdue(b)) - Number(overdue(a)) || (severity[String(a.data.severity)] ?? 4) - (severity[String(b.data.severity)] ?? 4)
      : queue === 'mandates' ? Number(b.status === 'pending_activation') - Number(a.status === 'pending_activation')
      : Number(unpaid(due(b)) && overdue(b)) - Number(unpaid(due(a)) && overdue(a)) || Number(unpaid(due(b))) - Number(unpaid(due(a)));
    return priority || compare(deadlineAt(deadline(a)), deadlineAt(deadline(b))) || (queue === 'collections' ? compare(instant(a.data.occurredAt), instant(b.data.occurredAt)) : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  const limit = query.limit || 25, index = query.target ? items.findIndex(row => row.id === query.target) : -1;
  const offset = index >= 0 ? Math.floor(index / limit) * limit : Math.min(query.offset || 0, Math.max(0, Math.ceil(items.length / limit) - 1) * limit);
  const page = items.slice(offset, offset + limit);
  const related = queueRelated(records, page, query.record);
  return { items: page, related, total: items.length, offset, counts, owners: [...new Set(base.map(owner))].sort(), types: [...new Set(base.map(row => String(row.data.type || 'unknown')))].sort(), asOf: now };
}

export function queueRelated(records: ValopayRecord[], page: ValopayRecord[], selectedId?: string) {
  const related = new Map<string, ValopayRecord>(), byId = new Map(records.map(row => [row.id, row]));
  const add = (id: unknown) => { const row = byId.get(String(id || '')); if (row) related.set(row.id, row); };
  for (const row of page) if (row.kind === 'attempts') add(row.data.dueItemId);
  const dues = [...page, ...related.values()].filter(row => row.kind === 'due-items');
  for (const due of dues) {
    add(due.data.mandateId); add(due.data.policyId);
    const latest = records.filter(row => row.kind === 'attempts' && row.status === 'failed' && row.data.dueItemId === due.id).sort((a, b) => instant(b.data.occurredAt || b.createdAt) - instant(a.data.occurredAt || a.createdAt) || a.id.localeCompare(b.id))[0];
    if (latest) related.set(latest.id, latest);
  }
  for (const row of [...page, ...related.values()]) { add(row.customerId); if (row.kind === 'mandates') add(row.data.policyId); }
  if (selectedId) for (const row of records.filter(row => row.kind === 'mandates' && row.data.reissuedFrom === selectedId).slice(0, 100)) related.set(row.id, row);
  return [...related.values()];
}
