// Offline checks that the text the API builds around a count reads as English
// for one as well as for many: "1 source row still needs correction", never
// "1 source rows still need correction" (23 September 2026 audit, item 9).
import assert from "node:assert/strict";
import { ctxAt, liveFixture, wat } from "./helpers.js";
import { seedMerchant } from "../src/lib/valopay-seed.js";
import { makeRecord, recordsOf } from "../src/domain/records.js";
import { executeAction } from "../src/domain/actions.js";
import { saveSourceProfile, batchSourceQuality } from "../src/domain/source-quality.js";
import { saveImportBatch } from "../src/domain/pilot-workflow.js";
import { closeReviewIssues, pilotProgress } from "../src/domain/close-review.js";
import { evaluateRetry, policySummary } from "../src/domain/policy-engine.js";
import { buildReports } from "../src/domain/reports.js";
import { buildDisputePack } from "../src/lib/valopay-packs.js";
import { assessCredit, createSyntheticCreditInput, type CreditContext } from "../src/domain/connected-credit.js";
import { consolidateCashPositions, type CashAccount } from "../src/domain/connected-cash.js";

let checks = 0;
const empty = (id: string) => { const state = seedMerchant(id, true); state.records = []; return state; };

// Source checks: an expected row count and the rows still to correct.
{
  const state = empty("counted-sources"), ctx = { actor: "Sandbox Admin", role: "Admin", now: "2026-09-22T08:00:00.000Z" };
  saveSourceProfile(state, ctx, { name: "Daily customers", source: "count-lms", kind: "customers", mapping: {}, identityColumn: "source_row_id", amountUnit: "naira", firstExpectedAt: "2026-09-22T09:00:00.000Z", cadenceHours: 24, graceMinutes: 60, expectedRows: 1, expectedAmountKobo: 0, status: "active", syntheticOnly: true });
  const batch = saveImportBatch(state, ctx, { name: "Two customers", source: "count-lms", sourceBatchId: "count-1", kind: "customers", csv: "source_row_id,name,reference,consentProvenance\nc-1,First customer,COUNT-C-1,Synthetic consent\nc-2,Second customer,COUNT-C-2,", mapping: {}, identityColumn: "source_row_id", amountUnit: "naira", syntheticOnly: true });
  assert.deepEqual(batchSourceQuality(state, batch).issues, ["Expected 1 source row; this batch contains 2.", "1 source row still needs correction."]);
  checks += 1;
}

// Close review: the differences and the items that remain at a close.
{
  const state = empty("counted-close");
  const close = makeRecord(state, "closes" as string, { status: "completed", name: "Close", data: { report: { variances: { count: 1, batches: [] }, positionRebuild: { mismatches: [] }, unallocated: { count: 1, kobo: 500 }, proposed: { count: 2, kobo: 900 }, possibleDuplicates: { count: 0 } } } });
  const detail = Object.fromEntries(closeReviewIssues(close).map((issue) => [issue.id, issue.detail]));
  assert.equal(detail["settlement-variance"], "1 difference was recorded.");
  assert.equal(detail.unallocated, "1 item totalling ₦5.00 remains at this close.");
  assert.equal(detail.proposed, "2 items totalling ₦9.00 remain at this close.");
  // Money in another currency is named beside the naira, in its own currency (the third review of the audit fixes).
  const withDollars = makeRecord(state, "closes" as string, { status: "completed", name: "Close", data: { report: { unallocated: { count: 2, kobo: 500, otherCurrencies: { USD: { count: 1, amount: 100_000 } } } } } });
  assert.equal(Object.fromEntries(closeReviewIssues(withDollars).map((issue) => [issue.id, issue.detail])).unallocated, "2 items totalling ₦5.00 and USD 1,000.00 remain at this close.");
  checks += 4;
}

// The pilot journey's evidence, one of everything.
{
  const state = empty("counted-journey");
  const customer = makeRecord(state, "customers", { name: "Only customer", status: "active", data: { consentProvenance: "Synthetic consent" } });
  makeRecord(state, "import-batches", { name: "Only batch", status: "committed", data: { committedAt: "2026-09-22T08:00:00.000Z" } });
  const payment = makeRecord(state, "payments", { name: "Only payment", status: "unallocated", customerId: customer.id, amountKobo: 1_000_000, data: {} });
  makeRecord(state, "allocations", { name: "R1", status: "confirmed", customerId: customer.id, amountKobo: 1_000_000, data: { paymentId: payment.id } });
  makeRecord(state, "observations", { name: "Only evidence", status: "unresolved", amountKobo: 1_000_000, data: { source: "transfer" } });
  makeRecord(state, "exceptions", { name: "Open exception", status: "open", data: { type: "unmatched_payment" } });
  makeRecord(state, "exceptions", { name: "Resolved exception", status: "resolved", data: { type: "unmatched_payment" } });
  const step = (id: string) => pilotProgress(state).steps.find((item) => item.id === id)!;
  assert.deepEqual(step("ingest").evidence, ["1 committed import batch; 1 customer record."]);
  assert.deepEqual(step("reconcile").evidence, ["1 confirmed allocation; 1 payment record.", "1 payment needs a match; 1 evidence record remains unresolved."]);
  assert.deepEqual(step("resolve").evidence, ["1 resolved case; 1 open; 1 without an assignee."]);
  assert.deepEqual(step("resolve").missing, ["Resolve 1 open case; a handover alone does not resolve a case."]);
  assert.deepEqual(step("export").evidence, ["0 ready exports reference the current approved close and its exact snapshot."]);
  checks += 5;
}

// A retry policy of one attempt: its summary, the ceiling's reason and the dispute pack's governing text.
{
  const { state, policy, due, customer } = liveFixture({ merchantId: "counted-policy" });
  policy.data.maxAttempts = 1;
  assert.match(policySummary(policy), /: up to 1 attempt in total across all collection systems;/);
  const decision = evaluateRetry(state, ctxAt(wat("2027-06-28T09:01:00")), due, policy);
  assert.equal(decision.rule, "ceiling");
  assert.match(decision.reason, /^The limit of 1 attempt has been reached across all collection systems\./);
  const pack = buildDisputePack(state, ctxAt(wat("2027-07-01T08:00:00"), "Finance"), customer.id);
  assert.match(pack.documents.find((document) => document.kind === "policies")!.text, /^Up to 1 attempt counting every source;/);
  policy.data.maxAttempts = 3;
  assert.match(policySummary(policy), /: up to 3 attempts in total/);
  checks += 5;
}

// Hand-back: one instalment returned to its owner, no attempt cancelled.
{
  const { state } = liveFixture({ merchantId: "counted-hand-back", withFailure: false });
  const result = executeAction(state, ctxAt(wat("2027-06-28T09:00:00")), { action: "hand_back", reason: "Pilot ends; the lender's system collects again." });
  assert.deepEqual((result.record!.data.checklist as string[]).slice(0, 2), ["Ownership of 1 obligation reverted to lms", "0 scheduled attempts cancelled with notices"]);
  checks += 1;
}

// An invoice for one collection, and the reports' allocation measures.
{
  const state = seedMerchant("counted-invoice");
  const terms = recordsOf(state, "commercial")[0]!;
  terms.data.signed = true; terms.data.effectiveDate = "2027-06-01";
  terms.data.designPartner = false; // Wording fixture uses ordinary signed terms; pricing authority is tested separately.
  for (const payment of recordsOf(state, "payments")) payment.data.channel = "transfer";
  const customer = recordsOf(state, "customers")[0]!, observedAt = wat("2027-06-10T06:20:00"), amountKobo = 2_500_000;
  const due = makeRecord(state, "due-items", { name: "Counted collection", status: "paid", customerId: customer.id, amountKobo, reference: "DUE-COUNTED", data: { dueDate: observedAt.slice(0, 10), owner: "lms", outstandingKobo: 0 } });
  const payment = makeRecord(state, "payments", { name: "PSK-COUNTED", status: "allocated", customerId: customer.id, amountKobo, reference: "PSK-COUNTED", data: { channel: "direct_debit", collectionStatus: "succeeded", settlementStatus: "settled", observedAt, settledAt: observedAt, reversalStatus: "none", refundStatus: "none", allocatedKobo: amountKobo, dueItemId: due.id } });
  makeRecord(state, "allocations", { name: "R1", status: "confirmed", customerId: customer.id, amountKobo, data: { paymentId: payment.id, dueItemId: due.id, rule: "R1", confidence: "certain", automatic: true } });
  const issued = executeAction(state, ctxAt(wat("2027-07-01T09:00:00"), "Finance"), { action: "issue_invoice", reason: "Month end", data: { period: "2027-06" } });
  assert.match(issued.message, /: 1 collection counted, 0 adjustment lines\./);

  const reports = empty("counted-reports");
  const paid = makeRecord(reports, "payments", { name: "Only payment", status: "allocated", amountKobo: 1_000_000, data: {} });
  makeRecord(reports, "allocations", { name: "R1", status: "confirmed", amountKobo: 1_000_000, data: { paymentId: paid.id, reviewed: true } });
  const detail = (key: string) => buildReports(reports, "2027-07-01T09:00:00.000Z").metrics.find((metric) => metric.key === key)!.detail;
  assert.equal(detail("allocation_rate"), "1 of 1 payment is fully or partly allocated, or exceeds the amount due.");
  assert.equal(detail("allocation_precision"), "1 allocation reviewed. Unreviewed allocations are excluded from this accuracy measure.");
  makeRecord(reports, "payments", { name: "Second payment", status: "unallocated", amountKobo: 1_000_000, data: {} });
  assert.equal(detail("allocation_rate"), "1 of 2 payments is fully or partly allocated, or exceeds the amount due.");
  checks += 4;
}

// Credit Desk and Cash Desk reasons and warnings.
{
  const ctx: CreditContext = { tenantId: "lender-a", actorId: "Sandbox Operations", permissions: ["credit:assess"], now: "2026-09-21T10:00:00.000Z" };
  const input = createSyntheticCreditInput({ tenantId: ctx.tenantId, applicantId: "applicant-a", applicationRef: "counted-application", now: ctx.now });
  const reason = (code: string, missedPayments: number) => assessCredit({ ...input, repaymentHistory: { ...input.repaymentHistory, missedPayments } }, ctx).score!.factors.find((factor) => factor.code === code)!.reason;
  assert.equal(reason("commitment_behaviour", 1), "1 missed repayment in the supplied verified history. This does not establish complete bureau coverage.");
  assert.equal(reason("commitment_behaviour", 2), "2 missed repayments in the supplied verified history. This does not establish complete bureau coverage.");
  const scope = { tenantId: "sample-tenant", legalEntityId: "sample-company", currency: "NGN" }, now = "2026-09-21T10:00:00.000Z";
  const account: CashAccount = { ...scope, id: "bank-1", name: "Operating account", source: "synthetic", sourceDefinition: "Provider booked and available balance", authorised: true, bookedMinor: 100_000, availableMinor: 90_000, pendingMinor: -10_000, balanceAsOf: now, fetchedAt: now, coverageComplete: true };
  const [position] = consolidateCashPositions(scope, [account, { ...account, id: "bank-2", authorised: false }], [], now);
  assert.ok(position!.warnings.includes("1 account omitted: missing authority or not known at this as-of time."), JSON.stringify(position!.warnings));
  checks += 3;
}

console.log(`Counted text checks passed (${checks} checks): source checks, close review, the pilot journey, retry policy, hand-back, invoices, reports, Credit Desk and Cash Desk.`);
