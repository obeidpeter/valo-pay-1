import { canTakeAllocation, instantInputSchema } from "@workspace/valopay-schema";
import type { ValopayRecord } from "../domain/types";
import { auditEntryName } from "./action-names";

/** Hard ceiling on one page so a list can never return more than this. */
export const LIST_PAGE_CEILING = 500;
/**
 * Kinds that grow with a lender's history, with every action or day, rather
 * than with its book: the audit chain, the daily closes and the logs of
 * exports, messages and retry decisions. A list of one of them without
 * `limit` returns at most LIST_PAGE_CEILING records, newest first, with
 * `nextOffset` to page on; a list of any other kind without `limit` returns
 * its whole filtered set.
 */
export const HISTORY_KINDS: ReadonlySet<string> = new Set(["audit", "closes", "exports", "notifications", "retry-decisions"]);
/** A list's page size: the `limit` asked for, at most the ceiling; without one, the ceiling for a history kind and no limit for the rest. */
export function listLimit(kind: string | undefined, limit: unknown): number | undefined {
  if (Number.isInteger(limit) && Number(limit) > 0) return Math.min(Number(limit), LIST_PAGE_CEILING);
  return kind !== undefined && HISTORY_KINDS.has(kind) ? LIST_PAGE_CEILING : undefined;
}

/** Search form of a text: marks stripped and case folded, so "Ọkọnkwọ", "Okonkwo" and "OKONKWO" all match one another however a name was typed. */
export function foldForSearch(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * Whether a list's search (already folded, foldForSearch) matches a record: its
 * name, its reference or any text or number value in its data, nested ones
 * included, each value on its own, so a search never runs from one value into
 * the next. A field's name, true, false, null and JSON's own quotes and braces
 * are not searched: "synthetic" or "true" no longer matches every record, and
 * a value holding a double quote is found as written. An audit entry is also
 * found by the name in words the audit log shows for its stored action
 * (auditEntryName, as withAuditName names it), as well as by that code.
 */
export function matchesSearch(record: { kind?: string; name: string; reference: string; data: unknown }, search: string): boolean {
  const matches = (value: unknown): boolean =>
    typeof value === "string" ? foldForSearch(value).includes(search)
    : typeof value === "number" ? String(value).includes(search)
    : Array.isArray(value) ? value.some(matches)
    : value !== null && typeof value === "object" ? Object.values(value).some(matches) : false;
  if (matches(record.name) || matches(record.reference) || matches(record.data)) return true;
  if (record.kind !== "audit") return false;
  const action = (record.data as { action?: unknown } | null)?.action;
  return matches(auditEntryName(typeof action === "string" ? action : record.name));
}

export interface ListQuery { status?: string; search?: string; limit?: number; offset?: number; updatedSince?: string; customerId?: string; id?: string; allocatable?: "true" | "false"; paymentId?: string }

/** The status a list of saved exports gives a job whose file an approved retention run removed (fileDeletedAt). */
export const EXPIRED_EXPORT_STATUS = "expired";
/**
 * Whether a record is in the status a list asks for. A saved export whose file
 * an approved retention run removed is `expired` whatever its job's status, so
 * `ready` (Completed) and `failed` (Needs retry) list only exports whose file
 * remains; any other record is in its own status. listRecords applies the same
 * rule in SQL.
 */
export function inListStatus(record: ValopayRecord, status: string): boolean {
  if (record.kind === "exports" && record.data.fileDeletedAt) return status === EXPIRED_EXPORT_STATUS;
  return record.status === status;
}

/**
 * True when a list asks only for instalments that can take an allocation
 * (`canTakeAllocation`); asked of another kind, it is refused. `paymentId`
 * narrows it to one payment's choices (allocationChoices), so it is refused
 * without allocatable=true.
 */
export function allocatableOnly(kind: string, query: ListQuery): boolean {
  if (query.paymentId !== undefined && query.allocatable !== "true") throw Object.assign(new Error("paymentId lists the instalments a manual allocation of that payment accepts. Use it with allocatable=true."), { status: 400 });
  if (query.allocatable !== "true") return false;
  if (kind !== "due-items") throw Object.assign(new Error("allocatable lists instalments only. Use it with due-items."), { status: 400 });
  return true;
}

/**
 * One payment's allocation choices (`paymentId`) as the list's customer
 * filter: the customer whose instalments a manual allocation of that payment
 * accepts (allocationPayer: its payer, or the customer of the instalment its
 * evidence names; no filter when any customer's are). Undefined when no
 * instalment can take it: the payment takes no allocation at all, or the
 * list's own customerId names another customer.
 */
export function allocationChoices(query: ListQuery, payer: { customerId?: string } | null): ListQuery | undefined {
  if (!payer) return undefined;
  if (payer.customerId === undefined) return query;
  if (query.customerId && query.customerId !== payer.customerId) return undefined;
  return { ...query, customerId: payer.customerId };
}

/** Why an incremental sync's watermark was refused. */
export const UPDATED_SINCE_REFUSAL = "updatedSince must be an RFC 3339 date and time with Z or an offset, such as 2026-09-18T08:00:00+01:00.";
/**
 * The instant an incremental sync's watermark names, in milliseconds, as the
 * shared instant schema reads it: RFC 3339 with Z or an offset, from the year
 * 0001. A number, a day without a time, a time without a zone (which would be
 * read in the server's own zone) or a value PostgreSQL cannot store is a 400.
 */
export function updatedSinceInstant(value: string): number {
  const since = instantInputSchema.safeParse(value);
  if (!since.success) throw Object.assign(new Error(UPDATED_SINCE_REFUSAL), { status: 400 });
  return Date.parse(since.data);
}

/**
 * Filter, order and page a kind's records: status (inListStatus) and search as before,
 * whether an instalment can take an allocation (`allocatable`; the caller
 * checks the kind with allocatableOnly), an `updatedSince` watermark for
 * incremental sync (Appendix B updated_since), newest first, then `offset` and
 * `limit` (listLimit, for `kind` when given).  `total` counts the filtered set
 * so a client can page; `nextOffset` is present when more rows remain.
 */
export function pageRecords(records: ValopayRecord[], query: ListQuery, kind?: string): { items: ValopayRecord[]; total: number; nextOffset?: number } {
  let items = records;
  const status = query.status;
  if (status && status !== "all") items = items.filter((record) => inListStatus(record, status));
  if (query.customerId) items = items.filter((record) => record.customerId === query.customerId);
  if (query.id) items = items.filter((record) => record.id === query.id);
  if (query.allocatable === "true") items = items.filter(canTakeAllocation);
  if (query.search) { const search = foldForSearch(query.search); items = items.filter((record) => matchesSearch(record, search)); }
  if (query.updatedSince) {
    const since = updatedSinceInstant(query.updatedSince);
    items = items.filter((record) => Date.parse(record.updatedAt) >= since);
  }
  items = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const total = items.length;
  const offset = Number.isInteger(query.offset) && Number(query.offset) > 0 ? Number(query.offset) : 0;
  const limit = listLimit(kind, query.limit);
  const page = limit === undefined ? items.slice(offset) : items.slice(offset, offset + limit);
  const nextOffset = offset + page.length < total ? offset + page.length : undefined;
  return nextOffset === undefined ? { items: page, total } : { items: page, total, nextOffset };
}
