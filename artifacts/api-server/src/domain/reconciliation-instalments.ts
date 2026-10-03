/** Instalment balances and statuses, including cancellation of unsent attempts when paid. */
import { type DomainState, type TypedRecord, type Context } from "./types";
import { recordsWhere } from "./record-index";
import { touch, recordsOf } from "./records";
import { outstanding } from "./reconciliation-values";
import { attemptsFor } from "./policy-engine";
import { nairaText, sumMoney } from "@workspace/valo-pay-1-schema";
import { isDeepStrictEqual } from "node:util";
import { validateRecord } from "./validation";

export function cancelUnsentAttempts(state: DomainState, dueItemId: string, now: string): void {
  recordsWhere(state, "attempts", "data.dueItemId", dueItemId).filter((item) => item.status === "scheduled").forEach((item) => {
    item.status = "cancelled";
    item.data.cancellationReason = "Instalment paid another way. No instruction was sent.";
    touch(item, now);
  });
}

/** Statuses a workflow sets rather than the balance: an edit, a repair or a returned allocation keeps them. */
const heldDueStatuses: readonly string[] = ["in_dispute", "cancelled", "closed"];

/** The status the balance alone gives an instalment: paid, part-paid, or else scheduled or in collection by its attempts. */
export function balanceStatus(state: DomainState, due: TypedRecord<"due-items">): TypedRecord<"due-items">["status"] {
  const left = outstanding(due);
  if (left === 0) return "paid";
  if (left < due.amountKobo) return "partially_paid";
  if (due.status === "scheduled" || due.status === "in_collection") return due.status;
  return attemptsFor(state, due.id).length ? "in_collection" : "scheduled";
}

/**
 * The status an instalment's balance implies: paid with nothing outstanding,
 * part-paid while some but not all of it is paid, and otherwise scheduled or
 * in collection, by its attempts. A dispute, cancellation or closure is kept,
 * and so is a final failure while money is still owed, unless `reopenFinal`
 * (a superseded allocation gives the engine money to collect again).
 */
export function derivedDueStatus(state: DomainState, due: TypedRecord<"due-items">, reopenFinal = false): TypedRecord<"due-items">["status"] {
  if (heldDueStatuses.includes(due.status)) return due.status;
  if (due.status === "unpaid_final" && outstanding(due) > 0 && !reopenFinal) return "unpaid_final";
  return balanceStatus(state, due);
}

/** An instalment's status in words, for messages. */
export const dueStatusText = (status: string): string => ({ in_collection: "in collection", partially_paid: "partially paid", unpaid_final: "unpaid after its final attempt", in_dispute: "in dispute" } as Record<string, string>)[status] ?? status;

/** Moves an instalment to the status its balance implies; a settled one has its unsent attempts cancelled. True when the status changed. */
export function settleDueStatus(state: DomainState, ctx: Context, due: TypedRecord<"due-items">, reopenFinal = false): boolean {
  const status = derivedDueStatus(state, due, reopenFinal);
  if (status === "paid") cancelUnsentAttempts(state, due.id, ctx.now);
  if (status === due.status) return false;
  due.status = status; touch(due, ctx.now);
  return true;
}

/**
 * An instalment edited through the record API. Its outstanding balance is
 * rebuilt from the confirmed allocations and its status follows that balance,
 * so a paid instalment whose amount rises is part-paid again and a part-paid
 * one reduced to what was paid is paid. The status is derived after
 * validation, which refuses a status set by the caller.
 */
export function amendDueItem(state: DomainState, ctx: Context, due: TypedRecord<"due-items">, input: TypedRecord<"due-items">): TypedRecord<"due-items"> {
  const allocated = sumMoney(recordsOf(state, "allocations").filter((item) => item.status === "confirmed" && item.data.dueItemId === due.id).map((item) => item.amountKobo));
  if (input.amountKobo < allocated) throw new Error(`The amount cannot be less than the ${nairaText(allocated)} already allocated to this instalment. Enter ${nairaText(allocated)} or more.`);
  for (const key of ["experimentId", "experimentArm", "firstFailureAt"] as const) {
    if (JSON.stringify(input.data[key]) !== JSON.stringify(due.data[key])) throw new Error("The experiment group of this instalment cannot be changed.");
  }
  // The engine reads the release to leave a released disputed debit alone; compared by value, as jsonb reorders keys.
  if (!isDeepStrictEqual(input.data.disputeRelease, due.data.disputeRelease)) throw new Error("Use Release from dispute to take an instalment out of dispute. You cannot change it here.");
  input.data.outstandingKobo = input.amountKobo - allocated;
  // RET-10: an obligation amended after its first failure leaves the experiment's eligible set.
  if (input.amountKobo !== due.amountKobo || String(input.data.dueDate) !== String(due.data.dueDate)) input.data.amendedAt = ctx.now;
  validateRecord(state, ctx, "due-items", input, true);
  Object.assign(due, input);
  settleDueStatus(state, ctx, due);
  return due;
}
