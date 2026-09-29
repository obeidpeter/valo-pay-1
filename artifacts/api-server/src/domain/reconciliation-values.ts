/** Shared reconciliation constants and record values; no workflow dependencies. */
import { type TypedRecord, type DomainState, type ValopayRecord } from "./types";
import { normaliseRefundStatus, paymentMoneyReturned, providerConnectionKey, type ExceptionType, type PaymentChannel, normaliseReversalStatus } from "@workspace/valopay-schema";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** ING-05: a second Payment for the same payer and amount inside this window is held as a possible duplicate. */
export const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

/** REC-04: unallocated Payments older than this become exceptions. */
export const UNALLOCATED_AGE_MS = DAY_MS;

/** Decision on a reversal of a payment no connection has seen: after waiting this long for its payment, it is an exception for Finance. */
export const UNSEEN_REVERSAL_AGE_MS = DAY_MS;

/** Appendix A, unknown_outcome: a debit attempt's or a pay-by-bank checkout's outcome still unknown this long after it became unknown is an exception. */
export const UNKNOWN_OUTCOME_AGE_MS = DAY_MS;

export const paymentRefunded = (payment: TypedRecord<"payments">): boolean => normaliseRefundStatus(payment.data.refundStatus) === "refunded";

/** Reversed, or refunded in full: the money went back to the payer, so nothing it has not already applied can be allocated or held as credit. */
export const paymentReturned = (payment: TypedRecord<"payments">): boolean => paymentMoneyReturned(payment);

export const paymentObservedAt = (payment: TypedRecord<"payments">): number => Date.parse(String(payment.data.observedAt || payment.createdAt));

/** When an allocation was applied (REC-07, REC-09): confirmedAt, or its creation for records written before confirmedAt was kept. A review or a reinstatement never moves it. */
export const allocationConfirmedAt = (allocation: TypedRecord<"allocations">): string => String(allocation.data.confirmedAt || allocation.createdAt);

/** ING-03: the provider connection evidence came through, or a payment was observed on; one that names none came through the lender's own. */
export const connectionOf = (state: DomainState, record: ValopayRecord): string => String(record.data.providerConnection || record.data.provider || state.merchant.provider);

/** Connection names are free text: they are compared without case or surrounding spaces. */
export const connectionKey = providerConnectionKey;

/** The connection a record names, as written: its providerConnection, else its provider (as observationProviderKey reads them); undefined when it names neither, and then it carries no provider identity. */
export const namedConnection = (record: ValopayRecord): string | undefined => [record.data.providerConnection, record.data.provider].find((value): value is string => typeof value === "string" && connectionKey(value) !== "");

/** FIN-03: a settlement batch held for its provider identity, a review not released since (holdEarlierSettlementIdentities). */
export const identityHeld = (batch: ValopayRecord): boolean => !!batch.data.providerIdentityReview && !batch.data.providerIdentityRelease;

/** The condition an exception type raises for when it names only its record: the record itself. */
export const identityCondition = (type: ExceptionType, linkedRecordId: string): string => `${type}:${linkedRecordId}`;

export function channelFor(source: unknown): PaymentChannel {
  switch (source) {
    case "webhook": case "settlement": return "direct_debit";
    case "transfer": return "transfer";
    case "card": return "card";
    case "statement": return "statement";
    default: return "manual";
  }
}

export const paymentReversed = (payment: TypedRecord<"payments">): boolean => normaliseReversalStatus(payment.data.reversalStatus) === "reversed";

/** The currency evidence or a payment is in, in capitals; one that names none is in naira. */
export const currencyOf = (record: ValopayRecord): string => String(record.data.currency || "NGN").trim().toUpperCase();

/** The stored instalment balance, falling back to its face value for older records. */
export function outstanding(due: TypedRecord<"due-items">): number {
  return Number.isInteger(due.data.outstandingKobo) ? Number(due.data.outstandingKobo) : due.amountKobo;
}
