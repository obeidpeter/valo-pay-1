import type { DomainState } from "../domain/types";
import { customerTimeline } from "../domain/timeline";
import { pageOffset } from "./console-read-models";

export const historySections = [
  "events",
  "mandates",
  "dueItems",
  "payments",
] as const;
export type HistorySection = (typeof historySections)[number];
export type CustomerHistoryQuery = Partial<
  Record<`${HistorySection}Limit` | `${HistorySection}Offset`, number>
> & { record?: string };
export const historyKind = {
  events: null,
  mandates: "mandates",
  dueItems: "due-items",
  payments: "payments",
} as const;
export const positionNote =
  "Calculated from instalments and payment records. Valo Pay does not hold these funds.";

/** Reference for synthetic tests. Production applies the same page boundaries in SQL. */
export function pageCustomerHistory(
  state: DomainState,
  id: string,
  query: CustomerHistoryQuery,
) {
  const timeline = customerTimeline(state, id);
  const totals = {} as Record<HistorySection, number>,
    offsets = {} as Record<HistorySection, number>;
  const focusedRecord = timeline.events.find((row) => row.id === query.record);
  for (const section of historySections) {
    const rows = timeline[section].sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
    const limit = Math.min(query[`${section}Limit`] || 25, 100);
    totals[section] = rows.length;
    offsets[section] = pageOffset(
      rows.length,
      limit,
      query[`${section}Offset`],
    );
    timeline[section] = rows.slice(offsets[section], offsets[section] + limit);
  }
  return {
    ...timeline,
    totals,
    offsets,
    ...(focusedRecord ? { focusedRecord } : {}),
  };
}
