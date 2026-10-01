import { moneyText, normaliseRefundStatus, normaliseReversalStatus } from "@workspace/valopay-schema";
import type { TypedRecord, ValopayRecord } from "./types";

/*
 * Whether payment evidence agrees with a payment, shared by reconciliation, which
 * decides what evidence becomes, and by the renewed reversal review's hold, which
 * must hold exactly the payment an adopted decision would reverse.
 */

/** The currency of a record's money: its ISO 4217 code, naira when it names none. */
const currencyOf = (record: ValopayRecord): string => String(record.data.currency || "NGN").trim().toUpperCase();

/** The gross evidence states: its stated gross, else its amount. A settlement line that states only what it paid out gives the least the gross can be. */
export function statedGross(observation: TypedRecord<"observations">): { kobo: number; atLeast: boolean } {
  const stated = observation.data.grossAmountKobo;
  return stated !== undefined ? { kobo: Number(stated), atLeast: false } : { kobo: observation.amountKobo, atLeast: observation.data.source === "settlement" };
}

/**
 * ING-03 and ING-05: why evidence under a payment's key is someone else's
 * money rather than more evidence of that payment: it names another payer (or
 * the payment is already tied to another payer's instalment, `tiedPayers`), it
 * is in another currency, or it states another gross amount. Undefined when it
 * agrees. A settlement line that states only what it paid out agrees with any
 * gross at least that large, and a gross completes a payment made from such a
 * line, whatever of it is applied, unless its money went back (a refund or a
 * reversal).
 */
export function evidenceConflict(payment: TypedRecord<"payments">, observation: TypedRecord<"observations">, tiedPayers: (payment: TypedRecord<"payments">) => readonly string[]): string | undefined {
  const payer = observation.customerId;
  if (payer && payment.customerId && payer !== payment.customerId) return "it names another payer";
  if (payer && !payment.customerId && tiedPayers(payment).some((customerId) => customerId !== payer)) return "it names a different payer from the instalment the payment is tied to";
  if (currencyOf(observation) !== currencyOf(payment)) return `it is in ${currencyOf(observation)} and the payment is in ${currencyOf(payment)}`;
  const { kobo, atLeast } = statedGross(observation);
  const returned = normaliseRefundStatus(payment.data.refundStatus) === "refunded" || normaliseReversalStatus(payment.data.reversalStatus) === "reversed";
  const agrees = atLeast ? kobo <= payment.amountKobo : kobo === payment.amountKobo || (payment.data.grossUnstated === true && kobo > payment.amountKobo && !returned);
  return agrees ? undefined : `it states ${moneyText(kobo, currencyOf(payment))}${atLeast ? " paid out" : ""} and the payment is ${moneyText(payment.amountKobo, currencyOf(payment))}`;
}
