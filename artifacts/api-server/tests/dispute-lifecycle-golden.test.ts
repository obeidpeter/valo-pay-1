// Golden tests for leaving a dispute, pay-by-bank outcomes that stay unknown
// and exceptions whose condition clears (23 September audit, items 3 and 10,
// decision 4 and the console's decision on exceptions left open). Every
// request runs as the store runs it: on a copy, with the repository's
// final-state check, and rolled back when it is refused.
import assert from "node:assert/strict";
import { HOUR, addAttempt, addObservation, ctxAt, liveFixture, outstandingOf, wat } from "./helpers.js";
import { amendDueItem, reconcile } from "../src/domain/reconciliation.js";
import { executeAction } from "../src/domain/actions.js";
import { makeRecord, recordsOf } from "../src/domain/records.js";
import { validateRecord } from "../src/domain/validation.js";
import { positionMismatches } from "../src/domain/close.js";
import { buildAlerts } from "../src/domain/alerts.js";
import { approvedPolicyFor, evaluateRetry } from "../src/domain/policy-engine.js";
import { connectedRevision, runConnectedAction, runConnectedActionWithNote } from "../src/domain/connected.js";
import { seedMerchant } from "../src/lib/valopay-seed.js";
import { isOpenException, paymentRefundedKobo, paymentUnappliedKobo } from "@workspace/valopay-schema";
import type { Context, DomainState, TypedRecord, ValopayRecord } from "../src/domain/types.js";

const { assertFinalState } = await import("../src/lib/valopay-store.js");
const finance = (now: string) => ctxAt(now, "Finance");
const operations = (now: string) => ctxAt(now, "Operations");
let checks = 0;
const failures: string[] = [];
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks += 1; };
const equal = <T>(actual: T, expected: T, message: string) => { assert.deepEqual(actual, expected, message); checks += 1; };

/** One finding's checks; a failure is reported with the others, so every finding is seen at once. */
function section(name: string, run: () => void) {
  try { run(); } catch (error) { failures.push(`${name}: ${(error as Error).message.split("\n")[0]}`); }
}

/**
 * A request as the store applies it: run on the lender, check the final state against the state before, and roll back
 * when refused. The rollback restores each record in place, so a test's references to records stay current.
 */
function request<T>(state: DomainState, run: () => T): { ok: true; value: T } | { ok: false; message: string; status?: number } {
  const before = structuredClone(state);
  try {
    const value = run();
    assertFinalState(structuredClone(before), state, state.merchant.id, new Date().toISOString());
    return { ok: true, value };
  } catch (error) {
    const live = new Map(state.records.map((record) => [record.id, record]));
    state.records.splice(0, state.records.length, ...before.records.map((saved) => {
      const record = live.get(saved.id);
      if (!record) return saved;
      for (const key of Object.keys(record)) delete (record as unknown as Record<string, unknown>)[key];
      return Object.assign(record, saved);
    }));
    state.settings = before.settings; state.merchant = before.merchant;
    return { ok: false, message: (error as Error).message, status: (error as { status?: number }).status };
  }
}
function accepted<T>(outcome: ReturnType<typeof request<T>>, label: string): T {
  if (!outcome.ok) assert.fail(`${label} was refused: ${outcome.message}`);
  checks += 1;
  return outcome.value;
}
function refused(outcome: ReturnType<typeof request<unknown>>, pattern: RegExp, status: number | undefined, label: string) {
  check(!outcome.ok && pattern.test(outcome.message) && outcome.status === status, `${label} (${outcome.ok ? "accepted" : `${outcome.status}: ${outcome.message}`})`);
}
/** Evidence as POST /v1/records/observations creates it: validated, unresolved, synthetic. */
function postObservation(state: DomainState, now: string, body: { reference: string; amountKobo: number; customerId?: string; data: Record<string, unknown> }) {
  const input: any = { ...body, name: body.reference, status: "unresolved", data: { ...body.data, synthetic: true }, createdAt: now, updatedAt: now };
  validateRecord(state, finance(now), "observations", input);
  return makeRecord(state, "observations", input) as TypedRecord<"observations">;
}
/** An instalment as POST /v1/records/due-items creates it. */
function postDue(state: DomainState, now: string, customerId: string, mandateId: string, reference: string, amountKobo: number, dueDate: string) {
  const input: any = { name: reference, reference, amountKobo, customerId, status: "scheduled", data: { dueDate, mandateId, owner: "lms", outstandingKobo: amountKobo, synthetic: true }, createdAt: now, updatedAt: now };
  validateRecord(state, ctxAt(now, "Admin"), "due-items", input);
  return makeRecord(state, "due-items", input) as TypedRecord<"due-items">;
}
const payment = (state: DomainState, reference: string) => recordsOf(state, "payments").find((item) => item.reference === reference)!;
const exceptionsFor = (state: DomainState, linkedRecordId: string, type?: string) => recordsOf(state, "exceptions").filter((item) => item.data.linkedRecordId === linkedRecordId && (!type || item.data.type === type));
const openExceptionsFor = (state: DomainState, linkedRecordId: string) => exceptionsFor(state, linkedRecordId).filter((item) => isOpenException(item.status));
const act = (state: DomainState, ctx: Context, action: string, recordId: string | undefined, reason: string, data: Record<string, unknown> = {}) =>
  request(state, () => executeAction(state, ctx, { action, recordId, reason, data }));
const close = (state: DomainState, at: string) => accepted(request(state, () => executeAction(state, finance(wat(at)), { action: "daily_close" })), `the daily close at ${at} WAT`);
/** A pay-by-bank step as POST /v1/connected/actions runs it, at the workspace's current revision. */
const connected = (state: DomainState, ctx: Context, action: string, recordId?: string, data: Record<string, unknown> = {}) =>
  request(state, () => runConnectedAction(state, ctx, { action, recordId, reason: `Sample step: ${action}`, expectedRevision: connectedRevision(state), data } as any) as ValopayRecord);
/** The same step with the note its audit entry adds to the reason, as the route records it. */
const connectedWithNote = (state: DomainState, ctx: Context, action: string, recordId?: string, data: Record<string, unknown> = {}) =>
  request(state, () => runConnectedActionWithNote(state, ctx, { action, recordId, reason: `Sample step: ${action}`, expectedRevision: connectedRevision(state), data } as any) as { result: ValopayRecord; auditNote?: string });
const intentOf = (state: DomainState, id: string) => recordsOf(state, "connected-intents").find((item) => item.id === id)!;
/** A checkout for the instalment, authorised and then given the outcome. */
function checkout(state: DomainState, due: TypedRecord<"due-items">, at: string, outcome: "confirmed" | "unknown" | "failed", amountKobo = outstandingOf(due)) {
  const ctx = operations(wat(at));
  const intent = accepted(connected(state, ctx, "payment.create", undefined, { dueItemId: due.id, amountKobo }), "the checkout");
  accepted(connected(state, ctx, "payment.authorise", intent.id), "its authorisation");
  accepted(connected(state, ctx, "payment.outcome", intent.id, { outcome }), `its ${outcome} outcome`);
  return intentOf(state, intent.id);
}

/** DEMO-LOAN-1005 paid by the debit PSK-REV-1, then reversed by the provider: the audit's scenario for item 3. */
function reversedInstalment(merchantId: string) {
  const { state, due, policy } = liveFixture({ withFailure: false, merchantId });
  const t0 = wat("2027-07-01T07:00:00");
  addAttempt(state, due, { status: "succeeded", occurredAt: t0, providerReference: "PSK-REV-1" });
  accepted(request(state, () => postObservation(state, t0, { reference: "PSK-REV-1", amountKobo: due.amountKobo, customerId: due.customerId, data: { source: "webhook", eventId: "w1", occurredAt: t0 } })), "the debit's webhook");
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T07:10:00")))), "the reconciliation of the debit");
  equal([due.status, outstandingOf(due)], ["paid", 0], "the debit pays the instalment");
  const t1 = wat("2027-07-03T09:00:00");
  accepted(request(state, () => postObservation(state, t1, { reference: "PSK-REV-1", amountKobo: due.amountKobo, customerId: due.customerId, data: { source: "webhook", eventId: "w1-reversal", reversed: true, occurredAt: t1 } })), "the reversal webhook");
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-03T09:10:00")))), "the reconciliation of the reversal");
  return { state, due, policy, dispute: exceptionsFor(state, due.id, "customer_dispute")[0] };
}

// ---------- Item 3: a reversal reopens the instalment in dispute, and someone owns it ----------
section("a provider reversal", () => {
  const { state, due, dispute } = reversedInstalment("reversal-dispute");
  equal([due.status, outstandingOf(due)], ["in_dispute", 2_500_000], "the reversal reopens the instalment in dispute with its balance owed again");
  check(dispute && isOpenException(dispute.status), "an exception is raised for the reopened instalment");
  equal([dispute!.data.owner, dispute!.amountKobo, dispute!.customerId], ["Operations", 2_500_000, due.customerId], "it has an owner, the amount owed and the customer");
  check(/PSK-REV-1/.test(String(dispute!.data.notes)) && /reversed/.test(String(dispute!.data.notes)) && /DEMO-LOAN-1005/.test(String(dispute!.data.notes)), `its notes name the reversed payment and the instalment (${dispute!.data.notes})`);
  close(state, "2027-07-04T07:00:00");
  equal(exceptionsFor(state, due.id, "customer_dispute").length, 1, "the next close does not raise it again");
});

section("resolving the dispute as not upheld", () => {
  const { state, due, policy, dispute } = reversedInstalment("not-upheld");
  // The customer repays by transfer while the instalment is in dispute: the money waits, and a manual allocation is refused.
  const t2 = wat("2027-07-04T09:00:00");
  accepted(request(state, () => postObservation(state, t2, { reference: "TRF-REPAY-1", amountKobo: due.amountKobo, customerId: due.customerId, data: { source: "transfer", eventId: "t-repay", narration: `repay ${due.reference}`, occurredAt: t2 } })), "the repayment");
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-04T09:10:00")))), "the reconciliation of the repayment");
  const repay = payment(state, "TRF-REPAY-1");
  equal(repay.status, "unallocated", "while the instalment is in dispute its repayment is not applied");
  refused(act(state, finance(wat("2027-07-04T10:00:00")), "manual_allocate", repay.id, "customer repaid", { dueItemId: due.id, amountKobo: due.amountKobo }), /in dispute/, 409, "nor can Finance apply it by hand");
  equal(evaluateRetry(state, finance(wat("2027-07-04T10:00:00")), due, policy).rule, "disputed", "and the engine pauses collection");
  // Operations resolves the dispute as not upheld: the instalment leaves dispute and its status follows its balance.
  const resolved = accepted(act(state, operations(wat("2027-07-04T11:00:00")), "resolve_exception", dispute!.id, "The provider confirmed the reversal was its own processing error; the customer owes the instalment.", { resolutionCode: "not_upheld" }), "the resolution as not upheld") as any;
  equal([dispute!.status, due.status, outstandingOf(due)], ["resolved", "in_collection", 2_500_000], "not upheld takes the instalment out of dispute: it owes the whole amount after its debit, so it is in collection");
  const release = due.data.disputeRelease as any;
  equal([release?.via, release?.exceptionId, release?.releasedBy, release?.status, release?.outstandingKobo], ["not_upheld", dispute!.id, "Sandbox Operations", "in_collection", 2_500_000], "the release is recorded on the instalment, with who and why");
  check(/DEMO-LOAN-1005/.test(resolved.message) && /out of dispute/.test(resolved.message), `the answer says where the instalment now stands (${resolved.message})`);
  check(/DEMO-LOAN-1005/.test(String(resolved.data.auditNote)) && /out of dispute/.test(String(resolved.data.auditNote)), `and the audit entry records it (${resolved.data.auditNote})`);
  check(evaluateRetry(state, finance(wat("2027-07-04T11:00:00")), due, policy).rule !== "disputed", "the engine no longer holds it as disputed");
  // The waiting repayment is applied at the next reconciliation.
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-04T11:10:00")))), "the next reconciliation");
  equal([repay.status, due.status, outstandingOf(due)], ["allocated", "paid", 0], "the repayment pays the instalment");
  close(state, "2027-07-05T07:00:00");
  equal([due.status, exceptionsFor(state, due.id, "customer_dispute").length], ["paid", 1], "and later closes leave it paid with no new dispute");
});

section("Finance releases an instalment from dispute with a reason", () => {
  const { state, due, dispute } = reversedInstalment("finance-release");
  const at = wat("2027-07-04T09:00:00");
  refused(act(state, operations(at), "release_dispute", due.id, "Operations tries to release it"), /Only Admin or Finance can release an instalment from dispute\./, 403, "Operations cannot release an instalment from dispute");
  refused(act(state, finance(at), "release_dispute", due.id, "  "), /reason/, undefined, "a release needs a reason");
  // Before the release, pay-by-bank refuses the instalment.
  refused(connected(state, operations(at), "payment.create", undefined, { dueItemId: due.id, amountKobo: due.amountKobo }), /open instalment/, 400, "pay-by-bank refuses an instalment in dispute");
  const released = accepted(act(state, finance(at), "release_dispute", due.id, "The provider withdrew the chargeback; the lender collects the instalment again."), "Finance's release") as any;
  equal([due.status, outstandingOf(due)], ["in_collection", 2_500_000], "the instalment leaves dispute and its status follows its balance");
  equal([due.data.disputeRelease?.via, due.data.disputeRelease?.releasedBy, due.data.disputeRelease?.reason], ["finance_release", "Sandbox Finance", "The provider withdrew the chargeback; the lender collects the instalment again."], "the release is recorded with who and why");
  equal([dispute!.status, dispute!.data.resolutionCode, dispute!.data.conditionCleared?.by], ["closed", "condition_cleared", "Sandbox Finance"], "the open dispute exception is closed because its condition cleared");
  check(/left dispute/.test(String(dispute!.data.conditionCleared?.reason)) && /Closed automatically on /.test(String(dispute!.data.notes)), `the exception says why it closed (${dispute!.data.conditionCleared?.reason})`);
  check(/released from dispute/.test(String(released.data.auditNote)) && /Closed 1 exception automatically, because its cause went away/.test(String(released.data.auditNote)), `the audit entry records the release and the closed exception (${released.data.auditNote})`);
  equal(released.data.dueStatus, "in_collection", "the answer carries the new status");
  refused(act(state, finance(at), "release_dispute", due.id, "Again"), /not in dispute/, 409, "an instalment not in dispute cannot be released");
  // Collection resumes: pay-by-bank takes a checkout, and Finance can apply a payment by hand.
  const intent = accepted(connected(state, operations(at), "payment.create", undefined, { dueItemId: due.id, amountKobo: due.amountKobo }), "a checkout after the release");
  accepted(connected(state, operations(at), "payment.cancel", intent.id), "its cancellation");
  addObservation(state, { reference: "TRF-REPAY-2", amountKobo: due.amountKobo, source: "transfer", customerId: due.customerId, eventId: "repay-2", occurredAt: at });
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-04T09:05:00")))), "the reconciliation of a transfer");
  const repay = payment(state, "TRF-REPAY-2");
  if (repay.status !== "allocated") accepted(act(state, finance(wat("2027-07-04T09:10:00")), "manual_allocate", repay.id, "The customer's repayment.", { dueItemId: due.id, amountKobo: due.amountKobo }), "Finance's allocation");
  equal([due.status, outstandingOf(due)], ["paid", 0], "and the repayment pays it");
  close(state, "2027-07-05T07:00:00");
  equal([dispute!.status, exceptionsFor(state, due.id, "customer_dispute").length], ["closed", 1], "the closed exception is never reopened or raised again");
  // An instalment an earlier build left in dispute with no exception is released the same way.
  const legacy = seedMerchant("legacy-dispute");
  const stuck = recordsOf(legacy, "due-items").find((item) => item.reference === "DEMO-LOAN-1006")!;
  stuck.status = "in_dispute";
  accepted(act(legacy, finance(at), "release_dispute", stuck.id, "Left in dispute by an earlier build with no exception."), "the release of a legacy dispute");
  equal(stuck.status, "scheduled", "it returns to scheduled: nothing is paid and no attempt was made");
});

section("a dispute resolved as upheld stays in dispute until Finance releases it", () => {
  const { state, due, dispute } = reversedInstalment("upheld");
  const resolved = accepted(act(state, operations(wat("2027-07-04T09:00:00")), "resolve_exception", dispute!.id, "The customer had already paid by transfer; the refund went back.", { resolutionCode: "upheld_refund" }), "the resolution as upheld") as any;
  equal([dispute!.status, due.status], ["resolved", "in_dispute"], "upheld keeps the instalment in dispute");
  check(/stays in dispute/.test(resolved.message) && /Finance/.test(resolved.message), `the answer says how it leaves dispute (${resolved.message})`);
  close(state, "2027-07-05T07:00:00");
  equal([due.status, exceptionsFor(state, due.id, "customer_dispute").length], ["in_dispute", 1], "a close neither releases it nor raises a second exception");
  accepted(act(state, finance(wat("2027-07-05T09:00:00")), "release_dispute", due.id, "The loan system rescheduled the instalment; collect it again."), "Finance's release");
  equal(due.status, "in_collection", "Finance's release takes it out of dispute");
});

section("a debit the customer disputed, once released, is not frozen again", () => {
  const { state, due, policy } = liveFixture({ merchantId: "customer-disputed", failureCode: "CUSTOMER_DISPUTED" });
  close(state, "2027-06-28T07:00:00");
  const [dispute] = exceptionsFor(state, due.id, "customer_dispute");
  equal([due.status, dispute?.status], ["in_dispute", "open"], "the disputed debit freezes the instalment with an exception");
  accepted(act(state, operations(wat("2027-06-28T09:00:00")), "resolve_exception", dispute!.id, "The mandate and notice were valid; the dispute is not upheld.", { resolutionCode: "not_upheld" }), "the resolution as not upheld");
  equal(due.status, "in_collection", "not upheld takes it out of dispute");
  for (const day of ["2027-06-29", "2027-06-30", "2027-07-01"]) close(state, `${day}T07:00:00`);
  equal([due.status, exceptionsFor(state, due.id, "customer_dispute").length], ["in_collection", 1], "later closes do not put it back in dispute for the same debit");
  const released = evaluateRetry(state, finance(wat("2027-07-01T08:00:00")), due, policy);
  equal([released.decision, released.rule], ["stop", "dispute_released"], "a disputed debit is still never retried automatically, and the engine records that its dispute is over");
  const recorded = recordsOf(state, "retry-decisions").filter((item) => item.data.dueItemId === due.id).at(-1);
  equal(recorded?.data.rule, "dispute_released", "so the customer's timeline no longer says collection is paused for a dispute");
  // A later debit the customer disputes again is a new dispute.
  addAttempt(state, due, { status: "failed", failureCode: "CUSTOMER_DISPUTED", occurredAt: wat("2027-07-02T06:16:00") });
  close(state, "2027-07-02T07:00:00");
  equal([due.status, exceptionsFor(state, due.id, "customer_dispute").filter((item) => isOpenException(item.status)).length], ["in_dispute", 1], "a new disputed debit freezes it again with a new exception");
});

section("an edit cannot rewrite a release", () => {
  const { state, due, dispute } = reversedInstalment("release-edit");
  accepted(act(state, operations(wat("2027-07-04T09:00:00")), "resolve_exception", dispute!.id, "Not upheld after review.", { resolutionCode: "not_upheld" }), "the resolution");
  const edited = structuredClone(due);
  (edited.data as any).disputeRelease = { ...(due.data.disputeRelease as object), attemptId: "someone-else" };
  refused(request(state, () => amendDueItem(state, ctxAt(wat("2027-07-04T10:00:00"), "Admin"), due, edited)), /Use Release from dispute to take an instalment out of dispute\./, undefined, "a direct edit of the recorded release is refused");
  const renamed = structuredClone(due);
  renamed.name = "Ngozi Eze · instalment 5 (renamed)";
  accepted(request(state, () => amendDueItem(state, ctxAt(wat("2027-07-04T10:00:00"), "Admin"), due, renamed)), "an edit that leaves the release alone");
});

// ---------- Decision 4: a pay-by-bank refund reopens the instalment without a dispute; a reversal disputes it ----------
section("pay-by-bank refunds and reversals", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "pay-by-bank-returns" });
  const first = checkout(state, due, "2027-07-01T09:00:00", "confirmed");
  equal([first.status, due.status], ["confirmed", "paid"], "a confirmed receipt pays the instalment");
  const at = wat("2027-07-01T10:00:00");
  accepted(connected(state, operations(at), "payment.refund_request", first.id), "the refund request");
  accepted(connected(state, finance(at), "payment.refund_confirm", first.id), "Finance's refund evidence");
  const refundedReceipt = recordsOf(state, "payments").find((item) => item.id === first.data.paymentId)!;
  equal([due.status, outstandingOf(due)], ["scheduled", 2_500_000], "a refund reopens the instalment by its balance, not in dispute");
  equal([exceptionsFor(state, due.id, "customer_dispute").length, openExceptionsFor(state, refundedReceipt.id).length], [0, 0], "and raises no dispute and no open exception on the refunded receipt");
  equal([refundedReceipt.status, paymentRefundedKobo(refundedReceipt)], ["returned", 2_500_000], "the receipt is returned in full");
  // A second checkout pays it again; this time Finance records reversal evidence.
  const second = checkout(state, due, "2027-07-02T09:00:00", "confirmed");
  equal(due.status, "paid", "the second receipt pays it");
  accepted(connected(state, finance(wat("2027-07-02T10:00:00")), "payment.reverse", second.id), "Finance's reversal evidence");
  const reversed = recordsOf(state, "payments").find((item) => item.id === second.data.paymentId)!;
  equal([due.status, outstandingOf(due), reversed.status], ["in_dispute", 2_500_000, "returned"], "a reversal reopens the instalment in dispute");
  const [dispute] = exceptionsFor(state, due.id, "customer_dispute");
  check(dispute && isOpenException(dispute.status) && String(dispute.data.notes).includes(reversed.reference), "with a dispute exception naming the reversed receipt");
  equal(openExceptionsFor(state, reversed.id).length, 0, "and no open exception on the reversed receipt itself");
  // A late receipt that paid nothing: its reversal puts no instalment in dispute.
  const { state: late, due: lateDue } = liveFixture({ withFailure: false, merchantId: "pay-by-bank-late-reversal" });
  const ctx = operations(wat("2027-07-01T09:00:00"));
  const intent = accepted(connected(late, ctx, "payment.create", undefined, { dueItemId: lateDue.id, amountKobo: lateDue.amountKobo }), "the checkout");
  accepted(connected(late, ctx, "payment.authorise", intent.id), "its authorisation");
  addObservation(late, { reference: "TRF-OTHER", amountKobo: lateDue.amountKobo, source: "transfer", customerId: lateDue.customerId, eventId: "other", occurredAt: wat("2027-07-01T09:05:00") });
  accepted(request(late, () => reconcile(late, finance(wat("2027-07-01T09:10:00")))), "the transfer's reconciliation");
  const other = payment(late, "TRF-OTHER");
  if (other.status !== "allocated") accepted(act(late, finance(wat("2027-07-01T09:15:00")), "manual_allocate", other.id, "Paid by transfer.", { dueItemId: lateDue.id, amountKobo: lateDue.amountKobo }), "the transfer's allocation");
  equal(lateDue.status, "paid", "the instalment is paid by transfer while the checkout waits");
  accepted(connected(late, ctx, "payment.outcome", intent.id, { outcome: "confirmed" }), "the late receipt");
  const lateReceipt = recordsOf(late, "payments").find((item) => item.id === intentOf(late, intent.id).data.paymentId)!;
  const [lateException] = openExceptionsFor(late, lateReceipt.id);
  check(lateException?.data.type === "unallocated_payment", "the late receipt waits for Finance with an exception");
  const reversal = accepted(connectedWithNote(late, finance(wat("2027-07-01T10:00:00")), "payment.reverse", intent.id), "the late receipt's reversal");
  equal([lateDue.status, exceptionsFor(late, lateDue.id, "customer_dispute").length], ["paid", 0], "the paid instalment is not put in dispute by a receipt that never paid it");
  equal([lateException!.status, lateException!.data.resolutionCode], ["closed", "condition_cleared"], "and the late receipt's exception closes because its money went back");
  // The review of these fixes: the step's audit entry names the exception it closed, and a step that closes none adds nothing.
  equal(reversal.auditNote, `Closed 1 exception automatically, because its cause went away (unallocated payment: payment ${lateReceipt.reference} was reversed).`, "the reversal's audit entry names it");
  const open = recordsOf(late, "due-items").find((item) => item.status === "scheduled" && item.id !== lateDue.id)!;
  equal(accepted(connectedWithNote(late, ctx, "payment.create", undefined, { dueItemId: open.id, amountKobo: open.amountKobo }), "a new checkout").auditNote, undefined, "a checkout that closes no exception adds no note");
});

// ---------- Item 10: a pay-by-bank outcome that stays unknown ages into an exception Finance resolves ----------
section("an unknown pay-by-bank outcome", () => {
  const { state, due, policy } = liveFixture({ merchantId: "checkout-unknown" });
  const intent = checkout(state, due, "2027-07-01T09:00:00", "unknown");
  close(state, "2027-07-01T20:00:00");
  equal(openExceptionsFor(state, intent.id).length, 0, "no exception before the outcome has been unknown for 24 hours");
  check(!buildAlerts(state, wat("2027-07-01T20:00:00")).some((alert) => alert.key === "pay_by_bank_outcome_unknown"), "and no alert");
  const report = close(state, "2027-07-02T10:00:00");
  const [unknown] = exceptionsFor(state, intent.id, "unknown_outcome");
  check(unknown && isOpenException(unknown.status), "after 24 hours the close raises an unknown-outcome exception for the checkout");
  equal([unknown!.data.owner, unknown!.data.linkedKind, unknown!.data.condition, unknown!.amountKobo, unknown!.customerId], ["Finance", "connected-intents", `unknown_outcome:${intent.id}`, intent.amountKobo, due.customerId], "owned by Finance, linked to the checkout");
  check(/24 hours/.test(String(unknown!.data.notes)) && String(unknown!.data.notes).includes(due.reference), `its notes say what is held (${unknown!.data.notes})`);
  equal([intent.data.outcomeExceptionId, report.data.checkoutOutcomesUnknown], [unknown!.id, 1], "the checkout names its exception and the close counts it");
  const alert = buildAlerts(state, wat("2027-07-02T10:00:00")).find((item) => item.key === "pay_by_bank_outcome_unknown");
  equal([alert?.severity, alert?.count, alert?.linkedRecordId], ["high", 1, intent.id], "an alert names the held checkout");
  close(state, "2027-07-20T07:00:00");
  equal(exceptionsFor(state, intent.id, "unknown_outcome").length, 1, "later closes do not raise it again");
  const later = wat("2027-07-20T08:00:00");
  equal(evaluateRetry(state, finance(later), due, approvedPolicyFor(state, due)!).rule, "in_flight", "until the outcome is known the instalment stays held");
  refused(connected(state, operations(later), "payment.create", undefined, { dueItemId: due.id, amountKobo: due.amountKobo }), /unknown outcome/, 409, "and a new checkout is refused");
  // Only Finance records the outcome, and a failure code belongs to a debit attempt.
  refused(act(state, operations(later), "resolve_exception", unknown!.id, "Operations tries to settle it.", { resolutionCode: "resolved_failed" }), /Finance/, 403, "Operations cannot record a pay-by-bank payment's outcome");
  refused(act(state, finance(later), "resolve_exception", unknown!.id, "With a debit failure code.", { resolutionCode: "resolved_failed", confirmedFailureCode: "INSUFFICIENT_FUNDS" }), /A failure code is only for a collection attempt/, undefined, "a debit failure code is refused for a checkout");
  // Finance marks it failed: the instalment is released.
  const resolved = accepted(act(state, finance(later), "resolve_exception", unknown!.id, "The bank confirmed no payment arrived for this checkout.", { resolutionCode: "resolved_failed" }), "Finance's resolution as failed") as any;
  equal([unknown!.status, intent.status, intent.data.outcomeResolution?.outcome, intent.data.outcomeResolution?.resolvedBy], ["resolved", "failed", "failed", "Sandbox Finance"], "the checkout is recorded as failed, by Finance");
  check(/failed/.test(resolved.message) && /released/.test(resolved.message), `the answer says the instalment is released (${resolved.message})`);
  check(/recorded as failed/.test(String(resolved.data.auditNote)) && String(resolved.data.auditNote).includes(due.reference), `and the audit entry records the outcome (${resolved.data.auditNote})`);
  const last = intent.data.events?.at(-1);
  check(last?.status === "failed" && /Finance/.test(String(last?.detail)), "the checkout's history records Finance's outcome");
  check(evaluateRetry(state, finance(later), due, policy).rule !== "in_flight", "the engine no longer holds the instalment");
  accepted(connected(state, operations(later), "payment.create", undefined, { dueItemId: due.id, amountKobo: due.amountKobo }), "a new checkout");
  check(!buildAlerts(state, later).some((item) => item.key === "pay_by_bank_outcome_unknown"), "and the alert clears");
});

section("an unknown pay-by-bank outcome confirmed paid with evidence", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "checkout-unknown-paid" });
  const intent = checkout(state, due, "2027-07-01T09:00:00", "unknown");
  close(state, "2027-07-02T10:00:00");
  const [unknown] = exceptionsFor(state, intent.id, "unknown_outcome");
  const at = wat("2027-07-02T11:00:00");
  refused(act(state, finance(at), "resolve_exception", unknown!.id, "Paid, but no evidence named.", { resolutionCode: "resolved_succeeded" }), /evidence reference/, undefined, "confirming it paid needs an evidence reference");
  refused(act(state, finance(at), "resolve_exception", unknown!.id, "Paid, with an account number.", { resolutionCode: "resolved_succeeded", evidenceReference: "0123456789" }), /masked/, undefined, "and the reference must be masked");
  accepted(act(state, finance(at), "resolve_exception", unknown!.id, "The bank statement shows the payment arrived.", { resolutionCode: "resolved_succeeded", evidenceReference: "STMT-***4411" }), "Finance's confirmation with evidence");
  const receipt = recordsOf(state, "payments").find((item) => item.id === intent.data.paymentId);
  equal([intent.status, receipt?.data.evidenceReference, receipt?.status, due.status, outstandingOf(due)], ["confirmed", "STMT-***4411", "allocated", "paid", 0], "the checkout is confirmed, its receipt carries the evidence and pays the instalment");
  equal([unknown!.status, intent.data.outcomeResolution?.evidenceReference], ["resolved", "STMT-***4411"], "the exception is resolved with the evidence on the checkout");
  close(state, "2027-07-03T07:00:00");
  equal([exceptionsFor(state, intent.id, "unknown_outcome").length, due.status], [1, "paid"], "nothing is raised again");
});

section("a late sample outcome closes the unknown-outcome exception", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "checkout-unknown-late" });
  const intent = checkout(state, due, "2027-07-01T09:00:00", "unknown");
  close(state, "2027-07-02T10:00:00");
  const [unknown] = exceptionsFor(state, intent.id, "unknown_outcome");
  const answer = accepted(connectedWithNote(state, operations(wat("2027-07-02T11:00:00")), "payment.outcome", intent.id, { outcome: "failed" }), "the provider's late answer");
  equal([intent.status, unknown!.status, unknown!.data.resolutionCode], ["failed", "closed", "condition_cleared"], "the exception closes because the outcome is now known");
  // The review of these fixes: the step's audit entry names the exception it closed.
  equal([answer.result.id, answer.auditNote], [intent.id, "Closed 1 exception automatically, because its cause went away (outcome unknown: the Pay by Bank payment’s outcome is now recorded as failed)."], "and the step's audit entry names it");
  close(state, "2027-07-03T07:00:00");
  equal(exceptionsFor(state, intent.id, "unknown_outcome").length, 1, "and is never raised again");
});

// ---------- Console decision: an exception closes when its condition clears ----------
section("exceptions whose payment is settled", () => {
  const state = seedMerchant("condition-cleared");
  const at = wat("2027-07-01T09:00:00");
  // Confirming SBX-PAY-1003's match: the exception asking Finance to confirm its payment closes.
  const due1003 = recordsOf(state, "due-items").find((item) => item.reference === "DEMO-LOAN-1003")!;
  const [confirmation] = exceptionsFor(state, due1003.id, "unallocated_payment");
  const pay1003 = payment(state, "SBX-PAY-1003"), proposal = recordsOf(state, "allocations").find((item) => item.data.paymentId === pay1003.id && item.status === "proposed")!;
  const confirmed = accepted(act(state, finance(at), "confirm_allocation", pay1003.id, "The payer and amount match this instalment.", { proposalId: proposal.id, proposalUpdatedAt: proposal.updatedAt }), "the confirmation of SBX-PAY-1003") as any;
  equal([confirmation!.status, confirmation!.data.resolutionCode, confirmation!.data.conditionCleared?.by, confirmation!.data.resolvedAt], ["closed", "condition_cleared", "Sandbox Finance", at], "the exception closes in the same action");
  check(/DEMO-LOAN-1003/.test(String(confirmation!.data.conditionCleared?.reason)) && /paid/.test(String(confirmation!.data.conditionCleared?.reason)), `with the reason (${confirmation!.data.conditionCleared?.reason})`);
  check(/because its cause went away/.test(String(confirmed.data.auditNote)), `and the audit entry names it (${confirmed.data.auditNote})`);
  // Refunding SBX-UNIDENTIFIED-001: its exception closes.
  const unidentified = payment(state, "SBX-UNIDENTIFIED-001");
  const [noReference] = exceptionsFor(state, unidentified.id, "unallocated_payment");
  accepted(act(state, finance(at), "record_refund", unidentified.id, "Returned to the sender.", { reference: "RF-***01" }), "the refund");
  equal([noReference!.status, noReference!.data.resolutionCode], ["closed", "condition_cleared"], "the refunded payment's exception closes");
  check(/refunded/.test(String(noReference!.data.conditionCleared?.reason)), "because the payment was refunded");
  for (const day of ["2027-07-02", "2027-07-03"]) close(state, `${day}T07:00:00`);
  equal([confirmation!.status, noReference!.status, exceptionsFor(state, due1003.id).length, exceptionsFor(state, unidentified.id).length], ["closed", "closed", 1, 1], "later closes neither reopen them nor raise them again");
});

section("an overpayment's excess applied and a duplicate refunded", () => {
  const { state, due, customer, mandate } = liveFixture({ withFailure: false, merchantId: "cleared-overpayment" });
  const second = postDue(state, wat("2027-07-01T08:00:00"), customer.id, mandate.id, "DEMO-LOAN-9005", 1_500_000, "2027-09-01");
  addObservation(state, { reference: "TRF-OVER", amountKobo: 2_800_000, source: "transfer", customerId: customer.id, eventId: "over", occurredAt: wat("2027-07-01T09:00:00") });
  close(state, "2027-07-01T09:05:00");
  const over = payment(state, "TRF-OVER");
  accepted(act(state, finance(wat("2027-07-01T10:00:00")), "manual_allocate", over.id, "Pays the fifth instalment.", { dueItemId: due.id, amountKobo: due.amountKobo }), "the allocation");
  const [excess] = exceptionsFor(state, over.id, "overpayment");
  check(excess && isOpenException(excess.status), "the excess raises an overpayment exception");
  accepted(act(state, finance(wat("2027-07-01T11:00:00")), "manual_allocate", over.id, "The excess pays towards the next instalment.", { dueItemId: second.id, amountKobo: 300_000 }), "the excess applied");
  equal([over.status, excess!.status, excess!.data.resolutionCode], ["allocated", "closed", "condition_cleared"], "once the payment is allocated in full its overpayment exception closes");
  // A suspected duplicate refunded to the payer.
  addObservation(state, { reference: "TRF-D1", amountKobo: 1_111_100, source: "transfer", customerId: customer.id, eventId: "d1", occurredAt: wat("2027-07-02T10:00:00") });
  addObservation(state, { reference: "TRF-D2", amountKobo: 1_111_100, source: "transfer", customerId: customer.id, eventId: "d2", occurredAt: wat("2027-07-02T10:01:00") });
  close(state, "2027-07-02T10:05:00");
  const twin = payment(state, "TRF-D2");
  const [held] = exceptionsFor(state, twin.id, "suspected_duplicate");
  equal([twin.status, held?.status], ["possible_duplicate", "open"], "the second transfer is held");
  accepted(act(state, finance(wat("2027-07-02T11:00:00")), "record_refund", twin.id, "Charged twice; returned.", { reference: "RF-***02" }), "the duplicate's refund");
  equal([twin.status, held!.status, held!.data.resolutionCode], ["returned", "closed", "condition_cleared"], "the refunded duplicate's exception closes");
});

section("a condition that returns is new work, and resolutions stay durable", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "cleared-returns" });
  addObservation(state, { reference: "TRF-AGED", amountKobo: due.amountKobo, source: "transfer", customerId: due.customerId, eventId: "aged", occurredAt: wat("2027-07-01T09:00:00") });
  close(state, "2027-07-02T10:00:00");
  const aged = payment(state, "TRF-AGED");
  const [first] = exceptionsFor(state, aged.id, "unallocated_payment");
  check(first && isOpenException(first.status), "the payment ages into an exception");
  accepted(act(state, finance(wat("2027-07-02T11:00:00")), "manual_allocate", aged.id, "Pays the fifth instalment.", { dueItemId: due.id, amountKobo: due.amountKobo }), "the allocation");
  equal(first!.status, "closed", "allocated in full, the exception closes");
  close(state, "2027-07-03T07:00:00");
  equal([first!.status, exceptionsFor(state, aged.id, "unallocated_payment").length], ["closed", 1], "while the payment stays allocated nothing reopens");
  // Finance's review finds the match wrong: the money waits again, which is new work.
  const allocation = recordsOf(state, "allocations").find((item) => item.data.paymentId === aged.id && item.status === "confirmed")!;
  accepted(act(state, finance(wat("2027-07-03T09:00:00")), "review_allocation", allocation.id, "Wrong instalment.", { correct: false }), "the review");
  close(state, "2027-07-04T07:00:00");
  const again = exceptionsFor(state, aged.id, "unallocated_payment");
  equal([again.length, first!.status, again.filter((item) => isOpenException(item.status)).length], [2, "closed", 1], "the cleared exception stays closed and a new one asks about the money waiting again");
  // A resolution is not rewritten when its condition clears later.
  const open = again.find((item) => isOpenException(item.status))!;
  accepted(act(state, finance(wat("2027-07-04T09:00:00")), "resolve_exception", open.id, "Kept as the customer's credit for now.", { resolutionCode: "held_credit" }), "the resolution");
  const other = postDue(state, wat("2027-07-04T09:30:00"), due.customerId, String(due.data.mandateId), "DEMO-LOAN-9105", due.amountKobo, "2027-09-01");
  accepted(act(state, finance(wat("2027-07-04T10:00:00")), "manual_allocate", aged.id, "Applied to the next instalment.", { dueItemId: other.id, amountKobo: due.amountKobo }), "the later allocation");
  equal([open.status, open.data.resolutionCode], ["resolved", "held_credit"], "a resolved exception keeps its resolution");
  close(state, "2027-07-05T07:00:00");
  equal(exceptionsFor(state, aged.id, "unallocated_payment").length, 2, "and nothing is raised again");
});

// ---------- Money stays conserved, every dispute has an owner and no settled exception stays open ----------
let propertyRuns = "";
section("random operations", () => {
  const property = propertyRun(Number(process.env.DISPUTE_SEEDS || 16), Number(process.env.DISPUTE_STEPS || 45));
  propertyRuns = `${property.applied} operations applied across ${property.seeds} seeds`;
  equal(property.violations, [], "no invariant is broken and no close or reconciliation is refused");
  check(property.applied > property.seeds * 20, `most operations applied (${property.applied})`);
  checks += property.checked;
});

function mulberry32(seed: number) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Money invariants after every request; ownership of disputes and held checkouts, and settled exceptions, after every close. */
function invariants(state: DomainState, afterClose: boolean, now: number): string[] {
  const problems: string[] = [];
  const allocations = recordsOf(state, "allocations");
  for (const p of recordsOf(state, "payments")) {
    const confirmed = allocations.filter((a) => a.status === "confirmed" && a.data.paymentId === p.id).reduce((sum, a) => sum + a.amountKobo, 0);
    if (Number(p.data.allocatedKobo || 0) !== confirmed) problems.push(`payment ${p.reference}: allocatedKobo ${p.data.allocatedKobo} is not its confirmed allocations ${confirmed}`);
    const reversed = p.data.reversalStatus === "reversed";
    if (!reversed && confirmed + paymentRefundedKobo(p) + paymentUnappliedKobo(p) !== p.amountKobo) problems.push(`payment ${p.reference}: ${p.amountKobo} is not allocated + refunded + unapplied`);
    if (reversed && confirmed > 0) problems.push(`payment ${p.reference}: reversed with money applied`);
  }
  for (const d of recordsOf(state, "due-items")) {
    const confirmed = allocations.filter((a) => a.status === "confirmed" && a.data.dueItemId === d.id).reduce((sum, a) => sum + a.amountKobo, 0);
    if (d.status !== "cancelled" && outstandingOf(d) !== d.amountKobo - confirmed) problems.push(`due ${d.reference}: outstanding ${outstandingOf(d)} is not ${d.amountKobo} - ${confirmed}`);
    if (d.status === "paid" && outstandingOf(d) > 0) problems.push(`due ${d.reference}: paid with ${outstandingOf(d)} outstanding`);
  }
  if (positionMismatches(state).length) problems.push("the position rebuild does not match");
  const exceptions = recordsOf(state, "exceptions");
  // Every instalment in dispute is someone's: an open dispute exception, or one resolved in a way that keeps the dispute.
  for (const d of recordsOf(state, "due-items").filter((item) => item.status === "in_dispute")) {
    const disputes = exceptions.filter((e) => e.data.linkedRecordId === d.id && e.data.type === "customer_dispute");
    if (!disputes.some((e) => isOpenException(e.status) || ["upheld_refund", "mandate_cancelled"].includes(String(e.data.resolutionCode)))) problems.push(`due ${d.reference}: in dispute with no owner`);
  }
  if (!afterClose) return problems;
  const byId = new Map(state.records.map((record) => [record.id, record]));
  for (const e of exceptions.filter((item) => isOpenException(item.status))) {
    const linked = byId.get(String(e.data.linkedRecordId));
    if (linked?.kind === "payments" && ["unallocated_payment", "overpayment", "suspected_duplicate"].includes(String(e.data.type)) && paymentUnappliedKobo(linked) === 0) problems.push(`exception ${e.data.type} on ${linked.reference}: open after its payment was settled`);
    if (e.data.type === "unknown_outcome" && linked && linked.status !== "unknown") problems.push(`exception unknown_outcome on ${linked.kind}: open after its outcome was recorded`);
  }
  for (const intent of recordsOf(state, "connected-intents").filter((item) => item.status === "unknown")) {
    const since = Date.parse(String((intent.data.events ?? []).find((event) => event.status === "unknown")?.at));
    if (now - since >= 24 * HOUR && !exceptions.some((e) => e.data.linkedRecordId === intent.id && e.data.type === "unknown_outcome" && isOpenException(e.status))) problems.push(`checkout ${intent.id}: unknown for 24 hours with no open exception`);
  }
  return problems;
}

/** Random evidence, allocations, refunds, reversals, pay-by-bank journeys and outcomes, disputes, releases and resolutions. */
function propertyRun(seeds: number, steps: number) {
  const violations: string[] = [];
  let applied = 0, checked = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const rand = mulberry32(seed);
    const pick = <T,>(items: T[]): T | undefined => (items.length ? items[Math.floor(rand() * items.length)] : undefined);
    let state = liveFixture({ withFailure: false, merchantId: `disputes-${seed}` }).state;
    let clock = Date.parse(wat("2027-06-30T08:00:00")), counter = 0;
    const at = () => new Date(clock).toISOString();
    const dues = () => recordsOf(state, "due-items"), payments = () => recordsOf(state, "payments");
    const openDisputes = () => recordsOf(state, "exceptions").filter((e) => e.data.type === "customer_dispute" && isOpenException(e.status));
    const step = (ctx: Context, action: string, recordId?: string, data: Record<string, unknown> = {}) => runConnectedAction(state, ctx, { action, recordId, reason: "Random pay-by-bank step.", expectedRevision: connectedRevision(state), data } as any) as ValopayRecord;
    const ops: Record<string, () => void> = {
      debit: () => { const due = pick(dues())!; counter++; const reference = `D-${seed}-${counter}`; addAttempt(state, due, { status: "succeeded", occurredAt: at(), providerReference: reference }); addObservation(state, { reference, amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: `e-${counter}`, occurredAt: at() }); },
      disputedDebit: () => { const due = pick(dues().filter((d) => !recordsOf(state, "attempts").some((a) => a.data.dueItemId === d.id && ["scheduled", "sent", "unknown"].includes(a.status))))!; if (!due) return; addAttempt(state, due, { status: "failed", failureCode: "CUSTOMER_DISPUTED", occurredAt: at() }); },
      transfer: () => { const due = pick(dues())!; counter++; addObservation(state, { reference: `T-${seed}-${counter}`, amountKobo: rand() < 0.6 ? due.amountKobo : Math.max(1, Math.floor(due.amountKobo * (0.3 + rand()))), source: "transfer", customerId: rand() < 0.9 ? due.customerId : "", eventId: `e-${counter}`, occurredAt: at(), narration: rand() < 0.5 ? `pay ${due.reference}` : undefined }); },
      reversal: () => { const target = pick(payments().filter((p) => p.data.canonical)); if (!target) return; counter++; addObservation(state, { reference: target.reference, amountKobo: target.amountKobo, source: "webhook", customerId: target.customerId, eventId: `rev-${counter}`, reversed: true, occurredAt: at(), provider: String(target.data.providerConnection || "Sandbox Rail"), currency: String(target.data.currency || "NGN") } as any); },
      reconcile: () => { reconcile(state, finance(at())); },
      close: () => { executeAction(state, finance(at()), { action: "daily_close" }); },
      confirm: () => { const p = pick(payments().filter((item) => item.status === "proposed")); const proposal = p && recordsOf(state, "allocations").find((item) => item.data.paymentId === p.id && item.status === "proposed"); if (p) executeAction(state, finance(at()), { action: "confirm_allocation", recordId: p.id, reason: "Checked the evidence.", data: proposal ? { proposalId: proposal.id, proposalUpdatedAt: proposal.updatedAt } : {} }); },
      manual: () => { const p = pick(payments()); if (!p) return; const due = pick(dues().filter((item) => !p.customerId || item.customerId === p.customerId)); if (!due) return; const left = paymentUnappliedKobo(p), owed = outstandingOf(due); executeAction(state, finance(at()), { action: "manual_allocate", recordId: p.id, reason: "Finance identified it.", data: { dueItemId: due.id, amountKobo: Math.max(1, Math.floor(Math.min(left, owed) * (rand() < 0.5 ? 1 : rand()))) } }); },
      refund: () => { const p = pick(payments()); if (p) executeAction(state, finance(at()), { action: "record_refund", recordId: p.id, reason: "Refunded outside Valo Pay.", data: { reference: "RF-***1" } }); },
      review: () => { const a = pick(recordsOf(state, "allocations").filter((item) => item.status !== "proposed")); if (a) executeAction(state, finance(at()), { action: "review_allocation", recordId: a.id, reason: "Precision review.", data: { correct: rand() < 0.5 } }); },
      amend: () => { const due = pick(dues())!; const input = structuredClone(due); input.amountKobo = Math.max(1_000_000, Math.floor(due.amountKobo * (0.5 + rand()))); input.data.overrideReason ||= "Amended by the lender."; amendDueItem(state, ctxAt(at(), "Admin"), due, input); },
      resolveDispute: () => { const e = pick(openDisputes()); if (e) executeAction(state, operations(at()), { action: "resolve_exception", recordId: e.id, reason: "Reviewed the dispute.", data: { resolutionCode: pick(["not_upheld", "not_upheld", "upheld_refund", "mandate_cancelled"]) } }); },
      release: () => { const due = pick(dues().filter((item) => item.status === "in_dispute")); if (due) executeAction(state, finance(at()), { action: "release_dispute", recordId: due.id, reason: "Collect it again." }); },
      resolve: () => { const e = pick(recordsOf(state, "exceptions").filter((item) => isOpenException(item.status) && item.data.type !== "customer_dispute")); if (!e) return; const codes = ({ suspected_duplicate: ["distinct_payments", "confirmed_duplicate_refund"], unallocated_payment: ["held_credit", "allocated_manual"], overpayment: ["held_credit"], settlement_variance: ["accepted_variance"], unknown_outcome: ["resolved_failed", "resolved_succeeded", "provider_confirmed_no_debit"] } as Record<string, string[]>)[String(e.data.type)] ?? ["no_action_required"]; executeAction(state, finance(at()), { action: "resolve_exception", recordId: e.id, reason: "Reviewed.", data: { resolutionCode: pick(codes), ...(e.data.linkedKind === "connected-intents" ? { evidenceReference: "STMT-***9" } : {}) } }); },
      checkout: () => { const due = pick(dues())!; const owed = outstandingOf(due); if (owed <= 0) return; const ctx = operations(at()); const intent = step(ctx, "payment.create", undefined, { dueItemId: due.id, amountKobo: Math.max(1, Math.floor(owed * (rand() < 0.6 ? 1 : rand()))) }); step(ctx, "payment.authorise", intent.id); step(ctx, "payment.outcome", intent.id, { outcome: pick(["confirmed", "unknown", "unknown", "failed"]) }); },
      lateOutcome: () => { const intent = pick(recordsOf(state, "connected-intents").filter((item) => item.status === "unknown")); if (intent) step(operations(at()), "payment.outcome", intent.id, { outcome: pick(["confirmed", "failed"]) }); },
      checkoutReturn: () => { const intent = pick(recordsOf(state, "connected-intents").filter((item) => item.status === "confirmed")); if (!intent) return; if (rand() < 0.5) { step(operations(at()), "payment.refund_request", intent.id); step(finance(at()), "payment.refund_confirm", intent.id); } else step(finance(at()), "payment.reverse", intent.id); },
    };
    const weights: [string, number][] = [["debit", 4], ["disputedDebit", 2], ["transfer", 4], ["reversal", 3], ["reconcile", 4], ["close", 4], ["confirm", 2], ["manual", 4], ["refund", 2], ["review", 2], ["amend", 1], ["resolveDispute", 3], ["release", 2], ["resolve", 3], ["checkout", 3], ["lateOutcome", 1], ["checkoutReturn", 2]];
    const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
    for (let index = 0; index < steps; index++) {
      clock += Math.floor(rand() * 10 * HOUR) + 60_000;
      let roll = rand() * total, name = weights[0]![0];
      for (const [candidate, weight] of weights) if ((roll -= weight) < 0) { name = candidate; break; }
      const before = structuredClone(state);
      try {
        ops[name]!();
        assertFinalState(structuredClone(before), state, state.merchant.id, at());
        applied += 1;
      } catch (error) {
        state = before;
        if (name === "reconcile" || name === "close") violations.push(`seed ${seed} step ${index}: ${name} refused: ${(error as Error).message}`);
      }
      const problems = invariants(state, name === "close" || name === "reconcile", clock);
      checked += 1;
      for (const problem of problems) violations.push(`seed ${seed} step ${index} after ${name}: ${problem}`);
      if (problems.length) break;
    }
  }
  return { violations: [...new Set(violations)].slice(0, 20), applied, seeds, checked };
}

if (failures.length) {
  console.error(failures.join("\n"));
  assert.fail(`${failures.length} dispute lifecycle section(s) failed`);
}
console.log(`Dispute lifecycle golden tests passed (${checks} checks): reversals that reopen an instalment in dispute with an exception, not upheld and Finance's release, an upheld dispute, a released disputed debit, pay-by-bank refunds and reversals, unknown pay-by-bank outcomes aged into an exception Finance resolves, exceptions closed when their condition clears, and the property run (${propertyRuns}).`);
