/** Payment allocations, payer decisions, returned money and dispute releases. */
import { type TypedRecord, type DomainState, type Context, type ValopayRecord } from "./types";
import { normaliseReversalStatus, normaliseRefundStatus, isKobo, paymentUnappliedKobo, paymentMoneyReturned, paymentRefundedKobo, nairaText, allocationClosedStatuses, sumMoney, isOpenException, resolveExceptionType } from "@workspace/valopay-schema";
import { outstanding, currencyOf, paymentReturned, paymentReversed } from "./reconciliation-values";
import { makeRecord, touch, recordsOf, findRecord } from "./records";
import { recordsWhere, recordById } from "./record-index";
import { paymentNeedsReversalReview, dueNeedsReversalReview } from "./reversal-review";
import { raiseException, closeClearedException, noteUpdate } from "./reconciliation-exceptions";
import { cancelUnsentAttempts, settleDueStatus, balanceStatus } from "./reconciliation-instalments";
import { statusHeldInDispute } from "./reconciliation-reversal-holds";
import { countedAttempts } from "./policy-engine";

/** The four independent status dimensions of a Payment (TRD 4.2), written in one vocabulary; legacy spellings are normalised. */
export function paymentDimensions(payment: TypedRecord<"payments">): void {
  payment.data.collectionStatus ||= "received";
  payment.data.settlementStatus ||= "unsettled";
  payment.data.reversalStatus = normaliseReversalStatus(payment.data.reversalStatus);
  payment.data.refundStatus = normaliseRefundStatus(payment.data.refundStatus);
  if (!isKobo(payment.data.allocatedKobo)) payment.data.allocatedKobo = 0;
}

/**
 * Creates an allocation: a proposal for Finance when `confidence` is
 * probable, otherwise applied at once. A payment whose evidence named no payer
 * is applied only by Finance, with `payerReason`: that allocation identifies
 * the payer. A proposal for such a payment carries no customer until then.
 */
export function allocatePayment(
  state: DomainState,
  ctx: Context,
  payment: TypedRecord<"payments">,
  due: TypedRecord<"due-items">,
  amount: number,
  rule: string,
  confidence: "certain" | "probable" | "manual",
  automatic: boolean,
  explanation?: string,
  payerReason?: string,
): TypedRecord<"allocations"> {
  assertAllocationEligible(state, due);
  assertPaymentAllocatable(state, payment, amount);
  assertSamePayer(state, payment, due, confidence === "probable" ? undefined : { automatic, reason: payerReason });
  if (!Number.isInteger(amount) || amount <= 0 || amount > paymentUnappliedKobo(payment)) {
    throw new Error("Enter a positive whole number in kobo, no more than the payment has left to allocate.");
  }
  const remaining = outstanding(due);
  if (amount > remaining) throw new Error("This allocation exceeds the outstanding instalment balance. Enter a lower amount.");
  const allocation = makeRecord(state, "allocations", {
    name: `Allocation ${rule}`, status: "proposed",
    customerId: payment.customerId, amountKobo: amount, createdAt: ctx.now,
    data: { paymentId: payment.id, dueItemId: due.id, rule, confidence, automatic, explanation: explanation ?? `Matching rule ${rule} linked this payment to the instalment.`, reviewed: null },
  });
  if (confidence === "probable") {
    payment.status = "proposed";
    payment.data.proposedDueItemId = due.id;
    payment.data.proposedAmountKobo = amount;
  } else {
    applyConfirmedAllocation(state, ctx, allocation, payerReason);
  }
  touch(payment, ctx.now);
  return allocation;
}

/**
 * A payment is applied only to its payer's instalments. One whose evidence
 * named no payer is applied only by Finance with a reason, never by
 * automatic matching (`applied`; a proposal passes none), and not against an
 * instalment its own evidence says is another customer's.
 */
function assertSamePayer(state: DomainState, payment: TypedRecord<"payments">, due: TypedRecord<"due-items">, applied?: { automatic: boolean; reason?: string }): void {
  if (payment.customerId && payment.customerId !== due.customerId) {
    throw Object.assign(new Error(`Payment ${payment.reference} is from another customer than instalment ${due.reference}'s. Choose one of the payer's instalments.`), { status: 409 });
  }
  if (payment.customerId || !applied) return;
  if (applied.automatic || !applied.reason?.trim()) {
    throw Object.assign(new Error(`Payment ${payment.reference} names no payer. Automatic matching never applies it: Finance identifies the payer by allocating it to one of their instalments, with a reason.`), { status: 409 });
  }
  const linked = payment.data.dueItemId && payment.data.dueItemId !== due.id ? recordsOf(state, "due-items").find((item) => item.id === payment.data.dueItemId) : undefined;
  if (linked && linked.customerId !== due.customerId) throw Object.assign(new Error(`Payment ${payment.reference}'s evidence names instalment ${linked.reference} of another customer. Choose one of that customer's instalments, or review the evidence.`), { status: 409 });
}

/**
 * Whose instalments a manual allocation of a payment accepts, by the rules
 * that allocation applies (assertPaymentAllocatable and assertSamePayer): its
 * payer's; for a payment whose evidence named no payer, those of the customer
 * of the instalment its evidence names (`instalmentCustomer`, when that
 * instalment exists), or any customer's while it names none. Null when it takes
 * no allocation at all: it is in another currency than naira, its money went
 * back, nothing of it is left to allocate, or reconciliation holds it for a
 * renewed review of an earlier reversal decision (legacyReversalReviewIds; a
 * hold not yet recorded is the action's alone to refuse). The allocation
 * picker's list applies it (`paymentId`).
 */
export function allocationPayer(payment: ValopayRecord, instalmentCustomer: string | undefined): { customerId?: string } | null {
  const held = payment.data.legacyReversalReviewIds;
  if (currencyOf(payment) !== "NGN" || paymentMoneyReturned(payment) || paymentUnappliedKobo(payment) <= 0 || (Array.isArray(held) && held.length > 0)) return null;
  if (payment.customerId) return { customerId: payment.customerId };
  return instalmentCustomer === undefined ? {} : { customerId: instalmentCustomer };
}

/**
 * Decision on evidence with no payer: Finance identifies the payer by applying
 * the payment to one of that customer's instalments. The payment takes the
 * customer in the same action, with who identified it, when, why and through
 * which allocation; a proposal of it for another customer is withdrawn.
 */
function identifyPayer(state: DomainState, ctx: Context, payment: TypedRecord<"payments">, due: TypedRecord<"due-items">, allocation: TypedRecord<"allocations">, reason: string): void {
  payment.customerId = due.customerId;
  payment.data.payerIdentification = { customerId: due.customerId, identifiedBy: ctx.actor, identifiedAt: ctx.now, reason: reason.trim(), dueItemId: due.id, allocationId: allocation.id };
  for (const proposal of recordsOf(state, "allocations").filter((item) => item.id !== allocation.id && item.status === "proposed" && item.data.paymentId === payment.id)) {
    if (recordsOf(state, "due-items").find((item) => item.id === proposal.data.dueItemId)?.customerId === due.customerId) continue;
    proposal.status = "superseded";
    proposal.data.supersededReason = "Superseded: Finance identified another customer as the payer.";
    touch(proposal, ctx.now);
  }
  touch(payment, ctx.now);
}

/**
 * Decision on a payer identified through a wrong match: once a precision
 * review (or a rejection) has taken the allocation that identified the payer
 * (payerIdentification.allocationId) out of use and nothing of the payment
 * stays applied, the identification is withdrawn. The payment has no payer
 * again, so Finance can apply it to its real payer's instalment, and the
 * withdrawn identification stays in payerIdentificationHistory with who
 * withdrew it, when and why. A proposal of the payment for that customer,
 * which rested on the identification, is withdrawn with it. A payer its
 * evidence named, one that evidence resolved to the payment since names (the
 * evidence confirms Finance's identification), or money that went back, keeps
 * its payer. Returns the customer the identification named, or undefined when
 * it stands.
 */
export function withdrawPayerIdentification(state: DomainState, ctx: Context, payment: TypedRecord<"payments">, reason: string): string | undefined {
  const identification = payment.data.payerIdentification;
  if (!identification || identification.customerId !== payment.customerId || paymentReturned(payment) || Number(payment.data.allocatedKobo || 0) > 0) return undefined;
  const allocations = recordsWhere(state, "allocations", "data.paymentId", payment.id);
  if (allocations.some((item) => item.status === "confirmed") || allocations.find((item) => item.id === identification.allocationId)?.status !== "superseded") return undefined;
  // Evidence of the payment that names the payer confirms it, whoever identified it first.
  if (recordsOf(state, "observations").some((item) => item.status === "resolved" && item.data.paymentId === payment.id && item.customerId === identification.customerId)) return undefined;
  const history = Array.isArray(payment.data.payerIdentificationHistory) ? payment.data.payerIdentificationHistory : [];
  payment.data.payerIdentificationHistory = [...history, { ...identification, withdrawnBy: ctx.actor, withdrawnAt: ctx.now, withdrawnReason: reason }];
  delete payment.data.payerIdentification;
  payment.customerId = "";
  touch(payment, ctx.now);
  const proposals = allocations.filter((item) => item.status === "proposed" && item.customerId === identification.customerId);
  for (const proposal of proposals) {
    proposal.status = "superseded";
    proposal.data.supersededReason = "Superseded: the payer Finance identified was withdrawn.";
    touch(proposal, ctx.now);
  }
  if (proposals.length) settlePaymentStatus(state, ctx, payment);
  return identification.customerId;
}

/**
 * Reversed or refunded money went back to the payer: no proposal, confirmation
 * or manual allocation may apply it. After a refund of part of a payment, such
 * as an overpayment's excess, only the money that stayed can be applied.
 * Instalments are owed in naira, so money in another currency is never applied.
 */
function assertPaymentAllocatable(state: DomainState, payment: TypedRecord<"payments">, amount: number): void {
  if (paymentNeedsReversalReview(state, payment)) throw Object.assign(new Error("This payment is held for renewed Finance review of an earlier reversal decision. Resolve that review and run reconciliation before allocating it."), { status: 409 });
  if (currencyOf(payment) !== "NGN") {
    throw Object.assign(new Error(`Payment ${payment.reference} is in ${currencyOf(payment)}. Instalments are owed in naira, so it cannot be applied to one. Record its refund or resolve it with Finance.`), { status: 409 });
  }
  if (paymentReturned(payment)) {
    const how = paymentReversed(payment) ? "reversed by the provider" : "refunded to the payer";
    throw Object.assign(new Error(`Payment ${payment.reference} was ${how}. Its money went back, so it cannot be allocated to an instalment.`), { status: 409 });
  }
  const refunded = paymentRefundedKobo(payment), left = paymentUnappliedKobo(payment);
  if (refunded > 0 && amount > left) {
    throw Object.assign(new Error(`Payment ${payment.reference} was refunded to the payer in part: ${nairaText(refunded)} went back, so ${left > 0 ? `only ${nairaText(left)} is` : "nothing is"} left to allocate to an instalment.`), { status: 409 });
  }
}

function assertAllocationEligible(state: DomainState, due: TypedRecord<'due-items'>): void {
  if (dueNeedsReversalReview(state, due)) throw Object.assign(new Error("This instalment is held for renewed Finance review of an earlier reversal decision. Resolve that review and run reconciliation before allocating a payment."), { status: 409 });
  if ((allocationClosedStatuses as readonly string[]).includes(due.status)) throw Object.assign(new Error('This instalment is cancelled, closed or in dispute. Refresh the queue and review its status before allocating a payment.'), { status: 409 });
}

/**
 * Applies an allocation. For a payment whose evidence named no payer,
 * `payerReason` is Finance's reason, and applying it identifies the payer.
 */
export function applyConfirmedAllocation(state: DomainState, ctx: Context, allocation: TypedRecord<"allocations">, payerReason?: string): void {
  const payment = recordById(state, String(allocation.data.paymentId), "payments");
  const due = recordById(state, String(allocation.data.dueItemId), "due-items");
  assertAllocationEligible(state, due);
  assertPaymentAllocatable(state, payment, allocation.amountKobo);
  assertSamePayer(state, payment, due, { automatic: allocation.data.automatic === true, reason: payerReason });
  if (allocation.status === "superseded") throw new Error("This allocation is no longer applied and cannot be confirmed. Review the payment to create a new match.");
  if (allocation.status === "confirmed") throw Object.assign(new Error("This allocation is already applied. Refresh the payment to see its current position."), { status: 409 });
  const amount = allocation.amountKobo;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > paymentUnappliedKobo(payment)) {
    throw new Error("This allocation is more than the payment has left to allocate. Refresh the payment and review the proposed amount.");
  }
  if (amount > outstanding(due)) throw Object.assign(new Error("The proposed allocation exceeds the instalment balance now outstanding. Refresh the queue and review the changed balances."), { status: 409 });
  if (!payment.customerId) identifyPayer(state, ctx, payment, due, allocation, payerReason!);
  allocation.customerId = payment.customerId;
  allocation.status = "confirmed";
  allocation.data.confirmedAt ||= ctx.now;
  paymentDimensions(payment);
  payment.data.allocatedKobo = sumMoney([Number(payment.data.allocatedKobo || 0), amount]);
  const remaining = Math.max(0, outstanding(due) - amount);
  due.data.outstandingKobo = remaining;
  due.status = remaining === 0 ? "paid" : "partially_paid";
  const unapplied = paymentUnappliedKobo(payment);
  if (unapplied === 0) payment.status = "allocated";
  else if (remaining === 0) {
    // 7.3: the excess is unapplied credit on the customer position and an exception; never auto-applied elsewhere.
    payment.status = "overpaid";
    raiseException(state, ctx, "overpayment", { linkedRecordId: payment.id, customerId: payment.customerId, amountKobo: unapplied, notes: `${unapplied} kobo remains unapplied after due item ${due.reference} was settled.` });
  } else payment.status = "partial";
  if (!payment.data.proposedDueItemId || payment.data.proposedDueItemId === due.id) { delete payment.data.proposedDueItemId; delete payment.data.proposedAmountKobo; }
  touch(allocation, ctx.now); touch(payment, ctx.now); touch(due, ctx.now);
  if (remaining === 0) cancelUnsentAttempts(state, due.id, ctx.now);
  // Another proposal on the same payment either still fits what is left or is superseded now.
  settlePaymentStatus(state, ctx, payment);
}

/** REC-09: a wrong automatic allocation is superseded and the due item and payment are reopened. */
export function supersedeAllocation(state: DomainState, ctx: Context, allocation: TypedRecord<"allocations">, reason: string): void {
  if (allocation.status !== "confirmed") {
    // A proposal applied nothing; its payment is re-derived so it does not stay "proposed" with no proposal.
    allocation.status = "superseded"; allocation.data.supersededReason ||= reason; touch(allocation, ctx.now);
    settlePaymentStatus(state, ctx, findRecord(state, String(allocation.data.paymentId), "payments"));
    return;
  }
  const payment = findRecord(state, String(allocation.data.paymentId), "payments");
  const due = findRecord(state, String(allocation.data.dueItemId), "due-items");
  allocation.status = "superseded";
  allocation.data.supersededReason = reason;
  payment.data.allocatedKobo = Math.max(0, Number(payment.data.allocatedKobo || 0) - allocation.amountKobo);
  const restored = Math.min(due.amountKobo, sumMoney([outstanding(due), allocation.amountKobo]));
  due.data.outstandingKobo = restored;
  settleDueStatus(state, ctx, due, true);
  touch(allocation, ctx.now); touch(due, ctx.now);
  settlePaymentStatus(state, ctx, payment);
}

/**
 * Decision on leaving a dispute: a customer dispute resolved as not upheld,
 * or Finance's release with a reason, takes the instalment out of dispute.
 * Its status then follows its balance, as after any other change (paid,
 * part-paid, or scheduled or in collection by its attempts; the collections
 * queue reads overdue from the due date), and a paid one has its unsent
 * attempts cancelled. Decision on a dispute a reversal review's hold made
 * (statusHeldInDispute): its release returns the instalment to the status it
 * had before the hold, never to collection by default. The release is
 * recorded on the instalment with the last counted attempt, whose disputed
 * debit then does not freeze it again, and each open dispute exception for it
 * is closed as its condition cleared. Returns those exceptions.
 */
export function releaseDispute(state: DomainState, ctx: Context, due: TypedRecord<"due-items">, release: { via: "not_upheld" | "finance_release"; reason: string; exceptionId?: string }): TypedRecord<"exceptions">[] {
  if (dueNeedsReversalReview(state, due)) throw Object.assign(new Error("Resolve the renewed reversal review and run reconciliation before releasing this instalment."), { status: 409 });
  if (due.status !== "in_dispute") throw Object.assign(new Error(`Instalment ${due.reference} is not in dispute, so there is nothing to release. Refresh it to see its current status.`), { status: 409 });
  const status = statusHeldInDispute(state, due) ?? balanceStatus(state, due);
  delete due.data.legacyReversalReviewPause;
  due.status = status;
  if (status === "paid") cancelUnsentAttempts(state, due.id, ctx.now);
  due.data.disputeRelease = {
    via: release.via, releasedAt: ctx.now, releasedBy: ctx.actor, reason: release.reason, ...(release.exceptionId ? { exceptionId: release.exceptionId } : {}),
    attemptId: countedAttempts(state, due.id).at(-1)?.id ?? null, status, outstandingKobo: outstanding(due),
  };
  touch(due, ctx.now);
  const disputes = recordsOf(state, "exceptions").filter((item) => isOpenException(item.status) && item.data.linkedRecordId === due.id && resolveExceptionType(item.data.type) === "customer_dispute");
  disputes.forEach((item) => closeClearedException(item, ctx, `instalment ${due.reference} left dispute`));
  return disputes;
}

/**
 * Decision on reversals: money that went back after it was applied leaves its
 * instalment owing that amount again, in dispute, and a customer_dispute
 * exception names the reversal so someone owns the instalment. One already
 * open for it gains the reversal as a dated line and the amount now owed.
 */
function disputeReversal(state: DomainState, ctx: Context, due: TypedRecord<"due-items">, payment: TypedRecord<"payments">, appliedKobo: number, how: string): void {
  if (due.status !== "in_dispute") { due.status = "in_dispute"; touch(due, ctx.now); }
  const notes = `Payment ${payment.reference} (${nairaText(appliedKobo)} applied to instalment ${due.reference}) was reversed: ${how}. The instalment owes ${nairaText(outstanding(due))} again and is in dispute, so collection and allocation are paused. Find out why the money went back, then resolve this exception as not upheld to collect the instalment again, or ask Finance to release it from dispute with a reason.`;
  const exception = raiseException(state, ctx, "customer_dispute", { linkedRecordId: due.id, customerId: due.customerId, amountKobo: outstanding(due), notes });
  if (exception.data.notes === notes) return;
  exception.amountKobo = outstanding(due);
  noteUpdate(exception, ctx, notes);
}

/** The reason a precision review records when it takes a match out of use; older records carry only this text. */
export const REVIEW_SUPERSESSION = "Precision audit marked this allocation wrong";

/** True when a precision review, not a reversal or a rejected proposal, took this allocation out of use. */
export function supersededByReview(allocation: TypedRecord<"allocations">): boolean {
  return allocation.status === "superseded" && (allocation.data.supersededByReview === true || String(allocation.data.supersededReason || "").startsWith(REVIEW_SUPERSESSION));
}

/**
 * REC-09: a match a review had marked wrong is reviewed as correct, so it is
 * applied again, provided the payment still holds that money and the
 * instalment still owes it, and the payment is not now recorded as another
 * customer's. Otherwise the verdict is refused, because a "correct" match
 * that is not applied would misstate the false-match rate. A payment whose
 * identified payer was withdrawn with the match has its payer identified
 * again by it, for the reviewer's reason.
 */
export function reinstateAllocation(state: DomainState, ctx: Context, allocation: TypedRecord<"allocations">, reason: string): void {
  const payment = findRecord(state, String(allocation.data.paymentId), "payments");
  const due = findRecord(state, String(allocation.data.dueItemId), "due-items");
  const left = paymentUnappliedKobo(payment);
  const blocker = paymentReturned(payment) ? `payment ${payment.reference} was ${paymentReversed(payment) ? "reversed" : "refunded"}`
    : ["cancelled", "closed", "in_dispute"].includes(due.status) ? `instalment ${due.reference} is ${due.status.replace(/_/g, " ")}`
    : payment.customerId && payment.customerId !== due.customerId ? `payment ${payment.reference} is now recorded as another customer's`
    : allocation.amountKobo > left ? `payment ${payment.reference} no longer has that much left to allocate`
    : allocation.amountKobo > outstanding(due) ? `instalment ${due.reference} no longer has that much outstanding`
    : null;
  if (blocker) throw Object.assign(new Error(`This match cannot be applied again because ${blocker}. Allocate the payment manually if it belongs to an instalment.`), { status: 409 });
  forgetRejectedMatch(payment, due.id);
  delete allocation.data.supersededReason; delete allocation.data.supersededByReview;
  allocation.data.reinstatedAt = ctx.now;
  allocation.status = "proposed"; // applyConfirmedAllocation applies an allocation that is not yet applied
  applyConfirmedAllocation(state, ctx, allocation, reason);
}

/**
 * Re-derives a payment's allocation status from its own records after a
 * proposal, allocation, refund or reversal changes it. A payment with money
 * applied is never "unallocated"; one whose money went back is "returned"; a
 * held possible duplicate keeps its hold. A proposal that no longer fits what
 * the payment has left is superseded here, rather than failing a later close.
 */
export function settlePaymentStatus(state: DomainState, ctx: Context, payment: TypedRecord<"payments">, reason = "Superseded: the proposal no longer fits what the payment has left."): void {
  paymentDimensions(payment);
  const allocated = Number(payment.data.allocatedKobo || 0);
  // What it still holds: a refund of part of it, such as an overpayment's excess, is not left to allocate.
  const left = paymentUnappliedKobo(payment);
  const returned = paymentReturned(payment);
  const proposals = recordsWhere(state, "allocations", "data.paymentId", payment.id).filter((item) => item.status === "proposed");
  for (const proposal of proposals) {
    if (!returned && proposal.amountKobo <= left) continue;
    proposal.status = "superseded";
    proposal.data.supersededReason = reason;
    touch(proposal, ctx.now);
  }
  const live = proposals.find((item) => item.status === "proposed");
  const previous = payment.status;
  if (previous === "possible_duplicate" && allocated === 0 && !returned) return;
  if (live) {
    payment.status = "proposed";
    payment.data.proposedDueItemId = String(live.data.dueItemId);
    payment.data.proposedAmountKobo = live.amountKobo;
  } else {
    delete payment.data.proposedDueItemId; delete payment.data.proposedAmountKobo;
    if (allocated === 0) payment.status = returned ? "returned" : "unallocated";
    // Refunded after part of it was applied: the rest went back, so what stayed is all applied.
    else if (left <= 0) payment.status = "allocated";
    else payment.status = previous === "overpaid" ? "overpaid" : "partial";
  }
  touch(payment, ctx.now);
}

/**
 * Records a refund made outside Valo Pay: it returns what the payment has not
 * applied, and data.refundedKobo keeps that amount for billing and reports. A
 * caller that returns applied money, such as the pay-by-bank refund, takes the
 * allocations off their instalments first, so the whole receipt is recorded.
 */
export function recordPaymentRefund(state: DomainState, ctx: Context, payment: TypedRecord<"payments">, reason: string): number {
  paymentDimensions(payment);
  const refundedKobo = Math.max(0, payment.amountKobo - Number(payment.data.allocatedKobo || 0));
  payment.data.refundStatus = "refunded";
  payment.data.refundedKobo = refundedKobo;
  touch(payment, ctx.now);
  // Its money went back: open proposals are withdrawn and the payment leaves the allocation queues.
  settlePaymentStatus(state, ctx, payment, reason);
  return refundedKobo;
}

/**
 * ING-05: Finance resolved a suspected duplicate as "distinct_payments": the
 * payment it held is money of its own. It leaves the hold now, and the rule
 * ladder matches it from the next reconciliation without holding it again for
 * the same reason. A confirmed duplicate stays held until its refund is
 * recorded. Evidence held because it conflicts with the payment its reference
 * names becomes a payment of its own at the next reconciliation instead
 * (canonicalPayment). Returns the payment released, if any.
 */
export function releaseDuplicateHold(state: DomainState, ctx: Context, exception: TypedRecord<"exceptions">): TypedRecord<"payments"> | undefined {
  if (exception.data.resolutionCode !== "distinct_payments") return undefined;
  const payment = recordsOf(state, "payments").find((item) => item.id === exception.data.linkedRecordId);
  if (!payment) return undefined;
  payment.data.duplicateReview = { exceptionId: exception.id, resolutionCode: "distinct_payments", reviewedBy: ctx.actor, reviewedAt: ctx.now };
  if (payment.status === "possible_duplicate") {
    payment.status = "unallocated";
    payment.data.explanation = "Finance resolved the suspected duplicate as a separate payment, so it is no longer held.";
    settlePaymentStatus(state, ctx, payment);
  }
  touch(payment, ctx.now);
  return payment;
}

/** Finance said this payment does not belong to the instalment: automatic matching never proposes the pair again. */
export function rememberRejectedMatch(payment: TypedRecord<"payments">, dueItemId: unknown): void {
  if (typeof dueItemId !== "string" || !dueItemId) return;
  const rejected = new Set(Array.isArray(payment.data.rejectedDueItemIds) ? payment.data.rejectedDueItemIds.map(String) : []);
  rejected.add(dueItemId);
  payment.data.rejectedDueItemIds = [...rejected].sort();
}

/** A reversed rejection: Finance now says the pair was right. */
export function forgetRejectedMatch(payment: TypedRecord<"payments">, dueItemId: unknown): void {
  if (!Array.isArray(payment.data.rejectedDueItemIds)) return;
  const kept = payment.data.rejectedDueItemIds.map(String).filter((id) => id !== dueItemId);
  if (kept.length) payment.data.rejectedDueItemIds = kept; else delete payment.data.rejectedDueItemIds;
}

export const rejectedMatches = (payment: TypedRecord<"payments">): Set<string> => new Set(Array.isArray(payment.data.rejectedDueItemIds) ? payment.data.rejectedDueItemIds.map(String) : []);

/**
 * Payments whose status contradicts their records: "unallocated" with money
 * applied, "proposed" with no live proposal, money returned while still
 * waiting in an allocation queue, carrying a proposal, or shown as holding
 * unapplied money ("partial" or "overpaid" after a refund), or "returned"
 * while it holds money a refund of part of it did not return.
 */
export function paymentsToSettle(state: DomainState): TypedRecord<"payments">[] {
  const proposed = new Set(recordsOf(state, "allocations").filter((item) => item.status === "proposed").map((item) => String(item.data.paymentId)));
  return recordsOf(state, "payments").filter((payment) => {
    if (paymentReturned(payment)) return ["unallocated", "proposed", "possible_duplicate", "partial", "overpaid"].includes(payment.status) || proposed.has(payment.id);
    if (payment.status === "returned") return true;
    if (payment.status === "unallocated") return Number(payment.data.allocatedKobo || 0) > 0 || proposed.has(payment.id);
    return payment.status === "proposed" && !proposed.has(payment.id);
  });
}

/**
 * A payment's money went back through a reversal, once: its confirmed
 * allocations are taken off their instalments, each of which owes that
 * amount again and is put in dispute with an exception (disputeReversal),
 * and the payment leaves every allocation queue. `reason` supersedes the
 * allocations and proposals; `how` says who reported the reversal.
 */
export function reversePayment(state: DomainState, ctx: Context, payment: TypedRecord<"payments">, reason = "Payment reversed by the provider.", how = "the provider reported it"): void {
  if (payment.data.reversalApplied) return;
  payment.data.reversalStatus = "reversed";
  payment.data.reversedAt = ctx.now;
  payment.data.reversalApplied = true;
  recordsOf(state, "allocations").filter((item) => item.data.paymentId === payment.id && item.status === "confirmed").forEach((allocation) => {
    const due = findRecord(state, String(allocation.data.dueItemId), "due-items");
    due.data.outstandingKobo = Math.min(due.amountKobo, sumMoney([outstanding(due), allocation.amountKobo]));
    allocation.status = "superseded";
    allocation.data.supersededReason = reason;
    touch(allocation, ctx.now); touch(due, ctx.now);
    disputeReversal(state, ctx, due, payment, allocation.amountKobo, how);
  });
  payment.data.allocatedKobo = 0;
  // Proposals on reversed money are superseded and the payment leaves every unallocated queue.
  settlePaymentStatus(state, ctx, payment, reason);
}
