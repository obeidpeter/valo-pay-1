// Golden tests for payment evidence that names no payer, evidence that shares a
// provider reference, rule R1's currency and connection, rule R4's narration
// references, settlement batches with several statement credits or a line in
// two batches, the unapplied rest of a partly allocated payment and Finance's
// "distinct payments" resolution (23 September audit, items 1, 2, 4, 5, 6, 13
// and 14), and what the review of those fixes found: evidence through another
// connection name, a payer identified through a wrong match, a net line applied
// before the debit's gross, a gross below the amount received, money in another
// currency and a line an earlier build counted in two batches, and what the
// third review found: Finance's resolutions of evidence deciding first, holds
// offered as they stand now, counted-twice reports kept, a batch an earlier
// build counted, amounts in their own currency, other currencies beside a
// customer's position, a payer the payment's evidence names and exceptions that
// name the currency of the money they are about, and what the fourth review
// found: a counted-twice report an earlier build carried in its notes and a
// waiting reversal an earlier build resolved. Every request runs as the
// store runs it: on a copy, with the repository's final-state check, and rolled
// back when it is refused.
import assert from "node:assert/strict";
import { HOUR, addAttempt, addObservation, ctxAt, liveFixture, outstandingOf, wat } from "./helpers.js";
import { allocatePayment, allocationPayer, amendDueItem, paymentObservedAt, raiseException, reconcile, supersedeAllocation } from "../src/domain/reconciliation.js";
import { executeAction } from "../src/domain/actions.js";
import { makeRecord, recordsOf } from "../src/domain/records.js";
import { validateRecord } from "../src/domain/validation.js";
import { positionFor, positionMismatches } from "../src/domain/close.js";
import { connectedRevision, runConnectedAction } from "../src/domain/connected.js";
import { importCsv } from "../src/lib/valopay-import.js";
import { pageReconciliation } from "../src/lib/console-read-models.js";
import { allocatableOnly, allocationChoices, pageRecords } from "../src/lib/valopay-list.js";
import { billableCollection } from "../src/domain/billing.js";
import { buildReports } from "../src/domain/reports.js";
import { buildAlerts } from "../src/domain/alerts.js";
import { customerTimeline } from "../src/domain/timeline.js";
import { buildDisputePack } from "../src/lib/valopay-packs.js";
import { pageQueue } from "../src/lib/valopay-queues.js";
import { pageCustomerHistory } from "../src/lib/customer-history.js";
import { bindCloseReviewBasis } from "../src/domain/close-review.js";
import { canTakeAllocation, paymentAwaitsAllocation, paymentRefundedKobo, paymentUnappliedKobo, resolutionCodesForException } from "@workspace/valopay-schema";
import type { DomainState, TypedRecord, ValopayRecord } from "../src/domain/types.js";

const { assertFinalState } = await import("../src/lib/valopay-store.js");
const finance = (now: string) => ctxAt(now, "Finance");
let checks = 0;
const failures: string[] = [];
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks += 1; };
const equal = <T>(actual: T, expected: T, message: string) => { assert.deepEqual(actual, expected, message); checks += 1; };

/** One finding's checks; a failure is reported with the others, so every finding is seen at once. */
function section(name: string, run: () => void) {
  try { run(); } catch (error) { failures.push(`${name}: ${(error as Error).message.split("\n")[0]}`); }
}

/** A request as the store applies it: run on the lender, check the final state against the state before, and roll back when refused. */
function request<T>(state: DomainState, run: () => T): { ok: true; value: T } | { ok: false; message: string; status?: number } {
  const before = structuredClone(state);
  try {
    const value = run();
    assertFinalState(structuredClone(before), state, state.merchant.id, new Date().toISOString());
    return { ok: true, value };
  } catch (error) {
    state.records = before.records; state.settings = before.settings; state.merchant = before.merchant;
    return { ok: false, message: (error as Error).message, status: (error as { status?: number }).status };
  }
}
function accepted<T>(outcome: ReturnType<typeof request<T>>, label: string): T {
  if (!outcome.ok) assert.fail(`${label} was refused: ${outcome.message}`);
  checks += 1;
  return outcome.value;
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
const payment = (state: DomainState, reference: string) => recordsOf(state, "payments").filter((item) => item.reference === reference);
const allocationsOf = (state: DomainState, paymentId: string) => recordsOf(state, "allocations").filter((item) => item.data.paymentId === paymentId);
const exceptionsFor = (state: DomainState, linkedRecordId: string, type?: string) => recordsOf(state, "exceptions").filter((item) => item.data.linkedRecordId === linkedRecordId && (!type || item.data.type === type));
const closeAnswer = (state: DomainState, at: string) => accepted(request(state, () => executeAction(state, finance(wat(at)), { action: "daily_close" })), `the daily close at ${at} WAT`);
const close = (state: DomainState, at: string) => closeAnswer(state, at).record!;

// ---------- Item 1: evidence with no payer is applied only when Finance identifies the payer, in the same action ----------
section("a settlement line with no customer", () => {
  const { state, due: fixtureDue } = liveFixture({ withFailure: false, merchantId: "no-payer-settlement" });
  addAttempt(state, fixtureDue, { status: "sent", occurredAt: wat("2027-07-01T06:15:00"), providerReference: "PSK-NOCUST-1" });
  // The provider's settlement report as the importer receives it: no lender customer column.
  const csv = "reference,amount,grossAmountKobo,feeKobo,batchReference,source,eventId,occurredAt\nPSK-NOCUST-1,24875.00,25000.00,125.00,B-0702,settlement,line-1,2027-07-02T06:00:00Z";
  accepted(request(state, () => importCsv(state, ctxAt(wat("2027-07-02T08:00:00"), "Operations"), { kind: "observations", csv, syntheticOnly: true, commit: true, identityColumn: "eventId", amountUnit: "naira" })), "the settlement file");
  // A committed import replaces the lender's records with its checked copy.
  const due = recordsOf(state, "due-items").find((item) => item.id === fixtureDue.id)!;
  const first = close(state, "2027-07-02T09:00:00");
  close(state, "2027-07-03T07:00:00");
  const [received] = payment(state, "PSK-NOCUST-1");
  equal([received!.customerId, received!.status], ["", "proposed"], "the payment keeps no payer and waits for Finance");
  const [proposal] = allocationsOf(state, received!.id);
  equal([proposal!.status, proposal!.data.rule, proposal!.data.confidence, proposal!.data.automatic, proposal!.customerId], ["proposed", "R1", "probable", false, ""], "R1 proposes the match and never applies it");
  check(/names no payer/.test(String(proposal!.data.explanation)), "the proposal says why Finance must confirm it");
  equal([outstandingOf(due), due.status], [due.amountKobo, "scheduled"], "nothing is applied to the instalment yet");
  equal(first.data.report.proposed.count >= 1, true, "the close reports the proposal");
  // Finance confirms: the payer is identified in the same action, with who and why.
  const confirmed = accepted(request(state, () => executeAction(state, finance(wat("2027-07-03T10:00:00")), { action: "confirm_allocation", recordId: received!.id, reason: "The debit reference is this customer's instalment.", data: { proposalId: proposal!.id, proposalUpdatedAt: proposal!.updatedAt } })), "Finance's confirmation");
  equal(received!.customerId, due.customerId, "the payment now carries the payer");
  equal([received!.data.payerIdentification?.customerId, received!.data.payerIdentification?.identifiedBy, received!.data.payerIdentification?.reason, received!.data.payerIdentification?.allocationId], [due.customerId, "Sandbox Finance", "The debit reference is this customer's instalment.", proposal!.id], "who identified the payer, and why, is on the payment");
  equal([proposal!.status, proposal!.customerId, due.status, outstandingOf(due)], ["confirmed", due.customerId, "paid", 0], "the confirmed match carries the payer and pays the instalment");
  check(/^Payer identified as customer DEMO-C1005 for payment PSK-NOCUST-1\.$/.test(String(confirmed.data.auditNote)) && /Ngozi Eze \(DEMO-C1005\)/.test(confirmed.message), "the answer names the payer and the audit entry says the payer was identified");
  close(state, "2027-07-04T07:00:00");
});

section("the seeded unidentified transfer", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "no-payer-manual" });
  const [unidentified] = payment(state, "SBX-UNIDENTIFIED-001");
  const outcome = accepted(request(state, () => executeAction(state, finance(wat("2027-07-01T10:00:00")), { action: "manual_allocate", recordId: unidentified!.id, reason: "Payer confirmed by phone against the transfer narration.", data: { dueItemId: due.id, amountKobo: 1_000_000 } })), "the manual allocation of a payment with no payer");
  equal(unidentified!.customerId, due.customerId, "allocating it identifies the payer");
  equal([unidentified!.data.payerIdentification?.identifiedBy, unidentified!.data.payerIdentification?.reason, unidentified!.data.payerIdentification?.dueItemId], ["Sandbox Finance", "Payer confirmed by phone against the transfer narration.", due.id], "and records who did it and why");
  const allocation = outcome.record as TypedRecord<"allocations">;
  equal([allocation.status, allocation.customerId, allocation.data.rule], ["confirmed", due.customerId, "R7"], "the manual allocation is applied for that payer");
  check(/identified the payer/.test(String(allocation.data.explanation)), "the allocation explains the identification");
  check(outcome.data.auditNote === "Payer identified as customer DEMO-C1005 for payment SBX-UNIDENTIFIED-001.", "the audit entry says so, by customer reference");
  equal([unidentified!.status, paymentUnappliedKobo(unidentified!)], ["partial", 2_200_000], "the rest stays unapplied");
  // The payer is now known: another customer's instalment is refused with a reason, not by the repository.
  const other = recordsOf(state, "due-items").find((item) => item.customerId !== due.customerId && item.status === "scheduled")!;
  const refused = request(state, () => executeAction(state, finance(wat("2027-07-01T11:00:00")), { action: "manual_allocate", recordId: unidentified!.id, reason: "Wrong payer", data: { dueItemId: other.id, amountKobo: 100_000 } }));
  check(!refused.ok && refused.status === 409 && /belong to different customers/.test(refused.message), `another customer's instalment is refused with a reason (${!refused.ok && refused.message})`);
  // Automatic matching never identifies a payer.
  addObservation(state, { reference: "TRF-NOBODY", amountKobo: due.amountKobo, source: "transfer", eventId: "nobody", occurredAt: wat("2027-07-01T12:00:00") });
  reconcile(state, finance(wat("2027-07-01T12:05:00")));
  const [nobody] = payment(state, "TRF-NOBODY");
  const second = recordsOf(state, "due-items").find((item) => item.customerId === due.customerId && item.id !== due.id) ?? due;
  assert.throws(() => allocatePayment(state, finance(wat("2027-07-01T12:10:00")), nobody!, second, 100_000, "R1", "certain", true), /payer/); checks += 1;
  equal(nobody!.customerId, "", "and the payment keeps no payer");
});

// ---------- Item 2: evidence from two payers that shares a provider reference is never merged ----------
section("a second payer's evidence with the first payer's reference and an instalment link", () => {
  const { state } = liveFixture({ withFailure: false, merchantId: "shared-reference-link" });
  const [a, b] = recordsOf(state, "due-items").filter((item) => item.status === "scheduled");
  const t0 = wat("2027-07-01T10:00:00"), t1 = wat("2027-07-01T11:00:00");
  accepted(request(state, () => postObservation(state, t0, { reference: "TRF-20270701-0001", amountKobo: 700_000, customerId: a!.customerId, data: { source: "transfer", eventId: "bank-a-1", occurredAt: t0 } })), "A's transfer");
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T10:05:00")))), "the first reconciliation");
  const second = accepted(request(state, () => postObservation(state, t1, { reference: "TRF-20270701-0001", amountKobo: b!.amountKobo, customerId: b!.customerId, data: { source: "card", eventId: "card-b-1", dueItemId: b!.id, occurredAt: t1 } })), "B's card payment");
  for (const at of ["2027-07-01T12:00:00", "2027-07-02T07:00:00"]) close(state, at);
  const [first] = payment(state, "TRF-20270701-0001");
  equal([payment(state, "TRF-20270701-0001").length, first!.customerId, first!.amountKobo, first!.data.dueItemId], [1, a!.customerId, 700_000, undefined], "A's payment keeps A's payer, amount and link");
  equal(second.status, "unresolved", "B's evidence is not merged into A's payment");
  const [held] = exceptionsFor(state, second.id, "suspected_duplicate");
  check(held && held.status === "open" && held.data.owner === "Finance" && /another payer/.test(String(held.data.notes)), "an exception asks Finance about the conflict");
  equal(exceptionsFor(state, second.id).length, 1, "and the next close does not raise it again");
  // Finance says the two are different payments: the next close records B's as a payment of its own.
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-02T09:00:00")), { action: "resolve_exception", recordId: held!.id, reason: "Two different payers; the provider reused the reference.", data: { resolutionCode: "distinct_payments" } })), "the resolution");
  close(state, "2027-07-02T10:00:00");
  const own = payment(state, "TRF-20270701-0001").find((item) => item.id !== first!.id)!;
  equal([second.status, second.data.paymentId, own.customerId, own.amountKobo], ["resolved", own.id, b!.customerId, b!.amountKobo], "B's evidence is now a payment of its own");
  equal([b!.status, allocationsOf(state, own.id)[0]?.data.rule], ["paid", "R1"], "and it pays B's instalment");
  equal(first!.status, "unallocated", "A's payment is untouched");
});

section("a second payer's evidence with the same reference and a different amount", () => {
  const { state } = liveFixture({ withFailure: false, merchantId: "shared-reference-amount" });
  const [a, b] = recordsOf(state, "due-items").filter((item) => item.status === "scheduled");
  const t0 = wat("2027-07-01T10:00:00");
  accepted(request(state, () => postObservation(state, t0, { reference: "TRF-0001", amountKobo: a!.amountKobo, customerId: a!.customerId, data: { source: "transfer", eventId: "bank-a-1", occurredAt: t0, narration: `pay ${a!.reference}` } })), "A's transfer");
  const cardB = accepted(request(state, () => postObservation(state, t0, { reference: "TRF-0001", amountKobo: 999_999, customerId: b!.customerId, data: { source: "card", eventId: "card-b-1", occurredAt: t0 } })), "B's card payment");
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T10:05:00")))), "the reconciliation");
  equal(payment(state, "TRF-0001").map((item) => [item.customerId, item.amountKobo]), [[a!.customerId, a!.amountKobo]], "one payment, A's");
  equal(cardB.status, "unresolved", "B's ₦9,999.99 stays visible as unresolved evidence");
  const [held] = exceptionsFor(state, cardB.id, "suspected_duplicate");
  check(held && /another payer/.test(String(held.data.notes)) && held.amountKobo === 999_999, "with an exception for its money");
  // Finance confirms it duplicates the first payment and must be refunded: it is recorded, held, then refunded.
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-01T11:00:00")), { action: "resolve_exception", recordId: held!.id, reason: "Charged twice; refund the card payment.", data: { resolutionCode: "confirmed_duplicate_refund" } })), "the resolution");
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T11:05:00")))), "the next reconciliation");
  const own = payment(state, "TRF-0001").find((item) => item.customerId === b!.customerId)!;
  equal([own.status, own.amountKobo, allocationsOf(state, own.id).length], ["possible_duplicate", 999_999, 0], "the duplicate is a payment held for its refund, never applied");
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-01T12:00:00")), { action: "record_refund", recordId: own.id, reason: "Refunded by the card provider.", data: { reference: "RF-***99" } })), "the refund");
  equal([own.status, paymentRefundedKobo(own)], ["returned", 999_999], "and its refund returns it");
});

section("evidence names the provider connection it came through", () => {
  const { state } = liveFixture({ withFailure: false, merchantId: "shared-reference-connection" });
  const [a, b] = recordsOf(state, "due-items").filter((item) => item.status === "scheduled");
  addObservation(state, { reference: "REF-SHARED", amountKobo: 1_111_100, source: "transfer", customerId: a!.customerId, eventId: "shared-a", occurredAt: wat("2027-07-01T09:00:00") });
  const otherRail = addObservation(state, { reference: "REF-SHARED", amountKobo: 2_222_200, source: "transfer", customerId: b!.customerId, eventId: "shared-b", occurredAt: wat("2027-07-01T09:00:00"), provider: "Other Rail" } as any);
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T09:05:00")))), "the reconciliation");
  // The review of these fixes: evidence through a connection where no payment has its reference, while another connection's payment does, waits for Finance.
  equal([payment(state, "REF-SHARED").map((item) => [item.data.providerConnection, item.customerId, item.amountKobo]), otherRail.status], [[["Sandbox Rail", a!.customerId, 1_111_100]], "unresolved"], "the reference through another connection is neither merged nor made a payment on its own");
  const [otherHeld] = exceptionsFor(state, otherRail.id, "suspected_duplicate");
  check(otherHeld && otherHeld.status === "open" && /came through Other Rail\. No payment there has its reference/.test(String(otherHeld.data.notes)) && /came through Sandbox Rail, and it names another payer\./.test(String(otherHeld.data.notes)), `Finance is asked about it, with both connections and the conflict named (${otherHeld?.data.notes})`);
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-01T09:07:00")), { action: "resolve_exception", recordId: otherHeld!.id, reason: "B paid through the other rail.", data: { resolutionCode: "distinct_payments" } })), "Finance's resolution");
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T09:08:00")))), "the reconciliation after it");
  equal(payment(state, "REF-SHARED").map((item) => [item.data.providerConnection, item.customerId, item.amountKobo]).sort(), [["Other Rail", b!.customerId, 2_222_200], ["Sandbox Rail", a!.customerId, 1_111_100]].sort(), "once Finance says it is money of its own, the same reference through another connection is another payment");
  equal(recordsOf(state, "observations").filter((item) => item.reference === "REF-SHARED" && item.status !== "resolved").length, 0, "both are resolved");
  // Connection names are free text: the same connection written another way is the same key.
  const again = addObservation(state, { reference: "REF-SHARED", amountKobo: 1_111_100, source: "webhook", customerId: a!.customerId, eventId: "shared-a-2", occurredAt: wat("2027-07-01T09:10:00"), provider: " sandbox rail " } as any);
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T09:15:00")))), "the next reconciliation");
  equal([payment(state, "REF-SHARED").length, again.data.paymentId], [2, payment(state, "REF-SHARED").find((item) => item.customerId === a!.customerId)!.id], "evidence naming the lender's connection in other case joins its payment");
  // A settlement line that states only what it paid out, then the debit's own gross: one payment, at the gross.
  const { state: net, due } = liveFixture({ withFailure: false, merchantId: "net-then-gross" });
  addObservation(net, { reference: "PSK-NET", amountKobo: 2_487_500, batchReference: "B-NET", source: "settlement", customerId: due.customerId, eventId: "net-1", occurredAt: wat("2027-07-01T07:00:00") });
  accepted(request(net, () => reconcile(net, finance(wat("2027-07-01T07:05:00")))), "the settlement line");
  addObservation(net, { reference: "PSK-NET", amountKobo: 2_500_000, source: "webhook", customerId: due.customerId, dueItemId: due.id, eventId: "gross-1", occurredAt: wat("2027-07-01T07:10:00") });
  accepted(request(net, () => reconcile(net, finance(wat("2027-07-01T07:15:00")))), "the webhook");
  equal([payment(net, "PSK-NET").length, payment(net, "PSK-NET")[0]!.amountKobo, recordsOf(net, "observations").filter((item) => item.reference === "PSK-NET" && item.status === "resolved").length], [1, 2_500_000, 2], "the webhook's gross agrees with the net line and completes the payment");
});

// ---------- Item 4: rule R1 compares the payment's real currency and connection ----------
section("rule R1's currency and connection", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "r1-currency" });
  const [other, third] = recordsOf(state, "due-items").filter((item) => item.status === "scheduled" && item.id !== due.id);
  const t0 = wat("2027-07-01T07:00:00");
  addAttempt(state, due, { status: "succeeded", occurredAt: t0, providerReference: "REF-XYZ-1" });
  addAttempt(state, other!, { status: "succeeded", occurredAt: t0, providerReference: "REF-XYZ-2" });
  addAttempt(state, third!, { status: "succeeded", occurredAt: t0, providerReference: "REF-XYZ-3" });
  const post = (reference: string, target: TypedRecord<"due-items">, data: Record<string, unknown>) => postObservation(state, t0, { reference, amountKobo: target.amountKobo, customerId: target.customerId, data: { source: "card", eventId: reference, occurredAt: t0, ...data } });
  post("REF-XYZ-1", due, { provider: "Some Other Rail", providerConnection: "Some Other Rail", currency: "USD" });
  post("REF-XYZ-2", other!, { provider: "Some Other Rail", providerConnection: "Some Other Rail" });
  post("REF-XYZ-3", third!, {});
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T07:10:00")))), "the reconciliation");
  const [usd] = payment(state, "REF-XYZ-1"), [otherRail] = payment(state, "REF-XYZ-2"), [own] = payment(state, "REF-XYZ-3");
  equal([usd!.data.currency, usd!.data.providerConnection, usd!.status, allocationsOf(state, usd!.id).length, due.status], ["USD", "Some Other Rail", "unallocated", 0, "scheduled"], "a USD card payment on another rail is not applied");
  const [usdException] = exceptionsFor(state, usd!.id, "unallocated_payment");
  check(usdException && /USD/.test(String(usdException.data.notes)) && /Some Other Rail/.test(String(usdException.data.notes)), "and an exception says why");
  equal([otherRail!.status, allocationsOf(state, otherRail!.id).length, exceptionsFor(state, otherRail!.id, "unallocated_payment").length], ["unallocated", 0, 1], "a naira payment through another connection is held the same way");
  equal([own!.data.currency, own!.data.providerConnection, allocationsOf(state, own!.id)[0]?.data.rule, allocationsOf(state, own!.id)[0]?.data.automatic, third!.status], ["NGN", "Sandbox Rail", "R1", true, "paid"], "the lender's own naira evidence still matches with certainty");
  const refused = request(state, () => executeAction(state, finance(wat("2027-07-01T08:00:00")), { action: "manual_allocate", recordId: usd!.id, reason: "By hand", data: { dueItemId: due.id, amountKobo: due.amountKobo } }));
  check(!refused.ok && refused.status === 409 && /naira/.test(refused.message), "money in another currency cannot be applied to a naira instalment by hand either");
});

// ---------- Item 5: rule R4 reads instalment references on token boundaries ----------
section("rule R4's narration references", () => {
  const t0 = wat("2027-07-01T07:00:00");
  const run = (merchantId: string, arrange: (state: DomainState, customer: string, mandate: string) => void, narration: string, amountKobo = 2_500_000) => {
    const { state, customer, mandate, due } = liveFixture({ withFailure: false, merchantId });
    // The seed is dated from today: its instalment is moved clear of rule R5's window around the payment.
    due.data.dueDate = "2026-01-28";
    arrange(state, customer.id, mandate.id);
    addObservation(state, { reference: `TRF-${merchantId}`, amountKobo, source: "transfer", customerId: customer.id, eventId: merchantId, occurredAt: t0, narration });
    accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T07:10:00")))), `the reconciliation for ${merchantId}`);
    const [received] = payment(state, `TRF-${merchantId}`);
    const allocation = allocationsOf(state, received!.id)[0];
    return { state, received: received!, allocation, target: recordsOf(state, "due-items").find((item) => item.id === allocation?.data.dueItemId) };
  };
  const pair = (paid: boolean) => (state: DomainState, customer: string, mandate: string) => {
    postDue(state, t0, customer, mandate, "LN0042-1", 2_500_000, "2027-01-28");
    const tenth = postDue(state, t0, customer, mandate, "LN0042-10", 2_500_000, "2027-10-28");
    if (paid) { tenth.data.outstandingKobo = 0; tenth.status = "paid"; }
  };
  const paid = run("r4-paid", pair(true), "Loan LN0042-10 October instalment");
  equal(paid.allocation, undefined, "a narration naming the paid LN0042-10 is not applied to LN0042-1");
  const open = run("r4-open", pair(false), "LN0042-10");
  equal([open.target?.reference, open.allocation?.data.rule, open.allocation?.data.automatic], ["LN0042-10", "R4", true], "it names LN0042-10, not LN0042-1");
  const both = run("r4-both", pair(false), "LN0042-1 and LN0042-10");
  equal(both.allocation?.data.rule === "R4", false, "a narration naming two instalments is not matched automatically");
  const longest = run("r4-longest", (state, customer, mandate) => { postDue(state, t0, customer, mandate, "LN0077", 2_500_000, "2027-01-28"); postDue(state, t0, customer, mandate, "LN0077-10", 2_500_000, "2027-10-28"); }, "Payment for LN0077-10");
  equal(longest.target?.reference, "LN0077-10", "the longest reference wins where references overlap");
  const elsewhere = run("r4-elsewhere", (state, customer, mandate) => {
    postDue(state, t0, customer, mandate, "LN0099", 2_500_000, "2027-01-28");
    const someone = recordsOf(state, "customers").find((item) => item.id !== customer)!;
    const theirs = recordsOf(state, "mandates").find((item) => item.customerId === someone.id)!;
    postDue(state, t0, someone.id, theirs.id, "LN0099-5", 2_500_000, "2027-02-28");
  }, "LN0099-5");
  equal(elsewhere.allocation?.data.rule === "R4", false, "a narration naming another customer's LN0099-5 is not this payer's LN0099");
  const alike = run("r4-alike", (state, customer, mandate) => {
    postDue(state, t0, customer, mandate, "LN0055-2", 2_500_000, "2027-01-28");
    const someone = recordsOf(state, "customers").find((item) => item.id !== customer)!;
    const theirs = recordsOf(state, "mandates").find((item) => item.customerId === someone.id)!;
    postDue(state, t0, someone.id, theirs.id, "LN0055/2", 2_500_000, "2027-02-28");
  }, "LN0055-2");
  equal(alike.allocation?.data.rule === "R4", false, "a reference that is not unique across the lender is not matched automatically");
});

// ---------- Item 6: settlement batches keep every bank credit and count a collection once ----------
section("two statement credits for one batch", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "two-credits" });
  addObservation(state, { reference: "PSK-P2", amountKobo: 2_487_500, grossAmountKobo: 2_500_000, feeKobo: 12_500, batchReference: "B-P2", source: "settlement", customerId: due.customerId, dueItemId: due.id, eventId: "s", occurredAt: wat("2027-07-01T07:00:00") });
  const creditA = addObservation(state, { reference: "STMT-A", amountKobo: 2_487_500, batchReference: "B-P2", source: "statement", eventId: "st-a", occurredAt: wat("2027-07-02T07:00:00") });
  const creditB = addObservation(state, { reference: "STMT-B", amountKobo: 2_487_500, batchReference: "B-P2", source: "statement", eventId: "st-b", occurredAt: wat("2027-07-02T07:05:00") });
  const repeat = addObservation(state, { reference: "STMT-A", amountKobo: 2_487_500, batchReference: "B-P2", source: "statement", eventId: "st-a-again", occurredAt: wat("2027-07-02T07:10:00") });
  const report = close(state, "2027-07-02T09:00:00").data.report;
  const batch = recordsOf(state, "settlement-batches").find((item) => item.reference === "B-P2")!;
  equal([creditA.status, creditB.status, repeat.status], ["resolved", "resolved", "resolved"], "every credit resolves to the batch");
  equal([batch.data.statementNetKobo, batch.data.statementObservationId, batch.status], [4_975_000, creditA.id, "variance"], "the credits are summed, so the second one is a variance rather than a replacement");
  equal(repeat.data.duplicateStatementCredit, true, "the same bank line delivered again adds nothing");
  check(/2 statement credits/.test(String(batch.data.explanation)), "the explanation counts the credits");
  equal([report.variances.count, exceptionsFor(state, batch.id, "settlement_variance").length], [1, 1], "the close reports the variance and Finance has an exception");
  // Two credits that together pay the batch reconcile it.
  const { state: split, due: splitDue } = liveFixture({ withFailure: false, merchantId: "split-credits" });
  addObservation(split, { reference: "PSK-SPLIT", amountKobo: 2_487_500, grossAmountKobo: 2_500_000, feeKobo: 12_500, batchReference: "B-SP", source: "settlement", customerId: splitDue.customerId, dueItemId: splitDue.id, eventId: "s", occurredAt: wat("2027-07-01T07:00:00") });
  addObservation(split, { reference: "STMT-1", amountKobo: 1_000_000, batchReference: "B-SP", source: "statement", eventId: "st-1", occurredAt: wat("2027-07-02T07:00:00") });
  addObservation(split, { reference: "STMT-2", amountKobo: 1_487_500, batchReference: "B-SP", source: "statement", eventId: "st-2", occurredAt: wat("2027-07-02T07:05:00") });
  close(split, "2027-07-02T09:00:00");
  equal(recordsOf(split, "settlement-batches")[0]!.status, "reconciled", "two credits that sum to the net reconcile the batch");
});

section("one settlement line in two batches", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "line-in-two-batches" });
  addObservation(state, { reference: "PSK-P3", amountKobo: 2_487_500, grossAmountKobo: 2_500_000, feeKobo: 12_500, batchReference: "B-1", source: "settlement", customerId: due.customerId, dueItemId: due.id, eventId: "s1", occurredAt: wat("2027-07-01T07:00:00") });
  const again = addObservation(state, { reference: "PSK-P3", amountKobo: 2_487_500, grossAmountKobo: 2_500_000, feeKobo: 12_500, batchReference: "B-2", source: "settlement", customerId: due.customerId, dueItemId: due.id, eventId: "s2", occurredAt: wat("2027-07-02T07:00:00") });
  addObservation(state, { reference: "STMT-1", amountKobo: 2_487_500, batchReference: "B-1", source: "statement", eventId: "st1", occurredAt: wat("2027-07-02T08:00:00") });
  addObservation(state, { reference: "STMT-2", amountKobo: 2_487_500, batchReference: "B-2", source: "statement", eventId: "st2", occurredAt: wat("2027-07-02T08:00:00") });
  const report = close(state, "2027-07-02T09:00:00").data.report;
  const one = recordsOf(state, "settlement-batches").find((item) => item.reference === "B-1")!, two = recordsOf(state, "settlement-batches").find((item) => item.reference === "B-2")!;
  equal([one.status, one.data.grossKobo, two.data.grossKobo], ["reconciled", 2_500_000, 0], "the collection is counted in its first batch only");
  equal([again.status, again.data.duplicateSettlementLine, again.data.settlementBatchId, again.data.countedInBatchId], ["resolved", true, two.id, one.id], "the second line is evidence that names where it is counted");
  const [exception] = exceptionsFor(state, two.id, "settlement_variance");
  check(exception && /PSK-P3/.test(String(exception.data.notes)) && /B-1/.test(String(exception.data.notes)), "an exception says the line is already counted in B-1");
  equal([two.status, report.variances.batches.map((item: { reference: string }) => item.reference)], ["variance", ["B-2"]], "and the second batch's credit is a variance, not a second payout reconciled");
});

// ---------- Item 13: the unapplied rest of a partly allocated payment stays with Finance ----------
section("the rest of a partly allocated payment", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "partial-rest" });
  addObservation(state, { reference: "TRF-P1", amountKobo: 5_000_000, source: "transfer", customerId: due.customerId, eventId: "p1", occurredAt: wat("2027-07-01T10:00:00") });
  close(state, "2027-07-01T10:05:00");
  const [received] = payment(state, "TRF-P1");
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-01T11:00:00")), { action: "manual_allocate", recordId: received!.id, reason: "Part of it is for this instalment.", data: { dueItemId: due.id, amountKobo: 1_000_000 } })), "the partial allocation");
  equal([received!.status, paymentUnappliedKobo(received!)], ["partial", 4_000_000], "the payment holds ₦40,000.00 more");
  const report = close(state, "2027-07-05T07:00:00").data.report;
  const [unidentified] = payment(state, "SBX-UNIDENTIFIED-001");
  // The seed is dated from today, so its transfer's age is read, not assumed.
  const aged24 = [received!, unidentified!].filter((item) => Date.parse(wat("2027-07-05T07:00:00")) - paymentObservedAt(item) >= 24 * HOUR).length;
  equal([report.unallocated.count, report.unallocated.kobo, report.unallocated.olderThan24Hours], [2, 4_000_000 + paymentUnappliedKobo(unidentified!), aged24], "the close counts the rest with the unallocated money and its age");
  const [aged] = exceptionsFor(state, received!.id, "unallocated_payment");
  equal([aged?.status, aged?.amountKobo], ["open", 4_000_000], "the rest ages into an exception for Finance");
  check(pageReconciliation(state, "payments", { limit: 25 }, wat("2027-07-05T07:00:00")).items.some((item) => item.id === received!.id), "and is in Finance's payments queue");
  equal(close(state, "2027-07-05T08:00:00").data.report.openingUnallocated.kobo, report.unallocated.kobo, "the next close opens with it");
  // An overpayment's excess is in the queue and the totals, and keeps its own overpayment exception.
  const small = recordsOf(state, "due-items").find((item) => item.customerId === due.customerId && item.id !== due.id) ?? postDue(state, wat("2027-07-05T08:00:00"), due.customerId, String(due.data.mandateId), "DEMO-LOAN-9005", 1_500_000, "2027-08-01");
  addObservation(state, { reference: "TRF-OVER", amountKobo: small.amountKobo + 300_000, source: "transfer", customerId: due.customerId, eventId: "over", occurredAt: wat("2027-07-05T09:00:00") });
  close(state, "2027-07-05T09:05:00");
  const [over] = payment(state, "TRF-OVER");
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-05T10:00:00")), { action: "manual_allocate", recordId: over!.id, reason: "Pays this instalment with ₦3,000.00 over.", data: { dueItemId: small.id, amountKobo: small.amountKobo } })), "the overpayment");
  const later = close(state, "2027-07-08T07:00:00").data.report;
  equal([over!.status, later.unallocated.count], ["overpaid", 3], "the excess is counted with the unallocated money");
  equal([exceptionsFor(state, over!.id, "overpayment").length, exceptionsFor(state, over!.id, "unallocated_payment").length], [1, 0], "and has its overpayment exception, not a second one");
  check(pageReconciliation(state, "payments", { limit: 25 }, wat("2027-07-08T07:00:00")).items.some((item) => item.id === over!.id), "Finance can allocate or refund the excess from the queue");
});

// ---------- Item 14: "distinct payments" releases a suspected duplicate ----------
section("a suspected duplicate resolved as a separate payment", () => {
  const { state } = liveFixture({ withFailure: false, merchantId: "distinct-payments" });
  const due = recordsOf(state, "due-items").find((item) => item.status === "scheduled")!;
  addObservation(state, { reference: "TRF-D1", amountKobo: due.amountKobo, source: "transfer", customerId: due.customerId, eventId: "d1", occurredAt: wat("2027-07-01T10:00:00") });
  addObservation(state, { reference: "TRF-D2", amountKobo: due.amountKobo, source: "transfer", customerId: due.customerId, eventId: "d2", occurredAt: wat("2027-07-01T10:01:30") });
  close(state, "2027-07-01T10:05:00");
  const [second] = payment(state, "TRF-D2");
  equal(second!.status, "possible_duplicate", "the second transfer is held");
  const [held] = exceptionsFor(state, second!.id, "suspected_duplicate");
  const resolved = accepted(request(state, () => executeAction(state, finance(wat("2027-07-01T11:00:00")), { action: "resolve_exception", recordId: held!.id, reason: "Two separate transfers, confirmed with the customer.", data: { resolutionCode: "distinct_payments" } })), "the resolution");
  equal(second!.status, "unallocated", "the hold is released at once");
  check(/released/.test(resolved.message), "and the answer says so");
  const report = close(state, "2027-07-03T07:00:00").data.report;
  check(second!.status !== "possible_duplicate", "the next close does not hold it again");
  equal([report.possibleDuplicates.count, exceptionsFor(state, second!.id, "suspected_duplicate").length], [0, 1], "the close no longer reports it and no new exception is raised");
  equal(second!.data.duplicateReview?.resolutionCode, "distinct_payments", "Finance's decision is on the payment");
  // A confirmed duplicate stays held for its refund.
  const { state: kept } = liveFixture({ withFailure: false, merchantId: "confirmed-duplicate" });
  const keptDue = recordsOf(kept, "due-items").find((item) => item.status === "scheduled")!;
  addObservation(kept, { reference: "TRF-K1", amountKobo: keptDue.amountKobo, source: "transfer", customerId: keptDue.customerId, eventId: "k1", occurredAt: wat("2027-07-01T10:00:00") });
  addObservation(kept, { reference: "TRF-K2", amountKobo: keptDue.amountKobo, source: "transfer", customerId: keptDue.customerId, eventId: "k2", occurredAt: wat("2027-07-01T10:01:00") });
  close(kept, "2027-07-01T10:05:00");
  const [twin] = payment(kept, "TRF-K2");
  accepted(request(kept, () => executeAction(kept, finance(wat("2027-07-01T11:00:00")), { action: "resolve_exception", recordId: exceptionsFor(kept, twin!.id, "suspected_duplicate")[0]!.id, reason: "Charged twice.", data: { resolutionCode: "confirmed_duplicate_refund" } })), "the resolution");
  close(kept, "2027-07-02T07:00:00");
  equal(twin!.status, "possible_duplicate", "a confirmed duplicate keeps its hold until its refund is recorded");
});

// ---------- Review finding 1: a reversal through another connection name is held, never made a payment and reversed ----------
section("reversal evidence through another connection name", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "reversal-other-connection" });
  addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T06:00:00"), providerReference: "PSK-REV-9" });
  addObservation(state, { reference: "PSK-REV-9", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "w1", occurredAt: wat("2027-07-01T06:00:00") });
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T07:00:00")))), "the debit");
  const [debit] = payment(state, "PSK-REV-9");
  equal([debit!.status, due.status], ["allocated", "paid"], "the debit pays the instalment");
  // The provider's disputes report spells the connection another way.
  const reversal = addObservation(state, { reference: "PSK-REV-9", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "rev1", reversed: true, occurredAt: wat("2027-07-02T06:00:00"), provider: "Sandbox Rail Disputes" } as any);
  close(state, "2027-07-02T07:00:00");
  equal(payment(state, "PSK-REV-9").map((item) => item.id), [debit!.id], "no second payment is made and reversed");
  equal([reversal.status, debit!.data.reversalStatus, debit!.status, due.status], ["unresolved", "none", "allocated", "paid"], "the reversal is held, and the payment is not reversed on a guess");
  const [held] = exceptionsFor(state, reversal.id, "suspected_duplicate");
  check(held && held.status === "open" && held.data.owner === "Finance" && /came through Sandbox Rail Disputes\. No payment there has its reference/.test(String(held.data.notes)) && /but payment .* came through Sandbox Rail\./.test(String(held.data.notes)), `Finance has an exception that names both connections (${held?.data.notes})`);
  close(state, "2027-07-03T07:00:00");
  equal([reversal.status, exceptionsFor(state, reversal.id).length], ["unresolved", 1], "the next close keeps it held and raises nothing new");
  // Whatever Finance decides, reversal evidence never becomes a payment: once resolved, it is set aside.
  const resolved = accepted(request(state, () => executeAction(state, finance(wat("2027-07-03T09:00:00")), { action: "resolve_exception", recordId: held!.id, reason: "The disputes report reverses a collection on another account.", data: { resolutionCode: "distinct_payments" } })), "Finance's resolution");
  check(/set aside/.test(resolved.message), `the answer says what the next reconciliation does (${resolved.message})`);
  close(state, "2027-07-04T07:00:00");
  equal([reversal.status, reversal.data.resolutionKey, reversal.data.paymentId, reversal.data.resolvedTo, payment(state, "PSK-REV-9").length], ["resolved", "reversal_set_aside_after_review", undefined, `exception:${held!.id}`, 1], "it is set aside, and still no payment is made from it");
  // Reported through the payment's own connection, the reversal reverses it.
  addObservation(state, { reference: "PSK-REV-9", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "rev2", reversed: true, occurredAt: wat("2027-07-04T08:00:00") });
  close(state, "2027-07-04T09:00:00");
  equal([payment(state, "PSK-REV-9").length, debit!.data.reversalStatus, due.status, outstandingOf(due)], [1, "reversed", "in_dispute", due.amountKobo], "a reversal through the payment's connection reverses it");
  // A reversal that disagrees with the payment its key names is held the same way and set aside, never made a payment and reversed.
  const { state: other, due: otherDue } = liveFixture({ withFailure: false, merchantId: "reversal-conflict" });
  addAttempt(other, otherDue, { status: "succeeded", occurredAt: wat("2027-07-01T06:00:00"), providerReference: "PSK-REV-10" });
  addObservation(other, { reference: "PSK-REV-10", amountKobo: otherDue.amountKobo, source: "webhook", customerId: otherDue.customerId, eventId: "w1", occurredAt: wat("2027-07-01T06:00:00") });
  accepted(request(other, () => reconcile(other, finance(wat("2027-07-01T07:00:00")))), "the second debit");
  const part = addObservation(other, { reference: "PSK-REV-10", amountKobo: 1_000_000, source: "webhook", customerId: otherDue.customerId, eventId: "rev1", reversed: true, occurredAt: wat("2027-07-02T06:00:00") });
  accepted(request(other, () => reconcile(other, finance(wat("2027-07-02T07:00:00")))), "the reversal of another amount");
  const [partHeld] = exceptionsFor(other, part.id, "suspected_duplicate");
  check(partHeld && partHeld.status === "open" && /reports a reversal/.test(String(partHeld.data.notes)) && /it is set aside and reverses nothing/.test(String(partHeld.data.notes)), `its exception says it is set aside once resolved (${partHeld?.data.notes})`);
  accepted(request(other, () => executeAction(other, finance(wat("2027-07-02T09:00:00")), { action: "resolve_exception", recordId: partHeld!.id, reason: "Checked with the provider.", data: { resolutionCode: "confirmed_duplicate_refund" } })), "its resolution");
  accepted(request(other, () => reconcile(other, finance(wat("2027-07-02T10:00:00")))), "the reconciliation after it");
  equal([part.status, part.data.resolutionKey, payment(other, "PSK-REV-10").length, otherDue.status], ["resolved", "reversal_set_aside_after_review", 1, "paid"], "it is set aside and no payment is made from it");
});

section("payments saved before the connection keying", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "legacy-connection-key" });
  addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T06:00:00"), providerReference: "PSK-OLD-1" });
  const first = addObservation(state, { reference: "PSK-OLD-1", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "old-1", occurredAt: wat("2027-07-01T06:00:00") });
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T07:00:00")))), "the debit");
  const [legacy] = payment(state, "PSK-OLD-1");
  // As the build before the connection keying left it: its evidence named a connection that build ignored, and the payment took the provider's name.
  first.data.providerConnection = "Sandbox Rail Collections";
  equal([legacy!.data.providerConnection, legacy!.status, due.status], ["Sandbox Rail", "allocated", "paid"], "the payment is keyed on its evidence's provider");
  const named = { provider: "Sandbox Rail", providerConnection: "Sandbox Rail Collections" };
  const line = addObservation(state, { reference: "PSK-OLD-1", amountKobo: due.amountKobo - 12_500, grossAmountKobo: due.amountKobo, feeKobo: 12_500, batchReference: "B-OLD", source: "settlement", customerId: due.customerId, eventId: "old-line", occurredAt: wat("2027-07-02T06:00:00"), ...named } as any);
  const reversal = addObservation(state, { reference: "PSK-OLD-1", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "old-reversal", reversed: true, occurredAt: wat("2027-07-03T06:00:00"), ...named } as any);
  close(state, "2027-07-03T07:00:00");
  equal([payment(state, "PSK-OLD-1").length, line.data.paymentId, reversal.data.paymentId], [1, legacy!.id, legacy!.id], "later evidence through the connection its evidence named still finds it");
  equal([legacy!.data.settlementStatus, legacy!.data.reversalStatus, due.status, exceptionsFor(state, reversal.id).length], ["settled", "reversed", "in_dispute", 0], "its settlement line counts for it and its reversal reverses it");
});

// ---------- Review finding 2: a payer identified through a match later found wrong can be corrected ----------
section("a payer identified through a match later found wrong", () => {
  const { state } = liveFixture({ withFailure: false, merchantId: "payer-withdrawn" });
  const dues = recordsOf(state, "due-items").filter((item) => item.status === "scheduled");
  const a = dues[0]!, b = dues.find((item) => item.customerId !== a.customerId)!;
  const customerRef = (id: string) => recordsOf(state, "customers").find((item) => item.id === id)!.reference;
  // A transfer with no payer named, really from customer B.
  addObservation(state, { reference: "TRF-NOPAYER-7", amountKobo: b.amountKobo, source: "transfer", eventId: "np7", occurredAt: wat("2027-07-01T09:00:00") });
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T09:05:00")))), "the reconciliation");
  const [received] = payment(state, "TRF-NOPAYER-7");
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-01T10:00:00")), { action: "manual_allocate", recordId: received!.id, reason: "Payer confirmed by phone.", data: { dueItemId: a.id, amountKobo: Math.min(a.amountKobo, received!.amountKobo) } })), "Finance identifying customer A by mistake");
  const wrong = allocationsOf(state, received!.id).find((item) => item.status === "confirmed")!;
  equal([received!.customerId, received!.data.payerIdentification?.allocationId], [a.customerId, wrong.id], "the allocation identified A");
  const reviewed = accepted(request(state, () => executeAction(state, finance(wat("2027-07-02T10:00:00")), { action: "review_allocation", recordId: wrong.id, reason: "Wrong payer: the caller was B.", data: { correct: false } })), "the precision review marking the match wrong");
  equal([received!.customerId, received!.status, received!.data.payerIdentification, outstandingOf(a)], ["", "unallocated", undefined, a.amountKobo], "the identification made through that match is withdrawn with it");
  equal((received!.data.payerIdentificationHistory ?? []).map((item: any) => [item.customerId, item.allocationId, item.reason, item.withdrawnBy, item.withdrawnReason]), [[a.customerId, wrong.id, "Payer confirmed by phone.", "Sandbox Finance", "Wrong payer: the caller was B."]], "its history keeps who identified A, why, and who withdrew it and why");
  check(new RegExp(`Payer identification of customer ${customerRef(a.customerId)} withdrawn for payment TRF-NOPAYER-7`).test(String(reviewed.data.auditNote)) && /withdrawn/.test(reviewed.message), `the answer and the audit entry say so (${reviewed.data.auditNote})`);
  equal([wrong.status, wrong.customerId], ["superseded", a.customerId], "the wrong match keeps the customer it was applied for");
  // Finance now applies the money to its real payer.
  const real = accepted(request(state, () => executeAction(state, finance(wat("2027-07-02T11:00:00")), { action: "manual_allocate", recordId: received!.id, reason: "Real payer is B.", data: { dueItemId: b.id, amountKobo: Math.min(b.amountKobo, received!.amountKobo) } })), "the allocation to the real payer B");
  equal([received!.customerId, received!.data.payerIdentification?.customerId, b.status], [b.customerId, b.customerId, "paid"], "B is identified and paid");
  check(new RegExp(`Payer identified as customer ${customerRef(b.customerId)}`).test(String(real.data.auditNote)), "and the audit entry names B");
  close(state, "2027-07-03T07:00:00");
  // The wrong match, reviewed as correct again now that B is the payer, is refused with the reason.
  const again = request(state, () => executeAction(state, finance(wat("2027-07-03T08:00:00")), { action: "review_allocation", recordId: wrong.id, reason: "Second look.", data: { correct: true } }));
  check(!again.ok && again.status === 409 && /another customer/.test(again.message), `a match for the withdrawn payer is not applied again (${!again.ok && again.message})`);
  // Reviewed as correct while the payment still has no payer, the match is applied again and identifies its payer again.
  const { state: back } = liveFixture({ withFailure: false, merchantId: "payer-reinstated" });
  const backDue = recordsOf(back, "due-items").find((item) => item.status === "scheduled")!;
  addObservation(back, { reference: "TRF-NOPAYER-8", amountKobo: backDue.amountKobo, source: "transfer", eventId: "np8", occurredAt: wat("2027-07-01T09:00:00") });
  accepted(request(back, () => reconcile(back, finance(wat("2027-07-01T09:05:00")))), "the second reconciliation");
  const [second] = payment(back, "TRF-NOPAYER-8");
  accepted(request(back, () => executeAction(back, finance(wat("2027-07-01T10:00:00")), { action: "manual_allocate", recordId: second!.id, reason: "Payer confirmed by the narration.", data: { dueItemId: backDue.id, amountKobo: backDue.amountKobo } })), "the identification");
  const match = allocationsOf(back, second!.id)[0]!;
  accepted(request(back, () => executeAction(back, finance(wat("2027-07-02T10:00:00")), { action: "review_allocation", recordId: match.id, reason: "Looks wrong.", data: { correct: false } })), "the review marking it wrong");
  equal(second!.customerId, "", "the payer is withdrawn");
  const restored = accepted(request(back, () => executeAction(back, finance(wat("2027-07-02T11:00:00")), { action: "review_allocation", recordId: match.id, reason: "It was right after all.", data: { correct: true } })), "the review marking it correct again");
  equal([match.status, second!.customerId, second!.data.payerIdentification?.reason, backDue.status], ["confirmed", backDue.customerId, "It was right after all.", "paid"], "the match is applied again and identifies the payer again");
  check(/Payer identified as customer/.test(String(restored.data.auditNote)), "and the audit entry says so");
  // What an earlier build left: the match marked wrong but its payer kept, and the ladder's proposal of the payment for that
  // payer's other instalment. Reviewing the match as wrong again withdraws the payer and the proposal that rested on it.
  const { state: stuck } = liveFixture({ withFailure: false, merchantId: "payer-left-by-earlier-build" });
  const guessedDue = recordsOf(stuck, "due-items").find((item) => item.status === "scheduled")!;
  const otherOfGuessed = postDue(stuck, wat("2027-07-01T08:00:00"), guessedDue.customerId, String(guessedDue.data.mandateId), "DEMO-LOAN-9101", 1_000_000, "2027-08-01");
  addObservation(stuck, { reference: "TRF-NOPAYER-9", amountKobo: 1_000_000, source: "transfer", eventId: "np9", occurredAt: wat("2027-07-01T09:00:00") });
  accepted(request(stuck, () => reconcile(stuck, finance(wat("2027-07-01T09:05:00")))), "the third reconciliation");
  const [third] = payment(stuck, "TRF-NOPAYER-9");
  accepted(request(stuck, () => executeAction(stuck, finance(wat("2027-07-01T10:00:00")), { action: "manual_allocate", recordId: third!.id, reason: "Payer guessed.", data: { dueItemId: guessedDue.id, amountKobo: 1_000_000 } })), "the guessed identification");
  const guessed = allocationsOf(stuck, third!.id)[0]!;
  supersedeAllocation(stuck, finance(wat("2027-07-02T09:00:00")), guessed, "Precision audit marked this allocation wrong: guessed.");
  guessed.data.supersededByReview = true;
  const leftover = makeRecord(stuck, "allocations", { name: "Allocation R5", status: "proposed", customerId: guessedDue.customerId, amountKobo: 1_000_000, createdAt: wat("2027-07-02T09:05:00"), data: { paymentId: third!.id, dueItemId: otherOfGuessed.id, rule: "R5", confidence: "probable", automatic: false, reviewed: null } });
  Object.assign(third!, { status: "proposed" }); Object.assign(third!.data, { proposedDueItemId: otherOfGuessed.id, proposedAmountKobo: 1_000_000 });
  equal(third!.customerId, guessedDue.customerId, "the earlier build kept the guessed payer");
  accepted(request(stuck, () => executeAction(stuck, finance(wat("2027-07-02T10:00:00")), { action: "review_allocation", recordId: guessed.id, reason: "Still wrong: not this customer.", data: { correct: false } })), "the review of the match the earlier build left");
  equal([third!.customerId, third!.status, leftover.status], ["", "unallocated", "superseded"], "the payer and the proposal that rested on it are withdrawn");
});

// ---------- Review finding 3: a net-only settlement line applied before the debit's webhook ----------
section("a net-only line applied before the debit's gross", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "net-applied-then-gross" });
  addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T06:00:00"), providerReference: "PSK-NET-1" });
  addObservation(state, { reference: "PSK-NET-1", amountKobo: 2_487_500, batchReference: "B-NET-1", source: "settlement", eventId: "line-1", occurredAt: wat("2027-07-02T06:00:00") });
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-02T07:00:00")))), "the settlement line");
  const [line] = payment(state, "PSK-NET-1");
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-02T09:00:00")), { action: "manual_allocate", recordId: line!.id, reason: "Debit reference is this instalment.", data: { dueItemId: due.id, amountKobo: 2_487_500 } })), "Finance applying the net");
  equal([due.status, outstandingOf(due)], ["partially_paid", 12_500], "the instalment owes the fee the net left out");
  const webhook = addObservation(state, { reference: "PSK-NET-1", amountKobo: 2_500_000, source: "webhook", customerId: due.customerId, dueItemId: due.id, eventId: "w-1", occurredAt: wat("2027-07-01T06:00:00") });
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-03T07:00:00")))), "the debit's webhook");
  equal([payment(state, "PSK-NET-1").length, webhook.status, webhook.data.paymentId, exceptionsFor(state, webhook.id).length], [1, "resolved", line!.id, 0], "the gross agrees with the payment the net made, whatever is applied, and is not held as a duplicate");
  equal([line!.amountKobo, line!.data.grossUnstated, line!.status, paymentUnappliedKobo(line!)], [2_500_000, undefined, "partial", 12_500], "the gross raises the payment, and the difference is unapplied money for Finance");
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-03T09:00:00")), { action: "manual_allocate", recordId: line!.id, reason: "The rest of the debit.", data: { dueItemId: due.id, amountKobo: 12_500 } })), "Finance applying the rest");
  equal([due.status, line!.status, paymentUnappliedKobo(line!)], ["paid", "allocated", 0], "one collection pays the instalment once");
  // Once the payment's money went back, a larger gross is held as before.
  const { state: refunded, due: refundedDue } = liveFixture({ withFailure: false, merchantId: "net-refunded-then-gross" });
  addObservation(refunded, { reference: "PSK-NET-2", amountKobo: 2_487_500, batchReference: "B-NET-2", source: "settlement", eventId: "line-2", occurredAt: wat("2027-07-02T06:00:00") });
  accepted(request(refunded, () => reconcile(refunded, finance(wat("2027-07-02T07:00:00")))), "the second line");
  const [returned] = payment(refunded, "PSK-NET-2");
  accepted(request(refunded, () => executeAction(refunded, finance(wat("2027-07-02T08:00:00")), { action: "record_refund", recordId: returned!.id, reason: "Paid back.", data: { reference: "RF-***2" } })), "its refund");
  const late = addObservation(refunded, { reference: "PSK-NET-2", amountKobo: 2_500_000, source: "webhook", customerId: refundedDue.customerId, eventId: "w-2", occurredAt: wat("2027-07-01T06:00:00") });
  accepted(request(refunded, () => reconcile(refunded, finance(wat("2027-07-03T07:00:00")))), "the webhook after the refund");
  equal([late.status, returned!.amountKobo, exceptionsFor(refunded, late.id, "suspected_duplicate").length], ["unresolved", 2_487_500, 1], "a refunded payment is not raised: the gross is held for Finance");
  // Evidence the earlier rule held joins its payment at the next reconciliation, and its exception closes as its condition cleared.
  const { state: earlier, due: earlierDue } = liveFixture({ withFailure: false, merchantId: "net-held-earlier" });
  addObservation(earlier, { reference: "PSK-NET-3", amountKobo: 2_487_500, batchReference: "B-NET-3", source: "settlement", eventId: "line-3", occurredAt: wat("2027-07-02T06:00:00") });
  accepted(request(earlier, () => reconcile(earlier, finance(wat("2027-07-02T07:00:00")))), "the third line");
  const [third] = payment(earlier, "PSK-NET-3");
  accepted(request(earlier, () => executeAction(earlier, finance(wat("2027-07-02T08:00:00")), { action: "manual_allocate", recordId: third!.id, reason: "This instalment.", data: { dueItemId: earlierDue.id, amountKobo: 2_487_500 } })), "Finance applying the third net");
  const heldEarlier = addObservation(earlier, { reference: "PSK-NET-3", amountKobo: 2_500_000, source: "webhook", customerId: earlierDue.customerId, eventId: "w-3", occurredAt: wat("2027-07-01T06:00:00") });
  const stale = makeRecord(earlier, "exceptions", { name: "Suspected duplicate", status: "open", customerId: earlierDue.customerId, amountKobo: 2_500_000, createdAt: wat("2027-07-02T09:00:00"), data: { type: "suspected_duplicate", severity: "high", owner: "Finance", notes: "Held by the earlier rule.", linkedRecordId: heldEarlier.id, condition: `suspected_duplicate:${heldEarlier.id}:${third!.id}` } });
  const cleared = accepted(request(earlier, () => executeAction(earlier, finance(wat("2027-07-03T07:00:00")), { action: "daily_close" })), "the close after the rule changed");
  equal([heldEarlier.status, heldEarlier.data.paymentId, third!.amountKobo], ["resolved", third!.id, 2_500_000], "the held gross joins its payment");
  equal([stale.status, stale.data.resolutionCode], ["closed", "condition_cleared"], "its exception closes as its condition cleared");
  check(/possible duplicate: payment evidence PSK-NET-3 is now (recorded against payment|dealt with)/.test(String(cleared.data.auditNote)), `and the close's audit entry names it (${cleared.data.auditNote})`);
});

// ---------- Review finding 4: a gross below the amount received ----------
section("a zero or understated gross", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "zero-gross" });
  const csv = "reference,amount,grossAmountKobo,batchReference,source,eventId,occurredAt\nPSK-ZERO-1,1.00,0.00,B-Z,settlement,z-1,2027-07-01T06:00:00Z";
  const imported = importCsv(state, ctxAt(wat("2027-07-01T08:00:00"), "Finance"), { kind: "observations", csv, syntheticOnly: true, commit: true, identityColumn: "eventId", amountUnit: "naira" });
  equal([imported.valid, imported.invalid, imported.imported], [0, 1, 0], "a settlement line whose gross is below its amount is refused");
  check(/amount before fees cannot be less than the amount received/.test(imported.rows[0]!.message), `with the reason (${imported.rows[0]!.message})`);
  const low = request(state, () => postObservation(state, wat("2027-07-01T08:00:00"), { reference: "PSK-LOW-1", amountKobo: 2_487_500, data: { source: "settlement", grossAmountKobo: 2_487_499, batchReference: "B-Z", eventId: "low-1" } }));
  check(!low.ok && /amount before fees cannot be less than the amount received/.test(low.message), "and so is the same evidence posted as a record");
  accepted(request(state, () => postObservation(state, wat("2027-07-01T08:00:00"), { reference: "PSK-EVEN-1", amountKobo: 2_500_000, data: { source: "webhook", grossAmountKobo: 2_500_000, eventId: "even-1" } })), "a gross equal to the amount");
  // A 0-kobo payment an earlier build made from such a line waits for nobody: no exception opens and closes at every close.
  const zero = makeRecord(state, "payments", { name: "Canonical payment", status: "unallocated", reference: "PSK-ZERO-OLD", customerId: due.customerId, amountKobo: 0, createdAt: wat("2027-07-01T06:00:00"), data: { providerReference: "PSK-ZERO-OLD", providerConnection: "Sandbox Rail", currency: "NGN", channel: "direct_debit", observedAt: wat("2027-07-01T06:00:00"), virtualAccountCustomerId: due.customerId, collectionStatus: "succeeded", settlementStatus: "settled", reversalStatus: "none", refundStatus: "none", allocatedKobo: 0, canonical: true } });
  equal(paymentAwaitsAllocation(zero), false, "a payment with nothing unapplied does not wait for Finance");
  for (const day of ["2027-07-02", "2027-07-03", "2027-07-04"]) close(state, `${day}T07:00:00`);
  equal([exceptionsFor(state, zero.id).length, zero.status], [0, "unallocated"], "no close raises an exception for it");
  check(!pageReconciliation(state, "payments", { limit: 100 }, wat("2027-07-04T08:00:00")).items.some((item) => item.id === zero.id), "and it is not in Finance's payments queue");
});

// ---------- Review finding 5: money in another currency stays out of naira totals ----------
section("money in another currency", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "other-currency" });
  const first = close(state, "2027-07-01T08:00:00"), baseline = first.data.report.unallocated;
  const before = positionFor(state, due.customerId);
  addObservation(state, { reference: "CARD-USD-1", amountKobo: 100_000, source: "card", customerId: due.customerId, eventId: "usd-1", occurredAt: wat("2027-07-01T09:00:00"), currency: "USD" } as any);
  const closed = close(state, "2027-07-02T10:00:00"), report = closed.data.report;
  const [usd] = payment(state, "CARD-USD-1");
  equal([usd!.status, usd!.data.currency, exceptionsFor(state, usd!.id, "unallocated_payment").length], ["unallocated", "USD", 1], "the USD payment is held with its exception");
  equal(positionFor(state, due.customerId), before, "the customer's naira position leaves it out");
  // Second review finding 5: one rule. Every count of waiting payments counts every currency, since each is work for Finance;
  // money is summed in naira only, with other currencies listed beside it.
  equal([report.unallocated.count, report.unallocated.kobo], [baseline.count + 1, baseline.kobo], "the close counts it as waiting, and its naira total leaves its money out");
  equal((report.unallocated as any).otherCurrencies, { USD: { count: 1, amount: 100_000 } }, "and list it in its own currency");
  state.settings.unallocatedAlertThreshold = 0;
  const alert = buildAlerts(state, wat("2027-07-02T10:00:00")).find((item) => item.key === "unallocated_over_threshold");
  equal([report.unallocated.count, report.unallocated.olderThan24Hours, report.unallocated.olderThan24Hours, report.unallocated.olderThan24Hours], [report.reconciliation.unallocated, buildReports(state, wat("2027-07-02T10:00:00")).operational.unallocatedOlderThan24Hours, alert?.count, baseline.count + 1], "the close, its reconciliation, the reports and the alert count alike, the USD payment included");
  check(/unallocated \(\d+ older than 24 hours\), including USD 1,000\.00 in another currency, /.test(String(closed.data.summary)), `the close's summary names the money in another currency (${closed.data.summary})`);
  check(!report.customerPositionsChanged.some((item: { customerId: string }) => item.customerId === due.customerId), "no naira position changed");
  const next = close(state, "2027-07-02T11:00:00").data.report;
  equal([next.openingUnallocated.count, next.openingUnallocated.kobo, (next.openingUnallocated as any).otherCurrencies], [baseline.count + 1, baseline.kobo, { USD: { count: 1, amount: 100_000 } }], "the next close opens with it counted and listed the same way");
  equal("otherCurrencies" in baseline, false, "a close with naira alone lists no other currency");
  check(!/including/.test(String(first.data.summary)), "and its summary names none");
});

// ---------- Review finding 8: a line an earlier build counted in two batches ----------
section("a line an earlier build counted in two batches", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "counted-twice-earlier" });
  addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T06:00:00"), providerReference: "PSK-P3" });
  addObservation(state, { reference: "PSK-P3", amountKobo: 2_487_500, grossAmountKobo: 2_500_000, feeKobo: 12_500, batchReference: "B-1", source: "settlement", customerId: due.customerId, eventId: "l1", occurredAt: wat("2027-07-02T06:00:00") });
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-02T07:00:00")))), "the first line");
  const [first] = recordsOf(state, "settlement-batches");
  const [collected] = payment(state, "PSK-P3");
  // What the build before the fix left behind: the same collection also counted in batch B-2, which its statement credit reconciled.
  const line = addObservation(state, { reference: "PSK-P3", amountKobo: 2_487_500, grossAmountKobo: 2_500_000, feeKobo: 12_500, batchReference: "B-2", source: "settlement", customerId: due.customerId, eventId: "l2", occurredAt: wat("2027-07-03T06:00:00") });
  const second = makeRecord(state, "settlement-batches", { ...structuredClone(first!), id: undefined, reference: "B-2", name: "Settlement batch B-2", status: "reconciled", data: { ...structuredClone(first!.data), batchReference: "B-2", lineObservationIds: [line.id], linePaymentIds: [collected!.id] } } as any);
  delete second.data.providerIdentityKey; // Persisted before provider-scoped identities existed.
  Object.assign(line, { status: "resolved" }); Object.assign(line.data, { paymentId: collected!.id, settlementBatchId: second.id, resolutionKey: "canonical_provider_reference" });
  addObservation(state, { reference: "STMT-B2", amountKobo: 2_487_500, batchReference: "B-2", source: "statement", eventId: "s2", occurredAt: wat("2027-07-03T08:00:00") });
  close(state, "2027-07-04T07:00:00");
  const [raised] = exceptionsFor(state, second.id, "settlement_variance");
  check(raised && raised.status === "open" && /PSK-P3/.test(String(raised.data.notes)) && /B-1/.test(String(raised.data.notes)) && /B-2/.test(String(raised.data.notes)), `the later batch has an exception naming both batches (${raised?.data.notes})`);
  equal([raised?.data.condition, raised?.amountKobo, exceptionsFor(state, first!.id, "settlement_variance").length], [`settlement_variance:${second.id}:counted:${collected!.id}`, 2_500_000, 0], "raised once for the collection counted again, on the later batch only");
  close(state, "2027-07-05T07:00:00");
  equal(exceptionsFor(state, second.id, "settlement_variance").length, 1, "the next close raises nothing new");
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-05T09:00:00")), { action: "resolve_exception", recordId: raised!.id, reason: "The provider paid it out twice and recovered it.", data: { resolutionCode: "provider_corrected" } })), "Finance's resolution");
  close(state, "2027-07-06T07:00:00");
  equal(exceptionsFor(state, second.id, "settlement_variance").map((item) => item.status), ["resolved"], "the resolution holds while the condition does");
});

// ---------- Second review finding 1: a reversal of a payment no connection has seen waits for it ----------
section("a reversal reported before its payment", () => {
  const { state, due: fixtureDue } = liveFixture({ withFailure: false, merchantId: "reversal-before-payment" });
  addAttempt(state, fixtureDue, { status: "succeeded", occurredAt: wat("2027-07-01T06:30:00"), providerReference: "PSK-REV-7" });
  const importAt = (csv: string, at: string) => accepted(request(state, () => importCsv(state, finance(wat(at)), { kind: "observations", csv, syntheticOnly: true, commit: true, identityColumn: "eventId" })), `the file imported at ${at} WAT`);
  // The provider's disputes file spells the connection its own way, and is imported and closed before the debit's settlement file.
  importAt(`reference,amountKobo,source,provider,customerId,eventId,reversed\nPSK-REV-7,2500000,webhook,Sandbox Rail Disputes,${fixtureDue.customerId},disp-1,true`, "2027-07-02T06:00:00");
  // A committed import replaces the lender's records with its checked copy, so records are read again after each import.
  const byId = <T extends ValopayRecord>(record: T): T => state.records.find((item) => item.id === record.id) as T;
  let reversal = recordsOf(state, "observations").find((item) => item.data.eventId === "disp-1")!;
  close(state, "2027-07-02T07:30:00");
  equal([payment(state, "PSK-REV-7").length, reversal.status, exceptionsFor(state, reversal.id).length], [0, "unresolved", 0], "no payment is made from it only to be reversed, and it waits for its payment without an exception at first");
  close(state, "2027-07-03T07:30:00");
  const [unseen] = exceptionsFor(state, reversal.id, "provider_status_mismatch");
  check(unseen && unseen.status === "open" && unseen.data.owner === "Finance" && unseen.data.linkedKind === "observations" && unseen.amountKobo === 2_500_000 && unseen.data.condition === `provider_status_mismatch:${reversal.id}:unseen`
    && /reported a reversal of payment PSK-REV-7/.test(String(unseen.data.notes)) && /No payment with that reference has come through any connection/.test(String(unseen.data.notes)), `after 24 hours Finance has an exception saying the platform has not seen the payment (${unseen?.data.notes})`);
  close(state, "2027-07-04T07:30:00");
  equal([exceptionsFor(state, reversal.id).length, payment(state, "PSK-REV-7").length], [1, 0], "the next close raises nothing new and still makes no payment");
  // The debit's own settlement file arrives through the lender's connection.
  importAt(`reference,amountKobo,grossAmountKobo,feeKobo,batchReference,source,provider,customerId,eventId\nPSK-REV-7,2487500,2500000,12500,B-7,settlement,Sandbox Rail,${fixtureDue.customerId},set-1`, "2027-07-04T08:00:00");
  const cleared = closeAnswer(state, "2027-07-04T09:00:00");
  reversal = byId(reversal);
  const due = recordsOf(state, "due-items").find((item) => item.id === fixtureDue.id)!;
  const [debit] = payment(state, "PSK-REV-7");
  equal([payment(state, "PSK-REV-7").length, debit!.data.providerConnection, debit!.status, due.status], [1, "Sandbox Rail", "allocated", "paid"], "the debit becomes the only payment with the reference, and pays its instalment");
  const [held] = exceptionsFor(state, reversal.id, "suspected_duplicate");
  equal([reversal.status, held?.status, held?.data.condition], ["unresolved", "open", `suspected_duplicate:${reversal.id}:connection:${debit!.id}`], "the reversal is held for the debit's connection, not applied on a guess");
  check(/‘Same payment; evidence joined to it’: it reverses payment PSK-REV-7\. It is applied to that payment, which is reversed/.test(String(held?.data.notes)) && /Any other resolution: it is set aside and reverses nothing/.test(String(held?.data.notes)), `its exception says what each resolution does (${held?.data.notes})`);
  equal(resolutionCodesForException(held), ["confirmed_duplicate_refund", "distinct_payments", "applied_to_next", "same_payment", "not_money"], "the same payment is offered for a hold made for the connection alone");
  equal([byId(unseen!).status, byId(unseen!).data.resolutionCode], ["closed", "condition_cleared"], "the exception for the unseen payment closes once the payment is recorded");
  check(/provider status mismatch: a payment with reference PSK-REV-7 is now recorded/.test(String(cleared.data.auditNote)), `and the close's audit entry names it (${cleared.data.auditNote})`);
  // Finance checks with the provider: the disputes report reverses this debit.
  const joined = accepted(request(state, () => executeAction(state, finance(wat("2027-07-04T10:00:00")), { action: "resolve_exception", recordId: held!.id, reason: "The provider confirmed the disputes report reverses this debit.", data: { resolutionCode: "same_payment" } })), "Finance's resolution as the same payment");
  check(/applies this reversal evidence to payment PSK-REV-7, which is reversed/.test(joined.message), `the answer says what the next reconciliation does (${joined.message})`);
  close(state, "2027-07-05T07:30:00");
  equal([reversal.status, reversal.data.resolutionKey, reversal.data.paymentId, debit!.data.reversalStatus, debit!.status, due.status, outstandingOf(due)], ["resolved", "joined_after_review", debit!.id, "reversed", "returned", "in_dispute", 2_500_000], "the reversal joins the debit, which is reversed, and its instalment owes the money again in dispute");
  equal([payment(state, "PSK-REV-7").length, exceptionsFor(state, due.id, "customer_dispute").filter((item) => item.status === "open").length, billableCollection(state, debit!, wat("2027-08-15T12:00:00"))], [1, 1, false], "no second payment, someone owns the dispute, and the reversed collection is never billed");
  // The debit is now keyed under the disputes connection too: a repeat of the report finds it.
  const repeat = addObservation(state, { reference: "PSK-REV-7", amountKobo: 2_500_000, source: "webhook", customerId: due.customerId, eventId: "disp-2", reversed: true, occurredAt: wat("2027-07-05T08:00:00"), provider: "Sandbox Rail Disputes" } as any);
  close(state, "2027-07-05T09:00:00");
  equal([repeat.status, repeat.data.resolutionKey, repeat.data.paymentId, exceptionsFor(state, repeat.id).length], ["resolved", "canonical_provider_reference", debit!.id, 0], "later evidence through either spelling finds the payment");
});

section("a reversal and its payment in one pass, in either order", () => {
  const outcome = (order: "reversal first" | "debit first", reversalThrough: string) => {
    const { state, due } = liveFixture({ withFailure: false, merchantId: `one-pass-${order.split(" ")[0]}-${reversalThrough.length}` });
    addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T06:00:00"), providerReference: "PSK-REV-8" });
    const reversal = () => addObservation(state, { reference: "PSK-REV-8", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "rev", reversed: true, occurredAt: wat("2027-07-01T06:45:00"), provider: reversalThrough } as any);
    const debit = () => addObservation(state, { reference: "PSK-REV-8", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "debit", occurredAt: wat("2027-07-01T07:00:00") });
    const evidence = order === "reversal first" ? [reversal(), debit()][0]! : [debit(), reversal()][1]!;
    close(state, "2027-07-01T09:00:00");
    const made = payment(state, "PSK-REV-8");
    return JSON.stringify({ payments: made.map((item) => [item.data.providerConnection, item.status, item.data.reversalStatus]), due: [due.status, outstandingOf(due)], reversal: [evidence.status, evidence.data.resolutionKey ?? null, exceptionsFor(state, evidence.id).map((item) => `${item.data.type}:${String(item.data.condition).replace(/[0-9a-f-]{36}/g, "#")}`)] });
  };
  const other = outcome("reversal first", "Sandbox Rail Disputes");
  equal(other, outcome("debit first", "Sandbox Rail Disputes"), "through another connection, the order inside one import or close changes nothing");
  equal(JSON.parse(other).payments, [["Sandbox Rail", "allocated", "none"]], "the debit is the only payment, and the reversal makes none");
  equal(JSON.parse(other).reversal, ["unresolved", null, ["suspected_duplicate:suspected_duplicate:#:connection:#"]], "the reversal is held for Finance as a hold for its connection");
  const own = outcome("reversal first", "Sandbox Rail");
  equal(own, outcome("debit first", "Sandbox Rail"), "through the debit's own connection, the order changes nothing either");
  equal([JSON.parse(own).payments, JSON.parse(own).due[0], JSON.parse(own).reversal.slice(0, 2)], [[["Sandbox Rail", "returned", "reversed"]], "scheduled", ["resolved", "canonical_provider_reference"]], "the reversal reverses the debit's payment, which then pays nothing");
});

section("a reversal Finance sets aside while it waits", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "unseen-reversal-set-aside" });
  const reversal = addObservation(state, { reference: "PSK-NEVER-1", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "rev", reversed: true, occurredAt: wat("2027-07-01T06:00:00"), provider: "Sandbox Rail Disputes" } as any);
  close(state, "2027-07-02T07:00:00");
  const [unseen] = exceptionsFor(state, reversal.id, "provider_status_mismatch");
  check(unseen?.status === "open", "after 24 hours the reversal is Finance's exception");
  const answer = accepted(request(state, () => executeAction(state, finance(wat("2027-07-02T09:00:00")), { action: "resolve_exception", recordId: unseen!.id, reason: "The provider says the report was sent to the wrong lender.", data: { resolutionCode: "platform_state_confirmed" } })), "Finance's resolution");
  check(/set aside at the next reconciliation/.test(answer.message), `the answer says it is set aside (${answer.message})`);
  close(state, "2027-07-03T07:00:00");
  equal([reversal.status, reversal.data.resolutionKey, reversal.data.resolvedTo, payment(state, "PSK-NEVER-1").length], ["resolved", "reversal_set_aside_after_review", `exception:${unseen!.id}`, 0], "it is set aside once Finance has checked it, and no payment is made from it");
});

// ---------- Second review finding 2: evidence held only for its connection can join its payment, or be set aside ----------
section("evidence held for its connection alone", () => {
  const settle = (merchantId: string) => {
    const { state, due } = liveFixture({ withFailure: false, merchantId });
    addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T07:00:00"), providerReference: "PSK-SET-1" });
    addObservation(state, { reference: "PSK-SET-1", amountKobo: 2_500_000, source: "webhook", customerId: due.customerId, eventId: "w1", occurredAt: wat("2027-07-01T07:00:00") });
    accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T07:05:00")))), "the debit");
    // The provider's settlement file names the connection another way.
    const line = addObservation(state, { reference: "PSK-SET-1", amountKobo: 2_487_500, grossAmountKobo: 2_500_000, feeKobo: 12_500, batchReference: "B-1", source: "settlement", customerId: due.customerId, eventId: "s1", occurredAt: wat("2027-07-01T08:00:00"), provider: "Sandbox Rail Settlements" } as any);
    addObservation(state, { reference: "STMT-B-1", amountKobo: 2_487_500, batchReference: "B-1", source: "statement", eventId: "st1", occurredAt: wat("2027-07-01T09:00:00") });
    close(state, "2027-07-01T09:05:00");
    const [debit] = payment(state, "PSK-SET-1");
    return { state, due, line, debit: debit!, held: exceptionsFor(state, line.id, "suspected_duplicate")[0]! };
  };
  const joined = settle("held-line-joined");
  check(joined.held.status === "open" && joined.held.data.condition === `suspected_duplicate:${joined.line.id}:connection:${joined.debit.id}`, "the line is held for its connection alone");
  const notes = String(joined.held.data.notes);
  check(/‘Same payment; evidence joined to it’: it is more evidence of payment PSK-SET-1, with its connection spelled another way\. It is added to that payment, and later evidence through Sandbox Rail Settlements finds that payment too\./.test(notes)
    && /‘Not money; evidence set aside’: it records no money\. It is set aside, and no payment is made from it\./.test(notes) && /‘Distinct payments’: it is money of its own/.test(notes) && /‘Duplicate confirmed; refund required’: the payer was charged twice\./.test(notes), `its exception says what each resolution does (${notes})`);
  const answer = accepted(request(joined.state, () => executeAction(joined.state, finance(wat("2027-07-01T10:00:00")), { action: "resolve_exception", recordId: joined.held.id, reason: "The settlement file spells the connection its own way.", data: { resolutionCode: "same_payment" } })), "Finance's resolution as the same payment");
  check(/joins this payment evidence to payment PSK-SET-1 as more evidence of it: no second payment is made/.test(answer.message), `the answer says so (${answer.message})`);
  const report = close(joined.state, "2027-07-02T07:30:00").data.report;
  const batch = recordsOf(joined.state, "settlement-batches").find((item) => item.reference === "B-1")!;
  equal([payment(joined.state, "PSK-SET-1").length, joined.line.status, joined.line.data.resolutionKey, joined.line.data.paymentId, joined.debit.data.settlementStatus], [1, "resolved", "joined_after_review", joined.debit.id, "settled"], "the line joins the debit: one payment, settled");
  equal([batch.status, batch.data.linePaymentIds, batch.data.grossKobo, batch.data.netKobo, batch.data.statementNetKobo], ["pending", [joined.debit.id], 2_500_000, 2_487_500, undefined], "joining a payment does not authorise a different connection's same-named payout credit");
  addObservation(joined.state, { reference: "STMT-B-1-OWN", amountKobo: 2_487_500, batchReference: "B-1", source: "statement", eventId: "st-own", occurredAt: wat("2027-07-02T07:35:00"), provider: "Sandbox Rail Settlements" } as any);
  close(joined.state, "2027-07-02T07:40:00");
  equal([batch.status, batch.data.statementNetKobo], ["reconciled", 2_487_500], "the batch reconciles only with the settlement connection's own credit");
  equal([positionFor(joined.state, joined.due.customerId).unallocatedKobo, report.possibleDuplicates.count, billableCollection(joined.state, joined.debit, wat("2027-08-15T12:00:00"))], [0, 0, true], "no credit that does not exist, no duplicate, and the settled debit is billed");
  const again = addObservation(joined.state, { reference: "PSK-SET-1", amountKobo: 2_500_000, source: "webhook", customerId: joined.due.customerId, eventId: "w2", occurredAt: wat("2027-07-02T08:00:00"), provider: "Sandbox Rail Settlements" } as any);
  close(joined.state, "2027-07-02T09:00:00");
  equal([again.status, again.data.paymentId, exceptionsFor(joined.state, again.id).length], ["resolved", joined.debit.id, 0], "later evidence through that spelling finds the payment");
  // Set aside as not money: nothing is made from it, and the line re-imported with the debit's own spelling settles the debit.
  const aside = settle("held-line-not-money");
  accepted(request(aside.state, () => executeAction(aside.state, finance(wat("2027-07-01T10:00:00")), { action: "resolve_exception", recordId: aside.held.id, reason: "A copy of the line with a mistyped connection.", data: { resolutionCode: "not_money" } })), "Finance's resolution as not money");
  const corrected = addObservation(aside.state, { reference: "PSK-SET-1", amountKobo: 2_487_500, grossAmountKobo: 2_500_000, feeKobo: 12_500, batchReference: "B-1", source: "settlement", customerId: aside.due.customerId, eventId: "s2", occurredAt: wat("2027-07-01T08:00:00") });
  close(aside.state, "2027-07-02T07:30:00");
  equal([aside.line.status, aside.line.data.resolutionKey, aside.line.data.resolvedTo, aside.line.data.paymentId, payment(aside.state, "PSK-SET-1").length], ["resolved", "set_aside_after_review", `exception:${aside.held.id}`, undefined, 1], "the held line is set aside and no payment is made from it");
  equal([corrected.data.paymentId, aside.debit.data.settlementStatus, recordsOf(aside.state, "settlement-batches").find((item) => item.reference === "B-1")?.status, exceptionsFor(aside.state, aside.line.id).filter((item) => item.status === "open").length], [aside.debit.id, "settled", "reconciled", 0], "the corrected line settles the debit, and nothing is left open");
  // The other codes keep their meaning: distinct payments makes a payment of its own through that connection.
  const distinct = settle("held-line-distinct");
  accepted(request(distinct.state, () => executeAction(distinct.state, finance(wat("2027-07-01T10:00:00")), { action: "resolve_exception", recordId: distinct.held.id, reason: "A second collection.", data: { resolutionCode: "distinct_payments" } })), "distinct payments");
  close(distinct.state, "2027-07-02T07:30:00");
  equal([payment(distinct.state, "PSK-SET-1").map((item) => item.data.providerConnection), distinct.line.data.resolutionKey], [["Sandbox Rail", "Sandbox Rail Settlements"], "separate_payment_after_review"], "distinct payments still records a payment of its own");
});

section("the same payment is offered only where it applies", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "same-payment-refused" });
  const other = recordsOf(state, "due-items").find((item) => item.customerId !== due.customerId && item.status === "scheduled")!;
  addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T06:00:00"), providerReference: "PSK-CLASH-1" });
  addObservation(state, { reference: "PSK-CLASH-1", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "w1", occurredAt: wat("2027-07-01T06:00:00") });
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T07:00:00")))), "the debit");
  // Another payer's evidence under the debit's key, and another payer's through another connection: real conflicts.
  const sameKey = addObservation(state, { reference: "PSK-CLASH-1", amountKobo: due.amountKobo, source: "card", customerId: other.customerId, eventId: "c1", occurredAt: wat("2027-07-01T08:00:00") });
  const elsewhere = addObservation(state, { reference: "PSK-CLASH-1", amountKobo: due.amountKobo, source: "webhook", customerId: other.customerId, eventId: "c2", occurredAt: wat("2027-07-01T08:00:00"), provider: "Sandbox Rail Disputes" } as any);
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T09:00:00")))), "the conflicting evidence");
  const [debit] = payment(state, "PSK-CLASH-1");
  for (const [evidence, label] of [[sameKey, "under the payment's own key"], [elsewhere, "through another connection"]] as const) {
    const [held] = exceptionsFor(state, evidence.id, "suspected_duplicate");
    equal([held?.data.condition, resolutionCodesForException(held)], [`suspected_duplicate:${evidence.id}:${debit!.id}`, ["confirmed_duplicate_refund", "distinct_payments", "applied_to_next", "not_money"]], `a conflict ${label} offers no join`);
    // Tried on a copy: a refused request puts back a copy of the records it started from.
    const copy = structuredClone(state);
    const refused = request(copy, () => executeAction(copy, finance(wat("2027-07-01T10:00:00")), { action: "resolve_exception", recordId: held!.id, reason: "Same payment?", data: { resolutionCode: "same_payment" } }));
    check(!refused.ok && /^This resolution is not available for this exception now\. Choose one of these: ‘Duplicate confirmed; refund required’, ‘Distinct payments’, ‘Applied to the next instalment’ or ‘Not money; evidence set aside’\.$/.test(refused.message), `joining it is refused (${!refused.ok && refused.message})`);
  }
  check(/and it names another payer\. It was not added to that payment, and no payment was made from it\./.test(String(exceptionsFor(state, elsewhere.id)[0]?.data.notes)), "the other connection's hold names its conflict too");
  // A payment held by the ladder, not evidence, offers neither.
  addObservation(state, { reference: "PSK-CLASH-2", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, dueItemId: due.id, eventId: "w2", occurredAt: wat("2027-07-01T11:00:00") });
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T11:05:00")))), "a second payment for the paid instalment");
  const [second] = payment(state, "PSK-CLASH-2");
  equal([second!.status, resolutionCodesForException(exceptionsFor(state, second!.id, "suspected_duplicate")[0])], ["possible_duplicate", ["confirmed_duplicate_refund", "distinct_payments", "applied_to_next"]], "a held payment offers the existing codes only");
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-01T12:00:00")), { action: "resolve_exception", recordId: exceptionsFor(state, sameKey.id)[0]!.id, reason: "A card test, not money.", data: { resolutionCode: "not_money" } })), "a conflict resolved as not money");
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T13:00:00")))), "the reconciliation after it");
  equal([sameKey.status, sameKey.data.resolutionKey, payment(state, "PSK-CLASH-1").length], ["resolved", "set_aside_after_review", 1], "evidence set aside as not money never becomes a payment");
});

// ---------- Second review finding 3: a net-only settlement line and the gross that completes it ----------
section("a net-only settlement line in its batch", () => {
  const run = (merchantId: string, line: Record<string, unknown>) => {
    const { state, due } = liveFixture({ withFailure: false, merchantId });
    addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T06:30:00"), providerReference: "PSK-NET-1" });
    const net = addObservation(state, { reference: "PSK-NET-1", amountKobo: 2_487_500, batchReference: "B-NET", source: "settlement", customerId: due.customerId, eventId: "n1", occurredAt: wat("2027-07-01T07:00:00"), ...line } as any);
    addObservation(state, { reference: "STMT-B-NET", amountKobo: 2_487_500, batchReference: "B-NET", source: "statement", eventId: "st1", occurredAt: wat("2027-07-01T07:30:00") });
    const first = close(state, "2027-07-01T08:00:00").data.report;
    return { state, due, net, first, batch: () => recordsOf(state, "settlement-batches").find((item) => item.reference === "B-NET")! };
  };
  const totals = (batch: ValopayRecord) => [batch.status, batch.data.grossKobo, batch.data.feeKobo, batch.data.expectedFeeKobo, batch.data.netKobo];
  // The payout alone: its gross is not yet known, so it is counted as its net with no fee, and the payout matches the statement.
  const bare = run("net-line-bare", {});
  equal([totals(bare.batch()), bare.first.variances.count, exceptionsFor(bare.state, bare.batch().id).length], [["reconciled", 2_487_500, 0, 0, 2_487_500], 0, 0], "a line whose gross is not yet known does not put its batch in variance");
  // The payout with its fee: the gross is the payout and the fee.
  const withFee = run("net-line-with-fee", { feeKobo: 12_500 });
  equal([totals(withFee.batch()), withFee.first.variances.count], [["reconciled", 2_500_000, 12_500, 12_500, 2_487_500], 0], "a line with its fee counts the gross they make");
  // The debit's webhook then states the gross: the batch takes it.
  for (const { state, due, net, batch } of [bare, withFee]) {
    addObservation(state, { reference: "PSK-NET-1", amountKobo: 2_500_000, source: "webhook", customerId: due.customerId, eventId: "w1", occurredAt: wat("2027-07-01T09:00:00") });
    const report = close(state, "2027-07-02T07:30:00").data.report;
    const [collected] = payment(state, "PSK-NET-1");
    equal([collected!.amountKobo, totals(batch()), report.variances.count], [2_500_000, ["reconciled", 2_500_000, 12_500, 12_500, 2_487_500], 0], `the gross completes the payment and the batch that counts its line (${net.data.feeKobo === undefined ? "no fee stated" : "fee stated"})`);
    equal([net.data.countedGrossKobo, net.data.assumedFeeKobo, net.data.expectedFeeKobo, net.data.feeVarianceKobo], [2_500_000, 12_500, 12_500, undefined], "and the line records what it now adds");
  }
  // What an earlier build left: the payout counted as the gross with the schedule's fee taken off it, the batch in variance with an open exception.
  const earlier = run("net-line-earlier-build", {});
  const batch = earlier.batch();
  Object.assign(batch.data, { grossKobo: 2_487_500, feeKobo: 12_437, expectedFeeKobo: 12_437, netKobo: 2_475_063, feeVarianceKobo: 0 });
  Object.assign(earlier.net.data, { assumedFeeKobo: 12_437, expectedFeeKobo: 12_437 });
  delete earlier.net.data.countedGrossKobo;
  close(earlier.state, "2027-07-01T09:00:00");
  const [variance] = exceptionsFor(earlier.state, batch.id, "settlement_variance");
  equal([batch.status, variance?.status, variance?.data.condition], ["variance", "open", `settlement_variance:${batch.id}:statement:2487500:2475063:12437`], "the earlier build's totals leave the batch in variance with an exception");
  addObservation(earlier.state, { reference: "PSK-NET-1", amountKobo: 2_500_000, source: "webhook", customerId: earlier.due.customerId, eventId: "w1", occurredAt: wat("2027-07-01T09:30:00") });
  const completed = closeAnswer(earlier.state, "2027-07-02T07:30:00");
  equal([totals(batch), completed.record!.data.report.variances.count], [["reconciled", 2_500_000, 12_500, 12_500, 2_487_500], 0], "the gross that completes the payment corrects the batch, which reconciles");
  equal([variance!.status, variance!.data.resolutionCode], ["closed", "condition_cleared"], "and its exception closes as its condition cleared");
  check(/settlement difference: settlement batch B-NET is now reconciled/.test(String(completed.data.auditNote)), `the close's audit entry names it (${completed.data.auditNote})`);
});

// ---------- Second review finding 6: the allocation picker offers what a manual allocation of that payment accepts ----------
section("the allocation picker's choices for one payment", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "picker-choices" });
  // A transfer file with an instalment column and no customer column.
  addObservation(state, { reference: "TRF-NAMED-1", amountKobo: 1_000_000, source: "transfer", dueItemId: due.id, eventId: "n1", occurredAt: wat("2027-07-01T07:00:00") });
  addObservation(state, { reference: "TRF-USD-1", amountKobo: 100_000, source: "card", customerId: due.customerId, eventId: "u1", occurredAt: wat("2027-07-01T07:00:00"), currency: "USD" } as any);
  addObservation(state, { reference: "TRF-NOBODY-1", amountKobo: 1_000_000, source: "transfer", eventId: "b1", occurredAt: wat("2027-07-01T07:00:00") });
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T07:05:00")))), "the reconciliation");
  const dues = recordsOf(state, "due-items");
  const choicesFor = (reference: string) => {
    const [p] = payment(state, reference);
    const named = !p!.customerId && p!.data.dueItemId ? dues.find((item) => item.id === p!.data.dueItemId)?.customerId : undefined;
    const query = allocationChoices({ allocatable: "true", paymentId: p!.id, limit: 100 }, allocationPayer(p!, named));
    return { p: p!, page: query ? pageRecords(dues, query, "due-items") : { items: [], total: 0 } };
  };
  const accepts = (p: ValopayRecord, d: ValopayRecord) => { const copy = structuredClone(state); return request(copy, () => executeAction(copy, finance(wat("2027-07-01T08:00:00")), { action: "manual_allocate", recordId: p.id, reason: "Finance identified the payer.", data: { dueItemId: d.id, amountKobo: Math.min(paymentUnappliedKobo(p), outstandingOf(d)) } })).ok; };
  const named = choicesFor("TRF-NAMED-1");
  const open = dues.filter((d) => canTakeAllocation(d));
  equal([named.p.customerId, named.page.total, named.page.items.every((d) => d.customerId === due.customerId)], ["", open.filter((d) => d.customerId === due.customerId).length, true], "a payment whose evidence names an instalment but no payer is offered that customer's open instalments only");
  equal(open.filter((d) => accepts(named.p, d)).map((d) => d.id).sort(), named.page.items.map((d) => d.id).sort(), "every choice offered is accepted by a manual allocation, and every one accepted is offered");
  const nobody = choicesFor("TRF-NOBODY-1");
  equal(nobody.page.total, open.length, "a payment that names neither is offered every open instalment");
  equal(choicesFor("TRF-USD-1").page.total, 0, "a payment in another currency, which no allocation accepts, is offered none");
  check(open.every((d) => !accepts(choicesFor("TRF-USD-1").p, d)), "and indeed none accepts it");
  // A payment reconciliation holds for a renewed review of an earlier reversal decision takes no allocation (409) until
  // Finance resolves the review, so it too is offered none, whoever its payer.
  const held = state.records.find((item) => item.id === nobody.p.id)!;
  held.data.legacyReversalReviewIds = ["review-of-an-earlier-decision"];
  equal(choicesFor("TRF-NOBODY-1").page.total, 0, "a payment held for a renewed reversal review is offered none");
  check(open.every((d) => !accepts(held, d)), "and indeed none accepts it");
  delete held.data.legacyReversalReviewIds;
  equal(allocationChoices({ allocatable: "true", paymentId: named.p.id, customerId: "someone-else" }, { customerId: due.customerId }), undefined, "a list for another customer than the payer's offers none");
  check((() => { try { allocatableOnly("due-items", { paymentId: named.p.id }); return false; } catch (error) { return (error as { status?: number }).status === 400; } })(), "paymentId without allocatable=true is refused");
});

// ---------- Third review finding 1: Finance's resolution of evidence decides first, whatever arrives when ----------
/** A record as it now stands: a refused request puts back a copy of the records it started from. */
const live = <T extends ValopayRecord>(state: DomainState, record: T): T => state.records.find((item) => item.id === record.id) as T;
const isOpen = (item: ValopayRecord) => ["open", "assigned", "in_progress"].includes(item.status);
section("a waiting reversal Finance resolved before its payment arrived", () => {
  const run = (label: string, code: string, closeBetween: boolean, debitThrough = "Sandbox Rail") => {
    const { state, due } = liveFixture({ withFailure: false, merchantId: `unseen-resolved-${label}` });
    addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T06:30:00"), providerReference: "PSK-UNSEEN-1" });
    const reversal = addObservation(state, { reference: "PSK-UNSEEN-1", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "rev-1", reversed: true, occurredAt: wat("2027-07-01T07:00:00"), provider: "Sandbox Rail" } as any);
    close(state, "2027-07-02T08:00:00");
    const [unseen] = exceptionsFor(state, reversal.id, "provider_status_mismatch");
    const answer = request(state, () => executeAction(state, finance(wat("2027-07-02T09:00:00")), { action: "resolve_exception", recordId: unseen!.id, reason: "Checked with the provider.", data: { resolutionCode: code } }));
    if (closeBetween) close(state, "2027-07-02T10:00:00");
    const waiting = live(state, reversal);
    const waited = [waiting.status, waiting.data.resolutionKey ?? null, exceptionsFor(state, reversal.id).filter(isOpen).length];
    // The debit's own evidence arrives, before or after a reconciliation has read Finance's resolution.
    addObservation(state, { reference: "PSK-UNSEEN-1", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "debit-1", occurredAt: wat("2027-07-01T06:30:00"), provider: debitThrough } as any);
    close(state, "2027-07-03T08:00:00");
    close(state, "2027-07-04T08:00:00");
    const [debit] = payment(state, "PSK-UNSEEN-1"), after = live(state, reversal), instalment = live(state, due);
    return {
      unseen: live(state, unseen!), answer, waited,
      reversal: [after.status, after.data.resolutionKey ?? null, after.data.paymentId === debit?.id],
      debit: [debit?.data.providerConnection, debit?.status, debit?.data.reversalStatus],
      due: [instalment.status, outstandingOf(instalment)],
      raised: exceptionsFor(state, reversal.id).filter((item) => item.id !== unseen!.id).map((item) => item.data.type),
    };
  };
  const collected = { debit: ["Sandbox Rail", "allocated", "none"], due: ["paid", 0] }, reversed = { debit: ["Sandbox Rail", "returned", "reversed"], due: ["scheduled", 2_500_000] };
  // Platform state confirmed: set aside for good, with or without a reconciliation before the debit.
  for (const [label, closeBetween] of [["confirmed-close-between", true], ["confirmed-debit-first", false]] as const) {
    const outcome = run(label, "platform_state_confirmed", closeBetween);
    check(outcome.answer.ok && /set aside at the next reconciliation: it reverses nothing, even if its payment arrives later/.test(outcome.answer.value.message), `the answer says what the resolution does (${outcome.answer.ok && outcome.answer.value.message})`);
    equal([outcome.reversal, outcome.debit, outcome.due, outcome.raised], [["resolved", "reversal_set_aside_after_review", false], collected.debit, collected.due, []], `${label}: the reversal is set aside and the collection stands`);
  }
  // The debit through another spelling of the connection before the next reconciliation: still set aside, never held again.
  const spelled = run("confirmed-other-spelling", "platform_state_confirmed", false, "Sandbox Rail Settlements");
  equal([spelled.reversal, spelled.debit[0], spelled.debit[2], spelled.raised], [["resolved", "reversal_set_aside_after_review", false], "Sandbox Rail Settlements", "none", []], "a debit through another spelling does not hold the set-aside reversal again");
  // Provider state adopted: the reversal keeps waiting with no new exception, and reverses its payment when it arrives.
  const adopted = run("adopted", "provider_state_adopted", true);
  check(adopted.answer.ok && /keeps waiting for its payment, with no new exception/.test(adopted.answer.value.message), `the answer says it keeps waiting (${adopted.answer.ok && adopted.answer.value.message})`);
  equal([adopted.waited, adopted.reversal, adopted.debit, adopted.due, adopted.raised], [["unresolved", null, 0], ["resolved", "canonical_provider_reference", true], reversed.debit, reversed.due, []], "an adopted reversal waits, then reverses its payment");
  const adoptedElsewhere = run("adopted-other-spelling", "provider_state_adopted", true, "Sandbox Rail Settlements");
  equal([adoptedElsewhere.reversal, adoptedElsewhere.debit, adoptedElsewhere.raised], [["resolved", "adopted_after_review", true], ["Sandbox Rail Settlements", "returned", "reversed"], []], "and reverses it through another spelling of the connection too, with no new exception");
  // Escalated to the provider is not offered: the exception stays open while it is checked, and the payment then applies it.
  const escalated = run("escalated", "escalated_to_provider", true);
  check(!escalated.answer.ok && /^This resolution is not available for this exception now\. Choose one of these: ‘Provider state adopted’ or ‘Platform state confirmed’\.$/.test(escalated.answer.message), `escalated_to_provider is refused (${!escalated.answer.ok && escalated.answer.message})`);
  equal([escalated.unseen.status, escalated.unseen.data.resolutionCode, escalated.reversal, escalated.debit], ["closed", "condition_cleared", ["resolved", "canonical_provider_reference", true], reversed.debit], "the open exception closes when the payment arrives, which the reversal reverses");
  equal(resolutionCodesForException(adopted.unseen), ["provider_state_adopted", "platform_state_confirmed"], "the waiting reversal's exception offers only the two codes that decide it");
  // A resolution replaces the notes with its reason: the text the exception was raised with is read on the one left open.
  const notes = String(escalated.unseen.data.notes);
  check(/‘Platform state confirmed’: the provider says it reverses nothing of this lender’s\. It is set aside and reverses nothing, even if its payment arrives later\./.test(notes) && /‘Provider state adopted’: the provider confirms the reversal\. It keeps waiting for its payment, with no new exception, and reverses the payment when it arrives/.test(notes) && /leave this exception open while you check/.test(notes), `the exception says what each resolution does (${notes})`);
});

// ---------- FIN-02: several releases omitted rule versions while assigning different meanings ----------
section("a waiting reversal Finance resolved under an earlier build", () => {
  const run = (code: string) => {
    const { state, due } = liveFixture({ withFailure: false, merchantId: `unseen-earlier-${code}` });
    addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T06:30:00"), providerReference: "PSK-UNSEEN-1" });
    const reversal = addObservation(state, { reference: "PSK-UNSEEN-1", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "rev-1", reversed: true, occurredAt: wat("2027-07-01T07:00:00"), provider: "Sandbox Rail" } as any);
    close(state, "2027-07-02T08:00:00");
    const [unseen] = exceptionsFor(state, reversal.id, "provider_status_mismatch");
    // Actual pre-marker persisted shape, including the PR59 adopted code. There is no trustworthy release discriminator.
    Object.assign(unseen!, { status: "resolved", updatedAt: wat("2027-07-02T09:00:00") });
    Object.assign(unseen!.data, { resolutionCode: code, notes: "Checked with the provider.", resolvedBy: "finance@example.test", resolvedAt: wat("2027-07-02T09:00:00") });
    const historical = structuredClone(unseen!);
    const upgraded = closeAnswer(state, "2027-07-02T10:00:00");
    addObservation(state, { reference: "PSK-UNSEEN-1", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "debit-1", occurredAt: wat("2027-07-01T06:30:00"), provider: "Sandbox Rail" } as any);
    const later = closeAnswer(state, "2027-07-03T08:00:00");
    const [debit] = payment(state, "PSK-UNSEEN-1"), after = live(state, reversal), instalment = live(state, due);
    return {
      upgraded, later, reversal: [after.status, after.data.resolutionKey ?? null, after.data.resolvedTo === `exception:${unseen!.id}`],
      debit: [debit?.status, debit?.data.reversalStatus], due: [instalment.status, outstandingOf(instalment)],
      raised: exceptionsFor(state, reversal.id).filter((item) => item.id !== unseen!.id).map((item) => item.data.type),
      historicalUnchanged: JSON.stringify(live(state, unseen!)) === JSON.stringify(historical),
      reviews: exceptionsFor(state, reversal.id).filter((item) => item.data.legacyResolutionReview).length,
    };
  };
  for (const code of ["escalated_to_provider", "provider_state_adopted", "platform_state_confirmed"]) {
    const outcome = run(code);
    equal([outcome.reversal, outcome.debit, outcome.due, outcome.raised], [["unresolved", null, false], ["unallocated", "none"], ["in_dispute", 2_500_000], ["provider_status_mismatch"]], `${code}: ambiguity holds the reversal, receipt and instalment instead of inferring a decision`);
    equal([outcome.historicalUnchanged, outcome.reviews, outcome.upgraded.data.legacyReversalReviewsPending, outcome.later.data.legacyReversalReviewsPending], [true, 1, 1, 1], `${code}: history is unchanged and reruns retain one explicit review`);
    check(/Some earlier reversal decisions need a fresh Finance review\./.test(String(outcome.upgraded.data.auditNote)), `${code}: the audit explains the hold`);
  }
  // A resolution this build records carries its rule version, and follows the codes as they are now.
  const { state, due } = liveFixture({ withFailure: false, merchantId: "unseen-marked" });
  const reversal = addObservation(state, { reference: "PSK-UNSEEN-2", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "rev-2", reversed: true, occurredAt: wat("2027-07-01T07:00:00"), provider: "Sandbox Rail" } as any);
  close(state, "2027-07-02T08:00:00");
  const [unseen] = exceptionsFor(state, reversal.id, "provider_status_mismatch");
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-02T09:00:00")), { action: "resolve_exception", recordId: unseen!.id, reason: "The provider confirmed the reversal.", data: { resolutionCode: "provider_state_adopted" } })), "this build's resolution");
  equal(live(state, unseen!).data.resolutionRuleVersion, 1, "resolve_exception records the rules the resolution follows");
  close(state, "2027-07-02T10:00:00");
  equal([live(state, reversal).status, exceptionsFor(state, reversal.id).filter(isOpen).length], ["unresolved", 0], "and an adopted reversal keeps waiting for its payment");
  const edit = request(state, () => { const input: any = structuredClone(live(state, unseen!)); input.data.resolutionRuleVersion = null; validateRecord(state, finance(wat("2027-07-02T11:00:00")), "exceptions", { ...input, data: { ...input.data, resolutionRuleVersion: undefined } }, true); });
  check(!edit.ok && /rule version|This exception is resolved, so it cannot be edited\./.test(edit.message), `the record API cannot remove it (${!edit.ok && edit.message})`);
});

section("held evidence Finance resolved in one sitting", () => {
  const run = (label: string, chargebackCode: string, closeBetween: boolean) => {
    const { state, due } = liveFixture({ withFailure: false, merchantId: `one-sitting-${label}` });
    addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T06:30:00"), providerReference: "PSK-FILE-1" });
    addObservation(state, { reference: "PSK-FILE-1", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "w1", occurredAt: wat("2027-07-01T06:30:00") });
    close(state, "2027-07-01T07:30:00");
    // The provider's settlement file spells the connection its own way: the collection's line, and a chargeback row for it.
    const line = addObservation(state, { reference: "PSK-FILE-1", amountKobo: due.amountKobo - 12_500, grossAmountKobo: due.amountKobo, feeKobo: 12_500, batchReference: "B-FILE", source: "settlement", customerId: due.customerId, eventId: "s1", occurredAt: wat("2027-07-02T06:00:00"), provider: "Sandbox Rail Settlements" } as any);
    const chargeback = addObservation(state, { reference: "PSK-FILE-1", amountKobo: due.amountKobo, source: "settlement", customerId: due.customerId, eventId: "s1-rev", reversed: true, occurredAt: wat("2027-07-02T06:00:00"), provider: "Sandbox Rail Settlements" } as any);
    close(state, "2027-07-02T07:30:00");
    const resolve = (evidence: ValopayRecord, code: string, at: string) => accepted(request(state, () => executeAction(state, finance(wat(at)), { action: "resolve_exception", recordId: exceptionsFor(state, evidence.id, "suspected_duplicate")[0]!.id, reason: "Checked with the provider.", data: { resolutionCode: code } })), `${label}: ${code}`).message;
    const answer = resolve(chargeback, chargebackCode, "2027-07-02T09:00:00");
    if (closeBetween) close(state, "2027-07-02T10:00:00");
    resolve(line, "same_payment", "2027-07-02T11:00:00");
    close(state, "2027-07-03T07:30:00");
    const [collected] = payment(state, "PSK-FILE-1"), instalment = live(state, due);
    return { answer, chargeback: [chargeback.status, chargeback.data.resolutionKey, chargeback.data.paymentId ?? null], line: [line.status, line.data.resolutionKey], collected: [collected!.status, collected!.data.reversalStatus, collected!.data.settlementStatus], due: [instalment.status, outstandingOf(instalment)] };
  };
  for (const [label, code, closeBetween] of [["not-money", "not_money", false], ["distinct", "distinct_payments", false], ["close-between", "not_money", true]] as const) {
    const outcome = run(label, code, closeBetween);
    check(/set aside at the next reconciliation: no payment is made from it only to be reversed, and it reverses nothing, even if its payment is found later/.test(outcome.answer), `${label}: the answer says so (${outcome.answer})`);
    equal([outcome.chargeback, outcome.line, outcome.collected, outcome.due], [["resolved", "reversal_set_aside_after_review", null], ["resolved", "joined_after_review"], ["allocated", "none", "settled"], ["paid", 0]], `${label}: the chargeback Finance set aside reverses nothing, though the joined line keys the payment under its spelling`);
  }
  // Payment evidence in the same file: set aside as not money, or a payment of its own, whatever the join keys.
  const copies = (label: string, code: string) => {
    const { state, due } = liveFixture({ withFailure: false, merchantId: `one-sitting-copy-${label}` });
    addObservation(state, { reference: "PSK-FILE-2", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "w2", occurredAt: wat("2027-07-01T06:30:00") });
    close(state, "2027-07-01T07:30:00");
    const first = addObservation(state, { reference: "PSK-FILE-2", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "c1", occurredAt: wat("2027-07-02T06:00:00"), provider: "Sandbox Rail Settlements" } as any);
    const second = addObservation(state, { reference: "PSK-FILE-2", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "c2", occurredAt: wat("2027-07-02T06:00:00"), provider: "Sandbox Rail Settlements" } as any);
    close(state, "2027-07-02T07:30:00");
    for (const [evidence, resolution] of [[first, "same_payment"], [second, code]] as const) accepted(request(state, () => executeAction(state, finance(wat("2027-07-02T09:00:00")), { action: "resolve_exception", recordId: exceptionsFor(state, evidence.id, "suspected_duplicate")[0]!.id, reason: "Checked.", data: { resolutionCode: resolution } })), `${label}: ${resolution}`);
    close(state, "2027-07-03T07:30:00");
    return { first: first.data.resolutionKey, second: [second.status, second.data.resolutionKey], payments: payment(state, "PSK-FILE-2").map((item) => item.data.providerConnection) };
  };
  equal(copies("not-money", "not_money"), { first: "joined_after_review", second: ["resolved", "set_aside_after_review"], payments: ["Sandbox Rail"] }, "evidence Finance said is not money is set aside, never merged into the payment the join keyed under its spelling");
  equal(copies("distinct", "distinct_payments"), { first: "joined_after_review", second: ["resolved", "separate_payment_after_review"], payments: ["Sandbox Rail", "Sandbox Rail Settlements"] }, "evidence Finance said is money of its own becomes a payment of its own");
});

// ---------- Third review upgrade note: the join is offered only while the hold, as it stands now, is for the connection alone ----------
section("the same payment offered as the hold stands now", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "hold-as-it-stands" });
  const other = recordsOf(state, "due-items").find((item) => item.customerId !== due.customerId && item.status === "scheduled")!;
  addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T06:00:00"), providerReference: "PSK-OLD-1" });
  addObservation(state, { reference: "PSK-OLD-1", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "w1", occurredAt: wat("2027-07-01T06:00:00") });
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T07:00:00")))), "the debit");
  const clash = addObservation(state, { reference: "PSK-OLD-1", amountKobo: due.amountKobo, source: "webhook", customerId: other.customerId, eventId: "w2", occurredAt: wat("2027-07-01T08:00:00"), provider: "Sandbox Rail Disputes" } as any);
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T09:00:00")))), "the other payer's evidence");
  const [debit] = payment(state, "PSK-OLD-1");
  const [held] = exceptionsFor(state, clash.id, "suspected_duplicate");
  // An earlier build stored a hold through another connection as one for the connection alone, whatever else the evidence said.
  held!.data.condition = `suspected_duplicate:${clash.id}:connection:${debit!.id}`;
  const conflictCodes = ["confirmed_duplicate_refund", "distinct_payments", "applied_to_next", "not_money"];
  const copy = structuredClone(state);
  const refused = request(copy, () => executeAction(copy, finance(wat("2027-07-01T10:00:00")), { action: "resolve_exception", recordId: held!.id, reason: "Same payment?", data: { resolutionCode: "same_payment" } }));
  check(!refused.ok && refused.message === "This resolution is not available for this exception now. Choose one of these: ‘Duplicate confirmed; refund required’, ‘Distinct payments’, ‘Applied to the next instalment’ or ‘Not money; evidence set aside’.", `resolving it reads the hold as it stands now and refuses the join (${!refused.ok && refused.message})`);
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T11:00:00")))), "the next reconciliation");
  const stood = live(state, held!);
  equal([stood.status, stood.data.condition, resolutionCodesForException(stood)], ["open", `suspected_duplicate:${clash.id}:${debit!.id}`, conflictCodes], "the reconciliation re-derives the stored condition, so the join is no longer offered");
  check(/Update on [^:\n]*: the hold now stands as follows\.\n[^]*it names another payer\./.test(String(stood.data.notes)), `its notes say where the hold now stands (${stood.data.notes})`);
  // A hold for the connection alone that stops being one when its payment's payer is identified as another customer.
  const { state: payerless, due: owed } = liveFixture({ withFailure: false, merchantId: "hold-stops-being-connection" });
  const third = recordsOf(payerless, "due-items").find((item) => item.customerId !== owed.customerId && item.status === "scheduled")!;
  addObservation(payerless, { reference: "TRF-NOPAYER-5", amountKobo: 1_000_000, source: "transfer", eventId: "t1", occurredAt: wat("2027-07-01T07:00:00") });
  const named = addObservation(payerless, { reference: "TRF-NOPAYER-5", amountKobo: 1_000_000, source: "transfer", customerId: owed.customerId, eventId: "t2", occurredAt: wat("2027-07-01T07:30:00"), provider: "Bank Statement Feed" } as any);
  accepted(request(payerless, () => reconcile(payerless, finance(wat("2027-07-01T08:00:00")))), "the transfer and its bank report");
  const [transfer] = payment(payerless, "TRF-NOPAYER-5");
  const [hold] = exceptionsFor(payerless, named.id, "suspected_duplicate");
  equal([hold?.data.condition, resolutionCodesForException(hold).includes("same_payment")], [`suspected_duplicate:${named.id}:connection:${transfer!.id}`, true], "the report naming a payer is held for its connection alone while the transfer has none");
  accepted(request(payerless, () => executeAction(payerless, finance(wat("2027-07-01T09:00:00")), { action: "manual_allocate", recordId: transfer!.id, reason: "The narration names this customer.", data: { dueItemId: third.id, amountKobo: 1_000_000 } })), "Finance identifying another customer as the payer");
  const moved = live(payerless, hold!);
  equal([moved.data.condition, resolutionCodesForException(moved).includes("same_payment")], [`suspected_duplicate:${named.id}:${transfer!.id}`, false], "the allocation that identified another payer re-derives the hold, so the join is no longer offered");
  // Evidence that also agrees with a payment Finance made from other evidence under its own spelling: the join to the payment
  // its exception names is offered only while it still agrees with that payment.
  const { state: beside, due: owner } = liveFixture({ withFailure: false, merchantId: "hold-beside-its-own-key" });
  const another = recordsOf(beside, "due-items").find((item) => item.customerId !== owner.customerId && item.status === "scheduled")!;
  addObservation(beside, { reference: "TRF-NOPAYER-6", amountKobo: 1_000_000, source: "transfer", eventId: "t1", occurredAt: wat("2027-07-01T07:00:00") });
  const first = addObservation(beside, { reference: "TRF-NOPAYER-6", amountKobo: 1_000_000, source: "transfer", customerId: owner.customerId, eventId: "t2", occurredAt: wat("2027-07-01T07:30:00"), provider: "Bank Statement Feed" } as any);
  const second = addObservation(beside, { reference: "TRF-NOPAYER-6", amountKobo: 1_000_000, source: "transfer", customerId: owner.customerId, eventId: "t3", occurredAt: wat("2027-07-01T07:40:00"), provider: "Bank Statement Feed" } as any);
  accepted(request(beside, () => reconcile(beside, finance(wat("2027-07-01T08:00:00")))), "the transfer and the bank's two reports");
  accepted(request(beside, () => executeAction(beside, finance(wat("2027-07-01T08:30:00")), { action: "resolve_exception", recordId: exceptionsFor(beside, second.id, "suspected_duplicate")[0]!.id, reason: "A second transfer of the customer's.", data: { resolutionCode: "distinct_payments" } })), "the second report as money of its own");
  accepted(request(beside, () => reconcile(beside, finance(wat("2027-07-01T09:00:00")))), "the reconciliation that records it");
  const [unnamed, ownKey] = payment(beside, "TRF-NOPAYER-6");
  const [firstHold] = exceptionsFor(beside, first.id, "suspected_duplicate");
  equal([first.status, ownKey?.data.providerConnection, resolutionCodesForException(live(beside, firstHold!)).includes("same_payment")], ["unresolved", "Bank Statement Feed", true], "the first report still offers the join while it agrees with the transfer");
  accepted(request(beside, () => executeAction(beside, finance(wat("2027-07-01T09:30:00")), { action: "manual_allocate", recordId: unnamed!.id, reason: "The narration names this customer.", data: { dueItemId: another.id, amountKobo: 1_000_000 } })), "Finance identifying another customer as the transfer's payer");
  const downgraded = live(beside, firstHold!);
  equal([downgraded.data.condition, resolutionCodesForException(downgraded).includes("same_payment")], [`suspected_duplicate:${first.id}:${unnamed!.id}`, false], "once it no longer agrees with the transfer, the join is no longer offered");
  check(/no longer agrees with payment TRF-NOPAYER-6: it names another payer\. It cannot be added to that payment\. The next reconciliation records it as evidence of payment TRF-NOPAYER-6, which has its reference through Bank Statement Feed/.test(String(downgraded.data.notes)), `its notes say so (${downgraded.data.notes})`);
  const joinCopy = structuredClone(beside);
  check(!request(joinCopy, () => executeAction(joinCopy, finance(wat("2027-07-01T10:00:00")), { action: "resolve_exception", recordId: firstHold!.id, reason: "Same payment?", data: { resolutionCode: "same_payment" } })).ok, "and resolving it as the same payment is refused");
});

// ---------- Third review finding 2: a collection counted in two batches stays reported until Finance resolves it ----------
/**
 * Two batches whose statement credit or fees put B2 in variance, then a line of collection X1, which B1 counts, again in
 * B2, reported on B2's open exception (the carrier).
 */
function carriedReport(label: string, clearBy: "second credit" | "fee corrected") {
  const { state } = liveFixture({ withFailure: false, merchantId: `counted-twice-${label}` });
  const [d1, d2] = recordsOf(state, "due-items").filter((item) => item.status === "scheduled");
  const fee = (gross: number) => Math.min(100_000, Math.floor((gross * 50) / 10_000));
  for (const [d, ref] of [[d1!, "PSK-X1"], [d2!, "PSK-X2"]] as const) {
    addAttempt(state, d, { status: "succeeded", occurredAt: wat("2027-07-01T06:00:00"), providerReference: ref });
    addObservation(state, { reference: ref, amountKobo: d.amountKobo, source: "webhook", customerId: d.customerId, eventId: `w-${ref}`, occurredAt: wat("2027-07-01T06:00:00") });
  }
  addObservation(state, { reference: "PSK-X1", amountKobo: d1!.amountKobo - fee(d1!.amountKobo), grossAmountKobo: d1!.amountKobo, feeKobo: fee(d1!.amountKobo), batchReference: "B1", source: "settlement", customerId: d1!.customerId, eventId: "s-x1", occurredAt: wat("2027-07-01T07:00:00") });
  const statedFee = clearBy === "fee corrected" ? fee(d2!.amountKobo) + 50_000 : fee(d2!.amountKobo), net2 = d2!.amountKobo - statedFee;
  addObservation(state, { reference: "PSK-X2", amountKobo: net2, grossAmountKobo: d2!.amountKobo, feeKobo: statedFee, batchReference: "B2", source: "settlement", customerId: d2!.customerId, eventId: "s-x2", occurredAt: wat("2027-07-01T07:00:00") });
  addObservation(state, { reference: "STMT-B1", amountKobo: d1!.amountKobo - fee(d1!.amountKobo), batchReference: "B1", source: "statement", eventId: "st-b1", occurredAt: wat("2027-07-01T09:00:00") });
  // B2's statement credit arrives in two parts, or B2's fee differs from the schedule: either way B2 is in variance.
  if (clearBy === "second credit") addObservation(state, { reference: "STMT-B2-PART1", amountKobo: net2 - 1_000_000, batchReference: "B2", source: "statement", eventId: "st-b2-1", occurredAt: wat("2027-07-01T09:00:00") });
  close(state, "2027-07-01T10:00:00");
  const b2 = recordsOf(state, "settlement-batches").find((item) => item.reference === "B2")!;
  // The provider's next file lists collection X1, which B1 counts, again in B2: reported on B2's open exception.
  const again = addObservation(state, { reference: "PSK-X1", amountKobo: d1!.amountKobo - fee(d1!.amountKobo), grossAmountKobo: d1!.amountKobo, feeKobo: fee(d1!.amountKobo), batchReference: "B2", source: "settlement", customerId: d1!.customerId, eventId: "s-x1-again", occurredAt: wat("2027-07-02T07:00:00") });
  close(state, "2027-07-02T08:00:00");
  const [carrier] = exceptionsFor(state, b2.id, "settlement_variance");
  check(carrier?.status === "open" && String(carrier.data.notes).includes("Settlement line PSK-X1 (₦18,000.00) is already counted in settlement batch B1") && ((carrier.data.countedTwice ?? []) as string[]).includes(`settlement_variance:${b2.id}:line:${again.id}`), `${label}: B2's open exception carries the report (${carrier?.data.notes})`);
  return { state, b2, carrier: carrier!, again };
}
/** B2 leaves variance: the rest of its credit arrives, or Finance corrects the fee it typed. */
function leaveVariance(state: DomainState, b2: ValopayRecord, clearBy: "second credit" | "fee corrected") {
  if (clearBy === "second credit") addObservation(state, { reference: "STMT-B2-PART2", amountKobo: 1_000_000, batchReference: "B2", source: "statement", eventId: "st-b2-2", occurredAt: wat("2027-07-02T09:00:00") });
  else accepted(request(state, () => { b2.data.feeKobo = Number(b2.data.expectedFeeKobo); b2.data.netKobo = Number(b2.data.grossKobo) - Number(b2.data.feeKobo); }), "Finance correcting B2's fee");
}

section("a collection in two batches stays reported when its batch leaves variance", () => {
  const run = (label: string, clearBy: "second credit" | "fee corrected") => {
    const { state, b2, carrier } = carriedReport(label, clearBy);
    leaveVariance(state, b2, clearBy);
    close(state, "2027-07-03T08:00:00");
    close(state, "2027-07-04T08:00:00");
    return { state, b2, carrier: live(state, carrier) };
  };
  for (const [label, clearBy, status] of [["second-credit", "second credit", "reconciled"], ["fee-corrected", "fee corrected", "pending"]] as const) {
    const { state, b2, carrier } = run(label, clearBy);
    equal([b2.status, carrier.status, exceptionsFor(state, b2.id, "settlement_variance").length], [status, "open", 1], `${label}: B2 leaves variance, and its exception stays open for the collection counted twice`);
    check(/the batch is now .*It stays open for the collection the provider reports in two batches: resolve it once you have checked both payouts with the provider\./.test(String(carrier.data.notes)), `${label}: its notes say why it stays open (${carrier.data.notes})`);
    accepted(request(state, () => executeAction(state, finance(wat("2027-07-04T09:00:00")), { action: "resolve_exception", recordId: carrier.id, reason: "The provider recovered the second payout.", data: { resolutionCode: "provider_corrected" } })), `${label}: Finance's resolution`);
    close(state, "2027-07-05T08:00:00");
    equal(exceptionsFor(state, b2.id, "settlement_variance").map((item) => item.status), ["resolved"], `${label}: Finance's resolution settles it, and nothing is raised again`);
  }
  // A report an earlier build closed with its batch's statement exception is raised again, on its own.
  const { state, b2, carrier } = run("lost-by-earlier-build", "second credit");
  Object.assign(carrier, { status: "closed" }); Object.assign(carrier.data, { resolutionCode: "condition_cleared" }); delete carrier.data.countedTwice;
  close(state, "2027-07-05T08:00:00");
  const again = recordsOf(state, "observations").find((item) => item.data.eventId === "s-x1-again")!;
  const raised = exceptionsFor(state, b2.id, "settlement_variance").filter(isOpen);
  equal(raised.map((item) => item.data.condition), [`settlement_variance:${b2.id}:line:${again.id}`], "the report the earlier build closed is raised again, once");
  close(state, "2027-07-06T08:00:00");
  equal(exceptionsFor(state, b2.id, "settlement_variance").filter(isOpen).length, 1, "and not again at the next close");
});

// ---------- Fourth review finding 1: a report an earlier build carried only in its notes ----------
section("a counted-twice report an earlier build carried only in its notes", () => {
  // What the earlier build left: the report added to B2's open exception as a dated line, with no countedTwice.
  const earlier = (label: string) => {
    const carried = carriedReport(label, "second credit");
    delete carried.carrier.data.countedTwice;
    return { ...carried, condition: `settlement_variance:${carried.b2.id}:line:${carried.again.id}` };
  };
  // Finance resolved it on the earlier build, whose resolution replaced its notes with Finance's reason: that settles the report.
  const resolved = earlier("notes-resolved");
  accepted(request(resolved.state, () => executeAction(resolved.state, finance(wat("2027-07-02T09:00:00")), { action: "resolve_exception", recordId: resolved.carrier.id, reason: "Checked both payouts with the provider: the second listing is a reporting error.", data: { resolutionCode: "provider_corrected" } })), "Finance's resolution");
  delete live(resolved.state, resolved.carrier).data.resolutionRuleVersion;
  close(resolved.state, "2027-07-03T08:00:00");
  close(resolved.state, "2027-07-04T08:00:00");
  equal(exceptionsFor(resolved.state, resolved.b2.id, "settlement_variance").map((item) => [item.status, item.data.condition]), [["resolved", live(resolved.state, resolved.carrier).data.condition]], "a report Finance resolved with the exception that carried it is not raised again after the upgrade");
  // The provider lists X1 in B2 once more: that line is reported on its own, and its report never takes the settled one.
  const third = addObservation(resolved.state, { reference: "PSK-X1", amountKobo: resolved.again.amountKobo, grossAmountKobo: resolved.again.data.grossAmountKobo, feeKobo: resolved.again.data.feeKobo, batchReference: "B2", source: "settlement", customerId: resolved.again.customerId, eventId: "s-x1-third", occurredAt: wat("2027-07-04T07:00:00") });
  close(resolved.state, "2027-07-05T08:00:00");
  close(resolved.state, "2027-07-06T08:00:00");
  equal(exceptionsFor(resolved.state, resolved.b2.id, "settlement_variance").filter(isOpen).map((item) => [item.data.condition, item.data.countedTwice]), [[`settlement_variance:${resolved.b2.id}:line:${third.id}`, undefined]], "a later line of the same collection is reported on its own, carrying nothing it did not raise");
  // Still open at the upgrade: the first reconciliation lists the report in countedTwice, as this build carries one.
  const open = earlier("notes-open");
  close(open.state, "2027-07-02T10:00:00");
  equal([live(open.state, open.carrier).status, live(open.state, open.carrier).data.countedTwice], ["open", [open.condition]], "the first reconciliation lists the report its notes carry");
  leaveVariance(open.state, open.b2, "second credit");
  close(open.state, "2027-07-03T08:00:00");
  const kept = live(open.state, open.carrier);
  equal([live(open.state, open.b2).status, kept.status, exceptionsFor(open.state, open.b2.id, "settlement_variance").length], ["reconciled", "open", 1], "so it stays open for Finance once B2 leaves variance, and nothing else is raised");
  check(/It stays open for the collection the provider reports in two batches/.test(String(kept.data.notes)), `its notes say why it stays open (${kept.data.notes})`);
  accepted(request(open.state, () => executeAction(open.state, finance(wat("2027-07-03T09:00:00")), { action: "resolve_exception", recordId: kept.id, reason: "The provider recovered the second payout.", data: { resolutionCode: "provider_corrected" } })), "Finance's resolution after the upgrade");
  close(open.state, "2027-07-04T08:00:00");
  equal(exceptionsFor(open.state, open.b2.id, "settlement_variance").map((item) => item.status), ["resolved"], "and Finance's resolution settles it");
});

// ---------- Third review finding 3: a batch an earlier build counted wrongly is corrected ----------
section("a batch an earlier build counted before the gross arrived", () => {
  const earlier = (label: string) => {
    const { state, due } = liveFixture({ withFailure: false, merchantId: `recount-${label}` });
    addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T06:30:00"), providerReference: "PSK-NET-9" });
    const line = addObservation(state, { reference: "PSK-NET-9", amountKobo: 2_487_500, batchReference: "B-NET-9", source: "settlement", customerId: due.customerId, eventId: "n1", occurredAt: wat("2027-07-01T07:00:00") });
    addObservation(state, { reference: "STMT-B-NET-9", amountKobo: 2_487_500, batchReference: "B-NET-9", source: "statement", eventId: "st1", occurredAt: wat("2027-07-01T07:30:00") });
    close(state, "2027-07-01T08:00:00");
    const batch = recordsOf(state, "settlement-batches").find((item) => item.reference === "B-NET-9")!;
    const [collected] = payment(state, "PSK-NET-9");
    // What the earlier build left: the payout counted as the gross with the schedule's fee taken off it, the batch in variance
    // with an exception, and the debit's gross raising the payment only.
    Object.assign(batch, { status: "variance" });
    Object.assign(batch.data, { grossKobo: 2_487_500, feeKobo: 12_437, expectedFeeKobo: 12_437, netKobo: 2_475_063, feeVarianceKobo: 0, explanation: "Statement credit differs from gross settlement lines less recorded fees." });
    Object.assign(line.data, { assumedFeeKobo: 12_437, expectedFeeKobo: 12_437 }); delete line.data.countedGrossKobo;
    const variance = raiseException(state, finance(wat("2027-07-01T08:00:00")), "settlement_variance", { linkedRecordId: batch.id, notes: "Statement credit differs from gross settlement lines less recorded fees.", condition: `settlement_variance:${batch.id}:statement:2487500:2475063:12437` });
    const webhook = addObservation(state, { reference: "PSK-NET-9", amountKobo: 2_500_000, source: "webhook", customerId: due.customerId, eventId: "w1", occurredAt: wat("2027-07-01T09:00:00") });
    collected!.amountKobo = 2_500_000; delete collected!.data.grossUnstated;
    Object.assign(webhook, { status: "resolved" }); Object.assign(webhook.data, { paymentId: collected!.id, resolutionKey: "canonical_provider_reference" });
    return { state, batch, line, variance };
  };
  const totals = (batch: ValopayRecord) => [batch.status, batch.data.grossKobo, batch.data.feeKobo, batch.data.expectedFeeKobo, batch.data.netKobo];
  const { state, batch, line, variance } = earlier("corrected");
  const completed = closeAnswer(state, "2027-07-02T08:00:00");
  equal([totals(batch), completed.record!.data.report.variances.count], [["reconciled", 2_500_000, 12_500, 12_500, 2_487_500], 0], "the next close counts the line again with its payment's gross, and the batch reconciles");
  equal([line.data.countedGrossKobo, line.data.assumedFeeKobo, line.data.expectedFeeKobo], [2_500_000, 12_500, 12_500], "the line records what it now adds");
  equal([variance.status, variance.data.resolutionCode], ["closed", "condition_cleared"], "and the batch's exception closes as its condition cleared");
  check(/settlement difference: settlement batch B-NET-9 is now reconciled/.test(String(completed.data.auditNote)), `the close's audit entry names it (${completed.data.auditNote})`);
  const before = JSON.stringify(recordsOf(state, "settlement-batches"));
  close(state, "2027-07-03T08:00:00");
  equal(JSON.stringify(recordsOf(state, "settlement-batches")), before, "a later close counts it no further");
  // A batch Finance already corrected by hand is left as Finance set it.
  const { state: byHand, batch: handBatch } = earlier("corrected-by-hand");
  Object.assign(handBatch.data, { grossKobo: 2_500_000, feeKobo: 12_500, netKobo: 2_487_500 });
  close(byHand, "2027-07-02T08:00:00");
  equal(totals(handBatch), ["reconciled", 2_500_000, 12_500, 12_437, 2_487_500], "the totals Finance typed are not corrected again");
});

// ---------- Third review finding 4: amounts in the payment's own currency ----------
section("amounts written in the payment's own currency", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "own-currency-text" });
  addObservation(state, { reference: "CARD-USD-9", amountKobo: 100_000, source: "card", customerId: due.customerId, eventId: "usd-9", occurredAt: wat("2027-07-01T09:00:00"), currency: "USD" } as any);
  addObservation(state, { reference: "PSK-USD-9", amountKobo: 99_500, grossAmountKobo: 100_000, feeKobo: 500, batchReference: "B-U1", source: "settlement", customerId: due.customerId, eventId: "usd-line-1", occurredAt: wat("2027-07-01T09:00:00"), currency: "USD" } as any);
  addObservation(state, { reference: "PSK-USD-9", amountKobo: 99_500, grossAmountKobo: 100_000, feeKobo: 500, batchReference: "B-U2", source: "settlement", customerId: due.customerId, eventId: "usd-line-2", occurredAt: wat("2027-07-02T09:00:00"), currency: "USD" } as any);
  close(state, "2027-07-02T10:00:00");
  const [card] = payment(state, "CARD-USD-9");
  const refund = accepted(request(state, () => executeAction(state, finance(wat("2027-07-02T11:00:00")), { action: "record_refund", recordId: card!.id, reason: "Card refund made outside Valo Pay.", data: { reference: "RF-***9" } })), "the USD refund");
  equal([refund.message, refund.data.refundedKobo], ["External refund of USD 1,000.00 recorded: the money this payment had not allocated. No money moved.", 100_000], "the refund's answer writes its amount in dollars");
  const two = recordsOf(state, "settlement-batches").find((item) => item.reference === "B-U2")!;
  check(exceptionsFor(state, two.id, "settlement_variance").some((item) => String(item.data.notes).includes("Settlement line PSK-USD-9 (USD 1,000.00) is already counted in settlement batch B-U1")), "a USD line counted in two batches is reported in dollars");
});

// ---------- Third review finding 5: the customer's positions list money in another currency beside the naira ----------
section("the customer timeline's position beside the dispute pack's", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "timeline-currencies" });
  equal("unallocatedOtherCurrencies" in customerTimeline(state, due.customerId).position, false, "a position with naira alone lists no other currency");
  addObservation(state, { reference: "CARD-USD-8", amountKobo: 100_000, source: "card", customerId: due.customerId, eventId: "usd-8", occurredAt: wat("2027-07-01T09:00:00"), currency: "USD" } as any);
  close(state, "2027-07-02T10:00:00");
  const position = customerTimeline(state, due.customerId).position;
  const pack = buildDisputePack(state, finance(wat("2027-07-02T11:00:00")), due.customerId);
  equal([position.unallocatedKobo, position.unallocatedOtherCurrencies], [pack.position.unallocatedKobo, { USD: { count: 1, amount: 100_000 } }], "the timeline lists the USD payment beside its naira credit");
  equal(position.unallocatedOtherCurrencies, pack.position.unallocatedOtherCurrencies, "as the dispute pack does");
});

// ---------- Third review, a residual: an exception about money in another currency names that currency ----------
section("exceptions about money in another currency", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "exception-currencies" });
  const t0 = wat("2027-07-01T09:00:00");
  // A USD and a EUR card payment, a USD reversal of a payment no connection has seen, a naira transfer and a USD settlement line.
  addObservation(state, { reference: "CARD-USD-7", amountKobo: 100_000, source: "card", customerId: due.customerId, eventId: "usd-7", occurredAt: t0, currency: "USD" } as any);
  addObservation(state, { reference: "CARD-EUR-7", amountKobo: 2_000, source: "card", customerId: due.customerId, eventId: "eur-7", occurredAt: t0, currency: "eur " } as any);
  addObservation(state, { reference: "PSK-UNSEEN-7", amountKobo: 7_000, source: "webhook", customerId: due.customerId, eventId: "rev-7", reversed: true, occurredAt: wat("2027-06-28T09:00:00"), currency: "USD" } as any);
  addObservation(state, { reference: "TRF-NGN-7", amountKobo: 500_000, source: "transfer", customerId: due.customerId, eventId: "ngn-7", occurredAt: t0 });
  addObservation(state, { reference: "PSK-USD-7", amountKobo: 99_500, grossAmountKobo: 100_000, feeKobo: 500, batchReference: "B-U7", source: "settlement", customerId: due.customerId, eventId: "usd-line-7a", occurredAt: t0, currency: "USD" } as any);
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T10:00:00")))), "the first reconciliation");
  // Evidence in EUR under the naira transfer's reference is held for Finance, and the USD line comes again in another batch.
  const held = addObservation(state, { reference: "TRF-NGN-7", amountKobo: 300_000, source: "transfer", customerId: due.customerId, eventId: "eur-held-7", occurredAt: t0, currency: "EUR" } as any);
  addObservation(state, { reference: "PSK-USD-7", amountKobo: 99_500, grossAmountKobo: 100_000, feeKobo: 500, batchReference: "B-U8", source: "settlement", customerId: due.customerId, eventId: "usd-line-7b", occurredAt: wat("2027-07-02T09:00:00"), currency: "USD" } as any);
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-02T10:00:00")))), "the second reconciliation");
  const [usd] = payment(state, "CARD-USD-7"), [eur] = payment(state, "CARD-EUR-7"), [line] = payment(state, "PSK-USD-7");
  const reversal = recordsOf(state, "observations").find((item) => item.data.eventId === "rev-7")!;
  const second = recordsOf(state, "settlement-batches").find((item) => item.reference === "B-U8")!;
  const raised = [exceptionsFor(state, usd!.id, "unallocated_payment")[0], exceptionsFor(state, eur!.id, "unallocated_payment")[0], exceptionsFor(state, line!.id, "unallocated_payment")[0],
    exceptionsFor(state, reversal.id, "provider_status_mismatch")[0], exceptionsFor(state, held.id, "suspected_duplicate")[0], exceptionsFor(state, second.id, "settlement_variance")[0]];
  equal(raised.map((item) => item && [item.amountKobo, item.data.currency]), [[100_000, "USD"], [2_000, "EUR"], [100_000, "USD"], [7_000, "USD"], [300_000, "EUR"], [100_000, "USD"]],
    "each exception raised for money in another currency names that currency beside its minor units: a payment held for Finance, a reversal waiting for its payment, held evidence and a line counted in two batches");
  check(recordsOf(state, "exceptions").filter((item) => !raised.includes(item)).every((item) => !("currency" in item.data)), "an exception about naira names none");
  // What the console reads carries it: the Exceptions queue, the customer's history and the dispute pack.
  const queued = pageQueue(state.records, "exceptions", { view: "open", limit: 100 } as any, wat("2027-07-02T11:00:00")).items.find((item) => item.id === raised[0]!.id);
  const history = pageCustomerHistory(state, due.customerId, { eventsLimit: 100 } as any).events.find((item) => item.id === raised[1]!.id);
  const pack = buildDisputePack(state, finance(wat("2027-07-02T11:00:00")), due.customerId).timeline.find((item) => item.recordId === raised[3]!.id);
  equal([queued?.data.currency, history?.data.currency, pack?.currency], ["USD", "EUR", "USD"], "the queue, the history and the dispute pack read it");
  // A close's review basis lists what remains open with the currency of each amount, as the reviewed close's export prints it.
  const unresolved = bindCloseReviewBasis(state, close(state, "2027-07-02T11:00:00")).data.reviewBasis.unresolved as { id: string; kind: string; currency?: string }[];
  equal([raised[0]!.id, raised[3]!.id, held.id].map((id) => unresolved.find((item) => item.id === id)?.currency), ["USD", "USD", "EUR"], "a close's unresolved items name the currency of their amounts: exceptions and evidence");
  check(unresolved.filter((item) => item.kind === "exceptions" && !raised.some((exception) => exception!.id === item.id)).every((item) => !("currency" in item)), "and a naira item names none");

  // A batch an earlier build left counting the USD collection that B-U7 counts: the report of it names the currency too.
  const earlier = makeRecord(state, "settlement-batches", { name: "Settlement batch B-U9", status: "pending", reference: "B-U9", data: { ...structuredClone(recordsOf(state, "settlement-batches").find((item) => item.reference === "B-U7")!.data), batchReference: "B-U9", lineObservationIds: [], linePaymentIds: [line!.id] } } as any);
  delete earlier.data.providerIdentityKey; // Actual pre-identity persisted shape.
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-02T11:30:00")))), "the reconciliation of the earlier build's batch");
  const [counted] = exceptionsFor(state, earlier.id, "settlement_variance");
  equal([counted?.data.condition, counted?.amountKobo, counted?.data.currency], [`settlement_variance:${earlier.id}:counted:${line!.id}`, 100_000, "USD"], "a batch that counts a USD collection another batch counts is reported in dollars");

  // What an earlier build left: the same exceptions with no currency, one of them already resolved.
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-02T12:00:00")), { action: "resolve_exception", recordId: raised[1]!.id, reason: "Held as credit in euros.", data: { resolutionCode: "held_credit" } })), "Finance resolving the EUR payment's exception");
  const legacy = [...raised, counted];
  for (const item of legacy) delete item!.data.currency;
  const stamps = legacy.map((item) => item!.updatedAt);
  check(buildDisputePack(state, finance(wat("2027-07-03T07:00:00")), due.customerId).timeline.find((item) => item.recordId === raised[3]!.id)?.currency === "USD", "the dispute pack reads such an exception in its money's currency even before it is corrected");
  const corrected = accepted(request(state, () => reconcile(state, finance(wat("2027-07-03T08:00:00")))), "the reconciliation after the upgrade");
  equal([legacy.map((item) => item!.data.currency), corrected.data.exceptionCurrenciesRecorded], [["USD", "EUR", "USD", "USD", "EUR", "USD", "USD"], 7], "the next reconciliation gives each the currency of the money it is about, the resolved one and both kinds of counted-twice report included, and counts them");
  check(legacy.every((item, index) => item!.updatedAt !== stamps[index]), "each corrected exception is written");
  const written = legacy.map((item) => item!.updatedAt);
  const again = accepted(request(state, () => reconcile(state, finance(wat("2027-07-03T09:00:00")))), "a later reconciliation");
  equal([legacy.map((item) => item!.updatedAt), "exceptionCurrenciesRecorded" in again.data], [written, false], "once: a later reconciliation writes none of them again and counts nothing");
  // A currency an exception names already is kept.
  raised[0]!.data.currency = "GBP";
  reconcile(state, finance(wat("2027-07-03T10:00:00")));
  equal(raised[0]!.data.currency, "GBP", "a currency the exception names is never replaced");
  equal(buildDisputePack(state, finance(wat("2027-07-03T11:00:00")), due.customerId).timeline.find((item) => item.recordId === raised[0]!.id)?.currency, "GBP", "and the dispute pack reads it as the exception names it, as the console does");
});

// ---------- Third review finding 6: a payer its payment's evidence names is not withdrawn ----------
section("a withdrawn identification the payment's evidence confirms", () => {
  const { state } = liveFixture({ withFailure: false, merchantId: "payer-named-after-identification" });
  const dues = recordsOf(state, "due-items").filter((item) => item.status === "scheduled");
  const d1 = dues[0]!, d2 = dues.find((item) => item.customerId !== d1.customerId)!;
  addObservation(state, { reference: "TRF-NOPAYER-1", amountKobo: 1_000_000, source: "transfer", eventId: "t1", occurredAt: wat("2027-07-01T07:00:00") });
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T07:05:00")))), "the payer-less transfer");
  const [transfer] = payment(state, "TRF-NOPAYER-1");
  accepted(request(state, () => executeAction(state, finance(wat("2027-07-01T08:00:00")), { action: "manual_allocate", recordId: transfer!.id, reason: "Bank narration names the customer.", data: { dueItemId: d1.id, amountKobo: 1_000_000 } })), "Finance identifying the payer");
  // The bank's own report of the same transfer then names that customer, and merges into the payment.
  const named = addObservation(state, { reference: "TRF-NOPAYER-1", amountKobo: 1_000_000, source: "transfer", customerId: d1.customerId, eventId: "t2", occurredAt: wat("2027-07-01T09:00:00") });
  accepted(request(state, () => reconcile(state, finance(wat("2027-07-01T09:05:00")))), "the bank's report");
  equal([named.status, named.data.paymentId], ["resolved", transfer!.id], "the report naming the payer is evidence of the payment");
  const identifying = allocationsOf(state, transfer!.id).find((item) => item.status === "confirmed")!;
  const reviewed = accepted(request(state, () => executeAction(state, finance(wat("2027-07-02T08:00:00")), { action: "review_allocation", recordId: identifying.id, reason: "Wrong instalment.", data: { correct: false } })), "the review marking the identifying match wrong");
  equal([transfer!.customerId, transfer!.data.payerIdentification?.customerId, transfer!.status, /withdrawn/.test(reviewed.message)], [d1.customerId, d1.customerId, "unallocated", false], "the payer stays: the payment's own evidence names it");
  const refused = request(state, () => executeAction(state, finance(wat("2027-07-02T09:00:00")), { action: "manual_allocate", recordId: transfer!.id, reason: "Another customer.", data: { dueItemId: d2.id, amountKobo: 1_000_000 } }));
  check(!refused.ok && refused.status === 409, `another customer's instalment is refused (${!refused.ok && refused.message})`);
});

// ---------- One inconsistent record never stops the lender's close ----------
section("conflicting evidence beside ordinary evidence", () => {
  const { state, due } = liveFixture({ withFailure: false, merchantId: "contained" });
  const [a, b] = recordsOf(state, "due-items").filter((item) => item.status === "scheduled" && item.id !== due.id);
  addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-07-01T06:00:00"), providerReference: "PSK-OK" });
  addObservation(state, { reference: "PSK-OK", amountKobo: due.amountKobo, source: "webhook", customerId: due.customerId, eventId: "ok", occurredAt: wat("2027-07-01T06:00:00") });
  addObservation(state, { reference: "TRF-CLASH", amountKobo: a!.amountKobo, source: "transfer", customerId: a!.customerId, eventId: "clash-a", occurredAt: wat("2027-07-01T06:00:00") });
  const clash = addObservation(state, { reference: "TRF-CLASH", amountKobo: b!.amountKobo, source: "card", customerId: b!.customerId, dueItemId: b!.id, eventId: "clash-b", occurredAt: wat("2027-07-01T06:00:00") });
  addAttempt(state, b!, { status: "sent", occurredAt: wat("2027-07-01T06:00:00"), providerReference: "PSK-NOBODY" });
  addObservation(state, { reference: "PSK-NOBODY", amountKobo: b!.amountKobo, source: "settlement", batchReference: "B-C", eventId: "nobody", occurredAt: wat("2027-07-01T06:30:00") });
  const report = close(state, "2027-07-01T09:00:00").data.report;
  equal([due.status, allocationsOf(state, payment(state, "PSK-OK")[0]!.id)[0]?.data.rule], ["paid", "R1"], "the ordinary evidence is matched");
  equal([clash.status, exceptionsFor(state, clash.id, "suspected_duplicate").length], ["unresolved", 1], "the conflicting evidence is held with an exception");
  equal(payment(state, "PSK-NOBODY")[0]!.status, "proposed", "the evidence with no payer waits for Finance");
  check(report.positionRebuild.alert === false, "and the close's position check holds");
});

// ---------- Money is conserved over random operations, and evidence is never merged into another payer's payment ----------
let propertyRuns = "";
section("random operations", () => {
  const property = propertyRun(Number(process.env.EVIDENCE_SEEDS || 16), Number(process.env.EVIDENCE_STEPS || 45));
  propertyRuns = `${property.applied} operations applied across ${property.seeds} seeds`;
  equal(property.violations, [], "no invariant is broken and no close or reconciliation is refused");
  check(property.applied > property.seeds * 20, `most operations applied (${property.applied})`);
  checks += property.checked;
});

function mulberry32(seed: number) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Money and evidence invariants after every request. */
function invariants(state: DomainState): string[] {
  const problems: string[] = [];
  const allocations = recordsOf(state, "allocations"), payments = recordsOf(state, "payments"), byId = new Map(state.records.map((item) => [item.id, item]));
  for (const p of payments) {
    const confirmed = allocations.filter((a) => a.status === "confirmed" && a.data.paymentId === p.id).reduce((sum, a) => sum + a.amountKobo, 0);
    if (Number(p.data.allocatedKobo || 0) !== confirmed) problems.push(`payment ${p.reference}: allocatedKobo ${p.data.allocatedKobo} is not its confirmed allocations ${confirmed}`);
    const reversed = p.data.reversalStatus === "reversed";
    if (!reversed && confirmed + paymentRefundedKobo(p) + paymentUnappliedKobo(p) !== p.amountKobo) problems.push(`payment ${p.reference}: ${p.amountKobo} is not allocated + refunded + unapplied`);
    if (reversed && confirmed > 0) problems.push(`payment ${p.reference}: reversed with money applied`);
    if (confirmed > 0 && !p.customerId) problems.push(`payment ${p.reference}: applied with no payer`);
    if (p.status === "unallocated" && confirmed > 0) problems.push(`payment ${p.reference}: unallocated with money applied`);
    for (const a of allocations.filter((item) => item.data.paymentId === p.id && item.status === "confirmed")) if (a.customerId !== p.customerId) problems.push(`allocation on ${p.reference}: payer ${a.customerId} is not the payment's`);
  }
  for (const d of recordsOf(state, "due-items")) {
    const confirmed = allocations.filter((a) => a.status === "confirmed" && a.data.dueItemId === d.id).reduce((sum, a) => sum + a.amountKobo, 0);
    if (d.status !== "cancelled" && outstandingOf(d) !== d.amountKobo - confirmed) problems.push(`due ${d.reference}: outstanding ${outstandingOf(d)} is not ${d.amountKobo} - ${confirmed}`);
  }
  if (positionMismatches(state).length) problems.push("the position rebuild does not match");
  // Resolved evidence agrees with the payment it resolved to: never another payer's, another currency or another gross.
  for (const o of recordsOf(state, "observations").filter((item) => item.status === "resolved" && item.data.paymentId)) {
    const p = byId.get(String(o.data.paymentId)) as ValopayRecord | undefined;
    if (!p) { problems.push(`observation ${o.reference}: resolved to a missing payment`); continue; }
    if (o.customerId && p.customerId && o.customerId !== p.customerId) problems.push(`observation ${o.reference}: merged into another payer's payment`);
    if (String(o.data.currency || "NGN").toUpperCase() !== String(p.data.currency || "NGN").toUpperCase()) problems.push(`observation ${o.reference}: merged across currencies`);
    const gross = Number(o.data.grossAmountKobo ?? o.amountKobo);
    if (o.data.source === "settlement" && o.data.grossAmountKobo === undefined ? gross > p.amountKobo : gross !== p.amountKobo) problems.push(`observation ${o.reference}: ${gross} merged into a payment of ${p.amountKobo}`);
  }
  // A collection's settlement line is counted in one batch; a batch's statement total is its distinct credits.
  const counted = new Map<string, string>();
  for (const batch of recordsOf(state, "settlement-batches")) for (const id of (batch.data.linePaymentIds ?? []) as string[]) {
    if (counted.has(id)) problems.push(`payment ${id}: counted in two settlement batches`);
    counted.set(id, batch.id);
  }
  for (const batch of recordsOf(state, "settlement-batches").filter((item) => item.data.statementObservationId)) {
    const credits = recordsOf(state, "observations").filter((item) => item.data.resolvedTo === `batch:${batch.id}` && !item.data.duplicateStatementCredit && !item.data.otherCurrencyCredit);
    const sum = credits.reduce((total, item) => total + item.amountKobo, 0);
    if (sum !== batch.data.statementNetKobo) problems.push(`batch ${batch.reference}: statement total ${batch.data.statementNetKobo} is not its credits ${sum}`);
  }
  // A batch holds one currency: it counts its lines in that currency alone, its totals are what they add, and its fees
  // are checked only in naira; a line in another is linked to it, never counted, and reported.
  const currency = (record: ValopayRecord | undefined) => String(record?.data.currency || "NGN").trim().toUpperCase();
  for (const batch of recordsOf(state, "settlement-batches").filter((item) => Array.isArray(item.data.lineObservationIds))) {
    const lines = (batch.data.lineObservationIds as string[]).map((id) => byId.get(id)!);
    if (lines.some((line) => currency(line) !== currency(batch))) problems.push(`batch ${batch.reference}: counts a line in another currency than its ${currency(batch)}`);
    const sum = (key: string) => lines.reduce((total, line) => total + Number(line.data[key] ?? 0), 0);
    if (batch.data.grossKobo !== sum("countedGrossKobo") || batch.data.feeKobo !== sum("assumedFeeKobo") || batch.data.netKobo !== Number(batch.data.grossKobo) - Number(batch.data.feeKobo)) problems.push(`batch ${batch.reference}: its totals are not what its lines add`);
    if (currency(batch) === "NGN" ? batch.data.expectedFeeKobo !== sum("expectedFeeKobo") : batch.data.expectedFeeKobo !== undefined || batch.data.feeVarianceKobo !== undefined) problems.push(`batch ${batch.reference}: its expected fee does not follow its currency's fee schedule`);
    for (const id of (batch.data.otherCurrencyLineIds ?? []) as string[]) {
      const line = byId.get(id);
      if (!line || currency(line) === currency(batch) || line.data.otherCurrencyLine !== true || line.data.settlementBatchId !== batch.id) problems.push(`batch ${batch.reference}: line ${line?.reference} is kept apart but is not a line in another currency`);
      if (!recordsOf(state, "exceptions").some((item) => item.data.condition === `settlement_variance:${batch.id}:currency:${id}` || ((item.data.otherCurrencyLines ?? []) as string[]).includes(`settlement_variance:${batch.id}:currency:${id}`))) problems.push(`batch ${batch.reference}: line ${line?.reference} in another currency was not reported`);
    }
  }
  // An exception names the currency of the money it is about (the payment or evidence it links to, or the payment a
  // report of a collection counted in two batches, or of a line in another currency, names), and one about naira names none.
  for (const e of recordsOf(state, "exceptions")) {
    const linked = byId.get(String(e.data.linkedRecordId ?? ""));
    const [, , report, named] = String(e.data.condition ?? "").split(":");
    const line = report === "line" || report === "currency" ? byId.get(String(named)) : undefined;
    const money = linked?.kind === "payments" || linked?.kind === "observations" ? linked : linked?.kind === "settlement-batches" ? byId.get(report === "counted" ? String(named) : String(line?.data.paymentId ?? "")) : undefined;
    const currency = String(money?.data.currency || "NGN").trim().toUpperCase();
    if (e.data.currency !== (currency === "NGN" ? undefined : currency)) problems.push(`exception ${e.data.type} on ${linked?.reference}: currency ${e.data.currency} is not its money's ${currency}`);
  }
  return problems;
}

/** The audit's property run, extended with shared references, other connections and currencies, several credits and lines in two batches. */
function propertyRun(seeds: number, steps: number) {
  const violations: string[] = [];
  let applied = 0, checked = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const rand = mulberry32(seed);
    const pick = <T,>(items: T[]): T | undefined => (items.length ? items[Math.floor(rand() * items.length)] : undefined);
    let state = liveFixture({ withFailure: false, merchantId: `evidence-${seed}` }).state;
    let clock = Date.parse(wat("2027-06-30T08:00:00")), counter = 0;
    const at = () => new Date(clock).toISOString();
    const dues = () => recordsOf(state, "due-items"), payments = () => recordsOf(state, "payments");
    // A decision names the payment's current proposal, as the console sends it.
    const reviewed = (payment: ValopayRecord) => { const proposal = recordsOf(state, "allocations").find((item) => item.data.paymentId === payment.id && item.status === "proposed"); return proposal ? { proposalId: proposal.id, proposalUpdatedAt: proposal.updatedAt } : {}; };
    const ops: Record<string, () => void> = {
      webhook: () => { const due = pick(dues())!; counter++; const ref = rand() < 0.3 && payments().length ? pick(payments())!.reference : `W-${seed}-${counter}`; if (rand() < 0.4) addAttempt(state, due, { status: "succeeded", occurredAt: at(), providerReference: ref }); addObservation(state, { reference: ref, amountKobo: rand() < 0.6 ? due.amountKobo : Math.max(1, Math.floor(due.amountKobo * (0.3 + rand()))), source: "webhook", customerId: due.customerId, dueItemId: rand() < 0.5 ? due.id : undefined, eventId: `e-${counter}`, occurredAt: at() }); },
      transfer: () => { const due = pick(dues())!; counter++; addObservation(state, { reference: rand() < 0.2 && payments().length ? pick(payments())!.reference : `T-${seed}-${counter}`, amountKobo: rand() < 0.5 ? due.amountKobo : Math.max(1, Math.floor(due.amountKobo * (0.3 + rand()))), source: rand() < 0.7 ? "transfer" : "card", customerId: rand() < 0.85 ? due.customerId : "", eventId: `e-${counter}`, occurredAt: at(), narration: rand() < 0.5 ? `pay ${due.reference}` : undefined }); },
      foreign: () => { const due = pick(dues())!; counter++; addObservation(state, { reference: rand() < 0.5 && payments().length ? pick(payments())!.reference : `F-${seed}-${counter}`, amountKobo: due.amountKobo, source: "card", customerId: due.customerId, eventId: `e-${counter}`, occurredAt: at(), ...(rand() < 0.5 ? { provider: "Other Rail" } : { currency: "USD" }) } as any); },
      settlement: () => { const target = pick(payments().filter((item) => item.data.channel === "direct_debit")); counter++; const due = pick(dues())!; const gross = target && rand() < 0.7 ? target.amountKobo : due.amountKobo; const fee = Math.min(100_000, Math.floor(gross * 50 / 10_000)); addObservation(state, { reference: target && gross === target.amountKobo ? target.reference : `S-${seed}-${counter}`, amountKobo: gross - fee, grossAmountKobo: gross, feeKobo: fee, batchReference: `B-${seed}-${Math.floor(counter / 4) - (rand() < 0.2 ? 1 : 0)}`, source: "settlement", customerId: rand() < 0.7 ? target?.customerId ?? due.customerId : "", eventId: `e-${counter}`, occurredAt: at() }); },
      foreignLine: () => { const usd = payments().filter((item) => item.data.currency === "USD"); const due = pick(dues())!; counter++; const target = rand() < 0.5 ? pick(usd) : undefined; const gross = target?.amountKobo ?? due.amountKobo, fee = Math.min(100_000, Math.floor(gross * 50 / 10_000)); addObservation(state, { reference: target?.reference ?? `SU-${seed}-${counter}`, amountKobo: gross - fee, grossAmountKobo: gross, feeKobo: fee, batchReference: `B-${seed}-${Math.floor(counter / 4) - (rand() < 0.3 ? 1 : 0)}`, source: "settlement", customerId: target?.customerId || due.customerId, eventId: `e-${counter}`, occurredAt: at(), currency: "USD" } as any); },
      noPayerLine: () => { const attempt = pick(recordsOf(state, "attempts").filter((item) => item.data.providerReference)); if (!attempt) return; counter++; const gross = attempt.amountKobo, fee = Math.min(100_000, Math.floor(gross * 50 / 10_000)); addObservation(state, { reference: String(attempt.data.providerReference), amountKobo: gross - fee, grossAmountKobo: gross, feeKobo: fee, batchReference: `BN-${seed}-${Math.floor(counter / 3)}`, source: "settlement", customerId: "", eventId: `e-${counter}`, occurredAt: at() }); },
      statement: () => { const batch = pick(recordsOf(state, "settlement-batches")); if (!batch) return; counter++; addObservation(state, { reference: rand() < 0.3 ? `ST-${batch.reference}` : `ST-${seed}-${counter}`, amountKobo: Math.max(1, rand() < 0.6 ? Number(batch.data.netKobo || 1) : Math.floor(Number(batch.data.netKobo || 2) / 2)), batchReference: batch.reference, source: "statement", eventId: `e-${counter}`, occurredAt: at(), ...(rand() < 0.15 ? { currency: batch.data.currency === "USD" ? "NGN" : "USD" } : batch.data.currency === "USD" ? { currency: "USD" } : {}) } as any); },
      reversal: () => { const target = pick(payments().filter((item) => item.data.canonical)); if (!target) return; counter++; addObservation(state, { reference: target.reference, amountKobo: target.amountKobo, source: "webhook", customerId: target.customerId, eventId: `rev-${counter}`, reversed: true, occurredAt: at(), provider: String(target.data.providerConnection || "Sandbox Rail"), currency: String(target.data.currency || "NGN") } as any); },
      reconcile: () => { reconcile(state, finance(at())); },
      close: () => { executeAction(state, finance(at()), { action: "daily_close" }); },
      confirm: () => { const p = pick(payments().filter((item) => item.status === "proposed")); if (p) executeAction(state, finance(at()), { action: "confirm_allocation", recordId: p.id, reason: "Checked the evidence.", data: reviewed(p) }); },
      reject: () => { const p = pick(payments().filter((item) => item.status === "proposed")); if (p) executeAction(state, finance(at()), { action: "reject_allocation", recordId: p.id, reason: "Not this instalment.", data: reviewed(p) }); },
      manual: () => { const p = pick(payments()); if (!p) return; const due = pick(dues().filter((item) => !p.customerId || rand() < 0.1 || item.customerId === p.customerId)); if (!due) return; const left = paymentUnappliedKobo(p), owed = outstandingOf(due); executeAction(state, finance(at()), { action: "manual_allocate", recordId: p.id, reason: "Finance identified it.", data: { dueItemId: due.id, amountKobo: rand() < 0.8 ? Math.max(1, Math.floor(Math.min(left, owed) * (rand() < 0.5 ? 1 : rand()))) : left + 1 } }); },
      refund: () => { const p = pick(payments()); if (p) executeAction(state, finance(at()), { action: "record_refund", recordId: p.id, reason: "Refunded outside Valo Pay.", data: { reference: "RF-***1" } }); },
      review: () => { const a = pick(recordsOf(state, "allocations").filter((item) => item.status !== "proposed")); if (a) executeAction(state, finance(at()), { action: "review_allocation", recordId: a.id, reason: "Precision review.", data: { correct: rand() < 0.5 } }); },
      amend: () => { const due = pick(dues())!; const input = structuredClone(due); input.amountKobo = Math.max(1_000_000, Math.floor(due.amountKobo * (0.5 + rand()))); input.data.overrideReason ||= "Amended by the lender."; amendDueItem(state, ctxAt(at(), "Admin"), due, input); },
      resolve: () => { const e = pick(recordsOf(state, "exceptions").filter((item) => ["open", "assigned", "in_progress"].includes(item.status))); if (!e) return; const codes = ({ suspected_duplicate: ["distinct_payments", "confirmed_duplicate_refund", "applied_to_next"], unallocated_payment: ["held_credit", "allocated_manual"], overpayment: ["held_credit"], settlement_variance: ["accepted_variance"], unknown_outcome: ["resolved_failed"] } as Record<string, string[]>)[String(e.data.type)] ?? ["no_action_required"]; executeAction(state, ctxAt(at(), "Admin"), { action: "resolve_exception", recordId: e.id, reason: "Reviewed.", data: { resolutionCode: pick(codes) } }); },
      a2a: () => { const due = pick(dues())!; const owed = outstandingOf(due); if (owed <= 0) return; const ops = ctxAt(at(), "Operations"); const intent = runConnectedAction(state, ops, { action: "payment.create", reason: "Pay by bank.", expectedRevision: connectedRevision(state), data: { dueItemId: due.id, amountKobo: Math.max(1, Math.floor(owed * (rand() < 0.6 ? 1 : rand()))) } } as any) as ValopayRecord; runConnectedAction(state, ops, { action: "payment.authorise", recordId: intent.id, reason: "Authorised.", expectedRevision: connectedRevision(state), data: {} } as any); runConnectedAction(state, ops, { action: "payment.outcome", recordId: intent.id, reason: "Confirmed.", expectedRevision: connectedRevision(state), data: { outcome: "confirmed" } } as any); },
      attempt: () => { const due = pick(dues().filter((d) => !recordsOf(state, "attempts").some((a) => a.data.dueItemId === d.id && ["scheduled", "sent", "unknown"].includes(a.status)))); if (!due) return; counter++; addAttempt(state, due, { status: rand() < 0.5 ? "unknown" : "sent", occurredAt: at(), providerReference: `PR-${seed}-${counter}` }); },
    };
    const weights: [string, number][] = [["webhook", 5], ["transfer", 5], ["foreign", 2], ["settlement", 3], ["foreignLine", 2], ["noPayerLine", 2], ["statement", 2], ["reversal", 1], ["reconcile", 6], ["close", 2], ["confirm", 3], ["reject", 1], ["manual", 4], ["refund", 2], ["review", 2], ["amend", 1], ["resolve", 3], ["a2a", 1], ["attempt", 2]];
    const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
    for (let step = 0; step < steps; step++) {
      clock += Math.floor(rand() * 6 * HOUR) + 60_000;
      let roll = rand() * total, name = weights[0]![0];
      for (const [candidate, weight] of weights) if ((roll -= weight) < 0) { name = candidate; break; }
      const before = structuredClone(state);
      try {
        ops[name]!();
        assertFinalState(structuredClone(before), state, state.merchant.id, at());
        applied += 1;
      } catch (error) {
        state = before;
        if (name === "reconcile" || name === "close") violations.push(`seed ${seed} step ${step}: ${name} refused: ${(error as Error).message}`);
      }
      const problems = invariants(state);
      checked += 1;
      for (const problem of problems) violations.push(`seed ${seed} step ${step} after ${name}: ${problem}`);
      if (problems.length) break;
    }
  }
  return { violations: [...new Set(violations)].slice(0, 20), applied, seeds, checked };
}

if (failures.length) {
  console.error(failures.join("\n"));
  assert.fail(`${failures.length} payment evidence section(s) failed`);
}
console.log(`Payment evidence golden tests passed (${checks} checks): evidence with no payer and Finance's payer identification, evidence that shares a reference, R1's currency and connection, R4's narration references, statement credits and lines across settlement batches, the rest of a partly allocated payment, distinct payments, evidence and reversals through another connection name, a withdrawn payer, a net line applied before the gross, a gross below the amount, money in another currency, a line an earlier build counted twice, Finance's resolutions deciding first, holds offered as they stand now, counted-twice reports kept, a batch an earlier build counted, amounts in their own currency, other currencies beside a customer's position, a payer its evidence names, exceptions in their money's currency, counted-twice reports and waiting reversals an earlier build resolved, a close that contains a conflict and the conservation property run (${propertyRuns}).`);
