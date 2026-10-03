import { notFoundText } from "@workspace/valo-pay-1-schema";
import { positionFor, unallocatedOtherCurrencies } from "./close";
import { recordsOf } from "./records";
import type { DomainState } from "./types";

/** One customer's timeline: the record, its derived position (REC-05) and every related record newest first. */
export function customerTimeline(state: DomainState, id: string) {
  const customer = recordsOf(state, "customers").find((record) => record.id === id);
  if (!customer) throw Object.assign(new Error(notFoundText("customer")), { status: 404 });
  const related = state.records.filter((record) => record.customerId === id);
  const dueItems = related.filter((record) => record.kind === "due-items"), payments = related.filter((record) => record.kind === "payments");
  // REC-05: one derivation of the position, shared with the daily close and the dispute pack; money in another currency is
  // listed beside the naira credit, as the pack lists it, never added to it.
  const { obligationsKobo, allocatedKobo, outstandingKobo, unallocatedKobo } = positionFor(state, id);
  const unallocatedOther = unallocatedOtherCurrencies(payments);
  return {
    customer,
    position: { obligationsKobo, allocatedKobo, outstandingKobo, unallocatedKobo, ...(unallocatedOther ? { unallocatedOtherCurrencies: unallocatedOther } : {}), note: "Calculated from instalments and payments. Valo Pay 1 never holds money." },
    events: related.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), mandates: related.filter((record) => record.kind === "mandates"), dueItems, payments,
  };
}
