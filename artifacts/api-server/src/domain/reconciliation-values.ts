/** Shared record values used by reconciliation and its exception lifecycle; no workflow dependencies. */
import { normaliseReversalStatus } from "@workspace/valopay-schema";
import type { TypedRecord, ValopayRecord } from "./types";

export const paymentReversed = (payment: TypedRecord<"payments">): boolean => normaliseReversalStatus(payment.data.reversalStatus) === "reversed";

/** The currency evidence or a payment is in, in capitals; one that names none is in naira. */
export const currencyOf = (record: ValopayRecord): string => String(record.data.currency || "NGN").trim().toUpperCase();

/** The stored instalment balance, falling back to its face value for older records. */
export function outstanding(due: TypedRecord<"due-items">): number {
  return Number.isInteger(due.data.outstandingKobo) ? Number(due.data.outstandingKobo) : due.amountKobo;
}
