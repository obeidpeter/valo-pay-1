// Golden tests for payment observations, canonical Payments, the rule ladder,
// exceptions and the daily close against TRD v1.1 sections 5.7, 5.8, 5.9, 7 and 10.4.
import assert from "node:assert/strict";
import { ZodError } from "zod";
import { DAY, HOUR, addAttempt, addNotice, addObservation, ctxAt, liveFixture, outstandingOf, wat } from "./helpers.js";
import { allocatePayment, applyConfirmedAllocation, intendedDueItem, reconcile } from "../src/domain/reconciliation.js";
import { executeAction } from "../src/domain/actions.js";
import { buildOverview, buildReports } from "../src/domain/reports.js";
import { makeRecord, recordsOf } from "../src/domain/records.js";
import { addBusinessDays } from "../src/domain/calendar.js";
import { bindCloseReviewBasis, closeReviewIssues } from "../src/domain/close-review.js";
import { validateRecord } from "../src/domain/validation.js";
import { seedMerchant } from "../src/lib/valo-pay-1-seed.js";
import type { DomainState, ValopayRecord } from "../src/domain/types.js";

const { assertFinalState } = await import("../src/lib/valo-pay-1-store.js");
let checks = 0;
const invariant = (state: DomainState) => { assert.doesNotThrow(() => assertFinalState({ merchant: structuredClone(state.merchant), settings: {}, records: [] }, state, state.merchant.id)); checks += 1; };
const finance = (now: string) => ctxAt(now, "Finance");
const GROSS = 2_500_000, FEE = 12_500, NET = GROSS - FEE; // ₦25,000 at 0.5% capped at ₦1,000
const permutations = <T>(items: T[]): T[][] => items.length <= 1 ? [items] : items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));

function assertOnePayment(state: DomainState, due: ValopayRecord, label: string) {
  const payments = recordsOf(state, "payments").filter((item) => item.reference === "PSK-88213");
  assert.equal(payments.length, 1, `${label}: one canonical Payment`);
  const payment = payments[0]!;
  const allocations = recordsOf(state, "allocations").filter((item) => item.data.paymentId === payment.id && item.status === "confirmed");
  assert.equal(allocations.length, 1, `${label}: one allocation`);
  assert.equal(allocations[0]!.amountKobo, GROSS, `${label}: the allocation is the gross amount`);
  assert.equal(allocations[0]!.data.rule, "R1", `${label}: matched by provider reference`);
  assert.equal(payment.status, "allocated", `${label}: no unapplied credit`);
  assert.equal(payment.amountKobo, GROSS);
  assert.equal(payment.data.settlementStatus, "settled", `${label}: the settlement line settled the Payment`);
  assert.equal(payment.data.collectionStatus, "succeeded");
  assert.equal(payment.data.reversalStatus, "none");
  assert.equal(due.status, "paid");
  assert.equal(outstandingOf(due), 0);
  const batch = recordsOf(state, "settlement-batches").find((item) => item.reference === "BATCH-2027-06-30")!;
  assert.equal(batch.status, "reconciled", `${label}: the statement credit reconciled the batch, not a customer`);
  assert.equal(batch.data.netKobo, NET);
  assert.equal(recordsOf(state, "observations").filter((item) => item.status === "unresolved").length, 0, `${label}: every observation resolved`);
  assert.equal(recordsOf(state, "exceptions").filter((item) => [payment.id, batch.id, due.id].includes(String(item.data.linkedRecordId))).length, 0, `${label}: no exception was raised for this money`);
  assert.equal(recordsOf(state, "observations").filter((item) => item.data.source === "settlement" && item.data.duplicateSettlementLine).length, 1, `${label}: the repeated settlement line is evidence only`);
  checks += 15;
}

// ---------- Three-source replay (10.4): webhook, settlement line and statement credit in every order, with duplicates, incrementally reconciled ----------
{
  type Source = "webhook" | "settlement" | "statement";
  for (const order of permutations<Source>(["webhook", "settlement", "statement"])) {
    for (const linkBy of ["attempt", "observation"] as const) {
      const { state, due } = liveFixture({ withFailure: false, merchantId: `replay-${order.join("-")}-${linkBy}` });
      let clock = Date.parse(wat("2027-06-30T06:20:00"));
      if (linkBy === "attempt") addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-06-30T06:20:00"), providerReference: "PSK-88213" });
      const feed = (source: Source, suffix: string) => {
        clock += HOUR;
        const at = new Date(clock).toISOString();
        const dueItemId = linkBy === "observation" && source !== "statement" ? due.id : undefined;
        if (source === "webhook") addObservation(state, { reference: "PSK-88213", amountKobo: GROSS, source, customerId: due.customerId, dueItemId, eventId: `w-${suffix}`, occurredAt: at });
        if (source === "settlement") addObservation(state, { reference: "PSK-88213", amountKobo: NET, grossAmountKobo: GROSS, feeKobo: FEE, batchReference: "BATCH-2027-06-30", source, customerId: due.customerId, dueItemId, eventId: `s-${suffix}` , occurredAt: at });
        if (source === "statement") addObservation(state, { reference: "STMT-0630", amountKobo: NET, batchReference: "BATCH-2027-06-30", source, eventId: `st-${suffix}`, occurredAt: at });
        reconcile(state, finance(new Date(clock).toISOString()));
      };
      for (const source of order) { feed(source, "1"); feed(source, "dup"); }
      // A statement credit that arrived before its batch waits for the next close.
      reconcile(state, finance(new Date(clock + HOUR).toISOString()));
      assertOnePayment(state, due, `${order.join(" → ")} linked by ${linkBy}`);
      invariant(state);
    }
  }
}

// ---------- Duplicate evidence versus a second payment (ING-05, 10.4) ----------
{
  const { state, due } = liveFixture({ withFailure: false, merchantId: "duplicates" });
  addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-06-30T06:20:00"), providerReference: "PSK-1" });
  addObservation(state, { reference: "PSK-1", amountKobo: GROSS, source: "webhook", customerId: due.customerId, eventId: "w1", occurredAt: wat("2027-06-30T06:20:00") });
  reconcile(state, finance(wat("2027-06-30T07:00:00")));
  assert.equal(due.status, "paid");
  // A repeated webhook for the same debit reference adds an observation and nothing else.
  addObservation(state, { reference: "PSK-1", amountKobo: GROSS, source: "webhook", customerId: due.customerId, eventId: "w1-repeat", occurredAt: wat("2027-06-30T06:21:00") });
  reconcile(state, finance(wat("2027-06-30T07:30:00")));
  assert.equal(recordsOf(state, "payments").filter((item) => item.reference === "PSK-1").length, 1);
  assert.equal(recordsOf(state, "allocations").filter((item) => item.status === "confirmed" && item.data.dueItemId === due.id).length, 1);
  assert.equal(recordsOf(state, "observations").find((item) => item.data.eventId === "w1-repeat")!.data.resolutionKey, "canonical_provider_reference");
  // A genuine second debit for the already-paid due item, twenty days later, is held as a possible duplicate with an exception and no allocation.
  addObservation(state, { reference: "PSK-2", amountKobo: GROSS, source: "webhook", customerId: due.customerId, dueItemId: due.id, eventId: "w2", occurredAt: wat("2027-07-20T06:20:00") });
  reconcile(state, finance(wat("2027-07-20T07:00:00")));
  const second = recordsOf(state, "payments").find((item) => item.reference === "PSK-2")!;
  assert.equal(second.status, "possible_duplicate");
  assert.equal(recordsOf(state, "allocations").filter((item) => item.data.paymentId === second.id).length, 0, "never auto-allocated");
  const exception = recordsOf(state, "exceptions").find((item) => item.data.linkedRecordId === second.id)!;
  assert.equal(exception.data.type, "suspected_duplicate");
  assert.equal(exception.data.owner, "Finance");
  assert.equal(exception.data.severity, "high");
  assert.equal(exception.data.dueBy, addBusinessDays(state, wat("2027-07-20T07:00:00"), 2), "Appendix A: two business days");
  // The intended due item is found through the attempt's provider reference, not the LMS reference on the attempt.
  const first = recordsOf(state, "payments").find((item) => item.reference === "PSK-1")!;
  assert.equal(intendedDueItem(state, first)?.key, "attempt_provider_reference");
  // Same payer, same amount, two minutes apart: the second is held; a payment a day later is not.
  const other = recordsOf(state, "due-items").find((item) => item.status === "scheduled" && item.customerId !== due.customerId && item.amountKobo >= 1_000_000)!;
  other.data.dueDate = "2027-07-21";
  addObservation(state, { reference: "TRF-A", amountKobo: other.amountKobo, source: "transfer", customerId: other.customerId, eventId: "ta", occurredAt: wat("2027-07-21T10:00:00") });
  addObservation(state, { reference: "TRF-B", amountKobo: other.amountKobo, source: "transfer", customerId: other.customerId, eventId: "tb", occurredAt: wat("2027-07-21T10:01:30") });
  addObservation(state, { reference: "TRF-C", amountKobo: other.amountKobo, source: "transfer", customerId: other.customerId, eventId: "tc", occurredAt: wat("2027-07-22T10:01:30") });
  reconcile(state, finance(wat("2027-07-22T11:00:00")));
  const [a, b, c] = ["TRF-A", "TRF-B", "TRF-C"].map((reference) => recordsOf(state, "payments").find((item) => item.reference === reference)!);
  assert.equal(a!.status, "proposed", "R5 proposes the first transfer for Finance");
  assert.equal(b!.status, "possible_duplicate", "a near-identical transfer two minutes later is held");
  assert.notEqual(c!.status, "possible_duplicate", "a transfer a day later is not a duplicate");
  invariant(state);
  checks += 14;
}

// ---------- Allocation ceiling: nothing can allocate more than a Payment or more than a due item's remaining balance ----------
{
  const { state, due } = liveFixture({ withFailure: false, merchantId: "ceiling" });
  addObservation(state, { reference: "TRF-X", amountKobo: 3_000_000, source: "transfer", customerId: due.customerId, eventId: "x", occurredAt: wat("2027-07-01T10:00:00") });
  reconcile(state, finance(wat("2027-07-01T10:05:00")));
  const payment = recordsOf(state, "payments").find((item) => item.reference === "TRF-X")!;
  assert.equal(payment.status, "unallocated", "no rule matches a transfer with no reference, narration or window");
  assert.throws(() => executeAction(state, finance(wat("2027-07-01T11:00:00")), { action: "manual_allocate", recordId: payment.id, reason: "r", data: { dueItemId: due.id, amountKobo: 2_600_000 } }), /still owes\. Enter a lower amount\./);
  executeAction(state, finance(wat("2027-07-01T11:00:00")), { action: "manual_allocate", recordId: payment.id, reason: "r", data: { dueItemId: due.id, amountKobo: GROSS } });
  assert.equal(due.status, "paid");
  assert.equal(payment.status, "overpaid", "7.3: the excess is unapplied credit with an exception");
  assert.equal(recordsOf(state, "exceptions").find((item) => item.data.linkedRecordId === payment.id)!.data.type, "overpayment");
  assert.throws(() => executeAction(state, finance(wat("2027-07-01T11:00:00")), { action: "manual_allocate", recordId: payment.id, reason: "r", data: { dueItemId: due.id, amountKobo: 1 } }), /still owes\. Enter a lower amount\.|already paid in full\. Choose another instalment\.|this payment has left to allocate/);
  invariant(state);
  checks += 5;
}

// ---------- Settlement fee schedule (CON-09, ING-07): 0.5% capped at ₦1,000, variance beyond ₦100 per batch is an exception ----------
{
  const { state, due } = liveFixture({ withFailure: false, merchantId: "fees" });
  const big = recordsOf(state, "due-items").find((item) => item.amountKobo === 6_000_000)!;
  big.data.owner = "lms";
  addObservation(state, { reference: "L1", amountKobo: GROSS - 30_000, grossAmountKobo: GROSS, feeKobo: 30_000, batchReference: "B-VAR", source: "settlement", customerId: due.customerId, dueItemId: due.id, eventId: "l1", occurredAt: wat("2027-07-01T07:00:00") });
  reconcile(state, finance(wat("2027-07-01T07:05:00")));
  const varianceBatch = recordsOf(state, "settlement-batches").find((item) => item.reference === "B-VAR")!;
  assert.equal(varianceBatch.data.expectedFeeKobo, FEE, "expected fee from the schedule");
  assert.equal(varianceBatch.data.feeKobo, 30_000, "stated fee from the line");
  assert.equal(varianceBatch.status, "variance");
  assert.equal(recordsOf(state, "exceptions").find((item) => item.data.linkedRecordId === varianceBatch.id)!.data.type, "settlement_variance");
  // The cap: ₦60,000 gross at 0.5% would be ₦300 but is capped at ₦1,000 only above ₦200,000; here it is ₦300.
  addObservation(state, { reference: "L2", amountKobo: 6_000_000 - 30_000, grossAmountKobo: 6_000_000, batchReference: "B-OK", source: "settlement", customerId: big.customerId, dueItemId: big.id, eventId: "l2", occurredAt: wat("2027-07-01T07:10:00") });
  addObservation(state, { reference: "STMT-OK", amountKobo: 6_000_000 - 30_000, batchReference: "B-OK", source: "statement", eventId: "st-ok", occurredAt: wat("2027-07-02T07:00:00") });
  reconcile(state, finance(wat("2027-07-02T07:05:00")));
  const okBatch = recordsOf(state, "settlement-batches").find((item) => item.reference === "B-OK")!;
  assert.equal(okBatch.data.expectedFeeKobo, 30_000);
  assert.equal(okBatch.status, "reconciled");
  const capped = { ...state, settings: { ...state.settings } };
  const { providerFeeKobo } = await import("@workspace/valo-pay-1-schema");
  assert.equal(providerFeeKobo(30_000_000, { bps: 50, capKobo: 100_000 }), 100_000, "₦300,000 gross is capped at ₦1,000");
  void capped;
  invariant(state);
  checks += 7;
}

// ---------- A settlement line proves a direct debit was collected, so a debit whose webhook never arrived is succeeded (BIL-01) ----------
{
  const { state, due } = liveFixture({ withFailure: false, merchantId: "settled-without-webhook" });
  addObservation(state, { reference: "PSK-SETTLED", amountKobo: NET, grossAmountKobo: GROSS, feeKobo: FEE, batchReference: "B-SO", source: "settlement", customerId: due.customerId, dueItemId: due.id, eventId: "settled-only", occurredAt: wat("2027-07-01T07:00:00") });
  reconcile(state, finance(wat("2027-07-01T07:05:00")));
  const payment = recordsOf(state, "payments").find((item) => item.reference === "PSK-SETTLED")!;
  assert.deepEqual([payment.data.channel, payment.data.collectionStatus, payment.data.settlementStatus], ["direct_debit", "succeeded", "settled"], "the settlement line settles the debit and records it as collected");
  invariant(state);
  checks += 1;
}

// ---------- Settlement batches follow their current lines and statement credit (ING-03, ING-07): a provider file split across two imports reconciles ----------
{
  const { state, due } = liveFixture({ withFailure: false, merchantId: "split-settlement" });
  const big = recordsOf(state, "due-items").find((item) => item.amountKobo === 6_000_000)!;
  const small = recordsOf(state, "due-items").find((item) => item.amountKobo === 1_500_000)!;
  big.data.owner = "lms"; small.data.owner = "lms";
  const BIG_FEE = 30_000, BIG_NET = 6_000_000 - BIG_FEE;
  const linked = (id: string) => recordsOf(state, "exceptions").filter((item) => item.data.type === "settlement_variance" && item.data.linkedRecordId === id);
  // Import 1: the first part of the provider file and the bank's credit for the whole batch.
  addObservation(state, { reference: "SPLIT-L1", amountKobo: NET, grossAmountKobo: GROSS, feeKobo: FEE, batchReference: "B-SPLIT", source: "settlement", customerId: due.customerId, dueItemId: due.id, eventId: "split-l1", occurredAt: wat("2027-07-01T07:00:00") });
  addObservation(state, { reference: "STMT-SPLIT", amountKobo: NET + BIG_NET, batchReference: "B-SPLIT", source: "statement", eventId: "split-st", occurredAt: wat("2027-07-01T08:00:00") });
  reconcile(state, finance(wat("2027-07-01T09:00:00")));
  const batch = recordsOf(state, "settlement-batches").find((item) => item.reference === "B-SPLIT")!;
  assert.equal(batch.status, "variance", "half a file does not add up to the statement credit");
  assert.equal(linked(batch.id).length, 1);
  // Import 2: the rest of the file. The batch now matches the credit.
  addObservation(state, { reference: "SPLIT-L2", amountKobo: BIG_NET, grossAmountKobo: 6_000_000, feeKobo: BIG_FEE, batchReference: "B-SPLIT", source: "settlement", customerId: big.customerId, dueItemId: big.id, eventId: "split-l2", occurredAt: wat("2027-07-02T07:00:00") });
  const close = executeAction(state, finance(wat("2027-07-02T09:00:00")), { action: "daily_close" }).record!;
  assert.equal(batch.data.netKobo, NET + BIG_NET);
  assert.equal(batch.status, "reconciled", "the completed batch reconciles to the statement credit");
  assert.equal(batch.data.explanation, "The statement credit equals the batch’s amount after fees. It was not allocated to a customer.", "and says so, not what the first half showed");
  assert.equal(close.data.report.variances.count, 0, "the close lists no settlement difference");
  // Second review decision 3: a batch's variance exception closes when its condition clears, as other exceptions do.
  assert.deepEqual(linked(batch.id).map((item) => [item.status, item.data.resolutionCode, item.data.conditionCleared?.reason]), [["closed", "condition_cleared", "settlement batch B-SPLIT is now reconciled"]], "the earlier exception closes as its condition cleared; nothing new is raised");
  const [earlier] = linked(batch.id);
  assert.equal(earlier!.data.notes, "The statement credit does not equal the batch’s amount after fees. Compare the provider’s settlement report with the bank statement.\nUpdate on 2 Jul 2027: the batch is now reconciled. The statement credit equals the batch’s amount after fees. It was not allocated to a customer.\nClosed automatically on 2 Jul 2027: settlement batch B-SPLIT is now reconciled.", "its notes say where the batch now stands and why it closed, after what the first half showed");
  assert.match(String(close.data.summary), / opened and 1 closed,/, "the close counts it as closed");
  // The API and the scheduler bind the review basis: the review asks for no explanation of a settlement difference, and has no open exception left for it.
  const issues = closeReviewIssues(bindCloseReviewBasis(state, close));
  assert.ok(!issues.some((issue) => issue.id === `variance:${batch.id}`), "the review asks for no explanation of a settlement difference");
  assert.deepEqual(issues.filter((issue) => issue.id === `item:${earlier!.id}` && issue.unresolved), [], "and no open exception asks for an owner");
  // A later close with nothing new leaves the batch and its exception exactly as they were.
  const settled = JSON.stringify([batch, earlier]);
  reconcile(state, finance(wat("2027-07-03T09:00:00")));
  assert.equal(JSON.stringify([batch, earlier]), settled, "an unchanged batch is not rewritten");
  // A late line after the batch reconciled is a new difference: the exception its condition cleared settles nothing.
  addObservation(state, { reference: "SPLIT-L3", amountKobo: 1_500_000 - 7_500, grossAmountKobo: 1_500_000, feeKobo: 7_500, batchReference: "B-SPLIT", source: "settlement", customerId: small.customerId, dueItemId: small.id, eventId: "split-l3", occurredAt: wat("2027-07-04T07:00:00") });
  reconcile(state, finance(wat("2027-07-04T09:00:00")));
  assert.equal(batch.status, "variance", "a reconciled batch that gains a line no longer matches its credit");
  assert.equal(batch.data.explanation, "The statement credit does not equal the batch’s amount after fees. Compare the provider’s settlement report with the bank statement.");
  assert.deepEqual(linked(batch.id).map((item) => item.status), ["closed", "open"], "and that is new work");
  // A fee variance that a later line cancels out leaves the batch waiting for its statement credit.
  addObservation(state, { reference: "FEE-L1", amountKobo: GROSS - (FEE + 20_000), grossAmountKobo: GROSS, feeKobo: FEE + 20_000, batchReference: "B-FEES", source: "settlement", eventId: "fee-l1", occurredAt: wat("2027-07-05T07:00:00") });
  reconcile(state, finance(wat("2027-07-05T09:00:00")));
  const fees = recordsOf(state, "settlement-batches").find((item) => item.reference === "B-FEES")!;
  assert.equal(fees.status, "variance");
  addObservation(state, { reference: "FEE-L2", amountKobo: 6_000_000 - (BIG_FEE - 20_000), grossAmountKobo: 6_000_000, feeKobo: BIG_FEE - 20_000, batchReference: "B-FEES", source: "settlement", eventId: "fee-l2", occurredAt: wat("2027-07-06T07:00:00") });
  reconcile(state, finance(wat("2027-07-06T09:00:00")));
  assert.deepEqual([fees.data.feeVarianceKobo, fees.status, fees.data.explanation], [0, "pending", undefined], "fees that now match the schedule are no longer a variance");
  assert.match(String(linked(fees.id)[0]!.data.notes), /\nUpdate on 6 Jul 2027: the batch is now pending\. Its fees are within the schedule, and it waits for its statement credit\.\nClosed automatically on 6 Jul 2027: the fees of settlement batch B-FEES are now within the schedule\.$/, "and its exception says so and closes, as its condition cleared");
  assert.deepEqual([linked(fees.id)[0]!.status, linked(fees.id)[0]!.data.resolutionCode], ["closed", "condition_cleared"]);
  invariant(state);
  checks += 19;
}

// ---------- A settlement batch Finance added by hand takes the provider's lines when they arrive (ING-03) ----------
{
  const { state, due } = liveFixture({ withFailure: false, merchantId: "hand-batch" });
  const typed = { grossKobo: GROSS, feeKobo: FEE, netKobo: NET };
  const input = { name: "Settlement batch B-HAND", reference: "B-HAND", status: "pending", data: { provider: "Sandbox Rail", batchReference: "B-HAND", ...typed } };
  validateRecord(state, finance(wat("2027-07-01T06:00:00")), "settlement-batches", input);
  const batch = makeRecord(state, "settlement-batches", input);
  addObservation(state, { reference: "STMT-HAND", amountKobo: NET, batchReference: "B-HAND", source: "statement", eventId: "hand-st", occurredAt: wat("2027-07-01T06:30:00") });
  reconcile(state, finance(wat("2027-07-01T06:45:00")));
  assert.equal(batch.status, "reconciled", "a batch entered by hand reconciles to its statement credit");
  addObservation(state, { reference: "HAND-L1", amountKobo: NET, grossAmountKobo: GROSS, feeKobo: FEE, batchReference: "B-HAND", source: "settlement", customerId: due.customerId, dueItemId: due.id, eventId: "hand-l1", occurredAt: wat("2027-07-01T07:00:00") });
  assert.doesNotThrow(() => executeAction(state, finance(wat("2027-07-01T09:00:00")), { action: "daily_close" }), "the provider's line does not stop the close");
  assert.deepEqual([batch.status, batch.data.lineObservationIds?.length, batch.data.grossKobo, batch.data.feeKobo, batch.data.netKobo, batch.data.expectedFeeKobo], ["reconciled", 1, GROSS, FEE, NET, FEE], "the provider's lines rebuild the totals");
  assert.deepEqual(batch.data.enteredTotals, { ...typed, currency: "NGN" }, "and the totals Finance typed are kept beside them, with their currency");
  assert.equal(due.status, "paid", "the line's payment is matched as usual");
  // PostgreSQL's jsonb returns the typed totals' keys in its own order; an edit that leaves them as stored is still accepted.
  const { grossKobo, feeKobo, netKobo } = batch.data.enteredTotals!;
  batch.data.enteredTotals = { feeKobo, netKobo, grossKobo };
  assert.doesNotThrow(() => validateRecord(state, finance(wat("2027-07-01T10:00:00")), "settlement-batches", { ...structuredClone(batch), name: "Settlement batch B-HAND (typed)" }, true), "renaming a batch whose lines have arrived is accepted");
  invariant(state);
  checks += 6;
}

// ---------- The record API cannot set what reconciliation copies onto a settlement batch; the totals Finance edits move it (ING-03, ING-07) ----------
{
  const { state, due } = liveFixture({ withFailure: false, merchantId: "batch-platform-fields" });
  addObservation(state, { reference: "EDIT-L1", amountKobo: NET, grossAmountKobo: GROSS, feeKobo: FEE, batchReference: "B-EDIT", source: "settlement", customerId: due.customerId, dueItemId: due.id, eventId: "edit-l1", occurredAt: wat("2027-07-01T07:00:00") });
  const credit = addObservation(state, { reference: "STMT-EDIT", amountKobo: NET + 1_000_000, batchReference: "B-EDIT", source: "statement", eventId: "edit-st", occurredAt: wat("2027-07-01T08:00:00") });
  reconcile(state, finance(wat("2027-07-01T09:00:00")));
  const batch = recordsOf(state, "settlement-batches").find((item) => item.reference === "B-EDIT")!;
  assert.deepEqual([batch.status, batch.data.statementObservationId, batch.data.statementNetKobo], ["variance", credit.id, NET + 1_000_000]);
  const ctx = finance(wat("2027-07-01T10:00:00"));
  // What PATCH /records/settlement-batches/:id validates: the stored batch with the submitted fields merged into its data.
  const patch = (data: Record<string, unknown>) => ({ ...structuredClone(batch), data: { ...structuredClone(batch.data), ...data } });
  const line = recordsOf(state, "observations").find((item) => item.reference === "EDIT-L1")!;
  const copied: [string, unknown][] = [["statementNetKobo", NET], ["statementObservationId", line.id], ["lineObservationIds", []], ["linePaymentIds", []], ["expectedFeeKobo", FEE + 20_000], ["feeVarianceKobo", 20_000], ["enteredTotals", { grossKobo: GROSS, feeKobo: FEE, netKobo: NET }]];
  for (const [key, value] of copied) {
    assert.throws(() => validateRecord(state, ctx, "settlement-batches", patch({ [key]: value }), true), /Reconciliation sets this detail of the settlement batch\. You cannot change it here\./, `the record API cannot set ${key}`);
  }
  assert.throws(() => validateRecord(state, ctx, "settlement-batches", { name: "b", status: "pending", reference: "B-TYPED", data: { provider: "Sandbox Rail", grossKobo: GROSS, feeKobo: FEE, netKobo: NET, statementObservationId: credit.id, statementNetKobo: NET } }), /Reconciliation sets this detail of the settlement batch/, "nor give a new batch a statement credit");
  // The console's edit dialog sends the stored data back with the fields it edits.
  assert.doesNotThrow(() => validateRecord(state, ctx, "settlement-batches", { ...patch({}), name: "Settlement batch B-EDIT (renamed)" }, true), "an edit that leaves them as stored is accepted");
  reconcile(state, finance(wat("2027-07-02T09:00:00")));
  assert.deepEqual([batch.status, batch.data.explanation], ["variance", "The statement credit does not equal the batch’s amount after fees. Compare the provider’s settlement report with the bank statement."], "the batch still follows its linked statement credit");
  // Finance corrects the provider's fee: the next reconciliation recomputes the fee variance and names both differences.
  const edit = patch({ feeKobo: FEE + 20_000, netKobo: NET - 20_000 });
  validateRecord(state, ctx, "settlement-batches", edit, true);
  Object.assign(batch, edit);
  reconcile(state, finance(wat("2027-07-02T10:00:00")));
  assert.deepEqual([batch.status, batch.data.feeVarianceKobo], ["variance", 20_000], "the fee variance follows the edited fee");
  assert.equal(batch.data.explanation, "The statement credit does not equal the batch’s amount after fees. Compare the provider’s settlement report with the bank statement. Provider fees of ₦325.00 differ from the expected ₦125.00 by ₦200.00.", "and the explanation names both differences");
  invariant(state);
  checks += copied.length + 6;
}

// ---------- Exception catalogue (EXC-02, Appendix A): owners and business-day SLAs, so the overdue share means something ----------
{
  const state = seedMerchant("exceptions");
  const ctx = finance(wat("2027-07-02T07:00:00")); // Friday
  const old = makeRecord(state, "payments", { name: "old", status: "unallocated", reference: "OLD-1", amountKobo: 1_000_000, createdAt: wat("2027-06-30T07:00:00"), data: { allocatedKobo: 0, observedAt: wat("2027-06-30T07:00:00") } });
  reconcile(state, ctx);
  // The sample lender's own unallocated-payment exception has the same catalogue name, so the one reconciliation raised is found by its payment.
  const aged = recordsOf(state, "exceptions").find((item) => item.data.type === "unallocated_payment" && item.name === "Unallocated payment" && item.data.linkedRecordId === old.id)!;
  assert.equal(aged.data.owner, "Finance");
  assert.equal(aged.data.dueBy, wat("2027-07-06T07:00:00"), "two business days after a Friday is Tuesday");
  assert.equal(buildReports(state, wat("2027-07-02T07:01:00")).operational.overdueExceptionRate, recordsOf(state, "exceptions").filter((item) => Date.parse(String(item.data.dueBy)) < Date.parse(wat("2027-07-02T07:01:00"))).length / recordsOf(state, "exceptions").filter((item) => ["open", "assigned", "in_progress"].includes(item.status)).length);
  assert.ok(Date.parse(String(aged.data.dueBy)) > Date.parse(ctx.now), "a fresh exception is never already overdue");
  checks += 4;
}

// ---------- Final attempt and dispute through the close (REC-04, 6.3): the policy is found through the mandate ----------
{
  const { state, due, policy } = liveFixture({ merchantId: "final" });
  policy.data.maxAttempts = 3;
  delete due.data.policyId; // only the mandate carries the policy
  addAttempt(state, due, { status: "failed", failureCode: "INSUFFICIENT_FUNDS", occurredAt: wat("2027-06-30T06:16:00") });
  addAttempt(state, due, { status: "failed", failureCode: "INSUFFICIENT_FUNDS", occurredAt: wat("2027-07-02T06:16:00") });
  reconcile(state, finance(wat("2027-07-02T07:00:00")));
  assert.equal(due.status, "unpaid_final");
  const final = recordsOf(state, "exceptions").find((item) => item.data.linkedRecordId === due.id)!;
  assert.equal(final.data.type, "unpaid_after_final_attempt");
  assert.equal(final.data.owner, "Operations");
  // A dispute freezes the item with a one-day SLA.
  const disputed = liveFixture({ merchantId: "disputed", failureCode: "CUSTOMER_DISPUTED" });
  reconcile(disputed.state, finance(wat("2027-06-28T07:00:00")));
  assert.equal(disputed.due.status, "in_dispute");
  const dispute = recordsOf(disputed.state, "exceptions").find((item) => item.data.linkedRecordId === disputed.due.id)!;
  assert.equal(dispute.data.type, "customer_dispute");
  assert.equal(dispute.data.dueBy, addBusinessDays(disputed.state, wat("2027-06-28T07:00:00"), 1));
  // An unknown outcome older than 24 hours is an exception; a fresh one is not.
  const unknown = liveFixture({ merchantId: "unknown", withFailure: false });
  addAttempt(unknown.state, unknown.due, { status: "unknown", failureCode: "TIMEOUT_UNKNOWN", occurredAt: wat("2027-06-28T06:16:00") });
  reconcile(unknown.state, finance(wat("2027-06-28T20:00:00")));
  assert.equal(recordsOf(unknown.state, "exceptions").some((item) => item.data.type === "unknown_outcome"), false);
  reconcile(unknown.state, finance(wat("2027-06-29T06:17:00")));
  assert.equal(recordsOf(unknown.state, "exceptions").find((item) => item.data.type === "unknown_outcome")!.data.owner, "Operations");
  // A mandate limit breach is its own exception type.
  const limited = liveFixture({ merchantId: "limited", failureCode: "MANDATE_LIMIT_EXCEEDED" });
  reconcile(limited.state, finance(wat("2027-06-28T07:00:00")));
  assert.equal(recordsOf(limited.state, "exceptions").find((item) => item.data.linkedRecordId === limited.due.id)!.data.type, "mandate_limit_exceeded");
  invariant(state);
  checks += 9;
}

// ---------- One reversal vocabulary: runtime payments count on the overview and reversals leave it ----------
{
  const { state, due } = liveFixture({ withFailure: false, merchantId: "overview" });
  const before = buildOverview(state, wat("2027-07-01T08:00:00")).metrics.find((item) => item.key === "settled")!.value;
  addObservation(state, { reference: "S1", amountKobo: NET, grossAmountKobo: GROSS, feeKobo: FEE, batchReference: "B1", source: "settlement", customerId: due.customerId, dueItemId: due.id, eventId: "s1", occurredAt: wat("2027-07-01T07:00:00") });
  reconcile(state, finance(wat("2027-07-01T07:05:00")));
  const payment = recordsOf(state, "payments").find((item) => item.reference === "S1")!;
  assert.equal(payment.data.reversalStatus, "none");
  assert.equal(payment.data.refundStatus, "none");
  const after = buildOverview(state, wat("2027-07-01T08:00:00")).metrics.find((item) => item.key === "settled")!.value;
  assert.equal(after, before + GROSS, "a payment reconciled at runtime counts in reconciled collections");
  // Legacy rows written by earlier builds are read as the same vocabulary.
  const legacy = recordsOf(state, "payments").find((item) => item.reference !== "S1" && item.status === "allocated")!;
  // Legacy spellings a connector may still send, outside the typed vocabulary on purpose.
  Object.assign(legacy.data, { reversalStatus: "not_reversed", refundStatus: "not_refunded" });
  assert.equal(buildOverview(state, wat("2027-07-01T08:00:00")).metrics.find((item) => item.key === "settled")!.value, after);
  // A provider reversal reopens the due item as in_dispute and removes the payment from the total.
  addObservation(state, { reference: "S1", amountKobo: GROSS, source: "webhook", customerId: due.customerId, eventId: "rev", occurredAt: wat("2027-07-03T07:00:00"), reversed: true });
  reconcile(state, finance(wat("2027-07-03T07:05:00")));
  assert.equal(payment.data.reversalStatus, "reversed");
  assert.equal(due.status, "in_dispute");
  assert.equal(recordsOf(state, "allocations").filter((item) => item.data.paymentId === payment.id && item.status === "confirmed").length, 0);
  assert.equal(buildOverview(state, wat("2027-07-03T08:00:00")).metrics.find((item) => item.key === "settled")!.value, before);
  invariant(state);
  checks += 8;
}

// ---------- Precision audit (REC-09): a wrong automatic allocation is superseded and the books reopen ----------
{
  const { state, due } = liveFixture({ withFailure: false, merchantId: "precision" });
  addAttempt(state, due, { status: "succeeded", occurredAt: wat("2027-06-30T06:20:00"), providerReference: "PSK-9" });
  addObservation(state, { reference: "PSK-9", amountKobo: GROSS, source: "webhook", customerId: due.customerId, eventId: "w9", occurredAt: wat("2027-06-30T06:20:00") });
  reconcile(state, finance(wat("2027-06-30T07:00:00")));
  const allocation = recordsOf(state, "allocations").find((item) => item.data.dueItemId === due.id && item.status === "confirmed")!;
  executeAction(state, finance(wat("2027-07-05T09:00:00")), { action: "review_allocation", recordId: allocation.id, reason: "Wrong loan", data: { correct: false } });
  assert.equal(allocation.status, "superseded");
  assert.equal(outstandingOf(due), GROSS);
  assert.equal(due.status, "in_collection");
  const payment = recordsOf(state, "payments").find((item) => item.reference === "PSK-9")!;
  assert.equal(payment.status, "unallocated"); assert.equal(payment.data.allocatedKobo, 0);
  assert.equal(buildReports(state, wat("2027-07-05T10:00:00")).operational.falseMatchRate, 1);
  invariant(state);
  checks += 6;
}

// ---------- Mandate operations (MAN-06, MAN-08) and hand-back (DEB-12) ----------
{
  const { state, mandate, due, cutover } = liveFixture({ merchantId: "mandates" });
  const ops = ctxAt(wat("2027-07-01T09:00:00"), "Operations");
  const scheduled = addAttempt(state, due, { status: "scheduled", occurredAt: wat("2027-07-02T06:00:00"), source: "valo" });
  executeAction(state, ops, { action: "mandate_suspend", recordId: mandate.id, reason: "customer request" });
  assert.equal(mandate.status, "suspended");
  assert.equal(scheduled.status, "cancelled", "MAN-08: scheduled attempts against a suspended mandate are cancelled");
  assert.throws(() => executeAction(state, ops, { action: "mandate_suspend", recordId: mandate.id, reason: "again" }), /Only an active mandate/);
  executeAction(state, ops, { action: "mandate_reinstate", recordId: mandate.id, reason: "restored" });
  assert.equal(mandate.status, "active");
  executeAction(state, ops, { action: "mandate_cancel", recordId: mandate.id, reason: "closed loan" });
  assert.equal(mandate.status, "cancelled");
  assert.throws(() => executeAction(state, ops, { action: "mandate_cancel", recordId: mandate.id, reason: "again" }), /cannot be cancelled/);
  assert.throws(() => executeAction(state, ops, { action: "mandate_reissue", recordId: mandate.id, reason: "r" }), /new consent evidence reference/);
  const reissued = executeAction(state, ops, { action: "mandate_reissue", recordId: mandate.id, reason: "new loan", data: { consentEvidence: "CONSENT-2027-07-01" } }).record!;
  assert.notEqual(reissued.id, mandate.id, "MAN-06: a re-issue is a new mandate");
  assert.equal(reissued.status, "pending_activation");
  assert.equal(reissued.data.reissuedFrom, mandate.id);
  assert.equal(reissued.data.consentEvidence, "CONSENT-2027-07-01");
  assert.equal(mandate.status, "cancelled", "the old record is not edited");
  // Hand-back reverts ownership to the owner named in the cutover contract.
  cutover.data.fallbackOwner = "merchant_manual";
  const pending = addAttempt(state, due, { status: "scheduled", occurredAt: wat("2027-07-03T06:00:00"), source: "valo" });
  const handBack = executeAction(state, ops, { action: "hand_back", reason: "exit" });
  assert.equal(due.data.owner, "merchant_manual");
  assert.equal(pending.status, "cancelled");
  assert.equal(state.merchant.killSwitch, true);
  assert.equal(handBack.record!.status, "handed_back");
  invariant(state);
  checks += 15;
}

// UX-C01: a reviewed proposal cannot silently become another match, or exceed
// balances changed while Finance was reviewing it. These are server checks.
{
  for (const action of ['confirm_allocation', 'reject_allocation']) {
    const { state, due } = liveFixture({ withFailure: false, merchantId: `proposal-${action}` });
    const payment = makeRecord(state, 'payments', { amountKobo: GROSS, customerId: due.customerId, data: { allocatedKobo: 0 } });
    const ctx = finance(wat('2027-07-01T11:00:00'));
    const proposal = allocatePayment(state, ctx, payment, due, GROSS, 'R5', 'probable', false);
    const input = { action, recordId: payment.id, reason: 'Checked the displayed proposal.', data: { proposalId: proposal.id, proposalUpdatedAt: proposal.updatedAt } };
    const before = structuredClone(state);
    assert.throws(() => executeAction(state, ctx, { ...input, data: { ...input.data, proposalId: 'another-proposal' } }), (error: any) => error.status === 409);
    assert.deepEqual(state, before, 'A changed proposal is refused before any record is changed.');
    assert.throws(() => executeAction(state, ctx, { ...input, data: { ...input.data, proposalUpdatedAt: '2027-01-01T00:00:00Z' } }), (error: any) => error.status === 409);
    executeAction(state, ctx, input);
    assert.equal(proposal.status, action === 'confirm_allocation' ? 'confirmed' : 'superseded');
    const committed = structuredClone(state);
    assert.throws(() => executeAction(state, ctx, input), /This payment has no proposed match to review\. Reload the page to see its current status\./);
    assert.deepEqual(state, committed, 'A repeated decision cannot apply the payment twice.');
    if (action === 'confirm_allocation') {
      assert.throws(() => applyConfirmedAllocation(state, ctx, proposal), /already confirmed/);
      assert.deepEqual(state, committed);
      checks += 2;
    }
    checks += 7;
  }
  const { state, due } = liveFixture({ withFailure: false, merchantId: 'proposal-balance-change' });
  const payment = makeRecord(state, 'payments', { amountKobo: GROSS, customerId: due.customerId, data: { allocatedKobo: 0 } });
  const ctx = finance(wat('2027-07-01T11:00:00'));
  const proposal = allocatePayment(state, ctx, payment, due, GROSS, 'R5', 'probable', false);
  due.data.outstandingKobo = GROSS - 1;
  const before = structuredClone(state);
  assert.throws(() => executeAction(state, ctx, { action: 'confirm_allocation', recordId: payment.id, reason: 'Review before another receipt arrived.', data: { proposalId: proposal.id, proposalUpdatedAt: proposal.updatedAt } }), (error: any) => error.status === 409 && /balance now outstanding/.test(error.message));
  assert.deepEqual(state, before, 'A reduced instalment ceiling blocks the allocation without partial changes.');
  checks += 2;
}

// UX-B01: a decision always names the proposal it was made on. Without proposalId or proposalUpdatedAt it is
// refused, naming what is missing, before anything is read or changed; the version is compared as an instant.
{
  const named = (...fields: string[]) => (error: unknown) => error instanceof ZodError && JSON.stringify(error.issues.map((issue) => issue.path.join('.'))) === JSON.stringify(fields);
  for (const action of ['confirm_allocation', 'reject_allocation']) {
    const { state, due } = liveFixture({ withFailure: false, merchantId: `proposal-pair-${action}` });
    const payment = makeRecord(state, 'payments', { amountKobo: GROSS, customerId: due.customerId, data: { allocatedKobo: 0 } });
    const ctx = finance(wat('2027-07-01T11:00:00'));
    const proposal = allocatePayment(state, ctx, payment, due, GROSS, 'R5', 'probable', false);
    const input = { action, recordId: payment.id, reason: 'Checked the displayed proposal.' };
    const before = structuredClone(state);
    assert.throws(() => executeAction(state, ctx, input), named('data.proposalId', 'data.proposalUpdatedAt'), 'a decision without the pair is refused, naming both fields');
    assert.throws(() => executeAction(state, ctx, { ...input, data: {} }), named('data.proposalId', 'data.proposalUpdatedAt'));
    assert.throws(() => executeAction(state, ctx, { ...input, data: { proposalId: proposal.id } }), named('data.proposalUpdatedAt'), 'a missing version is named');
    assert.throws(() => executeAction(state, ctx, { ...input, data: { proposalUpdatedAt: proposal.updatedAt } }), named('data.proposalId'), 'a missing proposal is named');
    assert.throws(() => executeAction(state, ctx, { ...input, data: { proposalId: '', proposalUpdatedAt: proposal.updatedAt } }), named('data.proposalId'), 'an empty proposal is missing');
    assert.throws(() => executeAction(state, ctx, { ...input, data: { proposalId: proposal.id, proposalUpdatedAt: 'yesterday' } }), named('data.proposalUpdatedAt'), 'a version that is not a date and time is named');
    assert.deepEqual(state, before, 'nothing is changed by a refused decision');
    // The same instant written with an offset is the version it names.
    const offset = new Date(Date.parse(proposal.updatedAt) + 3_600_000).toISOString().replace('Z', '+01:00');
    executeAction(state, ctx, { ...input, data: { proposalId: proposal.id, proposalUpdatedAt: offset } });
    assert.equal(proposal.status, action === 'confirm_allocation' ? 'confirmed' : 'superseded', 'the same instant written with an offset names the version');
    checks += 8;
  }
}

for (const status of ['cancelled', 'closed', 'in_dispute'] as const) {
  const {state,due}=liveFixture({withFailure:false,merchantId:`proposal-${status}`});
  const payment=makeRecord(state,'payments',{amountKobo:GROSS,customerId:due.customerId,data:{allocatedKobo:0}});
  const ctx=finance(wat('2027-07-01T11:00:00'));
  const proposal=allocatePayment(state,ctx,payment,due,GROSS,'R5','probable',false);
  due.status=status;
  const before=structuredClone(state);
  assert.throws(()=>applyConfirmedAllocation(state,ctx,proposal),(error:any)=>error.status===409 && /instalment is/.test(error.message));
  assert.deepEqual(state,before,'Changed eligibility cannot be overwritten by an old proposal.');
  assert.throws(()=>allocatePayment(state,ctx,payment,due,GROSS,'manual','manual',false),(error:any)=>error.status===409);
  assert.deepEqual(state,before,'Manual allocation checks eligibility before creating any record.');
  checks+=4;
}

// Automatic matching must quarantine an ineligible strong reference without
// redirecting it to another obligation or rolling back unrelated valid receipts.
for (const status of ['cancelled', 'closed', 'in_dispute', 'unpaid_final'] as const) {
  for (const linkBy of ['attempt', 'observation'] as const) {
    const { state, due } = liveFixture({ withFailure: false, merchantId: `batch-${status}-${linkBy}` });
    const observedAt = wat('2027-06-30T06:20:00');
    const ctx = finance(wat('2027-06-30T07:00:00'));
    due.status = status;
    const stopped = structuredClone(due);
    const alternative = makeRecord(state, 'due-items', {
      name: 'Another instalment for the same customer', status: 'scheduled', reference: 'DO-NOT-REDIRECT',
      customerId: due.customerId, amountKobo: GROSS,
      data: { ...due.data, dueDate: '2027-06-30', owner: 'lms' },
    });
    const healthy = recordsOf(state, 'due-items').find(item => item.customerId !== due.customerId && item.status === 'scheduled' && item.amountKobo === 6_000_000)!;
    const reference = `STOPPED-${status}-${linkBy}`;
    if (linkBy === 'attempt') addAttempt(state, due, { status: 'succeeded', occurredAt: observedAt, providerReference: reference });
    const blockedObservation = addObservation(state, {
      reference, amountKobo: GROSS, source: 'webhook', customerId: due.customerId,
      ...(linkBy === 'observation' ? { dueItemId: due.id } : {}),
      narration: alternative.reference, eventId: 'stopped-receipt', occurredAt: observedAt,
    });
    addObservation(state, { reference: 'VALID-IN-SAME-BATCH', amountKobo: healthy.amountKobo, source: 'webhook', customerId: healthy.customerId, dueItemId: healthy.id, eventId: 'valid-receipt', occurredAt: observedAt });
    assert.doesNotThrow(() => reconcile(state, ctx), 'A stopped instalment cannot abort reconciliation of other receipts.');
    const payment = recordsOf(state, 'payments').find(item => item.reference === reference)!;
    assert.equal(blockedObservation.status, 'resolved', 'The receipt is still recorded as evidence.');
    assert.equal(payment.status, 'unallocated');
    assert.match(String(payment.data.explanation), /so this payment stays unallocated for Finance to review\./);
    assert.equal(recordsOf(state, 'allocations').filter(item => item.data.paymentId === payment.id).length, 0);
    assert.deepEqual(due, stopped, 'Matching cannot reopen a stopped instalment.');
    assert.equal(outstandingOf(alternative), GROSS, 'A strong reference is not redirected by a weaker rule.');
    assert.equal(healthy.status, 'paid', 'A valid later receipt in the same batch is allocated.');
    reconcile(state, finance(wat('2027-07-02T07:00:00')));
    assert.equal(payment.status, 'unallocated');
    assert.equal(recordsOf(state, 'exceptions').filter(item => item.data.linkedRecordId === payment.id && item.data.type === 'unallocated_payment').length, 1, 'Existing Finance ageing rules retain the unresolved payment.');
    assert.equal(recordsOf(state, 'allocations').filter(item => item.data.dueItemId === healthy.id && item.status === 'confirmed').length, 1, 'A subsequent close does not duplicate the healthy allocation.');
    invariant(state);
    checks += 11;
  }
}

// R4 (including ambiguous narration) and R5 cannot propose the original gross
// instalment amount after another receipt has reduced the outstanding balance.
for (const rule of ['R4-unique', 'R4-ambiguous', 'R5'] as const) {
  const { state, due } = liveFixture({ withFailure: false, merchantId: `batch-partial-${rule}` });
  const observedAt = wat('2027-06-30T06:20:00');
  const ctx = finance(wat('2027-06-30T07:00:00'));
  due.data.dueDate = '2027-06-30';
  const candidates = [due];
  if (rule === 'R4-ambiguous') candidates.push(makeRecord(state, 'due-items', {
    name: 'Second partially paid instalment', status: 'scheduled', reference: 'OTHER-PARTIAL-LOAN',
    customerId: due.customerId, amountKobo: GROSS, data: { ...due.data, owner: 'lms' },
  }));
  for (const [index, candidate] of candidates.entries()) {
    const partial = makeRecord(state, 'payments', {
      name: 'Earlier partial receipt', status: 'unallocated', reference: `PARTIAL-${index}`,
      customerId: candidate.customerId, amountKobo: GROSS / 2,
      data: { allocatedKobo: 0, observedAt: wat('2027-06-29T06:00:00') },
    });
    allocatePayment(state, ctx, partial, candidate, GROSS / 2, 'R7', 'manual', false);
  }
  const before = candidates.map(candidate => structuredClone(candidate));
  const healthy = recordsOf(state, 'due-items').find(item => item.customerId !== due.customerId && item.status === 'scheduled' && item.amountKobo === 6_000_000)!;
  addObservation(state, {
    reference: 'GROSS-AFTER-PARTIAL', amountKobo: GROSS, source: 'transfer', customerId: due.customerId,
    ...(rule.startsWith('R4') ? { narration: candidates.map(candidate => candidate.reference).join(' and ') } : {}),
    eventId: 'gross-after-partial', occurredAt: observedAt,
  });
  addObservation(state, { reference: 'VALID-AFTER-PARTIAL', amountKobo: healthy.amountKobo, source: 'webhook', customerId: healthy.customerId, dueItemId: healthy.id, eventId: 'valid-after-partial', occurredAt: observedAt });
  assert.doesNotThrow(() => reconcile(state, ctx), `${rule}: a balance mismatch cannot abort the batch.`);
  const payment = recordsOf(state, 'payments').find(item => item.reference === 'GROSS-AFTER-PARTIAL')!;
  assert.equal(payment.status, 'unallocated', `${rule}: the gross receipt needs Finance review.`);
  assert.equal(recordsOf(state, 'allocations').filter(item => item.data.paymentId === payment.id).length, 0, 'No impossible proposal is created.');
  assert.deepEqual(candidates, before, 'Previously reduced balances are unchanged.');
  assert.equal(healthy.status, 'paid');
  assert.equal(recordsOf(state, 'allocations').filter(item => item.data.dueItemId === healthy.id && item.status === 'confirmed').length, 1);
  invariant(state);
  checks += 6;
}

console.log(`Reconciliation golden tests passed (${checks} checks): three-source replay in six orders, duplicate evidence, allocation ceiling, fee schedule, settlement batches that follow their lines and statement credit, hand-entered batches, batch fields only reconciliation records, exception catalogue, final attempts, reversal vocabulary, precision audit, mandate operations, hand-back, stale proposal protection, decisions that must name their proposal and safe automatic batch matching.`);
