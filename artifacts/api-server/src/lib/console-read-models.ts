import { foldForSearch } from './valo-pay-1-list';
import type { DomainState, ValopayRecord } from "../domain/types";
import { precisionAudit } from "../domain/reports";
import { paymentAwaitsAllocation } from "@workspace/valo-pay-1-schema";

export const reconciliationQueues = [
  "proposals",
  "duplicates",
  "payments",
  "observations",
  "audit",
  "batches",
] as const;
export type ReconciliationQueue = (typeof reconciliationQueues)[number];
export interface ReadPageQuery {
  q?: string;
  limit?: number;
  offset?: number;
  dueItem?: string;
  from?: string;
  to?: string;
}
export function pageOffset(total: number, limit: number, offset = 0) {
  return Math.min(offset, Math.max(0, Math.ceil(total / limit) - 1) * limit);
}
export function validateCloseRange(from = "", to = "") {
  const valid = (v: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString().slice(0, 10) === v;
  if ((from && !valid(from)) || (to && !valid(to)) || (from && to && from > to))
    throw Object.assign(
      new Error("Choose valid dates with the start on or before the end."),
      { status: 400 },
    );
}
export function closeSummary(row: ValopayRecord): ValopayRecord {
  const { summary, closedAt, schedule, positionAlert, report } = row.data;
  return {
    ...row,
    data: JSON.parse(
      JSON.stringify({
        summary,
        closedAt,
        schedule,
        positionAlert,
        report: report
          ? {
              unallocated: { kobo: report.unallocated?.kobo },
              exceptions: { openAtClose: report.exceptions?.openAtClose },
            }
          : undefined,
      }),
    ),
  };
}
export function pageCloseHistory(
  records: ValopayRecord[],
  query: ReadPageQuery,
) {
  validateCloseRange(query.from, query.to);
  const all = records.filter((r) => r.kind === "closes");
  const rows = all
    .filter((r) => {
      const day = new Date(Date.parse(r.createdAt) + 3600000)
        .toISOString()
        .slice(0, 10);
      return (
        (!query.from || day >= query.from) && (!query.to || day <= query.to)
      );
    })
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
  const limit = query.limit || 25,
    offset = pageOffset(rows.length, limit, query.offset);
  return {
    items: rows.slice(offset, offset + limit).map(closeSummary),
    total: rows.length,
    allTotal: all.length,
    offset,
    ...(rows.length
      ? { first: closeSummary(rows.at(-1)!), latest: closeSummary(rows[0]!) }
      : {}),
  };
}
/** Reference implementation used by the synthetic HTTP test server. Production pages in SQL. */
export function pageReconciliation(
  state: DomainState,
  queue: ReconciliationQueue,
  query: ReadPageQuery,
  now: string,
) {
  const byId = new Map(state.records.map((r) => [r.id, r]));
  const due = query.dueItem ? byId.get(query.dueItem) : undefined;
  const precision = queue === "audit" ? precisionAudit(state, now) : undefined;
  const ids = new Set(precision?.sampledAllocationIds || []);
  const rows = state.records
    .filter((r) => {
      const linked = [r,...[r.customerId,r.data.paymentId,r.data.dueItemId].map(id=>byId.get(String(id))).filter((row):row is ValopayRecord=>!!row)];
      const searchable = [...linked,...linked.map(row=>byId.get(row.customerId)).filter((row):row is ValopayRecord=>!!row)];
      if (query.q?.trim() && !searchable.some(row=>foldForSearch(row.name+' '+row.reference).includes(foldForSearch(query.q!).trim()))) return false;
      const match =
        queue === "proposals"
          ? r.kind === "allocations" && r.status === "proposed"
          : queue === "duplicates"
            ? r.kind === "payments" && r.status === "possible_duplicate"
            : queue === "payments"
              ? r.kind === "payments" && paymentAwaitsAllocation(r)
              : queue === "observations"
                ? r.kind === "observations" && r.status === "unresolved"
                : queue === "audit"
                  ? ids.has(r.id)
                  : r.kind === "settlement-batches";
      return (
        match &&
        (!query.dueItem ||
          (due?.kind === "due-items" &&
            (queue === "proposals"
              ? r.data.dueItemId === due.id
              : queue === "observations"
                ? r.data.dueItemId === due.id ||
                  (!!due.customerId && r.customerId === due.customerId)
                : !!due.customerId && r.customerId === due.customerId)))
      );
    })
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
  const limit = query.limit || 25,
    offset = pageOffset(rows.length, limit, query.offset),
    items = rows.slice(offset, offset + limit);
  const related = new Map<string, ValopayRecord>();
  if (due?.kind === "due-items") related.set(due.id, due);
  for (let hop = 0; hop < 2; hop++)
    for (const r of [...items, ...related.values()])
      for (const id of [r.customerId, r.data.paymentId, r.data.dueItemId]) {
        const row = byId.get(String(id));
        if (row && ["customers", "payments", "due-items"].includes(row.kind))
          related.set(row.id, row);
      }
  return {
    items,
    related: [...related.values()],
    total: rows.length,
    offset,
    asOf: now,
    ...(precision ? { precision } : {}),
  };
}
