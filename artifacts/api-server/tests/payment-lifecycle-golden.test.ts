// Golden tests for the payment and exception rules corrected after the
// September 2026 audit: money that went back to the payer, payment status
// after a stale or rejected proposal, precision reviews that stick,
// exception resolutions that hold across daily closes, and an instalment's
// status after its amount is edited.
import assert from "node:assert/strict";
import { addAttempt, addObservation, ctxAt, liveFixture, outstandingOf, wat } from "./helpers.js";
import { allocatePayment, amendDueItem, reconcile } from "../src/domain/reconciliation.js";
import { executeAction } from "../src/domain/actions.js";
import { positionFor } from "../src/domain/close.js";
import { countedAttempts, evaluateRetry } from "../src/domain/policy-engine.js";
import { precisionAudit } from "../src/domain/reports.js";
import { makeRecord, recordsOf } from "../src/domain/records.js";
import { seedMerchant } from "../src/lib/valopay-seed.js";
import type { DomainState, TypedRecord } from "../src/domain/types.js";
import { paymentMoneyReturned, paymentUnappliedKobo } from "@workspace/valopay-schema";

const { assertFinalState } = await import("../src/lib/valopay-store.js");
let checks = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks += 1; };
const equal = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); checks += 1; };
const refused = (action: () => unknown, pattern: RegExp, status: number | undefined, message: string) => {
  assert.throws(action, (error: any) => pattern.test(error.message) && error.status === status, message);
  checks += 1;
};
const invariant = (state: DomainState) => { assert.doesNotThrow(() => assertFinalState({ merchant: structuredClone(state.merchant), settings: {}, records: [] }, state, state.merchant.id)); checks += 1; };
const finance = (now: string) => ctxAt(now, "Finance");
const operations = (now: string) => ctxAt(now, "Operations");
const GROSS = 2_500_000; // ₦25,000, the fixture instalment

const paymentByReference = (state: DomainState, reference: string) => recordsOf(state, "payments").find((item) => item.reference === reference)!;
const allocationsFor = (state: DomainState, payment: TypedRecord<"payments">) => recordsOf(state, "allocations").filter((item) => item.data.paymentId === payment.id);
const exceptionsFor = (state: DomainState, type: string, linkedRecordId: string) => recordsOf(state, "exceptions").filter((item) => item.data.type === type && item.data.linkedRecordId === linkedRecordId);
const resolve = (state: DomainState, exception: TypedRecord<"exceptions">, now: string, resolutionCode: string, data: Record<string, unknown> = {}) =>
  executeAction(state, operations(now), { action: "resolve_exception", recordId: exception.id, reason: "Checked with the provider and the lender.", data: { resolutionCode, ...data } });
/** A transfer from the fixture customer that R5 proposes against the fixture instalment. */
function proposedTransfer(state: DomainState, due: TypedRecord<"due-items">, reference: string, at = "2027-07-01T09:00:00") {
  due.data.dueDate = "2027-07-01";
  addObservation(state, { reference, amountKobo: GROSS, source: "transfer", customerId: due.customerId, eventId: `obs-${reference}`, occurredAt: wat(at) });
  reconcile(state, finance(wat(at.replace(/:00$/, ":05"))));
  const payment = paymentByReference(state, reference);
  const proposal = allocationsFor(state, payment).find((item) => item.status === "proposed")!;
  return { payment, proposal };
}
function secondInstalment(state: DomainState, due: TypedRecord<"due-items">, amountKobo = GROSS, dueDate = "2027-08-01") {
  return makeRecord(state, "due-items", {
    name: "Ngozi Eze · instalment 6", status: "scheduled", customerId: due.customerId, amountKobo, reference: "DEMO-LOAN-2006",
    data: { dueDate, mandateId: due.data.mandateId, owner: "lms", outstandingKobo: amountKobo },
  });
}

// ---------- Item 1: a reversed payment leaves every allocation path, queue and balance ----------
{
  const { state, due } = liveFixture({ withFailure: false, merchantId: "returned-reversal" });
  const { payment, proposal } = proposedTransfer(state, due, "TRF-REV");
  // What Finance's screen shows of the proposal before the reversal withdraws it.
  const seen = { proposalId: proposal.id, proposalUpdatedAt: proposal.updatedAt };
  equal([payment.status, proposal.status, proposal.data.rule], ["proposed", "proposed", "R5"], "R5 proposes the transfer for Finance");
  addObservation(state, { reference: "TRF-REV", amountKobo: GROSS, source: "webhook", customerId: due.customerId, eventId: "rev", occurredAt: wat("2027-07-02T09:00:00"), reversed: true });
  reconcile(state, finance(wat("2027-07-02T09:05:00")));
  equal(payment.status, "returned", "a reversed payment is returned, not unallocated");
  equal([proposal.status, proposal.data.supersededReason], ["superseded", "Payment reversed by the provider."], "its pending proposal is withdrawn with the reason");
  equal(payment.data.proposedDueItemId, undefined, "no proposal is shown on the payment");
  assert.throws(() => executeAction(state, finance(wat("2027-07-02T10:00:00")), { action: "confirm_allocation", recordId: payment.id, reason: "Stale screen", data: seen }), /This payment has no proposed match to review\. Reload the page to see its current status\./); checks += 1;
  refused(() => executeAction(state, finance(wat("2027-07-02T10:00:00")), { action: "manual_allocate", recordId: payment.id, reason: "By hand", data: { dueItemId: due.id, amountKobo: GROSS } }), /reversed by the provider\. Its money went back/, 409, "a reversed payment cannot be allocated by hand");
  refused(() => executeAction(state, finance(wat("2027-07-02T10:00:00")), { action: "record_refund", recordId: payment.id, reason: "Refunded", data: { reference: "RF-REV" } }), /already went back/, 409, "a reversed payment cannot also be refunded");
  equal(positionFor(state, due.customerId).unallocatedKobo, 0, "reversed money is not customer credit");
  equal([outstandingOf(due), due.status], [GROSS, "scheduled"], "the instalment still owes everything");
  const week = reconcile(state, finance(wat("2027-07-09T09:05:00")));
  equal(exceptionsFor(state, "unallocated_payment", payment.id).length, 0, "no unallocated-payment exception for money that went back");
  check(!recordsOf(state, "payments").some((item) => item.id === payment.id && item.status === "unallocated"), "it never counts as unallocated in a close");
  equal(week.data.unallocated, recordsOf(state, "payments").filter((item) => item.status === "unallocated").length, "the close counts only payments waiting for Finance");
  invariant(state);
}

// ---------- Item 1: a refund returns the whole payment; it is refused where it would contradict the records ----------
{
  const { state, due } = liveFixture({ withFailure: false, merchantId: "returned-refund" });
  due.data.dueDate = "2027-07-20";
  addObservation(state, { reference: "TRF-ODD", amountKobo: 1_234_500, source: "transfer", customerId: due.customerId, eventId: "odd", occurredAt: wat("2027-07-01T09:00:00") });
  reconcile(state, finance(wat("2027-07-01T09:05:00")));
  const payment = paymentByReference(state, "TRF-ODD");
  equal(payment.status, "unallocated", "an amount that fits no instalment waits for Finance");
  equal(positionFor(state, due.customerId).unallocatedKobo, 1_234_500, "while it waits, it is the customer's credit");
  executeAction(state, finance(wat("2027-07-01T11:00:00")), { action: "record_refund", recordId: payment.id, reason: "Returned to the payer", data: { reference: "RF-ODD-1" } });
  equal([payment.status, payment.data.refundStatus], ["returned", "refunded"], "a recorded refund returns the payment");
  equal(payment.data.refundedKobo, 1_234_500, "the refund records the amount that went back");
  equal(positionFor(state, due.customerId).unallocatedKobo, 0, "refunded money is not customer credit");
  refused(() => executeAction(state, finance(wat("2027-07-01T12:00:00")), { action: "record_refund", recordId: payment.id, reason: "Again", data: { reference: "RF-ODD-2" } }), /already recorded/, 409, "one refund per payment");
  // A new instalment for exactly that amount appears; R5 must not propose the refunded money against it.
  secondInstalment(state, due, 1_234_500, "2027-07-02");
  reconcile(state, finance(wat("2027-07-03T09:05:00")));
  equal(allocationsFor(state, payment).length, 0, "refunded money is never proposed");
  equal(exceptionsFor(state, "unallocated_payment", payment.id).length, 0, "and never ages into an unallocated-payment exception");
  // An overpayment's excess is refunded: the applied money stays on its instalment, and only the excess goes back.
  addObservation(state, { reference: "TRF-OVER", amountKobo: 3_000_000, source: "transfer", customerId: due.customerId, eventId: "over", occurredAt: wat("2027-07-03T09:00:00") });
  reconcile(state, finance(wat("2027-07-03T09:05:00")));
  const over = paymentByReference(state, "TRF-OVER");
  executeAction(state, finance(wat("2027-07-03T10:00:00")), { action: "manual_allocate", recordId: over.id, reason: "Customer paid instalment 5 with extra", data: { dueItemId: due.id, amountKobo: GROSS } });
  equal([over.status, due.status, positionFor(state, due.customerId).unallocatedKobo], ["overpaid", "paid", 500_000], "the excess is the customer's credit until it is refunded");
  const refundedExcess = executeAction(state, finance(wat("2027-07-03T11:00:00")), { action: "record_refund", recordId: over.id, reason: "Excess returned to the payer", data: { reference: "RF-OVER" } });
  equal(refundedExcess.message, "External refund of ₦5,000.00 recorded: the money this payment had not allocated. Valo Pay did not move any money.", "the amount reads like the other money in the API");
  equal([over.status, over.data.refundStatus, over.data.allocatedKobo], ["allocated", "refunded", GROSS], "the refund returns the excess; what was applied stays applied");
  equal(over.data.refundedKobo, 500_000, "only the excess is recorded as refunded");
  equal([due.status, allocationsFor(state, over).map((item) => item.status)], ["paid", ["confirmed"]], "the instalment stays paid by the money that stayed");
  equal(positionFor(state, due.customerId).unallocatedKobo, 0, "the refunded excess is no longer credit");
  refused(() => executeAction(state, finance(wat("2027-07-03T12:00:00")), { action: "manual_allocate", recordId: over.id, reason: "Apply the rest", data: { dueItemId: recordsOf(state, "due-items").find((item) => item.reference === "DEMO-LOAN-2006")!.id, amountKobo: 500_000 } }), /Payment TRF-OVER was refunded to the payer in part: ₦5,000\.00 went back, so nothing is left to allocate/, 409, "the refunded excess cannot be allocated");
  // The match is then found wrong. The ₦25,000 that stayed never went back: it is the customer's credit again, and Finance may allocate it.
  const [overMatch] = allocationsFor(state, over);
  executeAction(state, finance(wat("2027-07-04T09:00:00")), { action: "review_allocation", recordId: overMatch!.id, reason: "Wrong loan", data: { correct: false } });
  equal([over.status, over.data.allocatedKobo, over.data.refundedKobo, over.data.refundStatus], ["unallocated", 0, 500_000, "refunded"], "only the excess went back, so the payment waits for Finance with the rest");
  equal([paymentMoneyReturned(over), paymentUnappliedKobo(over), positionFor(state, due.customerId).unallocatedKobo], [false, GROSS, GROSS], "what the refund did not return is credit and can be allocated");
  // An instalment for the gross ₦30,000, due the next day, is what R5 would propose if it read the payment as whole.
  const third = makeRecord(state, "due-items", { name: "Ngozi Eze · instalment 7", status: "scheduled", customerId: due.customerId, amountKobo: 3_000_000, reference: "DEMO-LOAN-2007", data: { dueDate: "2027-07-04", mandateId: due.data.mandateId, owner: "lms", outstandingKobo: 3_000_000 } });
  const closed = executeAction(state, finance(wat("2027-07-05T07:00:00")), { action: "daily_close" }).record!;
  equal([over.status, allocationsFor(state, over).filter((item) => item.status === "proposed").length, closed.data.report.reconciliation.paymentsSkipped], ["unallocated", 0, 0], "automatic matching, which reads the gross amount, leaves it for Finance without failing");
  equal(over.data.explanation, "A refund returned ₦5,000.00 of this payment. Automatic matching leaves the ₦25,000.00 it still holds for Finance to allocate.", "and says why");
  const waiting = recordsOf(state, "payments").filter((item) => item.status === "unallocated" && item.id !== over.id).reduce((sum, item) => sum + item.amountKobo, 0);
  equal([closed.data.report.unallocated.kobo, exceptionsFor(state, "unallocated_payment", over.id).map((item) => item.amountKobo)], [waiting + GROSS, [GROSS]], "the close and its exception count the NGN 25,000 it holds, not the NGN 30,000 received");
  refused(() => executeAction(state, finance(wat("2027-07-05T09:30:00")), { action: "record_refund", recordId: over.id, reason: "Again", data: { reference: "RF-OVER-2" } }), /already recorded/, 409, "one refund per payment, even when the payment holds money again");
  refused(() => executeAction(state, finance(wat("2027-07-05T10:00:00")), { action: "manual_allocate", recordId: over.id, reason: "Whole receipt", data: { dueItemId: third.id, amountKobo: 3_000_000 } }), /in part: ₦5,000\.00 went back, so only ₦25,000\.00 is left to allocate/, 409, "the refunded part still cannot be allocated");
  // The overpayment exception closed when its excess was refunded: its condition cleared (console decision on exceptions).
  equal([exceptionsFor(state, "overpayment", over.id)[0]!.status, exceptionsFor(state, "overpayment", over.id)[0]!.data.resolutionCode], ["closed", "condition_cleared"], "the refunded excess closed its overpayment exception");
  // Finance applies what stayed: it settles instalment 6 and the rest is an overpayment of what the payment still holds.
  const sixth = recordsOf(state, "due-items").find((item) => item.reference === "DEMO-LOAN-2006")!;
  executeAction(state, finance(wat("2027-07-05T10:05:00")), { action: "manual_allocate", recordId: over.id, reason: "Right loan", data: { dueItemId: sixth.id, amountKobo: 1_234_500 } });
  const overpayment = exceptionsFor(state, "overpayment", over.id).at(-1)!;
  equal([over.status, sixth.status, overpayment.amountKobo, positionFor(state, due.customerId).unallocatedKobo], ["overpaid", "paid", 1_265_500, 1_265_500], "the overpayment is the NGN 12,655 left, not the refunded NGN 5,000 as well");
  executeAction(state, finance(wat("2027-07-05T10:10:00")), { action: "manual_allocate", recordId: over.id, reason: "Rest to the next loan", data: { dueItemId: third.id, amountKobo: 1_265_500 } });
  equal([over.status, over.data.allocatedKobo, outstandingOf(third), third.status, positionFor(state, due.customerId).unallocatedKobo], ["allocated", GROSS, 1_734_500, "partially_paid", 0], "what stayed is all applied again, and the payment has nothing left");
  invariant(state);
}
{
  // A refund recorded before its amount was kept is read as the whole payment: after its match is found wrong, nothing is left.
  const { state, due } = liveFixture({ withFailure: false, merchantId: "legacy-refund" });
  const legacy = makeRecord(state, "payments", { name: "legacy", status: "allocated", reference: "LEG-REFUND", customerId: due.customerId, amountKobo: 3_000_000, data: { allocatedKobo: GROSS, observedAt: wat("2027-07-01T09:00:00"), channel: "transfer", refundStatus: "refunded" } });
  const match = makeRecord(state, "allocations", { name: "Allocation R7", status: "confirmed", customerId: due.customerId, amountKobo: GROSS, data: { paymentId: legacy.id, dueItemId: due.id, rule: "R7", confidence: "manual", automatic: false, reviewed: null } });
  due.data.outstandingKobo = 0; due.status = "paid";
  equal([paymentMoneyReturned(legacy), paymentUnappliedKobo(legacy)], [true, 0], "a refund with no recorded amount returned the whole payment");
  executeAction(state, finance(wat("2027-07-02T09:00:00")), { action: "review_allocation", recordId: match.id, reason: "Wrong loan", data: { correct: false } });
  equal([legacy.status, paymentUnappliedKobo(legacy), positionFor(state, due.customerId).unallocatedKobo], ["returned", 0, 0], "so its money is not credit once the match is superseded");
  refused(() => executeAction(state, finance(wat("2027-07-02T10:00:00")), { action: "manual_allocate", recordId: legacy.id, reason: "By hand", data: { dueItemId: due.id, amountKobo: GROSS } }), /refunded to the payer\. Its money went back/, 409, "and it cannot be allocated");
  // A refund whose recorded amount covers the whole payment reads the same.
  const whole = makeRecord(state, "payments", { name: "whole", status: "returned", reference: "WHOLE-REFUND", customerId: due.customerId, amountKobo: 700_000, data: { allocatedKobo: 0, observedAt: wat("2027-07-01T09:00:00"), channel: "transfer", refundStatus: "refunded", refundedKobo: 700_000 } });
  equal([paymentMoneyReturned(whole), paymentUnappliedKobo(whole)], [true, 0], "a refund of the whole amount returned the payment");
  invariant(state);
}

// ---------- Item 2: a stale proposal is withdrawn when Finance allocates the money elsewhere, and every later close completes ----------
{
  const { state, due } = liveFixture({ withFailure: false, merchantId: "stale-proposal" });
  const second = secondInstalment(state, due);
  const { payment, proposal } = proposedTransfer(state, due, "TRF-STALE");
  const seen = { proposalId: proposal.id, proposalUpdatedAt: proposal.updatedAt };
  executeAction(state, finance(wat("2027-07-01T11:00:00")), { action: "manual_allocate", recordId: payment.id, reason: "Customer asked for instalment 6", data: { dueItemId: second.id, amountKobo: GROSS } });
  equal([payment.status, payment.data.allocatedKobo], ["allocated", GROSS], "the payment is fully applied to the instalment Finance chose");
  equal([proposal.status, payment.data.proposedDueItemId], ["superseded", undefined], "the proposal that no longer fits is withdrawn");
  refused(() => executeAction(state, finance(wat("2027-07-01T11:02:00")), { action: "record_refund", recordId: payment.id, reason: "Returned", data: { reference: "RF-STALE" } }), /nothing unapplied to refund/, 409, "a payment whose money is all applied has nothing a refund recorded here can return");
  equal([payment.status, payment.data.refundStatus, payment.data.refundedKobo], ["allocated", "none", undefined], "and the refused refund records nothing");
  assert.throws(() => executeAction(state, finance(wat("2027-07-01T11:05:00")), { action: "reject_allocation", recordId: payment.id, reason: "Old screen", data: seen }), /This payment has no proposed match to review\. Reload the page to see its current status\./); checks += 1;
  for (const day of ["2027-07-02", "2027-07-03"]) reconcile(state, finance(wat(`${day}T07:00:00`)));
  equal([payment.status, allocationsFor(state, payment).filter((item) => item.status === "confirmed").length], ["allocated", 1], "later closes leave the applied payment alone");
  invariant(state);
}
{
  // A proposal that still fits what is left stays live; rejecting it keeps the money already applied.
  const { state, due } = liveFixture({ withFailure: false, merchantId: "partial-proposal" });
  const second = secondInstalment(state, due);
  const payment = makeRecord(state, "payments", { name: "Canonical payment", status: "unallocated", reference: "TRF-SPLIT", customerId: due.customerId, amountKobo: 4_000_000, data: { allocatedKobo: 0, observedAt: wat("2027-07-01T09:00:00"), channel: "transfer" } });
  const ctx = finance(wat("2027-07-01T09:05:00"));
  const proposal = allocatePayment(state, ctx, payment, due, GROSS, "R5", "probable", false);
  executeAction(state, finance(wat("2027-07-01T10:00:00")), { action: "manual_allocate", recordId: payment.id, reason: "Part for instalment 6", data: { dueItemId: second.id, amountKobo: 1_000_000 } });
  equal([proposal.status, payment.status, payment.data.proposedDueItemId], ["proposed", "proposed", due.id], "the proposal still fits the ₦30,000 left, so it stays for Finance");
  executeAction(state, finance(wat("2027-07-01T11:00:00")), { action: "reject_allocation", recordId: payment.id, reason: "Not this instalment", data: { proposalId: proposal.id, proposalUpdatedAt: proposal.updatedAt } });
  equal([payment.status, payment.data.allocatedKobo], ["partial", 1_000_000], "rejecting the proposal keeps the part already applied");
  const next = reconcile(state, finance(wat("2027-07-02T07:00:00")));
  equal([payment.status, next.data.paymentsSkipped], ["partial", 0], "the next close completes and leaves it alone");
  invariant(state);
}
{
  // Statuses left by earlier builds are re-derived before the rule ladder runs.
  const { state, due } = liveFixture({ withFailure: false, merchantId: "repaired-statuses" });
  const applied = makeRecord(state, "payments", { name: "legacy", status: "unallocated", reference: "LEG-APPLIED", customerId: due.customerId, amountKobo: GROSS, data: { allocatedKobo: GROSS, observedAt: wat("2027-07-01T09:00:00"), channel: "transfer" } });
  makeRecord(state, "allocations", { name: "Allocation R7", status: "confirmed", customerId: due.customerId, amountKobo: GROSS, data: { paymentId: applied.id, dueItemId: due.id, rule: "R7", confidence: "manual", automatic: false, reviewed: null } });
  due.data.outstandingKobo = 0; due.status = "paid";
  const stuck = makeRecord(state, "payments", { name: "legacy", status: "proposed", reference: "LEG-STUCK", customerId: due.customerId, amountKobo: 777_700, data: { allocatedKobo: 0, observedAt: wat("2027-07-01T09:00:00"), channel: "transfer", proposedDueItemId: due.id } });
  const reversed = makeRecord(state, "payments", { name: "legacy", status: "unallocated", reference: "LEG-REVERSED", customerId: due.customerId, amountKobo: 500_000, data: { allocatedKobo: 0, observedAt: wat("2027-07-01T09:00:00"), channel: "transfer", reversalStatus: "reversed" } });
  // An overpayment whose excess an earlier build recorded as refunded, in the legacy spelling, still showed as holding it.
  const second = secondInstalment(state, due);
  const refundedExcess = makeRecord(state, "payments", { name: "legacy", status: "overpaid", reference: "LEG-REFUNDED", customerId: due.customerId, amountKobo: 3_000_000, data: { allocatedKobo: GROSS, observedAt: wat("2027-07-01T09:00:00"), channel: "transfer" } });
  Object.assign(refundedExcess.data, { refundStatus: "recorded_externally" });
  makeRecord(state, "allocations", { name: "Allocation R7", status: "confirmed", customerId: due.customerId, amountKobo: GROSS, data: { paymentId: refundedExcess.id, dueItemId: second.id, rule: "R7", confidence: "manual", automatic: false, reviewed: null } });
  second.data.outstandingKobo = 0; second.status = "paid";
  // Its excess was refunded and its match then superseded, when an earlier build read any refund as returning the whole payment.
  const heldBack = makeRecord(state, "payments", { name: "legacy", status: "returned", reference: "LEG-PART-REFUND", customerId: due.customerId, amountKobo: 3_000_000, data: { allocatedKobo: 0, observedAt: wat("2027-07-01T09:00:00"), channel: "transfer", refundStatus: "refunded", refundedKobo: 500_000 } });
  const run = reconcile(state, finance(wat("2027-07-02T07:00:00")));
  equal([applied.status, stuck.status, reversed.status, refundedExcess.status, heldBack.status], ["allocated", "unallocated", "returned", "allocated", "unallocated"], "each status now matches its records");
  equal(run.data.paymentStatusesRepaired, 5, "the close reports the repairs");
  equal(stuck.data.proposedDueItemId, undefined, "the dead proposal pointer is cleared");
  invariant(state);
}
{
  // A payment with nothing to allocate, as an earlier build made from a settlement line whose gross was 0, is left alone
  // (the review of the audit fixes): the ladder never tries it, so no exception opens and closes at every close.
  const { state, due } = liveFixture({ withFailure: false, merchantId: "isolated-payment" });
  const zero = makeRecord(state, "payments", { name: "Canonical payment", status: "unallocated", reference: "ZERO-1", customerId: due.customerId, amountKobo: 0, data: { allocatedKobo: 0, observedAt: wat("2027-07-01T09:00:00"), channel: "transfer", virtualAccountCustomerId: due.customerId } });
  const quiet = reconcile(state, finance(wat("2027-07-01T09:05:00")));
  equal([quiet.data.paymentsSkipped, zero.data.explanation, recordsOf(state, "exceptions").filter((item) => item.data.linkedRecordId === zero.id).length], [0, undefined, 0], "a payment with nothing unapplied is not matched, skipped or raised");
  // One payment the ladder cannot apply, such as a corrupt row whose amount is not whole kobo, is left for Finance with the reason; the close still completes.
  const odd = makeRecord(state, "payments", { name: "Canonical payment", status: "unallocated", reference: "ODD-1", customerId: due.customerId, data: { allocatedKobo: 0, observedAt: wat("2027-07-01T09:00:00"), channel: "transfer", virtualAccountCustomerId: due.customerId } });
  odd.amountKobo = 1.5;
  const run = reconcile(state, finance(wat("2027-07-01T09:10:00")));
  equal(run.data.paymentsSkipped, 1, "the close completes and counts the skipped payment");
  check(String(odd.data.explanation).startsWith("Automatic matching left this payment for Finance: "), "the payment says why it was left");
  const updatedAt = odd.updatedAt;
  reconcile(state, finance(wat("2027-07-02T09:05:00")));
  equal(odd.updatedAt, updatedAt, "an unchanged reason is not rewritten at every close");
}

// ---------- Item 3: "Mark incorrect" sticks across closes, and "Mark correct" applies the same match again ----------
{
  const { state, due } = liveFixture({ withFailure: false, merchantId: "precision-sticks" });
  addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-06-30T06:20:00"), providerReference: "PSK-7" });
  addObservation(state, { reference: "PSK-7", amountKobo: GROSS, source: "webhook", customerId: due.customerId, eventId: "w7", occurredAt: wat("2027-06-30T06:20:00") });
  reconcile(state, finance(wat("2027-06-30T07:00:00")));
  const payment = paymentByReference(state, "PSK-7");
  const allocation = allocationsFor(state, payment).find((item) => item.status === "confirmed")!;
  equal([allocation.data.rule, allocation.data.automatic, allocation.data.confidence], ["R1", true, "certain"], "an automatic certain match");
  refused(() => executeAction(state, finance(wat("2027-07-05T09:00:00")), { action: "review_allocation", recordId: allocation.id, reason: "Right loan", data: { correct: "yes" } }), /Choose whether the allocation is correct/, undefined, "the verdict is a boolean");
  executeAction(state, finance(wat("2027-07-05T09:00:00")), { action: "review_allocation", recordId: allocation.id, reason: "Wrong loan", data: { correct: false } });
  equal([allocation.status, allocation.data.supersededByReview, payment.data.rejectedDueItemIds], ["superseded", true, [due.id]], "the review takes the match out of use and remembers the pair");
  for (const day of ["2027-07-06", "2027-07-07", "2027-07-08"]) reconcile(state, finance(wat(`${day}T07:00:00`)));
  equal(allocationsFor(state, payment).length, 1, "the next closes do not recreate the match");
  equal([payment.status, outstandingOf(due)], ["unallocated", GROSS], "payment and instalment stay open for Finance");
  check(String(payment.data.explanation).includes(`does not belong to instalment ${due.reference}`), "the payment says why it is not matched");
  equal(exceptionsFor(state, "unallocated_payment", payment.id).length, 1, "and ages into Finance's queue like any unallocated payment");
  equal(precisionAudit(state, wat("2027-07-08T10:00:00")).wrong, 1, "June's audit counts one wrong match");
  // Finance changes its verdict: the same allocation is applied again.
  const reinstated = executeAction(state, finance(wat("2027-07-08T11:00:00")), { action: "review_allocation", recordId: allocation.id, reason: "Checked the loan agreement again", data: { correct: true } });
  equal(reinstated.message, "Allocation reviewed as correct and applied again.", "the result says the match is applied");
  equal([allocation.status, allocation.data.reviewed, allocation.data.supersededByReview, allocation.data.supersededReason], ["confirmed", true, undefined, undefined], "the same allocation is confirmed again");
  equal(allocation.data.reinstatedAt, wat("2027-07-08T11:00:00"), "with the time it was applied again");
  equal([payment.status, payment.data.allocatedKobo, payment.data.rejectedDueItemIds], ["allocated", GROSS, undefined], "the payment is applied and the pair forgiven");
  equal([due.status, outstandingOf(due)], ["paid", 0], "the instalment is paid again");
  const audit = precisionAudit(state, wat("2027-07-08T12:00:00"));
  equal([audit.reviewed, audit.wrong, audit.falseMatchRate], [1, 0, 0], "a correct verdict is counted only for a match that is applied");
  invariant(state);
}
{
  // "Mark correct" is refused, with nothing changed, once the money has moved on.
  const { state, due } = liveFixture({ withFailure: false, merchantId: "precision-moved-on" });
  const second = secondInstalment(state, due);
  addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-06-30T06:20:00"), providerReference: "PSK-8" });
  addObservation(state, { reference: "PSK-8", amountKobo: GROSS, source: "webhook", customerId: due.customerId, eventId: "w8", occurredAt: wat("2027-06-30T06:20:00") });
  reconcile(state, finance(wat("2027-06-30T07:00:00")));
  const payment = paymentByReference(state, "PSK-8");
  const allocation = allocationsFor(state, payment).find((item) => item.status === "confirmed")!;
  executeAction(state, finance(wat("2027-07-05T09:00:00")), { action: "review_allocation", recordId: allocation.id, reason: "Wrong loan", data: { correct: false } });
  executeAction(state, finance(wat("2027-07-05T10:00:00")), { action: "manual_allocate", recordId: payment.id, reason: "Belongs to instalment 6", data: { dueItemId: second.id, amountKobo: GROSS } });
  const before = structuredClone(state);
  refused(() => executeAction(state, finance(wat("2027-07-05T11:00:00")), { action: "review_allocation", recordId: allocation.id, reason: "Changed my mind", data: { correct: true } }), /cannot be applied again because payment PSK-8 no longer has that much left/, 409, "the verdict is refused while the payment is applied elsewhere");
  equal(state, before, "and nothing changed");
  // A proposal is decided by confirming or rejecting it, not by an accuracy review.
  const proposalState = liveFixture({ withFailure: false, merchantId: "review-proposal" });
  const { proposal } = proposedTransfer(proposalState.state, proposalState.due, "TRF-REVIEW");
  refused(() => executeAction(proposalState.state, finance(wat("2027-07-01T11:00:00")), { action: "review_allocation", recordId: proposal.id, reason: "Looks wrong", data: { correct: false } }), /still a proposal/, 409, "a proposal cannot be reviewed into a dead end");
  equal(proposal.status, "proposed", "the proposal is untouched");
}
{
  // A rejected proposal is not proposed again; Finance's own allocation to that instalment still works.
  const { state, due } = liveFixture({ withFailure: false, merchantId: "rejection-sticks" });
  const { payment, proposal } = proposedTransfer(state, due, "TRF-REJ");
  executeAction(state, finance(wat("2027-07-01T11:00:00")), { action: "reject_allocation", recordId: payment.id, reason: "Different customer loan", data: { proposalId: proposal.id, proposalUpdatedAt: proposal.updatedAt } });
  equal([payment.status, payment.data.rejectedDueItemIds], ["unallocated", [due.id]], "the payment waits for Finance and remembers the rejection");
  reconcile(state, finance(wat("2027-07-02T07:00:00")));
  equal(allocationsFor(state, payment).length, 1, "the rejected pair is not proposed again");
  executeAction(state, finance(wat("2027-07-02T09:00:00")), { action: "manual_allocate", recordId: payment.id, reason: "Customer confirmed it is this instalment", data: { dueItemId: due.id, amountKobo: GROSS } });
  equal([payment.status, payment.data.rejectedDueItemIds, due.status], ["allocated", undefined, "paid"], "a manual allocation outranks the earlier rejection");
  invariant(state);
}

// ---------- Item 4: resolutions hold across closes while the condition is unchanged ----------
{
  const state = seedMerchant("durable-unallocated");
  const seeded = paymentByReference(state, "SBX-UNIDENTIFIED-001");
  const seededException = exceptionsFor(state, "unallocated_payment", seeded.id)[0]!;
  resolve(state, seededException, wat("2027-07-01T09:00:00"), "not_ours");
  const fresh = makeRecord(state, "payments", { name: "Canonical payment", status: "unallocated", reference: "TRF-AGED", amountKobo: 999_900, data: { allocatedKobo: 0, observedAt: wat("2027-06-29T09:00:00"), channel: "transfer" } });
  reconcile(state, finance(wat("2027-07-01T10:00:00")));
  const aged = exceptionsFor(state, "unallocated_payment", fresh.id);
  equal([aged.length, aged[0]!.data.condition], [1, `unallocated_payment:${fresh.id}`], "an aged payment raises one exception carrying its condition");
  resolve(state, aged[0]!, wat("2027-07-01T11:00:00"), "held_credit");
  for (const day of ["2027-07-02", "2027-07-05", "2027-07-06"]) reconcile(state, finance(wat(`${day}T07:00:00`)));
  equal(exceptionsFor(state, "unallocated_payment", fresh.id).length, 1, "held as credit: not raised again at later closes");
  equal(exceptionsFor(state, "unallocated_payment", seeded.id).length, 1, "a resolution recorded before conditions existed also holds");
  check(!recordsOf(state, "exceptions").some((item) => item.data.type === "unallocated_payment" && item.status === "open" && [seeded.id, fresh.id].includes(String(item.data.linkedRecordId))), "nothing is open again");
}
{
  const { state, due } = liveFixture({ withFailure: false, merchantId: "durable-variance" });
  addObservation(state, { reference: "L1", amountKobo: GROSS - 30_000, grossAmountKobo: GROSS, feeKobo: 30_000, batchReference: "B-VAR", source: "settlement", customerId: due.customerId, dueItemId: due.id, eventId: "l1", occurredAt: wat("2027-07-01T07:00:00") });
  reconcile(state, finance(wat("2027-07-01T07:05:00")));
  const batch = recordsOf(state, "settlement-batches").find((item) => item.reference === "B-VAR")!;
  const [variance] = exceptionsFor(state, "settlement_variance", batch.id);
  resolve(state, variance!, wat("2027-07-01T09:00:00"), "accepted_variance");
  reconcile(state, finance(wat("2027-07-02T07:05:00")));
  reconcile(state, finance(wat("2027-07-05T07:05:00")));
  equal(exceptionsFor(state, "settlement_variance", batch.id).length, 1, "an accepted variance is not raised again");
  // Another line changes the batch's fees: that is a different variance and new work.
  const other = recordsOf(state, "due-items").find((item) => item.customerId !== due.customerId && item.status === "scheduled" && item.amountKobo === 6_000_000)!;
  addObservation(state, { reference: "L2", amountKobo: 6_000_000 - 90_000, grossAmountKobo: 6_000_000, feeKobo: 90_000, batchReference: "B-VAR", source: "settlement", customerId: other.customerId, dueItemId: other.id, eventId: "l2", occurredAt: wat("2027-07-06T07:00:00") });
  reconcile(state, finance(wat("2027-07-06T07:05:00")));
  const variances = exceptionsFor(state, "settlement_variance", batch.id);
  equal([variances.length, variances.at(-1)!.status], [2, "open"], "a changed fee variance raises a new exception");
}
{
  // A fee variance accepted once holds whether it was raised before or after the statement credit matched the batch net.
  for (const statementFirst of [true, false]) {
    const { state, due } = liveFixture({ withFailure: false, merchantId: `durable-variance-statement-${statementFirst}` });
    const statement = () => addObservation(state, { reference: "STMT-FEE", amountKobo: GROSS - 30_000, batchReference: "B-FEE-STMT", source: "statement", eventId: "st", occurredAt: wat("2027-07-01T08:00:00") });
    addObservation(state, { reference: "L1", amountKobo: GROSS - 30_000, grossAmountKobo: GROSS, feeKobo: 30_000, batchReference: "B-FEE-STMT", source: "settlement", customerId: due.customerId, dueItemId: due.id, eventId: "l1", occurredAt: wat("2027-07-01T07:00:00") });
    if (statementFirst) statement();
    reconcile(state, finance(wat("2027-07-01T09:00:00")));
    const batch = recordsOf(state, "settlement-batches").find((item) => item.reference === "B-FEE-STMT")!;
    const [variance] = exceptionsFor(state, "settlement_variance", batch.id);
    resolve(state, variance!, wat("2027-07-01T10:00:00"), "accepted_variance");
    if (!statementFirst) statement();
    reconcile(state, finance(wat("2027-07-02T07:05:00")));
    reconcile(state, finance(wat("2027-07-05T07:05:00")));
    equal([batch.status, batch.data.statementNetKobo], ["variance", GROSS - 30_000], `the statement matched the net but the fees still differ (${statementFirst ? "statement first" : "fees first"})`);
    equal(exceptionsFor(state, "settlement_variance", batch.id).length, 1, `the accepted fee variance is not raised again (${statementFirst ? "statement first" : "fees first"})`);
  }
}
{
  // Resolutions stored before the batch evaluator: an earlier build keyed a variance found when the statement credit was linked on
  // the statement (settlement_variance:<batch>:statement:<credit>:<net>:<fees>), and one found by the fee check on the fees
  // (settlement_variance:<batch>:fees:<fees>:<expected fees>). Accepted under either spelling, the variance is not raised again.
  for (const spelling of ["statement", "fees"] as const) {
    const { state, due } = liveFixture({ withFailure: false, merchantId: `stored-variance-${spelling}` });
    addObservation(state, { reference: "L1", amountKobo: GROSS - 30_000, grossAmountKobo: GROSS, feeKobo: 30_000, batchReference: "B-STORED", source: "settlement", customerId: due.customerId, dueItemId: due.id, eventId: "l1", occurredAt: wat("2027-07-01T07:00:00") });
    addObservation(state, { reference: "STMT-STORED", amountKobo: GROSS - 30_000, batchReference: "B-STORED", source: "statement", eventId: "st", occurredAt: wat("2027-07-01T08:00:00") });
    reconcile(state, finance(wat("2027-07-01T09:00:00")));
    const batch = recordsOf(state, "settlement-batches").find((item) => item.reference === "B-STORED")!;
    const [stored] = exceptionsFor(state, "settlement_variance", batch.id);
    stored!.data.condition = spelling === "statement" ? `settlement_variance:${batch.id}:statement:2470000:2470000:30000` : `settlement_variance:${batch.id}:fees:30000:12500`;
    resolve(state, stored!, wat("2027-07-01T10:00:00"), "accepted_variance");
    reconcile(state, finance(wat("2027-07-02T07:05:00")));
    reconcile(state, finance(wat("2027-07-05T07:05:00")));
    equal([batch.status, batch.data.statementNetKobo, batch.data.netKobo, batch.data.feeVarianceKobo], ["variance", 2_470_000, 2_470_000, 17_500], `the credit matches the net and only the fees differ (${spelling} spelling)`);
    equal(exceptionsFor(state, "settlement_variance", batch.id).length, 1, `a variance accepted under the ${spelling} spelling is not raised again`);
  }
}
{
  const { state, due } = liveFixture({ withFailure: false, merchantId: "durable-mapping" });
  const attempt = addAttempt(state, due, { status: "failed", failureCode: "R42", occurredAt: wat("2027-06-28T06:16:00") });
  attempt.data.rawFailureCode = "R42";
  reconcile(state, finance(wat("2027-06-28T08:00:00")));
  const [mapping] = exceptionsFor(state, "mapping_needed", attempt.id);
  equal(mapping!.data.condition, `mapping_needed:${attempt.id}:R42`, "the condition names the unmapped provider code");
  resolve(state, mapping!, wat("2027-06-28T09:00:00"), "mapped_to_code");
  reconcile(state, finance(wat("2027-06-29T08:00:00")));
  equal(exceptionsFor(state, "mapping_needed", attempt.id).length, 1, "a classified code is not raised again");
}
{
  const { state, due } = liveFixture({ merchantId: "durable-notice" });
  reconcile(state, finance(wat("2027-06-29T06:17:00")));
  const [notice] = exceptionsFor(state, "notice_not_evidenced", due.id);
  const failed = countedAttempts(state, due.id).at(-1)!;
  equal(notice!.data.condition, `notice_not_evidenced:${due.id}:${failed.id}`, "the condition is the failed attempt whose notice was missing");
  resolve(state, notice!, wat("2027-06-29T09:00:00"), "channel_restored");
  reconcile(state, finance(wat("2027-06-30T08:00:00")));
  reconcile(state, finance(wat("2027-07-01T08:00:00")));
  equal(exceptionsFor(state, "notice_not_evidenced", due.id).length, 1, "the deferral of the same attempt is not raised again");
}

// ---------- Item 4: an unknown outcome's resolution becomes the attempt's outcome ----------
{
  const { state, due, policy } = liveFixture({ withFailure: false, merchantId: "unknown-failed" });
  executeAction(state, operations(wat("2027-06-28T06:16:00")), { action: "simulate_failure", recordId: due.id, reason: "Provider timed out", data: { failureCode: "TIMEOUT_UNKNOWN" } });
  const attempt = recordsOf(state, "attempts").find((item) => item.data.dueItemId === due.id)!;
  reconcile(state, finance(wat("2027-06-29T06:17:00")));
  const [unknown] = exceptionsFor(state, "unknown_outcome", attempt.id);
  equal(evaluateRetry(state, finance(wat("2027-06-29T07:00:00")), due, policy).rule, "in_flight", "while unknown, the instalment waits");
  refused(() => executeAction(state, operations(wat("2027-06-29T07:00:00")), { action: "simulate_failure", recordId: due.id, reason: "Another", data: { failureCode: "INSUFFICIENT_FUNDS" } }), /unknown outcome/, undefined, "and no further attempt is recorded");
  // The confirmed code is checked before anything is recorded.
  refused(() => resolve(state, unknown!, wat("2027-06-29T08:00:00"), "resolved_succeeded", { confirmedFailureCode: "INSUFFICIENT_FUNDS" }), /Leave the failure code blank unless you resolve an unknown outcome as ‘Confirmed failed’\./, undefined, "a code needs a failed outcome");
  refused(() => resolve(state, unknown!, wat("2027-06-29T08:00:00"), "resolved_failed", { confirmedFailureCode: "TIMEOUT_UNKNOWN" }), /Choose the failure code the provider confirmed/, undefined, "the timeout is not a confirmed code");
  equal(unknown!.status, "open", "a refused resolution records nothing");
  const resolved = resolve(state, unknown!, wat("2027-06-29T08:00:00"), "resolved_failed", { confirmedFailureCode: "INSUFFICIENT_FUNDS" });
  equal(resolved.message, "Exception resolution recorded. The collection attempt is now recorded as failed.", "the result names the attempt's new outcome");
  equal([attempt.status, attempt.data.failureCode, attempt.data.rawFailureCode, unknown!.data.confirmedFailureCode], ["failed", "INSUFFICIENT_FUNDS", "INSUFFICIENT_FUNDS", "INSUFFICIENT_FUNDS"], "the attempt takes the confirmed outcome");
  equal([attempt.data.outcomeConfirmation?.previousStatus, attempt.data.outcomeConfirmation?.previousFailureCode, attempt.data.outcomeConfirmation?.previousRawFailureCode, attempt.data.outcomeConfirmation?.exceptionId], ["unknown", "TIMEOUT_UNKNOWN", "TIMEOUT_UNKNOWN", unknown!.id], "what it showed before, including the provider's raw code, is kept on it");
  check(evaluateRetry(state, finance(wat("2027-06-29T09:00:00")), due, policy).rule !== "in_flight", "the instalment no longer waits as in flight");
  reconcile(state, finance(wat("2027-06-30T07:00:00")));
  equal([exceptionsFor(state, "unknown_outcome", attempt.id).length, exceptionsFor(state, "mapping_needed", attempt.id).length], [1, 0], "no repeat, and no mapping exception for the confirmed code");
  executeAction(state, operations(wat("2027-07-02T06:16:00")), { action: "simulate_failure", recordId: due.id, reason: "Next attempt failed", data: { failureCode: "INSUFFICIENT_FUNDS" } });
  equal(recordsOf(state, "attempts").filter((item) => item.data.dueItemId === due.id).length, 2, "a later attempt can be recorded");
  invariant(state);
}
{
  for (const [code, status] of [["resolved_failed", "failed"], ["resolved_succeeded", "succeeded"], ["provider_confirmed_no_debit", "cancelled"]] as const) {
    const { state, due } = liveFixture({ withFailure: false, merchantId: `unknown-${code}` });
    const attempt = addAttempt(state, due, { status: "unknown", failureCode: "TIMEOUT_UNKNOWN", occurredAt: wat("2027-06-28T06:16:00") });
    attempt.data.rawFailureCode = "TIMEOUT_UNKNOWN";
    reconcile(state, finance(wat("2027-06-29T06:17:00")));
    resolve(state, exceptionsFor(state, "unknown_outcome", attempt.id)[0]!, wat("2027-06-29T08:00:00"), code);
    equal(attempt.status, status, `${code} records the attempt as ${status}`);
    if (status === "failed") equal([attempt.data.failureCode, attempt.data.rawFailureCode], ["UNKNOWN", undefined], "a failure without a code is unclassified, which is never retried");
    else equal(attempt.data.failureCode, undefined, "no failure code remains on an attempt that did not fail");
    if (status === "cancelled") equal(countedAttempts(state, due.id).length, 0, "a debit that never happened does not count toward the ceiling");
    reconcile(state, finance(wat("2027-06-30T07:00:00")));
    equal([exceptionsFor(state, "unknown_outcome", attempt.id).length, exceptionsFor(state, "mapping_needed", attempt.id).length], [1, 0], `${code}: nothing is raised again`);
  }
}
{
  // Resolutions recorded before this change are applied by the next close.
  const { state, due } = liveFixture({ withFailure: false, merchantId: "unknown-legacy" });
  const attempt = addAttempt(state, due, { status: "unknown", failureCode: "TIMEOUT_UNKNOWN", occurredAt: wat("2027-06-28T06:16:00") });
  // The earlier build raised the exception again after it was resolved, so an attempt can carry two resolutions: the latest stands.
  const legacy = (resolutionCode: string, resolvedAt: string) => makeRecord(state, "exceptions", { name: "Unknown outcome", status: "resolved", customerId: due.customerId, data: { type: "unknown_outcome", severity: "high", owner: "Operations", linkedRecordId: attempt.id, resolutionCode, resolvedBy: "Sandbox Operations", resolvedAt: wat(resolvedAt), notes: "Earlier build" } });
  legacy("resolved_succeeded", "2027-06-29T08:00:00");
  legacy("provider_confirmed_no_debit", "2027-06-30T08:00:00");
  const run = reconcile(state, finance(wat("2027-07-01T07:00:00")));
  equal([attempt.status, run.data.attemptOutcomesConfirmed], ["cancelled", 1], "the latest recorded resolution is applied to the attempt");
  equal(exceptionsFor(state, "unknown_outcome", attempt.id).length, 2, "and no new exception is raised");
  equal(reconcile(state, finance(wat("2027-07-02T07:00:00"))).data.attemptOutcomesConfirmed, 0, "a later close has nothing left to apply");
  invariant(state);
}

// ---------- Item 13: an instalment's status follows its balance after an amount edit ----------
/** The store's check on a save, against the state as it was loaded. */
const saved = (loaded: DomainState, state: DomainState) => { assert.doesNotThrow(() => assertFinalState(loaded, state, state.merchant.id)); checks += 1; };
const dueByReference = (state: DomainState, reference: string) => recordsOf(state, "due-items").find((item) => item.reference === reference)!;
/** Finance applies a transfer of this amount to the instalment. */
function manualTransfer(state: DomainState, due: TypedRecord<"due-items">, reference: string, amountKobo: number, at: string) {
  const payment = makeRecord(state, "payments", { name: "Canonical payment", status: "unallocated", reference, customerId: due.customerId, amountKobo, data: { allocatedKobo: 0, observedAt: at, channel: "transfer" } });
  executeAction(state, finance(at), { action: "manual_allocate", recordId: payment.id, reason: "Customer confirmed the instalment", data: { dueItemId: due.id, amountKobo } });
}
{
  const state = seedMerchant("due-edits");
  const at = wat("2027-07-01T09:00:00");
  /** The record API's edit: the stored record with the changed fields, as PATCH /v1/records/due-items/:id builds it. */
  const edit = (due: TypedRecord<"due-items">, changes: { amountKobo?: number; name?: string }) =>
    amendDueItem(state, ctxAt(at, "Admin"), due, { ...due, ...changes, data: { ...due.data }, updatedAt: at });
  const paid = dueByReference(state, "DEMO-LOAN-1001"); // ₦25,000, paid in full by a confirmed allocation
  const partPaid = dueByReference(state, "DEMO-LOAN-1005"); // ₦25,000
  manualTransfer(state, partPaid, "TRF-PART", 1_000_000, at);
  const planned = addAttempt(state, partPaid, { status: "scheduled", occurredAt: wat("2027-07-03T07:00:00") });
  const collecting = dueByReference(state, "DEMO-LOAN-1004"); // ₦35,000, in collection after a failed attempt
  const untouched = dueByReference(state, "DEMO-LOAN-1006");
  const disputed = dueByReference(state, "DEMO-LOAN-1007");
  disputed.status = "in_dispute";
  const tunde = dueByReference(state, "DEMO-LOAN-1002");
  const final = makeRecord(state, "due-items", { name: "Túndé Bakare · instalment 9", status: "scheduled", customerId: tunde.customerId, amountKobo: 4_200_000, reference: "DEMO-LOAN-2009", data: { dueDate: "2027-06-01", mandateId: tunde.data.mandateId, owner: "lms", outstandingKobo: 4_200_000 } });
  manualTransfer(state, final, "TRF-FINAL", 1_500_000, at);
  final.status = "unpaid_final"; // the engine gave up after part of it was paid
  equal([paid.status, partPaid.status, partPaid.data.outstandingKobo], ["paid", "partially_paid", 1_500_000], "one instalment is paid and another part-paid by a ₦10,000 transfer");
  const loaded = structuredClone(state);

  edit(paid, { amountKobo: 3_000_000 });
  equal([paid.status, paid.data.outstandingKobo], ["partially_paid", 500_000], "a paid instalment raised to ₦30,000 owes ₦5,000 again and is part-paid");
  edit(paid, { amountKobo: GROSS });
  equal([paid.status, paid.data.outstandingKobo], ["paid", 0], "reduced back to what was paid, it is paid");
  refused(() => edit(paid, { amountKobo: 1_000_000 }), /below confirmed allocations/, undefined, "an amount below the confirmed allocations is still refused");
  edit(partPaid, { amountKobo: 1_000_000 });
  equal([partPaid.status, partPaid.data.outstandingKobo], ["paid", 0], "a part-paid instalment reduced to the amount paid is paid with nothing outstanding");
  equal(planned.status, "cancelled", "and its unsent attempt is cancelled, as when a payment settles it");
  edit(untouched, { name: "Dami Adéyẹmí · instalment 6 (renamed)" });
  equal([untouched.status, untouched.data.outstandingKobo], ["scheduled", 6_000_000], "an edit that leaves the balance whole keeps a scheduled instalment scheduled");
  edit(collecting, { amountKobo: 3_600_000 });
  equal([collecting.status, collecting.data.outstandingKobo], ["in_collection", 3_600_000], "an instalment in collection with nothing paid stays in collection when its amount changes");
  edit(disputed, { amountKobo: 3_000_000 });
  equal([disputed.status, disputed.data.outstandingKobo], ["in_dispute", 3_000_000], "a dispute is kept whatever the amount");
  edit(final, { amountKobo: 4_500_000 });
  equal([final.status, final.data.outstandingKobo], ["unpaid_final", 3_000_000], "a final failure is kept while money is still owed");
  edit(final, { amountKobo: 1_500_000 });
  equal([final.status, final.data.outstandingKobo], ["paid", 0], "and is paid once the edit leaves nothing outstanding");
  saved(loaded, state);
}
{
  // REC-09: marking a match wrong on an instalment the engine gave up on reopens it, since the money taken off it is owed again and the engine may collect it; an amount edit keeps the final failure, a review does not.
  const state = seedMerchant("final-reopened");
  const at = wat("2027-07-01T09:00:00");
  const tunde = dueByReference(state, "DEMO-LOAN-1002");
  const finalFailure = (reference: string, transfers: number[]) => {
    const due = makeRecord(state, "due-items", { name: `Túndé Bakare · ${reference}`, status: "scheduled", customerId: tunde.customerId, amountKobo: 4_200_000, reference, data: { dueDate: "2027-06-01", mandateId: tunde.data.mandateId, owner: "lms", outstandingKobo: 4_200_000 } });
    transfers.forEach((amountKobo, index) => manualTransfer(state, due, `TRF-${reference}-${index}`, amountKobo, at));
    due.status = "unpaid_final"; // the engine gave up after part of it was paid
    return { due, allocations: recordsOf(state, "allocations").filter((item) => item.status === "confirmed" && item.data.dueItemId === due.id) };
  };
  const once = finalFailure("DEMO-LOAN-2010", [1_500_000]);
  const twice = finalFailure("DEMO-LOAN-2011", [1_500_000, 1_000_000]);
  const loaded = structuredClone(state);
  const markWrong = (allocation: TypedRecord<"allocations">) => executeAction(state, finance(wat("2027-07-02T09:00:00")), { action: "review_allocation", recordId: allocation.id, reason: "Wrong loan", data: { correct: false } });
  markWrong(once.allocations[0]!);
  equal([once.due.status, once.due.data.outstandingKobo], ["scheduled", 4_200_000], "with its only payment taken back it owes the whole amount and is scheduled again");
  markWrong(twice.allocations[0]!);
  equal([twice.due.status, twice.due.data.outstandingKobo], ["partially_paid", 3_200_000], "with one of two payments taken back it is part-paid, not a final failure");
  saved(loaded, state);
}
{
  // Statuses an amount edit left behind before this rule are repaired by the next close, before the engine evaluates them.
  const state = seedMerchant("due-repair");
  const raised = dueByReference(state, "DEMO-LOAN-1002"); // paid ₦42,000, raised to ₦47,000 by an earlier build's edit
  raised.amountKobo = 4_700_000; raised.data.outstandingKobo = 500_000;
  const reduced = dueByReference(state, "DEMO-LOAN-1005"); // part-paid, then reduced to what was paid
  manualTransfer(state, reduced, "TRF-LEGACY", 1_000_000, wat("2027-07-01T09:00:00"));
  const planned = addAttempt(state, reduced, { status: "scheduled", occurredAt: wat("2027-07-03T07:00:00") });
  reduced.amountKobo = 1_000_000; reduced.data.outstandingKobo = 0;
  const unknown = dueByReference(state, "DEMO-LOAN-1006"); // no stored balance: the repair does not guess one
  delete unknown.data.outstandingKobo; unknown.status = "partially_paid";
  equal([raised.status, reduced.status], ["paid", "partially_paid"], "the stored statuses contradict the balances");
  const loaded = structuredClone(state);
  const run = reconcile(state, finance(wat("2027-07-02T07:00:00")));
  equal([raised.status, reduced.status, unknown.status], ["partially_paid", "paid", "partially_paid"], "each stored balance now decides its status");
  equal(planned.status, "cancelled", "the settled instalment's unsent attempt is cancelled");
  equal(run.data.dueStatusesRepaired, 2, "the close reports the repairs");
  saved(loaded, state);
  equal(reconcile(state, finance(wat("2027-07-03T07:00:00"))).data.dueStatusesRepaired, 0, "the next close has nothing left to repair");
}

console.log(`Payment lifecycle golden tests passed (${checks} checks): returned money, stale and rejected proposals, repaired statuses, isolated matching, precision reviews that stick and apply again, durable exception resolutions, confirmed unknown outcomes, and instalment statuses that follow their balance.`);
